/**
 * /eag-run 命令处理器（EagRunHandler）—— EAG-P3 批次 10 §4.12
 *
 * 本模块实现 EAG 方案 §5.12.2 + 设计文档 §4.12 所述的 /eag-run 命令处理逻辑，
 * 串联 DESIGN → CODING → TESTING 三 Loop 的完整长程自动化执行链路。
 *
 * 核心职责（对齐设计文档 §4.12.1）：
 * 1. 解析用户意图 → 生成或复用 spec.md
 * 2. 调用 MultiLoopPlanner.plan() 生成多 Loop 串联 DAG
 * 3. 调用 RunStateStore.initialize() 创建 RunState（写入 run-started 事件）
 * 4. 按拓扑序遍历 MultiLoopPlan.loops 执行各 Loop 节点：
 *    a. 检查节点依赖是否满足（dependencies 中所有节点 status="completed"）
 *    b. 通过 LoopExecutor 协议调用对应 Loop 编排器（DESIGN/CODING/TESTING）
 *    c. Loop 成功 → 调用 MilestoneTagger.tag() 创建 milestone + 追加 loop-completed 事件
 *    d. Loop 失败 → 调用 MilestoneTagger.rollback() 回滚到上一个 milestone + 追加 human-intervention 事件
 *    e. 自动流转：若 plan.autoTransition=true 且下一节点依赖满足 → 自动进入下一 Loop
 *    f. 非自动流转：返回 human-checkpoint 等待用户检查点确认
 * 5. 全部 Loop 完成 → 追加 run-completed 事件 + 生成最终报告
 * 6. 累计 3 次人工介入未解决 → 调用 BlockageAnalyzer.analyze() + 追加 run-paused 事件
 *
 * 关键技术决策（对齐 §4.12.2 + 工程实践）：
 * - LoopExecutor 协议解耦：EagRunHandler 通过 LoopExecutor 协议调用具体 Loop 编排器，
 *   避免长程自动化模块直接耦合 DesignLoopOrchestrator/CodingOrchestrator/TestingOrchestrator
 *   的具体 run() 方法签名（三者签名差异巨大，且本批次不实施 session.ts 集成）
 * - 真实业务实现：LoopExecutor 是协议接口，由调用方（session.ts 批次 11）注入真实实现，
 *   测试时使用基于真实业务逻辑的 LoopExecutor 实现（非 mock）
 * - 失败回滚：调用 MilestoneTagger.rollback() 通过 git reset --hard <tag> 回滚到上一个里程碑
 * - 阻塞触发：humanInterventionCount >= 3 时自动调用 BlockageAnalyzer + 暂停 Run
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/long-horizon/eag-run-handler
 */

import * as crypto from "node:crypto";
import type { LoopType } from "../loop/models";
import type { BlockageReport, LogCallback, MilestoneRecord, MultiLoopNode, MultiLoopPlan, RunState } from "./types";
import { BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD, DEFAULT_MAX_MULTI_LOOP_ITERATIONS } from "./types";
import type { MultiLoopPlanner } from "./multi-loop-planner";
import type { RunStateStore } from "./run-state-store";
import type { MilestoneTagger } from "./milestone-tagger";
import type { BlockageAnalyzer } from "./blockage-analyzer";

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

// ============================================================================
// 2. 自定义错误类
// ============================================================================

/**
 * /eag-run 命令处理器错误类型（字面量联合类型）
 *
 * - request-invalid：请求字段非法
 * - plan-failed：多 Loop 计划生成失败
 * - run-state-error：RunState 持久化失败
 * - loop-execution-failed：Loop 执行失败且无法自动回滚
 * - milestone-error：里程碑 tag 创建或回滚失败
 * - blockage-analysis-failed：阻塞分析失败
 */
export type EagRunHandlerErrorKind =
  | "request-invalid"
  | "plan-failed"
  | "run-state-error"
  | "loop-execution-failed"
  | "milestone-error"
  | "blockage-analysis-failed";

