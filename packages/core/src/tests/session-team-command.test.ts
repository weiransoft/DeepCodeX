/**
 * `/team` 分发落地测试（L0-1 / L0-3，2026-11-02）
 *
 * ## 这个文件守住的是什么
 *
 * 审计报告 §3.2 的核心缺陷不是"/team 功能弱"，而是**静默降级**：Web 宿主没有执行体，
 * 用户敲 `/team dispatch` 会被当普通文本投给模型，模型配合演出输出一段"看起来像结果"
 * 的文字。用户以为成功了，实际什么都没执行。
 *
 * 因此本文件的断言重心是「**命令不会变成普通对话**」，而不是"输出文案好看"：
 * - A1：全新会话（Web 新建聊天的首条消息）敲 `/team list` → 不产生任何 LLM 调用
 * - A4：已有会话敲 `/team` → 复用同一 sessionId，不新建会话
 * - A5：参数错误 → 退出码语义映射到会话状态（failed + failReason）
 *
 * ## 为什么必须覆盖"全新会话"这条路径
 *
 * `handleUserPrompt` 在没有活跃会话时走 `createSession` 而不是 `replySession`。
 * 拦截若只做在 `replySession`，首句命令照样漏给模型 —— 这正是本文件 A1 的由来。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager } from "../session";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 构造一个"一旦被调用就失败"的 LLM 桩：命令路径不该触达模型 */
function createForbiddenClient(): { client: unknown; callCount: { value: number } } {
  const callCount = { value: 0 };
  const client = {
    chat: {
      completions: {
        create: async () => {
          callCount.value++;
          throw new Error("命令路径不得调用 LLM");
        },
      },
    },
  };
  return { client, callCount };
}

function createTestManager(options: { workspace: string; client: unknown }): {
  manager: SessionManager;
  assistantTexts: string[];
  /** 每条 assistant/system 消息的 meta（2026-11-02 D3：/team 输出标记断言用） */
  assistantMetas: Array<Record<string, unknown> | undefined>;
} {
  const assistantTexts: string[] = [];
  const assistantMetas: Array<Record<string, unknown> | undefined> = [];
  const manager = new SessionManager({
    projectRoot: options.workspace,
    createOpenAIClient: () => ({
      client: options.client as never,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: (message: { content?: string; meta?: unknown }) => {
      assistantTexts.push(message.content ?? "");
      assistantMetas.push(message.meta as Record<string, unknown> | undefined);
    },
  });
  return { manager, assistantTexts, assistantMetas };
}

test("A1：全新会话首条 /team list 不触达模型，直接执行并落会话消息", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a1-workspace-");
  const home = createTempDir("deepcode-teamcmd-a1-home-");
  setHomeDir(home);

  const { client, callCount } = createForbiddenClient();
  const { manager, assistantTexts } = createTestManager({ workspace, client });

  await manager.handleUserPrompt({ text: "/team list" });

  assert.equal(callCount.value, 0, "命令必须被分发器截获，不能作为普通文本投给模型");
  assert.ok(
    assistantTexts.some((text) => text.includes("可用角色")),
    `应回显角色清单，实际：${assistantTexts.join(" || ")}`
  );

  const sessions = manager.listSessions();
  assert.equal(sessions.length, 1, "命令专用会话应写入索引，供用户在历史里回溯");
  assert.equal(sessions[0]?.summary?.startsWith("/team"), true, "会话摘要应取自命令原文");
});

test("A4：已有会话再敲 /team 复用同一 sessionId，不产生第二条会话", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a4-workspace-");
  const home = createTempDir("deepcode-teamcmd-a4-home-");
  setHomeDir(home);

  const { client, callCount } = createForbiddenClient();
  const { manager } = createTestManager({ workspace, client });

  await manager.handleUserPrompt({ text: "/team list" });
  const firstId = manager.getActiveSessionId();
  assert.ok(firstId, "首条命令应建立活跃会话");

  await manager.handleUserPrompt({ text: "/team match --keywords 增长" });

  assert.equal(manager.getActiveSessionId(), firstId, "第二条命令必须落在同一会话");
  assert.equal(manager.listSessions().length, 1, "不得为每条命令新建会话");
  assert.equal(callCount.value, 0, "两条命令都不该触达模型");
});

test("A4b：裸 /team 与 /team help 回显帮助，同样不触达模型", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a4b-workspace-");
  const home = createTempDir("deepcode-teamcmd-a4b-home-");
  setHomeDir(home);

  const { client, callCount } = createForbiddenClient();
  const { manager, assistantTexts } = createTestManager({ workspace, client });

  // 裸 `/team`：用户想看用法，这是最常见的手输形态
  await manager.handleUserPrompt({ text: "/team" });
  assert.equal(callCount.value, 0, "裸 /team 不应回落给模型");
  assert.ok(
    assistantTexts.some((text) => text.includes("用法") || text.includes("team <")),
    `裸 /team 应回显用法，实际：${assistantTexts.join(" || ")}`
  );

  // `/team help` 是正常诉求，按成功处理
  await manager.handleUserPrompt({ text: "/team help" });
  const entry = manager.getSession(manager.getActiveSessionId() ?? "");
  assert.equal(entry?.status, "completed", "/team help 属于正常诉求，不应标记失败");
  assert.equal(callCount.value, 0);
});

