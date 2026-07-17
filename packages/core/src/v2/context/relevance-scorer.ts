/**
 * 相关性评分器（RelevanceScorer）—— F-FOCUS-02 依赖模块
 *
 * 基于 CodeMap 距离 + 任务关键词匹配 + 时间衰减，对候选文件进行相关性评分。
 * 评分结果供 SlidingWindowManager 取 Top-K 相关文件。
 *
 * 评分公式：
 *   totalScore = codeMapDistanceWeight * distanceScore
 *              + keywordMatchWeight * keywordScore
 *              + timeDecayWeight * timeDecayScore
 *
 * 三维评分算法（技术方案 §6.4 P2-02 伪代码实现）：
 *
 * 1. CodeMap 距离评分（scoreCodeMapDistance）：
 *    - 源点集：taskContext.workingMemory.focusPoints 中 type="file" 的 ref
 *    - 候选文件本身是源点 → 1.0（直达）
 *    - 候选不在 codeMap.files 中 → 0.1（图未含）
 *    - 多源 BFS（反向索引 + 正向邻接双向遍历），跳数 >3 剪枝
 *    - 距离分映射表：d=0→1.0, d=1→0.7, d=2→0.4, d=3→0.1, 不可达→0.05
 *
 * 2. 关键词匹配评分（scoreKeywordMatch）：
 *    - V2-P1 采用 Jaccard 相似度（token 交集/并集比例）
 *    - 分词复用 semantic-embedder.ts 的 tokenize 函数（零新依赖）
 *    - 选择理由：Jaccard 无需训练、score/scoreBatch 结果一致、性能 O(tokens)；
 *      TF-IDF 需要语料库训练，单文档评分时 IDF 退化为 1（无区分度），
 *      留 V2-P2 经验 RAG 检索场景（F-MEM-04，批量检索时 IDF 有意义）
 *    - 文本来源：任务描述（taskDefinition.description）+ 候选文件路径
 *      （V2-P2 可扩展为文件内容，需 CodeMap 提供 symbols）
 *
 * 3. 时间衰减评分（scoreTimeDecay）：
 *    - score = 0.5 ^ (elapsedMs / halfLifeMs)
 *    - elapsedMs = now - lastAccessedAt
 *    - lastAccessedAt：focusPoints 中该文件的 addedAt（最近访问）；
 *      文件不在 focusPoints 中时用 taskState.startedAt（任务开始时统一衰减）
 *
 * 设计依据：
 * - V2 技术方案 §6.4 RelevanceScorer 接口契约 + P2-02 BFS 伪代码
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.6（P1 裁剪：零新依赖）
 * - 距离分映射表（§6.4 唯一事实源）：d=0→1.0 / d=1→0.7 / d=2→0.4 / d=3→0.1 / 不可达→0.05 / 图未含→0.1
 *
 * @module v2/context/relevance-scorer
 */

import type { TaskContext } from "./types";
import type { CodeMap } from "../codemap/generator";
// P1-05 单一入口约束：V2 模块禁止直接 import V1 文件，tokenize 经 v1-adapters re-export
import { tokenize } from "../integration/v1-adapters";

// ============================================================================
// 类型定义（与 V2_P1_IMPLEMENTATION_PLAN.md §3.6 完全对齐）
// ============================================================================

/** 相关性评分配置 */
export interface RelevanceScoringConfig {
  /** CodeMap 距离权重（默认 0.4） */
  codeMapDistanceWeight: number;
  /** 关键词匹配权重（默认 0.4） */
  keywordMatchWeight: number;
  /** 时间衰减权重（默认 0.2） */
  timeDecayWeight: number;
  /** 时间衰减半衰期（毫秒，默认 30 分钟） */
  timeDecayHalfLifeMs: number;
}

