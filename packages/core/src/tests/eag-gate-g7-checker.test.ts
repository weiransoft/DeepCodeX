/**
 * EAG-P3 批次 10 单元测试：G-7 TESTING Loop 退出门禁检查器
 *
 * 测试范围：
 * - T1. coverageReport.passed=false → passed=false
 * - T2. contractTests=[] → passed=false
 * - T3. contractTests 非空但 contractTestResults 含 exitCode!=0 → passed=false
 * - T4. e2eTests=[] → passed=false
 * - T5. e2eTests 非空但 e2eTestResults 含 exitCode!=0 → passed=false
 * - T6. compliancePackIds 非空但 complianceEvidence=undefined → passed=false
 * - T7. prDescription="" → passed=false
 * - T8. prDescription 缺少"变更摘要"段 → passed=false
 * - T9. prDescription 缺少"需求映射"段 → passed=false
 * - T10. prDescription 缺少"测试报告"段 → passed=false
 * - T11. prDescription 缺少"合规证据"段 → passed=false
 * - T12. 全部通过（无 ICP）→ passed=true
 * - T13. 全部通过（含 ICP + 合规证据）→ passed=true
 * - T14. gateId 为 "G-7"
 * - T15. 返回结果已冻结
 * - T16. 实现 GateChecker 协议
 * - T17. contractTestResults 为空数组（contractTests 非空）→ passed=false
 * - T18. e2eTestResults 为空数组（e2eTests 非空）→ passed=false
 * - T19. PR 描述四段结构完整（英文版）→ passed=true
 * - T20. 失败时 guidance 非空
 * - T21. 多重失败一次性收集

 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（GateG7Context / CoverageReport / GeneratedTestFile / TestExecutionResult）
 *
 * @module core/tests/eag-gate-g7-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import type {
  GateChecker,
  GateContext,
  GateG7Context,
  GateResult,
  TestExecutionResult,
  DocumentState,
  CoverageReport,
  GeneratedTestFile,
} from "../eag/gate/gate-types";
import type { TaskCard } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造 TaskCard
// ============================================================================

/**
 * 构造测试用 TaskCard（默认 status=completed）
 */
function createTaskCard(id: string): TaskCard {
  return {
    id,
    title: `任务 ${id}`,
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["npm test"],
    status: "completed",
    declaredSymbols: [`src/file.ts:${id}.method`],
  };
}

// ============================================================================
// 辅助函数：构造 CoverageReport
// ============================================================================

/**
 * 构造测试用 CoverageReport（默认 passed=true，全维度达标）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 CoverageReport
 */
function createCoverageReport(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    lines: 85,
    branches: 75,
    functions: 90,
    highRiskSymbols: 100,
    uncoveredHighRiskSymbols: [],
    uncoveredFiles: [],
    passed: true,
    failedDimensions: [],
    rawReport: {},
    ...overrides,
  };
}

// ============================================================================
// 辅助函数：构造 GeneratedTestFile
// ============================================================================

/**
 * 构造测试用契约测试文件
 *
 * @param relativePath 文件相对路径
 * @returns 完整的 GeneratedTestFile（kind="contract"）
 */
function createContractTestFile(relativePath: string): GeneratedTestFile {
  return {
    relativePath,
    content: "import { test } from 'node:test'; test('contract', () => {});",
    kind: "contract",
    requirementId: "F-001",
    sourceId: "/api/v1/orders/{orderId}",
    testCaseCount: 3,
    testCaseDescriptions: ["should return 200", "should return 404", "should return 400"],
  };
}

/**
 * 构造测试用 E2E 测试文件
 *
 * @param relativePath 文件相对路径
 * @returns 完整的 GeneratedTestFile（kind="e2e"）
 */
function createE2eTestFile(relativePath: string): GeneratedTestFile {
  return {
    relativePath,
    content: "import { test } from 'node:test'; test('e2e', () => {});",
    kind: "e2e",
    requirementId: "F-001",
    sourceId: "flow-order-create-pay-query",
    testCaseCount: 2,
    testCaseDescriptions: ["should complete order flow", "should handle payment failure"],
  };
}

// ============================================================================
// 辅助函数：构造 TestExecutionResult
// ============================================================================

/**
 * 构造测试用的测试执行结果（默认 exitCode=0 通过）
 *
 * @param filePath 文件路径
 * @param passed 是否通过（默认 true）
 * @returns 完整的 TestExecutionResult
 */
function createTestExecutionResult(filePath: string, passed: boolean = true): TestExecutionResult {
  return {
    filePath,
    exitCode: passed ? 0 : 1,
    durationMs: 1000,
    failedCount: passed ? 0 : 1,
    passedCount: passed ? 3 : 2,
  };
}

// ============================================================================
// 辅助函数：构造 PR 描述（含四段结构）
// ============================================================================

