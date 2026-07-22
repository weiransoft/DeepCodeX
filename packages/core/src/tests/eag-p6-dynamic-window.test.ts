/**
 * EAG-P6 Phase 2 单元测试：DynamicWindowManager + CodeMapSnippetProvider
 *
 * 测试范围（15 个 TC）：
 * - TC-DW-001: CodeMapSnippetProvider DW-1 焦点符号直供（上限 3 片段，distance=0，confidence=HIGH）
 * - TC-DW-002: CodeMapSnippetProvider DW-1 空焦点列表返回空数组
 * - TC-DW-003: CodeMapSnippetProvider DW-1 多焦点去重（按 symbolId）
 * - TC-DW-004: CodeMapSnippetProvider DW-2 爆炸半径（distance=1 或 2，confidence 派生）
 * - TC-DW-005: CodeMapSnippetProvider DW-2 空影响根返回空数组
 * - TC-DW-006: CodeMapSnippetProvider DW-3 风险热点（上限 5 片段，distance=MAX_SAFE_INTEGER）
 * - TC-DW-007: CodeMapSnippetProvider DW-3 topN 截断到 5
 * - TC-DW-008: CodeMapSnippetProvider DW-4 语义检索（关键词匹配）
 * - TC-DW-009: CodeMapSnippetProvider 降级模式（DefaultSymbolGraphAdapter 返回空数组）
 * - TC-DW-010: DynamicWindowManager design 阶段（仅 DW-1 激活）
 * - TC-DW-011: DynamicWindowManager coding 阶段（DW-1 + DW-2 激活）
 * - TC-DW-012: DynamicWindowManager testing 阶段（DW-1 + DW-2 + DW-3 激活）
 * - TC-DW-013: DynamicWindowManager deploy 阶段（仅 DW-1 激活）
 * - TC-DW-014: DynamicWindowManager allocateTokenBudget 30%/70% 分配
 * - TC-DW-015: DynamicWindowManager 降级模式返回空结果（graphAvailability=false）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象与真实图谱数据
 * - BFS 测试使用真实 5 节点 5 边的环形图谱（验证双向遍历 + 循环检测）
 * - 静态图谱数据与 Phase 1 测试一致，便于对比与回归
 *
 * 测试图谱设计（5 节点 5 边，环形结构，与 Phase 1 测试一致）：
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
 * @module core/tests/eag-p6-dynamic-window
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// 导入待测试模块
import { CodeMapSnippetProvider } from "../v2/context/code-map-snippet-provider";
import { DynamicWindowManager } from "../v2/context/dynamic-window-manager";
import { DefaultSymbolGraphAdapter } from "../v2/context/default-symbol-graph-adapter";
import { StaticSymbolGraph } from "../v2/context/static-symbol-graph";
import { resetGraphStoreAvailabilityCache } from "../v2/context/symbol-graph-adapter";
import type { Confidence, EdgeRecord, StaticGraphData, SymbolRecord } from "../v2/context/symbol-graph-types";
import {
  CODEMAP_BUDGET_RATIO,
  CODEMAP_SNIPPET_TYPE,
  DEFAULT_EXPLOSION_RADIUS_DEPTH,
  DEFAULT_EXPLOSION_RADIUS_MAX_NODES,
  EMPTY_CODEMAP_SNIPPETS,
  EMPTY_DYNAMIC_WINDOW_RESULT,
  EMPTY_TOKEN_BUDGET_ALLOCATION,
  LOW_RELEVANCE_THRESHOLD,
  MAX_DW1_SYMBOL_SNIPPETS,
  MAX_DW3_RISK_SNIPPETS,
  OTHER_BUDGET_RATIO,
  type CodeMapSnippet,
  type DynamicWindowQuery,
  type DynamicWindowResult,
  type LoopPhase,
  type TokenBudgetAllocation,
} from "../v2/context/dynamic-window-types";

// ============================================================================
// 测试数据：5 节点 5 边的环形图谱（与 Phase 1 测试一致）
// ============================================================================

/**
 * 测试图谱节点列表（5 个符号，覆盖 class/function 两种 kind）
 *
 * importance 设计（用于验证 DW-3 风险热点排序）：
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
// 辅助函数：构造测试用的 CodeMapSnippetProvider + DynamicWindowManager
// ============================================================================

/**
 * 构造测试用的 CodeMapSnippetProvider（使用 StaticSymbolGraph 真实图谱）
 *
 * 关键设计：
 * - graphAvailability 函数返回 true（强制启用图谱，绕过 isGraphStoreAvailable 降级）
 * - SymbolGraphAdapter 使用 StaticSymbolGraph（真实降级实现，非 mock）
 *
 * @returns {CodeMapSnippetProvider} 测试用的 CodeMapSnippetProvider 实例
 */
function createTestProvider(): CodeMapSnippetProvider {
  const adapter = new StaticSymbolGraph(TEST_GRAPH_DATA);
  // graphAvailability 返回 true，绕过 isGraphStoreAvailable 降级
  // 这样可以测试 CodeMapSnippetProvider 的真实逻辑，而非降级路径
  return new CodeMapSnippetProvider(adapter, () => true);
}

