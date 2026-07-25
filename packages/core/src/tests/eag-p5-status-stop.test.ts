/**
 * EAG-P5 /eag-autonomous-status 与 /eag-autonomous-stop 命令单元测试
 * （TASK-P5-3.1-005/006 验收标准 3、4，设计文档 v1.1 §6.1）
 *
 * 测试范围（对齐设计文档 §6.1 测试计划）：
 * - A. status() 方法（TC-STATUS-01 ~ 07）
 *   - 查询运行中/已完成/不存在的 runId
 *   - 报告含迭代次数 / token 统计 / 当前阶段 / 启动时间
 * - B. stop() 方法（TC-STOP-01 ~ 13）
 *   - 中止正在运行/暂停的 run（创建 abort 文件）
 *   - 回滚已完成/失败/中止的 run（返回 HEAD SHA + 未提交清单）
 *   - 不存在的 runId / abort 文件目录自动创建 / git 命令失败
 *   - 跨 session 中止 / 多次调用幂等性
 * - C. run() 循环 abort 检查（TC-RUN-01 ~ 04）
 *   - 正常完成/异常退出/中止后清理 abort 文件
 *   - 清理失败不抛异常
 * - D. CLI 命令解析（TC-CLI-01 ~ 09）
 *   - /eag-autonomous-status / /eag-autonomous-stop 命令解析
 *   - 缺少 runId / 大小写不敏感 / parser 优先匹配
 *   - EAG_COMMAND_STRINGS 包含 10 个命令
 *   - /eag-autonomous 不被误判为 status/stop
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 RunStateStore / AutonomousOrchestrator 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（git init + git rev-parse + git status）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 *
 * 设计依据：
 * - 设计文档 v1.1 §3.2（status）/ §3.3（stop）/ §3.4（run 循环修改）/ §3.5（CLI 命令解析）
 * - 需求文档 TASK-P5-3.1-005/006 验收标准
 *
 * @module core/tests/eag-p5-status-stop
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFileSync } from "node:child_process";

import type { P5LoopExecutor } from "../eag/p5";
import {
  AutonomousOrchestrator,
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  createP5LoopExecutorFromHandlers,
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  type P5RunState,
} from "../eag/p5";
import { EagCommandParser, EAG_COMMAND_STRINGS } from "../eag/cli/eag-command-parser";
import {
  extractEagAutonomousStatusRequestFromPrompt,
  extractEagAutonomousStopRequestFromPrompt,
} from "../eag/cli/eag-autonomous-command";
import { SessionManager } from "../session";

// ============================================================================
// 1. 测试辅助函数
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
  const prefix = path.join(os.tmpdir(), "eag-p5-status-stop-test-");
  const projectRoot = fs.mkdtempSync(prefix);
  // 创建 .eag/p5 子目录（run-state-store 会用到）
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
 * 在临时目录初始化 git 仓库（用于测试 git rev-parse / git status 命令）
 *
 * 算法：
 * 1. git init
 * 2. git config user.email / user.name（避免提交时无身份错误）
 * 3. 创建 README.md 并 git add + git commit（生成初始 HEAD SHA）
 *
 * @param projectRoot 项目根目录
 */
function initGitRepo(projectRoot: string): void {
  execSync("git init", { cwd: projectRoot, timeout: 10_000 });
  execSync('git config user.email "test@example.com"', { cwd: projectRoot, timeout: 5_000 });
  execSync('git config user.name "Test User"', { cwd: projectRoot, timeout: 5_000 });
  // 创建初始提交以生成 HEAD SHA
  const readmePath = path.join(projectRoot, "README.md");
  fs.writeFileSync(readmePath, "# Test Project\n", "utf8");
  execSync("git add README.md", { cwd: projectRoot, timeout: 5_000 });
  execSync('git commit -m "initial commit"', { cwd: projectRoot, timeout: 10_000 });
}

/**
 * 在临时目录创建未提交改动（用于测试 git status --porcelain 输出）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径
 */
function createUncommittedFile(projectRoot: string, relativePath: string): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, "// 未提交的测试文件\n", "utf8");
}

/**
 * 构造真实的 AutonomousOrchestrator 实例（使用真实的 5 个核心依赖）
 *
 * @returns AutonomousOrchestrator 实例
 */
function buildOrchestrator(): AutonomousOrchestrator {
  const loopExecutor: P5LoopExecutor = createP5LoopExecutorFromHandlers(
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
  });
}

/**
 * 初始化 RunState 并保存指定状态（用于 status/stop 测试的前置数据）
 *
 * 算法：
 * 1. 调用 P5RunStateStore.initialize() 创建初始状态文件
 * 2. 调用 P5RunStateStore.save() 追加指定状态（如 status=completed）
 *
 * @param store RunStateStore 实例
 * @param projectRoot 项目根目录
 * @param runId run-id
 * @param overrides 状态覆盖字段
 * @returns 最终保存的 P5RunState
 */
async function initializeAndSaveState(
  store: P5RunStateStore,
  projectRoot: string,
  runId: string,
  overrides: Partial<P5RunState> = {}
): Promise<Readonly<P5RunState>> {
  // 步骤 1：初始化 RunState 文件
  const initialState = await store.initialize({
    projectRoot,
    objective: "测试目标",
    runId,
    maxIterations: 10,
  });

  // 步骤 2：追加指定状态（覆盖字段）
  const updatedState = await store.save({
    ...initialState,
    iterIndex: 3,
    currentStage: "verify",
    completedLoops: Object.freeze(["coding"]),
    totalTokensUsed: 45230,
    totalLlmCallCount: 12,
    consecutiveFailures: 0,
    ...overrides,
  });

  return updatedState;
}

// ============================================================================
// A. status() 方法测试（TC-STATUS-01 ~ 07）
// ============================================================================

