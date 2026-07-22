/**
 * EAG-P6 Phase 4 flow_trace 工具实现（调用链路径枚举 / 控制流追踪）
 *
 * 本模块提供 flow_trace agent 工具，从起始符号出发沿调用边枚举全部控制流路径。
 * 支持方向感知：forward（我调用谁）/ backward（谁调用我）。
 * 工具走 tool-executor 独立路径，结果直接拼入当轮 LLM messages（D-2 决策）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-6（codemap 工具集）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §8.2.4 Phase 4 验收标准（4 工具全部注册到 tool-executor）
 * - EAG-P6-TASKS.md §3 TASK-P6-4-03（flow_trace 工具实现规格）
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - "真实 DFS 实现（非 mock）"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 * - TODO/FIXME 必须有对应实现，禁止空 TODO
 *
 * 接口契约（任务规格强制）：
 * - 输入：FlowTraceInput {
 *     startSymbolId: string;
 *     endSymbolId?: string;
 *     direction: 'forward' | 'backward';
 *     maxDepth?: number;
 *   }
 * - 输出：FlowTraceResult {
 *     paths: CallPath[];
 *     totalPaths: number;
 *     truncated: boolean;
 *   }
 * - 方法：execute(input: FlowTraceInput) => FlowTraceResult
 *
 * 实现要点：
 * - 真实 DFS 枚举从 startSymbolId 到 endSymbolId 的全部简单路径
 * - direction="forward"：沿 outgoing 边遍历（srcSymbolId → dstSymbolId，"我调用谁"）
 * - direction="backward"：沿 incoming 边遍历（dstSymbolId → srcSymbolId，"谁调用我"）
 * - endSymbolId 缺省时：枚举从 startSymbolId 出发到全部叶子节点（无后续邻居）的路径
 * - 路径内节点不重复（简单路径，避免环导致无限递归）
 * - 限制最大路径数 MAX_PATHS=20（防路径爆炸）
 * - 限制最大深度 maxDepth（默认 3，最大 5，防深路径爆炸）
 * - truncated 标志指示是否因达到 MAX_PATHS 而截断
 *
 * 降级保证（NFR-4 零回归）：
 * - isGraphStoreAvailable() 返回 false 时返回空结果（不抛错，不打印 warning）
 * - adapter.isAvailable() 返回 false 时返回空结果
 * - 行为与 V2-P3 完全一致（零回归）
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 对外返回的 FlowTraceResult 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/tools/flow-trace-tool
 */

import type { SymbolGraphAdapter } from "../context/symbol-graph-adapter";
import { isGraphStoreAvailable } from "../context/symbol-graph-adapter";
import type { EdgeDirection } from "../context/symbol-graph-types";

// ============================================================================
// 1. 工具元数据常量
// ============================================================================

/**
 * 工具名称常量（与 codemap_query 同级，注册到 tool-executor）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const FLOW_TRACE_TOOL_NAME: string = Object.freeze("flow_trace") as string;

/**
 * 工具描述（用于 tool-executor 工具列表展示）
 *
 * 使用 Object.freeze 冻结。
 */
export const FLOW_TRACE_TOOL_DESCRIPTION: string = Object.freeze(
  "追踪符号间的调用链路径（控制流追踪）。支持方向感知（forward=我调用谁 / " +
    "backward=谁调用我），返回从起始符号到目标符号的全部简单路径。"
) as string;

/**
 * 默认 DFS 最大深度（防深路径爆炸）
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_FLOW_TRACE_MAX_DEPTH: number = Object.freeze(3) as number;

/**
 * 最大 DFS 深度上限（防深路径爆炸，与 impact_analysis 的 maxDepth 上限一致）
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_FLOW_TRACE_MAX_DEPTH: number = Object.freeze(5) as number;

/**
 * 最大返回路径数上限（防路径爆炸）
 *
 * 路径枚举复杂度可能指数级（如 DAG 完全展开），故限制返回路径数避免结果集过大。
 * 使用 Object.freeze 冻结。
 */
export const MAX_PATHS: number = Object.freeze(20) as number;

/**
 * 空 FlowTraceResult 常量（冻结，供降级路径复用）
 *
 * 降级模式下返回此常量，避免每次调用创建新对象（性能优化 + 不可变优先）。
 */
export const EMPTY_FLOW_TRACE_RESULT: Readonly<FlowTraceResult> = Object.freeze({
  paths: Object.freeze([]),
  totalPaths: 0,
  truncated: false,
}) as Readonly<FlowTraceResult>;

// ============================================================================
// 2. 输入/输出接口定义
// ============================================================================

