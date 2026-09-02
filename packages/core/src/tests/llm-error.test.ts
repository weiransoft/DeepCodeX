import { test } from "node:test";
import assert from "node:assert/strict";
import { describeLlmError, getLlmErrorDetails } from "../common/llm-error";

test("describeLlmError shows provider business errors with trace metadata", () => {
  const error = Object.assign(new Error("402 Insufficient Balance"), {
    status: 402,
    error: {
      message: "Insufficient Balance",
    },
    code: "invalid_request_error",
    type: "unknown_error",
    headers: new Headers({
      "x-request-id": "request-123",
      "x-ds-trace-id": "trace-456",
    }),
  });

  assert.equal(
    describeLlmError(error),
    "HTTP 402: Insufficient Balance [code: invalid_request_error, type: unknown_error, request ID: request-123, trace ID: trace-456]"
  );
});

test("describeLlmError unwraps underlying network causes", () => {
  const cause = new Error("getaddrinfo ENOTFOUND api.deepseek.com");
  const error = Object.assign(new Error("Connection error."), { cause });

  assert.equal(describeLlmError(error), "Connection error: getaddrinfo ENOTFOUND api.deepseek.com");
});

test("LLM error details stop at circular causes and redact credentials", () => {
  const first = Object.assign(new Error("Connection error."), { cause: undefined as unknown });
  const second = new Error("fetch failed: https://example.test?api_key=sk-secret-value");
  (first as Error & { cause: unknown }).cause = second;
  (second as Error & { cause: unknown }).cause = first;

  const details = getLlmErrorDetails(first);
  assert.equal(details.causes?.[0]?.message, "fetch failed: https://example.test?api_key=***MASKED***");
  assert.equal(details.causes?.[0]?.causes?.[0]?.message, "Connection error.");
  assert.equal(details.causes?.[0]?.causes?.[0]?.causes, undefined);
});

// fork 保留用例：D-1 修复回归测试 —— message 为空时回退到 name 而非 "Unknown error"
// 参考 llm-error.ts fallback 链：safeText 对空字符串返回 undefined，因此空 message 回退到 name

/**
 * 模拟 SDK 中 APIUserAbortError 的真实形态：构造时未传 message（super("")），
 * 仅设置 name="APIUserAbortError"。这是 D-1 修复的典型触发场景。
 */
class APIUserAbortError extends Error {
  constructor(message: string = "") {
    super(message);
    this.name = "APIUserAbortError";
  }
}

// TC-LE-004：APIUserAbortError message 为空时输出 name 而非 "Unknown error"
// 验证 D-1 核心修复：super("") 传入空字符串，safeText 返回 undefined，回退到 name
test("TC-LE-004: APIUserAbortError with empty message falls back to name instead of 'Unknown error'", () => {
  const error = new APIUserAbortError();
  // D-1 修复前会返回 "Unknown error"，修复后返回 "APIUserAbortError"
  assert.equal(describeLlmError(error), "APIUserAbortError");
});

// TC-LE-005：APIUserAbortError message 非空时输出原 message
// 验证 D-1 兼容性：非空 message 优先于 name，保持原有行为
test("TC-LE-005: APIUserAbortError with non-empty message keeps original message", () => {
  const error = new APIUserAbortError("用户主动中止");
  assert.equal(describeLlmError(error), "用户主动中止");
});

// TC-LE-006：普通 Error message 为空时输出 error.name
// 验证 D-1 修复对普通 Error 的泛化：name 默认为 "Error"
test("TC-LE-006: plain Error with empty message falls back to error.name", () => {
  const error = new Error("");
  // Error 默认 name 为 "Error"，message 为空时回退到 name
  assert.equal(describeLlmError(error), "Error");
});

// TC-LE-007：record.message 为空字符串时回退到 name
// 验证 D-1 fallback 链对非 Error 对象的覆盖
test("TC-LE-007: record with empty message falls back to name", () => {
  const record = { name: "CustomError", message: "" };
  assert.equal(describeLlmError(record), "CustomError");
});

// TC-LE-008：record.name 与 record.message 均为空时回退到 "UnknownError"
// 验证 D-1 fallback 链末端：name 也无法获取时的最终兜底
test("TC-LE-008: record without name and empty message falls back to 'UnknownError'", () => {
  const record = { message: "" };
  // 无 name 字段且非 Error 实例，name 兜底为 "UnknownError"
  assert.equal(describeLlmError(record), "UnknownError");
});

// TC-LE-009：非 Error 非 record 值（字符串）输出 String(value)
// 验证 D-1 非 Error 路径：safeText(error) 对字符串原样返回
test("TC-LE-009: plain string value is converted via String(value)", () => {
  assert.equal(describeLlmError("plain string"), "plain string");
});

// TC-LE-010：非 Error 非 record 值（null）输出 "UnknownError"
// 验证 D-1 边界：null 既非 record 也非 Error，所有 fallback 均失败
test("TC-LE-010: null value falls back to 'UnknownError'", () => {
  assert.equal(describeLlmError(null), "UnknownError");
});

// TC-LE-011：getLlmErrorDetails 保留 name 字段且 message 回退到 name
// 验证 D-1 详情保留：details.name 与 details.message 均含原始错误类型
test("TC-LE-011: getLlmErrorDetails preserves name field and message falls back to name", () => {
  const error = new APIUserAbortError();
  const details = getLlmErrorDetails(error);
  assert.equal(details.name, "APIUserAbortError");
  // message 为空时回退到 name，保持错误类型信息不丢失
  assert.equal(details.message, "APIUserAbortError");
});

// TC-LE-012：HTTP 错误优先使用 provider message
// 验证 D-1 与 HTTP 路径兼容：有 status 时走 HTTP 分支，使用 getProviderMessage，不回退到 name
test("TC-LE-012: HTTP error uses provider message instead of falling back to name", () => {
  const error = { status: 429, error: { message: "Rate limited" }, message: "" };
  // 有 status 走 HTTP 分支，优先使用 error.error.message，不触发 name fallback
  assert.equal(describeLlmError(error), "HTTP 429: Rate limited");
});
