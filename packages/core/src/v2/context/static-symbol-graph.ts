/**
 * EAG-P6 Phase 1 StaticSymbolGraph 真实降级实现（Map + BFS）
 *
 * 本模块提供 SymbolGraphAdapter 接口的"静态图谱实现"——StaticSymbolGraph。
 * 通过构造时注入 StaticGraphData（符号列表 + 边列表），在内存中构建
 * 真实的图谱索引（Map + 双向边索引），并提供真实的查询能力：
 * - queryByName：字符串精确匹配 + 包含匹配（不区分大小写）
 * - queryByKind：kind 字段过滤 + importance 降序排序
 * - getEdges：Map 索引查找（incoming/outgoing/both）
 * - getExplosionRadius：真实有界 BFS（双向边遍历，禁 mock）
 * - getRiskHotspots：按 importance 降序排序，取 Top-N
 * - searchByQuery：分词 + 命中数排序的关键词检索
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-7（CodeMap 降级探测）+ §4 NFR-4（降级零回归）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §6 数据流图（StaticSymbolGraph 在 DW-1/DW-2/DW-3 数据流中作为数据源）
 *   + §11.3.2 V2-P4 未实施时的降级路径
 * - EAG-P6-TASKS.md §3 TASK-P6-1-01 部分 4（StaticSymbolGraph 类实现）
 *
 * 用户关键约束（任务规格强制）：
 * - "StaticSymbolGraph 必须是真实降级实现（基于 Map + BFS，不是 mock 返回固定值）"
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 *
 * 使用场景：
 * 1. 测试 fixtures 注入：单元测试 / 集成测试通过 StaticGraphData 构造图谱，
 *    验证 BFS / 排序 / 检索逻辑（TC-ADAPTER-006~009 验证）
 * 2. 序列化图谱加载：从 codemap.json / codemap.db dump 加载到内存
 * 3. PKC L2 索引派生：从 IndexedSymbol 派生 SymbolRecord，无显式边时 edges 为空数组
 * 4. V2-P4 未实施时的轻量降级：通过 L2 索引派生静态图谱，提供有限但真实的查询能力
 *
 * 算法说明：
 * - BFS（广度优先搜索）：从根节点出发，沿边逐层扩展，直到达到 maxDepth 或 maxNodes
 *   双向边覆盖：BFS 同时遍历 outgoing + incoming 边（影响面分析需要反向调用者链）
 *   防图谱爆炸：maxDepth 默认 2（最大 3），maxNodes 限制返回节点数
 *
 * 性能考量：
 * - 构造时一次性构建索引（O(N+M)，N=符号数，M=边数），后续查询 O(1) 或 O(log N)
 * - BFS 时间复杂度 O(V+E)，V=访问节点数，E=访问边数（受 maxDepth/maxNodes 约束）
 * - 索引内存占用：3 个 Map（symbolById + outgoingEdges + incomingEdges），
 *   约为原始数据的 2-3 倍（典型项目 < 10MB，可接受）
 *
 * 不可变优先原则：
 * - 类内部 Map 使用 ReadonlyArray 包装对外返回（防止外部修改）
 * - 返回的 SymbolRecord / EdgeRecord 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/context/static-symbol-graph
 */

import type { EdgeDirection, EdgeRecord, StaticGraphData, SymbolKind, SymbolRecord } from "./symbol-graph-types";
import { EMPTY_EDGE_RECORDS, EMPTY_SYMBOL_RECORDS, type SymbolGraphAdapter } from "./symbol-graph-adapter";

// ============================================================================
// 1. 内部辅助类型：BFS 访问节点（携带深度信息）
// ============================================================================

/**
 * BFS 队列节点（携带 BFS 深度信息）
 *
 * 用于 getExplosionRadius 的 BFS 遍历，记录每个被访问节点的深度，
 * 深度超过 maxDepth 时停止扩展（但有界 BFS 仍会处理当前层全部节点）。
 *
 * 字段：
 * - symbolId：节点符号 ID
 * - depth：BFS 深度（根节点为 0，其直接邻居为 1，依此类推）
 */
interface BfsQueueNode {
  readonly symbolId: string;
  readonly depth: number;
}

