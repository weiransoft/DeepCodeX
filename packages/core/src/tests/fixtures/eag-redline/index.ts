/**
 * redline-fixtures 样例库聚合入口（EAG-P2 批次 9 测试基础设施）
 *
 * 本模块提供 redline-fixtures 样例库的加载、过滤、校验 API：
 * - 静态 import 全部 38 个样例模块（避免运行时动态 import 的异步复杂性）
 * - 导出 FIXTURE_MANIFEST 常量（冻结的 manifest.json 内容）
 * - 实现 loadAllFixtures() 加载全部样例（manifest 元数据 + artifacts 合并）
 * - 实现 getFixturesByChecker() / getFixturesByRedlineId() / getFixturesByKind() 过滤查询
 * - 实现 validateFixtureManifest() 完整性校验
 *
 * 设计依据：
 * - EAG-P2 批次 9 redline-fixtures 设计 §1.5 index.ts Barrel 导出设计
 * - 不可变优先原则：全部导出常量使用 Object.freeze 冻结
 * - 静态 import 38 个样例模块（每个模块导出 artifacts 常量）
 *
 * @module core/tests/fixtures/eag-redline/index
 */

import manifestJson from "./manifest.json";
import type { FixtureManifest, LoadedFixture, FixtureManifestEntry } from "./types";

// ============================================================================
// 1. 静态 import 全部 38 个样例模块
// ============================================================================

// Checker 1: SagaDetector (E1) - 2 个样例
import { artifacts as sagaViolation } from "./saga-detector/e1-cross-aggregate-write.violation";
import { artifacts as sagaCompliant } from "./saga-detector/e1-saga-orchestrator.compliant";

// Checker 2: IdempotencyChecker (E2) - 2 个样例
import { artifacts as idempotencyViolation } from "./idempotency-checker/e2-no-idempotency-key.violation";
import { artifacts as idempotencyCompliant } from "./idempotency-checker/e2-with-idempotency-key.compliant";

// Checker 3: AuditEventMatcher (E3) - 2 个样例
import { artifacts as auditEventViolation } from "./audit-event-matcher/e3-state-change-no-event.violation";
import { artifacts as auditEventCompliant } from "./audit-event-matcher/e3-state-change-with-event.compliant";

// Checker 4: ImportAnalyzer (E4 + TCS-OSS-01) - 4 个样例
import { artifacts as importE4Violation } from "./import-analyzer/e4-domain-imports-infra.violation";
import { artifacts as importE4Compliant } from "./import-analyzer/e4-domain-clean.compliant";
import { artifacts as importOssViolation } from "./import-analyzer/tcs-oss-01-direct-sdk.violation";
import { artifacts as importOssCompliant } from "./import-analyzer/tcs-oss-01-port-abstraction.compliant";

// Checker 5: DtoValidatorChecker (E5) - 2 个样例
import { artifacts as dtoValidatorViolation } from "./dto-validator-checker/e5-dto-no-validator.violation";
import { artifacts as dtoValidatorCompliant } from "./dto-validator-checker/e5-dto-with-validator.compliant";

// Checker 6: HardcodeSecretScanner (E6 + TCS-SEC-02) - 2 个样例
import { artifacts as hardcodeSecretViolation } from "./hardcode-secret-scanner/e6-hardcoded-aws-key.violation";
import { artifacts as hardcodeSecretCompliant } from "./hardcode-secret-scanner/e6-env-var-reference.compliant";

// Checker 7: AnemicModelDetector (E7) - 2 个样例
import { artifacts as anemicModelViolation } from "./anemic-model-detector/e7-anemic-entity.violation";
import { artifacts as anemicModelCompliant } from "./anemic-model-detector/e7-rich-entity.compliant";

// Checker 8: ContractExistenceChecker (E8) - 2 个样例
import { artifacts as contractExistenceViolation } from "./contract-existence-checker/e8-controller-no-openapi.violation";
import { artifacts as contractExistenceCompliant } from "./contract-existence-checker/e8-controller-with-openapi.compliant";

// Checker 9: CachePatternChecker (TCS-CACHE-01/02/03) - 6 个样例
import { artifacts as cacheTtlViolation } from "./cache-pattern-checker/tcs-cache-01-no-ttl.violation";
import { artifacts as cacheTtlCompliant } from "./cache-pattern-checker/tcs-cache-01-with-ttl.compliant";
import { artifacts as cacheOrderViolation } from "./cache-pattern-checker/tcs-cache-02-wrong-order.violation";
import { artifacts as cacheOrderCompliant } from "./cache-pattern-checker/tcs-cache-02-correct-order.compliant";
import { artifacts as cacheNullViolation } from "./cache-pattern-checker/tcs-cache-03-no-null-cache.violation";
import { artifacts as cacheNullCompliant } from "./cache-pattern-checker/tcs-cache-03-with-null-cache.compliant";

