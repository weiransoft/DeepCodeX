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
import { SentenceStream, isNewTurnText, stripForSpeech, takeSentences } from "../web/src/voice/sentence";

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

test("V13 首句用更短的弱断点（12 字）以降 TTFA，第二句恢复 28 字", () => {
  const stream = new SentenceStream();
  // 第一个逗号在第 7 字（低于 12），第二个在第 14 字（达到首句阈值）
  const first = stream.push("今天天气不错，适合出门走走，不过风有点大");
  assert.equal(first.length, 1, "首句应在第二个逗号处断开");
  assert.equal(first[0], "今天天气不错，适合出门走走，");

  // 第二句累计 21 字（含两个逗号）：低于常规阈值，不该再断——否则整段像电报
  const full = "今天天气不错，适合出门走走，不过风有点大，后面还有一段";
  const second = stream.push(full);
  assert.equal(second.length, 0, "第二句不能继续用首句阈值");

  // 收尾时把第二句整段吐出来
  const tail = stream.flush(full);
  assert.equal(tail.length, 1, "收尾必须吐出第二句");
  assert.equal(tail[0], "不过风有点大，后面还有一段");
});

test("V14 flush 仍能收尾首句（流结束时残句不能丢）", () => {
  const stream = new SentenceStream();
  assert.equal(stream.push("刚开始说").length, 0);
  const tail = stream.flush("刚开始说，还没说完");
  assert.equal(tail.length, 1, "收尾必须吐出残句");
});

// ---- 轮次边界自检：回归「聊了几轮之后完全不说话」 ----
// SSE 的 previewText 是累积文本，同一轮单调递增且前缀稳定。原先轮次状态
// 只在 finishFeed() 复位，而 finishFeed 只挂 assistant_message 一条事件：
// 工具轮/打断/断线让这帧缺席后，切句游标停在上一轮末尾，后续短回复
// 一句都切不出来，连 TTS 请求都不发，并且会持续很多轮。

test("V15 同轮累积文本增长不误判为新一轮", () => {
  assert.equal(isNewTurnText("我在核对回滚路径", "我在核对回滚路径，再收敛音色"), false);
  assert.equal(isNewTurnText("", "第一轮第一帧"), false, "本轮还没喂过不算新轮");
  assert.equal(isNewTurnText("上一轮文本", ""), false, "空帧不该触发复位");
});

test("V16 累积文本回退 = 新一轮（哪怕上一轮很短）", () => {
  assert.equal(isNewTurnText("我把三处都核对了一遍，结论比较清楚", "好的，我记下了。"), true);
  assert.equal(isNewTurnText("好的", "好的，记下了"), false, "同轮增长仍属同一轮");
});

test("V17 上一轮很短、新一轮首帧就更长时靠前缀识别", () => {
  assert.equal(isNewTurnText("好的。", "稍等，我重新核对一下时间和语速设置。"), true);
  assert.equal(isNewTurnText("稍等，我重新核对", "稍等，我重新核对一下时间和语速设置。"), false);
});

test("V18 SSE 事件重放（同前缀、长度回退）也判定为新轮，宁可复位不可静默", () => {
  assert.equal(isNewTurnText("先说结论，第一，回滚路径没问题", "先说结论，第一"), true);
});

/** 最小轮次驱动器：复刻 useVoiceTalk.feed 的复位决策，guard=false 是旧行为 */
function makeFeeder(guard: boolean): { feed: (t: string) => void; finish: () => void; heard: string[] } {
  let stream: SentenceStream | null = null;
  let turnText = "";
  const heard: string[] = [];
  const feed = (cumulative: string): void => {
    if (guard && isNewTurnText(turnText, cumulative)) {
      stream = null;
      turnText = "";
    }
    turnText = cumulative;
    if (stream === null) stream = new SentenceStream();
    heard.push(...stream.push(cumulative));
  };
  const finish = (): void => {
    if (stream !== null) heard.push(...stream.flush(turnText));
    stream = null;
    turnText = "";
  };
  return { feed, finish, heard };
}

const LONG_TURN = "我把这三处都核对了一遍，结论比较清楚：先处理回滚路径，再收敛音色，最后看生成延迟。";

test("V19 旧行为复现：缺一次 finishFeed 后连续 4 轮 0 句", () => {
  const old = makeFeeder(false);
  old.feed(LONG_TURN);
  assert.ok(old.heard.length > 0, "第一轮正常出句");
  const before = old.heard.length;
  for (const text of ["好的，我记下了。", "稍等，我再核对一下时间。", "收到。", "那就先这样吧。"]) {
    old.feed(text);
  }
  assert.equal(old.heard.length, before, "旧行为：后续短回复全部静默");
});

test("V20 护栏：缺 finishFeed 后下一轮自动复位并恢复播报", () => {
  const guarded = makeFeeder(true);
  guarded.feed(LONG_TURN);
  const firstTurn = guarded.heard.length;
  assert.ok(firstTurn > 0, "第一轮正常出句");
  guarded.feed("好的，我记下了。");
  assert.ok(guarded.heard.length > firstTurn, "第二轮必须重新出句");
  guarded.feed("稍等，我再核对一下时间。");
  guarded.finish();
  assert.ok(guarded.heard.length >= firstTurn + 2, "多轮连续对话不能再次静默");
});

test("V21 reset() 能把停在上一轮末尾的游标归零", () => {
  const stream = new SentenceStream();
  stream.push(LONG_TURN);
  assert.deepEqual(stream.push("好的。"), [], "复位前游标挡住新文本");
  stream.reset();
  assert.deepEqual(stream.push("好的。"), ["好的。"], "复位后短句可正常切出");
});
