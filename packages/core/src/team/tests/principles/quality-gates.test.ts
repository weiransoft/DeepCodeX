/**
 * 质量门禁系统测试
 *
 * 覆盖：
 * 1. 7 大门禁 ID 完整性
 * 2. 门禁配置 CRUD
 * 3. GateResult 创建与统计
 * 4. QualityReport 聚合逻辑（PASS/FAIL 判定）
 * 5. QualityGateManager 启用/禁用、阈值更新
 * 6. 单门禁执行（默认 PASS / 自定义 executor）
 * 7. 全部门禁执行
 * 8. Markdown / JSON 报告生成
 * 9. 异常处理（无 executor、executor 抛错）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { QualityGateIdType, GateExecutorLike, GateResult, GateFinding } from "../../principles/quality-gates.js";
import {
  QualityGateId,
  ALL_QUALITY_GATE_IDS,
  isValidQualityGateId,
  GateSeverityType,
  GateStatusType,
  GateSeverity,
  GateStatus,
  createQualityGateConfig,
  qualityGateConfigToDict,
  createGateFinding,
  createGateResult,
  createQualityReport,
  DEFAULT_GATE_CONFIGS,
  getDefaultGateConfigs,
  findGateConfig,
  DefaultPassExecutor,
  QualityGateManager,
  DEFAULT_QUALITY_GATE_MANAGER,
  QualityGateConfig,
} from "../../principles/quality-gates.js";

test("ALL_QUALITY_GATE_IDS has 7 gates", () => {
  assert.equal(ALL_QUALITY_GATE_IDS.length, 7);
});

test("isValidQualityGateId accepts all valid IDs", () => {
  for (const id of ALL_QUALITY_GATE_IDS) {
    assert.ok(isValidQualityGateId(id));
  }
  assert.equal(isValidQualityGateId("non-existent"), false);
});

test("GateSeverity has 4 levels", () => {
  assert.equal(GateSeverity.CRITICAL, "critical");
  assert.equal(GateSeverity.HIGH, "high");
  assert.equal(GateSeverity.MEDIUM, "medium");
  assert.equal(GateSeverity.LOW, "low");
});

test("GateStatus has 6 statuses", () => {
  assert.equal(GateStatus.PENDING, "pending");
  assert.equal(GateStatus.RUNNING, "running");
  assert.equal(GateStatus.PASSED, "passed");
  assert.equal(GateStatus.FAILED, "failed");
  assert.equal(GateStatus.SKIPPED, "skipped");
  assert.equal(GateStatus.ERROR, "error");
});

test("createQualityGateConfig applies defaults", () => {
  const cfg = createQualityGateConfig({
    gateId: QualityGateId.CODE_REVIEW,
    name: "测试",
    description: "测试门禁",
  });
  assert.equal(cfg.gateId, "code-review");
  assert.equal(cfg.severity, GateSeverity.HIGH); // 默认
  assert.equal(cfg.required, true); // 默认
  assert.equal(cfg.threshold, 0.0); // 默认
  assert.equal(cfg.weight, 1.0); // 默认
  assert.equal(cfg.enabled, true); // 默认
  assert.equal(cfg.checker, "default_checker"); // 默认
  assert.deepEqual(cfg.params, {}); // 默认
});

test("createQualityGateConfig accepts all overrides", () => {
  const cfg = createQualityGateConfig({
    gateId: QualityGateId.SECURITY_SCAN,
    name: "安全",
    description: "安全扫描",
    severity: GateSeverity.CRITICAL,
    required: true,
    threshold: 0.95,
    weight: 2.0,
    enabled: false,
    checker: "custom_checker",
    params: { foo: "bar" },
  });
  assert.equal(cfg.severity, GateSeverity.CRITICAL);
  assert.equal(cfg.threshold, 0.95);
  assert.equal(cfg.weight, 2.0);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.checker, "custom_checker");
  assert.equal(cfg.params["foo"], "bar");
});

test("qualityGateConfigToDict serializes correctly", () => {
  const cfg = createQualityGateConfig({
    gateId: QualityGateId.TEST_COVERAGE,
    name: "覆盖率",
    description: "测试覆盖率",
    threshold: 0.8,
  });
  const dict = qualityGateConfigToDict(cfg);
  assert.equal(dict["gateId"], "test-coverage");
  assert.equal(dict["threshold"], 0.8);
  assert.equal(dict["required"], true);
});

test("createGateFinding auto-generates ID when omitted", () => {
  const finding = createGateFinding({
    gateId: QualityGateId.SECURITY_SCAN,
    rule: "no-hardcoded-secrets",
    message: "发现硬编码密钥",
    severity: GateSeverity.CRITICAL,
    filePath: "/src/config.ts",
    lineNumber: 42,
    evidence: "const SECRET = 'abc123';",
    fix: "改用 process.env.SECRET",
  });
  assert.ok(finding.findingId.length > 0);
  assert.ok(finding.findingId.includes("security-scan"));
  assert.equal(finding.gateId, "security-scan");
  assert.equal(finding.lineNumber, 42);
});

test("createGateFinding uses provided ID", () => {
  const finding = createGateFinding({
    findingId: "custom-id-001",
    gateId: QualityGateId.PONYTAIL_REDLINES,
    rule: "no-mock",
    message: "发现 mock",
    severity: GateSeverity.HIGH,
    filePath: "/src/foo.ts",
    lineNumber: 10,
    evidence: "from unittest.mock import Mock",
    fix: "使用真实实现",
  });
  assert.equal(finding.findingId, "custom-id-001");
});

test("createGateResult with required fields", () => {
  const now = new Date().toISOString();
  const result = createGateResult({
    gateId: QualityGateId.KARPATHY_PRINCIPLES,
    status: GateStatus.PASSED,
    passed: true,
    score: 0.95,
    threshold: 0.9,
    startedAt: now,
    completedAt: now,
    durationMs: 100,
  });
  assert.equal(result.gateId, "karpathy-principles");
  assert.equal(result.passed, true);
  assert.equal(result.score, 0.95);
  assert.equal(result.findings.length, 0);
  assert.equal(result.errorMessage, "");
  assert.deepEqual(result.metadata, {});
});

test("createQualityReport aggregates passed/failed/skipped/errored", () => {
  const now = new Date().toISOString();
  const results: GateResult[] = [
    createGateResult({
      gateId: QualityGateId.CODE_REVIEW,
      status: GateStatus.PASSED,
      passed: true,
      score: 1.0,
      threshold: 1.0,
      startedAt: now,
      completedAt: now,
      durationMs: 10,
    }),
    createGateResult({
      gateId: QualityGateId.TEST_COVERAGE,
      status: GateStatus.FAILED,
      passed: false,
      score: 0.5,
      threshold: 0.8,
      startedAt: now,
      completedAt: now,
      durationMs: 20,
    }),
    createGateResult({
      gateId: QualityGateId.SPEC_COMPLIANCE,
      status: GateStatus.SKIPPED,
      passed: true,
      score: 0.0,
      threshold: 1.0,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    }),
    createGateResult({
      gateId: QualityGateId.SECURITY_SCAN,
      status: GateStatus.ERROR,
      passed: false,
      score: 0.0,
      threshold: 1.0,
      startedAt: now,
      completedAt: now,
      durationMs: 5,
      errorMessage: "executor crashed",
    }),
  ];
  const report = createQualityReport({
    reportId: "qr-test-001",
    projectPath: "/test/project",
    timestamp: now,
    results,
  });
  assert.equal(report.totalGates, 4);
  assert.equal(report.passedGates, 2);
  assert.equal(report.failedGates, 1);
  assert.equal(report.skippedGates, 1);
  assert.equal(report.erroredGates, 1);
  // 整体未通过（存在 failed/errored）
  assert.equal(report.overallPassed, false);
  // 整体分数 = (1.0 + 0.5 + 0.0 + 0.0) / 4 = 0.375
  assert.equal(report.overallScore, 0.375);
});

test("createQualityReport counts findings by severity", () => {
  const now = new Date().toISOString();
  const findings: GateFinding[] = [
    createGateFinding({
      gateId: QualityGateId.SECURITY_SCAN,
      rule: "r1",
      message: "m1",
      severity: GateSeverity.CRITICAL,
      filePath: "/a.ts",
      lineNumber: 1,
      evidence: "e1",
      fix: "f1",
    }),
    createGateFinding({
      gateId: QualityGateId.SECURITY_SCAN,
      rule: "r2",
      message: "m2",
      severity: GateSeverity.HIGH,
      filePath: "/b.ts",
      lineNumber: 2,
      evidence: "e2",
      fix: "f2",
    }),
    createGateFinding({
      gateId: QualityGateId.SECURITY_SCAN,
      rule: "r3",
      message: "m3",
      severity: GateSeverity.MEDIUM,
      filePath: "/c.ts",
      lineNumber: 3,
      evidence: "e3",
      fix: "f3",
    }),
    createGateFinding({
      gateId: QualityGateId.SECURITY_SCAN,
      rule: "r4",
      message: "m4",
      severity: GateSeverity.LOW,
      filePath: "/d.ts",
      lineNumber: 4,
      evidence: "e4",
      fix: "f4",
    }),
  ];
  const result = createGateResult({
    gateId: QualityGateId.SECURITY_SCAN,
    status: GateStatus.FAILED,
    passed: false,
    score: 0.3,
    threshold: 0.8,
    findings,
    startedAt: now,
    completedAt: now,
    durationMs: 100,
  });
  const report = createQualityReport({
    reportId: "qr-test-002",
    projectPath: "/test",
    timestamp: now,
    results: [result],
  });
  assert.equal(report.totalFindings, 4);
  assert.equal(report.criticalFindings, 1);
  assert.equal(report.highFindings, 1);
  assert.equal(report.mediumFindings, 1);
  assert.equal(report.lowFindings, 1);
});

test("DEFAULT_GATE_CONFIGS has 7 entries", () => {
  assert.equal(DEFAULT_GATE_CONFIGS.length, 7);
});

test("getDefaultGateConfigs returns a deep copy", () => {
  const c1 = getDefaultGateConfigs();
  const c2 = getDefaultGateConfigs();
  c1[0]!.enabled = false;
  c1[0]!.params["foo"] = "bar";
  // 修改 c1 不应影响 c2
  assert.equal(c2[0]!.enabled, true);
  assert.equal(c2[0]!.params["foo"], undefined);
});

test("findGateConfig finds by ID", () => {
  const configs = getDefaultGateConfigs();
  const found = findGateConfig(configs, QualityGateId.CODE_REVIEW);
  assert.ok(found !== null);
  assert.equal(found.gateId, "code-review");
  const notFound = findGateConfig(configs, "non-existent" as QualityGateIdType);
  assert.equal(notFound, null);
});

test("DefaultPassExecutor returns pass", async () => {
  const executor = new DefaultPassExecutor(QualityGateId.CODE_REVIEW);
  const cfg = getDefaultGateConfigs()[0]!;
  const result = await executor.execute("/tmp", cfg);
  assert.equal(result.score, 1.0);
  assert.equal(result.findings.length, 0);
  assert.equal(result.metadata?.["executor"], "default-pass");
});

test("QualityGateManager default runAll passes (default executor)", async () => {
  const manager = new QualityGateManager("/tmp/test");
  const report = await manager.runAll();
  // 默认 7 个门禁全部 enabled，默认 executor 全部 PASS
  assert.equal(report.totalGates, 6);
  assert.equal(report.passedGates, 6);
  assert.equal(report.failedGates, 0);
  assert.equal(report.overallPassed, true);
  assert.equal(report.overallScore, 1.0);
  assert.equal(report.criticalFindings, 0);
});

test("QualityGateManager.setEnabled toggles gate", async () => {
  const manager = new QualityGateManager("/tmp/test");
  manager.setEnabled(QualityGateId.SECURITY_SCAN, false);
  const report = await manager.runAll();
  // SECURITY_SCAN 被禁用 → 计入 skipped
  assert.equal(report.totalGates, 5); // 只跑 6 个
  assert.equal(report.skippedGates, 0); // SECURITY_SCAN skipped（不计入 total）
  // 因为只跑 enabled 的，所以 SECURITY_SCAN 不在 results 中
  const scanResult = report.results.find((r) => r.gateId === QualityGateId.SECURITY_SCAN);
  assert.equal(scanResult, undefined);
});

test("QualityGateManager.setThreshold updates threshold", () => {
  const manager = new QualityGateManager("/tmp/test");
  manager.setThreshold(QualityGateId.TEST_COVERAGE, 0.95);
  const cfg = findGateConfig(manager.configs, QualityGateId.TEST_COVERAGE);
  assert.equal(cfg?.threshold, 0.95);
});

test("QualityGateManager.runOne returns SKIPPED for disabled gate", async () => {
  const manager = new QualityGateManager("/tmp/test");
  manager.setEnabled(QualityGateId.UIUX_VISUAL, false); // UIUX_VISUAL 默认 disabled
  const result = await manager.runOne(manager.configs.find((c) => c.gateId === QualityGateId.UIUX_VISUAL)!);
  assert.equal(result.status, GateStatus.SKIPPED);
  assert.equal(result.passed, true);
});

test("QualityGateManager custom executor produces finding", async () => {
  const manager = new QualityGateManager("/tmp/test");
  // 注册失败执行器
  const failExecutor: GateExecutorLike = {
    gateId: QualityGateId.TEST_COVERAGE,
    async execute(_path, _cfg) {
      return {
        score: 0.5,
        findings: [
          createGateFinding({
            gateId: QualityGateId.TEST_COVERAGE,
            rule: "coverage-low",
            message: "覆盖率不足",
            severity: GateSeverity.HIGH,
            filePath: "/src/index.ts",
            lineNumber: 1,
            evidence: "lines-covered=50%",
            fix: "添加更多测试",
          }),
        ],
        metadata: { source: "custom" },
      };
    },
  };
  manager.registerExecutor(failExecutor);
  // 只跑 TEST_COVERAGE 一个门禁
  const tcConfig = manager.configs.find((c) => c.gateId === QualityGateId.TEST_COVERAGE)!;
  const result = await manager.runOne(tcConfig);
  assert.equal(result.status, GateStatus.FAILED);
  assert.equal(result.passed, false);
  assert.equal(result.score, 0.5);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.gateId, "test-coverage");
  assert.equal(result.metadata["source"], "custom");
});

test("QualityGateManager handles executor exception", async () => {
  const manager = new QualityGateManager("/tmp/test");
  const errorExecutor: GateExecutorLike = {
    gateId: QualityGateId.SECURITY_SCAN,
    async execute(_path, _cfg) {
      throw new Error("scanner crashed");
    },
  };
  manager.registerExecutor(errorExecutor);
  const scConfig = manager.configs.find((c) => c.gateId === QualityGateId.SECURITY_SCAN)!;
  const result = await manager.runOne(scConfig);
  assert.equal(result.status, GateStatus.ERROR);
  assert.equal(result.passed, false);
  assert.equal(result.errorMessage, "scanner crashed");
});

test("QualityGateManager handles missing executor", async () => {
  const manager = new QualityGateManager("/tmp/test");
  // 手动注册一个 gateId 但不实现 execute
  const noExecutor: GateExecutorLike = {
    gateId: "non-existent" as QualityGateIdType,
    async execute() {
      return { score: 0, findings: [] };
    },
  };
  manager.registerExecutor(noExecutor);
  // 现在 CODE_REVIEW 没有 executor 被显式注册，会用 DefaultPassExecutor
  // 测试在调用时移除默认 executor
  manager.executors.delete(QualityGateId.CODE_REVIEW);
  const crConfig = manager.configs.find((c) => c.gateId === QualityGateId.CODE_REVIEW)!;
  const result = await manager.runOne(crConfig);
  assert.equal(result.status, GateStatus.ERROR);
  assert.equal(result.errorMessage.includes("no executor"), true);
});

test("QualityGateManager.reportToMarkdown generates valid report", async () => {
  const manager = new QualityGateManager("/tmp/test");
  const report = await manager.runAll();
  const md = manager.reportToMarkdown(report);
  assert.ok(md.includes("# 质量门禁报告"));
  assert.ok(md.includes("整体通过"));
  assert.ok(md.includes("门禁详情"));
  assert.ok(md.includes("| code-review |"));
  assert.ok(md.includes("| test-coverage |"));
});

test("QualityGateManager.reportToJson generates valid JSON", async () => {
  const manager = new QualityGateManager("/tmp/test");
  const report = await manager.runAll();
  const json = manager.reportToJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.reportId, report.reportId);
  assert.equal(parsed.totalGates, 6);
});

test("DEFAULT_QUALITY_GATE_MANAGER is a usable instance", async () => {
  const report = await DEFAULT_QUALITY_GATE_MANAGER.runAll();
  assert.ok(report.totalGates > 0);
});
