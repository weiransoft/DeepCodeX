/**
 * 全局动态编排命令描述符构建器
 *
 * 本模块提供 `buildDynamicCommandDescriptors()` 函数，从 CLI 层的真实命令来源
 * （BUILTIN_SLASH_COMMANDS、team 子命令、rules 子命令）构造 DynamicCommandDescriptor 数组，
 * 注入 SessionManager，使 LLM 动态建议层能识别并建议全部命令体系的命令。
 *
 * 设计原则（对齐 2026-07-24-eag-llm-dynamic-orchestration.md v1.4）：
 * 1. 真实来源驱动：描述符从真实命令定义转换，不硬编码。
 * 2. 避免循环依赖：CLI 层构造描述符后注入 core 层，core 不反向依赖 CLI。
 * 3. 覆盖全部命令体系：team/rules/slash，EAG 命令由 session.ts 内部生成。
 *
 * @module ui/core/dynamic-commands
 */

import type { DynamicCommandDescriptor } from "@vegamo/deepcode-core";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands";

// ============================================================================
// Team 子命令描述符
// ============================================================================

/**
 * Team 子命令描述符清单
 *
 * 对应 packages/cli/src/team/team-cmd.ts 中 TeamSubcommand 类型的 5 个子命令。
 * 每个描述符包含命令用途说明，供 LLM 理解何时建议使用该命令。
 */
const TEAM_COMMAND_DESCRIPTORS: ReadonlyArray<DynamicCommandDescriptor> = Object.freeze([
  Object.freeze({
    category: "team" as const,
    id: "team-list",
    name: "/team list",
    description: "列出所有可用角色（架构师/产品经理/测试专家/独立开发者/UI设计师）。",
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-match",
    name: "/team match",
    description: "根据关键词匹配最合适的角色，输出置信度和匹配理由。",
    args: ["--keywords <kw1,kw2,...>"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-dispatch",
    name: "/team dispatch",
    description: "分派任务到指定角色（自动匹配或 --role 强制指定）。适合单角色任务。",
    args: ["--task <任务描述>"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-autonomous",
    name: "/team autonomous",
    description: "启动 Ralph 自主迭代模式（plan → dev → verify → fix 4 阶段循环）。适合需要自动迭代的多步任务。",
    args: ["--goal <目标>"],
  }),
  Object.freeze({
    category: "team" as const,
    id: "team-full-lifecycle",
    name: "/team full-lifecycle",
    description: "8 阶段项目全流程（需求→架构→UI→测试设计→分解→开发→测试→文档审查）。适合新项目启动。",
    args: ["--project <项目名>"],
  }),
]);

// ============================================================================
// Rules 子命令描述符
// ============================================================================

/**
 * Rules 子命令描述符清单
 *
 * 对应 packages/cli/src/rules/rules-cmd.ts 中 RulesSubcommand 类型的 5 个子命令。
 * 每个描述符包含命令用途说明，供 LLM 理解何时建议使用该命令。
 */
const RULES_COMMAND_DESCRIPTORS: ReadonlyArray<DynamicCommandDescriptor> = Object.freeze([
  Object.freeze({
    category: "rules" as const,
    id: "rules-list",
    name: "/rules list",
    description: "列出所有生效规则（按 BLOCKER/MAJOR/WARNING 分组，含种子/用户/项目三层）。",
  }),
  Object.freeze({
    category: "rules" as const,
    id: "rules-add",
    name: "/rules add",
    description: "添加用户规则或项目规则（自动生成 USER-xxx / PROJ-xxx ID）。",
    args: ["--content <规则内容>", "--severity <BLOCKER|MAJOR|WARNING>"],
  }),
  Object.freeze({
    category: "rules" as const,
    id: "rules-remove",
    name: "/rules remove",
    description: "提示用户手动编辑规则文件移除规则（新 RLIS API 不支持运行时删除）。",
    args: ["--rule-id <ID>"],
  }),
  Object.freeze({
    category: "rules" as const,
    id: "rules-show",
    name: "/rules show",
    description: "查看规则详情（ID、分类、严重级别、内容、来源、注入/违规次数等）。",
    args: ["--rule-id <ID>"],
  }),
  Object.freeze({
    category: "rules" as const,
    id: "rules-path",
    name: "/rules path",
    description: "显示规则文件路径（全局用户层 ~/.deepcodeX/rules/global-rules.json 和项目层）。",
  }),
]);

// ============================================================================
// Slash 命令描述符构建
// ============================================================================

/**
 * 排除的 slash 命令 kind 集合
 *
 * 这些命令已在 team/rules 描述符中覆盖，或属于内部/退出命令，
 * 不需要重复出现在 slash 描述符中：
 * - team/architect/pm/coder/tester/ui → 已在 TEAM_COMMAND_DESCRIPTORS 中覆盖
 * - rules → 已在 RULES_COMMAND_DESCRIPTORS 中覆盖
 * - exit → 退出命令，不适合动态建议
 * - continue → 内部命令，由 isContinuePrompt 特殊处理
 */
const EXCLUDED_SLASH_KINDS = new Set(["team", "architect", "pm", "coder", "tester", "ui", "rules", "exit", "continue"]);

/**
 * 从 BUILTIN_SLASH_COMMANDS 构造 slash 命令描述符
 *
 * 将 TUI 内置 slash 命令（如 /skills、/model、/new、/init、/resume、/undo、/mcp、/raw、/memory）
 * 转换为 DynamicCommandDescriptor，排除已在 team/rules 描述符中覆盖的命令。
 *
 * @returns slash 命令描述符数组
 */
function buildSlashCommandDescriptors(): DynamicCommandDescriptor[] {
  const descriptors: DynamicCommandDescriptor[] = [];
  for (const cmd of BUILTIN_SLASH_COMMANDS) {
    // 跳过已排除的命令
    if (EXCLUDED_SLASH_KINDS.has(cmd.kind)) {
      continue;
    }
    descriptors.push(
      Object.freeze({
        category: "slash" as const,
        id: cmd.name,
        name: `/${cmd.name}`,
        description: cmd.description,
        ...(cmd.args ? { args: Object.freeze([...cmd.args]) } : {}),
      })
    );
  }
  return descriptors;
}

// ============================================================================
// 主入口：buildDynamicCommandDescriptors
// ============================================================================

/**
 * 构建全部外部命令描述符（team/rules/slash）
 *
 * 从 CLI 层的真实命令来源构造 DynamicCommandDescriptor 数组，
 * 注入 SessionManager 后，建议层 LLM 能识别并建议全部命令体系的命令。
 *
 * 注意：EAG 命令描述符由 session.ts 内部通过 listAvailableCommands() 生成，
 * 本函数只负责非 EAG 命令（team/rules/slash）。
 *
 * @returns 冻结的 DynamicCommandDescriptor 数组
 */
export function buildDynamicCommandDescriptors(): ReadonlyArray<DynamicCommandDescriptor> {
  const slashDescriptors = buildSlashCommandDescriptors();
  return Object.freeze([...TEAM_COMMAND_DESCRIPTORS, ...RULES_COMMAND_DESCRIPTORS, ...slashDescriptors]);
}
