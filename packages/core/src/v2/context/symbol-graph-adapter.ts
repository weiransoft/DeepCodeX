/**
 * EAG-P6 Phase 1 SymbolGraphAdapter 接口 + isGraphStoreAvailable 降级探测函数
 *
 * 本模块定义 V2-P4 符号图谱的"适配层接口"与"可用性探测函数"：
 * - SymbolGraphAdapter 接口：统一封装图谱查询能力，供 CodeMapSnippetProvider
 *   与 4 个 codemap_* 工具调用。P6 Phase 1 仅提供接口与降级实现，
 *   V2-P4 图谱模块实施后由真实 GraphStoreSymbolGraphAdapter 实现替换。
 * - isGraphStoreAvailable() 函数：探测 V2-P4 图谱存储是否可用，
 *   不可用时返回 false，触发 P6 全部功能降级到 V2-P3 行为（零回归）。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-7（CodeMap 降级探测）+ §4 NFR-4（降级零回归）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
 *   + §2.1.5 R-P6-1 最终结论（V2-P4 未实施 → 降级路径覆盖）
 *   + §11.3.1 V2-P4 未实施的处理策略
 * - EAG-P6-TASKS.md §3 TASK-P6-1-01（用户任务规格）
 *
 * 与 P5 SymbolGraphStore 的关系：
 * - 本接口与 P5 SymbolGraphStore **解耦**（用户任务规格强制要求）：
 *   - P6 Phase 1 不依赖 P5 的任何具体实现
 *   - P5 实施后可提供 GraphStoreSymbolGraphAdapter 包装 P5 SymbolGraphStore，
 *     实现本接口；P6 调用方零修改（依赖倒置）
 * - P6 SymbolGraphAdapter 接口签名（queryByName / queryByKind / getEdges /
 *   getExplosionRadius / getRiskHotspots / searchByQuery）独立于 P5 接口签名，
 *   便于 P6 在 P5 未实施时独立演进。
 *
 * 降级保证（与设计文档 §5.11.7 一致）：
 * - V2-P4 图谱模块未实施时，isGraphStoreAvailable() 返回 false
 * - DefaultSymbolGraphAdapter 在 isGraphStoreAvailable() 返回 false 时
 *   所有方法返回空数组（静默降级，不抛错，不打印 warning）
 * - 行为与 V2-P3 完全一致（文件级评分 + PCL 三层），零回归
 *
 * 探测逻辑（isGraphStoreAvailable）：
 * 1. 环境变量短路：DCX_TEST_DISABLE_BETTER_SQLITE3=1 时直接返回 false
 *    （测试场景真实模拟降级模式，TC-ADAPTER-001 验证）
 * 2. better-sqlite3 原生模块加载是否成功（动态 import + catch 加载异常）
 * 3. SymbolGraphStore 类是否可实例化（P5 未实施时此步抛错）
 * 4. 任一步骤失败即返回 false（降级模式）
 *
 * 性能考量：
 * - 探测结果通过模块级缓存（availabilityCache）记忆，避免每次调用都触发
 *   动态 import 与类实例化（高频调用场景下性能优化）
 * - 缓存可由测试通过 resetGraphStoreAvailabilityCache() 重置，便于测试断言
 *
 * 不可变优先原则：
 * - 接口方法全部 readonly（接口属性形式，不可重新赋值）
 * - 返回值全部 ReadonlyArray
 *
 * @module v2/context/symbol-graph-adapter
 */

import { createRequire } from "node:module";
import type { EdgeDirection, EdgeRecord, SymbolKind, SymbolRecord } from "./symbol-graph-types";

// ============================================================================
// 0. ESM 兼容的同步 require 函数
// ============================================================================
//
// 项目使用 "type": "module"（ESM 模块规范），无法直接调用 require()。
// 但 isGraphStoreAvailable() 必须是同步函数（调用方期望同步返回 boolean），
// 故通过 node:module.createRequire 创建一个 CommonJS require 函数，
// 用于同步探测 better-sqlite3 与 SymbolGraphStore 模块是否可用。
//
// 探测时机：模块加载时一次性创建 require 函数，避免每次探测都重新创建。
// 失败处理：若 createRequire 不可用（极老 Node 版本），requireFn 为 null，
// detectGraphStoreInternal 直接返回 false（降级模式）。
const requireFn: NodeRequire | null = (() => {
  try {
    return createRequire(import.meta.url);
  } catch {
    // createRequire 不可用（极老 Node 版本或异常环境），降级
    return null;
  }
})();

