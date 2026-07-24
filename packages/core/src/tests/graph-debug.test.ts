/**
 * 图调试器单元测试（TOP-5 图调试工具）
 *
 * 测试范围：
 * - A. createGraphDebugger 工厂函数
 *   - A1. logLevel=off 或未提供时返回 NoOpDebugger
 *   - A2. logLevel=info/debug/trace 时返回 DefaultGraphDebugger
 * - B. NoOpDebugger 空实现
 *   - B1. 所有 trace 方法不抛异常
 *   - B2. getExecutionSnapshot 返回空事件数组
 * - C. DefaultGraphDebugger 基本事件记录
 *   - C1. traceNodeStart / traceNodeComplete 产生事件
 *   - C2. getExecutionSnapshot 推导 completedNodes / failedNodes / currentNodeId
 *   - C3. reset 清空事件并切换 runId
 * - D. DefaultGraphDebugger 日志级别过滤
 *   - D1. off 级别不记录事件
 *   - D2. info 级别记录 complete / fork / merge / failure，不记录 start
 *   - D3. debug 级别记录 start + complete / fork / merge / failure
 *   - D4. trace 级别记录所有事件
 * - E. DefaultGraphDebugger guard 事件
 *   - E1. guard 未通过时 info 级别也记录
 *   - E2. guard 通过且 info 级别默认不记录
 *   - E3. guard 通过且 debug 级别记录
 *   - E4. includeGuardPassedEvents=true 时 guard 通过也记录
 * - F. 敏感数据脱敏
 *   - F1. input 中 apiKey / token 等敏感字段被脱敏
 *   - F2. output 中敏感字段被脱敏
 *   - F3. failureReason 中敏感字段被脱敏
 * - G. 输入输出快照控制
 *   - G1. trace 级别且 includeNodeSnapshots=false 时不保留原始 input/output
 *   - G2. trace 级别且 includeNodeSnapshots=true 时保留脱敏后的快照
 * - H. 环形缓冲区（maxEvents）
 *   - H1. 事件数超过 maxEvents 时丢弃最旧事件
 * - I. 跨运行隔离
 *   - I1. reset 后旧事件不再出现在快照中
 * - J. fork / merge / failure 事件
 *   - J1. traceForkStart / traceForkComplete 产生 fork 事件
 *   - J2. traceMerge 产生 merge 事件
 *   - J3. traceFailure 产生 failure 事件
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 不使用 mock 框架，使用真实的 DefaultGraphDebugger / NoOpDebugger 实例
 * - 中文注释
 *
 * @module core/tests/graph-debug
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  GraphGuardCheckResult,
  GraphDebugLogLevel,
  PredicateRegistry,
  WorkGraphConfig,
} from "../eag/graph/graph-loop-models";
import { createGraphDebugger, DefaultGraphDebugger, NoOpDebugger } from "../eag/graph/graph-debug";

// ============================================================================
// 1. 测试辅助函数
// ============================================================================

/**
 * 构造一个最小化的图节点定义
 *
 * @param nodeId 节点 ID
 * @param nodeType 节点类型（默认 task）
 * @returns 图节点定义
 */
