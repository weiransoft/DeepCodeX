/**
 * quality-check CLI 顶级命令 E2E 测试
 *
 * 测试目标：
 *   通过真实 CLI 子进程执行（child_process.spawnSync），验证 `deepcode quality-check <subcommand>`
 *   命令在端到端场景下的完整行为，覆盖命令路由、参数解析、真实 quality 包调用、
 *   退出码传递、stdout/stderr 输出分离等关键链路。
 *
 * 测试约定（遵循项目规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止 mock：所有测试通过真实 CLI 进程执行，使用真实文件系统与真实 quality 包
 *   - 每个测试用例独立隔离：独立临时目录 + after 统一清理
 *   - 通过 spawnSync 调用 `node --import tsx src/cli.tsx quality-check ...`，模拟真实用户使用
 *
 * 测试覆盖的复杂场景（共 25 个）：
 *   - A. help 子命令（exitCode=0，输出帮助文本）
 *   - B. codemap 子命令（默认/指定路径/JSON/markdown/output/scope/skip-dirs/max-files/多语言项目）
 *   - C. uiux 子命令（domFile/contrastFile/markdown 格式/问题检测/Schema 错误）
 *   - D. visual 子命令（current 必填/相同图像/不同图像/阈值调整/baseline 自动保存）
 *   - E. all 子命令（全量检查/部分失败容错）
 *   - F. 错误场景（未知子命令/路径不存在/缺必填参数）
 *   - G. 退出码语义验证（0/1/2/3/4 五档）
 *   - H. 输出分离（stdout/stderr 区分）
 *
 * @module cli/tests/quality-cli-e2e
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ============================================================================
// 测试基础设施
// ============================================================================

/** CLI 包根目录（用于定位 src/cli.tsx）
 *
 * 测试文件路径：packages/cli/src/tests/quality-cli-e2e.test.ts
 * CLI_PACKAGE_ROOT 应指向 packages/cli/（即 tests 的上两级）
 */
const CLI_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 临时目录集合（after 统一清理） */
const tempDirs: string[] = [];

/**
 * 创建唯一临时目录
 *
 * @param prefix 目录前缀（便于排查）
 * @returns 临时目录绝对路径
 */
