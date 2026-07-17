/**
 * 经验 RAG 推荐器（F-MEM-04）
 *
 * 使用 TF-IDF + 关键词 + 标签三路召回 + 综合排序，
 * 从 GlobalContext.historicalExperience 中检索与当前任务相关的历史经验。
 *
 * 关键技术点：
 *   1. 全部同步 API：与 GlobalContextManager 同步契约一致（P1-4 修复）
 *   2. 三路召回：任务类型匹配 + TF-IDF 语义相似 + 标签交集
 *   3. TF-IDF 相似度范围 0-1（cosine similarity 已 L2 归一化，P2-1 修复）
 *   4. relevance 计算总上限 1.0：
 *      - 任务类型匹配：+0.3
 *      - TF-IDF 相似度：×0.5（归一化到 0-0.5）
 *      - 标签交集比例：×0.2（归一化到 0-0.2）
 *   5. score = relevance * 0.6 + (importance/10) * 0.4（importance 归一化到 0-1）
 *   6. recordAccess 调用 GlobalContextManager.recordExperienceAccessBatch
 *      批量方法（P1-5 修复，一次 load+save 更新多条经验）
 *   7. tags 从 taskContext.workingMemory.focusPoints 提取 ref（P1-2 修复）
 *
 * 设计依据：
 * - V2 上下文记忆 PRD §US-MEM-004
 * - V2 技术方案 §8.4 经验 RAG 检索
 * - V2-P3 实施计划 §3.3（v1.1 修订落实 P1-2/P1-4/P1-5/P2-1）
 * - V2-P3 架构师审查报告 §2.2 P1-2/P1-4/P1-5 + §2.3 P2-1
 *
 * @module v2/memory/experience-recommender
 */

import type { GlobalContextManager } from "../context/global-context";
import type { SuccessExperience, FailureExperience } from "../context/global-context";
import type { TFIDFEmbedder } from "../integration/v1-adapters";
import { tokenize } from "../integration/v1-adapters";
import type { TaskContext } from "../context/types";

// ============================================================================
// 常量定义
// ============================================================================

/** 默认推荐数量 */
const DEFAULT_LIMIT = 5;

/** TF-IDF 语义相似召回阈值（similarity > 此值才召回） */
const SEMANTIC_SIMILARITY_THRESHOLD = 0.3;

/** relevance 计算权重：任务类型匹配 */
const RELEVANCE_TASK_TYPE_MATCH = 0.3;

/** relevance 计算权重：TF-IDF 相似度（× similarity，归一化到 0-0.5） */
const RELEVANCE_SEMANTIC_FACTOR = 0.5;

/** relevance 计算权重：标签交集比例（× intersectionRatio，归一化到 0-0.2） */
const RELEVANCE_TAG_FACTOR = 0.2;

/** score 计算权重：relevance */
const SCORE_RELEVANCE_WEIGHT = 0.6;

/** score 计算权重：importance（归一化到 0-1） */
const SCORE_IMPORTANCE_WEIGHT = 0.4;

/** importance 归一化分母（1-10 → 0.1-1.0） */
const IMPORTANCE_MAX = 10;

/**
 * V2-P3 ContextSnippet 类型常量（P1-1 修复）
 *
 * ContextSnippet.type 字段是自由 string，V2-P3 不修改类型定义，
 * 仅在此模块导出常量供 DualLayerContextManager 使用。
 */
export const CONTEXT_SNIPPET_TYPE = {
  /** 经验推荐片段 */
  EXPERIENCE_RECOMMENDATION: "experience_recommendation",
} as const;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 经验推荐结果
 *
 * 综合评分 score = relevance * 0.6 + (importance/10) * 0.4
 */
export interface ExperienceRecommendation {
  /** 经验条目（成功或失败） */
  experience: SuccessExperience | FailureExperience;
  /** 经验类型 */
  type: "success" | "failure";
  /** 相关性评分（0-1） */
  relevance: number;
  /** 重要性（1-10，从经验条目读取） */
  importance: number;
  /** 综合评分（0-1） */
  score: number;
  /** 推荐理由（自然语言） */
  reason: string;
}

/**
 * 任务特征
 *
 * 从 TaskContext 提取的检索特征，供 recall 和 rank 使用。
 */
