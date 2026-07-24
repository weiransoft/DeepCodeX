/**
 * 经验存储实现（v2.0 实现，对齐设计文档 §12.3 / §14.1）
 *
 * 本模块实现 ExperienceStoreProtocol，提供 Layer 3 经验自进化的存储与召回能力。
 *
 * 核心功能：
 * 1. storeCase：写入新案例（图执行完成后调用，积累经验）
 * 2. recallSimilar：查询相似案例（NodeLoopKernel Discovery 阶段调用，辅助决策）
 *
 * 相似度算法（对齐 §14.1）：
 * - 离散特征（string/boolean）：加权 Jaccard 相似度 = |交集| / |并集|
 * - 连续特征（number）：归一化欧氏距离 → 相似度 = 1 / (1 + distance)
 * - 总相似度 = discreteWeight × discreteSimilarity + continuousWeight × continuousSimilarity
 *   其中 discreteWeight / continuousWeight 按特征数量比例分配
 *
 * 召回策略（对齐 §14.1 召回策略）：
 * 1. 从内存加载所有案例（上限 1000 条，FIFO 淘汰）
 * 2. 计算查询任务与每个案例的相似度
 * 3. 按相似度降序排序，取前 K 个（默认 K=5）
 * 4. 相似度阈值过滤（默认 0.5，低于此值不召回）
 *
 * 存储策略：
 * - 内存存储（Map<caseId, ExperienceCase>），进程结束后不持久化
 * - FIFO 淘汰：超过 maxCases 时删除最早写入的案例
 * - 线程安全：单线程 Node.js 事件循环，无需锁
 *
 * @module eag/graph/experience-store
 */

import type {
  /** 经验案例 */
  ExperienceCase,
  /** 图日志记录器接口 */
  GraphLogger,
} from "./graph-loop-models";
import type { ExperienceStoreProtocol } from "./graph-loop-protocols";

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认最大案例存储数量（对齐 §14.1 召回策略：上限 1000 条，FIFO 淘汰）
 */
const DEFAULT_MAX_CASES = 1000;

/**
 * 默认召回数量上限（对齐 §14.1 召回策略：取前 K 个，默认 K=5）
 */
const DEFAULT_RECALL_LIMIT = 5;

/**
 * 默认相似度阈值（对齐 §14.1 召回策略：低于 0.5 不召回）
 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/**
 * 离散特征相似度权重（对齐 §14.1：总相似度 = 0.6 × 离散 + 0.4 × 连续）
 *
 * 注意：当只有离散特征或只有连续特征时，按特征数量比例自动调整权重。
 */
const DISCRETE_WEIGHT_RATIO = 0.6;
const CONTINUOUS_WEIGHT_RATIO = 0.4;

// ============================================================================
// 相似度计算函数（对齐 §14.1）
// ============================================================================

/**
 * 计算任务特征相似度（对齐 §14.1）
 *
 * 算法：
 * 1. 将 taskFeatures 分为离散特征（string/boolean）和连续特征（number）
 * 2. 离散特征：加权 Jaccard 相似度 = |交集| / |并集|（权重由 featureWeights 配置）
 * 3. 连续特征：归一化欧氏距离 → 转换为相似度 = 1 / (1 + distance)
 * 4. 总相似度 = discreteWeight × discreteSimilarity + continuousWeight × continuousSimilarity
 *    其中 discreteWeight / continuousWeight 按特征数量比例分配
 *
 * @param queryFeatures 查询任务特征
 * @param caseFeatures 案例任务特征
 * @param featureWeights 特征权重（可选，默认等权）
 * @returns 相似度 [0, 1]
 */
