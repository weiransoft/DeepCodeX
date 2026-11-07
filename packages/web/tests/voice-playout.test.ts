/**
 * 采样级播报后端测试（playout）
 *
 * ## 为什么要测这一层
 *
 * 用户报的"句间卡顿"经真机测量拆成了两个与合成无关的来源：
 * - TTS 每句自带 88ms 句首 / 47ms 句尾机械静音（24kHz Qwen3-TTS 实测）
 * - 每个 `Audio` 元素切换一次就是一次媒体线程上的解码器重建
 *
 * 前者靠 `findSpeechBounds` 裁掉，后者靠把音频排进 `AudioContext` 时间轴。
 * 这两件事都没有"看起来对不对"的中间状态——要么时间轴连续，要么中间有缝，
 * 所以用假 AudioContext 把排程参数（开始时刻/偏移/时长）直接读出来断言。
 *
 * ## 假件怎么用
 *
 * `FakeAudioContext` 只实现 player 用到的那部分表面：`decodeAudioData` 返回
 * 预置的假 buffer，`createBufferSource` 记录 `start(when, offset, duration)`。
 * 于是"第二句是否紧接第一句"变成算术断言，不依赖任何真实音频。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GAP_CLAUSE_MS,
  GAP_FIRST_MS,
  GAP_PLAIN_MS,
  GAP_SENTENCE_MS,
  SinkUnavailableError,
  TAIL_KEEP_MS,
  WebAudioClipPlayer,
  findSpeechBounds,
  gapBeforeMs,
  type ClipPlayer,
  type PlayOutcome,
  type ScheduledClip,
} from "../web/src/voice/playout";
import { SpeechQueue } from "../web/src/voice/player";

/** 采样率（与真机 TTS 一致） */
const SR = 24000;

/**
 * 造一段"静音 + 正弦有声 + 静音"的单声道样本
 *
 * @param leadMs 句首静音
 * @param speechMs 有声长度
 * @param tailMs 句尾静音
 * @returns 样本
 */
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

