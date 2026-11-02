/**
 * 临时会话「待审批工具自动拒绝」测试（2026-11-02 接线审查 D2）
 *
 * 背景：
 * 主循环一旦发现 `permissionPlan.askPermissions` 非空，就写 status=ask_permission
 * 并 `return`，等待宿主把用户决策作为 `permissionOverrides` 回注。临时会话
 * （dispatch / L2 子任务的执行载体）没有审批端：`runEphemeral` 收尾时会在 finally
 * 归档并删除会话，于是
 *   - 任务以 aborted 结束（哪怕模型只差一步就能交付）；
 *   - 宿主把这个 sessionId 的审批卡推到某个 chat，形成"幽灵审批卡"
 *     （点下去指向已删除的会话）。
 *
 * 修复语义（本文件锁定）：
 *   - 临时会话：待审批工具就地改判 deny，主循环继续；模型收到"后台执行无人可审批"
 *     的合成回执，可改用只读手段或如实报告；运行结果 `deniedTools` 列出卡点。
 *   - 主会话：行为零变化，仍停在 ask_permission 等人工决策。
 *   - permissions.mode=bypass：不产生 ask，临时会话照常真改代码（用户的显式选择）。
 *
 * 测试构造：真实 SessionManager + 注入受控 LLM 响应队列 + 隔离临时目录。
 *
 * @module core/tests/session-ephemeral-auto-deny
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

/** 跨平台设置 HOME，隔离用户级 settings 读取 */
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

/** 纯文本响应（工具执行后的收尾轮次） */
function createChatResponse(content: string, usage: Record<string, unknown>): unknown {
  return { choices: [{ message: { content } }], usage };
}

/** 带工具调用的响应 */
function createToolCallResponse(
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** 技能匹配请求（response_format=json_object）固定空响应 */
function createSkillMatchingResponse(): unknown {
  return { choices: [{ message: { content: JSON.stringify({ skillNames: [] }) } }] };
}

/**
 * 构造带权限模式注入的 SessionManager
 *
 * @param projectRoot 工作区
 * @param responses 依次消费的 LLM 响应队列（技能匹配请求自动旁路，不消耗队列）
 * @param permissions resolved settings 的 permissions
 * @param permissionModeOverride 模拟 CLI --permission-mode
 */
function createManager(
  projectRoot: string,
  responses: unknown[],
  permissions: Record<string, unknown>,
  permissionModeOverride?: "manual" | "auto" | "bypass"
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (request?.response_format?.type === "json_object") {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      permissions: permissions as any,
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    permissionModeOverride,
  });
}

/** 走一次临时运行（等价于 dispatch 注入的 runner） */
function runEphemeralOnce(
  manager: SessionManager,
  projectRoot: string,
  task = "把结果写进文件"
): ReturnType<SessionManager["runEphemeral"]> {
  return manager.runEphemeral({
    roleId: "coder",
    roleName: "Coder",
    systemPrompt: "You are the coder role.",
    task,
    projectRoot,
    maxToolRounds: 3,
    requireApproval: true,
  });
}

/** 读临时会话归档（runEphemeral finally 落盘），返回全部消息 */
function readArchivedEphemeralMessages(projectRoot: string): Array<Record<string, any>> {
  const dir = path.join(projectRoot, ".deepcode", "team-runs", "ephemeral");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const messages: Array<Record<string, any>> = [];
  for (const file of files) {
    messages.push(...JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")));
  }
  return messages;
}

// ---------------------------------------------------------------------------
// AD-I01：manual 模式下临时会话不再因审批整体中止
// ---------------------------------------------------------------------------

test("ephemeral run auto-denies ask-permission tools instead of aborting (AD-I01)", async () => {
  const workspace = createTempDir("deepcode-ad-i01-workspace-");
  const home = createTempDir("deepcode-ad-i01-home-");
  setHomeDir(home);

  const manager = createManager(
    workspace,
    [
      createToolCallResponse([
        {
          id: "call-bash-write",
          name: "bash",
          args: { command: "echo hi > note.txt", sideEffects: ["write-in-cwd"] },
        },
      ]),
      // 被拒后的收尾轮次：模型改用文字交代卡点
      createChatResponse("改不了文件，需要人工执行 echo hi > note.txt", {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      }),
    ],
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "manual"
  );

  const result = await runEphemeralOnce(manager, workspace);

  // 关键回归点：不再 aborted —— 主循环跑完，模型拿到拒绝回执后收尾
  assert.notEqual(result.endReason, "aborted", `不应因审批中止（error=${result.error}）`);
  assert.equal(result.endReason, "completed");
  assert.equal(result.text, "改不了文件，需要人工执行 echo hi > note.txt");

  // 被拒工具必须进结果，否则用户看 completed 会以为改动已落地
  assert.equal(result.deniedTools?.length, 1);
  assert.equal(result.deniedTools?.[0]?.tool, "bash");

  // 工具确实没执行
  assert.equal(fs.existsSync(path.join(workspace, "note.txt")), false);

  // 回喂给模型的是「后台执行无人可审批」，不是「用户拒绝了」——否则模型会放弃
  const toolMessages = readArchivedEphemeralMessages(workspace).filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1, `应有 1 条合成工具回执，实际 ${toolMessages.length}`);
  const toolContent = String(toolMessages[0]?.content ?? "");
  assert.match(toolContent, /unattended\s+background\s+execution/);
  assert.doesNotMatch(toolContent, /User denied the required permission/);
});

