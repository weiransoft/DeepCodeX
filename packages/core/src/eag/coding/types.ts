/**
 * CODING Loop 全部数据模型（EAG-P2 批次 9 S1 基础层）
 *
 * 本模块定义 EAG 方案 §5.10.3 / §5.10.5 CODING Loop 全部结构化数据类型，
 * 涵盖 Phase A 骨架生成、Phase B LLM 填充、STRICT 评估、FIX 回灌、Loop 编排
 * 五大阶段所需的所有契约。
 *
 * 设计依据：
 * - EAG 方案 §5.10.3 CODING Loop 设计（Phase A 骨架 → Phase B 填充 → STRICT 评估 → FIX 回灌）
 * - EAG 方案 §5.10.5 三 Loop 完整编排时序
 * - EAG 方案 §5.12.2 失败上限纪律（连续 3 次 FIX 失败 → HUMAN_CHECKPOINT）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则
 * - 批次 9 设计方案 §4.1 数据模型
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze + as const 冻结，防止运行期被 LLM 自改
 * - 工厂函数 createXxxRequest 统一返回 Object.freeze 冻结对象
 *
 * 外部类型复用：
 * - TaskDag / TaskCard / ModuleSplit：从 ../doc-driven/types 导入
 * - RedlineDefinition / EvaluationReport / EvaluationContext / EvaluationMode：从 ../evaluator/types 导入
 * - LLMClient：从 ../../providers/llm-provider 导入
 * - LoopGuard：从 ../../common/loop-guard 导入
 *
 * @module eag/coding/types
 */

// ============================================================================
// 1. 外部类型导入（仅 type-only import，避免运行期循环依赖）
// ============================================================================

import type { TaskDag, TaskCard, ModuleSplit } from "../doc-driven/types";
import type {
  RedlineDefinition,
  RedlineResult,
  EvaluationReport,
  EvaluationContext,
  EvaluationMode,
} from "../evaluator/types";
import type { LLMClient } from "../../providers/llm-provider";
import type { LoopGuard } from "../../common/loop-guard";

// ============================================================================
// 2. 文件类型与生成产出
// ============================================================================

/**
 * 生成文件类型（13 种，字面量联合类型）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 GeneratedFile.kind：
 * - aggregate：DDD 聚合根（含工厂方法 / 业务方法 / 领域事件发布点）
 * - value-object：值对象（不可变 / 无标识 / 全字段 final）
 * - domain-event：领域事件（包含事件 ID / 时间戳 / 载荷）
 * - domain-service：领域服务（跨聚合业务逻辑 / 无状态）
 * - repository-port：仓储接口（依赖倒置 / 领域层定义）
 * - repository-impl：仓储实现（基础设施层 / 实现领域层接口）
 * - application-service：应用服务（用例编排 / 事务脚本 / DTO 转换）
 * - dto：数据传输对象（输入校验 / 序列化标注）
 * - rest-controller：REST 控制器（HTTP 路由 / 异常映射 / 幂等键）
 * - saga-orchestrator：Saga 编排器（跨聚合最终一致 / 补偿事务）
 * - event-handler：事件处理器（异步消费 / 幂等去重 / 死信处理）
 * - test-spec：单元测试骨架（Given-When-Then / 断言模板）
 * - module-index：模块 barrel（统一导出 / 减少耦合）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误，并作为 TemplateRegistry 的索引键。
 */
export type GeneratedFileKind =
  | "aggregate"
  | "value-object"
  | "domain-event"
  | "domain-service"
  | "repository-port"
  | "repository-impl"
  | "application-service"
  | "dto"
  | "rest-controller"
  | "saga-orchestrator"
  | "event-handler"
  | "test-spec"
  | "module-index";

/**
 * GeneratedFileKind 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结。顺序对齐 §4.1.2 GeneratedFile.kind 定义顺序，
 * 也是模板注册表中的内置 kind 顺序。
 */
export const GENERATED_FILE_KINDS: ReadonlyArray<GeneratedFileKind> = Object.freeze([
  "aggregate",
  "value-object",
  "domain-event",
  "domain-service",
  "repository-port",
  "repository-impl",
  "application-service",
  "dto",
  "rest-controller",
  "saga-orchestrator",
  "event-handler",
  "test-spec",
  "module-index",
]);

/**
 * 生成的文件（骨架或填充后的代码文件）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 GeneratedFile：
 * 单个生成文件的元数据与内容。骨架生成器（Phase A）产出含 TODO 占位的骨架；
 * LLM 填充器（Phase B）产出含完整实现的代码。
 *
 * 字段全部 readonly——文件一旦生成即不可变，变更通过生成新版本表达。
 *
 * 范例：
 *   {
 *     relativePath: "src/domain/order/OrderAggregate.ts",
 *     content: "/** OrderAggregate 聚合根 *\/\nexport class OrderAggregate { ... }",
 *     kind: "aggregate",
 *     taskId: "T-001",
 *     requirementId: "F-001"
 *   }
 */
export interface GeneratedFile {
  /** 文件相对路径（相对 projectRoot，如 "src/domain/order/OrderAggregate.ts"） */
  readonly relativePath: string;
  /**
   * 文件内容（骨架代码含 `<%_ // TODO(phase-b): <description> _%>` 占位标记；
   * 填充后内容为完整 TypeScript 实现）
   */
  readonly content: string;
  /** 文件类型（用于评估器路由与模板检索，13 种之一） */
  readonly kind: GeneratedFileKind;
  /** 关联任务卡 ID（如 "T-001"，用于 G-3 偏离检测与需求溯源） */
  readonly taskId: string;
  /** 关联需求 ID（如 "F-001"，用于跨任务的需求溯源） */
  readonly requirementId: string;
}

// ============================================================================
// 3. Phase A 骨架生成请求与产出
// ============================================================================

/**
 * Phase A 骨架生成请求
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 SkeletonGenerationRequest：
 * SkeletonGenerator.generate() 的入参，携带骨架生成所需的全部输入。
 *
 * 字段全部 readonly——请求一经组装即不可变，防止 LLM 在生成过程中篡改输入。
 *
 * 范例：
 *   {
 *     planContent: "# 实现方案\n## 1. 模块切分\n...",
 *     tasksContent: "# 任务分解\n## T-001 UserAggregate 骨架\n...",
 *     taskDag: { nodes: [...], topologicalOrder: ["T-001", "T-002"] },
 *     taskCard: { id: "T-001", title: "UserAggregate 骨架", ... },
 *     techStack: ["TypeScript", "NestJS", "PostgreSQL"],
 *     projectRoot: "/path/to/project",
 *     outputDir: "src/"
 *   }
 */
export interface SkeletonGenerationRequest {
  /** 已批准的 plan.md 内容（含模块切分 / 接口契约 / 数据迁移 / 风险与回退） */
  readonly planContent: string;
  /** 已批准的 tasks.md 内容（含任务 DAG 与拓扑序） */
  readonly tasksContent: string;
  /** 任务 DAG（来自 doc-driven/task-decomposition，含拓扑序） */
  readonly taskDag: Readonly<TaskDag>;
  /** 当前迭代的任务卡（含 [REQ-F-xxx] 溯源标记与 declaredSymbols） */
  readonly taskCard: Readonly<TaskCard>;
  /** 技术栈锁定清单（CONSTITUTION.techStackLocks，未经用户批准不得变更） */
  readonly techStack: ReadonlyArray<string>;
  /** 项目根目录（绝对路径，用于解析输出目录与上下文查询） */
  readonly projectRoot: string;
  /** 输出目录（相对 projectRoot，默认 "src/"，骨架文件写入此目录） */
  readonly outputDir: string;
}

