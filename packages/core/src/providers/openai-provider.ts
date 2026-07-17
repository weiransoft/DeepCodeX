/**
 * OpenAI Provider（Provider 抽象层 · OpenAI 协议实现）
 *
 * 设计原则：包装现有 openai SDK 客户端创建逻辑，零行为变化。
 * - 流式调用不经过本层（session.ts 既有 createChatCompletionStream 直接操作
 *   底层 OpenAI SDK 实例，本层通过 getUnderlyingOpenAI 暴露）；
 * - 非流式 createMessage 走标准 chat.completions.create；
 * - 消息转换复用现有 OpenAIMessageConverter。
 *
 * @module providers/openai-provider
 */

import OpenAI from "openai";
import type { ResolvedDeepcodingSettings } from "../settings";
import { OpenAIMessageConverter } from "../common/openai-message-converter";
import type {
  LLMClient,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMUsage,
} from "./llm-provider";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;

  createClient(settings: ResolvedDeepcodingSettings): OpenAILLMClient {
    return new OpenAILLMClient(settings);
  }
}

export class OpenAILLMClient implements LLMClient {
  readonly providerName = "openai" as const;
  readonly model: string;
  readonly baseURL: string;
  readonly supportsThinking = true;
  readonly supportsPromptCaching = false;

  private readonly settings: ResolvedDeepcodingSettings;
  private sdk: OpenAI | null = null;
  private readonly converter = new OpenAIMessageConverter();

  constructor(settings: ResolvedDeepcodingSettings) {
    this.settings = settings;
    this.model = settings.model;
    this.baseURL = settings.baseURL;
  }

  /** 暴露底层 OpenAI SDK 实例（session.ts 既有流式逻辑复用，向后兼容关键） */
  getUnderlyingOpenAI(): OpenAI | null {
    if (!this.settings.apiKey) return null;
    if (!this.sdk) {
      this.sdk = new OpenAI({
        apiKey: this.settings.apiKey,
        baseURL: this.settings.baseURL || undefined,
      });
    }
    return this.sdk;
  }

  /** 非流式调用（chat.completions.create，复用 OpenAI converter 的消息转换） */
  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const client = this.getUnderlyingOpenAI();
    if (!client) {
      throw new Error("OpenAI provider 需要 env.API_KEY，请检查 settings.json 配置");
    }

    const messages = this.converter.buildMessages(request.messages, request.thinkingEnabled, this.model);
    const completion = await client.chat.completions.create(
      {
        model: this.model,
        messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((t) => ({
                type: "function" as const,
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      },
      { signal: request.signal ?? undefined }
    );

    const choice = completion.choices[0];
    const msg = choice?.message;
    const toolCalls: LLMToolCall[] = (msg?.tool_calls ?? [])
      .filter((tc) => tc.type === "function")
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      }));

    // DeepSeek thinking：reasoning_content 为非标准字段，做类型容错
    const reasoning = (msg as unknown as Record<string, unknown> | undefined)?.["reasoning_content"];

    const usage: LLMUsage | null = completion.usage
      ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens }
      : null;

    return {
      content: msg?.content ?? "",
      thinking: typeof reasoning === "string" ? reasoning : "",
      toolCalls,
      stopReason: choice?.finish_reason ?? null,
      usage,
    };
  }

  /**
   * 流式调用：归一化事件流。
   *
   * 注意：session.ts 主对话既有流式逻辑（createChatCompletionStream）不经过本方法，
   * 本方法面向新消费方（team workflows 等）提供统一事件流。
   */
  async *createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const client = this.getUnderlyingOpenAI();
    if (!client) {
      yield { type: "error", error: new Error("OpenAI provider 需要 env.API_KEY") };
      return;
    }

    const messages = this.converter.buildMessages(request.messages, request.thinkingEnabled, this.model);
    try {
      // M3：流式参数与非流式 createMessage 对齐——tools 映射为 function 工具、
      // temperature 仅在显式提供时传递（未提供时不发送，保持服务端默认采样行为）
      const stream = await client.chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((t) => ({
                  type: "function" as const,
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
        },
        { signal: request.signal ?? undefined }
      );

      // 工具调用增量状态：index → id/name 累积
      const toolState = new Map<number, { id: string; name: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", text: delta.content };
        }
        const reasoning = (delta as unknown as Record<string, unknown>)["reasoning_content"];
        if (typeof reasoning === "string" && reasoning.length > 0) {
          yield { type: "thinking_delta", thinking: reasoning };
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index;
          if (tc.id && tc.function?.name) {
            toolState.set(idx, { id: tc.id, name: tc.function.name });
            yield { type: "tool_call_start", id: tc.id, name: tc.function.name };
          } else if (tc.function?.arguments && toolState.has(idx)) {
            yield { type: "tool_call_delta", id: toolState.get(idx)!.id, argumentsJsonDelta: tc.function.arguments };
          }
        }
        const finish = chunk.choices[0]?.finish_reason;
        if (finish) {
          for (const [, state] of toolState) {
            yield { type: "tool_call_end", id: state.id };
          }
          yield { type: "message_end", stopReason: finish, usage: null };
        }
      }
    } catch (e) {
      yield { type: "error", error: e instanceof Error ? e : new Error(String(e)) };
    }
  }
}
