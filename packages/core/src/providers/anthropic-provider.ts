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
  /** 请求/流式调用超时（毫秒），与 OpenAI 侧 settings.timeout 对齐 */
  private readonly timeout: number;
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
    // settings.timeout 单位为秒，Anthropic SDK timeout 字段单位为毫秒；
    // 缺省时与 OpenAI 侧默认 600s 保持一致，避免无 timeout 导致 LLM 长期无响应。
    this.timeout = settings.timeout > 0 ? settings.timeout * 1000 : 600_000;
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
    // 流式 usage 聚合状态（M2）：Anthropic 的 input/cache 用量在 message_start 给出，
    // message_delta.usage 仅携带 output_tokens，需暂存后在 message_end 合并发出完整 LLMUsage
    let startUsage: {
      inputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    } | null = null;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start": {
            // 暂存 message_start 携带的 input/cache 用量，供 message_delta 合并
            const usage = event.message.usage;
            startUsage = {
              inputTokens: usage.input_tokens,
              ...(usage.cache_creation_input_tokens != null
                ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
                : {}),
              ...(usage.cache_read_input_tokens != null ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {}),
            };
            break;
          }
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
            // M2：合并 message_start 暂存的 input/cache 用量与 message_delta 的 output_tokens。
            // input/cache 字段优先取 message_delta 自带值（SDK 类型允许为空），缺省回落 message_start 暂存值；
            // 两者均缺失（异常事件序列）时 inputTokens 回退 0，保持与原硬编码行为一致的兜底。
            const deltaUsage = event.usage;
            const usage: LLMUsage | null = deltaUsage
              ? {
                  inputTokens: deltaUsage.input_tokens ?? startUsage?.inputTokens ?? 0,
                  outputTokens: deltaUsage.output_tokens,
                  cacheCreationInputTokens:
                    deltaUsage.cache_creation_input_tokens ?? startUsage?.cacheCreationInputTokens ?? undefined,
                  cacheReadInputTokens:
                    deltaUsage.cache_read_input_tokens ?? startUsage?.cacheReadInputTokens ?? undefined,
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
            // message_stop / ping 等事件不产生上层增量（message_start 已在上方分支暂存 usage）
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
        timeout: this.timeout,
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