// ---------------------------------------------------------------------------
// AD-I02：同一配置下主会话行为零变化（仍停在 ask_permission）
// ---------------------------------------------------------------------------

test("main session still pauses for approval under manual mode (AD-I02)", async () => {
  const workspace = createTempDir("deepcode-ad-i02-workspace-");
  const home = createTempDir("deepcode-ad-i02-home-");
  setHomeDir(home);

  const manager = createManager(
    workspace,
    [
      createToolCallResponse([
        {
          id: "call-bash-write",
          name: "bash",
          args: { command: "echo hi > note.txt", sideEffects: ["write-in-cwd"] },
        },
      ]),
    ],
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "manual"
  );

  const sessionId = await manager.createSession({ text: "写点东西" });
  const session = manager.getSession(sessionId);

  // 主会话的审批语义保持不变：暂停 + 明细齐全 + 工具未执行
  assert.equal(session?.status, "ask_permission", `主会话不得被自动拒绝逻辑影响（failReason=${session?.failReason}）`);
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-bash-write");
  assert.equal(
    manager.listSessionMessages(sessionId).some((message) => message.role === "tool"),
    false
  );
});

// ---------------------------------------------------------------------------
// AD-I03：bypass 模式下临时会话照常真改代码
// ---------------------------------------------------------------------------

test("ephemeral run still writes files when permissions.mode is bypass (AD-I03)", async () => {
  const workspace = createTempDir("deepcode-ad-i03-workspace-");
  const home = createTempDir("deepcode-ad-i03-home-");
  setHomeDir(home);

  const target = path.join(workspace, "bypass-dispatch.txt");
  const manager = createManager(
    workspace,
    [
      createToolCallResponse([{ id: "call-write", name: "write", args: { file_path: target, content: "ok" } }]),
      createChatResponse("已写入 bypass-dispatch.txt", {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      }),
    ],
    { mode: "bypass", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    undefined
  );

  const result = await runEphemeralOnce(manager, workspace);

  assert.equal(result.endReason, "completed");
  assert.equal(result.deniedTools, undefined, "bypass 模式不应产生自动拒绝");
  assert.equal(fs.readFileSync(target, "utf8"), "ok", "bypass 下 dispatch 必须能真正落盘");
});

// ---------------------------------------------------------------------------
// AD-I04：多轮被拒时结果累积全部卡点
// ---------------------------------------------------------------------------

test("ephemeral run accumulates denied tools across rounds (AD-I04)", async () => {
  const workspace = createTempDir("deepcode-ad-i04-workspace-");
  const home = createTempDir("deepcode-ad-i04-home-");
  setHomeDir(home);

  const manager = createManager(
    workspace,
    [
      createToolCallResponse([
        { id: "round1-write", name: "write", args: { file_path: path.join(workspace, "a.txt"), content: "a" } },
      ]),
      createToolCallResponse([
        { id: "round2-write", name: "write", args: { file_path: path.join(workspace, "b.txt"), content: "b" } },
      ]),
      createChatResponse("两处都无法写入", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ],
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "manual"
  );

  const result = await runEphemeralOnce(manager, workspace);

  assert.equal(result.endReason, "completed");
  assert.equal(result.deniedTools?.length, 2, `两轮各拒 1 项，实际 ${result.deniedTools?.length ?? 0}`);
  assert.deepEqual(
    result.deniedTools?.map((item) => item.tool),
    ["write", "write"]
  );
  assert.equal(fs.existsSync(path.join(workspace, "a.txt")), false);
  assert.equal(fs.existsSync(path.join(workspace, "b.txt")), false);
});
