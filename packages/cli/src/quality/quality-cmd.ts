/**
 * Quality 子命令 - 质量门禁 CLI 入口
 *
 * 来源：packages/quality（@deepcodex/quality）三大量检能力
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 支持的子命令：
 *   - codemap [path]      生成代码地图（默认子命令）
 *   - uiux                UI/UX 巡检（DOM 数据导入模式）
 *   - visual              视觉回归比对
 *   - all                 运行所有可用的质量检查
 *   - help                显示帮助
 *
 * 用法（CLI 模式）：
 *   deepcodex quality-check codemap ./packages/quality
 *   deepcodex quality-check uiux --dom-file ./dom.json
 *   deepcodex quality-check visual --baseline ./a.png --current ./b.png
 *
 * 用法（TUI 模式，由 App.tsx 调用）：
 *   /quality-check codemap
 *   /quality-check uiux --dom-file ./dom.json
 *
 * 设计原则：
 *   - 不依赖 mock：直接使用真实的 quality package 实例和文件系统
 *   - 输出缓冲：所有输出先收集到 OutputBuffer，再按 printToTerminal 决定是否写终端
 *   - 错误隔离：命令失败时返回 exitCode + stderr，不抛异常到调用方
 *   - 中文输出：所有面向用户的提示使用中文
 *   - 不可变优先：常量使用 Object.freeze 冻结，参数字段使用 readonly
 *
 * @module cli/quality/quality-cmd
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CodeMapGenerator,
  UIUXAnalyzer,
  VisualRegression,
  type CodeMap,
  type CodeMapOptions,
  type UIUXReport,
  type VisualRegressionOptions,
  type ImageAdapter,
  type DOMSignals,
} from "@deepcodex/quality";
import type { VisualDiffResult } from "@vegamo/deepcode-core";
import { FileBackedPageLike, FileBackedPageLikeError } from "./file-backed-page-like.js";
import { SharpImageAdapter, SharpImageAdapterError } from "./sharp-image-adapter.js";
import {
  formatCodeMapReport,
  formatUIUXReport,
  formatVisualReport,
  formatCombinedReport,
  type ReportFormat,
} from "./quality-formatter.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * /quality-check 子命令类型
 *
 * 5 个合法子命令：
 *   - codemap：生成代码地图（默认子命令，无参数时使用）
 *   - uiux：UI/UX 巡检（DOM 数据导入模式）
 *   - visual：视觉回归比对
 *   - all：运行所有可用检查
 *   - help：显示帮助
 */
export type QualitySubcommand = "codemap" | "uiux" | "visual" | "all" | "help";

/**
 * /quality-check 命令参数
 *
 * 由 parseQualityArgs 解析用户输入后构造，传递给 executeQualityCommand 执行。
 * 所有字段为 readonly，确保参数对象在传递过程中不被修改。
 */
export interface QualityCommandArgs {
  /** 子命令名称（默认 codemap） */
  readonly subcommand: QualitySubcommand;
  /** codemap 目标路径（相对 projectRoot 或绝对，默认当前目录） */
  readonly targetPath?: string;
  /** codemap 子目录白名单（仅分析该子目录） */
  readonly scope?: string;
  /** codemap 跳过目录（逗号分隔转数组） */
  readonly skipDirs?: string[];
  /** codemap 最大文件数（默认 5000） */
  readonly maxFiles?: number;
  /** codemap 单文件最大行数（默认 5000） */
  readonly maxLinesPerFile?: number;
  /** uiux DOM 数据 JSON 文件路径（必填） */
  readonly domFile?: string;
  /** uiux 对比度采样 JSON 文件路径（不传则从 domFile 读取 contrastSamples 字段） */
  readonly contrastFile?: string;
  /** visual 基线路径（文件或目录） */
  readonly baseline?: string;
  /** visual 当前图像路径（必填） */
  readonly current?: string;
  /** visual testId（默认 cli-quality） */
  readonly testId?: string;
  /** visual step 名（默认 compare） */
  readonly step?: string;
  /** visual 像素差异阈值（默认 0.01 = 1%） */
  readonly pixelThreshold?: number;
  /** visual SSIM 阈值（默认 0.95） */
  readonly ssimThreshold?: number;
  /** visual DOM 信号 JSON 文件路径 */
  readonly domSignalsFile?: string;
  /** 报告输出路径（默认 stdout） */
  readonly output?: string;
  /** 报告格式（默认 codemap=markdown，其他=text） */
  readonly format?: ReportFormat;
  /** 失败阈值（透传给子检查，覆盖默认阈值） */
  readonly threshold?: number;
  /** 项目根目录（默认 process.cwd()） */
  readonly projectRoot: string;
  /** 静默模式（仅输出结论，不输出明细） */
  readonly quiet?: boolean;
}

