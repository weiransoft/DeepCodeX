/**
 * EAG-P5 基线红灯守卫 / 统计口径统一 / P2 状态机 单元测试（2026-11-08 生产修复）
 *
 * 真实事故：verify 报的 2 个失败用例与任务卡 T-068 无关，属 run 起始既有基线红灯；
 * EAG 却把它们算成本任务失败 → 失败指纹两轮相同 → 确定性失败熔断 abort，
 * fix 阶段还整卡重跑。本测试覆盖 5 项修复 + 诚实降级红线。
 *
 * 测试约定（NFR-9 禁止 mock / 禁止伪造通过）：
 * - node:test + node:assert/strict，不用 mock 框架；
 * - 测试命令全部真实 spawnSync 执行（node -e 输出真实 runner 风格文本）；
 * - orchestrator 用真实 4 handlers + 真实 guardChain/smartConfirmation，
 *   仅用 createAlwaysSucceedTaskExecutor 替身替代 LLM 网络往返；
 * - 禁止把真失败说成通过：所有断言都要求 verify 结果仍为 failed。
 *
 * @module core/tests/eag-p5-baseline-guard
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { collectBaselineFailures } from "../eag/p5/handlers/baseline-guard";
import { P5VerifyStageHandler } from "../eag/p5/handlers/verify-stage-handler";
import { P5DevStageHandler, DEV_REASON_SKIPPED_AFTER_FIX } from "../eag/p5/handlers/dev-stage-handler";
import { P5FixStageHandler } from "../eag/p5/handlers/fix-stage-handler";
import { createSuccessStageResult, createFailedStageResult } from "../eag/p5/handlers/types";
import type { P5TaskExecutor } from "../eag/p5/handlers/task-executor-port";
// 命令层精确契约：result.runResult.failedTestIds（session.ts extractAutonomousRunDetails 读取位置）
import { EagAutonomousCommandHandler } from "../eag/cli/eag-autonomous-command";
import type { EagAutonomousRequest } from "../eag/cli/eag-autonomous-command";

import {
  buildStageContext,
  buildOrchestrator,
  createAlwaysSucceedTaskExecutor,
  createTestTaskCard,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  PASS_TEST_CMD,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// 1. 测试命令（真实 spawnSync 执行，输出可被 parseTestOutput / extractFailedTestIds 解析）
// ============================================================================

/**
 * 2 个"run 起始既有"失败用例（带 ✕ 用例名），Jest 统计 0 passed / 2 failed、退出码 1。
 * process.argv 逐项 console.log，避免命令里出现反斜杠 / 模板插值，保证 parseShellCommand
 * 白名单 tokenize 与 verify 完全同款。
 */
const TWO_BASELINE_FAILURES_CMD =
  `node -e 'for(const a of process.argv.slice(1))console.log(a);console.log("Tests: 0 passed, 2 failed");process.exit(1)'` +
  ` "  ✕ 基线A" "  ✕ 基线B"`;

/** 3 个失败：2 个基线 + 1 个本任务新增 */
const THREE_FAILURES_CMD =
  `node -e 'for(const a of process.argv.slice(1))console.log(a);console.log("Tests: 0 passed, 3 failed");process.exit(1)'` +
  ` "  ✕ 基线A" "  ✕ 基线B" "  ✕ 新增C"`;

/** 有失败统计但无任何失败用例标识（回归安全关键：不得被误判为可信基线清单） */
const NO_IDS_FAIL_CMD = `node -e 'console.log("Tests: 0 passed, 1 failed");process.exit(1)'`;

/** 运行起始全绿命令 */
const ALL_GREEN_CMD = `node -e 'console.log("Tests: 2 passed, 0 failed")'`;

/** 环境变量辅助：临时确保基线守卫开启（返回恢复函数） */
function withGuardOn(): () => void {
  const prev = process.env.EAG_BASELINE_GUARD;
  delete process.env.EAG_BASELINE_GUARD;
  return () => {
    if (prev === undefined) {
      delete process.env.EAG_BASELINE_GUARD;
    } else {
      process.env.EAG_BASELINE_GUARD = prev;
    }
  };
}

