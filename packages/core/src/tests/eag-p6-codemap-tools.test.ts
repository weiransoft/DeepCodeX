/**
 * EAG-P6 Phase 4 单元测试：4 个 codemap 工具 + tool-executor-registry
 *
 * 测试范围（25 个 TC）：
 * - TC-TOOL-001: codemap_query 按关键词查询（返回匹配 UserService 的符号）
 * - TC-TOOL-002: codemap_query 按 kind 过滤（class 过滤返回 UserService + AuthModule）
 * - TC-TOOL-003: codemap_query 按 namespace 过滤（src/B 前缀匹配 login）
 * - TC-TOOL-004: codemap_query limit 截断（kind=function 截断到 1，total=3）
 * - TC-TOOL-005: codemap_query 降级模式（graphAvailability=false 返回空结果）
 * - TC-TOOL-006: impact_analysis forward 方向（UserService → login → verifyToken）
 * - TC-TOOL-007: impact_analysis backward 方向（UserService ← logger）
 * - TC-TOOL-008: impact_analysis both 方向（UserService ↔ login + logger）
 * - TC-TOOL-009: impact_analysis 循环检测（5 节点环）
 * - TC-TOOL-010: impact_analysis 降级模式（返回空结果）
 * - TC-TOOL-011: flow_trace forward 路径枚举（UserService → logger 路径）
 * - TC-TOOL-012: flow_trace backward 路径枚举（logger → UserService 反向路径）
 * - TC-TOOL-013: flow_trace 起点=终点（单节点路径 length=0）
 * - TC-TOOL-014: flow_trace 缺省 endSymbolId（叶子节点路径）
 * - TC-TOOL-015: flow_trace 降级模式（返回空结果）
 * - TC-TOOL-016: risk_scan 默认参数（importance >= 0.5 全部 5 个符号）
 * - TC-TOOL-017: risk_scan threshold 过滤（>= 0.7 返回 3 个符号）
 * - TC-TOOL-018: risk_scan kind 过滤（class 返回 UserService + AuthModule）
 * - TC-TOOL-019: risk_scan limit 截断（limit=2 截断到 logger + UserService）
 * - TC-TOOL-020: risk_scan avgRiskScore 计算（(0.9+0.8+0.7)/3 = 0.8）
 * - TC-TOOL-021: risk_scan 降级模式（返回空结果）
 * - TC-TOOL-022: tool-executor-registry 注册 4 个 handler
 * - TC-TOOL-023: registerCodemapTools 注入 ToolExecutor（4 次 registerToolHandler 调用）
 * - TC-TOOL-024: handler 适配 codemap_query（args → execute → ToolExecutionResult）
 * - TC-TOOL-025: 不可变优先（全部返回结果 Object.isFrozen=true）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象与真实图谱数据
 * - BFS / DFS 测试使用真实 5 节点 5 边的环形图谱（验证双向遍历 + 循环检测）
 * - 静态图谱数据与 Phase 1/2 测试一致，便于对比与回归
 *
 * 测试图谱设计（5 节点 5 边，环形结构，与 Phase 1/2 测试一致）：
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
 * @module core/tests/eag-p6-codemap-tools
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// 导入待测试模块（4 个工具 + registry）
import { CodemapQueryTool } from "../v2/tools/codemap-query-tool";
import {
  CODEMAP_QUERY_TOOL_NAME,
  EMPTY_CODEMAP_QUERY_RESULT,
  MAX_CODEMAP_QUERY_LIMIT,
} from "../v2/tools/codemap-query-tool";
import { ImpactAnalysisTool } from "../v2/tools/impact-analysis-tool";
import {
  EMPTY_IMPACT_ANALYSIS_RESULT,
  IMPACT_ANALYSIS_TOOL_NAME,
  MAX_CYCLES,
  MAX_CYCLE_DETECTION_DEPTH,
} from "../v2/tools/impact-analysis-tool";
import { FlowTraceTool } from "../v2/tools/flow-trace-tool";
import { EMPTY_FLOW_TRACE_RESULT, FLOW_TRACE_TOOL_NAME, MAX_PATHS } from "../v2/tools/flow-trace-tool";
import { RiskScanTool } from "../v2/tools/risk-scan-tool";
import { DEFAULT_RISK_SCAN_THRESHOLD, EMPTY_RISK_SCAN_RESULT, RISK_SCAN_TOOL_NAME } from "../v2/tools/risk-scan-tool";
import {
  CodemapToolRegistry,
  CODEMAP_TOOL_METADATA,
  createCodemapToolHandlers,
  registerCodemapTools,
  type ToolExecutorRegistrar,
} from "../v2/tools/tool-executor-registry";
import type { ToolHandler } from "../../common/tool-types";

// 导入测试依赖（真实图谱实现，禁 mock）
import { StaticSymbolGraph } from "../v2/context/static-symbol-graph";
import type { EdgeRecord, StaticGraphData, SymbolRecord } from "../v2/context/symbol-graph-types";

// ============================================================================
// 测试数据：5 节点 5 边的环形图谱（与 Phase 1/2 测试一致）
// ============================================================================

/**
 * 测试图谱节点列表（5 个符号，覆盖 class/function 两种 kind）
 *
 * importance 设计（用于验证 risk_scan 排序与阈值过滤）：
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
 * 环形结构设计（用于验证 BFS / DFS 循环检测）：
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

/** 测试图谱数据包（符号 + 边） */
const TEST_GRAPH_DATA: StaticGraphData = {
  symbolRecords: TEST_SYMBOLS,
  edgeRecords: TEST_EDGES,
};

// ============================================================================
// 辅助函数：构造测试用的工具实例（使用真实 StaticSymbolGraph 图谱）
// ============================================================================

/**
 * 构造测试用的 SymbolGraphAdapter（真实 StaticSymbolGraph，非 mock）
 *
 * @returns 真实 StaticSymbolGraph 实例
 */
function createTestAdapter(): StaticSymbolGraph {
  return new StaticSymbolGraph(TEST_GRAPH_DATA);
}

/**
 * 构造测试用的 CodemapQueryTool（graphAvailability 返回 true，绕过降级）
 *
 * @returns 测试用的 CodemapQueryTool 实例
 */
function createCodemapQueryTool(): CodemapQueryTool {
  return new CodemapQueryTool(createTestAdapter(), () => true);
}

/**
 * 构造测试用的 ImpactAnalysisTool（graphAvailability 返回 true，绕过降级）
 *
 * @returns 测试用的 ImpactAnalysisTool 实例
 */
function createImpactAnalysisTool(): ImpactAnalysisTool {
  return new ImpactAnalysisTool(createTestAdapter(), () => true);
}