/**
 * 命令执行结果
 *
 * 与 RulesCommandResult 对齐：调用方按 exitCode 判断成功/失败，
 * 按 stdout/stderr 获取输出内容。
 */
export interface QualityCommandResult {
  /** 退出码：0=成功，1=检查未通过，2=参数错误，3=依赖缺失，4=内部错误 */
  readonly exitCode: number;
  /** 标准输出（报告内容） */
  readonly stdout: string;
  /** 标准错误（错误说明，成功时为空） */
  readonly stderr: string;
}

/**
 * 命令处理上下文（依赖注入）
 *
 * 用于注入 UIUXAnalyzer / VisualRegression / CodeMapGenerator 的工厂函数，
 * 支持可选注入（未注入时使用默认实现，降级场景由调用方处理）。
 *
 * 测试场景：测试代码通过 QualityHandlerContext 注入工厂函数（合法的依赖注入扩展点，非 mock），
 *           用于验证降级路径（如 createImageAdapter 返回 null 时 exitCode=3）或替换为真实实现。
 * 生产场景：未传入 context，使用默认实现（new CodeMapGenerator / new UIUXAnalyzer 等）。
 */
export interface QualityHandlerContext {
  /** CodeMapGenerator 工厂（默认：直接 new CodeMapGenerator） */
  readonly createCodeMapGenerator?: (options: CodeMapOptions) => CodeMapGenerator;
  /** UIUXAnalyzer 工厂（默认：直接 new UIUXAnalyzer） */
  readonly createUIUXAnalyzer?: () => UIUXAnalyzer;
  /** VisualRegression 工厂（默认：直接 new VisualRegression） */
  readonly createVisualRegression?: (options: VisualRegressionOptions) => VisualRegression;
  /** ImageAdapter 工厂（默认：SharpImageAdapter.create()；未安装 sharp 时返回 null） */
  readonly createImageAdapter?: () => Promise<ImageAdapter | null>;
}

// ============================================================================
// 常量定义（不可变）
// ============================================================================

/**
 * 合法的子命令名称数组
 *
 * 用于校验用户输入的子命令是否合法，防止拼写错误。
 */
const VALID_SUBCOMMANDS: ReadonlyArray<QualitySubcommand> = Object.freeze(["codemap", "uiux", "visual", "all", "help"]);

/**
 * 默认 testId（visual 子命令）
 */
const DEFAULT_TEST_ID = "cli-quality";

/**
 * 默认 step 名（visual 子命令）
 */
const DEFAULT_STEP = "compare";

/**
 * 默认像素差异阈值（visual 子命令）
 */
const DEFAULT_PIXEL_THRESHOLD = 0.01;

/**
 * 默认 SSIM 阈值（visual 子命令）
 */
const DEFAULT_SSIM_THRESHOLD = 0.95;

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
 *   - 测试时可关闭终端输出，通过返回值断言输出内容
 *   - TUI 模式（/quality-check）需要将输出作为消息内容返回，而非直接打印
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
// 主执行函数
// ============================================================================

/**
 * 执行 /quality-check 命令
 *
 * 与 executeRulesCommand 签名对齐：接收 args + printToTerminal，
 * 返回 QualityCommandResult（exitCode + stdout + stderr）。
 *
 * 流程：
 *   1. 创建 OutputBuffer 收集输出
 *   2. 根据 args.subcommand 分发到对应子命令处理函数
 *   3. 各子命令处理函数返回 exitCode
 *   4. 构造 QualityCommandResult 返回
 *
 * @param args 解析后的命令参数
 * @param context 依赖注入上下文（可选，用于测试替换）
 * @param printToTerminal 是否同时输出到终端（TUI 模式 false，CLI 模式 true）
 * @returns 退出码 + stdout + stderr
 */
export async function executeQualityCommand(
  args: QualityCommandArgs,
  context?: QualityHandlerContext,
  printToTerminal: boolean = true
): Promise<QualityCommandResult> {
  const buffer = new OutputBuffer(printToTerminal);
  let exitCode: number;

  try {
    switch (args.subcommand) {
      case "codemap":
        exitCode = await executeCodemapCommand(args, buffer, context);
        break;
      case "uiux":
        exitCode = await executeUiuxCommand(args, buffer, context);
        break;
      case "visual":
        exitCode = await executeVisualCommand(args, buffer, context);
        break;
      case "all":
        exitCode = await executeAllCommand(args, buffer, context);
        break;
      case "help":
        exitCode = executeHelpCommand(buffer);
        break;
      default: {
        // TypeScript exhaustiveness check：未知子命令应被参数解析拒绝
        const _exhaustive: never = args.subcommand;
        buffer.writeStderr(`未知的 quality-check 子命令: ${String(_exhaustive)}\n`);
        exitCode = 2;
      }
    }
  } catch (err) {
    // 兜底异常捕获：避免异常泄漏到调用方
    const message = err instanceof Error ? err.message : String(err);
    buffer.writeStderr(`✖ /quality-check 命令执行失败: ${message}\n`);
    exitCode = 4;
  }

  return {
    exitCode,
    stdout: buffer.getStdout(),
    stderr: buffer.getStderr(),
  };
}

