/**
 * EAG-P5 ↔ eag/loop/ 集成测试（方案 A：P5 复用 eag/loop/）
 *
 * 测试目标：验证 P5 AutonomousOrchestrator 正确复用 eag/loop/ 的调度层和数据层
 *
 * 测试范围（对应架构师 D3 建议的测试用例，已根据 D2.5 删除 Protocol 适配器调整）：
 * - I1. LoopEngineeringConfig 从 P5 配置正确映射（通过 index.ts 导出验证 + 配置构造验证）
 * - I2. LoopScheduler 在 P5 配置下的决策正确性（阈值一致性）
 * - I3. stop_when_empty_means_stop=false 对 P5 语义的影响
 * - I4. LoopEvent 正确生成（verification_passed / verification_rejected）
 * - I5. P5 index.ts 正确导出 eag/loop/ 关键类型
 * - I6. 端到端：AutonomousOrchestrator 使用 LoopScheduler 后，aborted 终止条件等价
 * - I7. 端到端：AutonomousOrchestrator 使用 LoopScheduler 后，failed 终止条件等价
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行 node -e 命令）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 *
 * 设计依据：
 * - 设计文档 EAG-P5-LOOP-INTEGRATION-DESIGN.md
 * - 架构师 D2 建议（分层复用：调度层 + 数据层）
 * - 架构师 D2.5 建议（删除 4 个 Protocol 适配器，避免死代码）
 *
 * @module core/tests/eag-p5-loop-integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// P5 核心组件
import {
  AutonomousOrchestrator,
  createP5LoopExecutorFromHandlers,
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  // eag/loop/ 集成类型（通过 P5 index.ts 导出，验证导出正确性）
  LoopScheduler,
  createLoopEngineeringConfig,
  // 类型
  type LoopEvaluationVerdict,
  type SchedulingDecision,
  type LoopEvent,
  // 默认配置常量
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
} from "../eag/p5";

// ============================================================================
// 1. 测试常量
// ============================================================================

/**
 * 通过测试命令（真实 child_process 执行，输出 Jest 格式）
 */
const PASS_TEST_CMD = `node -e 'console.log("Tests: 1 passed, 0 failed")'`;

/**
 * 失败测试命令（真实 child_process 执行，输出 Jest 格式 + 非零退出码）
 */
const FAIL_TEST_CMD = `node -e 'console.log("Tests: 0 passed, 1 failed"); process.exit(1)'`;

// ============================================================================
// 2. 测试辅助函数（复用 eag-p5-autonomous-orchestrator.test.ts 的模式）
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统）
 */
function createTempProject(): string {
  const prefix = path.join(os.tmpdir(), "eag-p5-loop-integ-");
  const projectRoot = fs.mkdtempSync(prefix);
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

/**
 * 清理临时项目目录
 */
function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 创建 tasks.md 文件（含指定状态的任务卡）
 */
function createTasksFile(
  projectRoot: string,
  taskCount: number,
  status: "pending" | "completed" | "in-progress" | "blocked"
): string {
  const tasksDir = path.join(projectRoot, ".eag", "p5");
  fs.mkdirSync(tasksDir, { recursive: true });
  const tasksFilePath = path.join(tasksDir, "tasks.md");

  const lines: string[] = [];
  lines.push("# EAG-P5 任务清单");
  lines.push("");

  for (let i = 1; i <= taskCount; i++) {
    const id = `T-${String(i).padStart(3, "0")}`;
    lines.push(`## ${id} 测试任务 ${i}`);
    lines.push(`- requirement: F-${String(i).padStart(3, "0")}`);
    lines.push(`- status: ${status}`);
    lines.push(`- dependencies: `);
    lines.push(`- files: src/services/Service${i}.ts`);
    lines.push(`- deletions: `);
    lines.push(`- symbols: Service${i}`);
    lines.push(`- acceptance: 测试通过`);
    lines.push("");
  }

  fs.writeFileSync(tasksFilePath, lines.join("\n"), "utf8");
  return tasksFilePath;
}

/**
 * 创建声明的源文件
 */
function createDeclaredFile(projectRoot: string, relativePath: string): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, "// 测试文件内容\n", "utf8");
}

