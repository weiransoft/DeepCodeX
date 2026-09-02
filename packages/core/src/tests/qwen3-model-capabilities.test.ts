import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultsToThinkingMode,
  isQwen3Model,
  isDeepSeekThinkingModel,
  DEEPSEEK_V4_MODELS,
  NON_MULTIMODAL_MODELS,
} from "../common/model-capabilities";

// ============================================================================
// Qwen3 模型识别单元测试
//
// 验证点（对应设计文档 §7 验收标准 1）：
//   1. defaultsToThinkingMode 正确识别 Qwen3 系列模型（默认启用 thinking）
//   2. defaultsToThinkingMode 保持 DeepSeek V4 系列识别不变（回归保护）
//   3. defaultsToThinkingMode 对非-thinking 模型返回 false
//   4. isQwen3Model 正确识别各种 Qwen3 模型名变体
//   5. isDeepSeekThinkingModel 正确识别 DeepSeek V4 系列
//   6. 大小写不敏感识别
// ============================================================================

test("defaultsToThinkingMode 对 Qwen3 系列模型返回 true", () => {
  // 用户参数中的模型名
  assert.ok(defaultsToThinkingMode("Qwen/Qwen3.6-27B"), "Qwen/Qwen3.6-27B 应默认启用 thinking");

  // 标准 Qwen3 模型名
  assert.ok(defaultsToThinkingMode("qwen3-8b"), "qwen3-8b 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3-14b"), "qwen3-14b 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3-32b"), "qwen3-32b 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3-30b-a3b"), "qwen3-30b-a3b 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3-235b-a22b"), "qwen3-235b-a22b 应默认启用 thinking");

  // 百炼平台模型 ID 格式
  assert.ok(defaultsToThinkingMode("qwen3.6-flash"), "qwen3.6-flash 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3.6-plus"), "qwen3.6-plus 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3.6-max-preview"), "qwen3.6-max-preview 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3.7-plus"), "qwen3.7-plus 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3.7-max"), "qwen3.7-max 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("qwen3.8-max-preview"), "qwen3.8-max-preview 应默认启用 thinking");
});

test("defaultsToThinkingMode 对 Qwen3 模型名大小写不敏感", () => {
  assert.ok(defaultsToThinkingMode("QWEN3-32B"), "QWEN3-32B 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("Qwen3-32B"), "Qwen3-32B 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode(" qwen3-32b "), "带空格的 qwen3-32b 应默认启用 thinking（trim 处理）");
  assert.ok(defaultsToThinkingMode("QWEN/QWEN3.6-27B"), "QWEN/QWEN3.6-27B 应默认启用 thinking");
});

test("defaultsToThinkingMode 对 DeepSeek V4 系列保持识别（回归保护）", () => {
  assert.ok(defaultsToThinkingMode("deepseek-v4-pro"), "deepseek-v4-pro 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("deepseek-v4-flash"), "deepseek-v4-flash 应默认启用 thinking");
  assert.ok(defaultsToThinkingMode("DeepSeek-V4-Pro"), "DeepSeek-V4-Pro 应默认启用 thinking（大小写不敏感）");
});

test("defaultsToThinkingMode 对非-thinking 模型返回 false", () => {
  assert.ok(!defaultsToThinkingMode("gpt-4"), "gpt-4 不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode("gpt-4o"), "gpt-4o 不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode("claude-3-opus"), "claude-3-opus 不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode("deepseek-chat"), "deepseek-chat 不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode("deepseek-reasoner"), "deepseek-reasoner 不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode("qwen-72b"), "qwen-72b（Qwen2 系列）不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode(""), "空字符串不应默认启用 thinking");
  assert.ok(!defaultsToThinkingMode("unknown-model"), "未知模型不应默认启用 thinking");
});

test("isQwen3Model 识别各种 Qwen3 模型名变体", () => {
  // 带 Qwen/ 前缀（HuggingFace / vLLM 格式）
  assert.ok(isQwen3Model("Qwen/Qwen3.6-27B"), "Qwen/Qwen3.6-27B 应识别为 Qwen3");
  assert.ok(isQwen3Model("Qwen/Qwen3-32B"), "Qwen/Qwen3-32B 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen/qwen3-8b"), "qwen/qwen3-8b 应识别为 Qwen3（大小写不敏感）");

  // 不带前缀
  assert.ok(isQwen3Model("qwen3-32b"), "qwen3-32b 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen3.6-plus"), "qwen3.6-plus 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen3.7-max"), "qwen3.7-max 应识别为 Qwen3");

  // 带空格（trim 处理）
  assert.ok(isQwen3Model("  qwen3-32b  "), "带空格的 qwen3-32b 应识别为 Qwen3");
});

