import type { ChatCompletionMessageParam, ChatCompletionContentPart } from "openai/resources/chat/completions";
import { supportsMultimodal } from "./model-capabilities";
import type { SessionMessage } from "../session";
import type { SessionContextHook, ContextSnippet } from "../v2/integration/session-hook";

export type OpenAIMessageConverterOptions = {
  /** Optional callback to render the /init command prompt template. */
  renderInitPrompt?: () => string;
  /**
   * V2 上下文 hook（可选，V2 未启用时为 undefined）。
   *
   * 设计依据：§9.1 F-04 修复——通过构造函数注入 SessionContextHook，
   * 在 buildMessages 开头同步调用 preBuildContext 拿到上下文片段并注入到 system message。
   * - V2 启用时：contextHook 被注入，buildMessages 调用 preBuildContext 拿 snippets 注入 system message；
   * - V2 未启用时：contextHook 为 undefined，OpenAIMessageConverter 行为与 v1 100% 一致（向后兼容）。
   */
  contextHook?: SessionContextHook;
};

/**
 * Converts internal SessionMessage arrays into OpenAI ChatCompletionMessageParam arrays.
 *
 * Handles:
 * - Tool-call / tool-result pairing with interrupt backfill
 * - Thinking-mode reasoning_content injection
 * - Multimodal content (images) filtering by model capability
 * - Compaction filtering
 */
export class OpenAIMessageConverter {
  constructor(private readonly options: OpenAIMessageConverterOptions = {}) {}

  /**
   * Build the OpenAI messages array from session messages, applying compaction
   * filtering, tool pairing, and format conversion.
   *
   * V2 集成（§9.1 NP-01 修复）：
   * - 在现有逻辑之前同步调用 contextHook.preBuildContext（无 await），保持同步签名不变；
   * - 拿到上下文片段后注入到首条 system message 末尾的"## V2 Context"区块；
   * - contextHook 为 undefined（V2 未启用）或 snippets 为空时，行为与 v1 100% 一致。
   */
  buildMessages(messages: SessionMessage[], thinkingEnabled: boolean, model: string): ChatCompletionMessageParam[] {
    // V2 上下文 hook 注入（同步调用，无 await）
    // NP-01 修复：preBuildContext 为同步方法，保持 buildMessages 同步签名不变
    if (this.options.contextHook) {
      const snippets = this.options.contextHook.preBuildContext(messages);
      if (snippets.length > 0) {
        // 将 snippets 注入到首条 system message（content 为字符串时才注入，
        // 避免 content 为 null 或非字符串时的类型问题）
        const systemMsg = messages.find((m) => m.role === "system");
        if (systemMsg && typeof systemMsg.content === "string") {
          systemMsg.content = this.injectSnippets(systemMsg.content, snippets);
        }
      }
    }

    const activeMessages = messages.filter((message) => !message.compacted);
    const toolPairings = this.pairToolMessages(activeMessages);
    const openAIMessages: ChatCompletionMessageParam[] = [];

    for (let index = 0; index < activeMessages.length; index += 1) {
      const message = activeMessages[index];
      if (message.role === "tool") {
        continue;
      }

      openAIMessages.push(this.convertMessage(message, thinkingEnabled, model));

      const toolCalls = this.getAssistantToolCalls(message);
      if (toolCalls.length === 0) {
        continue;
      }

      for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
        const toolCallId = this.getToolCallId(toolCalls[toolCallIndex]);
        if (!toolCallId) {
          continue;
        }

        const pairedToolIndex = toolPairings.get(this.buildToolPairingKey(index, toolCallIndex));
        if (pairedToolIndex != null) {
          openAIMessages.push(this.convertMessage(activeMessages[pairedToolIndex], thinkingEnabled, model));
          continue;
        }

        openAIMessages.push(this.buildInterruptedOpenAIToolMessage(toolCalls, toolCallId));
      }
    }

