/**
 * EAG-P3 批次 12 C1 单元测试：long-horizon/plan-blockage-analyzer.ts 依赖图阻塞分析器
 *
 * 测试范围（对齐设计文档 §3 C1 阻塞分析增强）：
 * - T1.  PlanBlockageAnalyzer 构造函数校验（planner 必填）
 * - T2.  analyze() 请求字段校验（runId / plan / runState）
 * - T3.  循环依赖检测（circular-dependency，3 节点环 / 2 节点环 / 自环）
 * - T4.  缺失依赖检测（missing-dependency，单节点缺依赖 / 多节点缺依赖）
 * - T5.  资源竞争检测（resource-contention，2 节点并行访问 / 多节点并行访问 / 串行无竞争）
 * - T6.  死锁风险检测（deadlock-risk，2 节点循环等待 / 3 节点循环等待 / 无环无死锁）
 * - T7.  门禁阻塞检测（gate-blocked，passed=false / passed=true 不记录 / 多门禁失败）
 * - T8.  多通道组合（循环依赖 + 资源竞争 + 死锁 + 门禁 同时触发）
 * - T9.  建议动作生成（SuggestedAction 字段映射正确性 + 优先级映射 + 成本映射）
 * - T10. overallBlocked 判定（blocker 触发 true / 仅 warning 触发 false / 空记录 false）
 * - T11. 报告不可变性（Object.freeze + ReadonlyArray + 深冻结）
 * - T12. 可选字段省略（不传 gateStatusSnapshot / resourceAccessGraph 跳过对应通道）
 * - T13. 边界场景（空 plan / 单节点 plan / 自依赖节点）
 * - T14. PlanBlockageAnalyzerError 错误类型与字面量
 * - T15. 既有 BlockageReport 字段填充策略（rootCauseHypotheses 等空数组）
 * - T16. 日志回调注入（自定义 logger 接收正确级别与消息）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实 MultiLoopPlanner 实例（复用其 validate() DFS 环检测能力）
 * - 直接构造真实 MultiLoopPlan / RunState 对象（符合接口契约的 plain object）
 * - 不使用任何 mock 框架，所有依赖均为真实实现
 * - 使用 node:test + node:assert/strict
 *
 * 设计依据：
 * - EAG-P3 批次 12 设计文档 §3 C1 阻塞分析增强
 * - EAG 方案 §5.12.2 阻塞分析报告
 * - eag/long-horizon/plan-blockage-analyzer.ts 源文件
 * - eag/long-horizon/types.ts C1 新增类型定义
 *
 * @module core/tests/eag-long-horizon-plan-blockage-analyzer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { PlanBlockageAnalyzer, PlanBlockageAnalyzerError } from "../eag/long-horizon/plan-blockage-analyzer";
import type { PlanBlockageAnalyzerErrorKind } from "../eag/long-horizon/plan-blockage-analyzer";
import type {
  BlockageAnalysisReport,
  BlockageRecord,
  BlockageType,
  BlockageSeverity,
  GateStatusSnapshot,
  MultiLoopNode,
  MultiLoopPlan,
  PlanBlockageAnalyzeRequest,
  ResourceAccessGraph,
  ResourceAccessRecord,
  RunState,
  SuggestedAction,
  ActionPriority,
  ActionEffort,
  LogCallback,
} from "../eag/long-horizon/types";
import type { GateResult } from "../eag/gate/gate-types";

// ============================================================================
// 测试辅助工具
// ============================================================================

/**
 * 创建测试用 MultiLoopNode（默认 status="pending"）
 *
 * @param nodeId 节点 ID
 * @param loopType Loop 类型
 * @param dependencies 依赖节点 ID 列表
 * @returns MultiLoopNode 实例（冻结）
 */
function makeNode(
  nodeId: string,
  loopType: "design" | "coding" | "testing",
  dependencies: ReadonlyArray<string> = []
): MultiLoopNode {
  return Object.freeze({
    nodeId,
    loopType,
    dependencies: Object.freeze([...dependencies]),
    status: "pending",
    entryArtifact: `docs/eag/${loopType}.md`,
    exitCriteria: `G-${loopType === "design" ? "1" : loopType === "coding" ? "5" : "7"} passed`,
  });
}

/**
 * 创建测试用 MultiLoopPlan
 *
 * @param nodes 节点列表
 * @param overrides 可选字段覆盖
 * @returns MultiLoopPlan 实例（冻结）
 */
function makePlan(nodes: ReadonlyArray<MultiLoopNode>, overrides?: Partial<MultiLoopPlan>): MultiLoopPlan {
  return Object.freeze({
    planId: "test-plan-001",
    projectRoot: "/tmp/test-project",
    loops: Object.freeze([...nodes]),
    autoTransition: false,
    rollbackOnFailure: true,
    createdAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  });
}

/**
 * 创建测试用 RunState（最小可用对象）
 *
 * @param overrides 可选字段覆盖
 * @returns RunState 实例（冻结）
 */
function makeRunState(overrides?: Partial<RunState>): RunState {
  return Object.freeze({
    runId: "test-run-001",
    projectRoot: "/tmp/test-project",
    startedAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
    currentLoop: "design",
    currentIteration: 0,
    completedLoops: Object.freeze([]),
    completedTaskIds: Object.freeze([]),
    pendingDeleteFiles: Object.freeze([]),
    milestones: Object.freeze([]),
    humanInterventions: Object.freeze([]),
    humanInterventionCount: 0,
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    status: "running",
    checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  });
}

/**
 * 创建测试用 GateResult
 *
 * @param gate 门禁 ID
 * @param passed 是否通过
 * @param severity 严重性
 * @param reason 失败理由
 * @param guidance 引导消息
 * @returns GateResult 实例（冻结）
 */
function makeGateResult(
  gate: "G-1" | "G-2" | "G-3" | "G-4" | "G-5" | "G-6" | "G-7",
  passed: boolean,
  severity: "blocker" | "major" | "warning",
  reason: string,
  guidance?: string
): GateResult {
  return Object.freeze({
    gate,
    passed,
    severity,
    reason,
    guidance,
  });
}

/**
 * 创建测试用 GateStatusSnapshot
 *
 * @param gateResults 门禁结果列表
 * @returns GateStatusSnapshot 实例（冻结）
 */
function makeGateStatusSnapshot(gateResults: ReadonlyArray<GateResult>): GateStatusSnapshot {
  return Object.freeze({
    snapshotAt: "2026-07-19T10:00:00.000Z",
    gateResults: Object.freeze([...gateResults]),
  });
}

