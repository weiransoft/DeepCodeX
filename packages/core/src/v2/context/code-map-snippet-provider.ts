/**
 * EAG-P6 Phase 2 CodeMapSnippetProvider 实现（DW-1/DW-2/DW-3 三层片段提取 + DW-4 语义检索）
 *
 * 本模块提供 CodeMap 片段的四层供给策略实现：
 * - DW-1 焦点符号直供（getDirectRetainSnippets）：上限 3 片段，必注入，不经评分
 * - DW-2 爆炸半径动态注入（getImpactSnippets）：参与评分竞争，无硬上限
 * - DW-3 风险热点按需拉取（getRiskHotspotSnippets）：上限 5 片段，TESTING 阶段必见
 * - DW-4 语义检索即时查（searchByQuery）：agent tool 调用，单轮 ≤5 次
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-2（CodeMapSnippetProvider）+ DW-1~DW-4 四层供给策略
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 2（CodeMapSnippetProvider）
 *   + §6 数据流图（DW-1/DW-2/DW-3/DW-4 数据流向）
 * - EAG-P6-TASKS.md §3 TASK-P6-2-02（CodeMapSnippetProvider 实现）
 *
 * 与 Phase 1 SymbolGraphAdapter 的关系：
 * - 本类通过 SymbolGraphAdapter 接口查询图谱，不直接依赖 V2-P4 graph-store 实现
 * - V2-P4 未实施时，DefaultSymbolGraphAdapter 返回空数组，本类所有方法返回空数组（降级）
 * - V2-P4 实施后，可替换为 GraphStoreSymbolGraphAdapter，本类零修改（依赖倒置）
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - "StaticSymbolGraph 必须是真实降级实现（基于 Map + BFS，不是 mock）"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 *
 * 算法说明：
 * - DW-1：调用 adapter.queryByName(focusPoint, limit) 获取焦点符号
 *   - distance = 0（焦点符号本身）
 *   - confidence = "HIGH"（焦点符号必注入，置信度最高）
 * - DW-2：调用 adapter.getExplosionRadius(rootId, maxDepth=2, maxNodes=50)
 *   获取影响面符号集，对每个符号通过 getEdges 计算 distance 与 confidence
 *   - distance：1（直接边）或 2（间接边，BFS 2 跳）
 *   - confidence：路径上最弱边的 confidence（HIGH > MEDIUM > LOW）
 * - DW-3：调用 adapter.getRiskHotspots(topN=5) 获取风险热点
 *   - distance = Number.MAX_SAFE_INTEGER（不参与距离评分，按 importance 排序）
 *   - confidence = "HIGH"（风险热点按 importance 排序，统一为 HIGH）
 * - DW-4：调用 adapter.searchByQuery(query, limit) 获取语义检索结果
 *   - distance = Number.MAX_SAFE_INTEGER（不参与距离评分）
 *   - confidence = "HIGH"（语义检索结果统一为 HIGH）
 *
 * 性能考量：
 * - DW-2 distance/confidence 计算需要调用 getEdges，复杂度 O(V*E)
 *   受 DEFAULT_EXPLOSION_RADIUS_MAX_NODES=50 限制，单次 DW-2 调用最多 50 次 getEdges
 * - DW-1/DW-3/DW-4 不调用 getEdges，直接使用 adapter 查询结果
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 对外返回的 CodeMapSnippet 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/context/code-map-snippet-provider
 */

import type { SymbolGraphAdapter } from "./symbol-graph-adapter";
import { isGraphStoreAvailable } from "./symbol-graph-adapter";
import type { Confidence, EdgeRecord, SymbolRecord } from "./symbol-graph-types";
import { CONFIDENCE_WEIGHTS } from "./symbol-graph-types";
import {
  CODEMAP_SNIPPET_TYPE,
  DEFAULT_EXPLOSION_RADIUS_DEPTH,
  DEFAULT_EXPLOSION_RADIUS_MAX_NODES,
  EMPTY_CODEMAP_SNIPPETS,
  MAX_DW1_SYMBOL_SNIPPETS,
  MAX_DW3_RISK_SNIPPETS,
  type CodeMapSnippet,
} from "./dynamic-window-types";

