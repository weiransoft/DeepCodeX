/**
 * P1 单元测试：规则使用证据链（RuleEvidence）
 *
 * 测试范围：
 * - T1. recordUsage 追加 evidence.wiredAt，deriveRuleEvidenceState → wired
 * - T2. recordViolation 追加 evidence.exercisedAt，state → exercised
 * - T3. recordVerdictRef 追加 verdictRefs，state → outcome-supported
 * - T4. copy-on-write：原规则对象不被突变
 * - T5. 容量上限：超 RULE_EVIDENCE_MAX_ENTRIES 丢弃最旧条目
 * - T6. deriveRuleEvidenceState 统计字段兜底（无 evidence 时按计数推导）
 * - T7. recordVerdictRef 空 ref 抛错
 * - T8. 旧规则（无 evidence 字段）兼容：derive → present/按计数
 *
 * 测试约定：node:test + assert/strict，禁止 mock，真实 RuleStore 实例。
 *
 * @module core/tests/eag-rlis-rule-evidence
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RuleStore } from "../eag/rlis/rule-store";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import { RULE_EVIDENCE_MAX_ENTRIES, deriveRuleEvidenceState, type UserRule } from "../eag/rlis/types";
import { markGlobalRulesInjected, readGlobalRulesFile, writeGlobalRulesFile } from "../global-rules";

/** 构造一条测试用 UserRule */
function makeRule(overrides: Partial<UserRule> = {}): UserRule {
  return {
    id: "USER-001",
    category: "code-truth",
    severity: "MAJOR",
    content: "测试规则正文",
    source: "user-explicit",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("T1: recordUsage 追加 wiredAt 且证据级别升级为 wired", () => {
  const store = new RuleStore(SEED_RULES, [makeRule()]);
  store.recordUsage("USER-001");
  const rule = store.getRuleById("USER-001");
  assert.ok(rule, "规则应存在");
  assert.equal(rule.usageCount, 1);
  assert.ok(rule.evidence, "evidence 应被初始化");
  assert.equal(rule.evidence.wiredAt.length, 1);
  assert.equal(rule.evidence.exercisedAt.length, 0);
  assert.equal(deriveRuleEvidenceState(rule), "wired");
});

test("T2: recordViolation 追加 exercisedAt 且证据级别升级为 exercised", () => {
  const store = new RuleStore(SEED_RULES, [makeRule()]);
  store.recordViolation("USER-001");
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.equal(rule.violationCount, 1);
  assert.equal(rule.evidence?.exercisedAt.length, 1);
  assert.equal(deriveRuleEvidenceState(rule), "exercised");
});

test("T3: recordVerdictRef 追加 verdictRefs 且证据级别升级为 outcome-supported", () => {
  const store = new RuleStore(SEED_RULES, [makeRule()]);
  store.recordUsage("USER-001");
  store.recordVerdictRef("USER-001", "task-42:pass");
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.deepEqual([...(rule.evidence?.verdictRefs ?? [])], ["task-42:pass"]);
  assert.equal(deriveRuleEvidenceState(rule), "outcome-supported");
  // verdictRef 不影响统计计数
  assert.equal(rule.usageCount, 1);
  assert.equal(rule.violationCount, 0);
});

test("T4: copy-on-write —— 证据追加不突变原规则对象", () => {
  const original = makeRule();
  const store = new RuleStore(SEED_RULES, [original]);
  store.recordUsage("USER-001");
  // 原对象未被突变
  assert.equal(original.usageCount, 0);
  assert.equal(original.evidence, undefined);
  const updated = store.getRuleById("USER-001");
  assert.ok(updated);
  assert.equal(updated.usageCount, 1);
  assert.equal(updated.evidence?.wiredAt.length, 1);
});

test("T5: 时间线容量上限 —— 超限丢弃最旧条目", () => {
  const store = new RuleStore(SEED_RULES, [makeRule()]);
  for (let i = 0; i < RULE_EVIDENCE_MAX_ENTRIES + 5; i++) {
    store.recordUsage("USER-001");
  }
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.equal(rule.evidence?.wiredAt.length, RULE_EVIDENCE_MAX_ENTRIES);
  assert.equal(rule.usageCount, RULE_EVIDENCE_MAX_ENTRIES + 5);
});

test("T6: deriveRuleEvidenceState 统计字段兜底（无 evidence 字段）", () => {
  // 只有 usageCount → wired
  const wiredOnly = makeRule({ usageCount: 3 });
  assert.equal(deriveRuleEvidenceState(wiredOnly), "wired");
  // 有 violationCount → exercised（优先于 wired）
  const exercised = makeRule({ usageCount: 3, violationCount: 1 });
  assert.equal(deriveRuleEvidenceState(exercised), "exercised");
  // 全零 → present
  assert.equal(deriveRuleEvidenceState(makeRule()), "present");
});

test("T7: recordVerdictRef 空 ref 抛错", () => {
  const store = new RuleStore(SEED_RULES, [makeRule()]);
  assert.throws(() => store.recordVerdictRef("USER-001", "  "), /verdictRef 不能为空/);
  assert.throws(() => store.recordVerdictRef("USER-NOPE", "x"), /不存在/);
});

test("T8: 旧格式规则（evidence 缺省 undefined）读取兼容", () => {
  const store = new RuleStore(SEED_RULES, [makeRule()]);
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.equal(rule.evidence, undefined);
  assert.equal(deriveRuleEvidenceState(rule), "present");
  // 二次注入正常追加
  store.recordUsage("USER-001");
  assert.equal(store.getRuleById("USER-001")?.evidence?.wiredAt.length, 1);
});

test("T9: markGlobalRulesInjected —— 注入回写 usageCount+1 与 wiredAt", () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mark-test-"));
  const rule = makeRule();
  writeGlobalRulesFile(homeRoot, [rule]);
  markGlobalRulesInjected(homeRoot, "2026-06-01T00:00:00.000Z");
  const [updated] = readGlobalRulesFile(homeRoot);
  assert.equal(updated.usageCount, 1);
  assert.deepEqual([...(updated.evidence?.wiredAt ?? [])], ["2026-06-01T00:00:00.000Z"]);
  assert.equal(updated.evidence?.exercisedAt.length, 0);
  assert.equal(deriveRuleEvidenceState(updated), "wired");
  // 二次注入累加
  markGlobalRulesInjected(homeRoot, "2026-06-02T00:00:00.000Z");
  const [again] = readGlobalRulesFile(homeRoot);
  assert.equal(again.usageCount, 2);
  assert.equal(again.evidence?.wiredAt.length, 2);
});

test("T10: markGlobalRulesInjected 容错 —— 空规则文件 no-op 不抛错", () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mark-empty-"));
  assert.doesNotThrow(() => markGlobalRulesInjected(homeRoot, "2026-06-01T00:00:00.000Z"));
  assert.equal(readGlobalRulesFile(homeRoot).length, 0);
});
