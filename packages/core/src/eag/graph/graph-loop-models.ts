/**
 * Loop-Graph 融合架构核心数据模型（v2.0 实现）
 *
 * 本模块定义 Loop-Graph 融合方案所需的全部结构化数据类型，对应设计文档：
 * - §7 核心数据模型（WorkGraph / GraphNodeDef / GraphEdgeDef / NodeLoopConfig / GraphRunReport / GraphNodeResult）
 * - §7.6 支持类型（GraphRunContext / GraphValidationResult / GraphGuardCheckResult / GraphGuardRecord /
 *   GraphRunStatus / ExperienceCase / PredicateRegistry / GraphLogger）
 * - §11.2 图级调度动作（GraphSchedulingAction / GraphSchedulingDecision）
 * - §11.4 双层重试抑制配置（RetrySuppressionConfig）
 *
 * 设计原则（对齐设计文档 §12.2 单向依赖）：
 * - 严格单向依赖：eag/graph/ → eag/loop/（仅复用 LoopScheduler + 数据模型）
 * - 禁止反向依赖：eag/loop/ 不得 import eag/graph/
 * - 禁止依赖 eag/p5/（Phase 2 不涉及 P5 集成）
 * - 不可变优先：所有 interface 字段声明为 readonly，运行期不可修改
 * - 协议与数据分离：本文件只定义"数据形状"，行为协议接口定义在 graph-loop-protocols.ts
 *
 * 安全原则（v2.0 修订）：
 * - 所有条件逻辑通过 PredicateRegistry 注册的谓词函数实现，禁止使用 `fn:` 表达式语法（RCE 风险）
 * - decision 节点通过 decisionPredicateId 引用谓词函数，边通过 activationPredicateId 引用谓词函数
 *
 * @module eag/graph/graph-loop-models
 */

// ============================================================================
// 类型导入（严格 type-only，避免运行期循环依赖）
// ============================================================================

import type {
  /** 业务 Loop 类型（design / coding / testing / deploy） */
  LoopType,
  /** Discovery 阶段工作模式（auto / manual / off） */
  DiscoveryMode,
  /** Evaluator 严格程度（strict / standard / off） */
  EvaluatorMode,
  /** 完整 Loop Engineering 运行的最终报告 */
  LoopRunReport,
} from "../loop/models";

// ============================================================================
// §7.2 节点类型与谓词函数
// ============================================================================

/**
 * 图节点类型枚举
 *
 * 对齐设计文档 §7.2：
 * - loop：包含五步闭环的复杂节点（使用 NodeLoopKernel 执行 Discovery→Handoff→Verification→Persistence→Scheduling）
 * - task：简单执行节点（直接调用已注册的 team plugin，不包含 Loop）
 * - decision：条件路由节点（通过 PredicateRegistry 中注册的谓词函数选择下游分支）
 * - merge：汇聚节点（等待多个上游边全部完成后合并结果）
 * - fork：并行派发节点（fan-out 到多个下游，受 maxParallelism 限制）
 * - end：终止节点（图遍历到此结束）
 */
export type GraphNodeType = "loop" | "task" | "decision" | "merge" | "fork" | "end";

/** GraphNodeType 全部合法值（用于运行时枚举与测试断言） */
export const GRAPH_NODE_TYPES: ReadonlyArray<GraphNodeType> = Object.freeze([
  "loop",
  "task",
  "decision",
  "merge",
  "fork",
  "end",
]);

/**
 * 谓词函数签名（v2.0 新增）
 *
 * 用于 decision 节点的分支选择和边的条件激活。
 * 禁止使用字符串表达式求值（消除 RCE 风险）。
 *
 * @param input 当前节点输入数据（已通过 EdgeResolver 解析边契约后得到）
 * @param context 图运行上下文（含全局状态、历史结果、谓词注册表引用等）
 * @returns 谓词求值结果：
 *          - decision 节点使用时，返回选中的下游边 ID（必须在 GraphEdgeDef 中定义且 from=当前节点）
 *          - 边条件激活使用时，返回 boolean（true 表示激活该边）
 */
export type PredicateFunction = (
  input: Readonly<Record<string, unknown>>,
  context: Readonly<GraphRunContext>
) => string | boolean;

// ============================================================================
// §7.1 WorkGraph：工作图定义
// ============================================================================

/**
 * 工作图定义（Layer 2 核心数据结构）
 *
 * 一个 WorkGraph 描述了一次复杂任务的完整拓扑结构：
 * - nodes：图中的所有节点（按 ID 索引，每个节点可包含一个 Loop）
 * - edges：图中的所有边（描述数据依赖和路由条件，edges 是节点间拓扑关系的单一数据源）
 * - entryNodeId：入口节点 ID（图遍历从此节点开始）
 * - globalState：图级共享状态（所有节点可读写，通过 GraphRunContext 在运行时传递）
 *
 * v2.0 修订要点：
 * - 移除了节点上的 `next` 字段，节点间拓扑关系只通过 GraphEdgeDef 表达
 * - 移除了 `condition` 字符串字段，改为 `decisionPredicateId` 引用 PredicateRegistry
 * - 所有字段 readonly，运行期不可变（构造时通过 createWorkGraph 工厂函数冻结）
 */
export interface WorkGraph {
  /** 图唯一标识 */
  readonly graphId: string;
  /** 图名称（人类可读） */
  readonly name: string;
  /** 图描述 */
  readonly description: string;
  /** 图中所有节点（按节点 ID 索引） */
  readonly nodes: ReadonlyMap<string, GraphNodeDef>;
  /** 图中所有边（节点间拓扑关系的单一数据源） */
  readonly edges: ReadonlyArray<GraphEdgeDef>;
  /** 入口节点 ID（必须存在于 nodes 中） */
  readonly entryNodeId: string;
  /** 图级共享状态（只读快照，运行时通过 GraphRunContext.globalState 读写） */
  readonly globalState: Readonly<Record<string, unknown>>;
  /** 图级配置 */
  readonly config: Readonly<WorkGraphConfig>;
}

/**
 * 图级配置
 *
 * 控制图遍历的全局上限与开关，所有字段在构造时冻结，运行期不可修改。
 * 对应设计文档 §7.1 WorkGraphConfig。
 */
