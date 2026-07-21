/**
 * CodeMap Markdown 渲染器单元测试（CM-13）
 *
 * 覆盖测试方案 §2.5 CM-13：CodeMap Markdown 输出
 *
 * 测试范围：
 * - 纯函数行为：输入 CodeMap 对象 → 输出 Markdown 字符串
 * - 9 个章节渲染：标题 / 项目信息 / 统计信息 / 模块 / 文件 / 依赖图 / 调用图 / 循环 / 失败文件
 * - 空数据优雅降级（空数组显示"（无 ...）"）
 * - Markdown 表格转义（管道符）
 * - 真实 CodeMapGenerator 集成（端到端：生成 CodeMap → 渲染 Markdown）
 *
 * 设计依据：
 * - V2 测试方案 §2.5 CM-13
 * - 架构师审查报告（2026-07-21）：纯函数实现，禁止 mock，使用真实文件系统
 *
 * @module v2/tests/codemap/markdown-renderer.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMap, CodeMapConfig } from "../../codemap/generator";
import { renderCodeMapAsMarkdown } from "../../codemap/markdown-renderer";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempProject: string;

beforeEach(() => {
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-md-render-"));
});

afterEach(() => {
  fs.rmSync(tempProject, { recursive: true, force: true });
});

/**
 * 构造默认配置的 CodeMapGenerator
 */
function makeGenerator(): CodeMapGenerator {
  const config: CodeMapConfig = {
    projectRoot: tempProject,
    extensions: [".ts", ".js", ".py"],
    excludeDirs: ["node_modules", ".git"],
    maxFileSizeKb: 512,
    incremental: false,
    outputPath: ".deepcode/codemap.json",
  };
  return new CodeMapGenerator(config);
}

/**
 * 写入文件到临时项目
 */
function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tempProject, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/**
 * 构造最小合法 CodeMap 对象（用于纯函数测试）
 */
function makeMinimalCodeMap(): CodeMap {
  return {
    project: {
      name: "test-project",
      root: "/tmp/test",
      techStack: {
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        testFrameworks: [],
        linters: [],
      },
      architecture: "unknown",
      languages: ["TypeScript"],
    },
    modules: [],
    files: [],
    callGraph: [],
    dependencyGraph: [],
    cycles: [],
    generatedAt: "2026-07-21T00:00:00.000Z",
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      totalClasses: 0,
      totalFunctions: 0,
      totalDependencies: 0,
      cyclesDetected: 0,
      unresolvedDeps: 0,
      generationTimeMs: 0,
    },
  };
}

// ============================================================================
// 纯函数行为测试
// ============================================================================

test("CM-13-01: 纯函数不修改输入 CodeMap 对象", () => {
  const codeMap = makeMinimalCodeMap();
  const snapshot = JSON.stringify(codeMap);

  // 调用渲染函数
  renderCodeMapAsMarkdown(codeMap);

  // 验证输入对象未被修改
  assert.equal(JSON.stringify(codeMap), snapshot, "渲染函数不应修改输入对象");
});

test("CM-13-02: 返回值为非空字符串", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.equal(typeof markdown, "string", "返回值应为字符串");
  assert.ok(markdown.length > 0, "返回值不应为空");
  // 应以换行结尾
  assert.ok(markdown.endsWith("\n"), "Markdown 应以换行结尾");
});

// ============================================================================
// 章节 1：标题测试
// ============================================================================

test("CM-13-03: 标题包含项目名和生成时间", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /# 代码地图：test-project/, "应包含项目名标题");
  assert.match(markdown, /> 生成时间：2026-07-21T00:00:00\.000Z/, "应包含生成时间");
});

// ============================================================================
// 章节 2：项目元信息测试
// ============================================================================

test("CM-13-04: 项目元信息包含根目录、架构、语言、技术栈", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.project.root = "/var/www/project";
  codeMap.project.architecture = "monorepo";
  codeMap.project.languages = ["TypeScript", "JavaScript"];
  codeMap.project.techStack = {
    frameworks: ["React", "Express"],
    buildTools: ["Vite"],
    packageManagers: ["npm"],
    testFrameworks: ["node:test"],
    linters: ["ESLint"],
  };

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /\/var\/www\/project/, "应包含根目录");
  assert.match(markdown, /架构类型.*monorepo/, "应包含架构类型");
  assert.match(markdown, /支持语言.*TypeScript.*JavaScript/, "应包含语言");
  assert.match(markdown, /框架.*React.*Express/, "应包含框架");
  assert.match(markdown, /构建工具.*Vite/, "应包含构建工具");
  assert.match(markdown, /包管理器.*npm/, "应包含包管理器");
  assert.match(markdown, /测试框架.*node:test/, "应包含测试框架");
  assert.match(markdown, /Linter.*ESLint/, "应包含 linter");
});

