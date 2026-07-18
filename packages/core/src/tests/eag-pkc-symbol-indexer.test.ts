/**
 * EAG-P2 批次 8 单元测试：符号索引器（SymbolIndexer）
 *
 * 测试范围：
 * - T1. SymbolIndexer 实例化（含 projectRoot 校验）
 * - T2. indexFile 解析 TypeScript 文件
 *   - T2a. 提取 class 符号
 *   - T2b. 提取 interface 符号
 *   - T2c. 提取 function 符号
 *   - T2d. 提取 type-alias 符号
 *   - T2e. 提取 enum 符号
 * - T3. indexFile 解析 Python 文件
 *   - T3a. 提取 Python class
 *   - T3b. 提取 Python function
 * - T4. indexFile 解析 Java 文件
 *   - T4a. 提取 Java class
 *   - T4b. 提取 Java method
 * - T5. getSymbol / getAllSymbols / getFileSymbols 查询
 * - T6. removeSymbolsOfFile 移除指定文件符号
 * - T7. indexIncremental 增量索引
 *   - T7a. 小变更直通（≤2 文件且 ≤10 符号）
 *   - T7b. 非小变更执行重建
 *   - T7c. deleted 类型移除符号
 * - T8. Embedder 集成（StaticEmbedder 为符号生成向量）
 * - T9. 入参校验
 *   - T9a. 空 filePath 抛 SymbolIndexerError
 *   - T9b. 不存在的文件抛 SymbolIndexerError
 * - T10. 不可变性
 *   - T10a. getSymbol 返回冻结对象
 *   - T10b. getAllSymbols 返回冻结数组
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（mkdtemp 创建临时目录）
 * - 使用 StaticEmbedder（基于 hash 的确定性向量，真实实现）
 *
 * @module core/tests/eag-pkc-symbol-indexer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SymbolIndexer, SymbolIndexerError } from "../eag/pkc/symbol-indexer";
import type { Embedder } from "../eag/pkc/symbol-indexer";
import type { GitDiff, IndexedSymbol } from "../eag/pkc/l2-types";

// ============================================================================
// StaticEmbedder：基于 hash 的确定性向量嵌入器（真实实现，非 mock）
// ============================================================================

/**
 * 静态嵌入器（与 semantic-searcher 测试共用设计）
 *
 * 实现原理：将文本字符 charCode 累加到固定维度的向量中，再 L2 归一化。
 */
class StaticEmbedder implements Embedder {
  public readonly dimension: number = 8;

  async embed(text: string): Promise<ReadonlyArray<number>> {
    const vector = new Array<number>(this.dimension).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % this.dimension] += text.charCodeAt(i) / 1000;
    }
    let norm = 0;
    for (const v of vector) {
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = vector[i] / norm;
      }
    }
    return Object.freeze(vector);
  }
}

// ============================================================================
// 辅助函数：创建临时项目目录
// ============================================================================

/**
 * 创建临时项目目录（含 src/services 子目录）
 *
 * @returns 临时项目根目录绝对路径
 */
async function createTempProject(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eag-pkc-indexer-"));
  await fs.mkdir(path.join(tmpDir, "src", "services"), { recursive: true });
  return tmpDir;
}

/**
 * 递归删除目录（测试结束后清理）
 *
 * @param dirPath 待删除目录
 */
async function removeTempDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略删除失败
  }
}

/**
 * 写入文件（含目录创建）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 相对路径
 * @param content 文件内容
 */
async function writeProjectFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf-8");
}

// ============================================================================
// T1. SymbolIndexer 实例化
// ============================================================================

