/**
 * TCS（Technical Component Specification，企业技术组件规范包）核心类型定义
 *
 * 本模块定义 EAG 方案 §5.8 企业技术组件规范包的全部结构化数据类型，作为
 * TCS 模块的最底层数据契约。TCS 将企业应用中反复出现的技术组件（对象存储 /
 * 缓存 / SQL 优化 / LDAP 接入 / 漏洞扫描）建模为可复用规范包，每个组件
 * 一份"接口契约 + 使用规范 + 红线"，CODING Loop 生成组件代码时强制遵循。
 *
 * 设计依据：
 * - EAG 方案 §5.8 企业技术组件规范包（v1.3 新增）
 * - §5.8.1 对象存储规范（ObjectStoragePort + S3/OSS/MinIO 三适配器）
 * - §5.8.2 缓存规范（多级缓存 + 三防设计）
 * - §5.8.3 SQL 查询优化规范（索引评审 + N+1 检测 + 深分页禁令）
 * - §5.8.4 LDAP / SSO 接入规范（双通道同步 + 幂等保护）
 * - §5.8.5 漏洞扫描与修复闭环（三层扫描 + 修复闭环）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 联合类型使用字面量联合 + ReadonlyArray 常量
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/tcs/types
 */

// ============================================================================
// 1. TCS 红线 ID 与基础常量
// ============================================================================

/**
 * TCS 红线 ID（13 条，字面量联合类型）
 *
 * 严格对齐 EAG 方案 §5.8.1~§5.8.5 各子节的红线清单：
 * - TCS-OSS-01~03：对象存储红线（业务代码直连 SDK / 签名 URL 过期 >24h / 文件未校验）
 * - TCS-CACHE-01~03：缓存红线（无 TTL / 双写顺序错误 / 穿透无防护）
 * - TCS-SQL-01~03：SQL 红线（全表扫描 / N+1 / 深分页滥用）
 * - TCS-LDAP-01~02：LDAP 红线（无缓存实时查询 / 同步无幂等）
 * - TCS-SEC-01~02：安全红线（高危漏洞未修复 / 硬编码密钥）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误，对齐 §5.12.4 配置冻结原则。
 */
export type TcsRedlineId =
  | "TCS-OSS-01"
  | "TCS-OSS-02"
  | "TCS-OSS-03"
  | "TCS-CACHE-01"
  | "TCS-CACHE-02"
  | "TCS-CACHE-03"
  | "TCS-SQL-01"
  | "TCS-SQL-02"
  | "TCS-SQL-03"
  | "TCS-LDAP-01"
  | "TCS-LDAP-02"
  | "TCS-SEC-01"
  | "TCS-SEC-02";

/**
 * TCS 红线 ID 全部合法值（13 条，用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序对齐 §5.8 各子节红线声明顺序。
 */
export const TCS_REDLINE_IDS: ReadonlyArray<TcsRedlineId> = Object.freeze([
  "TCS-OSS-01",
  "TCS-OSS-02",
  "TCS-OSS-03",
  "TCS-CACHE-01",
  "TCS-CACHE-02",
  "TCS-CACHE-03",
  "TCS-SQL-01",
  "TCS-SQL-02",
  "TCS-SQL-03",
  "TCS-LDAP-01",
  "TCS-LDAP-02",
  "TCS-SEC-01",
  "TCS-SEC-02",
]);

/**
 * TCS 红线分类（按技术组件划分，5 类）
 *
 * 用于红线清单的分组查询与统计。字面量联合防止拼写错误。
 */
export type TcsRedlineCategory = "oss" | "cache" | "sql" | "ldap" | "security";

/**
 * TCS 红线分类全部合法值（5 类）
 *
 * 使用 Object.freeze 冻结，顺序对齐 §5.8.1~§5.8.5。
 */
export const TCS_REDLINE_CATEGORIES: ReadonlyArray<TcsRedlineCategory> = Object.freeze([
  "oss",
  "cache",
  "sql",
  "ldap",
  "security",
]);

// ============================================================================
// 2. 对象存储（§5.8.1）共享类型
// ============================================================================

/**
 * 对象存储供应商类型（字面量联合）
 *
 * - s3：AWS S3 兼容协议（含 AWS S3 / Ceph / MinIO 等）
 * - oss：阿里云 OSS（自有协议，签名算法与 S3 不同）
 * - minio：MinIO 自建对象存储（S3 兼容协议，但部署形态不同）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type StorageProvider = "s3" | "oss" | "minio";

/**
 * 对象存储供应商全部合法值
 *
 * 使用 Object.freeze 冻结，顺序对齐 §5.8.1（S3 → OSS → MinIO）。
 */
export const STORAGE_PROVIDERS: ReadonlyArray<StorageProvider> = Object.freeze(["s3", "oss", "minio"]);

