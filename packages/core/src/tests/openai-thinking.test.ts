import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingRequestOptions } from "../common/openai-thinking";

// ============================================================================
// DeepSeek 格式回归测试（v1.1 修订后需要显式传入 model 参数）
//
// v1.1 变更：
//   - buildThinkingRequestOptions 新增第 4 个参数 model（默认 ""）
//   - 非-thinking 模型（model="" 或未识别）返回 {}，不再返回 DeepSeek 格式
//   - DeepSeek 格式仅对 model="deepseek-v4-pro" / "deepseek-v4-flash" 生效
//   - Qwen3 格式仅对 model 以 "qwen3" / "qwen/qwen3" 开头生效
//
// 本文件保留 DeepSeek 格式的回归测试，Qwen3 格式测试见 qwen3-thinking.test.ts
// ============================================================================

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

// ============================================================================
// v1.1 新增：非 thinking 模型与默认 model 行为测试
//
// 验证：
//   1. 未传 model（默认 ""）时返回 {}（向后兼容：不向未知模型发送 thinking 参数）
//   2. 非-thinking 模型（如 "gpt-4"）返回 {}（不向不支持的模型发送 thinking 参数）
//   3. DeepSeek-V4-Flash 同样支持 thinking（与 Pro 行为一致）
// ============================================================================

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
