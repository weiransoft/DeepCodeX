/**
 * 图级编排器实现（v2.0 实现，对齐设计文档 §9）
 *
 * GraphLoopOrchestrator 是 Layer 2 的核心编排器，负责协调图遍历的完整生命周期：
 * 1. 接收 WorkGraph 定义，通过 GraphGuard 校验结构
 * 2. 从入口节点开始遍历，通过 NodeExecutor 执行每个节点
 * 3. 通过 EdgeResolver 解析边契约，传递节点间数据
 * 4. 通过 GraphScheduler 做图级路由决策（前进/重试/隔离/停止）
 * 5. 通过 GraphGuard 做执行前后护栏检查
 * 6. 处理 fork 并行（Promise.all + structuredClone 状态隔离）和 merge 汇聚
 * 7. 管理图级共享状态（globalState）
 * 8. 生成图运行报告（GraphRunReport）
 *
 * 错误传播策略（对齐 §9.5）：
 * - 本实现采用 Phase 2 partial failure 策略：
 *   - 节点失败时，若 enableAutoIsolation=true，隔离该节点后继续执行其他分支
 *   - fork 并行分支失败时，隔离失败分支，其他分支继续
 *   - merge 节点感知上游隔离状态，跳过缺失输入字段（需 inputContract.required=false）
 * - 图级超时 / token 耗尽 / 用户取消 → 整图终止
 *
 * 并行实现（对齐 §9.4）：
 * - 使用 Promise.all 实现并行（不用 Worker Threads）
 * - 每个并行分支拥有独立的 globalState 快照（structuredClone 深拷贝）
 * - merge 阶段将各分支输出合并回主 globalState
 *
 * @module eag/graph/graph-loop-orchestrator
 */

import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图节点定义 */
  GraphNodeDef,
  /** 图边定义 */
  GraphEdgeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图运行报告 */
  GraphRunReport,
  /** 图运行状态快照 */
  GraphRunStatus,
  /** 图级调度决策 */
  GraphSchedulingDecision,
  /** 图级护栏检查结果 */
  GraphGuardCheckResult,
  /** 图级护栏记录 */
  GraphGuardRecord,
  /** 谓词注册表接口 */
  PredicateRegistry,
  /** 图日志记录器接口 */
  GraphLogger,
} from "./graph-loop-models";
import type {
  /** 编排器构造选项 */
  GraphLoopOrchestratorOptions,
  /** 图调试器协议（TOP-5） */
  GraphDebuggerProtocol,
} from "./graph-loop-protocols";
import type { GraphSchedulerImpl } from "./graph-scheduler";
// TOP-4 上下文拼接工具函数统一化：从统一工具模块导入 deepFreeze / mergeBranchGlobalState / redactSensitiveFields
import { deepFreeze, deepClone, mergeBranchGlobalState, redactSensitiveFields } from "./graph-context-utils";
// TOP-5 图调试工具：导入默认空实现
import { NoOpDebugger } from "./graph-debug";

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认最大遍历步数（防止无限循环的安全阀）
 *
 * 即使 maxDepth 配置较高，此硬上限也能防止图遍历失控。
 */
const MAX_TRAVERSAL_STEPS = 10000;

/**
 * 退避等待基数（毫秒），retry_node 决策的最小等待间隔
 */
const BACKOFF_WAIT_MS = 100;

// ============================================================================
// GraphLoopOrchestrator 编排器实现类
// ============================================================================

/**
 * 图级编排器实现类
 *
 * 协调 NodeExecutor / EdgeResolver / GraphScheduler / GraphGuard 四大组件，
 * 驱动 WorkGraph 的完整遍历生命周期。
 *
 * 使用示例：
 * ```typescript
 * const orchestrator = new GraphLoopOrchestrator({
 *   nodeExecutor: new NodeExecutorImpl(...),
 *   edgeResolver: new EdgeResolverImpl(),
 *   graphScheduler: new GraphSchedulerImpl(config),
 *   graphGuard: new GraphGuardImpl(config),
 *   predicateRegistry: createPredicateRegistry(),
 * });
 * const report = await orchestrator.run(workGraph);
 * ```
 */
export class GraphLoopOrchestrator {
  /** 节点执行器（执行单个图节点） */
  private readonly nodeExecutor: GraphLoopOrchestratorOptions["nodeExecutor"];
  /** 边解析器（解析边契约，构造目标节点输入） */
  private readonly edgeResolver: GraphLoopOrchestratorOptions["edgeResolver"];
  /** 图级调度器（决策下一节点 / 重试 / 隔离 / 停止） */
  private readonly graphScheduler: GraphLoopOrchestratorOptions["graphScheduler"];
  /** 图级护栏（结构校验 + 节点执行前后置检查） */
  private readonly graphGuard: GraphLoopOrchestratorOptions["graphGuard"];
  /** 谓词注册表（decision 节点和边条件求值） */
  private readonly predicateRegistry: PredicateRegistry;
  /** 经验存储（可选，Layer 3 集成时启用） */
  private readonly experienceStore?: GraphLoopOrchestratorOptions["experienceStore"];
  /**
   * 节点经验上送器（可选，§13.6.2 新增）
   *
   * 未注入时跳过经验上送，降级为无图级上下文积累。
   */
  private readonly experienceUploader?: GraphLoopOrchestratorOptions["experienceUploader"];
  /**
   * 双层上下文管理器（可选，§13.9.1 新增）
   *
   * V2-Graph 集成时启用 Layer 2 滑动窗口。
   * 未注入时降级为无优化上下文（不调用 buildOptimizedContext）。
   */
  private readonly dualLayerManager?: GraphLoopOrchestratorOptions["dualLayerManager"];
  /**
   * 当前用户 ID（可选，§13.9.1 新增）
   *
   * dualLayerManager 启用时必填，用于 buildOptimizedContext 的用户级上下文隔离。
   */
  private readonly userId?: string;
  /**
   * 项目根目录（可选，§13.9.1 v3 共识新增）
   *
   * 用于 initializeGraphGlobalContext 注入到 GraphGlobalContext.projectRoot。
   * 未注入时 projectRoot 字段为 undefined，不影响图执行。
   */
  private readonly projectRoot?: string;
  /**
   * 图调试器（可选，TOP-5）
   *
   * 未注入时默认使用 NoOpDebugger，保证零开销和向后兼容。
   * 所有 trace 调用均通过 safeTrace 包装，调试器异常不中断主流程。
   */
  private readonly debugger: GraphDebuggerProtocol;
  /** 日志记录器 */
  private readonly logger: GraphLogger;

