/**
 * EAG-P6 Phase 1 单元测试：SymbolGraphAdapter 适配层 + 降级实现
 *
 * 测试范围（10 个 TC）：
 * - TC-ADAPTER-001: isGraphStoreAvailable() 在 better-sqlite3 不可加载时返回 false
 * - TC-ADAPTER-002: isGraphStoreAvailable() 在 better-sqlite3 可加载时返回 true（环境支持时）
 * - TC-ADAPTER-003: DefaultSymbolGraphAdapter.isAvailable() 返回 false
 * - TC-ADAPTER-004: DefaultSymbolGraphAdapter 所有查询方法返回空数组
 * - TC-ADAPTER-005: DefaultSymbolGraphAdapter 不抛错
 * - TC-ADAPTER-006: StaticSymbolGraph 构造可接收静态数据
 * - TC-ADAPTER-007: StaticSymbolGraph.queryByName 简单字符串匹配
 * - TC-ADAPTER-008: StaticSymbolGraph.getExplosionRadius 真实 BFS（禁 mock）
 * - TC-ADAPTER-009: StaticSymbolGraph.getEdges Map 索引查找
 * - TC-ADAPTER-010: 所有新增类型 readonly（运行时 Object.freeze 校验）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象与真实图谱数据
 * - BFS 测试使用真实 5 节点 5 边的环形图谱（验证双向遍历 + 循环检测）
 *
 * 测试图谱设计（5 节点 5 边，环形结构）：
 *   UserService ──e1──→ login ──e2──→ verifyToken ──e3──→ AuthModule ──e4──→ logger
 *       ↑                                                                    │
 *       └────────────────────── e5 ──────────────────────────────────────────┘
 *
 * 节点信息：
 *   - UserService (class, importance: 0.8, src/A.ts)
 *   - login (function, importance: 0.7, src/B.ts)
 *   - verifyToken (function, importance: 0.6, src/C.ts)
 *   - AuthModule (class, importance: 0.5, src/D.ts)
 *   - logger (function, importance: 0.9, src/E.ts)
 *
 * 边信息（全部 CALLS 关系）：
 *   - e1: UserService → login (HIGH)
 *   - e2: login → verifyToken (HIGH)
 *   - e3: verifyToken → AuthModule (MEDIUM)
 *   - e4: AuthModule → logger (LOW)
 *   - e5: logger → UserService (MEDIUM)  [形成环，用于测试循环检测]
 *
 * @module core/tests/eag-p6-symbol-graph-adapter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// 导入待测试模块
import {
  isGraphStoreAvailable,
  resetGraphStoreAvailabilityCache,
  EMPTY_SYMBOL_RECORDS,
  EMPTY_EDGE_RECORDS,
  type SymbolGraphAdapter,
} from "../v2/context/symbol-graph-adapter";
import { DefaultSymbolGraphAdapter } from "../v2/context/default-symbol-graph-adapter";
import { StaticSymbolGraph } from "../v2/context/static-symbol-graph";
import type {
  EdgeDirection,
  EdgeKind,
  Confidence,
  SymbolKind,
  SymbolRecord,
  EdgeRecord,
  StaticGraphData,
} from "../v2/context/symbol-graph-types";
import {
  SYMBOL_KINDS,
  EDGE_DIRECTIONS,
  EDGE_KINDS,
  CONFIDENCE_LEVELS,
  CONFIDENCE_WEIGHTS,
} from "../v2/context/symbol-graph-types";

// ============================================================================
// 测试数据：5 节点 5 边的环形图谱
// ============================================================================

/**
 * 测试图谱节点列表（5 个符号，覆盖 class/function 两种 kind）
 *
 * importance 设计（用于验证 getRiskHotspots 排序）：
 * - logger: 0.9（最高，验证风险热点排序）
 * - UserService: 0.8
 * - login: 0.7
 * - verifyToken: 0.6
 * - AuthModule: 0.5（最低）
 */
const TEST_SYMBOLS: SymbolRecord[] = [
  {
    symbolId: "src/A.ts:UserService",
    kind: "class",
    name: "UserService",
    signature: "class UserService { login(email, password): Promise<AuthToken> }",
    filePath: "src/A.ts",
    startLine: 10,
    endLine: 80,
    summary: "用户服务类，封装登录与权限校验",
    importance: 0.8,
  },
  {
    symbolId: "src/B.ts:login",
    kind: "function",
    name: "login",
    signature: "login(email: string, password: string): Promise<AuthToken>",
    filePath: "src/B.ts",
    startLine: 5,
    endLine: 30,
    summary: "用户登录函数，校验凭证后颁发 token",
    importance: 0.7,
  },
  {
    symbolId: "src/C.ts:verifyToken",
    kind: "function",
    name: "verifyToken",
    signature: "verifyToken(token: string): Promise<boolean>",
    filePath: "src/C.ts",
    startLine: 1,
    endLine: 20,
    summary: "验证 JWT token 有效性",
    importance: 0.6,
  },
  {
    symbolId: "src/D.ts:AuthModule",
    kind: "class",
    name: "AuthModule",
    signature: "class AuthModule { authenticate(req): Promise<User> }",
    filePath: "src/D.ts",
    startLine: 15,
    endLine: 50,
    summary: "认证模块，集成 OAuth 与 JWT",
    importance: 0.5,
  },
  {
    symbolId: "src/E.ts:logger",
    kind: "function",
    name: "logger",
    signature: "logger(level: string, message: string): void",
    filePath: "src/E.ts",
    startLine: 1,
    endLine: 10,
    summary: "日志记录函数",
    importance: 0.9,
  },
];

