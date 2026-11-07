/**
 * 长文本分块护栏（2026-11-07 专项回归）
 *
 * 真机反馈「长文本还是会变语速，音色变了，讲话不自然不连贯」。复刻前端
 * 「切句 → 封块 → 逐块独立请求」链路的实测结论：
 *
 * - 中英混排 421 字被切成 13 块，块间语速极差 76.37%；
 * - 3 字碎片 F0 冲到 304Hz / 质心 4998Hz、13 字碎片 12.4 字/秒，
 *   模型把极短文本当短促感叹句起头，听感就是「忽然换了个人」；
 * - 伺服分母用字符数会把中英混排的发音量少算一半，制造假的语速漂移。
 *
 * 这里锁住前端这一层的三件事（音频信号层由 scripts/voice 负责）：
 * - B9  `speechUnits()` 与服务端 `speech_units()` 同口径；
 * - B10 `splitLongText()` 逐字可逆、不超上限、不产生极短尾段；
 * - B11 长文本队列不把 <10 等效单元的碎片单独发去合成，首块仍短以保 TTFA。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_BLOCK_UNITS, SpeechQueue, rebalanceShortBlock, speechUnits, splitLongText } from "../web/src/voice/player";
import type { ClipPlayer, ScheduledClip } from "../web/src/voice/playout";
import type { StreamSynthFn } from "../web/src/voice/player";
import { SentenceStream } from "../web/src/voice/sentence";

/** 立即完成的播放后端：本套用例只关心「发给合成的文本」，不关心音频内容 */
class NoopPlayer implements ClipPlayer {
  readonly maxLead = 8;
  prepare(): Promise<void> {
    return Promise.resolve();
  }
  schedule(): Promise<ScheduledClip> {
    return Promise.resolve({ done: Promise.resolve("ended") });
  }
  stop(): void {
    // 无资源
  }
  dispose(): void {
    // 无资源
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("B9 speechUnits 与服务端同口径：标点 0、汉字 1、拉丁折算、缩写逐字母", () => {
  const cn = "我先把刚才那三处改动捋了一遍，慢慢说给你听。";
  const hanzi = [...cn].filter((c) => /[\u4e00-\u9fff]/u.test(c)).length;
  assert.ok(Math.abs(speechUnits(cn) - hanzi) < 1e-6, `纯中文 ${speechUnits(cn)} vs ${hanzi}`);
  assert.ok(Math.abs(speechUnits("你好。") - speechUnits("你好")) < 1e-6, "标点不发音");
  const mixed = "resolveThinkingDepth 每轮输出 off、light、balanced、full 四档。";
  assert.ok(speechUnits(mixed) < mixed.length * 0.75, `中英混排 ${speechUnits(mixed)} / ${mixed.length} 字符`);
  assert.ok(speechUnits("TTFT") > speechUnits("ttft"), "全大写缩写逐字母念");
  assert.ok(speechUnits("2026") > 2.5 && speechUnits("2026") < 4.5, "数字串按位折算");
  assert.equal(speechUnits(""), 0);
  assert.equal(speechUnits("，。！"), 0);
});

test("B10 splitLongText 逐字可逆、不超上限、尾段不是碎片", () => {
  const long = "没有标点的长文本最能暴露语速漂移的问题因为模型看不到任何句读提示只能自己决定在哪里换气".repeat(4);
  const parts = splitLongText(long, 48);
  assert.equal(parts.join(""), long.trim(), "拼接必须逐字等于原文");
  assert.ok(
    parts.every((p) => p.length <= 48),
    `每段 ≤48 字，实际 ${JSON.stringify(parts.map((p) => p.length))}`
  );
  assert.ok(speechUnits(parts[parts.length - 1]) >= MIN_BLOCK_UNITS, "尾段达到最短发音量");
  assert.deepEqual(splitLongText("短句。", 48), ["短句。"], "不超上限时原样返回");

  const punctuated = "第一句说完了。第二句也说完了，但是后面还有很长的一段话没有标点只能硬切开来处理。".repeat(3);
  const pieces = splitLongText(punctuated, 48);
  assert.equal(pieces.join(""), punctuated.trim(), "带标点的长文本也不吞字");
  assert.ok(pieces.every((p) => p.length <= 48));
});

test("B11 长文本队列：碎片不单独合成，首块仍短，全文不丢字", async () => {
  const player = new NoopPlayer();
  const synthTexts: string[] = [];
  const streamSynth: StreamSynthFn = async (text, onChunk) => {
    synthTexts.push(text);
    onChunk(`blob:${synthTexts.length}`, 0);
    return 1;
  };
  const queue = new SpeechQueue(
    async (text) => `blob:fallback-${text}`,
    {},
    { player, createFallbackPlayer: () => player, streamSynth, minBlockUnits: MIN_BLOCK_UNITS }
  );

  // 模拟 SSE：每帧喂累积文本，SentenceStream 吐出完整句子后逐句入队
  const full =
    "我先把刚才那三处改动从头到尾捋了一遍慢慢说给你听不急着下结论。" +
    "第一处是播放队列的状态机原来是靠一个布尔量记着有没有在播一旦回调迟到了这一位就会永远卡在真值上。" +
    "第二处是解码超时浏览器的音频解码在设备切换的时候可能既不成功也不失败就那么悬着所以必须给它一个硬上限。" +
    "第三处是取消传播用户打断一句话的时候不只是要停掉正在播的音频还得把排队中的合成一起撤掉。" +
    "这三处合起来其实就是把能出声变成一直稳定地出声。嗯。";
  const stream = new SentenceStream();
  for (let end = 1; end <= full.length; end += 7) {
    for (const sentence of stream.push(full.slice(0, end))) queue.enqueue(sentence);
  }
  for (const sentence of stream.flush(full)) queue.enqueue(sentence);
  queue.flush();
  await waitFor(() => !queue.speaking && synthTexts.length > 0);

  assert.ok(synthTexts.length >= 3, `长文本应分成多块，实际 ${synthTexts.length} 块`);
  // 首块由「第一句」决定：SentenceStream 首句弱断 12 字，但整句不足 48 字时
  // 不会把句子拦腰切开（否则语气更碎）。所以只要求它明显短于整段，
  // 而不是等整条回复生成完才第一次出声。
  assert.ok(synthTexts[0].length < full.length / 2, `首块必须早于整段出声，实际 ${synthTexts[0].length} 字`);
  for (const [index, text] of synthTexts.entries()) {
    assert.ok(
      speechUnits(text) >= MIN_BLOCK_UNITS || index === 0,
      `第 ${index + 1} 块不应是碎片：${text.length} 字 / ${speechUnits(text).toFixed(1)} 单元`
    );
    assert.ok(text.length <= 48, `第 ${index + 1} 块超过硬上限：${text.length} 字`);
  }
  assert.equal(synthTexts.join(""), full.replace(/\s+/g, ""), "所有块拼回去必须逐字等于原文");
  queue.dispose();
});

test("B12 中英混排碎片：按发音单元借字符，且不把拉丁单词拦腰切开", () => {
  // 2026-11-07 门禁最后一处失败：`和 anthropic-provider。` 22 字符只有 7.07
  // 等效单元。旧版把「单元缺口」当字符数借 2~3 个字符，借完仍是短碎片。
  const prev = "balanced、full 四档之一，再透传给 openai-provider";
  const short = "和 anthropic-provider。";
  assert.ok(speechUnits(short) < MIN_BLOCK_UNITS, `复现用碎片应 <10 单元，实际 ${speechUnits(short)}`);

  const balanced = rebalanceShortBlock(prev, short, MIN_BLOCK_UNITS, 48);
  assert.equal(balanced.length, 2, "应重划成两段");
  assert.equal(balanced.join(""), prev + short, "重划必须逐字可逆");
  for (const part of balanced) {
    assert.ok(speechUnits(part) >= MIN_BLOCK_UNITS, `两段都要够发音量：${speechUnits(part).toFixed(2)}`);
    assert.ok(part.length <= 48, `两段都不超硬上限：${part.length}`);
  }
  assert.ok(
    balanced[1].startsWith("openai-provider"),
    `不能把 openai-provider 切成 opena / i-provider：${balanced[0].slice(-18)} | ${balanced[1].slice(0, 18)}`
  );
  assert.deepEqual(rebalanceShortBlock("短句。", "嗯。", MIN_BLOCK_UNITS, 48), ["短句。嗯。"]);
});

test("B13 中英混排长文本：队列不产生 <10 单元碎片、不超 48 字、不丢字", async () => {
  const player = new NoopPlayer();
  const synthTexts: string[] = [];
  const streamSynth: StreamSynthFn = async (text, onChunk) => {
    synthTexts.push(text);
    onChunk(`blob:${synthTexts.length}`, 0);
    return 1;
  };
  const queue = new SpeechQueue(
    async (text) => `blob:fallback-${text}`,
    {},
    { player, createFallbackPlayer: () => player, streamSynth, minBlockUnits: MIN_BLOCK_UNITS }
  );
  const full =
    "这次我把 session.ts 里的思考深度调度链路重新对了一遍，结论是这样的：" +
    "resolveThinkingDepth 每轮读四个信号，意图、复杂度、上下文长度和时效要求，" +
    "输出 off、light、balanced、full 四档之一，再透传给 openai-provider 和 anthropic-provider。" +
    "实测 short turn 的 TTFT 从 321 毫秒降到 190 毫秒左右，" +
    "complex turn 保持在原来的 1.8 秒，因为 full 档严格等于用户配置的 reasoning effort，一个字段都没动。" +
    "另外还有两个开关，DCX_THINK_DEPTH 设成 off 就能一键回到静态基线，" +
    "X-Tts-Voice 回显的 speaker 是 serena，不是 vivian，这点在排查音色问题时特别容易搞混。";

  const stream = new SentenceStream();
  for (let end = 1; end <= full.length; end += 5) {
    for (const sentence of stream.push(full.slice(0, end))) queue.enqueue(sentence);
  }
  for (const sentence of stream.flush(full)) queue.enqueue(sentence);
  queue.flush();
  await waitFor(() => !queue.speaking && synthTexts.length > 0);

  assert.ok(synthTexts.length >= 3, `长文本应分成多块，实际 ${synthTexts.length} 块`);
  for (const [index, text] of synthTexts.entries()) {
    assert.ok(
      speechUnits(text) >= MIN_BLOCK_UNITS || index === 0,
      `第 ${index + 1} 块不应是碎片：${text.length} 字 / ${speechUnits(text).toFixed(2)} 单元 → ${text.slice(0, 24)}`
    );
    assert.ok(text.length <= 48, `第 ${index + 1} 块超过硬上限：${text.length} 字`);
  }
  assert.equal(synthTexts.join("").replace(/\s+/g, ""), full.replace(/\s+/g, ""), "所有块拼回去必须逐字等于原文");
  queue.dispose();
});
