/**
 * Web 宿主权限默认策略回归测试（修复 2026-10-04 "Web bash 不像 CLI 自动执行"）
 *
 * 根因：Web 模式 ignoreProjectSettings=true 且个人工作区无 permissions 配置时，
 * resolved settings 的 permissions 为空 → effectivePermissionSettings 传 undefined
 * → 权限评估直落 evaluatePermissionScopes 内部默认值（mode:"manual"）→ bash 任意
 * 命令（含只读 ls/git status）全部弹审批卡片，与 CLI 行为分叉。
 *
 * 修复：Web（ignoreProjectSettings=true）且无显式权限配置时注入 auto + allowAll
 * 策略（与 CLI 历史默认一致）；CLI 路径（ignoreProjectSettings=false）行为不变。
 *
 * 关联设计文档：docs/dev/permission-modes.md §3.3
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { SessionManager } from "../session";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

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
});

/** 创建隔离临时目录 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 技能匹配请求旁路：SessionManager 内部技能匹配走 json_object 响应格式（与参考测试夹具一致） */
function isSkillMatchingRequest(request: any): boolean {
  return request?.response_format?.type === "json_object";
}

function createSkillMatchingResponse(): unknown {
  return { choices: [{ message: { content: JSON.stringify({ skillNames: [] }) } }] };
}

/**
 * 构造可配置权限注入形态的 SessionManager。
 *
 * @param projectRoot 工作区（隔离临时目录）
 * @param responses 依次消费的 LLM 响应队列（技能匹配请求自动旁路）
 * @param permissions resolved settings 的 permissions（undefined = 完全不提供，模拟 Web 空配置）
 * @param ignoreProjectSettings Web 宿主开关（true = Web 模式）
 * @param permissionModeOverride 三态覆盖注入（模拟未来 Web 设置面板透传）
 */
function createWebPermissionSessionManager(
  projectRoot: string,
  responses: unknown[],
  permissions: Record<string, unknown> | undefined,
  ignoreProjectSettings: boolean,
  permissionModeOverride?: "manual" | "auto" | "bypass"
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const next = responses.shift();
          assert.ok(next, "expected a queued chat response");
          return next;
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
      apiKey: "test-api-key",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () =>
      ({
        model: "test-model",
        // permissions 为 undefined 时模拟 Web 个人工作区完全无权限配置的形态
        ...(permissions !== undefined ? { permissions } : {}),
      }) as any,
    renderMarkdown: (text: string) => text,
    onAssistantMessage: () => {},
    ignoreProjectSettings,
    permissionModeOverride,
  });
}

/** 查找会话中带 tool_calls 的 assistant 消息（meta.permissions 断言用） */
function findAssistantWithToolCalls(manager: SessionManager, sessionId: string) {
  return manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);
}

// ---------------------------------------------------------------------------
// WP-01：Web 空权限配置 → bash 直通 allow（回归主修复点）
// ---------------------------------------------------------------------------

test("Web ignoreProjectSettings + 空权限配置：bash 工具直通 allow，不弹审批（WP-01）", async () => {
  const workspace = createTempDir("deepcode-web-perm-wp01-");
  const home = createTempDir("deepcode-web-perm-wp01-home-");
  setHomeDir(home);

  const manager = createWebPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_ls_1",
                  type: "function",
                  function: {
                    name: "bash",
                    // sideEffects 必须提供：缺失会被 parseBashSideEffects 归为 unknown →
                    // 无条件 ask（P0 安全修复），与权限模式无关，测不到本次修复点
                    arguments: JSON.stringify({ command: "ls -la", sideEffects: ["read-in-cwd"] }),
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "完成" } }] },
    ],
    undefined, // permissions 完全不提供 —— 模拟 Web 个人工作区空配置
    true // Web 模式
  );

  const sessionId = await manager.createSession({ text: "列出文件" });

  const assistant = findAssistantWithToolCalls(manager, sessionId);
  assert.ok(assistant, "应存在带 tool_calls 的 assistant 消息");
  const permissionsMeta = (assistant!.meta as any)?.permissions ?? [];
  const lsDecision = permissionsMeta.find((p: any) => p.toolCallId === "call_ls_1");
  assert.ok(lsDecision, "bash 调用应有权限判定记录");
  // 核心断言：修复前此处是 "ask"（内部默认 manual）→ Web 弹审批卡片与 CLI 分叉；
  // 修复后注入 auto+allowAll → "allow" 直通，与 CLI 历史默认一致
  assert.equal(lsDecision.permission, "allow", "Web 空配置下 bash 必须直通 allow（与 CLI allowAll 一致）");

  // 会话不应停在 ask_permission 状态（bash 直通后轮次正常收敛）
  const entry = manager.getSession(sessionId);
  assert.notEqual(entry?.status, "ask_permission", "bash 直通后会话不得停在 ask_permission");
});

