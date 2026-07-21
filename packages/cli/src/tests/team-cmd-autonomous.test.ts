/**
 * team-cmd-autonomous.test.ts - autonomous 子命令集成测试（P0-1 验证）
 *
 * 设计文档 §7.4：9 个 AC 用例（AC-001~AC-009）
 *   - AC-001: autonomous 无 --goal 参数 → exitCode=1, stderr 含 "需要 --goal"
 *   - AC-002: autonomous 无 API Key → exitCode=1, stderr 含 3 个关键字
 *   - AC-003: autonomous 成功完成 1 轮迭代 → exitCode=0, stdout 含 "Ralph Autonomous Loop"
 *   - AC-004: autonomous 连续失败 abort → exitCode=2, stdout 含 "Fatal abort" 或 "连续失败"
 *   - AC-005: autonomous 创建 RunState 文件 → state.json 文件存在
 *   - AC-006: autonomous 写入 notes.md → notes.md 文件存在且含 final summary
 *   - AC-007: autonomous git commit → git log 含 "ralph iter-1"
 *   - AC-008: --resume-run 恢复运行 → stdout 含 "已恢复运行"
 *   - AC-009: --resume-run 无可恢复运行 → stdout 含 "未找到可恢复的 run"
 *
 * 测试约定（遵循用户规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架，使用真实临时目录 + 真实 git 仓库
 *   - 通过 TeamCommandArgs.injectedClient 字段注入 stub client（真实接口契约的固定响应，
 *     非 mock），避免在开发机/CI 环境真实调用 LLM
 *   - 每个测试用例独立隔离：临时 projectRoot + 拦截/恢复 stdout/stderr + 备份/恢复环境变量
 *   - 测试后清理临时目录
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { executeTeamCommand } from "../team/team-cmd.js";
import { buildStubClientReturningValidOutput, buildStubClientAlwaysThrows } from "./utils/stub-client.js";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建临时项目目录（用于隔离测试）
 *
 * 每个测试用例创建独立的临时目录，避免污染当前工作目录
 * 目录名含 prefix 便于调试时识别
 *
 * @param prefix 目录名前缀（如 "ac003"）
 * @returns 临时目录绝对路径
 */
function makeTempProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-ac-${prefix}-`));
}

/**
 * 递归删除临时目录（忽略清理失败，不影响测试结果）
 *
 * @param dir 临时目录路径
 */
function rmTempProject(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 拦截 process.stdout.write 和 process.stderr.write，收集输出
 *
 * 真实拦截（非 mock）：替换 process.stdout/stderr 的 write 方法，
 * 将写入内容收集到数组，restore 时恢复原始方法
 *
 * 必须在 try/finally 中调用 restore，避免污染后续测试
 *
 * @returns 包含 stdout、stderr getter 和 restore 方法的对象
 */
function captureOutput(): {
  stdout: string;
  stderr: string;
  restore: () => void;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  // 绑定原始 write 方法，避免替换后丢失引用
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  // 替换 write 方法，收集写入内容
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  return {
    /** 获取已收集的 stdout 内容 */
    get stdout() {
      return stdoutChunks.join("");
    },
    /** 获取已收集的 stderr 内容 */
    get stderr() {
      return stderrChunks.join("");
    },
    /** 恢复原始 write 方法（必须在 finally 中调用） */
    restore: () => {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

/**
 * 隔离 OpenAI / DeepCode 相关环境变量 + 重定向 HOME 目录
 *
 * 用途：AC-002 测试 "无 API Key" 场景时，确保 createOpenAIClient 走 no-client 分支
 *   1. 清空 OPENAI_API_KEY / DEEPCODE_API_KEY 等环境变量
 *   2. 重定向 HOME / USERPROFILE 到临时目录，阻断 ~/.deepcode/settings.json 读取
 *
 * 内联实现（非从 core 包导入），原因：
 *   - env-isolation.ts 位于 packages/core/src/team/tests/utils/，未通过 @vegamo/deepcode-core re-export
 *   - CLI 包只能通过 @vegamo/deepcode-core 包入口导入 core 模块
 *   - 此处仅 AC-002 一个用例需要环境隔离，内联实现避免修改 core 包导出
 *   - 实现与 env-isolation.ts 完全一致（备份/恢复环境变量 + 重定向 HOME）
 *
 * @returns restore 函数，调用后恢复原值并删除临时 HOME 目录
 */
function isolateOpenAIEnv(): () => void {
  // 需要清空的环境变量列表
  const keys = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "DEEPCODE_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ];
  // 备份字典：记录每个 key 的原始值（undefined 表示原本未设置）
  const backup: Record<string, string | undefined> = {};
  for (const key of keys) {
    backup[key] = process.env[key];
    delete process.env[key];
  }

  // 重定向 HOME / USERPROFILE 到临时目录，阻断 settings.json 读取
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-ac-home-"));
  const backupHome = process.env.HOME;
  const backupUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // 返回聚合 restore 函数：先恢复 HOME，再恢复环境变量，最后清理临时目录
  return () => {
    if (backupHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = backupHome;
    }
    if (backupUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = backupUserProfile;
    }
    for (const key of keys) {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key]!;
      }
    }
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  };
}

/**
 * 在临时项目目录中创建 autonomous.yml 配置文件
 *
 * 用于 AC-004 配置 backoffBaseSec/backoffMaxSec/consecutiveFailureAbort，
 * 加速测试（避免真实 sleep 1s+）
 *
 * 配置文件路径：<projectRoot>/.deepcodex/autonomous.yml
 * 配置文件格式：极简 YAML（parseSimpleYaml 支持 key: value 格式）
 *
 * @param projectRoot 临时项目根目录
 * @param config 配置项（snake_case，与 YAML 字段名一致）
 */
function writeAutonomousConfig(
  projectRoot: string,
  config: {
    backoffBaseSec?: number;
    backoffMaxSec?: number;
    consecutiveFailureAbort?: number;
    maxIterations?: number;
  }
): void {
  const configDir = path.join(projectRoot, ".deepcodex");
  fs.mkdirSync(configDir, { recursive: true });
  const lines: string[] = [];
  if (config.backoffBaseSec !== undefined) {
    lines.push(`backoff_base_sec: ${config.backoffBaseSec}`);
  }
  if (config.backoffMaxSec !== undefined) {
    lines.push(`backoff_max_sec: ${config.backoffMaxSec}`);
  }
  if (config.consecutiveFailureAbort !== undefined) {
    lines.push(`consecutive_failure_abort: ${config.consecutiveFailureAbort}`);
  }
  if (config.maxIterations !== undefined) {
    lines.push(`max_iterations: ${config.maxIterations}`);
  }
  fs.writeFileSync(path.join(configDir, "autonomous.yml"), lines.join("\n") + "\n", "utf-8");
}

/**
 * 在临时项目目录中初始化 git 仓库
 *
 * 用于 AC-007 测试 git commit 行为：
 *   1. git init
 *   2. git config user.name / user.email（避免 commit 时报错）
 *   3. 创建初始文件 README.md 并 commit（建立 master/main 分支）
 *   4. 创建未 commit 的文件 feature.ts（供 autonomous 运行时 GitDriver.commit 提交）
 *
 * @param projectRoot 临时项目根目录
 */
function initGitRepo(projectRoot: string): void {
  execSync("git init", { cwd: projectRoot, stdio: "ignore" });
  execSync("git config user.name TestUser", { cwd: projectRoot, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: projectRoot, stdio: "ignore" });
  // 创建初始文件并 commit（建立分支，否则 git log 会报错）
  fs.writeFileSync(path.join(projectRoot, "README.md"), "initial\n", "utf-8");
  execSync("git add README.md", { cwd: projectRoot, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: projectRoot, stdio: "ignore" });
  // 创建未 commit 的文件，供 autonomous 运行时 GitDriver.commit 检测到变更并提交
  // 不需要 git add，GitDriver.commit 会执行 git add -A
  fs.writeFileSync(path.join(projectRoot, "feature.ts"), "// feature implementation\n", "utf-8");
}

/**
 * 在临时项目目录中构造一个可恢复的 run（state.json）
 *
 * 用于 AC-008 测试 --resume-run 恢复运行：
 *   - 在 <projectRoot>/.deepcodex/runs/<runId>/state.json 写入 status="aborted" 的状态
 *   - findLatestResumableRun 会扫描 runs 目录，找到 status != "completed" 的最新 run
 *
 * @param projectRoot 临时项目根目录
 * @param runId run 的唯一 ID（如 "r-testresume001"）
 * @param objective 原始目标（用于验证 resume 后的 state.objective）
 * @param iterIndex 已完成的迭代次数（用于验证 resume 后的输出 "已迭代 N 次"）
 */
function createResumableRun(projectRoot: string, runId: string, objective: string, iterIndex: number): void {
  const runDir = path.join(projectRoot, ".deepcodex", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  // state.json 字段必须与 RunStateSchema 完全一致，schemaVersion=1（RunState.load 会校验）
  const stateJson = {
    runId,
    objective,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    iterIndex,
    consecutiveFailures: 0,
    cumulativeTokens: 100,
    commitsMade: 0,
    history: [],
    status: "aborted", // status != "completed" 才会被 findLatestResumableRun 识别
    stopWhen: "",
    lastError: "测试中断",
    schemaVersion: 1,
  };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(stateJson, null, 2), "utf-8");
}

// ============================================================================
// AC-001: autonomous 无 --goal 参数
// ============================================================================

test("AC-001: autonomous 无 --goal 参数 → exitCode=1, stderr 含 '需要 --goal'", async () => {
  // 使用临时目录作为 projectRoot，避免污染当前工作目录
  const tmpDir = makeTempProject("ac001");
  const cap = captureOutput();
  try {
    // 传 injectedClient 绕过 Step 2 的 API Key 检查，让流程走到 Step 3 的 goal 检查
    // 原因：设计文档 §7.4 AC-001 输入是 args={subcommand:"autonomous"}（无 injectedClient），
    //       但如果不传 injectedClient，Step 2 会先失败（无 API Key），无法到达 Step 3 的 goal 检查。
    //       AC-001 的核心是验证 "无 --goal 参数" 的错误处理，应绕过 API Key 检查直接测 goal 校验。
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    assert.ok(cap.stderr.includes("需要 --goal"), `stderr 应含 "需要 --goal"，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-002: autonomous 无 API Key
// ============================================================================

