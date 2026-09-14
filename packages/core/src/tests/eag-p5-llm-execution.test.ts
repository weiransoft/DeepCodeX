/**
 * EAG-P5 LLM 执行链路补全（方案 A）单元测试
 * 设计文档：docs/dev/eag-p5-llm-execution-wiring.md §3.2~§3.7、§5
 *
 * 覆盖范围：
 * - plan 阶段：objective 合成任务卡真实原子落盘 + parseTaskCards 回读；
 *   objective 空→tasks-file-not-found；blocked/completed/依赖等待 reason 拆分；空文件→no-task-cards；
 *   buildSynthesizedTasksContent 格式契约。
 * - orchestrator：全绿后真实 markTaskCompleted（多卡逐轮、他卡与正文不变）；
 *   状态文件写入失败→本轮失败且不记 milestone（防"产物没写成却记完成"）；
 *   blocked→failed 且报告含任务 ID；无 tasks.md+空 objective→failed；
 *   执行器在真实 dev 阶段请求 stop（abort 标志文件）后终态不被 5d 翻转（P0-5 守卫可达变体）。
 * - dev 阶段：未绑定执行器→failed(NOT_BOUND)；无卡→success(no-task-card)；
 *   护栏 DENY→fatal 且执行器零触达；执行器 success=false→failed 并透传 error。
 * - fix 阶段：无 verify 失败→success(no-verify-failure)；有失败+未绑定→failed(NOT_BOUND)；
 *   有失败+已绑定→success 且执行器收到 stage:"fix" 与非空 feedback。
 * - verify 阶段：合成任务无 package.json / 有 package.json 无 scripts.test → 诚实 skipped+unverified；
 *   有 scripts.test 且失败 → 真实 spawn 后 failed；手写任务（非合成）无 package.json → 不降级，failed。
 *
 * 真实性：文件系统/child_process/git/护栏/状态机/orchestrator 全真实；
 * LLM 网络边界由 createAlwaysSucceedTaskExecutor 替身替代（设计 §6 允许，仅替网络）。
 *
 * @module core/tests/eag-p5-llm-execution
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { SessionManager } from "../session";
import { LlmTaskExecutor } from "../eag/p5/index";

import {
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  createSuccessStageResult,
  parseTaskCards,
  buildSynthesizedTasksContent,
  // reason 常量
  PLAN_REASON_TASK_CARD_SELECTED,
  PLAN_REASON_TASKS_FILE_NOT_FOUND,
  PLAN_REASON_NO_TASK_CARDS,
  PLAN_REASON_ALL_TASKS_COMPLETED,
  PLAN_REASON_TASKS_BLOCKED,
  DEV_REASON_TASK_EXECUTOR_NOT_BOUND,
  DEV_REASON_TASK_EXECUTION_FAILED,
  FIX_REASON_TASK_EXECUTOR_NOT_BOUND,
  FIX_REASON_TASK_EXECUTED,
  VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET,
  // 类型
  type P5StageContext,
  type P5StageResult,
  type P5TaskExecutor,
  type P5TaskExecutionInput,
  type P5TaskExecutionResult,
  type TaskCard,
} from "../eag/p5/index";

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
  createAlwaysSucceedTaskExecutor,
} from "./fixtures/eag-p5-e2e-fixtures";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 1. 本文件专用测试替身（仅替代 LLM 网络，可记录入参与故障注入）
// ============================================================================

/**
 * 创建"可记录入参"的恒成功执行器替身。
 *
 * 与共享夹具的区别：测试需要断言 dev/fix handler 传给执行器的
 * stage/feedback/abortFlagPath 等端口契约字段，故保留每次调用的 input 快照。
 *
 * @param options changedFiles/故障注入钩子
 * @returns executor 替身 + 调用记录数组
 */