/**
 * 测试图谱边列表（5 条边，形成环形结构）
 *
 * 环形结构设计（用于验证 BFS 循环检测）：
 *   UserService → login → verifyToken → AuthModule → logger → UserService（回到起点）
 */
const TEST_EDGES: EdgeRecord[] = [
  {
    edgeId: "e1",
    srcSymbolId: "src/A.ts:UserService",
    dstSymbolId: "src/B.ts:login",
    edgeKind: "CALLS",
    confidence: "HIGH",
  },
  {
    edgeId: "e2",
    srcSymbolId: "src/B.ts:login",
    dstSymbolId: "src/C.ts:verifyToken",
    edgeKind: "CALLS",
    confidence: "HIGH",
  },
  {
    edgeId: "e3",
    srcSymbolId: "src/C.ts:verifyToken",
    dstSymbolId: "src/D.ts:AuthModule",
    edgeKind: "CALLS",
    confidence: "MEDIUM",
  },
  {
    edgeId: "e4",
    srcSymbolId: "src/D.ts:AuthModule",
    dstSymbolId: "src/E.ts:logger",
    edgeKind: "CALLS",
    confidence: "LOW",
  },
  {
    edgeId: "e5",
    srcSymbolId: "src/E.ts:logger",
    dstSymbolId: "src/A.ts:UserService",
    edgeKind: "CALLS",
    confidence: "MEDIUM",
  },
];

/**
 * 测试图谱数据包（符号 + 边）
 */
const TEST_GRAPH_DATA: StaticGraphData = {
  symbolRecords: TEST_SYMBOLS,
  edgeRecords: TEST_EDGES,
};

// ============================================================================
// TC-ADAPTER-001: isGraphStoreAvailable() 在 better-sqlite3 不可加载时返回 false
// ============================================================================

test("TC-ADAPTER-001: isGraphStoreAvailable() 在 better-sqlite3 不可加载时返回 false", () => {
  // ---------- 保存原始环境变量 ----------
  const originalValue = process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;

  try {
    // ---------- 设置环境变量短路（模拟降级模式） ----------
    // DCX_TEST_DISABLE_BETTER_SQLITE3=1 时，isGraphStoreAvailable() 直接返回 false
    // 这是真实的环境变量检测，不是 mock
    process.env.DCX_TEST_DISABLE_BETTER_SQLITE3 = "1";

    // 重置缓存，确保本次探测走环境变量短路路径
    resetGraphStoreAvailabilityCache();

    // ---------- 断言：返回 false（降级模式） ----------
    const result = isGraphStoreAvailable();
    assert.equal(result, false, "DCX_TEST_DISABLE_BETTER_SQLITE3=1 时，isGraphStoreAvailable() 必须返回 false");
  } finally {
    // ---------- 清理：恢复原始环境变量 + 重置缓存 ----------
    if (originalValue === undefined) {
      delete process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;
    } else {
      process.env.DCX_TEST_DISABLE_BETTER_SQLITE3 = originalValue;
    }
    resetGraphStoreAvailabilityCache();
  }
});

// ============================================================================
// TC-ADAPTER-002: isGraphStoreAvailable() 在 better-sqlite3 可加载时返回 true（环境支持时）
// ============================================================================

test("TC-ADAPTER-002: isGraphStoreAvailable() 在 better-sqlite3 可加载时返回 true（环境支持时）", (t) => {
  // ---------- 保存原始环境变量 ----------
  const originalValue = process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;

  try {
    // ---------- 确保环境变量未设置（不走短路路径） ----------
    delete process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;
    resetGraphStoreAvailabilityCache();

    // ---------- 检测 better-sqlite3 与 SymbolGraphStore 是否可用 ----------
    // 由于项目 dependencies 中无 better-sqlite3，且 V2-P4 graph-store 模块未实施，
    // 此处检测结果通常为 false。当 V2-P4 实施后，此测试会自动验证 true 路径。
    const requireFn = createRequire(import.meta.url);

    let betterSqlite3Available = false;
    try {
      requireFn("better-sqlite3");
      betterSqlite3Available = true;
    } catch {
      betterSqlite3Available = false;
    }

    let graphStoreAvailable = false;
    if (betterSqlite3Available) {
      try {
        const graphStoreModule = requireFn("../v2/context/../codemap/graph-store.js");
        graphStoreAvailable = graphStoreModule && typeof graphStoreModule.SymbolGraphStore === "function";
      } catch {
        graphStoreAvailable = false;
      }
    }

    // ---------- 条件性测试：环境不支持时跳过 ----------
    // 当 better-sqlite3 或 SymbolGraphStore 不可用时跳过测试（非 mock，真实环境检测）
    if (!betterSqlite3Available || !graphStoreAvailable) {
      t.skip(
        `跳过：better-sqlite3 可用=${betterSqlite3Available}，SymbolGraphStore 可用=${graphStoreAvailable}（V2-P4 未实施，环境不支持 true 路径测试）`
      );
      return;
    }

    // ---------- 环境支持时：断言返回 true ----------
    const result = isGraphStoreAvailable();
    assert.equal(result, true, "better-sqlite3 与 SymbolGraphStore 均可用时，isGraphStoreAvailable() 必须返回 true");
  } finally {
    // ---------- 清理 ----------
    if (originalValue === undefined) {
      delete process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;
    } else {
      process.env.DCX_TEST_DISABLE_BETTER_SQLITE3 = originalValue;
    }
    resetGraphStoreAvailabilityCache();
  }
});

