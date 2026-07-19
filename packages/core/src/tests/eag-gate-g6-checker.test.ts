/**
 * EAG-P3 批次 10 单元测试：G-6 TESTING Loop 进入门禁检查器
 *
 * 测试范围：
 * - T1. g5Passed=false → passed=false, severity=blocker
 * - T2. unitTestsPassed=false → passed=false
 * - T3. specStatus="draft" → passed=false
 * - T4. specStatus="rejected" → passed=false
 * - T5. implementationRoot="" → passed=false
 * - T6. 全部字段合法 → passed=true
 * - T7. gateId 为 "G-6"
 * - T8. 失败时 guidance 非空
 * - T9. 返回结果已冻结（Object.isFrozen(result)===true）
 * - T10. 多重失败一次性收集到 failures 列表
 * - T11. 实现 GateChecker 协议
 * - T12. implementationRoot 为空白字符串（仅空格）→ passed=false
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（GateG6Context / DocumentState / TaskCard）
 *
 * @module core/tests/eag-gate-g6-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG6Checker } from "../eag/gate/gate-g6-checker";
import type { GateChecker, GateContext, GateG6Context, GateResult, DocumentState } from "../eag/gate/gate-types";
import type { TaskCard } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造 TaskCard
// ============================================================================

/**
 * 构造测试用 TaskCard（默认 status=completed）
 *
 * @param id 任务卡 ID
 * @param status 任务卡状态（默认 completed）
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
// 辅助函数：构造 GateG6Context
// ============================================================================

/**
 * 构造测试用 GateG6Context（默认全部字段合法）
 *
 * 默认值：
 * - projectId: "test-project"
 * - loopType: "testing"
 * - specStatus: "approved"
 * - planStatus: "approved"
 * - reviewRecords: []
 * - userApproved: true
 * - taskCard: { id: "T-001", status: "completed", ... }
 * - actualChanges: []
 * - g5Passed: true
 * - unitTestsPassed: true
 * - implementationRoot: "src/"
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GateG6Context
 */
function createG6Context(overrides: Partial<GateG6Context> = {}): GateG6Context {
  const baseContext: GateG6Context = {
    projectId: "test-project",
    loopType: "testing",
    specStatus: "approved" as DocumentState,
    planStatus: "approved" as DocumentState,
    reviewRecords: [],
    userApproved: true,
    taskCard: createTaskCard("T-001", "completed"),
    actualChanges: [],
    g5Passed: true,
    unitTestsPassed: true,
    implementationRoot: "src/",
  };
  return { ...baseContext, ...overrides };
}

// ============================================================================
// T1. g5Passed=false → passed=false, severity=blocker
// ============================================================================

test("T1. g5Passed=false → passed=false, severity=blocker", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ g5Passed: false });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-6");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("G-5"));
  assert.ok(result.reason.includes("未通过"));
});

// ============================================================================
// T2. unitTestsPassed=false → passed=false
// ============================================================================

test("T2. unitTestsPassed=false → passed=false", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ unitTestsPassed: false });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-6");
  assert.ok(result.reason.includes("单元测试"));
  assert.ok(result.reason.includes("未全过"));
});

// ============================================================================
// T3. specStatus="draft" → passed=false
// ============================================================================

test("T3. specStatus=draft → passed=false", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ specStatus: "draft" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("spec.md"));
  assert.ok(result.reason.includes("draft"));
});

// ============================================================================
// T4. specStatus="rejected" → passed=false
// ============================================================================

test("T4. specStatus=rejected → passed=false", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ specStatus: "rejected" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("rejected"));
});

// ============================================================================
// T5. implementationRoot="" → passed=false
// ============================================================================

test("T5. implementationRoot 为空字符串 → passed=false", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ implementationRoot: "" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("implementationRoot"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T6. 全部字段合法 → passed=true
// ============================================================================

test("T6. 全部字段合法 → passed=true", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-6");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("G-6 门禁通过"));
  assert.ok(result.reason.includes("src/"));
});

// ============================================================================
// T7. gateId 为 "G-6"
// ============================================================================

test("T7. gateId 为 G-6", () => {
  const checker = new GateG6Checker();
  assert.equal(checker.gateId, "G-6");
});

// ============================================================================
// T8. 失败时 guidance 非空
// ============================================================================

test("T8. 失败时 guidance 非空", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ g5Passed: false });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.guidance !== undefined);
  assert.ok((result.guidance ?? "").length > 0);
  assert.ok(result.guidance!.includes("G-6"));
});

// ============================================================================
// T9. 返回结果已冻结
// ============================================================================

test("T9. 返回结果已冻结（Object.isFrozen(result)===true）", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context();
  const result = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

test("T9b. 失败结果已冻结", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ g5Passed: false });
  const result = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

// ============================================================================
// T10. 多重失败一次性收集到 failures 列表
// ============================================================================

test("T10. 多重失败一次性收集到 failures 列表", () => {
  const checker = new GateG6Checker();
  // 同时触发 4 项失败：g5Passed=false / unitTestsPassed=false / specStatus=draft / implementationRoot=""
  const ctx = createG6Context({
    g5Passed: false,
    unitTestsPassed: false,
    specStatus: "draft" as DocumentState,
    implementationRoot: "",
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // reason 中应包含全部 4 项失败提示
  assert.ok(result.reason.includes("G-5"), `应包含 G-5 失败提示，实际：${result.reason}`);
  assert.ok(result.reason.includes("单元测试"), `应包含单元测试失败提示，实际：${result.reason}`);
  assert.ok(result.reason.includes("spec.md"), `应包含 spec.md 失败提示，实际：${result.reason}`);
  assert.ok(result.reason.includes("implementationRoot"), `应包含 implementationRoot 失败提示，实际：${result.reason}`);
  // 应明确提示失败项数量
  assert.ok(result.reason.includes("4 项失败"), `应提示共 4 项失败，实际：${result.reason}`);
});

// ============================================================================
// T11. 实现 GateChecker 协议
// ============================================================================

test("T11. 实现 GateChecker 协议", () => {
  const checker: GateChecker = new GateG6Checker();
  assert.equal(checker.gateId, "G-6");
  assert.equal(typeof checker.check, "function");
});

// ============================================================================
// T12. implementationRoot 为空白字符串（仅空格）→ passed=false
// ============================================================================

test("T12. implementationRoot 为空白字符串（仅空格）→ passed=false", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ implementationRoot: "   " });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("implementationRoot"));
});

// ============================================================================
// T13. 全部字段合法（specStatus=reviewing 也应失败）
// ============================================================================

test("T13. specStatus=reviewing → passed=false（仅 approved 通过）", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ specStatus: "reviewing" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("reviewing"));
});

// ============================================================================
// T14. 通过结果中 reason 包含 implementationRoot 实际值
// ============================================================================

test("T14. 通过结果中 reason 包含 implementationRoot 实际值", () => {
  const checker = new GateG6Checker();
  const ctx = createG6Context({ implementationRoot: "packages/core/src/" });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("packages/core/src/"));
});

// ============================================================================
// T15. 兼容 GateContext 协议（check 接受 GateContext 类型）
// ============================================================================

test("T15. check 方法接受 GateContext 类型参数（兼容性）", () => {
  const checker = new GateG6Checker();
  // GateG6Context extends GateContext，因此可以传入 GateContext 类型的引用
  const ctx: GateContext = createG6Context();
  const result: GateResult = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-6");
});
