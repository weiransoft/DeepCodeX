/**
 * T2/T4/T5 沉淀兜底 + raw 关联回填 + 沉淀结构化日志 集成测试
 *
 * 设计依据：docs/dev/eag-web-sedimentation-fixes.md §3
 * - FB-01：失败记录 + 修复记录 → syncSession → jsonl 重读后 failure 记录
 *   fixedByExecutionId === fix.id；成功与修复记录 memoryEntryIds 含对应 memory entry id
 * - LG-01：沉淀执行后 `<homeRoot>/.deepcodex/logs/sedimentation.log` 存在、
 *   每行合法 JSON、type 字段正确
 * - SD-01（sync 语义部分）：成功命令沉淀 → experience.json 出现条目；
 *   重复 sync 幂等（dedupKey 不新增条目、usageCount 递增）
 *
 * 说明：SessionManager.flushSedimentation 是对 store.closeSync + syncSession +
 * logSedimentEvent 的薄包装，其沉淀内核与 syncSession 共用同一实现
 * （session.ts syncSedimentationForSession），故本文件以 store + sync 组合直接
 * 验证内核语义；flush/finally/incremental 事件行由 session 层测试（LG-01 补充）
 * 与 disposeAll 链路（web 侧后续任务）覆盖。
 *
 * 所有测试使用真实文件系统（mkdtempSync + 隔离 HOME），不 mock。
 * —— 与 execution-history-memory-sync.test.ts 风格完全对齐
 *
 * @module v2/tests/memory/sedimentation-fixes.test
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
import type { ExecutionRecord } from "../../memory/execution-history-types";
import { getSedimentLogPath, logSedimentEvent } from "../../../common/sediment-logger";

// ============================================================================
// Fixture：隔离 HOME + 项目目录
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sediment-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sediment-project-"));
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

/** 等待 store 的 100ms pending flush 合并窗口过去 */
async function waitFlush(ms = 200): Promise<void> {
  await sleep(ms);
}

/** 从文件逐行读取全量执行记录（绕开任何 store 实例缓存） */
function readJsonlRecords(filePath: string): ExecutionRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExecutionRecord);
}

