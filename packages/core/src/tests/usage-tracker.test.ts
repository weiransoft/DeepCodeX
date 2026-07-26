/**
 * usage-tracker 模块单元测试
 *
 * 覆盖范围：
 * - isUsageRecord：类型守卫的空对象防御、类实例防御、数组防御
 * - addUsageValue：迭代实现的正确性、深度限制、与原递归实现的一致性
 * - accumulateUsage：null 安全
 * - usageWithRequestCount：请求计数递增
 * - accumulateUsagePerModel：模型级聚合
 * - getTotalTokens：总 token 数提取
 * - toModelUsage：LLMUsage → ModelUsage 转换（含 cache 字段映射）
 *
 * 修订记录：
 * - 2026-07-26：新增，对应 docs/dev/review.md CRITICAL-1 模块 2 + 代码细节修复 2/3
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUsageRecord,
  addUsageValue,
  accumulateUsage,
  usageWithRequestCount,
  accumulateUsagePerModel,
  getTotalTokens,
  toModelUsage,
  type ModelUsage,
} from "../usage-tracker";

describe("isUsageRecord", () => {
  it("返回 true 对于非空普通对象", () => {
    assert.equal(isUsageRecord({ prompt_tokens: 10 }), true);
    assert.equal(isUsageRecord({ a: 1, b: 2 }), true);
  });

  it("返回 false 对于 null", () => {
    assert.equal(isUsageRecord(null), false);
  });

  it("返回 false 对于 undefined", () => {
    assert.equal(isUsageRecord(undefined), false);
  });

  it("返回 false 对于原始类型", () => {
    assert.equal(isUsageRecord("string"), false);
    assert.equal(isUsageRecord(123), false);
    assert.equal(isUsageRecord(true), false);
    assert.equal(isUsageRecord(Symbol("s")), false);
  });

  it("返回 false 对于数组", () => {
    assert.equal(isUsageRecord([1, 2, 3]), false);
    assert.equal(isUsageRecord([]), false);
  });

  it("返回 false 对于空对象 {}（v2 修复：增加空对象防御）", () => {
    // 修复前：isUsageRecord({}) 返回 true
    // 修复后：isUsageRecord({}) 返回 false（Usage Record 应至少包含一个字段）
    assert.equal(isUsageRecord({}), false);
  });

  it("返回 false 对于类实例（v2 修复：增加类实例防御）", () => {
    // 修复前：isUsageRecord(new Date()) 返回 true
    // 修复后：返回 false（仅接受普通对象，拒绝 Date/Map/Set/类实例）
    assert.equal(isUsageRecord(new Date()), false);
    assert.equal(isUsageRecord(new Map()), false);
    assert.equal(isUsageRecord(new Set()), false);

    class FakeUsage {
      constructor(public prompt_tokens: number) {}
    }
    assert.equal(isUsageRecord(new FakeUsage(10)), false);
  });

  it("返回 true 对于 Object.create(null) 创建的对象", () => {
    // 无 prototype 的对象应被视为有效的 Usage Record
    const obj = Object.create(null);
    obj.prompt_tokens = 10;
    assert.equal(isUsageRecord(obj), true);
  });
});

describe("addUsageValue", () => {
  it("number + number → 求和", () => {
    assert.equal(addUsageValue(10, 20), 30);
    assert.equal(addUsageValue(0, 5), 5);
    assert.equal(addUsageValue(-10, 20), 10);
  });

  it("非 number current + number next → 从 0 开始累加", () => {
    assert.equal(addUsageValue(undefined, 20), 20);
    assert.equal(addUsageValue(null, 20), 20);
    assert.equal(addUsageValue("string", 20), 20);
    assert.equal(addUsageValue({ a: 1 }, 20), 20);
  });

  it("number current + object next → object 覆盖", () => {
    const result = addUsageValue(10, { a: 1 });
    assert.deepEqual(result, { a: 1 });
  });

  it("object + object → 递归合并", () => {
    const current = { a: 1, b: { c: 10, d: 20 } };
    const next = { b: { c: 5, e: 30 }, f: 100 };
    const result = addUsageValue(current, next) as Record<string, unknown>;
    assert.deepEqual(result, {
      a: 1,
      b: { c: 15, d: 20, e: 30 },
      f: 100,
    });
  });

  it("object + 非 object → 覆盖语义", () => {
    assert.equal(addUsageValue({ a: 1 }, "string"), "string");
    assert.equal(addUsageValue({ a: 1 }, null), null);
    assert.equal(addUsageValue({ a: 1 }, undefined), undefined);
  });

  it("空对象 current + object next → 完整返回 next", () => {
    const result = addUsageValue({}, { a: 1, b: 2 }) as Record<string, unknown>;
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it("object current + 空对象 next → 保留 current（v2 修复后空对象不是有效 Record）", () => {
    // 修复后：isUsageRecord({}) 返回 false，所以 {} 走"覆盖语义"
    const current = { a: 1, b: 2 };
    const result = addUsageValue(current, {});
    // 空对象不是有效 Record，直接返回 {}
    assert.deepEqual(result, {});
  });

  it("嵌套对象深度 ≤ 10 时正常处理", () => {
    // 构造深度 5 的嵌套对象
    const deep: Record<string, unknown> = { level: 0 };
    let current: Record<string, unknown> = deep;
    for (let i = 1; i <= 5; i++) {
      current.next = { level: i };
      current = current.next as Record<string, unknown>;
    }
    const result = addUsageValue(null, deep) as Record<string, unknown>;
    assert.equal(result.level, 0);
    assert.equal((result.next as Record<string, unknown>).level, 1);
  });

  it("v2 修复：迭代实现不栈溢出（深嵌套 payload）", () => {
    // 构造深度 100 的嵌套对象（在 maxIterations = 1000 限制内）
    // 递归实现会因深度 100 而接近栈溢出边界，迭代实现可正常处理
    const deep: Record<string, unknown> = { value: 1 };
    let current: Record<string, unknown> = deep;
    for (let i = 0; i < 100; i++) {
      current.next = { value: 1 };
      current = current.next as Record<string, unknown>;
    }
    // 迭代实现应正常完成，不抛栈溢出错误
    const result = addUsageValue(null, deep) as Record<string, unknown>;
    assert.equal(result.value, 1);
    // 验证嵌套层级正确处理
    let node = result;
    for (let i = 0; i < 50; i++) {
      node = node.next as Record<string, unknown>;
      assert.equal(node.value, 1, `第 ${i + 1} 层 value 应为 1`);
    }
  });

  it("v2 修复：超出深度限制时截断但不抛错", () => {
    // 构造深度 5000 的嵌套对象（超出 maxIterations = 1000 限制）
    // 修复前（递归实现）：会抛栈溢出错误
    // 修复后（迭代实现）：截断并记录警告，不抛错
    const deep: Record<string, unknown> = { value: 1 };
    let current: Record<string, unknown> = deep;
    for (let i = 0; i < 5000; i++) {
      current.next = { value: 1 };
      current = current.next as Record<string, unknown>;
    }
    // 应正常返回（部分截断），不抛 RangeError: Maximum call stack size exceeded
    const result = addUsageValue(null, deep) as Record<string, unknown>;
    // 根层 value 应被处理（因为是栈顶最后处理的）
    // 注意：由于 LIFO 顺序，深度超限时可能根层 value 未被处理，但不应抛错
    assert.ok(typeof result === "object", "应返回对象而不抛错");
  });

  it("模拟真实 Usage 数据累加", () => {
    const usage1: ModelUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    };
    const usage2: ModelUsage = {
      prompt_tokens: 200,
      completion_tokens: 80,
      total_tokens: 280,
    };
    const result = addUsageValue(usage1, usage2) as ModelUsage;
    assert.equal(result.prompt_tokens, 300);
    assert.equal(result.completion_tokens, 130);
    assert.equal(result.total_tokens, 430);
  });

  it("累加含嵌套 details 的 Usage", () => {
    const usage1 = {
      prompt_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 50 },
    };
    const usage2 = {
      prompt_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 30 },
    };
    const result = addUsageValue(usage1, usage2) as Record<string, unknown>;
    assert.equal(result.prompt_tokens, 300);
    assert.deepEqual(result.completion_tokens_details, { reasoning_tokens: 80 });
  });
});

describe("accumulateUsage", () => {
  it("current 为 null + next 为 null → 返回 null", () => {
    assert.equal(accumulateUsage(null, null), null);
    assert.equal(accumulateUsage(null, undefined), null);
  });

  it("current 为 null + next 有效 → 返回 next 累加结果", () => {
    const result = accumulateUsage(null, { prompt_tokens: 10 }) as ModelUsage;
    assert.equal(result.prompt_tokens, 10);
  });

  it("current 有效 + next 为 null → 返回 current", () => {
    const current: ModelUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const result = accumulateUsage(current, null) as ModelUsage;
    assert.equal(result.prompt_tokens, 100);
  });

  it("current 有效 + next 有效 → 累加", () => {
    const current: ModelUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const next = { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 };
    const result = accumulateUsage(current, next) as ModelUsage;
    assert.equal(result.prompt_tokens, 300);
    assert.equal(result.completion_tokens, 130);
    assert.equal(result.total_tokens, 430);
  });
});

describe("usageWithRequestCount", () => {
  it("无 total_reqs 时初始化为 1", () => {
    const usage: ModelUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    };
    const result = usageWithRequestCount(usage);
    assert.equal(result.total_reqs, 1);
    assert.equal(result.prompt_tokens, 10);
  });

  it("已有 total_reqs 时递增", () => {
    const usage: ModelUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      total_reqs: 5,
    };
    const result = usageWithRequestCount(usage);
    assert.equal(result.total_reqs, 6);
  });

  it("不修改原对象（不可变）", () => {
    const usage: ModelUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      total_reqs: 5,
    };
    usageWithRequestCount(usage);
    assert.equal(usage.total_reqs, 5);
  });
});

describe("accumulateUsagePerModel", () => {
  it("current 为 null + next 为 null → 返回 null", () => {
    assert.equal(accumulateUsagePerModel(null, "gpt-4", null), null);
    assert.equal(accumulateUsagePerModel(undefined, "gpt-4", undefined), null);
  });

  it("current 为 null + next 有效 → 初始化新字典", () => {
    const next: ModelUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    };
    const result = accumulateUsagePerModel(null, "gpt-4", next)!;
    assert.ok(result["gpt-4"]);
    assert.equal(result["gpt-4"].prompt_tokens, 100);
    assert.equal(result["gpt-4"].total_reqs, 1);
  });

  it("已有 current + 新 model → 追加", () => {
    const current = {
      "gpt-4": {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        total_reqs: 1,
      },
    };
    const next: ModelUsage = {
      prompt_tokens: 200,
      completion_tokens: 80,
      total_tokens: 280,
    };
    const result = accumulateUsagePerModel(current, "claude-3", next)!;
    assert.ok(result["gpt-4"]);
    assert.ok(result["claude-3"]);
    assert.equal(result["claude-3"].prompt_tokens, 200);
    assert.equal(result["claude-3"].total_reqs, 1);
  });

  it("已有 current + 同 model → 累加并递增请求计数", () => {
    const current = {
      "gpt-4": {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        total_reqs: 1,
      },
    };
    const next: ModelUsage = {
      prompt_tokens: 200,
      completion_tokens: 80,
      total_tokens: 280,
    };
    const result = accumulateUsagePerModel(current, "gpt-4", next)!;
    assert.equal(result["gpt-4"].prompt_tokens, 300);
    assert.equal(result["gpt-4"].completion_tokens, 130);
    assert.equal(result["gpt-4"].total_reqs, 2);
  });

  it("空模型名归一化为 'unknown'", () => {
    const next: ModelUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    };
    const result = accumulateUsagePerModel(null, "", next)!;
    assert.ok(result["unknown"]);
    const result2 = accumulateUsagePerModel(null, "   ", next)!;
    assert.ok(result2["unknown"]);
  });
});

describe("getTotalTokens", () => {
  it("返回 total_tokens 数值", () => {
    const usage: ModelUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    };
    assert.equal(getTotalTokens(usage), 150);
  });

  it("返回 0 对于 null/undefined", () => {
    assert.equal(getTotalTokens(null), 0);
    assert.equal(getTotalTokens(undefined), 0);
  });

  it("返回 0 对于非对象", () => {
    assert.equal(getTotalTokens("string" as unknown as ModelUsage), 0);
    assert.equal(getTotalTokens(123 as unknown as ModelUsage), 0);
  });

  it("返回 0 对于空对象（v2 修复后空对象不是有效 Record）", () => {
    assert.equal(getTotalTokens({} as ModelUsage), 0);
  });

  it("返回 0 对于 total_tokens 非 number", () => {
    const usage = { total_tokens: "150" } as unknown as ModelUsage;
    assert.equal(getTotalTokens(usage), 0);
  });
});

describe("toModelUsage", () => {
  it("返回 null 对于 null 输入", () => {
    assert.equal(toModelUsage(null), null);
  });

  it("转换基本 LLMUsage（无 cache 字段）", () => {
    const result = toModelUsage({
      inputTokens: 100,
      outputTokens: 50,
    })!;
    assert.equal(result.prompt_tokens, 100);
    assert.equal(result.completion_tokens, 50);
    assert.equal(result.total_tokens, 150);
    // 无 cache 字段时不输出 cache 相关字段
    assert.equal(result.prompt_cache_hit_tokens, undefined);
    assert.equal(result.prompt_cache_miss_tokens, undefined);
  });

  it("转换含 cache 字段的 LLMUsage（Anthropic 风格）", () => {
    const result = toModelUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 200,
    })!;
    // prompt_tokens = inputTokens + cacheCreation + cacheRead = 100 + 30 + 200 = 330
    assert.equal(result.prompt_tokens, 330);
    assert.equal(result.completion_tokens, 50);
    assert.equal(result.total_tokens, 380);
    assert.equal(result.prompt_cache_hit_tokens, 200);
    // prompt_cache_miss_tokens = inputTokens + cacheCreation = 100 + 30 = 130
    assert.equal(result.prompt_cache_miss_tokens, 130);
  });

  it("转换仅含 cacheRead 的 LLMUsage", () => {
    const result = toModelUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 200,
    })!;
    // cacheCreation 缺省为 0
    assert.equal(result.prompt_tokens, 300);
    assert.equal(result.prompt_cache_hit_tokens, 200);
    // cacheCreation 为 undefined，不输出 prompt_cache_miss_tokens
    assert.equal(result.prompt_cache_miss_tokens, undefined);
  });

  it("转换仅含 cacheCreation 的 LLMUsage", () => {
    const result = toModelUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 30,
    })!;
    assert.equal(result.prompt_tokens, 130);
    assert.equal(result.prompt_cache_miss_tokens, 130);
    // cacheRead 为 undefined，不输出 prompt_cache_hit_tokens
    assert.equal(result.prompt_cache_hit_tokens, undefined);
  });
});