/** 单个候选文件的评分输入 */
export interface RelevanceScoreInput {
  /** 候选文件路径（相对项目根的 POSIX 路径） */
  filePath: string;
  /** 当前任务上下文（focusPoints 为距离计算源点集） */
  taskContext: TaskContext;
  /** CodeMap（含 dependencyGraph） */
  codeMap: CodeMap;
  /** 当前时间（ISO 8601 字符串） */
  now: string;
}

/** 单个候选文件的评分结果 */
export interface RelevanceScore {
  /** 候选文件路径 */
  filePath: string;
  /** 总评分（0-1，加权求和） */
  totalScore: number;
  /** CodeMap 距离评分（0-1） */
  codeMapDistanceScore: number;
  /** 关键词匹配评分（0-1） */
  keywordMatchScore: number;
  /** 时间衰减评分（0-1） */
  timeDecayScore: number;
  /** 中文评分理由（审计/调试用） */
  reason: string;
}

// ============================================================================
// 常量定义
// ============================================================================

/** 默认评分配置 */
const DEFAULT_CONFIG: RelevanceScoringConfig = {
  codeMapDistanceWeight: 0.4,
  keywordMatchWeight: 0.4,
  timeDecayWeight: 0.2,
  timeDecayHalfLifeMs: 30 * 60 * 1000, // 30 分钟
};

/**
 * 距离分映射表（§6.4 唯一事实源）
 *
 * d=0 直达 1.0 / d=1 一跳 0.7 / d=2 两跳 0.4 / d=3 三跳 0.1 / 不可达 0.05
 */
const DISTANCE_SCORE_TABLE: Record<number, number> = {
  0: 1.0,
  1: 0.7,
  2: 0.4,
  3: 0.1,
};

/** 不可达文件的距离分（在图中但 BFS 到不了） */
const UNREACHABLE_SCORE = 0.05;

/** 图未含文件的距离分（新文件/未扫描） */
const NOT_IN_GRAPH_SCORE = 0.1;

/** BFS 最大跳数（超过此跳数无评分意义，剪枝） */
const MAX_BFS_DEPTH = 3;

// ============================================================================
// RelevanceScorer 类
// ============================================================================

/**
 * 相关性评分器
 *
 * 用法：
 * ```typescript
 * const scorer = new RelevanceScorer({ codeMapDistanceWeight: 0.5 });
 * const score = scorer.score({
 *   filePath: "src/auth.ts",
 *   taskContext,
 *   codeMap,
 *   now: new Date().toISOString(),
 * });
 * console.log(score.totalScore, score.reason);
 * ```
 */
export class RelevanceScorer {
  private readonly config: RelevanceScoringConfig;

