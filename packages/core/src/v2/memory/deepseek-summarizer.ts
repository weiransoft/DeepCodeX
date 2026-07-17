/**
 * 生产环境摘要器：调用真实 DeepSeek LLM API —— F-FOCUS-03 配套
 *
 * 复用既有 OpenAI SDK（与 common/openai-client.ts 相同模式），
 * 通过 baseURL 指向 DeepSeek API，无新增依赖（R-01 红线：零新增依赖）。
 *
 * 仅在配置启用 LLM 且 API key 可用时使用（由 summarizer-factory.ts 工厂方法判断）。
 *
 * 设计依据：
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.3.2
 * - V2 测试方案 §7.3
 * - 架构师审查 P1-1：增加 30s 超时，避免 LLM 调用阻塞 compressOldSnippets
 *
 * 超时策略（P1-1 架构师建议）：
 * - summarize 和 extractKeyInfo 均设置 30s 超时（AbortSignal.timeout）
 * - 超时后抛错，由 compressOldSnippets 的 try-catch 捕获并跳过该片段
 * - 不中断整体 buildWindow 流程
 *
 * JSON 解析降级（extractKeyInfo）：
 * - LLM 返回的 JSON 可能格式错误（非严格 JSON / 包含 markdown 代码块标记）
 * - 解析失败时返回空数组，不抛错（失败安全）
 *
 * @module v2/memory/deepseek-summarizer
 */

import OpenAI from "openai";
import { DEFAULT_BASE_URL } from "../integration/v1-adapters";
import type { ContentSummarizer, KeyInfo } from "./content-summarizer";

/** LLM 调用超时时间（毫秒，P1-1 架构师建议 30s） */
const LLM_TIMEOUT_MS = 30_000;

/** 默认模型名（与 settings.ts DEFAULT_MODEL 一致） */
const DEFAULT_MODEL_NAME = "deepseek-v4-pro";

/**
 * DeepSeek 摘要器（生产环境实现）
 *
 * 通过 OpenAI SDK 兼容接口调用 DeepSeek API。
 * 构造时需提供 apiKey（由 summarizer-factory.ts 从 env 读取）。
 */
export class DeepSeekSummarizer implements ContentSummarizer {
  /** OpenAI SDK 客户端实例（复用既有依赖，无新增） */
  private readonly client: OpenAI;
  /** 模型名（默认 deepseek-v4-pro） */
  private readonly model: string;

  /**
   * @param apiKey DeepSeek API Key（由调用方从 settings/env 获取）
   * @param model 模型名（可选，默认 deepseek-v4-pro，与 settings.ts DEFAULT_MODEL 一致）
   * @param baseURL API 基址（可选，默认 https://api.deepseek.com）
   */
  constructor(apiKey: string, model: string = DEFAULT_MODEL_NAME, baseURL: string = DEFAULT_BASE_URL) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  /**
   * 生成内容摘要（真实 LLM 调用）
   *
   * 调用 DeepSeek chat completions API，system message 指示生成不超过 maxLength 字符的摘要。
   * max_tokens 按 maxLength/4 估算（4 字符≈1 token，与 SlidingWindowManager 一致）。
   * temperature=0.3 保证摘要稳定性（低随机性）。
   *
   * 超时策略：30s 超时（AbortSignal.timeout），超时抛错由调用方捕获降级。
   *
   * @param content 原始内容
   * @param maxLength 最大长度（字符数）
   * @returns 摘要字符串（LLM 返回的 content，可能为空串）
   */
  async summarize(content: string, maxLength: number): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: "system", content: `请生成不超过 ${maxLength} 字符的摘要，保留关键信息。` },
          { role: "user", content },
        ],
        max_tokens: Math.ceil(maxLength / 4),
        temperature: 0.3,
      },
      { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }
    );
    return response.choices[0]?.message?.content ?? "";
  }

  /**
   * 提取关键信息（真实 LLM 抽取）
   *
   * 调用 DeepSeek chat completions API，要求返回 JSON 格式：
   * { "items": [{ "type": "preference"|"fact"|"skill"|"task", "content": "...", "confidence": 0.0-1.0 }] }
   *
   * 使用 response_format: { type: "json_object" } 强制 JSON 输出。
   * 解析失败时返回空数组（失败安全，不抛错）。
   *
   * 超时策略：30s 超时（AbortSignal.timeout），超时抛错由调用方捕获降级。
   *
   * @param content 原始内容
   * @returns 关键信息数组（解析失败时返回空数组）
   */
  async extractKeyInfo(content: string): Promise<KeyInfo[]> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "从内容中提取关键信息，返回 JSON 对象，含 items 数组，每项含 type(preference/fact/skill/task)、content、confidence 字段。",
          },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
      },
      { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }
    );
    const text = response.choices[0]?.message?.content ?? '{"items":[]}';
    try {
      const parsed = JSON.parse(text) as { items?: KeyInfo[] };
      return parsed.items ?? [];
    } catch {
      // JSON 解析失败：返回空数组（降级，不抛错，失败安全）
      return [];
    }
  }
}
