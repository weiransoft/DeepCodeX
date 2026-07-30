/**
 * EAG-P2 批次 7 单元测试：TCS 红线 fixtures 样例库
 *
 * 测试范围：
 * - F1. TCS_FIXTURES 总数为 26（13 条红线 × 2 个 fixture）
 * - F2. 每条红线恰好 1 个 violation + 1 个 compliant fixture
 * - F3. violation fixture 的 expectedVerdict 必须为 'violated'，expectedViolations 非空
 * - F4. compliant fixture 的 expectedVerdict 必须为 'passed'，expectedViolations 为空
 * - F5. fixture 字段完整性（redlineId / kind / description / code / language / expectedViolations / expectedVerdict）
 * - F6. fixture code 非空且包含可读代码片段（不少于 30 字符）
 * - F7. 分类 fixtures 数量正确（OSS=6 / CACHE=6 / SQL=6 / LDAP=4 / SECURITY=4）
 * - F8. getFixturesByRedlineId 查询函数
 * - F9. getFixturesByKind 查询函数
 * - F10. getTcsFixtureCount 总数查询
 * - F11. validateTcsFixtures 校验函数（通过返回 null）
 * - F12. 不可变性（fixture 对象已冻结）
 * - F13. 真实代码片段质量校验（code 中包含违规/合规对应的关键模式）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，直接调用真实 fixtures
 *
 * 设计依据：
 * - EAG 方案 §5.8.1~§5.8.5 红线 fixtures 样例库
 * - eag/tcs/fixtures/ 源文件（被测对象）
 *
 * @module core/tests/eag-redline-fixtures
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TCS_FIXTURES,
  OSS_FIXTURES,
  CACHE_FIXTURES,
  SQL_FIXTURES,
  LDAP_FIXTURES,
  SECURITY_FIXTURES,
  getFixturesByRedlineId,
  getFixturesByKind,
  getTcsFixtureCount,
  validateTcsFixtures,
} from "../eag/tcs/fixtures/index";
import type { TcsRedlineId } from "../eag/tcs/types";

// ============================================================================
// F1. TCS_FIXTURES 总数
// ============================================================================

test("F1. TCS_FIXTURES 总数为 26", () => {
  assert.equal(TCS_FIXTURES.length, 26);
  assert.equal(getTcsFixtureCount(), 26);
});

// ============================================================================
// F2. 每条红线恰好 1 violation + 1 compliant
// ============================================================================

test("F2. 每条红线恰好 1 个 violation + 1 个 compliant fixture", () => {
  const allRedlineIds: ReadonlyArray<TcsRedlineId> = [
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
  for (const rid of allRedlineIds) {
    const fixtures = getFixturesByRedlineId(rid);
    assert.equal(fixtures.length, 2, `红线 ${rid} 应有 2 个 fixture`);
    const violations = fixtures.filter((f) => f.kind === "violation");
    const compliants = fixtures.filter((f) => f.kind === "compliant");
    assert.equal(violations.length, 1, `红线 ${rid} 应有 1 个 violation fixture`);
    assert.equal(compliants.length, 1, `红线 ${rid} 应有 1 个 compliant fixture`);
  }
});

// ============================================================================
// F3. violation fixture 的 expectedVerdict='violated'，expectedViolations 非空
// ============================================================================

test("F3. violation fixture 的 expectedVerdict='violated' 且 expectedViolations 非空", () => {
  for (const f of TCS_FIXTURES) {
    if (f.kind === "violation") {
      assert.equal(
        f.expectedVerdict,
        "violated",
        `fixture ${f.redlineId}/${f.kind} 的 expectedVerdict 应为 'violated'`
      );
      assert.ok(f.expectedViolations.length > 0, `fixture ${f.redlineId}/${f.kind} 的 expectedViolations 应非空`);
    }
  }
});

// ============================================================================
// F4. compliant fixture 的 expectedVerdict='passed'，expectedViolations 为空
// ============================================================================

test("F4. compliant fixture 的 expectedVerdict='passed' 且 expectedViolations 为空", () => {
  for (const f of TCS_FIXTURES) {
    if (f.kind === "compliant") {
      assert.equal(f.expectedVerdict, "passed", `fixture ${f.redlineId}/${f.kind} 的 expectedVerdict 应为 'passed'`);
      assert.equal(f.expectedViolations.length, 0, `fixture ${f.redlineId}/${f.kind} 的 expectedViolations 应为空`);
    }
  }
});

// ============================================================================
// F5. fixture 字段完整性
// ============================================================================

test("F5. 每个 fixture 字段完整", () => {
  for (const f of TCS_FIXTURES) {
    assert.ok(f.redlineId, `fixture 应有 redlineId`);
    assert.ok(f.kind, `fixture ${f.redlineId} 应有 kind`);
    assert.ok(f.description, `fixture ${f.redlineId}/${f.kind} 应有 description`);
    assert.ok(f.code, `fixture ${f.redlineId}/${f.kind} 应有 code`);
    assert.ok(f.language, `fixture ${f.redlineId}/${f.kind} 应有 language`);
    assert.ok(f.expectedVerdict, `fixture ${f.redlineId}/${f.kind} 应有 expectedVerdict`);
    // kind 必须为 violation 或 compliant
    assert.ok(
      f.kind === "violation" || f.kind === "compliant",
      `fixture ${f.redlineId} 的 kind=${f.kind} 必须为 violation/compliant`
    );
    // language 必须为 typescript / java / python
    assert.ok(
      f.language === "typescript" || f.language === "java" || f.language === "python",
      `fixture ${f.redlineId} 的 language=${f.language} 必须为 typescript/java/python`
    );
    // expectedVerdict 必须为 violated 或 passed
    assert.ok(
      f.expectedVerdict === "violated" || f.expectedVerdict === "passed",
      `fixture ${f.redlineId} 的 expectedVerdict=${f.expectedVerdict} 必须为 violated/passed`
    );
  }
});

// ============================================================================
// F6. fixture code 非空且包含可读代码片段
// ============================================================================

test("F6. 每个 fixture 的 code 非空且至少 30 字符", () => {
  for (const f of TCS_FIXTURES) {
    assert.ok(f.code.length >= 30, `fixture ${f.redlineId}/${f.kind} 的 code 应至少 30 字符，实际为 ${f.code.length}`);
  }
});

// ============================================================================
// F7. 分类 fixtures 数量
// ============================================================================

test("F7a. 分类 fixtures 数量正确（OSS=6 / CACHE=6 / SQL=6 / LDAP=4 / SECURITY=4）", () => {
  assert.equal(OSS_FIXTURES.length, 6);
  assert.equal(CACHE_FIXTURES.length, 6);
  assert.equal(SQL_FIXTURES.length, 6);
  assert.equal(LDAP_FIXTURES.length, 4);
  assert.equal(SECURITY_FIXTURES.length, 4);
  assert.equal(
    OSS_FIXTURES.length + CACHE_FIXTURES.length + SQL_FIXTURES.length + LDAP_FIXTURES.length + SECURITY_FIXTURES.length,
    26
  );
});

test("F7b. 分类 fixtures 的 redlineId 与分类前缀对应", () => {
  for (const f of OSS_FIXTURES) {
    assert.ok(f.redlineId.startsWith("TCS-OSS-"), `OSS_FIXTURES 的 ${f.redlineId} 应以 TCS-OSS- 开头`);
  }
  for (const f of CACHE_FIXTURES) {
    assert.ok(f.redlineId.startsWith("TCS-CACHE-"), `CACHE_FIXTURES 的 ${f.redlineId} 应以 TCS-CACHE- 开头`);
  }
  for (const f of SQL_FIXTURES) {
    assert.ok(f.redlineId.startsWith("TCS-SQL-"), `SQL_FIXTURES 的 ${f.redlineId} 应以 TCS-SQL- 开头`);
  }
  for (const f of LDAP_FIXTURES) {
    assert.ok(f.redlineId.startsWith("TCS-LDAP-"), `LDAP_FIXTURES 的 ${f.redlineId} 应以 TCS-LDAP- 开头`);
  }
  for (const f of SECURITY_FIXTURES) {
    assert.ok(f.redlineId.startsWith("TCS-SEC-"), `SECURITY_FIXTURES 的 ${f.redlineId} 应以 TCS-SEC- 开头`);
  }
});

// ============================================================================
// F8. getFixturesByRedlineId 查询函数
// ============================================================================

test("F8a. getFixturesByRedlineId 返回该红线的全部 fixture", () => {
  const fixtures = getFixturesByRedlineId("TCS-OSS-01");
  assert.equal(fixtures.length, 2);
  for (const f of fixtures) {
    assert.equal(f.redlineId, "TCS-OSS-01");
  }
});

test("F8b. getFixturesByRedlineId 返回的列表已冻结", () => {
  const fixtures = getFixturesByRedlineId("TCS-CACHE-02");
  assert.ok(Object.isFrozen(fixtures));
});

// ============================================================================
// F9. getFixturesByKind 查询函数
// ============================================================================

test("F9. getFixturesByKind 返回正确数量的 violation / compliant fixture", () => {
  const violations = getFixturesByKind("violation");
  const compliants = getFixturesByKind("compliant");
  assert.equal(violations.length, 13); // 13 条红线 × 1 violation
  assert.equal(compliants.length, 13); // 13 条红线 × 1 compliant
  assert.equal(violations.length + compliants.length, 26);
  // 校验已冻结
  assert.ok(Object.isFrozen(violations));
  assert.ok(Object.isFrozen(compliants));
});

// ============================================================================
// F10. getTcsFixtureCount
// ============================================================================

test("F10. getTcsFixtureCount 返回 26", () => {
  assert.equal(getTcsFixtureCount(), 26);
});

// ============================================================================
// F11. validateTcsFixtures 校验函数
// ============================================================================

test("F11. validateTcsFixtures 通过校验返回 null", () => {
  const errors = validateTcsFixtures();
  assert.equal(errors, null, `fixtures 校验应通过，错误: ${errors ? errors.join("; ") : ""}`);
});

// ============================================================================
// F12. 不可变性
// ============================================================================

test("F12. TCS_FIXTURES 与每个 fixture 均已冻结", () => {
  assert.ok(Object.isFrozen(TCS_FIXTURES));
  for (const f of TCS_FIXTURES) {
    assert.ok(Object.isFrozen(f), `fixture ${f.redlineId}/${f.kind} 应已冻结`);
    assert.ok(Object.isFrozen(f.expectedViolations), `fixture ${f.redlineId}/${f.kind} 的 expectedViolations 应已冻结`);
  }
});

// ============================================================================
// F13. 真实代码片段质量校验（违规/合规对应的关键模式）
// ============================================================================

test("F13a. TCS-OSS-01 violation 代码片段包含直接 import 厂商 SDK 的模式", () => {
  const oss01Violation = TCS_FIXTURES.find((f) => f.redlineId === "TCS-OSS-01" && f.kind === "violation");
  assert.ok(oss01Violation);
  // code 中应包含 ali-oss 或 aws-sdk 或 minio 的直接 import
  assert.ok(
    /from\s+['"]ali-oss['"]/.test(oss01Violation.code) ||
      /from\s+['"]aws-sdk['"]/.test(oss01Violation.code) ||
      /from\s+['"]minio['"]/.test(oss01Violation.code),
    "TCS-OSS-01 violation code 应包含直接 import 厂商 SDK 的模式"
  );
});

test("F13b. TCS-OSS-01 compliant 代码片段仅依赖 ObjectStoragePort 抽象", () => {
  const oss01Compliant = TCS_FIXTURES.find((f) => f.redlineId === "TCS-OSS-01" && f.kind === "compliant");
  assert.ok(oss01Compliant);
  assert.ok(/ObjectStoragePort/.test(oss01Compliant.code), "TCS-OSS-01 compliant code 应包含 ObjectStoragePort 抽象");
  // 不应包含直接 import 厂商 SDK
  assert.ok(
    !/from\s+['"]ali-oss['"]/.test(oss01Compliant.code) && !/from\s+['"]aws-sdk['"]/.test(oss01Compliant.code),
    "TCS-OSS-01 compliant code 不应直接 import 厂商 SDK"
  );
});

test("F13c. TCS-CACHE-02 violation 代码片段先删缓存后更库", () => {
  const cache02Violation = TCS_FIXTURES.find((f) => f.redlineId === "TCS-CACHE-02" && f.kind === "violation");
  assert.ok(cache02Violation);
  // code 中应先出现 cache.delete，后出现 update
  const deleteIdx = cache02Violation.code.indexOf("cache.delete");
  const updateIdx = cache02Violation.code.indexOf("userRepo.update");
  assert.ok(deleteIdx >= 0, "TCS-CACHE-02 violation code 应包含 cache.delete 调用");
  assert.ok(updateIdx >= 0, "TCS-CACHE-02 violation code 应包含 userRepo.update 调用");
  assert.ok(
    deleteIdx < updateIdx,
    "TCS-CACHE-02 violation code 中 cache.delete 应在 userRepo.update 之前（先删缓存后更库）"
  );
});

test("F13d. TCS-CACHE-02 compliant 代码片段使用 doubleWrite 委托", () => {
  const cache02Compliant = TCS_FIXTURES.find((f) => f.redlineId === "TCS-CACHE-02" && f.kind === "compliant");
  assert.ok(cache02Compliant);
  assert.ok(/doubleWrite/.test(cache02Compliant.code), "TCS-CACHE-02 compliant code 应使用 doubleWrite 委托双写");
});

test("F13e. TCS-SQL-02 violation 代码片段在循环内调用 findUnique", () => {
  const sql02Violation = TCS_FIXTURES.find((f) => f.redlineId === "TCS-SQL-02" && f.kind === "violation");
  assert.ok(sql02Violation);
  assert.ok(
    /for\s*\(/.test(sql02Violation.code) && /findUnique/.test(sql02Violation.code),
    "TCS-SQL-02 violation code 应在 for 循环内调用 findUnique（N+1 模式）"
  );
});

test("F13f. TCS-SEC-02 violation 代码片段包含硬编码密钥", () => {
  const sec02Violation = TCS_FIXTURES.find((f) => f.redlineId === "TCS-SEC-02" && f.kind === "violation");
  assert.ok(sec02Violation);
  assert.ok(
    /AKIAIOSFODNN7EXAMPLE/.test(sec02Violation.code),
    "TCS-SEC-02 violation code 应包含硬编码 AWS Access Key 模式"
  );
});

test("F13g. TCS-SEC-02 compliant 代码片段使用 process.env 读取密钥", () => {
  const sec02Compliant = TCS_FIXTURES.find((f) => f.redlineId === "TCS-SEC-02" && f.kind === "compliant");
  assert.ok(sec02Compliant);
  assert.ok(
    /process\.env\.AWS_ACCESS_KEY_ID/.test(sec02Compliant.code),
    "TCS-SEC-02 compliant code 应使用 process.env.AWS_ACCESS_KEY_ID 读取密钥"
  );
  // 不应包含硬编码密钥
  assert.ok(
    !/AKIAIOSFODNN7EXAMPLE/.test(sec02Compliant.code),
    "TCS-SEC-02 compliant code 不应包含硬编码 AWS Access Key"
  );
});
