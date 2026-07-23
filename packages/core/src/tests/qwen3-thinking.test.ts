import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingRequestOptions } from "../common/openai-thinking";

// ============================================================================
// Qwen3 thinking 参数格式单元测试
//
// 验证点（对应设计文档 §7 验收标准 1-3）：
//   1. Qwen3 模型启用 thinking → 返回顶层 chat_template_kwargs.enable_thinking=true
//   2. Qwen3 模型关闭 thinking → 返回顶层 chat_template_kwargs.enable_thinking=false
//   3. Qwen3 模型不返回 thinking / extra_body 字段（与 DeepSeek 格式严格区分）
//   4. DeepSeek 格式不受 Qwen3 改动影响（回归保护）
//   5. 非-thinking 模型返回空对象（不向不支持的模型发送 thinking 参数）
//
// 关键事实（B4 修复）：
//   OpenAI Node SDK v6 不展开 extra_body，Qwen3 的 chat_template_kwargs
//   必须作为请求体顶层字段，不能包装在 extra_body 中。
// ============================================================================
import { isQwen3Model, isDeepSeekThinkingModel } from "../common/model-capabilities";

test("Qwen3.6-27B 启用 thinking 返回顶层 chat_template_kwargs.enable_thinking=true", () => {
  const result = buildThinkingRequestOptions(true, "http://47.95.252.237:8003/v1", "max", "Qwen/Qwen3.6-27B");
  assert.deepEqual(result, {
    chat_template_kwargs: { enable_thinking: true },
  });
  // 严格断言：不应包含 DeepSeek 格式的 thinking / extra_body 字段
  assert.ok(!("thinking" in result), "Qwen3 格式不应包含 thinking 字段");
  assert.ok(!("extra_body" in result), "Qwen3 格式不应包含 extra_body 字段");
});

