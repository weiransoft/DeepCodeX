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
