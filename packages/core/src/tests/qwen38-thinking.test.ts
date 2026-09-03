import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingRequestOptions } from "../common/openai-thinking";

// ============================================================================
// Qwen3.8 thinking 请求参数单元测试（v1.2 Qwen3.8 适配）
//
// 对应设计文档 docs/qwen38-adaptation.md §5.2（验收标准第 2、3、4、5 条）：
//   T1  Qwen3.8 thinking=true effort=max → enable_thinking + preserve_thinking
//       + reasoning_effort: "xhigh"（max 钳制到官方最高档）
//   T2  effort=high → reasoning_effort: "medium"（向下钳制，保守控制 token 开销）
//   T3  effort=xhigh / medium / low → 直传
//   T4  Qwen3.8 thinking=false → 仅 enable_thinking: false，
//       负向断言不含 reasoning_effort / preserve_thinking 残留字段
//   T5  旧 Qwen3（<3.8）thinking=true → 仅 enable_thinking（零回归）
//   T6  旧 Qwen3 thinking=false → 仅 enable_thinking（零回归）
//   T7  分叉边界 qwen30-8b → 走旧分支（零回归）
//   T8  非 thinking 模型（gpt-4o）→ 空对象
//   T9  DeepSeek 回归 thinking=true → thinking.type + extra_body.reasoning_effort
//   T10 DeepSeek 回归 thinking=false → thinking.type: "disabled"，无 extra_body
//
// 请求体断言一律使用 deepStrictEqual（多字段/少字段均失败），禁止宽松比较。
// ============================================================================

test("Qwen3.8 thinking=true effort=max 映射为 xhigh 并下发 preserve_thinking（T1）", () => {
  const result = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "max", "Qwen/Qwen3.8-27B-FP8");
  assert.deepStrictEqual(
    result,
    {
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      reasoning_effort: "xhigh",
    },
    "Qwen3.8 thinking=true effort=max 应下发 preserve_thinking 且 max 钳制为 xhigh"
  );
});

test("Qwen3.8 thinking=true effort=high 降档映射为 medium（T2）", () => {
  const result = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "high", "qwen3.8-plus");
  assert.deepStrictEqual(
    result,
    {
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      reasoning_effort: "medium",
    },
    "Qwen3.8 无 high 档，high 应向下钳制为 medium"
  );
});

test("Qwen3.8 thinking=true 直传档位 xhigh / medium / low（T3）", () => {
  // xhigh：Qwen3.8 服务端默认档，直传
  assert.deepStrictEqual(buildThinkingRequestOptions(true, "http://localhost:8000/v1", "xhigh", "qwen3.8-27b"), {
    chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    reasoning_effort: "xhigh",
  });
  // medium：直传
  assert.deepStrictEqual(buildThinkingRequestOptions(true, "http://localhost:8000/v1", "medium", "qwen3.8-27b"), {
    chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    reasoning_effort: "medium",
  });
  // low：直传
  assert.deepStrictEqual(buildThinkingRequestOptions(true, "http://localhost:8000/v1", "low", "qwen3.8-27b"), {
    chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    reasoning_effort: "low",
  });
});

test("Qwen3.8 thinking=false 仅下发 enable_thinking=false，无残留字段（T4）", () => {
  const result = buildThinkingRequestOptions(false, "http://localhost:8000/v1", "xhigh", "qwen3.8-plus");
  assert.deepStrictEqual(
    result,
    { chat_template_kwargs: { enable_thinking: false } },
    "Qwen3.8 thinking=false 应仅含 enable_thinking=false"
  );
  // 负向断言：不得残留 reasoning_effort / preserve_thinking 字段
  assert.ok(!("reasoning_effort" in result), "thinking=false 不应包含顶层 reasoning_effort");
  assert.ok(!("preserve_thinking" in result.chat_template_kwargs), "thinking=false 不应包含 preserve_thinking");
});

test("旧 Qwen3（<3.8）thinking=true 仅 enable_thinking，零回归（T5）", () => {
  const result = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "max", "qwen3-8b");
  assert.deepStrictEqual(
    result,
    { chat_template_kwargs: { enable_thinking: true } },
    "旧 Qwen3 thinking=true 请求形态应与 v1.1 逐字节一致"
  );
});

test("旧 Qwen3（<3.8）thinking=false 仅 enable_thinking，零回归（T6）", () => {
  const result = buildThinkingRequestOptions(false, "http://localhost:8000/v1", "max", "Qwen3-30B-A3B");
  assert.deepStrictEqual(
    result,
    { chat_template_kwargs: { enable_thinking: false } },
    "旧 Qwen3 thinking=false 请求形态应与 v1.1 逐字节一致"
  );
});

test("分叉边界 qwen30-8b 走旧 Qwen3 分支，零回归（T7）", () => {
  // isQwen3Model 前缀匹配命中、isQwen38Model 正则不命中的分叉模型，
  // 必须落入旧分支（不携带 preserve_thinking / reasoning_effort）
  const result = buildThinkingRequestOptions(true, "http://localhost:8000/v1", "max", "qwen30-8b");
  assert.deepStrictEqual(result, { chat_template_kwargs: { enable_thinking: true } }, "qwen30-8b 应走旧 Qwen3 分支");
});

test("非 thinking 模型（gpt-4o）thinking=true 返回空对象（T8）", () => {
  assert.deepStrictEqual(
    buildThinkingRequestOptions(true, "https://api.openai.com", "xhigh", "gpt-4o"),
    {},
    "非 Qwen / 非 DeepSeek 模型不应下发任何 thinking 参数（OpenAI 官方端点不受影响）"
  );
});

test("DeepSeek thinking=true 格式回归，与 Qwen3.8 格式严格区分（T9）", () => {
  const result = buildThinkingRequestOptions(true, "https://api.deepseek.com", "xhigh", "deepseek-v4-pro");
  assert.deepStrictEqual(
    result,
    {
      thinking: { type: "enabled" },
      extra_body: { reasoning_effort: "xhigh" },
    },
    "DeepSeek 应维持 thinking.type + extra_body.reasoning_effort 格式"
  );
  // 负向断言：不得混入 Qwen3.8 格式字段
  assert.ok(!("chat_template_kwargs" in result), "DeepSeek 格式不应包含 chat_template_kwargs");
  assert.ok(!("reasoning_effort" in result), "DeepSeek 格式的 reasoning_effort 应在 extra_body 内而非顶层");
});

test("DeepSeek thinking=false 格式回归，无 extra_body（T10）", () => {
  const result = buildThinkingRequestOptions(false, "https://api.deepseek.com", "max", "deepseek-v4-pro");
  assert.deepStrictEqual(
    result,
    { thinking: { type: "disabled" } },
    "DeepSeek thinking=false 应仅含 thinking.type=disabled"
  );
});