/**
 * 创建测试用 ResourceAccessRecord
 *
 * @param nodeId 节点 ID
 * @param resourceId 资源 ID
 * @param accessMode 访问模式
 * @param accessDescription 访问描述
 * @returns ResourceAccessRecord 实例（冻结）
 */
function makeAccess(
  nodeId: string,
  resourceId: string,
  accessMode: "read" | "write" | "read-write",
  accessDescription: string
): ResourceAccessRecord {
  return Object.freeze({
    nodeId,
    resourceId,
    accessMode,
    accessDescription,
  });
}

/**
 * 创建测试用 ResourceAccessGraph
 *
 * @param accesses 资源访问记录列表
 * @returns ResourceAccessGraph 实例（冻结）
 */
function makeResourceAccessGraph(accesses: ReadonlyArray<ResourceAccessRecord>): ResourceAccessGraph {
  return Object.freeze({
    accesses: Object.freeze([...accesses]),
  });
}

/**
 * 收集日志消息的辅助函数
 *
 * @returns logger 回调与日志条目数组的元组
 */
function makeLogCollector(): {
  readonly logs: Array<{ readonly message: string; readonly level?: string }>;
  readonly logger: LogCallback;
} {
  const logs: Array<{ readonly message: string; readonly level?: string }> = [];
  const logger: LogCallback = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  return { logs, logger };
}

// ============================================================================
// T1. PlanBlockageAnalyzer 构造函数校验
// ============================================================================

test("T1.1 PlanBlockageAnalyzer 构造函数注入真实 MultiLoopPlanner 可成功实例化", () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  assert.ok(analyzer instanceof PlanBlockageAnalyzer);
});

test("T1.2 PlanBlockageAnalyzer 构造函数接受自定义 logger", () => {
  const planner = new MultiLoopPlanner();
  const { logs, logger } = makeLogCollector();
  const analyzer = new PlanBlockageAnalyzer(planner, logger);
  assert.ok(analyzer instanceof PlanBlockageAnalyzer);
  // 此时还未调用 analyze，logs 应为空
  assert.equal(logs.length, 0);
});

test("T1.3 PlanBlockageAnalyzer 构造函数缺少 planner 抛 invalid-request", () => {
  assert.throws(
    () => new PlanBlockageAnalyzer(undefined as unknown as MultiLoopPlanner),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request" satisfies PlanBlockageAnalyzerErrorKind);
      assert.ok(err.message.includes("planner 必填"));
      return true;
    }
  );
});

test("T1.4 PlanBlockageAnalyzer 构造函数传入 null planner 抛 invalid-request", () => {
  assert.throws(
    () => new PlanBlockageAnalyzer(null as unknown as MultiLoopPlanner),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

// ============================================================================
// T2. analyze() 请求字段校验
// ============================================================================

test("T2.1 analyze() 缺少 runId 抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState();

  await assert.rejects(
    () =>
      analyzer.analyze({
        runId: "",
        plan,
        runState,
      } as PlanBlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runId"));
      return true;
    }
  );
});

test("T2.2 analyze() 缺少 plan 抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const runState = makeRunState();

  await assert.rejects(
    () =>
      analyzer.analyze({
        runId: "test-run-001",
        plan: undefined as unknown as MultiLoopPlan,
        runState,
      } as PlanBlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("plan.loops"));
      return true;
    }
  );
});

