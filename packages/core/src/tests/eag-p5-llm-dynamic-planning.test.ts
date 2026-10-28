/**
 * EAG-P5 修复回归测试：plan 阶段 LLM 动态规划 + 预算不足干净终止
 * （2026-10-09，事故 run 2cb0893cccea，设计文档
 * docs/dev/eag-p5-llm-dynamic-planning.md）
 *
 * 事故复盘：plan 阶段纯本地规则机械选卡（5ms 直进 dev）→ dev 单任务 21 轮
 * 烧光 200,000 预算 → verify 失败 → fix 剩余 779 token 瞬败（1872 > 779），
 * 形成"零智能机械循环 + 阶段机械瞬败"式空循环。
 *
 * 覆盖（对应设计文档 §3 测试设计 T1-T13）：
 * - T1/T2（F-A1）：真实 LlmTaskExecutor.planIteration 返回合法 select JSON →
 *   plan 按模型决策选卡（覆盖本地 ID 升序默认值）、token 消耗诚实计入；
 * - T3-T7（F-A2）：select 非法/replan 应用与越权拒绝/非 JSON/无凭据/预算闸门
 *   全部回退本地选卡（fail-open 但留痕，行为与修复前一致）；
 * - T8（F-A2）：规划器 stop → 5d 判定 failed（不假完成）；
 * - T9：perTaskBudget < 3000 → 不发起规划请求；
 * - T10（F-A3）：跨 run 失败记忆（真实 run-state 落盘）进入规划简报与 artifacts；
 * - T11（F-B）：预算烧穿 → Token 熔断干净 aborted（含"Token 预算耗尽"），
 *   fix 不再瞬败空转；2026-10-13 起软续期生效，场景为 dev 烧穿硬上限
 *   由后置增量检查熔断（软续期未触发前置检查放行）；
 * - T12（F-C）：跨 run 失败记忆作为 feedback 注入 dev executeTask；
 * - T13：无历史/首迭代/LLM 正常 select 的 happy path 与修复前行为等价；
 * - T14-T16（F-A2b，2026-10-09 页面端到端复测补充）：全卡 blocked 局面
 *   不再在规划器之前提前 return——规划器获得 replan 解锁/诚实 stop 的
 *   机会；无执行器能力时维持修复前 TASKS_BLOCKED 行为。
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - plan/编排器/执行器全部使用真实 P5PlanStageHandler / AutonomousOrchestrator /
 *   LlmTaskExecutor（含生产 planIteration 实现）/ GuardChain；
 * - 文件系统与 tasks.md / run-state 落盘全部真实（os.tmpdir 真实目录，逐字节断言）；
 * - 仅 LLM 网络边界用测试替身（StubLlmClient，既有测试体系的唯一替换点）。
 *
 * @module core/tests/eag-p5-llm-dynamic-planning
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
  PLAN_REASON_TASK_CARD_SELECTED,
  PLAN_REASON_PLANNER_STOP,
  PLAN_REASON_TASKS_BLOCKED,
  loadPreviousRunContext,
  LlmTaskExecutor,
  type P5StageContext,
  type P5RunState,
  type P5TaskExecutor,
  type P5TaskExecutionInput,
  type P5TaskExecutionResult,
} from "../eag/p5/index";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 1. 真实临时项目夹具
// ============================================================================

/** 阶段级日志记录器（捕获 handler warn/info 留痕，供断言回退路径有迹可循） */
class LogRecorder {
  private readonly entries: string[] = [];
  readonly callback = (message: string): void => {
    this.entries.push(message);
  };
  /** 是否存在包含指定片段的日志 */
  includes(fragment: string): boolean {
    return this.entries.some((e) => e.includes(fragment));
  }
}

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
    runId: "dynaplan-run-0001",
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
 * 构造 plan 阶段用 P5StageContext（含 LLM 动态规划所需的可选字段）。
 *
 * @param projectRoot 项目根目录
 * @param objective 自主目标文本
 * @param options 可选项：taskExecutor（注入真实执行器启用规划）、perTaskBudget、
 *                logger（日志记录器）、abortFlagPath
 * @returns 冻结的 P5StageContext
 */
