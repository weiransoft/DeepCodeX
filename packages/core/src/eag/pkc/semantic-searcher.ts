/**
 * 语义检索器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `SemanticSearcher` 类，提供 EAG 方案 §5.11.1 L2 语义检索层的
 * 混合检索逻辑：FTS5 BM25 全文检索 + 语义向量 RRF 融合 + 查询形态感知
 * kind boosting + focusPoints 上下文 1.5x 加权。
 *
 * 核心职责：
 * - search(query, opts)：执行混合检索，返回排序后的 SearchResult[]
 * - BM25 评分：基于倒排索引计算 BM25 分数（模拟 FTS5 行为）
 * - 向量余弦相似度：基于嵌入器计算查询向量与符号向量的余弦相似度
 * - RRF 融合：BM25 排名与向量排名按 RRF(k=60) 公式融合
 * - kind boosting：查询形态感知（PascalCase→Class 1.5x 等）
 * - focusPoints 加权：命中焦点符号获 1.5x 加权
 *
 * §5.11.6 V2-P4 设计要求：
 * - FTS5 BM25 全文检索（主通路）
 * - 语义向量 RRF 融合（k=60）
 * - 查询形态感知 kind boosting（PascalCase→Class 1.5x 等）
 * - focusPoints 上下文 1.5x 加权
 *
 * 设计依据：
 * - EAG 方案 §5.11.1 L2 语义检索层
 * - §5.11.6 V2-P4 CodeMap 符号级知识图谱增强
 * - BM25 算法（Robertson 1994，Okapi BM25）
 * - RRF 算法（Cormack et al. 2009，Reciprocal Rank Fusion）
 *
 * 实现说明：
 * - 不依赖 better-sqlite3 等原生模块，纯 TypeScript 实现 BM25
 * - 嵌入器（Embedder）可选；未注入时仅用 BM25（功能完整，不报错）
 * - 内部维护倒排索引（term → symbolId 列表）+ 符号 ID 映射
 *
 * 不可变优先：
 * - 内部状态使用 readonly 修饰
 * - 公开方法返回冻结对象
 *
 * @module eag/pkc/semantic-searcher
 */

import type { Embedder } from "./symbol-indexer";
import type { IndexedSymbol, SearchOptions, SearchResult, SymbolKind } from "./l2-types";
import { DEFAULT_KIND_BOOST, DEFAULT_RRF_K, DEFAULT_TOP_K, FOCUS_POINT_BOOST } from "./l2-types";

// ============================================================================
// BM25 算法参数
// ============================================================================

/**
 * BM25 算法参数 k1（项频率饱和参数，1.2 ≤ k1 ≤ 2.0 常用值）
 *
 * k1 控制项频率（TF）对评分的影响：k1 越大，TF 影响越显著。
 * 此处取 1.5（Okapi BM25 推荐值）。
 *
 * 使用 Object.freeze 冻结。
 */
const BM25_K1: number = Object.freeze(1.5) as number;

/**
 * BM25 算法参数 b（文档长度归一化参数，0 ≤ b ≤ 1）
 *
 * b 控制文档长度对评分的影响：b=0 不考虑长度，b=1 完全归一化。
 * 此处取 0.75（Okapi BM25 推荐值）。
 *
 * 使用 Object.freeze 冻结。
 */
const BM25_B: number = Object.freeze(0.75) as number;

// ============================================================================
// 查询形态识别规则
// ============================================================================

/**
 * 查询形态（用于 kind boosting 路由）
 *
 * - pascal-case：PascalCase（首字母大写，如 UserService、OrderController）
 * - camel-case：camelCase（首字母小写，如 getUserById、login）
 * - snake-case：snake_case（含下划线，如 get_user_by_id）
 * - default：无法识别形态（不加权）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
type QueryForm = "pascal-case" | "camel-case" | "snake-case" | "default";

/**
 * 查询形态 → kind boosting 系数表
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——查询形态感知 kind boosting：
 * - PascalCase 查询（如 `UserService`）→ Class 1.5x、Interface 1.4x、Type 1.3x
 * - camelCase 查询（如 `getUserById`）→ Function 1.3x、Method 1.4x
 * - snake_case 查询（如 `get_user_by_id`）→ Function 1.2x、Method 1.2x
 * - default：全部 1.0x（不加权）
 *
 * 使用 Object.freeze 冻结。
 */