/**
 * 构造测试用的 PR 描述（默认含完整四段结构，中文版）
 *
 * 四段结构：
 * 1. 变更摘要（## 变更摘要）
 * 2. 需求映射（## 需求映射）
 * 3. 测试报告（## 测试报告）
 * 4. 合规证据（## 合规证据）
 *
 * @param omitSection 要省略的段名（可选，如 "变更摘要" / "需求映射" / "测试报告" / "合规证据"）
 * @returns 完整或部分截断的 PR 描述字符串
 */
function createPrDescription(omitSection?: string): string {
  const sections: string[] = [];
  if (omitSection !== "变更摘要") {
    sections.push("## 变更摘要", "本次变更实现订单系统 TESTING Loop 退出。", "");
  }
  if (omitSection !== "需求映射") {
    sections.push("## 需求映射", "- F-001 → OrderService", "- F-002 → PaymentService", "");
  }
  if (omitSection !== "测试报告") {
    sections.push("## 测试报告", "- 契约测试：5 个全过", "- E2E 测试：2 个全过", "- 覆盖率：行 85% / 分支 75%", "");
  }
  if (omitSection !== "合规证据") {
    sections.push("## 合规证据", "- 合规证据报告：见 compliance-evidence.json", "");
  }
  return sections.join("\n");
}

/**
 * 构造测试用的 PR 描述（英文版四段结构）
 *
 * @returns 含英文四段结构的 PR 描述
 */
function createEnglishPrDescription(): string {
  return [
    "## Change Summary",
    "Implement TESTING Loop exit for order system.",
    "",
    "## Requirement Mapping",
    "- F-001 → OrderService",
    "- F-002 → PaymentService",
    "",
    "## Test Report",
    "- Contract tests: 5 passed",
    "- E2E tests: 2 passed",
    "",
    "## Compliance Evidence",
    "- Compliance evidence: see compliance-evidence.json",
    "",
  ].join("\n");
}

/**
 * 构造测试用的 PR 描述（中文四段结构 + 合规证据段含 packId/overallPassed 摘要）
 *
 * EAG-P3 批次 11 §9.2.3 要求启用 ICP 时 PR 描述 "## 合规证据" 段必须含
 * packId 与 overallPassed 摘要。本辅助函数构造符合该要求的 PR 描述。
 *
 * @param packId 合规包 ID（如 "GMP"）
 * @param overallPassed 整体通过状态（"true" / "false"）
 * @returns 含合规证据摘要的 PR 描述
 */
function createPrDescriptionWithComplianceSummary(packId: string, overallPassed: string): string {
  return [
    "## 变更摘要",
    "本次变更实现订单系统 TESTING Loop 退出。",
    "",
    "## 需求映射",
    "- F-001 → OrderService",
    "- F-002 → PaymentService",
    "",
    "## 测试报告",
    "- 契约测试：5 个全过",
    "- E2E 测试：2 个全过",
    "- 覆盖率：行 85% / 分支 75%",
    "",
    "## 合规证据",
    `- packId: ${packId}`,
    `- overallPassed: ${overallPassed}`,
    "- 合规证据报告：见 compliance-evidence.json",
    "",
  ].join("\n");
}

// ============================================================================
// 辅助函数：构造 GateG7Context
// ============================================================================

/**
 * 构造测试用 GateG7Context（默认全部字段合法，无 ICP）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GateG7Context
 */
function createG7Context(overrides: Partial<GateG7Context> = {}): GateG7Context {
  const baseContext: GateG7Context = {
    projectId: "test-project",
    loopType: "testing",
    specStatus: "approved" as DocumentState,
    planStatus: "approved" as DocumentState,
    reviewRecords: [],
    userApproved: true,
    taskCard: createTaskCard("T-001"),
    actualChanges: [],
    coverageReport: createCoverageReport(),
    contractTests: [createContractTestFile("tests/contract/order.contract.test.ts")],
    contractTestResults: [createTestExecutionResult("tests/contract/order.contract.test.ts", true)],
    e2eTests: [createE2eTestFile("tests/e2e/order-flow.e2e.test.ts")],
    e2eTestResults: [createTestExecutionResult("tests/e2e/order-flow.e2e.test.ts", true)],
    prDescription: createPrDescription(),
  };
  return { ...baseContext, ...overrides };
}

// ============================================================================
// T1. coverageReport.passed=false → passed=false
// ============================================================================

test("T1. coverageReport.passed=false → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    coverageReport: createCoverageReport({
      passed: false,
      failedDimensions: ["lines", "branches"],
    }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-7");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("覆盖率"));
  assert.ok(result.reason.includes("lines"));
  assert.ok(result.reason.includes("branches"));
});

// ============================================================================
// T2. contractTests=[] → passed=false
// ============================================================================