/**
 * Phase A 骨架生成产出
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 SkeletonGenerationResult：
 * SkeletonGenerator.generate() 的产出，含骨架文件列表 / 模板变量快照 / 占位列表 / 耗时。
 *
 * 字段全部 readonly——骨架一旦生成即不可变，Phase B 填充基于此快照进行。
 *
 * 范例：
 *   {
 *     files: [{ relativePath: "src/domain/UserAggregate.ts", content: "...", kind: "aggregate", ... }],
 *     templateVariables: { aggregateName: "UserAggregate", fields: [...], ... },
 *     fillPlaceholders: [{ id: "PH-001", filePath: "...", line: 25, kind: "method-body", ... }],
 *     durationMs: 320
 *   }
 */
export interface SkeletonGenerationResult {
  /** 生成的骨架文件列表（绝对路径 + 内容，含 TODO 占位） */
  readonly files: ReadonlyArray<GeneratedFile>;
  /** 模板变量快照（用于审计与 Phase B 上下文，包含所有 EJS 渲染时的变量值） */
  readonly templateVariables: Readonly<Record<string, unknown>>;
  /** 待 Phase B 填充的占位标记列表（每个 TODO 对应一个填充点） */
  readonly fillPlaceholders: ReadonlyArray<FillPlaceholder>;
  /** 生成耗时（毫秒，用于性能监控与 SLA 评估） */
  readonly durationMs: number;
}

/**
 * Phase B 填充占位类型（字面量联合类型）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FillPlaceholder.kind：
 * - method-body：方法体（含业务逻辑实现，最常见类型）
 * - class-body：类体（含字段定义 / 构造函数 / 工厂方法等）
 * - config：配置项（如依赖注入绑定 / 路由注册 / 中间件配置）
 * - import：导入语句（基于 InterfaceContract 静态推导，不调 LLM）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type FillPlaceholderKind = "method-body" | "class-body" | "config" | "import";

/**
 * FillPlaceholderKind 全部合法值（用于运行时枚举与校验）
 *
 * 使用 Object.freeze 冻结。顺序对齐 §4.1.2 FillPlaceholder.kind 定义顺序。
 */
export const FILL_PLACEHOLDER_KINDS: ReadonlyArray<FillPlaceholderKind> = Object.freeze([
  "method-body",
  "class-body",
  "config",
  "import",
]);

/**
 * Phase B 填充占位
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FillPlaceholder：
 * 骨架中的单个 TODO(phase-b) 标记，描述 Phase B LLM 填充的目标点。
 * LlmFiller 按此列表逐个填充，而非扫描代码识别占位（避免占位 ID 丢失，对齐 §7 R1 风险缓解）。
 *
 * 字段全部 readonly——占位一旦扫描生成即不可变。
 *
 * 范例：
 *   {
 *     id: "PH-001",
 *     filePath: "src/domain/UserAggregate.ts",
 *     line: 25,
 *     kind: "method-body",
 *     description: "实现 UserAggregate.create 工厂方法，包含不变式校验与领域事件发布",
 *     expectedSignature: "static create(command: UserCreateCommand): { aggregate: UserAggregate; events: DomainEvent[] }"
 *   }
 */
export interface FillPlaceholder {
  /** 占位 ID（在骨架中唯一，格式 "PH-NNN"，由 SkeletonGenerator 顺序分配） */
  readonly id: string;
  /** 所在文件相对路径（相对 projectRoot） */
  readonly filePath: string;
  /** 所在行号（1-based，从骨架代码内容中扫描得来） */
  readonly line: number;
  /** 占位类型（method-body / class-body / config / import） */
  readonly kind: FillPlaceholderKind;
  /** 占位描述（LLM 填充时的指引，描述该占位应实现的业务逻辑或配置内容） */
  readonly description: string;
  /** 期望的代码签名（method-body 时为方法签名，用于 LLM 输出一致性校验） */
  readonly expectedSignature?: string;
}

// ============================================================================
// 4. Phase B LLM 填充请求与产出
// ============================================================================

/**
 * Phase B LLM 填充请求
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 LlmFillRequest：
 * LlmFiller.fill() 的入参，携带骨架产出 / 装配后的上下文 / LLM 客户端 / 填充配置。
 *
 * 字段全部 readonly——LLM 客户端通过依赖注入传入，便于测试使用 InMemoryLLMClient 真实实现。
 *
 * 范例：
 *   {
 *     skeleton: { files: [...], fillPlaceholders: [...], ... },
 *     context: { l1GlobalView: {...}, l2SemanticResults: [...], ... },
 *     llmClient: new InMemoryLLMClient(generator),
 *     maxRounds: 3,
 *     maxTokensPerFile: 4000
 *   }
 */
export interface LlmFillRequest {
  /** 骨架生成产出（Phase A 结果，含 TODO 占位列表） */
  readonly skeleton: Readonly<SkeletonGenerationResult>;
  /** 装配后的上下文（PKC + TCS + RLIS + 红线，由 ContextAssembler 产出） */
  readonly context: Readonly<CodingContext>;
  /** LLM 客户端（由调用方注入真实 LLMClient；测试用 InMemoryLLMClient 真实实现） */
  readonly llmClient: LLMClient;
  /** 最大填充轮次（默认 3，单占位最多 2 次重试共 3 次调用） */
  readonly maxRounds: number;
  /** 单文件最大 token 上限（默认 4000，防止单次填充产生超长代码） */
  readonly maxTokensPerFile: number;
}

/**
 * Phase B LLM 填充产出
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 LlmFillResult：
 * LlmFiller.fill() 的产出，含填充后的文件列表 / 各占位状态 / 调用统计 / 耗时。
 *
 * 字段全部 readonly——填充结果一经产出即不可变。
 *
 * 范例：
 *   {
 *     filledFiles: [{ relativePath: "...", content: "...（完整实现）", ... }],
 *     fillStatus: [{ placeholderId: "PH-001", status: "filled", summary: "..." }],
 *     llmCallCount: 12,
 *     totalTokensUsed: 18432,
 *     durationMs: 4520
 *   }
 */
export interface LlmFillResult {
  /** 填充后的文件列表（含完整实现，无 TODO 占位残留） */
  readonly filledFiles: ReadonlyArray<GeneratedFile>;
  /** 各占位的填充状态（filled / skipped / failed） */
  readonly fillStatus: ReadonlyArray<FillStatus>;
  /** LLM 调用次数（含重试，用于成本核算与 SLA 评估） */
  readonly llmCallCount: number;
  /** 总 token 消耗（input + output，用于 LoopGuard 预算控制） */
  readonly totalTokensUsed: number;
  /** 填充耗时（毫秒） */
  readonly durationMs: number;
}

