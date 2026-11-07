/**
 * 语音交互延迟埋点回归（2026-11-07 自由交互 P0 #81）
 *
 * 覆盖两层：
 * - `voice/latency.ts` 五时间戳 → 分段延迟的纯函数（含缺段与时钟乱序）
 * - `voice/voice-bus.ts` 把 SSE 的 LLM 时序转发给当前语音实例
 *
 * 为什么必须单测：延迟数字一旦算错，后面所有「优化了多少毫秒」的结论
 * 都是假的；而缺段被填成 0 会制造「ASR 只用了 0ms」这种假绿灯。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { mergeLlmTiming, summarizeVoiceTurnLatency, type VoiceTurnTiming } from "../web/src/voice/latency";
import { hasVoiceSink, noteVoiceLlmTiming, registerVoice } from "../web/src/voice/voice-bus";
import type { LlmStreamTiming } from "../web/src/voice/latency";
import type { VoiceTalk } from "../web/src/voice/useVoiceTalk";

const T = {
  speechEndAtMs: 1000,
  endpointAtMs: 1250,
  submitAtMs: 1270,
  llmStartAtMs: 1300,
  llmFirstContentAtMs: 1650,
  ttsFirstByteAtMs: 1900,
  firstAudioAtMs: 1980,
} satisfies VoiceTurnTiming;

test("L1 五时间戳齐全时六段延迟逐段正确", () => {
  const r = summarizeVoiceTurnLatency(T);
  assert.equal(r.endpointMs, 250);
  assert.equal(r.asrSubmitMs, 300);
  assert.equal(r.llmTtftMs, 350);
  assert.equal(r.ttsQueueMs, 250);
  assert.equal(r.ttsTtfaMs, 80);
  assert.equal(r.e2eMs, 980);
  assert.equal(r.observedTimestamps, 7);
});

test("L2 缺端点只缺对应段，不把没测到写成 0", () => {
  const r = summarizeVoiceTurnLatency({
    speechEndAtMs: 1000,
    llmStartAtMs: 1300,
    firstAudioAtMs: 1980,
  });
  assert.equal(r.asrSubmitMs, 300);
  assert.equal(r.e2eMs, 980);
  assert.equal(r.endpointMs, undefined);
  assert.equal(r.llmTtftMs, undefined);
  assert.equal(r.ttsQueueMs, undefined);
  assert.equal(r.ttsTtfaMs, undefined);
  assert.equal(r.observedTimestamps, 3);
});

test("L3 时钟乱序/回拨不产出负数", () => {
  const r = summarizeVoiceTurnLatency({
    speechEndAtMs: 5000,
    llmStartAtMs: 1000, // 服务端时钟落后浏览器
    firstAudioAtMs: 4900,
  });
  assert.equal(r.asrSubmitMs, undefined);
  assert.equal(r.e2eMs, undefined);
});

test("L4 非有限值与空 trace 不抛错、不产生分段", () => {
  const r = summarizeVoiceTurnLatency({ llmStartAtMs: Number.NaN, speechEndAtMs: Number.POSITIVE_INFINITY });
  assert.equal(r.asrSubmitMs, undefined);
  assert.equal(r.observedTimestamps, 0);
  assert.deepEqual(summarizeVoiceTurnLatency({}), { observedTimestamps: 0 });
});

test("L5 mergeLlmTiming：start 帧只写请求起点", () => {
  const next = mergeLlmTiming({}, { startedAtMs: 1300, elapsedMs: 0 });
  assert.deepEqual(next, { llmStartAtMs: 1300 });
  assert.equal(next.llmFirstContentAtMs, undefined);
});

test("L6 mergeLlmTiming：首正文帧把相对偏移换算成绝对时刻", () => {
  const afterStart = mergeLlmTiming({}, { startedAtMs: 1300, elapsedMs: 20 });
  const next = mergeLlmTiming(afterStart, { startedAtMs: 1300, elapsedMs: 350, firstContentMs: 350 });
  assert.equal(next.llmFirstContentAtMs, 1650);
  assert.equal(summarizeVoiceTurnLatency(next).llmTtftMs, 350);
});

test("L7 mergeLlmTiming：null / undefined 空操作且不修改传入对象", () => {
  const original: VoiceTurnTiming = { speechEndAtMs: 1000 };
  assert.deepEqual(mergeLlmTiming(original, null), original);
  assert.deepEqual(mergeLlmTiming(original, undefined), original);
  assert.equal(Object.hasOwn(original, "llmStartAtMs"), false);
  assert.equal(summarizeVoiceTurnLatency(mergeLlmTiming(original, undefined)).llmTtftMs, undefined);
});

test("L8 总线把 LLM 时序转发给当前实例，无人注册时静默忽略", () => {
  const seen: LlmStreamTiming[] = [];
  const fake = {
    noteLlmTiming: (t: LlmStreamTiming) => seen.push(t),
  } as unknown as VoiceTalk;
  const unregister = registerVoice(fake);
  assert.equal(hasVoiceSink(), true);
  const timing: LlmStreamTiming = { startedAtMs: 1300, elapsedMs: 350, firstContentMs: 350 };
  noteVoiceLlmTiming(timing);
  assert.deepEqual(seen, [timing]);
  noteVoiceLlmTiming(null);
  noteVoiceLlmTiming(undefined);
  assert.equal(seen.length, 1, "null/undefined 不应转发");
  unregister();
  assert.equal(hasVoiceSink(), false);
  assert.doesNotThrow(() => noteVoiceLlmTiming(timing));
});
