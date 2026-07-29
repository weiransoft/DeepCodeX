import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rotateLogIfNeeded } from "./log-rotation";

const DEBUG_LOG_FILE = "debug.log";

// ============================================================================
// FIX-08（多角色审查 2026-07-29）：日志密钥脱敏
//
// 背景：logOpenAIChatCompletionDebug 会将完整 params/request 对象落盘到
// ~/.deepcode/logs/debug.log。若对象中携带 apiKey / Authorization 头等凭据，
// 密钥将以明文持久化，任何可读取该文件的进程均可窃取。
//
// 策略（与 graph-context-utils.ts 的 SENSITIVE_KEY_PATTERN 对齐）：
//   1. 键名命中敏感模式 → 值整体替换为 [REDACTED]
//   2. 字符串值形如密钥（sk-*/Bearer */Slack/GitHub token）→ 替换为 [REDACTED]
// ============================================================================

/**
 * 敏感字段名模式：大小写不敏感，包含任一关键词即视为敏感字段
 * （在 graph-context-utils 的 key|token|secret|password|credential 基础上
 *  追加 authorization，覆盖 HTTP Authorization 头字段名）
 */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential|authorization/i;

/**
 * 敏感值模式：即使键名不敏感，值本身形如密钥时也脱敏
 * 覆盖：sk-xxx（OpenAI/DeepSeek 兼容服务）、Bearer xxx、
 *       xox[baprs]-xxx（Slack）、ghp_/gho_/github_pat_（GitHub）
 */
const SENSITIVE_VALUE_PATTERN =
  /^(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|xox[baprs]-\S+|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_\S+)$/;

/** 脱敏替换标记（与 graph-context-utils.ts 保持一致） */
const REDACTED = "[REDACTED]";

export type OpenAIChatCompletionDebugEntry = {
  timestamp: string;
  location: string;
  requestId?: string;
  sessionId?: string;
  model?: string;
  baseURL?: string;
  durationMs?: number;
  params?: Record<string, unknown>;
  request: Record<string, unknown>;
  response?: unknown;
  responseChunks?: unknown[];
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

export function logOpenAIChatCompletionDebug(entry: OpenAIChatCompletionDebugEntry): void {
  try {
    const logPath = getDebugLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // D-2 修复：写入前调用日志轮转（按文件大小 10MB 滚动备份，保留 3 个备份）
    // 失败时降级为直接 append，不阻塞主流程
    try {
      rotateLogIfNeeded(logPath);
    } catch {
      // 轮转失败不阻塞写入
    }
    fs.appendFileSync(logPath, `${JSON.stringify(toSerializable(entry))}\n`, "utf8");
  } catch {
    // Debug logging must never affect CLI behavior.
  }
}

export function getDebugLogPath(): string {
  return path.join(os.homedir(), ".deepcode", "logs", DEBUG_LOG_FILE);
}

export function normalizeDebugError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "UnknownError",
    message: String(error),
  };
}

function toSerializable(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(current: unknown): unknown {
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current instanceof Error) {
      return normalizeDebugError(current);
    }
    if (!current || typeof current !== "object") {
      // FIX-08：字符串值形如密钥时脱敏（即使键名不敏感）
      if (typeof current === "string" && SENSITIVE_VALUE_PATTERN.test(current)) {
        return REDACTED;
      }
      return current;
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map(walk);
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(current)) {
      // FIX-08：敏感字段名命中时整体脱敏，防止凭据写入 debug.log
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      result[key] = walk(val);
    }
    return result;
  }

  return walk(value);
}