test("T1a. SymbolIndexer 可实例化（合法 projectRoot）", async () => {
  const tmpDir = await createTempProject();
  try {
    const indexer = new SymbolIndexer(tmpDir);
    assert.equal(indexer.getAllSymbols().length, 0);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T1b. SymbolIndexer 空 projectRoot 抛 SymbolIndexerError", () => {
  assert.throws(
    () => new SymbolIndexer(""),
    (err: unknown) => {
      assert.ok(err instanceof SymbolIndexerError);
      assert.equal(err.kind, "invalid-path");
      return true;
    }
  );
});

test("T1c. SymbolIndexer 空白 projectRoot 抛 SymbolIndexerError", () => {
  assert.throws(
    () => new SymbolIndexer("   "),
    (err: unknown) => {
      assert.ok(err instanceof SymbolIndexerError);
      assert.equal(err.kind, "invalid-path");
      return true;
    }
  );
});

test("T1d. SymbolIndexer 注入 StaticEmbedder 可实例化", async () => {
  const tmpDir = await createTempProject();
  try {
    const embedder = new StaticEmbedder();
    const indexer = new SymbolIndexer(tmpDir, embedder);
    assert.equal(indexer.getAllSymbols().length, 0);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T2. indexFile 解析 TypeScript 文件
// ============================================================================

test("T2a. indexFile 提取 TypeScript class 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/services/UserService.ts",
      [
        "/** 用户服务类 */",
        "export class UserService {",
        "  private readonly repo: UserRepository;",
        "",
        "  constructor(repo: UserRepository) {",
        "    this.repo = repo;",
        "  }",
        "",
        "  async login(email: string, password: string): Promise<AuthToken> {",
        "    return this.repo.findByEmail(email);",
        "  }",
        "}",
      ].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/services/UserService.ts");
    const classSymbol = symbols.find((s) => s.kind === "class");
    assert.ok(classSymbol, "应提取到 class 符号");
    assert.equal(classSymbol!.name, "UserService");
    assert.equal(classSymbol!.filePath, "src/services/UserService.ts");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T2b. indexFile 提取 TypeScript interface 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/types.ts",
      ["/** 用户接口 */", "export interface User {", "  id: string;", "  email: string;", "}"].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/types.ts");
    const interfaceSymbol = symbols.find((s) => s.kind === "interface");
    assert.ok(interfaceSymbol, "应提取到 interface 符号");
    assert.equal(interfaceSymbol!.name, "User");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T2c. indexFile 提取 TypeScript function 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/utils.ts",
      [
        "/** 工具函数 */",
        "export function formatDate(date: Date): string {",
        "  return date.toISOString();",
        "}",
        "",
        "export async function fetchData(url: string): Promise<Response> {",
        "  return fetch(url);",
        "}",
      ].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/utils.ts");
    const functionSymbols = symbols.filter((s) => s.kind === "function");
    assert.ok(functionSymbols.length >= 2, "应提取到至少 2 个 function 符号");
    const names = functionSymbols.map((s) => s.name);
    assert.ok(names.includes("formatDate"));
    assert.ok(names.includes("fetchData"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T2d. indexFile 提取 TypeScript type-alias 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/types.ts",
      ["export type UserID = string;", "export type UserStatus = 'active' | 'inactive' | 'banned';"].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/types.ts");
    const typeSymbols = symbols.filter((s) => s.kind === "type-alias");
    assert.ok(typeSymbols.length >= 1, "应提取到至少 1 个 type-alias 符号");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T2e. indexFile 提取 TypeScript enum 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.ts",
      ["export enum OrderStatus {", "  Pending,", "  Paid,", "  Shipped,", "  Completed,", "  Cancelled,", "}"].join(
        "\n"
      )
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/enums.ts");
    const enumSymbols = symbols.filter((s) => s.kind === "enum");
    assert.ok(enumSymbols.length >= 1, "应提取到至少 1 个 enum 符号");
    assert.equal(enumSymbols[0].name, "OrderStatus");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T3. indexFile 解析 Python 文件
// ============================================================================

test("T3a. indexFile 提取 Python class 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/models.py",
      [
        "class User:",
        "    def __init__(self, id, email):",
        "        self.id = id",
        "        self.email = email",
        "",
        "class Order:",
        "    def __init__(self, id, user_id):",
        "        self.id = id",
        "        self.user_id = user_id",
      ].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/models.py");
    const classSymbols = symbols.filter((s) => s.kind === "class");
    assert.ok(classSymbols.length >= 2, "应提取到至少 2 个 Python class 符号");
    const names = classSymbols.map((s) => s.name);
    assert.ok(names.includes("User"));
    assert.ok(names.includes("Order"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3b. indexFile 提取 Python function 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/utils.py",
      [
        "def format_date(date):",
        "    return date.isoformat()",
        "",
        "def parse_input(text):",
        "    return text.strip()",
      ].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/utils.py");
    const functionSymbols = symbols.filter((s) => s.kind === "function");
    assert.ok(functionSymbols.length >= 2, "应提取到至少 2 个 Python function 符号");
    const names = functionSymbols.map((s) => s.name);
    assert.ok(names.includes("format_date"));
    assert.ok(names.includes("parse_input"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T4. indexFile 解析 Java 文件
// ============================================================================

test("T4a. indexFile 提取 Java class 符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/UserService.java",
      [
        "package com.example;",
        "",
        "public class UserService {",
        "  private UserRepository repo;",
        "",
        "  public UserService(UserRepository repo) {",
        "    this.repo = repo;",
        "  }",
        "",
        "  public User findById(Long id) {",
        "    return repo.findById(id);",
        "  }",
        "}",
      ].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/UserService.java");
    const classSymbols = symbols.filter((s) => s.kind === "class");
    assert.ok(classSymbols.length >= 1, "应提取到至少 1 个 Java class 符号");
    assert.equal(classSymbols[0].name, "UserService");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T5. getSymbol / getAllSymbols / getFileSymbols 查询
// ============================================================================

test("T5a. getSymbol 按 ID 查询符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/x.ts", ["export class Foo {", "  bar(): void {}", "}", ""].join("\n"));
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/x.ts");
    const allSymbols = indexer.getAllSymbols();
    assert.ok(allSymbols.length > 0, "应索引到符号");
    const firstSymbol = allSymbols[0];
    const fetched = indexer.getSymbol(firstSymbol.symbolId);
    assert.ok(fetched, "应查询到符号");
    assert.equal(fetched!.symbolId, firstSymbol.symbolId);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5b. getSymbol 不存在的 ID 返回 null", async () => {
  const tmpDir = await createTempProject();
  try {
    const indexer = new SymbolIndexer(tmpDir);
    const fetched = indexer.getSymbol("not-exist");
    assert.equal(fetched, null);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5c. getAllSymbols 返回全部已索引符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/a.ts",
      ["export class A {}", "export class B {}", "export class C {}", ""].join("\n")
    );
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    const all = indexer.getAllSymbols();
    assert.ok(all.length >= 3, "应至少索引到 3 个 class 符号");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5d. getFileSymbols 返回指定文件的符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/a.ts", ["export class A {}", ""].join("\n"));
    await writeProjectFile(tmpDir, "src/b.ts", ["export class B {}", "export class C {}", ""].join("\n"));
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    await indexer.indexFile("src/b.ts");
    const fileA = indexer.getFileSymbols("src/a.ts");
    const fileB = indexer.getFileSymbols("src/b.ts");
    assert.equal(fileA.length, 1);
    assert.equal(fileB.length, 2);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5e. getIndexedFiles 返回已索引文件列表", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/a.ts", "export class A {}");
    await writeProjectFile(tmpDir, "src/b.ts", "export class B {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    await indexer.indexFile("src/b.ts");
    const files = indexer.getIndexedFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes("src/a.ts"));
    assert.ok(files.includes("src/b.ts"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T6. removeSymbolsOfFile 移除指定文件符号
// ============================================================================

test("T6a. removeSymbolsOfFile 移除指定文件的全部符号", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/a.ts", "export class A {}");
    await writeProjectFile(tmpDir, "src/b.ts", "export class B {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    await indexer.indexFile("src/b.ts");
    const removed = indexer.removeSymbolsOfFile("src/a.ts");
    assert.equal(removed, 1);
    assert.equal(indexer.getFileSymbols("src/a.ts").length, 0);
    assert.equal(indexer.getFileSymbols("src/b.ts").length, 1);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T6b. removeSymbolsOfFile 不存在的文件返回 0", async () => {
  const tmpDir = await createTempProject();
  try {
    const indexer = new SymbolIndexer(tmpDir);
    const removed = indexer.removeSymbolsOfFile("not-exist.ts");
    assert.equal(removed, 0);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T7. indexIncremental 增量索引
// ============================================================================

test("T7a. indexIncremental 小变更直通（≤2 文件且 ≤10 符号）", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/a.ts", ["export class A {}", "export class B {}", ""].join("\n"));
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    // 构造一个小变更 diff：1 个 modified 文件，已有 2 个符号（≤10）
    const diff: GitDiff = {
      changedFiles: [
        {
          type: "modified",
          filePath: "src/a.ts",
          addedLines: [10],
          removedLines: [],
        },
      ],
      baseCommit: "abc1234",
      headCommit: "def5678",
    };
    const result = await indexer.indexIncremental(diff);
    assert.equal(result.skipped, true);
    assert.equal(result.reindexedFiles.length, 0);
    assert.ok(result.reason.includes("小变更直通"), `reason 应含"小变更直通"，实际：${result.reason}`);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7b. indexIncremental 非小变更执行重建", async () => {
  const tmpDir = await createTempProject();
  try {
    // 准备 3 个文件（>2 触发非小变更）
    await writeProjectFile(tmpDir, "src/a.ts", "export class A {}");
    await writeProjectFile(tmpDir, "src/b.ts", "export class B {}");
    await writeProjectFile(tmpDir, "src/c.ts", "export class C {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    await indexer.indexFile("src/b.ts");
    await indexer.indexFile("src/c.ts");
    const diff: GitDiff = {
      changedFiles: [
        { type: "modified", filePath: "src/a.ts", addedLines: [], removedLines: [] },
        { type: "modified", filePath: "src/b.ts", addedLines: [], removedLines: [] },
        { type: "modified", filePath: "src/c.ts", addedLines: [], removedLines: [] },
      ],
      baseCommit: "abc1234",
      headCommit: "def5678",
    };
    const result = await indexer.indexIncremental(diff);
    assert.equal(result.skipped, false);
    assert.equal(result.reindexedFiles.length, 3);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7c. indexIncremental deleted 类型移除符号", async () => {
  const tmpDir = await createTempProject();
  try {
    // 准备 3 个文件，删除其中一个（仍 >2 文件，触发非小变更）
    await writeProjectFile(tmpDir, "src/a.ts", "export class A {}");
    await writeProjectFile(tmpDir, "src/b.ts", "export class B {}");
    await writeProjectFile(tmpDir, "src/c.ts", "export class C {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    await indexer.indexFile("src/b.ts");
    await indexer.indexFile("src/c.ts");
    // 删除 src/a.ts 文件
    await fs.unlink(path.join(tmpDir, "src/a.ts"));
    const diff: GitDiff = {
      changedFiles: [
        { type: "deleted", filePath: "src/a.ts", addedLines: [], removedLines: [] },
        { type: "modified", filePath: "src/b.ts", addedLines: [], removedLines: [] },
        { type: "modified", filePath: "src/c.ts", addedLines: [], removedLines: [] },
      ],
      baseCommit: "abc1234",
      headCommit: "def5678",
    };
    const result = await indexer.indexIncremental(diff);
    assert.equal(result.skipped, false);
    // 删除的 src/a.ts 不在 reindexedFiles 中（deleted 不重解析）
    assert.ok(!result.reindexedFiles.includes("src/a.ts"));
    // 应记录到 removedSymbols
    assert.ok(result.removedSymbols.length >= 1, "应至少移除 1 个符号");
    // 索引中已无 src/a.ts 的符号
    assert.equal(indexer.getFileSymbols("src/a.ts").length, 0);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T8. Embedder 集成
// ============================================================================

test("T8a. 注入 StaticEmbedder 后符号含 embedding 字段", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/x.ts", ["export class Foo {", "  bar(): void {}", "}", ""].join("\n"));
    const embedder = new StaticEmbedder();
    const indexer = new SymbolIndexer(tmpDir, embedder);
    const symbols = await indexer.indexFile("src/x.ts");
    const withEmbedding = symbols.filter((s) => s.embedding && s.embedding.length > 0);
    assert.ok(withEmbedding.length > 0, "应有符号含 embedding 字段");
    assert.equal(withEmbedding[0].embedding!.length, 8);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T8b. 不注入 Embedder 时符号 embedding 字段为 undefined", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/x.ts", "export class Foo {}");
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/x.ts");
    assert.ok(symbols.length > 0);
    assert.equal(symbols[0].embedding, undefined);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T9. 入参校验
// ============================================================================

test("T9a. indexFile 空 filePath 抛 SymbolIndexerError", async () => {
  const tmpDir = await createTempProject();
  try {
    const indexer = new SymbolIndexer(tmpDir);
    await assert.rejects(
      () => indexer.indexFile(""),
      (err: unknown) => {
        assert.ok(err instanceof SymbolIndexerError);
        assert.equal(err.kind, "invalid-path");
        return true;
      }
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9b. indexFile 不存在的文件抛 SymbolIndexerError", async () => {
  const tmpDir = await createTempProject();
  try {
    const indexer = new SymbolIndexer(tmpDir);
    await assert.rejects(
      () => indexer.indexFile("not-exist.ts"),
      (err: unknown) => {
        assert.ok(err instanceof SymbolIndexerError);
        assert.equal(err.kind, "path-not-found");
        return true;
      }
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T10. 不可变性
// ============================================================================

test("T10a. getSymbol 返回冻结对象", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/x.ts", "export class Foo {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/x.ts");
    const all = indexer.getAllSymbols();
    const fetched = indexer.getSymbol(all[0].symbolId);
    assert.ok(fetched);
    assert.equal(Object.isFrozen(fetched), true);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10b. getAllSymbols 返回冻结数组", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/x.ts", "export class Foo {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/x.ts");
    const all = indexer.getAllSymbols();
    assert.equal(Object.isFrozen(all), true);
    for (const sym of all) {
      assert.equal(Object.isFrozen(sym), true);
    }
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10c. indexFile 返回冻结数组", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/x.ts", "export class Foo {}");
    const indexer = new SymbolIndexer(tmpDir);
    const symbols = await indexer.indexFile("src/x.ts");
    assert.equal(Object.isFrozen(symbols), true);
    for (const sym of symbols) {
      assert.equal(Object.isFrozen(sym), true);
    }
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10d. indexIncremental 返回冻结对象", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(tmpDir, "src/a.ts", "export class A {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/a.ts");
    const diff: GitDiff = {
      changedFiles: [{ type: "modified", filePath: "src/a.ts", addedLines: [], removedLines: [] }],
      baseCommit: "abc",
      headCommit: "def",
    };
    const result = await indexer.indexIncremental(diff);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.reindexedFiles), true);
    assert.equal(Object.isFrozen(result.impactedSymbols), true);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T11. 重复 indexFile 同一文件（替换语义）
// ============================================================================

test("T11a. 重复 indexFile 同一文件替换旧符号", async () => {
  const tmpDir = await createTempProject();
  try {
    // 初始文件含 1 个 class
    await writeProjectFile(tmpDir, "src/x.ts", "export class A {}");
    const indexer = new SymbolIndexer(tmpDir);
    await indexer.indexFile("src/x.ts");
    assert.equal(indexer.getFileSymbols("src/x.ts").length, 1);

    // 修改文件：新增 1 个 class
    await writeProjectFile(tmpDir, "src/x.ts", "export class A {}\nexport class B {}");
    await indexer.indexFile("src/x.ts");
    assert.equal(indexer.getFileSymbols("src/x.ts").length, 2);
  } finally {
    await removeTempDir(tmpDir);
  }
});
