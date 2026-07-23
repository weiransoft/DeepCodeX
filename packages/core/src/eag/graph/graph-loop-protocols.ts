/**
 * Loop-Graph 融合架构协议接口（v2.0 实现）
 *
 * 本模块定义 Loop-Graph 融合方案的行为协议接口，对应设计文档：
 * - §8 核心协议接口（NodeExecutorProtocol / EdgeResolverProtocol / GraphGuardProtocol）
 * - §7.6 支持类型中的协议接口（GraphSchedulerProtocol / ExperienceStoreProtocol）
 * - §7.6 GraphLoopOrchestratorOptions（编排器构造选项，依赖上述协议接口）
 *
 * 设计原则：
 * - 协议与数据分离：本文件只定义"行为契约"（带方法签名的 interface），
 *   数据形状定义在 graph-loop-models.ts
 * - 依赖注入：GraphLoopOrchestrator 通过 GraphLoopOrchestratorOptions 接收所有协作组件，
 *   便于测试时注入 mock 实现（测试场景）和生产时注入真实实现（生产场景）
 * - 单向依赖：protocols.ts → models.ts（仅导入数据类型，不反向依赖）
 *
 * 实现责任分工：
 * - NodeExecutorProtocol：执行单个图节点（loop/task/decision/merge/fork/end 分流）
 *   实现类：NodeExecutorImpl（Phase 2 node-loop-kernel.ts 中提供 NodeLoopKernel，
 *           Phase 3 在 graph-loop-orchestrator.ts 中实现完整 NodeExecutor）
 * - EdgeResolverProtocol：解析边契约，构造目标节点输入数据
 *   实现类：EdgeResolverImpl（Phase 2 graph-edge-resolver.ts）
 * - GraphGuardProtocol：图级护栏（结构校验 + 节点执行前后置检查）
 *   实现类：GraphGuardImpl（Phase 2 graph-guard.ts）
 * - GraphSchedulerProtocol：图级调度器（决策下一节点 / 重试 / 隔离 / 停止）
 *   实现类：GraphSchedulerImpl（Phase 3 graph-scheduler.ts）
 * - ExperienceStoreProtocol：经验存储（Layer 3 案例召回与积累）
 *   实现类：ExperienceStoreImpl（Phase 4 experience-store.ts）
 *
 * @module eag/graph/graph-loop-protocols
 */

import type {
  /** 图节点定义 */
  GraphNodeDef,
  /** 图边定义 */
  GraphEdgeDef,
  /** 工作图定义 */
  WorkGraph,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图结构校验结果 */
  GraphValidationResult,
  /** 图级护栏检查结果 */
  GraphGuardCheckResult,
  /** 图级调度决策 */
  GraphSchedulingDecision,
  /** 经验案例 */
  ExperienceCase,
  /** 谓词注册表接口 */
  PredicateRegistry,
  /** 图日志记录器接口 */
  GraphLogger,
} from "./graph-loop-models";

// ============================================================================
// §8.1 NodeExecutorProtocol：节点执行器协议
// ============================================================================

/**
 * 节点执行器协议（§8.1）
 *
 * 负责执行单个图节点，根据节点类型分流：
 * - loop 节点：创建 NodeLoopKernel 执行五步闭环（Discovery→Handoff→Verification→Persistence→Scheduling）
 * - task 节点：直接调用关联 plugin（通过 PluginRegistry 查找已注册的 team plugin）
 * - decision 节点：调用 PredicateRegistry 中注册的谓词函数选择下游分支（v2.0 修订，不再使用 `fn:` 表达式）
 * - merge 节点：等待上游完成并合并结果（从 GraphRunContext.nodeResults 读取所有上游输出）
 * - fork 节点：并行派发到多个下游（通过 Promise.all，受 maxParallelism 限制）
 * - end 节点：终止图遍历（返回特殊状态结果，由 GraphScheduler 转换为 STOP_SUCCESS）
 *
 * 调用契约：
 * - 调用方：GraphLoopOrchestrator（在主循环中调用 execute 执行每个节点）
 * - 输入：node（节点定义）+ input（已通过 EdgeResolver 解析边契约后得到的输入数据）+ context（图运行上下文）
 * - 输出：GraphNodeResult（包含 status / output / loopReport / durationSec / failureReason / retryCount）
 * - 副作用：可能写入 context.globalState / context.nodeResults / context.totalTokensUsed
 * - 取消响应：execute 内部需在耗时操作前检查 context.cancelled，为 true 时立即返回 failed 状态
 */