// ============================================================================
// TC-ADAPTER-003: DefaultSymbolGraphAdapter.isAvailable() 返回 false
// ============================================================================

test("TC-ADAPTER-003: DefaultSymbolGraphAdapter.isAvailable() 返回 false", () => {
  // 构造 DefaultSymbolGraphAdapter 实例（降级实现）
  const adapter = new DefaultSymbolGraphAdapter();

  // 断言：isAvailable() 始终返回 false（降级模式标志）
  assert.equal(adapter.isAvailable(), false, "DefaultSymbolGraphAdapter.isAvailable() 必须返回 false（降级模式）");

  // 多次调用验证一致性（无状态，每次返回相同结果）
  assert.equal(adapter.isAvailable(), false, "多次调用 isAvailable() 必须一致返回 false");
});

// ============================================================================
// TC-ADAPTER-004: DefaultSymbolGraphAdapter 所有查询方法返回空数组
// ============================================================================

test("TC-ADAPTER-004: DefaultSymbolGraphAdapter 所有查询方法返回空数组", () => {
  const adapter = new DefaultSymbolGraphAdapter();

  // ---------- 验证所有查询方法返回空数组 ----------
  // queryByName
  const byName = adapter.queryByName("UserService", 10);
  assert.equal(byName.length, 0, "queryByName 必须返回空数组");
  assert.deepEqual(byName, [], "queryByName 必须返回空数组");

  // queryByKind
  const byKind = adapter.queryByKind("class", 10);
  assert.equal(byKind.length, 0, "queryByKind 必须返回空数组");
  assert.deepEqual(byKind, [], "queryByKind 必须返回空数组");

  // getEdges
  const edges = adapter.getEdges("src/A.ts:UserService", "both");
  assert.equal(edges.length, 0, "getEdges 必须返回空数组");
  assert.deepEqual(edges, [], "getEdges 必须返回空数组");

  // getExplosionRadius
  const explosion = adapter.getExplosionRadius("src/A.ts:UserService", 2, 50);
  assert.equal(explosion.length, 0, "getExplosionRadius 必须返回空数组");
  assert.deepEqual(explosion, [], "getExplosionRadius 必须返回空数组");

  // getRiskHotspots
  const hotspots = adapter.getRiskHotspots(10);
  assert.equal(hotspots.length, 0, "getRiskHotspots 必须返回空数组");
  assert.deepEqual(hotspots, [], "getRiskHotspots 必须返回空数组");

  // searchByQuery
  const search = adapter.searchByQuery("login token", 10);
  assert.equal(search.length, 0, "searchByQuery 必须返回空数组");
  assert.deepEqual(search, [], "searchByQuery 必须返回空数组");

  // ---------- 验证返回的是冻结的空数组常量（同一引用） ----------
  // 性能优化：所有方法返回共享的 EMPTY_SYMBOL_RECORDS / EMPTY_EDGE_RECORDS
  assert.equal(byName, EMPTY_SYMBOL_RECORDS, "queryByName 应返回 EMPTY_SYMBOL_RECORDS 常量");
  assert.equal(byKind, EMPTY_SYMBOL_RECORDS, "queryByKind 应返回 EMPTY_SYMBOL_RECORDS 常量");
  assert.equal(explosion, EMPTY_SYMBOL_RECORDS, "getExplosionRadius 应返回 EMPTY_SYMBOL_RECORDS 常量");
  assert.equal(hotspots, EMPTY_SYMBOL_RECORDS, "getRiskHotspots 应返回 EMPTY_SYMBOL_RECORDS 常量");
  assert.equal(search, EMPTY_SYMBOL_RECORDS, "searchByQuery 应返回 EMPTY_SYMBOL_RECORDS 常量");
  assert.equal(edges, EMPTY_EDGE_RECORDS, "getEdges 应返回 EMPTY_EDGE_RECORDS 常量");
});

// ============================================================================
// TC-ADAPTER-005: DefaultSymbolGraphAdapter 不抛错
// ============================================================================

