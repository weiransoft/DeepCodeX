/**
 * team 命令执行体测试（L0-1 / L1-1，2026-11-02）
 *
 * 这些断言直接对应方案 §3.5 的验收项：
 * - A1/A2：Web 与 CLI 共用同一执行体，`list` / `match` 返回结构化数据（不需要解析文本）
 * - A3：无注入候选时输出与改动前一致（`可用角色（5 个）`），有注入时新增业务角色分组
 * - A6：解析器覆盖聊天输入框的真实写法（引号、逗号分隔、`--flag=value`）
 * - C1：注入 runner 后 dispatch 走真实执行器（toolCapable=true），并落 dispatch 事件日志
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTeamCommandLine, runTeamCommand } from "../commands/team-command";
import { buildTeamCommandDescriptors, TEAM_SUBCOMMANDS } from "../commands/types";
import { ROLE_REGISTRY, listRoleIds } from "../team/role-registry";
import { buildRolesFromAgents, mergeRoleCandidates } from "../agents/role-bridge";

function makeProjectRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "deepcode-team-cmd-"));
}

/** 构造两个运行时角色（营销 + 学术），用于验证候选集注入后的输出分组 */
function runtimeCandidates() {
  return mergeRoleCandidates(
    ROLE_REGISTRY,
    buildRolesFromAgents(
      [
        {
          name: "domain-growth-hacker",
          description: "增长黑客：负责低成本获客与转化实验。",
          kind: "agent",
          role: "增长黑客",
          preset: true,
          group: "营销增长",
        },
        {
          name: "domain-literature-reviewer",
          description: "文献综述专家：负责系统性检索与证据分级。",
          kind: "agent",
          role: "文献综述专家",
          preset: true,
          group: "学术研究",
        },
      ],
      { excludeRoleIds: listRoleIds() }
    )
  );
}

test("A6：命令行解析覆盖聊天输入框真实写法", () => {
  assert.deepEqual(parseTeamCommandLine("/team list"), { subcommand: "list" });

  const match = parseTeamCommandLine("/team match --keywords 增长,营销");
  assert.equal(match?.subcommand, "match");
  assert.deepEqual(match?.keywords, ["增长", "营销"]);

  const dispatch = parseTeamCommandLine('/team dispatch --task "实现登录模块" --role architect');
  assert.equal(dispatch?.subcommand, "dispatch");
  assert.equal(dispatch?.task, "实现登录模块");
  assert.equal(dispatch?.role, "architect");

  const autonomous = parseTeamCommandLine('/team autonomous --goal "实现 OAuth2" --max-iterations=3 --resume-run');
  assert.equal(autonomous?.goal, "实现 OAuth2");
  assert.equal(autonomous?.maxIterations, 3);
  assert.equal(autonomous?.resumeRun, true);

  const lifecycle = parseTeamCommandLine(
    '/team full-lifecycle --project "电商网站" --use-loop --test-command "npm test"'
  );
  assert.equal(lifecycle?.goal, "电商网站");
  assert.equal(lifecycle?.useLoop, true);
  assert.equal(lifecycle?.testCommand, "npm test");

  // 非 team 命令 / 非法子命令 → null（调用方继续走普通消息路径，不被误拦截）
  assert.equal(parseTeamCommandLine("帮我重构这个函数"), null);
  assert.equal(parseTeamCommandLine("/eag-build --goal x"), null);
  assert.equal(parseTeamCommandLine("/team unknow-sub"), null);
  assert.equal(parseTeamCommandLine("/team"), null);
});

test("描述符单一数据源：每个子命令都有描述符，且与 TEAM_SUBCOMMANDS 一一对齐", () => {
  const descriptors = buildTeamCommandDescriptors();
  assert.equal(descriptors.length, TEAM_SUBCOMMANDS.length);
  // 从 TEAM_SUBCOMMANDS 推导而不是硬编码清单：这条断言守的是「描述符与子命令集合对齐」，
  // 硬编码会让每次新增子命令都变成一次假失败（L2 新增 auto 时已发生过一次）。
  assert.deepEqual(
    descriptors.map((d) => d.id),
    TEAM_SUBCOMMANDS.map((subcommand) => `team-${subcommand}`)
  );
  assert.ok(descriptors.every((d) => d.category === "team"));
  assert.ok(descriptors.every((d) => d.description.length > 10));
});

test("A3：list 无候选时输出与改动前一致（5 个内置角色）", async () => {
  const result = await runTeamCommand({ subcommand: "list" }, { projectRoot: makeProjectRoot(), eventLog: false });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("可用角色（5 个）"), result.stdout.slice(0, 200));
  assert.ok(result.stdout.includes("⏱  耗时:"));
  assert.equal(result.data?.kind, "list");
  if (result.data?.kind === "list") {
    assert.equal(result.data.roles.length, 5);
    assert.ok(result.data.roles.every((role) => role.group === undefined && role.preset === undefined));
  }
});