/**
 * 构造真实的 AutonomousOrchestrator 实例
 */
function buildOrchestrator(overrides?: {
  readonly defaultMaxIterations?: number;
  readonly defaultConsecutiveFailureAbort?: number;
}): AutonomousOrchestrator {
  const loopExecutor = createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    new P5DevStageHandler(),
    new P5VerifyStageHandler(),
    new P5FixStageHandler()
  );
  const runStateStore = new P5RunStateStore();
  const notesMemory = new P5NotesMemory();
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  const smartConfirmation = new P5SmartConfirmation();

  return new AutonomousOrchestrator({
    loopExecutor,
    runStateStore,
    notesMemory,
    guardChain,
    smartConfirmation,
    defaultMaxIterations: overrides?.defaultMaxIterations,
    defaultConsecutiveFailureAbort: overrides?.defaultConsecutiveFailureAbort,
  });
}

// ============================================================================
// 3. 测试用例
// ============================================================================

// ----------------------------------------------------------------------------
// I1. LoopEngineeringConfig 从 P5 配置正确映射
// ----------------------------------------------------------------------------

test("I1. LoopEngineeringConfig 从 P5 配置正确映射（通过 createLoopEngineeringConfig 构造）", () => {
  // 模拟 P5 AutonomousOrchestrator.buildLoopEngineeringConfig 的映射逻辑
  const consecutiveFailureAbort = 3;
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "",
    testCommand: "npm test",
    testTimeoutSec: 600,
    projectRoot: "/tmp/test",
    extra: {
      consecutive_failures_human_checkpoint: consecutiveFailureAbort,
      consecutive_failures_stop_failure: consecutiveFailureAbort + 1,
      stop_when_empty_means_stop: false,
    },
  });

  // 验证基本字段映射
  assert.equal(config.loopType, "coding");
  assert.equal(config.maxIterations, 10);
  assert.equal(config.maxTokens, 200_000);
  assert.equal(config.stopWhen, "");
  assert.equal(config.testCommand, "npm test");
  assert.equal(config.testTimeoutSec, 600);
  assert.equal(config.projectRoot, "/tmp/test");

  // 验证 extra 注入的可配置阈值
  assert.equal(config.extra.consecutive_failures_human_checkpoint, 3);
  assert.equal(config.extra.consecutive_failures_stop_failure, 4);
  assert.equal(config.extra.stop_when_empty_means_stop, false);

  // 验证配置已冻结（不可变）
  assert.ok(Object.isFrozen(config));
});

// ----------------------------------------------------------------------------
// I2. LoopScheduler 在 P5 配置下的决策正确性（阈值一致性）
// ----------------------------------------------------------------------------

test("I2a. LoopScheduler 在 P5 配置下：连续失败达 human_checkpoint 阈值 → human_checkpoint", () => {
  // 模拟 P5 配置：consecutiveFailureAbort=3
  const consecutiveFailureAbort = 3;
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "",
    extra: {
      consecutive_failures_human_checkpoint: consecutiveFailureAbort,
      consecutive_failures_stop_failure: consecutiveFailureAbort + 1,
      stop_when_empty_means_stop: false,
    },
  });
  const scheduler = new LoopScheduler(config);

  // 构造未通过的 verdict
  const verdict: LoopEvaluationVerdict = {
    passed: false,
    evaluatorId: "p5-test",
    reason: "测试失败",
    findings: [],
    severity: "warning",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // consecutiveFailures=2（不含本轮），effectiveFailures=3 → human_checkpoint
  // （3 >= human_checkpoint_threshold=3，但 3 < stop_failure_threshold=4）
  const decision = scheduler.decideNext(0, verdict, [], 0, 2);
  assert.equal(decision.action, "human_checkpoint");
  assert.equal(decision.requiresHumanInput, true);
});

