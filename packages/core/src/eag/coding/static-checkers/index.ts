/**
 * 静态判定器注册表（S2 判定器层 barrel 导出 + DEFAULT_STATIC_CHECKERS）
 *
 * 本模块对应 EAG-P2 批次 9 设计 §4.5.5 默认静态判定器注册表：
 * - 统一导出 13 个 StaticChecker 类与共享工具函数
 * - 维护 redlineId → StaticChecker 实例的注册表（DEFAULT_STATIC_CHECKERS）
 * - StrictEvaluator 按此注册表路由到对应 Checker 实例
 *
 * 注册表设计：
 * - 多对一映射：多个 redlineId 可映射到同一 Checker 实例
 *   （如 E4 与 TCS-OSS-01 都映射到 ImportAnalyzer）
 * - Object.freeze 冻结：防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）
 * - ReadonlyMap 类型：编译期保证不可变
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单（13 个）
 * - EAG-P2 批次 9 设计 §4.5.5 DEFAULT_STATIC_CHECKERS 注册表
 *
 * 不可变优先原则：
 * - DEFAULT_STATIC_CHECKERS 使用 Object.freeze(new Map([...])) 冻结
 * - 所有 Checker 类的 redlineIds 字段使用 Object.freeze 冻结
 * - 导出类型使用 ReadonlyMap / ReadonlyArray
 *
 * @module eag/coding/static-checkers
 */

// ============================================================================
// 1. 共享工具函数导出
// ============================================================================

export type { ImportStatement, DecoratorInfo, ClassMethodInfo, StringLiteral } from "./checker-utils";

export {
  scanImports,
  scanDecorators,
  scanClassMethods,
  scanStringLiterals,
  buildViolation,
  buildViolations,
  buildPass,
  buildUnknown,
  extractFilePathFromComment,
  lineOf,
} from "./checker-utils";

// ============================================================================
// 2. 13 个静态判定器类导出
// ============================================================================

// E4 / TCS-OSS-01：依赖方向 + 业务代码禁直连 OSS SDK
export { ImportAnalyzer } from "./import-analyzer";

// E6 / TCS-SEC-02：硬编码密钥扫描（gitleaks 规则集移植）
export { HardcodeSecretScanner } from "./hardcode-secret-scanner";

// E2：幂等性检查（API 端点幂等键 + 事件处理器去重表）
export { IdempotencyChecker } from "./idempotency-checker";

// E1：事务边界（跨聚合写调用图 + Saga 类存在性）
export { SagaDetector } from "./saga-detector";

// E3：审计（实体状态变更点 vs 领域事件发布点 1:1 比对）
export { AuditEventMatcher } from "./audit-event-matcher";

// E5：输入校验（DTO class-validator 装饰器扫描）
export { DtoValidatorChecker } from "./dto-validator-checker";

// E7：贫血模型禁令（实体方法密度启发式）
export { AnemicModelDetector } from "./anemic-model-detector";

// E8：API 契约（OpenAPI spec + 契约测试文件存在性）
export { ContractExistenceChecker } from "./contract-existence-checker";

// TCS-CACHE-01/02/03：缓存模式（TTL / 双写顺序 / 空值缓存）
export { CachePatternChecker } from "./cache-pattern-checker";

// TCS-SQL-01/02/03：SQL 模式（无索引 WHERE / 循环内查询 / OFFSET > 10000）
export { SqlPatternChecker } from "./sql-pattern-checker";

// TCS-LDAP-01/02：LDAP 模式（直连查询 / 同步任务幂等）
export { LdapPatternChecker } from "./ldap-pattern-checker";

// TCS-SEC-01：依赖漏洞扫描（npm audit 输出 + 已知漏洞依赖版本）
export { DependencyScanner } from "./dependency-scanner";

// TCS-OSS-02/03：对象存储模式（签名 URL 过期时间 / 文件上传校验）
// 批次 12 收尾补全：批次 9 设计 §4.5.4 应实现但遗漏，本批次补全
export { OssPatternChecker } from "./oss-pattern-checker";

// 棕地专属：既有 API 契约保护（复用 discovery/existing-contract-guard）
export { ContractGuardChecker } from "./contract-guard-checker";

// ============================================================================
// 3. 类型导入（仅 type-only）
// ============================================================================

import type { StaticChecker } from "../types";

// ============================================================================
// 4. 实例化所有 Checker（按 §4.5.5 注册表顺序）
// ============================================================================

// 注：实例化放在 import 之后，避免循环依赖。
// 每个 Checker 实例为无状态单例（无字段、无副作用），可安全共享。
import { ImportAnalyzer } from "./import-analyzer";
import { HardcodeSecretScanner } from "./hardcode-secret-scanner";
import { IdempotencyChecker } from "./idempotency-checker";
import { SagaDetector } from "./saga-detector";
import { AuditEventMatcher } from "./audit-event-matcher";
import { DtoValidatorChecker } from "./dto-validator-checker";
import { AnemicModelDetector } from "./anemic-model-detector";
import { ContractExistenceChecker } from "./contract-existence-checker";
import { CachePatternChecker } from "./cache-pattern-checker";
import { SqlPatternChecker } from "./sql-pattern-checker";
import { LdapPatternChecker } from "./ldap-pattern-checker";
import { DependencyScanner } from "./dependency-scanner";
import { OssPatternChecker } from "./oss-pattern-checker";
import { ContractGuardChecker } from "./contract-guard-checker";

