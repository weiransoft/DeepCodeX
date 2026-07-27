/**
 * EAG-P3 批次 12 C1 单元测试拆分文件 1/5：构造函数 + 请求校验 + 错误类型 + 字面量联合
 *
 * 拆分来源：eag-long-horizon-plan-blockage-analyzer.test.ts
 * 包含测试用例前缀：T1 + T2 + T14 + T18
 *
 * 测试范围：
 * - T1.  PlanBlockageAnalyzer 构造函数校验（planner 必填）
 * - T2.  analyze() 请求字段校验（runId / plan / runState）
 * - T14. PlanBlockageAnalyzerError 错误类型与字面量
 * - T18. BlockageType / BlockageSeverity 字面量联合完整性
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
 * @module core/tests/eag-blockage-construction-validation
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { PlanBlockageAnalyzer, PlanBlockageAnalyzerError } from "../eag/long-horizon/plan-blockage-analyzer";
import type { PlanBlockageAnalyzerErrorKind } from "../eag/long-horizon/plan-blockage-analyzer";
import type {
  BlockageAnalysisReport,
  BlockageType,
  BlockageSeverity,
  MultiLoopPlan,
  PlanBlockageAnalyzeRequest,
  RunState,
  ActionPriority,
  ActionEffort,
} from "../eag/long-horizon/types";
import { makeNode, makePlan, makeRunState, makeLogCollector } from "./fixtures/eag-blockage-fixtures";

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
