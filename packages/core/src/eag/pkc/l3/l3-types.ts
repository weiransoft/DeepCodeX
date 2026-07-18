/**
 * PKC L3 业务知识层数据模型（EAG-P2 批次 8）
 *
 * 本模块定义 EAG 方案 §5.11.2 L3 业务知识层（K2~K5）所需的全部结构化数据类型。
 * L3 层提供业务流程还原、数据库结构理解、业务数据理解、周边系统关联四项能力，
 * 让系统像资深程序员交接旧项目一样掌握项目的业务知识。
 *
 * 设计依据：
 * - EAG 方案 §5.11.2 L3 业务知识五项子能力
 * - K2 业务流程还原：HTTP 路由 + 调用链 + MQ 生产/消费 → 业务流程
 * - K3 数据库结构理解：schema 解析 + 迁移工具历史 + 表-代码双向溯源
 * - K4 业务数据理解：字典表/枚举/常量类识别 + 字段语义推断 + 敏感字段标注
 * - K5 周边系统关联：配置文件/env/docker-compose/k8s 解析 + 交互矩阵
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/pkc/l3-types
 */

// ============================================================================
// 1. K2 业务流程还原类型
// ============================================================================

/**
 * 业务流程步骤（流程图节点）
 *
 * 描述业务流程中的一个步骤：
 * - stepId：步骤唯一 ID
 * - name：步骤名称（如"创建订单"）
 * - type：步骤类型（http-handler / service-method / mq-producer / mq-consumer / scheduled-task / db-write / db-read）
 * - filePath / symbolName / startLine：代码位置
 * - description：步骤描述
 */
export interface FlowStep {
  /** 步骤唯一 ID（如 "step-001"） */
  readonly stepId: string;
  /** 步骤名称（如"创建订单"） */
  readonly name: string;
  /** 步骤类型（http-handler / service-method / mq-producer / mq-consumer / scheduled-task / db-write / db-read） */
  readonly type: FlowStepType;
  /** 文件相对路径 */
  readonly filePath: string;
  /** 符号名（如"OrderController.create"） */
  readonly symbolName: string;
  /** 起始行号（1-based） */
  readonly startLine: number;
  /** 步骤描述 */
  readonly description: string;
}

/**
 * 业务流程步骤类型（字面量联合类型）
 *
 * - http-handler：HTTP 路由处理器
 * - service-method：服务方法
 * - mq-producer：MQ 消息生产者
 * - mq-consumer：MQ 消息消费者
 * - scheduled-task：定时任务
 * - db-write：数据库写操作
 * - db-read：数据库读操作
 */
export type FlowStepType =
  | "http-handler"
  | "service-method"
  | "mq-producer"
  | "mq-consumer"
  | "scheduled-task"
  | "db-write"
  | "db-read";

/**
 * 业务流程分支（流程图边）
 *
 * 描述从一个步骤到另一个步骤的流转关系：
 * - fromStepId / toStepId：起点与终点步骤 ID
 * - condition：流转条件（可选，如"支付成功"）
 * - label：分支标签
 */
export interface FlowBranch {
  /** 起点步骤 ID */
  readonly fromStepId: string;
  /** 终点步骤 ID */
  readonly toStepId: string;
  /** 流转条件（可选，如"支付成功"） */
  readonly condition?: string;
  /** 分支标签（如"success"/"failure"/"async"） */
  readonly label: string;
}

/**
 * 异步边界（MQ 或定时任务触发的跨进程边界）
 *
 * 描述业务流程中的异步流转：
 * - producerStepId：生产者步骤 ID
 * - consumerStepId：消费者步骤 ID
 * - channel：异步通道（如"order.created"队列）
 * - channelType：通道类型（mq / cron / event-bus）
 */
export interface AsyncBoundary {
  /** 生产者步骤 ID */
  readonly producerStepId: string;
  /** 消费者步骤 ID */
  readonly consumerStepId: string;
  /** 异步通道（如"order.created"队列名） */
  readonly channel: string;
  /** 通道类型（mq / cron / event-bus） */
  readonly channelType: "mq" | "cron" | "event-bus";
}

