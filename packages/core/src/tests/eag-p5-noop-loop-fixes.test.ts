/**
 * EAG-P5 空循环根因修复回归测试（2026-10-07 多角色 review 裁决四根因）
 *
 * 覆盖（对应 review 报告根因 1/2/3）：
 * - 根因 1（3.5 AUTO 卡守卫"内存态未落盘"空循环回归）：
 *   · N1 旧 pending AUTO 卡与 goal 弱相关 → 旧卡 blocked 真实落盘 + 新合成卡落盘 + 选中新卡；
 *   · N2 第二轮同 goal 重跑 → 不再重复合成（卡数量不变），旧卡保持 blocked；
 *   · N3 markTaskCardStatusInContent 纯函数四分支；
 *   · N4 手写卡（requirementId≠AUTO）弱相关时不被拦截；
 *   · N5 3.4 已合成同目标卡时 3.5 只 blocked 旧卡、不重复追加；
 * - 根因 2（执行器"光说不做"判 success）：
 *   · E-N1 模型零工具调用 + 零文件变更 → success=true 且 noop=true；
 *   · E-N2 模型真实 write 落盘 → noop=false（非空转）；
 * - 根因 3（成功路径空转无熔断）：
 *   · O-N1 连续 3 轮 dev noop → 编排器触发连续空转熔断 status=aborted，
 *     而不是跑满 maxIterations 纯烧 token。
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - plan/编排器全部使用真实 StageHandler / AutonomousOrchestrator / GuardChain；
 * - 文件系统与 tasks.md 落盘全部真实（os.tmpdir 真实目录，逐字节断言）；
 * - 仅 LLM 网络边界用测试替身（StubLlmClient / noop 执行器替身，设计唯一替换点）。
 *
 * @module core/tests/eag-p5-noop-loop-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

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
  NOOP_CIRCUIT_BREAKER_THRESHOLD,
  markTaskCardStatusInContent,
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
    runId: "noopfix-run-001",
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
 * 构造 plan 阶段用 P5StageContext（最小完整上下文）。
 *
 * @param projectRoot 项目根目录
 * @param objective 自主目标文本
 * @param iterIndex 迭代序号（默认 0）
 * @returns 冻结的 P5StageContext
 */
