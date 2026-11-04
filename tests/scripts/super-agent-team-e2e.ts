#!/usr/bin/env -S npx tsx
/**
 * Super Agent「司南」团队协作端到端测试
 *
 * ## 验的是什么
 *
 * 单元测试覆盖模块内行为；本脚本验证**跨模块时序**：
 *
 * ```
 *   事件 → 准入 → 研判 → 动态分解（计划）→ 建单
 *        → 首波派工（按步骤角色）
 *        → Worker 执行 → 报告回灌
 *        → 推进下一波（同层并行，带上游交接）
 *        → 全部完成 → 工单收尾
 * ```
 *
 * ## 模型端点替身（只替换网络层）
 *
 * `chat.completions.create` 被替换为按**系统提示**分流的桩：
 * - 含「研判器」→ 返回 accept；
 * - 含「拆成可执行的工作流」→ 返回三步计划 JSON；
 * - 其余（Worker）→ 按提示里的步骤标题返回 ready 报告。
 *
 * 其余全部走真实生产代码：`SuperAgentRuntime` / `LlmAssessor` /
 * `LlmWorkflowPlanner` / `SuperAgentWorkerExecutor` / `BackgroundRunnerLauncher` /
 * `BackgroundTaskRunner` / SQLite 存储。
 *
 * 用法：
 *   npx tsx tests/scripts/super-agent-team-e2e.ts
 *
 * 退出码：0 = 全部通过；1 = 有断言失败
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SuperAgentRuntime } from "../../packages/core/src/super-agent/runtime.js";
import { LlmAssessor } from "../../packages/core/src/super-agent/router/assessment.js";
import { LlmWorkflowPlanner } from "../../packages/core/src/super-agent/planner/planner.js";
import { BackgroundRunnerLauncher } from "../../packages/core/src/super-agent/worker/executor.js";
import { WorkerInstructionRegistry } from "../../packages/core/src/super-agent/worker/channel.js";
import { BackgroundTaskRunner } from "../../packages/core/src/interrupts/background-runner.js";
import { TaskRegistry } from "../../packages/core/src/interrupts/task-registry.js";
import { callLlmOnce } from "../../packages/core/src/team/orchestrator/llm-once.js";

/** Worker 系统提示（与 CLI super-worker.ts 的常量口径一致） */
const WORKER_SYSTEM_PROMPT = `你是 DeepCodeX 常驻主理智能体「司南」派出的执行 Worker。

你会在用户提示中收到一份工单，包含：任务目标与你的步骤、团队分工与上游交接、
授权范围、待处理输入、角色约束、输出契约。

请严格按输出契约输出 JSON 对象。`;

/** 三步计划（桩返回的 JSON） */
const PLAN_JSON = JSON.stringify({
  version: 1,
  objective: "修复登录崩溃并补回归测试",
  strategy: "先定位根因，再并行修复与补测试",
  steps: [
    { id: "s1", title: "定位崩溃点", role: "architect", dependsOn: [], deliverable: "崩溃根因说明" },
    { id: "s2", title: "修复实现", role: "solo-coder", dependsOn: ["s1"], deliverable: "修复补丁" },
    { id: "s3", title: "补回归测试", role: "test-expert", dependsOn: ["s1"], deliverable: "回归测试用例" },
  ],
});

// ============================================================================
// 断言工具
// ============================================================================

interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: CaseResult[] = [];

