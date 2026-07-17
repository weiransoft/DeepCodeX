/**
 * 滑动窗口管理器（SlidingWindowManager）—— F-FOCUS-02
 *
 * 基于 RelevanceScorer 评分，保留 Top-K 相关文件 + 最近 N 轮对话，
 * 超 Token 预算时从低分端截断。
 *
 * V2-P1 阶段实现范围（架构师审查简化建议）：
 * - 基础版：Top-K 相关文件 + 最近 N 轮对话 + Token 预算截断
 * - 无 ProgressiveContextLoader 三层加载（§6.6 完整版进 V2-P2）
 * - 无 LLM 摘要压缩：超预算片段直接丢弃（droppedCount 记录审计），
 *   压缩语义由 V2-P2 渐进加载接管
 *
 * 窗口构建算法（§3.7 契约）：
 * 1. 候选文件片段 → scorer.scoreBatch 取 Top-K（按 totalScore 降序）
 * 2. 对话片段保留最近 keepRecentTurns 轮（按时间顺序，最新的在前）
 * 3. 按 charsPerToken 估算累计 token，超预算从低分端截断
 *
 * Token 估算策略（零依赖，不引入 tokenizer）：
 * - 4 字符 ≈ 1 token（OpenAI 经验值，适用于中英文混合文本）
 * - 估算公式：tokenCount = Math.ceil(content.length / charsPerToken)
 *
 * 设计依据：
 * - V2 技术方案 §6.5 SlidingWindowManager 接口契约
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.7（P1 裁剪：基础版，无 ProgressiveContextLoader）
 * - V2 技术方案 §14.5 V2-P1 功能项 F-FOCUS-02（基础版：Top-K + 最近 N 轮）
 *
 * @module v2/context/sliding-window
 */

import type { TaskContext } from "./types";
import type { CodeMap } from "../codemap/generator";
import type { ContextSnippet } from "../integration/session-hook";
import type { RelevanceScorer } from "./relevance-scorer";
import type { RelevanceScore } from "./relevance-scorer";

// ============================================================================
// 类型定义（与 V2_P1_IMPLEMENTATION_PLAN.md §3.7 完全对齐）
// ============================================================================

/** 滑动窗口配置 */
export interface SlidingWindowConfig {
  /** Token 预算（窗口大小，默认由调用方传入） */
  tokenBudget: number;
  /** 保留最近对话轮数（默认 5） */
  keepRecentTurns: number;
  /** 相关文件 Top-K（默认 20） */
  topKFiles: number;
  /** 字符→token 估算系数（默认 4，即 4 字符 ≈ 1 token） */
  charsPerToken: number;
}

/** 滑动窗口构建结果 */
export interface SlidingWindowResult {
  /** 保留的上下文片段（按优先级排序：文件片段 + 对话片段） */
  retainedSnippets: ContextSnippet[];
  /** 被丢弃的片段数（超预算截断） */
  droppedCount: number;
  /** 保留的文件路径列表 */
  retainedFiles: string[];
  /** 保留的对话轮数 */
  retainedTurns: number;
  /** 估算 Token 数（保留片段的累计 token） */
  estimatedTokens: number;
  /** 压缩前 Token 数（全部候选片段的累计 token） */
  originalTokens: number;
  /** 压缩率（estimatedTokens / originalTokens，1.0 表示无压缩） */
  compressionRatio: number;
}

// ============================================================================
// 常量定义
// ============================================================================

/** 默认滑动窗口配置 */
const DEFAULT_CONFIG: SlidingWindowConfig = {
  tokenBudget: 100_000,
  keepRecentTurns: 5,
  topKFiles: 20,
  charsPerToken: 4,
};

// ============================================================================
// SlidingWindowManager 类
// ============================================================================

/**
 * 滑动窗口管理器（基础版）
 *
 * 用法：
 * ```typescript
 * const scorer = new RelevanceScorer();
 * const window = new SlidingWindowManager({ tokenBudget: 8000, topKFiles: 10 }, scorer);
 * const result = window.buildWindow(candidates, taskContext, codeMap, 8000);
 * console.log(`保留 ${result.retainedSnippets.length} 片段，丢弃 ${result.droppedCount} 片段`);
 * ```
 */
export class SlidingWindowManager {
  private readonly config: SlidingWindowConfig;
  private readonly scorer: RelevanceScorer;

