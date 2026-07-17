/**
 * 双层上下文管理器（DualLayerContextManager）—— V2-P1 集成入口 + V2-P2 升级 + V2-P3 升级
 *
 * 组装全局上下文 + 任务上下文 → 产出 session-hook 形态的 ContextSnippet[]，
 * 供编排器在 refreshContextAsync 中调用后 setSnippets 写入缓存。
 *
 * V2-P1 → V2-P2 升级点：
 * 1. 构造函数增加 progressiveLoader + summarizer 参数（透传给 SlidingWindowManager）
 * 2. buildOptimizedContext 中 buildWindow 调用改 await（buildWindow 已改 async）
 * 3. 消费 result.compressedSnippets：压缩摘要片段追加到返回数组末尾（压缩而非丢弃）
 * 4. P1-4 架构师建议：ProgressiveContextLoader 三层加载片段注入 directRetainSnippets
 *    （确保 PCL 片段不参与评分，必注入到上下文）
 *
 * V2-P2 → V2-P3 升级点（架构师审查 v1 落实）：
 * 5. 构造函数增加 userGlobalMemory + experienceRecommender 两个可选参数
 *    （P1-1 修复：不注入 domainModeler，DomainModeler.model/persist 由独立 lifecycle 触发）
 * 6. buildOptimizedContext 追加 3 类 directRetain 片段收集：
 *    - UserGlobalMemory（P0-3 修复：复用 injectIntoSystemPrompt，避免逻辑重复）
 *    - DomainKnowledge（P0-1 修复：从 GlobalContext.domainKnowledge 读取，按 relatedConcepts
 *      数量降序取 Top-N，不依赖 ConceptEntry.confidence 字段——该字段不存在）
 *    - RecommendedExperience（P0-2 修复：调用 recommend(taskContext, limit, { recordAccess: false })，
 *      避免预计算路径污染 accessCount）
 * 7. P1-2 修复：collectExperienceSnippets（V2-P1 兜底）接收 excludeIds 参数，
 *    排除已被 collectRecommendedExperienceSnippets 推荐的经验，避免同一条经验双重注入
 * 8. P1-4 修复：增加 MAX_DOMAIN_CONCEPT/RULE/USER_MEMORY/EXPERIENCE_RECOMMENDATION 常量，
 *    各 collect 方法内 slice 截断，避免 directRetain 挤占全部 Token 预算
 *
 * 设计依据：
 * - V2 技术方案 §5.2 双层上下文模型（GlobalContext + TaskContext）
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.4 DualLayerContextManager 契约
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.5 CodeMapProvider 接口
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.5 V2-P2 适配点
 * - V2_P3 架构师审查报告（v1，2026-07-17）§三 P0-1/P0-2/P0-3 + P1-1/P1-2/P1-3/P1-4
 * - NP-01 红线：preBuildContext 保持同步读缓存，本方法永不进热路径
 * - P1-4 架构师建议：PCL 三层加载片段注入 directRetainSnippets（不参与评分）
 *
 * P1 裁剪（§3.4）：
 * - 无独立 TaskContextStore：任务层直接复用 P0b TaskContextManager（内存 Map）
 * - 无 syncContexts 双向方法：同步由 ContextSynchronizer 在归档回调中完成
 * - 产出物为 integration/session-hook 的 ContextSnippet 形态
 *   （{type, content, source, relevance?}），与 §5.2 的 ContextSnippet
 *   （{content, source, relevanceScore, tokenCount}）做形态映射，
 *   以 session-hook 契约为准（NP-01 集成红线，既有缓存结构不动）
 *
 * 候选片段收集策略（§5.2 双层模型 + V2-P2 PCL 注入 + V2-P3 三模块注入）：
 * - 全局层：UserProfile（codeStyle/frameworkPreferences/behaviorPatterns）+
 *   UserGlobalMemory（7 维度 + facts Top-10，V2-P3）+
 *   DomainKnowledge（conceptLibrary Top-N + ruleLibrary Top-N，V2-P3）+
 *   HistoricalExperience（兜底最近 N 条，V2-P1）+
 *   RecommendedExperience（RAG 推荐 Top-N，V2-P3）
 * - 任务层：TaskContext 的 focusPoints/thoughtHistory/intermediateResults
 * - 文件层：focusPoints(type=file) 的 ref 作为文件路径，从 CodeMap.files 提取内容片段
 * - V2-P2 PCL 层：ProgressiveContextLoader 三层加载片段（Metadata/Instruction/Resource）
 *   注入 directRetainSnippets，确保必注入且不参与评分
 *
 * 偏离报备（架构师审查待补）：
 * - DualLayerContextConfig 增加 projectRoot 必填字段（§3.4 契约未列）
 *   理由：buildOptimizedContext(userId, taskId) 签名不含 projectRoot，
 *   但 CodeMapProvider.getCodeMap(projectRoot) 需要 projectRoot；
 *   构造时绑定 projectRoot 是最小偏离，避免签名变更。
 *
 * @module v2/context/dual-layer-manager
 */

