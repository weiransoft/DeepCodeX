/**
 * DESIGN Loop 数据模型（EAG-P1 批次 3）
 *
 * 本模块定义 EAG 方案 §5.2.2 DESIGN Loop（设计循环）所需的全部结构化数据类型。
 * DESIGN Loop 的职责是：将原始业务需求（自然语言）通过 PM→架构师两阶段编排，
 * 产出 ARCHITECTURE.md（范式+分层+依赖规则）+ DOMAIN-MODEL.md（聚合/实体/值对象/领域事件），
 * 并由独立评估器按"范式一致性 / 设计完整性 / 反模式零命中"三要素判定是否通过。
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 DESIGN Loop（输入/角色编排/产出物/评估器判定/人工检查点）
 * - EAG 方案 §5.3 多角色编排层（PM / 架构师 / 独立评估器 三角色唤起知识）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * 命名冲突说明（重要）：
 * - EAG-P0 的 `eag/evaluator/types.ts` 已定义 `EvaluationVerdict` 为字符串字面量联合
 *   （"pass" | "fix" | "human_checkpoint" | "stop_failure"）用于 P0 IndependentEvaluator 协议产出。
 * - EAG-P1 批次 1 `eag/loop/models.ts` 已定义 `LoopEvaluationVerdict` 为结构化对象
 *   （含 passed/evaluatorId/reason/findings/severity/suggestedFix/sampledArtifacts）。
 * - 本模块定义 `DesignEvaluationVerdict` 作为 DESIGN Loop 专属评估器产出，
 *   字段语义对齐 P0 红线分级（blocker/major/warning），便于后续与 P0 评估器集成。
 *
 * @module eag/design/models
 */

import type { ParadigmId, ParadigmLockConfig, SignalEvidence, DependencyRule } from "../eak/types";

// ============================================================================
// 1. DESIGN Loop 输入与项目上下文
// ============================================================================

/**
 * DESIGN Loop 输入
 *
 * 对应 EAG 方案 §5.2.2 表格"输入"行：
 * - 原始业务需求（自然语言）
 * - 现有代码库上下文（增量场景，棕地项目时提供）
 *
 * paradigmLock 字段用于命令级覆盖范式选择（如 `/eag-design --paradigm cqrs-es`），
 * 优先级高于项目级 `.deepcode/eag.yml` 配置（由调用方在调用前合并）。
 */
export interface DesignLoopInput {
  /** 原始业务需求（自然语言，PM 据此结构化为用户故事+验收标准） */
  readonly rawRequirement: string;
  /** 棕地场景的现有代码库上下文（增量场景时提供，绿地场景省略） */
  readonly projectContext?: ProjectContext;
  /** 命令级覆盖范式锁定（如 `/eag-design --paradigm cqrs-es`，优先级高于配置文件） */
  readonly paradigmLock?: ParadigmLockConfig;
}

/**
 * 项目上下文（棕地场景）
 *
 * 当 DESIGN Loop 在已有项目上运行（增量场景）时，调用方需提供项目上下文，
 * 帮助架构师判断是否复用既有范式与领域模型。
 *
 * 绿地场景（新项目）时此字段省略，架构师从信号匹配开始选择范式。
 */
export interface ProjectContext {
  /** 项目根目录绝对路径 */
  readonly projectRoot: string;
  /** 既有范式（如有），架构师应优先沿用而非自主另选 */
  readonly existingParadigm?: ParadigmId;
  /** 既有领域模型文档 URI（如有），架构师应在其上增量扩展而非推倒重建 */
  readonly existingDomainModelUri?: string;
}

// ============================================================================
// 2. PM 产出：用户故事 + 验收标准 + 结构化需求
// ============================================================================

/**
 * 用户故事（PM 产出）
 *
 * 对应 EAG 方案 §5.3 产品经理角色的"用户故事模板"唤起知识：
 * - 角色（role）+ 动作（action）+ 价值（benefit）三段式
 * - 验收标准（acceptanceCriteria）使用 Gherkin Given/When/Then 语法
 * - 领域事件候选（domainEventCandidates）作为架构师设计领域事件的输入
 *
 * 范例：
 *   id: "US-001"
 *   role: "订单管理员"
 *   action: "创建订单"
 *   benefit: "跟踪订单状态"
 *   acceptanceCriteria: [{ id: "AC-001", given: "客户已登录", when: "提交订单", then: "订单状态为待支付" }]
 *   domainEventCandidates: ["OrderCreatedEvent"]
 */
