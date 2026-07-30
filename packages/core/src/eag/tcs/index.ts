/**
 * TCS（Technical Component Specification，企业技术组件规范包）模块入口
 *
 * 本模块是 EAG（企业应用生成）体系 §5.8 企业技术组件规范包的统一对外入口，
 * 汇总 TCS 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.8 企业技术组件规范包（v1.3 新增）
 * - §5.8.1 对象存储规范（ObjectStoragePort + S3/OSS/MinIO 三适配器）
 * - §5.8.2 缓存规范（多级缓存 + 三防设计）
 * - §5.8.3 SQL 查询优化规范（索引评审 + N+1 检测 + 深分页禁令）
 * - §5.8.4 LDAP / SSO 接入规范（双通道同步 + 幂等保护）
 * - §5.8.5 漏洞扫描与修复闭环（三层扫描 + 修复闭环）
 *
 * 模块结构：
 * - types.ts：TCS 核心类型定义（TcsRedlineId / ObjectStoragePort / CachePort / SqlOptimizationPort / LdapSyncPort / VulnerabilityScanPort / RedlineFixture 等）
 * - object-storage.ts：对象存储适配器（S3Adapter / OssAdapter / MinioAdapter）
 * - cache.ts：多级缓存实现（MultiLevelCache + 三防设计）
 * - sql-optimizer.ts：SQL 优化器（IndexReviewer + NPlusOneDetector + PaginationChecker）
 * - ldap-adapter.ts：LDAP 同步器（LdapSynchronizer + 双通道同步 + 幂等保护）
 * - vulnerability-scanner.ts：漏洞扫描器（VulnerabilityScanner + 三层扫描 + 修复闭环）
 * - tcs-redlines.ts：13 条 TCS 红线清单定义
 * - fixtures/：26 个 redline-fixtures 样例库（13 条红线 × 2 个样例）
 *
 * 公开 API（barrel 导出）：
 * - 类型：TcsRedlineId / TcsRedlineCategory / StorageProvider / CacheTier / SqlQueryType / LdapSyncMode / LdapDegradationStrategy / VulnerabilitySeverity / VulnerabilityScanLayer / FixtureKind
 * - 接口：ObjectStorageConfig / StorageKeyParams / PutOptions / PutResult / GetResult / DeleteResult / SignedUrlResult / MultipartUploadSession / MultipartOptions / MultipartResult / CacheKeyParams / CacheSetOptions / CacheGetResult / CacheMutexResult / CacheDoubleWriteResult / IndexReviewInput / IndexDefinition / ModelFieldDefinition / IndexReviewResult / NPlusOneDetectionResult / PaginationCheckResult / LdapConfig / LdapUserEntry / LdapOrgEntry / LdapSyncResult / LdapSyncState / VulnerabilityFinding / VulnerabilityScanReport / VulnerabilityScanResult / VulnerabilityFixWorkItem / ComplianceCheckResult / RedlineFixture / HttpResponse / StorageHttpClient / ObjectStoragePort / RedisClient / CacheSerializer / CachePort / SqlOptimizationPort / LdapClient / UserMirrorStore / LdapSyncPort / ScannerAdapter / VulnerabilityScanPort / TcsRedlineStats
 * - 类：JsonCacheSerializer / BloomFilter / MultiLevelCache / S3Adapter / OssAdapter / MinioAdapter / IndexReviewer / NPlusOneDetector / PaginationChecker / SqlOptimizer / LdapSynchronizer / VulnerabilityScanner
 * - 函数：deepFreeze / generateStorageKey / generateUuidV4 / validateFileExtension / validateFileSize / validateSignedUrlExpiry / signAwsSigV4 / signOssV1 / createObjectStorage / generateCacheKey / generateMutexKey / computeJitteredTtl / createCache / createSqlOptimizer / createLdapSynchronizer / createVulnerabilityScanner / getTcsRedlineCount / getTcsRedlinesBySeverity / getTcsRedlineById / getTcsRedlinesByCategory / isValidTcsRedlineId / isValidTcsRedlineCategory / getTcsRedlineStats / getFixturesByRedlineId / getFixturesByKind / getTcsFixtureCount / validateTcsFixtures
 * - 常量：TCS_REDLINE_IDS / TCS_REDLINE_CATEGORIES / STORAGE_PROVIDERS / CACHE_TIERS / LDAP_SYNC_MODES / VULNERABILITY_SEVERITIES / VULNERABILITY_SCAN_LAYERS / DEFAULT_SIGNED_URL_EXPIRY_SECONDS / MAX_SIGNED_URL_EXPIRY_SECONDS / DEFAULT_MULTIPART_THRESHOLD_BYTES / DEFAULT_PART_SIZE_BYTES / DEFAULT_MAX_FILE_BYTES / DEFAULT_LOCAL_TTL_SECONDS / DEFAULT_REDIS_TTL_SECONDS / DEFAULT_TTL_JITTER_RATIO / DEFAULT_MUTEX_EXPIRY_SECONDS / DEFAULT_NULL_CACHE_TTL_SECONDS / DEFAULT_BLOOM_EXPECTED_ITEMS / DEFAULT_BLOOM_FALSE_POSITIVE_RATE / DEEP_PAGINATION_THRESHOLD / QUERY_CALL_KEYWORDS / LOOP_KEYWORDS / MIN_DETECTION_CONFIDENCE / DEFAULT_SYNC_BATCH_SIZE / DEFAULT_FULL_SYNC_INTERVAL_SECONDS / DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS / DEFAULT_DEGRADATION_STRATEGY / DEFAULT_LDAP_FAILURE_THRESHOLD / HIGH_RISK_CVSS_THRESHOLD / DEFAULT_SCAN_TIMEOUT_MS / SEVERITY_TO_FIX_PRIORITY
 * - 红线清单：TCS_REDLINES
 * - fixtures 清单：TCS_FIXTURES / OSS_FIXTURES / CACHE_FIXTURES / SQL_FIXTURES / LDAP_FIXTURES / SECURITY_FIXTURES
 *
 * @module eag/tcs
 */