function makeNode(nodeId: string, nodeType: GraphNodeDef["nodeType"] = "task"): GraphNodeDef {
  return {
    nodeId,
    nodeType,
    label: `节点 ${nodeId}`,
    task: "测试任务",
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一个最小化的图运行上下文
 *
 * @param runId 运行 ID
 * @param graphId 图 ID
 * @returns 图运行上下文
 */
function makeContext(runId: string, graphId: string): GraphRunContext {
  const config: WorkGraphConfig = {
    maxDepth: 100,
    maxParallelism: 4,
    maxTokens: 0,
    timeoutSec: 0,
    enableExperienceRecall: false,
    enableAutoIsolation: true,
    nodeRetryLimit: 3,
  };
  return {
    runId,
    graphId,
    globalState: {},
    visited: new Set<string>(),
    nodeResults: new Map<string, GraphNodeResult>(),
    cancelled: false,
    config,
    predicateRegistry: {} as PredicateRegistry,
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  };
}

/**
 * 构造一个最小化的节点执行结果
 *
 * @param nodeId 节点 ID
 * @param status 执行状态
 * @param output 输出数据（可选）
 * @param failureReason 失败原因（可选）
 * @returns 节点执行结果
 */
function makeResult(
  nodeId: string,
  status: GraphNodeResult["status"],
  output: Record<string, unknown> = {},
  failureReason?: string
): GraphNodeResult {
  return {
    nodeId,
    nodeType: "task",
    status,
    output,
    durationSec: 0.1,
    retryCount: 0,
    failureReason,
  };
}

/**
 * 构造一个图级护栏检查结果
 *
 * @param passed 是否通过
 * @param severity 严重级别
 * @param reason 原因
 * @returns 护栏检查结果
 */
function makeGuard(
  passed: boolean,
  severity: GraphGuardCheckResult["severity"],
  reason: string
): GraphGuardCheckResult {
  return {
    passed,
    reason,
    severity,
  };
}

// ============================================================================
// A. createGraphDebugger 工厂函数测试
// ============================================================================

test("A1. 未提供选项时返回 NoOpDebugger", () => {
  const debuggerInstance = createGraphDebugger();
  assert.ok(debuggerInstance instanceof NoOpDebugger);
});

test("A2. logLevel=off 时返回 NoOpDebugger", () => {
  const debuggerInstance = createGraphDebugger({ logLevel: "off" });
  assert.ok(debuggerInstance instanceof NoOpDebugger);
});

test("A3. logLevel=info 时返回 DefaultGraphDebugger", () => {
  const debuggerInstance = createGraphDebugger({ logLevel: "info" });
  assert.ok(debuggerInstance instanceof DefaultGraphDebugger);
});

test("A4. logLevel=debug 时返回 DefaultGraphDebugger", () => {
  const debuggerInstance = createGraphDebugger({ logLevel: "debug" });
  assert.ok(debuggerInstance instanceof DefaultGraphDebugger);
});

test("A5. logLevel=trace 时返回 DefaultGraphDebugger", () => {
  const debuggerInstance = createGraphDebugger({ logLevel: "trace" });
  assert.ok(debuggerInstance instanceof DefaultGraphDebugger);
});

// ============================================================================
// B. NoOpDebugger 空实现测试
// ============================================================================

test("B1. NoOpDebugger 所有 trace 方法不抛异常", () => {
  const debuggerInstance = new NoOpDebugger();
  const node = makeNode("noop-node");
  const context = makeContext("run-1", "graph-1");
  const result = makeResult("noop-node", "completed");
  const guard = makeGuard(true, "info", "测试通过");

  assert.doesNotThrow(() => debuggerInstance.configure({ logLevel: "debug" }));
  assert.doesNotThrow(() => debuggerInstance.reset("run-2"));
  assert.doesNotThrow(() => debuggerInstance.traceNodeStart(node, {}, context));
  assert.doesNotThrow(() => debuggerInstance.traceNodeComplete(node, result, context));
  assert.doesNotThrow(() => debuggerInstance.traceForkStart(node, ["a", "b"], context));
  assert.doesNotThrow(() => debuggerInstance.traceForkComplete(node, [result], context));
  assert.doesNotThrow(() => debuggerInstance.traceMerge(node, [result], context));
  assert.doesNotThrow(() => debuggerInstance.traceFailure(node, result, context));
  assert.doesNotThrow(() => debuggerInstance.traceGuard(node, guard, "pre", context));
});

test("B2. NoOpDebugger getExecutionSnapshot 返回空事件数组", () => {
  const debuggerInstance = new NoOpDebugger();
  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.runId, "");
  assert.equal(snapshot.graphId, "");
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.completedNodes.length, 0);
  assert.equal(snapshot.failedNodes.length, 0);
});

// ============================================================================
// C. DefaultGraphDebugger 基本事件记录测试
// ============================================================================

test("C1. traceNodeStart / traceNodeComplete 产生事件", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "debug" });
  debuggerInstance.reset("run-1");
  const context = makeContext("run-1", "graph-1");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed", { answer: 42 });

  debuggerInstance.traceNodeStart(node, { answer: 42 }, context);
  debuggerInstance.traceNodeComplete(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[0].phase, "start");
  assert.equal(snapshot.events[0].nodeId, "node-1");
  assert.equal(snapshot.events[1].phase, "complete");
  assert.equal(snapshot.events[1].nodeId, "node-1");
});