function createRecordingTaskExecutor(options?: {
  readonly changedFiles?: ReadonlyArray<string>;
  /** 每次真实被调用时执行的夹具动作（故障注入用，如 chmod/写 abort 文件） */
  readonly onCall?: (input: Readonly<P5TaskExecutionInput>, callIndex: number) => void;
}): {
  readonly executor: P5TaskExecutor;
  readonly calls: Readonly<P5TaskExecutionInput>[];
} {
  const calls: P5TaskExecutionInput[] = [];
  const executor: P5TaskExecutor = {
    async executeTask(input): Promise<Readonly<P5TaskExecutionResult>> {
      const callIndex = calls.length;
      calls.push(input);
      options?.onCall?.(input, callIndex);
      return Object.freeze({
        success: true,
        summary: `[test-double] 第 ${callIndex + 1} 次执行完成（未发起真实 LLM 请求）`,
        tokensUsed: 1,
        tokensEstimated: false,
        llmRequests: 1,
        changedFiles: Object.freeze([...(options?.changedFiles ?? [])]),
      });
    },
  };
  return { executor, calls };
}

/**
 * 顺序执行真实四处理器中的前三阶段（plan→dev→verify），返回各阶段结果。
 *
 * @param projectRoot 项目根
 * @param taskExecutor 注入 dev 阶段的执行器
 * @param testCommand verify 真实执行的测试命令
 * @returns plan/dev/verify 结果
 */
async function runPlanDevVerify(
  projectRoot: string,
  taskExecutor: P5TaskExecutor | null,
  testCommand: string
): Promise<{
  readonly plan: Readonly<P5StageResult>;
  readonly dev: Readonly<P5StageResult>;
  readonly verify: Readonly<P5StageResult>;
}> {
  const plan = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan", { objective: "测试目标" }));

  const dev = await new P5DevStageHandler().handle(
    buildStageContext(projectRoot, "dev", {
      objective: "测试目标",
      prevResults: Object.freeze([plan]),
      taskExecutor,
    })
  );

  const verify = await new P5VerifyStageHandler().handle(
    buildStageContext(projectRoot, "verify", {
      objective: "测试目标",
      testCommand,
      prevResults: Object.freeze([plan, dev]),
    })
  );

  return Object.freeze({ plan, dev, verify });
}

// ============================================================================
// 2. plan 阶段：合成落盘 / reason 拆分
// ============================================================================