// ============================================================================
// 类型定义（from types.ts）
// ============================================================================

export type {
  // 基础类型
  TcsRedlineId,
  TcsRedlineCategory,
  StorageProvider,
  CacheTier,
  SqlQueryType,
  LdapSyncMode,
  LdapDegradationStrategy,
  VulnerabilitySeverity,
  VulnerabilityScanLayer,
  FixtureKind,
  // 对象存储类型
  ObjectStorageConfig,
  StorageKeyParams,
  PutOptions,
  PutResult,
  GetResult,
  DeleteResult,
  SignedUrlResult,
  MultipartUploadSession,
  MultipartOptions,
  MultipartResult,
  // 缓存类型
  CacheKeyParams,
  CacheSetOptions,
  CacheGetResult,
  CacheMutexResult,
  CacheDoubleWriteResult,
  // SQL 优化类型
  IndexReviewInput,
  IndexDefinition,
  ModelFieldDefinition,
  IndexReviewResult,
  NPlusOneDetectionResult,
  PaginationCheckResult,
  // LDAP 类型
  LdapConfig,
  LdapUserEntry,
  LdapOrgEntry,
  LdapSyncResult,
  LdapSyncState,
  // 漏洞扫描类型
  VulnerabilityFinding,
  VulnerabilityScanReport,
  VulnerabilityScanResult,
  VulnerabilityFixWorkItem,
  ComplianceCheckResult,
  // fixture 类型
  RedlineFixture,
} from "./types";

export {
  TCS_REDLINE_IDS,
  TCS_REDLINE_CATEGORIES,
  STORAGE_PROVIDERS,
  CACHE_TIERS,
  LDAP_SYNC_MODES,
  VULNERABILITY_SEVERITIES,
  VULNERABILITY_SCAN_LAYERS,
  deepFreeze,
} from "./types";

// ============================================================================
// 对象存储适配器（from object-storage.ts）
// ============================================================================

export type { HttpResponse, StorageHttpClient, ObjectStoragePort } from "./object-storage";

