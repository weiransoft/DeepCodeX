/**
 * 流式播报测试（连续块拼接 + 生产者-消费者队列）
 *
 * ## 为什么单开一个文件
 *
 * 整块链路的 589 条用例是长期验证过的稳定基线，流式是另一条独立路径。
 * 新用例单独放，才能明确「新路径挂了」还是「把旧路径改坏了」。
 *
 * ## 真机前提（这些断言不是拍脑袋写的）
 *
 * 2026-11-06 量过 `/tts/stream`：41 字 / speed 1.2 输出 11 块，合计
 * 8.399s，整块 `/tts` 是 8.333s；相邻块边界样本跳变中位数仅 2.8% 峰值。
 * 也就是说流式块**不是重叠片段，而是同一段音频按时间切开**——块内静音是
 * 模型本来生成的语义停顿。因此连续块必须「不裁静音、不加停顿、不补尾音」
 * 直接接在前一块采样点上；裁了会吞字，加 gap 会听出一串吞吐。
 *
 * 首块 0.389s 到达、整块 1.92s 生成完，所以队列必须**第一片音频到了就
 * 排程**，不能等 `streamSynth` 的 promise resolve。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SpeechQueue, type StreamSynthFn } from "../web/src/voice/player";
import {
  WebAudioClipPlayer,
  type ClipPlayer,
  type PlayOutcome,
  type ScheduleOptions,
  type ScheduledClip,
} from "../web/src/voice/playout";

/** 采样率（与真机 TTS 一致） */
const SR = 24000;

/** 造一段"静音 + 正弦有声 + 静音"的单声道样本 */
function makeSamples(leadMs: number, speechMs: number, tailMs: number): Float32Array {
  const total = Math.round(((leadMs + speechMs + tailMs) / 1000) * SR);
  const samples = new Float32Array(total);
  const start = Math.round((leadMs / 1000) * SR);
  const end = Math.round(((leadMs + speechMs) / 1000) * SR);
  for (let i = start; i < end; i += 1) {
    samples[i] = Math.sin((i / SR) * 2 * Math.PI * 220) * 0.5;
  }
  return samples;
}

