/**
 * Web 审批三态（auto 自动审批 / 会话级总是允许）—— SessionManager 场景集成测试
 *
 * 对应设计文档 docs/dev/web-approval.md 验收用例 WA-I01 ~ WA-I05：
 * - WA-I01：override="auto"，非高危只读 bash（ls -la）自动放行直通执行，
 *           会话不停留在 ask_permission（"非高危命令自动审批"核心行为）；
 * - WA-I02：override="manual"，同一只读命令仍进入 ask_permission（手动审批零回归）；
 * - WA-I03：override="auto"，非只读 bash（echo hi > note.txt 写副作用）
 *           不满足只读白名单 → 保持人工审批（自动审批范围收窄边界）；
 * - WA-I04：override="auto"，灾难命令（rm -rf /）命中 CommandSafety 黑名单
 *           → 必须人工审批，自动放行绝不过滤黑名单命令（安全底线）；
 * - WA-I05：manual 模式下 addSessionAlwaysAllows(["write-in-cwd"]) 登记后，
 *           write 工具审批请求经会话级"总是允许"直接改判 allow 执行，
 *           且不落盘任何项目级配置（Web 个人区 R5 防线）。
 *
 * 测试构造方式与 session-permission-mode-override.test.ts 一致：注入受控 LLM
 * 客户端（依赖注入），在隔离临时目录（workspace + HOME）中跑真实权限链路。
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
function createChatResponse(content: string): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
 * 构造带三态权限模式注入的 SessionManager（Web 审批场景专用）。
 *
 * @param projectRoot 工作区（隔离临时目录）
 * @param responses 依次消费的 LLM 响应队列（技能匹配请求自动旁路）
 * @param permissions resolved settings 的 permissions（含 mode 字段模拟 Web 设置）
 * @param permissionModeOverride Web approvalMode 注入的覆盖值（undefined = 不注入）
 */
function createWebApprovalSessionManager(
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
    // Web 审批三态覆盖：模拟 settings.web.approvalMode 的注入点（见 session-pool.ts）
    permissionModeOverride,
  });
}

/** 构造单个 bash 工具调用的首轮 LLM 响应 */
function bashToolCallResponse(toolCallId: string, command: string, sideEffects?: string[]): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify(sideEffects ? { command, sideEffects } : { command }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** 查找会话中带 tool_calls 的 assistant 消息（meta.permissions 断言用） */
function findAssistantWithToolCalls(manager: SessionManager, sessionId: string) {
  return manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);
}

// ---------------------------------------------------------------------------
// WA-I01：auto 模式非高危只读 bash → 自动放行直通执行
// ---------------------------------------------------------------------------

test("web auto approval passes readonly bash without ask_permission (WA-I01)", async () => {
  const workspace = createTempDir("deepcode-web-auto-wa01-workspace-");
  const home = createTempDir("deepcode-web-auto-wa01-home-");
  setHomeDir(home);

  const manager = createWebApprovalSessionManager(
    workspace,
    [bashToolCallResponse("call-ls", "ls -la", ["read-in-cwd"]), createChatResponse("done")],
    { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "auto"
  );

  const sessionId = await manager.createSession({ text: "列出文件" });
  const session = manager.getSession(sessionId);
  const assistant = findAssistantWithToolCalls(manager, sessionId);

  // 会话不因审批停摆；permissions 被改判 allow（applyAutoApprovalFilter 就地改判）
  assert.equal(session?.status, "completed");
  assert.equal(session?.askPermissions, undefined);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-ls", permission: "allow" }]);
  // 工具真实执行（存在 tool 角色消息且执行成功）
  const toolMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "tool");
  assert.ok(toolMessage, "只读命令应真实执行并产生 tool 消息");
});

// ---------------------------------------------------------------------------
// WA-I02：manual 模式同一只读命令仍弹审批（零回归）
// ---------------------------------------------------------------------------

