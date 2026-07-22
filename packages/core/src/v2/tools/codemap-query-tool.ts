/**
 * EAG-P6 Phase 4 codemap_query 工具实现（DW-4 即时查符号查询）
 *
 * 本模块提供 codemap_query agent 工具，支持按关键词 / kind / namespace / limit
 * 查询符号图谱，返回符号详情列表。工具走 tool-executor 独立路径，结果直接拼入
 * 当轮 LLM messages，不进 SlidingWindowManager 批量池（D-2 决策）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-6（codemap 工具集）+ DW-4 即时查策略
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §8.2.4 Phase 4 验收标准（4 工具全部注册到 tool-executor）
 * - EAG-P6-TASKS.md §3 TASK-P6-4-01（codemap_query 工具实现规格）
 *
 * 用户关键约束（任务规格强制）：
 * - "禁止使用模拟，占位，mock，简化的方式开发代码"
 * - "StaticSymbolGraph 必须是真实降级实现（基于 Map + BFS，不是 mock）"
 * - 不可变优先：readonly + ReadonlyArray + Object.freeze
 * - 中文详细注释，符合 Rust/Java 代码规范
 * - TODO/FIXME 必须有对应实现，禁止空 TODO
 *
 * 接口契约（任务规格强制）：
 * - 输入：CodemapQueryInput { query: string; kind?: SymbolKind; namespace?: string; limit?: number }
 * - 输出：CodemapQueryResult { symbols: SymbolRecord[]; total: number; queryTime: number }
 * - 方法：execute(input: CodemapQueryInput) => CodemapQueryResult
 *
 * 实现要点：
 * - 优先使用 SymbolGraphAdapter（若 isAvailable()=true）
 * - 降级到 DefaultSymbolGraphAdapter（返回空数组）
 * - 支持 query 关键词匹配（name 包含 / namespace 包含）
 * - 支持 kind 过滤
 * - 支持 namespace 过滤（通过 filePath 前缀匹配实现）
 * - 支持 limit 限制（默认 50，最大 200）
 *
 * 降级保证（NFR-4 零回归）：
 * - isGraphStoreAvailable() 返回 false 时返回空数组（不抛错，不打印 warning）
 * - adapter.isAvailable() 返回 false 时返回空数组
 * - 行为与 V2-P3 完全一致（零回归）
 *
 * 不可变优先原则：
 * - 类内部状态全部 readonly
 * - 对外返回的 CodemapQueryResult 通过 Object.freeze 冻结
 * - 接口方法全部 readonly（接口属性形式）
 *
 * @module v2/tools/codemap-query-tool
 */

import type { SymbolGraphAdapter } from "../context/symbol-graph-adapter";
import { isGraphStoreAvailable } from "../context/symbol-graph-adapter";
import type { SymbolKind, SymbolRecord } from "../context/symbol-graph-types";

// ============================================================================
// 1. 工具元数据常量
// ============================================================================

/**
 * 工具名称常量（与 ask-user-question 同级，注册到 tool-executor）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const CODEMAP_QUERY_TOOL_NAME: string = Object.freeze("codemap_query") as string;

/**
 * 工具描述（用于 tool-executor 工具列表展示）
 *
 * 使用 Object.freeze 冻结。
 */
export const CODEMAP_QUERY_TOOL_DESCRIPTION: string = Object.freeze(
  "查询符号图谱，返回符号详情列表。支持按关键词（name/summary/signature/filePath）匹配、" +
    "kind 过滤、namespace（filePath 前缀）过滤、limit 限制。"
) as string;

/**
 * 默认返回结果数上限（平衡 Token 预算与覆盖度）
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_CODEMAP_QUERY_LIMIT: number = Object.freeze(50) as number;

/**
 * 最大返回结果数上限（防止结果集过大导致 Token 爆炸）
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_CODEMAP_QUERY_LIMIT: number = Object.freeze(200) as number;

/**
 * 空 CodemapQueryResult 常量（冻结，供降级路径复用）
 *
 * 降级模式下返回此常量，避免每次调用创建新对象（性能优化 + 不可变优先）。
 */
export const EMPTY_CODEMAP_QUERY_RESULT: Readonly<CodemapQueryResult> = Object.freeze({
  symbols: Object.freeze([]),
  total: 0,
  queryTime: 0,
}) as Readonly<CodemapQueryResult>;

