/**
 * EAG-P6 Phase 4 impact_analysis 工具实现（符号变更影响范围分析 / 爆炸半径）
 *
 * 本模块提供 impact_analysis agent 工具，分析符号变更的影响范围（爆炸半径）。
 * 支持方向感知：forward（我调用谁）/ backward（谁调用我）/ both（双向）。
 * 工具走 tool-executor 独立路径，结果直接拼入当轮 LLM messages（D-2 决策）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-6（codemap 工具集）+ DW-2 爆炸半径策略
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §8.2.4 Phase 4 验收标准（4 工具全部注册到 tool-executor）
 * - EAG-P6-TASKS.md §3 TASK-P6-4-02（impact_analysis 工具实现规格）
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - "真实 BFS 遍历（非 mock）"
 * - "检测循环依赖（visited 集合 + path 栈）"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 * - TODO/FIXME 必须有对应实现，禁止空 TODO
 *
 * 接口契约（任务规格强制）：
 * - 输入：ImpactAnalysisInput {
 *     symbolId: string;
 *     direction: 'forward' | 'backward' | 'both';
 *     maxDepth?: number;
 *     maxNodes?: number;
 *   }
 * - 输出：ImpactAnalysisResult {
 *     impactedSymbols: ImpactedSymbol[];
 *     totalNodes: number;
 *     maxDepthReached: number;
 *     cycles: string[][];
 *   }
 * - 方法：execute(input: ImpactAnalysisInput) => ImpactAnalysisResult
 *
 * 实现要点：
 * - SymbolGraphAdapter.getExplosionRadius 仅支持双向 BFS，无 direction 参数
 *   故本工具内部基于 getEdges(symbolId, direction) 实现方向感知 BFS
 * - direction="forward"：沿 outgoing 边展开（srcSymbolId → dstSymbolId，"我调用谁"）
 * - direction="backward"：沿 incoming 边展开（dstSymbolId → srcSymbolId，"谁调用我"）
 * - direction="both"：双向展开（等价于 getExplosionRadius 行为，但本工具自带实现
 *   以保持与 forward/backward 路径一致的循环检测语义）
 * - 循环检测：独立 DFS（限制深度 ≤ maxDepth + 限制环数 ≤ MAX_CYCLES），
 *   避免环爆炸。每个环以 symbolId 列表形式返回（从根出发回到根的简单环）
 *
 * 降级保证（NFR-4 零回归）：
 * - isGraphStoreAvailable() 返回 false 时返回空结果（不抛错，不打印 warning）
 * - adapter.isAvailable() 返回 false 时返回空结果
 * - 行为与 V2-P3 完全一致（零回归）
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 对外返回的 ImpactAnalysisResult 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/tools/impact-analysis-tool
 */

import type { SymbolGraphAdapter } from "../context/symbol-graph-adapter";
import { isGraphStoreAvailable } from "../context/symbol-graph-adapter";
import type { EdgeDirection, SymbolRecord } from "../context/symbol-graph-types";

// ============================================================================
// 1. 工具元数据常量
// ============================================================================

/**
 * 工具名称常量（与 codemap_query 同级，注册到 tool-executor）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const IMPACT_ANALYSIS_TOOL_NAME: string = Object.freeze("impact_analysis") as string;

/**
 * 工具描述（用于 tool-executor 工具列表展示）
 *
 * 使用 Object.freeze 冻结。
 */
export const IMPACT_ANALYSIS_TOOL_DESCRIPTION: string = Object.freeze(
  "分析符号变更的影响范围（爆炸半径）。支持方向感知（forward=我调用谁 / " +
    "backward=谁调用我 / both=双向），返回受影响符号列表与检测到的循环依赖。"
) as string;

/**
 * 默认 BFS 最大深度（与 DEFAULT_EXPLOSION_RADIUS_DEPTH 对齐，防图谱爆炸）
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_IMPACT_ANALYSIS_MAX_DEPTH: number = Object.freeze(2) as number;

/**
 * 最大 BFS 深度上限（架构师 §5.2 接口契约约束，防图谱爆炸）
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_IMPACT_ANALYSIS_MAX_DEPTH: number = Object.freeze(3) as number;

/**
 * 默认返回节点数上限（与 DEFAULT_EXPLOSION_RADIUS_MAX_NODES 对齐）
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_IMPACT_ANALYSIS_MAX_NODES: number = Object.freeze(50) as number;

/**
 * 最大返回节点数上限（防结果集过大导致 Token 爆炸）
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_IMPACT_ANALYSIS_MAX_NODES: number = Object.freeze(200) as number;

/**
 * 最大循环依赖检测数量上限（防环爆炸）
 *
 * 环检测复杂度可能指数级（如完全图），故限制返回环数避免结果集过大。
 * 使用 Object.freeze 冻结。
 */