/** 环境变量辅助：临时设置守卫值（返回恢复函数） */
function withGuardValue(value: string): () => void {
  const prev = process.env.EAG_BASELINE_GUARD;
  process.env.EAG_BASELINE_GUARD = value;
  return () => {
    if (prev === undefined) {
      delete process.env.EAG_BASELINE_GUARD;
    } else {
      process.env.EAG_BASELINE_GUARD = prev;
    }
  };
}

/** 构造命令层 EagAutonomousRequest（直接装配，避开 prompt 解析的引号边界）。 */
function buildCommandRequest(testCommand: string): Readonly<EagAutonomousRequest> {
  return Object.freeze({
    goal: "失败用例透传验证",
    maxIterations: 2,
    confirmation: "smart" as const,
    testCommand,
    stopWhen: "",
    maxTokens: 200000,
    testTimeoutSec: 15,
    consecutiveFailureAbort: 5,
  });
}

// ============================================================================
// B1. collectBaselineFailures 正常解析 + 诚实降级
// ============================================================================

test("B1. collectBaselineFailures 正常解析出失败用例，异常/无标识/全绿均诚实降级", () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    // 正常：真实 spawn 一次，解析出 2 个基线失败用例
    const ok = collectBaselineFailures(projectRoot, TWO_BASELINE_FAILURES_CMD, 10_000);
    assert.equal(ok.available, true, "有可信基线红灯清单 → available=true");
    assert.deepEqual(ok.ids, ["基线A", "基线B"], "应识别到两个 run 起始既有失败用例");
    assert.ok(ok.reason.length > 0, "reason 非空");

    // 无法启动（白名单 basename 但程序不存在 → ENOENT）→ 降级
    const noStart = collectBaselineFailures(projectRoot, "/nonexistent-eag-bin/pytest -q", 10_000);
    assert.equal(noStart.available, false, "无法启动 → available=false");
    assert.ok(noStart.reason.length > 0, "降级原因非空");
    assert.deepEqual(noStart.ids, [], "降级时不排除任何失败");

    // 无测试计数（命令成功但输出无可解析统计）→ 降级
    const noStats = collectBaselineFailures(projectRoot, `node -e 'console.log("hello")'`, 10_000);
    assert.equal(noStats.available, false, "无测试计数 → available=false");
    assert.ok(noStats.reason.length > 0);

    // 命令被白名单/shell 校验拒绝 → 降级（不抛异常）
    const rejected = collectBaselineFailures(projectRoot, `node -e 'x' && rm -rf /`, 10_000);
    assert.equal(rejected.available, false, "命令被拒 → available=false");
    assert.ok(rejected.reason.length > 0);

    // failed>0 却提取不到任何用例标识 → 诚实降级（保护既有回归：FAIL_TEST_CMD 场景
    // 不会被误判为 baselineOnly 而逃过确定性失败熔断）
    const noIds = collectBaselineFailures(projectRoot, NO_IDS_FAIL_CMD, 10_000);
    assert.equal(noIds.available, false, "无可识别用例标识 → 必须降级，绝不臆造基线清单");
    assert.ok(noIds.reason.includes("未提取到") || noIds.reason.length > 0);

    // 运行起始测试全绿 → 无基线红灯清单 → 降级（不排除任何失败）
    const allGreen = collectBaselineFailures(projectRoot, ALL_GREEN_CMD, 10_000);
    assert.equal(allGreen.available, false, "全绿 → 无基线红灯清单");
    assert.ok(allGreen.reason.length > 0);
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

test("B1b. collectBaselineFailures 超时 → available=false 且 reason 非空", () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    // 命令睡眠 3s；timeoutMs 传小值（内部夹到 1000ms）→ spawnSync SIGTERM 超时
    const timedOut = collectBaselineFailures(projectRoot, `node -e 'setTimeout(()=>{},3000)'`, 1000);
    assert.equal(timedOut.available, false, "超时 → available=false");
    assert.ok(timedOut.reason.length > 0, "降级原因非空");
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B2. verify 拆分基线 / 新增失败（artifacts + summary 如实）
// ============================================================================

test("B2. verify 拆分：基线 2 个 + 新增 1 个 → artifacts 三字段正确、summary 如实", async () => {
  const projectRoot = createTempProject();
  try {
    const ctx = buildStageContext(projectRoot, "verify", {
      testCommand: THREE_FAILURES_CMD,
      baselineFailedTestIds: new Set(["基线A", "基线B"]),
      baselineAvailable: true,
    });
    const result = await new P5VerifyStageHandler().handle(ctx);

    assert.equal(result.kind, "failed", "verify 结果仍如实 failed（绝不声称通过）");
    // 原始失败用例清单保持不变
    assert.deepEqual(result.artifacts["failedTestIds"], ["基线A", "基线B", "新增C"]);
    // 三个新制品
    assert.equal(result.artifacts["baselineOnly"], false, "有新增失败 → 非 baselineOnly");
    assert.deepEqual(result.artifacts["newFailedTestIds"], ["新增C"]);
    assert.deepEqual(result.artifacts["baselineFailedTestIds"], ["基线A", "基线B"]);
    assert.equal(result.artifacts["baselineAvailable"], true);
    // summary 如实：含基线失败、新增失败、列出新增用例，且不含"测试通过"
    assert.ok(result.summary.includes("基线失败"), "summary 含「基线失败」");
    assert.ok(result.summary.includes("新增失败"), "summary 含「新增失败」");
    assert.ok(result.summary.includes("新增C"), "summary 列出新增用例");
    assert.ok(!result.summary.includes("测试通过"), "summary 绝不含「测试通过」");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B2b. verify 纯基线失败 → baselineOnly=true 且 summary 不省略基线仍失败的事实", async () => {
  const projectRoot = createTempProject();
  try {
    const ctx = buildStageContext(projectRoot, "verify", {
      testCommand: TWO_BASELINE_FAILURES_CMD,
      baselineFailedTestIds: new Set(["基线A", "基线B"]),
      baselineAvailable: true,
    });
    const result = await new P5VerifyStageHandler().handle(ctx);

    assert.equal(result.kind, "failed", "纯基线失败轮 verify 仍如实 failed");
    assert.equal(result.artifacts["baselineOnly"], true);
    assert.deepEqual(result.artifacts["newFailedTestIds"], []);
    assert.deepEqual(result.artifacts["baselineFailedTestIds"], ["基线A", "基线B"]);
    assert.ok(result.summary.includes("基线失败"), "summary 含「基线失败」");
    assert.ok(result.summary.includes("基线红灯仍失败"), "summary 不省略基线仍失败的事实");
    assert.ok(!result.summary.includes("测试通过"), "summary 绝不含「测试通过」");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B2c. 基线探测降级 → verify 不排除任何失败、不误判 baselineOnly", async () => {
  const projectRoot = createTempProject();
  try {
    // 不注入 baselineFailedTestIds / baselineAvailable（等价于 orchestrator 采集失败）
    const ctx = buildStageContext(projectRoot, "verify", { testCommand: TWO_BASELINE_FAILURES_CMD });
    const result = await new P5VerifyStageHandler().handle(ctx);

    assert.equal(result.kind, "failed");
    assert.equal(result.artifacts["baselineAvailable"], false);
    assert.equal(result.artifacts["baselineOnly"], false, "降级时绝不做任何排除");
    assert.deepEqual(result.artifacts["newFailedTestIds"], [], "降级时不做拆分");
    assert.deepEqual(result.artifacts["baselineFailedTestIds"], []);
    // 原始失败清单仍保留（如实）
    assert.deepEqual(result.artifacts["failedTestIds"], ["基线A", "基线B"]);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B2d. 基线可用但本轮无用例标识 → 不拆分、不误判 baselineOnly、summary 不误导", async () => {
  const projectRoot = createTempProject();
  try {
    const ctx = buildStageContext(projectRoot, "verify", {
      testCommand: NO_IDS_FAIL_CMD,
      baselineFailedTestIds: new Set(["基线A", "基线B"]),
      baselineAvailable: true,
    });
    const result = await new P5VerifyStageHandler().handle(ctx);

    assert.equal(result.kind, "failed");
    assert.equal(result.artifacts["baselineOnly"], false, "无用例标识 → 绝不判 baselineOnly 逃过熔断");
    assert.deepEqual(result.artifacts["newFailedTestIds"], []);
    assert.deepEqual(result.artifacts["baselineFailedTestIds"], []);
    assert.ok(result.summary.includes("未做拆分"), "summary 明确写未做拆分，避免 0+0 误导");
    assert.ok(!result.summary.includes("测试通过"));
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B3 / B6. baselineOnly 连续 2 轮不触发确定性失败熔断（真实 orchestrator.run）
// ============================================================================

test("B3. 基线红灯连续 2 轮不再触发确定性失败熔断 abort（真实 orchestrator.run）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const orchestrator = buildOrchestrator({
      taskExecutor: createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
    });

    const result = await orchestrator.run({
      projectRoot,
      objective: "验证基线红灯不拖进失败熔断",
      maxIterations: 4,
      consecutiveFailureAbort: 5,
      testCommand: TWO_BASELINE_FAILURES_CMD,
      testTimeoutSec: 15,
    });

    assert.notEqual(result.finalStatus, "aborted", "不得被基线红灯拖进确定性失败熔断 abort");
    assert.ok(result.totalIterations >= 2, "应至少跑 2 轮（覆盖『连续 2 轮』场景）");
    assert.equal(result.finalStatus, "failed", "由迭代次数用尽诚实收尾（任务未验证通过，非伪造成功）");
    // 终止原因口径（blockageReport.summary 来自真实 abortReason）不得误报为熔断。
    // 不拼 finalReport：它会原样回显 objective 文本，可能恰好含这些字样造成误判。
    const terminationText = result.blockageReport?.summary ?? "";
    assert.ok(!terminationText.includes("确定性失败熔断"), "终止原因不得误报确定性失败熔断口径");

    // 阻塞报告真实化：根因假设用真实基线信息、verify 分支含针对性建议
    const report = result.blockageReport;
    assert.ok(report !== undefined, "failed 收尾应生成 blockageReport");
    const hypotheses = report!.rootCauseHypotheses.join("\n");
    assert.ok(hypotheses.includes("基线A") || hypotheses.includes("基线探测"), "根因假设应含真实基线用例信息");
    const solutions = report!.suggestedSolutions.join("\n");
    assert.ok(
      solutions.includes("先单独修复或配置忽略 run 起始既有失败") || solutions.includes("projectRoot"),
      "verify 分支应含基线红灯针对性建议"
    );
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

test("B6. EAG_BASELINE_GUARD=0 关闭时不做任何排除（诚实降级）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardValue("0");
  try {
    // 单元：collectBaselineFailures 直接降级
    const snapshot = collectBaselineFailures(projectRoot, TWO_BASELINE_FAILURES_CMD, 10_000);
    assert.equal(snapshot.available, false);
    assert.deepEqual(snapshot.ids, []);
    assert.ok(snapshot.reason.includes("EAG_BASELINE_GUARD=0"));

    // 集成：关闭守卫后，同样的基线红灯按确定性失败熔断 abort（B3 的对比组），
    // 证明"开关关闭时确实不排除任何失败"。
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const orchestrator = buildOrchestrator({
      taskExecutor: createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
    });
    const result = await orchestrator.run({
      projectRoot,
      objective: "关闭守卫对比组",
      maxIterations: 5,
      consecutiveFailureAbort: 5,
      testCommand: TWO_BASELINE_FAILURES_CMD,
      testTimeoutSec: 15,
    });
    assert.equal(result.finalStatus, "aborted", "关闭守卫 → 同样基线红灯触发确定性失败熔断（对比 B3）");
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B4. changedFiles 统计口径统一（dev / fix handler）
// ============================================================================

test("B4. changedFiles 过滤：基线脏文件不计入本次产出（dev handler）", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "选取任务卡", { taskCard });
    const executor = createAlwaysSucceedTaskExecutor({
      changedFiles: ["src/services/Service1.ts", "工作区既有.ts", "本次产出.ts"],
    });
    const ctx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
      baselineDirtyPaths: new Set(["工作区既有.ts"]),
      taskExecutor: executor,
    });
    const result = await new P5DevStageHandler().handle(ctx);

    assert.equal(result.kind, "success");
    assert.deepEqual(result.artifacts["changedFiles"], ["src/services/Service1.ts", "本次产出.ts"]);
    assert.equal(result.artifacts["workspaceChangedFilesTotal"], 3, "审计字段保留全量工作区变更数");
    assert.ok(result.summary.includes("本次产出 2 个文件"), "summary 用过滤后的本次产出数");
    assert.ok(result.summary.includes("工作区既有 1 个未计入"), "summary 含「工作区既有 M 个未计入」");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B4b. changedFiles 过滤 + fixApplied/fixTaskCardId（fix handler）", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "选取任务卡", { taskCard });
    // 构造 verify 失败结果：findVerifyFailure 在批内兼容模式扫描 prevResults
    const verifyFailed = createFailedStageResult("verify", "failed", "测试失败", "测试失败：exitCode=1", {
      testStats: { passed: 0, failed: 2, skipped: 0, total: 2 },
      testOutputTail: "  ✕ 基线A\n  ✕ 基线B\nTests: 0 passed, 2 failed",
      completionEvidence: { testExitCode: 1, testOutputSummary: "  ✕ 基线A\n  ✕ 基线B" },
      commandResult: { exitCode: 1, timedOut: false },
    });
    const executor = createAlwaysSucceedTaskExecutor({ changedFiles: ["工作区既有.ts", "修复产出.ts"] });
    const ctx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([planResult, verifyFailed]),
      baselineDirtyPaths: new Set(["工作区既有.ts"]),
      taskExecutor: executor,
    });
    const result = await new P5FixStageHandler().handle(ctx);

    assert.equal(result.kind, "success");
    assert.deepEqual(result.artifacts["changedFiles"], ["修复产出.ts"]);
    assert.equal(result.artifacts["workspaceChangedFilesTotal"], 2);
    assert.ok(result.summary.includes("工作区既有 1 个未计入"));
    // P2 状态机前置：fix 成功必须打标记
    assert.equal(result.artifacts["fixApplied"], true);
    assert.equal(result.artifacts["fixTaskCardId"], "T-001");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B5. skipDevAfterFix：fix 后同卡不再从 dev 重跑整卡
// ============================================================================

test("B5. skipDevAfterFix：同卡 → dev 零执行器调用 + reason；flag=false → 正常执行", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "选取任务卡", { taskCard });

    let calls = 0;
    const base = createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] });
    const spy: P5TaskExecutor = {
      executeTask: async (input) => {
        calls += 1;
        return base.executeTask(input);
      },
    };

    // 同卡（orchestrator 置 skipDevAfterFix=true）：dev 零执行器调用
    const skipCtx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
      skipDevAfterFix: true,
      taskExecutor: spy,
    });
    const skipped = await new P5DevStageHandler().handle(skipCtx);
    assert.equal(skipped.kind, "success");
    assert.equal(skipped.artifacts["reason"], DEV_REASON_SKIPPED_AFTER_FIX);
    assert.equal(skipped.artifacts["skipped"], true);
    assert.equal(skipped.artifacts["noop"], false, "跳过 dev 不等于空转，不得误触发空转熔断");
    assert.ok(skipped.summary.includes("复用上一轮 fix 的增量修复，直接进入复验"));
    assert.equal(calls, 0, "跳过时 dev 不得调用 taskExecutor");

    // 不同卡（orchestrator 不置 flag → false）：dev 正常执行
    const normalCtx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
      skipDevAfterFix: false,
      taskExecutor: spy,
    });
    const normal = await new P5DevStageHandler().handle(normalCtx);
    assert.equal(normal.kind, "success");
    assert.notEqual(normal.artifacts["reason"], DEV_REASON_SKIPPED_AFTER_FIX);
    assert.equal(calls, 1, "正常路径应调用一次执行器");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B5b. 集成：fix 成功后同卡下一轮 dev 被跳过（dev 执行器仅轮 0 调用一次）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const devCalls: number[] = [];
    const fixCalls: number[] = [];
    const base = createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] });
    const spy: P5TaskExecutor = {
      executeTask: async (input) => {
        if (input.stage === "dev") devCalls.push(input.iterIndex);
        if (input.stage === "fix") fixCalls.push(input.iterIndex);
        return base.executeTask(input);
      },
    };
    const orchestrator = buildOrchestrator({ taskExecutor: spy });
    await orchestrator.run({
      projectRoot,
      objective: "验证 fix 后 dev 不整卡重跑",
      maxIterations: 3,
      consecutiveFailureAbort: 5,
      testCommand: TWO_BASELINE_FAILURES_CMD,
      testTimeoutSec: 15,
    });

    assert.ok(fixCalls.length >= 1, "fix 至少执行了一次（产生 fixApplied 标记）");
    assert.equal(
      devCalls.length,
      1,
      `fix 成功后同卡下一轮 dev 应被跳过，实际 dev 调用 ${devCalls.length} 次（iterIndex=${devCalls.join(",")}）`
    );
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B7. 失败用例标识透传到 result.runResult 顶层 failedTestIds（触发层逃生门精确契约）
// ============================================================================