test("TC-STATUS-01. status() 查询正在运行的 run", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-status-01";
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    const result = await orchestrator.status(runId, projectRoot);

    assert.equal(result.found, true);
    assert.equal(result.runId, runId);
    assert.equal(result.status, "running");
    assert.ok(result.report.includes("Autonomous Run Status"));
    assert.ok(result.report.includes(runId));
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STATUS-02. status() 查询已完成的 run", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-status-02";
    await initializeAndSaveState(store, projectRoot, runId, { status: "completed" });

    const result = await orchestrator.status(runId, projectRoot);

    assert.equal(result.found, true);
    assert.equal(result.status, "completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STATUS-03. status() 查询不存在的 runId", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.status("nonexistent-run-id", projectRoot);

    assert.equal(result.found, false);
    // P2-4 修复：加强弱断言——既有实现仅检查 report.length > 0，无法区分"未找到"与"查询成功但报告为空"
    // 改为精确检查 report 含"未找到"关键词，并验证 found=false 时其他字段为占位默认值（对齐 P2-12 JSDoc 说明）
    assert.ok(result.report.includes("未找到"), "report 应含'未找到'提示");
    // 验证占位默认值（found=false 时其他字段不代表真实状态）
    assert.equal(result.status, "failed");
    assert.equal(result.iterIndex, 0);
    assert.equal(result.maxIterations, 0);
    assert.equal(result.totalTokensUsed, 0);
    assert.equal(result.totalLlmCallCount, 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STATUS-04. status() 报告含迭代次数", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-status-04";
    await initializeAndSaveState(store, projectRoot, runId, {
      status: "running",
      iterIndex: 3,
      maxIterations: 10,
    });

    const result = await orchestrator.status(runId, projectRoot);

    assert.equal(result.iterIndex, 3);
    assert.equal(result.maxIterations, 10);
    // P2-4 修复：加强弱断言——既有实现仅检查 report 含 "3" 和 "10"，
    // 可能匹配到其他字段（如 token 统计、时间戳中的数字）。
    // 改为精确检查 "3 / 10" 格式的迭代次数字符串
    assert.ok(result.report.includes("3 / 10"), "report 应含 '3 / 10' 格式的迭代次数");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STATUS-05. status() 报告含 token 统计", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-status-05";
    await initializeAndSaveState(store, projectRoot, runId, {
      status: "running",
      totalTokensUsed: 45230,
      totalLlmCallCount: 12,
    });

    const result = await orchestrator.status(runId, projectRoot);

    assert.equal(result.totalTokensUsed, 45230);
    assert.equal(result.totalLlmCallCount, 12);
    assert.ok(result.report.includes("45230"));
    assert.ok(result.report.includes("12"));
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STATUS-06. status() 报告含当前阶段", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-status-06";
    await initializeAndSaveState(store, projectRoot, runId, {
      status: "running",
      currentStage: "verify",
    });

    const result = await orchestrator.status(runId, projectRoot);

    assert.equal(result.currentStage, "verify");
    // P2-4 修复：加强弱断言——既有实现仅检查 report 含 "verify"，
    // 可能匹配到其他字段（如 stop_when 条件、阻塞阶段名）。
    // 改为同时检查 "当前阶段" 标签 + "verify" 值，确保匹配的是状态报告中的阶段字段
    assert.ok(result.report.includes("当前阶段"), "report 应含'当前阶段'标签");
    assert.ok(result.report.includes("verify"), "report 应含 'verify' 阶段值");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STATUS-07. status() 报告含启动时间", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-status-07";
    const state = await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    const result = await orchestrator.status(runId, projectRoot);

    assert.equal(result.startedAt, state.startedAt);
    assert.ok(result.report.includes(state.startedAt));
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B. stop() 方法测试（TC-STOP-01 ~ 13）
// ============================================================================

test("TC-STOP-01. stop() 中止正在运行的 run", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-01";
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "abort");
    assert.equal(result.success, true);
    assert.equal(result.runStatus, "running");
    // 验证 abort 文件已创建
    const abortFilePath = path.join(projectRoot, ".eag", "p5", "abort-flags", `${runId}.abort`);
    assert.ok(fs.existsSync(abortFilePath), "abort 标志文件应已创建");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-02. stop() 中止暂停的 run", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-02";
    await initializeAndSaveState(store, projectRoot, runId, { status: "paused" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "abort");
    assert.equal(result.success, true);
    assert.equal(result.runStatus, "paused");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-03. stop() 回滚已完成的 run", async () => {
  const projectRoot = createTempProject();
  try {
    initGitRepo(projectRoot);
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-03";
    await initializeAndSaveState(store, projectRoot, runId, { status: "completed" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "rollback");
    assert.equal(result.success, true);
    assert.equal(result.runStatus, "completed");
    // headSha 应为非空字符串（40 字符 SHA）
    assert.ok(result.headSha, "headSha 应非空");
    assert.ok(result.headSha!.length >= 7, "headSha 应至少 7 字符（短 SHA）");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-04. stop() 回滚已失败的 run", async () => {
  const projectRoot = createTempProject();
  try {
    initGitRepo(projectRoot);
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-04";
    await initializeAndSaveState(store, projectRoot, runId, { status: "failed" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "rollback");
    assert.equal(result.success, true);
    assert.equal(result.runStatus, "failed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-05. stop() 回滚已中止的 run", async () => {
  const projectRoot = createTempProject();
  try {
    initGitRepo(projectRoot);
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-05";
    await initializeAndSaveState(store, projectRoot, runId, { status: "aborted" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "rollback");
    assert.equal(result.success, true);
    assert.equal(result.runStatus, "aborted");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-06. stop() 不存在的 runId", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.stop("nonexistent-run-id", projectRoot);

    assert.equal(result.success, false);
    // P2-4 修复：加强弱断言——既有实现仅检查 report.length > 0，无法区分"未找到"与"操作成功但报告为空"
    // 改为精确检查 report 含"未找到"关键词，并验证 action="not-found"（对齐 P1-2 修复）
    assert.ok(result.report.includes("未找到"), "report 应含'未找到'提示");
    // P1-2 修复验证：action 应为 "not-found"（而非旧实现的 "abort"）
    assert.equal(result.action, "not-found");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-07. stop() abort 文件目录自动创建", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-07";
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    // 删除 abort-flags 目录（如果存在）
    const abortFlagsDir = path.join(projectRoot, ".eag", "p5", "abort-flags");
    if (fs.existsSync(abortFlagsDir)) {
      fs.rmSync(abortFlagsDir, { recursive: true, force: true });
    }

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.success, true);
    // 验证目录被自动创建
    assert.ok(fs.existsSync(abortFlagsDir), "abort-flags 目录应被自动创建");
    // 验证 abort 文件已创建
    const abortFilePath = path.join(abortFlagsDir, `${runId}.abort`);
    assert.ok(fs.existsSync(abortFilePath), "abort 文件应已创建");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-08. stop() 回滚时列出未提交改动", async () => {
  const projectRoot = createTempProject();
  try {
    initGitRepo(projectRoot);
    // 创建未提交改动
    createUncommittedFile(projectRoot, "src/uncommitted-file.ts");

    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-08";
    await initializeAndSaveState(store, projectRoot, runId, { status: "completed" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "rollback");
    assert.equal(result.success, true);
    // 验证未提交文件清单非空
    assert.ok(result.uncommittedFiles, "uncommittedFiles 应非空");
    assert.ok(result.uncommittedFiles!.length > 0, "应至少有 1 个未提交文件");
    // 验证包含创建的文件
    const hasUncommittedFile = result.uncommittedFiles!.some((f) => f.includes("uncommitted-file.ts"));
    assert.ok(hasUncommittedFile, "未提交清单应包含 src/uncommitted-file.ts");
    // P2-11 修复：验证 uncommittedFiles 不可变性（Object.freeze 冻结）
    // 不可变优先原则要求所有返回的数组字段通过 Object.freeze 冻结，
    // 调用方尝试 push/splice 应静默失败（严格模式下抛 TypeError）
    assert.ok(Object.isFrozen(result.uncommittedFiles), "uncommittedFiles 应被 Object.freeze 冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-09. stop() 回滚时获取 HEAD SHA", async () => {
  const projectRoot = createTempProject();
  try {
    initGitRepo(projectRoot);
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-09";
    await initializeAndSaveState(store, projectRoot, runId, { status: "completed" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "rollback");
    assert.ok(result.headSha, "headSha 应非空");
    // HEAD SHA 应为 40 字符的 SHA-1 哈希
    assert.equal(result.headSha!.length, 40, "headSha 应为 40 字符 SHA-1");
    // 验证与实际 git rev-parse HEAD 一致
    const actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    assert.equal(result.headSha, actualSha, "headSha 应与 git rev-parse HEAD 一致");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-10. stop() 回滚时 git 命令失败（projectRoot 不是 git 仓库）", async () => {
  const projectRoot = createTempProject();
  try {
    // 不初始化 git 仓库
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-10";
    await initializeAndSaveState(store, projectRoot, runId, { status: "completed" });

    const result = await orchestrator.stop(runId, projectRoot);

    assert.equal(result.action, "rollback");
    assert.equal(result.success, true); // stop 本身成功，只是 git 命令失败
    // headSha 应为空或 undefined（git 命令失败）
    assert.ok(!result.headSha || result.headSha.length === 0, "headSha 应为空（git 命令失败）");
    // 报告应含 WARN 提示
    assert.ok(
      result.report.includes("Git") || result.report.includes("git") || result.report.includes("⚠️"),
      "报告应含 git 错误提示"
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-11. stop() 跨 session 中止场景（模拟）", async () => {
  const projectRoot = createTempProject();
  try {
    // 模拟跨 session：orchestrator A 创建运行状态，orchestrator B 创建 abort 文件
    const storeA = new P5RunStateStore();
    const orchestratorA = buildOrchestrator();
    const orchestratorB = buildOrchestrator();
    const runId = "test-stop-11";
    await initializeAndSaveState(storeA, projectRoot, runId, { status: "running" });

    // Session B 调用 stop() 创建 abort 文件
    const stopResult = await orchestratorB.stop(runId, projectRoot);

    assert.equal(stopResult.action, "abort");
    assert.equal(stopResult.success, true);

    // 验证 abort 文件已创建（Session A 的 run() 会在下次迭代检测到）
    const abortFilePath = path.join(projectRoot, ".eag", "p5", "abort-flags", `${runId}.abort`);
    assert.ok(fs.existsSync(abortFilePath), "abort 文件应已创建");

    // Session A 仍可查询状态（status 不受 abort 文件影响）
    const statusResult = await orchestratorA.status(runId, projectRoot);
    assert.equal(statusResult.found, true);
    assert.equal(statusResult.status, "running");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-12. stop() 多次调用幂等性", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-12";
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    // 第一次调用
    const result1 = await orchestrator.stop(runId, projectRoot);
    assert.equal(result1.success, true);

    // 第二次调用（abort 文件已存在，应幂等成功）
    const result2 = await orchestrator.stop(runId, projectRoot);
    assert.equal(result2.success, true);
    assert.equal(result2.action, "abort");

    // 验证 abort 文件仍然存在
    const abortFilePath = path.join(projectRoot, ".eag", "p5", "abort-flags", `${runId}.abort`);
    assert.ok(fs.existsSync(abortFilePath), "abort 文件应仍存在");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-13. stop() 入参校验（runId 为空字符串）", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    await assert.rejects(() => orchestrator.stop("", projectRoot), /runId 必须为非空字符串/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-14. stop() 入参校验（projectRoot 为空字符串）", async () => {
  const orchestrator = buildOrchestrator();
  await assert.rejects(() => orchestrator.stop("some-run-id", ""), /projectRoot 必须为非空字符串/);
});

test("TC-STOP-15. status() 入参校验（runId 为空字符串）", async () => {
  const orchestrator = buildOrchestrator();
  await assert.rejects(() => orchestrator.status("", "/some/path"), /runId 必须为非空字符串/);
});

test("TC-STOP-16. stop()→run() 跨方法集成测试（P1-4 新增）", async () => {
  // P1-4 新增：验证 stop() 创建的 abort 文件能被 run() 检测到并中止
  // 与 TC-RUN-04 的区别：TC-RUN-04 手动创建 abort 文件，本测试通过 stop() API 创建
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（让 plan 阶段能解析任务卡）
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    fs.writeFileSync(
      tasksFilePath,
      ["# EAG-P5 任务清单", "", "## T-001 测试任务", "- requirement: F-001", "- status: pending", ""].join("\n"),
      "utf8"
    );
    createDeclaredFileForTest(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const store = new P5RunStateStore();
    const runId = "test-stop-16-integration";

    // 步骤 1：初始化 RunState（status="running"，模拟 run() 正在运行）
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    // 步骤 2：调用 stop() 创建 abort 标志文件
    const stopResult = await orchestrator.stop(runId, projectRoot);
    assert.equal(stopResult.action, "abort");
    assert.equal(stopResult.success, true);

    // 验证 abort 文件已创建
    const abortFilePath = path.join(projectRoot, ".eag", "p5", "abort-flags", `${runId}.abort`);
    assert.ok(fs.existsSync(abortFilePath), "stop() 应创建 abort 标志文件");

    // 步骤 3：调用 run()——应在首次迭代检测到 abort 文件并中止
    // 注：run() 内部会调用 store.initialize()，但该 runId 已存在 RunState 文件，
    //     会抛 already-exists 错误。为避免此问题，先删除既有 RunState 文件。
    //     （实际场景中 stop() 在 run() 运行期间调用，不会出现 initialize 冲突；
    //      此处是测试环境的模拟，通过删除 RunState 文件模拟"run() 首次启动"场景）
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    const runStateFile = path.join(runStateDir, `${runId}.jsonl`);
    if (fs.existsSync(runStateFile)) {
      fs.unlinkSync(runStateFile);
    }

    const runResult = await orchestrator.run({
      projectRoot,
      objective: "测试 stop()→run() 跨方法集成",
      runId,
      maxIterations: 3,
      testCommand: "echo 'Tests: 1 passed, 0 failed'",
      testTimeoutSec: 30,
    });

    // 验证 run() 因 abort 文件而中止
    assert.equal(runResult.finalStatus, "aborted");
    assert.equal(runResult.exitCode, 2);

    // 验证 abort 文件已被 run() finally 块清理
    assert.ok(!fs.existsSync(abortFilePath), "abort 文件应已被 run() finally 块清理");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-STOP-17. stop() runId 路径遍历校验（P2-2 新增）", async () => {
  // P2-2 新增：验证 stop() 入参 runId 路径遍历校验
  // runId 含路径分隔符（如 ../）应抛错，防止路径遍历攻击
  const orchestrator = buildOrchestrator();
  await assert.rejects(() => orchestrator.stop("../etc/passwd", "/some/path"), /runId 格式非法/);
});

test("TC-STOP-18. status() runId 路径遍历校验（P2-2 新增）", async () => {
  // P2-2 新增：验证 status() 入参 runId 路径遍历校验
  const orchestrator = buildOrchestrator();
  await assert.rejects(() => orchestrator.status("../etc/passwd", "/some/path"), /runId 格式非法/);
});

// ============================================================================
// C. run() 循环 abort 检查测试（TC-RUN-01 ~ 04）
// ============================================================================

test("TC-RUN-01. run() 正常完成后清理 abort 文件", async () => {
  // P1-3 修复：改为真正调用 run()，而非直接调用 cleanupAbortFlag 私有方法
  // 既有实现通过反射调用 cleanupAbortFlag，仅测试清理逻辑本身，
  // 未覆盖 run() finally 块的实际清理行为（可能存在 finally 块未执行等集成问题）
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（让 plan 阶段能解析任务卡）
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    fs.writeFileSync(
      tasksFilePath,
      ["# EAG-P5 任务清单", "", "## T-001 测试任务", "- requirement: F-001", "- status: pending", ""].join("\n"),
      "utf8"
    );
    createDeclaredFileForTest(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const runId = "test-run-01-cleanup";

    // 预先创建 abort 文件（模拟 stop() 在 run() 启动前已调用）
    // run() 在首次迭代顶部检测到 abort 文件后中止，finally 块应清理该文件
    const abortFlagsDir = path.join(projectRoot, ".eag", "p5", "abort-flags");
    fs.mkdirSync(abortFlagsDir, { recursive: true });
    const abortFilePath = path.join(abortFlagsDir, `${runId}.abort`);
    fs.writeFileSync(abortFilePath, "", "utf-8");
    assert.ok(fs.existsSync(abortFilePath), "前置：abort 文件应存在");

    // 调用 run()——应在首次迭代检测到 abort 文件并中止，finally 块清理 abort 文件
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 abort 中止后清理 abort 文件",
      runId,
      maxIterations: 3,
      testCommand: "echo 'Tests: 1 passed, 0 failed'",
      testTimeoutSec: 30,
    });

    // 验证 run() 因 abort 文件而中止
    assert.equal(result.finalStatus, "aborted");
    // 验证 abort 文件已被 finally 块清理
    assert.ok(!fs.existsSync(abortFilePath), "abort 文件应已被 finally 块清理");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-RUN-02. cleanupAbortFlag 文件不存在时静默跳过", async () => {
  // 注：此测试直接调用 cleanupAbortFlag 私有方法（通过反射），
  // 因为"文件不存在时静默跳过"是 cleanupAbortFlag 的边界条件，
  // 通过 run() 难以触发（run() 退出时 abort 文件要么存在要么不存在，
  // 不存在时 cleanupAbortFlag 本就静默跳过，无法区分"正常跳过"与"从未创建"）。
  // P1-3 改造仅覆盖 TC-RUN-01（主流程），边界条件保留直接调用私有方法。
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const runId = "test-run-02-nonexistent";

    // 不创建 abort 文件，直接调用 cleanupAbortFlag
    const cleanupMethod = (
      orchestrator as unknown as {
        cleanupAbortFlag: (runId: string, projectRoot: string) => void;
      }
    ).cleanupAbortFlag;

    // 应静默跳过，不抛异常
    assert.doesNotThrow(() => {
      cleanupMethod.call(orchestrator, runId, projectRoot);
    });
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-RUN-03. cleanupAbortFlag 清理失败不抛异常（projectRoot 不存在）", async () => {
  // 注：此测试直接调用 cleanupAbortFlag 私有方法（通过反射），
  // 因为"清理失败不抛异常"是 cleanupAbortFlag 的容错边界条件，
  // 通过 run() 难以触发（run() 使用已 resolve 的 projectRoot，理论不会不存在）。
  // P1-3 改造仅覆盖 TC-RUN-01（主流程），边界条件保留直接调用私有方法。
  const orchestrator = buildOrchestrator();
  const runId = "test-run-03";
  // 使用不存在的 projectRoot 路径
  const nonexistentPath = "/nonexistent/path/that/does/not/exist";

  const cleanupMethod = (
    orchestrator as unknown as {
      cleanupAbortFlag: (runId: string, projectRoot: string) => void;
    }
  ).cleanupAbortFlag;

  // 应不抛异常（仅记录 WARN 日志）
  assert.doesNotThrow(() => {
    cleanupMethod.call(orchestrator, runId, nonexistentPath);
  });
});

test("TC-RUN-04. run() 循环检测到 abort 文件后中止（集成测试）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建 tasks.md（让 plan 阶段能解析任务卡）
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    fs.writeFileSync(
      tasksFilePath,
      ["# EAG-P5 任务清单", "", "## T-001 测试任务", "- requirement: F-001", "- status: pending", ""].join("\n"),
      "utf8"
    );
    // 创建声明的源文件
    createDeclaredFileForTest(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();

    // 使用固定的 runId，便于预先创建 abort 文件
    // 注：不预先调用 store.initialize，否则 run() 内部再次 initialize 会抛 already-exists 错误
    //     （run() 设计为首次启动时自行调用 initialize 创建 RunState）
    const runId = "test-run-04-abort";

    // 预先创建 abort 文件（在 run() 启动前）
    // 模拟场景：stop() 在 run() 启动前已被调用（如另一 session 误触发）
    // run() 在首次迭代顶部检测到 abort 文件后立即中止
    const abortFlagsDir = path.join(projectRoot, ".eag", "p5", "abort-flags");
    fs.mkdirSync(abortFlagsDir, { recursive: true });
    const abortFilePath = path.join(abortFlagsDir, `${runId}.abort`);
    fs.writeFileSync(abortFilePath, "", "utf-8");
    assert.ok(fs.existsSync(abortFilePath), "前置：abort 文件应存在");

    // 调用 run()，应在首次迭代检测到 abort 文件并中止
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 abort 中止",
      runId,
      maxIterations: 5,
      testCommand: "echo 'Tests: 1 passed, 0 failed'",
      testTimeoutSec: 30,
    });

    // 验证 finalStatus 为 aborted
    assert.equal(result.finalStatus, "aborted");
    assert.equal(result.exitCode, 2);

    // 验证 abort 文件已被 finally 块清理
    assert.ok(!fs.existsSync(abortFilePath), "abort 文件应已被 finally 块清理");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

/**
 * 创建声明的源文件（让 dev 阶段能盘点到真实文件）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径
 */
function createDeclaredFileForTest(projectRoot: string, relativePath: string): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, "// 测试文件内容\n", "utf8");
}

// ============================================================================
// D. CLI 命令解析测试（TC-CLI-01 ~ 09）
// ============================================================================

test("TC-CLI-01. /eag-autonomous-status 命令解析", () => {
  const request = extractEagAutonomousStatusRequestFromPrompt("/eag-autonomous-status abc123def456");
  assert.equal(request.runId, "abc123def456");
  assert.ok(Object.isFrozen(request), "返回对象应被 Object.freeze 冻结");
});

test("TC-CLI-02. /eag-autonomous-stop 命令解析", () => {
  const request = extractEagAutonomousStopRequestFromPrompt("/eag-autonomous-stop xyz789abc012");
  assert.equal(request.runId, "xyz789abc012");
  assert.ok(Object.isFrozen(request), "返回对象应被 Object.freeze 冻结");
});

test("TC-CLI-03. /eag-autonomous-status 缺少 runId 抛错", () => {
  assert.throws(() => extractEagAutonomousStatusRequestFromPrompt("/eag-autonomous-status"), /缺少必填参数 <run-id>/);
  assert.throws(() => extractEagAutonomousStatusRequestFromPrompt("/eag-autonomous-status "), /缺少必填参数 <run-id>/);
});

test("TC-CLI-04. /eag-autonomous-stop 缺少 runId 抛错", () => {
  assert.throws(() => extractEagAutonomousStopRequestFromPrompt("/eag-autonomous-stop"), /缺少必填参数 <run-id>/);
});

test("TC-CLI-05. EAG_COMMAND_STRINGS 包含 18 个命令", () => {
  // 验证：EAG_COMMAND_STRINGS 常量包含 18 个 EAG 命令字符串
  // 注：ADR-DI-001 §7.4.1 新增 7 个动态指令注入与后台子 Agent 命令
  //     （/inject /bg /tasks /fg /cancel /pause /resume），命令总数从 11 扩展至 18
  assert.equal(EAG_COMMAND_STRINGS.EAG_BUILD, "/eag-build");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DESIGN, "/eag-design");
  assert.equal(EAG_COMMAND_STRINGS.EAG_TEST, "/eag-test");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RUN, "/eag-run");
  assert.equal(EAG_COMMAND_STRINGS.EAG_RESUME, "/eag-resume");
  assert.equal(EAG_COMMAND_STRINGS.EAG_STATUS, "/eag-status");
  assert.equal(EAG_COMMAND_STRINGS.EAG_DEPLOY, "/eag-deploy");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS, "/eag-autonomous");
  // 新增的 2 个命令
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STATUS, "/eag-autonomous-status");
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS_STOP, "/eag-autonomous-stop");
  // Loop-Graph 融合方案 Phase 5 新增 /eag-graph 命令
  assert.equal(EAG_COMMAND_STRINGS.EAG_GRAPH, "/eag-graph");
  // ADR-DI-001 §7.4.1 新增 7 个动态指令注入与后台子 Agent 命令字符串
  assert.equal(EAG_COMMAND_STRINGS.INJECT, "/inject");
  assert.equal(EAG_COMMAND_STRINGS.BG, "/bg");
  assert.equal(EAG_COMMAND_STRINGS.TASKS, "/tasks");
  assert.equal(EAG_COMMAND_STRINGS.FG, "/fg");
  assert.equal(EAG_COMMAND_STRINGS.CANCEL, "/cancel");
  assert.equal(EAG_COMMAND_STRINGS.PAUSE, "/pause");
  assert.equal(EAG_COMMAND_STRINGS.RESUME, "/resume");
  // 验证总字段数
  assert.equal(Object.keys(EAG_COMMAND_STRINGS).length, 18, "应有 18 个 EAG 命令字符串");
});

test("TC-CLI-06. parser 优先匹配 status 而非 autonomous", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parse({ text: "/eag-autonomous-status abc123" });
  assert.equal(cmd.kind, "eag-autonomous-status");
  assert.ok(cmd.payload, "payload 应非空");
  assert.equal((cmd.payload as { runId: string }).runId, "abc123");
});

test("TC-CLI-07. parser 优先匹配 stop 而非 autonomous", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parse({ text: "/eag-autonomous-stop xyz789" });
  assert.equal(cmd.kind, "eag-autonomous-stop");
  assert.ok(cmd.payload, "payload 应非空");
  assert.equal((cmd.payload as { runId: string }).runId, "xyz789");
});

test("TC-CLI-08. /eag-autonomous-status 大小写不敏感", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parse({ text: "/EAG-AUTONOMOUS-STATUS MyRunId123" });
  assert.equal(cmd.kind, "eag-autonomous-status");
  assert.ok(cmd.payload);
  assert.equal((cmd.payload as { runId: string }).runId, "MyRunId123");
});

test("TC-CLI-09. /eag-autonomous 命令不被误判为 status/stop（反向边界）", () => {
  const parser = new EagCommandParser();
  // /eag-autonomous --goal "xxx" 应匹配 eag-autonomous，而非 status/stop
  const cmd = parser.parse({ text: '/eag-autonomous --goal "测试目标"' });
  assert.equal(cmd.kind, "eag-autonomous");
  // payload 应非空（解析出 --goal 参数）
  assert.ok(cmd.payload, "payload 应非空");
});

test("TC-CLI-10. /eag-autonomous-stop 大小写不敏感", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parse({ text: "/EAG-Autonomous-Stop RunId456" });
  assert.equal(cmd.kind, "eag-autonomous-stop");
  assert.ok(cmd.payload);
  assert.equal((cmd.payload as { runId: string }).runId, "RunId456");
});

test("TC-CLI-11. parseEagAutonomousStatusCommand 公开方法返回正确 kind", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parseEagAutonomousStatusCommand({ text: "/eag-autonomous-status abc" });
  assert.equal(cmd.kind, "eag-autonomous-status");
});

test("TC-CLI-12. parseEagAutonomousStatusCommand 对非 status 命令返回 unknown", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parseEagAutonomousStatusCommand({ text: "/eag-autonomous abc" });
  assert.equal(cmd.kind, "unknown");
  assert.equal(cmd.payload, null);
});

test("TC-CLI-13. parseEagAutonomousStopCommand 公开方法返回正确 kind", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parseEagAutonomousStopCommand({ text: "/eag-autonomous-stop xyz" });
  assert.equal(cmd.kind, "eag-autonomous-stop");
});

test("TC-CLI-14. parseEagAutonomousStopCommand 对非 stop 命令返回 unknown", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parseEagAutonomousStopCommand({ text: "/eag-autonomous xyz" });
  assert.equal(cmd.kind, "unknown");
  assert.equal(cmd.payload, null);
});

test("TC-CLI-15. /eag-autonomous-status 命令带图片附件返回 unknown", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parse({
    text: "/eag-autonomous-status abc",
    imageUrls: ["data:image/png;base64,xxx"],
  });
  assert.equal(cmd.kind, "unknown");
});

test("TC-CLI-16. /eag-autonomous-stop 命令带技能匹配返回 unknown", () => {
  const parser = new EagCommandParser();
  const cmd = parser.parse({
    text: "/eag-autonomous-stop abc",
    skills: [{ name: "some-skill" }],
  });
  assert.equal(cmd.kind, "unknown");
});

test("TC-CLI-17. extractEagAutonomousStatusRequestFromPrompt 命令前缀不匹配抛错", () => {
  assert.throws(() => extractEagAutonomousStatusRequestFromPrompt("/eag-autonomous abc"), /命令前缀不匹配/);
});

test("TC-CLI-18. extractEagAutonomousStopRequestFromPrompt 命令前缀不匹配抛错", () => {
  assert.throws(() => extractEagAutonomousStopRequestFromPrompt("/eag-autonomous-status abc"), /命令前缀不匹配/);
});

test("TC-CLI-19. extractEagAutonomousStatusRequestFromPrompt prompt 非字符串抛错", () => {
  assert.throws(
    () => extractEagAutonomousStatusRequestFromPrompt(undefined as unknown as string),
    /prompt 必须为非空字符串/
  );
});

test("TC-CLI-20. extractEagAutonomousStatusRequestFromPrompt prompt 空字符串抛错", () => {
  assert.throws(() => extractEagAutonomousStatusRequestFromPrompt("   "), /prompt 不能为空字符串/);
});

test("TC-CLI-21. /eag-autonomous-status 命令 trim 后解析", () => {
  const request = extractEagAutonomousStatusRequestFromPrompt("  /eag-autonomous-status   my-run-id  ");
  assert.equal(request.runId, "my-run-id");
});

test("TC-CLI-22. /eag-autonomous-status 命令多字段仅取首个 token", () => {
  // 用户误粘贴带空格的多字段，仅取首个 token
  const request = extractEagAutonomousStatusRequestFromPrompt("/eag-autonomous-status my-run-id extra-arg");
  assert.equal(request.runId, "my-run-id");
});

test("TC-CLI-23. EagCommand union 的 discriminated union 类型收窄", () => {
  // 类型层面的验证：通过 switch case 验证 TypeScript 自动收窄类型
  const parser = new EagCommandParser();
  const cmd = parser.parse({ text: "/eag-autonomous-status abc" });

  switch (cmd.kind) {
    case "eag-autonomous-status":
      // 此处 cmd.payload 类型应自动收窄为 EagAutonomousStatusRequest | null
      assert.ok(cmd.payload);
      assert.equal(cmd.payload.runId, "abc");
      break;
    case "eag-autonomous-stop":
      assert.fail("不应进入 eag-autonomous-stop 分支");
      break;
    default:
      assert.fail("不应进入 default 分支");
  }
});

// ============================================================================
// E. SessionManager 集成测试（TC-SESSION-01 ~ 03，P0-1 补全）
// ============================================================================
// 设计依据：设计文档 v1.2 §6.1 测试计划 TC-SESSION-01/02/03
// 测试目标：验证 handleEagAutonomousStatusCommand / handleEagAutonomousStopCommand
//          在 SessionManager 上下文中的完整集成路径（公共前置 + orchestrator 调用 + 渲染 + 状态更新）
// 测试约束（对齐用户规则）：禁止使用 mock，使用真实 AutonomousOrchestrator + 真实文件系统
// ============================================================================

/**
 * 构造测试用 SessionManager 实例（最小依赖，注入真实 AutonomousOrchestrator）
 *
 * 参考 eag-session-commands-hook.test.ts 的 createTestManager 模式，
 * 但 projectRoot 可定制（用于与 AutonomousOrchestrator 共享临时目录）。
 *
 * 设计决策（对齐用户规则：禁止使用 mock）：
 * - 注入真实的 AutonomousOrchestrator 实例（通过 buildOrchestrator 构造）
 * - createOpenAIClient 返回 client:null（不触发真实 LLM 调用，handler 不依赖 LLM）
 * - onAssistantMessage 回调直接捕获 message.content 到 messages 数组
 *
 * @param projectRoot 项目根目录（用于定位 RunStateStore 和 sessions index）
 * @param onMessage 消息回调（接收 assistant 消息内容）
 * @param orchestrator 真实的 AutonomousOrchestrator 实例（可选，未注入时测试 fail-closed）
 * @returns SessionManager 实例
 */
function createTestSessionManager(
  projectRoot: string,
  onMessage: (content: string) => void,
  orchestrator?: AutonomousOrchestrator
): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: (message: any) => onMessage(message.content),
    autonomousOrchestrator: orchestrator,
  } as any);
}