  /** 当前运行上下文（run() 执行期间非空，用于 stop() 和 status()） */
  private currentContext: GraphRunContext | null;
  /** 当前运行 ID（run() 执行期间非空） */
  private currentRunId: string | null;
  /** 当前遍历路径（节点 ID 序列，按访问顺序记录） */
  private currentTraversalPath: string[];
  /** 触发的护栏记录（按触发时间顺序） */
  private currentTriggeredGuards: GraphGuardRecord[];
  /** 停止原因（stop() 调用时设置，用于在报告中标明中止原因） */
  private stopReason: string | null;
  /** 当前执行的工作图定义（run() 执行期间非空，用于 isolate_node 等场景查询边） */
  private currentGraph: Readonly<WorkGraph> | null;
  /** 图是否因调度器 stop_failure / stop_timeout 提前终止（用于 determineFinalStatus 区分成功完成与失败停止） */
  private prematureStop: "failed" | "timeout" | null;

  /**
   * 构造图级编排器
   *
   * @param options 编排器构造选项（包含所有协作组件）
   */
  constructor(options: Readonly<GraphLoopOrchestratorOptions>) {
    this.nodeExecutor = options.nodeExecutor;
    this.edgeResolver = options.edgeResolver;
    this.graphScheduler = options.graphScheduler;
    this.graphGuard = options.graphGuard;
    this.predicateRegistry = options.predicateRegistry;
    this.experienceStore = options.experienceStore;
    this.experienceUploader = options.experienceUploader;
    this.dualLayerManager = options.dualLayerManager;
    this.userId = options.userId;
    this.projectRoot = options.projectRoot;
    // TOP-5：未注入 debugger 时默认使用 NoOpDebugger，确保向后兼容和零开销
    this.debugger = options.debugger ?? new NoOpDebugger();
    this.logger = options.logger ?? createConsoleLogger();

    this.currentContext = null;
    this.currentRunId = null;
    this.currentTraversalPath = [];
    this.currentTriggeredGuards = [];
    this.stopReason = null;
    this.currentGraph = null;
    this.prematureStop = null;
  }