function buildPlanContext(
  projectRoot: string,
  objective: string,
  options: {
    readonly taskExecutor?: P5TaskExecutor | null;
    readonly perTaskBudget?: number;
    readonly logger?: (message: string, level: "info" | "warn" | "error") => void;
    readonly abortFlagPath?: string;
    readonly runId?: string;
  } = {}
): P5StageContext {
  return Object.freeze({
    runId: options.runId ?? "dynaplan-run-0001",
    iterIndex: 0,
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
    // LLM 动态规划链路（F-A2）：执行器端口 + 剩余预算 + abort 标志路径
    taskExecutor: options.taskExecutor ?? null,
    perTaskBudget: options.perTaskBudget,
    abortFlagPath: options.abortFlagPath ?? path.join(projectRoot, ".eag", "p5", "abort.flag"),
    logger: options.logger ?? null,
  }) as unknown as P5StageContext;
}

/**
 * 写入手写任务卡清单（requirement=F-xxx，避开 3.4/3.5 AUTO 守卫），并为
 * 每张卡声明的 files 创建真实存在文件（通过范围锁预检）。
 *
 * @param projectRoot 项目根目录
 * @param cards 卡定义（id/title/fileBasenames）
 */
function writeHandwrittenCards(
  projectRoot: string,
  cards: ReadonlyArray<{ readonly id: string; readonly title: string; readonly file: string }>
): void {
  const sections = cards.map((card) =>
    [
      `## ${card.id} ${card.title}`,
      "- requirement: F-100",
      "- status: pending",
      "- dependencies:",
      `- files: ${card.file}`,
      "- deletions:",
      "- symbols:",
      "- acceptance: 测试通过",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(projectRoot, ".eag", "p5", "tasks.md"),
    ["# 任务清单", "", ...sections].join("\n"),
    "utf8"
  );
  // 声明文件真实存在（范围锁预检要求）
  for (const card of cards) {
    const absolute = path.join(projectRoot, card.file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "// 测试文件\n", "utf8");
  }
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

/**
 * 预置一条历史 aborted run-state 落盘（真实 JSONL 文件，F-A3 失败记忆数据源）。
 *
 * @param projectRoot 项目根目录
 * @param prevRunId 历史 run ID（必须不同于当前运行）
 */
function writePreviousAbortedRunState(projectRoot: string, prevRunId: string): void {
  const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
  fs.mkdirSync(runStateDir, { recursive: true });
  // 两行快照（中间态 + 终态），模拟真实 RunState JSONL 追加写形态
  const lines = [
    JSON.stringify({
      runId: prevRunId,
      status: "running",
      currentStage: "dev",
      totalTokensUsed: 150000,
      totalLlmCallCount: 15,
      consecutiveFailures: 0,
      updatedAt: "2026-10-09T14:05:00.000Z",
    }),
    JSON.stringify({
      runId: prevRunId,
      status: "aborted",
      currentStage: "dev",
      totalTokensUsed: 199221,
      totalLlmCallCount: 21,
      consecutiveFailures: 1,
      abortReason: "Token 预算耗尽：199221 >= 200000",
      updatedAt: "2026-10-09T14:20:00.000Z",
    }),
  ];
  fs.writeFileSync(path.join(runStateDir, `${prevRunId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

/** 构造真实 LlmTaskExecutor（桩 LLM 客户端注入 HTTP 边界） */
function buildLlmExecutor(projectRoot: string, client: StubLlmClient | null): LlmTaskExecutor {
  return new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });
}

// ============================================================================
// 2. T1/T2（F-A1）：合法 select 决策 + token 诚实记账
// ============================================================================

test("T1. planIteration 合法 select → plan 按模型决策选卡（覆盖本地 ID 升序默认值）", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t1-");
  try {
    // 两张可执行卡：本地规则会选 ID 升序第一张 T-001；
    // 模型决策选 T-002 → 修复后以模型决策为准
    writeHandwrittenCards(projectRoot, [
      { id: "T-001", title: "修复登录页面空指针（表单校验部分）", file: "src/services/Form.ts" },
      { id: "T-002", title: "修复登录页面空指针（会话恢复部分）", file: "src/services/Session.ts" },
    ]);
    // 规划器决策：选 T-002（围栏包裹，验证 JSON 提取容错）
    const client = new StubLlmClient([
      {
        content: '```json\n{"action":"select","taskId":"T-002","reasoning":"会话恢复部分是空指针根因，先修它"}\n```',
      },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
      })
    );

    assert.equal(result.kind, "success", `plan 应成功，实际：${result.kind} ${result.summary}`);
    const taskCard = result.artifacts["taskCard"] as { id: string; title: string } | null;
    assert.ok(taskCard !== null, "应选出任务卡");
    assert.equal(taskCard!.id, "T-002", "必须按 LLM 规划决策选 T-002（修复前机械选 T-001）");
    assert.equal(result.artifacts["plannerAction"], "select", "plannerAction 应留痕 select");
    assert.equal(result.artifacts["plannerReasoning"], "会话恢复部分是空指针根因，先修它", "规划理由应透传 artifacts");
    // 真实发起过一次规划请求（llmRequests 审计字段）
    assert.equal(client.requestCount, 1, "规划应真实发起一次 LLM 请求");
    assert.equal(result.artifacts["llmRequests"], 1, "plan 结果应审计 llmRequests=1");
  } finally {
    cleanup(projectRoot);
  }
});

test("T2. 规划 token 消耗诚实计入 plan 结果（tokensUsed=usage 累计，非恒 0）", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t2-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    const client = new StubLlmClient([
      {
        content: '{"action":"none","reasoning":"本地选卡合理，无需干预"}',
        // 精确 usage：600 input + 100 output = 700
        usage: { inputTokens: 600, outputTokens: 100 },
      },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
      })
    );

    assert.equal(result.kind, "success");
    // 修复前 plan 阶段 tokensUsed 恒 0（run 级预算虚高 700）；修复后如实记账
    assert.equal(result.tokensUsed, 700, "规划请求的 usage 必须如实计入 plan.tokensUsed");
    assert.equal(result.artifacts["llmRequests"], 1, "action=none 也发起了真实请求，llmRequests=1");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 3. T3-T7（F-A2）：决策非法/不可用 → 回退本地选卡
// ============================================================================

test("T3. select 非法（taskId 不在可执行集合）→ 回退本地选卡 + warn 留痕", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t3-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    const client = new StubLlmClient([
      { content: '{"action":"select","taskId":"T-999","reasoning":"选一张不存在的卡"}' },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();
    const logger = new LogRecorder();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
        logger: logger.callback,
      })
    );

    assert.equal(result.kind, "success");
    const taskCard = result.artifacts["taskCard"] as { id: string } | null;
    assert.equal(taskCard!.id, "T-001", "非法 select 必须回退本地选卡 T-001");
    assert.equal(result.artifacts["plannerAction"], "select-invalid", "plannerAction 应留痕 select-invalid 供审计");
    assert.ok(logger.includes("不在可执行集合"), "回退必须 warn 留痕（静默回退会让模型决策失效无人知晓）");
  } finally {
    cleanup(projectRoot);
  }
});

test("T4. replan 合法：改 AUTO 卡状态 + 追加新 AUTO 卡 → tasks.md 磁盘真实变更并本地重选", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t4-");
  try {
    const objective = "修复登录页面空指针";
    // AUTO 卡（标题嵌目标 → 3.4/3.5 守卫不拦截）：T-001 可执行，T-002 blocked
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        `## T-001 ${objective}`,
        "- requirement: AUTO",
        "- status: pending",
        "- dependencies:",
        "- files:",
        "- deletions:",
        "- symbols:",
        "- acceptance:",
        "",
        "## T-002 修复登录页面空指针的回归测试",
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
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    // replan：把 blocked 的 T-002 重置 pending + 追加依赖 T-001 的新卡
    const client = new StubLlmClient([
      {
        content:
          '{"action":"replan","reasoning":"回归测试被阻塞应放行，另补一个修复确认卡",' +
          '"tasks":[' +
          '{"id":"T-002","status":"pending"},' +
          '{"title":"修复登录页面空指针的收尾验证","dependencies":["T-001"]}' +
          "]}",
      },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, objective, { taskExecutor: executor, perTaskBudget: 100_000 })
    );

    assert.equal(result.kind, "success", `replan 应用应成功，实际：${result.summary}`);
    // 磁盘真实落盘断言（磁盘是唯一事实源）
    assert.equal(readCardStatus(tasksFilePath, "T-002"), "pending", "T-002 必须在磁盘上真实重置为 pending");
    const disk = fs.readFileSync(tasksFilePath, "utf8");
    assert.ok(
      disk.includes("## T-003 修复登录页面空指针的收尾验证"),
      "新卡必须由本地生成编号 T-003 并追加落盘（防 LLM 撞号）"
    );
    assert.ok(
      /## T-003[^\n]*\n- requirement: AUTO/.test(disk),
      "追加的新卡必须标记 requirement=AUTO（AUTO 卡语义守卫判定依据）"
    );
    assert.ok(/- dependencies: T-001/.test(disk.split("## T-003")[1] ?? ""), "新卡的依赖声明必须真实落盘");
    // 本地重选生效：T-001 仍是 ID 升序第一张可执行卡
    const taskCard = result.artifacts["taskCard"] as { id: string } | null;
    assert.equal(taskCard!.id, "T-001", "replan 后必须本地重选（T-001 优先）");
    assert.equal(result.artifacts["plannerAction"], "replan");
  } finally {
    cleanup(projectRoot);
  }
});

test("T5. replan 越权：改手写卡 / 设 completed / 未知卡 → 该部分被拒绝，磁盘不变", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t5-");
  try {
    const objective = "修复登录页面空指针";
    // 手写卡 T-001（F-100）+ AUTO 卡 T-002 pending
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 修复登录页面空指针",
        "- requirement: F-100",
        "- status: pending",
        "- dependencies:",
        "- files: src/services/Login.ts",
        "- deletions:",
        "- symbols:",
        "- acceptance: 测试通过",
        "",
        `## T-002 ${objective}的回归测试`,
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
    // 越权决策：手写卡设 completed（拒绝）+ 手写卡改 blocked（拒绝）+ 未知卡（跳过）
    const client = new StubLlmClient([
      {
        content:
          '{"action":"replan","reasoning":"越权尝试",' +
          '"tasks":[' +
          '{"id":"T-001","status":"completed"},' +
          '{"id":"T-999","status":"pending"}' +
          "]}",
      },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, objective, { taskExecutor: executor, perTaskBudget: 100_000 })
    );

    assert.equal(result.kind, "success");
    // 手写卡状态不得被 LLM 篡改（防假完成：completed 只能由真实进展产生）
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "pending", "手写卡不得被 replan 篡改状态");
    assert.equal(result.artifacts["plannerAction"], "replan", "replan 决策本身合法（应用部分被本地守门过滤）");
  } finally {
    cleanup(projectRoot);
  }
});

