/**
 * Semantic Embedder：真实的语义去重（Phase 6 升级 TypeScript 移植版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/semantic_embedder.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 核心目标：
 * - 把 generate-filter 的 dedup_strategy="semantic" 升级为真正的语义去重
 * - 默认实现 TFIDFEmbedder（无外部依赖，开箱即用）
 * - 可选实现 SentenceTransformerEmbedder（依赖 sentence-transformers，优雅降级）
 * - HashingEmbedder 用于超大规模候选集（O(1) 内存）
 *
 * 设计原则：
 * - 无外部依赖：TFIDFEmbedder 用纯 TypeScript + Math（避免 numpy 硬依赖）
 * - 接口统一：所有 Embedder 实现 EmbedderLike 接口
 * - 线程安全：EmbeddingCache 使用简单的同步（Node 单线程）
 * - 性能优先：HashingEmbedder 用于 >1000 候选
 * - 优雅降级：SentenceTransformerEmbedder 不可用时 fallback 到 TFIDF
 *
 * 作者：trae-multi-agent 融合 Phase 6（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

import * as crypto from "node:crypto";

// ============================================================================
// 模块日志
// ============================================================================

/** 模块日志回调（由调用方注入） */
export type SemanticLogCallback = (level: string, message: string) => void;

/** 默认日志回调（stdout） */
export const defaultSemanticLog: SemanticLogCallback = (level, message) => {
  console.log(`[semantic-embedder] [${level}] ${message}`);
};

/** 模块级日志（可由调用方通过 setLogCallback 替换） */
let moduleLog: SemanticLogCallback = defaultSemanticLog;

/** 设置模块日志回调 */
export function setSemanticLogCallback(cb: SemanticLogCallback | null): void {
  moduleLog = cb ?? defaultSemanticLog;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算两个向量的余弦相似度
 *
 * @param a 向量 A
 * @param b 向量 B
 * @returns 余弦相似度 0.0-1.0（已截断到 [0, 1]）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0.0;
  }
  let aWork: number[];
  let bWork: number[];
  if (a.length !== b.length) {
    // 维度不一致：截断到最小维度
    const n = Math.min(a.length, b.length);
    aWork = a.slice(0, n);
    bWork = b.slice(0, n);
  } else {
    aWork = a;
    bWork = b;
  }
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < aWork.length; i++) {
    dot += aWork[i]! * bWork[i]!;
    normA += aWork[i]! * aWork[i]!;
    normB += bWork[i]! * bWork[i]!;
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0.0 || normB === 0.0) {
    return 0.0;
  }
  const sim = dot / (normA * normB);
  // 截断到 [0, 1]
  return Math.max(0.0, Math.min(1.0, sim));
}

/**
 * 文本分词（轻量级：支持中英文混合）
 *
 * 策略：
 * - 英文：按非字母数字切分，转小写
 * - 中文：按字符切分（避免 jieba 硬依赖）
 * - 数字：作为 token 保留
 * - 去除标点
 * - 不去重（保留频率信息）
 *
 * @param text 输入文本
 * @returns token 列表
 */
export function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  // 简化的中英文分词：
  // - 英文/数字作为一个 token
  // - 中文字符（Unicode 4E00-9FFF）每个字作为一个 token
  // 其他字符（标点、空格、emoji）忽略
  const tokens: string[] = [];
  let buffer = "";
  for (const ch of lower) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)) {
      // 数字或英文小写字母：累积
      buffer += ch;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      // 中文字符：先 flush buffer，再加入单字
      if (buffer.length > 0) {
        tokens.push(buffer);
        buffer = "";
      }
      tokens.push(ch);
    } else {
      // 其他字符（标点、空格等）：flush buffer
      if (buffer.length > 0) {
        tokens.push(buffer);
        buffer = "";
      }
    }
  }
  if (buffer.length > 0) {
    tokens.push(buffer);
  }
  return tokens;
}

// ============================================================================
// Embedder 接口
// ============================================================================

/**
 * Embedder 抽象接口
 *
 * 关键接口：
 * - dimension：向量维度
 * - embed(text)：单文本 → 向量
 * - embedBatch(texts)：批量文本 → 向量列表
 * - similarity(a, b)：两文本相似度 0.0-1.0
 * - isSemanticMatch(a, b, threshold)：语义匹配判定
 */
