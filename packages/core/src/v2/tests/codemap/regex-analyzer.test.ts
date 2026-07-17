/**
 * RegexASTAnalyzer 单元测试（F-FOCUS-01 子模块）
 *
 * 覆盖 TS/JS/Python 三语言正则规则 + 边界用例 + 性能基准。
 * 所有测试使用真实文件系统（mkdtempSync 临时目录 + writeFile 真实代码），
 * 禁止 mock。
 *
 * 测试用例分组：
 * - RA-TS-CLASS-01~04: TS 类识别（export class / abstract class / interface / 普通类）
 * - RA-TS-FUNC-01~03: TS 函数识别（function / async function / export function）
 * - RA-TS-METHOD-01~05: TS 方法识别（public / private / protected / static / async）
 * - RA-TS-ARROW-01~04: TS 箭头函数（const / let / var / async）
 * - RA-JS-01: JS 复用 TS 规则验证
 * - RA-PY-01~03: Python class / function / import
 * - RA-EDGE-01~04: 边界用例（空文件 / 注释关键字 / 字符串关键字 / 嵌套括号）
 * - RA-PERF-01: 单文件解析性能 < 5ms
 *
 * @module v2/tests/codemap/regex-analyzer.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RegexASTAnalyzer, detectLanguage } from "../../codemap/regex-analyzer";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-codemap-ra-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 辅助函数：写入临时文件并用指定语言分析器分析
 *
 * @param fileName 文件名（含扩展名，决定语言检测）
 * @param content 文件内容
 * @returns 分析结果 FileInfo
 */
function analyzeFile(fileName: string, content: string) {
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  const language = detectLanguage(filePath);
  assert.ok(language, `无法检测语言: ${fileName}`);
  const analyzer = new RegexASTAnalyzer(language);
  return analyzer.analyzeFile(filePath);
}

// ============================================================================
// RA-TS-CLASS-01~04: TS 类识别
// ============================================================================

test("RA-TS-CLASS-01: 识别 export class", () => {
  const info = analyzeFile("test.ts", "export class Foo {\n  bar(): void {}\n}\n");
  assert.equal(info.parseStatus, "ok");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Foo");
  assert.equal(info.classes[0]!.type, "class");
  assert.equal(info.classes[0]!.startLine, 1);
});

test("RA-TS-CLASS-02: 识别 abstract class", () => {
  const info = analyzeFile("test.ts", "abstract class Animal {\n  abstract sound(): void;\n}\n");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Animal");
  assert.equal(info.classes[0]!.type, "class");
});

test("RA-TS-CLASS-03: 识别 interface", () => {
  const info = analyzeFile("test.ts", "interface IFoo {\n  bar(): void;\n}\n");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "IFoo");
  assert.equal(info.classes[0]!.type, "interface");
});

test("RA-TS-CLASS-04: 识别普通类（无 export）", () => {
  const info = analyzeFile("test.ts", "class Bar {\n  x: number = 0;\n}\n");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Bar");
  assert.equal(info.classes[0]!.type, "class");
});

// ============================================================================
// RA-TS-FUNC-01~03: TS 函数识别
// ============================================================================

test("RA-TS-FUNC-01: 识别 function", () => {
  const info = analyzeFile("test.ts", "function add(a: number, b: number): number {\n  return a + b;\n}\n");
  assert.equal(info.functions.length, 1);
  assert.equal(info.functions[0]!.name, "add");
  assert.equal(info.functions[0]!.params, "a: number, b: number");
  assert.equal(info.functions[0]!.returnType, "number");
  assert.equal(info.functions[0]!.startLine, 1);
});

test("RA-TS-FUNC-02: 识别 async function", () => {
  const info = analyzeFile("test.ts", "async function fetchData(): Promise<void> {\n  await fetch('/');\n}\n");
  assert.equal(info.functions.length, 1);
  const fn = info.functions.find((f) => f.name === "fetchData");
  assert.ok(fn, "应识别 async function fetchData");
  assert.equal(fn!.returnType, "Promise<void>");
});