/**
 * /eag-run 命令处理器错误基类
 *
 * 含错误类型与详细信息，便于调用方区分处理。
 */
export class EagRunHandlerError extends Error {
  /**
   * @param kind 错误类型
   * @param detail 错误详情
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: EagRunHandlerErrorKind,
    public readonly detail: string,
    public readonly cause?: unknown
  ) {
    super(`EagRunHandler 错误 [${kind}]：${detail}`);
    this.name = "EagRunHandlerError";
  }
}

// ============================================================================
// 3. LoopExecutor 协议（接口）—— 解耦具体 Loop 编排器
// ============================================================================

/**
 * Loop 执行上下文（LoopExecutor.execute 入参）
 *
 * 描述执行单个 Loop 节点所需的全部上下文：
 * - 节点信息（nodeId / loopType / dependencies）
 * - Run 上下文（runId / projectRoot）
 * - 用户原始请求（userIntent / specContent / autoTransition / maxIterations / coverageThreshold / compliancePackIds）
 * - 共享依赖（llmClient / pkcAccessor / loopGuard 由调用方注入到 LoopExecutor 实现中）
 *
 * 字段全部 readonly——上下文一经构造即不可变。
 */
export interface LoopExecutionContext {
  /** 当前执行的节点（MultiLoopPlan.loops 中的一个节点） */
  readonly node: Readonly<MultiLoopNode>;
  /** run-id（关联 RunState） */
  readonly runId: string;
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 用户意图文本（如"我需要一个订单管理微服务"） */
  readonly userIntent: string;
  /** spec.md 内容（DESIGN Loop 产出，CODING/TESTING Loop 复用） */
  readonly specContent?: string;
  /** 是否自动流转（前一 Loop 成功后是否自动进入下一 Loop） */
  readonly autoTransition: boolean;
  /** 最大 Loop 迭代次数 */
  readonly maxIterations: number;
  /** 覆盖率阈值（TESTING Loop 使用） */
  readonly coverageThreshold?: Readonly<Record<string, unknown>>;
  /** 启用的 ICP 合规包 ID 列表（TESTING Loop 使用） */
  readonly compliancePackIds?: ReadonlyArray<string>;
  /** 当前已完成节点 ID 列表（按拓扑序） */
  readonly completedNodeIds: ReadonlyArray<string>;
}

/**
 * Loop 执行结果（LoopExecutor.execute 产出）
 *
 * 描述单个 Loop 节点执行后的产出：
 * - finalStatus：completed / failed / human-checkpoint
 * - generatedArtifacts：Loop 产出的文档内容（spec/plan/tasks/...）
 * - llmCallCount / tokensUsed：本 Loop 的资源消耗
 * - durationSec：本 Loop 耗时
 * - failureReason：失败原因（finalStatus != completed 时填写）
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface LoopExecutionResult {
  /** 节点 ID（对应 LoopExecutionContext.node.nodeId） */
  readonly nodeId: string;
  /** Loop 类型 */
  readonly loopType: LoopType;
  /** 最终状态（completed / failed / human-checkpoint） */
  readonly finalStatus: "completed" | "failed" | "human-checkpoint";
  /** Loop 产出的文档内容（key 为文档类型如 "spec"/"plan"/"tasks"，value 为文档内容） */
  readonly generatedArtifacts: Readonly<Record<string, string>>;
  /** 本 Loop 的 LLM 调用次数 */
  readonly llmCallCount: number;
  /** 本 Loop 的 token 消耗 */
  readonly tokensUsed: number;
  /** 本 Loop 耗时（秒） */
  readonly durationSec: number;
  /** 失败原因（finalStatus != completed 时填写） */
  readonly failureReason?: string;
}

