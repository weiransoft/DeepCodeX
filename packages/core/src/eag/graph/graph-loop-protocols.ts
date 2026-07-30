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
  /** 安全护栏配置（TOP-3） */
  GraphGuardConfig,
  /** 安全护栏自定义规则触发阶段（TOP-3） */
  GraphGuardCustomRulePhase,
  /** 安全护栏自定义规则（TOP-3） */
  GraphGuardCustomRule,
  /** 图调试事件（TOP-5） */
  GraphDebugEvent,
  /** 图调试选项（TOP-5） */
  GraphDebugOptions,
  /** 图执行快照（TOP-5） */
  GraphExecutionSnapshot,
} from "./graph-loop-models";
// Loop 节点 Handoff 回调类型（仅类型导入，避免运行期循环依赖）
import type {
  /** Loop 执行器回调 */
  LoopExecutorCallback,
  /** Loop 评估器回调 */
  LoopEvaluatorCallback,
} from "./node-loop-kernel";

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
// §8.1.1 LoopHandoffAdapter：Loop 节点 Handoff 回调适配器协议
// ============================================================================

/**
 * Loop 节点 Handoff 回调适配器协议（v2.0 新增）
 *
 * 设计目的：
 * - 将 NodeLoopKernel 所需的 executor / evaluator 回调构造逻辑从 NodeExecutorImpl 中解耦，
 *   使 NodeExecutorImpl 不直接依赖 LLM 客户端、测试框架或具体业务实现。
 * - 调用方（如 CLI 层或测试）注入真实适配器，由适配器根据节点定义、输入数据和图上下文
 *   决定如何生成 Loop 的 Handoff 执行回调和 Verification 评估回调。
 * - 便于单元测试：测试可注入固定返回值的适配器，避免依赖真实 LLM / 测试运行器。
 *
 * 实现责任：
 * - createLoopExecutor：返回一个 LoopExecutorCallback，负责在 NodeLoopKernel 的 Handoff 阶段
 *   实际执行任务（如 LLM 调用、plugin 调用、代码生成等）。
 * - createLoopEvaluator：返回一个 LoopEvaluatorCallback，负责在 NodeLoopKernel 的 Verification
 *   阶段验证 executor 产出（如运行测试、lint 检查、契约校验等）。
 *
 * 调用契约：
 * - 调用方：NodeExecutorImpl（执行 loop 节点前）
 * - 输入：node（loop 节点定义）+ input（边解析后的输入数据）+ context（图运行上下文）
 * - 输出：构造好的 LoopExecutorCallback / LoopEvaluatorCallback
 * - 副作用：无（回调本身可在运行期产生副作用，但适配器构造过程应为纯函数）
 */
export interface LoopHandoffAdapter {
  /**
   * 构造 Loop 执行器回调（Handoff 阶段调用）
   *
   * @param node 当前 loop 节点定义（含 loopConfig / task / inputContract / outputContract）
   * @param input 节点输入数据（来自 EdgeResolver，符合 inputContract）
   * @param context 图运行上下文（含全局状态、取消信号、谓词注册表等）
   * @returns Loop 执行器回调
   */
  createLoopExecutor(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): LoopExecutorCallback;

  /**
   * 构造 Loop 评估器回调（Verification 阶段调用）
   *
   * @param node 当前 loop 节点定义
   * @param input 节点输入数据
   * @param context 图运行上下文
   * @returns Loop 评估器回调
   */
  createLoopEvaluator(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): LoopEvaluatorCallback;
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

  /**
   * 配置护栏行为（TOP-3 安全护栏可配置化）
   *
   * 运行时动态更新护栏检查开关与自定义规则注册表。
   * 默认所有检查开启，调用方可选择关闭特定检查以适配特殊场景。
   *
   * @param config 安全护栏配置（GraphGuardConfig 类型定义见 graph-loop-models.ts）
   */
  configure(config: Readonly<GraphGuardConfig>): void;