/**
 * 构造测试用的 DynamicWindowManager（使用真实 CodeMapSnippetProvider）
 *
 * @returns {DynamicWindowManager} 测试用的 DynamicWindowManager 实例
 */
function createTestManager(): DynamicWindowManager {
  const provider = createTestProvider();
  // graphAvailability 返回 true，绕过 isGraphStoreAvailable 降级
  return new DynamicWindowManager(provider, () => true);
}

/**
 * 构造测试用的 DynamicWindowQuery
 *
 * @param phase Loop 阶段
 * @param focusPoints 焦点符号列表（默认 ["UserService"]）
 * @param impactRoots 影响根符号列表（默认 ["src/A.ts:UserService"]）
 * @param riskTopN 风险热点 Top-N（默认 5）
 * @param maxSnippets 最大片段数（默认 30）
 * @param role 角色（默认 "solo_coder"）
 * @returns 测试用的 DynamicWindowQuery
 */
function createTestQuery(
  phase: LoopPhase,
  focusPoints: ReadonlyArray<string> = ["UserService"],
  impactRoots: ReadonlyArray<string> = ["src/A.ts:UserService"],
  riskTopN: number = 5,
  maxSnippets: number = 30,
  role: string = "solo_coder"
): DynamicWindowQuery {
  return {
    focusPoints,
    impactRoots,
    riskTopN,
    maxSnippets,
    role,
    phase,
  };
}

// ============================================================================
// TC-DW-001: CodeMapSnippetProvider DW-1 焦点符号直供（上限 3 片段，distance=0，confidence=HIGH）
// ============================================================================

test("TC-DW-001: CodeMapSnippetProvider DW-1 焦点符号直供（上限 3 片段，distance=0，confidence=HIGH）", () => {
  const provider = createTestProvider();

  // ---------- 调用 DW-1：焦点符号直供 ----------
  // 传入 "UserService"，应匹配 src/A.ts:UserService
  const snippets = provider.getDirectRetainSnippets(["UserService"]);

  // ---------- 断言：返回 1 个片段 ----------
  assert.equal(snippets.length, 1, "DW-1 应返回 1 个匹配 UserService 的片段");

  // ---------- 断言：片段属性正确 ----------
  const snippet = snippets[0] as CodeMapSnippet;
  assert.equal(snippet.type, CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL, "type 应为 codemap_symbol");
  assert.equal(snippet.symbolId, "src/A.ts:UserService", "symbolId 应为 src/A.ts:UserService");
  assert.equal(snippet.name, "UserService", "name 应为 UserService");
  assert.equal(snippet.kind, "class", "kind 应为 class");
  assert.equal(snippet.filePath, "src/A.ts", "filePath 应为 src/A.ts");
  assert.equal(snippet.importance, 0.8, "importance 应为 0.8");
  assert.equal(snippet.distance, 0, "distance 应为 0（焦点符号本身）");
  assert.equal(snippet.confidence, "HIGH", "confidence 应为 HIGH（焦点符号必注入）");

  // ---------- 断言：片段已冻结 ----------
  assert.equal(Object.isFrozen(snippet), true, "CodeMapSnippet 应已冻结（Object.isFrozen=true）");
  assert.equal(Object.isFrozen(snippets), true, "snippets 数组应已冻结（Object.isFrozen=true）");
});

// ============================================================================
// TC-DW-002: CodeMapSnippetProvider DW-1 空焦点列表返回空数组
// ============================================================================

test("TC-DW-002: CodeMapSnippetProvider DW-1 空焦点列表返回空数组", () => {
  const provider = createTestProvider();

  // ---------- 空数组 ----------
  const emptyResult = provider.getDirectRetainSnippets([]);
  assert.equal(emptyResult.length, 0, "空 focusPoints 应返回空数组");
  assert.equal(emptyResult, EMPTY_CODEMAP_SNIPPETS, "空结果应为 EMPTY_CODEMAP_SNIPPETS 常量");

  // ---------- 不匹配的焦点符号 ----------
  const noMatchResult = provider.getDirectRetainSnippets(["NonExistentSymbol"]);
  assert.equal(noMatchResult.length, 0, "不匹配的 focusPoint 应返回空数组");

  // ---------- 空字符串 ----------
  const emptyStringResult = provider.getDirectRetainSnippets([""]);
  assert.equal(emptyStringResult.length, 0, "空字符串 focusPoint 应返回空数组");
});

// ============================================================================
// TC-DW-003: CodeMapSnippetProvider DW-1 多焦点去重（按 symbolId）
// ============================================================================

