/**
 * EAG-P6 Phase 4 risk_scan 工具实现（风险热点扫描 / 高风险符号 Top-N）
 *
 * 本模块提供 risk_scan agent 工具，扫描图谱中的高风险符号（按 importance 降序）。
 * 支持阈值过滤（threshold）、返回数限制（limit）、符号类型过滤（kind）。
 * 工具走 tool-executor 独立路径，结果直接拼入当轮 LLM messages（D-2 决策）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-6（codemap 工具集）+ DW-3 风险热点策略
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §8.2.4 Phase 4 验收标准（4 工具全部注册到 tool-executor）
 * - EAG-P6-TASKS.md §3 TASK-P6-4-04（risk_scan 工具实现规格）
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 * - TODO/FIXME 必须有对应实现，禁止空 TODO
 *
 * 接口契约（任务规格强制）：
 * - 输入：RiskScanInput {
 *     threshold?: number;
 *     limit?: number;
 *     kind?: SymbolKind;
 *   }
 * - 输出：RiskScanResult {
 *     hotspots: RiskHotspot[];
 *     totalHotspots: number;
 *     avgRiskScore: number;
 *   }
 * - 方法：execute(input: RiskScanInput) => RiskScanResult
 *
 * 实现要点：
 * - 调用 SymbolGraphAdapter.getRiskHotspots(topN) 获取按 importance 降序的全部符号
 * - 阈值过滤：importance >= threshold（默认 0.5）
 * - 类型过滤：kind（可选，function/class/interface/type/variable/module/namespace）
 * - 数量限制：limit（默认 10，最大 50）
 * - 计算 avgRiskScore（截断后的热点符号平均 importance）
 * - totalHotspots 为截断前的总数（用于判断是否有更多结果）
 *
 * 降级保证（NFR-4 零回归）：
 * - isGraphStoreAvailable() 返回 false 时返回空结果（不抛错，不打印 warning）
 * - adapter.isAvailable() 返回 false 时返回空结果
 * - 行为与 V2-P3 完全一致（零回归）
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 对外返回的 RiskScanResult 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/tools/risk-scan-tool
 */

import type { SymbolGraphAdapter } from "../context/symbol-graph-adapter";
import { isGraphStoreAvailable } from "../context/symbol-graph-adapter";
import type { SymbolKind, SymbolRecord } from "../context/symbol-graph-types";

// ============================================================================
// 1. 工具元数据常量
// ============================================================================

/**
 * 工具名称常量（与 codemap_query 同级，注册到 tool-executor）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const RISK_SCAN_TOOL_NAME: string = Object.freeze("risk_scan") as string;

/**
 * 工具描述（用于 tool-executor 工具列表展示）
 *
 * 使用 Object.freeze 冻结。
 */
export const RISK_SCAN_TOOL_DESCRIPTION: string = Object.freeze(
  "扫描符号图谱中的高风险符号（按 importance 降序）。支持阈值过滤（threshold）、" +
    "返回数限制（limit）、符号类型过滤（kind），返回风险热点列表与平均风险评分。"
) as string;

/**
 * 默认风险阈值（importance ≥ 0.5 视为高风险）
 *
 * 与 LOW_RELEVANCE_THRESHOLD=0.1 区分：LOW_RELEVANCE_THRESHOLD 用于过滤低相关性片段，
 * DEFAULT_RISK_SCAN_THRESHOLD 用于过滤低风险符号（高风险 = importance ≥ 0.5）。
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_RISK_SCAN_THRESHOLD: number = Object.freeze(0.5) as number;

/**
 * 默认返回热点数上限（与 MAX_DW3_RISK_SNIPPETS=5 对齐，DW-3 上限 5 片段）
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_RISK_SCAN_LIMIT: number = Object.freeze(10) as number;

/**
 * 最大返回热点数上限（防结果集过大导致 Token 爆炸）
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_RISK_SCAN_LIMIT: number = Object.freeze(50) as number;

/**
 * 内部查询 topN 上限（用于 getRiskHotspots 调用，避免在 threshold/kind 过滤前被截断）
 *
 * 使用 Object.freeze 冻结。
 */
