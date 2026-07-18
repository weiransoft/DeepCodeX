/**
 * 企业架构知识层（EAK, Enterprise Architecture Knowledge）核心类型定义
 *
 * 本模块定义 EAG 方案 §5.1 企业架构知识层的全部结构化数据类型，作为
 * EAG 体系的最底层数据契约。所有范式定义、Skill 元数据、paradigm_lock
 * 配置均基于本模块的类型构建。
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 架构范式库（Architecture Paradigm Registry）
 * - EAG 方案 §5.1.2 模式 Skill 包（Pattern Skill Packs）
 * - EAG 方案 §5.1.3 企业红线清单（与 redlines 模块正交，本模块仅定义范式侧数据）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 联合类型使用字面量联合 + ReadonlyArray 常量
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * 设计原则：
 * - 范式定义是"结构化数据包"而非硬编码 prompt——模型通过查表获得范式约束
 * - 4 个范式 ID 字面量联合，避免字符串拼写错误
 * - 适用信号 + 信号证据分离：信号是判定依据，证据是审计依据
 * - 多语言骨架模板按 language 参数化，首版覆盖 TypeScript/Java/Python/Go
 *
 * @module eag/eak/types
 */

// ============================================================================
// 1. 范式 ID 与适用信号
// ============================================================================

/**
 * 范式 ID（4 个范式，字面量联合类型）
 *
 * - ddd-layered：DDD 分层架构（interfaces/application/domain/infrastructure 四层）
 * - clean-architecture：Clean Architecture（entities/use-cases/adapters/frameworks 同心圆）
 * - cqrs-es：CQRS + Event Sourcing（命令/查询分离 + 事件溯源 + 投影重建）
 * - microservice：微服务（服务边界=限界上下文 + API Gateway + Saga 编排）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误，对齐 §5.12.4 配置冻结原则。
 */
export type ParadigmId = "ddd-layered" | "clean-architecture" | "cqrs-es" | "microservice";

/**
 * ParadigmId 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序同时作为
 * selectParadigm 信号平分时的优先级判定顺序（ddd-layered > clean-architecture > cqrs-es > microservice）。
 */
export const PARADIGM_IDS: ReadonlyArray<ParadigmId> = Object.freeze([
  "ddd-layered",
  "clean-architecture",
  "cqrs-es",
  "microservice",
]);

/**
 * 适用信号（架构师据此选择范式）
 *
 * 4 个独立维度，覆盖业务复杂度、一致性要求、读写模式、集成复杂度。
 * 每个维度的取值是有限集合（字面量联合），便于打分比对。
 *
 * 字段全部 readonly——信号一旦判定即不可变，作为审计依据。
 */
export interface ApplicabilitySignals {
  /** 业务复杂度：实体关系丰富程度与领域规则密度 */
  readonly domainComplexity: "low" | "medium" | "high";
  /** 一致性要求：强一致 / 最终一致可接受 */
  readonly consistencyRequirement: "strong" | "eventual";
  /** 读写比例特征：读写均衡 / 读远多于写 / 写密集 */
  readonly readWritePattern: "balanced" | "read-heavy" | "write-heavy";
  /** 集成复杂度：单体 / 少量外部集成 / 多系统集成 */
  readonly integrationComplexity: "monolith" | "few-integrations" | "many-systems";
}

/**
 * 信号判定证据（架构师打分理由，引用需求原文，供评估器抽检）
 *
 * EAG 方案 §5.1.1 范式选择防误判机制要求"证据强制"——自主选择时
 * 架构师必须在 signalEvidence 中引用需求原文作为打分依据，
 * 评估器在 DESIGN Loop 验证阶段对"信号→范式"映射做合理性抽检，
 * 证据缺失即打回。
 *
 * 结构：键为信号维度名（如 "domainComplexity"），值为需求原文片段。
 * 使用 Readonly<Record> 保证整个记录不可变。
 */
export type SignalEvidence = Readonly<Record<string, string>>;

