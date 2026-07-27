/**
 * EAG-P3 批次 12 C1 单元测试拆分文件 5/5：报告不可变性 + 可选字段 + 字段填充策略
 *
 * 拆分来源：eag-long-horizon-plan-blockage-analyzer.test.ts
 * 包含测试用例前缀：T11 + T12 + T15
 *
 * 测试范围：
 * - T11. 报告不可变性（Object.freeze + ReadonlyArray + 深冻结）
 * - T12. 可选字段省略（不传 gateStatusSnapshot / resourceAccessGraph 跳过对应通道）
 * - T15. 既有 BlockageReport 字段填充策略（rootCauseHypotheses 等空数组）
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
 * @module core/tests/eag-blockage-immutability-report
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { PlanBlockageAnalyzer } from "../eag/long-horizon/plan-blockage-analyzer";
import type { BlockageAnalysisReport } from "../eag/long-horizon/types";
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