test("CM-13-05: 空技术栈字段显示'未识别'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /框架.*未识别/, "空框架应显示未识别");
  assert.match(markdown, /构建工具.*未识别/, "空构建工具应显示未识别");
});

test("CM-13-06: 空语言列表显示'未识别'", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.project.languages = [];
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /支持语言.*未识别/, "空语言列表应显示未识别");
});

// ============================================================================
// 章节 3：统计信息测试
// ============================================================================

test("CM-13-07: 统计信息表格包含全部 10 个指标", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.stats = {
    totalFiles: 100,
    parsedFiles: 95,
    failedFiles: 5,
    totalClasses: 50,
    totalFunctions: 200,
    totalDependencies: 80,
    cyclesDetected: 3,
    unresolvedDeps: 2,
    generationTimeMs: 1500,
  };

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /文件总数.*100/, "应包含 totalFiles");
  assert.match(markdown, /成功解析.*95/, "应包含 parsedFiles");
  assert.match(markdown, /解析失败.*5/, "应包含 failedFiles");
  assert.match(markdown, /类总数.*50/, "应包含 totalClasses");
  assert.match(markdown, /函数总数.*200/, "应包含 totalFunctions");
  assert.match(markdown, /依赖关系总数.*80/, "应包含 totalDependencies");
  assert.match(markdown, /循环依赖数.*3/, "应包含 cyclesDetected");
  assert.match(markdown, /未解析依赖数.*2/, "应包含 unresolvedDeps");
  assert.match(markdown, /生成耗时.*1500/, "应包含 generationTimeMs");
});

// ============================================================================
// 章节 4：模块列表测试
// ============================================================================

test("CM-13-08: 空模块列表显示'（无模块）'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /## 模块列表[\s\S]*?（无模块）/, "空模块列表应显示无模块");
});

test("CM-13-09: 模块列表渲染名称、路径、描述、依赖、导出、文件", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.modules = [
    {
      name: "core",
      path: "src/core",
      description: "核心模块",
      dependencies: ["react"],
      exports: ["Foo", "Bar"],
      files: ["src/core/foo.ts", "src/core/bar.ts"],
    },
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /### core/, "应包含模块名");
  assert.match(markdown, /路径.*src\/core/, "应包含模块路径");
  assert.match(markdown, /描述.*核心模块/, "应包含模块描述");
  assert.match(markdown, /依赖.*react/, "应包含模块依赖");
  assert.match(markdown, /导出.*Foo.*Bar/, "应包含模块导出");
  assert.match(markdown, /文件数.*2/, "应包含文件数");
  // 文件清单折叠展示
  assert.match(markdown, /<details>/, "应使用 details 折叠文件清单");
  assert.match(markdown, /src\/core\/foo\.ts/, "应包含文件路径 foo.ts");
  assert.match(markdown, /src\/core\/bar\.ts/, "应包含文件路径 bar.ts");
});

test("CM-13-10: 空描述/空依赖/空导出显示'（无）'或'（无描述）'", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.modules = [
    {
      name: "empty",
      path: "src/empty",
      description: "",
      dependencies: [],
      exports: [],
      files: [],
    },
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /描述.*（无描述）/, "空描述应显示无描述");
  assert.match(markdown, /依赖.*（无）/, "空依赖应显示无");
  assert.match(markdown, /导出.*（无）/, "空导出应显示无");
});

// ============================================================================
// 章节 5：文件列表测试
// ============================================================================

test("CM-13-11: 空文件列表显示'（无文件）'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /## 文件列表[\s\S]*?（无文件）/, "空文件列表应显示无文件");
});

test("CM-13-12: 文件列表渲染表格（路径/语言/行数/状态/类数/函数数）", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.files = [
    {
      path: "src/foo.ts",
      language: "typescript",
      classes: [{ name: "Foo", type: "class", methods: [], properties: [], startLine: 1, endLine: 10 }],
      functions: [
        { name: "bar", signature: "bar()", params: "()", returnType: "void", startLine: 2, endLine: 5, calls: [] },
      ],
      imports: [],
      exports: ["Foo"],
      lines: 10,
      parseStatus: "ok",
      dependencies: [],
    },
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /\| 路径 \| 语言 \| 行数 \| 解析状态 \| 类数 \| 函数数 \|/, "应包含表头");
  assert.match(markdown, /src\/foo\.ts \| typescript \| 10 \| ok \| 1 \| 1/, "应包含文件数据");
});

