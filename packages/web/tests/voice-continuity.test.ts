/**
 * 语音连贯性专项回归（编排层）
 *
 * 已有的 voice-*.test.ts 各自锁一个零件：切句器、队列健壮性、排程参数、
 * 总线看门狗。这里专门把「连贯性」当作跨模块契约来钉：
 *
 * - C1 长会话文本连贯：连续 20 轮 SSE 喂句（含故意缺收尾的轮次），每轮
 *   都必须出声，且所有句子拼回去恰好等于原文——不丢字、不重念。
 * - C2 流式块时间轴 gapless：连续块按采样点首尾相接，中间 0 缝隙。
 * - C3 连续块保留句内静音：流式块里的语义停顿不能被「裁首尾静音」
 *   逻辑吃掉，否则用户听到的是「讲了几句中间就断了」。
 * - C4 流式路径契约：每块 gap=0 且带 continuous 标记，顺序 = 原文顺序。
 *
 * 音频信号层的客观指标（语速/音色/边界 click/多轮延迟）由
 * scripts/voice/check_continuity.py 负责，两层互不替代。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SentenceStream, isNewTurnText, stripForSpeech } from "../web/src/voice/sentence";
import { WebAudioClipPlayer } from "../web/src/voice/playout";
import type { ClipPlayer, PlayOutcome, ScheduledClip, ScheduleOptions } from "../web/src/voice/playout";
import { SpeechQueue } from "../web/src/voice/player";
import type { StreamSynthFn } from "../web/src/voice/player";

const SR = 24000;

/** 等到条件成立 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 造静音 + 正弦有声的样本 */
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

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * SR));
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

/** 记录 start(when, offset, duration) 的假 source */
class TimelineSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  when = 0;
  offset = 0;
  duration = 0;

  connect(): void {
    // 假图
  }

  disconnect(): void {
    // 同上
  }

  start(when: number, offset: number, duration: number): void {
    this.when = when;
    this.offset = offset;
    this.duration = duration;
  }

  stop(): void {
    this.onended?.();
  }
}

/** 假 AudioContext：currentTime 恒定，便于把 gapless 变成算术断言 */
class TimelineContext {
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = {} as AudioDestinationNode;
  readonly sources: TimelineSource[] = [];
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
    const source = new TimelineSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  decodeAudioData(): Promise<AudioBuffer> {
    const next = this.buffers.shift();
    return next === undefined ? Promise.reject(new Error("没有更多假 buffer")) : Promise.resolve(next);
  }
}

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

// ---------------------------------------------------------------------------
// C1 长会话文本连贯
// ---------------------------------------------------------------------------

/**
 * 模拟 `useVoiceTalk.feed()` 的真实语义：SSE 给的是累积 previewText，
 * 每次先做轮次边界自检（isNewTurnText），再走 SentenceStream 游标。
 * 每 4 轮故意漏一次 finishFeed（工具轮 / 断线重连 / 用户打断的真实形态）。
 */
const TURNS = [
  "第一句真的很短。",
  "第二句稍微长一些，用来确认弱断句符不会把整段切成电报式的碎句，最后在这里收住。",
  "第三句讲的是回滚路径，先把失败分支理清楚，再补上行分支的验证。",
  "第四句故意不调收尾，模拟工具轮把 assistant_message 事件吞掉的情况。",
  "第五句换个完全不同的开头，好让前缀自检一定能识别出新一轮。",
  "第六句里有一个英文片段 continuity check，还有数字 2048，但整体仍然是中文。",
  "第七句带一个问号吗？带一个感叹号！再补一个省略号……这样就够了。",
  "第八句同样不收尾，而且比上一句短，用来触发长度回退这条判定路径。",
];