// ============================================================================
// 2. StaticSymbolGraph 类
// ============================================================================

/**
 * 静态符号图谱（SymbolGraphAdapter 接口的"内存图谱"实现）
 *
 * 通过构造时注入的 StaticGraphData 构建内存索引，提供真实的图谱查询能力。
 * 不依赖外部数据库（better-sqlite3），适合：
 * - 测试 fixtures 注入
 * - 序列化图谱加载
 * - V2-P4 未实施时的轻量降级
 *
 * 内部索引结构（构造时一次性构建）：
 * - symbolById: Map<string, SymbolRecord>（symbolId → 符号节点，O(1) 查找）
 * - outgoingEdges: Map<string, ReadonlyArray<EdgeRecord>>（srcSymbolId → 出边列表）
 * - incomingEdges: Map<string, ReadonlyArray<EdgeRecord>>（dstSymbolId → 入边列表）
 *
 * 查询方法实现：
 * - isAvailable(): 始终返回 true（静态图谱已构建，可用）
 * - queryByName: 精确匹配优先 → 包含匹配次之，不区分大小写，按匹配度排序
 * - queryByKind: kind 过滤 + importance 降序排序
 * - getEdges: Map 索引查找，按 direction 过滤（incoming/outgoing/both）
 * - getExplosionRadius: 真实 BFS（双向边遍历，maxDepth/maxNodes 限制）
 * - getRiskHotspots: 按 importance 降序排序，取 Top-N
 * - searchByQuery: 分词 + 命中数排序的关键词检索
 *
 * 不可变保证：
 * - 内部 Map 一旦构建不再修改（构造后只读）
 * - 对外返回的数组均为冻结的 ReadonlyArray（防止外部修改破坏索引一致性）
 * - 返回的 SymbolRecord / EdgeRecord 均为冻结对象
 *
 * 使用示例：
 * ```typescript
 * const data: StaticGraphData = {
 *   symbolRecords: [
 *     { symbolId: "src/A.ts:A", kind: "class", name: "A", ..., importance: 0.8 },
 *     { symbolId: "src/B.ts:B", kind: "function", name: "B", ..., importance: 0.5 }
 *   ],
 *   edgeRecords: [
 *     { edgeId: "e1", srcSymbolId: "src/A.ts:A", dstSymbolId: "src/B.ts:B",
 *       edgeKind: "CALLS", confidence: "HIGH" }
 *   ]
 * };
 * const graph = new StaticSymbolGraph(data);
 * console.log(graph.isAvailable()); // true
 * console.log(graph.queryByName("A", 10).length); // 1
 * console.log(graph.getExplosionRadius("src/A.ts:A", 2, 50).length); // 1 (B)
 * ```
 */
export class StaticSymbolGraph implements SymbolGraphAdapter {
  /**
   * 符号 ID → 符号节点 映射（核心索引，O(1) 查找）
   *
   * 构造时一次性构建，后续只读。
   * 键：symbolId（如 "src/services/UserService.ts:UserService"）
   * 值：SymbolRecord（冻结的符号节点对象）
   */
  private readonly symbolById: ReadonlyMap<string, SymbolRecord>;

  /**
   * 源符号 ID → 出边列表 映射（出边索引，用于 outgoing / both 方向查询）
   *
   * 构造时一次性构建，后续只读。
   * 键：srcSymbolId
   * 值：该符号作为边的起点的全部 EdgeRecord（按 edgeId 排序，便于稳定输出）
   */
  private readonly outgoingEdges: ReadonlyMap<string, ReadonlyArray<EdgeRecord>>;

  /**
   * 目标符号 ID → 入边列表 映射（入边索引，用于 incoming / both 方向查询）
   *
   * 构造时一次性构建，后续只读。
   * 键：dstSymbolId
   * 值：该符号作为边的终点的全部 EdgeRecord（按 edgeId 排序，便于稳定输出）
   */
  private readonly incomingEdges: ReadonlyMap<string, ReadonlyArray<EdgeRecord>>;