test("TC-DW-003: CodeMapSnippetProvider DW-1 多焦点去重（按 symbolId）", () => {
  const provider = createTestProvider();

  // ---------- 传入重复的焦点符号（同一符号匹配多次） ----------
  // "User" 会匹配 "UserService"（包含匹配）
  // "UserService" 会精确匹配 "UserService"
  // 两者匹配同一符号，应去重为 1 个片段
  const snippets = provider.getDirectRetainSnippets(["User", "UserService"]);

  assert.equal(snippets.length, 1, "重复匹配同一符号应去重为 1 个片段");
  assert.equal(snippets[0]?.symbolId, "src/A.ts:UserService", "去重后应保留 UserService");

  // ---------- 多个不同焦点符号 ----------
  // 传入 5 个不同的符号名，应截断到 MAX_DW1_SYMBOL_SNIPPETS=3 个
  const manySnippets = provider.getDirectRetainSnippets([
    "UserService",
    "login",
    "verifyToken",
    "AuthModule",
    "logger",
  ]);
  assert.equal(
    manySnippets.length,
    MAX_DW1_SYMBOL_SNIPPETS,
    `多焦点应截断到 MAX_DW1_SYMBOL_SNIPPETS=${MAX_DW1_SYMBOL_SNIPPETS} 个`
  );
});

// ============================================================================
// TC-DW-004: CodeMapSnippetProvider DW-2 爆炸半径（distance=1 或 2，confidence 派生）
// ============================================================================

test("TC-DW-004: CodeMapSnippetProvider DW-2 爆炸半径（distance=1 或 2，confidence 派生）", () => {
  const provider = createTestProvider();

  // ---------- 调用 DW-2：以 UserService 为根的爆炸半径 ----------
  // 图谱结构：UserService → login → verifyToken → AuthModule → logger → UserService（环）
  // maxDepth=2 时，从 UserService 出发：
  // - 1 跳：login（出边 e1）、logger（入边 e5）
  // - 2 跳：verifyToken（login → verifyToken，e2）、AuthModule（logger → ... 反向）
  //         UserService（环回到起点，已访问，跳过）
  const snippets = provider.getImpactSnippets(["src/A.ts:UserService"]);

  // ---------- 断言：返回片段数 > 0 ----------
  assert.ok(snippets.length > 0, "DW-2 应返回非空片段列表");
  assert.ok(
    snippets.length <= DEFAULT_EXPLOSION_RADIUS_MAX_NODES,
    `DW-2 片段数应 ≤ maxNodes=${DEFAULT_EXPLOSION_RADIUS_MAX_NODES}`
  );

  // ---------- 断言：所有片段 type=codemap_impact ----------
  for (const snippet of snippets) {
    assert.equal(snippet.type, CODEMAP_SNIPPET_TYPE.CODEMAP_IMPACT, "DW-2 片段 type 应为 codemap_impact");
    assert.equal(Object.isFrozen(snippet), true, "DW-2 片段应已冻结");
    // distance 应为 1 或 2（DEFAULT_EXPLOSION_RADIUS_DEPTH=2）
    assert.ok(
      snippet.distance === 1 || snippet.distance === 2,
      `DW-2 片段 distance 应为 1 或 2，实际为 ${snippet.distance}`
    );
    // confidence 应为 HIGH/MEDIUM/LOW 之一
    assert.ok(
      snippet.confidence === "HIGH" || snippet.confidence === "MEDIUM" || snippet.confidence === "LOW",
      `DW-2 片段 confidence 应为 HIGH/MEDIUM/LOW，实际为 ${snippet.confidence}`
    );
  }

  // ---------- 断言：不包含根符号本身 ----------
  const rootSymbolIds = snippets.map((s) => s.symbolId);
  assert.ok(!rootSymbolIds.includes("src/A.ts:UserService"), "DW-2 片段不应包含根符号 UserService 本身");

  // ---------- 断言：1 跳邻居 login 应在结果中 ----------
  // e1: UserService → login (HIGH)
  assert.ok(rootSymbolIds.includes("src/B.ts:login"), "DW-2 应包含 1 跳邻居 login");

  // ---------- 断言：login 的 distance=1，confidence=HIGH（来自 e1 边） ----------
  const loginSnippet = snippets.find((s) => s.symbolId === "src/B.ts:login") as CodeMapSnippet;
  assert.equal(loginSnippet.distance, 1, "login 的 distance 应为 1（直接边 e1）");
  assert.equal(loginSnippet.confidence, "HIGH", "login 的 confidence 应为 HIGH（e1 边 confidence=HIGH）");
});

// ============================================================================
// TC-DW-005: CodeMapSnippetProvider DW-2 空影响根返回空数组
// ============================================================================

test("TC-DW-005: CodeMapSnippetProvider DW-2 空影响根返回空数组", () => {
  const provider = createTestProvider();

  // ---------- 空数组 ----------
  const emptyResult = provider.getImpactSnippets([]);
  assert.equal(emptyResult.length, 0, "空 impactRoots 应返回空数组");
  assert.equal(emptyResult, EMPTY_CODEMAP_SNIPPETS, "空结果应为 EMPTY_CODEMAP_SNIPPETS 常量");

  // ---------- 不存在的影响根 ----------
  const noMatchResult = provider.getImpactSnippets(["src/NonExistent.ts:Foo"]);
  assert.equal(noMatchResult.length, 0, "不存在的 impactRoot 应返回空数组");

  // ---------- 空字符串 ----------
  const emptyStringResult = provider.getImpactSnippets([""]);
  assert.equal(emptyStringResult.length, 0, "空字符串 impactRoot 应返回空数组");
});