/**
 * 状态机（业务流程中的状态字段流转）
 *
 * 描述业务实体（如订单）的状态机：
 * - entityName：业务实体名（如"Order"）
 * - stateField：状态字段名（如"status"）
 * - states：状态列表
 * - transitions：状态迁移列表
 * - terminalStates：终态列表
 */
export interface StateMachine {
  /** 业务实体名（如"Order"） */
  readonly entityName: string;
  /** 状态字段名（如"status"） */
  readonly stateField: string;
  /** 状态列表（如["pending", "paid", "shipped", "completed", "cancelled"]） */
  readonly states: ReadonlyArray<string>;
  /** 状态迁移列表 */
  readonly transitions: ReadonlyArray<StateTransition>;
  /** 终态列表（如["completed", "cancelled"]） */
  readonly terminalStates: ReadonlyArray<string>;
}

/**
 * 状态迁移（状态机的边）
 *
 * - from：起始状态
 * - to：目标状态
 * - trigger：触发条件（如"用户支付"）
 * - guard：守卫条件（可选，如"金额>0"）
 */
export interface StateTransition {
  /** 起始状态 */
  readonly from: string;
  /** 目标状态 */
  readonly to: string;
  /** 触发条件（如"用户支付"） */
  readonly trigger: string;
  /** 守卫条件（可选，如"金额>0"） */
  readonly guard?: string;
}

/**
 * 业务流程还原结果（K2 产出）
 *
 * 综合 K2 业务流程还原的全部产出：
 * - steps：流程步骤列表
 * - branches：流程分支列表
 * - asyncBoundaries：异步边界列表
 * - mermaidFlow：Mermaid 流程图字符串（flowchart TD 格式）
 * - stateMachines：状态机列表（Mermaid stateDiagram-v2 格式）
 * - entryPoint：入口点（如 HTTP 路由）
 */
export interface FlowResult {
  /** 入口点（如 HTTP 路由符号名） */
  readonly entryPoint: string;
  /** 流程步骤列表 */
  readonly steps: ReadonlyArray<FlowStep>;
  /** 流程分支列表 */
  readonly branches: ReadonlyArray<FlowBranch>;
  /** 异步边界列表 */
  readonly asyncBoundaries: ReadonlyArray<AsyncBoundary>;
  /** Mermaid 流程图字符串（flowchart TD 格式） */
  readonly mermaidFlow: string;
  /** 状态机列表（每个含 Mermaid stateDiagram-v2 字符串） */
  readonly stateMachines: ReadonlyArray<StateMachineResult>;
}

/**
 * 状态机渲染结果（含 Mermaid 字符串）
 */
export interface StateMachineResult {
  /** 状态机本体 */
  readonly stateMachine: StateMachine;
  /** Mermaid 状态图字符串（stateDiagram-v2 格式） */
  readonly mermaidStateDiagram: string;
}

// ============================================================================
// 2. K3 数据库结构理解类型
// ============================================================================

/**
 * 数据库表（schema 解析产出）
 *
 * - tableName：表名
 * - comment：表注释（描述表职责）
 * - columns：字段列表
 * - indexes：索引列表
 * - foreignKeys：外键列表
 */
export interface DatabaseTable {
  /** 表名 */
  readonly tableName: string;
  /** 表注释（描述表职责） */
  readonly comment?: string;
  /** 字段列表 */
  readonly columns: ReadonlyArray<DatabaseColumn>;
  /** 索引列表 */
  readonly indexes: ReadonlyArray<DatabaseIndex>;
  /** 外键列表 */
  readonly foreignKeys: ReadonlyArray<DatabaseForeignKey>;
}

/**
 * 数据库字段
 *
 * - columnName：字段名
 * - dataType：数据类型（如"INTEGER"、"VARCHAR(255)"）
 * - nullable：是否可空
 * - defaultValue：默认值
 * - comment：字段注释
 * - isPrimaryKey：是否主键
 * - isUnique：是否唯一
 */
export interface DatabaseColumn {
  /** 字段名 */
  readonly columnName: string;
  /** 数据类型（如"INTEGER"、"VARCHAR(255)"） */
  readonly dataType: string;
  /** 是否可空 */
  readonly nullable: boolean;
  /** 默认值 */
  readonly defaultValue?: string;
  /** 字段注释 */
  readonly comment?: string;
  /** 是否主键 */
  readonly isPrimaryKey: boolean;
  /** 是否唯一 */
  readonly isUnique: boolean;
}

