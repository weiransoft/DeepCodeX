/**
 * 滑动窗口管理器（SlidingWindowManager）—— F-FOCUS-02 + F-FOCUS-03 配套
 *
 * 基于 RelevanceScorer 评分，保留 Top-K 相关文件 + 最近 N 轮对话，
 * 超 Token 预算时将超预算片段经 ContentSummarizer 压缩为摘要（V2-P2 升级，压缩而非丢弃）。
 *
 * V2-P1 → V2-P2 升级点：
 * 1. 构造函数增加 progressiveLoader + summarizer 参数
 * 2. buildWindow 改为 async（compressOldSnippets 需异步调用 ContentSummarizer）
 * 3. 超预算片段不再直接丢弃，而是经 compressOldSnippets 压缩为摘要
 * 4. SlidingWindowResult 增加 compressedSnippets 字段
 * 5. 新增 getBudgetAllocation() 公有方法（代理 progressiveLoader.getBudgetAllocation）
 * 6. 新增 maxCompressedSnippets 限制（P1-2 架构师建议，避免压缩片段过多挤占预算）
 *
 * 窗口构建算法（§3.7 契约 + V2-P2 升级）：
 * 1. 候选文件片段 → scorer.scoreBatch 取 Top-K（按 totalScore 降序）
 * 2. 对话片段保留最近 keepRecentTurns 轮（按时间顺序，最新的在前）
 * 3. 合并保留片段（文件在前，对话在后）
 * 4. 按 charsPerToken 估算累计 token：
 *    - V2-P1：超预算直接丢弃（droppedCount）
 *    - V2-P2：超预算片段经 compressOldSnippets 压缩为摘要（compressedSnippets）
 * 5. 压缩片段数量超过 maxCompressedSnippets 时，多余部分真正丢弃（droppedCount）
 *
 * Token 估算策略（零依赖，不引入 tokenizer）：
 * - 4 字符 ≈ 1 token（OpenAI 经验值，适用于中英文混合文本）
 * - 估算公式：tokenCount = Math.ceil(content.length / charsPerToken)
 *
 * 设计依据：
 * - V2 技术方案 §6.5 SlidingWindowManager 接口契约
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.4（V2-P2 升级版）
 * - 架构师审查 P1-2：compressOldSnippets 限制压缩片段数量
 *
 * @module v2/context/sliding-window
 */

import type { TaskContext } from "./types";
import type { CodeMap } from "../codemap/generator";
import type { ContextSnippet } from "../integration/session-hook";
import type { RelevanceScorer } from "./relevance-scorer";
import type { RelevanceScore } from "./relevance-scorer";
import type { ProgressiveContextLoader } from "./progressive-loader";
import type { ContentSummarizer } from "../memory/content-summarizer";

// ============================================================================
// 类型定义（与 V2_P2_IMPLEMENTATION_PLAN.md §3.4 完全对齐）
// ============================================================================

/**
 * 滑动窗口配置（V2-P2 升级：增加三层预算比例）
 */
export interface SlidingWindowConfig {
  /** Token 预算（窗口大小，默认 100000） */
  tokenBudget: number;
  /** 保留最近对话轮数（默认 5） */
  keepRecentTurns: number;
  /** 相关文件 Top-K（默认 20） */
  topKFiles: number;
  /** 字符→token 估算系数（默认 4，即 4 字符 ≈ 1 token） */
  charsPerToken: number;
  /** Metadata 层预算占比（V2-P2 新增，默认 0.1，与 ProgressiveContextLoader 对齐） */
  metadataBudgetRatio: number;
  /** Instruction 层预算占比（V2-P2 新增，默认 0.4，与 ProgressiveContextLoader 对齐） */
  instructionBudgetRatio: number;
  /** Resource 层预算占比（V2-P2 新增，默认 0.5，与 ProgressiveContextLoader 对齐） */
  resourceBudgetRatio: number;
  /**
   * 最大压缩片段数（V2-P2 新增，P1-2 架构师建议）
   *
   * 超预算片段经 ContentSummarizer 压缩后，若数量超过此限制，
   * 多余部分真正丢弃（计入 droppedCount），避免压缩摘要挤占过多预算。
   * 默认 10。
   */
  maxCompressedSnippets: number;
}

/**
 * 滑动窗口构建结果（V2-P2 升级：增加 compressedSnippets）
 */
