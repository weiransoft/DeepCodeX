/**
 * Anthropic Provider（原生 Claude API 支持 · 客户端层）
 *
 * 职责：
 * 1. 封装 @anthropic-ai/sdk 客户端创建（apiKey/baseURL/beta headers）；
 * 2. 请求构建：thinking/maxTokens/cache_control 注入；
 * 3. 响应解析：content/thinking/tool_use/usage 归一化为 LLMResponse；
 * 4. 流式事件：SSE 事件流归一化为 LLMStreamEvent；
 * 5. 错误透传：SDK 错误按 message 透传，不做静默降级。
 *
 * 可测试性：createMessage 的 HTTP 层经 transport 函数注入，测试可替换为桩实现
 * （非 mock 框架，是真实函数注入——验证解析逻辑本身）。
 *
 * @module providers/anthropic-provider
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedDeepcodingSettings } from "../settings";
import { AnthropicMessageConverter } from "./anthropic-converter";
import type {
  LLMClient,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMUsage,
} from "./llm-provider";

/** 非流式响应 transport 签名（生产=SDK 调用，测试=桩函数） */
type CreateTransport = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

/** 流式事件 transport 签名（生产=SDK 流式调用，测试=桩函数，真实异步迭代器非 mock 框架） */
type StreamTransport = (
  params: Anthropic.MessageCreateParamsNonStreaming
) => AsyncIterable<Anthropic.RawMessageStreamEvent>;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;

  createClient(settings: ResolvedDeepcodingSettings): AnthropicLLMClient {
    // 配置校验：fail-fast（设计文档 §5.1）
    if (!settings.apiKey) {
      throw new Error("Anthropic provider 需要 env.API_KEY（sk-ant- 开头），请检查 settings.json 配置");
    }
    return new AnthropicLLMClient(settings);
  }
}

export class AnthropicLLMClient implements LLMClient {
  readonly providerName = "anthropic" as const;
  readonly model: string;
  readonly baseURL: string;
  readonly supportsThinking = true;
  readonly supportsPromptCaching = true;

  /** SDK 客户端（延迟初始化，避免构造即联网校验） */
  private sdk: Anthropic | null = null;
  private readonly apiKey: string;
  private readonly betaFeatures: string[];
  private readonly maxTokens: number;
  private readonly thinkingBudgetTokens: number;
  private readonly converter = new AnthropicMessageConverter();
  /** 测试注入点：非流式 transport（生产环境为 null，走 SDK） */
  private transport: CreateTransport | null = null;
  /** 测试注入点：流式 transport（生产环境为 null，走 SDK 流式） */
  private streamTransport: StreamTransport | null = null;

  constructor(settings: ResolvedDeepcodingSettings) {
    this.apiKey = settings.apiKey ?? "";
    this.model = settings.model;
    this.baseURL = settings.baseURL || "https://api.anthropic.com";
    this.betaFeatures = settings.anthropic?.betaFeatures ?? [];
    this.maxTokens = settings.anthropic?.maxTokens ?? 8192;
    this.thinkingBudgetTokens = settings.anthropic?.thinkingBudgetTokens ?? 4096;
  }

  /** 测试专用：注入非流式 transport 桩（验证解析逻辑，绕开网络） */
  setTransportForTesting(transport: CreateTransport): void {
    this.transport = transport;
  }

  /** 测试专用：注入流式 transport 桩（验证 SSE 事件归一化逻辑，绕开网络） */
  setStreamTransportForTesting(transport: StreamTransport): void {
    this.streamTransport = transport;
  }

  /**
   * 构建 Claude 请求参数（独立公开以便测试断言，不发起网络调用）
   */
  buildRequestParams(request: LLMRequest): Anthropic.MessageCreateParamsNonStreaming {
    const { system, messages } = this.converter.buildMessages(request.messages, request.thinkingEnabled, this.model);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
    };

