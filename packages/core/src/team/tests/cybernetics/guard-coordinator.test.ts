/**
 * GuardCoordinator 守护协调器测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AIProviderLike } from "../../cybernetics/guard-coordinator.js";
import {
  RiskLevel,
  ALL_RISK_LEVELS,
  isValidRiskLevel,
  Severity,
  GuardCoordinatorError,
  createValidationWarning,
  validationWarningToDict,
  createCompensationStrategy,
  compensationStrategyToDict,
  createAnomalyPattern,
  ANOMALY_PATTERN_IDS,
  COMPENSATION_STRATEGY_IDS,
  containsPlaceholderCode,
  containsSpeculativeCode,
  hasClearGoals,
  containsUnverifiedAssumptions,
  GuardCoordinator,
} from "../../cybernetics/guard-coordinator.js";

test("ALL_RISK_LEVELS has 4 levels", () => {
  assert.equal(ALL_RISK_LEVELS.length, 4);
  assert.equal(RiskLevel.LOW, "low");
  assert.equal(RiskLevel.MEDIUM, "medium");
  assert.equal(RiskLevel.HIGH, "high");
  assert.equal(RiskLevel.CRITICAL, "critical");
});

test("isValidRiskLevel accepts valid", () => {
  for (const l of ALL_RISK_LEVELS) {
    assert.ok(isValidRiskLevel(l));
  }
  assert.equal(isValidRiskLevel("invalid"), false);
});

test("Severity has 4 levels", () => {
  assert.equal(Severity.INFO, "info");
  assert.equal(Severity.WARNING, "warning");
  assert.equal(Severity.ERROR, "error");
  assert.equal(Severity.CRITICAL, "critical");
});

test("createValidationWarning captures fields", () => {
  const w = createValidationWarning({
    warning_code: "W001",
    warning_type: "placeholder",
    message: "占位代码",
    severity: Severity.CRITICAL,
    recommended_action: "实现真实逻辑",
  });
  assert.equal(w.warning_code, "W001");
  assert.equal(w.warning_type, "placeholder");
});

test("validationWarningToDict serializes", () => {
  const w = createValidationWarning({
    warning_code: "W001",
    warning_type: "t",
    message: "m",
    severity: Severity.WARNING,
    recommended_action: "a",
  });
  const dict = validationWarningToDict(w);
  assert.equal(dict["warning_code"], "W001");
});

test("createCompensationStrategy captures fields", () => {
  const s = createCompensationStrategy({
    strategy_id: COMPENSATION_STRATEGY_IDS.TIMEOUT,
    error_type: "timeout",
    strategy_type: "feedforward",
    actions: ["increase timeout"],
    priority: 5,
    confidence: 0.8,
  });
  assert.equal(s.strategy_id, "strat_timeout");
  assert.equal(s.actions.length, 1);
});

test("compensationStrategyToDict serializes", () => {
  const s = createCompensationStrategy({
    strategy_id: COMPENSATION_STRATEGY_IDS.MEMORY,
    error_type: "memory",
    strategy_type: "feedback",
    actions: ["reduce cache"],
    priority: 8,
    confidence: 0.9,
  });
  const dict = compensationStrategyToDict(s);
  assert.equal(dict["error_type"], "memory");
});

test("createAnomalyPattern captures fields", () => {
  const p = createAnomalyPattern({
    pattern_id: ANOMALY_PATTERN_IDS.TIMEOUT_REPEATED,
    pattern_type: "timeout",
    trigger_conditions: [],
    anomaly_indicators: ["high latency"],
    recommended_response: "switch strategy",
    severity: RiskLevel.HIGH,
  });
  assert.equal(p.pattern_id, "pattern_timeout_repeated");
  assert.equal(p.severity, "high");
});

test("containsPlaceholderCode detects mock/TODO", () => {
  assert.equal(containsPlaceholderCode({ description: "use mock data" }), true);
  assert.equal(containsPlaceholderCode({ description: "pass  # 占位" }), true);
  assert.equal(containsPlaceholderCode({ description: "normal task" }), false);
});

test("containsSpeculativeCode detects future-reserved code", () => {
  assert.equal(containsSpeculativeCode({ description: "为未来预留扩展点" }), true);
  assert.equal(containsSpeculativeCode({ description: "implement feature now" }), false);
});

test("hasClearGoals checks for description or goals", () => {
  assert.equal(hasClearGoals({ description: "implement X with tests" }), true);
  assert.equal(hasClearGoals({ goals: ["goal1"] }), true);
  assert.equal(hasClearGoals({ description: "no" }), false);
  assert.equal(hasClearGoals({}), false);
});

test("containsUnverifiedAssumptions detects assumption comments", () => {
  assert.equal(containsUnverifiedAssumptions({ description: "假设数据格式正确" }), true);
  assert.equal(containsUnverifiedAssumptions({ description: "implement logic" }), false);
});

test("GuardCoordinator initializes default strategies/patterns/rules", () => {
  const gc = new GuardCoordinator({ agent_id: "agent-1" });
  assert.ok(gc.compensation_strategies.size > 0);
  assert.ok(gc.anomaly_patterns.size > 0);
  assert.ok(gc.validation_rules.length > 0);
});

test("GuardCoordinator.preExecuteValidation passes for clean task", async () => {
  const gc = new GuardCoordinator({ agent_id: "agent-1" });
  const result = await gc.preExecuteValidation({
    description: "implement feature X with proper tests and clear goals",
  });
  assert.ok(result !== null);
  assert.equal(typeof result.passed, "boolean");
  assert.ok(result.validation_time >= 0);
});

test("GuardCoordinator.preExecuteValidation flags placeholder code", async () => {
  const gc = new GuardCoordinator({ agent_id: "agent-1" });
  const result = await gc.preExecuteValidation({
    description: "use mock data in production",
    code: "pass  # 占位",
  });
  assert.ok(result.warnings.length > 0);
});

test("GuardCoordinator.monitorExecution returns monitor result", async () => {
  const gc = new GuardCoordinator({ agent_id: "agent-1" });
  const m = await gc.monitorExecution("exec-1", { success: true });
  assert.ok(m !== null);
  assert.equal(typeof m.status, "string");
  assert.ok(Array.isArray(m.detected_patterns));
});

test("GuardCoordinator.postExecuteReview returns review", async () => {
  const gc = new GuardCoordinator({ agent_id: "agent-1" });
  const r = await gc.postExecuteReview("exec-1", { success: true });
  assert.ok(r !== null);
  assert.ok(["SUCCESS", "PARTIAL_SUCCESS", "FAILURE"].includes(r.outcome));
});

test("GuardCoordinator accepts AIProvider", () => {
  const ai_provider: AIProviderLike = {
    generate: (prompt: string) => `mock: ${prompt}`,
  };
  const gc = new GuardCoordinator({ agent_id: "agent-2", ai_provider });
  assert.equal(gc.ai_provider, ai_provider);
});
