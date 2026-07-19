/**
 * Loop Engineering 核心编排器：LoopKernel（TypeScript 移植版）
 *
 * 实现五步闭环：
 *     Discovery → Handoff → Verification → Persistence → Scheduling
 *
 * LoopKernel 不直接执行具体业务逻辑，而是通过 Protocol 组合以下组件：
 * - DiscoveryProbeProtocol：发现本轮该做什么
 * - HandoffAdapterProtocol：生成工作项并调用 Generator 执行
 * - IndependentEvaluatorProtocol：独立评估 Generator 产出
 * - UnifiedMemoryLayerProtocol：统一记忆读写
 * - LoopScheduler：决定下一步动作
 *
 * 移植来源：multi-agent-team skill scripts/loop_engineering/kernel.py
 *
 * 设计约束：
 * - 所有依赖均为真实对象实例，禁止 mock（遵循项目"禁止 mock"规则）
 * - 上限保护：max_iterations / max_tokens / 连续失败上限（由 Scheduler 判定）
 * - 事件驱动：每步产生 LoopEvent 并写入 Memory
 * - 可安全停止：stop() 设置停止标志，当前轮次完成后退出
 *
 * @module eag/loop/kernel
 */

import type {
  LoopEngineeringConfig,
  LogCallback,
  LoopEvent,
  LoopEventType,
  LoopRunReport,
  LoopCycleResult,
  HumanCheckpointResponse,
} from "./models";
import type {
  DiscoveryProbeProtocol,
  HandoffAdapterProtocol,
  IndependentEvaluatorProtocol,
  UnifiedMemoryLayerProtocol,
} from "./protocols";
import type { LoopScheduler } from "./scheduler";
import type { SchedulingAction } from "./models";
// EAG-P3 批次 10 §4.17.2 扩展：多 Loop 串联调度
// 使用 type-only import 避免运行期循环依赖（long-horizon/types re-export 了 loop/models 的类型，
// 但 type-only import 仅在编译期解析，不会触发运行期模块加载循环）
import type { MultiLoopPlan, MultiLoopRunReport, MultiLoopNodeResult, MultiLoopNode } from "../long-horizon/types";
import type { RunStateStore } from "../long-horizon/run-state-store";

// ============================================================================
// LoopKernel 类
// ============================================================================

/**
 * Loop Engineering 五步闭环编排核心
 *
 * 用法：
 * ```typescript
 * const kernel = new LoopKernel(
 *   config,
 *   discoveryProbe,
 *   handoffAdapter,
 *   evaluator,
 *   memory,
 *   scheduler,
 *   (msg, level) => console.log(`[${level}] ${msg}`)
 * );
 * const report = kernel.run("实现用户登录功能");
 * ```
 *
 * 状态隔离：每次 run() 调用应在独立的 LoopKernel 实例上执行，
 * 内部状态（_events / _consecutiveFailures / _committedCount）在构造时初始化，
 * 不在多次 run() 之间复用（避免状态污染）。
 */
export class LoopKernel {
  // ============================ 依赖组件 ============================

  /** Loop Engineering 配置（冻结） */
  private readonly config: Readonly<LoopEngineeringConfig>;
  /** Discovery 阶段组件 */
  private readonly discoveryProbe: DiscoveryProbeProtocol;
  /** Handoff 阶段组件 */
  private readonly handoffAdapter: HandoffAdapterProtocol;
  /** 独立 Evaluator 组件 */
  private readonly evaluator: IndependentEvaluatorProtocol;
  /** 统一 Memory 层组件 */
  private readonly memory: UnifiedMemoryLayerProtocol;
  /** Loop 调度器 */
  private readonly scheduler: LoopScheduler;
  /** 日志回调函数 */
  private readonly log: LogCallback;

  // ============================ 运行时状态 ============================

