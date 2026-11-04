/**
 * 语音切句单测（web/voice/sentence）
 *
 * 这里测的是「念什么」而不是「怎么念」——播报质量先取决于送进 TTS 的文本
 * 是否干净、句子是否完整。两个失败模式最伤体验：
 *
 * - 把代码/路径念出来（用户听到「三个反引号 bash」）
 * - 把句子切碎（见逗号就断，合成出来像电报）
 *
 * 因此断言分成两组：剥离必须彻底，切分必须保守。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceStream, stripForSpeech, takeSentences } from "../web/src/voice/sentence";

test("V1 围栏代码块整块剥掉，不留语言标记", () => {
  const raw = "先跑这个：\n```bash\nnpm install\n```\n然后看结果。";
  const cleaned = stripForSpeech(raw);
  assert.ok(!cleaned.includes("```"), "反引号必须消失");
  assert.ok(!cleaned.includes("npm install"), "代码内容不该被念出来");
  assert.ok(!cleaned.includes("bash"), "语言标记不该被念出来");
  assert.ok(cleaned.includes("先跑这个"), "正文必须保留");
  assert.ok(cleaned.includes("然后看结果"), "正文必须保留");
});

test("V2 流式下未闭合的围栏也要剥掉（只收到半个 ``` 是常态）", () => {
  const raw = "这段是代码\n```ts\nconst a = 1;";
  const cleaned = stripForSpeech(raw);
  assert.ok(!cleaned.includes("```"));
  assert.ok(!cleaned.includes("const a"));
  assert.ok(cleaned.includes("这段是代码"));
});

test("V3 行内代码、URL、Markdown 链接的剥离边界", () => {
  assert.equal(stripForSpeech("把 `soul.ts` 改一下"), "把 改一下");
  // 链接只留文字：念「点击这里」比念一串 URL 有用
  assert.equal(stripForSpeech("见[文档](https://example.com/a/b)"), "见文档");
  // 裸 URL 直接删
  assert.equal(stripForSpeech("打开 https://example.com/x 看看"), "打开 看看");
});

test("V4 标题/列表符号剥掉，但正文顺序不变", () => {
  const cleaned = stripForSpeech("## 结论\n- 第一条\n- 第二条");
  assert.ok(!cleaned.includes("#"));
  assert.ok(!cleaned.includes("- 第一"));
  assert.equal(cleaned, "结论 第一条 第二条");
});

test("V5 强断句符立即断句，且连续标点被一起吃掉", () => {
  const result = takeSentences("第一句。第二句！真的吗？？");
  assert.deepEqual(result.sentences, ["第一句。", "第二句！", "真的吗？？"]);
});

test("V6 短句里的逗号不断句（避免电报式语气）", () => {
  const result = takeSentences("好的，我来看看。");
  assert.deepEqual(result.sentences, ["好的，我来看看。"]);
});

test("V7 长句在弱断句符处切开", () => {
  // 首段必须超过 28 字（WEAK_BREAK_MIN_LENGTH），否则按设计不断——短句里逗号太密
  const long = "这一句特意写得比较长一些，用来跨过弱断句的阈值，让逗号也能断，" + "后半句继续说明。";
  const result = takeSentences(long);
  assert.ok(result.sentences.length >= 2, "长句应该在逗号处断成多句");
  assert.ok(result.sentences[0].endsWith("，"), "首句应切在逗号上");
  assert.ok(
    result.sentences.some((s) => s.endsWith("。")),
    "末句应带句号"
  );
});

test("V8 游标幂等：同一条累积文本重放不会重复产出", () => {
  const text = "第一句。第二句。";
  const first = takeSentences(text, 0);
  assert.deepEqual(first.sentences, ["第一句。", "第二句。"]);
  const again = takeSentences(text, first.consumed);
  assert.deepEqual(again.sentences, [], "已消费部分不得重复朗读");
});

test("V9 未收尾时残句不吐，flush 时才吐", () => {
  const text = "完整一句。还没写完的半句";
  const partial = takeSentences(text, 0, false);
  assert.deepEqual(partial.sentences, ["完整一句。"]);
  const flushed = takeSentences(text, partial.consumed, true);
  assert.deepEqual(flushed.sentences, ["还没写完的半句"]);
  assert.equal(flushed.consumed, text.length);
});

test("V10 SentenceStream 逐条喂累积文本，总输出与一次性切分一致", () => {
  const full = "先确认方位。再拆任务。最后交付。";
  const stream = new SentenceStream();
  const collected: string[] = [];
  // 模拟 SSE 逐字累积
  for (let i = 1; i <= full.length; i += 1) {
    collected.push(...stream.push(full.slice(0, i)));
  }
  collected.push(...stream.flush(full));
  assert.deepEqual(collected, takeSentences(full, 0, true).sentences);
  assert.equal(collected.length, 3);
});

test("V11 超长无标点文本会被强制切断（不会一句读半分钟）", () => {
  const long = "啊".repeat(300);
  // 必须 flush：否则尾部残句按设计不吐出（否则最后一句永远不播，但也确实不该提前播）
  const result = takeSentences(long, 0, true);
  assert.ok(result.sentences.length >= 3, "超长句必须被切开");
  const total = result.sentences.join("").length;
  assert.equal(total, 300, "切开但不能丢字");
});

test("V12 纯代码回复不产出任何句子（宁可不出声，也别念代码）", () => {
  const raw = "```python\nprint('hi')\n```";
  const result = takeSentences(raw, 0, true);
  assert.deepEqual(result.sentences, []);
});