// ============================================================================
// 1. SymbolGraphAdapter 接口定义
// ============================================================================

/**
 * V2-P4 符号图谱适配层接口
 *
 * 封装 V2-P4 符号图谱查询能力，为 CodeMapSnippetProvider（DW-1/DW-2/DW-3）
 * 与 4 个 codemap_* 工具（DW-4 即时查）提供统一访问点。
 *
 * 接口契约（用户任务规格强制）：
 * - isAvailable(): 探测图谱是否可用（DefaultSymbolGraphAdapter 返回 false）
 * - queryByName(name, limit): 按名称查询符号（简单字符串匹配，无 FTS5）
 * - queryByKind(kind, limit): 按 kind 过滤符号
 * - getEdges(symbolId, direction): 查询节点边（Map 索引查找）
 * - getExplosionRadius(rootSymbolId, maxDepth, maxNodes): 爆炸半径 BFS
 *   （真实有界 BFS，禁 mock，DW-2 数据源）
 * - getRiskHotspots(topN): 风险热点 Top-N（按 importance 排序，DW-3 数据源）
 * - searchByQuery(query, limit): 自然语言查询（简单关键词匹配，无向量检索）
 *
 * 实现类：
 * - DefaultSymbolGraphAdapter：降级实现，所有方法返回空数组（本模块同包提供）
 * - StaticSymbolGraph：基于 Map + BFS 的真实降级实现（static-symbol-graph.ts）
 * - GraphStoreSymbolGraphAdapter：V2-P4 实施后的真实图谱实现（P5/P6 Phase 6 提供）
 *
 * 不可变优先：接口方法全部 readonly（接口属性形式），
 * 返回值全部 ReadonlyArray。
 */
export interface SymbolGraphAdapter {
  /**
   * 探测图谱是否可用
   *
   * @returns true=图谱可用，查询方法返回真实数据；
   *          false=图谱不可用，查询方法返回空数组（静默降级）
   */
  readonly isAvailable: () => boolean;

  /**
   * 按符号名查询符号
   *
   * 简单字符串匹配（无 FTS5 BM25 索引）：
   * - 精确匹配 symbol.name 优先
   * - 包含匹配 symbol.name.includes(name) 次之
   * - 不区分大小写
   *
   * @param name 符号名（部分匹配，如 "User" 可匹配 "UserService"）
   * @param limit 返回结果数上限
   * @returns 匹配的符号列表（最多 limit 条，按匹配度排序）
   */
  readonly queryByName: (name: string, limit: number) => ReadonlyArray<SymbolRecord>;

  /**
   * 按 kind 过滤符号
   *
   * @param kind 符号类型（function/class/interface/type/variable/module/namespace）
   * @param limit 返回结果数上限
   * @returns 匹配的符号列表（最多 limit 条，按 importance 降序排序）
   */
  readonly queryByKind: (kind: SymbolKind, limit: number) => ReadonlyArray<SymbolRecord>;

  /**
   * 查询节点的边
   *
   * @param symbolId 符号 ID
   * @param direction 边方向（incoming/outgoing/both）
   * @returns 边列表（按 edgeId 排序，便于测试断言稳定）
   */
  readonly getEdges: (symbolId: string, direction: EdgeDirection) => ReadonlyArray<EdgeRecord>;

  /**
   * 爆炸半径 BFS（DW-2 数据源）
   *
   * 从根符号出发，沿边进行有界 BFS 遍历，返回受影响的符号集合。
   * BFS 算法真实实现（禁 mock），覆盖 outgoing + incoming 双向边
   * （影响面分析需要反向调用者链 ±N 跳）。
   *
   * @param rootSymbolId 根符号 ID（BFS 起点）
   * @param maxDepth BFS 最大深度（默认 2，最大 3，防图谱爆炸）
   * @param maxNodes 返回节点数上限（防结果集过大）
   * @returns 受影响的符号列表（不含根符号本身，按 BFS 距离升序排序）
   */
  readonly getExplosionRadius: (
    rootSymbolId: string,
    maxDepth: number,
    maxNodes: number
  ) => ReadonlyArray<SymbolRecord>;