test("T6. LLM 输出非 JSON → ok=false 回退本地选卡，行为与修复前一致", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t6-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    const client = new StubLlmClient([{ content: "我觉得应该先做 T-001，因为它最简单。（自然语言回复，不是 JSON）" }]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();
    const logger = new LogRecorder();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
        logger: logger.callback,
      })
    );

    assert.equal(result.kind, "success");
    const taskCard = result.artifacts["taskCard"] as { id: string } | null;
    assert.equal(taskCard!.id, "T-001", "非 JSON 输出必须回退本地选卡");
    assert.equal(result.artifacts["plannerAction"], "failed", "plannerAction 应留痕 failed");
    // fail-open 但消耗与告警都必须留痕
    assert.ok(result.tokensUsed > 0, "请求已发生，token 消耗必须如实计入");
    assert.ok(logger.includes("回退本地选卡"), "回退必须 warn 留痕");
  } finally {
    cleanup(projectRoot);
  }
});

test("T7. 无凭据（client null）→ planIteration fail-closed → 本地选卡兜底，零请求", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t7-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    // 无凭据场景：工厂返回 null（生产链路真实形态）
    const executor = buildLlmExecutor(projectRoot, null);
    const handler = new P5PlanStageHandler();
    const logger = new LogRecorder();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
        logger: logger.callback,
      })
    );

    assert.equal(result.kind, "success");
    const taskCard = result.artifacts["taskCard"] as { id: string } | null;
    assert.equal(taskCard!.id, "T-001", "无凭据必须回退本地选卡（fail-closed 不伪造决策）");
    assert.equal(result.artifacts["plannerAction"], "failed");
    assert.equal(result.tokensUsed, 0, "未发生请求，tokensUsed 必须为 0");
    assert.ok(logger.includes("LLM 规划不可用"), "无凭据回退必须 warn 留痕");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 4. T8（F-A2）：规划器 stop → 5d 判定 failed
