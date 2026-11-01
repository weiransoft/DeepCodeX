/**
 * P2 单元测试：统一证据包（eag evidence-bundle）
 *
 * 测试范围：
 * - T1. 空数据源构建：recordCount=0、种子规则计数、validate ok
 * - T2. 执行历史聚合：计数/窗口过滤/会话去重/工具字典序
 * - T3. 隐私红线：argsSnippet 命中脱敏、明文不出现在序列化输出
 * - T4. 冻结性：显式窗口下两次构建 JSON 字节级一致
 * - T5. 规则证据级别：global 层 violationCount>0 → exercised、usageCount>0 → wired
 * - T6. 校验器拒绝损坏 bundle（generatedAt≠until、计数不一致）
 * - T7. 规则正文不进 bundle
 * - T8. maxRecords 截断
 *
 * 测试约定：node:test + assert/strict；临时目录用 mkdtempSync；不 mock——
 * 用真实 ExecutionHistoryStore.record() 造数据（显式 timestamp 控制时序）。
 *
 * @module core/tests/eag-evidence-bundle
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildEvidenceBundle, validateEvidenceBundle } from "../eag/evidence-bundle";
import { ExecutionHistoryStore } from "../v2/memory/execution-history-store";
import { DEFAULT_REDACTION_RULES, SensitiveInfoRedactor } from "../v2/memory/redaction";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import { readGlobalRulesFile, writeGlobalRulesFile } from "../global-rules";
import type { UserRule } from "../eag/rlis/types";

// ============================================================================
// fixture 辅助
// ============================================================================

/** 固定测试窗口终点（冻结性测试的关键：全部时间显式给定） */
const UNTIL = Date.parse("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  root: string;
  homeDir: string;
  redactor: SensitiveInfoRedactor;
}

/** 创建临时 fixture：homeDir + 项目根 + 注入自定义审计日志路径的脱敏器 */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eag-bundle-test-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, path.join(root, "redaction.log"));
  return { root, homeDir, redactor };
}

/** 用真实 ExecutionHistoryStore 写入指定执行历史（显式 timestamp） */
function seedHistory(
  fixture: Fixture,
  records: Array<{
    sessionId: string;
    toolName: string;
    ok: boolean;
    timestamp: number;
    argsSnippet?: string;
    exitCode?: number | null;
  }>
): void {
  const store = new ExecutionHistoryStore({ projectRoot: fixture.root, homeDir: fixture.homeDir });
  for (const r of records) {
    void store.record({
      sessionId: r.sessionId,
      toolName: r.toolName,
      ok: r.ok,
      timestamp: r.timestamp,
      argsSnippet: r.argsSnippet,
      exitCode: r.exitCode,
    });
  }
  store.closeSync();
}

/** 写入一条全局规则文件 */
function seedGlobalRule(fixture: Fixture, overrides: Partial<UserRule> = {}): UserRule {
  const rule: UserRule = {
    id: "USER-001",
    category: "code-truth",
    severity: "MAJOR",
    content: "禁止使用 console.log 调试语句（此正文不得进入 bundle）",
    source: "user-explicit",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  const existing = readGlobalRulesFile(fixture.homeDir);
  writeGlobalRulesFile(fixture.homeDir, [...existing, rule]);
  return rule;
}

// ============================================================================
// 测试
// ============================================================================

test("T1: 空数据源构建 —— recordCount=0、种子规则计数、validate ok", async () => {
  const fx = makeFixture();
  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - 7 * DAY,
    until: UNTIL,
    depth: "quick",
    redactor: fx.redactor,
  });
  assert.equal(bundle.schemaVersion, "1");
  assert.equal(bundle.depth, "quick");
  assert.equal(bundle.summary.recordCount, 0);
  assert.equal(bundle.summary.sessionCount, 0);
  assert.equal(bundle.assets.rules.seed.length, SEED_RULES.length);
  assert.equal(bundle.assets.rules.global.length, 0);
  assert.equal(bundle.assets.skills.count, 0);
  // generatedAt = window.until（冻结性约束）
  assert.equal(bundle.generatedAt, bundle.window.until);
  assert.ok(validateEvidenceBundle(bundle).ok, "空 bundle 应通过校验");
});

test("T2: 执行历史聚合 —— 计数/窗口过滤/会话去重/工具字典序", async () => {
  const fx = makeFixture();
  seedHistory(fx, [
    { sessionId: "s1", toolName: "bash", ok: true, timestamp: UNTIL - 3 * DAY, exitCode: 0 },
    { sessionId: "s1", toolName: "read", ok: true, timestamp: UNTIL - 2 * DAY },
    { sessionId: "s2", toolName: "bash", ok: false, timestamp: UNTIL - 1 * DAY, exitCode: 1 },
    // 窗口外（早于 since 7 天）——应被过滤
    { sessionId: "s2", toolName: "write", ok: true, timestamp: UNTIL - 30 * DAY },
  ]);
  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - 7 * DAY,
    until: UNTIL,
    depth: "normal",
    redactor: fx.redactor,
  });
  assert.equal(bundle.summary.recordCount, 3);
  assert.equal(bundle.summary.okCount, 2);
  assert.equal(bundle.summary.failCount, 1);
  assert.equal(bundle.summary.sessionCount, 2);
  // 工具计数按字典序插入
  assert.deepEqual(Object.keys(bundle.summary.toolCounts), ["bash", "read"]);
  assert.equal(bundle.summary.toolCounts["bash"], 2);
  // 记录升序
  const ts = bundle.executionHistory.map((r) => r.id);
  assert.equal(ts.length, 3);
  assert.ok(validateEvidenceBundle(bundle).ok);
});