// ---------------------------------------------------------------------------
// WP-02：Web 模式显式权限配置优先于注入的默认策略（用户意志不被覆盖）
// ---------------------------------------------------------------------------

test("Web ignoreProjectSettings + 显式 manual 配置：ask 行为保留，默认策略不覆盖用户意志（WP-02）", async () => {
  const workspace = createTempDir("deepcode-web-perm-wp02-");
  const home = createTempDir("deepcode-web-perm-wp02-home-");
  setHomeDir(home);

  const manager = createWebPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_ls_2",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: "ls -la", sideEffects: ["read-in-cwd"] }),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    // 显式 manual 配置（用户在 Web 设置面板选择手动审批后的持久化形态）
    { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] },
    true
  );

  const sessionId = await manager.createSession({ text: "列出文件" });
  // Web 空配置修复不得覆盖显式配置：manual 下 bash 仍须询问
  await manager.handleUserPrompt({ text: "列出文件" });

  const assistant = findAssistantWithToolCalls(manager, sessionId);
  assert.ok(assistant, "应存在带 tool_calls 的 assistant 消息");
  const permissionsMeta = (assistant!.meta as any)?.permissions ?? [];
  const lsDecision = permissionsMeta.find((p: any) => p.toolCallId === "call_ls_2");
  assert.ok(lsDecision, "bash 调用应有权限判定记录");
  assert.equal(lsDecision.permission, "ask", "显式 manual 配置下 bash 必须仍为 ask（用户意志优先）");
});

// ---------------------------------------------------------------------------
// WP-03：CLI 路径（ignoreProjectSettings=false）空配置行为不变（零回归）
// ---------------------------------------------------------------------------

test("CLI 路径空权限配置：effectivePermissionSettings 仍为 undefined，旧行为零回归（WP-03）", async () => {
  const workspace = createTempDir("deepcode-web-perm-wp03-");
  const home = createTempDir("deepcode-web-perm-wp03-home-");
  setHomeDir(home);

  const manager = createWebPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_ls_3",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: "ls -la", sideEffects: ["read-in-cwd"] }),
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "完成" } }] },
    ],
    undefined, // 空配置
    false // CLI 模式：修复逻辑不注入默认策略，行为与修复前完全一致
  );

  const sessionId = await manager.createSession({ text: "列出文件" });
  await manager.handleUserPrompt({ text: "列出文件" });

  const assistant = findAssistantWithToolCalls(manager, sessionId);
  assert.ok(assistant, "应存在带 tool_calls 的 assistant 消息");
  const permissionsMeta = (assistant!.meta as any)?.permissions ?? [];
  const lsDecision = permissionsMeta.find((p: any) => p.toolCallId === "call_ls_3");
  assert.ok(lsDecision, "bash 调用应有权限判定记录");
  // CLI 空配置走 evaluatePermissionScopes 的 undefined 默认参数（allowAll）——
  // 修复前后一致：bash 只读直通。此断言保护 CLI 路径不被 Web 注入逻辑影响。
  assert.equal(lsDecision.permission, "allow", "CLI 空配置行为保持修复前语义（undefined → 默认 allowAll）");
});

// ---------------------------------------------------------------------------
// WP-04：Web permissionModeOverride 注入通路预铺（未来设置面板透传生效）
// ---------------------------------------------------------------------------

test("Web permissionModeOverride manual：覆盖注入的 auto 默认，bash 回到 ask（WP-04）", async () => {
  const workspace = createTempDir("deepcode-web-perm-wp04-");
  const home = createTempDir("deepcode-web-perm-wp04-home-");
  setHomeDir(home);

  const manager = createWebPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_ls_4",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: "ls -la", sideEffects: ["read-in-cwd"] }),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    undefined,
    true,
    "manual" // Web 设置面板选择手动审批 → 透传 override
  );

  const sessionId = await manager.createSession({ text: "列出文件" });
  await manager.handleUserPrompt({ text: "列出文件" });

  const assistant = findAssistantWithToolCalls(manager, sessionId);
  assert.ok(assistant, "应存在带 tool_calls 的 assistant 消息");
  const permissionsMeta = (assistant!.meta as any)?.permissions ?? [];
  const lsDecision = permissionsMeta.find((p: any) => p.toolCallId === "call_ls_4");
  assert.ok(lsDecision, "bash 调用应有权限判定记录");
  // override 优先于注入的 auto 默认：mode=manual → 未显式 allow 的 scope 一律 ask
  assert.equal(lsDecision.permission, "ask", "Web override=manual 必须覆盖注入的 auto 默认回到 ask");
});