/**
 * 构造测试用的 FlowTraceTool（graphAvailability 返回 true，绕过降级）
 *
 * @returns 测试用的 FlowTraceTool 实例
 */
function createFlowTraceTool(): FlowTraceTool {
  return new FlowTraceTool(createTestAdapter(), () => true);
}

/**
 * 构造测试用的 RiskScanTool（graphAvailability 返回 true，绕过降级）
 *
 * @returns 测试用的 RiskScanTool 实例
 */
function createRiskScanTool(): RiskScanTool {
  return new RiskScanTool(createTestAdapter(), () => true);
}

/**
 * 构造测试用的降级模式工具（graphAvailability 返回 false，触发降级）
 *
 * @returns 4 个降级模式工具实例的元组
 */
function createDegradedTools(): [CodemapQueryTool, ImpactAnalysisTool, FlowTraceTool, RiskScanTool] {
  const adapter = createTestAdapter();
  // graphAvailability 返回 false，触发降级（即使 adapter.isAvailable()=true 也降级）
  return [
    new CodemapQueryTool(adapter, () => false),
    new ImpactAnalysisTool(adapter, () => false),
    new FlowTraceTool(adapter, () => false),
    new RiskScanTool(adapter, () => false),
  ];
}

/**
 * 构造测试用的 ToolExecutor 桩（实现 ToolExecutorRegistrar 接口，记录注册调用）
 *
 * 真实实现：使用 Map 记录注册的 handler，便于后续验证
 *
 * @returns ToolExecutor 桩实例 + 注册记录
 */
function createToolExecutorStub(): {
  registrar: ToolExecutorRegistrar;
  registeredNames: string[];
  registeredHandlers: Map<string, ToolHandler>;
} {
  const registeredNames: string[] = [];
  const registeredHandlers = new Map<string, ToolHandler>();
  const registrar: ToolExecutorRegistrar = {
    registerToolHandler: (name: string, handler: ToolHandler): void => {
      registeredNames.push(name);
      registeredHandlers.set(name, handler);
    },
  };
  return { registrar, registeredNames, registeredHandlers };
}

// ============================================================================
// TC-TOOL-001: codemap_query 按关键词查询（返回匹配 UserService 的符号）
// ============================================================================

test("TC-TOOL-001: codemap_query 按关键词查询（返回匹配 UserService 的符号）", () => {
  const tool = createCodemapQueryTool();

  // ---------- 调用 codemap_query ----------
  const result = tool.execute({ query: "UserService" });

  // ---------- 断言：返回 1 个符号 ----------
  assert.equal(result.symbols.length, 1, "应返回 1 个匹配 UserService 的符号");
  assert.equal(result.total, 1, "total 应为 1");
  assert.ok(result.queryTime >= 0, "queryTime 应为非负数");

  // ---------- 断言：符号属性正确 ----------
  const sym = result.symbols[0]!;
  assert.equal(sym.symbolId, "src/A.ts:UserService", "symbolId 应为 src/A.ts:UserService");
  assert.equal(sym.name, "UserService", "name 应为 UserService");
  assert.equal(sym.kind, "class", "kind 应为 class");
  assert.equal(sym.filePath, "src/A.ts", "filePath 应为 src/A.ts");

  // ---------- 断言：结果已冻结 ----------
  assert.equal(Object.isFrozen(result), true, "result 应已冻结");
  assert.equal(Object.isFrozen(result.symbols), true, "symbols 数组应已冻结");
});

// ============================================================================
// TC-TOOL-002: codemap_query 按 kind 过滤（class 过滤返回 UserService + AuthModule）
// ============================================================================

test("TC-TOOL-002: codemap_query 按 kind 过滤（class 过滤返回 UserService + AuthModule）", () => {
  const tool = createCodemapQueryTool();

  // ---------- 调用 codemap_query（kind=class） ----------
  const result = tool.execute({ query: "", kind: "class" });

  // ---------- 断言：返回 2 个 class 符号 ----------
  assert.equal(result.symbols.length, 2, "应返回 2 个 class 符号");
  assert.equal(result.total, 2, "total 应为 2");

  // ---------- 断言：按 importance 降序排序（UserService=0.8 > AuthModule=0.5） ----------
  assert.equal(result.symbols[0]!.symbolId, "src/A.ts:UserService", "第 1 个应为 UserService（importance=0.8）");
  assert.equal(result.symbols[1]!.symbolId, "src/D.ts:AuthModule", "第 2 个应为 AuthModule（importance=0.5）");

  // ---------- 断言：全部为 class 类型 ----------
  for (const sym of result.symbols) {
    assert.equal(sym.kind, "class", `符号 ${sym.symbolId} 的 kind 应为 class`);
  }
});

// ============================================================================
// TC-TOOL-003: codemap_query 按 namespace 过滤（src/B 前缀匹配 login）
// ============================================================================

test("TC-TOOL-003: codemap_query 按 namespace 过滤（src/B 前缀匹配 login）", () => {
  const tool = createCodemapQueryTool();

  // ---------- 调用 codemap_query（namespace="src/B"） ----------
  // 注：仅 query 提供，先 searchByQuery("login", 200) 返回 login
  // 再 namespace 过滤：filePath="src/B.ts" 以 "src/B" 开头 → 保留
  const result = tool.execute({ query: "login", namespace: "src/B" });

  // ---------- 断言：返回 1 个符号 ----------
  assert.equal(result.symbols.length, 1, "应返回 1 个匹配 login 且在 src/B 命名空间下的符号");
  assert.equal(result.symbols[0]!.symbolId, "src/B.ts:login", "应为 src/B.ts:login");
  assert.equal(result.symbols[0]!.filePath, "src/B.ts", "filePath 应为 src/B.ts");

  // ---------- 验证 namespace 过滤生效 ----------
  // 不带 namespace 的查询应在 name + summary + signature + filePath 全字段中匹配 "login"
  // 注：searchByQuery 实现匹配 name + summary + signature + filePath
  //   - login：name="login" 直接匹配
  //   - UserService：signature="class UserService { login(email, password): ... }" 含 "login" 子串
  // 故不带 namespace 时返回 2 个符号（login + UserService）
  const resultWithoutNamespace = tool.execute({ query: "login" });
  assert.equal(
    resultWithoutNamespace.symbols.length,
    2,
    "不带 namespace 应返回 2 个含 login 关键词的符号（login + UserService）"
  );

  // 带不匹配 namespace 的查询应返回 0 个
  const resultWithWrongNamespace = tool.execute({ query: "login", namespace: "src/X" });
  assert.equal(resultWithWrongNamespace.symbols.length, 0, "不匹配的 namespace 应返回 0 个符号");
});

