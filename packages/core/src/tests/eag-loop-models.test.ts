/**
 * EAG-P1 单元测试：Loop Engineering 核心数据模型
 *
 * 测试范围：
 * - A. 枚举值完整性（LoopType / DiscoveryMode / EvaluatorMode / LoopEventType / SchedulingAction）
 * - B. LoopEngineeringConfig 默认值与自定义覆盖
 * - C. 配置校验（maxIterations<1 抛错 / maxTokens<1 抛错 / samplingReadRatio 范围校验 / humanCheckpointEvery 负数校验）
 * - D. 各 dataclass 接口字段完整性（DiscoveryResult / HandoffItem / SchedulingDecision / LoopCycleResult / LoopRunReport）
 * - E. 配置冻结保证（Object.isFrozen）
 * - F. 命名冲突说明（LoopEvaluationVerdict 与 P0 EvaluationVerdict 的关系）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.2.1 五步闭环数据模型
 * - multi-agent-team skill scripts/loop_engineering/models.py（移植母本）
 * - eag/loop/models.ts 源文件（被测对象）
 *
 * @module core/tests/eag-loop-models
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  // 枚举常量
  LOOP_TYPES,
  DISCOVERY_MODES,
  EVALUATOR_MODES,
  LOOP_EVENT_TYPES,
  SCHEDULING_ACTIONS,
  DEFAULT_STAGE_ORDER,
  DEFAULT_LOOP_ENGINEERING_CONFIG,
  // 工厂函数与错误类
  createLoopEngineeringConfig,
  LoopEngineeringConfigError,
  // 类型导入（用于接口字段完整性测试）
  type LoopType,
  type DiscoveryMode,
  type EvaluatorMode,
  type LoopEventType,
  type SchedulingAction,
  type LoopEngineeringConfig,
  type DiscoveryResult,
  type HandoffItem,
  type LoopEvaluationVerdict,
  type LoopEvent,
  type MemoryQuery,
  type SchedulingDecision,
  type HumanCheckpointResponse,
  type LoopCycleResult,
  type LoopRunReport,
  type GeneratorResult,
  type VerdictSeverity,
  type LogCallback,
} from "../eag/loop/models";

// ============================================================================
// A. 枚举值完整性测试
// ============================================================================

test("A1. LOOP_TYPES 包含 design / coding / testing / deploy 四种类型（批次 13 新增 deploy）", () => {
  assert.deepEqual([...LOOP_TYPES], ["design", "coding", "testing", "deploy"]);
});

test("A2. DISCOVERY_MODES 包含 auto / manual / off 三种模式", () => {
  assert.deepEqual([...DISCOVERY_MODES], ["auto", "manual", "off"]);
});

test("A3. EVALUATOR_MODES 包含 strict / standard / off 三种模式", () => {
  assert.deepEqual([...EVALUATOR_MODES], ["strict", "standard", "off"]);
});

test("A4. LOOP_EVENT_TYPES 包含 12 种事件类型", () => {
  assert.equal(LOOP_EVENT_TYPES.length, 12);
  // 验证五步闭环 + 终态的全部事件
  const expectedEvents: LoopEventType[] = [
    "discovery_started",
    "discovery_completed",
    "handoff_created",
    "handoff_dispatched",
    "verification_started",
    "verification_rejected",
    "verification_passed",
    "persistence_written",
    "scheduling_decision",
    "human_checkpoint",
    "loop_completed",
    "loop_failed",
  ];
  assert.deepEqual([...LOOP_EVENT_TYPES], expectedEvents);
});

test("A5. SCHEDULING_ACTIONS 包含 5 种决策动作", () => {
  assert.equal(SCHEDULING_ACTIONS.length, 5);
  const expectedActions: SchedulingAction[] = ["continue", "fix", "human_checkpoint", "stop_success", "stop_failure"];
  assert.deepEqual([...SCHEDULING_ACTIONS], expectedActions);
});

test("A6. 枚举常量均已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(LOOP_TYPES));
  assert.ok(Object.isFrozen(DISCOVERY_MODES));
  assert.ok(Object.isFrozen(EVALUATOR_MODES));
  assert.ok(Object.isFrozen(LOOP_EVENT_TYPES));
  assert.ok(Object.isFrozen(SCHEDULING_ACTIONS));
});

// ============================================================================
// B. LoopEngineeringConfig 默认值与自定义覆盖
// ============================================================================

test("B1. DEFAULT_LOOP_ENGINEERING_CONFIG 默认值与 Python 母本一致", () => {
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.loopType, "coding");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.discoveryMode, "auto");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.evaluatorMode, "strict");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.maxIterations, 50);
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.maxTokens, 500_000);
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.humanCheckpointEvery, 5);
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.samplingReadRatio, 0.1);
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.stopWhen, "");
  assert.deepEqual([...DEFAULT_LOOP_ENGINEERING_CONFIG.stageOrder], ["plan", "dev", "verify", "fix"]);
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.projectRoot, ".");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.runDir, ".gnhf/runs");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.notesPath, "notes.md");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.testCommand, "python3 -m unittest discover -s tests -p 'test_*.py'");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.testTimeoutSec, 600.0);
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.securityAnalyzer, "builtin");
  assert.equal(DEFAULT_LOOP_ENGINEERING_CONFIG.autoCommit, true);
});

test("B2. DEFAULT_LOOP_ENGINEERING_CONFIG 已冻结", () => {
  assert.ok(Object.isFrozen(DEFAULT_LOOP_ENGINEERING_CONFIG));
});

test("B3. DEFAULT_STAGE_ORDER 默认阶段顺序为 plan/dev/verify/fix", () => {
  assert.deepEqual([...DEFAULT_STAGE_ORDER], ["plan", "dev", "verify", "fix"]);
  assert.ok(Object.isFrozen(DEFAULT_STAGE_ORDER));
});

test("B4. createLoopEngineeringConfig 无参数返回默认配置（冻结）", () => {
  const config = createLoopEngineeringConfig();
  assert.equal(config.maxIterations, 50);
  assert.equal(config.maxTokens, 500_000);
  assert.equal(config.loopType, "coding");
  assert.ok(Object.isFrozen(config));
});

test("B5. createLoopEngineeringConfig 支持部分字段覆盖", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    loopType: "design",
    stopWhen: "完成所有用户故事",
  });
  assert.equal(config.maxIterations, 10);
  assert.equal(config.loopType, "design");
  assert.equal(config.stopWhen, "完成所有用户故事");
  // 未覆盖字段保持默认值
  assert.equal(config.maxTokens, 500_000);
  assert.equal(config.evaluatorMode, "strict");
});

test("B6. createLoopEngineeringConfig extra 字段支持浅合并", () => {
  const config = createLoopEngineeringConfig({
    extra: { backoff_base_sec: 2.0, custom_key: "value" },
  });
  assert.equal(config.extra.backoff_base_sec, 2.0);
  assert.equal(config.extra.custom_key, "value");
});

test("B7. createLoopEngineeringConfig stageOrder 接受数组并冻结", () => {
  const config = createLoopEngineeringConfig({
    stageOrder: ["analyze", "implement", "test"],
  });
  assert.deepEqual([...config.stageOrder], ["analyze", "implement", "test"]);
  assert.ok(Object.isFrozen(config.stageOrder));
});

// ============================================================================
// C. 配置校验测试
// ============================================================================

test("C1. createLoopEngineeringConfig maxIterations<1 抛 LoopEngineeringConfigError", () => {
  assert.throws(
    () => createLoopEngineeringConfig({ maxIterations: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof LoopEngineeringConfigError);
      assert.equal((err as LoopEngineeringConfigError).field, "maxIterations");
      return true;
    }
  );
});

test("C2. createLoopEngineeringConfig maxIterations 负数抛错", () => {
  assert.throws(() => createLoopEngineeringConfig({ maxIterations: -5 }), LoopEngineeringConfigError);
});

test("C3. createLoopEngineeringConfig maxTokens<1 抛 LoopEngineeringConfigError", () => {
  assert.throws(
    () => createLoopEngineeringConfig({ maxTokens: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof LoopEngineeringConfigError);
      assert.equal((err as LoopEngineeringConfigError).field, "maxTokens");
      return true;
    }
  );
});

test("C4. createLoopEngineeringConfig samplingReadRatio<0 抛错", () => {
  assert.throws(() => createLoopEngineeringConfig({ samplingReadRatio: -0.1 }), LoopEngineeringConfigError);
});

test("C5. createLoopEngineeringConfig samplingReadRatio>1 抛错", () => {
  assert.throws(() => createLoopEngineeringConfig({ samplingReadRatio: 1.5 }), LoopEngineeringConfigError);
});

test("C6. createLoopEngineeringConfig samplingReadRatio 边界值 0 与 1 合法", () => {
  // 边界值合法（Python 母本行为：[0, 1] 闭区间）
  const config0 = createLoopEngineeringConfig({ samplingReadRatio: 0.0 });
  assert.equal(config0.samplingReadRatio, 0.0);
  const config1 = createLoopEngineeringConfig({ samplingReadRatio: 1.0 });
  assert.equal(config1.samplingReadRatio, 1.0);
});

test("C7. createLoopEngineeringConfig humanCheckpointEvery 负数抛错", () => {
  assert.throws(() => createLoopEngineeringConfig({ humanCheckpointEvery: -1 }), LoopEngineeringConfigError);
});

test("C8. createLoopEngineeringConfig humanCheckpointEvery=0 合法（关闭）", () => {
  const config = createLoopEngineeringConfig({ humanCheckpointEvery: 0 });
  assert.equal(config.humanCheckpointEvery, 0);
});

test("C9. LoopEngineeringConfigError 包含 field / value / reason 字段", () => {
  try {
    createLoopEngineeringConfig({ maxIterations: -1 });
    assert.fail("应抛出 LoopEngineeringConfigError");
  } catch (err) {
    assert.ok(err instanceof LoopEngineeringConfigError);
    const e = err as LoopEngineeringConfigError;
    assert.equal(e.field, "maxIterations");
    assert.equal(e.value, -1);
    assert.ok(e.reason.includes(">= 1"));
    assert.ok(e.message.includes("maxIterations"));
    assert.equal(e.name, "LoopEngineeringConfigError");
  }
});

// ============================================================================
// D. 各 dataclass 接口字段完整性测试
// ============================================================================

test("D1. DiscoveryResult 接口字段完整性", () => {
  const result: DiscoveryResult = {
    objective: "实现用户登录",
    inputs: { raw: "需求文本" },
    contextFeatures: { language: "TypeScript" },
    relevantSkills: ["eag-domain-modeling"],
    detectedRisks: ["跨聚合写"],
    inferredGoal: "User can login with email and password",
    worktreeRequired: true,
    suggestedAgents: ["architect"],
    suggestedPatterns: ["saga-orchestration"],
    artifactsToRead: ["docs/architecture.md"],
    timestamp: "2026-07-18T00:00:00.000Z",
  };
  assert.equal(result.objective, "实现用户登录");
  assert.equal(result.inputs.raw, "需求文本");
  assert.equal(result.contextFeatures.language, "TypeScript");
  assert.equal(result.relevantSkills.length, 1);
  assert.equal(result.detectedRisks[0], "跨聚合写");
  assert.equal(result.inferredGoal, "User can login with email and password");
  assert.equal(result.worktreeRequired, true);
  assert.equal(result.suggestedAgents[0], "architect");
  assert.equal(result.suggestedPatterns[0], "saga-orchestration");
  assert.equal(result.artifactsToRead[0], "docs/architecture.md");
  assert.equal(result.timestamp, "2026-07-18T00:00:00.000Z");
});

test("D2. HandoffItem 接口字段完整性", () => {
  const item: HandoffItem = {
    itemId: "wi-001",
    agentType: "solo-coder",
    task: "实现 User 聚合根",
    acceptanceCriteria: ["User.email 必须校验格式", "User.password 必须哈希存储"],
    worktreePath: "/tmp/worktree-1",
    dependencies: [],
    metadata: { priority: "high" },
  };
  assert.equal(item.itemId, "wi-001");
  assert.equal(item.agentType, "solo-coder");
  assert.equal(item.task, "实现 User 聚合根");
  assert.equal(item.acceptanceCriteria.length, 2);
  assert.equal(item.worktreePath, "/tmp/worktree-1");
  assert.equal(item.dependencies.length, 0);
  assert.equal(item.metadata.priority, "high");
});

test("D3. HandoffItem worktreePath 支持 null（不使用 worktree）", () => {
  const item: HandoffItem = {
    itemId: "wi-002",
    agentType: "architect",
    task: "设计架构",
    acceptanceCriteria: [],
    worktreePath: null,
    dependencies: [],
    metadata: {},
  };
  assert.equal(item.worktreePath, null);
});

test("D4. LoopEvaluationVerdict 接口字段完整性", () => {
  const verdict: LoopEvaluationVerdict = {
    passed: false,
    evaluatorId: "independent-evaluator",
    reason: "STRICT 模式下发现 2 个问题",
    findings: ["测试未通过", "缺少安全扫描指标"],
    severity: "blocker",
    suggestedFix: "请修复上述问题后重试",
    sampledArtifacts: ["src/user.ts", "src/auth.ts"],
  };
  assert.equal(verdict.passed, false);
  assert.equal(verdict.evaluatorId, "independent-evaluator");
  assert.equal(verdict.reason, "STRICT 模式下发现 2 个问题");
  assert.equal(verdict.findings.length, 2);
  assert.equal(verdict.severity, "blocker");
  assert.equal(verdict.suggestedFix, "请修复上述问题后重试");
  assert.equal(verdict.sampledArtifacts.length, 2);
});

test("D5. LoopEvent 接口字段完整性", () => {
  const event: LoopEvent = {
    eventId: "evt-abcdef12",
    eventType: "discovery_started",
    phase: "discovery",
    runId: "run12345abcdef",
    iterIndex: 0,
    payload: { objective: "test" },
    timestamp: "2026-07-18T00:00:00.000Z",
  };
  assert.equal(event.eventId, "evt-abcdef12");
  assert.equal(event.eventType, "discovery_started");
  assert.equal(event.phase, "discovery");
  assert.equal(event.runId, "run12345abcdef");
  assert.equal(event.iterIndex, 0);
  assert.equal(event.payload.objective, "test");
});

test("D6. MemoryQuery 接口字段完整性（四种查询类型）", () => {
  const query: MemoryQuery = {
    queryType: "recent",
    filters: { event_type: "verification_passed" },
    limit: 10,
    section: null,
    minSimilarity: 0.0,
    objective: "",
  };
  assert.equal(query.queryType, "recent");
  assert.equal(query.filters.event_type, "verification_passed");
  assert.equal(query.limit, 10);
  assert.equal(query.section, null);
});

test("D7. SchedulingDecision 接口字段完整性", () => {
  const decision: SchedulingDecision = {
    action: "fix",
    reason: "验证未通过：测试失败",
    nextLoopType: null,
    nextStageOrder: null,
    backoffSeconds: 2.5,
    requiresHumanInput: false,
  };
  assert.equal(decision.action, "fix");
  assert.equal(decision.reason, "验证未通过：测试失败");
  assert.equal(decision.nextLoopType, null);
  assert.equal(decision.nextStageOrder, null);
  assert.equal(decision.backoffSeconds, 2.5);
  assert.equal(decision.requiresHumanInput, false);
});

test("D8. HumanCheckpointResponse 接口字段完整性", () => {
  const response: HumanCheckpointResponse = {
    approved: true,
    feedback: "自动批准",
    abort: false,
  };
  assert.equal(response.approved, true);
  assert.equal(response.feedback, "自动批准");
  assert.equal(response.abort, false);
});

test("D9. LoopCycleResult 接口字段完整性", () => {
  const cycle: LoopCycleResult = {
    iterIndex: 0,
    discovery: {
      objective: "test",
      inputs: {},
      contextFeatures: {},
      relevantSkills: [],
      detectedRisks: [],
      inferredGoal: "",
      worktreeRequired: false,
      suggestedAgents: [],
      suggestedPatterns: [],
      artifactsToRead: [],
      timestamp: "2026-07-18T00:00:00.000Z",
    },
    handoffItems: [],
    generatorResult: { success: true },
    verdict: {
      passed: true,
      evaluatorId: "test-evaluator",
      reason: "通过",
      findings: [],
      severity: "info",
      suggestedFix: "",
      sampledArtifacts: [],
    },
    events: [],
    tokenUsed: 1000,
    durationSec: 1.5,
    schedulingDecision: {
      action: "stop_success",
      reason: "满足停止条件",
      nextLoopType: null,
      nextStageOrder: null,
      backoffSeconds: 0,
      requiresHumanInput: false,
    },
  };
  assert.equal(cycle.iterIndex, 0);
  assert.equal(cycle.discovery.objective, "test");
  assert.equal(cycle.generatorResult.success, true);
  assert.equal(cycle.verdict.passed, true);
  assert.equal(cycle.tokenUsed, 1000);
  assert.equal(cycle.durationSec, 1.5);
  assert.equal(cycle.schedulingDecision.action, "stop_success");
});

test("D10. LoopRunReport 接口字段完整性（含三种 finalStatus 取值）", () => {
  const report: LoopRunReport = {
    runId: "run-001",
    loopType: "coding",
    objective: "实现用户登录",
    totalIterations: 3,
    finalStatus: "completed",
    events: [],
    tokenUsed: 5000,
    durationSec: 12.5,
    committedCount: 1,
    humanCheckpoints: [],
    finalSummary: "Loop Engineering 运行报告\n",
  };
  assert.equal(report.runId, "run-001");
  assert.equal(report.loopType, "coding");
  assert.equal(report.totalIterations, 3);
  assert.equal(report.finalStatus, "completed");
  assert.equal(report.tokenUsed, 5000);
  assert.equal(report.committedCount, 1);
});

test("D11. LoopRunReport finalStatus 支持 failed 与 aborted", () => {
  const failed: LoopRunReport = {
    runId: "r1",
    loopType: "design",
    objective: "",
    totalIterations: 5,
    finalStatus: "failed",
    events: [],
    tokenUsed: 0,
    durationSec: 0,
    committedCount: 0,
    humanCheckpoints: [],
    finalSummary: "",
  };
  assert.equal(failed.finalStatus, "failed");
  const aborted: LoopRunReport = { ...failed, finalStatus: "aborted" };
  assert.equal(aborted.finalStatus, "aborted");
});

test("D12. GeneratorResult 类型为 Record<string, unknown>（约定字段）", () => {
  // GeneratorResult 是 Generator 执行结果，约定字段：success / test_result / lint_result 等
  const result: GeneratorResult = {
    success: true,
    test_result: { passed: true, summary: "10/10 通过" },
    lint_result: { passed: true, summary: "无 lint 错误" },
    security_result: { severity: "info", summary: "无安全问题" },
    modified_files: ["src/user.ts"],
    committed_count: 1,
  };
  assert.equal(result.success, true);
  assert.deepEqual(result.test_result, { passed: true, summary: "10/10 通过" });
  assert.deepEqual(result.modified_files, ["src/user.ts"]);
});

test("D13. VerdictSeverity 类型支持 info / warning / blocker", () => {
  const info: VerdictSeverity = "info";
  const warning: VerdictSeverity = "warning";
  const blocker: VerdictSeverity = "blocker";
  assert.equal(info, "info");
  assert.equal(warning, "warning");
  assert.equal(blocker, "blocker");
});

test("D14. LogCallback 类型支持 null 与函数", () => {
  const noLog: LogCallback = null;
  const withLog: LogCallback = (msg, level) => {
    return `${level}: ${msg}`;
  };
  assert.equal(noLog, null);
  assert.equal(typeof withLog, "function");
  assert.equal(withLog("test", "INFO"), "INFO: test");
});

// ============================================================================
// E. 配置冻结保证
// ============================================================================

test("E1. createLoopEngineeringConfig 返回的对象在严格模式下不可修改", () => {
  const config = createLoopEngineeringConfig();
  assert.ok(Object.isFrozen(config));
  // 在严格模式下修改冻结对象会抛错（tsx 运行时为严格模式）
  assert.throws(() => {
    (config as { maxIterations: number }).maxIterations = 999;
  }, TypeError);
});

test("E2. createLoopEngineeringConfig extra 字段不可修改", () => {
  const config = createLoopEngineeringConfig({ extra: { key: "value" } });
  assert.ok(Object.isFrozen(config.extra));
});

// ============================================================================
// F. 命名冲突说明（LoopEvaluationVerdict 与 P0 EvaluationVerdict 的关系）
// ============================================================================

test("F1. LoopEvaluationVerdict 是接口（含 passed/evaluatorId/reason 等字段），与 P0 EvaluationVerdict 字符串字面量联合不同", () => {
  // 验证 LoopEvaluationVerdict 是结构化接口（含 passed 等字段）
  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "test",
    reason: "通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };
  assert.equal(verdict.passed, true);
  assert.equal(typeof verdict, "object");
  // 注：P0 EvaluationVerdict 是 "pass"|"fix"|"human_checkpoint"|"stop_failure" 字符串字面量
  // 两者命名空间独立，由 scheduler 负责映射（passed=true → "pass"，passed=false+severity="blocker" → "fix"）
});

test("F2. LoopType 类型支持 design / coding / testing 赋值", () => {
  const design: LoopType = "design";
  const coding: LoopType = "coding";
  const testing: LoopType = "testing";
  assert.equal(design, "design");
  assert.equal(coding, "coding");
  assert.equal(testing, "testing");
});

test("F3. DiscoveryMode / EvaluatorMode 类型支持全部取值", () => {
  const dm1: DiscoveryMode = "auto";
  const dm2: DiscoveryMode = "manual";
  const dm3: DiscoveryMode = "off";
  const em1: EvaluatorMode = "strict";
  const em2: EvaluatorMode = "standard";
  const em3: EvaluatorMode = "off";
  assert.equal(dm1, "auto");
  assert.equal(dm2, "manual");
  assert.equal(dm3, "off");
  assert.equal(em1, "strict");
  assert.equal(em2, "standard");
  assert.equal(em3, "off");
});
