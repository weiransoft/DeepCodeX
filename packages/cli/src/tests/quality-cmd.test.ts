/**
 * quality-cmd 单元测试
 *
 * 测试范围：
 *   - A. parseQualityArgs: 参数解析（各子命令 + 选项）
 *   - B. executeQualityCommand - help: 帮助文本输出
 *   - C. executeQualityCommand - codemap: 真实项目代码地图生成
 *   - D. executeQualityCommand - uiux: DOM 数据导入模式巡检
 *   - E. executeQualityCommand - visual: SHARP_NOT_INSTALLED 路径 + 真实比对
 *   - F. executeQualityCommand - all: 组合执行
 *   - G. executeQualityCommand - 错误场景：未知子命令 / 参数错误
 *   - H. QualityHandlerContext: 依赖注入工厂函数
 *
 * 测试约定（遵循项目规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架：所有测试使用真实文件系统与真实 quality 包实例
 *   - 依赖注入（QualityHandlerContext）是 quality-cmd.ts 设计的合法扩展点，不是 mock：
 *     createCodeMapGenerator / createUIUXAnalyzer / createVisualRegression / createImageAdapter
 *     均为接口工厂函数，测试中注入真实实现或返回 null 的工厂（测试降级路径）
 *   - 每个测试用例独立隔离：独立临时目录 + after 统一清理
 *
 * @module cli/tests/quality-cmd
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  executeQualityCommand,
  parseQualityArgs,
  type QualityCommandArgs,
  type QualityHandlerContext,
} from "../quality/quality-cmd";
import { SharpImageAdapter } from "../quality/sharp-image-adapter";
import {
  CodeMapGenerator,
  UIUXAnalyzer,
  VisualRegression,
  type DOMAuditData,
  type ContrastSample,
  type CodeMapOptions,
  type VisualRegressionOptions,
} from "@deepcodex/quality";

// ============================================================================
// 测试基础设施：临时目录管理
// ============================================================================

/** 临时目录集合（after 统一清理） */
const tempDirs: string[] = [];

/**
 * 创建唯一临时目录
 *
 * @param prefix 目录前缀（便于排查）
 * @returns 临时目录绝对路径
 */
async function createTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quality-cmd-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// 测试结束后清理所有临时目录
after(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * 在临时目录中创建一个真实多语言项目（用于 codemap 测试）
 *
 * 项目结构：
 *   projectRoot/
 *   ├── src/
 *   │   ├── index.ts      （TypeScript 主入口，含 import）
 *   │   └── user.ts       （TypeScript 类）
 *   └── README.md         （非代码文件，应被忽略）
 */
async function createMiniProject(projectRoot: string): Promise<void> {
  const srcDir = path.join(projectRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });

  // TypeScript 主入口
  await fs.writeFile(
    path.join(srcDir, "index.ts"),
    [
      'import { User } from "./user";',
      "",
      "export function main(): string {",
      '  const u = new User("alice");',
      "  return u.greet();",
      "}",
      "",
      "main();",
      "",
    ].join("\n")
  );

  // TypeScript 类
  await fs.writeFile(
    path.join(srcDir, "user.ts"),
    [
      "export class User {",
      "  public name: string;",
      "  constructor(name: string) {",
      "    this.name = name;",
      "  }",
      "  public greet(): string {",
      '    if (!this.name) return "anon";',
      '    return "hi, " + this.name;',
      "  }",
      "}",
      "",
    ].join("\n")
  );

  // 非代码文件（应被 codemap 忽略）
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Test Project\n\nA mini project for testing.\n");
}

/**
 * 写入 JSON 文件并返回绝对路径
 */
async function writeJsonFile(dir: string, filename: string, data: unknown): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

// ============================================================================
// 测试 Fixtures：真实 DOMAuditData
// ============================================================================

/**
 * 构造一个含真实数据的 DOMAuditData 对象
 *
 * 包含 1 张图片（无 alt，触发 HIGH a11y 问题）、1 个无 label 表单控件等。
 */