  /**
   * 全部符号节点列表（按 symbolId 排序，便于 queryByKind / getRiskHotspots 稳定输出）
   *
   * 构造时一次性构建并排序，后续只读。
   * 缓存此列表避免每次查询都从 Map 重新提取并排序。
   */
  private readonly sortedSymbols: ReadonlyArray<SymbolRecord>;

  /**
   * 全部符号节点列表（按 importance 降序排序，便于 getRiskHotspots 稳定输出）
   *
   * 构造时一次性构建并排序，后续只读。
   * 缓存此列表避免每次 getRiskHotspots 调用都重新排序。
   */
  private readonly sortedByImportance: ReadonlyArray<SymbolRecord>;

  /**
   * 构造函数：注入静态图谱数据，构建内存索引
   *
   * 执行流程：
   * 1. 校验入参（data 不能为 null/undefined，symbolRecords/edgeRecords 可为空数组）
   * 2. 构建 symbolById Map（O(N)）
   * 3. 构建 outgoingEdges / incomingEdges Map（O(M)）
   * 4. 预排序 sortedSymbols（按 symbolId 升序，O(N log N)）
   * 5. 预排序 sortedByImportance（按 importance 降序，O(N log N)）
   *
   * 时间复杂度：O(N log N + M)，N=符号数，M=边数
   * 空间复杂度：O(N + M)（3 个 Map + 2 个排序列表）
   *
   * @param data 静态图谱数据包（symbolRecords + edgeRecords）
   * @throws {Error} data 为 null/undefined 时抛错（编程错误，不应在运行时发生）
   */
  constructor(data: StaticGraphData) {
    // ---------- 1. 校验入参 ----------
    // data 为 null/undefined 是编程错误（调用方应保证），抛错避免后续逻辑崩溃
    if (data === null || data === undefined) {
      throw new Error("StaticSymbolGraph 构造失败：data 不能为 null/undefined");
    }
    // symbolRecords / edgeRecords 可为空数组（无符号 / 无边的合法场景）
    const symbolRecords = data.symbolRecords ?? [];
    const edgeRecords = data.edgeRecords ?? [];

    // ---------- 2. 构建 symbolById Map ----------
    // O(N) 一次性构建，后续查询 O(1)
    // 注：Map 保留插入顺序，重复 symbolId 后者覆盖前者（与 V2-P4 graph-store 行为一致）
    const symbolById = new Map<string, SymbolRecord>();
    for (const sym of symbolRecords) {
      // 冻结每个符号节点，防止外部修改破坏索引一致性
      symbolById.set(sym.symbolId, Object.freeze({ ...sym }));
    }
    this.symbolById = symbolById;

    // ---------- 3. 构建 outgoingEdges / incomingEdges Map ----------
    // O(M) 一次性构建，后续查询 O(1)
    // 边列表按 edgeId 排序，保证 getEdges 输出稳定（便于测试断言）
    const outgoingMap = new Map<string, EdgeRecord[]>();
    const incomingMap = new Map<string, EdgeRecord[]>();
    for (const edge of edgeRecords) {
      // 冻结每条边，防止外部修改
      const frozenEdge = Object.freeze({ ...edge });

      // 出边索引：srcSymbolId → 边列表
      const outList = outgoingMap.get(edge.srcSymbolId) ?? [];
      outList.push(frozenEdge);
      outgoingMap.set(edge.srcSymbolId, outList);

      // 入边索引：dstSymbolId → 边列表
      const inList = incomingMap.get(edge.dstSymbolId) ?? [];
      inList.push(frozenEdge);
      incomingMap.set(edge.dstSymbolId, inList);
    }
    // 对每个符号的边列表按 edgeId 排序，保证 getEdges 输出稳定
    // 同时将可变数组冻结为 ReadonlyArray，防止外部修改
    const outgoingEdges = new Map<string, ReadonlyArray<EdgeRecord>>();
    for (const [key, list] of outgoingMap) {
      const sorted = list.slice().sort((a, b) => compareEdgeById(a, b));
      outgoingEdges.set(key, Object.freeze(sorted));
    }
    this.outgoingEdges = outgoingEdges;

    const incomingEdges = new Map<string, ReadonlyArray<EdgeRecord>>();
    for (const [key, list] of incomingMap) {
      const sorted = list.slice().sort((a, b) => compareEdgeById(a, b));
      incomingEdges.set(key, Object.freeze(sorted));
    }
    this.incomingEdges = incomingEdges;

    // ---------- 4. 预排序 sortedSymbols（按 symbolId 升序） ----------
    // 缓存排序列表，避免每次 queryByKind / searchByQuery 都重新排序
    const sortedSymbols = symbolRecords
      .slice()
      .sort((a, b) => a.symbolId.localeCompare(b.symbolId))
      .map((s) => Object.freeze({ ...s }));
    this.sortedSymbols = Object.freeze(sortedSymbols);

    // ---------- 5. 预排序 sortedByImportance（按 importance 降序） ----------
    // 缓存排序列表，避免每次 getRiskHotspots 都重新排序
    // importance 相同时按 symbolId 升序（保证稳定排序，便于测试断言）
    const sortedByImportance = symbolRecords
      .slice()
      .sort((a, b) => {
        // 降序：b.importance - a.importance
        const diff = b.importance - a.importance;
        if (Math.abs(diff) > 1e-9) {
          return diff;
        }
        // importance 相同时按 symbolId 升序（稳定排序）
        return a.symbolId.localeCompare(b.symbolId);
      })
      .map((s) => Object.freeze({ ...s }));
    this.sortedByImportance = Object.freeze(sortedByImportance);
  }