/**
 * Loop 执行器协议（接口）
 *
 * 解耦 EagRunHandler 与具体 Loop 编排器（DesignLoopOrchestrator / CodingOrchestrator / TestingOrchestrator），
 * 让长程自动化模块仅依赖此协议而非具体编排器的 run() 方法签名。
 *
 * 实现方负责：
 * 1. 根据 context.loopType 路由到对应的具体编排器
 * 2. 构造具体编排器的 run() 方法所需入参（从 context 中提取 + 内部生成）
 * 3. 调用具体编排器的 run() 方法
 * 4. 将编排器产出转换为 LoopExecutionResult 返回
 *
 * 真实实现位置：session.ts（批次 11 实施）注入 DesignLoopOrchestrator/CodingOrchestrator/TestingOrchestrator 的包装器
 * 测试实现位置：tests/eag-long-horizon-eag-run-handler.test.ts 使用基于真实业务逻辑的 LoopExecutor（非 mock）
 *
 * 设计依据：依赖倒置原则（DIP）+ 单一职责原则（SRP）。
 */
export interface LoopExecutor {
  /** Loop 类型（design / coding / testing） */
  readonly loopType: LoopType;
  /**
   * 执行单个 Loop 节点
   *
   * @param context Loop 执行上下文
   * @returns Loop 执行结果
   */
  execute(context: Readonly<LoopExecutionContext>): Promise<Readonly<LoopExecutionResult>>;
}

// ============================================================================
// 4. EagRunRequest / EagRunResult 接口
// ============================================================================

/**
 * /eag-run 命令请求
 *
 * 对应设计文档 §4.12.2 EagRunRequest。
 *
 * 字段全部 readonly——请求一经构造即不可变。
 *
 * 范例：
 *   {
 *     projectRoot: "/path/to/project",
 *     userIntent: "我需要一个订单管理微服务",
 *     autoTransition: false,
 *     maxIterations: 30,
 *     loopExecutors: [designExecutor, codingExecutor, testingExecutor]
 *   }
 */
export interface EagRunRequest {
  /** 项目根目录（绝对路径或相对路径，内部 path.resolve 处理） */
  readonly projectRoot: string;
  /** 用户意图文本（如"我需要一个订单管理微服务"） */
  readonly userIntent: string;
  /** spec.md 内容（可选，如未提供由 DESIGN Loop 生成） */
  readonly specContent?: string;
  /** 是否自动流转（默认 false，DESIGN→CODING 需用户检查点） */
  readonly autoTransition?: boolean;
  /** 最大 Loop 迭代次数（默认 30） */
  readonly maxIterations?: number;
  /** Loop 执行器列表（按 LoopType 路由，由调用方注入真实实现） */
  readonly loopExecutors: ReadonlyArray<LoopExecutor>;
  /** 覆盖率阈值（可选，TESTING Loop 使用） */
  readonly coverageThreshold?: Readonly<Record<string, unknown>>;
  /** 启用的 ICP 合规包 ID 列表（可选，TESTING Loop 使用） */
  readonly compliancePackIds?: ReadonlyArray<string>;
  /** run-id（可选，未提供时由 RunStateStore 自动生成 12 位 UUID 前缀） */
  readonly runId?: string;
}

/**
 * /eag-run 命令结果
 *
 * 对应设计文档 §4.12.2 EagRunResult。
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface EagRunResult {
  /** run-id（与 RunState.runId 一致） */
  readonly runId: string;
  /** 最终状态（completed / failed / human-checkpoint / paused） */
  readonly finalStatus: "completed" | "failed" | "human-checkpoint" | "paused";
  /** 完成的 Loop 列表（按完成顺序，如 ["design", "coding"]） */
  readonly completedLoops: ReadonlyArray<LoopType>;
  /** 里程碑列表（按时间顺序，每个 Loop 完成 = 一个里程碑） */
  readonly milestones: ReadonlyArray<MilestoneRecord>;
  /** 最终 RunState（含全部事件重放后的状态） */
  readonly finalRunState: Readonly<RunState>;
  /** 最终报告（Markdown 格式，含完成度/耗时/token 消耗/阻塞点） */
  readonly finalReport: string;
  /** 阻塞分析报告（finalStatus != completed 时填写） */
  readonly blockageReport?: Readonly<BlockageReport>;
  /** 总 LLM 调用次数（所有 Loop 汇总） */
  readonly totalLlmCallCount: number;
  /** 总 token 消耗（所有 Loop 汇总） */
  readonly totalTokensUsed: number;
  /** 总耗时（秒） */
  readonly durationSec: number;
}