// ============================================================================

test("T8. 规划器 stop → plan taskCard=null + reason=planner-stop → 终态 failed 不假完成", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t8-");
  try {
    const objective = "让时光机倒流";
    // AUTO 卡（标题嵌目标）
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        `## T-001 ${objective}`,
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
    const client = new StubLlmClient([
      {
        content: '{"action":"stop","reasoning":"目标在当前环境不可行（无时光机 API），继续只会烧预算"}',
      },
    ]);
    // 真实执行器绑定（plan 阶段走 LLM 规划；stop 后 dev 不会执行到）
    const orchestrator = buildOrchestrator();
    orchestrator.bindTaskExecutor(buildLlmExecutor(projectRoot, client));

    const result = await orchestrator.run({ projectRoot, objective, maxIterations: 3 });

    assert.equal(result.finalStatus, "failed", `规划器 stop 必须判 failed，实际：${result.finalStatus}`);
    assert.ok(result.blockageReport !== undefined, "failed 运行必须产出阻塞分析报告");
    assert.ok(
      result.blockageReport!.summary.includes("LLM 规划判定停止"),
      `阻塞摘要应透出规划器停止语义，实际：${result.blockageReport!.summary}`
    );
    assert.ok(
      result.blockageReport!.summary.includes("不可行"),
      `规划理由应进入阻塞摘要，实际：${result.blockageReport!.summary}`
    );
    // 任务卡不得被假完成
    assert.equal(
      readCardStatus(path.join(projectRoot, ".eag", "p5", "tasks.md"), "T-001"),
      "pending",
      "stop 后任务卡必须保持 pending"
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 5. T9（2026-10-20 R2b 重写）：规划器闸门与 perTaskBudget 解耦
// ============================================================================

test("T9. perTaskBudget < 3000 → 规划器照常发起请求（R2b：预算不再闸门）", async () => {
  // 旧语义（已废弃）：perTaskBudget < 3000 → 闸门关闭零请求。该闸门在
  // run 68acea2de182 事故中恰恰关死了"最失败后最需要 replan"的时刻
  // （perTaskBudget = max(0, 名义-已用) 烧穿后归零），是 blocked 死锁
  // 无法自愈的直接原因之一。R2b 后闸门只检查 planIteration 能力。
  const projectRoot = createTempProject("eag-dynaplan-t9-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    const client = new StubLlmClient([{ content: '{"action":"none","reasoning":"本地选卡合理"}' }]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 2500, // 旧口径下低于 MIN_PLANNER_TOKEN_BUDGET=3000
      })
    );

    assert.equal(result.kind, "success");
    assert.equal(client.requestCount, 1, "预算剩余 2500 也必须发起规划请求（闸门只查能力）");
    const taskCard = result.artifacts["taskCard"] as { id: string } | null;
    assert.equal(taskCard!.id, "T-001", "none 决策下本地选卡结果保持");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 6. T10（F-A3）：跨 run 失败记忆
// ============================================================================

test("T10. 历史 aborted run-state → 规划简报含终止原因与 token 消耗，artifacts 透出记忆", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t10-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    writePreviousAbortedRunState(projectRoot, "prevrun2cb0893");
    const client = new StubLlmClient([{ content: '{"action":"none","reasoning":"本地选卡合理"}' }]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
        // 当前 runId 必须不同于历史 run（排除自身）
        runId: "dynaplan-run-0001",
      })
    );

    assert.equal(result.kind, "success");
    // 规划简报（第二次消息 = user 提示词）必须包含上一轮真实失败记忆
    const plannerMessages = client.getRequests()[0]!.messages;
    const plannerBriefing = JSON.stringify(plannerMessages);
    assert.ok(plannerBriefing.includes("prevrun2cb0893"), "简报必须包含上一轮 run ID");
    assert.ok(
      plannerBriefing.includes("Token 预算耗尽：199221 >= 200000"),
      "简报必须包含上一轮真实 abortReason（磁盘事实源，不虚构）"
    );
    assert.ok(plannerBriefing.includes("199221"), "简报必须包含上一轮 token 消耗");
    // artifacts 透出（F-C dev 反馈注入的数据源）
    const memory = result.artifacts["previousRunContext"] as string;
    assert.ok(memory.length > 0, "previousRunContext 必须非空");
    assert.ok(memory.includes("aborted"), "记忆必须包含上一轮终止状态");
    assert.ok(memory.includes("勿机械重跑") || memory.includes("请勿机械重跑"), "记忆必须包含防机械重跑提示");
  } finally {
    cleanup(projectRoot);
  }
});

