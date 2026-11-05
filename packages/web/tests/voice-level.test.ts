/**
 * 录音电平可视化单测（web/voice/level）
 *
 * 这些函数决定"检测条怎么动"，而检测条存在的唯一目的是让用户相信
 * **麦克风在收东西**。所以断言的重点不是数值精度，而是三件事：
 *
 * 1. 一开口就得动（attack 够快）——否则用户以为没连上，会重复说
 * 2. 字间气口不能把条打回零（release 够慢）——否则条会闪成断续的碎片
 * 3. 真静音时必须是 0 且被标成"没信号"——这一条错了，提示语就会骗人
 *
 * 量化到档位是性能手段（只有跨档才触发 React 重渲染），顺带也是视觉上的
 * 台阶：12 格逐格亮。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAR_FLOOR,
  LEVEL_ATTACK,
  LEVEL_BUCKETS,
  LEVEL_FULL_SCALE,
  LEVEL_RELEASE,
  SILENCE_PEAK,
  barHeight,
  barWeight,
  isSignalAbsent,
  nextSmoothedLevel,
  quantizeLevel,
} from "../web/src/voice/level";

test("L1 上升用 attack 系数：第一帧就把条推到可观高度", () => {
  const first = nextSmoothedLevel(0, 0.2);
  assert.equal(first, 0.2 * LEVEL_ATTACK);
  // 2 帧（100ms）内必须超过原始值的 80%：第一个字被看见的时限
  const second = nextSmoothedLevel(first, 0.2);
  assert.ok(second > 0.2 * 0.8, `两帧后应接近原始值，实际 ${second}`);
});

test("L2 下降用 release 系数：一帧静音不会把条打回零", () => {
  const loud = 0.3;
  const dipped = nextSmoothedLevel(loud, 0.01);
  assert.equal(dipped, loud + (0.01 - loud) * LEVEL_RELEASE);
  assert.ok(dipped > loud * 0.8, "字间气口应只让条轻微回落，而不是归零");
});

test("L3 attack 必须比 release 快（否则是拖影，不是电平）", () => {
  assert.ok(LEVEL_ATTACK > LEVEL_RELEASE);
});

test("L4 量化只产出 12 档的离散值", () => {
  const seen = new Set<number>();
  for (let rms = 0; rms <= 1.2; rms += 0.01) {
    const q = quantizeLevel(rms);
    const steps = q * LEVEL_BUCKETS;
    assert.equal(Math.round(steps), steps, `量化结果 ${q} 不在 1/${LEVEL_BUCKETS} 的整数倍上`);
    seen.add(q);
  }
  assert.equal(seen.size, LEVEL_BUCKETS + 1, "0 到满格应恰好覆盖 13 个取值");
});

test("L5 正常说话音量已到半程以上，不必喊话才满格", () => {
  // 0.15 的 RMS 是常态说话的中位水平
  const q = quantizeLevel(0.15);
  assert.ok(q >= 0.35 && q <= 0.6, `0.15 的 RMS 应落在 35%~60%，实际 ${q}`);
  // 满量程按 0.35 标定：超过就一律满格
  assert.equal(quantizeLevel(LEVEL_FULL_SCALE * 2), 1);
  assert.equal(quantizeLevel(LEVEL_FULL_SCALE), 1);
});

test("L6 负值归 0、NaN 断路、Infinity 满格：脏值不能漏进样式", () => {
  assert.equal(quantizeLevel(-0.3), 0);
  assert.equal(quantizeLevel(Number.NaN), 0);
  assert.equal(quantizeLevel(Number.POSITIVE_INFINITY), 1);
  // 累加器一旦吃到 NaN 会永久中毒（每帧 NaN → 条永远是零），必须断路
  assert.equal(nextSmoothedLevel(Number.NaN, 0.2), 0);
  assert.equal(nextSmoothedLevel(0.2, Number.NaN), 0);
});

test("L7 无信号判定看峰值：底噪算没信号、人声算有信号", () => {
  assert.equal(isSignalAbsent(0), true);
  assert.equal(isSignalAbsent(0.008), true, "典型环境底噪应判为无信号");
  assert.equal(isSignalAbsent(SILENCE_PEAK - 0.001), true);
  assert.equal(isSignalAbsent(SILENCE_PEAK), false);
  assert.equal(isSignalAbsent(0.09), false, "正常说话必须判为有信号");
});

test("L8 阶梯条中间高、两侧低，且静音时仍有底座", () => {
  const count = LEVEL_BUCKETS;
  const center = barWeight(5, count);
  const edge = barWeight(0, count);
  assert.ok(center > edge, "中间格应比边缘格高");
  assert.equal(barWeight(0, count), barWeight(count - 1, count), "左右应对称");

  const silent = barHeight(5, count, 0);
  assert.equal(silent, BAR_FLOOR, "静音时就该停在底座，让用户看见检测条存在");
  assert.ok(silent > 0 && silent < 0.25);
  // 12 是偶数，没有正好居中的那一格：中间两格（5、6）都只在 0.95 上下
  assert.ok(barHeight(5, count, 1) > 0.94, "满格时中心格应接近到头");
});

test("L9 同一电平下中间格不矮于边缘格（波形感）", () => {
  for (const level of [0.2, 0.5, 1]) {
    assert.ok(barHeight(5, LEVEL_BUCKETS, level) >= barHeight(0, LEVEL_BUCKETS, level));
  }
});

test("L10 单格退化不除零", () => {
  assert.equal(barWeight(0, 1), 1);
  assert.equal(barHeight(0, 1, 0.5), BAR_FLOOR + 0.5 * (1 - BAR_FLOOR));
});