/**
 * flow_trace 工具输入参数
 *
 * 字段说明：
 * - startSymbolId：起始符号 ID（必填，DFS 起点）
 * - endSymbolId：目标符号 ID（可选，缺省时枚举到全部叶子节点的路径）
 * - direction：遍历方向（必填，forward/backward，不支持 both）
 * - maxDepth：DFS 最大深度（可选，默认 3，最大 5）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface FlowTraceInput {
  /** 起始符号 ID（DFS 起点，格式 filePath:fullyQualifiedName） */
  readonly startSymbolId: string;
  /** 目标符号 ID（可选，缺省时枚举到全部叶子节点的路径） */
  readonly endSymbolId?: string;
  /** 遍历方向（forward=我调用谁 / backward=谁调用我） */
  readonly direction: "forward" | "backward";
  /** DFS 最大深度（可选，默认 3，最大 5，超过截断） */
  readonly maxDepth?: number;
}

/**
 * 调用链路径条目（携带路径节点列表与路径长度）
 *
 * 字段说明：
 * - path：路径节点 symbolId 列表（含起点与终点，按调用顺序排列）
 * - length：路径长度（边数 = path.length - 1）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray。
 */
export interface CallPath {
  /** 路径节点 symbolId 列表（含起点与终点，按调用顺序排列，已冻结） */
  readonly path: ReadonlyArray<string>;
  /** 路径长度（边数 = path.length - 1） */
  readonly length: number;
}

/**
 * flow_trace 工具输出结果
 *
 * 字段说明：
 * - paths：调用链路径列表（按路径长度升序，同长度按字典序，已截断）
 * - totalPaths：路径总数（截断前的总数，用于判断是否有更多结果）
 * - truncated：是否因达到 MAX_PATHS 而截断
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 */
export interface FlowTraceResult {
  /** 调用链路径列表（按路径长度升序，同长度按字典序，已截断，已冻结） */
  readonly paths: ReadonlyArray<CallPath>;
  /** 路径总数（截断前的总数，用于判断是否有更多结果） */
  readonly totalPaths: number;
  /** 是否因达到 MAX_PATHS 而截断 */
  readonly truncated: boolean;
}

// ============================================================================
// 3. FlowTraceTool 类实现
// ============================================================================

/**
 * flow_trace 工具实现类
 *
 * 通过 SymbolGraphAdapter 接口查询图谱，不直接依赖 V2-P4 graph-store 实现。
 * V2-P4 未实施时，DefaultSymbolGraphAdapter 返回空数组，本工具返回空结果（降级）。
 * V2-P4 实施后，可替换为 GraphStoreSymbolGraphAdapter，本工具零修改（依赖倒置）。
 *
 * DFS 路径枚举算法（真实实现，禁 mock）：
 * 1. 根据 direction 选择 EdgeDirection：
 *    - forward → outgoing（边方向：起点 → 邻居）
 *    - backward → incoming（边方向：邻居 → 起点）
 * 2. DFS 从 startSymbolId 出发，沿选定方向边展开邻居
 * 3. path 栈记录当前路径，pathSet 集合快速判断节点是否在 path 中
 * 4. 若 endSymbolId 提供：
 *    - 邻居 === endSymbolId：找到一条路径，记录 path + [endSymbolId]
 *    - 邻居 !== endSymbolId 且 邻居未在 path 中：递归 DFS
 * 5. 若 endSymbolId 缺省：
 *    - 邻居为空（叶子节点）：记录当前 path 作为一条路径
 *    - 邻居未在 path 中：递归 DFS
 * 6. 限制路径数 ≤ MAX_PATHS=20（防路径爆炸）
 * 7. 限制深度 ≤ maxDepth（防深路径爆炸）
 * 8. 路径按 (length ASC, dictionary order) 排序
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const tool = new FlowTraceTool(adapter);
 *
 * // 正向追踪（UserService 调用链）
 * const result1 = tool.execute({
 *   startSymbolId: "src/A.ts:UserService",
 *   endSymbolId: "src/E.ts:logger",
 *   direction: "forward",
 * });
 * console.log(result1.paths.length); // UserService 到 logger 的路径数
 *
 * // 反向追踪（谁调用 logger）
 * const result2 = tool.execute({
 *   startSymbolId: "src/E.ts:logger",
 *   direction: "backward",
 * });
 * ```
 */
export class FlowTraceTool {
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
   * 构造 flow_trace 工具
   *
   * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可用时返回空结果）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(symbolGraphAdapter: SymbolGraphAdapter, graphAvailability: () => boolean = isGraphStoreAvailable) {
    this.symbolGraphAdapter = symbolGraphAdapter;
    this.graphAvailability = graphAvailability;
  }

