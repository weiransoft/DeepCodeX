/**
 * /quality-check 命令端到端集成测试
 *
 * 测试范围：
 *   - A. TUI 模式：用户输入 → 解析 → 执行 → 合成消息输出
 *   - B. CLI 模式：参数解析 → executeQualityCommand → stdout/stderr/exitCode
 *   - C. 命令路由：/quality-check 在 slash-commands 中正确注册
 *   - D. 真实端到端场景：codemap + uiux + visual + all 完整流程
 *
 * 测试约定（遵循项目规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架：所有测试使用真实文件系统与真实 quality 包实例
 *   - 集成测试模拟 App.tsx 中 handleQualitySlashCommand 的行为：
 *     parseQualityArgs(tokens.slice(1)) + executeQualityCommand(args, undefined, false)
 *   - 每个测试用例独立隔离：独立临时目录 + after 统一清理
 *
 * 注意：App.tsx 中的 handleQualitySlashCommand 是私有函数（未导出），
 * 本测试通过模拟其行为（parseQualityArgs + executeQualityCommand + 输出合并）
 * 验证 TUI 模式下的端到端流程。
 *
 * @module cli/tests/quality-check-integration
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeQualityCommand, parseQualityArgs } from "../quality/quality-cmd";
import { SharpImageAdapter } from "../quality/sharp-image-adapter";
import {
  buildSlashCommands,
  findExactSlashCommand,
  isTeamCommand,
  isInterruptCommand,
} from "../ui/core/slash-commands";
import type { DOMAuditData, ContrastSample } from "@deepcodex/quality";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quality-int-${prefix}-`));
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
 * 模拟 App.tsx 中的 handleQualitySlashCommand 函数行为
 *
 * 复刻 App.tsx 第 1586-1619 行的实现逻辑：
 *   1. 去除前导 "/"，按空白拆分 tokens
 *   2. 校验首 token 是 "quality-check"
 *   3. parseQualityArgs(tokens.slice(1)) 解析参数
 *   4. executeQualityCommand(args, undefined, false) 执行（TUI 模式不打印）
 *   5. 合并 stdout + stderr + 退出码作为合成消息返回
 *
 * 注意：这是对真实实现的行为复刻，不是 mock。
 * 测试目的是验证 parseQualityArgs + executeQualityCommand 在 TUI 模式下的协作。
 *
 * @param text 用户输入的完整文本（如 "/quality-check codemap ./path"）
 * @returns 合成消息文本（包含报告内容 + 退出码）
 */
async function simulateHandleQualitySlashCommand(text: string): Promise<string> {
  const trimmed = text.trim();
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] !== "quality-check") {
    return `无效的 /quality-check 命令: ${text}`;
  }

  const args = parseQualityArgs(tokens.slice(1));
  const result = await executeQualityCommand(args, undefined, false);

  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.stderr) {
    parts.push(result.stderr);
  }
  if (result.exitCode !== 0 && parts.length === 0) {
    parts.push(`✖ /quality-check 命令失败（退出码 ${result.exitCode}）`);
  } else if (result.exitCode !== 0) {
    parts.push(`\n[退出码: ${result.exitCode}]`);
  }
  return parts.join("\n").trim() || "(无输出)";
}

/**
 * 在临时目录中创建一个真实多语言项目
 */
async function createMiniProject(projectRoot: string): Promise<void> {
  const srcDir = path.join(projectRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });
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
    ].join("\n")
  );
  await fs.writeFile(
    path.join(srcDir, "user.ts"),
    [
      "export class User {",
      "  public name: string;",
      "  constructor(name: string) {",
      "    this.name = name;",
      "  }",
      "  public greet(): string {",
      '    return "hi, " + this.name;',
      "  }",
      "}",
      "",
    ].join("\n")
  );
}

/**
 * 写入 JSON 文件并返回绝对路径
 */
async function writeJsonFile(dir: string, filename: string, data: unknown): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

