/**
 * 图级调度器实现（v2.0 实现，对齐设计文档 §11）
 *
 * 本模块实现 GraphSchedulerProtocol，负责图级路由决策，区别于 LoopScheduler（节点内迭代决策）。
 *
 * 决策优先级（对齐 §11.3）：
 * 1. 图级超时（elapsedSec >= timeoutSec → stop_timeout）
 * 2. 图级 token 预算（totalTokensUsed >= maxTokens → stop_failure）
 * 3. 最大深度（currentDepth >= maxDepth → stop_failure）
 * 4. 用户取消（context.cancelled → stop_failure）
 * 5. 连续节点失败熔断（consecutiveNodeFailures >= threshold → stop_failure）
 * 6. 图级总重试预算（totalRetryCount >= maxTotalRetries → stop_failure）
 * 7. 节点失败处理（retryCount × loopIterations >= maxIterationsPerNode → isolate_node；
 *    retryCount < nodeRetryLimit → retry_node；enableAutoIsolation → isolate_node；否则 stop_failure）
 * 8. 节点成功路由（根据节点类型从 edges 查询下游）
 *
 * 双层重试抑制（对齐 §11.4）：
 * - maxTotalRetries：图级总重试预算（默认 nodeRetryLimit × nodes.size × 2）
 * - maxIterationsPerNode：单节点 retryCount × loopIterations 乘积上限（默认 20）
 * - consecutiveNodeFailureThreshold：连续节点失败熔断阈值（默认 3）
 * - backoffStrategy：退避叠加策略（max / sum / graph_only）
 *
 * 接口对齐说明（v2.0 修订）：
 * - decideNext 签名严格匹配 GraphSchedulerProtocol：`(currentNode, currentResult, context) => Promise<GraphSchedulingDecision>`
 * - 图定义（WorkGraph）通过 setGraph() 方法注入，不在 decideNext 参数中
 * - retryCount 从 currentResult.retryCount 读取（节点结果自带重试计数）
 * - lastLoopIterations 从 currentResult.loopReport?.totalIterations 读取（无 Loop 时为 0）
 *
 * @module eag/graph/graph-scheduler
 */

import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图节点定义 */
  GraphNodeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图级调度动作 */
  GraphSchedulingAction,
  /** 图级调度决策 */
  GraphSchedulingDecision,
  /** 双层重试抑制配置 */
  RetrySuppressionConfig,
  /** 谓词注册表接口 */
  PredicateRegistry,
  /** 图日志记录器接口 */
  GraphLogger,
} from "./graph-loop-models";
import type { GraphSchedulerProtocol } from "./graph-loop-protocols";

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认图级重试退避基数（秒）
 *
 * 每次 retry_node 的退避时间 = BASE_BACKOFF_SECONDS × 2^retryCount（指数退避）
 */
const BASE_BACKOFF_SECONDS = 2;

/**
 * 默认最大退避时间（秒），避免退避时间过长
 */
const MAX_BACKOFF_SECONDS = 60;

// ============================================================================
// GraphSchedulerImpl 实现类
// ============================================================================

/**
 * 图级调度器实现类
 *
 * 实现 GraphSchedulerProtocol，提供 decideNext 方法做图级路由决策。
 *
 * 使用示例：
 * ```typescript
 * const scheduler = new GraphSchedulerImpl(retrySuppressionConfig, logger);
 * scheduler.setGraph(workGraph);  // 注入图定义（编排器在执行前调用）
 *
 * const decision = await scheduler.decideNext(node, result, context);
 * if (decision.action === "next_node") {
 *   // 前进到 decision.nextNodeIds[0]
 * } else if (decision.action === "retry_node") {
 *   // 等待 decision.backoffSeconds 后重试当前节点
 * }
 * ```
 */
export class GraphSchedulerImpl implements GraphSchedulerProtocol {
  /** 双层重试抑制配置（冻结，运行期不可修改） */
  private readonly retrySuppression: Readonly<RetrySuppressionConfig>;
  /** 日志记录器 */
  private readonly logger: GraphLogger;
  /** 当前关联的工作图定义（通过 setGraph 注入，decideNext 时使用） */
  private graph: Readonly<WorkGraph> | null;
  /** 图级累计重试次数（所有节点的 retryCount 之和） */
  private totalRetryCount: number;
  /** 连续节点失败次数（成功时重置为 0） */
  private consecutiveNodeFailures: number;

