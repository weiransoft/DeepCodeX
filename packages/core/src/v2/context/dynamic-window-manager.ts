/**
 * EAG-P6 Phase 2 DynamicWindowManager 协调器实现（DW-1~DW-3 按 LoopPhase 激活）
 *
 * 本模块提供 DynamicWindowManager 协调器，按 Loop 阶段动态决定激活哪些 DW 层，
 * 协调 CodeMapSnippetProvider 的三层供给（DW-1/DW-2/DW-3），并产出最终保留的
 * CodeMapSnippet 列表（已按相关性评分排序、已 Token 截断、已冻结）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-1（DynamicWindowManager）+ DW-1~DW-4 四层供给策略
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 1（DynamicWindowManager）
 *   + §6 数据流图（DW-1~DW-4 数据流向）
 *   + §5.2 激活规则表（按 LoopPhase 激活 DW 层）
 * - EAG-P6-TASKS.md §3 TASK-P6-2-03（DynamicWindowManager 协调器实现）
 *
 * 激活规则（与 EAG-P6-ARCHITECTURE.md §5.2 接口契约 1 对齐）：
 *
 * | Loop 阶段 | DW-1 焦点符号 | DW-2 爆炸半径 | DW-3 风险热点 | DW-4 语义检索 |
 * |----------|---------------|---------------|---------------|---------------|
 * | design   | ✅ 必注入      | ❌ 不激活     | ❌ 不激活     | ✅ agent 主动调用 |
 * | coding   | ✅ 必注入      | ✅ 参与评分   | ❌ 不激活     | ✅ agent 主动调用 |
 * | testing  | ✅ 必注入      | ✅ 参与评分   | ✅ 必注入     | ✅ agent 主动调用 |
 * | deploy   | ✅ 必注入      | ❌ 不激活     | ❌ 不激活     | ✅ agent 主动调用 |
 *
 * 注意：DW-4 codemap_search 工具走 tool-executor 独立路径（D-2 决策），
 * 不经 DynamicWindowManager.computeWindow。本类仅协调 DW-1/DW-2/DW-3。
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - "StaticSymbolGraph 必须是真实降级实现（基于 Map + BFS，不是 mock）"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 *
 * 相关性评分（简化版，复用 RelevanceScorer 思路）：
 * - distance 评分：d=0→1.0, d=1→0.7, d=2→0.4, d≥MAX_SAFE_INTEGER→0.1
 * - importance 评分：importance 直接使用（0-1）
 * - confidence 评分：HIGH=1.0, MEDIUM=0.7, LOW=0.4
 * - 综合评分：0.4 * distanceScore + 0.3 * importance + 0.3 * confidenceScore
 *
 * Token 估算（4 字符 ≈ 1 token，OpenAI 经验值）：
 * - 单个 CodeMapSnippet 的 token 数 = Math.ceil(估算字符数 / CHARS_PER_TOKEN)
 * - 估算字符数 = name + signature + summary + filePath 的字符数总和
 *
 * 降级保证（D-5 / FR-7）：
 * - isGraphStoreAvailable() 返回 false 时，computeWindow 返回空结果（零回归）
 * - CodeMapSnippetProvider 在降级模式下各方法返回空数组
 * - SlidingWindowManager 行为与 V2-P3 完全一致（零回归）
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 对外返回的 DynamicWindowResult / TokenBudgetAllocation 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/context/dynamic-window-manager
 */

import type { CodeMapSnippetProvider } from "./code-map-snippet-provider";
import { isGraphStoreAvailable } from "./symbol-graph-adapter";
import type { Confidence } from "./symbol-graph-types";
import { CONFIDENCE_WEIGHTS } from "./symbol-graph-types";
import {
  CHARS_PER_TOKEN,
  CODEMAP_BUDGET_RATIO,
  EMPTY_DYNAMIC_WINDOW_RESULT,
  EMPTY_TOKEN_BUDGET_ALLOCATION,
  LOW_RELEVANCE_THRESHOLD,
  OTHER_BUDGET_RATIO,
  type CodeMapSnippet,
  type DynamicWindowQuery,
  type DynamicWindowResult,
  type DynamicWindowSource,
  type LoopPhase,
  type TokenBudgetAllocation,
} from "./dynamic-window-types";