export interface UserStory {
  /** 用户故事唯一标识（如 "US-001"） */
  readonly id: string;
  /** 角色（如 "订单管理员"） */
  readonly role: string;
  /** 动作（如 "创建订单"） */
  readonly action: string;
  /** 价值/收益（如 "跟踪订单状态"） */
  readonly benefit: string;
  /** Gherkin 验收标准列表（每条含 Given/When/Then 三段） */
  readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
  /** 领域事件候选名列表（如 ["OrderCreatedEvent"]，供架构师设计领域事件时参考） */
  readonly domainEventCandidates: ReadonlyArray<string>;
}

/**
 * 验收标准（Gherkin 语法）
 *
 * 对应 EAG 方案 §5.3 产品经理角色的"验收标准 Gherkin 语法"唤起知识。
 * Gherkin 三段式：Given（前置条件）→ When（触发动作）→ Then（预期结果）。
 */
export interface AcceptanceCriterion {
  /** 验收标准唯一标识（如 "AC-001"） */
  readonly id: string;
  /** 前置条件（Given） */
  readonly given: string;
  /** 触发动作（When） */
  readonly when: string;
  /** 预期结果（Then） */
  readonly then: string;
}

/**
 * 领域词汇（PM 产出，供架构师统一术语）
 *
 * 领域词汇表是 PM 在结构化需求阶段从原始需求中抽取的术语清单，
 * 用于消除歧义——同名异义、同义异名都会导致架构师误判领域边界。
 */
export interface DomainTerm {
  /** 术语（如 "订单"） */
  readonly term: string;
  /** 定义（明确术语在当前业务上下文中的含义） */
  readonly definition: string;
  /** 同义词列表（如 ["订单单据", "Order"]，用于后续术语统一） */
  readonly synonyms: ReadonlyArray<string>;
}

/**
 * 非功能需求分类
 *
 * 5 个分类对齐业界常见非功能需求维度，覆盖性能/安全/可用/可扩展/一致性。
 * 字面量联合避免拼写错误，分类的语义由 description 描述。
 */
export type NonFunctionalCategory = "performance" | "security" | "availability" | "scalability" | "consistency";

/**
 * 非功能需求（PM 产出）
 *
 * 非功能需求影响架构师范式选择——例如：
 * - consistency=strong + scalability=high → 倾向 CQRS+ES 范式
 * - availability=high + scalability=high → 倾向微服务范式
 */
export interface NonFunctionalRequirement {
  /** 非功能需求唯一标识（如 "NFR-001"） */
  readonly id: string;
  /** 分类（performance/security/availability/scalability/consistency） */
  readonly category: NonFunctionalCategory;
  /** 描述（如 "P99 延迟 < 200ms"） */
  readonly description: string;
}

/**
 * PM 结构化需求产出（对应 EAG 方案 §5.3 的 structured-requirement.json）
 *
 * PM 角色的核心交付物——将原始自然语言需求结构化为：
 * - 用户故事列表（含验收标准 + 领域事件候选）
 * - 领域词汇表（消除术语歧义）
 * - 非功能需求列表（影响范式选择）
 *
 * 此产出作为架构师角色的输入，驱动范式选择与领域模型设计。
 */
export interface StructuredRequirement {
  /** 用户故事列表（每条含角色/动作/价值/验收标准/领域事件候选） */
  readonly userStories: ReadonlyArray<UserStory>;
  /** 领域词汇表（消除术语歧义） */
  readonly domainGlossary: ReadonlyArray<DomainTerm>;
  /** 非功能需求列表（影响范式选择） */
  readonly nonFunctionalRequirements: ReadonlyArray<NonFunctionalRequirement>;
}

// ============================================================================
// 3. 架构师产出：ARCHITECTURE.md + DOMAIN-MODEL.md 内容模型
// ============================================================================

/**
 * 限界上下文（架构师产出，ARCHITECTURE.md 章节 2）
 *
 * 对应 DDD 战略设计的限界上下文（Bounded Context）概念：
 * 每个限界上下文对应一个业务子域，内部含若干聚合，对外通过领域事件/API 集成。
 *
 * 微服务范式下，限界上下文通常对应一个微服务边界。
 */
