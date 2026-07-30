/**
 * Loop-Graph 融合架构模块导出（v2.0）
 *
 * 本文件是 eag/graph 模块的统一出口，聚合导出所有公共 API。
 *
 * 模块结构：
 * - graph-loop-models.ts：核心数据模型（WorkGraph / GraphNodeDef / GraphRunContext 等）
 * - graph-loop-protocols.ts：协议接口（NodeExecutorProtocol / EdgeResolverProtocol 等）
 * - graph-builder.ts：图定义构造器（GraphBuilder）
 * - graph-edge-resolver.ts：边解析器（EdgeResolverImpl）
 * - graph-guard.ts：图级护栏（GraphGuardImpl）
 * - graph-scheduler.ts：图级调度器（GraphSchedulerImpl）
 * - node-loop-kernel.ts：节点内循环内核（NodeLoopKernel）
 * - node-executor.ts：节点执行器实现（NodeExecutorImpl）
 * - predicate-registry.ts：谓词注册表（PredicateRegistryImpl）
 * - graph-loop-orchestrator.ts：图级编排器（GraphLoopOrchestrator）
 *
 * 依赖方向（单向，无循环）：
 * - graph/ → loop/（复用 LoopScheduler 和数据模型）
 * - graph/ → p5/（可选集成，Phase 5）
 *
 * @module eag/graph
 */

// ============================================================================
// 核心数据模型（graph-loop-models.ts）
// ============================================================================

export type {
  /** 图节点类型 */
  GraphNodeType,
  /** 谓词函数类型 */
  PredicateFunction,
  /** 工作图定义 */
  WorkGraph,
  /** 图级配置 */
  WorkGraphConfig,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 图节点定义 */
  GraphNodeDef,
  /** 图边定义 */
  GraphEdgeDef,
  /** 节点内 Loop 配置 */
  NodeLoopConfig,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行报告 */
  GraphRunReport,
  /** 谓词注册表接口 */
  PredicateRegistry,
  /** 图日志记录器接口 */
  GraphLogger,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图结构校验结果 */
  GraphValidationResult,
  /** 图级调度动作 */
  GraphSchedulingAction,
  /** 图级调度决策 */
  GraphSchedulingDecision,
  /** 图级护栏检查结果 */
  GraphGuardCheckResult,
  /** 图级护栏记录 */
  GraphGuardRecord,
  /** 图运行状态快照 */
  GraphRunStatus,
  /** 经验案例 */
  ExperienceCase,
  /** 双层重试抑制配置 */
  RetrySuppressionConfig,
} from "./graph-loop-models";

export {
  /** 支持的图节点类型列表 */
  GRAPH_NODE_TYPES,
  /** 支持的图级调度动作列表 */
  GRAPH_SCHEDULING_ACTIONS,
  /** 默认图级配置 */
  DEFAULT_WORK_GRAPH_CONFIG,
  /** 默认节点内 Loop 配置 */
  DEFAULT_NODE_LOOP_CONFIG,
  /** 创建双层重试抑制配置（工厂函数） */
  createRetrySuppressionConfig,
} from "./graph-loop-models";

// ============================================================================
// 协议接口（graph-loop-protocols.ts）
// ============================================================================

export type {
  /** 节点执行器协议 */
  NodeExecutorProtocol,
  /** Loop 节点 Handoff 回调适配器协议 */
  LoopHandoffAdapter,
  /** 边解析器协议 */
  EdgeResolverProtocol,
  /** 图级护栏协议 */
  GraphGuardProtocol,
  /** 图级调度器协议 */
  GraphSchedulerProtocol,
  /** 经验存储协议 */
  ExperienceStoreProtocol,
  /** 节点经验上送协议 */
  NodeExperienceUploader,
  /** 双层上下文管理器协议 */
  DualLayerContextManagerProtocol,
  /** 图调试器协议 */
  GraphDebuggerProtocol,
  /** 编排器构造选项 */
  GraphLoopOrchestratorOptions,
} from "./graph-loop-protocols";

