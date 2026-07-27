/**
 * EAG-P3 批次 12 C1 单元测试拆分文件 4/5：建议动作 + overallBlocked 判定
 *
 * 拆分来源：eag-long-horizon-plan-blockage-analyzer.test.ts
 * 包含测试用例前缀：T9 + T10
 *
 * 测试范围：
 * - T9.  建议动作生成（SuggestedAction 字段映射正确性 + 优先级映射 + 成本映射）
 * - T10. overallBlocked 判定（blocker 触发 true / 仅 warning 触发 false / 空记录 false）
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
 * @module core/tests/eag-blockage-actions-blocked
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { PlanBlockageAnalyzer } from "../eag/long-horizon/plan-blockage-analyzer";
import type { ActionPriority, ActionEffort } from "../eag/long-horizon/types";
import {
  makeNode,
  makePlan,
  makeRunState,
  makeAccess,
  makeResourceAccessGraph,
  makeGateResult,
  makeGateStatusSnapshot,
} from "./fixtures/eag-blockage-fixtures";

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