test("C1 连续 20 轮（含缺收尾轮次）：每轮都出声，且句子拼回去等于原文", () => {
  const stream = new SentenceStream();
  const spoken: string[] = [];
  const perTurn: number[] = [];
  let turnText = "";
  const totalTurns = 20;

  for (let turn = 0; turn < totalTurns; turn += 1) {
    // 补充句不加前导空格：切句器按句 trim，整轮 stripForSpeech 却会保留
    // 句间空格，两边对照时会被误判成「丢了一个空格」。
    const text = TURNS[turn % TURNS.length] + (turn >= TURNS.length ? `第${turn + 1}轮补充一句。` : "");
    const before = spoken.length;
    // 逐帧喂累积文本（SSE llm_delta 的真实形态）
    for (let at = 1; at <= text.length; at += 3) {
      const cumulative = text.slice(0, at);
      if (isNewTurnText(turnText, cumulative)) {
        // 轮次自检触发时，先把上一轮残句补念出来——这正是 voice-bus
        // 重连边沿看门狗（宽限期到点后 finishVoice）的行为。缺
        // assistant_message 会晚一拍收尾，但不会永久丢字。
        spoken.push(...stream.flush(turnText));
        stream.reset();
        turnText = "";
      }
      turnText = cumulative;
      spoken.push(...stream.push(cumulative));
    }
    // SSE 的最后一帧一定是完整累积文本；步长 3 可能跳过最后一个字（尤其句号），
    // 补齐这一帧才不会把「少一个标点」误判成丢字。
    if (turnText !== text) {
      spoken.push(...stream.push(text));
      turnText = text;
    }
    // 每 4 轮漏一次收尾：游标带着上一轮的残留进入下一轮
    const missingFinish = turn % 4 === 3;
    if (!missingFinish) {
      spoken.push(...stream.flush(text));
      stream.reset();
      turnText = "";
    }
    perTurn.push(spoken.length - before);
  }
  // 最后一轮恰好也是缺收尾轮次：补一次看门狗收尾，避免尾巴留在游标后面
  if (turnText.length > 0) {
    spoken.push(...stream.flush(turnText));
    stream.reset();
  }

  assert.equal(perTurn.length, totalTurns);
  assert.ok(
    perTurn.every((count) => count > 0),
    `任何一轮都不能静默，实际每轮句数：${perTurn.join(",")}`
  );
  // 缺收尾后的下一轮必须靠 isNewTurnText 自检恢复
  for (const missing of [3, 7, 11, 15, 19]) {
    if (missing + 1 < totalTurns) {
      assert.ok(perTurn[missing + 1] > 0, `第 ${missing + 2} 轮应从缺收尾状态恢复`);
    }
  }

  const expected = Array.from({ length: totalTurns }, (_, turn) => {
    const text = TURNS[turn % TURNS.length] + (turn >= TURNS.length ? `第${turn + 1}轮补充一句。` : "");
    return stripForSpeech(text);
  }).join("");
  assert.equal(spoken.join(""), expected, "所有句子拼回去必须恰好等于原文：不丢字、不重念");
});

// ---------------------------------------------------------------------------
// C2 / C3 时间轴与静音保留
// ---------------------------------------------------------------------------

test("C2 流式连续块按采样点首尾相接：相邻块缝隙为 0", async () => {
  const restore = stubMediaApis();
  const ctx = new TimelineContext();
  for (let i = 0; i < 5; i += 1) ctx.buffers.push(fakeBuffer(makeSamples(0, 300, 0)));
  const player = new WebAudioClipPlayer(() => ctx as unknown as AudioContext);
  try {
    await player.prepare();
    for (let i = 0; i < 5; i += 1) {
      await player.schedule(`blob:${i}`, 0, { continuous: true });
    }
    assert.equal(ctx.sources.length, 5);
    for (let i = 1; i < ctx.sources.length; i += 1) {
      const prev = ctx.sources[i - 1];
      const cur = ctx.sources[i];
      assert.equal(cur.offset, 0, "连续块不能裁句首");
      assert.ok(
        Math.abs(cur.when - (prev.when + prev.duration)) < 1e-9,
        `第 ${i + 1} 块应紧接第 ${i} 块，实际缝隙 ${((cur.when - prev.when - prev.duration) * 1000).toFixed(3)}ms`
      );
    }
    // 整块时长完整进入时间轴，没有 TAIL_KEEP 补尾
    assert.ok(Math.abs(ctx.sources[0].duration - 0.3) < 1e-6);
  } finally {
    player.dispose();
    restore();
  }
});