export interface TaskFeatures {
  /** 任务类型（taskContext.taskDefinition.taskType） */
  taskType: string;
  /** 任务描述（taskContext.taskDefinition.description） */
  description: string;
  /** 关键词列表（从 description 分词，去重） */
  keywords: string[];
  /** 标签列表（从 taskContext.workingMemory.focusPoints 提取 ref，P1-2 修正） */
  tags: string[];
}

/**
 * recommend() 调用选项（P0-2 修复）
 *
 * V2-P3 集成 DualLayerContextManager 后，buildOptimizedContext 在每个 turn 入口
 * 预计算上下文时调用 recommend()，若每次都触发 recordAccess 写盘，会导致 accessCount
 * 异常膨胀（20 turn 会话会让同一条经验 accessCount+20），污染 LRU 淘汰信号。
 *
 * 解耦方案：buildOptimizedContext 调用时传 { recordAccess: false }，
 * recordAccess 应由"经验被真正采纳/引用"时触发（如任务归档、用户显式确认）。
 */
export interface RecommendOptions {
  /**
   * 是否在返回前批量更新命中经验的 accessCount（默认 true，保持向后兼容）。
   *
   * - true：调用 recordExperienceAccessBatch 写盘（适用于显式用户请求经验推荐场景）
   * - false：仅返回推荐结果，不写盘（适用于预计算路径如 buildOptimizedContext）
   */
  recordAccess?: boolean;
}

// ============================================================================
// ExperienceRecommender 类
// ============================================================================

/**
 * 经验 RAG 推荐器
 *
 * v1.1 修订（P1-4 修复）：所有方法改为同步，与 GlobalContextManager 同步 API 一致。
 * v1.1 修订（P1-2 修复）：extractTaskFeatures 的 tags 路径修正为
 *   taskContext.workingMemory.focusPoints（原误写为 TaskContext.focusPoints 顶层）。
 * v1.1 修订（P1-5 修复）：recordAccess 调用 GlobalContextManager.recordExperienceAccessBatch
 *   批量方法（一次 load + save 更新多条经验），替代循环调用单个 recordExperienceAccess。
 * v1.1 修订（P2-1 修复）：TF-IDF 相似度范围修正为 0-1（cosine similarity 已 L2 归一化）。
 *
 * 使用方式：
 * ```typescript
 * const globalManager = new GlobalContextManager();
 * const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
 * const recommender = new ExperienceRecommender(globalManager, embedder);
 * const recommendations = recommender.recommend(taskContext, 5);
 * ```
 */
export class ExperienceRecommender {
  /**
   * @param globalManager GlobalContext 管理器（读取历史经验 + 批量更新访问记录）
   * @param embedder TF-IDF 嵌入器（经 v1-adapters re-export）
   */
  constructor(
    private readonly globalManager: GlobalContextManager,
    private readonly embedder: TFIDFEmbedder
  ) {}

  /**
   * 推荐经验
   *
   * 实现步骤：
   *   1. extractTaskFeatures：从 TaskContext 提取任务特征
   *   2. recall：三路召回（任务类型匹配 + TF-IDF 语义相似 + 标签交集）
   *   3. rank：综合排序（relevance * 0.6 + importance/10 * 0.4）
   *   4. 取 Top-K（默认 K=5）
   *   5. recordAccess：批量更新命中经验的 accessCount（P1-5 修复，调用 recordExperienceAccessBatch）
   *      —— 仅当 options.recordAccess !== false 时执行（P0-2 修复）
   *
   * P0-2 修复（架构师审查）：新增 options.recordAccess 参数（默认 true 保持向后兼容）。
   * DualLayerContextManager.buildOptimizedContext 调用时传 { recordAccess: false }，
   * 避免预计算路径每个 turn 都触发 recordAccess 写盘导致 accessCount 异常膨胀。
   * recordAccess 应由"经验被真正采纳/引用"时触发（如任务归档、用户显式确认）。
   *
   * @param taskContext 当前任务上下文
   * @param limit 返回数量（默认 5）
   * @param options 调用选项（P0-2 新增，recordAccess 默认 true）
   * @returns 推荐列表（按 score 降序）
   */
  recommend(
    taskContext: TaskContext,
    limit: number = DEFAULT_LIMIT,
    options: RecommendOptions = {}
  ): ExperienceRecommendation[] {
    // 步骤 1：提取任务特征
    const features = this.extractTaskFeatures(taskContext);

    // 步骤 2：三路召回（同步，P1-4 修复）
    const recalled = this.recall("default", features);

    // 步骤 3：分别对成功/失败经验打分排序
    const successRecs = this.rank(recalled.success, features, "success");
    const failureRecs = this.rank(recalled.failure, features, "failure");

    // 合并 + 按 score 降序排序 + 取 Top-K
    const all = [...successRecs, ...failureRecs].sort((a, b) => b.score - a.score);
    const topK = all.slice(0, limit);

    // 步骤 5：批量更新命中经验的访问记录（P1-5 修复 + P0-2 修复）
    // P0-2：仅在 options.recordAccess !== false 时执行（默认 true 保持向后兼容）
    // 预计算路径（buildOptimizedContext）应传 { recordAccess: false } 避免污染 accessCount
    if (topK.length > 0 && options.recordAccess !== false) {
      this.recordAccess(
        "default",
        topK.map((r) => r.experience)
      );
    }

    return topK;
  }

