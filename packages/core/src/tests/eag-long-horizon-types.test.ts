/**
 * EAG-P3 批次 10 单元测试：long-horizon/types.ts 数据模型与常量
 *
 * 测试范围：
 * - T1. 状态字面量联合类型常量完整性（RUN_STATE_STATUSES / MULTI_LOOP_NODE_STATUSES 等）
 * - T2. DEFAULT_LOOP_TRANSITIONS 默认 Loop 转换规则
 * - T3. DEFAULT_ROOT_CAUSE_RULES 默认根因规则（4 条）
 * - T4. 关键常量值校验（BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD=3 等）
 * - T5. HEALTH_SCORE_WEIGHTS 健康度权重
 * - T6. LONG_HORIZON_DEFAULTS 默认值
 * - T7. 接口字段定义（通过构造样例对象验证 TypeScript 类型推导正确）
 * - T8. 类型复用导出（LoopType / LoopEvent / LoopRunReport）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 不涉及业务逻辑，仅校验数据模型与常量
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.9 数据模型
 * - EAG 方案 §5.12.4 G-A6d 配置冻结
 * - eag/long-horizon/types.ts 源文件
 *
 * @module core/tests/eag-long-horizon-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_STATE_STATUSES,
  MULTI_LOOP_NODE_STATUSES,
  LOOP_PHASES,
  DEFAULT_LOOP_TRANSITIONS,
  ROOT_CAUSE_SOURCES,
  SOLUTION_COSTS,
  DEFAULT_ROOT_CAUSE_RULES,
  BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD,
  LLM_INFERRED_CONFIDENCE_CAP,
  MULTI_LOOP_FINAL_STATUSES,
  MULTI_LOOP_NODE_FINAL_STATUSES,
  DEFAULT_MAX_MULTI_LOOP_ITERATIONS,
  DEFAULT_RUN_STATE_DIR,
  DEFAULT_MILESTONE_TAG_PREFIX,
  HEALTH_SCORE_WEIGHTS,
  LONG_HORIZON_DEFAULTS,
} from "../eag/long-horizon/types";
import type {
  RunState,
  MilestoneRecord,
  RegressionResult,
  HumanInterventionRecord,
  MultiLoopPlan,
  MultiLoopNode,
  BlockageReport,
  RootCauseHypothesis,
  SuggestedSolution,
  RequiredDecision,
  DecisionOption,
  RootCauseRule,
  DagValidationResult,
  MultiLoopRunReport,
  MultiLoopNodeResult,
  LoopType,
  LoopEvent,
  LoopRunReport,
} from "../eag/long-horizon/types";

// ============================================================================
// T1. 状态字面量联合类型常量完整性
// ============================================================================

test("T1.1 RUN_STATE_STATUSES 包含 5 种合法状态", () => {
  assert.deepEqual([...RUN_STATE_STATUSES], ["running", "paused", "completed", "failed", "human-checkpoint"]);
  assert.equal(RUN_STATE_STATUSES.length, 5);
});

test("T1.2 MULTI_LOOP_NODE_STATUSES 包含 5 种合法状态", () => {
  assert.deepEqual([...MULTI_LOOP_NODE_STATUSES], ["pending", "running", "completed", "failed", "human-checkpoint"]);
});

test("T1.3 LOOP_PHASES 包含 5 个阶段", () => {
  assert.deepEqual([...LOOP_PHASES], ["discovery", "handoff", "verification", "persistence", "scheduling"]);
});

test("T1.4 ROOT_CAUSE_SOURCES 包含 2 种来源", () => {
  assert.deepEqual([...ROOT_CAUSE_SOURCES], ["rule-based", "llm-inferred"]);
});

test("T1.5 SOLUTION_COSTS 包含 3 种成本级别", () => {
  assert.deepEqual([...SOLUTION_COSTS], ["low", "medium", "high"]);
});

test("T1.6 MULTI_LOOP_FINAL_STATUSES 包含 3 种最终状态", () => {
  assert.deepEqual([...MULTI_LOOP_FINAL_STATUSES], ["completed", "failed", "human-checkpoint"]);
});

test("T1.7 MULTI_LOOP_NODE_FINAL_STATUSES 包含 3 种节点最终状态", () => {
  assert.deepEqual([...MULTI_LOOP_NODE_FINAL_STATUSES], ["completed", "failed", "human-checkpoint"]);
});

test("T1.8 常量对象使用 Object.freeze 冻结", () => {
  assert.equal(Object.isFrozen(RUN_STATE_STATUSES), true);
  assert.equal(Object.isFrozen(MULTI_LOOP_NODE_STATUSES), true);
  assert.equal(Object.isFrozen(LOOP_PHASES), true);
  assert.equal(Object.isFrozen(ROOT_CAUSE_SOURCES), true);
  assert.equal(Object.isFrozen(SOLUTION_COSTS), true);
  assert.equal(Object.isFrozen(MULTI_LOOP_FINAL_STATUSES), true);
  assert.equal(Object.isFrozen(MULTI_LOOP_NODE_FINAL_STATUSES), true);
});

// ============================================================================
// T2. 默认 Loop 转换规则
// ============================================================================

test("T2.1 DEFAULT_LOOP_TRANSITIONS 包含 DESIGN → CODING → TESTING → DESIGN 转换", () => {
  assert.equal(DEFAULT_LOOP_TRANSITIONS.length, 3);
  // 第 1 条：DESIGN → CODING（需 spec 批准 + 用户检查点，非自动）
  assert.equal(DEFAULT_LOOP_TRANSITIONS[0].from, "design");
  assert.equal(DEFAULT_LOOP_TRANSITIONS[0].to, "coding");
  assert.equal(DEFAULT_LOOP_TRANSITIONS[0].automatic, false);
  // 第 2 条：CODING → TESTING（G-5 通过即自动）
  assert.equal(DEFAULT_LOOP_TRANSITIONS[1].from, "coding");
  assert.equal(DEFAULT_LOOP_TRANSITIONS[1].to, "testing");
  assert.equal(DEFAULT_LOOP_TRANSITIONS[1].automatic, true);
  // 第 3 条：TESTING → DESIGN（G-7 失败需用户检查点重新设计）
  assert.equal(DEFAULT_LOOP_TRANSITIONS[2].from, "testing");
  assert.equal(DEFAULT_LOOP_TRANSITIONS[2].to, "design");
  assert.equal(DEFAULT_LOOP_TRANSITIONS[2].automatic, false);
});

test("T2.2 DEFAULT_LOOP_TRANSITIONS 已冻结", () => {
  assert.equal(Object.isFrozen(DEFAULT_LOOP_TRANSITIONS), true);
});

// ============================================================================
// T3. 默认根因规则（DEFAULT_ROOT_CAUSE_RULES）
// ============================================================================

test("T3.1 DEFAULT_ROOT_CAUSE_RULES 包含 4 条规则", () => {
  assert.equal(DEFAULT_ROOT_CAUSE_RULES.length, 4);
  // 验证规则 ID 唯一
  const ids = DEFAULT_ROOT_CAUSE_RULES.map((r) => r.ruleId);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 4, "规则 ID 应唯一");
});

test("T3.2 DEFAULT_ROOT_CAUSE_RULES 包含 rc-001 ~ rc-004", () => {
  const ids = DEFAULT_ROOT_CAUSE_RULES.map((r) => r.ruleId);
  assert.ok(ids.includes("rc-001"), "应包含 rc-001");
  assert.ok(ids.includes("rc-002"), "应包含 rc-002");
  assert.ok(ids.includes("rc-003"), "应包含 rc-003");
  assert.ok(ids.includes("rc-004"), "应包含 rc-004");
});

test("T3.3 规则置信度在 [0.6, 0.8] 范围内", () => {
  for (const rule of DEFAULT_ROOT_CAUSE_RULES) {
    assert.ok(
      rule.confidence >= 0.6 && rule.confidence <= 0.8,
      `规则 ${rule.ruleId} 置信度 ${rule.confidence} 不在 [0.6, 0.8] 范围内`
    );
  }
});

test("T3.4 DEFAULT_ROOT_CAUSE_RULES 已冻结", () => {
  assert.equal(Object.isFrozen(DEFAULT_ROOT_CAUSE_RULES), true);
});

test("T3.5 rc-001 规则字段完整性（ruleId/pattern/description/confidence）", () => {
  const rc001 = DEFAULT_ROOT_CAUSE_RULES.find((r) => r.ruleId === "rc-001");
  assert.ok(rc001, "rc-001 应存在");
  assert.equal(rc001.pattern, "same-redline-3-failures");
  assert.equal(rc001.confidence, 0.8);
  assert.ok(rc001.description.length > 0, "描述应非空");
});

// ============================================================================
// T4. 关键常量值校验
// ============================================================================

test("T4.1 BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD = 3", () => {
  assert.equal(BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD, 3);
});

test("T4.2 LLM_INFERRED_CONFIDENCE_CAP = 0.6", () => {
  assert.equal(LLM_INFERRED_CONFIDENCE_CAP, 0.6);
});

test("T4.3 DEFAULT_MAX_MULTI_LOOP_ITERATIONS = 30", () => {
  assert.equal(DEFAULT_MAX_MULTI_LOOP_ITERATIONS, 30);
});

test("T4.4 DEFAULT_RUN_STATE_DIR = '.eag/run-state'", () => {
  assert.equal(DEFAULT_RUN_STATE_DIR, ".eag/run-state");
});

test("T4.5 DEFAULT_MILESTONE_TAG_PREFIX = 'eag'", () => {
  assert.equal(DEFAULT_MILESTONE_TAG_PREFIX, "eag");
});

// ============================================================================
// T5. HEALTH_SCORE_WEIGHTS 健康度权重
// ============================================================================

test("T5.1 HEALTH_SCORE_WEIGHTS 含 testPassRate/redlinePassRate/coverageRate 三个字段", () => {
  assert.ok(typeof HEALTH_SCORE_WEIGHTS.testPassRate === "number");
  assert.ok(typeof HEALTH_SCORE_WEIGHTS.redlinePassRate === "number");
  assert.ok(typeof HEALTH_SCORE_WEIGHTS.coverageRate === "number");
});

test("T5.2 HEALTH_SCORE_WEIGHTS 权重总和为 1.0", () => {
  const sum =
    HEALTH_SCORE_WEIGHTS.testPassRate + HEALTH_SCORE_WEIGHTS.redlinePassRate + HEALTH_SCORE_WEIGHTS.coverageRate;
  // 浮点数比较使用精度容差
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `权重总和应为 1.0，实际为 ${sum}`);
});

test("T5.3 HEALTH_SCORE_WEIGHTS 字段值符合设计文档 §4.15", () => {
  assert.equal(HEALTH_SCORE_WEIGHTS.testPassRate, 0.5);
  assert.equal(HEALTH_SCORE_WEIGHTS.redlinePassRate, 0.3);
  assert.equal(HEALTH_SCORE_WEIGHTS.coverageRate, 0.2);
});

test("T5.4 HEALTH_SCORE_WEIGHTS 已冻结", () => {
  assert.equal(Object.isFrozen(HEALTH_SCORE_WEIGHTS), true);
});

// ============================================================================
// T6. LONG_HORIZON_DEFAULTS 默认值
// ============================================================================

test("T6.1 LONG_HORIZON_DEFAULTS 含必要字段", () => {
  assert.ok(typeof LONG_HORIZON_DEFAULTS.maxMultiLoopIterations === "number");
  assert.ok(typeof LONG_HORIZON_DEFAULTS.runStateDir === "string");
  assert.ok(typeof LONG_HORIZON_DEFAULTS.milestoneTagPrefix === "string");
  assert.ok(typeof LONG_HORIZON_DEFAULTS.blockageTriggerThreshold === "number");
  assert.ok(typeof LONG_HORIZON_DEFAULTS.llmInferredConfidenceCap === "number");
  assert.ok(typeof LONG_HORIZON_DEFAULTS.healthScoreWeights === "object");
});

test("T6.2 LONG_HORIZON_DEFAULTS 字段值与其他常量一致", () => {
  assert.equal(LONG_HORIZON_DEFAULTS.maxMultiLoopIterations, DEFAULT_MAX_MULTI_LOOP_ITERATIONS);
  assert.equal(LONG_HORIZON_DEFAULTS.runStateDir, DEFAULT_RUN_STATE_DIR);
  assert.equal(LONG_HORIZON_DEFAULTS.milestoneTagPrefix, DEFAULT_MILESTONE_TAG_PREFIX);
  assert.equal(LONG_HORIZON_DEFAULTS.blockageTriggerThreshold, BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD);
  assert.equal(LONG_HORIZON_DEFAULTS.llmInferredConfidenceCap, LLM_INFERRED_CONFIDENCE_CAP);
});

test("T6.3 LONG_HORIZON_DEFAULTS 已冻结", () => {
  assert.equal(Object.isFrozen(LONG_HORIZON_DEFAULTS), true);
});

// ============================================================================
// T7. 接口字段定义（通过构造样例对象验证 TypeScript 类型推导正确）
// ============================================================================

test("T7.1 RunState 接口字段构造", () => {
  const runState: RunState = {
    runId: "test-run-001",
    projectRoot: "/tmp/test",
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    currentLoop: "design",
    currentIteration: 0,
    completedLoops: [],
    completedTaskIds: [],
    pendingDeleteFiles: [],
    milestones: [],
    humanInterventions: [],
    humanInterventionCount: 0,
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    status: "running",
    checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
  assert.equal(runState.runId, "test-run-001");
  assert.equal(runState.status, "running");
  assert.equal(runState.milestones.length, 0);
  assert.equal(runState.humanInterventionCount, 0);
});

test("T7.2 MilestoneRecord 接口字段构造", () => {
  const milestone: MilestoneRecord = {
    index: 1,
    name: "DESIGN Loop 完成",
    loopType: "design",
    completedAt: "2026-07-19T10:23:00.000Z",
    tagName: "eag/test-run-001/m1",
    commitSha: "abc123def456",
    regressionResult: {
      totalTests: 50,
      passedTests: 50,
      failedTests: 0,
      exitCode: 0,
      durationSec: 12.5,
    },
    healthScore: 0.95,
  };
  assert.equal(milestone.index, 1);
  assert.equal(milestone.tagName, "eag/test-run-001/m1");
  assert.equal(milestone.regressionResult?.passedTests, 50);
  assert.equal(milestone.healthScore, 0.95);
});

test("T7.3 RegressionResult 接口字段构造", () => {
  const regression: RegressionResult = {
    totalTests: 10,
    passedTests: 7,
    failedTests: 3,
    exitCode: 1,
    durationSec: 5.0,
  };
  assert.equal(regression.totalTests, 10);
  assert.equal(regression.failedTests, 3);
  assert.equal(regression.exitCode, 1);
});

test("T7.4 HumanInterventionRecord 接口字段构造", () => {
  const intervention: HumanInterventionRecord = {
    intervenedAt: "2026-07-19T10:30:00.000Z",
    loopType: "coding",
    reason: "FIX 失败 3 次",
    decision: "放宽 E7 评估器规则",
    resolved: false,
  };
  assert.equal(intervention.intervenedAt, "2026-07-19T10:30:00.000Z");
  assert.equal(intervention.loopType, "coding");
  assert.equal(intervention.resolved, false);
});

test("T7.5 MultiLoopNode 接口字段构造", () => {
  const node: MultiLoopNode = {
    nodeId: "design-1",
    loopType: "design",
    dependencies: [],
    status: "pending",
    entryArtifact: "用户需求",
    exitCriteria: "spec 批准",
  };
  assert.equal(node.nodeId, "design-1");
  assert.equal(node.loopType, "design");
});

test("T7.6 MultiLoopPlan 接口字段构造", () => {
  const plan: MultiLoopPlan = {
    planId: "test-plan-001",
    projectRoot: "/tmp/test",
    loops: [
      {
        nodeId: "design-1",
        loopType: "design",
        dependencies: [],
        status: "pending",
        entryArtifact: "用户需求",
        exitCriteria: "spec 批准",
      },
    ],
    autoTransition: true,
    rollbackOnFailure: true,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
  assert.equal(plan.planId, "test-plan-001");
  assert.equal(plan.loops.length, 1);
  assert.equal(plan.autoTransition, true);
});

test("T7.7 BlockageReport 接口字段构造", () => {
  const report: BlockageReport = {
    runId: "test-run-001",
    generatedAt: "2026-07-19T11:00:00.000Z",
    blockedLoop: "coding",
    blockedIteration: 5,
    rootCauseHypotheses: [],
    suggestedSolutions: [],
    requiredDecisions: [],
    relatedInterventions: [],
  };
  assert.equal(report.runId, "test-run-001");
  assert.equal(report.blockedLoop, "coding");
  assert.equal(report.rootCauseHypotheses.length, 0);
});

test("T7.8 RootCauseHypothesis 接口字段构造", () => {
  const hypothesis: RootCauseHypothesis = {
    hypothesisId: "rc-001",
    description: "同一红线 E1 反复出现",
    confidence: 0.8,
    evidence: ["E1 第 1 次出现", "E1 第 2 次出现"],
    source: "rule-based",
  };
  assert.equal(hypothesis.hypothesisId, "rc-001");
  assert.equal(hypothesis.source, "rule-based");
  assert.equal(hypothesis.evidence.length, 2);
});

test("T7.9 SuggestedSolution 接口字段构造", () => {
  const solution: SuggestedSolution = {
    solutionId: "sol-001",
    description: "放宽 E7 评估器规则",
    targetHypothesisId: "rc-001",
    rlisRuleId: "SEED-01",
    expectedEffect: "评估器规则放宽后可能放过贫血模型",
    cost: "low",
  };
  assert.equal(solution.solutionId, "sol-001");
  assert.equal(solution.cost, "low");
  assert.equal(solution.targetHypothesisId, "rc-001");
});

test("T7.10 RequiredDecision 接口字段构造", () => {
  const decision: RequiredDecision = {
    decisionId: "dec-001",
    description: "是否放宽 E7 评估器规则",
    options: [
      { optionId: "opt-1", description: "维持现状", impact: "可能继续失败" },
      { optionId: "opt-2", description: "放宽规则", impact: "可能放过贫血模型" },
    ],
    recommendedOptionId: "opt-2",
  };
  assert.equal(decision.decisionId, "dec-001");
  assert.equal(decision.options.length, 2);
  assert.equal(decision.recommendedOptionId, "opt-2");
});

test("T7.11 DecisionOption 接口字段构造", () => {
  const option: DecisionOption = {
    optionId: "opt-1",
    description: "维持现状",
    impact: "可能继续失败",
  };
  assert.equal(option.optionId, "opt-1");
  assert.ok(option.description.length > 0);
});

test("T7.12 RootCauseRule 接口字段构造", () => {
  const rule: RootCauseRule = {
    ruleId: "rc-custom-001",
    pattern: "custom-pattern",
    description: "自定义规则",
    confidence: 0.7,
  };
  assert.equal(rule.ruleId, "rc-custom-001");
  assert.equal(rule.confidence, 0.7);
});

test("T7.13 DagValidationResult 接口字段构造", () => {
  const result: DagValidationResult = {
    valid: true,
    cycles: [],
    unreachableNodes: [],
  };
  assert.equal(result.valid, true);
  assert.equal(result.cycles.length, 0);
  assert.equal(result.unreachableNodes.length, 0);
});

test("T7.14 MultiLoopRunReport 接口字段构造", () => {
  const report: MultiLoopRunReport = {
    planId: "test-plan-001",
    nodeResults: [],
    finalStatus: "completed",
    totalIterations: 3,
    totalLlmCallCount: 10,
    totalTokensUsed: 5000,
    durationSec: 120.5,
  };
  assert.equal(report.planId, "test-plan-001");
  assert.equal(report.finalStatus, "completed");
});

test("T7.15 MultiLoopNodeResult 接口字段构造", () => {
  const result: MultiLoopNodeResult = {
    nodeId: "design-1",
    loopType: "design",
    status: "completed",
  };
  assert.equal(result.nodeId, "design-1");
  assert.equal(result.status, "completed");
});

// ============================================================================
// T8. 类型复用导出验证
// ============================================================================

test("T8.1 LoopType 类型复用导出（编译期类型校验）", () => {
  // 通过类型注解验证 LoopType 已正确导出
  const loopType: LoopType = "design";
  assert.equal(loopType, "design");
});

test("T8.2 LoopEvent 类型复用导出（编译期类型校验）", () => {
  const event: LoopEvent = {
    eventId: "evt-001",
    eventType: "discovery_started",
    phase: "discovery",
    runId: "run-001",
    iterIndex: 0,
    payload: {},
    timestamp: "2026-07-19T00:00:00.000Z",
  };
  assert.equal(event.eventId, "evt-001");
});

test("T8.3 LoopRunReport 类型复用导出（编译期类型校验）", () => {
  const report: LoopRunReport = {
    runId: "run-001",
    loopType: "coding",
    objective: "test",
    totalIterations: 1,
    finalStatus: "completed",
    events: [],
    tokenUsed: 100,
    durationSec: 5.0,
    committedCount: 1,
    humanCheckpoints: [],
    finalSummary: "test summary",
  };
  assert.equal(report.runId, "run-001");
  assert.equal(report.finalStatus, "completed");
});