// ============================================================================
// 图定义构造器（graph-builder.ts）
// ============================================================================

export type {
  /** 工作图 JSON 表示 */
  WorkGraphJson,
  /** 图节点定义 JSON 表示 */
  GraphNodeDefJson,
  /** 图边定义 JSON 表示 */
  GraphEdgeDefJson,
} from "./graph-builder";

export {
  /** 图定义构造器（链式 API + fromJson） */
  GraphBuilder,
} from "./graph-builder";

// ============================================================================
// 边解析器（graph-edge-resolver.ts）
// ============================================================================

export {
  /** 边解析器实现类 */
  EdgeResolverImpl,
  /** 创建边解析器实例（工厂函数） */
  createEdgeResolver,
} from "./graph-edge-resolver";

// ============================================================================
// 图级护栏（graph-guard.ts）
// ============================================================================

export {
  /** 图级护栏实现类 */
  GraphGuardImpl,
  /** 创建图级护栏实例（工厂函数） */
  createGraphGuard,
} from "./graph-guard";

// ============================================================================
// 图级调度器（graph-scheduler.ts）
// ============================================================================

export {
  /** 图级调度器实现类 */
  GraphSchedulerImpl,
  /** 创建图级调度器实例（工厂函数） */
  createGraphScheduler,
} from "./graph-scheduler";

// ============================================================================
// 节点内循环内核（node-loop-kernel.ts）
// ============================================================================

export type {
  /** Loop 执行器回调类型 */
  LoopExecutorCallback,
  /** Loop 评估器回调类型 */
  LoopEvaluatorCallback,
  /** NodeLoopKernel 构造选项 */
  NodeLoopKernelOptions,
} from "./node-loop-kernel";

export {
  /** 节点内循环内核实现类 */
  NodeLoopKernel,
} from "./node-loop-kernel";

// ============================================================================
// 节点执行器（node-executor.ts）
// ============================================================================

export type {
  /** 节点执行器实现类构造选项 */
  NodeExecutorImplOptions,
} from "./node-executor";

export {
  /** 节点执行器实现类 */
  NodeExecutorImpl,
  /** 创建节点执行器实例（工厂函数） */
  createNodeExecutor,
} from "./node-executor";

// ============================================================================
// 谓词注册表（predicate-registry.ts）
// ============================================================================

export {
  /** 谓词注册表实现类 */
  PredicateRegistryImpl,
  /** 创建谓词注册表实例（工厂函数） */
  createPredicateRegistry,
} from "./predicate-registry";

// ============================================================================
// 图级编排器（graph-loop-orchestrator.ts）
// ============================================================================

export {
  /** 图级编排器实现类 */
  GraphLoopOrchestrator,
} from "./graph-loop-orchestrator";

// ============================================================================
// 经验存储（experience-store.ts）
// ============================================================================

export {
  /** 经验存储实现类 */
  ExperienceStoreImpl,
  /** 创建经验存储实例（工厂函数） */
  createExperienceStore,
  /** 计算任务特征相似度（加权 Jaccard + 归一化欧氏距离） */
  computeSimilarity,
} from "./experience-store";

// ============================================================================
// 图生命周期管理器（graph-lifecycle-manager.ts / graph-lifecycle-models.ts）
// ============================================================================

export type {
  /** 图生命周期状态 */
  GraphLifecycleState,
  /** 图生命周期状态变更事件 */
  GraphLifecycleStateChangeEvent,
  /** 图生命周期状态变更监听器 */
  GraphLifecycleStateChangeListener,
  /** 图生命周期管理器协议 */
  GraphLifecycleManagerProtocol,
} from "./graph-lifecycle-models";

export {
  /** 图生命周期状态机全部合法值 */
  GRAPH_LIFECYCLE_STATES,
} from "./graph-lifecycle-models";

export {
  /** 图生命周期管理器实现类 */
  GraphLifecycleManager,
} from "./graph-lifecycle-manager";
