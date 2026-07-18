/**
 * ETSB（Enterprise Tech Stack Blueprint，企业技术栈蓝图）数据模型
 *
 * 本模块定义 EAG 方案 §5.6（技术选型与企业架构蓝图）所需的全部结构化数据类型。
 * ETSB 是 DESIGN Loop 的前置阶段——技术选型不是每次临时决策，而是从选型矩阵中
 * 按需求信号推导 + 架构师裁定 + 用户确认，选定后受 SEED-06 规则锁定
 * （未经用户批准严禁变更）。
 *
 * 设计依据：
 * - EAG 方案 §5.6.1 技术选型矩阵（4 语言 × 10 层 = 40 单元格）
 * - EAG 方案 §5.6.2 部署蓝图（三套拓扑模板：前后端分离单体 / BFF 微服务 / 云原生微服务）
 * - EAG 方案 §5.6 选型决策流程（需求信号 → 矩阵候选过滤 → 决策表 → HUMAN_CHECKPOINT → 锁定）
 * - EAG 方案 SEED-06 规则（技术栈锁定后变更必须用户显式批准）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/etsb/types
 */

// ============================================================================
// 1. 技术语言与层（字面量联合，避免拼写错误）
// ============================================================================

/**
 * 技术语言（4 语言，字面量联合类型）
 *
 * 对齐 §5.6.1 技术选型矩阵的 4 列：
 * - typescript：TypeScript 系（前端 + NestJS/Express 后端）
 * - java：Java 系（Spring Boot 3）
 * - python：Python 系（FastAPI / Django）
 * - go：Go 系（Gin / go-zero）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误，对齐 §5.12.4 配置冻结原则。
 */
export type TechLanguage = "typescript" | "java" | "python" | "go";

/**
 * TechLanguage 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序同时作为
 * TechStackSelector 默认优先级判定顺序（typescript > java > python > go）。
 */
export const TECH_LANGUAGES: ReadonlyArray<TechLanguage> = Object.freeze(["typescript", "java", "python", "go"]);

/**
 * 技术层（10 层，字面量联合类型）
 *
 * 对齐 §5.6.1 技术选型矩阵的 10 行：
 * - frontend：前端（React/Vue 等）
 * - backend-framework：后端框架（NestJS/Spring Boot/FastAPI/Gin）
 * - orm：ORM/数据访问（Prisma/MyBatis-Plus/SQLAlchemy/GORM）
 * - cache：缓存（Redis/Caffeine）
 * - message-queue：消息队列（BullMQ/Kafka/RocketMQ/Celery）
 * - object-storage：对象存储（S3 SDK/OSS SDK/boto3/MinIO）
 * - search：搜索（Elasticsearch/Meilisearch）
 * - task-scheduler：任务调度（node-cron/XXL-Job/APScheduler/cron）
 * - auth：认证授权（JWT/Passport/Spring Security/OAuthlib/Casbin）
 * - api-contract：API 契约（OpenAPI/springdoc-openapi/FastAPI 原生/swaggo）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type TechLayer =
  | "frontend"
  | "backend-framework"
  | "orm"
  | "cache"
  | "message-queue"
  | "object-storage"
  | "search"
  | "task-scheduler"
  | "auth"
  | "api-contract";

/**
 * TechLayer 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序对齐 §5.6.1 表格行序。
 */
export const TECH_LAYERS: ReadonlyArray<TechLayer> = Object.freeze([
  "frontend",
  "backend-framework",
  "orm",
  "cache",
  "message-queue",
  "object-storage",
  "search",
  "task-scheduler",
  "auth",
  "api-contract",
]);

// ============================================================================
// 2. 技术选型矩阵数据模型
// ============================================================================

/**
 * 单个技术选项（矩阵单元格中的一个候选项）
 *
 * 每个选项代表一种具体的技术方案（如 "React 18 + TypeScript + Ant Design"）。
 * 矩阵单元格按 priority 升序排列，priority=1 为首选，priority=2 为备选。
 *
 * 字段全部 readonly——选项一旦定义即不可变。
 */
export interface TechStackOption {
  /**
   * 技术方案名称（如 "React 18 + TypeScript + Ant Design"）
   * 必须为非空字符串，对齐 §5.6.1 表格中的具体技术描述
   */
  readonly name: string;
  /**
   * 推荐优先级（1=首选，2=备选，数值越小优先级越高）
   * 矩阵单元格的 options 按 priority 升序排列
   */
  readonly priority: number;
  /**
   * 备注（如 "DDD 亲和"），说明该方案的特点或适用场景
   * 可选字段，部分方案无特殊备注
   */
  readonly notes?: string;
}

/**
 * 矩阵单元格（某语言 × 某层的全部候选选项）
 *
 * 单元格由 language 与 layer 唯一索引，options 按 priority 升序排列。
 * options 至少包含 1 个选项（首选），可包含多个备选。
 *
 * 对于 Java/Python/Go 的 frontend 层，由于这些语言无原生前端框架，
 * options 包含一个指向"前后端分离，前端采用 TypeScript 系方案"的选项
 * （对齐企业级实践：Java/Python/Go 后端搭配 TS 前端）。
 */
