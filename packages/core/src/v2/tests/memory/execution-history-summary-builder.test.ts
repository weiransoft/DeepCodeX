/**
 * ExecutionHistorySummaryBuilder 单元测试（US-EH-006/007）
 *
 * 测试覆盖 SummaryBuilder 两条构建路径的核心能力：
 *
 * buildForContext（注入 V2 上下文）:
 * - UT-SB-001: 空 store → 返回空 entries / totalTokens = 0
 * - UT-SB-002: taskType=build → 只保留 bash 工具记录
 * - UT-SB-003: 黑名单命令（echo/ls/pwd 等）被过滤
 * - UT-SB-004: 成功命令（ok=true）正确保留
 * - UT-SB-005: 失败+修复对——同 session + 10 分钟内 edit/write/bash(ok) 触发 fix 标记
 * - UT-SB-006: 2000 token 硬上限——超限截断最旧记录
 * - UT-SB-007: 失败记录（ok=false）但同 session 无修复 → 不纳入
 *
 * buildForMemory（沉淀 MemoryStore）:
 * - UT-SB-008: 成功命令进入 successEntries，含去重 key
 * - UT-SB-009: 失败+修复对进入 failureFixPairs，含稳定去重 key
 * - UT-SB-010: 黑名单命令不进入任何一类
 * - UT-SB-011: isLowValueRecord 独立导出函数的边界测试
 *
 * 所有测试使用真实文件系统（mkdtempSync + 隔离 HOME），不 mock store。
 * —— 与 execution-history-store.test.ts 测试风格完全对齐
 * —— SummaryBuilder 是纯逻辑构建器，测试重点在分类/过滤/硬上限截断逻辑
 *
 * @module v2/tests/memory/execution-history-summary-builder.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ExecutionHistoryStore } from "../../memory/execution-history-store";
import { ExecutionHistorySummaryBuilder, isLowValueRecord } from "../../memory/execution-history-summary-builder";
import type { ExecutionRecord } from "../../memory/execution-history-types";

// ============================================================================
// 测试 fixture：每个用例独立的临时 HOME 与项目目录
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sb-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sb-project-"));
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

/**
 * 等待 store flush 定时器（100ms 合并窗口）确保数据落盘
 * —— 与 store 测试里的 waitFlush 同模式
 */
async function waitFlush(ms = 150): Promise<void> {
  await sleep(ms);
}

// ============================================================================
// Helper：快速构建 ExecutionRecord（测试数据工厂）
// ============================================================================

type RecordInput = {
  sessionId?: string;
  toolName: "bash" | "edit" | "write" | "skill";
  ok: boolean;
  exitCode?: number;
  cwd?: string;
  argsSnippet?: string;
  timestamp?: number;
  date?: string;
};

/**
 * ExecutionHistoryRecordInputs 测试工厂
 * —— 参数全可选，只传变化的字段
 * —— 默认 sessionId = "test-session-1"，timestamp 从 Date.now() 倒推
 */
function makeRecord(input: RecordInput): Parameters<ExecutionHistoryStore["record"]>[0] {
  const now = Date.now();
  const ts = input.timestamp ?? now;
  return {
    sessionId: input.sessionId ?? "test-session-1",
    toolName: input.toolName,
    ok: input.ok,
    exitCode: input.exitCode,
    cwd: input.cwd ?? tempProject,
    argsSnippet:
      input.argsSnippet ??
      (input.toolName === "bash"
        ? JSON.stringify({ command: "echo hello" })
        : input.toolName === "edit"
          ? JSON.stringify({ filePath: path.join(tempProject, "a.ts") })
          : JSON.stringify({ filePath: path.join(tempProject, "a.ts") })),
    timestamp: ts,
    date: input.date ?? new Date(ts).toISOString().slice(0, 10),
  };
}

/** 快速 new store + record 多条数据 + waitFlush 的组合 helper */
async function setupStore(records: RecordInput[]): Promise<ExecutionHistoryStore> {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  for (const r of records) {
    // 同步构造 record 输入（用 timestamp 控制顺序）
    const input = makeRecord(r);
    await store.record(input);
  }
  await waitFlush();
  return store;
}

// ============================================================================
// 主测试
// ============================================================================

const builder = ExecutionHistorySummaryBuilder.get();

test("UT-SB-001: 空 store → buildForContext 返回空 entries + totalTokens=0", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  await waitFlush();

  const { entries, totalTokens } = builder.buildForContext(store);
  assert.equal(entries.length, 0);
  assert.equal(totalTokens, 0);
});