import * as path from "node:path";
import type { GlobalContextManager } from "./global-context";
import type { GlobalContext } from "./global-context";
import type { TaskContextManager } from "./task-context-manager";
import type { TaskContext, FocusPoint } from "./types";
import type { CodeMap, FileInfo } from "../codemap/generator";
import type { RelevanceScorer } from "./relevance-scorer";
import type { SlidingWindowManager } from "./sliding-window";
import type { SlidingWindowConfig } from "./sliding-window";
import type { RelevanceScoringConfig } from "./relevance-scorer";
import type { ContextSnippet } from "../integration/session-hook";
// V2-P2 新增导入：ProgressiveContextLoader（三层加载）+ ContentSummarizer（摘要器类型）
import type { ProgressiveContextLoader } from "./progressive-loader";
import type { ContentSummarizer } from "../memory/content-summarizer";
// V2-P3 新增导入：UserGlobalMemoryManager + ExperienceRecommender（DomainModeler 仅导入常量，不注入实例）
// P1-1 修复（架构师审查）：不注入 DomainModeler 实例，因其 model()/persist 由独立 lifecycle 触发，
// buildOptimizedContext 仅从 GlobalContext.domainKnowledge 读取已持久化的领域知识。
import type { UserGlobalMemoryManager } from "../memory/user-global-memory";
import type { ExperienceRecommender, ExperienceRecommendation } from "../memory/experience-recommender";
import type { SuccessExperience, FailureExperience } from "./global-context";
import { CONTEXT_SNIPPET_TYPE as UserMemorySnippetType } from "../memory/user-global-memory";
import { CONTEXT_SNIPPET_TYPE as ExperienceSnippetType } from "../memory/experience-recommender";
import { CONTEXT_SNIPPET_TYPE as DomainSnippetType } from "../understanding/domain-modeler";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 双层上下文管理器配置
 *
 * 与 §3.4 契约对齐，新增 projectRoot 必填字段（偏离报备见文件头注释）。
 */
export interface DualLayerContextConfig {
  /** 滑动窗口配置透传（SlidingWindowManager 构造用） */
  window: Partial<SlidingWindowConfig>;
  /** 相关性评分配置透传（RelevanceScorer 构造用） */
  scoring: Partial<RelevanceScoringConfig>;
  /** 默认 Token 预算（默认 100000） */
  defaultTokenBudget: number;
  /**
   * 项目根目录（必填，偏离 §3.4 契约）
   *
   * 用于 CodeMapProvider.getCodeMap(projectRoot) 调用，
   * 以及文件片段内容读取的根路径定位。
   */
  projectRoot: string;
}

/**
 * CodeMap 提供者接口（§3.5）
 *
 * 隔离 DualLayerContextManager 与 CodeMap 生成时机的直接耦合，
 * 便于测试替换。会话级缓存（每 projectRoot 一份，turn 内复用）。
 */
export interface CodeMapProvider {
  /**
   * 获取指定项目的 CodeMap
   *
   * @param projectRoot 项目根目录
   * @returns CodeMap（已生成或缓存的）
   */
  getCodeMap(projectRoot: string): Promise<CodeMap>;
}

// ============================================================================
// 常量
// ============================================================================

/** 默认 Token 预算（§3.4） */
const DEFAULT_TOKEN_BUDGET = 100_000;

/** 全局层经验片段最大条数（成功 + 失败合计，避免经验库膨胀挤占预算） */
const MAX_EXPERIENCE_SNIPPETS = 5;

/** 任务层思考历史片段最大条数（最近 N 条） */
const MAX_THOUGHT_SNIPPETS = 3;

/** 任务层中间结果片段最大条数 */
const MAX_INTERMEDIATE_SNIPPETS = 3;

// V2-P3 新增常量（P1-4 修复：限制每类片段条数，避免 directRetain 挤占全部 Token 预算）
/** 领域知识概念片段最大条数（从 conceptLibrary 按 relatedConcepts 数量降序取 Top-N） */
const MAX_DOMAIN_CONCEPT_SNIPPETS = 10;

/** 领域知识规则片段最大条数（从 ruleLibrary 按 priority 降序取 Top-N） */
const MAX_DOMAIN_RULE_SNIPPETS = 5;

/** 用户全局记忆片段最大条数（汇总为单条片段，7 维度 + facts Top-10） */
const MAX_USER_MEMORY_SNIPPETS = 1;

/** RAG 推荐经验片段最大条数（从 ExperienceRecommender.recommend 取 Top-N） */
const MAX_EXPERIENCE_RECOMMENDATION_SNIPPETS = 5;

// ============================================================================
// DualLayerContextManager 实现
// ============================================================================

/**
 * 双层上下文管理器（V2-P1 集成入口 + V2-P2 升级 + V2-P3 升级）
 *
 * 使用方式（V2-P3 版本，可选注入 userGlobalMemory + experienceRecommender）：
 * ```typescript
 * const progressiveLoader = new ProgressiveContextLoader({ tokenBudget: 100000 });
 * const summarizer = createSummarizer({ llm: { enabled: false } });
 * const windowManager = new SlidingWindowManager(
 *   { tokenBudget: 100000, topKFiles: 20 },
 *   scorer,
 *   progressiveLoader,
 *   summarizer,
 * );
 * // V2-P3 新增：用户全局记忆 + 经验推荐器（可选注入）
 * const userGlobalMemory = new UserGlobalMemoryManager(memoryStore);
 * const experienceRecommender = new ExperienceRecommender(globalManager, embedder);
 * const manager = new DualLayerContextManager(
 *   { projectRoot: "/path/to/project", window: {}, scoring: {}, defaultTokenBudget: 100000 },
 *   globalManager,
 *   taskManager,
 *   codeMapProvider,
 *   scorer,
 *   windowManager,
 *   progressiveLoader, // V2-P2 新增：用于 PCL 三层加载注入（P1-4）
 *   summarizer,        // V2-P2 新增：透传一致性（实际由 window 内部使用）
 *   userGlobalMemory,        // V2-P3 新增：用户全局记忆片段（可选）
 *   experienceRecommender,   // V2-P3 新增：RAG 推荐经验片段（可选）
 * );
 * // 由编排器在 refreshContextAsync 中调用（turn 入口）
 * const snippets = await manager.buildOptimizedContext("user-1", "task-1");
 * hook.setSnippets("session-1", snippets);
 * ```
 */
