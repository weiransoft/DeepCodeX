import * as path from "path";
import { fileURLToPath } from "url";
import { DEEPSEEK_V4_MODELS } from "../common/model-capabilities";
import type { ModelUsage } from "./types";

const DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD = 128 * 1024;
const DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD = 512 * 1024;

export function getCompactPromptTokenThreshold(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model)
    ? DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD
    : DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD;
}

export function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getTotalTokens(usage: ModelUsage | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const totalTokens = (usage as Record<string, unknown>).total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}

export function summarizeCompletionOptions(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...options,
    signal: options.signal instanceof AbortSignal ? { aborted: options.signal.aborted } : options.signal,
  };
}

export function addUsageValue(current: unknown, next: unknown): unknown {
  if (typeof next === "number") {
    return (typeof current === "number" ? current : 0) + next;
  }

  if (isUsageRecord(next)) {
    const currentRecord = isUsageRecord(current) ? current : {};
    const result: Record<string, unknown> = { ...currentRecord };
    for (const [key, value] of Object.entries(next)) {
      result[key] = addUsageValue(currentRecord[key], value);
    }
    return result;
  }

  return next;
}

export function accumulateUsage(current: ModelUsage | null, next: unknown | null | undefined): ModelUsage | null {
  if (next == null) {
    return current ?? null;
  }
  return addUsageValue(current, next) as ModelUsage;
}

export function usageWithRequestCount(usage: ModelUsage): ModelUsage {
  const totalReqs = typeof usage.total_reqs === "number" ? usage.total_reqs + 1 : 1;
  return {
    ...usage,
    total_reqs: totalReqs,
  };
}

export function accumulateUsagePerModel(
  current: Record<string, ModelUsage> | null | undefined,
  model: string,
  next: ModelUsage | null | undefined
): Record<string, ModelUsage> | null {
  if (next == null) {
    return current ?? null;
  }

  const usagePerModel = { ...(current ?? {}) };
  const modelName = model.trim() || "unknown";
  usagePerModel[modelName] = accumulateUsage(usagePerModel[modelName] ?? null, usageWithRequestCount(next))!;
  return usagePerModel;
}

export function getExtensionRoot(): string {
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "../..");
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "../..");
}
