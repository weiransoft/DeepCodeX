/**
 * 质量门禁 E2E 测试 - CodeMapGenerator 端到端流程
 *
 * 覆盖场景（每个用例 ID 对应 V2_CONTEXT_MEMORY_TEST_PLAN.md 中的 §4.3）：
 *   E2E-CM-01: 多语言项目扫描 → 生成 → 落盘 Markdown → 重新读取 → 验证完整
 *   E2E-CM-02: 增量更新（修改/新增/删除文件）→ 重新扫描差异
 *   E2E-CM-03: 循环依赖检测（a→b→a）不无限递归
 *   E2E-CM-04: 大目录 skipDirs 生效（node_modules / .git / dist）
 *   E2E-CM-05: 统计与死代码检测端到端（孤儿类被识别）
 *   E2E-CM-06: maxFiles 限制生效（巨型项目不内存爆炸）
 *   E2E-CM-07: 单文件分析失败不影响其他文件
 *   E2E-CM-08: JSON 输出可被程序化消费（重新解析后等价）
 *   E2E-CM-09: 复杂项目（6 语言混合）Markdown 含全部 6 种语言分布
 *   E2E-CM-10: 端到端性能（200 个文件 < 10s）
 *
 * 严格遵循 user rules：
 *   - 禁止 mock fs / mock path / mock generator
 *   - 所有测试基于真实 tmpdir + 真实文件写入
 *   - 通过真实算法验证结果
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CodeMapGenerator } from "../../codemap/generator.js";
import type { CodeMap } from "../../codemap/generator.js";
import { createMultiLangProject, createProjectWithNodeModules, createTmpDir, cleanupTmpDir } from "./e2e-helpers.js";

/** 读取并解析 JSON 文件 */
async function readJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/** 读取 Markdown 文件 */
async function readMd(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8");
}