export {
  // 默认配置常量
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  MAX_SIGNED_URL_EXPIRY_SECONDS,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  // 工具函数
  generateStorageKey,
  generateUuidV4,
  validateFileExtension,
  validateFileSize,
  validateSignedUrlExpiry,
  signAwsSigV4,
  signOssV1,
  // 适配器类
  S3Adapter,
  OssAdapter,
  MinioAdapter,
  // 工厂函数
  createObjectStorage,
} from "./object-storage";

// ============================================================================
// 多级缓存（from cache.ts）
// ============================================================================

export type { RedisClient, CacheSerializer, CachePort } from "./cache";

export {
  // 默认配置常量
  DEFAULT_LOCAL_TTL_SECONDS,
  DEFAULT_REDIS_TTL_SECONDS,
  DEFAULT_TTL_JITTER_RATIO,
  DEFAULT_MUTEX_EXPIRY_SECONDS,
  DEFAULT_NULL_CACHE_TTL_SECONDS,
  DEFAULT_BLOOM_EXPECTED_ITEMS,
  DEFAULT_BLOOM_FALSE_POSITIVE_RATE,
  // 工具类
  JsonCacheSerializer,
  BloomFilter,
  // 工具函数
  generateCacheKey,
  generateMutexKey,
  computeJitteredTtl,
  // 缓存实现类
  MultiLevelCache,
  // 工厂函数
  createCache,
} from "./cache";

// ============================================================================
// SQL 优化器（from sql-optimizer.ts）
// ============================================================================

export type { SqlOptimizationPort } from "./sql-optimizer";

export {
  // 默认配置常量
  DEEP_PAGINATION_THRESHOLD,
  QUERY_CALL_KEYWORDS,
  LOOP_KEYWORDS,
  MIN_DETECTION_CONFIDENCE,
  // 优化器实现类
  IndexReviewer,
  NPlusOneDetector,
  PaginationChecker,
  SqlOptimizer,
  // 工厂函数
  createSqlOptimizer,
} from "./sql-optimizer";

// ============================================================================
// LDAP 同步器（from ldap-adapter.ts）
// ============================================================================

export type { LdapClient, UserMirrorStore, LdapSyncPort } from "./ldap-adapter";

export {
  // 默认配置常量
  DEFAULT_SYNC_BATCH_SIZE,
  DEFAULT_FULL_SYNC_INTERVAL_SECONDS,
  DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS,
  DEFAULT_DEGRADATION_STRATEGY,
  DEFAULT_LDAP_FAILURE_THRESHOLD,
  // 同步器实现类
  LdapSynchronizer,
  // 工厂函数
  createLdapSynchronizer,
} from "./ldap-adapter";

// ============================================================================
// 漏洞扫描器（from vulnerability-scanner.ts）
// ============================================================================

export type { ScannerAdapter, VulnerabilityScanPort } from "./vulnerability-scanner";

export {
  // 默认配置常量
  HIGH_RISK_CVSS_THRESHOLD,
  DEFAULT_SCAN_TIMEOUT_MS,
  SEVERITY_TO_FIX_PRIORITY,
  // 扫描器实现类
  VulnerabilityScanner,
  // 工厂函数
  createVulnerabilityScanner,
} from "./vulnerability-scanner";

// ============================================================================
// TCS 红线清单（from tcs-redlines.ts）
// ============================================================================

export type { TcsRedlineStats } from "./tcs-redlines";

export {
  // 红线清单
  TCS_REDLINES,
  // 查询函数
  getTcsRedlineCount,
  getTcsRedlinesBySeverity,
  getTcsRedlineById,
  getTcsRedlinesByCategory,
  // 校验函数
  isValidTcsRedlineId,
  isValidTcsRedlineCategory,
  // 统计函数
  getTcsRedlineStats,
} from "./tcs-redlines";

// ============================================================================
// TCS 红线 fixtures 样例库（from fixtures/）
// ============================================================================

export {
  // 全量 fixtures
  TCS_FIXTURES,
  // 分类 fixtures
  OSS_FIXTURES,
  CACHE_FIXTURES,
  SQL_FIXTURES,
  LDAP_FIXTURES,
  SECURITY_FIXTURES,
  // 查询函数
  getFixturesByRedlineId,
  getFixturesByKind,
  getTcsFixtureCount,
  validateTcsFixtures,
} from "./fixtures/index";