// ============================================================================
// 1. 内部辅助类型：带评分的片段
// ============================================================================

/**
 * 带相关性评分的 CodeMapSnippet（内部临时结构）
 *
 * 用于 computeWindow 内部排序与截断，记录每个片段的综合评分与来源。
 *
 * 字段：
 * - snippet：原始 CodeMapSnippet
 * - score：综合相关性评分（0-1）
 * - source：来源标识（"dw1" / "dw2" / "dw3"）
 */
interface ScoredSnippet {
  /** 原始 CodeMapSnippet */
  readonly snippet: CodeMapSnippet;
  /** 综合相关性评分（0-1） */
  readonly score: number;
  /** 来源标识（"dw1" / "dw2" / "dw3"） */
  readonly source: "dw1" | "dw2" | "dw3";
}

// ============================================================================
// 2. 相关性评分权重常量
// ============================================================================

/**
 * distance 评分权重（0.4）
 *
 * 综合评分 = 0.4 * distanceScore + 0.3 * importance + 0.3 * confidenceScore
 */
const DISTANCE_WEIGHT = 0.4;

/**
 * importance 评分权重（0.3）
 */
const IMPORTANCE_WEIGHT = 0.3;

/**
 * confidence 评分权重（0.3）
 */
const CONFIDENCE_WEIGHT = 0.3;

// ============================================================================
// 3. DynamicWindowManager 类
// ============================================================================

/**
 * 动态窗口管理器（DynamicWindowManager）
 *
 * 协调 DW-1~DW-4 四层供给，根据当前 Loop 阶段动态决定激活哪些层。
 *
 * 激活规则（与 EAG-P6-ARCHITECTURE.md §5.2 接口契约 1 对齐）：
 * - design：仅激活 DW-1（必注入 directRetain）
 * - coding：激活 DW-1（directRetain）+ DW-2（candidates 参与评分）
 * - testing：激活 DW-1（directRetain）+ DW-2（candidates）+ DW-3（directRetain）
 * - deploy：仅激活 DW-1
 *
 * 注意：DW-4 codemap_search 工具走 tool-executor 独立路径（D-2 决策），
 * 不经 DynamicWindowManager.computeWindow。本类仅协调 DW-1/DW-2/DW-3。
 *
 * 降级保证（D-5 / FR-7）：
 * - graphAvailability() 返回 false 时，computeWindow 返回空结果（零回归）
 * - CodeMapSnippetProvider 在降级模式下各方法返回空数组
 * - SlidingWindowManager 行为与 V2-P3 完全一致（零回归）
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const provider = new CodeMapSnippetProvider(adapter);
 * const manager = new DynamicWindowManager(provider);
 *
 * const query: DynamicWindowQuery = {
 *   focusPoints: ["UserService"],
 *   impactRoots: ["src/A.ts:UserService"],
 *   riskTopN: 5,
 *   maxSnippets: 30,
 *   role: "solo_coder",
 *   phase: "coding",
 * };
 *
 * const result = manager.computeWindow(query);
 * console.log(result.snippets.length); // 保留的片段数
 * console.log(result.totalTokens);     // Token 估算
 * console.log(result.source);          // "dw1" / "dw2" / "dw3" / "mixed"
 * ```
 */
export class DynamicWindowManager {
  /**
   * CodeMap 片段提供者（DW-1/DW-2/DW-3 数据源）
   *
   * 由 CodeMapSnippetProvider 实现，封装 SymbolGraphAdapter 查询能力。
   */
  private readonly snippetProvider: CodeMapSnippetProvider;

  /**
   * 图谱可用性探测函数（默认 isGraphStoreAvailable）
   *
   * 用于降级判断：返回 false 时，computeWindow 返回空结果（零回归）。
   */
  private readonly graphAvailability: () => boolean;

