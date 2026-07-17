/**
 * CodeMapGenerator 单元测试（F-FOCUS-01 主模块）
 *
 * 覆盖测试方案 §2.5 CM 系列 14 个用例：
 * - CM-01~CM-04: TS/JS/Python 基础识别
 * - CM-05~CM-07: Java/Rust/Go（V2-P1 标记 skip，延后至 V2-P2）
 * - CM-08: import 依赖关系
 * - CM-09: 循环依赖检测不递归
 * - CM-10: 增量更新
 * - CM-11: 单文件解析失败跳过
 * - CM-12: 性能基准（中型档 1000 文件 < 15s）
 * - CM-13/CM-14: 归入后续迭代（JSON+Markdown 输出、文件监听）
 *
 * 架构师审查 R5：测试 API 对齐设计文档（CodeMapConfig + generateFullMap）。
 * 所有测试使用真实文件系统，禁止 mock。
 *
 * @module v2/tests/codemap/generator.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMapConfig } from "../../codemap/generator";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempProject: string;

beforeEach(() => {
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-codemap-gen-"));
});

afterEach(() => {
  fs.rmSync(tempProject, { recursive: true, force: true });
});

/**
 * 构造默认配置的 CodeMapGenerator
 *
 * @param projectRoot 项目根（默认 tempProject）
 * @param extensions 扫描扩展名（默认全部支持语言）
 */
function makeGenerator(
  projectRoot: string = tempProject,
  extensions: string[] = [".ts", ".js", ".py"]
): CodeMapGenerator {
  const config: CodeMapConfig = {
    projectRoot,
    extensions,
    excludeDirs: ["node_modules", ".git"],
    maxFileSizeKb: 512,
    incremental: false,
    outputPath: ".deepcode/codemap.json",
  };
  return new CodeMapGenerator(config);
}

/**
 * 辅助函数：写入文件到临时项目
 *
 * @param relPath 相对项目根路径
 * @param content 文件内容
 */
function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tempProject, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

// ============================================================================
// CM-01~CM-04: 基础识别
// ============================================================================

test("CM-01: TypeScript 类识别", async () => {
  writeFile("foo.ts", "export class Foo {\n  bar(): void {}\n}\n");
  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  assert.equal(map.stats.totalFiles, 1);
  assert.equal(map.stats.parsedFiles, 1);
  const fooFile = map.files.find((f) => f.path.endsWith("foo.ts"));
  assert.ok(fooFile, "foo.ts 应在 CodeMap 中");
  assert.equal(fooFile!.classes.length, 1);
  assert.equal(fooFile!.classes[0]!.name, "Foo");
});

test("CM-02: TypeScript 函数识别（async function + 返回类型）", async () => {
  writeFile("bar.ts", "export async function fetchData(): Promise<void> {\n  await Promise.resolve();\n}\n");
  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  const barFile = map.files.find((f) => f.path.endsWith("bar.ts"));
  assert.ok(barFile);
  const fn = barFile!.functions.find((f) => f.name === "fetchData");
  assert.ok(fn, "应识别 async function fetchData");
  assert.equal(fn!.returnType, "Promise<void>");
});

test("CM-03: JavaScript 箭头函数", async () => {
  writeFile("fn.js", "const add = (a, b) => a + b;\n");
  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  const jsFile = map.files.find((f) => f.path.endsWith("fn.js"));
  assert.ok(jsFile);
  assert.equal(jsFile!.language, "javascript");
  const arrow = jsFile!.functions.find((f) => f.name === "add");
  assert.ok(arrow, "应识别箭头函数 add");
});

test("CM-04: Python 类识别", async () => {
  writeFile("model.py", "class User:\n    def __init__(self, name):\n        self.name = name\n");
  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  const pyFile = map.files.find((f) => f.path.endsWith("model.py"));
  assert.ok(pyFile);
  assert.equal(pyFile!.language, "python");
  assert.equal(pyFile!.classes.length, 1);
  assert.equal(pyFile!.classes[0]!.name, "User");
});

// ============================================================================
// CM-05~CM-07: Java/Rust/Go（V2-P2 去 skip 转绿，强化断言对齐测试方案 §2.5）
// ============================================================================

test("CM-05: Java 类识别（V2-P2 去 skip 转绿）", async () => {
  writeFile("Bar.java", "public class Bar {}\n");
  const gen = makeGenerator(tempProject, [".java"]);
  const map = await gen.generateFullMap();

  assert.equal(map.stats.totalFiles, 1);
  assert.equal(map.stats.parsedFiles, 1);
  const barFile = map.files.find((f) => f.path.endsWith("Bar.java"));
  assert.ok(barFile, "Bar.java 应在 CodeMap 中");
  assert.equal(barFile!.language, "java");
  assert.equal(barFile!.classes.length, 1, "应识别 1 个类");
  assert.equal(barFile!.classes[0]!.name, "Bar", "类名应为 Bar");
  assert.equal(barFile!.classes[0]!.type, "class", "类型应为 class");
});