/**
 * 对象存储配置（连接参数）
 *
 * 描述对象存储适配器初始化所需的连接参数，包括供应商类型、端点、凭证、桶名等。
 * 字段全部 readonly——配置一旦发布即不可变（运行期变更需重新构造适配器实例）。
 */
export interface ObjectStorageConfig {
  /** 供应商类型（s3 / oss / minio） */
  readonly provider: StorageProvider;
  /** 访问端点（如 "https://s3.amazonaws.com" / "https://oss-cn-hangzhou.aliyuncs.com"） */
  readonly endpoint: string;
  /** 访问区域（如 "us-east-1" / "oss-cn-hangzhou"） */
  readonly region: string;
  /** 访问密钥 ID（access key id） */
  readonly accessKeyId: string;
  /** 访问密钥（access key secret，禁止硬编码，须从环境变量/Secret Manager 注入） */
  readonly accessKeySecret: string;
  /** 桶名（bucket name） */
  readonly bucket: string;
  /** 环境标识（用于 Key 规范的 {env} 段，如 "prod" / "staging" / "dev"） */
  readonly env: string;
  /** 业务域标识（用于 Key 规范的 {domain} 段，如 "user-avatar" / "order-attachment"） */
  readonly domain: string;
  /** 默认签名 URL 过期时间（秒，默认 900 即 15 分钟，对齐 §5.8.1 规范） */
  readonly defaultSignedUrlExpirySeconds?: number;
  /** 大文件阈值（字节，默认 104857600 即 100MB，超过则强制分片上传） */
  readonly multipartThresholdBytes?: number;
  /** 单个分片大小（字节，默认 8388608 即 8MB） */
  readonly partSizeBytes?: number;
  /** 允许的文件扩展名清单（白名单，未配置则允许全部——但需触发 TCS-OSS-03 校验提醒） */
  readonly allowedExtensions?: ReadonlyArray<string>;
  /** 允许的最大文件大小（字节，未配置则不限制——但需触发 TCS-OSS-03 校验提醒） */
  readonly maxFileBytes?: number;
}

/**
 * 文件 Key 生成参数
 *
 * §5.8.1 规范要求文件 Key 格式为 `{env}/{domain}/{yyyyMM}/{uuid}.{ext}`，
 * 本参数描述 Key 生成所需的字段（env/domain 已在配置中提供，这里仅需扩展名）。
 */
export interface StorageKeyParams {
  /** 文件扩展名（不含点，如 "jpg" / "pdf" / "xlsx"） */
  readonly extension: string;
  /** 可选的自定义时间戳（默认取当前时间，格式化为 yyyyMM） */
  readonly timestamp?: Date;
  /** 可选的自定义 UUID（默认随机生成 v4 UUID） */
  readonly uuid?: string;
}

/**
 * 上传选项
 *
 * 描述 put 操作的可选参数，包括内容类型、自定义元数据、是否强制分片等。
 */
export interface PutOptions {
  /** 内容类型（Content-Type，如 "image/jpeg" / "application/pdf"） */
  readonly contentType?: string;
  /** 自定义元数据（写入对象存储的 x-amz-meta-* / x-oss-meta-* 头） */
  readonly metadata?: Readonly<Record<string, string>>;
  /** 是否启用服务端加密（默认 false） */
  readonly serverSideEncryption?: boolean;
  /** 是否禁用分片上传（即使超过阈值也使用单次 put，仅在明确小文件场景使用） */
  readonly disableMultipart?: boolean;
}

/**
 * 上传结果
 *
 * 描述 put 操作成功后的返回值，包括生成的 Key、ETag、大小等信息。
 */
export interface PutResult {
  /** 生成的文件 Key（符合 `{env}/{domain}/{yyyyMM}/{uuid}.{ext}` 规范） */
  readonly key: string;
  /** 对象 ETag（MD5 哈希，用于完整性校验） */
  readonly etag: string;
  /** 对象大小（字节） */
  readonly sizeBytes: number;
  /** 上传方式（"single" 单次上传 / "multipart" 分片上传） */
  readonly uploadType: "single" | "multipart";
  /** 上传时间戳（ISO 8601 字符串） */
  readonly uploadedAt: string;
}

/**
 * 下载结果
 *
 * 描述 get 操作成功后的返回值，包括文件内容、内容类型、元数据等。
 */
export interface GetResult {
  /** 文件 Key */
  readonly key: string;
  /** 文件内容（Buffer） */
  readonly content: Buffer;
  /** 内容类型（Content-Type） */
  readonly contentType: string;
  /** 文件大小（字节） */
  readonly sizeBytes: number;
  /** ETag（用于完整性校验） */
  readonly etag: string;
  /** 最后修改时间（ISO 8601 字符串） */
  readonly lastModified: string;
  /** 自定义元数据 */
  readonly metadata: Readonly<Record<string, string>>;
  /** 是否标记为软删除（true 表示对象已标记删除，仍在生命周期保留期内） */
  readonly softDeleted: boolean;
}

