import { getLlmErrorDetails } from "./llm-error";

export const MAX_LLM_RETRIES = 5;
export const LLM_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * 流超时（idle / total）专属重试上限（含首次 attempt，即最多 2 次请求）。
 *
 * 超时本身就是"上游长时间无数据"的信号：若再走满 MAX_LLM_RETRIES=5 的指数退避，
 * 60s × 6 ≈ 6 分钟把用户钉在"思考中..."，与"卡死"不可区分；短任务专用超时
 * （skill matching 15s）乘 6 更毫无意义。给偶发抖动留一次恢复机会即可。
 *
 * 2026-11-01 起 OpenAI / Anthropic 两条通路共用本常量（此前只有 Anthropic 侧有 cap，
 * OpenAI 侧的总超时既不报错也不重试，语义不一致）。
 */
export const MAX_LLM_IDLE_TIMEOUT_ATTEMPTS = 2;

const BASE_RETRY_DELAY_MS = 800;
/**
 * LLM 重试退避硬上限（120 秒）。
 *
 * 上游（网关/代理）的 retry-after 头在过载时可能给出数百秒甚至更长的值，
 * 直接照单全收会让 CLI 挂在"思考中..."数分钟且无任何反馈，与"卡死"不可区分。
 * 超过本上限时截断为上限值——重试次数（MAX_LLM_RETRIES=5）与指数退避本身
 * 已覆盖常规瞬态，硬上限只兜异常头的底。
 */
export const MAX_LLM_RETRY_DELAY_MS = 120_000;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * 流超时语义区分（2026-11-01 两通路统一）
 *
 * - `idle`：两个 chunk 之间静默超过 LLM_STREAM_IDLE_TIMEOUT_MS（上游仍在连接但不出数据）
 * - `total`：整条流从发起到结束超过调用方给定的 streamTimeoutMs（settings.timeout 或
 *   短任务专用值如 skill matching 的 15s）
 *
 * 两者都必须归一化为可重试错误：旧实现里 OpenAI 通路的总超时只 abort 控制器、不打标记，
 * 流循环把它当成"用户点了停止"（abortedBreak）→ 静默返回已积累内容（通常为 ""），
 * 既不重试也不报错；而 Anthropic 通路早已归一化为本错误类型。语义拉齐后两条通路
 * 共用同一套重试 cap 与错误提示。
 */
export type LlmStreamTimeoutKind = "idle" | "total";

/** 毫秒转秒的可读文案：60 → "60"、200 → "0.2"、1500 → "1.5" */
function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

export class LlmStreamIdleTimeoutError extends Error {
  /** 超时种类：空闲静默 / 整条流总超时 */
  readonly kind: LlmStreamTimeoutKind;
  /** 触发本次超时的毫秒阈值 */
  readonly timeoutMs: number;

  constructor(options?: { kind?: LlmStreamTimeoutKind; timeoutMs?: number }) {
    const kind: LlmStreamTimeoutKind = options?.kind ?? "idle";
    const timeoutMs = options?.timeoutMs ?? LLM_STREAM_IDLE_TIMEOUT_MS;
    super(
      kind === "total"
        ? `Model stream exceeded the total timeout of ${formatTimeoutSeconds(timeoutMs)} seconds.`
        : `Model stream was idle for ${formatTimeoutSeconds(timeoutMs)} seconds.`
    );
    this.name = "LlmStreamIdleTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

export class LlmStreamDisconnectedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Model stream disconnected before completion.", options);
    this.name = "LlmStreamDisconnectedError";
  }
}

export function getLlmRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.9 + Math.min(1, Math.max(0, random())) * 0.2;
  return Math.round(exponentialDelay * jitter);
}

export function getLlmRetryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  const headers = getErrorHeaders(error);
  const retryAfterMs = parseDelay(getHeader(headers, "retry-after-ms"));
  if (retryAfterMs !== undefined) {
    // 硬上限截断：超大 retry-after 钳到 120s，避免 UI 挂在"思考中..."数分钟无反馈
    return Math.min(retryAfterMs, MAX_LLM_RETRY_DELAY_MS);
  }

  const retryAfter = getHeader(headers, "retry-after");
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, Math.round(seconds * 1000)), MAX_LLM_RETRY_DELAY_MS);
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), MAX_LLM_RETRY_DELAY_MS) : undefined;
}

export function isRetryableLlmError(error: unknown): boolean {
  // upstream 0.4.0 + fork 融合：优先检查自定义断连/超时错误类型（LlmStreamDisconnectedError /
  // LlmStreamIdleTimeoutError），这些是流式调用可重试的主要触发源。
  if (error instanceof LlmStreamIdleTimeoutError || error instanceof LlmStreamDisconnectedError) {
    return true;
  }

  const details = getLlmErrorDetails(error);
  const pending = [details];
  while (pending.length > 0) {
    const detail = pending.shift()!;
    // 可重试的 HTTP 状态码：
    // - 408 (Request Timeout) / 409 (Conflict) / 429 (Rate Limit)：标准可重试状态码
    // - 502/503/504：网关错误/服务不可用/网关超时，瞬态可重试
    // - 500 不可重试：Internal Server Error 通常是服务端 bug，重试没用
    if (
      detail.status === 408 ||
      detail.status === 409 ||
      detail.status === 429 ||
      detail.status === 502 ||
      detail.status === 503 ||
      detail.status === 504
    ) {
      return true;
    }
    if (detail.code && RETRYABLE_NETWORK_CODES.has(detail.code.toUpperCase())) {
      return true;
    }
    if (
      /(?:connection (?:error|reset|refused|closed)|fetch failed|network error|socket|timed? ?out|premature close|websocket.*closed)/i.test(
        `${detail.name} ${detail.message}`
      )
    ) {
      return true;
    }
    pending.push(...(detail.causes ?? []));
  }
  return false;
}

export function waitForLlmRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    // 32 位有符号整数上限：setTimeout 延时超过该值会立即触发（Node 规范行为），
    // 上游 retry-after 异常大（分钟级/垃圾头）时必须钳制，否则退避等待会瞬时穿透
    const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;
    const timer = setTimeout(finish, Math.min(Math.max(0, delayMs), MAX_SAFE_TIMEOUT_MS));
    signal?.addEventListener("abort", cancel, { once: true });

    function finish(): void {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }

    function cancel(): void {
      clearTimeout(timer);
      reject(abortError(signal));
    }
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  return error;
}

function getErrorHeaders(error: unknown): unknown {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.headers) {
      return record.headers;
    }
    current = record.cause;
  }
  return undefined;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): unknown }).get(name);
    return typeof value === "string" ? value.trim() : undefined;
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1].trim() : undefined;
}

function parseDelay(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const delay = Number.parseFloat(value);
  return Number.isFinite(delay) ? Math.max(0, Math.round(delay)) : undefined;
}