test("C2. getExecutionSnapshot 正确推导 completedNodes / currentNodeId", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "debug" });
  debuggerInstance.reset("run-2");
  const context = makeContext("run-2", "graph-2");
  const node = makeNode("node-a");
  const result = makeResult("node-a", "completed");

  debuggerInstance.traceNodeStart(node, {}, context);
  debuggerInstance.traceNodeComplete(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.runId, "run-2");
  assert.equal(snapshot.graphId, "graph-2");
  assert.equal(snapshot.currentNodeId, "node-a");
  assert.deepEqual(snapshot.completedNodes, ["node-a"]);
  assert.deepEqual(snapshot.failedNodes, []);
});

test("C3. reset 清空事件并切换 runId", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "debug" });
  debuggerInstance.reset("run-3");
  const context1 = makeContext("run-3", "graph-3");
  const node = makeNode("node-1");

  debuggerInstance.traceNodeStart(node, {}, context1);
  assert.equal(debuggerInstance.getExecutionSnapshot().events.length, 1);

  debuggerInstance.reset("run-4");
  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.runId, "run-4");
  assert.equal(snapshot.events.length, 0);

  const context2 = makeContext("run-4", "graph-3");
  debuggerInstance.traceNodeComplete(node, makeResult("node-1", "completed"), context2);
  assert.equal(debuggerInstance.getExecutionSnapshot().events.length, 1);
  assert.equal(debuggerInstance.getExecutionSnapshot().events[0].runId, "run-4");
});

// ============================================================================
// D. DefaultGraphDebugger 日志级别过滤测试
// ============================================================================

test("D1. off 级别不记录任何事件", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "off" });
  debuggerInstance.reset("run-off");
  const context = makeContext("run-off", "graph-off");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed");

  debuggerInstance.traceNodeStart(node, {}, context);
  debuggerInstance.traceNodeComplete(node, result, context);
  debuggerInstance.traceFailure(node, makeResult("node-1", "failed", {}, "失败"), context);
  debuggerInstance.traceGuard(node, makeGuard(false, "error", "未通过"), "pre", context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 0);
});

test("D2. info 级别记录 complete / fork / merge / failure，不记录 start", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-info");
  const context = makeContext("run-info", "graph-info");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed");

  debuggerInstance.traceNodeStart(node, {}, context);
  debuggerInstance.traceNodeComplete(node, result, context);
  debuggerInstance.traceForkStart(node, ["branch-1"], context);
  debuggerInstance.traceMerge(node, [result], context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const phases = snapshot.events.map((e) => e.phase);
  assert.equal(phases.includes("start"), false);
  assert.equal(phases.includes("complete"), true);
  assert.equal(phases.includes("fork"), true);
  assert.equal(phases.includes("merge"), true);
});

test("D3. debug 级别记录 start + complete / fork / merge / failure", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "debug" });
  debuggerInstance.reset("run-debug");
  const context = makeContext("run-debug", "graph-debug");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed");

  debuggerInstance.traceNodeStart(node, {}, context);
  debuggerInstance.traceNodeComplete(node, result, context);
  debuggerInstance.traceForkStart(node, ["branch-1"], context);
  debuggerInstance.traceMerge(node, [result], context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const phases = snapshot.events.map((e) => e.phase);
  assert.equal(phases.includes("start"), true);
  assert.equal(phases.includes("complete"), true);
  assert.equal(phases.includes("fork"), true);
  assert.equal(phases.includes("merge"), true);
});

test("D4. trace 级别记录 guard 通过事件", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "trace" });
  debuggerInstance.reset("run-trace");
  const context = makeContext("run-trace", "graph-trace");
  const node = makeNode("node-1");

  debuggerInstance.traceGuard(node, makeGuard(true, "info", "通过"), "pre", context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].phase, "guard");
});

// ============================================================================
// E. DefaultGraphDebugger guard 事件测试
// ============================================================================