test("TC-ADAPTER-005: DefaultSymbolGraphAdapter 不抛错", () => {
  const adapter = new DefaultSymbolGraphAdapter();

  // ---------- 验证各种边界输入不抛错（静默降级） ----------

  // 空字符串输入
  assert.doesNotThrow(() => adapter.queryByName("", 10), "queryByName 空字符串不应抛错");
  assert.doesNotThrow(() => adapter.searchByQuery("", 10), "searchByQuery 空字符串不应抛错");
  assert.doesNotThrow(() => adapter.getEdges("", "both"), "getEdges 空字符串不应抛错");
  assert.doesNotThrow(() => adapter.getExplosionRadius("", 2, 50), "getExplosionRadius 空字符串不应抛错");

  // 不存在的 symbolId
  assert.doesNotThrow(() => adapter.getEdges("nonexistent", "both"), "getEdges 不存在的 symbolId 不应抛错");
  assert.doesNotThrow(
    () => adapter.getExplosionRadius("nonexistent", 2, 50),
    "getExplosionRadius 不存在的 symbolId 不应抛错"
  );

  // 零与负数 limit / topN / maxDepth / maxNodes
  assert.doesNotThrow(() => adapter.queryByName("test", 0), "queryByName limit=0 不应抛错");
  assert.doesNotThrow(() => adapter.queryByName("test", -1), "queryByName limit=-1 不应抛错");
  assert.doesNotThrow(() => adapter.queryByKind("class", 0), "queryByKind limit=0 不应抛错");
  assert.doesNotThrow(() => adapter.getExplosionRadius("test", 0, 50), "getExplosionRadius maxDepth=0 不应抛错");
  assert.doesNotThrow(() => adapter.getExplosionRadius("test", 2, 0), "getExplosionRadius maxNodes=0 不应抛错");
  assert.doesNotThrow(() => adapter.getRiskHotspots(0), "getRiskHotspots topN=0 不应抛错");
  assert.doesNotThrow(() => adapter.getRiskHotspots(-5), "getRiskHotspots topN=-5 不应抛错");
  assert.doesNotThrow(() => adapter.searchByQuery("test", 0), "searchByQuery limit=0 不应抛错");

  // ---------- 验证所有调用都返回数组（即使是边界输入） ----------
  assert.equal(adapter.queryByName("", 10).length, 0);
  assert.equal(adapter.getEdges("nonexistent", "both").length, 0);
  assert.equal(adapter.getExplosionRadius("nonexistent", 2, 50).length, 0);
  assert.equal(adapter.getRiskHotspots(0).length, 0);
});

// ============================================================================
// TC-ADAPTER-006: StaticSymbolGraph 构造可接收静态数据
// ============================================================================

test("TC-ADAPTER-006: StaticSymbolGraph 构造可接收静态数据", () => {
  // ---------- 构造图谱（注入 5 节点 5 边的测试数据） ----------
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // ---------- 验证 isAvailable() 返回 true（静态图谱已构建） ----------
  assert.equal(graph.isAvailable(), true, "StaticSymbolGraph.isAvailable() 必须返回 true（静态图谱已构建）");

  // ---------- 验证图谱可正常查询（非空结果） ----------
  // queryByName 应能找到 UserService
  const byName = graph.queryByName("UserService", 10);
  assert.equal(byName.length, 1, "queryByName('UserService') 应返回 1 个结果");
  assert.equal(byName[0].name, "UserService", "查询结果名称应为 UserService");

  // queryByKind("class") 应返回 2 个 class（UserService + AuthModule）
  const byKind = graph.queryByKind("class", 10);
  assert.equal(byKind.length, 2, "queryByKind('class') 应返回 2 个 class");

  // getRiskHotspots(5) 应返回全部 5 个符号（按 importance 降序）
  const hotspots = graph.getRiskHotspots(5);
  assert.equal(hotspots.length, 5, "getRiskHotspots(5) 应返回 5 个符号");
  // 验证排序：logger (0.9) 应在第一位
  assert.equal(hotspots[0].name, "logger", "风险热点第一位应为 logger (importance=0.9)");

  // ---------- 验证空数据构造不抛错 ----------
  const emptyGraph = new StaticSymbolGraph({ symbolRecords: [], edgeRecords: [] });
  assert.equal(emptyGraph.isAvailable(), true, "空图谱 isAvailable() 也应返回 true");
  assert.equal(emptyGraph.queryByName("test", 10).length, 0, "空图谱查询应返回 0 结果");
  assert.equal(emptyGraph.getRiskHotspots(10).length, 0, "空图谱 getRiskHotspots 应返回 0 结果");
});

// ============================================================================
// TC-ADAPTER-007: StaticSymbolGraph.queryByName 简单字符串匹配
// ============================================================================

test("TC-ADAPTER-007: StaticSymbolGraph.queryByName 简单字符串匹配", () => {
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // ---------- 测试精确匹配 ----------
  // "login" 精确匹配 login 符号
  const exactMatch = graph.queryByName("login", 10);
  assert.equal(exactMatch.length, 1, "精确匹配 'login' 应返回 1 个结果");
  assert.equal(exactMatch[0].name, "login", "精确匹配结果应为 login");
  assert.equal(exactMatch[0].symbolId, "src/B.ts:login", "精确匹配 symbolId 应为 src/B.ts:login");

  // ---------- 测试包含匹配（不区分大小写） ----------
  // "user" 包含匹配 UserService（不区分大小写）
  const containsMatch = graph.queryByName("user", 10);
  assert.equal(containsMatch.length, 1, "包含匹配 'user' 应返回 1 个结果（UserService）");
  assert.equal(containsMatch[0].name, "UserService", "包含匹配结果应为 UserService");

  // "auth" 包含匹配 AuthModule（不区分大小写）
  const authMatch = graph.queryByName("auth", 10);
  assert.equal(authMatch.length, 1, "包含匹配 'auth' 应返回 1 个结果（AuthModule）");
  assert.equal(authMatch[0].name, "AuthModule", "包含匹配结果应为 AuthModule");

  // ---------- 测试精确匹配优先于包含匹配 ----------
  // "logger" 精确匹配 logger，不包含其他符号
  const loggerMatch = graph.queryByName("logger", 10);
  assert.equal(loggerMatch.length, 1, "精确匹配 'logger' 应返回 1 个结果");
  assert.equal(loggerMatch[0].name, "logger", "精确匹配结果应为 logger");

  // ---------- 测试 limit 截断 ----------
  // "e" 包含匹配 logger, UserService, verifyToken, AuthModule（都包含 'e'）
  // 但 login 不包含 'e'... 让我重新分析：
  // - UserService: "userservice" 包含 "e" → 是
  // - login: "login" 包含 "e" → 否
  // - verifyToken: "verifytoken" 包含 "e" → 是
  // - AuthModule: "authmodule" 包含 "e" → 是
  // - logger: "logger" 包含 "e" → 是
  // 共 4 个包含 "e" 的符号
  const eMatch = graph.queryByName("e", 2);
  assert.equal(eMatch.length, 2, "包含匹配 'e' limit=2 应返回 2 个结果（截断）");

  // ---------- 测试无匹配 ----------
  const noMatch = graph.queryByName("nonexistent", 10);
  assert.equal(noMatch.length, 0, "无匹配时应返回空数组");

  // ---------- 测试边界输入 ----------
  assert.equal(graph.queryByName("", 10).length, 0, "空字符串应返回空数组");
  assert.equal(graph.queryByName("test", 0).length, 0, "limit=0 应返回空数组");
  assert.equal(graph.queryByName("test", -1).length, 0, "limit=-1 应返回空数组");
});

