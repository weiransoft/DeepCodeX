export const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]);

export const NON_MULTIMODAL_MODELS = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-chat",
  "deepseek-reasoner",
]);

/**
 * 多模态解析模式（上游 0.3.1 引入）：
 * - "default"：按已知模型列表推断
 * - "on"：强制视为多模态模型
 * - "off"：强制视为非多模态模型
 */
export type MultimodalMode = "default" | "on" | "off";

/**
 * 判断模型是否默认启用 thinking 模式
 *
 * 支持的 thinking 模型：
 * - DeepSeek V4 系列（deepseek-v4-pro / deepseek-v4-flash / vision-exp）
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
 * 判断是否为 Qwen3.8+ 系列模型（3.8 / 3.9 / 4.x 等后续子版本）
 *
 * v1.2 新增（Qwen3.8 适配，见 docs/qwen38-adaptation.md D2）：
 * Qwen3.8 引入官方顶层 reasoning_effort 参数与 preserve_thinking 模板参数，
 * 需按子版本差异化下发，故在 isQwen3Model 粗粒度识别之外增加细粒度判别。
 *
 * 识别规则：model 转小写、去首尾空白后，匹配锚定正则 /^(?:qwen\/)?qwen3\.(\d+)/，
 * 且捕获的 minor 版本号 >= 8
 * 覆盖模型：Qwen/Qwen3.8-27B-FP8 / qwen3.8-27b / qwen3.8-plus /
 * qwen3.8-max-preview / qwen3.9-70b 等
 *
 * 设计说明：
 * - 正则锚定 ^ 并仅允许 qwen/ 前缀，与 isQwen3Model 的命名空间口径
 *   （"qwen3" / "qwen/qwen3" 开头）对齐，保证 isQwen38Model 识别集 ⊆ isQwen3Model 识别集
 * - 必须带小数点（qwen3.8-…），"qwen38" / "qwen30-8b" 等非版本串不匹配
 * - 以 3.8 为能力基线：3.8 引入 reasoning_effort / preserve_thinking，
 *   后续子版本视为向后兼容同一能力集
 * - \d+ 捕获完整数字，两位数 minor（如 qwen3.10）判定为 10 >= 8
 *
 * @param model 模型名称
 * @returns 是否为 Qwen3.8+ 系列模型
 */
export function isQwen38Model(model: string): boolean {
  const lower = model.trim().toLowerCase();
  const match = /^(?:qwen\/)?qwen3\.(\d+)/.exec(lower);
  if (!match) return false;
  return Number(match[1]) >= 8;
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

/**
 * 判断模型是否支持多模态（图片）内容
 *
 * @param model 模型名称
 * @param mode 多模态解析模式（settings.multimodal 解析结果，上游 0.3.1 引入）
 * @returns 是否支持多模态
 */
export function supportsMultimodal(model: string, mode: MultimodalMode = "default"): boolean {
  // 显式配置优先：on/off 直接覆盖模型列表推断
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return !NON_MULTIMODAL_MODELS.has(model.trim());
}