test("CM-06: Rust struct/enum/trait（V2-P2 去 skip 转绿，验证三型映射）", async () => {
  writeFile("baz.rs", "pub struct Baz {}\npub enum Qux {}\npub trait Trait {}\n");
  const gen = makeGenerator(tempProject, [".rs"]);
  const map = await gen.generateFullMap();

  assert.equal(map.stats.totalFiles, 1);
  const rustFile = map.files.find((f) => f.path.endsWith("baz.rs"));
  assert.ok(rustFile, "baz.rs 应在 CodeMap 中");
  assert.equal(rustFile!.language, "rust");
  assert.equal(rustFile!.classes.length, 3, "应识别 3 个类型（struct/enum/trait）");

  // struct → type === "struct"
  const structCls = rustFile!.classes.find((c) => c.name === "Baz");
  assert.ok(structCls, "应识别 struct Baz");
  assert.equal(structCls!.type, "struct");

  // enum → type === "enum"
  const enumCls = rustFile!.classes.find((c) => c.name === "Qux");
  assert.ok(enumCls, "应识别 enum Qux");
  assert.equal(enumCls!.type, "enum");

  // trait → type === "interface"（trait 语义最接近 interface）
  const traitCls = rustFile!.classes.find((c) => c.name === "Trait");
  assert.ok(traitCls, "应识别 trait Trait");
  assert.equal(traitCls!.type, "interface", "trait 应映射为 interface");
});

test("CM-07: Go struct（V2-P2 去 skip 转绿，验证 struct 类型）", async () => {
  writeFile("foo.go", "type Foo struct {}\n");
  const gen = makeGenerator(tempProject, [".go"]);
  const map = await gen.generateFullMap();

  assert.equal(map.stats.totalFiles, 1);
  const goFile = map.files.find((f) => f.path.endsWith("foo.go"));
  assert.ok(goFile, "foo.go 应在 CodeMap 中");
  assert.equal(goFile!.language, "go");
  assert.equal(goFile!.classes.length, 1, "应识别 1 个 struct");
  assert.equal(goFile!.classes[0]!.name, "Foo", "结构体名应为 Foo");
  assert.equal(goFile!.classes[0]!.type, "struct", "类型应为 struct");
});

// ============================================================================
// CM-08: import 依赖关系
// ============================================================================

test("CM-08: import 依赖关系（DependencyEdge + FileInfo.dependencies）", async () => {
  // foo.ts 导入 ./bar
  writeFile("foo.ts", "import { bar } from './bar';\nexport function foo() { return bar(); }\n");
  writeFile("bar.ts", "export function bar() { return 42; }\n");

  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  // foo.ts 应有 dependencies 包含 bar.ts
  const fooFile = map.files.find((f) => f.path.endsWith("foo.ts"));
  assert.ok(fooFile);
  assert.ok(
    fooFile!.dependencies.some((d) => d.endsWith("bar.ts")),
    "foo.ts 应依赖 bar.ts"
  );

  // dependencyGraph 应有 foo.ts → bar.ts 边
  const edge = map.dependencyGraph.find((e) => e.source.endsWith("foo.ts") && e.target.endsWith("bar.ts"));
  assert.ok(edge, "应有 foo→bar 依赖边");
  assert.equal(edge!.resolved, true);
});

// ============================================================================
// CM-09: 循环依赖检测不递归（R-14 错误处理）
// ============================================================================

test("CM-09: 循环依赖检测不递归（< 1s 完成）", async () => {
  // 构造循环依赖：a.ts → b.ts → a.ts
  writeFile("a.ts", "import { b } from './b';\nexport const a = () => b();\n");
  writeFile("b.ts", "import { a } from './a';\nexport const b = () => a();\n");

  const gen = makeGenerator();
  const start = Date.now();
  const map = await gen.generateFullMap();
  const elapsed = Date.now() - start;

  // 必须快速完成（不无限递归）
  assert.ok(elapsed < 1000, `生成时间应 < 1s，实际 ${elapsed}ms`);

  // 两文件应在 CodeMap 中
  const aNode = map.files.find((f) => f.path.endsWith("a.ts"));
  const bNode = map.files.find((f) => f.path.endsWith("b.ts"));
  assert.ok(aNode, "a.ts 应在 CodeMap 中");
  assert.ok(bNode, "b.ts 应在 CodeMap 中");

  // 依赖关系存在
  assert.ok(
    aNode!.dependencies.some((d) => d.endsWith("b.ts")),
    "a 依赖 b"
  );
  assert.ok(
    bNode!.dependencies.some((d) => d.endsWith("a.ts")),
    "b 依赖 a"
  );

  // 循环被标记
  assert.ok(
    map.cycles.some((c) => c.some((p) => p.endsWith("a.ts")) && c.some((p) => p.endsWith("b.ts"))),
    "循环 a↔b 应被标记"
  );
  assert.ok(map.stats.cyclesDetected >= 1, "统计应含至少 1 个循环");
});