/**
 * 占位填充状态（字面量联合类型）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FillStatus.status：
 * - filled：已填充（LLM 成功生成代码并替换占位）
 * - skipped：已跳过（import / config 占位由静态推导，无需 LLM）
 * - failed：填充失败（3 次调用均失败，标记为 failed 但不阻塞其他占位）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type FillStatusValue = "filled" | "skipped" | "failed";

/**
 * FillStatusValue 全部合法值（用于运行时枚举与校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const FILL_STATUS_VALUES: ReadonlyArray<FillStatusValue> = Object.freeze(["filled", "skipped", "failed"]);

/**
 * 占位填充状态
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FillStatus：
 * 描述单个占位的填充结果，便于审计与失败定位。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     placeholderId: "PH-001",
 *     status: "filled",
 *     summary: "static create(command: UserCreateCommand) { ... }"
 *   }
 */
export interface FillStatus {
  /** 占位 ID（对应 FillPlaceholder.id） */
  readonly placeholderId: string;
  /** 填充状态（filled / skipped / failed） */
  readonly status: FillStatusValue;
  /** 填充摘要（LLM 输出的前 200 字符，用于审计与日志展示） */
  readonly summary: string;
}

// ============================================================================
// 5. CODING Loop 上下文（Phase B 输入）
// ============================================================================

/**
 * 语义检索命中项
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 SemanticSearchHit：
 * PKC L2 语义检索的单个命中结果，描述与当前任务相关的代码符号。
 *
 * 与 pkc/l2-types 中 SemanticSearchResult 字段对齐但独立定义，
 * 避免 CODING 模块耦合 PKC 实现细节（仅通过 PkcAccessor 协议交互）。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     symbolId: "src/domain/UserAggregate.ts:UserAggregate.create",
 *     filePath: "src/domain/UserAggregate.ts",
 *     signature: "static create(command: UserCreateCommand): { aggregate: UserAggregate; events: DomainEvent[] }",
 *     score: 0.92,
 *     snippet: "static create(command: UserCreateCommand) { ... }"
 *   }
 */
export interface SemanticSearchHit {
  /** 符号唯一 ID（格式 "filePath:symbolName"，用于跨模块引用） */
  readonly symbolId: string;
  /** 符号所在文件路径（相对 projectRoot） */
  readonly filePath: string;
  /** 符号签名（如方法签名 "static create(command: Command): Result"） */
  readonly signature: string;
  /** 相关性评分（0~1，由 PKC L2 语义检索器计算） */
  readonly score: number;
  /** 代码片段（符号附近上下文，便于 LLM 理解复用意图） */
  readonly snippet: string;
}

/**
 * TCS 规范摘要
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 TcsSpecSummary：
 * 单个 TCS 技术组件规范的精简版本，供 LLM 填充时参考组件 Port 接口与红线约束。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     componentId: "TCS-CACHE",
 *     portInterface: "interface CachePort { get<T>(key: string): Promise<T | null>; ... }",
 *     redlines: [{ id: "TCS-CACHE-01", ... }, { id: "TCS-CACHE-02", ... }]
 *   }
 */
export interface TcsSpecSummary {
  /** 组件 ID（如 "TCS-CACHE" / "TCS-SQL" / "TCS-OSS"） */
  readonly componentId: string;
  /** Port 接口定义（TypeScript 接口字符串，供 LLM 复用与实现） */
  readonly portInterface: string;
  /** 该组件的红线清单（如 TCS-CACHE-01/02/03，供 STRICT 评估器判定） */
  readonly redlines: ReadonlyArray<RedlineDefinition>;
}

/**
 * RLIS 规则摘要
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 RlisRuleSummary：
 * 单条 RLIS 规则的精简版本，由 RuleInjector 注入到 LLM prompt 中。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     ruleId: "SEED-01",
 *     category: "implementation-quality",
 *     severity: "blocker",
 *     content: "禁止使用 mock/占位/简化实现，所有代码必须真实实现业务逻辑"
 *   }
 */
export interface RlisRuleSummary {
  /** 规则 ID（如 "SEED-01" / "USER-R-001"） */
  readonly ruleId: string;
  /** 规则分类（如 "implementation-quality" / "security" / "performance"） */
  readonly category: string;
  /** 严重性（对齐 RedlineSeverity：blocker / major / warning） */
  readonly severity: string;
  /** 规则内容（自然语言描述，供 LLM 与评估器参考） */
  readonly content: string;
}

/**
 * CODING Loop 上下文（Phase B 输入）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 CodingContext：
 * ContextAssembler.assemble() 的产出，携带 Phase B LLM 填充与 STRICT 评估共用的全部上下文。
 *
 * 上下文装配算法（§4.3.2）：
 * 1. 从 taskCard.fileCluster 提取查询关键词
 * 2. 调用 pkcAccessor.searchL2(query, topK=10) 获取相关符号
 * 3. 调用 pkcAccessor.queryL1GlobalView() 获取模块聚类
 * 4. 调用 pkcAccessor.queryL3BusinessKnowledge() 获取业务流程 + ER 图
 * 5. 从 plan.md 解析当前 taskCard 对应的 ModuleSplit + InterfaceContract
 * 6. 调用 ruleInjector.getEffectiveRules() 获取 RLIS 规则
 * 7. 合并 enterpriseRedlines + tcsRedlines + rlisRules → 统一红线清单
 * 8. 返回冻结的 CodingContext
 *
 * 字段全部 readonly——上下文一经装配即不可变，避免 LLM 在填充过程中篡改上下文。
 *
 * 范例：
 *   {
 *     l1GlobalView: { moduleClusters: [...], entryPoints: [...] },
 *     l2SemanticResults: [{ symbolId: "...", score: 0.92, ... }],
 *     l3BusinessKnowledge: { flows: [...], erDiagram: "..." },
 *     tcsSpecs: [{ componentId: "TCS-CACHE", ... }],
 *     rlisRules: [{ ruleId: "SEED-01", ... }],
 *     enterpriseRedlines: [{ id: "E1", ... }],
 *     taskCard: { id: "T-001", ... },
 *     moduleSplit: { moduleName: "UserAggregate", ... }
 *   }
 */
export interface CodingContext {
  /** PKC L1 全局视野摘要（模块聚类 + 入口点 + 爆炸半径 Top-N） */
  readonly l1GlobalView: Readonly<Record<string, unknown>>;
  /** PKC L2 语义检索结果（与本任务相关的 Top-K 符号，K 默认 10） */
  readonly l2SemanticResults: ReadonlyArray<SemanticSearchHit>;
  /** PKC L3 业务知识（K2 流程图 / K3 ER 图 / K5 交互矩阵） */
  readonly l3BusinessKnowledge: Readonly<Record<string, unknown>>;
  /** TCS 规范摘要（红线清单 + 接口契约，由 ContextAssembler 从 TCS_REDLINES 派生） */
  readonly tcsSpecs: ReadonlyArray<TcsSpecSummary>;
  /** RLIS 注入规则（SEED + 用户确认规则，由 RuleInjector.getEffectiveRules 产出） */
  readonly rlisRules: ReadonlyArray<RlisRuleSummary>;
  /** 企业红线清单（E1~E8，由 ENTERPRISE_REDLINES 提供） */
  readonly enterpriseRedlines: ReadonlyArray<RedlineDefinition>;
  /** 当前任务卡（含 [REQ-F-xxx] 溯源标记与 declaredSymbols） */
  readonly taskCard: Readonly<TaskCard>;
  /** 当前 plan.md 中相关模块切分（含 moduleName / responsibility / keyFiles） */
  readonly moduleSplit: Readonly<ModuleSplit>;
}