  /**
   * 风险热点 Top-N（DW-3 数据源）
   *
   * 按 importance 字段降序排序，返回前 topN 个高风险符号。
   * 用于 TESTING Loop 风险驱动用例优先级。
   *
   * @param topN 返回结果数上限
   * @returns 风险热点符号列表（按 importance 降序，最多 topN 条）
   */
  readonly getRiskHotspots: (topN: number) => ReadonlyArray<SymbolRecord>;

  /**
   * 自然语言查询符号（codemap_search 工具数据源）
   *
   * 简单关键词匹配（无 FTS5 + 向量 RRF 混合检索）：
   * - 将 query 分词（按空格 / 标点切分）
   * - 对每个符号的 name + summary + signature + filePath 进行关键词匹配
   * - 命中关键词数多的符号排名靠前
   *
   * @param query 自然语言查询字符串
   * @param limit 返回结果数上限
   * @returns 匹配的符号列表（最多 limit 条，按命中关键词数降序）
   */
  readonly searchByQuery: (query: string, limit: number) => ReadonlyArray<SymbolRecord>;
}

// ============================================================================
// 2. isGraphStoreAvailable 降级探测函数
// ============================================================================

/**
 * 探测结果缓存（模块级单例，避免高频调用时重复触发动态 import）
 *
 * undefined = 未探测；true = 可用；false = 不可用。
 * 测试通过 resetGraphStoreAvailabilityCache() 重置。
 */
let availabilityCache: boolean | undefined = undefined;

/**
 * 探测 V2-P4 图谱存储是否可用
 *
 * 探测逻辑（按顺序短路）：
 * 1. 环境变量短路：DCX_TEST_DISABLE_BETTER_SQLITE3=1 时直接返回 false
 *    （测试场景真实模拟降级模式，TC-ADAPTER-001 验证）
 * 2. 模块级缓存命中：availabilityCache 已设置时直接返回缓存值
 * 3. better-sqlite3 原生模块加载：动态 import + catch 加载异常
 * 4. SymbolGraphStore 类实例化：P5 未实施时此步抛错
 * 5. 任一步骤失败即返回 false（降级模式）
 *
 * 探测结果通过 availabilityCache 记忆，避免每次调用都触发动态 import。
 * 测试可通过 resetGraphStoreAvailabilityCache() 重置缓存。
 *
 * 当前 P6 Phase 1 状态：V2-P4 图谱模块未实施 → 函数必然返回 false
 * （better-sqlite3 未在 dependencies 中，SymbolGraphStore 类不存在）
 *
 * @returns true=可用 / false=不可用（降级到 JSON-only 模式，零回归）
 */
export function isGraphStoreAvailable(): boolean {
  // ---------- 1. 环境变量短路（测试场景真实模拟降级） ----------
  // DCX_TEST_DISABLE_BETTER_SQLITE3=1 时直接返回 false，不触发后续探测
  // 用于 TC-ADAPTER-001 验证（用户规则：禁止 mock，使用真实环境变量模拟降级）
  if (process.env.DCX_TEST_DISABLE_BETTER_SQLITE3 === "1") {
    availabilityCache = false;
    return false;
  }

  // ---------- 2. 模块级缓存命中 ----------
  if (availabilityCache !== undefined) {
    return availabilityCache;
  }

  // ---------- 3. 探测 better-sqlite3 + SymbolGraphStore ----------
  // 探测逻辑：try/catch 包裹，任一步骤失败即降级
  // 当前 P6 Phase 1：better-sqlite3 未在 dependencies 中，import 必然失败 → 返回 false
  // V2-P4 实施后：better-sqlite3 已安装 + SymbolGraphStore 类存在 → 返回 true
  availabilityCache = detectGraphStoreInternal();
  return availabilityCache;
}

/**
 * 重置图谱可用性探测缓存（仅供测试使用）
 *
 * 测试场景下需要多次探测（如先测试降级模式，再测试可用模式），
 * 通过本函数重置缓存，确保下一次 isGraphStoreAvailable() 调用重新探测。
 *
 * 注意：本函数仅供测试使用，生产代码不应调用。
 */
export function resetGraphStoreAvailabilityCache(): void {
  availabilityCache = undefined;
}

