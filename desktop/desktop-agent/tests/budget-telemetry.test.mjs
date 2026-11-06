/**
 * 预算熔断 / 审计脱敏测试（R8 / R2 / §8 度量基线）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Budget } from "../src/modules/budget.mjs";
import { Telemetry, redact } from "../src/modules/telemetry.mjs";
import { ErrorCode } from "../src/errors.mjs";

test("Budget：步数/截图/token 三类预算独立且原子预扣", () => {
  const b = new Budget({ maxSteps: 3, maxScreenshots: 1, maxTokens: 100, maxRetries: 1 });
  b.charge({ steps: 1 });
  b.charge({ steps: 1, tokens: 20 });
  assert.equal(b.status().used.steps, 2);
  assert.equal(b.status().used.tokens, 20);
  // 超限不部分生效
  assert.throws(() => b.charge({ steps: 5 }), (e) => e.code === ErrorCode.BUDGET_EXCEEDED);
  assert.equal(b.status().used.steps, 7); // 记录的是尝试值，用于复盘
});

test("Budget：一旦熔断，后续所有动作继续被拒，直到显式 reset", () => {
  const b = new Budget({ maxScreenshots: 1 });
  b.charge({ screenshots: 1 });
  assert.throws(() => b.charge({ screenshots: 1 }), (e) => e.code === ErrorCode.BUDGET_EXCEEDED);
  assert.throws(() => b.charge({ steps: 1 }), (e) => e.details.used !== undefined);
  b.reset();
  assert.equal(b.status().tripped, null);
  assert.equal(b.charge({ steps: 1 }).used.steps, 1);
});

test("Budget：estimateTokens 与内容长度单调相关，且为空输入返回 0", () => {
  const b = new Budget();
  assert.equal(b.estimateTokens(""), 0);
  const short = b.estimateTokens({ a: 1 });
  const long = b.estimateTokens({ nodes: Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, name: "按钮" })) });
  assert.ok(long > short);
});

test("redact：密钥类键名、超长 base64、长文本一律脱敏或截断", () => {
  const out = redact({
    apiKey: "sk-abcdefg",
    Authorization: "Bearer token",
    imageBase64: "A".repeat(600),
    title: "这是一个很长的标题".repeat(50),
    nested: { password: "p", ok: 1 },
  });
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.Authorization, "[redacted]");
  assert.match(out.imageBase64, /^\[binary-omitted:/);
  assert.ok(out.title.length <= 200);
  assert.equal(out.nested.password, "[redacted]");
  assert.equal(out.nested.ok, 1);
});

test("Telemetry：默认不落盘；事件流可回放；measure 记录耗时与结果码", async () => {
  const t = new Telemetry();
  assert.equal(t.sink, null);
  const r = await t.measure("act", { appId: "notepad", action: "click_ref", apiKey: "secret" }, async () => ({ ok: true }));
  assert.equal(r.ok, true);
  const events = t.list();
  assert.equal(events.length, 2);
  assert.equal(events[0].apiKey, "[redacted]");
  assert.equal(events[1].type, "act.done");
  assert.equal(typeof events[1].elapsedMs, "number");
  const m = t.metrics();
  assert.equal(m.screenshotsPersisted, 0);
  assert.equal(m.totalEvents, 2);
});

test("Telemetry：显式 sink 才写盘；sink 抛错不阻断主流程", async () => {
  const written = [];
  const t = new Telemetry({ sink: (e) => written.push(e) });
  t.emit("observe.snapshot", { nodeCount: 10 });
  assert.equal(written.length, 1);
  const t2 = new Telemetry({ sink: () => { throw new Error("disk full"); } });
  assert.doesNotThrow(() => t2.emit("x", {}));
});

test("Telemetry：环形缓冲有上限，避免长任务内存无限增长", () => {
  const t = new Telemetry({ capacity: 5 });
  for (let i = 0; i < 20; i += 1) t.emit("step", { i });
  assert.equal(t.events.length, 5);
  assert.equal(t.events[0].i, 15);
});
