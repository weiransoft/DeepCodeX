/**
 * EAG-P2 批次 9 S3 单元测试：G-5 退出门禁检查器
 *
 * 测试范围：
 * - T1. GateG5Checker 实例化与 gateId
 *   - T1a. 实例化成功（需注入 StrictEvaluator）
 *   - T1b. gateId 为 "G-5"
 *   - T1c. 实现 GateChecker 协议
 *   - T1d. getEvaluator 返回注入的 StrictEvaluator
 * - T2. 全部字段合法 → 通过
 * - T3. allTaskCards 为空 → 失败
 * - T4. allTaskCards 含未完成任务卡 → 失败
 *   - T4a. 单个任务卡 status=pending
 *   - T4b. 单个任务卡 status=blocked
 *   - T4c. 多个任务卡部分未完成
 * - T5. finalEvaluationReport.verdict 非 pass → 失败
 *   - T5a. verdict=fix
 *   - T5b. verdict=human_checkpoint
 *   - T5c. verdict=stop_failure
 * - T6. finalEvaluationReport 缺失 → 失败
 * - T7. gitClean=false → 失败
 * - T8. gitleaksPassed=false → 失败
 * - T9. 失败结果含引导消息
 * - T10. 失败结果 severity 为 blocker
 * - T11. 结果对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（StrictEvaluator / EvaluationReport）
 *
 * @module core/tests/eag-gate-g5-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG5Checker } from "../eag/gate/gate-g5-checker";
import type { GateChecker, GateContext, GateG5Context, GateResult } from "../eag/gate/gate-types";
import type { DocumentState, TaskCard } from "../eag/doc-driven/types";
import { StrictEvaluator } from "../eag/coding/strict-evaluator";
import type { EvaluationReport, EvaluationVerdict } from "../eag/evaluator/types";

// ============================================================================
// 辅助函数：构造 TaskCard
// ============================================================================

/**
 * 构造测试用 TaskCard
 *
 * @param id 任务卡 ID
 * @param status 任务卡状态
 * @returns 完整的 TaskCard
 */
function createTaskCard(id: string, status: TaskCard["status"] = "completed"): TaskCard {
  return {
    id,
    title: `任务 ${id}`,
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["npm test"],
    status,
    declaredSymbols: [`src/file.ts:${id}.method`],
  };
}

// ============================================================================
// 辅助函数：构造 EvaluationReport
// ============================================================================

/**
 * 构造测试用 EvaluationReport
 *
 * @param verdict 评估结论
 * @param overrides 覆盖字段
 * @returns 完整的 EvaluationReport
 */
function createEvaluationReport(
  verdict: EvaluationVerdict = "pass",
  overrides: Partial<EvaluationReport> = {}
): EvaluationReport {
  return {
    verdict,
    redlineResults: [],
    blockerCount: 0,
    majorCount: 0,
    warningCount: 0,
    durationMs: 100,
    notes: "测试评估报告",
    ...overrides,
  };
}

// ============================================================================
// 辅助函数：构造 GateG5Context
// ============================================================================

/**
 * 构造测试用 GateG5Context（默认全部字段合法）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GateG5Context
 */
function createG5Context(overrides: Partial<GateG5Context> = {}): GateG5Context {
  const baseContext: GateG5Context = {
    projectId: "test-project",
    loopType: "coding",
    specStatus: "approved" as DocumentState,
    planStatus: "approved" as DocumentState,
    reviewRecords: [],
    userApproved: true,
    taskCard: createTaskCard("T-001", "completed"),
    actualChanges: [],
    allTaskCards: [createTaskCard("T-001", "completed"), createTaskCard("T-002", "completed")],
    finalEvaluationReport: createEvaluationReport("pass"),
    gitClean: true,
    gitleaksPassed: true,
  };
  return { ...baseContext, ...overrides };
}

// ============================================================================
// T1. GateG5Checker 实例化与 gateId
// ============================================================================

test("T1a. GateG5Checker 实例化成功（注入 StrictEvaluator）", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  assert.ok(checker instanceof GateG5Checker);
});

test("T1b. gateId 为 G-5", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  assert.equal(checker.gateId, "G-5");
});

test("T1c. 实现 GateChecker 协议", () => {
  const evaluator = new StrictEvaluator();
  const checker: GateChecker = new GateG5Checker(evaluator);
  assert.equal(checker.gateId, "G-5");
  assert.equal(typeof checker.check, "function");
});

test("T1d. getEvaluator 返回注入的 StrictEvaluator", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const retrieved = checker.getEvaluator();
  assert.equal(retrieved, evaluator);
  assert.equal(retrieved.getName(), "StrictEvaluator");
});

// ============================================================================
// T2. 全部字段合法 → 通过
// ============================================================================

test("T2. 全部字段合法 → 通过", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-5");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("G-5 门禁通过"));
});

// ============================================================================
// T3. allTaskCards 为空 → 失败
// ============================================================================

