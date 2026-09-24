/**
 * ExecutionHistoryStore.patchRecordLinks 单元测试（T4，FB-01 语义分解）
 *
 * 设计依据：docs/dev/eag-web-sedimentation-fixes.md §2.4 / §3 FB-01
 * 覆盖能力：
 * - UT-PRL-001: 不存在 id 静默跳过 → 返回 0，文件不被重写
 * - UT-PRL-002: 命中字段合并——只设传入字段（memoryEntryIds / fixedByExecutionId），
 *   未传字段保持原值；重写后新 store 实例从文件重读可见回填结果
 * - UT-PRL-003: 与 pending flush 并发前提——缓存未加载 + pending 未落盘时直接
 *   patch：pending 记录回缓存、patch 命中、同步落盘后文件既不丢 pending 记录
 *   也无重复行，且回填字段持久化
 *
 * 所有测试使用真实文件系统（mkdtempSync + 隔离 HOME），不 mock。
 * —— 与 execution-history-store.test.ts 风格完全对齐
 *
 * @module v2/tests/memory/execution-history-patch-links.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ExecutionHistoryStore } from "../../memory/execution-history-store";
import type { ExecutionRecord } from "../../memory/execution-history-types";

// ============================================================================
// Fixture：隔离 HOME + 项目目录（与 execution-history-store.test.ts 同构）
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-patch-links-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-patch-links-project-"));
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

/** 等待 store 的 100ms pending flush 合并窗口过去（数据确定已落盘） */
async function waitFlush(ms = 200): Promise<void> {
  await sleep(ms);
}

/** 从文件逐行读取全量记录（新 store 实例不碰，直接读原始 jsonl） */
function readJsonlRecords(filePath: string): ExecutionRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExecutionRecord);
}

/**
 * 写一条最小记录并返回其 id
 * —— id 从落盘文件读取（不经过 query）：query() 在缓存未加载时会先
 * loadFileToCache 清空缓存，与 record 先入缓存的行为存在既有交互，
 * 测试通过文件读取绕开该路径，只断言 patchRecordLinks 自身语义。
 */
async function recordOne(
  store: ExecutionHistoryStore,
  sessionId: string,
  opts: { toolName: string; ok: boolean; command?: string }
): Promise<string> {
  await store.record({
    sessionId,
    toolName: opts.toolName,
    ok: opts.ok,
    argsSnippet: JSON.stringify({ command: opts.command ?? "npm test" }),
    exitCode: opts.ok ? 0 : 1,
    cwd: tempProject,
  });
  await waitFlush();
  const records = readJsonlRecords(store.getHistoryFilePath());
  const rec = records.find((r) => r.sessionId === sessionId && r.toolName === opts.toolName && r.ok === opts.ok);
  assert.ok(rec, "写入的记录应已落盘可查");
  return rec!.id;
}

// ============================================================================
// UT-PRL-001: 不存在 id → 静默跳过返回 0，文件不被重写
// ============================================================================
test("UT-PRL-001: patchRecordLinks 不存在 id 静默跳过 → 返回 0", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  const sessionId = "sess-prl-001";
  // recordOne 内部已等待 flush 落盘
  await recordOne(store, sessionId, { toolName: "bash", ok: true, command: "npm test" });

  // 全部 id 不存在 → 命中 0
  const hit = store.patchRecordLinks(sessionId, [{ id: "nonexistent-id", memoryEntryIds: ["m-1"] }]);
  assert.equal(hit, 0, "不存在的 id 应静默跳过并返回 0");

  // 空 patches → 0
  assert.equal(store.patchRecordLinks(sessionId, []), 0, "空 patches 列表应返回 0");

  // 不存在的 session → 0
  assert.equal(
    store.patchRecordLinks("other-session", [{ id: "whatever", memoryEntryIds: ["m-1"] }]),
    0,
    "session 无记录时应返回 0"
  );

  // 文件不应因 patch 失败被改动（回填字段仍缺省）
  const records = readJsonlRecords(store.getHistoryFilePath());
  assert.equal(records.length, 1, "文件仍应有 1 条记录");
  assert.equal(records[0].memoryEntryIds, undefined, "未命中时不应写 memoryEntryIds");
});

