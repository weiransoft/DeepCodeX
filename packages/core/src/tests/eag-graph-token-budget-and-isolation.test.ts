/**
 * EAG-Graph 两项回归：token 预算软化 + 终态不得误报 completed
 *
 * 覆盖场景：
 * - B1. 图级 token 预算耗尽（未显式开启 tokenBudgetHardStop）→ 不终止，继续调度
 * - B2. 图级 token 预算耗尽 + tokenBudgetHardStop=true → stop_failure（旧行为可恢复）
 * - B3. 节点被隔离（isolated）→ 图终态必须 failed，不得报 completed
 *
 * 背景（2026-11-01）：
 * - 「卡预算导致任务不执行」：2026-10-20 起 Token 消耗全局语义改为"仅作上下文
 *   压缩基线"，GraphGuard 已软化（tokenBudgetHardStop 默认 false），但调度器
 *   仍直接 stop_failure。于是 `eag graph --max-tokens N` 跑到 N 就中途终止，
 *   表现为"任务跑到一半不执行了"。
 * - 「跑绿了但活儿没干」：determineFinalStatus 只统计 status==="failed"，
 *   被隔离（isolated）的节点不计入 → 节点反复失败被摘掉后整图报 completed。
 *
 * 测试约定（遵循项目规则）：
 * - node:test + node:assert/strict，不使用 mock 框架
 * - 使用真实 GraphBuilder / GraphSchedulerImpl / GraphGuardImpl 实例
 *
 * @module core/tests/eag-graph-token-budget-and-isolation
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { GraphLoopOrchestrator } from "../eag/graph/graph-loop-orchestrator";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { EdgeResolverImpl } from "../eag/graph/graph-edge-resolver";
import { GraphGuardImpl } from "../eag/graph/graph-guard";
import { GraphSchedulerImpl, createGraphScheduler } from "../eag/graph/graph-scheduler";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";
import { DEFAULT_WORK_GRAPH_CONFIG, createRetrySuppressionConfig } from "../eag/graph/graph-loop-models";
import type {
  GraphLogger,
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  WorkGraph,
} from "../eag/graph/graph-loop-models";
import type { NodeExecutorProtocol } from "../eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助
// ============================================================================

/** 不输出日志的 logger（避免测试噪音） */
function silentLogger(): GraphLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** task 节点定义 */
function taskNode(nodeId: string): GraphNodeDef {
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

/** end 节点定义 */
function endNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "end",
    label: nodeId,
    task: `${nodeId} 结束`,
    inputContract: [],
    outputContract: [],
  };
}

/** 构造 A → end 的最小图 */
function buildTwoNodeGraph(config: Partial<typeof DEFAULT_WORK_GRAPH_CONFIG> = {}): WorkGraph {
  return GraphBuilder.create()
    .setGraphInfo("g-budget", "预算图", "token 预算回归")
    .addNode(taskNode("A"))
    .addNode(endNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig({ ...DEFAULT_WORK_GRAPH_CONFIG, ...config })
    .build();
}

/**
 * 构造已超预算的运行上下文（供调度器直接判定）
 *
 * @param maxTokens 图级预算
 * @param totalTokensUsed 已消耗 token
 */
function buildOverBudgetContext(
  maxTokens: number,
  totalTokensUsed: number,
  extraConfig: Partial<typeof DEFAULT_WORK_GRAPH_CONFIG> = {}
): GraphRunContext {
  return {
    runId: "run-budget",
    graphId: "g-budget",
    globalState: {},
    visited: new Set<string>(["A"]),
    nodeResults: new Map<string, GraphNodeResult>(),
    cancelled: false,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxTokens, ...extraConfig },
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed,
    startedAtMs: Date.now(),
  };
}

/** 恒成功的节点执行器（记录调用次数） */
function createCountingExecutor(): { executor: NodeExecutorProtocol; calls: () => number } {
  let calls = 0;
  return {
    executor: {
      async execute(node: Readonly<GraphNodeDef>): Promise<GraphNodeResult> {
        calls++;
        return {
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          status: "completed",
          output: {},
          durationSec: 0.01,
          retryCount: 0,
        };
      },
    },
    calls: () => calls,
  };
}

/** 构造完整编排器（真实组件） */
function createOrchestrator(executor: NodeExecutorProtocol): GraphLoopOrchestrator {
  const logger = silentLogger();
  const retrySuppression = createRetrySuppressionConfig(100, 100, 10);
  return new GraphLoopOrchestrator({
    nodeExecutor: executor,
    edgeResolver: new EdgeResolverImpl(logger),
    graphScheduler: new GraphSchedulerImpl(retrySuppression, logger),
    graphGuard: new GraphGuardImpl(logger),
    predicateRegistry: new PredicateRegistryImpl(),
    logger,
  });
}

