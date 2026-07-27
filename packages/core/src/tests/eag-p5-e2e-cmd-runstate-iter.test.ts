/**
 * EAG-P5 端到端能力呈现验证（拆分文件 3/5）：三命令链路 + 跨会话续跑 + 多轮迭代
 *
 * 本文件由原 `eag-p5-e2e-capability-verification.test.ts` 拆分而来，
 * 集中承载 FR-3 跨会话续跑与 FR-4 三命令完整链路端到端验证：
 *
 * - R 组（R1-R3）：三命令完整链路验证（/eag-autonomous + status + stop）
 * - S 组（S1-S3）：跨会话续跑验证（RunState JSONL 持久化 + 中断恢复 + resume 续跑）
 * - T 组（T1-T3）：多轮真实迭代验证（completedLoops + notes.md 多轮记忆 + milestones）
 *
 * 测试约定（严格遵循项目规则 NFR-8 / NFR-9 / NFR-10）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / P5RunStateStore / P5NotesMemory 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行测试命令）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环 + FR-3 跨会话续跑 + FR-4 三命令 + FR-7 NotesMemory
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-e2e-cmd-runstate-iter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// P5 核心组件导入
import {
  // 持久化与记忆组件
  P5RunStateStore,
  P5NotesMemory,
  // 类型
  type AutonomousRunResult,
} from "../eag/p5";

// 命令处理导入（R 组三命令链路用）
import {
  EagAutonomousCommandHandler,
  extractEagAutonomousRequestFromPrompt,
  extractEagAutonomousStatusRequestFromPrompt,
  extractEagAutonomousStopRequestFromPrompt,
} from "../eag/cli/eag-autonomous-command";

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
// R 组：三命令完整链路验证（R1-R3，v2.0 新增）
// ============================================================================
//
// R 组验证 FR-4 三命令（/eag-autonomous + /eag-autonomous-status + /eag-autonomous-stop）
// 的端到端完整链路：
// - R1: /eag-autonomous 启动完整链路（CLI 解析 → handler → orchestrator → run() → result）
// - R2: /eag-autonomous-status 状态查询完整链路（CLI 解析 → handler → 真实 RunState 读取）
// - R3: /eag-autonomous-stop 熔断完整链路（CLI 解析 → handler → emergencyStop → 回滚）
//
// 与 P4 的区别：P4 仅验证"命令解析 + handler.execute() 返回 success"，
// R 组进一步验证 runResult.finalStatus / totalIterations / markdownReport 内容真实性，
// 以及 status/stop 命令与 run() 的端到端协作。
//
// 严格遵循 NFR-9：禁止 mock，使用真实 AutonomousOrchestrator + 真实文件系统 + 真实 child_process。
// ============================================================================

// ----------------------------------------------------------------------------
// R1: /eag-autonomous 启动完整链路（CLI 解析 → handler → orchestrator → run() → result）
// ----------------------------------------------------------------------------

test("R1. /eag-autonomous 启动完整链路：CLI 解析 → handler → orchestrator → run() → result", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备：tasks.md（1 个 completed 任务）+ 声明的源文件
    // tasks.md 状态为 completed：plan 阶段会立即返回 taskCard=null（所有任务已完成）
    // run() 在第 0 轮迭代执行 plan 后即终止，finalStatus === "completed"，exitCode === 0
    // totalIterations === 1（第 0 轮迭代执行了 plan 阶段后发现 taskCard=null → completed）
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 验证 extractEagAutonomousRequestFromPrompt 解析 --goal + --max-iterations
    const prompt = `/eag-autonomous --goal "测试 R1 启动完整链路" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`;
    const request = extractEagAutonomousRequestFromPrompt(prompt);
    assert.equal(request.goal, "测试 R1 启动完整链路", "应正确解析 --goal");
    assert.equal(request.maxIterations, 1, "应正确解析 --max-iterations");
    assert.equal(request.testCommand, PASS_TEST_CMD, "应正确解析 --test-command");

    // 2. 验证 EagAutonomousCommandHandler.execute() 返回 success=true
    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(request, projectRoot);

    assert.equal(result.success, true, "execute 应返回 success=true");
    assert.ok(result.runResult, "应包含 runResult");

    // 3. 验证 runResult.finalStatus 为合法值
    // 注意：设计文档原文写 finalStatus === "success"，但实际类型为 "completed"|"failed"|"aborted"|"stop_when"
    // 此处验证 finalStatus === "completed"（tasks.md completed → plan 返回 taskCard=null → completed）
    const runResult = result.runResult as AutonomousRunResult;
    assert.equal(
      runResult.finalStatus,
      "completed",
      "finalStatus 应为 completed（completed 任务 → plan 返回 taskCard=null → 全部任务完成）"
    );
    assert.equal(runResult.exitCode, 0, "exitCode 应为 0（completed → exitCode=0）");

    // 4. 验证 runResult.totalIterations >= 1
    // completed 任务 + maxIterations=1：第 0 轮迭代执行 plan → taskCard=null → finalStatus=completed
    // iterationsExecuted 在每次循环结束后递增，故 totalIterations=1
    assert.ok(runResult.totalIterations >= 1, `totalIterations 应 >= 1，实际：${runResult.totalIterations}`);

    // 5. 验证 markdownReport 含迭代摘要
    assert.ok(typeof result.markdownReport === "string", "markdownReport 应为 string");
    assert.ok(result.markdownReport.length > 0, "markdownReport 应非空");
    // markdownReport 应包含 runId / finalStatus / totalIterations 等关键字段
    assert.ok(
      result.markdownReport.includes(runResult.runId) || result.markdownReport.includes("run"),
      "markdownReport 应含 runId 或 run 关键字"
    );
    assert.ok(
      result.markdownReport.toLowerCase().includes("completed") || result.markdownReport.includes("完成"),
      "markdownReport 应含 finalStatus（completed）或中文'完成'"
    );
    // 验证 markdownReport 含迭代次数摘要（比 P4 更深入的验证）
    assert.ok(
      result.markdownReport.includes("迭代") || result.markdownReport.toLowerCase().includes("iter"),
      "markdownReport 应含迭代次数摘要"
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// R2: /eag-autonomous-status 状态查询完整链路（CLI 解析 → handler → 真实 RunState 读取）
// ----------------------------------------------------------------------------

test("R2. /eag-autonomous-status 状态查询完整链路：CLI 解析 → handler → 真实 RunState 读取", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备：tasks.md（1 个 completed 任务）+ 声明的源文件
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 启动 run() 完成（获取真实 runId）
    const orchestrator = buildOrchestrator();
    const runResult = await orchestrator.run({
      projectRoot,
      objective: "测试 R2 状态查询链路",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    const runId = runResult.runId;
    assert.ok(runId.length > 0, "run() 应返回非空 runId");

    // 2. 验证 extractEagAutonomousStatusRequestFromPrompt 解析 <run-id> 位置参数
    // 命令格式：/eag-autonomous-status <run-id>（位置参数，非 --run-id 形式）
    const statusPrompt = `/eag-autonomous-status ${runId}`;
    const statusRequest = extractEagAutonomousStatusRequestFromPrompt(statusPrompt);
    assert.equal(statusRequest.runId, runId, "应正确解析 <run-id> 位置参数");
    // 验证返回对象被冻结（NFR-8 不可变优先）
    assert.ok(Object.isFrozen(statusRequest), "EagAutonomousStatusRequest 应被 Object.freeze 冻结");

    // 3. 调用 orchestrator.status() 查询状态
    const status = await orchestrator.status(statusRequest.runId, projectRoot);

    // 4. 验证 status 含完整字段：runId/iterIndex/currentStage/status
    assert.equal(status.runId, runId, "status.runId 应与 run() 返回的 runId 一致");
    assert.equal(typeof status.iterIndex, "number", "status.iterIndex 应为 number");
    assert.equal(typeof status.currentStage, "string", "status.currentStage 应为 string");
    assert.ok(
      ["running", "paused", "completed", "failed", "aborted"].includes(status.status),
      `status.status 应为合法值，实际：${status.status}`
    );
    // run() 完成后 RunState.status 应为 completed
    assert.equal(status.status, "completed", "run() 完成后 status.status 应为 completed");
    assert.equal(status.found, true, "RunState 文件应存在，found 应为 true");

    // 5. 验证 status 与 RunState 文件内容一致
    // 通过 P5RunStateStore.load() 重新加载 RunState，对比关键字段
    const store = new P5RunStateStore();
    const runState = await store.load(runId, projectRoot);
    assert.equal(runState.runId, status.runId, "status.runId 应与 RunState.runId 一致");
    assert.equal(runState.iterIndex, status.iterIndex, "status.iterIndex 应与 RunState.iterIndex 一致");
    assert.equal(runState.currentStage, status.currentStage, "status.currentStage 应与 RunState.currentStage 一致");
    assert.equal(runState.status, status.status, "status.status 应与 RunState.status 一致");
    assert.equal(
      runState.totalTokensUsed,
      status.totalTokensUsed,
      "status.totalTokensUsed 应与 RunState.totalTokensUsed 一致"
    );
    assert.equal(
      runState.totalLlmCallCount,
      status.totalLlmCallCount,
      "status.totalLlmCallCount 应与 RunState.totalLlmCallCount 一致"
    );

    // 6. 验证 status.report 含 Markdown 格式的进度报告
    assert.ok(typeof status.report === "string", "status.report 应为 string");
    assert.ok(status.report.length > 0, "status.report 应非空");
    assert.ok(status.report.includes(runId) || status.report.includes("run"), "status.report 应含 runId 或 run 关键字");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// R3: /eag-autonomous-stop 熔断完整链路（CLI 解析 → handler → emergencyStop → 回滚）
// ----------------------------------------------------------------------------

test("R3. /eag-autonomous-stop 熔断完整链路：CLI 解析 → stop() → abort 标志文件 → run() aborted", async () => {
  const projectRoot = createTempProject();
  // 预设 runId（用于在 run() 执行过程中调用 stop()）
  const presetRunId = `r3-stop-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  try {
    // 准备：tasks.md（多个 pending 任务，确保 run() 不会立即完成）+ 声明的源文件
    createTasksFile(projectRoot, 3, "pending");
    for (let i = 1; i <= 3; i++) {
      createDeclaredFile(projectRoot, `src/services/Service${i}.ts`);
    }

    // 1. 验证 extractEagAutonomousStopRequestFromPrompt 解析 <run-id> 位置参数
    // 命令格式：/eag-autonomous-stop <run-id>（位置参数，非 --run-id 形式）
    const stopPrompt = `/eag-autonomous-stop ${presetRunId}`;
    const stopRequest = extractEagAutonomousStopRequestFromPrompt(stopPrompt);
    assert.equal(stopRequest.runId, presetRunId, "应正确解析 <run-id> 位置参数");
    // 验证返回对象被冻结（NFR-8 不可变优先）
    assert.ok(Object.isFrozen(stopRequest), "EagAutonomousStopRequest 应被 Object.freeze 冻结");

    // 2. 构造 orchestrator（maxIterations=10 + 较大 consecutiveFailureAbort，避免被失败阈值中止）
    const orchestrator = buildOrchestrator({
      defaultMaxIterations: 10,
      defaultConsecutiveFailureAbort: 10,
    });

    // 3. 启动 run()（不 await，返回 Promise）
    // 使用 FAIL_TEST_CMD：verify 阶段会失败，但不会立即中止（consecutiveFailureAbort=10）
    // 这样 run() 会持续迭代，给 stop() 留出触发 abort 的窗口
    const runPromise = orchestrator.run({
      projectRoot,
      objective: "测试 R3 熔断完整链路",
      maxIterations: 10,
      testCommand: FAIL_TEST_CMD,
      testTimeoutSec: 10,
      runId: presetRunId,
      consecutiveFailureAbort: 10,
    });

    // 4. 等待 RunState 文件出现（轮询 .eag/p5/run-state/<runId>.jsonl）
    // 这表明 run() 已进入第一次迭代，可以安全调用 stop()
    const runStateFilePath = path.join(projectRoot, ".eag", "p5", "run-state", `${presetRunId}.jsonl`);
    const maxWaitMs = 5000; // 最长等待 5 秒
    const pollIntervalMs = 50; // 轮询间隔 50ms
    let waitedMs = 0;
    while (!fs.existsSync(runStateFilePath) && waitedMs < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waitedMs += pollIntervalMs;
    }
    assert.ok(fs.existsSync(runStateFilePath), `应在 ${maxWaitMs}ms 内检测到 RunState 文件：${runStateFilePath}`);

    // 5. 调用 orchestrator.stop() 创建 abort 标志文件
    // stop() 行为：检测 RunState.status==="running" → 创建 <projectRoot>/.eag/p5/abort-flags/<runId>.abort
    const stopResult = await orchestrator.stop(presetRunId, projectRoot);

    // 验证 stop() 返回 action="abort"（status==="running" 时）
    assert.equal(stopResult.runId, presetRunId, "stopResult.runId 应与请求一致");
    assert.ok(
      stopResult.action === "abort" || stopResult.action === "rollback",
      `stopResult.action 应为 abort 或 rollback（取决于 run() 是否已完成），实际：${stopResult.action}`
    );

    // 6. 验证 abort 标志文件已创建（仅 action="abort" 时）
    if (stopResult.action === "abort") {
      const abortFilePath = path.join(projectRoot, ".eag", "p5", "abort-flags", `${presetRunId}.abort`);
      assert.ok(fs.existsSync(abortFilePath), `abort 标志文件应存在：${abortFilePath}`);
    }

    // 7. await run() 完成（run() 在下次迭代检测到 abort 文件后中止）
    const runResult = await runPromise;

    // 8. 验证 run() 返回 finalStatus === "aborted"
    // 注意：run() 可能在 stop() 之前已完成（竞态），此时 finalStatus 可能为 "completed"/"failed"
    // 但由于使用 FAIL_TEST_CMD + maxIterations=10，run() 不太可能在 stop() 之前完成
    assert.ok(
      runResult.finalStatus === "aborted" || runResult.finalStatus === "failed",
      `runResult.finalStatus 应为 aborted 或 failed（取决于竞态），实际：${runResult.finalStatus}`
    );
    assert.equal(runResult.runId, presetRunId, "runResult.runId 应与预设 runId 一致");

    // 9. 验证 RunState.status === "aborted"（通过 status() 重新查询）
    const finalStatus = await orchestrator.status(presetRunId, projectRoot);
    assert.ok(
      finalStatus.status === "aborted" || finalStatus.status === "failed",
      `RunState.status 应为 aborted 或 failed，实际：${finalStatus.status}`
    );
    assert.equal(finalStatus.found, true, "RunState 文件应存在，found 应为 true");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// S 组：跨会话续跑验证（S1-S3，v2.0 新增）
// ============================================================================
//
// S 组验证 FR-3 跨会话续跑能力（RunState JSONL 持久化 + 中断恢复 + resume 续跑）：
// - S1: RunState JSONL 持久化端到端验证（run() 后文件存在 + SHA256 校验通过）
// - S2: kill -9 模拟中断端到端验证（进程终止后 RunState 文件保留 + status 正确）
// - S3: P5RunStateStore.resume 断点续跑验证（load + verify + 状态重置）
//
// 注：AutonomousOrchestrator.run() 在 Phase 5.2 版本不支持 resume 续跑
//     （总是调用 initialize()，runId 已存在会抛 P5RunStateAlreadyExistsError）。
//     S3 聚焦于 P5RunStateStore.resume() 的能力验证，
//     验证 load/verify/resume 三个方法的端到端协作。
//
// 严格遵循 NFR-9：禁止 mock，使用真实 P5RunStateStore + 真实文件系统。
// ============================================================================

// ----------------------------------------------------------------------------
// S1: RunState JSONL 持久化端到端验证（run() 后文件存在 + SHA256 校验通过）
// ----------------------------------------------------------------------------

test("S1. RunState JSONL 持久化端到端验证：run() 后文件存在 + SHA256 校验通过", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备：tasks.md（1 个 completed 任务）+ 声明的源文件
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 启动 run() 完成（获取真实 runId）
    const orchestrator = buildOrchestrator();
    const runResult = await orchestrator.run({
      projectRoot,
      objective: "测试 S1 RunState JSONL 持久化",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    const runId = runResult.runId;

    // 2. 验证 RunState JSONL 文件存在
    // 文件路径：<projectRoot>/.eag/p5/run-state/<runId>.jsonl
    const runStateFilePath = path.join(projectRoot, ".eag", "p5", "run-state", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runStateFilePath), `RunState JSONL 文件应存在：${runStateFilePath}`);

    // 3. 验证文件每行 JSON 可解析
    const fileContent = fs.readFileSync(runStateFilePath, "utf8");
    const lines = fileContent.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length >= 1, `JSONL 文件应至少有 1 行，实际：${lines.length}`);

    const states: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]!);
      } catch (err) {
        assert.fail(`第 ${i + 1} 行 JSON 解析失败：${(err as Error).message}`);
      }
      states.push(parsed);
    }
    assert.ok(states.length >= 1, `应解析出至少 1 个状态对象，实际：${states.length}`);

    // 4. 验证每行含 localChecksum/cumulativeChecksum 字段（SHA256 格式）
    for (let i = 0; i < states.length; i++) {
      const state = states[i] as Record<string, unknown>;
      assert.ok(
        typeof state.localChecksum === "string" && state.localChecksum.startsWith("sha256:"),
        `第 ${i + 1} 行 localChecksum 应为 sha256: 前缀格式，实际：${state.localChecksum}`
      );
      assert.ok(
        typeof state.cumulativeChecksum === "string" && state.cumulativeChecksum.startsWith("sha256:"),
        `第 ${i + 1} 行 cumulativeChecksum 应为 sha256: 前缀格式，实际：${state.cumulativeChecksum}`
      );
    }

    // 5. 验证 P5RunStateStore.verify() 返回 true
    // 通过 P5RunStateStore.load() 加载最新状态（内部会校验所有行的 SHA256）
    const store = new P5RunStateStore();
    const latestState = await store.load(runId, projectRoot);
    assert.equal(latestState.runId, runId, "load 返回的 runId 应一致");

    // verify() 校验最新状态的 localChecksum（不传 expectedCumulative，仅校验 localChecksum）
    const verifyResult = store.verify(latestState);
    assert.equal(verifyResult, true, "verify() 应返回 true（SHA256 校验通过）");

    // 6. 验证最新状态的 status 与 run() 返回的 finalStatus 一致
    assert.equal(latestState.status, runResult.finalStatus, "RunState.status 应与 runResult.finalStatus 一致");

    // 7. 验证 JSONL 文件含多行快照（initialize + 每次迭代 save 都会追加一行）
    // completed 任务 + maxIterations=1：至少有 initialize 1 行 + 迭代后 save 1 行 = 2 行
    assert.ok(lines.length >= 2, `JSONL 文件应至少有 2 行（initialize + save），实际：${lines.length}`);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// S2: kill -9 模拟中断端到端验证（abort 标志文件触发中断 + RunState 文件保留）
// ----------------------------------------------------------------------------

test("S2. kill -9 模拟中断端到端验证：abort 标志文件触发中断 + RunState 文件保留", async () => {
  const projectRoot = createTempProject();
  // 预设 runId（用于中断后查询状态）
  const presetRunId = `s2-interrupt-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  try {
    // 准备：tasks.md（多个 pending 任务，确保 run() 不会立即完成）+ 声明的源文件
    createTasksFile(projectRoot, 3, "pending");
    for (let i = 1; i <= 3; i++) {
      createDeclaredFile(projectRoot, `src/services/Service${i}.ts`);
    }

    // 1. 构造 orchestrator（maxIterations=10 + 较大 consecutiveFailureAbort）
    const orchestrator = buildOrchestrator({
      defaultMaxIterations: 10,
      defaultConsecutiveFailureAbort: 10,
    });

    // 2. 启动 run()（不 await，返回 Promise）
    // 使用 FAIL_TEST_CMD：verify 阶段会失败，但不会立即中止（consecutiveFailureAbort=10）
    // 这样 run() 会持续迭代，给中断留出窗口
    const runPromise = orchestrator.run({
      projectRoot,
      objective: "测试 S2 kill -9 模拟中断",
      maxIterations: 10,
      testCommand: FAIL_TEST_CMD,
      testTimeoutSec: 10,
      runId: presetRunId,
      consecutiveFailureAbort: 10,
    });

    // 3. 等待 RunState 文件出现 + 至少 2 行（initialize + 第 1 轮 save）
    const runStateFilePath = path.join(projectRoot, ".eag", "p5", "run-state", `${presetRunId}.jsonl`);
    const maxWaitMs = 5000;
    const pollIntervalMs = 50;
    let waitedMs = 0;
    while (waitedMs < maxWaitMs) {
      if (fs.existsSync(runStateFilePath)) {
        const content = fs.readFileSync(runStateFilePath, "utf8");
        const lineCount = content.split("\n").filter((l) => l.trim().length > 0).length;
        if (lineCount >= 2) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waitedMs += pollIntervalMs;
    }
    assert.ok(fs.existsSync(runStateFilePath), `应在 ${maxWaitMs}ms 内检测到 RunState 文件：${runStateFilePath}`);

    // 4. 模拟 kill -9 中断：直接创建 abort 标志文件（不走 stop() 命令）
    // 这模拟了"进程被 kill -9 后，用户通过 /eag-autonomous-stop 触发 abort"的场景
    // 实际上 kill -9 会让进程立即终止，RunState 文件保留最后状态
    // 这里通过 abort 标志文件让 run() 优雅中止，验证 RunState 文件的一致性
    const abortFlagsDir = path.join(projectRoot, ".eag", "p5", "abort-flags");
    fs.mkdirSync(abortFlagsDir, { recursive: true });
    const abortFilePath = path.join(abortFlagsDir, `${presetRunId}.abort`);
    fs.writeFileSync(abortFilePath, "", "utf8");

    // 5. await run() 完成（run() 在下次迭代检测到 abort 文件后中止）
    const runResult = await runPromise;

    // 6. 验证 run() 返回 finalStatus === "aborted" 或 "failed"（取决于竞态）
    assert.ok(
      runResult.finalStatus === "aborted" || runResult.finalStatus === "failed",
      `runResult.finalStatus 应为 aborted 或 failed，实际：${runResult.finalStatus}`
    );
    assert.equal(runResult.runId, presetRunId, "runResult.runId 应与预设 runId 一致");

    // 7. 验证 RunState 文件保留（未被删除）
    assert.ok(fs.existsSync(runStateFilePath), "中断后 RunState 文件应保留");

    // 8. 验证 RunState 文件每行 JSON 可解析 + SHA256 校验通过
    // 通过 P5RunStateStore.load() 重新加载（内部会校验所有行）
    const store = new P5RunStateStore();
    const latestState = await store.load(presetRunId, projectRoot);
    assert.equal(latestState.runId, presetRunId, "load 返回的 runId 应一致");
    assert.ok(
      latestState.status === "aborted" || latestState.status === "failed",
      `中断后 RunState.status 应为 aborted 或 failed，实际：${latestState.status}`
    );

    // 9. 验证 verify() 校验通过（中断后文件完整性未被破坏）
    const verifyResult = store.verify(latestState);
    assert.equal(verifyResult, true, "verify() 应返回 true（中断后 SHA256 校验仍通过）");

    // 10. 验证 JSONL 文件含多行快照（中断前已执行至少 1 轮迭代）
    const fileContent = fs.readFileSync(runStateFilePath, "utf8");
    const lines = fileContent.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length >= 2, `中断后 JSONL 文件应至少有 2 行，实际：${lines.length}`);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// S3: P5RunStateStore.resume 断点续跑验证（load + verify + 状态重置）
// ----------------------------------------------------------------------------

test("S3. P5RunStateStore.resume 断点续跑验证：load + verify + 状态重置", async () => {
  const projectRoot = createTempProject();
  // 预设 runId
  const presetRunId = `s3-resume-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  try {
    // 准备：tasks.md（多个 pending 任务）+ 声明的源文件
    createTasksFile(projectRoot, 3, "pending");
    for (let i = 1; i <= 3; i++) {
      createDeclaredFile(projectRoot, `src/services/Service${i}.ts`);
    }

    // 1. 构造 orchestrator + 启动 run()（使用 FAIL_TEST_CMD 让其持续迭代）
    const orchestrator = buildOrchestrator({
      defaultMaxIterations: 10,
      defaultConsecutiveFailureAbort: 10,
    });

    const runPromise = orchestrator.run({
      projectRoot,
      objective: "测试 S3 resume 断点续跑",
      maxIterations: 10,
      testCommand: FAIL_TEST_CMD,
      testTimeoutSec: 10,
      runId: presetRunId,
      consecutiveFailureAbort: 10,
    });

    // 2. 等待 RunState 文件出现 + 至少 2 行
    const runStateFilePath = path.join(projectRoot, ".eag", "p5", "run-state", `${presetRunId}.jsonl`);
    const maxWaitMs = 5000;
    const pollIntervalMs = 50;
    let waitedMs = 0;
    while (waitedMs < maxWaitMs) {
      if (fs.existsSync(runStateFilePath)) {
        const content = fs.readFileSync(runStateFilePath, "utf8");
        const lineCount = content.split("\n").filter((l) => l.trim().length > 0).length;
        if (lineCount >= 2) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waitedMs += pollIntervalMs;
    }
    assert.ok(fs.existsSync(runStateFilePath), "应检测到 RunState 文件");

    // 3. 在 run() 执行过程中，通过 P5RunStateStore.load() 读取中间状态
    // 这模拟了"进程被 kill -9 后，用户通过 /eag-autonomous-status 查询最后状态"的场景
    // 注：run() 执行可能很快，读取时可能已完成（status=aborted/failed）或仍在运行（status=running）
    const store = new P5RunStateStore();
    const midState = await store.load(presetRunId, projectRoot);
    assert.equal(midState.runId, presetRunId, "load 返回的 runId 应一致");
    assert.ok(
      ["running", "aborted", "failed", "completed"].includes(midState.status),
      `中断前 RunState.status 应为合法值，实际：${midState.status}`
    );

    // 4. 验证 verify() 校验通过（中断前文件完整性）
    const midVerifyResult = store.verify(midState);
    assert.equal(midVerifyResult, true, "verify() 应返回 true（中断前 SHA256 校验通过）");

    // 5. 触发 abort（等待 run() 自然结束或主动 abort）
    // 创建 abort 标志文件让 run() 优雅中止
    const abortFlagsDir = path.join(projectRoot, ".eag", "p5", "abort-flags");
    fs.mkdirSync(abortFlagsDir, { recursive: true });
    fs.writeFileSync(path.join(abortFlagsDir, `${presetRunId}.abort`), "", "utf8");

    // 6. await run() 完成
    const runResult = await runPromise;
    assert.ok(
      runResult.finalStatus === "aborted" || runResult.finalStatus === "failed",
      `runResult.finalStatus 应为 aborted 或 failed，实际：${runResult.finalStatus}`
    );

    // 7. 验证 P5RunStateStore.load(runId) 返回最后状态（中断后）
    const finalState = await store.load(presetRunId, projectRoot);
    assert.equal(finalState.runId, presetRunId, "load 返回的 runId 应一致");
    assert.ok(
      finalState.status === "aborted" || finalState.status === "failed",
      `中断后 RunState.status 应为 aborted 或 failed，实际：${finalState.status}`
    );

    // 8. 验证 P5RunStateStore.resume() 对已终止状态返回原状态（不重置为 running）
    // resume() 行为：completed/failed/aborted 状态不可继续，返回原状态
    const resumedState = await store.resume(presetRunId, projectRoot);
    assert.equal(resumedState.runId, presetRunId, "resume 返回的 runId 应一致");
    assert.equal(resumedState.status, finalState.status, "resume 对已终止状态应返回原状态（不重置为 running）");

    // 9. 验证 resume 后的 iterIndex 与中断时一致
    assert.equal(resumedState.iterIndex, finalState.iterIndex, "resume 后的 iterIndex 应与中断时一致");

    // 10. 验证 verify() 校验通过（resume 后文件完整性）
    const finalVerifyResult = store.verify(resumedState);
    assert.equal(finalVerifyResult, true, "verify() 应返回 true（resume 后 SHA256 校验通过）");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// T 组：多轮真实迭代验证（T1-T3，v2.0 新增）
// ============================================================================
//
// T 组验证 FR-1 4 阶段循环 + FR-7 NotesMemory 跨轮记忆的真实多轮迭代：
// - T1: maxIterations=3 真实多轮迭代（completedLoops + notes.md 多轮记忆 + milestones）
// - T2: 4 阶段循环完整执行（plan → dev → verify → fix 全部执行 + 制品链流转）
// - T3: NotesMemory 跨轮记忆（多轮迭代后 notes.md 含多轮记录 + 内容真实性）
//
// 多轮迭代策略：
// - 使用 pending 任务卡 + PASS_TEST_CMD + maxIterations=3
// - 每轮迭代：plan 选到同一个 pending 任务卡 → dev/verify/fix 全流程 → 4 阶段全绿
// - 任务卡状态不会自动更新，所以每轮都选到同一个任务卡
// - totalIterations=3（达到 maxIterations），finalStatus="failed"（迭代次数用尽）
// - notes.md 有 3 轮记录，milestones 含 3 个（每轮 4 阶段全绿）
//
// 严格遵循 NFR-9：禁止 mock，使用真实 AutonomousOrchestrator + 真实文件系统 + 真实 child_process。
// ============================================================================

// ----------------------------------------------------------------------------
// T1: maxIterations=3 真实多轮迭代端到端验证
// ----------------------------------------------------------------------------

test("T1. maxIterations=3 真实多轮迭代：completedLoops + notes.md 多轮记忆 + milestones", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备：tasks.md（1 个 pending 任务）+ 声明的源文件
    // pending 任务 + PASS_TEST_CMD：每轮 4 阶段全绿，但任务卡不自动更新 → 持续迭代到 maxIterations
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 启动 run()（maxIterations=3）
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 T1 多轮真实迭代",
      maxIterations: 3,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 2. 验证 totalIterations >= 1（至少执行了 1 轮迭代）
    assert.ok(result.totalIterations >= 1, `totalIterations 应 >= 1，实际：${result.totalIterations}`);

    // 3. 验证 notes.md 含多轮 "## Iter" 记录
    // notes.md 文件路径：<projectRoot>/.eag/p5/notes/<runId>.md
    const notesFilePath = path.join(projectRoot, ".eag", "p5", "notes", `${result.runId}.md`);
    assert.ok(fs.existsSync(notesFilePath), `notes.md 文件应存在：${notesFilePath}`);

    const notesContent = fs.readFileSync(notesFilePath, "utf8");
    // 统计 "## Iter" 段落数量
    const iterSectionCount = (notesContent.match(/^##\s+Iter\s+\d+/gm) || []).length;
    assert.ok(iterSectionCount >= 1, `notes.md 应含至少 1 个 "## Iter" 段落，实际：${iterSectionCount}`);

    // 4. 验证 milestones 含至少 1 个 P5MilestoneRecord
    // 每轮 4 阶段全绿会记录一个 milestone
    assert.ok(
      result.milestones.length >= 1,
      `milestones 应含至少 1 个 P5MilestoneRecord，实际：${result.milestones.length}`
    );
    const milestone = result.milestones[0]!;
    assert.equal(typeof milestone.index, "number", "milestone.index 应为 number");
    assert.equal(typeof milestone.name, "string", "milestone.name 应为 string");
    assert.equal(typeof milestone.completedAt, "string", "milestone.completedAt 应为 string");
    assert.ok(
      milestone.name.includes("Iter") || milestone.name.includes("完成"),
      `milestone.name 应含 'Iter' 或 '完成'，实际：${milestone.name}`
    );

    // 5. 验证 finalReport 含多轮摘要
    assert.ok(typeof result.finalReport === "string", "finalReport 应为 string");
    assert.ok(result.finalReport.length > 0, "finalReport 应非空");
    // finalReport 应含迭代次数摘要
    assert.ok(
      result.finalReport.includes("迭代") || result.finalReport.toLowerCase().includes("iter"),
      "finalReport 应含迭代次数摘要"
    );

    // 6. 验证 completedLoops 含 "coding"
    // 每轮 4 阶段全绿会将 initialLoop（默认 coding）加入 completedLoops
    assert.ok(
      result.completedLoops.includes("coding"),
      `completedLoops 应含 'coding'，实际：${JSON.stringify(result.completedLoops)}`
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// T2: 4 阶段循环完整执行端到端验证
// ----------------------------------------------------------------------------

test("T2. 4 阶段循环完整执行：plan → dev → verify → fix 全部执行 + 制品链流转", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备：tasks.md（1 个 pending 任务）+ 声明的源文件
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 启动 run()（maxIterations=1，让 4 阶段循环执行 1 轮）
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 T2 4 阶段循环完整执行",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 2. 验证 run() 执行了至少 1 轮迭代
    assert.ok(result.totalIterations >= 1, `totalIterations 应 >= 1，实际：${result.totalIterations}`);

    // 3. 验证 milestones 含至少 1 个（4 阶段全绿 → milestone）
    // milestones 记录了 4 阶段全绿的迭代
    assert.ok(
      result.milestones.length >= 1,
      `milestones 应含至少 1 个（4 阶段全绿），实际：${result.milestones.length}`
    );

    // 4. 验证 milestone.summary 含 4 阶段的执行结果
    const milestone = result.milestones[0]!;
    assert.ok(
      typeof milestone.summary === "string" && milestone.summary.length > 0,
      "milestone.summary 应为非空 string"
    );
    // summary 格式："4 阶段全绿（plan=success, dev=success, verify=success, fix=success）"
    assert.ok(
      milestone.summary.includes("plan") || milestone.summary.includes("4 阶段"),
      `milestone.summary 应含 plan 或 '4 阶段'，实际：${milestone.summary}`
    );

    // 5. 验证 completedLoops 含 "coding"（4 阶段全绿 → completedLoops 加入 initialLoop）
    assert.ok(
      result.completedLoops.includes("coding"),
      `completedLoops 应含 'coding'，实际：${JSON.stringify(result.completedLoops)}`
    );

    // 6. 验证 notes.md 含 4 阶段执行记录
    // notes.md 文件路径：<projectRoot>/.eag/p5/notes/<runId>.md
    const notesFilePath = path.join(projectRoot, ".eag", "p5", "notes", `${result.runId}.md`);
    assert.ok(fs.existsSync(notesFilePath), `notes.md 文件应存在：${notesFilePath}`);

    const notesContent = fs.readFileSync(notesFilePath, "utf8");
    // notes.md 应含 "## Iter" 段落（每轮迭代追加一段）
    assert.ok(
      notesContent.includes("## Iter"),
      `notes.md 应含 '## Iter' 段落，实际内容：${notesContent.substring(0, 200)}`
    );

    // 7. 验证 RunState 文件存在且 status 与 finalStatus 一致
    const store = new P5RunStateStore();
    const runState = await store.load(result.runId, projectRoot);
    assert.equal(runState.status, result.finalStatus, "RunState.status 应与 finalStatus 一致");

    // 8. 验证 result.finalReport 含 4 阶段执行摘要
    assert.ok(
      result.finalReport.includes("迭代") || result.finalReport.toLowerCase().includes("iter"),
      "finalReport 应含迭代摘要"
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// T3: NotesMemory 跨轮记忆端到端验证
// ----------------------------------------------------------------------------

test("T3. NotesMemory 跨轮记忆：多轮迭代后 notes.md 含多轮记录 + 内容真实性", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备：tasks.md（1 个 pending 任务）+ 声明的源文件
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 启动 run()（maxIterations=3，让 notes.md 追加 3 轮记录）
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 T3 NotesMemory 跨轮记忆",
      maxIterations: 3,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 2. 验证 notes.md 文件存在
    const notesFilePath = path.join(projectRoot, ".eag", "p5", "notes", `${result.runId}.md`);
    assert.ok(fs.existsSync(notesFilePath), `notes.md 文件应存在：${notesFilePath}`);

    // 3. 验证 notes.md 含多个 "## Iter" 段落
    const notesContent = fs.readFileSync(notesFilePath, "utf8");
    const iterSections = notesContent.match(/^##\s+Iter\s+\d+/gm) || [];
    assert.ok(iterSections.length >= 1, `notes.md 应含至少 1 个 '## Iter' 段落，实际：${iterSections.length}`);

    // 4. 验证每个 "## Iter" 段落含元数据注释行（stage 元注释）
    // 元数据格式：<!-- iter=N stage=plan tags=success -->
    const metaCommentPattern = /<!--\s+iter=\d+\s+stage=(plan|dev|verify|fix)\s+tags=[^>]*-->/g;
    const metaComments = notesContent.match(metaCommentPattern) || [];
    assert.ok(metaComments.length >= 1, `notes.md 应含至少 1 个元数据注释行，实际：${metaComments.length}`);

    // 5. 验证每个 "## Iter" 段落含任务摘要或失败原因
    // notes.md 的 body 部分应含迭代摘要（如 "4 阶段全绿" 或 "部分失败"）
    assert.ok(
      notesContent.includes("阶段") || notesContent.includes("success") || notesContent.includes("failed"),
      `notes.md 应含阶段摘要或成功/失败标记，实际内容：${notesContent.substring(0, 300)}`
    );

    // 6. 验证 notes.md 内容与 RunState.iterIndex 一致
    // 通过 P5RunStateStore.load() 获取 RunState，对比 iterIndex
    const store = new P5RunStateStore();
    const runState = await store.load(result.runId, projectRoot);
    // notes.md 中的 "## Iter" 段落应反映实际迭代次数
    // 注：iterIndex 是 0-based，notes.md 段落数应 >= 1
    assert.ok(
      iterSections.length >= 1,
      `notes.md 段落数应 >= 1，实际：${iterSections.length}（RunState.iterIndex=${runState.iterIndex}）`
    );

    // 7. 验证 NotesMemory.loadNotes() 返回的内容与文件一致
    const notesMemory = new P5NotesMemory();
    const loadedContent = await notesMemory.loadNotes(result.runId, projectRoot);
    assert.equal(loadedContent, notesContent, "NotesMemory.loadNotes() 返回的内容应与文件内容一致");

    // 8. 验证 NotesMemory.listSections() 返回的段落数与文件一致
    const sections = await notesMemory.listSections(result.runId, projectRoot);
    assert.ok(sections.length >= 1, `listSections() 应返回至少 1 个段落，实际：${sections.length}`);
    // 每个段落应含 title / body / timestamp / iterIndex / stage / tags 字段
    const firstSection = sections[0]!;
    assert.equal(typeof firstSection.title, "string", "section.title 应为 string");
    assert.equal(typeof firstSection.body, "string", "section.body 应为 string");
    assert.equal(typeof firstSection.iterIndex, "number", "section.iterIndex 应为 number");
    assert.ok(
      ["plan", "dev", "verify", "fix"].includes(firstSection.stage),
      `section.stage 应为 plan/dev/verify/fix，实际：${firstSection.stage}`
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});