test("isQwen3Model 拒绝非 Qwen3 模型", () => {
  // Qwen2 系列（不应识别为 Qwen3）
  assert.ok(!isQwen3Model("qwen-72b"), "qwen-72b 不应识别为 Qwen3");
  assert.ok(!isQwen3Model("qwen2-72b"), "qwen2-72b 不应识别为 Qwen3");

  // 其他厂商模型
  assert.ok(!isQwen3Model("deepseek-v4-pro"), "deepseek-v4-pro 不应识别为 Qwen3");
  assert.ok(!isQwen3Model("gpt-4"), "gpt-4 不应识别为 Qwen3");
  assert.ok(!isQwen3Model("claude-3-opus"), "claude-3-opus 不应识别为 Qwen3");

  // 边界情况
  assert.ok(!isQwen3Model(""), "空字符串不应识别为 Qwen3");
  assert.ok(!isQwen3Model("qwen"), "qwen（无版本号）不应识别为 Qwen3");
});

test("isDeepSeekThinkingModel 识别 DeepSeek V4 系列", () => {
  assert.ok(isDeepSeekThinkingModel("deepseek-v4-pro"), "deepseek-v4-pro 应识别为 DeepSeek thinking 模型");
  assert.ok(isDeepSeekThinkingModel("deepseek-v4-flash"), "deepseek-v4-flash 应识别为 DeepSeek thinking 模型");
  assert.ok(isDeepSeekThinkingModel("DeepSeek-V4-Pro"), "DeepSeek-V4-Pro 应识别（大小写不敏感）");
  assert.ok(isDeepSeekThinkingModel("  deepseek-v4-pro  "), "带空格应识别（trim 处理）");
});

test("isDeepSeekThinkingModel 拒绝非 V4 系列", () => {
  assert.ok(!isDeepSeekThinkingModel("deepseek-chat"), "deepseek-chat 不应识别为 thinking 模型");
  assert.ok(!isDeepSeekThinkingModel("deepseek-reasoner"), "deepseek-reasoner 不应识别为 thinking 模型");
  assert.ok(!isDeepSeekThinkingModel("deepseek-v3"), "deepseek-v3 不应识别为 thinking 模型");
  assert.ok(!isDeepSeekThinkingModel("Qwen/Qwen3.6-27B"), "Qwen3 不应识别为 DeepSeek thinking 模型");
  assert.ok(!isDeepSeekThinkingModel(""), "空字符串不应识别为 DeepSeek thinking 模型");
});

test("DEEPSEEK_V4_MODELS 集合包含预期的三个模型", () => {
  // 合并上游 0.3.1 后新增多模态实验模型 deepseek-v4-flash-vision-exp（共 3 个）
  assert.equal(DEEPSEEK_V4_MODELS.size, 3, "DEEPSEEK_V4_MODELS 应包含 3 个模型");
  assert.ok(DEEPSEEK_V4_MODELS.has("deepseek-v4-pro"), "应包含 deepseek-v4-pro");
  assert.ok(DEEPSEEK_V4_MODELS.has("deepseek-v4-flash"), "应包含 deepseek-v4-flash");
  assert.ok(DEEPSEEK_V4_MODELS.has("deepseek-v4-flash-vision-exp"), "应包含 deepseek-v4-flash-vision-exp");
});

test("NON_MULTIMODAL_MODELS 集合包含 DeepSeek 系列（非多模态）", () => {
  assert.ok(NON_MULTIMODAL_MODELS.has("deepseek-v4-pro"), "deepseek-v4-pro 应为非多模态");
  assert.ok(NON_MULTIMODAL_MODELS.has("deepseek-v4-flash"), "deepseek-v4-flash 应为非多模态");
  assert.ok(NON_MULTIMODAL_MODELS.has("deepseek-chat"), "deepseek-chat 应为非多模态");
  assert.ok(NON_MULTIMODAL_MODELS.has("deepseek-reasoner"), "deepseek-reasoner 应为非多模态");
  // Qwen3 系列不在非多模态列表中（默认支持多模态）
  assert.ok(!NON_MULTIMODAL_MODELS.has("qwen3-32b"), "qwen3-32b 不应在非多模态列表中");
});