export function computeSimilarity(
  queryFeatures: Readonly<Record<string, unknown>>,
  caseFeatures: Readonly<Record<string, unknown>>,
  featureWeights?: Readonly<Record<string, number>>
): number {
  // 1. 分离离散和连续特征
  // 离散特征：string / boolean / undefined / null
  // 连续特征：number
  const discreteKeys: string[] = [];
  const continuousKeys: string[] = [];
  const allKeys = new Set([...Object.keys(queryFeatures), ...Object.keys(caseFeatures)]);
  for (const key of allKeys) {
    const queryVal = queryFeatures[key];
    if (typeof queryVal === "number") {
      continuousKeys.push(key);
    } else {
      discreteKeys.push(key);
    }
  }

  // 2. 离散特征：加权 Jaccard 相似度
  // Jaccard = |交集| / |并集|，加权版本：交集权重和 / 并集权重和
  let discreteSimilarity = 0;
  if (discreteKeys.length > 0) {
    let intersectionWeight = 0;
    let unionWeight = 0;
    for (const key of discreteKeys) {
      const weight = featureWeights?.[key] ?? 1;
      unionWeight += weight;
      // 离散特征值相等则计入交集
      if (queryFeatures[key] === caseFeatures[key]) {
        intersectionWeight += weight;
      }
    }
    discreteSimilarity = unionWeight > 0 ? intersectionWeight / unionWeight : 0;
  }

  // 3. 连续特征：归一化欧氏距离 → 转换为相似度
  // distance = sqrt(Σ(queryVal - caseVal)²)
  // similarity = 1 / (1 + distance)（值域 [0, 1]，distance=0 时 similarity=1）
  let continuousSimilarity = 0;
  if (continuousKeys.length > 0) {
    let sumSquaredDiff = 0;
    for (const key of continuousKeys) {
      const queryVal = Number(queryFeatures[key] ?? 0);
      const caseVal = Number(caseFeatures[key] ?? 0);
      sumSquaredDiff += Math.pow(queryVal - caseVal, 2);
    }
    const distance = Math.sqrt(sumSquaredDiff);
    continuousSimilarity = 1 / (1 + distance);
  }

  // 4. 加权融合
  // 按特征数量比例分配权重（对齐 §14.1 算法第 4 步）
  const totalKeys = discreteKeys.length + continuousKeys.length;
  if (totalKeys === 0) {
    return 0;
  }

  // 当两种特征都存在时，使用 0.6/0.4 权重比例
  // 当只有一种特征时，该特征权重为 1.0
  if (discreteKeys.length > 0 && continuousKeys.length > 0) {
    return DISCRETE_WEIGHT_RATIO * discreteSimilarity + CONTINUOUS_WEIGHT_RATIO * continuousSimilarity;
  } else if (discreteKeys.length > 0) {
    return discreteSimilarity;
  } else {
    return continuousSimilarity;
  }
}

// ============================================================================
// ExperienceStoreImpl 实现类
// ============================================================================

/**
 * 经验存储实现类
 *
 * 实现 ExperienceStoreProtocol，提供基于内存的案例存储与相似度召回。
 *
 * 存储策略：
 * - 内存 Map 存储（caseId → ExperienceCase），进程结束后不持久化
 * - FIFO 淘汰：超过 maxCases 时删除最早写入的案例
 * - 案例写入时自动生成 caseId 和 createdAt
 *
 * 召回策略（对齐 §14.1）：
 * - 遍历所有案例，计算相似度
 * - 按相似度降序排序
 * - 过滤低于阈值（默认 0.5）的案例
 * - 取前 K 个（默认 K=5）
 *
 * 使用示例：
 * ```typescript
 * const store = new ExperienceStoreImpl({ maxCases: 500 }, logger);
 *
 * // 写入案例
 * await store.storeCase({
 *   caseId: "",
 *   taskType: "coding",
 *   taskFeatures: { language: "typescript", complexity: "high" },
 *   strategy: "loop-with-strict-evaluator",
 *   success: true,
 *   executionTimeSec: 120.5,
 *   createdAt: "",
 * });
 *
 * // 召回相似案例
 * const similar = await store.recallSimilar(
 *   { language: "typescript", complexity: "high" },
 *   5
 * );
 * ```
 */
export class ExperienceStoreImpl implements ExperienceStoreProtocol {
  /** 案例存储（按 caseId 索引，保持插入顺序） */
  private readonly cases: Map<string, ExperienceCase>;
  /** 最大案例存储数量（FIFO 淘汰） */
  private readonly maxCases: number;
  /** 默认相似度阈值（低于此值不召回） */
  private readonly similarityThreshold: number;
  /** 特征权重配置（可选，用于相似度计算） */
  private readonly featureWeights?: Readonly<Record<string, number>>;
  /** 日志记录器 */
  private readonly logger: GraphLogger;
  /** 案例写入顺序追踪（用于 FIFO 淘汰，记录 caseId 的插入顺序） */
  private readonly insertionOrder: string[];

  /**
   * 构造经验存储
   *
   * @param options 构造选项（可选）
   * @param logger 日志记录器（可选，默认使用 console）
   */
  constructor(
    options?: {
      /** 最大案例存储数量（默认 1000） */
      maxCases?: number;
      /** 相似度阈值（默认 0.5） */
      similarityThreshold?: number;
      /** 特征权重配置（可选） */
      featureWeights?: Readonly<Record<string, number>>;
    },
    logger?: GraphLogger
  ) {
    this.cases = new Map();
    this.maxCases = options?.maxCases ?? DEFAULT_MAX_CASES;
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.featureWeights = options?.featureWeights;
    this.logger = logger ?? createConsoleLogger();
    this.insertionOrder = [];
  }