// Checker 10: SqlPatternChecker (TCS-SQL-01/02/03) - 6 个样例
import { artifacts as sqlSelectAllViolation } from "./sql-pattern-checker/tcs-sql-01-select-all.violation";
import { artifacts as sqlSelectAllCompliant } from "./sql-pattern-checker/tcs-sql-01-explicit-columns.compliant";
import { artifacts as sqlNPlusOneViolation } from "./sql-pattern-checker/tcs-sql-02-n-plus-one.violation";
import { artifacts as sqlNPlusOneCompliant } from "./sql-pattern-checker/tcs-sql-02-batch-query.compliant";
import { artifacts as sqlOffsetViolation } from "./sql-pattern-checker/tcs-sql-03-deep-offset.violation";
import { artifacts as sqlOffsetCompliant } from "./sql-pattern-checker/tcs-sql-03-cursor-pagination.compliant";

// Checker 11: LdapPatternChecker (TCS-LDAP-01/02) - 4 个样例
import { artifacts as ldapDirectViolation } from "./ldap-pattern-checker/tcs-ldap-01-direct-ldap.violation";
import { artifacts as ldapDirectCompliant } from "./ldap-pattern-checker/tcs-ldap-01-sync-port.compliant";
import { artifacts as ldapIdempotentViolation } from "./ldap-pattern-checker/tcs-ldap-02-no-idempotent.violation";
import { artifacts as ldapIdempotentCompliant } from "./ldap-pattern-checker/tcs-ldap-02-upsert.compliant";

// Checker 12: DependencyScanner (TCS-SEC-01) - 2 个样例
import { artifacts as dependencyViolation } from "./dependency-scanner/tcs-sec-01-vulnerable-lodash.violation";
import { artifacts as dependencyCompliant } from "./dependency-scanner/tcs-sec-01-fixed-version.compliant";

// Checker 13: ContractGuardChecker (棕地专属) - 2 个样例
import {
  artifacts as contractGuardViolation,
  BROWNFIELD_BASELINE as contractGuardViolationBaseline,
} from "./contract-guard-checker/brownfield-api-breaking-change.violation";
import {
  artifacts as contractGuardCompliant,
  BROWNFIELD_BASELINE as contractGuardCompliantBaseline,
} from "./contract-guard-checker/brownfield-api-compatible.compliant";

// ============================================================================
// 2. manifest 常量导出
// ============================================================================

/**
 * manifest 常量（冻结）
 *
 * 从 manifest.json 加载的样例库清单，包含 13 个 Checker 的元数据和 38 个样例的详细信息。
 * 使用 Object.freeze 冻结防止运行期修改。
 */
export const FIXTURE_MANIFEST: FixtureManifest = Object.freeze(manifestJson) as FixtureManifest;

// ============================================================================
// 3. fixtureId → artifacts 的静态映射
// ============================================================================

/**
 * fixtureId → artifacts 的静态映射（冻结）
 *
 * 将 38 个样例的 fixtureId 映射到对应的 artifacts 数组，
 * 供 loadAllFixtures() 合并 manifest 元数据与代码产出物。
 */
const ARTIFACTS_MAP: ReadonlyMap<
  string,
  ReadonlyArray<{ readonly path: string; readonly content: string }>