/**
 * 删除结果
 *
 * 描述 delete 操作成功后的返回值。§5.8.1 规范要求删除走软删除标记 + 生命周期规则，
 * 因此 delete 操作实际是给对象打上软删除标记（如 x-amz-meta-deleted-at 头），
 * 真正物理删除由对象存储生命周期规则按策略执行。
 */
export interface DeleteResult {
  /** 文件 Key */
  readonly key: string;
  /** 软删除标记时间戳（ISO 8601 字符串） */
  readonly deletedAt: string;
  /** 是否已物理删除（true 表示对象不存在或已被生命周期规则清理） */
  readonly permanent: boolean;
}

/**
 * 签名 URL 结果
 *
 * 描述 signedUrl 操作成功后的返回值，包括签名 URL、过期时间等。
 */
export interface SignedUrlResult {
  /** 文件 Key */
  readonly key: string;
  /** 签名 URL（含签名信息，可通过 HTTP 直接访问） */
  readonly url: string;
  /** 过期时间戳（ISO 8601 字符串） */
  readonly expiresAt: string;
  /** 过期时间（秒，从生成时刻起计算） */
  readonly expiresInSeconds: number;
  /** HTTP 方法（"GET" 下载 / "PUT" 上传） */
  readonly method: "GET" | "PUT";
}

/**
 * 分片上传会话
 *
 * 描述 multipartUpload 操作的会话信息（用于断点续传场景）。
 */
export interface MultipartUploadSession {
  /** 上传会话 ID（S3 的 uploadId / OSS 的 uploadId） */
  readonly uploadId: string;
  /** 文件 Key */
  readonly key: string;
  /** 已上传的分片信息 */
  readonly parts: ReadonlyArray<{
    /** 分片序号（从 1 开始） */
    readonly partNumber: number;
    /** 分片 ETag */
    readonly etag: string;
    /** 分片大小（字节） */
    readonly sizeBytes: number;
  }>;
}

/**
 * 分片上传选项
 *
 * 描述 multipartUpload 操作的可选参数。
 */
export interface MultipartOptions extends PutOptions {
  /** 分片大小（字节，覆盖配置中的 partSizeBytes） */
  readonly partSizeBytes?: number;
  /** 已存在的上传会话 ID（用于断点续传，未提供则启动新会话） */
  readonly resumeUploadId?: string;
}

/**
 * 分片上传结果
 *
 * 描述 multipartUpload 操作成功后的返回值。
 */
export interface MultipartResult extends PutResult {
  /** 上传会话 ID */
  readonly uploadId: string;
  /** 分片总数 */
  readonly partCount: number;
}

// ============================================================================
// 3. 缓存（§5.8.2）共享类型
// ============================================================================

/**
 * 缓存层级（字面量联合）
 *
 * - local：本地缓存（Caffeine/Map，秒级 TTL）
 * - redis：分布式缓存（Redis，分钟级 TTL）
 * - db：数据库（持久化存储，作为缓存回源的最终数据源）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type CacheTier = "local" | "redis" | "db";

/**
 * 缓存层级全部合法值
 *
 * 使用 Object.freeze 冻结，顺序对齐 §5.8.2 多级缓存策略：local → redis → db。
 */
export const CACHE_TIERS: ReadonlyArray<CacheTier> = Object.freeze(["local", "redis", "db"]);

/**
 * 缓存键命名规范
 *
 * §5.8.2 规范要求 Key 格式为 `{app}:{domain}:{entity}:{id}`，
 * 本类型描述 Key 生成所需的字段。
 */
export interface CacheKeyParams {
  /** 应用标识（{app} 段，如 "bi-service"） */
  readonly app: string;
  /** 业务域标识（{domain} 段，如 "user" / "order"） */
  readonly domain: string;
  /** 实体标识（{entity} 段，如 "UserEntity" / "OrderEntity"） */
  readonly entity: string;
  /** 实体 ID（{id} 段，如 "12345" / "uuid-xxx"） */
  readonly id: string;
}

/**
 * 缓存写入选项
 *
 * 描述缓存写入时的可选参数，包括 TTL、是否豁免 TTL、是否为空值缓存等。
 */
export interface CacheSetOptions {
  /** TTL（秒，必填——对齐 TCS-CACHE-01 红线"禁止无 TTL 的 key"） */
  readonly ttlSeconds: number;
  /** TTL 抖动比例（0~1，默认 0.2 即 ±20%，对齐 §5.8.2 雪崩防护） */
  readonly ttlJitterRatio?: number;
  /** 是否豁免 TTL（true 表示永久有效，仅在豁免清单内的 key 可使用） */
  readonly ttlExempt?: boolean;
  /** 是否为空值缓存（true 表示穿透防护的空结果缓存，对齐 TCS-CACHE-03 红线） */
  readonly nullCache?: boolean;
  /** 是否仅写入本地缓存（不传播到 Redis，用于热点 key 的本地预读） */
  readonly localOnly?: boolean;
}