test("T3: 隐私红线 —— argsSnippet 脱敏、明文不出现在序列化输出", async () => {
  const fx = makeFixture();
  seedHistory(fx, [
    {
      sessionId: "s1",
      toolName: "bash",
      ok: true,
      timestamp: UNTIL - DAY,
      argsSnippet: "curl -H 'api_key: sk-secret-123' https://example.com",
    },
  ]);
  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - 7 * DAY,
    until: UNTIL,
    redactor: fx.redactor,
  });
  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes("sk-secret-123"), "明文密钥不得进入 bundle");
  assert.equal(bundle.executionHistory[0]?.redactionHits, 1);
  assert.ok(bundle.executionHistory[0]?.args.includes("[REDACTED]"));
});

test("T4: 冻结性 —— 显式窗口下两次构建 JSON 字节级一致", async () => {
  const fx = makeFixture();
  seedHistory(fx, [
    { sessionId: "s1", toolName: "bash", ok: true, timestamp: UNTIL - DAY, argsSnippet: "npm test" },
    { sessionId: "s2", toolName: "edit", ok: true, timestamp: UNTIL - 2 * DAY },
  ]);
  seedGlobalRule(fx, { id: "USER-002", usageCount: 2 });
  const args = {
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - 7 * DAY,
    until: UNTIL,
    redactor: fx.redactor,
  } as const;
  const first = await buildEvidenceBundle(args);
  const second = await buildEvidenceBundle(args);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "同窗口两次构建应字节级一致");
});

test("T5: 规则证据级别 —— 计数推导 exercised/wired/present", async () => {
  const fx = makeFixture();
  seedGlobalRule(fx, { id: "USER-001", violationCount: 2, usageCount: 5 }); // exercised
  seedGlobalRule(fx, { id: "USER-002", usageCount: 1 }); // wired
  seedGlobalRule(fx, { id: "USER-003" }); // present
  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - DAY,
    until: UNTIL,
    redactor: fx.redactor,
  });
  const byId = new Map(bundle.assets.rules.global.map((r) => [r.id, r]));
  assert.equal(byId.get("USER-001")?.evidenceState, "exercised");
  assert.equal(byId.get("USER-002")?.evidenceState, "wired");
  assert.equal(byId.get("USER-003")?.evidenceState, "present");
  // global 层按 ID 字典序
  assert.deepEqual(
    bundle.assets.rules.global.map((r) => r.id),
    ["USER-001", "USER-002", "USER-003"]
  );
});

test("T6: 校验器拒绝损坏 bundle", async () => {
  const fx = makeFixture();
  const good = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - DAY,
    until: UNTIL,
    redactor: fx.redactor,
  });
  // generatedAt ≠ window.until
  const tampered1 = { ...good, generatedAt: "2026-07-01T00:00:00.000Z" };
  const v1 = validateEvidenceBundle(tampered1);
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((e) => e.includes("generatedAt")));
  // recordCount ≠ ok + fail
  const tampered2 = {
    ...good,
    summary: { ...good.summary, recordCount: 5, okCount: 0, failCount: 0 },
  };
  const v2 = validateEvidenceBundle(tampered2);
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("recordCount")));
  // 非 JSON 输入
  assert.equal(validateEvidenceBundle("nope").ok, false);
});

test("T7: 规则正文不进 bundle（计数只用于路由）", async () => {
  const fx = makeFixture();
  const rule = seedGlobalRule(fx, {});
  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - DAY,
    until: UNTIL,
    redactor: fx.redactor,
  });
  assert.ok(!JSON.stringify(bundle).includes(rule.content), "规则正文不得进入 bundle");
  assert.equal(bundle.assets.rules.global[0]?.id, rule.id);
  assert.equal(bundle.assets.rules.global[0]?.usageCount, 0);
});

test("T8: maxRecords 截断（保留窗口内最早的记录）", async () => {
  const fx = makeFixture();
  seedHistory(fx, [
    { sessionId: "s1", toolName: "bash", ok: true, timestamp: UNTIL - 3 * DAY },
    { sessionId: "s2", toolName: "read", ok: true, timestamp: UNTIL - 2 * DAY },
    { sessionId: "s3", toolName: "edit", ok: true, timestamp: UNTIL - DAY },
  ]);
  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: UNTIL - 7 * DAY,
    until: UNTIL,
    maxRecords: 2,
    redactor: fx.redactor,
  });
  assert.equal(bundle.summary.recordCount, 2);
  // 升序截断保留最早两条
  assert.equal(bundle.executionHistory[0]?.sessionId, "s1");
  assert.equal(bundle.executionHistory[1]?.sessionId, "s2");
});