// ============================================================================
// 1. 内部辅助类型：DW-2 距离与置信度计算结果
// ============================================================================

/**
 * DW-2 距离与置信度计算结果
 *
 * 用于 getImpactSnippets 内部，记录每个影响面符号到根符号的 BFS 距离
 * 与路径上最弱边的置信度。
 *
 * 字段：
 * - distance：BFS 跳数（1=直接边 / 2=间接边）
 * - confidence：路径上最弱边的置信度（HIGH > MEDIUM > LOW）
 */
interface DistanceAndConfidence {
  /** BFS 跳数（1=直接边 / 2=间接边） */
  readonly distance: number;
  /** 路径上最弱边的置信度（HIGH > MEDIUM > LOW） */
  readonly confidence: Confidence;
}

// ============================================================================
// 2. CodeMapSnippetProvider 类
// ============================================================================

/**
 * CodeMap 片段提供者（DW-1/DW-2/DW-3 片段提取 + DW-4 语义检索）
 *
 * 从 V2-P4 符号图谱（通过 SymbolGraphAdapter 接口）提取 CodeMap 片段，
 * 按 DW-1 / DW-2 / DW-3 / DW-4 四种类型封装。
 *
 * 实现要求（与 PM 文档 FR-2 对齐）：
 * - DW-1 上限 3 片段（D-3：防挤占预算）
 * - DW-2 参与评分竞争（注入 candidates 池而非 directRetain，无硬上限）
 * - DW-3 上限 5 片段（D-3：测试专家必见）
 * - DW-4 单轮 ≤5 次（D-3：agent tool 调用上限，由 tool-executor 强制）
 * - 降级：isGraphStoreAvailable() 返回 false 或 adapter.isAvailable() 返回 false 时
 *   全部返回空数组（零回归）
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const provider = new CodeMapSnippetProvider(adapter);
 *
 * // DW-1: 焦点符号直供
 * const dw1 = provider.getDirectRetainSnippets(["UserService"]);
 * console.log(dw1.length); // ≤3
 *
 * // DW-2: 爆炸半径
 * const dw2 = provider.getImpactSnippets(["src/A.ts:UserService"]);
 * console.log(dw2.length); // 影响面符号数
 *
 * // DW-3: 风险热点
 * const dw3 = provider.getRiskHotspotSnippets(5);
 * console.log(dw3.length); // ≤5
 *
 * // DW-4: 语义检索
 * const dw4 = provider.searchByQuery("user login token", 10);
 * console.log(dw4.length); // ≤10
 * ```
 */
export class CodeMapSnippetProvider {
  /**
   * V2-P4 符号图谱适配层（依赖倒置，通过接口访问图谱）
   *
   * 实现类：
   * - DefaultSymbolGraphAdapter：降级实现，所有方法返回空数组
   * - StaticSymbolGraph：基于 Map + BFS 的真实降级实现
   * - GraphStoreSymbolGraphAdapter：V2-P4 实施后的真实图谱实现（P5/P6 Phase 6 提供）
   */
  private readonly symbolGraphAdapter: SymbolGraphAdapter;

  /**
   * 图谱可用性探测函数（默认 isGraphStoreAvailable）
   *
   * 用于双层降级判断：
   * 1. isGraphStoreAvailable() 探测 V2-P4 图谱存储是否可用（环境级探测）
   * 2. adapter.isAvailable() 探测适配层是否可用（实例级探测）
   *
   * 任一返回 false 时，所有 collect* 方法返回空数组（零回归）。
   */
  private readonly graphAvailability: () => boolean;

