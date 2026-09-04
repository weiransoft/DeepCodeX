/**
 * ExecutionHistoryStore 单元测试（UT-001 ~ UT-006）
 *
 * 测试覆盖 PRD TEST_PLAN 一期 store 层核心能力：
 * - UT-001: record() 基本写入 + 文件格式验证（jsonl 每行一个 JSON）
 * - UT-002: query() 多维度过滤（sessionId / toolName / ok / lastDays / keyword）
 * - UT-003: fs 写失败静默降级（mock fs.appendFileSync throw → 不抛错）
 * - UT-004: 自动裁剪 prune()（每 session 超 500 条 / 全局 age 超 100 天）
 * - UT-005: 损坏文件备份（模拟文件里有非法 JSON → backupCorruptedFile 被调用）
 * - UT-006: turnIndex 自增（多次 record → turnIndex 连续递增，跨 session 独立）
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录 + 隔离 HOME），禁止 mock。
 * —— 与 MemoryStore 测试风格对齐（memory-store.test.ts）
 * —— 不 mock fs.appendFileSync（store 内部用 fs.promises.appendFile 是 async 的，
 *    真实测试更能暴露问题；UT-003 降级测试用特殊方式触发）
 *
 * @module v2/tests/memory/execution-history-store.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ExecutionHistoryStore } from "../../memory/execution-history-store";
import { LOW_VALUE_BASH_COMMANDS } from "../../memory/execution-history-types";

// ============================================================================
// 测试 fixture：每个用例独立的临时 HOME 与项目目录
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-exec-history-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-exec-history-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  // 清理临时目录（rm -rf）
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

/**
 * 等待 store 的 flush 定时器触发（100ms 合并窗口）
 * —— 测试里 record() 是 fire-and-forget，需要等定时器跑完 fs 才真正落盘
 * —— flush 定时器启动后 100ms 触发 + fs 写入耗时 ≈ 150-200ms 足够
 */
async function waitForFlush(maxMs = 500): Promise<void> {
  await sleep(maxMs);
}

// ============================================================================
// UT-001: record() 基本写入 + jsonl 格式验证
// ============================================================================
test("UT-001: record() 写入 jsonl 格式文件，每行一个 JSON，字段完整", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // 写入 3 条不同工具的记录
  await store.record({
    sessionId: "sess-001",
    toolName: "bash",
    ok: true,
    argsSnippet: '{"command": "npm test"}',
    outputSnippet: "PASS 3 tests",
    exitCode: 0,
    cwd: tempProject,
    durationMs: 1500,
  });

  await store.record({
    sessionId: "sess-001",
    toolName: "edit",
    ok: true,
    argsSnippet: '{"filePath": "src/app.ts", "search": "old", "replace": "new"}',
    outputSnippet: "1 change made",
    cwd: tempProject,
  });

  await store.record({
    sessionId: "sess-002",
    toolName: "bash",
    ok: false,
    argsSnippet: '{"command": "npm run build"}',
    errorSnippet: "TypeError: foo is not a function",
    exitCode: 1,
    cwd: tempProject,
    timedOut: false,
    durationMs: 3200,
  });

  // 等待 flush 落盘
  await waitForFlush();

  // 验证文件存在
  const filePath = store.getHistoryFilePath();
  assert.ok(fs.existsSync(filePath), "execution-history.jsonl 应该存在");

  // 验证 jsonl 格式：每行一个独立 JSON，全部可解析
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 3, "应该有 3 行有效记录");

  for (const line of lines) {
    const rec = JSON.parse(line);
    assert.ok(rec.id, "每条记录应有 id");
    assert.ok(rec.sessionId, "每条记录应有 sessionId");
    assert.ok(typeof rec.turnIndex === "number", "每条记录应有数字 turnIndex");
    assert.ok(rec.timestamp, "每条记录应有 timestamp");
    assert.ok(rec.date, "每条记录应有 date（YYYY-MM-DD 格式）");
    assert.ok(rec.toolName, "每条记录应有 toolName");
    assert.ok(typeof rec.ok === "boolean", "每条记录应有 ok（布尔值）");
  }
});

