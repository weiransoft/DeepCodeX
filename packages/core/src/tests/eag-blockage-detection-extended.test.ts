/**
 * EAG-P3 批次 12 C1 单元测试拆分文件 3/5：扩展阻塞检测通道 + 边界 + 日志 + 端到端
 *
 * 拆分来源：eag-long-horizon-plan-blockage-analyzer.test.ts
 * 包含测试用例前缀：T7 + T8 + T13 + T16 + T17
 *
 * 测试范围：
 * - T7.  门禁阻塞检测（gate-blocked，passed=false / passed=true 不记录 / 多门禁失败）
 * - T8.  多通道组合（循环依赖 + 资源竞争 + 死锁 + 门禁 同时触发）
 * - T13. 边界场景（空 plan / 单节点 plan / 自依赖节点）
 * - T16. 日志回调注入（自定义 logger 接收正确级别与消息）
 * - T17. 端到端综合场景（模拟真实 EAG Run）
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
 * @module core/tests/eag-blockage-detection-extended
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { PlanBlockageAnalyzer } from "../eag/long-horizon/plan-blockage-analyzer";
import {
  makeNode,
  makePlan,
  makeRunState,
  makeAccess,
  makeResourceAccessGraph,
  makeGateResult,
  makeGateStatusSnapshot,
  makeLogCollector,
} from "./fixtures/eag-blockage-fixtures";

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
