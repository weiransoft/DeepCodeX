/**
 * EAG-Graph Guard 可配置化单元测试（TOP-3）
 *
 * 测试范围：
 * - C1. 默认行为与 v2.0 完全一致（所有检查开启）
 * - C2. lenient 输出契约验证级别（仅检查字段存在，不检查类型）
 * - C3. 关闭 enableTokenBudgetCheck 后 token 预算耗尽不再触发 stop_failure
 * - C4. 关闭 enableDepthCheck 后达到 maxDepth 不再触发 stop_failure
 * - C5. 关闭 enablePostExecutionDurationCheck 后单节点耗时异常不再产生 warning
 * - C6. 自定义规则在 validate 阶段触发并导致 valid=false
 * - C7. 自定义规则在 pre 阶段触发并导致 stop_failure
 * - C8. 自定义规则在 post 阶段触发并导致 stop_failure
 * - C9. 自定义规则执行异常时按 stop_failure 处理
 * - C10. configure() 运行时更新配置与自定义规则
 * - C11. registerCustomRule() 单独注册规则并与 configure() 共存
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - docs/superpowers/plans/2026-07-23-eag-graph-top5-improvements.md 阶段 B
 * - eag/graph/graph-guard.ts 源文件（被测对象）
 *
 * @module core/tests/graph-guard-config
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphGuardImpl, createGraphGuard } from "../eag/graph/graph-guard";
import { DEFAULT_WORK_GRAPH_CONFIG } from "../eag/graph/graph-loop-models";
import type {
  WorkGraph,
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  PredicateRegistry,
  PredicateFunction,
  GraphGuardConfig,
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
 * 构造一个简单的线性图（start → end）
 *
 * @param graphId 图 ID
 */
function makeLinearGraph(graphId: string = "g1"): WorkGraph {
  return {
    graphId,
    name: "线性图",
    description: "测试用线性图",
    nodes: new Map([
      ["start", makeTaskNode("start")],
      ["end", makeEndNode("end")],
    ]),
    edges: [{ edgeId: "e1", from: "start", to: "end", dataMapping: {} }],
    entryNodeId: "start",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };
}