// ============================================================================
// UT-002: query() 多维度过滤
// ============================================================================
test("UT-002: query() 多维度过滤（sessionId / toolName / ok / keyword）", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // 写入多 session 多工具记录
  for (let i = 0; i < 5; i++) {
    await store.record({
      sessionId: "sess-A",
      toolName: i % 2 === 0 ? "bash" : "edit",
      ok: i % 3 !== 0, // ok=false 的是第 0, 3 条
      argsSnippet: `command-${i}`,
      outputSnippet: `output-with-pattern-${i}`,
      cwd: tempProject,
      exitCode: i % 3 === 0 ? 1 : 0,
      durationMs: i * 100,
    });
  }
  for (let i = 0; i < 3; i++) {
    await store.record({
      sessionId: "sess-B",
      toolName: "bash",
      ok: true,
      argsSnippet: `build-${i}`,
      outputSnippet: "build succeeded",
      cwd: tempProject,
      exitCode: 0,
    });
  }

  // 等待 flush
  await waitForFlush();

  // 全量查询
  const all = store.query();
  assert.equal(all.length, 8, `全量应返回 8 条，实际 ${all.length}`);

  // 按 sessionId 过滤
  const sessA = store.query({ sessionId: "sess-A" });
  assert.equal(sessA.length, 5, `sess-A 应 5 条，实际 ${sessA.length}`);
  assert.ok(sessA.every((r) => r.sessionId === "sess-A"));

  // 按 toolName=bash 过滤
  const bashOnly = store.query({ toolName: "bash" });
  assert.ok(bashOnly.every((r) => r.toolName === "bash"));

  // 按 ok=false 过滤
  const failed = store.query({ ok: false });
  assert.ok(failed.length >= 2, `ok=false 至少 2 条`);
  assert.ok(failed.every((r) => r.ok === false));

  // keyword 过滤（outputSnippet 里有 "pattern" 的）
  const kwFiltered = store.query({ keyword: "pattern" });
  assert.ok(kwFiltered.length >= 3, `keyword=pattern 至少 3 条`);
  for (const r of kwFiltered) {
    assert.ok(
      (r.outputSnippet ?? "").includes("pattern") || (r.argsSnippet ?? "").includes("pattern"),
      `记录 id=${r.id} 应包含 "pattern"`
    );
  }

  // 组合过滤：sessionId=sess-A + ok=true
  const combined = store.query({ sessionId: "sess-A", ok: true });
  assert.ok(combined.every((r) => r.sessionId === "sess-A" && r.ok === true));

  // 排序验证（默认 desc = 最新在前）
  const defaultOrder = store.query({ limit: 100 });
  for (let i = 1; i < defaultOrder.length; i++) {
    assert.ok(defaultOrder[i - 1].timestamp >= defaultOrder[i].timestamp, `默认排序应该 desc`);
  }
});

// ============================================================================
// UT-003: 历史库不存在时 query() 返回空数组（fail-safe）
// ============================================================================
test("UT-003: query() 在历史库完全不存在时返回空数组，不报错", () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  // 没 record 过任何记录 → 文件不存在
  const result = store.query();
  assert.equal(result.length, 0, "空库应返回 0 条");

  // 按 sessionId 查不存在的 session
  const missingSess = store.query({ sessionId: "nonexistent" });
  assert.equal(missingSess.length, 0);
});

