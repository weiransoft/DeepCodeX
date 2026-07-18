/**
 * EDM（Enterprise Data Model，企业通用域模型包）核心类型定义
 *
 * 本模块定义 EAG 方案 §5.7 企业通用域模型包的全部结构化数据类型，作为
 * EDM 模块的最底层数据契约。EDM 将企业应用 80% 的公共内核（用户/组织/权限等）
 * 建模为可复用领域模块包，DESIGN Loop 检测到企业应用需求信号时自动纳入领域模型，
 * 业务域只需建模差异化部分。
 *
 * 设计依据：
 * - EAG 方案 §5.7 企业通用域模型包
 * - §5.7.1 公共内核五域（用户域/组织域/角色域/功能权限域/数据权限域）
 * - §5.7.2 EDM 纳入机制（信号检测 + 骨架模板 + 领域模型 + 迁移脚本三件套）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 联合类型使用字面量联合 + ReadonlyArray 常量
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * 设计原则：
 * - EDM 域定义是"结构化数据包"——可被骨架生成器消费生成与业务域同层同规范的源码
 * - 5 个域 ID 字面量联合，避免字符串拼写错误
 * - 信号词 + 检测证据分离：信号词是判定依据，证据是审计依据
 * - 红线判定器是表驱动的纯函数，禁止 mock/simulated
 *
 * @module eag/edm/types
 */

// ============================================================================
// 1. 域 ID 与基础结构
// ============================================================================

/**
 * EDM 域 ID（5 个公共内核域，字面量联合类型）
 *
 * - user：用户域（账号生命周期 + 凭证 + 密码策略）
 * - org：组织域（组织树物化路径 + 左右值 + 岗位）
 * - role：角色域（角色继承 + SoD 互斥约束）
 * - permission：功能权限域（菜单/API/按钮三级资源）
 * - data-scope：数据权限域（行级五级 + 列级脱敏 + 查询改写）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误，对齐 §5.12.4 配置冻结原则。
 */
export type EdmDomainId = "user" | "org" | "role" | "permission" | "data-scope";

/**
 * EdmDomainId 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序同时作为信号检测时的优先级遍历顺序
 * （user → org → role → permission → data-scope）。
 */
export const EDM_DOMAIN_IDS: ReadonlyArray<EdmDomainId> = Object.freeze([
  "user",
  "org",
  "role",
  "permission",
  "data-scope",
]);

/**
 * 属性定义（用于值对象与领域事件的载荷字段）
 *
 * 描述领域模型中的属性，包括名称、类型、是否必填。
 * 字段全部 readonly——属性定义一旦发布即不可变。
 */
export interface EdmAttributeDefinition {
  /** 属性名（如 "username" / "phone" / "roleIds"） */
  readonly name: string;
  /** 属性类型（如 "string" / "number" / "Date" / "ReadonlyArray<string>"） */
  readonly type: string;
  /** 是否必填（true 表示聚合创建/更新时必须提供，false 表示可选） */
  readonly required: boolean;
}

// ============================================================================
// 2. 聚合 / 值对象 / 领域事件定义
// ============================================================================

/**
 * 聚合定义（EDM 域的核心构件）
 *
 * 描述 DDD 战术设计中的聚合，包括聚合根实体、不变式约束、内部实体、值对象、发布的领域事件。
 *
 * 设计依据：
 * - EAG 方案 §5.7.1 各域聚合的核心设计决策
 * - DDD 聚合根一致性边界原则：聚合内强一致，聚合间最终一致
 *
 * 字段全部 readonly——聚合定义一旦发布即不可变。
 */
export interface EdmAggregateDefinition {
  /** 聚合名称（如 "UserAggregate"、"OrgUnitAggregate"） */
  readonly name: string;
  /** 聚合根实体名（如 "UserEntity"、"OrgUnitEntity"） */
  readonly rootEntity: string;
  /**
   * 不变式约束列表（聚合必须维持的一致性规则）
   * 如 "账号状态转换必须符合生命周期状态机"、"组织树不得出现循环引用"
   */
  readonly invariants: ReadonlyArray<string>;
  /** 聚合内包含的实体列表（不含聚合根本身，如 ["PositionEntity", "ReportingLineEntity"]） */
  readonly containedEntities: ReadonlyArray<string>;
  /** 聚合关联的值对象列表（如 ["CredentialVO", "UserProfileVO"]） */
  readonly valueObjects: ReadonlyArray<string>;
  /** 聚合发布的领域事件列表（如 ["UserCreatedEvent", "UserActivatedEvent"]） */
  readonly publishedEvents: ReadonlyArray<string>;
}

