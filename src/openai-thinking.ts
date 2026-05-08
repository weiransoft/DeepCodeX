import type { ReasoningEffort } from "./settings";

type ThinkingConfig = {
  type: "enabled" | "disabled";
};

type ThinkingRequestOptions = {
  thinking?: ThinkingConfig;
  extra_body?: {
    thinking?: ThinkingConfig;
    reasoning_effort?: ReasoningEffort;
  };
};

export function buildThinkingRequestOptions(
  thinkingEnabled: boolean,
  baseURL?: string,
  reasoningEffort: ReasoningEffort = "max"
): ThinkingRequestOptions {
  const thinking: ThinkingConfig = { type: thinkingEnabled ? "enabled" : "disabled" };
  const normalizedBaseURL = baseURL?.toLowerCase() ?? "";

  if (normalizedBaseURL.includes(".volces.com")) {
    return {
      thinking,
      ...(thinkingEnabled ? { extra_body: { reasoning_effort: reasoningEffort } } : {})
    };
  }

  return {
    extra_body: {
      thinking,
      ...(thinkingEnabled ? { reasoning_effort: reasoningEffort } : {})
    }
  };
}
