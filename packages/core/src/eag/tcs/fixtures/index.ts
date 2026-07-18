/**
 * TCS 红线 fixtures 样例库聚合入口
 *
 * 汇总 5 个分类的 26 个 fixture（每条红线 1 个违规 + 1 个合规样例），
 * 作为评估器测试与回归测试的标准样例库。
 *
 * fixtures 清单：
 * - OSS_FIXTURES：6 个（TCS-OSS-01/02/03 各 2 个）
 * - CACHE_FIXTURES：6 个（TCS-CACHE-01/02/03 各 2 个）
 * - SQL_FIXTURES：6 个（TCS-SQL-01/02/03 各 2 个）
 * - LDAP_FIXTURES：4 个（TCS-LDAP-01/02 各 2 个）
 * - SECURITY_FIXTURES：4 个（TCS-SEC-01/02 各 2 个）
 *
 * 合计 26 个 fixture，覆盖 13 条 TCS 红线。
 *
 * @module eag/tcs/fixtures
 */

import type { RedlineFixture, TcsRedlineId } from "../types";
import { OSS_FIXTURES } from "./oss-fixtures";
import { CACHE_FIXTURES } from "./cache-fixtures";
import { SQL_FIXTURES } from "./sql-fixtures";
import { LDAP_FIXTURES } from "./ldap-fixtures";
import { SECURITY_FIXTURES } from "./security-fixtures";

// ============================================================================
// 全量 fixtures 聚合
// ============================================================================

/**
 * TCS 全部 fixtures（26 个，13 条红线各 2 个）
 *
 * 使用 Object.freeze 冻结，防止运行期被修改。
 * 顺序对齐 §5.8.1~§5.8.5（OSS → CACHE → SQL → LDAP → SECURITY）。
 */
export const TCS_FIXTURES: ReadonlyArray<RedlineFixture> = Object.freeze([
  ...OSS_FIXTURES,
  ...CACHE_FIXTURES,
  ...SQL_FIXTURES,
  ...LDAP_FIXTURES,
  ...SECURITY_FIXTURES,
]);

// ============================================================================
// 分类 fixtures 导出
// ============================================================================

export { OSS_FIXTURES } from "./oss-fixtures";
export { CACHE_FIXTURES } from "./cache-fixtures";
export { SQL_FIXTURES } from "./sql-fixtures";
export { LDAP_FIXTURES } from "./ldap-fixtures";
export { SECURITY_FIXTURES } from "./security-fixtures";

// ============================================================================
// 查询辅助函数
// ============================================================================

/**
 * 按红线 ID 过滤 fixtures
 *
 * @param redlineId 红线 ID
 * @returns 该红线的全部 fixtures（通常 2 个：1 violation + 1 compliant）
 */
export function getFixturesByRedlineId(redlineId: TcsRedlineId): ReadonlyArray<RedlineFixture> {
  return Object.freeze(TCS_FIXTURES.filter((f) => f.redlineId === redlineId));
}

/**
 * 按 fixture 类型过滤（violation / compliant）
 *
 * @param kind fixture 类型
 * @returns 该类型的全部 fixtures
 */
export function getFixturesByKind(kind: "violation" | "compliant"): ReadonlyArray<RedlineFixture> {
  return Object.freeze(TCS_FIXTURES.filter((f) => f.kind === kind));
}

/**
 * 获取全部 fixture 数量（应为 26）
 *
 * @returns fixture 总数
 */
export function getTcsFixtureCount(): number {
  return TCS_FIXTURES.length;
}

/**
 * 校验 fixtures 完整性
 *
 * 校验规则：
 * - 总数为 26（13 条红线 × 2 个 fixture）
 * - 每条红线恰好 1 个 violation + 1 个 compliant
 * - 所有 fixture 的 redlineId 都是合法的 TcsRedlineId
 *
 * @returns 校验通过返回 null，校验失败返回错误信息列表
 */
export function validateTcsFixtures(): ReadonlyArray<string> | null {
  const errors: string[] = [];

  // 校验总数
  if (TCS_FIXTURES.length !== 26) {
    errors.push(`fixture 总数应为 26，实际为 ${TCS_FIXTURES.length}`);
  }

  // 校验每条红线恰好 1 violation + 1 compliant
  const redlineIds: ReadonlyArray<TcsRedlineId> = [
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
  ];
  for (const rid of redlineIds) {
    const fixtures = TCS_FIXTURES.filter((f) => f.redlineId === rid);
    if (fixtures.length !== 2) {
      errors.push(`红线 ${rid} 应有 2 个 fixture，实际为 ${fixtures.length}`);
      continue;
    }
    const violations = fixtures.filter((f) => f.kind === "violation");
    const compliants = fixtures.filter((f) => f.kind === "compliant");
    if (violations.length !== 1) {
      errors.push(`红线 ${rid} 应有 1 个 violation fixture，实际为 ${violations.length}`);
    }
    if (compliants.length !== 1) {
      errors.push(`红线 ${rid} 应有 1 个 compliant fixture，实际为 ${compliants.length}`);
    }
  }

  // 校验 violation fixture 的 expectedVerdict 必须为 violated
  for (const f of TCS_FIXTURES) {
    if (f.kind === "violation" && f.expectedVerdict !== "violated") {
      errors.push(
        `fixture (${f.redlineId}/${f.kind}) 的 expectedVerdict 应为 'violated'，实际为 '${f.expectedVerdict}'`
      );
    }
    if (f.kind === "compliant" && f.expectedVerdict !== "passed") {
      errors.push(`fixture (${f.redlineId}/${f.kind}) 的 expectedVerdict 应为 'passed'，实际为 '${f.expectedVerdict}'`);
    }
    if (f.kind === "violation" && f.expectedViolations.length === 0) {
      errors.push(`fixture (${f.redlineId}/${f.kind}) 是 violation 但 expectedViolations 为空`);
    }
    if (f.kind === "compliant" && f.expectedViolations.length > 0) {
      errors.push(
        `fixture (${f.redlineId}/${f.kind}) 是 compliant 但 expectedViolations 非空（${f.expectedViolations.length} 条）`
      );
    }
  }

  return errors.length > 0 ? Object.freeze(errors) : null;
}