test("T3a. allTaskCards 为空数组 → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({ allTaskCards: [] });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("allTaskCards"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T4. allTaskCards 含未完成任务卡 → 失败
// ============================================================================

test("T4a. 单个任务卡 status=pending → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({
    allTaskCards: [createTaskCard("T-001", "completed"), createTaskCard("T-002", "pending")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("T-002"));
  assert.ok(result.reason.includes("pending"));
});

test("T4b. 单个任务卡 status=blocked → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({
    allTaskCards: [createTaskCard("T-001", "completed"), createTaskCard("T-002", "blocked")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("T-002"));
  assert.ok(result.reason.includes("blocked"));
});

test("T4c. 多个任务卡部分未完成 → 失败（含未完成数）", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({
    allTaskCards: [
      createTaskCard("T-001", "completed"),
      createTaskCard("T-002", "in-progress"),
      createTaskCard("T-003", "pending"),
      createTaskCard("T-004", "blocked"),
    ],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("3"));
  assert.ok(result.reason.includes("T-002"));
  assert.ok(result.reason.includes("T-003"));
  assert.ok(result.reason.includes("T-004"));
});

// ============================================================================
// T5. finalEvaluationReport.verdict 非 pass → 失败
// ============================================================================

test("T5a. finalEvaluationReport.verdict=fix → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({
    finalEvaluationReport: createEvaluationReport("fix", {
      blockerCount: 1,
      majorCount: 2,
    }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("fix"));
  assert.ok(result.reason.includes("blocker=1"));
  assert.ok(result.reason.includes("major=2"));
});

test("T5b. finalEvaluationReport.verdict=human_checkpoint → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({
    finalEvaluationReport: createEvaluationReport("human_checkpoint"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("human_checkpoint"));
});

test("T5c. finalEvaluationReport.verdict=stop_failure → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({
    finalEvaluationReport: createEvaluationReport("stop_failure"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("stop_failure"));
});

// ============================================================================
// T6. finalEvaluationReport 缺失 → 失败
// ============================================================================

test("T6. finalEvaluationReport 缺失 verdict 字段 → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  // 构造 verdict 字段非法的上下文：将 verdict 设为 undefined
  // 由于 EvaluationReport.verdict 是必填字段，需通过类型断言绕过编译检查
  const ctx = createG5Context({
    finalEvaluationReport: { verdict: undefined } as unknown as EvaluationReport,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("finalEvaluationReport"));
});

// ============================================================================
// T7. gitClean=false → 失败
// ============================================================================

test("T7. gitClean=false → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({ gitClean: false });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("git"));
  assert.ok(result.reason.includes("不干净"));
});

// ============================================================================
// T8. gitleaksPassed=false → 失败
// ============================================================================

test("T8. gitleaksPassed=false → 失败", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({ gitleaksPassed: false });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("gitleaks"));
  assert.ok(result.reason.includes("未通过"));
});

// ============================================================================
// T9. 失败结果含引导消息
// ============================================================================

test("T9. 失败结果含引导消息（建议继续完成/修复后重试）", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({ gitClean: false });
  const result = checker.check(ctx);
  assert.ok(result.guidance !== undefined);
  assert.ok(result.guidance!.includes("重试"));
});

// ============================================================================
// T10. 失败结果 severity 为 blocker
// ============================================================================

test("T10. 失败结果 severity 为 blocker", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({ gitClean: false });
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T11. 结果对象已冻结
// ============================================================================

test("T11a. 通过结果对象已冻结", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context();
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

test("T11b. 失败结果对象已冻结", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  const ctx = createG5Context({ gitClean: false });
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

// ============================================================================
// T12. 检查顺序：allTaskCards → evaluationReport → gitClean → gitleaks
// ============================================================================

test("T12a. 检查顺序：allTaskCards 失败时优先返回（不检查后续）", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  // 同时设置 allTaskCards 不通过 + gitClean=false，应优先返回任务卡失败原因
  const ctx = createG5Context({
    allTaskCards: [createTaskCard("T-001", "pending")],
    gitClean: false,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("T-001"));
  assert.ok(!result.reason.includes("git"));
});

test("T12b. 检查顺序：evaluationReport 失败时优先于 gitClean", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  // 同时设置 evaluationReport.verdict=fix + gitClean=false，应优先返回评估失败原因
  const ctx = createG5Context({
    finalEvaluationReport: createEvaluationReport("fix"),
    gitClean: false,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("fix"));
  assert.ok(!result.reason.includes("git"));
});

// ============================================================================
// T13. GateContext 类型入参（向上转型兼容性）
// ============================================================================

test("T13. GateContext 类型入参仍可被 check 接收（运行时按 G5 处理）", () => {
  const evaluator = new StrictEvaluator();
  const checker = new GateG5Checker(evaluator);
  // GateG5Context 继承自 GateContext，可向上转型为 GateContext 传入
  const g5Context: GateContext = createG5Context();
  const result = checker.check(g5Context);
  assert.equal(result.passed, true);
});