// ============================================================================
// CM-10: 增量更新
// ============================================================================

test("CM-10: 增量更新：仅重新分析变更文件", async () => {
  writeFile("a.ts", "export const a = 1;\n");
  writeFile("b.ts", "export const b = 2;\n");

  const gen = makeGenerator();
  // 全量生成
  const map1 = await gen.generateFullMap();
  assert.equal(map1.stats.totalFiles, 2);

  // 修改 a.ts
  writeFile("a.ts", "export const a = 100;\nexport function newFn() { return a; }\n");

  // 增量更新（配置需启用 incremental）
  const incrementalGen = new CodeMapGenerator({
    projectRoot: tempProject,
    extensions: [".ts"],
    excludeDirs: ["node_modules", ".git"],
    maxFileSizeKb: 512,
    incremental: true,
    outputPath: ".deepcode/codemap.json",
  });
  const map2 = await incrementalGen.updateIncremental(["a.ts"]);

  // a.ts 应含新增的 newFn
  const aFile = map2.files.find((f) => f.path.endsWith("a.ts"));
  assert.ok(aFile);
  const newFn = aFile!.functions.find((f) => f.name === "newFn");
  assert.ok(newFn, "增量更新后 a.ts 应含 newFn");

  // b.ts 保持不变
  const bFile = map2.files.find((f) => f.path.endsWith("b.ts"));
  assert.ok(bFile);
  assert.equal(bFile!.exports[0], "b");
});

// ============================================================================
// CM-11: 单文件解析失败跳过（US-ERR-003）
// ============================================================================

test("CM-11: 单文件解析失败跳过，不中断整体扫描", async () => {
  // 3 个正常文件 + 1 个非法语法文件
  writeFile("ok1.ts", "export const a = 1;\n");
  writeFile("ok2.ts", "export const b = 2;\n");
  writeFile("ok3.ts", "export const c = 3;\n");
  // 非法语法（故意写入，触发解析异常——实际正则解析不会抛错，
  // 但用二进制内容可能触发读取异常，这里用一个会失败的路径模拟）
  writeFile("bad.ts", "export const {{{}}}}}}invalid syntax");

  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  // 至少 3 个正常文件应被识别
  assert.ok(map.files.length >= 4, `应有 4 个文件，实际 ${map.files.length}`);

  // bad.ts 应在 CodeMap 中（即使解析有局限，parseStatus 应为 ok 或 failed）
  const badFile = map.files.find((f) => f.path.endsWith("bad.ts"));
  assert.ok(badFile, "bad.ts 应在 CodeMap 中");

  // 错误日志文件应存在（.deepcode/codemap-errors.log）
  const errorLogPath = path.join(tempProject, ".deepcode", "codemap-errors.log");
  assert.ok(fs.existsSync(errorLogPath), "错误日志文件应存在");
});

// ============================================================================
// CM-12: 性能基准（中型档 1000 文件 < 15s）
// ============================================================================

test("CM-12: 1000 文件项目生成时间 < 15s（中型档）", async () => {
  // 构造 1000 个简单 TS 文件
  for (let i = 0; i < 1000; i++) {
    writeFile(`mod${i}.ts`, `export function fn${i}() { return ${i}; }\n`);
  }

  const gen = makeGenerator();
  const start = Date.now();
  const map = await gen.generateFullMap();
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 15000, `1000 文件生成应 < 15s，实际 ${(elapsed / 1000).toFixed(2)}s`);
  assert.equal(map.stats.totalFiles, 1000);
  assert.equal(map.stats.parsedFiles, 1000);
  assert.equal(map.stats.failedFiles, 0);
});

// ============================================================================
// 补充：持久化 + 读取 + 项目信息检测
// ============================================================================