    return openAIMessages;
  }

  /**
   * Returns the trailing assistant message with pending (unexecuted) tool calls,
   * if one exists at the end of the conversation.
   */
  getTrailingPendingToolCallMessage(
    messages: SessionMessage[]
  ): { message: SessionMessage; toolCalls: unknown[] } | { message: null; toolCalls: [] } {
    const activeMessages = messages.filter((message) => !message.compacted);
    const latestMessage = activeMessages[activeMessages.length - 1];
    if (!latestMessage || latestMessage.role !== "assistant") {
      return { message: null, toolCalls: [] };
    }

    const toolCalls = this.getAssistantToolCalls(latestMessage);
    if (toolCalls.length === 0) {
      return { message: null, toolCalls: [] };
    }
    return {
      message: latestMessage,
      toolCalls: toolCalls.filter((toolCall) => Boolean(this.getToolCallId(toolCall))),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * 将上下文片段注入到 system message 内容末尾
   *
   * 格式约定（§9.1）：
   * - 在原 system message 内容后追加"## V2 Context"区块标题；
   * - 每个片段以"--- {type}: {source} ---"作为分隔头部，紧随片段内容；
   * - 片段之间以空行分隔，便于 LLM 解析。
   *
   * @param content 原 system message 内容（非空字符串，由调用方保证）
   * @param snippets 上下文片段列表（非空，由调用方保证 length > 0）
   * @returns 拼接后的 system message 内容
   */
  private injectSnippets(content: string, snippets: ContextSnippet[]): string {
    // 每个片段格式："--- {type}: {source} ---" 头部 + 换行 + 片段内容
    const contextBlock = snippets.map((s) => `--- ${s.type}: ${s.source} ---\n${s.content}`).join("\n\n");
    return `${content}\n\n## V2 Context\n\n${contextBlock}`;
  }

  private convertMessage(message: SessionMessage, thinkingEnabled: boolean, model: string): ChatCompletionMessageParam {
    const content = this.renderContent(message);
    const base: ChatCompletionMessageParam = {
      role: message.role,
      content,
    } as ChatCompletionMessageParam;

    const messageParams = message.messageParams as
      | { tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string }
      | null
      | undefined;
    if (messageParams?.tool_calls) {
      (base as { tool_calls?: unknown[] }).tool_calls = messageParams.tool_calls;
    }
    if (messageParams?.tool_call_id) {
      (base as { tool_call_id?: string }).tool_call_id = messageParams.tool_call_id;
    }
    if (typeof messageParams?.reasoning_content === "string") {
      (base as { reasoning_content?: string }).reasoning_content = messageParams.reasoning_content;
    } else if (thinkingEnabled && message.role === "assistant") {
      // Thinking-mode providers require every replayed assistant message
      // to include the reasoning_content field, even when it is empty.
      (base as { reasoning_content?: string }).reasoning_content = "";
    }

    if ((message.role === "user" || message.role === "system") && message.contentParams) {
      const contentParts: ChatCompletionContentPart[] = [];
      if (content) {
        contentParts.push({ type: "text", text: content });
      }
      const params = Array.isArray(message.contentParams) ? message.contentParams : [message.contentParams];
      for (const param of params) {
        const part = param as ChatCompletionContentPart;
        if (part && (part.type !== "image_url" || supportsMultimodal(model))) {
          contentParts.push(part);
        }
      }
      const contentValue: string | ChatCompletionContentPart[] = contentParts.length > 0 ? contentParts : content;
      (base as { content: string | ChatCompletionContentPart[] }).content = contentValue;
    }

    return base;
  }

  private renderContent(message: SessionMessage): string {
    if (message.role === "user" && message.content === "/init") {
      return this.options.renderInitPrompt?.() ?? "";
    }
    return message.content ?? "";
  }

  private pairToolMessages(messages: SessionMessage[]): Map<string, number> {
    const pairings = new Map<string, number>();
    const usedToolMessageIndexes = new Set<number>();

    for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex += 1) {
      const toolCalls = this.getAssistantToolCalls(messages[assistantIndex]);
      for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
        const toolCallId = this.getToolCallId(toolCalls[toolCallIndex]);
        if (!toolCallId) {
          continue;
        }

        const toolIndex = this.findPairableToolMessageIndex(
          messages,
          assistantIndex,
          toolCallId,
          usedToolMessageIndexes
        );
        if (toolIndex == null) {
          continue;
        }

        usedToolMessageIndexes.add(toolIndex);
        pairings.set(this.buildToolPairingKey(assistantIndex, toolCallIndex), toolIndex);
      }
    }

    return pairings;
  }

  private findPairableToolMessageIndex(
    messages: SessionMessage[],
    assistantIndex: number,
    toolCallId: string,
    usedToolMessageIndexes: Set<number>
  ): number | null {
    let firstMatchingIndex: number | null = null;
    for (let index = assistantIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "tool" || usedToolMessageIndexes.has(index)) {
        continue;
      }

      const candidateToolCallId = this.getToolMessageCallId(message);
      if (candidateToolCallId !== toolCallId) {
        continue;
      }

      if (firstMatchingIndex == null) {
        firstMatchingIndex = index;
      }
      if (!this.isInterruptedToolMessage(message)) {
        return index;
      }
    }
    return firstMatchingIndex;
  }

  private getAssistantToolCalls(message: SessionMessage): unknown[] {
    if (message.role !== "assistant") {
      return [];
    }
    const messageParams = message.messageParams as { tool_calls?: unknown[] } | null;
    return Array.isArray(messageParams?.tool_calls) ? messageParams.tool_calls : [];
  }

  private getToolCallId(toolCall: unknown): string | null {
    if (!toolCall || typeof toolCall !== "object") {
      return null;
    }
    const id = (toolCall as { id?: unknown }).id;
    return typeof id === "string" && id ? id : null;
  }

  private getToolMessageCallId(message: SessionMessage): string | null {
    const messageParams = message.messageParams as { tool_call_id?: unknown } | null;
    const toolCallId = messageParams?.tool_call_id;
    return typeof toolCallId === "string" && toolCallId ? toolCallId : null;
  }

  private buildToolPairingKey(assistantIndex: number, toolCallIndex: number): string {
    return `${assistantIndex}:${toolCallIndex}`;
  }

  private isInterruptedToolMessage(message: SessionMessage): boolean {
    if (typeof message.content !== "string" || !message.content.trim()) {
      return false;
    }
    try {
      const parsed = JSON.parse(message.content) as { metadata?: { interrupted?: unknown } };
      return parsed.metadata?.interrupted === true;
    } catch {
      return false;
    }
  }

  private buildInterruptedOpenAIToolMessage(toolCalls: unknown[], toolCallId: string): ChatCompletionMessageParam {
    const toolFunction = this.findToolFunction(toolCalls, toolCallId);
    return {
      role: "tool",
      content: this.buildInterruptedToolResult(toolFunction, "Previous tool call did not complete."),
      tool_call_id: toolCallId,
    } as ChatCompletionMessageParam;
  }

  /** Exposed for use by appendToolMessages in SessionManager. */
  findToolFunction(toolCalls: unknown[], toolCallId: string): unknown | null {
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const record = toolCall as { id?: unknown; function?: unknown };
      if (record.id === toolCallId) {
        return record.function ?? null;
      }
    }
    return null;
  }

  private buildInterruptedToolResult(toolFunction: unknown | null, reason: string): string {
    const toolName =
      toolFunction && typeof toolFunction === "object" && typeof (toolFunction as { name?: unknown }).name === "string"
        ? (toolFunction as { name: string }).name
        : "tool";
    return JSON.stringify(
      {
        ok: false,
        name: toolName,
        error: reason,
        metadata: {
          interrupted: true,
        },
      },
      null,
      2
    );
  }
}
