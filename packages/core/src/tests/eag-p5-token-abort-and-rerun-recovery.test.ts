/**
 * EAG-P5 修复回归测试：Token 熔断 aborted 轮误判全绿 + 同目标重跑死锁
 * （2026-10-09，事故 run f2358227def5 / 5081a4c28cd7，设计文档
 * docs/dev/eag-p5-token-abort-and-rerun-recovery-fix.md）
 *
 * 覆盖（对应设计文档 §2 修复项）：
 * - F1 token 熔断 break 前补置 iterationFailed：aborted 轮不得 markTaskCompleted、
 *   不得记 milestone、不得登记 completedLoops（T-A1）；
 * - F2 formatIterationSummary 真实判定 allSuccess：含 failed 阶段必须输出
 *   "部分失败"，杜绝"4 阶段全绿（… dev=failed）"自相矛盾文案（T-A2）；
 * - F3 token 熔断路径登记 lastFatalStage：blockageReport.blockedStage 必须是
 *   真实熔断阶段而非兜底 "plan"（T-A1）；
 * - F4 执行器 pre-flight 估算预检（T-A3）+ 响应后检查（T-A4）：
 *   超烧窗口从"跨线单次请求"压到 ≈0；
 * - F5 plan blocked 分支 AUTO 卡同目标重跑恢复（T-A5）+ 手写卡不重置（T-A6）+
 *   运行内防重入（T-A7）+ 落盘失败 fail-closed（T-A8）；
 * - F6 5d blocked 场景根因假设/建议方案真实成因（T-A9）。
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - plan/编排器/执行器全部使用真实 StageHandler / AutonomousOrchestrator /
 *   LlmTaskExecutor / GuardChain；
 * - 文件系统与 tasks.md 落盘全部真实（os.tmpdir 真实目录，逐字节断言；
 *   T-A8 的"落盘失败"用真实只读目录权限触发，非测试替身）；
 * - 仅 LLM 网络边界用测试替身（StubLlmClient，既有测试体系的唯一替换点）。
 *
 * @module core/tests/eag-p5-token-abort-and-rerun-recovery
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  P5PlanStageHandler,
  AutonomousOrchestrator,
  createP5LoopExecutorFromHandlers,
  createDevStageHandler,
  createVerifyStageHandler,
  createFixStageHandler,
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  PLAN_REASON_TASKS_BLOCKED,
  LlmTaskExecutor,
  type P5StageContext,
  type P5RunState,
  type P5TaskExecutor,
  type P5TaskExecutionResult,
} from "../eag/p5/index";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 1. 真实临时项目夹具
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统，含 .eag/p5 子目录）。
 *
 * @param prefix 临时目录前缀
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

/**
 * 递归删除临时目录（容错，不影响断言结论）。
 *
 * @param projectRoot 临时项目根目录
 */
function cleanup(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
}

/**
 * 构造最小完整 P5RunState（handler 内部读取 maxIterations 等字段）。
 *
 * @param projectRoot 项目根目录
 * @param objective 本次运行目标文本
 * @returns 冻结的 P5RunState
 */