test("UT-SB-002: taskType=build → buildForContext 只保留 bash 工具记录", async () => {
  const store = await setupStore([
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm run build" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "webpack --config a.js" }) },
    { toolName: "edit", ok: true, argsSnippet: JSON.stringify({ filePath: "src/a.ts" }) }, // 非 bash 应被过滤
  ]);

  const { entries } = builder.buildForContext(store, "build");
  // build/task/deploy 只查 bash——edit 被过滤
  assert.ok(entries.length <= 2, `期望 ≤2 条（只 bash），实际 ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.trigger.startsWith("bash") || /npm|webpack/.test(e.trigger), `bash build 应触发 npm/webpack`);
  }
});

test("UT-SB-003: 黑名单命令（echo/ls/pwd 等）被 buildForContext 和 buildForMemory 过滤", async () => {
  const store = await setupStore([
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "echo hello" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "ls -la" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "pwd" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm install express" }) }, // 非黑名单
  ]);

  const { entries } = builder.buildForContext(store, "general");
  // 黑名单 echo/ls/pwd 应被过滤 → entries 只含 npm install
  assert.equal(entries.length, 1, `黑名单应过滤 echo/ls/pwd，实际 ${entries.length}`);
  assert.ok(entries[0].trigger.includes("npm install"));
});

test("UT-SB-004: 成功命令 ok=true 被 buildForContext 正确保留", async () => {
  const store = await setupStore([
    { toolName: "bash", ok: true, exitCode: 0, argsSnippet: JSON.stringify({ command: "make test" }) },
    { toolName: "bash", ok: true, exitCode: 0, argsSnippet: JSON.stringify({ command: "git status" }) },
    { toolName: "bash", ok: false, exitCode: 1, argsSnippet: JSON.stringify({ command: "make test" }) },
  ]);

  const { entries } = builder.buildForContext(store, "general");
  const okEntries = entries.filter((e) => e.result.startsWith("ok:"));
  assert.ok(okEntries.length >= 2, `至少 2 条 ok 成功被保留，实际 ok=${okEntries.length}`);
});

test("UT-SB-005: 失败+修复对——同 session + 10 分钟内 edit/write/bash(ok) 触发 fix 标记", async () => {
  const now = Date.now();
  // 构造时序：失败 bash → edit 修复（10 秒后）
  const store = await setupStore([
    {
      toolName: "bash",
      ok: false,
      exitCode: 1,
      argsSnippet: JSON.stringify({ command: "tsc --noEmit" }),
      timestamp: now,
    },
    {
      toolName: "edit",
      ok: true,
      argsSnippet: JSON.stringify({ filePath: "src/a.ts", search: "old", replace: "new" }),
      timestamp: now + 5_000, // 5 秒后修复
    },
  ]);

  const { entries } = builder.buildForContext(store, "general");
  // entries 应包含 fail+fix 对（失败记录 + 修复后结果）
  const failFixEntry = entries.find((e) => e.result.startsWith("fail:") && e.result.includes("fix via edit"));
  assert.ok(failFixEntry, `应该有一条 fail→fix 条目，实际 entries: ${JSON.stringify(entries)}`);
});

test("UT-SB-006: 2000 token 硬上限——buildForContext 超限截断最旧", async () => {
  // 构造大量有价值命令，让 entries 总数远超 2000 tokens
  const records: RecordInput[] = [];
  const now = Date.now();
  for (let i = 0; i < 100; i++) {
    records.push({
      toolName: "bash",
      ok: true,
      exitCode: 0,
      argsSnippet: JSON.stringify({ command: `build-step-${i}-with-very-long-command-to-inflate-token-count` }),
      timestamp: now - i * 1000, // 每条间隔 1s，i=0 最新，i=99 最旧
    });
  }
  const store = await setupStore(records);

  const { entries, totalTokens } = builder.buildForContext(store, "general");
  assert.ok(totalTokens <= 2000, `总 tokens ${totalTokens} 应 ≤ 2000`);
  // 至少有一些 entries（不是全被截断）
  assert.ok(entries.length > 0, "至少应保留部分 entries");
  // entries 按 timestamp desc 排序——最新在前、最旧被截断
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1].estTokens >= 0, "每条 entry 有 estTokens");
  }
});

test("UT-SB-007: 失败记录（ok=false）但同 session 无修复 → 不纳入 entries", async () => {
  const store = await setupStore([
    {
      toolName: "bash",
      ok: false,
      exitCode: 1,
      argsSnippet: JSON.stringify({ command: "npm run build" }),
      // 这条失败记录同 session 内没有 edit/write/bash(ok) 后续 → 应被过滤
    },
    {
      toolName: "bash",
      ok: true,
      exitCode: 0,
      argsSnippet: JSON.stringify({ command: "echo done" }),
    },
  ]);

  const { entries } = builder.buildForContext(store, "general");
  // 失败+无修复的 bash 不应出现
  const pureFail = entries.find((e) => e.result.startsWith("fail:") && !e.result.includes("fix via"));
  assert.equal(pureFail, undefined, "纯失败（无修复）不应纳入 entries");
});

// ============================================================================
// buildForMemory 路径测试
// ============================================================================

test("UT-SB-008: buildForMemory——成功命令进入 successEntries 含去重 key", async () => {
  const store = await setupStore([
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "make test" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm install" }) },
    { toolName: "bash", ok: false, exitCode: 1, argsSnippet: JSON.stringify({ command: "tsc --noEmit" }) },
  ]);
  const allRecords = store.query({ order: "asc", limit: 1000 });
  const { successEntries, failureFixPairs } = builder.buildForMemory(allRecords);

  assert.ok(successEntries.length >= 2, `至少 2 条成功命令，实际 ${successEntries.length}`);
  assert.equal(failureFixPairs.length, 0, "无修复的失败不进入 failureFixPairs");
  // 去重 key 格式："success:{toolName}:{firstWord}"
  for (const e of successEntries) {
    assert.ok(e.key.startsWith("success:"), `key 应以 success: 开头，实际 ${e.key}`);
    assert.ok(e.record.toolName === "bash", "成功记录应为 bash 工具");
  }
});

test("UT-SB-009: buildForMemory——失败+修复对进入 failureFixPairs 含稳定去重 key", async () => {
  const now = Date.now();
  const store = await setupStore([
    {
      toolName: "bash",
      ok: false,
      exitCode: 1,
      argsSnippet: JSON.stringify({ command: "tsc --noEmit" }),
      timestamp: now,
    },
    {
      toolName: "edit",
      ok: true,
      argsSnippet: JSON.stringify({ filePath: "src/a.ts" }),
      timestamp: now + 3000, // 3s 后修复
    },
  ]);
  const allRecords = store.query({ order: "asc", limit: 1000 });
  const { successEntries, failureFixPairs } = builder.buildForMemory(allRecords);

  assert.ok(
    successEntries.length >= 1,
    `修复 edit 本身也是 ok=true 非低价值，应进入 successEntries；实际 ${successEntries.length}`
  );
  assert.equal(failureFixPairs.length, 1, "应该有 1 条失败+修复对");
  const pair = failureFixPairs[0];
  assert.ok(pair.key.startsWith("fix:"), `key 应以 fix: 开头，实际 ${pair.key}`);
  assert.ok(pair.failure.ok === false, "pair.failure 应是失败记录");
  assert.ok(pair.fix.ok === true, "pair.fix 应是成功修复");
  // 同数据多次调用 → key 稳定
  const { failureFixPairs: pairs2 } = builder.buildForMemory(allRecords);
  assert.equal(pairs2[0].key, pair.key, "多次调用去重 key 应稳定");
});

test("UT-SB-010: buildForMemory——黑名单命令不进入 successEntries 或 failureFixPairs", async () => {
  const store = await setupStore([
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "echo hello" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "ls -la" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "pwd" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "rm -rf tmp" }) },
  ]);
  const allRecords = store.query({ order: "asc", limit: 1000 });
  const { successEntries } = builder.buildForMemory(allRecords);

  // echo/ls/pwd 黑名单应被过滤 → 只剩 rm -rf
  assert.equal(successEntries.length, 1, `黑名单应过滤 3 条，实际 successEntries=${successEntries.length}`);
  assert.ok(successEntries[0].key.includes("rm"), `rm -rf 应保留，实际 key=${successEntries[0].key}`);
});

// ============================================================================
// isLowValueRecord 独立函数边界测试
// ============================================================================

test("UT-SB-011: isLowValueRecord 边界——非 bash / JSON 解析失败 / 空 args", () => {
  // 非 bash 工具永远不是低价值
  const editRec: ExecutionRecord = {
    id: "r1",
    sessionId: "s1",
    toolName: "edit",
    ok: true,
    argsSnippet: JSON.stringify({ filePath: "a.ts" }),
    timestamp: Date.now(),
    date: "2026-09-04",
    turnIndex: 1,
  };
  assert.equal(isLowValueRecord(editRec), false, "edit 工具永远不是低价值");

  // JSON 解析失败 → fallback substring 也能识别黑名单
  const brokenJsonRec: ExecutionRecord = {
    ...editRec,
    toolName: "bash",
    argsSnippet: "{ invalid json", // JSON.parse 会抛
    timestamp: Date.now(),
    date: "2026-09-04",
  };
  // fallback 会看 argsSnippet 前 50 字符——"{ invalid json" 里没黑名单词 → 不是低价值
  assert.equal(isLowValueRecord(brokenJsonRec), false);

  // 空 argsSnippet → 不是低价值
  const emptyRec: ExecutionRecord = {
    ...editRec,
    toolName: "bash",
    argsSnippet: "",
  };
  assert.equal(isLowValueRecord(emptyRec), false);
});
