/**
 * 唤醒监听循环单测（web/voice/wake-listener）
 *
 * 真机测不了这里：CI 没有麦克风，也没人喊唤醒词。但**编排**是可以断言的——
 * 用假采集器喂预置片段，验证四件事：
 *
 * 1. 空段（没人说话）不进识别——否则纯静音也要跑一次 Whisper；
 * 2. 命中唤醒词就回调，并且自己停掉（不能继续占麦克风）；
 * 3. 没命中就继续听下一段；
 * 4. 识别失败要停并报错，不能刷屏重试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WakeListener, type WakeCapture } from "../web/src/voice/wake-listener";
import type { EndpointOptions, EndpointVerdict } from "../web/src/voice/endpointing";

/** 一段预置的采集结果 */
type FakeSegment = { idle: boolean };

/**
 * 假采集器：每次 startRecording 取一段，异步回调判定结果
 *
 * 段用完后不再回调（模拟"一直在录但没人说话"），由 stop() 收尾。
 */
class FakeCapture implements WakeCapture {
  /** 剩余待录的段 */
  private readonly segments: FakeSegment[];
  /** startRecording 被调用的次数 */
  readonly starts: number[] = [];
  /** 是否已释放 */
  released = false;
  /** 最近一次收到的判定参数（验证 idleMs 有没有传下去） */
  lastEndpoint: EndpointOptions | undefined;

  constructor(segments: FakeSegment[]) {
    this.segments = [...segments];
  }

  async open(): Promise<void> {
    // 打开成功
  }

  async startRecording(
    _onMax?: () => void,
    options?: { onEndpoint?: (verdict: EndpointVerdict) => void; endpoint?: EndpointOptions }
  ): Promise<void> {
    this.starts.push(this.starts.length);
    this.lastEndpoint = options?.endpoint;
    const segment = this.segments.shift();
    if (segment === undefined) return;
    queueMicrotask(() => {
      options?.onEndpoint?.({
        active: false,
        done: true,
        idle: segment.idle,
        speechMs: segment.idle ? 0 : 600,
        silenceMs: 900,
      });
    });
  }

  async stopRecording(): Promise<Blob> {
    return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  }

  release(): void {
    this.released = true;
  }
}

/**
 * 等到条件成立（或超时）
 *
 * 循环是 `void this.loop()` 起的，测试只能等它跑到预期状态。
 *
 * @param predicate 条件
 * @param timeoutMs 超时
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待条件超时");
}

test("L1 空段不进识别，命中唤醒词后回调并自行停止", async () => {
  const capture = new FakeCapture([{ idle: true }, { idle: true }, { idle: false }]);
  const transcripts: Blob[] = [];
  const woke: string[] = [];

  const listener = new WakeListener({
    createCapture: () => capture,
    wakeWord: "司南",
    transcribe: async (audio) => {
      transcripts.push(audio);
      return "司南，帮我看下时间";
    },
    onWake: (text) => woke.push(text),
  });

  await listener.start();
  await waitFor(() => woke.length > 0);

  assert.equal(transcripts.length, 1, "两个空段应被丢弃，只有人声段送去识别");
  assert.equal(woke[0], "司南，帮我看下时间");
  assert.equal(listener.listening, false, "命中后要自己停掉，不能继续占着麦克风");
  assert.equal(capture.released, true, "停止时要释放麦克风");
  assert.equal(capture.lastEndpoint?.idleMs !== undefined, true, "空段超时要传给判定器");
});

test("L2 没命中就继续听下一段", async () => {
  const capture = new FakeCapture([{ idle: false }, { idle: false }]);
  const heard: string[] = [];
  const woke: string[] = [];
  const replies = ["今天天气不错", "司南你在吗"];

  const listener = new WakeListener({
    createCapture: () => capture,
    wakeWord: "司南",
    transcribe: async () => {
      const next = replies[heard.length] ?? "";
      heard.push(next);
      return next;
    },
    onWake: (text) => woke.push(text),
  });

  await listener.start();
  await waitFor(() => woke.length > 0);

  assert.deepEqual(heard, ["今天天气不错", "司南你在吗"], "第一段没命中要继续听");
  assert.equal(woke.length, 1);
});

test("L3 识别失败要停并报错，不重试", async () => {
  const capture = new FakeCapture([{ idle: false }, { idle: false }, { idle: false }]);
  const errors: string[] = [];

  const listener = new WakeListener({
    createCapture: () => capture,
    wakeWord: "司南",
    transcribe: async () => {
      throw new Error("语音服务不可达");
    },
    onWake: () => {
      throw new Error("不该被唤醒");
    },
    onError: (message) => errors.push(message),
  });

  await listener.start();
  await waitFor(() => errors.length > 0);

  assert.equal(errors[0], "语音服务不可达");
  assert.equal(listener.listening, false, "出错后必须停，避免错误风暴");
  assert.equal(capture.starts.length, 1, "只尝试了一段，没有反复重试");
});

test("L4 stop() 幂等，且 stop 之后不再唤醒", async () => {
  const capture = new FakeCapture([{ idle: false }, { idle: false }]);
  const woke: string[] = [];

  const listener = new WakeListener({
    createCapture: () => capture,
    wakeWord: "司南",
    transcribe: async () => "司南帮我看下",
    onWake: (text) => woke.push(text),
  });

  await listener.start();
  listener.stop();
  listener.stop();
  assert.equal(listener.listening, false);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(woke.length, 0, "stop 之后不该再回调唤醒");
});