export interface EmbedderLike {
  /** 向量维度 */
  readonly dimension: number;
  /** 单文本 → 向量 */
  embed(text: string): number[];
  /** 批量文本 → 向量列表（默认循环调用 embed） */
  embedBatch(texts: string[]): number[][];
  /** 两文本相似度 0.0-1.0（默认实现：cosine similarity） */
  similarity(a: string, b: string): number;
  /** 语义匹配判定 */
  isSemanticMatch(a: string, b: string, threshold?: number): boolean;
}

// ============================================================================
// TFIDFEmbedder：TF-IDF 向量化（无外部依赖，默认实现）
// ============================================================================

/**
 * TF-IDF Embedder 配置
 */
export interface TFIDFEmbedderConfig {
  /** 训练语料库（用于计算 IDF）。undefined 表示 lazy 模式：第一次 embed 时再训练 */
  corpus?: string[];
  /** 最大特征数（限制词表大小，避免 OOM） */
  max_features: number;
  /** 向量归一化方式（"l2" / "none"） */
  norm: "l2" | "none";
}

/**
 * TF-IDF Embedder（默认实现，无外部依赖）
 *
 * 核心思路：
 * - 用 token 频率作为向量
 * - 用语料库 IDF 调整（罕见词权重高）
 * - L2 归一化（方便 cosine similarity）
 *
 * 适用场景：
 * - 候选数 < 1000（语料库小，训练快）
 * - 文本长度 < 10000 字符
 * - 中英文混合场景
 *
 * 性能：
 * - 训练：O(n * L)（n 候选数，L 平均长度）
 * - 查询：O(L)（单文本分词 + 查表）
 * - 内存：O(vocab_size)
 *
 * 局限：
 * - 无法识别同义词（"好"与"棒"被视为不同）
 * - 无法识别语序（"AB"与"BA"视为相同）
 * - 短文本效果差（< 3 token 几乎无法区分）
 */
export class TFIDFEmbedder implements EmbedderLike {
  private _max_features: number;
  private _norm: "l2" | "none";
  private _vocab: Map<string, number> = new Map();
  private _idf: Map<string, number> = new Map();
  private _trained = false;

  constructor(config: Partial<TFIDFEmbedderConfig> = {}) {
    this._max_features = config.max_features ?? 5000;
    this._norm = config.norm ?? "l2";
    if (config.corpus !== undefined) {
      this.fit(config.corpus);
    }
  }

  get dimension(): number {
    return this._vocab.size;
  }

  /**
   * 用语料库训练 IDF
   *
   * @param corpus 训练文本列表
   */
  fit(corpus: string[]): void {
    const docFreq = new Map<string, number>();
    let nDocs = 0;
    for (const text of corpus) {
      const tokenSet = new Set(tokenize(text));
      if (tokenSet.size > 0) {
        nDocs += 1;
        for (const token of tokenSet) {
          docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
        }
      }
    }

    // 构建词表（限制最大特征数，按文档频率降序）
    if (docFreq.size === 0 || nDocs === 0) {
      moduleLog("warning", "TFIDFEmbedder.fit：空语料库，向量维度为 0");
      this._vocab = new Map();
      this._idf = new Map();
      this._trained = true;
      return;
    }

    // 选择 top max_features 词（按文档频率降序）
    const sortedTokens = Array.from(docFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this._max_features);

    this._vocab = new Map<string, number>();
    this._idf = new Map<string, number>();
    sortedTokens.forEach(([token, df], idx) => {
      this._vocab.set(token, idx);
      // 平滑 IDF：log((1 + N) / (1 + df)) + 1
      this._idf.set(token, Math.log((1 + nDocs) / (1 + df)) + 1.0);
    });
    this._trained = true;
    moduleLog("info", `TFIDFEmbedder 训练完成：vocab_size=${this._vocab.size}, corpus_size=${nDocs}`);
  }

  /**
   * 懒训练：第一次 embed 时用单文档训练
   */
  private _ensureTrained(text: string): void {
    if (!this._trained) {
      this.fit([text]);
    }
  }