  /**
   * 注册自定义校验规则（TOP-3 安全护栏可配置化）
   *
   * 自定义规则在指定 phase 触发：
   * - "validate"：图结构校验阶段（validateGraph 调用时）
   * - "pre"：节点执行前阶段（checkPreExecution 调用时）
   * - "post"：节点执行后阶段（checkPostExecution 调用时）
   *
   * 自定义规则执行异常时，护栏将其作为 error 级别处理，建议动作 stop_failure。
   *
   * @param ruleId 规则唯一标识（重复注册覆盖旧规则）
   * @param phase 规则触发阶段
   * @param rule 自定义校验函数
   */
  registerCustomRule(ruleId: string, phase: GraphGuardCustomRulePhase, rule: GraphGuardCustomRule): void;
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
// §13.6.2 NodeExperienceUploader：节点经验上送协议（多角色评审共识 B-3）
// ============================================================================
//
// 设计目的（对齐 §13.6.2）：
// - 解耦 GraphLoopOrchestrator 与 eag/p5 模块（架构约束：eag/graph 禁止依赖 eag/p5）
// - 允许调用方自定义经验来源（如从 loopReport 提取，或从外部 NotesMemory 提取）
// - 便于单元测试注入真实闭包实现（项目规则：不使用 mock 框架）
//
// 实现责任：
// - 从 nodeResult.loopReport.events 提取成功/失败事件 → GraphExperienceEntry
// - 从 nodeResult.loopReport 中提取决策事件 → BulletinEntry
// - 从 nodeResult.output 提取摘要 → NodeSummary
// - 将上述条目写入 context.globalState 的 GraphGlobalContext 字段
// - 仅 status="completed" 的节点经验持久化到 ExperienceStore（由实现方注入）
//
// 默认实现：DefaultNodeExperienceUploader（在 graph-context-helpers.ts 中提供）
// ============================================================================

/**
 * 节点经验上送协议（对齐 §13.6.2）
 *
 * 由外部注入实现（如调用方封装 P5NotesMemory + ExperienceStore 的组合），
 * GraphLoopOrchestrator 仅调用此协议，不直接依赖 eag/p5 或具体的 ExperienceStore 实现。
 */
export interface NodeExperienceUploader {
  /**
   * 上送节点执行经验到全局上下文
   *
   * 副作用：
   * - 写入 context.globalState.collectedExperiences（新增经验条目）
   * - 写入 context.globalState.bulletinBoard（新增动向通知）
   * - 写入 context.globalState.nodeSummaries（新增节点摘要）
   * - 更新 context.globalState.lastUpdatedAt
   * - 若注入了 ExperienceStore，将 completed 节点经验持久化
   *
   * @param nodeId 节点 ID
   * @param nodeResult 节点执行结果（含 loopReport，从中提取经验）
   * @param context 图运行上下文（写入 globalState 的 GraphGlobalContext 字段）
   * @returns 无返回值，所有副作用通过 context.globalState 体现
   */
  uploadExperiences(nodeId: string, nodeResult: GraphNodeResult, context: GraphRunContext): Promise<void>;
}

// ============================================================================
// §13.9.1 DualLayerContextManagerProtocol：双层上下文管理器协议（Layer 2 滑动窗口）
// ============================================================================
//
// 设计目的（对齐 §13.13.2 B-2 共识）：
// - 定义此协议接口而非直接依赖 DualLayerContextManager 具体类
// - 避免 eag/graph/graph-loop-protocols.ts 依赖 v2/context 模块（保持 protocols.ts 纯净）
// - DualLayerContextManager（v2/context/dual-layer-manager.ts）通过结构化类型匹配实现此协议
// - buildOptimizedContext 第三参数 options 扩展（graphGlobalContext / currentNodeId / maxTokens）
//   使 Layer 2 滑动窗口能感知图级全局上下文，实现三层上下文有机集成
// ============================================================================

/**
 * 双层上下文管理器协议（Layer 2 滑动窗口，对齐 §13.9.1）
 *
 * DualLayerContextManager 实现此协议（结构化类型匹配，无需 implements 关键字）。
 * GraphLoopOrchestrator 通过此协议调用 buildOptimizedContext，不感知具体实现。
 */
export interface DualLayerContextManagerProtocol {
  /**
   * 构建优化上下文（Layer 2 滑动窗口）
   *
   * 集成图级片段（对齐 §13.8）：
   * - 当 options.graphGlobalContext 和 options.currentNodeId 提供时，
   *   调用 collectGraphContextSnippets 收集图级片段
   * - 图级片段分两条通道：
   *   - directRetain（必注入）：project_goal / shared_artifact
   *   - scoringCandidates（参与评分）：node_summary / experience / bulletin
   * - 超过 GRAPH_SNIPPET_TOKEN_BUDGET 时按 relevance 降序截断（project_goal 永不丢弃）
   *
   * @param userId 用户 ID
   * @param taskId 任务 ID
   * @param options 扩展选项（graphGlobalContext / currentNodeId / maxTokens）
   * @returns 优化后的上下文片段数组
   */
  buildOptimizedContext(
    userId: string,
    taskId: string,
    options?: {
      /** Token 预算上限（可选） */
      maxTokens?: number;
      /** 图级全局上下文（unknown 类型，避免反向依赖，类型断言在 v2/context 侧完成） */
      graphGlobalContext?: unknown;
      /** 当前节点 ID（用于排除自身经验） */
      currentNodeId?: string;
    }
  ): Promise<ReadonlyArray<unknown>>;
}

// ============================================================================
// §7.6 GraphDebuggerProtocol：图调试器协议（TOP-5）
// ============================================================================

/**
 * 图调试器协议（TOP-5 图调试工具与运行时文档）
 *
 * 提供图执行过程的旁路观测能力，支持执行追踪日志、执行快照和运行时配置。
 * 调试器与现有 GraphLogger 完全独立：GraphLogger 用于业务日志输出，
 * GraphDebuggerProtocol 用于结构化调试事件收集与快照生成。
 *
 * 设计约束：
 * - 所有方法参数和返回类型遵循不可变优先原则（Readonly<T>）
 * - 实现类必须保证自身异常不中断主流程（编排器通过 safeTrace 二次保护）
 * - 调试器应支持跨运行隔离：每次 run() 前调用 reset(runId) 清空上一运行事件
 * - 默认注入 NoOpDebugger，未启用调试时零开销
 */
export interface GraphDebuggerProtocol {
  /**
   * 配置调试器选项
   *
   * 运行时动态更新调试行为。logLevel="off" 时停止生成事件。
   * 调用方传入的 options 会被实现类冻结后保存。
   *
   * @param options 调试选项（logLevel / includeNodeSnapshots / includeGuardPassedEvents / maxEvents）
   */
  configure(options: Readonly<GraphDebugOptions>): void;