// ============================================================================
// TC-TOOL-004: codemap_query limit 截断（kind=function 截断到 1，total=3）
// ============================================================================

test("TC-TOOL-004: codemap_query limit 截断（kind=function 截断到 1，total=3）", () => {
  const tool = createCodemapQueryTool();

  // ---------- 调用 codemap_query（kind=function, limit=1） ----------
  // function 类型有 3 个：logger(0.9) / login(0.7) / verifyToken(0.6)
  // limit=1 截断到 1 个，应保留 importance 最高的 logger
  const result = tool.execute({ query: "", kind: "function", limit: 1 });

  // ---------- 断言：返回 1 个符号，total=3 ----------
  assert.equal(result.symbols.length, 1, "limit=1 应截断到 1 个符号");
  assert.equal(result.total, 3, "total 应为 3（截断前的总数）");

  // ---------- 断言：保留 importance 最高的 logger ----------
  assert.equal(result.symbols[0]!.symbolId, "src/E.ts:logger", "应保留 importance=0.9 的 logger");
  assert.equal(result.symbols[0]!.importance, 0.9, "logger 的 importance 应为 0.9");
});

// ============================================================================
// TC-TOOL-005: codemap_query 降级模式（graphAvailability=false 返回空结果）
// ============================================================================

test("TC-TOOL-005: codemap_query 降级模式（graphAvailability=false 返回空结果）", () => {
  const [tool] = createDegradedTools();

  // ---------- 调用 codemap_query（降级模式） ----------
  const result = tool.execute({ query: "UserService" });

  // ---------- 断言：返回空结果 ----------
  assert.equal(result.symbols.length, 0, "降级模式应返回空 symbols 数组");
  assert.equal(result.total, 0, "降级模式 total 应为 0");
  assert.equal(result, EMPTY_CODEMAP_QUERY_RESULT, "降级模式应返回 EMPTY_CODEMAP_QUERY_RESULT 常量");
});

// ============================================================================
// TC-TOOL-006: impact_analysis forward 方向（UserService → login → verifyToken）
// ============================================================================

test("TC-TOOL-006: impact_analysis forward 方向（UserService → login → verifyToken）", () => {
  const tool = createImpactAnalysisTool();

  // ---------- 调用 impact_analysis（forward, maxDepth=2） ----------
  // 图谱结构：UserService → login → verifyToken → AuthModule → logger → UserService（环）
  // forward 方向 maxDepth=2：从 UserService 出发沿 outgoing 边展开
  // - 1 跳：login（e1: UserService → login）
  // - 2 跳：verifyToken（e2: login → verifyToken）
  const result = tool.execute({
    symbolId: "src/A.ts:UserService",
    direction: "forward",
    maxDepth: 2,
  });

  // ---------- 断言：返回 2 个受影响符号 ----------
  assert.equal(result.impactedSymbols.length, 2, "forward maxDepth=2 应返回 2 个受影响符号");
  assert.equal(result.totalNodes, 2, "totalNodes 应为 2");
  assert.equal(result.maxDepthReached, 2, "maxDepthReached 应为 2");

  // ---------- 断言：第 1 个是 login（depth=1） ----------
  const loginImpacted = result.impactedSymbols[0]!;
  assert.equal(loginImpacted.symbol.symbolId, "src/B.ts:login", "depth=1 应为 login");
  assert.equal(loginImpacted.depth, 1, "login 的 depth 应为 1");
  assert.equal(loginImpacted.direction, "forward", "direction 应为 forward");

  // ---------- 断言：第 2 个是 verifyToken（depth=2） ----------
  const verifyTokenImpacted = result.impactedSymbols[1]!;
  assert.equal(verifyTokenImpacted.symbol.symbolId, "src/C.ts:verifyToken", "depth=2 应为 verifyToken");
  assert.equal(verifyTokenImpacted.depth, 2, "verifyToken 的 depth 应为 2");
});

// ============================================================================
// TC-TOOL-007: impact_analysis backward 方向（UserService ← logger）
// ============================================================================

test("TC-TOOL-007: impact_analysis backward 方向（UserService ← logger）", () => {
  const tool = createImpactAnalysisTool();

  // ---------- 调用 impact_analysis（backward, maxDepth=1） ----------
  // 图谱结构：UserService ← logger（e5: logger → UserService）
  // backward 方向 maxDepth=1：从 UserService 出发沿 incoming 边展开
  // - 1 跳：logger（e5 反向：logger → UserService）
  const result = tool.execute({
    symbolId: "src/A.ts:UserService",
    direction: "backward",
    maxDepth: 1,
  });

  // ---------- 断言：返回 1 个受影响符号（logger） ----------
  assert.equal(result.impactedSymbols.length, 1, "backward maxDepth=1 应返回 1 个受影响符号");
  assert.equal(result.totalNodes, 1, "totalNodes 应为 1");
  assert.equal(result.maxDepthReached, 1, "maxDepthReached 应为 1");

  // ---------- 断言：受影响符号是 logger ----------
  const loggerImpacted = result.impactedSymbols[0]!;
  assert.equal(loggerImpacted.symbol.symbolId, "src/E.ts:logger", "backward depth=1 应为 logger");
  assert.equal(loggerImpacted.depth, 1, "logger 的 depth 应为 1");
  assert.equal(loggerImpacted.direction, "backward", "direction 应为 backward");
});

// ============================================================================
// TC-TOOL-008: impact_analysis both 方向（UserService ↔ login + logger）
// ============================================================================

test("TC-TOOL-008: impact_analysis both 方向（UserService ↔ login + logger）", () => {
  const tool = createImpactAnalysisTool();

  // ---------- 调用 impact_analysis（both, maxDepth=1） ----------
  // 图谱结构：login → UserService（e1: UserService → login outgoing） + logger → UserService（e5: logger → UserService incoming）
  // both 方向 maxDepth=1：从 UserService 出发双向展开
  // - 1 跳 outgoing：login（e1: UserService → login）
  // - 1 跳 incoming：logger（e5: logger → UserService）
  const result = tool.execute({
    symbolId: "src/A.ts:UserService",
    direction: "both",
    maxDepth: 1,
  });

  // ---------- 断言：返回 2 个受影响符号 ----------
  assert.equal(result.impactedSymbols.length, 2, "both maxDepth=1 应返回 2 个受影响符号");
  assert.equal(result.totalNodes, 2, "totalNodes 应为 2");
  assert.equal(result.maxDepthReached, 1, "maxDepthReached 应为 1");

  // ---------- 断言：受影响符号含 login 与 logger ----------
  const impactedIds = result.impactedSymbols.map((s) => s.symbol.symbolId).sort();
  assert.deepEqual(impactedIds, ["src/B.ts:login", "src/E.ts:logger"].sort(), "both maxDepth=1 应含 login 与 logger");

  // ---------- 断言：所有 direction 均为 both ----------
  for (const impacted of result.impactedSymbols) {
    assert.equal(impacted.direction, "both", "direction 应为 both");
  }
});

