/**
 * dispatch 事件日志测试（L1-3，2026-11-02）
 *
 * 覆盖方案 §6.3 的验收项：
 * - E1：seq 连续无缺口
 * - E2：崩溃（末条不是 dispatch/end）后重新打开 → 事件数 = 崩溃前 + 1，且原事件逐条未变
 * - E4：并发两次 dispatch → 各自 seq 从 1 起、无交叉无重复
 * - 终态幂等：end() 只写一次
 * - 审计重建：summarizeDispatchEvents 能还原「选了谁、调了几次工具、怎么结束」
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DispatchEventLog,
  generateDispatchRunId,
  parseDispatchEvents,
  summarizeDispatchEvents,
} from "../team/dispatch-event-log";

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "deepcode-dispatch-log-"));
}

test("E1：seq 从 1 起连续无缺口，事件按写入顺序落盘", () => {
  const dir = makeDir();
  const log = new DispatchEventLog("run-1", dir);
  log.open();
  log.append("dispatch/start", { title: "实现登录" });
  log.append("dispatch/match", { roleId: "architect", confidence: 0.87 });
  log.append("dispatch/llm-call", { delegated: false });
  log.end("completed");

  const events = log.read();
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["dispatch/start", "dispatch/match", "dispatch/llm-call", "dispatch/end"]
  );
  // 落盘是一行一个 JSON（append-only 可逐条解析）
  const lines = readFileSync(log.filePath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => JSON.parse(line).seq > 0));
});

test("E2：崩溃后重开 → 追加合成终态（+1 条），既有事件逐条未变", () => {
  const dir = makeDir();
  const first = new DispatchEventLog("run-crash", dir);
  first.open();
  first.append("dispatch/start", { title: "崩溃前" });
  first.append("dispatch/match", { roleId: "solo-coder" });
  const beforeRaw = readFileSync(first.filePath, "utf-8");
  const beforeEvents = first.read();
  assert.equal(beforeEvents.length, 2);

  // 模拟进程被 kill：不再写 dispatch/end，直接新建实例重新打开同一目录
  const reopened = new DispatchEventLog("run-crash", dir);
  reopened.open();
  const after = reopened.read();

  assert.equal(after.length, beforeEvents.length + 1, "崩溃修复只追加 1 条合成终态");
  assert.ok(
    readFileSync(reopened.filePath, "utf-8").startsWith(beforeRaw),
    "既有行必须逐字节保留（append-only，不截断不改写）"
  );
  const synthetic = after[after.length - 1]!;
  assert.equal(synthetic.type, "dispatch/end");
  assert.equal(synthetic.payload["reason"], "crashed");
  assert.equal(synthetic.payload["synthetic"], true);
  // 合成终态之后可继续写，seq 接着涨
  const next = reopened.append("dispatch/start", { title: "新一次派单" });
  assert.equal(next.seq, 4);
});

test("E4：并发两个 dispatch 各自 seq 从 1 起，互不交叉", () => {
  const root = makeDir();
  const runA = generateDispatchRunId();
  const runB = generateDispatchRunId();
  assert.notEqual(runA, runB);

  const logA = new DispatchEventLog(runA, DispatchEventLog.defaultDir(root, runA));
  const logB = new DispatchEventLog(runB, DispatchEventLog.defaultDir(root, runB));
  logA.open();
  logB.open();

  logA.append("dispatch/start", { id: "A" });
  logB.append("dispatch/start", { id: "B" });
  logA.append("dispatch/match", { roleId: "architect" });
  logB.append("dispatch/match", { roleId: "test-expert" });

  assert.deepEqual(
    logA.read().map((e) => e.seq),
    [1, 2]
  );
  assert.deepEqual(
    logB.read().map((e) => e.seq),
    [1, 2]
  );
  assert.ok(logA.read().every((e) => e.runId === runA));
  assert.ok(logB.read().every((e) => e.runId === runB));
  // 目录隔离：互不可见
  assert.ok(logA.filePath !== logB.filePath);
});

test("终态幂等 + 审计重建：end() 只写一次，summary 能还原关键事实", () => {
  const dir = makeDir();
  const log = new DispatchEventLog("run-summary", dir);
  log.open();
  log.append("dispatch/start", { title: "重构登录" });
  log.append("dispatch/match", { roleId: "solo-coder", confidence: 0.72 });
  log.append("dispatch/expert", { expertId: "domain-growth-hacker" });
  log.append("dispatch/llm-call", { delegated: true });
  log.append("dispatch/tool-result", { tool: "read_file", ok: true });
  log.append("dispatch/tool-result", { tool: "write_file", ok: true });
  assert.ok(log.end("completed"));
  assert.equal(log.end("completed"), null, "第二次 end 不得重复写入");

  const summary = summarizeDispatchEvents(log.read());
  assert.equal(summary.runId, "run-summary");
  assert.equal(summary.role, "solo-coder");
  assert.equal(summary.confidence, 0.72);
  assert.equal(summary.expert, "domain-growth-hacker");
  assert.equal(summary.llmCalls, 1);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.endReason, "completed");
});

test("坏行容错：半写行被跳过，不影响后续事件解析", () => {
  const parsed = parseDispatchEvents(
    ['{"seq":1,"runId":"r","type":"dispatch/start","at":"t","payload":{}}', '{"seq":2,"runId":"r","ty', ""].join("\n")
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.seq, 1);
});