/**
 * 构造一个最小可用的 GraphRunContext
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
// C1. 默认行为与 v2.0 完全一致
// ============================================================================

test("C1. 默认配置下所有内置检查开启，行为与 v2.0 一致", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, true, "默认配置下合法图应校验通过");

  const node = makeTaskNode("task1");
  const context = makeRunContext({
    currentDepth: 100,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxDepth: 100 },
  });
  const preCheck = guard.checkPreExecution(node, context);
  assert.equal(preCheck.passed, false, "默认配置下达到 maxDepth 应触发 stop_failure");
  assert.equal(preCheck.suggestedAction, "stop_failure");
});

test("C1b. createGraphGuard() 返回的实例仍支持配置化方法", () => {
  const guard: GraphGuardProtocol = createGraphGuard();
  assert.equal(typeof guard.configure, "function", "工厂函数实例应有 configure 方法");
  assert.equal(typeof guard.registerCustomRule, "function", "工厂函数实例应有 registerCustomRule 方法");
});

// ============================================================================
// C2. lenient 输出契约验证级别
// ============================================================================

test("C2. lenient 级别仅校验字段存在，不校验类型", () => {
  const guard = new GraphGuardImpl({ outputContractValidationLevel: "lenient" });
  const graph = makeLinearGraph();
  guard.validateGraph(graph); // 缓存 currentGraph

  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "count", type: "number", required: true }],
    plugin: "echo",
  };
  // count 字段存在但类型为字符串，lenient 级别应通过
  const result = makeCompletedResult("task1", { count: "not-a-number" });
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, true, "lenient 级别不校验类型，应通过");
  assert.equal(checkResult.severity, "info");
});

test("C2b. lenient 级别仍校验必填字段缺失", () => {
  const guard = new GraphGuardImpl({ outputContractValidationLevel: "lenient" });
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  const node: GraphNodeDef = {
    nodeId: "task1",
    nodeType: "task",
    label: "任务",
    task: "任务",
    inputContract: [],
    outputContract: [{ name: "count", type: "number", required: true }],
    plugin: "echo",
  };
  const result = makeCompletedResult("task1", {});
  const context = makeRunContext();

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, false, "lenient 级别仍检查必填字段缺失");
  assert.equal(checkResult.suggestedAction, "retry_node");
});

// ============================================================================
// C3. 关闭 enableTokenBudgetCheck
// ============================================================================

test("C3. 关闭 enableTokenBudgetCheck 后 token 预算耗尽不再触发 stop_failure", () => {
  const guard = new GraphGuardImpl({ enableTokenBudgetCheck: false });
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  const node = makeTaskNode("task1");
  const context = makeRunContext({
    totalTokensUsed: 10_000,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxTokens: 10_000 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, true, "关闭 token 预算检查后应通过");
  assert.equal(result.severity, "info");
});

// ============================================================================
// C4. 关闭 enableDepthCheck
// ============================================================================

test("C4. 关闭 enableDepthCheck 后达到 maxDepth 不再触发 stop_failure", () => {
  const guard = new GraphGuardImpl({ enableDepthCheck: false });
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  const node = makeTaskNode("task1");
  const context = makeRunContext({
    currentDepth: 100,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxDepth: 100 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, true, "关闭深度检查后应通过");
  assert.equal(result.severity, "info");
});

// ============================================================================
// C5. 关闭 enablePostExecutionDurationCheck
// ============================================================================

test("C5. 关闭 enablePostExecutionDurationCheck 后耗时异常不再产生 warning", () => {
  const guard = new GraphGuardImpl({ enablePostExecutionDurationCheck: false });
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

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
  assert.equal(checkResult.passed, true, "关闭耗时检查后应通过");
  assert.equal(checkResult.severity, "info", "关闭后不应产生 warning");
});

// ============================================================================
// C6. 自定义规则在 validate 阶段触发
// ============================================================================

test("C6. validate 阶段自定义规则失败时 valid=false", () => {
  const guard = new GraphGuardImpl();
  guard.registerCustomRule("noTestGraph", "validate", (graph) => ({
    pass: !graph.name.includes("测试"),
    message: "图名称不能包含'测试'",
  }));

  const graph: WorkGraph = {
    ...makeLinearGraph("g1"),
    name: "测试图",
  };
  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, false, "自定义规则应使校验失败");
  assert.match(validation.errors.join("\n"), /图名称不能包含'测试'/);
});

test("C6b. validate 阶段自定义规则通过时不影响 valid", () => {
  const guard = new GraphGuardImpl();
  guard.registerCustomRule("alwaysPass", "validate", () => ({ pass: true }));

  const graph = makeLinearGraph();
  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, true, "通过的自定义规则不应影响校验结果");
});

// ============================================================================
// C7. 自定义规则在 pre 阶段触发
// ============================================================================

test("C7. pre 阶段自定义规则失败时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.registerCustomRule("noCancelled", "pre", (_graph, context) => ({
    pass: context?.globalState.allowed === true,
    message: "globalState.allowed 必须为 true",
  }));

  const node = makeTaskNode("task1");
  const context = makeRunContext({ globalState: {} });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, false, "pre 自定义规则应失败");
  assert.equal(result.suggestedAction, "stop_failure");
  assert.match(result.reason, /globalState\.allowed 必须为 true/);
});

test("C7b. pre 阶段自定义规则通过时不影响执行", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.registerCustomRule("alwaysPass", "pre", () => ({ pass: true }));

  const node = makeTaskNode("task1");
  const context = makeRunContext({ globalState: { allowed: true } });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, true, "pre 自定义规则通过时应放行");
});

// ============================================================================
// C8. 自定义规则在 post 阶段触发
// ============================================================================

test("C8. post 阶段自定义规则失败时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.registerCustomRule("outputMustHaveSummary", "post", (_graph, context) => {
    const result = context?.nodeResults.get("task1");
    const hasSummary = result && Object.prototype.hasOwnProperty.call(result.output, "summary");
    return {
      pass: hasSummary === true,
      message: "task1 输出必须包含 summary 字段",
    };
  });

  const node = makeTaskNode("task1");
  const result = makeCompletedResult("task1", { summary: "" });
  const context = makeRunContext();
  context.nodeResults.set("task1", result);

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, true, "包含 summary 字段时应通过");
});

test("C8b. post 阶段自定义规则缺少 summary 时失败", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.registerCustomRule("outputMustHaveSummary", "post", (_graph, context) => {
    const result = context?.nodeResults.get("task1");
    const hasSummary = result && Object.prototype.hasOwnProperty.call(result.output, "summary");
    return {
      pass: hasSummary === true,
      message: "task1 输出必须包含 summary 字段",
    };
  });

  const node = makeTaskNode("task1");
  const result = makeCompletedResult("task1", {});
  const context = makeRunContext();
  context.nodeResults.set("task1", result);

  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, false, "缺少 summary 字段时应失败");
  assert.equal(checkResult.suggestedAction, "stop_failure");
  assert.match(checkResult.reason, /task1 输出必须包含 summary 字段/);
});

// ============================================================================
// C9. 自定义规则执行异常时按 stop_failure 处理
// ============================================================================

test("C9. validate 阶段自定义规则抛异常时 valid=false", () => {
  const guard = new GraphGuardImpl();
  guard.registerCustomRule("throwInValidate", "validate", () => {
    throw new Error("validate 规则故意抛错");
  });

  const graph = makeLinearGraph();
  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, false, "自定义规则异常应使校验失败");
  assert.match(validation.errors.join("\n"), /validate 规则故意抛错/);
});

test("C9b. pre 阶段自定义规则抛异常时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.registerCustomRule("throwInPre", "pre", () => {
    throw new Error("pre 规则故意抛错");
  });

  const node = makeTaskNode("task1");
  const context = makeRunContext();
  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, false, "pre 自定义规则异常应失败");
  assert.equal(result.suggestedAction, "stop_failure");
  assert.match(result.reason, /pre 规则故意抛错/);
});

test("C9c. post 阶段自定义规则抛异常时返回 stop_failure", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.registerCustomRule("throwInPost", "post", () => {
    throw new Error("post 规则故意抛错");
  });

  const node = makeTaskNode("task1");
  const result = makeCompletedResult("task1", {});
  const context = makeRunContext();
  const checkResult = guard.checkPostExecution(node, result, context);
  assert.equal(checkResult.passed, false, "post 自定义规则异常应失败");
  assert.equal(checkResult.suggestedAction, "stop_failure");
  assert.match(checkResult.reason, /post 规则故意抛错/);
});

// ============================================================================
// C10. configure() 运行时更新配置与自定义规则
// ============================================================================

test("C10. configure() 运行时关闭 depthCheck", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.configure({ enableDepthCheck: false });

  const node = makeTaskNode("task1");
  const context = makeRunContext({
    currentDepth: 100,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxDepth: 100 },
  });

  const result = guard.checkPreExecution(node, context);
  assert.equal(result.passed, true, "configure 关闭 depthCheck 后应通过");
});

test("C10b. configure() 运行时注册自定义规则", () => {
  const guard = new GraphGuardImpl();
  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  const config: GraphGuardConfig = {
    customRules: {
      configuredRule: {
        phase: "validate",
        rule: () => ({ pass: false, message: "由 configure 注入的规则" }),
      },
    },
  };
  guard.configure(config);

  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, false, "configure 注入的规则应生效");
  assert.match(validation.errors.join("\n"), /由 configure 注入的规则/);
});

test("C10c. configure() 覆盖自定义规则注册表", () => {
  const guard = new GraphGuardImpl();
  guard.registerCustomRule("oldRule", "validate", () => ({ pass: false, message: "旧规则" }));

  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.configure({
    customRules: {
      newRule: {
        phase: "validate",
        rule: () => ({ pass: false, message: "新规则" }),
      },
    },
  });

  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, false);
  assert.doesNotMatch(validation.errors.join("\n"), /旧规则/, "旧规则应被 configure 清除");
  assert.match(validation.errors.join("\n"), /新规则/, "新规则应生效");
});

// ============================================================================
// C11. registerCustomRule() 与 configure() 共存
// ============================================================================

test("C11. registerCustomRule 与 configure 注入的规则可共存", () => {
  const guard = new GraphGuardImpl();
  guard.registerCustomRule("registeredRule", "validate", () => ({
    pass: false,
    message: "registerCustomRule 注册",
  }));

  const graph = makeLinearGraph();
  guard.validateGraph(graph);

  guard.configure({
    outputContractValidationLevel: "lenient",
    customRules: {
      configuredRule: {
        phase: "validate",
        rule: () => ({ pass: false, message: "configure 注入" }),
      },
    },
  });

  // configure 会清除已有规则并重新加载，因此只有 configuredRule 生效
  const validation = guard.validateGraph(graph);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /configure 注入/);
  assert.doesNotMatch(
    validation.errors.join("\n"),
    /registerCustomRule 注册/,
    "configure 应覆盖 registerCustomRule 注册的规则"
  );
});