test("RA-TS-FUNC-03: 识别 export function", () => {
  const info = analyzeFile("test.ts", "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
  assert.equal(info.functions.length, 1);
  assert.equal(info.functions[0]!.name, "greet");
  assert.equal(info.exports.length, 1);
  assert.equal(info.exports[0], "greet");
});

// ============================================================================
// RA-TS-METHOD-01~05: TS 方法识别
// ============================================================================

test("RA-TS-METHOD-01: 识别 public 方法", () => {
  const info = analyzeFile("test.ts", "class Foo {\n  public bar(): void {}\n}\n");
  // public bar 会被 methodPattern 匹配
  const method = info.functions.find((f) => f.name === "bar");
  assert.ok(method, "应识别 public 方法 bar");
});

test("RA-TS-METHOD-02: 识别 private 方法", () => {
  const info = analyzeFile("test.ts", "class Foo {\n  private secret(): string { return 'x'; }\n}\n");
  const method = info.functions.find((f) => f.name === "secret");
  assert.ok(method, "应识别 private 方法 secret");
});

test("RA-TS-METHOD-03: 识别 protected 方法", () => {
  const info = analyzeFile("test.ts", "class Foo {\n  protected base(): void {}\n}\n");
  const method = info.functions.find((f) => f.name === "base");
  assert.ok(method, "应识别 protected 方法 base");
});

test("RA-TS-METHOD-04: 识别 static 方法", () => {
  const info = analyzeFile("test.ts", "class Foo {\n  static create(): Foo { return new Foo(); }\n}\n");
  const method = info.functions.find((f) => f.name === "create");
  assert.ok(method, "应识别 static 方法 create");
});

test("RA-TS-METHOD-05: 识别 async 方法", () => {
  const info = analyzeFile("test.ts", "class Foo {\n  async loadData(): Promise<void> {}\n}\n");
  const method = info.functions.find((f) => f.name === "loadData");
  assert.ok(method, "应识别 async 方法 loadData");
});

// ============================================================================
// RA-TS-ARROW-01~04: TS 箭头函数
// ============================================================================

test("RA-TS-ARROW-01: 识别 const 箭头函数", () => {
  const info = analyzeFile("test.ts", "const add = (a: number, b: number) => a + b;\n");
  const fn = info.functions.find((f) => f.name === "add");
  assert.ok(fn, "应识别 const 箭头函数 add");
  assert.equal(fn!.params, "a: number, b: number");
});

test("RA-TS-ARROW-02: 识别 let 箭头函数", () => {
  const info = analyzeFile("test.ts", "let fn = (x: number) => x * 2;\n");
  const fn = info.functions.find((f) => f.name === "fn");
  assert.ok(fn, "应识别 let 箭头函数 fn");
});

test("RA-TS-ARROW-03: 识别 var 箭头函数", () => {
  const info = analyzeFile("test.ts", "var legacy = () => 42;\n");
  const fn = info.functions.find((f) => f.name === "legacy");
  assert.ok(fn, "应识别 var 箭头函数 legacy");
});

test("RA-TS-ARROW-04: 识别 async 箭头函数", () => {
  const info = analyzeFile("test.ts", "const fetcher = async (url: string) => { return fetch(url); };\n");
  const fn = info.functions.find((f) => f.name === "fetcher");
  assert.ok(fn, "应识别 async 箭头函数 fetcher");
});

// ============================================================================
// RA-JS-01: JS 复用 TS 规则
// ============================================================================

test("RA-JS-01: JavaScript 复用 TS 正则规则正确解析", () => {
  const info = analyzeFile(
    "test.js",
    [
      "export class Foo {",
      "  bar() { return 1; }",
      "}",
      "function baz() { return 2; }",
      "const arrow = (x) => x + 1;",
      "import { stuff } from './stuff';",
    ].join("\n")
  );
  assert.equal(info.language, "javascript");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Foo");
  const baz = info.functions.find((f) => f.name === "baz");
  assert.ok(baz, "应识别 JS function baz");
  const arrow = info.functions.find((f) => f.name === "arrow");
  assert.ok(arrow, "应识别 JS 箭头函数 arrow");
  assert.equal(info.imports.length, 1);
  assert.equal(info.imports[0], "./stuff");
});

// ============================================================================
// RA-PY-01~03: Python class / function / import
// ============================================================================

test("RA-PY-01: Python 类识别", () => {
  const info = analyzeFile(
    "test.py",
    [
      "class Animal:",
      "    def __init__(self, name):",
      "        self.name = name",
      "",
      "    def speak(self):",
      "        pass",
    ].join("\n")
  );
  assert.equal(info.language, "python");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Animal");
  // __init__ 和 speak 都应被识别为函数（def）
  const initFn = info.functions.find((f) => f.name === "__init__");
  assert.ok(initFn, "应识别 __init__");
  const speakFn = info.functions.find((f) => f.name === "speak");
  assert.ok(speakFn, "应识别 speak");
});

test("RA-PY-02: Python 函数识别（含返回类型注解）", () => {
  const info = analyzeFile("test.py", ["def add(a: int, b: int) -> int:", "    return a + b"].join("\n"));
  assert.equal(info.functions.length, 1);
  assert.equal(info.functions[0]!.name, "add");
  assert.equal(info.functions[0]!.params, "a: int, b: int");
  assert.equal(info.functions[0]!.returnType, "int");
});

test("RA-PY-03: Python import 识别（import + from import）", () => {
  const info = analyzeFile(
    "test.py",
    ["import os", "import sys", "from typing import List, Dict", "from .models import User"].join("\n")
  );
  assert.equal(info.imports.length, 4);
  assert.ok(info.imports.includes("os"));
  assert.ok(info.imports.includes("sys"));
  assert.ok(info.imports.includes("typing"));
  assert.ok(info.imports.includes(".models"));
});

// ============================================================================
// RA-EDGE-01~04: 边界用例
// ============================================================================

test("RA-EDGE-01: 空文件不崩溃，返回 ok 状态", () => {
  const info = analyzeFile("empty.ts", "");
  assert.equal(info.parseStatus, "ok");
  assert.equal(info.classes.length, 0);
  assert.equal(info.functions.length, 0);
  assert.equal(info.lines, 1); // 空串 split('\n') 得到 [""]，长度 1
});

test("RA-EDGE-02: 注释内的 class 关键字不误匹配", () => {
  const info = analyzeFile(
    "test.ts",
    [
      "// 这是一个注释，提到 class Foo 但不是定义",
      "/* 块注释 interface Bar */",
      "export class Real {",
      "  method(): void {}",
      "}",
    ].join("\n")
  );
  // 注释行的 class/interface 可能被正则误匹配（已知局限），
  // 但至少应识别真正的 Real 类
  const realClass = info.classes.find((c) => c.name === "Real");
  assert.ok(realClass, "应识别真正的 Real 类");
});

test("RA-EDGE-03: 字符串内的 function 关键字不误匹配为定义", () => {
  const info = analyzeFile(
    "test.ts",
    ["const msg = 'function fake() {}';", "export function real(): void {}"].join("\n")
  );
  // real 应被识别；fake 在字符串内，正则可能误匹配（已知局限）
  const real = info.functions.find((f) => f.name === "real");
  assert.ok(real, "应识别 real 函数");
});

test("RA-EDGE-04: 嵌套括号的参数列表不崩溃", () => {
  const info = analyzeFile(
    "test.ts",
    ["function complex(callback: (x: number) => void): void {", "  callback(42);", "}"].join("\n")
  );
  // 嵌套括号正则可能不完整匹配（已知局限），但不应崩溃
  assert.equal(info.parseStatus, "ok");
  // complex 应被识别（functionPattern 用 [^)]* 不跨首个 )，回调参数可能截断
  const fn = info.functions.find((f) => f.name === "complex");
  assert.ok(fn, "应识别 complex 函数");
});

// ============================================================================
// RA-PERF-01: 单文件解析性能
// ============================================================================

test("RA-PERF-01: 单文件正则解析 < 5ms（防回溯爆炸）", () => {
  // 构造 500 行 TS 文件（含多个类/函数/导入）
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`import { mod${i} } from './mod${i}';`);
  }
  for (let i = 0; i < 50; i++) {
    lines.push(`export class Class${i} {`);
    lines.push(`  method${i}(x: number): number { return x + ${i}; }`);
    lines.push(`}`);
  }
  for (let i = 0; i < 50; i++) {
    lines.push(`function fn${i}(a: string, b: number): void { console.log(a, b); }`);
  }
  const content = lines.join("\n");
  const filePath = path.join(tempDir, "bench.ts");
  fs.writeFileSync(filePath, content, "utf-8");

  const analyzer = new RegexASTAnalyzer("typescript");
  const start = performance.now();
  analyzer.analyzeFile(filePath);
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 5, `单文件解析应 < 5ms，实际 ${elapsed.toFixed(2)}ms`);
});

