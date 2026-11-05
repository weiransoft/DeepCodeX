/**
 * 唤醒词匹配单测（web/voice/wake）
 *
 * 唤醒的两个方向都难受：
 *
 * - 太严：用户喊三遍没反应，最后放弃这个功能；
 * - 太松：安静房间里自言自语就把助手唤起来了，更糟——它开始录你说的话。
 *
 * 所以断言分三组：精确必须命中、同音/漏字要容错、**句中的近似不算命中**。
 * 第三组是这套匹配能用的前提：短唤醒词的编辑距离 1 太容易撞上别的词。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, matchWakeWord, normalizeForWake } from "../web/src/voice/wake";

test("W1 归一化去掉标点空白并转小写", () => {
  assert.equal(normalizeForWake("司南，帮 我看下！"), "司南帮我看下");
  assert.equal(normalizeForWake("  Hey Sina.  "), "heysina");
  assert.equal(normalizeForWake("，，。。"), "");
});

test("W2 精确命中：带标点也算", () => {
  const result = matchWakeWord("司南，帮我看下时间", "司南");
  assert.equal(result.hit, true);
  assert.equal(result.kind, "exact");
  assert.equal(result.index, 0);
});

test("W3 精确命中不限位置（句中喊也算）", () => {
  const result = matchWakeWord("那个，司南你在吗", "司南");
  assert.equal(result.hit, true);
  assert.equal(result.kind, "exact");
  assert.equal(result.index, 2);
});

test("W4 同音容错：思南 ≈ 司南", () => {
  const result = matchWakeWord("思南帮我把灯关了", "司南");
  assert.equal(result.hit, true);
  assert.equal(result.kind, "fuzzy");
  assert.equal(result.index, 0);
});

test("W5 漏一个字也容错", () => {
  // 转写少了「手」：司南助… vs 司南助手，距离 1
  const result = matchWakeWord("司南助在吗", "司南助手");
  assert.equal(result.hit, true);
  assert.equal(result.kind, "fuzzy");
});

test("W6 句中近似不算命中（避免误唤醒）", () => {
  // 开头 6 个字以内没有「司南」的近似，只在中段出现「思念南」
  const result = matchWakeWord("我今天一直在思念南方的家", "司南");
  assert.equal(result.hit, false);
});

test("W7 单字唤醒词不做近似", () => {
  assert.equal(matchWakeWord("难的题", "南").hit, false);
  assert.equal(matchWakeWord("南，帮我看下", "南").hit, true);
});

test("W8 空输入一律不命中", () => {
  assert.equal(matchWakeWord("", "司南").hit, false);
  assert.equal(matchWakeWord("司南", "").hit, false);
  assert.equal(matchWakeWord("司南", "   ").hit, false);
});

test("W9 完全无关的话不命中", () => {
  assert.equal(matchWakeWord("今天天气不错", "司南").hit, false);
});

test("W10 编辑距离带上限提前退出", () => {
  assert.equal(editDistance("司南", "司南"), 0);
  assert.equal(editDistance("司南", "思南"), 1);
  assert.equal(editDistance("abc", "abd"), 1);
  // 超过上限直接返回上限 + 1，不返回真实距离
  assert.equal(editDistance("abcdef", "uvwxyz", 1), 2);
});
