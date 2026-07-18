/**
 * EAG-P2 批次 8 单元测试：PKC L2 语义检索层类型定义
 *
 * 测试范围：
 * - T1. SymbolKind 字面量联合完整性（8 类符号）
 *   - T1a. SYMBOL_KINDS 包含 8 个值
 *   - T1b. SYMBOL_KINDS 顺序正确
 *   - T1c. SYMBOL_KINDS 已冻结
 * - T2. DEFAULT_KIND_BOOST 默认系数表
 *   - T2a. 全部 kind 默认 1.0
 *   - T2b. 已冻结
 * - T3. IndexedSymbol 接口字段完整性
 * - T4. SearchOptions 接口字段完整性
 * - T5. SearchResult 接口字段完整性（含 matchedBy 字面量联合）
 * - T6. GitDiffType 字面量联合完整性
 * - T7. GitDiffFile 接口字段完整性
 * - T8. GitDiff 接口字段完整性
 * - T9. ReindexResult 接口字段完整性
 * - T10. 默认参数常量
 *   - T10a. DEFAULT_RRF_K = 60
 *   - T10b. DEFAULT_TOP_K = 10
 *   - T10c. FOCUS_POINT_BOOST = 1.5
 *   - T10d. SMALL_CHANGE_FILE_THRESHOLD = 2
 *   - T10e. SMALL_CHANGE_IMPACTED_THRESHOLD = 10
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-pkc-l2-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KIND_BOOST,
  DEFAULT_RRF_K,
  DEFAULT_TOP_K,
  FOCUS_POINT_BOOST,
  SMALL_CHANGE_FILE_THRESHOLD,
  SMALL_CHANGE_IMPACTED_THRESHOLD,
  SYMBOL_KINDS,
} from "../eag/pkc/l2-types";
import type {
  GitDiff,
  GitDiffFile,
  GitDiffType,
  IndexedSymbol,
  ReindexResult,
  SearchOptions,
  SearchResult,
  SymbolKind,
} from "../eag/pkc/l2-types";

// ============================================================================
// T1. SymbolKind 字面量联合完整性
// ============================================================================

test("T1a. SYMBOL_KINDS 包含 8 个值", () => {
  assert.equal(SYMBOL_KINDS.length, 8);
});

test("T1b. SYMBOL_KINDS 顺序正确", () => {
  const expected: ReadonlyArray<SymbolKind> = [
    "class",
    "function",
    "method",
    "interface",
    "variable",
    "enum",
    "type-alias",
    "property",
  ];
  assert.deepEqual([...SYMBOL_KINDS], [...expected]);
});

test("T1c. SYMBOL_KINDS 已冻结", () => {
  assert.equal(Object.isFrozen(SYMBOL_KINDS), true);
});

// ============================================================================
// T2. DEFAULT_KIND_BOOST 默认系数表
// ============================================================================

test("T2a. DEFAULT_KIND_BOOST 全部 kind 默认 1.0", () => {
  for (const kind of SYMBOL_KINDS) {
    assert.equal(DEFAULT_KIND_BOOST[kind], 1.0);
  }
});

test("T2b. DEFAULT_KIND_BOOST 已冻结", () => {
  assert.equal(Object.isFrozen(DEFAULT_KIND_BOOST), true);
});

// ============================================================================
// T3. IndexedSymbol 接口字段完整性
// ============================================================================

test("T3. IndexedSymbol 接口字段完整性", () => {
  const symbol: IndexedSymbol = {
    symbolId: "src/services/UserService.ts:UserService.login",
    kind: "method",
    name: "login",
    signature: "login(email: string, password: string): Promise<AuthToken>",
    filePath: "src/services/UserService.ts",
    startLine: 42,
    endLine: 78,
    summary: "用户登录方法",
    embedding: [0.1, 0.2, 0.3],
  };
  assert.equal(symbol.symbolId, "src/services/UserService.ts:UserService.login");
  assert.equal(symbol.kind, "method");
  assert.equal(symbol.name, "login");
  assert.equal(symbol.startLine, 42);
  assert.equal(symbol.endLine, 78);
  assert.deepEqual([...(symbol.embedding ?? [])], [0.1, 0.2, 0.3]);
});

test("T3b. IndexedSymbol embedding 字段可选（无向量模型时为 undefined）", () => {
  const symbol: IndexedSymbol = {
    symbolId: "src/x.ts:foo",
    kind: "function",
    name: "foo",
    signature: "foo()",
    filePath: "src/x.ts",
    startLine: 1,
    endLine: 1,
    summary: "test",
  };
  assert.equal(symbol.embedding, undefined);
});

// ============================================================================
// T4. SearchOptions 接口字段完整性
// ============================================================================

test("T4. SearchOptions 接口字段完整性（全部可选）", () => {
  const opts: SearchOptions = {
    topK: 5,
    focusPoints: ["src/services/UserService.ts:UserService.login"],
    kindBoost: { ...DEFAULT_KIND_BOOST },
    enableVector: true,
    rrfK: 60,
  };
  assert.equal(opts.topK, 5);
  assert.equal(opts.focusPoints?.length, 1);
  assert.equal(opts.enableVector, true);
  assert.equal(opts.rrfK, 60);
});

// ============================================================================
// T5. SearchResult 接口字段完整性
// ============================================================================

test("T5. SearchResult 接口字段完整性（含 matchedBy 字面量联合）", () => {
  const result: SearchResult = {
    symbol: {
      symbolId: "src/x.ts:foo",
      kind: "function",
      name: "foo",
      signature: "foo()",
      filePath: "src/x.ts",
      startLine: 1,
      endLine: 1,
      summary: "test",
    },
    score: 0.873,
    matchedBy: "both",
    snippet: "function foo() { ... }",
  };
  assert.equal(result.score, 0.873);
  assert.equal(result.matchedBy, "both");
  assert.equal(result.snippet, "function foo() { ... }");
});

test("T5b. matchedBy 字面量联合覆盖 bm25/vector/both", () => {
  const values: SearchResult["matchedBy"][] = ["bm25", "vector", "both"];
  assert.equal(values.length, 3);
});

// ============================================================================
// T6. GitDiffType 字面量联合完整性
// ============================================================================

test("T6. GitDiffType 字面量联合覆盖 added/modified/deleted/renamed", () => {
  const types: GitDiffType[] = ["added", "modified", "deleted", "renamed"];
  assert.equal(types.length, 4);
});

// ============================================================================
// T7. GitDiffFile 接口字段完整性
// ============================================================================

test("T7. GitDiffFile 接口字段完整性", () => {
  const file: GitDiffFile = {
    type: "modified",
    filePath: "src/services/UserService.ts",
    oldFilePath: undefined,
    addedLines: [42, 43, 44],
    removedLines: [40],
  };
  assert.equal(file.type, "modified");
  assert.equal(file.filePath, "src/services/UserService.ts");
  assert.equal(file.oldFilePath, undefined);
  assert.equal(file.addedLines.length, 3);
  assert.equal(file.removedLines.length, 1);
});

test("T7b. GitDiffFile renamed 类型含 oldFilePath", () => {
  const file: GitDiffFile = {
    type: "renamed",
    filePath: "src/services/UserService.ts",
    oldFilePath: "src/services/UserService_old.ts",
    addedLines: [],
    removedLines: [],
  };
  assert.equal(file.oldFilePath, "src/services/UserService_old.ts");
});

// ============================================================================
// T8. GitDiff 接口字段完整性
// ============================================================================

test("T8. GitDiff 接口字段完整性", () => {
  const diff: GitDiff = {
    changedFiles: [
      {
        type: "modified",
        filePath: "src/services/UserService.ts",
        addedLines: [42],
        removedLines: [],
      },
    ],
    baseCommit: "abc1234",
    headCommit: "def5678",
  };
  assert.equal(diff.changedFiles.length, 1);
  assert.equal(diff.baseCommit, "abc1234");
  assert.equal(diff.headCommit, "def5678");
});

// ============================================================================
// T9. ReindexResult 接口字段完整性
// ============================================================================

test("T9. ReindexResult 接口字段完整性", () => {
  const result: ReindexResult = {
    reindexedFiles: ["src/services/UserService.ts"],
    impactedSymbols: ["src/services/UserService.ts:UserService.login"],
    addedSymbols: [],
    updatedSymbols: [],
    removedSymbols: [],
    skipped: false,
    reason: "增量重建",
  };
  assert.equal(result.reindexedFiles.length, 1);
  assert.equal(result.impactedSymbols.length, 1);
  assert.equal(result.skipped, false);
  assert.equal(result.reason, "增量重建");
});

// ============================================================================
// T10. 默认参数常量
// ============================================================================

test("T10a. DEFAULT_RRF_K = 60", () => {
  assert.equal(DEFAULT_RRF_K, 60);
});

test("T10b. DEFAULT_TOP_K = 10", () => {
  assert.equal(DEFAULT_TOP_K, 10);
});

test("T10c. FOCUS_POINT_BOOST = 1.5", () => {
  assert.equal(FOCUS_POINT_BOOST, 1.5);
});

test("T10d. SMALL_CHANGE_FILE_THRESHOLD = 2", () => {
  assert.equal(SMALL_CHANGE_FILE_THRESHOLD, 2);
});

test("T10e. SMALL_CHANGE_IMPACTED_THRESHOLD = 10", () => {
  assert.equal(SMALL_CHANGE_IMPACTED_THRESHOLD, 10);
});