function buildRunState(projectRoot: string, objective: string): P5RunState {
  const now = new Date().toISOString();
  return Object.freeze({
    runId: "tokenabort-run-001",
    projectRoot,
    objective,
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
 * 构造 plan 阶段用 P5StageContext（最小完整上下文，可注入 prevResults）。
 *
 * @param projectRoot 项目根目录
 * @param objective 自主目标文本
 * @param prevResults 此前阶段结果（防重入测试注入本运行历史，默认空）
 * @param iterIndex 迭代序号（默认 0）
 * @returns 冻结的 P5StageContext
 */
function buildPlanContext(
  projectRoot: string,
  objective: string,
  prevResults: ReadonlyArray<unknown> = [],
  iterIndex = 0
): P5StageContext {
  return Object.freeze({
    runId: "tokenabort-run-001",
    iterIndex,
    stage: "plan",
    projectRoot,
    worktreePath: projectRoot,
    objective,
    currentPlan: "",
    notesSnapshot: "",
    prevResults: Object.freeze([...prevResults]),
    runState: buildRunState(projectRoot, objective),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
    tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
    testCommand: "npm test",
    testTimeoutSec: 30,
    loopType: "coding" as const,
  }) as unknown as P5StageContext;
}

/**
 * 读取指定卡的 status 行值（找不到该卡或 status 行时返回 null）。
 *
 * @param tasksFilePath tasks.md 绝对路径
 * @param taskId 任务卡 ID（如 "T-001"）
 * @returns status 字符串或 null
 */
function readCardStatus(tasksFilePath: string, taskId: string): string | null {
  const content = fs.readFileSync(tasksFilePath, "utf8");
  const lines = content.split(/\r?\n/);
  let inCard = false;
  for (const line of lines) {
    if (new RegExp(`^##\\s+${taskId}(?=\\s|$)`).test(line)) {
      inCard = true;
      continue;
    }
    if (inCard && /^##\s/.test(line)) {
      break;
    }
    if (inCard) {
      const m = line.match(/^\s*-\s*status:\s*(\S+)\s*$/);
      if (m) {
        return m[1]!;
      }
    }
  }
  return null;
}

/**
 * 构造真实 AutonomousOrchestrator（全部真实 handler / store / guard，无替身）。
 *
 * @param noTestCmd verify 阶段执行的测试命令（默认恒过且诚实 skip）
 * @returns 编排器实例
 */
function buildOrchestrator(noTestCmd = 'node -e "console.log(1)"'): AutonomousOrchestrator {
  const loopExecutor = createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    createDevStageHandler(),
    createVerifyStageHandler(),
    createFixStageHandler()
  );
  return new AutonomousOrchestrator({
    loopExecutor,
    runStateStore: new P5RunStateStore(),
    notesMemory: new P5NotesMemory(),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
    defaultTestCommand: noTestCmd,
    defaultTestTimeoutSec: 15,
  });
}

// ============================================================================
// 2. F1 + F3：Token 熔断 aborted 轮诚实收尾（T-A1）
// ============================================================================

test("T-A1. 编排器：dev 阶段确定性失败 → 熔断 aborted 轮不标 completed、不记 milestone、blockedStage=dev", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a1-");
  try {
    // 一张手写卡（requirement F-001，避开 3.4/3.5 守卫），声明文件真实存在
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 测试任务 1",
        "- requirement: F-001",
        "- status: pending",
        "- dependencies:",
        "- files: src/services/Service1.ts",
        "- deletions:",
        "- symbols: Service1",
        "- acceptance: 测试通过",
        "",
      ].join("\n"),
      "utf8"
    );
    const declared = path.join(projectRoot, "src", "services", "Service1.ts");
    fs.mkdirSync(path.dirname(declared), { recursive: true });
    fs.writeFileSync(declared, "// 测试文件\n", "utf8");

    // 任务执行器替身（仅替代 LLM 网络往返）：dev 执行"失败 + 烧穿预算"——
    // 复现 run f2358227def5 的核心事实：单任务 tokensUsed 超过 maxTokens。
    // 2026-10-09 F-B 起阶段开始前有最小可行预算检查（3000），故 maxTokens
    // 取 4000 保证 plan/dev 正常进入，dev 返回 4500 越线。
    // 2026-10-20 需求变更：Token 消耗不再终止运行——替身的 Token 超限 error
    // 只是普通失败信息，运行按**确定性失败熔断**收口（同一任务卡 + 相同失败
    // 连续 2 次即 abort，防模型循环重试）——这正是新口径下"模型循环就终止"
    // 的编排器级体现；任务卡毒化拦截（不标 completed）与 blockedStage=dev
    // 语义保持不变。
    const failingExecutor: P5TaskExecutor = Object.freeze({
      async executeTask(): Promise<Readonly<P5TaskExecutionResult>> {
        return Object.freeze({
          success: false,
          summary: "",
          tokensUsed: 4500,
          tokensEstimated: false,
          llmRequests: 21,
          changedFiles: Object.freeze([]),
          error: "Token 预算超限：单任务已用 4500 tokens（预算 4000），执行中止",
        });
      },
    });
    const orchestrator = buildOrchestrator();
    orchestrator.bindTaskExecutor(failingExecutor);

    const result = await orchestrator.run({
      projectRoot,
      objective: "完成测试任务",
      maxIterations: 10,
      maxTokens: 4000,
    });

    // 断言 1（F1）：终态 aborted（确定性失败熔断），且不得按全绿轮收尾
    assert.equal(result.finalStatus, "aborted", `应熔断 aborted，实际：${result.finalStatus}`);
    assert.equal(result.milestones.length, 0, "aborted 轮不得记录里程碑（修复前会记'4 阶段全绿'假里程碑）");
    // 断言 2（F1 核心回归点）：dev 失败的任务卡不得被 markTaskCompleted 毒化落盘
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    assert.equal(
      readCardStatus(tasksFilePath, "T-001"),
      "pending",
      "dev 熔断失败的任务卡必须保持 pending（修复前被假标 completed，毒化下次运行）"
    );
    // 断言 3（F3）：阻塞报告的 blockedStage 必须是真实熔断阶段 dev（修复前兜底成 plan）；
    // 终止原因透出**确定性失败熔断**（2026-10-20 起 Token 预算耗尽不再是终止口径，
    // 恒失败的模型循环由确定性失败熔断收口）
    assert.ok(result.blockageReport !== undefined, "aborted 运行必须产出阻塞分析报告");
    assert.equal(result.blockageReport!.blockedStage, "dev", "blockedStage 必须是真实熔断阶段 dev");
    assert.ok(
      result.blockageReport!.summary.includes("确定性失败熔断"),
      `阻塞报告摘要应透出真实终止原因（确定性失败熔断），实际：${result.blockageReport!.summary}`
    );
    // 断言 4（F1）：假全绿轮的 completedLoops 误登记不得发生
    assert.ok(!result.completedLoops.includes("coding"), "aborted 轮不得把 coding 登记为已完成 Loop");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 3. F2：formatIterationSummary 真实判定 allSuccess（T-A2）
// ============================================================================

test("T-A2. formatIterationSummary：含 failed 阶段输出'部分失败'，杜绝'全绿+dev=failed'矛盾文案", () => {
  // 私有方法经原型调用（纯函数语义，不依赖 this；避免为测试改变可见性）
  const format = (AutonomousOrchestrator.prototype as unknown as Record<string, (r: unknown) => string>)[
    "formatIterationSummary"
  ];
  assert.equal(typeof format, "function", "formatIterationSummary 应存在于原型");

  // 复现 run f2358227def5 的真实阶段结果形态：plan success + dev failed
  const poisonedResults = [
    { stage: "plan", kind: "success" },
    { stage: "dev", kind: "failed" },
  ];
  const poisoned = format.call(null, poisonedResults);
  assert.ok(poisoned.startsWith("部分失败"), `含 failed 阶段必须输出"部分失败"，实际：${poisoned}`);
  assert.ok(!poisoned.includes("4 阶段全绿"), "矛盾文案不得再出现");

  // 全 success 迭代保持"4 阶段全绿"语义不变
  const greenResults = [
    { stage: "plan", kind: "success" },
    { stage: "dev", kind: "success" },
  ];
  const green = format.call(null, greenResults);
  assert.ok(green.startsWith("4 阶段全绿"), `全 success 应输出"4 阶段全绿"，实际：${green}`);
});

// ============================================================================
// 4. F4：执行器 pre-flight 预检 + 响应后检查（T-A3 / T-A4）
// ============================================================================

/**
 * 构造执行器输入（端口契约的最小完整真实值，可注入 perTaskBudget）。
 *
 * @param projectRoot 项目根目录
 * @param perTaskBudget 单任务 Token 预算（undefined 时不注入）
 * @returns 冻结的 P5TaskExecutionInput
 */
function buildExecutionInput(
  projectRoot: string,
  perTaskBudget?: number
): Parameters<LlmTaskExecutor["executeTask"]>[0] {
  return Object.freeze({
    projectRoot,
    runId: "tokenabort-run-001",
    iterIndex: 0,
    stage: "dev",
    objective: "在临时项目中按任务卡完成真实文件改动",
    taskId: "T-001",
    taskTitle: "创建 answer 模块",
    acceptanceCriteria: Object.freeze(["文件真实落盘"]),
    abortFlagPath: path.join(projectRoot, ".eag", "p5", "abort.flag"),
    perTaskBudget,
  });
}

test("T-A3. 执行器 pre-flight 预检：预算内装不下下一次请求 → 零 LLM 请求直接 failure", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a3-");
  try {
    const client = new StubLlmClient([
      // 任何脚本响应都不应被触达：预检必须发生在请求之前
      { content: "不应该被执行到的终态回复" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    // 预算 10：任务简报消息字符量换算（CHARS_PER_TOKEN_ESTIMATE=3.5）必然 > 10
    const result = await executor.executeTask(buildExecutionInput(projectRoot, 10));

    assert.equal(result.success, false, "预算装不下下一次请求必须失败");
    assert.ok((result.error ?? "").includes("Token 预算预检超限"), `错误信息应透出预检超限语义，实际：${result.error}`);
    assert.equal(client.requestCount, 0, "预检失败必须零 LLM 请求（不发请求不烧 token）");
    assert.equal(result.tokensUsed, 0, "未发生任何请求，tokensUsed 必须为 0");
  } finally {
    cleanup(projectRoot);
  }
});

test("T-A4. 执行器响应后检查：单次请求 usage 越线 → 收尾工具照常执行 + 折叠续跑合法放行", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a4-");
  try {
    const targetAbsolute = path.join(projectRoot, "src", "answer.js");
    // 脚本：轮1 精确 usage 600+100=700（预算 699 越线）带工具调用 → 响应后
    // 检查命中段超限 → 折叠续跑（epoch=1），**收尾工具照常执行**（token 已
    // 真实消耗，工具是该请求语义的一部分，不得拦）；轮2 工具执行完、上下文
    // 含本轮 assistant+tool（折叠在请求前，消息序列保留当前轮，4 条合法）；
    // 轮2 响应 100+20=120 < 续跑段额度（均耗 700×4），续跑段放行给出终态。
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: targetAbsolute, content: "module.exports = 42;\n" } }],
        // 精确 usage：600 input + 100 output = 700，预算 699 → 响应后即越线
        usage: { inputTokens: 600, outputTokens: 100 },
      },
      { content: "文件已按预算内最终版本落盘。", usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot, 699));

    assert.equal(result.success, true, `续跑段应合法放行并完成任务，实际 error=${result.error}`);
    assert.equal(client.requestCount, 2, "越线请求照常执行 + 续跑段终态共 2 请求");
    assert.equal(
      fs.existsSync(targetAbsolute),
      true,
      "越线那次请求的收尾工具必须照常执行（拦截会丢失该请求语义，违反熔断点前移契约）"
    );
    assert.equal(fs.readFileSync(targetAbsolute, "utf8"), "module.exports = 42;\n", "落盘内容必须是越线请求写入的版本");
    assert.equal(result.tokensUsed, 820, "tokensUsed 如实累计：700 + 续跑段 120");
    // 续跑请求（第 2 条）：段折叠在响应后检查发生（epoch 推进 + baseline 重置），
    // 本轮 assistant/tool 消息保留 → system + 原 user + assistant + tool = 4 条，
    // 其中原历史已折叠为续跑指令段（compactMessagesForRequest 自压缩保证协议合法）
    const rolloverRequest = client.getRequests()[1]!;
    assert.ok(
      rolloverRequest.messages.some((m) => m.role === "user" && (m.content ?? "").includes("上下文续跑")),
      "续跑请求必须携带折叠后的续跑指令段"
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 5. F5：plan blocked 分支 AUTO 卡同目标重跑恢复（T-A5 ~ T-A8）
// ============================================================================

/**
 * 写入"同目标重跑死锁"现场 tasks.md：completed AUTO 同题卡 + blocked 旧卡
 * （复现 run 5081a4c28cd7：假 completed 卡挡住合成守卫、blocked 卡占位）。
 *
 * @param projectRoot 项目根目录
 * @param cardTitle completed AUTO 卡标题（即历史 objective 截断）
 * @param requirement 卡 requirement 值（AUTO=合成卡 / F-xxx=手写卡）
 */
function writeBlockedWithCompletedCard(projectRoot: string, cardTitle: string, requirement: string): void {
  fs.writeFileSync(
    path.join(projectRoot, ".eag", "p5", "tasks.md"),
    [
      "# EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance）",
      "",
      `## T-001 ${cardTitle}`,
      `- requirement: ${requirement}`,
      "- status: completed",
      "- dependencies:",
      "- files:",
      "- deletions:",
      "- symbols:",
      "- acceptance:",
      "",
      "## T-002 历史遗留的无关旧任务",
      "- requirement: AUTO",
      "- status: blocked",
      "- dependencies:",
      "- files:",
      "- deletions:",
      "- symbols:",
      "- acceptance:",
      "",
    ].join("\n"),
    "utf8"
  );
}

test("T-A5. 3.6 恢复守卫：completed AUTO 同题卡 + 全 blocked → 重置为 pending 落盘并选中执行", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a5-");
  try {
    const objective = "修复登录页面空指针";
    writeBlockedWithCompletedCard(projectRoot, objective, "AUTO");
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(buildPlanContext(projectRoot, objective));

    assert.equal(result.kind, "success", `plan 应恢复出可执行卡，实际：${result.kind} ${result.summary}`);
    const taskCard = result.artifacts["taskCard"] as { id: string; title: string } | null;
    assert.ok(taskCard !== null, "同目标重跑必须恢复出任务卡（修复前幂等死锁 TASKS_BLOCKED）");
    assert.equal(taskCard!.id, "T-001", "应选中被重置的同题 AUTO 卡");
    // 磁盘真实落盘断言：completed → pending 必须落盘（磁盘是唯一事实源）
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "pending", "completed AUTO 卡必须在磁盘上真实重置为 pending");
    assert.equal(readCardStatus(tasksFilePath, "T-002"), "blocked", "无关旧卡必须保持 blocked 不被误动");
  } finally {
    cleanup(projectRoot);
  }
});