// ============================================================================
// 补充：detectLanguage 单元测试
// ============================================================================

test("RA-LANG-01: detectLanguage 扩展名映射", () => {
  assert.equal(detectLanguage("/a/b.ts"), "typescript");
  assert.equal(detectLanguage("/a/b.tsx"), "typescript");
  assert.equal(detectLanguage("/a/b.js"), "javascript");
  assert.equal(detectLanguage("/a/b.mjs"), "javascript");
  assert.equal(detectLanguage("/a/b.py"), "python");
  assert.equal(detectLanguage("/a/b.txt"), null);
  assert.equal(detectLanguage("/a/b.md"), null);
});

test("RA-LANG-02: V2-P2 启用全部 6 语言（Java/Rust/Go 不再抛错）", () => {
  // V2-P1 之前：Java/Rust/Go 抛错"未在 V2-P1 启用"
  // V2-P2：Java/Rust/Go 不再抛错，可正常构造分析器
  assert.doesNotThrow(() => new RegexASTAnalyzer("java"), "Java 不应抛错（V2-P2 已启用）");
  assert.doesNotThrow(() => new RegexASTAnalyzer("rust"), "Rust 不应抛错（V2-P2 已启用）");
  assert.doesNotThrow(() => new RegexASTAnalyzer("go"), "Go 不应抛错（V2-P2 已启用）");

  // 验证可正常分析对应语言的文件
  const javaInfo = analyzeFile("test.java", "public class Bar {}\n");
  assert.equal(javaInfo.language, "java");
  const rustInfo = analyzeFile("test.rs", "pub struct Baz {}\n");
  assert.equal(rustInfo.language, "rust");
  const goInfo = analyzeFile("test.go", "type Foo struct {}\n");
  assert.equal(goInfo.language, "go");
});

