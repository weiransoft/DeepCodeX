import type { SkillInfo } from "@vegamo/deepcode-core";

/**
 * 斜杠命令种类
 *
 * DeepCodeX 扩展：新增 6 个多角色团队命令
 *   - team: 多角色调度（自动匹配最合适角色）
 *   - architect / pm / coder / tester / ui: 强制指定角色
 * DeepCodeX V2 扩展：新增 memory 命令
 *   - memory: 记忆管理（list/delete/review/export）
 * DeepCodeX EAG 扩展：新增 rules 命令
 *   - rules: RLIS 规则管理（list/add/remove/show/path）
 * DeepCodeX DI 扩展（ADR-DI-001）：新增 7 个动态注入与后台任务命令
 *   - inject: 向当前任务追加指令
 *   - bg: 后台启动新子 agent
 *   - tasks: 列出所有任务
 *   - fg: 切换前台关注任务
 *   - cancel: 取消指定任务
 *   - pause: 暂停前台任务
 *   - resume: 恢复暂停的任务（复用现有 "resume" kind，通过参数区分场景）
 */
export type SlashCommandKind =
  | "skill"
  | "skills"
  | "model"
  | "plan"
  | "new"
  | "init"
  | "resume"
  | "continue"
  | "undo"
  | "mcp"
  | "raw"
  | "exit"
  | "team"
  | "architect"
  | "pm"
  | "coder"
  | "tester"
  | "ui"
  | "memory"
  | "rules"
  // ===== ADR-DI-001 动态注入与后台子 Agent 命令 =====
  // 注意："/resume <taskId>" 复用现有 "resume" kind，通过参数区分场景
  | "inject"
  | "bg"
  | "tasks"
  | "fg"
  | "cancel"
  | "pause";

export type SlashCommandItem = {
  kind: SlashCommandKind;
  name: string;
  label: string;
  description: string;
  skill?: SkillInfo;
  args?: string[];
};