  /**
   * 启动图编排（主入口）
   *
   * 完整流程（对齐 §9.2）：
   * 1. GraphGuard.validateGraph(graph) → 校验图结构
   * 2. 初始化 GraphRunContext（globalState、visited、nodeResults、predicateRegistry）
   * 3. 注入图定义到 GraphScheduler（setGraph）
   * 4. 从入口节点开始遍历，循环执行：
   *    a. GraphGuard.checkPreExecution(node, ctx)
   *    b. EdgeResolver.resolve(incomingEdges, upstreamOutputs, node, globalState) → input
   *    c. NodeExecutor.execute(node, input, ctx) → result
   *    d. GraphGuard.checkPostExecution(node, result, ctx)
   *    e. nodeResults.set(node.id, result)
   *    f. GraphScheduler.decideNext(node, result, ctx) → decision
   *    g. 根据 decision.action 处理（next_node / retry_node / isolate_node / stop_*）
   * 5. 生成 GraphRunReport
   *
   * @param graph 工作图定义
   * @returns 图运行报告（冻结对象）
   */
  async run(graph: Readonly<WorkGraph>): Promise<Readonly<GraphRunReport>> {
    const startedAtMs = Date.now();
    this.currentRunId = generateRunId();
    this.currentTraversalPath = [];
    this.currentTriggeredGuards = [];
    this.stopReason = null;
    this.prematureStop = null;
    this.currentGraph = graph;

    // TOP-5：重置调试器，确保本次运行事件不与上一次运行串扰
    this.debugger.reset(this.currentRunId);

    // 1. 初始化运行上下文（提前创建，便于 debugger 在校验阶段也能获取 runId/graphId）
    const context: GraphRunContext = {
      runId: this.currentRunId,
      graphId: graph.graphId,
      globalState: { ...graph.globalState },
      visited: new Set<string>(),
      nodeResults: new Map<string, GraphNodeResult>(),
      cancelled: false,
      config: graph.config,
      predicateRegistry: this.predicateRegistry,
      currentDepth: 0,
      totalTokensUsed: 0,
      startedAtMs,
    };
    this.currentContext = context;

    // 2. 图结构校验（一次性）
    const validationResult = this.graphGuard.validateGraph(graph);

    // TOP-5：记录图级校验 guard 事件（validate 阶段无当前节点）
    this.safeTrace(() =>
      this.debugger.traceGuard(
        undefined,
        {
          passed: validationResult.valid,
          reason: validationResult.valid
            ? `图结构校验通过，警告 ${validationResult.warnings.length} 条`
            : `图结构校验失败：${validationResult.errors.join("; ")}`,
          suggestedAction: validationResult.valid ? undefined : "stop_failure",
          severity: validationResult.valid ? "info" : "error",
        },
        "validate",
        context
      )
    );

    if (!validationResult.valid) {
      this.logger.error(`[GraphLoopOrchestrator] 图结构校验失败：${validationResult.errors.join("; ")}`);
      // 校验失败直接返回 failed 报告
      return this.buildReport(
        graph,
        this.currentRunId,
        "failed",
        new Map(),
        0,
        0,
        0,
        (Date.now() - startedAtMs) / 1000,
        `图结构校验失败：${validationResult.errors.join("; ")}`
      );
    }

    // 记录校验阶段的护栏事件（warnings）
    for (const warning of validationResult.warnings) {
      this.currentTriggeredGuards.push({
        recordId: generateId(),
        guardName: "validateGraph",
        triggerPhase: "validate",
        result: {
          passed: true,
          reason: warning,
          suggestedAction: undefined,
          severity: "warning",
        },
        triggeredAt: new Date().toISOString(),
      });
    }

    // 2.1（§13.9.1 新增）：初始化 GraphGlobalContext 字段到 globalState
    // 不修改 globalState 类型，仅注入 GraphGlobalContext 的字段值
    // v3 共识修复：传入 projectRoot 参数（未注入时为 undefined，不影响图执行）
    this.initializeGraphGlobalContext(graph, context, this.projectRoot);

    // 3. 注入图定义到调度器（若调度器是 GraphSchedulerImpl 实例）
    if (this.graphScheduler && typeof (this.graphScheduler as GraphSchedulerImpl).setGraph === "function") {
      (this.graphScheduler as GraphSchedulerImpl).setGraph(graph);
    }

    // 4. 从入口节点开始遍历
    let currentNodeId: string | null = graph.entryNodeId;
    let stepCount = 0;
    let totalIterations = 0;
    let totalLlmCallCount = 0;
    // 节点重试计数器（按节点 ID 索引，记录图级重试次数）
    const nodeRetryCounts = new Map<string, number>();

    while (currentNodeId !== null && stepCount < MAX_TRAVERSAL_STEPS) {
      stepCount++;

      // 检查用户取消
      if (context.cancelled) {
        this.logger.warn(`[GraphLoopOrchestrator] 用户已取消图执行`);
        break;
      }

      // 获取当前节点定义
      const currentNode = graph.nodes.get(currentNodeId);
      if (!currentNode) {
        this.logger.error(`[GraphLoopOrchestrator] 节点 ${currentNodeId} 不存在`);
        break;
      }

      // 记录遍历路径
      this.currentTraversalPath.push(currentNodeId);
      context.visited.add(currentNodeId);

      // a. 执行前护栏检查
      const preCheck = this.graphGuard.checkPreExecution(currentNode, context);
      this.recordGuardRecord(preCheck, "pre", currentNodeId);
      // TOP-5：记录 pre 阶段 guard 事件
      this.safeTrace(() => this.debugger.traceGuard(currentNode, preCheck, "pre", context));
      if (!preCheck.passed) {
        this.logger.warn(`[GraphLoopOrchestrator] 节点 ${currentNodeId} 执行前护栏拦截：${preCheck.reason}`);
        // 护栏拦截，构造 failed 结果并让调度器决策
        const failedResult: GraphNodeResult = {
          nodeId: currentNodeId,
          nodeType: currentNode.nodeType,
          status: "failed",
          output: {},
          durationSec: 0,
          failureReason: preCheck.reason,
          retryCount: nodeRetryCounts.get(currentNodeId) ?? 0,
        };
        context.nodeResults.set(currentNodeId, failedResult);
        // TOP-5：pre-guard 拦截导致的失败也需记录
        this.safeTrace(() => this.debugger.traceFailure(currentNode, failedResult, context));

        const decision = await this.graphScheduler.decideNext(currentNode, failedResult, context);
        currentNodeId = this.processDecision(decision, currentNode, context, nodeRetryCounts);
        continue;
      }

      // b. 通过 EdgeResolver 解析边契约，构造节点输入
      const incomingEdges = graph.edges.filter((e) => e.to === currentNodeId);
      const upstreamOutputs = this.collectUpstreamOutputs(incomingEdges, context);
      let input: Record<string, unknown>;
      try {
        input = this.edgeResolver.resolve(incomingEdges, upstreamOutputs, currentNode, context.globalState) as Record<
          string,
          unknown
        >;
      } catch (err) {
        // 边解析失败：构造 failed 结果
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[GraphLoopOrchestrator] 节点 ${currentNodeId} 边解析失败：${errorMsg}`);
        const failedResult: GraphNodeResult = {
          nodeId: currentNodeId,
          nodeType: currentNode.nodeType,
          status: "failed",
          output: {},
          durationSec: 0,
          failureReason: `边解析失败：${errorMsg}`,
          retryCount: nodeRetryCounts.get(currentNodeId) ?? 0,
        };
        context.nodeResults.set(currentNodeId, failedResult);
        // TOP-5：边解析失败属于节点失败
        this.safeTrace(() => this.debugger.traceFailure(currentNode, failedResult, context));

        const decision = await this.graphScheduler.decideNext(currentNode, failedResult, context);
        currentNodeId = this.processDecision(decision, currentNode, context, nodeRetryCounts);
        continue;
      }

      // TOP-5：记录 merge 节点汇聚事件（在输入构造完成后、执行前）
      if (currentNode.nodeType === "merge") {
        const upstreamResults = incomingEdges
          .map((edge) => context.nodeResults.get(edge.from))
          .filter((r): r is GraphNodeResult => r !== undefined);
        this.safeTrace(() => this.debugger.traceMerge(currentNode, upstreamResults, context));
      }

      // TOP-5：记录节点开始执行
      this.safeTrace(() => this.debugger.traceNodeStart(currentNode, input, context));

      // b.2（§13.9.1 新增，对齐多角色评审共识 B-6）：调用 DualLayerContextManager 构建优化上下文
      // 当 dualLayerManager 和 userId 同时存在时，注入图级片段到 Layer 2 滑动窗口
      // 失败时降级为无优化上下文（不中断主流程）
      if (this.dualLayerManager && this.userId) {
        const taskId = `${context.runId}-${currentNodeId}`;
        try {
          const snippets = await this.dualLayerManager.buildOptimizedContext(this.userId, taskId, {
            graphGlobalContext: context.globalState,
            currentNodeId,
          });
          // 将优化上下文片段挂载到 context 的扩展字段
          // 节点执行器可选择性地读取 __contextSnippets 字段注入到 LLM prompt
          (context as GraphRunContext & { __contextSnippets?: unknown[] }).__contextSnippets = snippets as unknown[];
        } catch (err) {
          // buildOptimizedContext 失败：降级为无优化上下文（不中断主流程）
          this.logger.warn(
            `[GraphLoopOrchestrator] 节点 ${currentNodeId} buildOptimizedContext 失败，降级为无优化上下文：${(err as Error).message}`
          );
        }
      }

      // c. 执行节点
      let result: GraphNodeResult;
      const nodeStartTime = Date.now();
      try {
        result = await this.nodeExecutor.execute(currentNode, input, context);
      } catch (err) {
        // 节点执行抛异常：构造 failed 结果
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[GraphLoopOrchestrator] 节点 ${currentNodeId} 执行异常：${errorMsg}`);
        result = {
          nodeId: currentNodeId,
          nodeType: currentNode.nodeType,
          status: "failed",
          output: {},
          durationSec: (Date.now() - nodeStartTime) / 1000,
          failureReason: `执行异常：${errorMsg}`,
          retryCount: nodeRetryCounts.get(currentNodeId) ?? 0,
        };
      }

      // 补充 retryCount 到结果（节点执行器可能不设置此字段）
      if (result.retryCount === undefined) {
        result = {
          ...result,
          retryCount: nodeRetryCounts.get(currentNodeId) ?? 0,
        };
      }

      // TOP-5：记录节点执行完成
      this.safeTrace(() => this.debugger.traceNodeComplete(currentNode, result, context));

      // d. 执行后护栏检查
      const postCheck = this.graphGuard.checkPostExecution(currentNode, result, context);
      this.recordGuardRecord(postCheck, "post", currentNodeId);
      // TOP-5：记录 post 阶段 guard 事件
      this.safeTrace(() => this.debugger.traceGuard(currentNode, postCheck, "post", context));
      if (!postCheck.passed) {
        this.logger.warn(`[GraphLoopOrchestrator] 节点 ${currentNodeId} 执行后护栏拦截：${postCheck.reason}`);
        // 护栏拦截：将结果状态改为 failed
        result = {
          ...result,
          status: "failed",
          failureReason: postCheck.reason,
        };
      }

      // e. 记录节点结果
      context.nodeResults.set(currentNodeId, result);

      // TOP-5：节点最终状态为 failed 时记录失败事件
      if (result.status === "failed") {
        this.safeTrace(() => this.debugger.traceFailure(currentNode, result, context));
      }

      // e.2（§13.9.2 新增，对齐多角色评审共识 B-3 / B-4）：经验上送与动向广播
      // 当 experienceUploader 注入且节点状态为 completed 或 failed 时，上送经验到全局上下文
      // 失败时不中断主流程（经验上送是副作用，不影响图遍历）
      // 注意：fork 的分支节点经验上送由 executeFork 内部处理，此处仅处理主循环节点
      if (this.experienceUploader && (result.status === "completed" || result.status === "failed")) {
        try {
          await this.experienceUploader.uploadExperiences(currentNodeId, result, context);
        } catch (err) {
          // 经验上送失败：不中断主流程，仅记录警告
          this.logger.warn(
            `[GraphLoopOrchestrator] 节点 ${currentNodeId} 经验上送失败，不中断主流程：${(err as Error).message}`
          );
        }
      }

      // 累加 Loop 迭代次数、LLM 调用次数和 token 消耗
      if (result.loopReport) {
        totalIterations += result.loopReport.totalIterations;
        // v4-L1 修复：累加节点 LLM 调用次数（Loop 内部调用次数由 NodeExecutor 设置到 result.llmCallCount）
        totalLlmCallCount += result.llmCallCount ?? 0;
        // LoopRunReport.tokenUsed 字段记录 Loop 内部 token 消耗
        // 但节点级 token 已由 NodeExecutor 累加到 context.totalTokensUsed，此处不重复累加
      } else if (result.llmCallCount !== undefined) {
        // v4-L1 修复：无 Loop 但 NodeExecutor 直接报告了 LLM 调用次数
        totalLlmCallCount += result.llmCallCount;
      }
      // token 消耗由节点执行器在执行时累加到 context.totalTokensUsed

      // f. 处理 fork 节点的并行执行
      if (currentNode.nodeType === "fork" && result.status === "completed") {
        const downstreamEdges = graph.edges.filter((e) => e.from === currentNode.nodeId);
        // TOP-5：记录 fork 并行派发开始
        this.safeTrace(() =>
          this.debugger.traceForkStart(
            currentNode,
            downstreamEdges.map((e) => e.to),
            context
          )
        );
        const forkResults = await this.executeFork(currentNode, graph, context);
        // TOP-5：记录 fork 并行派发完成
        this.safeTrace(() => this.debugger.traceForkComplete(currentNode, forkResults, context));
        // fork 的并行结果合并到 nodeResults
        for (const fr of forkResults) {
          context.nodeResults.set(fr.nodeId, fr);
          if (fr.loopReport) {
            totalIterations += fr.loopReport.totalIterations;
            // v4-L1 修复：累加 fork 分支节点的 LLM 调用次数
            totalLlmCallCount += fr.llmCallCount ?? 0;
          } else if (fr.llmCallCount !== undefined) {
            // v4-L1 修复：无 Loop 但分支节点报告了 LLM 调用次数
            totalLlmCallCount += fr.llmCallCount;
          }
        }
      }

      // g. 调度器决策下一节点
      const decision = await this.graphScheduler.decideNext(currentNode, result, context);

      // h. 处理决策
      currentNodeId = this.processDecision(decision, currentNode, context, nodeRetryCounts);

      // 退避等待（retry_node 决策时）
      if (decision.action === "retry_node" && decision.backoffSeconds > 0) {
        await sleep(decision.backoffSeconds * 1000 + BACKOFF_WAIT_MS);
      }
    }

