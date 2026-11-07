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
import {
  beginVoiceTurn,
  feedVoice,
  finishVoice,
  hasVoiceSink,
  noteVoiceConnectionLost,
  noteVoiceConnectionRestored,
  registerVoice,
  VOICE_RECONNECT_GRACE_MS,
} from "../web/src/voice/voice-bus";
import type { VoiceTalk } from "../web/src/voice/useVoiceTalk";

/** 等一小段真实时间，让宽限期定时器有机会/没机会触发 */
async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 记录收到的累积文本与轮次动作，其余字段用不到 */
function fakeVoice(): { voice: VoiceTalk; fed: string[]; state: { begun: number; finished: number } } {
  const fed: string[] = [];
  const state = { begun: 0, finished: 0 };
  const voice = {
    feed: (cumulative: string) => {
      fed.push(cumulative);
    },
    finishFeed: () => {
      state.finished += 1;
    },
    beginTurn: () => {
      state.begun += 1;
    },
  } as unknown as VoiceTalk;
  return { voice, fed, state };
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

test("B6 beginVoiceTurn 转发到当前实例（用户发出新消息的确定起点）", () => {
  const { voice, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    beginVoiceTurn();
    beginVoiceTurn();
    assert.equal(state.begun, 2, "每次调用都要转发，复位动作本身幂等");
  } finally {
    off();
  }
});

test("B7 finishVoice 多个入口各调一次也不会抛（done / 连接错误 / 停止生成）", () => {
  const { voice, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    assert.doesNotThrow(() => {
      finishVoice();
      finishVoice();
    });
    assert.equal(state.finished, 2, "总线只负责转发，幂等性由 hook 保证");
  } finally {
    off();
  }
});

test("B8 无人注册时 beginVoiceTurn / finishVoice 静默忽略", () => {
  assert.equal(hasVoiceSink(), false);
  assert.doesNotThrow(() => {
    beginVoiceTurn();
    finishVoice();
  });
});

test("B9 连接出错不立刻收尾；重连后继续推正文时撤表，不重念整段", async () => {
  const { voice, fed, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    noteVoiceConnectionLost(15);
    assert.equal(state.finished, 0, "错误边沿立刻封块会把已念过的句子从头再念一遍");
    feedVoice("你好，世界");
    await wait(60);
    assert.equal(state.finished, 0, "还有正文说明本轮活着，宽限期必须撤掉");
    assert.deepEqual(fed, ["你好，世界"]);
  } finally {
    noteVoiceConnectionRestored();
    off();
  }
});

test("B10 宽限期内一直沉默：判定本轮已丢失，补一次收尾封出尾巴", async () => {
  const { voice, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    noteVoiceConnectionLost(15);
    await wait(60);
    assert.equal(state.finished, 1, "沉默不会超时也不会报错，必须主动兜底");
  } finally {
    noteVoiceConnectionRestored();
    off();
  }
});

test("B11 连接恢复（onopen）撤表，不误封仍在生成的轮次", async () => {
  const { voice, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    noteVoiceConnectionLost(15);
    noteVoiceConnectionRestored();
    await wait(60);
    assert.equal(state.finished, 0);
  } finally {
    off();
  }
});

test("B12 确定轮次边界撤表：done / 新消息不会与看门狗重复收尾", async () => {
  const { voice, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    noteVoiceConnectionLost(15);
    finishVoice();
    await wait(60);
    assert.equal(state.finished, 1, "done 已收尾，看门狗不能再补一次");

    noteVoiceConnectionLost(15);
    beginVoiceTurn();
    await wait(60);
    assert.equal(state.finished, 1, "用户发出新消息是确定起点，旧轮不该再补念尾巴");
  } finally {
    noteVoiceConnectionRestored();
    off();
  }
});

test("B13 连续连接错误只保留一个定时器；无人注册不启表", async () => {
  assert.equal(hasVoiceSink(), false);
  noteVoiceConnectionLost(15);
  const { voice, state } = fakeVoice();
  const off = registerVoice(voice);
  try {
    await wait(60);
    assert.equal(state.finished, 0, "无人注册时不该留下会打到新实例的定时器");
    noteVoiceConnectionLost(15);
    noteVoiceConnectionLost(15);
    noteVoiceConnectionLost(15);
    await wait(60);
    assert.equal(state.finished, 1, "多次 onerror 只应有一个宽限期");
  } finally {
    noteVoiceConnectionRestored();
    off();
  }
});

test("B14 生产宽限期是秒级，不会把工具等待误判成本轮丢失", () => {
  assert.ok(VOICE_RECONNECT_GRACE_MS >= 2000, "宽限期要盖住一次自动重连");
  assert.ok(VOICE_RECONNECT_GRACE_MS <= 10_000, "太长会让断线后尾巴迟迟不出声");
});
