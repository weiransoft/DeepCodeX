/**
 * EAG 全量审查修复回归测试（第 1 组：long-horizon 状态重放 / graph fork / 自建循环无进展判定）
 *
 * 覆盖审查项：
 * - P0-1 ① human-intervention 事件重放后 status==="human-checkpoint" 且 blockedReason 保留；
 *         两套重放（load 完整重放 / listRuns 轻量重放）口径一致。
 * - P0-1 ② /eag-resume 能触发 human-intervention-resolved 分支（标记上次介入为已解决）。
 * - P0-2 ③ fork 分支执行会调用 pre/post guard，且分支结果纳入 decideNext 与 nodeRetryCounts
 *         （不再硬编码 retryCount:0）。
 * - P1   ④ 自建循环连续无进展达阈值时判失败而非成功（含降级单轨 / 双轨探索型 / 开关回退）。
 * - P1   ⑤ team/plugins/loop.ts 达 max-iterations 不报 success（含开关回退）。
 *
 * 测试约定（遵循项目「禁止 mock 框架」规则）：
 * - node:test + node:assert/strict
 * - 使用真实 RunStateStore / EagResumeHandler / LoopKernel / GraphLoopOrchestrator 等实例，
 *   协作组件用「真实类型的轻量实现 + 闭包 spy」（非 mock 框架产物）
 * - 真实临时文件系统 I/O（fs.mkdtempSync + finally 清理）
 *
 * @module core/tests/eag-long-horizon-review-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RunStateStore } from "../eag/long-horizon/run-state-store";
import { EagResumeHandler } from "../eag/long-horizon/eag-resume-handler";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { MilestoneTagger, HealthScoreCalculator } from "../eag/long-horizon/milestone-tagger";
import { BlockageAnalyzer } from "../eag/long-horizon/blockage-analyzer";
import type { MultiLoopPlan } from "../eag/long-horizon/types";

import { LoopKernel, NoProgressDetector } from "../eag/loop/kernel";
import { LoopScheduler } from "../eag/loop/scheduler";
import { createLoopEngineeringConfig } from "../eag/loop/models";
import type {
  DiscoveryResult,
  HandoffItem,
  GeneratorResult,
  LoopEvaluationVerdict,
  LoopEvent,
  LoopEngineeringConfig,
} from "../eag/loop/models";
import type {
  DiscoveryProbeProtocol,
  HandoffAdapterProtocol,
  IndependentEvaluatorProtocol,
  UnifiedMemoryLayerProtocol,
} from "../eag/loop/protocols";

import { GraphLoopOrchestrator } from "../eag/graph/graph-loop-orchestrator";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";
import { DEFAULT_WORK_GRAPH_CONFIG } from "../eag/graph/graph-loop-models";
import type {
  WorkGraph,
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  GraphLogger,
} from "../eag/graph/graph-loop-models";

import { LoopPlugin } from "../team/plugins/loop";

// ============================================================================
// 通用辅助
// ============================================================================

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const silentGraphLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as GraphLogger;

// ============================================================================
// ① human-intervention 事件重放后 status==="human-checkpoint" 且 blockedReason 保留
// ============================================================================

test("① human-intervention 重放置 human-checkpoint 并保留 blockedReason（两套重放一致）", async () => {
  const projectRoot = makeTempDir("eag-review-replay-");
  try {
    const store = new RunStateStore();
    const runId = "review-replay-1";
    await store.initialize({ runId, projectRoot });
    await store.appendEvent(runId, {
      type: "human-intervention",
      payload: { loopType: "coding", reason: "spec.md 待人工批准", decision: "pending" },
    });

    // 完整重放（load / appendEvent 共用）
    const state = await store.load(runId, projectRoot);
    assert.equal(state.status, "human-checkpoint", "load() 应重建出 human-checkpoint");
    assert.equal(state.blockedReason, "spec.md 待人工批准", "blockedReason 不得丢失");
    assert.equal(state.humanInterventionCount, 1);

    // 轻量重放（listRuns / buildSummaryFromFile）口径必须与完整重放一致
    const summaries = await store.listRuns(projectRoot);
    const summary = summaries.find((s) => s.runId === runId);
    assert.ok(summary, "listRuns 应包含该 run");
    assert.equal(summary!.status, "human-checkpoint", "轻量重放同样应为 human-checkpoint");

    // human-intervention-resolved 后恢复 running 且清空 blockedReason
    await store.appendEvent(runId, {
      type: "human-intervention-resolved",
      payload: { index: 0, decision: "批准" },
    });
    const resolved = await store.load(runId, projectRoot);
    assert.equal(resolved.status, "running", "resolved 后应恢复 running");
    assert.equal(resolved.blockedReason, undefined, "resolved 后 blockedReason 应清空");
    assert.equal(resolved.humanInterventions[0]!.resolved, true);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// ② /eag-resume 能触发 human-intervention-resolved 分支
// ============================================================================

test("② resume 从 human-checkpoint 恢复并触发 human-intervention-resolved 分支", async () => {
  const projectRoot = makeTempDir("eag-review-resume-");
  try {
    const store = new RunStateStore();
    const runId = "review-resume-1";
    await store.initialize({ runId, projectRoot });
    await store.appendEvent(runId, {
      type: "human-intervention",
      payload: { loopType: "design", reason: "需要确认设计", decision: "pending" },
    });

    // 前置校验：load() 必须重建出 human-checkpoint，否则分支无从触发
    const before = await store.load(runId, projectRoot);
    assert.equal(before.status, "human-checkpoint");

    const plan: MultiLoopPlan = Object.freeze({
      planId: runId,
      projectRoot,
      loops: Object.freeze([
        Object.freeze({
          nodeId: "design-1",
          loopType: "design" as const,
          dependencies: Object.freeze([]) as ReadonlyArray<string>,
          status: "completed" as const,
          entryArtifact: "docs/spec.md",
          exitCriteria: "G-5 passed",
        }),
      ]) as MultiLoopPlan["loops"],
      autoTransition: true,
      rollbackOnFailure: true,
      createdAt: new Date().toISOString(),
    });

    const handler = new EagResumeHandler({
      runStateStore: store,
      multiLoopPlanner: new MultiLoopPlanner(),
      milestoneTagger: new MilestoneTagger(store, undefined, {
        regressionTestCommand: 'node -e "console.log(1)"',
        regressionTestTimeoutSec: 30,
        healthScoreCalculator: new HealthScoreCalculator(),
      }),
      blockageAnalyzer: new BlockageAnalyzer(store),
    });

    // 复用原 plan + 已完成节点集合，使恢复阶段跳过所有节点、聚焦状态机分支
    const stubExecutor = {
      loopType: "design" as const,
      async execute() {
        return {
          nodeId: "design-1",
          loopType: "design" as const,
          finalStatus: "completed" as const,
          generatedArtifacts: {},
          llmCallCount: 0,
          tokensUsed: 0,
          durationSec: 0,
        };
      },
    };

    await handler.handle({
      runId,
      projectRoot,
      userIntent: "订单管理微服务",
      loopExecutors: [stubExecutor],
      userDecision: "批准 spec.md 继续执行",
      plan,
      completedNodeIds: ["design-1"],
    });

    const after = await store.load(runId, projectRoot);
    assert.equal(after.humanInterventionCount, 1, "不应重复追加介入记录");
    assert.equal(
      after.humanInterventions[0]!.resolved,
      true,
      "resume 必须触发 human-intervention-resolved 分支（标记上次介入已解决）"
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// ③ fork 分支执行会调用 pre/post guard 且计入 retry 预算
// ============================================================================

function makeTaskNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务`,
    inputContract: [],
    outputContract: [],
    plugin: "echo",
  } as GraphNodeDef;
}
function makeForkNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "fork",
    label: nodeId,
    task: "并行派发",
    inputContract: [],
    outputContract: [],
  } as GraphNodeDef;
}
function makeMergeNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "merge",
    label: nodeId,
    task: "合并",
    inputContract: [],
    outputContract: [],
  } as GraphNodeDef;
}
function makeEndNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "end",
    label: nodeId,
    task: "结束",
    inputContract: [],
    outputContract: [],
  } as GraphNodeDef;
}

test("③ fork 分支执行会调用 pre/post guard、纳入 decideNext 与 nodeRetryCounts", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-fork-review", "fork guard 测试", "审查修复")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "C", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig({ ...DEFAULT_WORK_GRAPH_CONFIG, maxParallelism: 2 })
    .build();

  const preGuardCalls: string[] = [];
  const postGuardCalls: string[] = [];
  const decideNextCalls: string[] = [];
  const executedNodes: string[] = [];

  // spy guard：仅实现 executeFork 用到的两个方法，真实返回「通过」结果
  const spyGuard = {
    checkPreExecution: (node: Readonly<GraphNodeDef>) => {
      preGuardCalls.push(node.nodeId);
      return { passed: true, reason: "", severity: "info" };
    },
    checkPostExecution: (node: Readonly<GraphNodeDef>) => {
      postGuardCalls.push(node.nodeId);
      return { passed: true, reason: "", severity: "info" };
    },
  };
  // spy scheduler：对分支结果一律返回 retry_node，以验证 retry 预算被累计
  const spyScheduler = {
    async decideNext(node: Readonly<GraphNodeDef>) {
      decideNextCalls.push(node.nodeId);
      return { action: "retry_node", reason: "test", nextNodeIds: [], backoffSeconds: 0 };
    },
    setGraph: () => undefined,
  };
  // spy executor：结果故意不带 retryCount，交由 fork 逻辑从重试预算补齐
  const spyExecutor = {
    async execute(node: Readonly<GraphNodeDef>): Promise<GraphNodeResult> {
      executedNodes.push(node.nodeId);
      return {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0,
      } as GraphNodeResult;
    },
  };
  const spyEdgeResolver = { resolve: () => ({}) };

  const orchestrator = new GraphLoopOrchestrator({
    nodeExecutor: spyExecutor as never,
    edgeResolver: spyEdgeResolver as never,
    graphScheduler: spyScheduler as never,
    graphGuard: spyGuard as never,
    predicateRegistry: new PredicateRegistryImpl(),
    logger: silentGraphLogger,
  });

  const context = {
    runId: "r-fork-review",
    graphId: "g-fork-review",
    globalState: {},
    visited: new Set<string>(),
    nodeResults: new Map<string, GraphNodeResult>(),
    cancelled: false,
    config: { ...DEFAULT_WORK_GRAPH_CONFIG, maxParallelism: 2 },
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  } as unknown as GraphRunContext;

  // 预置重试预算，验证 fork 分支不再硬编码 retryCount:0
  const nodeRetryCounts = new Map<string, number>([
    ["B", 2],
    ["C", 0],
  ]);
  const forkNode = graph.nodes.get("fork1")!;

  // 白盒调用 private executeFork（private 仅编译期约束），精确验证分支护栏与预算
  const forkResults = await (
    orchestrator as unknown as {
      executeFork: (
        forkNode: Readonly<GraphNodeDef>,
        graph: Readonly<WorkGraph>,
        context: GraphRunContext,
        nodeRetryCounts: Map<string, number>
      ) => Promise<ReadonlyArray<GraphNodeResult>>;
    }
  ).executeFork(forkNode, graph, context, nodeRetryCounts);

  assert.deepEqual(executedNodes.sort(), ["B", "C"], "两个分支都应被执行");
  // pre guard 必须在分支执行前调用
  assert.ok(preGuardCalls.includes("B") && preGuardCalls.includes("C"), `pre guard 应覆盖分支，实际=${preGuardCalls}`);
  // post guard 必须在分支执行后调用
  assert.ok(
    postGuardCalls.includes("B") && postGuardCalls.includes("C"),
    `post guard 应覆盖分支，实际=${postGuardCalls}`
  );
  // 分支结果必须纳入 decideNext
  assert.ok(
    decideNextCalls.includes("B") && decideNextCalls.includes("C"),
    `decideNext 应覆盖分支，实际=${decideNextCalls}`
  );
  // retry 预算被累计（2+1=3 / 0+1=1），而非固定 0
  assert.equal(nodeRetryCounts.get("B"), 3, "B 的 retry 预算应被累计");
  assert.equal(nodeRetryCounts.get("C"), 1, "C 的 retry 预算应被累计");
  const resultB = forkResults.find((r) => r.nodeId === "B");
  const resultC = forkResults.find((r) => r.nodeId === "C");
  assert.equal(resultB?.retryCount, 3, "B 分支结果 retryCount 应反映重试预算");
  assert.equal(resultC?.retryCount, 1, "C 分支结果 retryCount 应反映重试预算");
});

// ============================================================================
// ④ 自建循环连续无进展达阈值时判失败而非成功
// ============================================================================

// LoopKernel 真实轻量协作组件（对齐 eag-loop-kernel.test.ts 的实现方式）
class StaticDiscoveryProbe implements DiscoveryProbeProtocol {
  discover(): DiscoveryResult {
    return {
      objective: "test",
      inputs: {},
      contextFeatures: {},
      relevantSkills: [],
      detectedRisks: [],
      inferredGoal: "",
      worktreeRequired: false,
      suggestedAgents: [],
      suggestedPatterns: [],
      artifactsToRead: [],
      timestamp: "2026-01-01T00:00:00.000Z",
    } as DiscoveryResult;
  }
}

class StaticHandoffAdapter implements HandoffAdapterProtocol {
  createWorkItems(): HandoffItem[] {
    return [
      {
        itemId: "wi-1",
        agentType: "solo-coder",
        task: "test",
        acceptanceCriteria: [],
        worktreePath: null,
        dependencies: [],
        metadata: {},
      } as HandoffItem,
    ];
  }
  execute(): GeneratorResult {
    // 固定结果：每轮输出完全一致，构成「结果重复且无变化」的无进展空转
    return {
      success: true,
      test_result: { passed: true, summary: "ok" },
      modified_files: [],
      committed_count: 0,
    } as unknown as GeneratorResult;
  }
}

class PassingEvaluator implements IndependentEvaluatorProtocol {
  evaluate(): LoopEvaluationVerdict {
    return {
      passed: true,
      evaluatorId: "passing",
      reason: "通过",
      findings: [],
      severity: "info",
      suggestedFix: "",
      sampledArtifacts: [],
    } as LoopEvaluationVerdict;
  }
}

class InMemoryMemory implements UnifiedMemoryLayerProtocol {
  private readonly stored: LoopEvent[] = [];
  persistEvent(event: LoopEvent): void {
    this.stored.push(event);
  }
  query(): Array<Readonly<Record<string, unknown>>> {
    return [];
  }
  estimateTokenUsage(): number {
    return 0;
  }
}

test("④ 自建循环连续无进展达阈值时判失败（降级单轨，含报告说明）", () => {
  const projectRoot = makeTempDir("eag-review-noprogress-"); // 非 git 仓库 → 降级单轨
  try {
    const config = createLoopEngineeringConfig({
      maxIterations: 8,
      maxTokens: 100_000,
      stopWhen: "",
      projectRoot,
      // 关闭「通过即停」，让 verdict.passed 时持续 continue，模拟空转到 maxIterations 前
      extra: { stop_when_empty_means_stop: false },
    } as Partial<LoopEngineeringConfig>);
    const kernel = new LoopKernel(
      config,
      new StaticDiscoveryProbe(),
      new StaticHandoffAdapter(),
      new PassingEvaluator(),
      new InMemoryMemory(),
      new LoopScheduler(config)
    );

    const report = kernel.run("无进展空转测试");

    assert.equal(report.finalStatus, "failed", "连续无进展空转必须诚实判失败，绝不报 completed");
    assert.ok(report.finalSummary.includes("无进展"), "报告应说明无进展熔断");
    assert.ok(report.finalSummary.includes("降级"), "报告应说明已降级为单轨判定");
  } finally {
    rmrf(projectRoot);
  }
});

test("④-b NoProgressDetector 双轨 / 降级 / 开关回退", () => {
  // 轨道 A（结果重复，降级单轨）：阈值 limit+1
  const degraded = new NoProgressDetector({ limit: 2, enabled: true, degraded: true });
  let last = degraded.observe({ resultFingerprint: "same", workspaceSnapshot: null, hasSuccessfulWrite: false });
  assert.equal(last.stalled, false);
  last = degraded.observe({ resultFingerprint: "same", workspaceSnapshot: null, hasSuccessfulWrite: false });
  assert.equal(last.stalled, false);
  last = degraded.observe({ resultFingerprint: "same", workspaceSnapshot: null, hasSuccessfulWrite: false });
  assert.equal(last.stalled, true, "降级单轨连续相同结果达阈值应判无进展");
  assert.equal(last.degraded, true);
  assert.ok(String(last.cause).includes("降级"), "cause 应说明降级");

  // 轨道 B（输出变化但工作区无变化、git 可用）：探索型空转，阈值 limit+2
  const exploring = new NoProgressDetector({
    limit: 2,
    enabled: true,
    degraded: false,
    startWorkspaceSnapshot: "clean",
  });
  let v = { stalled: false, cause: "" };
  for (let i = 0; i < 4; i += 1) {
    const verdict = exploring.observe({
      resultFingerprint: `fingerprint-${i}`, // 每轮都不同
      workspaceSnapshot: "clean", // 工作区始终无变化
      hasSuccessfulWrite: false,
    });
    v = { stalled: verdict.stalled, cause: verdict.cause ?? "" };
  }
  assert.equal(v.stalled, true, "探索型空转达阈值应判无进展");
  assert.ok(v.cause.includes("探索型"), "cause 应说明探索型空转");

  // 真进展清零：工作区快照变化不应误判
  const progressing = new NoProgressDetector({
    limit: 2,
    enabled: true,
    degraded: false,
    startWorkspaceSnapshot: "snapshot-0",
  });
  let pStalled = false;
  for (let i = 0; i < 6; i += 1) {
    const verdict = progressing.observe({
      resultFingerprint: "same",
      workspaceSnapshot: `snapshot-${i}`, // 每轮都变化
      hasSuccessfulWrite: false,
    });
    pStalled = pStalled || verdict.stalled;
  }
  assert.equal(pStalled, false, "工作区持续变化是真进展，不应误判无进展");

  // 开关回退：enabled=false 时保持旧行为（仅靠轮数上限）
  const disabled = new NoProgressDetector({ limit: 2, enabled: false, degraded: true });
  for (let i = 0; i < 6; i += 1) {
    const verdict = disabled.observe({ resultFingerprint: "same", workspaceSnapshot: null, hasSuccessfulWrite: false });
    assert.equal(verdict.stalled, false, "开关关闭时不得触发无进展熔断");
  }
});

// ============================================================================
// ⑤ team/plugins/loop.ts 达 max-iterations 不报 success
// ============================================================================

function makePluginContext(): Record<string, unknown> & { state: Record<string, unknown> } {
  return {
    projectRoot: process.cwd(),
    task: { taskId: "review-task" },
    dispatch: { dispatchId: "review-dispatch", plugin: "loop" },
    registry: {},
    dispatcher: {},
    dryRun: false,
    cancelled: false,
    state: {
      loop: true,
      loopStep: () => "working", // 永不命中退出条件
      loopExitWhen: "done",
      loopMaxIterations: 3,
      loopBackoffBase: 0,
      loopBackoffMax: 0,
    },
    events: [],
    startTime: Date.now(),
    deadlineMs: 0,
    log: () => undefined,
    extensions: {},
  };
}

test("⑤ LoopPlugin 达 max-iterations 不报 succeeded（含开关回退）", async () => {
  const ctx = makePluginContext();
  const plugin = new LoopPlugin();
  const result = await plugin.execute(ctx as never);

  assert.equal(result.status, "failed", "达 max-iterations 未达成退出条件，必须诚实判失败");
  assert.equal(ctx.state["loopExitReason"], "max-iterations");
  assert.equal((ctx.state["loopHistory"] as unknown[]).length, 3);

  // 开关可回退到旧行为
  const prev = process.env["DEEPCODE_LOOP_REPORT_MAX_ITER_AS_SUCCESS"];
  process.env["DEEPCODE_LOOP_REPORT_MAX_ITER_AS_SUCCESS"] = "1";
  try {
    const ctx2 = makePluginContext();
    const result2 = await new LoopPlugin().execute(ctx2 as never);
    assert.equal(result2.status, "succeeded", "开关开启时回退旧行为");
  } finally {
    if (prev === undefined) delete process.env["DEEPCODE_LOOP_REPORT_MAX_ITER_AS_SUCCESS"];
    else process.env["DEEPCODE_LOOP_REPORT_MAX_ITER_AS_SUCCESS"] = prev;
  }
});