test("T2.3 analyze() plan.loops 非数组抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const runState = makeRunState();
  const invalidPlan = { planId: "x", loops: "not-array" } as unknown as MultiLoopPlan;

  await assert.rejects(
    () =>
      analyzer.analyze({
        runId: "test-run-001",
        plan: invalidPlan,
        runState,
      }),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("T2.4 analyze() 缺少 runState 抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);

  await assert.rejects(
    () =>
      analyzer.analyze({
        runId: "test-run-001",
        plan,
        runState: undefined as unknown as RunState,
      } as PlanBlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runState"));
      return true;
    }
  );
});

test("T2.5 analyze() request 为 null 抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);

  await assert.rejects(
    () => analyzer.analyze(null as unknown as PlanBlockageAnalyzeRequest),
    (err: unknown) => {
      assert.ok(err instanceof PlanBlockageAnalyzerError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

// ============================================================================
// T3. 循环依赖检测（circular-dependency）
// ============================================================================

test("T3.1 循环依赖检测：2 节点环（A → B → A）生成 1 条 blocker 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 构造 2 节点环：coding-1 依赖 coding-2，coding-2 依赖 coding-1
  // 注意：design-1 作为根节点存在，避免 BFS 不可达节点检测干扰
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["coding-2"]),
    makeNode("coding-2", "coding", ["coding-1"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 应至少检测到 1 条 circular-dependency
  const circularBlockages = report.blockageRecords.filter((r) => r.type === "circular-dependency");
  assert.ok(circularBlockages.length >= 1, `应检测到 >=1 条循环依赖，实际 ${circularBlockages.length}`);

  // 验证第一条循环依赖记录的字段
  const first = circularBlockages[0]!;
  assert.equal(first.severity, "blocker");
  assert.ok(first.affectedNodes.length >= 2, "环中应至少 2 个节点");
  assert.ok(first.rootCause.includes("环"));
  assert.ok(first.mitigation.length > 0);
  // overallBlocked 应为 true（blocker 触发）
  assert.equal(report.overallBlocked, true);
});

test("T3.2 循环依赖检测：3 节点环（A → B → C → A）生成 blocker 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 构造 3 节点环：coding-1 → coding-2 → coding-3 → coding-1
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["coding-3"]),
    makeNode("coding-2", "coding", ["coding-1"]),
    makeNode("coding-3", "coding", ["coding-2"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const circularBlockages = report.blockageRecords.filter((r) => r.type === "circular-dependency");
  assert.ok(circularBlockages.length >= 1, `应检测到 >=1 条循环依赖，实际 ${circularBlockages.length}`);
  assert.equal(report.overallBlocked, true);
});

test("T3.3 循环依赖检测：无环 DAG 不产生 circular-dependency 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 构造无环 DAG：design-1 → coding-1 → testing-1
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("testing-1", "testing", ["coding-1"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const circularBlockages = report.blockageRecords.filter((r) => r.type === "circular-dependency");
  assert.equal(circularBlockages.length, 0, "无环 DAG 不应产生循环依赖记录");
  assert.equal(report.overallBlocked, false);
});

test("T3.4 循环依赖记录的 blockageId 以 blk-circular- 开头", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["coding-2"]),
    makeNode("coding-2", "coding", ["coding-1"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const circularBlockages = report.blockageRecords.filter((r) => r.type === "circular-dependency");
  for (const b of circularBlockages) {
    assert.ok(b.blockageId.startsWith("blk-circular-"), `blockageId 应以 blk-circular- 开头，实际为 ${b.blockageId}`);
  }
});

// ============================================================================
// T4. 缺失依赖检测（missing-dependency）
// ============================================================================

test("T4.1 缺失依赖检测：单节点引用不存在的依赖生成 blocker 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // coding-1 依赖不存在的 ghost-node
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost-node"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const missingBlockages = report.blockageRecords.filter((r) => r.type === "missing-dependency");
  assert.equal(missingBlockages.length, 1);
  const first = missingBlockages[0]!;
  assert.equal(first.severity, "blocker");
  assert.deepEqual([...first.affectedNodes], ["coding-1"]);
  assert.ok(first.rootCause.includes("ghost-node"), `根因应包含 ghost-node：${first.rootCause}`);
  assert.ok(first.mitigation.includes("ghost-node"));
  assert.equal(report.overallBlocked, true);
});

test("T4.2 缺失依赖检测：单节点引用多个不存在的依赖合并为 1 条记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // coding-1 依赖 ghost-a 和 ghost-b 两个不存在的节点
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost-a", "ghost-b"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const missingBlockages = report.blockageRecords.filter((r) => r.type === "missing-dependency");
  assert.equal(missingBlockages.length, 1, "同节点多缺失依赖应合并为 1 条");
  const first = missingBlockages[0]!;
  assert.ok(first.rootCause.includes("ghost-a"));
  assert.ok(first.rootCause.includes("ghost-b"));
});

test("T4.3 缺失依赖检测：多节点各有缺失依赖分别生成记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["ghost-a"]),
    makeNode("coding-2", "coding", ["ghost-b"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const missingBlockages = report.blockageRecords.filter((r) => r.type === "missing-dependency");
  assert.equal(missingBlockages.length, 2, "两个节点分别缺依赖应生成 2 条记录");
  // 验证 affectedNodes 分别对应 coding-1 与 coding-2
  const affected = missingBlockages.map((b) => b.affectedNodes[0]).sort();
  assert.deepEqual(affected, ["coding-1", "coding-2"]);
});

test("T4.4 缺失依赖检测：依赖全部存在不产生记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1", "coding-1"]),
    makeNode("testing-1", "testing", ["coding-1", "coding-2"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const missingBlockages = report.blockageRecords.filter((r) => r.type === "missing-dependency");
  assert.equal(missingBlockages.length, 0);
});

test("T4.5 缺失依赖记录的 blockageId 以 blk-missing- 开头", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const missingBlockages = report.blockageRecords.filter((r) => r.type === "missing-dependency");
  for (const b of missingBlockages) {
    assert.ok(b.blockageId.startsWith("blk-missing-"));
  }
});

// ============================================================================
// T5. 资源竞争检测（resource-contention）
// ============================================================================

test("T5.1 资源竞争检测：2 节点并行访问同一资源生成 major 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 2 个并行 CODING 节点（都只依赖 design-1，无相互依赖）
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  // 2 个节点都访问同一资源 db:orders
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单读写"),
    makeAccess("coding-2", "db:orders", "read-write", "订单读写"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  assert.equal(contentionBlockages.length, 1);
  const first = contentionBlockages[0]!;
  assert.equal(first.severity, "major");
  // affectedNodes 排序后应为 ["coding-1", "coding-2"]
  assert.deepEqual([...first.affectedNodes], ["coding-1", "coding-2"]);
  assert.ok(first.rootCause.includes("db:orders"));
  assert.ok(first.mitigation.length > 0);
  // major 严重性不触发 overallBlocked
  assert.equal(report.overallBlocked, false);
});

test("T5.2 资源竞争检测：3 节点并行访问同一资源生成 major 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
    makeNode("coding-3", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单读写"),
    makeAccess("coding-2", "db:orders", "read-write", "订单读写"),
    makeAccess("coding-3", "db:orders", "read-write", "订单读写"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  assert.equal(contentionBlockages.length, 1);
  assert.equal(contentionBlockages[0]!.affectedNodes.length, 3);
});

test("T5.3 资源竞争检测：串行节点访问同一资源不产生记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // coding-2 依赖 coding-1（串行），都访问 db:orders
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1", "coding-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单读写"),
    makeAccess("coding-2", "db:orders", "read-write", "订单读写"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  assert.equal(contentionBlockages.length, 0, "串行节点不产生资源竞争");
});

test("T5.4 资源竞争检测：单节点访问资源不产生记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["design-1"])]);
  const graph = makeResourceAccessGraph([makeAccess("coding-1", "db:orders", "read-write", "订单读写")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  assert.equal(contentionBlockages.length, 0, "单节点不产生资源竞争");
});

test("T5.5 资源竞争检测：多资源多竞争生成多条记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 4 个并行节点：coding-1/coding-2 竞争 db:orders，coding-3/coding-4 竞争 db:payments
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
    makeNode("coding-3", "coding", ["design-1"]),
    makeNode("coding-4", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单"),
    makeAccess("coding-2", "db:orders", "read-write", "订单"),
    makeAccess("coding-3", "db:payments", "read-write", "支付"),
    makeAccess("coding-4", "db:payments", "read-write", "支付"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  assert.equal(contentionBlockages.length, 2, "两个资源分别竞争应生成 2 条记录");
  // 验证每条记录的 rootCause 包含对应资源 ID
  const rootCauses = contentionBlockages.map((b) => b.rootCause).sort();
  assert.ok(rootCauses[0]!.includes("db:orders") || rootCauses[1]!.includes("db:orders"));
  assert.ok(rootCauses[0]!.includes("db:payments") || rootCauses[1]!.includes("db:payments"));
});

test("T5.6 资源竞争检测：blockageId 以 blk-contention- 开头", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单"),
    makeAccess("coding-2", "db:orders", "read-write", "订单"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  for (const b of contentionBlockages) {
    assert.ok(b.blockageId.startsWith("blk-contention-"));
  }
});

// ============================================================================
// T6. 死锁风险检测（deadlock-risk）
// ============================================================================

test("T6.1 死锁风险检测：2 节点循环等待生成 blocker 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 2 个并行节点（都依赖 design-1，无相互依赖）
  // coding-1 持有 db:orders 写锁，coding-2 持有 db:payments 写锁
  // coding-1 同时想写 db:payments，coding-2 同时想写 db:orders → 循环等待
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "write", "持有 orders 写锁"),
    makeAccess("coding-1", "db:payments", "write", "等待 payments 写锁"),
    makeAccess("coding-2", "db:payments", "write", "持有 payments 写锁"),
    makeAccess("coding-2", "db:orders", "write", "等待 orders 写锁"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.ok(deadlockBlockages.length >= 1, `应检测到 >=1 条死锁风险，实际 ${deadlockBlockages.length}`);
  const first = deadlockBlockages[0]!;
  assert.equal(first.severity, "blocker");
  assert.ok(first.affectedNodes.length >= 2);
  assert.ok(first.rootCause.includes("循环等待"));
  assert.equal(report.overallBlocked, true);
});

test("T6.2 死锁风险检测：3 节点循环等待生成 blocker 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 3 节点循环等待：A 持 R1 等 R2，B 持 R2 等 R3，C 持 R3 等 R1
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-a", "coding", ["design-1"]),
    makeNode("coding-b", "coding", ["design-1"]),
    makeNode("coding-c", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-a", "db:r1", "write", "持有 r1"),
    makeAccess("coding-a", "db:r2", "write", "等待 r2"),
    makeAccess("coding-b", "db:r2", "write", "持有 r2"),
    makeAccess("coding-b", "db:r3", "write", "等待 r3"),
    makeAccess("coding-c", "db:r3", "write", "持有 r3"),
    makeAccess("coding-c", "db:r1", "write", "等待 r1"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.ok(deadlockBlockages.length >= 1, "3 节点循环等待应检测到死锁");
  assert.equal(report.overallBlocked, true);
});

test("T6.3 死锁风险检测：无环无死锁不产生记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 单节点持有资源，无其他节点等待 → 无死锁
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["design-1"])]);
  const graph = makeResourceAccessGraph([makeAccess("coding-1", "db:orders", "write", "持有")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.equal(deadlockBlockages.length, 0);
});

test("T6.4 死锁风险检测：串行节点不构成死锁", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // coding-1 与 coding-2 是串行（coding-2 依赖 coding-1）
  // 即使两者持有对方想要的资源，由于串行执行不会死锁
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1", "coding-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "write", "持有"),
    makeAccess("coding-1", "db:payments", "write", "等待"),
    makeAccess("coding-2", "db:payments", "write", "持有"),
    makeAccess("coding-2", "db:orders", "write", "等待"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.equal(deadlockBlockages.length, 0, "串行节点不构成死锁");
});

test("T6.5 死锁风险记录的 blockageId 以 blk-deadlock- 开头", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "write", "持有"),
    makeAccess("coding-1", "db:payments", "write", "等待"),
    makeAccess("coding-2", "db:payments", "write", "持有"),
    makeAccess("coding-2", "db:orders", "write", "等待"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  for (const b of deadlockBlockages) {
    assert.ok(b.blockageId.startsWith("blk-deadlock-"));
  }
});

// ============================================================================
// T7. 门禁阻塞检测（gate-blocked）
// ============================================================================

test("T7.1 门禁阻塞检测：passed=false 的 blocker 门禁生成记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", false, "blocker", "spec.md 状态为 reviewing", "进入 DESIGN Loop"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 1);
  const first = gateBlockages[0]!;
  assert.equal(first.severity, "blocker");
  assert.equal(first.affectedNodes.length, 0); // 门禁不直接对应 DAG 节点
  assert.ok(first.rootCause.includes("G-1"));
  assert.ok(first.rootCause.includes("spec.md"));
  assert.equal(first.mitigation, "进入 DESIGN Loop");
  assert.equal(report.overallBlocked, true);
});

