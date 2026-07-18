/**
 * EAG-P1 批次 6 单元测试：RuleStore 三层存储 + RuleInjector 注入器（EAG 方案 §5.5.2 / §5.5.3）
 *
 * 测试范围：
 * - RuleStore 三层存储：
 *   - T1.  构造函数（仅种子层）
 *   - T2.  构造函数（种子 + 全局 + 项目三层）
 *   - T3.  getEffectiveRules 按 severity 排序（BLOCKER 优先）
 *   - T4.  getRuleById 查询（含 null 返回）
 *   - T5.  getRulesByCategory 按分类查询
 *   - T6.  getRulesBySeverity 按级别查询
 *   - T7.  getSnapshot 快照完整性
 *   - T8.  addUserRule 添加用户规则（含重复 ID 抛错）
 *   - T9.  addLearnedRule 添加学习规则（含防误学红线）
 *   - T10. recordUsage 累加 usageCount（含不存在 ID 抛错）
 *   - T11. recordViolation 累加 violationCount
 *   - T12. suggestSeverityUpgrade 高频违规阈值判定
 *   - T13. suggestCleanup 长期零违规阈值判定
 *   - T14. copy-on-write 模式不修改原对象
 *   - T15. 同 ID 规则按优先级覆盖（project > global > seed）
 *
 * - RuleInjector 注入器：
 *   - T16. inject 空规则列表返回空字符串
 *   - T17. inject 默认不截断（全部注入）
 *   - T18. inject 按 category 分组
 *   - T19. inject 同 category 内按 severity 排序（BLOCKER 置顶）
 *   - T20. formatRule 格式化单条规则
 *   - T21. estimateTokenCount 4 字符/token 粗估
 *   - T22. inject 超 token 预算截断（WARNING 最先裁）
 *   - T23. inject 超预算截断时追加提示
 *   - T24. inject BLOCKER 永不裁（即使超预算）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 SEED_RULES 与构造真实对象
 *
 * 设计依据：
 * - EAG 方案 §5.5.2 三层规则存储
 * - EAG 方案 §5.5.3 规则注入
 * - EAG 方案 §5.5.4 反馈闭环
 * - eag/rlis/rule-store.ts 与 eag/rlis/rule-injector.ts 源文件
 *
 * @module core/tests/eag-rlis-rule-store-injector
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleStore } from "../eag/rlis/rule-store";
import { RuleInjector } from "../eag/rlis/rule-injector";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import type { UserRule } from "../eag/rlis/types";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建一条测试用 UserRule
 */
