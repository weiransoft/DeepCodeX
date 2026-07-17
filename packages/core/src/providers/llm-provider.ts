/**
 * LLM Provider 统一接口层（原生 Claude API 支持 · 核心抽象）
 *
 * 设计依据：docs/superpowers/specs/2026-07-17-claude-native-support-design.md §2
 * - 双协议共存：OpenAI 与 Anthropic 各自实现 LLMProvider，运行时按 settings 路由
 * - 上层（session.ts / edit-handler 等）只依赖本接口，不感知协议差异
 * - 消息/工具/流式事件在各 provider 内部完成转换
 *
 * @module providers/llm-provider
 */

import type { SessionMessage } from "../session";
import type { ResolvedDeepcodingSettings } from "../settings";

/** Provider 标识 */
export type ProviderName = "openai" | "anthropic";

/** 内部统一工具定义（与协议无关，字段对齐 OpenAI 风格，由 provider 负责转换） */
export interface LLMToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema 对象（OpenAI parameters / Claude input_schema 同源） */
  parameters: Record<string, unknown>;
}

/** 内部统一请求（provider 无关） */
export interface LLMRequest {
  /** 完整会话消息（内部 SessionMessage 形态，含 tool/compact 标记） */
  messages: SessionMessage[];
  /** 工具定义（可选） */
  tools?: LLMToolDefinition[];
  /** 是否启用思考模式（DeepSeek thinking / Claude extended thinking） */
  thinkingEnabled: boolean;
  /** 最大输出 token 数（Claude 必填，OpenAI 可选） */
  maxTokens?: number;
  /** 采样温度（仅 OpenAI 生效；Claude 忽略并告警，由 provider 内部处理） */
  temperature?: number;
  /** 中止信号 */
  signal?: AbortSignal | null;
}

/** 统一工具调用结果（assistant 侧） */
export interface LLMToolCall {
  id: string;
  name: string;
  /** JSON 字符串（与 OpenAI arguments 对齐；Claude input 对象序列化而来） */
  argumentsJson: string;
}

/** token 用量（统一字段，cache 相关仅 Anthropic 可能非空） */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** 非流式统一响应 */
export interface LLMResponse {
  /** 文本内容（无文本时为空串） */
  content: string;
  /** 思考内容（thinking/reasoning_content，未启用时为空串） */
  thinking: string;
  /** 工具调用列表 */
  toolCalls: LLMToolCall[];
  /** 结束原因（透传协议原值，如 stop/end_turn/tool_use/max_tokens） */
  stopReason: string | null;
  usage: LLMUsage | null;
}

/** 流式事件类型（两协议归一化） */
export type LLMStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsJsonDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "message_end"; stopReason: string | null; usage: LLMUsage | null }
  | { type: "error"; error: Error };

/** Provider 客户端（单次会话级，线程不安全的配置快照） */
export interface LLMClient {
  readonly providerName: ProviderName;
  readonly model: string;
  readonly baseURL: string;
  readonly supportsThinking: boolean;
  readonly supportsPromptCaching: boolean;

  /** 非流式调用（background summarization / edit-handler 等场景） */
  createMessage(request: LLMRequest): Promise<LLMResponse>;

  /** 流式调用（主对话场景），产出归一化事件流 */
  createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}

/** Provider 工厂接口 */
export interface LLMProvider {
  readonly name: ProviderName;
  createClient(settings: ResolvedDeepcodingSettings): LLMClient;
}