  /** 当前运行唯一标识（12 位 UUID 前缀） */
  private readonly runId: string;
  /** 当前运行产生的全部事件列表 */
  private readonly events: LoopEvent[] = [];
  /** 人类检查点记录 */
  private readonly humanCheckpoints: Array<Readonly<Record<string, unknown>>> = [];
  /** 停止请求标志（由 stop() 设置） */
  private stopRequested: boolean = false;
  /** 当前连续失败次数 */
  private consecutiveFailures: number = 0;
  /** 成功持久化（如 commit）累计次数 */
  private committedCount: number = 0;

  /**
   * 构造 LoopKernel
   *
   * @param config Loop Engineering 配置
   * @param discoveryProbe Discovery 阶段组件
   * @param handoffAdapter Handoff 阶段组件
   * @param evaluator 独立 Evaluator 组件
   * @param memory 统一 Memory 层组件
   * @param scheduler Loop 调度器
   * @param log 日志回调函数（可选，null 表示不输出日志）
   */
  constructor(
    config: Readonly<LoopEngineeringConfig>,
    discoveryProbe: DiscoveryProbeProtocol,
    handoffAdapter: HandoffAdapterProtocol,
    evaluator: IndependentEvaluatorProtocol,
    memory: UnifiedMemoryLayerProtocol,
    scheduler: LoopScheduler,
    log: LogCallback = null
  ) {
    this.config = config;
    this.discoveryProbe = discoveryProbe;
    this.handoffAdapter = handoffAdapter;
    this.evaluator = evaluator;
    this.memory = memory;
    this.scheduler = scheduler;
    this.log = log;
    this.runId = this.generateRunId();
  }

  // ============================ 公开方法 ============================

  /**
   * 启动完整 Loop Engineering 流程
   *
   * 循环执行五步闭环，直到满足停止条件或触发上限。
   *
   * @param objective 运行目标描述
   * @returns 完整运行报告
   */
  run(objective: string): LoopRunReport {
    const startTime = Date.now();
    this.info(`启动 Loop Engineering：runId=${this.runId} loopType=${this.config.loopType} objective="${objective}"`);

    let iterIndex = 0;
    let finalStatus: "completed" | "failed" | "aborted" = "failed";

    while (!this.stopRequested) {
      // 1. 单轮执行
      const cycleResult = this.runOneCycle(objective, iterIndex);

      // 2. 根据调度决策更新状态
      const decision = cycleResult.schedulingDecision;
      if (decision.action === "stop_success") {
        finalStatus = "completed";
        this.info(`Loop 正常完成：${decision.reason}`);
        break;
      }
      if (decision.action === "stop_failure") {
        finalStatus = "failed";
        this.warn(`Loop 失败停止：${decision.reason}`);
        break;
      }
      if (decision.action === "human_checkpoint") {
        // 传入当前 iterIndex，使 human_checkpoint 事件的 iterIndex 字段正确反映触发轮次
        // （修复 M3：原 Python 母本与 TS 初版在 requestHumanCheckpoint 内部硬编码 iterIndex=0，
        //   导致非首轮触发时事件 iterIndex 失真）
        const response = this.requestHumanCheckpoint(decision.reason, iterIndex);
        this.humanCheckpoints.push({
          iterIndex,
          reason: decision.reason,
          approved: response.approved,
          feedback: response.feedback,
          abort: response.abort,
        });
        if (response.abort) {
          finalStatus = "aborted";
          this.info("人类中止 Loop");
          break;
        }
        // 注意：HUMAN_CHECKPOINT 由验证失败触发，consecutiveFailures 的递增
        // 统一在下方 cycleResult.verdict.passed === false 分支处理，
        // 保证连续失败计数能向 STOP_FAILURE 阈值（5）正确递进
      }

      // 3. 下一轮准备 - 基于本轮 verdict 更新连续失败计数
      // 设计：consecutiveFailures 跟踪"连续验证失败次数"，与 action 解耦——
      //   - verdict.passed=true：CONTINUE（重置计数）
      //   - verdict.passed=false：FIX / HUMAN_CHECKPOINT（递增计数）
      //   - STOP_SUCCESS / STOP_FAILURE 已 break，不会到达此处
      if (cycleResult.verdict.passed) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures += 1;
      }

      iterIndex += 1;

      // 4. 安全上限：如果 iterIndex 已超过 max_iterations，强制停止
      if (iterIndex >= this.config.maxIterations) {
        finalStatus = "failed";
        this.warn(`达到最大迭代次数上限 ${this.config.maxIterations}`);
        break;
      }
    }