// ============================================================================
// 6. STRICT 评估请求
// ============================================================================

/**
 * STRICT 评估请求
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 StrictEvaluationRequest：
 * StrictEvaluator.evaluate() 的扩展入参（在 IndependentEvaluator 协议基础上增加 LLM 客户端）。
 *
 * 评估策略（§4.5.2）：
 * - STRICT 模式默认（无客观指标即不通过）
 * - 静态判定优先（13 个 StaticChecker 类）
 * - LLM judge 仅在 reasoning 红线且静态判定为 unknown 时调用
 *
 * 字段全部 readonly。llmClient 可选——STRICT 模式优先静态判定，不强制依赖 LLM。
 *
 * 范例：
 *   {
 *     evaluationContext: { loopType: "coding", iteration: 1, taskId: "T-001", ... },
 *     redlines: [...ENTERPRISE_REDLINES, ...TCS_REDLINES, ...rlisRedlines],
 *     llmClient: new InMemoryLLMClient(generator)
 *   }
 */
export interface StrictEvaluationRequest {
  /** 评估上下文（产出物路径 + 内联内容 + Loop 信息） */
  readonly evaluationContext: Readonly<EvaluationContext>;
  /** 红线清单（E1~E8 + TCS_REDLINES + RLIS 规则转化的红线） */
  readonly redlines: ReadonlyArray<RedlineDefinition>;
  /** LLM 客户端（用于 reasoning 类型红线的判定，可空——STRICT 模式优先静态） */
  readonly llmClient?: LLMClient;
}

// ============================================================================
// 7. FIX 回灌请求与产出
// ============================================================================

/**
 * FIX 回灌请求
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FixLoopRequest：
 * FixLoop.run() 的入参，携带原代码 / 评估报告 / 上下文 / LLM 客户端 / 轮次上限。
 *
 * 字段全部 readonly。LLM 客户端必填——FIX 阶段必须调用 LLM 生成修复 patch。
 *
 * 范例：
 *   {
 *     originalFiles: [{ relativePath: "...", content: "...", ... }],
 *     evaluationReport: { verdict: "fix", redlineResults: [...], ... },
 *     context: { ... },
 *     llmClient: new InMemoryLLMClient(generator),
 *     maxRounds: 3
 *   }
 */
export interface FixLoopRequest {
  /** 原始代码文件列表（FIX 前的填充产出） */
  readonly originalFiles: ReadonlyArray<GeneratedFile>;
  /** 评估报告（含违规项与修复建议，由 StrictEvaluator 产出） */
  readonly evaluationReport: Readonly<EvaluationReport>;
  /** 上下文（与 Phase B 共享，含 PKC / TCS / RLIS / 红线） */
  readonly context: Readonly<CodingContext>;
  /** LLM 客户端（用于生成 unified diff 修复 patch） */
  readonly llmClient: LLMClient;
  /** 最大 FIX 轮次（默认 3，对齐 §5.2.3 连续 3 次 FIX 失败 → HUMAN_CHECKPOINT） */
  readonly maxRounds: number;
}

/**
 * 单轮 FIX 记录
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FixRoundRecord：
 * 描述单轮 FIX 的输入报告 / patch / 输出报告 / 是否通过。
 *
 * 字段全部 readonly——单轮记录一经产生即不可变，便于审计与失败分析。
 *
 * 范例：
 *   {
 *     round: 1,
 *     inputReport: { verdict: "fix", blockerCount: 2, ... },
 *     patch: "--- a/src/domain/UserAggregate.ts\n+++ b/src/domain/UserAggregate.ts\n@@ ...",
 *     outputReport: { verdict: "pass", blockerCount: 0, ... },
 *     passed: true
 *   }
 */
export interface FixRoundRecord {
  /** 轮次序号（从 1 开始） */
  readonly round: number;
  /** 输入评估报告（本轮 FIX 的修复目标） */
  readonly inputReport: Readonly<EvaluationReport>;
  /** LLM 生成的修复 patch（unified diff 格式字符串） */
  readonly patch: string;
  /** 修复后评估报告（应用 patch 后重新评估的结果） */
  readonly outputReport: Readonly<EvaluationReport>;
  /** 是否通过（outputReport.verdict === "pass"） */
  readonly passed: boolean;
}

/**
 * FIX 回灌产出
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 FixLoopResult：
 * FixLoop.run() 的产出，含修复后的文件 / 各轮记录 / 最终报告 / 调用统计 / 耗时。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     fixedFiles: [{ relativePath: "...", content: "...（修复后）", ... }],
 *     rounds: [{ round: 1, ... }, { round: 2, ... }],
 *     finalReport: { verdict: "pass", ... },
 *     totalLlmCallCount: 2,
 *     durationMs: 3200
 *   }
 */
export interface FixLoopResult {
  /** 修复后的文件列表（应用所有 patch 后的最终版本） */
  readonly fixedFiles: ReadonlyArray<GeneratedFile>;
  /** 各轮修复记录（含输入/输出报告与 patch，便于审计） */
  readonly rounds: ReadonlyArray<FixRoundRecord>;
  /** 最终评估报告（最后一轮的 outputReport，verdict=pass 或 fix-exhausted） */
  readonly finalReport: Readonly<EvaluationReport>;
  /** 总 LLM 调用次数（含所有轮次） */
  readonly totalLlmCallCount: number;
  /** 总耗时（毫秒） */
  readonly durationMs: number;
}

// ============================================================================
// 8. CODING Loop 编排请求与产出
// ============================================================================