test("T2. contractTests 为空数组 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    contractTests: [],
    contractTestResults: [],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("契约测试"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T3. contractTests 非空但 contractTestResults 含 exitCode!=0 → passed=false
// ============================================================================

test("T3. contractTests 非空但 contractTestResults 含 exitCode!=0 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    contractTests: [createContractTestFile("tests/contract/order.contract.test.ts")],
    contractTestResults: [createTestExecutionResult("tests/contract/order.contract.test.ts", false)],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("契约测试"));
  assert.ok(result.reason.includes("失败"));
  assert.ok(result.reason.includes("order.contract.test.ts"));
});

// ============================================================================
// T4. e2eTests=[] → passed=false
// ============================================================================

test("T4. e2eTests 为空数组 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    e2eTests: [],
    e2eTestResults: [],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("E2E 测试"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T5. e2eTests 非空但 e2eTestResults 含 exitCode!=0 → passed=false
// ============================================================================

test("T5. e2eTests 非空但 e2eTestResults 含 exitCode!=0 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    e2eTests: [createE2eTestFile("tests/e2e/order-flow.e2e.test.ts")],
    e2eTestResults: [createTestExecutionResult("tests/e2e/order-flow.e2e.test.ts", false)],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("E2E 测试"));
  assert.ok(result.reason.includes("失败"));
  assert.ok(result.reason.includes("order-flow.e2e.test.ts"));
});

// ============================================================================
// T6. compliancePackIds 非空但 complianceEvidence=undefined → passed=false
// ============================================================================

test("T6. compliancePackIds 非空但 complianceEvidence=undefined → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    compliancePackIds: Object.freeze(["GMP", "CFR-21-Part-11"]),
    complianceEvidence: undefined,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("ICP"));
  assert.ok(result.reason.includes("complianceEvidence"));
  assert.ok(result.reason.includes("缺失"));
});

// ============================================================================
// T7. prDescription="" → passed=false
// ============================================================================

test("T7. prDescription 为空字符串 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({ prDescription: "" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("PR 描述"));
  assert.ok(result.reason.includes("未就绪"));
});

// ============================================================================
// T8. prDescription 缺少"变更摘要"段 → passed=false
// ============================================================================

test("T8. prDescription 缺少变更摘要段 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription("变更摘要"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("变更摘要"));
});

// ============================================================================
// T9. prDescription 缺少"需求映射"段 → passed=false
// ============================================================================

test("T9. prDescription 缺少需求映射段 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription("需求映射"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("需求映射"));
});

// ============================================================================
// T10. prDescription 缺少"测试报告"段 → passed=false
// ============================================================================

test("T10. prDescription 缺少测试报告段 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription("测试报告"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("测试报告"));
});

// ============================================================================
// T11. prDescription 缺少"合规证据"段 → passed=false
// ============================================================================

test("T11. prDescription 缺少合规证据段 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription("合规证据"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("合规证据"));
});

// ============================================================================
// T12. 全部通过（无 ICP）→ passed=true
// ============================================================================

test("T12. 全部通过（无 ICP）→ passed=true", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-7");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("G-7 门禁通过"));
  assert.ok(result.reason.includes("契约测试 1 个全过"));
  assert.ok(result.reason.includes("E2E 测试 1 个全过"));
});

// ============================================================================
// T13. 全部通过（含 ICP + 合规证据）→ passed=true
//
// EAG-P3 批次 11 §9.2 修正：
// - complianceEvidence 必须为 ComplianceEvidenceReport 结构（含 packId/runId/
//   generatedAt/ruleResults/overallPassed），废弃旧结构 { overallVerdict, packs }
// - PR 描述"## 合规证据"段必须含 packId 与 overallPassed 摘要
// ============================================================================

test("T13. 全部通过（含 ICP + 合规证据）→ passed=true", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    compliancePackIds: Object.freeze(["GMP", "CFR-21-Part-11"]),
    complianceEvidence: Object.freeze({
      packId: "GMP",
      runId: "run-20260719-001",
      generatedAt: "2026-07-19T10:00:00.000Z",
      ruleResults: Object.freeze([
        {
          ruleId: "GMP-01",
          passed: true,
          severity: "blocker",
          evidence: [],
          reason: "工艺验证测试 5 条全部通过",
        },
        {
          ruleId: "GMP-02",
          passed: true,
          severity: "major",
          evidence: [],
          reason: "偏差处理流程已配置",
        },
      ]),
      overallPassed: true,
      summary: "GMP 合规包 2 条规则全部通过",
    }),
    prDescription: createPrDescriptionWithComplianceSummary("GMP", "true"),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("ICP"));
  assert.ok(result.reason.includes("2 个合规包"));
});

// ============================================================================
// T14. gateId 为 "G-7"
// ============================================================================