export interface WorkGraphConfig {
  /** 最大遍历深度（防死循环，默认 100） */
  readonly maxDepth: number;
  /** 最大并行度（fan-out 并发上限，默认 4） */
  readonly maxParallelism: number;
  /** 图级 token 预算（所有节点 token 总和上限，0 表示不限制） */
  readonly maxTokens: number;
  /** 图级超时（秒，0 表示不限制） */
  readonly timeoutSec: number;
  /** 是否启用经验召回（Layer 3 集成时启用） */
  readonly enableExperienceRecall: boolean;
  /** 是否启用节点失败自动隔离（true 时 retryCount 超限后标记 isolated，false 时 STOP_FAILURE） */
  readonly enableAutoIsolation: boolean;
  /** 节点失败重试次数（图级，区别于 Loop 级的 consecutiveFailures） */
  readonly nodeRetryLimit: number;
}

/**
 * 默认图级配置
 *
 * 数值依据（对齐设计文档 §7.1 默认值）：
 * - maxDepth=100：防止深度过大导致死循环
 * - maxParallelism=4：fan-out 默认并发上限（保守值，避免资源争抢）
 * - maxTokens=0：默认不限制 token（由节点级 maxTokens 控制）
 * - timeoutSec=0：默认不限制超时（由调用方按需配置）
 * - enableExperienceRecall=false：Phase 2 不启用经验召回（Phase 4 集成时开启）
 * - enableAutoIsolation=true：默认开启自动隔离，提高图执行容错性
 * - nodeRetryLimit=3：单个节点最多重试 3 次（与 §11.4 双层重试抑制配合）
 */
export const DEFAULT_WORK_GRAPH_CONFIG: Readonly<WorkGraphConfig> = Object.freeze({
  maxDepth: 100,
  maxParallelism: 4,
  maxTokens: 0,
  timeoutSec: 0,
  enableExperienceRecall: false,
  enableAutoIsolation: true,
  nodeRetryLimit: 3,
});

// ============================================================================
// §7.2 GraphNodeDef：节点定义（含契约）
// ============================================================================

/**
 * 图节点字段契约（输入/输出契约的字段定义）
 *
 * 对齐设计文档 §7.2 NodeFieldContract，用于声明节点输入/输出数据的字段规范，
 * 供 EdgeResolver 在解析边契约时进行字段映射与类型校验。
 */
export interface NodeFieldContract {
  /** 字段名 */
  readonly name: string;
  /** 字段类型（string/number/boolean/object/array/any） */
  readonly type: "string" | "number" | "boolean" | "object" | "array" | "any";
  /** 是否必需（required=true 时 EdgeResolver 必须能解析出该字段，否则校验失败） */
  readonly required: boolean;
  /** 默认值（required=false 时使用，未提供时取此值） */
  readonly defaultValue?: unknown;
  /** 字段描述（人类可读） */
  readonly description?: string;
}

/**
 * 图节点定义（增强版，包含 Node Contract）
 *
 * 对齐设计文档 §7.2，每个节点声明输入契约、输出契约和任务定义。
 *
 * v2.0 修订：
 * - 移除 `next` 字段：节点间拓扑关系只通过 GraphEdgeDef 表达（edges 为单一数据源）
 * - 移除 `condition` 字符串字段：改为 `decisionPredicateId` 引用 PredicateRegistry 中注册的谓词函数
 *
 * 节点类型分流（由 NodeExecutor 协议实现负责）：
 * - loop：创建 NodeLoopKernel 执行五步闭环
 * - task：直接调用关联 plugin
 * - decision：调用 PredicateRegistry 中注册的谓词函数选择下游分支
 * - merge：等待上游完成并合并结果
 * - fork：并行派发到多个下游（通过 Promise.all）
 * - end：终止图遍历
 */
export interface GraphNodeDef {
  /** 节点唯一 ID（在图中必须唯一） */
  readonly nodeId: string;
  /** 节点类型 */
  readonly nodeType: GraphNodeType;
  /** 节点标签（人类可读） */
  readonly label: string;
  /** 任务描述（该节点要完成什么工作，loop 节点会作为 Loop 的 objective） */
  readonly task: string;
  /** 输入契约：声明需要的输入数据字段及其类型（EdgeResolver 按此校验输入） */
  readonly inputContract: ReadonlyArray<NodeFieldContract>;
  /** 输出契约：声明产出的输出数据字段及其类型（供下游边的 dataMapping 引用） */
  readonly outputContract: ReadonlyArray<NodeFieldContract>;
  /**
   * Loop 配置（仅 nodeType="loop" 时有效）
   *
   * 当此字段存在时，节点内部创建 NodeLoopKernel 执行五步闭环；
   * 当此字段不存在时，节点直接执行 task（简单模式）。
   */
  readonly loopConfig?: Readonly<NodeLoopConfig>;
  /**
   * 关联的 plugin 名（仅 nodeType="task" 时有效）
   *
   * 用于直接调用已注册的 team plugin（如 autonomous / multi-goal / graph / loop 等）。
   */
  readonly plugin?: string;
  /**
   * 决策谓词 ID（仅 nodeType="decision" 时有效，v2.0 修订）
   *
   * 引用 PredicateRegistry 中注册的谓词函数 ID。
   * 谓词函数签名：(input: Record<string, unknown>, context: GraphRunContext) => string | boolean
   * 返回值：选中的下游边 ID（必须在 GraphEdgeDef 中定义且 from=当前节点）
   *
   * 安全约束：禁止使用 `fn:` 表达式语法（RCE 风险），所有条件逻辑必须通过谓词函数实现。
   */
  readonly decisionPredicateId?: string;
  /** 节点级配置覆盖（合并到 GraphRunContext 供节点执行器读取） */
  readonly overrides?: Readonly<Record<string, unknown>>;
  /** 节点描述（人类可读，可选） */
  readonly description?: string;
}

// ============================================================================
// §7.3 GraphEdgeDef：边定义（含契约）
// ============================================================================

/**
 * 图边定义（增强版，包含 Edge Contract）
 *
 * 对齐设计文档 §7.3，边不仅表示"从 A 到 B"的顺序，
 * 还描述数据如何从源节点传递到目标节点（通过 dataMapping）。
 *
 * v2.0 修订：
 * - 移除 `condition` 字符串字段和 `fn:` 表达式语法（RCE 风险）
 * - 所有条件逻辑通过 `activationPredicateId` 引用 PredicateRegistry 中注册的谓词函数实现
 *
 * 拓扑关系单一数据源：
 * - 节点的下游通过 `edges.filter(e => e.from === nodeId)` 查询
 * - 节点的上游通过 `edges.filter(e => e.to === nodeId)` 查询
 * - decision 节点的分支选择结果就是某条边的 edgeId
 */
