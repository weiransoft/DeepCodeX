/**
 * EAG-P2 批次 8 单元测试：G-3 门禁检查器
 *
 * 测试范围：
 * - T1. GateG3Checker 实例化与 gateId
 * - T2. 无变更 → 通过
 * - T3. 完全声明（actualSymbolIds ⊆ declaredSymbolIds）→ 通过
 * - T4. 偏离 < 阈值（1~2 个）→ 通过（warning）
 * - T5. 偏离 ≥ 阈值（3 个）→ 失败（blocker）
 * - T6. 偏离 ≥ 阈值（5 个，跨文件累计）→ 失败
 * - T7. 失败结果含引导消息
 * - T8. 失败结果 severity 为 blocker
 * - T9. 失败结果含偏离详情
 * - T10. 结果对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-gate-g3-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG3Checker } from "../eag/gate/gate-g3-checker";
import type { FileChange, GateChecker, GateContext, GateResult } from "../eag/gate/gate-types";

// ============================================================================
// 辅助函数：构造 FileChange
// ============================================================================

/**
 * 构造测试用 FileChange
 *
 * @param filePath 文件路径
 * @param declaredSymbolIds 声明符号 ID 列表
 * @param actualSymbolIds 实际符号 ID 列表
 * @returns 文件变更记录
 */
function createFileChange(filePath: string, declaredSymbolIds: string[], actualSymbolIds: string[]): FileChange {
  return {
    type: "modified",
    filePath,
    declaredSymbolIds,
    actualSymbolIds,
  };
}

/**
 * 构造测试用 GateContext（默认无变更）
 *
 * @param actualChanges 实际变更列表
 * @returns 完整的 GateContext
 */
function createContext(actualChanges: FileChange[] = []): GateContext {
  return {
    projectId: "test-project",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
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
    actualChanges,
  };
}

// ============================================================================
// T1. GateG3Checker 实例化与 gateId
// ============================================================================

test("T1. GateG3Checker 实例化与 gateId 为 G-3", () => {
  const checker = new GateG3Checker();
  assert.ok(checker instanceof GateG3Checker);
  assert.equal(checker.gateId, "G-3");
  // 验证实现 GateChecker 协议
  const asChecker: GateChecker = checker;
  assert.equal(typeof asChecker.check, "function");
});

// ============================================================================
// T2. 无变更 → 通过
// ============================================================================

test("T2. 无变更（actualChanges=[]）→ 通过", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([]);
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("无实际变更"));
});

// ============================================================================
// T3. 完全声明（actualSymbolIds ⊆ declaredSymbolIds）→ 通过
// ============================================================================

test("T3. 完全声明 → 通过（无偏离）", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      ["src/services/UserService.ts:UserService.login", "src/services/UserService.ts:UserService.logout"],
      ["src/services/UserService.ts:UserService.login", "src/services/UserService.ts:UserService.logout"]
    ),
  ]);
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("完全一致"));
});

// ============================================================================
// T4. 偏离 < 阈值（1~2 个）→ 通过（warning）
// ============================================================================

test("T4a. 偏离 1 个 → 通过（warning）", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      ["src/services/UserService.ts:UserService.login"],
      [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout", // 未声明
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "warning");
});

test("T4b. 偏离 2 个 → 通过（warning）", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      ["src/services/UserService.ts:UserService.login"],
      [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout",
        "src/services/UserService.ts:UserService.register",
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "warning");
});

// ============================================================================
// T5. 偏离 ≥ 阈值（3 个）→ 失败（blocker）
// ============================================================================

test("T5. 偏离 3 个 → 失败（blocker）", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      ["src/services/UserService.ts:UserService.login"],
      [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout", // 偏离 1
        "src/services/UserService.ts:UserService.register", // 偏离 2
        "src/services/UserService.ts:UserService.resetPassword", // 偏离 3
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("3"));
  assert.ok(result.reason.includes("HUMAN_CHECKPOINT"));
});

// ============================================================================
// T6. 偏离 ≥ 阈值（5 个，跨文件累计）→ 失败
// ============================================================================

test("T6. 偏离 5 个（跨 2 文件累计）→ 失败", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      [],
      [
        "src/services/UserService.ts:UserService.login", // 偏离 1
        "src/services/UserService.ts:UserService.logout", // 偏离 2
        "src/services/UserService.ts:UserService.register", // 偏离 3
      ]
    ),
    createFileChange(
      "src/services/OrderService.ts",
      [],
      [
        "src/services/OrderService.ts:OrderService.create", // 偏离 4
        "src/services/OrderService.ts:OrderService.cancel", // 偏离 5
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("5"));
});

// ============================================================================
// T7. 失败结果含引导消息
// ============================================================================

test("T7. 失败结果含引导消息（建议更新 plan.md 与 tasks.md）", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      [],
      [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout",
        "src/services/UserService.ts:UserService.register",
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.ok(result.guidance !== undefined);
  assert.ok(result.guidance!.includes("plan.md"));
  assert.ok(result.guidance!.includes("tasks.md"));
});

// ============================================================================
// T8. 失败结果 severity 为 blocker
// ============================================================================

test("T8. 失败结果 severity 为 blocker", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      [],
      [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout",
        "src/services/UserService.ts:UserService.register",
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T9. 失败结果含偏离详情
// ============================================================================

test("T9. 失败结果含偏离详情（含文件路径与符号 ID）", () => {
  const checker = new GateG3Checker();
  const ctx = createContext([
    createFileChange(
      "src/services/UserService.ts",
      [],
      [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout",
        "src/services/UserService.ts:UserService.register",
      ]
    ),
  ]);
  const result = checker.check(ctx);
  assert.ok(result.reason.includes("src/services/UserService.ts"));
  assert.ok(result.reason.includes("UserService.login"));
});

// ============================================================================
// T10. 结果对象已冻结
// ============================================================================

test("T10. 结果对象已冻结", () => {
  const checker = new GateG3Checker();
  const ctx = createContext();
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});
