export const DEEPSEEK_V4_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
  "deepseek-flash",
]);

/**
 * 非多模态模型集合（默认不支持图片内容的模型）
 * 用于 supportsMultimodal 的反推判定：不在此集合中的模型默认为多模态模型。
 *
 * fork 侧新增，用于多模态正推模型列表（upstream 0.4.0 采用 "deepseek-flash 或含 -vision" 正推）。
 */
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

/**
 * 从带路径前缀的模型名中提取实际模型名（最后一个 "/" 之后的部分）
 *
 * 部署场景中模型名常带注册中心/命名空间前缀，例如：
 * - "ms/kpanda-global-cluster/public/qwen38-27b-awq" → "qwen38-27b-awq"
 * - "Qwen/Qwen3.6-27B"                                → "Qwen3.6-27B"
 * - "registry.cn-hangzhou.aliyuncs.com/qwen3.5"      → "qwen3.5"
 * - "qwen3-32b"                                      → "qwen3-32b"（无 "/" 原样返回）
 *
 * 设计约束：
 * - 只按最后一个 "/" 分割，保持路径前缀不做语义解析（避免 "/" 出现在版本串中的极端 case）
 * - 返回值 trim() 过，与上游 model 预处理口径保持一致
 *
 * @param model 原始模型名（可能含路径前缀）
 * @returns 最后一个 "/" 之后的实际模型名；无 "/" 时返回 trim 后的原值
 */
function stripModelPathPrefix(model: string): string {
  const trimmed = model.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

/**
 * 判断模型是否默认启用 thinking 模式
 *
 * 支持的 thinking 模型：
 * - DeepSeek V4 系列（deepseek-v4-pro / deepseek-v4-flash / vision-exp）
 * - Qwen3 系列（所有以 qwen3 开头的模型，含路径前缀如 "ms/.../qwen38-27b-awq"）
 *
 * v1.1 变更：
 * - 新增 Qwen3 系列识别（大小写不敏感 + 路径前缀剥离），覆盖：
 *   无前缀：qwen3-8B / qwen3-32B / qwen3.6-plus / qwen3.7-max 等
 *   有前缀：Qwen/Qwen3.6-27B / ms/kpanda/.../qwen38-27b-awq 等
 * - DeepSeek 模型判断改为大小写不敏感（兼容 "DeepSeek-V4-Pro" 等变体）
 * - 关键修复（2026-09-30）：路径前缀剥离——部署场景中模型名常带注册中心
 *   前缀（如 "ms/kpanda-global-cluster/public/qwen38-27b-awq"），
 *   此前 startsWith("qwen3") 完全 MISS → flattenMidConversationSystemMessages
 *   未触发 → 中间 system 消息未转换 → 上游 vLLM 返回 400
 *
 * @param model 模型名称（如 "deepseek-v4-pro" / "Qwen/Qwen3.6-27B" / "ms/.../qwen38-27b-awq"）
 * @returns 是否默认启用 thinking 模式
 */
export function defaultsToThinkingMode(model: string): boolean {
  const lower = model.trim().toLowerCase();
  // DeepSeek V4 系列（大小写不敏感）
  if (DEEPSEEK_V4_MODELS.has(lower)) return true;
  // Qwen3 系列：去掉路径前缀（ms/.../），再判断 startsWith("qwen3")
  const bare = stripModelPathPrefix(lower);
  if (bare.startsWith("qwen3")) return true;
  return false;
}

/**
 * 判断是否为 Qwen3 系列模型
 *
 * 识别规则：
 * 1. model 转小写 → trim()
 * 2. 剥离最后一个 "/" 之前的路径前缀（注册中心 / 命名空间 / 团队等）
 * 3. 剥离后的实际模型名以 "qwen3" 开头
 *
 * 覆盖模型：
 * - 无前缀：qwen3-8B / qwen3-32B / qwen3.6-plus / qwen3.7-max 等
 * - 有前缀：Qwen/Qwen3.6-27B / ms/kpanda/.../qwen38-27b-awq 等
 *
 * 关键修复（2026-09-30）：此前仅判断 startsWith("qwen3") 或 startsWith("qwen/qwen3")，
 * 对带注册中心前缀的部署模型（如 "ms/kpanda-global-cluster/public/qwen38-27b-awq"）
 * 完全 MISS，导致 Qwen3 兼容的 flattenMidConversationSystemMessages 未触发，
 * 上游 vLLM 收到中间含 system 的 messages → "System message must be at the beginning" 400。
 *
 * @param model 模型名称（可含路径前缀）
 * @returns 是否为 Qwen3 系列模型
 */
export function isQwen3Model(model: string): boolean {
  const bare = stripModelPathPrefix(model.trim().toLowerCase());
  return bare.startsWith("qwen3");
}

/**
 * 判断是否为 Qwen3.8+ 系列模型（3.8 / 3.9 / 4.x 等后续子版本）
 *
 * v1.2 新增（Qwen3.8 适配，见 docs/qwen38-adaptation.md D2）：
 * Qwen3.8 引入官方顶层 reasoning_effort 参数与 preserve_thinking 模板参数，
 * 需按子版本差异化下发，故在 isQwen3Model 粗粒度识别之外增加细粒度判别。
 *
 * 识别规则：
 * 1. model 转小写 → trim() → 剥离路径前缀
 * 2. 对剥离后的实际模型名匹配 /^qwen3\.(\d+)/，捕获 minor 版本号
 * 3. minor >= 8 视为 Qwen3.8+
 *
 * 覆盖模型：
 * - 无前缀：qwen3.8-27b / qwen3.8-plus / qwen3.9-70b 等
 * - 有前缀：ms/.../qwen3.8-27b-awq / Qwen/Qwen3.8-27B-FP8 等
 *
 * 设计说明：
 * - 与 isQwen3Model 共享 stripModelPathPrefix，保证 isQwen38Model 识别集 ⊆ isQwen3Model 识别集
 * - 必须带小数点（qwen3.8-…），"qwen38" / "qwen30-8b" 等非版本串不匹配
 * - 以 3.8 为能力基线：3.8 引入 reasoning_effort / preserve_thinking
 * - \d+ 捕获完整数字，两位数 minor（如 qwen3.10）判定为 10 >= 8
 *
 * @param model 模型名称（可含路径前缀）
 * @returns 是否为 Qwen3.8+ 系列模型
 */
export function isQwen38Model(model: string): boolean {
  const bare = stripModelPathPrefix(model.trim().toLowerCase());
  const match = /^qwen3\.(\d+)/.exec(bare);
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
 * 默认模式（"default"）下使用 NON_MULTIMODAL_MODELS 反推：
 * 不在非多模态集合中的模型视为多模态模型。
 * 也兼容 "deepseek-flash" 或含 "-vision" 正推识别（upstream 0.4.0 逻辑）。
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
  const normalized = model.trim();
  // fork 反推：不在非多模态集合中 → 视为多模态
  if (!NON_MULTIMODAL_MODELS.has(normalized)) return true;
  // upstream 0.4.0 正推兜底：deepseek-flash 或含 -vision
  if (normalized === "deepseek-flash" || normalized.includes("-vision")) return true;
  return false;
}