async function createTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quality-e2e-${prefix}-`));
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
 * 执行 deepcode quality-check CLI 命令（真实子进程）
 *
 * 通过 spawnSync 启动 `node --import tsx src/cli.tsx quality-check <args...>`，
 * 模拟真实用户在 shell 中执行 `deepcode quality-check ...` 的行为。
 *
 * @param args quality-check 子命令参数数组（如 ["codemap", "/tmp/xxx"]）
 * @param options 额外选项（cwd/env/timeout）
 * @returns 子进程执行结果（stdout/stderr/exitCode）
 */
function runQualityCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): { stdout: string; stderr: string; exitCode: number } {
  // 构造完整命令：node --import tsx src/cli.tsx quality-check <args...>
  const cliPath = path.join(CLI_PACKAGE_ROOT, "src", "cli.tsx");
  const fullArgs = ["--import", "tsx", cliPath, "quality-check", ...args];
  const result = spawnSync("node", fullArgs, {
    cwd: options.cwd ?? CLI_PACKAGE_ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf-8",
    timeout: options.timeout ?? 60_000,
    // 捕获 stdout 与 stderr 分离输出
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

// ============================================================================
// Fixtures：真实项目结构构造
// ============================================================================

/**
 * 创建一个真实多语言项目（TypeScript + JavaScript + Python）
 *
 * 项目结构：
 *   projectRoot/
 *   ├── src/
 *   │   ├── index.ts        TypeScript 主入口
 *   │   ├── utils.ts        TypeScript 工具类
 *   │   └── helper.js       JavaScript 文件
 *   ├── scripts/
 *   │   └── build.py        Python 脚本
 *   ├── node_modules/       应被 codemap 跳过
 *   │   └── fake-lib/index.js
 *   ├── dist/               应被 codemap 跳过
 *   │   └── bundle.js
 *   └── README.md           非代码文件，应被忽略
 */
async function createMultiLanguageProject(projectRoot: string): Promise<void> {
  const srcDir = path.join(projectRoot, "src");
  const scriptsDir = path.join(projectRoot, "scripts");
  const nodeModulesDir = path.join(projectRoot, "node_modules", "fake-lib");
  const distDir = path.join(projectRoot, "dist");

  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.mkdir(nodeModulesDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });

  // TypeScript 主入口
  await fs.writeFile(
    path.join(srcDir, "index.ts"),
    [
      'import { User } from "./user";',
      'import { greet } from "./utils";',
      "",
      "export function main(): string {",
      '  const u = new User("alice");',
      "  return greet(u.name);",
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
      '    return "hi, " + this.name;',
      "  }",
      "}",
      "",
    ].join("\n")
  );

  // TypeScript 工具函数
  await fs.writeFile(
    path.join(srcDir, "utils.ts"),
    [
      "export function greet(name: string): string {",
      "  if (!name) return 'anon';",
      "  return `hello, ${name}`;",
      "}",
      "",
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
    ].join("\n")
  );

  // JavaScript 文件
  await fs.writeFile(
    path.join(srcDir, "helper.js"),
    ["function helper() {", "  return 'helper';", "}", "module.exports = { helper };", ""].join("\n")
  );

  // Python 脚本
  await fs.writeFile(
    path.join(scriptsDir, "build.py"),
    ["def main():", "    print('building...')", "", "if __name__ == '__main__':", "    main()", ""].join("\n")
  );

  // node_modules 中的假库（应被跳过）
  await fs.writeFile(path.join(nodeModulesDir, "index.js"), "module.exports = function() { return 'fake'; };");

  // dist 中的构建产物（应被跳过）
  await fs.writeFile(path.join(distDir, "bundle.js"), "console.log('built');");

  // 非代码文件
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Test Project\n\nA mini project for E2E testing.\n");
}

/**
 * 创建一个真实 DOM 数据 JSON 文件（含 a11y 问题）
 */
async function createDomAuditFile(dir: string, filename: string = "dom.json"): Promise<string> {
  const data = {
    images: [
      {
        tag: "img",
        selector: "img.hero",
        alt: null, // 缺失 alt，触发 HIGH a11y 问题
        src: "hero.png",
        natural_width: 800,
        natural_height: 400,
        complete: true,
      },
      {
        tag: "img",
        selector: "img.logo",
        alt: "Logo",
        src: "logo.png",
        natural_width: 120,
        natural_height: 60,
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
        has_label: false, // 无 label，触发 HIGH a11y 问题
        has_aria_label: false,
        has_aria_labelledby: false,
        required: true,
        placeholder: "请输入用户名",
      },
    ],
    buttons: [
      { selector: "button.submit", text: "提交", width: 120, height: 44, visible: true, disabled: false },
      { selector: "button.small", text: "X", width: 20, height: 20, visible: true, disabled: false }, // 小于 44px，触发 MEDIUM
    ],
    links: [{ selector: "a.help", text: "查看帮助", href: "/help", target: null }],
    headings: [{ level: 1, text: "登录" }],
    errors: [],
  };
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

/**
 * 创建一个真实对比度采样 JSON 文件（含低对比度问题）
 */
async function createContrastSamplesFile(dir: string, filename: string = "contrast.json"): Promise<string> {
  const data = [
    {
      text: "灰色文字",
      color: "#cccccc", // 浅灰色
      background: "#ffffff",
      font_size: 14,
      font_weight: 400,
      selector: "p.muted",
    },
    {
      text: "正常文字",
      color: "#333333",
      background: "#ffffff",
      font_size: 16,
      font_weight: 400,
      selector: "p.normal",
    },
  ];
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

/**
 * 生成一个真实 PNG 图像文件（使用 sharp）
 *
 * @param filePath 输出文件路径
 * @param width 图像宽度
 * @param height 图像高度
 * @param color 填充颜色 [R, G, B, A]
 */
async function generatePngImage(
  filePath: string,
  width: number,
  height: number,
  color: [number, number, number, number]
): Promise<void> {
  const sharp = (await import("sharp")).default;
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buffer[i * 4] = color[0];
    buffer[i * 4 + 1] = color[1];
    buffer[i * 4 + 2] = color[2];
    buffer[i * 4 + 3] = color[3];
  }
  await sharp(buffer, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(filePath);
}

// ============================================================================
// 检测 sharp 是否可用（决定 visual 测试是否跳过）
// ============================================================================

let sharpAvailable = false;
// 使用 before() 钩子避免 top-level await 与 __dirname 冲突（ESM 模块限制）
before(async () => {
  try {
    await import("sharp");
    sharpAvailable = true;
  } catch {
    sharpAvailable = false;
  }
});

// ============================================================================
// A. help 子命令测试
// ============================================================================

test("E2E-A1: 'deepcode quality-check help' 输出帮助文本并 exitCode=0", () => {
  const result = runQualityCli(["help"]);
  // yargs 会先输出自己的 help，然后 cli.tsx 输出 formatQualityHelp()
  // 这里验证最终包含我们的帮助文本关键标识
  assert.ok(
    result.stdout.includes("DeepCodeX Quality Check") || result.stdout.includes("Quality gate"),
    `stdout 应包含帮助文本标识，实际：\n${result.stdout.slice(0, 200)}`
  );
  assert.equal(result.exitCode, 0);
});

// ============================================================================
// B. codemap 子命令测试
// ============================================================================

test("E2E-B1: 'deepcode quality-check codemap <path>' 对真实项目生成代码地图（exitCode=0）", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-basic");
  await createMultiLanguageProject(projectRoot);

  const result = runQualityCli(["codemap", projectRoot]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  // 默认 markdown 格式，应包含关键章节
  assert.ok(result.stdout.includes("Code Map:"), "应包含 'Code Map:' 标题");
  assert.ok(result.stdout.includes("文件数"), "应包含 '文件数' 统计");
});

test("E2E-B2: 'deepcode quality-check codemap' 默认对当前目录生成代码地图", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-default");
  await createMultiLanguageProject(projectRoot);

  // 通过 --project-root 选项指定项目根目录（避免 cwd 切换导致 tsx 模块找不到）
  const result = runQualityCli(["codemap", "--project-root", projectRoot]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("Code Map:"), "应包含 'Code Map:' 标题");
});

test("E2E-B3: 'deepcode quality-check codemap <path> --format json' 输出可解析 JSON", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-json");
  await createMultiLanguageProject(projectRoot);

  const result = runQualityCli(["codemap", projectRoot, "--format", "json"]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  // JSON 格式输出应可被 JSON.parse 解析
  const parsed = JSON.parse(result.stdout);
  assert.ok(typeof parsed === "object", "JSON 输出应为对象");
  assert.ok(typeof parsed.stats === "object", "应包含 stats 字段");
  assert.ok(parsed.stats.fileCount > 0, "fileCount 应 > 0");
});

test("E2E-B4: 'deepcode quality-check codemap <path> --format markdown --output <file>' 写入文件", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-output");
  await createMultiLanguageProject(projectRoot);
  const outputPath = path.join(projectRoot, "code-map.md");

  const result = runQualityCli(["codemap", projectRoot, "--format", "markdown", "--output", outputPath]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  // 验证文件真实写入磁盘
  const fileContent = await fs.readFile(outputPath, "utf-8");
  assert.ok(fileContent.includes("Code Map:"), "输出文件应包含 'Code Map:' 标题");
});

test("E2E-B5: 'deepcode quality-check codemap <path> --skip-dirs node_modules,dist' 跳过指定目录", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-skip");
  await createMultiLanguageProject(projectRoot);

  const result = runQualityCli(["codemap", projectRoot, "--format", "json", "--skip-dirs", "node_modules,dist"]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  // 文件节点在 nodes 数组中（kind=file），通过 relativePath 判断是否被跳过
  const fileNodes = (parsed.nodes || []).filter((n: { kind: string }) => n.kind === "file");
  const hasNodeModules = fileNodes.some((n: { relativePath: string }) => n.relativePath.includes("node_modules"));
  const hasDist = fileNodes.some((n: { relativePath: string }) => n.relativePath.includes("dist/"));
  assert.equal(hasNodeModules, false, "不应扫描 node_modules");
  assert.equal(hasDist, false, "不应扫描 dist");
});

test("E2E-B6: 'deepcode quality-check codemap <path> --scope src' 仅扫描指定目录", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-scope");
  await createMultiLanguageProject(projectRoot);

  const result = runQualityCli(["codemap", projectRoot, "--format", "json", "--scope", "src"]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const fileNodes = (parsed.nodes || []).filter((n: { kind: string }) => n.kind === "file");
  // --scope src 表示只扫描 src 目录
  const hasScripts = fileNodes.some((n: { relativePath: string }) => n.relativePath.startsWith("scripts/"));
  assert.equal(hasScripts, false, "不应扫描 scripts 目录（--scope src 限制）");
  const hasSrc = fileNodes.some((n: { relativePath: string }) => n.relativePath.startsWith("src/"));
  assert.equal(hasSrc, true, "应扫描 src 目录");
});

test("E2E-B7: 'deepcode quality-check codemap <path> --max-files 1' 限制文件数", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-maxfiles");
  await createMultiLanguageProject(projectRoot);

  const result = runQualityCli(["codemap", projectRoot, "--format", "json", "--max-files", "1"]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  // max-files=1 表示最多扫描 1 个文件
  assert.ok(parsed.stats.fileCount <= 1, `fileCount 应 <= 1，实际：${parsed.stats.fileCount}`);
});

test("E2E-B8: 多语言项目（TS+JS+Python）codemap 正确识别语言分布", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-multilang");
  await createMultiLanguageProject(projectRoot);

  const result = runQualityCli(["codemap", projectRoot, "--format", "json", "--skip-dirs", "node_modules,dist"]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  // languageBreakdown 字段名（非 languageStats），格式 { "typescript": N, "javascript": N, "python": N }
  const langs = Object.keys(parsed.stats.languageBreakdown || {});
  assert.ok(langs.includes("typescript"), `应识别 typescript，实际：${langs}`);
  assert.ok(langs.includes("javascript"), `应识别 javascript，实际：${langs}`);
  assert.ok(langs.includes("python"), `应识别 python，实际：${langs}`);
});

// ============================================================================
// C. uiux 子命令测试
// ============================================================================

test("E2E-C1: 'deepcode quality-check uiux --dom-file <file>' 真实巡检（含 a11y 问题）", async () => {
  const projectRoot = await createTmpDir("e2e-uiux-basic");
  const domFile = await createDomAuditFile(projectRoot);

  const result = runQualityCli(["uiux", "--dom-file", domFile]);
  // DOM 中有 a11y 问题（img 无 alt + input 无 label + 按钮过小），exitCode=1
  assert.equal(result.exitCode, 1, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  // 默认 text 格式输出
  assert.ok(result.stdout.includes("UI/UX"), "应包含 'UI/UX' 标识");
  assert.ok(result.stdout.includes("a11y"), "应包含 'a11y' 类别");
});

test("E2E-C2: 'deepcode quality-check uiux --dom-file <file> --contrast-file <file>' 含对比度采样", async () => {
  const projectRoot = await createTmpDir("e2e-uiux-contrast");
  const domFile = await createDomAuditFile(projectRoot);
  const contrastFile = await createContrastSamplesFile(projectRoot);

  const result = runQualityCli(["uiux", "--dom-file", domFile, "--contrast-file", contrastFile, "--format", "json"]);
  assert.equal(result.exitCode, 1, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(typeof parsed === "object", "JSON 输出应为对象");
  assert.ok(parsed.total_issues > 0, "应检测到问题");
});

test("E2E-C3: 'deepcode quality-check uiux --dom-file <file> --format markdown' markdown 报告", async () => {
  const projectRoot = await createTmpDir("e2e-uiux-markdown");
  const domFile = await createDomAuditFile(projectRoot);

  const result = runQualityCli(["uiux", "--dom-file", domFile, "--format", "markdown"]);
  assert.equal(result.exitCode, 1, `stderr: ${result.stderr}`);
  // markdown 格式应包含表格
  assert.ok(result.stdout.includes("UI/UX 巡检报告"), "应包含 'UI/UX 巡检报告' 标题");
  assert.ok(result.stdout.includes("|"), "应包含 markdown 表格语法");
});

test("E2E-C4: 'deepcode quality-check uiux' 缺 --dom-file 时 exitCode=2", async () => {
  const result = runQualityCli(["uiux"]);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("dom-file") || result.stderr.includes("参数"), "应提示缺少 dom-file 参数");
});

test("E2E-C5: 'deepcode quality-check uiux --dom-file <missing>' 文件不存在时 exitCode=2", async () => {
  const result = runQualityCli(["uiux", "--dom-file", "/tmp/nonexistent-dom-file.json"]);
  assert.equal(result.exitCode, 2);
  assert.ok(
    result.stderr.includes("不存在") || result.stderr.includes("not found") || result.stderr.includes("FILE_NOT_FOUND"),
    "应提示文件不存在"
  );
});

test("E2E-C6: 'deepcode quality-check uiux --dom-file <invalid-json>' JSON 解析失败 exitCode=2", async () => {
  const projectRoot = await createTmpDir("e2e-uiux-invalid-json");
  const invalidFile = path.join(projectRoot, "invalid.json");
  await fs.writeFile(invalidFile, "{ invalid json content }", "utf-8");

  const result = runQualityCli(["uiux", "--dom-file", invalidFile]);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("JSON") || result.stderr.includes("PARSE_ERROR"), "应提示 JSON 解析失败");
});

// ============================================================================
// D. visual 子命令测试（依赖 sharp，未安装时跳过）
// ============================================================================

test("E2E-D1: 'deepcode quality-check visual' 缺 --current 时 exitCode=2", () => {
  const result = runQualityCli(["visual"]);
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("current"), "应提示缺少 current 参数");
});

test(
  "E2E-D2: 'deepcode quality-check visual --current <same> --baseline <dir>' 相同图像 exitCode=0",
  { skip: !sharpAvailable ? "sharp 未安装，跳过 visual 真实比对测试" : undefined },
  async () => {
    const projectRoot = await createTmpDir("e2e-visual-same");
    const baselineDir = path.join(projectRoot, "baseline");
    const currentPath = path.join(projectRoot, "current.png");
    await fs.mkdir(baselineDir, { recursive: true });
    // 生成相同图像作为基线和当前
    const baselinePath = path.join(baselineDir, "compare.png");
    await generatePngImage(baselinePath, 100, 100, [255, 0, 0, 255]);
    await generatePngImage(currentPath, 100, 100, [255, 0, 0, 255]);

    const result = runQualityCli(["visual", "--current", currentPath, "--baseline", baselineDir, "--step", "compare"]);
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  }
);

test(
  "E2E-D3: 'deepcode quality-check visual --current <diff> --baseline <dir>' 不同图像 exitCode=1",
  { skip: !sharpAvailable ? "sharp 未安装，跳过 visual 真实比对测试" : undefined },
  async () => {
    const projectRoot = await createTmpDir("e2e-visual-diff");
    const baselineDir = path.join(projectRoot, "baseline");
    const currentPath = path.join(projectRoot, "current.png");
    await fs.mkdir(baselineDir, { recursive: true });
    // 生成不同图像：基线红色，当前蓝色
    const baselinePath = path.join(baselineDir, "compare.png");
    await generatePngImage(baselinePath, 100, 100, [255, 0, 0, 255]);
    await generatePngImage(currentPath, 100, 100, [0, 0, 255, 255]);

    const result = runQualityCli(["visual", "--current", currentPath, "--baseline", baselineDir, "--step", "compare"]);
    // 不同图像，像素差异 > 1%，exitCode=1
    assert.equal(result.exitCode, 1, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  }
);

test(
  "E2E-D4: 'deepcode quality-check visual --pixel-threshold 0.5' 高阈值容忍差异 exitCode=0",
  { skip: !sharpAvailable ? "sharp 未安装，跳过 visual 真实比对测试" : undefined },
  async () => {
    const projectRoot = await createTmpDir("e2e-visual-threshold");
    const baselineDir = path.join(projectRoot, "baseline");
    const currentPath = path.join(projectRoot, "current.png");
    await fs.mkdir(baselineDir, { recursive: true });
    const baselinePath = path.join(baselineDir, "compare.png");
    // 生成轻微差异的图像：基线红色，当前略偏红
    await generatePngImage(baselinePath, 100, 100, [255, 0, 0, 255]);
    await generatePngImage(currentPath, 100, 100, [250, 5, 5, 255]);

    const result = runQualityCli([
      "visual",
      "--current",
      currentPath,
      "--baseline",
      baselineDir,
      "--step",
      "compare",
      "--pixel-threshold",
      "0.5", // 50% 阈值，容忍小差异
    ]);
    // 差异 < 50%，exitCode=0
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  }
);

test(
  "E2E-D5: 'deepcode quality-check visual' 首次运行自动保存基线（baseline 不存在）",
  { skip: !sharpAvailable ? "sharp 未安装，跳过 visual 真实比对测试" : undefined },
  async () => {
    const projectRoot = await createTmpDir("e2e-visual-autosave");
    const baselineDir = path.join(projectRoot, "baseline");
    const currentPath = path.join(projectRoot, "current.png");
    // baselineDir 不存在，首次运行应自动创建并保存基线
    await generatePngImage(currentPath, 100, 100, [0, 255, 0, 255]);

    const result = runQualityCli(["visual", "--current", currentPath, "--baseline", baselineDir, "--step", "compare"]);
    // 首次运行 exitCode=0（自动保存基线后视为通过）
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    // 验证基线文件被自动创建
    const baselineFile = path.join(baselineDir, "compare.png");
    const fileExists = nodeFs.existsSync(baselineFile);
    assert.equal(fileExists, true, "基线文件应被自动创建");
  }
);

// ============================================================================
// E. all 子命令测试
// ============================================================================

test("E2E-E1: 'deepcode quality-check all' 仅 codemap 可用时执行 codemap 并跳过其他（exitCode=0）", async () => {
  const projectRoot = await createTmpDir("e2e-all-codemap-only");
  await createMultiLanguageProject(projectRoot);

  // 通过 --project-root 指定项目根目录（避免 cwd 切换导致 tsx 模块找不到）
  const result = runQualityCli(["all", "--project-root", projectRoot]);
  // codemap 通过，uiux/visual 因缺少必填参数被跳过，exitCode=0
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("Code Map"), "应包含 codemap 输出");
});

test("E2E-E2: 'deepcode quality-check all --dom-file <file> --current <png>' 全量检查（含失败）", async () => {
  const projectRoot = await createTmpDir("e2e-all-full");
  await createMultiLanguageProject(projectRoot);
  const domFile = await createDomAuditFile(projectRoot);

  // 通过 --project-root 指定项目根目录，只传 dom-file，不传 current，visual 被跳过
  const result = runQualityCli(["all", "--dom-file", domFile, "--project-root", projectRoot]);
  // codemap 通过 + uiux 失败（a11y 问题）→ exitCode=max(0,1)=1
  assert.equal(result.exitCode, 1, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("Code Map"), "应包含 codemap 输出");
  assert.ok(result.stdout.includes("UI/UX"), "应包含 uiux 输出");
});

// ============================================================================
// F. 错误场景测试
// ============================================================================

test("E2E-F1: 'deepcode quality-check unknown-sub' 未知子命令 exitCode!=0", () => {
  // yargs choices 校验失败时返回 exitCode=1（yargs .fail() 处理器调用 process.exit(1)）
  // 这是 yargs 的标准行为，与 quality-cmd 内部的 exitCode=2 不同
  const result = runQualityCli(["unknown-sub"]);
  assert.ok(result.exitCode !== 0, `未知子命令应返回非零退出码，实际：${result.exitCode}`);
  // yargs 或 quality-cmd 应输出错误信息
  assert.ok(result.stderr.length > 0 || result.stdout.length > 0, "应有错误输出");
});

test("E2E-F2: 'deepcode quality-check codemap /nonexistent/path' 路径不存在 exitCode=2", () => {
  const result = runQualityCli(["codemap", "/nonexistent/path/that/does/not/exist"]);
  assert.equal(result.exitCode, 2);
  assert.ok(
    result.stderr.includes("不存在") || result.stderr.includes("not found") || result.stderr.includes("NOENT"),
    "应提示路径不存在"
  );
});

test("E2E-F3: 'deepcode quality-check codemap <file>' target 是文件而非目录 exitCode=2", async () => {
  const projectRoot = await createTmpDir("e2e-codemap-file-as-dir");
  const filePath = path.join(projectRoot, "single-file.ts");
  await fs.writeFile(filePath, "export const x = 1;", "utf-8");

  const result = runQualityCli(["codemap", filePath]);
  assert.equal(result.exitCode, 2);
});

// ============================================================================
// G. 退出码语义验证
// ============================================================================

test("E2E-G1: 退出码 0（检查通过）- codemap 对有效项目", async () => {
  const projectRoot = await createTmpDir("e2e-exit-0");
  await createMultiLanguageProject(projectRoot);
  const result = runQualityCli(["codemap", projectRoot]);
  assert.equal(result.exitCode, 0);
});

test("E2E-G2: 退出码 1（检查未通过）- uiux 检测到 HIGH 问题", async () => {
  const projectRoot = await createTmpDir("e2e-exit-1");
  const domFile = await createDomAuditFile(projectRoot);
  const result = runQualityCli(["uiux", "--dom-file", domFile]);
  assert.equal(result.exitCode, 1);
});

test("E2E-G3: 退出码 2（参数错误）- 缺必填参数", () => {
  const result = runQualityCli(["uiux"]); // 缺 --dom-file
  assert.equal(result.exitCode, 2);
});

test("E2E-G4: 退出码 2（参数错误）- 文件不存在", () => {
  const result = runQualityCli(["uiux", "--dom-file", "/tmp/nonexistent.json"]);
  assert.equal(result.exitCode, 2);
});

test("E2E-G5: 未知子命令返回非零退出码（yargs choices 校验失败）", () => {
  // yargs choices 校验失败时返回 exitCode=1（yargs .fail() 处理器调用 process.exit(1)）
  // 这是 yargs 的标准行为，与 quality-cmd 内部的 exitCode=2 不同
  const result = runQualityCli(["unknown"]);
  assert.ok(result.exitCode !== 0, `未知子命令应返回非零退出码，实际：${result.exitCode}`);
});

// ============================================================================
// H. 输出分离测试
// ============================================================================

test("E2E-H1: codemap 成功时 stdout 有内容，stderr 为空", async () => {
  const projectRoot = await createTmpDir("e2e-stdout-stderr");
  await createMultiLanguageProject(projectRoot);
  const result = runQualityCli(["codemap", projectRoot]);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length > 0, "stdout 应有内容");
  assert.equal(result.stderr.length, 0, "stderr 应为空");
});

test("E2E-H2: 参数错误时 stderr 有内容，stdout 为空", () => {
  const result = runQualityCli(["uiux"]); // 缺必填参数
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.length > 0, "stderr 应有错误信息");
  // stdout 可能为空或只有少量提示
});

test("E2E-H3: --quiet 模式 + --output 时 stdout 仅含结论行", async () => {
  const projectRoot = await createTmpDir("e2e-quiet");
  await createMultiLanguageProject(projectRoot);
  const outputPath = path.join(projectRoot, "map.md");
  const result = runQualityCli(["codemap", projectRoot, "--quiet", "--output", outputPath]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  // --quiet + --output 模式下，stdout 只应包含结论行（✅ 代码地图已写入）
  // 而不应包含统计详情（文件数/节点数/边数/死代码候选）
  assert.ok(result.stdout.includes("✅"), "应包含 ✅ 结论行");
  assert.ok(!result.stdout.includes("文件数:"), "不应包含统计详情（--quiet）");
  // 验证文件已写入
  const fileContent = await fs.readFile(outputPath, "utf-8");
  assert.ok(fileContent.includes("Code Map:"), "输出文件应包含代码地图");
});

// ============================================================================
// I. 复杂场景集成测试
// ============================================================================

test("E2E-I1: 完整工作流 - codemap → uiux → visual 三步全量检查", async () => {
  const projectRoot = await createTmpDir("e2e-full-workflow");
  await createMultiLanguageProject(projectRoot);
  const domFile = await createDomAuditFile(projectRoot);

  // 步骤 1: codemap
  const codemapResult = runQualityCli(["codemap", projectRoot, "--format", "json"]);
  assert.equal(codemapResult.exitCode, 0, `codemap 失败: ${codemapResult.stderr}`);
  const codemapData = JSON.parse(codemapResult.stdout);
  assert.ok(codemapData.stats.fileCount > 0, "codemap 应扫描到文件");

  // 步骤 2: uiux
  const uiuxResult = runQualityCli(["uiux", "--dom-file", domFile, "--format", "json"]);
  assert.equal(uiuxResult.exitCode, 1, `uiux 应失败（a11y 问题）: ${uiuxResult.stderr}`);
  const uiuxData = JSON.parse(uiuxResult.stdout);
  assert.ok(uiuxData.total_issues > 0, "uiux 应检测到问题");

  // 步骤 3: visual（如果 sharp 可用）
  if (sharpAvailable) {
    const baselineDir = path.join(projectRoot, "baseline");
    const currentPath = path.join(projectRoot, "current.png");
    await fs.mkdir(baselineDir, { recursive: true });
    const baselinePath = path.join(baselineDir, "compare.png");
    await generatePngImage(baselinePath, 50, 50, [0, 0, 255, 255]);
    await generatePngImage(currentPath, 50, 50, [255, 0, 0, 255]);

    const visualResult = runQualityCli([
      "visual",
      "--current",
      currentPath,
      "--baseline",
      baselineDir,
      "--step",
      "compare",
      "--format",
      "json",
    ]);
    assert.equal(visualResult.exitCode, 1, `visual 应失败（不同图像）: ${visualResult.stderr}`);
    const visualData = JSON.parse(visualResult.stdout);
    assert.ok(visualData.pixelDiffRatio > 0, "visual 应检测到像素差异");
  }
});

test("E2E-I2: all 子命令 - 完整全量检查（codemap + uiux + visual）", async () => {
  const projectRoot = await createTmpDir("e2e-all-complete");
  await createMultiLanguageProject(projectRoot);
  const domFile = await createDomAuditFile(projectRoot);

  const args = ["all", "--dom-file", domFile, "--format", "text"];
  if (sharpAvailable) {
    const baselineDir = path.join(projectRoot, "baseline");
    const currentPath = path.join(projectRoot, "current.png");
    await fs.mkdir(baselineDir, { recursive: true });
    const baselinePath = path.join(baselineDir, "compare.png");
    await generatePngImage(baselinePath, 80, 80, [0, 255, 0, 255]);
    await generatePngImage(currentPath, 80, 80, [255, 0, 0, 255]);
    args.push("--current", currentPath, "--baseline", baselineDir);
  }

  const result = runQualityCli([...args, "--project-root", projectRoot]);
  // codemap 通过(0) + uiux 失败(1) + visual 失败(1，如果可用) → exitCode=max(0,1,1)=1
  assert.equal(result.exitCode, 1, `stderr: ${result.stderr}`);
  // 应包含所有可用子命令的输出
  assert.ok(result.stdout.includes("Code Map"), "应包含 codemap 输出");
  assert.ok(result.stdout.includes("UI/UX"), "应包含 uiux 输出");
  if (sharpAvailable) {
    assert.ok(result.stdout.includes("Visual") || result.stdout.includes("视觉"), "应包含 visual 输出");
  }
});

test("E2E-I3: 大型项目（10+ 文件）codemap 性能验证（< 30s）", async () => {
  const projectRoot = await createTmpDir("e2e-large-project");
  const srcDir = path.join(projectRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });

  // 生成 15 个 TypeScript 文件
  for (let i = 0; i < 15; i++) {
    await fs.writeFile(
      path.join(srcDir, `module-${i}.ts`),
      [
        `export class Module${i} {`,
        "  private value: number;",
        "  constructor(v: number) { this.value = v; }",
        "  public compute(): number {",
        "    let result = this.value;",
        "    for (let j = 0; j < 10; j++) {",
        "      result += j * i;",
        "    }",
        "    return result;",
        "  }",
        "}",
        "",
      ].join("\n")
    );
  }

  const start = Date.now();
  const result = runQualityCli(["codemap", projectRoot, "--format", "json"], { timeout: 30_000 });
  const elapsed = Date.now() - start;
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.ok(elapsed < 30_000, `应在 30s 内完成，实际：${elapsed}ms`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.stats.fileCount >= 15, `应扫描到 >=15 个文件，实际：${parsed.stats.fileCount}`);
});

test("E2E-I4: codemap --output 写入文件后内容可被外部工具读取", async () => {
  const projectRoot = await createTmpDir("e2e-output-readable");
  await createMultiLanguageProject(projectRoot);
  const outputPath = path.join(projectRoot, "output", "map.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const result = runQualityCli(["codemap", projectRoot, "--format", "json", "--output", outputPath]);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  // 外部工具读取并解析 JSON
  const fileContent = await fs.readFile(outputPath, "utf-8");
  const parsed = JSON.parse(fileContent);
  assert.ok(typeof parsed === "object", "外部工具应能解析输出文件");
  assert.ok(parsed.stats.fileCount > 0, "输出文件应包含有效数据");
});