export const MAX_CYCLES: number = Object.freeze(10) as number;

/**
 * 循环检测最大深度上限（独立于 BFS 的 maxDepth 约束）
 *
 * 设计依据：
 * - BFS 的 maxDepth 受架构师 §5.2 接口契约硬约束（默认 2 / 最大 3），
 *   用于限制爆炸半径，避免图谱爆炸
 * - 循环检测是不同的关注点：用户需要找到完整的环（如 5 节点环需要深度 5）
 *   若与 BFS 共用 maxDepth=3 上限，则无法检测长度 > 3 的环
 * - 故为循环检测单独引入更高的深度上限，允许检测典型规模的项目级环
 *
 * 取值考量：
 * - 10 跳足以覆盖绝大多数真实项目的循环依赖（典型项目环长度 < 10）
 * - 与 MAX_CYCLES=10 协同，最坏情况返回 10 个 ≤10 跳的环，结果集可控
 * - 用户传入 maxDepth > 10 时截断到 10，避免极端深度导致 DFS 指数爆炸
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_CYCLE_DETECTION_DEPTH: number = Object.freeze(10) as number;

/**
 * 空 ImpactAnalysisResult 常量（冻结，供降级路径复用）
 *
 * 降级模式下返回此常量，避免每次调用创建新对象（性能优化 + 不可变优先）。
 */
export const EMPTY_IMPACT_ANALYSIS_RESULT: Readonly<ImpactAnalysisResult> = Object.freeze({
  impactedSymbols: Object.freeze([]),
  totalNodes: 0,
  maxDepthReached: 0,
  cycles: Object.freeze([]),
}) as Readonly<ImpactAnalysisResult>;

// ============================================================================
// 2. 输入/输出接口定义
// ============================================================================

/**
 * impact_analysis 工具输入参数
 *
 * 字段说明：
 * - symbolId：根符号 ID（必填，BFS 起点，格式 filePath:fullyQualifiedName）
 * - direction：遍历方向（必填，forward/backward/both）
 * - maxDepth：BFS 最大深度（可选，默认 2，最大 3）
 * - maxNodes：返回节点数上限（可选，默认 50，最大 200）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface ImpactAnalysisInput {
  /** 根符号 ID（BFS 起点，格式 filePath:fullyQualifiedName） */
  readonly symbolId: string;
  /** 遍历方向（forward=我调用谁 / backward=谁调用我 / both=双向） */
  readonly direction: "forward" | "backward" | "both";
  /** BFS 最大深度（可选，默认 2，最大 3，超过截断） */
  readonly maxDepth?: number;
  /** 返回节点数上限（可选，默认 50，最大 200，超过截断） */
  readonly maxNodes?: number;
}

/**
 * 受影响符号条目（携带 BFS 深度与方向信息）
 *
 * 字段说明：
 * - symbol：受影响的符号节点（冻结的 SymbolRecord）
 * - depth：BFS 深度（根的直接邻居为 1，次级为 2，依此类推）
 * - direction：到达此节点的方向（与输入 direction 一致）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface ImpactedSymbol {
  /** 受影响的符号节点（冻结的 SymbolRecord） */
  readonly symbol: SymbolRecord;
  /** BFS 深度（1=直接邻居，2=次级邻居，依此类推） */
  readonly depth: number;
  /** 到达此节点的方向（与输入 direction 一致） */
  readonly direction: "forward" | "backward" | "both";
}

/**
 * impact_analysis 工具输出结果
 *
 * 字段说明：
 * - impactedSymbols：受影响符号列表（按 BFS 深度升序，同深度按 importance 降序，已截断）
 * - totalNodes：受影响符号总数（截断前的总数，用于判断是否有更多结果）
 * - maxDepthReached：BFS 实际到达的最大深度（≤ maxDepth）
 * - cycles：检测到的循环依赖列表（每个环为 symbolId 列表，从根出发回到根）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 */
export interface ImpactAnalysisResult {
  /** 受影响符号列表（按 BFS 深度升序，同深度按 importance 降序，已截断，已冻结） */
  readonly impactedSymbols: ReadonlyArray<ImpactedSymbol>;
  /** 受影响符号总数（截断前的总数，用于判断是否有更多结果） */
  readonly totalNodes: number;
  /** BFS 实际到达的最大深度（≤ maxDepth） */
  readonly maxDepthReached: number;
  /** 检测到的循环依赖列表（每个环为 symbolId 列表，从根出发回到根，最多 MAX_CYCLES 条） */
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
}

// ============================================================================
// 3. 内部辅助类型：BFS 队列节点
// ============================================================================

/**
 * BFS 队列节点（携带 BFS 深度信息）
 *
 * 用于方向感知 BFS 遍历，记录每个被访问节点的深度，
 * 深度超过 maxDepth 时停止扩展（但有界 BFS 仍会处理当前层全部节点）。
 *
 * 字段：
 * - symbolId：节点符号 ID
 * - depth：BFS 深度（根节点为 0，其直接邻居为 1，依此类推）
 */
