/**
 * EAG-P5 基线红灯拆分 → 修复指令链路 回归测试（2026-11-08 生产修复）
 *
 * 背景：892938aa 已把 verify 失败正确拆成 baselineMatched / newFailed，并写出
 * newFailedTestIds / baselineFailedTestIds / baselineAvailable / baselineOnly，但下游
 * 消费方仍把「含基线红灯的全量失败清单」回灌给 dev/fix 执行器：
 * - autonomous-orchestrator.buildVerifyFailureFeedback() 读全量 failedTestIds；
 * - fix-stage-handler 从 outputSummary（原始输出尾部）重新 extractFailedTestIds()。
 * 结果：基线红灯（与本任务无关）被当成"请优先定位并复跑这些用例"反复喂给模型。
 *
 * 本测试覆盖修复后的两条修复指令链路：
 * U 组（单元，直接驱动 P5FixStageHandler）：
 *   - baselineOnly → fix feedback 改为"无需改代码"标注，用例清单为空、不含基线用例名；
 *   - 可拆分（有新增失败）→ 用例清单只含新增失败，标注"与本任务相关的新增失败"；
 *   - 诚实降级（baselineAvailable=false / 未提取到用例标识）→ 回退全量，不丢任何失败。
 * I 组（集成，真实 orchestrator.run + 真实 4 handlers）：
 *   - 2 个基线红灯 + 本任务无新增失败 → fix feedback 与下一轮 dev feedback 均不含基线用例名；
 *   - EAG_BASELINE_GUARD=0（基线探测降级）→ dev feedback 仍含全部失败用例（不丢信息）。
 *
 * 约定（NFR-9 禁止伪造通过）：node:test + node:assert/strict，测试命令真实 spawn，
 * orchestrator 用真实 handlers + 真实 guardChain，仅用替身替代 LLM 网络往返；
 * 绝不把 verify 真失败说成通过。
 *
 * @module core/tests/eag-p5-baseline-feedback-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { P5FixStageHandler } from "../eag/p5/handlers/fix-stage-handler";
import { loadPreviousRunContext } from "../eag/p5/handlers/plan-stage-handler";
import { EnvBoundaryGuard } from "../eag/p5/guards/env-boundary-guard";
import type { GuardContext } from "../eag/p5/guards/types";
import { createSuccessStageResult, createFailedStageResult } from "../eag/p5/handlers/types";
import type {
  P5TaskExecutor,
  P5TaskExecutionInput,
  P5TaskExecutionResult,
} from "../eag/p5/handlers/task-executor-port";

import {
  buildStageContext,
  buildOrchestrator,
  createAlwaysSucceedTaskExecutor,
  createTestTaskCard,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// 1. 测试命令与夹具
// ============================================================================

/**
 * 2 个"run 起始既有"失败用例（Jest ✕ 风格），0 passed / 2 failed、退出码 1。
 * orchestrator 用同一命令做基线探测与每轮 verify → 探测出 {基线A, 基线B} 且
 * 每轮 verify 失败集与之完全一致 → baselineOnly=true、newFailedTestIds=[]。
 */
const TWO_BASELINE_FAILURES_CMD =
  `node -e 'for(const a of process.argv.slice(1))console.log(a);console.log("Tests: 0 passed, 2 failed");process.exit(1)'` +
  ` "  ✕ 基线A" "  ✕ 基线B"`;

/** 环境变量辅助：确保基线守卫开启（返回恢复函数）。 */
function withGuardOn(): () => void {
  const prev = process.env.EAG_BASELINE_GUARD;
  delete process.env.EAG_BASELINE_GUARD;
  return () => {
    if (prev === undefined) delete process.env.EAG_BASELINE_GUARD;
    else process.env.EAG_BASELINE_GUARD = prev;
  };
}

/** 环境变量辅助：临时设置守卫值（返回恢复函数）。 */
function withGuardValue(value: string): () => void {
  const prev = process.env.EAG_BASELINE_GUARD;
  process.env.EAG_BASELINE_GUARD = value;
  return () => {
    if (prev === undefined) delete process.env.EAG_BASELINE_GUARD;
    else process.env.EAG_BASELINE_GUARD = prev;
  };
}

/** 记录每次 executeTask 的 (stage, iterIndex, feedback) 的执行器替身。 */
interface CapturedCall {
  readonly stage: "dev" | "fix";
  readonly iterIndex: number;
  readonly feedback?: string;
}