/**
 * 缓存读取结果
 *
 * 描述缓存读取操作的返回值，包括值、来源层级、是否命中空值缓存等。
 */
export interface CacheGetResult<T> {
  /** 缓存值（null 表示未命中） */
  readonly value: T | null;
  /** 命中的缓存层级（null 表示完全未命中，需回源 DB） */
  readonly tier: CacheTier | null;
  /** 是否命中空值缓存（true 表示命中穿透防护的空结果缓存） */
  readonly nullCacheHit: boolean;
  /** 是否命中本地缓存（用于性能统计） */
  readonly localHit: boolean;
  /** 是否命中 Redis 缓存（用于性能统计） */
  readonly redisHit: boolean;
}

/**
 * 缓存重建互斥锁结果
 *
 * 描述热点 key 互斥重建（mutex）的锁获取结果，对齐 §5.8.2 击穿防护。
 */
export interface CacheMutexResult {
  /** 是否成功获取锁 */
  readonly acquired: boolean;
  /** 锁持有者 ID（用于释放锁时校验） */
  readonly holderId: string;
  /** 锁过期时间（秒，避免锁泄漏） */
  readonly expiresInSeconds: number;
}

/**
 * 双写一致性结果
 *
 * 描述"先更库后删缓存"双写顺序的执行结果，对齐 TCS-CACHE-02 红线。
 */
export interface CacheDoubleWriteResult {
  /** DB 更新是否成功 */
  readonly dbUpdated: boolean;
  /** 缓存删除是否成功 */
  readonly cacheDeleted: boolean;
  /** 双写顺序（必须为 "db-then-delete-cache" 才合规） */
  readonly order: "db-then-delete-cache" | "cache-delete-then-db" | "db-then-update-cache";
  /** 执行耗时（毫秒） */
  readonly durationMs: number;
}

// ============================================================================
// 4. SQL 优化（§5.8.3）共享类型
// ============================================================================

/**
 * SQL 查询类型（用于索引评审的语义分析）
 *
 * - select：SELECT 查询
 * - insert：INSERT 写入
 * - update：UPDATE 更新
 * - delete：DELETE 删除
 */
export type SqlQueryType = "select" | "insert" | "update" | "delete";

/**
 * 索引评审输入（迁移脚本片段）
 *
 * 描述索引评审所需的输入信息，包括表名、SQL 语句、现有索引清单等。
 */
export interface IndexReviewInput {
  /** 表名 */
  readonly tableName: string;
  /** 待评审的 SQL 语句列表 */
  readonly sqlStatements: ReadonlyArray<string>;
  /** 现有索引清单（含字段、类型） */
  readonly existingIndexes: ReadonlyArray<IndexDefinition>;
  /** ORM 模型字段清单（用于推断字段类型与索引适用性） */
  readonly modelFields: ReadonlyArray<ModelFieldDefinition>;
}

/**
 * 索引定义
 *
 * 描述数据库索引的结构化定义，包括字段列表、类型、是否唯一等。
 */
export interface IndexDefinition {
  /** 索引名 */
  readonly name: string;
  /** 索引字段列表（按顺序，联合索引用于最左前缀匹配） */
  readonly columns: ReadonlyArray<string>;
  /** 索引类型（btree / hash / gin / gist） */
  readonly type: "btree" | "hash" | "gin" | "gist";
  /** 是否唯一索引 */
  readonly unique: boolean;
  /** 是否主键索引 */
  readonly isPrimaryKey: boolean;
}

/**
 * ORM 模型字段定义
 *
 * 描述 ORM 模型中的字段，用于索引评审时推断字段类型与索引适用性。
 */
export interface ModelFieldDefinition {
  /** 字段名 */
  readonly name: string;
  /** 字段类型（"string" / "number" / "Date" / "boolean" / "json"） */
  readonly type: string;
  /** 是否可空 */
  readonly nullable: boolean;
  /** 是否外键（关联其他表） */
  readonly isForeignKey: boolean;
  /** 关联表名（仅 isForeignKey=true 时有效） */
  readonly referencesTable?: string;
}

/**
 * 索引评审结果
 *
 * 描述索引评审器的输出，包括覆盖情况、缺失索引建议、警告等。
 */