/**
 * CODING Loop 最终状态（字面量联合类型）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 CodingLoopResult.finalStatus：
 * - completed：已完成（所有任务卡 status=completed + STRICT 通过 + commit 就绪）
 * - failed：失败（LoopGuard 触达上限或不可恢复错误）
 * - human-checkpoint：人工介入（单任务卡 FIX 耗尽或评估器无法判定）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type CodingLoopFinalStatus = "completed" | "failed" | "human-checkpoint";

/**
 * CodingLoopFinalStatus 全部合法值（用于运行时枚举与校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const CODING_LOOP_FINAL_STATUSES: ReadonlyArray<CodingLoopFinalStatus> = Object.freeze([
  "completed",
  "failed",
  "human-checkpoint",
]);

/**
 * 单任务卡执行状态（字面量联合类型）
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 TaskCodingResult.status：
 * - completed：已完成（STRICT 评估 verdict=pass）
 * - fix-exhausted：FIX 耗尽（3 轮 FIX 后仍未通过，转 HUMAN_CHECKPOINT）
 * - human-checkpoint：人工介入（评估器 verdict=human_checkpoint 或 G-4/G-5 门禁失败）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type TaskCodingStatus = "completed" | "fix-exhausted" | "human-checkpoint";

/**
 * TaskCodingStatus 全部合法值（用于运行时枚举与校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const TASK_CODING_STATUSES: ReadonlyArray<TaskCodingStatus> = Object.freeze([
  "completed",
  "fix-exhausted",
  "human-checkpoint",
]);

/**
 * CODING Loop 编排请求
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 CodingLoopRequest：
 * CodingOrchestrator.run() 的入参，携带项目根目录 / 三文档内容 / 任务 DAG / 任务卡列表 /
 * 技术栈 / 宪法 / LLM 客户端 / PKC 访问器 / LoopGuard / 迭代上限。
 *
 * 字段全部 readonly。LoopGuard 必填——所有 Loop 必须有上限保护（对齐 §5.2.1 A-3/A-4 共识）。
 *
 * 范例：
 *   {
 *     projectRoot: "/path/to/project",
 *     specContent: "...",
 *     planContent: "...",
 *     tasksContent: "...",
 *     taskDag: { nodes: [...], topologicalOrder: ["T-001", "T-002"] },
 *     taskCards: [{ id: "T-001", ... }, { id: "T-002", ... }],
 *     techStack: ["TypeScript", "NestJS", "PostgreSQL"],
 *     constitutionContent: "...",
 *     llmClient: new OpenAIClient(...),
 *     pkcAccessor: new InMemoryPkcAccessor(...),
 *     loopGuard: new LoopGuard({ maxIterations: 10 }),
 *     maxIterations: 10,
 *     maxFixRounds: 3
 *   }
 */
export interface CodingLoopRequest {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 已批准的 spec.md 内容（功能需求规格） */
  readonly specContent: string;
  /** 已批准的 plan.md 内容（实现方案：模块切分 + 接口契约 + 数据迁移 + 风险） */
  readonly planContent: string;
  /** 已批准的 tasks.md 内容（任务分解 DAG + 验收标准） */
  readonly tasksContent: string;
  /** 任务 DAG（含拓扑序，由 TaskDecomposer 生成） */
  readonly taskDag: Readonly<TaskDag>;
  /** 当前要执行的任务卡列表（按拓扑序，由 taskDag.nodes 映射得来） */
  readonly taskCards: ReadonlyArray<TaskCard>;
  /** 技术栈锁定清单（CONSTITUTION.techStackLocks，未经用户批准不得变更） */
  readonly techStack: ReadonlyArray<string>;
  /** CONSTITUTION.md 内容（含红线声明 / 不可协商项 / 项目愿景） */
  readonly constitutionContent: string;
  /** LLM 客户端（贯穿 Phase B + FIX 全流程） */
  readonly llmClient: LLMClient;
  /** PKC 知识库访问器（L1/L2/L3 查询接口，由调用方注入实现） */
  readonly pkcAccessor: PkcAccessor;
  /** LoopGuard 实例（上限保护，由调用方注入已配置的实例） */
  readonly loopGuard: LoopGuard;
  /** 最大迭代次数（默认 10，覆盖大多数企业任务的迭代需求） */
  readonly maxIterations: number;
  /** 单任务最大 FIX 轮次（默认 3，对齐 §5.2.3 连续 3 次 FIX 失败 → HUMAN_CHECKPOINT） */
  readonly maxFixRounds: number;
}

/**
 * 单任务卡执行结果
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 TaskCodingResult：
 * 描述单个任务卡的 CODING Loop 执行结果，含骨架 / 填充 / 评估 / 状态 / 迭代次数。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     taskCardId: "T-001",
 *     skeleton: { files: [...], ... },
 *     fill: { filledFiles: [...], ... },
 *     finalEvaluation: { verdict: "pass", ... },
 *     status: "completed",
 *     iterations: 2
 *   }
 */
export interface TaskCodingResult {
  /** 任务卡 ID（对应 TaskCard.id） */
  readonly taskCardId: string;
  /** 骨架生成产出（Phase A 结果） */
  readonly skeleton: Readonly<SkeletonGenerationResult>;
  /** LLM 填充产出（Phase B 结果，含完整实现） */
  readonly fill: Readonly<LlmFillResult>;
  /** 最终评估报告（FIX 后的最终 STRICT 评估结果） */
  readonly finalEvaluation: Readonly<EvaluationReport>;
  /** 状态（completed / fix-exhausted / human-checkpoint） */
  readonly status: TaskCodingStatus;
  /** 迭代次数（Phase A + Phase B + FIX 总迭代数） */
  readonly iterations: number;
}

/**
 * CODING Loop 编排产出
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 CodingLoopResult：
 * CodingOrchestrator.run() 的产出，含各任务卡结果 / 总生成文件 / 统计信息 / 最终状态。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     taskResults: [{ taskCardId: "T-001", status: "completed", ... }],
 *     allGeneratedFiles: [{ relativePath: "...", ... }],
 *     totalIterations: 5,
 *     totalLlmCallCount: 28,
 *     totalTokensUsed: 64200,
 *     durationSec: 120,
 *     finalStatus: "completed"
 *   }
 */
export interface CodingLoopResult {
  /** 各任务卡的执行结果（按拓扑序） */
  readonly taskResults: ReadonlyArray<TaskCodingResult>;
  /** 总生成文件列表（所有任务卡的 allGeneratedFiles 汇总） */
  readonly allGeneratedFiles: ReadonlyArray<GeneratedFile>;
  /** 总迭代次数（所有任务卡的 iterations 汇总） */
  readonly totalIterations: number;
  /** 总 LLM 调用次数（Phase B + FIX 全流程） */
  readonly totalLlmCallCount: number;
  /** 总 token 消耗（input + output，用于成本核算与 SLA 评估） */
  readonly totalTokensUsed: number;
  /** 总耗时（秒） */
  readonly durationSec: number;
  /** 最终状态（completed / failed / human-checkpoint） */
  readonly finalStatus: CodingLoopFinalStatus;
  /** 阻塞原因（finalStatus != completed 时填写，描述具体阻塞点） */
  readonly blockedReason?: string;
}

// ============================================================================
// 9. PKC 知识库访问器协议
// ============================================================================

/**
 * PKC 知识库访问器协议
 *
 * 对应 EAG-P2 批次 9 设计 §4.1.2 PkcAccessor：
 * 解耦 PKC 实现细节，CODING Loop 仅依赖此协议而非 PKC 具体类。
 * 调用方负责注入具体实现（生产环境用真实 PKC，测试用 InMemoryPkcAccessor 真实实现）。
 *
 * 设计依据：依赖倒置原则（DIP）+ 测试禁令"禁止 mock PKC"（§8.4）。
 *
 * 实现方负责：
 * 1. queryL1GlobalView：返回模块聚类 + 入口点 + 爆炸半径 Top-N
 * 2. searchL2：基于自然语言查询返回相关符号命中列表
 * 3. queryL3BusinessKnowledge：返回 K2 流程图 / K3 ER 图 / K5 交互矩阵
 *
 * 调用方（ContextAssembler）负责：
 * 1. 装配 CodingContext.l1GlobalView / l2SemanticResults / l3BusinessKnowledge
 * 2. 对 L2 结果按 score 排序，仅取 Top-5；score < 0.5 的命中项过滤（§7 R7 风险缓解）
 */