function check(id: string, title: string, ok: boolean, detail: string): void {
  results.push({ id, title, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${id} ${title}`);
  console.log(`   ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "super-team-e2e-"));
  const dbPath = path.join(tmp, ".deepcode", "super-agent", "super-agent.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  /** 记录 Worker 收到的提示词（按到达顺序） */
  const workerPrompts: string[] = [];

  const fakeClient = {
    chat: {
      completions: {
        create: async (body: unknown): Promise<unknown> => {
          const messages = (body as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
          const system = messages.find((m) => m.role === "system")?.content ?? "";
          const user = messages.find((m) => m.role === "user")?.content ?? "";

          if (system.includes("研判器")) {
            return response(JSON.stringify({ kind: "accept", reason: "E2E：具体可执行的修复请求", matchedRules: [] }));
          }
          if (system.includes("拆成可执行的工作流")) {
            return response(PLAN_JSON);
          }

          // Worker：按「你的步骤」标题产出对应摘要
          workerPrompts.push(user);
          // 模拟真实模型调用延迟：桩若瞬时返回，可能在「派工映射登记」前就完成，
          // 属于测试桩的时序假象（真实 LLM 调用以秒计）。40ms 足以让映射先落地。
          await sleep(40);
          const title = /## 你的步骤（第 \d+\/\d+ 步）\n(.+)/.exec(user)?.[1]?.trim() ?? "未知步骤";
          return response(
            JSON.stringify({
              kind: "ready",
              summary: `已完成：${title}`,
              artifacts: [`artifact-${workerPrompts.length}.md`],
            })
          );
        },
      },
    },
  };

  const fakeHandle = {
    client: fakeClient,
    model: "e2e-stub-model",
    baseURL: "http://local.stub/v1",
    thinkingEnabled: false,
  };

  // --- 真实 Worker 装配（与 CLI super-worker.ts 等价） ---
  const channels = new WorkerInstructionRegistry();
  const outputs = new Map<string, string>();
  const registry = new TaskRegistry({ onTaskStateChanged: () => {} });
  const runtimeHolder: { runtime?: SuperAgentRuntime } = {};

  const launcher = new BackgroundRunnerLauncher(
    new BackgroundTaskRunner({
      sharedSessionOptions: {
        sessionManagerFactory: (taskId: string) => ({
          handleUserPrompt: async (prompt: string): Promise<void> => {
            const result = await callLlmOnce(fakeHandle as never, WORKER_SYSTEM_PROMPT, prompt, 30_000);
            if (!result.ok) throw new Error(result.message);
            outputs.set(taskId, result.content);
            channels.deactivate(taskId);
          },
        }),
      },
      registry,
      onInject: (task, instruction) => {
        channels.push(task.id, instruction);
      },
      onTaskComplete: (task) => {
        const assignmentId = launcher.assignmentOf(task.id);
        if (assignmentId === undefined) return;
        launcher.forget(task.id);
        channels.deactivate(task.id);
        channels.forget(task.id);
        const output = outputs.get(task.id);
        outputs.delete(task.id);
        runtimeHolder.runtime?.notifyWorkerComplete(assignmentId, output ?? task.result, task.error);
      },
    })
  );

  const runtime = await SuperAgentRuntime.create({
    databasePath: dbPath,
    projectRoot: tmp,
    assessor: new LlmAssessor({ projectRoot: tmp, injectedClient: fakeHandle }),
    planner: new LlmWorkflowPlanner({ projectRoot: tmp, injectedClient: fakeHandle }),
    launcher,
    injector: launcher,
  });
  runtimeHolder.runtime = runtime;

  try {
    const policy = runtime.engine.settings.getPolicy();
    runtime.engine.settings.setPolicy({
      ...policy,
      acceptMode: "auto",
      sourceParts: {
        cli: { sourceId: "cli", allowlist: ["local-developer"], botList: [], admission: { cli: "inferred" } },
      },
    });

    // ------------------------------------------------------------------
    // E2E-1：接单 + 动态分解落库
    // ------------------------------------------------------------------
    runtime.injectTrigger(
      {
        sourceId: "cli",
        idempotencyKey: "",
        actor: "local-developer",
        actorKind: "human",
        addressed: true,
        text: "登录页在 Safari 16 下崩溃，请定位并修复，同时补回归测试",
        meta: { scope: "cli" },
      },
      ["cli:local-developer"]
    );
    // 驱动调度，直到工单收尾（或超时）
    const deadline = Date.now() + 20_000;
    for (;;) {
      await runtime.tick();
      const tickets = runtime.repos.listTickets();
      if (tickets.length === 1 && tickets[0]?.state === "ended") break;
      if (Date.now() > deadline) break;
      await sleep(25);
    }

    const tickets = runtime.repos.listTickets();
    const ticket = tickets[0];
    const ticketId = ticket?.id ?? "";
    const plan = runtime.repos.findPlan(ticketId);
    const steps = runtime.repos.listPlanSteps(ticketId);

    check(
      "TEAM-1a",
      "研判 accept 后真实建单",
      tickets.length === 1 && ticket?.state === "ended",
      `工单数=${tickets.length} state=${ticket?.state ?? "-"}`
    );
    check(
      "TEAM-1b",
      "计划由真实计划器生成并落库（3 步 / 3 角色）",
      plan !== undefined && plan.steps.length === 3 && plan.team.length === 3 && plan.source === "llm",
      `steps=${plan?.steps.length ?? 0} team=${plan?.team.length ?? 0} source=${plan?.source ?? "-"}`
    );
    check(
      "TEAM-1c",
      "三步骤全部就绪，Assignment 数与步骤数一致",
      steps.length === 3 &&
        steps.every((step) => step.state === "ready") &&
        runtime.repos.listAssignments(ticketId).length === 3,
      steps.map((step) => `${step.stepId}:${step.state}`).join(" ") +
        ` assignments=${runtime.repos.listAssignments(ticketId).length}`
    );
    check(
      "TEAM-1d",
      "工单以「已完成（3 步）」收尾",
      /已完成（3 步）/.test(ticket?.endedReason ?? ""),
      `endedReason=${ticket?.endedReason ?? "-"}`
    );

    // ------------------------------------------------------------------
    // E2E-2：按步骤角色派工 + 上游交接
    // ------------------------------------------------------------------
    const first = workerPrompts[0] ?? "";
    const architects = workerPrompts.filter((prompt) => /## 你的步骤（第 1\/3 步）/.test(prompt));
    check(
      "TEAM-2a",
      "首个 Worker 提示词含目标 / 步骤 / 团队",
      /## 任务目标/.test(first) && /## 你的步骤（第 1\/3 步）/.test(first) && /## 团队/.test(first),
      `首条提示词长度=${first.length}`
    );
    check(
      "TEAM-2b",
      "首波按步骤角色执行（架构师）",
      architects.length > 0 && /角色：architect/.test(architects[0] ?? ""),
      `首波提示词数=${architects.length}`
    );

    const downstream = workerPrompts.filter((prompt) =>
      /## 你的步骤（第 2\/3 步）|## 你的步骤（第 3\/3 步）/.test(prompt)
    );
    check(
      "TEAM-2c",
      "第二波并行派工两步，且各自带上游交接",
      downstream.length === 2 && downstream.every((prompt) => /## 上游交接[\s\S]*定位崩溃点/.test(prompt)),
      `第二波提示词数=${downstream.length}`
    );
    check(
      "TEAM-2d",
      "第二波角色分别为实现与测试",
      downstream.some((prompt) => /角色：solo-coder/.test(prompt)) &&
        downstream.some((prompt) => /角色：test-expert/.test(prompt)),
      downstream.map((prompt) => /角色：(\S+)/.exec(prompt)?.[1] ?? "?").join("、")
    );

    // ------------------------------------------------------------------
    // E2E-3：可观测性
    // ------------------------------------------------------------------
    const status = runtime.status();
    check(
      "TEAM-3a",
      "status 暴露计划与步骤进度",
      status.plans.total === 1 && status.plans.completedSteps === 3 && status.plans.runningSteps === 0,
      `plans=${status.plans.total} ready=${status.plans.completedSteps} running=${status.plans.runningSteps}`
    );
    check(
      "TEAM-3b",
      "计划器能力被如实标记为可用（注入了真实端点桩）",
      status.plannerAvailable === true,
      `plannerAvailable=${status.plannerAvailable}`
    );
    check(
      "TEAM-3c",
      "工单详情携带计划与团队（super plan 的数据来源）",
      runtime.engine.people.getTicket(ticketId).plan?.team.length === 3,
      `team=${runtime.engine.people.getTicket(ticketId).plan?.team.length ?? 0}`
    );
  } finally {
    await runtime.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const failure of failed) console.log(`  ❌ ${failure.id} ${failure.title}：${failure.detail}`);
    process.exit(1);
  }
}

/**
 * 构造 OpenAI 兼容响应
 *
 * @param content 文本内容
 * @returns 响应体
 */
function response(content: string): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

main().catch((error: unknown) => {
  console.error("E2E 执行失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
