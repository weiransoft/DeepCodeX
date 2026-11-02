/**
 * 编排主流程单测（L2 验收 O5~O9）
 *
 * 全部使用 stub LLM 句柄 + stub runner，不触网、不读真实工作区。
 * projectRoot 一律指向系统临时目录，避免在仓库里留下 `.deepcode/team-runs/`。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { OpenAIClientHandle } from "../common/openai-client.js";
import { orchestrate, type OrchestrationProgressEvent } from "../team/orchestrator/index.js";
import type { DispatchRunner, DispatchRunnerContext } from "../team/team-adapter.js";

/** 建一个临时项目根（清理交给系统 /tmp 机制，测试之间互不干扰） */
function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-orchestrator-"));
}

/**
 * stub LLM：按调用顺序返回预设文本；用尽后重复最后一条
 *
 * @returns handle 与调用计数器（用于断言"dry-run 不调执行器"这类行为）
 */
function createStubHandle(responses: ReadonlyArray<string>): {
  handle: OpenAIClientHandle;
  calls: () => number;
} {
  let index = 0;
  const handle: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async () => {
            const content = responses[Math.min(index, responses.length - 1)] ?? "";
            index += 1;
            return { choices: [{ message: { content }, finish_reason: "stop" }] };
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "http://localhost:0",
    thinkingEnabled: false,
  };
  return { handle, calls: () => index };
}

/** 拆解结果 JSON（2 个子任务，t2 依赖 t1） */
const PLAN_TWO_SUBTASKS = JSON.stringify({
  rationale: "先设计再实现",
  subtasks: [
    {
      id: "t1",
      title: "设计接口",
      description: "定义导出函数签名",
      roleHint: "architect",
      dependsOn: [],
      files: ["src/export.ts"],
    },
    {
      id: "t2",
      title: "实现导出",
      description: "按接口实现导出逻辑",
      dependsOn: ["t1"],
      files: ["src/export.ts"],
    },
  ],
});

/** 正常 runner：记录被调用的子任务 */
function createStubRunner(
  behavior: (ctx: DispatchRunnerContext) => { ok: boolean; rounds?: number } = () => ({ ok: true })
): { runner: DispatchRunner; contexts: DispatchRunnerContext[] } {
  const contexts: DispatchRunnerContext[] = [];
  const runner: DispatchRunner = async (ctx) => {
    contexts.push(ctx);
    const outcome = behavior(ctx);
    if (!outcome.ok) {
      throw new Error(`stub runner 失败: ${ctx.roleName}`);
    }
    return {
      text: `【${ctx.roleName}】已完成：${ctx.task.slice(0, 40)}`,
      toolCalls: [{ tool: "Write", ok: true }],
      rounds: outcome.rounds ?? 2,
      endReason: "completed",
    };
  };
  return { runner, contexts };
}

// ============================================================================
// O5：依赖失败传播
// ============================================================================