const QUERY_FORM_BOOST: Readonly<Record<QueryForm, Readonly<Record<SymbolKind, number>>>> = Object.freeze({
  "pascal-case": Object.freeze({
    class: 1.5,
    function: 1.0,
    method: 1.0,
    interface: 1.4,
    variable: 1.0,
    enum: 1.2,
    "type-alias": 1.3,
    property: 1.0,
  }),
  "camel-case": Object.freeze({
    class: 1.0,
    function: 1.3,
    method: 1.4,
    interface: 1.0,
    variable: 1.1,
    enum: 1.0,
    "type-alias": 1.0,
    property: 1.1,
  }),
  "snake-case": Object.freeze({
    class: 1.0,
    function: 1.2,
    method: 1.2,
    interface: 1.0,
    variable: 1.0,
    enum: 1.0,
    "type-alias": 1.0,
    property: 1.0,
  }),
  default: Object.freeze({ ...DEFAULT_KIND_BOOST }),
});

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 语义检索器错误（参数非法时抛出）
 */
export class SemanticSearcherError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-query：查询字符串非法
   *   - embedder-failed：嵌入器调用失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-query" | "embedder-failed",
    public readonly detail: string
  ) {
    super(`语义检索器错误 [${kind}]：${detail}`);
    this.name = "SemanticSearcherError";
  }
}

// ============================================================================
// 内部辅助类型：BM25 倒排索引
// ============================================================================

/**
 * 倒排索引条目（term → 文档频率 + 文档列表）
 */
interface InvertedIndexEntry {
  /** 文档频率（DF，含此 term 的文档数） */
  readonly documentFrequency: number;
  /** 文档 → 项频率（TF）映射 */
  readonly postings: ReadonlyMap<string, number>;
}

// ============================================================================
// SemanticSearcher 类
// ============================================================================

/**
 * 语义检索器（实现 §5.11.1 L2 语义检索层的混合检索）
 *
 * 提供真实检索逻辑（禁止 mock）：
 * - search：执行 BM25 + 向量 RRF 融合检索
 * - setIndex：注入已索引的符号列表（来自 SymbolIndexer.getAllSymbols）
 * - addSymbol：增量添加单个符号到检索索引
 * - removeSymbol：从检索索引移除单个符号
 *
 * 检索流程：
 * 1. 入参校验（query 非空字符串）
 * 2. 词法分析：将 query 分词为 term 列表（按空格 + 驼峰切分）
 * 3. BM25 通路：对每个 term 查倒排索引，累加 BM25 分数，按分数降序排名
 * 4. 向量通路（可选）：若启用向量且有嵌入器，计算 query 向量与每个符号向量的余弦相似度，按相似度降序排名
 * 5. RRF 融合：BM25 排名 + 向量排名按 RRF(k=60) 公式融合
 * 6. kind boosting：根据查询形态（PascalCase/camelCase/snake_case）加权
 * 7. focusPoints 加权：命中焦点符号获 1.5x 加权
 * 8. 归一化分数到 0~1，按综合分数降序排序
 * 9. 取 topK 条返回
 *
 * 降级策略：
 * - 无嵌入器：仅用 BM25，matchedBy="bm25"
 * - 有嵌入器但符号无 embedding：仅用 BM25，matchedBy="bm25"
 * - 嵌入器调用失败：仅用 BM25，不报错
 *
 * 使用方式：
 * ```typescript
 * const searcher = new SemanticSearcher(embedder);
 * searcher.setIndex(indexer.getAllSymbols());
 * const results = await searcher.search("用户登录", { topK: 5 });
 * ```
 */
export class SemanticSearcher {
  /**
   * 可选嵌入器（用于向量通路）
   *
   * 未注入时仅用 BM25。
   */
  private readonly embedder?: Embedder;

  /**
   * 符号 ID → IndexedSymbol 映射（核心符号存储）
   */
  private readonly symbolById: Map<string, IndexedSymbol> = new Map();