  /**
   * 探测图谱是否可用
   *
   * StaticSymbolGraph 构造后即视为可用（已构建内存索引），始终返回 true。
   * 调用方依据此返回值决定是否走图谱增强路径。
   *
   * @returns 始终返回 true（静态图谱已构建，可用）
   */
  readonly isAvailable = (): boolean => true;

  /**
   * 按符号名查询符号
   *
   * 简单字符串匹配（无 FTS5 BM25 索引），匹配规则：
   * 1. 精确匹配 symbol.name（不区分大小写）优先
   * 2. 包含匹配 symbol.name.includes(name)（不区分大小写）次之
   * 3. 返回结果按匹配度排序（精确匹配在前，包含匹配在后）
   * 4. 同匹配度内按 importance 降序排序（高风险符号优先）
   * 5. 截断到 limit 条
   *
   * 边界处理：
   * - name 为空字符串：返回空数组（无意义查询）
   * - limit <= 0：返回空数组（无意义限制）
   * - 无匹配：返回空数组
   *
   * @param name 符号名（部分匹配，如 "User" 可匹配 "UserService"）
   * @param limit 返回结果数上限
   * @returns 匹配的符号列表（最多 limit 条，按匹配度 + importance 排序）
   */
  readonly queryByName = (name: string, limit: number): ReadonlyArray<SymbolRecord> => {
    // ---------- 边界处理 ----------
    if (typeof name !== "string" || name.length === 0) {
      return EMPTY_SYMBOL_RECORDS;
    }
    if (typeof limit !== "number" || limit <= 0) {
      return EMPTY_SYMBOL_RECORDS;
    }

    // ---------- 匹配逻辑 ----------
    // 不区分大小写：将查询名转为小写，与符号名小写形式比较
    const lowerName = name.toLowerCase();

    // 第一轮：精确匹配（symbol.name.toLowerCase() === lowerName）
    const exactMatches: SymbolRecord[] = [];
    // 第二轮：包含匹配（symbol.name.toLowerCase().includes(lowerName)）
    const containsMatches: SymbolRecord[] = [];

    for (const sym of this.sortedSymbols) {
      const symNameLower = sym.name.toLowerCase();
      if (symNameLower === lowerName) {
        // 精确匹配
        exactMatches.push(sym);
      } else if (symNameLower.includes(lowerName)) {
        // 包含匹配（非精确）
        containsMatches.push(sym);
      }
    }

    // ---------- 排序逻辑 ----------
    // 精确匹配内：按 importance 降序（高风险优先）
    exactMatches.sort((a, b) => b.importance - a.importance);
    // 包含匹配内：按 importance 降序（高风险优先）
    containsMatches.sort((a, b) => b.importance - a.importance);

    // ---------- 合并 + 截断 ----------
    // 精确匹配在前，包含匹配在后
    const merged = [...exactMatches, ...containsMatches];
    const truncated = merged.slice(0, limit);

    // 冻结返回，防止外部修改
    return Object.freeze(truncated);
  };