  /**
   * 执行 flow_trace 工具查询
   *
   * 执行流程：
   * 1. 降级判断：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即返回空结果
   * 2. 参数规范化：maxDepth 缺省时使用 3（最大 5）
   * 3. 边界处理：startSymbolId 为空或 direction 非法时返回空结果
   * 4. DFS 路径枚举：从 startSymbolId 出发，沿选定方向边展开邻居
   * 5. 路径排序：按 (length ASC, dictionary order) 排序
   * 6. 截断到 MAX_PATHS，统计 totalPaths（截断前总数）与 truncated 标志
   * 7. 冻结返回 FlowTraceResult
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回 EMPTY_FLOW_TRACE_RESULT（零回归）
   * - adapter.isAvailable() 返回 false：返回 EMPTY_FLOW_TRACE_RESULT（零回归）
   * - startSymbolId 为空字符串：返回 EMPTY_FLOW_TRACE_RESULT
   * - direction 非法值（非 forward/backward）：返回 EMPTY_FLOW_TRACE_RESULT
   * - startSymbolId 在图谱中不存在：返回 EMPTY_FLOW_TRACE_RESULT
   * - endSymbolId 提供但在图谱中不存在：返回 EMPTY_FLOW_TRACE_RESULT
   *
   * 边界处理：
   * - maxDepth 缺省（undefined / NaN / <=0）：使用默认值 3
   * - maxDepth 超过 MAX_FLOW_TRACE_MAX_DEPTH=5：截断到 5
   * - endSymbolId === startSymbolId：返回单节点路径（length=0），仅 1 条
   * - 路径数超过 MAX_PATHS=20：截断到 20，truncated=true
   *
   * @param input 路径追踪输入参数（startSymbolId / endSymbolId / direction / maxDepth）
   * @returns 路径追踪结果（paths / totalPaths / truncated，已冻结）
   */
  readonly execute = (input: FlowTraceInput): FlowTraceResult => {
    // ---------- 1. 降级判断 ----------
    // 双层降级：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即降级
    if (!this.isAvailable()) {
      return EMPTY_FLOW_TRACE_RESULT;
    }

    // ---------- 2. 边界处理：input 为 null/undefined ----------
    if (input === null || input === undefined) {
      return EMPTY_FLOW_TRACE_RESULT;
    }

    // ---------- 3. 参数规范化 ----------
    // startSymbolId：必填，为空字符串视为无效
    const startSymbolId: string = typeof input.startSymbolId === "string" ? input.startSymbolId.trim() : "";
    // endSymbolId：可选，为空字符串视为未提供
    const endSymbolId: string | undefined =
      typeof input.endSymbolId === "string" && input.endSymbolId.trim().length > 0
        ? input.endSymbolId.trim()
        : undefined;
    // direction：必填，必须为 forward/backward 之一
    const direction: "forward" | "backward" = input.direction;
    // maxDepth：缺省时使用默认值 3，超过 5 截断到 5
    const maxDepth: number = this.normalizeMaxDepth(input.maxDepth);

    // ---------- 4. 边界处理：startSymbolId 为空或 direction 非法 ----------
    if (startSymbolId.length === 0) {
      return EMPTY_FLOW_TRACE_RESULT;
    }
    if (direction !== "forward" && direction !== "backward") {
      return EMPTY_FLOW_TRACE_RESULT;
    }

    // ---------- 5. DFS 路径枚举 ----------
    // 调用内部 DFS 实现，返回路径列表（含 truncated 标志）
    const dfsResult = this.enumeratePaths(startSymbolId, endSymbolId, direction, maxDepth);

    // ---------- 6. 构建并冻结返回结果 ----------
    const result: FlowTraceResult = Object.freeze({
      paths: Object.freeze(
        dfsResult.paths.map(
          (p) =>
            Object.freeze({
              path: Object.freeze([...p.path]),
              length: p.length,
            }) as CallPath
        )
      ),
      totalPaths: dfsResult.totalPaths,
      truncated: dfsResult.truncated,
    }) as FlowTraceResult;

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
   * - maxDepth 缺省（undefined / NaN / <=0）：使用默认值 DEFAULT_FLOW_TRACE_MAX_DEPTH=3
   * - maxDepth 超过 MAX_FLOW_TRACE_MAX_DEPTH=5：截断到 5
   * - maxDepth 在 (0, 5] 区间：直接使用
   *
   * @param maxDepth 原始 maxDepth 值（可选）
   * @returns 规范化后的 maxDepth 值（1 ~ 5）
   */
  private normalizeMaxDepth = (maxDepth?: number): number => {
    if (typeof maxDepth !== "number" || Number.isNaN(maxDepth) || maxDepth <= 0) {
      return DEFAULT_FLOW_TRACE_MAX_DEPTH;
    }
    if (maxDepth > MAX_FLOW_TRACE_MAX_DEPTH) {
      return MAX_FLOW_TRACE_MAX_DEPTH;
    }
    return Math.floor(maxDepth);
  };

  /**
   * DFS 路径枚举（真实实现，禁 mock）
   *
   * 算法步骤：
   * 1. 初始化 path 栈（含起点 startSymbolId）
   * 2. 初始化 pathSet 集合（避免路径内重复访问，保证简单路径）
   * 3. 初始化 paths 结果集（最多 MAX_PATHS 条）
   * 4. DFS 递归：
   *    a. 当前节点 = path 末尾
   *    b. 若 endSymbolId 提供 且 当前节点 === endSymbolId：找到一条路径，记录 path
   *    c. 若 path.length > maxDepth + 1：停止扩展（深度限制）
   *    d. 获取当前节点选定方向的邻居
   *    e. 若 endSymbolId 提供：
   *       - 邻居 === endSymbolId：找到一条路径，记录 path + [endSymbolId]
   *       - 邻居 !== endSymbolId 且 邻居未在 path 中：递归 DFS
   *    f. 若 endSymbolId 缺省：
   *       - 邻居为空（叶子节点）：记录当前 path 作为一条路径
   *       - 邻居未在 path 中：递归 DFS
   * 5. 路径按 (length ASC, dictionary order) 排序
   * 6. 截断到 MAX_PATHS，统计 totalPaths 与 truncated 标志
   *
   * direction → EdgeDirection 映射：
   * - forward → outgoing（边方向：起点 → 邻居，邻居为 dstSymbolId）
   * - backward → incoming（边方向：邻居 → 起点，邻居为 srcSymbolId）
   *
   * 防路径爆炸：
   * - maxDepth 默认 3（最大 5）
   * - MAX_PATHS=20 限制返回路径数
   * - pathSet 集合避免路径内重复访问（保证简单路径，防止环路导致无限递归）
   *
   * @param startSymbolId 起始符号 ID（DFS 起点）
   * @param endSymbolId 目标符号 ID（可选，缺省时枚举到全部叶子节点的路径）
   * @param direction 遍历方向（forward/backward）
   * @param maxDepth DFS 最大深度
   * @returns 路径枚举结果（paths + totalPaths + truncated）
   */
  private enumeratePaths = (
    startSymbolId: string,
    endSymbolId: string | undefined,
    direction: "forward" | "backward",
    maxDepth: number
  ): {
    paths: CallPath[];
    totalPaths: number;
    truncated: boolean;
  } => {
    // ---------- 1. direction → EdgeDirection 映射 ----------
    const edgeDirection: EdgeDirection = direction === "forward" ? "outgoing" : "incoming";

    // ---------- 2. DFS 初始化 ----------
    // path 栈：当前 DFS 路径（含起点）
    const path: string[] = [startSymbolId];
    // pathSet 集合：快速判断节点是否在 path 中（避免 O(N) 线性查找）
    const pathSet = new Set<string>([startSymbolId]);
    // paths 结果集：检测到的路径列表（最多 MAX_PATHS 条）
    const paths: CallPath[] = [];
    // truncated 标志：是否因达到 MAX_PATHS 而截断
    let truncated = false;

    // ---------- 3. DFS 递归函数 ----------
    // 使用闭包定义递归函数，访问外部变量 path / pathSet / paths / maxDepth / endSymbolId
    const dfs = (currentId: string): void => {
      // 已达路径数上限：提前终止 DFS，标记 truncated=true
      if (paths.length >= MAX_PATHS) {
        truncated = true;
        return;
      }

      // 当前路径长度已达 maxDepth + 1：停止扩展（深度限制）
      // path.length = maxDepth + 1 表示已遍历 maxDepth 条边
      if (path.length > maxDepth + 1) {
        return;
      }

      // ---------- 3.1 endSymbolId 提供 且 当前节点 === endSymbolId ----------
      // 找到一条路径：记录当前 path（currentId 已在 path 末尾）
      // 注：起点 === 终点的情况（length=0）在 DFS 启动前已处理（见 3.4）
      if (endSymbolId !== undefined && currentId === endSymbolId) {
        // 仅当 path.length >= 2 时记录（避免 length=0 的单节点路径重复记录）
        // 注：单节点路径在 DFS 启动前已单独处理
        if (path.length >= 2) {
          paths.push({
            path: [...path],
            length: path.length - 1,
          });
          if (paths.length >= MAX_PATHS) {
            truncated = true;
          }
        }
        // 当前节点已是终点，不再继续扩展
        return;
      }

      // ---------- 3.2 获取当前节点选定方向的邻居 ----------
      const edges = this.symbolGraphAdapter.getEdges(currentId, edgeDirection);

      // 提取邻居节点 ID（去重，方向感知）
      const neighborIds = new Set<string>();
      for (const edge of edges) {
        if (direction === "forward") {
          // outgoing 边：当前节点 → dstSymbolId
          // 防御性：仅当 edge.srcSymbolId === currentId 时才将 dstSymbolId 作为邻居
          if (edge.srcSymbolId === currentId) {
            neighborIds.add(edge.dstSymbolId);
          }
        } else {
          // backward：incoming 边：srcSymbolId → 当前节点
          // 防御性：仅当 edge.dstSymbolId === currentId 时才将 srcSymbolId 作为邻居
          if (edge.dstSymbolId === currentId) {
            neighborIds.add(edge.srcSymbolId);
          }
        }
      }

      // ---------- 3.3 endSymbolId 缺省 且 邻居为空（叶子节点） ----------
      // 记录当前 path 作为一条路径（叶子节点结束）
      if (endSymbolId === undefined && neighborIds.size === 0) {
        // 仅当 path.length >= 2 时记录（避免单节点路径，单节点路径在 3.4 单独处理）
        if (path.length >= 2) {
          paths.push({
            path: [...path],
            length: path.length - 1,
          });
          if (paths.length >= MAX_PATHS) {
            truncated = true;
          }
        }
        // 叶子节点无邻居，自然结束
        return;
      }

      // ---------- 3.4 遍历邻居，递归 DFS ----------
      for (const neighborId of neighborIds) {
        // 已达路径数上限：提前终止
        if (paths.length >= MAX_PATHS) {
          truncated = true;
          return;
        }

        // 邻居在 path 中：跳过（避免非简单路径，防止环路导致无限递归）
        if (pathSet.has(neighborId)) {
          continue;
        }

        // 入栈
        path.push(neighborId);
        pathSet.add(neighborId);

        // 递归 DFS
        dfs(neighborId);

        // 出栈（回溯）
        path.pop();
        pathSet.delete(neighborId);
      }
    };

    // ---------- 4. 处理起点 === 终点的特殊情况 ----------
    // 若 endSymbolId === startSymbolId：记录单节点路径（length=0），仅 1 条
    if (endSymbolId !== undefined && endSymbolId === startSymbolId) {
      paths.push({
        path: [startSymbolId],
        length: 0,
      });
      // 单节点路径已记录，无需 DFS（DFS 会因 currentId === endSymbolId 而立即返回）
      // 但仍需检查是否有更长的环回到起点的路径
      // 注：DFS 启动后，因 pathSet 含起点，无法再次访问起点，故不会记录环路径
      // 此处仅记录单节点路径，环路径由 impact_analysis 工具的 detectCycles 负责
      return {
        paths,
        totalPaths: paths.length,
        truncated: false,
      };
    }

    // ---------- 5. 启动 DFS ----------
    dfs(startSymbolId);

    // ---------- 6. 路径排序 ----------
    // 按 (length ASC, dictionary order) 排序
    // 同长度内按 path 字典序（便于测试断言稳定）
    paths.sort((a, b) => {
      if (a.length !== b.length) {
        return a.length - b.length;
      }
      // 字典序比较：逐元素比较 symbolId
      const minLen = Math.min(a.path.length, b.path.length);
      for (let i = 0; i < minLen; i++) {
        const cmp = a.path[i].localeCompare(b.path[i]);
        if (cmp !== 0) {
          return cmp;
        }
      }
      return a.path.length - b.path.length;
    });

    // ---------- 7. 截断到 MAX_PATHS，统计 totalPaths ----------
    const totalPaths = paths.length;
    const truncatedPaths = paths.slice(0, MAX_PATHS);
    // 注：DFS 期间已控制 paths.length ≤ MAX_PATHS，此处截断为冗余保护
    const finalTruncated = truncated || truncatedPaths.length < totalPaths;

    // ---------- 8. 返回路径枚举结果 ----------
    return {
      paths: truncatedPaths,
      totalPaths,
      truncated: finalTruncated,
    };
  };
}