  /**
   * 倒排索引（term → InvertedIndexEntry）
   *
   * 用于 BM25 评分：term → (DF + (symbolId → TF))。
   */
  private readonly invertedIndex: Map<string, InvertedIndexEntry> = new Map();

  /**
   * 符号 ID → 文档长度（term 总数）映射
   *
   * 用于 BM25 长度归一化。
   */
  private readonly documentLengths: Map<string, number> = new Map();

  /**
   * 文档平均长度（term 总数 / 文档数），用于 BM25 长度归一化
   */
  private averageDocumentLength: number = 0;

  /**
   * @param embedder 可选嵌入器（无嵌入器时仅用 BM25）
   */
  constructor(embedder?: Embedder) {
    this.embedder = embedder;
  }

  /**
   * 注入已索引的符号列表（替换现有索引）
   *
   * @param symbols 符号列表（来自 SymbolIndexer.getAllSymbols）
   */
  setIndex(symbols: ReadonlyArray<IndexedSymbol>): void {
    // 重置索引
    this.symbolById.clear();
    this.invertedIndex.clear();
    this.documentLengths.clear();
    this.averageDocumentLength = 0;

    // 逐个添加
    for (const sym of symbols) {
      this.addSymbol(sym);
    }

    // 计算平均文档长度
    this.recomputeAverageDocumentLength();
  }

  /**
   * 添加单个符号到检索索引
   *
   * @param symbol 待添加的符号
   */
  addSymbol(symbol: IndexedSymbol): void {
    // 避免重复添加（同 symbolId 替换）
    if (this.symbolById.has(symbol.symbolId)) {
      this.removeSymbol(symbol.symbolId);
    }

    // 构建文档文本（name + signature + summary）
    const docText = `${symbol.name} ${symbol.signature} ${symbol.summary}`;
    const terms = this.tokenize(docText);

    // 写入符号存储
    this.symbolById.set(symbol.symbolId, symbol);

    // 写入文档长度
    this.documentLengths.set(symbol.symbolId, terms.length);

    // 写入倒排索引：对每个 term 增加 TF
    const termFrequencies = new Map<string, number>();
    for (const term of terms) {
      termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
    }

    for (const [term, tf] of termFrequencies.entries()) {
      const existing = this.invertedIndex.get(term);
      if (existing) {
        // 已有 term：扩展 postings
        const newPostings = new Map(existing.postings);
        newPostings.set(symbol.symbolId, tf);
        // 注：DF 已包含新符号（postings 数量增加即可），此处重新计算
        this.invertedIndex.set(term, {
          documentFrequency: newPostings.size,
          postings: newPostings,
        });
      } else {
        // 新 term：创建条目
        const postings = new Map<string, number>();
        postings.set(symbol.symbolId, tf);
        this.invertedIndex.set(term, {
          documentFrequency: 1,
          postings,
        });
      }
    }

    // 重新计算平均文档长度
    this.recomputeAverageDocumentLength();
  }

  /**
   * 从检索索引移除单个符号
   *
   * @param symbolId 符号 ID
   */
  removeSymbol(symbolId: string): void {
    const symbol = this.symbolById.get(symbolId);
    if (!symbol) {
      return;
    }

    // 从倒排索引移除
    const docText = `${symbol.name} ${symbol.signature} ${symbol.summary}`;
    const terms = this.tokenize(docText);
    const termSet = new Set(terms);

    for (const term of termSet) {
      const entry = this.invertedIndex.get(term);
      if (!entry) continue;
      const newPostings = new Map(entry.postings);
      newPostings.delete(symbolId);
      if (newPostings.size === 0) {
        // 无文档含此 term：移除条目
        this.invertedIndex.delete(term);
      } else {
        this.invertedIndex.set(term, {
          documentFrequency: newPostings.size,
          postings: newPostings,
        });
      }
    }

    // 从符号存储与文档长度移除
    this.symbolById.delete(symbolId);
    this.documentLengths.delete(symbolId);

    // 重新计算平均文档长度
    this.recomputeAverageDocumentLength();
  }

