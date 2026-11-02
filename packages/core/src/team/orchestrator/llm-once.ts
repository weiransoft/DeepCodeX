/**
 * 轻量「单次文本补全」通道（L2 拆解 / 聚合专用）
 *
 * ## 为什么不复用 `executeDispatch` 内部的 `callLlmOnce`
 *
 * 那个函数是 `executeDispatch` 的**闭包内函数**，依赖外层的 `handle`、
 * `thinkingOptions`、`requestId`、`debugLogEnabled` 与 `eventLog`。要导出它必须
 * 改动 `executeDispatch` 的调用栈——而 A 路线（L0/L1）的全部已验收行为都挂在
 * 那条栈上。为一个只调两次的辅助功能去动 1490 行适配器的主干，收益远小于风险。
 *
 * 因此这里独立实现一个精简版：messages → content，带超时与 thinking 参数对齐。
 * **刻意不做**：自动续写（拆解/聚合输出都短）、token 统计（调用方不需要分账）、
 * debug 日志（拆解失败已有降级路径，不需要第二套排查设施）。
 *
 * @module team/orchestrator/llm-once
 */

import { createOpenAIClient, isOpenAIClientHandle, type OpenAIClientHandle } from "../../common/openai-client.js";
import { buildThinkingRequestOptions } from "../../common/openai-thinking.js";

/** 单次调用结果 */
export type LlmOnceResult =
  | { ok: true; content: string }
  | { ok: false; kind: "llm-unavailable" | "llm-error"; message: string };

/**
 * 解析可用的 LLM 句柄
 *
 * 优先级与 `executeDispatch` 一致：注入句柄（测试 / 宿主复用）→ 按 projectRoot 创建。
 * `client === null` 表示 API Key 缺失，返回 null 交由调用方降级。
 */
export function resolveLlmHandle(projectRoot: string, injectedClient?: unknown): OpenAIClientHandle | null {
  if (injectedClient !== undefined) {
    if (!isOpenAIClientHandle(injectedClient)) return null;
    return injectedClient;
  }
  try {
    const created = createOpenAIClient(projectRoot);
    if (created.client === null) return null;
    return {
      client: created.client,
      model: created.model,
      baseURL: created.baseURL,
      temperature: created.temperature,
      thinkingEnabled: created.thinkingEnabled,
      reasoningEffort: created.reasoningEffort,
      debugLogEnabled: created.debugLogEnabled,
    };
  } catch {
    return null;
  }
}

/** OpenAI SDK 客户端的最小结构（与 team-adapter 的断言保持一致，避免 any） */
interface ChatClientLike {
  chat: {
    completions: {
      create: (
        body: unknown,
        options?: { signal?: AbortSignal }
      ) => Promise<{
        choices: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      }>;
    };
  };
}

/**
 * 调一次 chat completion，取文本
 *
 * @param handle    已解析的句柄（调用方负责 null 检查）
 * @param system    系统提示
 * @param user      用户提示
 * @param timeoutMs 超时（默认 120s；拆解/聚合都在一次调用内完成，超时即视为失败）
 */
export async function callLlmOnce(
  handle: OpenAIClientHandle,
  system: string,
  user: string,
  timeoutMs = 120_000
): Promise<LlmOnceResult> {
  const client = handle.client as ChatClientLike;
  if (!client || typeof client.chat?.completions?.create !== "function") {
    return { ok: false, kind: "llm-unavailable", message: "LLM 客户端结构不可用（缺少 chat.completions.create）" };
  }

  const thinkingOptions = buildThinkingRequestOptions(
    handle.thinkingEnabled,
    handle.baseURL,
    handle.reasoningEffort ?? "high",
    handle.model
  );

  const body: Record<string, unknown> = {
    model: handle.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...thinkingOptions,
  };
  if (handle.temperature !== undefined) {
    body["temperature"] = handle.temperature;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client.chat.completions.create(body, { signal: controller.signal });
    const choice = response.choices?.[0];
    // reasoning_content 兜底：部分模型（DeepSeek / Qwen3 thinking）把答案放在该字段，
    // content 为空。与 session.ts / team-adapter 的处理保持一致。
    const content = (choice?.message?.content ?? choice?.message?.reasoning_content ?? "").trim();
    if (content === "") {
      return {
        ok: false,
        kind: "llm-error",
        message: `模型返回空内容（finish_reason=${choice?.finish_reason ?? "unknown"}）`,
      };
    }
    return { ok: true, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      kind: "llm-error",
      message: aborted ? `LLM 调用超时（${timeoutMs}ms）` : `LLM 调用失败: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