export interface TechStackMatrixCell {
  /** 语言维度（4 语言之一） */
  readonly language: TechLanguage;
  /** 层维度（10 层之一） */
  readonly layer: TechLayer;
  /** 候选选项列表（按 priority 升序，至少 1 个选项） */
  readonly options: ReadonlyArray<TechStackOption>;
}

/**
 * 完整技术选型矩阵（4 语言 × 10 层 = 40 单元格）
 *
 * 矩阵采用嵌套 Record 结构：language → layer → options[]
 * 查询时通过 matrix.cells[language][layer] 获取该单元格的候选选项列表。
 *
 * 使用 Readonly<Record<...>> 三层嵌套保证编译期不可变。
 * 顶层常量 TECH_STACK_MATRIX 使用 Object.freeze 冻结（在 registry 模块实现）。
 *
 * 设计说明：
 * - 嵌套 Record 比 Map 更适合静态数据，TypeScript 类型推导更友好
 * - 4 语言 × 10 层 = 40 单元格的规模下，Record 查询性能足够
 * - 嵌套结构便于按语言或按层维度遍历
 */
export interface TechStackMatrix {
  /**
   * 矩阵单元格集合（嵌套 Record：language → layer → options）
   * 每个单元格的 options 按 priority 升序排列
   */
  readonly cells: Readonly<Record<TechLanguage, Readonly<Record<TechLayer, ReadonlyArray<TechStackOption>>>>>;
}

// ============================================================================
// 3. 技术选型决策表
// ============================================================================

/**
 * 单层选型决策（架构师对某层的最终选型产出）
 *
 * 每层决策包含：
 * - 选中方案（selectedOption）
 * - 选型理由（reason，基于需求信号 + 矩阵内容生成）
 * - 备选方案列表（alternatives，未选中但可考虑的方案）
 * - 风险清单（risks，该选型可能带来的风险）
 *
 * 对齐 §5.6.1 决策流程："每项含选型理由 + 备选 + 风险"。
 */
export interface TechStackDecision {
  /** 决策对应的层（10 层之一） */
  readonly layer: TechLayer;
  /** 选中方案（矩阵中该层的一个 option，可能经信号调整后改变首选） */
  readonly selectedOption: TechStackOption;
  /** 选型理由（中文，基于需求信号 + 矩阵内容生成，供用户审计） */
  readonly reason: string;
  /** 备选方案列表（矩阵中该层未选中的其他 option，按 priority 排序） */
  readonly alternatives: ReadonlyArray<TechStackOption>;
  /** 风险清单（中文，描述该选型可能带来的技术风险或注意事项） */
  readonly risks: ReadonlyArray<string>;
}

/**
 * 完整技术选型决策表（10 层各一条决策）
 *
 * 架构师根据需求信号从矩阵中推导出的完整选型方案，
 * 经 HUMAN_CHECKPOINT 用户确认后写入 .deepcode/eag.yml tech_stack 段并锁定。
 *
 * 对齐 §5.6.1："架构师产出《技术选型决策表》（每项含选型理由 + 备选 + 风险）
 * → HUMAN_CHECKPOINT 用户确认 → 写入 .deepcode/eag.yml 的 tech_stack 段并锁定"。
 *
 * 字段说明：
 * - language：决策表对应的主语言（4 语言之一）
 * - decisions：10 层各一条决策（按 TECH_LAYERS 顺序）
 * - humanConfirmed：HUMAN_CHECKPOINT 确认状态（true=用户已确认，false=待确认）
 */
export interface TechStackDecisionTable {
  /** 决策表对应的主语言（4 语言之一） */
  readonly language: TechLanguage;
  /** 10 层各一条决策（按 TECH_LAYERS 顺序排列） */
  readonly decisions: ReadonlyArray<TechStackDecision>;
  /** HUMAN_CHECKPOINT 用户确认状态（true=已确认，false=待确认） */
  readonly humanConfirmed: boolean;
}

// ============================================================================
// 4. 部署蓝图（Deployment Blueprints）
// ============================================================================

/**
 * 部署蓝图 ID（3 套蓝图，字面量联合类型）
 *
 * 对齐 §5.6.2 三套拓扑模板：
 * - spa-monolith：前后端分离单体（SPA + 单后端 + 单库 + Redis）
 * - bff-microservice：BFF 微服务（SPA → BFF 层 → 2~5 个领域服务 + 消息队列）
 * - cloud-native-microservice：云原生微服务（API Gateway + N 服务 + 服务发现 + 配置中心 + 链路追踪）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type DeploymentBlueprintId = "spa-monolith" | "bff-microservice" | "cloud-native-microservice";

/**
 * DeploymentBlueprintId 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序对齐 §5.6.2 表格行序。
 */
