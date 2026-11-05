/**
 * 麦克风电平外报单测（web/voice/mic）
 *
 * 这条链路是用户"看不看得见麦克风在工作"的全部依据，所以测的不是音质，
 * 而是**采样循环的存在与边界**：
 *
 * - 按住说话（没有判定器）也必须跑循环——这是最常见的说话方式，漏了它
 *   等于给一半用户看一条永远不动的条
 * - 电平与说完判定必须共用同一帧：两个循环会各读各的，出现"条在动但
 *   判定说你在静音"这种自相矛盾
 * - 停下之后一帧都不能再回调：否则 React 卸载后仍 setState，白刷
 *
 * 浏览器 API（getUserMedia / MediaRecorder / AudioContext）全部用假件替换，
 * 真实音频不参与。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MicCapture } from "../web/src/voice/mic";
import type { EndpointVerdict } from "../web/src/voice/endpointing";

/** 假分析器：整帧填同一个幅度，RMS 就等于该幅度 */
class FakeAnalyser {
  fftSize = 1024;
  /** 本帧幅度（RMS） */
  amplitude = 0.1;

  getFloatTimeDomainData(buffer: Float32Array): void {
    buffer.fill(this.amplitude);
  }
}

/** 假 AudioContext：只提供音频图需要的最小接口 */
class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  analyser = new FakeAnalyser();
  closed = false;

  constructor() {
    FakeAudioContext.created.push(this);
  }

  createMediaStreamSource(): { connect: () => void } {
    return { connect: (): void => {} };
  }

  createAnalyser(): FakeAnalyser {
    return this.analyser;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** 假录音器：stop 时同步触发 onstop（与真实实现的事件语义一致） */
class FakeMediaRecorder {
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: unknown) {
    // 构造参数不参与断言
  }

  start(): void {
    // 无操作
  }

  stop(): void {
    this.onstop?.();
  }
}

/**
 * 装好浏览器假件
 *
 * @param t 测试上下文（用于自动还原）
 */
function installFakes(t: TestContext): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    navigator: globals.navigator,
    MediaRecorder: globals.MediaRecorder,
    AudioContext: globals.AudioContext,
  };
  FakeAudioContext.created = [];
  const stream = { active: true, getTracks: (): unknown[] => [] };

  globals.MediaRecorder = FakeMediaRecorder;
  globals.AudioContext = FakeAudioContext;
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => stream } },
    configurable: true,
  });

  t.after(() => {
    Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true });
    globals.MediaRecorder = saved.MediaRecorder;
    globals.AudioContext = saved.AudioContext;
  });
}

/** 取最新建的音频上下文（即录音期那个采样循环用的） */
function lastContext(): FakeAudioContext {
  const context = FakeAudioContext.created.at(-1);
  assert.ok(context !== undefined, "应当创建过 AudioContext");
  return context;
}

test("M1 按住说话也会上报电平：没有判定器时采样循环照样要跑", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  installFakes(t);
  const levels: number[] = [];
  const mic = new MicCapture();

  await mic.startRecording(undefined, { onLevel: (rms) => levels.push(rms) });
  t.mock.timers.tick(150);

  assert.equal(levels.length, 3, "50ms 一帧，150ms 应上报 3 帧");
  // Float32Array 存 0.1 会有精度损失（0.10000000149…），这里比的是"同一路数"
  assert.ok(Math.abs(levels[0] - 0.1) < 1e-6, "上报的是原始 RMS，不做平滑（平滑属于 UI 层）");
  mic.release();
});

test("M2 电平与说完判定共用同一帧：帧数一致，不会各读各的", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  installFakes(t);
  const levels: number[] = [];
  const verdicts: EndpointVerdict[] = [];
  const mic = new MicCapture();

  await mic.startRecording(undefined, {
    onLevel: (rms) => levels.push(rms),
    onEndpoint: (verdict) => verdicts.push(verdict),
  });
  const analyser = lastContext().analyser;

  // 8 帧（400ms）人声
  analyser.amplitude = 0.2;
  t.mock.timers.tick(400);
  assert.equal(levels.length, 8, "人声段每帧都要报电平");
  assert.equal(verdicts.length, 0, "还在说话，不能判说完");

  // 静音 1000ms：第 18 帧（900ms）判定说完，之后循环自停
  analyser.amplitude = 0.005;
  t.mock.timers.tick(1000);

  assert.equal(verdicts.length, 1, "静音够时长应判定说完，且只判一次");
  assert.equal(verdicts[0].idle, false, "前面说过话，不是空段");
  assert.equal(levels.length, 26, "8 帧人声 + 18 帧静音；判定后不再多报帧");
  mic.release();
});

test("M3 说完判定触发后循环自停，不再空转采样", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  installFakes(t);
  let levelFrames = 0;
  const mic = new MicCapture();

  await mic.startRecording(undefined, {
    onLevel: () => {
      levelFrames += 1;
    },
    onEndpoint: () => {
      // 判定后调用方通常立刻 stopRecording
    },
  });
  const analyser = lastContext().analyser;
  analyser.amplitude = 0.2;
  t.mock.timers.tick(400);
  analyser.amplitude = 0.005;
  t.mock.timers.tick(1000);
  const afterDone = levelFrames;

  t.mock.timers.tick(2000);
  assert.equal(levelFrames, afterDone, "判定完成后不应再有电平帧");
  assert.equal(lastContext().closed, true, "音频上下文应被关闭，释放系统资源");
  mic.release();
});

test("M4 释放后一帧都不再回调（避免卸载后仍 setState）", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  installFakes(t);
  let frames = 0;
  const mic = new MicCapture();

  await mic.startRecording(undefined, {
    onLevel: () => {
      frames += 1;
    },
  });
  t.mock.timers.tick(100);
  const before = frames;
  assert.ok(before > 0);

  mic.release();
  t.mock.timers.tick(500);
  assert.equal(frames, before, "释放之后不应再采样");
});

test("M5 两个回调都不给时不建 AudioContext（没人看就不必付这份开销）", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  installFakes(t);
  const mic = new MicCapture();

  await mic.startRecording(undefined, {});
  t.mock.timers.tick(200);

  assert.equal(FakeAudioContext.created.length, 0);
  mic.release();
});

test("M6 一次录音只建一个音频上下文：电平与判定不能拆成两条图", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  installFakes(t);
  const mic = new MicCapture();

  await mic.startRecording(undefined, {
    onLevel: () => {},
    onEndpoint: () => {},
  });
  t.mock.timers.tick(100);

  assert.equal(FakeAudioContext.created.length, 1);
  mic.release();
});