function fakeBuffer(samples: Float32Array): AudioBuffer {
  return {
    duration: samples.length / SR,
    sampleRate: SR,
    numberOfChannels: 1,
    length: samples.length,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  offset = 0;
  duration = 0;

  connect(): void {}
  disconnect(): void {}

  start(when: number, offset: number, duration: number): void {
    this.startedAt = when;
    this.offset = offset;
    this.duration = duration;
  }

  stop(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = {} as AudioDestinationNode;
  readonly sources: FakeSource[] = [];
  readonly buffers: AudioBuffer[] = [];

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  decodeAudioData(): Promise<AudioBuffer> {
    const next = this.buffers.shift();
    if (next === undefined) return Promise.reject(new Error("没有更多假 buffer"));
    return Promise.resolve(next);
  }
}

/** 装上浏览器 API 桩（node 没有 fetch / AudioContext / objectURL） */
function stubMediaApis(): () => void {
  const scope = globalThis as unknown as { fetch: unknown };
  const prevFetch = scope.fetch;
  const prevCreate = URL.createObjectURL;
  const prevRevoke = URL.revokeObjectURL;
  scope.fetch = async (): Promise<unknown> => ({ arrayBuffer: async () => new ArrayBuffer(8) });
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => undefined;
  return () => {
    scope.fetch = prevFetch;
    URL.createObjectURL = prevCreate;
    URL.revokeObjectURL = prevRevoke;
  };
}

/**
 * 装上只记录 revoke 的 objectURL 桩
 *
 * 流式测试要断言"被打断后迟到的 chunk 被回收"，所以不能用 no-op 版。
 */
function stubObjectUrl(): { revoked: string[]; restore: () => void } {
  const revoked: string[] = [];
  const origin = globalThis.URL as unknown as Record<string, unknown>;
  const prevCreate = origin.createObjectURL;
  const prevRevoke = origin.revokeObjectURL;
  origin.createObjectURL = () => "blob:fake";
  origin.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  return {
    revoked,
    restore: () => {
      origin.createObjectURL = prevCreate;
      origin.revokeObjectURL = prevRevoke;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 记录排程参数的假后端，`done` 由测试手动放行 */
class RecordingPlayer implements ClipPlayer {
  readonly maxLead = 3;
  readonly scheduled: { url: string; gap: number; options?: ScheduleOptions }[] = [];
  private readonly pending: ((outcome: PlayOutcome) => void)[] = [];

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  schedule(url: string, gap: number, options?: ScheduleOptions): Promise<ScheduledClip> {
    this.scheduled.push({ url, gap, options });
    const done = new Promise<PlayOutcome>((resolve) => {
      this.pending.push(resolve);
    });
    return Promise.resolve({ done });
  }

  /** 放行已排程的所有块 */
  finishAll(outcome: PlayOutcome = "ended"): void {
    for (const resolve of this.pending) resolve(outcome);
  }

  stop(): void {
    this.finishAll("aborted");
    this.pending.length = 0;
  }

  dispose(): void {
    this.stop();
  }
}

test("S1 连续块不裁静音、忽略 gap：按采样点直接相接", async () => {
  const restore = stubMediaApis();
  const ctx = new FakeAudioContext();
  ctx.buffers.push(fakeBuffer(makeSamples(88, 1000, 120)));
  ctx.buffers.push(fakeBuffer(makeSamples(0, 1000, 0)));
  // 第三块作对照：不传 continuous 时必须仍按整句逻辑裁掉句首静音
  ctx.buffers.push(fakeBuffer(makeSamples(88, 1000, 120)));
  const player = new WebAudioClipPlayer(() => ctx as unknown as AudioContext);
  try {
    await player.prepare();
    await player.schedule("blob:a", 999, { continuous: true });
    await player.schedule("blob:b", 999, { continuous: true });
    await player.schedule("blob:c", 0);

    const [first, second, whole] = ctx.sources;
    assert.equal(first.offset, 0, "流式块首部静音是语义停顿，不能裁");
    assert.ok(Math.abs(first.duration - 1.208) < 0.002, `连续块要用整段时长，实际 ${first.duration}`);
    const gap = (second.startedAt ?? 0) - ((first.startedAt ?? 0) + first.duration);
    assert.ok(Math.abs(gap) < 0.0001, `连续块之间必须零缝隙，实际 ${(gap * 1000).toFixed(2)}ms`);
    assert.equal(second.offset, 0, "第二块同样不裁");
    assert.ok(Math.abs(whole.offset - 0.088) < 0.002, "旧路径仍要裁句首静音，不能被新选项带坏");
  } finally {
    player.dispose();
    restore();
  }
});

test("S2 首片音频到达即排程：不等流式合成整体结束", async () => {
  const url = stubObjectUrl();
  const player = new RecordingPlayer();
  let emit: ((chunkUrl: string, index: number) => void) | null = null;
  let finishStream: ((count: number) => void) | null = null;
  let streamSettled = false;
  const states: boolean[] = [];
  const streamSynth: StreamSynthFn = (_text, onChunk) => {
    emit = onChunk;
    return new Promise<number>((resolve) => {
      finishStream = (count) => {
        streamSettled = true;
        resolve(count);
      };
    });
  };
  const queue = new SpeechQueue(
    async () => "blob:whole",
    { onSpeakingChange: (v) => states.push(v) },
    { player, firstBlockChars: 1, blockChars: 1, streamSynth }
  );
  try {
    queue.enqueue("一句要播的话。");
    queue.flush();
    await waitFor(() => emit !== null);

    emit?.("blob:chunk-0", 0);
    await waitFor(() => player.scheduled.length === 1);
    assert.equal(streamSettled, false, "整块流式生成还没结束，第一片就该已经出声");
    assert.equal(player.scheduled[0].url, "blob:chunk-0");
    assert.equal(player.scheduled[0].gap, 0, "连续块之间不能插标点停顿");
    assert.equal(player.scheduled[0].options?.continuous, true);
    assert.equal(states[0], true, "排程即进入播报态");

    emit?.("blob:chunk-1", 1);
    await waitFor(() => player.scheduled.length === 2);
    finishStream?.(2);
    player.finishAll();
    await waitFor(() => states.at(-1) === false);
  } finally {
    queue.dispose();
    url.restore();
  }
});

test("S3 流式不可用自动回退整块：不报错、不哑", async () => {
  const url = stubObjectUrl();
  const player = new RecordingPlayer();
  const texts: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const streamSynth: StreamSynthFn = () => Promise.reject(new Error("流式端点 404"));
  const queue = new SpeechQueue(
    async (text) => {
      texts.push(text);
      return "blob:whole";
    },
    { onNotice: (m) => notices.push(m), onError: (m) => errors.push(m) },
    { player, firstBlockChars: 1, blockChars: 1, streamSynth }
  );
  try {
    queue.enqueue("一句要播的话。");
    queue.flush();
    await waitFor(() => player.scheduled.length === 1);
    assert.deepEqual(texts, ["一句要播的话。"], "该块要交给整块合成重试");
    assert.deepEqual(errors, [], "可自愈的降级不该弹红色错误");
    assert.ok(
      notices.some((m) => m.includes("回退整块")),
      `要留降级说明，实际 ${JSON.stringify(notices)}`
    );
    assert.equal(player.scheduled[0].options?.continuous, false, "整块音频要走裁静音 + 停顿的老逻辑");
    player.finishAll();
  } finally {
    queue.dispose();
    url.restore();
  }
});

test("S4 开关关闭（返回 0 块）静默回退整块，不产生提示", async () => {
  const url = stubObjectUrl();
  const player = new RecordingPlayer();
  const texts: string[] = [];
  const notices: string[] = [];
  const streamSynth: StreamSynthFn = () => Promise.resolve(0);
  const queue = new SpeechQueue(
    async (text) => {
      texts.push(text);
      return "blob:whole";
    },
    { onNotice: (m) => notices.push(m) },
    { player, firstBlockChars: 1, blockChars: 1, streamSynth }
  );
  try {
    queue.enqueue("一句要播的话。");
    queue.flush();
    await waitFor(() => player.scheduled.length === 1);
    assert.deepEqual(texts, ["一句要播的话。"]);
    assert.deepEqual(notices, [], "用户主动关的开关不算故障，不该刷提示");
    assert.equal(player.scheduled[0].options?.continuous, false);
    player.finishAll();
  } finally {
    queue.dispose();
    url.restore();
  }
});

test("S5 打断立刻掐断流，迟到的 chunk 被回收且不排程", async () => {
  const url = stubObjectUrl();
  const player = new RecordingPlayer();
  let emit: ((chunkUrl: string, index: number) => void) | null = null;
  let captured: AbortSignal | null = null;
  const streamSynth: StreamSynthFn = (_text, onChunk, signal) => {
    emit = onChunk;
    captured = signal;
    return new Promise<number>(() => undefined); // 永不自行结束，靠 stop() abort
  };
  const queue = new SpeechQueue(
    async () => "blob:whole",
    {},
    { player, firstBlockChars: 1, blockChars: 1, streamSynth }
  );
  try {
    queue.enqueue("一句要播的话。");
    queue.flush();
    await waitFor(() => captured !== null);
    queue.stop();
    assert.equal(captured?.aborted, true, "stop() 必须真的 abort 掉响应流");

    const before = player.scheduled.length;
    emit?.("blob:late", 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(player.scheduled.length, before, "旧一轮迟到的音频不能串进新一轮时间轴");
    assert.ok(url.revoked.includes("blob:late"), "迟到的 objectURL 要回收，不能泄漏");
  } finally {
    queue.dispose();
    url.restore();
  }
});