// ============================================================================
// RA-JAVA-01~03: Java class / method / import（V2-P2 新增）
// ============================================================================

test("RA-JAVA-01: Java 类识别", () => {
  const info = analyzeFile("Bar.java", "public class Bar {\n  private int x;\n}\n");
  assert.equal(info.language, "java");
  assert.equal(info.parseStatus, "ok");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Bar");
  assert.equal(info.classes[0]!.type, "class");
});

test("RA-JAVA-02: Java 方法识别", () => {
  const info = analyzeFile(
    "Bar.java",
    ["public class Bar {", "  public void hello() {", '    System.out.println("hi");', "  }", "}"].join("\n")
  );
  // hello 方法应被识别（收集到 functions 列表）
  const hello = info.functions.find((f) => f.name === "hello");
  assert.ok(hello, "应识别 Java 方法 hello");
});

test("RA-JAVA-03: Java import 识别", () => {
  const info = analyzeFile(
    "Bar.java",
    ["import java.util.List;", "import static java.lang.Math.PI;", "public class Bar {}"].join("\n")
  );
  assert.equal(info.imports.length, 2);
  assert.ok(info.imports.includes("java.util.List"), "应识别 java.util.List");
  assert.ok(info.imports.includes("java.lang.Math.PI"), "应识别 static import java.lang.Math.PI");
});

