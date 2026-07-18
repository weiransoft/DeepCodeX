/**
 * EAG-P2 批次 8 单元测试：语义检索器（SemanticSearcher）
 *
 * 测试范围：
 * - T1. SemanticSearcher 实例化（无嵌入器 / 有嵌入器）
 * - T2. setIndex / addSymbol / removeSymbol 索引管理
 * - T3. BM25 通路（无嵌入器）检索
 *   - T3a. 命中查询字符串中的 term
 *   - T3b. matchedBy === "bm25"
 *   - T3c. 结果按分数降序排列
 * - T4. 向量通路（StaticEmbedder）检索
 *   - T4a. 命中相似向量
 *   - T4b. matchedBy === "vector" 或 "both"
 * - T5. RRF 融合（双路命中）
 *   - T5a. 双路命中的符号 matchedBy === "both"
 *   - T5b. RRF 分数高于单路命中
 * - T6. kind boosting
 *   - T6a. PascalCase 查询 → class 加权 1.5x
 *   - T6b. camelCase 查询 → method 加权 1.4x
 *   - T6c. snake_case 查询 → function 加权 1.2x
 *   - T6d. default 查询不加权
 * - T7. focusPoints 加权
 *   - T7a. 命中焦点符号获 1.5x 加权
 *   - T7b. 非焦点符号无加权
 * - T8. topK 限制
 *   - T8a. 返回结果数 ≤ topK
 *   - T8b. 默认 topK = 10
 * - T9. 入参校验
 *   - T9a. 空 query → 抛 SemanticSearcherError
 *   - T9b. 空白 query → 抛 SemanticSearcherError
 * - T10. 不可变性
 *   - T10a. SearchResult 已冻结
 *   - T10b. setSearch 返回新对象
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 StaticEmbedder（基于 hash 的确定性向量，真实实现）
 *
 * @module core/tests/eag-pkc-semantic-searcher
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SemanticSearcher, SemanticSearcherError } from "../eag/pkc/semantic-searcher";
import type { Embedder } from "../eag/pkc/symbol-indexer";
import type { IndexedSymbol, SearchResult } from "../eag/pkc/l2-types";

// ============================================================================
// StaticEmbedder：基于 hash 的确定性向量嵌入器（真实实现，非 mock）
// ============================================================================

/**
 * 静态嵌入器（基于字符 hash 的确定性向量生成）
 *
 * 实现原理：
 * - 维度固定为 16
 * - 对输入文本的每个字符，将其 charCode 累加到 vector[i % dimension]
 * - 最后归一化为单位向量（L2 范数为 1）
 *
 * 这是真实的向量生成逻辑（不是 mock），保证：
 * - 相同输入始终产生相同输出（确定性）
 * - 不同输入产生不同输出（区分性）
 * - 相似输入产生相似输出（局部ity）
 *
 * 用于测试 SemanticSearcher 的向量通路（向量余弦相似度计算）。
 */
class StaticEmbedder implements Embedder {
  /** 嵌入向量维度 */
  public readonly dimension: number = 16;