test("T10b. loadPreviousRunContext 纯函数：无历史返回空串；running 中间态不构成失败记忆", () => {
  const projectRoot = createTempProject("eag-dynaplan-t10b-");
  try {
    // 无 run-state 目录 → 空串
    assert.equal(loadPreviousRunContext(projectRoot, "cur-run-0001"), "", "无历史必须空串兜底");

    // 只有 running 中间态 → 不构成失败记忆（可能来自其他进行中的会话）
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    fs.mkdirSync(runStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(runStateDir, "runningrun-01.jsonl"),
      JSON.stringify({
        runId: "runningrun-01",
        status: "running",
        currentStage: "dev",
        totalTokensUsed: 5000,
        totalLlmCallCount: 2,
        consecutiveFailures: 0,
        updatedAt: "2026-10-09T15:00:00.000Z",
      }) + "\n",
      "utf8"
    );
    assert.equal(loadPreviousRunStateSafe(projectRoot), "", "running 中间态不得被当成失败记忆");

    // 当前 runId 自身被排除
    writePreviousAbortedRunState(projectRoot, "cur-run-0001");
    assert.equal(
      loadPreviousRunStateSafe(projectRoot, "cur-run-0001"),
      "",
      "当前 run 自身必须被排除（避免读到本 run 中间态）"
    );
  } finally {
    cleanup(projectRoot);
  }
});