// ============================================================================
// 2. 输入/输出接口定义
// ============================================================================

/**
 * codemap_query 工具输入参数
 *
 * 字段说明：
 * - query：查询关键词（必填，匹配 name / summary / signature / filePath）
 * - kind：符号类型过滤（可选，function/class/interface/type/variable/module/namespace）
 * - namespace：命名空间过滤（可选，按 filePath 前缀匹配，如 "src/services/"）
 * - limit：返回结果数上限（可选，默认 50，最大 200）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface CodemapQueryInput {
  /** 查询关键词（必填，匹配 name / summary / signature / filePath，不区分大小写） */
  readonly query: string;
  /** 符号类型过滤（可选，function/class/interface/type/variable/module/namespace） */
  readonly kind?: SymbolKind;
  /** 命名空间过滤（可选，按 filePath 前缀匹配，如 "src/services/" 匹配 src/services/* 下全部符号） */
  readonly namespace?: string;
  /** 返回结果数上限（可选，默认 50，最大 200，超过则截断） */
  readonly limit?: number;
}

/**
 * codemap_query 工具输出结果
 *
 * 字段说明：
 * - symbols：匹配的符号列表（按匹配度排序，已截断到 limit）
 * - total：匹配的符号总数（截断前的总数，用于判断是否有更多结果）
 * - queryTime：查询耗时（毫秒，用于性能监控）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 */
export interface CodemapQueryResult {
  /** 匹配的符号列表（按匹配度排序，已截断到 limit，已冻结） */
  readonly symbols: ReadonlyArray<SymbolRecord>;
  /** 匹配的符号总数（截断前的总数，用于判断是否有更多结果） */
  readonly total: number;
  /** 查询耗时（毫秒，用于性能监控） */
  readonly queryTime: number;
}

// ============================================================================
// 3. CodemapQueryTool 类实现
// ============================================================================

/**
 * codemap_query 工具实现类
 *
 * 通过 SymbolGraphAdapter 接口查询图谱，不直接依赖 V2-P4 graph-store 实现。
 * V2-P4 未实施时，DefaultSymbolGraphAdapter 返回空数组，本工具返回空结果（降级）。
 * V2-P4 实施后，可替换为 GraphStoreSymbolGraphAdapter，本工具零修改（依赖倒置）。
 *
 * 查询策略（与 StaticSymbolGraph 各 query 方法协同）：
 * 1. 仅 query 提供（kind/namespace 缺省）：
 *    - 调用 adapter.searchByQuery(query, limit) 进行关键词检索
 *    - 命中关键词数多的符号排名靠前
 * 2. 仅 kind 提供（query 缺省）：
 *    - 调用 adapter.queryByKind(kind, limit) 进行 kind 过滤
 *    - 按 importance 降序排序
 * 3. query 与 kind 同时提供：
 *    - 先调用 adapter.searchByQuery(query, maxLimit) 获取关键词匹配结果
 *    - 再在结果上过滤 kind
 * 4. namespace 过滤（与上述任一组合叠加）：
 *    - 在上述结果基础上，按 filePath 前缀匹配过滤
 *
 * 性能考量：
 * - 单次查询调用 adapter 1 次（searchByQuery 或 queryByKind）
 * - namespace 过滤在内存中完成（O(N) 字符串前缀匹配）
 * - 总体复杂度：O(N + M log M)，N=图谱符号数，M=匹配数
 *
 * 使用示例：
 * ```typescript
 * const adapter = new StaticSymbolGraph(graphData);
 * const tool = new CodemapQueryTool(adapter);
 *
 * // 按关键词查询
 * const result1 = tool.execute({ query: "UserService" });
 * console.log(result1.symbols.length); // 匹配 UserService 的符号数
 *
 * // 按 kind 过滤
 * const result2 = tool.execute({ query: "", kind: "class" });
 * console.log(result2.symbols.length); // 全部 class 符号数
 *
 * // 按 namespace 过滤
 * const result3 = tool.execute({ query: "login", namespace: "src/services/" });
 * console.log(result3.symbols.length); // src/services/ 下匹配 login 的符号数
 * ```
 */