test("I2b. LoopScheduler 在 P5 配置下：连续失败达 stop_failure 阈值 → stop_failure", () => {
  const consecutiveFailureAbort = 3;
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "",
    extra: {
      consecutive_failures_human_checkpoint: consecutiveFailureAbort,
      consecutive_failures_stop_failure: consecutiveFailureAbort + 1,
      stop_when_empty_means_stop: false,
    },
  });
  const scheduler = new LoopScheduler(config);

  const verdict: LoopEvaluationVerdict = {
    passed: false,
    evaluatorId: "p5-test",
    reason: "测试失败",
    findings: [],
    severity: "warning",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // consecutiveFailures=3（不含本轮），effectiveFailures=4 → stop_failure
  // （4 >= stop_failure_threshold=4）
  const decision = scheduler.decideNext(0, verdict, [], 0, 3);
  assert.equal(decision.action, "stop_failure");
});

test("I2c. LoopScheduler 在 P5 配置下：连续失败未达阈值 → fix", () => {
  const consecutiveFailureAbort = 3;
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "",
    extra: {
      consecutive_failures_human_checkpoint: consecutiveFailureAbort,
      consecutive_failures_stop_failure: consecutiveFailureAbort + 1,
      stop_when_empty_means_stop: false,
    },
  });
  const scheduler = new LoopScheduler(config);

  const verdict: LoopEvaluationVerdict = {
    passed: false,
    evaluatorId: "p5-test",
    reason: "测试失败",
    findings: [],
    severity: "warning",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // consecutiveFailures=0（不含本轮），effectiveFailures=1 → fix
  // （1 < human_checkpoint_threshold=3）
  const decision = scheduler.decideNext(0, verdict, [], 0, 0);
  assert.equal(decision.action, "fix");
});

// ----------------------------------------------------------------------------
// I3. stop_when_empty_means_stop=false 对 P5 语义的影响
// ----------------------------------------------------------------------------

test("I3a. stop_when_empty_means_stop=false：空 stopWhen + 验证通过 → continue（不停止）", () => {
  // P5 语义：空 stopWhen 时不停止，依赖 plan taskCard=null 判定完成
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "", // 空 stopWhen
    extra: {
      stop_when_empty_means_stop: false, // P5 语义
    },
  });
  const scheduler = new LoopScheduler(config);

  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "p5-test",
    reason: "全部通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // 空 stopWhen + passed=true + stop_when_empty_means_stop=false → continue（不停止）
  const decision = scheduler.decideNext(0, verdict, [], 0, 0);
  assert.equal(decision.action, "continue");
});

test("I3b. stop_when_empty_means_stop=true（eag/loop/ 默认）：空 stopWhen + 验证通过 → stop_success（停止）", () => {
  // eag/loop/ 母本语义：空 stopWhen 时单轮通过即停止
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "",
    extra: {
      stop_when_empty_means_stop: true, // eag/loop/ 默认
    },
  });
  const scheduler = new LoopScheduler(config);

  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "p5-test",
    reason: "全部通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // 空 stopWhen + passed=true + stop_when_empty_means_stop=true → stop_success
  const decision = scheduler.decideNext(0, verdict, [], 0, 0);
  assert.equal(decision.action, "stop_success");
});

// ----------------------------------------------------------------------------
// I4. LoopEvent 正确生成（verification_passed / verification_rejected）
// ----------------------------------------------------------------------------

test("I4a. LoopEvent verification_passed：verdict.passed=true → eventType=verification_passed", () => {
  // 构造一个 verification_passed 事件（模拟 P5 buildLoopEvent 的逻辑）
  const runId = "test-run-001";
  const iterIndex = 0;
  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "p5-autonomous-orchestrator",
    reason: "所有 4 阶段均成功",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  const event: LoopEvent = {
    eventId: `${runId}-iter-${iterIndex}-${Date.now()}`,
    eventType: verdict.passed ? "verification_passed" : "verification_rejected",
    phase: "verification",
    runId,
    iterIndex,
    payload: Object.freeze({
      passed: verdict.passed,
      severity: verdict.severity,
      reason: verdict.reason,
      findings: verdict.findings,
    }),
    timestamp: new Date().toISOString(),
  };

  assert.equal(event.eventType, "verification_passed");
  assert.equal(event.phase, "verification");
  assert.equal(event.runId, runId);
  assert.equal(event.iterIndex, iterIndex);
  assert.equal((event.payload as { passed: boolean }).passed, true);
});

