/**
 * stream-aggregator.ts 单元测试（S5.3，2026-08-19 新增）
 *
 * 测试对象：core/src/stream-aggregator.ts（从 session.ts 抽取的流式纯函数工具）
 * 覆盖导出面：
 * - estimateStreamTokens：token 估算（空串 / 纯 CJK 0.6 每字 / 纯 ASCII 0.3 每字 / 混合文本）
 * - formatEstimatedTokens：格式化分档边界（0 / 负数 / 99 / 100 / 9999 / 10000）
 * - isAbortLikeError：Abort 错误识别（AbortError / APIUserAbortError / 普通 Error / 非 Error）
 * - throwIfAborted：AbortSignal 前置守卫（已取消抛出 / 未取消不抛 / undefined / null）
 * - CJK_REGEX：CJK 字符正则匹配行为（基本区 / 扩展 A 区 / 兼容区 / 非范围字符）
 *
 * 设计说明：
 * - 真实行为测试（非 mock）：全部断言基于真实函数调用结果
 * - APIUserAbortError 用真实子类实例验证 constructor.name 判定路径
 * - 该模块是流式路径依赖的纯工具（流式本体在 session.ts），
 *   无 chunk 聚合 / usage 累计逻辑，用例按真实导出面设计
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CJK_REGEX,
  estimateStreamTokens,
  formatEstimatedTokens,
  isAbortLikeError,
  throwIfAborted,
} from "../stream-aggregator";

// ============================================================================
// estimateStreamTokens：token 估算
// ============================================================================

/**
 * 浮点容差断言辅助（0.6/0.3 的二进制表示存在精度误差，
 * 如 2×0.6 + 2×0.3 = 1.7999999999999998，须用容差比较而非严格相等）
 * @param actual 实际值
 * @param expected 期望值
 * @param message 断言失败信息
 */