export interface BoundedContext {
  /** 上下文名称（如 "订单上下文"） */
  readonly name: string;
  /** 职责描述（说明该上下文负责的业务能力） */
  readonly responsibility: string;
  /** 聚合名清单（如 ["OrderAggregate", "PaymentAggregate"]） */
  readonly aggregates: ReadonlyArray<string>;
}

/**
 * 分层定义（架构师产出，ARCHITECTURE.md 章节 3）
 *
 * 描述范式采用的分层结构，每层的职责与允许依赖的层。
 * 与 dependencyRules 配合——layering 描述"是什么"，dependencyRules 描述"不能违反什么"。
 *
 * 范例（DDD 分层）：
 *   - name: "domain", responsibility: "领域模型", allowedDependencies: []
 *   - name: "application", responsibility: "应用编排", allowedDependencies: ["domain"]
 *   - name: "interfaces", responsibility: "接口适配", allowedDependencies: ["application", "domain"]
 *   - name: "infrastructure", responsibility: "基础设施", allowedDependencies: ["domain", "application"]
 */
export interface LayerDefinition {
  /** 层名称（如 "domain"、"application"、"interfaces"、"infrastructure"） */
  readonly name: string;
  /** 职责描述（说明该层承担的职责） */
  readonly responsibility: string;
  /** 允许依赖的层名列表（未列入的层不得依赖） */
  readonly allowedDependencies: ReadonlyArray<string>;
}

/**
 * 架构师产出：ARCHITECTURE.md 内容模型
 *
 * 对应 EAG 方案 §5.2.2 产出物 ARCHITECTURE.md（范式+分层+依赖规则）。
 * 包含范式选择理由、信号证据、限界上下文、分层、依赖规则五部分。
 *
 * 设计约束（评估器据此判定）：
 * - selectedParadigmId 必须为 4 个合法范式 ID 之一
 * - dependencyRules 应引用范式库中该范式的 dependencyRules（保持一致性）
 * - signalEvidence 在自主选择时必须非空（非锁定场景）
 */
export interface ArchitectureDocument {
  /** 选中的范式 ID（4 个范式之一） */
  readonly selectedParadigmId: ParadigmId;
  /** 范式选择理由（架构师用自然语言说明为何选此范式） */
  readonly paradigmRationale: string;
  /**
   * 信号判定证据（架构师打分理由，引用需求原文片段）。
   * 键为信号维度名（如 "domainComplexity"），值为需求原文片段。
   * 自主选择时（非 paradigm_lock 锁定）必须非空，否则评估器打回。
   */
  readonly signalEvidence: SignalEvidence;
  /** 限界上下文列表（ARCHITECTURE.md 章节 2） */
  readonly boundedContexts: ReadonlyArray<BoundedContext>;
  /** 分层定义列表（ARCHITECTURE.md 章节 3） */
  readonly layering: ReadonlyArray<LayerDefinition>;
  /**
   * 依赖规则列表（ARCHITECTURE.md 章节 4）。
   * 应直接引用所选范式的 dependencyRules，评估器据此判定 layering 是否违反。
   */
  readonly dependencyRules: ReadonlyArray<DependencyRule>;
}

/**
 * 属性定义（领域模型构件的属性）
 *
 * 用于实体/值对象/领域事件等构件的属性描述。
 */
export interface AttributeDefinition {
  /** 属性名（如 "orderId"） */
  readonly name: string;
  /** 属性类型（如 "string"、"number"、"MoneyVO"、"OrderId"） */
  readonly type: string;
  /** 是否必填（true=必填，false=可选） */
  readonly required: boolean;
}

/**
 * 行为定义（实体的业务方法，避免贫血模型）
 *
 * 对应 EAG 方案 §5.1.3 红线 E7"贫血模型禁令"——
 * 实体必须内聚业务方法，业务逻辑不得散落在 Service 层。
 * 每个行为可能触发领域事件（publishedEvents）。
 */
export interface BehaviorDefinition {
  /** 方法名（如 "confirmPayment"） */
  readonly name: string;
  /** 行为描述（说明该方法的业务语义） */
  readonly description: string;
  /** 触发的领域事件列表（如 ["OrderConfirmedEvent"]） */
  readonly publishedEvents: ReadonlyArray<string>;
}