test("B7a. 带 2 个失败用例的 run → result.runResult.failedTestIds 顶层含这两个 ID（命令层真实链路）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const orchestrator = buildOrchestrator({
      taskExecutor: createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
    });
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const cmdResult = await handler.execute(buildCommandRequest(TWO_BASELINE_FAILURES_CMD), projectRoot);

    assert.equal(cmdResult.success, true, "命令层执行应成功");
    assert.ok(cmdResult.runResult, "EagAutonomousCommandResult 应携带 runResult");
    // 精确复刻 session.ts extractAutonomousRunDetails 的读取方式：runResult 顶层 failedTestIds
    const carried: unknown = (cmdResult.runResult as unknown as { readonly failedTestIds?: unknown }).failedTestIds;
    assert.ok(Array.isArray(carried), "runResult 顶层 failedTestIds 必须是数组（非嵌套/非改名）");
    assert.deepEqual(carried, ["基线A", "基线B"], "应含本次 run 的两个失败用例，且跨 2 轮去重保序");
    assert.equal((carried as ReadonlyArray<string>).length, 2, "重复轮次不应重复累计（去重生效）");
    // 值必须全为字符串（session 层会 filter 非字符串）
    assert.ok((carried as ReadonlyArray<unknown>).every((v) => typeof v === "string" && v.length > 0));
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

