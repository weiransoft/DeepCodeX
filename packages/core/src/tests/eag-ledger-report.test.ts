/**
 * P6 干预台账 + 确定性报告渲染测试
 *
 * 覆盖：
 * 1. 台账：roundtrip / 双读单写兼容 / 容错读（损坏不抛）/ 原子写 / 容量上限 / 回访回填
 * 2. 渲染：确定性（同输入字节级一致）/ 必备章节校验 / 空态 / Outcome-supported 追溯行
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readLedger,
  appendLedgerEntry,
  recordVerification,
  ledgerFilePath,
  legacyLedgerFilePath,
  MAX_LEDGER_ENTRIES,
  type LedgerEntry,
} from "../eag/intervention-ledger";
import { renderAuditReport, validateAuditReport, type AuditReportInput } from "../eag/report-render";

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p6-ledger-"));
}

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    findingId: "FINDING-001",
    appliedAt: "2026-10-30T10:00:00.000Z",
    owner: "user",
    expectedEffect: "构建轮次减少一半",
    ...overrides,
  };
}

// ============================================================================
// 1. 台账
// ============================================================================

test("T1: 台账 roundtrip——append 后 read 读回一致", () => {
  const home = makeHome();
  assert.equal(appendLedgerEntry(home, makeEntry()), true);
  const entries = readLedger(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].findingId, "FINDING-001");
  assert.equal(entries[0].appliedAt, "2026-10-30T10:00:00.000Z");
  // 落在新根
  assert.ok(fs.existsSync(ledgerFilePath(home)));
});

test("T2: 双读单写——新根缺失时回退旧根读取；追加时旧根条目随首次写入带入新根（单写路径零丢失）", () => {
  const home = makeHome();
  // 只写旧根（模拟存量）
  const legacyPath = legacyLedgerFilePath(home);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify([makeEntry({ findingId: "LEGACY-1" })]), "utf8");
  const entries = readLedger(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].findingId, "LEGACY-1");
  // 追加写入：走新根（唯一写入路径）；为防丢失，旧根存量随本次写入合并进新根
  assert.equal(appendLedgerEntry(home, makeEntry({ findingId: "NEW-1" })), true);
  assert.ok(fs.existsSync(ledgerFilePath(home)));
  assert.ok(fs.existsSync(legacyLedgerFilePath(home))); // 旧根文件保留（不删除不迁移工具）
  // 合并视图：LEGACY-1 + NEW-1 都可见（此后读新根）
  const merged = readLedger(home);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((e) => e.findingId).sort(), ["LEGACY-1", "NEW-1"]);
});

test("T3: 容错读——损坏 JSON / 非数组 / 坏条目逐条跳过，不抛出", () => {
  const home = makeHome();
  const p = ledgerFilePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{ not json", "utf8");
  assert.deepEqual(readLedger(home), []);
  fs.writeFileSync(p, JSON.stringify({ oops: true }), "utf8");
  assert.deepEqual(readLedger(home), []);
  fs.writeFileSync(
    p,
    JSON.stringify([
      makeEntry(),
      { bad: true },
      null,
      { findingId: "", appliedAt: "x", owner: "o", expectedEffect: "e" },
    ]),
    "utf8"
  );
  const entries = readLedger(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].findingId, "FINDING-001");
});

test("T4: 非法条目拒绝写入（缺关键字段返回 false）", () => {
  const home = makeHome();
  assert.equal(appendLedgerEntry(home, makeEntry({ findingId: "" })), false);
  assert.equal(appendLedgerEntry(home, makeEntry({ expectedEffect: "" })), false);
  assert.equal(readLedger(home).length, 0);
});

test("T5: 容量上限——超出 MAX_LEDGER_ENTRIES 时优先丢弃最旧无验证条目", () => {
  const home = makeHome();
  for (let i = 0; i < MAX_LEDGER_ENTRIES + 10; i += 1) {
    assert.equal(
      appendLedgerEntry(
        home,
        makeEntry({
          findingId: `F-${i}`,
          appliedAt: `2026-10-30T10:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(4, "0")}Z`,
        })
      ),
      true
    );
  }
  const entries = readLedger(home);
  assert.equal(entries.length, MAX_LEDGER_ENTRIES);
  // 最旧的无验证条目被丢弃：F-0 不在，F-(MAX+9) 在
  assert.ok(!entries.some((e) => e.findingId === "F-0"));
  assert.ok(entries.some((e) => e.findingId === `F-${MAX_LEDGER_ENTRIES + 9}`));
});

test("T6: 回访回填——recordVerification 匹配最近未验证条目；已验证条目不再匹配", () => {
  const home = makeHome();
  appendLedgerEntry(home, makeEntry({ findingId: "F-A" }));
  appendLedgerEntry(home, makeEntry({ findingId: "F-A", appliedAt: "2026-10-31T10:00:00.000Z" }));
  assert.equal(
    recordVerification(home, "F-A", { verifiedAt: "2026-11-01T08:00:00.000Z", state: "outcome-supported" }),
    true
  );
  const entries = readLedger(home);
  assert.equal(entries.length, 2);
  // 最近一条（appliedAt 10-31）被回填
  assert.equal(entries[1].verification?.state, "outcome-supported");
  assert.equal(entries[0].verification, undefined);
  // 再回填：只剩未验证的 F-A（第一条）会被匹配
  assert.equal(recordVerification(home, "F-A", { verifiedAt: "2026-11-01T09:00:00.000Z", state: "partial" }), true);
  assert.equal(readLedger(home)[0].verification?.state, "partial");
  // 无匹配
  assert.equal(recordVerification(home, "F-NONE", { verifiedAt: "x", state: "blocked" }), false);
});

// ============================================================================
// 2. 确定性渲染
// ============================================================================

const BASE_INPUT: AuditReportInput = {
  generatedAt: "2026-11-01T08:00:00.000Z",
  evidenceWindow: "2026-10-25 ~ 2026-11-01（7 天）",
  ruleEvidence: [
    { ruleId: "USER-002", evidenceState: "wired", usageCount: 3, violationCount: 0 },
    { ruleId: "USER-001", evidenceState: "exercised", usageCount: 5, violationCount: 2 },
  ],
  loopSuggestions: [
    {
      id: "s1",
      fingerprint: "a".repeat(64),
      sequence: ["bash:npm", "edit"],
      occurrences: 3,
      distinctSessions: 3,
      coverageLadder: "extend",
      matchedAsset: "npm-build-checklist",
      rationale: "重复出现 3 次，可扩展现有资产",
    },
  ],
  ledgerEntries: [
    makeEntry({
      findingId: "F-DEPLOY",
      verification: { verifiedAt: "2026-11-01T07:00:00.000Z", state: "outcome-supported", note: "构建轮次 6→2" },
    }),
  ],
  llmSummary: "本窗口规则使用证据充分，建议优先扩展 npm-build-checklist。",
};

test("T7: 确定性——同输入两次渲染字节级一致；排序稳定（输入顺序无关）", () => {
  const r1 = renderAuditReport(BASE_INPUT);
  const r2 = renderAuditReport(BASE_INPUT);
  assert.equal(r1, r2);
  // 规则证据乱序输入 → 输出仍按 ruleId 排序，结果一致
  const shuffled: AuditReportInput = {
    ...BASE_INPUT,
    ruleEvidence: [...(BASE_INPUT.ruleEvidence ?? [])].reverse(),
    ledgerEntries: [...(BASE_INPUT.ledgerEntries ?? [])],
  };
  assert.equal(renderAuditReport(shuffled), r1);
  assert.ok(validateAuditReport(r1));
});

test("T8: 必备章节校验——renderAuditReport 产物必过 validateAuditReport", () => {
  const report = renderAuditReport({ generatedAt: "t", evidenceWindow: "w" });
  assert.ok(validateAuditReport(report));
  assert.equal(validateAuditReport("# 残缺报告"), false);
});

test("T9: 空态——无数据时各章节渲染占位而非崩溃", () => {
  const report = renderAuditReport({ generatedAt: "2026-11-01T08:00:00.000Z", evidenceWindow: "空窗" });
  assert.ok(report.includes("_（本窗口无规则使用证据）_"));
  assert.ok(report.includes("_（窗口内未发现跨会话重复工作流）_"));
  assert.ok(report.includes("_（暂无干预记录）_"));
  // 无 LLM 结论时不渲染结论章节
  assert.ok(!report.includes("## 结论"));
});

test("T10: Outcome-supported 追溯行——引用 findingId 与 appliedAt（验收）", () => {
  const report = renderAuditReport(BASE_INPUT);
  assert.ok(report.includes("追溯：verification=outcome-supported"));
  assert.ok(report.includes("findingId F-DEPLOY"));
  assert.ok(report.includes("appliedAt 2026-10-30T10:00:00.000Z"));
  // 非 outcome-supported 只渲染普通回访行，无追溯行
  const partial = renderAuditReport({
    ...BASE_INPUT,
    ledgerEntries: [makeEntry({ findingId: "F-P", verification: { verifiedAt: "t2", state: "partial" } })],
  });
  assert.ok(!partial.includes("追溯："));
  assert.ok(partial.includes("回访：partial"));
});