// ============================================================================
// TC-ADAPTER-008: StaticSymbolGraph.getExplosionRadius 真实 BFS（禁 mock）
// ============================================================================

test("TC-ADAPTER-008: StaticSymbolGraph.getExplosionRadius 真实 BFS（禁 mock）", () => {
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // ---------- BFS 测试 1：从 UserService 出发，maxDepth=2，双向边遍历 ----------
  //
  // 图谱结构：
  //   UserService ──e1──→ login ──e2──→ verifyToken ──e3──→ AuthModule ──e4──→ logger
  //       ↑                                                                    │
  //       └────────────────────── e5 ──────────────────────────────────────────┘
  //
  // BFS from UserService (maxDepth=2):
  //   Depth 0: UserService (root, 不计入结果)
  //   Depth 1: login (outgoing e1), logger (incoming e5)
  //     - login importance: 0.7, logger importance: 0.9
  //     - 同深度按 importance 降序：[logger, login]
  //   Depth 2: verifyToken (from login outgoing e2), AuthModule (from logger incoming e4)
  //     - verifyToken importance: 0.6, AuthModule importance: 0.5
  //     - 同深度按 importance 降序：[verifyToken, AuthModule]
  //   最终结果：[logger, login, verifyToken, AuthModule]（4 个节点）
  const explosion1 = graph.getExplosionRadius("src/A.ts:UserService", 2, 50);
  assert.equal(explosion1.length, 4, "BFS from UserService maxDepth=2 应返回 4 个节点");
  // 验证 BFS 距离排序 + 同深度 importance 降序
  assert.equal(explosion1[0].name, "logger", "BFS depth=1 第一个应为 logger (importance=0.9)");
  assert.equal(explosion1[1].name, "login", "BFS depth=1 第二个应为 login (importance=0.7)");
  assert.equal(explosion1[2].name, "verifyToken", "BFS depth=2 第一个应为 verifyToken (importance=0.6)");
  assert.equal(explosion1[3].name, "AuthModule", "BFS depth=2 第二个应为 AuthModule (importance=0.5)");

  // ---------- BFS 测试 2：从 UserService 出发，maxDepth=1（限制深度） ----------
  //   Depth 0: UserService (root)
  //   Depth 1: login, logger
  //   最终结果：[logger, login]（2 个节点，深度限制为 1）
  const explosion2 = graph.getExplosionRadius("src/A.ts:UserService", 1, 50);
  assert.equal(explosion2.length, 2, "BFS from UserService maxDepth=1 应返回 2 个节点");
  assert.equal(explosion2[0].name, "logger", "BFS depth=1 第一个应为 logger");
  assert.equal(explosion2[1].name, "login", "BFS depth=1 第二个应为 login");

  // ---------- BFS 测试 3：从 UserService 出发，maxDepth=3（完整遍历，含循环检测） ----------
  //   Depth 0: UserService (root)
  //   Depth 1: login, logger
  //   Depth 2: verifyToken, AuthModule
  //   Depth 3: （verifyToken 的邻居 AuthModule 已访问，AuthModule 的邻居 logger 已访问）
  //   最终结果：[logger, login, verifyToken, AuthModule]（4 个节点，循环检测阻止回到 UserService）
  const explosion3 = graph.getExplosionRadius("src/A.ts:UserService", 3, 50);
  assert.equal(explosion3.length, 4, "BFS from UserService maxDepth=3 应返回 4 个节点（循环检测阻止回到 root）");

  // ---------- BFS 测试 4：从 verifyToken 出发（验证双向 BFS） ----------
  //   verifyToken 的邻居：
  //     outgoing: AuthModule (e3)
  //     incoming: login (e2)
  //   Depth 1: login (0.7), AuthModule (0.5) → sorted: [login, AuthModule]
  //   Depth 2: from login → UserService (e1 incoming), verifyToken (e2 outgoing, 已访问)
  //            from AuthModule → logger (e4 outgoing), verifyToken (e3 incoming, 已访问)
  //   Depth 2: UserService (0.8), logger (0.9) → sorted: [logger, UserService]
  //   最终结果：[login, AuthModule, logger, UserService]（4 个节点）
  const explosion4 = graph.getExplosionRadius("src/C.ts:verifyToken", 2, 50);
  assert.equal(explosion4.length, 4, "BFS from verifyToken maxDepth=2 应返回 4 个节点（双向 BFS）");
  assert.equal(explosion4[0].name, "login", "BFS depth=1 第一个应为 login (importance=0.7)");
  assert.equal(explosion4[1].name, "AuthModule", "BFS depth=1 第二个应为 AuthModule (importance=0.5)");
  assert.equal(explosion4[2].name, "logger", "BFS depth=2 第一个应为 logger (importance=0.9)");
  assert.equal(explosion4[3].name, "UserService", "BFS depth=2 第二个应为 UserService (importance=0.8)");

  // ---------- BFS 测试 5：maxNodes 限制（截断） ----------
  //   maxNodes=1 时，只返回 1 个节点（logger，depth=1 中 importance 最高）
  const explosion5 = graph.getExplosionRadius("src/A.ts:UserService", 2, 1);
  assert.equal(explosion5.length, 1, "BFS maxNodes=1 应返回 1 个节点");
  assert.equal(explosion5[0].name, "logger", "maxNodes=1 时应返回 importance 最高的 logger");

  // ---------- BFS 测试 6：不存在的 rootSymbolId ----------
  const explosion6 = graph.getExplosionRadius("nonexistent", 2, 50);
  assert.equal(explosion6.length, 0, "不存在的 rootSymbolId 应返回空数组");

  // ---------- BFS 测试 7：边界输入 ----------
  assert.equal(graph.getExplosionRadius("src/A.ts:UserService", 0, 50).length, 0, "maxDepth=0 应返回空数组");
  assert.equal(graph.getExplosionRadius("src/A.ts:UserService", 2, 0).length, 0, "maxNodes=0 应返回空数组");
  assert.equal(graph.getExplosionRadius("", 2, 50).length, 0, "空 rootSymbolId 应返回空数组");
});

