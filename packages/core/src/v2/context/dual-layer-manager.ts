/**
 * 双层上下文管理器（DualLayerContextManager）—— V2-P1 集成入口
 *
 * 组装全局上下文 + 任务上下文 → 产出 session-hook 形态的 ContextSnippet[]，
 * 供编排器在 refreshContextAsync 中调用后 setSnippets 写入缓存。
 *
 * 设计依据：
 * - V2 技术方案 §5.2 双层上下文模型（GlobalContext + TaskContext）
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.4 DualLayerContextManager 契约
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.5 CodeMapProvider 接口
 * - NP-01 红线：preBuildContext 保持同步读缓存，本方法永不进热路径
 *
 * P1 裁剪（§3.4）：
 * - 无独立 TaskContextStore：任务层直接复用 P0b TaskContextManager（内存 Map）
 * - 无 syncContexts 双向方法：同步由 ContextSynchronizer 在归档回调中完成
 * - 产出物为 integration/session-hook 的 ContextSnippet 形态
 *   （{type, content, source, relevance?}），与 §5.2 的 ContextSnippet
 *   （{content, source, relevanceScore, tokenCount}）做形态映射，
 *   以 session-hook 契约为准（NP-01 集成红线，既有缓存结构不动）
 *
 * 候选片段收集策略（§5.2 双层模型）：
 * - 全局层：UserProfile（codeStyle/frameworkPreferences/behaviorPatterns）+
 *   HistoricalExperience（最近 N 条成功/失败经验）
 * - 任务层：TaskContext 的 focusPoints/thoughtHistory/intermediateResults
 * - 文件层：focusPoints(type=file) 的 ref 作为文件路径，从 CodeMap.files 提取内容片段
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
import type { GlobalContext, SuccessExperience, FailureExperience } from "./global-context";
import type { TaskContextManager } from "./task-context-manager";
import type { TaskContext, FocusPoint } from "./types";
import type { CodeMap, FileInfo } from "../codemap/generator";
import type { RelevanceScorer } from "./relevance-scorer";
import type { SlidingWindowManager } from "./sliding-window";
import type { SlidingWindowConfig } from "./sliding-window";
import type { RelevanceScoringConfig } from "./relevance-scorer";
import type { ContextSnippet } from "../integration/session-hook";

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

// ============================================================================
// DualLayerContextManager 实现
// ============================================================================

/**
 * 双层上下文管理器（V2-P1 集成入口）
 *
 * 使用方式：
 * ```typescript
 * const manager = new DualLayerContextManager(
 *   { projectRoot: "/path/to/project", window: {}, scoring: {}, defaultTokenBudget: 100000 },
 *   globalManager,
 *   taskManager,
 *   codeMapProvider,
 *   scorer,
 *   windowManager,
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
   * @param config 配置（必填 projectRoot）
   * @param globalManager 全局上下文管理器（P0a 既有）
   * @param taskManager 任务上下文管理器（P0b 既有）
   * @param codeMapProvider CodeMap 提供者
   * @param scorer 相关性评分器
   * @param window 滑动窗口管理器
   */
  constructor(
    config: Partial<DualLayerContextConfig> & Pick<DualLayerContextConfig, "projectRoot">,
    private readonly globalManager: GlobalContextManager,
    private readonly taskManager: TaskContextManager,
    private readonly codeMapProvider: CodeMapProvider,
    private readonly scorer: RelevanceScorer,
    private readonly window: SlidingWindowManager
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
   * 实现步骤：
   * 1. 从 globalManager 加载 GlobalContext（含 UserProfile + HistoricalExperience）
   * 2. 从 taskManager 加载 TaskContext（含 focusPoints/thoughtHistory 等）
   * 3. 从 codeMapProvider 获取 CodeMap
   * 4. 收集候选片段（全局层 + 任务层 + 文件层）
   * 5. 调用 window.buildWindow 做评分 + Top-K + Token 预算截断
   * 6. 返回 retainedSnippets（session-hook 形态）
   *
   * 降级语义：
   * - TaskContext 不存在：返回空数组（任务未创建或已归档）
   * - CodeMap 获取失败：仅返回全局层 + 任务层片段（文件层降级为空）
   * - GlobalContext 加载失败：globalManager 内部已降级返回默认空上下文
   *
   * @param userId 用户 ID
   * @param taskId 任务 ID
   * @param maxTokens 可选的 Token 预算覆盖（默认使用 config.defaultTokenBudget）
   * @returns 优化后的上下文片段列表（session-hook 形态）
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
    // 分离"直接保留片段"（全局层/任务层，不参与评分）与"评分片段"（文件层，由 scorer 评分）
    // 理由：SlidingWindowManager.buildWindow 假设非对话片段都是文件片段并对它们评分；
    //       全局层/任务层片段的 source 不是文件路径，评分时距离分会得 0.1（图未含），
    //       导致被 Top-K 截断掉。分离后直接保留片段不进评分，保证必注入。
    const directRetainSnippets: ContextSnippet[] = [];
    const scoringCandidates: ContextSnippet[] = [];

    // 4.1 全局层：UserProfile 片段（直接保留）
    const userProfileSnippets = this.collectUserProfileSnippets(globalContext);
    directRetainSnippets.push(...userProfileSnippets);

    // 4.2 全局层：HistoricalExperience 片段（直接保留）
    const experienceSnippets = this.collectExperienceSnippets(globalContext);
    directRetainSnippets.push(...experienceSnippets);

    // 4.3 任务层：focusPoints / thoughtHistory / intermediateResults 片段（直接保留）
    const taskSnippets = this.collectTaskSnippets(taskContext);
    directRetainSnippets.push(...taskSnippets);

    // 4.4 文件层：从 CodeMap.files 提取 focusPoints 文件内容片段（参与评分）
    if (codeMap) {
      const fileSnippets = this.collectFileSnippets(taskContext, codeMap);
      scoringCandidates.push(...fileSnippets);
    }

    // ---- 5. 调用 SlidingWindowManager 做评分 + Top-K + Token 预算截断 ----
    // 直接保留片段先扣除 Token 预算，剩余预算给评分片段
    const directTokens = this.estimateTokens(directRetainSnippets);
    const remainingBudget = Math.max(0, (maxTokens ?? this.config.defaultTokenBudget) - directTokens);

    let retainedScoringSnippets: ContextSnippet[] = [];
    if (codeMap && scoringCandidates.length > 0) {
      const result = this.window.buildWindow(scoringCandidates, taskContext, codeMap, remainingBudget);
      retainedScoringSnippets = result.retainedSnippets;
    } else if (scoringCandidates.length > 0) {
      // CodeMap 缺失时无法评分：简单截断评分候选
      retainedScoringSnippets = this.truncateByTokenBudget(scoringCandidates, remainingBudget);
    }

    // ---- 6. 合并：直接保留片段（前）+ 评分片段（后）----
    return [...directRetainSnippets, ...retainedScoringSnippets];
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
   * 收集 HistoricalExperience 片段（全局层）
   *
   * 提取最近 N 条成功 + 失败经验，封装为 ContextSnippet。
   * - 成功经验：solution 字段（解决方案摘要）
   * - 失败经验：lessonLearned 字段（教训）
   *
   * @param globalContext 全局上下文
   * @returns 经验片段列表（最多 MAX_EXPERIENCE_SNIPPETS 条）
   */
  private collectExperienceSnippets(globalContext: GlobalContext): ContextSnippet[] {
    const snippets: ContextSnippet[] = [];
    const exp = globalContext.historicalExperience;

    // 成功经验：按 createdAt 倒序取最近 N 条
    const successes = [...exp.successExperiences]
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

    // 失败经验：按 createdAt 倒序取最近 N 条
    const failures = [...exp.failureExperiences]
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
