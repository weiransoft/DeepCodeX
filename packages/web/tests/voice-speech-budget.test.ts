/**
 * 朗读字数预算单测（web/voice/speech-budget）
 *
 * 这段逻辑的失败方式很隐蔽：算多了，用户听三分钟机器自言自语；算少了，
 * 一句完整的话被切一半，听起来像音频坏了。所以断言集中在**边界**上——
 * 正好用完、差一个字、已经用完。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEAK_BUDGET_CHARS, takeWithinBudget } from "../web/src/voice/speech-budget";

test("B1 预算内：整句原样返回，累计字数正确", () => {
  const slice = takeWithinBudget("今天天气不错。", 0);
  assert.equal(slice.text, "今天天气不错。");
  assert.equal(slice.used, 7);
  assert.equal(slice.exhausted, false);
});

test("B2 单句超出剩余预算：截到剩余字数，并标记超预算", () => {
  const slice = takeWithinBudget("一二三四五", 3, 5);
  assert.equal(slice.text, "一二", "只能念剩下 2 个字");
  assert.equal(slice.used, 5);
  assert.equal(slice.exhausted, true, "被截断了，收尾要补一句说明");
});

test("B3 预算已用尽：这句不念，且继续标记超预算", () => {
  const slice = takeWithinBudget("后面还有很长一段", 5, 5);
  assert.equal(slice.text, "", "预算用尽就不该再合成");
  assert.equal(slice.used, 5);
  assert.equal(slice.exhausted, true);
});

test("B4 正好用完预算：不改写句子，也不标记超预算（否则会多念一句废话）", () => {
  const slice = takeWithinBudget("一二三四五", 0, 5);
  assert.equal(slice.text, "一二三四五", "整句在预算内，不该被切");
  assert.equal(slice.used, 5);
  assert.equal(slice.exhausted, false, "什么都没截却报超预算，会在结尾凭空多念一句「后面还有内容」");
});

test("B5 多句累积：总字数不超过预算", () => {
  const sentences = ["第一句话在这里。", "第二句话稍微长一点点。", "第三句话就更长了，肯定要被切掉。"];
  let used = 0;
  let spoken = "";
  for (const sentence of sentences) {
    const slice = takeWithinBudget(sentence, used, 20);
    used = slice.used;
    spoken += slice.text;
    if (slice.exhausted) break;
  }
  assert.ok(spoken.length <= 20, `实际念了 ${spoken.length} 字，超预算了`);
  assert.equal(spoken, "第一句话在这里。第二句话稍微长一点点。第", "应切在预算边界上");
});

test("B6 空串不占预算、不触发截断", () => {
  const slice = takeWithinBudget("", 10);
  assert.equal(slice.text, "");
  assert.equal(slice.used, 10);
  assert.equal(slice.exhausted, false);
});

test("B7 非法累计字数当作 0（否则 NaN 会让预算形同虚设）", () => {
  const slice = takeWithinBudget("正常一句话", Number.NaN);
  assert.equal(slice.text, "正常一句话", "累计值坏了也不能把内容吞掉");
  assert.equal(slice.used, 5);
  assert.ok(Number.isFinite(slice.used));
});

test("B8 默认预算 320 字：600 字的长回复必须被截断", () => {
  const long = "这".repeat(600);
  const slice = takeWithinBudget(long, 0);
  assert.equal(slice.text.length, SPEAK_BUDGET_CHARS, "默认预算应为 320 字");
  assert.equal(slice.exhausted, true, "长回复必须停下来，不能整篇念完");
});