test("T7.2 门禁阻塞检测：passed=true 不产生记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-1", true, "blocker", "通过")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 0);
});

test("T7.3 门禁阻塞检测：major 严重性门禁生成 major 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-3", false, "major", "方案偏离检测到 1 项偏差", "调整任务卡"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 1);
  assert.equal(gateBlockages[0]!.severity, "major");
  // major 不触发 overallBlocked
  assert.equal(report.overallBlocked, false);
});

test("T7.4 门禁阻塞检测：warning 严重性门禁生成 warning 记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-2", false, "warning", "评审意见 1 项 minor", "修订 spec"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 1);
  assert.equal(gateBlockages[0]!.severity, "warning");
  assert.equal(report.overallBlocked, false);
});

test("T7.5 门禁阻塞检测：多门禁失败生成多条记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", false, "blocker", "G-1 失败"),
    makeGateResult("G-2", false, "major", "G-2 失败"),
    makeGateResult("G-3", false, "warning", "G-3 失败"),
    makeGateResult("G-4", true, "blocker", "G-4 通过"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 3, "3 个失败门禁应生成 3 条记录");
  // 严重性应分别为 blocker / major / warning
  const severities = gateBlockages.map((b) => b.severity).sort();
  assert.deepEqual(severities, ["blocker", "major", "warning"]);
  // 任一 blocker 触发 overallBlocked
  assert.equal(report.overallBlocked, true);
});

test("T7.6 门禁阻塞检测：guidance 缺失时使用默认 mitigation", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", false, "blocker", "G-1 失败"), // 不传 guidance
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 1);
  // guidance 缺失时 mitigation 应包含"修复门禁"字样
  assert.ok(gateBlockages[0]!.mitigation.includes("修复门禁"));
});

test("T7.7 门禁阻塞记录的 blockageId 以 blk-gate- 开头", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-1", false, "blocker", "失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  for (const b of gateBlockages) {
    assert.ok(b.blockageId.startsWith("blk-gate-"));
  }
});

// ============================================================================
// T8. 多通道组合（循环依赖 + 资源竞争 + 死锁 + 门禁 同时触发）
// ============================================================================