    // 5. 生成运行报告
    const elapsedSec = (Date.now() - startedAtMs) / 1000;
    const finalStatus = this.determineFinalStatus(context, this.stopReason);
    const finalReport = this.buildFinalReport(graph, context, finalStatus, totalIterations, elapsedSec);

    const report = this.buildReport(
      graph,
      this.currentRunId,
      finalStatus,
      context.nodeResults,
      totalIterations,
      totalLlmCallCount,
      context.totalTokensUsed,
      elapsedSec,
      finalReport
    );

    // 清理运行时状态
    this.currentContext = null;
    this.currentRunId = null;
    this.currentGraph = null;

    return report;
  }

  // ========================================================================
  // TOP-5：调试器安全调用辅助方法
  // ========================================================================

  /**
   * 安全调用调试器 trace 方法
   *
   * 所有 debugger 调用都必须经过此包装，确保调试器自身异常不会中断图执行主流程。
   * 若 options.debugger 未注入，默认使用 NoOpDebugger，此函数直接返回。
   *
   * @param traceFn 调试器调用闭包
   */
  private safeTrace(traceFn: () => void): void {
    try {
      traceFn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[GraphLoopOrchestrator] 调试器调用异常，已忽略：${message}`);
    }
  }

  /**
   * 安全停止图遍历
   *
   * 设置 context.cancelled = true，主循环在下次检查时退出。
   *
   * @param reason 停止原因
   */
  stop(reason: string): void {
    this.stopReason = reason;
    if (this.currentContext) {
      this.currentContext.cancelled = true;
    }
    this.logger.warn(`[GraphLoopOrchestrator] 收到停止请求：${reason}`);
  }

  /**
   * 查询图运行状态
   *
   * @param runId 运行 ID
   * @returns 状态快照
   */
  async status(runId: string): Promise<Readonly<GraphRunStatus>> {
    if (!this.currentContext || this.currentRunId !== runId) {
      // 无匹配运行 ID：返回默认 completed 状态
      return {
        runId,
        status: "completed",
        currentNodeId: null,
        completedNodeCount: 0,
        totalNodeCount: 0,
        progressPercent: 100,
        totalTokensUsed: 0,
        elapsedSec: 0,
        lastUpdatedAt: new Date().toISOString(),
      };
    }

    const ctx = this.currentContext;
    const totalNodeCount = ctx.nodeResults.size;
    const completedCount = Array.from(ctx.nodeResults.values()).filter(
      (r) => r.status === "completed" || r.status === "failed" || r.status === "skipped" || r.status === "isolated"
    ).length;
    const currentNodeId =
      this.currentTraversalPath.length > 0 ? this.currentTraversalPath[this.currentTraversalPath.length - 1] : null;
    const elapsedSec = (Date.now() - ctx.startedAtMs) / 1000;

    return {
      runId,
      status: ctx.cancelled ? "aborted" : "running",
      currentNodeId,
      completedNodeCount: completedCount,
      totalNodeCount,
      progressPercent: totalNodeCount > 0 ? Math.round((completedCount / totalNodeCount) * 100) : 0,
      totalTokensUsed: ctx.totalTokensUsed,
      elapsedSec,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 处理调度器决策，返回下一个要执行的节点 ID
   *
   * 决策动作处理：
   * - next_node：前进到 decision.nextNodeIds[0]（并行场景已由 executeFork 处理）
   * - retry_node：重试当前节点（递增 retryCount，返回当前节点 ID）
   * - isolate_node：标记当前节点为 isolated，前进到下游
   * - stop_success / stop_failure / stop_timeout：终止遍历（返回 null）
   *
   * @param decision 调度器决策
   * @param currentNode 当前节点
   * @param context 运行上下文
   * @param nodeRetryCounts 节点重试计数器（可变，retry_node 时递增）
   * @returns 下一个要执行的节点 ID（null 表示终止）
   */
  private processDecision(
    decision: GraphSchedulingDecision,
    currentNode: Readonly<GraphNodeDef>,
    context: GraphRunContext,
    nodeRetryCounts: Map<string, number>
  ): string | null {
    switch (decision.action) {
      case "next_node": {
        // 前进到下游节点
        if (decision.nextNodeIds.length === 0) {
          this.logger.warn(`[GraphLoopOrchestrator] next_node 决策但 nextNodeIds 为空，终止遍历`);
          return null;
        }
        // 递增遍历深度（每次前进到新节点时）
        context.currentDepth++;
        return decision.nextNodeIds[0];
      }

      case "retry_node": {
        // 重试当前节点：递增 retryCount，返回当前节点 ID
        const currentRetryCount = nodeRetryCounts.get(currentNode.nodeId) ?? 0;
        nodeRetryCounts.set(currentNode.nodeId, currentRetryCount + 1);
        this.logger.info(`[GraphLoopOrchestrator] 重试节点 ${currentNode.nodeId}（第 ${currentRetryCount + 1} 次）`);
        return currentNode.nodeId;
      }

      case "isolate_node": {
        // 隔离当前节点：标记为 isolated，前进到下游
        const isolatedResult = context.nodeResults.get(currentNode.nodeId);
        if (isolatedResult) {
          const updatedResult: GraphNodeResult = {
            ...isolatedResult,
            status: "isolated",
          };
          context.nodeResults.set(currentNode.nodeId, updatedResult);
        }
        // 隔离后前进到下游节点（通过边查询）
        const graph = this.currentGraph;
        if (graph) {
          const downstreamEdges = graph.edges.filter((e) => e.from === currentNode.nodeId);
          if (downstreamEdges.length > 0) {
            context.currentDepth++;
            return downstreamEdges[0].to;
          }
        }
        return null;
      }

      case "stop_success":
        this.logger.info(`[GraphLoopOrchestrator] 图执行成功完成：${decision.reason}`);
        return null;

      case "stop_failure":
        this.logger.warn(`[GraphLoopOrchestrator] 图执行失败终止：${decision.reason}`);
        this.prematureStop = "failed";
        return null;

      case "stop_timeout":
        this.logger.warn(`[GraphLoopOrchestrator] 图执行超时终止：${decision.reason}`);
        this.prematureStop = "timeout";
        return null;

      case "human_checkpoint":
        // 人工检查点：暂不实现交互，记录后视为停止
        this.logger.info(`[GraphLoopOrchestrator] 到达人工检查点：${decision.reason}`);
        return null;

      default:
        this.logger.error(`[GraphLoopOrchestrator] 未知决策动作：${decision.action}`);
        return null;
    }
  }

  /**
   * 执行 fork 节点的并行分支
   *
   * 使用 Promise.all 实现并行，每个分支拥有独立的 globalState 快照（状态隔离）。
   * 分支执行完成后，将各分支输出合并回主 globalState。
   *
   * @param forkNode fork 节点定义
   * @param graph 工作图定义
   * @param context 运行上下文
   * @returns 各分支的执行结果列表
   */
  private async executeFork(
    forkNode: Readonly<GraphNodeDef>,
    graph: Readonly<WorkGraph>,
    context: GraphRunContext
  ): Promise<ReadonlyArray<GraphNodeResult>> {
    // 查询 fork 节点的所有下游边
    const downstreamEdges = graph.edges.filter((e) => e.from === forkNode.nodeId);
    if (downstreamEdges.length === 0) {
      this.logger.warn(`[GraphLoopOrchestrator] fork 节点 ${forkNode.nodeId} 无下游边`);
      return [];
    }

    // 受 maxParallelism 限制的分批并行
    const maxParallelism = context.config.maxParallelism;
    const batches = chunkArray(downstreamEdges, maxParallelism);
    const allResults: GraphNodeResult[] = [];

    for (const batch of batches) {
      // 检查取消信号
      if (context.cancelled) {
        this.logger.warn(`[GraphLoopOrchestrator] fork 执行被取消`);
        break;
      }

      // 记录本批次开始前的 token 基数（用于计算各分支的 token 增量）
      const baseTokens = context.totalTokensUsed;

      // 每个分支创建独立的 BranchContext（状态隔离）
      // 返回 { result, tokenDelta, branchGlobalState } 以便在 Promise.all 后统一合并
      const branchPromises = batch.map(async (edge) => {
        const targetNode = graph.nodes.get(edge.to);
        if (!targetNode) {
          this.logger.error(`[GraphLoopOrchestrator] fork 目标节点 ${edge.to} 不存在`);
          return {
            result: {
              nodeId: edge.to,
              nodeType: "task" as const,
              status: "failed" as const,
              output: {},
              durationSec: 0,
              failureReason: `目标节点 ${edge.to} 不存在`,
              retryCount: 0,
            } as GraphNodeResult,
            tokenDelta: 0,
            branchGlobalState: null as Record<string, unknown> | null,
          };
        }

        // 深拷贝 globalState 实现状态隔离
        const branchGlobalState = structuredClone(context.globalState);
        const branchVisited = new Set(context.visited);
        const branchNodeResults = new Map(context.nodeResults);

        // 解析边契约
        let branchInput: Record<string, unknown>;
        try {
          branchInput = this.edgeResolver.resolve(
            [edge],
            context.nodeResults.get(forkNode.nodeId)?.output ?? {},
            targetNode,
            branchGlobalState
          ) as Record<string, unknown>;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            result: {
              nodeId: targetNode.nodeId,
              nodeType: targetNode.nodeType,
              status: "failed" as const,
              output: {},
              durationSec: 0,
              failureReason: `边解析失败：${errorMsg}`,
              retryCount: 0,
            } as GraphNodeResult,
            tokenDelta: 0,
            branchGlobalState: null,
          };
        }

        // 执行节点（使用独立的分支上下文）
        // branchContext 拥有独立的 globalState / visited / nodeResults（状态隔离）
        const branchContext: GraphRunContext = {
          ...context,
          globalState: branchGlobalState,
          visited: branchVisited,
          nodeResults: branchNodeResults,
        };

        // TOP-5：记录分支节点开始执行
        this.safeTrace(() => this.debugger.traceNodeStart(targetNode, branchInput, branchContext));

        try {
          const result = await this.nodeExecutor.execute(targetNode, branchInput, branchContext);

          // v3 共识修复 B-2（架构师 B-4 + 独立开发者 B-2）：
          // 分支节点执行后立即调用 uploadExperiences 上送经验到 branchGlobalState
          // 确保并行分支的经验在合并前已写入各自的 branchContext，避免合并时丢失
          // 仅在节点状态为 completed 或 failed 时上送（跳过 skipped/isolated）
          if (this.experienceUploader && (result.status === "completed" || result.status === "failed")) {
            try {
              await this.experienceUploader.uploadExperiences(targetNode.nodeId, result, branchContext);
            } catch (err) {
              // 经验上送失败不中断分支执行，仅记录警告
              this.logger.warn(
                `[GraphLoopOrchestrator] 分支节点 ${targetNode.nodeId} 经验上送失败，不中断分支：${(err as Error).message}`
              );
            }
          }

          // TOP-5：记录分支节点执行完成
          this.safeTrace(() => this.debugger.traceNodeComplete(targetNode, result, branchContext));

          // 计算本分支的 token 增量（branchContext.totalTokensUsed 已由 executor 累加）
          const tokenDelta = branchContext.totalTokensUsed - baseTokens;
          return { result, tokenDelta, branchGlobalState };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const failedResult: GraphNodeResult = {
            nodeId: targetNode.nodeId,
            nodeType: targetNode.nodeType,
            status: "failed" as const,
            output: {},
            durationSec: 0,
            failureReason: `执行异常：${errorMsg}`,
            retryCount: 0,
          } as GraphNodeResult;
          // TOP-5：记录分支节点执行失败
          this.safeTrace(() => this.debugger.traceFailure(targetNode, failedResult, branchContext));
          return {
            result: failedResult,
            tokenDelta: 0,
            branchGlobalState: null,
          };
        }
      });

      // Promise.all 等待本批所有分支完成
      const batchOutputs = await Promise.all(branchPromises);

      // 统一合并各分支的结果、token 增量、globalState 到主 context
      // 在 Promise.all 后顺序合并，避免并行写入竞态
      for (const { result, tokenDelta, branchGlobalState } of batchOutputs) {
        allResults.push(result);
        // 累加 token 增量到主 context
        context.totalTokensUsed += tokenDelta;
        // v3 共识修复 B-1（架构师 B-4 + 独立开发者 B-1 + 测试专家 B3）：
        // 禁止使用 Object.assign 浅覆盖整个 globalState，必须对 Map/Array 字段做 entry 级合并，
        // 避免分支经验丢失（nodeSummaries / collectedExperiences / bulletinBoard 不可被浅覆盖）
        if (branchGlobalState) {
          mergeBranchGlobalState(context.globalState, branchGlobalState);
        }
        // 将并行分支节点记录到遍历路径和 visited 集合（对齐 §9.2 遍历路径记录要求）
        this.currentTraversalPath.push(result.nodeId);
        context.visited.add(result.nodeId);
      }
    }

    return allResults;
  }

  // ============================================================================
  // §13.9 图级全局上下文管理方法（v3 共识修复实现）
  // ============================================================================

  /**
   * 初始化 GraphGlobalContext 字段到 globalState（§13.9.1）
   *
   * 设计意图（对齐多角色评审共识 B-5 + v3 修复）：
   * - 不修改 globalState 类型（保持 Record<string, unknown> 不变）
   * - 仅注入 GraphGlobalContext 的字段值，通过 Object.assign 合并到 globalState
   * - 保留图定义中用户配置的其他字段（不被覆盖）
   * - 后续通过 getGraphGlobalContext(context) 工具函数访问
   *
   * 注入字段：
   * - projectRoot / projectGoal / globalConstraints：项目级信息（全程不变）
   * - sharedArtifacts：从 graph.globalState 继承初始共享数据
   * - nodeSummaries / collectedExperiences / bulletinBoard：初始化为空集合
   * - runId / graphId / createdAt / lastUpdatedAt：溯源字段
   *
   * @param graph 工作图定义
   * @param context 图运行上下文（globalState 字段将被注入 GraphGlobalContext 字段）
   * @param projectRoot 项目根目录（可选，未注入时 projectRoot 字段为 undefined）
   */
  private initializeGraphGlobalContext(
    graph: Readonly<WorkGraph>,
    context: GraphRunContext,
    projectRoot?: string
  ): void {
    const now = new Date().toISOString();
    // 构造 GraphGlobalContext 字段（保持 globalState: Record<string, unknown> 类型不变）
    // 注意：globalConstraints 使用 ReadonlyArray<string>，extractConstraints 返回 string[]，
    //       Object.assign 后类型退化为 string[]，但运行期不影响（仅类型层面 readonly 约束）
    const globalCtx: {
      projectRoot?: string;
      projectGoal?: string;
      globalConstraints?: string[];
      sharedArtifacts?: Record<string, unknown>;
      nodeSummaries?: Map<string, unknown>;
      collectedExperiences?: unknown[];
      bulletinBoard?: unknown[];
      runId?: string;
      graphId?: string;
      createdAt?: string;
      lastUpdatedAt?: string;
    } = {
      projectRoot,
      projectGoal: graph.description, // 从图定义获取项目目标
      globalConstraints: this.extractConstraints(graph), // 从图定义提取约束
      sharedArtifacts: { ...graph.globalState }, // 从图定义的 globalState 初始化共享产物
      nodeSummaries: new Map(),
      collectedExperiences: [],
      bulletinBoard: [],
      runId: context.runId,
      graphId: context.graphId,
      createdAt: now,
      lastUpdatedAt: now,
    };
    // 合并到 globalState（保留图定义中用户配置的其他字段）
    Object.assign(context.globalState, globalCtx);
  }

  /**
   * 从图定义提取全局约束（§13.9.1）
   *
   * 将图级配置（maxTokens / timeoutSec / maxParallelism）转换为人类可读的约束字符串，
   * 注入到 GraphGlobalContext.globalConstraints，供节点 agent 在执行时感知全局限制。
   *
   * @param graph 工作图定义
   * @returns 约束字符串数组（如 ["token 预算 ≤ 500000", "超时 ≤ 3600s", "最大并行度 ≤ 4"]）
   */
  private extractConstraints(graph: Readonly<WorkGraph>): string[] {
    const constraints: string[] = [];
    // 从图级配置提取约束（仅提取非零/非默认值，避免无意义约束）
    if (graph.config.maxTokens > 0) {
      constraints.push(`token 预算 ≤ ${graph.config.maxTokens}`);
    }
    if (graph.config.timeoutSec > 0) {
      constraints.push(`超时 ≤ ${graph.config.timeoutSec}s`);
    }
    if (graph.config.maxParallelism > 0) {
      constraints.push(`最大并行度 ≤ ${graph.config.maxParallelism}`);
    }
    return constraints;
  }

  /**
   * 收集上游节点的输出数据（用于 EdgeResolver 解析）
   *
   * 对于 merge 节点（多条入边），将所有上游输出合并为一个对象。
   * 对于普通节点（单条入边），直接返回上游输出。
   *
   * @param incomingEdges 入边列表
   * @param context 运行上下文
   * @returns 合并后的上游输出数据
   */
  private collectUpstreamOutputs(
    incomingEdges: ReadonlyArray<GraphEdgeDef>,
    context: GraphRunContext
  ): Record<string, unknown> {
    if (incomingEdges.length === 0) {
      // 入口节点无上游，返回空对象
      return {};
    }

    if (incomingEdges.length === 1) {
      // 单上游：直接返回上游输出
      const upstreamId = incomingEdges[0].from;
      const upstreamResult = context.nodeResults.get(upstreamId);
      return upstreamResult ? { ...upstreamResult.output } : {};
    }

    // 多上游（merge 场景）：合并所有上游输出
    const merged: Record<string, unknown> = {};
    for (const edge of incomingEdges) {
      const upstreamResult = context.nodeResults.get(edge.from);
      if (upstreamResult && upstreamResult.status === "completed") {
        // 以节点 ID 为 key 存储输出，EdgeResolver 可通过路径访问
        merged[edge.from] = upstreamResult.output;
        // 同时展开字段（后写入者覆盖前写入者，适用于字段不重叠场景）
        Object.assign(merged, upstreamResult.output);
      }
    }
    return merged;
  }

  /**
   * 记录护栏事件到 triggeredGuards
   *
   * @param checkResult 护栏检查结果
   * @param phase 触发时机（pre / post / validate）
   * @param nodeId 关联节点 ID（validate 阶段为空）
   */
  private recordGuardRecord(
    checkResult: GraphGuardCheckResult,
    phase: "pre" | "post" | "validate",
    nodeId?: string
  ): void {
    // 只记录未通过或严重级别的事件（避免记录过多正常通过的事件）
    if (!checkResult.passed || checkResult.severity === "warning" || checkResult.severity === "error") {
      this.currentTriggeredGuards.push({
        recordId: generateId(),
        guardName: phase === "pre" ? "preExecutionGuard" : phase === "post" ? "postExecutionGuard" : "validateGraph",
        triggerPhase: phase,
        nodeId,
        result: checkResult,
        triggeredAt: new Date().toISOString(),
      });
    }
  }

  /**
   * 确定图最终状态
   *
   * @param context 运行上下文
   * @param stopReason 停止原因
   * @returns 最终状态（completed / failed / aborted / timeout）
   */
  private determineFinalStatus(
    context: GraphRunContext,
    stopReason: string | null
  ): "completed" | "failed" | "aborted" | "timeout" {
    // 用户取消
    if (context.cancelled || stopReason) {
      return "aborted";
    }

    // 调度器触发的 stop_failure / stop_timeout 优先判定
    if (this.prematureStop === "failed") {
      return "failed";
    }
    if (this.prematureStop === "timeout") {
      return "timeout";
    }

    // 图级超时兜底
    const elapsedSec = (Date.now() - context.startedAtMs) / 1000;
    if (context.config.timeoutSec > 0 && elapsedSec >= context.config.timeoutSec) {
      return "timeout";
    }

    // 检查是否有 failed 节点（未隔离的失败）
    const hasFailed = Array.from(context.nodeResults.values()).some((r) => r.status === "failed");
    if (hasFailed) {
      return "failed";
    }

    // 默认成功完成
    return "completed";
  }

  /**
   * 构建最终报告（Markdown 格式）
   *
   * @param graph 工作图定义
   * @param context 运行上下文
   * @param finalStatus 最终状态
   * @param totalIterations 总迭代次数
   * @param elapsedSec 总耗时
   * @returns Markdown 格式报告
   */
  private buildFinalReport(
    graph: Readonly<WorkGraph>,
    context: GraphRunContext,
    finalStatus: string,
    totalIterations: number,
    elapsedSec: number
  ): string {
    const lines: string[] = [];
    lines.push(`# 图运行报告`);
    lines.push(``);
    lines.push(`- **图名称**：${graph.name}`);
    lines.push(`- **图 ID**：${graph.graphId}`);
    lines.push(`- **运行 ID**：${context.runId}`);
    lines.push(`- **最终状态**：${finalStatus}`);
    lines.push(`- **总耗时**：${elapsedSec.toFixed(2)}s`);
    lines.push(`- **总迭代次数**：${totalIterations}`);
    lines.push(`- **总 token 消耗**：${context.totalTokensUsed}`);
    lines.push(`- **遍历路径**：${this.currentTraversalPath.join(" → ")}`);
    lines.push(``);
    lines.push(`## 节点执行结果`);
    lines.push(``);
    lines.push(`| 节点 ID | 类型 | 状态 | 耗时(s) | 重试次数 | 失败原因 |`);
    lines.push(`|---------|------|------|---------|----------|----------|`);
    for (const [nodeId, result] of context.nodeResults.entries()) {
      lines.push(
        `| ${nodeId} | ${result.nodeType} | ${result.status} | ${result.durationSec.toFixed(2)} | ${result.retryCount} | ${result.failureReason ?? "-"} |`
      );
    }
    lines.push(``);
    if (this.currentTriggeredGuards.length > 0) {
      lines.push(`## 触发的护栏事件`);
      lines.push(``);
      for (const guard of this.currentTriggeredGuards) {
        lines.push(
          `- **${guard.guardName}** (${guard.triggerPhase}) ${guard.nodeId ? `节点 ${guard.nodeId}` : ""}：${guard.result.reason}`
        );
      }
      lines.push(``);
    }
    return lines.join("\n");
  }

  /**
   * 构建图运行报告对象
   *
   * @param graph 工作图定义
   * @param runId 运行 ID
   * @param finalStatus 最终状态
   * @param nodeResults 节点结果 Map
   * @param totalIterations 总迭代次数
   * @param totalLlmCallCount 总 LLM 调用次数
   * @param totalTokensUsed 总 token 消耗
   * @param durationSec 总耗时
   * @param finalReport Markdown 报告
   * @returns 冻结的图运行报告
   */
  private buildReport(
    graph: Readonly<WorkGraph>,
    runId: string,
    finalStatus: "completed" | "failed" | "aborted" | "timeout",
    nodeResults: Map<string, GraphNodeResult>,
    totalIterations: number,
    totalLlmCallCount: number,
    totalTokensUsed: number,
    durationSec: number,
    finalReport: string
  ): Readonly<GraphRunReport> {
    return Object.freeze({
      runId,
      graphId: graph.graphId,
      finalStatus,
      traversalPath: Object.freeze([...this.currentTraversalPath]),
      nodeResults: new Map(nodeResults) as ReadonlyMap<string, GraphNodeResult>,
      totalIterations,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
      triggeredGuards: Object.freeze([...this.currentTriggeredGuards]),
      finalReport,
      finalGlobalState: this.snapshotGlobalState(this.currentContext?.globalState),
    });
  }

  /**
   * 生成 globalState 的不可变快照（v3.1-H1）
   *
   * 处理流程（对齐 §13.4.2 / §13.11.2 要求）：
   * 1. structuredClone 深拷贝：避免共享引用污染，Node 17+ 支持克隆 Map/Set/Array/Object
   * 2. 对 sharedArtifacts 中的敏感 key 脱敏：匹配 /key|token|secret|password|credential/i 的字段值替换为 [REDACTED]
   * 3. deepFreeze 递归冻结：确保所有嵌套对象/数组/Map 不可变（架构师 M-4）
   *
   * 设计目的：
   * - 防止外部代码通过 finalGlobalState 修改运行期 globalState（引用污染）
   * - 防止敏感信息（API key、token、密码等）泄漏到图运行报告
   * - 确保报告不可变，便于审计和追溯
   *
   * @param globalState 原始 globalState（可为 undefined）
   * @returns 冻结后的不可变快照（深拷贝 + 脱敏 + 递归冻结）
   */
  private snapshotGlobalState(
    globalState: Readonly<Record<string, unknown>> | undefined
  ): Readonly<Record<string, unknown>> {
    // 1. 空快照兜底：globalState 为 undefined 时返回冻结的空对象
    if (!globalState) {
      return Object.freeze({});
    }

    // 2. deepClone 深拷贝（基于 structuredClone）
    // 避免共享引用污染：外部修改快照不会影响运行期 globalState
    const snapshot = deepClone(globalState) as Record<string, unknown>;

    // 3. 对 sharedArtifacts 中的敏感 key 脱敏
    // 仅处理 sharedArtifacts 字段（其他字段如 projectGoal/nodeSummaries 不含敏感信息）
    const sharedArtifacts = (snapshot as { sharedArtifacts?: Record<string, unknown> }).sharedArtifacts;
    if (sharedArtifacts && typeof sharedArtifacts === "object") {
      redactSensitiveFields(sharedArtifacts);
    }

    // 4. deepFreeze 递归冻结
    // 确保所有嵌套对象/数组不可变，包括 nodeSummaries(Map)/collectedExperiences(Array)/
    // bulletinBoard(Array)/sharedArtifacts(Object) 等引用类型字段
    return deepFreeze(snapshot);
  }

  /**
   * 获取当前关联的工作图定义
   *
   * @returns 工作图定义（run() 执行期间非空）
   */
  private getCurrentGraph(): Readonly<WorkGraph> | null {
    return this.currentGraph;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建基于 console 的默认日志记录器
 *
 * @returns GraphLogger 实例
 */
function createConsoleLogger(): GraphLogger {
  return {
    debug: (message, context) => console.debug(message, context ?? ""),
    info: (message, context) => console.info(message, context ?? ""),
    warn: (message, context) => console.warn(message, context ?? ""),
    error: (message, context) => console.error(message, context ?? ""),
  };
}

/**
 * 生成运行 ID（UUID v4 简化版）
 *
 * @returns 运行 ID 字符串
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成唯一 ID（用于护栏记录等）
 *
 * @returns 唯一 ID 字符串
 */
function generateId(): string {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 将数组按指定大小分块
 *
 * @param array 原始数组
 * @param chunkSize 每块大小
 * @returns 分块后的二维数组
 */
function chunkArray<T>(array: ReadonlyArray<T>, chunkSize: number): ReadonlyArray<ReadonlyArray<T>> {
  if (chunkSize <= 0) {
    return [array];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * 异步等待指定毫秒数
 *
 * @param ms 等待毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
