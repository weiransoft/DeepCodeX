import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenAIClientHandle } from "../common/openai-client";

// ============================================================================
// OpenAIClientHandle 类型守卫五档 reasoningEffort 单元测试（v1.2 Qwen3.8 适配）
//
// 对应设计文档 docs/qwen38-adaptation.md §5.4（验收标准第 6 条）：
//   T1  正向：新档位 xhigh / medium 被守卫接受
//   T2  正向回归：旧三档 low / high / max 放宽后不可误拒
//   T3  负向：非法值 ultra / 大小写变体 xHIGH 仍被拒绝
//   T4  守卫基础行为回归：缺 client 键返回 false
//
// 注意：isOpenAIClientHandle 校验四个必填字段（client / model / baseURL /
// thinkingEnabled），reasoningEffort 仅在存在时校验——因此必须传完整 handle
// 才能测到档位放宽逻辑（只传 reasoningEffort 会因缺 client 提前失败）。
// ============================================================================

/** 构造完整合法 handle 夹具：覆盖四个必填字段，reasoningEffort 由用例覆写 */
function makeHandle(reasoningEffort?: unknown): Record<string, unknown> {
  const handle: Record<string, unknown> = {
    client: {},
    model: "qwen3.8-plus",
    baseURL: "https://api.example.com/v1",
    thinkingEnabled: true,
  };
  if (reasoningEffort !== undefined) {
    handle.reasoningEffort = reasoningEffort;
  }
  return handle;
}

test("isOpenAIClientHandle 接受新档位 xhigh 与 medium（T1）", () => {
  assert.ok(isOpenAIClientHandle(makeHandle("xhigh")), "新档位 xhigh 应通过守卫");
  assert.ok(isOpenAIClientHandle(makeHandle("medium")), "新档位 medium 应通过守卫");
});

test("isOpenAIClientHandle 对旧三档 low/high/max 保持接受（T2 回归）", () => {
  for (const effort of ["low", "high", "max"]) {
    assert.ok(isOpenAIClientHandle(makeHandle(effort)), `旧档位 ${effort} 放宽后不应被误拒`);
  }
});

test("isOpenAIClientHandle 拒绝非法档位与大小写变体（T3）", () => {
  assert.ok(!isOpenAIClientHandle(makeHandle("ultra")), "非法档位 ultra 应被拒绝");
  assert.ok(!isOpenAIClientHandle(makeHandle("xHIGH")), "大写变体 xHIGH 应被拒绝（严格字面量、大小写敏感）");
});

test("isOpenAIClientHandle 缺 client 键返回 false（T4 回归）", () => {
  const handle = makeHandle("xhigh");
  delete handle.client;
  assert.ok(!isOpenAIClientHandle(handle), "缺 client 键应返回 false（守卫基础行为）");
});
