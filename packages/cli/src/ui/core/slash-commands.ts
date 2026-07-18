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
  | "rules";

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