/** loadPreviousRunContext 的异常安全包装（断言辅助：空串兜底） */
function loadPreviousRunStateSafe(projectRoot: string, currentRunId = "other-run-0002"): string {
  return loadPreviousRunContext(projectRoot, currentRunId);
}

// ============================================================================
// 7. T11（F-B，2026-10-20 语义翻转）：预算烧穿不再终止——运行正常完成
// ============================================================================

test("T11. 预算烧穿硬上限 → 运行不再 Token 熔断（completed），Token 消耗仅观测", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t11-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    // 执行器替身（替代 LLM 网络往返）：dev 消耗 15100/10000。
    // 2026-10-20 语义翻转前：dev 执行后 5b-3 后置增量检查命中硬上限熔断
    // （软续期一次至硬上限 15000 = 名义 10000 ×(1+0.5)，15100 >= 15000 →
    // aborted"Token 预算耗尽"）。
    // 2026-10-20 起需求变更：Token 消耗不再终止运行——同样场景运行正常
    // completed（dev 真实成功、任务卡 completed、verify/fix 正常走完），
    // 上下文压力由执行器段额度 80% 自动压缩接管，防失控由模型循环/空循环
    // 熔断与全局轮数上限负责。本测试反向验证 Token 终止口径绝迹。
    let executeTaskCalls = 0;
    const budgetBurnerExecutor: P5TaskExecutor = Object.freeze({
      async executeTask(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
        executeTaskCalls += 1;
        return Object.freeze({
          success: true,
          summary: "[test-double] 已消耗 15100 tokens",
          tokensUsed: 15100,
          tokensEstimated: false,
          llmRequests: 1,
          changedFiles: Object.freeze([]),
        });
      },
    });
    const orchestrator = buildOrchestrator();
    orchestrator.bindTaskExecutor(budgetBurnerExecutor);

    const result = await orchestrator.run({
      projectRoot,
      objective: "修复登录页面空指针",
      maxIterations: 3,
      maxTokens: 10000,
    });

    assert.equal(result.finalStatus, "completed", `预算烧穿不得终止运行，实际：${result.finalStatus}`);
    assert.ok(
      !result.blockageReport?.summary.includes("Token 预算耗尽"),
      `不得再出现"Token 预算耗尽"终止口径，实际：${result.blockageReport?.summary}`
    );
    // dev 正常执行且后续阶段不再被熔断拦截
    assert.ok(executeTaskCalls >= 1, "dev 至少执行过一次任务");
    // 任务卡按 dev 真实成功结果标 completed（不再有"预算耗尽假完成拦截"语义）
    assert.equal(
      readCardStatus(path.join(projectRoot, ".eag", "p5", "tasks.md"), "T-001"),
      "completed",
      "dev 真实成功且无 Token 熔断 → 任务卡正常标 completed"
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 8. T12（F-C）：跨 run 失败记忆作为 feedback 注入 dev
// ============================================================================

test("T12. previousRunContext 存在 → dev executeTask 收到非空 feedback（带着失败认知重跑）", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t12-");
  try {
    writeHandwrittenCards(projectRoot, [{ id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" }]);
    writePreviousAbortedRunState(projectRoot, "prevrun2cb0893");
    // 执行器替身（替代 LLM 网络往返）：捕获 dev 收到的 feedback
    let capturedFeedback: string | undefined;
    let capturedStage: string | undefined;
    const feedbackCaptureExecutor: P5TaskExecutor = Object.freeze({
      async executeTask(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
        capturedFeedback = input.feedback;
        capturedStage = input.stage;
        return Object.freeze({
          success: true,
          summary: "[test-double] 已按反馈实现",
          tokensUsed: 10,
          tokensEstimated: false,
          llmRequests: 1,
          changedFiles: Object.freeze([]),
        });
      },
    });
    const orchestrator = buildOrchestrator();
    orchestrator.bindTaskExecutor(feedbackCaptureExecutor);

    const result = await orchestrator.run({
      projectRoot,
      objective: "修复登录页面空指针",
      maxIterations: 2,
    });

    assert.equal(result.finalStatus, "completed", `单卡应完成，实际：${result.finalStatus}`);
    assert.equal(capturedStage, "dev", "应捕获 dev 阶段的执行输入");
    assert.ok(
      typeof capturedFeedback === "string" && capturedFeedback.length > 0,
      "dev 必须收到非空 feedback（F-C 注入）"
    );
    assert.ok(
      capturedFeedback!.includes("prevrun2cb0893"),
      `feedback 必须包含上一轮 run 记忆，实际：${capturedFeedback}`
    );
    assert.ok(capturedFeedback!.includes("Token 预算耗尽"), "feedback 必须包含上一轮真实失败原因");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 9. T13：happy path 回归——LLM 正常 select 与修复前行为等价
// ============================================================================

test("T13. 无历史 run、首迭代、LLM select 本地同款卡 → happy path 与修复前行为等价", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t13-");
  try {
    writeHandwrittenCards(projectRoot, [
      { id: "T-001", title: "修复登录页面空指针", file: "src/services/Login.ts" },
      { id: "T-002", title: "修复登录页面空指针（补充用例）", file: "src/services/LoginCase.ts" },
    ]);
    const client = new StubLlmClient([
      { content: '{"action":"select","taskId":"T-001","reasoning":"T-001 是根因卡，先修"}' },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, "修复登录页面空指针", {
        taskExecutor: executor,
        perTaskBudget: 100_000,
      })
    );

    assert.equal(result.kind, "success");
    assert.equal(
      result.artifacts["reason"],
      PLAN_REASON_TASK_CARD_SELECTED,
      "reason 应保持 TASK_CARD_SELECTED（与修复前口径一致）"
    );
    const taskCard = result.artifacts["taskCard"] as { id: string; title: string } | null;
    assert.ok(taskCard !== null);
    assert.equal(taskCard!.id, "T-001", "选中卡与本地规则结果一致（模型确认同一张卡）");
    assert.equal(result.artifacts["plannerAction"], "select");
    // PLAN_REASON_PLANNER_STOP 常量存在性（导出契约，5d 判定依赖）
    assert.equal(PLAN_REASON_PLANNER_STOP, "planner-stop");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 10. T14-T16（F-A2b）：全卡 blocked 局面不再绕过 LLM 规划器
// ============================================================================

/**
 * 写入全部 blocked 的 AUTO 卡清单（F-A2b 场景基线：跨 run 恢复最典型局面——
 * 上一轮 aborted 后所有卡保持非 completed，且被历史 replan 标 blocked）。
 *
 * @param projectRoot 项目根目录
 * @param objective 运行目标（AUTO 卡标题须嵌目标以通过相关性守卫）
 * @param cardIds 卡 ID 列表（默认 T-001/T-002）
 */
function writeAllBlockedAutoCards(
  projectRoot: string,
  objective: string,
  cardIds: ReadonlyArray<string> = ["T-001", "T-002"]
): void {
  const sections = cardIds.map((id, index) =>
    [
      `## ${id} ${objective}${index > 0 ? `（子任务 ${index}）` : ""}`,
      "- requirement: AUTO",
      "- status: blocked",
      "- dependencies:",
      "- files:",
      "- deletions:",
      "- symbols:",
      "- acceptance:",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(projectRoot, ".eag", "p5", "tasks.md"),
    ["# 任务清单", "", ...sections].join("\n"),
    "utf8"
  );
}

test("T14. 全卡 blocked → 规划器被真实调用 → replan 解锁 AUTO 卡并重选（修复前零请求机械失败）", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t14-");
  try {
    const objective = "修复登录页面空指针";
    writeAllBlockedAutoCards(projectRoot, objective);
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    // replan：把 blocked 的 T-002 重置 pending（T-001 保持 blocked 以证明
    // 解锁路径来自 replan 而非本地守卫）
    const client = new StubLlmClient([
      {
        content:
          '{"action":"replan","reasoning":"上一轮 aborted 后卡被机械标 blocked，' +
          'T-002 子任务仍可执行，重置 pending 解锁",' +
          '"tasks":[{"id":"T-002","status":"pending"}]}',
      },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();
    const logger = new LogRecorder();

    const result = await handler.handle(
      buildPlanContext(projectRoot, objective, {
        taskExecutor: executor,
        perTaskBudget: 100_000,
        logger: logger.callback,
      })
    );

    // 修复前：TASKS_BLOCKED 在规划器之前提前 return → requestCount=0、0 秒 failed。
    // 修复后：规划器被真实调用且决策生效。
    assert.equal(client.requestCount, 1, "全卡 blocked 必须仍然发起 LLM 规划请求");
    assert.equal(result.kind, "success", `replan 解锁后应成功，实际：${result.summary}`);
    const taskCard = result.artifacts["taskCard"] as { id: string; title: string } | null;
    assert.ok(taskCard !== null, "replan 解锁后必须选出可执行卡");
    assert.equal(taskCard!.id, "T-002", "必须选中 replan 解锁的 T-002");
    assert.equal(result.artifacts["plannerAction"], "replan", "plannerAction 应留痕 replan");
    assert.equal(result.tokensUsed, 48, "规划请求的默认 usage（32+16）必须如实计入 plan 结果");
    // 磁盘真实落盘断言（磁盘是唯一事实源）
    assert.equal(readCardStatus(tasksFilePath, "T-002"), "pending", "T-002 必须在磁盘上真实解锁为 pending");
    assert.equal(readCardStatus(tasksFilePath, "T-001"), "blocked", "replan 未触及的 T-001 保持 blocked");
    assert.ok(logger.includes("replan 已落盘并重选"), "解锁重选必须留痕（复测验收：llmRequests>0 且非机械选卡）");
  } finally {
    cleanup(projectRoot);
  }
});

test("T15. 全卡 blocked → replan 后仍无可执行卡 → planner-stop 诚实终止（token 与审计并入返回）", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t15-");
  try {
    const objective = "修复登录页面空指针";
    writeAllBlockedAutoCards(projectRoot, objective);
    // replan 只追加一张依赖 blocked 卡的新卡（依赖不满足 → 仍无可执行卡）
    const client = new StubLlmClient([
      {
        content:
          '{"action":"replan","reasoning":"需要先等环境诊断卡完成",' +
          '"tasks":[{"title":"环境依赖诊断","dependencies":["T-001"]}]}',
      },
    ]);
    const executor = buildLlmExecutor(projectRoot, client);
    const handler = new P5PlanStageHandler();

    const result = await handler.handle(
      buildPlanContext(projectRoot, objective, {
        taskExecutor: executor,
        perTaskBudget: 100_000,
      })
    );

    assert.equal(result.kind, "success");
    // replan 后无可执行卡 → 按规划器停止语义收尾（诚实透出理由，不假完成）
    assert.equal(result.artifacts["taskCard"], null, "无可执行卡时 taskCard 必须为 null");
    assert.equal(
      result.artifacts["reason"],
      PLAN_REASON_PLANNER_STOP,
      "reason 必须是 planner-stop（5d 判定 failed 依据）"
    );
    assert.equal(result.artifacts["plannerAction"], "replan", "plannerAction 应留痕 replan");
    assert.ok(
      String(result.artifacts["plannerReasoning"]).includes("需要先等环境诊断卡完成"),
      "规划理由必须透传 artifacts"
    );
    // 请求真实发生：token 消耗与请求审计必须并入收尾返回值（记账原则）
    assert.equal(client.requestCount, 1, "replan 应真实发起一次 LLM 请求");
    assert.ok(result.tokensUsed > 0, "tokensUsed 必须如实记账");
    assert.equal(result.artifacts["llmRequests"], 1, "收尾返回必须审计 llmRequests=1");
  } finally {
    cleanup(projectRoot);
  }
});

test("T16. 全卡 blocked + 无规划能力（旧宿主/测试替身）→ 维持修复前 TASKS_BLOCKED 行为", async () => {
  const projectRoot = createTempProject("eag-dynaplan-t16-");
  try {
    const objective = "修复登录页面空指针";
    writeAllBlockedAutoCards(projectRoot, objective);
    const handler = new P5PlanStageHandler();
    const logger = new LogRecorder();

    // taskExecutor=null（旧宿主形态）：plannerGateOpen=false → 规划器跳过
    const result = await handler.handle(buildPlanContext(projectRoot, objective, { logger: logger.callback }));

    assert.equal(result.kind, "success");
    assert.equal(result.artifacts["taskCard"], null, "全卡 blocked 时 taskCard 为 null");
    assert.equal(result.artifacts["reason"], PLAN_REASON_TASKS_BLOCKED, "无规划能力时维持修复前 tasks-blocked 语义");
    assert.equal(result.tokensUsed, 0, "未发生请求，tokensUsed 必须为 0");
    assert.equal(result.artifacts["plannerAction"], undefined, "规划器被跳过时不得伪造 plannerAction 审计字段");
  } finally {
    cleanup(projectRoot);
  }
});
