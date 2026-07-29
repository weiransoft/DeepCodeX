/**
 * Rules 子命令 - RLIS 规则管理 CLI
 *
 * EAG 方案 §5.5 规则学习与注入系统（RLIS）的命令行入口。
 * 提供 /rules <subcommand> 形式的规则管理能力，支持：
 * - list：列出三层规则（种子 / 用户 / 项目）
 * - add：添加用户规则或项目规则（自动生成 USER-xxx / PROJ-xxx ID）
 * - remove：提示用户手动编辑规则文件移除规则（新 RLIS API 不支持运行时删除）
 * - show：查看规则详情
 * - path：显示规则文件路径
 *
 * 调用方：
 * - packages/cli/src/cli.tsx —— 非 TUI 模式（deepcode rules list）
 * - packages/cli/src/ui/views/App.tsx —— TUI 模式（/rules list）
 *
 * 设计原则：
 * - 不依赖 mock：直接使用真实的 RuleStore 实例和文件系统
 * - 文件持久化：新 RuleStore 为纯内存版，本模块负责读写规则文件
 *   - 全局用户层：~/.deepcodeX/rules/global-rules.json
 *   - 项目层：<projectRoot>/.deepcode/rules/project-rules.json
 * - 输出缓冲：所有输出先收集到 OutputBuffer，再按 printToTerminal 决定是否写终端
 * - 错误隔离：命令失败时返回 exitCode=1 + stderr 错误说明，不抛异常到调用方
 * - 中文输出：所有面向用户的提示使用中文
 * - 不可变优先：常量使用 Object.freeze 冻结，UserRule 字段使用 readonly
 *
 * @module cli/rules/rules-cmd
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { RuleStore, SEED_RULES, type UserRule, type RuleSeverity, type RuleCategory } from "@vegamo/deepcode-core";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * /rules 子命令类型
 *
 * 5 个合法子命令：
 * - list：列出三层规则
 * - add：添加规则
 * - remove：提示手动编辑规则文件移除规则
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
  readonly subcommand: RulesSubcommand;
  /** add 子命令的规则内容（必需） */
  readonly content?: string;
  /** remove / show 子命令的规则 ID（必需） */
  readonly ruleId?: string;
  /** add 子命令的严重级别（默认 MAJOR，大写形式） */
  readonly severity?: RuleSeverity;
  /** add 子命令的存储层（默认 user；决定 ID 前缀与持久化文件） */
  readonly layer?: "user" | "project";
  /** 项目根目录（用于定位 .deepcode/rules/project-rules.json） */
  readonly projectRoot: string;
}

/**
 * 命令执行结果
 *
 * 所有子命令统一返回此结构，调用方按 exitCode 判断成功/失败，
 * 按 stdout/stderr 获取输出内容。
 */
export interface RulesCommandResult {
  /** 退出码：0=成功，1=失败 */
  readonly exitCode: number;
  /** 标准输出（命令的常规输出） */
  readonly stdout: string;
  /** 标准错误（错误说明，成功时为空） */
  readonly stderr: string;
}

// ============================================================================
// 常量定义（不可变，使用 Object.freeze 冻结）
// ============================================================================

/**
 * 全局用户层规则目录绝对路径
 *
 * 对应 EAG 方案 §5.5.2 三层规则存储表的全局用户层。
 * 跨项目生效的个人偏好规则存放于此目录下。
 */
const GLOBAL_RULES_DIR: string = path.join(os.homedir(), ".deepcodeX", "rules");

/**
 * 全局用户层规则文件绝对路径
 *
 * 存放用户通过 /rules add 添加的 USER-xxx 规则（source=user-explicit）。
 * 文件格式为 JSON 数组，每个元素为一条 UserRule 对象。
 */
const GLOBAL_RULES_FILE: string = path.join(GLOBAL_RULES_DIR, "global-rules.json");

/**
 * 项目层规则目录相对路径（相对于 projectRoot）
 *
 * 对应 EAG 方案 §5.5.2 三层规则存储表的项目层。
 * 项目级约束规则存放于此目录下，优先级最高，覆盖同名全局/种子规则。
 */
const PROJECT_RULES_DIR_REL: string = path.join(".deepcode", "rules");

/**
 * 项目层规则文件名
 *
 * 存放项目通过 /rules add --layer project 添加的 PROJ-xxx 规则。
 */
const PROJECT_RULES_FILE_NAME: string = "project-rules.json";

/**
 * 用户通过 CLI 添加规则时的默认分类
 *
 * 多数用户添加的规则为「代码真实性」类（禁止某写法），
 * 故默认分类为 code-truth。如需其他分类可后续扩展 --category 参数。
 */