/**
 * 预注入 session entry 到 sessions index（用于验证 session 状态更新）
 *
 * handleEagAutonomousStatusCommand / handleEagAutonomousStopCommand 内部调用
 * updateSessionEntry 更新 session 状态。若 session 不存在，updateSessionEntry
 * 返回 null（静默忽略），无法验证状态更新。此 helper 通过直接操作 sessions
 * index 预注入 session entry，使测试能验证 status 从 pending → completed/failed。
 *
 * @param manager SessionManager 实例
 * @param sessionId 预注入的 session ID
 */
function injectSessionEntry(manager: SessionManager, sessionId: string): void {
  const internal = manager as any;
  const index = internal.loadSessionsIndex();
  const now = new Date().toISOString();
  index.entries.push({
    id: sessionId,
    summary: "test session",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "pending",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
    planMode: false,
  });
  internal.saveSessionsIndex(index);
}

/**
 * 读取 session entry 的当前状态（用于验证 handler 执行后 session 状态更新）
 *
 * @param manager SessionManager 实例
 * @param sessionId 目标 session ID
 * @returns session entry 的 status 字段，若 session 不存在返回 null
 */
function getSessionStatus(manager: SessionManager, sessionId: string): string | null {
  const internal = manager as any;
  const index = internal.loadSessionsIndex();
  const entry = index.entries.find((e: any) => e.id === sessionId);
  return entry ? entry.status : null;
}