export interface PkcAccessor {
  /**
   * 查询 L1 全局视野摘要
   *
   * @param projectRoot 项目根目录（绝对路径）
   * @returns L1 全局视野摘要（模块聚类 + 入口点 + 爆炸半径 Top-N）
   */
  queryL1GlobalView(projectRoot: string): Promise<Readonly<Record<string, unknown>>>;

  /**
   * 语义检索 L2（自然语言查询 → 符号命中列表）
   *
   * @param query 自然语言查询（如 "用户登录认证流程"）
   * @param projectRoot 项目根目录（绝对路径）
   * @param topK 返回的 Top-K 个命中项（默认 10，由调用方按需调整）
   * @returns 符号命中列表（按 score 降序）
   */
  searchL2(query: string, projectRoot: string, topK?: number): Promise<ReadonlyArray<SemanticSearchHit>>;

  /**
   * 查询 L3 业务知识（K2 流程图 / K3 ER 图 / K5 交互矩阵）
   *
   * @param projectRoot 项目根目录（绝对路径）
   * @returns L3 业务知识（K2/K3/K5 汇总为一个 Record）
   */
  queryL3BusinessKnowledge(projectRoot: string): Promise<Readonly<Record<string, unknown>>>;
}

// ============================================================================
// 10. 模板注册表协议
// ============================================================================

/**
 * 模板变量 Schema 协议
 *
 * 对应 EAG-P2 批次 9 设计 §4.2.6 TemplateRegistry.getVariableSchema：
 * 模板变量的运行时校验 schema，由 zod 实现。
 *
 * 设计依据（§4.2.2 关键技术决策）：
 * - 模板变量在运行时由任务卡 + plan.md 解析得来
 * - 需 schema 校验防 LLM 生成非法结构
 * - zod 已是 packages/core 依赖（package.json dependencies）
 *
 * 此处仅定义协议接口，具体 schema 由 templates/index.ts 中的 zod 对象实现。
 * 使用 unknown 索引签名避免本文件直接依赖 zod（保持 types.ts 零运行时依赖）。
 */
export interface TemplateVariableSchema {
  /**
   * 校验模板变量是否合法
   *
   * @param variables 待校验的模板变量对象
   * @returns 校验结果（success=true 时 data 为合法对象；success=false 时 errors 为错误列表）
   */
  validate(variables: Readonly<Record<string, unknown>>): {
    readonly success: boolean;
    readonly data?: Readonly<Record<string, unknown>>;
    readonly errors?: ReadonlyArray<string>;
  };
}

/**
 * 模板注册表协议
 *
 * 对应 EAG-P2 批次 9 设计 §4.2.6 TemplateRegistry：
 * 统一管理 13 种 TypeScript 模板的检索与变量校验。
 *
 * 实现方（DEFAULT_TEMPLATE_REGISTRY）负责：
 * 1. 从内嵌的 .ejs.ts 字符串常量中返回模板内容
 * 2. 列出所有已注册的 kind（13 种）
 * 3. 返回对应 kind 的 zod schema（封装为 TemplateVariableSchema 协议）
 *
 * 调用方（SkeletonGenerator）负责：
 * 1. 根据 ModuleSplit.responsibility 与 InterfaceContract 判定需要哪些 kind
 * 2. 从 TemplateRegistry 获取模板字符串与变量 schema
 * 3. 用 zod schema 校验模板变量
 * 4. 调用 ejs.render(templateString, variables) 渲染骨架
 */
export interface TemplateRegistry {
  /**
   * 按 kind 获取模板字符串
   *
   * @param kind 模板类型（13 种之一）
   * @returns EJS 模板字符串（含 <%- variable %> 变量与 <%_ // TODO(phase-b): ... _%> 占位）
   * @throws {Error} kind 未注册时抛出
   */
  getTemplate(kind: GeneratedFileKind): string;

  /**
   * 列出所有已注册的 kind
   *
   * @returns 已注册的 kind 列表（13 种，使用 Object.freeze 冻结）
   */
  listKinds(): ReadonlyArray<GeneratedFileKind>;

  /**
   * 获取模板变量 schema
   *
   * @param kind 模板类型
   * @returns 模板变量 zod schema（封装为 TemplateVariableSchema 协议）
   * @throws {Error} kind 未注册时抛出
   */
  getVariableSchema(kind: GeneratedFileKind): TemplateVariableSchema;
}

// ============================================================================
// 11. 评估器类型复用导出
// ============================================================================

/**
 * 复用 evaluator/types 中的 EvaluationContext 与 EvaluationMode
 *
 * CODING Loop 的 STRICT 评估器直接复用 EAG-P0 已定义的评估上下文与模式类型，
 * 避免类型重复定义。通过 re-export 让外部模块可从 coding/types 统一导入。
 */
export type { EvaluationContext, EvaluationMode };

// ============================================================================
// 12. 默认配置常量
// ============================================================================

/**
 * 默认最大填充轮次（单占位最多 2 次重试共 3 次调用）
 *
 * 数值依据（§4.4.2 关键技术决策）：
 * - 单占位最多 2 次重试（共 3 次调用）
 * - 3 次都失败则标记 failed 但不阻塞其他占位
 * - 最终由 STRICT 评估器判定整体是否可放行
 *
 * 使用 `as const` 字面量断言（数字本身已是不可变原始值，无需 Object.freeze）。
 */
export const DEFAULT_MAX_FILL_ROUNDS = 3 as const;

/**
 * 默认单文件最大 token 上限
 *
 * 数值依据（§4.4.2 关键技术决策）：
 * - 单文件 4000 tokens 上限
 * - 防止单次填充产生超长代码导致循环依赖
 * - 超限时拆分为多次调用
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MAX_TOKENS_PER_FILE = 4000 as const;

/**
 * 默认最大 FIX 轮次
 *
 * 数值依据（§5.2.3 CODING Loop 失败处理 + §5.12.2 失败上限纪律）：
 * - 连续 3 次 FIX 失败 → HUMAN_CHECKPOINT
 * - 3 轮上限硬约束，不可被 LLM 自改
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MAX_FIX_ROUNDS = 3 as const;

/**
 * 默认最大 CODING Loop 迭代次数
 *
 * 数值依据（§5.2.1 五步闭环上限保护）：
 * - 10 次迭代覆盖大多数企业任务的迭代需求
 * - 上限 1000（autonomous 模式），CODING Loop 默认 10
 * - 由 LoopGuard 强制执行，LLM 不可自改
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MAX_CODING_ITERATIONS = 10 as const;

/**
 * 默认 LLM 调用温度（代码生成场景）
 *
 * 数值依据（§4.4.2 关键技术决策）：
 * - 0.2 低温代码生成
 * - 代码生成需要确定性，避免高温度产生幻觉 API
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_CODE_GENERATION_TEMPERATURE = 0.2 as const;

/**
 * 默认单次 LLM 调用最大 token 上限
 *
 * 数值依据（§4.4.2 关键技术决策）：
 * - 单次 LLM 调用 8000 tokens 上限
 * - 防止单次填充产生超长代码导致循环依赖
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MAX_TOKENS_PER_LLM_CALL = 8000 as const;

/**
 * 默认 L2 语义检索 Top-K
 *
 * 数值依据（§4.3.2 上下文装配算法）：
 * - 默认取 Top-10 命中项
 * - ContextAssembler 进一步按 score 排序仅取 Top-5
 * - score < 0.5 的命中项过滤掉（§7 R7 风险缓解）
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_L2_SEARCH_TOP_K = 10 as const;

/**
 * L2 语义检索 score 过滤阈值
 *
 * 数值依据（§7 R7 风险缓解）：
 * - score < 0.5 的命中项过滤掉
 * - 避免低质量命中项引入噪声上下文
 *
 * 使用 `as const` 字面量断言。
 */
