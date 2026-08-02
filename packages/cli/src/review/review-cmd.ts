/**
 * Review 子命令 - 代码审查 CLI 入口
 *
 * 来源：docs/code-review-process-incident.md 行动项 A3
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 支持的子命令：
 *   - typecheck    仅运行类型检查（npm run typecheck / npx tsc --noEmit / cargo check 等）
 *   - lint         仅运行 lint（npx eslint . / ruff check / cargo clippy 等）
 *   - format       仅运行格式化检查（npx prettier --check . / ruff format --check 等）
 *   - full         运行所有可用检查（默认子命令）
 *   - help         显示帮助
 *
 * 用法（CLI 模式）：
 *   deepcode review                  # 默认 full，自动检测项目类型
 *   deepcode review typecheck        # 仅类型检查
 *   deepcode review lint             # 仅 lint
 *   deepcode review format           # 仅格式化检查
 *   deepcode review full             # 运行所有检查
 *   deepcode review help             # 显示帮助
 *
 * 用法（TUI 模式，由 App.tsx 调用）：
 *   /review                          # 默认 full
 *   /review typecheck
 *   /review lint
 *   /review format
 *   /review help
 *
 * 设计原则：
 *   - 不依赖 mock：直接使用真实的 child_process.execSync 执行命令
 *   - 工具验证优先：所有数字必须有真实命令输出作为证据（响应事件检讨 A1 约束）
 *   - 输出缓冲：所有输出先收集到 OutputBuffer，再按 printToTerminal 决定是否写终端
 *   - 错误隔离：命令失败时返回 exitCode + stderr，不抛异常到调用方
 *   - 中文输出：所有面向用户的提示使用中文
 *   - 不可变优先：常量使用 Object.freeze 冻结，参数字段使用 readonly
 *
 * @module cli/review/review-cmd
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, type SpawnSyncReturns } from "node:child_process";
import { formatReviewReport, type ReviewReportSection } from "./review-formatter.js";
// 架构师审查 L2 修复（2026-07-27）：OutputBuffer 提取到共享模块，避免与 quality-cmd.ts 代码重复
import { OutputBuffer } from "../common/output-buffer.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * /review 子命令类型
 *
 * 5 个合法子命令：
 *   - typecheck：仅运行类型检查
 *   - lint：仅运行 lint
 *   - format：仅运行格式化检查
 *   - full：运行所有可用检查（默认）
 *   - help：显示帮助
 */
export type ReviewSubcommand = "typecheck" | "lint" | "format" | "full" | "help";

/**
 * /review 命令参数
 *
 * 由 parseReviewArgs 解析用户输入后构造，传递给 executeReviewCommand 执行。
 * 所有字段为 readonly，确保参数对象在传递过程中不被修改。
 */
export interface ReviewCommandArgs {
  /** 子命令名称（默认 full） */
  readonly subcommand: ReviewSubcommand;
  /** 项目根目录（默认 process.cwd()） */
  readonly projectRoot: string;
  /** 静默模式（仅输出结论，不输出明细） */
  readonly quiet?: boolean;
  /** 输出格式（默认 markdown） */
  readonly format?: "markdown" | "text" | "json";
}

/**
 * 命令执行结果
 *
 * 与 QualityCommandResult 对齐：调用方按 exitCode 判断成功/失败，
 * 按 stdout/stderr 获取输出内容。
 */
export interface ReviewCommandResult {
  /** 退出码：0=通过，1=检查未通过，2=参数错误，3=依赖缺失，4=内部错误 */
  readonly exitCode: number;
  /** 标准输出（报告内容） */
  readonly stdout: string;
  /** 标准错误（错误说明，成功时为空） */
  readonly stderr: string;
}

/**
 * 单条工具命令的执行记录
 *
 * 用于在报告中提供"证据附注"——每个 [已验证] 结论必须附上对应的命令输出片段。
 */
export interface ToolCommandRecord {
  /** 实际执行的命令字符串 */
  readonly command: string;
  /** 命令退出码（null 表示超时或未运行） */
  readonly exitCode: number | null;
  /** 标准输出（截断到前 10000 字符避免内存爆炸） */
  readonly stdout: string;
  /** 标准错误（截断到前 5000 字符） */
  readonly stderr: string;
  /** 执行耗时（毫秒） */
  readonly durationMs: number;
  /** 是否超时 */
  readonly timedOut: boolean;
}