export class DualLayerContextManager {
  /** 配置（含 projectRoot、tokenBudget 等） */
  private readonly config: DualLayerContextConfig;

  /**
   * V2-P3 构造函数（在 V2-P2 基础上增加 userGlobalMemory + experienceRecommender 可选参数）
   *
   * P1-1 修复（架构师审查）：不注入 DomainModeler 实例。DomainModeler.model() 是重 IO 操作
   * （全量扫描 + 文件读取），不应进 turn 入口路径；其 model() + persistToGlobalContext()
   * 由独立 lifecycle 触发（CLI 命令 / ProjectUnderstandingService / 显式用户动作），
   * buildOptimizedContext 仅从 GlobalContext.domainKnowledge 读取已持久化的领域知识。
   *
   * @param config 配置（必填 projectRoot）
   * @param globalManager 全局上下文管理器（P0a 既有）
   * @param taskManager 任务上下文管理器（P0b 既有）
   * @param codeMapProvider CodeMap 提供者
   * @param scorer 相关性评分器
   * @param window 滑动窗口管理器（V2-P2：构造时已注入 progressiveLoader + summarizer）
   * @param progressiveLoader V2-P2 新增：渐进式三层加载器，用于 PCL 片段注入 directRetainSnippets（P1-4 架构师建议）
   * @param summarizer V2-P2 新增：内容摘要器（透传一致性，实际由 window 内部 compressOldSnippets 使用）
   * @param userGlobalMemory V2-P3 新增可选：用户全局记忆管理器，注入后收集 7 维度 + facts 片段（P0-3 修复：复用 injectIntoSystemPrompt）
   * @param experienceRecommender V2-P3 新增可选：经验 RAG 推荐器，注入后收集推荐经验片段（P0-2 修复：传 recordAccess:false 避免污染 accessCount）
   */
  constructor(
    config: Partial<DualLayerContextConfig> & Pick<DualLayerContextConfig, "projectRoot">,
    private readonly globalManager: GlobalContextManager,
    private readonly taskManager: TaskContextManager,
    private readonly codeMapProvider: CodeMapProvider,
    private readonly scorer: RelevanceScorer,
    private readonly window: SlidingWindowManager,
    private readonly progressiveLoader: ProgressiveContextLoader,
    private readonly summarizer: ContentSummarizer,
    // V2-P3 新增可选参数（向后兼容，未注入时跳过对应 collect 方法）
    private readonly userGlobalMemory?: UserGlobalMemoryManager,
    private readonly experienceRecommender?: ExperienceRecommender
  ) {
    this.config = {
      window: config.window ?? {},
      scoring: config.scoring ?? {},
      defaultTokenBudget: config.defaultTokenBudget ?? DEFAULT_TOKEN_BUDGET,
      projectRoot: config.projectRoot,
    };
  }