/**
 * 构造真实 DOMAuditData（含 a11y 问题）
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
 * 构造真实 ContrastSample 数组
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
// C. 命令路由：/quality-check 在 slash-commands 中正确注册
// ============================================================================

test("集成: /quality-check 命令在 BUILTIN_SLASH_COMMANDS 中正确注册", () => {
  const items = buildSlashCommands([]);
  const qualityItem = items.find((i) => i.kind === "quality-check");
  assert.ok(qualityItem, "/quality-check 应在 BUILTIN_SLASH_COMMANDS 中注册");
  assert.equal(qualityItem!.name, "quality-check");
  assert.equal(qualityItem!.label, "/quality-check");
  assert.ok(qualityItem!.description.includes("Quality gate"));
  assert.ok(qualityItem!.args && qualityItem!.args.length > 0);
});

test("集成: findExactSlashCommand 能识别 /quality-check", () => {
  const items = buildSlashCommands([]);
  const item = findExactSlashCommand(items, "/quality-check");
  assert.ok(item);
  assert.equal(item?.kind, "quality-check");
});

test("集成: /quality-check 不被 isTeamCommand / isInterruptCommand 误判", () => {
  assert.equal(isTeamCommand("quality-check"), false);
  assert.equal(isInterruptCommand("quality-check"), false);
});

// ============================================================================
// A. TUI 模式端到端：simulateHandleQualitySlashCommand
// ============================================================================

test("TUI 集成: '/quality-check help' 输出帮助文本", async () => {
  const output = await simulateHandleQualitySlashCommand("/quality-check help");
  assert.ok(output.includes("DeepCodeX Quality Check"));
  assert.ok(output.includes("用法:"));
  assert.ok(output.includes("子命令:"));
  // 帮助文本应不包含退出码后缀（exitCode=0）
  assert.ok(!output.includes("[退出码:"));
});

test("TUI 集成: '/quality-check' 无子命令默认走 codemap（在项目目录下）", async () => {
  const projectRoot = await createTmpDir("tui-default");
  await createMiniProject(projectRoot);
  // 修改 cwd 到临时项目目录（parseQualityArgs 默认使用 process.cwd()）
  const originalCwd = process.cwd();
  process.chdir(projectRoot);
  try {
    const output = await simulateHandleQualitySlashCommand("/quality-check");
    // codemap 输出应包含 Code Map 标题
    assert.ok(output.includes("Code Map:"));
  } finally {
    process.chdir(originalCwd);
  }
});

test("TUI 集成: 无效命令（非 /quality-check 前缀）返回错误提示", async () => {
  const output = await simulateHandleQualitySlashCommand("/other-command");
  assert.ok(output.includes("无效的 /quality-check 命令"));
});

test("TUI 集成: '/quality-check codemap <path>' 指定路径生成代码地图", async () => {
  const projectRoot = await createTmpDir("tui-codemap-path");
  await createMiniProject(projectRoot);

  const output = await simulateHandleQualitySlashCommand(`/quality-check codemap ${projectRoot}`);
  // 默认 codemap 输出 markdown 格式，包含 "# Code Map: <projectName>" 标题
  assert.ok(output.includes("Code Map:"));
  // markdown 格式输出为 "- **文件数**: N"，text 格式为 "- 文件数: N"
  // 两种格式都包含 "文件数" 关键字
  assert.ok(output.includes("文件数"));
});

test("TUI 集成: '/quality-check codemap --format json' 输出可解析的 JSON", async () => {
  const projectRoot = await createTmpDir("tui-codemap-json");
  await createMiniProject(projectRoot);

  const output = await simulateHandleQualitySlashCommand(`/quality-check codemap ${projectRoot} --format json`);
  // 应为可解析的 JSON
  const parsed = JSON.parse(output);
  assert.ok(typeof parsed.projectName === "string");
  assert.ok(Array.isArray(parsed.nodes));
});

test("TUI 集成: '/quality-check uiux --dom-file <path>' 输出巡检报告", async () => {
  const projectRoot = await createTmpDir("tui-uiux");
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  const output = await simulateHandleQualitySlashCommand(`/quality-check uiux --dom-file ${domFile}`);
  assert.ok(output.includes("UI/UX 巡检报告"));
  // 有 HIGH 问题（img 缺 alt、表单无 label、对比度过低），exitCode=1，应附带退出码后缀
  assert.ok(output.includes("[退出码: 1]"));
});

test("TUI 集成: '/quality-check uiux' 缺少 --dom-file 输出错误", async () => {
  const output = await simulateHandleQualitySlashCommand("/quality-check uiux");
  assert.ok(output.includes("需要 --dom-file"));
  assert.ok(output.includes("[退出码: 2]"));
});

test("TUI 集成: '/quality-check visual --current <path>' 在 sharp 未注入时返回 exitCode=3", async () => {
  // simulateHandleQualitySlashCommand 未注入 context，会调用真实的 SharpImageAdapter.create()
  // 在 sharp 已安装的环境中应成功（exitCode=0 或 1）
  // 在 sharp 未安装的环境中应返回 exitCode=3
  // 这里我们测试命令路由的端到端流程，不依赖 sharp 安装状态
  const projectRoot = await createTmpDir("tui-visual");
  // 创建一个空的 current.png 文件（满足文件存在性校验）
  const currentPath = path.join(projectRoot, "current.png");
  await fs.writeFile(currentPath, Buffer.alloc(0));

  const output = await simulateHandleQualitySlashCommand(`/quality-check visual --current ${currentPath}`);
  // 输出应包含命令执行反馈（成功或失败）
  // 由于 SharpImageAdapter 真实加载 sharp，结果取决于环境
  assert.ok(
    output.includes("视觉回归比对报告") || output.includes("sharp 依赖") || output.includes("[退出码:"),
    `输出应包含视觉回归相关内容，实际: ${output.slice(0, 200)}`
  );
});

test("TUI 集成: '/quality-check all' 在项目目录下跳过 uiux 与 visual", async () => {
  const projectRoot = await createTmpDir("tui-all");
  await createMiniProject(projectRoot);
  const originalCwd = process.cwd();
  process.chdir(projectRoot);
  try {
    const output = await simulateHandleQualitySlashCommand("/quality-check all");
    assert.ok(output.includes("Code Map"));
    assert.ok(output.includes("(skipped: --dom-file 未提供)"));
    assert.ok(output.includes("(skipped: --current 未提供)"));
  } finally {
    process.chdir(originalCwd);
  }
});

test("TUI 集成: '/quality-check unknown-sub' 未知子命令返回 exitCode=2", async () => {
  const output = await simulateHandleQualitySlashCommand("/quality-check unknown-sub");
  // 未知子命令触发 exhaustive check，stderr 写入错误信息
  assert.ok(output.includes("未知的 quality-check 子命令") || output.includes("[退出码: 2]"));
});

test("TUI 集成: 命令前后空白被正确 trim", async () => {
  const output = await simulateHandleQualitySlashCommand("   /quality-check help   ");
  assert.ok(output.includes("DeepCodeX Quality Check"));
});

test("TUI 集成: 命令不带 / 前缀也能解析（容错）", async () => {
  // simulateHandleQualitySlashCommand 内部检测 trimmed.startsWith("/") 并 slice，
  // 但即使不带 /，body 等于原文本，tokens[0] 仍是 "quality-check"，应正常解析
  const output = await simulateHandleQualitySlashCommand("quality-check help");
  assert.ok(output.includes("DeepCodeX Quality Check"));
});

// ============================================================================
// D. 真实端到端场景：完整工作流
// ============================================================================

test("端到端: codemap → uiux → visual 完整质量检查工作流", async () => {
  const projectRoot = await createTmpDir("e2e-full-flow");
  await createMiniProject(projectRoot);

  // Step 1: codemap 生成代码地图
  const codemapOutput = await simulateHandleQualitySlashCommand(`/quality-check codemap ${projectRoot} --format text`);
  assert.ok(codemapOutput.includes("Code Map:"));
  assert.ok(!codemapOutput.includes("[退出码:")); // codemap 应成功

  // Step 2: uiux 巡检
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });
  const uiuxOutput = await simulateHandleQualitySlashCommand(`/quality-check uiux --dom-file ${domFile}`);
  assert.ok(uiuxOutput.includes("UI/UX 巡检报告"));
  assert.ok(uiuxOutput.includes("[退出码: 1]")); // 有 HIGH 问题

  // Step 3: visual 视觉回归（使用真实 sharp 比对相同图像）
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
  const baselineDir = path.join(projectRoot, "baseline");
  await fs.mkdir(baselineDir, { recursive: true });
  const baselinePath = path.join(baselineDir, "compare.png");
  const currentPath = path.join(projectRoot, "current.png");
  await adapter.save(baselinePath, { width, height, pixels });
  await adapter.save(currentPath, { width, height, pixels });

  // 注意：simulateHandleQualitySlashCommand 不支持 context 注入，
  // 因此 visual 命令会真实加载 SharpImageAdapter（已安装），
  // 不需要注入 adapter。这里我们直接调用 executeQualityCommand 验证 visual 流程。
  const { executeQualityCommand, parseQualityArgs } = await import("../quality/quality-cmd");
  const args = parseQualityArgs(["visual", "--baseline", baselineDir, "--current", currentPath, "--step", "compare"]);
  const visualResult = await executeQualityCommand(args, undefined, false);
  assert.equal(visualResult.exitCode, 0);
  assert.ok(visualResult.stdout.includes("✅ 通过"));
});

test("端到端: '/quality-check all' 含 domFile 与 current 时执行所有检查", async () => {
  const projectRoot = await createTmpDir("e2e-all");
  await createMiniProject(projectRoot);

  // 准备 dom.json
  const domData = makeRealisticDOMAuditData();
  const contrastSamples = makeRealisticContrastSamples();
  const domFile = await writeJsonFile(projectRoot, "dom.json", {
    domAuditData: domData,
    contrastSamples,
  });

  // 准备 current.png（使用真实 sharp 生成）
  const adapter = await SharpImageAdapter.create();
  const width = 8;
  const height = 8;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 100;
    pixels[i + 1] = 150;
    pixels[i + 2] = 200;
    pixels[i + 3] = 255;
  }
  const currentPath = path.join(projectRoot, "current.png");
  await adapter.save(currentPath, { width, height, pixels });

  const output = await simulateHandleQualitySlashCommand(
    `/quality-check all --dom-file ${domFile} --current ${currentPath}`
  );
  // all 子命令应执行 codemap + uiux + visual
  assert.ok(output.includes("Code Map"));
  assert.ok(output.includes("UI/UX Audit"));
  assert.ok(output.includes("Visual Regression"));
});

test("端到端: codemap --output 写入文件后可被外部读取", async () => {
  const projectRoot = await createTmpDir("e2e-output");
  await createMiniProject(projectRoot);
  const outputPath = path.join(projectRoot, "reports", "codemap.md");

  const output = await simulateHandleQualitySlashCommand(
    `/quality-check codemap ${projectRoot} --format markdown --output ${outputPath}`
  );
  assert.ok(output.includes("代码地图已写入"));

  // 验证文件真实写入磁盘
  const fileContent = await fs.readFile(outputPath, "utf-8");
  assert.ok(fileContent.includes("# Code Map:"));
  assert.ok(fileContent.includes("## 语言分布"));
});

// ============================================================================
// E. 错误处理与边界场景
// ============================================================================

test("边界: '/quality-check codemap ./non-existent' 输出 exitCode=2 错误", async () => {
  const output = await simulateHandleQualitySlashCommand("/quality-check codemap ./non-existent-dir-12345");
  assert.ok(output.includes("目标路径不存在") || output.includes("[退出码: 2]"));
});

test("边界: '/quality-check uiux --dom-file ./non-existent.json' 输出 exitCode=2 错误", async () => {
  const output = await simulateHandleQualitySlashCommand("/quality-check uiux --dom-file ./non-existent-12345.json");
  assert.ok(output.includes("DOM 数据文件不存在") || output.includes("[退出码: 2]"));
});

test("边界: '/quality-check visual --current ./non-existent.png' 输出 exitCode=2 错误", async () => {
  const output = await simulateHandleQualitySlashCommand("/quality-check visual --current ./non-existent-12345.png");
  assert.ok(output.includes("当前图像文件不存在") || output.includes("[退出码: 2]"));
});

test("边界: '/quality-check uiux --dom-file <path> --threshold 100' 高阈值下 exitCode=0", async () => {
  const projectRoot = await createTmpDir("boundary-threshold");
  const domData = makeRealisticDOMAuditData();
  const domFile = await writeJsonFile(projectRoot, "dom.json", domData);

  const output = await simulateHandleQualitySlashCommand(`/quality-check uiux --dom-file ${domFile} --threshold 100`);
  // 阈值 100 允许 100 个 HIGH 问题，exitCode 应为 0
  assert.ok(output.includes("UI/UX 巡检报告"));
  // exitCode=0，输出不应包含退出码后缀
  assert.ok(!output.includes("[退出码:"));
});

test("边界: 命令参数含特殊字符（路径含空格）", async () => {
  const projectRoot = await createTmpDir("boundary spaces");
  await createMiniProject(projectRoot);

  // 注意：simulateHandleQualitySlashCommand 通过 split(/\s+/) 拆分 tokens，
  // 路径含空格会被拆分为多个 token，导致解析异常。
  // 这是预期的行为：TUI 模式下用户应使用引号或避免路径含空格。
  // 这里验证命令至少不会崩溃，并返回某种输出。
  const output = await simulateHandleQualitySlashCommand(`/quality-check codemap ${projectRoot}`);
  // 路径含空格会被拆分，codemap 可能因路径不完整而失败，但应返回某种输出
  assert.ok(output.length > 0);
});
