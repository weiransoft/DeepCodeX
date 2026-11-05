/**
 * 噪声底估计单测（web/voice/noise-floor）
 *
 * 这个模块的存在理由就是"绝对阈值有两类必然失败的用户"。所以断言直接按
 * 那两类人来写，而不是按公式写：
 *
 * - **低增益麦克风**：正常说话只有 0.02~0.04，旧阈值 0.05 永远判不成人声
 * - **高噪声环境**：底噪 0.03~0.06，旧阈值以下的部分永远是"静音"，永远
 *   等不到收尾
 *
 * 另外两条防退化断言（噪声底不被喊话顶飞、NaN 不污染）是这类"自适应"代码
 * 最容易写崩的地方。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOISE_FLOOR_CALIBRATION_FRAMES,
  NOISE_FLOOR_CAP,
  NOISE_FLOOR_FACTOR,
  NoiseFloorTracker,
  rmsThreshold,
} from "../web/src/voice/noise-floor";

/** 连喂 n 帧，返回最终的噪声底 */
function feed(tracker: NoiseFloorTracker, rms: number, frames: number, active = false): number {
  let floor = tracker.value;
  for (let i = 0; i < frames; i += 1) floor = tracker.observe(rms, active);
  return floor;
}

test("N1 安静房间：噪声底落在底噪附近，阈值仍在低档（不会把轻声说话判成静音）", () => {
  const tracker = new NoiseFloorTracker();
  const floor = feed(tracker, 0.006, 20);
  assert.ok(floor <= 0.008, `噪声底应贴着环境底噪，实际 ${floor}`);
  const threshold = rmsThreshold(floor);
  assert.ok(threshold <= 0.02, `安静房间阈值不能高，实际 ${threshold}`);
});

test("N2 低增益麦克风：说话 0.03 也要判成人声（旧绝对阈值 0.05 会漏）", () => {
  const tracker = new NoiseFloorTracker();
  // 先让环境安静 600ms，把底噪学到 0.008
  feed(tracker, 0.008, 12, false);
  const threshold = rmsThreshold(tracker.value);
  assert.ok(0.03 >= threshold, `说话 0.03 必须过阈值，实际阈值 ${threshold}`);
  assert.ok(0.03 < 0.05, "前提：这个音量确实低于旧阈值");
});

test("N3 高噪声环境：底噪 0.03 本身不能判成人声", () => {
  const tracker = new NoiseFloorTracker();
  const floor = feed(tracker, 0.03, 20, false);
  const threshold = rmsThreshold(floor);
  assert.ok(0.03 < threshold, `底噪必须低于阈值，实际阈值 ${threshold}`);
  // 但正常说话仍要过得去
  assert.ok(0.2 >= threshold, "嘈杂环境里的正常说话必须仍被判成人声");
});

test("N4 标定期取最小值：用户一按下就开口，噪声底也不该被说话拉高", () => {
  const tracker = new NoiseFloorTracker();
  // 前 6 帧（标定期）：4 帧在说话、2 帧是气口
  for (let i = 0; i < 4; i += 1) tracker.observe(0.25, true);
  tracker.observe(0.01, false);
  const floor = tracker.observe(0.012, false);
  assert.ok(floor <= 0.012, `应取窗口最小值，实际 ${floor}`);
  assert.equal(tracker.calibrating, false, "标定期已结束");
});

test("N5 一次喊话不能把噪声底顶到上限（floor 永不超过当帧 RMS）", () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, 0.005, 10, false); // 安静
  const before = tracker.value;
  const after = feed(tracker, 0.9, 200, true); // 持续喊 10 秒
  assert.ok(after <= NOISE_FLOOR_CAP, `噪声底必须被上限挡住，实际 ${after}`);
  assert.ok(after >= before, "上浮方向不能反");
  const threshold = rmsThreshold(after);
  assert.ok(threshold <= 0.09, `阈值上限 0.09，实际 ${threshold}`);
});

test("N6 环境安静下来立刻下探（不能在高阈值上赖好几秒）", () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, 0.03, 20, false); // 吵
  const loud = rmsThreshold(tracker.value);
  feed(tracker, 0.003, 1, false); // 一帧安静
  const quiet = rmsThreshold(tracker.value);
  assert.ok(quiet < loud, `应当立即下探，吵时 ${loud}、静时 ${quiet}`);
  assert.ok(quiet <= 0.0125, `下探后阈值应回到低档，实际 ${quiet}`);
});

test("N7 阈值夹在 [0.012, 0.09]：噪声底为 0 或极高时都不越界", () => {
  assert.equal(rmsThreshold(0), 0.012, "噪声底为 0 时取下限，不能归零");
  assert.equal(rmsThreshold(0.0001), 0.012);
  assert.ok(rmsThreshold(NOISE_FLOOR_CAP) <= 0.09);
  assert.equal(rmsThreshold(10), 0.09, "离谱的噪声底要夹到上限");
  assert.equal(rmsThreshold(Number.NaN), 0.012, "NaN 要退回下限，不能算出 NaN");
});

test("N8 NaN 不污染噪声底（否则整段录音永远「没人说话」）", () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, 0.006, 10, false);
  const before = tracker.value;
  tracker.observe(Number.NaN, false);
  tracker.observe(-1, false);
  assert.equal(tracker.value, before, "非法值必须被忽略");
  assert.ok(Number.isFinite(rmsThreshold(tracker.value)));
});

test("N9 连续说话 10 秒后阈值仍在说话音量之下（不能把自己后半句判成静音）", () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, 0.006, 10, false);
  // 轻声说话 0.09，连续 200 帧（10 秒）
  const floor = feed(tracker, 0.09, 200, true);
  const threshold = rmsThreshold(floor);
  assert.ok(0.09 >= threshold, `阈值不能涨到说话音量之上，实际 ${threshold}`);
});

test("N10 reset 保留已学到的噪声底（同一间屋子不必每轮重新标定）", () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, 0.03, 20, false);
  const learned = tracker.value;
  tracker.reset();
  assert.equal(tracker.value, learned, "复位不应丢掉环境估计");
  assert.equal(tracker.calibrating, true, `复位会重新开一个标定窗口（${NOISE_FLOOR_CALIBRATION_FRAMES} 帧）`);
});

test("N11 倍数关系：阈值 = 噪声底 × 倍数（未触边界时）", () => {
  const tracker = new NoiseFloorTracker();
  feed(tracker, 0.01, 20, false);
  const threshold = rmsThreshold(tracker.value);
  assert.equal(threshold, tracker.value * NOISE_FLOOR_FACTOR);
});