test("B7b. 无失败的 run → failedTestIds 为 undefined（诚实留空，绝不编造用例名）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    // 1 张 pending 卡 + 通过的测试命令：verify 真实执行且通过，任务被标记 completed
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const orchestrator = buildOrchestrator({
      taskExecutor: createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
    });
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const cmdResult = await handler.execute(buildCommandRequest(PASS_TEST_CMD), projectRoot);

    assert.equal(cmdResult.success, true);
    assert.ok(cmdResult.runResult);
    const carried: unknown = (cmdResult.runResult as unknown as { readonly failedTestIds?: unknown }).failedTestIds;
    assert.equal(carried, undefined, "verify 全通过时 failedTestIds 应为 undefined（不编造）");
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// B8. 直接断言 orchestrator.run() 返回对象（即 AutonomousRunResult / cmdResult.runResult
//     所指的同一对象）顶层 failedTestIds——非 cast、非 artifacts、非嵌套，最直接的契约验证
// ============================================================================

test("B8a. run() 返回对象顶层 failedTestIds 直接含 2 个失败用例 ID（复用 B3 装配）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const orchestrator = buildOrchestrator({
      taskExecutor: createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
    });
    const runResult = await orchestrator.run({
      projectRoot,
      objective: "验证 run() 返回对象顶层 failedTestIds",
      maxIterations: 2,
      consecutiveFailureAbort: 5,
      testCommand: TWO_BASELINE_FAILURES_CMD,
      testTimeoutSec: 15,
    });

    // 直接属性访问：顶层、同名、数组（不用 cast、不读 artifacts、不读嵌套对象）
    const ids = runResult.failedTestIds;
    assert.ok(Array.isArray(ids), "run() 返回对象顶层 failedTestIds 必须是数组");
    assert.deepEqual(ids, ["基线A", "基线B"], "应含本次 run 的 2 个失败用例，且跨轮去重保序");
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

test("B8b. 无失败的 run() 返回对象顶层 failedTestIds 为 undefined（复用 B3 装配）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const orchestrator = buildOrchestrator({
      taskExecutor: createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
    });
    const runResult = await orchestrator.run({
      projectRoot,
      objective: "验证无失败时 failedTestIds 为 undefined",
      maxIterations: 2,
      consecutiveFailureAbort: 5,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 15,
    });

    assert.equal(runResult.failedTestIds, undefined, "verify 全通过时顶层 failedTestIds 应为 undefined（不编造）");
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});
