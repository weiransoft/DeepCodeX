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
 * DeepCodeX Quality Gate 扩展：新增 quality-check 命令
 *   - quality-check: 质量门禁（codemap / uiux / visual / all）
 * DeepCodeX Review 扩展：新增 review 命令
 *   - review: 代码审查（typecheck / lint / format / full / help）— 工具验证优先
 * DeepCodeX 帮助扩展（FIX-06，多角色审查 2026-07-29）：新增 help 命令
 *   - help: 显示全部内置命令清单（与 CLI --help EPILOG 同一数据源）
 * DeepCodeX EAG P5 扩展（2026-07-31 新特性集成审查 FIX-3）：新增 4 个 EAG 编排命令
 *   - eag-autonomous: 启动 Ralph 风格无人值守 4 阶段循环（plan/dev/verify/fix）
 *   - eag-autonomous-status: 查询自主运行状态（断点续跑证据）
 *   - eag-autonomous-stop: 熔断中止自主运行
 *   - eag-graph: 执行 Loop-Graph 融合工作图
 * DeepCodeX EAG S3.2 扩展（2026-08-19 DESIGN Loop 接线）：新增 1 个 EAG 编排命令
 *   - eag-design: 执行 DESIGN Loop（PM 结构化需求 → 架构师设计 → 评估器判定 → 失败带反馈重试）
 *   说明：命令执行统一走 core session.ts 的 EagCommandParser 前缀解析分发，
 *         此处注册仅解决可发现性（Tab 补全 / /help 展示 / inline 参数提示）。
 * 上游 v0.3.1 新增：fork 命令（从当前会话派生新会话）
 */
export type SlashCommandKind =
  | "skill"
  | "skills"
  | "model"
  | "plan"
  | "new"
  | "init"
  | "resume"
  | "fork" // 上游 v0.3.1 新增
  | "continue"
  | "undo"
  | "mcp"
  | "raw"
  | "exit"
  | "help"
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
  | "pause"
  // ===== DeepCodeX Quality Gate 命令 =====
  | "quality-check"
  // ===== DeepCodeX Review 命令（工具验证优先） =====
  | "review"
  // ===== EAG P5 编排命令（2026-07-31 FIX-3） =====
  | "eag-autonomous"
  | "eag-autonomous-status"
  | "eag-autonomous-stop"
  | "eag-graph"
  // ===== EAG DESIGN Loop 命令（2026-08-19 S3.2 接线） =====
  | "eag-design";

export type SlashCommandItem = {
  kind: SlashCommandKind;
  name: string;
  label: string;
  description: string;
  skill?: SkillInfo;
  args?: string[];
};

export const BUILTIN_SLASH_COMMANDS: SlashCommandItem[] = [
  // fork 帮助扩展（FIX-06）：/help 与 CLI --help EPILOG 共用命令清单数据源
  {
    kind: "help",
    name: "help",
    label: "/help",
    description: "List all built-in commands with descriptions",
  },
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
  // 上游 v0.3.1 新增：/fork 从当前会话派生新会话
  {
    kind: "fork",
    name: "fork",
    label: "/fork",
    description: "Fork the current conversation",
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
  // ===== DeepCodeX Quality Gate 质量门禁命令 =====
  // 子命令：codemap / uiux / visual / all / help
  {
    kind: "quality-check",
    name: "quality-check",
    label: "/quality-check",
    args: ["<subcommand>", "[options]"],
    description: "Quality gate: code map / UI-UX audit / visual regression (subcommands: codemap|uiux|visual|all|help)",
  },
  // ===== DeepCodeX Review 代码审查命令（工具验证优先） =====
  // 子命令：typecheck / lint / format / full / help
  // 自然语言：/review <任务描述> 可直接交给 LLM 进行代码审查
  // 关联事件：docs/archive/code-review-process-incident.md（原始 review 报告失实事件，已归档）
  {
    kind: "review",
    name: "review",
    label: "/review",
    args: ["<subcommand|task>", "[options]"],
    description:
      "Code review: tool mode (typecheck|lint|format|full|help) or natural language task (e.g., /review evaluate current code)",
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
  // ===== EAG P5 编排命令（2026-07-31 FIX-3） =====
  // 执行路径：选中后填充命令前缀供用户补参数，提交后经裸文本透传至
  // core session.ts 的 EagCommandParser 统一解析分发（与 C 域 6 命令同款模式）。
  {
    kind: "eag-autonomous",
    name: "eag-autonomous",
    label: "/eag-autonomous",
    args: ["<goal>", "[--max-iterations <n>]", "[--project-root <path>]", "[--confirmation <mode>]"],
    description: "Start unattended Ralph loop (plan/dev/verify/fix) for a goal",
  },
  {
    kind: "eag-autonomous-status",
    name: "eag-autonomous-status",
    label: "/eag-autonomous-status",
    args: ["[runId]"],
    description: "Query autonomous run status and resume evidence (latest run if runId omitted)",
  },
  {
    kind: "eag-autonomous-stop",
    name: "eag-autonomous-stop",
    label: "/eag-autonomous-stop",
    args: ["[runId]"],
    description: "Circuit-break an autonomous run (latest run if runId omitted)",
  },
  {
    kind: "eag-graph",
    name: "eag-graph",
    label: "/eag-graph",
    args: ["--graph-file <path>", "[--max-parallel <n>]", "[--node-retry-limit <n>]"],
    description: "Execute a Loop-Graph fusion work graph (loop/task/decision/merge/fork/end nodes)",
  },
  // ===== EAG DESIGN Loop 命令（2026-08-19 S3.2 接线） =====
  // 执行路径与上方 EAG P5 命令同款：选中后填充命令前缀供用户补参数，
  // 提交后经裸文本透传至 core session.ts 的 EagCommandParser 统一解析
  // （eag-design 前缀匹配 → extractDesignLoopInputFromPrompt 提取
  //   --requirement / --paradigm 参数 → DesignLoopOrchestrator.run()）。
  {
    kind: "eag-design",
    name: "eag-design",
    label: "/eag-design",
    args: ["--requirement <text>", "[--paradigm <ddd-layered|clean-architecture|cqrs-es|microservice>]"],
    description: "Run DESIGN Loop (PM structures requirement, architect designs, evaluator gates with feedback retry)",
  },
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
 * 渲染内置命令清单文本（FIX-06，多角色审查 2026-07-29）
 *
 * 单一数据源原则：CLI `--help` EPILOG 与 TUI `/help` 命令共用此函数渲染命令清单，
 * 避免两处硬编码清单随命令注册表演进而漂移（审查发现 EPILOG 缺 11+ 已注册命令）。
 *
 * 渲染格式（每行一条命令，label 列对齐）：
 *   /help            List all built-in commands with descriptions
 *   /skills          List available skills
 *   ...
 *
 * 对齐宽度：取全部命令 label 的最大长度 + 2 空格间距，保证列整齐。
 *
 * @returns 多行命令清单文本（不含首尾空行）
 */
export function formatBuiltinCommandList(): string {
  const labelWidth = Math.max(...BUILTIN_SLASH_COMMANDS.map((item) => item.label.length));
  return BUILTIN_SLASH_COMMANDS.map((item) => `  ${item.label.padEnd(labelWidth)}  ${item.description}`).join("\n");
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
