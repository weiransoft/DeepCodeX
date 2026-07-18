/**
 * EAG-P1 批次 6 单元测试：RLIS 内置种子规则完整性（EAG 方案 §5.5.5）
 *
 * 测试范围：
 * - T1.  SEED_RULES 常量数量完整（10 条）
 * - T2.  SEED_RULES 已冻结（Object.isFrozen）
 * - T3.  SEED-01 ~ SEED-10 ID 唯一性与完整性
 * - T4.  SEED-01: code-truth / BLOCKER（禁 mock/占位/简化）
 * - T5.  SEED-02: comment-style / MAJOR（注释规范）
 * - T6.  SEED-03: code-truth / BLOCKER（禁逃避式删除）
 * - T7.  SEED-04: code-truth / MAJOR（TODO 必须有实现）
 * - T8.  SEED-05: process-gate / MAJOR（架构师审查）
 * - T9.  SEED-06: change-control / BLOCKER（禁改技术栈）
 * - T10. SEED-07: code-truth / MAJOR（FIXME 必须有修改）
 * - T11. SEED-08: project-structure / MAJOR（测试目录规范）
 * - T12. SEED-09: process-gate / MAJOR（单元测试）
 * - T13. SEED-10: process-gate / BLOCKER（需求文档先行）
 * - T14. 全部种子规则字段固定约定（source/confirmedBy/usageCount/violationCount/createdAt）
 * - T15. getSeedRuleCount 函数行为
 * - T16. getSeedRulesBySeverity 函数行为
 * - T17. getSeedRulesByCategory 函数行为
 * - T18. getSeedRuleById 函数行为（含 null 返回）
 * - T19. 种子规则分类分布正确（code-truth:4 / comment-style:1 / process-gate:3 / change-control:1 / project-structure:1）
 * - T20. 种子规则级别分布正确（BLOCKER:4 / MAJOR:6 / WARNING:0）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接引用真实 SEED_RULES 常量
 *
 * 设计依据：
 * - EAG 方案 §5.5.5 内置种子规则表
 * - eag/rlis/seed-rules.ts 源文件
 *
 * @module core/tests/eag-rlis-seed-rules
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_RULES,
  getSeedRuleCount,
  getSeedRulesBySeverity,
  getSeedRulesByCategory,
  getSeedRuleById,
} from "../eag/rlis/seed-rules";
import type { UserRule } from "../eag/rlis/types";

// ============================================================================
// T1. SEED_RULES 常量数量完整（10 条）
// ============================================================================

test("T1. SEED_RULES 包含 10 条种子规则", () => {
  assert.equal(SEED_RULES.length, 10);
});

// ============================================================================
// T2. SEED_RULES 已冻结
// ============================================================================

test("T2. SEED_RULES 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(SEED_RULES), true);
});

// ============================================================================
// T3. SEED-01 ~ SEED-10 ID 唯一性与完整性
// ============================================================================

test("T3a. SEED_RULES 的 ID 为 SEED-01 ~ SEED-10", () => {
  const expectedIds = Array.from({ length: 10 }, (_, i) => `SEED-${String(i + 1).padStart(2, "0")}`);
  const actualIds = SEED_RULES.map((r) => r.id);
  assert.deepEqual(actualIds, expectedIds);
});

test("T3b. SEED_RULES 的 ID 全部唯一", () => {
  const ids = SEED_RULES.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 10);
});

// ============================================================================
// T4. SEED-01: code-truth / BLOCKER（禁 mock/占位/简化）
// ============================================================================

test("T4. SEED-01 字段完整：code-truth / BLOCKER / 禁 mock", () => {
  const rule = getSeedRuleById("SEED-01");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "code-truth");
  assert.equal(rule!.severity, "BLOCKER");
  assert.ok(rule!.content.includes("mock"));
  assert.ok(rule!.content.includes("简化"));
});

// ============================================================================
// T5. SEED-02: comment-style / MAJOR（注释规范）
// ============================================================================

test("T5. SEED-02 字段完整：comment-style / MAJOR / 注释规范", () => {
  const rule = getSeedRuleById("SEED-02");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "comment-style");
  assert.equal(rule!.severity, "MAJOR");
  assert.ok(rule!.content.includes("注释"));
  assert.ok(rule!.content.includes("中文"));
});

// ============================================================================
// T6. SEED-03: code-truth / BLOCKER（禁逃避式删除）
// ============================================================================

test("T6. SEED-03 字段完整：code-truth / BLOCKER / 禁逃避式删除", () => {
  const rule = getSeedRuleById("SEED-03");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "code-truth");
  assert.equal(rule!.severity, "BLOCKER");
  assert.ok(rule!.content.includes("逃避式删除"));
});

// ============================================================================
// T7. SEED-04: code-truth / MAJOR（TODO 必须有实现）
// ============================================================================

test("T7. SEED-04 字段完整：code-truth / MAJOR / TODO 必须有实现", () => {
  const rule = getSeedRuleById("SEED-04");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "code-truth");
  assert.equal(rule!.severity, "MAJOR");
  assert.ok(rule!.content.includes("TODO"));
});

// ============================================================================
// T8. SEED-05: process-gate / MAJOR（架构师审查）
// ============================================================================

test("T8. SEED-05 字段完整：process-gate / MAJOR / 架构师审查", () => {
  const rule = getSeedRuleById("SEED-05");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "process-gate");
  assert.equal(rule!.severity, "MAJOR");
  assert.ok(rule!.content.includes("架构师"));
  assert.ok(rule!.content.includes("审查"));
});

// ============================================================================
// T9. SEED-06: change-control / BLOCKER（禁改技术栈）
// ============================================================================

test("T9. SEED-06 字段完整：change-control / BLOCKER / 禁改技术栈", () => {
  const rule = getSeedRuleById("SEED-06");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "change-control");
  assert.equal(rule!.severity, "BLOCKER");
  assert.ok(rule!.content.includes("技术栈"));
});

// ============================================================================
// T10. SEED-07: code-truth / MAJOR（FIXME 必须有修改）
// ============================================================================

test("T10. SEED-07 字段完整：code-truth / MAJOR / FIXME 必须有修改", () => {
  const rule = getSeedRuleById("SEED-07");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "code-truth");
  assert.equal(rule!.severity, "MAJOR");
  assert.ok(rule!.content.includes("FIXME"));
});

// ============================================================================
// T11. SEED-08: project-structure / MAJOR（测试目录规范）
// ============================================================================

test("T11. SEED-08 字段完整：project-structure / MAJOR / 测试目录规范", () => {
  const rule = getSeedRuleById("SEED-08");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "project-structure");
  assert.equal(rule!.severity, "MAJOR");
  assert.ok(rule!.content.includes("tests"));
  assert.ok(rule!.content.includes("tests/scripts"));
});

// ============================================================================
// T12. SEED-09: process-gate / MAJOR（单元测试）
// ============================================================================

test("T12. SEED-09 字段完整：process-gate / MAJOR / 单元测试", () => {
  const rule = getSeedRuleById("SEED-09");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "process-gate");
  assert.equal(rule!.severity, "MAJOR");
  assert.ok(rule!.content.includes("单元测试"));
});

// ============================================================================
// T13. SEED-10: process-gate / BLOCKER（需求文档先行）
// ============================================================================

test("T13. SEED-10 字段完整：process-gate / BLOCKER / 需求文档先行", () => {
  const rule = getSeedRuleById("SEED-10");
  assert.notEqual(rule, null);
  assert.equal(rule!.category, "process-gate");
  assert.equal(rule!.severity, "BLOCKER");
  assert.ok(rule!.content.includes("需求文档"));
});

// ============================================================================
// T14. 全部种子规则字段固定约定
// ============================================================================

test("T14a. 全部种子规则 source 固定为 'builtin-seed'", () => {
  for (const rule of SEED_RULES) {
    assert.equal(rule.source, "builtin-seed", `规则 ${rule.id} 的 source 应为 "builtin-seed"，实际 "${rule.source}"`);
  }
});

test("T14b. 全部种子规则 confirmedBy 固定为 'auto'", () => {
  for (const rule of SEED_RULES) {
    assert.equal(rule.confirmedBy, "auto", `规则 ${rule.id} 的 confirmedBy 应为 "auto"，实际 "${rule.confirmedBy}"`);
  }
});

test("T14c. 全部种子规则 usageCount 初始化为 0", () => {
  for (const rule of SEED_RULES) {
    assert.equal(rule.usageCount, 0, `规则 ${rule.id} 的 usageCount 应为 0，实际 ${rule.usageCount}`);
  }
});

test("T14d. 全部种子规则 violationCount 初始化为 0", () => {
  for (const rule of SEED_RULES) {
    assert.equal(rule.violationCount, 0, `规则 ${rule.id} 的 violationCount 应为 0，实际 ${rule.violationCount}`);
  }
});

test("T14e. 全部种子规则 createdAt 固定为 '2026-07-18T00:00:00.000Z'", () => {
  for (const rule of SEED_RULES) {
    assert.equal(
      rule.createdAt,
      "2026-07-18T00:00:00.000Z",
      `规则 ${rule.id} 的 createdAt 应为 "2026-07-18T00:00:00.000Z"，实际 "${rule.createdAt}"`
    );
  }
});

// ============================================================================
// T15. getSeedRuleCount 函数行为
// ============================================================================

test("T15. getSeedRuleCount 返回 10", () => {
  assert.equal(getSeedRuleCount(), 10);
});

// ============================================================================
// T16. getSeedRulesBySeverity 函数行为
// ============================================================================

test("T16a. getSeedRulesBySeverity('BLOCKER') 返回 4 条", () => {
  const blockerRules = getSeedRulesBySeverity("BLOCKER");
  assert.equal(blockerRules.length, 4);
  // BLOCKER 规则 ID: SEED-01, SEED-03, SEED-06, SEED-10
  const blockerIds = blockerRules.map((r) => r.id);
  assert.ok(blockerIds.includes("SEED-01"));
  assert.ok(blockerIds.includes("SEED-03"));
  assert.ok(blockerIds.includes("SEED-06"));
  assert.ok(blockerIds.includes("SEED-10"));
});

test("T16b. getSeedRulesBySeverity('MAJOR') 返回 6 条", () => {
  const majorRules = getSeedRulesBySeverity("MAJOR");
  assert.equal(majorRules.length, 6);
  // MAJOR 规则 ID: SEED-02, SEED-04, SEED-05, SEED-07, SEED-08, SEED-09
  const majorIds = majorRules.map((r) => r.id);
  assert.ok(majorIds.includes("SEED-02"));
  assert.ok(majorIds.includes("SEED-04"));
  assert.ok(majorIds.includes("SEED-05"));
  assert.ok(majorIds.includes("SEED-07"));
  assert.ok(majorIds.includes("SEED-08"));
  assert.ok(majorIds.includes("SEED-09"));
});

test("T16c. getSeedRulesBySeverity('WARNING') 返回 0 条（种子规则无 WARNING）", () => {
  const warningRules = getSeedRulesBySeverity("WARNING");
  assert.equal(warningRules.length, 0);
});

// ============================================================================
// T17. getSeedRulesByCategory 函数行为
// ============================================================================

test("T17a. getSeedRulesByCategory('code-truth') 返回 4 条", () => {
  const rules = getSeedRulesByCategory("code-truth");
  assert.equal(rules.length, 4);
  // code-truth 规则 ID: SEED-01, SEED-03, SEED-04, SEED-07
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes("SEED-01"));
  assert.ok(ids.includes("SEED-03"));
  assert.ok(ids.includes("SEED-04"));
  assert.ok(ids.includes("SEED-07"));
});

test("T17b. getSeedRulesByCategory('comment-style') 返回 1 条", () => {
  const rules = getSeedRulesByCategory("comment-style");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "SEED-02");
});

test("T17c. getSeedRulesByCategory('process-gate') 返回 3 条", () => {
  const rules = getSeedRulesByCategory("process-gate");
  assert.equal(rules.length, 3);
  // process-gate 规则 ID: SEED-05, SEED-09, SEED-10
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes("SEED-05"));
  assert.ok(ids.includes("SEED-09"));
  assert.ok(ids.includes("SEED-10"));
});

test("T17d. getSeedRulesByCategory('change-control') 返回 1 条", () => {
  const rules = getSeedRulesByCategory("change-control");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "SEED-06");
});

test("T17e. getSeedRulesByCategory('project-structure') 返回 1 条", () => {
  const rules = getSeedRulesByCategory("project-structure");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "SEED-08");
});

test("T17f. getSeedRulesByCategory('quality-gate') 返回 0 条（种子规则无此分类）", () => {
  const rules = getSeedRulesByCategory("quality-gate");
  assert.equal(rules.length, 0);
});

// ============================================================================
// T18. getSeedRuleById 函数行为（含 null 返回）
// ============================================================================

test("T18a. getSeedRuleById('SEED-01') 返回正确规则", () => {
  const rule = getSeedRuleById("SEED-01");
  assert.notEqual(rule, null);
  assert.equal(rule!.id, "SEED-01");
});

test("T18b. getSeedRuleById('SEED-10') 返回正确规则", () => {
  const rule = getSeedRuleById("SEED-10");
  assert.notEqual(rule, null);
  assert.equal(rule!.id, "SEED-10");
});

test("T18c. getSeedRuleById('SEED-99') 不存在时返回 null", () => {
  const rule = getSeedRuleById("SEED-99");
  assert.equal(rule, null);
});

test("T18d. getSeedRuleById('') 空字符串返回 null", () => {
  const rule = getSeedRuleById("");
  assert.equal(rule, null);
});

// ============================================================================
// T19. 种子规则分类分布正确
// ============================================================================

test("T19. 种子规则分类分布：code-truth:4 / comment-style:1 / process-gate:3 / change-control:1 / project-structure:1 / quality-gate:0", () => {
  assert.equal(getSeedRulesByCategory("code-truth").length, 4);
  assert.equal(getSeedRulesByCategory("comment-style").length, 1);
  assert.equal(getSeedRulesByCategory("process-gate").length, 3);
  assert.equal(getSeedRulesByCategory("change-control").length, 1);
  assert.equal(getSeedRulesByCategory("project-structure").length, 1);
  assert.equal(getSeedRulesByCategory("quality-gate").length, 0);
  // 总数 = 10
  const total =
    getSeedRulesByCategory("code-truth").length +
    getSeedRulesByCategory("comment-style").length +
    getSeedRulesByCategory("process-gate").length +
    getSeedRulesByCategory("change-control").length +
    getSeedRulesByCategory("project-structure").length +
    getSeedRulesByCategory("quality-gate").length;
  assert.equal(total, 10);
});

// ============================================================================
// T20. 种子规则级别分布正确
// ============================================================================

test("T20. 种子规则级别分布：BLOCKER:4 / MAJOR:6 / WARNING:0", () => {
  assert.equal(getSeedRulesBySeverity("BLOCKER").length, 4);
  assert.equal(getSeedRulesBySeverity("MAJOR").length, 6);
  assert.equal(getSeedRulesBySeverity("WARNING").length, 0);
  // 总数 = 10
  const total =
    getSeedRulesBySeverity("BLOCKER").length +
    getSeedRulesBySeverity("MAJOR").length +
    getSeedRulesBySeverity("WARNING").length;
  assert.equal(total, 10);
});