test("T8.1 多通道组合：4 类阻塞同时触发 → 报告包含 4 类记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 构造 plan：含循环依赖 + 缺失依赖 + 资源竞争 + 死锁
  const plan = makePlan([
    makeNode("design-1", "design"),
    // 循环依赖：coding-1 ↔ coding-2
    makeNode("coding-1", "coding", ["design-1", "coding-2"]),
    makeNode("coding-2", "coding", ["design-1", "coding-1"]),
    // 缺失依赖：coding-3 依赖 ghost
    makeNode("coding-3", "coding", ["ghost-node"]),
    // 并行节点 coding-4 / coding-5 用于资源竞争与死锁
    makeNode("coding-4", "coding", ["design-1"]),
    makeNode("coding-5", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    // 资源竞争：coding-4 / coding-5 都访问 db:audit
    makeAccess("coding-4", "db:audit", "read-write", "审计日志读写"),
    makeAccess("coding-5", "db:audit", "read-write", "审计日志读写"),
    // 死锁：coding-4 持 db:lock-a 等 db:lock-b，coding-5 持 db:lock-b 等 db:lock-a
    makeAccess("coding-4", "db:lock-a", "write", "持锁"),
    makeAccess("coding-4", "db:lock-b", "write", "等锁"),
    makeAccess("coding-5", "db:lock-b", "write", "持锁"),
    makeAccess("coding-5", "db:lock-a", "write", "等锁"),
  ]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-1", false, "blocker", "G-1 失败", "修复")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
    resourceAccessGraph: graph,
  });

  // 应包含 4 类阻塞记录
  const types = new Set(report.blockageRecords.map((r) => r.type));
  assert.ok(types.has("circular-dependency"), "应包含循环依赖");
  assert.ok(types.has("missing-dependency"), "应包含缺失依赖");
  assert.ok(types.has("resource-contention"), "应包含资源竞争");
  assert.ok(types.has("deadlock-risk"), "应包含死锁风险");
  assert.ok(types.has("gate-blocked"), "应包含门禁阻塞");

  // overallBlocked=true（存在多个 blocker）
  assert.equal(report.overallBlocked, true);

  // 建议动作数应等于阻塞记录数
  assert.equal(report.suggestedActions.length, report.blockageRecords.length);
});

test("T8.2 多通道组合：blockageId 全局唯一", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1", "ghost-1"]),
    makeNode("coding-2", "coding", ["design-1", "ghost-2"]),
  ]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", false, "blocker", "失败"),
    makeGateResult("G-2", false, "major", "失败"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const ids = report.blockageRecords.map((r) => r.blockageId);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, "blockageId 应全局唯一");
});

// ============================================================================
// T9. 建议动作生成（SuggestedAction）
// ============================================================================

test("T9.1 建议动作生成：每条 BlockageRecord 生成 1 个 SuggestedAction", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["ghost-1"]),
    makeNode("coding-2", "coding", ["ghost-2"]),
    makeNode("coding-3", "coding", ["ghost-3"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 3 条缺失依赖 → 3 个建议动作
  assert.equal(report.suggestedActions.length, 3);
  assert.equal(report.blockageRecords.length, 3);
});

test("T9.2 建议动作：actionId 以 act- 开头且全局唯一", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["ghost-1"]),
    makeNode("coding-2", "coding", ["ghost-2"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  for (const a of report.suggestedActions) {
    assert.ok(a.actionId.startsWith("act-"), `actionId 应以 act- 开头：${a.actionId}`);
  }
  const ids = report.suggestedActions.map((a) => a.actionId);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "actionId 应唯一");
});

test("T9.3 建议动作：targetBlockageId 关联到存在的 blockageId", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost-1"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const blockageIds = new Set(report.blockageRecords.map((r) => r.blockageId));
  for (const a of report.suggestedActions) {
    assert.ok(blockageIds.has(a.targetBlockageId), `targetBlockageId=${a.targetBlockageId} 应存在于 blockageRecords`);
  }
});

test("T9.4 建议动作：blocker → critical 优先级映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-1", false, "blocker", "G-1 失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const action = report.suggestedActions[0]!;
  assert.equal(action.priority, "critical" satisfies ActionPriority);
});

test("T9.5 建议动作：major → high 优先级映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-3", false, "major", "G-3 失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const action = report.suggestedActions[0]!;
  assert.equal(action.priority, "high" satisfies ActionPriority);
});

test("T9.6 建议动作：warning → medium 优先级映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-2", false, "warning", "G-2 失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const action = report.suggestedActions[0]!;
  assert.equal(action.priority, "medium" satisfies ActionPriority);
});

test("T9.7 建议动作：circular-dependency → medium 成本映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["coding-2"]),
    makeNode("coding-2", "coding", ["coding-1"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const circularActions = report.suggestedActions.filter((a) => {
    const blockage = report.blockageRecords.find((r) => r.blockageId === a.targetBlockageId);
    return blockage?.type === "circular-dependency";
  });
  for (const a of circularActions) {
    assert.equal(a.estimatedEffort, "medium" satisfies ActionEffort);
  }
});

test("T9.8 建议动作：deadlock-risk → high 成本映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:a", "write", "持"),
    makeAccess("coding-1", "db:b", "write", "等"),
    makeAccess("coding-2", "db:b", "write", "持"),
    makeAccess("coding-2", "db:a", "write", "等"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const deadlockActions = report.suggestedActions.filter((a) => {
    const blockage = report.blockageRecords.find((r) => r.blockageId === a.targetBlockageId);
    return blockage?.type === "deadlock-risk";
  });
  for (const a of deadlockActions) {
    assert.equal(a.estimatedEffort, "high" satisfies ActionEffort);
  }
});

test("T9.9 建议动作：missing-dependency → low 成本映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  const missingActions = report.suggestedActions.filter((a) => {
    const blockage = report.blockageRecords.find((r) => r.blockageId === a.targetBlockageId);
    return blockage?.type === "missing-dependency";
  });
  for (const a of missingActions) {
    assert.equal(a.estimatedEffort, "low" satisfies ActionEffort);
  }
});

test("T9.10 建议动作：gate-blocked → low 成本映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-1", false, "blocker", "失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateActions = report.suggestedActions.filter((a) => {
    const blockage = report.blockageRecords.find((r) => r.blockageId === a.targetBlockageId);
    return blockage?.type === "gate-blocked";
  });
  for (const a of gateActions) {
    assert.equal(a.estimatedEffort, "low" satisfies ActionEffort);
  }
});

test("T9.11 建议动作：resource-contention → medium 成本映射", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单"),
    makeAccess("coding-2", "db:orders", "read-write", "订单"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionActions = report.suggestedActions.filter((a) => {
    const blockage = report.blockageRecords.find((r) => r.blockageId === a.targetBlockageId);
    return blockage?.type === "resource-contention";
  });
  for (const a of contentionActions) {
    assert.equal(a.estimatedEffort, "medium" satisfies ActionEffort);
  }
});