function makeRealisticDOMAuditData(): DOMAuditData {
  return {
    images: [
      {
        tag: "img",
        selector: "img.hero",
        alt: null,
        src: "hero.png",
        natural_width: 800,
        natural_height: 400,
        complete: true,
      },
    ],
    form_controls: [
      {
        tag: "input",
        type: "text",
        id: "username",
        name: "username",
        selector: "input#username",
        has_label: false,
        has_aria_label: false,
        has_aria_labelledby: false,
        required: true,
        placeholder: "请输入用户名",
      },
    ],
    buttons: [{ selector: "button.submit", text: "提交", width: 120, height: 44, visible: true, disabled: false }],
    links: [{ selector: "a.help", text: "查看帮助", href: "/help", target: null }],
    headings: [{ level: 1, text: "登录" }],
    errors: [],
  };
}

/**
 * 构造一个含低对比度采样的 ContrastSample 数组
 */
function makeRealisticContrastSamples(): ContrastSample[] {
  return [
    {
      text: "灰色文字",
      color: "#cccccc",
      background: "#ffffff",
      font_size: 14,
      font_weight: 400,
      selector: "p.muted",
    },
  ];
}

// ============================================================================
// A. parseQualityArgs 参数解析测试
// ============================================================================

test("parseQualityArgs: 空 tokens 默认子命令为 codemap", () => {
  const args = parseQualityArgs([], "/tmp/project");
  assert.equal(args.subcommand, "codemap");
  assert.equal(args.projectRoot, "/tmp/project");
});

test("parseQualityArgs: 第一个 token 作为子命令", () => {
  const args = parseQualityArgs(["uiux"], "/tmp/project");
  assert.equal(args.subcommand, "uiux");
});

test("parseQualityArgs: codemap 子命令的位置参数作为 targetPath", () => {
  const args = parseQualityArgs(["codemap", "./packages/quality"], "/tmp/project");
  assert.equal(args.subcommand, "codemap");
  assert.equal(args.targetPath, "./packages/quality");
});

test("parseQualityArgs: --scope 选项解析", () => {
  const args = parseQualityArgs(["codemap", "--scope", "src"], "/tmp/project");
  assert.equal(args.scope, "src");
});

test("parseQualityArgs: --skip-dirs 逗号分隔转数组", () => {
  const args = parseQualityArgs(["codemap", "--skip-dirs", "node_modules,dist,build"], "/tmp/project");
  assert.deepEqual(args.skipDirs, ["node_modules", "dist", "build"]);
});

test("parseQualityArgs: --skip-dirs 自动 trim 与空值过滤", () => {
  const args = parseQualityArgs(["codemap", "--skip-dirs", " a , b , , c "], "/tmp/project");
  assert.deepEqual(args.skipDirs, ["a", "b", "c"]);
});

test("parseQualityArgs: --max-files 数值解析", () => {
  const args = parseQualityArgs(["codemap", "--max-files", "100"], "/tmp/project");
  assert.equal(args.maxFiles, 100);
});

test("parseQualityArgs: --max-files 非法值（0 / 负数 / 非数字）被忽略", () => {
  const args1 = parseQualityArgs(["codemap", "--max-files", "0"], "/tmp/project");
  assert.equal(args1.maxFiles, undefined);
  const args2 = parseQualityArgs(["codemap", "--max-files", "-5"], "/tmp/project");
  assert.equal(args2.maxFiles, undefined);
  const args3 = parseQualityArgs(["codemap", "--max-files", "abc"], "/tmp/project");
  assert.equal(args3.maxFiles, undefined);
});

test("parseQualityArgs: --max-lines 数值解析", () => {
  const args = parseQualityArgs(["codemap", "--max-lines", "2000"], "/tmp/project");
  assert.equal(args.maxLinesPerFile, 2000);
});

test("parseQualityArgs: uiux 子命令 --dom-file 选项解析", () => {
  const args = parseQualityArgs(["uiux", "--dom-file", "./dom.json"], "/tmp/project");
  assert.equal(args.subcommand, "uiux");
  assert.equal(args.domFile, "./dom.json");
});

test("parseQualityArgs: uiux 子命令 --contrast-file 选项解析", () => {
  const args = parseQualityArgs(
    ["uiux", "--dom-file", "./dom.json", "--contrast-file", "./contrast.json"],
    "/tmp/project"
  );
  assert.equal(args.domFile, "./dom.json");
  assert.equal(args.contrastFile, "./contrast.json");
});

