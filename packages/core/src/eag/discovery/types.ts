/**
 * 棕地 Discovery 数据模型（EAG 方案 §6.2）
 *
 * 本模块定义 EAG 方案 §6.2「棕地场景：既有系统增量改造」所需的全部结构化数据类型。
 * 棕地 Discovery 的职责是：推断现有代码库的领域模型，作为 DESIGN Loop 的既有模型基线，
 * 在增量设计中标注「新增/修改/不动」三类变更，由既有契约保护判定器确保不破坏现有契约。
 *
 * 设计依据：
 * - EAG 方案 §6.2 棕地场景执行流（Discovery 增强 → DESIGN Loop 增量设计 → CODING Loop → TESTING Loop → 交付）
 * - EAG 方案 §6.2 棕地专属评估规则（既有契约保护判定 + 范式漂移记录为技术债而非打回）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层常量使用 Object.freeze 冻结
 *
 * @module eag/discovery/types
 */

// ============================================================================
// 1. 变更类型：ChangeType
// ============================================================================

/**
 * 变更类型（字面量联合类型）
 *
 * 对应 EAG 方案 §6.2 增量设计的三类变更标注：
 * - add：新增（既有代码库中不存在，新需求要求新增的变更项）
 * - modify：修改（既有代码库中存在，新需求要求修改的变更项）
 * - unchanged：不动（既有代码库中存在，新需求未涉及的变更项，保留以维护完整性）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type ChangeType = "add" | "modify" | "unchanged";

/**
 * 变更类型全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const CHANGE_TYPES: ReadonlyArray<ChangeType> = Object.freeze(["add", "modify", "unchanged"]);

// ============================================================================
// 2. 既有模型快照：ExistingModelSnapshot
// ============================================================================

/**
 * 既有模型快照
 *
 * 推断现有代码库的领域模型，作为 DESIGN Loop 的既有模型基线。
 * 由 BrownfieldDiscovery.discover() 产出，传递给 DESIGN Loop 做增量设计。
 *
 * 字段语义：
 * - aggregates：既有聚合名清单（如 ["OrderAggregate", "PaymentAggregate"]）
 * - entities：既有实体名清单
 * - valueObjects：既有值对象名清单
 * - domainEvents：既有领域事件名清单（如 ["OrderCreatedEvent", "PaymentSucceededEvent"]）
 * - boundedContexts：既有限界上下文名清单
 * - existingFiles：既有文件路径清单（用于变更分类与文件修改纪律判定）
 */
export interface ExistingModelSnapshot {
  /** 既有聚合名清单 */
  readonly aggregates: ReadonlyArray<string>;
  /** 既有实体名清单 */
  readonly entities: ReadonlyArray<string>;
  /** 既有值对象名清单 */
  readonly valueObjects: ReadonlyArray<string>;
  /** 既有领域事件名清单 */
  readonly domainEvents: ReadonlyArray<string>;
  /** 有限界上下文名清单 */
  readonly boundedContexts: ReadonlyArray<string>;
  /** 既有文件路径清单 */
  readonly existingFiles: ReadonlyArray<string>;
}

// ============================================================================
// 3. 增量变更：IncrementalChange
// ============================================================================

/**
 * 增量变更
 *
 * 增量设计结果中的单个变更项，对应 EAG 方案 §6.2「新增/修改/不动」三类变更标注。
 *
 * 字段语义：
 * - name：变更项名称（如 "RefundAggregate"、"OrderService.cancel()"）
 * - changeType：变更类型（add/modify/unchanged）
 * - filePath：变更文件路径（modify/unchanged 时必填，add 时可选——新增文件路径）
 * - reason：变更理由（说明为何 add/modify/unchanged，供 HUMAN_CHECKPOINT 审查）
 */
export interface IncrementalChange {
  /** 变更项名称（如 "RefundAggregate"、"OrderService.cancel()"） */
  readonly name: string;
  /** 变更类型（add/modify/unchanged） */
  readonly changeType: ChangeType;
  /** 变更文件路径（modify/unchanged 时必填，add 时可选） */
  readonly filePath?: string;
  /** 变更理由（说明为何 add/modify/unchanged） */
  readonly reason: string;
}