test("T14. gateId 为 G-7", () => {
  const checker = new GateG7Checker();
  assert.equal(checker.gateId, "G-7");
});

// ============================================================================
// T15. 返回结果已冻结
// ============================================================================

test("T15. 返回结果已冻结（通过场景）", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context();
  const result = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

test("T15b. 返回结果已冻结（失败场景）", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    coverageReport: createCoverageReport({ passed: false, failedDimensions: ["lines"] }),
  });
  const result = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

// ============================================================================
// T16. 实现 GateChecker 协议
// ============================================================================

test("T16. 实现 GateChecker 协议", () => {
  const checker: GateChecker = new GateG7Checker();
  assert.equal(checker.gateId, "G-7");
  assert.equal(typeof checker.check, "function");
});

// ============================================================================
// T17. contractTestResults 为空数组（contractTests 非空）→ passed=false
// ============================================================================

test("T17. contractTestResults 为空数组（contractTests 非空）→ passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    contractTests: [createContractTestFile("tests/contract/order.contract.test.ts")],
    contractTestResults: [],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("契约测试执行结果"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T18. e2eTestResults 为空数组（e2eTests 非空）→ passed=false
// ============================================================================

test("T18. e2eTestResults 为空数组（e2eTests 非空）→ passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    e2eTests: [createE2eTestFile("tests/e2e/order-flow.e2e.test.ts")],
    e2eTestResults: [],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("E2E 测试执行结果"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T19. PR 描述四段结构完整（英文版）→ passed=true
// ============================================================================

test("T19. PR 描述四段结构完整（英文版）→ passed=true", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createEnglishPrDescription(),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("G-7 门禁通过"));
});

// ============================================================================
// T20. 失败时 guidance 非空
// ============================================================================

test("T20. 失败时 guidance 非空", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    coverageReport: createCoverageReport({ passed: false, failedDimensions: ["lines"] }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.guidance !== undefined);
  assert.ok((result.guidance ?? "").length > 0);
  assert.ok(result.guidance!.includes("G-7"));
});

// ============================================================================
// T21. 多重失败一次性收集
// ============================================================================

test("T21. 多重失败一次性收集（覆盖率+契约+E2E+PR 全部失败）", () => {
  const checker = new GateG7Checker();
  // 同时触发 4 项失败：
  // 1. coverageReport.passed=false
  // 2. contractTests=[] (空)
  // 3. e2eTests=[] (空)
  // 4. prDescription="" (空)
  const ctx = createG7Context({
    coverageReport: createCoverageReport({ passed: false, failedDimensions: ["lines"] }),
    contractTests: [],
    contractTestResults: [],
    e2eTests: [],
    e2eTestResults: [],
    prDescription: "",
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // reason 中应包含全部 4 项失败提示
  assert.ok(result.reason.includes("覆盖率"), `应包含覆盖率失败提示，实际：${result.reason}`);
  assert.ok(result.reason.includes("契约测试"), `应包含契约测试失败提示，实际：${result.reason}`);
  assert.ok(result.reason.includes("E2E 测试"), `应包含 E2E 测试失败提示，实际：${result.reason}`);
  assert.ok(result.reason.includes("PR 描述"), `应包含 PR 描述失败提示，实际：${result.reason}`);
  // 应明确提示失败项数量
  assert.ok(result.reason.includes("4 项失败"), `应提示共 4 项失败，实际：${result.reason}`);
});

// ============================================================================
// T22. 兼容 GateContext 协议（check 接受 GateContext 类型）
// ============================================================================

test("T22. check 方法接受 GateContext 类型参数（兼容性）", () => {
  const checker = new GateG7Checker();
  // GateG7Context extends GateContext，因此可以传入 GateContext 类型的引用
  const ctx: GateContext = createG7Context();
  const result: GateResult = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-7");
});

// ============================================================================
// T23. compliancePackIds 为空数组（未启用 ICP）→ 不要求 complianceEvidence
// ============================================================================

test("T23. compliancePackIds 为空数组（未启用 ICP）→ 不要求 complianceEvidence", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    compliancePackIds: Object.freeze([]),
    complianceEvidence: undefined,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T24. 多个契约测试文件部分失败 → passed=false
// ============================================================================

test("T24. 多个契约测试文件部分失败 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    contractTests: [
      createContractTestFile("tests/contract/order.contract.test.ts"),
      createContractTestFile("tests/contract/payment.contract.test.ts"),
      createContractTestFile("tests/contract/user.contract.test.ts"),
    ],
    contractTestResults: [
      createTestExecutionResult("tests/contract/order.contract.test.ts", true),
      createTestExecutionResult("tests/contract/payment.contract.test.ts", false),
      createTestExecutionResult("tests/contract/user.contract.test.ts", true),
    ],
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("1 个失败文件"));
  assert.ok(result.reason.includes("payment.contract.test.ts"));
});
