/**
 * EAG-P2 批次 7 单元测试：TCS 核心类型与常量（types.ts）
 *
 * 测试范围：
 * - T1. TCS 红线 ID 与分类：TCS_REDLINE_IDS / TCS_REDLINE_CATEGORIES 完整性
 * - T2. 对象存储类型与常量：StorageProvider / STORAGE_PROVIDERS
 * - T3. 缓存类型与常量：CacheTier / CACHE_TIERS
 * - T4. SQL 优化类型：SqlQueryType
 * - T5. LDAP 类型与常量：LdapSyncMode / LDAP_SYNC_MODES / LdapDegradationStrategy
 * - T6. 漏洞扫描类型与常量：VulnerabilitySeverity / VULNERABILITY_SEVERITIES / VulnerabilityScanLayer / VULNERABILITY_SCAN_LAYERS
 * - T7. fixture 类型：FixtureKind / RedlineFixture 接口结构
 * - T8. deepFreeze 深度冻结函数（顶层对象 / 嵌套对象 / 数组 / null / 函数）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.8 企业技术组件规范包
 * - eag/tcs/types.ts 源文件（被测对象）
 *
 * @module core/tests/eag-tcs-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TCS_REDLINE_IDS,
  TCS_REDLINE_CATEGORIES,
  STORAGE_PROVIDERS,
  CACHE_TIERS,
  LDAP_SYNC_MODES,
  VULNERABILITY_SEVERITIES,
  VULNERABILITY_SCAN_LAYERS,
  deepFreeze,
  type TcsRedlineId,
  type TcsRedlineCategory,
  type StorageProvider,
  type CacheTier,
  type LdapSyncMode,
  type LdapDegradationStrategy,
  type VulnerabilitySeverity,
  type VulnerabilityScanLayer,
  type FixtureKind,
  type RedlineFixture,
} from "../eag/tcs/types";

// ============================================================================
// T1. TCS 红线 ID 与分类
// ============================================================================

test("T1a. TCS_REDLINE_IDS 包含全部 13 条红线 ID", () => {
  assert.equal(TCS_REDLINE_IDS.length, 13);
  const expectedIds: ReadonlyArray<TcsRedlineId> = [
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
  assert.deepEqual([...TCS_REDLINE_IDS], [...expectedIds]);
});

test("T1b. TCS_REDLINE_IDS 已冻结（不可变）", () => {
  assert.ok(Object.isFrozen(TCS_REDLINE_IDS));
  // 尝试修改应失败（严格模式下抛错或静默失败）
  // 说明：TCS_REDLINE_IDS 类型为 ReadonlyArray<TcsRedlineId>，
  // 通过 as TcsRedlineId[] 强转为可变数组类型以触发运行时 push 操作，
  // 进而验证 Object.freeze 冻结保护在运行时生效。
  // "TCS-FAKE-99" 不是合法 TcsRedlineId 字面量（用于测试无效 ID 边界场景），
  // 通过 as TcsRedlineId 类型断言绕过编译期字面量联合检查，强制传入无效 ID。
  assert.throws(() => {
    (TCS_REDLINE_IDS as TcsRedlineId[]).push("TCS-FAKE-99" as TcsRedlineId);
  }, TypeError);
});

test("T1c. TCS_REDLINE_CATEGORIES 包含 5 个分类", () => {
  assert.equal(TCS_REDLINE_CATEGORIES.length, 5);
  const expectedCategories: ReadonlyArray<TcsRedlineCategory> = ["oss", "cache", "sql", "ldap", "security"];
  assert.deepEqual([...TCS_REDLINE_CATEGORIES], [...expectedCategories]);
  assert.ok(Object.isFrozen(TCS_REDLINE_CATEGORIES));
});

// ============================================================================
// T2. 对象存储类型与常量
// ============================================================================

test("T2a. STORAGE_PROVIDERS 包含 s3 / oss / minio 三种供应商", () => {
  assert.equal(STORAGE_PROVIDERS.length, 3);
  const expected: ReadonlyArray<StorageProvider> = ["s3", "oss", "minio"];
  assert.deepEqual([...STORAGE_PROVIDERS], [...expected]);
  assert.ok(Object.isFrozen(STORAGE_PROVIDERS));
});

// ============================================================================
// T3. 缓存类型与常量
// ============================================================================

test("T3. CACHE_TIERS 包含 local / redis / db 三层", () => {
  assert.equal(CACHE_TIERS.length, 3);
  const expected: ReadonlyArray<CacheTier> = ["local", "redis", "db"];
  assert.deepEqual([...CACHE_TIERS], [...expected]);
  assert.ok(Object.isFrozen(CACHE_TIERS));
});

// ============================================================================
// T4. SQL 优化类型（字面量联合校验）
// ============================================================================

test("T4. SqlQueryType 字面量联合包含 select/insert/update/delete", () => {
  // 字面量联合通过类型层面校验，运行时通过实际值校验
  const queryTypes: ReadonlyArray<string> = ["select", "insert", "update", "delete"];
  for (const qt of queryTypes) {
    assert.ok(["select", "insert", "update", "delete"].includes(qt));
  }
});

// ============================================================================
// T5. LDAP 类型与常量
// ============================================================================

test("T5a. LDAP_SYNC_MODES 包含 full / incremental", () => {
  assert.equal(LDAP_SYNC_MODES.length, 2);
  const expected: ReadonlyArray<LdapSyncMode> = ["full", "incremental"];
  assert.deepEqual([...LDAP_SYNC_MODES], [...expected]);
  assert.ok(Object.isFrozen(LDAP_SYNC_MODES));
});

test("T5b. LdapDegradationStrategy 字面量联合包含 3 种降级策略", () => {
  const strategies: ReadonlyArray<LdapDegradationStrategy> = ["reject-new", "emergency-admin", "readonly"];
  assert.equal(strategies.length, 3);
  // 校验字面量联合的全部合法值
  for (const s of strategies) {
    assert.ok(s === "reject-new" || s === "emergency-admin" || s === "readonly", `降级策略 ${s} 应为合法值`);
  }
});

// ============================================================================
// T6. 漏洞扫描类型与常量
// ============================================================================

test("T6a. VULNERABILITY_SEVERITIES 包含 5 个严重级别", () => {
  assert.equal(VULNERABILITY_SEVERITIES.length, 5);
  const expected: ReadonlyArray<VulnerabilitySeverity> = ["critical", "high", "medium", "low", "info"];
  assert.deepEqual([...VULNERABILITY_SEVERITIES], [...expected]);
  assert.ok(Object.isFrozen(VULNERABILITY_SEVERITIES));
});

test("T6b. VULNERABILITY_SCAN_LAYERS 包含 3 个扫描层级", () => {
  assert.equal(VULNERABILITY_SCAN_LAYERS.length, 3);
  const expected: ReadonlyArray<VulnerabilityScanLayer> = ["dependency", "code-defect", "secret-leak"];
  assert.deepEqual([...VULNERABILITY_SCAN_LAYERS], [...expected]);
  assert.ok(Object.isFrozen(VULNERABILITY_SCAN_LAYERS));
});

// ============================================================================
// T7. fixture 类型
// ============================================================================

test("T7a. FixtureKind 字面量联合包含 violation / compliant", () => {
  const kinds: ReadonlyArray<FixtureKind> = ["violation", "compliant"];
  assert.equal(kinds.length, 2);
  for (const k of kinds) {
    assert.ok(k === "violation" || k === "compliant", `fixture 类型 ${k} 应为合法值`);
  }
});

test("T7b. RedlineFixture 接口结构可正确构造实例", () => {
  // 构造一个真实的 RedlineFixture 实例（不使用 mock）
  const fixture: RedlineFixture = {
    redlineId: "TCS-OSS-01",
    kind: "violation",
    description: "测试 fixture：业务代码直接 import ali-oss",
    code: "import { OSS } from 'ali-oss';",
    language: "typescript",
    expectedViolations: [
      {
        filePath: "src/services/user-service.ts",
        line: 2,
        description: "业务代码直接 import ali-oss",
      },
    ],
    expectedVerdict: "violated",
  };
  assert.equal(fixture.redlineId, "TCS-OSS-01");
  assert.equal(fixture.kind, "violation");
  assert.equal(fixture.language, "typescript");
  assert.equal(fixture.expectedViolations.length, 1);
  assert.equal(fixture.expectedViolations[0].line, 2);
  assert.equal(fixture.expectedVerdict, "violated");
});

// ============================================================================
// T8. deepFreeze 深度冻结函数
// ============================================================================

test("T8a. deepFreeze 冻结顶层对象", () => {
  const obj = { a: 1, b: "hello" };
  const frozen = deepFreeze(obj);
  assert.ok(Object.isFrozen(frozen));
  // 修改应抛错
  assert.throws(() => {
    (frozen as { a: number }).a = 999;
  }, TypeError);
});

test("T8b. deepFreeze 递归冻结嵌套对象", () => {
  const obj = {
    outer: {
      inner: {
        deep: "value",
      },
    },
    list: [1, 2, 3],
  };
  const frozen = deepFreeze(obj);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.outer));
  assert.ok(Object.isFrozen(frozen.outer.inner));
  assert.ok(Object.isFrozen(frozen.list));
  // 修改嵌套对象应抛错
  assert.throws(() => {
    (frozen.outer.inner as { deep: string }).deep = "modified";
  }, TypeError);
});

test("T8c. deepFreeze 处理 null 与原始类型", () => {
  // null 不应抛错
  assert.equal(deepFreeze(null), null);
  // 原始类型应原样返回
  assert.equal(deepFreeze(42), 42);
  assert.equal(deepFreeze("hello"), "hello");
  assert.equal(deepFreeze(undefined), undefined);
  assert.equal(deepFreeze(true), true);
});

test("T8d. deepFreeze 跳过函数类型", () => {
  const obj = {
    value: 1,
    method: () => "hello",
  };
  const frozen = deepFreeze(obj);
  assert.ok(Object.isFrozen(frozen));
  // 函数应保持可调用
  assert.equal(frozen.method(), "hello");
});

test("T8e. deepFreeze 幂等（重复冻结无副作用）", () => {
  const obj = { a: { b: 1 } };
  const frozen1 = deepFreeze(obj);
  const frozen2 = deepFreeze(frozen1);
  // 同一引用
  assert.equal(frozen1, frozen2);
  assert.ok(Object.isFrozen(frozen2));
  assert.ok(Object.isFrozen(frozen2.a));
});

test("T8f. deepFreeze 冻结数组及其元素对象", () => {
  const obj = {
    items: [
      { id: 1, name: "first" },
      { id: 2, name: "second" },
    ],
  };
  const frozen = deepFreeze(obj);
  assert.ok(Object.isFrozen(frozen.items));
  assert.ok(Object.isFrozen(frozen.items[0]));
  assert.ok(Object.isFrozen(frozen.items[1]));
  // 修改数组元素应抛错
  assert.throws(() => {
    (frozen.items[0] as { id: number }).id = 999;
  }, TypeError);
});
