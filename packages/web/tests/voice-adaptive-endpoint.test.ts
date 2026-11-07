/**
 * 动态端点窗与回馈语 HOLD 回归（2026-11-07 自由交互 P0 #82）
 *
 * 两条纪律：
 * 1. `Endpointer` 默认必须仍是固定 900ms —— 既有 10+ 用例与老用户行为零回归；
 * 2. 自适应只压「正常一句话」，短语与长叙述保持保守窗。没有流式 ASR，
 *    判停时拿不到部分转写文本，不能用臆测的语义去激进切句。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ENDPOINT_ADAPTIVE_SILENCE_MS,
  ENDPOINT_FAST_SILENCE_MS,
  ENDPOINT_FRAME_MS,
  ENDPOINT_SILENCE_MS,
  Endpointer,
  type EndpointOptions,
  type EndpointVerdict,
} from "../web/src/voice/endpointing";
import {
  BACKCHANNEL_HOLD_KEY,
  ENDPOINT_PROFILE_KEY,
  defaultEndpointProfile,
  readBackchannelHold,
  readEndpointProfile,
  writeBackchannelHold,
  writeEndpointProfile,
} from "../web/src/voice/preference";
import { BackchannelGate, VAD_FRAME_MS } from "../web/src/voice/mic";

const LOUD = 0.8;
const QUIET = 0.01;
const FRAME = ENDPOINT_FRAME_MS;

/** 用固定阈值构造（关掉噪声底自适应，让断言只测窗口逻辑） */
function make(options: EndpointOptions = {}): Endpointer {
  return new Endpointer({ threshold: 0.5, ...options });
}

function feed(endpointer: Endpointer, rms: number, frames: number): EndpointVerdict[] {
  const verdicts: EndpointVerdict[] = [];
  for (let i = 0; i < frames; i += 1) verdicts.push(endpointer.push(rms));
  return verdicts;
}

const frames = (ms: number): number => Math.ceil(ms / FRAME);

test("E1 legacy（缺省档）仍是固定 900ms，零回归", () => {
  const e = make();
  feed(e, LOUD, frames(700));
  const before = feed(e, QUIET, frames(ENDPOINT_SILENCE_MS) - 1);
  assert.equal(before.at(-1)?.done, false);
  assert.equal(before.at(-1)?.silenceGoalMs, ENDPOINT_SILENCE_MS);
  const after = feed(e, QUIET, 1);
  assert.equal(after.at(-1)?.done, true);
});

test("E2 adaptive 把正常一句话压到 600ms", () => {
  const e = make({ profile: "adaptive" });
  feed(e, LOUD, frames(700));
  const before = feed(e, QUIET, frames(ENDPOINT_ADAPTIVE_SILENCE_MS) - 1);
  assert.equal(before.at(-1)?.done, false);
  assert.equal(before.at(-1)?.silenceGoalMs, ENDPOINT_ADAPTIVE_SILENCE_MS);
  assert.equal(feed(e, QUIET, 1).at(-1)?.done, true);
});

test("E3 adaptive 对短语保持 900ms，不把「嗯」急着送出去", () => {
  const e = make({ profile: "adaptive" });
  feed(e, LOUD, frames(300));
  const before = feed(e, QUIET, frames(ENDPOINT_ADAPTIVE_SILENCE_MS) + 1);
  assert.equal(before.at(-1)?.done, false, "600ms 静音还不足以判停短语");
  assert.equal(before.at(-1)?.silenceGoalMs, ENDPOINT_SILENCE_MS);
  const rest = feed(e, QUIET, frames(ENDPOINT_SILENCE_MS) - before.length - 1);
  assert.equal(rest.at(-1)?.done, false);
  assert.equal(feed(e, QUIET, 1).at(-1)?.done, true);
});

test("E4 adaptive 对长叙述保持 900ms，避免从句内停顿切断", () => {
  const e = make({ profile: "adaptive" });
  feed(e, LOUD, frames(3100));
  const v = feed(e, QUIET, frames(ENDPOINT_ADAPTIVE_SILENCE_MS) + 2).at(-1);
  assert.equal(v?.done, false);
  assert.equal(v?.silenceGoalMs, ENDPOINT_SILENCE_MS);
});

test("E5 fast 档正常句 350ms 判停（A/B 用，默认不开）", () => {
  const e = make({ profile: "fast" });
  feed(e, LOUD, frames(700));
  const before = feed(e, QUIET, frames(ENDPOINT_FAST_SILENCE_MS) - 1);
  assert.equal(before.at(-1)?.done, false);
  assert.equal(before.at(-1)?.silenceGoalMs, ENDPOINT_FAST_SILENCE_MS);
  assert.equal(feed(e, QUIET, 1).at(-1)?.done, true);
});

