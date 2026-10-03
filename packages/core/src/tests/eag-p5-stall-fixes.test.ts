/**
 * EAG-P5 卡死事故修复回归单测（2026-10-03 事故复盘：eag run 假死表象四项修复）
 *
 * 覆盖四项修复（对应事故分析报告修复建议 #3/#4/#5/#6）：
 * - G1-G6 能力预检（修复#3）：detectShellCapabilityGap 纯函数命中/不误伤 +
 *   plan 阶段对"远程装 K3s CUDA 部署 MySQL"类目标在合成任务卡之前 fatal 拒绝；
 * - V1 verify 空测试降级（修复#5）：合成任务 + 默认 npm test 输出 0/0/0 且
 *   exitCode=1 → 记 unverified/skipped 而非 failed；手写任务卡必须如实 failed；
 * - O1/O2 onIteration 进度回写（修复#4）：每轮迭代摘要回调触发 + 回调抛错
 *   不反噬主循环；
 * - （修复#6 拒绝风暴 fail-fast 见 eag-p5-llm-executor.test.ts E9/E10）
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - 全部使用真实 StageHandler / AutonomousOrchestrator / GuardChain / RunStateStore；
 * - 文件系统与 child_process（verify 阶段 spawnSync）全部真实执行；
 * - 仅 LLM 网络边界用测试替身（createAlwaysSucceedTaskExecutor，设计唯一替换点）。
 *
 * @module core/tests/eag-p5-stall-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  AutonomousOrchestrator,
  createP5LoopExecutorFromHandlers,
  createDefaultBlockerGuardChain,
  detectShellCapabilityGap,
  PLAN_REASON_CAPABILITY_GAP,
  VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET,
  type P5StageContext,
  type P5RunState,
  type AutonomousIterationSummary,
} from "../eag/p5/index";
import { createAlwaysSucceedTaskExecutor } from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// 1. 真实临时项目夹具（与 eag-p5-autonomous-orchestrator.test.ts 同构）
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统，含 .eag/p5 子目录）。
 *
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-p5-stallfix-"));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

/**
 * 清理临时项目目录（递归删除，容错）。
 *
 * @param projectRoot 临时项目根目录
 */
function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
}

/**
 * 构造最小完整 P5RunState（handler 内部读取 runState.maxIterations 等字段）。
 *
 * @param projectRoot 项目根目录
 * @returns 冻结的 P5RunState
 */
function buildRunState(projectRoot: string): P5RunState {
  const now = new Date().toISOString();
  return Object.freeze({
    runId: "stallfix-run-001",
    projectRoot,
    objective: "测试目标",
    startedAt: now,
    updatedAt: now,
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
  }) as P5RunState;
}

/**
 * 构造 plan 阶段用 P5StageContext（objective 合成路径的最小完整上下文）。
 *
 * @param projectRoot 项目根目录
 * @param objective 自主目标文本
 * @returns 冻结的 P5StageContext
 */
function buildPlanContext(projectRoot: string, objective: string): P5StageContext {
  return Object.freeze({
    runId: "stallfix-run-001",
    iterIndex: 0,
    stage: "plan",
    projectRoot,
    worktreePath: projectRoot,
    objective,
    currentPlan: "",
    notesSnapshot: "",
    prevResults: Object.freeze([]),
    runState: buildRunState(projectRoot),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
    tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
    testCommand: "npm test",
    testTimeoutSec: 30,
    loopType: "coding" as const,
  }) as unknown as P5StageContext;
}

// ============================================================================
// G. 修复#3：能力预检 detectShellCapabilityGap + plan 阶段拒绝
// ============================================================================