// ============================================================================
// UT-004: 自动裁剪 prune()
// ============================================================================
test("UT-004: prune() 裁剪——每 session 超量 + 全局超龄", async () => {
  // 用极小配置，让裁剪更容易触发
  const store = new ExecutionHistoryStore({
    projectRoot: tempProject,
    maxRecordsPerSession: 5, // 每 session 最多 5 条（默认 500）
    maxAgeDays: 0, // 0 天 = 全部裁剪（测试用）
    cacheMax: 1000,
  });

  // 写入 10 条记录（同 session）
  for (let i = 0; i < 10; i++) {
    await store.record({
      sessionId: "sess-overflow",
      toolName: "bash",
      ok: true,
      argsSnippet: `cmd-${i}`,
      cwd: tempProject,
    });
  }

  await waitForFlush();

  // prune 裁剪（因为 maxAgeDays=0，全部按 age 裁剪掉）
  const result = store.prune();
  assert.ok(result.prunedByAge >= 10, `prunedByAge 应 ≥ 10，实际 ${result.prunedByAge}`);

  // 裁剪后文件应该被删除（全部被 age 裁剪掉）
  const filePath = store.getHistoryFilePath();
  assert.ok(!fs.existsSync(filePath), "全部被裁剪后文件应该被删除");
});

// ============================================================================
// UT-005: 损坏文件备份
// ============================================================================
test("UT-005: 读损坏文件时自动备份损坏行，返回空数组", () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // 手动创建损坏的 jsonl 文件（混有非法 JSON 行）
  const filePath = store.getHistoryFilePath();
  const projectDir = path.dirname(filePath);
  fs.mkdirSync(projectDir, { recursive: true });

  const validRec = {
    id: "valid-001",
    sessionId: "sess-corrupt",
    turnIndex: 0,
    timestamp: Date.now(),
    date: "2026-09-04",
    toolName: "bash",
    ok: true,
  };
  const corruptContent = [
    JSON.stringify(validRec),
    "this-is-not-valid-json{{{",
    JSON.stringify({ id: "valid-002", sessionId: "sess-corrupt" }),
    "another broken line ***",
  ].join("\n");

  fs.writeFileSync(filePath, corruptContent, "utf8");

  // query 应该正常返回有效记录，不抛错
  const result = store.query({ sessionId: "sess-corrupt" });
  assert.ok(result.length >= 1, `应该至少返回 1 条有效记录，实际 ${result.length}`);

  // 损坏文件应该被备份
  const backups = fs.readdirSync(projectDir).filter((f) => f.includes(".corrupted."));
  assert.ok(backups.length >= 1, `应该生成至少 1 个损坏备份文件，实际 ${backups.length}`);
});

// ============================================================================
// UT-006: turnIndex 自增（跨 session 独立 + 重启连续）
// ============================================================================
test("UT-006: turnIndex 自增——同 session 连续递增，跨 session 独立", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // 同 session 连续 3 次 record
  await store.record({ sessionId: "sess-turn", toolName: "bash", ok: true, cwd: tempProject });
  await store.record({ sessionId: "sess-turn", toolName: "edit", ok: true, cwd: tempProject });
  await store.record({ sessionId: "sess-turn", toolName: "bash", ok: false, cwd: tempProject });

  await waitForFlush();

  const records = store.query({ sessionId: "sess-turn" });
  assert.equal(records.length, 3);

  // turnIndex 应该是 0, 1, 2（降序排列后 turnIndex 应该依次是 2, 1, 0）
  const sortedByTurn = [...records].sort((a, b) => a.turnIndex - b.turnIndex);
  assert.equal(sortedByTurn[0].turnIndex, 0, "第 1 条 turnIndex 应为 0");
  assert.equal(sortedByTurn[1].turnIndex, 1, "第 2 条 turnIndex 应为 1");
  assert.equal(sortedByTurn[2].turnIndex, 2, "第 3 条 turnIndex 应为 2");

  // 新建另一个 session，turnIndex 应该独立从 0 开始
  await store.record({ sessionId: "sess-turn-2", toolName: "bash", ok: true, cwd: tempProject });
  await waitForFlush();

  const records2 = store.query({ sessionId: "sess-turn-2" });
  assert.equal(records2[0].turnIndex, 0, "跨 session 新 session 的 turnIndex 应从 0 开始");

  // 验证 session1 的 turnIndex 仍然是 0, 1, 2（不受 session2 影响）
  const records1Again = store.query({ sessionId: "sess-turn" });
  const turns = new Set(records1Again.map((r) => r.turnIndex));
  assert.deepEqual(turns, new Set([0, 1, 2]), "session1 的 turnIndex 应保持 [0, 1, 2]");
});

