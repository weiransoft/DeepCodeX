/**
 * EAG-P5 端到端能力呈现验证（拆分文件 2/5）：FR 核心能力 + 15 条 BLOCKER 守护链端到端触发
 *
 * 本文件由原 `eag-p5-e2e-capability-verification.test.ts` 拆分而来，
 * 集中承载 EAG 核心能力呈现与守护链端到端触发验证：
 *
 * - P 组（P1-P5）：FR-1 4 阶段循环 + FR-2 6 层 BLOCKER + FR-4 三命令 +
 *                  FR-7 NotesMemory + NFR-8 不可变优先
 * - Q 组（Q1-Q15）：15 条 BLOCKER 端到端触发（通过 BlockerGuardChain.execute() 真实触发）
 *
 * 测试约定（严格遵循项目规则 NFR-8 / NFR-9 / NFR-10）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / GuardChain 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行测试命令）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环 + FR-2 6 层 15 条 BLOCKER + FR-4 三命令 + FR-7 NotesMemory
 * - 架构师审查 §4.1 接口契约 + §4.2 BlockerGuardChain 接口契约
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-e2e-fr-guard-chain
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// P5 核心组件导入（AutonomousOrchestrator + 命令处理 + StageHandler + 守护链）
import {
  // AutonomousOrchestrator 主控制器
  AutonomousOrchestrator,
  // StageHandler（P5 验证用）
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  // 守护链
  createDefaultBlockerGuardChain,
  // StageResult 构造工厂
  createSuccessStageResult,
  createFailedStageResult,
  // 守护栏常量
  GUARD_LAYER_ORDER,
  ALL_GUARD_RULE_IDS,
  // Fix 阶段清理意图检测
  detectCleanupIntent,
  // 类型
  type AutonomousRunResult,
  type CompletionEvidence,
  type ChangeDiff,
  // v2.0 新增：守护链与上下文类型（Q 组用）
  type GuardContext,
  type GuardChainResult,
  type GuardVerdict,
  type GuardRuleId,
  type GuardLayer,
  type ChangedFile,
  // 默认配置常量
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
} from "../eag/p5/index";

// 命令处理导入（P4 用）
import { EagAutonomousCommandHandler, extractEagAutonomousRequestFromPrompt } from "../eag/cli/eag-autonomous-command";

// 共享夹具导入
import {
  PASS_TEST_CMD,
  FAIL_TEST_CMD,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  buildOrchestrator,
  buildStageContext,
  createTestTaskCard,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// P 组：EAG 核心能力呈现验证（P1-P5）
// ============================================================================

test("P1. FR-1 4 阶段循环完整呈现：plan → dev → verify → fix 全部执行", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 FR-1 4 阶段循环完整呈现",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 AutonomousRunResult.completedLoops 含 "coding"
    assert.ok(result.completedLoops.includes("coding"), "completedLoops 应含 'coding'");

    // 验证 AutonomousRunResult.milestones 含至少 1 个 P5MilestoneRecord
    assert.ok(result.milestones.length >= 1, "应至少有 1 个里程碑");
    const milestone = result.milestones[0]!;
    assert.equal(typeof milestone.index, "number", "milestone.index 应为 number");
    assert.equal(typeof milestone.name, "string", "milestone.name 应为 string");
    assert.equal(typeof milestone.completedAt, "string", "milestone.completedAt 应为 string");

    // 验证 AutonomousRunResult.totalIterations >= 1
    assert.ok(result.totalIterations >= 1, "应至少迭代 1 次");

    // 验证 AutonomousRunResult.finalReport 非空
    assert.ok(typeof result.finalReport === "string", "finalReport 应为 string");
    assert.ok(result.finalReport.length > 0, "finalReport 应非空");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P2. FR-2 6 层 BLOCKER 护栏呈现：Dev 阶段 G-A1a + G-A5a + Fix 阶段 G-A3b 均可触发", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");

    // 1. 验证 Dev 阶段越界路径触发 G-A1a fatal
    const outsidePath = path.join(os.tmpdir(), "outside-p2-test-file.ts");
    fs.writeFileSync(outsidePath, "// 越界文件", "utf8");

    const taskCardA1a = createTestTaskCard("T-001", [outsidePath], ["OutsideService"]);
    const planResultA1a = createSuccessStageResult("plan", "plan 完成", { taskCard: taskCardA1a }, [], 0, 10);
    const devCtxA1a = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResultA1a]),
    });
    const devResultA1a = await new P5DevStageHandler().handle(devCtxA1a);
    assert.equal(devResultA1a.kind, "fatal", "Dev G-A1a 应返回 fatal");
    assert.equal(devResultA1a.artifacts["guardRuleId"], "G-A1a", "应为 G-A1a");
    fs.unlinkSync(outsidePath);

    // 2. 验证 Dev 阶段凭据文件触发 G-A5a fatal
    const taskCardA5a = createTestTaskCard("T-001", [".env"], ["EnvConfig"]);
    const planResultA5a = createSuccessStageResult("plan", "plan 完成", { taskCard: taskCardA5a }, [], 0, 10);
    const devCtxA5a = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResultA5a]),
    });
    const devResultA5a = await new P5DevStageHandler().handle(devCtxA5a);
    assert.equal(devResultA5a.kind, "fatal", "Dev G-A5a 应返回 fatal");
    assert.equal(devResultA5a.artifacts["guardRuleId"], "G-A5a", "应为 G-A5a");

    // 3. 验证 Fix 阶段 cleanup 命令触发 G-A3b
    assert.equal(detectCleanupIntent("rm -rf /tmp"), true, "G-A3b 应拦截 rm -rf");
    assert.equal(detectCleanupIntent("git reset --hard"), true, "G-A3b 应拦截 git reset --hard");

    // 4. 验证 GUARD_LAYER_ORDER 含 6 层
    assert.equal(GUARD_LAYER_ORDER.length, 6, "GUARD_LAYER_ORDER 应有 6 层");
    assert.ok(GUARD_LAYER_ORDER.includes("A-1"), "应含 A-1 层");
    assert.ok(GUARD_LAYER_ORDER.includes("A-2"), "应含 A-2 层");
    assert.ok(GUARD_LAYER_ORDER.includes("A-3"), "应含 A-3 层");
    assert.ok(GUARD_LAYER_ORDER.includes("A-4"), "应含 A-4 层");
    assert.ok(GUARD_LAYER_ORDER.includes("A-5"), "应含 A-5 层");
    assert.ok(GUARD_LAYER_ORDER.includes("A-6"), "应含 A-6 层");

    // 5. 验证 ALL_GUARD_RULE_IDS 含 15 条 BLOCKER + 1 条 MAJOR（共 16 条）
    assert.equal(ALL_GUARD_RULE_IDS.length, 16, "ALL_GUARD_RULE_IDS 应有 16 条（15 BLOCKER + 1 MAJOR）");
    // 验证关键 BLOCKER ID 存在
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A1a"), "应含 G-A1a");
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A2a"), "应含 G-A2a");
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A3a"), "应含 G-A3a");
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A4a"), "应含 G-A4a");
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A5a"), "应含 G-A5a");
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A6a"), "应含 G-A6a");
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A6d"), "应含 G-A6d");
    // G-A6c 是 MAJOR 级
    assert.ok(ALL_GUARD_RULE_IDS.includes("G-A6c"), "应含 G-A6c（MAJOR）");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P3. FR-7 NotesMemory 跨轮记忆呈现：run() 后 notes.md 文件存在且含迭代摘要", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 FR-7 NotesMemory 跨轮记忆",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 run() 完成后 notes.md 文件存在
    const notesFilePath = path.join(projectRoot, ".eag", "p5", "notes", `${result.runId}.md`);
    assert.ok(fs.existsSync(notesFilePath), `notes.md 文件应存在：${notesFilePath}`);

    // 验证文件内容含 "## Iter" 段落标题（对齐 notes-memory appendNote 的 title 格式）
    const notesContent = fs.readFileSync(notesFilePath, "utf8");
    assert.ok(notesContent.includes("## Iter"), "notes.md 应含 '## Iter' 段落标题");

    // 验证文件内容含任务摘要或失败原因（tags 或 stage 信息）
    // notes 格式含 "tags=" 或 "stage=" 元注释
    assert.ok(
      notesContent.includes("tags=") ||
        notesContent.includes("stage=") ||
        notesContent.includes("success") ||
        notesContent.includes("failed"),
      "notes.md 应含任务摘要或失败原因"
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P4. FR-4 /eag-autonomous 命令完整链路呈现：CLI → handler → orchestrator → result", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 验证 extractEagAutonomousRequestFromPrompt 解析 --goal
    const prompt = `/eag-autonomous --goal "测试 FR-4 命令完整链路" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`;
    const request = extractEagAutonomousRequestFromPrompt(prompt);
    assert.equal(request.goal, "测试 FR-4 命令完整链路", "应正确解析 --goal");
    assert.equal(request.maxIterations, 1, "应正确解析 --max-iterations");
    assert.equal(request.testCommand, PASS_TEST_CMD, "应正确解析 --test-command");

    // 2. 验证 EagAutonomousCommandHandler.execute() 返回 success=true
    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(request, projectRoot);

    assert.equal(result.success, true, "execute 应返回 success=true");

    // 3. 验证 result.runResult 含完整 AutonomousRunResult
    assert.ok(result.runResult, "应包含 runResult");
    const runResult = result.runResult as AutonomousRunResult;
    assert.equal(typeof runResult.runId, "string", "runId 应为 string");
    assert.ok(runResult.runId.length > 0, "runId 应非空");
    assert.ok(
      ["completed", "failed", "aborted", "stop_when"].includes(runResult.finalStatus),
      "finalStatus 应为合法值"
    );
    assert.ok([0, 1, 2, 3].includes(runResult.exitCode), "exitCode 应为合法值");

    // 4. 验证 result.markdownReport 非空
    assert.ok(typeof result.markdownReport === "string", "markdownReport 应为 string");
    assert.ok(result.markdownReport.length > 0, "markdownReport 应非空");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5. NFR-8 不可变优先呈现：所有 readonly 字段 + Object.freeze 冻结", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 NFR-8 不可变优先",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 1. 验证 AutonomousRunResult Object.isFrozen
    assert.ok(Object.isFrozen(result), "AutonomousRunResult 应被冻结");

    // 2. 验证 P5StageResult Object.isFrozen（通过直接构造 StageHandler 测试）
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "test", { taskCard }, [], 0, 10);
    assert.ok(Object.isFrozen(planResult), "P5StageResult 应被冻结");

    // 3. 验证 TaskCard Object.isFrozen
    assert.ok(Object.isFrozen(taskCard), "TaskCard 应被冻结");

    // 4. 验证 CompletionEvidence Object.isFrozen（通过 verify 阶段产出）
    const planResultForVerify = createSuccessStageResult("plan", "plan 完成", { taskCard }, [], 0, 10);
    const devResultForVerify = createSuccessStageResult("dev", "dev 完成", { taskCard }, [], 0, 10);
    const verifyCtx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResultForVerify, devResultForVerify]),
      testCommand: PASS_TEST_CMD,
    });
    const verifyResult = await new P5VerifyStageHandler().handle(verifyCtx);
    const evidence = verifyResult.artifacts["completionEvidence"] as CompletionEvidence;
    assert.ok(Object.isFrozen(evidence), "CompletionEvidence 应被冻结");

    // 5. 验证 FixSuggestion Object.isFrozen（通过 fix 阶段产出）
    const verifyFailResult = createFailedStageResult(
      "verify",
      "failed",
      "测试失败",
      "AssertionError",
      {
        testStats: { passed: 0, failed: 1, skipped: 0, total: 1 },
        completionEvidence: evidence,
        commandResult: { exitCode: 1, timedOut: false },
      },
      [],
      0,
      100
    );
    const fixCtx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([planResultForVerify, devResultForVerify, verifyFailResult]),
    });
    const fixResult = await new P5FixStageHandler().handle(fixCtx);
    const fixSuggestion = fixResult.artifacts["fixSuggestion"];
    assert.ok(Object.isFrozen(fixSuggestion), "FixSuggestion 应被冻结");

    // 6. 验证 AUTONOMOUS_DEFAULT_* 常量 Object.isFrozen
    assert.ok(
      Object.isFrozen(AUTONOMOUS_DEFAULT_MAX_ITERATIONS) || typeof AUTONOMOUS_DEFAULT_MAX_ITERATIONS === "number",
      "AUTONOMOUS_DEFAULT_MAX_ITERATIONS 应为常量"
    );
    assert.ok(
      Object.isFrozen(AUTONOMOUS_DEFAULT_MAX_TOKENS) || typeof AUTONOMOUS_DEFAULT_MAX_TOKENS === "number",
      "AUTONOMOUS_DEFAULT_MAX_TOKENS 应为常量"
    );
    assert.ok(
      Object.isFrozen(AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT) ||
        typeof AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT === "number",
      "AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT 应为常量"
    );
    assert.ok(
      Object.isFrozen(AUTONOMOUS_DEFAULT_TEST_COMMAND) || typeof AUTONOMOUS_DEFAULT_TEST_COMMAND === "string",
      "AUTONOMOUS_DEFAULT_TEST_COMMAND 应为常量"
    );
    assert.ok(
      Object.isFrozen(AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC) || typeof AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC === "number",
      "AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC 应为常量"
    );

    // 验证常量值正确
    assert.equal(AUTONOMOUS_DEFAULT_MAX_ITERATIONS, 10, "默认最大迭代次数应为 10");
    assert.equal(AUTONOMOUS_DEFAULT_MAX_TOKENS, 200000, "默认最大 Token 预算应为 200000");
    assert.equal(AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT, 3, "默认连续失败 abort 阈值应为 3");
    assert.equal(AUTONOMOUS_DEFAULT_TEST_COMMAND, "npm test", "默认测试命令应为 'npm test'");
    assert.equal(AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC, 600, "默认测试超时秒数应为 600");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// Q 组：15 条 BLOCKER 端到端触发验证（Q1-Q15，v2.0 新增）
// ============================================================================
//
// 与既有 eag-p5-guards.test.ts 的区别：
// - 既有 89 个单元测试验证单 Guard.check() 行为
// - Q 组通过 BlockerGuardChain.execute() 端到端触发守护链，验证：
//   ① overallDecision 的正确性（DENY/ASK/PASS）
//   ② firstDenial.ruleId 的正确性（短路中止）
//   ③ firstDenial.severity 的正确性（BLOCKER/MAJOR）
//   ④ 守护链串联执行行为（6 层按序执行）

/**
 * 构造 Q 组测试用的 GuardContext（v2.0 新增）
 *
 * 设计要点：
 * - projectRoot / worktreePath 默认取相同临时项目目录（路径牢笼边界）
 * - 所有字段 readonly + Object.freeze，符合 NFR-8
 * - overrides 允许覆盖任意字段，便于构造违规场景
 * - 与既有 guards.test.ts 的 createContext 区别：本函数用于端到端守护链测试
 *
 * @param projectRoot 项目根目录（路径牢笼边界）
 * @param overrides 覆盖字段（可选）
 * @returns 冻结的 GuardContext
 */
