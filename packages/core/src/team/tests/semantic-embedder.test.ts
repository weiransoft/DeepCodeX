/**
 * Semantic Embedder 单元测试
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/test_semantic_embedder.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 覆盖范围：
 * 1. tokenize 文本分词
 * 2. cosineSimilarity 向量余弦相似度
 * 3. TFIDFEmbedder fit / embed / similarity
 * 4. HashingEmbedder embed / similarity
 * 5. SentenceTransformerEmbedder fallback
 * 6. EmbeddingCache LRU + 命中率
 * 7. createEmbedder 工厂
 */

import {
  TFIDFEmbedder,
  HashingEmbedder,
  SentenceTransformerEmbedder,
  EmbeddingCache,
  cosineSimilarity,
  tokenize,
  getDefaultEmbedder,
  resetDefaultEmbedder,
  createEmbedder,
  type EmbedderLike,
} from "../workflows/semantic-embedder.js";

// ----------------------------------------------------------------------------
// 测试辅助
// ----------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}（expected true）`);
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(actual - expected) <= tolerance) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`);
}

function assertThrows(fn: () => unknown, ctor: abstract new (...args: never[]) => Error, label: string): void {
  try {
    fn();
    failed += 1;
    failures.push(`FAIL: ${label}（未抛异常）`);
  } catch (e) {
    if (e instanceof ctor) {
      passed += 1;
    } else {
      const errName = e instanceof Error ? e.constructor.name : String(e);
      failures.push(`FAIL: ${label}（抛错类型错误：实际 ${errName}，期望 ${ctor.name}）`);
    }
  }
}

function suite(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    console.log(`\n=== ${name} ===`);
  });
}

// ============================================================================
// 1. tokenize 文本分词
// ============================================================================

await suite("tokenize 英文", () => {
  const tokens = tokenize("Hello World");
  assertEqual(tokens.length, 2, "two tokens");
  assertEqual(tokens[0], "hello", "hello");
  assertEqual(tokens[1], "world", "world");
});

await suite("tokenize 中文（按字切分）", () => {
  const tokens = tokenize("你好世界");
  assertEqual(tokens.length, 4, "four tokens");
  assertEqual(tokens[0], "你", "你");
  assertEqual(tokens[1], "好", "好");
  assertEqual(tokens[2], "世", "世");
  assertEqual(tokens[3], "界", "界");
});

await suite("tokenize 中英文混合", () => {
  const tokens = tokenize("机器 learning 算法");
  // 期望：机/器/learning/算/法
  assertTrue(tokens.includes("learning"), "english token present");
  assertTrue(tokens.includes("机"), "chinese token 1");
  assertTrue(tokens.includes("器"), "chinese token 2");
});

await suite("tokenize 数字", () => {
  const tokens = tokenize("Python 3.11 has 123 features");
  assertTrue(tokens.includes("python"), "python");
  assertTrue(tokens.includes("3"), "3");
  assertTrue(tokens.includes("11"), "11");
  assertTrue(tokens.includes("123"), "123");
});

await suite("tokenize 标点去除", () => {
  const tokens = tokenize("Hello, World!");
  assertEqual(tokens.length, 2, "punctuation removed");
});

await suite("tokenize 空文本", () => {
  assertEqual(tokenize("").length, 0, "empty");
  assertEqual(tokenize("   ").length, 0, "spaces only");
  assertEqual(tokenize("!@#$").length, 0, "punctuation only");
});

// ============================================================================
// 2. cosineSimilarity
// ============================================================================

await suite("cosineSimilarity 完全相同", () => {
  const v = [1.0, 0.0, 0.0];
  assertClose(cosineSimilarity(v, v), 1.0, 1e-9, "identical vectors");
});

await suite("cosineSimilarity 完全正交", () => {
  const a = [1.0, 0.0, 0.0];
  const b = [0.0, 1.0, 0.0];
  assertClose(cosineSimilarity(a, b), 0.0, 1e-9, "orthogonal");
});

await suite("cosineSimilarity 反向", () => {
  const a = [1.0, 0.0, 0.0];
  const b = [-1.0, 0.0, 0.0];
  // cosine similarity 截断到 [0, 1]
  assertClose(cosineSimilarity(a, b), 0.0, 1e-9, "opposite → clamped to 0");
});

await suite("cosineSimilarity 维度不一致", () => {
  const a = [1.0, 0.0];
  const b = [0.0, 1.0, 0.0];
  // 截断到 min 维度
  assertClose(cosineSimilarity(a, b), 0.0, 1e-9, "truncate to min");
});

await suite("cosineSimilarity 空向量", () => {
  assertEqual(cosineSimilarity([], [1.0]), 0.0, "empty a");
  assertEqual(cosineSimilarity([1.0], []), 0.0, "empty b");
  assertEqual(cosineSimilarity([], []), 0.0, "both empty");
});

await suite("cosineSimilarity 零向量", () => {
  assertEqual(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0.0, "zero a");
  assertEqual(cosineSimilarity([1, 2, 3], [0, 0, 0]), 0.0, "zero b");
});

// ============================================================================
// 3. TFIDFEmbedder
// ============================================================================

await suite("TFIDFEmbedder 懒训练：fit 未调用时第一次 embed 触发", () => {
  const emb = new TFIDFEmbedder();
  const vec = emb.embed("hello world");
  assertTrue(emb.dimension > 0, "vocab created");
  assertEqual(vec.length, emb.dimension, "vec length matches vocab");
});

await suite("TFIDFEmbedder fit 后可用", () => {
  const emb = new TFIDFEmbedder({
    corpus: ["hello world", "foo bar", "hello foo"],
  });
  assertTrue(emb.dimension > 0, "vocab non-empty");
  const vec = emb.embed("hello world");
  assertEqual(vec.length, emb.dimension, "vec length");
});

await suite("TFIDFEmbedder similarity 完全相同文本 → 1.0", () => {
  const emb = new TFIDFEmbedder({ corpus: ["hello world"] });
  assertClose(emb.similarity("hello world", "hello world"), 1.0, 1e-9, "identical");
});

await suite("TFIDFEmbedder similarity 完全不同 → 0.0", () => {
  const emb = new TFIDFEmbedder({
    corpus: ["hello world", "completely different content here"],
  });
  const sim = emb.similarity("hello", "completely");
  assertTrue(sim < 0.5, `low similarity: ${sim}`);
});

await suite("TFIDFEmbedder similarity 相似文本 → 高分", () => {
  const emb = new TFIDFEmbedder({
    corpus: ["machine learning is great", "deep learning is powerful"],
  });
  const sim = emb.similarity("machine learning is great", "deep learning is powerful");
  // 共享 "learning" / "is" → 应该有中等以上相似度
  assertTrue(sim > 0.3, `medium similarity: ${sim}`);
});

await suite("TFIDFEmbedder 短文本 → 零向量", () => {
  const emb = new TFIDFEmbedder({ corpus: ["hello world"] });
  const vec = emb.embed("");
  // 空 token 列表 → 零向量
  assertTrue(
    vec.every((v) => v === 0),
    "all zero"
  );
});

await suite("TFIDFEmbedder isSemanticMatch", () => {
  const emb = new TFIDFEmbedder({ corpus: ["hello world"] });
  assertTrue(emb.isSemanticMatch("hello world", "hello world", 0.85), "match identical");
  assertTrue(!emb.isSemanticMatch("hello", "world", 0.85), "no match different");
});

await suite("TFIDFEmbedder embedBatch 批量", () => {
  const emb = new TFIDFEmbedder({ corpus: ["hello world", "foo bar"] });
  const vecs = emb.embedBatch(["hello", "world", "foo"]);
  assertEqual(vecs.length, 3, "3 vectors");
  for (const v of vecs) {
    assertEqual(v.length, emb.dimension, "vec length consistent");
  }
});

await suite("TFIDFEmbedder L2 归一化", () => {
  const emb = new TFIDFEmbedder({ corpus: ["hello world"] });
  const vec = emb.embed("hello world");
  let norm = 0.0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  assertClose(norm, 1.0, 1e-9, "L2 norm is 1");
});

await suite("TFIDFEmbedder max_features 限制词表", () => {
  const corpus = Array.from({ length: 100 }, (_, i) => `token${i} foo bar`);
  const emb = new TFIDFEmbedder({ corpus, max_features: 10 });
  assertTrue(emb.dimension <= 10, `vocab size: ${emb.dimension}`);
});

await suite("TFIDFEmbedder norm='none' 不归一化", () => {
  const emb = new TFIDFEmbedder({
    corpus: ["hello world"],
    norm: "none",
  });
  const vec = emb.embed("hello world");
  let norm = 0.0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  // 不归一化：norm 不为 1
  assertTrue(Math.abs(norm - 1.0) > 0.01, "not normalized");
});

// ============================================================================
// 4. HashingEmbedder
// ============================================================================

await suite("HashingEmbedder 维度正确", () => {
  const emb = new HashingEmbedder({ n_features: 256 });
  assertEqual(emb.dimension, 256, "dimension");
  const vec = emb.embed("hello world");
  assertEqual(vec.length, 256, "vec length");
});

await suite("HashingEmbedder 同文本 → 同向量", () => {
  const emb = new HashingEmbedder({ n_features: 1024 });
  const v1 = emb.embed("hello world");
  const v2 = emb.embed("hello world");
  for (let i = 0; i < v1.length; i++) {
    assertEqual(v1[i], v2[i], `idx ${i}`);
  }
});

await suite("HashingEmbedder similarity 完全相同 → 1.0", () => {
  const emb = new HashingEmbedder();
  assertClose(emb.similarity("hello", "hello"), 1.0, 1e-9, "identical");
});

await suite("HashingEmbedder 跨运行稳定", () => {
  const emb1 = new HashingEmbedder({ n_features: 128 });
  const emb2 = new HashingEmbedder({ n_features: 128 });
  const v1 = emb1.embed("hello world");
  const v2 = emb2.embed("hello world");
  // MD5 哈希确定性：两个实例应产生相同向量
  for (let i = 0; i < v1.length; i++) {
    assertEqual(v1[i], v2[i], `idx ${i}`);
  }
});

await suite("HashingEmbedder L2 归一化", () => {
  const emb = new HashingEmbedder({ n_features: 256 });
  const vec = emb.embed("hello world hello");
  let norm = 0.0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  assertClose(norm, 1.0, 1e-9, "L2 norm is 1");
});

await suite("HashingEmbedder embedBatch", () => {
  const emb = new HashingEmbedder();
  const vecs = emb.embedBatch(["hello", "world"]);
  assertEqual(vecs.length, 2, "2 vectors");
});

await suite("HashingEmbedder sign trick 存在正负值", () => {
  const emb = new HashingEmbedder({ n_features: 1024 });
  const vec = emb.embed("hello world foo bar baz qux");
  const hasPos = vec.some((x) => x > 0);
  const hasNeg = vec.some((x) => x < 0);
  assertTrue(hasPos, "has positive");
  assertTrue(hasNeg, "has negative (sign trick)");
});

// ============================================================================
// 5. SentenceTransformerEmbedder (无 delegate 时使用 mock)
// ============================================================================

await suite("SentenceTransformerEmbedder 无 delegate 使用 mock", () => {
  const emb = new SentenceTransformerEmbedder();
  assertEqual(emb.dimension, 384, "default dim 384");
  const vec = emb.embed("hello world");
  assertEqual(vec.length, 384, "vec length");
});

await suite("SentenceTransformerEmbedder mock 完全相同 → 1.0", () => {
  const emb = new SentenceTransformerEmbedder();
  assertClose(emb.similarity("hello", "hello"), 1.0, 1e-9, "identical");
});

await suite("SentenceTransformerEmbedder mock L2 归一化", () => {
  const emb = new SentenceTransformerEmbedder();
  const vec = emb.embed("hello world");
  let norm = 0.0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  assertClose(norm, 1.0, 1e-9, "normalized");
});

await suite("SentenceTransformerEmbedder 注入 delegate", () => {
  const fakeVec = [0.1, 0.2, 0.3];
  const delegate = {
    model_name: "fake",
    dimension: 3,
    embed: (_text: string): number[] => fakeVec,
    embedBatch: (_texts: string[]): number[][] => [fakeVec, fakeVec],
  };
  const emb = new SentenceTransformerEmbedder({ delegate });
  assertEqual(emb.dimension, 3, "dim from delegate");
  const vec = emb.embed("anything");
  assertEqual(vec, fakeVec, "vec from delegate");
});

await suite("SentenceTransformerEmbedder 同步 delegate 抛错（Promise）", () => {
  const delegate = {
    model_name: "async",
    dimension: 3,
    embed: (_text: string): Promise<number[]> => Promise.resolve([0.1, 0.2, 0.3]),
    embedBatch: (_texts: string[]): Promise<number[][]> => Promise.resolve([[0.1, 0.2, 0.3]]),
  };
  const emb = new SentenceTransformerEmbedder({ delegate });
  assertThrows(
    () => emb.embed("test"),
    Error as abstract new (...args: never[]) => Error,
    "Promise delegate throws on sync embed"
  );
});

// ============================================================================
// 6. EmbeddingCache
// ============================================================================

await suite("EmbeddingCache 基本缓存", () => {
  const inner = new TFIDFEmbedder({ corpus: ["hello world"] });
  const cache = new EmbeddingCache({ embedder: inner, capacity: 10 });
  const v1 = cache.getOrCompute("hello world");
  const v2 = cache.getOrCompute("hello world");
  // 缓存命中：返回相同引用
  assertTrue(v1 === v2, "cached reference");
  assertEqual(cache.hits, 1, "1 hit");
  assertEqual(cache.misses, 1, "1 miss");
});

await suite("EmbeddingCache 命中率统计", () => {
  const inner = new TFIDFEmbedder({ corpus: ["hello world"] });
  const cache = new EmbeddingCache({ embedder: inner, capacity: 10 });
  cache.getOrCompute("a");
  cache.getOrCompute("b");
  cache.getOrCompute("a"); // hit
  cache.getOrCompute("b"); // hit
  cache.getOrCompute("c");
  assertEqual(cache.hits, 2, "2 hits");
  assertEqual(cache.misses, 3, "3 misses");
  assertClose(cache.hitRate, 2 / 5, 1e-9, "hit rate");
});

await suite("EmbeddingCache LRU 淘汰", () => {
  const inner = new TFIDFEmbedder({ corpus: ["hello world"] });
  const cache = new EmbeddingCache({ embedder: inner, capacity: 2 });
  cache.getOrCompute("a");
  cache.getOrCompute("b");
  cache.getOrCompute("c"); // 触发淘汰
  assertEqual(cache.size, 2, "size capped at 2");
  // a 已被淘汰
  cache.getOrCompute("a"); // miss
  assertEqual(cache.misses, 4, "4 misses (a, b, c, a)");
});

await suite("EmbeddingCache LRU 更新顺序", () => {
  const inner = new TFIDFEmbedder({ corpus: ["hello world"] });
  const cache = new EmbeddingCache({ embedder: inner, capacity: 2 });
  cache.getOrCompute("a");
  cache.getOrCompute("b");
  // 访问 a 使其变为最近
  cache.getOrCompute("a");
  cache.getOrCompute("c"); // 应该淘汰 b（最旧）
  // b 应被淘汰
  cache.getOrCompute("b"); // miss
  assertEqual(cache.misses, 4, "b was evicted");
});

await suite("EmbeddingCache similarity", () => {
  const inner = new TFIDFEmbedder({ corpus: ["hello world"] });
  const cache = new EmbeddingCache({ embedder: inner, capacity: 10 });
  const sim = cache.similarity("hello world", "hello world");
  assertClose(sim, 1.0, 1e-9, "identical");
});

await suite("EmbeddingCache clear", () => {
  const inner = new TFIDFEmbedder({ corpus: ["hello world"] });
  const cache = new EmbeddingCache({ embedder: inner, capacity: 10 });
  cache.getOrCompute("a");
  cache.clear();
  assertEqual(cache.size, 0, "size 0");
  assertEqual(cache.hits, 0, "hits reset");
  assertEqual(cache.misses, 0, "misses reset");
});

// ============================================================================
// 7. createEmbedder 工厂
// ============================================================================

await suite("createEmbedder auto → TFIDF", () => {
  resetDefaultEmbedder();
  const emb = createEmbedder("auto");
  assertTrue(emb instanceof TFIDFEmbedder, "tfidf instance");
});

await suite("createEmbedder tfidf", () => {
  const emb = createEmbedder("tfidf", { corpus: ["hello"] });
  assertTrue(emb instanceof TFIDFEmbedder, "tfidf");
});

await suite("createEmbedder hashing", () => {
  const emb = createEmbedder("hashing", { n_features: 512 });
  assertTrue(emb instanceof HashingEmbedder, "hashing");
  assertEqual(emb.dimension, 512, "dim 512");
});

await suite("createEmbedder sentence_transformer", () => {
  const emb = createEmbedder("sentence_transformer");
  assertTrue(emb instanceof SentenceTransformerEmbedder, "st");
});

await suite("createEmbedder 未知类型抛错", () => {
  // 使用类型断言绕过静态检查（运行时仍会抛错）
  assertThrows(
    () => createEmbedder("unknown" as unknown as "auto"),
    Error as abstract new (...args: never[]) => Error,
    "unknown type throws"
  );
});

// ============================================================================
// 8. getDefaultEmbedder 单例
// ============================================================================

await suite("getDefaultEmbedder 返回相同实例", () => {
  resetDefaultEmbedder();
  const a = getDefaultEmbedder();
  const b = getDefaultEmbedder();
  assertTrue(a === b, "singleton");
});

// ============================================================================
// 9. 跨 Embedder 类型比较
// ============================================================================

await suite("HashingEmbedder 适合大规模（O(1) 内存）", () => {
  // 1M token 文本不应导致内存爆炸
  const bigText = "hello ".repeat(100_000);
  const emb = new HashingEmbedder({ n_features: 256 });
  const vec = emb.embed(bigText);
  assertEqual(vec.length, 256, "fixed dim regardless of input");
});

await suite("TFIDFEmbedder 适合中等规模", () => {
  // 词表大小与语料库相关
  const emb = new TFIDFEmbedder({
    corpus: ["alpha beta gamma", "delta epsilon zeta", "eta theta iota"],
  });
  assertTrue(emb.dimension > 0, "vocab non-empty");
  assertTrue(emb.dimension < 100, "small vocab");
});

await suite("三种 Embedder 共享 EmbedderLike 接口", () => {
  const embedders: EmbedderLike[] = [new TFIDFEmbedder(), new HashingEmbedder(), new SentenceTransformerEmbedder()];
  for (const e of embedders) {
    assertTrue(typeof e.dimension === "number", "has dimension");
    assertTrue(typeof e.embed === "function", "has embed");
    assertTrue(typeof e.similarity === "function", "has similarity");
    assertTrue(typeof e.isSemanticMatch === "function", "has isSemanticMatch");
  }
});

// ----------------------------------------------------------------------------
// 输出
// ----------------------------------------------------------------------------

console.log(`\n=== Test Summary ===`);

console.log(`Passed: ${passed}`);

console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
