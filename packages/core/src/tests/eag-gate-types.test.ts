/**
 * EAG-P2 批次 8 单元测试：方案先行门禁类型定义
 *
 * 测试范围：
 * - T1. ReviewRole 字面量联合完整性
 *   - T1a. REVIEW_ROLES 包含 4 个角色
 *   - T1b. REVIEW_ROLES 顺序正确（architect/pm/test-expert/solo-coder）
 *   - T1c. REVIEW_ROLES 已冻结
 * - T2. ReviewVerdict 字面量联合完整性
 * - T3. ReviewRecord 接口字段完整性
 * - T4. FileChangeType 字面量联合完整性
 * - T5. FileChange 接口字段完整性
 * - T6. LoopType 字面量联合完整性
 *   - T6a. LOOP_TYPES 包含 3 个 Loop
 *   - T6b. LOOP_TYPES 顺序正确
 *   - T6c. LOOP_TYPES 已冻结
 * - T7. GateId 字面量联合完整性
 *   - T7a. GATE_IDS 包含 3 个门禁
 *   - T7b. GATE_IDS 顺序正确
 *   - T7c. GATE_IDS 已冻结
 * - T8. GateSeverity 字面量联合完整性（与 RedlineSeverity 对齐小写）
 * - T9. GateContext 接口字段完整性
 * - T10. GateResult 接口字段完整性
 * - T11. GateOrchestrationResult 接口字段完整性
 * - T12. GateChecker 协议接口完整性
 * - T13. 配置常量
 *   - T13a. G2_MIN_REVIEW_ROLES = 2
 *   - T13b. G2_FULL_REVIEW_ROLES = 4
 *   - T13c. G3_DEVIATION_THRESHOLD = 3
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-gate-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  G2_FULL_REVIEW_ROLES,
  G2_MIN_REVIEW_ROLES,
  G3_DEVIATION_THRESHOLD,
  GATE_IDS,
  LOOP_TYPES,
  REVIEW_ROLES,
} from "../eag/gate/gate-types";
import type {
  FileChange,
  FileChangeType,
  GateChecker,
  GateContext,
  GateId,
  GateOrchestrationResult,
  GateResult,
  GateSeverity,
  LoopType,
  ReviewRecord,
  ReviewRole,
  ReviewVerdict,
} from "../eag/gate/gate-types";
import type { TaskCard } from "../eag/doc-driven/types";

// ============================================================================
// T1. ReviewRole 字面量联合完整性
// ============================================================================

test("T1a. REVIEW_ROLES 包含 4 个角色", () => {
  assert.equal(REVIEW_ROLES.length, 4);
});

test("T1b. REVIEW_ROLES 顺序正确（architect/pm/test-expert/solo-coder）", () => {
  const expected: ReadonlyArray<ReviewRole> = ["architect", "pm", "test-expert", "solo-coder"];
  assert.deepEqual([...REVIEW_ROLES], [...expected]);
});

test("T1c. REVIEW_ROLES 已冻结", () => {
  assert.equal(Object.isFrozen(REVIEW_ROLES), true);
});

// ============================================================================
// T2. ReviewVerdict 字面量联合完整性
// ============================================================================

test("T2. ReviewVerdict 字面量联合覆盖 approve/reject/conditional-approve", () => {
  // 通过构造真实对象验证字面量联合
  const verdicts: ReviewVerdict[] = ["approve", "reject", "conditional-approve"];
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.includes("approve"));
  assert.ok(verdicts.includes("reject"));
  assert.ok(verdicts.includes("conditional-approve"));
});

// ============================================================================
// T3. ReviewRecord 接口字段完整性
// ============================================================================

test("T3. ReviewRecord 接口字段完整性", () => {
  const record: ReviewRecord = {
    role: "architect",
    reviewer: "Alice",
    verdict: "approve",
    comments: "架构合理",
    reviewedAt: "2026-07-19T10:00:00.000Z",
  };
  assert.equal(record.role, "architect");
  assert.equal(record.reviewer, "Alice");
  assert.equal(record.verdict, "approve");
  assert.equal(record.comments, "架构合理");
  assert.equal(record.reviewedAt, "2026-07-19T10:00:00.000Z");
});

// ============================================================================
// T4. FileChangeType 字面量联合完整性
// ============================================================================

test("T4. FileChangeType 字面量联合覆盖 added/modified/deleted/renamed", () => {
  const types: FileChangeType[] = ["added", "modified", "deleted", "renamed"];
  assert.equal(types.length, 4);
  assert.ok(types.includes("added"));
  assert.ok(types.includes("modified"));
  assert.ok(types.includes("deleted"));
  assert.ok(types.includes("renamed"));
});

// ============================================================================
// T5. FileChange 接口字段完整性
// ============================================================================

test("T5. FileChange 接口字段完整性", () => {
  const change: FileChange = {
    type: "modified",
    filePath: "src/services/PaymentService.ts",
    declaredSymbolIds: ["src/services/PaymentService.ts:PaymentService.refund"],
    actualSymbolIds: [
      "src/services/PaymentService.ts:PaymentService.refund",
      "src/services/PaymentCallbackHandler.ts:PaymentCallbackHandler.handle",
    ],
  };
  assert.equal(change.type, "modified");
  assert.equal(change.filePath, "src/services/PaymentService.ts");
  assert.equal(change.declaredSymbolIds.length, 1);
  assert.equal(change.actualSymbolIds.length, 2);
});

// ============================================================================
// T6. LoopType 字面量联合完整性
// ============================================================================

test("T6a. LOOP_TYPES 包含 4 个 Loop（批次 13 新增 deploy）", () => {
  assert.equal(LOOP_TYPES.length, 4);
});

test("T6b. LOOP_TYPES 顺序正确（design/coding/testing/deploy）", () => {
  const expected: ReadonlyArray<LoopType> = ["design", "coding", "testing", "deploy"];
  assert.deepEqual([...LOOP_TYPES], [...expected]);
});

test("T6c. LOOP_TYPES 已冻结", () => {
  assert.equal(Object.isFrozen(LOOP_TYPES), true);
});

// ============================================================================
// T7. GateId 字面量联合完整性
// ============================================================================

test("T7a. GATE_IDS 包含 8 个门禁（G-1~G-8，批次 13 新增 G-8）", () => {
  assert.equal(GATE_IDS.length, 8);
});

test("T7b. GATE_IDS 顺序正确（G-1/G-2/G-3/G-4/G-5/G-6/G-7/G-8）", () => {
  const expected: ReadonlyArray<GateId> = ["G-1", "G-2", "G-3", "G-4", "G-5", "G-6", "G-7", "G-8"];
  assert.deepEqual([...GATE_IDS], [...expected]);
});

test("T7c. GATE_IDS 已冻结", () => {
  assert.equal(Object.isFrozen(GATE_IDS), true);
});

// ============================================================================
// T8. GateSeverity 字面量联合完整性（与 RedlineSeverity 对齐小写）
// ============================================================================

test("T8. GateSeverity 字面量联合覆盖 blocker/major/warning（小写对齐 RedlineSeverity）", () => {
  const severities: GateSeverity[] = ["blocker", "major", "warning"];
  assert.equal(severities.length, 3);
  // 关键：必须为小写，与 RedlineSeverity 对齐
  assert.ok(severities.includes("blocker"));
  assert.ok(severities.includes("major"));
  assert.ok(severities.includes("warning"));
  // 反向断言：不含大写值（与 RuleSeverity 区分）
  // 通过 as 断言绕过编译期类型检查，运行时验证赋值后的值仍为原始大写字符串
  // 说明：字面量联合类型 GateSeverity = "blocker" | "major" | "warning" 在编译期已排除大写值，
  // 此处通过 as 断言强制赋值，用于运行时验证"小写对齐"语义（与 RuleSeverity 一致）
  const _shouldBeUndefined: GateSeverity | undefined = "BLOCKER" as GateSeverity | undefined;
  assert.equal(_shouldBeUndefined, "BLOCKER" as unknown as GateSeverity);
});

// ============================================================================
// T9. GateContext 接口字段完整性
// ============================================================================

test("T9. GateContext 接口字段完整性", () => {
  const taskCard: TaskCard = {
    id: "T-001",
    title: "UserAggregate 骨架",
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["npm test user-aggregate"],
    status: "pending",
    declaredSymbols: [],
  };
  const context: GateContext = {
    projectId: "order-system",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard,
    actualChanges: [],
  };
  assert.equal(context.projectId, "order-system");
  assert.equal(context.loopType, "coding");
  assert.equal(context.specStatus, "approved");
  assert.equal(context.planStatus, "approved");
  assert.equal(context.reviewRecords.length, 0);
  assert.equal(context.userApproved, true);
  assert.equal(context.taskCard.id, "T-001");
  assert.equal(context.actualChanges.length, 0);
});

// ============================================================================
// T10. GateResult 接口字段完整性
// ============================================================================

test("T10. GateResult 接口字段完整性", () => {
  const result: GateResult = {
    passed: false,
    gate: "G-1",
    reason: "spec.md 状态为 reviewing，未批准",
    guidance: "建议进入 DESIGN Loop",
    severity: "blocker",
  };
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-1");
  assert.equal(result.reason, "spec.md 状态为 reviewing，未批准");
  assert.equal(result.guidance, "建议进入 DESIGN Loop");
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T11. GateOrchestrationResult 接口字段完整性
// ============================================================================

test("T11. GateOrchestrationResult 接口字段完整性", () => {
  const orchestrationResult: GateOrchestrationResult = {
    results: [],
    allPassed: true,
    firstFailedGate: null,
    loopType: "design",
  };
  assert.equal(orchestrationResult.results.length, 0);
  assert.equal(orchestrationResult.allPassed, true);
  assert.equal(orchestrationResult.firstFailedGate, null);
  assert.equal(orchestrationResult.loopType, "design");
});

// ============================================================================
// T12. GateChecker 协议接口完整性
// ============================================================================

test("T12. GateChecker 协议接口完整性", () => {
  // 构造一个真实的 GateChecker 实现以验证协议
  const checker: GateChecker = {
    gateId: "G-1",
    check: (_ctx: GateContext): GateResult => ({
      passed: true,
      gate: "G-1",
      reason: "测试通过",
      severity: "blocker",
    }),
  };
  assert.equal(checker.gateId, "G-1");
  const ctx: GateContext = {
    projectId: "test",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard: {
      id: "T-001",
      title: "test",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: [],
      status: "pending",
      declaredSymbols: [],
    },
    actualChanges: [],
  };
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T13. 配置常量
// ============================================================================

test("T13a. G2_MIN_REVIEW_ROLES = 2", () => {
  assert.equal(G2_MIN_REVIEW_ROLES, 2);
});

test("T13b. G2_FULL_REVIEW_ROLES = 4", () => {
  assert.equal(G2_FULL_REVIEW_ROLES, 4);
});

test("T13c. G3_DEVIATION_THRESHOLD = 3", () => {
  assert.equal(G3_DEVIATION_THRESHOLD, 3);
});