/**
 * 数据库索引
 *
 * - indexName：索引名
 * - columnNames：索引字段列表
 * - isUnique：是否唯一索引
 * - isPrimary：是否主键索引
 */
export interface DatabaseIndex {
  /** 索引名 */
  readonly indexName: string;
  /** 索引字段列表 */
  readonly columnNames: ReadonlyArray<string>;
  /** 是否唯一索引 */
  readonly isUnique: boolean;
  /** 是否主键索引 */
  readonly isPrimary: boolean;
}

/**
 * 数据库外键
 *
 * - foreignKeyName：外键名
 * - columnName：本地字段名
 * - referencedTableName：引用表名
 * - referencedColumnName：引用字段名
 */
export interface DatabaseForeignKey {
  /** 外键名 */
  readonly foreignKeyName: string;
  /** 本地字段名 */
  readonly columnName: string;
  /** 引用表名 */
  readonly referencedTableName: string;
  /** 引用字段名 */
  readonly referencedColumnName: string;
}

/**
 * 数据库迁移历史（Alembic/Flyway/Prisma migrate 演化时间线）
 *
 * - migrationId：迁移 ID（如"20260101000000_create_users"）
 * - tool：迁移工具（alembic / flyway / prisma / knex / typeorm）
 * - description：迁移描述
 * - timestamp：迁移时间戳（ISO 8601 字符串）
 * - direction：方向（up / down）
 */
export interface DatabaseMigration {
  /** 迁移 ID（如"20260101000000_create_users"） */
  readonly migrationId: string;
  /** 迁移工具（alembic / flyway / prisma / knex / typeorm） */
  readonly tool: "alembic" | "flyway" | "prisma" | "knex" | "typeorm" | "unknown";
  /** 迁移描述 */
  readonly description: string;
  /** 迁移时间戳（ISO 8601 字符串） */
  readonly timestamp: string;
  /** 方向（up / down） */
  readonly direction: "up" | "down";
}

/**
 * 表-代码双向溯源（表 ↔ ORM 实体 ↔ 使用模块）
 *
 * - tableName：表名
 * - ormEntity：ORM 实体名（如"User"、"OrderEntity"）
 * - ormFilePath：ORM 实体文件路径
 * - usageModules：使用该实体的模块列表
 */
export interface TableCodeTrace {
  /** 表名 */
  readonly tableName: string;
  /** ORM 实体名（如"User"、"OrderEntity"） */
  readonly ormEntity: string;
  /** ORM 实体文件路径 */
  readonly ormFilePath: string;
  /** 使用该实体的模块列表 */
  readonly usageModules: ReadonlyArray<string>;
}

/**
 * 数据库结构分析结果（K3 产出）
 *
 * 综合 K3 数据库结构理解的全部产出：
 * - tables：表列表
 * - indexes：全表索引汇总
 * - foreignKeys：全表外键汇总
 * - migrations：迁移历史时间线
 * - erDiagram：Mermaid ER 图字符串（erDiagram 格式）
 * - codeTraces：表-代码双向溯源列表
 */
export interface SchemaAnalysisResult {
  /** 表列表 */
  readonly tables: ReadonlyArray<DatabaseTable>;
  /** 全表索引汇总 */
  readonly indexes: ReadonlyArray<DatabaseIndex>;
  /** 全表外键汇总 */
  readonly foreignKeys: ReadonlyArray<DatabaseForeignKey>;
  /** 迁移历史时间线 */
  readonly migrations: ReadonlyArray<DatabaseMigration>;
  /** Mermaid ER 图字符串（erDiagram 格式） */
  readonly erDiagram: string;
  /** 表-代码双向溯源列表 */
  readonly codeTraces: ReadonlyArray<TableCodeTrace>;
}

// ============================================================================
// 3. K4 业务数据理解类型
// ============================================================================

/**
 * 枚举定义（业务数据中的枚举/常量类）
 *
 * - enumName：枚举名
 * - values：枚举值列表（含值与含义）
 * - filePath：定义文件路径
 * - description：枚举描述
 */