export interface NodeExecutorProtocol {
  /**
   * 执行单个图节点
   *
   * @param node 节点定义（含节点类型、任务描述、契约、Loop 配置等）
   * @param input 输入数据（已通过 EdgeResolver 解析边契约后得到，符合 node.inputContract）
   * @param context 图运行上下文（含全局状态、取消信号、谓词注册表等）
   * @returns 节点执行结果（包含 status / output / loopReport / durationSec / failureReason / retryCount）
   */
  execute(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): Promise<GraphNodeResult>;
}

// ============================================================================
// §8.2 EdgeResolverProtocol：边解析器协议
// ============================================================================

/**
 * 边解析器协议（§8.2）
 *
 * 负责解析边契约，将源节点的输出数据映射到目标节点的输入。
 *
 * 解析流程：
 * 1. 接收从源节点到目标节点的所有边（可能多条，merge 节点场景）
 * 2. 遍历每条边的 dataMapping，按 "key=value" 映射字段
 *    - key：目标节点的输入字段名
 *    - value：源节点输出字段的路径（支持点号路径，如 "output.designDoc"）
 * 3. 按 targetNode.inputContract 校验字段类型与必填性
 *    - required=true 但解析不到值 → 抛出错误（除非有 defaultValue）
 *    - required=false 且解析不到值 → 使用 defaultValue 或忽略
 * 4. 返回构造好的目标节点输入数据
 *
 * 调用契约：
 * - 调用方：GraphLoopOrchestrator（在执行目标节点前调用 resolve 构造其输入）
 * - 输入：edges（源到目标的所有边）+ sourceOutput（源节点输出）+ targetNode（目标节点定义）+ globalState（图级状态）
 * - 输出：目标节点的输入数据（符合 targetNode.inputContract）
 * - 副作用：无（纯函数，不修改输入参数）
 */
export interface EdgeResolverProtocol {
  /**
   * 解析边契约，构造目标节点的输入数据
   *
   * @param edges 从源节点到目标节点的所有边（merge 场景为多条，普通场景为单条）
   * @param sourceOutput 源节点的输出数据（merge 场景为合并后的输出对象）
   * @param targetNode 目标节点定义（用于读取 inputContract 进行字段校验）
   * @param globalState 图级共享状态（供 dataMapping 引用全局字段，如 "$state.userId"）
   * @returns 目标节点的输入数据（符合 targetNode.inputContract 声明的字段规范）
   * @throws {Error} 当 required 字段无法解析且无 defaultValue 时抛出
   */
  resolve(
    edges: ReadonlyArray<GraphEdgeDef>,
    sourceOutput: Readonly<Record<string, unknown>>,
    targetNode: Readonly<GraphNodeDef>,
    globalState: Readonly<Record<string, unknown>>
  ): Readonly<Record<string, unknown>>;
}

// ============================================================================
// §8.3 GraphGuardProtocol：图级护栏协议
// ============================================================================

/**
 * 图级护栏协议（§8.3）
 *
 * 提供图遍历过程中的安全防护，分三个阶段检查：
 *
 * 1. validateGraph（图构造时调用，一次性）：
 *    - 入口节点存在（entryNodeId 在 nodes 中）
 *    - 所有 edges 的 from/to 引用的节点存在
 *    - 无不可达节点（从入口不可到达的节点，作为 warnings 提示）
 *    - 环路标记（有环图需显式标记 isCyclic=true，避免无限遍历）
 *    - decision 节点的 decisionPredicateId 在 PredicateRegistry 中已注册
 *    - edge 的 activationPredicateId（若存在）在 PredicateRegistry 中已注册
 *
 * 2. checkPreExecution（节点执行前调用，每节点）：
 *    - 检查节点是否已被隔离（isolated 节点直接跳过）
 *    - 检查图级超时（elapsedSec >= config.timeoutSec）
 *    - 检查图级 token 预算（totalTokensUsed >= config.maxTokens）
 *    - 检查当前遍历深度（currentDepth >= config.maxDepth）
 *
 * 3. checkPostExecution（节点执行后调用，每节点）：
 *    - 检查节点输出是否符合 outputContract（字段类型与必填性）
 *    - 检查节点耗时是否异常（如单节点超过总预算的 50%）
 *    - 检查节点失败是否触发熔断（连续失败达 consecutiveNodeFailureThreshold）
 *
 * 调用契约：
 * - 调用方：GraphLoopOrchestrator（在节点执行前后调用 checkPreExecution/checkPostExecution）
 * - 返回值：GraphGuardCheckResult（passed=false 时携带 suggestedAction 指导 GraphScheduler 决策）
 */