  /**
   * 构造 CodeMap 片段提供者
   *
   * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可用时返回空结果）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(symbolGraphAdapter: SymbolGraphAdapter, graphAvailability: () => boolean = isGraphStoreAvailable) {
    // 冻结 adapter 引用（adapter 自身应为不可变，由实现类保证）
    this.symbolGraphAdapter = symbolGraphAdapter;
    this.graphAvailability = graphAvailability;
  }

  // --------------------------------------------------------------------------
  // DW-1: 焦点符号直供（getDirectRetainSnippets）
  // --------------------------------------------------------------------------

  /**
   * DW-1 焦点符号直供（type: "codemap_symbol"，上限 3 片段）
   *
   * 数据流：
   * 1. 接收 focusPoints（焦点符号名或符号 ID 列表，来自任务卡 focusPoints）
   * 2. V2-P4 可用时：对每个 focusPoint 调用 adapter.queryByName(focusPoint, limit)
   *    获取匹配的符号列表
   * 3. 截断为 Top-3（MAX_DW1_SYMBOL_SNIPPETS，D-3 决策）
   * 4. 每个 CodeMapSnippet：
   *    - type: "codemap_symbol"
   *    - distance: 0（焦点符号本身，必注入）
   *    - confidence: "HIGH"（焦点符号必注入，置信度最高）
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回空数组（零回归）
   * - adapter.isAvailable() 返回 false：返回空数组（零回归）
   * - focusPoints 为空数组：返回空数组（无焦点符号可查）
   *
   * 边界处理：
   * - focusPoint 不匹配任何符号：跳过该 focusPoint
   * - 多个 focusPoint 匹配同一符号：去重（按 symbolId）
   * - 截断到 MAX_DW1_SYMBOL_SNIPPETS=3 条
   *
   * @param focusPoints 焦点符号名或符号 ID 列表
   * @returns DW-1 片段列表（最多 3 片段，type: "codemap_symbol"，已冻结）
   */
  readonly getDirectRetainSnippets = (focusPoints: ReadonlyArray<string>): ReadonlyArray<CodeMapSnippet> => {
    // ---------- 1. 降级判断 ----------
    // 双层降级：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即降级
    if (!this.isAvailable()) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 2. 边界处理 ----------
    // focusPoints 为空数组或非数组：返回空数组（无焦点符号可查）
    if (!Array.isArray(focusPoints) || focusPoints.length === 0) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 3. 收集焦点符号 ----------
    // 对每个 focusPoint 调用 queryByName 获取匹配的符号
    // 使用 Set 去重（按 symbolId），避免多个 focusPoint 匹配同一符号
    const collectedSymbols: SymbolRecord[] = [];
    const seenSymbolIds = new Set<string>();

    for (const focusPoint of focusPoints) {
      // 截断到 MAX_DW1_SYMBOL_SNIPPETS=3 条
      if (collectedSymbols.length >= MAX_DW1_SYMBOL_SNIPPETS) {
        break;
      }

      // 边界处理：focusPoint 为空字符串或非字符串时跳过
      if (typeof focusPoint !== "string" || focusPoint.length === 0) {
        continue;
      }

      // 调用 adapter.queryByName 获取匹配的符号
      // limit 设为 MAX_DW1_SYMBOL_SNIPPETS，由 adapter 内部截断
      const matchedSymbols = this.symbolGraphAdapter.queryByName(focusPoint, MAX_DW1_SYMBOL_SNIPPETS);

      // 将匹配的符号加入收集列表（去重）
      for (const sym of matchedSymbols) {
        if (collectedSymbols.length >= MAX_DW1_SYMBOL_SNIPPETS) {
          break;
        }
        if (seenSymbolIds.has(sym.symbolId)) {
          continue;
        }
        seenSymbolIds.add(sym.symbolId);
        collectedSymbols.push(sym);
      }
    }

    // ---------- 4. 转换为 CodeMapSnippet ----------
    // 每个符号转换为 DW-1 片段：
    // - type: "codemap_symbol"
    // - distance: 0（焦点符号本身）
    // - confidence: "HIGH"（焦点符号必注入，置信度最高）
    const snippets: CodeMapSnippet[] = collectedSymbols.map((sym) =>
      this.symbolToSnippet(
        sym,
        CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL,
        0, // distance = 0（焦点符号本身）
        "HIGH" // confidence = HIGH（焦点符号必注入）
      )
    );

    // ---------- 5. 冻结返回 ----------
    return Object.freeze(snippets);
  };