/**
 * 项目类型检测结果
 *
 * 通过检测标志性文件推断项目类型，决定使用哪套工具命令映射。
 */
export type ProjectType = "node" | "python" | "rust" | "go" | "unknown";

/**
 * 单个审查维度的执行结果
 *
 * 对应报告中每个章节（typecheck / lint / format），包含真实命令输出证据。
 */
export interface ReviewDimensionResult {
  /** 维度名称（如 "类型检查"） */
  readonly name: string;
  /** 子命令名（如 "typecheck"） */
  readonly subcommand: ReviewSubcommand | "help";
  /** 该维度是否通过（exitCode === 0） */
  readonly passed: boolean;
  /** 该维度执行的命令记录（可能多条，按优先级尝试） */
  readonly records: ReadonlyArray<ToolCommandRecord>;
  /** 该维度的简要结论（含数字与置信度标注） */
  readonly summary: string;
}

/**
 * 命令处理上下文（依赖注入）
 *
 * 用于注入工具命令执行函数，便于测试替换为真实实现（合法的依赖注入扩展点，非 mock）。
 * 生产场景：未传入 context，使用默认 execSync 实现。
 */
export interface ReviewHandlerContext {
  /**
   * 执行工具命令的工厂函数（默认：execSync 封装）
   *
   * 测试场景下可注入自定义实现，例如验证降级路径或固定输出。
   * 必须返回真实的 ToolCommandRecord，禁止返回 mock 数据。
   */
  readonly runToolCommand?: (command: string, options: RunToolCommandOptions) => ToolCommandRecord;
  /**
   * 命令执行超时（毫秒）
   *
   * 架构师审查 L3 修复（2026-07-27）：
   *   - 之前 executeDimension 调用 runToolCommand 时未透传 timeoutMs，
   *     导致测试场景无法单独配置超时，生产场景只能使用 DEFAULT_TIMEOUT_MS
   *   - 现在通过 context 注入可配置的超时值，便于测试控制
   *   - 默认值：DEFAULT_TIMEOUT_MS（120000ms = 2 分钟）
   */
  readonly timeoutMs?: number;
}

/**
 * runToolCommand 的选项
 */
export interface RunToolCommandOptions {
  /** 工作目录 */
  readonly cwd: string;
  /** 超时（毫秒，默认 120000 = 2 分钟） */
  readonly timeoutMs?: number;
}

// ============================================================================
// 常量定义（不可变）
// ============================================================================

/**
 * 合法的子命令名称数组
 *
 * 用于校验用户输入的子命令是否合法，防止拼写错误。
 */
const VALID_SUBCOMMANDS: ReadonlyArray<ReviewSubcommand> = Object.freeze([
  "typecheck",
  "lint",
  "format",
  "full",
  "help",
]);

/**
 * 默认子命令（无参数时使用）
 */
const DEFAULT_SUBCOMMAND: ReviewSubcommand = "full";

/**
 * 默认命令超时（2 分钟）
 *
 * 与 quality-cmd 的 codemap 超时保持一致，避免大型项目检查超时。
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * stdout 最大保留字符数默认值（避免内存爆炸）
 *
 * 架构师审查 L6 修复（2026-07-27）：
 *   - 默认值从 10_000 提升到 50_000，避免大型项目（如本仓库 705 文件、10703 个 ESLint errors）输出被过度截断
 *   - 支持通过环境变量 REVIEW_MAX_STDOUT_CHARS 自定义
 *   - 解析失败时回退到默认值
 *   - 使用懒求值（函数），确保运行时修改环境变量即时生效
 */
const DEFAULT_MAX_STDOUT_CHARS = 50_000;

/**
 * stderr 最大保留字符数默认值
 */
const DEFAULT_MAX_STDERR_CHARS = 5_000;

/**
 * 获取 stdout 最大保留字符数（懒求值，每次调用读取环境变量）
 *
 * 架构师审查 L6 修复：支持环境变量 REVIEW_MAX_STDOUT_CHARS 动态配置
 *
 * @returns stdout 最大字符数
 */
export function getMaxStdoutChars(): number {
  return parsePositiveInt(process.env.REVIEW_MAX_STDOUT_CHARS, DEFAULT_MAX_STDOUT_CHARS);
}

/**
 * 获取 stderr 最大保留字符数（懒求值，每次调用读取环境变量）
 *
 * @returns stderr 最大字符数
 */
export function getMaxStderrChars(): number {
  return parsePositiveInt(process.env.REVIEW_MAX_STDERR_CHARS, DEFAULT_MAX_STDERR_CHARS);
}

