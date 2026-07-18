/**
 * EAG-P2 批次 7 单元测试：TCS 红线清单（tcs-redlines.ts）
 *
 * 测试范围：
 * - R1. TCS_REDLINES 清单完整性（13 条红线，Object.freeze 冻结）
 * - R2. 红线 ID 与级别对应关系（blocker / major / warning 数量）
 * - R3. 红线字段完整性（id / name / description / severity / checkMethod / checkType / fixGuidance）
 * - R4. 红线 ID 唯一性（13 条 ID 互不重复）
 * - R5. 红线分类覆盖（5 个分类各覆盖对应数量红线）
 * - R6. getTcsRedlineCount 总数查询
 * - R7. getTcsRedlinesBySeverity 按级别过滤
 * - R8. getTcsRedlineById 按 ID 查找（命中 / 未命中）
 * - R9. getTcsRedlinesByCategory 按分类过滤
 * - R10. isValidTcsRedlineId / isValidTcsRedlineCategory 合法性校验
 * - R11. getTcsRedlineStats 统计信息（total / blocker / major / warning / byCategory）
 * - R12. 不可变性（运行期修改 TCS_REDLINES 抛错）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，直接调用真实红线清单
 *
 * 设计依据：
 * - EAG 方案 §5.8.1~§5.8.5 红线清单
 * - eag/tcs/tcs-redlines.ts 源文件（被测对象）
 *
 * @module core/tests/eag-tcs-redlines
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RedlineDefinition } from "../eag/evaluator/types";
import {
  TCS_REDLINES,
  getTcsRedlineCount,
  getTcsRedlinesBySeverity,
  getTcsRedlineById,
  getTcsRedlinesByCategory,
  isValidTcsRedlineId,
  isValidTcsRedlineCategory,
  getTcsRedlineStats,
  type TcsRedlineStats,
} from "../eag/tcs/tcs-redlines";
import type { TcsRedlineId, TcsRedlineCategory } from "../eag/tcs/types";

// ============================================================================
// R1. TCS_REDLINES 清单完整性
// ============================================================================

test("R1a. TCS_REDLINES 包含 13 条红线", () => {
  assert.equal(TCS_REDLINES.length, 13);
  assert.equal(getTcsRedlineCount(), 13);
});

test("R1b. TCS_REDLINES 已 Object.freeze 冻结", () => {
  assert.ok(Object.isFrozen(TCS_REDLINES));
  // 尝试 push 应抛错
  assert.throws(() => {
    (TCS_REDLINES as RedlineDefinition[]).push({
      id: "TCS-FAKE-99",
      name: "fake",
      description: "fake",
      severity: "warning",
      checkMethod: "fake",
      checkType: "static",
      fixGuidance: "fake",
    });
  }, TypeError);
});

// ============================================================================
// R2. 红线级别数量
// ============================================================================

test("R2. 红线级别数量正确（blocker=7 / major=6 / warning=0）", () => {
  const blockers = getTcsRedlinesBySeverity("blocker");
  const majors = getTcsRedlinesBySeverity("major");
  const warnings = getTcsRedlinesBySeverity("warning");
  // 预期：blocker 7 条（OSS-01/03, CACHE-02, SQL-01, LDAP-02, SEC-01/02）
  assert.equal(blockers.length, 7);
  // 预期：major 6 条（OSS-02, CACHE-01/03, SQL-02/03, LDAP-01）
  assert.equal(majors.length, 6);
  // 预期：warning 0 条（TCS 红线仅 blocker / major 两级）
  assert.equal(warnings.length, 0);
  // 总数校验
  assert.equal(blockers.length + majors.length + warnings.length, 13);
});

// ============================================================================
// R3. 红线字段完整性
// ============================================================================

test("R3. 每条红线字段完整（id/name/description/severity/checkMethod/checkType/fixGuidance）", () => {
  for (const r of TCS_REDLINES) {
    assert.ok(r.id, `红线 ${r.id} 应有 id`);
    assert.ok(r.name, `红线 ${r.id} 应有 name`);
    assert.ok(r.description, `红线 ${r.id} 应有 description`);
    assert.ok(r.severity, `红线 ${r.id} 应有 severity`);
    assert.ok(r.checkMethod, `红线 ${r.id} 应有 checkMethod`);
    assert.ok(r.checkType, `红线 ${r.id} 应有 checkType`);
    assert.ok(r.fixGuidance, `红线 ${r.id} 应有 fixGuidance`);
    // severity 必须为合法值
    assert.ok(
      r.severity === "blocker" || r.severity === "major" || r.severity === "warning",
      `红线 ${r.id} 的 severity=${r.severity} 必须为 blocker/major/warning`
    );
    // checkType 必须为 static 或 reasoning
    assert.ok(
      r.checkType === "static" || r.checkType === "reasoning",
      `红线 ${r.id} 的 checkType=${r.checkType} 必须为 static/reasoning`
    );
  }
});

// ============================================================================
// R4. 红线 ID 唯一性
// ============================================================================

test("R4. 13 条红线 ID 互不重复", () => {
  const ids = TCS_REDLINES.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, 13);
  assert.equal(uniqueIds.size, 13);
});

// ============================================================================
// R5. 红线分类覆盖
// ============================================================================

test("R5a. 5 个分类各覆盖对应数量红线（oss=3/cache=3/sql=3/ldap=2/security=2）", () => {
  const oss = getTcsRedlinesByCategory("oss");
  const cache = getTcsRedlinesByCategory("cache");
  const sql = getTcsRedlinesByCategory("sql");
  const ldap = getTcsRedlinesByCategory("ldap");
  const security = getTcsRedlinesByCategory("security");
  assert.equal(oss.length, 3);
  assert.equal(cache.length, 3);
  assert.equal(sql.length, 3);
  assert.equal(ldap.length, 2);
  assert.equal(security.length, 2);
  assert.equal(oss.length + cache.length + sql.length + ldap.length + security.length, 13);
});

test("R5b. 每个分类的红线 ID 都以正确前缀开头", () => {
  for (const r of getTcsRedlinesByCategory("oss")) {
    assert.ok(r.id.startsWith("TCS-OSS-"), `分类 oss 的红线 ${r.id} 应以 TCS-OSS- 开头`);
  }
  for (const r of getTcsRedlinesByCategory("cache")) {
    assert.ok(r.id.startsWith("TCS-CACHE-"), `分类 cache 的红线 ${r.id} 应以 TCS-CACHE- 开头`);
  }
  for (const r of getTcsRedlinesByCategory("sql")) {
    assert.ok(r.id.startsWith("TCS-SQL-"), `分类 sql 的红线 ${r.id} 应以 TCS-SQL- 开头`);
  }
  for (const r of getTcsRedlinesByCategory("ldap")) {
    assert.ok(r.id.startsWith("TCS-LDAP-"), `分类 ldap 的红线 ${r.id} 应以 TCS-LDAP- 开头`);
  }
  for (const r of getTcsRedlinesByCategory("security")) {
    assert.ok(r.id.startsWith("TCS-SEC-"), `分类 security 的红线 ${r.id} 应以 TCS-SEC- 开头`);
  }
});

// ============================================================================
// R6. getTcsRedlineCount 总数查询
// ============================================================================

test("R6. getTcsRedlineCount 返回 13", () => {
  assert.equal(getTcsRedlineCount(), 13);
});

// ============================================================================
// R7. getTcsRedlinesBySeverity 按级别过滤
// ============================================================================

test("R7. getTcsRedlinesBySeverity 返回的列表均为指定级别且已冻结", () => {
  const blockers = getTcsRedlinesBySeverity("blocker");
  for (const r of blockers) {
    assert.equal(r.severity, "blocker");
  }
  assert.ok(Object.isFrozen(blockers));
});

// ============================================================================
// R8. getTcsRedlineById 按 ID 查找
// ============================================================================

test("R8a. getTcsRedlineById 命中存在的红线", () => {
  const r = getTcsRedlineById("TCS-OSS-01");
  assert.ok(r !== null);
  assert.equal(r.id, "TCS-OSS-01");
  assert.equal(r.name, "业务代码直连具体厂商 SDK");
  assert.equal(r.severity, "blocker");
});

test("R8b. getTcsRedlineById 未命中返回 null", () => {
  // 使用类型断言绕过编译期检查（运行时校验）
  const r = getTcsRedlineById("TCS-FAKE-99" as TcsRedlineId);
  assert.equal(r, null);
});

test("R8c. getTcsRedlineById 命中全部 13 条红线", () => {
  const allIds: ReadonlyArray<TcsRedlineId> = [
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
  for (const id of allIds) {
    const r = getTcsRedlineById(id);
    assert.ok(r !== null, `红线 ${id} 应能被查找到`);
    assert.equal(r.id, id);
  }
});

// ============================================================================
// R9. getTcsRedlinesByCategory 按分类过滤
// ============================================================================

test("R9. getTcsRedlinesByCategory 返回的列表已冻结", () => {
  const oss = getTcsRedlinesByCategory("oss");
  assert.ok(Object.isFrozen(oss));
});

// ============================================================================
// R10. isValidTcsRedlineId / isValidTcsRedlineCategory
// ============================================================================

test("R10a. isValidTcsRedlineId 合法 ID 返回 true", () => {
  assert.ok(isValidTcsRedlineId("TCS-OSS-01"));
  assert.ok(isValidTcsRedlineId("TCS-CACHE-02"));
  assert.ok(isValidTcsRedlineId("TCS-SEC-02"));
});

test("R10b. isValidTcsRedlineId 非法 ID 返回 false", () => {
  assert.equal(isValidTcsRedlineId("TCS-FAKE-99"), false);
  assert.equal(isValidTcsRedlineId(""), false);
  assert.equal(isValidTcsRedlineId("tcs-oss-01"), false); // 大小写敏感
  assert.equal(isValidTcsRedlineId("TCS-OSS-1"), false); // 缺少前导 0
});

test("R10c. isValidTcsRedlineCategory 合法分类返回 true", () => {
  assert.ok(isValidTcsRedlineCategory("oss"));
  assert.ok(isValidTcsRedlineCategory("cache"));
  assert.ok(isValidTcsRedlineCategory("sql"));
  assert.ok(isValidTcsRedlineCategory("ldap"));
  assert.ok(isValidTcsRedlineCategory("security"));
});

test("R10d. isValidTcsRedlineCategory 非法分类返回 false", () => {
  assert.equal(isValidTcsRedlineCategory("OSS"), false); // 大小写敏感
  assert.equal(isValidTcsRedlineCategory("network"), false);
  assert.equal(isValidTcsRedlineCategory(""), false);
});

// ============================================================================
// R11. getTcsRedlineStats 统计信息
// ============================================================================

test("R11a. getTcsRedlineStats 返回正确的总数与级别统计", () => {
  const stats: TcsRedlineStats = getTcsRedlineStats();
  assert.equal(stats.total, 13);
  assert.equal(stats.blockerCount, 7);
  assert.equal(stats.majorCount, 6);
  assert.equal(stats.warningCount, 0);
});

test("R11b. getTcsRedlineStats 的 byCategory 字段正确", () => {
  const stats = getTcsRedlineStats();
  assert.equal(stats.byCategory.oss, 3);
  assert.equal(stats.byCategory.cache, 3);
  assert.equal(stats.byCategory.sql, 3);
  assert.equal(stats.byCategory.ldap, 2);
  assert.equal(stats.byCategory.security, 2);
  // 总和校验
  const sum =
    stats.byCategory.oss +
    stats.byCategory.cache +
    stats.byCategory.sql +
    stats.byCategory.ldap +
    stats.byCategory.security;
  assert.equal(sum, 13);
});

test("R11c. getTcsRedlineStats 返回的对象已冻结", () => {
  const stats = getTcsRedlineStats();
  assert.ok(Object.isFrozen(stats));
  assert.ok(Object.isFrozen(stats.byCategory));
});

// ============================================================================
// R12. 不可变性
// ============================================================================

test("R12. 修改 TCS_REDLINES 元素的字段应抛错（对象已冻结）", () => {
  const r = TCS_REDLINES[0];
  assert.ok(Object.isFrozen(r));
  assert.throws(() => {
    (r as RedlineDefinition).id = "TCS-FAKE-99";
  }, TypeError);
  assert.throws(() => {
    (r as RedlineDefinition).severity = "warning";
  }, TypeError);
});