  // --------------------------------------------------------------------------
  // DW-2: 爆炸半径动态注入（getImpactSnippets）
  // --------------------------------------------------------------------------

  /**
   * DW-2 爆炸半径动态注入（type: "codemap_impact"，参与评分竞争）
   *
   * 数据流：
   * 1. 接收 impactRoots（影响根符号 ID 列表，来自 changedFiles 派生）
   * 2. V2-P4 可用时：对每个 impactRoot 调用 adapter.getExplosionRadius(
   *    rootId, maxDepth=2, maxNodes=50) 获取影响面符号集
   * 3. 不截断（参与评分竞争，由 SlidingWindowManager Token 预算截断）
   * 4. 每个 CodeMapSnippet：
   *    - type: "codemap_impact"
   *    - distance: 1（直接边）或 2（间接边，BFS 2 跳）
   *    - confidence: 路径上最弱边的 confidence（HIGH > MEDIUM > LOW）
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回空数组（零回归）
   * - adapter.isAvailable() 返回 false：返回空数组（零回归）
   * - impactRoots 为空数组：返回空数组（无影响根可查）
   *
   * 边界处理：
   * - impactRoot 不存在于图谱中：getExplosionRadius 返回空数组，跳过该 root
   * - 多个 impactRoot 的影响面重叠：去重（按 symbolId）
   * - 不包含 impactRoot 本身（DW-2 只返回影响面，不返回根符号）
   *
   * 性能考量：
   * - 对每个 impactRoot 调用一次 getExplosionRadius（BFS，受 maxDepth/maxNodes 限制）
   * - 对每个返回的符号调用 getEdges 计算 distance 与 confidence
   * - 单次 DW-2 调用最多 impactRoots.length * 50 次 getEdges（受 maxNodes=50 限制）
   *
   * @param impactRoots 影响根符号 ID 列表
   * @returns DW-2 片段列表（type: "codemap_impact"，无硬上限，已冻结）
   */
  readonly getImpactSnippets = (impactRoots: ReadonlyArray<string>): ReadonlyArray<CodeMapSnippet> => {
    // ---------- 1. 降级判断 ----------
    if (!this.isAvailable()) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 2. 边界处理 ----------
    if (!Array.isArray(impactRoots) || impactRoots.length === 0) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 3. 收集影响面符号 ----------
    // 对每个 impactRoot 调用 getExplosionRadius 获取影响面符号集
    // 使用 Set 去重（按 symbolId），避免多个 root 的影响面重叠
    const collectedSnippets: CodeMapSnippet[] = [];
    const seenSymbolIds = new Set<string>();

    // 同时收集 impactRoot 本身的 symbolId 集合，用于过滤根符号
    // impactRoots 可能是符号名或符号 ID，统一通过 queryByName 解析为 symbolId
    const rootSymbolIds = new Set<string>();
    for (const root of impactRoots) {
      if (typeof root !== "string" || root.length === 0) {
        continue;
      }
      // 直接加入 root（假设 root 是 symbolId）
      rootSymbolIds.add(root);
      // 同时按 name 查询，将匹配的 symbolId 也加入（覆盖 root 是符号名的情况）
      const matchedRoots = this.symbolGraphAdapter.queryByName(root, 10);
      for (const matched of matchedRoots) {
        rootSymbolIds.add(matched.symbolId);
      }
    }

    // 对每个 root 执行 BFS 获取影响面
    for (const rootId of rootSymbolIds) {
      // 调用 adapter.getExplosionRadius 获取影响面符号集
      // maxDepth=2（DEFAULT_EXPLOSION_RADIUS_DEPTH），maxNodes=50（DEFAULT_EXPLOSION_RADIUS_MAX_NODES）
      const impactedSymbols = this.symbolGraphAdapter.getExplosionRadius(
        rootId,
        DEFAULT_EXPLOSION_RADIUS_DEPTH,
        DEFAULT_EXPLOSION_RADIUS_MAX_NODES
      );

      // 对每个影响面符号，计算 distance 与 confidence，转换为 CodeMapSnippet
      for (const sym of impactedSymbols) {
        // 去重：已收集的符号跳过
        if (seenSymbolIds.has(sym.symbolId)) {
          continue;
        }
        // 排除 impactRoot 本身（DW-2 只返回影响面，不返回根符号）
        if (rootSymbolIds.has(sym.symbolId)) {
          continue;
        }
        seenSymbolIds.add(sym.symbolId);

        // 计算 distance 与 confidence（通过 getEdges 检查直接边）
        const dc = this.computeDistanceAndConfidence(rootId, sym.symbolId);

        // 转换为 CodeMapSnippet
        const snippet = this.symbolToSnippet(sym, CODEMAP_SNIPPET_TYPE.CODEMAP_IMPACT, dc.distance, dc.confidence);
        collectedSnippets.push(snippet);
      }
    }

    // ---------- 4. 冻结返回 ----------
    return Object.freeze(collectedSnippets);
  };

