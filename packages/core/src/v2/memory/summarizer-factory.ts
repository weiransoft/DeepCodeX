/**
 * 摘要器工厂：根据配置创建对应的摘要器 —— F-FOCUS-03 配套
 *
 * 切换逻辑（V2_P2_IMPLEMENTATION_PLAN.md §3.3.4，测试方案 §7.5）：
 * - config.llm.enabled === true 且 DEEPSEEK_API_KEY 环境变量存在 → DeepSeekSummarizer（生产）
 * - 否则 → RuleBasedSummarizer（测试/降级，真实规则非 mock）
 *
 * CI 集成（技术方案 §10.4）：
 * - CI 环境不设置 DEEPSEEK_API_KEY → 自动使用 RuleBasedSummarizer
 * - 本地手测时设置 DEEPSEEK_API_KEY → 使用真实 DeepSeekSummarizer
 * - LS-05 测试：DeepSeekSummarizer 构造不抛错（API 调用本地手测，CI skip）
 *
 * 降级策略（R-P2-04 风险缓解）：
 * - LLM 不可用（无 API key）时自动降级为 RuleBasedSummarizer
 * - 保证 CI 环境无 API key 也能全绿
 *
 * @module v2/memory/summarizer-factory
 */

import type { ContentSummarizer, SummarizerConfig } from "./content-summarizer";
import { DeepSeekSummarizer } from "./deepseek-summarizer";
import { RuleBasedSummarizer } from "./rule-based-summarizer";

/**
 * 创建摘要器实例（工厂方法）
 *
 * 根据 SummarizerConfig.llm.enabled 和环境变量 DEEPSEEK_API_KEY 决定实现：
 * - enabled=true + DEEPSEEK_API_KEY 存在 → DeepSeekSummarizer（真实 LLM 调用）
 * - enabled=true + 无 DEEPSEEK_API_KEY → RuleBasedSummarizer（降级，真实规则非 mock）
 * - enabled=false → RuleBasedSummarizer（测试环境，真实规则非 mock）
 *
 * @param config 摘要器配置（含 llm.enabled 开关）
 * @returns ContentSummarizer 实例（DeepSeek 或 RuleBased）
 */
export function createSummarizer(config: SummarizerConfig): ContentSummarizer {
  if (config.llm.enabled && process.env["DEEPSEEK_API_KEY"]) {
    // 生产环境：真实 LLM 调用（DEEPSEEK_API_KEY 由 env 注入）
    return new DeepSeekSummarizer(process.env["DEEPSEEK_API_KEY"]);
  }
  // 测试环境或未配置 LLM：使用真实规则实现（非 mock，真实启发式算法）
  return new RuleBasedSummarizer();
}