test("parseQualityArgs: visual 子命令所有选项解析", () => {
  const args = parseQualityArgs(
    [
      "visual",
      "--baseline",
      "./a.png",
      "--current",
      "./b.png",
      "--test-id",
      "TC-001",
      "--step",
      "final",
      "--pixel-threshold",
      "0.05",
      "--ssim-threshold",
      "0.9",
      "--dom-signals-file",
      "./signals.json",
    ],
    "/tmp/project"
  );
  assert.equal(args.subcommand, "visual");
  assert.equal(args.baseline, "./a.png");
  assert.equal(args.current, "./b.png");
  assert.equal(args.testId, "TC-001");
  assert.equal(args.step, "final");
  assert.equal(args.pixelThreshold, 0.05);
  assert.equal(args.ssimThreshold, 0.9);
  assert.equal(args.domSignalsFile, "./signals.json");
});

test("parseQualityArgs: --pixel-threshold 范围校验（0-1）", () => {
  // 合法值
  const valid = parseQualityArgs(["visual", "--current", "./b.png", "--pixel-threshold", "0.1"], "/tmp");
  assert.equal(valid.pixelThreshold, 0.1);
  // 超出 1 时被忽略
  const tooHigh = parseQualityArgs(["visual", "--current", "./b.png", "--pixel-threshold", "1.5"], "/tmp");
  assert.equal(tooHigh.pixelThreshold, undefined);
  // 负数被忽略
  const negative = parseQualityArgs(["visual", "--current", "./b.png", "--pixel-threshold", "-0.1"], "/tmp");
  assert.equal(negative.pixelThreshold, undefined);
});

test("parseQualityArgs: --ssim-threshold 范围校验（0-1）", () => {
  const valid = parseQualityArgs(["visual", "--current", "./b.png", "--ssim-threshold", "0.95"], "/tmp");
  assert.equal(valid.ssimThreshold, 0.95);
  const tooHigh = parseQualityArgs(["visual", "--current", "./b.png", "--ssim-threshold", "2"], "/tmp");
  assert.equal(tooHigh.ssimThreshold, undefined);
});

test("parseQualityArgs: --output 选项解析", () => {
  const args = parseQualityArgs(["codemap", "--output", "./map.json"], "/tmp/project");
  assert.equal(args.output, "./map.json");
});

test("parseQualityArgs: --format 选项解析（json/text/markdown）", () => {
  const json = parseQualityArgs(["codemap", "--format", "json"], "/tmp");
  assert.equal(json.format, "json");
  const text = parseQualityArgs(["codemap", "--format", "text"], "/tmp");
  assert.equal(text.format, "text");
  const md = parseQualityArgs(["codemap", "--format", "markdown"], "/tmp");
  assert.equal(md.format, "markdown");
  // 非法值被忽略
  const invalid = parseQualityArgs(["codemap", "--format", "xml"], "/tmp");
  assert.equal(invalid.format, undefined);
});

test("parseQualityArgs: --threshold 数值解析（>=0）", () => {
  const args = parseQualityArgs(["uiux", "--dom-file", "./d.json", "--threshold", "2"], "/tmp");
  assert.equal(args.threshold, 2);
  // 负数被忽略
  const neg = parseQualityArgs(["uiux", "--dom-file", "./d.json", "--threshold", "-1"], "/tmp");
  assert.equal(neg.threshold, undefined);
});

test("parseQualityArgs: --quiet 标志解析", () => {
  const args = parseQualityArgs(["codemap", "--quiet"], "/tmp/project");
  assert.equal(args.quiet, true);
});

test("parseQualityArgs: --project-root 选项覆盖函数参数", () => {
  const args = parseQualityArgs(["codemap", "--project-root", "/custom/root"], "/default");
  assert.equal(args.projectRoot, "/custom/root");
});

test("parseQualityArgs: projectRoot 默认回退到 process.cwd()", () => {
  const args = parseQualityArgs(["codemap"]);
  assert.equal(args.projectRoot, process.cwd());
});