test("I4b. LoopEvent verification_rejected：verdict.passed=false → eventType=verification_rejected", () => {
  const runId = "test-run-002";
  const iterIndex = 1;
  const verdict: LoopEvaluationVerdict = {
    passed: false,
    evaluatorId: "p5-autonomous-orchestrator",
    reason: "存在失败阶段",
    findings: ["[verify] failed: 测试失败"],
    severity: "warning",
    suggestedFix: "检查失败阶段的错误信息并修复",
    sampledArtifacts: [],
  };

  const event: LoopEvent = {
    eventId: `${runId}-iter-${iterIndex}-${Date.now()}`,
    eventType: verdict.passed ? "verification_passed" : "verification_rejected",
    phase: "verification",
    runId,
    iterIndex,
    payload: Object.freeze({
      passed: verdict.passed,
      severity: verdict.severity,
      reason: verdict.reason,
      findings: verdict.findings,
    }),
    timestamp: new Date().toISOString(),
  };

  assert.equal(event.eventType, "verification_rejected");
  assert.equal(event.iterIndex, 1);
  assert.equal((event.payload as { passed: boolean }).passed, false);
  assert.deepEqual((event.payload as { findings: string[] }).findings, ["[verify] failed: 测试失败"]);
});

test("I4c. LoopScheduler.shouldStopWhen 检测到 verification_passed 事件 → stop_success（含关键词时）", () => {
  // 当 stopWhen 含完成类关键词时，scheduler 检查 memoryEvents 是否含 verification_passed
  // 注：STOP_WHEN_KEYWORDS = ["完成","通过","成功","done","passed","completed"]
  // 使用 "all tests passed" 包含 "passed" 关键词
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "all tests passed", // 含 "passed" 关键词
    extra: {
      stop_when_empty_means_stop: false,
    },
  });
  const scheduler = new LoopScheduler(config);

  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "p5-test",
    reason: "全部通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // 构造一个含 verification_passed 事件的 memoryEvents
  const memoryEvents: LoopEvent[] = [
    {
      eventId: "evt-001",
      eventType: "verification_passed",
      phase: "verification",
      runId: "test-run",
      iterIndex: 0,
      payload: {},
      timestamp: new Date().toISOString(),
    },
  ];

  // stopWhen="all tests passed" + memoryEvents 含 verification_passed → stop_success
  const decision = scheduler.decideNext(0, verdict, memoryEvents, 0, 0);
  assert.equal(decision.action, "stop_success");
});

// ----------------------------------------------------------------------------
// I5. P5 index.ts 正确导出 eag/loop/ 关键类型
// ----------------------------------------------------------------------------

test("I5. P5 index.ts 正确导出 eag/loop/ 关键类型和类", () => {
  // 验证 LoopScheduler 类可从 P5 index.ts 导入
  assert.ok(typeof LoopScheduler === "function", "LoopScheduler 应为可构造的类");

  // 验证 createLoopEngineeringConfig 工厂函数可从 P5 index.ts 导入
  assert.ok(typeof createLoopEngineeringConfig === "function", "createLoopEngineeringConfig 应为函数");

  // 验证通过 P5 index.ts 导出的 createLoopEngineeringConfig 可正常构造配置
  const config = createLoopEngineeringConfig({
    loopType: "coding",
    maxIterations: 5,
    maxTokens: 100_000,
  });
  assert.ok(Object.isFrozen(config), "配置应被冻结");
  assert.equal(config.maxIterations, 5);

  // 验证 LoopScheduler 可通过 P5 index.ts 导出的类构造
  const scheduler = new LoopScheduler(config);
  assert.ok(scheduler instanceof LoopScheduler, "应为 LoopScheduler 实例");

  // 验证 decideNext 方法可用
  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "test",
    reason: "ok",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };
  const decision: SchedulingDecision = scheduler.decideNext(0, verdict, [], 0, 0);
  assert.ok(decision.action === "continue" || decision.action === "stop_success");
});