// ============================================================================
// 5. EagRunHandler 主类
// ============================================================================

/**
 * /eag-run 命令处理器
 *
 * 对应 EAG 方案 §5.12.2 + 设计文档 §4.12：
 * 串联 DESIGN → CODING → TESTING 三 Loop，自动流转 + 失败回滚 + 阻塞分析。
 *
 * 使用方式：
 * ```typescript
 * const handler = new EagRunHandler({
 *   multiLoopPlanner: new MultiLoopPlanner(),
 *   runStateStore: new RunStateStore(),
 *   milestoneTagger: new MilestoneTagger(...),
 *   blockageAnalyzer: new BlockageAnalyzer(...),
 *   loopExecutors: [designExecutor, codingExecutor, testingExecutor],
 * });
 * const result = await handler.handle({
 *   projectRoot: "/path/to/project",
 *   userIntent: "我需要一个订单管理微服务",
 *   loopExecutors: [designExecutor, codingExecutor, testingExecutor],
 * });
 * ```
 *
 * 状态隔离：每次 handle() 调用应在独立的 EagRunHandler 实例上执行，
 * 避免多次 run 之间的状态污染。
 */
export class EagRunHandler {
  // ----------------------------------------------------------------------
  // 私有字段
  // ----------------------------------------------------------------------

  /** 多 Loop 串联计划生成器（依赖注入） */
  private readonly multiLoopPlanner: MultiLoopPlanner;
  /** RunState 持久化存储（依赖注入） */
  private readonly runStateStore: RunStateStore;
  /** 里程碑 tag 生成器（依赖注入） */
  private readonly milestoneTagger: MilestoneTagger;
  /** 阻塞分析器（依赖注入） */
  private readonly blockageAnalyzer: BlockageAnalyzer;
  /** 默认 Loop 执行器列表（依赖注入，可被 request.loopExecutors 覆盖） */
  private readonly defaultLoopExecutors: ReadonlyMap<LoopType, LoopExecutor>;
  /** 日志回调 */
  private readonly logger: LogCallback;

  // ----------------------------------------------------------------------
  // 构造函数
  // ----------------------------------------------------------------------

  /**
   * 初始化 /eag-run 命令处理器
   *
   * @param options 注入选项
   * @param options.multiLoopPlanner 多 Loop 串联计划生成器（必填）
   * @param options.runStateStore RunState 持久化存储（必填）
   * @param options.milestoneTagger 里程碑 tag 生成器（必填）
   * @param options.blockageAnalyzer 阻塞分析器（必填）
   * @param options.loopExecutors Loop 执行器列表（可选，可由 request.loopExecutors 覆盖）
   * @param options.logger 日志回调（可选）
   */
  constructor(options: {
    readonly multiLoopPlanner: MultiLoopPlanner;
    readonly runStateStore: RunStateStore;
    readonly milestoneTagger: MilestoneTagger;
    readonly blockageAnalyzer: BlockageAnalyzer;
    readonly loopExecutors?: ReadonlyArray<LoopExecutor>;
    readonly logger?: LogCallback;
  }) {
    // 校验必填依赖（fail-fast，避免运行时 NPE）
    if (!options || !options.multiLoopPlanner) {
      throw new EagRunHandlerError("request-invalid", "multiLoopPlanner 必填");
    }
    if (!options.runStateStore) {
      throw new EagRunHandlerError("request-invalid", "runStateStore 必填");
    }
    if (!options.milestoneTagger) {
      throw new EagRunHandlerError("request-invalid", "milestoneTagger 必填");
    }
    if (!options.blockageAnalyzer) {
      throw new EagRunHandlerError("request-invalid", "blockageAnalyzer 必填");
    }

    this.multiLoopPlanner = options.multiLoopPlanner;
    this.runStateStore = options.runStateStore;
    this.milestoneTagger = options.milestoneTagger;
    this.blockageAnalyzer = options.blockageAnalyzer;

    // 将 loopExecutors 数组转为 Map<LoopType, LoopExecutor>，便于 O(1) 查找
    const executorMap = new Map<LoopType, LoopExecutor>();
    if (options.loopExecutors) {
      for (const executor of options.loopExecutors) {
        executorMap.set(executor.loopType, executor);
      }
    }
    this.defaultLoopExecutors = Object.freeze(executorMap);
    this.logger = options.logger ?? noopLog;
  }