export interface IndexReviewResult {
  /** 评审的表名 */
  readonly tableName: string;
  /** 整体评审结论（"pass" 通过 / "warn" 警告 / "fail" 不通过） */
  readonly verdict: "pass" | "warn" | "fail";
  /** 现有索引对 WHERE 字段的覆盖情况 */
  readonly whereCoverage: ReadonlyArray<{
    /** SQL 语句 */
    readonly sql: string;
    /** WHERE 子句使用的字段 */
    readonly whereColumns: ReadonlyArray<string>;
    /** 是否被索引覆盖 */
    readonly covered: boolean;
    /** 覆盖的索引名（covered=false 时为 null） */
    readonly coveringIndex: string | null;
  }>;
  /** 现有索引对 ORDER BY 字段的覆盖情况 */
  readonly orderByCoverage: ReadonlyArray<{
    readonly sql: string;
    readonly orderByColumns: ReadonlyArray<string>;
    readonly covered: boolean;
    readonly coveringIndex: string | null;
  }>;
  /** 现有索引对 JOIN 字段的覆盖情况 */
  readonly joinCoverage: ReadonlyArray<{
    readonly sql: string;
    readonly joinColumns: ReadonlyArray<string>;
    readonly covered: boolean;
    readonly coveringIndex: string | null;
  }>;
  /** 建议新增的索引清单（"fail" 级别时必填） */
  readonly suggestedIndexes: ReadonlyArray<IndexDefinition>;
  /** 全表扫描风险（对齐 TCS-SQL-01 红线） */
  readonly fullTableScanRisk: boolean;
  /** 评审备注 */
  readonly notes: string;
}

/**
 * N+1 查询检测结果
 *
 * 描述 N+1 检测器对代码片段的扫描结果，包括检测到的 N+1 模式位置、严重级别等。
 */
export interface NPlusOneDetectionResult {
  /** 检测的文件路径 */
  readonly filePath: string;
  /** 是否检测到 N+1 模式 */
  readonly detected: boolean;
  /** 检测到的 N+1 模式详情 */
  readonly patterns: ReadonlyArray<{
    /** 起始行号 */
    readonly startLine: number;
    /** 结束行号 */
    readonly endLine: number;
    /** 循环类型（"for" / "forEach" / "while" / "map"） */
    readonly loopType: "for" | "forEach" | "while" | "map";
    /** 循环内执行的查询语句片段 */
    readonly querySnippet: string;
    /** 检测置信度（0~1，越高越确信） */
    readonly confidence: number;
    /** 修复建议 */
    readonly fixSuggestion: string;
  }>;
  /** 检测备注 */
  readonly notes: string;
}

/**
 * 分页规范检查结果
 *
 * 描述分页查询的规范检查结果，对齐 §5.8.3 深分页禁令（offset > 10000 改用游标/keyset 分页）。
 */
export interface PaginationCheckResult {
  /** SQL 语句 */
  readonly sql: string;
  /** 是否为深分页（offset > 10000） */
  readonly isDeepPagination: boolean;
  /** 解析出的 offset 值（未指定则 0） */
  readonly offset: number;
  /** 解析出的 limit 值（未指定则 0） */
  readonly limit: number;
  /** 是否合规（深分页违规则 false） */
  readonly compliant: boolean;
  /** 修复建议（不合规时提供） */
  readonly fixSuggestion: string | null;
}

// ============================================================================
// 5. LDAP / SSO（§5.8.4）共享类型
// ============================================================================

/**
 * LDAP 同步模式（字面量联合）
 *
 * - full：定时全量同步（按调度任务周期执行，刷新整个用户库）
 * - incremental：登录时增量同步（用户登录时实时拉取该用户最新信息）
 *
 * 字面量联合而非 string，对齐 §5.8.4 双通道同步设计。
 */
export type LdapSyncMode = "full" | "incremental";

/**
 * LDAP 同步模式全部合法值
 *
 * 使用 Object.freeze 冻结，顺序对齐 §5.8.4（全量优先于增量）。
 */
export const LDAP_SYNC_MODES: ReadonlyArray<LdapSyncMode> = Object.freeze(["full", "incremental"]);

/**
 * LDAP 连接配置
 *
 * 描述 LDAP 适配器初始化所需的连接参数，包括 URL、绑定 DN、密码、搜索基等。
 */
export interface LdapConfig {
  /** LDAP 服务器 URL（如 "ldap://ldap.example.com:389" / "ldaps://ldap.example.com:636"） */
  readonly url: string;
  /** 绑定 DN（管理员账号 DN，用于搜索用户） */
  readonly bindDn: string;
  /** 绑定密码（禁止硬编码，须从环境变量/Secret Manager 注入） */
  readonly bindPassword: string;
  /** 用户搜索基（如 "ou=users,dc=example,dc=com"） */
  readonly userSearchBase: string;
  /** 用户搜索过滤器（如 "(uid={0})"，{0} 占位符由实际登录账号替换） */
  readonly userSearchFilter: string;
  /** 组织搜索基（如 "ou=orgs,dc=example,dc=com"） */
  readonly orgSearchBase: string;
  /** 组织搜索过滤器 */
  readonly orgSearchFilter: string;
  /** 同步批大小（全量同步时分页拉取，默认 500） */
  readonly syncBatchSize?: number;
  /** 全量同步间隔（秒，默认 3600 即 1 小时） */
  readonly fullSyncIntervalSeconds?: number;
  /** 增量同步缓存 TTL（秒，默认 300 即 5 分钟，对齐 TCS-LDAP-01 红线要求不实时查询 LDAP） */
  readonly incrementalCacheTtlSeconds?: number;
  /** 降级策略（LDAP 不可用时的行为，对齐 §5.8.4） */
  readonly degradationStrategy?: LdapDegradationStrategy;
}

