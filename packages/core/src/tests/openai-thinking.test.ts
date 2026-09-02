import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingRequestOptions } from "../common/openai-thinking";

// fork 保留：v1.1 四参数签名（第 4 参 model）——合并后 2 参调用（model=""）会返回 {}，故 DeepSeek 用例需显式传 model

test("buildThinkingRequestOptions explicitly disables thinking for DeepSeek", () => {
  assert.deepEqual(buildThinkingRequestOptions(false, "https://api.deepseek.com", "max", "deepseek-v4-pro"), {
    thinking: { type: "disabled" },
  });
});

test("buildThinkingRequestOptions uses the same disabled payload for volces endpoints", () => {
  assert.deepEqual(
    buildThinkingRequestOptions(false, "https://ark.cn-beijing.volces.com/api/v3", "max", "deepseek-v4-pro"),
    {
      thinking: { type: "disabled" },
    }
  );
});

test("buildThinkingRequestOptions enables thinking with default reasoning effort for DeepSeek", () => {
  assert.deepEqual(buildThinkingRequestOptions(true, "https://api.deepseek.com", "max", "deepseek-v4-pro"), {
    thinking: { type: "enabled" },
    extra_body: { reasoning_effort: "max" },
  });
});

test("buildThinkingRequestOptions uses the same enabled payload for volces endpoints", () => {
  assert.deepEqual(
    buildThinkingRequestOptions(true, "https://ark.cn-beijing.volces.com/api/v3", "max", "deepseek-v4-pro"),
    {
      thinking: { type: "enabled" },
      extra_body: { reasoning_effort: "max" },
    }
  );
});

test("buildThinkingRequestOptions accepts high reasoning effort for DeepSeek", () => {
  assert.deepEqual(buildThinkingRequestOptions(true, "https://api.deepseek.com", "high", "deepseek-v4-pro"), {
    thinking: { type: "enabled" },
    extra_body: { reasoning_effort: "high" },
  });
});

// fork 保留：v1.1 新增 —— 非 thinking 模型与默认 model 行为测试
//
// 验证：
//   1. 未传 model（默认 ""）时返回 {}（向后兼容：不向未知模型发送 thinking 参数）
//   2. 非-thinking 模型（如 "gpt-4"）返回 {}（不向不支持的模型发送 thinking 参数）
//   3. DeepSeek-V4-Flash 同样支持 thinking（与 Pro 行为一致）
test("buildThinkingRequestOptions returns empty object when model is empty (backward compat)", () => {
  assert.deepEqual(buildThinkingRequestOptions(true, "https://api.deepseek.com", "max"), {});
});

test("buildThinkingRequestOptions returns empty object for non-thinking model (gpt-4)", () => {
  assert.deepEqual(buildThinkingRequestOptions(true, "https://api.openai.com", "max", "gpt-4"), {});
});

test("buildThinkingRequestOptions returns empty object for non-thinking model when disabled", () => {
  assert.deepEqual(buildThinkingRequestOptions(false, "https://api.openai.com", "max", "gpt-4"), {});
});

test("buildThinkingRequestOptions enables thinking for deepseek-v4-flash (same format as pro)", () => {
  assert.deepEqual(buildThinkingRequestOptions(true, "https://api.deepseek.com", "max", "deepseek-v4-flash"), {
    thinking: { type: "enabled" },
    extra_body: { reasoning_effort: "max" },
  });
});

// 上游 v0.3.1 新增用例（适配合并后 4 参签名）：reasoning effort 支持 "low" 档位（仅 DeepSeek 生效）
test("buildThinkingRequestOptions accepts low reasoning effort for DeepSeek", () => {
  assert.deepEqual(buildThinkingRequestOptions(true, "https://api.deepseek.com", "low", "deepseek-v4-pro"), {
    thinking: { type: "enabled" },
    extra_body: { reasoning_effort: "low" },
  });
});