test("B8：list 注入候选后按业务类别分组，并标注预置来源", async () => {
  const result = await runTeamCommand(
    { subcommand: "list" },
    { projectRoot: makeProjectRoot(), candidates: runtimeCandidates(), eventLog: false }
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("可用角色（5 个内置 + 2 个业务角色）"), result.stdout.slice(0, 300));
  assert.ok(result.stdout.includes("业务角色（2 个，来自智能体）"));
  assert.ok(result.stdout.includes("【营销增长】"));
  assert.ok(result.stdout.includes("【学术研究】"));
  assert.ok(result.stdout.includes("[预置]"));

  if (result.data?.kind === "list") {
    const runtime = result.data.roles.filter((role) => role.roleId.startsWith("domain-"));
    assert.equal(runtime.length, 2);
    assert.ok(runtime.every((role) => role.preset === true));
    assert.deepEqual(runtime.map((role) => role.group).sort(), ["academic", "marketing"]);
  }
});

test("A2：match 关键词命中营销专家（候选集注入生效）", async () => {
  const result = await runTeamCommand(
    { subcommand: "match", keywords: ["增长", "投放", "获客"] },
    { projectRoot: makeProjectRoot(), candidates: runtimeCandidates(), eventLog: false }
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("匹配结果"));
  assert.equal(result.data?.kind, "match");
  if (result.data?.kind === "match") {
    assert.equal(result.data.matches[0]?.roleId, "domain-growth-hacker");
    assert.equal(result.data.matches[0]?.builtin, false);
  }
});

test("参数错误返回 2：match 缺 --keywords、dispatch 缺 task", async () => {
  const root = makeProjectRoot();
  const noKeywords = await runTeamCommand({ subcommand: "match" }, { projectRoot: root, eventLog: false });
  assert.equal(noKeywords.exitCode, 2);
  assert.ok(noKeywords.stderr.includes("--keywords"));

  const noTask = await runTeamCommand({ subcommand: "dispatch" }, { projectRoot: root, eventLog: false });
  assert.equal(noTask.exitCode, 2);
  assert.ok(noTask.stderr.includes("--task"));
});

test("C1：注入 runner 后 dispatch 走真实执行器，且落 dispatch 事件日志", async () => {
  const projectRoot = makeProjectRoot();
  const seen: Array<{ roleId: string; requireApproval: boolean; maxToolRounds: number; systemPrompt: string }> = [];

  const result = await runTeamCommand(
    { subcommand: "dispatch", role: "architect", task: "实现用户登录模块" },
    {
      projectRoot,
      runner: async (context) => {
        seen.push({
          roleId: context.roleId,
          requireApproval: context.requireApproval,
          maxToolRounds: context.maxToolRounds,
          systemPrompt: context.systemPrompt,
        });
        return {
          text: "已新增 src/auth/login.ts",
          toolCalls: [
            { tool: "read_file", ok: true },
            { tool: "write_file", ok: true },
          ],
          rounds: 2,
          endReason: "completed",
        };
      },
    }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(seen.length, 1, "runner 必须被调用一次");
  assert.equal(seen[0]!.roleId, "architect");
  assert.equal(seen[0]!.requireApproval, true, "审批不可关闭（字面量 true）");
  assert.equal(seen[0]!.maxToolRounds, 8, "默认工具轮次上限");
  assert.ok(seen[0]!.systemPrompt.length > 50, "角色 system prompt 必须已拼装");

  assert.equal(result.data?.kind, "dispatch");
  if (result.data?.kind === "dispatch") {
    assert.equal(result.data.dispatch.toolCapable, true);
    assert.equal(result.data.dispatch.status, "succeeded");
    assert.ok(result.data.dispatch.output.includes("src/auth/login.ts"));
  }
  assert.ok(result.stdout.includes("status: succeeded"));

  // 事件日志：默认落 <projectRoot>/.deepcode/team-runs/<runId>/events.jsonl
  const runsRoot = path.join(projectRoot, ".deepcode", "team-runs");
  assert.ok(existsSync(runsRoot), "必须创建 team-runs 目录");
  const runDirs = readdirSync(runsRoot);
  assert.equal(runDirs.length, 1);
  assert.ok(existsSync(path.join(runsRoot, runDirs[0]!, "events.jsonl")));
});

test("runner 返回非 completed 时映射为失败状态（max-rounds → isPartial）", async () => {
  const result = await runTeamCommand(
    { subcommand: "dispatch", role: "solo-coder", task: "改一个长任务" },
    {
      projectRoot: makeProjectRoot(),
      eventLog: false,
      runner: async () => ({
        text: "只做了一半",
        toolCalls: [{ tool: "write_file", ok: true }],
        rounds: 8,
        endReason: "max-rounds",
        error: "工具调用轮次超过预算（8），已中止",
      }),
    }
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.data?.kind, "dispatch");
  if (result.data?.kind === "dispatch") {
    assert.equal(result.data.dispatch.status, "failed");
    assert.ok(result.data.dispatch.error?.includes("轮次超过预算"));
  }
  assert.ok(result.stdout.includes("isPartial: true"));
});