test("G1. 能力预检：远程部署类目标（K3s/CUDA/镜像/装）命中多类 shell 能力缺口", () => {
  // 与真实事故目标同语义："远程装 K3s CUDA、部署 MySQL/Redis、拉镜像、初始化数据"
  const result = detectShellCapabilityGap(["远程装 K3s CUDA、部署 MySQL/Redis、拉镜像、初始化数据"]);
  assert.equal(result.requiresShell, true, "远程部署目标必须命中能力缺口");
  // 至少命中：远程执行 / 软件安装 / 容器编排 / 数据库变更 四类
  assert.ok(
    result.capabilities.some((c) => c.includes("远程执行")),
    `应命中远程执行类别，实际：${result.capabilities.join("、")}`
  );
  assert.ok(
    result.capabilities.some((c) => c.includes("容器")),
    `应命中容器/编排类别，实际：${result.capabilities.join("、")}`
  );
  assert.ok(
    result.capabilities.some((c) => c.includes("安装")),
    `应命中软件/包安装类别，实际：${result.capabilities.join("、")}`
  );
  // 类别去重：同一类别不得重复出现
  assert.equal(new Set(result.capabilities).size, result.capabilities.length, "命中类别必须去重");
});

test("G2. 能力预检：纯代码/文档目标不误伤（不命中任何缺口）", () => {
  const result = detectShellCapabilityGap([
    "为 refund() 方法补充单元测试并修复边界条件 bug",
    "阅读 src/utils/date.ts 并把日期格式化统一为 ISO 8601",
  ]);
  assert.equal(result.requiresShell, false, "纯编码目标不得触发能力预检");
  assert.equal(result.capabilities.length, 0);
});

test("G3. 能力预检：空文本/空数组健壮（不抛错、不命中）", () => {
  assert.equal(detectShellCapabilityGap([]).requiresShell, false);
  assert.equal(detectShellCapabilityGap(["", "  "]).requiresShell, false);
});

