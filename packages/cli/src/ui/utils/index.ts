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
 * fork 特性：构造合成助手消息
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

/**
 * 上游 v0.3.1 新增：从会话消息中提取可见且非空的用户输入历史。
 *
 * 仅保留 role=user、visible=true 且内容为非空字符串的消息，
 * 用于会话恢复（--resume/--fork）时的 prompt 历史预填充。
 *
 * @param messages 会话消息列表
 * @returns 去除首尾空白后的用户输入文本数组
 */
export function buildPromptHistory(messages: SessionMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user" && message.visible && typeof message.content === "string")
    .map((message) => (message.content ?? "").trim())
    .filter((content) => content.length > 0);
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
  /** 模型最大上下文窗口 token 数，用于计算 token 占比（fork 调用形态） */
  maxContextTokens?: number;
  /** 是否开启思考模式（上游 v0.3.1 settings 调用形态） */
  thinkingEnabled?: boolean;
  /** 思考强度（上游 v0.3.1 settings 调用形态） */
  reasoningEffort?: string;
  /** 上下文窗口大小（上游 v0.3.1 settings 调用形态），大于 0 时以进度条展示 token 占用 */
  contextWindow?: number;
};

/**
 * 构造 TUI 底部状态栏文本。
 *
 * 合并 fork 与上游 v0.3.1 两种调用形态：
 * - fork 形态：{ model?, maxContextTokens? } → 输出 "model: xxx" 与 "tokens: a / b (x%)"
 *   （未传 model 时会从 usagePerModel 推断）
 * - 上游 v0.3.1 形态：{ contextWindow, model, thinkingEnabled, reasoningEffort }
 *   → 输出上下文进度条与 "model effort"（无 "model:" 前缀，空模型名整段省略）
 *
 * 通过是否显式传入 thinkingEnabled / contextWindow 区分两种形态，
 * 两种既有调用方与测试用例均保持兼容。
 *
 * @param entry 当前会话状态
 * @param options 可选的模型与上下文窗口信息
 * @returns 状态栏字符串，各段以 " · " 连接
 */
export function buildStatusLine(entry: SessionEntry, options?: BuildStatusLineOptions): string {
  const parts: string[] = [];
  parts.push(`status: ${entry.status}`);

  // token 段：优先使用上游 v0.3.1 的进度条形式（contextWindow > 0 时）；
  // 否则回退到 fork 的百分比形式或纯 token 数展示。
  if (typeof entry.activeTokens === "number" && entry.activeTokens > 0) {
    const contextWindow = options?.contextWindow ?? 0;
    if (contextWindow > 0) {
      // 上游 v0.3.1：进度条形式（如 550/8192 [▓▓▓▓▓▓░░░░] 55%）
      parts.push(formatContextUsage(entry.activeTokens, contextWindow));
    } else {
      // fork：百分比占比形式
      const maxTokens = options?.maxContextTokens ?? 0;
      if (maxTokens > 0) {
        const ratio = Math.min(100, Math.max(0, (entry.activeTokens / maxTokens) * 100));
        parts.push(
          `tokens: ${entry.activeTokens.toLocaleString("en-US")} / ${maxTokens.toLocaleString("en-US")} (${ratio.toFixed(1)}%)`
        );
      } else {
        // fork：仅显示当前活跃 token 数
        parts.push(`tokens: ${entry.activeTokens.toLocaleString("en-US")}`);
      }
    }
  }

  // 模型段：显式传入 thinkingEnabled（上游形态）时使用 "model effort" 格式；
  // 否则（fork 形态）输出 "model: xxx"，model 未传时从 usagePerModel 推断。
  const rawModel = options?.model ?? inferModelName(entry);
  const model = rawModel.trim();
  if (model) {
    if (options?.thinkingEnabled !== undefined) {
      // 上游 v0.3.1 格式：无前缀，思考开启时追加 reasoning effort
      parts.push(options.thinkingEnabled ? `${model} ${options.reasoningEffort}` : model);
    } else {
      // fork 格式：带 model: 前缀
      parts.push(`model: ${model}`);
    }
  }

  if (entry.failReason) {
    parts.push(`fail: ${entry.failReason}`);
  }
  return parts.join(" · ");
}

/**
 * fork 特有：从 usagePerModel 推断模型名。
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

// 进度条宽度（上游 v0.3.1）：上下文占用条共 10 格
const CONTEXT_BAR_WIDTH = 10;

/**
 * 上游 v0.3.1 新增：将 token 数格式化为人类可读形式。
 *
 * 小于 1024 显示整数；1024~1M 显示 K；超过 1M 显示 M，最多保留一位小数。
 *
 * @param tokens token 数量
 * @returns 格式化后的字符串（如 "1.1K"、"1.3M"）
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens < 1024) {
    return String(Math.round(tokens));
  }

  const unit = tokens >= 1024 * 1024 ? "M" : "K";
  const divisor = unit === "M" ? 1024 * 1024 : 1024;
  return `${Number((tokens / divisor).toFixed(1))}${unit}`;
}

/**
 * 上游 v0.3.1 新增：格式化上下文占用展示文本。
 *
 * 形如 "550/8192 [▓▓▓▓▓▓░░░░] 55%"，条与百分比均封顶 100%。
 *
 * @param activeTokens 当前活跃 token 数
 * @param contextWindow 上下文窗口大小
 * @returns 进度条文本
 */
export function formatContextUsage(activeTokens: number, contextWindow: number): string {
  const safeActiveTokens = Number.isFinite(activeTokens) ? Math.max(0, activeTokens) : 0;
  const ratio = Number.isFinite(contextWindow) && contextWindow > 0 ? safeActiveTokens / contextWindow : 0;
  const cappedRatio = Math.min(1, ratio);
  const filledBlocks = Math.round(cappedRatio * CONTEXT_BAR_WIDTH);
  const bar = `${"▓".repeat(filledBlocks)}${"░".repeat(CONTEXT_BAR_WIDTH - filledBlocks)}`;
  const percent = Math.min(100, Math.round(ratio * 100));
  return `${formatTokenCount(safeActiveTokens)}/${formatTokenCount(contextWindow)} [${bar}] ${percent}%`;
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