// ============================================================================
// TC-DW-006: CodeMapSnippetProvider DW-3 风险热点（上限 5 片段，distance=MAX_SAFE_INTEGER）
// ============================================================================

test("TC-DW-006: CodeMapSnippetProvider DW-3 风险热点（上限 5 片段，distance=MAX_SAFE_INTEGER）", () => {
  const provider = createTestProvider();

  // ---------- 调用 DW-3：风险热点 Top-5 ----------
  // 图谱 importance 排序：logger(0.9) > UserService(0.8) > login(0.7) > verifyToken(0.6) > AuthModule(0.5)
  const snippets = provider.getRiskHotspotSnippets(5);

  // ---------- 断言：返回 5 个片段（图谱共 5 个符号） ----------
  assert.equal(snippets.length, 5, "DW-3 应返回 5 个片段（图谱共 5 个符号）");

  // ---------- 断言：按 importance 降序排序 ----------
  assert.equal(snippets[0]?.symbolId, "src/E.ts:logger", "第 1 个应为 logger（importance=0.9）");
  assert.equal(snippets[1]?.symbolId, "src/A.ts:UserService", "第 2 个应为 UserService（importance=0.8）");
  assert.equal(snippets[2]?.symbolId, "src/B.ts:login", "第 3 个应为 login（importance=0.7）");
  assert.equal(snippets[3]?.symbolId, "src/C.ts:verifyToken", "第 4 个应为 verifyToken（importance=0.6）");
  assert.equal(snippets[4]?.symbolId, "src/D.ts:AuthModule", "第 5 个应为 AuthModule（importance=0.5）");

  // ---------- 断言：片段属性正确 ----------
  for (const snippet of snippets) {
    assert.equal(snippet.type, CODEMAP_SNIPPET_TYPE.CODEMAP_RISK, "DW-3 片段 type 应为 codemap_risk");
    assert.equal(snippet.distance, Number.MAX_SAFE_INTEGER, "DW-3 片段 distance 应为 Number.MAX_SAFE_INTEGER");
    assert.equal(snippet.confidence, "HIGH", "DW-3 片段 confidence 应为 HIGH");
    assert.equal(Object.isFrozen(snippet), true, "DW-3 片段应已冻结");
  }
});

// ============================================================================
// TC-DW-007: CodeMapSnippetProvider DW-3 topN 截断到 5
// ============================================================================

test("TC-DW-007: CodeMapSnippetProvider DW-3 topN 截断到 5", () => {
  const provider = createTestProvider();

  // ---------- topN=10（超过 MAX_DW3_RISK_SNIPPETS=5），应截断到 5 ----------
  const overflowResult = provider.getRiskHotspotSnippets(10);
  assert.equal(
    overflowResult.length,
    MAX_DW3_RISK_SNIPPETS,
    `topN=10 应截断到 MAX_DW3_RISK_SNIPPETS=${MAX_DW3_RISK_SNIPPETS}`
  );

  // ---------- topN=3（小于 MAX_DW3_RISK_SNIPPETS=5），应返回 3 个 ----------
  const underflowResult = provider.getRiskHotspotSnippets(3);
  assert.equal(underflowResult.length, 3, "topN=3 应返回 3 个片段");

  // ---------- topN 缺省（undefined），应使用默认值 5 ----------
  const defaultResult = provider.getRiskHotspotSnippets();
  assert.equal(
    defaultResult.length,
    MAX_DW3_RISK_SNIPPETS,
    `topN 缺省应使用默认值 MAX_DW3_RISK_SNIPPETS=${MAX_DW3_RISK_SNIPPETS}`
  );

  // ---------- topN=0，应返回空数组 ----------
  const zeroResult = provider.getRiskHotspotSnippets(0);
  assert.equal(zeroResult.length, 0, "topN=0 应返回空数组");

  // ---------- topN=-5，应返回空数组 ----------
  const negativeResult = provider.getRiskHotspotSnippets(-5);
  assert.equal(negativeResult.length, 0, "topN=-5 应返回空数组");
});

// ============================================================================
// TC-DW-008: CodeMapSnippetProvider DW-4 语义检索（关键词匹配）
// ============================================================================