// ============================================================================
// 2. 目录骨架模板与依赖规则
// ============================================================================

/**
 * 支持的目标语言（首版覆盖 TypeScript/Java/Python/Go，对齐 CodeMap 多语言能力）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type SkeletonLanguage = "typescript" | "java" | "python" | "go";

/**
 * SkeletonLanguage 全部合法值（用于运行时枚举与测试断言）
 */
export const SKELETON_LANGUAGES: ReadonlyArray<SkeletonLanguage> = Object.freeze([
  "typescript",
  "java",
  "python",
  "go",
]);

/**
 * 目录骨架模板（按语言参数化）
 *
 * 每个范式为每种支持的语言提供一份骨架模板，描述目录结构、入口文件、配置文件。
 * 骨架生成器（eag/skeleton/skeleton-generator.ts）将基于此模板确定性生成项目骨架。
 *
 * 字段全部 readonly——模板一旦定义即不可变，避免运行期被篡改导致骨架漂移。
 */
export interface SkeletonTemplate {
  /** 目标语言 */
  readonly language: SkeletonLanguage;
  /** 目录列表（如 ["src/domain", "src/application", ...]），按依赖方向由内到外排列 */
  readonly directories: ReadonlyArray<string>;
  /** 入口文件清单（路径 + 用途说明，用于骨架生成器创建空文件壳） */
  readonly entryFiles: ReadonlyArray<{
    /** 文件路径（相对项目根，如 "src/domain/order/aggregate.ts"） */
    readonly path: string;
    /** 文件用途说明（中文，用于生成文件头注释） */
    readonly purpose: string;
  }>;
  /** 配置文件路径（如 "tsconfig.json" / "pom.xml" / "pyproject.toml" / "go.mod"） */
  readonly configFile: string;
}

/**
 * 依赖规则（评估器据此判定，如"domain 层不得 import infrastructure"）
 *
 * 依赖规则是范式一致性的核心约束，评估器在 CODING Loop 的 Verification 阶段
 * 对产出物逐条判定。规则按 fromLayer → forbiddenToLayers 的方向定义。
 *
 * 字段全部 readonly——规则一旦定义即不可变，避免运行期被篡改导致评估器误判。
 */
export interface DependencyRule {
  /** 规则唯一 ID（如 "DEP-DOM-01"） */
  readonly id: string;
  /** 规则描述（中文，详细说明禁止的依赖方向与原因） */
  readonly description: string;
  /** 源层名称（如 "domain"、"entities"、"command-side"） */
  readonly fromLayer: string;
  /** 禁止依赖的目标层列表（如 ["infrastructure", "application", "interfaces"]） */
  readonly forbiddenToLayers: ReadonlyArray<string>;
  /** 严重级别：blocker 不可豁免 / major 可人工豁免 / warning 仅提示 */
  readonly severity: "blocker" | "major" | "warning";
}

// ============================================================================
// 3. 命名规范与反模式
// ============================================================================

/**
 * 命名规范的元素类型（聚合根/实体/值对象/领域事件/应用服务/仓储/工厂）
 *
 * 字面量联合，覆盖 DDD 战术设计的主要构件。
 */
export type NamingElement =
  | "aggregate-root"
  | "entity"
  | "value-object"
  | "domain-event"
  | "application-service"
  | "repository"
  | "factory";

/**
 * 命名规范（如聚合根 XxxAggregate、领域事件 XxxEvent）
 *
 * 命名规范是范式一致性的辅助约束，评估器据此检查类名/文件名是否符合范式约定。
 *
 * 字段全部 readonly——规范一旦定义即不可变。
 */
export interface NamingConvention {
  /** 元素类型（聚合根/实体/值对象/领域事件/应用服务/仓储/工厂） */
  readonly element: NamingElement;
  /** 命名模式（正则或描述，如 "XxxAggregate" / "XxxEvent" / "XxxRepository"） */
  readonly pattern: string;
  /** 规范描述（中文，说明命名约定的原因与适用场景） */
  readonly description: string;
}