export interface BusinessEnum {
  /** 枚举名 */
  readonly enumName: string;
  /** 枚举值列表 */
  readonly values: ReadonlyArray<BusinessEnumValue>;
  /** 定义文件路径 */
  readonly filePath: string;
  /** 枚举描述 */
  readonly description: string;
}

/**
 * 枚举值（含值与业务含义）
 *
 * - value：枚举值（如 1、2 或 "ACTIVE"）
 * - label：业务含义（如"待支付"、"已支付"）
 * - comment：附加注释
 */
export interface BusinessEnumValue {
  /** 枚举值（如 1、2 或 "ACTIVE"） */
  readonly value: string;
  /** 业务含义（如"待支付"、"已支付"） */
  readonly label: string;
  /** 附加注释 */
  readonly comment?: string;
}

/**
 * 字典表（数据库中存储枚举/配置的表）
 *
 * - tableName：表名
 * - keyColumn：键字段名
 * - valueColumn：值字段名
 * - description：字典表职责描述
 * - filePath：对应 ORM 实体文件路径
 */
export interface DictionaryTable {
  /** 表名 */
  readonly tableName: string;
  /** 键字段名 */
  readonly keyColumn: string;
  /** 值字段名 */
  readonly valueColumn: string;
  /** 字典表职责描述 */
  readonly description: string;
  /** 对应 ORM 实体文件路径 */
  readonly filePath: string;
}

/**
 * 字段业务语义（推断的字段含义）
 *
 * - tableName：表名
 * - columnName：字段名
 * - inferredSemantics：推断的业务语义（如"用户邮箱""订单总金额"）
 * - evidence：推断证据列表（comment / 命名 / 使用上下文）
 * - confidence：置信度（0~1，越高越可信）
 */
export interface FieldSemantics {
  /** 表名 */
  readonly tableName: string;
  /** 字段名 */
  readonly columnName: string;
  /** 推断的业务语义（如"用户邮箱""订单总金额"） */
  readonly inferredSemantics: string;
  /** 推断证据列表（comment / 命名 / 使用上下文） */
  readonly evidence: ReadonlyArray<string>;
  /** 置信度（0~1，越高越可信） */
  readonly confidence: number;
}

/**
 * 敏感字段（与 EDM 数据权限列级脱敏联动）
 *
 * - tableName：表名
 * - columnName：字段名
 * - sensitivity：敏感性级别（high / medium / low）
 * - reason：敏感性判定原因（如"含 PII 信息""含支付信息"）
 * - desensitizationRule：脱敏规则（如"前 3 后 4 保留，中间 * "）
 */
export interface SensitiveField {
  /** 表名 */
  readonly tableName: string;
  /** 字段名 */
  readonly columnName: string;
  /** 敏感性级别（high / medium / low） */
  readonly sensitivity: "high" | "medium" | "low";
  /** 敏感性判定原因（如"含 PII 信息""含支付信息"） */
  readonly reason: string;
  /** 脱敏规则（如"前 3 后 4 保留，中间 * "） */
  readonly desensitizationRule?: string;
}

/**
 * 数据字典（K4 产出）
 *
 * 综合 K4 业务数据理解的全部产出：
 * - enums：枚举/常量类列表
 * - dictionaryTables：字典表列表
 * - fieldSemantics：字段业务语义推断列表
 * - sensitiveFields：敏感字段列表
 */
export interface DataDictionary {
  /** 枚举/常量类列表 */
  readonly enums: ReadonlyArray<BusinessEnum>;
  /** 字典表列表 */
  readonly dictionaryTables: ReadonlyArray<DictionaryTable>;
  /** 字段业务语义推断列表 */
  readonly fieldSemantics: ReadonlyArray<FieldSemantics>;
  /** 敏感字段列表 */
  readonly sensitiveFields: ReadonlyArray<SensitiveField>;
}

// ============================================================================
// 4. K5 周边系统关联类型
// ============================================================================