/**
 * 聚合定义（架构师产出，DOMAIN-MODEL.md 章节 1）
 *
 * 聚合是 DDD 战术设计的核心——一组相关实体与值对象的集合，
 * 通过聚合根（rootEntity）对外暴露，保证内部一致性不变式。
 *
 * 范例：
 *   name: "OrderAggregate"
 *   rootEntity: "OrderEntity"
 *   invariants: ["订单总金额必须等于所有订单项金额之和"]
 *   containedEntities: ["OrderLineEntity"]
 *   valueObjects: ["MoneyVO", "AddressVO"]
 *   publishedEvents: ["OrderCreatedEvent", "OrderConfirmedEvent"]
 */
export interface AggregateDefinition {
  /** 聚合名（如 "OrderAggregate"，须以 Aggregate 后缀） */
  readonly name: string;
  /** 聚合根实体名（如 "OrderEntity"） */
  readonly rootEntity: string;
  /** 不变式清单（聚合内一致性约束，如订单总金额必须等于明细之和） */
  readonly invariants: ReadonlyArray<string>;
  /** 聚合内实体列表（不含聚合根本身） */
  readonly containedEntities: ReadonlyArray<string>;
  /** 关联值对象列表 */
  readonly valueObjects: ReadonlyArray<string>;
  /** 发布的领域事件列表 */
  readonly publishedEvents: ReadonlyArray<string>;
}

/**
 * 实体定义（架构师产出，DOMAIN-MODEL.md 章节 2）
 *
 * 实体是有唯一标识的领域对象，包含属性与业务方法。
 * 聚合根是一种特殊实体，负责维护聚合内一致性。
 *
 * 范例：
 *   name: "OrderEntity"
 *   aggregate: "OrderAggregate"
 *   attributes: [{ name: "orderId", type: "OrderId", required: true }]
 *   behaviors: [{ name: "confirm", description: "确认订单", publishedEvents: ["OrderConfirmedEvent"] }]
 */
export interface EntityDefinition {
  /** 实体名（如 "OrderEntity"） */
  readonly name: string;
  /** 所属聚合格（如 "OrderAggregate"） */
  readonly aggregate: string;
  /** 属性列表 */
  readonly attributes: ReadonlyArray<AttributeDefinition>;
  /** 业务方法列表（避免贫血模型，必须非空） */
  readonly behaviors: ReadonlyArray<BehaviorDefinition>;
}

/**
 * 值对象定义（架构师产出，DOMAIN-MODEL.md 章节 3）
 *
 * 值对象是无唯一标识的不可变领域对象，通过所有属性相等性判断同一性。
 * 范例：MoneyVO、AddressVO、OrderId。
 *
 * immutabilityGuarantee 字段说明不可变性保证机制（如"所有字段 readonly + 构造后无 setter"）。
 */
export interface ValueObjectDefinition {
  /** 值对象名（如 "MoneyVO"） */
  readonly name: string;
  /** 属性列表 */
  readonly attributes: ReadonlyArray<AttributeDefinition>;
  /** 不可变性保证说明（描述如何保证不可变） */
  readonly immutabilityGuarantee: string;
}

/**
 * 领域事件定义（架构师产出，DOMAIN-MODEL.md 章节 4）
 *
 * 领域事件描述领域中已发生的业务事实，采用过去式命名（如 OrderCreatedEvent）。
 * 由聚合根发布，由订阅者消费（如投影器、Saga 编排器、审计系统）。
 *
 * 范例：
 *   name: "OrderCreatedEvent"
 *   publisher: "OrderAggregate"
 *   subscribers: ["OrderProjection", "InventorySaga"]
 *   payload: [{ name: "orderId", type: "OrderId", required: true }]
 */
export interface DomainEventDefinition {
  /** 事件名（如 "OrderCreatedEvent"，须以 Event 后缀） */
  readonly name: string;
  /** 发布者聚合名（如 "OrderAggregate"） */
  readonly publisher: string;
  /** 订阅者列表（如 ["OrderProjection", "InventorySaga"]） */
  readonly subscribers: ReadonlyArray<string>;
  /** 事件负载属性列表 */
  readonly payload: ReadonlyArray<AttributeDefinition>;
}

