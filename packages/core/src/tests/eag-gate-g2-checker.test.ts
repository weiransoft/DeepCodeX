/**
 * EAG-P2 批次 8 单元测试：G-2 门禁检查器
 *
 * 测试范围：
 * - T1. GateG2Checker 实例化与 gateId
 * - T2. 完整评审（4 角色 approve）+ 用户批准 → 通过
 * - T3. 最少评审（2 角色 architect + test-expert approve）+ 用户批准 → 通过（warning）
 * - T4. 评审角色数 < 2 → 失败（blocker）
 * - T5. 评审角色缺少 architect → 失败
 * - T6. 评审角色缺少 test-expert → 失败
 * - T7. 评审记录含 reject → 失败
 * - T8. 用户未批准 → 失败
 * - T9. 失败结果含引导消息
 * - T10. 失败结果 severity 为 blocker
 * - T11. 完整评审（4 角色）通过时 severity 为 blocker
 * - T12. 部分评审（3 角色）通过时 severity 为 warning
 * - T13. 结果对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-gate-g2-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG2Checker } from "../eag/gate/gate-g2-checker";
import type { GateChecker, GateContext, GateResult, ReviewRecord } from "../eag/gate/gate-types";

// ============================================================================
// 辅助函数：构造 ReviewRecord
// ============================================================================

/**
 * 构造测试用 ReviewRecord
 *
 * @param role 评审角色
 * @param verdict 评审结论（默认 approve）
 * @returns 评审记录
 */
function createReviewRecord(role: ReviewRecord["role"], verdict: ReviewRecord["verdict"] = "approve"): ReviewRecord {
  return {
    role,
    reviewer: `reviewer-${role}`,
    verdict,
    comments: `${role} 评审意见`,
    reviewedAt: "2026-07-19T10:00:00.000Z",
  };
}

/**
 * 构造测试用 GateContext（默认含 4 角色完整评审 + 用户已批准）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GateContext
 */
function createContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    projectId: "test-project",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [
      createReviewRecord("architect"),
      createReviewRecord("pm"),
      createReviewRecord("test-expert"),
      createReviewRecord("solo-coder"),
    ],
    userApproved: true,
    taskCard: {
      id: "T-001",
      title: "测试任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
    actualChanges: [],
    ...overrides,
  };
}

// ============================================================================
// T1. GateG2Checker 实例化与 gateId
// ============================================================================

test("T1. GateG2Checker 实例化与 gateId 为 G-2", () => {
  const checker = new GateG2Checker();
  assert.ok(checker instanceof GateG2Checker);
  assert.equal(checker.gateId, "G-2");
  // 验证实现 GateChecker 协议
  const asChecker: GateChecker = checker;
  assert.equal(typeof asChecker.check, "function");
});

// ============================================================================
// T2. 完整评审（4 角色 approve）+ 用户批准 → 通过
// ============================================================================

test("T2. 完整评审（4 角色 approve）+ 用户批准 → 通过", () => {
  const checker = new GateG2Checker();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-2");
  assert.ok(result.reason.includes("4 角色完整评审"));
});

// ============================================================================
// T3. 最少评审（2 角色 architect + test-expert approve）+ 用户批准 → 通过（warning）
// ============================================================================

test("T3. 最少评审（2 角色）+ 用户批准 → 通过（warning）", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({
    reviewRecords: [createReviewRecord("architect"), createReviewRecord("test-expert")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "warning");
  assert.ok(result.reason.includes("2 角色评审"));
});

// ============================================================================
// T4. 评审角色数 < 2 → 失败（blocker）
// ============================================================================

test("T4. 评审角色数 < 2（仅 1 角色）→ 失败", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({
    reviewRecords: [createReviewRecord("architect")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("1") && result.reason.includes("2"));
});

// ============================================================================
// T5. 评审角色缺少 architect → 失败
// ============================================================================

test("T5. 评审角色缺少 architect → 失败", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({
    reviewRecords: [createReviewRecord("pm"), createReviewRecord("test-expert")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("architect"));
});

// ============================================================================
// T6. 评审角色缺少 test-expert → 失败
// ============================================================================

test("T6. 评审角色缺少 test-expert → 失败", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({
    reviewRecords: [createReviewRecord("architect"), createReviewRecord("pm")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("test-expert"));
});

// ============================================================================
// T7. 评审记录含 reject → 失败
// ============================================================================

test("T7. 评审记录含 reject → 失败", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({
    reviewRecords: [
      createReviewRecord("architect", "reject"),
      createReviewRecord("test-expert"),
      createReviewRecord("pm"),
      createReviewRecord("solo-coder"),
    ],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("reject"));
  assert.ok(result.reason.includes("architect"));
});

// ============================================================================
// T8. 用户未批准 → 失败
// ============================================================================

test("T8. 用户未批准 → 失败", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({ userApproved: false });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("用户未显式批准"));
});

// ============================================================================
// T9. 失败结果含引导消息
// ============================================================================

test("T9. 失败结果含引导消息（建议召集多角色评审会议）", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({ userApproved: false });
  const result = checker.check(ctx);
  assert.ok(result.guidance !== undefined);
  assert.ok(result.guidance!.includes("多角色评审会议"));
});

// ============================================================================
// T10. 失败结果 severity 为 blocker
// ============================================================================

test("T10. 失败结果 severity 为 blocker", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({ userApproved: false });
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T11. 完整评审（4 角色）通过时 severity 为 blocker
// ============================================================================

test("T11. 完整评审（4 角色）通过时 severity 为 blocker", () => {
  const checker = new GateG2Checker();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T12. 部分评审（3 角色）通过时 severity 为 warning
// ============================================================================

test("T12. 部分评审（3 角色）通过时 severity 为 warning", () => {
  const checker = new GateG2Checker();
  const ctx = createContext({
    reviewRecords: [createReviewRecord("architect"), createReviewRecord("test-expert"), createReviewRecord("pm")],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "warning");
  assert.ok(result.reason.includes("3 角色评审"));
});

// ============================================================================
// T13. 结果对象已冻结
// ============================================================================

test("T13. 结果对象已冻结", () => {
  const checker = new GateG2Checker();
  const ctx = createContext();
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});
