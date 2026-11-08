/**
 * EAG-P2 批次 8 单元测试：方案先行门禁编排器
 *
 * 测试范围：
 * - T1. GateOrchestrator 实例化
 *   - T1a. 默认检查器列表含 5 个检查器（G-1/G-2/G-3/G-6/G-7，批次 10 新增 G-6/G-7）
 *   - T1b. 自定义检查器列表注入
 * - T2. design Loop → 跳过所有门禁
 * - T3. testing Loop + 普通 GateContext → 向后兼容跳过 G-6/G-7（批次 10 新增）
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
 * - 禁止 mock，使用真实检查器（GateG1Checker/GateG2Checker/GateG3Checker/GateG6Checker/GateG7Checker）
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

test("T1a. 默认检查器列表含 5 个检查器（G-1/G-2/G-3/G-6/G-7）", () => {
  const orchestrator = new GateOrchestrator();
  const checkers = orchestrator.getCheckers();
  assert.equal(checkers.length, 5);
  assert.equal(checkers[0].gateId, "G-1");
  assert.equal(checkers[1].gateId, "G-2");
  assert.equal(checkers[2].gateId, "G-3");
  assert.equal(checkers[3].gateId, "G-6");
  assert.equal(checkers[4].gateId, "G-7");
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
// T3. testing Loop + 普通 GateContext → 向后兼容跳过 G-6/G-7
// ============================================================================

test("T3. testing Loop + 普通 GateContext → G-6/G-7 skipped 且默认 fail-closed（results 为空）", () => {
  // 2026-11-08 EAG 全量审查修复：旧「静默跳过 G-6/G-7 却报 allPassed=true」被判定为
  // 误报全绿。默认严格覆盖下，任何 skippedGates 都使 allPassed=false；
  // 显式 strictGateCoverage:false（或 EAG_LEGACY_PASS_THROUGH=1）可回退到旧宽松语义。
  const orchestrator = new GateOrchestrator();
  // 传入普通 GateContext（非 GateG6Context/GateG7Context），G-6/G-7 记为 missing-context
  const ctx = createContext({
    loopType: "testing",
    specStatus: "draft",
    planStatus: "draft",
  });
  const result = orchestrator.run(ctx);
  assert.equal(result.results.length, 0, "G-6/G-7 均跳过 → 无实际执行结果");
  assert.equal(result.allPassed, false, "默认 fail-closed：有 skipped 门禁不得报全绿");
  assert.equal(result.firstFailedGate, "G-6", "首个跳过门禁应被披露为 firstFailedGate");
  assert.equal(result.loopType, "testing");

  // A/B 回退对照：显式确认宽松覆盖后恢复修复前语义
  const lenient = new GateOrchestrator({ strictGateCoverage: false }).run(ctx);
  assert.equal(lenient.allPassed, true, "显式宽松覆盖必须能回退到旧语义");
  assert.equal(lenient.firstFailedGate, null);
});

// ============================================================================
// T4. coding Loop 全部通过 → allPassed=true
// ============================================================================

test("T4. coding Loop 默认缺 G-4/G-5 检查器 → allPassed=false，firstFailedGate=G-4", () => {
  // 2026-11-08 EAG 全量审查修复：默认 checkers 仅 G-1/2/3/6/7，coding 要求 G-1..G-5。
  // 旧语义「缺 G-4/G-5 却报 allPassed=true」属误报全绿，默认改 fail-closed。
  // 本用例同时用显式宽松覆盖做 A/B 对照，证明真实执行的 G-1/G-2/G-3 仍全部通过。
  const orchestrator = new GateOrchestrator();
  const ctx = createContext();
  const result = orchestrator.run(ctx);
  assert.equal(result.results.length, 3, "G-1/G-2/G-3 真实执行且通过");
  assert.ok(
    result.results.every((r) => r.passed),
    "三条真实执行的门禁必须全通过"
  );
  assert.equal(result.allPassed, false, "缺 G-4/G-5 检查器时不得报全绿");
  assert.equal(result.firstFailedGate, "G-4", "firstFailedGate 应指向首个缺失门禁");
  assert.equal(result.loopType, "coding");

  // A/B 回退对照：显式确认宽松覆盖 → 恢复修复前 allPassed=true / firstFailedGate=null
  const lenient = new GateOrchestrator({ strictGateCoverage: false }).run(ctx);
  assert.equal(lenient.allPassed, true);
  assert.equal(lenient.firstFailedGate, null);
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

test("T9. 检查器协议违反（gateId 不在 G-1~G-7）→ 构造时抛 GateOrchestratorError", () => {
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

test("T10b. firstFailedGate 在真实门禁全通过但缺检查器时为 G-4（默认 fail-closed）", () => {
  // 2026-11-08 审查修复：默认严格覆盖把「缺检查器」也计入未通过。
  // 显式宽松覆盖时 firstFailedGate 仍为 null（回退语义 A/B 对照）。
  const orchestrator = new GateOrchestrator();
  const ctx = createContext();
  const result = orchestrator.run(ctx);
  assert.equal(result.firstFailedGate, "G-4");

  const lenient = new GateOrchestrator({ strictGateCoverage: false }).run(ctx);
  assert.equal(lenient.firstFailedGate, null, "显式宽松覆盖下应恢复 null");
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

// ============================================================================
// T13. skippedGates 披露缺检查器的门禁（2026-11-01：修复"静默跳过却报全绿"）
// ============================================================================

test("T13. coding Loop 缺 G-4/G-5 检查器时 skippedGates 显式披露且默认判未通过", () => {
  // 2026-11-08 审查修复：旧注释「默认（非严格）不改变既有 allPassed 语义」已废止，
  // 默认改为严格覆盖（fail-closed）；显式 strictGateCoverage:false 仍可回退到宽松语义。
  const orchestrator = new GateOrchestrator();
  const result = orchestrator.run(createContext());

  const skipped = result.skippedGates ?? [];
  const noChecker = skipped.filter((s) => s.reason === "no-checker").map((s) => s.gate);
  assert.deepEqual(noChecker.sort(), ["G-4", "G-5"], "coding 要求执行 G-1..G-5，缺检查器的应被披露");
  assert.equal(result.allPassed, false, "默认严格模式下缺检查器必须判未通过");
  assert.equal(result.firstFailedGate, "G-4");

  // A/B 回退对照
  const lenient = new GateOrchestrator({ strictGateCoverage: false }).run(createContext());
  assert.equal(lenient.allPassed, true, "显式宽松覆盖必须能回退到旧语义");
});

test("T14. strictGateCoverage=true 时缺检查器计入未通过（fail-closed）", () => {
  const orchestrator = new GateOrchestrator({ strictGateCoverage: true });
  const result = orchestrator.run(createContext());

  assert.equal(result.allPassed, false, "严格模式下缺检查器必须判未通过");
  assert.equal(result.firstFailedGate, "G-4", "未通过门禁应指向首个缺失的 G-4");
});

test("T15. testing Loop + 普通 GateContext → G-6/G-7 记为 missing-context（默认亦计入未通过）", () => {
  // 2026-11-08 审查修复：默认严格覆盖下 missing-context 同样使 allPassed=false，
  // 本用例只验证 skippedGates 的披露内容与结果条数；allPassed 契约见 T3。
  const orchestrator = new GateOrchestrator();
  const result = orchestrator.run(createContext({ loopType: "testing" }));

  const skipped = result.skippedGates ?? [];
  const missingContext = skipped.filter((s) => s.reason === "missing-context").map((s) => s.gate);
  assert.deepEqual(missingContext.sort(), ["G-6", "G-7"], "向后兼容跳过应被披露为 missing-context");
  assert.equal(result.results.length, 0, "G-6/G-7 均跳过 → 无实际执行结果");
  assert.equal(result.allPassed, false, "默认 fail-closed：missing-context 同样计入未通过");
});

test("T16. design Loop 跳过门禁时 skippedGates 为空数组", () => {
  const orchestrator = new GateOrchestrator();
  const result = orchestrator.run(createContext({ loopType: "design" }));
  assert.equal(result.allPassed, true);
  assert.deepEqual(result.skippedGates, []);
});
