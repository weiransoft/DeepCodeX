/**
 * `/team roundtable` 接线测试
 *
 * 覆盖三件事：
 * 1. 命令行解析（`--roles` / `--moderator` / `--rounds` / `--escalations`）
 * 2. 参数校验（未知角色、主持人兼任参与者、参与者不足）
 * 3. 端到端输出（讨论 → 共识 → 台账 → 执行 → 结论行）
 *
 * 桩 LLM 与 `roundtable-room.test.ts` 同款路由；这里关心的是**命令层**是否正确
 * 把参数转成编排选项、把结果渲染成可读文本与结构化 data。
 *
 * @module core/tests/team-roundtable-command
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatTeamHelp, parseTeamCommandLine, runTeamCommand } from "../commands/team-command.js";

/** 造临时项目根 */
function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-roundtable-cmd-"));
}

/** 从请求体取最后一条 user 消息 */
function readUser(request: any): string {
  const messages = request?.messages;
  if (!Array.isArray(messages)) return "";
  const users = messages.filter((m: any) => m?.role === "user");
  const last = users[users.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

/** 桩客户端：按 prompt 句式路由 */
function createStubClient() {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          const user = readUser(request);
          const content = (() => {
            if (user.includes("输出你的 JSON 发言")) {
              return JSON.stringify({
                posture: "support",
                blocking: false,
                keyPoints: [],
                questions: [],
                content: "同意按此方案",
              });
            }
            if (user.includes("讨论已经收敛")) {
              return JSON.stringify({
                summary: "采用用户维度限流",
                decisions: ["按用户维度限流", "429 带 Retry-After"],
                openQuestions: [],
                assignments: [
                  {
                    roleId: "architect",
                    scope: "docs/**",
                    deliverable: "限流规则文档",
                    acceptance: "评审通过",
                    dependsOn: [],
                  },
                  {
                    roleId: "solo-coder",
                    scope: "src/**",
                    deliverable: "限流中间件",
                    acceptance: "用例绿",
                    dependsOn: ["architect"],
                  },
                ],
              });
            }
            if (user.includes("请用你自己的话复述")) {
              return JSON.stringify({
                restated: "按分工完成",
                steps: ["读共识", "实现"],
                acceptance: "自测通过",
                needDiscussion: false,
                question: "",
              });
            }
            if (user.includes("## 会议共识")) {
              return JSON.stringify({ summary: "完成", filesTouched: [], questions: [] });
            }
            return "{}";
          })();
          return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: 5 } };
        },
      },
    },
  };
  return { client, model: "stub-model", baseURL: "https://stub.local", thinkingEnabled: false };
}

test("T1. 解析 --roles / --moderator / --rounds / --escalations", () => {
  const args = parseTeamCommandLine(
    '/team roundtable --task "给登录加限流" --roles architect,solo-coder --moderator ui-designer --rounds 2 --escalations 0'
  );
  assert.ok(args);
  assert.equal(args!.subcommand, "roundtable");
  assert.equal(args!.task, "给登录加限流");
  assert.deepEqual(args!.roles, ["architect", "solo-coder"]);
  assert.equal(args!.moderator, "ui-designer");
  assert.equal(args!.rounds, 2);
  assert.equal(args!.escalations, 0);
});

test("T2. 帮助文本列出 roundtable 与全部相关选项", () => {
  const help = formatTeamHelp();
  assert.ok(help.includes("roundtable --task <goal>"));
  assert.ok(help.includes("--roles <a,b,c>"));
  assert.ok(help.includes("--moderator <role-id>"));
  assert.ok(help.includes("--rounds <n>"));
  assert.ok(help.includes("--escalations <n>"));
});

test("T3. 未知角色 → 退出码 2 且指名道姓", async () => {
  const projectRoot = tempProject();
  const result = await runTeamCommand(
    { subcommand: "roundtable", task: "任意目标", roles: ["architect", "no-such-role"], projectRoot },
    { projectRoot }
  );
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("no-such-role"), `stderr 应指出具体角色：${result.stderr}`);
});

test("T4. 主持人兼任参与者 → 退出码 2（否则共识计数与议程会混在一起）", async () => {
  const projectRoot = tempProject();
  const result = await runTeamCommand(
    {
      subcommand: "roundtable",
      task: "任意目标",
      roles: ["architect", "solo-coder"],
      moderator: "architect",
      projectRoot,
    },
    { projectRoot }
  );
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("主持人"));
});

test("T5. 参与者不足 2 人 → 退出码 2", async () => {
  const projectRoot = tempProject();
  const result = await runTeamCommand(
    { subcommand: "roundtable", task: "任意目标", roles: ["architect"], projectRoot },
    { projectRoot }
  );
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("至少需要 2 个参与者"));
});

test("T6. 端到端：达成共识 → 输出台账与执行结果 → 退出码 0", async () => {
  const projectRoot = tempProject();
  const stub = createStubClient();
  const result = await runTeamCommand(
    {
      subcommand: "roundtable",
      task: "为登录接口加限流",
      roles: ["architect", "solo-coder"],
      moderator: "product-manager",
      rounds: 1,
      projectRoot,
      injectedClient: stub as any,
    },
    { projectRoot }
  );

  assert.equal(result.exitCode, 0, `期望 0，实际 ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("━━━ 共识"), "缺少共识段");
  assert.ok(result.stdout.includes("━━━ 任务台账"), "缺少台账段");
  assert.ok(result.stdout.includes("━━━ 执行"), "缺少执行段");
  assert.ok(result.stdout.includes("status: consensus"), "缺少结论行");
  assert.ok(result.stdout.includes("采用用户维度限流"), "共识正文未渲染");

  // 结构化产物：宿主可直接渲染，不必解析文本
  assert.ok(result.data && result.data.kind === "roundtable");
  if (result.data?.kind === "roundtable") {
    assert.equal(result.data.status, "consensus");
    assert.equal(result.data.assignments.length, 2);
    assert.equal(result.data.executions.length, 2);
    assert.ok(
      result.data.executions.every((item) => item.mode === "text"),
      "未注入 runner 应为文本模式"
    );
  }
});

test("T7. 无模型凭据 → 退出码 1，且明确说明原因", async () => {
  const projectRoot = tempProject();
  const result = await runTeamCommand(
    {
      subcommand: "roundtable",
      task: "任意目标",
      roles: ["architect", "solo-coder"],
      rounds: 1,
      projectRoot,
      // 非合法句柄 → resolveLlmHandle 返回 null，不触碰真实凭据
      injectedClient: { notAHandle: true } as any,
    },
    { projectRoot }
  );
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.stdout.includes("status: skipped") || result.stderr.includes("模型凭据"),
    `实际输出：${result.stdout}${result.stderr}`
  );
});
