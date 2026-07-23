export const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

export const NON_MULTIMODAL_MODELS = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-chat",
  "deepseek-reasoner",
]);

/**
 * 判断模型是否默认启用 thinking 模式
 *
 * 支持的 thinking 模型：
 * - DeepSeek V4 系列（deepseek-v4-pro / deepseek-v4-flash）
 * - Qwen3 系列（所有以 qwen3 开头的模型，含 "Qwen/Qwen3" 前缀格式）
 *
 * v1.1 变更：
 * - 新增 Qwen3 系列识别（大小写不敏感），覆盖 Qwen3-8B / Qwen3-32B /
 *   Qwen3-30B-A3B / Qwen/Qwen3.6-27B / qwen3.6-plus / qwen3.7-max 等
 * - DeepSeek 模型判断改为大小写不敏感（兼容 "DeepSeek-V4-Pro" 等变体）
 *
 * @param model 模型名称（如 "deepseek-v4-pro" / "Qwen/Qwen3.6-27B"）
 * @returns 是否默认启用 thinking 模式
 */
export function defaultsToThinkingMode(model: string): boolean {
  const lower = model.trim().toLowerCase();
  // DeepSeek V4 系列（大小写不敏感）
  if (DEEPSEEK_V4_MODELS.has(lower)) return true;
  // Qwen3 系列（含 "Qwen/Qwen3" 前缀格式，大小写不敏感）
  if (lower.startsWith("qwen3") || lower.startsWith("qwen/qwen3")) return true;
  return false;
}

/**
 * 判断是否为 Qwen3 系列模型
 *
 * 识别规则：model 转小写后以 "qwen3" 或 "qwen/qwen3" 开头
 * 覆盖模型：Qwen3-8B / Qwen3-32B / Qwen3-30B-A3B / Qwen3-235B-A22B /
 * Qwen/Qwen3.6-27B / qwen3.6-plus / qwen3.7-max / qwen3.8-max-preview 等
 *
 * @param model 模型名称
 * @returns 是否为 Qwen3 系列模型
 */
export function isQwen3Model(model: string): boolean {
  const lower = model.trim().toLowerCase();
  return lower.startsWith("qwen3") || lower.startsWith("qwen/qwen3");
}

/**
 * 判断是否为 DeepSeek thinking 模型（支持 thinking.type 参数格式）
 *
 * DeepSeek V4 系列使用 thinking: { type: "enabled" | "disabled" } 参数格式
 * 控制 thinking 模式，与 Qwen3 的 chat_template_kwargs.enable_thinking 格式不同
 *
 * @param model 模型名称
 * @returns 是否为 DeepSeek thinking 模型
 */
export function isDeepSeekThinkingModel(model: string): boolean {
  return DEEPSEEK_V4_MODELS.has(model.trim().toLowerCase());
}

export function supportsMultimodal(model: string): boolean {
  return !NON_MULTIMODAL_MODELS.has(model.trim());
}