test("O5：依赖失败的子任务 → 后继 skipped 并带 blockedBy，同层兄弟不受影响", async () => {
  const projectRoot = createTempProject();
  const plan = JSON.stringify({
    rationale: "t2 依赖 t1，t3 独立",
    subtasks: [
      { id: "t1", title: "设计", description: "设计接口", dependsOn: [] },
      { id: "t2", title: "实现", description: "实现接口", dependsOn: ["t1"] },
      { id: "t3", title: "文档", description: "写使用文档", dependsOn: [] },
    ],
  });

  const { handle } = createStubHandle([plan, "聚合报告"]);
  // 让第一个子任务失败（按调用顺序，t1 一定先跑——它是第 0 层唯一节点）
  const { runner } = createStubRunner((ctx) => (ctx.task.includes("设计接口") ? { ok: false } : { ok: true }));

  const result = await orchestrate({
    goal: "实现导出功能",
    projectRoot,
    budget: { maxParallel: 1 },
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  const byId = new Map(result.subtasks.map((s) => [s.id, s]));
  assert.equal(byId.get("t1")?.status, "failed");
  assert.equal(byId.get("t2")?.status, "skipped");
  assert.deepEqual(byId.get("t2")?.blockedBy, ["t1"]);
  assert.equal(byId.get("t3")?.status, "succeeded", "无依赖的兄弟必须继续执行");
  assert.equal(result.endReason, "error");
});

// ============================================================================
// O6：全局预算
// ============================================================================

test("O6：totalToolRounds 扣完后剩余子任务 skipped，不超发", async () => {
  const projectRoot = createTempProject();
  const plan = JSON.stringify({
    subtasks: [
      { id: "t1", title: "任务一", description: "做第一件事", dependsOn: [] },
      { id: "t2", title: "任务二", description: "做第二件事", dependsOn: [] },
      { id: "t3", title: "任务三", description: "做第三件事", dependsOn: [] },
    ],
  });

  const { handle } = createStubHandle([plan, "聚合"]);
  const { runner, contexts } = createStubRunner(() => ({ ok: true, rounds: 2 }));

  const result = await orchestrate({
    goal: "三件独立的事",
    projectRoot,
    // 串行 + 全局 3 轮：t1 消耗 2 → 剩 1；t2 消耗 2 → 剩 -1；t3 开不了
    budget: { maxParallel: 1, totalToolRounds: 3 },
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  const statuses = result.subtasks.map((s) => `${s.id}:${s.status}`);
  assert.deepEqual(statuses, ["t1:succeeded", "t2:succeeded", "t3:skipped"]);
  assert.match(result.subtasks[2]!.error ?? "", /预算/);
  assert.equal(contexts.length, 2, "预算耗尽后不得再调用执行器");
  assert.equal(result.budget.usedToolRounds, 4);
});

test("O6b：并发下预算预扣生效——不会两个子任务同时通过检查后超发", async () => {
  const projectRoot = createTempProject();
  const plan = JSON.stringify({
    subtasks: [
      { id: "t1", title: "任务一", description: "第一件事", dependsOn: [] },
      { id: "t2", title: "任务二", description: "第二件事", dependsOn: [] },
      { id: "t3", title: "任务三", description: "第三件事", dependsOn: [] },
    ],
  });
  const { handle } = createStubHandle([plan, "聚合"]);
  const { runner, contexts } = createStubRunner(() => ({ ok: true, rounds: 2 }));

  const result = await orchestrate({
    goal: "三件独立的事",
    projectRoot,
    // 并发 2、单任务上限 4、全局 4：t1 预扣 4 → 剩余 0 → t2/t3 开不了。
    // 若"检查与扣减"跨 await（旧实现），t1/t2 会同时通过检查，实际超发到 4 轮以上。
    budget: { maxParallel: 2, maxToolRounds: 4, totalToolRounds: 4 },
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  const succeeded = result.subtasks.filter((s) => s.status === "succeeded");
  assert.equal(succeeded.length, 1, "全局预算 4 只够一个子任务，不得并发超发");
  assert.equal(contexts.length, 1);
  assert.equal(result.subtasks.filter((s) => s.status === "skipped").length, 2);
  // 实际用量 = 2（t1 真实轮次），预扣的 4 中未用的 2 应已退还（不影响断言结果，
  // 但保证后续层若存在还能继续跑）
  assert.equal(result.budget.usedToolRounds, 2);
});

// ============================================================================
// O7：聚合降级
// ============================================================================

test("O7：聚合 LLM 抛错 → 报告仍生成，aggregated=false", async () => {
  const projectRoot = createTempProject();
  let call = 0;
  const handle: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async () => {
            call += 1;
            if (call === 1) {
              return { choices: [{ message: { content: PLAN_TWO_SUBTASKS }, finish_reason: "stop" }] };
            }
            throw new Error("聚合服务 503");
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "http://localhost:0",
    thinkingEnabled: false,
  };

  const { runner } = createStubRunner();
  const result = await orchestrate({
    goal: "实现导出",
    projectRoot,
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  assert.equal(result.aggregate.aggregated, false);
  assert.match(result.aggregate.error ?? "", /503/);
  // 降级报告必须仍含每个子任务的状态与产出
  assert.match(result.aggregate.text, /编排结果/);
  assert.match(result.aggregate.text, /t1/);
  assert.equal(
    result.subtasks.every((s) => s.status === "succeeded"),
    true
  );
});

// ============================================================================
// O8：dry-run
// ============================================================================

test("O8：dry-run 不调用执行器、不产生子任务结果，但给出分层计划", async () => {
  const projectRoot = createTempProject();
  const { handle } = createStubHandle([PLAN_TWO_SUBTASKS]);
  const { runner, contexts } = createStubRunner();

  const result = await orchestrate({
    goal: "实现导出",
    projectRoot,
    runner,
    llmHandle: handle,
    dryRun: true,
    eventLog: false,
  });

  assert.equal(contexts.length, 0, "dry-run 不得调用执行器");
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.subtasks, []);
  assert.deepEqual(result.layers, [["t1"], ["t2"]]);
  assert.match(result.aggregate.text, /dry-run/);
  assert.match(result.aggregate.text, /执行顺序/);
});

// ============================================================================
// O9：端到端（含文件冲突下移）
// ============================================================================

test("O9：2 子任务端到端 —— 文件冲突使其串行、角色建议生效、结果结构完整", async () => {
  const projectRoot = createTempProject();
  const { handle } = createStubHandle([PLAN_TWO_SUBTASKS, "## 完成了什么\n导出的接口与实现都已完成。"]);
  const { runner, contexts } = createStubRunner();

  const progress: OrchestrationProgressEvent[] = [];

  const result = await orchestrate({
    goal: "给项目加 CSV 导出",
    projectRoot,
    runner,
    llmHandle: handle,
    onProgress: (event) => progress.push(event),
  });

  // 结构完整性
  assert.equal(result.mode, "orchestrated");
  assert.equal(result.subtasks.length, 2);
  assert.ok(result.runId.startsWith("orchestrate-"));
  assert.equal(result.budget.totalToolRounds, 32);

  // t1/t2 都声明 src/export.ts：t1 在层 0，t2 因依赖也在层 1 —— 依赖已使其串行，
  // 因此这里不应出现额外的冲突下移（验证「不产生无意义的下移记录」）
  assert.equal(result.serialized.length, 0);
  assert.deepEqual(result.layers, [["t1"], ["t2"]]);

  // 角色建议：t1 的 roleHint=architect 命中内置角色 → 强制指定生效
  const t1 = result.subtasks.find((s) => s.id === "t1")!;
  assert.equal(t1.roleId, "architect");

  // 聚合走了 LLM
  assert.equal(result.aggregate.aggregated, true);
  assert.match(result.aggregate.text, /完成了什么/);

  // 每个子任务都真实调了 runner
  assert.equal(contexts.length, 2);

  // 进度事件覆盖四个阶段
  const phases = new Set(progress.map((event) => event.phase));
  assert.equal(phases.has("decompose"), true);
  assert.equal(phases.has("plan"), true);
  assert.equal(phases.has("execute"), true);
  assert.equal(phases.has("aggregate"), true);
  assert.equal(phases.has("end"), true);

  assert.equal(result.endReason, "completed");
});

test("O9b：同层两个子任务声明同一文件 → 自动串行，并记录下移原因", async () => {
  const projectRoot = createTempProject();
  const plan = JSON.stringify({
    subtasks: [
      { id: "t1", title: "改 A", description: "修改 a.ts 的 A 部分", dependsOn: [], files: ["src/a.ts"] },
      { id: "t2", title: "改 B", description: "修改 a.ts 的 B 部分", dependsOn: [], files: ["src/a.ts"] },
    ],
  });
  const { handle } = createStubHandle([plan, "汇总"]);
  const { runner } = createStubRunner();

  const result = await orchestrate({
    goal: "同一文件的两处修改",
    projectRoot,
    budget: { maxParallel: 2 },
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  assert.equal(result.serialized.length, 1);
  assert.equal(result.serialized[0]!.id, "t2");
  assert.deepEqual(result.layers, [["t1"], ["t2"]]);
  // 报告里必须能看到这次并发降级，否则用户不知道为什么慢
  assert.match(result.aggregate.text, /并发调整|下移/);
});

// ============================================================================
// 降级路径
// ============================================================================

test("降级：拆解返回非 JSON → 单任务派单，报告注明降级原因", async () => {
  const projectRoot = createTempProject();
  const { handle } = createStubHandle(["我觉得你应该先想清楚需求。", "单任务完成"]);
  const { runner, contexts } = createStubRunner();

  const result = await orchestrate({
    goal: "随便做点什么",
    projectRoot,
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  assert.equal(result.mode, "degraded-single");
  assert.match(result.degradationReason ?? "", /no-json/);
  assert.equal(result.subtasks.length, 1);
  assert.equal(result.subtasks[0]!.status, "succeeded");
  assert.equal(contexts.length, 1);
});

test("降级：LLM 不可用（handle=null）→ 仍走单任务，但聚合为本地拼装", async () => {
  const projectRoot = createTempProject();
  const { runner } = createStubRunner();

  const result = await orchestrate({
    goal: "做一个功能",
    projectRoot,
    runner,
    llmHandle: null,
    eventLog: false,
  });

  assert.equal(result.mode, "degraded-single");
  assert.match(result.degradationReason ?? "", /llm-unavailable/);
  assert.equal(result.aggregate.aggregated, false);
  assert.match(result.aggregate.text, /编排结果/);
});

test("降级：拆解违反上限 → 拒绝并降级，不产生超量子任务", async () => {
  const projectRoot = createTempProject();
  const plan = JSON.stringify({
    subtasks: Array.from({ length: 5 }, (_, i) => ({
      id: `t${i + 1}`,
      title: `任务${i + 1}`,
      description: `做第 ${i + 1} 件事`,
    })),
  });
  const { handle } = createStubHandle([plan, "汇总"]);
  const { runner } = createStubRunner();

  const result = await orchestrate({
    goal: "五件事",
    projectRoot,
    budget: { maxSubtasks: 3 },
    runner,
    llmHandle: handle,
    eventLog: false,
  });

  assert.equal(result.mode, "degraded-single");
  assert.match(result.degradationReason ?? "", /maxSubtasks/);
  assert.equal(result.subtasks.length, 1);
});
