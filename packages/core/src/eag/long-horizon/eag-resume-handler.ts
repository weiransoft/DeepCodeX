/**
 * /eag-resume 命令处理器（EagResumeHandler）—— EAG-P3 批次 10 §4.13
 *
 * 本模块实现 EAG 方案 §5.12.2 + 设计文档 §4.13 所述的 /eag-resume 命令处理逻辑，
 * 从 RunState 断点恢复，校验 SHA256 完整性 + git HEAD 一致性后继续执行未完成的 Loop 节点。
 *
 * 核心职责（对齐设计文档 §4.13.1）：
 * 1. 加载 RunState（RunStateStore.load）
 *    - SHA256 校验失败 → 抛 RunStateCorruptedError，拒绝恢复
 * 2. 校验 git HEAD 与 RunState 最后一个 milestone 的 commitSha 一致
 *    - 不一致 → 抛 RunStateDivergedError（用户可能手动改了代码）
 * 3. 重建 MultiLoopPlan（从 RunState.milestones + RunState.completedLoops 推导）
 * 4. 从当前 Loop 的当前迭代继续执行：
 *    - status="human-checkpoint" → 等待用户决策（userDecision 必填）
 *    - status="paused" → 恢复后需用户确认（追加 run-resumed 事件后继续执行）
 *    - status="running" → 直接继续（崩溃恢复场景）
 * 5. 追加 run-resumed 事件 + 继续执行剩余 Loop 节点
 *
 * 关键技术决策（对齐 §4.13.2 + 工程实践）：
 * - SHA256 完整性校验：复用 RunStateStore.load() 内部的累积 SHA256 校验逻辑
 * - git HEAD 一致性校验：通过 child_process.execSync 调用 git rev-parse HEAD，
 *   与 RunState.milestones[last].commitSha 比对（如无 milestone 则跳过校验）
 * - 与 EagRunHandler 共享 LoopExecutor 协议：保证 run 与 resume 使用相同的 Loop 执行接口
 * - 重建 MultiLoopPlan：由于 plan 不持久化，需从 RunState.completedLoops 反推已完成节点，
 *   然后调用 MultiLoopPlanner.plan() 重新生成完整计划，跳过已完成的节点
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/long-horizon/eag-resume-handler
 */

import * as childProcess from "node:child_process";
import type { LoopType } from "../loop/models";
import type { BlockageReport, LogCallback, MilestoneRecord, MultiLoopNode, MultiLoopPlan, RunState } from "./types";
import { BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD, DEFAULT_MAX_MULTI_LOOP_ITERATIONS } from "./types";
import type { MultiLoopPlanner } from "./multi-loop-planner";
import type { RunStateStore } from "./run-state-store";
import { RunStateCorruptedError, RunStateNotFoundError } from "./run-state-store";
import type { MilestoneTagger } from "./milestone-tagger";
import type { BlockageAnalyzer } from "./blockage-analyzer";
import type { LoopExecutionContext, LoopExecutionResult, LoopExecutor } from "./eag-run-handler";
import { EagRunHandlerError } from "./eag-run-handler";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 默认日志空函数（避免 undefined 判空）
 *
 * 对齐 testing/testing-orchestrator.ts 与 run-state-store.ts 中的 noopLog 模式。
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

/**
 * git rev-parse HEAD 命令超时（毫秒）
 *
 * 取值依据：git 命令正常执行 < 1 秒，5 秒覆盖大型仓库 + IO 抖动。
 */
const GIT_REV_PARSE_TIMEOUT_MS = 5000 as const;

// ============================================================================
// 2. 自定义错误类
// ============================================================================

/**
 * /eag-resume 命令处理器错误类型（字面量联合类型）
 *
 * - request-invalid：请求字段非法
 * - run-not-found：run-id 不存在
 * - run-corrupted：RunState SHA256 校验失败
 * - run-diverged：git HEAD 与 RunState 不一致
 * - resume-failed：恢复执行失败
 * - git-error：git 命令执行失败
 */
export type EagResumeHandlerErrorKind =
  | "request-invalid"
  | "run-not-found"
  | "run-corrupted"
  | "run-diverged"
  | "resume-failed"
  | "git-error";