> = Object.freeze(
  new Map([
    // Checker 1: SagaDetector (E1)
    ["saga-detector/e1-cross-aggregate-write.violation", sagaViolation],
    ["saga-detector/e1-saga-orchestrator.compliant", sagaCompliant],

    // Checker 2: IdempotencyChecker (E2)
    ["idempotency-checker/e2-no-idempotency-key.violation", idempotencyViolation],
    ["idempotency-checker/e2-with-idempotency-key.compliant", idempotencyCompliant],

    // Checker 3: AuditEventMatcher (E3)
    ["audit-event-matcher/e3-state-change-no-event.violation", auditEventViolation],
    ["audit-event-matcher/e3-state-change-with-event.compliant", auditEventCompliant],

    // Checker 4: ImportAnalyzer (E4 + TCS-OSS-01)
    ["import-analyzer/e4-domain-imports-infra.violation", importE4Violation],
    ["import-analyzer/e4-domain-clean.compliant", importE4Compliant],
    ["import-analyzer/tcs-oss-01-direct-sdk.violation", importOssViolation],
    ["import-analyzer/tcs-oss-01-port-abstraction.compliant", importOssCompliant],

    // Checker 5: DtoValidatorChecker (E5)
    ["dto-validator-checker/e5-dto-no-validator.violation", dtoValidatorViolation],
    ["dto-validator-checker/e5-dto-with-validator.compliant", dtoValidatorCompliant],

    // Checker 6: HardcodeSecretScanner (E6 + TCS-SEC-02)
    ["hardcode-secret-scanner/e6-hardcoded-aws-key.violation", hardcodeSecretViolation],
    ["hardcode-secret-scanner/e6-env-var-reference.compliant", hardcodeSecretCompliant],

    // Checker 7: AnemicModelDetector (E7)
    ["anemic-model-detector/e7-anemic-entity.violation", anemicModelViolation],
    ["anemic-model-detector/e7-rich-entity.compliant", anemicModelCompliant],

    // Checker 8: ContractExistenceChecker (E8)
    ["contract-existence-checker/e8-controller-no-openapi.violation", contractExistenceViolation],
    ["contract-existence-checker/e8-controller-with-openapi.compliant", contractExistenceCompliant],

    // Checker 9: CachePatternChecker (TCS-CACHE-01/02/03)
    ["cache-pattern-checker/tcs-cache-01-no-ttl.violation", cacheTtlViolation],
    ["cache-pattern-checker/tcs-cache-01-with-ttl.compliant", cacheTtlCompliant],
    ["cache-pattern-checker/tcs-cache-02-wrong-order.violation", cacheOrderViolation],
    ["cache-pattern-checker/tcs-cache-02-correct-order.compliant", cacheOrderCompliant],
    ["cache-pattern-checker/tcs-cache-03-no-null-cache.violation", cacheNullViolation],
    ["cache-pattern-checker/tcs-cache-03-with-null-cache.compliant", cacheNullCompliant],

    // Checker 10: SqlPatternChecker (TCS-SQL-01/02/03)
    ["sql-pattern-checker/tcs-sql-01-select-all.violation", sqlSelectAllViolation],
    ["sql-pattern-checker/tcs-sql-01-explicit-columns.compliant", sqlSelectAllCompliant],
    ["sql-pattern-checker/tcs-sql-02-n-plus-one.violation", sqlNPlusOneViolation],
    ["sql-pattern-checker/tcs-sql-02-batch-query.compliant", sqlNPlusOneCompliant],
    ["sql-pattern-checker/tcs-sql-03-deep-offset.violation", sqlOffsetViolation],
    ["sql-pattern-checker/tcs-sql-03-cursor-pagination.compliant", sqlOffsetCompliant],

    // Checker 11: LdapPatternChecker (TCS-LDAP-01/02)
    ["ldap-pattern-checker/tcs-ldap-01-direct-ldap.violation", ldapDirectViolation],
    ["ldap-pattern-checker/tcs-ldap-01-sync-port.compliant", ldapDirectCompliant],
    ["ldap-pattern-checker/tcs-ldap-02-no-idempotent.violation", ldapIdempotentViolation],
    ["ldap-pattern-checker/tcs-ldap-02-upsert.compliant", ldapIdempotentCompliant],

    // Checker 12: DependencyScanner (TCS-SEC-01)
    ["dependency-scanner/tcs-sec-01-vulnerable-lodash.violation", dependencyViolation],
    ["dependency-scanner/tcs-sec-01-fixed-version.compliant", dependencyCompliant],

    // Checker 13: ContractGuardChecker (棕地专属)
    ["contract-guard-checker/brownfield-api-breaking-change.violation", contractGuardViolation],
    ["contract-guard-checker/brownfield-api-compatible.compliant", contractGuardCompliant],
  ])
);

/**
 * 棕地专属 baseline 映射（fixtureId → baseline）
 *
 * ContractGuardChecker 样例需要注入 existingApiContracts baseline，
 * 从样例模块的 BROWNFIELD_BASELINE 命名导出读取。
 */
const BROWNFIELD_BASELINE_MAP: ReadonlyMap<
  string,
  ReadonlyArray<{ readonly apiName: string; readonly signature: string }>
> = Object.freeze(
  new Map([
    ["contract-guard-checker/brownfield-api-breaking-change.violation", contractGuardViolationBaseline],
    ["contract-guard-checker/brownfield-api-compatible.compliant", contractGuardCompliantBaseline],
  ])
);

// ============================================================================
// 4. 加载/过滤/校验函数实现
// ============================================================================

/**
 * 加载全部样例（manifest 元数据 + artifacts 合并）
 *
 * 遍历 manifest 中的全部 Checker 与 fixtures，将元数据与静态映射的 artifacts 合并为 LoadedFixture。
 * 对于 ContractGuardChecker 样例，额外注入 brownfieldBaseline。
 *
 * @returns 加载后的样例列表（38 个，只读）
 */