  /**
   * @param config 可选的配置覆盖（缺省字段使用 DEFAULT_CONFIG）
   * @param scorer 相关性评分器（依赖注入）
   */
  constructor(config: Partial<SlidingWindowConfig>, scorer: RelevanceScorer) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scorer = scorer;
  }

  /**
   * 构建滑动窗口
   *
   * 算法步骤：
   * 1. 分离候选片段为文件片段 + 对话片段（按 type 字段区分）
   * 2. 文件片段 → scorer.scoreBatch 取 Top-K（按 totalScore 降序）
   * 3. 对话片段保留最近 keepRecentTurns 轮（按时间顺序，最新的在前）
   * 4. 合并保留片段（文件在前，对话在后）
   * 5. 按 charsPerToken 估算累计 token，超预算从低分端截断
   *
   * @param candidates 所有候选上下文片段（含文件片段和对话片段）
   * @param taskContext 当前任务上下文
   * @param codeMap CodeMap
   * @param maxTokens 最大 Token 数（覆盖 config.tokenBudget，可选）
   * @returns 滑动窗口构建结果
   */
  buildWindow(
    candidates: ContextSnippet[],
    taskContext: TaskContext,
    codeMap: CodeMap,
    maxTokens?: number
  ): SlidingWindowResult {
    const budget = maxTokens ?? this.config.tokenBudget;
    const now = new Date().toISOString();

    // ---------- 1. 分离文件片段与对话片段 ----------
    // 文件片段：type 包含 "file" 或 source 为文件路径
    // 对话片段：type 包含 "conversation" / "dialog" / "turn"
    const fileSnippets: ContextSnippet[] = [];
    const conversationSnippets: ContextSnippet[] = [];
    for (const snippet of candidates) {
      if (isConversationSnippet(snippet)) {
        conversationSnippets.push(snippet);
      } else {
        fileSnippets.push(snippet);
      }
    }

    // ---------- 2. 文件片段评分取 Top-K ----------
    const fileInputs = fileSnippets.map((s) => ({
      filePath: s.source,
      taskContext,
      codeMap,
      now,
    }));
    const topScores = this.scorer.scoreBatch(fileInputs, this.config.topKFiles);
    // 构建 source → score 映射
    const scoreMap = new Map<string, RelevanceScore>();
    for (const score of topScores) {
      scoreMap.set(score.filePath, score);
    }
    // 按 totalScore 降序保留 Top-K 文件片段
    const retainedFileSnippets: Array<{ snippet: ContextSnippet; score: RelevanceScore }> = [];
    for (const snippet of fileSnippets) {
      const score = scoreMap.get(snippet.source);
      if (score) {
        retainedFileSnippets.push({ snippet, score });
      }
    }
    // 按评分降序排序
    retainedFileSnippets.sort((a, b) => b.score.totalScore - a.score.totalScore);

    // ---------- 3. 对话片段保留最近 N 轮 ----------
    // 假设对话片段按时间顺序排列（最早的在前），取最后 keepRecentTurns 轮
    const recentConversations = conversationSnippets.slice(-this.config.keepRecentTurns);

    // ---------- 4. 合并保留片段（文件在前，对话在后） ----------
    // 文件片段携带 relevance 评分（由 scorer 计算）
    const mergedSnippets: ContextSnippet[] = [];
    for (const { snippet, score } of retainedFileSnippets) {
      mergedSnippets.push({
        ...snippet,
        relevance: score.totalScore,
      });
    }
    for (const snippet of recentConversations) {
      mergedSnippets.push(snippet);
    }

    // ---------- 5. Token 预算截断 ----------
    // 计算全部候选的 originalTokens
    const originalTokens = this.estimateTokens(candidates);

    // 从低分端截断：文件片段按评分升序截断（低分先丢弃），对话片段按时间顺序截断（旧先丢弃）
    // 简化实现：按 mergedSnippets 顺序累计 token，超预算则丢弃后续
    // 文件片段已按评分降序排列（高分在前），对话片段已按时间顺序排列（新在后）
    // 因此从末尾截断即可（丢弃低分文件 + 旧对话）
    const retainedSnippets: ContextSnippet[] = [];
    let estimatedTokens = 0;
    let droppedCount = 0;

    for (const snippet of mergedSnippets) {
      const tokenCount = this.estimateTokens([snippet]);
      if (estimatedTokens + tokenCount <= budget) {
        retainedSnippets.push(snippet);
        estimatedTokens += tokenCount;
      } else {
        droppedCount++;
      }
    }

    // ---------- 6. 收集结果元数据 ----------
    const retainedFiles = retainedSnippets.filter((s) => !isConversationSnippet(s)).map((s) => s.source);
    const retainedTurns = retainedSnippets.filter((s) => isConversationSnippet(s)).length;

    return {
      retainedSnippets,
      droppedCount,
      retainedFiles,
      retainedTurns,
      estimatedTokens,
      originalTokens,
      compressionRatio: originalTokens === 0 ? 1.0 : estimatedTokens / originalTokens,
    };
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 估算片段列表的 Token 数
   *
   * 估算公式：tokenCount = sum(ceil(content.length / charsPerToken))
   *
   * @param snippets 片段列表
   * @returns 估算 Token 数
   */
  private estimateTokens(snippets: ContextSnippet[]): number {
    let totalChars = 0;
    for (const snippet of snippets) {
      totalChars += snippet.content.length;
    }
    return Math.ceil(totalChars / this.config.charsPerToken);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断片段是否为对话片段
 *
 * 对话片段的 type 字段包含 "conversation" / "dialog" / "turn" 关键字。
 * 其他类型（file_content / task_context / memory / codemap 等）视为文件片段。
 *
 * @param snippet 上下文片段
 * @returns 是否为对话片段
 */
function isConversationSnippet(snippet: ContextSnippet): boolean {
  const type = snippet.type.toLowerCase();
  return type.includes("conversation") || type.includes("dialog") || type.includes("turn");
}