function assertApproxEqual(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}（期望 ${expected}，实际 ${actual}）`);
}

test("SA-001: estimateStreamTokens 空串返回 0", () => {
  assert.equal(estimateStreamTokens(""), 0, "空串应返回 0");
});

test("SA-002: estimateStreamTokens 纯 CJK 文本按每字 0.6 估算", () => {
  // 3 个 CJK 字符：3 × 0.6 = 1.8
  const result = estimateStreamTokens("你好吗");
  assertApproxEqual(result, 1.8, "3 个 CJK 字符应估算 1.8");
});

test("SA-003: estimateStreamTokens 纯 ASCII 文本按每字 0.3 估算", () => {
  // 4 个 ASCII 字符：4 × 0.3 = 1.2
  const result = estimateStreamTokens("abcd");
  assertApproxEqual(result, 1.2, "4 个 ASCII 字符应估算 1.2");
});

test("SA-004: estimateStreamTokens 混合文本按 CJK/非 CJK 分别计权", () => {
  // 2 个 CJK + 2 个 ASCII：2 × 0.6 + 2 × 0.3 = 1.8
  const result = estimateStreamTokens("你好ab");
  assertApproxEqual(result, 1.8, "2 CJK + 2 ASCII 应估算 1.8");
});

test("SA-005: estimateStreamTokens 空白字符串非空仍按字符计权", () => {
  // 空格 2 个：2 × 0.3 = 0.6（空白字符非 CJK，走 other 分支）
  const result = estimateStreamTokens("  ");
  assertApproxEqual(result, 0.6, "2 个空格应估算 0.6");
});

// ============================================================================
// formatEstimatedTokens：格式化分档边界
// ============================================================================

test('SA-010: formatEstimatedTokens 0 与负数返回 "0"', () => {
  assert.equal(formatEstimatedTokens(0), "0", '0 应返回 "0"');
  assert.equal(formatEstimatedTokens(-5), "0", '-5 应返回 "0"');
});

test("SA-011: formatEstimatedTokens 小于 100 返回原始数字（99 边界）", () => {
  assert.equal(formatEstimatedTokens(99), "99", '99 应返回 "99"');
  assert.equal(formatEstimatedTokens(42.4), "42", '42.4 四舍五入后应返回 "42"');
});

test("SA-012: formatEstimatedTokens 100 起进入 k 格式（100 边界）", () => {
  // 100 → 0.1k（Number((100/1000).toFixed(1)) = 0.1）
  assert.equal(formatEstimatedTokens(100), "0.1k", '100 应返回 "0.1k"');
  // 999 → 1k（0.999.toFixed(1) = "1.0" → Number = 1）
  assert.equal(formatEstimatedTokens(999), "1k", '999 应返回 "1k"');
  // 1500 → 1.5k
  assert.equal(formatEstimatedTokens(1500), "1.5k", '1500 应返回 "1.5k"');
});

test("SA-013: formatEstimatedTokens 9999 边界四舍五入进位到 10k", () => {
  // 9999 → 9.999 → toFixed(1) = "10.0" → Number = 10 → "10k"
  assert.equal(formatEstimatedTokens(9999), "10k", '9999 应返回 "10k"');
});

test("SA-014: formatEstimatedTokens 10000 起返回取整 k 格式", () => {
  assert.equal(formatEstimatedTokens(10000), "10k", '10000 应返回 "10k"');
  // 15500 → Math.round(15.5) = 16
  assert.equal(formatEstimatedTokens(15500), "16k", '15500 应返回 "16k"');
});

// ============================================================================
// isAbortLikeError：Abort 错误识别
// ============================================================================

test("SA-020: isAbortLikeError 识别原生 AbortError", () => {
  const err = new Error("Request was aborted.");
  err.name = "AbortError";
  assert.equal(isAbortLikeError(err), true, "name 为 AbortError 的 Error 应识别为 true");
});

test("SA-021: isAbortLikeError 识别 APIUserAbortError（constructor.name 判定）", () => {
  // 真实子类实例（非 mock）：constructor.name 为 APIUserAbortError
  class APIUserAbortError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "APIUserAbortError";
    }
  }
  const err = new APIUserAbortError("Request was aborted.");
  assert.equal(isAbortLikeError(err), true, "APIUserAbortError 实例应识别为 true");
});

test("SA-022: isAbortLikeError 普通 Error 返回 false", () => {
  assert.equal(isAbortLikeError(new Error("普通错误")), false, "普通 Error 应识别为 false");
});

test("SA-023: isAbortLikeError 非 Error 对象返回 false", () => {
  assert.equal(isAbortLikeError("string"), false, "字符串应返回 false");
  assert.equal(isAbortLikeError(42), false, "数字应返回 false");
  assert.equal(isAbortLikeError(null), false, "null 应返回 false");
  assert.equal(isAbortLikeError(undefined), false, "undefined 应返回 false");
  assert.equal(isAbortLikeError({ name: "AbortError" }), false, "非 Error 的普通对象应返回 false");
});

// ============================================================================
// throwIfAborted：AbortSignal 前置守卫
// ============================================================================

test("SA-030: throwIfAborted 已取消的 signal 抛出 AbortError", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => throwIfAborted(controller.signal),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "已取消的 signal 应抛出 name 为 AbortError 的错误"
  );
});

test("SA-031: throwIfAborted 未取消的 signal 不抛出", () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal), "未取消的 signal 不应抛出");
});

test("SA-032: throwIfAborted undefined / null 不抛出", () => {
  assert.doesNotThrow(() => throwIfAborted(undefined), "undefined 不应抛出");
  assert.doesNotThrow(() => throwIfAborted(null), "null 不应抛出");
});

// ============================================================================
// CJK_REGEX：CJK 字符正则行为
// ============================================================================

test("SA-040: CJK_REGEX 匹配基本区与扩展 A 区 CJK 字符", () => {
  // U+4E2D（中，基本区）与 U+3400（扩展 A 区首字符）均应匹配
  const matches = "中㐀abc".match(CJK_REGEX);
  assert.ok(matches, "应产生匹配");
  assert.equal(matches!.length, 2, `应匹配 2 个 CJK 字符，实际: ${matches!.length}`);
  assert.deepEqual(matches, ["中", "㐀"], `匹配结果应为 ["中","㐀"]，实际: ${JSON.stringify(matches)}`);
});

test("SA-041: CJK_REGEX 不匹配 ASCII / CJK 标点 / 假名范围外字符", () => {
  // U+3000（CJK 全角空格，属标点区 U+3000-U+303F，不在正则范围内）
  assert.equal(CJK_REGEX.test("abc"), false, "纯 ASCII 不应匹配");
  assert.equal(CJK_REGEX.test("\u3000"), false, "U+3000 CJK 标点不应匹配");
});

test("SA-042: CJK_REGEX 兼容表意文字区（U+F900）可匹配", () => {
  // U+F900（CJK 兼容表意文字区首字符）应匹配
  const matches = "\uF900".match(CJK_REGEX);
  assert.ok(matches, "U+F900 应产生匹配");
  assert.equal(matches!.length, 1, "应匹配 1 个字符");
});