export function loadAllFixtures(): ReadonlyArray<LoadedFixture> {
  const result: LoadedFixture[] = [];

  // 遍历 manifest 中的全部 Checker
  for (const checker of FIXTURE_MANIFEST.checkers) {
    // 遍历该 Checker 的全部 fixtures
    for (const fixtureMeta of checker.fixtures) {
      // 从静态映射中获取 artifacts
      const artifacts = ARTIFACTS_MAP.get(fixtureMeta.fixtureId);
      if (!artifacts) {
        throw new Error(`样例 ${fixtureMeta.fixtureId} 的 artifacts 未在 ARTIFACTS_MAP 中注册`);
      }

      // 构造 LoadedFixture
      const loadedFixture: LoadedFixture = {
        meta: fixtureMeta,
        checkerClass: checker.checkerClass,
        artifacts,
      };

      // 棕地专属样例注入 baseline
      if (checker.checkerClass === "ContractGuardChecker") {
        const baseline = BROWNFIELD_BASELINE_MAP.get(fixtureMeta.fixtureId);
        if (baseline) {
          (
            loadedFixture as {
              brownfieldBaseline?: ReadonlyArray<{ readonly apiName: string; readonly signature: string }>;
            }
          ).brownfieldBaseline = baseline;
        }
      }

      result.push(loadedFixture);
    }
  }

  return Object.freeze(result);
}

/**
 * 按 Checker 类名过滤样例
 *
 * @param checkerClass Checker 类名（PascalCase，如 "SagaDetector"）
 * @returns 该 Checker 的样例列表（只读）
 */
export function getFixturesByChecker(checkerClass: string): ReadonlyArray<LoadedFixture> {
  const allFixtures = loadAllFixtures();
  return Object.freeze(allFixtures.filter((f) => f.checkerClass === checkerClass));
}

/**
 * 按红线 ID 过滤样例
 *
 * @param redlineId 红线 ID（如 "E1" / "TCS-CACHE-01"）
 * @returns 该红线的样例列表（只读）
 */
export function getFixturesByRedlineId(redlineId: string): ReadonlyArray<LoadedFixture> {
  const allFixtures = loadAllFixtures();
  return Object.freeze(allFixtures.filter((f) => f.meta.targetRedlineId === redlineId));
}

/**
 * 按 kind 过滤样例
 *
 * @param kind 样例类型（"violation" / "compliant"）
 * @returns 该类型的样例列表（只读）
 */
export function getFixturesByKind(kind: "violation" | "compliant"): ReadonlyArray<LoadedFixture> {
  const allFixtures = loadAllFixtures();
  return Object.freeze(allFixtures.filter((f) => f.meta.kind === kind));
}

/**
 * 校验 manifest 完整性
 *
 * 校验项：
 * 1. 样例总数与 manifest.totalFixtures 一致
 * 2. 每个 Checker 至少 1 对样例（violation + compliant）
 * 3. fixtureId 全局唯一
 * 4. 所有样例的 artifacts 已在 ARTIFACTS_MAP 中注册
 *
 * @returns 错误信息列表；若无错误返回 null
 */
export function validateFixtureManifest(): ReadonlyArray<string> | null {
  const errors: string[] = [];
  const fixtureIdSet = new Set<string>();
  let totalCount = 0;

  // 校验 1: 样例总数
  for (const checker of FIXTURE_MANIFEST.checkers) {
    totalCount += checker.fixtures.length;

    // 校验 2: 每个 Checker 至少 1 对样例
    const violationCount = checker.fixtures.filter((f) => f.kind === "violation").length;
    const compliantCount = checker.fixtures.filter((f) => f.kind === "compliant").length;
    if (violationCount < 1 || compliantCount < 1) {
      errors.push(
        `Checker ${checker.checkerName} 样例不完整：violation=${violationCount}, compliant=${compliantCount}，应至少各 1 个`
      );
    }

    // 校验 3: fixtureId 全局唯一
    for (const fixture of checker.fixtures) {
      if (fixtureIdSet.has(fixture.fixtureId)) {
        errors.push(`fixtureId 重复：${fixture.fixtureId}`);
      }
      fixtureIdSet.add(fixture.fixtureId);

      // 校验 4: artifacts 已注册
      if (!ARTIFACTS_MAP.has(fixture.fixtureId)) {
        errors.push(`样例 ${fixture.fixtureId} 的 artifacts 未在 ARTIFACTS_MAP 中注册`);
      }
    }
  }

  // 校验 1: 总数一致
  if (totalCount !== FIXTURE_MANIFEST.totalFixtures) {
    errors.push(`样例总数不一致：manifest.totalFixtures=${FIXTURE_MANIFEST.totalFixtures}，实际=${totalCount}`);
  }

  return errors.length > 0 ? Object.freeze(errors) : null;
}

// ============================================================================
// 5. 类型导出（便于测试文件使用）
// ============================================================================

export type { FixtureManifest, LoadedFixture, FixtureManifestEntry } from "./types";
