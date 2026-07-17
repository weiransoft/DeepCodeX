/**
 * KarpathyPrincipleEnforcer 单元测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PrincipleType,
  ALL_PRINCIPLE_TYPES,
  isValidPrincipleType,
  ViolationSeverity,
  SEVERITY_ORDER,
  VIOLATION_PATTERNS,
  createPrincipleViolation,
  principleViolationToDict,
  createVerificationCheckpoint,
  verificationCheckpointToDict,
  karpathyEnforcementReportToDict,
  KarpathyNodeFileSystem,
  KarpathyPrincipleEnforcer,
  getPrincipleName,
} from "../../cybernetics/karpathy-principle-enforcer.js";

test("PrincipleType has 4 types", () => {
  assert.equal(ALL_PRINCIPLE_TYPES.length, 4);
  assert.equal(PrincipleType.THINK_BEFORE_CODING, "think_before_coding");
  assert.equal(PrincipleType.SIMPLICITY_FIRST, "simplicity_first");
  assert.equal(PrincipleType.SURGICAL_CHANGES, "surgical_changes");
  assert.equal(PrincipleType.GOAL_DRIVEN, "goal_driven");
});

test("isValidPrincipleType accepts valid", () => {
  for (const p of ALL_PRINCIPLE_TYPES) {
    assert.ok(isValidPrincipleType(p));
  }
  assert.equal(isValidPrincipleType("invalid"), false);
});

test("SEVERITY_ORDER ranks correctly", () => {
  assert.ok(SEVERITY_ORDER[ViolationSeverity.CRITICAL] > SEVERITY_ORDER[ViolationSeverity.HIGH]);
  assert.ok(SEVERITY_ORDER[ViolationSeverity.HIGH] > SEVERITY_ORDER[ViolationSeverity.MEDIUM]);
  assert.ok(SEVERITY_ORDER[ViolationSeverity.MEDIUM] > SEVERITY_ORDER[ViolationSeverity.LOW]);
  assert.ok(SEVERITY_ORDER[ViolationSeverity.LOW] > SEVERITY_ORDER[ViolationSeverity.INFO]);
});

test("VIOLATION_PATTERNS has patterns for all 4 principles", () => {
  for (const p of ALL_PRINCIPLE_TYPES) {
    assert.ok(VIOLATION_PATTERNS[p] !== undefined);
    assert.ok(VIOLATION_PATTERNS[p]!.length > 0);
  }
});

test("createPrincipleViolation captures all fields", () => {
  const v = createPrincipleViolation({
    principle: PrincipleType.SURGICAL_CHANGES,
    severity: ViolationSeverity.CRITICAL,
    file_path: "/src/foo.ts",
    line_number: 42,
    description: "占位代码",
    suggestion: "实现真实逻辑",
    evidence: "pass  # 占位",
  });
  assert.equal(v.principle, "surgical_changes");
  assert.equal(v.severity, "critical");
  assert.equal(v.file_path, "/src/foo.ts");
  assert.equal(v.line_number, 42);
});

test("principleViolationToDict serializes", () => {
  const v = createPrincipleViolation({
    principle: PrincipleType.SIMPLICITY_FIRST,
    severity: ViolationSeverity.MEDIUM,
    file_path: "/a.ts",
    line_number: 1,
    description: "d",
    suggestion: "s",
    evidence: "e",
  });
  const dict = principleViolationToDict(v);
  assert.equal(dict["principle"], "simplicity_first");
  assert.equal(dict["severity"], "medium");
});

test("createVerificationCheckpoint initializes unverified", () => {
  const cp = createVerificationCheckpoint({
    checkpoint_id: "cp-1",
    principle: PrincipleType.GOAL_DRIVEN,
    description: "test",
    criteria: ["c1", "c2"],
  });
  assert.equal(cp.verified, false);
  assert.equal(cp.criteria.length, 2);
});

test("verificationCheckpointToDict serializes", () => {
  const cp = createVerificationCheckpoint({
    checkpoint_id: "cp-1",
    principle: PrincipleType.GOAL_DRIVEN,
    description: "d",
    criteria: ["c"],
  });
  const dict = verificationCheckpointToDict(cp);
  assert.equal(dict["verified"], false);
});

test("karpathyEnforcementReportToDict structure", () => {
  const report = {
    report_id: "r1",
    project_path: "/p",
    timestamp: new Date().toISOString(),
    violations: [],
    checkpoints: [],
    summary: {},
  };
  const dict = karpathyEnforcementReportToDict(report);
  assert.equal(dict["report_id"], "r1");
  assert.equal(Array.isArray(dict["violations"]), true);
});

test("getPrincipleName returns human-readable name", () => {
  // 实际返回带 emoji 和中文的完整名称（用于 UI 展示）
  assert.ok(getPrincipleName(PrincipleType.THINK_BEFORE_CODING).includes("Think Before Coding"));
  assert.ok(getPrincipleName(PrincipleType.SIMPLICITY_FIRST).includes("Simplicity First"));
  assert.ok(getPrincipleName(PrincipleType.SURGICAL_CHANGES).includes("Surgical Changes"));
  assert.ok(getPrincipleName(PrincipleType.GOAL_DRIVEN).includes("Goal-Driven"));
});

test("KarpathyPrincipleEnforcer can be instantiated", () => {
  const enforcer = new KarpathyPrincipleEnforcer({
    project_root: "/tmp",
  });
  assert.ok(enforcer !== null);
});

test("KarpathyPrincipleEnforcer scanFile detects violation", () => {
  const enforcer = new KarpathyPrincipleEnforcer({
    project_root: "/tmp",
  });
  // 创建临时文件包含占位代码
  const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.ts`);
  fs.writeFileSync(tmpFile, "function foo() {\n  pass  # 占位\n}\n", "utf8");
  const violations = enforcer.scanFile(tmpFile);
  fs.unlinkSync(tmpFile);
  assert.ok(violations.length > 0);
  // 占位代码通常归类为 SURGICAL_CHANGES
  assert.ok(violations.some((v) => v.principle === PrincipleType.SURGICAL_CHANGES));
});

test("KarpathyPrincipleEnforcer scanFile returns empty for clean file", () => {
  const enforcer = new KarpathyPrincipleEnforcer({
    project_root: "/tmp",
  });
  const tmpFile = path.join(os.tmpdir(), `clean-${Date.now()}.ts`);
  fs.writeFileSync(tmpFile, "// Clean file\nconst x = 1;\nexport { x };\n", "utf8");
  const violations = enforcer.scanFile(tmpFile);
  fs.unlinkSync(tmpFile);
  assert.equal(violations.length, 0);
});

test("KarpathyPrincipleEnforcer hasCriticalViolations works", () => {
  const enforcer = new KarpathyPrincipleEnforcer({
    project_root: "/tmp",
  });
  const tmpFile = path.join(os.tmpdir(), `crit-${Date.now()}.ts`);
  fs.writeFileSync(tmpFile, "function foo() {\n  pass  # 占位\n}\n", "utf8");
  enforcer.scanFile(tmpFile);
  fs.unlinkSync(tmpFile);
  assert.equal(enforcer.hasCriticalViolations(), true);
});

test("KarpathyPrincipleEnforcer generateReport works", () => {
  const enforcer = new KarpathyPrincipleEnforcer({
    project_root: "/tmp",
  });
  const tmpFile = path.join(os.tmpdir(), `gen-${Date.now()}.ts`);
  fs.writeFileSync(tmpFile, "function foo() {\n  pass  # 占位\n}\n", "utf8");
  enforcer.scanFile(tmpFile);
  fs.unlinkSync(tmpFile);
  const report = enforcer.generateReport();
  assert.ok(typeof report === "string");
  assert.ok(report.length > 0);
});