  /**
   * 构建优化上下文（async，仅供 turn 入口预计算调用）
   *
   * 由编排器在 refreshContextAsync 中调用后 setSnippets 写入缓存；
   * 热路径 preBuildContext 保持纯同步读缓存，本方法永不进热路径。
   *
   * V2-P2 升级实现步骤：
   * 1. 从 globalManager 加载 GlobalContext（含 UserProfile + HistoricalExperience）
   * 2. 从 taskManager 加载 TaskContext（含 focusPoints/thoughtHistory 等）
   * 3. 从 codeMapProvider 获取 CodeMap
   * 4. 收集候选片段（全局层 + 任务层 + 文件层 + V2-P2 PCL 三层）
   * 5. 调用 window.buildWindow 做评分 + Top-K + Token 预算截断 + V2-P2 压缩
   * 6. 返回 retainedSnippets + compressedSnippets（session-hook 形态）
   *
   * V2-P2 新增（P1-4 架构师建议）：
   * - 步骤 4 中调用 progressiveLoader.loadAll(taskContext) 加载三层片段
   * - 三层片段（progressive_metadata/instruction/resource）注入 directRetainSnippets
   * - 确保必注入且不参与评分（与文件层 scoringCandidates 分离）
   *
   * V2-P2 新增（压缩而非丢弃）：
   * - 步骤 5 中 buildWindow 返回 compressedSnippets（超预算片段的摘要）
   * - 步骤 6 中压缩摘要片段追加到返回数组末尾（优先级最低）
   *
   * 降级语义：
   * - TaskContext 不存在：返回空数组（任务未创建或已归档）
   * - CodeMap 获取失败：仅返回全局层 + 任务层 + PCL 片段（文件层降级为空）
   * - GlobalContext 加载失败：globalManager 内部已降级返回默认空上下文
   * - PCL 加载失败：try-catch 捕获，降级为无 PCL 片段（不中断流程）
   *
   * @param userId 用户 ID
   * @param taskId 任务 ID
   * @param maxTokens 可选的 Token 预算覆盖（默认使用 config.defaultTokenBudget）
   * @returns 优化后的上下文片段列表（session-hook 形态，含压缩摘要）
   */
  async buildOptimizedContext(userId: string, taskId: string, maxTokens?: number): Promise<ContextSnippet[]> {
    // ---- 1. 加载 TaskContext（任务层）----
    const taskContext = this.taskManager.get(taskId);
    if (!taskContext) {
      // 任务不存在或已归档：返回空数组（无注入，降级语义）
      return [];
    }

    // ---- 2. 加载 GlobalContext（全局层）----
    // globalManager.load 内部已做降级处理（损坏文件 → 默认空上下文）
    const globalContext = this.globalManager.load(userId);

    // ---- 3. 获取 CodeMap（文件层）----
    let codeMap: CodeMap | null = null;
    try {
      codeMap = await this.codeMapProvider.getCodeMap(this.config.projectRoot);
    } catch {
      // CodeMap 获取失败：降级为仅全局层 + 任务层（文件层降级为空）
      codeMap = null;
    }

    // ---- 4. 收集候选片段 ----
    // 分离"直接保留片段"（全局层/任务层/PCL 层/V2-P3 三类，不参与评分）与"评分片段"（文件层，由 scorer 评分）
    // 理由：SlidingWindowManager.buildWindow 假设非对话片段都是文件片段并对它们评分；
    //       全局层/任务层/PCL 层/V2-P3 片段的 source 不是文件路径，评分时距离分会得 0.1（图未含），
    //       导致被 Top-K 截断掉。分离后直接保留片段不进评分，保证必注入。
    const directRetainSnippets: ContextSnippet[] = [];
    const scoringCandidates: ContextSnippet[] = [];

    // 4.1 全局层：UserProfile 片段（直接保留）
    const userProfileSnippets = this.collectUserProfileSnippets(globalContext);
    directRetainSnippets.push(...userProfileSnippets);

    // 4.2 V2-P3 全局层：UserGlobalMemory 片段（直接保留，P0-3 修复：复用 injectIntoSystemPrompt）
    // 仅当 userGlobalMemory 注入时收集；空记忆或异常降级为无片段（不中断流程）
    try {
      const userMemorySnippets = this.collectUserGlobalMemorySnippets(userId);
      directRetainSnippets.push(...userMemorySnippets);
    } catch {
      // UserGlobalMemory 收集失败：降级为无片段（不中断整体流程）
    }

    // 4.3 V2-P3 全局层：DomainKnowledge 片段（直接保留，P0-1 修复：从 GlobalContext.domainKnowledge 读取）
    // 始终执行（仅依赖已加载的 globalContext，零额外依赖，P1-3 修复统一降级语义）
    try {
      const domainSnippets = this.collectDomainKnowledgeSnippets(globalContext);
      directRetainSnippets.push(...domainSnippets);
    } catch {
      // DomainKnowledge 收集失败：降级为无片段（不中断整体流程）
    }

    // 4.4 V2-P3 全局层：RecommendedExperience 片段（直接保留，P0-2 修复：recordAccess=false）
    // 仅当 experienceRecommender 注入时收集；recommend() 异常降级为无片段
    // P1-2 修复：先收集推荐经验，记录已推荐的经验 id，后续 collectExperienceSnippets 兜底时排除
    const recommendedIds = new Set<string>();
    try {
      const recommendedSnippets = this.collectRecommendedExperienceSnippets(taskContext);
      for (const s of recommendedSnippets) {
        // 从 source 提取经验 id（source 格式：global:experience:recommendation:<id>）
        const id = s.source.split(":").pop();
        if (id) {
          recommendedIds.add(id);
        }
      }
      directRetainSnippets.push(...recommendedSnippets);
    } catch {
      // RecommendedExperience 收集失败：降级为无片段（不中断整体流程）
    }

    // 4.5 全局层：HistoricalExperience 片段（V2-P1 兜底，直接保留）
    // P1-2 修复：接收 recommendedIds 参数，排除已被推荐的经验，避免同一条经验双重注入
    const experienceSnippets = this.collectExperienceSnippets(globalContext, recommendedIds);
    directRetainSnippets.push(...experienceSnippets);

    // 4.6 任务层：focusPoints / thoughtHistory / intermediateResults 片段（直接保留）
    const taskSnippets = this.collectTaskSnippets(taskContext);
    directRetainSnippets.push(...taskSnippets);

    // 4.7 V2-P2 PCL 层：ProgressiveContextLoader 三层加载片段（直接保留，P1-4 架构师建议）
    // PCL 片段（progressive_metadata/instruction/resource）注入 directRetainSnippets，
    // 确保必注入且不参与评分。PCL 加载失败时降级为无 PCL 片段（不中断流程）。
    try {
      const pclResult = await this.progressiveLoader.loadAll(taskContext);
      directRetainSnippets.push(...pclResult.metadata);
      directRetainSnippets.push(...pclResult.instruction);
      directRetainSnippets.push(...pclResult.resource);
    } catch {
      // PCL 加载失败：降级为无 PCL 片段（不中断整体 buildOptimizedContext 流程）
    }

    // 4.8 文件层：从 CodeMap.files 提取 focusPoints 文件内容片段（参与评分）
    if (codeMap) {
      const fileSnippets = this.collectFileSnippets(taskContext, codeMap);
      scoringCandidates.push(...fileSnippets);
    }

    // ---- 5. 调用 SlidingWindowManager 做评分 + Top-K + Token 预算截断 + V2-P2 压缩 ----
    // 直接保留片段先扣除 Token 预算，剩余预算给评分片段
    const directTokens = this.estimateTokens(directRetainSnippets);
    const remainingBudget = Math.max(0, (maxTokens ?? this.config.defaultTokenBudget) - directTokens);

    let retainedScoringSnippets: ContextSnippet[] = [];
    let compressedSnippets: ContextSnippet[] = []; // V2-P2 新增：压缩摘要片段
    if (codeMap && scoringCandidates.length > 0) {
      // V2-P2：buildWindow 已改 async，需 await
      const result = await this.window.buildWindow(scoringCandidates, taskContext, codeMap, remainingBudget);
      retainedScoringSnippets = result.retainedSnippets;
      compressedSnippets = result.compressedSnippets; // V2-P2：消费压缩摘要
    } else if (scoringCandidates.length > 0) {
      // CodeMap 缺失时无法评分：简单截断评分候选
      retainedScoringSnippets = this.truncateByTokenBudget(scoringCandidates, remainingBudget);
    }

    // ---- 6. 合并：直接保留片段（前）+ 评分片段（中）+ 压缩摘要片段（末尾，V2-P2 新增）----
    // V2-P2：压缩摘要片段追加到末尾（优先级最低，压缩而非丢弃）
    return [...directRetainSnippets, ...retainedScoringSnippets, ...compressedSnippets];
  }