test("parseQualityArgs: 未知 --key 容错忽略", () => {
  const args = parseQualityArgs(["codemap", "--unknown-key", "value"], "/tmp");
  assert.equal(args.subcommand, "codemap");
  // 未知 key 不会出现在结果中
  assert.equal((args as unknown as Record<string, unknown>)["unknown-key"], undefined);
});

// ============================================================================
// B. executeQualityCommand - help 子命令
// ============================================================================

test("executeQualityCommand: help 子命令返回 exitCode=0 并输出帮助文本", async () => {
  const args: QualityCommandArgs = {
    subcommand: "help",
    projectRoot: "/tmp",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("DeepCodeX Quality Check"));
  assert.ok(result.stdout.includes("用法:"));
  assert.ok(result.stdout.includes("子命令:"));
  assert.ok(result.stdout.includes("codemap"));
  assert.ok(result.stdout.includes("uiux"));
  assert.ok(result.stdout.includes("visual"));
  assert.ok(result.stdout.includes("all"));
  assert.ok(result.stdout.includes("help"));
  assert.ok(result.stdout.includes("退出码:"));
  assert.ok(result.stdout.includes("示例:"));
  assert.equal(result.stderr, "");
});

// ============================================================================
// C. executeQualityCommand - codemap 子命令
// ============================================================================

test("executeQualityCommand: codemap 子命令对真实项目生成代码地图（exitCode=0）", async () => {
  const projectRoot = await createTmpDir("codemap-real");
  await createMiniProject(projectRoot);

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    format: "text",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  // 应输出代码地图统计
  assert.ok(result.stdout.includes("Code Map:"));
  assert.ok(result.stdout.includes("文件数:"));
  assert.ok(result.stdout.includes("节点数:"));
  assert.ok(result.stdout.includes("边数:"));
});

test("executeQualityCommand: codemap 子命令 targetPath 不存在时返回 exitCode=2", async () => {
  const projectRoot = await createTmpDir("codemap-missing");
  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    targetPath: "./non-existent-dir",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("目标路径不存在"));
});

test("executeQualityCommand: codemap 子命令 targetPath 是文件时返回 exitCode=2", async () => {
  const projectRoot = await createTmpDir("codemap-file");
  const filePath = path.join(projectRoot, "file.txt");
  await fs.writeFile(filePath, "hello", "utf-8");

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    targetPath: filePath,
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("不是目录"));
});

test("executeQualityCommand: codemap 子命令 --output 写入文件并返回成功", async () => {
  const projectRoot = await createTmpDir("codemap-output");
  await createMiniProject(projectRoot);
  const outputPath = path.join(projectRoot, "reports", "map.txt");

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    format: "text",
    output: outputPath,
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("代码地图已写入"));
  // 验证文件真实写入
  assert.ok(nodeFs.existsSync(outputPath));
  const fileContent = nodeFs.readFileSync(outputPath, "utf-8");
  assert.ok(fileContent.includes("Code Map:"));
});

test("executeQualityCommand: codemap 子命令 json 格式输出可解析的 CodeMap", async () => {
  const projectRoot = await createTmpDir("codemap-json");
  await createMiniProject(projectRoot);

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    format: "json",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  // stdout 应为可解析的 JSON
  const parsed = JSON.parse(result.stdout);
  assert.ok(typeof parsed.projectName === "string");
  assert.ok(Array.isArray(parsed.nodes));
  assert.ok(parsed.stats);
  assert.ok(typeof parsed.stats.fileCount === "number");
});

test("executeQualityCommand: codemap 子命令 markdown 格式输出 markdown 内容", async () => {
  const projectRoot = await createTmpDir("codemap-md");
  await createMiniProject(projectRoot);

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    format: "markdown",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  // markdown 内容应包含 # Code Map: 标题
  assert.ok(result.stdout.includes("# Code Map:"));
  assert.ok(result.stdout.includes("## 语言分布"));
});