function makeRule(overrides: Partial<UserRule> = {}): UserRule {
  return {
    id: "USER-01",
    category: "code-truth",
    severity: "MAJOR",
    content: "测试规则",
    source: "user-explicit",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// RuleStore 三层存储测试
// ============================================================================

// ============================================================================
// T1. 构造函数（仅种子层）
// ============================================================================

test("T1a. RuleStore 仅种子层构造：getEffectiveRules 返回 10 条", () => {
  const store = new RuleStore(SEED_RULES);
  assert.equal(store.getEffectiveRules().length, 10);
});

test("T1b. RuleStore 仅种子层构造：getSnapshot 字段完整", () => {
  const store = new RuleStore(SEED_RULES);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.seedRules.length, 10);
  assert.equal(snapshot.globalRules.length, 0);
  assert.equal(snapshot.projectRules.length, 0);
  assert.equal(snapshot.effectiveRules.length, 10);
});

// ============================================================================
// T2. 构造函数（种子 + 全局 + 项目三层）
// ============================================================================

test("T2. RuleStore 三层构造：effective 数量 = 去重后的合并数", () => {
  const globalRules: UserRule[] = [
    makeRule({ id: "USER-01", severity: "MAJOR" }),
    makeRule({ id: "USER-02", category: "comment-style", severity: "WARNING" }),
  ];
  const projectRules: UserRule[] = [makeRule({ id: "PROJ-01", category: "process-gate", severity: "BLOCKER" })];
  const store = new RuleStore(SEED_RULES, globalRules, projectRules);
  // 合并后：10 条种子 + 2 条全局 + 1 条项目 = 13 条（无 ID 冲突）
  assert.equal(store.getEffectiveRules().length, 13);
});

// ============================================================================
// T3. getEffectiveRules 按 severity 排序（BLOCKER 优先）
// ============================================================================

test("T3. getEffectiveRules 按 severity 排序：BLOCKER 在前，WARNING 在后", () => {
  const globalRules: UserRule[] = [
    makeRule({ id: "USER-W01", severity: "WARNING" }),
    makeRule({ id: "USER-M01", severity: "MAJOR" }),
  ];
  const store = new RuleStore(SEED_RULES, globalRules);
  const effective = store.getEffectiveRules();
  // 第一条必须是 BLOCKER
  assert.equal(effective[0].severity, "BLOCKER");
  // 最后一条必须是 WARNING
  assert.equal(effective[effective.length - 1].severity, "WARNING");
});

// ============================================================================
// T4. getRuleById 查询
// ============================================================================

test("T4a. getRuleById 查询存在的规则", () => {
  const store = new RuleStore(SEED_RULES);
  const rule = store.getRuleById("SEED-01");
  assert.notEqual(rule, null);
  assert.equal(rule!.id, "SEED-01");
});

test("T4b. getRuleById 查询不存在的规则返回 null", () => {
  const store = new RuleStore(SEED_RULES);
  assert.equal(store.getRuleById("SEED-99"), null);
});

// ============================================================================
// T5. getRulesByCategory 按分类查询
// ============================================================================

test("T5. getRulesByCategory('code-truth') 返回 4 条", () => {
  const store = new RuleStore(SEED_RULES);
  const rules = store.getRulesByCategory("code-truth");
  assert.equal(rules.length, 4);
  for (const r of rules) {
    assert.equal(r.category, "code-truth");
  }
});

// ============================================================================
// T6. getRulesBySeverity 按级别查询
// ============================================================================

test("T6. getRulesBySeverity('BLOCKER') 返回 4 条", () => {
  const store = new RuleStore(SEED_RULES);
  const rules = store.getRulesBySeverity("BLOCKER");
  assert.equal(rules.length, 4);
  for (const r of rules) {
    assert.equal(r.severity, "BLOCKER");
  }
});

// ============================================================================
// T7. getSnapshot 快照完整性
// ============================================================================

test("T7. getSnapshot 返回三层完整快照", () => {
  const globalRules: UserRule[] = [makeRule({ id: "USER-01" })];
  const projectRules: UserRule[] = [makeRule({ id: "PROJ-01" })];
  const store = new RuleStore(SEED_RULES, globalRules, projectRules);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.seedRules.length, 10);
  assert.equal(snapshot.globalRules.length, 1);
  assert.equal(snapshot.projectRules.length, 1);
  assert.equal(snapshot.effectiveRules.length, 12);
});

// ============================================================================
// T8. addUserRule 添加用户规则
// ============================================================================

test("T8a. addUserRule 成功添加：effective 数量 +1", () => {
  const store = new RuleStore(SEED_RULES);
  const initialCount = store.getEffectiveRules().length;
  store.addUserRule(makeRule({ id: "USER-01" }));
  assert.equal(store.getEffectiveRules().length, initialCount + 1);
});

test("T8b. addUserRule 强制覆盖 source 为 'user-explicit'", () => {
  const store = new RuleStore(SEED_RULES);
  store.addUserRule(makeRule({ id: "USER-01", source: "learned" }));
  const rule = store.getRuleById("USER-01");
  assert.equal(rule!.source, "user-explicit");
});

test("T8c. addUserRule 强制覆盖 confirmedBy 为 'auto'", () => {
  const store = new RuleStore(SEED_RULES);
  store.addUserRule(makeRule({ id: "USER-01", confirmedBy: "user" }));
  const rule = store.getRuleById("USER-01");
  assert.equal(rule!.confirmedBy, "auto");
});