const DEFAULT_USER_RULE_CATEGORY: RuleCategory = "code-truth";

/**
 * 用户通过 CLI 添加规则时的默认严重级别
 *
 * 用户添加的规则默认为 MAJOR 级（打回但可人工豁免），
 * 与种子规则多数规则级别一致。
 */
const DEFAULT_USER_RULE_SEVERITY: RuleSeverity = "MAJOR";

/**
 * 冻结的合法存储层标识数组
 *
 * 用于校验 layer 参数合法性，防止拼写错误。
 */
const VALID_LAYERS: ReadonlyArray<"user" | "project"> = Object.freeze(["user", "project"]);

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
// 文件 I/O 辅助函数（新 RuleStore 为纯内存版，需 CLI 层负责持久化）
// ============================================================================

/**
 * 获取项目层规则文件绝对路径
 *
 * 项目层规则文件位于 <projectRoot>/.deepcode/rules/project-rules.json，
 * 存放 PROJ-xxx 规则（优先级最高，覆盖同名全局/种子规则）。
 *
 * @param projectRoot 项目根目录
 * @returns 项目层规则文件绝对路径
 */
function getProjectRulesFile(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_RULES_DIR_REL, PROJECT_RULES_FILE_NAME);
}

/**
 * 从 JSON 文件读取规则列表
 *
 * 文件格式为 UserRule 对象的 JSON 数组。
 * 文件不存在或格式非法时返回空数组（容错处理，避免命令因文件缺失而失败）。
 *
 * @param filePath 规则文件绝对路径
 * @returns 规则列表（文件不存在/格式非法时返回空数组）
 */
function readRulesFromFile(filePath: string): UserRule[] {
  // 文件不存在时返回空数组（首次使用时文件尚未创建）
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    // 校验解析结果为数组
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 逐条校验为合法 UserRule 对象（含必需字段）
    return parsed.filter((item: unknown): item is UserRule => {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as UserRule).id === "string" &&
        typeof (item as UserRule).category === "string" &&
        typeof (item as UserRule).severity === "string" &&
        typeof (item as UserRule).content === "string" &&
        typeof (item as UserRule).source === "string" &&
        typeof (item as UserRule).confirmedBy === "string" &&
        typeof (item as UserRule).usageCount === "number" &&
        typeof (item as UserRule).violationCount === "number" &&
        typeof (item as UserRule).createdAt === "string"
      );
    });
  } catch {
    // JSON 解析失败时返回空数组（容错）
    return [];
  }
}

/**
 * 将规则列表写入 JSON 文件
 *
 * 自动创建父目录（若不存在）。文件格式为 UserRule 对象的 JSON 数组，
 * 缩进 2 空格便于人工查看与编辑。
 *
 * @param filePath 规则文件绝对路径
 * @param rules 待写入的规则列表
 */
function writeRulesToFile(filePath: string, rules: ReadonlyArray<UserRule>): void {
  // 确保父目录存在（递归创建）
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // 写入 JSON 数组（缩进 2 空格）
  const json = JSON.stringify(rules, null, 2);
  fs.writeFileSync(filePath, json, "utf8");
}

/**
 * 从文件系统构造 RuleStore 实例
 *
 * 读取全局用户层与项目层规则文件，与内置种子层合并构造 RuleStore。
 * 三层规则存储优先级：project > global > seed（同 ID 规则高优先级覆盖低优先级）。
 *
 * @param projectRoot 项目根目录（用于定位项目层规则文件）
 * @returns 已合并三层的 RuleStore 实例
 */