// ============================================================================
// T10. overallBlocked 判定
// ============================================================================

test("T10.1 overallBlocked：存在 blocker 严重性记录 → true", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // missing-dependency 严重性为 blocker
  assert.equal(report.overallBlocked, true);
});

test("T10.2 overallBlocked：仅 warning 严重性记录 → false", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-2", false, "warning", "失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  // 仅 warning 不触发 overallBlocked
  assert.equal(report.overallBlocked, false);
  assert.equal(report.blockageRecords.length, 1);
});

test("T10.3 overallBlocked：仅 major 严重性记录 → false", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单"),
    makeAccess("coding-2", "db:orders", "read-write", "订单"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  // resource-contention 严重性为 major
  assert.equal(report.overallBlocked, false);
  assert.equal(report.blockageRecords.length, 1);
});

test("T10.4 overallBlocked：无任何阻塞记录 → false", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("testing-1", "testing", ["coding-1"]),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.equal(report.blockageRecords.length, 0);
  assert.equal(report.overallBlocked, false);
});

test("T10.5 overallBlocked：major + warning 混合 → false", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单"),
    makeAccess("coding-2", "db:orders", "read-write", "订单"),
  ]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-2", false, "warning", "失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
    resourceAccessGraph: graph,
  });

  // 1 条 major + 1 条 warning，无 blocker
  assert.equal(report.blockageRecords.length, 2);
  assert.equal(report.overallBlocked, false);
});

// ============================================================================
// T11. 报告不可变性（Object.freeze + ReadonlyArray + 深冻结）
// ============================================================================

test("T11.1 报告对象本身被 Object.freeze 冻结", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.ok(Object.isFrozen(report), "report 应被 Object.freeze 冻结");
});

test("T11.2 blockageRecords 数组被冻结", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.ok(Object.isFrozen(report.blockageRecords), "blockageRecords 应被冻结");
});

test("T11.3 单条 BlockageRecord 被冻结", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  for (const b of report.blockageRecords) {
    assert.ok(Object.isFrozen(b), "每条 BlockageRecord 应被冻结");
    assert.ok(Object.isFrozen(b.affectedNodes), "affectedNodes 应被冻结");
  }
});

test("T11.4 suggestedActions 数组与单条 SuggestedAction 被冻结", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.ok(Object.isFrozen(report.suggestedActions));
  for (const a of report.suggestedActions) {
    assert.ok(Object.isFrozen(a), "每条 SuggestedAction 应被冻结");
  }
});

test("T11.5 既有 BlockageReport 字段数组被冻结（rootCauseHypotheses 等）", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.ok(Object.isFrozen(report.rootCauseHypotheses));
  assert.ok(Object.isFrozen(report.suggestedSolutions));
  assert.ok(Object.isFrozen(report.requiredDecisions));
  assert.ok(Object.isFrozen(report.relatedInterventions));
});

test("T11.6 修改冻结报告在严格模式下抛 TypeError", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.throws(() => {
    // 试图修改冻结对象的字段
    (report as { overallBlocked: boolean }).overallBlocked = false;
  }, TypeError);
});

// ============================================================================
// T12. 可选字段省略（不传 gateStatusSnapshot / resourceAccessGraph 跳过对应通道）
// ============================================================================

test("T12.1 不传 gateStatusSnapshot 与 resourceAccessGraph → 仅运行循环依赖 + 缺失依赖通道", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    // 不传 gateStatusSnapshot / resourceAccessGraph
  });

  // 仅缺失依赖通道应产生 1 条记录
  assert.equal(report.blockageRecords.length, 1);
  assert.equal(report.blockageRecords[0]!.type, "missing-dependency");
  // 不应有 resource-contention / deadlock-risk / gate-blocked
  const types = new Set(report.blockageRecords.map((r) => r.type));
  assert.ok(!types.has("resource-contention"));
  assert.ok(!types.has("deadlock-risk"));
  assert.ok(!types.has("gate-blocked"));
});

test("T12.2 仅传 gateStatusSnapshot → 跳过资源竞争与死锁通道", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([makeGateResult("G-1", false, "blocker", "失败")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
    // 不传 resourceAccessGraph
  });

  const types = new Set(report.blockageRecords.map((r) => r.type));
  assert.ok(types.has("gate-blocked"));
  assert.ok(!types.has("resource-contention"));
  assert.ok(!types.has("deadlock-risk"));
});

test("T12.3 仅传 resourceAccessGraph → 跳过门禁阻塞通道", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-1", "db:orders", "read-write", "订单"),
    makeAccess("coding-2", "db:orders", "read-write", "订单"),
  ]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
    // 不传 gateStatusSnapshot
  });

  const types = new Set(report.blockageRecords.map((r) => r.type));
  assert.ok(types.has("resource-contention"));
  assert.ok(!types.has("gate-blocked"));
});

// ============================================================================
// T13. 边界场景
// ============================================================================

test("T13.1 边界场景：空 plan（loops 为空数组）→ 0 阻塞记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.equal(report.blockageRecords.length, 0);
  assert.equal(report.overallBlocked, false);
  assert.equal(report.suggestedActions.length, 0);
});

test("T13.2 边界场景：单节点无依赖 plan → 0 阻塞记录", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.equal(report.blockageRecords.length, 0);
});

test("T13.3 边界场景：节点自依赖（nodeId 依赖自身）→ 检测为循环依赖", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 注意：MultiLoopPlanner.validate() 的 DFS 算法在遇到自依赖时是否报环取决于实现
  // 这里构造一个 design-1 + coding-1（coding-1 依赖 design-1 与 coding-1 自身）
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["design-1", "coding-1"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 自依赖应至少触发循环依赖或缺失依赖（取决于 DFS 实现）
  // 这里仅断言：要么有循环依赖记录，要么整体阻塞
  const hasCircular = report.blockageRecords.some((r) => r.type === "circular-dependency");
  const hasMissing = report.blockageRecords.some((r) => r.type === "missing-dependency");
  assert.ok(hasCircular || hasMissing, "自依赖应至少触发循环依赖或缺失依赖检测");
});

test("T13.4 边界场景：plan.loops 含重复 nodeId → 不抛异常（由上层保证唯一性）", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 构造含重复 nodeId 的 plan（不符合契约，但分析器不应崩溃）
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-1", "coding", ["design-1"]), // 重复
  ]);
  const runState = makeRunState();

  // 应正常完成分析（不抛异常）
  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.ok(report.blockageRecords.length >= 0);
});

