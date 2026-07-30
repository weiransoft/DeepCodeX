/**
 * EAG-P5 Phase 5.2 AutonomousOrchestrator + LoopExecutor 单元测试
 * （TASK-P5-1.2-010 验证）
 *
 * 测试范围：
 * - A. P5LoopExecutor 分流器（TASK-P5-1.2-008 验证）
 *   - 构造校验（handlers 完整/缺失/阶段不完整）
 *   - execute 分流正确性（4 个阶段分别路由到对应 handler）
 *   - 异常兜底（handler 抛错 → 转换为 fatal StageResult）
 *   - executeBatch 批量执行（全 success / 中间 failed 中止）
 *   - getStats 统计累加正确性
 * - B. AutonomousOrchestrator 主控制器（TASK-P5-1.2-009 验证）
 *   - 构造校验（5 个核心依赖完整/缺失）
 *   - run() 完整 4 阶段循环
 *   - 4 类终止条件（completed / stop_when / aborted / failed）
 * - C. 默认配置常量正确性
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行 node -e 命令）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 *
 * 测试命令设计：
 * - PASS_TEST_CMD：输出 Jest 格式 "Tests: 1 passed, 0 failed"，退出码 0
 *   → verify-stage-handler 解析为 {passed:1, failed:0} → testPassed=true → success
 * - FAIL_TEST_CMD：输出 Jest 格式 "Tests: 0 passed, 1 failed"，退出码 1
 *   → verify-stage-handler 解析为 {passed:0, failed:1} → testPassed=false → failed
 * - 两个命令均不在黑白名单中，风险分=0 → SmartConfirmation auto-approve
 *
 * 设计依据：
 * - 需求文档 §3 FR-3 无人值守 4 阶段循环
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约
 * - 任务分解 TASK-P5-1.2-008~010 测试用例编号
 *
 * @module core/tests/eag-p5-autonomous-orchestrator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  // P5LoopExecutor 分流器
  P5LoopExecutor,
  createP5LoopExecutorFromHandlers,
  // AutonomousOrchestrator 主控制器
  AutonomousOrchestrator,
  // 4 个 StageHandler
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  // 核心依赖
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  // 辅助工厂函数
  createSuccessStageResult,
  // 类型
  type P5StageContext,
  type P5StageResult,
  type P5StageHandler,
  type P5RunState,
  // 默认配置常量
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
} from "../eag/p5/index";

// ============================================================================
// 1. 测试常量
// ============================================================================

/**
 * 通过测试命令（真实 child_process 执行，输出 Jest 格式）
 *
 * 命令：node -e 'console.log("Tests: 1 passed, 0 failed")'
 * 输出：Tests: 1 passed, 0 failed
 * 退出码：0
 * 解析结果：{ passed: 1, failed: 0, skipped: 0, total: 1, parser: "jest" }
 *
 * SmartConfirmation 判定：
 * - 黑名单不命中（无 node 模式）
 * - 白名单不命中（无 node -e 模式）
 * - 风险分=0（RISK_PATTERNS 无 node 模式）→ auto-approve
 */
const PASS_TEST_CMD = `node -e 'console.log("Tests: 1 passed, 0 failed")'`;

/**
 * 失败测试命令（真实 child_process 执行，输出 Jest 格式 + 非零退出码）
 *
 * 命令：node -e 'console.log("Tests: 0 passed, 1 failed"); process.exit(1)'
 * 输出：Tests: 0 passed, 1 failed
 * 退出码：1
 * 解析结果：{ passed: 0, failed: 1, skipped: 0, total: 1, parser: "jest" }
 *
 * SmartConfirmation 判定：同 PASS_TEST_CMD，auto-approve
 */
const FAIL_TEST_CMD = `node -e 'console.log("Tests: 0 passed, 1 failed"); process.exit(1)'`;

// ============================================================================
// 2. 测试辅助函数
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统）
 *
 * 在 os.tmpdir() 下创建唯一临时目录，并确保 .eag/p5 子目录存在。
 * 测试结束后由调用方通过 cleanupTempProject 清理。
 *
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(): string {
  const prefix = path.join(os.tmpdir(), "eag-p5-test-");
  const projectRoot = fs.mkdtempSync(prefix);
  // 创建 .eag/p5 子目录（run-state-store 和 notes-memory 会用到）
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

/**
 * 清理临时项目目录（递归删除，容错处理）
 *
 * @param projectRoot 临时项目根目录
 */
function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败（测试环境不强求清理，CI 会定期清理 tmpdir）
  }
}

