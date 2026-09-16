/**
 * 三态权限模式（manual / auto / bypass）—— SessionManager 场景集成测试
 *
 * 对应设计文档 docs/dev/permission-modes.md §7.2 用例 PM-I01 ~ PM-I07：
 * - PM-I01：override="bypass"，bash+write 调用直接执行，无 ask_permission
 * - PM-I02：override="manual"，bash 写操作进入 ask_permission，askPermissions 齐全
 * - PM-I03：settings mode=bypass + 无 override → 与 PM-I01 一致
 * - PM-I04：无 mode + 无 override（存量用户）→ 行为与现状一致（回归基线）
 * - PM-I05：bypass 下灾难命令 `rm -rf /` 仍被 checkDangerousBashCommand 硬拦截（安全底线）
 * - PM-I06：manual 下用户审批 allow + alwaysAllows → 工具执行 + settings.json 回写保留 mode
 * - PM-I07：bypass + planMode 开启 → 不产生强制 ask（放行）
 *
 * 测试构造方式与 session.test.ts 既有权限用例一致：注入受控 LLM 客户端（依赖注入），
 * 在隔离临时目录（workspace + HOME）中跑真实 SessionManager 权限链路。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, type SessionMessage } from "../session";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

/** 跨平台设置 HOME（Unix 用 HOME，Windows 用 USERPROFILE），隔离用户级 settings 读取 */
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

/** 创建隔离临时目录并登记清理 */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 构造纯文本 LLM 响应（工具执行完毕后的收尾轮次） */
function createChatResponse(content: string, usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

/** 判断请求是否为技能匹配请求（SessionManager 内部额外发起的 json_object 调用） */
function isSkillMatchingRequest(request: any): boolean {
  return request?.response_format?.type === "json_object";
}

/** 技能匹配请求的固定空响应（无可用技能） */
function createSkillMatchingResponse(): unknown {
  return { choices: [{ message: { content: JSON.stringify({ skillNames: [] }) } }] };
}

/**
 * 构造带三态权限模式注入的 SessionManager。
 *
 * @param projectRoot 工作区（隔离临时目录）
 * @param responses 依次消费的 LLM 响应队列（技能匹配请求自动旁路）
 * @param permissions resolved settings 的 permissions（可含/不含 mode 字段以模拟存量与新版配置）
 * @param permissionModeOverride CLI --permission-mode 注入的覆盖值（undefined = 不注入）
 */
function createPermissionModeSessionManager(
  projectRoot: string,
  responses: unknown[],
  permissions: Record<string, unknown>,
  permissionModeOverride?: "manual" | "auto" | "bypass"
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
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
    // 三态权限模式覆盖：模拟 CLI --permission-mode 的注入点（undefined 表示未传 flag）
    permissionModeOverride,
  });
}

/** 查找会话中带 tool_calls 的 assistant 消息（meta.permissions 断言用） */
function findAssistantWithToolCalls(manager: SessionManager, sessionId: string): SessionMessage | undefined {
  return manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);
}

// ---------------------------------------------------------------------------
// PM-I01：bypass 覆盖 → 工具直接执行，无 ask_permission
// ---------------------------------------------------------------------------

test("permissionModeOverride bypass executes bash and write tools without ask_permission (PM-I01)", async () => {
  const workspace = createTempDir("deepcode-perm-i01-bypass-workspace-");
  const home = createTempDir("deepcode-perm-i01-bypass-home-");
  setHomeDir(home);

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-echo",
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command: "echo bypass-ok" }) },
                },
                {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ file_path: path.join(workspace, "bypass.txt"), content: "bypass" }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ],
    // settings 未配置 mode（存量形态），仅靠 CLI override 生效
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "bypass"
  );

  const sessionId = await manager.createSession({ text: "run tools in bypass" });
  const session = manager.getSession(sessionId);
  const assistant = findAssistantWithToolCalls(manager, sessionId);
  const toolMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "tool");

  // 不进入 ask_permission，工具全部实际执行（write 落盘可验证）
  assert.equal(session?.status, "completed");
  assert.equal(session?.askPermissions, undefined);
  assert.deepEqual(assistant?.meta?.permissions, [
    { toolCallId: "call-echo", permission: "allow" },
    { toolCallId: "call-write", permission: "allow" },
  ]);
  assert.equal(toolMessages.length, 2);
  assert.equal(fs.readFileSync(path.join(workspace, "bypass.txt"), "utf8"), "bypass");
});

// ---------------------------------------------------------------------------
// PM-I02：manual 覆盖 → bash 写操作进入 ask_permission
// ---------------------------------------------------------------------------

test("permissionModeOverride manual pauses session for bash write operations (PM-I02)", async () => {
  const workspace = createTempDir("deepcode-perm-i02-manual-workspace-");
  const home = createTempDir("deepcode-perm-i02-manual-home-");
  setHomeDir(home);

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-bash-write",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "echo hi > note.txt",
                      sideEffects: ["write-in-cwd"],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "manual"
  );

  const sessionId = await manager.createSession({ text: "write a note" });
  const session = manager.getSession(sessionId);
  const assistant = findAssistantWithToolCalls(manager, sessionId);

  // 手动审批：session 暂停等待用户授权，scope 齐全，工具未执行
  assert.equal(session?.status, "ask_permission");
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-bash-write");
  assert.deepEqual(session?.askPermissions?.[0]?.scopes, ["write-in-cwd"]);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-bash-write", permission: "ask" }]);
  assert.equal(
    manager.listSessionMessages(sessionId).some((message) => message.role === "tool"),
    false
  );
});

// ---------------------------------------------------------------------------
// PM-I03：settings mode=bypass + 无 override → 与 PM-I01 一致
// ---------------------------------------------------------------------------

