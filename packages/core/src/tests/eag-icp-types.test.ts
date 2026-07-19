/**
 * EAG-P3 批次 11 单元测试：ICP 核心类型与常量（types.ts）
 *
 * 测试范围：
 * - T1. CompliancePackId 字面量联合 + COMPLIANCE_PACK_IDS 常量
 * - T2. ComplianceSeverity + COMPLIANCE_SEVERITIES
 * - T3. ComplianceCheckKind + COMPLIANCE_CHECK_KINDS
 * - T4. ComplianceEvidenceKind + COMPLIANCE_EVIDENCE_KINDS
 * - T5. DEFAULT_COMPLIANCE_PACK_VERSION / DEFAULT_PACK_NAMES 常量
 * - T6. createComplianceEvidence 工厂函数（含校验与冻结）
 * - T7. createComplianceRuleResult 工厂函数（含校验与冻结）
 * - T8. createComplianceEvidenceReport 工厂函数（含校验与冻结）
 * - T9. createComplianceCheckContext 工厂函数（含校验与冻结）
 * - T10. ComplianceCheckError 错误类型
 * - T11. 不可变性校验（Object.isFrozen === true）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-icp-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPLIANCE_PACK_IDS,
  COMPLIANCE_SEVERITIES,
  COMPLIANCE_CHECK_KINDS,
  COMPLIANCE_EVIDENCE_KINDS,
  DEFAULT_COMPLIANCE_PACK_VERSION,
  DEFAULT_PACK_NAMES,
  createComplianceEvidence,
  createComplianceRuleResult,
  createComplianceEvidenceReport,
  createComplianceCheckContext,
  ComplianceCheckError,
} from "../eag/icp/types";

// ============================================================================
// T1. CompliancePackId + COMPLIANCE_PACK_IDS
// ============================================================================

test("T1a: COMPLIANCE_PACK_IDS 应包含三大法规域", () => {
  assert.equal(COMPLIANCE_PACK_IDS.length, 3, "应有 3 个合规包 ID");
  assert.ok(COMPLIANCE_PACK_IDS.includes("GMP"), "应包含 GMP");
  assert.ok(COMPLIANCE_PACK_IDS.includes("CFR"), "应包含 CFR");
  assert.ok(COMPLIANCE_PACK_IDS.includes("ALCOA"), "应包含 ALCOA");
});

test("T1b: COMPLIANCE_PACK_IDS 应被冻结", () => {
  assert.ok(Object.isFrozen(COMPLIANCE_PACK_IDS), "COMPLIANCE_PACK_IDS 应被 Object.freeze 冻结");
});

test("T1c: COMPLIANCE_PACK_IDS 顺序应为 GMP / CFR / ALCOA", () => {
  const expected = ["GMP", "CFR", "ALCOA"];
  assert.deepEqual([...COMPLIANCE_PACK_IDS], expected);
});

// ============================================================================
// T2. ComplianceSeverity + COMPLIANCE_SEVERITIES
// ============================================================================

test("T2a: COMPLIANCE_SEVERITIES 应包含三种严重性", () => {
  assert.equal(COMPLIANCE_SEVERITIES.length, 3);
  assert.ok(COMPLIANCE_SEVERITIES.includes("blocker"));
  assert.ok(COMPLIANCE_SEVERITIES.includes("major"));
  assert.ok(COMPLIANCE_SEVERITIES.includes("warning"));
});

test("T2b: COMPLIANCE_SEVERITIES 应被冻结", () => {
  assert.ok(Object.isFrozen(COMPLIANCE_SEVERITIES));
});

test("T2c: COMPLIANCE_SEVERITIES 顺序应为 blocker → major → warning（递减）", () => {
  assert.deepEqual([...COMPLIANCE_SEVERITIES], ["blocker", "major", "warning"]);
});

// ============================================================================
// T3. ComplianceCheckKind + COMPLIANCE_CHECK_KINDS
// ============================================================================

test("T3a: COMPLIANCE_CHECK_KINDS 应包含三种检查类型", () => {
  assert.equal(COMPLIANCE_CHECK_KINDS.length, 3);
  assert.ok(COMPLIANCE_CHECK_KINDS.includes("static"));
  assert.ok(COMPLIANCE_CHECK_KINDS.includes("dynamic"));
  assert.ok(COMPLIANCE_CHECK_KINDS.includes("hybrid"));
});

test("T3b: COMPLIANCE_CHECK_KINDS 应被冻结", () => {
  assert.ok(Object.isFrozen(COMPLIANCE_CHECK_KINDS));
});

// ============================================================================
// T4. ComplianceEvidenceKind + COMPLIANCE_EVIDENCE_KINDS
// ============================================================================

test("T4a: COMPLIANCE_EVIDENCE_KINDS 应包含五种证据类型", () => {
  assert.equal(COMPLIANCE_EVIDENCE_KINDS.length, 5);
  assert.ok(COMPLIANCE_EVIDENCE_KINDS.includes("code-snippet"));
  assert.ok(COMPLIANCE_EVIDENCE_KINDS.includes("test-output"));
  assert.ok(COMPLIANCE_EVIDENCE_KINDS.includes("config"));
  assert.ok(COMPLIANCE_EVIDENCE_KINDS.includes("log"));
  assert.ok(COMPLIANCE_EVIDENCE_KINDS.includes("audit-trail"));
});

test("T4b: COMPLIANCE_EVIDENCE_KINDS 应被冻结", () => {
  assert.ok(Object.isFrozen(COMPLIANCE_EVIDENCE_KINDS));
});

// ============================================================================
// T5. 默认常量
// ============================================================================

test("T5a: DEFAULT_COMPLIANCE_PACK_VERSION 应为 1.0.0", () => {
  assert.equal(DEFAULT_COMPLIANCE_PACK_VERSION, "1.0.0");
});

test("T5b: DEFAULT_PACK_NAMES 应包含三大法规域的中文名称", () => {
  assert.equal(DEFAULT_PACK_NAMES.GMP, "药品生产质量管理规范（GMP）");
  assert.equal(DEFAULT_PACK_NAMES.CFR, "21 CFR Part 11 电子记录与电子签名");
  assert.equal(DEFAULT_PACK_NAMES.ALCOA, "ALCOA+ 数据完整性原则");
});

test("T5c: DEFAULT_PACK_NAMES 应被冻结", () => {
  assert.ok(Object.isFrozen(DEFAULT_PACK_NAMES));
});

// ============================================================================
// T6. createComplianceEvidence 工厂函数
// ============================================================================

test("T6a: createComplianceEvidence 应正常构造合法证据对象", () => {
  const evidence = createComplianceEvidence({
    kind: "code-snippet",
    source: "src/test.ts:1-10",
    content: "console.log('hello');",
  });
  assert.equal(evidence.kind, "code-snippet");
  assert.equal(evidence.source, "src/test.ts:1-10");
  assert.equal(evidence.content, "console.log('hello');");
  assert.ok(Object.isFrozen(evidence), "返回值应被冻结");
});

test("T6b: createComplianceEvidence 应拒绝非法 kind", () => {
  assert.throws(
    () =>
      createComplianceEvidence({
        // @ts-expect-error 测试非法 kind
        kind: "invalid-kind",
        source: "src/test.ts",
        content: "test",
      }),
    /kind 非法/,
    "应拒绝非法 kind"
  );
});

test("T6c: createComplianceEvidence 应拒绝空 source", () => {
  assert.throws(
    () =>
      createComplianceEvidence({
        kind: "code-snippet",
        source: "",
        content: "test",
      }),
    /source 必须为非空字符串/,
    "应拒绝空 source"
  );
});

test("T6d: createComplianceEvidence 应拒绝非字符串 content", () => {
  assert.throws(
    () =>
      createComplianceEvidence({
        kind: "code-snippet",
        source: "src/test.ts",
        // @ts-expect-error 测试非字符串 content
        content: 123,
      }),
    /content 必须为字符串/,
    "应拒绝非字符串 content"
  );
});

test("T6e: createComplianceEvidence 应允许空字符串 content", () => {
  const evidence = createComplianceEvidence({
    kind: "log",
    source: "log:test",
    content: "",
  });
  assert.equal(evidence.content, "");
});

// ============================================================================
// T7. createComplianceRuleResult 工厂函数
// ============================================================================

test("T7a: createComplianceRuleResult 应正常构造合法结果对象", () => {
  const result = createComplianceRuleResult({
    ruleId: "GMP-01",
    passed: true,
    severity: "blocker",
    evidence: [],
    reason: "测试通过",
  });
  assert.equal(result.ruleId, "GMP-01");
  assert.equal(result.passed, true);
  assert.equal(result.severity, "blocker");
  assert.equal(result.reason, "测试通过");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence));
});

test("T7b: createComplianceRuleResult 应拒绝空 ruleId", () => {
  assert.throws(
    () =>
      createComplianceRuleResult({
        ruleId: "",
        passed: true,
        severity: "blocker",
        evidence: [],
        reason: "test",
      }),
    /ruleId 必须为非空字符串/
  );
});

test("T7c: createComplianceRuleResult 应拒绝非法 severity", () => {
  assert.throws(
    () =>
      createComplianceRuleResult({
        ruleId: "GMP-01",
        passed: true,
        // @ts-expect-error 测试非法 severity
        severity: "critical",
        evidence: [],
        reason: "test",
      }),
    /severity 非法/
  );
});

test("T7d: createComplianceRuleResult 应拒绝非数组 evidence", () => {
  assert.throws(
    () =>
      createComplianceRuleResult({
        ruleId: "GMP-01",
        passed: true,
        severity: "blocker",
        // @ts-expect-error 测试非数组 evidence
        evidence: "not-array",
        reason: "test",
      }),
    /evidence 必须为数组/
  );
});

// ============================================================================
// T8. createComplianceEvidenceReport 工厂函数
// ============================================================================

test("T8a: createComplianceEvidenceReport 应正常构造合法报告对象", () => {
  const report = createComplianceEvidenceReport({
    packId: "GMP",
    runId: "run-001",
    generatedAt: "2026-07-19T10:00:00.000Z",
    ruleResults: [],
    overallPassed: true,
    summary: "测试通过",
  });
  assert.equal(report.packId, "GMP");
  assert.equal(report.runId, "run-001");
  assert.equal(report.generatedAt, "2026-07-19T10:00:00.000Z");
  assert.equal(report.overallPassed, true);
  assert.equal(report.summary, "测试通过");
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.ruleResults));
});

test("T8b: createComplianceEvidenceReport 应拒绝非法 packId", () => {
  assert.throws(
    () =>
      createComplianceEvidenceReport({
        // @ts-expect-error 测试非法 packId
        packId: "INVALID",
        runId: "run-001",
        generatedAt: "2026-07-19T10:00:00.000Z",
        ruleResults: [],
        overallPassed: true,
        summary: "test",
      }),
    /packId 非法/
  );
});

test("T8c: createComplianceEvidenceReport 应拒绝空 runId", () => {
  assert.throws(
    () =>
      createComplianceEvidenceReport({
        packId: "GMP",
        runId: "",
        generatedAt: "2026-07-19T10:00:00.000Z",
        ruleResults: [],
        overallPassed: true,
        summary: "test",
      }),
    /runId 必须为非空字符串/
  );
});

test("T8d: createComplianceEvidenceReport 应拒绝非布尔 overallPassed", () => {
  assert.throws(
    () =>
      createComplianceEvidenceReport({
        packId: "GMP",
        runId: "run-001",
        generatedAt: "2026-07-19T10:00:00.000Z",
        ruleResults: [],
        // @ts-expect-error 测试非布尔 overallPassed
        overallPassed: "yes",
        summary: "test",
      }),
    /overallPassed 必须为布尔值/
  );
});

// ============================================================================
// T9. createComplianceCheckContext 工厂函数
// ============================================================================

test("T9a: createComplianceCheckContext 应正常构造合法上下文", () => {
  const ctx = createComplianceCheckContext({
    projectRoot: "/tmp/project",
    fileMap: { "src/test.ts": "console.log('hi');" },
    astMap: {},
    configMap: { key: "value" },
  });
  assert.equal(ctx.projectRoot, "/tmp/project");
  assert.equal(ctx.fileMap["src/test.ts"], "console.log('hi');");
  assert.equal(ctx.configMap.key, "value");
  assert.ok(Object.isFrozen(ctx));
  assert.ok(Object.isFrozen(ctx.fileMap));
  assert.ok(Object.isFrozen(ctx.configMap));
});

test("T9b: createComplianceCheckContext 应拒绝空 projectRoot", () => {
  assert.throws(
    () =>
      createComplianceCheckContext({
        projectRoot: "",
        fileMap: {},
        astMap: {},
        configMap: {},
      }),
    /projectRoot 必须为非空字符串/
  );
});

test("T9c: createComplianceCheckContext 应拒绝非对象 fileMap", () => {
  assert.throws(
    () =>
      createComplianceCheckContext({
        projectRoot: "/tmp",
        // @ts-expect-error 测试非对象 fileMap
        fileMap: "not-object",
        astMap: {},
        configMap: {},
      }),
    /fileMap 必须为对象/
  );
});

test("T9d: createComplianceCheckContext 应保留 testRunner 注入", () => {
  const fakeRunner = {
    async run(_testPath: string) {
      return { exitCode: 0, output: "ok" };
    },
  };
  const ctx = createComplianceCheckContext({
    projectRoot: "/tmp",
    fileMap: {},
    astMap: {},
    configMap: {},
    testRunner: fakeRunner,
  });
  assert.ok(ctx.testRunner, "testRunner 应被保留");
  assert.equal(typeof ctx.testRunner!.run, "function");
});

// ============================================================================
// T10. ComplianceCheckError 错误类型
// ============================================================================

test("T10a: ComplianceCheckError 应正确构造", () => {
  const error = new ComplianceCheckError("GMP-01", "测试执行失败", new Error("inner"));
  assert.equal(error.ruleId, "GMP-01");
  assert.equal(error.reason, "测试执行失败");
  assert.ok(error.cause instanceof Error);
  assert.equal(error.cause.message, "inner");
  assert.equal(error.name, "ComplianceCheckError");
  assert.ok(error.message.includes("GMP-01"));
  assert.ok(error.message.includes("测试执行失败"));
});

test("T10b: ComplianceCheckError 应可不传 cause", () => {
  const error = new ComplianceCheckError("CFR-01", "原因不明");
  assert.equal(error.ruleId, "CFR-01");
  assert.equal(error.reason, "原因不明");
  assert.equal(error.cause, undefined);
});

// ============================================================================
// T11. 不可变性深度校验
// ============================================================================

test("T11a: createComplianceEvidence 返回值尝试修改应抛错（strict mode）", () => {
  "use strict";
  const evidence = createComplianceEvidence({
    kind: "code-snippet",
    source: "src/test.ts",
    content: "test",
  });
  assert.throws(
    () => {
      // @ts-expect-error 测试修改冻结对象
      evidence.kind = "log";
    },
    TypeError,
    "冻结对象的属性赋值应抛 TypeError"
  );
});

test("T11b: createComplianceEvidenceReport 返回值的 ruleResults 应被冻结", () => {
  const report = createComplianceEvidenceReport({
    packId: "CFR",
    runId: "run-002",
    generatedAt: "2026-07-19T10:00:00.000Z",
    ruleResults: [
      {
        ruleId: "CFR-01",
        passed: true,
        severity: "blocker",
        evidence: [],
        reason: "通过",
      },
    ],
    overallPassed: true,
    summary: "全部通过",
  });
  assert.ok(Object.isFrozen(report.ruleResults), "ruleResults 应被冻结");
  assert.throws(
    () => {
      // @ts-expect-error 测试修改冻结数组
      report.ruleResults.push({ ruleId: "x" });
    },
    TypeError,
    "冻结数组的 push 应抛 TypeError"
  );
});