const INTERNAL_RISK_SCAN_TOP_N: number = Object.freeze(200) as number;

/**
 * 空 RiskScanResult 常量（冻结，供降级路径复用）
 *
 * 降级模式下返回此常量，避免每次调用创建新对象（性能优化 + 不可变优先）。
 */
export const EMPTY_RISK_SCAN_RESULT: Readonly<RiskScanResult> = Object.freeze({
  hotspots: Object.freeze([]),
  totalHotspots: 0,
  avgRiskScore: 0,
}) as Readonly<RiskScanResult>;

// ============================================================================
// 2. 输入/输出接口定义
// ============================================================================

/**
 * risk_scan 工具输入参数
 *
 * 字段说明：
 * - threshold：风险阈值（可选，默认 0.5，importance ≥ threshold 视为高风险）
 * - limit：返回热点数上限（可选，默认 10，最大 50）
 * - kind：符号类型过滤（可选，function/class/interface/type/variable/module/namespace）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RiskScanInput {
  /** 风险阈值（可选，默认 0.5，importance ≥ threshold 视为高风险，范围 [0, 1]） */
  readonly threshold?: number;
  /** 返回热点数上限（可选，默认 10，最大 50，超过截断） */
  readonly limit?: number;
  /** 符号类型过滤（可选，function/class/interface/type/variable/module/namespace） */
  readonly kind?: SymbolKind;
}

/**
 * 风险热点条目（携带符号节点与风险评分）
 *
 * 字段说明：
 * - symbol：高风险符号节点（冻结的 SymbolRecord）
 * - riskScore：风险评分（0-1，直接使用 importance 字段）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RiskHotspot {
  /** 高风险符号节点（冻结的 SymbolRecord） */
  readonly symbol: SymbolRecord;
  /** 风险评分（0-1，直接使用 importance 字段，数值越高风险越大） */
  readonly riskScore: number;
}

/**
 * risk_scan 工具输出结果
 *
 * 字段说明：
 * - hotspots：风险热点列表（按 riskScore 降序，已截断到 limit）
 * - totalHotspots：风险热点总数（截断前的总数，用于判断是否有更多结果）
 * - avgRiskScore：截断后热点符号的平均风险评分（0-1，无热点时为 0）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 */
export interface RiskScanResult {
  /** 风险热点列表（按 riskScore 降序，已截断到 limit，已冻结） */
  readonly hotspots: ReadonlyArray<RiskHotspot>;
  /** 风险热点总数（截断前的总数，用于判断是否有更多结果） */
  readonly totalHotspots: number;
  /** 截断后热点符号的平均风险评分（0-1，无热点时为 0） */
  readonly avgRiskScore: number;
}

// ============================================================================
// 3. RiskScanTool 类实现
// ============================================================================

/**
 * risk_scan 工具实现类
 *
 * 通过 SymbolGraphAdapter 接口查询图谱，不直接依赖 V2-P4 graph-store 实现。
 * V2-P4 未实施时，DefaultSymbolGraphAdapter 返回空数组，本工具返回空结果（降级）。
 * V2-P4 实施后，可替换为 GraphStoreSymbolGraphAdapter，本工具零修改（依赖倒置）。
 *
 * 查询策略：
 * 1. 调用 adapter.getRiskHotspots(INTERNAL_RISK_SCAN_TOP_N=200) 获取按 importance 降序的符号
 * 2. 阈值过滤：importance >= threshold（默认 0.5）
 * 3. 类型过滤：kind（可选）
 * 4. 截断到 limit（默认 10，最大 50）
 * 5. 计算 avgRiskScore（截断后热点符号的平均 importance）
 * 6. totalHotspots 为截断前的总数
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const tool = new RiskScanTool(adapter);
 *
 * // 默认扫描（threshold=0.5, limit=10）
 * const result1 = tool.execute({});
 * console.log(result1.hotspots.length); // 高风险符号数
 * console.log(result1.avgRiskScore);    // 平均风险评分
 *
 * // 自定义阈值与限制
 * const result2 = tool.execute({
 *   threshold: 0.7,
 *   limit: 5,
 *   kind: "class",
 * });
 * ```
 */