function buildPlanContext(projectRoot: string, objective: string, iterIndex = 0): P5StageContext {
  return Object.freeze({
    runId: "noopfix-run-001",
    iterIndex,
    stage: "plan",
    projectRoot,
    worktreePath: projectRoot,
    objective,
    currentPlan: "",
    notesSnapshot: "",
    prevResults: Object.freeze([]),
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
 * 写入含一张旧 pending AUTO 卡的 tasks.md（模拟历史遗留的僵尸合成卡）。
 *
 * 卡标题与 N1 测试的 objective 语义完全无关（零词重合）。
 *
 * @param projectRoot 项目根目录
 */
function writeStaleAutoCard(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, ".eag", "p5", "tasks.md"),
    [
      "<!-- EAG-P5 任务清单（由自主目标自动生成，可手工编辑补充 files/acceptance） -->",
      "",
      "## T-001 修复登录页面空指针",
      "- requirement: AUTO",
      "- status: pending",
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

/**
 * 统计 tasks.md 中的任务卡数量（按 `## T-xxx ` 标题行计数）。
 *
 * @param tasksFilePath tasks.md 绝对路径
 * @returns 卡数量
 */
function countCards(tasksFilePath: string): number {
  const content = fs.readFileSync(tasksFilePath, "utf8");
  return (content.match(/^## T-\d+ /gm) ?? []).length;
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

// ============================================================================
// 2. 根因 1：3.5 AUTO 卡守卫磁盘落盘（N1-N5）
// ============================================================================

test("N1. 3.5 守卫：旧 pending AUTO 卡与 goal 弱相关 → blocked 真实落盘 + 新合成卡落盘 + 选中新卡", async () => {
  const projectRoot = createTempProject("eag-noopfix-n1-");
  try {
    writeStaleAutoCard(projectRoot);
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();
    // goal 与旧卡"修复登录页面空指针"零词重合
    const ctx = buildPlanContext(projectRoot, "实现订单退款接口并补充单元测试");

    const result = await handler.handle(ctx);

    assert.equal(result.kind, "success", `plan 应成功，实际：${result.kind} ${result.summary}`);
    const taskCard = result.artifacts["taskCard"] as { id: string; title: string } | null;
    assert.ok(taskCard !== null, "应选出任务卡");
    // 选中的必须是新合成卡（旧卡被 blocked 后不可再选）
    assert.equal(taskCard!.id, "T-002", `应选中新合成卡 T-002，实际选中：${taskCard!.id}`);
    // 磁盘真实落盘断言（核心回归点：旧版只在内存 patched，磁盘不变导致每轮重触发）
    assert.equal(countCards(tasksFilePath), 2, "新合成卡必须真实追加落盘");
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "blocked", "旧 AUTO 卡必须在磁盘上真实变更为 blocked");
    assert.equal(readCardStatus(tasksFilePath, "T-002"), "pending", "新合成卡必须以 pending 状态落盘");
  } finally {
    cleanup(projectRoot);
  }
});

test("N2. 3.5 守卫：第二轮同 goal 重跑不再重复合成（空循环回归的最终断言）", async () => {
  const projectRoot = createTempProject("eag-noopfix-n2-");
  try {
    writeStaleAutoCard(projectRoot);
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();
    const objective = "实现订单退款接口并补充单元测试";

    // 第一轮：触发守卫（blocked + 追加）
    const first = await handler.handle(buildPlanContext(projectRoot, objective, 0));
    assert.equal(first.kind, "success");
    assert.equal(countCards(tasksFilePath), 2, "第一轮应恰好 2 张卡");

    // 第二轮：同 goal 重跑——磁盘是唯一事实源，旧卡已 blocked、新卡 title 嵌入 goal，
    // 守卫不得再追加（旧版回归：内存态 patched 未落盘 → 每轮重复合成）
    const second = await handler.handle(buildPlanContext(projectRoot, objective, 1));
    assert.equal(second.kind, "success");
    assert.equal(countCards(tasksFilePath), 2, "第二轮不得重复合成新卡");
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "blocked", "旧卡第二轮仍应保持 blocked");
    const card = second.artifacts["taskCard"] as { id: string } | null;
    assert.ok(card !== null);
    assert.equal(card!.id, "T-002", "第二轮仍应选中新合成卡");
  } finally {
    cleanup(projectRoot);
  }
});

test("N3. markTaskCardStatusInContent：改写目标卡 / 不影响其他卡 / 无 status 行插入兜底 / 未找到卡原样返回", () => {
  const content = [
    "## T-001 任务甲",
    "- requirement: AUTO",
    "- status: pending",
    "- files: a.ts",
    "",
    "## T-002 任务乙",
    "- requirement: F-002",
    "- status: in-progress",
    "- files: b.ts",
    "",
  ].join("\n");

  // 分支 1：改写目标卡 status，其他卡不受影响
  const rewritten = markTaskCardStatusInContent(content, "T-001", "blocked");
  assert.ok(rewritten.includes("- status: blocked"), "T-001 status 应被改写为 blocked");
  assert.ok(/## T-002[\s\S]*- status: in-progress/.test(rewritten), "T-002 status 不得被误改");
  assert.ok(!/## T-001[\s\S]*?in-progress/.test(rewritten.split("## T-002")[0]!), "T-001 不得残留 in-progress");

  // 分支 2：目标卡没有 status 行 → 标题行后插入兜底行（否则磁盘上仍是 pending，守卫重触发）
  const noStatus = ["## T-003 任务丙", "- requirement: AUTO", "- files: c.ts", ""].join("\n");
  const inserted = markTaskCardStatusInContent(noStatus, "T-003", "blocked");
  assert.ok(/^## T-003 任务丙\n- status: blocked$/m.test(inserted), `无 status 行时应在标题后插入，实际：${inserted}`);

  // 分支 3：未找到目标卡 → 原样返回（不得篡改其他内容）
  const untouched = markTaskCardStatusInContent(content, "T-999", "blocked");
  assert.equal(untouched, content, "未找到目标卡时必须原样返回");
});

test("N4. 3.5 守卫：手写卡（requirementId≠AUTO）弱相关时不被拦截（用户显式意志不覆盖）", async () => {
  const projectRoot = createTempProject("eag-noopfix-n4-");
  try {
    // 手写卡：requirement 为 F-001（非 AUTO），标题与 goal 零词重合
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 修复登录页面空指针",
        "- requirement: F-001",
        "- status: pending",
        "- dependencies:",
        "- files: src/login.ts",
        "- deletions:",
        "- symbols:",
        "- acceptance: 登录流程可用",
        "",
      ].join("\n"),
      "utf8"
    );
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();
    const ctx = buildPlanContext(projectRoot, "实现订单退款接口并补充单元测试");

    const result = await handler.handle(ctx);

    assert.equal(result.kind, "success");
    const card = result.artifacts["taskCard"] as { id: string } | null;
    assert.ok(card !== null);
    assert.equal(card!.id, "T-001", "手写卡必须被正常选中执行");
    // 3.4 守卫（既有语义）会为弱相关 goal 追加同目标合成卡，但手写卡 ID 更小仍先被选中；
    // 3.5 守卫的边界是：手写卡绝不被 blocked、状态绝不被改写
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "pending", "手写卡状态不得被改写为 blocked");
    assert.equal(readCardStatus(tasksFilePath, "T-002") ?? "pending", "pending", "追加的合成卡保持 pending");
  } finally {
    cleanup(projectRoot);
  }
});

test("N5. 3.5 守卫：3.4 已合成同目标卡时只 blocked 旧卡、不重复追加同目标卡", async () => {
  const projectRoot = createTempProject("eag-noopfix-n5-");
  try {
    // 磁盘上已有两张卡：旧 AUTO 卡（与 goal 无关）+ 3.4 刚合成的同目标卡 T-002。
    // 模拟 3.4 追加后 pickNextPendingTask 仍选中旧 T-001（ID 升序抢先）的场景。
    const objective = "实现订单退款接口并补充单元测试";
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "<!-- EAG-P5 任务清单 -->",
        "",
        "## T-001 修复登录页面空指针",
        "- requirement: AUTO",
        "- status: pending",
        "- dependencies:",
        "- files:",
        "- deletions:",
        "- symbols:",
        "- acceptance:",
        "",
        `## T-002 ${objective}`,
        "- requirement: AUTO",
        "- status: pending",
        "- dependencies:",
        "- files:",
        "- deletions:",
        "- symbols:",
        "- acceptance:",
        "",
      ].join("\n"),
      "utf8"
    );
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(buildPlanContext(projectRoot, objective, 0));

    assert.equal(result.kind, "success");
    assert.equal(countCards(tasksFilePath), 2, "3.4 已合成同目标卡时 3.5 不得重复追加");
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "blocked", "旧无关卡必须被 blocked 落盘");
    assert.equal(readCardStatus(tasksFilePath, "T-002"), "pending", "同目标合成卡保持 pending");
    const card = result.artifacts["taskCard"] as { id: string } | null;
    assert.ok(card !== null);
    assert.equal(card!.id, "T-002", "应选中同目标合成卡");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 3. 根因 2：执行器 noop 标记（E-N1/E-N2）
// ============================================================================

/**
 * 创建真实临时 git 项目（changedFiles 检出依赖真实 git 仓库）。
 *
 * @returns 项目根目录绝对路径
 */
function createGitProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-noopfix-git-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: "ignore" });
  return projectRoot;
}

/**
 * 构造执行器输入（端口契约的最小完整真实值）。
 *
 * @param projectRoot 项目根目录
 * @returns 冻结的 P5TaskExecutionInput
 */
function buildExecutionInput(projectRoot: string): Parameters<LlmTaskExecutor["executeTask"]>[0] {
  return Object.freeze({
    projectRoot,
    runId: "noopfix-run-001",
    iterIndex: 0,
    stage: "dev",
    objective: "在临时项目中按任务卡完成真实文件改动",
    taskId: "T-001",
    taskTitle: "创建 answer 模块",
    acceptanceCriteria: Object.freeze(["文件真实落盘"]),
    abortFlagPath: path.join(projectRoot, ".eag", "p5", "abort.flag"),
  });
}

test("E-N1. 执行器：模型零工具调用 + 零文件变更 → success=true 且 noop=true（空转可被编排器识别）", async () => {
  const projectRoot = createGitProject();
  try {
    // 桩模型直接给出终态文本（"光说不做"，不发起任何工具调用）
    const client = new StubLlmClient([{ content: "我打算创建 src/answer.js 模块并导出 answer 函数。" }]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true, "工具循环正常到达终态，success 仍为 true");
    assert.equal(result.noop, true, "零工具调用 + 零变更必须标记 noop=true");
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.llmRequests, 1);
  } finally {
    cleanup(projectRoot);
  }
});

test("E-N2. 执行器：模型真实 write 落盘 → noop=false（非空转，不误伤正常任务）", async () => {
  const projectRoot = createGitProject();
  try {
    const targetAbsolute = path.join(projectRoot, "src", "answer.js");
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: targetAbsolute, content: "module.exports = () => 42;\n" } }],
      },
      { content: "已创建 src/answer.js。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true);
    assert.equal(result.noop, false, "有真实变更时不得标记 noop");
    assert.ok(result.changedFiles.length > 0, "git 应检出真实变更文件");
    assert.ok(fs.existsSync(targetAbsolute), "文件必须真实落盘");
  } finally {
    cleanup(projectRoot);
  }
});