/**
 * 值对象定义
 *
 * 描述 DDD 战术设计中的值对象，包括属性列表与不可变性保证说明。
 * 值对象无唯一标识，通过属性值比对相等性，构造后不可变。
 *
 * 字段全部 readonly——值对象定义一旦发布即不可变。
 */
export interface EdmValueObjectDefinition {
  /** 值对象名称（如 "CredentialVO"、"MaterializedPathVO"） */
  readonly name: string;
  /** 属性列表（如 [{ name: "phone", type: "string", required: true }]） */
  readonly attributes: ReadonlyArray<EdmAttributeDefinition>;
  /** 不可变性保证说明（如 "构造后所有字段 readonly，Object.freeze 冻结"） */
  readonly immutabilityGuarantee: string;
}

/**
 * 领域事件定义
 *
 * 描述聚合发布的事件，包括发布者、订阅者、载荷字段。
 * 领域事件是聚合间解耦通信的核心机制，发布者无需知道订阅者。
 *
 * 字段全部 readonly——事件定义一旦发布即不可变。
 */
export interface EdmDomainEventDefinition {
  /** 事件名称（如 "UserCreatedEvent"、"OrgChangedEvent"） */
  readonly name: string;
  /** 发布者（聚合名，如 "UserAggregate"） */
  readonly publisher: string;
  /** 订阅者列表（如 ["PermissionCacheInvalidator", "AuditLogHandler"]） */
  readonly subscribers: ReadonlyArray<string>;
  /** 事件载荷字段（如 [{ name: "userId", type: "string", required: true }]） */
  readonly payload: ReadonlyArray<EdmAttributeDefinition>;
}

// ============================================================================
// 3. EDM 域定义
// ============================================================================

/**
 * EDM 域定义（EAG 核心数据结构）
 *
 * 每个域是一个结构化数据包，包含：
 * - 唯一标识与描述
 * - 聚合列表（域内聚合根及其不变式）
 * - 值对象列表（域内值对象及其属性）
 * - 领域事件列表（域内事件及其发布订阅关系）
 * - 信号词列表（触发该域纳入的关键词）
 *
 * 设计依据：EAG 方案 §5.7.1 公共内核五域定义。
 *
 * 字段全部 readonly——域定义一旦发布即不可变，对齐 §5.12.4 配置冻结原则。
 */
export interface EdmDomainDefinition {
  /** 域 ID（5 个公共内核域之一） */
  readonly id: EdmDomainId;
  /** 域名称（中文，如 "用户域"、"组织域"） */
  readonly name: string;
  /** 域描述（详细说明域的职责与设计决策） */
  readonly description: string;
  /** 域内聚合定义列表 */
  readonly aggregates: ReadonlyArray<EdmAggregateDefinition>;
  /** 域内值对象定义列表 */
  readonly valueObjects: ReadonlyArray<EdmValueObjectDefinition>;
  /** 域内领域事件定义列表 */
  readonly domainEvents: ReadonlyArray<EdmDomainEventDefinition>;
  /**
   * 触发该域纳入的信号词列表
   *
   * DESIGN Loop 的 Discovery 阶段扫描需求文本，命中信号词即建议纳入该域。
   * 如用户域信号词：["登录", "账号", "用户", "密码", "凭证", "注册"]
   */
  readonly signalKeywords: ReadonlyArray<string>;
}

// ============================================================================
// 4. 信号检测结果
// ============================================================================

/**
 * EDM 信号检测结果
 *
 * EdmSignalDetector.detect() 的产出，记录检测到的域、命中的信号词与原文片段、
 * 建议纳入的域（架构师可裁剪）。
 *
 * 字段全部 readonly——检测结果一旦产出即不可变，作为审计依据。
 *
 * 设计依据：EAG 方案 §5.7.2 信号检测机制。
 */
export interface EdmDetectionResult {
  /** 检测到的域列表（命中信号词的域） */
  readonly detectedDomains: ReadonlyArray<EdmDomainId>;
  /**
   * 检测证据（每个域命中的信号词与原文片段）
   *
   * 结构：键为域 ID，值为证据片段列表（信号词周围的文本片段）。
   * 用于架构师审计检测合理性，避免误判。
   */
  readonly evidence: Readonly<Record<EdmDomainId, ReadonlyArray<string>>>;
  /**
   * 建议纳入的域列表
   *
   * 默认等于 detectedDomains，架构师可在 DESIGN Loop 的人工检查点裁剪
   * （如纯内部工具可去掉数据权限域）。
   */
  readonly suggestedDomains: ReadonlyArray<EdmDomainId>;
}