/**
 * 解析正整数环境变量，失败时回退到默认值
 *
 * @param value 环境变量字符串值
 * @param defaultValue 默认值（解析失败时使用）
 * @returns 解析后的正整数
 */
function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const num = parseInt(value, 10);
  if (Number.isNaN(num) || num <= 0) {
    return defaultValue;
  }
  return num;
}

// ============================================================================
// OutputBuffer：已提取到 ../common/output-buffer.ts（架构师审查 L2 修复）
// ============================================================================

// ============================================================================
// 参数解析
// ============================================================================

/**
 * 工具验证型 /review 命令已知的选项集合
 *
 * 用于 extractReviewNaturalLanguageTask 判断用户输入是否仍属于工具检查模式，
 * 还是已经进入自然语言任务描述。
 */
const KNOWN_REVIEW_OPTIONS: ReadonlySet<string> = Object.freeze(new Set(["--quiet", "--format", "--project-root"]));

/**
 * 从 /review 输入中提取自然语言任务描述
 *
 * 设计背景：
 *   /review 同时承担两种语义：
 *     1. 工具验证命令：/review [typecheck|lint|format|full|help] [options]
 *     2. 自然语言审查请求：/review 当前项目全部代码，并对照 gold comments ...
 *   原 parseReviewArgs 只要首 token 不是合法子命令就抛错，导致用户按直觉输入
 *   自然语言时报“非法的子命令”；即便使用 /review full 也会被当成项目根目录，
 *   在 benchmark 等无 package.json 的目录下报“无法识别项目类型”。
 *
 * 判定规则（按 token 顺序扫描）：
 *   - 空内容（仅 /review）=> 工具模式（默认 full），返回 undefined
 *   - 首 token 是合法子命令，后续 token 全部是已知选项或其参数 => 工具模式
 *   - 首 token 是已知选项（如 --quiet）=> 工具模式（默认 full）
 *   - 任何非选项 token 出现在子命令/选项之后 => 自然语言，返回 /review 后的原文
 *
 * 返回值：
 *   - undefined：输入应走工具验证模式（由 handleReviewSlashCommand 处理）
 *   - string：自然语言任务描述（不含前导 "/review"），应交回 LLM 流程
 *
 * @param text 用户输入的完整文本（如 "/review 当前工程代码"）
 * @returns 自然语言任务描述，或 undefined 表示工具模式
 */
export function extractReviewNaturalLanguageTask(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/review")) {
    return undefined;
  }

  const body = trimmed.slice("/review".length).trim();
  if (body === "") {
    // 仅输入 /review，按工具模式默认 full 处理
    return undefined;
  }

  const tokens = body.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] ?? "";
  const firstIsSubcommand = VALID_SUBCOMMANDS.includes(firstToken as ReviewSubcommand);

  let i = firstIsSubcommand ? 1 : 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    if (token.startsWith("--")) {
      // 未知选项视为自然语言（可能是任务描述中的文字）
      if (!KNOWN_REVIEW_OPTIONS.has(token)) {
        return firstIsSubcommand ? tokens.slice(1).join(" ") : body;
      }
      // --format / --project-root 需要下一个 token 作为参数
      if (token === "--format" || token === "--project-root") {
        if (i + 1 >= tokens.length) {
          return firstIsSubcommand ? tokens.slice(1).join(" ") : body;
        }
        i += 2;
      } else {
        i++;
      }
    } else {
      // 非选项 token 出现在子命令之后，说明是自然语言任务描述
      // 返回去掉子命令前缀后的任务描述，避免把 "full" 等词混入任务文本
      return firstIsSubcommand ? tokens.slice(1).join(" ") : body;
    }
  }

  // 所有 token 都被工具模式消费完毕
  return undefined;
}

/**
 * 解析 /review 命令参数
 *
 * 与 parseQualityArgs 设计对齐：接受 tokens 数组，返回 ReviewCommandArgs。
 * 支持的选项：
 *   --quiet                 静默模式
 *   --format <fmt>          输出格式（markdown / text / json）
 *   --project-root <path>   项目根目录（默认 process.cwd()）
 *
 * @param tokens 命令 tokens（已去除 "/review" 前缀）
 * @param defaultProjectRoot 默认项目根目录
 * @returns 解析后的参数对象
 */