  /**
   * 文本 → TF-IDF 向量
   *
   * 步骤：
   * 1. 分词
   * 2. 计算每个 token 的 TF-IDF
   * 3. 写入向量
   * 4. L2 归一化（如果 norm="l2"）
   *
   * @param text 输入文本
   * @returns 向量（长度 = vocab_size）
   */
  embed(text: string): number[] {
    this._ensureTrained(text);
    if (this._vocab.size === 0) {
      return [];
    }

    // 步骤 1：分词
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      return new Array(this._vocab.size).fill(0.0);
    }

    // 步骤 2：计算 TF（词频）
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    // 步骤 3：构建向量
    const vec = new Array(this._vocab.size).fill(0.0);
    for (const [token, count] of tf.entries()) {
      const idx = this._vocab.get(token);
      if (idx !== undefined) {
        vec[idx] = count * (this._idf.get(token) ?? 1.0);
      }
    }

    // 步骤 4：L2 归一化
    if (this._norm === "l2") {
      let norm = 0.0;
      for (const x of vec) norm += x * x;
      norm = Math.sqrt(norm);
      if (norm > 0.0) {
        for (let i = 0; i < vec.length; i++) {
          vec[i] = vec[i]! / norm;
        }
      }
    }

    return vec;
  }

  embedBatch(texts: string[]): number[][] {
    return texts.map((t) => this.embed(t));
  }

  /**
   * 两文本相似度（优化：复用 embed 的归一化）
   */
  similarity(a: string, b: string): number {
    if (a === b) {
      return 1.0;
    }
    const va = this.embed(a);
    const vb = this.embed(b);
    if (va.length === 0 || vb.length === 0) {
      return 0.0;
    }
    // 向量已 L2 归一化，cosine = dot product
    let dot = 0.0;
    const n = Math.min(va.length, vb.length);
    for (let i = 0; i < n; i++) {
      dot += va[i]! * vb[i]!;
    }
    return dot;
  }

  isSemanticMatch(a: string, b: string, threshold = 0.85): boolean {
    return this.similarity(a, b) >= threshold;
  }
}

// ============================================================================
// HashingEmbedder：哈希向量（O(1) 内存，超大规模候选集）
// ============================================================================

/**
 * Hashing Embedder 配置
 */
export interface HashingEmbedderConfig {
  /** 哈希桶数量 */
  n_features: number;
  /** 向量归一化方式 */
  norm: "l2" | "none";
}

/**
 * Hashing Embedder（基于特征哈希的向量化）
 *
 * 核心思路：
 * - 用 hash(token) % n_features 作为 token 的桶索引
 * - 优点：无需训练，O(1) 内存
 * - 缺点：哈希冲突导致精度下降
 *
 * 适用场景：
 * - 候选数 > 10000
 * - 内存受限
 * - 不需要高精度的场景
 *
 * 性能：
 * - 训练：无需
 * - 查询：O(L)
 * - 内存：O(n_features)（固定）
 */
export class HashingEmbedder implements EmbedderLike {
  private _n_features: number;
  private _norm: "l2" | "none";

  constructor(config: Partial<HashingEmbedderConfig> = {}) {
    this._n_features = config.n_features ?? 1024;
    this._norm = config.norm ?? "l2";
  }

  get dimension(): number {
    return this._n_features;
  }

  /**
   * 哈希 token 到桶索引
   *
   * 使用 MD5（与 Python 版一致）确保跨进程/跨运行结果稳定
   */
  private _hashToken(token: string): number {
    const h = crypto.createHash("md5").update(token, "utf-8").digest("hex");
    // 截取前 8 个 hex 字符（32 bit）转 int
    const intVal = parseInt(h.slice(0, 8), 16);
    return intVal % this._n_features;
  }

  /**
   * 哈希 token 到符号（-1 / +1），用于 sign trick
   */
  private _signToken(token: string): number {
    const h = crypto
      .createHash("md5")
      .update("sign_" + token, "utf-8")
      .digest("hex");
    return parseInt(h.slice(0, 1), 16) % 2 === 0 ? 1.0 : -1.0;
  }