test("E6 显式 silenceMs 始终压过档位（单测精确复现优先）", () => {
  const e = make({ profile: "fast", silenceMs: 1000 });
  feed(e, LOUD, frames(700));
  const before = feed(e, QUIET, frames(900));
  assert.equal(before.at(-1)?.done, false);
  assert.equal(before.at(-1)?.silenceGoalMs, 1000);
  assert.equal(feed(e, QUIET, frames(100)).at(-1)?.done, true);
});

test("E7 静音等待期间档位不跳变（窗口对一次停顿恒定）", () => {
  const e = make({ profile: "adaptive" });
  feed(e, LOUD, frames(700));
  const goals = feed(e, QUIET, frames(ENDPOINT_ADAPTIVE_SILENCE_MS) - 1).map((v) => v.silenceGoalMs);
  assert.ok(goals.length > 1);
  assert.equal(new Set(goals).size, 1, `窗口不该在静音期间跳档：${goals.join(",")}`);
});

test("E8 reset 后重新按新一段已说时长取窗", () => {
  const e = make({ profile: "adaptive" });
  feed(e, LOUD, frames(700));
  e.reset();
  feed(e, LOUD, frames(300));
  assert.equal(feed(e, QUIET, 1).at(-1)?.silenceGoalMs, ENDPOINT_SILENCE_MS, "复位后是短语，回到保守窗");
});

test("E9 偏好：默认 adaptive、可回滚 legacy、非法值回落、HOLD 默认关", () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  try {
    assert.equal(defaultEndpointProfile(), "adaptive");
    assert.equal(readEndpointProfile(), "adaptive");
    assert.equal(readBackchannelHold(), false);
    writeEndpointProfile("legacy");
    assert.equal(store.get(ENDPOINT_PROFILE_KEY), "legacy");
    assert.equal(readEndpointProfile(), "legacy", "legacy 是完整回滚开关");
    writeEndpointProfile("fast");
    assert.equal(readEndpointProfile(), "fast");
    store.set(ENDPOINT_PROFILE_KEY, "nonsense");
    assert.equal(readEndpointProfile(), "adaptive", "坏配置不能把端点判定卡死");
    writeBackchannelHold(true);
    assert.equal(store.get(BACKCHANNEL_HOLD_KEY), "1");
    assert.equal(readBackchannelHold(), true);
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

// ---- 回馈语 HOLD（播报期打断）----

test("E10 不开 HOLD 时行为与原来逐字一致：连续 300ms 触发一次", () => {
  const gate = new BackchannelGate({ frameMs: VAD_FRAME_MS });
  const results = Array.from({ length: 8 }, () => gate.push(true));
  assert.deepEqual(results, [false, false, false, false, false, true, false, false]);
});

test("E11 HOLD 开启后短促回馈语不打断，持续插话到 500ms 才打断", () => {
  const short = new BackchannelGate({ hold: true, frameMs: VAD_FRAME_MS });
  // 7 帧人声（350ms）+ 2 帧静音（100ms）→ 回馈语，全程不触发
  const backchannel = [
    ...Array.from({ length: 7 }, () => short.push(true)),
    ...Array.from({ length: 4 }, () => short.push(false)),
  ];
  assert.equal(backchannel.some(Boolean), false);

  const real = new BackchannelGate({ hold: true, frameMs: VAD_FRAME_MS });
  const results = Array.from({ length: 11 }, () => real.push(true));
  assert.equal(results.slice(0, 9).some(Boolean), false, "450ms 前不打断");
  assert.equal(results[9], true, "第 500ms 判为真实插话");
});

test("E12 HOLD 不会永久屏蔽后续插话，也不会把不连续噪声攒够", () => {
  const gate = new BackchannelGate({ hold: true, frameMs: VAD_FRAME_MS });
  Array.from({ length: 7 }, () => gate.push(true)); // 回馈语
  Array.from({ length: 3 }, () => gate.push(false)); // 段后静音清零
  const second = Array.from({ length: 10 }, () => gate.push(true)); // 真的要插话
  assert.equal(second[9], true, "新一轮持续说话仍能打断");

  const noisy = new BackchannelGate({ frameMs: VAD_FRAME_MS });
  const mixed = [
    ...Array.from({ length: 3 }, () => noisy.push(true)),
    noisy.push(false),
    ...Array.from({ length: 3 }, () => noisy.push(true)),
  ];
  assert.equal(mixed.some(Boolean), false, "中断后 hot 清零，不累计零碎噪声");
});
