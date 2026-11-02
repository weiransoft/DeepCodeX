/**
 * /team auto 命令层单测（L2 验收 O10 的自动化部分）
 *
 * 关注点不是编排算法（已在 orchestrator.test.ts 覆盖），而是：
 * - 命令层是否正确解析出 auto 的必填项与参数
 * - 结构化产物 `data.kind === "orchestrate"` 是否完整
 * - dry-run 是否真的不执行
 * - 参数错误是否返回退出码 2（而非 1 或 4）
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { OpenAIClientHandle } from "../common/openai-client.js";
import { runTeamCommand } from "../commands/team-command.js";
import { parseTeamCommandLine } from "../commands/team-command.js";
import type { TeamCommandData } from "../commands/types.js";

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-team-auto-"));
}

/** 只返回固定拆解 JSON 的 stub 客户端 */
function createStubClient(content: string): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
        },
      },
    },
    model: "stub-model",
    baseURL: "http://localhost:0",
    thinkingEnabled: false,
  };
}

const PLAN_TWO = JSON.stringify({
  rationale: "先设计后实现",
  subtasks: [
    { id: "t1", title: "设计接口", description: "设计导出接口", dependsOn: [], files: ["src/export.ts"] },
    { id: "t2", title: "实现", description: "实现导出逻辑", dependsOn: ["t1"], files: ["src/export.ts"] },
  ],
});

// ============================================================================
// 解析层
// ============================================================================

test("解析：/team auto 的各形态都能解析出正确字段", () => {
  const bare = parseTeamCommandLine('/team auto --goal "加一个导出功能"');
  assert.ok(bare);
  assert.equal(bare.subcommand, "auto");
  assert.equal(bare.goal, "加一个导出功能");

  const full = parseTeamCommandLine(
    "/team auto --goal 重构配置加载 --max-subtasks 4 --max-parallel 3 --dry-run --no-aggregate"
  );
  assert.ok(full);
  assert.equal(full.maxSubtasks, 4);
  assert.equal(full.maxParallel, 3);
  assert.equal(full.dryRun, true);
  assert.equal(full.skipAggregate, true);

  // --flag=value 形态
  const equals = parseTeamCommandLine("/team auto --goal=补齐测试 --max-subtasks=2");
  assert.ok(equals);
  assert.equal(equals.goal, "补齐测试");
  assert.equal(equals.maxSubtasks, 2);
});

test("解析：auto 缺少 --goal 时仍能解析（错误由执行体以退出码 2 报出）", () => {
  const args = parseTeamCommandLine("/team auto");
  assert.ok(args);
  assert.equal(args.subcommand, "auto");
  assert.equal(args.goal, undefined);
});

// ============================================================================
// 执行层
// ============================================================================

test("执行：--dry-run 输出计划且不产生子任务结果，退出码 0", async () => {
  const projectRoot = createTempProject();
  const result = await runTeamCommand(
    {
      subcommand: "auto",
      goal: "给项目加 CSV 导出",
      dryRun: true,
      projectRoot,
      injectedClient: createStubClient(PLAN_TWO),
    },
    { projectRoot, eventLog: false }
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /dry-run/);
  assert.match(result.stdout, /执行顺序/);
  assert.equal(result.data?.kind, "orchestrate");

  const data = result.data as Extract<TeamCommandData, { kind: "orchestrate" }>;
  assert.equal(data.dryRun, true);
  assert.equal(data.mode, "orchestrated");
  assert.deepEqual(data.subtasks, []);
  assert.deepEqual(data.layers, [["t1"], ["t2"]]);
  assert.equal(data.usedToolRounds, 0);
});

test("执行：缺少 --goal → 退出码 2 且给出用法", async () => {
  const projectRoot = createTempProject();
  const result = await runTeamCommand({ subcommand: "auto", projectRoot }, { projectRoot, eventLog: false });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--goal/);
  assert.match(result.stderr, /用法/);
});

test("执行：--max-subtasks 非法值 → 退出码 2", async () => {
  const projectRoot = createTempProject();
  const result = await runTeamCommand(
    { subcommand: "auto", goal: "做点事", maxSubtasks: 0, projectRoot },
    { projectRoot, eventLog: false }
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /max-subtasks/);
});

test("执行：注入 runner 后真实执行 2 个子任务，结构化产物完整", async () => {
  const projectRoot = createTempProject();
  const result = await runTeamCommand(
    {
      subcommand: "auto",
      goal: "实现导出",
      projectRoot,
      injectedClient: createStubClient(PLAN_TWO),
    },
    {
      projectRoot,
      eventLog: false,
      maxToolRounds: 4,
      runner: async (ctx) => ({
        text: `${ctx.roleName} 完成`,
        toolCalls: [{ tool: "Write", ok: true }],
        rounds: 1,
        endReason: "completed",
      }),
    }
  );

  assert.equal(result.exitCode, 0);
  const data = result.data as Extract<TeamCommandData, { kind: "orchestrate" }>;
  assert.equal(data.mode, "orchestrated");
  assert.equal(data.subtasks.length, 2);
  assert.equal(
    data.subtasks.every((subtask) => subtask.status === "succeeded"),
    true
  );
  // 聚合应走 stub 返回的拆解文本（同一条 stub 内容），至少保证有报告
  assert.ok(data.report.length > 0);
  assert.equal(data.usedToolRounds, 2);
});

test("执行：拆解不可用 → 降级单任务，退出码 0（不把降级当失败）", async () => {
  const projectRoot = createTempProject();
  const result = await runTeamCommand(
    { subcommand: "auto", goal: "做一件小事", projectRoot },
    {
      projectRoot,
      eventLog: false,
      runner: async (ctx) => ({
        text: `${ctx.roleName} 完成`,
        toolCalls: [],
        rounds: 1,
        endReason: "completed",
      }),
    }
  );

  // 无 injectedClient 且测试环境无 API Key → LLM 不可用 → 降级
  const data = result.data as Extract<TeamCommandData, { kind: "orchestrate" }>;
  assert.equal(result.exitCode, 0);
  assert.equal(data.mode, "degraded-single");
  assert.match(data.degradationReason ?? "", /llm-unavailable/);
  assert.equal(data.subtasks.length, 1);
});