test("E1. guard 未通过时 info 级别记录", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-guard-fail");
  const context = makeContext("run-guard-fail", "graph-guard");

  debuggerInstance.traceGuard(makeNode("node-1"), makeGuard(false, "error", "未通过"), "pre", context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].phase, "guard");
});

test("E2. guard 通过且 info 级别默认不记录", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-guard-pass");
  const context = makeContext("run-guard-pass", "graph-guard");

  debuggerInstance.traceGuard(makeNode("node-1"), makeGuard(true, "info", "通过"), "pre", context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 0);
});

test("E3. guard 通过且 debug 级别记录", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "debug" });
  debuggerInstance.reset("run-guard-pass-debug");
  const context = makeContext("run-guard-pass-debug", "graph-guard");

  debuggerInstance.traceGuard(makeNode("node-1"), makeGuard(true, "info", "通过"), "pre", context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 1);
});

test("E4. includeGuardPassedEvents=true 时 guard 通过也记录", () => {
  const debuggerInstance = new DefaultGraphDebugger({
    logLevel: "info",
    includeGuardPassedEvents: true,
  });
  debuggerInstance.reset("run-guard-pass-include");
  const context = makeContext("run-guard-pass-include", "graph-guard");

  debuggerInstance.traceGuard(makeNode("node-1"), makeGuard(true, "info", "通过"), "pre", context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 1);
});

// ============================================================================
// F. 敏感数据脱敏测试
// ============================================================================

test("F1. input 中敏感字段被脱敏", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "trace", includeNodeSnapshots: true });
  debuggerInstance.reset("run-redact-input");
  const context = makeContext("run-redact-input", "graph-redact");
  const node = makeNode("node-1");

  debuggerInstance.traceNodeStart(node, { apiKey: "secret-key", normalField: "hello" }, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const event = snapshot.events[0];
  assert.equal(event.phase, "start");
  const metadata = event.metadata as Record<string, unknown>;
  assert.ok(metadata);
  const inputSnapshot = metadata.inputSnapshot as Record<string, unknown>;
  assert.ok(inputSnapshot);
  assert.equal(inputSnapshot.apiKey, "[REDACTED]");
  assert.equal(inputSnapshot.normalField, "hello");
});

test("F2. output 中敏感字段被脱敏", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "trace", includeNodeSnapshots: true });
  debuggerInstance.reset("run-redact-output");
  const context = makeContext("run-redact-output", "graph-redact");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed", { token: "bearer-token", value: 42 });

  debuggerInstance.traceNodeComplete(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const metadata = snapshot.events[0].metadata as Record<string, unknown>;
  const outputSnapshot = metadata.output as Record<string, unknown>;
  assert.equal(outputSnapshot.token, "[REDACTED]");
  assert.equal(outputSnapshot.value, 42);
});

test("F3. failureReason 中敏感字段被脱敏", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-redact-failure");
  const context = makeContext("run-redact-failure", "graph-redact");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "failed", {}, "认证失败：password=secret123");

  debuggerInstance.traceFailure(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const metadata = snapshot.events[0].metadata as Record<string, unknown>;
  const failureReason = metadata.failureReason as string;
  assert.ok(!failureReason.includes("secret123"));
  assert.ok(failureReason.includes("[REDACTED]"));
});

// ============================================================================
// G. 输入输出快照控制测试
// ============================================================================

test("G1. trace 级别但 includeNodeSnapshots=false 时不保留原始 input/output", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "trace", includeNodeSnapshots: false });
  debuggerInstance.reset("run-no-snapshot");
  const context = makeContext("run-no-snapshot", "graph-snapshot");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed", { answer: 42 });

  debuggerInstance.traceNodeStart(node, { answer: 42 }, context);
  debuggerInstance.traceNodeComplete(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const startMetadata = snapshot.events[0].metadata as Record<string, unknown>;
  const completeMetadata = snapshot.events[1].metadata as Record<string, unknown>;
  assert.equal(startMetadata.inputSnapshot, undefined);
  assert.equal(completeMetadata.output, undefined);
  assert.deepEqual(startMetadata.inputKeys, ["answer"]);
  assert.deepEqual(completeMetadata.outputKeys, ["answer"]);
});