    // 5. 生成最终报告
    // 注意：stop() 触发时 finalStatus 保持默认值 "failed"（对齐 Python 母本行为）
    // "aborted" 状态仅在人类检查点 abort=true 时使用（见上方 human_checkpoint 分支）
    const durationSec = (Date.now() - startTime) / 1000;
    const tokenUsed = this.memory.estimateTokenUsage();

    // 发射终态事件
    this.emit(finalStatus === "completed" ? "loop_completed" : "loop_failed", "scheduling", iterIndex, {
      finalStatus,
      durationSec,
      tokenUsed,
    });

    const summary = this.buildFinalSummary(objective, iterIndex, finalStatus, durationSec, tokenUsed);

    return {
      runId: this.runId,
      loopType: this.config.loopType,
      objective,
      totalIterations: iterIndex + 1,
      finalStatus,
      events: [...this.events],
      tokenUsed,
      durationSec,
      committedCount: this.committedCount,
      humanCheckpoints: [...this.humanCheckpoints],
      finalSummary: summary,
    };
  }

  // ===========================================================================
  // EAG-P3 批次 10 §4.17.2 扩展：多 Loop 串联调度（向后兼容，新增方法）
  // ===========================================================================

  /**
   * 执行多 Loop 串联计划（EAG-P3 批次 10 §4.17.3）
   *
   * 算法：
   * 1. 遍历 multiLoopPlan.loops（按拓扑序，DESIGN → CODING → TESTING）
   * 2. 对每个节点：
   *    a. 检查依赖是否满足（dependencies 中所有节点 status="completed"）
   *    b. 构造临时 LoopEngineeringConfig（loopType=node.loopType，其他字段复用当前 config）
   *    c. 构造临时 LoopKernel 实例（注入相同组件 + 临时 config）
   *    d. 调用临时 LoopKernel.run(node.objective) 执行单 Loop
   *    e. Loop 成功（finalStatus="completed"）→ 节点 status="completed"
   *    f. Loop 失败（finalStatus="failed"）→ 节点 status="failed" + 终止后续节点
   *    g. Loop 中止（finalStatus="aborted"）→ 节点 status="human-checkpoint" + 终止后续节点
   * 3. 全部节点完成 → 返回 multi-loop 报告（finalStatus="completed"）
   * 4. 中途失败/中止 → 返回 multi-loop 报告（finalStatus="failed" / "human-checkpoint"）
   *
   * 向后兼容性（§4.17.2）：
   * - 既有 run() 方法不变，调用方未调用 scheduleMultiLoop() 时不受影响
   * - 仅当 config.multiLoopPlan 存在且调用方显式调用 scheduleMultiLoop() 时进入多 Loop 模式
   * - 同一份 DiscoveryProbe / HandoffAdapter / Evaluator / Memory / Scheduler 组件可被复用
   *
   * @param multiLoopPlan 多 Loop 串联计划
   * @param runStateStore RunState 持久化存储（可选，提供时记录 loop-started / loop-completed 事件）
   * @returns 多 Loop 执行报告
   */
  async scheduleMultiLoop(
    multiLoopPlan: Readonly<MultiLoopPlan>,
    runStateStore?: RunStateStore
  ): Promise<Readonly<MultiLoopRunReport>> {
    const startTime = Date.now();
    this.info(`启动多 Loop 串联调度：planId=${multiLoopPlan.planId} 节点数=${multiLoopPlan.loops.length}`);

    // 校验入参
    if (!multiLoopPlan || !multiLoopPlan.loops || multiLoopPlan.loops.length === 0) {
      throw new Error("scheduleMultiLoop 入参非法：multiLoopPlan.loops 不能为空");
    }

    // 节点状态映射表：nodeId → status（"pending" | "completed" | "failed" | "human-checkpoint"）
    // 初始化为 "pending"，遍历过程中更新
    const nodeStatusMap = new Map<string, "pending" | "completed" | "failed" | "human-checkpoint">();
    for (const node of multiLoopPlan.loops) {
      nodeStatusMap.set(node.nodeId, "pending");
    }

    // 节点结果列表（按拓扑序）
    const nodeResults: MultiLoopNodeResult[] = [];

    // 累计统计
    let totalIterations = 0;
    const totalLlmCallCount = 0;
    let totalTokensUsed = 0;

    // 最终状态：默认 completed，遇到失败/中止时降级
    let finalStatus: "completed" | "failed" | "human-checkpoint" = "completed";

    // 遍历节点（按拓扑序）
    for (const node of multiLoopPlan.loops) {
      // 检查依赖是否满足
      const depsNotSatisfied = node.dependencies.some((depId) => nodeStatusMap.get(depId) !== "completed");
      if (depsNotSatisfied) {
        // 依赖未满足：节点标记为 failed，终止后续节点
        const unmetDeps = node.dependencies.filter((depId) => nodeStatusMap.get(depId) !== "completed");
        const failureReason = `依赖未满足：${unmetDeps.join(", ")}`;
        this.warn(`节点 ${node.nodeId} [${node.loopType}] 跳过：${failureReason}`);

        nodeResults.push(
          Object.freeze({
            nodeId: node.nodeId,
            loopType: node.loopType,
            status: "failed",
            failureReason,
          }) as MultiLoopNodeResult
        );
        nodeStatusMap.set(node.nodeId, "failed");
        finalStatus = "failed";
        break;
      }

      // 依赖满足：构造临时 config 并执行单 Loop
      // 使用 node.entryArtifact 作为 run() 的 objective（节点入口文档作为本轮 Loop 目标）
      this.info(`节点 ${node.nodeId} [${node.loopType}] 开始执行，目标：${node.entryArtifact}`);

      // 记录 loop-started 事件（如果提供了 RunStateStore）
      if (runStateStore) {
        try {
          await runStateStore.appendEvent(multiLoopPlan.planId, {
            type: "loop-started",
            timestamp: new Date().toISOString(),
            payload: {
              loopType: node.loopType,
              nodeId: node.nodeId,
              objective: node.entryArtifact,
              dependencies: [...node.dependencies],
            },
          });
        } catch (exc) {
          // 持久化失败仅告警，不阻断流程
          this.warn(`记录 loop-started 事件失败：${exc instanceof Error ? exc.message : String(exc)}`);
        }
      }

      // 构造临时 LoopEngineeringConfig：复用当前 config 的所有字段，仅切换 loopType
      const nodeConfig: Readonly<LoopEngineeringConfig> = Object.freeze({
        ...this.config,
        loopType: node.loopType,
      });

      // 构造临时 LoopKernel 实例：复用相同的组件依赖
      // 注意：临时实例的内部状态（events / consecutiveFailures 等）独立于当前实例，
      // 避免多次 run() 之间的状态污染（对齐 run() 方法的设计约束）
      const nodeKernel = new LoopKernel(
        nodeConfig,
        this.discoveryProbe,
        this.handoffAdapter,
        this.evaluator,
        this.memory,
        this.scheduler,
        this.log
      );

      // 执行单 Loop（同步调用，对齐 run() 的同步签名）
      // 使用 node.entryArtifact 作为 objective（节点入口文档作为本轮 Loop 目标）
      const loopReport = nodeKernel.run(node.entryArtifact);

      // 累计统计
      totalIterations += loopReport.totalIterations;
      totalTokensUsed += loopReport.tokenUsed;
      // 注：LoopRunReport 不直接含 llmCallCount，使用 tokenUsed 近似（与 EagRunHandler 设计一致）

      // 根据单 Loop 最终状态设置节点状态
      let nodeStatus: "completed" | "failed" | "human-checkpoint";
      let failureReason: string | undefined;

      if (loopReport.finalStatus === "completed") {
        nodeStatus = "completed";
        this.info(`节点 ${node.nodeId} [${node.loopType}] 执行成功`);
      } else if (loopReport.finalStatus === "failed") {
        nodeStatus = "failed";
        failureReason = `Loop 失败停止：${loopReport.finalSummary}`;
        this.warn(`节点 ${node.nodeId} [${node.loopType}] 执行失败：${failureReason}`);
        finalStatus = "failed";
      } else {
        // aborted → human-checkpoint（multi-loop 节点状态映射）
        nodeStatus = "human-checkpoint";
        failureReason = `Loop 被人类中止：${loopReport.finalSummary}`;
        this.warn(`节点 ${node.nodeId} [${node.loopType}] 被中止：${failureReason}`);
        finalStatus = "human-checkpoint";
      }

      // 记录节点结果
      nodeResults.push(
        Object.freeze({
          nodeId: node.nodeId,
          loopType: node.loopType,
          status: nodeStatus,
          loopReport,
          failureReason,
        }) as MultiLoopNodeResult
      );
      nodeStatusMap.set(node.nodeId, nodeStatus);

      // 记录 loop-completed 事件（如果提供了 RunStateStore）
      if (runStateStore) {
        try {
          await runStateStore.appendEvent(multiLoopPlan.planId, {
            type: "loop-completed",
            timestamp: new Date().toISOString(),
            payload: {
              loopType: node.loopType,
              nodeId: node.nodeId,
              finalStatus: nodeStatus,
              totalIterations: loopReport.totalIterations,
              tokenUsed: loopReport.tokenUsed,
              durationSec: loopReport.durationSec,
              failureReason: failureReason ?? null,
            },
          });
        } catch (exc) {
          this.warn(`记录 loop-completed 事件失败：${exc instanceof Error ? exc.message : String(exc)}`);
        }
      }

      // 失败或中止时终止后续节点
      if (nodeStatus !== "completed") {
        this.info(`多 Loop 调度因节点 ${node.nodeId} 状态=${nodeStatus} 而提前终止`);
        break;
      }

      // 自动流转判定：若 autoTransition=false，则在第一个节点完成后返回 human-checkpoint
      // 等待用户确认后再次调用 scheduleMultiLoop（剩余节点）
      // 注：首版实现简化为 autoTransition=true 模式（自动串联执行全部节点）；
      // 若 autoTransition=false，调用方应在每节点完成后自行决定是否继续
      if (!multiLoopPlan.autoTransition) {
        // 非自动流转：剩余节点标记为 pending，返回 human-checkpoint
        finalStatus = "human-checkpoint";
        this.info(`autoTransition=false，节点 ${node.nodeId} 完成后暂停等待用户检查点`);
        break;
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;
    this.info(
      `多 Loop 串联调度结束：planId=${multiLoopPlan.planId} finalStatus=${finalStatus} ` +
        `节点数=${nodeResults.length} 总迭代=${totalIterations} 总 token=${totalTokensUsed} 耗时=${durationSec.toFixed(2)}s`
    );

    // 返回冻结的多 Loop 报告
    return Object.freeze({
      planId: multiLoopPlan.planId,
      nodeResults: Object.freeze(nodeResults) as ReadonlyArray<MultiLoopNodeResult>,
      finalStatus,
      totalIterations,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
    }) as MultiLoopRunReport;
  }

  /**
   * 执行单轮五步闭环
   *
   * 步骤：
   * 1. Discovery：discoveryProbe.discover
   * 2. Handoff：handoffAdapter.createWorkItems + execute
   * 3. Verification：evaluator.evaluate
   * 4. Persistence：memory.persistEvent + committedCount 累计
   * 5. Scheduling：scheduler.decideNext + computeBackoff
   *
   * @param objective 运行目标
   * @param iterIndex 当前迭代索引
   * @returns 本轮执行结果
   */
  runOneCycle(objective: string, iterIndex: number): LoopCycleResult {
    const cycleStart = Date.now();
    this.info(`开始第 ${iterIndex + 1} 轮循环`);

    // Step 1: Discovery
    this.emit("discovery_started", "discovery", iterIndex, { objective });
    const discovery = this.discoveryProbe.discover(objective, [...this.events], this.memory);
    this.emit("discovery_completed", "discovery", iterIndex, {
      objective: discovery.objective,
      risks: [...discovery.detectedRisks],
      agents: [...discovery.suggestedAgents],
      patterns: [...discovery.suggestedPatterns],
    });

    // Step 2: Handoff - 生成工作项
    const handoffItems = this.handoffAdapter.createWorkItems(discovery, this.config.loopType);
    this.emit("handoff_created", "handoff", iterIndex, { itemCount: handoffItems.length });

    // Step 3: Handoff - 执行 Generator
    const generatorResult = this.handoffAdapter.execute(handoffItems, this.config);
    this.emit("handoff_dispatched", "handoff", iterIndex, {
      generatorKeys: Object.keys(generatorResult),
      success: this.readBooleanField(generatorResult, "success", false),
    });

    // Step 4: Verification - 独立 Evaluator
    this.emit("verification_started", "verification", iterIndex, { evaluatorMode: this.config.evaluatorMode });
    const verdict = this.evaluator.evaluate(handoffItems, generatorResult, {
      objective,
      loopType: this.config.loopType,
    });
    this.emit(verdict.passed ? "verification_passed" : "verification_rejected", "verification", iterIndex, {
      passed: verdict.passed,
      reason: verdict.reason,
      severity: verdict.severity,
      findings: [...verdict.findings],
    });

    // Step 5: Persistence
    if (verdict.passed) {
      // 通过时累加 generator 声明的提交次数
      const committedInThisCycle = this.readNumberField(generatorResult, "committed_count", 0);
      this.committedCount += committedInThisCycle;
    }
    this.emit("persistence_written", "persistence", iterIndex, {
      passed: verdict.passed,
      committedCount: this.committedCount,
    });

    // Step 6: Scheduling
    const cumulativeTokens = this.memory.estimateTokenUsage();
    let decision = this.scheduler.decideNext(
      iterIndex,
      verdict,
      [...this.events],
      cumulativeTokens,
      this.consecutiveFailures
    );
    // FIX / CONTINUE 动作需计算退避时间
    if (decision.action === "fix" || decision.action === "continue") {
      const backoffSeconds = this.scheduler.computeBackoff(this.consecutiveFailures);
      decision = {
        ...decision,
        backoffSeconds,
      };
    }
    this.emit("scheduling_decision", "scheduling", iterIndex, {
      action: decision.action,
      reason: decision.reason,
      backoff: decision.backoffSeconds,
    });

    const cycleDurationSec = (Date.now() - cycleStart) / 1000;
    const tokenUsed = this.memory.estimateTokenUsage();
    const cycleEvents = this.events.filter((e) => e.iterIndex === iterIndex);

    return {
      iterIndex,
      discovery,
      handoffItems,
      generatorResult,
      verdict,
      events: cycleEvents,
      tokenUsed,
      durationSec: cycleDurationSec,
      schedulingDecision: decision,
    };
  }

  /**
   * 触发人类检查点
   *
   * 默认实现自动批准（非交互式环境）。
   * 未来可扩展为通过 CLI / UI 等待人类输入。
   *
   * @param reason 触发原因
   * @param iterIndex 当前迭代轮次索引（用于 human_checkpoint 事件的 iterIndex 字段，
   *                  默认 0，保持向后兼容；run() 内部调用时应传入当前轮次）
   * @returns 人类响应（默认 approved=true）
   */
  requestHumanCheckpoint(reason: string, iterIndex: number = 0): HumanCheckpointResponse {
    this.info(`人类检查点：${reason}`);
    this.emit("human_checkpoint", "scheduling", iterIndex, { reason });
    // 默认实现：自动批准，不中止
    return {
      approved: true,
      feedback: "自动批准",
      abort: false,
    };
  }

  /**
   * 安全停止循环
   *
   * 设置停止标志，当前轮次完成后退出。
   *
   * @param reason 停止原因
   */
  stop(reason: string): void {
    this.stopRequested = true;
    this.info(`收到停止请求：${reason}`);
  }

  // ============================ 私有方法 ============================

  /**
   * 输出 INFO 级别日志
   */
  private info(message: string): void {
    if (this.log) {
      this.log(message, "INFO");
    }
  }

  /**
   * 输出 WARN 级别日志
   */
  private warn(message: string): void {
    if (this.log) {
      this.log(message, "WARN");
    }
  }

  /**
   * 生成运行唯一标识（12 位 UUID 前缀，对应 Python `uuid.uuid4().hex[:12]`）
   *
   * @returns 12 位十六进制字符串
   */
  private generateRunId(): string {
    // 使用 crypto.randomUUID 生成 UUID v4，去除连字符后取前 12 位
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return uuid.substring(0, 12);
  }

  /**
   * 生成事件唯一标识（对应 Python `evt-{uuid.uuid4().hex[:8]}`）
   *
   * @returns 事件 ID（格式：evt-XXXXXXXX）
   */
  private generateEventId(): string {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return `evt-${uuid.substring(0, 8)}`;
  }

  /**
   * 创建事件、追加到内存并写入 Memory
   *
   * @param eventType 事件类型
   * @param phase 所属阶段
   * @param iterIndex 迭代轮次索引
   * @param payload 事件负载（可选，默认空对象）
   * @returns 创建的事件
   */
  private emit(
    eventType: LoopEventType,
    phase: string,
    iterIndex: number,
    payload: Readonly<Record<string, unknown>> = {}
  ): LoopEvent {
    const event: LoopEvent = {
      eventId: this.generateEventId(),
      eventType,
      phase,
      runId: this.runId,
      iterIndex,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    try {
      this.memory.persistEvent(event);
    } catch (exc) {
      // 持久化失败仅告警，不阻断 Loop（对应 Python try/except 行为）
      this.warn(`持久化事件失败：${exc instanceof Error ? exc.message : String(exc)}`);
    }
    return event;
  }

  /**
   * 从 GeneratorResult 读取布尔字段（带类型守卫）
   *
   * @param result Generator 结果
   * @param key 字段名
   * @param defaultValue 默认值（字段不存在或类型不符时使用）
   * @returns 读取到的布尔值
   */
  private readBooleanField(result: Readonly<Record<string, unknown>>, key: string, defaultValue: boolean): boolean {
    const raw = result[key];
    if (typeof raw === "boolean") {
      return raw;
    }
    return defaultValue;
  }

  /**
   * 从 GeneratorResult 读取数值字段（带类型守卫）
   *
   * @param result Generator 结果
   * @param key 字段名
   * @param defaultValue 默认值
   * @returns 读取到的数值
   */
  private readNumberField(result: Readonly<Record<string, unknown>>, key: string, defaultValue: number): number {
    const raw = result[key];
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      return raw;
    }
    return defaultValue;
  }

  /**
   * 构建最终摘要文本（对应 Python _build_final_summary）
   *
   * @param objective 运行目标
   * @param lastIterIndex 最后一轮的 iterIndex（从 0 开始，故总迭代次数 = lastIterIndex + 1）
   * @param finalStatus 最终状态
   * @param durationSec 总耗时秒数
   * @param tokenUsed 总 token 消耗
   * @returns 摘要文本
   */
  private buildFinalSummary(
    objective: string,
    lastIterIndex: number,
    finalStatus: string,
    durationSec: number,
    tokenUsed: number
  ): string {
    return (
      `Loop Engineering 运行报告\n` +
      `- runId: ${this.runId}\n` +
      `- loopType: ${this.config.loopType}\n` +
      `- objective: ${objective}\n` +
      `- totalIterations: ${lastIterIndex + 1}\n` +
      `- finalStatus: ${finalStatus}\n` +
      `- durationSec: ${durationSec.toFixed(2)}\n` +
      `- tokenUsed: ${tokenUsed}\n` +
      `- committedCount: ${this.committedCount}\n` +
      `- humanCheckpoints: ${this.humanCheckpoints.length}\n`
    );
  }
}

// ============================ SchedulingAction 导出（便于测试引用） ============================

// 重新导出 SchedulingAction 类型，便于调用方在不需要直接 import models 时使用
export type { SchedulingAction };