/**
 * 创建 tasks.md 文件（含指定状态的任务卡）
 *
 * 任务卡格式（对齐 plan-stage-handler 的解析器）：
 *   ## T-001 测试任务 1
 *   - requirement: F-001
 *   - status: pending
 *   - dependencies:
 *   - files: src/services/Service1.ts
 *   - deletions:
 *   - symbols: Service1
 *   - acceptance: 测试通过
 *
 * @param projectRoot 项目根目录
 * @param taskCount 任务卡数量
 * @param status 任务卡状态（pending/completed/in-progress/blocked）
 * @returns tasks.md 文件绝对路径
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
 * 创建声明的源文件（让 dev 阶段能盘点到真实文件）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径（相对 projectRoot）
 */
function createDeclaredFile(projectRoot: string, relativePath: string): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, "// 测试文件内容\n", "utf8");
}

/**
 * 构造真实的 P5LoopExecutor 实例（使用真实的 4 个 StageHandler）
 *
 * @returns P5LoopExecutor 实例
 */
function buildLoopExecutor(): P5LoopExecutor {
  return createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    new P5DevStageHandler(),
    new P5VerifyStageHandler(),
    new P5FixStageHandler()
  );
}

/**
 * 构造真实的 AutonomousOrchestrator 实例（使用真实的 5 个核心依赖）
 *
 * @param overrides 可选的配置覆盖
 * @returns AutonomousOrchestrator 实例
 */
function buildOrchestrator(overrides?: {
  readonly defaultMaxIterations?: number;
  readonly defaultMaxTokens?: number;
  readonly defaultConsecutiveFailureAbort?: number;
  readonly defaultTestCommand?: string;
  readonly defaultTestTimeoutSec?: number;
}): AutonomousOrchestrator {
  const loopExecutor = buildLoopExecutor();
  const runStateStore = new P5RunStateStore();
  const notesMemory = new P5NotesMemory();
  // 使用 throwOnDeny: false 避免护栏 DENY 时抛出 GuardViolationError
  // StageHandler 会正确处理 DENY 结果（转换为 fatal StageResult）
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  const smartConfirmation = new P5SmartConfirmation();

  return new AutonomousOrchestrator({
    loopExecutor,
    runStateStore,
    notesMemory,
    guardChain,
    smartConfirmation,
    defaultMaxIterations: overrides?.defaultMaxIterations,
    defaultMaxTokens: overrides?.defaultMaxTokens,
    defaultConsecutiveFailureAbort: overrides?.defaultConsecutiveFailureAbort,
    defaultTestCommand: overrides?.defaultTestCommand,
    defaultTestTimeoutSec: overrides?.defaultTestTimeoutSec,
  });
}

/**
 * 构造测试用 P5StageContext（用于 P5LoopExecutor 单阶段测试）
 *
 * 提供合理的默认值，测试用例可通过 overrides 覆盖特定字段。
 *
 * @param projectRoot 项目根目录
 * @param overrides 覆盖字段（可选）
 * @returns 冻结的 P5StageContext
 */
function createStageContext(projectRoot: string, overrides: Partial<P5StageContext> = {}): P5StageContext {
  // 构造测试用 P5RunState（含全部 20 个 readonly 字段）
  const runState: P5RunState = Object.freeze({
    runId: "test-run-001",
    projectRoot,
    objective: "测试目标",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentLoop: "coding",
    iterIndex: 0,
    currentStage: "plan",
    completedStages: Object.freeze([]),
    completedLoops: Object.freeze([]),
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    consecutiveFailures: 0,
    maxIterations: 10,
    maxTokens: 200_000,
    stopWhen: "",
    status: "running",
    lastGuardTriggered: null,
    localChecksum: "sha256:test-local-checksum",
    cumulativeChecksum: "sha256:test-cumulative-checksum",
  });

  // 构造真实的 GuardChain 和 SmartConfirmation 实例
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  const smartConfirmation = new P5SmartConfirmation();

  // 构造完整的 P5StageContext（含全部 16 个 readonly 字段）
  return Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "plan",
    projectRoot,
    worktreePath: projectRoot,
    objective: "测试目标",
    currentPlan: "",
    notesSnapshot: "",
    prevResults: Object.freeze([]),
    runState,
    guardChain,
    smartConfirmation,
    tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
    testCommand: PASS_TEST_CMD,
    testTimeoutSec: 30,
    loopType: "coding" as const,
    ...overrides,
  }) as P5StageContext;
}

