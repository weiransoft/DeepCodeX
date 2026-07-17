/**
 * Anthropic 消息转换器（原生 Claude API 支持 · 消息层）
 *
 * 职责：内部 SessionMessage[] → Claude Messages API 的 { system, messages } 结构。
 *
 * 核心差异处理（设计文档 §4）：
 * 1. system 提取：Claude 要求 system 为顶层参数而非首条消息；
 * 2. 角色交替：Claude 强制 user/assistant 交替，连续同角色自动合并（\n\n 连接）；
 * 3. 工具调用：assistant.tool_calls → content[].type="tool_use"；
 * 4. 工具结果：role="tool" → role="user" + content[].type="tool_result"；
 * 5. compacted 过滤：与 OpenAI converter 行为对齐。
 *
 * @module providers/anthropic-converter
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SessionMessage } from "../session";

/** 转换产出：顶层 system + 交替对话 */
export interface AnthropicMessageBundle {
  system?: string;
  messages: Anthropic.MessageParam[];
}

export class AnthropicMessageConverter {
  /**
   * 构建 Claude 消息体
   *
   * @param messages 内部会话消息（含 system/user/assistant/tool）
   * @param thinkingEnabled 是否启用 extended thinking（影响 assistant thinking 块透传）
   * @param model 目标模型（保留参数，供未来按模型能力分支，与 OpenAI converter 签名对齐）
   */
  buildMessages(messages: SessionMessage[], thinkingEnabled: boolean, model: string): AnthropicMessageBundle {
    void thinkingEnabled; // thinking 块由 provider 请求级参数控制，此处不干预内容层
    void model;

    const active = messages.filter((m) => !m.compacted);

    // 1. 提取首条 system 消息为顶层参数（其余 system 按普通文本并入对话，防信息丢失）
    let system: string | undefined;
    const rest: SessionMessage[] = [];
    let systemExtracted = false;
    for (const m of active) {
      if (!systemExtracted && m.role === "system" && typeof m.content === "string") {
        system = m.content;
        systemExtracted = true;
        continue;
      }
      rest.push(m);
    }

    // 2. 逐条转换（tool 角色转 user + tool_result 块）
    const converted: Anthropic.MessageParam[] = [];
    for (const m of rest) {
      converted.push(this.convertOne(m));
    }

    // 3. 合并连续同角色（Claude 强制 user/assistant 交替）
    const merged = this.mergeConsecutive(converted);

    return { system, messages: merged };
  }

  /**
   * 工具定义转换：内部 LLMToolDefinition → Claude Tool（input_schema 透传）
   */
  buildTools(
    tools: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>
  ): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  // --------------------------------------------------------------------------
  // 私有实现
  // --------------------------------------------------------------------------

  /** 单条消息转换（system 已由上层提取，此处仅处理 user/assistant/tool） */
  private convertOne(m: SessionMessage): Anthropic.MessageParam {
    if (m.role === "tool") {
      // tool 结果 → user 消息 + tool_result 块
      const toolCallId = this.extractToolCallId(m);
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: typeof m.content === "string" ? m.content : "",
          } as Anthropic.ToolResultBlockParam,
        ],
      };
    }

    if (m.role === "assistant") {
      const toolCalls = this.extractToolCalls(m);
      if (toolCalls.length > 0) {
        // assistant 带工具调用：content 为块数组（text 可选 + tool_use 块）
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (typeof m.content === "string" && m.content.trim().length > 0) {
          blocks.push({ type: "text", text: m.content });
        }
        for (const tc of toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: this.parseArguments(tc.argumentsJson),
          } as Anthropic.ToolUseBlockParam);
        }
        return { role: "assistant", content: blocks };
      }
      return { role: "assistant", content: typeof m.content === "string" ? m.content : "" };
    }

    // user 与残留 system（非首条）按纯文本处理
    return { role: "user", content: typeof m.content === "string" ? m.content : "" };
  }

  /** 合并连续同角色消息（纯文本以 \n\n 连接；含块数组时展平拼接块） */
  private mergeConsecutive(list: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    for (const m of list) {
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) {
        prev.content = this.concatContent(prev.content, m.content);
        continue;
      }
      out.push({ ...m });
    }
    return out;
  }

  /** content 拼接：双方均为纯文本时以 \n\n 连接（保持字符串形态）；含块数组时统一转块数组后展平 */
  private concatContent(
    a: string | Anthropic.ContentBlockParam[],
    b: string | Anthropic.ContentBlockParam[]
  ): string | Anthropic.ContentBlockParam[] {
    // 纯文本 + 纯文本：以 \n\n 连接（Claude 交替合并场景的文本拼接语义）
    if (typeof a === "string" && typeof b === "string") {
      return `${a}\n\n${b}`;
    }
    const toBlocks = (c: string | Anthropic.ContentBlockParam[]): Anthropic.ContentBlockParam[] =>
      typeof c === "string" ? [{ type: "text", text: c }] : c;
    return [...toBlocks(a), ...toBlocks(b)];
  }

  /** 从 tool 消息的 messageParams 提取 tool_call_id（容错：缺失时给占位，上游配对逻辑保证存在） */
  private extractToolCallId(m: SessionMessage): string {
    const params = m.messageParams as Record<string, unknown> | null;
    const id = params?.["tool_call_id"];
    return typeof id === "string" && id.length > 0 ? id : "unknown_tool_call";
  }

  /** 从 assistant 消息提取工具调用列表（兼容 OpenAI messageParams.tool_calls 形态） */
  private extractToolCalls(m: SessionMessage): Array<{ id: string; name: string; argumentsJson: string }> {
    const params = m.messageParams as Record<string, unknown> | null;
    const raw = params?.["tool_calls"];
    if (!Array.isArray(raw)) return [];
    const out: Array<{ id: string; name: string; argumentsJson: string }> = [];
    for (const item of raw) {
      const tc = item as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (typeof tc.id !== "string" || typeof tc.function?.name !== "string") continue;
      out.push({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: typeof tc.function.arguments === "string" ? tc.function.arguments : "{}",
      });
    }
    return out;
  }

  /** arguments JSON 字符串 → Claude input 对象（解析失败回退空对象，防整条消息作废） */
  private parseArguments(json: string): Record<string, unknown> {
    try {
      const v: unknown = JSON.parse(json);
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