export class CodemapQueryTool {
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
   * 构造 codemap_query 工具
   *
   * @param symbolGraphAdapter V2-P4 符号图谱适配层（不可用时返回空结果）
   * @param graphAvailability 图谱可用性探测函数（默认 isGraphStoreAvailable）
   */
  constructor(symbolGraphAdapter: SymbolGraphAdapter, graphAvailability: () => boolean = isGraphStoreAvailable) {
    // 冻结 adapter 引用（adapter 自身应为不可变，由实现类保证）
    this.symbolGraphAdapter = symbolGraphAdapter;
    this.graphAvailability = graphAvailability;
  }

  /**
   * 执行 codemap_query 工具查询
   *
   * 执行流程：
   * 1. 降级判断：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即返回空结果
   * 2. 参数规范化：limit 缺省时使用默认值 50，超过 200 截断到 200
   * 3. 边界处理：query 与 kind 均缺省时返回空结果（无查询条件）
   * 4. 查询分发：
   *    - 仅 query：调用 searchByQuery
   *    - 仅 kind：调用 queryByKind
   *    - query + kind：先 searchByQuery 再过滤 kind
   * 5. namespace 过滤（可选）：按 filePath 前缀匹配过滤
   * 6. 截断到 limit，统计 total（截断前总数）
   * 7. 计算查询耗时（毫秒）
   * 8. 冻结返回 CodemapQueryResult
   *
   * 降级语义：
   * - graphAvailability() 返回 false：返回 EMPTY_CODEMAP_QUERY_RESULT（零回归）
   * - adapter.isAvailable() 返回 false：返回 EMPTY_CODEMAP_QUERY_RESULT（零回归）
   * - query 与 kind 均缺省：返回 EMPTY_CODEMAP_QUERY_RESULT（无查询条件）
   * - query 为空字符串且 kind 缺省：返回 EMPTY_CODEMAP_QUERY_RESULT
   *
   * 边界处理：
   * - limit 缺省（undefined / NaN / <= 0）：使用默认值 50
   * - limit 超过 MAX_CODEMAP_QUERY_LIMIT=200：截断到 200
   * - namespace 为空字符串：忽略 namespace 过滤
   * - query 为空字符串但 kind 提供：按 kind 过滤
   *
   * @param input 查询输入参数（query / kind / namespace / limit）
   * @returns 查询结果（symbols / total / queryTime，已冻结）
   */
  readonly execute = (input: CodemapQueryInput): CodemapQueryResult => {
    // ---------- 0. 记录开始时间（用于计算 queryTime） ----------
    const startTime = Date.now();

    // ---------- 1. 降级判断 ----------
    // 双层降级：graphAvailability() 或 adapter.isAvailable() 任一返回 false 即降级
    if (!this.isAvailable()) {
      return EMPTY_CODEMAP_QUERY_RESULT;
    }

    // ---------- 2. 边界处理：input 为 null/undefined ----------
    // 防御性处理，调用方应保证 input 非空
    if (input === null || input === undefined) {
      return EMPTY_CODEMAP_QUERY_RESULT;
    }

    // ---------- 3. 参数规范化 ----------
    // query：可选，为空字符串视为未提供
    const query: string = typeof input.query === "string" ? input.query.trim() : "";
    // kind：可选，未提供时为 undefined
    const kind: SymbolKind | undefined = input.kind;
    // namespace：可选，为空字符串视为未提供
    const namespace: string = typeof input.namespace === "string" ? input.namespace.trim() : "";
    // limit：缺省时使用默认值 50，超过 200 截断到 200
    const limit: number = this.normalizeLimit(input.limit);

    // ---------- 4. 边界处理：query 与 kind 均缺省 ----------
    // 无查询条件时返回空结果（避免全表扫描）
    if (query.length === 0 && kind === undefined) {
      return EMPTY_CODEMAP_QUERY_RESULT;
    }

    // ---------- 5. 查询分发 ----------
    // 根据参数组合选择不同的查询策略
    let matchedSymbols: ReadonlyArray<SymbolRecord>;

    if (query.length > 0 && kind !== undefined) {
      // 5.1 query + kind 同时提供：先 searchByQuery 再过滤 kind
      // 取 MAX_CODEMAP_QUERY_LIMIT 作为内部 limit，避免在 kind 过滤前被截断
      const searchResults = this.symbolGraphAdapter.searchByQuery(query, MAX_CODEMAP_QUERY_LIMIT);
      // 在结果上过滤 kind
      matchedSymbols = searchResults.filter((sym) => sym.kind === kind);
    } else if (query.length > 0) {
      // 5.2 仅 query 提供：调用 searchByQuery
      // 取 MAX_CODEMAP_QUERY_LIMIT 作为内部 limit，避免在 namespace 过滤前被截断
      matchedSymbols = this.symbolGraphAdapter.searchByQuery(query, MAX_CODEMAP_QUERY_LIMIT);
    } else {
      // 5.3 仅 kind 提供（query 为空字符串）：调用 queryByKind
      // kind 已确保非 undefined（上方边界处理保证）
      // 取 MAX_CODEMAP_QUERY_LIMIT 作为内部 limit，避免在 namespace 过滤前被截断
      matchedSymbols = this.symbolGraphAdapter.queryByKind(kind as SymbolKind, MAX_CODEMAP_QUERY_LIMIT);
    }

    // ---------- 6. namespace 过滤（可选） ----------
    // namespace 非空时，按 filePath 前缀匹配过滤
    // 例：namespace="src/services/" 匹配 filePath="src/services/UserService.ts"
    let filteredSymbols: ReadonlyArray<SymbolRecord> = matchedSymbols;
    if (namespace.length > 0) {
      filteredSymbols = matchedSymbols.filter((sym) => this.matchesNamespace(sym.filePath, namespace));
    }

    // ---------- 7. 截断到 limit，统计 total ----------
    // total 是截断前的总数（用于判断是否有更多结果）
    const total: number = filteredSymbols.length;
    const truncatedSymbols: ReadonlyArray<SymbolRecord> = filteredSymbols.slice(0, limit);

    // ---------- 8. 计算查询耗时（毫秒） ----------
    const queryTime: number = Date.now() - startTime;

    // ---------- 9. 冻结返回 CodemapQueryResult ----------
    // 注：truncatedSymbols 的元素已是冻结的 SymbolRecord（由 StaticSymbolGraph 保证）
    // 此处仅需冻结外层数组与 result 对象
    const result: CodemapQueryResult = Object.freeze({
      symbols: Object.freeze([...truncatedSymbols]),
      total,
      queryTime,
    }) as CodemapQueryResult;

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
   * 规范化 limit 参数
   *
   * 规则：
   * - limit 缺省（undefined / NaN / <=0）：使用默认值 DEFAULT_CODEMAP_QUERY_LIMIT=50
   * - limit 超过 MAX_CODEMAP_QUERY_LIMIT=200：截断到 200
   * - limit 在 (0, 200] 区间：直接使用
   *
   * @param limit 原始 limit 值（可选）
   * @returns 规范化后的 limit 值（1 ~ 200）
   */
  private normalizeLimit = (limit?: number): number => {
    // limit 缺省或非数字：使用默认值 50
    if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
      return DEFAULT_CODEMAP_QUERY_LIMIT;
    }
    // limit 超过最大值：截断到 200
    if (limit > MAX_CODEMAP_QUERY_LIMIT) {
      return MAX_CODEMAP_QUERY_LIMIT;
    }
    // limit 在 (0, 200] 区间：直接使用
    return Math.floor(limit);
  };