/**
 * 架构师产出：DOMAIN-MODEL.md 内容模型
 *
 * 对应 EAG 方案 §5.2.2 产出物 DOMAIN-MODEL.md（聚合/实体/值对象/领域事件）。
 * 包含四部分：聚合清单、实体清单、值对象清单、领域事件清单。
 */
export interface DomainModelDocument {
  /** 聚合清单（DOMAIN-MODEL.md 章节 1） */
  readonly aggregates: ReadonlyArray<AggregateDefinition>;
  /** 实体清单（DOMAIN-MODEL.md 章节 2） */
  readonly entities: ReadonlyArray<EntityDefinition>;
  /** 值对象清单（DOMAIN-MODEL.md 章节 3） */
  readonly valueObjects: ReadonlyArray<ValueObjectDefinition>;
  /** 领域事件清单（DOMAIN-MODEL.md 章节 4） */
  readonly domainEvents: ReadonlyArray<DomainEventDefinition>;
}

// ============================================================================
// 4. DESIGN Loop 完整产出与评估判定
// ============================================================================

/**
 * DESIGN Loop 完整产出
 *
 * 包含 PM 产出（StructuredRequirement）+ 架构师产出（ArchitectureDocument + DomainModelDocument），
 * 作为评估器输入与最终交付物。
 */
export interface DesignArtifacts {
  /** PM 产出：结构化需求 */
  readonly structuredRequirement: StructuredRequirement;
  /** 架构师产出：架构设计文档 */
  readonly architectureDocument: ArchitectureDocument;
  /** 架构师产出：领域模型文档 */
  readonly domainModelDocument: DomainModelDocument;
}

/**
 * DESIGN 评估器严重级别（对齐 P0 红线分级）
 *
 * 与 P0 `RedlineSeverity` 保持一致：
 * - blocker：阻断级，必须修复，不可豁免
 * - major：重要级，打回但可人工豁免
 * - warning：警告级，仅提示不打回
 */
export type DesignVerdictSeverity = "blocker" | "major" | "warning";

/**
 * DESIGN Loop 评估器判定结果
 *
 * 命名说明（重要）：
 * - P0 `eag/evaluator/types.ts` 已定义 `EvaluationVerdict` 为字符串字面量联合（"pass"|"fix"|...）
 * - 批次 1 `eag/loop/models.ts` 已定义 `LoopEvaluationVerdict` 为结构化对象（含 evaluatorId/findings 等）
 * - 本模块定义 `DesignEvaluationVerdict` 作为 DESIGN Loop 专属评估器产出，
 *   字段语义对齐 P0 红线分级（blocker/major/warning），便于后续与 P0 评估器集成。
 *
 * 判定逻辑（由 DesignEvaluatorProtocol 实现方提供）：
 * - passed=true：全部判定项通过（范式一致性 + 设计完整性 + 反模式零命中 + 证据强制）
 * - passed=false：存在 blocker 或 major 级问题，需架构师修正后重试
 * - severity：最高问题级别（passed=true 时为 "info" 之外的最低级别）
 */
export interface DesignEvaluationVerdict {
  /** 是否通过（true=全部判定项通过，false=存在问题需修正） */
  readonly passed: boolean;
  /** 判定理由（人类可读，包含具体哪条判定项通过/失败） */
  readonly reason: string;
  /** 严重级别（blocker/major/warning，passed=true 时为 warning） */
  readonly severity: DesignVerdictSeverity;
  /** 发现的问题清单（每条描述一个具体问题，供架构师修正参考） */
  readonly findings: ReadonlyArray<string>;
  /** 建议修复方案（架构师据此修正设计文档） */
  readonly suggestedFix: string;
}

/**
 * DESIGN Loop 结果
 *
 * 编排器（DesignLoopOrchestrator）执行完整 DESIGN Loop 后的最终产出，
 * 包含输入、产出物、评估判定、人工检查点状态、迭代次数五部分。
 */
export interface DesignLoopResult {
  /** DESIGN Loop 输入（原始需求 + 项目上下文 + 范式锁定） */
  readonly input: DesignLoopInput;
  /** DESIGN Loop 完整产出（PM + 架构师产出） */
  readonly artifacts: DesignArtifacts;
  /** 评估器最终判定（最后一轮的判定结果） */
  readonly evaluationVerdict: DesignEvaluationVerdict;
  /** 是否触发了人工检查点（§5.2.2 要求设计文档生成后默认触发 1 次 HUMAN_CHECKPOINT） */
  readonly humanCheckpointTriggered: boolean;
  /** 实际迭代次数（1=一次通过，>1=有重试） */
  readonly iterations: number;
}