function createStore(projectRoot: string): RuleStore {
  // 读取全局用户层规则（~/.deepcodeX/rules/global-rules.json）
  const globalRules = readRulesFromFile(GLOBAL_RULES_FILE);
  // 读取项目层规则（<projectRoot>/.deepcode/rules/project-rules.json）
  const projectRules = readRulesFromFile(getProjectRulesFile(projectRoot));
  // 构造 RuleStore：seedRules 必填，globalRules 与 projectRules 可选
  return new RuleStore(SEED_RULES, globalRules, projectRules);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 自动生成规则 ID
 *
 * ID 格式：USER-xxx 或 PROJ-xxx（xxx 为 3 位数字，从 001 开始递增）。
 * 通过扫描生效规则集中同前缀 ID，找到最大编号 +1。
 *
 * 注意：新 RLIS API 通过 store.getEffectiveRules() 获取合并后的规则列表，
 * 已包含三层（种子 / 全局 / 项目）合并去重后的规则。
 *
 * @param store RuleStore 实例（用于查询已有规则）
 * @param layer 目标存储层（决定前缀 USER / PROJ）
 * @returns 新规则 ID
 */
function generateRuleId(store: RuleStore, layer: "user" | "project"): string {
  // 前缀：user 层 → USER，project 层 → PROJ
  const prefix = layer === "user" ? "USER" : "PROJ";
  // 获取合并后的生效规则列表，扫描同前缀 ID 找最大编号
  const effectiveRules = store.getEffectiveRules();
  let maxNum = 0;
  for (const rule of effectiveRules) {
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
    "用法: deepcode rules <subcommand> [options]",
    "      /rules <subcommand> [args]          # TUI 模式",
    "",
    "RLIS 规则学习与注入系统：管理三层规则（种子 / 用户 / 项目）",
    "",
    "子命令：",
    "  list                              列出所有生效规则（按严重级别分组）",
    "  add --content <内容>               添加规则（默认 user 层，severity=MAJOR）",
    "  remove --rule-id <ID>              提示手动编辑规则文件移除规则（新 API 不支持运行时删除）",
    "  show --rule-id <ID>                查看规则详情",
    "  path                              显示规则文件路径",
    "",
    "可选参数（仅 add 子命令）：",
    "  --severity <BLOCKER|MAJOR|WARNING>  严重级别（默认 MAJOR，大写形式）",
    "  --layer <user|project>              存储层（默认 user；决定 ID 前缀与持久化文件）",
    "  --project-root <路径>               项目根目录（默认当前目录）",
    "",
    "示例：",
    "  deepcode rules list",
    '  deepcode rules add --content "禁止使用 var 声明变量" --severity BLOCKER',
    "  deepcode rules remove --rule-id USER-001",
    "  deepcode rules show --rule-id SEED-01",
    "  deepcode rules path",
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
 *   - N：合并去重后生效规则数（getEffectiveRules().length）
 *   - X/Y/Z：三层各自规则数（getSnapshot()）
 * - 按 severity 分组：BLOCKER 级（不可豁免）、MAJOR 级、WARNING 级
 * - 每条规则：[ID] (category) content
 *
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 */
function executeList(store: RuleStore, buffer: OutputBuffer): void {
  // 获取合并后生效规则列表（已按 severity 排序，BLOCKER 优先）
  const effectiveRules = store.getEffectiveRules();
  // 获取三层存储快照（用于统计各层规则数）
  const snapshot = store.getSnapshot();
  const seedCount = snapshot.seedRules.length;
  const userCount = snapshot.globalRules.length;
  const projectCount = snapshot.projectRules.length;

  // 标题
  buffer.writeStdout("生效规则清单\n");
  buffer.writeStdout("========================================\n");
  // 统计行
  buffer.writeStdout(
    `共 ${effectiveRules.length} 条（种子 ${seedCount} / 用户 ${userCount} / 项目 ${projectCount}）\n\n`
  );

  // 按 severity 分组（新 API 使用大写形式）
  const blockerRules = effectiveRules.filter((r) => r.severity === "BLOCKER");
  const majorRules = effectiveRules.filter((r) => r.severity === "MAJOR");
  const warningRules = effectiveRules.filter((r) => r.severity === "WARNING");

  // BLOCKER 级（不可豁免）
  if (blockerRules.length > 0) {
    buffer.writeStdout("## BLOCKER 级（不可豁免）\n");
    for (const rule of blockerRules) {
      buffer.writeStdout(`- [${rule.id}] (${rule.category}) ${rule.content}\n`);
    }
    buffer.writeStdout("\n");
  }

  // MAJOR 级
  if (majorRules.length > 0) {
    buffer.writeStdout("## MAJOR 级\n");
    for (const rule of majorRules) {
      buffer.writeStdout(`- [${rule.id}] (${rule.category}) ${rule.content}\n`);
    }
    buffer.writeStdout("\n");
  }

  // WARNING 级
  if (warningRules.length > 0) {
    buffer.writeStdout("## WARNING 级\n");
    for (const rule of warningRules) {
      buffer.writeStdout(`- [${rule.id}] (${rule.category}) ${rule.content}\n`);
    }
    buffer.writeStdout("\n");
  }
}

/**
 * add 子命令：添加规则
 *
 * 自动生成 USER-xxx 或 PROJ-xxx ID，将规则写入对应存储层文件。
 * 规则字段（完整 UserRule 对象）：
 * - id：自动生成（USER-xxx / PROJ-xxx）
 * - category：默认 code-truth（用户添加规则多为代码真实性类）
 * - severity：参数指定（默认 MAJOR，大写形式）
 * - content：用户输入的规则正文
 * - source：固定 user-explicit（addUserRule 会强制覆盖）
 * - confirmedBy：固定 auto（用户显式添加无需确认，addUserRule 会强制覆盖）
 * - usageCount：初始化为 0
 * - violationCount：初始化为 0
 * - createdAt：当前时间 ISO 8601 字符串
 *
 * 持久化策略：
 * - layer=user → 写入 ~/.deepcodeX/rules/global-rules.json（ID 前缀 USER）
 * - layer=project → 写入 <projectRoot>/.deepcode/rules/project-rules.json（ID 前缀 PROJ）
 *
 * 注意：新 RLIS API 的 RuleStore.addUserRule 为纯内存操作，
 * 本函数额外将规则持久化到对应文件，保证下次命令执行时能加载到。
 *
 * @param args 命令参数
 * @param store RuleStore 实例（用于 ID 生成与唯一性校验）
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功，1=失败）
 */
function executeAdd(args: RulesCommandArgs, store: RuleStore, buffer: OutputBuffer): number {
  // 校验 content 参数
  if (!args.content || args.content.trim().length === 0) {
    buffer.writeStderr("✖ /rules add 需要 --content 参数\n用法: deepcode rules add --content <内容>\n");
    return 1;
  }

  // 目标存储层（默认 user；校验合法性）
  const layer: "user" | "project" = args.layer ?? "user";
  if (!VALID_LAYERS.includes(layer)) {
    buffer.writeStderr(`✖ 无效的存储层: ${layer}\n合法值: user, project\n`);
    return 1;
  }

  // 严重级别（默认 MAJOR；新 API 使用大写形式）
  const severity: RuleSeverity = args.severity ?? DEFAULT_USER_RULE_SEVERITY;

  // 自动生成 ID（USER-xxx 或 PROJ-xxx）
  const ruleId = generateRuleId(store, layer);

  // 构造完整的 UserRule 对象（含 category/content/confirmedBy/usageCount/violationCount/createdAt）
  const rule: UserRule = Object.freeze({
    id: ruleId,
    category: DEFAULT_USER_RULE_CATEGORY,
    severity,
    content: args.content,
    source: "user-explicit",
    confirmedBy: "auto",
    usageCount: 0,
    violationCount: 0,
    createdAt: new Date().toISOString(),
  });

  // 调用 RuleStore.addUserRule 添加到内存存储（会校验 ID 唯一性，重复时抛错）
  // 注意：新 API 不区分 user/project 层添加，统一通过 source 字段标识（source=user-explicit）
  try {
    store.addUserRule(rule);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    buffer.writeStderr(`✖ 规则添加失败：${message}\n`);
    return 1;
  }

  // 持久化到对应文件（新 RuleStore 为纯内存版，需 CLI 层负责文件 I/O）
  const targetFile = layer === "user" ? GLOBAL_RULES_FILE : getProjectRulesFile(args.projectRoot);
  const existingRules = readRulesFromFile(targetFile);
  writeRulesToFile(targetFile, [...existingRules, rule]);

  // 输出成功信息
  const layerLabel = layer === "user" ? "用户层" : "项目层";
  buffer.writeStdout(`✔ 规则已添加（${layerLabel}）\n`);
  buffer.writeStdout(`  ID: ${ruleId}\n`);
  buffer.writeStdout(`  分类: ${rule.category}\n`);
  buffer.writeStdout(`  严重级别: ${severity}\n`);
  buffer.writeStdout(`  内容: ${rule.content}\n`);
  buffer.writeStdout(`  存储文件: ${targetFile}\n`);
  return 0;
}

/**
 * remove 子命令：提示手动编辑规则文件移除规则
 *
 * 新 RLIS API 不支持运行时删除规则（设计上需手动编辑规则文件），
 * 本命令保留入口以兼容 CLI 调用，输出提示消息指引用户手动编辑。
 *
 * 提示内容：
 * - 规则 ID（用户传入的）
 * - 全局用户层文件路径（USER-xxx 规则所在）
 * - 项目层文件路径（PROJ-xxx 规则所在）
 * - 操作指引（编辑对应文件，删除规则对象）
 *
 * @param args 命令参数
 * @param store RuleStore 实例（未使用，保留参数以保持签名一致）
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功；1=缺少 ruleId 参数）
 */
function executeRemove(args: RulesCommandArgs, _store: RuleStore, buffer: OutputBuffer): number {
  // 校验 ruleId 参数
  if (!args.ruleId || args.ruleId.trim().length === 0) {
    buffer.writeStderr("✖ /rules remove 需要 --rule-id 参数\n用法: deepcode rules remove --rule-id <ID>\n");
    return 1;
  }

  // 新 API 不支持运行时删除，输出手动编辑指引
  buffer.writeStdout(`ℹ 规则移除需手动编辑规则文件\n`);
  buffer.writeStdout(`  规则 ID: ${args.ruleId}\n`);
  buffer.writeStdout(`  全局用户层文件: ${GLOBAL_RULES_FILE}\n`);
  buffer.writeStdout(`  项目层文件: ${getProjectRulesFile(args.projectRoot)}\n`);
  buffer.writeStdout(`  操作指引: 编辑上述对应文件，删除该规则对象后保存即可\n`);
  buffer.writeStdout(`  提示: USER-xxx 规则在全局用户层文件，PROJ-xxx 规则在项目层文件，SEED-xxx 规则为内置不可删除\n`);
  return 0;
}

/**
 * show 子命令：查看规则详情
 *
 * 输出规则的完整字段：ID、分类、严重级别、内容、来源、确认来源、
 * 注入次数、违规次数、创建时间。
 *
 * 新 API 字段（替代旧 API 的 name/description/injectionTargets/pattern/tags/removable）：
 * - category：规则分类（code-truth/comment-style/process-gate/change-control/project-structure/quality-gate）
 * - content：规则正文（替代旧 description）
 * - source：规则来源（builtin-seed/user-explicit/learned）
 * - confirmedBy：确认来源（user/auto）
 * - usageCount：注入次数统计
 * - violationCount：违规次数统计
 * - createdAt：创建时间（ISO 8601）
 *
 * @param args 命令参数
 * @param store RuleStore 实例
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功，1=失败）
 */
function executeShow(args: RulesCommandArgs, store: RuleStore, buffer: OutputBuffer): number {
  // 校验 ruleId 参数
  if (!args.ruleId || args.ruleId.trim().length === 0) {
    buffer.writeStderr("✖ /rules show 需要 --rule-id 参数\n用法: deepcode rules show --rule-id <ID>\n");
    return 1;
  }

  // 用 getRuleById 查询（新 API，替代旧 API 的遍历查找）
  const rule = store.getRuleById(args.ruleId);
  if (!rule) {
    buffer.writeStderr(`✖ 规则不存在\n`);
    buffer.writeStderr(`  规则 ID: ${args.ruleId}\n`);
    return 1;
  }

  // 输出规则详情（新字段：category/content/severity/source/confirmedBy/usageCount/violationCount/createdAt）
  buffer.writeStdout("规则详情\n");
  buffer.writeStdout("========================================\n");
  buffer.writeStdout(`ID: ${rule.id}\n`);
  buffer.writeStdout(`分类: ${rule.category}\n`);
  buffer.writeStdout(`严重级别: ${rule.severity}\n`);
  buffer.writeStdout(`内容: ${rule.content}\n`);
  buffer.writeStdout(`来源: ${rule.source}\n`);
  buffer.writeStdout(`确认来源: ${rule.confirmedBy}\n`);
  buffer.writeStdout(`注入次数: ${rule.usageCount}\n`);
  buffer.writeStdout(`违规次数: ${rule.violationCount}\n`);
  buffer.writeStdout(`创建时间: ${rule.createdAt}\n`);
  return 0;
}

/**
 * path 子命令：显示规则文件路径
 *
 * 新 RLIS API 无 getUserRulesPath/getProjectRulesPath 方法，
 * 改为返回固定路径字符串：
 * - 全局用户层：~/.deepcodeX/rules/global-rules.json
 * - 项目层：<projectRoot>/.deepcode/rules/project-rules.json
 *
 * @param args 命令参数
 * @param _store RuleStore 实例（未使用，保留参数以保持签名一致）
 * @param buffer 输出缓冲
 * @returns 退出码（0=成功）
 */
function executePath(args: RulesCommandArgs, _store: RuleStore, buffer: OutputBuffer): number {
  const projectRulesFile = getProjectRulesFile(args.projectRoot);
  buffer.writeStdout("规则文件路径\n");
  buffer.writeStdout("========================================\n");
  buffer.writeStdout(`全局用户层文件: ${GLOBAL_RULES_FILE}\n`);
  buffer.writeStdout(`项目层文件: ${projectRulesFile}\n`);
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

  // 从文件系统构造 RuleStore 实例（绑定 projectRoot，合并三层规则）
  const store = createStore(args.projectRoot);

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