/**
 * 默认静态判定器注册表
 *
 * 对应 EAG-P2 批次 9 设计 §4.5.5 DEFAULT_STATIC_CHECKERS：
 * 维护 redlineId → StaticChecker 实例的映射。
 *
 * 注册规则（多对一映射）：
 * - E1 → SagaDetector（事务边界检查）
 * - E2 → IdempotencyChecker（幂等性检查）
 * - E3 → AuditEventMatcher（审计事件比对）
 * - E4 → ImportAnalyzer（依赖方向检查）
 * - E5 → DtoValidatorChecker（DTO 输入校验）
 * - E6 → HardcodeSecretScanner（硬编码密钥扫描）
 * - E7 → AnemicModelDetector（贫血模型检测）
 * - E8 → ContractExistenceChecker（API 契约存在性）
 * - TCS-OSS-01 → ImportAnalyzer（业务代码禁直连 OSS SDK）
 * - TCS-OSS-02 → OssPatternChecker（签名 URL 过期时间，批次 12 补全）
 * - TCS-OSS-03 → OssPatternChecker（文件上传校验，批次 12 补全）
 * - TCS-CACHE-01/02/03 → CachePatternChecker（缓存三防设计）
 * - TCS-SQL-01/02/03 → SqlPatternChecker（SQL 优化三红线）
 * - TCS-LDAP-01/02 → LdapPatternChecker（LDAP 接入双红线）
 * - TCS-SEC-01 → DependencyScanner（依赖漏洞扫描）
 * - TCS-SEC-02 → HardcodeSecretScanner（同 E6，gitleaks 规则集）
 *
 * 历史背景：TCS-OSS-02 / TCS-OSS-03 在批次 9 设计中应有但遗漏，
 * 批次 12 C2 端到端测试发现 StrictEvaluator 对这两条红线返回 unknown
 * 触发 decideVerdict 的 unknownBlockerOrMajor > 0 → human_checkpoint。
 * 本批次补全 OssPatternChecker 后注册表覆盖全部 21 条 redlineId 映射。
 *
 * 注：ContractGuardChecker（棕地专属）未在此注册——
 * 该 Checker 由 StrictEvaluator 在棕地场景下按需实例化并注入既有 API 契约清单。
 *
 * 使用 Object.freeze(new Map([...])) 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
export const DEFAULT_STATIC_CHECKERS: ReadonlyMap<string, StaticChecker> = Object.freeze(
  new Map<string, StaticChecker>([
    // E1~E8 企业红线
    ["E1", new SagaDetector()],
    ["E2", new IdempotencyChecker()],
    ["E3", new AuditEventMatcher()],
    ["E4", new ImportAnalyzer()],
    ["E5", new DtoValidatorChecker()],
    ["E6", new HardcodeSecretScanner()],
    ["E7", new AnemicModelDetector()],
    ["E8", new ContractExistenceChecker()],

    // TCS 红线（13 条）
    ["TCS-OSS-01", new ImportAnalyzer()],
    // 批次 12 补全：TCS-OSS-02/03 之前未注册，导致 StrictEvaluator 返回 unknown → human_checkpoint
    ["TCS-OSS-02", new OssPatternChecker()],
    ["TCS-OSS-03", new OssPatternChecker()],
    ["TCS-SEC-01", new DependencyScanner()],
    ["TCS-SEC-02", new HardcodeSecretScanner()],
    ["TCS-CACHE-01", new CachePatternChecker()],
    ["TCS-CACHE-02", new CachePatternChecker()],
    ["TCS-CACHE-03", new CachePatternChecker()],
    ["TCS-SQL-01", new SqlPatternChecker()],
    ["TCS-SQL-02", new SqlPatternChecker()],
    ["TCS-SQL-03", new SqlPatternChecker()],
    ["TCS-LDAP-01", new LdapPatternChecker()],
    ["TCS-LDAP-02", new LdapPatternChecker()],
  ])
);

/**
 * 创建棕地专属 ContractGuardChecker 实例
 *
 * 棕地场景下，StrictEvaluator 应调用此工厂函数创建 ContractGuardChecker 实例，
 * 并传入项目特有的既有 API 契约清单（existingApiContracts）。
 *
 * @param existingApiContracts 既有 API 契约清单（棕地 baseline）
 * @returns ContractGuardChecker 实例
 */
export function createContractGuardChecker(
  existingApiContracts: ReadonlyArray<{
    readonly apiName: string;
    readonly signature: string;
  }>
): ContractGuardChecker {
  return new ContractGuardChecker(existingApiContracts);
}

/**
 * 获取所有已注册的红线 ID 列表
 *
 * 工具函数：返回 DEFAULT_STATIC_CHECKERS 中所有 redlineId（按字典序排序）。
 * 用于测试断言与日志展示。
 *
 * @returns 已注册的红线 ID 列表（只读，按字典序排序）
 */
export function getRegisteredRedlineIds(): ReadonlyArray<string> {
  return Object.freeze(Array.from(DEFAULT_STATIC_CHECKERS.keys()).sort());
}

/**
 * 按 redlineId 查找 StaticChecker 实例
 *
 * @param redlineId 红线 ID（如 "E1" / "TCS-CACHE-01"）
 * @returns 对应的 StaticChecker 实例；未注册返回 undefined
 */
export function getCheckerByRedlineId(redlineId: string): StaticChecker | undefined {
  return DEFAULT_STATIC_CHECKERS.get(redlineId);
}
