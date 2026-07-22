/**
 * EAG-P6 Phase 1 DefaultSymbolGraphAdapter 静默降级实现
 *
 * 本模块提供 SymbolGraphAdapter 接口的"降级实现"——DefaultSymbolGraphAdapter。
 * 当 V2-P4 图谱模块未实施（isGraphStoreAvailable() 返回 false）时，调用方使用
 * 本实现作为兜底，所有查询方法返回空数组，行为与 V2-P3 完全一致（零回归）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-7（CodeMap 降级探测）+ §4 NFR-4（降级零回归）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §11.3.1 V2-P4 未实施的处理策略
 *   + §2.1.5 R-P6-1 最终结论（V2-P4 未实施 → 降级路径覆盖）
 * - EAG-P6-TASKS.md §3 TASK-P6-1-01 部分 3（DefaultSymbolGraphAdapter 类实现）
 *
 * 降级语义：
 * - isAvailable() 始终返回 false（降级模式标志）
 * - 所有查询方法返回空数组（EMPTY_SYMBOL_RECORDS / EMPTY_EDGE_RECORDS）
 * - 不抛错、不打印 warning（静默降级，避免日志噪音）
 * - 行为与 V2-P3 完全一致（文件级评分 + PCL 三层，零回归）
 *
 * 调用方使用方式：
 * ```typescript
 * const adapter: SymbolGraphAdapter = isGraphStoreAvailable()
 *   ? new GraphStoreSymbolGraphAdapter(...)  // V2-P4 实施后的真实图谱实现
 *   : new DefaultSymbolGraphAdapter();       // 当前 P6 Phase 1 的降级实现
 *
 * if (adapter.isAvailable()) {
 *   const hotspots = adapter.getRiskHotspots(10);
 *   // 使用图谱数据驱动 TESTING Loop 优先级
 * } else {
 *   // 降级路径：跳过图谱增强，沿用 V2-P3 行为
 * }
 * ```
 *
 * 性能考量：
 * - 所有方法返回共享的冻结空数组常量（EMPTY_SYMBOL_RECORDS / EMPTY_EDGE_RECORDS），
 *   避免每次调用创建新数组对象（高频调用场景下性能优化）
 * - 不维护任何内部状态，无内存占用
 *
 * 不可变优先原则：
 * - 类无内部可变状态
 * - 接口方法全部 readonly（接口属性形式）
 * - 返回值全部 ReadonlyArray（且为冻结的空数组常量）
 *
 * @module v2/context/default-symbol-graph-adapter
 */

import type { EdgeDirection, EdgeRecord, SymbolKind, SymbolRecord } from "./symbol-graph-types";
import { EMPTY_EDGE_RECORDS, EMPTY_SYMBOL_RECORDS, type SymbolGraphAdapter } from "./symbol-graph-adapter";

// ============================================================================
// DefaultSymbolGraphAdapter 类
// ============================================================================

/**
 * 默认降级实现（SymbolGraphAdapter 接口的"无图谱"实现）
 *
 * 何时使用：
 * - V2-P4 图谱模块未实施（P6 Phase 1 当前状态）
 * - V2-P4 图谱模块加载失败（better-sqlite3 编译失败 / 数据库文件损坏）
 * - 测试场景模拟降级模式（TC-ADAPTER-003/004/005 验证）
 *
 * 设计原则：
 * - 静默降级：不抛错、不打印 warning，调用方无感知
 * - 零回归：行为与 V2-P3 完全一致（返回空数据，调用方自然跳过图谱增强）
 * - 高性能：共享冻结空数组常量，无内存分配
 * - 不可变：无内部状态，线程安全
 *
 * 接口实现说明：
 * - isAvailable() 始终返回 false（标识降级模式）
 * - queryByName() 返回 EMPTY_SYMBOL_RECORDS
 * - queryByKind() 返回 EMPTY_SYMBOL_RECORDS
 * - getEdges() 返回 EMPTY_EDGE_RECORDS
 * - getExplosionRadius() 返回 EMPTY_SYMBOL_RECORDS
 * - getRiskHotspots() 返回 EMPTY_SYMBOL_RECORDS
 * - searchByQuery() 返回 EMPTY_SYMBOL_RECORDS
 *
 * 使用示例：
 * ```typescript
 * const adapter = new DefaultSymbolGraphAdapter();
 * console.log(adapter.isAvailable()); // false
 * console.log(adapter.queryByName("User", 10).length); // 0
 * console.log(adapter.getExplosionRadius("root", 2, 50).length); // 0
 * ```
 */