// ============================================================================
// A. P5LoopExecutor 测试（TASK-P5-1.2-008 验证）
// ============================================================================

test("A1. P5LoopExecutor 构造成功（handlers 完整）", () => {
  const executor = buildLoopExecutor();
  assert.ok(executor instanceof P5LoopExecutor);
  // 支持的 4 个阶段
  const stages = executor.getSupportedStages();
  assert.equal(stages.length, 4);
  assert.ok(stages.includes("plan"));
  assert.ok(stages.includes("dev"));
  assert.ok(stages.includes("verify"));
  assert.ok(stages.includes("fix"));
  // 初始统计为 0
  const stats = executor.getStats();
  assert.equal(stats.totalDispatches, 0);
  assert.equal(stats.successCount, 0);
  assert.equal(stats.failedCount, 0);
  assert.equal(stats.fatalCount, 0);
});

test("A2. P5LoopExecutor 构造失败（options 缺失）", () => {
  assert.throws(
    () => new P5LoopExecutor(undefined as unknown as Parameters<typeof P5LoopExecutor>[0]),
    /options 必须为对象/
  );
});

test("A3. P5LoopExecutor 构造失败（handlers 某阶段缺失）", () => {
  assert.throws(
    () =>
      new P5LoopExecutor({
        handlers: {
          plan: new P5PlanStageHandler(),
          dev: new P5DevStageHandler(),
          verify: new P5VerifyStageHandler(),
          // fix 缺失
        } as unknown as Parameters<typeof P5LoopExecutor>[0]["handlers"],
      }),
    /handlers\.fix 缺失/
  );
});