    // system 注入：prompt caching 启用时转为块数组并打 cache_control
    if (system !== undefined) {
      if (this.betaFeatures.includes("prompt-caching")) {
        params.system = [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          } as Anthropic.TextBlockParam,
        ];
      } else {
        params.system = system;
      }
    }

    // extended thinking 注入（请求级开关）
    if (request.thinkingEnabled && this.betaFeatures.includes("extended-thinking")) {
      params.thinking = { type: "enabled", budget_tokens: this.thinkingBudgetTokens };
    }

    // 工具定义转换
    if (request.tools && request.tools.length > 0) {
      params.tools = this.converter.buildTools(request.tools);
    }

    return params;
  }

  /** 非流式调用 */
  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const params = this.buildRequestParams(request);
    const message = this.transport
      ? await this.transport(params)
      : await this.getSdk().messages.create(params, { signal: request.signal ?? undefined });
    return this.parseResponse(message);
  }

  /** 流式调用：SDK 事件流 → 归一化 LLMStreamEvent */
  async *createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const params = this.buildRequestParams(request);
    // SDK 的 messages.stream() 接受非流式形态参数并自动启用流式，无需（也不可）传 stream: true；
    // 测试场景经注入的流式 transport 供给真实异步事件序列（验证归一化逻辑本身）
    const stream: AsyncIterable<Anthropic.RawMessageStreamEvent> = this.streamTransport
      ? this.streamTransport(params)
      : this.getSdk().messages.stream(params, { signal: request.signal ?? undefined });

    // 流式状态：tool_use 块的 id/name 在 content_block_start 给出，input_json_delta 后续增量
    let currentToolId: string | null = null;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              currentToolId = block.id;
              yield { type: "tool_call_start", id: block.id, name: block.name };
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking_delta", thinking: delta.thinking };
            } else if (delta.type === "input_json_delta" && currentToolId !== null) {
              yield { type: "tool_call_delta", id: currentToolId, argumentsJsonDelta: delta.partial_json };
            }
            break;
          }
          case "content_block_stop": {
            if (currentToolId !== null) {
              yield { type: "tool_call_end", id: currentToolId };
              currentToolId = null;
            }
            break;
          }
          case "message_delta": {
            const usage: LLMUsage | null = event.usage
              ? {
                  inputTokens: 0, // message_delta.usage 仅含 output_tokens，input 在 message_start
                  outputTokens: event.usage.output_tokens,
                }
              : null;
            yield {
              type: "message_end",
              stopReason: event.delta.stop_reason ?? null,
              usage,
            };
            break;
          }
          default:
            // message_start / message_stop / ping 等事件不产生上层增量
            break;
        }
      }
    } catch (e) {
      // 流式错误归一化为 error 事件（不抛出，让上层统一处理）
      yield { type: "error", error: e instanceof Error ? e : new Error(String(e)) };
    }
  }

  // --------------------------------------------------------------------------
  // 私有实现
  // --------------------------------------------------------------------------

  /** 延迟初始化 SDK 客户端（beta features 经 defaultHeaders 注入） */
  private getSdk(): Anthropic {
    if (!this.sdk) {
      const headers: Record<string, string> = {};
      if (this.betaFeatures.length > 0) {
        headers["anthropic-beta"] = this.betaFeatures.join(",");
      }
      this.sdk = new Anthropic({
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        defaultHeaders: headers,
      });
    }
    return this.sdk;
  }

  /** 非流式响应解析：content 块分类聚合 */
  private parseResponse(message: Anthropic.Message): LLMResponse {
    let content = "";
    let thinking = "";
    const toolCalls: LLMToolCall[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "thinking") {
        thinking += block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          argumentsJson: JSON.stringify(block.input),
        });
      }
    }

    const usage: LLMUsage | null = message.usage
      ? {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: message.usage.cache_read_input_tokens ?? undefined,
        }
      : null;

    return {
      content,
      thinking,
      toolCalls,
      stopReason: message.stop_reason ?? null,
      usage,
    };
  }
}
