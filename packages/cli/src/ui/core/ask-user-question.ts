import type { SessionMessage, SessionStatus } from "@vegamo/deepcode-core";

export type AskUserQuestionOption = {
  label: string;
  description?: string;
};

export type AskUserQuestionItem = {
  question: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
};

/**
 * 建议命令（与核心层 ask-user-question-handler.ts 同构）
 *
 * 用于在用户回答 AskUserQuestion 后自动注入执行下一条 slash 命令。
 */
export type SuggestedCommand = {
  /** 完整命令字符串（必须以 / 开头） */
  readonly command: string;
  /** 命令来源说明（可选，用于 UI 显示） */
  readonly reason?: string;
};

export type PendingAskUserQuestion = {
  messageId: string;
  sessionId: string;
  questions: AskUserQuestionItem[];
  /** 可选：用户回答后自动执行的命令 */
  readonly suggestedCommand?: SuggestedCommand;
};

export type AskUserQuestionAnswers = Record<string, string>;

export function findPendingAskUserQuestion(
  messages: SessionMessage[],
  status: SessionStatus | null
): PendingAskUserQuestion | null {
  if (status !== "waiting_for_user") {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool" || message.visible === false) {
      continue;
    }
    // 解析完整内容（questions + suggestedCommand）
    const parsed = parsePendingAskUserQuestion(message.content);
    if (parsed.questions.length === 0) {
      continue;
    }
    return {
      messageId: message.id,
      sessionId: message.sessionId,
      questions: parsed.questions,
      ...(parsed.suggestedCommand ? { suggestedCommand: parsed.suggestedCommand } : {}),
    };
  }

  return null;
}

export function formatAskUserQuestionAnswers(answers: AskUserQuestionAnswers): string {
  const answersText = Object.entries(answers)
    .map(([question, answer]) => `"${escapeAnswerPart(question)}"="${escapeAnswerPart(answer)}"`)
    .join(", ");
  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}

export function formatAskUserQuestionDecline(): string {
  return "The user declined to answer the questions. Continue with the available context, or ask again if the information is required.";
}

/**
 * 解析 PendingAskUserQuestion 完整内容（questions + suggestedCommand）
 *
 * @param content 工具消息的 content 字段（JSON 字符串）
 * @returns 包含 questions 数组和可选 suggestedCommand 的解析结果；
 *          格式错误或字段缺失时返回 { questions: [] }（降级安全）
 */
function parsePendingAskUserQuestion(content: string | null): {
  questions: AskUserQuestionItem[];
  suggestedCommand?: SuggestedCommand;
} {
  if (!content) {
    return { questions: [] };
  }

  try {
    const parsed = JSON.parse(content) as {
      awaitUserResponse?: unknown;
      metadata?: {
        kind?: unknown;
        questions?: unknown;
        suggestedCommand?: unknown;
      } | null;
    };
    if (parsed.awaitUserResponse !== true) {
      return { questions: [] };
    }
    const metadata = parsed.metadata;
    if (!metadata || metadata.kind !== "ask_user_question") {
      return { questions: [] };
    }
    return {
      questions: normalizeQuestions(metadata.questions),
      suggestedCommand: normalizeSuggestedCommand(metadata.suggestedCommand),
    };
  } catch {
    return { questions: [] };
  }
}

/**
 * 允许的 suggestedCommand 命令名白名单
 *
 * 与核心层 ask-user-question-handler.ts 的 ALLOWED_SUGGESTED_COMMAND_NAMES 严格对齐，
 * 作为防御性编程的第二道防线（核心层在工具调用阶段已过滤，CLI 层在解析消息时再次校验）。
 *
 * 安全策略：只允许"读取/调度类"命令自动执行，禁止"会话控制类"命令。
 * - 允许：team 系列（多角色调度，只读 + 子任务派发）
 * - 允许：EAG 系列（企业应用生成，前瞻性扩展）
 * - 拒绝：exit / undo / new / inject / bg / cancel / pause / raw / mcp / memory / rules 等
 *   理由：这些命令可能中断会话、撤销操作、注入恶意指令或修改全局配置，
 *         不应被 LLM 通过 suggestedCommand 自动触发。
 */
