/**
 * 说完判定单测（web/voice/endpointing）
 *
 * 这里测的是「什么时候该把话发出去」。判定错了的两个方向都很难受：
 *
 * - 太早：一句话说到一半被送去识别，用户得重说
 * - 太晚：说完等两秒才动，对话像在跨洋
 *
 * 因此断言分成三组：正常说完必须触发、噪声/咳嗽不能触发、
 * 句内停顿不能触发（最后一条是阈值能被接受的前提）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINT_FRAME_MS, ENDPOINT_SILENCE_MS, Endpointer } from "../web/src/voice/endpointing";
import { NoiseFloorTracker } from "../web/src/voice/noise-floor";

/**
 * 喂 n 帧给定 RMS，返回这一段里**是否出现过**判定，以及最后一帧的状态
 *
 * 必须收集"出现过"而不是只看最后一帧：`done` 只在一帧上为 true，
 * 继续喂静音就会变回 false，只看末帧会把已经触发过的判定漏掉。
 */
function feed(endpointer: Endpointer, rms: number, frames: number) {
  let last = endpointer.push(rms);
  let doneSeen = last.done;
  for (let i = 1; i < frames; i += 1) {
    last = endpointer.push(rms);
    doneSeen = doneSeen || last.done;
  }
  return { ...last, done: doneSeen };
}

test("E1 说够 400ms 再静音 900ms → 判定说完，且只判一次", () => {
  const endpointer = new Endpointer();
  feed(endpointer, 0.2, 8); // 400ms 人声
  const beforeDone = feed(endpointer, 0.01, Math.floor(ENDPOINT_SILENCE_MS / ENDPOINT_FRAME_MS) - 1);
  assert.equal(beforeDone.done, false, "还没静够时长，不能提前判定");

  const done = feed(endpointer, 0.01, 2);
  assert.equal(done.done, true, "静音够时长应判定说完");

  const again = feed(endpointer, 0.01, 10);
  assert.equal(again.done, false, "同一句话不能重复提交");
});

test("E2 全程静音 → 永不判定（不能把空录音发出去）", () => {
  const endpointer = new Endpointer();
  const verdict = feed(endpointer, 0.005, 40);
  assert.equal(verdict.done, false);
  assert.equal(endpointer.hasSpeech, false);
});

test("E3 短促噪声（100ms）后静音 → 不判定（咳嗽不是一句话）", () => {
  const endpointer = new Endpointer();
  feed(endpointer, 0.3, 2); // 100ms，低于 300ms 下限
  const verdict = feed(endpointer, 0.005, 40);
  assert.equal(verdict.done, false);
});

test("E4 句内停顿 500ms 后继续说话 → 不判定（不能把一句话切成两段）", () => {
  const endpointer = new Endpointer();
  feed(endpointer, 0.2, 10); // 500ms 人声
  const pause = feed(endpointer, 0.005, 10); // 500ms 停顿，低于 900ms
  assert.equal(pause.done, false, "句内停顿不该触发提交");

  feed(endpointer, 0.2, 10); // 继续说
  const verdict = feed(endpointer, 0.005, 18); // 再说 900ms
  assert.equal(verdict.done, true, "真正说完后仍要能提交");
});

test("E5 阈值可调：抬高阈值后同样的音量不算人声", () => {
  const endpointer = new Endpointer({ threshold: 0.5 });
  const verdict = feed(endpointer, 0.3, 40);
  assert.equal(verdict.active, false);
  assert.equal(verdict.done, false);
});

test("E6 reset 后重新计数（连续两轮对话互不污染）", () => {
  const endpointer = new Endpointer();
  feed(endpointer, 0.2, 8);
  feed(endpointer, 0.005, 20);
  endpointer.reset();
  assert.equal(endpointer.hasSpeech, false);
  const verdict = feed(endpointer, 0.005, 40);
  assert.equal(verdict.done, false, "复位后没有新的语音就不能判定");
});