  /**
   * @param config 可选的配置覆盖（缺省字段使用 DEFAULT_CONFIG）
   */
  constructor(config?: Partial<RelevanceScoringConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 评分单个文件
   *
   * @param input 评分输入
   * @returns 评分结果
   */
  score(input: RelevanceScoreInput): RelevanceScore {
    const distanceScore = this.scoreCodeMapDistance(input.filePath, input.taskContext, input.codeMap);
    const keywordScore = this.scoreKeywordMatch(input.filePath, input.taskContext);
    const timeDecayScore = this.scoreTimeDecay(input.filePath, input.taskContext, input.now);

    const totalScore =
      this.config.codeMapDistanceWeight * distanceScore +
      this.config.keywordMatchWeight * keywordScore +
      this.config.timeDecayWeight * timeDecayScore;

    const reason =
      `距离=${distanceScore.toFixed(2)}(权重${this.config.codeMapDistanceWeight}) + ` +
      `关键词=${keywordScore.toFixed(2)}(权重${this.config.keywordMatchWeight}) + ` +
      `时间=${timeDecayScore.toFixed(2)}(权重${this.config.timeDecayWeight}) = ${totalScore.toFixed(3)}`;

    return {
      filePath: input.filePath,
      totalScore,
      codeMapDistanceScore: distanceScore,
      keywordMatchScore: keywordScore,
      timeDecayScore: timeDecayScore,
      reason,
    };
  }

  /**
   * 批量评分并排序，返回 Top-K
   *
   * @param inputs 候选文件列表
   * @param topK 返回 Top-K（默认全部返回，按 totalScore 降序）
   * @returns 按总评分降序排列的 Top-K 结果
   */
  scoreBatch(inputs: RelevanceScoreInput[], topK?: number): RelevanceScore[] {
    const scores = inputs.map((input) => this.score(input));
    // 按 totalScore 降序排序（评分高的在前）
    scores.sort((a, b) => b.totalScore - a.totalScore);
    // 截取 Top-K
    if (topK !== undefined && topK >= 0) {
      return scores.slice(0, topK);
    }
    return scores;
  }

  // ========================================================================
  // 私有评分方法
  // ========================================================================

  /**
   * CodeMap 距离评分
   *
   * 算法（§6.4 P2-02 伪代码实现）：
   * 1. 源点集提取：focusPoints 中 type="file" 的 ref
   * 2. 候选文件本身是源点 → 1.0（直达）
   * 3. 候选不在 codeMap.files 中 → 0.1（图未含）
   * 4. 多源 BFS（反向索引 + 正向邻接双向遍历），跳数 >3 剪枝
   * 5. 距离分映射表：d=0→1.0, d=1→0.7, d=2→0.4, d=3→0.1, 不可达→0.05
   *
   * @param filePath 候选文件路径
   * @param taskContext 任务上下文（含 focusPoints 源点集）
   * @param codeMap CodeMap（含 dependencyGraph）
   * @returns 距离评分（0-1）
   */
  private scoreCodeMapDistance(filePath: string, taskContext: TaskContext, codeMap: CodeMap): number {
    // ---------- 第一步：源点集提取 ----------
    const sources = taskContext.workingMemory.focusPoints.filter((p) => p.type === "file").map((p) => p.ref);

    // 候选文件本身是源点 → 直达 1.0
    if (sources.includes(filePath)) {
      return DISTANCE_SCORE_TABLE[0]; // 1.0
    }

    // 空源点集 → 无法计算距离，返回中性偏低分
    if (sources.length === 0) {
      return NOT_IN_GRAPH_SCORE;
    }

    // ---------- 第二步：构建邻接表 + 反向索引 ----------
    // 邻接表：file -> 直接 import 的 file[]
    // 反向索引：file -> 依赖它的 file[]
    const adjacency = new Map<string, Set<string>>();
    const reverseIndex = new Map<string, Set<string>>();
    const allNodes = new Set<string>();

    // 收集所有节点
    for (const file of codeMap.files) {
      allNodes.add(file.path);
      if (!adjacency.has(file.path)) adjacency.set(file.path, new Set());
      if (!reverseIndex.has(file.path)) reverseIndex.set(file.path, new Set());
      // file.dependencies 由 generator 解析 import 路径得出
      for (const dep of file.dependencies) {
        allNodes.add(dep);
        if (!adjacency.has(dep)) adjacency.set(dep, new Set());
        if (!reverseIndex.has(dep)) reverseIndex.set(dep, new Set());
        // 正向边：file -> dep
        adjacency.get(file.path)!.add(dep);
        // 反向边：dep -> file
        reverseIndex.get(dep)!.add(file.path);
      }
    }

    // ---------- 第三步：图存在性判定 ----------
    // 候选文件不在图中（新文件/未扫描）→ 0.1
    if (!allNodes.has(filePath)) {
      return NOT_IN_GRAPH_SCORE;
    }

    // ---------- 第四步：多源 BFS 求最短跳数 ----------
    // 从所有源点同时出发逐层扩散，d 即首次到达候选文件的层数
    const visited = new Set<string>(sources);
    // 队列元素：[节点, 跳数]
    const queue: Array<[string, number]> = sources.map((s) => [s, 0]);

    while (queue.length > 0) {
      const [node, d] = queue.shift()!;
      // 跳数 >3 无评分意义，剪枝
      if (d >= MAX_BFS_DEPTH) continue;

      // 双向遍历：正向邻接 + 反向索引（调用方与被调方都算相关）
      const neighbors: string[] = [];
      const forward = adjacency.get(node);
      if (forward) neighbors.push(...forward);
      const backward = reverseIndex.get(node);
      if (backward) neighbors.push(...backward);

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        if (neighbor === filePath) {
          // 首次到达即最短，d+1 为最短跳数
          const distance = d + 1;
          return DISTANCE_SCORE_TABLE[Math.min(distance, MAX_BFS_DEPTH)];
        }
        queue.push([neighbor, d + 1]);
      }
    }

    // ---------- 第五步：不可达 → 0.05 ----------
    return UNREACHABLE_SCORE;
  }