export const BUILTIN_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    kind: "skills",
    name: "skills",
    label: "/skills",
    description: "List available skills",
  },
  {
    kind: "model",
    name: "model",
    label: "/model",
    description: "Select model, thinking mode and effort control",
  },
  {
    kind: "plan",
    name: "plan",
    label: "/plan",
    description: "Switch the input to Plan Mode",
  },
  {
    kind: "new",
    name: "new",
    label: "/new",
    description: "Start a fresh conversation",
  },
  {
    kind: "init",
    name: "init",
    label: "/init",
    description: "Initialize an AGENTS.md file with instructions for LLM",
  },
  {
    kind: "resume",
    name: "resume",
    label: "/resume",
    description: "Pick a previous conversation to continue",
  },
  {
    kind: "continue",
    name: "continue",
    label: "/continue",
    description: "Continue the active conversation or pick one to resume",
  },
  {
    kind: "undo",
    name: "undo",
    label: "/undo",
    description: "Restore code and/or conversation to a previous point",
  },
  {
    kind: "mcp",
    name: "mcp",
    label: "/mcp",
    description: "Show MCP server status and available tools",
  },
  {
    kind: "raw",
    name: "raw",
    label: "/raw",
    args: ["lite", "normal", "raw-scrollback"],
    description: "Toggle display mode for viewing or collapsing reasoning content",
  },
  {
    kind: "exit",
    name: "exit",
    label: "/exit",
    description: "Quit Deep Code CLI",
  },
  // ===== DeepCodeX 多角色团队命令（5 角色 + 自动调度） =====
  {
    kind: "team",
    name: "team",
    label: "/team",
    args: ["<task description>"],
    description:
      "Auto-dispatch task to best-fit multi-role team member (Karpathy 4 principles + Ponytail 16 red lines)",
  },
  {
    kind: "architect",
    name: "architect",
    label: "/architect",
    args: ["<task description>"],
    description: "Force dispatch to Architect role (system design, tech selection, ADR)",
  },
  {
    kind: "pm",
    name: "pm",
    label: "/pm",
    args: ["<task description>"],
    description: "Force dispatch to Product Manager role (PRD, user story, acceptance criteria)",
  },
  {
    kind: "coder",
    name: "coder",
    label: "/coder",
    args: ["<task description>"],
    description: "Force dispatch to Solo Coder role (implementation, refactor, unit test)",
  },
  {
    kind: "tester",
    name: "tester",
    label: "/tester",
    args: ["<task description>"],
    description: "Force dispatch to Test Expert role (test design, E2E, coverage)",
  },
  {
    kind: "ui",
    name: "ui",
    label: "/ui",
    args: ["<task description>"],
    description: "Force dispatch to UI Designer role (UI/UX, accessibility, design system)",
  },
  // ===== DeepCodeX V2 记忆管理命令 =====
  {
    kind: "memory",
    name: "memory",
    label: "/memory",
    args: ["<subcommand>"],
    description: "Memory management (list/delete/review/export)",
  },
  // ===== DeepCodeX EAG 规则管理命令 =====
  {
    kind: "rules",
    name: "rules",
    label: "/rules",
    args: ["<subcommand>"],
    description: "RLIS rule management (list/add/remove/show/path)",
  },
  // ===== ADR-DI-001 动态注入与后台子 Agent 命令 =====
  // 设计依据：ADR-DI-001 §7.4.2 SlashCommandKind 扩展
  // /inject <指令文本>：向当前正在执行的任务追加指令（软中断，下一轮 LLM 调用消费）
  {
    kind: "inject",
    name: "inject",
    label: "/inject",
    args: ["<instruction text>"],
    description: "Inject instruction into the running task (soft interrupt, consumed next LLM call)",
  },
  // /bg <任务描述>：后台启动新子 agent 执行独立任务（fire-and-steer 模式）
  {
    kind: "bg",
    name: "bg",
    label: "/bg",
    args: ["<task prompt>"],
    description: "Start a background sub-agent for an independent task (returns task_id immediately)",
  },
  // /tasks：列出所有运行中和已完成的任务（前台 + 后台）
  {
    kind: "tasks",
    name: "tasks",
    label: "/tasks",
    description: "List all tasks (foreground + background) with status, progress, and duration",
  },
  // /fg <taskId>：切换前台关注到指定任务（不中断其他后台任务）
  {
    kind: "fg",
    name: "fg",
    label: "/fg",
    args: ["<task-id>"],
    description: "Switch foreground focus to a specific task (does not interrupt others)",
  },
  // /cancel <taskId>：取消指定任务（硬中断，状态转为 cancelled）
  {
    kind: "cancel",
    name: "cancel",
    label: "/cancel",
    args: ["<task-id>"],
    description: "Cancel a task by ID (hard interrupt, transitions to cancelled state)",
  },
  // /pause：暂停当前前台任务（创建 abort 标志，下次迭代停止）
  {
    kind: "pause",
    name: "pause",
    label: "/pause",
    description: "Pause the active foreground task (use /resume <task-id> to continue)",
  },
  // 注意：/resume <taskId> 复用现有 "resume" kind，通过参数区分场景：
  //   - /resume（无参数）→ 显示会话列表，选择恢复之前的对话
  //   - /resume <taskId> → 恢复暂停的后台任务
];

export function buildSlashCommands(skills: SkillInfo[]): SlashCommandItem[] {
  const skillItems: SlashCommandItem[] = skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    label: `/${skill.name}`,
    description: skill.description || "(no description)",
    skill,
  }));
  return [...skillItems, ...BUILTIN_SLASH_COMMANDS];
}

export function filterSlashCommands(items: SlashCommandItem[], token: string): SlashCommandItem[] {
  if (!token.startsWith("/")) {
    return [];
  }
  const query = token.slice(1).toLowerCase();
  if (!query) {
    return items;
  }
  return items.filter((item) => item.name.toLowerCase().includes(query));
}