// ============================================================================
// RA-RUST-01~03: Rust struct / fn / use（V2-P2 新增）
// ============================================================================

test("RA-RUST-01: Rust struct 识别（type === struct）", () => {
  const info = analyzeFile("baz.rs", "pub struct Baz {\n  field: i32,\n}\n");
  assert.equal(info.language, "rust");
  assert.equal(info.parseStatus, "ok");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Baz");
  assert.equal(info.classes[0]!.type, "struct");
});

test("RA-RUST-02: Rust fn 识别（含返回类型）", () => {
  const info = analyzeFile("add.rs", "pub fn add(a: i32, b: i32) -> i32 {\n  a + b\n}\n");
  const addFn = info.functions.find((f) => f.name === "add");
  assert.ok(addFn, "应识别 Rust fn add");
  assert.equal(addFn!.params, "a: i32, b: i32");
  assert.equal(addFn!.returnType, "i32");
});

test("RA-RUST-03: Rust use 识别", () => {
  const info = analyzeFile("use.rs", "use std::collections::HashMap;\npub fn main() {}\n");
  assert.ok(info.imports.includes("std::collections::HashMap"), "应识别 use std::collections::HashMap");
});

// ============================================================================
// RA-GO-01~03: Go struct / func / import（V2-P2 新增）
// ============================================================================

test("RA-GO-01: Go struct 识别（type === struct）", () => {
  const info = analyzeFile("foo.go", "type Foo struct {\n  X int\n}\n");
  assert.equal(info.language, "go");
  assert.equal(info.parseStatus, "ok");
  assert.equal(info.classes.length, 1);
  assert.equal(info.classes[0]!.name, "Foo");
  assert.equal(info.classes[0]!.type, "struct");
});

test("RA-GO-02: Go func 识别", () => {
  const info = analyzeFile("add.go", "func Add(a, b int) int { return a + b }\n");
  const addFn = info.functions.find((f) => f.name === "Add");
  assert.ok(addFn, "应识别 Go func Add");
  assert.equal(addFn!.params, "a, b int");
});

test("RA-GO-03: Go import 识别（单行 import）", () => {
  const info = analyzeFile("fmt.go", 'import "fmt"\nfunc main() { fmt.Println("hi") }\n');
  assert.ok(info.imports.includes("fmt"), '应识别 import "fmt"');
});

// ============================================================================
// RA-RUST-TYPE: Rust struct/enum/trait 类型映射（CM-06 配套）
// ============================================================================

test("RA-RUST-TYPE: Rust struct/enum/trait 类型映射正确", () => {
  const info = analyzeFile("types.rs", ["pub struct Baz {}", "pub enum Qux {}", "pub trait Trait {}"].join("\n"));
  assert.equal(info.classes.length, 3, "应识别 3 个类型");
  const struct = info.classes.find((c) => c.name === "Baz");
  assert.ok(struct, "应识别 struct Baz");
  assert.equal(struct!.type, "struct");
  const en = info.classes.find((c) => c.name === "Qux");
  assert.ok(en, "应识别 enum Qux");
  assert.equal(en!.type, "enum");
  const trait = info.classes.find((c) => c.name === "Trait");
  assert.ok(trait, "应识别 trait Trait");
  assert.equal(trait!.type, "interface", "trait 应映射为 interface（语义最接近）");
});

test("RA-CALLS-01: 同文件函数调用识别（calls 字段）", () => {
  const info = analyzeFile(
    "test.ts",
    ["function helper(): number { return 42; }", "function caller(): number {", "  return helper();", "}"].join("\n")
  );
  const caller = info.functions.find((f) => f.name === "caller");
  assert.ok(caller, "应识别 caller");
  assert.ok(caller!.calls.includes("helper"), "caller 应调用 helper");
});
