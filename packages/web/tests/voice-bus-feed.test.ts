/**
 * 语音喂句总线的边界防御单测（web/voice/voice-bus）
 *
 * 回归背景（实测发现）：`llm_delta` 的 `previewText` 在 `start` 帧和纯 thinking
 * 增量上是 **undefined**（core 的 `LlmStreamProgress.previewText` 本就是可选）。
 * 总线原样转发后，`scanVoiceDirective` 的 `cumulative.replace(...)` 抛
 * TypeError——而它跑在 `onLlmDelta` 里 `setEntries` 之前，一抛就整帧跳过。
 *
 * 症状不是"语音出问题"，而是「**开了语音播报之后，某些回复的正文压根不显示**」，
 * 极难联想到语音。所以这道防御必须有测试钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedVoice, hasVoiceSink, registerVoice } from "../web/src/voice/voice-bus";
import type { VoiceTalk } from "../web/src/voice/useVoiceTalk";

/** 记录收到的累积文本，其余字段用不到 */
function fakeVoice(): { voice: VoiceTalk; fed: string[] } {
  const fed: string[] = [];
  const voice = {
    feed: (cumulative: string) => {
      fed.push(cumulative);
    },
    finishFeed: () => {},
  } as unknown as VoiceTalk;
  return { voice, fed };
}

test("B1 previewText 缺省（undefined）时静默丢弃，不抛异常", () => {
  const { voice, fed } = fakeVoice();
  const off = registerVoice(voice);
  try {
    assert.doesNotThrow(() => {
      feedVoice(undefined);
    });
    assert.deepEqual(fed, [], "缺省帧不该转发给播报队列");
  } finally {
    off();
  }
});

test("B2 空串不转发：start 帧的空预览会白白重建流并把 TTFA 埋点刷成 0", () => {
  const { voice, fed } = fakeVoice();
  const off = registerVoice(voice);
  try {
    feedVoice("");
    assert.deepEqual(fed, []);
  } finally {
    off();
  }
});

test("B3 正常正文照常转发（防御不能把功能挡掉）", () => {
  const { voice, fed } = fakeVoice();
  const off = registerVoice(voice);
  try {
    feedVoice("你好");
    feedVoice("你好，世界");
    assert.deepEqual(fed, ["你好", "你好，世界"]);
  } finally {
    off();
  }
});

test("B4 无人注册时静默忽略（语音关闭的常态路径）", () => {
  assert.equal(hasVoiceSink(), false);
  assert.doesNotThrow(() => {
    feedVoice("随便说点什么");
    feedVoice(undefined);
  });
});

test("B5 注销后不再转发，旧实例不会被残留引用继续喂", () => {
  const { voice, fed } = fakeVoice();
  const off = registerVoice(voice);
  feedVoice("第一句");
  off();
  feedVoice("第二句");
  assert.deepEqual(fed, ["第一句"]);
  assert.equal(hasVoiceSink(), false);
});