function createRecordingExecutor(
  captured: CapturedCall[],
  options: { readonly fixFails?: boolean } = {}
): P5TaskExecutor {
  const devBase = createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] });
  const fixBase = createAlwaysSucceedTaskExecutor({
    success: options.fixFails === true ? false : true,
    error: options.fixFails === true ? "[test] 故意让 fix 失败以驱动下一轮 dev 真实运行" : undefined,
  });
  return Object.freeze({
    async executeTask(input: P5TaskExecutionInput): Promise<Readonly<P5TaskExecutionResult>> {
      captured.push({ stage: input.stage, iterIndex: input.iterIndex, feedback: input.feedback });
      return input.stage === "fix" ? fixBase.executeTask(input) : devBase.executeTask(input);
    },
  });
}

/** 构造带任务卡的 plan 成功结果（fix handler 需要任务卡才会走到执行器）。 */
function makePlanResult(): Readonly<ReturnType<typeof createSuccessStageResult>> {
  return createSuccessStageResult("plan", "选取任务卡", { taskCard: createTestTaskCard() });
}

/** 构造 verify 失败结果（artifacts 即 verify handler 真实产出的拆分制品）。 */
function makeVerifyFailure(
  artifacts: Readonly<Record<string, unknown>>
): Readonly<ReturnType<typeof createFailedStageResult>> {
  return createFailedStageResult("verify", "failed", "测试失败", "测试失败：exitCode=1", artifacts);
}

// ============================================================================
// 2. U 组：fix-stage-handler 修复指令链路（单元）
// ============================================================================

/** baselineOnly 制品（2 个基线红灯、本任务 0 新增）。 */
function baselineOnlyArtifacts(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    testStats: { passed: 0, failed: 2, skipped: 0, total: 2 },
    failedTestIds: Object.freeze(["基线A", "基线B"]),
    failedTestTotal: 2,
    newFailedTestIds: Object.freeze([]),
    baselineFailedTestIds: Object.freeze(["基线A", "基线B"]),
    baselineAvailable: true,
    baselineOnly: true,
    testOutputTail: "  ✕ 基线A\n  ✕ 基线B\nTests: 0 passed, 2 failed",
    completionEvidence: { testExitCode: 1, testOutputSummary: "  ✕ 基线A\n  ✕ 基线B" },
    commandResult: { exitCode: 1, timedOut: false },
  });
}