export interface GraphEdgeDef {
  /** 边唯一标识（在图中必须唯一） */
  readonly edgeId: string;
  /** 源节点 ID（必须存在于 WorkGraph.nodes） */
  readonly from: string;
  /** 目标节点 ID（必须存在于 WorkGraph.nodes） */
  readonly to: string;
  /**
   * 数据映射（Edge Contract 核心）
   *
   * key = 目标节点的输入字段名
   * value = 源节点的输出字段名（支持点号路径，如 "output.designDoc"）
   *
   * 示例：{ "designDoc": "output.designDoc", "apiSpec": "output.apiSpec" }
   * 表示将源节点的 output.designDoc 映射到目标节点的 input.designDoc
   *
   * EdgeResolver 在解析时按目标节点的 inputContract 校验字段类型与必填性。
   */
  readonly dataMapping: Readonly<Record<string, string>>;
  /**
   * 边激活谓词 ID（可选，v2.0 修订）
   *
   * 引用 PredicateRegistry 中注册的谓词函数 ID。
   * 仅当谓词求值为 true 时，边才被激活（被 GraphScheduler 选为下游分支）。
   * 用于实现条件路由（配合 decision 节点使用）。
   *
   * 安全约束：禁止使用 `condition` 字符串字段和 `fn:` 表达式语法（RCE 风险）。
   */
  readonly activationPredicateId?: string;
  /** 边描述（人类可读，可选） */
  readonly description?: string;
}

// ============================================================================
// §7.4 NodeLoopConfig：节点内 Loop 配置
// ============================================================================

/**
 * 节点内 Loop 配置
 *
 * 当 GraphNodeDef.loopConfig 存在时，节点内部创建 NodeLoopKernel。
 * 此配置是对 LoopEngineeringConfig 的简化包装，仅保留图级场景需要的字段，
 * 完整的 LoopEngineeringConfig 由 NodeLoopKernel 在构造时补全（如 projectRoot / runDir 等）。
 *
 * 字段说明（对齐设计文档 §7.4）：
 * - loopType / discoveryMode / evaluatorMode：复用 eag/loop/models 的类型定义
 * - maxIterations / maxTokens：节点级上限，覆盖图级配置
 * - stopWhen：自然语言停止条件，供 LoopScheduler 参考
 * - stageOrder：编码 Loop 内部阶段顺序（默认 ["plan","dev","verify","fix"]）
 * - autoCommit：验证通过后是否自动 git commit
 * - humanCheckpointEvery：每 N 轮触发人类检查点（0=关闭）
 */
export interface NodeLoopConfig {
  /** Loop 类型（design / coding / testing / deploy） */
  readonly loopType: LoopType;
  /** Discovery 模式（auto / manual / off） */
  readonly discoveryMode: DiscoveryMode;
  /** Evaluator 模式（strict / standard / off） */
  readonly evaluatorMode: EvaluatorMode;
  /** 节点级最大迭代次数（覆盖图级配置，必须 >= 1） */
  readonly maxIterations: number;
  /** 节点级最大 token 预算（必须 >= 1） */
  readonly maxTokens: number;
  /** 自然语言停止条件（空字符串表示无显式停止条件） */
  readonly stopWhen: string;
  /** 阶段顺序（编码 Loop 用，默认 ["plan","dev","verify","fix"]） */
  readonly stageOrder: ReadonlyArray<string>;
  /** 是否自动提交（验证通过后自动 git commit） */
  readonly autoCommit: boolean;
  /** 人工检查点频率（每 N 轮，0=关闭） */
  readonly humanCheckpointEvery: number;
}

/**
 * 默认节点内 Loop 配置
 *
 * 数值依据（对齐 eag/loop/models DEFAULT_LOOP_ENGINEERING_CONFIG）：
 * - loopType="coding"：默认走编码 Loop（最常用场景）
 * - discoveryMode="auto"：默认自动感知上下文
 * - evaluatorMode="strict"：默认 STRICT 模式（保守策略）
 * - maxIterations=10：节点级迭代上限（小于 Loop 默认 50，因为图级有多个节点串联）
 * - maxTokens=100_000：节点级 token 预算（小于 Loop 默认 500_000）
 * - stopWhen=""：无显式停止条件（依赖 maxIterations 控制）
 * - stageOrder=["plan","dev","verify","fix"]：对齐 DEFAULT_STAGE_ORDER
 * - autoCommit=false：图场景默认不自动提交（由图级编排器统一控制）
 * - humanCheckpointEvery=0：图场景默认关闭节点级人工检查点（避免阻塞图遍历）
 */
export const DEFAULT_NODE_LOOP_CONFIG: Readonly<NodeLoopConfig> = Object.freeze({
  loopType: "coding",
  discoveryMode: "auto",
  evaluatorMode: "strict",
  maxIterations: 10,
  maxTokens: 100_000,
  stopWhen: "",
  stageOrder: Object.freeze(["plan", "dev", "verify", "fix"]),
  autoCommit: false,
  humanCheckpointEvery: 0,
});

// ============================================================================
// §7.5 GraphRunReport / GraphNodeResult：图运行报告
// ============================================================================

/**
 * 单个节点的执行结果
 *
 * 对应设计文档 §7.5 GraphNodeResult，由 NodeExecutor 协议实现产出，
 * 描述一个图节点执行后的状态、输出数据、Loop 报告（如包含 Loop）和重试次数。
 *
 * status 取值：
 * - completed：节点执行成功
 * - failed：节点执行失败（failureReason 填写失败原因）
 * - skipped：节点被跳过（如上游失败导致下游不可达）
 * - isolated：节点被隔离（retryCount 超限后标记为 isolated，下游节点跳过）
 */
export interface GraphNodeResult {
  /** 节点 ID */
  readonly nodeId: string;
  /** 节点类型 */
  readonly nodeType: GraphNodeType;
  /** 执行状态（completed / failed / skipped / isolated） */
  readonly status: "completed" | "failed" | "skipped" | "isolated";
  /** 节点输出数据（符合 outputContract 声明的字段规范） */
  readonly output: Readonly<Record<string, unknown>>;
  /** 如果节点包含 Loop，记录 Loop 运行报告；否则为 undefined */
  readonly loopReport?: Readonly<LoopRunReport>;
  /** 节点 LLM 调用次数（由 NodeExecutor 累加；无 Loop 或不统计时为 undefined） */
  readonly llmCallCount?: number;
  /** 执行耗时（秒） */
  readonly durationSec: number;
  /** 失败原因（status=failed 时填写，其他状态为 undefined） */
  readonly failureReason?: string;
  /** 重试次数（图级重试计数，不含 Loop 内部迭代） */
  readonly retryCount: number;
}