export interface GraphGuardProtocol {
  /**
   * 检查图结构完整性（构造时调用一次）
   *
   * 校验项（v2.0 修订：基于 edges 而非 node.next）：
   * - 入口节点存在
   * - 所有 edges 的 from/to 引用的节点存在
   * - 无不可达节点（从入口不可到达的节点）
   * - 环路标记（有环图需显式标记 isCyclic=true）
   * - decision 节点的 decisionPredicateId 在 PredicateRegistry 中已注册
   * - edge 的 activationPredicateId（若存在）在 PredicateRegistry 中已注册
   *
   * @param graph 待校验的工作图
   * @returns 校验结果（valid / errors / warnings / isCyclic / unreachableNodes）
   */
  validateGraph(graph: Readonly<WorkGraph>): GraphValidationResult;

  /**
   * 检查节点执行前的前置条件
   *
   * 检查项：
   * - 节点是否已被隔离（isolated 节点直接跳过）
   * - 图级超时（elapsedSec >= config.timeoutSec → suggestedAction=stop_timeout）
   * - 图级 token 预算（totalTokensUsed >= config.maxTokens → suggestedAction=stop_failure）
   * - 当前遍历深度（currentDepth >= config.maxDepth → suggestedAction=stop_failure）
   *
   * @param node 待执行节点
   * @param context 运行上下文
   * @returns 是否允许执行（passed=false 时携带 suggestedAction 和 reason）
   */
  checkPreExecution(node: Readonly<GraphNodeDef>, context: Readonly<GraphRunContext>): GraphGuardCheckResult;

  /**
   * 检查节点执行后的后置条件
   *
   * 检查项：
   * - 节点输出是否符合 outputContract（字段类型与必填性）
   * - 节点耗时是否异常（如单节点超过总耗时 50%）
   * - 节点失败是否触发熔断（连续失败达 consecutiveNodeFailureThreshold）
   *
   * @param node 已执行节点
   * @param result 执行结果
   * @param context 运行上下文
   * @returns 是否允许继续（passed=false 时携带 suggestedAction 和 reason）
   */
  checkPostExecution(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): GraphGuardCheckResult;
}

// ============================================================================
// §7.6 GraphSchedulerProtocol：图级调度器协议
// ============================================================================

/**
 * 图级调度器协议（v2.0 补充定义）
 *
 * 与 LoopScheduler（节点内迭代决策）对应，负责图级路由决策。
 *
 * 决策类型对比：
 * | 决策类型     | LoopScheduler（节点内）       | GraphScheduler（图级）          |
 * |-------------|------------------------------|--------------------------------|
 * | 决策范围     | 单节点内的下一轮迭代           | 图中下一个要执行的节点           |
 * | 输入         | verdict / failures / tokens  | nodeResult / graphState / depth|
 * | 输出         | CONTINUE / FIX / STOP        | NEXT_NODE / RETRY / ISOLATE / STOP |
 * | 退避         | 指数退避（节点内重试）         | 节点级退避（图级重试）           |
 *
 * 实现类：GraphSchedulerImpl（Phase 3 graph-scheduler.ts），需实现：
 * - §11.3 决策优先级（超时 → token → 深度 → 节点失败 → 节点成功）
 * - §11.4 双层重试抑制（maxTotalRetries / maxIterationsPerNode / 熔断）
 */
export interface GraphSchedulerProtocol {
  /**
   * 决定下一个要执行的节点
   *
   * 决策流程（对齐 §11.4 含重试抑制）：
   * 1. 检查图级超时 / token / depth → STOP
   * 2. 检查连续节点失败熔断 → STOP_FAILURE
   * 3. 检查图级总重试预算 → STOP_FAILURE
   * 4. if result.status == "failed":
   *    a. if retryCount × lastLoopIterations >= maxIterationsPerNode → ISOLATE_NODE
   *    b. if retryCount < nodeRetryLimit → RETRY_NODE
   *    c. else if enableAutoIsolation → ISOLATE_NODE
   *    d. else → STOP_FAILURE
   * 5. if result.status == "completed": 根据节点类型选择 next
   *    - loop/task：nextNodeIds = [edges.from(nodeId)[0].to]
   *    - decision：调用 predicateRegistry.lookup(decisionPredicateId) → nextNodeIds = [selectedEdge.to]
   *    - fork：nextNodeIds = edges.from(nodeId).map(e => e.to)（受 maxParallelism 限制）
   *    - merge：等待所有上游边完成 → nextNodeIds = [edges.from(nodeId)[0].to]
   *    - end：STOP_SUCCESS
   *
   * @param currentNode 当前节点定义
   * @param currentResult 当前节点执行结果
   * @param context 图运行上下文
   * @returns 调度决策（包含 action / reason / nextNodeIds / backoffSeconds / requiresHumanInput）
   */
  decideNext(
    currentNode: Readonly<GraphNodeDef>,
    currentResult: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): Promise<GraphSchedulingDecision>;
}

