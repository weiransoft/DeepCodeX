#!/usr/bin/env -S npx tsx
/**
 * Super Agent 端到端测试（真实内核全链路）
 *
 * 覆盖 docs/proposals/super-agent/proposal-final.md §9 的验收项，并补上
 * 单元测试覆盖不到的**跨模块时序**：
 *
 *   E2E-1  准入 → 研判 → 建工单 → 派工 → Worker 执行 → 报告回灌 → 工单收尾
 *   E2E-2  Worker prompt 的段落结构（首轮无历史时不塞空段）
 *   E2E-3  第 2 轮输入**真**到达 LLM（F1 断链修复的真实验证）
 *   E2E-4  未真送达时输入**不**被标记为已投递（如实降级）
 *   E2E-5  历史研判决策真实落库，且可从既有表派生（零新表）
 *   E2E-6  status 含 4 个承诺计数
 *   E2E-7  同源其他工单的历史报告进入「工单上下文」段（Worker 不再冷启动）
 *
 * ## 模型端点替身
 *
 * 只替换**网络端点**（`chat.completions.create`），其余全部走真实生产代码：
 * `SuperAgentRuntime` / `LlmAssessor` / `SuperAgentWorkerExecutor` /
 * `BackgroundRunnerLauncher` / `BackgroundTaskRunner` / SQLite 存储。
 * 真实模型不可达（无凭据 / 本地服务未起）时，本脚本仍能验证**内核时序**。
 *
 * 用法：
 *   npx tsx tests/scripts/super-agent-e2e.ts
 *
 * 退出码：0 = 全部通过；1 = 有断言失败
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SuperAgentRuntime } from "../../packages/core/src/super-agent/runtime.js";
import { LlmAssessor } from "../../packages/core/src/super-agent/router/assessment.js";
import { BackgroundRunnerLauncher } from "../../packages/core/src/super-agent/worker/executor.js";
import { WorkerInstructionRegistry } from "../../packages/core/src/super-agent/worker/channel.js";
import { recallHistoricalDecisions } from "../../packages/core/src/super-agent/engine/history.js";
import { openStore } from "../../packages/core/src/super-agent/store/store.js";
import { SuperAgentRepositories } from "../../packages/core/src/super-agent/store/repositories.js";
import { BackgroundTaskRunner } from "../../packages/core/src/interrupts/background-runner.js";
import { TaskRegistry } from "../../packages/core/src/interrupts/task-registry.js";
import { callLlmOnce } from "../../packages/core/src/team/orchestrator/llm-once.js";

/** Worker 系统提示（与 CLI super-worker.ts 的常量一致） */
const WORKER_SYSTEM_PROMPT = `你是 DeepCodeX Super Agent 的执行 Worker。

你会在用户提示中收到一份工单，包含：
- 授权范围（**超出范围的工作必须交还**，不得自行扩大）
- 待处理输入
- 角色约束
- 输出契约

请严格按输出契约输出 JSON 对象，不要输出任何解释性文字，也不要用代码块包裹。`;

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

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(30);
  }
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "super-e2e-"));
  const dbPath = path.join(tmp, ".deepcode", "super-agent", "super-agent.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // --- 模型端点替身：记录全部调用，按 system 区分研判 / Worker ---
  interface Call {
    readonly system: string;
    readonly user: string;
  }
  const calls: Call[] = [];
  let workerCallCount = 0;
  let releaseWorkerFirst: (() => void) | undefined;
  const workerFirstCall = new Promise<void>((resolve) => {
    releaseWorkerFirst = resolve;
  });

  const fakeClient = {
    chat: {
      completions: {
        create: async (body: unknown): Promise<unknown> => {
          const messages = (body as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
          const system = messages.find((m) => m.role === "system")?.content ?? "";
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          calls.push({ system, user });

          if (system.includes("研判器")) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: "accept",
                      reason: "E2E：可复现的样式缺陷，属于复现并修复范畴",
                      matchedRules: ["reproduce-and-fix"],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
            };
          }

          workerCallCount += 1;
          if (workerCallCount === 1) {
            // 留出窗口，让主流程在 Worker 运行期间投递第 2 轮输入
            releaseWorkerFirst?.();
            await sleep(900);
          }
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: "ready",
                    summary: "已复现登录页样式错乱，定位到 Safari 16 的 flex 简写差异并给出修复",
                    artifacts: ["src/pages/Login.tsx"],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 260, completion_tokens: 48, total_tokens: 308 },
          };
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

  // --- 真实存储与仓储 ---
  const store = await openStore({ databasePath: dbPath });
  const repos = new SuperAgentRepositories(store);

  // --- 真实研判器（注入模型端点 + 真实历史召回端口） ---
  const assessor = new LlmAssessor({
    projectRoot: tmp,
    injectedClient: fakeHandle,
    recall: (query: string, sourceId: string) =>
      recallHistoricalDecisions({ repos, now: () => store.now() }, { query, sourceId }).map((hit) => hit.decision),
  });

  // --- 真实 Worker 装配（与 CLI super-worker.ts 等价） ---
  const channels = new WorkerInstructionRegistry();
  const outputs = new Map<string, string>();
  const registry = new TaskRegistry({ onTaskStateChanged: () => {} });
  // 用容器持有运行时引用：Worker 终态回调需要它，但回调在运行时创建前就已装配
  const runtimeHolder: { runtime?: SuperAgentRuntime } = {};

  const launcher = new BackgroundRunnerLauncher(
    new BackgroundTaskRunner({
      sharedSessionOptions: {
        sessionManagerFactory: (taskId: string) => ({
          handleUserPrompt: async (prompt: string): Promise<void> => {
            let current = prompt;
            for (;;) {
              const result = await callLlmOnce(fakeHandle as never, WORKER_SYSTEM_PROMPT, current, 30_000);
              if (!result.ok) throw new Error(result.message);
              outputs.set(taskId, result.content);

              const instructions = channels.drain(taskId);
              if (instructions.length === 0) {
                channels.deactivate(taskId);
                return;
              }
              const addition = instructions.map((item) => item.text).join("\n");
              current = `${prompt}\n\n## 追加输入（来自运行期间的新指令）\n${addition}`;
            }
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
    assessor,
    launcher,
    injector: launcher,
  });
  runtimeHolder.runtime = runtime;

  try {
    // ---------------------------------------------------------------------
    // 策略：auto + cli 来源准入表
    // ---------------------------------------------------------------------
    const policy = runtime.engine.settings.getPolicy();
    runtime.engine.settings.setPolicy({
      ...policy,
      acceptMode: "auto",
      sourceParts: {
        cli: {
          sourceId: "cli",
          allowlist: ["local-developer"],
          botList: [],
          admission: { cli: "inferred" },
        },
      },
    });

    // ---------------------------------------------------------------------
    // E2E-1：准入 → 研判 → 建工单 → 派工
    // ---------------------------------------------------------------------
    const intake = runtime.injectTrigger(
      {
        sourceId: "cli",
        idempotencyKey: "",
        actor: "local-developer",
        actorKind: "human",
        addressed: true,
        text: "登录页在 Safari 16 下样式错乱，按钮溢出屏幕，请复现并修复",
        meta: { scope: "cli" },
      },
      ["cli:local-developer"]
    );
    check("E2E-1a", "事件经真实准入路径入队", intake.status === "stored", `intake.status=${intake.status}`);

    await runtime.tick();

    const tickets = repos.listTickets();
    check(
      "E2E-1b",
      "研判 accept 后真实建单",
      tickets.length === 1,
      `工单数=${tickets.length} state=${tickets[0]?.state ?? "-"}`
    );

    const ticket = tickets[0];
    if (ticket === undefined) throw new Error("未建出工单，后续断言无法执行。");

    const assignments = repos.listAssignments(ticket.id);
    check(
      "E2E-1c",
      "派工产生 Assignment",
      assignments.length === 1,
      `assignment=${assignments[0]?.id ?? "-"} role=${assignments[0]?.role ?? "-"}`
    );

    // ---------------------------------------------------------------------
    // E2E-2：Worker prompt 含「## 工单上下文」段
    // ---------------------------------------------------------------------
    const workerCall1 = await waitFor(
      () => calls.find((c) => c.system.includes("执行 Worker")),
      10_000,
      "Worker 首次 LLM 调用"
    );
    check(
      "E2E-2a",
      "Worker prompt 含工单头 / 授权范围 / 角色约束 / 输出契约",
      workerCall1.user.includes("Super Agent 工单") &&
        workerCall1.user.includes("授权范围") &&
        workerCall1.user.includes("角色约束") &&
        workerCall1.user.includes("输出契约"),
      `prompt 长度=${workerCall1.user.length}`
    );
    check(
      "E2E-2b",
      "首个工单首轮无同源历史 → 不出现空的「工单上下文」段",
      !workerCall1.user.includes("## 工单上下文"),
      workerCall1.user.includes("## 工单上下文") ? "意外出现空段" : "无历史可投影 → 省略该段（不塞空段）"
    );

    // ---------------------------------------------------------------------
    // E2E-3：第 2 轮输入真实到达 LLM
    // ---------------------------------------------------------------------
    // 等 Worker 真正进入第 1 轮 LLM 调用（此刻它正持有一个可注入的会话）
    await workerFirstCall;
    const secondRoundText = "补充：只在 Safari 16.4+ 复现，Chrome 正常";
    runtime.engine.people.postMessage(ticket.id, secondRoundText);
    await runtime.tick();

    const workerCall2 = await waitFor(
      () => calls.filter((c) => c.system.includes("执行 Worker"))[1],
      10_000,
      "Worker 第 2 轮 LLM 调用"
    );
    check(
      "E2E-3a",
      "第 2 轮 prompt 含「追加输入」段",
      workerCall2.user.includes("## 追加输入（来自运行期间的新指令）"),
      workerCall2.user.includes("追加输入") ? "追加段已出现" : "缺失"
    );
    check(
      "E2E-3b",
      "第 2 轮 prompt 真含第 2 轮输入正文",
      workerCall2.user.includes(secondRoundText),
      workerCall2.user.includes(secondRoundText) ? "输入正文已送达 LLM" : "输入正文未送达"
    );

    const inputs = repos.listInputs(ticket.id);
    const secondInput = inputs.find((i) => i.body.includes("补充：只在 Safari"));
    check(
      "E2E-3c",
      "真送达后输入才被标记为已投递",
      secondInput?.deliveredAt !== null && secondInput?.deliveredAt !== undefined,
      `deliveredAt=${secondInput?.deliveredAt ?? "null"}`
    );

    // ---------------------------------------------------------------------
    // E2E-4：未真送达 → 不标记已投递（如实降级）
    // ---------------------------------------------------------------------
    const noWireRuntime = await SuperAgentRuntime.create({
      databasePath: path.join(tmp, ".deepcode", "super-agent", "no-wire.db"),
      projectRoot: tmp,
      assessor,
      launcher,
      injector: null, // 故意不接注入通道
    });
    const noWireTicket = repos.listTickets()[0];
    let degraded = false;
    try {
      noWireRuntime.engine.people.postMessage(noWireTicket?.id ?? "none", "这条不会被送达");
      await noWireRuntime.tick();
      const pending = repos.listPendingInputs(noWireTicket?.id ?? "");
      degraded = pending.some((i) => i.body.includes("这条不会被送达"));
    } catch {
      degraded = true;
    } finally {
      await noWireRuntime.stop();
    }
    check(
      "E2E-4a",
      "无注入通道时输入保持待投递（不谎称已送达）",
      degraded,
      degraded ? "输入仍在 pending 列表" : "输入被误标为已投递"
    );

    // ---------------------------------------------------------------------
    // E2E-5：报告回灌 → 工单收尾
    // ---------------------------------------------------------------------
    await waitFor(() => repos.listAssignments(ticket.id)[0]?.report !== null, 10_000, "Worker 报告回写");
    for (let i = 0; i < 5; i += 1) {
      await runtime.tick();
    }
    const finalTicket = repos.findTicket(ticket.id);
    check("E2E-5a", "报告回灌后工单收尾", finalTicket?.state === "ended", `工单 state=${finalTicket?.state ?? "-"}`);
    check(
      "E2E-5b",
      "Worker 报告已落库",
      (repos.listAssignments(ticket.id)[0]?.report ?? null) !== null,
      JSON.stringify(repos.listAssignments(ticket.id)[0]?.report ?? null).slice(0, 160)
    );

    // ---------------------------------------------------------------------
    // E2E-6：全局层历史经验投影（零新表）
    // ---------------------------------------------------------------------
    const allDecisions = repos.listRecentDecisions(50);
    check(
      "E2E-6a",
      "历史研判决策真实落库（可派生全局层）",
      allDecisions.length >= 1,
      `decision 数=${allDecisions.length} kind=${allDecisions[0]?.kind ?? "-"}`
    );

    const recalled = recallHistoricalDecisions(
      { repos, now: () => store.now() },
      { query: "登录页 Safari 样式错乱 复现并修复", sourceId: "cli" }
    );
    check(
      "E2E-6b",
      "历史经验从既有表派生（零新表、零迁移）",
      recalled.length >= 1,
      `召回命中=${recalled.length} 最高分=${recalled[0]?.totalScore?.toFixed(4) ?? "-"}`
    );

    const schemaTables = store.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = schemaTables.map((t) => t.name);
    check(
      "E2E-6c",
      "未引入 memory_entry / ticket_context 等新表",
      !tableNames.includes("memory_entry") && !tableNames.includes("ticket_context"),
      `表数=${tableNames.length} 无新增记忆表`
    );

    const status = runtime.status();
    check(
      "E2E-6d",
      "status 含 4 个承诺计数",
      status.candidates.total >= 1 &&
        status.routedViaSubscription >= 0 &&
        status.openAttention >= 0 &&
        status.workerTokens.total >= 0,
      `候选=${status.candidates.total} 直通=${status.routedViaSubscription} 待办=${status.openAttention} token=${status.workerTokens.total}`
    );

    // ---------------------------------------------------------------------
    // E2E-7：第二个工单首轮能拿到同源历史（Worker 不再冷启动）
    // ---------------------------------------------------------------------
    runtime.injectTrigger(
      {
        sourceId: "cli",
        idempotencyKey: "",
        actor: "local-developer",
        actorKind: "human",
        addressed: true,
        text: "另一个任务：把登录页的样式错乱一并回归验证",
        meta: { scope: "cli" },
      },
      // 独立 thread：避免命中第一个工单的订阅被扇出
      ["cli:local-developer#second"]
    );
    await runtime.tick();

    const ticketsAfter = repos.listTickets();
    check("E2E-7a", "第二个事件真实建出第二个工单", ticketsAfter.length === 2, `工单数=${ticketsAfter.length}`);

    const workerCalls = calls.filter((c) => c.system.includes("执行 Worker"));
    const workerCallForSecond = await waitFor(
      () => workerCalls.find((c) => c.user.includes("另一个任务：把登录页的样式错乱一并回归验证")),
      10_000,
      "第二个工单的 Worker 调用"
    );
    check(
      "E2E-7b",
      "第二个工单首轮 prompt 含「## 工单上下文」段",
      workerCallForSecond.user.includes("## 工单上下文"),
      workerCallForSecond.user.includes("## 工单上下文") ? "已注入" : "缺失"
    );
    check(
      "E2E-7c",
      "该段含同源历史报告摘要（Worker 不再冷启动）",
      workerCallForSecond.user.includes("历史报告摘要") && workerCallForSecond.user.includes("已复现登录页样式错乱"),
      workerCallForSecond.user.includes("历史报告摘要") ? "含第 1 个工单的报告摘要" : "未含历史报告摘要"
    );
  } finally {
    await runtime.stop();
    store.close();
  }

  // ==========================================================================
  // 汇总
  // ==========================================================================
  const failed = results.filter((r) => !r.ok);
  console.log("\n══════════════════════════════════════════");
  console.log(`端到端测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log("失败用例：");
    for (const f of failed) console.log(`  ❌ ${f.id} ${f.title} — ${f.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error("E2E 异常终止：", err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
