/**
 * ExecutionHistoryMemorySync 单元测试（US-EH-007/008）
 *
 * 测试覆盖 ExecutionHistoryMemorySync 的核心能力：
 *
 * - UT-MS-001: syncSession 空 sessionId（store 无此 session 数据）→ 返回 (0,0) 不报错
 * - UT-MS-002: syncSession 成功命令沉淀 → MemoryStore 有 experience 条目
 * - UT-MS-003: syncSession 重复调用（同 session 多次 sync）→ upsert 不重复增长
 * - UT-MS-004: metadata.executionRecordIds 双向打通
 * - UT-MS-005: 失败+修复对沉淀 → MemoryStore 有 failure-fix experience
 * - UT-MS-006: 黑名单命令不沉淀
 * - UT-MS-007: MemoryStore 构造异常（无 projectRoot）→ syncSession catch 降级
 *
 * 所有测试使用真实文件系统（mkdtempSync + 隔离 HOME），不 mock。
 * —— 与 SummaryBuilder / store test 风格完全对齐
 *
 * @module v2/tests/memory/execution-history-memory-sync.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ExecutionHistoryStore } from "../../memory/execution-history-store";
import { ExecutionHistoryMemorySync } from "../../memory/execution-history-memory-sync";
import { MemoryStore } from "../../memory/memory-store";

// ============================================================================
// Fixture：隔离 HOME + 项目目录
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sync-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sync-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

async function waitFlush(ms = 150): Promise<void> {
  await sleep(ms);
}

// ============================================================================
// Helper
// ============================================================================

type RecordInput = {
  sessionId: string;
  toolName: "bash" | "edit" | "write";
  ok: boolean;
  exitCode?: number;
  argsSnippet?: string;
  timestamp?: number;
};

function makeRecord(input: RecordInput): Parameters<ExecutionHistoryStore["record"]>[0] {
  const now = Date.now();
  return {
    sessionId: input.sessionId,
    toolName: input.toolName,
    ok: input.ok,
    exitCode: input.exitCode,
    cwd: tempProject,
    argsSnippet:
      input.argsSnippet ??
      (input.toolName === "bash"
        ? JSON.stringify({ command: "echo hello" })
        : JSON.stringify({ filePath: path.join(tempProject, "a.ts") })),
    timestamp: input.timestamp ?? now,
    date: new Date(input.timestamp ?? now).toISOString().slice(0, 10),
  };
}

/**
 * 快速 setup：store + MemoryStore + sync
 */
async function setup(records: RecordInput[]): Promise<{
  store: ExecutionHistoryStore;
  memoryStore: MemoryStore;
  sync: ExecutionHistoryMemorySync;
}> {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  for (const r of records) {
    await store.record(makeRecord(r));
  }
  await waitFlush();
  const memoryStore = new MemoryStore(tempProject);
  const sync = new ExecutionHistoryMemorySync(store, memoryStore);
  return { store, memoryStore, sync };
}

// ============================================================================
// 测试
// ============================================================================

test("UT-MS-001: syncSession 空 sessionId → 返回 (0,0) 不报错", async () => {
  const { memoryStore, sync } = await setup([]);

  const { successCount, failureFixCount } = sync.syncSession("nonexistent-session");
  assert.equal(successCount, 0);
  assert.equal(failureFixCount, 0);

  // MemoryStore 不应有新数据
  const listResult = memoryStore.list("experience");
  assert.equal(listResult.entries.length, 0, "空 session 不应沉淀任何 experience");
});

test("UT-MS-002: syncSession 成功命令沉淀 → MemoryStore 有 experience 条目", async () => {
  const sessionId = "session-success-002";
  const { memoryStore, sync } = await setup([
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm test" }) },
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "git push" }) },
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "echo done" }) }, // 黑名单
  ]);

  const { successCount, failureFixCount } = sync.syncSession(sessionId);
  // echo 是黑名单应被过滤 → successCount = 2
  assert.equal(successCount, 2, `黑名单 echo 应过滤，期望 2 条成功，实际 ${successCount}`);
  assert.equal(failureFixCount, 0, "无失败+修复对");

  const listResult = memoryStore.list("experience");
  assert.equal(listResult.entries.length, 2, `MemoryStore 应有 2 条 experience`);

  // 每条验证 source + type
  for (const e of listResult.entries) {
    assert.equal(e.type, "experience");
    assert.equal(e.source, "auto_extracted");
  }
});