test("T-A6. 3.6 恢复守卫：手写 completed 卡（requirement≠AUTO）不重置，维持 TASKS_BLOCKED", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a6-");
  try {
    const objective = "修复登录页面空指针";
    writeBlockedWithCompletedCard(projectRoot, objective, "F-001");
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(buildPlanContext(projectRoot, objective));

    assert.equal(result.kind, "success");
    assert.equal(
      result.artifacts["reason"],
      PLAN_REASON_TASKS_BLOCKED,
      "手写卡是人工完成事实，不得重置——维持任务阻塞语义"
    );
    const taskCard = result.artifacts["taskCard"] as { id: string } | null;
    assert.equal(taskCard, null, "不得选出任何任务卡");
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "completed", "手写 completed 卡必须原样保留");
  } finally {
    cleanup(projectRoot);
  }
});

test("T-A7. 3.6 恢复守卫：本运行此前迭代已执行过该卡 → 不重置（防运行内反复执行烧穿迭代）", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a7-");
  try {
    const objective = "修复登录页面空指针";
    writeBlockedWithCompletedCard(projectRoot, objective, "AUTO");
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();

    // prevResults 注入"本运行 iter0 的 plan 已真实选中 T-001"的事实
    const prevResults = [
      {
        stage: "plan",
        kind: "success",
        summary: "已选取任务卡 T-001",
        artifacts: { taskCard: { id: "T-001", title: objective } },
        guardRecords: [],
        tokensUsed: 0,
        durationMs: 1,
      },
    ];
    const result = await handler.handle(buildPlanContext(projectRoot, objective, prevResults, 1));

    assert.equal(result.kind, "success");
    assert.equal(
      result.artifacts["reason"],
      PLAN_REASON_TASKS_BLOCKED,
      "运行内防重入：已执行过的卡不得再次重置（否则 iter0 完成 → iter1 重置无限循环）"
    );
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "completed", "防重入生效时磁盘状态不得变更");
  } finally {
    cleanup(projectRoot);
  }
});

