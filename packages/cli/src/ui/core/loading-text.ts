import type { LlmRetryEvent, LlmStreamProgress, SessionEntry } from "@vegamo/deepcode-core";
import {
  BASH_RUNNING_HINT_SLOW_MS,
  BASH_RUNNING_HINT_STUCK_MS,
  BASH_RUNNING_HINT_VERY_SLOW_MS,
} from "@vegamo/deepcode-core";
import stringWidth from "string-width";

type RunningProcesses = SessionEntry["processes"];

export type LoadingTextInput = {
  progress: LlmStreamProgress | null;
  retry?: LlmRetryEvent | null;
  processes?: RunningProcesses;
  now: number;
  screenWidth?: number;
};

const STALL_THRESHOLD_MS = 3000;
const MIN_PREVIEW_TERMINAL_WIDTH = 80;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 将数字字符串格式化为带千分位分隔符的字符串。
 *
 * 例如："1234567" → "1,234,567"；"850" → "850"。
 * 上游 v0.4.0 streaming preview 会传入已带单位的紧凑格式（如 "1.5k"），
 * 此时原样透传（此前 Number("1.5k") 为 NaN 会被错误折叠为 "0"，
 * 导致用户在 preview 场景看到 "↓ 0 tokens" 的显示 bug）。
 * 输入为空或纯非数字时返回 "0"。
 *
 * @param value 原始 token 数字字符串（或已格式化的紧凑串）
 * @returns 带千分位分隔符的字符串，或透传的紧凑格式
 */
function formatTokens(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (raw === "") {
    return "0";
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    // 非纯数字（如上游 preview 的 "1.5k" 紧凑格式）：原样透传，不折叠为 "0"
    return raw;
  }
  return num.toLocaleString("en-US");
}

export function buildLoadingText(input: LoadingTextInput): string {
  const { progress, retry, processes, now } = input;
  const processText = buildProcessLoadingText(processes, now);
  if (processText) {
    return processText;
  }

  if (retry) {
    return `Reconnecting... ${retry.attempt}/${retry.maxRetries} (esc to interrupt)`;
  }

  if (!progress) {
    return "思考中...";
  }

  const startedAt = parseTimestamp(progress.startedAt);
  if (startedAt === null) {
    return "思考中...";
  }

  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs < STALL_THRESHOLD_MS) {
    return "思考中...";
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  // 融合两侧：fork 的千分位格式化 + 上游 v0.4.0 的 streaming preview
  const tokens = formatTokens(progress.formattedTokens);
  const status = `思考中... (${elapsedSeconds}s) · ↓ ${tokens} tokens`;
  const preview = progress.previewText;
  if (progress.estimatedTokens <= 1500 || !preview || (input.screenWidth ?? 0) < MIN_PREVIEW_TERMINAL_WIDTH) {
    return status;
  }
  const available = (input.screenWidth ?? 0) - 28 - stringWidth(status) - 3; // Space and brackets.
  if (available <= 0) {
    return status;
  }
  if (stringWidth(preview) <= available) {
    return `${status} [${preview}]`;
  }
  let tail = "";
  let width = 3; // Leading ellipsis.
  const graphemes = Array.from(segmenter.segment(preview), (part) => part.segment);
  for (let i = graphemes.length - 1; i >= 0; i--) {
    width += stringWidth(graphemes[i]!);
    if (width > available) break;
    tail = graphemes[i] + tail;
  }
  return tail ? `${status} [...${tail}]` : status;
}

function buildProcessLoadingText(processes: RunningProcesses | undefined, now: number): string | null {
  if (!processes || processes.size === 0) {
    return null;
  }

  const first = processes.values().next().value as { startTime: string; command: string } | undefined;
  if (!first) {
    return null;
  }

  const elapsedMs = Math.max(0, now - (parseTimestamp(first.startTime) ?? now));
  const hint = buildRunningProcessHint(elapsedMs);
  return `(${formatElapsedTime(first.startTime, now)}) ${first.command}${hint}`;
}

/**
 * 运行中命令的卡顿提示阶梯（修复"工具调用卡死"2026-10-03）。
 *
 * 阶梯与 core 的 BASH_RUNNING_HINT_* 常量对齐：
 *   <10s   → 不提示
 *   10~30s → 运行中，可 Ctrl+C 中断
 *   30~60s → 较慢，建议走 run_in_background
 *   ≥60s   → 已卡住？Ctrl+C 中断 + 改用 run_in_background:true
 *
 * 仅做提示，不改变 120s 硬超时兜底逻辑。
 *
 * @param elapsedMs 命令已运行毫秒数
 * @returns 提示后缀（带前导分隔符 " · "）；<10s 返回空串
 */
function buildRunningProcessHint(elapsedMs: number): string {
  if (elapsedMs >= BASH_RUNNING_HINT_STUCK_MS) {
    return " · 已卡住？Ctrl+C 中断 + 改用 run_in_background:true";
  }
  if (elapsedMs >= BASH_RUNNING_HINT_VERY_SLOW_MS) {
    return " · 较慢，建议走 run_in_background";
  }
  if (elapsedMs >= BASH_RUNNING_HINT_SLOW_MS) {
    return " · 运行中，可 Ctrl+C 中断";
  }
  return "";
}

function formatElapsedTime(startTimeIso: string, now: number): string {
  const startTime = parseTimestamp(startTimeIso);
  const elapsedMs = startTime === null ? 0 : Math.max(0, now - startTime);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}