  // --------------------------------------------------------------------------
  // DW-3: 风险热点按需拉取（getRiskHotspotSnippets）
  // --------------------------------------------------------------------------

  /**
   * DW-3 风险热点按需拉取（type: "codemap_risk"，上限 5 片段，TESTING 阶段必见）
   *
   * 数据流：
   * 1. 接收 topN（风险热点 Top-N，默认 MAX_DW3_RISK_SNIPPETS=5，最大 10）
   * 2. V2-P4 可用时：调用 adapter.getRiskHotspots(topN) 获取风险热点符号
   * 3. 截断为 Top-5（MAX_DW3_RISK_SNIPPETS，D-3 决策）
   * 4. 每个 CodeMapSnippet：
   *    - type: "codemap_risk"
   *    - distance: Number.MAX_SAFE_INTEGER（不参与距离评分，按 importance 排序）
   *    - confidence: "HIGH"（风险热点按 importance 排序，统一为 HIGH）
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回空数组（零回归）
   * - adapter.isAvailable() 返回 false：返回空数组（零回归）
   * - topN 为 0 或负数：返回空数组
   *
   * 边界处理：
   * - topN 超过 MAX_DW3_RISK_SNIPPETS=5：截断到 5
   * - topN 缺省（undefined）：使用默认值 5
   *
   * @param topN 风险热点 Top-N（默认 5，最大 5，超过则截断）
   * @returns DW-3 片段列表（最多 5 片段，type: "codemap_risk"，已冻结）
   */
  readonly getRiskHotspotSnippets = (topN?: number): ReadonlyArray<CodeMapSnippet> => {
    // ---------- 1. 降级判断 ----------
    if (!this.isAvailable()) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 2. 参数规范化 ----------
    // topN 缺省（undefined / NaN）时使用默认值 MAX_DW3_RISK_SNIPPETS=5
    // topN 超过 MAX_DW3_RISK_SNIPPETS=5 时截断到 5（D-3 决策）
    // topN 为 0 或负数时返回空数组（用户明确要求 0 个结果）
    if (typeof topN === "number") {
      // topN 是数字：0 或负数返回空数组，正数截断到 MAX_DW3_RISK_SNIPPETS
      if (topN <= 0) {
        return EMPTY_CODEMAP_SNIPPETS;
      }
    }
    // topN 缺省或非数字时使用默认值 MAX_DW3_RISK_SNIPPETS=5
    const effectiveTopN =
      typeof topN === "number" && topN > 0 ? Math.min(topN, MAX_DW3_RISK_SNIPPETS) : MAX_DW3_RISK_SNIPPETS;

    // ---------- 3. 调用 adapter.getRiskHotspots ----------
    // adapter 内部按 importance 降序排序，截断到 effectiveTopN 条
    const hotspotSymbols = this.symbolGraphAdapter.getRiskHotspots(effectiveTopN);

    // ---------- 4. 转换为 CodeMapSnippet ----------
    // 每个符号转换为 DW-3 片段：
    // - type: "codemap_risk"
    // - distance: Number.MAX_SAFE_INTEGER（不参与距离评分，按 importance 排序）
    // - confidence: "HIGH"（风险热点按 importance 排序，统一为 HIGH）
    const snippets: CodeMapSnippet[] = hotspotSymbols.map((sym) =>
      this.symbolToSnippet(
        sym,
        CODEMAP_SNIPPET_TYPE.CODEMAP_RISK,
        Number.MAX_SAFE_INTEGER, // distance = MAX_SAFE_INTEGER（不参与距离评分）
        "HIGH" // confidence = HIGH（风险热点统一为 HIGH）
      )
    );

    // ---------- 5. 冻结返回 ----------
    return Object.freeze(snippets);
  };

