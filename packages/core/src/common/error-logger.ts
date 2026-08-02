import * as fs from "fs";
import * as path from "path";
import type { LlmErrorDetails } from "./llm-error";
// D-2 修复：导入统一日志轮转工具，替代历史"读全文 + slice + 重写"反模式
import { rotateLogIfNeeded, getDeepCodeXLogDir } from "./log-rotation";

/** error.log 文件名常量 */
const ERROR_LOG_FILE = "error.log";

/**
 * 获取 error.log 完整路径。
 *
 * 与 debug-logger.ts 的 getDebugLogPath 保持一致的设计：每次调用都重新读取
 * os.homedir()，确保测试通过切换 process.env.HOME 能实现日志隔离。
 * 若改为模块级常量，模块加载时路径即固定，测试将无法通过 HOME 切换隔离。
 *
 * 日志目录已迁移到 ~/.deepcodex/logs，旧版 ~/.deepcode/logs 仅保留只读兼容。
 */
export function getErrorLogPath(): string {
  return path.join(getDeepCodeXLogDir(), ERROR_LOG_FILE);
}

/**
 * 确保日志目录存在。
 *
 * @param logPath 日志文件完整路径（从中提取目录）
 */
function ensureLogDir(logPath: string): void {
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Mask sensitive values (API keys, tokens) that may appear in error messages
 * or response bodies.
 */
function maskSensitive(text: string): string {
  return (
    text
      // Mask Bearer tokens in Authorization headers
      .replace(/(Authorization:\s*Bearer\s+)[^\s\r\n]+/gi, "$1***MASKED***")
      // Mask "apiKey" or "api_key" values in JSON-like strings
      .replace(/((?:api[Kk]ey|api_key|secret)\s*[:=]\s*"?)[^",}\s]+/gi, "$1***MASKED***")
  );
}

const CONTENT_TRUNCATE_PREVIEW = 100;

/**
 * Truncate a content string for logging: keep a short prefix and append the
 * total length so the payload structure is preserved while content bloat is
 * avoided.
 */
function truncateContent(value: string): string {
  if (value.length <= CONTENT_TRUNCATE_PREVIEW) {
    return value;
  }
  return `${value.slice(0, CONTENT_TRUNCATE_PREVIEW)}...(total ${value.length} chars)`;
}

/**
 * Deep-clone a request payload, only truncating `content` fields whose value
 * is a string.  Every other field is kept exactly as-is so the logged request
 * mirrors the original API payload (no fields added or removed).
 */
function sanitizeRequestPayload(request: Record<string, unknown>): Record<string, unknown> {
  function walk(value: unknown): unknown {
    if (!value || typeof value !== "object") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(walk);
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(record)) {
      if (key === "content" && typeof val === "string") {
        result[key] = truncateContent(val);
      } else {
        result[key] = walk(val);
      }
    }

    return result;
  }

  return walk(request) as Record<string, unknown>;
}

export type ApiErrorLogEntry = {
  timestamp: string;
  location: string;
  requestId: string;
  sessionId?: string;
  model?: string;
  baseURL?: string;
  error: LlmErrorDetails;
  request: Record<string, unknown>;
  response?: unknown;
};

/**
 * Write an API error log entry to ~/.deepcodex/logs/error.log.
 */
export function logApiError(entry: ApiErrorLogEntry): void {
  try {
    const logPath = getErrorLogPath();
    ensureLogDir(logPath);

    const logLine: Record<string, unknown> = {
      timestamp: entry.timestamp,
      location: entry.location,
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      model: entry.model,
      baseURL: entry.baseURL,
      error: sanitizeError(entry.error),
      request: sanitizeRequestPayload(entry.request),
    };

    if (entry.response !== undefined) {
      logLine.response = typeof entry.response === "string" ? maskSensitive(entry.response) : entry.response;
    }

    const newLine = JSON.stringify(logLine) + "\n";
    // D-2 修复：写入前调用日志轮转（按文件大小 10MB 滚动备份，保留 3 个备份）
    // 失败时降级为直接 append，不阻塞主流程
    try {
      rotateLogIfNeeded(logPath);
    } catch {
      // 轮转失败不阻塞写入
    }
    fs.appendFileSync(logPath, newLine, "utf8");
  } catch {
    // Silently ignore logging failures to avoid disrupting the main flow
  }
}

function sanitizeError(error: LlmErrorDetails): LlmErrorDetails {
  return {
    ...error,
    message: maskSensitive(error.message),
    stack: error.stack ? maskSensitive(error.stack) : undefined,
    causes: error.causes?.map(sanitizeError),
  };
}