test("T-A8. 3.6 恢复守卫：落盘失败（真实只读目录）→ fail-closed 维持 TASKS_BLOCKED，不伪造成功", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a8-");
  try {
    const objective = "修复登录页面空指针";
    writeBlockedWithCompletedCard(projectRoot, objective, "AUTO");
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    // 真实触发落盘失败：tasks.md 所在目录改为只读（原子写需在目录内建临时文件）
    fs.chmodSync(path.dirname(tasksFilePath), 0o555);
    const handler = new P5PlanStageHandler();
    try {
      const result = await handler.handle(buildPlanContext(projectRoot, objective));

      assert.equal(result.kind, "success");
      assert.equal(
        result.artifacts["reason"],
        PLAN_REASON_TASKS_BLOCKED,
        "落盘失败必须 fail-closed：维持阻塞语义透出诊断，不得伪造恢复成功"
      );
      const taskCard = result.artifacts["taskCard"] as { id: string } | null;
      assert.equal(taskCard, null, "落盘失败时不得选出任务卡（内存态与磁盘态不得分裂）");
    } finally {
      // 恢复目录权限，保证 cleanup 可递归删除
      fs.chmodSync(path.dirname(tasksFilePath), 0o755);
    }
    // 磁盘原样：completed 未被半途篡改
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "completed", "落盘失败时磁盘必须原样");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 6. F6：5d blocked 场景根因假设/建议方案真实成因（T-A9）
// ============================================================================

test("T-A9. 5d blocked 报告：根因假设与建议方案透出真实阻塞构成，不再套用'依赖成环'模板", async () => {
  const projectRoot = createTempProject("eag-tokenabort-a9-");
  try {
    // 单张 blocked 卡，标题与 objective 互含（titleEmbedded → 3.4/3.5 守卫不干扰；
    // 非 completed → 3.6 恢复守卫不触发）→ 纯粹的 TASKS_BLOCKED → 5d failed 路径
    const objective = "修复登录页面空指针";
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        `## T-001 ${objective}`,
        "- requirement: AUTO",
        "- status: blocked",
        "- dependencies:",
        "- files:",
        "- deletions:",
        "- symbols:",
        "- acceptance:",
        "",
      ].join("\n"),
      "utf8"
    );
    const orchestrator = buildOrchestrator();
    // 绑定恒 noop 执行器（plan 阶段即被 5d 判 failed，dev 不会执行到）
    const noopExecutor: P5TaskExecutor = Object.freeze({
      async executeTask(): Promise<Readonly<P5TaskExecutionResult>> {
        return Object.freeze({
          success: true,
          summary: "[test-double] noop",
          tokensUsed: 1,
          tokensEstimated: false,
          llmRequests: 1,
          changedFiles: Object.freeze([]),
          noop: true,
        });
      },
    });
    orchestrator.bindTaskExecutor(noopExecutor);

    const result = await orchestrator.run({
      projectRoot,
      objective,
      maxIterations: 3,
    });

    assert.equal(result.finalStatus, "failed", `应 blocked 判 failed，实际：${result.finalStatus}`);
    assert.ok(result.blockageReport !== undefined, "failed 运行必须产出阻塞分析报告");
    const hypotheses = result.blockageReport!.rootCauseHypotheses;
    assert.ok(
      hypotheses.some((h) => h.includes("任务清单无可执行的 pending 卡")),
      `根因假设应透出真实阻塞构成，实际：${JSON.stringify(hypotheses)}`
    );
    const solutions = result.blockageReport!.suggestedSolutions;
    assert.ok(
      solutions.some((s) => s.includes("清理或重置")),
      `建议方案应给出 blocked 卡清理/重置指引，实际：${JSON.stringify(solutions)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});