test("A4. P5LoopExecutor execute 分流正确（4 个阶段分别调用对应 handler）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建含 1 张 pending 任务卡的 tasks.md
    createTasksFile(projectRoot, 1, "pending");
    // 创建声明的源文件（让 dev 阶段能盘点到）
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const executor = buildLoopExecutor();

    // 执行 plan 阶段
    const planCtx = createStageContext(projectRoot, { stage: "plan" });
    const planResult = await executor.execute("plan", planCtx);
    assert.equal(planResult.stage, "plan");
    assert.equal(planResult.kind, "success");
    // plan 应产出 taskCard 非 null
    const planTaskCard = planResult.artifacts["taskCard"];
    assert.ok(planTaskCard !== null && planTaskCard !== undefined);

    // 执行 dev 阶段（传入 plan 结果作为 prevResults）
    const devCtx = createStageContext(projectRoot, {
      stage: "dev",
      prevResults: Object.freeze([planResult]),
    });
    const devResult = await executor.execute("dev", devCtx);
    assert.equal(devResult.stage, "dev");
    assert.equal(devResult.kind, "success");

    // 执行 verify 阶段（传入 plan + dev 结果，使用 PASS_TEST_CMD）
    const verifyCtx = createStageContext(projectRoot, {
      stage: "verify",
      prevResults: Object.freeze([planResult, devResult]),
    });
    const verifyResult = await executor.execute("verify", verifyCtx);
    assert.equal(verifyResult.stage, "verify");
    assert.equal(verifyResult.kind, "success");

    // 执行 fix 阶段（传入 plan + dev + verify 结果）
    const fixCtx = createStageContext(projectRoot, {
      stage: "fix",
      prevResults: Object.freeze([planResult, devResult, verifyResult]),
    });
    const fixResult = await executor.execute("fix", fixCtx);
    assert.equal(fixResult.stage, "fix");
    assert.equal(fixResult.kind, "success");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("A5. P5LoopExecutor 异常兜底（handler 抛错 → 返回 fatal StageResult）", async () => {
  /**
   * 抛异常的 stub handler（真实实现，非 mock）
   *
   * 实现 P5StageHandler 接口，在 handle() 中故意抛出异常，
   * 用于验证 P5LoopExecutor 的异常兜底机制：
   * handler 抛出的异常不应传播到调用方，而应转换为 fatal StageResult。
   */
  class ThrowingHandler implements P5StageHandler {
    async handle(_ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>> {
      throw new Error("测试故意抛出的异常");
    }
  }

  const executor = new P5LoopExecutor({
    handlers: Object.freeze({
      plan: new ThrowingHandler(),
      dev: new ThrowingHandler(),
      verify: new ThrowingHandler(),
      fix: new ThrowingHandler(),
    }),
  });

  const projectRoot = createTempProject();
  try {
    const ctx = createStageContext(projectRoot);
    const result = await executor.execute("plan", ctx);

    // 验证异常被转换为 fatal StageResult
    assert.equal(result.kind, "fatal");
    assert.equal(result.stage, "plan");
    assert.match(result.summary, /未捕获异常/);
    assert.match(result.error ?? "", /测试故意抛出的异常/);

    // 验证统计累加（fatal 计数）
    const stats = executor.getStats();
    assert.equal(stats.totalDispatches, 1);
    assert.equal(stats.fatalCount, 1);
    assert.equal(stats.successCount, 0);
    assert.equal(stats.failedCount, 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("A6. P5LoopExecutor executeBatch 全部 success（4 阶段顺序执行）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const executor = buildLoopExecutor();

    const results = await executor.executeBatch(["plan", "dev", "verify", "fix"], (stage, prevResults) =>
      createStageContext(projectRoot, {
        stage,
        prevResults: Object.freeze([...prevResults]),
      })
    );

    // 验证全部 4 个阶段都被执行且 success
    assert.equal(results.length, 4);
    assert.equal(results[0]!.stage, "plan");
    assert.equal(results[0]!.kind, "success");
    assert.equal(results[1]!.stage, "dev");
    assert.equal(results[1]!.kind, "success");
    assert.equal(results[2]!.stage, "verify");
    assert.equal(results[2]!.kind, "success");
    assert.equal(results[3]!.stage, "fix");
    assert.equal(results[3]!.kind, "success");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("A7. P5LoopExecutor executeBatch 中间 failed 时立即中止", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const executor = buildLoopExecutor();

    // 使用 FAIL_TEST_CMD 让 verify 阶段失败
    const results = await executor.executeBatch(["plan", "dev", "verify", "fix"], (stage, prevResults) =>
      createStageContext(projectRoot, {
        stage,
        testCommand: FAIL_TEST_CMD,
        prevResults: Object.freeze([...prevResults]),
      })
    );

    // verify 失败后应立即中止，不执行 fix
    assert.equal(results.length, 3);
    assert.equal(results[0]!.stage, "plan");
    assert.equal(results[0]!.kind, "success");
    assert.equal(results[1]!.stage, "dev");
    assert.equal(results[1]!.kind, "success");
    assert.equal(results[2]!.stage, "verify");
    assert.equal(results[2]!.kind, "failed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("A8. P5LoopExecutor getStats 统计累加正确", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const executor = buildLoopExecutor();

    // 初始统计应为 0
    const initialStats = executor.getStats();
    assert.equal(initialStats.totalDispatches, 0);
    assert.equal(initialStats.successCount, 0);
    assert.equal(initialStats.failedCount, 0);
    assert.equal(initialStats.fatalCount, 0);

    // 执行 plan 阶段（success）
    const planCtx = createStageContext(projectRoot, { stage: "plan" });
    await executor.execute("plan", planCtx);

    // 执行 verify 阶段（success，使用 PASS_TEST_CMD）
    const verifyCtx = createStageContext(projectRoot, {
      stage: "verify",
      prevResults: Object.freeze([]),
    });
    await executor.execute("verify", verifyCtx);

    // 验证统计累加
    const stats = executor.getStats();
    assert.equal(stats.totalDispatches, 2);
    assert.equal(stats.dispatchesByStage.plan, 1);
    assert.equal(stats.dispatchesByStage.verify, 1);
    assert.equal(stats.dispatchesByStage.dev, 0);
    assert.equal(stats.dispatchesByStage.fix, 0);
    assert.equal(stats.successCount, 2);
    assert.equal(stats.failedCount, 0);
    assert.equal(stats.fatalCount, 0);
    // 耗时应为非负数
    assert.ok(stats.totalDurationMs >= 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("A9. P5LoopExecutor getHandler 返回正确的 handler 实例", () => {
  const planHandler = new P5PlanStageHandler();
  const devHandler = new P5DevStageHandler();
  const verifyHandler = new P5VerifyStageHandler();
  const fixHandler = new P5FixStageHandler();

  const executor = createP5LoopExecutorFromHandlers(planHandler, devHandler, verifyHandler, fixHandler);

  // 验证 getHandler 返回注入的实例
  assert.equal(executor.getHandler("plan"), planHandler);
  assert.equal(executor.getHandler("dev"), devHandler);
  assert.equal(executor.getHandler("verify"), verifyHandler);
  assert.equal(executor.getHandler("fix"), fixHandler);
});

// ============================================================================
// B. AutonomousOrchestrator 测试（TASK-P5-1.2-009 验证）
// ============================================================================

test("B1. AutonomousOrchestrator 构造成功（5 个核心依赖完整）", () => {
  const orchestrator = buildOrchestrator();
  assert.ok(orchestrator instanceof AutonomousOrchestrator);
});

test("B2. AutonomousOrchestrator 构造失败（核心依赖缺失）", () => {
  const loopExecutor = buildLoopExecutor();
  const runStateStore = new P5RunStateStore();
  const notesMemory = new P5NotesMemory();
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  const smartConfirmation = new P5SmartConfirmation();

  // 缺少 loopExecutor
  assert.throws(
    () =>
      new AutonomousOrchestrator({
        runStateStore,
        notesMemory,
        guardChain,
        smartConfirmation,
      } as unknown as Parameters<typeof AutonomousOrchestrator>[0]),
    /loopExecutor 必填/
  );

  // 缺少 runStateStore
  assert.throws(
    () =>
      new AutonomousOrchestrator({
        loopExecutor,
        notesMemory,
        guardChain,
        smartConfirmation,
      } as unknown as Parameters<typeof AutonomousOrchestrator>[0]),
    /runStateStore 必填/
  );

  // 缺少 notesMemory
  assert.throws(
    () =>
      new AutonomousOrchestrator({
        loopExecutor,
        runStateStore,
        guardChain,
        smartConfirmation,
      } as unknown as Parameters<typeof AutonomousOrchestrator>[0]),
    /notesMemory 必填/
  );

  // 缺少 guardChain
  assert.throws(
    () =>
      new AutonomousOrchestrator({
        loopExecutor,
        runStateStore,
        notesMemory,
        smartConfirmation,
      } as unknown as Parameters<typeof AutonomousOrchestrator>[0]),
    /guardChain 必填/
  );

  // 缺少 smartConfirmation
  assert.throws(
    () =>
      new AutonomousOrchestrator({
        loopExecutor,
        runStateStore,
        notesMemory,
        guardChain,
      } as unknown as Parameters<typeof AutonomousOrchestrator>[0]),
    /smartConfirmation 必填/
  );
});

test("B3. AutonomousOrchestrator run() completed 终止条件（plan 返回 taskCard=null）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（含 1 张 completed 任务卡）
    // plan 阶段找不到 pending 任务 → 返回 success + taskCard=null
    // → 触发 5d 终止条件 → finalStatus="completed"
    createTasksFile(projectRoot, 1, "completed");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 completed 终止条件",
      maxIterations: 3,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 completed 终止条件
    assert.equal(result.finalStatus, "completed");
    assert.equal(result.exitCode, 0);
    assert.ok(result.totalIterations >= 1);
    // 完成时不应有 blockageReport
    assert.equal(result.blockageReport, undefined);
    // finalReport 应包含 completed
    assert.match(result.finalReport, /completed/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B4. AutonomousOrchestrator run() stop_when 终止条件（verify 通过 + stopWhen 命中）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（含 1 张 pending 任务卡，plan 会选取它）
    createTasksFile(projectRoot, 1, "pending");
    // 创建声明的源文件（让 dev 阶段能盘点到）
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 stop_when 终止条件",
      maxIterations: 1, // 仅 1 轮迭代
      stopWhen: "all tests pass",
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 stop_when 终止条件
    assert.equal(result.finalStatus, "stop_when");
    assert.equal(result.exitCode, 3);
    assert.ok(result.totalIterations >= 1);
    // 4 阶段全绿应记录 milestone
    assert.ok(result.milestones.length >= 1);
    // stop_when 时不应有 blockageReport
    assert.equal(result.blockageReport, undefined);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B5. AutonomousOrchestrator run() aborted 终止条件（连续失败 >= abort 阈值）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（含 1 张 pending 任务卡）
    createTasksFile(projectRoot, 1, "pending");
    // 创建声明的源文件
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
    assert.equal(result.exitCode, 2);
    // 至少迭代 2 次（连续失败 2 次才触发 abort）
    assert.ok(result.totalIterations >= 2);
    // aborted 时应有 blockageReport
    assert.ok(result.blockageReport !== undefined);
    // blockageReport 应含根因假设
    assert.ok(result.blockageReport.rootCauseHypotheses.length > 0);
    assert.ok(result.blockageReport.suggestedSolutions.length > 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B6. AutonomousOrchestrator run() failed 终止条件（迭代次数用尽）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（含 1 张 pending 任务卡）
    createTasksFile(projectRoot, 1, "pending");
    // 创建声明的源文件
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 failed 终止条件",
      maxIterations: 1, // 仅 1 轮迭代
      consecutiveFailureAbort: 3, // abort 阈值设为 3（1 次失败不会触发 abort）
      testCommand: FAIL_TEST_CMD, // 测试命令始终失败
      testTimeoutSec: 10,
    });

    // 验证 failed 终止条件
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.exitCode, 1);
    // 迭代次数应为 1
    assert.ok(result.totalIterations >= 1);
    // failed 时应有 blockageReport
    assert.ok(result.blockageReport !== undefined);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B7. AutonomousOrchestrator run() request 校验失败（projectRoot 缺失）", async () => {
  const orchestrator = buildOrchestrator();

  await assert.rejects(
    async () =>
      orchestrator.run({
        projectRoot: "",
        objective: "测试目标",
      }),
    /projectRoot 必须为非空字符串/
  );
});

test("B8. AutonomousOrchestrator run() request 校验失败（objective 缺失）", async () => {
  const orchestrator = buildOrchestrator();

  await assert.rejects(
    async () =>
      orchestrator.run({
        projectRoot: "/tmp/test",
        objective: "",
      }),
    /objective 必须为非空字符串/
  );
});

// ============================================================================
// C. 默认配置常量测试
// ============================================================================

test("C1. AutonomousOrchestrator 默认配置常量正确性", () => {
  // 验证默认值与架构师审查 §4.1 + 用户任务说明一致
  assert.equal(AUTONOMOUS_DEFAULT_MAX_ITERATIONS, 10, "默认最大迭代次数应为 10");
  assert.equal(AUTONOMOUS_DEFAULT_MAX_TOKENS, 200_000, "默认最大 Token 预算应为 200000");
  assert.equal(AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT, 3, "默认连续失败 abort 阈值应为 3");
  assert.equal(AUTONOMOUS_DEFAULT_TEST_COMMAND, "npm test", '默认测试命令应为 "npm test"');
  assert.equal(AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC, 600, "默认测试超时秒数应为 600");
});

// ============================================================================
// D. AutonomousRunResult 不可变性测试
// ============================================================================

test("D1. AutonomousRunResult 返回冻结对象（不可变优先原则）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");

    const orchestrator = buildOrchestrator();

    const result = await orchestrator.run({
      projectRoot,
      objective: "测试结果不可变性",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证返回对象被 Object.freeze 冻结
    assert.ok(Object.isFrozen(result), "AutonomousRunResult 应被冻结");
    assert.ok(Object.isFrozen(result.completedLoops), "completedLoops 应被冻结");
    assert.ok(Object.isFrozen(result.milestones), "milestones 应被冻结");
    assert.ok(Object.isFrozen(result.triggeredGuards), "triggeredGuards 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// E. P5StageResult 工厂函数测试
// ============================================================================

test("E1. createSuccessStageResult 返回冻结对象", () => {
  const result = createSuccessStageResult("plan", "测试摘要", { key: "value" }, [], 100, 50);

  assert.equal(result.kind, "success");
  assert.equal(result.stage, "plan");
  assert.equal(result.summary, "测试摘要");
  assert.equal(result.tokensUsed, 100);
  assert.equal(result.durationMs, 50);
  assert.ok(Object.isFrozen(result), "createSuccessStageResult 返回值应被冻结");
});