export function parseReviewArgs(
  tokens: ReadonlyArray<string>,
  defaultProjectRoot: string = process.cwd()
): ReviewCommandArgs {
  // 第一个 token 是子命令（若为空或非合法子命令，则使用默认 full）
  let subcommand: ReviewSubcommand = DEFAULT_SUBCOMMAND;
  let quiet = false;
  let format: "markdown" | "text" | "json" = "markdown";
  let projectRoot = defaultProjectRoot;

  if (tokens.length > 0) {
    const first = tokens[0];
    // 仅当首 token 不以 "--" 开头时，才尝试作为子命令解析
    if (first && !first.startsWith("--")) {
      if (VALID_SUBCOMMANDS.includes(first as ReviewSubcommand)) {
        subcommand = first as ReviewSubcommand;
      } else {
        // 非法子命令：抛错由调用方处理
        throw new ReviewArgsError(`非法的子命令: ${first}（合法值: ${VALID_SUBCOMMANDS.join(" / ")}）`);
      }
    }
  }

  // 解析剩余选项
  // 架构师审查 L1 修复（2026-07-27）：将循环起始索引提取为独立变量，提升可读性
  // 起始索引判定：
  //   - 若 subcommand 已被首 token 设置（非默认值），或首 token 是 --option，则从 0 开始解析
  //   - 否则跳过首 token（已被作为子命令消费），从 1 开始解析
  const startIndex = subcommand !== DEFAULT_SUBCOMMAND || tokens[0]?.startsWith("--") ? 0 : 1;
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--quiet") {
      quiet = true;
    } else if (token === "--format") {
      const next = tokens[++i];
      if (next !== "markdown" && next !== "text" && next !== "json") {
        throw new ReviewArgsError(`--format 非法值: ${next ?? "(缺失)"}（合法值: markdown / text / json）`);
      }
      format = next;
    } else if (token === "--project-root") {
      const next = tokens[++i];
      if (!next) {
        throw new ReviewArgsError("--project-root 需要参数");
      }
      projectRoot = next;
    } else if (token.startsWith("--")) {
      throw new ReviewArgsError(`未知选项: ${token}`);
    }
  }

  return { subcommand, projectRoot, quiet, format };
}

/**
 * 参数解析错误
 *
 * 用于在 parseReviewArgs 中区分"参数错误"与其他错误，便于调用方按 exitCode=2 处理。
 */
export class ReviewArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewArgsError";
  }
}

// ============================================================================
// 项目类型检测
// ============================================================================

/**
 * 检测项目类型
 *
 * 通过检测标志性文件推断项目类型，决定使用哪套工具命令映射。
 * 优先级：node > python > rust > go > unknown
 *
 * @param projectRoot 项目根目录
 * @returns 项目类型
 */
export function detectProjectType(projectRoot: string): ProjectType {
  // Node.js / TypeScript 项目：检测 package.json
  if (fs.existsSync(path.join(projectRoot, "package.json"))) {
    return "node";
  }
  // Python 项目：检测 pyproject.toml / setup.py / requirements.txt
  if (
    fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(projectRoot, "setup.py")) ||
    fs.existsSync(path.join(projectRoot, "requirements.txt"))
  ) {
    return "python";
  }
  // Rust 项目：检测 Cargo.toml
  if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    return "rust";
  }
  // Go 项目：检测 go.mod
  if (fs.existsSync(path.join(projectRoot, "go.mod"))) {
    return "go";
  }
  return "unknown";
}

// ============================================================================
// 工具命令映射
// ============================================================================

/**
 * 获取指定项目类型与维度的候选命令列表
 *
 * 返回多个候选命令，按优先级排序。executeReviewCommand 会依次尝试，
 * 首个成功执行（exitCode !== 127 即命令存在）的命令作为该维度的结果。
 *
 * @param projectType 项目类型
 * @param dimension 维度（typecheck / lint / format）
 * @returns 候选命令数组（按优先级排序）
 */