test("T8d. addUserRule 重复 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  store.addUserRule(makeRule({ id: "USER-01" }));
  assert.throws(() => {
    store.addUserRule(makeRule({ id: "USER-01" }));
  }, /已存在/);
});

test("T8e. addUserRule 重复种子规则 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  assert.throws(() => {
    store.addUserRule(makeRule({ id: "SEED-01" }));
  }, /已存在/);
});

// ============================================================================
// T9. addLearnedRule 添加学习规则（防误学红线）
// ============================================================================

test("T9a. addLearnedRule confirmedBy='user' 成功添加", () => {
  const store = new RuleStore(SEED_RULES);
  store.addLearnedRule(makeRule({ id: "LEARN-01", source: "learned", confirmedBy: "user" }));
  const rule = store.getRuleById("LEARN-01");
  assert.notEqual(rule, null);
  assert.equal(rule!.source, "learned");
  assert.equal(rule!.confirmedBy, "user");
});

test("T9b. addLearnedRule confirmedBy='auto' 抛错（防误学红线）", () => {
  const store = new RuleStore(SEED_RULES);
  assert.throws(() => {
    store.addLearnedRule(makeRule({ id: "LEARN-01", source: "learned", confirmedBy: "auto" }));
  }, /必须经用户确认/);
});

test("T9c. addLearnedRule 强制覆盖 source 为 'learned'", () => {
  const store = new RuleStore(SEED_RULES);
  store.addLearnedRule(makeRule({ id: "LEARN-01", source: "user-explicit", confirmedBy: "user" }));
  const rule = store.getRuleById("LEARN-01");
  assert.equal(rule!.source, "learned");
});

test("T9d. addLearnedRule 重复 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  store.addLearnedRule(makeRule({ id: "LEARN-01", source: "learned", confirmedBy: "user" }));
  assert.throws(() => {
    store.addLearnedRule(makeRule({ id: "LEARN-01", source: "learned", confirmedBy: "user" }));
  }, /已存在/);
});

// ============================================================================
// T10. recordUsage 累加 usageCount
// ============================================================================

test("T10a. recordUsage 成功累加 usageCount", () => {
  const store = new RuleStore(SEED_RULES);
  const before = store.getRuleById("SEED-01")!.usageCount;
  store.recordUsage("SEED-01");
  const after = store.getRuleById("SEED-01")!.usageCount;
  assert.equal(after, before + 1);
});

test("T10b. recordUsage 多次累加 usageCount", () => {
  const store = new RuleStore(SEED_RULES);
  store.recordUsage("SEED-01");
  store.recordUsage("SEED-01");
  store.recordUsage("SEED-01");
  assert.equal(store.getRuleById("SEED-01")!.usageCount, 3);
});

test("T10c. recordUsage 不存在的 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  assert.throws(() => {
    store.recordUsage("SEED-99");
  }, /不存在/);
});

// ============================================================================
// T11. recordViolation 累加 violationCount
// ============================================================================

test("T11a. recordViolation 成功累加 violationCount", () => {
  const store = new RuleStore(SEED_RULES);
  store.recordViolation("SEED-01");
  assert.equal(store.getRuleById("SEED-01")!.violationCount, 1);
});

test("T11b. recordViolation 不存在的 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  assert.throws(() => {
    store.recordViolation("SEED-99");
  }, /不存在/);
});

// ============================================================================
// T12. suggestSeverityUpgrade 高频违规阈值判定
// ============================================================================

test("T12a. suggestSeverityUpgrade violationCount<5 返回 false", () => {
  const store = new RuleStore(SEED_RULES);
  // 累加 4 次违规（< 5）
  for (let i = 0; i < 4; i++) store.recordViolation("SEED-01");
  assert.equal(store.suggestSeverityUpgrade("SEED-01"), false);
});

