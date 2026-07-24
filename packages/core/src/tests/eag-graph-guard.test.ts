/**
 * EAG-Graph Guard 单元测试（Phase 2）
 *
 * 测试范围：
 * - G1. validateGraph：合法图校验通过
 * - G2. validateGraph：入口节点不存在 → errors
 * - G3. validateGraph：边 from/to 引用不存在的节点 → errors
 * - G4. validateGraph：decision 节点缺少 decisionPredicateId → errors
 * - G5. validateGraph：task 节点缺少 plugin → errors
 * - G6. validateGraph：loop 节点缺少 loopConfig → errors
 * - G7. validateGraph：不可达节点 → warnings + unreachableNodes
 * - G8. validateGraph：环路检测（DFS 三色标记）→ warnings + isCyclic=true
 * - G9. checkPreExecution：正常通过
 * - G10. checkPreExecution：图级超时 → stop_timeout
 * - G11. checkPreExecution：token 预算耗尽 → stop_failure
 * - G12. checkPreExecution：最大深度 → stop_failure
 * - G13. checkPreExecution：用户取消 → stop_failure
 * - G14. checkPostExecution：completed 状态 + 契约通过
 * - G15. checkPostExecution：completed 状态 + 契约失败 → retry_node
 * - G16. checkPostExecution：failed/skipped/isolated 状态跳过契约校验
 * - G17. checkPostExecution：节点耗时异常 → warning（不阻断）
 * - G18. createGraphGuard 工厂函数
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §8.3 GraphGuardProtocol
 * - eag/graph/graph-guard.ts 源文件（被测对象）
 *
 * @module core/tests/eag-graph-guard
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphGuardImpl, createGraphGuard } from "../eag/graph/graph-guard";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { DEFAULT_WORK_GRAPH_CONFIG } from "../eag/graph/graph-loop-models";
import type {
  WorkGraph,
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  NodeFieldContract,
  PredicateRegistry,
  PredicateFunction,
} from "../eag/graph/graph-loop-models";
import type { GraphGuardProtocol } from "../eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个最小可用的 task 节点定义
 *
 * @param nodeId 节点 ID
 */
function makeTaskNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务`,
    inputContract: [],
    outputContract: [],
    plugin: "echo",
  };
}

/**
 * 构造一个 end 节点定义
 *
 * @param nodeId 节点 ID
 */
function makeEndNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "end",
    label: nodeId,
    task: "结束节点",
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一个 decision 节点定义
 *
 * @param nodeId 节点 ID
 * @param predicateId 决策谓词 ID
 */
function makeDecisionNode(nodeId: string, predicateId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "decision",
    label: nodeId,
    task: `${nodeId} 决策`,
    inputContract: [],
    outputContract: [],
    decisionPredicateId: predicateId,
  };
}

/**
 * 构造一个 loop 节点定义
 *
 * @param nodeId 节点 ID
 * @param withLoopConfig 是否包含 loopConfig
 */
function makeLoopNode(nodeId: string, withLoopConfig: boolean): GraphNodeDef {
  const node: GraphNodeDef = {
    nodeId,
    nodeType: "loop",
    label: nodeId,
    task: `${nodeId} 循环任务`,
    inputContract: [],
    outputContract: [],
  };
  if (withLoopConfig) {
    node.loopConfig = {
      loopType: "coding",
      discoveryMode: "auto",
      evaluatorMode: "standard",
      maxIterations: 5,
      maxTokens: 50000,
      stopWhen: "",
      stageOrder: ["plan", "dev", "verify", "fix"],
      autoCommit: false,
      humanCheckpointEvery: 0,
    };
  }
  return node;
}

/**
 * 构造一个简单的线性图（start → end）
 *
 * @param graphId 图 ID
 */
function makeLinearGraph(graphId: string = "g1"): WorkGraph {
  return GraphBuilder.create()
    .setGraphInfo(graphId, "线性图", "测试用线性图")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .build();
}

/**
 * 构造一个最小可用的 GraphRunContext（用于 checkPreExecution / checkPostExecution）
 *
 * @param overrides 部分字段覆盖
 */
function makeRunContext(overrides?: Partial<GraphRunContext>): GraphRunContext {
  const config = overrides?.config ?? DEFAULT_WORK_GRAPH_CONFIG;
  return {
    runId: overrides?.runId ?? "run-001",
    graphId: overrides?.graphId ?? "g1",
    globalState: overrides?.globalState ?? {},
    visited: overrides?.visited ?? new Set<string>(),
    nodeResults: overrides?.nodeResults ?? new Map<string, GraphNodeResult>(),
    cancelled: overrides?.cancelled ?? false,
    config,
    predicateRegistry: overrides?.predicateRegistry ?? createFakePredicateRegistry(),
    currentDepth: overrides?.currentDepth ?? 0,
    totalTokensUsed: overrides?.totalTokensUsed ?? 0,
    startedAtMs: overrides?.startedAtMs ?? Date.now(),
  };
}

/**
 * 构造一个真实的 PredicateRegistry 实现（不使用 mock）
 *
 * 注册一个默认谓词 "alwaysTrue"
 */
function createFakePredicateRegistry(): PredicateRegistry {
  const registry: Map<string, PredicateFunction> = new Map();
  registry.set("alwaysTrue", () => true);
  return {
    register(id: string, predicate: PredicateFunction): void {
      if (registry.has(id)) {
        throw new Error(`谓词 ID 已存在：${id}`);
      }
      registry.set(id, predicate);
    },
    lookup(id: string): PredicateFunction {
      const fn = registry.get(id);
      if (!fn) {
        throw new Error(`谓词 ID 未注册：${id}`);
      }
      return fn;
    },
    has(id: string): boolean {
      return registry.has(id);
    },
  };
}

/**
 * 构造一个 completed 状态的 GraphNodeResult
 *
 * @param nodeId 节点 ID
 * @param output 输出数据
 * @param durationSec 耗时（秒）
 */
function makeCompletedResult(
  nodeId: string,
  output: Record<string, unknown> = {},
  durationSec: number = 0.1
): GraphNodeResult {
  return {
    nodeId,
    nodeType: "task",
    status: "completed",
    output,
    durationSec,
    retryCount: 0,
  };
}

// ============================================================================
// G1. validateGraph：合法图校验通过
// ============================================================================

test("G1. validateGraph 合法线性图校验通过", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  const result = guard.validateGraph(graph);

  assert.equal(result.valid, true, "合法图应校验通过");
  assert.equal(result.errors.length, 0, "合法图不应有 errors");
  assert.equal(result.isCyclic, false, "线性图不应有环");
  assert.equal(result.unreachableNodes.length, 0, "线性图不应有不可达节点");
});

// ============================================================================
// G2. validateGraph：入口节点不存在 → errors
// ============================================================================

test("G2. validateGraph 入口节点不存在时 errors 非空", () => {
  const guard = new GraphGuardImpl();
  // 手动构造一个入口节点不存在的图（绕过 GraphBuilder 的校验）
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["start", makeTaskNode("start")],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "start", to: "end", dataMapping: {} }],
    entryNodeId: "nonexistent",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, false, "入口不存在时应 valid=false");
  assert.ok(result.errors.length > 0, "应有 errors");
  assert.match(result.errors.join("\n"), /入口节点不存在/, "errors 应包含入口不存在信息");
});

// ============================================================================
// G3. validateGraph：边 from/to 引用不存在的节点 → errors
// ============================================================================

test("G3. validateGraph 边 from 引用不存在节点时 errors 非空", () => {
  const guard = new GraphGuardImpl();
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["start", makeTaskNode("start")],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "ghost", to: "end", dataMapping: {} }],
    entryNodeId: "start",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /from 引用不存在的节点/);
});

test("G3b. validateGraph 边 to 引用不存在节点时 errors 非空", () => {
  const guard = new GraphGuardImpl();
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["start", makeTaskNode("start")],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "start", to: "ghost", dataMapping: {} }],
    entryNodeId: "start",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /to 引用不存在的节点/);
});

// ============================================================================
// G4. validateGraph：decision 节点缺少 decisionPredicateId → errors
// ============================================================================

test("G4. validateGraph decision 节点缺少 decisionPredicateId 时 errors 非空", () => {
  const guard = new GraphGuardImpl();
  const decisionNode: GraphNodeDef = {
    nodeId: "decide",
    nodeType: "decision",
    label: "决策",
    task: "决策任务",
    inputContract: [],
    outputContract: [],
    // 缺少 decisionPredicateId
  };
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["decide", decisionNode],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "decide", to: "end", dataMapping: {} }],
    entryNodeId: "decide",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /decision 节点 decide 缺少 decisionPredicateId/);
});

// ============================================================================
// G5. validateGraph：task 节点缺少 plugin → errors
// ============================================================================

test("G5. validateGraph task 节点缺少 plugin 时 errors 非空", () => {
  const guard = new GraphGuardImpl();
  const taskNodeWithoutPlugin: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务描述",
    inputContract: [],
    outputContract: [],
    // 缺少 plugin
  };
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["task1", taskNodeWithoutPlugin],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "task1", to: "end", dataMapping: {} }],
    entryNodeId: "task1",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /task 节点 task1 缺少 plugin/);
});

// ============================================================================
// G6. validateGraph：loop 节点缺少 loopConfig → errors
// ============================================================================

test("G6. validateGraph loop 节点缺少 loopConfig 时 errors 非空", () => {
  const guard = new GraphGuardImpl();
  const loopNodeWithoutConfig = makeLoopNode("loop1", false);
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["loop1", loopNodeWithoutConfig],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "loop1", to: "end", dataMapping: {} }],
    entryNodeId: "loop1",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /loop 节点 loop1 缺少 loopConfig/);
});

// ============================================================================
// G7. validateGraph：不可达节点 → warnings + unreachableNodes
// ============================================================================

test("G7. validateGraph 不可达节点出现在 warnings 和 unreachableNodes 中", () => {
  const guard = new GraphGuardImpl();
  // 构造一个含孤立节点的图：start → end，但 isolated 节点无入边
  const graph: WorkGraph = {
    graphId: "g1",
    name: "测试",
    description: "描述",
    nodes: new Map([
      ["start", makeTaskNode("start")],
      ["end", makeEndNode("end")],
      ["isolated", makeTaskNode("isolated")],
    ]),
    edges: [{ edgeId: "e1", from: "start", to: "end", dataMapping: {} }],
    entryNodeId: "start",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  // 不可达节点是 warning，不阻断 valid
  assert.equal(result.valid, true, "不可达节点不阻断校验");
  assert.ok(result.unreachableNodes.includes("isolated"), "unreachableNodes 应包含 isolated");
  assert.ok(result.warnings.length > 0, "应有 warnings");
  assert.match(result.warnings.join("\n"), /不可达/);
});

// ============================================================================
// G8. validateGraph：环路检测 → warnings + isCyclic=true
// ============================================================================

test("G8. validateGraph 含环的图 isCyclic=true 并产生 warning", () => {
  const guard = new GraphGuardImpl();
  // 构造一个含环的图：A → B → C → A
  const graph: WorkGraph = {
    graphId: "g1",
    name: "环路图",
    description: "含环的测试图",
    nodes: new Map([
      ["A", makeTaskNode("A")],
      ["B", makeTaskNode("B")],
      ["C", makeTaskNode("C")],
    ]),
    edges: [
      { edgeId: "e1", from: "A", to: "B", dataMapping: {} },
      { edgeId: "e2", from: "B", to: "C", dataMapping: {} },
      { edgeId: "e3", from: "C", to: "A", dataMapping: {} },
    ],
    entryNodeId: "A",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.isCyclic, true, "应检测到环");
  assert.ok(result.warnings.length > 0, "应有 warnings");
  assert.match(result.warnings.join("\n"), /环/);
});

// ============================================================================
// G9. checkPreExecution：正常通过
// ============================================================================

test("G9. checkPreExecution 正常条件通过", () => {
  const guard = new GraphGuardImpl();
  const node = makeTaskNode("task1");
  const context = makeRunContext({
    cancelled: false,
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, timeoutSec: 0, maxTokens: 0, maxDepth: 100 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, true, "正常条件应通过");
  assert.equal(result.severity, "info");
});

// ============================================================================
// G10. checkPreExecution：图级超时 → stop_timeout
// ============================================================================

test("G10. checkPreExecution 超时时返回 stop_timeout", () => {
  const guard = new GraphGuardImpl();
  const node = makeTaskNode("task1");
  // startedAtMs 设为 100 秒前，timeoutSec=30 → 已超时
  const context = makeRunContext({
    startedAtMs: Date.now() - 100_000,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, timeoutSec: 30 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, false, "超时应不通过");
  assert.equal(result.suggestedAction, "stop_timeout");
  assert.equal(result.severity, "error");
  assert.match(result.reason, /图级超时/);
});

// ============================================================================
// G11. checkPreExecution：token 预算耗尽 → stop_failure
// ============================================================================

test("G11. checkPreExecution token 预算耗尽时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const node = makeTaskNode("task1");
  const context = makeRunContext({
    totalTokensUsed: 10_000,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxTokens: 10_000 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, false, "token 耗尽应不通过");
  assert.equal(result.suggestedAction, "stop_failure");
  assert.match(result.reason, /token 预算耗尽/);
});

// ============================================================================
// G12. checkPreExecution：最大深度 → stop_failure
// ============================================================================

test("G12. checkPreExecution 达到最大深度时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const node = makeTaskNode("task1");
  const context = makeRunContext({
    currentDepth: 100,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxDepth: 100 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, false, "达到最大深度应不通过");
  assert.equal(result.suggestedAction, "stop_failure");
  assert.match(result.reason, /最大遍历深度/);
});

// ============================================================================
// G13. checkPreExecution：用户取消 → stop_failure
// ============================================================================

test("G13. checkPreExecution 用户取消时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const node = makeTaskNode("task1");
  const context = makeRunContext({
    cancelled: true,
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, false, "用户取消应不通过");
  assert.equal(result.suggestedAction, "stop_failure");
  assert.match(result.reason, /用户已请求取消/);
});

// ============================================================================
// G14. checkPostExecution：completed 状态 + 契约通过
// ============================================================================

test("G14. checkPostExecution completed 状态且契约通过时 passed=true", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "result", type: "string", required: true }],
    plugin: "echo",
  };
  const result = makeCompletedResult("task1", { result: "成功" });
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, true, "契约通过时应 passed=true");
  assert.equal(checkResult.severity, "info");
});

// ============================================================================
// G15. checkPostExecution：completed 状态 + 契约失败 → retry_node
// ============================================================================

test("G15. checkPostExecution completed 状态但必填输出字段缺失时返回 retry_node", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "result", type: "string", required: true }],
    plugin: "echo",
  };
  // 输出中缺少必填字段 result
  const result = makeCompletedResult("task1", { other: "其他" });
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, false, "契约失败时应 passed=false");
  assert.equal(checkResult.suggestedAction, "retry_node");
  assert.match(checkResult.reason, /必填输出字段 "result" 缺失/);
});

test("G15b. checkPostExecution completed 状态但输出类型不匹配时返回 retry_node", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "count", type: "number", required: true }],
    plugin: "echo",
  };
  // 输出中 count 是字符串而非 number
  const result = makeCompletedResult("task1", { count: "not-a-number" });
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, false);
  assert.equal(checkResult.suggestedAction, "retry_node");
  assert.match(checkResult.reason, /类型不匹配/);
});

// ============================================================================
// G16. checkPostExecution：failed/skipped/isolated 状态跳过契约校验
// ============================================================================

test("G16a. checkPostExecution failed 状态跳过契约校验", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "result", type: "string", required: true }],
    plugin: "echo",
  };
  const failedResult: GraphNodeResult = {
    nodeId: "task1",
    nodeType: "task",
    status: "failed",
    output: {}, // 输出为空，但 failed 状态不校验契约
    durationSec: 0.5,
    failureReason: "执行失败",
    retryCount: 0,
  };
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, failedResult, context);
  assert.equal(checkResult.passed, true, "failed 状态应跳过契约校验");
  assert.match(checkResult.reason, /failed/);
});

test("G16b. checkPostExecution skipped 状态跳过契约校验", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "result", type: "string", required: true }],
    plugin: "echo",
  };
  const skippedResult: GraphNodeResult = {
    nodeId: "task1",
    nodeType: "task",
    status: "skipped",
    output: {},
    durationSec: 0,
    retryCount: 0,
  };
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, skippedResult, context);
  assert.equal(checkResult.passed, true, "skipped 状态应跳过契约校验");
  assert.match(checkResult.reason, /skipped/);
});

test("G16c. checkPostExecution isolated 状态跳过契约校验", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "result", type: "string", required: true }],
    plugin: "echo",
  };
  const isolatedResult: GraphNodeResult = {
    nodeId: "task1",
    nodeType: "task",
    status: "isolated",
    output: {},
    durationSec: 0,
    retryCount: 3,
  };
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, isolatedResult, context);
  assert.equal(checkResult.passed, true, "isolated 状态应跳过契约校验");
  assert.match(checkResult.reason, /isolated/);
});

// ============================================================================
// G17. checkPostExecution：节点耗时异常 → warning（不阻断）
// ============================================================================

test("G17. checkPostExecution 节点耗时超过图级超时 50% 时产生 warning 但 passed=true", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [],
    plugin: "echo",
  };
  // 图级超时 30 秒，节点耗时 20 秒（> 30 * 0.5 = 15 秒）
  const result = makeCompletedResult("task1", {}, 20);
  const context = makeRunContext({
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, timeoutSec: 30 },
  });

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, true, "耗时异常仅 warning，不阻断");
  assert.equal(checkResult.severity, "warning", "severity 应为 warning");
  assert.match(checkResult.reason, /耗时较长/);
});

test("G17b. checkPostExecution 节点耗时未超阈值时无 warning", () => {
  const guard = new GraphGuardImpl();
  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [],
    plugin: "echo",
  };
  // 图级超时 30 秒，节点耗时 10 秒（< 30 * 0.5 = 15 秒）
  const result = makeCompletedResult("task1", {}, 10);
  const context = makeRunContext({
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, timeoutSec: 30 },
  });

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, true);
  assert.equal(checkResult.severity, "info", "未超阈值时应为 info");
});

// ============================================================================
// G18. createGraphGuard 工厂函数
// ============================================================================

test("G18. createGraphGuard() 返回 GraphGuardProtocol 实例", () => {
  const guard = createGraphGuard();
  assert.ok(guard, "工厂函数应返回非空实例");
  assert.equal(typeof guard.validateGraph, "function", "实例应有 validateGraph 方法");
  assert.equal(typeof guard.checkPreExecution, "function", "实例应有 checkPreExecution 方法");
  assert.equal(typeof guard.checkPostExecution, "function", "实例应有 checkPostExecution 方法");
});

test("G18b. createGraphGuard() 返回的实例可正常工作", () => {
  const guard: GraphGuardProtocol = createGraphGuard();
  const graph = makeLinearGraph();
  const result = guard.validateGraph(graph);
  assert.equal(result.valid, true, "工厂函数创建的实例应正常工作");
});

// ============================================================================
// G19. validateGraph 复杂图（多分支 + 合并）
// ============================================================================

test("G19. validateGraph 分支合并图校验通过", () => {
  const guard = new GraphGuardImpl();
  // start → fork → (branchA, branchB) → merge → end
  const graph: WorkGraph = {
    graphId: "g1",
    name: "分支合并图",
    description: "fork-merge 测试图",
    nodes: new Map([
      ["start", makeTaskNode("start")],
      [
        "fork",
        { nodeId: "fork", nodeType: "fork", label: "fork", task: "并行派发", inputContract: [], outputContract: [] },
      ],
      ["branchA", makeTaskNode("branchA")],
      ["branchB", makeTaskNode("branchB")],
      [
        "merge",
        { nodeId: "merge", nodeType: "merge", label: "merge", task: "合并", inputContract: [], outputContract: [] },
      ],
      ["end", makeEndNode("end")],
    ]),
    edges: [
      { edgeId: "e1", from: "start", to: "fork", dataMapping: {} },
      { edgeId: "e2", from: "fork", to: "branchA", dataMapping: {} },
      { edgeId: "e3", from: "fork", to: "branchB", dataMapping: {} },
      { edgeId: "e4", from: "branchA", to: "merge", dataMapping: {} },
      { edgeId: "e5", from: "branchB", to: "merge", dataMapping: {} },
      { edgeId: "e6", from: "merge", to: "end", dataMapping: {} },
    ],
    entryNodeId: "start",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const result = guard.validateGraph(graph);
  assert.equal(result.valid, true, "分支合并图应校验通过");
  assert.equal(result.isCyclic, false, "分支合并图不应有环");
  assert.equal(result.unreachableNodes.length, 0, "分支合并图不应有不可达节点");
});