test("web manual approval still asks readonly bash (WA-I02)", async () => {
  const workspace = createTempDir("deepcode-web-auto-wa02-workspace-");
  const home = createTempDir("deepcode-web-auto-wa02-home-");
  setHomeDir(home);

  const manager = createWebApprovalSessionManager(
    workspace,
    [bashToolCallResponse("call-ls-manual", "ls -la", ["read-in-cwd"])],
    { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "manual"
  );

  const sessionId = await manager.createSession({ text: "列出文件" });
  const session = manager.getSession(sessionId);

  // 手动审批模式下只读命令也须人工确认（自动放行仅在 auto 生效）
  assert.equal(session?.status, "ask_permission");
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-ls-manual");
  assert.equal(
    manager.listSessionMessages(sessionId).some((message) => message.role === "tool"),
    false,
    "审批未决策前工具不得执行"
  );
});

// ---------------------------------------------------------------------------
// WA-I03：auto + askAll 下非只读 bash（写副作用）→ 保持人工审批
// ---------------------------------------------------------------------------

test("web auto approval keeps ask for non-readonly bash write command (WA-I03)", async () => {
  const workspace = createTempDir("deepcode-web-auto-wa03-workspace-");
  const home = createTempDir("deepcode-web-auto-wa03-home-");
  setHomeDir(home);

  const manager = createWebApprovalSessionManager(
    workspace,
    // 第二条为合成收尾响应：ask_permission 停摆理论上不再发起 LLM 调用，
    // 兜底消费防止测试夹具遗漏导致误报（正确行为下该条永不被消费）
    // "echo" 命中只读前缀但重定向写入被只读判据的元字符检查拒绝，
    // 精确命中"前缀在白名单、整串非只读"的收窄边界
    [
      bashToolCallResponse("call-write-shell", "echo hi > note.txt", ["write-in-cwd"]),
      createChatResponse("unexpected"),
    ],
    // defaultMode=askAll：未列入 allow 白名单的 scope（write-in-cwd）在 auto
    // 模式下进入待审批集合，才能测到"自动放行只覆盖只读命令"的收窄边界
    { mode: "auto", allow: [], deny: [], ask: [], defaultMode: "askAll", addWorkingDirs: [] },
    "auto"
  );

  const sessionId = await manager.createSession({ text: "写个笔记" });
  const session = manager.getSession(sessionId);

  // 命令含重定向写入：不在只读白名单 → 自动放行不覆盖，保持人工审批
  assert.equal(session?.status, "ask_permission", `审批停摆异常（failReason=${session?.failReason}）`);
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-write-shell");
});

// ---------------------------------------------------------------------------
// WA-I04：auto 模式灾难命令命中黑名单 → 必须人工审批（安全底线）
// ---------------------------------------------------------------------------

test("web auto approval never passes blacklisted catastrophic command (WA-I04)", async () => {
  const workspace = createTempDir("deepcode-web-auto-wa04-workspace-");
  const home = createTempDir("deepcode-web-auto-wa04-home-");
  setHomeDir(home);

  const manager = createWebApprovalSessionManager(
    workspace,
    [bashToolCallResponse("call-rmrf-auto", "rm -rf /", ["delete-in-cwd"])],
    // defaultMode=askAll：确保灾难命令进入 askPermissions 而非被 defaultMode 直接放行
    { mode: "auto", allow: [], deny: [], ask: [], defaultMode: "askAll", addWorkingDirs: [] },
    undefined
  );

  const sessionId = await manager.createSession({ text: "删除一切" });
  const session = manager.getSession(sessionId);

  // CommandSafety 黑名单命中 → applyAutoApprovalFilter 第二级判据必须拒绝放行
  assert.equal(session?.status, "ask_permission");
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-rmrf-auto");
});

// ---------------------------------------------------------------------------
// WA-I05：会话级"总是允许"登记 → 同 scope 工具调用直接改判 allow（任何模式生效）
// ---------------------------------------------------------------------------

test("session always allows scope converts write ask to allow without persisting settings (WA-I05)", async () => {
  const workspace = createTempDir("deepcode-web-auto-wa05-workspace-");
  const home = createTempDir("deepcode-web-auto-wa05-home-");
  setHomeDir(home);

  const manager = createWebApprovalSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write-always",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      file_path: path.join(workspace, "always.txt"),
                      content: "always-allowed",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      createChatResponse("done"),
    ],
    // 手动审批模式：write 本须弹卡片；会话级登记后须直接放行
    { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    "manual"
  );

  // 模拟 Web 审批卡片「本次会话总是允许」回填通道（session-pool.ts 调 manager 登记）
  manager.addSessionAlwaysAllows(["write-in-cwd"]);

  const sessionId = await manager.createSession({ text: "写文件（总是允许）" });
  const session = manager.getSession(sessionId);
  const assistant = findAssistantWithToolCalls(manager, sessionId);

  // 第一级"会话级总是允许"生效：ask 改判 allow，工具实际落盘
  assert.equal(session?.status, "completed");
  assert.equal(session?.askPermissions, undefined);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-write-always", permission: "allow" }]);
  assert.equal(fs.readFileSync(path.join(workspace, "always.txt"), "utf8"), "always-allowed");
  // R5 防线：会话级登记绝不落盘项目级配置（个人区不写 permissions.allow）
  assert.equal(fs.existsSync(path.join(workspace, ".deepcode", "settings.json")), false);
});