test("TC-DW-008: CodeMapSnippetProvider DW-4 语义检索（关键词匹配）", () => {
  const provider = createTestProvider();

  // ---------- 调用 DW-4：语义检索 "login token" ----------
  // 应匹配含 "login" 或 "token" 关键词的符号：
  // - login（name 含 "login"，summary 含 "token"）
  // - verifyToken（name 含 "token"，summary 含 "token"）
  // - UserService（signature 含 "login"，summary 含 "登录"）
  const snippets = provider.searchByQuery("login token", 10);

  // ---------- 断言：返回片段数 > 0 ----------
  assert.ok(snippets.length > 0, "DW-4 应返回非空片段列表");
  assert.ok(snippets.length <= 10, "DW-4 片段数应 ≤ limit=10");

  // ---------- 断言：所有片段 type=codemap_symbol（DW-4 复用 DW-1 的 type） ----------
  for (const snippet of snippets) {
    assert.equal(
      snippet.type,
      CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL,
      "DW-4 片段 type 应为 codemap_symbol（复用 DW-1 的 type）"
    );
    assert.equal(snippet.distance, Number.MAX_SAFE_INTEGER, "DW-4 片段 distance 应为 Number.MAX_SAFE_INTEGER");
    assert.equal(snippet.confidence, "HIGH", "DW-4 片段 confidence 应为 HIGH");
    assert.equal(Object.isFrozen(snippet), true, "DW-4 片段应已冻结");
  }

  // ---------- 断言：login 应在结果中（命中 "login" 关键词） ----------
  const symbolIds = snippets.map((s) => s.symbolId);
  assert.ok(symbolIds.includes("src/B.ts:login"), "DW-4 应包含 login（命中 'login' 关键词）");

  // ---------- 边界：空 query 返回空数组 ----------
  const emptyQueryResult = provider.searchByQuery("", 10);
  assert.equal(emptyQueryResult.length, 0, "空 query 应返回空数组");

  // ---------- 边界：limit=0 返回空数组 ----------
  const zeroLimitResult = provider.searchByQuery("login", 0);
  assert.equal(zeroLimitResult.length, 0, "limit=0 应返回空数组");
});

// ============================================================================
// TC-DW-009: CodeMapSnippetProvider 降级模式（DefaultSymbolGraphAdapter 返回空数组）
// ============================================================================

test("TC-DW-009: CodeMapSnippetProvider 降级模式（DefaultSymbolGraphAdapter 返回空数组）", () => {
  // ---------- 使用 DefaultSymbolGraphAdapter（降级实现） ----------
  // graphAvailability 返回 true（绕过环境降级），但 adapter.isAvailable() 返回 false
  // 双层降级：graphAvailability()=true && adapter.isAvailable()=false → 整体降级
  const adapter = new DefaultSymbolGraphAdapter();
  const provider = new CodeMapSnippetProvider(adapter, () => true);

  // ---------- 断言：DW-1 返回空数组 ----------
  const dw1Result = provider.getDirectRetainSnippets(["UserService"]);
  assert.equal(dw1Result.length, 0, "降级模式 DW-1 应返回空数组");
  assert.equal(dw1Result, EMPTY_CODEMAP_SNIPPETS, "降级模式 DW-1 应返回 EMPTY_CODEMAP_SNIPPETS 常量");

  // ---------- 断言：DW-2 返回空数组 ----------
  const dw2Result = provider.getImpactSnippets(["src/A.ts:UserService"]);
  assert.equal(dw2Result.length, 0, "降级模式 DW-2 应返回空数组");
  assert.equal(dw2Result, EMPTY_CODEMAP_SNIPPETS, "降级模式 DW-2 应返回 EMPTY_CODEMAP_SNIPPETS 常量");

  // ---------- 断言：DW-3 返回空数组 ----------
  const dw3Result = provider.getRiskHotspotSnippets(5);
  assert.equal(dw3Result.length, 0, "降级模式 DW-3 应返回空数组");
  assert.equal(dw3Result, EMPTY_CODEMAP_SNIPPETS, "降级模式 DW-3 应返回 EMPTY_CODEMAP_SNIPPETS 常量");

  // ---------- 断言：DW-4 返回空数组 ----------
  const dw4Result = provider.searchByQuery("login", 10);
  assert.equal(dw4Result.length, 0, "降级模式 DW-4 应返回空数组");
  assert.equal(dw4Result, EMPTY_CODEMAP_SNIPPETS, "降级模式 DW-4 应返回 EMPTY_CODEMAP_SNIPPETS 常量");

  // ---------- 测试 graphAvailability()=false 的环境降级 ----------
  // 即使 adapter 是 StaticSymbolGraph（isAvailable=true），
  // graphAvailability()=false 也会触发降级
  const realAdapter = new StaticSymbolGraph(TEST_GRAPH_DATA);
  const envDegradedProvider = new CodeMapSnippetProvider(realAdapter, () => false);

  const envDw1Result = envDegradedProvider.getDirectRetainSnippets(["UserService"]);
  assert.equal(envDw1Result.length, 0, "graphAvailability()=false 时 DW-1 应返回空数组");
});

// ============================================================================
// TC-DW-010: DynamicWindowManager design 阶段（仅 DW-1 激活）
// ============================================================================