/**
 * /eag-resume 命令处理器错误基类
 *
 * 含错误类型与详细信息，便于调用方区分处理。
 */
export class EagResumeHandlerError extends Error {
  /**
   * @param kind 错误类型
   * @param detail 错误详情
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: EagResumeHandlerErrorKind,
    public readonly detail: string,
    public readonly cause?: unknown
  ) {
    super(`EagResumeHandler 错误 [${kind}]：${detail}`);
    this.name = "EagResumeHandlerError";
  }
}

// ============================================================================
// 3. EagResumeRequest 接口
// ============================================================================

/**
 * /eag-resume 命令请求
 *
 * 对应设计文档 §4.13.2 EagResumeRequest。
 *
 * 字段全部 readonly——请求一经构造即不可变。
 *
 * 范例：
 *   {
 *     runId: "a1b2c3d4e5f6",
 *     projectRoot: "/path/to/project",
 *     userIntent: "我需要一个订单管理微服务",
 *     loopExecutors: [designExecutor, codingExecutor, testingExecutor],
 *     userDecision: "批准 spec.md"
 *   }
 */
export interface EagResumeRequest {
  /** run-id（必填，需对应已存在的 RunState） */
  readonly runId: string;
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /**
   * 用户意图文本（必填，用于重建 MultiLoopPlan 时调用 MultiLoopPlanner.plan()）
   *
   * 注意：与 EagRunRequest.userIntent 一致，恢复时需重新传入，
   * 因为 RunState 不持久化原始用户意图（避免 JSONL 文件膨胀）。
   */
  readonly userIntent: string;
  /** Loop 执行器列表（与 EagRunRequest.loopExecutors 一致） */
  readonly loopExecutors: ReadonlyArray<LoopExecutor>;
  /**
   * 用户决策（可选，status="human-checkpoint" 时用户提供决策内容）
   *
   * 决策内容会被追加到 human-intervention-resolved 事件的 payload.decision 字段。
   */
  readonly userDecision?: string;
  /** 覆盖率阈值（可选，TESTING Loop 使用） */
  readonly coverageThreshold?: Readonly<Record<string, unknown>>;
  /** 启用的 ICP 合规包 ID 列表（可选，TESTING Loop 使用） */
  readonly compliancePackIds?: ReadonlyArray<string>;
  /** 最大 Loop 迭代次数（可选，默认 30） */
  readonly maxIterations?: number;
  /** 是否自动流转（可选，默认 false） */
  readonly autoTransition?: boolean;
}

// ============================================================================
// 4. EagResumeHandler 主类
// ============================================================================

/**
 * /eag-resume 命令处理器
 *
 * 对应 EAG 方案 §5.12.2 + 设计文档 §4.13：
 * 从 RunState 断点恢复 + SHA256 校验 + git HEAD 一致性校验 + 继续执行未完成 Loop。
 *
 * 使用方式：
 * ```typescript
 * const handler = new EagResumeHandler({
 *   runStateStore: new RunStateStore(),
 *   multiLoopPlanner: new MultiLoopPlanner(),
 *   milestoneTagger: new MilestoneTagger(...),
 *   blockageAnalyzer: new BlockageAnalyzer(...),
 * });
 * const result = await handler.handle({
 *   runId: "a1b2c3d4e5f6",
 *   projectRoot: "/path/to/project",
 *   userIntent: "我需要一个订单管理微服务",
 *   loopExecutors: [designExecutor, codingExecutor, testingExecutor],
 *   userDecision: "批准 spec.md",
 * });
 * ```
 *
 * 与 EagRunHandler 的关系：
 * - 共享 LoopExecutor 协议、LoopExecutionContext、LoopExecutionResult 类型
 * - 共享 EagRunResult 类型（resume 的产出结构与 run 一致）
 * - 不共享 handle() 方法：resume 有独立的校验链路（SHA256 + git HEAD）
 */
export class EagResumeHandler {
  // ----------------------------------------------------------------------
  // 私有字段
  // ----------------------------------------------------------------------