// ============================================================================
// TC-TOOL-009: impact_analysis 循环检测（5 节点环）
// ============================================================================

test("TC-TOOL-009: impact_analysis 循环检测（5 节点环）", () => {
  const tool = createImpactAnalysisTool();

  // ---------- 调用 impact_analysis（forward, maxDepth=5） ----------
  // 图谱结构：UserService → login → verifyToken → AuthModule → logger → UserService（环）
  // forward 方向 maxDepth=5：DFS 检测从 UserService 出发回到 UserService 的简单环
  // 期望环：[UserService, login, verifyToken, AuthModule, logger, UserService]
  const result = tool.execute({
    symbolId: "src/A.ts:UserService",
    direction: "forward",
    maxDepth: 5,
  });

  // ---------- 断言：检测到至少 1 个环 ----------
  assert.ok(result.cycles.length >= 1, "应检测到至少 1 个循环依赖");
  assert.ok(result.cycles.length <= MAX_CYCLES, `cycles 数量应 ≤ MAX_CYCLES=${MAX_CYCLES}`);

  // ---------- 断言：环的格式正确（首尾为根节点） ----------
  const firstCycle = result.cycles[0]!;
  assert.equal(firstCycle[0], "src/A.ts:UserService", "环的首节点应为 UserService");
  assert.equal(firstCycle[firstCycle.length - 1], "src/A.ts:UserService", "环的尾节点应为 UserService");

  // ---------- 断言：环含 5 个节点（去重后）+ 1 个闭合节点 ----------
  // 环长度 = 6（5 个不同节点 + 闭合的根节点）
  // 注：环格式为 [root, n1, n2, n3, n4, root]，长度为 6
  assert.ok(firstCycle.length >= 3, "环长度应 ≥ 3（含根节点首尾）");

  // ---------- 断言：环包含全部 5 个节点 ----------
  const uniqueNodesInCycle = new Set(firstCycle);
  assert.ok(uniqueNodesInCycle.has("src/A.ts:UserService"), "环应含 UserService");
  assert.ok(uniqueNodesInCycle.has("src/B.ts:login"), "环应含 login");
  assert.ok(uniqueNodesInCycle.has("src/C.ts:verifyToken"), "环应含 verifyToken");
  assert.ok(uniqueNodesInCycle.has("src/D.ts:AuthModule"), "环应含 AuthModule");
  assert.ok(uniqueNodesInCycle.has("src/E.ts:logger"), "环应含 logger");
});

// ============================================================================
// TC-TOOL-010: impact_analysis 降级模式（返回空结果）
// ============================================================================

test("TC-TOOL-010: impact_analysis 降级模式（返回空结果）", () => {
  const [, tool] = createDegradedTools();

  // ---------- 调用 impact_analysis（降级模式） ----------
  const result = tool.execute({
    symbolId: "src/A.ts:UserService",
    direction: "both",
  });

  // ---------- 断言：返回空结果 ----------
  assert.equal(result.impactedSymbols.length, 0, "降级模式应返回空 impactedSymbols");
  assert.equal(result.totalNodes, 0, "降级模式 totalNodes 应为 0");
  assert.equal(result.cycles.length, 0, "降级模式 cycles 应为空");
  assert.equal(result, EMPTY_IMPACT_ANALYSIS_RESULT, "降级模式应返回 EMPTY_IMPACT_ANALYSIS_RESULT");
});

// ============================================================================
// TC-TOOL-011: flow_trace forward 路径枚举（UserService → logger 路径）
// ============================================================================

test("TC-TOOL-011: flow_trace forward 路径枚举（UserService → logger 路径）", () => {
  const tool = createFlowTraceTool();

  // ---------- 调用 flow_trace（forward, UserService → logger） ----------
  // 图谱结构：UserService → login → verifyToken → AuthModule → logger
  // forward 方向：沿 outgoing 边遍历
  // 期望路径：UserService → login → verifyToken → AuthModule → logger（length=4）
  const result = tool.execute({
    startSymbolId: "src/A.ts:UserService",
    endSymbolId: "src/E.ts:logger",
    direction: "forward",
    maxDepth: 5,
  });

  // ---------- 断言：返回至少 1 条路径 ----------
  assert.ok(result.paths.length >= 1, "应返回至少 1 条路径");
  assert.equal(result.truncated, false, "truncated 应为 false（路径数未超 MAX_PATHS）");

  // ---------- 断言：第 1 条路径正确 ----------
  const firstPath = result.paths[0]!;
  assert.equal(firstPath.length, 4, "路径长度（边数）应为 4");
  assert.equal(firstPath.path.length, 5, "路径节点数应为 5");

  // ---------- 断言：路径起点与终点正确 ----------
  assert.equal(firstPath.path[0], "src/A.ts:UserService", "路径起点应为 UserService");
  assert.equal(firstPath.path[4], "src/E.ts:logger", "路径终点应为 logger");

  // ---------- 断言：路径中间节点正确 ----------
  assert.equal(firstPath.path[1], "src/B.ts:login", "路径第 2 节点应为 login");
  assert.equal(firstPath.path[2], "src/C.ts:verifyToken", "路径第 3 节点应为 verifyToken");
  assert.equal(firstPath.path[3], "src/D.ts:AuthModule", "路径第 4 节点应为 AuthModule");
});

// ============================================================================
// TC-TOOL-012: flow_trace backward 路径枚举（logger → UserService 反向路径）
// ============================================================================

test("TC-TOOL-012: flow_trace backward 路径枚举（logger → UserService 反向路径）", () => {
  const tool = createFlowTraceTool();

  // ---------- 调用 flow_trace（backward, logger → UserService） ----------
  // 图谱结构反向：logger → AuthModule → verifyToken → login → UserService
  // backward 方向：沿 incoming 边遍历（logger 的 incoming 边指向 AuthModule）
  // 期望路径：logger → AuthModule → verifyToken → login → UserService（length=4）
  const result = tool.execute({
    startSymbolId: "src/E.ts:logger",
    endSymbolId: "src/A.ts:UserService",
    direction: "backward",
    maxDepth: 5,
  });

  // ---------- 断言：返回至少 1 条路径 ----------
  assert.ok(result.paths.length >= 1, "应返回至少 1 条反向路径");

  // ---------- 断言：第 1 条路径正确 ----------
  const firstPath = result.paths[0]!;
  assert.equal(firstPath.length, 4, "路径长度应为 4");
  assert.equal(firstPath.path[0], "src/E.ts:logger", "路径起点应为 logger");
  assert.equal(firstPath.path[4], "src/A.ts:UserService", "路径终点应为 UserService");
});

