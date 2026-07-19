/**
 * EAG-P3 批次 11 单元测试：G-7 合规证据扩展（§9.2 G-7-Comp-1~4 + PR 描述合规证据段）
 *
 * 本测试文件专注校验 EAG-P3 批次 11 §9.2 在 GateG7Checker 上扩展的合规证据校验：
 * - G-7-Comp-1：启用 ICP 时 complianceEvidence 必填（!== undefined）
 * - G-7-Comp-2：complianceEvidence 必须为 ComplianceEvidenceReport 结构
 *   （含 packId / runId / generatedAt / ruleResults / overallPassed）
 * - G-7-Comp-4：blocker 级规则必须全部通过（架构师审查 B5-M10 修复，独立校验）
 * - G-7-Comp-3：overallPassed 必须为 true
 * - G-7-PR-Comp：启用 ICP 时 PR 描述 "## 合规证据" 段必须含 packId 与 overallPassed 摘要
 *
 * 测试范围：
 * - T1. G-7-Comp-1：启用 ICP 但 complianceEvidence=undefined → passed=false
 * - T2. G-7-Comp-2：complianceEvidence 缺 packId 字段 → passed=false
 * - T3. G-7-Comp-2：complianceEvidence 缺 runId 字段 → passed=false
 * - T4. G-7-Comp-2：complianceEvidence 缺 generatedAt 字段 → passed=false
 * - T5. G-7-Comp-2：complianceEvidence 缺 ruleResults 字段 → passed=false
 * - T6. G-7-Comp-2：complianceEvidence 缺 overallPassed 字段 → passed=false
 * - T7. G-7-Comp-2：ruleResults 不是数组 → passed=false
 * - T8. G-7-Comp-4：存在 blocker 级规则未通过 → passed=false
 * - T9. G-7-Comp-4：blocker 级全过 + major 级未过 → 仍进入 G-7-Comp-3 校验
 * - T10. G-7-Comp-3：overallPassed=false → passed=false
 * - T11. G-7-Comp-1~4 全部通过 → passed=true
 * - T12. 未启用 ICP（compliancePackIds=undefined）→ 跳过 G-7-Comp 校验
 * - T13. 未启用 ICP（compliancePackIds=[]）→ 跳过 G-7-Comp 校验
 * - T14. PR 描述缺 "## 合规证据" 段（启用 ICP）→ passed=false
 * - T15. PR 描述 "## 合规证据" 段缺 packId 摘要 → passed=false
 * - T16. PR 描述 "## 合规证据" 段缺 overallPassed 摘要 → passed=false
 * - T17. PR 描述 "## 合规证据" 段含 packId 与 overallPassed 摘要 → passed=true
 * - T18. G-7-Comp-2 多重结构错误一次性收集
 * - T19. G-7-Comp-4 多条 blocker 级规则未通过 → 错误消息列出全部 ruleId
 * - T20. G-7-Comp-1~4 + PR 描述段全部失败 → 多重失败一次性收集
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（GateG7Context / ComplianceEvidenceReport / ComplianceRuleResult）
 * - 中文详细注释
 *
 * @module core/tests/eag-gate-g7-compliance
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import type {
  GateG7Context,
  TestExecutionResult,
  DocumentState,
  CoverageReport,
  GeneratedTestFile,
} from "../eag/gate/gate-types";
import type { TaskCard } from "../eag/doc-driven/types";
import type { ComplianceEvidenceReport, ComplianceRuleResult } from "../eag/icp/types";

// ============================================================================
// 辅助函数：构造 TaskCard
// ============================================================================

/**
 * 构造测试用 TaskCard（默认 status=completed）
 *
 * @param id 任务 ID
 * @returns 完整的 TaskCard
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
 * @returns 完整的 CoverageReport（passed=true）
 */
function createCoverageReport(): CoverageReport {
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
  };
}

// ============================================================================
// 辅助函数：构造测试文件与执行结果
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

/**
 * 构造测试用的测试执行结果（默认 exitCode=0 通过）
 *
 * @param filePath 文件路径
 * @returns 完整的 TestExecutionResult
 */
function createTestExecutionResult(filePath: string): TestExecutionResult {
  return {
    filePath,
    exitCode: 0,
    durationMs: 1000,
    failedCount: 0,
    passedCount: 3,
  };
}

