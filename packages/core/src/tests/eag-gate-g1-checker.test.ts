/**
 * EAG-P2 批次 8 单元测试：G-1 门禁检查器
 *
 * 测试范围：
 * - T1. GateG1Checker 实例化与 gateId
 *   - T1a. 实例化成功
 *   - T1b. gateId 为 "G-1"
 *   - T1c. 实现 GateChecker 协议
 * - T2. spec.md 与 plan.md 均已批准 → 通过
 * - T3. spec.md 未批准 → 失败（blocker）
 *   - T3a. specStatus="draft"
 *   - T3b. specStatus="reviewing"
 *   - T3c. specStatus="rejected"
 * - T4. spec.md 已批准但 plan.md 未批准 → 失败（blocker）
 *   - T4a. planStatus="draft"
 *   - T4b. planStatus="reviewing"
 *   - T4c. planStatus="rejected"
 * - T5. 失败结果含引导消息
 * - T6. 失败结果 severity 为 blocker
 * - T7. 结果对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-gate-g1-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG1Checker } from "../eag/gate/gate-g1-checker";
import type { GateChecker, GateContext, GateResult } from "../eag/gate/gate-types";
import type { DocumentState } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造 GateContext
// ============================================================================

/**
 * 构造测试用 GateContext（默认 spec/plan 均已批准）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GateContext
 */
function createContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    projectId: "test-project",
    loopType: "coding",
    specStatus: "approved" as DocumentState,
    planStatus: "approved" as DocumentState,
    reviewRecords: [],
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
// T1. GateG1Checker 实例化与 gateId
// ============================================================================

test("T1a. GateG1Checker 实例化成功", () => {
  const checker = new GateG1Checker();
  assert.ok(checker instanceof GateG1Checker);
});

test("T1b. gateId 为 G-1", () => {
  const checker = new GateG1Checker();
  assert.equal(checker.gateId, "G-1");
});

test("T1c. 实现 GateChecker 协议", () => {
  const checker: GateChecker = new GateG1Checker();
  assert.equal(checker.gateId, "G-1");
  assert.equal(typeof checker.check, "function");
});

// ============================================================================
// T2. spec.md 与 plan.md 均已批准 → 通过
// ============================================================================

test("T2. spec.md 与 plan.md 均已批准 → 通过", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "approved", planStatus: "approved" });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-1");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("均已批准"));
});

// ============================================================================
// T3. spec.md 未批准 → 失败（blocker）
// ============================================================================

test("T3a. specStatus=draft → 失败", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "draft" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-1");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("draft"));
});

test("T3b. specStatus=reviewing → 失败", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "reviewing" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("reviewing"));
});

test("T3c. specStatus=rejected → 失败", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "rejected" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("rejected"));
});

// ============================================================================
// T4. spec.md 已批准但 plan.md 未批准 → 失败（blocker）
// ============================================================================

test("T4a. planStatus=draft → 失败", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "approved", planStatus: "draft" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("plan.md"));
  assert.ok(result.reason.includes("draft"));
});

test("T4b. planStatus=reviewing → 失败", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "approved", planStatus: "reviewing" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("plan.md"));
  assert.ok(result.reason.includes("reviewing"));
});

test("T4c. planStatus=rejected → 失败", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "approved", planStatus: "rejected" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("plan.md"));
  assert.ok(result.reason.includes("rejected"));
});

// ============================================================================
// T5. 失败结果含引导消息
// ============================================================================

test("T5. 失败结果含引导消息（建议进入 DESIGN Loop）", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "draft" });
  const result = checker.check(ctx);
  assert.ok(result.guidance !== undefined);
  assert.ok(result.guidance!.includes("DESIGN Loop"));
});

// ============================================================================
// T6. 失败结果 severity 为 blocker
// ============================================================================

test("T6. 失败结果 severity 为 blocker", () => {
  const checker = new GateG1Checker();
  const ctx = createContext({ specStatus: "draft" });
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T7. 结果对象已冻结
// ============================================================================

test("T7. 结果对象已冻结", () => {
  const checker = new GateG1Checker();
  const ctx = createContext();
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});