// ============================================================================
// §7.6 ExperienceStoreProtocol：经验存储协议
// ============================================================================

/**
 * 经验存储协议（v2.0 补充定义）
 *
 * Layer 3 经验自进化的存储抽象，由 Phase 4 experience-store.ts 提供具体实现。
 *
 * 使用场景：
 * - NodeLoopKernel 在 Discovery 阶段调用 recallSimilar 查询相似案例，辅助决策
 * - GraphLoopOrchestrator 在图执行完成后调用 storeCase 写入新案例，积累经验
 *
 * 实现要求：
 * - recallSimilar 必须按相似度降序返回（最相似的在前）
 * - storeCase 必须保证写入持久化（内存/文件/数据库均可，由实现决定）
 * - 相似度算法：v2.0 使用加权 Jaccard + 归一化欧氏距离（对齐 §14.1），
 *   未来可替换为向量检索（如 sentence-transformers embedding）
 */
export interface ExperienceStoreProtocol {
  /**
   * 查询相似案例（用于经验召回）
   *
   * @param taskFeatures 当前任务特征（键值对形式，如 { language: "typescript", complexity: "high" }）
   * @param limit 返回案例数上限（按相似度降序取前 N 个）
   * @returns 相似案例列表（按相似度降序，最相似的在前）
   */
  recallSimilar(taskFeatures: Readonly<Record<string, unknown>>, limit: number): Promise<ReadonlyArray<ExperienceCase>>;

  /**
   * 写入新案例（用于经验积累）
   *
   * @param caseData 执行案例（包含 taskType / taskFeatures / strategy / success / executionTimeSec 等）
   */
  storeCase(caseData: Readonly<ExperienceCase>): Promise<void>;
}

// ============================================================================
// §7.6 GraphLoopOrchestratorOptions：编排器构造选项
// ============================================================================

/**
 * GraphLoopOrchestrator 构造选项（v2.0 补充定义）
 *
 * 通过依赖注入方式传入所有协作组件，便于测试和扩展。
 *
 * 必需组件：
 * - nodeExecutor：节点执行器（实现 NodeExecutorProtocol）
 * - edgeResolver：边解析器（实现 EdgeResolverProtocol）
 * - graphScheduler：图级调度器（实现 GraphSchedulerProtocol）
 * - graphGuard：图级护栏（实现 GraphGuardProtocol）
 * - predicateRegistry：谓词注册表（实现 PredicateRegistry）
 *
 * 可选组件：
 * - experienceStore：经验存储（Layer 3 集成时启用，Phase 4 实现）
 * - logger：日志记录器（默认使用 console）
 *
 * 使用示例：
 * ```typescript
 * const options: GraphLoopOrchestratorOptions = {
 *   nodeExecutor: new NodeExecutorImpl(...),
 *   edgeResolver: new EdgeResolverImpl(),
 *   graphScheduler: new GraphSchedulerImpl(config),
 *   graphGuard: new GraphGuardImpl(config),
 *   predicateRegistry: createPredicateRegistry(),
 *   experienceStore: new ExperienceStoreImpl(...),  // 可选
 *   logger: consoleLogger,                          // 可选
 * };
 * const orchestrator = new GraphLoopOrchestrator(options);
 * ```
 */
export interface GraphLoopOrchestratorOptions {
  /** 节点执行器（必需，实现 NodeExecutorProtocol） */
  readonly nodeExecutor: NodeExecutorProtocol;
  /** 边解析器（必需，实现 EdgeResolverProtocol） */
  readonly edgeResolver: EdgeResolverProtocol;
  /** 图级调度器（必需，实现 GraphSchedulerProtocol） */
  readonly graphScheduler: GraphSchedulerProtocol;
  /** 图级护栏（必需，实现 GraphGuardProtocol） */
  readonly graphGuard: GraphGuardProtocol;
  /** 谓词注册表（必需，v2.0 新增，用于 decision 节点和边条件求值） */
  readonly predicateRegistry: PredicateRegistry;
  /** 经验存储（可选，Layer 3 集成时启用，Phase 4 实现） */
  readonly experienceStore?: ExperienceStoreProtocol;
  /** 日志记录器（可选，默认使用 console） */
  readonly logger?: Readonly<GraphLogger>;
}