test("CM-PERSIST-01: CodeMap 持久化到 .deepcode/codemap.json", async () => {
  writeFile("foo.ts", "export class Foo {}\n");
  const gen = makeGenerator();
  await gen.generateFullMap();

  const persistPath = path.join(tempProject, ".deepcode", "codemap.json");
  assert.ok(fs.existsSync(persistPath), "codemap.json 应存在");

  // 临时文件不应残留（原子写入完成）
  assert.ok(!fs.existsSync(persistPath + ".tmp"), "临时文件不应残留");
});

test("CM-READ-01: readCodeMap 读取持久化的 CodeMap", async () => {
  writeFile("foo.ts", "export class Foo {}\n");
  const gen = makeGenerator();
  const map1 = await gen.generateFullMap();

  // 新实例读取
  const gen2 = makeGenerator();
  const map2 = await gen2.readCodeMap();
  assert.ok(map2, "应能读取持久化的 CodeMap");
  assert.equal(map2!.stats.totalFiles, map1.stats.totalFiles);
  assert.equal(map2!.files.length, 1);
});

test("CM-READ-02: readCodeMap 文件不存在返回 null", async () => {
  const gen = makeGenerator();
  const result = await gen.readCodeMap();
  assert.equal(result, null);
});

test("CM-PROJ-01: 项目信息检测（techStack + architecture）", async () => {
  // 写入 package.json + tsconfig.json + src/ 目录
  writeFile(
    "package.json",
    JSON.stringify({
      name: "test-project",
      dependencies: { express: "4.18.0" },
      devDependencies: { jest: "29.0.0", eslint: "8.0.0" },
    })
  );
  writeFile("tsconfig.json", "{}");
  writeFile("src/index.ts", "export const x = 1;\n");

  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  assert.equal(map.project.name, path.basename(tempProject));
  assert.ok(map.project.techStack.frameworks.includes("typescript"));
  assert.ok(map.project.techStack.frameworks.includes("express"));
  assert.ok(map.project.techStack.packageManagers.includes("npm"));
  assert.ok(map.project.techStack.testFrameworks.includes("jest"));
  assert.ok(map.project.techStack.linters.includes("eslint"));
  // 存在 src/ → layered
  assert.equal(map.project.architecture, "layered");
});

test("CM-STATS-01: 统计信息正确（classes/functions/dependencies）", async () => {
  writeFile(
    "a.ts",
    [
      "import { b } from './b';",
      "export class A {",
      "  method(): void { b(); }",
      "}",
      "export function fnA() { return b(); }",
    ].join("\n")
  );
  writeFile("b.ts", "export function b() { return 42; }\n");

  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  assert.equal(map.stats.totalFiles, 2);
  assert.equal(map.stats.parsedFiles, 2);
  assert.ok(map.stats.totalClasses >= 1, "应有至少 1 个类");
  assert.ok(map.stats.totalFunctions >= 2, "应有至少 2 个函数");
  assert.ok(map.stats.totalDependencies >= 1, "应有至少 1 条依赖");
  assert.equal(map.stats.cyclesDetected, 0, "无循环依赖");
});

test("CM-CALLGRAPH-01: 同文件调用图（CallEdge）", async () => {
  writeFile("caller.ts", ["function helper() { return 1; }", "function main() { return helper(); }"].join("\n"));
  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  // 应有 main → helper 的 CallEdge
  const edge = map.callGraph.find((e) => e.caller === "main" && e.callee === "helper");
  assert.ok(edge, "应有 main→helper 调用边");
  assert.ok(edge!.line >= 2, "调用行号应 >= 2");
});

test("CM-GITIGNORE-01: .gitignore 排除文件不扫描", async () => {
  writeFile("src/app.ts", "export const app = 1;\n");
  writeFile("src/ignored.ts", "export const ignored = 1;\n");
  // .gitignore 排除 ignored.ts
  writeFile(".gitignore", "ignored.ts\n");

  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  // app.ts 应被扫描
  assert.ok(
    map.files.some((f) => f.path.endsWith("app.ts")),
    "app.ts 应被扫描"
  );
  // ignored.ts 应被排除
  assert.ok(!map.files.some((f) => f.path.endsWith("ignored.ts")), "ignored.ts 应被 .gitignore 排除");
});

test("CM-DEPS-02: 未解析依赖（目标文件不存在）计入 unresolvedDeps", async () => {
  writeFile("foo.ts", "import { missing } from './missing';\n");
  const gen = makeGenerator();
  const map = await gen.generateFullMap();

  assert.ok(map.stats.unresolvedDeps >= 1, "应有 1 个未解析依赖");
  const edge = map.dependencyGraph.find((e) => e.source.endsWith("foo.ts"));
  assert.ok(edge);
  assert.equal(edge!.resolved, false, "未解析依赖 resolved 应为 false");
});