test("A4c：手误子命令（/team ls）回显帮助并明确报错，不静默回落", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a4c-workspace-");
  const home = createTempDir("deepcode-teamcmd-a4c-home-");
  setHomeDir(home);

  const { client, callCount } = createForbiddenClient();
  const { manager, assistantTexts } = createTestManager({ workspace, client });

  await manager.handleUserPrompt({ text: "/team ls" });

  assert.equal(callCount.value, 0, "手误子命令也不能回落给模型（否则模型会演一段假结果）");
  assert.ok(
    assistantTexts.some((text) => text.includes("未知子命令：ls")),
    `应明确告知未知子命令，实际：${assistantTexts.join(" || ")}`
  );
  const entry = manager.getSession(manager.getActiveSessionId() ?? "");
  assert.equal(entry?.status, "failed", "未知子命令按参数错误处理");
});

test("A5：参数错误 → 退出码 2 映射为失败状态并给出可读原因", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a5-workspace-");
  const home = createTempDir("deepcode-teamcmd-a5-home-");
  setHomeDir(home);

  const { client } = createForbiddenClient();
  const { manager, assistantTexts } = createTestManager({ workspace, client });

  await manager.handleUserPrompt({ text: "/team match" });

  const sessionId = manager.getActiveSessionId();
  assert.ok(sessionId);
  const entry = manager.getSession(sessionId);
  assert.equal(entry?.status, "failed", "缺参属于用户输入错误，会话应标记失败");
  assert.ok((entry?.failReason ?? "").includes("match"), `失败原因应指明子命令，实际：${entry?.failReason}`);
  assert.ok(
    assistantTexts.some((text) => text.includes("--keywords")),
    "应把用法提示回显给用户，而不是静默失败"
  );
});

test("A6：/teams（复数）不是命令，仍走普通消息链路", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a6-workspace-");
  const home = createTempDir("deepcode-teamcmd-a6-home-");
  setHomeDir(home);

  const { client, callCount } = createForbiddenClient();
  const { manager, assistantTexts } = createTestManager({ workspace, client });

  // 首 token 严格等于 `team` 才算命令；`/teams` 必须以普通用户消息投给模型。
  // 桩会在被调用时抛错，主循环把异常收进会话状态（不向调用方抛出），
  // 因此断言落在"模型被调用过 + 没有任何 team 输出"上。
  await manager.handleUserPrompt({ text: "/teams 是复数形式，不是命令" });

  // 主循环在 LLM 抛错后可能重试一次，因此只断言"至少投给过模型一次"
  assert.ok(callCount.value >= 1, "非 /team 前缀必须走模型");
  assert.equal(
    assistantTexts.some((text) => text.includes("【team】") || text.includes("可用角色")),
    false,
    "普通消息不得产生 team 命令输出"
  );
});

test("A7：/team 输出带 teamCommand 标记（Web 据此渲染团队卡片而非助手气泡）", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a7-workspace-");
  const home = createTempDir("deepcode-teamcmd-a7-home-");
  setHomeDir(home);

  const { client, callCount } = createForbiddenClient();
  const { manager, assistantMetas } = createTestManager({ workspace, client });

  await manager.handleUserPrompt({ text: "/team list" });

  assert.equal(callCount.value, 0, "命令路径不触达模型");
  assert.ok(assistantMetas.length > 0, "应至少推出一条命令输出");
  // 每条输出都必须带标记（否则前端会把它当普通助手消息）：progress 若干条 + 结果 1 条
  const phases = assistantMetas.map((item) => (item?.["teamCommand"] as { phase?: string } | undefined)?.phase);
  assert.ok(
    phases.every((phase) => phase === "progress" || phase === "result"),
    `所有输出都必须带 teamCommand 标记，实际：${JSON.stringify(phases)}`
  );
  assert.equal(phases.at(-1), "result", "最后一条必须是结果（前端据此渲染结果卡）");
  const meta = assistantMetas.at(-1)?.["teamCommand"] as { subcommand?: string; phase?: string } | undefined;
  assert.ok(meta !== undefined);
  assert.equal(meta.subcommand, "list");
  assert.equal(meta.phase, "result");
});

test("A8：/team 未知子命令标记为 error 阶段（前端标红而不是当正常结果）", async () => {
  const workspace = createTempDir("deepcode-teamcmd-a8-workspace-");
  const home = createTempDir("deepcode-teamcmd-a8-home-");
  setHomeDir(home);

  const { client } = createForbiddenClient();
  const { manager, assistantMetas } = createTestManager({ workspace, client });

  await manager.handleUserPrompt({ text: "/team nosuchsub" });

  const meta = assistantMetas.at(-1)?.["teamCommand"] as { subcommand?: string; phase?: string } | undefined;
  assert.ok(meta !== undefined);
  assert.equal(meta.phase, "error", "参数错误必须以 error 阶段下发");
  // 未知子命令不是合法子命令 → subcommand 回落到 help（args 为 null 分支）
  assert.equal(meta.subcommand, "help");
});