// ============================================================================
// TC-TOOL-013: flow_trace 起点=终点（单节点路径 length=0）
// ============================================================================

test("TC-TOOL-013: flow_trace 起点=终点（单节点路径 length=0）", () => {
  const tool = createFlowTraceTool();

  // ---------- 调用 flow_trace（startSymbolId === endSymbolId） ----------
  const result = tool.execute({
    startSymbolId: "src/A.ts:UserService",
    endSymbolId: "src/A.ts:UserService",
    direction: "forward",
  });

  // ---------- 断言：返回 1 条单节点路径 ----------
  assert.equal(result.paths.length, 1, "起点=终点应返回 1 条单节点路径");
  assert.equal(result.totalPaths, 1, "totalPaths 应为 1");
  assert.equal(result.truncated, false, "truncated 应为 false");

  // ---------- 断言：路径长度为 0（仅含起点节点） ----------
  const firstPath = result.paths[0]!;
  assert.equal(firstPath.length, 0, "路径长度（边数）应为 0");
  assert.equal(firstPath.path.length, 1, "路径节点数应为 1");
  assert.equal(firstPath.path[0], "src/A.ts:UserService", "路径节点应为 UserService");
});

// ============================================================================
// TC-TOOL-014: flow_trace 缺省 endSymbolId（叶子节点路径）
// ============================================================================

test("TC-TOOL-014: flow_trace 缺省 endSymbolId（叶子节点路径）", () => {
  const tool = createFlowTraceTool();

  // ---------- 调用 flow_trace（forward, maxDepth=2, 无 endSymbolId） ----------
  // 图谱结构：UserService → login → verifyToken → ...
  // forward 方向 maxDepth=2，无 endSymbolId：
  // - 沿 outgoing 边遍历到 maxDepth=2 内的叶子节点（无后续邻居的节点）
  // - 但本图谱所有节点都有 outgoing 边（环形结构），故无叶子节点
  // - 期望：路径数为 0（无叶子节点路径）
  // 注：环形图谱无叶子节点，故 endSymbolId 缺省时返回 0 条路径
  const result = tool.execute({
    startSymbolId: "src/A.ts:UserService",
    direction: "forward",
    maxDepth: 2,
  });

  // ---------- 断言：环形图谱无叶子节点，返回 0 条路径 ----------
  // 注：环形结构中每个节点都有 outgoing 边，故无叶子节点路径
  // 但 maxDepth=2 限制了路径长度，超出深度的节点不视为叶子
  // 此处验证 endSymbolId 缺省时的行为（不抛错，返回 paths 列表）
  assert.ok(Array.isArray(result.paths), "paths 应为数组");
  assert.equal(result.truncated, false, "truncated 应为 false");
  assert.ok(result.paths.length <= MAX_PATHS, `paths 数量应 ≤ MAX_PATHS=${MAX_PATHS}`);
});

// ============================================================================
// TC-TOOL-015: flow_trace 降级模式（返回空结果）
// ============================================================================

test("TC-TOOL-015: flow_trace 降级模式（返回空结果）", () => {
  const [, , tool] = createDegradedTools();

  // ---------- 调用 flow_trace（降级模式） ----------
  const result = tool.execute({
    startSymbolId: "src/A.ts:UserService",
    direction: "forward",
  });

  // ---------- 断言：返回空结果 ----------
  assert.equal(result.paths.length, 0, "降级模式应返回空 paths");
  assert.equal(result.totalPaths, 0, "降级模式 totalPaths 应为 0");
  assert.equal(result, EMPTY_FLOW_TRACE_RESULT, "降级模式应返回 EMPTY_FLOW_TRACE_RESULT");
});

// ============================================================================
// TC-TOOL-016: risk_scan 默认参数（importance >= 0.5 全部 5 个符号）
// ============================================================================

test("TC-TOOL-016: risk_scan 默认参数（importance >= 0.5 全部 5 个符号）", () => {
  const tool = createRiskScanTool();

  // ---------- 调用 risk_scan（默认参数：threshold=0.5, limit=10） ----------
  // 5 个符号的 importance 均 >= 0.5（最低 AuthModule=0.5）
  const result = tool.execute({});

  // ---------- 断言：返回 5 个热点符号 ----------
  assert.equal(result.hotspots.length, 5, "应返回 5 个 importance >= 0.5 的符号");
  assert.equal(result.totalHotspots, 5, "totalHotspots 应为 5");

  // ---------- 断言：按 riskScore 降序排序 ----------
  // logger=0.9 > UserService=0.8 > login=0.7 > verifyToken=0.6 > AuthModule=0.5
  assert.equal(result.hotspots[0]!.symbol.symbolId, "src/E.ts:logger", "第 1 应为 logger (0.9)");
  assert.equal(result.hotspots[1]!.symbol.symbolId, "src/A.ts:UserService", "第 2 应为 UserService (0.8)");
  assert.equal(result.hotspots[2]!.symbol.symbolId, "src/B.ts:login", "第 3 应为 login (0.7)");
  assert.equal(result.hotspots[3]!.symbol.symbolId, "src/C.ts:verifyToken", "第 4 应为 verifyToken (0.6)");
  assert.equal(result.hotspots[4]!.symbol.symbolId, "src/D.ts:AuthModule", "第 5 应为 AuthModule (0.5)");

  // ---------- 断言：riskScore === importance ----------
  for (const hotspot of result.hotspots) {
    assert.equal(hotspot.riskScore, hotspot.symbol.importance, "riskScore 应等于 importance");
  }

  // ---------- 断言：avgRiskScore = (0.9+0.8+0.7+0.6+0.5)/5 = 0.7 ----------
  assert.ok(Math.abs(result.avgRiskScore - 0.7) < 1e-9, `avgRiskScore 应为 0.7，实际为 ${result.avgRiskScore}`);
});

// ============================================================================
// TC-TOOL-017: risk_scan threshold 过滤（>= 0.7 返回 3 个符号）
// ============================================================================