export const L2_SCORE_FILTER_THRESHOLD = 0.5 as const;

/**
 * FIX 循环上下文窗口：保留前 N 轮失败摘要
 *
 * 数值依据（§4.6.2 关键技术决策）：
 * - 每轮 FIX 携带前 2 轮失败摘要
 * - 避免重复犯错
 * - 最多保留最近 2 轮的失败摘要防 token 膨胀
 *
 * 使用 `as const` 字面量断言。
 */
export const FIX_CONTEXT_WINDOW_SIZE = 2 as const;

/**
 * 同一红线连续违反上限（触发 HUMAN_CHECKPOINT）
 *
 * 数值依据（§7 R3 FIX 不收敛风险缓解）：
 * - 同一红线连续 2 轮 violated → 强制 HUMAN_CHECKPOINT
 * - 避免 LLM 反复修复同一红线导致 FIX 循环不收敛
 *
 * 使用 `as const` 字面量断言。
 */
export const SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT = 2 as const;

/**
 * 默认配置汇总（含所有默认值的只读快照）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 * 调用方可从此处获取所有默认值，避免散落引用。
 */
export const CODING_DEFAULTS: Readonly<{
  readonly maxFillRounds: number;
  readonly maxTokensPerFile: number;
  readonly maxFixRounds: number;
  readonly maxCodingIterations: number;
  readonly codeGenerationTemperature: number;
  readonly maxTokensPerLlmCall: number;
  readonly l2SearchTopK: number;
  readonly l2ScoreFilterThreshold: number;
  readonly fixContextWindowSize: number;
  readonly sameRedlineConsecutiveViolationLimit: number;
}> = Object.freeze({
  maxFillRounds: DEFAULT_MAX_FILL_ROUNDS,
  maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_FILE,
  maxFixRounds: DEFAULT_MAX_FIX_ROUNDS,
  maxCodingIterations: DEFAULT_MAX_CODING_ITERATIONS,
  codeGenerationTemperature: DEFAULT_CODE_GENERATION_TEMPERATURE,
  maxTokensPerLlmCall: DEFAULT_MAX_TOKENS_PER_LLM_CALL,
  l2SearchTopK: DEFAULT_L2_SEARCH_TOP_K,
  l2ScoreFilterThreshold: L2_SCORE_FILTER_THRESHOLD,
  fixContextWindowSize: FIX_CONTEXT_WINDOW_SIZE,
  sameRedlineConsecutiveViolationLimit: SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT,
});

// ============================================================================
// 13. 工厂函数（统一返回 Object.freeze 冻结对象）
// ============================================================================

/**
 * 创建骨架生成请求（带字段校验 + 冻结）
 *
 * 工厂函数模式：调用方传入部分字段，工厂函数完成校验并 Object.freeze 冻结。
 *
 * 校验规则：
 * - planContent / tasksContent 必须为非空字符串
 * - taskDag 必须含 nodes 与 topologicalOrder
 * - taskCard 必须含 id / title / requirementId
 * - techStack 必须为数组
 * - projectRoot / outputDir 必须为非空字符串
 *
 * @param input 请求字段
 * @returns 冻结后的 SkeletonGenerationRequest 对象
 * @throws {SkeletonRequestError} 任一字段非法时抛出
 */
export function createSkeletonGenerationRequest(
  input: Readonly<SkeletonGenerationRequest>
): Readonly<SkeletonGenerationRequest> {
  // 字段合法性校验
  if (typeof input.planContent !== "string" || input.planContent.trim().length === 0) {
    throw new SkeletonRequestError("planContent", input.planContent, "必须为非空字符串");
  }
  if (typeof input.tasksContent !== "string" || input.tasksContent.trim().length === 0) {
    throw new SkeletonRequestError("tasksContent", input.tasksContent, "必须为非空字符串");
  }
  if (!input.taskDag || !Array.isArray(input.taskDag.nodes) || !Array.isArray(input.taskDag.topologicalOrder)) {
    throw new SkeletonRequestError("taskDag", input.taskDag, "必须含 nodes 与 topologicalOrder 数组");
  }
  if (!input.taskCard || typeof input.taskCard.id !== "string" || input.taskCard.id.trim().length === 0) {
    throw new SkeletonRequestError("taskCard", input.taskCard, "必须含非空 id 字段");
  }
  if (!Array.isArray(input.techStack)) {
    throw new SkeletonRequestError("techStack", input.techStack, "必须为数组");
  }
  if (typeof input.projectRoot !== "string" || input.projectRoot.trim().length === 0) {
    throw new SkeletonRequestError("projectRoot", input.projectRoot, "必须为非空字符串");
  }
  if (typeof input.outputDir !== "string" || input.outputDir.trim().length === 0) {
    throw new SkeletonRequestError("outputDir", input.outputDir, "必须为非空字符串");
  }

  return Object.freeze({
    planContent: input.planContent,
    tasksContent: input.tasksContent,
    taskDag: input.taskDag,
    taskCard: input.taskCard,
    techStack: Object.freeze([...input.techStack]),
    projectRoot: input.projectRoot,
    outputDir: input.outputDir,
  });
}

/**
 * 骨架生成请求校验错误
 *
 * 当 SkeletonGenerationRequest 的字段非法时抛出。
 */