/**
 * LDAP 降级策略（字面量联合）
 *
 * - reject-new：拒绝新登录（已登录会话不受影响，对齐 §5.8.4 默认策略）
 * - emergency-admin：启用紧急本地管理员账号（绕过 LDAP 验证）
 * - readonly：只读模式（已登录用户可继续操作，新登录拒绝）
 */
export type LdapDegradationStrategy = "reject-new" | "emergency-admin" | "readonly";

/**
 * LDAP 用户实体
 *
 * 描述从 LDAP 拉取的用户信息，包括 entryUUID（账号映射键）、DN、属性等。
 */
export interface LdapUserEntry {
  /** LDAP entryUUID（账号映射键——对齐 §5.8.4 不使用 DN 而使用 entryUUID） */
  readonly entryUUID: string;
  /** LDAP DN（可变，仅用于审计追溯，不作为账号映射键） */
  readonly dn: string;
  /** 用户名（uid 字段） */
  readonly username: string;
  /** 显示名（cn 字段） */
  readonly displayName: string;
  /** 邮箱（mail 字段） */
  readonly email: string;
  /** 所属组织 DN 列表 */
  readonly orgDns: ReadonlyArray<string>;
  /** 用户状态（active / disabled / locked） */
  readonly status: "active" | "disabled" | "locked";
  /** 最后更新时间戳（ISO 8601 字符串，用于增量同步判断） */
  readonly lastModifiedAt: string;
}

/**
 * LDAP 组织实体
 *
 * 描述从 LDAP 拉取的组织信息，将映射到 EDM 组织域。
 */
export interface LdapOrgEntry {
  /** LDAP DN（组织 DN） */
  readonly dn: string;
  /** 组织标识（ou 字段） */
  readonly orgUnitCode: string;
  /** 组织名称（cn 字段） */
  readonly name: string;
  /** 父组织 DN（顶级组织为空字符串） */
  readonly parentDn: string;
  /** 组织类型（department / division / team） */
  readonly type: "department" | "division" | "team";
}

/**
 * LDAP 同步结果
 *
 * 描述一次同步操作（全量或增量）的执行结果，包括同步数量、跳过数量、错误信息等。
 */
export interface LdapSyncResult {
  /** 同步模式（full / incremental） */
  readonly mode: LdapSyncMode;
  /** 同步开始时间（ISO 8601 字符串） */
  readonly startedAt: string;
  /** 同步结束时间（ISO 8601 字符串） */
  readonly finishedAt: string;
  /** 同步耗时（毫秒） */
  readonly durationMs: number;
  /** 同步的用户总数 */
  readonly usersSynced: number;
  /** 同步的组织总数 */
  readonly orgsSynced: number;
  /** 跳过的用户数（幂等保护：用户未变化则跳过，对齐 TCS-LDAP-02 红线） */
  readonly usersSkipped: number;
  /** 新增的用户数（首次同步新增） */
  readonly usersCreated: number;
  /** 更新的用户数（已有用户信息变更） */
  readonly usersUpdated: number;
  /** 同步错误数 */
  readonly errorCount: number;
  /** 错误详情列表 */
  readonly errors: ReadonlyArray<{
    readonly entryUUID: string;
    readonly message: string;
  }>;
}

/**
 * LDAP 同步状态
 *
 * 描述 LDAP 同步任务的运行状态，用于幂等保护与监控。
 */
export interface LdapSyncState {
  /** 最后一次全量同步时间（ISO 8601 字符串） */
  readonly lastFullSyncAt: string | null;
  /** 最后一次增量同步时间（ISO 8601 字符串） */
  readonly lastIncrementalSyncAt: string | null;
  /** 最后一次同步结果（用于幂等校验） */
  readonly lastSyncResult: LdapSyncResult | null;
  /** 已同步用户 entryUUID 集合（用于幂等保护，避免重复创建账号） */
  readonly syncedEntryUUIDs: ReadonlySet<string>;
}

// ============================================================================
// 6. 漏洞扫描（§5.8.5）共享类型
// ============================================================================

/**
 * 漏洞严重级别（CVSS v3 评分对应分级）
 *
 * - critical：CVSS 9.0~10.0（严重）
 * - high：CVSS 7.0~8.9（高危，对齐 TCS-SEC-01 红线"CVSS ≥7 即放行"判定）
 * - medium：CVSS 4.0~6.9（中危）
 * - low：CVSS 0.1~3.9（低危）
 * - info：CVSS 0.0（信息性）
 *
 * 字面量联合而非 string，对齐 §5.8.5 三层扫描输出。
 */