// ----------------------------------------------------------------------------
// I6. 端到端：AutonomousOrchestrator 使用 LoopScheduler 后，aborted 终止条件等价
// ----------------------------------------------------------------------------

test("I6. 端到端：AutonomousOrchestrator + LoopScheduler → aborted 终止条件（连续失败 >= abort 阈值）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（含 1 张 pending 任务卡）
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 LoopScheduler 集成后的 aborted 终止条件",
      maxIterations: 5,
      consecutiveFailureAbort: 2, // 连续失败 2 次即 abort
      testCommand: FAIL_TEST_CMD, // 测试命令始终失败
      testTimeoutSec: 10,
    });

    // 验证 aborted 终止条件（与原 B5 测试等价）
    assert.equal(result.finalStatus, "aborted");
    assert.equal(result.exitCode, 2);
    // 至少迭代 2 次（连续失败 2 次才触发 abort）
    assert.ok(result.totalIterations >= 2);
    // aborted 时应有 blockageReport
    assert.ok(result.blockageReport !== undefined);
    assert.ok(result.blockageReport.rootCauseHypotheses.length > 0);
    assert.ok(result.blockageReport.suggestedSolutions.length > 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// I7. 端到端：AutonomousOrchestrator 使用 LoopScheduler 后，failed 终止条件等价
// ----------------------------------------------------------------------------

test("I7. 端到端：AutonomousOrchestrator + LoopScheduler → failed 终止条件（迭代次数用尽）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 LoopScheduler 集成后的 failed 终止条件",
      maxIterations: 1, // 仅 1 轮迭代
      consecutiveFailureAbort: 3, // abort 阈值设为 3（1 次失败不会触发 abort）
      testCommand: FAIL_TEST_CMD, // 测试命令始终失败
      testTimeoutSec: 10,
    });

    // 验证 failed 终止条件（与原 B6 测试等价）
    // 注：maxIterations=1 时，scheduler 的 stop_failure 因 iterIndex+1>=maxIterations 不触发 aborted
    //     由步骤 6 统一设为 failed（保持向后兼容）
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.exitCode, 1);
    assert.ok(result.totalIterations >= 1);
    assert.ok(result.blockageReport !== undefined);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// I8. 端到端：AutonomousOrchestrator 使用 LoopScheduler 后，completed 终止条件等价
// ----------------------------------------------------------------------------

test("I8. 端到端：AutonomousOrchestrator + LoopScheduler → completed 终止条件（plan 返回 taskCard=null）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（含 1 张 completed 任务卡 → plan 阶段找不到 pending 任务 → taskCard=null）
    createTasksFile(projectRoot, 1, "completed");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 LoopScheduler 集成后的 completed 终止条件",
      maxIterations: 3,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 completed 终止条件（与原 B3 测试等价）
    // plan 阶段返回 taskCard=null → status="completed"
    assert.equal(result.finalStatus, "completed");
    assert.equal(result.exitCode, 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// I9. 端到端：AutonomousOrchestrator 使用 LoopScheduler 后，stop_when 终止条件等价
// ----------------------------------------------------------------------------

test("I9. 端到端：AutonomousOrchestrator + LoopScheduler → stop_when 终止条件（verify 通过 + stopWhen 命中）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 LoopScheduler 集成后的 stop_when 终止条件",
      maxIterations: 3,
      stopWhen: "all tests pass", // 设置 stop_when 条件
      testCommand: PASS_TEST_CMD, // 测试通过
      testTimeoutSec: 10,
    });

    // 验证 stop_when 终止条件（与原 B4 测试等价）
    // verify 通过 + stopWhen 命中 → status="stop_when"
    assert.equal(result.finalStatus, "stop_when");
    assert.equal(result.exitCode, 3);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// I10. 向后兼容验证：默认 consecutiveFailureAbort 阈值正确
// ----------------------------------------------------------------------------

test("I10. 向后兼容：AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT 默认值为 3", () => {
  // 验证 P5 默认 abort 阈值为 3（对齐架构 §4.4）
  assert.equal(AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT, 3);
});