  // --------------------------------------------------------------------------
  // DW-4: 语义检索即时查（searchByQuery）
  // --------------------------------------------------------------------------

  /**
   * DW-4 语义检索即时查（type: "codemap_symbol"，agent tool 调用，单轮 ≤5 次）
   *
   * 数据流：
   * 1. 接收 query（自然语言查询字符串）与 limit（返回结果数上限）
   * 2. V2-P4 可用时：调用 adapter.searchByQuery(query, limit) 获取匹配符号
   * 3. 不截断（由调用方通过 limit 参数控制）
   * 4. 每个 CodeMapSnippet：
   *    - type: "codemap_symbol"（DW-4 复用 DW-1 的 type，因为都是符号定义）
   *    - distance: Number.MAX_SAFE_INTEGER（不参与距离评分，按命中关键词数排序）
   *    - confidence: "HIGH"（语义检索结果统一为 HIGH）
   *
   * 注意：DW-4 单轮调用上限由 tool-executor 强制（MAX_CODEMAP_TOOLS_PER_TURN=5），
   * 本方法不强制限制，由调用方（tool-executor）控制。
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回空数组（零回归）
   * - adapter.isAvailable() 返回 false：返回空数组（零回归）
   * - query 为空字符串：返回空数组
   * - limit 为 0 或负数：返回空数组
   *
   * @param query 自然语言查询字符串
   * @param limit 返回结果数上限
   * @returns DW-4 片段列表（最多 limit 条，type: "codemap_symbol"，已冻结）
   */
  readonly searchByQuery = (query: string, limit: number): ReadonlyArray<CodeMapSnippet> => {
    // ---------- 1. 降级判断 ----------
    if (!this.isAvailable()) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 2. 边界处理 ----------
    if (typeof query !== "string" || query.length === 0) {
      return EMPTY_CODEMAP_SNIPPETS;
    }
    if (typeof limit !== "number" || limit <= 0) {
      return EMPTY_CODEMAP_SNIPPETS;
    }

    // ---------- 3. 调用 adapter.searchByQuery ----------
    const searchResults = this.symbolGraphAdapter.searchByQuery(query, limit);

    // ---------- 4. 转换为 CodeMapSnippet ----------
    // 每个符号转换为 DW-4 片段：
    // - type: "codemap_symbol"（DW-4 复用 DW-1 的 type，因为都是符号定义）
    // - distance: Number.MAX_SAFE_INTEGER（不参与距离评分，按命中关键词数排序）
    // - confidence: "HIGH"（语义检索结果统一为 HIGH）
    const snippets: CodeMapSnippet[] = searchResults.map((sym) =>
      this.symbolToSnippet(
        sym,
        CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL,
        Number.MAX_SAFE_INTEGER, // distance = MAX_SAFE_INTEGER（不参与距离评分）
        "HIGH" // confidence = HIGH（语义检索结果统一为 HIGH）
      )
    );

    // ---------- 5. 冻结返回 ----------
    return Object.freeze(snippets);
  };

  // --------------------------------------------------------------------------
  // 内部辅助方法
  // --------------------------------------------------------------------------

  /**
   * 探测图谱是否可用（双层降级判断）
   *
   * 双层降级：
   * 1. graphAvailability()：环境级探测（V2-P4 图谱存储是否可用）
   * 2. adapter.isAvailable()：实例级探测（适配层自身是否可用）
   *
   * 任一返回 false 即视为不可用，所有 collect* 方法返回空数组（零回归）。
   *
   * @returns true=可用 / false=不可用（降级模式）
   */
  private isAvailable = (): boolean => {
    return this.graphAvailability() && this.symbolGraphAdapter.isAvailable();
  };