  /**
   * 按 kind 过滤符号
   *
   * 匹配规则：
   * 1. 过滤 symbol.kind === kind 的符号
   * 2. 按 importance 降序排序（高风险符号优先）
   * 3. importance 相同时按 symbolId 升序（稳定排序）
   * 4. 截断到 limit 条
   *
   * 边界处理：
   * - limit <= 0：返回空数组
   * - 无匹配：返回空数组
   *
   * @param kind 符号类型（function/class/interface/type/variable/module/namespace）
   * @param limit 返回结果数上限
   * @returns 匹配的符号列表（最多 limit 条，按 importance 降序排序）
   */
  readonly queryByKind = (kind: SymbolKind, limit: number): ReadonlyArray<SymbolRecord> => {
    // ---------- 边界处理 ----------
    if (typeof limit !== "number" || limit <= 0) {
      return EMPTY_SYMBOL_RECORDS;
    }

    // ---------- 过滤 + 排序 ----------
    // 复用 sortedByImportance（已按 importance 降序排序），过滤 kind 后截断
    const filtered = this.sortedByImportance.filter((sym) => sym.kind === kind);

    // ---------- 截断 ----------
    const truncated = filtered.slice(0, limit);

    // 冻结返回
    return Object.freeze(truncated);
  };

  /**
   * 查询节点的边
   *
   * 匹配规则：
   * - direction="incoming"：返回所有 dstSymbolId === symbolId 的边
   * - direction="outgoing"：返回所有 srcSymbolId === symbolId 的边
   * - direction="both"：返回 incoming + outgoing 全部边（去重，按 edgeId 排序）
   *
   * 边界处理：
   * - symbolId 不存在：返回空数组（无该符号的边）
   * - 无匹配边：返回空数组
   *
   * @param symbolId 符号 ID
   * @param direction 边方向（incoming/outgoing/both）
   * @returns 边列表（按 edgeId 排序，便于测试断言稳定）
   */
  readonly getEdges = (symbolId: string, direction: EdgeDirection): ReadonlyArray<EdgeRecord> => {
    // ---------- 边界处理 ----------
    if (typeof symbolId !== "string" || symbolId.length === 0) {
      return EMPTY_EDGE_RECORDS;
    }

    // ---------- 按方向查询 ----------
    if (direction === "incoming") {
      // 入边：dstSymbolId === symbolId
      const edges = this.incomingEdges.get(symbolId);
      return edges ?? EMPTY_EDGE_RECORDS;
    }

    if (direction === "outgoing") {
      // 出边：srcSymbolId === symbolId
      const edges = this.outgoingEdges.get(symbolId);
      return edges ?? EMPTY_EDGE_RECORDS;
    }

    // direction === "both"：合并 incoming + outgoing，按 edgeId 去重 + 排序
    const incoming = this.incomingEdges.get(symbolId) ?? EMPTY_EDGE_RECORDS;
    const outgoing = this.outgoingEdges.get(symbolId) ?? EMPTY_EDGE_RECORDS;

    // 去重（按 edgeId，避免同一边在 incoming + outgoing 中重复出现）
    // 注：incoming 和 outgoing 不应有交集（边方向唯一），但防御性去重
    const seen = new Set<string>();
    const merged: EdgeRecord[] = [];
    for (const edge of [...incoming, ...outgoing]) {
      if (!seen.has(edge.edgeId)) {
        seen.add(edge.edgeId);
        merged.push(edge);
      }
    }

    // 按 edgeId 排序，保证输出稳定
    merged.sort((a, b) => compareEdgeById(a, b));

    // 冻结返回
    return Object.freeze(merged);
  };