test("Qwen3.6-27B 关闭 thinking 返回顶层 chat_template_kwargs.enable_thinking=false", () => {
  const result = buildThinkingRequestOptions(false, "http://47.95.252.237:8003/v1", "max", "Qwen/Qwen3.6-27B");
  assert.deepEqual(result, {
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.ok(!("thinking" in result), "Qwen3 格式不应包含 thinking 字段");
  assert.ok(!("extra_body" in result), "Qwen3 格式不应包含 extra_body 字段");
});

test("Qwen3-32B 启用 thinking 返回顶层 chat_template_kwargs（不带 Qwen/ 前缀）", () => {
  const result = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "high", "qwen3-32b");
  assert.deepEqual(result, {
    chat_template_kwargs: { enable_thinking: true },
  });
});

test("Qwen3-30B-A3B 关闭 thinking 返回顶层 chat_template_kwargs.enable_thinking=false", () => {
  const result = buildThinkingRequestOptions(false, "http://localhost:8000/v1", "max", "qwen3-30b-a3b");
  assert.deepEqual(result, {
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("Qwen3.7-max 启用 thinking（百炼平台模型 ID 格式）", () => {
  const result = buildThinkingRequestOptions(true, "https://dashscope.aliyuncs.com/v1", "max", "qwen3.7-max");
  assert.deepEqual(result, {
    chat_template_kwargs: { enable_thinking: true },
  });
});

test("Qwen3 reasoning_effort 参数不影响 chat_template_kwargs 格式", () => {
  // Qwen3 格式不使用 reasoning_effort（仅 DeepSeek 格式使用）
  // 无论 reasoningEffort 传 "high" 还是 "max"，Qwen3 格式只返回 chat_template_kwargs
  const resultHigh = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "high", "Qwen/Qwen3.6-27B");
  const resultMax = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "max", "Qwen/Qwen3.6-27B");
  assert.deepEqual(resultHigh, resultMax);
  assert.ok(!("extra_body" in resultHigh), "Qwen3 格式不应包含 extra_body.reasoning_effort");
});

test("Qwen3 模型名大小写不敏感（QWEN3-32B / qwen3-32b / Qwen3-32B 等价）", () => {
  const variants = ["QWEN3-32B", "qwen3-32b", "Qwen3-32B", " Qwen3-32B "];
  for (const model of variants) {
    const result = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "max", model);
    assert.deepEqual(
      result,
      {
        chat_template_kwargs: { enable_thinking: true },
      },
      `模型名 "${model}" 应被识别为 Qwen3 系列`
    );
  }
});

test("DeepSeek 格式不受 Qwen3 改动影响（回归保护）", () => {
  // DeepSeek-V4-Pro 启用 thinking
  const deepseekEnabled = buildThinkingRequestOptions(true, "https://api.deepseek.com", "max", "deepseek-v4-pro");
  assert.deepEqual(deepseekEnabled, {
    thinking: { type: "enabled" },
    extra_body: { reasoning_effort: "max" },
  });
  // 不应包含 chat_template_kwargs
  assert.ok(!("chat_template_kwargs" in deepseekEnabled), "DeepSeek 格式不应包含 chat_template_kwargs");

  // DeepSeek-V4-Pro 关闭 thinking
  const deepseekDisabled = buildThinkingRequestOptions(false, "https://api.deepseek.com", "max", "deepseek-v4-pro");
  assert.deepEqual(deepseekDisabled, {
    thinking: { type: "disabled" },
  });
  assert.ok(!("chat_template_kwargs" in deepseekDisabled), "DeepSeek 格式不应包含 chat_template_kwargs");
});

test("非-thinking 模型返回空对象（gpt-4 / claude-3 / 未知模型）", () => {
  const nonThinkingModels = ["gpt-4", "gpt-4o", "claude-3-opus", "unknown-model", ""];
  for (const model of nonThinkingModels) {
    const resultEnabled = buildThinkingRequestOptions(true, "https://api.openai.com", "max", model);
    assert.deepEqual(resultEnabled, {}, `模型 "${model}" 启用 thinking 应返回空对象`);

    const resultDisabled = buildThinkingRequestOptions(false, "https://api.openai.com", "max", model);
    assert.deepEqual(resultDisabled, {}, `模型 "${model}" 关闭 thinking 应返回空对象`);
  }
});

test("isQwen3Model 辅助函数正确识别 Qwen3 系列模型", () => {
  // Qwen3 系列
  assert.ok(isQwen3Model("Qwen/Qwen3.6-27B"), "Qwen/Qwen3.6-27B 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen3-32b"), "qwen3-32b 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen3-30b-a3b"), "qwen3-30b-a3b 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen3.6-plus"), "qwen3.6-plus 应识别为 Qwen3");
  assert.ok(isQwen3Model("qwen3.7-max"), "qwen3.7-max 应识别为 Qwen3");
  assert.ok(isQwen3Model("QWEN3-235B-A22B"), "QWEN3-235B-A22B 应识别为 Qwen3（大小写不敏感）");

  // 非 Qwen3 系列
  assert.ok(!isQwen3Model("deepseek-v4-pro"), "deepseek-v4-pro 不应识别为 Qwen3");
  assert.ok(!isQwen3Model("gpt-4"), "gpt-4 不应识别为 Qwen3");
  assert.ok(!isQwen3Model("qwen-72b"), "qwen-72b（Qwen2 系列）不应识别为 Qwen3");
  assert.ok(!isQwen3Model(""), "空字符串不应识别为 Qwen3");
});

test("isDeepSeekThinkingModel 辅助函数正确识别 DeepSeek V4 系列", () => {
  // DeepSeek V4 系列
  assert.ok(isDeepSeekThinkingModel("deepseek-v4-pro"), "deepseek-v4-pro 应识别为 DeepSeek thinking 模型");
  assert.ok(isDeepSeekThinkingModel("deepseek-v4-flash"), "deepseek-v4-flash 应识别为 DeepSeek thinking 模型");
  assert.ok(isDeepSeekThinkingModel("DeepSeek-V4-Pro"), "DeepSeek-V4-Pro 应识别（大小写不敏感）");

  // 非 DeepSeek V4 系列
  assert.ok(!isDeepSeekThinkingModel("deepseek-chat"), "deepseek-chat 不应识别为 thinking 模型");
  assert.ok(!isDeepSeekThinkingModel("deepseek-reasoner"), "deepseek-reasoner 不应识别为 thinking 模型");
  assert.ok(!isDeepSeekThinkingModel("Qwen/Qwen3.6-27B"), "Qwen3 不应识别为 DeepSeek thinking 模型");
  assert.ok(!isDeepSeekThinkingModel(""), "空字符串不应识别为 DeepSeek thinking 模型");
});
