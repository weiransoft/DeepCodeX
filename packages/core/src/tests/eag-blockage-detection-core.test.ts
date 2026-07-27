/**
 * EAG-P3 批次 12 C1 单元测试拆分文件 2/5：核心阻塞检测通道
 *
 * 拆分来源：eag-long-horizon-plan-blockage-analyzer.test.ts
 * 包含测试用例前缀：T3 + T4 + T5 + T6
 *
 * 测试范围：
 * - T3.  循环依赖检测（circular-dependency，3 节点环 / 2 节点环 / 自环）
 * - T4.  缺失依赖检测（missing-dependency，单节点缺依赖 / 多节点缺依赖）
 * - T5.  资源竞争检测（resource-contention，2 节点并行访问 / 多节点并行访问 / 串行无竞争）
 * - T6.  死锁风险检测（deadlock-risk，2 节点循环等待 / 3 节点循环等待 / 无环无死锁）
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
 * @module core/tests/eag-blockage-detection-core
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
} from "./fixtures/eag-blockage-fixtures";

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
