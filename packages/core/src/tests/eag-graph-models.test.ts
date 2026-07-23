/**
 * EAG-Graph Phase 2 单元测试：核心数据模型（graph-loop-models.ts）
 *
 * 测试范围：
 * - M1. 类型与常量：GraphNodeType / GRAPH_NODE_TYPES / GraphSchedulingAction / GRAPH_SCHEDULING_ACTIONS
 * - M2. WorkGraph / WorkGraphConfig 接口结构 + DEFAULT_WORK_GRAPH_CONFIG 默认值
 * - M3. GraphNodeDef / NodeFieldContract 接口结构
 * - M4. GraphEdgeDef 接口结构
 * - M5. NodeLoopConfig 接口结构 + DEFAULT_NODE_LOOP_CONFIG 默认值
 * - M6. GraphNodeResult / GraphRunReport 接口结构
 * - M7. GraphRunContext / GraphValidationResult / GraphGuardCheckResult / GraphGuardRecord 接口结构
 * - M8. GraphSchedulingDecision / GraphRunStatus / ExperienceCase 接口结构
 * - M9. PredicateRegistry / GraphLogger 接口结构（接口形状校验）
 * - M10. RetrySuppressionConfig 接口结构 + createRetrySuppressionConfig 工厂函数
 *   - M10a. 默认值计算（nodeRetryLimit × nodeCount × 2）
 *   - M10b. 部分覆盖
 *   - M10c. 冻结保证（Object.isFrozen）
 *   - M10d. 非法 nodeCount 抛错
 *   - M10e. 非法 nodeRetryLimit 抛错
 *   - M10f. nodeCount=0 时 maxTotalRetries 至少为 1
 * - M11. 不可变保证：常量 Object.isFrozen
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - 测试用例独立、可重复
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §7 核心数据模型、§7.6 支持类型、§11.2 调度动作、§11.4 双层重试抑制
 * - eag/graph/graph-loop-models.ts 源文件
 *
 * @module core/tests/eag-graph-models
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_NODE_TYPES,
  GRAPH_SCHEDULING_ACTIONS,
  DEFAULT_WORK_GRAPH_CONFIG,
  DEFAULT_NODE_LOOP_CONFIG,
  createRetrySuppressionConfig,
} from "../eag/graph/graph-loop-models";
import type {
  WorkGraph,
  WorkGraphConfig,
  GraphNodeDef,
  NodeFieldContract,
  GraphEdgeDef,
  NodeLoopConfig,
  GraphNodeResult,
  GraphRunReport,
  GraphRunContext,
  GraphValidationResult,
  GraphGuardCheckResult,
  GraphGuardRecord,
  GraphSchedulingDecision,
  GraphRunStatus,
  ExperienceCase,
  PredicateRegistry,
  GraphLogger,
  PredicateFunction,
  RetrySuppressionConfig,
  GraphNodeType,
  GraphSchedulingAction,
} from "../eag/graph/graph-loop-models";

// ============================================================================
// M1. 类型与常量：GraphNodeType / GRAPH_NODE_TYPES
// ============================================================================

test("M1a: GRAPH_NODE_TYPES 包含全部 6 种节点类型", () => {
  assert.equal(GRAPH_NODE_TYPES.length, 6);
  const expected: ReadonlyArray<GraphNodeType> = ["loop", "task", "decision", "merge", "fork", "end"];
  assert.deepEqual([...GRAPH_NODE_TYPES], [...expected]);
});

test("M1b: GRAPH_NODE_TYPES 冻结保证", () => {
  assert.equal(Object.isFrozen(GRAPH_NODE_TYPES), true);
});

test("M1c: GRAPH_SCHEDULING_ACTIONS 包含全部 7 种调度动作", () => {
  assert.equal(GRAPH_SCHEDULING_ACTIONS.length, 7);
  const expected: ReadonlyArray<GraphSchedulingAction> = [
    "next_node",
    "retry_node",
    "isolate_node",
    "human_checkpoint",
    "stop_success",
    "stop_failure",
    "stop_timeout",
  ];
  assert.deepEqual([...GRAPH_SCHEDULING_ACTIONS], [...expected]);
});

test("M1d: GRAPH_SCHEDULING_ACTIONS 冻结保证", () => {
  assert.equal(Object.isFrozen(GRAPH_SCHEDULING_ACTIONS), true);
});

// ============================================================================
// M2. WorkGraph / WorkGraphConfig 接口结构 + DEFAULT_WORK_GRAPH_CONFIG
// ============================================================================

test("M2a: DEFAULT_WORK_GRAPH_CONFIG 包含全部 7 个字段", () => {
  const config = DEFAULT_WORK_GRAPH_CONFIG;
  assert.equal(typeof config.maxDepth, "number");
  assert.equal(typeof config.maxParallelism, "number");
  assert.equal(typeof config.maxTokens, "number");
  assert.equal(typeof config.timeoutSec, "number");
  assert.equal(typeof config.enableExperienceRecall, "boolean");
  assert.equal(typeof config.enableAutoIsolation, "boolean");
  assert.equal(typeof config.nodeRetryLimit, "number");
});

test("M2b: DEFAULT_WORK_GRAPH_CONFIG 默认值符合设计文档 §7.1", () => {
  const config = DEFAULT_WORK_GRAPH_CONFIG;
  assert.equal(config.maxDepth, 100, "maxDepth 默认应为 100");
  assert.equal(config.maxParallelism, 4, "maxParallelism 默认应为 4");
  assert.equal(config.maxTokens, 0, "maxTokens 默认应为 0（不限制）");
  assert.equal(config.timeoutSec, 0, "timeoutSec 默认应为 0（不限制）");
  assert.equal(config.enableExperienceRecall, false, "enableExperienceRecall 默认应为 false");
  assert.equal(config.enableAutoIsolation, true, "enableAutoIsolation 默认应为 true");
  assert.equal(config.nodeRetryLimit, 3, "nodeRetryLimit 默认应为 3");
});

test("M2c: DEFAULT_WORK_GRAPH_CONFIG 冻结保证", () => {
  assert.equal(Object.isFrozen(DEFAULT_WORK_GRAPH_CONFIG), true);
});

test("M2d: WorkGraph 接口可构造真实实例", () => {
  const nodes = new Map<string, GraphNodeDef>();
  const graph: WorkGraph = {
    graphId: "test-graph-1",
    name: "测试图",
    description: "用于测试的图定义",
    nodes,
    edges: [],
    entryNodeId: "start",
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };
  assert.equal(graph.graphId, "test-graph-1");
  assert.equal(graph.nodes.size, 0);
  assert.equal(graph.edges.length, 0);
});

// ============================================================================
// M3. GraphNodeDef / NodeFieldContract 接口结构
// ============================================================================

test("M3a: NodeFieldContract 接口可构造真实实例", () => {
  const contract: NodeFieldContract = {
    name: "designDoc",
    type: "string",
    required: true,
    description: "设计文档",
  };
  assert.equal(contract.name, "designDoc");
  assert.equal(contract.type, "string");
  assert.equal(contract.required, true);
});

test("M3b: GraphNodeDef 接口可构造完整实例（含契约和 Loop 配置）", () => {
  const node: GraphNodeDef = {
    nodeId: "design-1",
    nodeType: "loop",
    label: "设计阶段",
    task: "根据需求生成设计文档",
    inputContract: [{ name: "requirement", type: "string", required: true }],
    outputContract: [{ name: "designDoc", type: "string", required: true }],
    loopConfig: DEFAULT_NODE_LOOP_CONFIG,
    description: "设计 Loop 节点",
  };
  assert.equal(node.nodeId, "design-1");
  assert.equal(node.nodeType, "loop");
  assert.equal(node.inputContract.length, 1);
  assert.equal(node.outputContract.length, 1);
  assert.ok(node.loopConfig);
});

test("M3c: GraphNodeDef decision 节点支持 decisionPredicateId", () => {
  const node: GraphNodeDef = {
    nodeId: "decision-1",
    nodeType: "decision",
    label: "决策节点",
    task: "根据复杂度选择分支",
    inputContract: [],
    outputContract: [],
    decisionPredicateId: "complexity-based-choice",
  };
  assert.equal(node.decisionPredicateId, "complexity-based-choice");
  assert.equal(node.loopConfig, undefined);
});

// ============================================================================
// M4. GraphEdgeDef 接口结构
// ============================================================================

test("M4a: GraphEdgeDef 接口可构造真实实例（含 dataMapping）", () => {
  const edge: GraphEdgeDef = {
    edgeId: "e1",
    from: "design",
    to: "coding",
    dataMapping: { designDoc: "output.designDoc", apiSpec: "output.apiSpec" },
  };
  assert.equal(edge.edgeId, "e1");
  assert.equal(edge.from, "design");
  assert.equal(edge.to, "coding");
  assert.equal(Object.keys(edge.dataMapping).length, 2);
});

test("M4b: GraphEdgeDef 支持可选 activationPredicateId", () => {
  const edge: GraphEdgeDef = {
    edgeId: "e2",
    from: "decision",
    to: "fast-path",
    dataMapping: {},
    activationPredicateId: "is-fast",
  };
  assert.equal(edge.activationPredicateId, "is-fast");
});

// ============================================================================
// M5. NodeLoopConfig + DEFAULT_NODE_LOOP_CONFIG
// ============================================================================

test("M5a: DEFAULT_NODE_LOOP_CONFIG 包含全部 9 个字段", () => {
  const cfg = DEFAULT_NODE_LOOP_CONFIG;
  assert.equal(cfg.loopType, "coding");
  assert.equal(cfg.discoveryMode, "auto");
  assert.equal(cfg.evaluatorMode, "strict");
  assert.equal(cfg.maxIterations, 10);
  assert.equal(cfg.maxTokens, 100_000);
  assert.equal(cfg.stopWhen, "");
  assert.equal(cfg.autoCommit, false);
  assert.equal(cfg.humanCheckpointEvery, 0);
  assert.deepEqual([...cfg.stageOrder], ["plan", "dev", "verify", "fix"]);
});

test("M5b: DEFAULT_NODE_LOOP_CONFIG 冻结保证", () => {
  assert.equal(Object.isFrozen(DEFAULT_NODE_LOOP_CONFIG), true);
});

test("M5c: NodeLoopConfig 接口可构造自定义实例", () => {
  const cfg: NodeLoopConfig = {
    loopType: "design",
    discoveryMode: "manual",
    evaluatorMode: "standard",
    maxIterations: 5,
    maxTokens: 50_000,
    stopWhen: "设计文档通过评审",
    stageOrder: ["plan", "dev"],
    autoCommit: true,
    humanCheckpointEvery: 2,
  };
  assert.equal(cfg.loopType, "design");
  assert.equal(cfg.maxIterations, 5);
});

// ============================================================================
// M6. GraphNodeResult / GraphRunReport 接口结构
// ============================================================================

test("M6a: GraphNodeResult 接口可构造 completed 状态实例", () => {
  const result: GraphNodeResult = {
    nodeId: "design-1",
    nodeType: "loop",
    status: "completed",
    output: { designDoc: "设计文档内容" },
    durationSec: 12.5,
    retryCount: 0,
  };
  assert.equal(result.status, "completed");
  assert.equal(result.output.designDoc, "设计文档内容");
});

test("M6b: GraphNodeResult 接口可构造 failed 状态实例（含 failureReason）", () => {
  const result: GraphNodeResult = {
    nodeId: "coding-1",
    nodeType: "loop",
    status: "failed",
    output: {},
    durationSec: 30.0,
    retryCount: 2,
    failureReason: "测试未通过",
  };
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "测试未通过");
});

test("M6c: GraphRunReport 接口可构造完整实例", () => {
  const nodeResults = new Map<string, GraphNodeResult>();
  const report: GraphRunReport = {
    runId: "run-001",
    graphId: "test-graph-1",
    finalStatus: "completed",
    traversalPath: ["start", "end"],
    nodeResults,
    totalIterations: 5,
    totalLlmCallCount: 10,
    totalTokensUsed: 5000,
    durationSec: 60.0,
    triggeredGuards: [],
    finalReport: "# 执行报告",
    finalGlobalState: {},
  };
  assert.equal(report.runId, "run-001");
  assert.equal(report.finalStatus, "completed");
  assert.equal(report.traversalPath.length, 2);
});

// ============================================================================
// M7. GraphRunContext / GraphValidationResult / GraphGuardCheckResult / GraphGuardRecord
// ============================================================================

test("M7a: GraphRunContext 接口可构造完整实例", () => {
  const fakeRegistry = createFakePredicateRegistry();
  const ctx: GraphRunContext = {
    runId: "run-001",
    graphId: "test-graph-1",
    globalState: { userId: "u1" },
    visited: new Set<string>(),
    nodeResults: new Map<string, GraphNodeResult>(),
    cancelled: false,
    config: DEFAULT_WORK_GRAPH_CONFIG,
    predicateRegistry: fakeRegistry,
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  };
  assert.equal(ctx.runId, "run-001");
  assert.equal(ctx.cancelled, false);
  assert.equal(ctx.currentDepth, 0);
  assert.equal(ctx.globalState.userId, "u1");
});

test("M7b: GraphValidationResult 接口可构造 valid=true 实例", () => {
  const result: GraphValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    isCyclic: false,
    unreachableNodes: [],
  };
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("M7c: GraphValidationResult 接口可构造 valid=false 实例", () => {
  const result: GraphValidationResult = {
    valid: false,
    errors: ["入口节点不存在"],
    warnings: ["存在环"],
    isCyclic: true,
    unreachableNodes: ["orphan-node"],
  };
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.isCyclic, true);
});

test("M7d: GraphGuardCheckResult 接口可构造 passed=false 实例", () => {
  const result: GraphGuardCheckResult = {
    passed: false,
    reason: "图级超时",
    suggestedAction: "stop_timeout",
    severity: "error",
  };
  assert.equal(result.passed, false);
  assert.equal(result.suggestedAction, "stop_timeout");
});

test("M7e: GraphGuardRecord 接口可构造完整实例", () => {
  const record: GraphGuardRecord = {
    recordId: "rec-001",
    guardName: "maxDepthGuard",
    triggerPhase: "pre",
    nodeId: "design-1",
    result: { passed: false, reason: "深度超限", severity: "error", suggestedAction: "stop_failure" },
    triggeredAt: new Date().toISOString(),
  };
  assert.equal(record.guardName, "maxDepthGuard");
  assert.equal(record.triggerPhase, "pre");
});

// ============================================================================
// M8. GraphSchedulingDecision / GraphRunStatus / ExperienceCase
// ============================================================================

test("M8a: GraphSchedulingDecision 接口可构造 next_node 决策", () => {
  const decision: GraphSchedulingDecision = {
    action: "next_node",
    reason: "节点执行成功",
    nextNodeIds: ["coding-1"],
    backoffSeconds: 0,
    requiresHumanInput: false,
  };
  assert.equal(decision.action, "next_node");
  assert.equal(decision.nextNodeIds.length, 1);
});

test("M8b: GraphSchedulingDecision 接口可构造 fork 决策（多个 nextNodeIds）", () => {
  const decision: GraphSchedulingDecision = {
    action: "next_node",
    reason: "fork 节点并行派发",
    nextNodeIds: ["branch-a", "branch-b", "branch-c"],
    backoffSeconds: 0,
    requiresHumanInput: false,
  };
  assert.equal(decision.nextNodeIds.length, 3);
});

test("M8c: GraphRunStatus 接口可构造 running 状态实例", () => {
  const status: GraphRunStatus = {
    runId: "run-001",
    status: "running",
    currentNodeId: "design-1",
    completedNodeCount: 2,
    totalNodeCount: 5,
    progressPercent: 40,
    totalTokensUsed: 2000,
    elapsedSec: 30.5,
    lastUpdatedAt: new Date().toISOString(),
  };
  assert.equal(status.status, "running");
  assert.equal(status.progressPercent, 40);
});

test("M8d: ExperienceCase 接口可构造成功案例", () => {
  const caseData: ExperienceCase = {
    caseId: "case-001",
    taskType: "coding",
    taskFeatures: { language: "typescript", complexity: "high" },
    strategy: "loop-with-strict-evaluator",
    success: true,
    executionTimeSec: 120.5,
    createdAt: new Date().toISOString(),
  };
  assert.equal(caseData.success, true);
  assert.equal(caseData.taskFeatures.language, "typescript");
});

test("M8e: ExperienceCase 接口可构造失败案例（含 failureReason）", () => {
  const caseData: ExperienceCase = {
    caseId: "case-002",
    taskType: "design",
    taskFeatures: { domain: "ecommerce" },
    strategy: "loop-with-manual-discovery",
    success: false,
    executionTimeSec: 60.0,
    failureReason: "需求不明确",
    nodeId: "design-1",
    graphRunId: "run-001",
    createdAt: new Date().toISOString(),
  };
  assert.equal(caseData.success, false);
  assert.equal(caseData.failureReason, "需求不明确");
});

// ============================================================================
// M9. PredicateRegistry / GraphLogger 接口形状校验
// ============================================================================

test("M9a: PredicateRegistry 接口形状校验（register/lookup/has）", () => {
  const registry = createFakePredicateRegistry();
  assert.equal(typeof registry.register, "function");
  assert.equal(typeof registry.lookup, "function");
  assert.equal(typeof registry.has, "function");
});

test("M9b: GraphLogger 接口形状校验（debug/info/warn/error）", () => {
  const logger: GraphLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  assert.equal(typeof logger.debug, "function");
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.warn, "function");
  assert.equal(typeof logger.error, "function");
});

test("M9c: PredicateFunction 签名可赋值返回 string（decision 节点用）", () => {
  const fn: PredicateFunction = (_input, _ctx) => "edge-to-fast-path";
  assert.equal(typeof fn, "function");
});

test("M9d: PredicateFunction 签名可赋值返回 boolean（边条件激活用）", () => {
  const fn: PredicateFunction = (input, _ctx) => input.score === 100;
  assert.equal(typeof fn, "function");
});

// ============================================================================
// M10. createRetrySuppressionConfig 工厂函数
// ============================================================================

test("M10a: createRetrySuppressionConfig 默认值计算（nodeRetryLimit × nodeCount × 2）", () => {
  const cfg = createRetrySuppressionConfig(10, 3);
  assert.equal(cfg.maxTotalRetries, 60, "maxTotalRetries 应为 3 × 10 × 2 = 60");
  assert.equal(cfg.maxIterationsPerNode, 20, "maxIterationsPerNode 默认 20");
  assert.equal(cfg.consecutiveNodeFailureThreshold, 3, "consecutiveNodeFailureThreshold 默认 3");
  assert.equal(cfg.backoffStrategy, "max", "backoffStrategy 默认 max");
});

test("M10b: createRetrySuppressionConfig 支持部分覆盖", () => {
  const cfg = createRetrySuppressionConfig(5, 2, { maxIterationsPerNode: 15 });
  assert.equal(cfg.maxTotalRetries, 20, "maxTotalRetries 应为 2 × 5 × 2 = 20");
  assert.equal(cfg.maxIterationsPerNode, 15, "maxIterationsPerNode 被覆盖为 15");
});

test("M10c: createRetrySuppressionConfig 冻结保证", () => {
  const cfg = createRetrySuppressionConfig(3, 1);
  assert.equal(Object.isFrozen(cfg), true);
});

test("M10d: createRetrySuppressionConfig 非法 nodeCount 抛错", () => {
  assert.throws(() => createRetrySuppressionConfig(-1, 3), /nodeCount 必须为非负整数/);
  assert.throws(() => createRetrySuppressionConfig(1.5, 3), /nodeCount 必须为非负整数/);
});

test("M10e: createRetrySuppressionConfig 非法 nodeRetryLimit 抛错", () => {
  assert.throws(() => createRetrySuppressionConfig(10, -1), /nodeRetryLimit 必须为非负整数/);
  assert.throws(() => createRetrySuppressionConfig(10, 1.5), /nodeRetryLimit 必须为非负整数/);
});

test("M10f: createRetrySuppressionConfig nodeCount=0 时 maxTotalRetries 至少为 1", () => {
  const cfg = createRetrySuppressionConfig(0, 3);
  assert.equal(cfg.maxTotalRetries, 1, "nodeCount=0 时 maxTotalRetries 应为 max(1, 0) = 1");
});

// ============================================================================
// M11. 不可变保证：常量 Object.isFrozen
// ============================================================================

test("M11: 所有导出常量均冻结", () => {
  assert.equal(Object.isFrozen(GRAPH_NODE_TYPES), true);
  assert.equal(Object.isFrozen(GRAPH_SCHEDULING_ACTIONS), true);
  assert.equal(Object.isFrozen(DEFAULT_WORK_GRAPH_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_NODE_LOOP_CONFIG), true);
});

// ============================================================================
// 辅助函数：创建测试用 PredicateRegistry 桩（非 mock，真实实现接口）
// ============================================================================

/**
 * 创建测试用 PredicateRegistry 实例
 *
 * 注意：这不是 mock，而是真实实现 PredicateRegistry 接口的最简实例，
 * 用于 GraphRunContext 构造时填充 predicateRegistry 字段。
 * 本测试文件不测试谓词注册表本身的功能（那在 eag-graph-predicate-registry.test.ts 中测试）。
 */
function createFakePredicateRegistry(): PredicateRegistry {
  const map = new Map<string, PredicateFunction>();
  return {
    register(id, fn) {
      map.set(id, fn);
    },
    lookup(id) {
      const fn = map.get(id);
      if (!fn) throw new Error(`谓词未注册: ${id}`);
      return fn;
    },
    has(id) {
      return map.has(id);
    },
  };
}