test("TC-DW-010: DynamicWindowManager design 阶段（仅 DW-1 激活）", () => {
  const manager = createTestManager();
  const query = createTestQuery("design");

  // ---------- 调用 computeWindow ----------
  const result = manager.computeWindow(query);

  // ---------- 断言：返回 DynamicWindowResult ----------
  assert.ok(result !== null && result !== undefined, "computeWindow 应返回非 null 结果");
  assert.equal(Object.isFrozen(result), true, "DynamicWindowResult 应已冻结");

  // ---------- 断言：design 阶段仅激活 DW-1 ----------
  // DW-1 应返回 1 个片段（UserService）
  // DW-2 不激活（design 阶段）
  // DW-3 不激活（design 阶段）
  assert.ok(result.snippets.length >= 1, "design 阶段应至少返回 1 个 DW-1 片段");

  // ---------- 断言：所有片段均为 codemap_symbol（DW-1） ----------
  for (const snippet of result.snippets) {
    assert.equal(
      snippet.type,
      CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL,
      "design 阶段所有片段应为 codemap_symbol（仅 DW-1 激活）"
    );
  }

  // ---------- 断言：source 为 "dw1"（仅 DW-1 激活） ----------
  assert.equal(result.source, "dw1", "design 阶段 source 应为 dw1");

  // ---------- 断言：totalTokens > 0 ----------
  assert.ok(result.totalTokens > 0, "design 阶段 totalTokens 应 > 0");

  // ---------- 断言：droppedLowRelevance 为 0（DW-1 焦点符号评分高，不会丢弃） ----------
  assert.equal(result.droppedLowRelevance, 0, "design 阶段 droppedLowRelevance 应为 0（DW-1 焦点符号评分高）");
});

// ============================================================================
// TC-DW-011: DynamicWindowManager coding 阶段（DW-1 + DW-2 激活）
// ============================================================================

test("TC-DW-011: DynamicWindowManager coding 阶段（DW-1 + DW-2 激活）", () => {
  const manager = createTestManager();
  const query = createTestQuery("coding");

  // ---------- 调用 computeWindow ----------
  const result = manager.computeWindow(query);

  // ---------- 断言：coding 阶段激活 DW-1 + DW-2 ----------
  // DW-1 应返回 1 个片段（UserService）
  // DW-2 应返回多个片段（login, logger, verifyToken, AuthModule）
  // DW-3 不激活（coding 阶段）
  assert.ok(result.snippets.length >= 2, "coding 阶段应至少返回 2 个片段（DW-1 + DW-2）");

  // ---------- 断言：片段类型为 codemap_symbol 或 codemap_impact ----------
  const types = new Set(result.snippets.map((s) => s.type));
  assert.ok(types.has(CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL), "coding 阶段应包含 codemap_symbol 片段（DW-1）");
  assert.ok(types.has(CODEMAP_SNIPPET_TYPE.CODEMAP_IMPACT), "coding 阶段应包含 codemap_impact 片段（DW-2）");
  assert.ok(!types.has(CODEMAP_SNIPPET_TYPE.CODEMAP_RISK), "coding 阶段不应包含 codemap_risk 片段（DW-3 不激活）");

  // ---------- 断言：source 为 "mixed"（DW-1 + DW-2 混合） ----------
  assert.equal(result.source, "mixed", "coding 阶段 source 应为 mixed（DW-1 + DW-2 混合）");

  // ---------- 断言：DW-1 焦点符号 UserService 在结果中 ----------
  const symbolIds = result.snippets.map((s) => s.symbolId);
  assert.ok(symbolIds.includes("src/A.ts:UserService"), "coding 阶段应包含焦点符号 UserService（DW-1 必注入）");

  // ---------- 断言：DW-2 影响面符号 login 在结果中 ----------
  assert.ok(symbolIds.includes("src/B.ts:login"), "coding 阶段应包含影响面符号 login（DW-2 1 跳邻居）");
});

// ============================================================================
// TC-DW-012: DynamicWindowManager testing 阶段（DW-1 + DW-2 + DW-3 激活）
// ============================================================================

test("TC-DW-012: DynamicWindowManager testing 阶段（DW-1 + DW-2 + DW-3 激活）", () => {
  const manager = createTestManager();
  const query = createTestQuery("testing");

  // ---------- 调用 computeWindow ----------
  const result = manager.computeWindow(query);

  // ---------- 断言：testing 阶段激活 DW-1 + DW-2 + DW-3 ----------
  // DW-1 应返回 1 个片段（UserService）
  // DW-2 应返回多个片段（login, logger, verifyToken, AuthModule）
  // DW-3 应返回 5 个片段（全部符号，按 importance 降序）
  assert.ok(result.snippets.length >= 3, "testing 阶段应至少返回 3 个片段（DW-1 + DW-2 + DW-3）");

  // ---------- 断言：片段类型包含 codemap_symbol / codemap_impact / codemap_risk ----------
  const types = new Set(result.snippets.map((s) => s.type));
  assert.ok(types.has(CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL), "testing 阶段应包含 codemap_symbol 片段（DW-1）");
  assert.ok(types.has(CODEMAP_SNIPPET_TYPE.CODEMAP_IMPACT), "testing 阶段应包含 codemap_impact 片段（DW-2）");
  assert.ok(types.has(CODEMAP_SNIPPET_TYPE.CODEMAP_RISK), "testing 阶段应包含 codemap_risk 片段（DW-3）");

  // ---------- 断言：source 为 "mixed"（DW-1 + DW-2 + DW-3 混合） ----------
  assert.equal(result.source, "mixed", "testing 阶段 source 应为 mixed（DW-1 + DW-2 + DW-3 混合）");

  // ---------- 断言：DW-3 风险热点 logger 在结果中（importance=0.9 最高） ----------
  const symbolIds = result.snippets.map((s) => s.symbolId);
  assert.ok(symbolIds.includes("src/E.ts:logger"), "testing 阶段应包含风险热点 logger（DW-3 importance=0.9 最高）");

  // ---------- 断言：DW-3 片段 distance=MAX_SAFE_INTEGER ----------
  const riskSnippets = result.snippets.filter((s) => s.type === CODEMAP_SNIPPET_TYPE.CODEMAP_RISK);
  for (const snippet of riskSnippets) {
    assert.equal(snippet.distance, Number.MAX_SAFE_INTEGER, "DW-3 片段 distance 应为 Number.MAX_SAFE_INTEGER");
  }
});

