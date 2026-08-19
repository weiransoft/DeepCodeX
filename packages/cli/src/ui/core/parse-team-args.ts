/**
 * parse-team-args.ts - TUI /team 命令参数解析（纯函数）
 *
 * 来源：从 App.tsx 内联实现抽取（S2 优化项，2026-08-19）
 * 抽取目的：
 *   1. 使 TUI 参数解析逻辑可独立单元测试（此前内联于 App.tsx 无法直接测）
 *   2. 修复 failFast 三态语义：旧实现仅在 raw.failFast === true 时置位，
 *      无法表达 false（--no-fail-fast 不可达），与 CLI 入口（cli.tsx 默认 true、
 *      --no-fail-fast 可关）语义不一致
 *
 * fail-fast 语义（S2 统一判定，与 team-cmd.ts 消费端一致）：
 *   - 未指定            → failFast = true（默认快速失败）
 *   - --fail-fast       → failFast = true
 *   - --no-fail-fast    → failFast = false（部分失败时继续执行并汇总）
 *
 * 严格遵循 user rules：禁止 mock/占位/简化
 */

import type { TeamCommandArgs, TeamSubcommand } from "../../team/team-cmd";

/**
 * 解析 /team 命令参数为 TeamCommandArgs 对象
 *
 * 支持的参数：
 * - subcommand（位置参数）：list / match / dispatch / autonomous / full-lifecycle（默认 list）
 * - --role <roleId>          强制指定角色
 * - --task <text>            任务描述
 * - --task-file <path>       任务文件路径
 * - --goal <text>             项目目标
 * - --keywords <kw1,kw2,...>  关键词（match 模式，逗号分隔）
 * - --max-iterations <n>      最大迭代次数
 * - --force-role              禁用自动匹配
 * - --consensus               共识模式
 * - --fail-fast               失败时中止（默认开启）
 * - --no-fail-fast            失败时继续（显式关闭 fail-fast）
 * - --project-root <path>     项目根目录
 * - --resume-run               断点续跑
 * - --use-loop                 启用循环模式
 * - --prd-path <path>          PRD 文档路径
 * - --architecture-path <path> 架构文档路径
 * - --test-plan-path <path>    测试计划路径
 * - --test-command <cmd>       测试命令
 *
 * @param tokens 命令 tokens（去除 "team" 前缀后的参数数组）
 * @returns TeamCommandArgs 对象（subcommand 必填，其他字段按需填充；
 *          failFast 恒为 boolean——未指定时默认 true，与 CLI 入口语义一致）
 */