  /**
   * 构造图级调度器
   *
   * @param retrySuppression 双层重试抑制配置
   * @param logger 日志记录器（可选，默认使用 console）
   */
  constructor(retrySuppression: Readonly<RetrySuppressionConfig>, logger?: GraphLogger) {
    this.retrySuppression = retrySuppression;
    this.logger = logger ?? createConsoleLogger();
    this.graph = null;
    this.totalRetryCount = 0;
    this.consecutiveNodeFailures = 0;
  }

  /**
   * 注入工作图定义（编排器在图执行前调用）
   *
   * 由于 GraphSchedulerProtocol.decideNext 签名不包含 graph 参数，
   * 图定义需通过此方法注入，供 routeToNextNodes / routeDecisionNode 查询节点和边。
   *
   * @param graph 工作图定义
   * @throws {Error} 当 graph 为 null 或 undefined 时抛出
   */
  setGraph(graph: Readonly<WorkGraph>): void {
    if (!graph) {
      throw new Error("[GraphScheduler] setGraph: graph 不能为空");
    }
    this.graph = graph;
  }

  /**
   * 图级路由决策（主入口，实现 GraphSchedulerProtocol）
   *
   * 按优先级依次检查各项条件，返回第一个匹配的决策动作。
   *
   * @param currentNode 当前节点定义
   * @param currentResult 当前节点的执行结果（含 retryCount 和 loopReport）
   * @param context 图运行上下文
   * @returns 调度决策（Promise 包装，对齐协议接口）
   * @throws {Error} 当未调用 setGraph 注入图定义时抛出
   */
  async decideNext(
    currentNode: Readonly<GraphNodeDef>,
    currentResult: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): Promise<GraphSchedulingDecision> {
    // 校验图定义已注入
    if (!this.graph) {
      throw new Error("[GraphScheduler] decideNext: 未调用 setGraph 注入图定义");
    }

    // 从 currentResult 提取重试计数和 Loop 迭代次数（协议接口对齐）
    const retryCount = currentResult.retryCount;
    const lastLoopIterations = currentResult.loopReport?.totalIterations ?? 0;

    // 1. 图级超时检查（timeoutSec > 0 时启用）
    const elapsedSec = (Date.now() - context.startedAtMs) / 1000;
    if (context.config.timeoutSec > 0 && elapsedSec >= context.config.timeoutSec) {
      this.logger.warn(
        `[GraphScheduler] 图级超时：elapsedSec=${elapsedSec.toFixed(2)}s >= timeoutSec=${context.config.timeoutSec}s`
      );
      return this.makeDecision(
        "stop_timeout",
        `图级超时：${elapsedSec.toFixed(2)}s >= ${context.config.timeoutSec}s`,
        []
      );
    }

    // 2. 图级 token 预算检查（maxTokens > 0 时启用）
    if (context.config.maxTokens > 0 && context.totalTokensUsed >= context.config.maxTokens) {
      this.logger.warn(
        `[GraphScheduler] 图级 token 预算耗尽：${context.totalTokensUsed} >= ${context.config.maxTokens}`
      );
      return this.makeDecision(
        "stop_failure",
        `图级 token 预算耗尽：${context.totalTokensUsed} >= ${context.config.maxTokens}`,
        []
      );
    }

    // 3. 最大深度检查
    if (context.currentDepth >= context.config.maxDepth) {
      this.logger.warn(`[GraphScheduler] 达到最大遍历深度：${context.currentDepth} >= ${context.config.maxDepth}`);
      return this.makeDecision(
        "stop_failure",
        `达到最大遍历深度：${context.currentDepth} >= ${context.config.maxDepth}`,
        []
      );
    }

    // 4. 用户取消检查
    if (context.cancelled) {
      this.logger.warn(`[GraphScheduler] 用户已请求取消图执行`);
      return this.makeDecision("stop_failure", "用户已请求取消图执行", []);
    }

    // 5. 连续节点失败熔断检查
    if (this.consecutiveNodeFailures >= this.retrySuppression.consecutiveNodeFailureThreshold) {
      this.logger.warn(
        `[GraphScheduler] 连续节点失败熔断：${this.consecutiveNodeFailures} >= ${this.retrySuppression.consecutiveNodeFailureThreshold}`
      );
      return this.makeDecision("stop_failure", `连续节点失败熔断：${this.consecutiveNodeFailures} 个节点连续失败`, []);
    }

    // 6. 节点失败处理
    if (currentResult.status === "failed") {
      // 6.1 图级总重试预算检查（仅在节点失败时触发，避免阻止成功节点前进）
      if (this.totalRetryCount >= this.retrySuppression.maxTotalRetries) {
        this.logger.warn(
          `[GraphScheduler] 图级总重试预算耗尽：${this.totalRetryCount} >= ${this.retrySuppression.maxTotalRetries}`
        );
        return this.makeDecision(
          "stop_failure",
          `图级总重试预算耗尽：${this.totalRetryCount} >= ${this.retrySuppression.maxTotalRetries}`,
          []
        );
      }
      return this.handleNodeFailure(currentNode, currentResult, context, retryCount, lastLoopIterations);
    }

    // 8. 节点隔离处理（isolated 状态：跳过后续依赖，继续图遍历）
    if (currentResult.status === "isolated") {
      // 隔离节点的下游应跳过，尝试前进到其他可达节点
      this.logger.info(`[GraphScheduler] 节点 ${currentNode.nodeId} 已隔离，尝试跳过后续依赖`);
      return this.routeToNextNodes(currentNode, context);
    }

    // 9. 节点跳过处理（skipped 状态：继续前进）
    if (currentResult.status === "skipped") {
      this.logger.info(`[GraphScheduler] 节点 ${currentNode.nodeId} 已跳过，继续前进`);
      return this.routeToNextNodes(currentNode, context);
    }

    // 10. 节点成功处理（completed 状态）
    if (currentResult.status === "completed") {
      // 成功时重置连续失败计数
      this.consecutiveNodeFailures = 0;
      return this.routeToNextNodes(currentNode, context);
    }

    // 未知状态：默认停止
    return this.makeDecision("stop_failure", `未知节点状态：${currentResult.status}`, []);
  }