  /**
   * 构造动态窗口管理器
   *
   * @param snippetProvider CodeMap 片段提供者（DW-1/DW-2/DW-3 数据源）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(snippetProvider: CodeMapSnippetProvider, graphAvailability: () => boolean = isGraphStoreAvailable) {
    this.snippetProvider = snippetProvider;
    this.graphAvailability = graphAvailability;
  }

  // --------------------------------------------------------------------------
  // computeWindow：协调 DW-1~DW-3，产出最终保留的片段列表
  // --------------------------------------------------------------------------

  /**
   * 收集图谱上下文片段，按 Loop 阶段协调四层供给
   *
   * 算法步骤：
   * 1. 降级判断：graphAvailability() 返回 false 时返回空结果（零回归）
   * 2. 按 loopPhase 激活 DW 层：
   *    - design/deploy：仅激活 DW-1
   *    - coding：激活 DW-1 + DW-2
   *    - testing：激活 DW-1 + DW-2 + DW-3
   * 3. 收集各 DW 层产出的 CodeMapSnippet
   * 4. 计算每个片段的综合相关性评分（distance + importance + confidence）
   * 5. 丢弃低评分片段（score < LOW_RELEVANCE_THRESHOLD=0.1）
   * 6. 按综合评分降序排序
   * 7. 按 maxSnippets 截断
   * 8. 估算 Token 数（4 字符 ≈ 1 token）
   * 9. 确定来源标识（dw1/dw2/dw3/mixed）
   * 10. 冻结返回 DynamicWindowResult
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回 EMPTY_DYNAMIC_WINDOW_RESULT（零回归）
   * - CodeMapSnippetProvider 各方法在降级模式下返回空数组
   *
   * 边界处理：
   * - query.focusPoints 为空数组：DW-1 返回空数组
   * - query.impactRoots 为空数组或 undefined：DW-2 返回空数组
   * - query.riskTopN 为 0 或负数：DW-3 返回空数组
   * - query.maxSnippets 为 0 或负数：返回空结果
   *
   * @param query 动态窗口查询参数（含 focusPoints / impactRoots / riskTopN / maxSnippets / phase）
   * @returns 动态窗口结果（含片段列表、Token 估算、来源标识、低相关性丢弃统计，已冻结）
   */
  readonly computeWindow = (query: DynamicWindowQuery): DynamicWindowResult => {
    // ---------- 1. 降级判断 ----------
    // graphAvailability() 返回 false 时返回空结果（零回归）
    if (!this.graphAvailability()) {
      return EMPTY_DYNAMIC_WINDOW_RESULT;
    }

    // ---------- 2. 边界处理 ----------
    // query 为 null/undefined 或 maxSnippets <= 0 时返回空结果
    if (query === null || query === undefined) {
      return EMPTY_DYNAMIC_WINDOW_RESULT;
    }
    if (typeof query.maxSnippets !== "number" || query.maxSnippets <= 0) {
      return EMPTY_DYNAMIC_WINDOW_RESULT;
    }

    // ---------- 3. 按 loopPhase 激活 DW 层 ----------
    // 收集各 DW 层产出的 CodeMapSnippet，附带来源标识
    const phase: LoopPhase = query.phase;
    const collectedSnippets: ScoredSnippet[] = [];

    // 3.1 DW-1 焦点符号直供（design/coding/testing/deploy 均激活）
    const dw1Snippets = this.snippetProvider.getDirectRetainSnippets(query.focusPoints);
    for (const snippet of dw1Snippets) {
      const score = this.computeSnippetScore(snippet);
      collectedSnippets.push({ snippet, score, source: "dw1" });
    }

    // 3.2 DW-2 爆炸半径（仅 coding/testing 激活）
    if (phase === "coding" || phase === "testing") {
      const impactRoots = query.impactRoots ?? [];
      if (impactRoots.length > 0) {
        const dw2Snippets = this.snippetProvider.getImpactSnippets(impactRoots);
        for (const snippet of dw2Snippets) {
          const score = this.computeSnippetScore(snippet);
          collectedSnippets.push({ snippet, score, source: "dw2" });
        }
      }
    }

    // 3.3 DW-3 风险热点（仅 testing 激活）
    if (phase === "testing") {
      const riskTopN = query.riskTopN;
      const dw3Snippets = this.snippetProvider.getRiskHotspotSnippets(riskTopN);
      for (const snippet of dw3Snippets) {
        const score = this.computeSnippetScore(snippet);
        collectedSnippets.push({ snippet, score, source: "dw3" });
      }
    }

    // ---------- 4. 丢弃低评分片段 ----------
    // 评分低于 LOW_RELEVANCE_THRESHOLD=0.1 的片段被丢弃
    // 注：DW-1 焦点符号（distance=0, confidence=HIGH）必注入，理论上评分 ≥ 0.7，
    //     不会被丢弃；DW-2/DW-3 片段可能因 distance/importance 过低被丢弃
    let droppedLowRelevance = 0;
    const retainedSnippets: ScoredSnippet[] = [];
    for (const scored of collectedSnippets) {
      if (scored.score < LOW_RELEVANCE_THRESHOLD) {
        droppedLowRelevance++;
        continue;
      }
      retainedSnippets.push(scored);
    }

    // ---------- 5. 按综合评分降序排序 ----------
    // 评分高的在前，同分内按 symbolId 升序（稳定排序，便于测试断言）
    retainedSnippets.sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-9) {
        return diff;
      }
      return a.snippet.symbolId.localeCompare(b.snippet.symbolId);
    });

    // ---------- 6. 按 maxSnippets 截断 ----------
    // 超出 maxSnippets 的片段被丢弃（不计入 droppedLowRelevance，因为是超量截断而非低评分）
    const truncatedSnippets = retainedSnippets.slice(0, query.maxSnippets);

    // ---------- 7. 估算 Token 数 ----------
    // 4 字符 ≈ 1 token（OpenAI 经验值）
    // 估算字符数 = name + signature + summary + filePath 的字符数总和
    const finalSnippets: CodeMapSnippet[] = truncatedSnippets.map((s) => s.snippet);
    const totalTokens = this.estimateTokens(finalSnippets);

    // ---------- 8. 确定来源标识 ----------
    // 统计各来源的片段数，决定 source 字段
    const source = this.determineSource(truncatedSnippets);

    // ---------- 9. 构建并冻结返回结果 ----------
    const result: DynamicWindowResult = {
      snippets: Object.freeze(finalSnippets.slice()) as ReadonlyArray<CodeMapSnippet>,
      totalTokens,
      source,
      droppedLowRelevance,
    };

    return Object.freeze(result) as DynamicWindowResult;
  };

  // --------------------------------------------------------------------------
  // allocateTokenBudget：30% codemap + 70% 其他
  // --------------------------------------------------------------------------

  /**
   * 分配 Token 预算（30% codemap + 70% 其他）
   *
   * 分配规则（D-6 决策）：
   * - codemapBudget = totalBudget * CODEMAP_BUDGET_RATIO（默认 30%）
   * - otherBudget = totalBudget - codemapBudget（默认 70%）
   *
   * 使用统计：
   * - codemapUsed：实际 codemap 片段消耗的 Token 数（≤ codemapBudget）
   * - otherUsed：实际其他片段消耗的 Token 数（≤ otherBudget）
   *
   * 用途：
   * - SlidingWindowManager 按此分配分别截断两类片段
   * - DynamicWindowManager 在 computeWindow 中填充实际使用量，供审计与日志追踪
   *
   * 边界处理：
   * - totalBudget <= 0：返回 EMPTY_TOKEN_BUDGET_ALLOCATION
   * - totalBudget 非数字：返回 EMPTY_TOKEN_BUDGET_ALLOCATION
   *
   * @param totalBudget 总 Token 预算
   * @param codemapUsed 实际 codemap 片段消耗的 Token 数（默认 0）
   * @param otherUsed 实际其他片段消耗的 Token 数（默认 0）
   * @returns Token 预算分配结构（已冻结）
   */
  readonly allocateTokenBudget = (
    totalBudget: number,
    codemapUsed: number = 0,
    otherUsed: number = 0
  ): TokenBudgetAllocation => {
    // ---------- 边界处理 ----------
    if (typeof totalBudget !== "number" || totalBudget <= 0 || !Number.isFinite(totalBudget)) {
      return EMPTY_TOKEN_BUDGET_ALLOCATION;
    }

    // ---------- 计算预算分配 ----------
    // codemapBudget = totalBudget * 0.3，向下取整避免超预算
    const codemapBudget = Math.floor(totalBudget * CODEMAP_BUDGET_RATIO);
    // otherBudget = totalBudget - codemapBudget（避免浮点误差，使用减法而非乘法）
    const otherBudget = totalBudget - codemapBudget;

    // ---------- 规范化实际使用量 ----------
    // codemapUsed / otherUsed 不能为负数，不能超过对应预算
    const safeCodemapUsed =
      typeof codemapUsed === "number" && codemapUsed >= 0 ? Math.min(codemapUsed, codemapBudget) : 0;
    const safeOtherUsed = typeof otherUsed === "number" && otherUsed >= 0 ? Math.min(otherUsed, otherBudget) : 0;

    // ---------- 构建并冻结返回结果 ----------
    const allocation: TokenBudgetAllocation = {
      codemapBudget,
      otherBudget,
      codemapUsed: safeCodemapUsed,
      otherUsed: safeOtherUsed,
    };

    return Object.freeze(allocation) as TokenBudgetAllocation;
  };

  // --------------------------------------------------------------------------
  // 内部辅助方法
  // --------------------------------------------------------------------------

  /**
   * 计算单个 CodeMapSnippet 的综合相关性评分
   *
   * 评分公式：
   *   totalScore = DISTANCE_WEIGHT * distanceScore
   *              + IMPORTANCE_WEIGHT * importance
   *              + CONFIDENCE_WEIGHT * confidenceScore
   *
   * 评分维度：
   * 1. distance 评分（权重 0.4）：
   *    - d=0 → 1.0（焦点符号本身，最高分）
   *    - d=1 → 0.7（一跳邻居）
   *    - d=2 → 0.4（两跳邻居）
   *    - d=Number.MAX_SAFE_INTEGER → 0.1（不参与距离评分，如 DW-3 风险热点）
   *    - 其他 → 0.1（远距离符号）
   *
   * 2. importance 评分（权重 0.3）：
   *    - 直接使用 SymbolRecord.importance（0-1）
   *
   * 3. confidence 评分（权重 0.3）：
   *    - HIGH = 1.0
   *    - MEDIUM = 0.7
   *    - LOW = 0.4
   *
   * @param snippet CodeMap 片段
   * @returns 综合相关性评分（0-1）
   */
  private readonly computeSnippetScore = (snippet: CodeMapSnippet): number => {
    // ---------- 1. distance 评分 ----------
    const distanceScore = this.scoreDistance(snippet.distance);

    // ---------- 2. importance 评分 ----------
    // importance 直接使用（0-1），防御性处理负数与超 1 的情况
    const importanceScore = Math.max(0, Math.min(1, snippet.importance));

    // ---------- 3. confidence 评分 ----------
    const confidenceScore = this.scoreConfidence(snippet.confidence);

    // ---------- 4. 综合评分 ----------
    const totalScore =
      DISTANCE_WEIGHT * distanceScore + IMPORTANCE_WEIGHT * importanceScore + CONFIDENCE_WEIGHT * confidenceScore;

    // 防御性处理：确保评分在 [0, 1] 范围内
    return Math.max(0, Math.min(1, totalScore));
  };

  /**
   * distance 评分映射
   *
   * 映射表（与 RelevanceScorer 距离分映射表对齐）：
   * - d=0 → 1.0（焦点符号本身，最高分）
   * - d=1 → 0.7（一跳邻居）
   * - d=2 → 0.4（两跳邻居）
   * - d=Number.MAX_SAFE_INTEGER → 0.1（不参与距离评分，如 DW-3 风险热点）
   * - 其他 → 0.1（远距离符号）
   *
   * @param distance BFS 距离
   * @returns distance 评分（0-1）
   */
  private readonly scoreDistance = (distance: number): number => {
    // 焦点符号本身（DW-1）
    if (distance === 0) {
      return 1.0;
    }
    // 一跳邻居（DW-2 直接边）
    if (distance === 1) {
      return 0.7;
    }
    // 两跳邻居（DW-2 间接边）
    if (distance === 2) {
      return 0.4;
    }
    // 远距离或不参与距离评分（DW-3 风险热点 / DW-4 语义检索）
    return 0.1;
  };

  /**
   * confidence 评分映射
   *
   * 映射表（与 CONFIDENCE_WEIGHTS 对齐）：
   * - HIGH = 1.0
   * - MEDIUM = 0.7
   * - LOW = 0.4
   *
   * @param confidence 边置信度
   * @returns confidence 评分（0-1）
   */
  private readonly scoreConfidence = (confidence: Confidence): number => {
    return CONFIDENCE_WEIGHTS[confidence];
  };

  /**
   * 估算 CodeMapSnippet 列表的 Token 数
   *
   * 估算规则（4 字符 ≈ 1 token，OpenAI 经验值）：
   * - 单个片段的估算字符数 = name + signature + summary + filePath 的字符数总和
   * - 单个片段的 Token 数 = Math.ceil(估算字符数 / CHARS_PER_TOKEN)
   * - 列表总 Token 数 = 所有片段 Token 数总和
   *
   * @param snippets CodeMapSnippet 列表
   * @returns Token 估算数
   */
  private readonly estimateTokens = (snippets: ReadonlyArray<CodeMapSnippet>): number => {
    let totalChars = 0;
    for (const snippet of snippets) {
      // 估算字符数 = name + signature + summary + filePath 的字符数总和
      // 防御性处理：可选字段可能为 undefined
      const nameChars = typeof snippet.name === "string" ? snippet.name.length : 0;
      const signatureChars = typeof snippet.signature === "string" ? snippet.signature.length : 0;
      const summaryChars = typeof snippet.summary === "string" ? snippet.summary.length : 0;
      const filePathChars = typeof snippet.filePath === "string" ? snippet.filePath.length : 0;
      totalChars += nameChars + signatureChars + summaryChars + filePathChars;
    }
    // 4 字符 ≈ 1 token，向上取整避免低估
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  };

  /**
   * 确定动态窗口结果的来源标识
   *
   * 规则：
   * - 仅含 DW-1 片段 → "dw1"
   * - 仅含 DW-2 片段 → "dw2"
   * - 仅含 DW-3 片段 → "dw3"
   * - 多来源混合 → "mixed"
   * - 无片段 → "dw1"（默认值，与 EMPTY_DYNAMIC_WINDOW_RESULT 一致）
   *
   * @param snippets 带来源标识的片段列表
   * @returns 来源标识
   */
  private readonly determineSource = (snippets: ReadonlyArray<ScoredSnippet>): DynamicWindowSource => {
    // 无片段：返回默认值 "dw1"
    if (snippets.length === 0) {
      return "dw1";
    }

    // 统计各来源的片段数
    const sourceSet = new Set<"dw1" | "dw2" | "dw3">();
    for (const scored of snippets) {
      sourceSet.add(scored.source);
    }

    // 单一来源
    if (sourceSet.size === 1) {
      const onlySource = sourceSet.values().next().value;
      return onlySource as DynamicWindowSource;
    }

    // 多来源混合
    return "mixed";
  };
}