  /**
   * 关键词匹配评分（Jaccard 相似度）
   *
   * 算法：
   * 1. 任务描述分词：taskContext.taskDefinition.description → tokens
   * 2. 候选文件路径分词：filePath → tokens（路径分隔符 / . _ - 均为分隔符）
   * 3. Jaccard 相似度 = |交集| / |并集|
   *
   * 选择 Jaccard 而非 TF-IDF 的理由：
   * - Jaccard 无需训练，score/scoreBatch 结果一致
   * - TF-IDF 需要语料库训练，单文档评分时 IDF 退化为 1（无区分度）
   * - V2-P2 经验 RAG 检索场景（F-MEM-04）批量检索时 IDF 有意义，届时启用 TF-IDF
   * - 分词复用 semantic-embedder.ts 的 tokenize 函数（零新依赖）
   *
   * @param filePath 候选文件路径
   * @param taskContext 任务上下文（含 taskDefinition.description）
   * @returns 关键词匹配评分（0-1）
   */
  private scoreKeywordMatch(filePath: string, taskContext: TaskContext): number {
    const taskText = taskContext.taskDefinition.description;
    const taskTokens = new Set(tokenize(taskText));
    // 文件路径分词：路径分隔符 / . _ - 均为分隔符，复用 tokenize（已处理标点）
    const fileTokens = new Set(tokenize(filePath));

    // 空集 → 0 分
    if (taskTokens.size === 0 || fileTokens.size === 0) {
      return 0;
    }

    // Jaccard 相似度 = |交集| / |并集|
    let intersection = 0;
    for (const token of taskTokens) {
      if (fileTokens.has(token)) intersection++;
    }
    const union = taskTokens.size + fileTokens.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * 时间衰减评分
   *
   * 算法：score = 0.5 ^ (elapsedMs / halfLifeMs)
   * - elapsedMs = now - lastAccessedAt
   * - lastAccessedAt：focusPoints 中该文件的 addedAt（最近访问）；
   *   文件不在 focusPoints 中时用 taskState.startedAt（任务开始时统一衰减）
   *
   * @param filePath 候选文件路径
   * @param taskContext 任务上下文（含 focusPoints.addedAt 和 taskState.startedAt）
   * @param now 当前时间（ISO 8601 字符串）
   * @returns 时间衰减评分（0-1，越近访问越高）
   */
  private scoreTimeDecay(filePath: string, taskContext: TaskContext, now: string): number {
    // 查找该文件在 focusPoints 中的 addedAt（最近访问时间）
    const focusPoint = taskContext.workingMemory.focusPoints.find((p) => p.type === "file" && p.ref === filePath);
    const lastAccessedAt = focusPoint?.addedAt ?? taskContext.taskState.startedAt;

    const nowMs = new Date(now).getTime();
    const accessedMs = new Date(lastAccessedAt).getTime();
    const elapsedMs = nowMs - accessedMs;

    // 时间戳无效或未来时间 → 中性分 0.5
    if (isNaN(accessedMs) || isNaN(nowMs) || elapsedMs < 0) {
      return 0.5;
    }

    // score = 0.5 ^ (elapsedMs / halfLifeMs)
    return Math.pow(0.5, elapsedMs / this.config.timeDecayHalfLifeMs);
  }
}