// ============================================================================
// 辅助函数：构造 PR 描述
// ============================================================================

/**
 * 构造测试用的 PR 描述（含四段结构，合规证据段可定制）
 *
 * 默认构造完整四段结构，"## 合规证据" 段含 packId 与 overallPassed 摘要。
 * 可通过参数控制合规证据段内容，便于测试 G-7-PR-Comp 各场景。
 *
 * @param options 合规证据段定制选项
 * @returns PR 描述字符串
 */
function createPrDescription(
  options: {
    /** 合规证据段是否省略（默认 false） */
    omitComplianceSection?: boolean;
    /** 合规证据段是否含 packId 摘要（默认 true） */
    includePackId?: boolean;
    /** 合规证据段是否含 overallPassed 摘要（默认 true） */
    includeOverallPassed?: boolean;
    /** packId 值（默认 "GMP"） */
    packId?: string;
    /** overallPassed 值（默认 "true"） */
    overallPassed?: string;
  } = {}
): string {
  const {
    omitComplianceSection = false,
    includePackId = true,
    includeOverallPassed = true,
    packId = "GMP",
    overallPassed = "true",
  } = options;

  const sections: string[] = [
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
  ];

  if (!omitComplianceSection) {
    sections.push("## 合规证据");
    if (includePackId) {
      sections.push(`- packId: ${packId}`);
    }
    if (includeOverallPassed) {
      sections.push(`- overallPassed: ${overallPassed}`);
    }
    sections.push("- 合规证据报告：见 compliance-evidence.json", "");
  }

  return sections.join("\n");
}

// ============================================================================
// 辅助函数：构造 ComplianceRuleResult
// ============================================================================

/**
 * 构造测试用的 ComplianceRuleResult
 *
 * @param ruleId 规则 ID
 * @param passed 是否通过
 * @param severity 严重性（blocker / major / warning）
 * @returns 完整的 ComplianceRuleResult
 */
function createRuleResult(
  ruleId: string,
  passed: boolean,
  severity: "blocker" | "major" | "warning"
): ComplianceRuleResult {
  return {
    ruleId,
    passed,
    severity,
    evidence: [],
    reason: passed ? `${ruleId} 已通过` : `${ruleId} 未通过`,
  };
}

// ============================================================================
// 辅助函数：构造 ComplianceEvidenceReport
// ============================================================================

/**
 * 构造测试用的 ComplianceEvidenceReport（默认 overallPassed=true，全部规则通过）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 ComplianceEvidenceReport
 */
function createComplianceEvidenceReport(overrides: Partial<ComplianceEvidenceReport> = {}): ComplianceEvidenceReport {
  return {
    packId: "GMP",
    runId: "run-20260719-001",
    generatedAt: "2026-07-19T10:00:00.000Z",
    ruleResults: [createRuleResult("GMP-01", true, "blocker"), createRuleResult("GMP-02", true, "major")],
    overallPassed: true,
    summary: "GMP 合规包 2 条规则全部通过",
    ...overrides,
  };
}

// ============================================================================
// 辅助函数：构造 GateG7Context
// ============================================================================