test("E-N3. 执行器：模型真实调用了只读工具但零文件变更 → noop=false（防误报回归）", async () => {
  const projectRoot = createGitProject();
  try {
    // 非 git 项目场景合并验证：createTempProject 不含 .git——read-only bash/read
    // 类任务在非 git 仓库本就检不出任何变更，若用 changedFiles 判据必被误标 noop
    const nonGitRoot = createTempProject("eag-noopfix-nongit-");
    const existingFile = path.join(nonGitRoot, "report.md");
    fs.writeFileSync(existingFile, "# 已有报告\n", "utf8");
    try {
      const client = new StubLlmClient([
        { content: "", toolCalls: [{ name: "read", args: { file_path: existingFile } }] },
        { content: "已审阅 report.md，无需修改。" },
      ]);
      const executor = new LlmTaskExecutor({ projectRoot: nonGitRoot, createLlmClient: () => client });

      const result = await executor.executeTask(buildExecutionInput(nonGitRoot));

      assert.equal(result.success, true);
      assert.equal(result.noop, false, "模型真实发起了工具调用（只读），不得标记 noop");
      assert.equal(result.changedFiles.length, 0, "只读任务零变更属合法场景");
    } finally {
      cleanup(nonGitRoot);
    }
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 4. 根因 3：编排器连续空转熔断（O-N1）
// ============================================================================

/**
 * 构造"恒 noop"任务执行器替身（仅替代 LLM 网络往返，状态机全真实）。
 *
 * 模拟"光说不做"执行结果：success=true、零文件变更、noop=true。
 *
 * @returns 符合 P5TaskExecutor 端口的测试替身
 */
function createNoopTaskExecutor(): P5TaskExecutor {
  const frozenResult: P5TaskExecutionResult = Object.freeze({
    success: true,
    summary: "[test-double] noop 替身：模型零工具调用、零文件变更",
    tokensUsed: 1,
    tokensEstimated: false,
    llmRequests: 1,
    changedFiles: Object.freeze([]),
    noop: true,
  });
  return Object.freeze({
    async executeTask(): Promise<Readonly<P5TaskExecutionResult>> {
      return frozenResult;
    },
  });
}

test("O-N1. 编排器：连续 3 轮 dev noop → 触发连续空转熔断 status=aborted（不再烧满 maxIterations）", async () => {
  const projectRoot = createTempProject("eag-noopfix-o1-");
  try {
    // 3 张相关手写卡（title 与 goal 词重合，避开 3.4/3.5 守卫干扰；
    // requirement 为 F-0xx 手写卡，3.5 不拦截）
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
        "## T-002 测试任务 2",
        "- requirement: F-002",
        "- status: pending",
        "- dependencies:",
        "- files: src/services/Service2.ts",
        "- deletions:",
        "- symbols: Service2",
        "- acceptance: 测试通过",
        "",
        "## T-003 测试任务 3",
        "- requirement: F-003",
        "- status: pending",
        "- dependencies:",
        "- files: src/services/Service3.ts",
        "- deletions:",
        "- symbols: Service3",
        "- acceptance: 测试通过",
        "",
      ].join("\n"),
      "utf8"
    );
    // 创建声明文件（dev 阶段盘点需要）
    for (const i of [1, 2, 3]) {
      const p = path.join(projectRoot, "src", "services", `Service${i}.ts`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "// 测试文件\n", "utf8");
    }

    // 测试命令：exit 0 且无测试统计 → verify 无条件诚实 skip（unverified），
    // 不进入 guard chain 证据校验，隔离空转熔断断言
    const noTestCmd = "node -e 'console.log(\"nothing to test\")'";
    const loopExecutor = createP5LoopExecutorFromHandlers(
      new P5PlanStageHandler(),
      createDevStageHandler(),
      createVerifyStageHandler(),
      createFixStageHandler()
    );
    const orchestrator = new AutonomousOrchestrator({
      loopExecutor,
      runStateStore: new P5RunStateStore(),
      notesMemory: new P5NotesMemory(),
      guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
      smartConfirmation: new P5SmartConfirmation(),
      defaultTestCommand: noTestCmd,
      defaultTestTimeoutSec: 15,
    });
    orchestrator.bindTaskExecutor(createNoopTaskExecutor());

    const result = await orchestrator.run({
      projectRoot,
      objective: "完成测试任务",
      maxIterations: 10,
    });

    // 断言 1：第 3 轮 noop 后触发熔断（阈值 3），不跑满 10 轮
    assert.equal(result.finalStatus, "aborted", `应空转熔断，实际：${result.finalStatus}`);
    assert.equal(result.totalIterations, NOOP_CIRCUIT_BREAKER_THRESHOLD, "熔断轮次应等于阈值 3");
    // 断言 2：熔断前每轮都真实走完（3 张卡都被 markTaskCompleted 落盘）
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "completed");
    assert.equal(readCardStatus(tasksFilePath, "T-002"), "completed");
    assert.equal(readCardStatus(tasksFilePath, "T-003"), "completed");
    // 断言 3：最终报告透出空转熔断语义（诚实告警，不伪装完成）
    assert.ok(
      result.finalReport.includes("空转") || result.blockageReport !== undefined,
      "最终报告或阻塞报告应透出空转熔断信息"
    );
  } finally {
    cleanup(projectRoot);
  }
});
