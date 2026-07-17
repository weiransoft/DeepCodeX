/**
 * ContentSummarizer 单元测试（F-FOCUS-03 配套，V2-P2 新增）
 *
 * 测试覆盖（V2_P2_IMPLEMENTATION_PLAN.md §4.4 + V2 测试方案 §7）：
 * - LS-01: summarize 基本功能（生成不超过 maxLength 的摘要）
 * - LS-02: summarize 保留首句（首句加权 +2，最高分必入选）
 * - LS-03: summarize 空内容返回空串
 * - LS-04: summarize 保持原顺序（按原文本顺序输出，非按分数顺序）
 * - LS-05: extractKeyInfo 偏好/事实识别（含关键词 → preference/fact 类型）
 *
 * 测试目标：RuleBasedSummarizer（真实启发式算法，非 mock）
 * 注：DeepSeekSummarizer 需 DEEPSEEK_API_KEY，仅本地手测，CI skip（见 summarizer-factory.test.ts）。
 *
 * @module v2/tests/memory/content-summarizer.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleBasedSummarizer } from "../../memory/rule-based-summarizer";

// ============================================================================
// LS 测试用例（LS-01 ~ LS-05）
// ============================================================================

// ============================================================
// LS-01: summarize 基本功能（生成不超过 maxLength 的摘要）
// ============================================================

test("LS-01: summarize 基本功能（生成不超过 maxLength 的摘要）", async () => {
  const summarizer = new RuleBasedSummarizer();
  // 构造 3 个句子的内容
  const content = "这是第一句话。这是第二句话。这是第三句话。";
  // maxLength 足够大，应返回全部句子
  const summary = await summarizer.summarize(content, 100);

  // 断言 1：返回非空字符串
  assert.ok(summary.length > 0, "摘要应非空");

  // 断言 2：摘要长度 <= maxLength
  assert.ok(summary.length <= 100, `摘要长度（${summary.length}）应 <= maxLength（100）`);

  // 断言 3：摘要含原文句子（用空格拼接）
  assert.ok(summary.includes("这是第一句话"), "摘要应含第一句话");
});

// ============================================================
// LS-02: summarize 保留首句（首句加权 +2，最高分必入选）
// ============================================================

test("LS-02: summarize 保留首句（首句加权 +2，即使 maxLength 不足也优先保留）", async () => {
  const summarizer = new RuleBasedSummarizer();
  // 3 个句子，每句 6 字符
  const content = "第一句话。第二句话。第三句话。";
  // maxLength=10 只能容纳 1 个句子（6 字符）
  const summary = await summarizer.summarize(content, 10);

  // 断言：摘要应保留首句（首句加权 +2，最高分）
  assert.ok(summary.includes("第一句话"), `摘要应保留首句（首句加权 +2），实际：${summary}`);
  // 首句 6 字符 <= maxLength 10，应被保留
  assert.ok(summary.length <= 10, `摘要长度（${summary.length}）应 <= 10`);
});

// ============================================================
// LS-03: summarize 空内容返回空串
// ============================================================

test("LS-03: summarize 空内容返回空串", async () => {
  const summarizer = new RuleBasedSummarizer();

  // 空字符串
  const summary1 = await summarizer.summarize("", 100);
  assert.equal(summary1, "", "空字符串应返回空串");

  // 仅含分隔符（句号、换行等，splitSentences 过滤后为空）
  const summary2 = await summarizer.summarize("。。。...\n\n", 100);
  assert.equal(summary2, "", "仅含分隔符应返回空串（splitSentences 过滤后为空）");
});

// ============================================================
// LS-04: summarize 保持原顺序（按原文本顺序输出，非按分数顺序）
// ============================================================

test("LS-04: summarize 保持原顺序（按原文本顺序输出，非按分数顺序）", async () => {
  const summarizer = new RuleBasedSummarizer();
  // 3 个句子：首句（+2）、末句（+1）、中间句（+0）
  // 分数：首句 2.5（+2 + 0.5 长度适中）、中间句 0.5（+0.5 长度适中）、末句 1.5（+1 + 0.5 长度适中）
  // 按分数降序：首句(2.5) > 末句(1.5) > 中间句(0.5)
  // 但输出应按原顺序：首句 → 中间句 → 末句
  const content = "首句内容测试。中间句内容。末句内容测试。";
  const summary = await summarizer.summarize(content, 100);

  // 断言 1：摘要含全部 3 个句子（maxLength 足够大）
  assert.ok(summary.includes("首句内容测试"), "摘要应含首句");
  assert.ok(summary.includes("中间句内容"), "摘要应含中间句");
  assert.ok(summary.includes("末句内容测试"), "摘要应含末句");

  // 断言 2：句子顺序应与原文一致（首句在前，末句在后）
  const firstIdx = summary.indexOf("首句内容测试");
  const middleIdx = summary.indexOf("中间句内容");
  const lastIdx = summary.indexOf("末句内容测试");
  assert.ok(firstIdx < middleIdx, "首句应在中间句之前");
  assert.ok(middleIdx < lastIdx, "中间句应在末句之前");
});

// ============================================================
// LS-05: extractKeyInfo 偏好/事实识别
// ============================================================

test("LS-05: extractKeyInfo 偏好/事实识别（含关键词 → preference/fact 类型）", async () => {
  const summarizer = new RuleBasedSummarizer();

  // 构造含偏好和事实关键词的内容
  const content = "用户偏好深色主题。系统使用 MySQL 数据库。普通描述句子。";

  const keyInfos = await summarizer.extractKeyInfo(content);

  // 断言 1：返回非空数组（应识别出偏好和事实）
  assert.ok(keyInfos.length >= 2, `应识别至少 2 条关键信息，实际：${keyInfos.length}`);

  // 断言 2：应识别出 preference 类型（含"偏好"关键词）
  const preferences = keyInfos.filter((k) => k.type === "preference");
  assert.ok(preferences.length >= 1, "应识别至少 1 条 preference");
  const pref = preferences[0];
  assert.ok(pref.content.includes("偏好"), `preference 内容应含 '偏好'，实际：${pref.content}`);
  assert.ok(Math.abs(pref.confidence - 0.8) < 0.01, `preference confidence 应为 0.8，实际：${pref.confidence}`);

  // 断言 3：应识别出 fact 类型（含"使用"关键词）
  const facts = keyInfos.filter((k) => k.type === "fact");
  assert.ok(facts.length >= 1, "应识别至少 1 条 fact");
  const fact = facts[0];
  assert.ok(fact.content.includes("使用"), `fact 内容应含 '使用'，实际：${fact.content}`);
  assert.ok(Math.abs(fact.confidence - 0.7) < 0.01, `fact confidence 应为 0.7，实际：${fact.confidence}`);
});

// ============================================================
// LS-05b: extractKeyInfo 无关键词时返回空数组
// ============================================================

test("LS-05b: extractKeyInfo 无关键词时返回空数组", async () => {
  const summarizer = new RuleBasedSummarizer();

  // 无偏好/事实关键词的内容
  const content = "今天天气不错。一起去散步吧。";
  const keyInfos = await summarizer.extractKeyInfo(content);

  // 断言：返回空数组（无匹配关键词）
  assert.equal(keyInfos.length, 0, "无关键词时应返回空数组");
});

// ============================================================
// LS-05c: extractKeyInfo 英文关键词识别
// ============================================================

test("LS-05c: extractKeyInfo 英文关键词识别（prefer/uses）", async () => {
  const summarizer = new RuleBasedSummarizer();

  // 含英文偏好和事实关键词
  const content = "I prefer dark theme. The system uses MySQL database.";
  const keyInfos = await summarizer.extractKeyInfo(content);

  // 断言 1：应识别出 preference（含 "prefer"）
  const preferences = keyInfos.filter((k) => k.type === "preference");
  assert.ok(preferences.length >= 1, "应识别英文 preference（prefer）");

  // 断言 2：应识别出 fact（含 "uses"）
  const facts = keyInfos.filter((k) => k.type === "fact");
  assert.ok(facts.length >= 1, "应识别英文 fact（uses）");
});