// ============================================================================
// 5. DESIGN Loop 配置
// ============================================================================

/**
 * DESIGN Loop 评估模式
 *
 * - strict：严格模式，任一判定项失败即打回（EAG 默认）
 * - lenient：宽松模式，仅 blocker 级问题打回（实验性，不推荐生产）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type DesignEvaluationMode = "strict" | "lenient";

/**
 * DESIGN Loop 配置
 *
 * 字段说明：
 * - maxIterations：最大迭代次数（默认 3，评估失败后重新调用架构师的上限）
 * - triggerHumanCheckpoint：是否在设计文档生成后触发人工检查点（默认 true，§5.2.2 要求）
 * - evaluationMode：评估模式（默认 strict）
 *
 * 不可变保证：通过 createDefaultDesignLoopConfig 工厂函数 Object.freeze 冻结。
 */
export interface DesignLoopConfig {
  /** 最大迭代次数（默认 3，必须 >= 1） */
  readonly maxIterations: number;
  /** 是否触发人工检查点（默认 true，§5.2.2 要求设计决策需人确认） */
  readonly triggerHumanCheckpoint: boolean;
  /** 评估模式（默认 strict，EAG 默认模式） */
  readonly evaluationMode: DesignEvaluationMode;
}

/**
 * 默认 DESIGN Loop 配置常量
 *
 * 数值依据：
 * - maxIterations=3：DESIGN Loop 评估失败重试上限，3 次足够覆盖"评估→修正→再评估"循环
 * - triggerHumanCheckpoint=true：§5.2.2 明确要求"设计文档生成后默认触发 1 次 HUMAN_CHECKPOINT"
 * - evaluationMode="strict"：EAG 默认 STRICT 模式（保守策略）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
export const DEFAULT_DESIGN_LOOP_CONFIG: Readonly<DesignLoopConfig> = Object.freeze({
  maxIterations: 3,
  triggerHumanCheckpoint: true,
  evaluationMode: "strict",
});

/**
 * DESIGN Loop 配置校验错误
 *
 * 当 DesignLoopConfig 的字段非法时抛出。
 */
export class DesignLoopConfigError extends Error {
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
    super(`DesignLoopConfig 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "DesignLoopConfigError";
  }
}

/**
 * 创建默认 DESIGN Loop 配置（带字段校验 + 冻结）
 *
 * 工厂函数模式：调用方传入部分字段覆盖默认值，工厂函数完成校验并 Object.freeze 冻结。
 *
 * 校验规则：
 * - maxIterations 必须为整数且 >= 1
 * - triggerHumanCheckpoint 必须为 boolean
 * - evaluationMode 必须为 "strict" 或 "lenient" 之一
 *
 * @param overrides 覆盖字段（缺省字段使用 DEFAULT_DESIGN_LOOP_CONFIG）
 * @returns 冻结后的配置对象
 * @throws {DesignLoopConfigError} 任一字段非法时抛出
 */
export function createDefaultDesignLoopConfig(overrides?: Partial<DesignLoopConfig>): Readonly<DesignLoopConfig> {
  // 合并默认值与覆盖值
  const merged: DesignLoopConfig = {
    ...DEFAULT_DESIGN_LOOP_CONFIG,
    ...overrides,
  };

  // 字段合法性校验
  if (!Number.isInteger(merged.maxIterations) || merged.maxIterations < 1) {
    throw new DesignLoopConfigError("maxIterations", merged.maxIterations, "必须为整数且 >= 1");
  }
  if (typeof merged.triggerHumanCheckpoint !== "boolean") {
    throw new DesignLoopConfigError("triggerHumanCheckpoint", merged.triggerHumanCheckpoint, "必须为 boolean");
  }
  if (merged.evaluationMode !== "strict" && merged.evaluationMode !== "lenient") {
    throw new DesignLoopConfigError("evaluationMode", merged.evaluationMode, '必须为 "strict" 或 "lenient" 之一');
  }

  return Object.freeze(merged);
}
