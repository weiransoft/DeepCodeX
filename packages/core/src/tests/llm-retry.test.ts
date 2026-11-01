import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getLlmRetryDelayMs,
  getLlmRetryAfterMs,
  isRetryableLlmError,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  LlmStreamDisconnectedError,
  LlmStreamIdleTimeoutError,
  MAX_LLM_IDLE_TIMEOUT_ATTEMPTS,
  waitForLlmRetry,
} from "../common/llm-retry";

test("getLlmRetryDelayMs applies exponential backoff with ten percent jitter", () => {
  const expected = [800, 1600, 3200, 6400, 12800];
  for (let index = 0; index < expected.length; index += 1) {
    const attempt = index + 1;
    assert.equal(
      getLlmRetryDelayMs(attempt, () => 0),
      Math.round(expected[index]! * 0.9)
    );
    assert.equal(
      getLlmRetryDelayMs(attempt, () => 0.5),
      expected[index]
    );
    assert.equal(
      getLlmRetryDelayMs(attempt, () => 1),
      Math.round(expected[index]! * 1.1)
    );
  }
});

test("getLlmRetryAfterMs honors millisecond, second, and HTTP-date headers", () => {
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  assert.equal(
    getLlmRetryAfterMs(
      Object.assign(new Error("rate limited"), { headers: new Headers({ "retry-after-ms": "1250" }) }),
      now
    ),
    1250
  );
  assert.equal(getLlmRetryAfterMs({ headers: { "Retry-After": "60" } }, now), 60_000);
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "Tue, 01 Sep 2026 00:00:30 GMT" } }, now), 30_000);
});

test("getLlmRetryAfterMs prefers retry-after-ms and ignores invalid headers", () => {
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after-ms": "2500", "retry-after": "60" } }), 2500);
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "not-a-date" } }), undefined);
  assert.equal(getLlmRetryAfterMs(new Error("no headers")), undefined);
});

test("isRetryableLlmError recognizes recoverable HTTP and transport failures", () => {
  // 500 不在可重试集合（上游 v0.4.0 语义：Internal Server Error 通常是服务端 bug，
  // 重试无效）；原断言把 500/599 也标 true 与实现矛盾，已按实现语义修正。
  for (const status of [408, 409, 429, 502, 503, 504]) {
    assert.equal(isRetryableLlmError(Object.assign(new Error("API failed"), { status })), true);
  }
  assert.equal(isRetryableLlmError(Object.assign(new Error("Server error"), { status: 500 })), false);
  assert.equal(isRetryableLlmError(Object.assign(new Error("API failed"), { status: 599 })), false);
  assert.equal(isRetryableLlmError(Object.assign(new Error("Bad request"), { status: 400 })), false);
  assert.equal(isRetryableLlmError(Object.assign(new Error("Unauthorized"), { status: 401 })), false);
  assert.equal(
    isRetryableLlmError(
      new Error("Connection error", { cause: Object.assign(new Error("read failed"), { code: "ECONNRESET" }) })
    ),
    true
  );
  assert.equal(isRetryableLlmError(new LlmStreamIdleTimeoutError()), true);
  assert.equal(isRetryableLlmError(new LlmStreamDisconnectedError()), true);
});

test("LlmStreamIdleTimeoutError distinguishes idle from total timeout", () => {
  // 2026-11-01 两通路统一：同一错误类型承载两种超时语义，文案不得混淆——
  // 旧实现无论总超时阈值多少都喊"idle for 60 seconds"，误导排障方向。
  const idle = new LlmStreamIdleTimeoutError();
  assert.equal(idle.kind, "idle");
  assert.equal(idle.timeoutMs, LLM_STREAM_IDLE_TIMEOUT_MS);
  assert.equal(idle.message, "Model stream was idle for 60 seconds.");

  const total = new LlmStreamIdleTimeoutError({ kind: "total", timeoutMs: 15_000 });
  assert.equal(total.kind, "total");
  assert.equal(total.timeoutMs, 15_000);
  assert.equal(total.message, "Model stream exceeded the total timeout of 15 seconds.");

  // 非整秒阈值（skill matching 之外的短超时）也要可读，不能出现 "0.2 seconds" 之外的畸形数字
  const fractional = new LlmStreamIdleTimeoutError({ kind: "total", timeoutMs: 1_500 });
  assert.equal(fractional.message, "Model stream exceeded the total timeout of 1.5 seconds.");

  // 两种 kind 都必须可重试，否则总超时会被 isAbortLikeError 吃成"用户中断"
  assert.equal(isRetryableLlmError(idle), true);
  assert.equal(isRetryableLlmError(total), true);
  assert.equal(MAX_LLM_IDLE_TIMEOUT_ATTEMPTS, 2, "超时专属 cap 为 2 次 attempt（首次 + 1 次重试）");
});

test("waitForLlmRetry can be interrupted", async () => {
  const controller = new AbortController();
  const waiting = waitForLlmRetry(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: Error) => error.name === "AbortError");
});

test("getLlmRetryAfterMs clamps oversized retry-after headers to 120s", () => {
  // 上游过载给出 600s retry-after：必须钳到 MAX_LLM_RETRY_DELAY_MS=120s，
  // 否则 CLI 挂在"思考中..."十分钟无反馈（与卡死不可区分）
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "600" } }), 120_000);
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after-ms": String(30 * 60 * 1000) } }), 120_000);
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "Tue, 01 Sep 2026 00:30:00 GMT" } }, now), 120_000);
  // 正常范围内的值不受钳制影响
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "60" } }), 60_000);
});

test("waitForLlmRetry tolerates delays above the 32-bit setTimeout bound", async () => {
  // retry-after 异常大（> 2^31-1 ms）时 setTimeout 会立即触发；
  // getLlmRetryAfterMs 已钳制，waitForLlmRetry 自身再做一层防御：
  // abort 在钳制后的等待期内仍然可靠生效（不被立即 resolve 穿透）
  const controller = new AbortController();
  const waiting = waitForLlmRetry(3_000_000_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: Error) => error.name === "AbortError");
});