  // ----------------------------------------------------------------------
  // 公共 API
  // ----------------------------------------------------------------------

  /**
   * 执行 /eag-run 命令
   *
   * 完整时序（对齐设计文档 §4.12.2）：
   * 1. 校验请求字段
   * 2. 调用 MultiLoopPlanner.plan() 生成多 Loop 计划
   * 3. 调用 RunStateStore.initialize() 创建 RunState
   * 4. 按拓扑序遍历 MultiLoopPlan.loops 执行各 Loop 节点
   * 5. 全部完成 → 追加 run-completed 事件 + 生成最终报告
   * 6. 累计 3 次人工介入 → 调用 BlockageAnalyzer + 追加 run-paused 事件
   *
   * @param request 命令请求
   * @returns 执行结果（含最终状态 + RunState + 报告）
   * @throws EagRunHandlerError 请求非法 / 计划生成失败 / RunState 持久化失败
   */
  async handle(request: Readonly<EagRunRequest>): Promise<Readonly<EagRunResult>> {
    // ===== Step 1: 校验请求字段 =====
    this.validateRequest(request);

    const startTime = Date.now();
    this.logger(`/eag-run 启动：projectRoot=${request.projectRoot} userIntent="${request.userIntent}"`, "info");

    // ===== Step 2: 装配 Loop 执行器 Map =====
    // 优先使用 request.loopExecutors，否则回退到构造时注入的 defaultLoopExecutors
    const executorMap = this.resolveExecutors(request);

    // ===== Step 3: 生成或复用 runId =====
    // 必须在调用 MultiLoopPlanner.plan() 之前确定 runId，因为 planner 要求 runId 非空。
    // 若调用方未提供 runId，则生成 12 位 UUID 前缀（与 RunStateStore.generateRunId 算法一致）。
    const resolvedRunId = request.runId ?? this.generateRunId();

    // ===== Step 4: 调用 MultiLoopPlanner.plan() 生成多 Loop 计划 =====
    // specContent 未提供时使用 userIntent 作为最小 spec（DESIGN Loop 内部会细化为完整 spec.md）
    const specForPlan = request.specContent ?? this.buildMinimalSpecFromIntent(request.userIntent);
    let plan: Readonly<MultiLoopPlan>;
    try {
      plan = await this.multiLoopPlanner.plan({
        runId: resolvedRunId,
        projectRoot: request.projectRoot,
        specContent: specForPlan,
        autoTransition: request.autoTransition ?? false,
        rollbackOnFailure: true,
      });
    } catch (err) {
      throw new EagRunHandlerError(
        "plan-failed",
        `多 Loop 计划生成失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // ===== Step 5: 调用 RunStateStore.initialize() 创建 RunState =====
    let runState: Readonly<RunState>;
    try {
      runState = await this.runStateStore.initialize({
        runId: resolvedRunId,
        projectRoot: request.projectRoot,
        initialLoop: plan.loops.length > 0 ? plan.loops[0].loopType : "design",
      });
    } catch (err) {
      throw new EagRunHandlerError(
        "run-state-error",
        `RunState 初始化失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // 用实际生成的 runId 重新装配 plan（planner 内部使用 planId = runId）
    if (plan.planId !== runState.runId) {
      plan = Object.freeze({
        ...plan,
        planId: runState.runId,
      });
    }

    // ===== Step 6: 按拓扑序遍历执行各 Loop 节点 =====
    const completedLoops: LoopType[] = [];
    const milestones: MilestoneRecord[] = [];
    const completedNodeIds: string[] = [];
    let totalLlmCallCount = 0;
    let totalTokensUsed = 0;
    let currentSpecContent = request.specContent ?? "";
    let currentPlanContent = "";
    let currentTasksContent = "";
    let blockageReport: BlockageReport | undefined;
    let finalStatus: EagRunResult["finalStatus"] = "completed";
    let failureReason: string | undefined;

    for (const node of plan.loops) {
      // 5.1 检查节点依赖是否满足
      if (!this.areDependenciesSatisfied(node, completedNodeIds)) {
        // 依赖未满足：理论上 planner 已校验 DAG 合法性，此处仅作安全保护
        failureReason = `节点 ${node.nodeId} 依赖未满足：${node.dependencies.join(", ")}`;
        finalStatus = "failed";
        this.logger(`节点依赖未满足：${node.nodeId}`, "error");
        break;
      }

      // 5.2 追加 loop-started 事件
      try {
        runState = await this.runStateStore.appendEvent(runState.runId, {
          type: "loop-started",
          payload: {
            loopType: node.loopType,
            iteration: 1,
            nodeId: node.nodeId,
          },
        });
      } catch (err) {
        throw new EagRunHandlerError(
          "run-state-error",
          `追加 loop-started 事件失败：${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      // 5.3 通过 LoopExecutor 协议调用对应 Loop 编排器
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
        specContent: currentSpecContent || undefined,
        autoTransition: plan.autoTransition,
        maxIterations: request.maxIterations ?? DEFAULT_MAX_MULTI_LOOP_ITERATIONS,
        coverageThreshold: request.coverageThreshold,
        compliancePackIds: request.compliancePackIds,
        completedNodeIds: [...completedNodeIds],
      });

      let loopResult: Readonly<LoopExecutionResult>;
      try {
        this.logger(`执行 Loop 节点：${node.nodeId} (type=${node.loopType})`, "info");
        loopResult = await executor.execute(context);
      } catch (err) {
        // Loop 执行抛出异常：视为 failed
        failureReason = `Loop ${node.nodeId} 执行抛出异常：${err instanceof Error ? err.message : String(err)}`;
        finalStatus = "failed";
        this.logger(`Loop 执行异常：${node.nodeId} - ${failureReason}`, "error");

        // 追加 human-intervention 事件
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

        // 检查是否触发阻塞分析
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

      // 5.4 处理 Loop 执行结果
      if (loopResult.finalStatus === "completed") {
        // Loop 成功：更新上下文 + 创建 milestone
        if (loopResult.generatedArtifacts.spec) {
          currentSpecContent = loopResult.generatedArtifacts.spec;
        }
        if (loopResult.generatedArtifacts.plan) {
          currentPlanContent = loopResult.generatedArtifacts.plan;
        }
        if (loopResult.generatedArtifacts.tasks) {
          currentTasksContent = loopResult.generatedArtifacts.tasks;
        }

        // 创建里程碑 tag
        try {
          const milestone = await this.milestoneTagger.tag({
            runId: runState.runId,
            projectRoot: request.projectRoot,
            name: `${node.loopType.toUpperCase()} Loop 完成`,
            loopType: node.loopType,
          });
          milestones.push(milestone);

          // 追加 loop-completed + milestone-tagged 事件
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

          this.logger(`Loop 节点完成：${node.nodeId} milestone=${milestone.tagName}`, "info");
        } catch (err) {
          throw new EagRunHandlerError(
            "milestone-error",
            `里程碑 tag 创建失败：${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }
      } else if (loopResult.finalStatus === "human-checkpoint") {
        // Loop 等待人工决策：返回 human-checkpoint
        failureReason = loopResult.failureReason ?? `Loop ${node.nodeId} 等待人工决策`;
        finalStatus = "human-checkpoint";

        // 追加 human-intervention 事件
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

        // 检查是否触发阻塞分析
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

        // 非自动流转或阻塞触发：跳出循环
        break;
      } else {
        // Loop 失败：回滚到上一个 milestone + 追加 human-intervention 事件
        failureReason = loopResult.failureReason ?? `Loop ${node.nodeId} 执行失败`;

        try {
          // 回滚到上一个 milestone（如有）
          if (milestones.length > 0) {
            await this.milestoneTagger.rollback(runState.runId, request.projectRoot);
            this.logger(`已回滚到上一个 milestone：${milestones[milestones.length - 1].tagName}`, "warn");
          }

          // 追加 human-intervention 事件
          runState = await this.runStateStore.appendEvent(runState.runId, {
            type: "human-intervention",
            payload: {
              loopType: node.loopType,
              reason: failureReason,
              decision: "pending",
            },
          });

          // 检查是否触发阻塞分析
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
          throw new EagRunHandlerError(
            "milestone-error",
            `里程碑回滚失败：${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }

        // 失败后跳出循环（除非自动流转且依赖满足，但本批次简化为失败即停止）
        break;
      }
    }

    // ===== Step 6: 追加终态事件（run-completed / run-failed） =====
    if (finalStatus === "completed") {
      try {
        runState = await this.runStateStore.appendEvent(runState.runId, {
          type: "run-completed",
          payload: {
            finalReport: "Run 完成",
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

    // ===== Step 7: 生成最终报告 =====
    const durationSec = (Date.now() - startTime) / 1000;
    const finalReport = this.buildFinalReport({
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
      `/eag-run 完成：runId=${runState.runId} finalStatus=${finalStatus} duration=${durationSec.toFixed(2)}s`,
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
   * 校验 /eag-run 请求字段
   *
   * 校验规则：
   * - projectRoot 必填且为非空字符串
   * - userIntent 必填且为非空字符串
   * - loopExecutors 必填且非空数组
   * - maxIterations 若提供必须为 >= 1 的整数
   *
   * @param request 请求对象
   * @throws EagRunHandlerError 请求字段非法时抛出
   */
  private validateRequest(request: Readonly<EagRunRequest>): void {
    if (!request || typeof request !== "object") {
      throw new EagRunHandlerError("request-invalid", "request 必须为对象");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new EagRunHandlerError("request-invalid", "projectRoot 必须为非空字符串");
    }
    if (typeof request.userIntent !== "string" || request.userIntent.trim().length === 0) {
      throw new EagRunHandlerError("request-invalid", "userIntent 必须为非空字符串");
    }
    if (!Array.isArray(request.loopExecutors) || request.loopExecutors.length === 0) {
      throw new EagRunHandlerError("request-invalid", "loopExecutors 必须为非空数组");
    }
    if (request.maxIterations !== undefined) {
      if (!Number.isInteger(request.maxIterations) || request.maxIterations < 1) {
        throw new EagRunHandlerError("request-invalid", "maxIterations 必须为整数且 >= 1");
      }
    }
    // 校验每个 LoopExecutor 必须实现 loopType 与 execute 方法
    for (let i = 0; i < request.loopExecutors.length; i++) {
      const executor = request.loopExecutors[i];
      if (!executor || typeof executor.loopType !== "string" || typeof executor.execute !== "function") {
        throw new EagRunHandlerError(
          "request-invalid",
          `loopExecutors[${i}] 必须实现 LoopExecutor 协议（含 loopType 字段与 execute 方法）`
        );
      }
    }
  }

  /**
   * 装配 Loop 执行器 Map
   *
   * 优先使用 request.loopExecutors，否则回退到构造时注入的 defaultLoopExecutors。
   *
   * @param request 请求对象
   * @returns LoopType → LoopExecutor 的映射 Map
   */
  private resolveExecutors(request: Readonly<EagRunRequest>): ReadonlyMap<LoopType, LoopExecutor> {
    const executorMap = new Map<LoopType, LoopExecutor>();
    // 优先填充 request.loopExecutors
    for (const executor of request.loopExecutors) {
      executorMap.set(executor.loopType, executor);
    }
    // 回退填充 defaultLoopExecutors（仅填充 request 未提供的 LoopType）
    for (const [loopType, executor] of this.defaultLoopExecutors) {
      if (!executorMap.has(loopType)) {
        executorMap.set(loopType, executor);
      }
    }
    return Object.freeze(executorMap);
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
   * 从用户意图构建最小 spec.md（当 request.specContent 未提供时使用）
   *
   * 算法：将 userIntent 包装为单模块 spec.md（模块名"主模块"），
   * 供 MultiLoopPlanner.plan() 解析。
   *
   * @param userIntent 用户意图文本
   * @returns 最小 spec.md 内容
   */
  private buildMinimalSpecFromIntent(userIntent: string): string {
    return `# 业务需求\n\n${userIntent}\n\n## 模块：主模块\n`;
  }

  /**
   * 生成 12 位 UUID 前缀作为 runId
   *
   * 与 RunStateStore.generateRunId 算法一致，确保 handler 在调用 planner 之前
   * 即可生成 runId（planner 要求 runId 非空），同时保证 RunStateStore.initialize
   * 使用同一 runId 创建文件。
   *
   * @returns 12 位十六进制字符串
   */
  private generateRunId(): string {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return uuid.substring(0, 12);
  }

  /**
   * 触发阻塞分析
   *
   * 算法：调用 BlockageAnalyzer.analyze() 生成阻塞分析报告。
   * 失败时仅记录日志，不阻断主流程（避免阻塞分析失败导致 Run 无法终止）。
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
      // BlockageAnalyzer.analyze() 的签名见 blockage-analyzer.ts
      // 此处通过类型断言避免循环导入（blockage-analyzer.ts 反向依赖 types.ts）
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
   * 生成最终报告（Markdown 格式）
   *
   * 报告包含：
   * - 基本信息（run-id / 最终状态 / 总耗时 / 总 token）
   * - 完成度（已完成的 Loop 列表）
   * - 里程碑列表（序号 + 名称 + tag）
   * - 阻塞点（如有）
   *
   * @param data 报告数据
   * @returns Markdown 格式报告
   */
  private buildFinalReport(data: {
    readonly runId: string;
    readonly finalStatus: EagRunResult["finalStatus"];
    readonly completedLoops: ReadonlyArray<LoopType>;
    readonly milestones: ReadonlyArray<MilestoneRecord>;
    readonly totalLlmCallCount: number;
    readonly totalTokensUsed: number;
    readonly durationSec: number;
    readonly failureReason?: string;
    readonly blockageReport?: BlockageReport;
  }): string {
    const parts: string[] = [];

    // ===== 章节 1：基本信息 =====
    parts.push(`# EAG Run Report: ${data.runId}`);
    parts.push("");
    parts.push("## 基本信息");
    parts.push("");
    parts.push(`- **状态**: ${data.finalStatus}`);
    parts.push(`- **总耗时**: ${data.durationSec.toFixed(2)}s`);
    parts.push(`- **总 LLM 调用**: ${data.totalLlmCallCount}`);
    parts.push(`- **总 Token 消耗**: ${data.totalTokensUsed}`);
    if (data.failureReason) {
      parts.push(`- **失败原因**: ${data.failureReason}`);
    }
    parts.push("");

    // ===== 章节 2：完成度 =====
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

    // ===== 章节 3：里程碑列表 =====
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

    // ===== 章节 4：阻塞点（如有） =====
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