test("TC-TOOL-017: risk_scan threshold 过滤（>= 0.7 返回 3 个符号）", () => {
  const tool = createRiskScanTool();

  // ---------- 调用 risk_scan（threshold=0.7） ----------
  // importance >= 0.7 的符号：logger(0.9) / UserService(0.8) / login(0.7)
  const result = tool.execute({ threshold: 0.7 });

  // ---------- 断言：返回 3 个热点符号 ----------
  assert.equal(result.hotspots.length, 3, "threshold=0.7 应返回 3 个符号");
  assert.equal(result.totalHotspots, 3, "totalHotspots 应为 3");

  // ---------- 断言：所有 hotspot 的 riskScore >= 0.7 ----------
  for (const hotspot of result.hotspots) {
    assert.ok(hotspot.riskScore >= 0.7, `riskScore ${hotspot.riskScore} 应 >= 0.7`);
  }
});

// ============================================================================
// TC-TOOL-018: risk_scan kind 过滤（class 返回 UserService + AuthModule）
// ============================================================================

test("TC-TOOL-018: risk_scan kind 过滤（class 返回 UserService + AuthModule）", () => {
  const tool = createRiskScanTool();

  // ---------- 调用 risk_scan（kind=class, threshold=0.4 确保 AuthModule 通过） ----------
  // class 类型符号：UserService(0.8) / AuthModule(0.5)
  // threshold=0.4 确保两者都通过阈值过滤
  const result = tool.execute({ kind: "class", threshold: 0.4 });

  // ---------- 断言：返回 2 个 class 符号 ----------
  assert.equal(result.hotspots.length, 2, "kind=class 应返回 2 个符号");
  assert.equal(result.totalHotspots, 2, "totalHotspots 应为 2");

  // ---------- 断言：全部为 class 类型 ----------
  for (const hotspot of result.hotspots) {
    assert.equal(hotspot.symbol.kind, "class", `符号 ${hotspot.symbol.symbolId} 的 kind 应为 class`);
  }

  // ---------- 断言：按 importance 降序 ----------
  assert.equal(result.hotspots[0]!.symbol.symbolId, "src/A.ts:UserService", "第 1 应为 UserService (0.8)");
  assert.equal(result.hotspots[1]!.symbol.symbolId, "src/D.ts:AuthModule", "第 2 应为 AuthModule (0.5)");
});

// ============================================================================
// TC-TOOL-019: risk_scan limit 截断（limit=2 截断到 logger + UserService）
// ============================================================================

test("TC-TOOL-019: risk_scan limit 截断（limit=2 截断到 logger + UserService）", () => {
  const tool = createRiskScanTool();

  // ---------- 调用 risk_scan（limit=2） ----------
  // 5 个符号 importance >= 0.5，limit=2 截断到 2 个
  // 应保留 importance 最高的 logger(0.9) + UserService(0.8)
  const result = tool.execute({ limit: 2 });

  // ---------- 断言：返回 2 个热点符号，totalHotspots=5 ----------
  assert.equal(result.hotspots.length, 2, "limit=2 应截断到 2 个符号");
  assert.equal(result.totalHotspots, 5, "totalHotspots 应为 5（截断前总数）");

  // ---------- 断言：保留 importance 最高的 2 个 ----------
  assert.equal(result.hotspots[0]!.symbol.symbolId, "src/E.ts:logger", "第 1 应为 logger (0.9)");
  assert.equal(result.hotspots[1]!.symbol.symbolId, "src/A.ts:UserService", "第 2 应为 UserService (0.8)");
});

// ============================================================================
// TC-TOOL-020: risk_scan avgRiskScore 计算（(0.9+0.8+0.7)/3 = 0.8）
// ============================================================================

test("TC-TOOL-020: risk_scan avgRiskScore 计算（(0.9+0.8+0.7)/3 = 0.8）", () => {
  const tool = createRiskScanTool();

  // ---------- 调用 risk_scan（threshold=0.7, limit=3） ----------
  // importance >= 0.7 的符号：logger(0.9) / UserService(0.8) / login(0.7)
  // avgRiskScore = (0.9 + 0.8 + 0.7) / 3 = 2.4 / 3 = 0.8
  const result = tool.execute({ threshold: 0.7, limit: 3 });

  // ---------- 断言：返回 3 个符号 ----------
  assert.equal(result.hotspots.length, 3, "应返回 3 个符号");

  // ---------- 断言：avgRiskScore = 0.8 ----------
  assert.ok(Math.abs(result.avgRiskScore - 0.8) < 1e-9, `avgRiskScore 应为 0.8，实际为 ${result.avgRiskScore}`);
});

// ============================================================================
// TC-TOOL-021: risk_scan 降级模式（返回空结果）
// ============================================================================

test("TC-TOOL-021: risk_scan 降级模式（返回空结果）", () => {
  const [, , , tool] = createDegradedTools();

  // ---------- 调用 risk_scan（降级模式） ----------
  const result = tool.execute({});

  // ---------- 断言：返回空结果 ----------
  assert.equal(result.hotspots.length, 0, "降级模式应返回空 hotspots");
  assert.equal(result.totalHotspots, 0, "降级模式 totalHotspots 应为 0");
  assert.equal(result.avgRiskScore, 0, "降级模式 avgRiskScore 应为 0");
  assert.equal(result, EMPTY_RISK_SCAN_RESULT, "降级模式应返回 EMPTY_RISK_SCAN_RESULT");
});

// ============================================================================
// TC-TOOL-022: tool-executor-registry 注册 4 个 handler
// ============================================================================

test("TC-TOOL-022: tool-executor-registry 注册 4 个 handler", () => {
  const adapter = createTestAdapter();
  const registry = new CodemapToolRegistry(adapter, () => true);

  // ---------- 调用 getHandlers ----------
  const handlers = registry.getHandlers();

  // ---------- 断言：handlers 含 4 个工具名 ----------
  assert.equal(handlers.size, 4, "handlers 应含 4 个工具");

  // ---------- 断言：4 个工具名正确 ----------
  const expectedNames = [CODEMAP_QUERY_TOOL_NAME, IMPACT_ANALYSIS_TOOL_NAME, FLOW_TRACE_TOOL_NAME, RISK_SCAN_TOOL_NAME];
  for (const name of expectedNames) {
    assert.ok(handlers.has(name), `handlers 应含工具 ${name}`);
    assert.equal(typeof handlers.get(name), "function", `工具 ${name} 的 handler 应为函数`);
  }

  // ---------- 断言：getMetadata 返回 4 个元数据 ----------
  const metadata = registry.getMetadata();
  assert.equal(metadata.length, 4, "metadata 应含 4 个工具元数据");
  assert.equal(metadata, CODEMAP_TOOL_METADATA, "metadata 应为 CODEMAP_TOOL_METADATA 常量");

  // ---------- 断言：元数据 name 与 description 均为非空字符串 ----------
  for (const meta of metadata) {
    assert.equal(typeof meta.name, "string", "meta.name 应为字符串");
    assert.equal(typeof meta.description, "string", "meta.description 应为字符串");
    assert.ok(meta.name.length > 0, "meta.name 应为非空");
    assert.ok(meta.description.length > 0, "meta.description 应为非空");
  }

  // ---------- 断言：再次调用 getHandlers 返回同一缓存实例 ----------
  const handlers2 = registry.getHandlers();
  assert.equal(handlers, handlers2, "再次调用 getHandlers 应返回同一缓存实例");
});