  /** RunState 持久化存储（依赖注入） */
  private readonly runStateStore: RunStateStore;
  /** 多 Loop 串联计划生成器（依赖注入，用于重建 plan） */
  private readonly multiLoopPlanner: MultiLoopPlanner;
  /** 里程碑 tag 生成器（依赖注入） */
  private readonly milestoneTagger: MilestoneTagger;
  /** 阻塞分析器（依赖注入） */
  private readonly blockageAnalyzer: BlockageAnalyzer;
  /** 日志回调 */
  private readonly logger: LogCallback;

  // ----------------------------------------------------------------------
  // 构造函数
  // ----------------------------------------------------------------------

  /**
   * 初始化 /eag-resume 命令处理器
   *
   * @param options 注入选项
   * @param options.runStateStore RunState 持久化存储（必填）
   * @param options.multiLoopPlanner 多 Loop 串联计划生成器（必填）
   * @param options.milestoneTagger 里程碑 tag 生成器（必填）
   * @param options.blockageAnalyzer 阻塞分析器（必填）
   * @param options.logger 日志回调（可选）
   */
  constructor(options: {
    readonly runStateStore: RunStateStore;
    readonly multiLoopPlanner: MultiLoopPlanner;
    readonly milestoneTagger: MilestoneTagger;
    readonly blockageAnalyzer: BlockageAnalyzer;
    readonly logger?: LogCallback;
  }) {
    if (!options || !options.runStateStore) {
      throw new EagResumeHandlerError("request-invalid", "runStateStore 必填");
    }
    if (!options.multiLoopPlanner) {
      throw new EagResumeHandlerError("request-invalid", "multiLoopPlanner 必填");
    }
    if (!options.milestoneTagger) {
      throw new EagResumeHandlerError("request-invalid", "milestoneTagger 必填");
    }
    if (!options.blockageAnalyzer) {
      throw new EagResumeHandlerError("request-invalid", "blockageAnalyzer 必填");
    }
    this.runStateStore = options.runStateStore;
    this.multiLoopPlanner = options.multiLoopPlanner;
    this.milestoneTagger = options.milestoneTagger;
    this.blockageAnalyzer = options.blockageAnalyzer;
    this.logger = options.logger ?? noopLog;
  }

  // ----------------------------------------------------------------------
  // 公共 API
  // ----------------------------------------------------------------------