  /**
   * 获取图级累计重试次数
   *
   * @returns 累计重试次数
   */
  getTotalRetryCount(): number {
    return this.totalRetryCount;
  }

  /**
   * 获取连续节点失败次数
   *
   * @returns 连续失败次数
   */
  getConsecutiveNodeFailures(): number {
    return this.consecutiveNodeFailures;
  }

  /**
   * 重置调度器状态（新图运行前调用）
   *
   * 清空累计重试次数和连续失败计数，并清除图定义引用。
   */
  reset(): void {
    this.totalRetryCount = 0;
    this.consecutiveNodeFailures = 0;
    this.graph = null;
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 处理节点失败情况
   *
   * 决策流程（对齐 §11.4 决策流程）：
   * 1. 检查 retryCount × lastLoopIterations 乘积上限 → ISOLATE_NODE
   * 2. retryCount < nodeRetryLimit → RETRY_NODE（带退避）
   * 3. enableAutoIsolation → ISOLATE_NODE
   * 4. 否则 → STOP_FAILURE
   *
   * @param node 失败节点
   * @param result 执行结果
   * @param context 运行上下文
   * @param retryCount 当前重试次数（从 result.retryCount 读取）
   * @param lastLoopIterations 最后一轮 Loop 迭代次数（从 result.loopReport 读取）
   * @returns 调度决策
   */
  private handleNodeFailure(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>,
    retryCount: number,
    lastLoopIterations: number
  ): GraphSchedulingDecision {
    // 递增连续失败计数
    this.consecutiveNodeFailures++;

    // 1. 检查 retryCount × lastLoopIterations 乘积上限（双层重试抑制）
    // 使用 (retryCount + 1) 因为 retryCount 是已重试次数，本次失败是第 retryCount+1 次尝试
    const iterationsProduct = (retryCount + 1) * Math.max(lastLoopIterations, 1);
    if (iterationsProduct >= this.retrySuppression.maxIterationsPerNode) {
      this.logger.warn(
        `[GraphScheduler] 节点 ${node.nodeId} 重试 × 迭代乘积超限：${iterationsProduct} >= ${this.retrySuppression.maxIterationsPerNode}，隔离节点`
      );
      return this.makeDecision(
        "isolate_node",
        `重试 × 迭代乘积超限：${iterationsProduct} >= ${this.retrySuppression.maxIterationsPerNode}`,
        []
      );
    }

    // 2. retryCount < nodeRetryLimit → RETRY_NODE
    if (retryCount < context.config.nodeRetryLimit) {
      this.totalRetryCount++;
      const backoffSeconds = this.computeBackoff(retryCount);
      this.logger.info(`[GraphScheduler] 节点 ${node.nodeId} 重试（第 ${retryCount + 1} 次），退避 ${backoffSeconds}s`);
      return {
        action: "retry_node",
        reason: `节点 ${node.nodeId} 执行失败（${result.failureReason ?? "未知原因"}），重试第 ${retryCount + 1} 次`,
        nextNodeIds: Object.freeze([node.nodeId]),
        backoffSeconds,
        requiresHumanInput: false,
      };
    }

    // 3. enableAutoIsolation → ISOLATE_NODE
    if (context.config.enableAutoIsolation) {
      this.logger.warn(`[GraphScheduler] 节点 ${node.nodeId} 重试次数耗尽（${retryCount}），自动隔离`);
      return this.makeDecision(
        "isolate_node",
        `节点 ${node.nodeId} 重试次数耗尽（${retryCount} >= ${context.config.nodeRetryLimit}），自动隔离`,
        []
      );
    }

    // 4. 否则 → STOP_FAILURE
    this.logger.error(`[GraphScheduler] 节点 ${node.nodeId} 失败且未启用自动隔离，整图终止`);
    return this.makeDecision("stop_failure", `节点 ${node.nodeId} 失败且未启用自动隔离`, []);
  }

  /**
   * 根据节点类型路由到下游节点
   *
   * 路由规则（对齐 §11.3 决策优先级第 5 条）：
   * - loop/task：nextNodeIds = [edges.from(nodeId)[0].to]
   * - decision：调用 predicateRegistry.lookup(decisionPredicateId) 选择下游边
   * - fork：nextNodeIds = edges.from(nodeId).map(e => e.to)（受 maxParallelism 限制）
   * - merge：nextNodeIds = [edges.from(nodeId)[0].to]
   * - end：STOP_SUCCESS
   *
   * @param node 当前节点
   * @param context 运行上下文
   * @returns 调度决策
   */
  private routeToNextNodes(node: Readonly<GraphNodeDef>, context: Readonly<GraphRunContext>): GraphSchedulingDecision {
    // graph 已在 decideNext 入口校验非空，此处安全断言
    const graph = this.graph as Readonly<WorkGraph>;

    // end 节点：图执行成功完成
    if (node.nodeType === "end") {
      this.logger.info(`[GraphScheduler] 到达 end 节点 ${node.nodeId}，图执行成功完成`);
      return this.makeDecision("stop_success", `到达 end 节点 ${node.nodeId}，图执行成功完成`, []);
    }

    // 查询下游边（from = node.nodeId）
    const downstreamEdges = graph.edges.filter((e) => e.from === node.nodeId);

    // 无下游边：视为到达终点
    if (downstreamEdges.length === 0) {
      this.logger.info(`[GraphScheduler] 节点 ${node.nodeId} 无下游边，图执行结束`);
      return this.makeDecision("stop_success", `节点 ${node.nodeId} 无下游边，图执行结束`, []);
    }

    // decision 节点：调用谓词函数选择下游边
    if (node.nodeType === "decision") {
      return this.routeDecisionNode(node, downstreamEdges, context);
    }

    // fork 节点：并行分支已由 orchestrator.executeFork 执行，scheduler 只需决策汇聚点
    // 找到所有分支下游节点的交集（即共同汇聚节点，通常为 merge），避免主循环重复执行分支节点
    if (node.nodeType === "fork") {
      const branchNodeIds = downstreamEdges.map((e) => e.to);
      const downstreamSets = branchNodeIds.map(
        (branchId) => new Set(graph.edges.filter((e) => e.from === branchId).map((e) => e.to))
      );
      const firstSet = downstreamSets[0] ?? new Set<string>();
      const commonDownstream =
        downstreamSets.length > 0
          ? Array.from(firstSet).filter((id) => downstreamSets.every((set) => set.has(id)))
          : [];

      if (commonDownstream.length > 0) {
        this.logger.info(`[GraphScheduler] fork 节点 ${node.nodeId} 汇聚到 ${commonDownstream.join(", ")}`);
        return this.makeDecision(
          "next_node",
          `fork 节点 ${node.nodeId} 汇聚到 ${commonDownstream.join(", ")}`,
          commonDownstream
        );
      }

      // 无共同汇聚节点：保持原行为，派发到分支节点（向后兼容）
      const parallelism = Math.min(downstreamEdges.length, context.config.maxParallelism);
      const nextNodeIds = downstreamEdges.slice(0, parallelism).map((e) => e.to);
      this.logger.info(
        `[GraphScheduler] fork 节点 ${node.nodeId} 派发到 ${nextNodeIds.length} 个下游（maxParallelism=${context.config.maxParallelism}）`
      );
      return this.makeDecision(
        "next_node",
        `fork 节点 ${node.nodeId} 并行派发到 ${nextNodeIds.length} 个下游`,
        nextNodeIds
      );
    }

    // loop / task / merge 节点：前进到第一条下游边的目标
    const nextNodeId = downstreamEdges[0].to;
    this.logger.info(`[GraphScheduler] 节点 ${node.nodeId} → ${nextNodeId}`);
    return this.makeDecision("next_node", `节点 ${node.nodeId} → ${nextNodeId}`, [nextNodeId]);
  }

  /**
   * 处理 decision 节点的谓词路由
   *
   * 调用 predicateRegistry.lookup(decisionPredicateId) 获取谓词函数，
   * 执行后返回选中的下游边 ID，找到对应的下游节点。
   *
   * 谓词函数签名：(input: Record<string, unknown>, context: GraphRunContext) => string | boolean
   * - 返回 string：选中的下游边 ID（edgeId）
   * - 返回 boolean：true 选择第一条边，false 选择第二条边（二元分支）
   *
   * @param node decision 节点
   * @param downstreamEdges 下游边列表
   * @param context 运行上下文
   * @returns 调度决策
   */
  private routeDecisionNode(
    node: Readonly<GraphNodeDef>,
    downstreamEdges: ReadonlyArray<{ edgeId: string; to: string }>,
    context: Readonly<GraphRunContext>
  ): GraphSchedulingDecision {
    if (!node.decisionPredicateId) {
      this.logger.error(`[GraphScheduler] decision 节点 ${node.nodeId} 缺少 decisionPredicateId`);
      return this.makeDecision("stop_failure", `decision 节点 ${node.nodeId} 缺少 decisionPredicateId`, []);
    }

    // 从上下文中获取谓词注册表
    const registry: PredicateRegistry = context.predicateRegistry;

    let predicateResult: string | boolean;
    try {
      const predicate = registry.lookup(node.decisionPredicateId);
      // 从 context.nodeResults 获取当前节点的输入数据（上游输出合并后）
      // decision 谓词从 context.globalState 和 nodeResults 读取所需数据
      const input = this.getNodeInput(node, context);
      predicateResult = predicate(input, context);
    } catch (err) {
      this.logger.error(
        `[GraphScheduler] decision 节点 ${node.nodeId} 谓词执行失败：${err instanceof Error ? err.message : String(err)}`
      );
      return this.makeDecision(
        "stop_failure",
        `decision 节点 ${node.nodeId} 谓词执行失败：${err instanceof Error ? err.message : String(err)}`,
        []
      );
    }

    // 谓词返回 string：选中的下游边 ID
    if (typeof predicateResult === "string") {
      const selectedEdge = downstreamEdges.find((e) => e.edgeId === predicateResult);
      if (!selectedEdge) {
        this.logger.error(
          `[GraphScheduler] decision 节点 ${node.nodeId} 谓词返回的边 ID "${predicateResult}" 不在下游边中`
        );
        return this.makeDecision(
          "stop_failure",
          `decision 节点 ${node.nodeId} 谓词返回的边 ID "${predicateResult}" 不在下游边中`,
          []
        );
      }
      this.logger.info(
        `[GraphScheduler] decision 节点 ${node.nodeId} → ${selectedEdge.to}（边 ${selectedEdge.edgeId}）`
      );
      return this.makeDecision(
        "next_node",
        `decision 节点 ${node.nodeId} 选择边 ${selectedEdge.edgeId} → ${selectedEdge.to}`,
        [selectedEdge.to]
      );
    }

    // 谓词返回 boolean：true → 第一条边，false → 第二条边（二元分支）
    if (typeof predicateResult === "boolean") {
      const edgeIndex = predicateResult ? 0 : 1;
      const selectedEdge = downstreamEdges[edgeIndex];
      if (!selectedEdge) {
        this.logger.error(
          `[GraphScheduler] decision 节点 ${node.nodeId} 谓词返回 ${predicateResult} 但下游边不足（需要至少 ${edgeIndex + 1} 条）`
        );
        return this.makeDecision(
          "stop_failure",
          `decision 节点 ${node.nodeId} 谓词返回 ${predicateResult} 但下游边不足`,
          []
        );
      }
      this.logger.info(
        `[GraphScheduler] decision 节点 ${node.nodeId} 谓词返回 ${predicateResult}，选择边 ${selectedEdge.edgeId} → ${selectedEdge.to}`
      );
      return this.makeDecision(
        "next_node",
        `decision 节点 ${node.nodeId} 谓词返回 ${predicateResult}，选择边 ${selectedEdge.edgeId}`,
        [selectedEdge.to]
      );
    }

    return this.makeDecision(
      "stop_failure",
      `decision 节点 ${node.nodeId} 谓词返回类型未知：${typeof predicateResult}`,
      []
    );
  }

  /**
   * 获取节点输入数据（从 context.nodeResults 中合并上游输出）
   *
   * decision 谓词需要访问上游节点的输出数据做条件判断。
   * 此处从 context.nodeResults 读取已完成的节点结果，合并为一个输入对象。
   *
   * @param node 目标节点
   * @param context 运行上下文
   * @returns 合并后的输入数据
   */
  private getNodeInput(node: Readonly<GraphNodeDef>, context: Readonly<GraphRunContext>): Record<string, unknown> {
    // 从 context.nodeResults 合并所有已完成节点的输出
    // 谓词函数可根据需要从合并对象中读取字段
    const merged: Record<string, unknown> = {};
    for (const [nodeId, result] of context.nodeResults.entries()) {
      if (result.status === "completed") {
        merged[nodeId] = result.output;
      }
    }
    // 合并 globalState 中的共享状态
    Object.assign(merged, context.globalState);
    return merged;
  }

  /**
   * 计算退避时间（指数退避）
   *
   * 退避时间 = BASE_BACKOFF_SECONDS × 2^retryCount，上限 MAX_BACKOFF_SECONDS
   *
   * @param retryCount 当前重试次数
   * @returns 退避秒数
   */
  private computeBackoff(retryCount: number): number {
    const backoff = BASE_BACKOFF_SECONDS * Math.pow(2, retryCount);
    return Math.min(backoff, MAX_BACKOFF_SECONDS);
  }

  /**
   * 构造调度决策对象
   *
   * @param action 决策动作
   * @param reason 决策理由
   * @param nextNodeIds 下游节点 ID 列表
   * @param backoffSeconds 退避秒数（默认 0）
   * @param requiresHumanInput 是否需要人工输入（默认 false）
   * @returns 调度决策对象（nextNodeIds 已冻结）
   */
  private makeDecision(
    action: GraphSchedulingAction,
    reason: string,
    nextNodeIds: ReadonlyArray<string>,
    backoffSeconds: number = 0,
    requiresHumanInput: boolean = false
  ): GraphSchedulingDecision {
    return {
      action,
      reason,
      nextNodeIds: Object.freeze([...nextNodeIds]),
      backoffSeconds,
      requiresHumanInput,
    };
  }
}

/**
 * 创建图级调度器实例（工厂函数）
 *
 * @param retrySuppression 双层重试抑制配置
 * @param logger 日志记录器（可选）
 * @returns 新的 GraphSchedulerProtocol 实例
 */
export function createGraphScheduler(
  retrySuppression: Readonly<RetrySuppressionConfig>,
  logger?: GraphLogger
): GraphSchedulerProtocol {
  return new GraphSchedulerImpl(retrySuppression, logger);
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