export class DefaultSymbolGraphAdapter implements SymbolGraphAdapter {
  /**
   * 构造函数
   *
   * 无需任何参数，无副作用，可安全多次实例化。
   * 不抛错，不打印 warning（静默降级）。
   */
  constructor() {
    // 无内部状态需要初始化
    // 显式空构造函数体，符合 Java/Rust 代码规范（构造函数需显式声明）
  }

  /**
   * 探测图谱是否可用
   *
   * DefaultSymbolGraphAdapter 始终返回 false，标识降级模式。
   * 调用方依据此返回值决定是否走图谱增强路径。
   *
   * @returns 始终返回 false（降级模式）
   */
  readonly isAvailable = (): boolean => false;

  /**
   * 按符号名查询符号
   *
   * 降级模式：返回空数组（无图谱数据）。
   *
   * @param _name 符号名（降级模式下未使用，下划线前缀避免 lint 警告）
   * @param _limit 返回结果数上限（降级模式下未使用）
   * @returns 始终返回 EMPTY_SYMBOL_RECORDS（冻结的空数组）
   */
  readonly queryByName = (_name: string, _limit: number): ReadonlyArray<SymbolRecord> => EMPTY_SYMBOL_RECORDS;

  /**
   * 按 kind 过滤符号
   *
   * 降级模式：返回空数组（无图谱数据）。
   *
   * @param _kind 符号类型（降级模式下未使用）
   * @param _limit 返回结果数上限（降级模式下未使用）
   * @returns 始终返回 EMPTY_SYMBOL_RECORDS（冻结的空数组）
   */
  readonly queryByKind = (_kind: SymbolKind, _limit: number): ReadonlyArray<SymbolRecord> => EMPTY_SYMBOL_RECORDS;

  /**
   * 查询节点的边
   *
   * 降级模式：返回空数组（无图谱数据）。
   *
   * @param _symbolId 符号 ID（降级模式下未使用）
   * @param _direction 边方向（降级模式下未使用）
   * @returns 始终返回 EMPTY_EDGE_RECORDS（冻结的空数组）
   */
  readonly getEdges = (_symbolId: string, _direction: EdgeDirection): ReadonlyArray<EdgeRecord> => EMPTY_EDGE_RECORDS;

  /**
   * 爆炸半径 BFS（DW-2 数据源）
   *
   * 降级模式：返回空数组（无图谱数据）。
   * 调用方收到空数组后，跳过爆炸半径分析，沿用 V2-P3 行为。
   *
   * @param _rootSymbolId 根符号 ID（降级模式下未使用）
   * @param _maxDepth BFS 最大深度（降级模式下未使用）
   * @param _maxNodes 返回节点数上限（降级模式下未使用）
   * @returns 始终返回 EMPTY_SYMBOL_RECORDS（冻结的空数组）
   */
  readonly getExplosionRadius = (
    _rootSymbolId: string,
    _maxDepth: number,
    _maxNodes: number
  ): ReadonlyArray<SymbolRecord> => EMPTY_SYMBOL_RECORDS;

  /**
   * 风险热点 Top-N（DW-3 数据源）
   *
   * 降级模式：返回空数组（无图谱数据）。
   * 调用方收到空数组后，跳过风险驱动用例优先级，沿用 V2-P3 行为。
   *
   * @param _topN 返回结果数上限（降级模式下未使用）
   * @returns 始终返回 EMPTY_SYMBOL_RECORDS（冻结的空数组）
   */
  readonly getRiskHotspots = (_topN: number): ReadonlyArray<SymbolRecord> => EMPTY_SYMBOL_RECORDS;

  /**
   * 自然语言查询符号（codemap_search 工具数据源）
   *
   * 降级模式：返回空数组（无图谱数据）。
   * 调用方收到空数组后，codemap_search 工具返回空结果，调用方提示用户
   * "图谱未启用"，不抛错（符合 NFR-4 降级零回归）。
   *
   * @param _query 自然语言查询字符串（降级模式下未使用）
   * @param _limit 返回结果数上限（降级模式下未使用）
   * @returns 始终返回 EMPTY_SYMBOL_RECORDS（冻结的空数组）
   */
  readonly searchByQuery = (_query: string, _limit: number): ReadonlyArray<SymbolRecord> => EMPTY_SYMBOL_RECORDS;
}
