/**
 * EAG-P1 批次 6 单元测试：RLIS 类型定义完整性（EAG 方案 §5.5.1）
 *
 * 测试范围：
 * - T1.  RuleCategory 字面量联合类型完整性（6 个分类）
 * - T2.  RULE_CATEGORIES 常量完整性与冻结
 * - T3.  RuleSeverity 字面量联合类型完整性（3 个级别，大写）
 * - T4.  RULE_SEVERITIES 常量完整性与冻结
 * - T5.  RuleSource 字面量联合类型完整性（3 个来源）
 * - T6.  RULE_SOURCES 常量完整性与冻结
 * - T7.  RuleConfirmedBy 字面量联合类型完整性（2 个确认来源）
 * - T8.  RULE_CONFIRMED_BY 常量完整性与冻结
 * - T9.  UserRule 接口字段完整性（9 个字段）
 * - T10. RuleCandidate 接口字段完整性（8 个字段）
 * - T11. RuleStoreLayer 字面量联合类型完整性（3 个层）
 * - T12. RULE_STORE_LAYERS 常量完整性与冻结
 * - T13. RuleStoreSnapshot 接口字段完整性（4 个字段）
 * - T14. RuleInjectionConfig 接口字段完整性（2 个字段）
 * - T15. SEVERITY_PRIORITY 映射正确性与冻结
 * - T16. compareSeverity 函数排序行为
 * - T17. 不可变性验证（Object.freeze 后不可变）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实类型与常量
 * - 类型层面验证通过构造真实对象 + 字段访问实现
 *
 * 设计依据：
 * - EAG 方案 §5.5.1 规则模型
 * - EAG 方案 §5.5.2 三层规则存储
 * - EAG 方案 §5.5.3 规则注入配置
 * - eag/rlis/types.ts 类型定义文件
 *
 * @module core/tests/eag-rlis-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULE_CATEGORIES,
  RULE_SEVERITIES,
  RULE_SOURCES,
  RULE_CONFIRMED_BY,
  RULE_STORE_LAYERS,
  SEVERITY_PRIORITY,
  compareSeverity,
} from "../eag/rlis/types";
import type {
  RuleCategory,
  RuleSeverity,
  RuleSource,
  RuleConfirmedBy,
  UserRule,
  RuleCandidate,
  RuleStoreLayer,
  RuleStoreSnapshot,
  RuleInjectionConfig,
} from "../eag/rlis/types";

// ============================================================================
// T1. RuleCategory 字面量联合类型完整性
// ============================================================================

test("T1a. RULE_CATEGORIES 包含全部 6 个分类", () => {
  assert.equal(RULE_CATEGORIES.length, 6);
  assert.ok(RULE_CATEGORIES.includes("code-truth"));
  assert.ok(RULE_CATEGORIES.includes("comment-style"));
  assert.ok(RULE_CATEGORIES.includes("process-gate"));
  assert.ok(RULE_CATEGORIES.includes("change-control"));
  assert.ok(RULE_CATEGORIES.includes("project-structure"));
  assert.ok(RULE_CATEGORIES.includes("quality-gate"));
});

test("T1b. RULE_CATEGORIES 顺序符合规范", () => {
  // 顺序对齐 §5.5.3 注入时的分组排序（按定义顺序输出）
  assert.equal(RULE_CATEGORIES[0], "code-truth");
  assert.equal(RULE_CATEGORIES[1], "comment-style");
  assert.equal(RULE_CATEGORIES[2], "process-gate");
  assert.equal(RULE_CATEGORIES[3], "change-control");
  assert.equal(RULE_CATEGORIES[4], "project-structure");
  assert.equal(RULE_CATEGORIES[5], "quality-gate");
});

test("T1c. RULE_CATEGORIES 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(RULE_CATEGORIES), true);
});

test("T1d. RuleCategory 类型可正确赋值 6 个字面量", () => {
  // 通过赋值验证字面量联合类型合法
  const categories: RuleCategory[] = [
    "code-truth",
    "comment-style",
    "process-gate",
    "change-control",
    "project-structure",
    "quality-gate",
  ];
  assert.equal(categories.length, 6);
});

// ============================================================================
// T2. RuleSeverity 字面量联合类型完整性（大写）
// ============================================================================

test("T2a. RULE_SEVERITIES 包含全部 3 个级别（大写）", () => {
  assert.equal(RULE_SEVERITIES.length, 3);
  assert.ok(RULE_SEVERITIES.includes("BLOCKER"));
  assert.ok(RULE_SEVERITIES.includes("MAJOR"));
  assert.ok(RULE_SEVERITIES.includes("WARNING"));
});

test("T2b. RULE_SEVERITIES 顺序：BLOCKER → MAJOR → WARNING", () => {
  // 顺序对齐 §5.5.3 severity 排序依据（BLOCKER 优先 → MAJOR → WARNING）
  assert.equal(RULE_SEVERITIES[0], "BLOCKER");
  assert.equal(RULE_SEVERITIES[1], "MAJOR");
  assert.equal(RULE_SEVERITIES[2], "WARNING");
});

test("T2c. RULE_SEVERITIES 已冻结", () => {
  assert.equal(Object.isFrozen(RULE_SEVERITIES), true);
});

test("T2d. RuleSeverity 类型可正确赋值 3 个大写字面量", () => {
  const severities: RuleSeverity[] = ["BLOCKER", "MAJOR", "WARNING"];
  assert.equal(severities.length, 3);
});

test("T2e. RuleSeverity 必须为大写（小写形式不应被赋值）", () => {
  // 通过类型系统保证：小写形式不是合法的 RuleSeverity 字面量
  // 此测试通过运行时检查再次验证 RULE_SEVERITIES 中无小写值
  for (const sev of RULE_SEVERITIES) {
    assert.equal(sev, sev.toUpperCase(), `severity "${sev}" 应为大写`);
  }
});

// ============================================================================
// T3. RuleSource 字面量联合类型完整性
// ============================================================================

test("T3a. RULE_SOURCES 包含全部 3 个来源", () => {
  assert.equal(RULE_SOURCES.length, 3);
  assert.ok(RULE_SOURCES.includes("builtin-seed"));
  assert.ok(RULE_SOURCES.includes("user-explicit"));
  assert.ok(RULE_SOURCES.includes("learned"));
});

test("T3b. RULE_SOURCES 已冻结", () => {
  assert.equal(Object.isFrozen(RULE_SOURCES), true);
});

test("T3c. RuleSource 类型可正确赋值 3 个字面量", () => {
  const sources: RuleSource[] = ["builtin-seed", "user-explicit", "learned"];
  assert.equal(sources.length, 3);
});

// ============================================================================
// T4. RuleConfirmedBy 字面量联合类型完整性
// ============================================================================

test("T4a. RULE_CONFIRMED_BY 包含全部 2 个确认来源", () => {
  assert.equal(RULE_CONFIRMED_BY.length, 2);
  assert.ok(RULE_CONFIRMED_BY.includes("user"));
  assert.ok(RULE_CONFIRMED_BY.includes("auto"));
});

test("T4b. RULE_CONFIRMED_BY 已冻结", () => {
  assert.equal(Object.isFrozen(RULE_CONFIRMED_BY), true);
});

test("T4c. RuleConfirmedBy 类型可正确赋值 2 个字面量", () => {
  const confirmedBy: RuleConfirmedBy[] = ["user", "auto"];
  assert.equal(confirmedBy.length, 2);
});

// ============================================================================
// T5. UserRule 接口字段完整性
// ============================================================================

test("T5. UserRule 接口 9 个字段全部可正确赋值", () => {
  // 构造真实 UserRule 对象验证字段可赋值
  const rule: UserRule = {
    id: "SEED-01",
    category: "code-truth",
    severity: "BLOCKER",
    content: "禁止使用 mock 开发",
    source: "builtin-seed",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
  // 验证全部字段可访问且值正确
  assert.equal(rule.id, "SEED-01");
  assert.equal(rule.category, "code-truth");
  assert.equal(rule.severity, "BLOCKER");
  assert.equal(rule.content, "禁止使用 mock 开发");
  assert.equal(rule.source, "builtin-seed");
  assert.equal(rule.confirmedBy, "auto");
  assert.equal(rule.usageCount, 0);
  assert.equal(rule.violationCount, 0);
  assert.equal(rule.createdAt, "2026-07-18T00:00:00.000Z");
});

// ============================================================================
// T6. RuleCandidate 接口字段完整性
// ============================================================================

test("T6. RuleCandidate 接口 8 个字段全部可正确赋值", () => {
  const candidate: RuleCandidate = {
    id: "LEARN-01",
    category: "code-truth",
    severity: "BLOCKER",
    content: "不要使用 mock 开发",
    detectedPattern: "不要...",
    occurrenceCount: 2,
    firstDetectedAt: "2026-07-18T00:00:00.000Z",
    lastDetectedAt: "2026-07-18T01:00:00.000Z",
  };
  assert.equal(candidate.id, "LEARN-01");
  assert.equal(candidate.category, "code-truth");
  assert.equal(candidate.severity, "BLOCKER");
  assert.equal(candidate.content, "不要使用 mock 开发");
  assert.equal(candidate.detectedPattern, "不要...");
  assert.equal(candidate.occurrenceCount, 2);
  assert.equal(candidate.firstDetectedAt, "2026-07-18T00:00:00.000Z");
  assert.equal(candidate.lastDetectedAt, "2026-07-18T01:00:00.000Z");
});

// ============================================================================
// T7. RuleStoreLayer 字面量联合类型完整性
// ============================================================================

test("T7a. RULE_STORE_LAYERS 包含全部 3 个层", () => {
  assert.equal(RULE_STORE_LAYERS.length, 3);
  assert.ok(RULE_STORE_LAYERS.includes("seed"));
  assert.ok(RULE_STORE_LAYERS.includes("global"));
  assert.ok(RULE_STORE_LAYERS.includes("project"));
});

test("T7b. RULE_STORE_LAYERS 顺序：seed → global → project", () => {
  // 顺序同时作为合并优先级（project > global > seed，但定义顺序为低到高）
  assert.equal(RULE_STORE_LAYERS[0], "seed");
  assert.equal(RULE_STORE_LAYERS[1], "global");
  assert.equal(RULE_STORE_LAYERS[2], "project");
});

test("T7c. RULE_STORE_LAYERS 已冻结", () => {
  assert.equal(Object.isFrozen(RULE_STORE_LAYERS), true);
});

test("T7d. RuleStoreLayer 类型可正确赋值 3 个字面量", () => {
  const layers: RuleStoreLayer[] = ["seed", "global", "project"];
  assert.equal(layers.length, 3);
});

// ============================================================================
// T8. RuleStoreSnapshot 接口字段完整性
// ============================================================================

test("T8. RuleStoreSnapshot 接口 4 个字段全部可正确赋值", () => {
  const emptyRules: ReadonlyArray<UserRule> = [];
  const snapshot: RuleStoreSnapshot = {
    seedRules: emptyRules,
    globalRules: emptyRules,
    projectRules: emptyRules,
    effectiveRules: emptyRules,
  };
  assert.equal(snapshot.seedRules.length, 0);
  assert.equal(snapshot.globalRules.length, 0);
  assert.equal(snapshot.projectRules.length, 0);
  assert.equal(snapshot.effectiveRules.length, 0);
});

// ============================================================================
// T9. RuleInjectionConfig 接口字段完整性
// ============================================================================

test("T9a. RuleInjectionConfig 接口字段可正确赋值（truncateBySeverity=true）", () => {
  const config: RuleInjectionConfig = {
    maxTokenBudget: 1000,
    truncateBySeverity: true,
  };
  assert.equal(config.maxTokenBudget, 1000);
  assert.equal(config.truncateBySeverity, true);
});

test("T9b. RuleInjectionConfig 接口字段可正确赋值（maxTokenBudget 可选）", () => {
  const config: RuleInjectionConfig = {
    truncateBySeverity: false,
  };
  assert.equal(config.maxTokenBudget, undefined);
  assert.equal(config.truncateBySeverity, false);
});

// ============================================================================
// T10. SEVERITY_PRIORITY 映射正确性与冻结
// ============================================================================

test("T10a. SEVERITY_PRIORITY 映射正确（BLOCKER=3, MAJOR=2, WARNING=1）", () => {
  assert.equal(SEVERITY_PRIORITY.BLOCKER, 3);
  assert.equal(SEVERITY_PRIORITY.MAJOR, 2);
  assert.equal(SEVERITY_PRIORITY.WARNING, 1);
});

test("T10b. SEVERITY_PRIORITY 已冻结", () => {
  assert.equal(Object.isFrozen(SEVERITY_PRIORITY), true);
});

test("T10c. SEVERITY_PRIORITY 数值越大优先级越高（BLOCKER 最高）", () => {
  assert.ok(SEVERITY_PRIORITY.BLOCKER > SEVERITY_PRIORITY.MAJOR);
  assert.ok(SEVERITY_PRIORITY.MAJOR > SEVERITY_PRIORITY.WARNING);
});

// ============================================================================
// T11. compareSeverity 函数排序行为
// ============================================================================

test("T11a. compareSeverity(BLOCKER, MAJOR) 返回负数（BLOCKER 优先）", () => {
  const result = compareSeverity("BLOCKER", "MAJOR");
  assert.ok(result < 0, `期望负数，实际 ${result}`);
});

test("T11b. compareSeverity(MAJOR, BLOCKER) 返回正数（MAJOR 次之）", () => {
  const result = compareSeverity("MAJOR", "BLOCKER");
  assert.ok(result > 0, `期望正数，实际 ${result}`);
});

test("T11c. compareSeverity(BLOCKER, BLOCKER) 返回 0（同级）", () => {
  assert.equal(compareSeverity("BLOCKER", "BLOCKER"), 0);
});

test("T11d. compareSeverity(WARNING, BLOCKER) 返回正数（WARNING 最后）", () => {
  const result = compareSeverity("WARNING", "BLOCKER");
  assert.ok(result > 0, `期望正数，实际 ${result}`);
});

test("T11e. compareSeverity 用于数组排序（BLOCKER → MAJOR → WARNING）", () => {
  const severities: RuleSeverity[] = ["WARNING", "MAJOR", "BLOCKER"];
  const sorted = [...severities].sort(compareSeverity);
  assert.deepEqual(sorted, ["BLOCKER", "MAJOR", "WARNING"]);
});

// ============================================================================
// T12. 不可变性验证（Object.freeze 后运行期不可变）
// ============================================================================

test("T12a. RULE_CATEGORIES push 操作在严格模式下抛 TypeError", () => {
  assert.throws(() => {
    // 类型断言绕过 readonly 检查，验证运行期冻结
    (RULE_CATEGORIES as RuleCategory[]).push("extra" as RuleCategory);
  }, TypeError);
});

test("T12b. RULE_SEVERITIES push 操作在严格模式下抛 TypeError", () => {
  assert.throws(() => {
    (RULE_SEVERITIES as RuleSeverity[]).push("INFO" as RuleSeverity);
  }, TypeError);
});

test("T12c. SEVERITY_PRIORITY 赋值操作在严格模式下抛 TypeError", () => {
  assert.throws(() => {
    // 类型断言绕过 readonly 检查，验证运行期冻结
    (SEVERITY_PRIORITY as Record<string, number>)["INFO"] = 0;
  }, TypeError);
});

test("T12d. RULE_SOURCES push 操作在严格模式下抛 TypeError", () => {
  assert.throws(() => {
    (RULE_SOURCES as RuleSource[]).push("extra" as RuleSource);
  }, TypeError);
});