test("E7 空段超时：一帧人声都没有时按 idle 收尾（唤醒监听用）", () => {
  const endpointer = new Endpointer({ idleMs: 1000 });
  const verdict = feed(endpointer, 0.005, 20); // 1000ms 纯静音
  assert.equal(verdict.done, true, "到点要收尾，否则会一直录到 60s 上限");
  assert.equal(verdict.idle, true, "必须标成空段：这段不该送去识别");

  const again = feed(endpointer, 0.005, 20);
  assert.equal(again.done, false, "idle 只触发一次");
});

test("E8 说过话的段不会走 idle 分支", () => {
  const endpointer = new Endpointer({ idleMs: 1000 });
  feed(endpointer, 0.2, 8); // 400ms 人声
  const verdict = feed(endpointer, 0.005, 20);
  assert.equal(verdict.done, true);
  assert.equal(verdict.idle, false, "有人声的段是有内容的，要送识别");
});

test("E9 没开 idleMs 时纯静音永不触发（按住说话的老行为）", () => {
  const endpointer = new Endpointer();
  const verdict = feed(endpointer, 0.005, 100); // 5000ms 静音
  assert.equal(verdict.done, false);
  assert.equal(verdict.idle, false);
});

/**
 * 下面三条针对的是「阈值写死 0.05」时期的两类必然失败用户。
 *
 * 这两类都不是边缘情况：低增益麦克风是笔记本远场/耳机麦的常态，高噪声是
 * 空调房与街边的常态。它们失败的方式还特别难查——低增益表现为「点了就
 * 结束」，高噪声表现为「一直在录、发出去是空的」，都不会报错。
 */

test("E10 低增益麦克风：说话只有 0.03 也能判成一句（旧阈值 0.05 下永不触发）", () => {
  const endpointer = new Endpointer();
  const ambient = feed(endpointer, 0.008, 12); // 600ms 环境底噪
  assert.equal(ambient.active, false, "底噪不能判成人声");

  const speech = feed(endpointer, 0.03, 8); // 400ms 轻声说话
  assert.equal(speech.active, true, "0.03 的说话必须被听见");
  assert.equal(speech.speechMs, 400);

  const verdict = feed(endpointer, 0.008, 18); // 900ms 静音
  assert.equal(verdict.done, true, "说完要能收尾，否则免按住模式点了没反应");
  assert.equal(verdict.idle, false, "有内容的段不能标成空段");
});

test("E11 高噪声环境：底噪 0.04 不算人声，也不会把标定期算进人声时长", () => {
  const endpointer = new Endpointer();
  const ambient = feed(endpointer, 0.04, 20); // 1000ms 空调噪声
  assert.equal(ambient.active, false, "底噪必须判成静音，否则永远等不到收尾");
  assert.equal(ambient.speechMs, 0, "标定期的 300ms 噪声不能被算成人声");
  assert.equal(ambient.done, false, "纯噪声不能凑成一句话发出去");

  const speech = feed(endpointer, 0.25, 8); // 400ms 正常说话
  assert.equal(speech.speechMs, 400, "人声时长只能是真实说话的部分");

  const verdict = feed(endpointer, 0.04, 18);
  assert.equal(verdict.done, true, "噪声环境下说完仍要能收尾");
});

test("E12 跟踪器跨轮持有：第二轮不必重新标定，第一帧就按学到的阈值判", () => {
  const tracker = new NoiseFloorTracker();
  // 上一轮已经学到「这间屋子底噪 0.03」
  for (let i = 0; i < 20; i += 1) tracker.observe(0.03, false);

  const endpointer = new Endpointer({ noiseFloor: tracker });
  const first = endpointer.push(0.03);
  assert.equal(first.active, false, "第二轮第一帧不该把底噪当人声");
  assert.ok(first.threshold >= 0.07, `阈值应沿用上一轮学到的值，实际 ${first.threshold}`);
});

test("E13 显式传 threshold 时关闭自适应（判定可复现）", () => {
  const endpointer = new Endpointer({ threshold: 0.05 });
  const verdict = feed(endpointer, 0.2, 10);
  assert.equal(verdict.threshold, 0.05, "固定阈值不该被噪声底改写");
  assert.equal(verdict.active, true);
});