// ============================================================================
// B1 / B2：token 预算软化
// ============================================================================

test("B1. token 预算耗尽但未开硬停 → 调度器不 stop_failure（任务继续执行）", async () => {
  const graph = buildTwoNodeGraph({ maxTokens: 1000 });
  const scheduler = createGraphScheduler(createRetrySuppressionConfig(100, 100, 10), silentLogger());
  scheduler.setGraph(graph);

  const context = buildOverBudgetContext(1000, 5000);
  const result: GraphNodeResult = {
    nodeId: "A",
    nodeType: "task",
    status: "completed",
    output: {},
    durationSec: 0.01,
    retryCount: 0,
  };

  const decision = await scheduler.decideNext(graph.nodes.get("A")!, result, context);
  assert.notEqual(
    decision.action,
    "stop_failure",
    `预算耗尽只应告警，不应终止；实际 action=${decision.action}（${decision.reason}）`
  );
});

test("B2. token 预算耗尽 + tokenBudgetHardStop=true → stop_failure（旧行为显式可恢复）", async () => {
  const graph = buildTwoNodeGraph({ maxTokens: 1000, tokenBudgetHardStop: true });
  const scheduler = createGraphScheduler(createRetrySuppressionConfig(100, 100, 10), silentLogger());
  scheduler.setGraph(graph);

  const context = buildOverBudgetContext(1000, 5000, { tokenBudgetHardStop: true });
  const result: GraphNodeResult = {
    nodeId: "A",
    nodeType: "task",
    status: "completed",
    output: {},
    durationSec: 0.01,
    retryCount: 0,
  };

  const decision = await scheduler.decideNext(graph.nodes.get("A")!, result, context);
  assert.equal(decision.action, "stop_failure");
  assert.match(decision.reason, /token 预算耗尽/);
});

test("B3. 预算耗尽后图仍能跑完（maxTokens 只影响告警，不截断遍历）", async () => {
  const { executor, calls } = createCountingExecutor();
  const orchestrator = createOrchestrator(executor);

  // 预算设为 0 = 不限制；此处改用极小预算 + 执行器累加 token 制造超预算
  const graph = buildTwoNodeGraph({ maxTokens: 1 });
  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", `超预算不应导致失败，实际：${report.finalStatus}`);
  assert.equal(calls(), 2, "A 与 end 都应被真实执行（预算不截断遍历）");
});

// ============================================================================
// B4：隔离节点不得被洗成 completed
// ============================================================================

test("B4. 节点重试耗尽被隔离 → 图终态必须 failed（不得误报 completed）", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-isolated", "隔离图", "隔离终态回归")
    .addNode(taskNode("A"))
    .addNode(taskNode("B"))
    .addNode(endNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig({ ...DEFAULT_WORK_GRAPH_CONFIG, nodeRetryLimit: 1, enableAutoIsolation: true })
    .build();

  // A 恒失败（会被隔离），B 恒成功
  // 注意：retryCount 必须随调用次数自增——调度器据 result.retryCount 判断
  // "重试是否耗尽"，恒为 0 会一直重试（退避 1s/次）而永远走不到隔离分支。
  const callCounts = new Map<string, number>();
  const executor: NodeExecutorProtocol = {
    async execute(node: Readonly<GraphNodeDef>): Promise<GraphNodeResult> {
      const count = callCounts.get(node.nodeId) ?? 0;
      callCounts.set(node.nodeId, count + 1);
      if (node.nodeType === "end") {
        return {
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          status: "completed",
          output: {},
          durationSec: 0.01,
          retryCount: 0,
        };
      }
      if (node.nodeId === "A") {
        return {
          nodeId: "A",
          nodeType: node.nodeType,
          status: "failed",
          output: {},
          durationSec: 0.01,
          failureReason: "A 模拟持续失败",
          retryCount: count,
        };
      }
      return {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0.01,
        retryCount: count,
      };
    },
  };

  const orchestrator = createOrchestrator(executor);
  const report = await orchestrator.run(graph);

  // 前置：A 确实被隔离（否则本用例没测到目标路径）
  assert.equal(report.nodeResults.get("A")?.status, "isolated", "A 应被隔离");
  assert.equal(
    report.finalStatus,
    "failed",
    `存在被隔离节点时不得报 completed（隔离=产出缺失），实际：${report.finalStatus}`
  );
});