// ============================================================================
// TC-ADAPTER-009: StaticSymbolGraph.getEdges Map 索引查找
// ============================================================================

test("TC-ADAPTER-009: StaticSymbolGraph.getEdges Map 索引查找", () => {
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // ---------- 测试 outgoing 边 ----------
  // UserService 的 outgoing 边：e1 (UserService → login)
  const outgoing = graph.getEdges("src/A.ts:UserService", "outgoing");
  assert.equal(outgoing.length, 1, "UserService outgoing 应有 1 条边（e1）");
  assert.equal(outgoing[0].edgeId, "e1", "UserService outgoing 边应为 e1");
  assert.equal(outgoing[0].srcSymbolId, "src/A.ts:UserService", "e1 源应为 UserService");
  assert.equal(outgoing[0].dstSymbolId, "src/B.ts:login", "e1 目标应为 login");

  // ---------- 测试 incoming 边 ----------
  // UserService 的 incoming 边：e5 (logger → UserService)
  const incoming = graph.getEdges("src/A.ts:UserService", "incoming");
  assert.equal(incoming.length, 1, "UserService incoming 应有 1 条边（e5）");
  assert.equal(incoming[0].edgeId, "e5", "UserService incoming 边应为 e5");
  assert.equal(incoming[0].srcSymbolId, "src/E.ts:logger", "e5 源应为 logger");
  assert.equal(incoming[0].dstSymbolId, "src/A.ts:UserService", "e5 目标应为 UserService");

  // ---------- 测试 both 方向 ----------
  // UserService 的 both 边：e1 (outgoing) + e5 (incoming)，按 edgeId 排序
  const both = graph.getEdges("src/A.ts:UserService", "both");
  assert.equal(both.length, 2, "UserService both 应有 2 条边（e1 + e5）");
  assert.equal(both[0].edgeId, "e1", "both 第一条边应为 e1（按 edgeId 排序）");
  assert.equal(both[1].edgeId, "e5", "both 第二条边应为 e5（按 edgeId 排序）");

  // ---------- 测试多边节点 ----------
  // login 的 outgoing 边：e2 (login → verifyToken)
  // login 的 incoming 边：e1 (UserService → login)
  // login 的 both 边：e1 + e2，按 edgeId 排序
  const loginBoth = graph.getEdges("src/B.ts:login", "both");
  assert.equal(loginBoth.length, 2, "login both 应有 2 条边（e1 incoming + e2 outgoing）");
  assert.equal(loginBoth[0].edgeId, "e1", "login both 第一条边应为 e1");
  assert.equal(loginBoth[1].edgeId, "e2", "login both 第二条边应为 e2");

  // ---------- 测试无边节点（理论上环形图谱中每个节点都有边，用不存在的 ID 测试） ----------
  const noEdges = graph.getEdges("nonexistent", "both");
  assert.equal(noEdges.length, 0, "不存在的 symbolId 应返回空数组");

  // ---------- 测试边界输入 ----------
  assert.equal(graph.getEdges("", "both").length, 0, "空 symbolId 应返回空数组");
  assert.equal(
    graph.getEdges("src/A.ts:UserService", "incoming" as EdgeDirection).length,
    1,
    "incoming 方向应返回 1 条边"
  );
  assert.equal(
    graph.getEdges("src/A.ts:UserService", "outgoing" as EdgeDirection).length,
    1,
    "outgoing 方向应返回 1 条边"
  );

  // ---------- 验证返回的边对象已冻结（不可变） ----------
  assert.equal(Object.isFrozen(incoming), true, "返回的边列表应已冻结（Object.freeze）");
  assert.equal(Object.isFrozen(incoming[0]), true, "返回的边对象应已冻结（Object.freeze）");
});