test("AC-002: autonomous 无 API Key → exitCode=1, stderr 含 3 个关键字", async () => {
  // 隔离环境变量 + 重定向 HOME，确保 createOpenAIClient 走 no-client 分支
  const restoreEnv = isolateOpenAIEnv();
  const tmpDir = makeTempProject("ac002");
  const cap = captureOutput();
  try {
    // 不传 injectedClient，让流程走 createOpenAIClient 分支
    // 期望 createOpenAIClient 返回 client=null，Step 2 失败退出
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      projectRoot: tmpDir,
      // 不传 injectedClient
    });
    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    // v1.2 修正 M-14：多重断言；v1.3 修正 F-02：关键字从 OPENAI_API_KEY 改为 DEEPCODE_API_KEY
    assert.ok(
      cap.stderr.includes("autonomous 模式需要 API Key"),
      `stderr 应含 "autonomous 模式需要 API Key"，实际: ${cap.stderr}`
    );
    assert.ok(cap.stderr.includes("DEEPCODE_API_KEY"), `stderr 应含 "DEEPCODE_API_KEY"，实际: ${cap.stderr}`);
    assert.ok(cap.stderr.includes("env.API_KEY"), `stderr 应含 "env.API_KEY"，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
    restoreEnv();
  }
});

// ============================================================================
// AC-003: autonomous 成功完成 1 轮迭代
// ============================================================================

test("AC-003: autonomous 成功完成 1 轮迭代 → exitCode=0, stdout 含 'Ralph Autonomous Loop'", async () => {
  const tmpDir = makeTempProject("ac003");
  const cap = captureOutput();
  try {
    // 注入 stub client，stage-aware 工厂会让 plan/dev/verify/fix 4 个 stage 都返回 success
    // maxIter=1 确保只运行 1 轮迭代后自然退出
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      maxIterations: 1,
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`);
    assert.ok(cap.stdout.includes("Ralph Autonomous Loop"), `stdout 应含 "Ralph Autonomous Loop"，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-004: autonomous 连续失败 abort
// ============================================================================

test("AC-004: autonomous 连续失败 abort → exitCode=2, stdout 含 'Fatal abort' 或 '连续失败'", async () => {
  const tmpDir = makeTempProject("ac004");
  // 配置 backoffBaseSec=0.05 加速测试：
  //   backoffSleep(0) → 0.05 * 2^0 = 0.05 < 0.1，不 sleep
  //   backoffSleep(1) → 0.05 * 2^1 = 0.1，不 > 0.1，不 sleep
  //   backoffSleep(2) → 0.05 * 2^2 = 0.2 > 0.1，sleep 0.2s（第 3 次失败后 abort，不 sleep）
  // 总测试时间约 0.2s
  writeAutonomousConfig(tmpDir, {
    backoffBaseSec: 0.05,
    backoffMaxSec: 0.05,
    consecutiveFailureAbort: 3,
  });
  const cap = captureOutput();
  try {
    // 注入总是抛错的 stub client：
    //   - plan stage: executeDispatch catch 错误 → status=failed → PlanStageHandler.judgeResult: kind=retriable
    //   - runOneIteration 立即返回 kind=retriable（不继续 dev/verify/fix）
    //   - loop-controller: consecutiveFailures += 1, backoffSleep
    //   - 3 次连续 retriable 后 abort（exitCode=2）
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      maxIterations: 5, // 不会真的跑 5 次，3 次失败后就 abort
      projectRoot: tmpDir,
      injectedClient: buildStubClientAlwaysThrows(),
    });
    assert.equal(
      exitCode,
      2,
      `exitCode 应为 2（Fatal abort），实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`
    );
    // exitCodeMap[2] = "✖ Fatal abort（连续失败超限）"
    // log("error", "[RalphLoop] 连续失败 3 次，abort")
    assert.ok(
      cap.stdout.includes("Fatal abort") || cap.stdout.includes("连续失败"),
      `stdout 应含 "Fatal abort" 或 "连续失败"，实际: ${cap.stdout}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-005: autonomous 创建 RunState 文件
// ============================================================================

test("AC-005: autonomous 创建 RunState 文件 → state.json 文件存在", async () => {
  const tmpDir = makeTempProject("ac005");
  const cap = captureOutput();
  try {
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      maxIterations: 1,
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`);

    // 扫描 <tmpDir>/.deepcodex/runs/ 目录，查找 state.json
    const runsDir = path.join(tmpDir, ".deepcodex", "runs");
    assert.ok(fs.existsSync(runsDir), `runs 目录应存在: ${runsDir}`);
    const runDirs = fs.readdirSync(runsDir).filter((name) => fs.statSync(path.join(runsDir, name)).isDirectory());
    assert.ok(runDirs.length > 0, "应至少有一个 run 目录");

    // 检查第一个 run 目录下的 state.json
    const stateJsonPath = path.join(runsDir, runDirs[0]!, "state.json");
    assert.ok(fs.existsSync(stateJsonPath), `state.json 应存在: ${stateJsonPath}`);

    // 验证 state.json 内容：status 应为 "completed"（maxIter=1 成功完成）
    const stateContent = JSON.parse(fs.readFileSync(stateJsonPath, "utf-8"));
    assert.equal(
      stateContent.status,
      "completed",
      `state.json 的 status 应为 "completed"，实际: ${stateContent.status}`
    );
    assert.equal(stateContent.iterIndex, 1, `state.json 的 iterIndex 应为 1，实际: ${stateContent.iterIndex}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-006: autonomous 写入 notes.md
// ============================================================================

test("AC-006: autonomous 写入 notes.md → notes.md 文件存在且含 final summary", async () => {
  const tmpDir = makeTempProject("ac006");
  const cap = captureOutput();
  try {
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      maxIterations: 1,
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`);

    // 检查 notes.md 文件存在
    const notesPath = path.join(tmpDir, ".deepcodex", "notes.md");
    assert.ok(fs.existsSync(notesPath), `notes.md 应存在: ${notesPath}`);

    // 检查 notes.md 内容含 final summary
    // NotesMemory.writeFinalSummary 追加 "Final Summary" section
    // RalphLoopController.buildFinalSummary 生成 "## Ralph Run Summary" 内容
    const notesContent = fs.readFileSync(notesPath, "utf-8");
    assert.ok(
      notesContent.includes("Final Summary") || notesContent.includes("Ralph Run Summary"),
      `notes.md 应含 "Final Summary" 或 "Ralph Run Summary"，实际: ${notesContent}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-007: autonomous git commit
// ============================================================================

test("AC-007: autonomous git commit → git log 含 'ralph iter-1'", async () => {
  const tmpDir = makeTempProject("ac007");
  // 初始化 git 仓库 + 创建未 commit 的 feature.ts 文件
  // autonomous 运行时 GitDriver.commit 会 git add -A + git commit -m "ralph iter-1: ..."
  initGitRepo(tmpDir);
  const cap = captureOutput();
  try {
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      maxIterations: 1,
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`);

    // 检查 git log 含 "ralph iter-1"
    // GitDriver.commit message 格式：`ralph iter-${iterIndex}: ${summary.slice(0, 80)}`
    const gitLog = execSync("git log", { cwd: tmpDir, encoding: "utf-8" });
    assert.ok(gitLog.includes("ralph iter-1"), `git log 应含 "ralph iter-1"，实际: ${gitLog}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-008: --resume-run 恢复运行
// ============================================================================

test("AC-008: --resume-run 恢复运行 → stdout 含 '已恢复运行'", async () => {
  const tmpDir = makeTempProject("ac008");
  // 先构造一个可恢复的 run（status="aborted"）
  // findLatestResumableRun 会扫描 runs 目录，找到 status != "completed" 的最新 run
  const runId = "r-testresume001";
  createResumableRun(tmpDir, runId, "原目标", 1);
  const cap = captureOutput();
  try {
    // --resume-run：从 runs 目录查找最新可恢复的 run
    // 注入 stub client 避免 resume 后继续运行时真实调用 LLM
    // maxIter=1：resume 后 runState.iterIndex=1 >= 1，shouldStop 返回 true，不执行迭代，立即完成
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      resumeRun: true,
      maxIterations: 1,
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    // resume 后 iterIndex=1 >= maxIter=1，shouldStop=true，不执行迭代，自然退出
    // consecutiveFailures=0 → exitCode=0（natural exit，markComplete）
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`);
    assert.ok(cap.stdout.includes("已恢复运行"), `stdout 应含 "已恢复运行"，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// AC-009: --resume-run 无可恢复运行
// ============================================================================

test("AC-009: --resume-run 无可恢复运行 → stdout 含 '未找到可恢复的 run'", async () => {
  const tmpDir = makeTempProject("ac009");
  // 不创建任何 run 目录（空目录），findLatestResumableRun 返回 null
  const cap = captureOutput();
  try {
    // --resume-run + goal：未找到可恢复的 run 时，创建新运行
    // 注入 stub client 避免新运行时真实调用 LLM
    // maxIter=1：确保新运行只跑 1 轮后退出
    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      resumeRun: true,
      goal: "新目标",
      maxIterations: 1,
      projectRoot: tmpDir,
      injectedClient: buildStubClientReturningValidOutput(),
    });
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`);
    assert.ok(cap.stdout.includes("未找到可恢复的 run"), `stdout 应含 "未找到可恢复的 run"，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});
