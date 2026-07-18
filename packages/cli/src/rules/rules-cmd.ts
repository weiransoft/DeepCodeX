/**
 * Rules 子命令 - RLIS 规则管理 CLI
 *
 * EAG 方案 §5.5 规则学习与注入系统（RLIS）的命令行入口。
 * 提供 /rules <subcommand> 形式的规则管理能力，支持：
 * - list：列出三层规则（种子 / 用户 / 项目）
 * - add：添加用户规则或项目规则（自动生成 USER-xxx / PROJ-xxx ID）
 * - remove：移除规则（BLOCKER 级种子规则不可移除）
 * - show：查看规则详情
 * - path：显示规则文件路径
 *
 * 调用方：
 * - packages/cli/src/cli.tsx —— 非 TUI 模式（deepcodex rules list）
 * - packages/cli/src/ui/views/App.tsx —— TUI 模式（/rules list）
 *
 * 设计原则：
 * - 不依赖 mock：直接使用真实的 RuleStore 实例和文件系统
 * - 输出缓冲：所有输出先收集到 OutputBuffer，再按 printToTerminal 决定是否写终端
 * - 错误隔离：命令失败时返回 exitCode=1 + stderr 错误说明，不抛异常到调用方
 * - 中文输出：所有面向用户的提示使用中文
 *
 * @module cli/rules/rules-cmd
 */

import * as os from "node:os";
import * as path from "node:path";
import {
  RuleStore,
  SEED_RULES,
  type RuleDefinition,
  type RuleSeverity,
  type RuleStorageLayer,
} from "@vegamo/deepcode-core";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * /rules 子命令类型
 *
 * 5 个合法子命令：
 * - list：列出三层规则
 * - add：添加规则
 * - remove：移除规则
 * - show：查看规则详情
 * - path：显示规则文件路径
 */
export type RulesSubcommand = "list" | "add" | "remove" | "show" | "path";

/**
 * /rules 命令参数
 *
 * 由 CLI 层（cli.tsx 或 App.tsx）解析用户输入后构造，
 * 传递给 executeRulesCommand 执行。
 */
export interface RulesCommandArgs {
  /** 子命令名称 */
  subcommand: RulesSubcommand;
  /** add 子命令的规则内容（必需） */
  content?: string;
  /** remove / show 子命令的规则 ID（必需） */
  ruleId?: string;
  /** add 子命令的严重级别（默认 major） */
  severity?: RuleSeverity;
  /** add 子命令的存储层（默认 user） */
  layer?: "user" | "project";
  /** 项目根目录（用于定位 .deepcode/rules/project-rules.json） */
  projectRoot: string;
}

/**
 * 命令执行结果
 *
 * 所有子命令统一返回此结构，调用方按 exitCode 判断成功/失败，
 * 按 stdout/stderr 获取输出内容。
 */
export interface RulesCommandResult {
  /** 退出码：0=成功，1=失败 */
  exitCode: number;
  /** 标准输出（命令的常规输出） */
  stdout: string;
  /** 标准错误（错误说明，成功时为空） */
  stderr: string;
}

// ============================================================================
// OutputBuffer：输出缓冲器
// ============================================================================

/**
 * 输出缓冲器
 *
 * 收集命令执行期间的 stdout 和 stderr 输出，避免直接写终端。
 * 当 printToTerminal=true 时，同时写入真实终端；
 * 当 printToTerminal=false 时，仅收集到缓冲区，由调用方处理。
 *
 * 设计目的：
 * - 测试时可关闭终端输出，通过返回值断言输出内容
 * - TUI 模式（/rules list）需要将输出作为消息内容返回，而非直接打印
 */
class OutputBuffer {
  /** stdout 缓冲 */
  private readonly stdoutChunks: string[] = [];
  /** stderr 缓冲 */
  private readonly stderrChunks: string[] = [];
  /** 是否同时写入真实终端 */
  private readonly printToTerminal: boolean;

  /**
   * 构造 OutputBuffer
   *
   * @param printToTerminal 是否同时写入真实终端（默认 true）
   */
  constructor(printToTerminal: boolean = true) {
    this.printToTerminal = printToTerminal;
  }

  /**
   * 写入 stdout
   *
   * @param text 输出文本
   */
  writeStdout(text: string): void {
    this.stdoutChunks.push(text);
    if (this.printToTerminal) {
      process.stdout.write(text);
    }
  }