// ============================================================================
// TC-ADAPTER-010: 所有新增类型 readonly（运行时 Object.freeze 校验）
// ============================================================================

test("TC-ADAPTER-010: 所有新增类型 readonly（运行时 Object.freeze 校验）", () => {
  // ---------- 验证枚举常量已冻结 ----------
  assert.equal(Object.isFrozen(SYMBOL_KINDS), true, "SYMBOL_KINDS 应已冻结");
  assert.equal(Object.isFrozen(EDGE_DIRECTIONS), true, "EDGE_DIRECTIONS 应已冻结");
  assert.equal(Object.isFrozen(EDGE_KINDS), true, "EDGE_KINDS 应已冻结");
  assert.equal(Object.isFrozen(CONFIDENCE_LEVELS), true, "CONFIDENCE_LEVELS 应已冻结");
  assert.equal(Object.isFrozen(CONFIDENCE_WEIGHTS), true, "CONFIDENCE_WEIGHTS 应已冻结");

  // ---------- 验证空数组常量已冻结 ----------
  assert.equal(Object.isFrozen(EMPTY_SYMBOL_RECORDS), true, "EMPTY_SYMBOL_RECORDS 应已冻结");
  assert.equal(Object.isFrozen(EMPTY_EDGE_RECORDS), true, "EMPTY_EDGE_RECORDS 应已冻结");

  // ---------- 验证 StaticSymbolGraph 返回的结果已冻结 ----------
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // queryByName 返回的数组应已冻结
  const byName = graph.queryByName("login", 10);
  assert.equal(Object.isFrozen(byName), true, "queryByName 返回的数组应已冻结");

  // queryByKind 返回的数组应已冻结
  const byKind = graph.queryByKind("class", 10);
  assert.equal(Object.isFrozen(byKind), true, "queryByKind 返回的数组应已冻结");

  // getEdges 返回的数组应已冻结
  const edges = graph.getEdges("src/A.ts:UserService", "both");
  assert.equal(Object.isFrozen(edges), true, "getEdges 返回的数组应已冻结");
  if (edges.length > 0) {
    assert.equal(Object.isFrozen(edges[0]), true, "getEdges 返回的边对象应已冻结");
  }

  // getExplosionRadius 返回的数组应已冻结
  const explosion = graph.getExplosionRadius("src/A.ts:UserService", 2, 50);
  assert.equal(Object.isFrozen(explosion), true, "getExplosionRadius 返回的数组应已冻结");
  if (explosion.length > 0) {
    assert.equal(Object.isFrozen(explosion[0]), true, "getExplosionRadius 返回的符号对象应已冻结");
  }

  // getRiskHotspots 返回的数组应已冻结
  const hotspots = graph.getRiskHotspots(3);
  assert.equal(Object.isFrozen(hotspots), true, "getRiskHotspots 返回的数组应已冻结");
  if (hotspots.length > 0) {
    assert.equal(Object.isFrozen(hotspots[0]), true, "getRiskHotspots 返回的符号对象应已冻结");
  }

  // searchByQuery 返回的数组应已冻结
  const search = graph.searchByQuery("login", 10);
  assert.equal(Object.isFrozen(search), true, "searchByQuery 返回的数组应已冻结");

  // ---------- 验证冻结对象的修改会抛错（strict mode 下） ----------
  // ES Module 默认严格模式，修改冻结对象会抛 TypeError
  assert.throws(
    () => {
      // 尝试向冻结数组 push 元素（应抛 TypeError）
      (byName as unknown as SymbolRecord[]).push(byName[0]);
    },
    TypeError,
    "向冻结数组 push 元素应抛 TypeError"
  );

  // ---------- 验证 DefaultSymbolGraphAdapter 返回的常量也是冻结的 ----------
  const defaultAdapter = new DefaultSymbolGraphAdapter();
  const defaultResult = defaultAdapter.queryByName("test", 10);
  assert.equal(Object.isFrozen(defaultResult), true, "DefaultSymbolGraphAdapter 返回的数组应已冻结");
  assert.equal(defaultResult, EMPTY_SYMBOL_RECORDS, "DefaultSymbolGraphAdapter 应返回冻结的 EMPTY_SYMBOL_RECORDS 常量");

  // ---------- 编译期 readonly 校验（通过类型系统保证） ----------
  // 以下赋值在编译期会被 TypeScript 拒绝（readonly 属性）：
  //   const sym: SymbolRecord = TEST_SYMBOLS[0];
  //   sym.symbolId = "modified";  // TS Error: Cannot assign to 'symbolId' because it is a read-only property
  // 测试文件本身被 tsc 编译（通过 tsx 运行），若编译失败则测试无法运行，
  // 故测试成功运行即证明类型定义正确。
});

// ============================================================================
// 附加测试：StaticSymbolGraph 的 queryByKind + getRiskHotspots + searchByQuery
// ============================================================================

