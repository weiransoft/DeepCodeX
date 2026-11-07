/**
 * 块级合并测试（SpeechQueue 的"攒句子再一次请求"）
 *
 * ## 为什么需要这一层
 *
 * 用户报「每句话音色都不一样，尤其长句」。真机定位到：`sentence.ts` 的
 * 弱断句阈值只有 28 字，长句在逗号处被切成三四段，而**每段都是一次独立
 * 的 TTS 请求**——TTS 每次请求都重新起韵律，段与段之间就成了"换了口气"。
 *
 * 修法是在队列里把连续句子攒成块（首块 24 字、后续 72 字）再请求一次。
 * 块大小是这一层的核心契约，用"合成函数收到的文本"直接断言，不靠听感。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_BLOCK_CHARS, SpeechQueue, joinSentences, splitLongText } from "../web/src/voice/player";
import type { ClipPlayer, PlayOutcome, ScheduledClip } from "../web/src/voice/playout";

/** 记录排程、立即播完的假后端 */
class InstantPlayer implements ClipPlayer {
  readonly maxLead = 3;
  readonly scheduled: { url: string; gap: number }[] = [];

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  schedule(url: string, gap: number): Promise<ScheduledClip> {
    this.scheduled.push({ url, gap });
    return Promise.resolve({ done: Promise.resolve<PlayOutcome>("ended") });
  }

  stop(): void {
    // 无状态
  }

  dispose(): void {
    // 无资源
  }
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

test("B1 中文句子直接拼回原文（切句是人为在标点处切开的）", () => {
  assert.equal(joinSentences(["今天天气不错。", "我们出去走走吧。"]), "今天天气不错。我们出去走走吧。");
  assert.equal(joinSentences([]), "");
  assert.equal(joinSentences(["只有一句。"]), "只有一句。");
});

test("B2 西文句子之间补空格，避免念成连读", () => {
  assert.equal(joinSentences(["Hello there.", "How are you?"]), "Hello there. How are you?");
  assert.equal(joinSentences(["版本 1。", "OK。"]), "版本 1。OK。");
});

test("B3 短句攒够目标字数才合成：四句只打一次请求", async () => {
  const player = new InstantPlayer();
  const texts: string[] = [];
  const states: boolean[] = [];
  const queue = new SpeechQueue(
    async (text) => {
      texts.push(text);
      return `blob:${texts.length}`;
    },
    { onSpeakingChange: (v) => states.push(v) },
    { player, firstBlockChars: 12, blockChars: 12, warmupChars: 12 }
  );

  queue.enqueue("第一句。");
  queue.enqueue("第二句。");
  // 累计 8 字，还不到 12
  assert.equal(texts.length, 0, "不到目标字数不该发起合成");
  queue.enqueue("第三句。");
  // 累计 12 字 → 封块并合成
  await waitFor(() => texts.length === 1);
  assert.equal(texts[0], "第一句。第二句。第三句。", `应合并成一块，实际 ${JSON.stringify(texts)}`);

  queue.enqueue("第四句。");
  queue.flush();
  await waitFor(() => texts.length === 2);
  assert.equal(texts[1], "第四句。", "flush 把剩下的尾巴单独成块");
  await waitFor(() => states.at(-1) === false);
});

test("B4 flush 之前不满一块的尾巴不合成、不播（必须由调用方收尾）", async () => {
  const player = new InstantPlayer();
  const texts: string[] = [];
  const queue = new SpeechQueue(
    async (text) => {
      texts.push(text);
      return "blob:x";
    },
    {},
    { player, firstBlockChars: 40, blockChars: 40, warmupChars: 40 }
  );

  queue.enqueue("一句很短的话。");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(texts.length, 0, "没到目标字数、也没 flush，不该合成");

  queue.flush();
  await waitFor(() => texts.length === 1);
  assert.equal(texts[0], "一句很短的话。");
});

test("B5 首块比后续块小：首块为了早出声，后续块为了连贯", async () => {
  const player = new InstantPlayer();
  const texts: string[] = [];
  const queue = new SpeechQueue(
    async (text) => {
      texts.push(text);
      return "blob:x";
    },
    {},
    { player, firstBlockChars: 6, blockChars: 12 }
  );

  // 八个 3 字句（"第一。"）：首块吃两句（6 字），后续块吃四句（12 字），
  // 剩两句（6 字）不够 12、交给 flush
  for (const s of ["第一。", "第二。", "第三。", "第四。", "第五。", "第六。", "第七。", "第八。"]) {
    queue.enqueue(s);
  }
  queue.flush();
  await waitFor(() => texts.length >= 3);

  assert.equal(texts[0], "第一。第二。", "首块按 6 字封块（两句）");
  assert.equal(texts[1].length, 12, `后续块应按 12 字封块，实际 ${texts[1].length} 字`);
  assert.equal(texts[2], "第七。第八。", "剩下的尾巴由 flush 单独成块");
});

test("B6 超长单句二次切分：任何块都不超过硬上限，且不丢字", async () => {
  const player = new InstantPlayer();
  const texts: string[] = [];
  const queue = new SpeechQueue(
    async (text) => {
      texts.push(text);
      return "blob:x";
    },
    {},
    { player, firstBlockChars: 14, blockChars: 40 }
  );
  // 120 字无标点的单句：真机日志里出现过 180 字单块，触发 TTS 退化
  const long = "这里没有标点".repeat(20);
  queue.enqueue(long);
  queue.flush();
  await waitFor(() => texts.length >= 3);
  assert.ok(
    texts.every((t) => t.length <= MAX_BLOCK_CHARS),
    `不能有超过 ${MAX_BLOCK_CHARS} 字的块，实际 ${JSON.stringify(texts.map((t) => t.length))}`
  );
  assert.equal(texts.join(""), long, "切分不能吞字或重复");
});

test("B7 splitLongText 优先在标点处断，拼接回去等于原文", () => {
  const text = "第一句说完了。第二句也说完了，但是后面还有很长的一段话没有标点只能硬切开来处理。";
  const parts = splitLongText(text, 20);
  assert.ok(
    parts.every((p) => p.length <= 20),
    `每块都要 ≤20 字，实际 ${JSON.stringify(parts)}`
  );
  assert.equal(parts.join(""), text, "拼回去必须逐字等于原文");
  assert.ok(/[。！？!?；;，,、：:]$/u.test(parts[0]), `应优先在标点处断，实际首块 ${JSON.stringify(parts[0])}`);
  assert.deepEqual(splitLongText("短句。", 20), ["短句。"], "不超上限时原样返回");
});

test("B8 有界队列：合成彻底卡住时丢弃最旧块并提示，不让延迟无限累加", () => {
  const notices: string[] = [];
  const queue = new SpeechQueue(
    // 模拟 TTS 永久无响应：生成侧继续灌入，blocks 会一直涨
    () => new Promise<string>(() => undefined),
    { onNotice: (m) => notices.push(m) },
    { player: new InstantPlayer(), firstBlockChars: 1, blockChars: 1 }
  );
  for (let i = 0; i < 30; i += 1) queue.enqueue(`第${i}句。`);
  assert.ok(
    notices.some((m) => m.includes("积压")),
    `超过上限要留提示，实际 ${JSON.stringify(notices)}`
  );
  assert.ok(notices.length <= 7, `只在超限时提示，不应每块都刷屏，实际 ${notices.length} 条`);
});