/**
 * 图运行报告
 *
 * 对应设计文档 §7.5 GraphRunReport，记录一次 WorkGraph 执行的完整结果，
 * 由 GraphLoopOrchestrator.run() 产出。
 *
 * finalStatus 取值：
 * - completed：图执行成功完成（到达 end 节点）
 * - failed：图执行失败终止（如节点失败且未启用自动隔离）
 * - aborted：图执行被用户中止（GraphRunContext.cancelled=true）
 * - timeout：图执行超时（elapsedSec >= config.timeoutSec）
 */
export interface GraphRunReport {
  /** 图运行唯一标识 */
  readonly runId: string;
  /** 关联的 WorkGraph ID */
  readonly graphId: string;
  /** 最终状态（completed / failed / aborted / timeout） */
  readonly finalStatus: "completed" | "failed" | "aborted" | "timeout";
  /** 遍历路径（节点 ID 序列，按访问顺序记录） */
  readonly traversalPath: ReadonlyArray<string>;
  /** 节点执行结果（按节点 ID 索引） */
  readonly nodeResults: ReadonlyMap<string, GraphNodeResult>;
  /** 总迭代次数（所有节点的 Loop 迭代次数之和，无 Loop 节点不计入） */
  readonly totalIterations: number;
  /** 总 LLM 调用次数（所有节点 LLM 调用次数之和） */
  readonly totalLlmCallCount: number;
  /** 总 token 消耗（所有节点 token 消耗之和） */
  readonly totalTokensUsed: number;
  /** 总耗时（秒） */
  readonly durationSec: number;
  /** 触发的图级护栏记录（按触发时间顺序） */
  readonly triggeredGuards: ReadonlyArray<GraphGuardRecord>;
  /** 最终报告（Markdown 格式，人类可读） */
  readonly finalReport: string;
  /** 图级共享状态最终快照（GraphRunContext.globalState 的最终值） */
  readonly finalGlobalState: Readonly<Record<string, unknown>>;
}

// ============================================================================
// §7.6 支持类型定义
// ============================================================================

/**
 * 谓词注册表接口（v2.0 新增）
 *
 * 替代 `fn:` 表达式语法，所有条件逻辑通过注册的谓词函数实现。
 * 消除 RCE 风险，同时支持运行时动态注册。
 *
 * 实现类定义在 predicate-registry.ts（PredicateRegistryImpl），
 * 本接口仅声明协议形状，供 GraphRunContext / GraphLoopOrchestratorOptions 等类型引用。
 *
 * 使用方式：
 * ```typescript
 * const registry: PredicateRegistry = new PredicateRegistryImpl();
 * registry.register("isDesignApproved", (input, ctx) => input.approved === true);
 * // decision 节点配置 decisionPredicateId="isDesignApproved"
 * // 边配置 activationPredicateId="isDesignApproved"
 * ```
 */
export interface PredicateRegistry {
  /**
   * 注册谓词函数
   *
   * @param id 谓词 ID（在图定义中通过 decisionPredicateId / activationPredicateId 引用）
   * @param predicate 谓词函数（签名见 PredicateFunction）
   * @throws {Error} 当 id 已存在时抛出（避免覆盖）
   */
  register(id: string, predicate: PredicateFunction): void;

  /**
   * 查询谓词函数
   *
   * @param id 谓词 ID
   * @returns 谓词函数
   * @throws {Error} 当 id 未注册时抛出（避免静默失败）
   */
  lookup(id: string): PredicateFunction;

  /**
   * 检查谓词是否已注册
   *
   * @param id 谓词 ID
   * @returns 是否已注册
   */
  has(id: string): boolean;
}

/**
 * 图日志记录器接口（v2.0 补充定义）
 *
 * 为 GraphLoopOrchestrator / GraphScheduler / GraphGuard 等组件提供统一日志接口。
 * 默认实现使用 console，调用方可注入自定义日志器（如 pino / winston）。
 */