// ============================================================================
// TC-DW-013: DynamicWindowManager deploy 阶段（仅 DW-1 激活）
// ============================================================================

test("TC-DW-013: DynamicWindowManager deploy 阶段（仅 DW-1 激活）", () => {
  const manager = createTestManager();
  const query = createTestQuery("deploy");

  // ---------- 调用 computeWindow ----------
  const result = manager.computeWindow(query);

  // ---------- 断言：deploy 阶段仅激活 DW-1 ----------
  // DW-1 应返回 1 个片段（UserService）
  // DW-2 不激活（deploy 阶段）
  // DW-3 不激活（deploy 阶段）
  assert.ok(result.snippets.length >= 1, "deploy 阶段应至少返回 1 个 DW-1 片段");

  // ---------- 断言：所有片段均为 codemap_symbol（DW-1） ----------
  for (const snippet of result.snippets) {
    assert.equal(
      snippet.type,
      CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL,
      "deploy 阶段所有片段应为 codemap_symbol（仅 DW-1 激活）"
    );
  }

  // ---------- 断言：source 为 "dw1"（仅 DW-1 激活） ----------
  assert.equal(result.source, "dw1", "deploy 阶段 source 应为 dw1");

  // ---------- 断言：droppedLowRelevance 为 0 ----------
  assert.equal(result.droppedLowRelevance, 0, "deploy 阶段 droppedLowRelevance 应为 0");
});

// ============================================================================
// TC-DW-014: DynamicWindowManager allocateTokenBudget 30%/70% 分配
// ============================================================================

test("TC-DW-014: DynamicWindowManager allocateTokenBudget 30%/70% 分配", () => {
  const manager = createTestManager();

  // ---------- 测试 1：totalBudget=10000 ----------
  const allocation1 = manager.allocateTokenBudget(10000);
  assert.equal(Object.isFrozen(allocation1), true, "TokenBudgetAllocation 应已冻结");
  // codemapBudget = 10000 * 0.3 = 3000
  assert.equal(
    allocation1.codemapBudget,
    3000,
    `totalBudget=10000 时 codemapBudget 应为 3000（${CODEMAP_BUDGET_RATIO * 100}%）`
  );
  // otherBudget = 10000 - 3000 = 7000
  assert.equal(
    allocation1.otherBudget,
    7000,
    `totalBudget=10000 时 otherBudget 应为 7000（${OTHER_BUDGET_RATIO * 100}%）`
  );
  // 默认 codemapUsed / otherUsed 为 0
  assert.equal(allocation1.codemapUsed, 0, "默认 codemapUsed 应为 0");
  assert.equal(allocation1.otherUsed, 0, "默认 otherUsed 应为 0");

  // ---------- 测试 2：totalBudget=10000 + codemapUsed=2500 + otherUsed=6000 ----------
  const allocation2 = manager.allocateTokenBudget(10000, 2500, 6000);
  assert.equal(allocation2.codemapBudget, 3000, "codemapBudget 应为 3000");
  assert.equal(allocation2.otherBudget, 7000, "otherBudget 应为 7000");
  assert.equal(allocation2.codemapUsed, 2500, "codemapUsed 应为 2500");
  assert.equal(allocation2.otherUsed, 6000, "otherUsed 应为 6000");

  // ---------- 测试 3：codemapUsed 超过 codemapBudget，应截断 ----------
  const allocation3 = manager.allocateTokenBudget(10000, 5000, 6000);
  assert.equal(allocation3.codemapUsed, 3000, "codemapUsed 超过 codemapBudget 时应截断到 3000");

  // ---------- 测试 4：otherUsed 超过 otherBudget，应截断 ----------
  const allocation4 = manager.allocateTokenBudget(10000, 2000, 9000);
  assert.equal(allocation4.otherUsed, 7000, "otherUsed 超过 otherBudget 时应截断到 7000");

  // ---------- 测试 5：totalBudget=0，应返回空分配 ----------
  const allocation5 = manager.allocateTokenBudget(0);
  assert.equal(allocation5, EMPTY_TOKEN_BUDGET_ALLOCATION, "totalBudget=0 应返回 EMPTY_TOKEN_BUDGET_ALLOCATION");

  // ---------- 测试 6：totalBudget=-100，应返回空分配 ----------
  const allocation6 = manager.allocateTokenBudget(-100);
  assert.equal(allocation6, EMPTY_TOKEN_BUDGET_ALLOCATION, "totalBudget=-100 应返回 EMPTY_TOKEN_BUDGET_ALLOCATION");

  // ---------- 测试 7：负数 codemapUsed / otherUsed 应规范化为 0 ----------
  const allocation7 = manager.allocateTokenBudget(10000, -100, -200);
  assert.equal(allocation7.codemapUsed, 0, "负数 codemapUsed 应规范化为 0");
  assert.equal(allocation7.otherUsed, 0, "负数 otherUsed 应规范化为 0");
});