  // ------------------------------------------------------------------------

  /**
   * 提取任务特征
   *
   * v1.1 修订（P1-2 修复）：tags 路径修正为 taskContext.workingMemory.focusPoints。
   *
   * - taskType：从 taskContext.taskDefinition.taskType 读取
   * - description：从 taskContext.taskDefinition.description 读取
   * - keywords：从 description 分词（去重，保留首次出现顺序）
   * - tags：从 taskContext.workingMemory.focusPoints 提取 ref 作为标签
   *         （仅取 type="concept" 或 type="function" 的 focusPoint.ref）
   *
   * @param taskContext 任务上下文
   * @returns 任务特征对象
   */
  private extractTaskFeatures(taskContext: TaskContext): TaskFeatures {
    const taskType = taskContext.taskDefinition.taskType || "";
    const description = taskContext.taskDefinition.description || "";

    // 关键词：从 description 分词，去重（保留首次出现顺序）
    const rawTokens = tokenize(description);
    const seen = new Set<string>();
    const keywords: string[] = [];
    for (const token of rawTokens) {
      if (!seen.has(token)) {
        seen.add(token);
        keywords.push(token);
      }
    }

    // 标签：从 taskContext.workingMemory.focusPoints 提取 ref（P1-2 修正）
    // 仅取 type="concept" 或 type="function" 的 focusPoint.ref
    const tags: string[] = [];
    for (const fp of taskContext.workingMemory.focusPoints) {
      if (fp.type === "concept" || fp.type === "function") {
        if (fp.ref && !tags.includes(fp.ref)) {
          tags.push(fp.ref);
        }
      }
    }

    return { taskType, description, keywords, tags };
  }

  /**
   * 三路召回
   *
   * 召回策略：
   *   - 任务类型完全匹配：召回该 taskType 的所有经验
   *   - TF-IDF 语义相似：description 与经验 description 相似度 > 0.3
   *   - 标签交集：经验 tags 与任务 tags 有交集
   *
   * 三路结果合并去重（按经验 ID）。
   *
   * v1.1 修订（P1-4 修复）：改为同步方法（GlobalContextManager.load 是同步的）。
   *
   * @param userId 用户 ID
   * @param features 任务特征
   * @returns 召回的成功/失败经验列表（已去重）
   */
  private recall(
    userId: string,
    features: TaskFeatures
  ): { success: SuccessExperience[]; failure: FailureExperience[] } {
    // 加载 GlobalContext（同步）
    const ctx = this.globalManager.load(userId);
    const successExps = ctx.historicalExperience.successExperiences;
    const failureExps = ctx.historicalExperience.failureExperiences;

    // 训练 embedder（以所有经验 description 为语料，提升相似度计算准确性）
    const allDescriptions: string[] = [features.description];
    for (const exp of successExps) {
      allDescriptions.push(exp.description);
    }
    for (const exp of failureExps) {
      allDescriptions.push(exp.description);
    }
    // 重新训练 embedder（覆盖可能的旧 vocab，确保包含所有经验的 token）
    this.embedder.fit(allDescriptions);

    // 三路召回成功经验
    const successSet = new Map<string, SuccessExperience>();
    for (const exp of successExps) {
      // 路径 1：任务类型完全匹配
      if (features.taskType && exp.taskType === features.taskType) {
        successSet.set(exp.id, exp);
        continue;
      }
      // 路径 2：TF-IDF 语义相似度 > 阈值
      const sim = this.embedder.similarity(features.description, exp.description);
      if (sim > SEMANTIC_SIMILARITY_THRESHOLD) {
        successSet.set(exp.id, exp);
        continue;
      }
      // 路径 3：标签交集
      if (features.tags.length > 0 && exp.tags.some((t) => features.tags.includes(t))) {
        successSet.set(exp.id, exp);
      }
    }

    // 三路召回失败经验（同上逻辑）
    const failureSet = new Map<string, FailureExperience>();
    for (const exp of failureExps) {
      if (features.taskType && exp.taskType === features.taskType) {
        failureSet.set(exp.id, exp);
        continue;
      }
      const sim = this.embedder.similarity(features.description, exp.description);
      if (sim > SEMANTIC_SIMILARITY_THRESHOLD) {
        failureSet.set(exp.id, exp);
        continue;
      }
      if (features.tags.length > 0 && exp.tags.some((t) => features.tags.includes(t))) {
        failureSet.set(exp.id, exp);
      }
    }

    return {
      success: Array.from(successSet.values()),
      failure: Array.from(failureSet.values()),
    };
  }