export interface GraphLogger {
  /** DEBUG 级别日志（详细诊断信息） */
  debug(message: string, context?: Record<string, unknown>): void;
  /** INFO 级别日志（正常运行信息） */
  info(message: string, context?: Record<string, unknown>): void;
  /** WARN 级别日志（潜在问题警告） */
  warn(message: string, context?: Record<string, unknown>): void;
  /** ERROR 级别日志（错误信息） */
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * 图运行上下文（v2.0 补充定义）
 *
 * 贯穿整个图执行过程的上下文对象，由 GraphLoopOrchestrator 在 run() 启动时创建，
 * 传递给 NodeExecutor / EdgeResolver / GraphGuard / GraphScheduler 等所有协作组件。
 *
 * 包含：
 * - 全局共享状态（所有节点可读写，需通过锁或串行化保证一致性）
 * - 已访问节点集合（用于环路检测）
 * - 节点执行结果历史（按节点 ID 索引，供下游节点和 EdgeResolver 查询上游输出）
 * - 取消信号（用户调用 stop() 时设置为 true，节点执行器需在循环中检查）
 * - 图级配置快照（不可变，构造时从 WorkGraph.config 复制）
 * - 谓词注册表引用（用于 decision 节点和边条件求值）
 * - 当前遍历深度（GraphScheduler 在每次决策时递增）
 * - 累计 token 消耗（节点执行器在每次 LLM 调用后累加）
 * - 图执行开始时间戳（用于计算 elapsedSec 和超时检测）
 *
 * 注意：globalState / visited / nodeResults 字段虽声明为 readonly 引用，
 * 但其内部内容是可变的（运行期需要写入），readonly 仅约束引用本身不被替换。
 */
export interface GraphRunContext {
  /** 运行唯一标识（与 GraphRunReport.runId 一致） */
  readonly runId: string;
  /** 关联的 WorkGraph ID */
  readonly graphId: string;
  /** 图级共享状态（运行时可变，所有节点可读写） */
  readonly globalState: Record<string, unknown>;
  /** 已访问节点 ID 集合（用于环路检测，运行时可变） */
  readonly visited: Set<string>;
  /** 节点执行结果历史（按节点 ID 索引，运行时可变） */
  readonly nodeResults: Map<string, GraphNodeResult>;
  /** 取消信号（true 表示用户已请求停止，节点执行器需在循环中检查此字段） */
  cancelled: boolean;
  /** 图级配置快照（不可变，构造时从 WorkGraph.config 复制） */
  readonly config: Readonly<WorkGraphConfig>;
  /** 谓词注册表引用（用于 decision 节点和边条件求值） */
  readonly predicateRegistry: Readonly<PredicateRegistry>;
  /** 当前遍历深度（GraphScheduler 在每次决策时递增，用于 maxDepth 检测） */
  currentDepth: number;
  /** 累计 token 消耗（节点执行器在每次 LLM 调用后累加，用于 maxTokens 检测） */
  totalTokensUsed: number;
  /** 图执行开始时间戳（毫秒，用于计算 elapsedSec 和超时检测） */
  readonly startedAtMs: number;
}

/**
 * 图结构校验结果（v2.0 补充定义）
 *
 * GraphGuard.validateGraph() 的返回值，描述图结构是否合法。
 * 校验项见 §8.3 GraphGuardProtocol.validateGraph 的 JSDoc。
 */
export interface GraphValidationResult {
  /** 校验是否通过（errors 为空时为 true） */
  readonly valid: boolean;
  /** 错误列表（valid=false 时填写，每条错误描述一个具体问题） */
  readonly errors: ReadonlyArray<string>;
  /** 警告列表（valid=true 但有潜在问题时填写，如不可达节点） */
  readonly warnings: ReadonlyArray<string>;
  /** 图是否包含环（用于有环图标记，对齐 §8.3 环路标记要求） */
  readonly isCyclic: boolean;
  /** 不可达节点列表（从入口无法到达的节点 ID，应作为 warnings 提示） */
  readonly unreachableNodes: ReadonlyArray<string>;
}

/**
 * 图级调度动作（v2.0 补充定义，对齐 §11.2）
 *
 * GraphScheduler.decideNext() 返回的决策动作，指导 GraphLoopOrchestrator 下一步行为。
 * - next_node：前进到下一个节点（普通成功路径）
 * - retry_node：重试当前节点（消耗 nodeRetryLimit 配额）
 * - isolate_node：隔离当前节点（标记为 isolated，跳过后续依赖）
 * - human_checkpoint：触发人类检查点（暂停图执行等待人工确认）
 * - stop_success：图执行成功完成（到达 end 节点）
 * - stop_failure：图执行失败终止（如节点失败且未启用自动隔离）
 * - stop_timeout：图执行超时终止（elapsedSec >= timeoutSec）
 */
export type GraphSchedulingAction =
  | "next_node"
  | "retry_node"
  | "isolate_node"
  | "human_checkpoint"
  | "stop_success"
  | "stop_failure"
  | "stop_timeout";

/** GraphSchedulingAction 全部合法值（用于运行时枚举与测试断言） */
export const GRAPH_SCHEDULING_ACTIONS: ReadonlyArray<GraphSchedulingAction> = Object.freeze([
  "next_node",
  "retry_node",
  "isolate_node",
  "human_checkpoint",
  "stop_success",
  "stop_failure",
  "stop_timeout",
]);

/**
 * 图级调度决策（v2.0 补充定义，对齐 §11.2）
 *
 * GraphScheduler.decideNext() 的返回值，包含动作、理由、下一节点列表、退避秒数等。
 */
export interface GraphSchedulingDecision {
  /** 决策动作 */
  readonly action: GraphSchedulingAction;
  /** 决策理由（人类可读，用于审计和调试） */
  readonly reason: string;
  /** 下一个/多个节点 ID 列表（fork 时多个，stop_* 时为空数组） */
  readonly nextNodeIds: ReadonlyArray<string>;
  /** 退避秒数（retry_node 时为正数，其他动作为 0） */
  readonly backoffSeconds: number;
  /** 是否需要人类输入（human_checkpoint 时为 true，其他为 false） */
  readonly requiresHumanInput: boolean;
}

/**
 * 图级护栏检查结果（v2.0 补充定义）
 *
 * GraphGuard.checkPreExecution() / checkPostExecution() 的返回值，
 * 描述护栏是否通过，以及不通过时的建议动作（指导 GraphScheduler 决策）。
 */
export interface GraphGuardCheckResult {
  /** 检查是否通过（passed=true 时允许继续执行） */
  readonly passed: boolean;
  /** 拦截原因（passed=false 时填写，人类可读） */
  readonly reason: string;
  /** 建议动作（passed=false 时填写，指导 GraphScheduler 决策） */
  readonly suggestedAction?: GraphSchedulingAction;
  /** 护栏严重级别（info / warning / error / fatal） */
  readonly severity: "info" | "warning" | "error" | "fatal";
}

/**
 * 安全护栏自定义规则触发阶段（TOP-3 安全护栏可配置化）
 *
 * - validate：图结构校验阶段（validateGraph 调用时触发）
 * - pre：节点执行前阶段（checkPreExecution 调用时触发）
 * - post：节点执行后阶段（checkPostExecution 调用时触发）
 */
export type GraphGuardCustomRulePhase = "validate" | "pre" | "post";

/**
 * 安全护栏自定义规则签名（TOP-3 安全护栏可配置化）
 *
 * 由调用方提供的自定义校验函数，在指定 phase 触发。
 * 返回 pass=false 时，护栏将其作为 error 级别处理，建议动作 stop_failure。
 *
 * @param graph 工作图定义（validate 阶段可用，pre/post 阶段也可读）
 * @param context 图运行上下文（pre/post 阶段可用，validate 阶段可能为 undefined）
 * @returns 校验结果：pass 表示是否通过，message 为可选失败原因
 */
export type GraphGuardCustomRule = (
  graph: Readonly<WorkGraph>,
  context?: Readonly<GraphRunContext>
) => { pass: boolean; message?: string };

/**
 * 安全护栏配置（TOP-3 安全护栏可配置化）
 *
 * 支持运行时配置 GraphGuardImpl 的校验行为，默认全部开启，保持与当前行为完全兼容。
 */
export interface GraphGuardConfig {
  /** 输出契约验证级别：strict=严格校验类型和必填性，lenient=仅校验字段存在 */
  readonly outputContractValidationLevel?: "strict" | "lenient";
  /** 是否启用 token 预算检查（默认 true） */
  readonly enableTokenBudgetCheck?: boolean;
  /** 是否启用图深度检查（默认 true） */
  readonly enableDepthCheck?: boolean;
  /** 是否启用单节点耗时检查（默认 true） */
  readonly enablePostExecutionDurationCheck?: boolean;
  /** 自定义校验规则注册表（ruleId → { phase, rule }） */
  readonly customRules?: Readonly<
    Record<string, Readonly<{ phase: GraphGuardCustomRulePhase; rule: GraphGuardCustomRule }>>
  >;
}

/**
 * 图级护栏记录（v2.0 补充定义）
 *
 * 记录一次图执行中触发的所有护栏事件，用于审计和事后分析。
 * 由 GraphLoopOrchestrator 在每次护栏检查后追加到 GraphRunReport.triggeredGuards。
 */
export interface GraphGuardRecord {
  /** 记录唯一标识（UUID） */
  readonly recordId: string;
  /** 触发的护栏名称（如 "maxDepthGuard" / "tokenBudgetGuard" / "cycleDetectionGuard"） */
  readonly guardName: string;
  /** 触发时机（pre=执行前 / post=执行后 / validate=图校验） */
  readonly triggerPhase: "pre" | "post" | "validate";
  /** 关联节点 ID（validate 阶段为空，pre/post 阶段为对应节点 ID） */
  readonly nodeId?: string;
  /** 护栏检查结果（包含 passed / reason / suggestedAction / severity） */
  readonly result: Readonly<GraphGuardCheckResult>;
  /** 触发时间戳（ISO 字符串） */
  readonly triggeredAt: string;
}

// ============================================================================
// §7.7 图调试数据模型（TOP-5 图调试工具与运行时文档）
// ============================================================================

/**
 * 图调试事件阶段
 *
 * 描述调试事件在图执行生命周期中的触发时机：
 * - start：节点开始执行
 * - complete：节点执行完成
 * - fork：fork 节点并行派发或分支执行
 * - merge：merge 节点汇聚上游结果
 * - failure：节点执行失败（含执行异常、guard 拦截、边解析失败）
 * - guard：护栏检查（pre/post/validate）
 */
export type GraphDebugEventPhase = "start" | "complete" | "fork" | "merge" | "failure" | "guard";

/**
 * 图调试追踪级别
 *
 * - off：关闭调试事件生成与输出（等效于未注入 debugger）
 * - info：仅记录关键事件（节点完成、失败、guard 失败/警告、fork/merge 汇总）
 * - debug：记录所有节点 start/complete 和 guard 结果
 * - trace：最详细，包含输入输出快照（需 includeNodeSnapshots=true 才保留原始数据）
 */
export type GraphDebugLogLevel = "off" | "info" | "debug" | "trace";

/**
 * 图调试事件（TOP-5）
 *
 * 记录图执行过程中的一个关键观测点，用于执行追踪、快照生成和事后分析。
 * 所有字段只读，运行期由 DefaultGraphDebugger 构造并冻结后入队。
 *
 * 设计约束：
 * - 事件必须携带 runId，支持跨运行隔离和日志聚合
 * - nodeId 在 guard 的 validate 阶段可能为空（图级事件）
 * - metadata 中不会直接存放原始 input/output（由 includeNodeSnapshots 控制）
 */
export interface GraphDebugEvent {
  /** 事件唯一标识（UUID） */
  readonly eventId: string;
  /** 所属运行 ID（与 GraphRunContext.runId 一致） */
  readonly runId: string;
  /** 事件时间戳（ISO 字符串） */
  readonly timestamp: string;
  /** 关联节点 ID（validate 阶段等图级事件可为 undefined） */
  readonly nodeId?: string;
  /** 事件阶段 */
  readonly phase: GraphDebugEventPhase;
  /** 事件描述（人类可读，已做敏感词脱敏） */
  readonly message: string;
  /** 事件附加元数据（只读，可能包含快照摘要、guard 结果、分支 ID 等） */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * 图调试选项（TOP-5）
 *
 * 配置 DefaultGraphDebugger 的行为与输出详细程度。
 * 所有字段在 configure() 调用时冻结，运行期不可变。
 */
export interface GraphDebugOptions {
  /** 追踪级别（默认 off，关闭时不生成任何调试事件） */
  readonly logLevel: GraphDebugLogLevel;
  /** 是否包含节点输入/输出快照（默认 false，生产环境建议关闭以避免泄露敏感数据） */
  readonly includeNodeSnapshots?: boolean;
  /** 是否记录 guard 通过事件（默认 false，仅记录失败/警告） */
  readonly includeGuardPassedEvents?: boolean;
  /** 事件环形缓冲区上限（默认 1000，超过后按 FIFO 丢弃最旧事件，防止内存泄漏） */
  readonly maxEvents?: number;
}

/**
 * 图执行快照（TOP-5）
 *
 * 由 GraphDebuggerProtocol.getExecutionSnapshot() 返回，描述一次图运行的当前观测状态。
 * 返回对象经 deepClone + deepFreeze 处理，保证不可变。
 *
 * 注意：
 * - currentNodeId 表示主循环当前节点；fork 并行分支期间主循环停留在 fork 节点，
 *   分支节点事件会单独记录，可通过 events 按 runId/branchId 关联
 * - completedNodes / failedNodes 基于当前已记录的 nodeResults 视图构建
 */
export interface GraphExecutionSnapshot {
  /** 运行 ID */
  readonly runId: string;
  /** 图定义 ID */
  readonly graphId: string;
  /** 主循环当前节点 ID（图执行完成后或尚未开始时为 undefined） */
  readonly currentNodeId?: string;
  /** 已完成节点 ID 列表（按事件顺序，可能包含 failed/isolated/skipped） */
  readonly completedNodes: ReadonlyArray<string>;
  /** 失败节点 ID 列表 */
  readonly failedNodes: ReadonlyArray<string>;
  /** 当前缓冲区中的所有调试事件（只读，按时间顺序） */
  readonly events: ReadonlyArray<GraphDebugEvent>;
}

/**
 * 图运行状态快照（v2.0 补充定义）
 *
 * GraphLoopOrchestrator.status() 的返回值，描述当前图执行的实时状态。
 * 供前端 / CLI / 监控系统查询图执行进度。
 */
export interface GraphRunStatus {
  /** 运行 ID（与 GraphRunReport.runId 一致） */
  readonly runId: string;
  /** 当前状态（running / completed / failed / aborted / timeout） */
  readonly status: "running" | "completed" | "failed" | "aborted" | "timeout";
  /** 当前执行到的节点 ID（图执行完成后为 null） */
  readonly currentNodeId: string | null;
  /** 已完成节点数（含 completed / failed / skipped / isolated） */
  readonly completedNodeCount: number;
  /** 总节点数（WorkGraph.nodes.size） */
  readonly totalNodeCount: number;
  /** 进度百分比（0-100，= completedNodeCount / totalNodeCount * 100） */
  readonly progressPercent: number;
  /** 累计 token 消耗（GraphRunContext.totalTokensUsed 快照） */
  readonly totalTokensUsed: number;
  /** 已耗时（秒，= (Date.now() - startedAtMs) / 1000） */
  readonly elapsedSec: number;
  /** 最后更新时间戳（ISO 字符串，每次状态变更时刷新） */
  readonly lastUpdatedAt: string;
}

/**
 * 经验案例（v2.0 补充定义）
 *
 * 对齐 team/cybernetics/feedback-control-loop.ts 的 ExecutionCase，
 * 用于 Layer 3 经验自进化的案例存储与召回。
 *
 * 案例字段说明：
 * - taskType：任务类型（如 "coding" / "design" / "testing"）
 * - taskFeatures：任务特征（用于相似度匹配，如 { language: "typescript", complexity: "high" }）
 * - strategy：使用的策略（如 "loop-with-strict-evaluator"）
 * - success：是否成功（用于过滤负案例）
 * - executionTimeSec：执行耗时（用于评估策略效率）
 * - failureReason：失败原因（success=false 时填写，用于避坑召回）
 */
export interface ExperienceCase {
  /** 案例 ID（UUID） */
  readonly caseId: string;
  /** 任务类型（与 LoopType 对齐，或扩展自定义类型） */
  readonly taskType: string;
  /** 任务特征（用于相似度匹配，键值对形式） */
  readonly taskFeatures: Readonly<Record<string, unknown>>;
  /** 使用的策略（如 "loop-with-strict-evaluator" / "graph-fork-merge"） */
  readonly strategy: string;
  /** 是否成功（用于过滤正/负案例） */
  readonly success: boolean;
  /** 执行耗时（秒，用于评估策略效率） */
  readonly executionTimeSec: number;
  /** 失败原因（success=false 时填写，用于避坑召回） */
  readonly failureReason?: string;
  /** 关联的节点 ID（图执行时产生，可选） */
  readonly nodeId?: string;
  /** 关联的图运行 ID（图执行时产生，可选） */
  readonly graphRunId?: string;
  /** 创建时间（ISO 字符串） */
  readonly createdAt: string;
}

// ============================================================================
// §11.4 双层重试抑制配置（v2.0 新增）
// ============================================================================

/**
 * 双层重试抑制配置（v2.0 新增，对齐 §11.4）
 *
 * 解决双层重试爆炸问题：
 * - 节点内 Loop 有 maxIterations（默认 10），图级有 nodeRetryLimit（默认 3）
 * - 理论最坏情况：单个节点重试 3 次 × 每次 10 轮迭代 = 30 次 LLM 调用
 * - 多节点图的总重试次数可能爆炸（如 10 节点图 × 30 = 300 次）
 *
 * 抑制策略（4 层防护）：
 * 1. maxTotalRetries：图级总重试预算（默认 nodeRetryLimit × nodes.size × 2）
 * 2. maxIterationsPerNode：单节点 retryCount × loopIterations 乘积上限（默认 20）
 * 3. consecutiveNodeFailureThreshold：连续节点失败熔断阈值（默认 3）
 * 4. backoffStrategy：退避叠加策略（max / sum / graph_only）
 */
export interface RetrySuppressionConfig {
  /** 图级总重试预算（默认 nodeRetryLimit × nodes.size × 2，超限后强制 STOP_FAILURE） */
  readonly maxTotalRetries: number;
  /** 单节点 retryCount × loopIterations 乘积上限（默认 20，超限后跳过 RETRY_NODE 直接 ISOLATE_NODE） */
  readonly maxIterationsPerNode: number;
  /** 连续节点失败熔断阈值（默认 3，连续 N 个节点失败触发图级熔断 → STOP_FAILURE） */
  readonly consecutiveNodeFailureThreshold: number;
  /** 退避叠加策略："max"（取较大值）/ "sum"（求和）/ "graph_only"（仅图级退避） */
  readonly backoffStrategy: "max" | "sum" | "graph_only";
}

/**
 * 创建双层重试抑制配置（带默认值计算）
 *
 * 工厂函数：根据节点数和图级 nodeRetryLimit 自动计算合理的 maxTotalRetries，
 * 避免调用方手动计算公式 `nodeRetryLimit × nodes.size × 2`。
 *
 * @param nodeCount 图中节点总数（用于计算 maxTotalRetries 默认值）
 * @param nodeRetryLimit 图级节点失败重试次数（来自 WorkGraphConfig）
 * @param overrides 覆盖字段（缺省字段使用默认值）
 * @returns 冻结后的 RetrySuppressionConfig
 */
export function createRetrySuppressionConfig(
  nodeCount: number,
  nodeRetryLimit: number,
  overrides?: Partial<RetrySuppressionConfig>
): Readonly<RetrySuppressionConfig> {
  // 校验输入参数合法性
  if (!Number.isInteger(nodeCount) || nodeCount < 0) {
    throw new Error(`createRetrySuppressionConfig: nodeCount 必须为非负整数，实际值=${nodeCount}`);
  }
  if (!Number.isInteger(nodeRetryLimit) || nodeRetryLimit < 0) {
    throw new Error(`createRetrySuppressionConfig: nodeRetryLimit 必须为非负整数，实际值=${nodeRetryLimit}`);
  }

  // 计算默认值：nodeRetryLimit × nodes.size × 2（对齐 §11.4 抑制策略 1）
  const defaultMaxTotalRetries = Math.max(1, nodeRetryLimit * nodeCount * 2);

  return Object.freeze({
    maxTotalRetries: defaultMaxTotalRetries,
    maxIterationsPerNode: 20,
    consecutiveNodeFailureThreshold: 3,
    backoffStrategy: "max" as const,
    ...overrides,
  });
}

// ============================================================================
// §13.4.1 图级全局上下文（Layer 0）—— 多角色评审共识 B-5 / B-1
// ============================================================================
//
// 设计原则（对齐设计文档 §13.4.1）：
// - 保留 GraphRunContext.globalState: Record<string, unknown> 类型不变
// - GraphGlobalContext 定义为可选字段访问接口，兼容降级路径（未初始化时访问不抛错）
// - 通过 getGraphGlobalContext() 工具函数访问，提供类型安全断言
// - 运行期写入时通过 deepFreeze() 冻结每条条目，保证不可变优先
// - 所有字段均为可选（?:），兼容现有 globalState 字符串索引式访问
//   （__experienceRecall / $state.<field> / Object.assign 等模式）
// ============================================================================

/**
 * 节点执行摘要（供其他节点了解前序节点动态）
 *
 * 对齐设计文档 §13.4.1：每个节点执行完成后，由经验上送器生成摘要并写入
 * GraphGlobalContext.nodeSummaries，供后续节点在构建任务上下文时读取。
 */
export interface NodeSummary {
  /** 节点 ID（在图中唯一） */
  readonly nodeId: string;
  /** 节点类型（loop / task / decision / merge / fork / end） */
  readonly nodeType: string;
  /** 节点标签（人类可读） */
  readonly label: string;
  /** 执行状态（completed / failed / skipped / isolated） */
  readonly status: "completed" | "failed" | "skipped" | "isolated";
  /** 输出摘要（输出数据的精简描述，非完整输出，用于上下文片段） */
  readonly outputSummary: string;
  /** 关键决策列表（该节点在执行过程中做出的重要决策） */
  readonly keyDecisions: ReadonlyArray<string>;
  /** 执行完成时间戳（ISO 字符串，用于排序） */
  readonly completedAt: string;
}

/**
 * 图级经验条目（节点上送的经验）
 *
 * 对齐设计文档 §13.4.1：节点执行完成后，通过 NodeExperienceUploader 协议
 * 将本节点积累的经验上送到 GraphGlobalContext.collectedExperiences，
 * 供后续节点在 Discovery 阶段召回复用。
 */
export interface GraphExperienceEntry {
  /** 经验 ID（唯一标识，用于去重） */
  readonly experienceId: string;
  /** 来源节点 ID（图执行产生）或 "historical"（跨图历史经验） */
  readonly sourceNodeId: string;
  /** 经验类型：success（成功经验）/ failure（失败教训） */
  readonly type: "success" | "failure";
  /** 任务类型（与 LoopType 对齐，或扩展自定义类型） */
  readonly taskType: string;
  /** 经验描述（任务场景的精简描述） */
  readonly description: string;
  /** 解决方案（成功经验时填写，描述采用的策略） */
  readonly solution?: string;
  /** 失败原因（失败经验时填写，描述失败根因） */
  readonly failureReason?: string;
  /** 教训（失败经验时填写，描述应避免的陷阱） */
  readonly lessonLearned?: string;
  /** 产生时间（ISO 字符串，用于排序和滑动窗口截断） */
  readonly createdAt: string;
}

/**
 * 动向广播条目（节点间的消息板通知）
 *
 * 对齐设计文档 §13.4.1：节点在执行过程中通过 AgentBulletinBoard 模式
 * 写入 GraphGlobalContext.bulletinBoard，通知其他节点本节点的关键决策/产出。
 * 滑动窗口保留最近 20 条（MAX_BULLETIN_ENTRIES）。
 */
export interface BulletinEntry {
  /** 条目 ID（唯一标识） */
  readonly entryId: string;
  /** 来源节点 ID */
  readonly sourceNodeId: string;
  /** 通知类型：decision（决策）/ milestone（里程碑）/ blocker（阻塞）/ discovery（发现） */
  readonly type: "decision" | "milestone" | "blocker" | "discovery";
  /** 通知内容摘要（精简描述，用于上下文片段） */
  readonly summary: string;
  /** 详细信息（可选，用于深入排查） */
  readonly details?: string;
  /** 时间戳（ISO 字符串，用于排序和滑动窗口截断） */
  readonly timestamp: string;
}

/**
 * 图级全局上下文（Layer 0）
 *
 * 对齐设计文档 §13.4.1：作为 GraphRunContext.globalState 的可选字段视图，
 * 承载项目目标、全局约束、跨节点共享数据、经验汇总池和动向广播板。
 *
 * 访问方式：
 * - 通过 getGraphGlobalContext(ctx) 获取类型安全视图
 * - 通过 isGraphGlobalContextInitialized(ctx) 判断是否已初始化
 *
 * 不可变性（对齐 §13.4.1 多角色评审共识 M-4）：
 * - 溯源字段（projectRoot / projectGoal / globalConstraints / runId / graphId / createdAt）
 *   声明为 readonly，图启动时注入后全程不变
 * - 集合字段（sharedArtifacts / nodeSummaries / collectedExperiences / bulletinBoard）
 *   引用可写（允许 push / 重新赋值以支持滑动窗口截断），但每条条目
 *   在写入时通过 deepFreeze() 递归冻结，保证元素不可变
 * - lastUpdatedAt 每次 uploadExperiences 后刷新
 *
 * 降级语义：
 * - 当 GraphGlobalContext 未初始化时，getGraphGlobalContext() 返回空对象
 * - isGraphGlobalContextInitialized() 返回 false，节点执行降级为直接执行模式
 */
export interface GraphGlobalContext {
  // ---- 项目级信息（图启动时注入，全程不变，readonly）----
  /** 项目根目录（用于文件读写定位） */
  readonly projectRoot?: string;
  /** 项目目标（用户意图，图编排的终极目标，作为 directRetain 通道必注入片段） */
  readonly projectGoal?: string;
  /** 全局约束（如代码规范、安全策略、技术栈约束，初始化后不变） */
  readonly globalConstraints?: ReadonlyArray<string>;