test("CM-13-13: 文件路径中的管道符被转义", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.files = [
    {
      path: "src/foo|bar.ts",
      language: "typescript",
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      lines: 5,
      parseStatus: "ok",
      dependencies: [],
    },
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  // 管道符应被转义为 \|
  assert.match(markdown, /src\/foo\\|bar\.ts/, "管道符应被转义为 \\|");
});

// ============================================================================
// 章节 6：依赖关系图测试
// ============================================================================

test("CM-13-14: 空依赖图显示'（无依赖关系）'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /## 依赖关系图[\s\S]*?（无依赖关系）/, "空依赖图应显示无依赖关系");
});

test("CM-13-15: 依赖图渲染表格（源/目标/类型/已解析）", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.dependencyGraph = [
    { source: "src/foo.ts", target: "src/bar.ts", type: "import", resolved: true },
    { source: "src/baz.ts", target: "src/missing.ts", type: "require", resolved: false },
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /\| 源文件 \| 目标文件 \| 类型 \| 已解析 \|/, "应包含依赖图表头");
  assert.match(markdown, /src\/foo\.ts \| src\/bar\.ts \| import \| ✅/, "已解析依赖应显示 ✅");
  assert.match(markdown, /src\/baz\.ts \| src\/missing\.ts \| require \| ❌/, "未解析依赖应显示 ❌");
});

// ============================================================================
// 章节 7：调用关系图测试
// ============================================================================

test("CM-13-16: 空调用图显示'（无调用关系）'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /## 调用关系图[\s\S]*?（无调用关系）/, "空调用图应显示无调用关系");
});

test("CM-13-17: 调用图渲染表格（调用方/被调用方/文件/行号）", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.callGraph = [{ caller: "Foo.bar", callee: "helper", file: "src/foo.ts", line: 10 }];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /\| 调用方 \| 被调用方 \| 文件 \| 行号 \|/, "应包含调用图表头");
  assert.match(markdown, /Foo\.bar \| helper \| src\/foo\.ts \| 10/, "应包含调用数据");
});

// ============================================================================
// 章节 8：循环依赖测试
// ============================================================================

test("CM-13-18: 空循环依赖显示'（无循环依赖）'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /## 循环依赖[\s\S]*?（无循环依赖）/, "空循环依赖应显示无循环依赖");
});

test("CM-13-19: 循环依赖渲染为路径链（首尾相同形成闭环）", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.cycles = [["src/a.ts", "src/b.ts", "src/c.ts"]];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /### 循环 #1/, "应包含循环编号");
  // 路径链：src/a.ts → src/b.ts → src/c.ts → src/a.ts
  assert.match(markdown, /src\/a\.ts → src\/b\.ts → src\/c\.ts → src\/a\.ts/, "应渲染为闭环路径链");
});