export interface SlidingWindowResult {
  /** 保留的上下文片段（按优先级排序：文件片段 + 对话片段） */
  retainedSnippets: ContextSnippet[];
  /** 被压缩的片段（V2-P2 新增：摘要而非丢弃，type="compressed_summary"） */
  compressedSnippets: ContextSnippet[];
  /** 被丢弃的片段数（完全无法保留也无法压缩的，超 maxCompressedSnippets 限制的部分） */
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

/** 默认滑动窗口配置（V2-P2：增加三层预算比例 + maxCompressedSnippets） */
const DEFAULT_CONFIG: SlidingWindowConfig = {
  tokenBudget: 100_000,
  keepRecentTurns: 5,
  topKFiles: 20,
  charsPerToken: 4,
  metadataBudgetRatio: 0.1,
  instructionBudgetRatio: 0.4,
  resourceBudgetRatio: 0.5,
  maxCompressedSnippets: 10,
};

// ============================================================================
// SlidingWindowManager 类
// ============================================================================

/**
 * 滑动窗口管理器（V2-P2 完整版）
 *
 * 用法：
 * ```typescript
 * const scorer = new RelevanceScorer();
 * const progressiveLoader = new ProgressiveContextLoader({ tokenBudget: 8000 });
 * const summarizer = createSummarizer({ llm: { enabled: false } });
 * const window = new SlidingWindowManager(
 *   { tokenBudget: 8000, topKFiles: 10 },
 *   scorer,
 *   progressiveLoader,
 *   summarizer,
 * );
 * const result = await window.buildWindow(candidates, taskContext, codeMap, 8000);
 * console.log(`保留 ${result.retainedSnippets.length} 片段，压缩 ${result.compressedSnippets.length} 片段`);
 * ```
 */
export class SlidingWindowManager {
  private readonly config: SlidingWindowConfig;
  private readonly scorer: RelevanceScorer;
  /** V2-P2 新增：渐进式加载器（用于 getBudgetAllocation 代理） */
  private readonly progressiveLoader: ProgressiveContextLoader;
  /** V2-P2 新增：内容摘要器（用于压缩旧片段） */
  private readonly summarizer: ContentSummarizer;

  /**
   * V2-P2 构造函数
   *
   * @param config 可选的配置覆盖（缺省字段使用 DEFAULT_CONFIG）
   * @param scorer 相关性评分器（依赖注入）
   * @param progressiveLoader 渐进式三层加载器（V2-P2 新增，用于 getBudgetAllocation 代理）
   * @param summarizer 内容摘要器（V2-P2 新增，压缩旧片段用）
   */
  constructor(
    config: Partial<SlidingWindowConfig>,
    scorer: RelevanceScorer,
    progressiveLoader: ProgressiveContextLoader,
    summarizer: ContentSummarizer
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scorer = scorer;
    this.progressiveLoader = progressiveLoader;
    this.summarizer = summarizer;
  }

  /**
   * 构建滑动窗口（V2-P2 改为 async）
   *
   * V2-P2 升级算法：
   * 1. 分离候选片段为文件片段 + 对话片段
   * 2. 文件片段 → scorer.scoreBatch 取 Top-K
   * 3. 对话片段保留最近 keepRecentTurns 轮
   * 4. 合并保留片段（文件在前，对话在后）
   * 5. 按 Token 预算截断：
   *    - V2-P1：超预算直接丢弃（droppedCount）
   *    - V2-P2：超预算片段经 compressOldSnippets 压缩为摘要（compressedSnippets）
   * 6. 压缩片段数量超过 maxCompressedSnippets 时，多余部分真正丢弃（droppedCount）
   * 7. 返回 retainedSnippets + compressedSnippets + droppedCount
   *
   * @param candidates 所有候选上下文片段（含文件片段和对话片段）
   * @param taskContext 当前任务上下文
   * @param codeMap CodeMap
   * @param maxTokens 最大 Token 数（覆盖 config.tokenBudget，可选）
   * @returns 滑动窗口构建结果（含 retainedSnippets + compressedSnippets）
   */
  async buildWindow(
    candidates: ContextSnippet[],
    taskContext: TaskContext,
    codeMap: CodeMap,
    maxTokens?: number
  ): Promise<SlidingWindowResult> {
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

    // ---------- 5. Token 预算截断（V2-P2 升级：压缩而非丢弃） ----------
    // 计算全部候选的 originalTokens
    const originalTokens = this.estimateTokens(candidates);

    // V2-P2 升级：超预算片段收集到 overBudgetSnippets，经 compressOldSnippets 压缩为摘要
    const retainedSnippets: ContextSnippet[] = [];
    const overBudgetSnippets: ContextSnippet[] = [];
    let estimatedTokens = 0;

    for (const snippet of mergedSnippets) {
      const tokenCount = this.estimateTokens([snippet]);
      if (estimatedTokens + tokenCount <= budget) {
        retainedSnippets.push(snippet);
        estimatedTokens += tokenCount;
      } else {
        overBudgetSnippets.push(snippet);
      }
    }

    // ---------- 6. 压缩超预算片段（V2-P2 新增） ----------
    // P1-2 架构师建议：限制压缩片段数量，超出的部分真正丢弃
    const compressibleSnippets = overBudgetSnippets.slice(0, this.config.maxCompressedSnippets);
    const excessSnippets = overBudgetSnippets.slice(this.config.maxCompressedSnippets);

    const compressedSnippets = await this.compressOldSnippets(compressibleSnippets);
    // 超出 maxCompressedSnippets 限制的部分真正丢弃（droppedCount 计入）
    // 注：compressOldSnippets 内部单片段压缩失败也会跳过，这些也计入 droppedCount
    const compressFailedCount = compressibleSnippets.length - compressedSnippets.length;
    const droppedCount = excessSnippets.length + compressFailedCount;

    // ---------- 7. 收集结果元数据 ----------
    const retainedFiles = retainedSnippets.filter((s) => !isConversationSnippet(s)).map((s) => s.source);
    const retainedTurns = retainedSnippets.filter((s) => isConversationSnippet(s)).length;

    return {
      retainedSnippets,
      compressedSnippets,
      droppedCount,
      retainedFiles,
      retainedTurns,
      estimatedTokens,
      originalTokens,
      compressionRatio: originalTokens === 0 ? 1.0 : estimatedTokens / originalTokens,
    };
  }