test("U1. baselineOnly（ctx 投影路径）→ fix feedback 改为『无需改代码』标注、用例清单为空、不含基线用例名", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const captured: CapturedCall[] = [];
    const planResult = makePlanResult();
    const verifyResult = makeVerifyFailure(baselineOnlyArtifacts());
    const ctx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([planResult, verifyResult]),
      taskExecutor: createRecordingExecutor(captured),
      // 真实 orchestrator 在 fix 阶段投影的本轮 verify 拆分结果
      verifyFailedTestIds: ["基线A", "基线B"],
      verifyNewFailedTestIds: [],
      verifyBaselineAvailable: true,
      verifyBaselineOnly: true,
    });

    const result = await new P5FixStageHandler().handle(ctx);
    assert.equal(result.kind, "success", "fix 仍照常调用执行器（不破坏 P2 状态机）");
    assert.equal(captured.length, 1, "执行器应被调用一次");

    const feedback = captured[0]!.feedback ?? "";
    assert.ok(feedback.includes("无需据此修改代码"), "反馈应显式说明无需修改代码");
    assert.ok(feedback.includes("run 起始既有红灯"), "反馈应说明失败与本任务无关");
    assert.ok(!feedback.includes("基线A"), "fix feedback 不得出现基线用例『基线A』");
    assert.ok(!feedback.includes("基线B"), "fix feedback 不得出现基线用例『基线B』");
    assert.ok(!feedback.includes("请优先定位并复跑"), "纯基线失败不得再让模型去复跑用例");

    const suggestion = result.artifacts["fixSuggestion"] as {
      readonly failedTestIds: ReadonlyArray<string>;
      readonly baselineOnly?: boolean;
      readonly failedIdsSplitApplied?: boolean;
    };
    assert.deepEqual(suggestion.failedTestIds, [], "用例清单应为空（无本任务新增失败）");
    assert.equal(suggestion.baselineOnly, true);
    assert.equal(suggestion.failedIdsSplitApplied, true);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("U2. baselineOnly（artifacts 回退路径）→ 无 ctx 投影时同样改为标注、不含基线用例名", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const captured: CapturedCall[] = [];
    const ctx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([makePlanResult(), makeVerifyFailure(baselineOnlyArtifacts())]),
      taskExecutor: createRecordingExecutor(captured),
      // 不注入任何 verify* 投影字段：fix handler 必须回退到 verifyResult.artifacts
    });

    const result = await new P5FixStageHandler().handle(ctx);
    assert.equal(result.kind, "success");
    const feedback = captured[0]?.feedback ?? "";
    assert.ok(feedback.includes("无需据此修改代码"), "回退路径也应给出标注");
    assert.ok(!feedback.includes("基线A") && !feedback.includes("基线B"), "回退路径也不得含基线用例名");
    const suggestion = result.artifacts["fixSuggestion"] as { readonly failedTestIds: ReadonlyArray<string> };
    assert.deepEqual(suggestion.failedTestIds, []);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("U3. 可拆分（2 基线 + 1 新增）→ 用例清单只含新增失败、标注『与本任务相关的新增失败』", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const captured: CapturedCall[] = [];
    const verifyArtifacts = Object.freeze({
      testStats: { passed: 0, failed: 3, skipped: 0, total: 3 },
      failedTestIds: Object.freeze(["基线A", "基线B", "新增C"]),
      failedTestTotal: 3,
      newFailedTestIds: Object.freeze(["新增C"]),
      baselineFailedTestIds: Object.freeze(["基线A", "基线B"]),
      baselineAvailable: true,
      baselineOnly: false,
      testOutputTail: "  ✕ 基线A\n  ✕ 基线B\n  ✕ 新增C\nTests: 0 passed, 3 failed",
      completionEvidence: { testExitCode: 1, testOutputSummary: "  ✕ 新增C" },
      commandResult: { exitCode: 1, timedOut: false },
    });
    const ctx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([makePlanResult(), makeVerifyFailure(verifyArtifacts)]),
      taskExecutor: createRecordingExecutor(captured),
      verifyFailedTestIds: ["基线A", "基线B", "新增C"],
      verifyNewFailedTestIds: ["新增C"],
      verifyBaselineAvailable: true,
      verifyBaselineOnly: false,
    });

    const result = await new P5FixStageHandler().handle(ctx);
    assert.equal(result.kind, "success");
    const feedback = captured[0]?.feedback ?? "";
    assert.ok(feedback.includes("以下为与本任务相关的新增失败"), "应显式标注清单只含新增失败");
    assert.ok(feedback.includes("新增C"), "新增失败用例必须出现在修复指令中");

    const suggestion = result.artifacts["fixSuggestion"] as {
      readonly failedTestIds: ReadonlyArray<string>;
      readonly baselineOnly?: boolean;
      readonly failedIdsSplitApplied?: boolean;
    };
    assert.deepEqual(suggestion.failedTestIds, ["新增C"], "用例清单只含新增失败（已排除基线）");
    assert.equal(suggestion.baselineOnly, false);
    assert.equal(suggestion.failedIdsSplitApplied, true);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("U4. 诚实降级（baselineAvailable=false）→ 回退全量清单、反馈含全部失败用例、不丢信息", async () => {
  const projectRoot = createTempProject();
  try {
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    // 基线探测降级：newFailedTestIds 为空（陷阱——若天真替换成它会变成"失败但无用例"），
    // 必须回退全量 failedTestIds，一个都不能排除。
    const degradedArtifacts = Object.freeze({
      testStats: { passed: 0, failed: 3, skipped: 0, total: 3 },
      failedTestIds: Object.freeze(["用例甲", "用例乙", "用例丙"]),
      failedTestTotal: 3,
      newFailedTestIds: Object.freeze([]),
      baselineFailedTestIds: Object.freeze([]),
      baselineAvailable: false,
      baselineOnly: false,
      testOutputTail: "  ✕ 用例甲\n  ✕ 用例乙\n  ✕ 用例丙\nTests: 0 passed, 3 failed",
      completionEvidence: { testExitCode: 1, testOutputSummary: "  ✕ 用例丙" },
      commandResult: { exitCode: 1, timedOut: false },
    });

    // 变体 a：ctx 投影 baselineAvailable=false（orchestrator 真实降级路径）
    // 变体 b：不投影，仅靠 artifacts（fixtures 直接构造 handler 路径）
    for (const viaCtxProjection of [true, false]) {
      const captured: CapturedCall[] = [];
      const ctx = buildStageContext(projectRoot, "fix", {
        prevResults: Object.freeze([makePlanResult(), makeVerifyFailure(degradedArtifacts)]),
        taskExecutor: createRecordingExecutor(captured),
        ...(viaCtxProjection
          ? {
              verifyFailedTestIds: ["用例甲", "用例乙", "用例丙"],
              verifyNewFailedTestIds: [],
              verifyBaselineAvailable: false,
              verifyBaselineOnly: false,
            }
          : {}),
      });

      const result = await new P5FixStageHandler().handle(ctx);
      assert.equal(result.kind, "success", `viaCtxProjection=${viaCtxProjection} 应照常执行`);
      const feedback = captured[0]?.feedback ?? "";
      for (const id of ["用例甲", "用例乙", "用例丙"]) {
        assert.ok(feedback.includes(id), `降级时反馈不得丢失败用例『${id}』`);
      }
      assert.ok(feedback.includes("失败用例（请优先定位并复跑这些用例"), "降级保留标准『请复跑』修复指令");
      assert.ok(!feedback.includes("无需据此修改代码"), "降级不得谎称『无需改代码』");

      const suggestion = result.artifacts["fixSuggestion"] as {
        readonly failedTestIds: ReadonlyArray<string>;
        readonly failedIdsSplitApplied?: boolean;
        readonly baselineOnly?: boolean;
      };
      assert.deepEqual(suggestion.failedTestIds, ["用例甲", "用例乙", "用例丙"], "降级回退全量清单");
      assert.equal(suggestion.failedIdsSplitApplied, false);
      assert.equal(suggestion.baselineOnly, false);
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// 3. I 组：真实 orchestrator.run 修复指令链路（集成）
// ============================================================================

test("I1. 2 基线红灯 + 本任务无新增失败 → fix/dev feedback 均不含基线用例名", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardOn();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const captured: CapturedCall[] = [];
    // fix 故意失败 → 不产生 fixApplied → 下一轮 dev 不被 P2 状态机跳过，
    // 从而能真实捕获"下一轮 dev feedback"（carriedFailureFeedback 的消费端）。
    const orchestrator = buildOrchestrator({ taskExecutor: createRecordingExecutor(captured, { fixFails: true }) });

    await orchestrator.run({
      projectRoot,
      objective: "验证基线红灯不进入修复指令链路",
      maxIterations: 2,
      consecutiveFailureAbort: 5,
      testCommand: TWO_BASELINE_FAILURES_CMD,
      testTimeoutSec: 15,
    });

    const fixFeedbacks = captured.filter((c) => c.stage === "fix");
    assert.ok(fixFeedbacks.length >= 1, "应至少捕获一次 fix feedback");
    const iter1Dev = captured.find((c) => c.stage === "dev" && c.iterIndex === 1);
    assert.ok(iter1Dev !== undefined, "第 1 轮 dev 应真实运行（fix 失败未被跳过）");
    assert.ok(
      typeof iter1Dev!.feedback === "string" && iter1Dev!.feedback.length > 0,
      "第 1 轮 dev 应收到上一轮 verify 的失败反馈（carriedFailureFeedback 链路贯通）"
    );

    // 核心回归：所有修复指令（fix + 下一轮 dev）都不得含基线用例名
    for (const call of captured) {
      const feedback = call.feedback ?? "";
      assert.ok(
        !feedback.includes("基线A") && !feedback.includes("基线B"),
        `stage=${call.stage} iter=${call.iterIndex} 的 feedback 含基线用例名（不应让模型去修基线红灯）：${feedback.slice(0, 200)}`
      );
    }
    // dev feedback 应为显式标注，而非"请在现有改动基础上继续修 + 用例清单"
    assert.ok(iter1Dev!.feedback!.includes("无需据此修改代码"), "dev feedback 应显式标注与本任务无关、无需改代码");
    assert.ok(!iter1Dev!.feedback!.includes("请在现有改动基础上继续修"), "dev feedback 不得再要求『继续修』");
    // fix feedback 同样不得带"请优先定位并复跑"指令
    for (const call of fixFeedbacks) {
      assert.ok(!(call.feedback ?? "").includes("请优先定位并复跑"), "纯基线轮 fix feedback 不得要求复跑用例");
    }
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

test("I2. EAG_BASELINE_GUARD=0（基线探测降级）→ dev feedback 仍含全部失败用例（诚实降级不丢信息）", async () => {
  const projectRoot = createTempProject();
  const restore = withGuardValue("0");
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const captured: CapturedCall[] = [];
    const orchestrator = buildOrchestrator({ taskExecutor: createRecordingExecutor(captured, { fixFails: true }) });

    await orchestrator.run({
      projectRoot,
      objective: "验证基线探测降级时不丢失败信息",
      maxIterations: 2,
      consecutiveFailureAbort: 5,
      testCommand: TWO_BASELINE_FAILURES_CMD,
      testTimeoutSec: 15,
    });

    const iter1Dev = captured.find((c) => c.stage === "dev" && c.iterIndex === 1);
    assert.ok(iter1Dev !== undefined, "第 1 轮 dev 应真实运行");
    const feedback = iter1Dev!.feedback ?? "";
    // 降级：不排除任何失败，全量用例必须出现在 dev feedback 中
    assert.ok(feedback.includes("基线A"), "降级时 dev feedback 不得丢『基线A』");
    assert.ok(feedback.includes("基线B"), "降级时 dev feedback 不得丢『基线B』");
    assert.ok(feedback.includes("请在现有改动基础上继续修"), "降级时保留标准『继续修』修复指令");
    assert.ok(!feedback.includes("无需据此修改代码"), "降级时不得谎称『无需改代码』");
  } finally {
    restore();
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// 4. P2 组：head-only 截断修复（plan 跨 run 记忆 / env 凭据扫描）
// ============================================================================

test("P2-1. 超长跨 run 记忆 → 头部 + 尾部保留（不丢终止原因开头与尾部固定建议）", () => {
  const projectRoot = createTempProject();
  try {
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    fs.mkdirSync(runStateDir, { recursive: true });
    const longAbortReason = "确定性失败熔断：同一任务卡反复失败 " + "X".repeat(2000);
    fs.writeFileSync(
      path.join(runStateDir, "prevrun-long.jsonl"),
      JSON.stringify({
        runId: "prevrun-long",
        status: "aborted",
        currentStage: "verify",
        totalTokensUsed: 1000,
        totalLlmCallCount: 3,
        consecutiveFailures: 3,
        abortReason: longAbortReason,
        updatedAt: "2026-11-08T00:00:00.000Z",
      }) + "\n",
      "utf8"
    );

    const text = loadPreviousRunContext(projectRoot, "cur-run-0001");
    assert.ok(text.length > 0, "应读到上一条终态记忆");
    assert.ok(text.length < longAbortReason.length, "超长记忆应被截断（不无限灌进提示词）");
    assert.ok(text.includes("确定性失败熔断"), "头部应保留终止原因开头");
    assert.ok(text.includes("请勿机械重跑"), "尾部应保留固定建议（head-only 会丢）");
    assert.ok(text.includes("换思路分解任务"), "尾部应保留固定建议后半段（head-only 会丢）");
    assert.ok(text.includes("中段省略"), "应显式标注中段被省略，避免拼接被当成原文");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P2-2. 超长环境变量值尾部凭据不得逃过 G-A1c（首 N + 尾 N 双窗口）", () => {
  const guard = new EnvBoundaryGuard();
  // 前 8192 字符全是安全填充，AWS Key 藏在尾部：旧 head-only 扫描会漏检 → PASS。
  const filler = "x".repeat(9000);
  const tailCredential = "AKIAIOSFODNN7EXAMPLE";
  const ctx: GuardContext = {
    runId: "test-run-001",
    iterIndex: 1,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    confirmationCardAccepted: true,
    emergencyStopRequested: false,
    loopGuardConfig: Object.freeze({ maxIterations: 50, maxTokens: 200_000, maxConsecutiveFailures: 3 }),
    envSnapshot: { LONG_CERT_CHAIN: `${filler}${tailCredential}` },
  };

  const verdict = guard.check(ctx);
  assert.equal(verdict.decision, "DENY", "尾部凭据必须被检出，不得因 head-only 扫描漏掉");
  assert.equal(verdict.ruleId, "G-A1c");
});