  /**
   * 查询相似案例（用于经验召回）
   *
   * 召回流程（对齐 §14.1 召回策略）：
   * 1. 遍历所有案例，计算查询特征与每个案例的相似度
   * 2. 过滤低于相似度阈值的案例
   * 3. 按相似度降序排序
   * 4. 取前 limit 个案例
   *
   * @param taskFeatures 当前任务特征（键值对形式）
   * @param limit 返回案例数上限（按相似度降序取前 N 个）
   * @returns 相似案例列表（按相似度降序，最相似的在前）
   */
  async recallSimilar(
    taskFeatures: Readonly<Record<string, unknown>>,
    limit: number
  ): Promise<ReadonlyArray<ExperienceCase>> {
    if (this.cases.size === 0) {
      this.logger.debug(`[ExperienceStore] 案例库为空，返回空列表`);
      return [];
    }

    // 实际取数量上限（不超过 limit 和默认上限）
    const actualLimit = Math.min(limit > 0 ? limit : DEFAULT_RECALL_LIMIT, DEFAULT_RECALL_LIMIT);

    // 1. 计算每个案例的相似度
    const scoredCases: Array<{ caseData: ExperienceCase; similarity: number }> = [];
    for (const caseData of this.cases.values()) {
      const similarity = computeSimilarity(taskFeatures, caseData.taskFeatures, this.featureWeights);
      // 2. 过滤低于阈值的案例
      if (similarity >= this.similarityThreshold) {
        scoredCases.push({ caseData, similarity });
      }
    }

    // 3. 按相似度降序排序
    scoredCases.sort((a, b) => b.similarity - a.similarity);

    // 4. 取前 limit 个
    const result = scoredCases.slice(0, actualLimit).map((item) => item.caseData);

    this.logger.info(
      `[ExperienceStore] 召回完成：查询 ${this.cases.size} 个案例，通过阈值 ${this.similarityThreshold} 的 ${scoredCases.length} 个，返回前 ${result.length} 个`
    );

    return result;
  }

  /**
   * 写入新案例（用于经验积累）
   *
   * 写入流程：
   * 1. 生成 caseId 和 createdAt（若未提供）
   * 2. 存入 cases Map
   * 3. 如果超过 maxCases，按 FIFO 淘汰最早写入的案例
   *
   * @param caseData 执行案例（caseId 和 createdAt 可为空，自动生成）
   */
  async storeCase(caseData: Readonly<ExperienceCase>): Promise<void> {
    // 生成 caseId 和 createdAt（若未提供）
    const caseId = caseData.caseId || generateCaseId();
    const createdAt = caseData.createdAt || new Date().toISOString();

    const fullCase: ExperienceCase = {
      ...caseData,
      caseId,
      createdAt,
    };

    // 存入 Map
    this.cases.set(caseId, fullCase);
    this.insertionOrder.push(caseId);

    // FIFO 淘汰：超过 maxCases 时删除最早写入的案例
    while (this.insertionOrder.length > this.maxCases) {
      const oldestId = this.insertionOrder.shift();
      if (oldestId) {
        this.cases.delete(oldestId);
        this.logger.debug(`[ExperienceStore] FIFO 淘汰案例：${oldestId}`);
      }
    }

    this.logger.info(
      `[ExperienceStore] 写入案例：${caseId}（taskType=${fullCase.taskType}, success=${fullCase.success}），当前案例库大小：${this.cases.size}`
    );
  }

  /**
   * 获取当前案例库大小
   *
   * @returns 案例数量
   */
  size(): number {
    return this.cases.size;
  }

  /**
   * 获取所有案例（用于测试和调试）
   *
   * @returns 案例列表（按插入顺序）
   */
  getAllCases(): ReadonlyArray<ExperienceCase> {
    return Array.from(this.cases.values());
  }

  /**
   * 清空案例库
   */
  clear(): void {
    this.cases.clear();
    this.insertionOrder.length = 0;
    this.logger.info(`[ExperienceStore] 案例库已清空`);
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建经验存储实例（工厂函数）
 *
 * @param options 构造选项（可选）
 * @param logger 日志记录器（可选）
 * @returns 新的 ExperienceStoreProtocol 实例
 */
export function createExperienceStore(
  options?: {
    maxCases?: number;
    similarityThreshold?: number;
    featureWeights?: Readonly<Record<string, number>>;
  },
  logger?: GraphLogger
): ExperienceStoreProtocol {
  return new ExperienceStoreImpl(options, logger);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建基于 console 的默认日志记录器
 *
 * @returns GraphLogger 实例
 */
function createConsoleLogger(): GraphLogger {
  return {
    debug: (message, context) => console.debug(message, context ?? ""),
    info: (message, context) => console.info(message, context ?? ""),
    warn: (message, context) => console.warn(message, context ?? ""),
    error: (message, context) => console.error(message, context ?? ""),
  };
}

/**
 * 生成案例 ID（UUID v4 简化版）
 *
 * @returns 案例 ID 字符串
 */
function generateCaseId(): string {
  return `case-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
