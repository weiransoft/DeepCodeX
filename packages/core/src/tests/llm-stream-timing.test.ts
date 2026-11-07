/**
 * LLM 流式时序（TTFT）纯函数回归（2026-11-07 自由交互 P0 #81）
 *
 * 这些数字会被前端直接拿去算「慢在哪一段」，因此口径必须锁死：
 * - 只有**正文**首个 token 算 TTFT，thinking 增量不算；
 * - 同一 requestId 的首正文时刻只记一次；
 * - 时钟偏差不产负数，非法 ISO 时间要能兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { advanceLlmStreamTiming, type LlmStreamTimingState } from "../llm-stream-timing";

const ISO = "2026-11-07T01:00:00.000Z";
const START_MS = Date.parse(ISO);

test("C1 start 帧建立状态，只带请求起点与 elapsed", () => {
  const { state, timing } = advanceLlmStreamTiming(null, ISO, "start", undefined, START_MS + 10);
  assert.deepEqual(state, { startedAtMs: START_MS, firstContentMs: null });
  assert.equal(timing.startedAtMs, START_MS);
  assert.equal(timing.elapsedMs, 10);
  assert.equal(timing.firstContentMs, undefined);
});

test("C2 thinking-only 增量不算首正文 token", () => {
  let state: LlmStreamTimingState | null = null;
  let timing;
  ({ state, timing } = advanceLlmStreamTiming(state, ISO, "start", undefined, START_MS));
  ({ state, timing } = advanceLlmStreamTiming(state, ISO, "update", undefined, START_MS + 120));
  assert.equal(state.firstContentMs, null);
  assert.equal(timing.firstContentMs, undefined);
  assert.equal(timing.elapsedMs, 120);
});

test("C3 首个非空正文 update 记录 TTFT，后续帧不改写", () => {
  let state: LlmStreamTimingState | null = null;
  let timing;
  ({ state, timing } = advanceLlmStreamTiming(state, ISO, "start", undefined, START_MS));
  ({ state, timing } = advanceLlmStreamTiming(state, ISO, "update", "你", START_MS + 350));
  assert.equal(timing.firstContentMs, 350);
  ({ state, timing } = advanceLlmStreamTiming(state, ISO, "update", "你好，今天", START_MS + 600));
  assert.equal(timing.firstContentMs, 350, "首正文时刻只能记一次");
  assert.equal(timing.elapsedMs, 600);
  assert.equal(state.firstContentMs, 350);
});

test("C4 end 帧仍带首正文时刻，供前端补齐全链路", () => {
  const started = advanceLlmStreamTiming(null, ISO, "start", undefined, START_MS);
  const first = advanceLlmStreamTiming(started.state, ISO, "update", "好", START_MS + 200);
  const end = advanceLlmStreamTiming(first.state, ISO, "end", "好", START_MS + 900);
  assert.equal(end.timing.firstContentMs, 200);
  assert.equal(end.timing.elapsedMs, 900);
});

test("C5 非法 startedAt 兜底为 nowMs，不产生 NaN", () => {
  const { timing } = advanceLlmStreamTiming(null, "not-a-date", "update", "好", 5000);
  assert.equal(timing.startedAtMs, 5000);
  assert.equal(timing.elapsedMs, 0);
  assert.equal(timing.firstContentMs, 0);
});

test("C6 时钟回拨时 elapsed / TTFT 夹到 0，不产负数", () => {
  const { timing } = advanceLlmStreamTiming(null, ISO, "update", "好", START_MS - 500);
  assert.equal(timing.elapsedMs, 0);
  assert.equal(timing.firstContentMs, 0);
});

test("C7 首帧就是 update（漏收 start）也能算出 TTFT", () => {
  const { timing } = advanceLlmStreamTiming(null, ISO, "update", "你好", START_MS + 80);
  assert.equal(timing.firstContentMs, 80);
  assert.equal(timing.startedAtMs, START_MS);
});

test("C8 不同 requestId 的状态由调用方隔离，纯函数本身不共享可变全局", () => {
  const a = advanceLlmStreamTiming(null, ISO, "update", "甲", START_MS + 100);
  const b = advanceLlmStreamTiming(null, ISO, "update", "乙", START_MS + 900);
  assert.equal(a.timing.firstContentMs, 100);
  assert.equal(b.timing.firstContentMs, 900);
  assert.notStrictEqual(a.state, b.state);
});