  /**
   * 排序（relevance * 0.6 + importance/10 * 0.4）
   *
   * v1.1 修订（P2-1 修复）：TF-IDF 相似度范围修正为 0-1。
   *
   * relevance 计算（总上限 1.0）：
   *   - 任务类型匹配：+0.3
   *   - TF-IDF 相似度：×0.5（归一化到 0-0.5，similarity 范围 0-1）
   *   - 标签交集比例：×0.2（归一化到 0-0.2）
   *
   * importance 直接从经验条目读取（1-10），归一化到 0-1（除以 10）。
   *
   * @param experiences 经验列表
   * @param features 任务特征
   * @param type 经验类型（success / failure）
   * @returns 推荐结果列表（按 score 降序）
   */
  private rank(
    experiences: Array<SuccessExperience | FailureExperience>,
    features: TaskFeatures,
    type: "success" | "failure"
  ): ExperienceRecommendation[] {
    const recommendations: ExperienceRecommendation[] = [];

    for (const exp of experiences) {
      // 计算 relevance（总上限 1.0）
      let relevance = 0;
      const reasons: string[] = [];

      // 任务类型匹配：+0.3
      if (features.taskType && exp.taskType === features.taskType) {
        relevance += RELEVANCE_TASK_TYPE_MATCH;
        reasons.push(`任务类型匹配（${exp.taskType}）`);
      }

      // TF-IDF 相似度：×0.5（归一化到 0-0.5）
      const sim = this.embedder.similarity(features.description, exp.description);
      relevance += sim * RELEVANCE_SEMANTIC_FACTOR;
      if (sim > SEMANTIC_SIMILARITY_THRESHOLD) {
        reasons.push(`语义相似（${sim.toFixed(2)}）`);
      }

      // 标签交集比例：×0.2（归一化到 0-0.2）
      if (features.tags.length > 0 && exp.tags.length > 0) {
        const intersection = exp.tags.filter((t) => features.tags.includes(t));
        const intersectionRatio = intersection.length / features.tags.length;
        relevance += intersectionRatio * RELEVANCE_TAG_FACTOR;
        if (intersection.length > 0) {
          reasons.push(`标签交集（${intersection.join(",")}）`);
        }
      }

      // relevance 上限 1.0
      relevance = Math.min(relevance, 1.0);

      // importance 归一化到 0-1
      const normalizedImportance = exp.importance / IMPORTANCE_MAX;

      // 综合评分
      const score = relevance * SCORE_RELEVANCE_WEIGHT + normalizedImportance * SCORE_IMPORTANCE_WEIGHT;

      recommendations.push({
        experience: exp,
        type,
        relevance,
        importance: exp.importance,
        score,
        reason: reasons.join("；") || "无明确匹配因素",
      });
    }

    // 按 score 降序排序
    recommendations.sort((a, b) => b.score - a.score);
    return recommendations;
  }

  /**
   * 批量更新命中经验的访问记录
   *
   * v1.1 修订（P1-5 修复）：调用 GlobalContextManager.recordExperienceAccessBatch
   * 批量方法（一次 load + save 更新多条经验），替代循环调用单个 recordExperienceAccess。
   *
   * @param userId 用户 ID
   * @param experiences 命中的经验列表
   */
  private recordAccess(userId: string, experiences: Array<SuccessExperience | FailureExperience>): void {
    const ids = experiences.map((e) => e.id);
    this.globalManager.recordExperienceAccessBatch(userId, ids);
  }
}