test("C3 流式块内的语义停顿必须完整保留（整句模式才会裁首尾）", async () => {
  const restore = stubMediaApis();
  // 100ms 首 padding + 200ms 有声 + 400ms 语义停顿 + 200ms 有声 + 100ms 尾 padding
  const samples = concat(silence(100), makeSamples(0, 200, 0), silence(400), makeSamples(0, 200, 0), silence(100));
  const continuousCtx = new TimelineContext();
  continuousCtx.buffers.push(fakeBuffer(samples));
  const continuousPlayer = new WebAudioClipPlayer(() => continuousCtx as unknown as AudioContext);
  const plainCtx = new TimelineContext();
  plainCtx.buffers.push(fakeBuffer(samples));
  const plainPlayer = new WebAudioClipPlayer(() => plainCtx as unknown as AudioContext);
  try {
    await continuousPlayer.prepare();
    await continuousPlayer.schedule("blob:continuous", 0, { continuous: true });
    await plainPlayer.prepare();
    await plainPlayer.schedule("blob:plain", 0);

    const continuous = continuousCtx.sources[0];
    const plain = plainCtx.sources[0];
    assert.ok(
      Math.abs(continuous.duration - samples.length / SR) < 1e-6,
      `连续块必须整块进入时间轴，实际 ${continuous.duration}s / 应为 ${samples.length / SR}s`
    );
    assert.equal(continuous.offset, 0, "连续块不能裁掉 100ms 句首 padding");
    // 首尾各 100ms padding 被裁掉，但整句模式要补回 TAIL_KEEP_MS(60ms) 尾音：
    // 200ms - 60ms = 140ms 差值。锁住具体数值，避免只测「有差」的弱断言。
    assert.ok(
      Math.abs(continuous.duration - plain.duration - 0.14) < 0.005,
      `整句模式应裁掉首尾 padding 并补 60ms 尾音，差值应 0.140s，实际 ${(continuous.duration - plain.duration).toFixed(3)}s`
    );
  } finally {
    continuousPlayer.dispose();
    plainPlayer.dispose();
    restore();
  }
});

// ---------------------------------------------------------------------------
// C4 流式路径契约
// ---------------------------------------------------------------------------

/** 记录每次排程的 gap 与 continuous 标记 */
class RecordingPlayer implements ClipPlayer {
  readonly maxLead = 8;
  readonly calls: { url: string; gap: number; continuous: boolean | undefined }[] = [];

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  schedule(url: string, gap: number, options?: ScheduleOptions): Promise<ScheduledClip> {
    this.calls.push({ url, gap, continuous: options?.continuous });
    // done 故意不 settle：本用例只关心排程参数，不关心播放收尾
    return Promise.resolve({ done: new Promise<PlayOutcome>(() => undefined) });
  }

  stop(): void {
    // 无状态
  }

  dispose(): void {
    // 无资源
  }
}

test("C4 流式三块连续送达：gap 全为 0、标记 continuous、顺序与原文一致", async () => {
  const restore = stubMediaApis();
  const player = new RecordingPlayer();
  const synthCalls: string[] = [];
  const streamSynth: StreamSynthFn = async (text, onChunk) => {
    synthCalls.push(text);
    for (let i = 0; i < 3; i += 1) onChunk(`blob:${text}-${i}`, i);
    return 3;
  };
  const queue = new SpeechQueue(
    async (text) => `blob:fallback-${text}`,
    {},
    {
      player,
      createFallbackPlayer: () => player,
      streamSynth,
      firstBlockChars: 1,
      blockChars: 1,
      warmupChars: 1,
    }
  );
  try {
    queue.enqueue("第一句。");
    queue.flush();
    await waitFor(() => player.calls.length === 3);
    assert.deepEqual(synthCalls, ["第一句。"], "一个文本块只启动一次流式合成");
    assert.deepEqual(
      player.calls.map((call) => call.url),
      ["blob:第一句。-0", "blob:第一句。-1", "blob:第一句。-2"],
      "时间轴顺序必须等于 chunk 到达顺序"
    );
    for (const call of player.calls) {
      assert.equal(call.gap, 0, "连续块之间不能插标点停顿");
      assert.equal(call.continuous, true, "连续块必须带 continuous 标记");
    }
  } finally {
    queue.stop();
    restore();
  }
});
