import { test } from "node:test";
import assert from "node:assert/strict";
import { getThinkingOptionIndex, MODEL_COMMAND_MODELS, MODEL_COMMAND_THINKING_OPTIONS } from "../ui";

test("model dropdown offers supported DeepSeek models", () => {
  assert.deepEqual(MODEL_COMMAND_MODELS, ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
});

// v1.2 变更（Qwen3.8 适配，R2）：选项扩为六档（新增 xhigh / medium），
// 顺序按思考强度降序：[xhigh, max, high, medium, low, No thinking]
// （对应设计文档 docs/qwen38-adaptation.md §5.5 T1）
test("model dropdown offers all reasoning effort levels", () => {
  assert.deepEqual(
    MODEL_COMMAND_THINKING_OPTIONS.map((option) => option.reasoningEffort),
    ["xhigh", "max", "high", "medium", "low", undefined]
  );
  assert.equal(getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "low" }), 4);
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.5 T2）：
// 新档位 xhigh（索引 0，Qwen3.8 服务端默认档）与 medium（索引 3）可精确定位
test("model dropdown resolves new xhigh and medium levels", () => {
  assert.equal(getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "xhigh" }), 0);
  assert.equal(getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "medium" }), 3);
});

// v1.2 新增（Qwen3.8 适配，对应设计文档 §5.5 T3/T4）：
// 未知档位未命中回落索引 0；No thinking 项定位索引 5（回归）
test("model dropdown falls back to first option and locates no-thinking", () => {
  assert.equal(getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "unknown" as never }), 0);
  assert.equal(getThinkingOptionIndex({ thinkingEnabled: false, reasoningEffort: "max" }), 5);
});
