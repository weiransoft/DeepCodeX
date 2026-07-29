import chalk from "chalk";
import { renderMessageToStdout } from "../components/MessageView/utils";
import type { RawMode } from "../contexts";
import type { PromptDraft } from "../views/PromptInput";
import type { ModelConfigSelection } from "@vegamo/deepcode-core";
import type { SessionEntry, SessionMessage } from "@vegamo/deepcode-core";
import type { SessionManager } from "@vegamo/deepcode-core";

/**
 * Render all messages directly to stdout for Raw mode display.
 * Writes each message followed by the "Press ESC to exit raw mode" footer.
 */
export function renderRawModeMessages(allMessages: SessionMessage[], mode: string | RawMode): void {
  for (const msg of allMessages) {
    process.stdout.write("\n");
    process.stdout.write(renderMessageToStdout(msg, mode as RawMode) + "\n\n");
  }
  if (allMessages.length > 0) {
    process.stdout.write("\n\n");
    process.stdout.write(chalk.dim("Press ESC to exit raw mode"));
  } else {
    process.stdout.write("\n");
    process.stdout.write(chalk.dim("(No messages in this session yet. Start chatting to see them here.)"));
    process.stdout.write("\n\n");
    process.stdout.write(chalk.dim("Press ESC to exit raw mode"));
  }
}

export function buildSyntheticUserMessage(content: string, imageCount: number): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `local-${Math.random().toString(36).slice(2)}`,
    sessionId: "local",
    role: "user",
    content,
    contentParams:
      imageCount > 0
        ? Array.from({ length: imageCount }, () => ({
            type: "image_url",
            image_url: { url: "" },
          }))
        : null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

/**
 * 构造合成助手消息
 *
 * 用于在 TUI 中显示命令执行结果（如 /rules list 的输出），
 * 不走完整 LLM 流程，仅用于本地命令的输出展示。
 *
 * @param content 助手消息内容
 * @returns SessionMessage（role=assistant）
 */
export function buildSyntheticAssistantMessage(content: string): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `local-assistant-${Math.random().toString(36).slice(2)}`,
    sessionId: "local",
    role: "assistant",
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

export function buildPromptDraftFromSessionMessage(message: SessionMessage, nonce: number): PromptDraft {
  return {
    nonce,
    text: typeof message.content === "string" ? message.content : "",
    imageUrls: extractImageUrlsFromContentParams(message.contentParams),
  };
}

export function extractImageUrlsFromContentParams(contentParams: unknown): string[] {
  const params = Array.isArray(contentParams) ? contentParams : contentParams ? [contentParams] : [];
  const imageUrls: string[] = [];
  for (const param of params) {
    if (!param || typeof param !== "object") {
      continue;
    }
    const record = param as { type?: unknown; image_url?: { url?: unknown } };
    const url = record.image_url?.url;
    if (record.type === "image_url" && typeof url === "string" && url) {
      imageUrls.push(url);
    }
  }
  return imageUrls;
}

export function isCurrentSessionEmpty(sessionManager: SessionManager): boolean {
  const activeSessionId = sessionManager.getActiveSessionId();
  return !activeSessionId || !sessionManager.getSession(activeSessionId);
}

export type BuildStatusLineOptions = {
  /** 当前模型名称（如 deepseek-v4-pro） */
  model?: string;
  /** 模型最大上下文窗口 token 数，用于计算 token 占比 */
  maxContextTokens?: number;
};

/**
 * 构造 TUI 底部状态栏文本。
 *
 * FIX-19（多角色审查 2026-07-29）：在原有 status / tokens / fail 基础上，
 * 补充当前模型名与 token 占比，使状态栏信息更丰富。
 *
 * @param entry 当前会话状态
 * @param options 可选的模型与上下文窗口信息
 * @returns 状态栏字符串，各段以 " · " 连接
 */
export function buildStatusLine(entry: SessionEntry, options?: BuildStatusLineOptions): string {
  const parts: string[] = [];
  parts.push(`status: ${entry.status}`);

  // 模型名：优先使用调用方传入的当前设置，若未提供则尝试从 usagePerModel 推断
  const modelName = options?.model ?? inferModelName(entry);
  if (modelName) {
    parts.push(`model: ${modelName}`);
  }

  // token 信息：显示当前活跃 token 数与占比（在已知最大上下文窗口时）
  if (typeof entry.activeTokens === "number" && entry.activeTokens > 0) {
    const maxTokens = options?.maxContextTokens ?? 0;
    if (maxTokens > 0) {
      const ratio = Math.min(100, Math.max(0, (entry.activeTokens / maxTokens) * 100));
      parts.push(
        `tokens: ${entry.activeTokens.toLocaleString("en-US")} / ${maxTokens.toLocaleString("en-US")} (${ratio.toFixed(1)}%)`
      );
    } else {
      parts.push(`tokens: ${entry.activeTokens.toLocaleString("en-US")}`);
    }
  }

  if (entry.failReason) {
    parts.push(`fail: ${entry.failReason}`);
  }
  return parts.join(" · ");
}

/**
 * 从 usagePerModel 推断模型名。
 *
 * 若 usagePerModel 仅含一个模型，直接返回该模型名；
 * 若含多个模型，返回 "multi(<count>)"；若为空则返回空字符串。
 *
 * @param entry 当前会话状态
 * @returns 推断出的模型名或空字符串
 */
function inferModelName(entry: SessionEntry): string {
  const models = entry.usagePerModel ? Object.keys(entry.usagePerModel) : [];
  if (models.length === 1) {
    return models[0]!;
  }
  if (models.length > 1) {
    return `multi(${models.length})`;
  }
  return "";
}

export function formatThinkingMode(
  settings: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">
): string {
  if (!settings.thinkingEnabled) {
    return "no thinking";
  }
  return `thinking ${settings.reasoningEffort}`;
}

export function formatModelConfig(settings: ModelConfigSelection): string {
  return `${settings.model}, ${formatThinkingMode(settings)}`;
}