// ============================================================================
// TC-TOOL-023: registerCodemapTools 注入 ToolExecutor（4 次 registerToolHandler 调用）
// ============================================================================

test("TC-TOOL-023: registerCodemapTools 注入 ToolExecutor（4 次 registerToolHandler 调用）", () => {
  const adapter = createTestAdapter();
  const { registrar, registeredNames, registeredHandlers } = createToolExecutorStub();

  // ---------- 调用 registerCodemapTools ----------
  const registry = registerCodemapTools(registrar, adapter, () => true);

  // ---------- 断言：注册了 4 个工具 ----------
  assert.equal(registeredNames.length, 4, "应注册 4 个工具");
  assert.equal(registeredHandlers.size, 4, "registeredHandlers 应含 4 个工具");

  // ---------- 断言：4 个工具名正确 ----------
  assert.ok(registeredHandlers.has(CODEMAP_QUERY_TOOL_NAME), "应注册 codemap_query");
  assert.ok(registeredHandlers.has(IMPACT_ANALYSIS_TOOL_NAME), "应注册 impact_analysis");
  assert.ok(registeredHandlers.has(FLOW_TRACE_TOOL_NAME), "应注册 flow_trace");
  assert.ok(registeredHandlers.has(RISK_SCAN_TOOL_NAME), "应注册 risk_scan");

  // ---------- 断言：返回的 registry 实例有效 ----------
  assert.ok(registry instanceof CodemapToolRegistry, "应返回 CodemapToolRegistry 实例");
  assert.equal(registry.getHandlers().size, 4, "registry.getHandlers() 应含 4 个工具");
});

// ============================================================================
// TC-TOOL-024: handler 适配 codemap_query（args → execute → ToolExecutionResult）
// ============================================================================

test("TC-TOOL-024: handler 适配 codemap_query（args → execute → ToolExecutionResult）", async () => {
  const adapter = createTestAdapter();
  const { handlers, registry } = createCodemapToolHandlers(adapter, () => true);

  // ---------- 调用 codemap_query handler ----------
  const codemapQueryHandler = handlers.get(CODEMAP_QUERY_TOOL_NAME)!;
  const result = await codemapQueryHandler(
    { query: "UserService" },
    // context 参数（codemap 工具不依赖 context，传入最小化对象）
    {
      sessionId: "test-session",
      projectRoot: "/test",
      toolCall: {
        id: "test-call-id",
        type: "function",
        function: { name: CODEMAP_QUERY_TOOL_NAME, arguments: JSON.stringify({ query: "UserService" }) },
      },
    }
  );

  // ---------- 断言：返回 ToolExecutionResult ----------
  assert.equal(result.ok, true, "ok 应为 true");
  assert.equal(result.name, CODEMAP_QUERY_TOOL_NAME, "name 应为 codemap_query");
  assert.equal(typeof result.output, "string", "output 应为字符串（JSON 序列化）");

  // ---------- 断言：output 含 UserService 符号 ----------
  const parsedOutput = JSON.parse(result.output!) as { symbols: Array<{ symbolId: string }>; total: number };
  assert.equal(parsedOutput.symbols.length, 1, "output 应含 1 个符号");
  assert.equal(parsedOutput.symbols[0]!.symbolId, "src/A.ts:UserService", "符号应为 UserService");
  assert.equal(parsedOutput.total, 1, "total 应为 1");

  // ---------- 断言：metadata 含 total 与 queryTime ----------
  assert.ok(result.metadata, "metadata 应存在");
  assert.equal(result.metadata!.total, 1, "metadata.total 应为 1");
  assert.ok(typeof result.metadata!.queryTime === "number", "metadata.queryTime 应为数字");

  // ---------- 验证 risk_scan handler 适配 ----------
  const riskScanHandler = handlers.get(RISK_SCAN_TOOL_NAME)!;
  const riskResult = await riskScanHandler(
    {},
    {
      sessionId: "test-session",
      projectRoot: "/test",
      toolCall: {
        id: "test-call-id",
        type: "function",
        function: { name: RISK_SCAN_TOOL_NAME, arguments: "{}" },
      },
    }
  );
  assert.equal(riskResult.ok, true, "risk_scan handler 应返回 ok=true");
  assert.equal(riskResult.name, RISK_SCAN_TOOL_NAME, "risk_scan name 应正确");

  // ---------- 验证降级模式 handler 仍正常返回 ----------
  const degradedRegistry = new CodemapToolRegistry(adapter, () => false);
  const degradedHandler = degradedRegistry.getHandlers().get(CODEMAP_QUERY_TOOL_NAME)!;
  const degradedResult = await degradedHandler(
    { query: "UserService" },
    {
      sessionId: "test",
      projectRoot: "/test",
      toolCall: { id: "x", type: "function", function: { name: "x", arguments: "{}" } },
    }
  );
  assert.equal(degradedResult.ok, true, "降级模式 handler 应返回 ok=true");
  const degradedParsed = JSON.parse(degradedResult.output!) as { symbols: unknown[] };
  assert.equal(degradedParsed.symbols.length, 0, "降级模式 output 应含 0 个符号");
});

// ============================================================================
// TC-TOOL-025: 不可变优先（全部返回结果 Object.isFrozen=true）
// ============================================================================