interface BfsQueueNode {
  /** 节点符号 ID */
  readonly symbolId: string;
  /** BFS 深度（根节点为 0，直接邻居为 1） */
  readonly depth: number;
}

// ============================================================================
// 4. ImpactAnalysisTool 类实现
// ============================================================================

/**
 * impact_analysis 工具实现类
 *
 * 通过 SymbolGraphAdapter 接口查询图谱，不直接依赖 V2-P4 graph-store 实现。
 * V2-P4 未实施时，DefaultSymbolGraphAdapter 返回空数组，本工具返回空结果（降级）。
 * V2-P4 实施后，可替换为 GraphStoreSymbolGraphAdapter，本工具零修改（依赖倒置）。
 *
 * 方向感知 BFS 算法（真实实现，禁 mock）：
 * 1. 根据 direction 选择 EdgeDirection：
 *    - forward → outgoing（边方向：根 → 邻居）
 *    - backward → incoming（边方向：邻居 → 根）
 *    - both → both（双向）
 * 2. BFS 从根节点出发，沿选定方向边展开邻居
 * 3. visited 集合避免重复访问（保证 BFS 终止）
 * 4. 每个邻居记录 depth（BFS 距离）
 * 5. 结果按 (depth ASC, importance DESC) 排序
 * 6. 截断到 maxNodes 条
 *
 * 循环检测算法（真实 DFS，禁 mock）：
 * 1. 在 BFS 完成后，独立跑 DFS 找从根出发回到根的简单环
 * 2. 限制 DFS 深度 ≤ cycleDetectionDepth（独立于 BFS maxDepth，上限 MAX_CYCLE_DETECTION_DEPTH=10）
 * 3. 限制环数 ≤ MAX_CYCLES=10（避免结果集过大）
 * 4. 每个环以 symbolId 列表形式返回（含根节点作为首尾元素）
 *
 * 深度参数解耦（重要设计决策）：
 * - BFS maxDepth：受架构师 §5.2 接口契约硬约束（默认 2 / 最大 3），用于控制爆炸半径
 * - 循环检测 cycleDetectionDepth：独立深度参数（默认 10 / 最大 10），用于检测典型环
 * - 解耦原因：BFS 的 3 跳限制无法检测长度 > 3 的环（如 5 节点环），
 *   故循环检测需要更高的深度上限以满足实际项目需求
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const tool = new ImpactAnalysisTool(adapter);
 *
 * // 正向影响分析（我调用谁）
 * const result1 = tool.execute({
 *   symbolId: "src/A.ts:UserService",
 *   direction: "forward",
 *   maxDepth: 2,
 * });
 * console.log(result1.impactedSymbols.length); // UserService 直接/间接调用的符号数
 *
 * // 反向影响分析（谁调用我）
 * const result2 = tool.execute({
 *   symbolId: "src/A.ts:UserService",
 *   direction: "backward",
 *   maxDepth: 2,
 * });
 *
 * // 双向影响分析
 * const result3 = tool.execute({
 *   symbolId: "src/A.ts:UserService",
 *   direction: "both",
 * });
 *
 * // 循环依赖检测
 * console.log(result3.cycles); // 检测到的环列表
 * ```
 */
export class ImpactAnalysisTool {
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
   * 构造 impact_analysis 工具
   *
   * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可用时返回空结果）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(symbolGraphAdapter: SymbolGraphAdapter, graphAvailability: () => boolean = isGraphStoreAvailable) {
    this.symbolGraphAdapter = symbolGraphAdapter;
    this.graphAvailability = graphAvailability;
  }