const ALLOWED_SUGGESTED_COMMAND_NAMES = new Set<string>([
  // 多角色团队命令（/team /architect /pm /coder /tester /ui）
  "team",
  "architect",
  "pm",
  "coder",
  "tester",
  "ui",
  // EAG 命令（前瞻性扩展，当前可能未注册到 BUILTIN_SLASH_COMMANDS）
  "eag-build",
  "eag-design",
  "eag-test",
  "eag-run",
  "eag-deploy",
]);

/**
 * 解析并校验 suggestedCommand 字段（与核心层 parseSuggestedCommand 同构）
 *
 * 安全约束：
 * - command 必须是字符串且非空
 * - command 必须以 "/" 开头（仅允许 slash 命令）
 * - command 首个 token 必须命中 ALLOWED_SUGGESTED_COMMAND_NAMES 白名单
 *   （防止 LLM 注入 exit/undo/new/inject/bg 等会话控制类命令）
 * - reason 是可选字符串
 *
 * @param raw 原始输入值
 * @returns 解析后的 SuggestedCommand，或 undefined（格式错误或不在白名单时降级）
 */
function normalizeSuggestedCommand(raw: unknown): SuggestedCommand | undefined {
  // 非对象或数组直接拒绝
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const command = (raw as { command?: unknown }).command;
  if (typeof command !== "string") {
    return undefined;
  }
  const trimmedCommand = command.trim();
  // 安全约束 1：command 不能为空且必须以 / 开头
  if (trimmedCommand.length === 0 || !trimmedCommand.startsWith("/")) {
    return undefined;
  }
  // 安全约束 2：白名单校验 —— 只允许特定命令种类自动执行
  // 提取首个 token（如 "/team dispatch ..." → "/team"），去除 "/" 得到命令名（如 "team"）
  const firstToken = trimmedCommand.split(/\s+/, 1)[0];
  if (!firstToken) {
    return undefined;
  }
  const commandName = firstToken.slice(1);
  if (!commandName || !ALLOWED_SUGGESTED_COMMAND_NAMES.has(commandName)) {
    // 命令不在白名单中（如 "/exit"、"/undo"、"/inject" 等），拒绝自动执行
    return undefined;
  }
  const reason = (raw as { reason?: unknown }).reason;
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  return {
    command: trimmedCommand,
    ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
  };
}

function normalizeQuestions(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: AskUserQuestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const question =
      typeof (item as { question?: unknown }).question === "string"
        ? (item as { question: string }).question.trim()
        : "";
    const rawOptions = (item as { options?: unknown }).options;
    if (!question || !Array.isArray(rawOptions) || rawOptions.length === 0) {
      continue;
    }
    const options: AskUserQuestionOption[] = rawOptions
      .map((option) => normalizeOption(option))
      .filter((option): option is AskUserQuestionOption => Boolean(option));
    if (options.length === 0) {
      continue;
    }
    const multiSelect =
      typeof (item as { multiSelect?: unknown }).multiSelect === "boolean"
        ? (item as { multiSelect: boolean }).multiSelect
        : undefined;
    questions.push({ question, multiSelect, options });
  }
  return questions;
}

function normalizeOption(raw: unknown): AskUserQuestionOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const label = typeof (raw as { label?: unknown }).label === "string" ? (raw as { label: string }).label.trim() : "";
  if (!label) {
    return null;
  }
  const description =
    typeof (raw as { description?: unknown }).description === "string"
      ? (raw as { description: string }).description.trim()
      : "";
  return {
    label,
    description: description || undefined,
  };
}

function escapeAnswerPart(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}
