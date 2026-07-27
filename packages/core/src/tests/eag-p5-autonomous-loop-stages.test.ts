/**
 * EAG-P5 Autonomous 测试拆分文件 3/5：4 阶段循环 E2E + 最大迭代限制
 *
 * 本文件从 eag-p5-e2e-autonomous.test.ts 拆分而来，包含：
 * - E 组（E1-E5）：4 阶段循环 E2E（DOD-1 验证）
 *   - plan → dev → verify → fix 完整执行
 *   - finalStatus=completed / stop_when / aborted / failed 四类终止
 *   - milestones 里程碑记录
 *   - triggeredGuards 护栏触发记录
 * - F 组（F1-F3）：最大迭代限制（NFR-2 + G-A6d 验证）
 *   - maxIterations 上限触发终止
 *   - 不可变优先（Object.freeze）
 *
 * 测试约定（严格遵循项目规则 P-5 + NFR-9）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行 node -e 命令）
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约
 * - NFR-2 maxIterations 上限 + NFR-8 不可变优先 + NFR-9 禁止 mock
 *
 * @module core/tests/eag-p5-autonomous-loop-stages
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// P5 核心组件导入（E 组 / F 组类型）
import type { AutonomousRunRequest } from "../eag/p5";

// P5 默认配置常量导入（F2 用）
import {
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
} from "../eag/p5";

// 共享夹具导入
import {
  PASS_TEST_CMD,
  FAIL_TEST_CMD,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  buildOrchestrator,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// E. 4 阶段循环 E2E 测试
// ============================================================================

test("E1. 4 阶段循环完整执行（plan → dev → verify → fix，finalStatus=completed）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建含 1 张 completed 任务卡的 tasks.md（plan 阶段直接成功）
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 4 阶段循环完整执行",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 finalStatus
    assert.equal(result.finalStatus, "completed", "应完成成功");
    assert.equal(result.exitCode, 0, "退出码应为 0（全绿）");
    // 验证迭代次数
    assert.ok(result.totalIterations >= 1, "应至少迭代 1 次");
    // 验证 milestones（每轮 4 阶段全绿 = 一个里程碑）
    assert.ok(result.milestones.length >= 1, "应至少有 1 个里程碑");
    // 验证 stop_when 时不应有 blockageReport
    assert.equal(result.blockageReport, undefined, "completed 时不应有 blockageReport");
    // 验证结果不可变性
    assert.ok(Object.isFrozen(result), "AutonomousRunResult 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E2. stop_when 终止条件（finalStatus=stop_when, exitCode=3）", async () => {
  const projectRoot = createTempProject();
  try {
    // R2 修复：使用 "pending" 状态的任务卡，让 stop_when 条件先于 completed 触发
    // 若使用 "completed"，plan 阶段直接完成，orchestrator 返回 finalStatus=completed 而非 stop_when
    // 使用 "pending" 时，测试命令通过（PASS_TEST_CMD）满足 stopWhen="all tests pass" 条件
    // orchestrator 检测到 stop_when 条件满足后返回 finalStatus=stop_when
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 stop_when 终止条件",
      maxIterations: 1,
      stopWhen: "all tests pass",
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 stop_when 终止条件
    assert.equal(result.finalStatus, "stop_when");
    assert.equal(result.exitCode, 3, "stop_when 退出码应为 3");
    assert.ok(result.totalIterations >= 1);
    assert.ok(result.milestones.length >= 1, "stop_when 也应记录里程碑");
    assert.equal(result.blockageReport, undefined, "stop_when 时不应有 blockageReport");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E3. aborted 终止条件（连续失败 >= abort 阈值, exitCode=2）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 aborted 终止条件",
      maxIterations: 5,
      consecutiveFailureAbort: 2, // 连续失败 2 次即 abort
      testCommand: FAIL_TEST_CMD, // 测试命令始终失败
      testTimeoutSec: 10,
    });

    // 验证 aborted 终止条件
    assert.equal(result.finalStatus, "aborted");
    assert.equal(result.exitCode, 2, "aborted 退出码应为 2");
    assert.ok(result.totalIterations >= 2, "至少迭代 2 次才触发 abort");
    assert.ok(result.blockageReport !== undefined, "aborted 时应有 blockageReport");
    assert.ok(result.blockageReport!.rootCauseHypotheses.length > 0, "blockageReport 应含根因假设");
    assert.ok(result.blockageReport!.suggestedSolutions.length > 0, "blockageReport 应含建议方案");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E4. failed 终止条件（迭代次数用尽, exitCode=1）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 failed 终止条件",
      maxIterations: 1, // 仅 1 轮迭代
      consecutiveFailureAbort: 3, // abort 阈值设为 3（1 次失败不触发 abort）
      testCommand: FAIL_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 failed 终止条件
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.exitCode, 1, "failed 退出码应为 1");
    assert.ok(result.totalIterations >= 1);
    assert.ok(result.blockageReport !== undefined, "failed 时应有 blockageReport");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E5. AutonomousRunResult 完整字段验证", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "完整字段验证",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证所有 readonly 字段存在且类型正确
    assert.equal(typeof result.runId, "string", "runId 应为 string");
    assert.ok(result.runId.length > 0, "runId 应非空");
    assert.ok(["completed", "failed", "aborted", "stop_when"].includes(result.finalStatus), "finalStatus 应为四值之一");
    assert.ok([0, 1, 2, 3].includes(result.exitCode), "exitCode 应为 0/1/2/3 之一");
    assert.ok(Array.isArray(result.completedLoops), "completedLoops 应为数组");
    assert.ok(Array.isArray(result.milestones), "milestones 应为数组");
    assert.equal(typeof result.totalIterations, "number", "totalIterations 应为 number");
    assert.equal(typeof result.totalLlmCallCount, "number", "totalLlmCallCount 应为 number");
    assert.equal(typeof result.totalTokensUsed, "number", "totalTokensUsed 应为 number");
    assert.equal(typeof result.durationSec, "number", "durationSec 应为 number");
    assert.equal(typeof result.finalReport, "string", "finalReport 应为 string");
    assert.ok(Array.isArray(result.triggeredGuards), "triggeredGuards 应为数组");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// F. 最大迭代限制测试（NFR-2 + G-A6d）
// ============================================================================

test("F1. maxIterations 上限触发终止（迭代次数用尽 → failed）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 maxIterations 上限",
      maxIterations: 2, // 限制 2 轮迭代
      consecutiveFailureAbort: 10, // 高阈值，避免触发 abort
      testCommand: FAIL_TEST_CMD, // 始终失败
      testTimeoutSec: 10,
    });

    // 验证 maxIterations 上限触发 failed 终止
    assert.ok(result.finalStatus === "failed" || result.finalStatus === "aborted", "迭代用尽应为 failed 或 aborted");
    assert.ok(result.totalIterations <= 2, "迭代次数不应超过 maxIterations");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("F2. AUTONOMOUS_DEFAULT_* 常量正确性（NFR-2 + G-A6d）", () => {
  // 验证默认配置常量与架构师审查 §4.1 + 用户任务说明一致
  assert.equal(AUTONOMOUS_DEFAULT_MAX_ITERATIONS, 10, "默认最大迭代次数应为 10");
  assert.equal(AUTONOMOUS_DEFAULT_MAX_TOKENS, 200_000, "默认最大 Token 预算应为 200000");
  assert.equal(AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT, 3, "默认连续失败 abort 阈值应为 3");
  assert.equal(AUTONOMOUS_DEFAULT_TEST_COMMAND, "npm test", '默认测试命令应为 "npm test"');
  assert.equal(AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC, 600, "默认测试超时秒数应为 600");
});

test("F3. AutonomousRunRequest 不可变性（G-A6d Object.freeze）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");

    const orchestrator = buildOrchestrator();
    const request: AutonomousRunRequest = Object.freeze({
      projectRoot,
      objective: "不可变性测试",
      maxIterations: 1,
      maxTokens: 200000,
      stopWhen: "",
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
      consecutiveFailureAbort: 3,
    });

    // 验证 request 被冻结
    assert.ok(Object.isFrozen(request), "AutonomousRunRequest 应被冻结");
    // 尝试修改应抛 TypeError
    assert.throws(() => {
      (request as { maxIterations: number }).maxIterations = 999;
    }, TypeError);

    // 执行验证（确保冻结的 request 仍可被 orchestrator 处理）
    const result = await orchestrator.run(request);
    assert.ok(result.totalIterations >= 1);
  } finally {
    cleanupTempProject(projectRoot);
  }
});