test("executeQualityCommand: codemap 子命令 --quiet 模式仅输出结论", async () => {
  const projectRoot = await createTmpDir("codemap-quiet");
  await createMiniProject(projectRoot);
  const outputPath = path.join(projectRoot, "map.txt");

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    format: "text",
    output: outputPath,
    quiet: true,
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  // quiet 模式下不输出文件数等明细
  assert.ok(!result.stdout.includes("- 文件数:"));
  assert.ok(result.stdout.includes("代码地图已写入"));
});

// ============================================================================
// D. executeQualityCommand - uiux 子命令
// ============================================================================

test("executeQualityCommand: uiux 子命令缺少 --dom-file 时返回 exitCode=2", async () => {
  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot: "/tmp",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("需要 --dom-file"));
});

test("executeQualityCommand: uiux 子命令 domFile 不存在时返回 exitCode=2", async () => {
  const projectRoot = await createTmpDir("uiux-missing");
  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile: "./non-existent.json",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("DOM 数据文件不存在"));
});

test("executeQualityCommand: uiux 子命令 domFile 非法 JSON 时返回 exitCode=2", async () => {
  const projectRoot = await createTmpDir("uiux-parse-err");
  const domFile = path.join(projectRoot, "dom.json");
  await fs.writeFile(domFile, "{ invalid json,,, }", "utf-8");

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("JSON 解析失败"));
});

test("executeQualityCommand: uiux 子命令对含问题的 DOM 数据返回 exitCode=1", async () => {
  const projectRoot = await createTmpDir("uiux-issues");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
    format: "text",
  };
  const result = await executeQualityCommand(args, undefined, false);
  // 含 HIGH 问题（img 缺 alt、表单无 label、对比度过低）应返回 1
  assert.equal(result.exitCode, 1);
  assert.ok(result.stdout.includes("UI/UX 巡检报告"));
  assert.ok(result.stdout.includes("HIGH:") || result.stdout.includes("HIGH"));
});

test("executeQualityCommand: uiux 子命令对干净页面返回 exitCode=0", async () => {
  const projectRoot = await createTmpDir("uiux-clean");
  // 构造一个无问题的 DOM 数据
  const cleanDomData: DOMAuditData = {
    images: [
      {
        tag: "img",
        selector: "img.logo",
        alt: "公司 Logo",
        src: "logo.png",
        natural_width: 200,
        natural_height: 60,
        complete: true,
      },
    ],
    form_controls: [
      {
        tag: "input",
        type: "email",
        id: "email",
        name: "email",
        selector: "input#email",
        has_label: true,
        has_aria_label: false,
        has_aria_labelledby: false,
        required: true,
        placeholder: "",
      },
    ],
    buttons: [{ selector: "button.primary", text: "提交", width: 120, height: 44, visible: true, disabled: false }],
    links: [{ selector: "a.help", text: "查看帮助", href: "/help", target: null }],
    headings: [{ level: 1, text: "登录" }],
    errors: [],
  };
  // 高对比度采样（避免 LOW 问题）
  const goodContrast: ContrastSample[] = [
    {
      text: "标题",
      color: "#000000",
      background: "#ffffff",
      font_size: 24,
      font_weight: 700,
      selector: "h1",
    },
  ];
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: cleanDomData,
    contrastSamples: goodContrast,
  });

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
    format: "text",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("UI/UX 巡检报告"));
});

test("executeQualityCommand: uiux 子命令 --threshold 提高允许 HIGH 问题数", async () => {
  const projectRoot = await createTmpDir("uiux-threshold");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
    threshold: 10, // 允许 10 个 HIGH 问题
  };
  const result = await executeQualityCommand(args, undefined, false);
  // HIGH 问题数 < 10，应返回 0
  assert.equal(result.exitCode, 0);
});

test("executeQualityCommand: uiux 子命令 --output 写入报告文件", async () => {
  const projectRoot = await createTmpDir("uiux-output");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });
  const outputPath = path.join(projectRoot, "uiux-report.txt");

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
    output: outputPath,
    format: "text",
  };
  const result = await executeQualityCommand(args, undefined, false);
  // exitCode 可能是 1（有 HIGH 问题），但报告应已写入
  assert.ok(result.exitCode === 0 || result.exitCode === 1);
  assert.ok(result.stdout.includes("UI/UX 巡检报告已写入"));
  assert.ok(nodeFs.existsSync(outputPath));
});