export function parseTeamArgs(tokens: string[]): TeamCommandArgs {
  // 使用 Record<string, unknown> 中间存储，最后构造 TeamCommandArgs
  const raw: Record<string, unknown> = {};

  // 第一个 token 是子命令（默认 "list"）
  let subcommand: TeamSubcommand = "list";
  if (tokens.length > 0 && !tokens[0]!.startsWith("--")) {
    const first = tokens[0]!;
    // 校验子命令合法性（与 team-cmd.ts 的 TeamSubcommand 类型对齐）
    if (
      first === "list" ||
      first === "match" ||
      first === "dispatch" ||
      first === "autonomous" ||
      first === "full-lifecycle"
    ) {
      subcommand = first;
      tokens = tokens.slice(1);
    } else {
      // 未知子命令，仍保留原值让 executeTeamCommand 报错（exhaustiveness check）
      subcommand = first as TeamSubcommand;
      tokens = tokens.slice(1);
    }
  }
  raw.subcommand = subcommand;

  // 解析 --key value 参数
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith("--")) {
        // 值参数
        raw[key] = nextToken;
        i++;
      } else {
        // 布尔参数
        raw[key] = true;
      }
    }
  }

  // --keywords 逗号分隔转数组（match 子命令使用）
  if (typeof raw.keywords === "string") {
    raw.keywords = (raw.keywords as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // camelCase 转换：CLI 风格参数名转 TeamCommandArgs 字段名
  // --task-file → taskFile, --max-iterations → maxIterations,
  // --force-role → forceRole, --fail-fast → failFast,
  // --no-fail-fast → noFailFast（S2 新增，用于显式关闭 fail-fast）,
  // --project-root → projectRoot, --resume-run → resumeRun,
  // --use-loop → useLoop, --prd-path → prdPath, --architecture-path → architecturePath,
  // --test-plan-path → testPlanPath, --test-command → testCommand
  const kebabToCamelMap: Record<string, string> = {
    "task-file": "taskFile",
    "max-iterations": "maxIterations",
    "force-role": "forceRole",
    "fail-fast": "failFast",
    "no-fail-fast": "noFailFast",
    "project-root": "projectRoot",
    "resume-run": "resumeRun",
    "use-loop": "useLoop",
    "prd-path": "prdPath",
    "architecture-path": "architecturePath",
    "test-plan-path": "testPlanPath",
    "test-command": "testCommand",
  };
  for (const [kebab, camel] of Object.entries(kebabToCamelMap)) {
    if (raw[kebab] !== undefined) {
      raw[camel] = raw[kebab];
      delete raw[kebab];
    }
  }

  // --max-iterations 字符串转数字
  // 注意：必须在 kebab→camel 转换之后执行——解析循环存储的原始键为
  // "max-iterations"，转换前 raw.maxIterations 恒为 undefined（TPA-008 修复）
  if (typeof raw.maxIterations === "string") {
    const n = Number.parseInt(raw.maxIterations as string, 10);
    if (!Number.isNaN(n)) {
      raw.maxIterations = n;
    } else {
      delete raw.maxIterations;
    }
  }

  // S2 fail-fast 三态归一：
  //   --no-fail-fast（解析为 noFailFast=true）→ failFast=false；
  //   其余情况（未指定 / --fail-fast）→ failFast=true（默认快速失败）
  if (raw.noFailFast === true) {
    raw.failFast = false;
  }

  // 构造 TeamCommandArgs 对象（仅包含已解析的字段，避免 undefined 字段污染）
  // 注意：此处使用对象展开 + 条件包含，确保类型安全
  const args: TeamCommandArgs = { subcommand };
  if (typeof raw.role === "string") {
    args.role = raw.role as TeamCommandArgs["role"];
  }
  if (typeof raw.task === "string") {
    args.task = raw.task;
  }
  if (typeof raw.taskFile === "string") {
    args.taskFile = raw.taskFile;
  }
  if (typeof raw.goal === "string") {
    args.goal = raw.goal;
  }
  if (Array.isArray(raw.keywords)) {
    args.keywords = raw.keywords as string[];
  }
  if (typeof raw.maxIterations === "number") {
    args.maxIterations = raw.maxIterations;
  }
  if (raw.forceRole === true) {
    args.forceRole = true;
  }
  if (raw.consensus === true) {
    args.consensus = true;
  }
  // failFast 恒定归一（S2）：仅 --no-fail-fast 显式关闭为 false，其余为 true。
  // 旧实现 `raw.failFast === true` 才置位导致 TUI 无法表达 false，已修正
  args.failFast = raw.failFast !== false;
  if (typeof raw.projectRoot === "string") {
    args.projectRoot = raw.projectRoot;
  }
  if (raw.resumeRun === true) {
    args.resumeRun = true;
  }
  if (raw.useLoop === true) {
    args.useLoop = true;
  }
  if (typeof raw.prdPath === "string") {
    args.prdPath = raw.prdPath;
  }
  if (typeof raw.architecturePath === "string") {
    args.architecturePath = raw.architecturePath;
  }
  if (typeof raw.testPlanPath === "string") {
    args.testPlanPath = raw.testPlanPath;
  }
  if (typeof raw.testCommand === "string") {
    args.testCommand = raw.testCommand;
  }

  return args;
}