/** 假整型 buffer（只提供 player 用到的字段） */
function fakeBuffer(samples: Float32Array): AudioBuffer {
  return {
    duration: samples.length / SR,
    sampleRate: SR,
    numberOfChannels: 1,
    length: samples.length,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

/** 假 buffer source：记录排程参数 */
class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  offset = 0;
  duration = 0;

  connect(): void {
    // 假图，无需真连接
  }

  disconnect(): void {
    // 同上
  }

  start(when: number, offset: number, duration: number): void {
    this.startedAt = when;
    this.offset = offset;
    this.duration = duration;
  }

  stop(): void {
    this.onended?.();
  }
}

/** 假 AudioContext：按顺序从队列取 buffer 解码 */
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

/**
 * 装上 fetch / revokeObjectURL 桩
 *
 * @returns 还原函数
 */
function stubMediaApis(): () => void {
  const scope = globalThis as unknown as { fetch: unknown };
  const prevFetch = scope.fetch;
  const prevRevoke = URL.revokeObjectURL;
  scope.fetch = async (): Promise<unknown> => ({ arrayBuffer: async () => new ArrayBuffer(8) });
  URL.revokeObjectURL = () => undefined;
  return () => {
    scope.fetch = prevFetch;
    URL.revokeObjectURL = prevRevoke;
  };
}

/**
 * 等到条件成立
 *
 * @param predicate 条件
 * @param timeoutMs 超时
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("T1 裁静音：句首 88ms / 句尾 47ms 的 padding 被识别为静音", () => {
  const samples = makeSamples(88, 1000, 47);
  const bounds = findSpeechBounds(samples);
  const startMs = (bounds.start / SR) * 1000;
  const endMs = (bounds.end / SR) * 1000;
  assert.ok(Math.abs(startMs - 88) <= 1, `句首边界应为 88ms，实际 ${startMs.toFixed(1)}`);
  assert.ok(Math.abs(endMs - 1088) <= 1, `有声结束应为 1088ms，实际 ${endMs.toFixed(1)}`);
});

test("T2 全静音：返回空区间（由调用方报错跳过，不能排一段无声的）", () => {
  const bounds = findSpeechBounds(new Float32Array(SR / 10));
  assert.deepEqual(bounds, { start: 0, end: 0 });
});

test("T3 停顿由标点决定，首句不等待", () => {
  assert.equal(gapBeforeMs("好。", true), GAP_FIRST_MS, "首句不该先静一下");
  assert.equal(gapBeforeMs("好。", false), GAP_SENTENCE_MS);
  assert.equal(gapBeforeMs("好？", false), GAP_SENTENCE_MS);
  assert.equal(gapBeforeMs("好，", false), GAP_CLAUSE_MS);
  assert.equal(gapBeforeMs("好、", false), GAP_CLAUSE_MS);
  assert.equal(gapBeforeMs("没有标点", false), GAP_PLAIN_MS);
  // 引号收尾要看里面那个标点，否则「他说：“好。”」会被判成普通句
  assert.equal(gapBeforeMs("他说：“好。”", false), GAP_SENTENCE_MS);
  assert.equal(gapBeforeMs("他说：“好，”", false), GAP_CLAUSE_MS);
});

test("T4 采样级拼接：第二句排在「第一句结束 + 句间停顿」上，且跳过句首静音", async () => {
  const restore = stubMediaApis();
  const ctx = new FakeAudioContext();
  // 尾部留 120ms（大于 TAIL_KEEP_MS），让"尾部保留"这条规则真正生效；
  // 真机 TTS 句尾只有 46~49ms，那时 duration 会被 buffer 剩余长度钳住
  ctx.buffers.push(fakeBuffer(makeSamples(88, 1000, 120)));
  ctx.buffers.push(fakeBuffer(makeSamples(88, 1000, 120)));
  ctx.buffers.push(fakeBuffer(makeSamples(88, 1000, 120)));
  const player = new WebAudioClipPlayer(() => ctx as unknown as AudioContext);
  try {
    await player.prepare();
    await player.schedule("blob:1", GAP_FIRST_MS);
    await player.schedule("blob:2", GAP_SENTENCE_MS);
    await player.schedule("blob:3", GAP_SENTENCE_MS);

    assert.equal(ctx.sources.length, 3);
    const [first, second, third] = ctx.sources;
    assert.ok(Math.abs(first.offset - 0.088) < 0.002, `句首静音要跳过，实际 offset=${first.offset}`);
    assert.ok(
      Math.abs(first.duration - (1.0 + TAIL_KEEP_MS / 1000)) < 0.002,
      `时长应为有声 1000ms + 尾部保留 ${TAIL_KEEP_MS}ms，实际 ${first.duration}`
    );

    // 核心断言：缝的大小等于标点停顿，而不是元素切换开销
    const gap1 = (second.startedAt ?? 0) - ((first.startedAt ?? 0) + first.duration);
    const gap2 = (third.startedAt ?? 0) - ((second.startedAt ?? 0) + second.duration);
    assert.ok(
      Math.abs(gap1 - GAP_SENTENCE_MS / 1000) < 0.002,
      `第一、二句之间应为 ${GAP_SENTENCE_MS}ms，实际 ${(gap1 * 1000).toFixed(1)}ms`
    );
    assert.ok(
      Math.abs(gap2 - GAP_SENTENCE_MS / 1000) < 0.002,
      `第二、三句之间应为 ${GAP_SENTENCE_MS}ms，实际 ${(gap2 * 1000).toFixed(1)}ms`
    );
  } finally {
    player.dispose();
    restore();
  }
});

/** 假后端：只记录排程，`done` 由测试手动放行 */
class GatedPlayer implements ClipPlayer {
  readonly maxLead = 3;
  readonly scheduled: { url: string; gap: number }[] = [];
  private readonly pending: ((outcome: PlayOutcome) => void)[] = [];

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  schedule(url: string, gap: number): Promise<ScheduledClip> {
    this.scheduled.push({ url, gap });
    const done = new Promise<PlayOutcome>((resolve) => {
      this.pending.push(resolve);
    });
    return Promise.resolve({ done });
  }

  /** 放行第 index 句 */
  finish(index: number, outcome: PlayOutcome = "ended"): void {
    this.pending[index]?.(outcome);
  }

  stop(): void {
    for (const resolve of this.pending) resolve("aborted");
    this.pending.length = 0;
  }

  dispose(): void {
    this.stop();
  }
}

test("T5 领先排程：三句都在第一句播完前完成排程（否则句间必然空等合成）", async () => {
  const player = new GatedPlayer();
  const states: boolean[] = [];
  const queue = new SpeechQueue(
    async (text) => `blob:${text}`,
    { onSpeakingChange: (v) => states.push(v) },
    // 这个用例要观察"每句各自排程"，所以把块阈值压到 1 字
    { player, createFallbackPlayer: () => player, firstBlockChars: 1, blockChars: 1 }
  );

  queue.enqueue("第一句。");
  queue.enqueue("第二句。");
  queue.enqueue("第三句。");

  await waitFor(() => player.scheduled.length === 3);
  assert.deepEqual(
    player.scheduled.map((s) => s.gap),
    [GAP_FIRST_MS, GAP_SENTENCE_MS, GAP_SENTENCE_MS],
    "首句不等待，之后按句末标点留停顿"
  );
  assert.equal(states[0], true, "排程即进入播报态");

  // 逐句放行，队列要能正常收尾
  player.finish(0);
  await waitFor(() => player.scheduled.length === 3);
  player.finish(1);
  player.finish(2);
  await waitFor(() => states[states.length - 1] === false);
});

/** 不可用后端：prepare 直接抛，模拟没有用户手势的 AudioContext */
class UnavailablePlayer implements ClipPlayer {
  readonly maxLead = 3;

  prepare(): Promise<void> {
    return Promise.reject(new SinkUnavailableError("AudioContext 无法恢复"));
  }

  schedule(): Promise<ScheduledClip> {
    return Promise.reject(new Error("不该走到这里"));
  }

  stop(): void {
    // 无状态
  }

  dispose(): void {
    // 无资源
  }
}

test("T6 降级：Web Audio 恢复不了时切到元素播放，不是哑掉", async () => {
  const fallback = new GatedPlayer();
  const notices: string[] = [];
  const states: boolean[] = [];
  const queue = new SpeechQueue(
    async (text) => `blob:${text}`,
    {
      onSpeakingChange: (v) => states.push(v),
      onNotice: (m) => notices.push(m),
      onError: (m) => {
        throw new Error(`不该报错：${m}`);
      },
    },
    { player: new UnavailablePlayer(), createFallbackPlayer: () => fallback }
  );

  queue.enqueue("一句要播的话。");
  // 一句不满首块目标字数：必须 flush 才算"句子流结束"，否则永远不会合成
  queue.flush();
  await waitFor(() => fallback.scheduled.length === 1);
  assert.ok(
    notices.some((m) => m.includes("已自动切回兼容播放")),
    `降级要留一条提示，实际 ${JSON.stringify(notices)}`
  );

  fallback.finish(0);
  await waitFor(() => states[states.length - 1] === false);
});

/**
 * resume 永不 settle 的上下文
 *
 * 这是真机上的坑：WebKit/Chromium 在没有用户手势时 `resume()` 可能既不
 * resolve 也不 reject，而是**永久 pending**。之前的 `prepare()` 直接 await
 * 它，于是整个播报队列卡在第一步，一次 TTS 请求都发不出去。
 */
class HangingAudioContext extends FakeAudioContext {
  constructor() {
    super();
    this.state = "suspended";
  }

  override resume(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
}

test("T7 resume 永久挂起时，prepare 必须在有限时间内判定不可用", async () => {
  const ctx = new HangingAudioContext();
  const player = new WebAudioClipPlayer(() => ctx as unknown as AudioContext, 20);
  const started = Date.now();

  await assert.rejects(
    () => player.prepare(),
    (error: unknown) => error instanceof SinkUnavailableError && /未返回/.test((error as Error).message),
    "超时要抛 SinkUnavailableError，调用方才会降级"
  );
  assert.ok(Date.now() - started < 500, `不能无限等下去，实际 ${Date.now() - started}ms`);
});

test("T8 播放后端挂起也不能挡住合成：超时后降级，声音照常出", async () => {
  const restore = stubMediaApis();
  try {
    const ctx = new HangingAudioContext();
    const hung = new WebAudioClipPlayer(() => ctx as unknown as AudioContext, 20);
    const fallback = new GatedPlayer();
    const synthTexts: string[] = [];
    const notices: string[] = [];
    const queue = new SpeechQueue(
      async (text) => {
        synthTexts.push(text);
        return `blob:${text}`;
      },
      {
        onNotice: (m) => notices.push(m),
        onError: (m) => {
          throw new Error(`不该报错：${m}`);
        },
      },
      { player: hung, createFallbackPlayer: () => fallback, firstBlockChars: 1, blockChars: 1 }
    );

    queue.enqueue("一句要播的话。");
    queue.flush();

    // 关键断言：合成先发生，不依赖播放后端准备完成
    await waitFor(() => synthTexts.length === 1);
    assert.equal(synthTexts[0], "一句要播的话。", "后端挂住也要照常发 TTS 请求");
    // 超时后走降级，最终由元素后端排程出声
    await waitFor(() => fallback.scheduled.length === 1);
    assert.ok(
      notices.some((m) => m.includes("已自动切回兼容播放")),
      `降级要留提示，实际 ${JSON.stringify(notices)}`
    );
    fallback.finish(0);
  } finally {
    restore();
  }
});

/** 解码永久挂起：设备切换 / 坏 WAV / 上下文异常时 decodeAudioData 可能不 settle 也不抛错 */
class HangingDecodeContext extends FakeAudioContext {
  override decodeAudioData(): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>(() => undefined);
  }
}

test("T9 解码永不 settle 时 schedule 必须在有限时间内抛错（回归：running 永久卡住、后续全静默）", async () => {
  const restore = stubMediaApis();
  try {
    const ctx = new HangingDecodeContext();
    const player = new WebAudioClipPlayer(() => ctx as unknown as AudioContext, 20, 20);
    await player.prepare();
    const started = Date.now();
    await assert.rejects(
      () => player.schedule("blob:hang", GAP_FIRST_MS),
      (error: unknown) => error instanceof Error && /音频解码超时/.test(error.message),
      "超时必须抛错，队列才能跳过这一块继续消费"
    );
    assert.ok(Date.now() - started < 1000, `不能无限等下去，实际 ${Date.now() - started}ms`);
    assert.equal(ctx.sources.length, 0, "超时后不能还把 source 排到时间轴上");
  } finally {
    restore();
  }
});