  /**
   * 写入 stderr
   *
   * @param text 错误文本
   */
  writeStderr(text: string): void {
    this.stderrChunks.push(text);
    if (this.printToTerminal) {
      process.stderr.write(text);
    }
  }

  /**
   * 获取收集到的 stdout
   *
   * @returns stdout 文本
   */
  getStdout(): string {
    return this.stdoutChunks.join("");
  }

  /**
   * 获取收集到的 stderr
   *
   * @returns stderr 文本
   */
  getStderr(): string {
    return this.stderrChunks.join("");
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从规则内容提取名称
 *
 * 规则的 name 字段用于简短标识，description 字段保留完整内容。
 * 提取规则：
 * - 短内容（≤30 字符）→ 直接作为名称
 * - 长内容（>30 字符）→ 前 30 字符 + "..."
 *
 * @param content 规则完整内容
 * @returns 规则名称（可能被截断）
 */
function extractRuleName(content: string): string {
  if (content.length <= 30) {
    return content;
  }
  return content.slice(0, 30) + "...";
}

/**
 * 自动生成规则 ID
 *
 * ID 格式：USER-xxx 或 PROJ-xxx（xxx 为 3 位数字，从 001 开始递增）。
 * 通过扫描已有规则的同前缀 ID，找到最大编号 +1。
 *
 * @param store RuleStore 实例（用于查询已有规则）
 * @param layer 目标存储层（决定前缀 USER / PROJ）
 * @returns 新规则 ID
 */
function generateRuleId(store: RuleStore, layer: "user" | "project"): string {
  // 前缀：user 层 → USER，project 层 → PROJ
  const prefix = layer === "user" ? "USER" : "PROJ";
  // 加载合并后的规则集，扫描同前缀 ID 找最大编号
  const ruleset = store.loadMergedRuleset();
  let maxNum = 0;
  for (const rule of ruleset.rules) {
    if (rule.id.startsWith(prefix + "-")) {
      const numStr = rule.id.slice(prefix.length + 1);
      const num = parseInt(numStr, 10);
      if (!Number.isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }
  // 下一编号（3 位补零）
  const nextNum = maxNum + 1;
  return `${prefix}-${String(nextNum).padStart(3, "0")}`;
}

// ============================================================================
// help 文本生成
// ============================================================================

/**
 * 生成 /rules 命令的帮助文本
 *
 * 包含命令格式示例、5 个子命令说明、常用参数。
 *
 * @returns help 文本（多行字符串）
 */
export function formatRulesHelp(): string {
  return [
    "用法: deepcodex rules <subcommand> [options]",
    "      /rules <subcommand> [args]          # TUI 模式",
    "",
    "RLIS 规则学习与注入系统：管理三层规则（种子 / 用户 / 项目）",
    "",
    "子命令：",
    "  list                              列出所有生效规则（按严重级别分组）",
    "  add --content <内容>               添加规则（默认 user 层，severity=major）",
    "  remove --rule-id <ID>              移除规则（BLOCKER 级种子规则不可移除）",
    "  show --rule-id <ID>                查看规则详情",
    "  path                              显示规则文件路径",
    "",
    "可选参数（仅 add 子命令）：",
    "  --severity <blocker|major|warning>  严重级别（默认 major）",
    "  --layer <user|project>              存储层（默认 user）",
    "  --project-root <路径>               项目根目录（默认当前目录）",
    "",
    "示例：",
    "  deepcodex rules list",
    '  deepcodex rules add --content "禁止使用 var 声明变量" --severity blocker',
    "  deepcodex rules remove --rule-id USER-001",
    "  deepcodex rules show --rule-id SEED-01",
    "  deepcodex rules path",
    "",
  ].join("\n");
}

// ============================================================================
// 子命令实现
// ============================================================================

/**
 * list 子命令：列出三层规则
 *
 * 输出格式：
 * - 标题："生效规则清单"
 * - 统计行："共 N 条（种子 X / 用户 Y / 项目 Z）"
 * - 按 severity 分组：BLOCKER 级（不可豁免）、MAJOR 级、WARNING 级
 * - 每条规则：[ID] 名称 — 描述（截断）
 *
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 */
function executeList(store: RuleStore, buffer: OutputBuffer): void {
  const ruleset = store.loadMergedRuleset();
  // 标题
  buffer.writeStdout("生效规则清单\n");
  buffer.writeStdout("========================================\n");
  // 统计行
  buffer.writeStdout(
    `共 ${ruleset.rules.length} 条（种子 ${ruleset.seedCount} / 用户 ${ruleset.userCount} / 项目 ${ruleset.projectCount}）\n\n`
  );

  // 按 severity 分组
  const blockerRules = ruleset.rules.filter((r) => r.severity === "blocker");
  const majorRules = ruleset.rules.filter((r) => r.severity === "major");
  const warningRules = ruleset.rules.filter((r) => r.severity === "warning");

  // BLOCKER 级（不可豁免）
  if (blockerRules.length > 0) {
    buffer.writeStdout("## BLOCKER 级（不可豁免）\n");
    for (const rule of blockerRules) {
      buffer.writeStdout(`- [${rule.id}] ${rule.name}\n`);
      buffer.writeStdout(`  ${rule.description}\n`);
    }
    buffer.writeStdout("\n");
  }

  // MAJOR 级
  if (majorRules.length > 0) {
    buffer.writeStdout("## MAJOR 级\n");
    for (const rule of majorRules) {
      buffer.writeStdout(`- [${rule.id}] ${rule.name}\n`);
      buffer.writeStdout(`  ${rule.description}\n`);
    }
    buffer.writeStdout("\n");
  }

  // WARNING 级
  if (warningRules.length > 0) {
    buffer.writeStdout("## WARNING 级\n");
    for (const rule of warningRules) {
      buffer.writeStdout(`- [${rule.id}] ${rule.name}\n`);
      buffer.writeStdout(`  ${rule.description}\n`);
    }
    buffer.writeStdout("\n");
  }
}

/**
 * add 子命令：添加规则
 *
 * 自动生成 USER-xxx 或 PROJ-xxx ID，将规则写入对应存储层。
 * 规则字段：
 * - id：自动生成
 * - name：从 content 前 30 字符提取
 * - description：完整 content
 * - severity：参数指定（默认 major）
 * - source：与 layer 一致（user / project）
 * - injectionTargets：默认 ["system_prompt", "evaluator"]
 * - pattern：null（需推理判定）
 * - tags：["custom"]
 * - removable：true
 *
 * @param args 命令参数
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功，1=失败）
 */
function executeAdd(args: RulesCommandArgs, store: RuleStore, buffer: OutputBuffer): number {
  // 校验 content 参数
  if (!args.content || args.content.trim().length === 0) {
    buffer.writeStderr("✖ /rules add 需要 --content 参数\n用法: deepcodex rules add --content <内容>\n");
    return 1;
  }

  // 目标存储层（默认 user）
  const layer: RuleStorageLayer = args.layer ?? "user";
  // 严重级别（默认 major）
  const severity: RuleSeverity = args.severity ?? "major";
  // 自动生成 ID
  const ruleId = generateRuleId(store, layer as "user" | "project");

  // 构造规则定义
  const rule: RuleDefinition = {
    id: ruleId,
    name: extractRuleName(args.content),
    description: args.content,
    severity,
    source: layer,
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["custom"],
    removable: true,
  };

  // 调用 RuleStore.addRule 持久化
  const result = store.addRule(rule, layer);
  if (!result.success) {
    buffer.writeStderr(`✖ 规则添加失败：${result.error}\n`);
    return 1;
  }

  // 输出成功信息
  const layerLabel = layer === "user" ? "用户层" : "项目层";
  buffer.writeStdout(`✔ 规则已添加（${layerLabel}）\n`);
  buffer.writeStdout(`  ID: ${ruleId}\n`);
  buffer.writeStdout(`  名称: ${rule.name}\n`);
  buffer.writeStdout(`  严重级别: ${severity}\n`);
  return 0;
}

/**
 * remove 子命令：移除规则
 *
 * 移除逻辑：
 * - 用户/项目规则：从对应文件中删除
 * - 可移除的种子规则：写入 removedSeedIds，下次加载时跳过
 * - BLOCKER 级种子规则（removable=false）：拒绝移除
 *
 * @param args 命令参数
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功，1=失败）
 */
function executeRemove(args: RulesCommandArgs, store: RuleStore, buffer: OutputBuffer): number {
  // 校验 ruleId 参数
  if (!args.ruleId || args.ruleId.trim().length === 0) {
    buffer.writeStderr("✖ /rules remove 需要 --rule-id 参数\n用法: deepcodex rules remove --rule-id <ID>\n");
    return 1;
  }

  // 调用 RuleStore.removeRule
  const result = store.removeRule(args.ruleId);
  if (!result.success) {
    buffer.writeStderr(`✖ 规则移除失败：${result.error}\n`);
    buffer.writeStderr(`  规则 ID: ${args.ruleId}\n`);
    return 1;
  }

  // 输出成功信息
  buffer.writeStdout(`✔ 规则已移除\n`);
  buffer.writeStdout(`  ID: ${args.ruleId}\n`);
  return 0;
}

/**
 * show 子命令：查看规则详情
 *
 * 输出规则的全部字段：ID、名称、描述、严重级别、来源、注入目标、
 * 正则模式、标签、是否可移除。
 *
 * @param args 命令参数
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功，1=失败）
 */
function executeShow(args: RulesCommandArgs, store: RuleStore, buffer: OutputBuffer): number {
  // 校验 ruleId 参数
  if (!args.ruleId || args.ruleId.trim().length === 0) {
    buffer.writeStderr("✖ /rules show 需要 --rule-id 参数\n用法: deepcodex rules show --rule-id <ID>\n");
    return 1;
  }

  // 查询规则
  const rule = store.getRuleById(args.ruleId);
  if (!rule) {
    buffer.writeStderr(`✖ 规则不存在\n`);
    buffer.writeStderr(`  规则 ID: ${args.ruleId}\n`);
    return 1;
  }

  // 输出规则详情
  buffer.writeStdout("规则详情\n");
  buffer.writeStdout("========================================\n");
  buffer.writeStdout(`ID: ${rule.id}\n`);
  buffer.writeStdout(`名称: ${rule.name}\n`);
  buffer.writeStdout(`描述: ${rule.description}\n`);
  buffer.writeStdout(`严重级别: ${rule.severity}\n`);
  buffer.writeStdout(`来源: ${rule.source}\n`);
  buffer.writeStdout(`注入目标: ${rule.injectionTargets.join(", ")}\n`);
  buffer.writeStdout(`正则模式: ${rule.pattern === null ? "（无，需推理判定）" : rule.pattern}\n`);
  buffer.writeStdout(`标签: ${rule.tags.join(", ")}\n`);
  buffer.writeStdout(`可移除: ${rule.removable ? "是" : "否"}\n`);
  return 0;
}

/**
 * path 子命令：显示规则文件路径
 *
 * 输出用户规则文件和项目规则文件的绝对路径。
 *
 * @param args 命令参数
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功）
 */
function executePath(args: RulesCommandArgs, store: RuleStore, buffer: OutputBuffer): number {
  buffer.writeStdout("规则文件路径\n");
  buffer.writeStdout("========================================\n");
  buffer.writeStdout(`用户规则文件: ${store.getUserRulesPath()}\n`);
  buffer.writeStdout(`项目规则文件: ${store.getProjectRulesPath()}\n`);
  buffer.writeStdout(`项目根目录: ${args.projectRoot}\n`);
  return 0;
}

// ============================================================================
// 主入口：executeRulesCommand
// ============================================================================

/**
 * 执行 /rules 命令
 *
 * 主入口函数，由 CLI 层（cli.tsx 或 App.tsx）调用。
 * 根据 subcommand 分发到对应的子命令实现。
 *
 * @param args 命令参数
 * @param printToTerminal 是否同时写入真实终端（默认 true）
 * @returns 命令执行结果（exitCode + stdout + stderr）
 */
export async function executeRulesCommand(
  args: RulesCommandArgs,
  printToTerminal: boolean = true
): Promise<RulesCommandResult> {
  // 创建输出缓冲器
  const buffer = new OutputBuffer(printToTerminal);

  // 创建 RuleStore 实例（绑定 projectRoot）
  const store = new RuleStore({ projectRoot: args.projectRoot });

  // 按子命令分发
  let exitCode: number;
  switch (args.subcommand) {
    case "list":
      executeList(store, buffer);
      exitCode = 0;
      break;
    case "add":
      exitCode = executeAdd(args, store, buffer);
      break;
    case "remove":
      exitCode = executeRemove(args, store, buffer);
      break;
    case "show":
      exitCode = executeShow(args, store, buffer);
      break;
    case "path":
      exitCode = executePath(args, store, buffer);
      break;
    default: {
      // 未知子命令（运行时防御，TS 类型层已保证合法）
      const sub = (args as { subcommand: string }).subcommand;
      buffer.writeStderr(`✖ 未知子命令: ${sub || "(空)"}\n可用子命令: list, add, remove, show, path\n`);
      exitCode = 1;
    }
  }

  return {
    exitCode,
    stdout: buffer.getStdout(),
    stderr: buffer.getStderr(),
  };
}
