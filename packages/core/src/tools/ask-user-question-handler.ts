// fork 侧安全修复依赖：path 与 isPathInProject 用于 suggestedCommand 参数沙箱的
// 路径边界校验（禁止 LLM 通过参数把路径指向项目外）
import * as path from "node:path";
import { isPathInProject } from "../common/permissions";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

type AskUserQuestionOption = {
  label: string;
  description?: string;
};

type AskUserQuestionItem = {
  question: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
};

/**
 * 建议命令（用户回答 AskUserQuestion 后自动注入执行）（fork 侧特性）
 *
 * 安全约束：
 * - command 必须以 "/" 开头（仅允许 slash 命令）
 * - command 首个 token 必须命中 ALLOWED_SUGGESTED_COMMAND_NAMES 白名单
 * - command 参数必须通过 validateSuggestedCommandArgs 沙箱校验
 * - reason 为可选说明，用于 UI 显示
 *
 * 类型已导出（export type），便于 CLI 层（ask-user-question.ts）共享同构类型。
 */
export type SuggestedCommand = {
  /** 完整命令字符串（必须以 / 开头，如 "/team dispatch --role architect --task ..."） */
  readonly command: string;
  /** 命令来源说明（可选，用于 UI 显示） */
  readonly reason?: string;
};

type AskUserQuestionMetadata = {
  kind: "ask_user_question";
  questions: AskUserQuestionItem[];
  /** 可选：用户回答后自动执行的命令 */
  readonly suggestedCommand?: SuggestedCommand;
};

/**
 * 允许的 suggestedCommand 命令名白名单（fork 侧安全修复）
 *
 * 安全策略：只允许"读取/调度类"命令自动执行，禁止"会话控制类"命令。
 * - 允许：team 系列（多角色调度，只读 + 子任务派发）
 * - 允许：EAG 系列（企业应用生成，前瞻性扩展，当前可能未在 BUILTIN_SLASH_COMMANDS 中注册）
 * - 拒绝：exit / undo / new / inject / bg / cancel / pause / raw / mcp / memory / rules 等
 *   理由：这些命令可能中断会话、撤销操作、注入恶意指令或修改全局配置，
 *         不应被 LLM 通过 suggestedCommand 自动触发。
 *
 * 注意：此处使用命令名（不含 "/"，如 "team"、"architect"）而非 SlashCommandKind，
 * 因为核心层（core）无法访问 CLI 层的 BUILTIN_SLASH_COMMANDS 常量。
 * 命令名与 packages/cli/src/ui/core/slash-commands.ts 的 SlashCommandItem.name 字段对齐。
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
 * 参数级路径选项黑名单（fork 侧 P0 安全修复）。
 *
 * 禁止 LLM 通过 suggestedCommand 的参数把文件路径指向项目外，
 * 例如 `--task-file /etc/passwd` 或 `--project-root /tmp`。
 */
const FORBIDDEN_PATH_OPTION_NAMES = new Set<string>(["--task-file", "--task_file", "--project-root", "--project_root"]);

/**
 * Shell 元字符黑名单（fork 侧安全修复）。
 *
 * 禁止出现在 suggestedCommand 中，防止通过 shell 解释器执行任意命令。
 */