/**
 * 周边系统依赖类型（字面量联合类型）
 *
 * - database：数据库（MySQL/PostgreSQL/MongoDB 等）
 * - message-queue：消息队列（RabbitMQ/Kafka/Redis PubSub 等）
 * - cache：缓存（Redis/Memcached 等）
 * - object-storage：对象存储（S3/MinIO/OSS 等）
 * - third-party-api：第三方 API（支付网关/短信/LDAP 等）
 * - ldap：LDAP 目录服务
 * - payment-gateway：支付网关（Stripe/Alipay/WechatPay 等）
 */
export type PeripheralDependencyType =
  | "database"
  | "message-queue"
  | "cache"
  | "object-storage"
  | "third-party-api"
  | "ldap"
  | "payment-gateway";

/**
 * 周边系统依赖（单一外部依赖项）
 *
 * - type：依赖类型
 * - name：依赖名称（如"primary-db"、"redis-cache"）
 * - technology：技术栈（如"PostgreSQL 15"、"Redis 7"）
 * - configKeys：配置项 key 列表（如["DATABASE_URL", "DATABASE_POOL_SIZE"]）
 * - credentialSource：凭据来源（如"env:DATABASE_URL"）
 */
export interface PeripheralDependency {
  /** 依赖类型 */
  readonly type: PeripheralDependencyType;
  /** 依赖名称（如"primary-db"、"redis-cache"） */
  readonly name: string;
  /** 技术栈（如"PostgreSQL 15"、"Redis 7"） */
  readonly technology: string;
  /** 配置项 key 列表（如["DATABASE_URL", "DATABASE_POOL_SIZE"]） */
  readonly configKeys: ReadonlyArray<string>;
  /** 凭据来源（如"env:DATABASE_URL"） */
  readonly credentialSource: string;
}

/**
 * 交互矩阵条目（系统 ↔ 周边的交互关系）
 *
 * - dependentModule：依赖方模块（如"src/services/UserService.ts"）
 * - dependency：依赖的周边系统
 * - protocol：通信协议（如"TCP 5432"、"AMQP"、"HTTPS"）
 * - configKey：配置项 key
 * - credentialSource：凭据来源
 */
export interface InteractionMatrixEntry {
  /** 依赖方模块（如"src/services/UserService.ts"） */
  readonly dependentModule: string;
  /** 依赖的周边系统 */
  readonly dependency: PeripheralDependency;
  /** 通信协议（如"TCP 5432"、"AMQP"、"HTTPS"） */
  readonly protocol: string;
  /** 配置项 key */
  readonly configKey: string;
  /** 凭据来源 */
  readonly credentialSource: string;
}

/**
 * 配置清单条目（配置项全清单）
 *
 * - key：配置项 key（如"DATABASE_URL"）
 * - defaultValue：默认值（可选）
 * - effectiveEnvironments：生效环境列表（如["production", "staging"]）
 * - isSensitive：是否敏感（含凭据/密钥时为 true）
 * - source：配置来源（env / docker-compose / k8s-configmap / application.yml）
 */
export interface ConfigInventoryEntry {
  /** 配置项 key（如"DATABASE_URL"） */
  readonly key: string;
  /** 默认值（可选） */
  readonly defaultValue?: string;
  /** 生效环境列表（如["production", "staging"]） */
  readonly effectiveEnvironments: ReadonlyArray<string>;
  /** 是否敏感（含凭据/密钥时为 true） */
  readonly isSensitive: boolean;
  /** 配置来源（env / docker-compose / k8s-configmap / application.yml） */
  readonly source: "env" | "docker-compose" | "k8s-configmap" | "application.yml" | "application.properties";
}

/**
 * 周边系统分析结果（K5 产出）
 *
 * 综合 K5 周边系统关联的全部产出：
 * - dependencies：周边系统依赖列表
 * - interactionMatrix：交互矩阵
 * - configInventory：配置项全清单
 */
export interface PeripheralAnalysisResult {
  /** 周边系统依赖列表 */
  readonly dependencies: ReadonlyArray<PeripheralDependency>;
  /** 交互矩阵（系统 ↔ 周边的交互关系） */
  readonly interactionMatrix: ReadonlyArray<InteractionMatrixEntry>;
  /** 配置项全清单 */
  readonly configInventory: ReadonlyArray<ConfigInventoryEntry>;
}