export function getToolCommands(
  projectType: ProjectType,
  dimension: "typecheck" | "lint" | "format"
): ReadonlyArray<string> {
  switch (projectType) {
    case "node":
      switch (dimension) {
        case "typecheck":
          return Object.freeze(["npm run typecheck --silent", "npx tsc --noEmit"]);
        case "lint":
          return Object.freeze(["npm run lint --silent", "npx eslint ."]);
        case "format":
          return Object.freeze(["npx prettier --check ."]);
      }
      break;
    case "python":
      switch (dimension) {
        case "typecheck":
          return Object.freeze(["mypy .", "pyright"]);
        case "lint":
          return Object.freeze(["ruff check .", "flake8 ."]);
        case "format":
          return Object.freeze(["ruff format --check .", "black --check ."]);
      }
      break;
    case "rust":
      switch (dimension) {
        case "typecheck":
          return Object.freeze(["cargo check"]);
        case "lint":
          return Object.freeze(["cargo clippy -- -D warnings"]);
        case "format":
          return Object.freeze(["cargo fmt -- --check"]);
      }
      break;
    case "go":
      switch (dimension) {
        case "typecheck":
          return Object.freeze(["go build ./..."]);
        case "lint":
          return Object.freeze(["go vet ./...", "golangci-lint run"]);
        case "format":
          return Object.freeze(["gofmt -l ."]);
      }
      break;
    case "unknown":
    default:
      return Object.freeze([]);
  }
  return Object.freeze([]);
}

// ============================================================================
// 工具命令执行
// ============================================================================

/**
 * 默认的工具命令执行函数
 *
 * 使用 execSync 执行命令，捕获 stdout/stderr/exitCode。
 * 命令不存在（exitCode=127）时返回 null，由调用方尝试下一个候选命令。
 *
 * @param command 命令字符串
 * @param options 选项（cwd / timeoutMs）
 * @returns 命令执行记录，或 null（命令不存在）
 */
