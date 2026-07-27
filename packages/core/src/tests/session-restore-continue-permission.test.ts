/**
 * SessionManager restoreSession / /continue / snippet / activateSession / permission 测试套件
 *
 * 覆盖方法群：
 * - /continue：replySession continues without appending /continue、
 *   /continue runs trailing pending tool calls、rebuilds snippet state from read history、
 *   no manual-change notice for /continue
 * - restoreSession：restoreSessionConversation truncates messages、
 *   restoreSessionCode restores project files、preserves pre-existing files、
 *   restores deleted tracked files
 * - activateSession：pauses for permission when ask、temporarily asks in Plan Mode
 * - permission：preserves permission_denied status on reload、
 *   applies permission replies + alwaysAllow、turns denied into tool errors、
 *   preserves raw session messages when previous tool call pending
 *
 * 共 13 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { GitFileHistory } from "../common/file-history";
import { clearSessionState } from "../common/state";
import type { SessionMessage } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createPermissionSessionManager,
  createChatResponse,
  createToolCallResponse,
  buildTestMessage,
  createFileHistoryCommit,
  getFileHistoryGitDir,
  hasGit,
  flushPromises,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("replySession continues without appending /continue as a user message", async () => {
  const workspace = createTempDir(env, "deepcode-continue-workspace-");
  const home = createTempDir(env, "deepcode-continue-home-");
  env.setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-continue");
  const activatedSessionIds: string[] = [];
  (manager as any).activateSession = async (sessionId: string) => {
    activatedSessionIds.push(sessionId);
  };

  const sessionId = await manager.createSession({ text: "first prompt" });
  await flushPromises();
  const messagesBefore = manager.listSessionMessages(sessionId);
  fetchCalls.length = 0;
  activatedSessionIds.length = 0;

  await manager.replySession(sessionId, { text: "/continue" });
  await flushPromises();

  const messagesAfter = manager.listSessionMessages(sessionId);
  const userMessages = messagesAfter.filter((message) => message.role === "user");

  assert.equal(activatedSessionIds.length, 1);
  assert.equal(activatedSessionIds[0], sessionId);
  assert.equal(messagesAfter.length, messagesBefore.length);
  assert.equal(
    userMessages.some((message) => message.content === "/continue"),
    false
  );
  assert.equal(fetchCalls.length, 0);
});

test("restoreSessionConversation truncates messages before the selected user prompt", async () => {
  const workspace = createTempDir(env, "deepcode-undo-conversation-workspace-");
  const home = createTempDir(env, "deepcode-undo-conversation-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-undo-conversation");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const firstAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "first answer",
    null,
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, firstAssistant);
  await manager.replySession(sessionId, { text: "second prompt" });
  const secondUserMessage = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "user")
    .at(-1);
  assert.ok(secondUserMessage);
  const secondAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "second answer",
    null,
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, secondAssistant);

  manager.restoreSessionConversation(sessionId, secondUserMessage.id);

  const contents = manager.listSessionMessages(sessionId).map((message) => message.content);
  assert.ok(contents.includes("first prompt"));
  assert.ok(contents.includes("first answer"));
  assert.ok(!contents.includes("second prompt"));
  assert.ok(!contents.includes("second answer"));
  assert.equal(manager.getSession(sessionId)?.assistantReply, "first answer");
});

test("restoreSessionCode restores project files from the recorded Git checkpoint", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-undo-code-workspace-");
  const home = createTempDir(env, "deepcode-undo-code-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-undo-code");
  const sessionId = "session-code-restore";
  const checkpointHash = createFileHistoryCommit(home, workspace, sessionId, { "tracked.txt": "before\n" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  assert.ok(fileHistory.recordCheckpoint(sessionId, [path.join(workspace, "new.txt")], "pre-create new.txt"));
  createFileHistoryCommit(home, workspace, sessionId, { "tracked.txt": "after\n", "new.txt": "remove me\n" });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "after\n", "utf8");
  fs.writeFileSync(path.join(workspace, "new.txt"), "remove me\n", "utf8");

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-with-checkpoint", sessionId, "user", "restore here"),
    checkpointHash,
  });

  manager.restoreSessionCode(sessionId, "user-with-checkpoint");

  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
});

test("restoreSessionCode preserves files that predate their first tracked mutation", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-undo-preexisting-files-workspace-");
  const home = createTempDir(env, "deepcode-undo-preexisting-files-home-");
  env.setHomeDir(home);

  const readmePath = path.join(workspace, "README.md");
  const readmeEnPath = path.join(workspace, "README-en.md");
  const readmeZhPath = path.join(workspace, "README-zh_CN.md");
  fs.writeFileSync(readmePath, "这是一个hello world演示项目\n", "utf8");
  fs.writeFileSync(readmeEnPath, "This is a hello world demo project.\n", "utf8");
  fs.writeFileSync(readmeZhPath, "", "utf8");

  const manager = createSessionManager(workspace, "machine-id-undo-preexisting-files");
  const sessionId = "session-undo-preexisting-files";
  const gitDir = getFileHistoryGitDir(home, workspace);
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);

  const targetCheckpoint = fileHistory.recordCheckpoint(
    sessionId,
    [readmePath, readmeEnPath],
    "checkpoint before syncing all readmes"
  );
  assert.ok(targetCheckpoint);

  assert.ok(fileHistory.recordCheckpoint(sessionId, [readmeZhPath], "pre-sync zh readme"));
  fs.writeFileSync(readmePath, "Synced readme\n", "utf8");
  fs.writeFileSync(readmeEnPath, "Synced readme\n", "utf8");
  fs.writeFileSync(readmeZhPath, "Synced readme\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [readmePath, readmeEnPath, readmeZhPath], "synced readmes"));

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-with-readme-checkpoint", sessionId, "user", "sync README*.md"),
    checkpointHash: targetCheckpoint,
  });

  manager.restoreSessionCode(sessionId, "user-with-readme-checkpoint");

  assert.equal(fs.readFileSync(readmePath, "utf8"), "这是一个hello world演示项目\n");
  assert.equal(fs.readFileSync(readmeEnPath, "utf8"), "This is a hello world demo project.\n");
  assert.equal(fs.readFileSync(readmeZhPath, "utf8"), "");
});

test("restoreSessionCode restores deleted tracked files and leaves unrelated files alone", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-undo-deleted-files-workspace-");
  const home = createTempDir(env, "deepcode-undo-deleted-files-home-");
  env.setHomeDir(home);

  const trackedPath = path.join(workspace, "tracked.txt");
  const unrelatedPath = path.join(workspace, "unrelated.txt");
  fs.writeFileSync(trackedPath, "before delete\n", "utf8");
  fs.writeFileSync(unrelatedPath, "do not touch\n", "utf8");

  const manager = createSessionManager(workspace, "machine-id-undo-deleted-files");
  const sessionId = "session-undo-deleted-files";
  const gitDir = getFileHistoryGitDir(home, workspace);
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);
  const targetCheckpoint = fileHistory.recordCheckpoint(sessionId, [trackedPath], "before delete");
  assert.ok(targetCheckpoint);

  fs.unlinkSync(trackedPath);
  assert.ok(fileHistory.recordCheckpoint(sessionId, [trackedPath], "after delete"));

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-before-delete", sessionId, "user", "restore deleted file"),
    checkpointHash: targetCheckpoint,
  });

  manager.restoreSessionCode(sessionId, "user-before-delete");

  assert.equal(fs.readFileSync(trackedPath, "utf8"), "before delete\n");
  assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "do not touch\n");
});

test("replySession /continue runs trailing pending tool calls before requesting another response", async () => {
  const workspace = createTempDir(env, "deepcode-continue-tool-workspace-");
  const home = createTempDir(env, "deepcode-continue-tool-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("continued after tool", {
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const pendingAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to read a file",
    [
      {
        id: "call-pending-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: path.join(workspace, "note.txt") }) },
      },
    ],
    null
  ) as SessionMessage;
  fs.writeFileSync(path.join(workspace, "note.txt"), "hello from pending tool\n", "utf8");
  (manager as any).appendSessionMessage(sessionId, pendingAssistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, { text: "/continue" });

  const messages = manager.listSessionMessages(sessionId);
  const toolMessage = messages.find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "call-pending-read";
  });
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const userMessages = messages.filter((message) => message.role === "user");

  assert.ok(toolMessage);
  assert.match(toolMessage.content ?? "", /hello from pending tool/);
  assert.equal(assistantMessages[assistantMessages.length - 1]?.content, "continued after tool");
  assert.equal(
    userMessages.some((message) => message.content === "/continue"),
    false
  );
});

test("replySession rebuilds snippet state from persisted read history before editing", async () => {
  const workspace = createTempDir(env, "deepcode-rebuild-snippet-workspace-");
  const home = createTempDir(env, "deepcode-rebuild-snippet-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "note.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\n", "utf8");

  const responses = [
    createToolCallResponse(
      [
        {
          id: "call-edit",
          type: "function",
          function: {
            name: "edit",
            arguments: JSON.stringify({
              snippet_id: "full_file_5",
              file_path: filePath,
              old_string: "beta",
              new_string: "gamma",
            }),
          },
        },
      ],
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    ),
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const readToolMessage = (manager as any).buildToolMessage(
    sessionId,
    "call-read",
    JSON.stringify({
      ok: true,
      name: "read",
      output: "     1\talpha\n     2\tbeta\n",
      metadata: {
        snippet: {
          id: "full_file_5",
          filePath,
          startLine: 1,
          endLine: 3,
        },
      },
    }),
    { name: "read", arguments: JSON.stringify({ file_path: filePath }) }
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, readToolMessage);

  clearSessionState(sessionId);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, { text: "change beta" });

  assert.equal(fs.readFileSync(filePath, "utf8"), "alpha\ngamma\n");
  const editToolMessage = manager.listSessionMessages(sessionId).find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "call-edit";
  });
  assert.ok(editToolMessage);
  assert.match(editToolMessage.content ?? "", /"ok":true|"ok": true/);
  assert.doesNotMatch(editToolMessage.content ?? "", /Unknown snippet_id/);
});

test("activateSession pauses for permission when a tool call requires ask", async () => {
  const workspace = createTempDir(env, "deepcode-permission-ask-workspace-");
  const home = createTempDir(env, "deepcode-permission-ask-home-");
  env.setHomeDir(home);

  const manager = createPermissionSessionManager(
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
                    arguments: JSON.stringify({
                      command: "rg TODO src",
                      description: "Search TODO markers",
                      sideEffects: ["read-in-cwd"],
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
    {
      allow: [],
      deny: [],
      ask: [],
      defaultMode: "askAll",
    }
  );

  const sessionId = await manager.createSession({ text: "search todos" });
  const session = manager.getSession(sessionId);
  const assistant = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);

  assert.equal(session?.status, "ask_permission");
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-bash");
  assert.deepEqual(session?.askPermissions?.[0]?.scopes, ["read-in-cwd"]);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-bash", permission: "ask" }]);
  assert.equal(
    manager.listSessionMessages(sessionId).some((message) => message.role === "tool"),
    false
  );
});

test("activateSession temporarily asks before allowed writes in Plan Mode", async () => {
  const workspace = createTempDir(env, "deepcode-plan-permission-workspace-");
  const home = createTempDir(env, "deepcode-plan-permission-home-");
  env.setHomeDir(home);

  const manager = createPermissionSessionManager(
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
                    arguments: JSON.stringify({ file_path: path.join(workspace, "plan.txt"), content: "planned" }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    {
      allow: ["write-in-cwd"],
      deny: [],
      ask: [],
      defaultMode: "allowAll",
    }
  );

  const sessionId = await manager.createSession({ text: "Plan this change", planMode: true });
  const session = manager.getSession(sessionId);
  const assistant = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);

  assert.equal(session?.status, "ask_permission");
  assert.deepEqual(session?.askPermissions?.[0]?.scopes, ["write-in-cwd"]);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-write", permission: "ask" }]);
});

test("SessionManager preserves permission_denied status when sessions are reloaded", async () => {
  const workspace = createTempDir(env, "deepcode-permission-denied-workspace-");
  const home = createTempDir(env, "deepcode-permission-denied-home-");
  env.setHomeDir(home);

  const permissions = {
    allow: [],
    deny: [],
    ask: [],
    defaultMode: "askAll" as const,
  };
  const manager = createPermissionSessionManager(
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
                    arguments: JSON.stringify({
                      command: "rg TODO src",
                      description: "Search TODO markers",
                      sideEffects: ["read-in-cwd"],
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    permissions
  );

  const sessionId = await manager.createSession({ text: "search todos" });
  manager.denySessionPermission(sessionId);

  const reloadedManager = createPermissionSessionManager(workspace, [], permissions);
  const reloadedSession = reloadedManager.getSession(sessionId);

  assert.equal(reloadedSession?.status, "permission_denied");
  assert.equal(reloadedSession?.failReason, "Permission denied by user");
});

test("replySession applies permission replies, runs pending tools, and stores always allow scopes", async () => {
  const workspace = createTempDir(env, "deepcode-permission-allow-workspace-");
  const home = createTempDir(env, "deepcode-permission-allow-home-");
  env.setHomeDir(home);
  fs.writeFileSync(path.join(workspace, "note.txt"), "allowed content\n", "utf8");

  const manager = createPermissionSessionManager(
    workspace,
    [createChatResponse("continued", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
    {
      allow: [],
      deny: [],
      ask: ["read-in-cwd"],
      defaultMode: "allowAll",
    }
  );
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};
  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to read",
    [
      {
        id: "call-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: path.join(workspace, "note.txt") }) },
      },
    ],
    null
  ) as SessionMessage;
  assistant.meta = { ...(assistant.meta ?? {}), permissions: [{ toolCallId: "call-read", permission: "ask" }] };
  (manager as any).appendSessionMessage(sessionId, assistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, {
    text: "/continue",
    permissions: [{ toolCallId: "call-read", permission: "allow" }],
    alwaysAllows: ["read-in-cwd"],
  });

  const toolMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "tool");
  const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".deepcode", "settings.json"), "utf8"));

  assert.match(toolMessage?.content ?? "", /allowed content/);
  assert.deepEqual(settings.permissions.allow, ["read-in-cwd"]);
  assert.equal(manager.getSession(sessionId)?.status, "completed");
});

test("replySession turns denied permission replies into tool errors before appending user text", async () => {
  const workspace = createTempDir(env, "deepcode-permission-deny-workspace-");
  const home = createTempDir(env, "deepcode-permission-deny-home-");
  env.setHomeDir(home);

  const manager = createPermissionSessionManager(
    workspace,
    [createChatResponse("handled denial", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
    {
      allow: [],
      deny: [],
      ask: ["write-out-cwd"],
      defaultMode: "allowAll",
    }
  );
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};
  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to write",
    [
      {
        id: "call-write",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/outside.txt", content: "x" }) },
      },
    ],
    null
  ) as SessionMessage;
  assistant.meta = { ...(assistant.meta ?? {}), permissions: [{ toolCallId: "call-write", permission: "ask" }] };
  (manager as any).appendSessionMessage(sessionId, assistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, {
    text: "Do not write outside the workspace.",
    permissions: [{ toolCallId: "call-write", permission: "deny" }],
  });

  const messages = manager.listSessionMessages(sessionId);
  const assistantIndex = messages.findIndex((message) => message.id === assistant.id);
  const toolMessage = messages[assistantIndex + 1];
  const userMessage = messages[assistantIndex + 2];

  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /User denied the required permission/);
  assert.equal(userMessage?.role, "user");
  assert.equal(userMessage?.content, "Do not write outside the workspace.");
});

test("replySession preserves raw session messages when a previous tool call is pending", async () => {
  const workspace = createTempDir(env, "deepcode-pending-tool-workspace-");
  const home = createTempDir(env, "deepcode-pending-tool-home-");
  env.setHomeDir(home);

  globalThis.fetch = (async () =>
    ({
      ok: true,
      text: async () => "",
    }) as Response) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-pending-tool");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistantMessage = (manager as any).buildAssistantMessage(
    sessionId,
    "I will run a tool.",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"sleep 100"}' },
      },
    ],
    ""
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, assistantMessage);

  await manager.replySession(sessionId, { text: "second prompt" });

  const messages = manager.listSessionMessages(sessionId);
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
  assert.notEqual(assistantIndex, -1);
  assert.equal(messages[assistantIndex + 1]?.role, "user");
  assert.equal(messages[assistantIndex + 1]?.content, "second prompt");
  assert.equal(
    messages.some((message) => String(message.content).includes("Previous tool call did not complete.")),
    false
  );
});
