/**
 * 系统提示词里的「此刻」（时间注入）
 *
 * 背景：模型没有时钟，训练数据里也没有「今天」。不注入时间时，
 * 「今天几号 / 现在几点 / 明天周几」只能靠猜——而它会拿训练截止日期
 * 当今天，答案必然错。这一组用例锁住三件事：
 *
 * - C1 东八区是本项目的默认时区；
 * - C2 换时区真的生效（同一时间戳在不同时区给出不同的小时）；
 * - C3 时区名写错时不能把整段系统提示词搞崩。
 *
 * @module tests/super-agent-soul-clock
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSinanSoul, renderSoulPrompt } from "../super-agent/soul/index.js";
import { DEFAULT_TIME_ZONE, formatClock, resolveTimeZone } from "../super-agent/soul/render.js";

/** 固定时钟：2026-11-04T12:00:00Z → 北京时间 20:00 星期三 */
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

test("C1 默认时区是东八区，时间渲染成中文可读格式", () => {
  assert.equal(DEFAULT_TIME_ZONE, "Asia/Shanghai");
  assert.equal(formatClock(NOW), "2026年11月4日 星期三 20:00");
});

test("C2 换时区真的生效：同一时间戳在 UTC / 纽约给出不同的小时", () => {
  assert.equal(formatClock(NOW, "UTC"), "2026年11月4日 星期三 12:00");
  assert.equal(formatClock(NOW, "America/New_York"), "2026年11月4日 星期三 07:00");
});

test("C3 时区名非法时退回系统时区，不抛错", () => {
  // 非法 IANA 名会让 Intl 抛 RangeError；提示词构造不能因此整段失败
  assert.doesNotThrow(() => formatClock(NOW, "Mars/Olympus"));
  assert.ok(formatClock(NOW, "Mars/Olympus").length > 0);
});

test("C4 环境变量可覆盖默认时区", () => {
  const original = process.env.DEEPCODE_TIMEZONE;
  try {
    process.env.DEEPCODE_TIMEZONE = "UTC";
    assert.equal(resolveTimeZone(), "UTC");

    // 空串等同于没设：不能因为设了个空值就退化成「系统时区」
    process.env.DEEPCODE_TIMEZONE = "   ";
    assert.equal(resolveTimeZone(), DEFAULT_TIME_ZONE);
  } finally {
    if (original === undefined) delete process.env.DEEPCODE_TIMEZONE;
    else process.env.DEEPCODE_TIMEZONE = original;
  }
});

test("C5 系统提示词末尾带「此刻」，且时间在文中可见", () => {
  const soul = createSinanSoul();
  const prompt = renderSoulPrompt(soul, { now: NOW });

  assert.ok(prompt.includes("## 此刻"), "缺少「此刻」小节");
  assert.ok(prompt.includes("2026年11月4日 星期三 20:00"), "缺少渲染后的时间");
  assert.ok(prompt.includes("Asia/Shanghai"), "缺少时区标识");
  // 明确告诉模型不要用训练数据里的日期
  assert.ok(prompt.includes("不要用训练数据里的日期"), "缺少「不要用训练数据日期」的约束");

  // 放在末尾：前缀缓存按前缀匹配，时间每轮都变，放开头会让缓存全失效
  const tail = prompt.slice(prompt.indexOf("## 此刻"));
  assert.ok(tail.length < prompt.length, "「此刻」应在正文之后而非开头");
  assert.ok(prompt.trimEnd().endsWith("推算。"), "「此刻」应是最后一段");
});