  /**
   * 重置调试器状态以开始新的图运行
   *
   * 在 GraphLoopOrchestrator.run() 开始时调用，确保上一运行的事件不会串扰到本次快照。
   * 实现类应清空内部事件缓冲，并记录当前 runId。
   *
   * @param runId 新的运行 ID
   */
  reset(runId: string): void;

  /**
   * 追踪节点开始执行
   *
   * @param node 当前节点定义
   * @param input 节点输入数据（已通过 EdgeResolver 解析）
   * @param context 图运行上下文
   */
  traceNodeStart(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 追踪节点执行完成
   *
   * @param node 当前节点定义
   * @param result 节点执行结果
   * @param context 图运行上下文
   */
  traceNodeComplete(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 追踪 fork 节点并行派发开始
   *
   * @param forkNode fork 节点定义
   * @param branchNodeIds 分支节点 ID 列表
   * @param context 图运行上下文
   */
  traceForkStart(
    forkNode: Readonly<GraphNodeDef>,
    branchNodeIds: ReadonlyArray<string>,
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 追踪 fork 节点并行派发完成
   *
   * @param forkNode fork 节点定义
   * @param branchResults 各分支执行结果
   * @param context 图运行上下文
   */
  traceForkComplete(
    forkNode: Readonly<GraphNodeDef>,
    branchResults: ReadonlyArray<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 追踪 merge 节点汇聚上游结果
   *
   * @param mergeNode merge 节点定义
   * @param upstreamResults 上游节点结果列表
   * @param context 图运行上下文
   */
  traceMerge(
    mergeNode: Readonly<GraphNodeDef>,
    upstreamResults: ReadonlyArray<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 追踪节点失败
   *
   * 在节点执行失败（status=failed）时调用，与 traceNodeComplete 配套使用。
   * 失败原因、重试次数等信息从 result 中读取。
   *
   * @param node 失败节点定义
   * @param result 节点执行结果（status 必为 failed）
   * @param context 图运行上下文
   */
  traceFailure(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 追踪护栏检查结果
   *
   * @param node 关联节点（validate 阶段为图级事件，可传 undefined）
   * @param guardResult 护栏检查结果
   * @param phase 护栏触发阶段
   * @param context 图运行上下文
   */
  traceGuard(
    node: Readonly<GraphNodeDef> | undefined,
    guardResult: Readonly<GraphGuardCheckResult>,
    phase: "pre" | "post" | "validate",
    context: Readonly<GraphRunContext>
  ): void;

  /**
   * 获取当前执行快照
   *
   * 返回对象经深拷贝并冻结，调用方无法修改内部事件缓冲。
   * 若当前无运行（未调用 reset），返回空事件列表。
   *
   * @returns 不可变的图执行快照
   */
  getExecutionSnapshot(): GraphExecutionSnapshot;
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
  /**
   * 节点经验上送器（可选，对齐 §13.6.2 多角色评审共识 B-3）
   *
   * 未注入时跳过经验上送，降级为无图级上下文积累。
   * 默认实现：DefaultNodeExperienceUploader（graph-context-helpers.ts）。
   */
  readonly experienceUploader?: NodeExperienceUploader;
  /**
   * 双层上下文管理器（可选，对齐 §13.9.1 多角色评审共识 B-6）
   *
   * V2-Graph 集成时启用 Layer 2 滑动窗口。
   * 未注入时降级为无优化上下文（不调用 buildOptimizedContext）。
   * DualLayerContextManager（v2/context）通过结构化类型匹配实现 DualLayerContextManagerProtocol。
   */
  readonly dualLayerManager?: DualLayerContextManagerProtocol;
  /**
   * 当前用户 ID（可选，对齐 §13.9.1）
   *
   * dualLayerManager 启用时必填，用于 buildOptimizedContext 的用户级上下文隔离。
   * 未提供时跳过 buildOptimizedContext 调用（降级）。
   */
  readonly userId?: string;
  /**
   * 项目根目录（可选，对齐 §13.9.1 多角色评审共识 v3）
   *
   * 用于 initializeGraphGlobalContext 注入到 GraphGlobalContext.projectRoot，
   * 供节点执行器在需要时定位文件读写路径。
   * 未注入时 projectRoot 字段为 undefined，不影响图执行。
   */
  readonly projectRoot?: string;
  /**
   * 图调试器（可选，TOP-5）
   *
   * 未注入时默认使用 NoOpDebugger，保证零开销和向后兼容。
   * 注入后 GraphLoopOrchestrator 会在 run() 开始时调用 debugger.reset(runId)，
   * 并在节点执行、fork/merge、guard、失败等关键路径调用对应 trace 方法。
   */
  readonly debugger?: GraphDebuggerProtocol;
  /** 日志记录器（可选，默认使用 console） */
  readonly logger?: Readonly<GraphLogger>;
}