export class SkeletonRequestError extends Error {
  /**
   * @param field 非法字段名
   * @param value 非法字段值
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`SkeletonGenerationRequest 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "SkeletonRequestError";
  }
}

/**
 * 创建 LLM 填充请求（带字段校验 + 冻结）
 *
 * @param input 请求字段
 * @returns 冻结后的 LlmFillRequest 对象
 * @throws {LlmFillRequestError} 任一字段非法时抛出
 */
export function createLlmFillRequest(input: Readonly<LlmFillRequest>): Readonly<LlmFillRequest> {
  if (!input.skeleton || !Array.isArray(input.skeleton.files)) {
    throw new LlmFillRequestError("skeleton", input.skeleton, "必须含 files 数组");
  }
  if (!input.context || !input.context.taskCard) {
    throw new LlmFillRequestError("context", input.context, "必须含 taskCard 字段");
  }
  if (!input.llmClient || typeof input.llmClient.createMessage !== "function") {
    throw new LlmFillRequestError("llmClient", input.llmClient, "必须实现 LLMClient 接口");
  }
  if (typeof input.maxRounds !== "number" || input.maxRounds < 1) {
    throw new LlmFillRequestError("maxRounds", input.maxRounds, "必须为 ≥1 的数字");
  }
  if (typeof input.maxTokensPerFile !== "number" || input.maxTokensPerFile < 1) {
    throw new LlmFillRequestError("maxTokensPerFile", input.maxTokensPerFile, "必须为 ≥1 的数字");
  }

  return Object.freeze({
    skeleton: input.skeleton,
    context: input.context,
    llmClient: input.llmClient,
    maxRounds: input.maxRounds,
    maxTokensPerFile: input.maxTokensPerFile,
  });
}

/**
 * LLM 填充请求校验错误
 */
export class LlmFillRequestError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`LlmFillRequest 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "LlmFillRequestError";
  }
}

/**
 * 创建 CODING Loop 编排请求（带字段校验 + 冻结）
 *
 * @param input 请求字段
 * @returns 冻结后的 CodingLoopRequest 对象
 * @throws {CodingLoopRequestError} 任一字段非法时抛出
 */
export function createCodingLoopRequest(input: Readonly<CodingLoopRequest>): Readonly<CodingLoopRequest> {
  if (typeof input.projectRoot !== "string" || input.projectRoot.trim().length === 0) {
    throw new CodingLoopRequestError("projectRoot", input.projectRoot, "必须为非空字符串");
  }
  if (typeof input.specContent !== "string" || input.specContent.trim().length === 0) {
    throw new CodingLoopRequestError("specContent", input.specContent, "必须为非空字符串");
  }
  if (typeof input.planContent !== "string" || input.planContent.trim().length === 0) {
    throw new CodingLoopRequestError("planContent", input.planContent, "必须为非空字符串");
  }
  if (typeof input.tasksContent !== "string" || input.tasksContent.trim().length === 0) {
    throw new CodingLoopRequestError("tasksContent", input.tasksContent, "必须为非空字符串");
  }
  if (!input.taskDag || !Array.isArray(input.taskDag.nodes)) {
    throw new CodingLoopRequestError("taskDag", input.taskDag, "必须含 nodes 数组");
  }
  if (!Array.isArray(input.taskCards) || input.taskCards.length === 0) {
    throw new CodingLoopRequestError("taskCards", input.taskCards, "必须为非空数组");
  }
  if (!Array.isArray(input.techStack)) {
    throw new CodingLoopRequestError("techStack", input.techStack, "必须为数组");
  }
  if (typeof input.constitutionContent !== "string" || input.constitutionContent.trim().length === 0) {
    throw new CodingLoopRequestError("constitutionContent", input.constitutionContent, "必须为非空字符串");
  }
  if (!input.llmClient || typeof input.llmClient.createMessage !== "function") {
    throw new CodingLoopRequestError("llmClient", input.llmClient, "必须实现 LLMClient 接口");
  }
  if (!input.pkcAccessor || typeof input.pkcAccessor.queryL1GlobalView !== "function") {
    throw new CodingLoopRequestError("pkcAccessor", input.pkcAccessor, "必须实现 PkcAccessor 接口");
  }
  if (!input.loopGuard || typeof input.loopGuard.check !== "function") {
    throw new CodingLoopRequestError("loopGuard", input.loopGuard, "必须为 LoopGuard 实例");
  }
  if (typeof input.maxIterations !== "number" || input.maxIterations < 1) {
    throw new CodingLoopRequestError("maxIterations", input.maxIterations, "必须为 ≥1 的数字");
  }
  if (typeof input.maxFixRounds !== "number" || input.maxFixRounds < 1) {
    throw new CodingLoopRequestError("maxFixRounds", input.maxFixRounds, "必须为 ≥1 的数字");
  }

  return Object.freeze({
    projectRoot: input.projectRoot,
    specContent: input.specContent,
    planContent: input.planContent,
    tasksContent: input.tasksContent,
    taskDag: input.taskDag,
    taskCards: Object.freeze([...input.taskCards]),
    techStack: Object.freeze([...input.techStack]),
    constitutionContent: input.constitutionContent,
    llmClient: input.llmClient,
    pkcAccessor: input.pkcAccessor,
    loopGuard: input.loopGuard,
    maxIterations: input.maxIterations,
    maxFixRounds: input.maxFixRounds,
  });
}

/**
 * CODING Loop 编排请求校验错误
 */
export class CodingLoopRequestError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`CodingLoopRequest 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "CodingLoopRequestError";
  }
}

// ============================================================================
// 14. 静态判定器协议（S2 判定器层共用契约）
// ============================================================================

/**
 * 静态判定器协议（StaticChecker Protocol）
 *
 * 对应 EAG-P2 批次 9 设计 §4.5.3 StaticChecker 协议定义：
 * 所有静态判定器（13 个 Checker 类）必须满足此接口。
 * STRICT 评估器按 redlineIds 路由到对应 Checker 实例，调用 check() 获得判定结果。
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单（静态可判 redline.checkType="static"）
 * - EAG-P2 批次 9 设计 §4.5.2 STRICT 评估策略：静态判定优先，LLM judge 仅在 reasoning + unknown 时调用
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单（13 个）
 *
 * 实现方（13 个 StaticChecker 子类）负责：
 * 1. 声明 redlineIds：该 Checker 负责的红线 ID 列表（如 ["E1"] / ["E4", "TCS-OSS-01"]）
 * 2. 实现 check(artifacts, redline)：对产出物逐文件扫描，返回 RedlineResult
 *
 * 调用方（StrictEvaluator）负责：
 * 1. 维护 redlineId → StaticChecker 实例的注册表（DEFAULT_STATIC_CHECKERS）
 * 2. 按红线 ID 路由到对应 Checker，调用 check(artifacts, redline)
 * 3. 收集所有 RedlineResult 汇总为 EvaluationReport
 *
 * 不可变优先原则：
 * - redlineIds 使用 ReadonlyArray<string>（运行期通过 Object.freeze 冻结）
 * - artifacts 参数使用 ReadonlyArray + readonly 字段
 * - redline 参数使用 Readonly<RedlineDefinition>
 * - 返回值 RedlineResult 在 checker-utils.ts 中通过 Object.freeze 冻结
 *
 * 范例：
 *   ```typescript
 *   export class SagaDetector implements StaticChecker {
 *     readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E1"]);
 *     check(artifacts, redline): RedlineResult {
 *       // 扫描跨聚合写调用...
 *       return violations.length > 0 ? buildViolations("E1", violations) : buildPass("E1");
 *     }
 *   }
 *   ```
 */
export interface StaticChecker {
  /** 该 Checker 负责的红线 ID 列表（运行期冻结，如 ["E1"] / ["E4", "TCS-OSS-01"]） */
  readonly redlineIds: ReadonlyArray<string>;

  /**
   * 执行静态判定
   *
   * 算法约束（§4.5.3）：
   * 1. 仅依赖 artifacts（产出物内容）与 redline（红线定义）做确定性判定
   * 2. 不调用 LLM、不读取外部状态、不产生副作用
   * 3. 返回值必须为冻结的 RedlineResult（通过 checker-utils.buildViolation / buildPass / buildUnknown 构建）
   *
   * @param artifacts 产出物列表（每个产出物含路径与内容）
   * @param redline 当前红线定义（评估器按 redlineIds 路由后传入）
   * @returns 判定结果（status="passed" / "violated" / "unknown"）
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult;
}