// ============================================================================
// 5. 红线 ID 与违反记录
// ============================================================================

/**
 * EDM 红线 ID（3 条专属红线，字面量联合类型）
 *
 * - EDM-01：权限判定不得仅在前端（BLOCKER）
 *   理由：前端权限判定可被绕过（用户篡改 SPA 代码或直接调 API），必须后端服务层校验
 * - EDM-02：数据权限查询改写必须覆盖全部列表查询接口（MAJOR）
 *   理由：未覆盖的接口将成为数据越权漏洞，攻击者可通过未改写的接口访问无权数据
 * - EDM-03：角色互斥约束必须在授权时校验（MAJOR）
 *   理由：SoD（职责分离）是企业内控核心约束，授权时未校验将导致一人多权舞弊
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type EdmRedlineId = "EDM-01" | "EDM-02" | "EDM-03";

/**
 * EdmRedlineId 全部合法值（用于运行时枚举与测试断言）
 */
export const EDM_REDLINE_IDS: ReadonlyArray<EdmRedlineId> = Object.freeze(["EDM-01", "EDM-02", "EDM-03"]);

/**
 * 红线严重级别
 *
 * - BLOCKER：不可豁免，必须修复（如 EDM-01 前端-only 权限判定）
 * - MAJOR：可人工豁免，但默认打回（如 EDM-02/03）
 *
 * 与 EAG-P0 `eag/evaluator/types.ts` 的 RedlineSeverity 对齐（大写形式以匹配 §5.7.2 表述）。
 */
export type EdmRedlineSeverity = "BLOCKER" | "MAJOR";

/**
 * 红线违反记录
 *
 * 每条记录描述一次红线违反的具体位置和详情，供评估器汇总为修复建议。
 *
 * 字段全部 readonly——违反记录一旦产出即不可变，作为审计依据。
 */
export interface EdmRedlineViolation {
  /** 红线 ID（EDM-01/02/03 之一） */
  readonly id: EdmRedlineId;
  /** 严重级别（BLOCKER/MAJOR） */
  readonly severity: EdmRedlineSeverity;
  /** 违反详情（中文，说明违反的具体场景与原因） */
  readonly message: string;
  /** 违反位置（如 "前端代码 /api/permissions/check"、"列表接口 GET /api/orders"） */
  readonly location: string;
}

/**
 * EDM 红线元数据（ID → 级别映射，用于表驱动判定）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 * 红线判定器据此确定每条红线的严重级别，避免硬编码。
 */
export const EDM_REDLINE_SEVERITY_MAP: Readonly<Record<EdmRedlineId, EdmRedlineSeverity>> = Object.freeze({
  "EDM-01": "BLOCKER",
  "EDM-02": "MAJOR",
  "EDM-03": "MAJOR",
});

// ============================================================================
// 6. 深度冻结辅助函数
// ============================================================================

/**
 * 深度冻结对象（递归冻结所有嵌套对象与数组）
 *
 * Object.freeze 是浅冻结——仅冻结顶层属性，嵌套对象/数组仍可变。
 * EDM 域定义包含多层嵌套结构（aggregates/valueObjects/domainEvents/signalKeywords 等），
 * 必须深度冻结才能保证整个域定义树运行期不可变，对齐 §5.12.4 G-A6d 配置冻结原则。
 *
 * 算法：
 * 1. 遍历对象的所有自有属性
 * 2. 若属性值为对象或数组且未被冻结，递归调用 deepFreeze
 * 3. 调用 Object.freeze 冻结当前对象
 * 4. 返回冻结后的对象（与输入同引用，便于链式调用）
 *
 * 注意：
 * - 已冻结对象跳过递归，避免重复冻结（Object.freeze 对已冻结对象是幂等的，但递归浪费）
 * - 非对象（null/undefined/原始类型）直接返回，不冻结
 * - 不处理循环引用（EDM 域定义是树形结构，无循环引用）
 *
 * @param obj 待冻结的对象
 * @returns 冻结后的对象（与输入同引用）
 */
export function deepFreeze<T>(obj: T): T {
  // 非对象或 null 直接返回
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // 已冻结对象跳过，避免重复递归
  if (Object.isFrozen(obj)) {
    return obj;
  }

  // 遍历所有自有属性，递归冻结嵌套对象/数组
  const keys = Object.keys(obj as Record<string, unknown>);
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object") {
      deepFreeze(value);
    }
  }

  // 冻结当前对象
  return Object.freeze(obj);
}
