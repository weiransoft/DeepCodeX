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
 * 参数级路径选项黑名单。
 *
 * P0 安全修复：与核心层 ask-user-question-handler.ts 保持一致，
 * 禁止 LLM 通过 suggestedCommand 的参数把文件路径指向项目外。
 */
const FORBIDDEN_PATH_OPTION_NAMES = new Set<string>(["--task-file", "--task_file", "--project-root", "--project_root"]);

/**
 * Shell 元字符黑名单。
 *
 * 禁止出现在 suggestedCommand 中，防止通过 shell 解释器执行任意命令。
 */
const SHELL_METACHAR_PATTERN = /[;&|<>()`$\\]/;

/**
 * 解析并校验 suggestedCommand 字段（与核心层 parseSuggestedCommand 同构）
 *
 * 安全约束：
 * - command 必须是字符串且非空
 * - command 必须以 "/" 开头（仅允许 slash 命令）
 * - command 首个 token 必须命中 ALLOWED_SUGGESTED_COMMAND_NAMES 白名单
 *   （防止 LLM 注入 exit/undo/new/inject/bg 等会话控制类命令）
 * - command 参数必须通过参数沙箱校验（禁止绝对路径、~ 展开、路径穿越等）
 * - reason 是可选字符串
 *
 * @param raw 原始输入值
 * @returns 解析后的 SuggestedCommand，或 undefined（格式错误、不在白名单或参数沙箱失败时降级）
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

  // P0 安全修复：CLI 层第二道参数沙箱（无 projectRoot 时拒绝绝对路径）
  const sandbox = validateSuggestedCommandArgs(trimmedCommand);
  if (!sandbox.ok) {
    return undefined;
  }

  const reason = (raw as { reason?: unknown }).reason;
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  return {
    command: trimmedCommand,
    ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
  };
}

/**
 * 将命令字符串拆分为 token 数组（支持单/双引号）。
 *
 * @param command 原始命令字符串
 * @returns token 数组；引号未闭合时返回 null
 */
function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * 去除字符串首尾的成对引号。
 *
 * @param value 原始 token
 * @returns 去除引号后的值
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 校验单个路径参数是否合法（CLI 层无 projectRoot，因此拒绝所有绝对路径）。
 *
 * 规则：
 * - 禁止含 ".." 的路径穿越
 * - 禁止以 "~" 开头的 home 目录展开
 * - 拒绝所有绝对路径（以 "/" 开头）
 *
 * @param value 路径字符串
 * @returns 非法时返回原因，否则返回 null
 */
function checkPathValue(value: string): string | null {
  if (value.length === 0) {
    return "路径不能为空";
  }
  if (value.includes("..")) {
    return "路径包含 ..（路径穿越）";
  }
  if (value.startsWith("~")) {
    return "路径以 ~ 开头（home 目录展开）";
  }
  if (value.startsWith("/")) {
    return "绝对路径不被允许";
  }
  return null;
}

/**
 * suggestedCommand 参数沙箱校验（CLI 层第二道防线）。
 *
 * P0 安全修复：
 * - 拒绝含 shell 元字符的命令字符串
 * - 拒绝 FORBIDDEN_PATH_OPTION_NAMES 中列出的选项指向非法路径
 * - 拒绝任何以 "/"、"~" 开头或含 ".." 的参数 token
 *
 * @param command 已 trim 的命令字符串
 * @returns 校验结果，失败时携带原因
 */
function validateSuggestedCommandArgs(command: string): { ok: true } | { ok: false; reason: string } {
  if (SHELL_METACHAR_PATTERN.test(command)) {
    return { ok: false, reason: "命令包含非法 shell 元字符" };
  }

  const tokens = tokenizeCommand(command);
  if (tokens === null) {
    return { ok: false, reason: "命令引号未闭合" };
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const rawValue = stripQuotes(token);

    // 跳过命令名本身（首个 token，如 "/team"）
    if (index === 0) {
      continue;
    }

    // 处理 --option=value 形式
    let optionName = rawValue;
    let value: string | undefined;
    const eqIndex = rawValue.indexOf("=");
    if (eqIndex !== -1) {
      optionName = rawValue.slice(0, eqIndex);
      value = rawValue.slice(eqIndex + 1);
    }

    if (FORBIDDEN_PATH_OPTION_NAMES.has(optionName)) {
      const pathValue = value !== undefined ? value : tokens[index + 1];
      if (pathValue === undefined) {
        return { ok: false, reason: `选项 ${optionName} 缺少值` };
      }
      const pathError = checkPathValue(stripQuotes(pathValue));
      if (pathError) {
        return { ok: false, reason: `${optionName} 指向非法路径：${pathError}` };
      }
      // 若值在下一个 token，跳过该 token
      if (value === undefined) {
        index += 1;
      }
      continue;
    }

    // 全局拒绝任何看起来像绝对路径、home 展开或路径穿越的 token
    if (rawValue.startsWith("/") || rawValue.startsWith("~") || rawValue.includes("..")) {
      return { ok: false, reason: `命令参数包含非法路径：${rawValue}` };
    }
  }

  return { ok: true };
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