/**
 * 内部探测实现：better-sqlite3 加载 + SymbolGraphStore 类实例化
 *
 * 探测步骤（任一失败即返回 false）：
 * 1. 检测 requireFn 是否可用（createRequire 在模块加载时已尝试创建）
 * 2. 加载 better-sqlite3 原生模块（catch 加载异常）
 * 3. 加载 V2-P4 graph-store 模块并检测 SymbolGraphStore 类是否导出
 *
 * 当前 P6 Phase 1 实现：
 * - better-sqlite3 未在 packages/core/package.json dependencies 中
 *   （已通过 Grep 验证：仅 semantic-searcher.ts 注释提及"不依赖 better-sqlite3"）
 * - V2-P4 SymbolGraphStore 类未实施
 *   （已通过 LS 验证：packages/core/src/v2/codemap/ 下仅有 generator/regex-analyzer/
 *    file-watcher/markdown-renderer/codemap-commands，无 graph-store.ts）
 * - 故本函数当前必然返回 false
 *
 * 实现说明：
 * - 项目 type: "module"，无法直接调用 require()；通过 node:module.createRequire
 *   在模块加载时创建同步 require 函数（requireFn）
 * - requireFn 为 null 时直接返回 false（极老 Node 版本降级）
 * - 失败时静默返回 false（不抛错，不打印 warning，符合降级语义）
 *
 * @returns true=可用 / false=不可用
 */
function detectGraphStoreInternal(): boolean {
  // ---------- 0. 检测 requireFn 是否可用 ----------
  // requireFn 在模块加载时已尝试创建，此处仅检测是否成功
  if (requireFn === null) {
    // createRequire 不可用（极老 Node 版本或异常环境），降级
    return false;
  }

  // ---------- 1. 探测 better-sqlite3 原生模块加载 ----------
  // better-sqlite3 是 native 模块，加载失败常见原因：
  // - 未安装（dependencies 未声明）
  // - Node 版本不兼容
  // - 编译失败（node-gyp 环境缺失）
  // 上述任一情况均通过 try/catch 捕获，返回 false（降级模式）
  try {
    // 尝试加载 better-sqlite3
    // 若模块不存在或加载失败，requireFn 会抛 MODULE_NOT_FOUND 或原生编译错误
    requireFn("better-sqlite3");
  } catch {
    // better-sqlite3 加载失败（未安装 / 编译失败 / Node 版本不兼容）
    // 静默降级，不抛错，不打印 warning（符合降级语义）
    return false;
  }

  // ---------- 2. 探测 V2-P4 SymbolGraphStore 类是否可用 ----------
  // V2-P4 实施后，SymbolGraphStore 类位于 packages/core/src/v2/codemap/graph-store.ts
  // 当前 P6 Phase 1：该文件不存在，requireFn 必然抛 MODULE_NOT_FOUND → 返回 false
  try {
    // requireFn 解析相对路径基于 import.meta.url（即当前文件路径）
    // 当前文件位于 packages/core/src/v2/context/symbol-graph-adapter.ts
    // graph-store 模块相对路径：../codemap/graph-store.js
    const graphStoreModule = requireFn("../codemap/graph-store.js");
    // 探测类是否导出（不实例化，避免构造参数问题）
    if (!graphStoreModule || typeof graphStoreModule.SymbolGraphStore !== "function") {
      // SymbolGraphStore 类不存在（模块未导出该类）
      return false;
    }
    // 类存在，认为可用（实际实例化由调用方负责，本探测仅验证类可达）
    return true;
  } catch {
    // V2-P4 graph-store 模块未实施（文件不存在）或加载失败
    // 静默降级，不抛错
    return false;
  }
}

// ============================================================================
// 3. 默认空返回常量（供 DefaultSymbolGraphAdapter 复用，避免重复创建数组）
// ============================================================================

/**
 * 空符号列表常量（冻结，供降级实现复用）
 *
 * DefaultSymbolGraphAdapter 所有查询方法返回此常量，
 * 避免每次调用创建新数组对象（性能优化 + 不可变优先）。
 */
export const EMPTY_SYMBOL_RECORDS: ReadonlyArray<SymbolRecord> = Object.freeze([]);

/**
 * 空边列表常量（冻结，供降级实现复用）
 *
 * DefaultSymbolGraphAdapter.getEdges 返回此常量。
 */
export const EMPTY_EDGE_RECORDS: ReadonlyArray<EdgeRecord> = Object.freeze([]);