  /**
   * 估算片段列表的 Token 数（4 字符≈1 token）
   *
   * @param snippets 片段列表
   * @returns 估算 Token 数
   */
  private estimateTokens(snippets: ContextSnippet[]): number {
    const charsPerToken = 4;
    let totalChars = 0;
    for (const s of snippets) {
      totalChars += s.content.length;
    }
    return Math.ceil(totalChars / charsPerToken);
  }

  // ------------------------------------------------------------------------
  // 私有方法：候选片段收集
  // ------------------------------------------------------------------------

  /**
   * 收集 UserProfile 片段（全局层）
   *
   * 提取 UserProfile 中的可注入字段，封装为 ContextSnippet。
   * - codeStyle：代码风格偏好（缩进/引号/分号/注释语言）
   * - frameworkPreferences：框架偏好列表
   * - behaviorPatterns：行为模式列表
   *
   * @param globalContext 全局上下文
   * @returns UserProfile 片段列表（通常 1 个汇总片段）
   */
  private collectUserProfileSnippets(globalContext: GlobalContext): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    const profile = globalContext.userProfile;

    // 汇总为单个片段（避免碎片化挤占预算）
    const lines: string[] = [];
    lines.push(`缩进: ${profile.codeStyle.indent}`);
    lines.push(`引号: ${profile.codeStyle.quoteStyle}`);
    lines.push(`分号: ${profile.codeStyle.semicolons ? "是" : "否"}`);
    lines.push(`注释语言: ${profile.codeStyle.commentLanguage}`);
    if (profile.frameworkPreferences.length > 0) {
      lines.push(`框架偏好: ${profile.frameworkPreferences.join(", ")}`);
    }
    if (profile.behaviorPatterns.length > 0) {
      lines.push(`行为模式: ${profile.behaviorPatterns.join(", ")}`);
    }

    snippets.push({
      type: "user_profile",
      content: lines.join("\n"),
      source: "global:user_profile",
      relevance: 1.0, // 全局层片段默认最高相关性
    });