  /**
   * 执行混合检索
   *
   * 检索流程详见类注释。
   *
   * @param query 查询字符串（自然语言或代码片段）
   * @param opts 检索选项（topK / focusPoints / kindBoost / enableVector / rrfK）
   * @returns 排序后的检索结果列表（最多 topK 条）
   * @throws {SemanticSearcherError} query 非法时抛出
   */
  async search(query: string, opts?: SearchOptions): Promise<ReadonlyArray<SearchResult>> {
    // 入参校验
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new SemanticSearcherError("invalid-query", "查询字符串必须为非空字符串");
    }

    // 解析选项
    const topK = opts?.topK ?? DEFAULT_TOP_K;
    const focusPoints = opts?.focusPoints ? new Set(opts.focusPoints) : new Set<string>();
    const enableVector = opts?.enableVector ?? true;
    const rrfK = opts?.rrfK ?? DEFAULT_RRF_K;

    // 查询形态识别 → kind boosting 系数表
    const queryForm = this.detectQueryForm(query);
    const kindBoost = opts?.kindBoost ?? QUERY_FORM_BOOST[queryForm];

    // ==========================
    // BM25 通路
    // ==========================
    const queryTerms = this.tokenize(query);
    const bm25Scores = this.computeBM25Scores(queryTerms);
    // 按分数降序排名
    const bm25Ranked = [...bm25Scores.entries()].sort((a, b) => b[1] - a[1]);
    const bm25RankMap = new Map<string, number>();
    bm25Ranked.forEach(([id], idx) => {
      bm25RankMap.set(id, idx + 1); // 排名从 1 开始
    });

    // ==========================
    // 向量通路（可选）
    // ==========================
    let vectorRankMap: Map<string, number> | null = null;
    if (enableVector && this.embedder) {
      try {
        const queryEmbedding = await this.embedder.embed(query);
        const vectorScores = this.computeVectorScores(queryEmbedding);
        if (vectorScores.size > 0) {
          const vectorRanked = [...vectorScores.entries()].sort((a, b) => b[1] - a[1]);
          vectorRankMap = new Map<string, number>();
          vectorRanked.forEach(([id], idx) => {
            vectorRankMap!.set(id, idx + 1);
          });
        }
      } catch {
        // 嵌入器调用失败：仅用 BM25，不报错
        vectorRankMap = null;
      }
    }

    // ==========================
    // RRF 融合
    // ==========================
    const rrfScores = this.computeRRFFusion(bm25RankMap, vectorRankMap, rrfK);

    // ==========================
    // 应用 kind boosting + focusPoints 加权
    // ==========================
    const finalScores = new Map<string, number>();
    for (const [symbolId, rrfScore] of rrfScores.entries()) {
      const symbol = this.symbolById.get(symbolId);
      if (!symbol) continue;
      const kindBoostFactor = kindBoost[symbol.kind] ?? 1.0;
      const focusBoostFactor = focusPoints.has(symbolId) ? FOCUS_POINT_BOOST : 1.0;
      finalScores.set(symbolId, rrfScore * kindBoostFactor * focusBoostFactor);
    }