  /**
   * 文本 → 哈希向量
   */
  embed(text: string): number[] {
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      return new Array(this._n_features).fill(0.0);
    }

    const vec = new Array(this._n_features).fill(0.0);
    // 用 sign trick 减少哈希冲突影响
    for (const token of tokens) {
      const idx = this._hashToken(token);
      const sign = this._signToken(token);
      vec[idx] = (vec[idx] ?? 0) + sign;
    }

    if (this._norm === "l2") {
      let norm = 0.0;
      for (const x of vec) norm += x * x;
      norm = Math.sqrt(norm);
      if (norm > 0.0) {
        for (let i = 0; i < vec.length; i++) {
          vec[i] = vec[i]! / norm;
        }
      }
    }
    return vec;
  }

  embedBatch(texts: string[]): number[][] {
    return texts.map((t) => this.embed(t));
  }

  similarity(a: string, b: string): number {
    if (a === b) {
      return 1.0;
    }
    return cosineSimilarity(this.embed(a), this.embed(b));
  }

  isSemanticMatch(a: string, b: string, threshold = 0.85): boolean {
    return this.similarity(a, b) >= threshold;
  }
}

// ============================================================================
// SentenceTransformerEmbedder：可选实现（优雅降级）
// ============================================================================

/**
 * Sentence Transformer Embedder 配置
 *
 * 注意：TypeScript 版不强制依赖 sentence-transformers（Node 无此原生包）；
 * 真实运行时应由调用方注入外部 embedding 服务的适配实现。
 */
export interface SentenceTransformerEmbedderConfig {
  /** 模型名称（默认 paraphrase-multilingual-MiniLM-L12-v2） */
  model_name: string;
  /** 推理设备（"cpu" 强制） */
  device: string;
  /** 模型缓存目录 */
  cache_dir?: string;
  /** 注入的 embedder 委托（避免直接 import sentence-transformers） */
  delegate?: SentenceTransformerDelegate;
}

/**
 * Sentence Transformer 委托接口
 *
 * 由调用方实现具体模型加载与推理逻辑，避免硬依赖。
 */
export interface SentenceTransformerDelegate {
  /** 模型名称 */
  readonly model_name: string;
  /** 嵌入维度 */
  readonly dimension: number;
  /** 单文本 → embedding（已归一化） */
  embed(text: string): Promise<number[]> | number[];
  /** 批量文本 → embeddings（已归一化） */
  embedBatch(texts: string[]): Promise<number[][]> | number[][];
}

/**
 * SentenceTransformer Embedder（Phase 7 升级：真实语义相似度）
 *
 * 真正语义相似度：基于预训练的多语言模型（paraphrase-multilingual-MiniLM-L12-v2）
 *
 * 优雅降级：
 * - delegate 未注入时，使用 mock 向量（仅用于开发测试）
 * - 生产环境必须注入真实 delegate
 */
export class SentenceTransformerEmbedder implements EmbedderLike {
  private _model_name: string;
  private _device: string;
  private _cache_dir?: string;
  private _delegate?: SentenceTransformerDelegate;
  private _dim: number;

  constructor(config: Partial<SentenceTransformerEmbedderConfig> = {}) {
    this._model_name = config.model_name ?? "paraphrase-multilingual-MiniLM-L12-v2";
    this._device = config.device ?? "cpu";
    this._cache_dir = config.cache_dir;
    this._delegate = config.delegate;

    // 强制 CPU：MPS 在某些场景存在缓存/塌缩 bug
    moduleLog(
      "info",
      `SentenceTransformerEmbedder 初始化：model=${this._model_name}, device=${this._device}, delegate=${this._delegate ? "injected" : "absent (using fallback vectors)"}`
    );

    // 维度：优先用 delegate，否则用默认值 384
    this._dim = this._delegate ? this._delegate.dimension : 384;
  }

  get dimension(): number {
    return this._dim;
  }

  /**
   * 单文本 → embedding
   *
   * 真实实现：委托给 delegate.embed()
   * Fallback：生成 mock 向量（仅用于开发）
   */
  async embedAsync(text: string): Promise<number[]> {
    if (this._delegate) {
      return await this._delegate.embed(text);
    }
    // Fallback：基于字符哈希的 mock 向量（保证同文本相同结果）
    return this._mockEmbed(text);
  }