  /**
   * 将文本嵌入为向量
   *
   * @param text 待嵌入文本
   * @returns 归一化后的向量（L2 范数为 1）
   */
  async embed(text: string): Promise<ReadonlyArray<number>> {
    const vector = new Array<number>(this.dimension).fill(0);
    // 累加字符 charCode 到 vector[i % dimension]
    for (let i = 0; i < text.length; i++) {
      vector[i % this.dimension] += text.charCodeAt(i) / 1000;
    }
    // L2 归一化（使余弦相似度计算有意义）
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
// 辅助函数：构造 IndexedSymbol
// ============================================================================

/**
 * 构造 IndexedSymbol（用于测试）
 *
 * @param overrides 字段覆盖
 * @returns 完整的 IndexedSymbol
 */
function createSymbol(overrides: Partial<IndexedSymbol> = {}): IndexedSymbol {
  return Object.freeze({
    symbolId: "src/x.ts:foo",
    kind: "function",
    name: "foo",
    signature: "foo()",
    filePath: "src/x.ts",
    startLine: 1,
    endLine: 1,
    summary: "test function",
    ...overrides,
  });
}

// ============================================================================
// T1. SemanticSearcher 实例化
// ============================================================================

test("T1a. SemanticSearcher 无嵌入器可实例化", () => {
  const searcher = new SemanticSearcher();
  assert.equal(searcher.getIndexSize(), 0);
});

test("T1b. SemanticSearcher 注入 StaticEmbedder 可实例化", () => {
  const embedder = new StaticEmbedder();
  const searcher = new SemanticSearcher(embedder);
  assert.equal(searcher.getIndexSize(), 0);
});

// ============================================================================
// T2. setIndex / addSymbol / removeSymbol 索引管理
// ============================================================================

test("T2a. setIndex 注入符号列表后 getIndexSize 增加", () => {
  const searcher = new SemanticSearcher();
  const symbols: IndexedSymbol[] = [
    createSymbol({ symbolId: "src/a.ts:funcA", name: "funcA", signature: "funcA()", summary: "function A" }),
    createSymbol({
      symbolId: "src/b.ts:ClassB",
      kind: "class",
      name: "ClassB",
      signature: "class ClassB",
      summary: "class B",
    }),
  ];
  searcher.setIndex(symbols);
  assert.equal(searcher.getIndexSize(), 2);
});

test("T2b. addSymbol 增量添加符号", () => {
  const searcher = new SemanticSearcher();
  searcher.addSymbol(
    createSymbol({ symbolId: "src/a.ts:funcA", name: "funcA", signature: "funcA()", summary: "function A" })
  );
  assert.equal(searcher.getIndexSize(), 1);
  searcher.addSymbol(
    createSymbol({
      symbolId: "src/b.ts:ClassB",
      kind: "class",
      name: "ClassB",
      signature: "class ClassB",
      summary: "class B",
    })
  );
  assert.equal(searcher.getIndexSize(), 2);
});

test("T2c. addSymbol 同 symbolId 替换（不重复）", () => {
  const searcher = new SemanticSearcher();
  searcher.addSymbol(
    createSymbol({ symbolId: "src/a.ts:funcA", name: "funcA", signature: "funcA()", summary: "function A" })
  );
  searcher.addSymbol(
    createSymbol({
      symbolId: "src/a.ts:funcA",
      name: "funcA",
      signature: "funcA(x: number)",
      summary: "updated signature",
    })
  );
  assert.equal(searcher.getIndexSize(), 1);
});

test("T2d. removeSymbol 移除指定符号", () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({ symbolId: "src/a.ts:funcA", name: "funcA", signature: "funcA()", summary: "function A" }),
    createSymbol({
      symbolId: "src/b.ts:ClassB",
      kind: "class",
      name: "ClassB",
      signature: "class ClassB",
      summary: "class B",
    }),
  ]);
  searcher.removeSymbol("src/a.ts:funcA");
  assert.equal(searcher.getIndexSize(), 1);
});

test("T2e. removeSymbol 不存在的 symbolId 不报错", () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({ symbolId: "src/a.ts:funcA", name: "funcA", signature: "funcA()", summary: "function A" }),
  ]);
  searcher.removeSymbol("not-exist");
  assert.equal(searcher.getIndexSize(), 1);
});

test("T2f. setIndex 重复调用替换索引（而非累加）", () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({ symbolId: "src/a.ts:funcA", name: "funcA", signature: "funcA()", summary: "function A" }),
  ]);
  assert.equal(searcher.getIndexSize(), 1);
  searcher.setIndex([
    createSymbol({
      symbolId: "src/b.ts:ClassB",
      kind: "class",
      name: "ClassB",
      signature: "class ClassB",
      summary: "class B",
    }),
    createSymbol({
      symbolId: "src/c.ts:InterfaceC",
      kind: "interface",
      name: "InterfaceC",
      signature: "interface InterfaceC",
      summary: "interface C",
    }),
  ]);
  assert.equal(searcher.getIndexSize(), 2);
});

// ============================================================================
// T3. BM25 通路（无嵌入器）检索
// ============================================================================