test("P-S1. 无 tasks.md+objective 非空：真实合成 T-001 原子落盘，回读为 pending 空声明卡", async () => {
  const projectRoot = createTempProject();
  try {
    const objective = "实现订单退款功能\n包含金额校验";
    const ctx = buildStageContext(projectRoot, "plan", { objective });

    const result = await new P5PlanStageHandler().handle(ctx);

    assert.equal(result.kind, "success");
    // 合成落盘后继续走统一选卡流程：reason 为 task-card-selected，
    // 由 synthesized=true 标志区分"本轮卡来自 objective 合成"（verify/orchestrator 据此分流）
    assert.equal(result.artifacts["reason"], PLAN_REASON_TASK_CARD_SELECTED);
    assert.equal(result.artifacts["synthesized"], true);

    const taskCard = result.artifacts["taskCard"] as TaskCard;
    assert.equal(taskCard.id, "T-001");
    assert.equal(taskCard.status, "pending");
    assert.deepEqual(taskCard.declaredFiles, []);
    assert.deepEqual(taskCard.acceptanceCriteria, []);

    // 文件必须真实存在于磁盘，并与解析器闭环
    const tasksFilePath = path.join(projectRoot, ".eag", "p5", "tasks.md");
    assert.ok(fs.existsSync(tasksFilePath), "合成 tasks.md 必须真实落盘");
    const raw = fs.readFileSync(tasksFilePath, "utf8");
    assert.match(raw, /^## T-001 实现订单退款功能 包含金额校验/m, "多行 objective 应折叠为单行标题");
    assert.match(raw, /^- status: pending$/m);
    assert.match(raw, /^- requirement: AUTO$/m);

    const reparsed = parseTaskCards(raw);
    assert.equal(reparsed.length, 1);
    assert.equal(reparsed[0]!.id, "T-001");
    assert.equal(reparsed[0]!.status, "pending");
    assert.deepEqual([...reparsed[0]!.declaredFiles], []);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P-S2. 无 tasks.md+objective 空白：taskCard=null 且 reason=tasks-file-not-found", async () => {
  const projectRoot = createTempProject();
  try {
    const result = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan", { objective: "   " }));
    assert.equal(result.kind, "success");
    assert.equal(result.artifacts["taskCard"], null);
    assert.equal(result.artifacts["reason"], PLAN_REASON_TASKS_FILE_NOT_FOUND);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P-S3. 清单全部 completed：taskCard=null 且 reason=all-tasks-completed", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 2, "completed");
    const result = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));
    assert.equal(result.kind, "success");
    assert.equal(result.artifacts["taskCard"], null);
    assert.equal(result.artifacts["reason"], PLAN_REASON_ALL_TASKS_COMPLETED);
    assert.equal(result.artifacts["completedCards"], 2);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P-S4. 显式 blocked 卡：reason=tasks-blocked 且 blockedCardIds 含任务 ID", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "blocked");
    const result = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));
    assert.equal(result.kind, "success");
    assert.equal(result.artifacts["taskCard"], null);
    assert.equal(result.artifacts["reason"], PLAN_REASON_TASKS_BLOCKED);
    assert.deepEqual(result.artifacts["blockedCardIds"], ["T-001"]);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P-S5. pending 卡依赖未满足：reason=tasks-blocked 且 waitingDependencies 给出缺失依赖", async () => {
  const projectRoot = createTempProject();
  try {
    // 手写一张依赖 T-000（不存在）的 pending 卡
    const tasksContent = [
      "# EAG-P5 任务清单",
      "",
      "## T-001 被依赖阻塞的任务",
      "- requirement: F-001",
      "- status: pending",
      "- dependencies: T-000",
      "- files:",
      "- acceptance:",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectRoot, ".eag", "p5", "tasks.md"), tasksContent, "utf8");

    const result = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));
    assert.equal(result.artifacts["reason"], PLAN_REASON_TASKS_BLOCKED);
    const waiting = result.artifacts["waitingDependencies"] as ReadonlyArray<{
      readonly id: string;
      readonly missingDependencies: ReadonlyArray<string>;
    }>;
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]!.id, "T-001");
    assert.deepEqual([...waiting[0]!.missingDependencies], ["T-000"]);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P-S6. tasks.md 存在但无任何任务卡：reason=no-task-cards", async () => {
  const projectRoot = createTempProject();
  try {
    fs.writeFileSync(path.join(projectRoot, ".eag", "p5", "tasks.md"), "# 只有标题\n\n- 不是任务卡属性\n", "utf8");
    const result = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));
    assert.equal(result.kind, "success");
    assert.equal(result.artifacts["taskCard"], null);
    assert.equal(result.artifacts["reason"], PLAN_REASON_NO_TASK_CARDS);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P-S7. buildSynthesizedTasksContent：格式契约（标题单行/换行折叠/空值属性行）", () => {
  const content = buildSynthesizedTasksContent("第一行\n  第二行\t制表");
  assert.match(content, /^## T-001 第一行 第二行 制表$/m);
  // 空值属性行故意保留 "- key:"（不被属性正则命中，解析器取默认空数组）
  for (const key of ["dependencies", "files", "deletions", "symbols", "acceptance"]) {
    assert.match(content, new RegExp(`^- ${key}:$`, "m"));
  }
  const reparsed = parseTaskCards(content);
  assert.equal(reparsed.length, 1);
  assert.equal(reparsed[0]!.status, "pending");
});

// ============================================================================
// 3. dev 阶段：fail-closed / 无卡 / 护栏优先 / 失败透传
// ============================================================================