    // ==========================
    // 归一化分数到 0~1 + 排序 + 取 topK
    // ==========================
    const maxScore = Math.max(...finalScores.values(), 1e-9);
    const ranked = [...finalScores.entries()]
      .map(([symbolId, score]) => {
        const symbol = this.symbolById.get(symbolId)!;
        const normalizedScore = score / maxScore;
        const matchedBy = this.determineMatchedBy(symbolId, bm25RankMap, vectorRankMap);
        const snippet = this.buildSnippet(symbol);
        return Object.freeze({
          symbol: Object.freeze({ ...symbol }),
          score: normalizedScore,
          matchedBy,
          snippet,
        }) as SearchResult;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return Object.freeze(ranked);
  }

  /**
   * 返回当前索引的符号数量
   *
   * @returns 符号数量
   */
  getIndexSize(): number {
    return this.symbolById.size;
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 重新计算平均文档长度
   */
  private recomputeAverageDocumentLength(): void {
    if (this.documentLengths.size === 0) {
      this.averageDocumentLength = 0;
      return;
    }
    let total = 0;
    for (const len of this.documentLengths.values()) {
      total += len;
    }
    this.averageDocumentLength = total / this.documentLengths.size;
  }

  /**
   * 词法分析：将文本分词为 term 列表
   *
   * 分词规则：
   * 1. 按非字母数字字符切分（空格、标点、下划线）
   * 2. 驼峰切分（camelCase → camel + Case）
   * 3. 全部转小写
   * 4. 过滤空串与停用词（a/the/of/in 等单字符 term）
   *
   * @param text 待分词文本
   * @returns term 列表（小写）
   */
  private tokenize(text: string): string[] {
    // 1. 按非字母数字字符切分
    const rawTokens = text.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0);

    // 2. 驼峰切分（camelCase / PascalCase）
    const splitTokens: string[] = [];
    for (const token of rawTokens) {
      // 在小写→大写边界切分（如 getUserById → get, User, By, Id）
      const subTokens = token
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(" ")
        .filter((t) => t.length > 0);
      splitTokens.push(...subTokens);
    }

    // 3. 全部转小写
    const lowerTokens = splitTokens.map((t) => t.toLowerCase());

    // 4. 过滤空串与单字符（保留 2 字符及以上的 term）
    return lowerTokens.filter((t) => t.length >= 2);
  }

  /**
   * 计算 BM25 分数
   *
   * BM25 公式（Okapi BM25）：
   *   score(q, d) = Σ IDF(qi) * (TF(qi, d) * (k1 + 1)) / (TF(qi, d) + k1 * (1 - b + b * |d| / avgdl))
   * 其中 IDF(qi) = log((N - DF(qi) + 0.5) / (DF(qi) + 0.5) + 1)
   *
   * @param queryTerms 查询 term 列表
   * @returns symbolId → BM25 分数映射
   */
  private computeBM25Scores(queryTerms: ReadonlyArray<string>): Map<string, number> {
    const scores = new Map<string, number>();
    const N = this.symbolById.size;
    if (N === 0) {
      return scores;
    }

    // 去重查询 term（避免同一 term 多次累加）
    const uniqueQueryTerms = [...new Set(queryTerms)];

    for (const term of uniqueQueryTerms) {
      const entry = this.invertedIndex.get(term);
      if (!entry) continue;

      // IDF
      const df = entry.documentFrequency;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      // 对每个含此 term 的文档累加 BM25 分数
      for (const [symbolId, tf] of entry.postings.entries()) {
        const docLength = this.documentLengths.get(symbolId) ?? 0;
        const avgdl = this.averageDocumentLength || 1;
        // BM25 TF 饱和项
        const tfNormalized = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgdl)));
        const contribution = idf * tfNormalized;
        scores.set(symbolId, (scores.get(symbolId) ?? 0) + contribution);
      }
    }

    return scores;
  }

  /**
   * 计算向量余弦相似度分数
   *
   * 余弦相似度：cosine(q, d) = (q · d) / (|q| * |d|)
   *
   * @param queryEmbedding 查询向量
   * @returns symbolId → 余弦相似度映射
   */
  private computeVectorScores(queryEmbedding: ReadonlyArray<number>): Map<string, number> {
    const scores = new Map<string, number>();
    const queryNorm = this.vectorNorm(queryEmbedding);
    if (queryNorm === 0) {
      return scores;
    }

    for (const [symbolId, symbol] of this.symbolById.entries()) {
      if (!symbol.embedding || symbol.embedding.length === 0) {
        continue;
      }
      const symbolNorm = this.vectorNorm(symbol.embedding);
      if (symbolNorm === 0) {
        continue;
      }
      // 点积
      const dotProduct = this.dotProduct(queryEmbedding, symbol.embedding);
      const cosine = dotProduct / (queryNorm * symbolNorm);
      scores.set(symbolId, cosine);
    }

    return scores;
  }

  /**
   * RRF 融合（Reciprocal Rank Fusion）
   *
   * RRF 公式：score(d) = Σ 1/(k + rank_i(d))
   * 其中 k 为融合常数（默认 60），rank_i(d) 为文档 d 在第 i 个排名列表中的名次
   *
   * @param bm25RankMap BM25 排名（symbolId → rank，rank 从 1 开始）
   * @param vectorRankMap 向量排名（symbolId → rank，rank 从 1 开始；可为 null）
   * @param k RRF 常数 k
   * @returns symbolId → RRF 融合分数映射
   */
  private computeRRFFusion(
    bm25RankMap: Map<string, number>,
    vectorRankMap: Map<string, number> | null,
    k: number
  ): Map<string, number> {
    const rrfScores = new Map<string, number>();

    // 收集所有 symbolId（两路并集）
    const allSymbolIds = new Set<string>();
    for (const id of bm25RankMap.keys()) {
      allSymbolIds.add(id);
    }
    if (vectorRankMap) {
      for (const id of vectorRankMap.keys()) {
        allSymbolIds.add(id);
      }
    }

    // 计算每个 symbolId 的 RRF 分数
    for (const symbolId of allSymbolIds) {
      let score = 0;
      const bm25Rank = bm25RankMap.get(symbolId);
      if (bm25Rank !== undefined) {
        score += 1 / (k + bm25Rank);
      }
      if (vectorRankMap) {
        const vectorRank = vectorRankMap.get(symbolId);
        if (vectorRank !== undefined) {
          score += 1 / (k + vectorRank);
        }
      }
      rrfScores.set(symbolId, score);
    }

    return rrfScores;
  }

  /**
   * 判定检索命中来源
   *
   * @param symbolId 符号 ID
   * @param bm25RankMap BM25 排名
   * @param vectorRankMap 向量排名
   * @returns "bm25" / "vector" / "both"
   */
  private determineMatchedBy(
    symbolId: string,
    bm25RankMap: Map<string, number>,
    vectorRankMap: Map<string, number> | null
  ): "bm25" | "vector" | "both" {
    const inBm25 = bm25RankMap.has(symbolId);
    const inVector = vectorRankMap ? vectorRankMap.has(symbolId) : false;
    if (inBm25 && inVector) {
      return "both";
    }
    if (inBm25) {
      return "bm25";
    }
    return "vector";
  }

  /**
   * 构建命中片段（取符号签名作为片段）
   *
   * @param symbol 符号
   * @returns 命中片段字符串
   */
  private buildSnippet(symbol: IndexedSymbol): string {
    // 优先返回签名（含路径与行号）
    return `${symbol.filePath}:${symbol.startLine} ${symbol.signature}`;
  }

  /**
   * 识别查询形态（PascalCase / camelCase / snake_case / default）
   *
   * 识别规则：
   * - 仅含字母数字 + 下划线，且含下划线 → snake-case
   * - 首字母大写，无下划线，无空格 → pascal-case
   * - 首字母小写，无下划线，无空格，含大写字母 → camel-case
   * - 其他（含空格、中文、特殊字符等） → default
   *
   * @param query 查询字符串
   * @returns 查询形态
   */
  private detectQueryForm(query: string): QueryForm {
    const trimmed = query.trim();

    // 含空格 → default
    if (/\s/.test(trimmed)) {
      return "default";
    }

    // 含中文等非 ASCII → default
    if (/[^\x00-\x7F]/.test(trimmed)) {
      return "default";
    }

    // 仅一个 token（无空格）
    // 含下划线 → snake-case
    if (/^[a-z][a-z0-9_]*_[a-z0-9_]+$/i.test(trimmed) && trimmed.includes("_")) {
      return "snake-case";
    }

    // PascalCase：首字母大写，无下划线
    if (/^[A-Z][a-zA-Z0-9]+$/.test(trimmed)) {
      return "pascal-case";
    }

    // camelCase：首字母小写，无下划线，含大写字母
    if (/^[a-z][a-zA-Z0-9]+$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
      return "camel-case";
    }

    // 其他（如全小写、全大写、含数字、含特殊字符）→ default
    return "default";
  }

  /**
   * 计算向量点积
   *
   * @param a 向量 a
   * @param b 向量 b
   * @returns 点积
   */
  private dotProduct(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  /**
   * 计算向量 L2 范数
   *
   * @param v 向量
   * @returns L2 范数
   */
  private vectorNorm(v: ReadonlyArray<number>): number {
    let sum = 0;
    for (const x of v) {
      sum += x * x;
    }
    return Math.sqrt(sum);
  }
}