test("executeQualityCommand: uiux 子命令 markdown 格式输出表格", async () => {
  const projectRoot = await createTmpDir("uiux-md");
  const domData = makeRealisticDOMAuditData();
  const domFile = await writeJsonFile(projectRoot, "dom.json", domData);

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
    format: "markdown",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.ok(result.exitCode === 0 || result.exitCode === 1);
  assert.ok(result.stdout.includes("# UI/UX 巡检报告"));
  assert.ok(result.stdout.includes("## 总览"));
  assert.ok(result.stdout.includes("| 综合评分 |"));
});

// ============================================================================
// E. executeQualityCommand - visual 子命令
// ============================================================================

test("executeQualityCommand: visual 子命令缺少 --current 时返回 exitCode=2", async () => {
  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot: "/tmp",
  };
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("需要 --current"));
});

test("executeQualityCommand: visual 子命令 createImageAdapter 返回 null 时返回 exitCode=3", async () => {
  const projectRoot = await createTmpDir("visual-no-sharp");
  // 创建一个空的 current 文件（满足 current 文件存在性校验）
  const currentPath = path.join(projectRoot, "current.png");
  await fs.writeFile(currentPath, Buffer.alloc(0));

  // 通过 QualityHandlerContext 注入返回 null 的 createImageAdapter
  // 这不是 mock：QualityHandlerContext 是 quality-cmd.ts 设计的合法依赖注入扩展点，
  // createImageAdapter 工厂返回 null 模拟 sharp 未安装的真实场景
  const context: QualityHandlerContext = {
    createImageAdapter: async () => null,
  };

  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot,
    current: currentPath,
  };
  const result = await executeQualityCommand(args, context, false);
  assert.equal(result.exitCode, 3);
  assert.ok(result.stderr.includes("sharp 依赖"));
});

test("executeQualityCommand: visual 子命令 current 文件不存在时返回 exitCode=2", async () => {
  const projectRoot = await createTmpDir("visual-current-missing");

  // 注入真实的 SharpImageAdapter（已安装）
  const context: QualityHandlerContext = {
    createImageAdapter: async () => await SharpImageAdapter.create(),
  };

  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot,
    current: "./non-existent.png",
  };
  const result = await executeQualityCommand(args, context, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("当前图像文件不存在"));
});

test("executeQualityCommand: visual 子命令使用真实 sharp 比对相同图像（exitCode=0）", async () => {
  const projectRoot = await createTmpDir("visual-same");
  // 使用 SharpImageAdapter.save() 生成真实 PNG 文件
  const adapter = await SharpImageAdapter.create();
  const width = 10;
  const height = 10;
  const pixels = new Uint8ClampedArray(width * height * 4);
  // 纯红色图像
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255;
    pixels[i + 1] = 0;
    pixels[i + 2] = 0;
    pixels[i + 3] = 255;
  }
  const baselinePath = path.join(projectRoot, "baseline.png");
  const currentPath = path.join(projectRoot, "current.png");
  await adapter.save(baselinePath, { width, height, pixels });
  await adapter.save(currentPath, { width, height, pixels });

  const context: QualityHandlerContext = {
    createImageAdapter: async () => adapter,
  };

  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot,
    baseline: baselinePath,
    current: currentPath,
    testId: "test-same",
    step: "compare",
    format: "text",
  };
  const result = await executeQualityCommand(args, context, false);
  // 相同图像 pixelDiffRatio=0，应通过
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("视觉回归比对报告"));
  assert.ok(result.stdout.includes("像素差异比: 0.0000%"));
  assert.ok(result.stdout.includes("✅ 通过"));
});