/** 读取 sedimentation.log 并逐行解析（每行必须合法 JSON，解析失败即测试失败） */
function readSedimentLogLines(homeRoot: string): Array<Record<string, unknown>> {
  const logPath = getSedimentLogPath(homeRoot);
  assert.ok(fs.existsSync(logPath), `sedimentation.log 应存在于 ${logPath}`);
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ============================================================================
// FB-01：失败+修复对 → syncSession → raw jsonl 回填 fixedByExecutionId/memoryEntryIds
// ============================================================================
test("FB-01: syncSession 后 jsonl 中 failure 记录 fixedByExecutionId=fix.id，双侧 memoryEntryIds 写入", async () => {
  const sessionId = "sess-fb01";
  const now = Date.now();
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // 失败记录（tsc 报错）+ 10 分钟窗口内的修复记录（edit 改文件）
  await store.record({
    sessionId,
    toolName: "bash",
    ok: false,
    exitCode: 1,
    argsSnippet: JSON.stringify({ command: "tsc --noEmit" }),
    errorSnippet: "TS2345: Argument of type 'string' is not assignable",
    cwd: tempProject,
    timestamp: now,
  });
  await store.record({
    sessionId,
    toolName: "edit",
    ok: true,
    argsSnippet: JSON.stringify({ filePath: "src/a.ts" }),
    cwd: tempProject,
    timestamp: now + 5000,
  });
  await waitFlush();

  // 记录 id（在 patch 之前拿——patch 只改字段不改 id）
  const before = readJsonlRecords(store.getHistoryFilePath());
  const failRec = before.find((r) => !r.ok);
  const fixRec = before.find((r) => r.ok);
  assert.ok(failRec && fixRec, "应有 1 条失败 + 1 条修复记录");
  // 前置条件：record() 从不写二期字段
  assert.equal(failRec!.fixedByExecutionId, undefined, "sync 前 raw 记录不应有 fixedByExecutionId");

  const memoryStore = new MemoryStore(tempProject, tempHome);
  const sync = new ExecutionHistoryMemorySync(store, memoryStore);
  const stats = sync.syncSession(sessionId);
  assert.equal(stats.failureFixCount, 1, "应沉淀 1 条失败+修复对");
  assert.equal(stats.linkedCount, 2, "应回填 2 条 raw 记录（failure + fix）");

  // 新 store 从文件重读（绕开缓存）：验证原子重写持久化
  const after = readJsonlRecords(store.getHistoryFilePath());
  assert.equal(after.length, 2, "重写后文件仍应恰有 2 条记录");
  const afterFail = after.find((r) => r.id === failRec!.id)!;
  const afterFix = after.find((r) => r.id === fixRec!.id)!;
  assert.equal(afterFail.fixedByExecutionId, fixRec!.id, "failure 记录 fixedByExecutionId 应为 fix.id");

  // memoryEntryIds 应含对应 memory entry id（与 MemoryStore 中 failure-fix experience 对齐）
  const fixExp = memoryStore
    .list("experience")
    .entries.find((e) => Array.isArray(e.tags) && e.tags.includes("failure-fix"));
  assert.ok(fixExp, "应有 failure-fix experience");
  assert.ok(
    Array.isArray(afterFail.memoryEntryIds) && afterFail.memoryEntryIds!.includes(fixExp!.id),
    "failure 记录 memoryEntryIds 应含 memory entry id"
  );
  assert.ok(
    Array.isArray(afterFix.memoryEntryIds) && afterFix.memoryEntryIds!.includes(fixExp!.id),
    "fix 记录 memoryEntryIds 应含 memory entry id"
  );
  assert.equal(afterFix.fixedByExecutionId, undefined, "fix 记录不应写 fixedByExecutionId");
});

// ============================================================================
// SD-01（sync 内核语义）：成功命令沉淀 + 重复 sync 幂等
// ============================================================================
test("SD-01: 成功命令 sync → experience.json 出现条目；重复 sync dedupKey 幂等 usageCount 递增", async () => {
  const sessionId = "sess-sd01";
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  await store.record({
    sessionId,
    toolName: "bash",
    ok: true,
    exitCode: 0,
    argsSnippet: JSON.stringify({ command: "npm test" }),
    cwd: tempProject,
  });
  await waitFlush();

  const memoryStore = new MemoryStore(tempProject, tempHome);
  const sync = new ExecutionHistoryMemorySync(store, memoryStore);

  const stats1 = sync.syncSession(sessionId);
  assert.ok(stats1.successCount >= 1, `首次 sync 应沉淀至少 1 条成功命令，实际 ${stats1.successCount}`);

  // experience.json 落盘（MemoryStore experience 持久化路径）且含条目
  const experiencePath = path.join(tempHome, ".deepcode", "memory", "experience.json");
  assert.ok(fs.existsSync(experiencePath), "experience.json 应存在");
  const experienceData = JSON.parse(fs.readFileSync(experiencePath, "utf8"));
  assert.ok(
    Array.isArray(experienceData.entries) && experienceData.entries.length >= 1,
    "experience.json 应含至少 1 条沉淀条目"
  );

  // 重复 sync：dedupKey 幂等 → 条目数不增，usageCount 递增
  const entriesAfter1 = memoryStore.list("experience").entries;
  const usage1 = (entriesAfter1[0].metadata?.usageCount as number) ?? 0;
  const stats2 = sync.syncSession(sessionId);
  const entriesAfter2 = memoryStore.list("experience").entries;
  assert.equal(entriesAfter2.length, entriesAfter1.length, "重复 sync 不应新增 dedupKey 条目");
  const usage2 = (entriesAfter2[0].metadata?.usageCount as number) ?? 0;
  assert.ok(usage2 > usage1, `重复 sync usageCount 应递增（${usage1} → ${usage2}）`);
  assert.ok(stats2.successCount >= 1, "重复 sync 的 upsert 仍计入 successCount（更新语义）");
});

// ============================================================================
// LG-01：沉淀执行后经 logSedimentEvent 写 sedimentation.log（JSONL / type 正确）
// ============================================================================
test("LG-01: 沉淀事件后 sedimentation.log 存在、每行合法 JSON、type 字段正确", () => {
  logSedimentEvent(tempHome, {
    type: "sync",
    sessionId: "sess-lg01",
    successCount: 2,
    failureFixCount: 1,
    linkedRecords: 3,
  });
  logSedimentEvent(tempHome, {
    type: "flush",
    sessionId: "sess-lg01",
    successCount: 0,
    failureFixCount: 0,
    linkedRecords: 0,
  });
  logSedimentEvent(tempHome, { type: "degrade", sessionId: "sess-lg01", error: "simulated sediment failure" });

  const lines = readSedimentLogLines(tempHome);
  assert.equal(lines.length, 3, "应写入 3 行事件");
  for (const line of lines) {
    assert.equal(typeof line.ts, "string", "每行应携带 ISO 时间戳 ts");
    assert.equal(typeof line.type, "string", "每行应携带事件类型 type");
    assert.equal(line.sessionId, "sess-lg01", "每行应关联 sessionId");
  }
  assert.deepEqual(
    lines.map((l) => l.type),
    ["sync", "flush", "degrade"],
    "type 字段应与写入顺序一致"
  );
  // 观察字段透传
  assert.equal(lines[0].successCount, 2, "sync 事件应携带 successCount");
  assert.equal(lines[0].linkedRecords, 3, "sync 事件应携带 linkedRecords（T4 回填数）");
  assert.equal(lines[2].error, "simulated sediment failure", "degrade 事件应携带 error 原文");
});

// ============================================================================
// SD-01b：pending 未 flush 时经 closeSync（flushSedimentation 第一步同语义）后 sync 可见
// ============================================================================
test("SD-01b: record 后立即 closeSync，syncSession 可见 pending 数据并沉淀", async () => {
  const sessionId = "sess-sd01b";
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  await store.record({
    sessionId,
    toolName: "bash",
    ok: true,
    exitCode: 0,
    argsSnippet: JSON.stringify({ command: "pnpm build" }),
    cwd: tempProject,
  });
  // 不等 100ms 定时器——直接 closeSync 同步落盘（flushSedimentation 的第一步）
  store.closeSync();

  // 新实例从文件重读，验证 pending 已持久化
  const persisted = readJsonlRecords(store.getHistoryFilePath());
  assert.equal(persisted.length, 1, "closeSync 后 pending 记录应已落盘");

  const memoryStore = new MemoryStore(tempProject, tempHome);
  const sync = new ExecutionHistoryMemorySync(store, memoryStore);
  const stats = sync.syncSession(sessionId);
  assert.ok(stats.successCount >= 1, "closeSync 后 sync 应沉淀 pending 数据");
});