  /**
   * 压缩旧片段（V2-P2 新增）
   *
   * 将超预算片段经 ContentSummarizer 压缩为摘要片段。
   * 压缩后片段的 type 标记为 "compressed_summary"，source 保留原始来源。
   *
   * 策略：
   * - 对每个片段调用 summarizer.summarize(content, maxCompressedLength)
   * - maxCompressedLength = max(50, floor(content.length / 3))（压缩比 3:1）
   * - 压缩失败的片段（summarizer 抛错）跳过，不中断流程
   * - 压缩片段数量由调用方限制（maxCompressedSnippets，P1-2 架构师建议）
   *
   * 失败安全（R-P2-04 风险缓解）：
   * - 单片段压缩失败：try-catch 捕获，跳过该片段，不影响其他片段
   * - LLM 超时/限流：DeepSeekSummarizer 30s 超时后抛错，被 try-catch 捕获
   * - 全部片段压缩失败：返回空数组，buildWindow 降级为 V2-P1 行为（全部丢弃）
   *
   * @param snippets 超预算片段列表（已由调用方限制数量）
   * @returns 压缩后的摘要片段列表（可能少于输入数量，单片段失败时跳过）
   */
  private async compressOldSnippets(snippets: ContextSnippet[]): Promise<ContextSnippet[]> {
    if (snippets.length === 0) return [];

    const compressed: ContextSnippet[] = [];
    for (const snippet of snippets) {
      try {
        // 压缩比 3:1，目标长度为原长度的 1/3，最小 50 字符
        const maxCompressedLength = Math.max(50, Math.floor(snippet.content.length / 3));
        const summary = await this.summarizer.summarize(snippet.content, maxCompressedLength);
        compressed.push({
          type: "compressed_summary",
          content: `[摘要] ${summary}`,
          source: snippet.source,
          relevance: snippet.relevance,
        });
      } catch {
        // 压缩失败：跳过该片段（降级，不中断整体流程）
        // 失败计数由调用方 buildWindow 通过 compressibleSnippets.length - compressed.length 计算
      }
    }
    return compressed;
  }

  /**
   * 获取三层预算分配（V2-P2 新增，供测试断言 SW-COMPRESS-03）
   *
   * 代理 progressiveLoader.getBudgetAllocation()，确保 SlidingWindowManager
   * 与 ProgressiveContextLoader 使用相同的三层预算分配。
   *
   * @returns 三层预算 Token 数
   */
  getBudgetAllocation(): { metadata: number; instruction: number; resource: number } {
    return this.progressiveLoader.getBudgetAllocation();
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
 * 其他类型（file_content / task_context / memory / codemap / compressed_summary /
 * progressive_metadata / progressive_instruction / progressive_resource 等）视为文件片段。
 *
 * @param snippet 上下文片段
 * @returns 是否为对话片段
 */
function isConversationSnippet(snippet: ContextSnippet): boolean {
  const type = snippet.type.toLowerCase();
  return type.includes("conversation") || type.includes("dialog") || type.includes("turn");
}