    return snippets;
  }

  /**
   * 收集 HistoricalExperience 片段（全局层，V2-P1 兜底）
   *
   * 提取最近 N 条成功 + 失败经验，封装为 ContextSnippet。
   * - 成功经验：solution 字段（解决方案摘要）
   * - 失败经验：lessonLearned 字段（教训）
   *
   * P1-2 修复（架构师审查）：新增 excludeIds 参数，排除已被
   * collectRecommendedExperienceSnippets 推荐的经验 id，避免同一条经验
   * 以 experience_success（兜底）和 experience_recommendation（推荐）两种 type
   * 双重注入到 directRetainSnippets，浪费 Token 且语义混乱。
   * 推荐优先：recommend() 已基于 RAG score 排序，质量更高；
   * 兜底仅补充"未被推荐但最近"的经验。
   *
   * @param globalContext 全局上下文
   * @param excludeIds 已被推荐的经验 id 集合（V2-P3 推荐经验 id，默认空集合）
   * @returns 经验片段列表（最多 MAX_EXPERIENCE_SNIPPETS 条）
   */
  private collectExperienceSnippets(
    globalContext: GlobalContext,
    excludeIds: Set<string> = new Set()
  ): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    const exp = globalContext.historicalExperience;

    // 成功经验：按 createdAt 倒序取最近 N 条（排除已被推荐的经验）
    const successes = [...exp.successExperiences]
      .filter((s) => !excludeIds.has(s.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.ceil(MAX_EXPERIENCE_SNIPPETS / 2));
    for (const s of successes) {
      snippets.push({
        type: "experience_success",
        content: `[成功经验] ${s.taskType}: ${s.description}\n解决方案: ${s.solution}`,
        source: `global:experience:success:${s.id}`,
        relevance: 0.8, // 经验片段高相关性（但低于 UserProfile）
      });
    }

    // 失败经验：按 createdAt 倒序取最近 N 条（排除已被推荐的经验）
    const failures = [...exp.failureExperiences]
      .filter((f) => !excludeIds.has(f.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.floor(MAX_EXPERIENCE_SNIPPETS / 2));
    for (const f of failures) {
      snippets.push({
        type: "experience_failure",
        content: `[失败教训] ${f.taskType}: ${f.description}\n失败原因: ${f.failureReason}\n教训: ${f.lessonLearned}`,
        source: `global:experience:failure:${f.id}`,
        relevance: 0.8,
      });
    }

    return snippets;
  }

  // ------------------------------------------------------------------------
  // V2-P3 新增私有方法：用户全局记忆 / 领域知识 / 推荐经验片段收集
  // ------------------------------------------------------------------------

  /**
   * 收集用户全局记忆片段（V2-P3 全局层，P0-3 修复）
   *
   * P0-3 修复（架构师审查）：复用 UserGlobalMemoryManager.injectIntoSystemPrompt，
   * 避免在 DualLayerContextManager 重复实现"7 维度按优先级排序 + facts Top-10 + 2000 字符截断"逻辑。
   * 重复实现会导致双源真相，未来调整维度优先级时只改一处而另一处漂移。
   *
   * 实现策略：
   *   - 调用 injectIntoSystemPrompt(userId, "") 传入空 originalPrompt
   *   - 从返回值中提取 <user_memory>...</user_memory> 块内容作为片段 content
   *   - 空记忆时 injectIntoSystemPrompt 返回原 prompt（即空字符串），此时返回空数组
   *   - 注：UserGlobalMemoryManager 内部已做 facts 按 confidence 降序取 Top-10、2000 字符截断
   *
   * 降级语义：
   *   - userGlobalMemory 未注入：返回空数组（无用户记忆片段）
   *   - injectIntoSystemPrompt 异常：上层 try-catch 降级为空数组
   *   - 空记忆：返回空数组（injectIntoSystemPrompt 返回原 prompt，无 <user_memory> 块）
   *
   * @param userId 用户 ID
   * @returns 用户全局记忆片段列表（最多 MAX_USER_MEMORY_SNIPPETS 条，通常为单条汇总片段）
   */
  private collectUserGlobalMemorySnippets(userId: string): ContextSnippet[] {
    // userGlobalMemory 未注入：返回空数组（降级语义）
    if (!this.userGlobalMemory) {
      return [];
    }

    // 复用 injectIntoSystemPrompt（P0-3 修复），传入空 originalPrompt 获取纯 memoryBlock
    // injectIntoSystemPrompt 在空记忆时返回原 prompt（即空字符串），无 <user_memory> 块
    const injected = this.userGlobalMemory.injectIntoSystemPrompt(userId, "");

    // 提取 <user_memory>...</user_memory> 块内容
    const openTag = "<user_memory>";
    const closeTag = "</user_memory>";
    const openIdx = injected.indexOf(openTag);
    const closeIdx = injected.lastIndexOf(closeTag);
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
      // 空记忆或格式异常：返回空数组
      return [];
    }

    // 提取块内容（去除标签本身），trim 去除首尾换行
    const content = injected.slice(openIdx + openTag.length, closeIdx).trim();
    if (!content) {
      return [];
    }

    // 汇总为单条片段（MAX_USER_MEMORY_SNIPPETS=1，P1-4 修复限制条数）
    // injectIntoSystemPrompt 内部已做 7 维度优先级排序 + facts Top-10 + 2000 字符截断，
    // 此处仅产出单条汇总片段，slice(0, MAX_USER_MEMORY_SNIPPETS) 为防御性截断（保持常量被使用）
    return [
      {
        type: UserMemorySnippetType.USER_GLOBAL_MEMORY,
        content,
        // source 命名与 collectUserProfileSnippets 的 "global:user_profile" 保持一致性（OPT-4）
        source: "global:user_global_memory",
        // relevance=1.0：用户级最高优先级，与 UserProfile 同级
        // 注：directRetain 片段不参与评分，relevance 仅作为降级截断排序依据（P2-2）
        relevance: 1.0,
      },
    ].slice(0, MAX_USER_MEMORY_SNIPPETS);
  }

  /**
   * 收集业务领域知识片段（V2-P3 全局层，P0-1 修复）
   *
   * P0-1 修复（架构师审查）：ConceptEntry 类型无 confidence 字段（仅含 id/name/description/relatedConcepts），
   * 原方案的"按 confidence 降序取 Top-N"无法实现。改为按 relatedConcepts 数量降序排序
   * （关联概念多的概念更可能是核心业务概念），取 Top-N。
   *
   * 数据来源：GlobalContext.domainKnowledge（由 DomainModeler.persistToGlobalContext 预先持久化）
   * - conceptLibrary：业务概念列表 → 按 relatedConcepts.length 降序取 Top-N
   * - ruleLibrary：业务规则列表 → 按 priority 降序取 Top-N
   *
   * 降级语义：
   *   - domainKnowledge 为空（conceptLibrary 和 ruleLibrary 均为空）：返回空数组
   *   - 读取异常：上层 try-catch 降级为空数组
   *
   * P1-3 修复（架构师审查）：始终执行（不依赖 domainModeler 注入），仅依赖已加载的 globalContext，
   * 零额外依赖。domainKnowledge 可能由独立 lifecycle（CLI 命令 / ProjectUnderstandingService）预先持久化。
   *
   * @param globalContext 全局上下文（已加载）
   * @returns 领域知识片段列表（最多 MAX_DOMAIN_CONCEPT_SNIPPETS + MAX_DOMAIN_RULE_SNIPPETS 条）
   */
  private collectDomainKnowledgeSnippets(globalContext: GlobalContext): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    const dk = globalContext.domainKnowledge;

    // 概念片段排序策略（V2-P3 多角色审查 L-4 修复）：
    // - 优先按 confidence 降序（V2-P3 起 ConceptEntry 含可选 confidence 字段）
    // - 无 confidence 时回退 relatedConcepts.length 降序（V2-P3 之前持久化的旧数据兜底）
    // - 关联概念多的概念更可能是核心业务概念（聚合根/实体）
    const concepts = [...dk.conceptLibrary]
      .sort((a, b) => {
        // L-4 修复：优先按推断置信度排序（@Entity+后缀双重匹配 0.9 > 仅后缀 0.75）
        const aConf = a.confidence ?? 0;
        const bConf = b.confidence ?? 0;
        if (aConf !== bConf) return bConf - aConf;
        // 无 confidence 或 confidence 相同时，回退 relatedConcepts.length 降序（向后兼容）
        return b.relatedConcepts.length - a.relatedConcepts.length;
      })
      .slice(0, MAX_DOMAIN_CONCEPT_SNIPPETS);
    for (const c of concepts) {
      // 仅在概念有 description 时注入（避免空描述挤占 Token）
      const desc = c.description ? `: ${c.description}` : "";
      const related = c.relatedConcepts.length > 0 ? ` (关联: ${c.relatedConcepts.join(", ")})` : "";
      snippets.push({
        type: DomainSnippetType.DOMAIN_CONCEPT,
        content: `[业务概念] ${c.name}${desc}${related}`,
        source: `global:domain:concept:${c.id}`,
        // relevance=0.85：领域知识高相关性，介于 UserProfile(1.0) 和 HistoricalExperience(0.8) 之间
        // 注：directRetain 片段不参与评分，relevance 仅作为降级截断排序依据（P2-2）
        relevance: 0.85,
      });
    }

    // 规则片段：按 priority 降序取 Top-N
    const rules = [...dk.ruleLibrary].sort((a, b) => b.priority - a.priority).slice(0, MAX_DOMAIN_RULE_SNIPPETS);
    for (const r of rules) {
      snippets.push({
        type: DomainSnippetType.DOMAIN_RULE,
        content: `[业务规则] ${r.rule} (scope: ${r.scope}, priority: ${r.priority})`,
        source: `global:domain:rule:${r.id}`,
        relevance: 0.85,
      });
    }

    return snippets;
  }

  /**
   * 收集推荐经验片段（V2-P3 全局层，P0-2 修复）
   *
   * P0-2 修复（架构师审查）：调用 recommend() 时传 { recordAccess: false }，
   * 避免预计算路径（buildOptimizedContext 每个 turn 入口调用一次）触发 recordAccess 写盘，
   * 导致 accessCount 异常膨胀（20 turn 会话让同一条经验 accessCount+20），污染 LRU 淘汰信号。
   * recordAccess 应由"经验被真正采纳/引用"时触发（如任务归档、用户显式确认）。
   *
   * 实现策略：
   *   - 调用 experienceRecommender.recommend(taskContext, MAX_EXPERIENCE_RECOMMENDATION_SNIPPETS, { recordAccess: false })
   *   - 成功经验：拼装 description + solution + reason（OPT-3：包含 reason 提升 LLM 可解释性）
   *   - 失败经验：拼装 description + failureReason + lessonLearned + reason
   *   - source 格式：global:experience:recommendation:<id>（供 P1-2 去重提取 id）
   *
   * 降级语义：
   *   - experienceRecommender 未注入：返回空数组
   *   - recommend() 异常：上层 try-catch 降级为空数组
   *   - 返回空推荐列表：返回空数组
   *
   * @param taskContext 任务上下文
   * @returns 推荐经验片段列表（最多 MAX_EXPERIENCE_RECOMMENDATION_SNIPPETS 条）
   */
  private collectRecommendedExperienceSnippets(taskContext: TaskContext): ContextSnippet[] {
    // experienceRecommender 未注入：返回空数组（降级语义）
    if (!this.experienceRecommender) {
      return [];
    }

    // 调用 recommend()，传 recordAccess: false（P0-2 修复）
    const recommendations: ExperienceRecommendation[] = this.experienceRecommender.recommend(
      taskContext,
      MAX_EXPERIENCE_RECOMMENDATION_SNIPPETS,
      { recordAccess: false }
    );

    const snippets: ContextSnippet[] = [];
    for (const rec of recommendations) {
      // 根据经验类型拼装 content（OPT-3：包含 reason 提升 LLM 可解释性）
      // rec.type 与 rec.experience 联合类型不直接关联，需类型断言收窄
      let content: string;
      if (rec.type === "success") {
        const exp = rec.experience as SuccessExperience;
        content = `[推荐成功经验] ${exp.taskType}: ${exp.description}\n解决方案: ${exp.solution}\n推荐理由: ${rec.reason}`;
      } else {
        const exp = rec.experience as FailureExperience;
        content = `[推荐失败教训] ${exp.taskType}: ${exp.description}\n失败原因: ${exp.failureReason}\n教训: ${exp.lessonLearned}\n推荐理由: ${rec.reason}`;
      }

      snippets.push({
        type: ExperienceSnippetType.EXPERIENCE_RECOMMENDATION,
        content,
        // source 格式：global:experience:recommendation:<id>（供 P1-2 去重提取 id）
        source: `global:experience:recommendation:${rec.experience.id}`,
        // relevance=0.85：RAG 推荐高相关性，高于兜底 HistoricalExperience(0.8)
        // 注：directRetain 片段不参与评分，relevance 仅作为降级截断排序依据（P2-2）
        relevance: 0.85,
      });
    }

    return snippets;
  }

  /**
   * 收集任务层片段（focusPoints / thoughtHistory / intermediateResults）
   *
   * @param taskContext 任务上下文
   * @returns 任务层片段列表
   */
  private collectTaskSnippets(taskContext: TaskContext): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    const wm = taskContext.workingMemory;

    // 任务定义片段（高相关性，必注入）
    snippets.push({
      type: "task_definition",
      content: `[任务] ${taskContext.taskDefinition.description}\n目标: ${taskContext.taskDefinition.goals.join("; ")}`,
      source: `task:${taskContext.taskId}:definition`,
      relevance: 1.0,
    });

    // focusPoints 片段（任务关注的文件/函数/概念）
    if (wm.focusPoints.length > 0) {
      const fpLines = wm.focusPoints.map((fp) => `- [${fp.type}] ${fp.ref} (优先级: ${fp.priority})`);
      snippets.push({
        type: "task_focus_points",
        content: `[关注点]\n${fpLines.join("\n")}`,
        source: `task:${taskContext.taskId}:focus_points`,
        relevance: 0.9,
      });
    }

    // thoughtHistory 片段（最近 N 条思考）
    const thoughts = wm.thoughtHistory.slice(-MAX_THOUGHT_SNIPPETS);
    if (thoughts.length > 0) {
      const thoughtLines = thoughts.map((t) => `- [${t.stage}] ${t.thought}`);
      snippets.push({
        type: "task_thoughts",
        content: `[思考历史]\n${thoughtLines.join("\n")}`,
        source: `task:${taskContext.taskId}:thoughts`,
        relevance: 0.7,
      });
    }

    // intermediateResults 片段（最近 N 条中间结果）
    const intermediates = wm.intermediateResults.slice(-MAX_INTERMEDIATE_SNIPPETS);
    if (intermediates.length > 0) {
      const interLines = intermediates.map((i) => `- [${i.source}] ${i.result}`);
      snippets.push({
        type: "task_intermediates",
        content: `[中间结果]\n${interLines.join("\n")}`,
        source: `task:${taskContext.taskId}:intermediates`,
        relevance: 0.7,
      });
    }

    return snippets;
  }

  /**
   * 收集文件层片段（从 CodeMap.files 提取 focusPoints 文件的内容）
   *
   * 策略：
   * - 从 taskContext.workingMemory.focusPoints 中提取 type="file" 的 ref
   * - 在 CodeMap.files 中查找对应 FileInfo
   * - 读取文件内容（前 N 行作为片段，避免全文挤占预算）
   *
   * 注意：本方法不做 I/O 读取（CodeMap 已含文件结构信息，但不含全文内容）。
   * P1 阶段仅注入文件元信息（路径 + 行数 + 类/函数列表），
   * 文件全文注入由 P2 ProgressiveContextLoader 接管（§6.5 完整版）。
   *
   * @param taskContext 任务上下文
   * @param codeMap CodeMap
   * @returns 文件层片段列表
   */
  private collectFileSnippets(taskContext: TaskContext, codeMap: CodeMap): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    const wm = taskContext.workingMemory;

    // 从 focusPoints 提取 file ref
    const filePaths = wm.focusPoints
      .filter((fp): fp is FocusPoint & { type: "file" } => fp.type === "file")
      .map((fp) => fp.ref);

    if (filePaths.length === 0) {
      return snippets;
    }

    // 构建 path → FileInfo 索引（O(1) 查找）
    // 同时支持相对路径和绝对路径作为 key（CodeMap.files[].path 是绝对路径，
    // 但 focusPoint.ref 可能是相对路径，兼容两种形态）
    const fileMap = new Map<string, FileInfo>();
    for (const f of codeMap.files) {
      // 绝对路径作为 key
      fileMap.set(f.path, f);
      // 相对路径（相对 projectRoot）作为 key
      const relPath = path.relative(this.config.projectRoot, f.path);
      if (relPath && !relPath.startsWith("..")) {
        fileMap.set(relPath, f);
        // POSIX 形态（/ 分隔符）作为 key（跨平台一致性）
        fileMap.set(relPath.split(path.sep).join("/"), f);
      }
    }

    // 为每个 focusPoint 文件生成元信息片段
    for (const filePath of filePaths) {
      const fileInfo = fileMap.get(filePath);
      if (!fileInfo) {
        // 文件不在 CodeMap 中：跳过（可能是新建文件或外部文件）
        continue;
      }

      // 构建文件元信息片段（不含全文，避免挤占预算）
      const lines: string[] = [];
      lines.push(`文件: ${fileInfo.path}`);
      lines.push(`语言: ${fileInfo.language}`);
      lines.push(`行数: ${fileInfo.lines}`);
      if (fileInfo.classes.length > 0) {
        lines.push(`类: ${fileInfo.classes.map((c) => c.name).join(", ")}`);
      }
      if (fileInfo.functions.length > 0) {
        lines.push(`函数: ${fileInfo.functions.map((f) => f.name).join(", ")}`);
      }
      if (fileInfo.exports.length > 0) {
        lines.push(`导出: ${fileInfo.exports.join(", ")}`);
      }

      snippets.push({
        type: "file_content",
        content: lines.join("\n"),
        source: `file:${fileInfo.path}`,
        // relevance 由 SlidingWindowManager 通过 scorer 计算后填充
        // 此处先给中性分，buildWindow 会覆盖
        relevance: 0.5,
      });
    }

    return snippets;
  }

  // ------------------------------------------------------------------------
  // 私有方法：降级路径的 Token 预算截断
  // ------------------------------------------------------------------------

  /**
   * 按 Token 预算截断候选片段（降级路径，无相关性评分）
   *
   * 当 CodeMap 不可用时，buildWindow 无法调用，使用本方法做简单截断：
   * - 按候选片段的 relevance 降序排序
   * - 按 charsPerToken=4 估算累计 token，超预算从低分端丢弃
   *
   * @param candidates 候选片段
   * @param maxTokens Token 预算
   * @returns 截断后的片段列表
   */
  private truncateByTokenBudget(candidates: ContextSnippet[], maxTokens: number): ContextSnippet[] {
    // 按 relevance 降序排序（无 relevance 视为 0）
    const sorted = [...candidates].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

    const result: ContextSnippet[] = [];
    let usedTokens = 0;
    const charsPerToken = 4; // 与 SlidingWindowManager 默认值一致

    for (const snippet of sorted) {
      const tokens = Math.ceil(snippet.content.length / charsPerToken);
      if (usedTokens + tokens > maxTokens) {
        break; // 超预算：停止追加
      }
      result.push(snippet);
      usedTokens += tokens;
    }

    return result;
  }
}