test("settings permissions.mode bypass takes effect when no CLI override is provided (PM-I03)", async () => {
  const workspace = createTempDir("deepcode-perm-i03-settings-bypass-workspace-");
  const home = createTempDir("deepcode-perm-i03-settings-bypass-home-");
  setHomeDir(home);

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      file_path: path.join(workspace, "settings-bypass.txt"),
                      content: "settings",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ],
    // settings.json 配置了 mode=bypass，CLI 未传 override
    { mode: "bypass", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    undefined
  );

  const sessionId = await manager.createSession({ text: "run via settings mode" });
  const session = manager.getSession(sessionId);

  assert.equal(session?.status, "completed");
  assert.equal(session?.askPermissions, undefined);
  assert.equal(fs.readFileSync(path.join(workspace, "settings-bypass.txt"), "utf8"), "settings");
});

// ---------------------------------------------------------------------------
// PM-I04：无 mode + 无 override（存量用户）→ 回归基线
// ---------------------------------------------------------------------------

test("legacy settings without mode keep existing ask behavior (PM-I04)", async () => {
  const workspace = createTempDir("deepcode-perm-i04-legacy-workspace-");
  const home = createTempDir("deepcode-perm-i04-legacy-home-");
  setHomeDir(home);

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: "ls", sideEffects: ["read-in-cwd"] }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    // 存量配置：无 mode 字段，defaultMode=askAll → 一切工具都要询问（引入三态前行为）
    { allow: [], deny: [], ask: [], defaultMode: "askAll", addWorkingDirs: [] },
    undefined
  );

  const sessionId = await manager.createSession({ text: "legacy baseline" });
  const session = manager.getSession(sessionId);
  const assistant = findAssistantWithToolCalls(manager, sessionId);

  assert.equal(session?.status, "ask_permission");
  assert.deepEqual(session?.askPermissions?.[0]?.scopes, ["read-in-cwd"]);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-bash", permission: "ask" }]);
});

// ---------------------------------------------------------------------------
// PM-I05：bypass 下灾难命令仍被硬拦截（安全底线）
// ---------------------------------------------------------------------------

test("bypass mode still blocks catastrophic bash commands via executor guard (PM-I05)", async () => {
  const workspace = createTempDir("deepcode-perm-i05-bypass-guard-workspace-");
  const home = createTempDir("deepcode-perm-i05-bypass-guard-home-");
  setHomeDir(home);

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-rmrf",
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command: "rm -rf /" }) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      createChatResponse("acknowledged", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ],
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "bypass"
  );

  const sessionId = await manager.createSession({ text: "delete everything" });

  // bypass 不拦截审批（无 ask_permission），但灾难命令在 executor 层被硬拦截，
  // 工具消息返回失败结果而非真实执行
  const toolMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "tool");
  assert.match(toolMessage?.content ?? "", /ToolExecutor guard blocked bash command: forbidden rm -rf \//);
  assert.equal(manager.getSession(sessionId)?.status, "completed");
});

// ---------------------------------------------------------------------------
// PM-I06：manual 下审批 allow + alwaysAllows → 执行 + 回写保留 mode
// ---------------------------------------------------------------------------

test("manual mode reply with alwaysAllows executes tools and preserves mode in settings.json (PM-I06)", async () => {
  const workspace = createTempDir("deepcode-perm-i06-manual-allow-workspace-");
  const home = createTempDir("deepcode-perm-i06-manual-allow-home-");
  setHomeDir(home);
  fs.writeFileSync(path.join(workspace, "note.txt"), "manual allow content\n", "utf8");

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ file_path: path.join(workspace, "note.txt") }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      createChatResponse("continued", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ],
    // manual 模式：read 不在白名单 → 需要用户授权
    { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    undefined
  );
  const sessionId = await manager.createSession({ text: "read the note" });
  assert.equal(manager.getSession(sessionId)?.status, "ask_permission");

  // 用户审批：allow 该次调用 + always allow read-in-cwd scope
  await manager.replySession(sessionId, {
    text: "/continue",
    permissions: [{ toolCallId: "call-read", permission: "allow" }],
    alwaysAllows: ["read-in-cwd"],
  });

  const toolMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "tool");
  const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".deepcode", "settings.json"), "utf8"));

  // 工具已真实执行（读取到文件内容）
  assert.match(toolMessage?.content ?? "", /manual allow content/);
  // 回写 settings.json：allow 白名单追加 + mode 保留为 manual（不因回写丢失三态模式）
  assert.deepEqual(settings.permissions.allow, ["read-in-cwd"]);
  assert.equal(settings.permissions.mode, "manual");
  assert.equal(manager.getSession(sessionId)?.status, "completed");
});

// ---------------------------------------------------------------------------
// PM-I07：bypass + planMode → 不产生强制 ask
// ---------------------------------------------------------------------------

test("bypass mode skips plan-mode forced asks (PM-I07)", async () => {
  const workspace = createTempDir("deepcode-perm-i07-bypass-plan-workspace-");
  const home = createTempDir("deepcode-perm-i07-bypass-plan-home-");
  setHomeDir(home);

  const manager = createPermissionModeSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      file_path: path.join(workspace, "plan-bypass.txt"),
                      content: "planned",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ],
    { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "bypass"
  );

  // planMode 常规下会对 write-in-cwd 强制 ask（见 session.test.ts 既有用例），bypass 放行
  const sessionId = await manager.createSession({ text: "plan a change", planMode: true });
  const session = manager.getSession(sessionId);
  const assistant = findAssistantWithToolCalls(manager, sessionId);

  assert.notEqual(session?.status, "ask_permission");
  assert.equal(session?.askPermissions, undefined);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-write", permission: "allow" }]);
});