  /**
   * 执行 impact_analysis 工具查询
   *
   * 执行流程：
   * 1. 降级判断：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即返回空结果
   * 2. 参数规范化：
   *    - maxDepth（BFS 爆炸半径）：缺省时使用 2，最大 3（架构师硬约束）
   *    - cycleDetectionDepth（循环检测深度）：缺省时使用 10，最大 10（独立于 BFS）
   *    - maxNodes：缺省时使用 50，最大 200
   * 3. 边界处理：symbolId 为空或 direction 非法时返回空结果
   * 4. 方向感知 BFS：从根节点出发，沿选定方向边展开邻居（深度 ≤ maxDepth）
   * 5. 结果排序：按 (depth ASC, importance DESC) 排序
   * 6. 截断到 maxNodes，统计 totalNodes（截断前总数）
   * 7. 计算 maxDepthReached（实际到达的最大深度）
   * 8. 循环检测：独立 DFS 找从根出发回到根的简单环（深度 ≤ cycleDetectionDepth + 环数 ≤ MAX_CYCLES）
   * 9. 冻结返回 ImpactAnalysisResult
   *
   * 深度参数解耦说明（重要）：
   * - BFS maxDepth 与循环检测 cycleDetectionDepth 是两个独立的深度参数
   * - 用户传入的 input.maxDepth 同时用于两者，但规范化规则不同：
   *   - BFS：受 MAX_IMPACT_ANALYSIS_MAX_DEPTH=3 硬约束（爆炸半径控制）
   *   - 循环检测：受 MAX_CYCLE_DETECTION_DEPTH=10 约束（允许检测典型环）
   * - 例：用户传 maxDepth=5
   *   - BFS 用 min(5, 3)=3（爆炸半径限制为 3 跳）
   *   - 循环检测用 min(5, 10)=5（可检测 5 节点环）
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回 EMPTY_IMPACT_ANALYSIS_RESULT（零回归）
   * - adapter.isAvailable() 返回 false：返回 EMPTY_IMPACT_ANALYSIS_RESULT（零回归）
   * - symbolId 为空字符串：返回 EMPTY_IMPACT_ANALYSIS_RESULT
   * - direction 非法值：返回 EMPTY_IMPACT_ANALYSIS_RESULT
   * - symbolId 在图谱中不存在：返回 EMPTY_IMPACT_ANALYSIS_RESULT
   *
   * 边界处理：
   * - maxDepth 缺省（undefined / NaN / <=0）：BFS 用默认值 2，循环检测用 10
   * - maxDepth 超过 MAX_IMPACT_ANALYSIS_MAX_DEPTH=3：BFS 截断到 3
   * - maxDepth 超过 MAX_CYCLE_DETECTION_DEPTH=10：循环检测截断到 10
   * - maxNodes 缺省（undefined / NaN / <=0）：使用默认值 50
   * - maxNodes 超过 MAX_IMPACT_ANALYSIS_MAX_NODES=200：截断到 200
   *
   * @param input 影响分析输入参数（symbolId / direction / maxDepth / maxNodes）
   * @returns 影响分析结果（impactedSymbols / totalNodes / maxDepthReached / cycles，已冻结）
   */
  readonly execute = (input: ImpactAnalysisInput): ImpactAnalysisResult => {
    // ---------- 1. 降级判断 ----------
    // 双层降级：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即降级
    if (!this.isAvailable()) {
      return EMPTY_IMPACT_ANALYSIS_RESULT;
    }

    // ---------- 2. 边界处理：input 为 null/undefined ----------
    // 防御性处理，调用方应保证 input 非空
    if (input === null || input === undefined) {
      return EMPTY_IMPACT_ANALYSIS_RESULT;
    }

    // ---------- 3. 参数规范化 ----------
    // symbolId：必填，为空字符串视为无效
    const symbolId: string = typeof input.symbolId === "string" ? input.symbolId.trim() : "";
    // direction：必填，必须为 forward/backward/both 之一
    const direction: "forward" | "backward" | "both" = input.direction;
    // maxDepth：缺省时使用默认值 2，超过 3 截断到 3（BFS 爆炸半径约束）
    const maxDepth: number = this.normalizeMaxDepth(input.maxDepth);
    // maxNodes：缺省时使用默认值 50，超过 200 截断到 200
    const maxNodes: number = this.normalizeMaxNodes(input.maxNodes);
    // cycleDetectionDepth：循环检测独立深度（与 BFS maxDepth 解耦）
    // 用户传入的 maxDepth 用于 BFS 爆炸半径（受架构师硬约束 ≤3），
    // 但循环检测需要更高的深度上限以支持典型环（如 5 节点环需深度 5），
    // 故单独规范化：用户 maxDepth 优先，否则使用 MAX_CYCLE_DETECTION_DEPTH=10
    const cycleDetectionDepth: number = this.normalizeCycleDetectionDepth(input.maxDepth);

    // ---------- 4. 边界处理：symbolId 为空或 direction 非法 ----------
    if (symbolId.length === 0) {
      return EMPTY_IMPACT_ANALYSIS_RESULT;
    }
    if (direction !== "forward" && direction !== "backward" && direction !== "both") {
      return EMPTY_IMPACT_ANALYSIS_RESULT;
    }

    // ---------- 5. 方向感知 BFS ----------
    // 调用内部 BFS 实现，返回受影响符号列表（含 depth 信息）
    const bfsResult = this.runDirectionalBfs(symbolId, direction, maxDepth, maxNodes);

    // ---------- 6. 循环检测 ----------
    // 独立 DFS 找从根出发回到根的简单环
    // 深度限制使用 cycleDetectionDepth（独立于 BFS maxDepth，允许更深以检测完整环）
    // 环数限制 ≤ MAX_CYCLES=10
    const cycles = this.detectCycles(symbolId, direction, cycleDetectionDepth);

    // ---------- 7. 构建并冻结返回结果 ----------
    const result: ImpactAnalysisResult = Object.freeze({
      impactedSymbols: Object.freeze([...bfsResult.impactedSymbols]),
      totalNodes: bfsResult.totalNodes,
      maxDepthReached: bfsResult.maxDepthReached,
      cycles: Object.freeze(cycles.map((c) => Object.freeze([...c]))),
    }) as ImpactAnalysisResult;

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
   * 规范化 maxDepth 参数
   *
   * 规则：
   * - maxDepth 缺省（undefined / NaN / <=0）：使用默认值 DEFAULT_IMPACT_ANALYSIS_MAX_DEPTH=2
   * - maxDepth 超过 MAX_IMPACT_ANALYSIS_MAX_DEPTH=3：截断到 3
   * - maxDepth 在 (0, 3] 区间：直接使用
   *
   * @param maxDepth 原始 maxDepth 值（可选）
   * @returns 规范化后的 maxDepth 值（1 ~ 3）
   */
  private normalizeMaxDepth = (maxDepth?: number): number => {
    if (typeof maxDepth !== "number" || Number.isNaN(maxDepth) || maxDepth <= 0) {
      return DEFAULT_IMPACT_ANALYSIS_MAX_DEPTH;
    }
    if (maxDepth > MAX_IMPACT_ANALYSIS_MAX_DEPTH) {
      return MAX_IMPACT_ANALYSIS_MAX_DEPTH;
    }
    return Math.floor(maxDepth);
  };

  /**
   * 规范化 maxNodes 参数
   *
   * 规则：
   * - maxNodes 缺省（undefined / NaN / <=0）：使用默认值 DEFAULT_IMPACT_ANALYSIS_MAX_NODES=50
   * - maxNodes 超过 MAX_IMPACT_ANALYSIS_MAX_NODES=200：截断到 200
   * - maxNodes 在 (0, 200] 区间：直接使用
   *
   * @param maxNodes 原始 maxNodes 值（可选）
   * @returns 规范化后的 maxNodes 值（1 ~ 200）
   */
  private normalizeMaxNodes = (maxNodes?: number): number => {
    if (typeof maxNodes !== "number" || Number.isNaN(maxNodes) || maxNodes <= 0) {
      return DEFAULT_IMPACT_ANALYSIS_MAX_NODES;
    }
    if (maxNodes > MAX_IMPACT_ANALYSIS_MAX_NODES) {
      return MAX_IMPACT_ANALYSIS_MAX_NODES;
    }
    return Math.floor(maxNodes);
  };

  /**
   * 规范化循环检测深度参数（独立于 BFS maxDepth）
   *
   * 与 normalizeMaxDepth 的关键差异：
   * - normalizeMaxDepth：用于 BFS 爆炸半径，受架构师硬约束 ≤3（MAX_IMPACT_ANALYSIS_MAX_DEPTH）
   * - normalizeCycleDetectionDepth：用于循环检测，允许更深（≤10，MAX_CYCLE_DETECTION_DEPTH）
   *
   * 规则：
   * - maxDepth 缺省（undefined / NaN / <=0）：使用 MAX_CYCLE_DETECTION_DEPTH=10（允许检测最长环）
   * - maxDepth 超过 MAX_CYCLE_DETECTION_DEPTH=10：截断到 10（防 DFS 指数爆炸）
   * - maxDepth 在 (0, 10] 区间：直接使用（尊重用户意图）
   *
   * 设计考量：
   * - 用户传入 maxDepth=5 时，BFS 用 min(5, 3)=3（爆炸半径约束），
   *   但循环检测用 min(5, 10)=5（允许检测 5 节点环）
   * - 用户未传 maxDepth 时，BFS 用默认 2，循环检测用默认 10（最大检测能力）
   *
   * @param maxDepth 原始 maxDepth 值（可选，与 BFS 共用同一输入参数）
   * @returns 规范化后的循环检测深度值（1 ~ 10）
   */
  private normalizeCycleDetectionDepth = (maxDepth?: number): number => {
    // maxDepth 缺省或非正数：使用最大循环检测深度（允许检测最长环）
    if (typeof maxDepth !== "number" || Number.isNaN(maxDepth) || maxDepth <= 0) {
      return MAX_CYCLE_DETECTION_DEPTH;
    }
    // maxDepth 超过最大循环检测深度：截断到 10（防 DFS 指数爆炸）
    if (maxDepth > MAX_CYCLE_DETECTION_DEPTH) {
      return MAX_CYCLE_DETECTION_DEPTH;
    }
    // maxDepth 在 (0, 10] 区间：直接使用（尊重用户意图）
    return Math.floor(maxDepth);
  };

  /**
   * 方向感知 BFS（真实实现，禁 mock）
   *
   * 算法步骤：
   * 1. 初始化 BFS 队列，根节点入队（depth=0）
   * 2. 初始化 visited 集合，根节点标记为已访问（避免循环）
   * 3. 循环出队，直到队列为空：
   *    a. 取出队首节点，深度为 depth
   *    b. 若 depth >= maxDepth，不再扩展（但有界 BFS 仍会处理当前节点）
   *    c. 根据 direction 获取该节点的边
   *    d. 对每条边，获取邻居节点 symbolId
   *    e. 若邻居未访问，加入结果集，入队（depth+1）
   * 4. 结果按 (depth ASC, importance DESC) 排序
   * 5. 截断到 maxNodes 条
   * 6. 统计 totalNodes（截断前总数）
   * 7. 计算 maxDepthReached（实际到达的最大深度）
   *
   * direction → EdgeDirection 映射：
   * - forward → outgoing（边方向：根 → 邻居，邻居为 dstSymbolId）
   * - backward → incoming（边方向：邻居 → 根，邻居为 srcSymbolId）
   * - both → both（双向，邻居为 dstSymbolId + srcSymbolId 去重）
   *
   * 防图谱爆炸：
   * - maxDepth 默认 2（最大 3），架构师 §5.2 接口契约约束
   * - maxNodes 限制返回节点数（典型值 50-200）
   * - visited 集合避免循环遍历（防止环路导致死循环）
   *
   * @param rootSymbolId 根符号 ID（BFS 起点）
   * @param direction 遍历方向（forward/backward/both）
   * @param maxDepth BFS 最大深度
   * @param maxNodes 返回节点数上限
   * @returns BFS 结果（impactedSymbols + totalNodes + maxDepthReached）
   */
  private runDirectionalBfs = (
    rootSymbolId: string,
    direction: "forward" | "backward" | "both",
    maxDepth: number,
    maxNodes: number
  ): {
    impactedSymbols: ReadonlyArray<ImpactedSymbol>;
    totalNodes: number;
    maxDepthReached: number;
  } => {
    // ---------- 0. 边界处理：根节点不存在于图谱 ----------
    // 通过 getEdges(rootSymbolId, direction) 间接判断：
    // 若根节点不存在或无边，返回空结果
    // 此处不直接调用 adapter.queryByName 验证根节点存在性
    // （避免额外查询开销；若根节点不存在，BFS 自然返回空结果）

    // ---------- 1. direction → EdgeDirection 映射 ----------
    const edgeDirection: EdgeDirection =
      direction === "forward" ? "outgoing" : direction === "backward" ? "incoming" : "both";

    // ---------- 2. BFS 初始化 ----------
    // 队列：待扩展节点（携带深度信息）
    const queue: BfsQueueNode[] = [{ symbolId: rootSymbolId, depth: 0 }];
    // 已访问集合：避免循环遍历（含根节点，根节点不计入结果）
    const visited = new Set<string>([rootSymbolId]);
    // 结果集：受影响的符号节点（携带 BFS 深度）
    const results: ImpactedSymbol[] = [];
    // 实际到达的最大深度（初始 0，BFS 期间更新）
    let maxDepthReached = 0;

    // ---------- 3. BFS 主循环 ----------
    while (queue.length > 0) {
      // 出队队首节点
      const current = queue.shift()!;
      const currentDepth = current.depth;

      // 当前节点深度已达 maxDepth，不再扩展其邻居
      // （但有界 BFS 已处理当前节点，仅停止向更深层扩展）
      if (currentDepth >= maxDepth) {
        continue;
      }

      // 获取当前节点选定方向的边
      const edges = this.symbolGraphAdapter.getEdges(current.symbolId, edgeDirection);

      // 提取邻居节点 ID（去重，方向感知）
      // - forward / both：邻居为 outgoing 边的 dstSymbolId
      // - backward / both：邻居为 incoming 边的 srcSymbolId
      // - both：dstSymbolId + srcSymbolId 合并去重
      const neighborIds = new Set<string>();
      for (const edge of edges) {
        if (direction === "forward" || direction === "both") {
          // outgoing 边：当前节点 → dstSymbolId
          // 防御性：仅当 edge.srcSymbolId === current.symbolId 时才将 dstSymbolId 作为邻居
          if (edge.srcSymbolId === current.symbolId) {
            neighborIds.add(edge.dstSymbolId);
          }
        }
        if (direction === "backward" || direction === "both") {
          // incoming 边：srcSymbolId → 当前节点
          // 防御性：仅当 edge.dstSymbolId === current.symbolId 时才将 srcSymbolId 作为邻居
          if (edge.dstSymbolId === current.symbolId) {
            neighborIds.add(edge.srcSymbolId);
          }
        }
      }

      // 遍历邻居，未访问的加入结果集并入队
      for (const neighborId of neighborIds) {
        // 已访问：跳过（避免循环）
        if (visited.has(neighborId)) {
          continue;
        }

        // 标记为已访问
        visited.add(neighborId);

        // 查询邻居符号节点（通过 queryByName 无法精确查询 symbolId，此处直接遍历）
        // 注：SymbolGraphAdapter 接口未提供 getById 方法，但 getEdges 已返回边信息
        // 此处通过 searchByQuery 查询邻居 symbolId 的最后一段（冒号后的 name 部分）
        // 更准确的方式是遍历 adapter.queryByKind 的全部 kind 取并集，
        // 但开销过大；故此处采用 queryByName(symbolId 末段) 辅助查找
        const neighborSymbol = this.findSymbolById(neighborId);
        if (neighborSymbol === undefined) {
          // 邻居不存在于图谱中：跳过（边指向了不存在的符号，防御性处理）
          continue;
        }

        // 计算邻居深度
        const neighborDepth = currentDepth + 1;
        // 更新 maxDepthReached
        if (neighborDepth > maxDepthReached) {
          maxDepthReached = neighborDepth;
        }

        // 加入结果集（携带 depth 与 direction 信息）
        results.push({
          symbol: neighborSymbol,
          depth: neighborDepth,
          direction,
        });

        // 入队，等待后续扩展
        queue.push({ symbolId: neighborId, depth: neighborDepth });
      }
    }

    // ---------- 4. 结果排序 ----------
    // 按 (depth ASC, importance DESC) 排序
    // 同深度内按 importance 降序（高风险符号优先）
    // 同 importance 内按 symbolId 升序（稳定排序，便于测试断言）
    results.sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      const importanceDiff = b.symbol.importance - a.symbol.importance;
      if (Math.abs(importanceDiff) > 1e-9) {
        return importanceDiff;
      }
      return a.symbol.symbolId.localeCompare(b.symbol.symbolId);
    });