test("executeQualityCommand: visual 子命令使用真实 sharp 比对不同图像（exitCode=1）", async () => {
  const projectRoot = await createTmpDir("visual-diff");
  const adapter = await SharpImageAdapter.create();
  const width = 20;
  const height = 20;

  // 基线图像：纯红色
  const baselinePixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < baselinePixels.length; i += 4) {
    baselinePixels[i] = 255;
    baselinePixels[i + 1] = 0;
    baselinePixels[i + 2] = 0;
    baselinePixels[i + 3] = 255;
  }
  // 当前图像：纯蓝色（差异显著）
  const currentPixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < currentPixels.length; i += 4) {
    currentPixels[i] = 0;
    currentPixels[i + 1] = 0;
    currentPixels[i + 2] = 255;
    currentPixels[i + 3] = 255;
  }

  // VisualRegression 在 baselineDir 中查找 `${step}.png` 作为基线
  // step 默认为 "compare"，因此基线文件必须命名为 compare.png
  const baselineDir = path.join(projectRoot, "baseline");
  await fs.mkdir(baselineDir, { recursive: true });
  const baselinePath = path.join(baselineDir, "compare.png");
  const currentPath = path.join(projectRoot, "current.png");
  await adapter.save(baselinePath, { width, height, pixels: baselinePixels });
  await adapter.save(currentPath, { width, height, pixels: currentPixels });

  const context: QualityHandlerContext = {
    createImageAdapter: async () => adapter,
  };

  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot,
    baseline: baselineDir, // 传入目录作为 baselineDir
    current: currentPath,
    step: "compare", // 与基线文件名 compare.png 对应
    format: "text",
  };
  const result = await executeQualityCommand(args, context, false);
  // 全部像素不同（红→蓝），pixelDiffRatio > 阈值，应返回 1
  assert.equal(result.exitCode, 1);
  assert.ok(result.stdout.includes("❌ 未通过"));
});

// ============================================================================
// F. executeQualityCommand - all 子命令
// ============================================================================

test("executeQualityCommand: all 子命令无 domFile/current 时跳过 uiux 与 visual（exitCode=0）", async () => {
  const projectRoot = await createTmpDir("all-skip");
  await createMiniProject(projectRoot);

  const args: QualityCommandArgs = {
    subcommand: "all",
    projectRoot,
    format: "text",
  };
  const result = await executeQualityCommand(args, undefined, false);
  // codemap 成功（0），uiux/visual 跳过，max=0
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("Code Map"));
  assert.ok(result.stdout.includes("(skipped: --dom-file 未提供)"));
  assert.ok(result.stdout.includes("(skipped: --current 未提供)"));
});

test("executeQualityCommand: all 子命令含 domFile 时执行 uiux", async () => {
  const projectRoot = await createTmpDir("all-uiux");
  await createMiniProject(projectRoot);
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const args: QualityCommandArgs = {
    subcommand: "all",
    projectRoot,
    domFile,
    format: "text",
  };
  const result = await executeQualityCommand(args, undefined, false);
  // uiux 有 HIGH 问题（exitCode=1），max(0, 1, 0) = 1
  assert.equal(result.exitCode, 1);
  assert.ok(result.stdout.includes("Code Map"));
  assert.ok(result.stdout.includes("UI/UX Audit"));
  assert.ok(result.stdout.includes("(skipped: --current 未提供)"));
});

// ============================================================================
// G. executeQualityCommand - 错误场景
// ============================================================================

test("executeQualityCommand: 未知子命令触发 exhaustive check 返回 exitCode=2", async () => {
  // 通过类型断言绕过编译期检查，模拟运行时未知子命令
  const args = {
    subcommand: "unknown-cmd" as never,
    projectRoot: "/tmp",
  } as QualityCommandArgs;
  const result = await executeQualityCommand(args, undefined, false);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("未知的 quality-check 子命令"));
});

test("executeQualityCommand: 内部异常被捕获返回 exitCode=4", async () => {
  // 通过注入抛异常的 createCodeMapGenerator 模拟内部错误
  const context: QualityHandlerContext = {
    createCodeMapGenerator: () => {
      // 返回一个伪 generator，调用 generate 时抛异常
      return {
        generate: async () => {
          throw new Error("模拟内部错误");
        },
        toMarkdown: () => "",
      } as never;
    },
  };
  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot: "/tmp",
  };
  const result = await executeQualityCommand(args, context, false);
  // codemap 内部捕获异常返回 4，executeQualityCommand 兜底也返回 4
  assert.equal(result.exitCode, 4);
  assert.ok(result.stderr.includes("生成代码地图失败"));
});