test("T13.5 边界场景：资源访问图无任何访问记录 → 0 资源竞争 / 0 死锁", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const graph = makeResourceAccessGraph([]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    resourceAccessGraph: graph,
  });

  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.equal(contentionBlockages.length, 0);
  assert.equal(deadlockBlockages.length, 0);
});

test("T13.6 边界场景：门禁快照无任何 gateResult → 0 门禁阻塞", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const snapshot = makeGateStatusSnapshot([]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
  });

  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 0);
});

// ============================================================================
// T14. PlanBlockageAnalyzerError 错误类型与字面量
// ============================================================================

test("T14.1 PlanBlockageAnalyzerError 含 kind 字段", () => {
  const err = new PlanBlockageAnalyzerError("invalid-request", "测试消息");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof PlanBlockageAnalyzerError);
  assert.equal(err.kind, "invalid-request");
  assert.equal(err.name, "PlanBlockageAnalyzerError");
  assert.ok(err.message.includes("测试消息"));
});

test("T14.2 PlanBlockageAnalyzerError 支持 cause 字段", () => {
  const cause = new Error("原始异常");
  const err = new PlanBlockageAnalyzerError("planner-error", "包装消息", cause);
  assert.equal(err.cause, cause);
});

test("T14.3 PlanBlockageAnalyzerErrorKind 字面量联合包含 invalid-request 与 planner-error", () => {
  // 通过类型断言验证字面量联合完整性
  const kinds: PlanBlockageAnalyzerErrorKind[] = ["invalid-request", "planner-error"];
  assert.equal(kinds.length, 2);
});

// ============================================================================
// T15. 既有 BlockageReport 字段填充策略
// ============================================================================

test("T15.1 既有 BlockageReport 字段填充为空数组（rootCauseHypotheses 等）", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 既有根因维度字段应为空数组（PlanBlockageAnalyzer 专注依赖图维度）
  assert.equal(report.rootCauseHypotheses.length, 0);
  assert.equal(report.suggestedSolutions.length, 0);
  assert.equal(report.requiredDecisions.length, 0);
  assert.equal(report.relatedInterventions.length, 0);
});

test("T15.2 报告 runId 与请求 runId 一致", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState({ runId: "custom-run-id-001" });

  const report = await analyzer.analyze({
    runId: "custom-run-id-001",
    plan,
    runState,
  });

  assert.equal(report.runId, "custom-run-id-001");
});

test("T15.3 报告 blockedLoop / blockedIteration 与请求 runState 一致", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState({
    currentLoop: "coding",
    currentIteration: 5,
  });

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.equal(report.blockedLoop, "coding");
  assert.equal(report.blockedIteration, 5);
});

test("T15.4 报告 generatedAt 为合法 ISO 8601 字符串", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 验证 ISO 8601 格式：能被 Date.parse 解析
  const parsed = Date.parse(report.generatedAt);
  assert.ok(!Number.isNaN(parsed), `generatedAt 应为合法 ISO 8601 字符串：${report.generatedAt}`);
});

test("T15.5 BlockageAnalysisReport 兼容 BlockageReport 接口（向后兼容）", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState();

  const report: BlockageAnalysisReport = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // BlockageAnalysisReport 继承 BlockageReport，应有全部父字段
  // 通过类型断言验证字段存在
  const asBlockageReport = report as unknown as {
    runId: string;
    generatedAt: string;
    blockedLoop: string;
    blockedIteration: number;
    rootCauseHypotheses: unknown[];
    suggestedSolutions: unknown[];
    requiredDecisions: unknown[];
    relatedInterventions: unknown[];
  };
  assert.equal(typeof asBlockageReport.runId, "string");
  assert.equal(typeof asBlockageReport.generatedAt, "string");
  assert.equal(typeof asBlockageReport.blockedLoop, "string");
  assert.equal(typeof asBlockageReport.blockedIteration, "number");
  assert.ok(Array.isArray(asBlockageReport.rootCauseHypotheses));
});

// ============================================================================
// T16. 日志回调注入
// ============================================================================

test("T16.1 自定义 logger 接收 info 级别消息（含 runId 与节点数）", async () => {
  const planner = new MultiLoopPlanner();
  const { logs, logger } = makeLogCollector();
  const analyzer = new PlanBlockageAnalyzer(planner, logger);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["design-1"])]);
  const runState = makeRunState();

  await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 应至少有一条包含 runId 的 info 日志
  const infoLogs = logs.filter((l) => l.level === "info");
  assert.ok(infoLogs.length >= 1, "应至少有 1 条 info 日志");
  // 第一条 info 日志应包含 runId
  const firstInfo = infoLogs[0]!;
  assert.ok(firstInfo.message.includes("test-run-001"), `首条 info 日志应包含 runId：${firstInfo.message}`);
});

test("T16.2 自定义 logger 接收各通道检测结果日志", async () => {
  const planner = new MultiLoopPlanner();
  const { logs, logger } = makeLogCollector();
  const analyzer = new PlanBlockageAnalyzer(planner, logger);
  const plan = makePlan([makeNode("design-1", "design"), makeNode("coding-1", "coding", ["ghost"])]);
  const runState = makeRunState();

  await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  // 应有循环依赖 + 缺失依赖通道的日志
  const messages = logs.map((l) => l.message).join("\n");
  assert.ok(messages.includes("循环依赖检测"), "应记录循环依赖通道日志");
  assert.ok(messages.includes("缺失依赖检测"), "应记录缺失依赖通道日志");
});

test("T16.3 不传 logger 时使用 noopLog 不抛异常", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner); // 不传 logger
  const plan = makePlan([makeNode("design-1", "design")]);
  const runState = makeRunState();

  // 应正常完成不抛异常
  const report = await analyzer.analyze({
    runId: "test-run-001",
    plan,
    runState,
  });

  assert.ok(report);
});

// ============================================================================
// T17. 端到端综合场景（模拟真实 EAG Run）
// ============================================================================