export const DEPLOYMENT_BLUEPRINT_IDS: ReadonlyArray<DeploymentBlueprintId> = Object.freeze([
  "spa-monolith",
  "bff-microservice",
  "cloud-native-microservice",
]);

/**
 * 部署蓝图（一套完整的部署拓扑模板）
 *
 * 每套蓝图描述一种部署架构的拓扑结构、适用信号与组件清单，
 * 供架构师根据需求信号选择最匹配的部署方案。
 *
 * 对齐 §5.6.2 表格：蓝图 ID + 拓扑描述 + 适用信号 + 组件清单。
 *
 * 字段全部 readonly——蓝图一旦定义即不可变，避免运行期被篡改导致部署漂移。
 */
export interface DeploymentBlueprint {
  /** 蓝图唯一 ID（3 套蓝图之一） */
  readonly id: DeploymentBlueprintId;
  /** 蓝图中文名称（如 "前后端分离单体"） */
  readonly name: string;
  /** 拓扑描述（中文，详细说明组件间连接关系与数据流） */
  readonly topology: string;
  /** 适用信号列表（中文，描述该蓝图适用的业务场景信号） */
  readonly applicabilitySignals: ReadonlyArray<string>;
  /** 组件清单（中文，列出该蓝图包含的全部基础设施组件） */
  readonly components: ReadonlyArray<string>;
}

// ============================================================================
// 5. SEED-06 技术栈锁定
// ============================================================================

/**
 * SEED-06 技术栈锁定状态
 *
 * 技术选型决策表经用户确认后写入 .deepcode/eag.yml 的 tech_stack 段并锁定，
 * 锁定后任何变更必须用户显式批准（SEED-06 规则）。
 *
 * 评估器在 CODING Loop 监测 package.json/pom.xml 等依赖文件变更，
 * 发现与锁定栈不符的依赖即打回。
 *
 * 字段说明：
 * - locked：是否已锁定（true=锁定，false=已解锁）
 * - decisionTable：锁定的决策表（锁定时必填）
 * - lockedAt：锁定时间戳（ISO 8601 格式，如 "2026-07-18T10:30:00.000Z"）
 * - lockedBy：锁定操作人（用户名或角色名，用于审计日志）
 *
 * 字段全部 readonly——锁定状态一旦设定即不可变，变更需通过 unlockTechStack 重新生成。
 */
export interface TechStackLock {
  /** 是否已锁定（true=锁定状态，false=已解锁） */
  readonly locked: boolean;
  /** 锁定的决策表（locked=true 时为决策表副本，locked=false 时仍保留原决策表供审计） */
  readonly decisionTable: TechStackDecisionTable;
  /** 锁定时间戳（ISO 8601 格式，解锁后保留原锁定时间供审计） */
  readonly lockedAt: string;
  /** 锁定操作人（用户名或角色名） */
  readonly lockedBy: string;
}

// ============================================================================
// 6. 选型输入信号
// ============================================================================

/**
 * 技术选型输入信号（架构师据此从矩阵推导决策表）
 *
 * 对齐 §5.6.1 选型决策流程："需求信号（并发量/团队栈存量/部署环境/合规要求）→ 矩阵候选过滤"。
 *
 * 4 个信号维度：
 * - language：主语言（必填，决定矩阵的列维度）
 * - concurrency：并发量信号（low/medium/high，影响 message-queue 选型）
 * - teamStackLegacy：团队栈存量（已有语言栈，可能覆盖 input.language）
 * - deployEnv：部署环境（single-server/cluster/cloud-native，影响蓝图选择）
 * - compliance：合规要求（general/strict，影响 auth 层选型）
 *
 * 除 language 外其他信号可选，缺省时使用矩阵默认首选（priority=1）。
 */
export interface TechStackSelectionInput {
  /** 主语言（必填，4 语言之一，决定矩阵的列维度） */
  readonly language: TechLanguage;
  /**
   * 并发量信号（可选）
   * - low：低并发（< 100 QPS）
   * - medium：中并发（100~1000 QPS）
   * - high：高并发（> 1000 QPS），message-queue 层优先选 Kafka
   */
  readonly concurrency?: "low" | "medium" | "high";
  /**
   * 团队栈存量（可选，已有语言栈）
   * 若提供且与 input.language 不同，则强制使用 teamStackLegacy 作为实际语言
   * （团队存量栈优先级高于临时指定，对齐"团队栈存量"信号语义）
   */
  readonly teamStackLegacy?: TechLanguage;
  /**
   * 部署环境（可选）
   * - single-server：单机部署
   * - cluster：集群部署
   * - cloud-native：云原生部署，推荐云原生微服务蓝图
   */
  readonly deployEnv?: "single-server" | "cluster" | "cloud-native";
  /**
   * 合规要求（可选）
   * - general：一般合规
   * - strict：严格合规，auth 层优先选企业级方案（如 Spring Security + OAuth2）
   */
  readonly compliance?: "general" | "strict";
}
