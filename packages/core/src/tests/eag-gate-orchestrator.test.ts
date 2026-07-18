/**
 * EAG-P2 批次 8 单元测试：方案先行门禁编排器
 *
 * 测试范围：
 * - T1. GateOrchestrator 实例化
 *   - T1a. 默认检查器列表含 3 个检查器（G-1/G-2/G-3）
 *   - T1b. 自定义检查器列表注入
 * - T2. design Loop → 跳过所有门禁
 * - T3. testing Loop → 跳过所有门禁
 * - T4. coding Loop 全部通过 → allPassed=true
 * - T5. coding Loop G-1 失败 → 短路（不执行 G-2/G-3）
 * - T6. coding Loop G-2 失败 → 短路（不执行 G-3）
 * - T7. coding Loop G-3 失败 → results 含 3 条
 * - T8. 非法 loopType → 抛 GateOrchestratorError
 * - T9. 检查器协议违反（gateId 不合法）→ 抛 GateOrchestratorError
 * - T10. firstFailedGate 正确设置
 * - T11. 结果对象已冻结
 * - T12. getCheckers 返回注入的检查器列表
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实检查器（GateG1Checker/GateG2Checker/GateG3Checker）
 *
 * @module core/tests/eag-gate-orchestrator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateOrchestrator } from "../eag/gate/gate-orchestrator";
import { GateOrchestratorError } from "../eag/gate/gate-orchestrator";
import { GateG1Checker } from "../eag/gate/gate-g1-checker";
import { GateG2Checker } from "../eag/gate/gate-g2-checker";
import { GateG3Checker } from "../eag/gate/gate-g3-checker";
import type { FileChange, GateChecker, GateContext, GateId, GateResult, ReviewRecord } from "../eag/gate/gate-types";

// ============================================================================
// 辅助函数：构造 ReviewRecord / FileChange / GateContext
// ============================================================================

/**
 * 构造测试用 ReviewRecord
 *
 * @param role 评审角色
 * @param verdict 评审结论
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
 * 构造测试用 GateContext
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
// T1. GateOrchestrator 实例化
// ============================================================================

test("T1a. 默认检查器列表含 3 个检查器（G-1/G-2/G-3）", () => {
  const orchestrator = new GateOrchestrator();
  const checkers = orchestrator.getCheckers();
  assert.equal(checkers.length, 3);
  assert.equal(checkers[0].gateId, "G-1");
  assert.equal(checkers[1].gateId, "G-2");
  assert.equal(checkers[2].gateId, "G-3");
});

test("T1b. 自定义检查器列表注入", () => {
  const customCheckers: GateChecker[] = [new GateG1Checker(), new GateG2Checker(), new GateG3Checker()];
  const orchestrator = new GateOrchestrator({ checkers: customCheckers });
  assert.equal(orchestrator.getCheckers().length, 3);
});

// ============================================================================
// T2. design Loop → 跳过所有门禁
// ============================================================================

test("T2. design Loop → 跳过所有门禁（results 为空，allPassed=true）", () => {
  const orchestrator = new GateOrchestrator();
  // 即使 spec/plan 未批准，design Loop 也跳过门禁
  const ctx = createContext({
    loopType: "design",
    specStatus: "draft",
    planStatus: "draft",
  });
  const result = orchestrator.run(ctx);
  assert.equal(result.results.length, 0);
  assert.equal(result.allPassed, true);
  assert.equal(result.firstFailedGate, null);
  assert.equal(result.loopType, "design");
});

// ============================================================================
// T3. testing Loop → 跳过所有门禁
// ============================================================================

test("T3. testing Loop → 跳过所有门禁", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext({
    loopType: "testing",
    specStatus: "draft",
    planStatus: "draft",
  });
  const result = orchestrator.run(ctx);
  assert.equal(result.results.length, 0);
  assert.equal(result.allPassed, true);
  assert.equal(result.loopType, "testing");
});

// ============================================================================
// T4. coding Loop 全部通过 → allPassed=true
// ============================================================================

test("T4. coding Loop 全部通过 → allPassed=true，firstFailedGate=null", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext();
  const result = orchestrator.run(ctx);
  assert.equal(result.allPassed, true);
  assert.equal(result.firstFailedGate, null);
  assert.equal(result.results.length, 3);
  assert.equal(result.loopType, "coding");
});

// ============================================================================
// T5. coding Loop G-1 失败 → 短路（不执行 G-2/G-3）
// ============================================================================

test("T5. coding Loop G-1 失败 → 短路（results 仅含 1 条）", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext({
    specStatus: "draft", // G-1 失败
    planStatus: "draft",
  });
  const result = orchestrator.run(ctx);
  assert.equal(result.allPassed, false);
  assert.equal(result.firstFailedGate, "G-1");
  assert.equal(result.results.length, 1); // 短路，仅 G-1 执行
  assert.equal(result.results[0].gate, "G-1");
  assert.equal(result.results[0].passed, false);
});

// ============================================================================
// T6. coding Loop G-2 失败 → 短路（不执行 G-3）
// ============================================================================

test("T6. coding Loop G-2 失败 → 短路（results 含 2 条）", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext({
    specStatus: "approved",
    planStatus: "approved",
    userApproved: false, // G-2 失败（用户未批准）
  });
  const result = orchestrator.run(ctx);
  assert.equal(result.allPassed, false);
  assert.equal(result.firstFailedGate, "G-2");
  assert.equal(result.results.length, 2); // G-1 通过 + G-2 失败
  assert.equal(result.results[0].gate, "G-1");
  assert.equal(result.results[0].passed, true);
  assert.equal(result.results[1].gate, "G-2");
  assert.equal(result.results[1].passed, false);
});

// ============================================================================
// T7. coding Loop G-3 失败 → results 含 3 条
// ============================================================================

test("T7. coding Loop G-3 失败 → results 含 3 条", () => {
  const orchestrator = new GateOrchestrator();
  // 构造 3 个偏离符号触发 G-3 失败
  const actualChanges: FileChange[] = [
    {
      type: "modified",
      filePath: "src/services/UserService.ts",
      declaredSymbolIds: [],
      actualSymbolIds: [
        "src/services/UserService.ts:UserService.login",
        "src/services/UserService.ts:UserService.logout",
        "src/services/UserService.ts:UserService.register",
      ],
    },
  ];
  const ctx = createContext({ actualChanges });
  const result = orchestrator.run(ctx);
  assert.equal(result.allPassed, false);
  assert.equal(result.firstFailedGate, "G-3");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[2].gate, "G-3");
  assert.equal(result.results[2].passed, false);
});

// ============================================================================
// T8. 非法 loopType → 抛 GateOrchestratorError
// ============================================================================

test("T8. 非法 loopType → 抛 GateOrchestratorError", () => {
  const orchestrator = new GateOrchestrator();
  // 构造非法 loopType（绕过 TS 类型检查）
  const ctx = createContext({ loopType: "invalid" as unknown as GateContext["loopType"] });
  assert.throws(
    () => orchestrator.run(ctx),
    (err: unknown) => {
      assert.ok(err instanceof GateOrchestratorError);
      assert.equal((err as GateOrchestratorError).kind, "invalid-loop-type");
      return true;
    }
  );
});

// ============================================================================
// T9. 检查器协议违反（gateId 不合法）→ 抛 GateOrchestratorError
// ============================================================================

test("T9. 检查器协议违反（gateId 不在 G-1/G-2/G-3）→ 构造时抛 GateOrchestratorError", () => {
  // 构造协议违反的检查器（gateId="G-99" 不合法）
  const invalidChecker: GateChecker = {
    gateId: "G-99" as GateId,
    check: (_ctx: GateContext): GateResult => ({
      passed: true,
      gate: "G-99" as GateId,
      reason: "非法检查器",
      severity: "blocker",
    }),
  };
  // 协议校验已移至 constructor（M-8 优化）：构造时一次性校验所有 checkers
  // 因此错误应在 new GateOrchestrator(...) 时抛出，而非在 run() 时
  assert.throws(
    () => new GateOrchestrator({ checkers: [invalidChecker] }),
    (err: unknown) => {
      assert.ok(err instanceof GateOrchestratorError);
      assert.equal((err as GateOrchestratorError).kind, "checker-protocol-violation");
      return true;
    }
  );
});

// ============================================================================
// T10. firstFailedGate 正确设置
// ============================================================================

test("T10. firstFailedGate 在 G-1 失败时为 G-1", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext({ specStatus: "draft" });
  const result = orchestrator.run(ctx);
  assert.equal(result.firstFailedGate, "G-1");
});

test("T10b. firstFailedGate 在全部通过时为 null", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext();
  const result = orchestrator.run(ctx);
  assert.equal(result.firstFailedGate, null);
});

// ============================================================================
// T11. 结果对象已冻结
// ============================================================================

test("T11. 结果对象已冻结", () => {
  const orchestrator = new GateOrchestrator();
  const ctx = createContext();
  const result = orchestrator.run(ctx);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.results), true);
});

// ============================================================================
// T12. getCheckers 返回注入的检查器列表
// ============================================================================

test("T12. getCheckers 返回注入的检查器列表", () => {
  const checkers: GateChecker[] = [new GateG1Checker(), new GateG2Checker(), new GateG3Checker()];
  const orchestrator = new GateOrchestrator({ checkers });
  const retrieved = orchestrator.getCheckers();
  assert.equal(retrieved.length, 3);
  assert.equal(retrieved[0].gateId, "G-1");
  assert.equal(retrieved[1].gateId, "G-2");
  assert.equal(retrieved[2].gateId, "G-3");
});