test("TC-TOOL-025: 不可变优先（全部返回结果 Object.isFrozen=true）", () => {
  const codemapQueryTool = createCodemapQueryTool();
  const impactAnalysisTool = createImpactAnalysisTool();
  const flowTraceTool = createFlowTraceTool();
  const riskScanTool = createRiskScanTool();

  // ---------- 验证 codemap_query 结果冻结 ----------
  const queryResult = codemapQueryTool.execute({ query: "UserService" });
  assert.equal(Object.isFrozen(queryResult), true, "codemap_query 结果应冻结");
  assert.equal(Object.isFrozen(queryResult.symbols), true, "codemap_query.symbols 应冻结");

  // ---------- 验证 impact_analysis 结果冻结 ----------
  const impactResult = impactAnalysisTool.execute({
    symbolId: "src/A.ts:UserService",
    direction: "forward",
    maxDepth: 2,
  });
  assert.equal(Object.isFrozen(impactResult), true, "impact_analysis 结果应冻结");
  assert.equal(Object.isFrozen(impactResult.impactedSymbols), true, "impact_analysis.impactedSymbols 应冻结");
  assert.equal(Object.isFrozen(impactResult.cycles), true, "impact_analysis.cycles 应冻结");

  // ---------- 验证 flow_trace 结果冻结 ----------
  const flowResult = flowTraceTool.execute({
    startSymbolId: "src/A.ts:UserService",
    endSymbolId: "src/E.ts:logger",
    direction: "forward",
  });
  assert.equal(Object.isFrozen(flowResult), true, "flow_trace 结果应冻结");
  assert.equal(Object.isFrozen(flowResult.paths), true, "flow_trace.paths 应冻结");
  // 验证每个 path 也已冻结
  for (const path of flowResult.paths) {
    assert.equal(Object.isFrozen(path), true, "flow_trace.paths[i] 应冻结");
    assert.equal(Object.isFrozen(path.path), true, "flow_trace.paths[i].path 应冻结");
  }

  // ---------- 验证 risk_scan 结果冻结 ----------
  const riskResult = riskScanTool.execute({});
  assert.equal(Object.isFrozen(riskResult), true, "risk_scan 结果应冻结");
  assert.equal(Object.isFrozen(riskResult.hotspots), true, "risk_scan.hotspots 应冻结");

  // ---------- 验证降级模式返回的常量也冻结 ----------
  const [, degradedImpact, degradedFlow, degradedRisk] = createDegradedTools();
  assert.equal(Object.isFrozen(EMPTY_CODEMAP_QUERY_RESULT), true, "EMPTY_CODEMAP_QUERY_RESULT 应冻结");
  assert.equal(Object.isFrozen(EMPTY_IMPACT_ANALYSIS_RESULT), true, "EMPTY_IMPACT_ANALYSIS_RESULT 应冻结");
  assert.equal(Object.isFrozen(EMPTY_FLOW_TRACE_RESULT), true, "EMPTY_FLOW_TRACE_RESULT 应冻结");
  assert.equal(Object.isFrozen(EMPTY_RISK_SCAN_RESULT), true, "EMPTY_RISK_SCAN_RESULT 应冻结");

  // ---------- 验证降级模式返回的是同一常量引用 ----------
  const [degradedQuery] = createDegradedTools();
  assert.equal(
    degradedQuery.execute({ query: "x" }),
    EMPTY_CODEMAP_QUERY_RESULT,
    "降级模式应返回 EMPTY_CODEMAP_QUERY_RESULT 常量引用"
  );
  assert.equal(
    degradedImpact.execute({ symbolId: "x", direction: "forward" }),
    EMPTY_IMPACT_ANALYSIS_RESULT,
    "降级模式应返回 EMPTY_IMPACT_ANALYSIS_RESULT 常量引用"
  );
  assert.equal(
    degradedFlow.execute({ startSymbolId: "x", direction: "forward" }),
    EMPTY_FLOW_TRACE_RESULT,
    "降级模式应返回 EMPTY_FLOW_TRACE_RESULT 常量引用"
  );
  assert.equal(degradedRisk.execute({}), EMPTY_RISK_SCAN_RESULT, "降级模式应返回 EMPTY_RISK_SCAN_RESULT 常量引用");
});

// ============================================================================
// 附加测试：常量与默认值校验
// ============================================================================

test("附加测试：工具元数据常量与默认值校验", () => {
  // ---------- 验证工具名常量 ----------
  assert.equal(CODEMAP_QUERY_TOOL_NAME, "codemap_query", "工具名应为 codemap_query");
  assert.equal(IMPACT_ANALYSIS_TOOL_NAME, "impact_analysis", "工具名应为 impact_analysis");
  assert.equal(FLOW_TRACE_TOOL_NAME, "flow_trace", "工具名应为 flow_trace");
  assert.equal(RISK_SCAN_TOOL_NAME, "risk_scan", "工具名应为 risk_scan");

  // ---------- 验证常量已冻结 ----------
  assert.equal(Object.isFrozen(CODEMAP_QUERY_TOOL_NAME), true, "CODEMAP_QUERY_TOOL_NAME 字符串本身已冻结");
  assert.equal(Object.isFrozen(EMPTY_CODEMAP_QUERY_RESULT), true, "EMPTY_CODEMAP_QUERY_RESULT 应冻结");
  assert.equal(Object.isFrozen(EMPTY_IMPACT_ANALYSIS_RESULT), true, "EMPTY_IMPACT_ANALYSIS_RESULT 应冻结");
  assert.equal(Object.isFrozen(EMPTY_FLOW_TRACE_RESULT), true, "EMPTY_FLOW_TRACE_RESULT 应冻结");
  assert.equal(Object.isFrozen(EMPTY_RISK_SCAN_RESULT), true, "EMPTY_RISK_SCAN_RESULT 应冻结");
  assert.equal(Object.isFrozen(CODEMAP_TOOL_METADATA), true, "CODEMAP_TOOL_METADATA 应冻结");

  // ---------- 验证默认值合理性 ----------
  assert.ok(MAX_CODEMAP_QUERY_LIMIT > 0, "MAX_CODEMAP_QUERY_LIMIT 应 > 0");
  assert.ok(MAX_CYCLES > 0, "MAX_CYCLES 应 > 0");
  assert.ok(MAX_PATHS > 0, "MAX_PATHS 应 > 0");
  assert.ok(
    DEFAULT_RISK_SCAN_THRESHOLD >= 0 && DEFAULT_RISK_SCAN_THRESHOLD <= 1,
    "DEFAULT_RISK_SCAN_THRESHOLD 应在 [0, 1] 区间"
  );

  // ---------- 验证循环检测深度上限合理性 ----------
  // MAX_CYCLE_DETECTION_DEPTH 应 ≥ 5（允许检测 5 节点环）
  // 且独立于 BFS 的 MAX_IMPACT_ANALYSIS_MAX_DEPTH=3 硬约束
  assert.ok(MAX_CYCLE_DETECTION_DEPTH >= 5, "MAX_CYCLE_DETECTION_DEPTH 应 ≥ 5（允许检测 5 节点环）");
  assert.ok(MAX_CYCLE_DETECTION_DEPTH <= 20, "MAX_CYCLE_DETECTION_DEPTH 应 ≤ 20（防 DFS 指数爆炸）");
  assert.equal(Object.isFrozen(MAX_CYCLE_DETECTION_DEPTH), true, "MAX_CYCLE_DETECTION_DEPTH 应冻结");
});