  // ---- 跨节点共享数据（节点可读写，集合引用可写但元素 deepFreeze 冻结）----
  /** 共享产物（前序节点产出供后续节点使用，如设计文档、API 规范） */
  sharedArtifacts?: Record<string, unknown>;
  /** 已访问节点摘要（nodeId → NodeSummary，用于动向感知） */
  nodeSummaries?: Map<string, NodeSummary>;

  // ---- 经验汇总池（节点上送，后续节点复用，引用可写以支持滑动窗口截断）----
  /** 已收集的经验列表（成功 + 失败，按时间顺序，滑动窗口截断） */
  collectedExperiences?: GraphExperienceEntry[];

  // ---- 动向广播板（节点写入，其他节点读取，引用可写以支持 FIFO 截断）----
  /** 动向广播板（最近 N 条关键决策/产出通知，默认保留 20 条） */
  bulletinBoard?: BulletinEntry[];

  // ---- 溯源字段（readonly，图启动时注入后不变）----
  /** 图运行 ID（与 GraphRunContext.runId 一致，便于快照追溯） */
  readonly runId?: string;
  /** 图定义 ID（与 GraphRunContext.graphId 一致） */
  readonly graphId?: string;
  /** 全局上下文创建时间戳（ISO 字符串） */
  readonly createdAt?: string;
  /** 全局上下文最后更新时间戳（每次 uploadExperiences 后刷新） */
  lastUpdatedAt?: string;
}

// TOP-4 上下文拼接工具函数统一化：
// getGraphGlobalContext / isGraphGlobalContextInitialized 实现已迁移到 graph-context-utils.ts，
// 本模块通过 re-export 保持外部 API 完全不变。
export { getGraphGlobalContext, isGraphGlobalContextInitialized } from "./graph-context-utils";
