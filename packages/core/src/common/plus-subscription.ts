import { fetch as undiciFetch } from "undici";
import { readDeepcodePlusSettings, type DeepcodePlusSettings } from "../settings";
import type { CreateOpenAIClient, OpenAIClientResult } from "./tool-types";

export const DEEPCODE_PLUS_BASE_URL = "https://deepcode.vegamo.cn/plugin/openai";
export type PlusSubscriptionStatus = "api only" | "full ability" | "unknown";
export type OpenAIConnection = {
  apiKey?: string;
  baseURL: string;
  usingPlus: boolean;
  configurationError?: string;
};
export type OpenAIConnectionContext = {
  connection: OpenAIConnection;
  plusApiKey?: string;
};

export function resolveOpenAIConnection(
  settings: { apiKey?: string; baseURL: string },
  plusApiKey?: string,
  subscriptionPlan: DeepcodePlusSettings["subscriptionPlan"] = "default",
  status: PlusSubscriptionStatus = "unknown"
): OpenAIConnection {
  const regular = { apiKey: settings.apiKey, baseURL: settings.baseURL, usingPlus: false };
  if (subscriptionPlan === "off") return regular;
  if (subscriptionPlan === "on" && !plusApiKey) {
    return {
      apiKey: undefined,
      baseURL: DEEPCODE_PLUS_BASE_URL,
      usingPlus: false,
      configurationError:
        "PLUS_API_KEY not found. Please configure env.PLUS_API_KEY in ~/.deepcode-plus/settings.json.",
    };
  }
  if (
    subscriptionPlan === "default" &&
    (!plusApiKey || status === "api only" || (status === "unknown" && settings.apiKey))
  )
    return regular;
  return { apiKey: plusApiKey, baseURL: DEEPCODE_PLUS_BASE_URL, usingPlus: true };
}

type ProbeFetch = (
  url: string,
  options: {
    method: "GET";
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: "manual";
  }
) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

export async function checkPlusSubscription(
  apiKey: string,
  signal?: AbortSignal,
  fetcher: ProbeFetch = undiciFetch,
  timeoutMs = 3000
): Promise<PlusSubscriptionStatus> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${DEEPCODE_PLUS_BASE_URL}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      redirect: "manual",
    });
    signal?.throwIfAborted();
    // Only HTTP status matters; release the body without requiring valid JSON.
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) return "full ability";
    if (response.status === 401 || response.status === 403) return "api only";
    return "unknown";
  } catch {
    signal?.throwIfAborted();
    return "unknown";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Keep the selected credentials stable for every LLM call within a turn. */
export function withPlusSubscription(
  getSettings: () => { apiKey?: string; baseURL: string },
  buildClient: (context: OpenAIConnectionContext) => OpenAIClientResult,
  dependencies: {
    readSettings?: () => DeepcodePlusSettings;
    checkSubscription?: (apiKey: string, signal?: AbortSignal) => Promise<PlusSubscriptionStatus>;
  } = {}
): CreateOpenAIClient {
  const readSettings = dependencies.readSettings ?? readDeepcodePlusSettings;
  const checkSubscription = dependencies.checkSubscription ?? checkPlusSubscription;
  let prepared: OpenAIConnectionContext | undefined;
  const resolve = (plus: DeepcodePlusSettings, status: PlusSubscriptionStatus): OpenAIConnectionContext => ({
    connection: resolveOpenAIConnection(getSettings(), plus.apiKey, plus.subscriptionPlan, status),
    plusApiKey: plus.apiKey,
  });
  return Object.assign(() => buildClient(prepared ?? resolve(readSettings(), "unknown")), {
    prepare: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const plus = readSettings();
      const status =
        plus.subscriptionPlan === "default" && plus.apiKey ? await checkSubscription(plus.apiKey, signal) : "unknown";
      signal?.throwIfAborted();
      prepared = resolve(plus, status);
    },
  });
}