test("G2. trace 级别且 includeNodeSnapshots=true 时保留脱敏快照", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "trace", includeNodeSnapshots: true });
  debuggerInstance.reset("run-with-snapshot");
  const context = makeContext("run-with-snapshot", "graph-snapshot");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "completed", { answer: 42 });

  debuggerInstance.traceNodeStart(node, { answer: 42 }, context);
  debuggerInstance.traceNodeComplete(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  const startMetadata = snapshot.events[0].metadata as Record<string, unknown>;
  const completeMetadata = snapshot.events[1].metadata as Record<string, unknown>;
  assert.deepEqual(startMetadata.inputSnapshot, { answer: 42 });
  assert.deepEqual(completeMetadata.output, { answer: 42 });
});

// ============================================================================
// H. 环形缓冲区（maxEvents）测试
// ============================================================================

test("H1. 事件数超过 maxEvents 时丢弃最旧事件", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info", maxEvents: 3 });
  debuggerInstance.reset("run-ring");
  const context = makeContext("run-ring", "graph-ring");

  debuggerInstance.traceNodeComplete(makeNode("node-1"), makeResult("node-1", "completed"), context);
  debuggerInstance.traceNodeComplete(makeNode("node-2"), makeResult("node-2", "completed"), context);
  debuggerInstance.traceNodeComplete(makeNode("node-3"), makeResult("node-3", "completed"), context);
  debuggerInstance.traceNodeComplete(makeNode("node-4"), makeResult("node-4", "completed"), context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 3);
  const nodeIds = snapshot.events.map((e) => e.nodeId);
  assert.deepEqual(nodeIds, ["node-2", "node-3", "node-4"]);
});

// ============================================================================
// I. 跨运行隔离测试
// ============================================================================

test("I1. reset 后旧事件不再出现在快照中", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-old");
  const contextOld = makeContext("run-old", "graph-iso");
  debuggerInstance.traceNodeComplete(makeNode("node-1"), makeResult("node-1", "completed"), contextOld);
  assert.equal(debuggerInstance.getExecutionSnapshot().events.length, 1);

  debuggerInstance.reset("run-new");
  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.runId, "run-new");
});

// ============================================================================
// J. fork / merge / failure 事件测试
// ============================================================================

test("J1. traceForkStart / traceForkComplete 产生 fork 事件", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-fork");
  const context = makeContext("run-fork", "graph-fork");
  const forkNode = makeNode("fork-node", "fork");
  const branchResults = [makeResult("branch-1", "completed"), makeResult("branch-2", "failed", {}, "分支失败")];

  debuggerInstance.traceForkStart(forkNode, ["branch-1", "branch-2"], context);
  debuggerInstance.traceForkComplete(forkNode, branchResults, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[0].phase, "fork");
  assert.equal(snapshot.events[0].nodeId, "fork-node");
  assert.equal(snapshot.events[1].phase, "fork");
  const completeMetadata = snapshot.events[1].metadata as Record<string, unknown>;
  const summary = completeMetadata.branchResults as Array<Record<string, unknown>>;
  assert.equal(summary.length, 2);
  assert.equal(summary[0].status, "completed");
  assert.equal(summary[1].status, "failed");
});

test("J2. traceMerge 产生 merge 事件", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-merge");
  const context = makeContext("run-merge", "graph-merge");
  const mergeNode = makeNode("merge-node", "merge");
  const upstreamResults = [makeResult("upstream-1", "completed"), makeResult("upstream-2", "completed")];

  debuggerInstance.traceMerge(mergeNode, upstreamResults, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].phase, "merge");
  assert.equal(snapshot.events[0].nodeId, "merge-node");
});

test("J3. traceFailure 产生 failure 事件并推导 failedNodes", () => {
  const debuggerInstance = new DefaultGraphDebugger({ logLevel: "info" });
  debuggerInstance.reset("run-failure");
  const context = makeContext("run-failure", "graph-failure");
  const node = makeNode("node-1");
  const result = makeResult("node-1", "failed", {}, "执行失败");

  debuggerInstance.traceFailure(node, result, context);

  const snapshot = debuggerInstance.getExecutionSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].phase, "failure");
  assert.deepEqual(snapshot.failedNodes, ["node-1"]);
  assert.deepEqual(snapshot.completedNodes, ["node-1"]);
});
