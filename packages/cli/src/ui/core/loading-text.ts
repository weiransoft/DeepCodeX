import type { LlmStreamProgress, SessionEntry } from "@vegamo/deepcode-core";

type RunningProcesses = SessionEntry["processes"];

export type LoadingTextInput = {
  progress: LlmStreamProgress | null;
  processes?: RunningProcesses;
  now: number;
};

const STALL_THRESHOLD_MS = 3000;

/**
 * 将数字字符串格式化为带千分位分隔符的字符串。
 *
 * 例如："1234567" → "1,234,567"；"850" → "850"。
 * 输入为空或非数字时返回 "0"。
 *
 * @param value 原始 token 数字字符串
 * @returns 带千分位分隔符的字符串
 */
function formatTokens(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  const num = Number(raw);
  if (raw === "" || !Number.isFinite(num)) {
    return "0";
  }
  return num.toLocaleString("en-US");
}

export function buildLoadingText(input: LoadingTextInput): string {
  const { progress, processes, now } = input;
  const processText = buildProcessLoadingText(processes, now);
  if (processText) {
    return processText;
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
  const tokens = formatTokens(progress.formattedTokens);
  return `思考中... (${elapsedSeconds}s) · ↓ ${tokens} tokens`;
}

function buildProcessLoadingText(processes: RunningProcesses | undefined, now: number): string | null {
  if (!processes || processes.size === 0) {
    return null;
  }

  const first = processes.values().next().value as { startTime: string; command: string } | undefined;
  if (!first) {
    return null;
  }

  return `(${formatElapsedTime(first.startTime, now)}) ${first.command}`;
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