test("CM-13-20: 多条循环依赖依次渲染", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.cycles = [
    ["src/a.ts", "src/b.ts"],
    ["src/x.ts", "src/y.ts", "src/z.ts"],
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /### 循环 #1/, "应包含循环 #1");
  assert.match(markdown, /### 循环 #2/, "应包含循环 #2");
  assert.match(markdown, /src\/a\.ts → src\/b\.ts → src\/a\.ts/, "循环 1 路径链正确");
  assert.match(markdown, /src\/x\.ts → src\/y\.ts → src\/z\.ts → src\/x\.ts/, "循环 2 路径链正确");
});

// ============================================================================
// 章节 9：失败文件清单测试
// ============================================================================

test("CM-13-21: 无失败文件显示'（无失败文件）'", () => {
  const codeMap = makeMinimalCodeMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);
  assert.match(markdown, /## 失败文件清单[\s\S]*?（无失败文件）/, "无失败文件应显示提示");
});

test("CM-13-22: 失败文件清单仅展示 parseStatus=failed 的文件", () => {
  const codeMap = makeMinimalCodeMap();
  codeMap.files = [
    {
      path: "src/ok.ts",
      language: "typescript",
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      lines: 5,
      parseStatus: "ok",
      dependencies: [],
    },
    {
      path: "src/failed.ts",
      language: "typescript",
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      lines: 100,
      parseStatus: "failed",
      dependencies: [],
    },
  ];

  const markdown = renderCodeMapAsMarkdown(codeMap);
  // 失败文件清单章节应包含 failed.ts，不应包含 ok.ts
  const failedSection = markdown.split("## 失败文件清单")[1] ?? "";
  assert.match(failedSection, /src\/failed\.ts/, "失败文件清单应包含 failed.ts");
  assert.doesNotMatch(failedSection, /src\/ok\.ts/, "失败文件清单不应包含 ok.ts");
});

// ============================================================================
// 端到端集成测试：CodeMapGenerator → renderCodeMapAsMarkdown
// ============================================================================

test("CM-13-23: 端到端集成 - 真实生成 CodeMap 后渲染 Markdown", async () => {
  // 准备真实项目结构
  // 注意：import 路径不带 .js 扩展名，便于 resolveDependency 解析到 .ts 文件
  // （ESM .js 扩展名约定由 tsconfig 处理，CodeMap 依赖解析使用候选扩展名表）
  writeFile("src/foo.ts", "export class Foo {\n  bar(): void {}\n}\n");
  writeFile("src/baz.ts", "import { Foo } from './foo';\n\nexport function useFoo(): Foo {\n  return new Foo();\n}\n");

  // 真实生成 CodeMap
  const generator = makeGenerator();
  const codeMap = await generator.generateFullMap();

  // 渲染为 Markdown
  const markdown = renderCodeMapAsMarkdown(codeMap);

  // 验证 Markdown 包含真实数据
  assert.match(markdown, /# 代码地图/, "应包含标题");
  assert.match(markdown, /## 项目信息/, "应包含项目信息章节");
  assert.match(markdown, /## 统计信息/, "应包含统计信息章节");
  assert.match(markdown, /## 文件列表/, "应包含文件列表章节");

  // 应包含真实文件路径
  assert.match(markdown, /src\/foo\.ts/, "应包含 foo.ts 文件");
  assert.match(markdown, /src\/baz\.ts/, "应包含 baz.ts 文件");

  // 应包含类信息
  assert.match(markdown, /Foo/, "应包含 Foo 类");

  // 应包含依赖关系（baz.ts → foo.ts 已解析）
  assert.match(markdown, /src\/baz\.ts \| src\/foo\.ts \| import \| ✅/, "应包含 baz.ts → foo.ts 依赖");
});

test("CM-13-24: 端到端 - 包含循环依赖的 CodeMap 渲染", async () => {
  // 准备循环依赖结构：a.ts ↔ b.ts
  // 注意：import 路径不带 .js 扩展名，便于 resolveDependency 解析到 .ts 文件
  writeFile("src/a.ts", "import { b } from './b';\nexport function a(): void { b(); }\n");
  writeFile("src/b.ts", "import { a } from './a';\nexport function b(): void { a(); }\n");

  const generator = makeGenerator();
  const codeMap = await generator.generateFullMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);

  // 应检测到循环依赖并正确渲染
  assert.ok(codeMap.cycles.length > 0, "应检测到至少 1 条循环依赖");
  assert.match(markdown, /### 循环 #1/, "应包含循环编号");
  assert.match(markdown, /src\/[ab]\.ts → src\/[ab]\.ts → src\/[ab]\.ts/, "应渲染循环路径链");
});

test("CM-13-25: 端到端 - 空项目渲染不报错", async () => {
  // 空项目（无任何源文件）
  const generator = makeGenerator();
  const codeMap = await generator.generateFullMap();
  const markdown = renderCodeMapAsMarkdown(codeMap);

  // 空项目应渲染成功，且各章节显示"（无 ...）"
  assert.match(markdown, /# 代码地图/, "应包含标题");
  assert.match(markdown, /文件总数 \| 0/, "空项目 totalFiles=0");
  assert.match(markdown, /（无模块）/, "应显示无模块");
  assert.match(markdown, /（无文件）/, "应显示无文件");
  assert.match(markdown, /（无依赖关系）/, "应显示无依赖关系");
  assert.match(markdown, /（无调用关系）/, "应显示无调用关系");
  assert.match(markdown, /（无循环依赖）/, "应显示无循环依赖");
  assert.match(markdown, /（无失败文件）/, "应显示无失败文件");
});
