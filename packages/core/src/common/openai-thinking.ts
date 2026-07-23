import type { ReasoningEffort } from "../settings";
import { isQwen3Model, isDeepSeekThinkingModel } from "./model-capabilities";

type ThinkingConfig = {
  type: "enabled" | "disabled";
};

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
  };
};

/**
 * 构建 thinking 请求参数
 *
 * 根据 model 判断使用哪种 thinking 参数格式：
 * - Qwen3 系列：chat_template_kwargs.enable_thinking（顶层字段，vLLM 标准）
 * - DeepSeek V4 系列：thinking.type + extra_body.reasoning_effort
 * - 其他模型：返回空对象（不传 thinking 参数，模型不支持）
 *
 * v1.1 变更：
 * - 新增第 4 个参数 model（有默认值 ""，向后兼容现有调用方）
 * - 新增 Qwen3 的 chat_template_kwargs 格式支持
 * - 非 thinking 模型返回空对象（原行为是返回 thinking: { type: "disabled" }，
 *   修订后不传 thinking 参数，避免向不支持的模型发送无效字段）
 *
 * @param thinkingEnabled 是否启用 thinking 模式
 * @param _baseURL API 基础 URL（保留参数，当前未使用）
 * @param reasoningEffort 推理强度（"high" / "max"），仅 DeepSeek 系列生效
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