test("G4. plan 阶段：objective 合成路径命中能力缺口 → fatal 拒绝且不落盘 tasks.md", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5PlanStageHandler();
    const ctx = buildPlanContext(projectRoot, "ssh 登录生产服务器安装 docker 并部署 mysql");

    const result = await handler.handle(ctx);

    // 必须 fatal（failed/fatal 语义），绝不合成放行
    assert.equal(result.kind, "fatal", `能力缺口目标必须 fatal 拒绝，实际 kind=${result.kind}`);
    assert.match(result.summary, /超出 P5 执行器能力/);
    assert.equal(result.artifacts["reason"], PLAN_REASON_CAPABILITY_GAP);
    // detail 必须给出可执行建议（主会话执行 / 改写为纯代码产出）
    assert.match(result.error ?? "", /主会话/);
    // 关键：tasks.md 绝不落盘——合成前的预检必须早于任何写盘
    assert.ok(
      !fs.existsSync(path.join(projectRoot, ".eag", "p5", "tasks.md")),
      "能力预检拒绝后不得合成并落盘 tasks.md"
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("G5. plan 阶段：纯编码 objective 正常合成单卡任务（预检不误伤既有链路）", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5PlanStageHandler();
    const ctx = buildPlanContext(projectRoot, "创建一个导出 add(a,b) 函数的 src/math.js 模块");

    const result = await handler.handle(ctx);

    assert.equal(result.kind, "success", `纯编码目标应正常合成任务卡，实际：${result.summary}`);
    assert.ok(result.artifacts["taskCard"], "应产出选中的任务卡");
    assert.ok(fs.existsSync(path.join(projectRoot, ".eag", "p5", "tasks.md")), "合成任务清单必须真实落盘");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("G6. plan 阶段：手写 tasks.md 存在时不触发能力预检（范围锁语义不变）", async () => {
  const projectRoot = createTempProject();
  try {
    // 手写清单含"部署"字样任务卡标题——预检只守 objective 合成入口，
    // 手写清单是用户显式意志，范围由 G-A1a 文件牢笼约束，不受本预检限制
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 生成部署清单 deploy/manifest.yaml",
        "- requirement: F-001",
        "- status: pending",
        "- dependencies:",
        "- files: deploy/manifest.yaml",
        "- deletions:",
        "- symbols:",
        "- acceptance: 清单文件可被 YAML 解析",
        "",
      ].join("\n"),
      "utf8"
    );

    const handler = new P5PlanStageHandler();
    const ctx = buildPlanContext(projectRoot, "生成部署清单文件");
    const result = await handler.handle(ctx);

    assert.equal(result.kind, "success", "手写任务卡路径不得被能力预检拦截");
    assert.ok(result.artifacts["taskCard"]);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// V. 修复#5：verify 空测试（0 passed/0 failed + exitCode=1）降级 unverified
// ============================================================================

/**
 * 构造 verify 阶段上下文（合成任务标记 + 真实可执行 testCommand）。
 *
 * @param projectRoot 项目根目录
 * @param overrides 覆盖字段
 * @returns 冻结的 P5StageContext
 */
function buildVerifyContext(projectRoot: string, overrides: Record<string, unknown> = {}): P5StageContext {
  return Object.freeze({
    runId: "stallfix-verify-001",
    iterIndex: 0,
    stage: "verify",
    projectRoot,
    worktreePath: projectRoot,
    objective: "测试目标",
    currentPlan: "",
    notesSnapshot: "",
    prevResults: Object.freeze([]),
    runState: buildRunState(projectRoot),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
    tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
    testCommand: "npm test",
    testTimeoutSec: 60,
    loopType: "coding" as const,
    ...overrides,
  }) as unknown as P5StageContext;
}

test("V1. verify：合成任务 + npm test 无测试计数输出（exitCode=1）→ unverified 降级而非 failed", async () => {
  const projectRoot = createTempProject();
  try {
    // 真实复现事故场景：package.json 无 scripts.test → npm test 以 exitCode=1
    // 失败但输出不含任何测试计数（0 passed/0 failed/0 skipped）
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "stallfix-bio", version: "1.0.0" }, null, 2),
      "utf8"
    );

    const handler = new P5VerifyStageHandler();
    // synthesizedTask=true：plan 阶段由 objective 合成的任务卡（无测试目标是预期状态）
    const ctx = buildVerifyContext(projectRoot, { synthesizedTask: true });

    const result = await handler.handle(ctx);

    // 修复语义：诚实降级为 success + skipped/unverified，不得累加 consecutiveFailures
    assert.equal(result.kind, "success", `空测试输出应降级 unverified，实际：${result.summary}`);
    assert.equal(result.artifacts["skipped"], true);
    assert.equal(result.artifacts["unverified"], true);
    assert.equal(result.artifacts["reason"], VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("V2. verify：手写任务卡 + 无测试输出（exitCode=1）必须如实 failed（V4 契约不放宽）", async () => {
  const projectRoot = createTempProject();
  try {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "stallfix-handwritten", version: "1.0.0" }, null, 2),
      "utf8"
    );

    const handler = new P5VerifyStageHandler();
    // 无 synthesizedTask 标记：用户手写任务卡承诺了可验证产出，
    // "没有测试可跑"是交付缺口而非环境事实，必须如实 failed 交 fix 阶段
    const ctx = buildVerifyContext(projectRoot, {});

    const result = await handler.handle(ctx);

    assert.equal(result.kind, "failed", `手写任务不得因空测试输出降级成功，实际：${result.kind}`);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("V3. verify：合成任务 + 显式自定义 testCommand 空输出仍如实 failed（降级只限默认 npm test）", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    // 用户显式指定测试命令（非默认 npm test）：命令失败但没有测试计数
    // 说明命令本身配置错误，属真实验证失败，不得静默降级
    const ctx = buildVerifyContext(projectRoot, {
      synthesizedTask: true,
      testCommand: `node -e 'process.exit(1)'`,
    });

    const result = await handler.handle(ctx);

    assert.equal(result.kind, "failed", `自定义测试命令失败必须如实 failed，实际：${result.kind}`);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// O. 修复#4：AutonomousOrchestrator onIteration 进度回写回调
// ============================================================================

/**
 * 构造完整真实装配的 AutonomousOrchestrator（4 handler + 5 核心依赖）。
 *
 * @returns AutonomousOrchestrator 实例
 */
function buildFullOrchestrator(): AutonomousOrchestrator {
  const loopExecutor = createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    new P5DevStageHandler(),
    new P5VerifyStageHandler(),
    new P5FixStageHandler()
  );
  return new AutonomousOrchestrator({
    loopExecutor,
    runStateStore: new P5RunStateStore(),
    notesMemory: new P5NotesMemory(),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
  });
}

test("O1. onIteration：每轮迭代结束后收到 4 阶段摘要（abort 前每一轮都有回写点）", async () => {
  const projectRoot = createTempProject();
  try {
    // 1 张 pending 卡 + FAIL 测试命令 → 每轮 dev 成功、verify 失败 → 轮次摘要应逐轮回写
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 实现 add 函数",
        "- requirement: F-001",
        "- status: pending",
        "- dependencies:",
        "- files: src/add.js",
        "- deletions:",
        "- symbols: add",
        "- acceptance: 单测通过",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "add.js"), "module.exports = (a,b)=>a+b;\n", "utf8");

    const orchestrator = buildFullOrchestrator();
    orchestrator.bindTaskExecutor(createAlwaysSucceedTaskExecutor({ changedFiles: ["src/add.js"] }));

    /** 回调收到的迭代摘要序列（真实观测，非断言替身） */
    const summaries: AutonomousIterationSummary[] = [];

    const result = await orchestrator.run({
      projectRoot,
      objective: "验证进度回写回调",
      maxIterations: 2,
      consecutiveFailureAbort: 10,
      // 真实失败命令：输出 Jest 格式 0 passed 1 failed → verify 如实 failed（非空输出降级路径）
      testCommand: `node -e 'console.log("Tests: 0 passed, 1 failed"); process.exit(1)'`,
      testTimeoutSec: 30,
      onIteration: (summary) => {
        summaries.push(summary);
      },
    });

    // 2 轮迭代全部用尽 → 回调必须收到 2 条摘要（修复前运行期零观测点）
    assert.equal(result.finalStatus, "failed");
    assert.equal(summaries.length, 2, `每轮迭代应各触发一次 onIteration，实际 ${summaries.length} 次`);
    // 摘要结构完整性：runId/iterIndex/stages/连续失败计数
    const first = summaries[0]!;
    assert.equal(typeof first.runId, "string");
    assert.equal(first.iterIndex, 0);
    assert.equal(summaries[1]!.iterIndex, 1);
    assert.ok(
      first.stages.length >= 3,
      `摘要应覆盖 plan/dev/verify 阶段，实际：${first.stages.map((s) => s.stage).join(",")}`
    );
    // verify 失败的轮次：阶段摘要必须带失败标记与非空文本（供主会话醒目展示）
    const verifyStage = first.stages.find((s) => s.stage === "verify");
    assert.ok(verifyStage, "摘要必须包含 verify 阶段");
    assert.equal(verifyStage!.success, false);
    assert.ok(verifyStage!.summary.length > 0, "失败阶段摘要文本不得为空");
    // 连续失败计数随轮次递增（与熔断观测一致）
    assert.ok(summaries[1]!.consecutiveFailures >= summaries[0]!.consecutiveFailures);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("O2. onIteration 回调抛错：被吞掉并记 warn，绝不反噬主循环终止", async () => {
  const projectRoot = createTempProject();
  try {
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 已完成任务",
        "- requirement: F-001",
        "- status: completed",
        "- dependencies:",
        "- files:",
        "- deletions:",
        "- symbols:",
        "- acceptance:",
        "",
      ].join("\n"),
      "utf8"
    );

    const orchestrator = buildFullOrchestrator();
    let callCount = 0;

    // 回调必然抛错：orchestrator 必须吞掉异常，completed 终止不受影响
    const result = await orchestrator.run({
      projectRoot,
      objective: "验证回调异常隔离",
      maxIterations: 2,
      testCommand: `node -e 'console.log("Tests: 1 passed, 0 failed")'`,
      testTimeoutSec: 30,
      onIteration: () => {
        callCount += 1;
        throw new Error("主会话写入失败（模拟 onAssistantMessage 抛错）");
      },
    });

    assert.equal(result.finalStatus, "completed", `回调抛错不得改变 run 终态，实际：${result.finalStatus}`);
    assert.ok(callCount >= 1, "回调必须确实被调用过（否则隔离断言无意义）");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