// ============================================================================
// 4. 增量设计结果：IncrementalDesignResult
// ============================================================================

/**
 * 增量设计结果
 *
 * BrownfieldDiscovery.discover() 的产出，对应 EAG 方案 §6.2 DESIGN Loop 增量设计阶段。
 * 设计文档标注「新增/修改/不动」三类变更，由 HUMAN_CHECKPOINT 审查后进入 CODING Loop。
 *
 * 字段语义：
 * - addedChanges：新增变更列表（changeType="add"）
 * - modifiedChanges：修改变更列表（changeType="modify"）
 * - unchangedChanges：不动变更列表（changeType="unchanged"）
 * - existingModelSnapshot：既有模型快照（作为设计基线）
 */
export interface IncrementalDesignResult {
  /** 新增变更列表 */
  readonly addedChanges: ReadonlyArray<IncrementalChange>;
  /** 修改变更列表 */
  readonly modifiedChanges: ReadonlyArray<IncrementalChange>;
  /** 不动变更列表 */
  readonly unchangedChanges: ReadonlyArray<IncrementalChange>;
  /** 既有模型快照 */
  readonly existingModelSnapshot: ExistingModelSnapshot;
}

// ============================================================================
// 5. 契约违反：ContractViolation
// ============================================================================

/**
 * 契约违反类型（字面量联合类型）
 *
 * 对应 EAG 方案 §6.2 棕地专属评估规则的三类契约保护判定：
 * - api-contract：API 契约违反（破坏现有 API 契约，如修改公开方法签名）
 * - file-modification：文件修改纪律违反（改动未标注「修改」的文件）
 * - paradigm-drift：范式漂移（新代码与存量范式不一致）
 *
 * 注：paradigm-drift 仅记录为技术债而非打回（§6.2 棕地专属评估规则）。
 */
export type ContractViolationType = "api-contract" | "file-modification" | "paradigm-drift";

/**
 * 契约违反类型全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const CONTRACT_VIOLATION_TYPES: ReadonlyArray<ContractViolationType> = Object.freeze([
  "api-contract",
  "file-modification",
  "paradigm-drift",
]);

/**
 * 契约违反
 *
 * 由 ExistingContractGuard 的判定方法产出，记录具体的契约违反信息。
 *
 * 字段语义：
 * - type：违反类型（api-contract/file-modification/paradigm-drift）
 * - message：违反详情（人类可读的描述）
 * - location：违反位置（文件路径或 API 名称）
 */
export interface ContractViolation {
  /** 违反类型 */
  readonly type: ContractViolationType;
  /** 违反详情 */
  readonly message: string;
  /** 违反位置（文件路径或 API 名称） */
  readonly location: string;
}

// ============================================================================
// 6. 技术债报告：TechDebtReport
// ============================================================================

/**
 * 技术债报告
 *
 * 对应 EAG 方案 §6.2 棕地专属评估规则：
 * 「存量违例记录为技术债报告而非打回」。
 *
 * 当既有代码范式与目标范式不一致时（如老系统是贫血模型），
 * 生成的新代码遵循目标范式，但不强制重构存量——
 * 评估器仅对当轮产出文件执行红线判定，存量违例记录为技术债报告。
 *
 * 字段语义：
 * - violations：违例列表（每条含规则名、位置、描述）
 * - recommendation：建议（如「建议在后续迭代中重构 OrderService 为充血模型」）
 */
export interface TechDebtReport {
  /** 违例列表 */
  readonly violations: ReadonlyArray<{
    /** 违反的规则名 */
    readonly rule: string;
    /** 违反位置 */
    readonly location: string;
    /** 违反描述 */
    readonly description: string;
  }>;
  /** 建议（如「建议在后续迭代中重构 OrderService 为充血模型」） */
  readonly recommendation: string;
}