test("D1. dev 未绑定执行器：failed 且 reason=task-executor-not-bound", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const plan = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));

    const dev = await new P5DevStageHandler().handle(
      buildStageContext(projectRoot, "dev", {
        prevResults: Object.freeze([plan]),
        // 显式不注入 taskExecutor（buildStageContext 默认无该字段）
      })
    );
    assert.equal(dev.kind, "failed");
    assert.equal(dev.artifacts["reason"], DEV_REASON_TASK_EXECUTOR_NOT_BOUND);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D2. dev 无任务卡（收尾轮）：success 且 reason=no-task-card", async () => {
  const projectRoot = createTempProject();
  try {
    // 手工构造 plan 收尾结果（taskCard=null），不经过执行器
    const planNull = createSuccessStageResult(
      "plan",
      "所有任务已完成",
      { taskCard: null, reason: PLAN_REASON_ALL_TASKS_COMPLETED },
      [],
      0,
      1
    );
    const dev = await new P5DevStageHandler().handle(
      buildStageContext(projectRoot, "dev", { prevResults: Object.freeze([planNull]) })
    );
    assert.equal(dev.kind, "success");
    assert.equal(dev.artifacts["reason"], "no-task-card");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D3. dev 护栏 DENY 优先：越界卡 fatal(G-A1a)，执行器零触达", async () => {
  const projectRoot = createTempProject();
  try {
    // 任务卡声明项目外文件（真实存在的越界路径）
    const outsidePath = path.join(createTempProject("eag-p5-outside-d3-"), "outside.ts");
    fs.writeFileSync(outsidePath, "// outside", "utf8");
    try {
      const recording = createRecordingTaskExecutor();
      const taskCard = createTestTaskCard("T-001", [outsidePath], ["OutsideService"]);
      const planResult = createSuccessStageResult("plan", "plan 完成", { taskCard }, [], 0, 1);
      const dev = await new P5DevStageHandler().handle(
        buildStageContext(projectRoot, "dev", {
          prevResults: Object.freeze([planResult]),
          taskExecutor: recording.executor,
        })
      );

      assert.equal(dev.kind, "fatal");
      assert.equal(dev.artifacts["guardRuleId"], "G-A1a");
      assert.equal(recording.calls.length, 0, "护栏 DENY 时绝不允许触达执行器");
    } finally {
      cleanupTempProject(path.dirname(outsidePath));
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D4. dev 执行器返回 success=false：failed 且 reason=task-execution-failed，error 透传", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const plan = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));

    // 恒失败替身（真实网络失败的可复现替代：执行器返回失败结果）
    const failingExecutor = createAlwaysSucceedTaskExecutor({
      success: false,
      error: "LLM 网关 500：模拟真实服务端错误",
    });
    const dev = await new P5DevStageHandler().handle(
      buildStageContext(projectRoot, "dev", {
        prevResults: Object.freeze([plan]),
        taskExecutor: failingExecutor,
      })
    );
    assert.equal(dev.kind, "failed");
    assert.equal(dev.artifacts["reason"], DEV_REASON_TASK_EXECUTION_FAILED);
    assert.match(dev.error ?? "", /500/);
    assert.equal(dev.artifacts["llmRequests"], 1, "失败前真实发起的请求数仍应透传到制品");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// 4. fix 阶段：无失败直通 / fail-closed / 带反馈真实修复
// ============================================================================

test("F1. fix 无 verify 失败：success(no-verify-failure)，不触达执行器", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const plan = await new P5PlanStageHandler().handle(buildStageContext(projectRoot, "plan"));
    const recording = createRecordingTaskExecutor({ changedFiles: ["src/services/Service1.ts"] });
    const dev = await new P5DevStageHandler().handle(
      buildStageContext(projectRoot, "dev", {
        prevResults: Object.freeze([plan]),
        taskExecutor: recording.executor,
      })
    );

    // prevResults 中没有 verify 失败结果（仅 plan+dev）
    const fix = await new P5FixStageHandler().handle(
      buildStageContext(projectRoot, "fix", {
        prevResults: Object.freeze([plan, dev]),
        taskExecutor: recording.executor,
      })
    );
    assert.equal(fix.kind, "success");
    assert.equal(fix.artifacts["reason"], "no-verify-failure");
    // 执行器只在 dev 被调用 1 次，fix 直通不应再调
    assert.equal(recording.calls.length, 1);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("F2. fix 有 verify 失败但未绑定执行器：failed 且 reason=fix-task-executor-not-bound", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const chain = await runPlanDevVerify(
      projectRoot,
      createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] }),
      FAIL_TEST_CMD
    );
    assert.equal(chain.verify.kind, "failed", "前置：verify 必须真实失败");

    const fix = await new P5FixStageHandler().handle(
      buildStageContext(projectRoot, "fix", {
        prevResults: Object.freeze([chain.plan, chain.dev, chain.verify]),
        // 不注入执行器
      })
    );
    assert.equal(fix.kind, "failed");
    assert.equal(fix.artifacts["reason"], FIX_REASON_TASK_EXECUTOR_NOT_BOUND);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("F3. fix 有 verify 失败且绑定执行器：success，执行器收到 stage=fix 与非空 feedback", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    const devExecutor = createAlwaysSucceedTaskExecutor({ changedFiles: ["src/services/Service1.ts"] });
    const chain = await runPlanDevVerify(projectRoot, devExecutor, FAIL_TEST_CMD);
    assert.equal(chain.verify.kind, "failed");

    const fixRecording = createRecordingTaskExecutor({ changedFiles: ["src/services/Service1.ts"] });
    const fix = await new P5FixStageHandler().handle(
      buildStageContext(projectRoot, "fix", {
        prevResults: Object.freeze([chain.plan, chain.dev, chain.verify]),
        taskExecutor: fixRecording.executor,
      })
    );

    assert.equal(fix.kind, "success");
    assert.equal(fix.artifacts["reason"], FIX_REASON_TASK_EXECUTED);
    assert.equal(fixRecording.calls.length, 1);
    const fixInput = fixRecording.calls[0]!;
    assert.equal(fixInput.stage, "fix");
    assert.equal(fixInput.taskId, "T-001");
    assert.ok(typeof fixInput.feedback === "string" && fixInput.feedback.length > 0, "fix 必须带结构化失败反馈");
    // 反馈应包含真实失败输出片段（FAIL_TEST_CMD 的输出）
    assert.match(fixInput.feedback!, /0 passed, 1 failed|exitCode/i);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// 5. verify 阶段：合成任务无测试目标的诚实 skip / 非合成不降级
// ============================================================================

test("V1. 合成任务 + 默认 npm test + 无 package.json：success skipped/unverified，措辞含不代表测试通过", async () => {
  const projectRoot = createTempProject();
  try {
    assert.ok(!fs.existsSync(path.join(projectRoot, "package.json")));
    const verify = await new P5VerifyStageHandler().handle(
      buildStageContext(projectRoot, "verify", {
        synthesizedTask: true,
        testCommand: "npm test",
      })
    );
    assert.equal(verify.kind, "success");
    assert.equal(verify.artifacts["reason"], VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET);
    assert.equal(verify.artifacts["skipped"], true);
    assert.equal(verify.artifacts["unverified"], true);
    assert.match(verify.summary, /不代表测试通过/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("V2. 合成任务 + package.json 无 scripts.test：前置探测 skip（不 spawn）", async () => {
  const projectRoot = createTempProject();
  try {
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "no-tests", scripts: { build: "tsc" } }, null, 2),
      "utf8"
    );
    const verify = await new P5VerifyStageHandler().handle(
      buildStageContext(projectRoot, "verify", {
        synthesizedTask: true,
        testCommand: "npm test",
      })
    );
    assert.equal(verify.kind, "success");
    assert.equal(verify.artifacts["unverified"], true);
    assert.equal(verify.artifacts["reason"], VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET);
    assert.match(String(verify.artifacts["skipDetail"]), /package\.json|scripts\.test/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("V3. 合成任务 + package.json 有 scripts.test 但测试失败：真实 spawn npm test → failed（不允许 skip）", async () => {
  const projectRoot = createTempProject();
  try {
    // scripts.test 为白名单程序 node 构造的真实失败命令（输出 Jest 格式 + exit 1）
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify(
        {
          name: "failing-tests",
          scripts: {
            test: "node -e 'console.log(process.argv[1]);process.exit(1)' 'Tests: 0 passed, 1 failed'",
          },
        },
        null,
        2
      ),
      "utf8"
    );
    const verify = await new P5VerifyStageHandler().handle(
      buildStageContext(projectRoot, "verify", {
        synthesizedTask: true,
        testCommand: "npm test",
        testTimeoutSec: 60,
      })
    );
    assert.equal(verify.kind, "failed", "有真实测试目标且失败时必须 failed，不能降级为 skip");
    assert.notEqual(verify.artifacts["reason"], VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET);
    const stats = verify.artifacts["testStats"] as { readonly failed: number };
    assert.equal(stats.failed, 1);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("V4. 手写任务（非合成）+ 无 package.json + npm test：不降级，真实 spawn 失败 → failed", async () => {
  const projectRoot = createTempProject();
  try {
    assert.ok(!fs.existsSync(path.join(projectRoot, "package.json")));
    const verify = await new P5VerifyStageHandler().handle(
      buildStageContext(projectRoot, "verify", {
        // 不设置 synthesizedTask（手写 tasks.md 路径）
        testCommand: "npm test",
        testTimeoutSec: 60,
      })
    );
    assert.equal(verify.kind, "failed", "手写任务即使无测试目标也必须如实失败，由用户显式配置测试命令");
    assert.notEqual(verify.artifacts["reason"], VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET);
    assert.notEqual(verify.artifacts["unverified"], true);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// 6. orchestrator 编排新语义（5c/5d/P0-5 守卫）
// ============================================================================

test("M1. 两张 pending 卡：逐轮全绿标记 completed，他卡与正文属性保持不变，最终 completed", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 2, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");
    createDeclaredFile(projectRoot, "src/services/Service2.ts");

    // 替身按任务卡回报对应变更文件（仅替 LLM 网络，状态机真实）
    const executor: P5TaskExecutor = {
      async executeTask(input) {
        const file = input.taskId === "T-001" ? "src/services/Service1.ts" : "src/services/Service2.ts";
        return Object.freeze({
          success: true,
          summary: `[test-double] 完成 ${input.taskId}`,
          tokensUsed: 1,
          tokensEstimated: false,
          llmRequests: 1,
          changedFiles: Object.freeze([file]),
        });
      },
    };
    const orchestrator = buildOrchestrator({ taskExecutor: executor });
    const result = await orchestrator.run({
      projectRoot,
      objective: "两张卡逐轮完成",
      maxIterations: 4,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    assert.equal(result.finalStatus, "completed", `应正常收尾：${result.finalReport.slice(0, 300)}`);
    assert.equal(result.exitCode, 0);
    // 两次任务轮各一个 milestone，收尾轮不记 milestone
    assert.equal(result.milestones.length, 2);
    assert.deepEqual([...result.completedLoops], ["coding"]);

    // tasks.md 两张卡均被真实改写为 completed，其余属性行原样保留
    const raw = fs.readFileSync(path.join(projectRoot, ".eag", "p5", "tasks.md"), "utf8");
    const cards = parseTaskCards(raw);
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.equal(card.status, "completed", `${card.id} 应为 completed`);
      assert.equal(card.requirementId.startsWith("F-"), true, `${card.id} 的 requirement 属性不应被破坏`);
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("M2. 全绿但 tasks.md 原子写回失败：本轮判失败、不记 milestone、任务卡保持 pending，最终 aborted", async () => {
  const projectRoot = createTempProject();
  const p5Dir = path.join(projectRoot, ".eag", "p5");
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 故障注入：执行器被真实调用后把 p5 目录置为只读，使 markTaskCompleted 的
    // tmp+rename 原子写回失败（EACCES）。RunState/notes 文件此前已创建，
    // 对【已存在文件】的写入不依赖目录项权限，不受影响。
    const executor: P5TaskExecutor = {
      async executeTask(input) {
        try {
          fs.chmodSync(p5Dir, 0o555);
        } catch {
          // 非 POSIX 或权限受限时忽略；用例断言会如实暴露差异
        }
        return Object.freeze({
          success: true,
          summary: "[test-double] 执行完成但状态目录只读",
          tokensUsed: 1,
          tokensEstimated: false,
          llmRequests: 1,
          changedFiles: Object.freeze(["src/services/Service1.ts"]),
        });
      },
    };
    const orchestrator = buildOrchestrator({
      taskExecutor: executor,
      defaultConsecutiveFailureAbort: 2,
    });
    const result = await orchestrator.run({
      projectRoot,
      objective: "状态写入故障",
      maxIterations: 5,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 每轮全绿但状态写不回 → 连续失败 → aborted（不是 completed，杜绝假完成）
    assert.ok(
      result.finalStatus === "aborted" || result.finalStatus === "failed",
      `写回失败不应 completed，实际：${result.finalStatus}`
    );
    assert.equal(result.milestones.length, 0, "状态未写成绝不允许记录全绿 milestone");
    const raw = fs.readFileSync(path.join(p5Dir, "tasks.md"), "utf8");
    assert.equal(parseTaskCards(raw)[0]!.status, "pending", "任务卡必须保持 pending");
  } finally {
    // 恢复目录权限后再清理（否则 Windows/受限环境 rm 失败）
    try {
      fs.chmodSync(p5Dir, 0o755);
    } catch {
      // 容错
    }
    cleanupTempProject(projectRoot);
  }
});

test("O1. blocked 卡编排收尾：finalStatus=failed/exit1，最终报告含阻塞任务 ID", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "blocked");
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "阻塞任务收尾",
      maxIterations: 2,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.exitCode, 1);
    assert.match(result.finalReport, /T-001/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("O2. 空 objective 在 run() 入口即被拒绝（plan 层 tasks-file-not-found 终局由 P-S2 覆盖）", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    // 生产入参校验：空目标不允许启动自主运行（防止空转），必须显式抛错而非静默 failed/completed
    await assert.rejects(
      () =>
        orchestrator.run({
          projectRoot,
          objective: "  ",
          maxIterations: 2,
          testCommand: PASS_TEST_CMD,
          testTimeoutSec: 10,
        }),
      /objective 必须为非空字符串/
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("O3. dev 执行期间收到 stop（abort 标志文件真实写入）：终态 aborted，5d 不得翻转为 completed/failed", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 替身执行 dev 时通过端口拿到 abortFlagPath 并真实写入（等价用户在长请求期间点击 stop），
    // 同时返回失败结果。下一轮循环顶部必须读到该文件并以 aborted 收尾。
    const executor: P5TaskExecutor = {
      async executeTask(input) {
        fs.mkdirSync(path.dirname(input.abortFlagPath), { recursive: true });
        fs.writeFileSync(input.abortFlagPath, String(Date.now()), "utf8");
        return Object.freeze({
          success: false,
          summary: "",
          tokensUsed: 0,
          tokensEstimated: false,
          llmRequests: 0,
          changedFiles: Object.freeze([]),
          error: "aborted：任务执行被中止信号中断",
        });
      },
    };
    const orchestrator = buildOrchestrator({ taskExecutor: executor });
    const result = await orchestrator.run({
      projectRoot,
      objective: "执行中停止",
      maxIterations: 4,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });
    assert.equal(result.finalStatus, "aborted");
    assert.equal(result.exitCode, 2);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// 7. SessionManager 构造尾部装配（§3.9：真实 LlmTaskExecutor 绑定最后一公里）
// ============================================================================

/**
 * 构造最小可用 SessionManager（沿用 eag-p5-status-stop 测试的 as any 缝合模式）。
 *
 * @param projectRoot 项目根
 * @param autonomousOrchestrator 外挂编排器（真实实例或鸭子对象）
 * @param createLLMClient LLM 工厂覆写（测试缝合点，等价无凭据时返回 null）
 */
function createMinimalSessionManager(
  projectRoot: string,
  autonomousOrchestrator: unknown,
  createLLMClient: () => unknown
): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({ client: null, model: "stub-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "stub-model" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: () => undefined,
    autonomousOrchestrator,
    createLLMClient,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
}

test("BIND-1. SessionManager 构造尾部把真实 LlmTaskExecutor 绑入 orchestrator（绑定实例类型 + 端到端跑通）", async () => {
  const projectRoot = createTempProject("eag-p5-bind-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: "ignore" });

    // 对照：未经 SessionManager 装配的真实 orchestrator，执行器槽位必须为 null（fail-closed 基线）
    const unboundProbe = buildOrchestrator();
    assert.equal(
      (unboundProbe as unknown as { taskExecutor: unknown }).taskExecutor,
      null,
      "基线：未装配的 orchestrator 必须保持 taskExecutor=null"
    );

    // 真实 orchestrator（构造时未绑定执行器），交由 SessionManager 构造尾部完成装配
    const orchestrator = buildOrchestrator();

    // 桩客户端仅替换 HTTP 边界（与 INT-A 同构：write 真实落盘 + 终态，共 2 次请求）
    const mathFileAbs = path.join(projectRoot, "src", "bind-check.js");
    const client = new StubLlmClient([
      {
        content: "写入装配验证文件。",
        toolCalls: [
          {
            name: "write",
            args: {
              file_path: mathFileAbs,
              content: "module.exports = 7;\n",
            },
          },
        ],
      },
      { content: "装配验证文件已写入。" },
    ]);

    // 显式创建 SessionManager（构造副作用：new LlmTaskExecutor + bindTaskExecutor）
    createMinimalSessionManager(projectRoot, orchestrator, () => client);

    // 白盒断言：绑定的是真实 LlmTaskExecutor 实例（而非替身/空转占位）
    const bound = (orchestrator as unknown as { taskExecutor: unknown }).taskExecutor;
    assert.ok(bound instanceof LlmTaskExecutor, "构造尾部必须绑定真实 LlmTaskExecutor 实例");

    // 端到端行为断言：绑定的执行器真实消费桩脚本、write 真实落盘，
    // 无 package.json → verify 诚实 skip(unverified) → 全绿 → T-001 completed → 收尾
    const result = await orchestrator.run({
      projectRoot,
      objective: "写入 bind-check.js 验证 SessionManager 装配",
      maxIterations: 3,
      testCommand: "npm test",
      testTimeoutSec: 30,
    });
    assert.equal(result.finalStatus, "completed", `装配后应端到端跑通：\n${result.finalReport}`);
    assert.equal(client.requestCount, 2, "绑定执行器必须真实发起 2 次 LLM 请求");
    assert.ok(fs.existsSync(mathFileAbs), "write 工具必须在项目牢笼内真实落盘");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("BIND-1b. 无 API 凭据（LLM 工厂返回 null）：绑定的执行器首轮 fail-closed，dev 不再是 task-executor-not-bound", async () => {
  const projectRoot = createTempProject("eag-p5-bind-nokey-");
  try {
    const orchestrator = buildOrchestrator();
    createMinimalSessionManager(projectRoot, orchestrator, () => null);

    const bound = (orchestrator as unknown as { taskExecutor: unknown }).taskExecutor;
    assert.ok(bound instanceof LlmTaskExecutor);

    const result = await orchestrator.run({
      projectRoot,
      objective: "验证无凭据时执行器 fail-closed",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });
    // 终态 failed（执行器零请求失败），且失败来自执行器而非"未绑定"——
    // notes.md 是每轮四阶段结果的真实持久化产物，读取本轮 notes 文本归因
    assert.equal(result.finalStatus, "failed");
    const notesDir = path.join(projectRoot, ".eag", "p5", "notes");
    const noteFiles = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((f) => f.endsWith(".md")) : [];
    assert.equal(noteFiles.length, 1, "run 必须真实落盘 1 份 notes");
    const notesText = fs.readFileSync(path.join(notesDir, noteFiles[0]!), "utf8");
    assert.match(notesText, /未配置 API 凭据|LLM 客户端不可用/, "notes 必须记录执行器 fail-closed 的真实原因");
    assert.doesNotMatch(notesText, /task-executor-not-bound/, "装配后不得再出现未绑定原因");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("BIND-2. 鸭子检测：外挂 orchestrator 无 bindTaskExecutor 方法（F9-v2 recording 形态）时构造不报错、不绑定", () => {
  const projectRoot = createTempProject();
  try {
    // 仅记录被调用情况的鸭子对象：没有 bindTaskExecutor 方法
    const recordingOrchestrator = {
      runCalls: 0,
      run(): void {
        this.runCalls += 1;
      },
    };
    // 构造必须平稳完成（鸭子检测跳过绑定），不得因缺方法抛 TypeError
    const manager = createMinimalSessionManager(projectRoot, recordingOrchestrator, () => null);
    assert.ok(manager instanceof SessionManager);
    assert.equal(recordingOrchestrator.runCalls, 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});