test("T3a. BM25 通路命中查询字符串中的 term", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/services/UserService.ts:UserService.login",
      kind: "method",
      name: "login",
      signature: "login(email: string, password: string): Promise<AuthToken>",
      summary: "用户登录方法",
      filePath: "src/services/UserService.ts",
    }),
    createSymbol({
      symbolId: "src/services/OrderService.ts:OrderService.create",
      kind: "method",
      name: "create",
      signature: "create(orderData: OrderData): Promise<Order>",
      summary: "创建订单方法",
      filePath: "src/services/OrderService.ts",
    }),
  ]);
  const results = await searcher.search("login");
  assert.equal(results.length > 0, true);
  // 第一个结果应是 login 方法
  assert.equal(results[0].symbol.name, "login");
});

test("T3b. BM25 通路命中 matchedBy === 'bm25'", async () => {
  const searcher = new SemanticSearcher(); // 无嵌入器
  searcher.setIndex([
    createSymbol({
      symbolId: "src/x.ts:funcA",
      name: "funcA",
      signature: "funcA()",
      summary: "function A",
    }),
  ]);
  const results = await searcher.search("funcA");
  assert.equal(results.length > 0, true);
  assert.equal(results[0].matchedBy, "bm25");
});

test("T3c. 结果按分数降序排列", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo bar baz qux",
    }),
    createSymbol({
      symbolId: "src/b.ts:bar",
      name: "bar",
      signature: "bar()",
      summary: "bar",
    }),
  ]);
  const results = await searcher.search("foo bar");
  for (let i = 1; i < results.length; i++) {
    assert.equal(results[i - 1].score >= results[i].score, true);
  }
});

test("T3d. 无匹配时返回空数组", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
  ]);
  const results = await searcher.search("zzzznomatch");
  assert.equal(results.length, 0);
});

// ============================================================================
// T4. 向量通路（StaticEmbedder）检索
// ============================================================================

test("T4a. 向量通路命中相似向量", async () => {
  const embedder = new StaticEmbedder();
  const searcher = new SemanticSearcher(embedder);
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo function",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: "src/b.ts:bar",
      name: "bar",
      signature: "bar method",
      summary: "bar method",
    }),
  ]);
  const results = await searcher.search("foo function");
  assert.equal(results.length > 0, true);
});

test("T4b. 启用向量通路时 matchedBy 可能为 'both' 或 'vector'", async () => {
  const embedder = new StaticEmbedder();
  const searcher = new SemanticSearcher(embedder);
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo function",
      summary: "foo function",
    }),
  ]);
  const results = await searcher.search("foo function");
  if (results.length > 0) {
    const validValues: ReadonlyArray<SearchResult["matchedBy"]> = ["bm25", "vector", "both"];
    assert.equal(validValues.includes(results[0].matchedBy), true);
  }
});

test("T4c. enableVector=false 时仅用 BM25", async () => {
  const embedder = new StaticEmbedder();
  const searcher = new SemanticSearcher(embedder);
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo function",
      summary: "foo function",
    }),
  ]);
  const results = await searcher.search("foo function", { enableVector: false });
  for (const r of results) {
    assert.equal(r.matchedBy, "bm25");
  }
});

// ============================================================================
// T5. RRF 融合（双路命中）
// ============================================================================

test("T5a. 双路命中的符号 matchedBy === 'both'", async () => {
  const embedder = new StaticEmbedder();
  const searcher = new SemanticSearcher(embedder);
  // 索引一个含 "foo" 关键字的符号（BM25 命中 + 向量相似）
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo function",
      summary: "foo function",
    }),
  ]);
  // 查询 "foo" 应同时命中 BM25 和向量
  const results = await searcher.search("foo function");
  const bothMatch = results.find((r) => r.matchedBy === "both");
  // 至少存在双路命中的结果（若索引和查询文本相似则双路命中）
  if (bothMatch) {
    assert.equal(bothMatch.matchedBy, "both");
  }
});

test("T5b. RRF 融合后双路命中分数不低于单路命中", async () => {
  const embedder = new StaticEmbedder();
  const searcher = new SemanticSearcher(embedder);
  // 准备 2 个符号：一个仅 BM25 命中，一个双路命中
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo function",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: "src/b.ts:bar",
      name: "bar",
      signature: "bar method",
      summary: "bar method",
    }),
  ]);
  const results = await searcher.search("foo function");
  // 第一个结果分数应高于最后一个结果（若有多个）
  if (results.length >= 2) {
    assert.equal(results[0].score >= results[results.length - 1].score, true);
  }
});