  /**
   * 爆炸半径 BFS（DW-2 数据源）
   *
   * 从根符号出发，沿边进行有界 BFS 遍历，返回受影响的符号集合。
   *
   * BFS 算法真实实现（禁 mock），覆盖 outgoing + incoming 双向边
   * （影响面分析需要反向调用者链 ±N 跳）。
   *
   * 算法步骤：
   * 1. 初始化 BFS 队列，根节点入队（depth=0）
   * 2. 初始化 visited 集合，根节点标记为已访问（避免循环）
   * 3. 循环出队，直到队列为空或达到 maxNodes：
   *    a. 取出队首节点，深度为 depth
   *    b. 若 depth >= maxDepth，不再扩展（但有界 BFS 仍会处理当前节点）
   *    c. 获取该节点的双向边（incoming + outgoing）
   *    d. 对每条边，获取邻居节点 symbolId
   *    e. 若邻居未访问，加入结果集，入队（depth+1）
   * 4. 结果按 BFS 距离升序排序（近的在前）
   * 5. 截断到 maxNodes 条
   *
   * 边界处理：
   * - rootSymbolId 不存在：返回空数组
   * - maxDepth <= 0：返回空数组（不扩展）
   * - maxNodes <= 0：返回空数组（不返回任何节点）
   * - 无边：返回空数组（根节点本身不包含在结果中）
   *
   * 防图谱爆炸：
   * - maxDepth 默认 2（调用方传入），最大 3（架构师 §5.2 接口契约约束）
   * - maxNodes 限制返回节点数（典型值 50-200）
   * - visited 集合避免循环遍历（防止环路导致死循环）
   *
   * @param rootSymbolId 根符号 ID（BFS 起点）
   * @param maxDepth BFS 最大深度（默认 2，最大 3，防图谱爆炸）
   * @param maxNodes 返回节点数上限（防结果集过大）
   * @returns 受影响的符号列表（不含根符号本身，按 BFS 距离升序排序）
   */
  readonly getExplosionRadius = (
    rootSymbolId: string,
    maxDepth: number,
    maxNodes: number
  ): ReadonlyArray<SymbolRecord> => {
    // ---------- 边界处理 ----------
    if (typeof rootSymbolId !== "string" || rootSymbolId.length === 0) {
      return EMPTY_SYMBOL_RECORDS;
    }
    if (typeof maxDepth !== "number" || maxDepth <= 0) {
      return EMPTY_SYMBOL_RECORDS;
    }
    if (typeof maxNodes !== "number" || maxNodes <= 0) {
      return EMPTY_SYMBOL_RECORDS;
    }
    // 根节点不存在于图谱中：返回空数组
    if (!this.symbolById.has(rootSymbolId)) {
      return EMPTY_SYMBOL_RECORDS;
    }

    // ---------- BFS 初始化 ----------
    // 队列：待扩展节点（携带深度信息）
    const queue: BfsQueueNode[] = [{ symbolId: rootSymbolId, depth: 0 }];
    // 已访问集合：避免循环遍历（含根节点，根节点不计入结果）
    const visited = new Set<string>([rootSymbolId]);
    // 结果集：受影响的符号节点（携带 BFS 深度，便于按距离排序）
    const results: Array<{ symbol: SymbolRecord; depth: number }> = [];

    // ---------- BFS 主循环 ----------
    while (queue.length > 0) {
      // 出队队首节点
      const current = queue.shift()!;
      const currentDepth = current.depth;

      // 当前节点深度已达 maxDepth，不再扩展其邻居
      // （但有界 BFS 已处理当前节点，仅停止向更深层扩展）
      if (currentDepth >= maxDepth) {
        continue;
      }

      // 获取当前节点的双向边（incoming + outgoing）
      const incoming = this.incomingEdges.get(current.symbolId) ?? [];
      const outgoing = this.outgoingEdges.get(current.symbolId) ?? [];

      // 合并邻居节点（去重 by symbolId）
      // - outgoing 边的邻居是 dstSymbolId（当前节点 → 邻居）
      // - incoming 边的邻居是 srcSymbolId（邻居 → 当前节点）
      const neighborIds = new Set<string>();
      for (const edge of outgoing) {
        neighborIds.add(edge.dstSymbolId);
      }
      for (const edge of incoming) {
        neighborIds.add(edge.srcSymbolId);
      }

      // 遍历邻居，未访问的加入结果集并入队
      for (const neighborId of neighborIds) {
        // 已访问：跳过（避免循环）
        if (visited.has(neighborId)) {
          continue;
        }
        // 邻居不存在于图谱中：跳过（边指向了不存在的符号，防御性处理）
        const neighborSymbol = this.symbolById.get(neighborId);
        if (neighborSymbol === undefined) {
          continue;
        }

        // 标记为已访问
        visited.add(neighborId);
        // 加入结果集（depth = currentDepth + 1）
        results.push({ symbol: neighborSymbol, depth: currentDepth + 1 });
        // 入队，等待后续扩展
        queue.push({ symbolId: neighborId, depth: currentDepth + 1 });

        // 注：不在此处提前截断到 maxNodes，因为 BFS 完成后需要按 (depth, importance)
        // 排序再截断，确保返回的是最重要的节点而非最先发现的节点。
        // 防图谱爆炸由 maxDepth（最大 3）+ visited 集合（无重复访问）+ 图谱规模有限共同保证。
      }
    }

    // ---------- 结果排序 + 截断 ----------
    // 按 BFS 深度升序排序（近的在前），同深度内按 importance 降序（高风险优先）
    results.sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return b.symbol.importance - a.symbol.importance;
    });

    // 截断到 maxNodes 条（防止 BFS 期间 results 略超 maxNodes）
    const truncated = results.slice(0, maxNodes).map((r) => r.symbol);

    // 冻结返回
    return Object.freeze(truncated);
  };

  /**
   * 风险热点 Top-N（DW-3 数据源）
   *
   * 按 importance 字段降序排序，返回前 topN 个高风险符号。
   * 用于 TESTING Loop 风险驱动用例优先级。
   *
   * 匹配规则：
   * 1. 复用 sortedByImportance（已按 importance 降序排序）
   * 2. 截断到 topN 条
   *
   * 边界处理：
   * - topN <= 0：返回空数组
   * - 图谱为空：返回空数组
   *
   * @param topN 返回结果数上限
   * @returns 风险热点符号列表（按 importance 降序，最多 topN 条）
   */
  readonly getRiskHotspots = (topN: number): ReadonlyArray<SymbolRecord> => {
    // ---------- 边界处理 ----------
    if (typeof topN !== "number" || topN <= 0) {
      return EMPTY_SYMBOL_RECORDS;
    }

    // ---------- 截断 ----------
    // 直接复用 sortedByImportance（已按 importance 降序排序）
    const truncated = this.sortedByImportance.slice(0, topN);

    // 冻结返回
    return Object.freeze(truncated);
  };

  /**
   * 自然语言查询符号（codemap_search 工具数据源）
   *
   * 简单关键词匹配（无 FTS5 + 向量 RRF 混合检索）：
   * 1. 将 query 分词（按空格 / 标点切分，转小写）
   * 2. 对每个符号的 name + summary + signature + filePath 进行关键词匹配
   * 3. 命中关键词数多的符号排名靠前
   * 4. 同命中数内按 importance 降序排序（高风险优先）
   * 5. 截断到 limit 条
   *
   * 分词规则：
   * - 按空格、制表符、换行符切分
   * - 按标点符号切分（句号、逗号、分号、冒号、问号、感叹号、括号、方括号、花括号、尖括号、等号、加减乘除等）
   * - 转小写（不区分大小写匹配）
   * - 过滤空 token（连续分隔符产生的空字符串）
   * - 过滤过短 token（length < 2，如单字符"a"无意义）
   *
   * 边界处理：
   * - query 为空字符串：返回空数组
   * - limit <= 0：返回空数组
   * - 无匹配：返回空数组
   *
   * @param query 自然语言查询字符串
   * @param limit 返回结果数上限
   * @returns 匹配的符号列表（最多 limit 条，按命中关键词数 + importance 排序）
   */
  readonly searchByQuery = (query: string, limit: number): ReadonlyArray<SymbolRecord> => {
    // ---------- 边界处理 ----------
    if (typeof query !== "string" || query.length === 0) {
      return EMPTY_SYMBOL_RECORDS;
    }
    if (typeof limit !== "number" || limit <= 0) {
      return EMPTY_SYMBOL_RECORDS;
    }

    // ---------- 1. 分词 ----------
    // 按空格 / 标点切分，转小写，过滤空 token 和过短 token
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) {
      return EMPTY_SYMBOL_RECORDS;
    }

    // ---------- 2. 关键词匹配 + 命中数统计 ----------
    // 对每个符号，统计 tokens 中有多少个出现在 name + summary + signature + filePath 中
    const results: Array<{ symbol: SymbolRecord; hitCount: number }> = [];
    for (const sym of this.sortedSymbols) {
      // 拼接可搜索文本（name + summary + signature + filePath），转小写
      const searchableText = `${sym.name} ${sym.summary} ${sym.signature} ${sym.filePath}`.toLowerCase();

      // 统计命中关键词数
      let hitCount = 0;
      for (const token of tokens) {
        if (searchableText.includes(token)) {
          hitCount++;
        }
      }

      // 至少命中一个关键词才加入结果集
      if (hitCount > 0) {
        results.push({ symbol: sym, hitCount });
      }
    }

    // ---------- 3. 排序 ----------
    // 按 hitCount 降序（命中多的在前），同 hitCount 内按 importance 降序（高风险优先）
    // 同 importance 内按 symbolId 升序（稳定排序）
    results.sort((a, b) => {
      if (a.hitCount !== b.hitCount) {
        return b.hitCount - a.hitCount;
      }
      const importanceDiff = b.symbol.importance - a.symbol.importance;
      if (Math.abs(importanceDiff) > 1e-9) {
        return importanceDiff;
      }
      return a.symbol.symbolId.localeCompare(b.symbol.symbolId);
    });

    // ---------- 4. 截断 ----------
    const truncated = results.slice(0, limit).map((r) => r.symbol);

    // 冻结返回
    return Object.freeze(truncated);
  };
}