function buildQGuardContext(projectRoot: string, overrides?: Partial<GuardContext>): Readonly<GuardContext> {
  return Object.freeze({
    runId: "test-run-q",
    iterIndex: 0,
    stage: "dev" as const,
    loopType: "coding" as const,
    projectRoot,
    worktreePath: projectRoot,
    confirmationCardAccepted: true,
    emergencyStopRequested: false,
    loopGuardConfig: Object.freeze({
      maxIterations: 10,
      maxTokens: 200_000,
      maxConsecutiveFailures: 3,
    }),
    ...overrides,
  } as GuardContext);
}

/**
 * 构造 Q 组测试用的含/不含生产凭据的环境变量快照（v2.0 新增）
 *
 * @param withProdCreds 是否注入生产凭据
 * @returns 冻结的环境变量快照
 */
function buildQEnvSnapshot(withProdCreds: boolean): Readonly<Record<string, string>> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    NODE_ENV: "development",
  };
  if (withProdCreds) {
    return Object.freeze({
      ...base,
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
  }
  return Object.freeze(base);
}

/**
 * 构造 Q 组测试用的冻结/未冻结上限配置（v2.0 新增）
 *
 * G-A6d 上限不可自改测试需构造未冻结的 loopGuardConfig 触发拦截。
 *
 * @param frozen 是否冻结
 * @returns 上限配置对象（frozen=true 时返回冻结对象）
 */
function buildQLoopGuardConfig(frozen: boolean): Readonly<{
  maxIterations: number;
  maxTokens: number;
  maxConsecutiveFailures: number;
}> {
  const config = {
    maxIterations: 10,
    maxTokens: 200_000,
    maxConsecutiveFailures: 3,
  };
  return frozen ? Object.freeze(config) : config;
}

/**
 * 构造 Q 组测试用的完整 CompletionEvidence（v2.0 新增）
 *
 * @param overrides 覆盖字段（可选）
 * @returns 冻结的 CompletionEvidence
 */
function buildQCompletionEvidence(overrides?: Partial<CompletionEvidence>): Readonly<CompletionEvidence> {
  return Object.freeze({
    testCommand: PASS_TEST_CMD,
    testExitCode: 0,
    testOutputSummary: "Tests: 1 passed, 0 failed",
    coveragePercent: 85,
    evaluatorVerdict: "pass",
    executedAt: new Date().toISOString(),
    ...overrides,
  });
}

/**
 * 构造 Q 组测试用的 ChangeDiff（v2.0 新增）
 *
 * @param filePaths 变更文件路径列表
 * @returns 冻结的 ChangeDiff
 */
function buildQChangeDiff(filePaths: string[]): Readonly<ChangeDiff> {
  const changedFiles: ChangedFile[] = filePaths.map((filePath) => ({
    filePath,
    changeType: "modified" as const,
    additions: 5,
    deletions: 2,
  }));
  return Object.freeze({
    changedFiles: Object.freeze(changedFiles),
    affectedSymbols: Object.freeze([]),
    totalAdditions: changedFiles.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: changedFiles.reduce((sum, f) => sum + f.deletions, 0),
  });
}

// ----------------------------------------------------------------------------
// Q1: G-A1a 路径牢笼端到端触发
// ----------------------------------------------------------------------------

test("Q1. G-A1a 路径牢笼端到端触发：Dev 阶段越界路径命令 → 守护链 DENY + firstDenial", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含越界路径的 GuardContext（命令含系统目录绝对路径）
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommand: "rm /etc/passwd",
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A1a", "firstDenial 规则 ID 应为 G-A1a");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
    assert.equal(result.firstDenial!.decision, "DENY", "决策应为 DENY");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q2: G-A1b 环境变量写保护端到端触发
// ----------------------------------------------------------------------------

test("Q2. G-A1b 环境变量写保护端到端触发：export HOME → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含环境变量写操作的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommand: "export HOME=/tmp/evil",
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A1b", "firstDenial 规则 ID 应为 G-A1b");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
    assert.match(result.firstDenial!.reason, /HOME/, "拦截原因应含 HOME");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q3: G-A1c 生产凭据不可达端到端触发
// ----------------------------------------------------------------------------

test("Q3. G-A1c 生产凭据不可达端到端触发：envSnapshot 含 AWS_ACCESS_KEY_ID → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含生产凭据的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      envSnapshot: buildQEnvSnapshot(true),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A1c", "firstDenial 规则 ID 应为 G-A1c");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q4: G-A2a 黑名单永禁端到端触发
// ----------------------------------------------------------------------------

test("Q4. G-A2a 黑名单端到端触发：rm -rf / → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含黑名单命令的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommand: "rm -rf /",
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A2a", "firstDenial 规则 ID 应为 G-A2a");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
    assert.match(result.firstDenial!.reason, /rm -rf/, "拦截原因应含 rm -rf");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q5: G-A2b 删除分级端到端触发（批量 > 3 文件 → ASK）
// ----------------------------------------------------------------------------

test("Q5. G-A2b 删除分级端到端触发：批量删除 > 3 文件 → 守护链 ASK", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含批量删除命令的 GuardContext（4 个文件 > 阈值 3）
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommand: "rm file1.txt file2.txt file3.txt file4.txt",
      currentTaskCard: Object.freeze({
        id: "T-001",
        title: "测试任务",
        requirementId: "F-001",
        dependencies: Object.freeze([]),
        acceptanceCriteria: Object.freeze(["测试通过"]),
        status: "in-progress" as const,
        declaredSymbols: Object.freeze([]),
        declaredFiles: Object.freeze(["file1.txt"]),
        declaredDeletions: Object.freeze(["file1.txt", "file2.txt", "file3.txt", "file4.txt"]),
      }),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为（G-A2b 触发 ASK，整体应为 ASK）
    // 注意：firstDenial 仅记录 DENY 决策，ASK 决策需检查 triggeredGuards
    assert.equal(result.overallDecision, "ASK", "整体决策应为 ASK");
    const a2bVerdict = result.triggeredGuards.find((v) => v.ruleId === "G-A2b");
    assert.ok(a2bVerdict, "triggeredGuards 应含 G-A2b 判定");
    assert.equal(a2bVerdict!.decision, "ASK", "G-A2b 决策应为 ASK");
    assert.equal(a2bVerdict!.severity, "BLOCKER", "严重性应为 BLOCKER");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q6: G-A2c 白名单收敛端到端触发（未知命令 → ASK）
// ----------------------------------------------------------------------------

test("Q6. G-A2c 白名单收敛端到端触发：未知命令 → 守护链 ASK", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含未知命令的 GuardContext（unknown-command 不在白名单内）
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommand: "unknown-command --flag value",
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为（G-A2c 触发 ASK，整体应为 ASK）
    // 注意：firstDenial 仅记录 DENY 决策，ASK 决策需检查 triggeredGuards
    assert.equal(result.overallDecision, "ASK", "整体决策应为 ASK");
    const a2cVerdict = result.triggeredGuards.find((v) => v.ruleId === "G-A2c");
    assert.ok(a2cVerdict, "triggeredGuards 应含 G-A2c 判定");
    assert.equal(a2cVerdict!.decision, "ASK", "G-A2c 决策应为 ASK");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q7: G-A3a 范围锁端到端触发（变更文件 ∉ declaredFiles → ASK）
// ----------------------------------------------------------------------------

test("Q7. G-A3a 范围锁端到端触发：变更文件 ∉ declaredFiles → 守护链 ASK", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含越界变更的 GuardContext（changedFiles 含 src/b.ts，但 declaredFiles 仅 src/a.ts）
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      currentTaskCard: Object.freeze({
        id: "T-001",
        title: "测试任务",
        requirementId: "F-001",
        dependencies: Object.freeze([]),
        acceptanceCriteria: Object.freeze(["测试通过"]),
        status: "in-progress" as const,
        declaredSymbols: Object.freeze([]),
        declaredFiles: Object.freeze(["src/a.ts"]),
        declaredDeletions: Object.freeze([]),
      }),
      currentDiff: buildQChangeDiff(["src/b.ts"]),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为（G-A3a 触发 ASK，整体应为 ASK）
    // 注意：firstDenial 仅记录 DENY 决策，ASK 决策需检查 triggeredGuards
    assert.equal(result.overallDecision, "ASK", "整体决策应为 ASK");
    const a3aVerdict = result.triggeredGuards.find((v) => v.ruleId === "G-A3a");
    assert.ok(a3aVerdict, "triggeredGuards 应含 G-A3a 判定");
    assert.equal(a3aVerdict!.decision, "ASK", "G-A3a 决策应为 ASK");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q8: G-A3b 清理意图永禁端到端触发
// ----------------------------------------------------------------------------

test("Q8. G-A3b 清理意图永禁端到端触发：任务卡标题含 reset → 守护链 ASK", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含清理类关键词任务卡的 GuardContext
    // 注意：pendingCommand 必须通过 A-2 层白名单（如 "npm test"），
    // 否则 G-A2c 会先在 A-2 层 ASK 短路中止，A-3 层永远不执行。
    // G-A3b 检查 pendingCommand 或 currentTaskCard.title 含清理类关键词，
    // 此处通过任务卡标题 "Reset user configuration" 触发 G-A3b。
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommand: "npm test",
      currentTaskCard: Object.freeze({
        id: "T-001",
        title: "Reset user configuration",
        requirementId: "F-001",
        dependencies: Object.freeze([]),
        acceptanceCriteria: Object.freeze(["测试通过"]),
        status: "in-progress" as const,
        declaredSymbols: Object.freeze([]),
        declaredFiles: Object.freeze(["src/services/UserService.ts"]),
        declaredDeletions: Object.freeze([]),
      }),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为（G-A3b 触发 ASK，整体应为 ASK）
    // 注意：firstDenial 仅记录 DENY 决策，ASK 决策需检查 triggeredGuards
    assert.equal(result.overallDecision, "ASK", "整体决策应为 ASK");
    const a3bVerdict = result.triggeredGuards.find((v) => v.ruleId === "G-A3b");
    assert.ok(a3bVerdict, "triggeredGuards 应含 G-A3b 判定");
    assert.equal(a3bVerdict!.decision, "ASK", "G-A3b 决策应为 ASK");
    // 验证 detectCleanupIntent 返回 true（命令含 cleanup 关键词也应识别）
    assert.equal(detectCleanupIntent("cleanup logs"), true, "detectCleanupIntent 应识别 cleanup 关键词");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q9: G-A4a 证据强制端到端触发（verify 阶段缺少证据 → DENY）
// ----------------------------------------------------------------------------

test("Q9. G-A4a 证据强制端到端触发：verify 阶段缺少 completionEvidence → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造 verify 阶段但缺少 completionEvidence 的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      stage: "verify",
      completionEvidence: undefined,
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A4a", "firstDenial 规则 ID 应为 G-A4a");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
    assert.match(result.firstDenial!.reason, /completionEvidence/, "拦截原因应含 completionEvidence");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q10: G-A4b stop_when 确定性判定端到端触发（非确定性条件 → DENY）
// ----------------------------------------------------------------------------

test("Q10. G-A4b stop_when 确定性判定端到端触发：非确定性条件 → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含非确定性 stop_when 表达式的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      stopWhenExpression: "looks good",
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A4b", "firstDenial 规则 ID 应为 G-A4b");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q11: G-A5a 凭据读取白名单端到端触发（读取 .env → DENY）
// ----------------------------------------------------------------------------

test("Q11. G-A5a 凭据读取白名单端到端触发：读取 .env → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含 .env 读取请求的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingReadFiles: Object.freeze([".env", "src/config.ts"]),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A5a", "firstDenial 规则 ID 应为 G-A5a");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
    assert.match(result.firstDenial!.reason, /\.env/, "拦截原因应含 .env");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q12: G-A5b commit 前扫描端到端触发（检出 AWS Access Key → DENY）
// ----------------------------------------------------------------------------

test("Q12. G-A5b commit 前扫描端到端触发：检出 AWS Access Key → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造含 AWS Access Key 的待提交文件（创建真实文件触发 gitleaks 扫描）
    const credFilePath = path.join(projectRoot, "config", "aws-credentials.json");
    fs.mkdirSync(path.dirname(credFilePath), { recursive: true });
    fs.writeFileSync(
      credFilePath,
      '{"aws_access_key_id": "AKIAIOSFODNN7EXAMPLE", "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}'
    );

    // 构造含密钥文件的 pendingCommitFiles
    const ctx = buildQGuardContext(projectRoot, {
      stage: "dev",
      pendingCommitFiles: Object.freeze(["config/aws-credentials.json"]),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A5b", "firstDenial 规则 ID 应为 G-A5b");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q13: G-A6a 确认卡前置端到端触发（首次迭代未确认 → DENY）
// ----------------------------------------------------------------------------

test("Q13. G-A6a 确认卡前置端到端触发：首次迭代未确认 → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造首次迭代 + 未确认的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      iterIndex: 0,
      confirmationCardAccepted: false,
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A6a", "firstDenial 规则 ID 应为 G-A6a");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q14: G-A6b 熔断回滚端到端触发（emergencyStopRequested → DENY）
// ----------------------------------------------------------------------------

test("Q14. G-A6b 熔断回滚端到端触发：emergencyStopRequested=true → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造熔断请求的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      emergencyStopRequested: true,
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A6b", "firstDenial 规则 ID 应为 G-A6b");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// Q15: G-A6d 上限冻结端到端触发（loopGuardConfig 未冻结 → DENY）
// ----------------------------------------------------------------------------

test("Q15. G-A6d 上限冻结端到端触发：loopGuardConfig 未冻结 → 守护链 DENY", async () => {
  const projectRoot = createTempProject();
  try {
    // 构造未冻结 loopGuardConfig 的 GuardContext
    const ctx = buildQGuardContext(projectRoot, {
      loopGuardConfig: buildQLoopGuardConfig(false),
    });

    // 端到端调用守护链
    const chain = createDefaultBlockerGuardChain({ throwOnDeny: false });
    const result = await chain.execute(ctx);

    // 验证守护链端到端行为
    assert.equal(result.overallDecision, "DENY", "整体决策应为 DENY");
    assert.ok(result.firstDenial, "应存在 firstDenial");
    assert.equal(result.firstDenial!.ruleId, "G-A6d", "firstDenial 规则 ID 应为 G-A6d");
    assert.equal(result.firstDenial!.severity, "BLOCKER", "严重性应为 BLOCKER");
    // 验证 Object.isFrozen 检测
    assert.equal(Object.isFrozen(buildQLoopGuardConfig(false)), false, "未冻结配置应被检测");
    assert.equal(Object.isFrozen(buildQLoopGuardConfig(true)), true, "冻结配置应通过检测");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