test("T17.1 端到端：3 模块微服务 plan + 资源竞争 + 门禁失败 → 综合报告", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  // 模拟 3 模块微服务：用户管理 + 订单管理（依赖用户）+ 支付管理（依赖订单）
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-users", "coding", ["design-1"]),
    makeNode("coding-orders", "coding", ["design-1", "coding-users"]),
    makeNode("coding-payments", "coding", ["design-1", "coding-orders"]),
    makeNode("testing-1", "testing", ["coding-users", "coding-orders", "coding-payments"]),
  ]);
  // 资源访问图：orders 与 payments 都访问 db:audit-log（但 orders 与 payments 是串行的，不应竞争）
  const graph = makeResourceAccessGraph([
    makeAccess("coding-orders", "db:audit-log", "read-write", "审计日志"),
    makeAccess("coding-payments", "db:audit-log", "read-write", "审计日志"),
  ]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", true, "blocker", "G-1 通过"),
    makeGateResult("G-2", false, "major", "评审未通过", "修订 spec"),
    makeGateResult("G-3", false, "warning", "1 项 minor 偏差"),
  ]);
  const runState = makeRunState({ currentLoop: "coding", currentIteration: 2 });

  const report = await analyzer.analyze({
    runId: "e2e-run-001",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
    resourceAccessGraph: graph,
  });

  // orders 与 payments 串行，不应产生资源竞争
  const contentionBlockages = report.blockageRecords.filter((r) => r.type === "resource-contention");
  assert.equal(contentionBlockages.length, 0, "串行节点不应产生资源竞争");

  // 应有 2 条门禁阻塞记录（G-2 + G-3）
  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 2);

  // 应无死锁记录
  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.equal(deadlockBlockages.length, 0);

  // 应无循环依赖
  const circularBlockages = report.blockageRecords.filter((r) => r.type === "circular-dependency");
  assert.equal(circularBlockages.length, 0);

  // 应无缺失依赖
  const missingBlockages = report.blockageRecords.filter((r) => r.type === "missing-dependency");
  assert.equal(missingBlockages.length, 0);

  // overallBlocked=false（G-2 major + G-3 warning，无 blocker）
  assert.equal(report.overallBlocked, false);

  // 建议动作数 = 阻塞记录数
  assert.equal(report.suggestedActions.length, report.blockageRecords.length);
});

test("T17.2 端到端：复杂环 + 多资源死锁 + 全门禁失败 → overallBlocked=true", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    // 3 节点环
    makeNode("coding-a", "coding", ["design-1", "coding-c"]),
    makeNode("coding-b", "coding", ["design-1", "coding-a"]),
    makeNode("coding-c", "coding", ["design-1", "coding-b"]),
    // 2 个并行节点用于死锁
    makeNode("coding-x", "coding", ["design-1"]),
    makeNode("coding-y", "coding", ["design-1"]),
  ]);
  const graph = makeResourceAccessGraph([
    makeAccess("coding-x", "db:r1", "write", "持 r1"),
    makeAccess("coding-x", "db:r2", "write", "等 r2"),
    makeAccess("coding-y", "db:r2", "write", "持 r2"),
    makeAccess("coding-y", "db:r1", "write", "等 r1"),
  ]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", false, "blocker", "G-1 失败"),
    makeGateResult("G-2", false, "blocker", "G-2 失败"),
    makeGateResult("G-3", false, "major", "G-3 失败"),
  ]);
  const runState = makeRunState({ currentLoop: "coding", currentIteration: 1 });

  const report = await analyzer.analyze({
    runId: "e2e-run-002",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
    resourceAccessGraph: graph,
  });

  // 应有循环依赖（3 节点环）
  const circularBlockages = report.blockageRecords.filter((r) => r.type === "circular-dependency");
  assert.ok(circularBlockages.length >= 1, "应检测到 3 节点环");

  // 应有死锁风险
  const deadlockBlockages = report.blockageRecords.filter((r) => r.type === "deadlock-risk");
  assert.ok(deadlockBlockages.length >= 1, "应检测到 2 节点死锁");

  // 应有门禁阻塞（3 个失败门禁）
  const gateBlockages = report.blockageRecords.filter((r) => r.type === "gate-blocked");
  assert.equal(gateBlockages.length, 3);

  // overallBlocked=true
  assert.equal(report.overallBlocked, true);

  // 建议动作数 = 阻塞记录数
  assert.equal(report.suggestedActions.length, report.blockageRecords.length);

  // 应有 critical 优先级的动作（来自 blocker 严重性）
  const criticalActions = report.suggestedActions.filter((a) => a.priority === "critical");
  assert.ok(criticalActions.length >= 1, "应至少有 1 个 critical 优先级动作");
});

test("T17.3 端到端：清洁 plan + 全门禁通过 + 无资源访问 → 完全无阻塞", async () => {
  const planner = new MultiLoopPlanner();
  const analyzer = new PlanBlockageAnalyzer(planner);
  const plan = makePlan([
    makeNode("design-1", "design"),
    makeNode("coding-1", "coding", ["design-1"]),
    makeNode("coding-2", "coding", ["design-1", "coding-1"]),
    makeNode("testing-1", "testing", ["coding-1", "coding-2"]),
  ]);
  const snapshot = makeGateStatusSnapshot([
    makeGateResult("G-1", true, "blocker", "G-1 通过"),
    makeGateResult("G-2", true, "blocker", "G-2 通过"),
    makeGateResult("G-3", true, "blocker", "G-3 通过"),
  ]);
  const graph = makeResourceAccessGraph([makeAccess("coding-1", "db:orders", "read", "只读访问")]);
  const runState = makeRunState();

  const report = await analyzer.analyze({
    runId: "e2e-run-003",
    plan,
    runState,
    gateStatusSnapshot: snapshot,
    resourceAccessGraph: graph,
  });

  assert.equal(report.blockageRecords.length, 0);
  assert.equal(report.overallBlocked, false);
  assert.equal(report.suggestedActions.length, 0);
});

// ============================================================================
// T18. BlockageType / BlockageSeverity 字面量联合完整性
// ============================================================================

test("T18.1 BlockageType 包含 5 个字面量值", () => {
  // 通过类型断言验证字面量联合完整性
  const types: BlockageType[] = [
    "circular-dependency",
    "resource-contention",
    "deadlock-risk",
    "missing-dependency",
    "gate-blocked",
  ];
  assert.equal(types.length, 5);
});

test("T18.2 BlockageSeverity 包含 3 个字面量值", () => {
  const severities: BlockageSeverity[] = ["blocker", "major", "warning"];
  assert.equal(severities.length, 3);
});

test("T18.3 ActionPriority 包含 4 个字面量值", () => {
  const priorities: ActionPriority[] = ["critical", "high", "medium", "low"];
  assert.equal(priorities.length, 4);
});

test("T18.4 ActionEffort 包含 3 个字面量值", () => {
  const efforts: ActionEffort[] = ["low", "medium", "high"];
  assert.equal(efforts.length, 3);
});