/**
 * 构造测试用 GateG7Context（默认全部字段合法，含 ICP + 合规证据 + 含 packId/overallPassed 摘要的 PR）
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
    contractTestResults: [createTestExecutionResult("tests/contract/order.contract.test.ts")],
    e2eTests: [createE2eTestFile("tests/e2e/order-flow.e2e.test.ts")],
    e2eTestResults: [createTestExecutionResult("tests/e2e/order-flow.e2e.test.ts")],
    compliancePackIds: Object.freeze(["GMP"]),
    complianceEvidence: Object.freeze(createComplianceEvidenceReport()) as unknown as Readonly<Record<string, unknown>>,
    prDescription: createPrDescription(),
  };
  return { ...baseContext, ...overrides };
}

// ============================================================================
// T1. G-7-Comp-1：启用 ICP 但 complianceEvidence=undefined → passed=false
// ============================================================================

test("T1. G-7-Comp-1：启用 ICP 但 complianceEvidence=undefined → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({ complianceEvidence: undefined });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-1]"));
  assert.ok(result.reason.includes("complianceEvidence"));
  assert.ok(result.reason.includes("缺失"));
});

// ============================================================================
// T2. G-7-Comp-2：complianceEvidence 缺 packId 字段 → passed=false
// ============================================================================

test("T2. G-7-Comp-2：complianceEvidence 缺 packId 字段 → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport();
  // 删除 packId 字段
  const { packId: _unused, ...reportWithoutPackId } = report;
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(reportWithoutPackId) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  assert.ok(result.reason.includes("packId"));
});

// ============================================================================
// T3. G-7-Comp-2：complianceEvidence 缺 runId 字段 → passed=false
// ============================================================================

test("T3. G-7-Comp-2：complianceEvidence 缺 runId 字段 → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport();
  // 删除 runId 字段
  const { runId: _unused, ...reportWithoutRunId } = report;
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(reportWithoutRunId) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  assert.ok(result.reason.includes("runId"));
});

// ============================================================================
// T4. G-7-Comp-2：complianceEvidence 缺 generatedAt 字段 → passed=false
// ============================================================================

test("T4. G-7-Comp-2：complianceEvidence 缺 generatedAt 字段 → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport();
  // 删除 generatedAt 字段
  const { generatedAt: _unused, ...reportWithoutGeneratedAt } = report;
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(reportWithoutGeneratedAt) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  assert.ok(result.reason.includes("generatedAt"));
});

// ============================================================================
// T5. G-7-Comp-2：complianceEvidence 缺 ruleResults 字段 → passed=false
// ============================================================================

test("T5. G-7-Comp-2：complianceEvidence 缺 ruleResults 字段 → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport();
  // 删除 ruleResults 字段
  const { ruleResults: _unused, ...reportWithoutRuleResults } = report;
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(reportWithoutRuleResults) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  assert.ok(result.reason.includes("ruleResults"));
});

// ============================================================================
// T6. G-7-Comp-2：complianceEvidence 缺 overallPassed 字段 → passed=false
// ============================================================================

test("T6. G-7-Comp-2：complianceEvidence 缺 overallPassed 字段 → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport();
  // 删除 overallPassed 字段
  const { overallPassed: _unused, ...reportWithoutOverallPassed } = report;
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(reportWithoutOverallPassed) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  assert.ok(result.reason.includes("overallPassed"));
});

// ============================================================================
// T7. G-7-Comp-2：ruleResults 不是数组 → passed=false
// ============================================================================

test("T7. G-7-Comp-2：ruleResults 不是数组（字符串）→ passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport({
    ruleResults: "not-an-array" as unknown as ReadonlyArray<ComplianceRuleResult>,
  });
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(report) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  assert.ok(result.reason.includes("ruleResults"));
  assert.ok(result.reason.includes("数组"));
});

// ============================================================================
// T8. G-7-Comp-4：存在 blocker 级规则未通过 → passed=false
// ============================================================================

test("T8. G-7-Comp-4：存在 blocker 级规则未通过 → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport({
    ruleResults: [
      createRuleResult("GMP-01", true, "blocker"),
      createRuleResult("GMP-02", false, "blocker"), // blocker 级未通过
      createRuleResult("GMP-03", true, "major"),
    ],
    overallPassed: false,
  });
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(report) as unknown as Readonly<Record<string, unknown>>,
    prDescription: createPrDescription({ overallPassed: "false" }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-4]"));
  assert.ok(result.reason.includes("blocker"));
  assert.ok(result.reason.includes("GMP-02"));
});

// ============================================================================
// T9. G-7-Comp-4：blocker 级全过 + major 级未过 → G-7-Comp-4 通过，G-7-Comp-3 失败
// ============================================================================

test("T9. G-7-Comp-4：blocker 级全过 + major 级未过 → G-7-Comp-4 通过但 G-7-Comp-3 失败", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport({
    ruleResults: [
      createRuleResult("GMP-01", true, "blocker"),
      createRuleResult("GMP-02", false, "major"), // major 级未通过（B5-M2 修复：不可豁免，阻塞 G-7 门禁）
    ],
    overallPassed: false, // 由 major 级失败导致 overallPassed=false
  });
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(report) as unknown as Readonly<Record<string, unknown>>,
    prDescription: createPrDescription({ overallPassed: "false" }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // G-7-Comp-4 应通过（blocker 级全过），reason 不应包含 [G-7-Comp-4]
  assert.ok(!result.reason.includes("[G-7-Comp-4]"), `G-7-Comp-4 应通过，实际：${result.reason}`);
  // G-7-Comp-3 应失败
  assert.ok(result.reason.includes("[G-7-Comp-3]"));
  assert.ok(result.reason.includes("overallPassed=false"));
  // B5-M2 修复验证：失败消息应包含新文案"需修复后重试 G-7 门禁"
  assert.ok(
    result.reason.includes("需修复后重试 G-7 门禁"),
    `G-7-Comp-3 失败消息应包含 "需修复后重试 G-7 门禁"，实际：${result.reason}`
  );
  // B5-M2 修复验证：失败消息不再包含"可人工豁免"误导性表述
  assert.ok(!result.reason.includes("可人工豁免"), `G-7-Comp-3 失败消息不应包含 "可人工豁免"，实际：${result.reason}`);
});

// ============================================================================
// T10. G-7-Comp-3：overallPassed=false → passed=false
// ============================================================================

test("T10. G-7-Comp-3：overallPassed=false → passed=false", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport({
    ruleResults: [createRuleResult("GMP-01", true, "blocker"), createRuleResult("GMP-02", true, "major")],
    overallPassed: false, // 全部规则通过但 overallPassed=false（不一致场景）
  });
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(report) as unknown as Readonly<Record<string, unknown>>,
    prDescription: createPrDescription({ overallPassed: "false" }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-3]"));
  assert.ok(result.reason.includes("overallPassed=false"));
  // B5-M2 修复验证：失败消息应包含新文案"需修复后重试 G-7 门禁"
  assert.ok(
    result.reason.includes("需修复后重试 G-7 门禁"),
    `G-7-Comp-3 失败消息应包含 "需修复后重试 G-7 门禁"，实际：${result.reason}`
  );
  // B5-M2 修复验证：失败消息不再包含"可人工豁免"误导性表述
  assert.ok(!result.reason.includes("可人工豁免"), `G-7-Comp-3 失败消息不应包含 "可人工豁免"，实际：${result.reason}`);
});

// ============================================================================
// T11. G-7-Comp-1~4 全部通过 → passed=true
// ============================================================================

test("T11. G-7-Comp-1~4 全部通过 → passed=true", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport({
    ruleResults: [
      createRuleResult("GMP-01", true, "blocker"),
      createRuleResult("GMP-02", true, "major"),
      createRuleResult("GMP-03", true, "warning"),
    ],
    overallPassed: true,
  });
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(report) as unknown as Readonly<Record<string, unknown>>,
    prDescription: createPrDescription({ overallPassed: "true" }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("G-7 门禁通过"));
  assert.ok(result.reason.includes("ICP"));
});

// ============================================================================
// T12. 未启用 ICP（compliancePackIds=undefined）→ 跳过 G-7-Comp 校验
// ============================================================================

test("T12. 未启用 ICP（compliancePackIds=undefined）→ 跳过 G-7-Comp 校验", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    compliancePackIds: undefined,
    complianceEvidence: undefined,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  // reason 不应包含任何 [G-7-Comp-x] 标识
  assert.ok(!result.reason.includes("[G-7-Comp-"));
});

// ============================================================================
// T13. 未启用 ICP（compliancePackIds=[]）→ 跳过 G-7-Comp 校验
// ============================================================================

test("T13. 未启用 ICP（compliancePackIds=[]）→ 跳过 G-7-Comp 校验", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    compliancePackIds: Object.freeze([]),
    complianceEvidence: undefined,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(!result.reason.includes("[G-7-Comp-"));
});

// ============================================================================
// T14. PR 描述缺 "## 合规证据" 段（启用 ICP）→ passed=false
// ============================================================================

test("T14. PR 描述缺 ## 合规证据 段（启用 ICP）→ passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription({ omitComplianceSection: true }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // 应同时报告四段结构缺失 + G-7-PR-Comp 缺段
  assert.ok(result.reason.includes("合规证据"));
  assert.ok(result.reason.includes("[G-7-PR-Comp]"));
});

// ============================================================================
// T15. PR 描述 "## 合规证据" 段缺 packId 摘要 → passed=false
// ============================================================================

test("T15. PR 描述 ## 合规证据 段缺 packId 摘要 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription({ includePackId: false }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-PR-Comp]"));
  assert.ok(result.reason.includes("packId"));
});

// ============================================================================
// T16. PR 描述 "## 合规证据" 段缺 overallPassed 摘要 → passed=false
// ============================================================================

test("T16. PR 描述 ## 合规证据 段缺 overallPassed 摘要 → passed=false", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription({ includeOverallPassed: false }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-PR-Comp]"));
  assert.ok(result.reason.includes("overallPassed"));
});

// ============================================================================
// T17. PR 描述 "## 合规证据" 段含 packId 与 overallPassed 摘要 → 通过
// ============================================================================

test("T17. PR 描述 ## 合规证据 段含 packId 与 overallPassed 摘要 → 通过", () => {
  const checker = new GateG7Checker();
  const ctx = createG7Context({
    prDescription: createPrDescription({ includePackId: true, includeOverallPassed: true }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.ok(!result.reason.includes("[G-7-PR-Comp]"));
});

// ============================================================================
// T18. G-7-Comp-2 多重结构错误一次性收集
// ============================================================================

test("T18. G-7-Comp-2 多重结构错误一次性收集（缺 packId + runId + overallPassed）", () => {
  const checker = new GateG7Checker();
  // 构造一个缺多个字段的对象
  const badReport: Record<string, unknown> = {
    generatedAt: "2026-07-19T10:00:00.000Z",
    ruleResults: [],
    // 缺 packId / runId / overallPassed
  };
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(badReport) as unknown as Readonly<Record<string, unknown>>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-2]"));
  // 一次校验应同时报告 packId / runId / overallPassed 三个缺失字段
  assert.ok(result.reason.includes("packId"), `应同时报告 packId 缺失，实际：${result.reason}`);
  assert.ok(result.reason.includes("runId"), `应同时报告 runId 缺失，实际：${result.reason}`);
  assert.ok(result.reason.includes("overallPassed"), `应同时报告 overallPassed 缺失，实际：${result.reason}`);
});

// ============================================================================
// T19. G-7-Comp-4 多条 blocker 级规则未通过 → 错误消息列出全部 ruleId
// ============================================================================

test("T19. G-7-Comp-4 多条 blocker 级规则未通过 → 错误消息列出全部 ruleId", () => {
  const checker = new GateG7Checker();
  const report = createComplianceEvidenceReport({
    ruleResults: [
      createRuleResult("GMP-01", false, "blocker"), // blocker 级未通过
      createRuleResult("GMP-02", false, "blocker"), // blocker 级未通过
      createRuleResult("GMP-03", false, "blocker"), // blocker 级未通过
      createRuleResult("GMP-04", true, "major"),
    ],
    overallPassed: false,
  });
  const ctx = createG7Context({
    complianceEvidence: Object.freeze(report) as unknown as Readonly<Record<string, unknown>>,
    prDescription: createPrDescription({ overallPassed: "false" }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("[G-7-Comp-4]"));
  assert.ok(result.reason.includes("3 条 blocker"));
  // 应在错误消息中列出全部未通过的 blocker 级规则 ID
  assert.ok(result.reason.includes("GMP-01"), `应列出 GMP-01，实际：${result.reason}`);
  assert.ok(result.reason.includes("GMP-02"), `应列出 GMP-02，实际：${result.reason}`);
  assert.ok(result.reason.includes("GMP-03"), `应列出 GMP-03，实际：${result.reason}`);
});

// ============================================================================
// T20. G-7-Comp-1~4 + PR 描述段全部失败 → 多重失败一次性收集
// ============================================================================

test("T20. G-7-Comp-1 + G-7-PR-Comp 全部失败 → 多重失败一次性收集", () => {
  const checker = new GateG7Checker();
  // 同时触发：
  // 1. G-7-Comp-1（complianceEvidence=undefined）
  // 2. G-7-PR-Comp（PR 描述缺 ## 合规证据 段）
  // 注：complianceEvidence=undefined 时跳过 G-7-Comp-2/3/4 校验，但 PR 描述段校验仍执行
  const ctx = createG7Context({
    complianceEvidence: undefined,
    prDescription: createPrDescription({ omitComplianceSection: true }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // 应同时报告 G-7-Comp-1 与 G-7-PR-Comp
  assert.ok(result.reason.includes("[G-7-Comp-1]"), `应包含 [G-7-Comp-1]，实际：${result.reason}`);
  assert.ok(result.reason.includes("[G-7-PR-Comp]"), `应包含 [G-7-PR-Comp]，实际：${result.reason}`);
});
