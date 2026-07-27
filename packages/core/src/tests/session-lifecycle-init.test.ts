/**
 * SessionManager 生命周期与初始化测试套件
 *
 * 覆盖方法群：
 * - getProjectCode：短/长 project root 哈希
 * - createSession AGENTS 路径：/init .deepcode AGENTS、root AGENTS、generate prompt
 * - replySession AGENTS 路径：/init root AGENTS、skill matching 系统提示
 * - 默认系统提示顺序：prefix-cache-friendly order、disabled default skills
 * - 上报：machineId token 报告（createSession/replySession）、fetch 失败静默、
 *   成功/失败完成通知
 *
 * 共 14 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, getProjectCode } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createMockedClientSessionManagerWithClient,
  createNotifyingSessionManager,
  createChatResponse,
  createSkillMatchingResponse,
  isSkillMatchingRequest,
  flushPromises,
  waitForNotifyRecords,
  createNotifyRecorderScript,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("getProjectCode shortens long project roots for Windows-compatible storage paths", () => {
  const shortRoot = "short-project";
  assert.equal(getProjectCode(shortRoot), shortRoot.replace(/[\\/]/g, "-").replace(/:/g, ""));

  const longRoot = path.join(
    os.tmpdir(),
    "deepcode-project-code-workspace-with-a-long-name-that-would-create-long-git-internal-paths"
  );
  const projectCode = getProjectCode(longRoot);

  assert.ok(projectCode.length <= 64);
  assert.match(projectCode, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(projectCode, longRoot.replace(/[\\/]/g, "-").replace(/:/g, ""));
});

test("SessionManager normalizes legacy sessions without activeTokens to zero", () => {
  const workspace = createTempDir(env, "deepcode-legacy-active-tokens-workspace-");
  const home = createTempDir(env, "deepcode-legacy-active-tokens-home-");
  env.setHomeDir(home);

  const projectCode = getProjectCode(workspace);
  const projectDir = path.join(home, ".deepcode", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "legacy-session",
          status: "completed",
          usage: { total_tokens: 123 },
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-legacy");

  assert.equal(manager.getSession("legacy-session")?.activeTokens, 0);
  assert.equal(manager.getSession("legacy-session")?.usagePerModel, null);
});

test("createSession stores /init and sends the active .deepcode project AGENTS path to the LLM", async () => {
  const workspace = createTempDir(env, "deepcode-init-deepcode-workspace-");
  const home = createTempDir(env, "deepcode-init-deepcode-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(workspace, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".deepcode", "AGENTS.md"), "deepcode project instructions", "utf8");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-deepcode");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessage = messages.find((message) => message.role === "user");
  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: string;
  }>;
  const openAIUserMessage = openAIMessages.find((message) => message.role === "user");
  const systemContents = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(userMessage?.content, "/init");
  assert.match(openAIUserMessage?.content ?? "", /Update \.\/\.deepcode\/AGENTS\.md/);
  assert.doesNotMatch(openAIUserMessage?.content ?? "", /Update \.\/AGENTS\.md/);
  assert.ok(systemContents.includes("deepcode project instructions"));
  assert.ok(!systemContents.includes("root project instructions"));
});

test("createSession appends default system prompts in prefix-cache-friendly order", async () => {
  const workspace = createTempDir(env, "deepcode-system-order-workspace-");
  const home = createTempDir(env, "deepcode-system-order-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-system-order");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "hello" });
  const systemContents = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(systemContents.length >= 4, true);
  assert.match(systemContents[0] ?? "", /# Available Tools/);
  assert.doesNotMatch(systemContents[0] ?? "", /# Local Workspace Environment/);
  assert.doesNotMatch(systemContents[0] ?? "", /当前LLM模型为test-model/);
  assert.match(systemContents[1] ?? "", /<karpathy-guidelines-skill>/);
  assert.match(systemContents[1] ?? "", /# Karpathy Guidelines/);
  assert.doesNotMatch(systemContents[1] ?? "", /path="templates\/skills\//);
  assert.doesNotMatch(systemContents[1] ?? "", /当前LLM模型为test-model/);
  assert.match(systemContents[2] ?? "", /# Local Workspace Environment/);
  assert.match(systemContents[2] ?? "", /当前LLM模型为test-model/);
  const environmentJsonMatch = (systemContents[2] ?? "").match(/```json\n([\s\S]+?)\n```/);
  assert.ok(environmentJsonMatch);
  const environmentInfo = JSON.parse(environmentJsonMatch[1] ?? "{}") as { "root path"?: string };
  assert.equal(environmentInfo["root path"], workspace);
  assert.equal(systemContents[3], "root project instructions");
});

test("createSession skips disabled default skills", async () => {
  const workspace = createTempDir(env, "deepcode-disabled-default-skill-workspace-");
  const home = createTempDir(env, "deepcode-disabled-default-skill-home-");
  env.setHomeDir(home);

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId: "machine-id-disabled-default-skill",
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      // 禁用全部 4 个默认 skill（v1.4 新增 3 个），
      // 验证禁用后默认 skill 内容不进入系统消息
      enabledSkills: {
        "karpathy-guidelines": false,
        "design-aesthetics": false,
        "ui-ux-best-practices": false,
        "code-quality-guidelines": false,
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const sessionId = await manager.createSession({ text: "hello" });
  const systemContents = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(systemContents.length, 2);
  assert.match(systemContents[0] ?? "", /# Available Tools/);
  assert.doesNotMatch(systemContents.join("\n"), /<karpathy-guidelines-skill>/);
  assert.match(systemContents[1] ?? "", /# Local Workspace Environment/);
});

test("createSession includes agent instructions in the skill matching system prompt", async () => {
  const workspace = createTempDir(env, "deepcode-skill-match-create-workspace-");
  const home = createTempDir(env, "deepcode-skill-match-create-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(workspace, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".deepcode", "AGENTS.md"), "prefer project-specific skill matching", "utf8");
  const skillDir = path.join(workspace, ".deepcode", "skills", "project-aware");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: project-aware\ndescription: Match project-specific instructions\n---\n# Project Aware\n",
    "utf8"
  );

  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          return { choices: [{ message: { content: '{"skillNames":[]}' } }] };
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  await manager.createSession({ text: "pick the right workflow" });

  const messages = (requests[0]?.messages ?? []) as Array<{ role?: string; content?: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /<agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /prefer project-specific skill matching/);
  assert.match(messages[0]?.content ?? "", /<\/agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /The candidate skills are as follows/);
  assert.equal(messages[1]?.role, "user");
});

test("replySession includes current agent instructions in the skill matching system prompt", async () => {
  const workspace = createTempDir(env, "deepcode-skill-match-reply-workspace-");
  const home = createTempDir(env, "deepcode-skill-match-reply-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          return { choices: [{ message: { content: '{"skillNames":[]}' } }] };
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "" });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "use reply-time agent instructions", "utf8");
  const skillDir = path.join(workspace, ".agents", "skills", "reply-aware");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: reply-aware\ndescription: Match reply-time instructions\n---\n# Reply Aware\n",
    "utf8"
  );

  await manager.replySession(sessionId, { text: "pick the reply workflow" });

  const messages = (requests[0]?.messages ?? []) as Array<{ role?: string; content?: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /<agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /use reply-time agent instructions/);
  assert.match(messages[0]?.content ?? "", /<\/agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /The candidate skills are as follows/);
  assert.equal(messages[1]?.role, "user");
});

test("replySession stores /init and sends the active root project AGENTS path to the LLM", async () => {
  const workspace = createTempDir(env, "deepcode-init-root-workspace-");
  const home = createTempDir(env, "deepcode-init-root-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-root");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  await manager.replySession(sessionId, { text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessages = messages.filter((message) => message.role === "user");
  const replyMessage = userMessages[userMessages.length - 1];
  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: string;
  }>;
  const openAIUserMessages = openAIMessages.filter((message) => message.role === "user");
  const openAIReplyMessage = openAIUserMessages[openAIUserMessages.length - 1];

  assert.equal(replyMessage?.content, "/init");
  assert.match(openAIReplyMessage?.content ?? "", /Update \.\/AGENTS\.md/);
});

test("createSession stores /init and sends generate prompt when no project AGENTS file is effective", async () => {
  const workspace = createTempDir(env, "deepcode-init-generate-workspace-");
  const home = createTempDir(env, "deepcode-init-generate-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(home, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".deepcode", "AGENTS.md"), "user instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-generate");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessage = messages.find((message) => message.role === "user");
  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: string;
  }>;
  const openAIUserMessage = openAIMessages.find((message) => message.role === "user");

  assert.equal(userMessage?.content, "/init");
  assert.match(openAIUserMessage?.content ?? "", /Generate a file named \.\/AGENTS\.md/);
  assert.doesNotMatch(openAIUserMessage?.content ?? "", /Update \.\/AGENTS\.md/);
});

test("createSession reports a new prompt with the machineId token", async () => {
  const workspace = createTempDir(env, "deepcode-session-workspace-");
  const home = createTempDir(env, "deepcode-session-home-");
  env.setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-123");
  const activatedSessionIds: string[] = [];
  (manager as any).activateSession = async (sessionId: string) => {
    activatedSessionIds.push(sessionId);
  };

  const sessionId = await manager.createSession({ text: "hello world" });
  await flushPromises();

  assert.equal(activatedSessionIds.length, 1);
  assert.equal(activatedSessionIds[0], sessionId);
  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://deepcode.vegamo.cn/api/plugin/new");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {});
  assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-123");
});

test("replySession reports a new prompt with the machineId token", async () => {
  const workspace = createTempDir(env, "deepcode-reply-workspace-");
  const home = createTempDir(env, "deepcode-reply-home-");
  env.setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-456");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  await flushPromises();
  fetchCalls.length = 0;

  await manager.replySession(sessionId, { text: "second prompt" });
  await flushPromises();

  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://deepcode.vegamo.cn/api/plugin/new");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {});
  assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-456");
});

test("reporting a new prompt does not warn when the background request fails", async () => {
  const workspace = createTempDir(env, "deepcode-report-failure-workspace-");
  const home = createTempDir(env, "deepcode-report-failure-home-");
  env.setHomeDir(home);

  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = (async () => {
    throw new Error("fetch failed");
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-failure");
  (manager as any).activateSession = async () => {};

  await manager.createSession({ text: "hello world" });
  await flushPromises();

  assert.deepEqual(warnings, []);
});

test(
  "SessionManager notifies successful completion with session context",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir(env, "deepcode-notify-success-workspace-");
    const home = createTempDir(env, "deepcode-notify-success-home-");
    env.setHomeDir(home);

    const notifyOutput = path.join(workspace, "notify.jsonl");
    const notifyScript = createNotifyRecorderScript(workspace);
    const manager = createNotifyingSessionManager(
      workspace,
      [createChatResponse("final answer", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
      notifyScript,
      notifyOutput
    );

    await manager.createSession({ text: "notify success" });

    const records = await waitForNotifyRecords(notifyOutput, 1);
    assert.equal(records[0]?.STATUS, "completed");
    assert.equal(records[0]?.FAIL_REASON, null);
    assert.equal(records[0]?.BODY, "final answer");
    assert.equal(records[0]?.TITLE, "notify success");
    assert.match(String(records[0]?.DURATION), /^\d+$/);
  }
);

test(
  "SessionManager notifies failed completion with failure context",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir(env, "deepcode-notify-failure-workspace-");
    const home = createTempDir(env, "deepcode-notify-failure-home-");
    env.setHomeDir(home);

    const notifyOutput = path.join(workspace, "notify.jsonl");
    const notifyScript = createNotifyRecorderScript(workspace);
    const manager = createNotifyingSessionManager(
      workspace,
      [
        createChatResponse("first answer", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        new Error("second request failed"),
      ],
      notifyScript,
      notifyOutput
    );

    const sessionId = await manager.createSession({ text: "notify failure" });
    await waitForNotifyRecords(notifyOutput, 1);
    await manager.replySession(sessionId, { text: "second prompt" });

    const records = await waitForNotifyRecords(notifyOutput, 2);
    const failedRecord = records[1];
    assert.equal(failedRecord?.STATUS, "failed");
    assert.equal(failedRecord?.FAIL_REASON, "second request failed");
    assert.equal(failedRecord?.BODY, "first answer");
    assert.notEqual(failedRecord?.BODY, "stale-body");
    assert.equal(failedRecord?.TITLE, "notify failure");
  }
);