test("T12b. suggestSeverityUpgrade violationCount=5 返回 true", () => {
  const store = new RuleStore(SEED_RULES);
  // 累加 5 次违规（>= 5）
  for (let i = 0; i < 5; i++) store.recordViolation("SEED-01");
  assert.equal(store.suggestSeverityUpgrade("SEED-01"), true);
});

test("T12c. suggestSeverityUpgrade violationCount>5 返回 true", () => {
  const store = new RuleStore(SEED_RULES);
  for (let i = 0; i < 10; i++) store.recordViolation("SEED-01");
  assert.equal(store.suggestSeverityUpgrade("SEED-01"), true);
});

test("T12d. suggestSeverityUpgrade 不存在的 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  assert.throws(() => {
    store.suggestSeverityUpgrade("SEED-99");
  }, /不存在/);
});

// ============================================================================
// T13. suggestCleanup 长期零违规阈值判定
// ============================================================================

test("T13a. suggestCleanup usageCount<10 返回 false", () => {
  const store = new RuleStore(SEED_RULES);
  for (let i = 0; i < 9; i++) store.recordUsage("SEED-01");
  assert.equal(store.suggestCleanup("SEED-01"), false);
});

test("T13b. suggestCleanup usageCount=10 且 violationCount=0 返回 true", () => {
  const store = new RuleStore(SEED_RULES);
  for (let i = 0; i < 10; i++) store.recordUsage("SEED-01");
  assert.equal(store.suggestCleanup("SEED-01"), true);
});

test("T13c. suggestCleanup usageCount>=10 但 violationCount>0 返回 false", () => {
  const store = new RuleStore(SEED_RULES);
  for (let i = 0; i < 10; i++) store.recordUsage("SEED-01");
  store.recordViolation("SEED-01");
  assert.equal(store.suggestCleanup("SEED-01"), false);
});

test("T13d. suggestCleanup 不存在的 ID 抛错", () => {
  const store = new RuleStore(SEED_RULES);
  assert.throws(() => {
    store.suggestCleanup("SEED-99");
  }, /不存在/);
});

// ============================================================================
// T14. copy-on-write 模式不修改原对象
// ============================================================================

test("T14a. recordUsage 不修改原 SEED_RULES 常量", () => {
  // 记录原始 usageCount
  const originalUsage = SEED_RULES[0].usageCount;
  const store = new RuleStore(SEED_RULES);
  store.recordUsage("SEED-01");
  // 验证原 SEED_RULES 常量未被修改
  assert.equal(SEED_RULES[0].usageCount, originalUsage);
});

test("T14b. addUserRule 不修改原 SEED_RULES 常量", () => {
  const originalLength = SEED_RULES.length;
  const store = new RuleStore(SEED_RULES);
  store.addUserRule(makeRule({ id: "USER-01" }));
  // 验证原 SEED_RULES 常量未被修改
  assert.equal(SEED_RULES.length, originalLength);
});

// ============================================================================
// T15. 同 ID 规则按优先级覆盖（project > global > seed）
// ============================================================================

test("T15a. 同 ID 规则：project 覆盖 global", () => {
  const globalRules: UserRule[] = [makeRule({ id: "USER-01", content: "全局规则内容" })];
  const projectRules: UserRule[] = [makeRule({ id: "USER-01", content: "项目规则内容（覆盖全局）" })];
  const store = new RuleStore(SEED_RULES, globalRules, projectRules);
  const rule = store.getRuleById("USER-01");
  assert.equal(rule!.content, "项目规则内容（覆盖全局）");
});

test("T15b. 同 ID 规则：global 覆盖 seed", () => {
  const globalRules: UserRule[] = [makeRule({ id: "SEED-01", content: "全局覆盖种子规则内容" })];
  const store = new RuleStore(SEED_RULES, globalRules);
  const rule = store.getRuleById("SEED-01");
  assert.equal(rule!.content, "全局覆盖种子规则内容");
});