export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * 漏洞严重级别全部合法值
 *
 * 使用 Object.freeze 冻结，顺序按严重程度从高到低排列。
 */
export const VULNERABILITY_SEVERITIES: ReadonlyArray<VulnerabilitySeverity> = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

/**
 * 漏洞扫描层级（字面量联合）
 *
 * 对齐 §5.8.5 三层扫描：
 * - dependency：依赖漏洞扫描（npm audit / OWASP Dependency-Check）
 * - code-defect：代码缺陷扫描（Semgrep 规则集）
 * - secret-leak：密钥泄漏扫描（gitleaks）
 */
export type VulnerabilityScanLayer = "dependency" | "code-defect" | "secret-leak";

/**
 * 漏洞扫描层级全部合法值
 *
 * 使用 Object.freeze 冻结，顺序对齐 §5.8.5 三层扫描声明顺序。
 */
export const VULNERABILITY_SCAN_LAYERS: ReadonlyArray<VulnerabilityScanLayer> = Object.freeze([
  "dependency",
  "code-defect",
  "secret-leak",
]);

/**
 * 漏洞扫描结果（单条漏洞记录）
 *
 * 描述扫描器发现的一条漏洞记录，包括漏洞 ID、严重级别、位置、修复建议等。
 */
export interface VulnerabilityFinding {
  /** 漏洞唯一标识（CVE 编号 / Semgrep 规则 ID / gitleaks fingerprint） */
  readonly id: string;
  /** 扫描层级（dependency / code-defect / secret-leak） */
  readonly layer: VulnerabilityScanLayer;
  /** 严重级别（critical / high / medium / low / info） */
  readonly severity: VulnerabilitySeverity;
  /** CVSS 评分（0~10，依赖漏洞必填，代码缺陷可选） */
  readonly cvssScore?: number;
  /** 漏洞描述 */
  readonly description: string;
  /** 受影响文件路径 */
  readonly filePath: string;
  /** 受影响行号（可选） */
  readonly line?: number;
  /** 受影响依赖名（仅 layer=dependency 时有效） */
  readonly packageName?: string;
  /** 受影响依赖版本（仅 layer=dependency 时有效） */
  readonly packageVersion?: string;
  /** 修复版本（仅 layer=dependency 时有效） */
  readonly fixedVersion?: string;
  /** 修复建议 */
  readonly fixGuidance: string;
  /** 是否可自动修复（true 表示可生成修复工作项进入 FIX 动作） */
  readonly autoFixable: boolean;
}

/**
 * 漏洞扫描报告（单层扫描结果汇总）
 *
 * 描述一个扫描层级（如 dependency / code-defect / secret-leak）的扫描结果汇总。
 */
export interface VulnerabilityScanReport {
  /** 扫描层级 */
  readonly layer: VulnerabilityScanLayer;
  /** 扫描开始时间（ISO 8601 字符串） */
  readonly startedAt: string;
  /** 扫描结束时间（ISO 8601 字符串） */
  readonly finishedAt: string;
  /** 扫描耗时（毫秒） */
  readonly durationMs: number;
  /** 发现的漏洞列表 */
  readonly findings: ReadonlyArray<VulnerabilityFinding>;
  /** critical 级别漏洞数 */
  readonly criticalCount: number;
  /** high 级别漏洞数 */
  readonly highCount: number;
  /** medium 级别漏洞数 */
  readonly mediumCount: number;
  /** low 级别漏洞数 */
  readonly lowCount: number;
  /** info 级别漏洞数 */
  readonly infoCount: number;
  /** 扫描器版本（如 "npm-audit-10.2.3" / "semgrep-1.45.0" / "gitleaks-8.18.0"） */
  readonly scannerVersion: string;
  /** 扫描备注 */
  readonly notes: string;
}

/**
 * 漏洞扫描综合结果（三层扫描汇总）
 *
 * 描述 §5.8.5 三层扫描的综合输出，作为 Verification 阶段判定"是否放行"的依据。
 */
export interface VulnerabilityScanResult {
  /** 三层扫描报告 */
  readonly reports: ReadonlyArray<VulnerabilityScanReport>;
  /** 综合判定（"pass" 通过 / "fix" 需修复 / "human-checkpoint" 转人工） */
  readonly verdict: "pass" | "fix" | "human-checkpoint";
  /** 高危漏洞（CVSS ≥7）总数（critical + high，对齐 TCS-SEC-01 红线） */
  readonly highRiskCount: number;
  /** 是否检测到硬编码密钥（对齐 TCS-SEC-02 红线，与 E6 联动） */
  readonly hasHardcodedSecret: boolean;
  /** 可自动修复的漏洞数 */
  readonly autoFixableCount: number;
  /** 需转人工的漏洞数 */
  readonly humanCheckpointCount: number;
  /** 修复工作项清单（自动生成的 FIX 动作输入） */
  readonly fixWorkItems: ReadonlyArray<VulnerabilityFixWorkItem>;
}