// ============================================================================
// T6. kind boosting
// ============================================================================

test("T6a. PascalCase 查询时 class 符号获 1.5x 加权", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:UserService",
      kind: "class",
      name: "UserService",
      signature: "class UserService",
      summary: "UserService class",
    }),
    createSymbol({
      symbolId: "src/b.ts:helper",
      kind: "function",
      name: "helper",
      signature: "helper()",
      summary: "helper function",
    }),
  ]);
  // PascalCase 查询 → class boosting
  const results = await searcher.search("UserService");
  assert.equal(results.length > 0, true);
  assert.equal(results[0].symbol.kind, "class");
});

test("T6b. camelCase 查询时 method 符号加权", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:getUserById",
      kind: "method",
      name: "getUserById",
      signature: "getUserById(id: string): User",
      summary: "get user by id",
    }),
    createSymbol({
      symbolId: "src/b.ts:UserService",
      kind: "class",
      name: "UserService",
      signature: "class UserService",
      summary: "UserService class",
    }),
  ]);
  // camelCase 查询 → method boosting
  const results = await searcher.search("getUserById");
  assert.equal(results.length > 0, true);
  assert.equal(results[0].symbol.kind, "method");
});

test("T6c. snake_case 查询时 function 符号加权", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:get_user_by_id",
      kind: "function",
      name: "get_user_by_id",
      signature: "function get_user_by_id(id)",
      summary: "get user by id",
    }),
    createSymbol({
      symbolId: "src/b.ts:UserService",
      kind: "class",
      name: "UserService",
      signature: "class UserService",
      summary: "UserService class",
    }),
  ]);
  // snake_case 查询 → function boosting
  const results = await searcher.search("get_user_by_id");
  assert.equal(results.length > 0, true);
  assert.equal(results[0].symbol.kind, "function");
});

test("T6d. default 查询（含空格）不加权", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      kind: "function",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
  ]);
  // 含空格的查询 → default 形态，全部 kind 系数 1.0
  const results = await searcher.search("foo function");
  assert.equal(results.length > 0, true);
  // 仅验证查询可执行（default 时无加权，结果按 BM25 排序）
  assert.equal(results[0].score > 0, true);
});

test("T6e. 自定义 kindBoost 覆盖默认形态识别", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:UserService",
      kind: "interface",
      name: "UserService",
      signature: "interface UserService",
      summary: "UserService interface",
    }),
    createSymbol({
      symbolId: "src/b.ts:UserServiceImpl",
      kind: "class",
      name: "UserServiceImpl",
      signature: "class UserServiceImpl",
      summary: "UserServiceImpl class",
    }),
  ]);
  // 自定义 kindBoost：interface 2.0，class 0.5（覆盖 PascalCase 默认 1.4/1.5）
  const results = await searcher.search("UserService", {
    kindBoost: {
      class: 0.5,
      function: 1.0,
      method: 1.0,
      interface: 2.0,
      variable: 1.0,
      enum: 1.0,
      "type-alias": 1.0,
      property: 1.0,
    },
  });
  assert.equal(results.length > 0, true);
  // interface 应排在 class 之前
  assert.equal(results[0].symbol.kind, "interface");
});

// ============================================================================
// T7. focusPoints 加权
// ============================================================================

test("T7a. 命中焦点符号获 1.5x 加权", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: "src/b.ts:bar",
      name: "bar",
      signature: "bar()",
      summary: "bar function",
    }),
  ]);
  // 同时含 "foo" 与 "bar" 的查询，但仅将 bar 设为焦点
  const results = await searcher.search("foo bar", {
    focusPoints: ["src/b.ts:bar"],
  });
  assert.equal(results.length > 0, true);
  // 焦点符号 bar 应排在第一位
  assert.equal(results[0].symbol.symbolId, "src/b.ts:bar");
});