export class RiskScanTool {
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
   * 任一返回 false 时，execute 返回空结果（零回归）。
   */
  private readonly graphAvailability: () => boolean;

  /**
   * 构造 risk_scan 工具
   *
   * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可用时返回空结果）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(symbolGraphAdapter: SymbolGraphAdapter, graphAvailability: () => boolean = isGraphStoreAvailable) {
    this.symbolGraphAdapter = symbolGraphAdapter;
    this.graphAvailability = graphAvailability;
  }

  /**
   * 执行 risk_scan 工具查询
   *
   * 执行流程：
   * 1. 降级判断：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即返回空结果
   * 2. 参数规范化：threshold 缺省时使用 0.5，limit 缺省时使用 10（最大 50）
   * 3. 调用 adapter.getRiskHotspots(INTERNAL_RISK_SCAN_TOP_N=200) 获取按 importance 降序的符号
   * 4. 阈值过滤：importance >= threshold
   * 5. 类型过滤：kind（可选）
   * 6. 截断到 limit，统计 totalHotspots（截断前总数）
   * 7. 计算 avgRiskScore（截断后热点符号的平均 importance）
   * 8. 冻结返回 RiskScanResult
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回 EMPTY_RISK_SCAN_RESULT（零回归）
   * - adapter.isAvailable() 返回 false：返回 EMPTY_RISK_SCAN_RESULT（零回归）
   * - 无高风险符号：返回 EMPTY_RISK_SCAN_RESULT
   *
   * 边界处理：
   * - threshold 缺省（undefined / NaN / <0 / >1）：使用默认值 0.5
   * - limit 缺省（undefined / NaN / <=0）：使用默认值 10
   * - limit 超过 MAX_RISK_SCAN_LIMIT=50：截断到 50
   * - kind 非法值（非 SymbolKind 字面量）：忽略 kind 过滤
   *
   * @param input 风险扫描输入参数（threshold / limit / kind）
   * @returns 风险扫描结果（hotspots / totalHotspots / avgRiskScore，已冻结）
   */
  readonly execute = (input: RiskScanInput): RiskScanResult => {
    // ---------- 1. 降级判断 ----------
    // 双层降级：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即降级
    if (!this.isAvailable()) {
      return EMPTY_RISK_SCAN_RESULT;
    }

    // ---------- 2. 边界处理：input 为 null/undefined ----------
    // 防御性处理，调用方应保证 input 非空（允许空对象 {} 表示全部使用默认值）
    const safeInput: RiskScanInput = input ?? {};

    // ---------- 3. 参数规范化 ----------
    // threshold：缺省时使用默认值 0.5，范围 [0, 1]，超出范围使用默认值
    const threshold: number = this.normalizeThreshold(safeInput.threshold);
    // limit：缺省时使用默认值 10，超过 50 截断到 50
    const limit: number = this.normalizeLimit(safeInput.limit);
    // kind：可选，必须为合法 SymbolKind 之一，否则视为未提供
    const kind: SymbolKind | undefined = this.normalizeKind(safeInput.kind);

    // ---------- 4. 调用 adapter.getRiskHotspots ----------
    // 使用 INTERNAL_RISK_SCAN_TOP_N=200 作为 topN，避免在 threshold/kind 过滤前被截断
    const allHotspots: ReadonlyArray<SymbolRecord> = this.symbolGraphAdapter.getRiskHotspots(INTERNAL_RISK_SCAN_TOP_N);

    // ---------- 5. 阈值过滤 ----------
    // importance >= threshold 视为高风险
    const thresholdFiltered = allHotspots.filter((sym) => sym.importance >= threshold);

    // ---------- 6. 类型过滤（可选） ----------
    // kind 提供时，按 kind 过滤
    let finalFiltered: ReadonlyArray<SymbolRecord> = thresholdFiltered;
    if (kind !== undefined) {
      finalFiltered = thresholdFiltered.filter((sym) => sym.kind === kind);
    }

    // ---------- 7. 截断到 limit，统计 totalHotspots ----------
    const totalHotspots: number = finalFiltered.length;
    const truncated: ReadonlyArray<SymbolRecord> = finalFiltered.slice(0, limit);

    // ---------- 8. 计算 avgRiskScore ----------
    // 截断后热点符号的平均 importance（无热点时为 0）
    let avgRiskScore: number = 0;
    if (truncated.length > 0) {
      const sum: number = truncated.reduce((acc, sym) => acc + sym.importance, 0);
      avgRiskScore = sum / truncated.length;
    }

    // ---------- 9. 构建 RiskHotspot 列表 ----------
    // 将 SymbolRecord 转换为 RiskHotspot（携带 riskScore = importance）
    const hotspots: RiskHotspot[] = truncated.map((sym) => ({
      symbol: sym,
      riskScore: sym.importance,
    }));

    // ---------- 10. 冻结返回 RiskScanResult ----------
    const result: RiskScanResult = Object.freeze({
      hotspots: Object.freeze(hotspots),
      totalHotspots,
      avgRiskScore,
    }) as RiskScanResult;

    return result;
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
   * 任一返回 false 即视为不可用，execute 返回空结果（零回归）。
   *
   * @returns true=可用 / false=不可用（降级模式）
   */
  private isAvailable = (): boolean => {
    return this.graphAvailability() && this.symbolGraphAdapter.isAvailable();
  };

  /**
   * 规范化 threshold 参数
   *
   * 规则：
   * - threshold 缺省（undefined / NaN / <0 / >1）：使用默认值 DEFAULT_RISK_SCAN_THRESHOLD=0.5
   * - threshold 在 [0, 1] 区间：直接使用
   *
   * @param threshold 原始 threshold 值（可选）
   * @returns 规范化后的 threshold 值（0 ~ 1）
   */
  private normalizeThreshold = (threshold?: number): number => {
    if (typeof threshold !== "number" || Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      return DEFAULT_RISK_SCAN_THRESHOLD;
    }
    return threshold;
  };

  /**
   * 规范化 limit 参数
   *
   * 规则：
   * - limit 缺省（undefined / NaN / <=0）：使用默认值 DEFAULT_RISK_SCAN_LIMIT=10
   * - limit 超过 MAX_RISK_SCAN_LIMIT=50：截断到 50
   * - limit 在 (0, 50] 区间：直接使用
   *
   * @param limit 原始 limit 值（可选）
   * @returns 规范化后的 limit 值（1 ~ 50）
   */
  private normalizeLimit = (limit?: number): number => {
    if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
      return DEFAULT_RISK_SCAN_LIMIT;
    }
    if (limit > MAX_RISK_SCAN_LIMIT) {
      return MAX_RISK_SCAN_LIMIT;
    }
    return Math.floor(limit);
  };

  /**
   * 规范化 kind 参数
   *
   * 规则：
   * - kind 缺省（undefined / 非字符串）：返回 undefined（不过滤）
   * - kind 为合法 SymbolKind 字面量：直接使用
   * - kind 为非法字符串：返回 undefined（视为未提供，不过滤）
   *
   * @param kind 原始 kind 值（可选）
   * @returns 规范化后的 kind 值（合法 SymbolKind 或 undefined）
   */
  private normalizeKind = (kind?: unknown): SymbolKind | undefined => {
    if (typeof kind !== "string") {
      return undefined;
    }
    // 合法 SymbolKind 字面量校验
    const validKinds: ReadonlyArray<SymbolKind> = [
      "function",
      "class",
      "interface",
      "type",
      "variable",
      "module",
      "namespace",
    ];
    if (validKinds.includes(kind as SymbolKind)) {
      return kind as SymbolKind;
    }
    // 非法字符串：视为未提供
    return undefined;
  };
}