/**
 * 漏洞修复工作项
 *
 * 描述一个漏洞修复工作项的内容，用于进入 FIX 动作或 HUMAN_CHECKPOINT。
 */
export interface VulnerabilityFixWorkItem {
  /** 工作项 ID（自动生成，如 "FIX-VULN-001"） */
  readonly id: string;
  /** 关联的漏洞 ID */
  readonly vulnerabilityId: string;
  /** 修复优先级（critical / high 必须为 "urgent"） */
  readonly priority: "urgent" | "high" | "medium" | "low";
  /** 修复类型（"auto" 自动修复 / "manual" 人工修复） */
  readonly type: "auto" | "manual";
  /** 修复描述 */
  readonly description: string;
  /** 修复步骤清单 */
  readonly steps: ReadonlyArray<string>;
  /** 修复后验证方法（如 "运行 npm audit 验证漏洞已消除"） */
  readonly verificationMethod: string;
  /** 是否阻塞放行（true 表示必须修复后才能放行，对齐 TCS-SEC-01） */
  readonly blocksRelease: boolean;
}

/**
 * 合规检查结果（与漏洞扫描联动）
 *
 * 描述 TCS 红线检查的合规判定结果，作为评估器 Verification 阶段的红线判定输出。
 */
export interface ComplianceCheckResult {
  /** 检查的红线 ID */
  readonly redlineId: TcsRedlineId;
  /** 检查时间戳（ISO 8601 字符串） */
  readonly checkedAt: string;
  /** 检查结论（"passed" 通过 / "violated" 违规） */
  readonly status: "passed" | "violated";
  /** 违规详情（status=violated 时填写） */
  readonly violations: ReadonlyArray<{
    /** 违规文件路径 */
    readonly filePath: string;
    /** 违规行号（可选） */
    readonly line?: number;
    /** 违规描述 */
    readonly description: string;
    /** 修复建议 */
    readonly fixSuggestion: string;
  }>;
  /** 检查证据（用于审计） */
  readonly evidence: string;
}

// ============================================================================
// 7. 红线 fixtures（样例库）共享类型
// ============================================================================

/**
 * 红线 fixture 样例类型（违规 / 合规）
 *
 * 用于区分 fixture 是违规样例还是合规样例。
 */
export type FixtureKind = "violation" | "compliant";

/**
 * 红线 fixture 样例结构
 *
 * 描述单条红线 fixture 的完整内容，包括关联的红线 ID、样例代码、预期违规信息等。
 * 用于测试评估器对红线的判定准确性。
 */
export interface RedlineFixture {
  /** 关联的红线 ID（如 "TCS-OSS-01"） */
  readonly redlineId: TcsRedlineId;
  /** 样例类型（violation 违规 / compliant 合规） */
  readonly kind: FixtureKind;
  /** 样例描述（说明样例展示的场景与意图） */
  readonly description: string;
  /** 样例代码（真实可读的 TypeScript/Java/Python 代码片段） */
  readonly code: string;
  /** 样例代码语言（"typescript" / "java" / "python"） */
  readonly language: "typescript" | "java" | "python";
  /** 预期违规信息（仅 kind=violation 时填写，描述评估器应识别的违规点） */
  readonly expectedViolations: ReadonlyArray<{
    /** 违规文件路径（样例代码模拟的文件路径） */
    readonly filePath: string;
    /** 违规行号（1-based，可选） */
    readonly line?: number;
    /** 违规描述 */
    readonly description: string;
  }>;
  /** 预期评估结论（"violated" 违规 / "passed" 通过） */
  readonly expectedVerdict: "violated" | "passed";
}

// ============================================================================
// 8. 通用辅助函数
// ============================================================================

/**
 * 深度冻结辅助函数
 *
 * 递归冻结对象的所有嵌套属性，确保配置的所有层级都不可变。
 * 对齐 §5.12.4 G-A6d 配置冻结原则——防止运行期被 LLM 自改。
 *
 * 实现说明：
 * - 仅冻结对象类型（typeof === "object" 且非 null）
 * - 跳过函数类型（避免冻结原型链上的方法）
 * - 即使父对象已冻结，仍递归检查子属性（子属性可能未冻结）
 *
 * @param obj 待冻结的对象
 * @returns 冻结后的对象（同引用）
 */
export function deepFreeze<T>(obj: T): T {
  // 仅处理对象且非 null
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  // 冻结自身（若未冻结；Object.freeze 幂等，重复调用无副作用）
  if (!Object.isFrozen(obj)) {
    Object.freeze(obj);
  }
  // 关键：无论自身是否已冻结，都必须递归检查子属性。
  // 因为子对象可能未冻结，必须通过递归补冻结才能保证深度不可变。
  const keys = Object.keys(obj as Record<string, unknown>);
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object") {
      deepFreeze(value);
    }
  }
  return obj;
}