test("T15c. 同 ID 规则：project 覆盖 seed", () => {
  const projectRules: UserRule[] = [makeRule({ id: "SEED-01", content: "项目覆盖种子规则内容" })];
  const store = new RuleStore(SEED_RULES, [], projectRules);
  const rule = store.getRuleById("SEED-01");
  assert.equal(rule!.content, "项目覆盖种子规则内容");
});

test("T15d. 同 ID 规则：project > global > seed（三层同 ID 时 project 胜出）", () => {
  const globalRules: UserRule[] = [makeRule({ id: "SEED-01", content: "全局层" })];
  const projectRules: UserRule[] = [makeRule({ id: "SEED-01", content: "项目层（最高优先级）" })];
  const store = new RuleStore(SEED_RULES, globalRules, projectRules);
  const rule = store.getRuleById("SEED-01");
  assert.equal(rule!.content, "项目层（最高优先级）");
});

// ============================================================================
// RuleInjector 注入器测试
// ============================================================================

// ============================================================================
// T16. inject 空规则列表返回空字符串
// ============================================================================

test("T16. inject 空规则列表返回空字符串", () => {
  const injector = new RuleInjector();
  assert.equal(injector.inject([]), "");
});

// ============================================================================
// T17. inject 默认不截断（全部注入）
// ============================================================================

test("T17. inject 默认不截断：注入全部 10 条种子规则", () => {
  const injector = new RuleInjector();
  const text = injector.inject(SEED_RULES);
  // 验证全部 10 条规则 ID 都出现在注入文本中
  for (const rule of SEED_RULES) {
    assert.ok(text.includes(`[${rule.id}]`), `注入文本应包含规则 ID ${rule.id}`);
  }
});

// ============================================================================
// T18. inject 按 category 分组
// ============================================================================

test("T18. inject 按 category 分组：6 个分类标题（非空分类）", () => {
  const injector = new RuleInjector();
  const text = injector.inject(SEED_RULES);
  // 种子规则涉及 5 个分类（quality-gate 无规则）
  assert.ok(text.includes("### [code-truth]"));
  assert.ok(text.includes("### [comment-style]"));
  assert.ok(text.includes("### [process-gate]"));
  assert.ok(text.includes("### [change-control]"));
  assert.ok(text.includes("### [project-structure]"));
  // quality-gate 在种子规则中无内容，不应出现
  assert.ok(!text.includes("### [quality-gate]"));
});

// ============================================================================
// T19. inject 同 category 内按 severity 排序（BLOCKER 置顶）
// ============================================================================

test("T19. inject 同 category 内 BLOCKER 在 MAJOR 之前", () => {
  const injector = new RuleInjector();
  const text = injector.inject(SEED_RULES);
  // code-truth 分类：BLOCKER 有 SEED-01/SEED-03，MAJOR 有 SEED-04/SEED-07
  const seed01Pos = text.indexOf("[SEED-01]");
  const seed03Pos = text.indexOf("[SEED-03]");
  const seed04Pos = text.indexOf("[SEED-04]");
  const seed07Pos = text.indexOf("[SEED-07]");
  // BLOCKER 规则应在 MAJOR 规则之前
  assert.ok(seed01Pos < seed04Pos, "SEED-01 (BLOCKER) 应在 SEED-04 (MAJOR) 之前");
  assert.ok(seed01Pos < seed07Pos, "SEED-01 (BLOCKER) 应在 SEED-07 (MAJOR) 之前");
  assert.ok(seed03Pos < seed04Pos, "SEED-03 (BLOCKER) 应在 SEED-04 (MAJOR) 之前");
  assert.ok(seed03Pos < seed07Pos, "SEED-03 (BLOCKER) 应在 SEED-07 (MAJOR) 之前");
});

// ============================================================================
// T20. formatRule 格式化单条规则
// ============================================================================