function defaultRunToolCommand(command: string, options: RunToolCommandOptions): ToolCommandRecord {
  const startTime = Date.now();
  try {
    const output = execSync(command, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return {
      command,
      exitCode: 0,
      stdout: truncate(output, getMaxStdoutChars()),
      stderr: "",
      durationMs: Date.now() - startTime,
      timedOut: false,
    };
  } catch (error: unknown) {
    // execSync 在非零退出码时抛出错误，错误对象包含 stdout/stderr/status
    const err = error as SpawnSyncReturns<string> & { status?: number; signal?: string | null };
    // 命令不存在（exitCode=127）→ 返回 null 由调用方尝试下一候选
    if (err.status === 127) {
      return {
        command,
        exitCode: 127,
        stdout: "",
        stderr: String(err.stderr ?? ""),
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    }
    // 超时（signal=SIGTERM）
    // 修复（2026-07-27 RV-10）：之前 `err.signal === null` 被误判为超时，
    // 但命令正常退出（非零退出码）时 signal 也是 null，导致 typecheck 检查失败被误标为"超时"
    // 正确判定：只有 signal === "SIGTERM" 才是 execSync 触发的超时
    if (err.signal === "SIGTERM") {
      return {
        command,
        exitCode: err.status ?? null,
        stdout: truncate(String(err.stdout ?? ""), getMaxStdoutChars()),
        stderr: truncate(String(err.stderr ?? ""), getMaxStderrChars()),
        durationMs: Date.now() - startTime,
        timedOut: true,
      };
    }
    // 其他非零退出码：命令存在但检查未通过
    return {
      command,
      exitCode: err.status ?? 1,
      stdout: truncate(String(err.stdout ?? ""), getMaxStdoutChars()),
      stderr: truncate(String(err.stderr ?? ""), getMaxStderrChars()),
      durationMs: Date.now() - startTime,
      timedOut: false,
    };
  }
}

/**
 * 截断字符串到指定长度，并附加截断提示
 *
 * @param text 原始文本
 * @param maxChars 最大字符数
 * @returns 截断后的文本（超出时附加截断提示）
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + `\n...（已截断，共 ${text.length} 字符，仅显示前 ${maxChars} 字符）`;
}

// ============================================================================
// 维度执行
// ============================================================================

/**
 * 执行单个维度的所有候选命令
 *
 * 按优先级依次尝试候选命令，首个 exitCode !== 127（命令存在）的命令作为该维度结果。
 * 若所有候选命令都不存在（exitCode=127），返回 records 数组中所有记录，passed=false。
 *
 * 架构师审查 L3 修复（2026-07-27）：新增 timeoutMs 参数，透传到 runToolCommand 选项
 *
 * @param dimension 维度名
 * @param subcommand 子命令名
 * @param projectType 项目类型
 * @param projectRoot 项目根目录
 * @param runToolCommand 命令执行函数
 * @param timeoutMs 命令超时（毫秒，可选，默认使用 DEFAULT_TIMEOUT_MS）
 * @returns 该维度的执行结果
 */
function executeDimension(
  dimension: "typecheck" | "lint" | "format",
  subcommand: ReviewSubcommand,
  projectType: ProjectType,
  projectRoot: string,
  runToolCommand: (command: string, options: RunToolCommandOptions) => ToolCommandRecord,
  timeoutMs?: number
): ReviewDimensionResult {
  const candidates = getToolCommands(projectType, dimension);
  const records: ToolCommandRecord[] = [];

  for (const command of candidates) {
    // L3 修复：透传 timeoutMs 到 runToolCommand，便于测试和生产场景控制超时
    const record = runToolCommand(command, { cwd: projectRoot, timeoutMs });
    records.push(record);

    // exitCode !== 127 表示命令存在（无论是否通过），作为该维度最终结果
    if (record.exitCode !== 127) {
      const passed = record.exitCode === 0;
      const summary = buildDimensionSummary(dimension, record);
      return {
        name: getDimensionName(dimension),
        subcommand,
        passed,
        records,
        summary,
      };
    }
    // exitCode === 127 表示命令不存在，继续尝试下一个候选
  }

  // 所有候选命令都不存在
  return {
    name: getDimensionName(dimension),
    subcommand,
    passed: false,
    records,
    summary: `[未验证] 未找到可用的 ${getDimensionName(dimension)} 工具（尝试过 ${candidates.length} 个候选命令均不存在）`,
  };
}

/**
 * 获取维度中文名
 */
function getDimensionName(dimension: "typecheck" | "lint" | "format"): string {
  switch (dimension) {
    case "typecheck":
      return "类型检查";
    case "lint":
      return "Lint 检查";
    case "format":
      return "格式化检查";
  }
}

/**
 * 构建维度简要结论
 *
 * 从命令输出中提取关键数字（errors / warnings / unformatted files 等），
 * 标注 [已验证] 置信度。
 *
 * 架构师审查 M3 修复（2026-07-27）：扩展正则模式，兼容多种工具输出格式
 *   - Prettier: "N files are not formatted" / "N file is not formatted"
 *   - Ruff:     "Would reformat: N files" / "Would reformat N files"
 *   - Black:    "would reformat N files"
 *   - gofmt:    输出文件列表（每行一个文件名），通过行数计数
 *   - cargo fmt: 输出 diff（无明确数字），unformattedCount 保持 null
 */
function buildDimensionSummary(dimension: "typecheck" | "lint" | "format", record: ToolCommandRecord): string {
  if (record.timedOut) {
    return `[不确定] ${getDimensionName(dimension)} 超时（耗时 ${record.durationMs}ms）`;
  }
  if (record.exitCode === 0) {
    return `[已验证] ${getDimensionName(dimension)} 通过（exitCode=0，耗时 ${record.durationMs}ms）`;
  }
  // 命令失败：从 stderr/stdout 提取关键数字
  const output = record.stderr + "\n" + record.stdout;
  const errorCount = extractNumber(output, /(\d+)\s+error/gi);
  const warningCount = extractNumber(output, /(\d+)\s+warning/gi);

  // M3 修复：未格式化文件数提取，兼容 Prettier / Ruff / Black 等多种工具输出格式
  const unformattedCount = extractUnformattedCount(output, record.command);

  const parts: string[] = [`[已验证] ${getDimensionName(dimension)} 未通过（exitCode=${record.exitCode}）`];
  if (errorCount !== null) parts.push(`错误数：${errorCount}`);
  if (warningCount !== null) parts.push(`警告数：${warningCount}`);
  if (unformattedCount !== null) parts.push(`未格式化文件数：${unformattedCount}`);
  parts.push(`耗时：${record.durationMs}ms`);
  return parts.join("，");
}

/**
 * 提取未格式化文件数（M3 修复：兼容多种工具输出格式）
 *
 * 支持的工具输出格式：
 *   - Prettier:  "N files are not formatted" / "N file is not formatted"
 *   - Ruff:      "Would reformat: N files" / "Would reformat N files"
 *   - Black:     "would reformat N files" / "N files would be reformatted"
 *   - gofmt:     输出文件列表（每行一个文件路径），通过非空行数计数
 *   - cargo fmt: 输出 diff（无明确数字），返回 null
 *
 * @param output 命令输出文本（stderr + stdout）
 * @param command 执行的命令字符串（用于工具类型推断）
 * @returns 未格式化文件数，或 null（无法提取）
 */
function extractUnformattedCount(output: string, command: string): number | null {
  // Prettier 格式：N files are not formatted / N file is not formatted
  const prettierMatch = extractNumber(output, /(\d+)\s+file(?:s)?\s+(?:are\s+)?not\s+formatted/gi);
  if (prettierMatch !== null) {
    return prettierMatch;
  }

  // Ruff / Black 格式：Would reformat: N files / would reformat N files
  const ruffBlackMatch = extractNumber(output, /(?:would|will)\s+reformat:?\s*(\d+)\s+file/gi);
  if (ruffBlackMatch !== null) {
    return ruffBlackMatch;
  }

  // Black 替代格式：N files would be reformatted
  const blackAltMatch = extractNumber(output, /(\d+)\s+files?\s+would\s+be\s+reformatted/gi);
  if (blackAltMatch !== null) {
    return blackAltMatch;
  }

  // gofmt 格式：输出文件列表（每行一个文件路径），通过非空行数计数
  // 仅当命令包含 "gofmt" 且输出不为空时尝试
  if (command.includes("gofmt") && output.trim().length > 0) {
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) => line.length > 0 && !line.startsWith("diff ") && !line.startsWith("---") && !line.startsWith("+++")
      );
    if (lines.length > 0) {
      return lines.length;
    }
  }

  // 无法提取（如 cargo fmt 输出 diff 无明确数字）
  return null;
}