  /**
   * 判断 filePath 是否匹配 namespace 前缀
   *
   * 匹配规则：
   * - namespace 作为 filePath 的前缀匹配（区分大小写）
   * - 例：namespace="src/services/" 匹配 filePath="src/services/UserService.ts"
   * - 例：namespace="src" 匹配 filePath="src/A.ts" 与 filePath="src/services/B.ts"
   *
   * 设计考量：
   * - 区分大小写：与 POSIX 路径规范一致（Linux 文件系统区分大小写）
   * - 前缀匹配：与 namespace 语义一致（namespace 是路径前缀，非子串）
   * - 不支持通配符：保持简单，避免引入 glob 解析复杂度
   *
   * @param filePath 符号文件路径（如 "src/services/UserService.ts"）
   * @param namespace 命名空间前缀（如 "src/services/"）
   * @returns true=匹配 / false=不匹配
   */
  private matchesNamespace = (filePath: string, namespace: string): boolean => {
    // 边界处理：filePath 或 namespace 为空字符串时返回 false
    if (typeof filePath !== "string" || filePath.length === 0) {
      return false;
    }
    if (typeof namespace !== "string" || namespace.length === 0) {
      return false;
    }
    // 前缀匹配（区分大小写）
    return filePath.startsWith(namespace);
  };
}