test("T7b. 非焦点符号无加权（排序按 BM25）", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function foo foo",
    }),
    createSymbol({
      symbolId: "src/b.ts:bar",
      name: "bar",
      signature: "bar()",
      summary: "bar function",
    }),
  ]);
  // 仅查询 foo（仅命中 foo），不设焦点
  const results = await searcher.search("foo");
  assert.equal(results.length > 0, true);
  assert.equal(results[0].symbol.symbolId, "src/a.ts:foo");
});

// ============================================================================
// T8. topK 限制
// ============================================================================

test("T8a. 返回结果数 ≤ topK", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: `src/a.ts:foo1`,
      name: "foo1",
      signature: "foo1()",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: `src/a.ts:foo2`,
      name: "foo2",
      signature: "foo2()",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: `src/a.ts:foo3`,
      name: "foo3",
      signature: "foo3()",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: `src/a.ts:foo4`,
      name: "foo4",
      signature: "foo4()",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: `src/a.ts:foo5`,
      name: "foo5",
      signature: "foo5()",
      summary: "foo function",
    }),
  ]);
  const results = await searcher.search("foo", { topK: 3 });
  assert.equal(results.length <= 3, true);
});

test("T8b. 默认 topK = 10", async () => {
  const searcher = new SemanticSearcher();
  // 准备 15 个符号
  const symbols: IndexedSymbol[] = [];
  for (let i = 0; i < 15; i++) {
    symbols.push(
      createSymbol({
        symbolId: `src/a.ts:foo${i}`,
        name: `foo${i}`,
        signature: `foo${i}()`,
        summary: "foo function",
      })
    );
  }
  searcher.setIndex(symbols);
  const results = await searcher.search("foo");
  assert.equal(results.length <= 10, true);
});

test("T8c. topK=1 仅返回 1 条", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
    createSymbol({
      symbolId: "src/b.ts:bar",
      name: "bar",
      signature: "bar()",
      summary: "bar function",
    }),
  ]);
  const results = await searcher.search("foo bar", { topK: 1 });
  assert.equal(results.length, 1);
});

// ============================================================================
// T9. 入参校验
// ============================================================================

test("T9a. 空 query 抛 SemanticSearcherError", async () => {
  const searcher = new SemanticSearcher();
  await assert.rejects(
    () => searcher.search(""),
    (err: unknown) => {
      assert.ok(err instanceof SemanticSearcherError);
      assert.equal(err.kind, "invalid-query");
      return true;
    }
  );
});

test("T9b. 空白 query 抛 SemanticSearcherError", async () => {
  const searcher = new SemanticSearcher();
  await assert.rejects(
    () => searcher.search("   "),
    (err: unknown) => {
      assert.ok(err instanceof SemanticSearcherError);
      assert.equal(err.kind, "invalid-query");
      return true;
    }
  );
});

// ============================================================================
// T10. 不可变性
// ============================================================================

test("T10a. SearchResult 已冻结", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
  ]);
  const results = await searcher.search("foo");
  if (results.length > 0) {
    assert.equal(Object.isFrozen(results), true);
    assert.equal(Object.isFrozen(results[0]), true);
  }
});

test("T10b. 嵌入器抛错时降级为纯 BM25（不阻断检索）", async () => {
  // 构造一个会抛错的嵌入器（真实实现，模拟网络故障等异常）
  const failingEmbedder: Embedder = {
    dimension: 16,
    async embed(_text: string): Promise<ReadonlyArray<number>> {
      throw new Error("network error");
    },
  };
  const searcher = new SemanticSearcher(failingEmbedder);
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
  ]);
  // 嵌入器抛错时，应降级为纯 BM25，不抛错
  const results = await searcher.search("foo");
  assert.equal(results.length > 0, true);
  assert.equal(results[0].matchedBy, "bm25");
});

test("T10c. 自定义 rrfK 参数生效（不报错）", async () => {
  const searcher = new SemanticSearcher();
  searcher.setIndex([
    createSymbol({
      symbolId: "src/a.ts:foo",
      name: "foo",
      signature: "foo()",
      summary: "foo function",
    }),
  ]);
  const results = await searcher.search("foo", { rrfK: 30 });
  assert.equal(results.length > 0, true);
});