test("附加测试：StaticSymbolGraph.queryByKind 按 importance 降序排序", () => {
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // queryByKind("class") 应返回 UserService (0.8) + AuthModule (0.5)
  // 按 importance 降序：[UserService, AuthModule]
  const classes = graph.queryByKind("class", 10);
  assert.equal(classes.length, 2, "queryByKind('class') 应返回 2 个 class");
  assert.equal(classes[0].name, "UserService", "第一个 class 应为 UserService (importance=0.8)");
  assert.equal(classes[1].name, "AuthModule", "第二个 class 应为 AuthModule (importance=0.5)");

  // queryByKind("function") 应返回 login (0.7) + verifyToken (0.6) + logger (0.9)
  // 按 importance 降序：[logger, login, verifyToken]
  const functions = graph.queryByKind("function", 10);
  assert.equal(functions.length, 3, "queryByKind('function') 应返回 3 个 function");
  assert.equal(functions[0].name, "logger", "第一个 function 应为 logger (importance=0.9)");
  assert.equal(functions[1].name, "login", "第二个 function 应为 login (importance=0.7)");
  assert.equal(functions[2].name, "verifyToken", "第三个 function 应为 verifyToken (importance=0.6)");
});

test("附加测试：StaticSymbolGraph.getRiskHotspots 按 importance 降序排序", () => {
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // getRiskHotspots(5) 应返回全部 5 个符号，按 importance 降序
  const hotspots = graph.getRiskHotspots(5);
  assert.equal(hotspots.length, 5, "getRiskHotspots(5) 应返回 5 个符号");
  assert.equal(hotspots[0].name, "logger", "第一个应为 logger (importance=0.9)");
  assert.equal(hotspots[1].name, "UserService", "第二个应为 UserService (importance=0.8)");
  assert.equal(hotspots[2].name, "login", "第三个应为 login (importance=0.7)");
  assert.equal(hotspots[3].name, "verifyToken", "第四个应为 verifyToken (importance=0.6)");
  assert.equal(hotspots[4].name, "AuthModule", "第五个应为 AuthModule (importance=0.5)");

  // getRiskHotspots(3) 应返回前 3 个
  const top3 = graph.getRiskHotspots(3);
  assert.equal(top3.length, 3, "getRiskHotspots(3) 应返回 3 个符号");
  assert.equal(top3[0].name, "logger", "第一个应为 logger");
  assert.equal(top3[1].name, "UserService", "第二个应为 UserService");
  assert.equal(top3[2].name, "login", "第三个应为 login");
});

test("附加测试：StaticSymbolGraph.searchByQuery 关键词命中数排序", () => {
  const graph = new StaticSymbolGraph(TEST_GRAPH_DATA);

  // searchByQuery("login token", 10)
  // 分词：["login", "token"]
  // 命中分析（搜索文本 = name + summary + signature + filePath，转小写）：
  //   - UserService: signature 含 "login(email"（命中 login），signature 含 "AuthToken" 即 "authtoken"（命中 token）→ hitCount=2
  //   - login: name="login"（命中 login），summary 含 "token"（命中 token）→ hitCount=2
  //   - verifyToken: name="verifytoken"（命中 token），summary 含 "token"（命中 token）→ hitCount=1（去重后只计 1 次）
  //   - AuthModule: 无命中 → hitCount=0
  //   - logger: 无命中 → hitCount=0
  // 排序：hitCount 降序，同 hitCount 内 importance 降序
  //   - UserService (hitCount=2, importance=0.8)
  //   - login (hitCount=2, importance=0.7)
  //   - verifyToken (hitCount=1, importance=0.6)
  const results = graph.searchByQuery("login token", 10);
  assert.equal(results.length, 3, "searchByQuery('login token') 应返回 3 个结果（hitCount > 0）");
  assert.equal(results[0].name, "UserService", "第一个应为 UserService (hitCount=2, importance=0.8)");
  assert.equal(results[1].name, "login", "第二个应为 login (hitCount=2, importance=0.7)");
  assert.equal(results[2].name, "verifyToken", "第三个应为 verifyToken (hitCount=1, importance=0.6)");

  // searchByQuery("auth", 10)
  // 分词：["auth"]（length >= 2）
  // 命中分析（"auth" 是 "authtoken"、"authmodule"、"authenticate" 的子串）：
  //   - UserService: signature 含 "AuthToken" → "authtoken" 命中 "auth" → hitCount=1
  //   - login: signature 含 "AuthToken" → "authtoken" 命中 "auth" → hitCount=1
  //   - AuthModule: name="authmodule"(命中 auth), signature 含 "authenticate"(命中 auth) → hitCount=1（去重后 1 次）
  //   - verifyToken: 无 "auth" 命中 → hitCount=0
  //   - logger: 无 "auth" 命中 → hitCount=0
  // 排序：hitCount 降序（全部为 1），同 hitCount 内 importance 降序
  //   - UserService (hitCount=1, importance=0.8)
  //   - login (hitCount=1, importance=0.7)
  //   - AuthModule (hitCount=1, importance=0.5)
  const authResults = graph.searchByQuery("auth", 10);
  assert.equal(
    authResults.length,
    3,
    "searchByQuery('auth') 应返回 3 个结果（auth 是 authtoken/authmodule/authenticate 的子串）"
  );
  assert.equal(authResults[0].name, "UserService", "第一个应为 UserService (importance=0.8)");
  assert.equal(authResults[1].name, "login", "第二个应为 login (importance=0.7)");
  assert.equal(authResults[2].name, "AuthModule", "第三个应为 AuthModule (importance=0.5)");

  // searchByQuery("nonexistent", 10) 无匹配
  const noMatch = graph.searchByQuery("nonexistent", 10);
  assert.equal(noMatch.length, 0, "无匹配时应返回空数组");

  // 边界输入
  assert.equal(graph.searchByQuery("", 10).length, 0, "空 query 应返回空数组");
  assert.equal(graph.searchByQuery("test", 0).length, 0, "limit=0 应返回空数组");
});