export function findExactSlashCommand(items: SlashCommandItem[], token: string): SlashCommandItem | null {
  if (!token.startsWith("/")) {
    return null;
  }
  const query = token.slice(1);
  const matches = items.filter((item) => item.name === query);
  return matches.find((item) => item.kind !== "skill") ?? matches[0] ?? null;
}

export function formatSlashCommandDescription(description: string): string {
  return (description || "(no description)").trim().replace(/\s+/g, " ");
}

export function formatSlashCommandLabel(item: SlashCommandItem): string {
  return item.kind === "skill" && item.skill?.isLoaded ? `${item.label} ✓` : item.label;
}

/**
 * DeepCodeX 扩展：判断是否为多角色团队命令
 */
export function isTeamCommand(kind: SlashCommandKind): boolean {
  return (
    kind === "team" || kind === "architect" || kind === "pm" || kind === "coder" || kind === "tester" || kind === "ui"
  );
}

/**
 * DeepCodeX 扩展：team 命令 → roleId 映射
 */
export function teamCommandToRoleId(kind: SlashCommandKind): string | null {
  switch (kind) {
    case "team":
      return null; // auto
    case "architect":
      return "architect";
    case "pm":
      return "product-manager";
    case "coder":
      return "solo-coder";
    case "tester":
      return "test-expert";
    case "ui":
      return "ui-designer";
    default:
      return null;
  }
}

/**
 * ADR-DI-001 扩展：判断是否为动态注入与后台任务命令
 *
 * 用于在 handleSlashSelection 与 handlePrompt 中识别 7 个新命令，
 * 统一走中断能力扩展路径（SessionManager 的 injectInstruction / startBackgroundTask 等方法）。
 *
 * 注意：`/resume <taskId>` 复用现有 "resume" kind，不在此函数判断范围内，
 * 由 handlePrompt 内通过参数前缀（`t-`）区分场景。
 *
 * @param kind SlashCommandKind 枚举值
 * @returns 是否为 ADR-DI-001 动态注入命令
 */
export function isInterruptCommand(kind: SlashCommandKind): boolean {
  return (
    kind === "inject" || kind === "bg" || kind === "tasks" || kind === "fg" || kind === "cancel" || kind === "pause"
  );
}

/**
 * ADR-DI-001 扩展：判断 /resume 命令的参数是否为任务 ID
 *
 * 任务 ID 格式：`t-` 前缀 + UUID 前缀（如 `t-abc123def456`）。
 * 当 /resume 带有 `t-` 前缀的参数时，走恢复暂停任务路径；
 * 否则走现有恢复会话路径。
 *
 * @param text 用户输入的完整文本（如 "/resume t-abc123" 或 "/resume"）
 * @returns 是否为恢复暂停任务的场景
 */
export function isResumeTaskCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/resume")) {
    return false;
  }
  // 提取 /resume 之后的参数
  const args = trimmed.slice(7).trim();
  if (!args) {
    return false;
  }
  // 任务 ID 以 "t-" 前缀开头（与 BackgroundTaskRunner.startBackground 生成的 taskId 格式一致）
  return args.startsWith("t-");
}

/**
 * ADR-DI-001 扩展：从命令文本中提取参数
 *
 * 例如：
 * - "/inject test instruction" → "test instruction"
 * - "/bg 调研 React 19" → "调研 React 19"
 * - "/fg t-abc123" → "t-abc123"
 * - "/cancel t-abc123" → "t-abc123"
 * - "/resume t-abc123" → "t-abc123"
 * - "/tasks" → ""
 * - "/pause" → ""
 *
 * @param text 用户输入的完整文本
 * @param commandName 命令名（不含 "/"，如 "inject" / "bg" / "resume"）
 * @returns 参数文本（去除命令前缀后的内容，已 trim）
 */
export function extractCommandArgument(text: string, commandName: string): string {
  const trimmed = text.trim();
  const prefix = `/${commandName}`;
  if (!trimmed.startsWith(prefix)) {
    return "";
  }
  return trimmed.slice(prefix.length).trim();
}