// ============================================================================
// UT-PRL-002: 命中字段合并 + 原子重写持久化
// ============================================================================
test("UT-PRL-002: patchRecordLinks 命中字段合并，只设传入字段且持久化", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  const sessionId = "sess-prl-002";
  const failId = await recordOne(store, sessionId, { toolName: "bash", ok: false, command: "tsc --noEmit" });
  const fixId = await recordOne(store, sessionId, { toolName: "edit", ok: true });
  await waitFlush();

  // patch 1：failure 记录写 fixedByExecutionId + memoryEntryIds
  // patch 2：fix 记录只写 memoryEntryIds（不传 fixedByExecutionId → 保持缺省）
  // patch 3：不存在的 id（混在有效 patch 中，不计入命中）
  const hit = store.patchRecordLinks(sessionId, [
    { id: failId, fixedByExecutionId: fixId, memoryEntryIds: ["mem-a"] },
    { id: fixId, memoryEntryIds: ["mem-a"] },
    { id: "ghost-id", memoryEntryIds: ["mem-x"] },
  ]);
  assert.equal(hit, 2, "两个有效 id 命中，ghost id 不计入命中数");

  // 新 store 实例从文件重读（绕开旧缓存），验证原子重写持久化
  const store2 = new ExecutionHistoryStore({ projectRoot: tempProject });
  const records = store2.query({ sessionId, order: "asc" });
  const failRec = records.find((r) => r.id === failId);
  const fixRec = records.find((r) => r.id === fixId);
  assert.ok(failRec && fixRec, "两条记录都应持久化在文件中");
  assert.equal(failRec!.fixedByExecutionId, fixId, "failure 记录 fixedByExecutionId 应为 fix.id");
  assert.deepEqual(failRec!.memoryEntryIds, ["mem-a"], "failure 记录应写 memoryEntryIds");
  assert.deepEqual(fixRec!.memoryEntryIds, ["mem-a"], "fix 记录应写 memoryEntryIds");
  assert.equal(fixRec!.fixedByExecutionId, undefined, "未传 fixedByExecutionId 时不应写字段");
});

// ============================================================================
// UT-PRL-003: 缓存未加载 + pending 未落盘时 patch（并发前提回归锁）
// ============================================================================
test("UT-PRL-003: 缓存未加载且 pending 未落盘时 patch → 不丢数据、无重复行、字段持久化", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  const sessionId = "sess-prl-003";

  // 先落一条已 flush 的记录
  await recordOne(store, sessionId, { toolName: "bash", ok: true, command: "npm run build" });
  await waitFlush();

  // 新建实例（缓存未加载）→ 直接 record（进 pending，100ms 定时器未触发）
  // → 立即 patchRecordLinks：query() 会触发 loadFileToCache（cache 清空后从文件
  // 重建，pending 记录被清出缓存——这是 patch 实现必须处理的窗口）
  const store2 = new ExecutionHistoryStore({ projectRoot: tempProject });
  await store2.record({
    sessionId,
    toolName: "bash",
    ok: true,
    argsSnippet: JSON.stringify({ command: "npx tsc" }),
    exitCode: 0,
    cwd: tempProject,
  });
  // 不走 query（避免提前触发 loadFileToCache 干扰验证路径），直接 patch：
  // 内部先 loadFileToCache + pending 回缓存。patch 目标用「已 flush 的那条记录」
  // 验证命中与持久化；pending 记录则通过重写后文件行数验证不丢、不重复。
  const flushedRecords = readJsonlRecords(store2.getHistoryFilePath());
  const flushedId = flushedRecords[0].id;

  const hit = store2.patchRecordLinks(sessionId, [{ id: flushedId, memoryEntryIds: ["mem-pending"] }]);
  assert.equal(hit, 1, "已 flush 记录应命中");

  // 等原 flush 定时器（已 patch 内清除）窗口过去，确认没有第二次 append
  await waitFlush();

  const finalRecords = readJsonlRecords(store2.getHistoryFilePath());
  assert.equal(finalRecords.length, 2, "文件应恰有 2 条记录（已 flush 1 条 + pending 1 条），无重复行");
  const patched = finalRecords.find((r) => r.id === flushedId);
  assert.deepEqual(patched?.memoryEntryIds, ["mem-pending"], "回填字段应持久化");
  const pendingCopy = finalRecords.find((r) => (r.argsSnippet ?? "").includes("npx tsc"));
  assert.ok(pendingCopy, "pending 记录应在重写后保留（不丢数据）");

  // 缓存事实源验证：patch 后 query 能同时看到两条
  const inCache = store2.query({ sessionId });
  assert.equal(inCache.length, 2, "缓存全集应含 pending 与已 flush 两条");
});
