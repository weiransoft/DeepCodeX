/**
 * 按回合思考深度调度：Web 侧信号透传、白名单与效率指标
 *
 * 三件事必须有测试钉住：
 * 1. HTTP 入口不能把任意 `messageParams` 放进 core（那是 CLI 编排参数容器）；
 * 2. 语音来源标记是一次性的，键盘输入不会误继承时效敏感标志；
 * 3. 效率汇总缺实测值就留空，绝不填 0 冒充实测收益。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThinkingDepthParams } from "../src/api/chat-api";
import { summarizeDepthEfficiency, summarizeVoiceTurnLatency, type ThinkDepthSnapshot } from "../web/src/voice/latency";
import {
  consumeVoiceOrigin,
  markVoiceOrigin,
  noteVoiceThinkDepth,
  registerVoice,
  resetVoiceOriginForTesting,
} from "../web/src/voice/voice-bus";
import type { VoiceTalk } from "../web/src/voice/useVoiceTalk";

// ---------------------------------------------------------------------------
// 1. 请求体白名单
// ---------------------------------------------------------------------------

test("W1 只放行 latencySensitive / thinkingDepth=fixed", () => {
  assert.deepEqual(parseThinkingDepthParams({ latencySensitive: true, thinkingDepth: "fixed" }), {
    latencySensitive: true,
    thinkingDepth: "fixed",
  });
});

test("W2 编排参数与未知键一律丢弃（HTTP 入口不得触发 codingLoopRequest）", () => {
  assert.deepEqual(
    parseThinkingDepthParams({
      codingLoopRequest: { task: "build" },
      latencySensitive: true,
      __proto__: { polluted: true },
      nested: { a: 1 },
    }),
    { latencySensitive: true }
  );
});

test("W3 布尔值只认字面 true；字符串 / 1 都不算", () => {
  assert.equal(parseThinkingDepthParams({ latencySensitive: "true" }), undefined);
  assert.equal(parseThinkingDepthParams({ latencySensitive: 1 }), undefined);
  assert.equal(parseThinkingDepthParams({ thinkingDepth: "auto" }), undefined);
});

test("W4 null / 数组 / 非对象 / 空对象安全返回 undefined", () => {
  for (const raw of [undefined, null, [], "x", 3, {}, { thinkingDepth: null }]) {
    assert.equal(parseThinkingDepthParams(raw), undefined);
  }
});

// ---------------------------------------------------------------------------
// 2. 语音来源一次性标记
// ---------------------------------------------------------------------------

test("W5 语音标记消费一次即清除；键盘输入不继承", () => {
  resetVoiceOriginForTesting();
  assert.equal(consumeVoiceOrigin(), false);
  markVoiceOrigin();
  assert.equal(consumeVoiceOrigin(), true, "语音回合命中");
  assert.equal(consumeVoiceOrigin(), false, "下一条键盘输入不继承");
});

test("W6 连续两次标记仍只影响一条消息", () => {
  resetVoiceOriginForTesting();
  markVoiceOrigin();
  markVoiceOrigin();
  assert.equal(consumeVoiceOrigin(), true);
  assert.equal(consumeVoiceOrigin(), false);
});

test("W7 思考深度快照透传到语音实例；旧实例缺方法也不抛错", () => {
  const seen: ThinkDepthSnapshot[] = [];
  const voice = {
    feed: () => {},
    finishFeed: () => {},
    beginTurn: () => {},
    noteThinkDepth: (depth: ThinkDepthSnapshot) => seen.push(depth),
  } as unknown as VoiceTalk;
  const off = registerVoice(voice);
  const snapshot: ThinkDepthSnapshot = {
    scene: "companion_chat",
    level: "off",
    effort: "low",
    thinkingEnabled: false,
    control: "effort",
    effective: true,
    fallback: false,
  };
  try {
    noteVoiceThinkDepth(snapshot);
    noteVoiceThinkDepth(null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].scene, "companion_chat");
  } finally {
    off();
  }

  // 旧 bundle 实例没有 noteThinkDepth：遥测缺失不能把整帧 llm_delta 抛掉
  const legacy = { feed: () => {}, finishFeed: () => {}, beginTurn: () => {} } as unknown as VoiceTalk;
  const off2 = registerVoice(legacy);
  try {
    assert.doesNotThrow(() => noteVoiceThinkDepth(snapshot));
  } finally {
    off2();
  }
});

// ---------------------------------------------------------------------------
// 3. 效率指标
// ---------------------------------------------------------------------------

function depth(level: ThinkDepthSnapshot["level"], overrides: Partial<ThinkDepthSnapshot> = {}): ThinkDepthSnapshot {
  return {
    scene: level === "full" ? "task" : "small_talk",
    level,
    effort: level === "full" ? "max" : "low",
    thinkingEnabled: level !== "off",
    control: "effort",
    effective: level !== "full",
    fallback: false,
    ...overrides,
  };
}

function breakdown(ttft: number, e2e: number) {
  return summarizeVoiceTurnLatency({
    llmStartAtMs: 1000,
    llmFirstContentAtMs: 1000 + ttft,
    speechEndAtMs: 900,
    firstAudioAtMs: 900 + e2e,
  });
}

test("W8 按档位分组统计 TTFT / E2E / TTFA，并给出 full 与 off 的 P50 差", () => {
  const report = summarizeDepthEfficiency([
    { thinkDepth: depth("full"), breakdown: breakdown(900, 2100), ttfaMs: 1900 },
    { thinkDepth: depth("full"), breakdown: breakdown(1100, 2300), ttfaMs: 2100 },
    { thinkDepth: depth("off"), breakdown: breakdown(300, 1200), ttfaMs: 1100 },
    { thinkDepth: depth("off"), breakdown: breakdown(400, 1300), ttfaMs: 1200 },
    { thinkDepth: depth("light"), breakdown: breakdown(500, 1500) },
  ]);
  assert.equal(report.total, 5);
  assert.equal(report.grouped, 5);
  assert.equal(report.byLevel.full?.count, 2);
  assert.equal(report.byLevel.full?.ttftP50Ms, 900);
  assert.equal(report.byLevel.full?.ttftP95Ms, 1100);
  assert.equal(report.byLevel.off?.ttftP50Ms, 300);
  assert.equal(report.byLevel.off?.ttfaP50Ms, 1100);
  assert.equal(report.byLevel.light?.e2eP50Ms, 1500);
  assert.equal(report.ttftSavingP50Ms, 600);
  assert.equal(report.downgradedRatio, 0.6);
});

test("W9 缺档位 / 缺实测值一律留空，不填 0 冒充实测", () => {
  const report = summarizeDepthEfficiency([
    { breakdown: breakdown(900, 2100) },
    { thinkDepth: depth("full") },
    { thinkDepth: depth("off"), breakdown: summarizeVoiceTurnLatency({}) },
  ]);
  assert.equal(report.total, 3);
  assert.equal(report.grouped, 2);
  assert.equal(report.byLevel.full?.ttftP50Ms, undefined);
  assert.equal(report.byLevel.off?.ttftP50Ms, undefined);
  assert.equal(report.ttftSavingP50Ms, undefined);
});

test("W10 兜底样本单独计数，空输入不抛错", () => {
  const report = summarizeDepthEfficiency([
    { thinkDepth: depth("full", { fallback: true }), breakdown: breakdown(900, 2100) },
    { thinkDepth: depth("off"), breakdown: breakdown(300, 1200) },
  ]);
  assert.equal(report.fallbackCount, 1);
  assert.equal(report.downgradedRatio, 0.5);
  const empty = summarizeDepthEfficiency([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.grouped, 0);
  assert.deepEqual(empty.byLevel, {});
});