test("TC-SESSION-01. handleEagAutonomousStatusCommand 集成测试（P0-1 新增）", async () => {
  // 验证 handleEagAutonomousStatusCommand 的完整集成路径：
  // 1. 公共前置逻辑（记录用户输入 / 更新 processing / 校验依赖 / 校验 payload）
  // 2. 调用 orchestrator.status(runId, projectRoot)
  // 3. 通过 onAssistantMessage 渲染 Markdown 报告
  // 4. 更新 session 状态为 completed
  //
  // 设计决策（对齐用户规则：禁止使用 mock）：
  // - 使用真实的 AutonomousOrchestrator 实例（通过 buildOrchestrator 构造）
  // - 使用真实的 P5RunStateStore 初始化 RunState 数据
  // - 使用真实的文件系统（临时目录）
  const projectRoot = createTempProject();
  try {
    // 步骤 1：初始化 RunState 数据（status="running"）
    const store = new P5RunStateStore();
    const runId = "test-session-01";
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    // 步骤 2：构造真实 AutonomousOrchestrator 实例
    const orchestrator = buildOrchestrator();

    // 步骤 3：构造 SessionManager，注入 orchestrator，projectRoot 指向临时目录
    const messages: string[] = [];
    const manager = createTestSessionManager(projectRoot, (content) => messages.push(content), orchestrator);

    // 步骤 4：预注入 session entry（用于验证 session 状态更新）
    const sessionId = "test-session-status-01";
    injectSessionEntry(manager, sessionId);

    // 步骤 5：构造 EagAutonomousStatusRequest
    const request = extractEagAutonomousStatusRequestFromPrompt(`/eag-autonomous-status ${runId}`);

    // 步骤 6：调用 handleEagAutonomousStatusCommand（通过 internal 访问私有方法）
    const internal = manager as any;
    await internal.handleEagAutonomousStatusCommand(
      sessionId,
      { text: `/eag-autonomous-status ${runId}` },
      request,
      new AbortController()
    );

    // 验证 1：onAssistantMessage 渲染了 status report
    assert.ok(messages.length > 0, "应发送至少一条 assistant 消息");
    assert.ok(
      messages.some((m) => m.includes("Autonomous Run Status")),
      `消息应含 'Autonomous Run Status' 标题，实际为：${messages.join("\n")}`
    );
    assert.ok(
      messages.some((m) => m.includes(runId)),
      `消息应含 runId '${runId}'，实际为：${messages.join("\n")}`
    );

    // 验证 2：session 状态更新为 completed（status 查询是只读操作，无论 found=true/false 都视为 completed）
    const finalStatus = getSessionStatus(manager, sessionId);
    assert.equal(finalStatus, "completed", "session 状态应为 completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-SESSION-02. handleEagAutonomousStopCommand 集成测试（P0-1 新增）", async () => {
  // 验证 handleEagAutonomousStopCommand 的完整集成路径：
  // 1. 公共前置逻辑（记录用户输入 / 更新 processing / 校验依赖 / 校验 payload）
  // 2. 调用 orchestrator.stop(runId, projectRoot)
  // 3. 通过 onAssistantMessage 渲染 Markdown 报告
  // 4. 更新 session 状态（依据 result.success）
  //
  // 设计决策（对齐用户规则：禁止使用 mock）：
  // - 使用真实的 AutonomousOrchestrator 实例
  // - RunState status="running"，stop() 将创建 abort 标志文件并返回 action="abort"
  const projectRoot = createTempProject();
  try {
    // 步骤 1：初始化 RunState 数据（status="running"）
    const store = new P5RunStateStore();
    const runId = "test-session-02";
    await initializeAndSaveState(store, projectRoot, runId, { status: "running" });

    // 步骤 2：构造真实 AutonomousOrchestrator 实例
    const orchestrator = buildOrchestrator();

    // 步骤 3：构造 SessionManager，注入 orchestrator
    const messages: string[] = [];
    const manager = createTestSessionManager(projectRoot, (content) => messages.push(content), orchestrator);

    // 步骤 4：预注入 session entry
    const sessionId = "test-session-stop-02";
    injectSessionEntry(manager, sessionId);

    // 步骤 5：构造 EagAutonomousStopRequest
    const request = extractEagAutonomousStopRequestFromPrompt(`/eag-autonomous-stop ${runId}`);

    // 步骤 6：调用 handleEagAutonomousStopCommand
    const internal = manager as any;
    await internal.handleEagAutonomousStopCommand(
      sessionId,
      { text: `/eag-autonomous-stop ${runId}` },
      request,
      new AbortController()
    );

    // 验证 1：onAssistantMessage 渲染了 stop report
    assert.ok(messages.length > 0, "应发送至少一条 assistant 消息");
    assert.ok(
      messages.some((m) => m.includes("Autonomous Run Stop")),
      `消息应含 'Autonomous Run Stop' 标题，实际为：${messages.join("\n")}`
    );

    // 验证 2：abort 标志文件已创建（stop() 对 running 状态创建 abort 文件）
    const abortFilePath = path.join(projectRoot, ".eag", "p5", "abort-flags", `${runId}.abort`);
    assert.ok(fs.existsSync(abortFilePath), "abort 标志文件应已创建");

    // 验证 3：session 状态更新为 completed（stop 操作成功，session 标记 completed）
    const finalStatus = getSessionStatus(manager, sessionId);
    assert.equal(finalStatus, "completed", "session 状态应为 completed（stop 操作成功）");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("TC-SESSION-03. handleEagAutonomousStatusCommand 未注入 orchestrator 时 fail-closed（P0-1 新增）", async () => {
  // 验证 handleEagAutonomousStatusCommand 的依赖校验逻辑（fail-closed）：
  // - autonomousOrchestrator 未注入（undefined）
  // - 通知用户配置缺失（"AutonomousOrchestrator 未注入"）
  // - session 标记 failed
  //
  // 测试设计（对齐设计文档 §3.6 fail-closed 语义）：
  // - 不注入 autonomousOrchestrator
  // - 预注入 session entry，验证 status 从 pending → failed
  const projectRoot = createTempProject();
  try {
    // 步骤 1：构造 SessionManager，不注入 orchestrator
    const messages: string[] = [];
    const manager = createTestSessionManager(
      projectRoot,
      (content) => messages.push(content)
      // 不传入 orchestrator，测试 fail-closed
    );

    // 步骤 2：预注入 session entry
    const sessionId = "test-session-fail-closed-03";
    injectSessionEntry(manager, sessionId);

    // 步骤 3：调用 handleEagAutonomousStatusCommand（request 为 null，依赖校验先于 request 校验）
    const internal = manager as any;
    await internal.handleEagAutonomousStatusCommand(
      sessionId,
      { text: "/eag-autonomous-status some-run-id" },
      null, // request 为 null，但依赖校验先执行，不会到达 request 校验
      new AbortController()
    );

    // 验证 1：onAssistantMessage 渲染了错误消息
    assert.ok(messages.length > 0, "应发送至少一条通知消息");
    assert.ok(
      messages.some((m) => m.includes("AutonomousOrchestrator 未注入")),
      `消息应含 'AutonomousOrchestrator 未注入' 错误提示，实际为：${messages.join("\n")}`
    );

    // 验证 2：session 状态更新为 failed（fail-closed）
    const finalStatus = getSessionStatus(manager, sessionId);
    assert.equal(finalStatus, "failed", "session 状态应为 failed（fail-closed）");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