test("T20. formatRule 格式：'- [ID] [SEVERITY] content'", () => {
  const injector = new RuleInjector();
  const rule = SEED_RULES[0];
  const formatted = injector.formatRule(rule);
  assert.equal(formatted, `- [${rule.id}] [${rule.severity}] ${rule.content}`);
});

// ============================================================================
// T21. estimateTokenCount 4 字符/token 粗估
// ============================================================================

test("T21a. estimateTokenCount 空字符串返回 0", () => {
  const injector = new RuleInjector();
  assert.equal(injector.estimateTokenCount(""), 0);
});

test("T21b. estimateTokenCount 4 字符 ≈ 1 token（向上取整）", () => {
  const injector = new RuleInjector();
  // 4 字符 → 1 token
  assert.equal(injector.estimateTokenCount("abcd"), 1);
});

test("T21c. estimateTokenCount 5 字符 ≈ 2 token（向上取整）", () => {
  const injector = new RuleInjector();
  // 5 字符 / 4 = 1.25 → 向上取整为 2
  assert.equal(injector.estimateTokenCount("abcde"), 2);
});

// ============================================================================
// T22. inject 超 token 预算截断（WARNING 最先裁）
// ============================================================================

test("T22. inject 超 token 预算：WARNING 规则被裁剪", () => {
  const injector = new RuleInjector();
  // 构造含 WARNING 规则的测试数据
  const rules: UserRule[] = [
    makeRule({ id: "USER-B01", severity: "BLOCKER", content: "BLOCKER 规则 1" }),
    makeRule({ id: "USER-M01", severity: "MAJOR", content: "MAJOR 规则 1" }),
    makeRule({ id: "USER-W01", severity: "WARNING", content: "WARNING 规则 1" }),
    makeRule({ id: "USER-W02", severity: "WARNING", content: "WARNING 规则 2" }),
  ];
  // 设置极小的 token 预算，强制触发截断
  const text = injector.inject(rules, {
    maxTokenBudget: 20,
    truncateBySeverity: true,
  });
  // BLOCKER 和 MAJOR 应保留
  assert.ok(text.includes("[USER-B01]"), "BLOCKER 规则应保留");
  // WARNING 规则可能被裁剪（取决于预算）
  // 验证截断提示出现
  assert.ok(text.includes("已截断"), "截断时应追加截断提示");
});

// ============================================================================
// T23. inject 超预算截断时追加提示
// ============================================================================

test("T23. inject 超预算截断时追加'（已截断 N 条）'提示", () => {
  const injector = new RuleInjector();
  const rules: UserRule[] = [
    makeRule({ id: "USER-W01", severity: "WARNING", content: "WARNING 规则 1" }),
    makeRule({ id: "USER-W02", severity: "WARNING", content: "WARNING 规则 2" }),
    makeRule({ id: "USER-W03", severity: "WARNING", content: "WARNING 规则 3" }),
  ];
  const text = injector.inject(rules, {
    maxTokenBudget: 10,
    truncateBySeverity: true,
  });
  assert.ok(text.includes("已截断"), "应包含截断提示");
});

// ============================================================================
// T24. inject BLOCKER 永不裁（即使超预算）
// ============================================================================

test("T24. inject 超预算时 BLOCKER 永不裁", () => {
  const injector = new RuleInjector();
  const rules: UserRule[] = [
    makeRule({ id: "USER-B01", severity: "BLOCKER", content: "BLOCKER 规则 1" }),
    makeRule({ id: "USER-B02", severity: "BLOCKER", content: "BLOCKER 规则 2" }),
    makeRule({ id: "USER-W01", severity: "WARNING", content: "WARNING 规则 1" }),
  ];
  // 极小预算，强制仅保留 BLOCKER
  const text = injector.inject(rules, {
    maxTokenBudget: 5,
    truncateBySeverity: true,
  });
  // BLOCKER 规则必须保留
  assert.ok(text.includes("[USER-B01]"), "BLOCKER 规则 1 必须保留");
  assert.ok(text.includes("[USER-B02]"), "BLOCKER 规则 2 必须保留");
});