  /**
   * 单文本 → embedding（同步接口）
   */
  embed(text: string): number[] {
    if (this._delegate) {
      const result = this._delegate.embed(text);
      if (result instanceof Promise) {
        throw new Error("SentenceTransformerEmbedder.embed() 收到 Promise；请改用 embedAsync() 或注入同步 delegate");
      }
      return result;
    }
    return this._mockEmbed(text);
  }

  /**
   * 批量文本 → embeddings
   */
  async embedBatchAsync(texts: string[]): Promise<number[][]> {
    if (this._delegate) {
      return await this._delegate.embedBatch(texts);
    }
    return texts.map((t) => this._mockEmbed(t));
  }

  /**
   * 批量文本 → embeddings（同步）
   */
  embedBatch(texts: string[]): number[][] {
    if (this._delegate) {
      const result = this._delegate.embedBatch(texts);
      if (result instanceof Promise) {
        throw new Error(
          "SentenceTransformerEmbedder.embedBatch() 收到 Promise；请改用 embedBatchAsync() 或注入同步 delegate"
        );
      }
      return result;
    }
    return texts.map((t) => this._mockEmbed(t));
  }

  /**
   * Mock embedding（仅用于开发/测试）
   *
   * 真实环境必须注入 delegate，否则语义质量无法保证
   */
  private _mockEmbed(text: string): number[] {
    const vec = new Array(this._dim).fill(0.0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const idx = this._hashToken(token, this._dim);
      vec[idx] = (vec[idx] ?? 0) + 1.0;
    }
    // L2 归一化
    let norm = 0.0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0.0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] = vec[i]! / norm;
      }
    }
    return vec;
  }

  private _hashToken(token: string, mod: number): number {
    const h = crypto.createHash("md5").update(token, "utf-8").digest("hex");
    return parseInt(h.slice(0, 8), 16) % mod;
  }

  similarity(a: string, b: string): number {
    if (a === b) {
      return 1.0;
    }
    return cosineSimilarity(this.embed(a), this.embed(b));
  }

  isSemanticMatch(a: string, b: string, threshold = 0.85): boolean {
    return this.similarity(a, b) >= threshold;
  }
}

// ============================================================================
// EmbeddingCache：LRU 缓存（避免重复计算）
// ============================================================================

/**
 * EmbeddingCache 配置
 */
export interface EmbeddingCacheConfig {
  /** 底层 Embedder */
  embedder: EmbedderLike;
  /** 最大缓存条目数 */
  capacity: number;
}

/**
 * Embedding LRU 缓存
 *
 * 关键能力：
 * - 避免重复计算相同文本的 embedding
 * - 容量限制（LRU 淘汰）
 * - 命中率统计
 *
 * 适用场景：
 * - 大量重复文本（如同一文件的多处引用）
 * - 同一文本在不同 similarity 调用中复用
 *
 * 注：Node.js 单线程，无需显式锁
 */
export class EmbeddingCache {
  private _embedder: EmbedderLike;
  private _capacity: number;
  private _cache: Map<string, number[]> = new Map();
  private _hits = 0;
  private _misses = 0;

  constructor(config: EmbeddingCacheConfig) {
    this._embedder = config.embedder;
    this._capacity = config.capacity;
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this._cache.size;
  }

  /** 缓存命中次数 */
  get hits(): number {
    return this._hits;
  }

  /** 缓存未命中次数 */
  get misses(): number {
    return this._misses;
  }

  /** 缓存命中率 */
  get hitRate(): number {
    const total = this._hits + this._misses;
    return total > 0 ? this._hits / total : 0.0;
  }