// ============================================================================
// codemap 子命令实现
// ============================================================================

/**
 * 执行 codemap 子命令
 *
 * 流程：
 *   1. 解析 targetPath（默认当前目录）
 *   2. 构造 CodeMapOptions
 *   3. 创建 CodeMapGenerator 实例并调用 generate()
 *   4. 根据 format 格式化输出
 *   5. 若 output 指定，写入文件；否则输出到 stdout
 *
 * @param args 命令参数
 * @param buffer 输出缓冲器
 * @param context 依赖注入上下文
 * @returns 退出码（0=成功，2=参数错误，4=内部错误）
 */
async function executeCodemapCommand(
  args: QualityCommandArgs,
  buffer: OutputBuffer,
  context?: QualityHandlerContext
): Promise<number> {
  // Step 1: 解析 targetPath（默认当前目录）
  const projectRoot = args.projectRoot || process.cwd();
  const targetPath = args.targetPath
    ? path.isAbsolute(args.targetPath)
      ? args.targetPath
      : path.resolve(projectRoot, args.targetPath)
    : projectRoot;

  // 校验目标路径存在
  try {
    const stats = await fs.stat(targetPath);
    if (!stats.isDirectory()) {
      buffer.writeStderr(`✖ codemap 目标路径不是目录: ${targetPath}\n`);
      return 2;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      buffer.writeStderr(`✖ codemap 目标路径不存在: ${targetPath}\n`);
      return 2;
    }
    buffer.writeStderr(
      `✖ 检查 codemap 目标路径失败: ${targetPath} - ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 4;
  }

  // Step 2: 构造 CodeMapOptions
  const options: CodeMapOptions = {
    projectRoot: targetPath,
    scope: args.scope,
    skipDirs: args.skipDirs,
    maxFiles: args.maxFiles,
    maxLinesPerFile: args.maxLinesPerFile,
    generateMarkdown: true,
    generateJson: true,
  };

  // Step 3: 创建 CodeMapGenerator 实例并生成代码地图
  const generator = context?.createCodeMapGenerator
    ? context.createCodeMapGenerator(options)
    : new CodeMapGenerator(options);

  let map: CodeMap;
  try {
    map = await generator.generate();
  } catch (err) {
    buffer.writeStderr(`✖ 生成代码地图失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 4;
  }

  // Step 4: 格式化输出（codemap 默认 markdown）
  const format: ReportFormat = args.format ?? "markdown";
  // 当 format=markdown 时，使用 CodeMapGenerator.toMarkdown() 输出
  const markdownContent = format === "markdown" ? generator.toMarkdown(map) : undefined;
  const content = formatCodeMapReport(map, format, markdownContent);

  // Step 5: 输出（文件 or stdout）
  if (args.output) {
    try {
      const outputPath = path.isAbsolute(args.output) ? args.output : path.resolve(projectRoot, args.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, content, "utf-8");
      buffer.writeStdout(`✅ 代码地图已写入: ${outputPath}\n`);
      // 静默模式只输出结论
      if (!args.quiet) {
        buffer.writeStdout(`- 文件数: ${map.stats.fileCount}\n`);
        buffer.writeStdout(`- 节点数: ${map.nodes.length}\n`);
        buffer.writeStdout(`- 边数: ${map.edges.length}\n`);
        buffer.writeStdout(`- 死代码候选: ${map.stats.deadCodeCandidates.length} 个\n`);
      }
    } catch (err) {
      buffer.writeStderr(
        `✖ 写入代码地图文件失败: ${args.output} - ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 4;
    }
  } else {
    // stdout 输出完整报告
    buffer.writeStdout(content);
    buffer.writeStdout("\n");
  }

  return 0;
}

// ============================================================================
// uiux 子命令实现
// ============================================================================

/**
 * 执行 uiux 子命令
 *
 * 流程：
 *   1. 校验 domFile 必填
 *   2. 通过 FileBackedPageLike.fromFile 加载 DOM 数据
 *   3. 创建 UIUXAnalyzer 实例并调用 audit(page)
 *   4. 调用 analyzer.report() 获取 UIUXReport
 *   5. 根据 format 格式化输出
 *   6. 若 output 指定，写入文件；否则输出到 stdout
 *   7. 根据 high_count 判断 exitCode（>0 时返回 1）
 *
 * @param args 命令参数
 * @param buffer 输出缓冲器
 * @param context 依赖注入上下文
 * @returns 退出码（0=成功，1=检查未通过，2=参数错误，4=内部错误）
 */
async function executeUiuxCommand(
  args: QualityCommandArgs,
  buffer: OutputBuffer,
  context?: QualityHandlerContext
): Promise<number> {
  // Step 1: 校验 domFile 必填
  if (!args.domFile) {
    buffer.writeStderr("✖ uiux 子命令需要 --dom-file <path> 参数\n");
    buffer.writeStderr("用法: /quality-check uiux --dom-file ./dom.json\n");
    return 2;
  }

  // Step 2: 通过 FileBackedPageLike 加载 DOM 数据
  let page: FileBackedPageLike;
  try {
    page = await FileBackedPageLike.fromFile(args.domFile, args.contrastFile);
  } catch (err) {
    if (err instanceof FileBackedPageLikeError) {
      // 根据 err.code 返回不同的退出码
      switch (err.code) {
        case "FILE_NOT_FOUND":
        case "PARSE_ERROR":
        case "SCHEMA_ERROR":
          buffer.writeStderr(`✖ ${err.message}\n`);
          return 2;
        case "IO_ERROR":
        default:
          buffer.writeStderr(`✖ ${err.message}\n`);
          return 4;
      }
    }
    buffer.writeStderr(`✖ 加载 DOM 数据失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 4;
  }

  // Step 3: 创建 UIUXAnalyzer 并执行巡检
  const analyzer = context?.createUIUXAnalyzer ? context.createUIUXAnalyzer() : new UIUXAnalyzer();
  let report: UIUXReport;
  try {
    await analyzer.audit(page);
    report = analyzer.report();
  } catch (err) {
    buffer.writeStderr(`✖ UI/UX 巡检执行失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 4;
  }

  // Step 4: 格式化输出（uiux 默认 text）
  const format: ReportFormat = args.format ?? "text";
  const content = formatUIUXReport(report, format);

  // Step 5: 输出（文件 or stdout）
  if (args.output) {
    try {
      const projectRoot = args.projectRoot || process.cwd();
      const outputPath = path.isAbsolute(args.output) ? args.output : path.resolve(projectRoot, args.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, content, "utf-8");
      buffer.writeStdout(`✅ UI/UX 巡检报告已写入: ${outputPath}\n`);
      if (!args.quiet) {
        buffer.writeStdout(`- 综合评分: ${report.score}/100\n`);
        buffer.writeStdout(`- 是否通过: ${report.is_pass ? "✅ 通过" : "❌ 未通过"}\n`);
        buffer.writeStdout(
          `- 问题总数: ${report.total_issues} (HIGH=${report.high_count}, MEDIUM=${report.medium_count}, LOW=${report.low_count})\n`
        );
      }
    } catch (err) {
      buffer.writeStderr(
        `✖ 写入 UI/UX 巡检报告失败: ${args.output} - ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 4;
    }
  } else {
    // stdout 输出完整报告
    buffer.writeStdout(content);
    buffer.writeStdout("\n");
  }

  // Step 6: 根据 high_count 判断 exitCode
  // 用户可通过 --threshold 覆盖默认阈值（默认 0，即任何 HIGH 问题都视为未通过）
  const threshold = args.threshold ?? 0;
  if (report.high_count > threshold) {
    return 1;
  }
  return 0;
}

// ============================================================================
// visual 子命令实现
// ============================================================================

/**
 * 执行 visual 子命令
 *
 * 流程：
 *   1. 校验 current 必填（baseline 可选，缺失时自动保存为基线）
 *   2. 通过 SharpImageAdapter.create() 加载 sharp（未安装返回 exitCode=3）
 *   3. 加载 DOM 信号（可选）
 *   4. 构造 VisualRegressionOptions 并创建实例
 *   5. 调用 compare() 执行比对
 *   6. 根据 format 格式化输出
 *   7. 若 output 指定，写入文件；否则输出到 stdout
 *   8. 根据 pixelDiffRatio 判断 exitCode（超阈值返回 1）
 *
 * @param args 命令参数
 * @param buffer 输出缓冲器
 * @param context 依赖注入上下文
 * @returns 退出码（0=成功，1=检查未通过，2=参数错误，3=依赖缺失，4=内部错误）
 */
async function executeVisualCommand(
  args: QualityCommandArgs,
  buffer: OutputBuffer,
  context?: QualityHandlerContext
): Promise<number> {
  // Step 1: 校验 current 必填
  if (!args.current) {
    buffer.writeStderr("✖ visual 子命令需要 --current <path> 参数\n");
    buffer.writeStderr("用法: /quality-check visual --baseline ./a.png --current ./b.png\n");
    return 2;
  }

  // Step 2: 通过 SharpImageAdapter 加载 sharp
  let imageAdapter: ImageAdapter | null;
  if (context?.createImageAdapter) {
    // 测试场景：使用注入的工厂函数
    imageAdapter = await context.createImageAdapter();
  } else {
    // 生产场景：使用 SharpImageAdapter.create()
    try {
      imageAdapter = await SharpImageAdapter.create();
    } catch (err) {
      if (err instanceof SharpImageAdapterError && err.code === "SHARP_NOT_INSTALLED") {
        buffer.writeStderr(`✖ ${err.message}\n`);
        return 3;
      }
      buffer.writeStderr(`✖ 加载 sharp 失败: ${err instanceof Error ? err.message : String(err)}\n`);
      return 4;
    }
  }

  if (imageAdapter === null) {
    buffer.writeStderr(
      "✖ 视觉回归需要 sharp 依赖：请在 packages/cli 目录执行 `npm install sharp` 或 `npm install --include=optional sharp`\n"
    );
    return 3;
  }

  // Step 3: 加载 DOM 信号（可选）
  let domSignals: DOMSignals | undefined;
  if (args.domSignalsFile) {
    try {
      const signalsContent = await fs.readFile(args.domSignalsFile, "utf-8");
      domSignals = JSON.parse(signalsContent) as DOMSignals;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        buffer.writeStderr(`✖ DOM 信号文件不存在: ${args.domSignalsFile}\n`);
        return 2;
      }
      buffer.writeStderr(
        `✖ 加载 DOM 信号失败: ${args.domSignalsFile} - ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 4;
    }
  }

  // Step 4: 构造 VisualRegressionOptions
  const testId = args.testId ?? DEFAULT_TEST_ID;
  const step = args.step ?? DEFAULT_STEP;
  const pixelThreshold = args.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const ssimThreshold = args.ssimThreshold ?? DEFAULT_SSIM_THRESHOLD;

  // baseline 路径适配：
  //   - 用户传入 --baseline <path>：将其父目录作为 baselineDir
  //   - 未传入 --baseline：不设置 baselineDir（visualRegression 会创建 /nonexistent 路径）
  let baselineDir: string | undefined;
  if (args.baseline) {
    const baselineAbs = path.isAbsolute(args.baseline)
      ? args.baseline
      : path.resolve(args.projectRoot || process.cwd(), args.baseline);
    // 判断 baseline 是文件还是目录
    try {
      const stats = await fs.stat(baselineAbs);
      if (stats.isDirectory()) {
        baselineDir = baselineAbs;
      } else {
        // baseline 是文件：将其父目录作为 baselineDir
        baselineDir = path.dirname(baselineAbs);
      }
    } catch {
      // baseline 路径不存在：将其父目录作为 baselineDir（首次运行时自动创建基线）
      baselineDir = path.dirname(baselineAbs);
    }
  }

  const options: VisualRegressionOptions = {
    baselineDir,
    pixelThreshold,
    ssimThreshold,
    autoSaveBaseline: true,
    imageAdapter,
    logCallback: (level, message) => {
      // 日志写入 stderr（避免污染 stdout 的报告输出）
      const prefix = level === "ERROR" ? "✖" : level === "WARNING" ? "⚠️ " : "ℹ️";
      buffer.writeStderr(`  [visual:${level}] ${prefix} ${message}\n`);
    },
  };

  // Step 5: 创建 VisualRegression 实例并执行比对
  const visualRegression = context?.createVisualRegression
    ? context.createVisualRegression(options)
    : new VisualRegression(options);

  // 解析 current 路径为绝对路径
  const currentAbs = path.isAbsolute(args.current)
    ? args.current
    : path.resolve(args.projectRoot || process.cwd(), args.current);

  // 校验 current 文件存在
  try {
    await fs.access(currentAbs);
  } catch {
    buffer.writeStderr(`✖ 当前图像文件不存在: ${currentAbs}\n`);
    return 2;
  }

  let result: VisualDiffResult;
  try {
    result = await visualRegression.compare({
      currentScreenshot: currentAbs,
      testId,
      step,
      domSignals,
    });
  } catch (err) {
    buffer.writeStderr(`✖ 视觉回归比对执行失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 4;
  }

  // Step 6: 格式化输出（visual 默认 text）
  const format: ReportFormat = args.format ?? "text";
  const content = formatVisualReport(result, format);

  // Step 7: 输出（文件 or stdout）
  if (args.output) {
    try {
      const projectRoot = args.projectRoot || process.cwd();
      const outputPath = path.isAbsolute(args.output) ? args.output : path.resolve(projectRoot, args.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, content, "utf-8");
      buffer.writeStdout(`✅ 视觉回归报告已写入: ${outputPath}\n`);
      if (!args.quiet) {
        buffer.writeStdout(`- 像素差异比: ${(result.pixelDiffRatio * 100).toFixed(4)}%\n`);
        // ssimScore 是 optional 字段，未提供时显示 N/A
        buffer.writeStdout(`- SSIM 评分: ${result.ssimScore !== undefined ? result.ssimScore.toFixed(4) : "N/A"}\n`);
        buffer.writeStdout(`- 变化区域: ${result.changedRegions.length} 个\n`);
        buffer.writeStdout(`- 数据显示不全: ${result.dataIncomplete.length} 项\n`);
        buffer.writeStdout(`- 显示错误: ${result.displayErrors.length} 项\n`);
      }
    } catch (err) {
      buffer.writeStderr(
        `✖ 写入视觉回归报告失败: ${args.output} - ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 4;
    }
  } else {
    // stdout 输出完整报告
    buffer.writeStdout(content);
    buffer.writeStdout("\n");
  }

  // Step 8: 根据 pixelDiffRatio 判断 exitCode
  // 用户可通过 --threshold 覆盖默认阈值
  const threshold = args.threshold ?? pixelThreshold;
  if (result.pixelDiffRatio > threshold) {
    return 1;
  }
  return 0;
}

// ============================================================================
// all 子命令实现
// ============================================================================

/**
 * 执行 all 子命令
 *
 * 按 codemap → uiux → visual 顺序执行所有子命令：
 *   - 任一子命令失败时累积 stderr，但继续执行后续子命令
 *   - 最终 exitCode = max(各子命令 exitCode)
 *   - 单一报告合并输出（使用 formatCombinedReport）
 *
 * @param args 命令参数
 * @param buffer 输出缓冲器
 * @param context 依赖注入上下文
 * @returns 退出码（max(各子命令 exitCode)）
 */
async function executeAllCommand(
  args: QualityCommandArgs,
  buffer: OutputBuffer,
  context?: QualityHandlerContext
): Promise<number> {
  const sections: Array<{ title: string; content: string }> = [];
  const stderrAccumulator: string[] = [];
  let maxExitCode = 0;

  // 1) codemap 子命令
  const codemapResult = await executeQualityCommand({ ...args, subcommand: "codemap" }, context, false);
  if (codemapResult.stderr) {
    stderrAccumulator.push(`[codemap] ${codemapResult.stderr}`);
  }
  if (codemapResult.stdout) {
    sections.push({ title: "Code Map", content: codemapResult.stdout });
  }
  maxExitCode = Math.max(maxExitCode, codemapResult.exitCode);

  // 2) uiux 子命令（仅在 domFile 提供时执行）
  if (args.domFile) {
    const uiuxResult = await executeQualityCommand({ ...args, subcommand: "uiux" }, context, false);
    if (uiuxResult.stderr) {
      stderrAccumulator.push(`[uiux] ${uiuxResult.stderr}`);
    }
    if (uiuxResult.stdout) {
      sections.push({ title: "UI/UX Audit", content: uiuxResult.stdout });
    }
    maxExitCode = Math.max(maxExitCode, uiuxResult.exitCode);
  } else {
    // domFile 未提供时跳过 uiux（不视为错误）
    sections.push({
      title: "UI/UX Audit",
      content: "(skipped: --dom-file 未提供)",
    });
  }

  // 3) visual 子命令（仅在 current 提供时执行）
  if (args.current) {
    const visualResult = await executeQualityCommand({ ...args, subcommand: "visual" }, context, false);
    if (visualResult.stderr) {
      stderrAccumulator.push(`[visual] ${visualResult.stderr}`);
    }
    if (visualResult.stdout) {
      sections.push({ title: "Visual Regression", content: visualResult.stdout });
    }
    maxExitCode = Math.max(maxExitCode, visualResult.exitCode);
  } else {
    // current 未提供时跳过 visual（不视为错误）
    sections.push({
      title: "Visual Regression",
      content: "(skipped: --current 未提供)",
    });
  }

  // 合并报告输出
  const combinedContent = formatCombinedReport(sections);

  // 输出（文件 or stdout）
  if (args.output) {
    try {
      const projectRoot = args.projectRoot || process.cwd();
      const outputPath = path.isAbsolute(args.output) ? args.output : path.resolve(projectRoot, args.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, combinedContent, "utf-8");
      buffer.writeStdout(`✅ 全量质量检查报告已写入: ${outputPath}\n`);
    } catch (err) {
      buffer.writeStderr(
        `✖ 写入全量质量检查报告失败: ${args.output} - ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 4;
    }
  } else {
    buffer.writeStdout(combinedContent);
    buffer.writeStdout("\n");
  }

  // 输出累积的 stderr
  if (stderrAccumulator.length > 0) {
    buffer.writeStderr("\n⚠️ 子命令警告：\n");
    for (const line of stderrAccumulator) {
      buffer.writeStderr(`  ${line}\n`);
    }
  }

  return maxExitCode;
}

// ============================================================================
// help 子命令实现
// ============================================================================

/**
 * 执行 help 子命令
 *
 * 输出 /quality-check 的所有子命令与选项说明。
 *
 * @param buffer 输出缓冲器
 * @returns 退出码（0=成功）
 */
function executeHelpCommand(buffer: OutputBuffer): number {
  buffer.writeStdout(QUALITY_HELP_TEXT);
  return 0;
}

/**
 * 格式化 quality-check 帮助文本（供 CLI 顶级命令 `deepcode quality-check help` 使用）
 *
 * 设计原因：与 team-cmd.ts 的 formatTeamHelp / rules-cmd.ts 的 formatRulesHelp 保持一致的导出风格，
 * 让 cli.tsx 中的命令路由可以统一通过 `if (subcommand === "help") { stdout.write(formatXxxHelp()); exit(0); }` 模式处理。
 *
 * @returns 帮助文本字符串
 */
export function formatQualityHelp(): string {
  return QUALITY_HELP_TEXT;
}

/**
 * /quality-check 帮助文本
 */
const QUALITY_HELP_TEXT = `
DeepCodeX Quality Check - 质量门禁 CLI

用法:
  /quality-check <subcommand> [options]

子命令:
  codemap [path]                  生成代码地图（默认子命令）
  uiux                            UI/UX 巡检（DOM 数据导入模式）
  visual                          视觉回归比对
  all                             运行所有可用的质量检查
  help                            显示此帮助

通用选项:
  --output <path>                 报告输出路径（默认 stdout）
  --format <json|text|markdown>   报告格式（codemap 默认 markdown，其他默认 text）
  --threshold <number>            失败阈值（覆盖子命令默认阈值）
  --project-root <path>           项目根目录（默认 process.cwd()）
  --quiet                         静默模式（仅输出结论）

codemap 选项:
  [path]                          目标路径（默认当前目录）
  --scope <dir>                   子目录白名单
  --skip-dirs <a,b,c>             跳过目录（逗号分隔）
  --max-files <n>                 最大文件数（默认 5000）
  --max-lines <n>                 单文件最大行数（默认 5000）

uiux 选项:
  --dom-file <path>               DOM 数据 JSON 文件路径（必填）
  --contrast-file <path>          对比度采样 JSON 文件路径（可选）

visual 选项:
  --current <path>                当前图像路径（必填）
  --baseline <path>               基线图像路径（首次运行自动保存）
  --test-id <id>                  测试 ID（默认 cli-quality）
  --step <name>                   步骤名（默认 compare）
  --pixel-threshold <0-1>         像素差异阈值（默认 0.01）
  --ssim-threshold <0-1>          SSIM 阈值（默认 0.95）
  --dom-signals-file <path>       DOM 信号 JSON 文件路径

退出码:
  0 = 检查通过
  1 = 检查未通过（存在 HIGH 问题 / 差异超阈值）
  2 = 参数错误（缺必填参数 / 文件不存在 / 子命令未知）
  3 = 依赖缺失（visual 子命令未安装 sharp）
  4 = 内部错误（未捕获异常）

示例:
  /quality-check                                  # 生成当前项目代码地图
  /quality-check codemap ./packages/quality       # 生成指定目录代码地图
  /quality-check codemap --format json --output ./map.json
  /quality-check uiux --dom-file ./dom.json
  /quality-check uiux --dom-file ./dom.json --format markdown --output ./uiux.md
  /quality-check visual --baseline ./a.png --current ./b.png
  /quality-check all --dom-file ./dom.json --current ./b.png
  /quality-check help
`.trim();

// ============================================================================
// 参数解析函数（供 App.tsx 调用）
// ============================================================================

/**
 * 解析 /quality-check 命令参数为 QualityCommandArgs 对象
 *
 * 与 parseTeamArgs 同模式：
 *   1. 第一个非 -- token 作为子命令（默认 codemap）
 *   2. 子命令后若紧跟非 -- token，作为 targetPath（codemap 专用）
 *   3. --key value 形式的参数循环解析
 *   4. --skip-dirs a,b,c 逗号分隔转数组
 *   5. 数值参数做 Number() 转换与合法性校验
 *
 * @param tokens 命令 tokens（去除 "quality-check" 前缀后的参数数组）
 * @param projectRoot 项目根目录（默认 process.cwd()）
 * @returns QualityCommandArgs 对象
 */
export function parseQualityArgs(tokens: string[], projectRoot: string = process.cwd()): QualityCommandArgs {
  const raw: Record<string, unknown> = {};

  // 第一个 token 是子命令（默认 codemap）
  let subcommand: QualitySubcommand = "codemap";
  let remainingTokens = [...tokens];

  if (tokens.length > 0 && !tokens[0]!.startsWith("--")) {
    const first = tokens[0]!;
    if ((VALID_SUBCOMMANDS as ReadonlyArray<string>).includes(first)) {
      subcommand = first as QualitySubcommand;
      remainingTokens = tokens.slice(1);
    } else {
      // 未知子命令，仍保留原值让 executeQualityCommand 报错
      subcommand = first as QualitySubcommand;
      remainingTokens = tokens.slice(1);
    }
  }
  raw.subcommand = subcommand;

  // codemap 子命令的位置参数：第一个非 -- token 作为 targetPath
  if (subcommand === "codemap" && remainingTokens.length > 0 && !remainingTokens[0]!.startsWith("--")) {
    raw.targetPath = remainingTokens[0];
    remainingTokens = remainingTokens.slice(1);
  }

  // 解析 --key value 参数
  for (let i = 0; i < remainingTokens.length; i++) {
    const token = remainingTokens[i]!;
    if (!token.startsWith("--")) {
      // 跳过非 -- 前缀的 token（位置参数已处理）
      continue;
    }
    const key = token.slice(2);
    const nextToken = remainingTokens[i + 1];

    switch (key) {
      case "scope":
        if (nextToken) {
          raw.scope = nextToken;
          i++;
        }
        break;
      case "skip-dirs":
        if (nextToken) {
          // 逗号分隔转数组
          raw.skipDirs = nextToken
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "max-files":
        if (nextToken) {
          const n = Number(nextToken);
          if (Number.isFinite(n) && n > 0) {
            raw.maxFiles = n;
          }
          i++;
        }
        break;
      case "max-lines":
        if (nextToken) {
          const n = Number(nextToken);
          if (Number.isFinite(n) && n > 0) {
            raw.maxLinesPerFile = n;
          }
          i++;
        }
        break;
      case "dom-file":
        if (nextToken) {
          raw.domFile = nextToken;
          i++;
        }
        break;
      case "contrast-file":
        if (nextToken) {
          raw.contrastFile = nextToken;
          i++;
        }
        break;
      case "baseline":
        if (nextToken) {
          raw.baseline = nextToken;
          i++;
        }
        break;
      case "current":
        if (nextToken) {
          raw.current = nextToken;
          i++;
        }
        break;
      case "test-id":
        if (nextToken) {
          raw.testId = nextToken;
          i++;
        }
        break;
      case "step":
        if (nextToken) {
          raw.step = nextToken;
          i++;
        }
        break;
      case "pixel-threshold":
        if (nextToken) {
          const n = Number(nextToken);
          if (Number.isFinite(n) && n >= 0 && n <= 1) {
            raw.pixelThreshold = n;
          }
          i++;
        }
        break;
      case "ssim-threshold":
        if (nextToken) {
          const n = Number(nextToken);
          if (Number.isFinite(n) && n >= 0 && n <= 1) {
            raw.ssimThreshold = n;
          }
          i++;
        }
        break;
      case "dom-signals-file":
        if (nextToken) {
          raw.domSignalsFile = nextToken;
          i++;
        }
        break;
      case "output":
        if (nextToken) {
          raw.output = nextToken;
          i++;
        }
        break;
      case "format":
        if (nextToken) {
          const f = nextToken;
          if (f === "json" || f === "text" || f === "markdown") {
            raw.format = f;
          }
          i++;
        }
        break;
      case "threshold":
        if (nextToken) {
          const n = Number(nextToken);
          if (Number.isFinite(n) && n >= 0) {
            raw.threshold = n;
          }
          i++;
        }
        break;
      case "project-root":
        if (nextToken) {
          raw.projectRoot = nextToken;
          i++;
        }
        break;
      case "quiet":
        raw.quiet = true;
        break;
      default:
        // 未知参数忽略（容错）
        break;
    }
  }

  // 构造 QualityCommandArgs（projectRoot 优先使用参数中传入的，回退到函数参数）
  return {
    subcommand: raw.subcommand as QualitySubcommand,
    targetPath: raw.targetPath as string | undefined,
    scope: raw.scope as string | undefined,
    skipDirs: raw.skipDirs as string[] | undefined,
    maxFiles: raw.maxFiles as number | undefined,
    maxLinesPerFile: raw.maxLinesPerFile as number | undefined,
    domFile: raw.domFile as string | undefined,
    contrastFile: raw.contrastFile as string | undefined,
    baseline: raw.baseline as string | undefined,
    current: raw.current as string | undefined,
    testId: raw.testId as string | undefined,
    step: raw.step as string | undefined,
    pixelThreshold: raw.pixelThreshold as number | undefined,
    ssimThreshold: raw.ssimThreshold as number | undefined,
    domSignalsFile: raw.domSignalsFile as string | undefined,
    output: raw.output as string | undefined,
    format: raw.format as ReportFormat | undefined,
    threshold: raw.threshold as number | undefined,
    projectRoot: (raw.projectRoot as string | undefined) ?? projectRoot,
    quiet: raw.quiet as boolean | undefined,
  };
}