    // ---------- 5. 截断到 maxNodes，统计 totalNodes ----------
    const totalNodes = results.length;
    const truncated = results.slice(0, maxNodes);

    // ---------- 6. 返回 BFS 结果 ----------
    return {
      impactedSymbols: truncated,
      totalNodes,
      maxDepthReached,
    };
  };

  /**
   * 通过 symbolId 查找符号节点
   *
   * SymbolGraphAdapter 接口未提供 getById 方法，本方法通过遍历全部 kind 的
   * queryByKind 结果查找匹配 symbolId 的符号。
   *
   * 性能考量：
   * - 单次查找复杂度 O(N)，N=图谱符号数
   * - BFS 期间多次调用（每个邻居调用一次），总体复杂度 O(V*N)，V=访问节点数
   * - 对于典型项目（N<1000, V<50），可接受
   * - V2-P4 实施后，GraphStoreSymbolGraphAdapter 可提供 O(1) 的 getById 方法
   *
   * 替代方案考量（已放弃）：
   * - 通过 queryByName(symbolId 末段) 查找：name 可能重复，无法精确匹配 symbolId
   * - 通过 searchByQuery(symbolId) 查找：keyword 匹配可能命中多个符号
   * 故采用遍历 queryByKind 全部 kind 的方式，保证精确匹配 symbolId
   *
   * @param symbolId 符号 ID（精确匹配）
   * @returns 符号节点（未找到返回 undefined）
   */
  private findSymbolById = (symbolId: string): SymbolRecord | undefined => {
    // 遍历全部 kind 的 queryByKind 结果，查找 symbolId 匹配的符号
    // 注：此处使用 MAX_IMPACT_ANALYSIS_MAX_NODES 作为 limit 上限，
    //     避免在大型图谱中遍历过多符号
    const allKinds: ReadonlyArray<"function" | "class" | "interface" | "type" | "variable" | "module" | "namespace"> = [
      "function",
      "class",
      "interface",
      "type",
      "variable",
      "module",
      "namespace",
    ];

    for (const kind of allKinds) {
      const symbols = this.symbolGraphAdapter.queryByKind(kind, MAX_IMPACT_ANALYSIS_MAX_NODES);
      for (const sym of symbols) {
        if (sym.symbolId === symbolId) {
          return sym;
        }
      }
    }

    // 未找到匹配的符号
    return undefined;
  };

  /**
   * 循环检测（真实 DFS，禁 mock）
   *
   * 算法：从根节点出发，沿选定方向边 DFS 遍历，查找回到根节点的简单环。
   *
   * 算法步骤：
   * 1. 初始化 path 栈（含根节点）
   * 2. 初始化 pathSet 集合（避免路径内重复访问，保证简单环）
   * 3. 初始化 cycles 结果集（最多 MAX_CYCLES 条）
   * 4. DFS 递归：
   *    a. 当前节点 = path 末尾
   *    b. 若 path.length > maxDepth + 1：停止扩展（深度限制）
   *    c. 获取当前节点选定方向的邻居
   *    d. 对每个邻居：
   *       - 若邻居 === 根节点 且 path.length >= 2：找到一个环，记录 path + [根节点]
   *       - 若邻居 !== 根节点 且 邻居未在 path 中：递归 DFS
   * 5. 返回 cycles 结果集（最多 MAX_CYCLES 条）
   *
   * 注意事项：
   * - 仅检测从根节点出发的简单环（路径内节点不重复，起点=终点=根节点）
   * - 不检测非根节点的环（避免环爆炸）
   * - 限制环数 ≤ MAX_CYCLES=10（防止完全图等极端场景环爆炸）
   * - 限制深度 ≤ maxDepth（循环检测独立深度，由 normalizeCycleDetectionDepth 规范化，
   *   上限 MAX_CYCLE_DETECTION_DEPTH=10，独立于 BFS 的 maxDepth=3 硬约束）
   * - 每个环以 symbolId 列表形式返回（含根节点作为首尾元素）
   *
   * @param rootSymbolId 根符号 ID（环的起点与终点）
   * @param direction 遍历方向（forward/backward/both）
   * @param maxDepth 循环检测最大深度（环长度 ≤ maxDepth + 1，由 normalizeCycleDetectionDepth 规范化）
   * @returns 循环依赖列表（每个环为 symbolId 列表，从根出发回到根，最多 MAX_CYCLES 条）
   */
  private detectCycles = (
    rootSymbolId: string,
    direction: "forward" | "backward" | "both",
    maxDepth: number
  ): string[][] => {
    // ---------- 1. direction → EdgeDirection 映射 ----------
    const edgeDirection: EdgeDirection =
      direction === "forward" ? "outgoing" : direction === "backward" ? "incoming" : "both";

    // ---------- 2. DFS 初始化 ----------
    // path 栈：当前 DFS 路径（含根节点）
    const path: string[] = [rootSymbolId];
    // pathSet 集合：快速判断节点是否在 path 中（避免 O(N) 线性查找）
    const pathSet = new Set<string>([rootSymbolId]);
    // cycles 结果集：检测到的环列表（最多 MAX_CYCLES 条）
    const cycles: string[][] = [];

    // ---------- 3. DFS 递归函数 ----------
    // 使用闭包定义递归函数，访问外部变量 path / pathSet / cycles / maxDepth / rootSymbolId
    const dfs = (currentId: string): void => {
      // 已达环数上限：提前终止 DFS
      if (cycles.length >= MAX_CYCLES) {
        return;
      }

      // 当前路径长度已达 maxDepth + 1：停止扩展（深度限制）
      // path.length = maxDepth + 1 表示已遍历 maxDepth 条边，再加一条边回到根节点即形成环
      // 但此时环长度为 maxDepth + 1（含根节点首尾），符合 maxDepth 约束
      // 故允许 path.length === maxDepth + 1 时继续检查是否能回到根节点
      if (path.length > maxDepth + 1) {
        return;
      }

      // 获取当前节点选定方向的边
      const edges = this.symbolGraphAdapter.getEdges(currentId, edgeDirection);

      // 提取邻居节点 ID（去重，方向感知）
      const neighborIds = new Set<string>();
      for (const edge of edges) {
        if (direction === "forward" || direction === "both") {
          if (edge.srcSymbolId === currentId) {
            neighborIds.add(edge.dstSymbolId);
          }
        }
        if (direction === "backward" || direction === "both") {
          if (edge.dstSymbolId === currentId) {
            neighborIds.add(edge.srcSymbolId);
          }
        }
      }

      // 遍历邻居
      for (const neighborId of neighborIds) {
        // 已达环数上限：提前终止
        if (cycles.length >= MAX_CYCLES) {
          return;
        }

        // 邻居 === 根节点 且 path.length >= 2：找到一个环
        // path.length >= 2 保证环至少含 2 个不同节点（根 + 至少一个中间节点）
        if (neighborId === rootSymbolId && path.length >= 2) {
          // 记录环：path + [rootSymbolId]
          // 注：path 末尾不含根节点（根节点仅在 path[0]），故追加根节点形成闭合环
          cycles.push([...path, rootSymbolId]);
          continue;
        }

        // 邻居 !== 根节点 且 邻居未在 path 中：递归 DFS
        // 邻居在 path 中（非根节点）：跳过（避免非简单环）
        if (neighborId !== rootSymbolId && !pathSet.has(neighborId)) {
          // 入栈
          path.push(neighborId);
          pathSet.add(neighborId);

          // 递归 DFS
          dfs(neighborId);

          // 出栈（回溯）
          path.pop();
          pathSet.delete(neighborId);
        }
      }
    };

    // ---------- 4. 启动 DFS ----------
    dfs(rootSymbolId);

    // ---------- 5. 返回环列表 ----------
    return cycles;
  };
}