// ============================================================================
// 3. 内部辅助函数
// ============================================================================

/**
 * 边 ID 比较函数（按 edgeId 字符串升序排序）
 *
 * 用于 getEdges / outgoingEdges / incomingEdges 的边列表排序，
 * 保证输出顺序稳定（便于测试断言）。
 *
 * @param a 边 A
 * @param b 边 B
 * @returns 负数（A 在前）/ 0（相等）/ 正数（B 在前）
 */
function compareEdgeById(a: EdgeRecord, b: EdgeRecord): number {
  return a.edgeId.localeCompare(b.edgeId);
}

/**
 * 查询字符串分词函数
 *
 * 将自然语言查询字符串分词为关键词列表：
 * 1. 按空格 / 制表符 / 换行符切分
 * 2. 按标点符号切分（句号、逗号、分号、冒号、问号、感叹号、括号、方括号、花括号、尖括号、等号、加减乘除等）
 * 3. 转小写（不区分大小写匹配）
 * 4. 过滤空 token（连续分隔符产生的空字符串）
 * 5. 过滤过短 token（length < 2，如单字符"a"无意义）
 *
 * 实现说明：
 * - 使用正则表达式切分（覆盖空格、标点符号、括号、运算符等）
 * - 转小写后过滤 length < 2 的 token
 * - 返回去重后的 token 列表（避免同一关键词重复计数）
 *
 * @param query 自然语言查询字符串
 * @returns 分词后的关键词列表（小写、去重、过滤过短 token）
 */
function tokenizeQuery(query: string): string[] {
  // 分词正则：匹配空格 / 制表符 / 换行符 / 常见标点符号
  // 标点符号覆盖：.,;:!?(){}<>=+-*/|"'[]\\
  // 注：字符类中 [ 无需转义；] 必须转义防闭合字符类；- 放 +-*/ 中间需转义为 \-
  const separatorPattern = /[\s.,;:!?(){}<>=+\-*/|"'[\]\\]+/;

  // 切分 + 转小写 + 过滤空 token + 过滤过短 token
  const rawTokens = query
    .split(separatorPattern)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

  // 去重（避免同一关键词重复计数，如 "user user" 只计一次）
  const uniqueTokens = Array.from(new Set(rawTokens));

  return uniqueTokens;
}