const SHELL_METACHAR_PATTERN = /[;&|<>()`$\\]/;

export async function handleAskUserQuestionTool(
  args: Record<string, unknown>,
  _context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const questions = parseQuestions(args.questions);
  if (!questions.ok) {
    return {
      ok: false,
      name: "AskUserQuestion",
      error: questions.error,
    };
  }

  // 解析可选的 suggestedCommand 字段（格式错误、白名单失败或参数沙箱失败时降级为 undefined）
  const suggestedCommand = parseSuggestedCommand(args.suggestedCommand, _context.projectRoot);

  const metadata: AskUserQuestionMetadata = {
    kind: "ask_user_question",
    questions: questions.value,
    ...(suggestedCommand ? { suggestedCommand } : {}),
  };

  return {
    ok: true,
    name: "AskUserQuestion",
    // 注意：buildQuestionSummary 不再接收 suggestedCommand，避免 LLM 上下文污染
    // suggestedCommand 仅通过 metadata 字段传递给 UI 层
    output: buildQuestionSummary(questions.value),
    metadata,
    awaitUserResponse: true,
  };
}

/**
 * 解析并校验 suggestedCommand 字段（fork 侧安全修复）
 *
 * 安全约束：
 * - command 必须是字符串且非空
 * - command 必须以 "/" 开头（仅允许 slash 命令，防止任意命令注入）
 * - command 首个 token 必须命中 ALLOWED_SUGGESTED_COMMAND_NAMES 白名单
 *   （防止 LLM 注入 exit/undo/new/inject/bg 等会话控制类命令）
 * - command 参数必须通过 validateSuggestedCommandArgs 沙箱校验
 *   （禁止 --task-file/--project-root 指向项目外、绝对路径、~ 展开、路径穿越等）
 * - reason 是可选字符串
 *
 * @param raw 原始输入值
 * @param projectRoot 当前项目根目录，用于校验相对路径是否落在项目内
 * @returns 解析后的 SuggestedCommand，或 undefined（格式错误、不在白名单或参数沙箱失败时降级）
 */
function parseSuggestedCommand(raw: unknown, projectRoot?: string): SuggestedCommand | undefined {
  // 非对象或数组直接拒绝
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const command = (raw as { command?: unknown }).command;
  if (typeof command !== "string") {
    return undefined;
  }
  const trimmedCommand = command.trim();
  if (trimmedCommand.length === 0) {
    return undefined;
  }
  // 安全约束 1：只允许以 / 开头的 slash 命令
  if (!trimmedCommand.startsWith("/")) {
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

  // P0 安全修复：参数级沙箱校验
  const sandbox = validateSuggestedCommandArgs(trimmedCommand, projectRoot);
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
 * 校验单个路径参数是否合法。
 *
 * 规则：
 * - 禁止含 ".." 的路径穿越
 * - 禁止以 "~" 开头的 home 目录展开
 * - 绝对路径必须在 projectRoot 子树内（无 projectRoot 时直接拒绝绝对路径）
 * - 相对路径在提供 projectRoot 时必须解析到 projectRoot 子树内
 *
 * @param value 路径字符串
 * @param projectRoot 当前项目根目录（可选）
 * @returns 非法时返回原因，否则返回 null
 */
function checkPathValue(value: string, projectRoot?: string): string | null {
  if (value.length === 0) {
    return "路径不能为空";
  }
  if (value.includes("..")) {
    return "路径包含 ..（路径穿越）";
  }
  if (value.startsWith("~")) {
    return "路径以 ~ 开头（home 目录展开）";
  }

  if (path.isAbsolute(value)) {
    if (!projectRoot) {
      return "绝对路径不被允许";
    }
    if (!isPathInProject(projectRoot, value)) {
      return "绝对路径超出项目根目录";
    }
    return null;
  }

  if (projectRoot) {
    if (!isPathInProject(projectRoot, value)) {
      return "相对路径解析后超出项目根目录";
    }
  }

  return null;
}

/**
 * suggestedCommand 参数沙箱校验。
 *
 * P0 安全修复：
 * - 拒绝含 shell 元字符的命令字符串
 * - 拒绝 FORBIDDEN_PATH_OPTION_NAMES 中列出的选项指向项目外路径
 * - 拒绝任何以 "/"、"~" 开头或含 ".." 的参数 token
 *
 * @param command 已 trim 的命令字符串
 * @param projectRoot 当前项目根目录（可选，用于路径边界校验）
 * @returns 校验结果，失败时携带原因
 */
function validateSuggestedCommandArgs(
  command: string,
  projectRoot?: string
): { ok: true } | { ok: false; reason: string } {
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
      const pathError = checkPathValue(stripQuotes(pathValue), projectRoot);
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

function parseQuestions(raw: unknown): { ok: true; value: AskUserQuestionItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: '"questions" must be a non-empty array.',
    };
  }

  const questions: AskUserQuestionItem[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: `Question at index ${index} must be an object.`,
      };
    }

    const question =
      typeof (item as { question?: unknown }).question === "string"
        ? (item as { question: string }).question.trim()
        : "";
    if (!question) {
      return {
        ok: false,
        error: `Question at index ${index} is missing a non-empty "question" string.`,
      };
    }

    const rawOptions = (item as { options?: unknown }).options;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
      return {
        ok: false,
        error: `Question at index ${index} must include a non-empty "options" array.`,
      };
    }

    const options: AskUserQuestionOption[] = [];
    for (let optionIndex = 0; optionIndex < rawOptions.length; optionIndex += 1) {
      const option = rawOptions[optionIndex];
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return {
          ok: false,
          error: `Option ${optionIndex} for question ${index} must be an object.`,
        };
      }

      const label =
        typeof (option as { label?: unknown }).label === "string" ? (option as { label: string }).label.trim() : "";
      if (!label) {
        return {
          ok: false,
          error: `Option ${optionIndex} for question ${index} is missing a non-empty "label" string.`,
        };
      }

      const description =
        typeof (option as { description?: unknown }).description === "string"
          ? (option as { description: string }).description.trim()
          : undefined;

      options.push({
        label,
        description: description || undefined,
      });
    }

    const multiSelect =
      typeof (item as { multiSelect?: unknown }).multiSelect === "boolean"
        ? (item as { multiSelect: boolean }).multiSelect
        : undefined;

    questions.push({
      question,
      multiSelect,
      options,
    });
  }

  return {
    ok: true,
    value: questions,
  };
}

/**
 * 构建工具输出的摘要文本（fork 侧保留）
 *
 * 注意：suggestedCommand 信息仅通过 metadata 传递给 UI 层（PendingAskUserQuestion.suggestedCommand），
 * 由 UI 层在用户回答后通过 handleQuestionAnswers 自动执行。
 * 此处不再将 suggestedCommand 暴露在 tool result 文本中，避免 LLM 看到后提前回复或绕过用户确认。
 *
 * @param questions 问题列表
 */
function buildQuestionSummary(questions: AskUserQuestionItem[]): string {
  const lines = ["Waiting for user input."];

  questions.forEach((item, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${item.question}`);
    lines.push(`   Mode: ${item.multiSelect ? "multi-select" : "single-select"}`);
    item.options.forEach((option) => {
      lines.push(`   - ${option.label}`);
      if (option.description) {
        lines.push(`     ${option.description}`);
      }
    });
    lines.push("   - Other");
  });

  // 注意：suggestedCommand 不在 tool result 中暴露（避免 LLM 上下文污染）
  // 之前实现中的 [Auto-dispatch after answer] 行已移除，suggestedCommand 仅通过
  // metadata.suggestedCommand 字段传递给 UI 层（AskUserQuestionPrompt → handleQuestionAnswers）。

  return lines.join("\n");
}