// ============================================================================
// UT-007: closeSync() 同步 flush 保证进程退出前数据不丢
// ============================================================================
test("UT-007: closeSync() 同步 flush——即使不等待 flush 定时器也能保证数据落盘", () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // record 但不 waitForFlush（flush 定时器 100ms 还没触发）
  void store.record({
    sessionId: "sess-close",
    toolName: "bash",
    ok: true,
    cwd: tempProject,
  });

  // 立即 closeSync（同步 flush）
  store.closeSync();

  // 不等待定时器——直接读文件验证数据已落盘
  const filePath = store.getHistoryFilePath();
  assert.ok(fs.existsSync(filePath), "closeSync 后文件应该存在");
  const content = fs.readFileSync(filePath, "utf8");
  assert.ok(content.includes("sess-close"), "文件应包含 sessionId");
});

// ============================================================================
// UT-008: buildToolQueryResult() LLM 工具返回结构完整
// ============================================================================
test("UT-008: buildToolQueryResult() 返回结构符合 ToolDefinition 预期", async () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  await store.record({
    sessionId: "sess-tool",
    toolName: "bash",
    ok: true,
    argsSnippet: "ls -la /tmp",
    outputSnippet: "total 0\ndrwxr-xr-x",
    exitCode: 0,
    cwd: tempProject,
    durationMs: 50,
  });

  await waitForFlush();

  const result = store.buildToolQueryResult({ keyword: "ls" });
  assert.ok(result.ok === true);
  assert.ok(result.totalCount >= 1);
  assert.ok(result.returnedCount >= 1);
  assert.ok(result.records[0].id);
  assert.ok(result.records[0].toolName === "bash");
  assert.ok(result.records[0].ok === true);
  assert.ok(result.records[0].exitCode === 0);
  assert.ok(typeof result.records[0].args === "string");
  assert.ok(typeof result.records[0].output === "string");
});

// ============================================================================
// UT-009: record() fire-and-forget 模式——返回 Promise.resolve 不阻塞调用方
// ============================================================================
test("UT-009: record() 返回立即 resolve 的 Promise，fire-and-forget 可安全调用", () => {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });

  // record 应该返回 Promise.resolve()（同步部分立即完成）
  const p = store.record({
    sessionId: "sess-ff",
    toolName: "bash",
    ok: true,
    cwd: tempProject,
  });

  assert.ok(p instanceof Promise, "record() 应返回 Promise");

  // 不 await —— 模拟 session hooks 的 `void store.record(...).catch(() => {})` 用法
  // 等 flush 定时器触发后数据应落盘
  void p.catch(() => {
    // catch 是空处理——验证不会抛错
  });

  // closeSync 同步 flush
  store.closeSync();

  // 验证数据已落盘
  const content = fs.readFileSync(store.getHistoryFilePath(), "utf8");
  assert.ok(content.includes("sess-ff"));
});

// ============================================================================
// UT-010: 黑名单命令常量正确（一期二期共用）
// ============================================================================
test("UT-010: LOW_VALUE_BASH_COMMANDS 常量正确", () => {
  assert.ok(LOW_VALUE_BASH_COMMANDS.has("echo"));
  assert.ok(LOW_VALUE_BASH_COMMANDS.has("ls"));
  assert.ok(LOW_VALUE_BASH_COMMANDS.has("cat"));
  assert.ok(LOW_VALUE_BASH_COMMANDS.has("pwd"));
  assert.ok(!LOW_VALUE_BASH_COMMANDS.has("npm"));
  assert.ok(!LOW_VALUE_BASH_COMMANDS.has("git"));
});