// ============================================================================
// TC-DW-015: DynamicWindowManager 降级模式返回空结果（graphAvailability=false）
// ============================================================================

test("TC-DW-015: DynamicWindowManager 降级模式返回空结果（graphAvailability=false）", () => {
  // ---------- 构造降级模式的 DynamicWindowManager ----------
  // graphAvailability 返回 false，触发降级
  const provider = createTestProvider();
  const manager = new DynamicWindowManager(provider, () => false);

  // ---------- 调用 computeWindow ----------
  const query = createTestQuery("coding");
  const result = manager.computeWindow(query);

  // ---------- 断言：返回 EMPTY_DYNAMIC_WINDOW_RESULT ----------
  assert.equal(
    result,
    EMPTY_DYNAMIC_WINDOW_RESULT,
    "graphAvailability()=false 时应返回 EMPTY_DYNAMIC_WINDOW_RESULT 常量"
  );

  // ---------- 断言：空结果属性正确 ----------
  assert.equal(result.snippets.length, 0, "降级模式 snippets 应为空数组");
  assert.equal(result.totalTokens, 0, "降级模式 totalTokens 应为 0");
  assert.equal(result.source, "dw1", "降级模式 source 应为 dw1（默认值）");
  assert.equal(result.droppedLowRelevance, 0, "降级模式 droppedLowRelevance 应为 0");

  // ---------- 测试：query 为 null/undefined 时返回空结果 ----------
  const manager2 = createTestManager();
  const nullResult = manager2.computeWindow(null as unknown as DynamicWindowQuery);
  assert.equal(nullResult, EMPTY_DYNAMIC_WINDOW_RESULT, "query=null 应返回 EMPTY_DYNAMIC_WINDOW_RESULT");

  // ---------- 测试：maxSnippets=0 时返回空结果 ----------
  const query2: DynamicWindowQuery = {
    focusPoints: ["UserService"],
    impactRoots: ["src/A.ts:UserService"],
    riskTopN: 5,
    maxSnippets: 0,
    role: "solo_coder",
    phase: "coding",
  };
  const zeroMaxResult = manager2.computeWindow(query2);
  assert.equal(zeroMaxResult, EMPTY_DYNAMIC_WINDOW_RESULT, "maxSnippets=0 应返回 EMPTY_DYNAMIC_WINDOW_RESULT");

  // ---------- 测试：maxSnippets=-1 时返回空结果 ----------
  const query3: DynamicWindowQuery = {
    focusPoints: ["UserService"],
    impactRoots: ["src/A.ts:UserService"],
    riskTopN: 5,
    maxSnippets: -1,
    role: "solo_coder",
    phase: "coding",
  };
  const negativeMaxResult = manager2.computeWindow(query3);
  assert.equal(negativeMaxResult, EMPTY_DYNAMIC_WINDOW_RESULT, "maxSnippets=-1 应返回 EMPTY_DYNAMIC_WINDOW_RESULT");

  // ---------- 测试：环境变量触发的真实降级（DCX_TEST_DISABLE_BETTER_SQLITE3=1） ----------
  // 设置环境变量，isGraphStoreAvailable() 返回 false
  // 注意：此处测试真实的 isGraphStoreAvailable 降级路径，不是 mock
  const originalEnv = process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;
  try {
    process.env.DCX_TEST_DISABLE_BETTER_SQLITE3 = "1";
    resetGraphStoreAvailabilityCache();

    // 使用真实的 isGraphStoreAvailable（不传 graphAvailability 参数）
    const realManager = new DynamicWindowManager(provider);
    const realResult = realManager.computeWindow(createTestQuery("coding"));

    assert.equal(realResult.snippets.length, 0, "DCX_TEST_DISABLE_BETTER_SQLITE3=1 时 snippets 应为空（真实降级）");
    assert.equal(realResult.totalTokens, 0, "DCX_TEST_DISABLE_BETTER_SQLITE3=1 时 totalTokens 应为 0（真实降级）");
  } finally {
    // 清理环境变量
    if (originalEnv === undefined) {
      delete process.env.DCX_TEST_DISABLE_BETTER_SQLITE3;
    } else {
      process.env.DCX_TEST_DISABLE_BETTER_SQLITE3 = originalEnv;
    }
    resetGraphStoreAvailabilityCache();
  }
});