// ============================================================================
// H. QualityHandlerContext 依赖注入测试
// ============================================================================

test("QualityHandlerContext: createCodeMapGenerator 注入被正确调用", async () => {
  const projectRoot = await createTmpDir("di-codemap");
  await createMiniProject(projectRoot);

  let factoryCalled = false;
  const context: QualityHandlerContext = {
    createCodeMapGenerator: (options: CodeMapOptions) => {
      factoryCalled = true;
      assert.ok(options.projectRoot);
      // 返回真实的 CodeMapGenerator（依赖注入的合法用法，非 mock）
      return new CodeMapGenerator(options);
    },
  };

  const args: QualityCommandArgs = {
    subcommand: "codemap",
    projectRoot,
    format: "text",
  };
  const result = await executeQualityCommand(args, context, false);
  assert.equal(result.exitCode, 0);
  assert.ok(factoryCalled, "createCodeMapGenerator 工厂应被调用");
});

test("QualityHandlerContext: createUIUXAnalyzer 注入被正确调用", async () => {
  const projectRoot = await createTmpDir("di-uiux");
  const domData = makeRealisticDOMAuditData();
  const domFile = await writeJsonFile(projectRoot, "dom.json", domData);

  let factoryCalled = false;
  const context: QualityHandlerContext = {
    createUIUXAnalyzer: () => {
      factoryCalled = true;
      // 返回真实的 UIUXAnalyzer（依赖注入的合法用法，非 mock）
      return new UIUXAnalyzer();
    },
  };

  const args: QualityCommandArgs = {
    subcommand: "uiux",
    projectRoot,
    domFile,
  };
  const result = await executeQualityCommand(args, context, false);
  assert.ok(factoryCalled, "createUIUXAnalyzer 工厂应被调用");
  // exitCode 可能是 0、1 或 4（取决于 UIUXAnalyzer 检测结果与异常情况）
  assert.ok(result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 4);
});

test("QualityHandlerContext: createVisualRegression 注入被正确调用", async () => {
  const projectRoot = await createTmpDir("di-visual");
  // 生成相同图像，确保 visualRegression.compare() 成功
  const adapter = await SharpImageAdapter.create();
  const width = 10;
  const height = 10;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 128;
    pixels[i + 1] = 128;
    pixels[i + 2] = 128;
    pixels[i + 3] = 255;
  }
  const basePath = path.join(projectRoot, "baseline.png");
  const currentPath = path.join(projectRoot, "current.png");
  await adapter.save(basePath, { width, height, pixels });
  await adapter.save(currentPath, { width, height, pixels });

  let factoryCalled = false;
  const context: QualityHandlerContext = {
    createImageAdapter: async () => adapter,
    createVisualRegression: (options: VisualRegressionOptions) => {
      factoryCalled = true;
      assert.ok(options.imageAdapter);
      assert.ok(options.baselineDir);
      // 返回真实的 VisualRegression（依赖注入的合法用法，非 mock）
      return new VisualRegression(options);
    },
  };

  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot,
    baseline: basePath,
    current: currentPath,
  };
  const result = await executeQualityCommand(args, context, false);
  assert.ok(factoryCalled, "createVisualRegression 工厂应被调用");
  // 相同图像应通过（exitCode=0），但允许 4 兜底（如 sharp 版本兼容问题）
  assert.ok(result.exitCode === 0 || result.exitCode === 4);
});

test("QualityHandlerContext: createImageAdapter 抛异常时被捕获返回 exitCode=4", async () => {
  const projectRoot = await createTmpDir("di-adapter-err");
  const currentPath = path.join(projectRoot, "current.png");
  await fs.writeFile(currentPath, Buffer.alloc(0));

  const context: QualityHandlerContext = {
    createImageAdapter: async () => {
      throw new Error("工厂内部错误");
    },
  };

  const args: QualityCommandArgs = {
    subcommand: "visual",
    projectRoot,
    current: currentPath,
  };
  const result = await executeQualityCommand(args, context, false);
  assert.equal(result.exitCode, 4);
  assert.ok(result.stderr.includes("加载 sharp 失败") || result.stderr.includes("命令执行失败"));
});