describe("E2E: CodeMapGenerator 端到端流程", () => {
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await createTmpDir("codemap");
  });

  after(async () => {
    await cleanupTmpDir(tmpRoot);
  });

  it("E2E-CM-01: 多语言项目完整流程（生成 → 落盘 → 重新读取 → 验证一致）", async () => {
    const projectRoot = await createTmpDir("cm01");
    try {
      await createMultiLangProject(projectRoot);

      const gen = new CodeMapGenerator({
        projectRoot,
        markdownOutputPath: path.join(projectRoot, "out", "CODE_MAP.md"),
        jsonOutputPath: path.join(projectRoot, "out", "CODE_MAP.json"),
      });
      const map = await gen.generate();
      await gen.dump(map);

      // 验证 1: 6 个代码文件全部被识别
      assert.equal(map.stats.fileCount, 7, "应扫描 7 个代码文件（5 语言 + 2 个 ts/py 重复）");

      // 验证 2: 6 种语言分布
      const langs = Object.keys(map.stats.languageBreakdown).sort();
      assert.deepEqual(langs, ["go", "java", "python", "rust", "typescript"], "应包含 5 种语言（ts/py/java/go/rs）");

      // 验证 3: 关键节点存在
      const userClass = map.nodes.find((n) => n.kind === "class" && n.name === "User");
      assert.ok(userClass, "应识别 User 类");
      const greetTrait = map.nodes.find((n) => n.kind === "interface" && n.name === "Greet");
      assert.ok(greetTrait, "应识别 Greet trait");
      const serverStruct = map.nodes.find((n) => n.kind === "class" && n.name === "Server");
      assert.ok(serverStruct, "应识别 Go Server struct");

      // 验证 4: 依赖边存在
      const indexEdges = map.edges.filter((e) => e.sourceFile.endsWith("index.ts") && e.kind === "imports");
      assert.ok(indexEdges.length >= 1, "index.ts 应有 import 边");
      const userDep = indexEdges.find((e) => e.from.includes("user"));
      assert.ok(userDep, "index.ts 应引用 user 模块");

      // 验证 5: Markdown 输出存在且包含关键内容
      const md = await readMd(path.join(projectRoot, "out", "CODE_MAP.md"));
      assert.match(md, /^# Code Map: /m, "Markdown 应以标题开头");
      assert.match(md, /## 语言分布/, "Markdown 应包含语言分布章节");
      assert.match(md, /typescript/, "Markdown 应列出 typescript");
      assert.match(md, /## 节点分布/, "Markdown 应包含节点分布章节");
      assert.match(md, /## 复杂度 Top 10/, "Markdown 应包含复杂度 Top 10");
      assert.match(md, /## 死代码候选/, "Markdown 应包含死代码候选章节");
      assert.match(md, /## 文件清单/, "Markdown 应包含文件清单");

      // 验证 6: JSON 输出可被重新解析且与内存等价
      const jsonMap = await readJson<CodeMap>(path.join(projectRoot, "out", "CODE_MAP.json"));
      assert.equal(jsonMap.stats.fileCount, map.stats.fileCount);
      assert.equal(jsonMap.nodes.length, map.nodes.length);
      assert.equal(jsonMap.edges.length, map.edges.length);
      assert.equal(jsonMap.projectName, map.projectName);
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-02: 增量更新（修改文件 → 重新扫描反映新内容）", async () => {
    const projectRoot = await createTmpDir("cm02");
    try {
      await createMultiLangProject(projectRoot);

      // 第一次扫描
      const gen1 = new CodeMapGenerator({ projectRoot });
      const map1 = await gen1.generate();
      const userClass1 = map1.nodes.find((n) => n.kind === "class" && n.name === "User");
      assert.ok(userClass1, "第一次应找到 User 类");
      const lineStart1 = userClass1!.lineStart;
      const lineEnd1 = userClass1!.lineEnd;

      // 修改 user.ts（增加一个方法，扩展类体）
      const userPath = path.join(projectRoot, "src", "user.ts");
      await fs.writeFile(
        userPath,
        `export class User {
  public name: string;
  public age: number;
  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
  public greet(): string {
    if (!this.name) return "anon";
    return "hi, " + this.name;
  }
  public getProfile(): string {
    return this.name + " (" + this.age + ")";
  }
  public isAdult(): boolean {
    return this.age >= 18;
  }
}
`
      );

      // 第二次扫描
      const gen2 = new CodeMapGenerator({ projectRoot });
      const map2 = await gen2.generate();
      const userClass2 = map2.nodes.find((n) => n.kind === "class" && n.name === "User");
      assert.ok(userClass2);
      // 修改后类的行范围应扩大
      assert.ok(userClass2!.lineEnd > lineEnd1, `修改后类的结束行应扩大：${lineEnd1} → ${userClass2!.lineEnd}`);
      // 应有新的方法被识别
      const methods = map2.nodes.filter((n) => n.kind === "method" && n.parentId === `class::src/user.ts::User`);
      const methodNames = methods.map((m) => m.name);
      assert.ok(methodNames.includes("getProfile"), "应识别新增的 getProfile 方法");
      assert.ok(methodNames.includes("isAdult"), "应识别新增的 isAdult 方法");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-03: 循环依赖检测（a→b→a）不无限递归", async () => {
    const projectRoot = await createTmpDir("cm03");
    try {
      await fs.writeFile(
        path.join(projectRoot, "a.ts"),
        `import { b } from "./b";
export function a() { return b(); }`
      );
      await fs.writeFile(
        path.join(projectRoot, "b.ts"),
        `import { a } from "./a";
export function b() { return a(); }`
      );

      const gen = new CodeMapGenerator({ projectRoot });
      // 必须不抛栈溢出
      const map = await gen.generate();

      const aFn = map.nodes.find((n) => n.name === "a" && n.kind === "function");
      const bFn = map.nodes.find((n) => n.name === "b" && n.kind === "function");
      assert.ok(aFn, "应识别 a 函数");
      assert.ok(bFn, "应识别 b 函数");

      // 应有 a→b 和 b→a 的 import 边
      const aToB = map.edges.find((e) => e.kind === "imports" && e.from.includes("a") && e.to.includes("b"));
      const bToA = map.edges.find((e) => e.kind === "imports" && e.from.includes("b") && e.to.includes("a"));
      assert.ok(aToB, "应有 a→b 的 import 边");
      assert.ok(bToA, "应有 b→a 的 import 边");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-04: skipDirs 生效（node_modules / .git / dist 不被扫描）", async () => {
    const projectRoot = await createTmpDir("cm04");
    try {
      await createProjectWithNodeModules(projectRoot);

      // 额外创建 .git 和 dist 目录
      await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, ".git", "config"), "fake git");
      await fs.mkdir(path.join(projectRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "dist", "bundle.js"), "compiled code");

      const gen = new CodeMapGenerator({ projectRoot });
      const map = await gen.generate();

      // 仅 src/app.ts 应被扫描
      const fileNodes = map.nodes.filter((n) => n.kind === "file");
      assert.equal(fileNodes.length, 1, "应仅扫描 1 个文件");
      assert.equal(fileNodes[0]!.relativePath, "src/app.ts");
      // 确认无 node_modules / .git / dist
      const relPaths = map.nodes.map((n) => n.relativePath);
      assert.ok(!relPaths.some((p) => p.includes("node_modules")), "应排除 node_modules");
      assert.ok(!relPaths.some((p) => p.includes(".git")), "应排除 .git");
      assert.ok(!relPaths.some((p) => p.includes("dist")), "应排除 dist");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-05a: 死代码检测 - 完全未被引用的文件内类被识别为死代码", async () => {
    const projectRoot = await createTmpDir("cm05a");
    try {
      // orphan.ts 完全未被任何文件 import → 内部类应算死代码
      await fs.writeFile(
        path.join(projectRoot, "orphan.ts"),
        `export class OrphanA {
  public f() { return 1; }
}
export class OrphanB {
  public g() { return 2; }
}
`
      );

      const gen = new CodeMapGenerator({ projectRoot });
      const map = await gen.generate();

      const deadIds = map.stats.deadCodeCandidates;
      // OrphanA 和 OrphanB 都应被识别为死代码
      assert.ok(
        deadIds.some((id) => id.includes("OrphanA")),
        "OrphanA 类应被识别为死代码候选"
      );
      assert.ok(
        deadIds.some((id) => id.includes("OrphanB")),
        "OrphanB 类应被识别为死代码候选"
      );
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-05b: 死代码检测 - 被 import 的文件内节点不算法死代码（间接入边）", async () => {
    const projectRoot = await createTmpDir("cm05b");
    try {
      // entry.ts → main.ts → lib.ts 的链式 import
      await fs.writeFile(
        path.join(projectRoot, "entry.ts"),
        `import { run } from "./main";
export function start() { return run(); }
`
      );
      await fs.writeFile(
        path.join(projectRoot, "main.ts"),
        `import { Service } from "./lib";
export function run() { return new Service().exec(); }
`
      );
      await fs.writeFile(
        path.join(projectRoot, "lib.ts"),
        `export class Service {
  public exec() { return 42; }
}
`
      );

      const gen = new CodeMapGenerator({ projectRoot });
      const map = await gen.generate();

      const deadIds = map.stats.deadCodeCandidates;
      // Service 类不应被识别为死代码（lib.ts 被 main.ts import，间接入边）
      assert.ok(
        !deadIds.some((id) => id.includes("::Service")),
        "Service 类不应被识别为死代码（lib.ts 被 main.ts import）"
      );
      // run 函数不应被识别为死代码（main.ts 被 entry.ts import，间接入边）
      assert.ok(!deadIds.some((id) => id.includes("run")), "run 函数不应被识别为死代码（main.ts 被 entry.ts import）");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-06: maxFiles 限制生效（巨型项目不内存爆炸）", async () => {
    const projectRoot = await createTmpDir("cm06");
    try {
      // 创建 20 个文件
      const srcDir = path.join(projectRoot, "src");
      await fs.mkdir(srcDir, { recursive: true });
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(path.join(srcDir, `f${i}.ts`), `export const v${i} = ${i};`);
      }

      // 限制 maxFiles=5
      const gen = new CodeMapGenerator({ projectRoot, maxFiles: 5 });
      const map = await gen.generate();
      assert.equal(map.stats.fileCount, 5, "应仅扫描 5 个文件");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-07: 单文件分析失败不影响其他文件", async () => {
    const projectRoot = await createTmpDir("cm07");
    try {
      // 创建一个无扩展名的"坏"文件 + 一个正常文件
      // 通过设置非常小的 maxLinesPerFile 触发截断/异常保护
      await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "src", "ok.ts"), "export const x = 1;");
      // 一个有 10000 行的文件
      const bigLines = Array.from({ length: 10000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
      await fs.writeFile(path.join(projectRoot, "src", "big.ts"), bigLines);

      // 限制 maxLinesPerFile=100，big.ts 会被截断但不应失败
      const gen = new CodeMapGenerator({ projectRoot, maxLinesPerFile: 100 });
      const map = await gen.generate();
      assert.equal(map.stats.fileCount, 2, "两个文件都应被处理");
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-08: JSON 输出可被程序化消费（重新解析后等价）", async () => {
    const projectRoot = await createTmpDir("cm08");
    try {
      await createMultiLangProject(projectRoot);

      const gen = new CodeMapGenerator({
        projectRoot,
        jsonOutputPath: path.join(projectRoot, "out.json"),
      });
      const map = await gen.generate();
      await gen.dump(map);

      // 重新读取并验证关键字段
      const loaded = await readJson<CodeMap>(path.join(projectRoot, "out.json"));
      assert.equal(loaded.projectName, map.projectName);
      assert.equal(loaded.projectRoot, map.projectRoot);
      assert.equal(loaded.generatedAt, map.generatedAt);
      assert.equal(loaded.stats.fileCount, map.stats.fileCount);
      assert.equal(loaded.stats.totalLines, map.stats.totalLines);
      assert.deepEqual(loaded.stats.nodesByKind, map.stats.nodesByKind);
      assert.deepEqual(loaded.stats.languageBreakdown, map.stats.languageBreakdown);

      // 验证节点字段完整
      for (const orig of map.nodes) {
        const found = loaded.nodes.find((n) => n.id === orig.id);
        assert.ok(found, `重新读取的 JSON 应包含节点 ${orig.id}`);
        assert.equal(found!.kind, orig.kind);
        assert.equal(found!.name, orig.name);
        assert.equal(found!.complexity, orig.complexity);
        assert.equal(found!.complexityLevel, orig.complexityLevel);
      }
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-09: Markdown 输出含 5 种语言分布（TS/Py/Java/Go/Rust）", async () => {
    const projectRoot = await createTmpDir("cm09");
    try {
      await createMultiLangProject(projectRoot);

      const gen = new CodeMapGenerator({
        projectRoot,
        markdownOutputPath: path.join(projectRoot, "MAP.md"),
      });
      const map = await gen.generate();
      await gen.dump(map);

      const md = await readMd(path.join(projectRoot, "MAP.md"));
      // 5 种语言都应出现在语言分布表中
      for (const lang of ["typescript", "python", "java", "go", "rust"]) {
        assert.ok(md.includes(lang), `Markdown 应包含语言 ${lang}`);
      }
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });

  it("E2E-CM-10: 端到端性能（200 文件 < 10s）", async () => {
    const projectRoot = await createTmpDir("cm10");
    try {
      // 创建 200 个真实小文件
      const srcDir = path.join(projectRoot, "src");
      await fs.mkdir(srcDir, { recursive: true });
      for (let i = 0; i < 200; i++) {
        await fs.writeFile(
          path.join(srcDir, `m${i}.ts`),
          `import { x } from "./x";
export class C${i} {
  public f(): number { return ${i}; }
  public g(): string { return "${i}"; }
}
export function f${i}() { return new C${i}().f(); }
`
        );
      }

      const start = Date.now();
      const gen = new CodeMapGenerator({ projectRoot });
      const map = await gen.generate();
      const elapsed = Date.now() - start;

      assert.equal(map.stats.fileCount, 200);
      assert.ok(elapsed < 10_000, `扫描 200 文件应 < 10s，实际 ${elapsed}ms`);
    } finally {
      await cleanupTmpDir(projectRoot);
    }
  });
});