/**
 * 从文本中提取匹配的数字
 *
 * 用于从命令输出中提取 errors / warnings / unformatted files 等数字。
 * 取所有匹配中的最大值（通常是总结行而非过程行）。
 *
 * @param text 命令输出文本
 * @param pattern 正则模式（必须含捕获组 1 = 数字）
 * @returns 数字或 null（无匹配）
 */
function extractNumber(text: string, pattern: RegExp): number | null {
  const matches = text.matchAll(pattern);
  let max: number | null = null;
  for (const match of matches) {
    const num = parseInt(match[1] ?? "", 10);
    if (!Number.isNaN(num) && (max === null || num > max)) {
      max = num;
    }
  }
  return max;
}

// ============================================================================
// 主 handler
// ============================================================================

/**
 * 执行 /review 命令
 *
 * 流程：
 *   1. 解析参数（已由 parseReviewArgs 完成）
 *   2. 处理 help 子命令：返回帮助文本
 *   3. 检测项目类型
 *   4. 按子命令执行对应维度
 *   5. 生成报告
 *   6. 返回 exitCode + stdout + stderr
 *
 * @param args 命令参数
 * @param context 依赖注入上下文（可选）
 * @param printToTerminal 是否同时写入终端（CLI 模式=true，TUI 模式=false）
 * @returns 命令执行结果
 */
