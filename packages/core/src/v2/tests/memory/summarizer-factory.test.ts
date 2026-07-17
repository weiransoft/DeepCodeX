/**
 * summarizer-factory 单元测试（F-FOCUS-03 配套，V2-P2 新增）
 *
 * 测试覆盖（V2_P2_IMPLEMENTATION_PLAN.md §4.4 + V2 测试方案 §7.5）：
 * - LS-FACT-01: config.llm.enabled=false → RuleBasedSummarizer（测试环境）
 * - LS-FACT-02: config.llm.enabled=true + 无 DEEPSEEK_API_KEY → RuleBasedSummarizer（降级）
 * - LS-FACT-03: config.llm.enabled=true + 有 DEEPSEEK_API_KEY → DeepSeekSummarizer（生产，仅验证类型，不调用 API）
 *
 * 环境变量处理：
 * - LS-FACT-03 需临时设置 DEEPSEEK_API_KEY，测试后立即恢复（避免污染其他测试）
 * - 使用 try-finally 确保环境变量恢复
 *
 * @module v2/tests/memory/summarizer-factory.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSummarizer } from "../../memory/summarizer-factory";
import { RuleBasedSummarizer } from "../../memory/rule-based-summarizer";
import { DeepSeekSummarizer } from "../../memory/deepseek-summarizer";

// ============================================================================
// LS-FACT 测试用例（LS-FACT-01 ~ LS-FACT-03）
// ============================================================================

// ============================================================
// LS-FACT-01: config.llm.enabled=false → RuleBasedSummarizer
// ============================================================

test("LS-FACT-01: config.llm.enabled=false → RuleBasedSummarizer（测试环境）", () => {
  // llm.enabled=false → 必定使用 RuleBasedSummarizer（无论 DEEPSEEK_API_KEY 是否存在）
  const summarizer = createSummarizer({ llm: { enabled: false } });

  // 断言：返回 RuleBasedSummarizer 实例（真实启发式算法，非 mock）
  assert.ok(summarizer instanceof RuleBasedSummarizer, "llm.enabled=false 应返回 RuleBasedSummarizer 实例");
  assert.ok(!(summarizer instanceof DeepSeekSummarizer), "llm.enabled=false 不应返回 DeepSeekSummarizer 实例");
});

// ============================================================
// LS-FACT-02: config.llm.enabled=true + 无 DEEPSEEK_API_KEY → RuleBasedSummarizer（降级）
// ============================================================

test("LS-FACT-02: config.llm.enabled=true + 无 DEEPSEEK_API_KEY → RuleBasedSummarizer（降级）", () => {
  // 保存原始环境变量，测试后恢复
  const originalKey = process.env["DEEPSEEK_API_KEY"];
  try {
    // 确保无 DEEPSEEK_API_KEY
    delete process.env["DEEPSEEK_API_KEY"];

    // llm.enabled=true 但无 API key → 降级为 RuleBasedSummarizer
    const summarizer = createSummarizer({ llm: { enabled: true } });

    // 断言：降级为 RuleBasedSummarizer（CI 环境无 API key，确保测试全绿）
    assert.ok(
      summarizer instanceof RuleBasedSummarizer,
      "llm.enabled=true + 无 DEEPSEEK_API_KEY 应降级为 RuleBasedSummarizer"
    );
  } finally {
    // 恢复原始环境变量
    if (originalKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = originalKey;
    }
  }
});

// ============================================================
// LS-FACT-03: config.llm.enabled=true + 有 DEEPSEEK_API_KEY → DeepSeekSummarizer
// ============================================================

test("LS-FACT-03: config.llm.enabled=true + 有 DEEPSEEK_API_KEY → DeepSeekSummarizer（仅验证类型，不调用 API）", () => {
  // 保存原始环境变量，测试后恢复
  const originalKey = process.env["DEEPSEEK_API_KEY"];
  try {
    // 设置测试用 API key（仅用于工厂方法判断，不实际调用 API）
    process.env["DEEPSEEK_API_KEY"] = "test-key-for-factory-assertion-only";

    // llm.enabled=true + 有 API key → DeepSeekSummarizer
    const summarizer = createSummarizer({ llm: { enabled: true } });

    // 断言：返回 DeepSeekSummarizer 实例（生产环境，真实 LLM 调用）
    // 注：仅验证类型，不调用 summarize/extractKeyInfo（避免实际 API 请求）
    assert.ok(
      summarizer instanceof DeepSeekSummarizer,
      "llm.enabled=true + 有 DEEPSEEK_API_KEY 应返回 DeepSeekSummarizer 实例"
    );
    assert.ok(
      !(summarizer instanceof RuleBasedSummarizer),
      "不应返回 RuleBasedSummarizer 实例（应使用 DeepSeek 生产实现）"
    );
  } finally {
    // 恢复原始环境变量（避免污染其他测试）
    if (originalKey === undefined) {
      delete process.env["DEEPSEEK_API_KEY"];
    } else {
      process.env["DEEPSEEK_API_KEY"] = originalKey;
    }
  }
});