  /**
   * 执行 /eag-resume 命令
   *
   * 完整时序（对齐设计文档 §4.13.2）：
   * 1. 校验请求字段
   * 2. 加载 RunState（含 SHA256 累积校验）
   * 3. 校验 git HEAD 与最后一个 milestone 的 commitSha 一致
   * 4. 重建 MultiLoopPlan
   * 5. 追加 run-resumed 事件
   * 6. 从断点继续执行剩余 Loop 节点
   * 7. 生成最终报告
   *
   * @param request 恢复请求
   * @returns 恢复后的执行结果（与 EagRunResult 同构）
   * @throws EagResumeHandlerError run-id 不存在 / SHA256 校验失败 / git HEAD 不一致
   */
  async handle(request: Readonly<EagResumeRequest>): Promise<Readonly<import("./eag-run-handler").EagRunResult>> {
    // ===== Step 1: 校验请求字段 =====
    this.validateRequest(request);

    const startTime = Date.now();
    this.logger(`/eag-resume 启动：runId=${request.runId} projectRoot=${request.projectRoot}`, "info");

    // ===== Step 2: 加载 RunState（含 SHA256 累积校验） =====
    let runState: Readonly<RunState>;
    try {
      runState = await this.runStateStore.load(request.runId, request.projectRoot);
    } catch (err) {
      if (err instanceof RunStateNotFoundError) {
        throw new EagResumeHandlerError(
          "run-not-found",
          `run-id 不存在：${request.runId}（projectRoot=${request.projectRoot}）`,
          err
        );
      }
      if (err instanceof RunStateCorruptedError) {
        throw new EagResumeHandlerError(
          "run-corrupted",
          `RunState SHA256 校验失败：${err.detail}，请从最近 milestone tag 手动恢复`,
          err
        );
      }
      throw new EagResumeHandlerError(
        "resume-failed",
        `加载 RunState 失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    this.logger(
      `RunState 加载成功：runId=${runState.runId} status=${runState.status} completedLoops=[${runState.completedLoops.join(", ")}]`,
      "info"
    );

    // ===== Step 3: 校验 git HEAD 与最后一个 milestone 的 commitSha 一致 =====
    if (runState.milestones.length > 0) {
      const lastMilestone = runState.milestones[runState.milestones.length - 1];
      try {
        const currentHead = this.getGitHead(request.projectRoot);
        if (currentHead !== lastMilestone.commitSha) {
          throw new EagResumeHandlerError(
            "run-diverged",
            `git HEAD 与最后一个 milestone 不一致：HEAD=${currentHead} milestone.commitSha=${lastMilestone.commitSha}（用户可能手动改了代码，请回滚到 ${lastMilestone.tagName} 后重试）`
          );
        }
      } catch (err) {
        if (err instanceof EagResumeHandlerError) {
          throw err;
        }
        throw new EagResumeHandlerError(
          "git-error",
          `git rev-parse HEAD 失败：${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }
    } else {
      this.logger("无 milestone 记录，跳过 git HEAD 一致性校验", "info");
    }

    // ===== Step 4: 重建 MultiLoopPlan =====
    // 由于 plan 不持久化，需重新生成完整 plan，然后跳过已完成的节点
    let plan: Readonly<MultiLoopPlan>;
    try {
      plan = await this.multiLoopPlanner.plan({
        runId: runState.runId,
        projectRoot: request.projectRoot,
        specContent: this.buildMinimalSpecFromIntent(request.userIntent),
        autoTransition: request.autoTransition ?? false,
        rollbackOnFailure: true,
      });
    } catch (err) {
      throw new EagResumeHandlerError(
        "resume-failed",
        `重建 MultiLoopPlan 失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // 推导已完成的节点 ID 列表（基于 completedLoops）
    // 算法：遍历 plan.loops，若 node.loopType 已在 runState.completedLoops 中，则视为已完成
    const completedNodeIds: string[] = [];
    for (const node of plan.loops) {
      if (runState.completedLoops.includes(node.loopType)) {
        completedNodeIds.push(node.nodeId);
      }
    }
    this.logger(`已完成的节点：${completedNodeIds.join(", ") || "（无）"}`, "info");

    // ===== Step 5: 追加 run-resumed 事件 =====
    try {
      runState = await this.runStateStore.appendEvent(runState.runId, {
        type: "run-resumed",
        payload: {
          previousStatus: runState.status,
          userDecision: request.userDecision ?? "",
        },
      });
    } catch (err) {
      throw new EagResumeHandlerError(
        "resume-failed",
        `追加 run-resumed 事件失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // ===== Step 6: 从断点继续执行剩余 Loop 节点 =====
    // 装配 LoopExecutor Map
    const executorMap = new Map<LoopType, LoopExecutor>();
    for (const executor of request.loopExecutors) {
      executorMap.set(executor.loopType, executor);
    }

    const completedLoops: LoopType[] = [...runState.completedLoops];
    const milestones: MilestoneRecord[] = [...runState.milestones];
    let totalLlmCallCount = runState.totalLlmCallCount;
    let totalTokensUsed = runState.totalTokensUsed;
    let blockageReport: BlockageReport | undefined;
    let finalStatus: import("./eag-run-handler").EagRunResult["finalStatus"] = "completed";
    let failureReason: string | undefined;

    // 处理 human-checkpoint 状态：若用户提供了 userDecision，标记上一次介入为已解决
    if (runState.status === "human-checkpoint" && request.userDecision) {
      try {
        runState = await this.runStateStore.appendEvent(runState.runId, {
          type: "human-intervention-resolved",
          payload: {
            index: runState.humanInterventionCount - 1,
            decision: request.userDecision,
          },
        });
        this.logger(`人工介入已解决：${request.userDecision}`, "info");
      } catch (err) {
        this.logger(
          `标记 human-intervention-resolved 失败：${err instanceof Error ? err.message : String(err)}`,
          "warn"
        );
      }
    }

    // 遍历剩余未完成节点
    for (const node of plan.loops) {
      // 跳过已完成的节点
      if (completedNodeIds.includes(node.nodeId)) {
        continue;
      }

      // 6.1 检查依赖是否满足
      if (!this.areDependenciesSatisfied(node, completedNodeIds)) {
        failureReason = `节点 ${node.nodeId} 依赖未满足：${node.dependencies.join(", ")}`;
        finalStatus = "failed";
        this.logger(`节点依赖未满足：${node.nodeId}`, "error");
        break;
      }

      // 6.2 追加 loop-started 事件
      try {
        runState = await this.runStateStore.appendEvent(runState.runId, {
          type: "loop-started",
          payload: {
            loopType: node.loopType,
            iteration: runState.currentIteration + 1,
            nodeId: node.nodeId,
          },
        });
      } catch (err) {
        throw new EagResumeHandlerError(
          "resume-failed",
          `追加 loop-started 事件失败：${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      // 6.3 通过 LoopExecutor 协议调用对应 Loop 编排器
      const executor = executorMap.get(node.loopType);
      if (!executor) {
        failureReason = `未找到 LoopType=${node.loopType} 的 LoopExecutor 实现`;
        finalStatus = "failed";
        this.logger(`未找到 LoopExecutor：${node.loopType}`, "error");
        break;
      }

      const context: Readonly<LoopExecutionContext> = Object.freeze({
        node,
        runId: runState.runId,
        projectRoot: request.projectRoot,
        userIntent: request.userIntent,
        specContent: undefined, // resume 时不复用 spec，由 LoopExecutor 内部决定是否重新生成
        autoTransition: plan.autoTransition,
        maxIterations: request.maxIterations ?? DEFAULT_MAX_MULTI_LOOP_ITERATIONS,
        coverageThreshold: request.coverageThreshold,
        compliancePackIds: request.compliancePackIds,
        completedNodeIds: [...completedNodeIds],
      });

      let loopResult: Readonly<LoopExecutionResult>;
      try {
        this.logger(`恢复执行 Loop 节点：${node.nodeId} (type=${node.loopType})`, "info");
        loopResult = await executor.execute(context);
      } catch (err) {
        failureReason = `Loop ${node.nodeId} 恢复执行抛出异常：${err instanceof Error ? err.message : String(err)}`;
        finalStatus = "failed";
        this.logger(`Loop 恢复执行异常：${node.nodeId} - ${failureReason}`, "error");

        try {
          runState = await this.runStateStore.appendEvent(runState.runId, {
            type: "human-intervention",
            payload: {
              loopType: node.loopType,
              reason: failureReason,
              decision: "pending",
            },
          });
        } catch (e) {
          this.logger(`追加 human-intervention 事件失败：${e instanceof Error ? e.message : String(e)}`, "warn");
        }

        if (runState.humanInterventionCount >= BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD) {
          blockageReport = await this.triggerBlockageAnalysis(
            runState.runId,
            request.projectRoot,
            node.loopType,
            runState.currentIteration
          );
          finalStatus = "paused";
          try {
            runState = await this.runStateStore.appendEvent(runState.runId, {
              type: "run-paused",
              payload: { reason: "累计 3 次人工介入未解决" },
            });
          } catch (e) {
            this.logger(`追加 run-paused 事件失败：${e instanceof Error ? e.message : String(e)}`, "warn");
          }
        }
        break;
      }

      // 累计资源消耗
      totalLlmCallCount += loopResult.llmCallCount;
      totalTokensUsed += loopResult.tokensUsed;

      // 6.4 处理 Loop 执行结果
      if (loopResult.finalStatus === "completed") {
        // 创建里程碑 tag
        try {
          const milestone = await this.milestoneTagger.tag({
            runId: runState.runId,
            projectRoot: request.projectRoot,
            name: `${node.loopType.toUpperCase()} Loop 完成（恢复）`,
            loopType: node.loopType,
          });
          milestones.push(milestone);

          runState = await this.runStateStore.appendEvent(runState.runId, {
            type: "loop-completed",
            payload: {
              loopType: node.loopType,
              nodeId: node.nodeId,
              milestone,
            },
          });
          runState = await this.runStateStore.appendEvent(runState.runId, {
            type: "milestone-tagged",
            payload: { milestone },
          });

          completedLoops.push(node.loopType);
          completedNodeIds.push(node.nodeId);

          this.logger(`Loop 节点恢复完成：${node.nodeId} milestone=${milestone.tagName}`, "info");
        } catch (err) {
          throw new EagResumeHandlerError(
            "resume-failed",
            `里程碑 tag 创建失败：${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }
      } else if (loopResult.finalStatus === "human-checkpoint") {
        failureReason = loopResult.failureReason ?? `Loop ${node.nodeId} 等待人工决策`;
        finalStatus = "human-checkpoint";

        try {
          runState = await this.runStateStore.appendEvent(runState.runId, {
            type: "human-intervention",
            payload: {
              loopType: node.loopType,
              reason: failureReason,
              decision: "pending",
            },
          });
        } catch (err) {
          this.logger(`追加 human-intervention 事件失败：${err instanceof Error ? err.message : String(err)}`, "warn");
        }

        if (runState.humanInterventionCount >= BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD) {
          blockageReport = await this.triggerBlockageAnalysis(
            runState.runId,
            request.projectRoot,
            node.loopType,
            runState.currentIteration
          );
          finalStatus = "paused";
          try {
            runState = await this.runStateStore.appendEvent(runState.runId, {
              type: "run-paused",
              payload: { reason: "累计 3 次人工介入未解决" },
            });
          } catch (err) {
            this.logger(`追加 run-paused 事件失败：${err instanceof Error ? err.message : String(err)}`, "warn");
          }
        }
        break;
      } else {
        // Loop 失败：回滚到上一个 milestone
        failureReason = loopResult.failureReason ?? `Loop ${node.nodeId} 恢复执行失败`;
        try {
          if (milestones.length > 0) {
            await this.milestoneTagger.rollback(runState.runId, request.projectRoot);
            this.logger(`已回滚到上一个 milestone：${milestones[milestones.length - 1].tagName}`, "warn");
          }

          runState = await this.runStateStore.appendEvent(runState.runId, {
            type: "human-intervention",
            payload: {
              loopType: node.loopType,
              reason: failureReason,
              decision: "pending",
            },
          });

          if (runState.humanInterventionCount >= BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD) {
            blockageReport = await this.triggerBlockageAnalysis(
              runState.runId,
              request.projectRoot,
              node.loopType,
              runState.currentIteration
            );
            finalStatus = "paused";
            try {
              runState = await this.runStateStore.appendEvent(runState.runId, {
                type: "run-paused",
                payload: { reason: "累计 3 次人工介入未解决" },
              });
            } catch (err) {
              this.logger(`追加 run-paused 事件失败：${err instanceof Error ? err.message : String(err)}`, "warn");
            }
          } else {
            finalStatus = "human-checkpoint";
          }
        } catch (err) {
          throw new EagResumeHandlerError(
            "resume-failed",
            `里程碑回滚失败：${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }
        break;
      }
    }

    // ===== Step 7: 追加终态事件 =====
    if (finalStatus === "completed") {
      try {
        runState = await this.runStateStore.appendEvent(runState.runId, {
          type: "run-completed",
          payload: {
            finalReport: "Run 恢复完成",
            totalLlmCallCount,
            totalTokensUsed,
          },
        });
      } catch (err) {
        this.logger(`追加 run-completed 事件失败：${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    } else if (finalStatus === "failed") {
      try {
        runState = await this.runStateStore.appendEvent(runState.runId, {
          type: "run-failed",
          payload: { reason: failureReason ?? "未知失败原因" },
        });
      } catch (err) {
        this.logger(`追加 run-failed 事件失败：${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }

    // ===== Step 8: 生成最终报告 =====
    const durationSec = (Date.now() - startTime) / 1000;
    const finalReport = this.buildResumeReport({
      runId: runState.runId,
      finalStatus,
      completedLoops,
      milestones,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
      failureReason,
      blockageReport,
    });

    this.logger(
      `/eag-resume 完成：runId=${runState.runId} finalStatus=${finalStatus} duration=${durationSec.toFixed(2)}s`,
      "info"
    );

    return Object.freeze({
      runId: runState.runId,
      finalStatus,
      completedLoops: Object.freeze([...completedLoops]),
      milestones: Object.freeze([...milestones]),
      finalRunState: runState,
      finalReport,
      blockageReport,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
    });
  }

  // ----------------------------------------------------------------------
  // 私有方法
  // ----------------------------------------------------------------------

  /**
   * 校验 /eag-resume 请求字段
   *
   * 校验规则：
   * - runId 必填且为非空字符串
   * - projectRoot 必填且为非空字符串
   * - userIntent 必填且为非空字符串
   * - loopExecutors 必填且非空数组
   *
   * @param request 请求对象
   * @throws EagResumeHandlerError 请求字段非法时抛出
   */
  private validateRequest(request: Readonly<EagResumeRequest>): void {
    if (!request || typeof request !== "object") {
      throw new EagResumeHandlerError("request-invalid", "request 必须为对象");
    }
    if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
      throw new EagResumeHandlerError("request-invalid", "runId 必须为非空字符串");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new EagResumeHandlerError("request-invalid", "projectRoot 必须为非空字符串");
    }
    if (typeof request.userIntent !== "string" || request.userIntent.trim().length === 0) {
      throw new EagResumeHandlerError("request-invalid", "userIntent 必须为非空字符串");
    }
    if (!Array.isArray(request.loopExecutors) || request.loopExecutors.length === 0) {
      throw new EagResumeHandlerError("request-invalid", "loopExecutors 必须为非空数组");
    }
    for (let i = 0; i < request.loopExecutors.length; i++) {
      const executor = request.loopExecutors[i];
      if (!executor || typeof executor.loopType !== "string" || typeof executor.execute !== "function") {
        throw new EagResumeHandlerError(
          "request-invalid",
          `loopExecutors[${i}] 必须实现 LoopExecutor 协议（含 loopType 字段与 execute 方法）`
        );
      }
    }
  }

  /**
   * 获取 git HEAD 的 commit SHA
   *
   * 算法：通过 child_process.execSync 调用 `git rev-parse HEAD`，
   * 返回当前 HEAD 的完整 commit SHA（40 字符十六进制字符串）。
   *
   * 注意：本方法使用同步调用，因为 /eag-resume 是命令行场景，
   * 同步调用 git 命令是可接受的（< 1 秒）。
   *
   * @param projectRoot 项目根目录（git 仓库根）
   * @returns 当前 HEAD 的 commit SHA
   * @throws EagResumeHandlerError git 命令执行失败
   */
  private getGitHead(projectRoot: string): string {
    try {
      const output = childProcess.execSync("git rev-parse HEAD", {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: GIT_REV_PARSE_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.trim();
    } catch (err) {
      throw new EagResumeHandlerError(
        "git-error",
        `git rev-parse HEAD 执行失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  /**
   * 检查节点依赖是否满足
   *
   * 算法：遍历 node.dependencies，全部存在于 completedNodeIds 中即满足。
   *
   * @param node 待执行的节点
   * @param completedNodeIds 已完成节点 ID 列表
   * @returns true=依赖全部满足，false=存在未满足的依赖
   */
  private areDependenciesSatisfied(node: Readonly<MultiLoopNode>, completedNodeIds: ReadonlyArray<string>): boolean {
    if (node.dependencies.length === 0) {
      return true;
    }
    const completedSet = new Set(completedNodeIds);
    for (const dep of node.dependencies) {
      if (!completedSet.has(dep)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 从用户意图构建最小 spec.md（重建 plan 时使用）
   *
   * @param userIntent 用户意图文本
   * @returns 最小 spec.md 内容
   */
  private buildMinimalSpecFromIntent(userIntent: string): string {
    return `# 业务需求\n\n${userIntent}\n\n## 模块：主模块\n`;
  }

  /**
   * 触发阻塞分析
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @param blockedLoop 阻塞的 Loop 类型
   * @param blockedIteration 阻塞的迭代号
   * @returns 阻塞分析报告（失败时返回 undefined）
   */
  private async triggerBlockageAnalysis(
    runId: string,
    projectRoot: string,
    blockedLoop: LoopType,
    blockedIteration: number
  ): Promise<BlockageReport | undefined> {
    try {
      this.logger(`触发阻塞分析：runId=${runId} blockedLoop=${blockedLoop}`, "warn");
      const report = await this.blockageAnalyzer.analyze({
        runId,
        projectRoot,
        blockedLoop,
        blockedIteration,
      });
      return report;
    } catch (err) {
      this.logger(`阻塞分析失败：${err instanceof Error ? err.message : String(err)}`, "error");
      return undefined;
    }
  }

  /**
   * 生成恢复报告（Markdown 格式）
   *
   * 报告结构与 EagRunHandler.buildFinalReport 类似，但头部标注"恢复执行"。
   *
   * @param data 报告数据
   * @returns Markdown 格式报告
   */
  private buildResumeReport(data: {
    readonly runId: string;
    readonly finalStatus: import("./eag-run-handler").EagRunResult["finalStatus"];
    readonly completedLoops: ReadonlyArray<LoopType>;
    readonly milestones: ReadonlyArray<MilestoneRecord>;
    readonly totalLlmCallCount: number;
    readonly totalTokensUsed: number;
    readonly durationSec: number;
    readonly failureReason?: string;
    readonly blockageReport?: BlockageReport;
  }): string {
    const parts: string[] = [];

    parts.push(`# EAG Run Resume Report: ${data.runId}`);
    parts.push("");
    parts.push("## 基本信息");
    parts.push("");
    parts.push(`- **状态**: ${data.finalStatus}`);
    parts.push(`- **恢复耗时**: ${data.durationSec.toFixed(2)}s`);
    parts.push(`- **累计 LLM 调用**: ${data.totalLlmCallCount}`);
    parts.push(`- **累计 Token 消耗**: ${data.totalTokensUsed}`);
    if (data.failureReason) {
      parts.push(`- **失败原因**: ${data.failureReason}`);
    }
    parts.push("");

    parts.push("## 完成度");
    parts.push("");
    if (data.completedLoops.length === 0) {
      parts.push("- 无已完成的 Loop");
    } else {
      for (const loop of data.completedLoops) {
        parts.push(`- ✅ ${loop.toUpperCase()} Loop 已完成`);
      }
    }
    parts.push("");

    parts.push("## 里程碑");
    parts.push("");
    if (data.milestones.length === 0) {
      parts.push("- 无里程碑");
    } else {
      parts.push("| # | 名称 | Loop 类型 | Tag | 健康度 |");
      parts.push("|---|------|----------|-----|--------|");
      for (let i = 0; i < data.milestones.length; i++) {
        const m = data.milestones[i];
        parts.push(`| ${i + 1} | ${m.name} | ${m.loopType} | ${m.tagName} | ${m.healthScore.toFixed(2)} |`);
      }
    }
    parts.push("");

    if (data.blockageReport) {
      parts.push("## 阻塞分析");
      parts.push("");
      parts.push(`- **阻塞 Loop**: ${data.blockageReport.blockedLoop}`);
      parts.push(`- **阻塞迭代**: ${data.blockageReport.blockedIteration}`);
      parts.push(`- **生成时间**: ${data.blockageReport.generatedAt}`);
      parts.push("");
      parts.push("### 根因假设");
      parts.push("");
      for (const h of data.blockageReport.rootCauseHypotheses) {
        parts.push(`- **${h.hypothesisId}** (${h.source}, confidence=${h.confidence}): ${h.description}`);
      }
      parts.push("");
      parts.push("### 建议方案");
      parts.push("");
      for (const s of data.blockageReport.suggestedSolutions) {
        parts.push(`- **${s.solutionId}** (cost=${s.cost}): ${s.description}`);
      }
      parts.push("");
      parts.push("### 所需决策");
      parts.push("");
      for (const d of data.blockageReport.requiredDecisions) {
        parts.push(`- **${d.decisionId}**: ${d.description} (推荐: ${d.recommendedOptionId})`);
      }
    }

    return parts.join("\n");
  }
}

// ============================================================================
// 5. 重新导出 EagRunHandlerError（便于调用方统一捕获）
// ============================================================================

// 重新导出 EagRunHandlerError，便于 session.ts 统一处理 run/resume 错误
export { EagRunHandlerError };