  /**
   * 将 SymbolRecord 转换为 CodeMapSnippet
   *
   * 派生规则：
   * - symbolId / name / kind / signature / summary / filePath / startLine / endLine / importance
   *   直接复用 SymbolRecord 同名字段
   * - type / distance / confidence 由调用方传入
   *
   * 不可变保证：返回的 CodeMapSnippet 通过 Object.freeze 冻结。
   *
   * @param sym 符号节点记录
   * @param type 片段类型（codemap_symbol / codemap_impact / codemap_risk）
   * @param distance BFS 距离
   * @param confidence 边置信度
   * @returns 冻结的 CodeMapSnippet 对象
   */
  private readonly symbolToSnippet = (
    sym: SymbolRecord,
    type: CodeMapSnippet["type"],
    distance: number,
    confidence: Confidence
  ): CodeMapSnippet => {
    return Object.freeze({
      type,
      symbolId: sym.symbolId,
      name: sym.name,
      kind: sym.kind,
      signature: sym.signature,
      summary: sym.summary,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      importance: sym.importance,
      distance,
      confidence,
    }) as CodeMapSnippet;
  };

  /**
   * 计算 DW-2 影响面符号到根符号的 BFS 距离与路径上最弱边的置信度
   *
   * 算法：
   * 1. 获取根符号的双向边（getEdges(rootId, "both")）
   * 2. 遍历所有边，找到直接连接到 targetSymbolId 的边：
   *    - 若有直接边：distance=1，confidence=这些边中最弱的
   *    - 若无直接边：distance=2，confidence=MEDIUM（默认中置信度，间接影响）
   *
   * confidence 比较（CONFIDENCE_WEIGHTS）：
   * - HIGH = 1.0
   * - MEDIUM = 0.7
   * - LOW = 0.4
   * 取最弱（权重最小）的 confidence。
   *
   * 边界处理：
   * - rootId 不存在：getEdges 返回空数组，distance=2，confidence=MEDIUM
   * - targetSymbolId 不存在：getEdges 返回空数组，distance=2，confidence=MEDIUM
   * - 无直接边：distance=2，confidence=MEDIUM（BFS 2 跳的间接影响）
   *
   * @param rootId 根符号 ID
   * @param targetSymbolId 目标符号 ID
   * @returns 距离与置信度计算结果
   */
  private readonly computeDistanceAndConfidence = (rootId: string, targetSymbolId: string): DistanceAndConfidence => {
    // 获取根符号的双向边（incoming + outgoing）
    const edges = this.symbolGraphAdapter.getEdges(rootId, "both");

    // 遍历所有边，找到直接连接到 targetSymbolId 的边
    const directEdges: EdgeRecord[] = [];
    for (const edge of edges) {
      // 双向边：检查 src 或 dst 是否为 targetSymbolId
      if (edge.srcSymbolId === targetSymbolId || edge.dstSymbolId === targetSymbolId) {
        directEdges.push(edge);
      }
    }

    // 若有直接边：distance=1，confidence=这些边中最弱的
    if (directEdges.length > 0) {
      // 取最弱 confidence（CONFIDENCE_WEIGHTS 数值最小）
      let weakestConfidence: Confidence = "HIGH";
      let weakestWeight = CONFIDENCE_WEIGHTS["HIGH"];
      for (const edge of directEdges) {
        const weight = CONFIDENCE_WEIGHTS[edge.confidence];
        if (weight < weakestWeight) {
          weakestWeight = weight;
          weakestConfidence = edge.confidence;
        }
      }
      return { distance: 1, confidence: weakestConfidence };
    }

    // 无直接边：distance=2，confidence=MEDIUM（间接影响，默认中置信度）
    // 注：getExplosionRadius 在 maxDepth=2 时返回的节点最多 2 跳，
    // 无直接边则必为 2 跳（间接影响），confidence 默认 MEDIUM
    return { distance: 2, confidence: "MEDIUM" };
  };
}