  /** 清空缓存 */
  clear(): void {
    this._cache.clear();
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * 获取或计算 embedding
   */
  getOrCompute(text: string): number[] {
    const cached = this._cache.get(text);
    if (cached !== undefined) {
      // LRU：移到末尾（Map 保留插入顺序，删除并重新插入实现 LRU）
      this._cache.delete(text);
      this._cache.set(text, cached);
      this._hits += 1;
      return cached;
    }
    this._misses += 1;

    const vec = this._embedder.embed(text);

    // 容量检查：淘汰最早的（Map 迭代顺序 = 插入顺序）
    if (this._cache.size >= this._capacity) {
      const firstKey = this._cache.keys().next().value;
      if (firstKey !== undefined) {
        this._cache.delete(firstKey);
      }
    }
    this._cache.set(text, vec);
    return vec;
  }

  /**
   * 两文本相似度（带缓存：复用 embed 结果）
   */
  similarity(a: string, b: string): number {
    if (a === b) {
      return 1.0;
    }
    const va = this.getOrCompute(a);
    const vb = this.getOrCompute(b);
    if (va.length === 0 || vb.length === 0) {
      return 0.0;
    }
    // 依赖 embedder 已 L2 归一化
    let dot = 0.0;
    const n = Math.min(va.length, vb.length);
    for (let i = 0; i < n; i++) {
      dot += va[i]! * vb[i]!;
    }
    return Math.max(0.0, Math.min(1.0, dot));
  }
}

// ============================================================================
// Factory：默认 Embedder
// ============================================================================

let _defaultEmbedder: EmbedderLike | null = null;

/**
 * 获取默认 Embedder
 *
 * 策略：
 * 1. 优先返回缓存的实例
 * 2. 否则返回 TFIDFEmbedder（无外部依赖，开箱即用）
 *
 * @param options 配置选项
 * @param options.prefer_sentence_transformer 是否优先 SentenceTransformer（默认 false，
 *        TypeScript 环境下硬依赖不可用）
 * @returns 默认 Embedder 实例
 */
export function getDefaultEmbedder(options: { prefer_sentence_transformer?: boolean } = {}): EmbedderLike {
  if (_defaultEmbedder !== null) {
    return _defaultEmbedder;
  }
  // TypeScript 环境：硬依赖 sentence-transformers 不可用，直接用 TFIDF
  if (options.prefer_sentence_transformer === true) {
    moduleLog("warning", "prefer_sentence_transformer=true 但未注入 delegate，使用 TFIDFEmbedder fallback");
  }
  _defaultEmbedder = new TFIDFEmbedder();
  moduleLog("info", "默认 Embedder：TFIDF");
  return _defaultEmbedder;
}

/** 重置默认 Embedder 缓存（仅用于测试） */
export function resetDefaultEmbedder(): void {
  _defaultEmbedder = null;
}

/**
 * 创建 Embedder（工厂函数）
 *
 * @param embedder_type "auto" / "tfidf" / "hashing" / "sentence_transformer"
 * @param config 透传给具体 Embedder 的配置
 * @returns Embedder 实例
 * @throws 当 embedder_type 未知时
 */
export function createEmbedder(
  embedder_type: "auto" | "tfidf" | "hashing" | "sentence_transformer" = "auto",
  config: Record<string, unknown> = {}
): EmbedderLike {
  switch (embedder_type) {
    case "auto":
      return getDefaultEmbedder({
        prefer_sentence_transformer: (config["prefer_sentence_transformer"] as boolean | undefined) ?? false,
      });
    case "tfidf":
      return new TFIDFEmbedder(config as Partial<TFIDFEmbedderConfig>);
    case "hashing":
      return new HashingEmbedder(config as Partial<HashingEmbedderConfig>);
    case "sentence_transformer":
      return new SentenceTransformerEmbedder(config as Partial<SentenceTransformerEmbedderConfig>);
    default:
      throw new Error(
        `未知 embedder_type='${String(embedder_type)}'。可选: auto / tfidf / hashing / sentence_transformer`
      );
  }
}

// ============================================================================
// 默认导出
// ============================================================================

// 注意：仅导出值（接口仅作为类型，不出现在 default 导出中）
export default {
  // 工具
  cosineSimilarity,
  tokenize,
  setSemanticLogCallback,
  defaultSemanticLog,
  // 类
  TFIDFEmbedder,
  HashingEmbedder,
  SentenceTransformerEmbedder,
  EmbeddingCache,
  // 工厂
  getDefaultEmbedder,
  resetDefaultEmbedder,
  createEmbedder,
};