export async function executeReviewCommand(
  args: ReviewCommandArgs,
  context: ReviewHandlerContext = {},
  printToTerminal: boolean = true
): Promise<ReviewCommandResult> {
  const buffer = new OutputBuffer(printToTerminal);
  const runToolCommand = context.runToolCommand ?? defaultRunToolCommand;

  try {
    // help 子命令：直接返回帮助文本
    if (args.subcommand === "help") {
      buffer.writeStdout(formatReviewHelp());
      return {
        exitCode: 0,
        stdout: buffer.getStdout(),
        stderr: buffer.getStderr(),
      };
    }

    // 检测项目类型
    const projectType = detectProjectType(args.projectRoot);

    if (projectType === "unknown") {
      const msg = `✖ 无法识别项目类型（在 ${args.projectRoot} 下未找到 package.json / pyproject.toml / Cargo.toml / go.mod）`;
      buffer.writeStderr(msg + "\n");
      return {
        exitCode: 2, // 参数错误：项目类型未知
        stdout: buffer.getStdout(),
        stderr: buffer.getStderr(),
      };
    }

    // 按子命令执行对应维度
    const sections: ReviewReportSection[] = [];
    const dimensionsToRun: ReadonlyArray<"typecheck" | "lint" | "format"> =
      args.subcommand === "full"
        ? Object.freeze(["typecheck", "lint", "format"])
        : Object.freeze([args.subcommand as "typecheck" | "lint" | "format"]);

    let overallPassed = true;
    for (const dimension of dimensionsToRun) {
      // L3 修复：透传 context.timeoutMs 到 executeDimension，便于测试控制超时
      const result = executeDimension(
        dimension,
        args.subcommand,
        projectType,
        args.projectRoot,
        runToolCommand,
        context.timeoutMs
      );
      if (!result.passed) {
        overallPassed = false;
      }
      sections.push({
        name: result.name,
        subcommand: result.subcommand,
        passed: result.passed,
        records: result.records,
        summary: result.summary,
      });
    }

    // 生成报告
    const report = formatReviewReport({
      projectType,
      projectRoot: args.projectRoot,
      reviewTime: new Date().toISOString(),
      scope: args.subcommand,
      sections,
      quiet: args.quiet ?? false,
      format: args.format ?? "markdown",
    });
    buffer.writeStdout(report);

    // 总体退出码判定（架构师审查 M1 修复，2026-07-27）：
    //   - 0 = 通过（所有维度检查通过）
    //   - 1 = 检查未通过（至少一个维度检查未通过，但工具可用）
    //   - 3 = 依赖缺失（所有维度的所有候选命令都返回 127=命令不存在）
    //
    // 判定优先级：先检查"全部依赖缺失"（exitCode=3），再回退到"检查未通过"（exitCode=1）
    // 这样可以避免"环境未安装工具"被误判为"代码检查未通过"，影响 CI/CD 决策
    //
    // 判定条件：
    //   1. 至少执行了一个维度（sections.length > 0）
    //   2. 每个维度都有命令记录（records.length > 0）
    //   3. 所有命令记录的 exitCode 都是 127（命令不存在）
    const allDependenciesMissing =
      sections.length > 0 && sections.every((s) => s.records.length > 0 && s.records.every((r) => r.exitCode === 127));

    if (allDependenciesMissing) {
      // 依赖缺失：所有候选命令都不可用，无法执行真实检查
      // 报告中各维度会标注 [未验证]，退出码 3 便于 CI/CD 区分"环境问题"与"代码问题"
      return {
        exitCode: 3,
        stdout: buffer.getStdout(),
        stderr: buffer.getStderr(),
      };
    }

    // 总体退出码：0=通过，1=检查未通过
    return {
      exitCode: overallPassed ? 0 : 1,
      stdout: buffer.getStdout(),
      stderr: buffer.getStderr(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    buffer.writeStderr(`✖ /review 命令执行失败：${message}\n`);
    return {
      exitCode: 4, // 内部错误
      stdout: buffer.getStdout(),
      stderr: buffer.getStderr(),
    };
  }
}

/**
 * 格式化 /review 帮助文本
 *
 * @returns 帮助文本
 */
export function formatReviewHelp(): string {
  return `DeepCodeX 代码审查命令（/review）

用法：
  /review [subcommand] [options]
  /review <自然语言审查任务>
  deepcode review [subcommand] [options]

子命令：
  typecheck    仅运行类型检查（npm run typecheck / npx tsc --noEmit / cargo check 等）
  lint         仅运行 lint（npx eslint . / ruff check . / cargo clippy 等）
  format       仅运行格式化检查（npx prettier --check . / ruff format --check 等）
  full         运行所有可用检查（默认子命令）
  help         显示此帮助

自然语言模式：
  当 /review 后的内容不是合法子命令或仅包含工具选项时，系统会将其视为自然语言
  代码审查任务，直接交给 LLM 处理。例如：
    /review 当前项目全部代码，并对照 gold comments 评估准确率与召回率

选项：
  --quiet                 静默模式（仅输出结论，不输出明细）
  --format <fmt>          输出格式（markdown / text / json，默认 markdown）
  --project-root <path>   项目根目录（默认 process.cwd()）

退出码：
  0  检查通过
  1  检查未通过（有错误或警告）
  2  参数错误（项目类型未知或子命令非法）
  3  依赖缺失（无可用工具）
  4  内部错误

支持的项目类型：
  - Node.js / TypeScript（package.json）
  - Python（pyproject.toml / setup.py / requirements.txt）
  - Rust（Cargo.toml）
  - Go（go.mod）

示例：
  /review                          # 默认 full，自动检测项目类型
  /review typecheck                # 仅类型检查
  /review lint                     # 仅 lint
  /review format                   # 仅格式化检查
  /review full --quiet             # 运行所有检查，仅输出结论
  /review full --format json       # JSON 格式输出
  /review 当前项目全部代码，并对照 gold comments 评估准确率与召回率
                                   # 自然语言代码审查任务（不走工具检查）
  deepcode review help             # CLI 模式显示帮助

设计原则：
  - 工具验证优先：所有数字必须有真实命令输出作为证据
  - 三档置信度：[已验证] / [未验证] / [不确定]
  - 证据附注：每个 [已验证] 结论附命令输出片段
`;
}
