import type { ReasoningEffort } from "../settings";
// 本仓库 Qwen3 支持保留：Qwen3 系列使用独立的 thinking 参数格式（v1.1 变更）
import { isQwen3Model, isQwen38Model, isDeepSeekThinkingModel } from "./model-capabilities";

type ThinkingConfig = {
  type: "enabled" | "disabled";
};

/**
 * Qwen3.8 官方顶层 reasoning_effort 档位
 *
 * 模型卡仅定义三档：xhigh（默认）/ medium / low。
 * 注意：禁止将本类型/字段挪到公共路径——OpenAI SDK 官方 reasoning_effort
 * 类型只认 low/medium/high，xhigh 发到 OpenAI 官方端点会 400。
 */
type QwenReasoningEffort = "xhigh" | "medium" | "low";

type ThinkingRequestOptions = {
  thinking?: ThinkingConfig;
  extra_body?: {
    reasoning_effort?: ReasoningEffort;
  };
  /**
   * Qwen3 专属：chat_template_kwargs 作为请求体顶层字段
   *
   * vLLM 部署的 Qwen3 模型通过此参数控制 thinking 模式开关。
   * 注意：必须作为顶层字段，不能包装在 extra_body 中——
   * OpenAI Node SDK v6 不会展开 extra_body，包装在内会导致参数失效。
   */
  chat_template_kwargs?: {
    enable_thinking: boolean;
    /**
     * Qwen3.8+ 专属：保留历史消息的思考块
     *
     * v1.2 新增（Qwen3.8 适配，见 docs/qwen38-adaptation.md D3/D4）。
     * 与 CLI 侧 openai-message-converter 无条件回放历史 reasoning_content
     * 的语义一致；显式下发 true 可免疫服务端默认值变更。
     */
    preserve_thinking?: boolean;
  };
  /**
   * Qwen3.8+ 专属：官方顶层 reasoning_effort（xhigh / medium / low）
   *
   * v1.2 新增（Qwen3.8 适配，见 docs/qwen38-adaptation.md D3）。
   * 仅 Qwen3.8+ 分支产出，禁止挪到公共路径（理由见 QwenReasoningEffort 注释）。
   */
  reasoning_effort?: QwenReasoningEffort;
};

/**
 * CLI 五档 reasoningEffort → Qwen3.8 官方三档映射
 *
 * v1.2 新增（Qwen3.8 适配，见 docs/qwen38-adaptation.md D3 映射表）：
 * - low    → low    直传
 * - medium → medium 直传
 * - high   → medium Qwen3.8 无 high 档；保守控制 token 开销，向下钳到次低档
 * - xhigh  → xhigh  直传（Qwen3.8 服务端默认档）
 * - max    → xhigh  max 高于官方最高档，钳制到 xhigh
 * 映射单调不降；settings 默认档 "max" 映射为 xhigh，与模型服务端默认一致，无档位漂移。
 *
 * @param effort CLI 侧五档推理强度
 * @returns Qwen3.8 官方三档值
 */
function mapReasoningEffortToQwen(effort: ReasoningEffort): QwenReasoningEffort {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return "xhigh";
    // high 向下钳制到 medium（保守控制 token 开销）；max 钳制到官方最高档 xhigh
    case "high":
    case "max":
      return effort === "high" ? "medium" : "xhigh";
  }
}

/**
 * 构建 thinking 请求参数
 *
 * 根据 model 判断使用哪种 thinking 参数格式：
 * - Qwen3.8+ 系列：chat_template_kwargs.{enable_thinking, preserve_thinking}（thinking 开启时）
 *   + 顶层 reasoning_effort（xhigh/medium/low，经五档映射）
 * - Qwen3 系列（<3.8）：chat_template_kwargs.enable_thinking（顶层字段，vLLM 标准）
 * - DeepSeek V4 系列：thinking.type + extra_body.reasoning_effort
 * - 其他模型：返回空对象（不传 thinking 参数，模型不支持）
 *
 * v1.1 变更：
 * - 新增第 4 个参数 model（有默认值 ""，向后兼容现有调用方）
 * - 新增 Qwen3 的 chat_template_kwargs 格式支持
 * - 非 thinking 模型返回空对象（原行为是返回 thinking: { type: "disabled" }，
 *   修订后不传 thinking 参数，避免向不支持的模型发送无效字段）
 *
 * v1.2 变更（Qwen3.8 适配，见 docs/qwen38-adaptation.md D3）：
 * - Qwen3.8+ 且 thinking 开启：追加 chat_template_kwargs.preserve_thinking: true
 *   与顶层 reasoning_effort（五档映射表见 mapReasoningEffortToQwen）
 * - Qwen3.8+ 且 thinking 关闭：仅 enable_thinking: false，不新增字段（沿用服务端默认）
 * - 旧 Qwen3（<3.8）与 DeepSeek 分支零回归
 *
 * @param thinkingEnabled 是否启用 thinking 模式
 * @param _baseURL API 基础 URL（保留参数，当前未使用）
 * @param reasoningEffort 推理强度（五档 "low" / "medium" / "high" / "xhigh" / "max"），
 *   DeepSeek 系列经 extra_body 生效，Qwen3.8+ 经顶层 reasoning_effort 映射生效
 * @param model 模型名称（用于判断 thinking 参数格式），默认空字符串
 * @returns thinking 请求参数对象（通过类型拓宽注入 OpenAI SDK 请求体）
 */
export function buildThinkingRequestOptions(
  thinkingEnabled: boolean,
  _baseURL: string | undefined,
  reasoningEffort: ReasoningEffort = "max",
  model: string = ""
): ThinkingRequestOptions {
  // Qwen3 系列：使用 chat_template_kwargs.enable_thinking（顶层字段）
  // vLLM 部署的 Qwen3 模型通过此参数控制 thinking 模式开关
  // 注意：chat_template_kwargs 必须作为请求体顶层字段，不能包装在 extra_body 中
  // （OpenAI Node SDK v6 不会展开 extra_body，包装在内会导致参数失效）
  if (isQwen3Model(model)) {
    // v1.2（Qwen3.8 适配）：Qwen3.8+ 且 thinking 开启时，
    // 追加 preserve_thinking: true（与 CLI 无条件回放历史 reasoning_content 的语义一致，
    // 显式下发免疫服务端默认值变更）与顶层 reasoning_effort（五档映射为官方三档）
    if (isQwen38Model(model) && thinkingEnabled) {
      return {
        chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
        reasoning_effort: mapReasoningEffortToQwen(reasoningEffort),
      };
    }
    // thinking 关闭或非 3.8+ 子版本：仅 enable_thinking，不新增字段（零回归）
    return {
      chat_template_kwargs: { enable_thinking: thinkingEnabled },
    };
  }

  // DeepSeek V4 系列：使用 thinking.type + extra_body.reasoning_effort
  // thinking 为 DeepSeek 非标准扩展字段，SDK 类型未覆盖，经显式类型拓宽注入
  if (isDeepSeekThinkingModel(model)) {
    const thinking: ThinkingConfig = { type: thinkingEnabled ? "enabled" : "disabled" };
    return {
      thinking,
      ...(thinkingEnabled ? { extra_body: { reasoning_effort: reasoningEffort } } : {}),
    };
  }

  // 其他模型：不传 thinking 参数（模型不支持 thinking）
  return {};
}