/**
 * 反模式（评估器据此扣分）
 *
 * 反模式是范式违反的典型场景清单，评估器在 CODING/TESTING Loop 的
 * Verification 阶段对产出物逐条判定。命中反模式即扣分。
 *
 * 字段全部 readonly——反模式一旦定义即不可变。
 */
export interface AntiPattern {
  /** 反模式唯一 ID（如 "AP-ANEMIC-01"） */
  readonly id: string;
  /** 反模式名称（如 "anemic-domain-model" / "shared-database-microservice"） */
  readonly name: string;
  /** 反模式描述（中文，详细说明反模式的表现与危害） */
  readonly description: string;
  /** 判定方式：static 静态可判 / reasoning 推理判定（需 LLM 阅读代码理解语义） */
  readonly detection: "static" | "reasoning";
  /** 严重级别：blocker 不可豁免 / major 可人工豁免 / warning 仅提示 */
  readonly severity: "blocker" | "major" | "warning";
}

// ============================================================================
// 4. 范式定义与 paradigm_lock 配置
// ============================================================================

/**
 * 企业架构范式定义（EAG 核心数据结构）
 *
 * 每个范式是一个结构化数据包，包含：
 * - 唯一标识与描述
 * - 适用信号（架构师据此选择范式）
 * - 信号证据（自主选择时强制引用需求原文）
 * - 多语言骨架模板（首版 4 语言）
 * - 依赖规则（评估器据此判定依赖方向）
 * - 命名规范（评估器据此检查命名一致性）
 * - 反模式（评估器据此扣分）
 *
 * 设计依据：EAG 方案 §5.1.1 架构范式库定义。
 *
 * 字段全部 readonly——范式定义一旦发布即不可变，对齐 §5.12.4 配置冻结原则。
 */
export interface ArchitectureParadigm {
  /** 范式 ID（4 个范式之一） */
  readonly id: ParadigmId;
  /** 范式名称（中文，便于审计日志与人类阅读） */
  readonly name: string;
  /** 范式描述（中文，详细说明范式的核心理念与典型适用场景） */
  readonly description: string;
  /** 适用信号（架构师角色据此选择，打分时必须附需求文本证据） */
  readonly applicabilitySignals: ApplicabilitySignals;
  /** 信号判定证据（架构师打分理由，引用需求原文，供评估器抽检） */
  readonly signalEvidence?: SignalEvidence;
  /** 多语言骨架模板列表（每个语言一份） */
  readonly skeletonTemplates: ReadonlyArray<SkeletonTemplate>;
  /** 依赖规则列表（评估器据此判定依赖方向） */
  readonly dependencyRules: ReadonlyArray<DependencyRule>;
  /** 命名规范列表（评估器据此检查命名一致性） */
  readonly namingConventions: ReadonlyArray<NamingConvention>;
  /** 反模式列表（评估器据此扣分） */
  readonly antiPatterns: ReadonlyArray<AntiPattern>;
}

/**
 * paradigm_lock 配置（组织范式锁定机制）
 *
 * EAG 方案 §5.1.1 范式选择防误判机制要求"组织范式锁定"——
 * `.deepcode/eag.yml` 配置 `paradigm_lock: clean-architecture` 后，
 * 架构师跳过信号判定直接采用锁定范式。
 *
 * 企业有既定架构规范时防止模型"自主另选"引发事故。
 *
 * 字段全部 readonly——配置一旦加载即不可变。
 */
export interface ParadigmLockConfig {
  /** 是否锁定范式（true 时架构师跳过信号判定） */
  readonly locked: boolean;
  /** 锁定的范式 ID（locked=true 时必填，locked=false 时为 null） */
  readonly paradigmId: ParadigmId | null;
  /** 锁定原因（如"组织规范要求" / "既定架构标准"，用于审计日志） */
  readonly reason: string;
}
