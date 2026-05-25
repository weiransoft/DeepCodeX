import { DEEPSEEK_V4_MODELS } from "../common/model-capabilities";
import type { ModelUsage } from "../session-types";

const DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD = 128 * 1024;
const DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD = 512 * 1024;

export function getCompactPromptTokenThreshold(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model)
    ? DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD
    : DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD;
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getTotalTokens(usage: ModelUsage | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const totalTokens = (usage as Record<string, unknown>).total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}