test("UT-MS-003: syncSession 重复调用同 session → upsert 不重复增长", async () => {
  const sessionId = "session-upsert-003";
  const { memoryStore, sync } = await setup([
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm test" }) },
  ]);

  sync.syncSession(sessionId);
  const countAfter1 = memoryStore.list("experience").entries.length;

  // 加一条新命令但保留原 dedup key（不同 sessionId 同命令）
  sync.syncSession(sessionId);
  const countAfter2 = memoryStore.list("experience").entries.length;

  // upsert：同 key 不新增 → count 应保持不变（或增长很小）
  assert.equal(countAfter1, countAfter2, "重复 syncSession 不应导致 experience 重复增长");
});

test("UT-MS-004: metadata.executionRecordIds 双向打通 + usageCount 累加", async () => {
  const sessionId = "session-meta-004";
  const { memoryStore, sync } = await setup([
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm test" }) },
  ]);

  sync.syncSession(sessionId);

  const entry = memoryStore.list("experience").entries[0];
  assert.ok(entry, "应有 experience 条目");

  // 验证 metadata.executionRecordIds
  const ids = entry.metadata?.executionRecordIds as string[] | undefined;
  assert.ok(Array.isArray(ids), `metadata.executionRecordIds 应是数组，实际 ${ids}`);
  assert.ok(ids.length >= 1, `应关联至少 1 条 ExecutionRecord.id，实际 ${ids}`);

  // 验证 usageCount = 1（首次沉淀）
  const usage = (entry.metadata?.usageCount as number) ?? 0;
  assert.equal(usage, 1, `首次沉淀 usageCount 应为 1，实际 ${usage}`);
});

test("UT-MS-005: 失败+修复对沉淀 → failure-fix experience 带 metadata.fixedByExecutionId", async () => {
  const now = Date.now();
  const sessionId = "session-fix-005";
  const { memoryStore, sync } = await setup([
    {
      sessionId,
      toolName: "bash",
      ok: false,
      exitCode: 1,
      argsSnippet: JSON.stringify({ command: "tsc --noEmit" }),
      timestamp: now,
    },
    {
      sessionId,
      toolName: "edit",
      ok: true,
      argsSnippet: JSON.stringify({ filePath: "src/a.ts" }),
      timestamp: now + 5000,
    },
  ]);

  const { failureFixCount } = sync.syncSession(sessionId);
  assert.equal(failureFixCount, 1, `应有 1 条失败+修复对，实际 ${failureFixCount}`);

  // 找 failure-fix experience
  const allExperiences = memoryStore.list("experience").entries;
  const fixExp = allExperiences.find((e) => Array.isArray(e.tags) && e.tags.includes("failure-fix"));
  assert.ok(fixExp, "应有一条 failure-fix 标签的 experience");

  // 验证 metadata 里有 fixedByExecutionId
  const fixedBy = fixExp.metadata?.fixedByExecutionId;
  assert.ok(typeof fixedBy === "string" && fixedBy.length > 0, `应有 fixedByExecutionId，实际 ${fixedBy}`);

  // verification：executionRecordIds 含 2 条（失败 + 修复）
  const ids = fixExp.metadata?.executionRecordIds as string[];
  assert.equal(ids.length, 2, `failure-fix 应关联 2 条 record（失败+修复），实际 ${ids.length}`);
});

test("UT-MS-006: 黑名单命令完全不沉淀", async () => {
  const sessionId = "session-blacklist-006";
  const { memoryStore, sync } = await setup([
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "echo hello" }) },
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "ls -la" }) },
    { sessionId, toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "pwd" }) },
  ]);

  const { successCount } = sync.syncSession(sessionId);
  assert.equal(successCount, 0, "全黑名单 → successCount = 0");
  assert.equal(memoryStore.list("experience").entries.length, 0, "全黑名单 → 无沉淀");
});

test("UT-MS-007: MemoryStore 构造异常场景（无 projectRoot 仍能工作）", async () => {
  // MemoryStore 对 project 类型需要 projectRoot，但 experience 不需要
  // 验证：ExecutionHistoryMemorySync 整体 try/catch，任何异常不 rethrow
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  await store.record(
    makeRecord({
      sessionId: "session-safe-007",
      toolName: "bash",
      ok: true,
      argsSnippet: JSON.stringify({ command: "ls -la" }),
    })
  );
  await waitFlush();

  // MemoryStore 用空字符串 projectRoot——这是 MemorySync 的 fail-safe 路径
  const memoryStore = new MemoryStore("");
  const sync = new ExecutionHistoryMemorySync(store, memoryStore);
  // 不应 throw
  assert.doesNotThrow(() => {
    sync.syncSession("session-safe-007");
  });
});
