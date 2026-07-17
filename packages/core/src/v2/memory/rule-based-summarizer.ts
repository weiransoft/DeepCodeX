/**
 * 测试环境摘要器：基于真实启发式规则（非 mock）—— F-FOCUS-03 配套
 *
 * 实现完整的摘要生成逻辑，不依赖外部 LLM。
 *
 * 算法：
 * 1. 按句子分割（中文。！？与英文 .!? 与换行符）
 * 2. 句子评分：首句加权 +2，末句加权 +1，含关键词加权 +1.5/+1，长度适中 +0.5
 * 3. 按分数降序选取，直到达到 maxLength
 * 4. 按原顺序输出（保持语义连贯性）
 *
 * 设计依据：
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.3.3
 * - V2 测试方案 §7.4（真实规则实现，禁止 mock）
 * - 用户规则：禁止使用 mock/占位/简化，严格真实实现
 *
 * 关键词字典设计：
 * - PREFERENCE_KEYWORDS：偏好识别（"偏好/喜欢/总是/习惯/倾向" + 英文对应）
 * - FACT_KEYWORDS：事实识别（"是/等于/位于/使用" + 英文对应）
 * - 字典为中英文双语，支持国际化场景
 *
 * @module v2/memory/rule-based-summarizer
 */

import type { ContentSummarizer, KeyInfo } from "./content-summarizer";

/**
 * 基于规则的摘要器（真实启发式算法实现）
 *
 * 不调用任何外部 LLM，纯本地计算。适用于：
 * - CI 环境（无 DEEPSEEK_API_KEY）
 * - 离线场景
 * - DeepSeek API 不可用时的降级
 */
export class RuleBasedSummarizer implements ContentSummarizer {
  /** 偏好关键词字典（用于偏好识别，中英文双语） */
  private static readonly PREFERENCE_KEYWORDS: readonly string[] = [
    "偏好",
    "喜欢",
    "总是",
    "习惯",
    "倾向",
    "prefer",
    "like",
    "always",
  ];

  /** 事实关键词字典（用于事实识别，中英文双语） */
  private static readonly FACT_KEYWORDS: readonly string[] = ["是", "等于", "位于", "使用", "is", "equals", "uses"];

  /**
   * 生成内容摘要（真实启发式算法）
   *
   * 算法步骤：
   * 1. 按句子分割（中英文标点 + 换行符）
   * 2. 对每个句子评分（首句+2 / 末句+1 / 含偏好词+1.5 / 含事实词+1 / 长度适中+0.5）
   * 3. 按分数降序选取句子，累计长度不超过 maxLength
   * 4. 按原文本顺序重新排列选中句子（保持语义连贯）
   * 5. 用空格拼接为摘要字符串
   *
   * 边界处理：
   * - content 为空 → 返回空串
   * - 所有句子都超 maxLength → 返回空串（无法容纳任何完整句子）
   * - 单句超 maxLength 但分数最高 → 跳过该句（保持句子完整性，不截断）
   *
   * @param content 原始内容
   * @param maxLength 最大长度（字符数）
   * @returns 摘要字符串
   */
  async summarize(content: string, maxLength: number): Promise<string> {
    const sentences = this.splitSentences(content);
    if (sentences.length === 0) return "";

    // 句子评分：构建带索引和分数的数组
    const scored = sentences.map((sentence, index) => ({
      sentence,
      score: this.scoreSentence(sentence, index, sentences.length),
      index,
    }));

    // 按分数降序排序（高分优先选取）
    scored.sort((a, b) => b.score - a.score);

    // 按分数降序选取句子，累计长度不超过 maxLength
    const selected: Array<{ sentence: string; index: number }> = [];
    let currentLength = 0;
    for (const item of scored) {
      if (currentLength + item.sentence.length > maxLength) {
        // 当前句子加进去会超长：跳过（保持句子完整性，不截断）
        continue;
      }
      selected.push({ sentence: item.sentence, index: item.index });
      currentLength += item.sentence.length;
    }

    // 按原文本顺序重新排列（保持语义连贯性，LS-04 测试要求）
    selected.sort((a, b) => a.index - b.index);

    // 用空格拼接为摘要字符串
    return selected.map((s) => s.sentence).join(" ");
  }

  /**
   * 提取关键信息（真实规则提取，非 mock）
   *
   * 遍历每个句子，匹配偏好/事实关键词字典：
   * - 偏好匹配 → KeyInfo{type: "preference", confidence: 0.8}
   * - 事实匹配 → KeyInfo{type: "fact", confidence: 0.7}
   *
   * 一个句子可能同时匹配偏好和事实，产出多条 KeyInfo（不同 type）。
   *
   * @param content 原始内容
   * @returns 关键信息数组
   */
  async extractKeyInfo(content: string): Promise<KeyInfo[]> {
    const results: KeyInfo[] = [];
    const sentences = this.splitSentences(content);

    for (const sentence of sentences) {
      // 规则 1：偏好识别（含偏好关键词 → preference 类型）
      if (RuleBasedSummarizer.PREFERENCE_KEYWORDS.some((kw) => sentence.includes(kw))) {
        results.push({
          type: "preference",
          content: sentence,
          confidence: 0.8,
        });
      }
      // 规则 2：事实识别（含事实关键词 → fact 类型）
      if (RuleBasedSummarizer.FACT_KEYWORDS.some((kw) => sentence.includes(kw))) {
        results.push({
          type: "fact",
          content: sentence,
          confidence: 0.7,
        });
      }
    }

    return results;
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 句子分割（真实实现）
   *
   * 按中文句号（。）、英文句号（.）、问号（!?！？）和换行符分割。
   * 分割后 trim 每个句子，过滤空串。
   *
   * @param text 原始文本
   * @returns 句子数组（已 trim，过滤空串）
   */
  private splitSentences(text: string): string[] {
    return text
      .split(/[。.!?！？\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * 句子评分（真实算法）
   *
   * 评分维度（累加）：
   * - 首句加权 +2（首句通常包含主题，最重要）
   * - 末句加权 +1（末句通常是结论，较重要）
   * - 含偏好关键词 +1.5（偏好信息高价值）
   * - 含事实关键词 +1（事实信息中价值）
   * - 长度适中（10-200 字符）+0.5（过短信息不足，过长可能跑题）
   *
   * @param sentence 句子
   * @param index 句子索引（0-based）
   * @param total 总句数
   * @returns 评分（浮点数，越高越重要）
   */
  private scoreSentence(sentence: string, index: number, total: number): number {
    let score = 0;
    // 首句加权（主题句）
    if (index === 0) score += 2;
    // 末句加权（结论句）
    if (index === total - 1) score += 1;
    // 含偏好关键词加权
    if (RuleBasedSummarizer.PREFERENCE_KEYWORDS.some((kw) => sentence.includes(kw))) {
      score += 1.5;
    }
    // 含事实关键词加权
    if (RuleBasedSummarizer.FACT_KEYWORDS.some((kw) => sentence.includes(kw))) {
      score += 1;
    }
    // 长度适中加权（10-200 字符为信息密度最佳区间）
    if (sentence.length > 10 && sentence.length < 200) score += 0.5;
    return score;
  }
}
