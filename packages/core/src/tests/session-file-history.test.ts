/**
 * SessionManager file-history 测试套件
 *
 * 覆盖方法群：
 * - 初始化：createSession initializes file-history repo and session branch、
 *   empty manifest without scanning existing files
 * - 快照：replySession records checkpointHash、Write tool advances file-history、
 *   Write checkpoints restore tool-touched files outside workspace
 * - 手动编辑：snapshots manual edits、inserts hidden system notice for changed files、
 *   no notice when unchanged、reports manual deletion、ignores untracked files、
 *   no notice for /continue、no notice for permission-only replies
 * - git missing：missing git executable does not block sessions or Write tool calls
 *
 * 共 13 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { GitFileHistory } from "../common/file-history";
import { getProjectCode } from "../session";
import type { SessionMessage } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createChatResponse,
  createFileHistoryCommit,
  getFileHistoryGitDir,
  readFileHistoryManifest,
  runFileHistoryGit,
  hasGit,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("replySession records the current file-history branch head as checkpointHash", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-checkpoint-hash-workspace-");
  const home = createTempDir(env, "deepcode-checkpoint-hash-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-checkpoint-hash");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const checkpointHash = createFileHistoryCommit(home, workspace, sessionId, { "note.txt": "checkpoint\n" });

  await manager.replySession(sessionId, { text: "second prompt" });

  const userMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "user");
  assert.equal(userMessages[userMessages.length - 1]?.checkpointHash, checkpointHash);
});

test("createSession initializes file-history repo and session branch", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-file-history-init-workspace-");
  const home = createTempDir(env, "deepcode-file-history-init-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-file-history-init");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  const gitDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "file-history", ".git");

  assert.ok(fs.existsSync(gitDir));
  assert.ok(userMessage?.checkpointHash);
  assert.equal(
    runFileHistoryGit(gitDir, workspace, ["rev-parse", "--verify", `refs/heads/${sessionId}^{commit}`]).trim(),
    userMessage.checkpointHash
  );
});

test("createSession initializes an empty file-history manifest without scanning existing files", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-file-history-empty-init-workspace-");
  const home = createTempDir(env, "deepcode-file-history-empty-init-home-");
  env.setHomeDir(home);
  fs.writeFileSync(path.join(workspace, "unrelated.txt"), "keep me\n", "utf8");
  fs.mkdirSync(path.join(workspace, "nested"));
  fs.writeFileSync(path.join(workspace, "nested", "another.txt"), "also keep me\n", "utf8");

  const manager = createSessionManager(workspace, "machine-id-file-history-empty-init");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);

  const manifest = readFileHistoryManifest(home, workspace, userMessage.checkpointHash);
  assert.deepEqual(manifest.files, {});
});

test("replySession snapshots manual edits to tracked files before appending the user prompt", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-prompt-checkpoint-manual-edit-workspace-");
  const home = createTempDir(env, "deepcode-prompt-checkpoint-manual-edit-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "hello_world.py");
  const manager = createSessionManager(workspace, "machine-id-prompt-checkpoint-manual-edit");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "create hello world" });
  const gitDir = getFileHistoryGitDir(home, workspace);
  const fileHistory = new GitFileHistory(workspace, gitDir);

  fs.writeFileSync(filePath, 'print("Hello, World!")\n', "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "created hello world"));

  const manualEdit = 'if name == main:\n  print("Hello, World!")\n';
  fs.writeFileSync(filePath, manualEdit, "utf8");
  await manager.replySession(sessionId, { text: "I manually edited @hello_world.py, note it" });
  const manualEditUserMessage = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "user")
    .at(-1);
  assert.ok(manualEditUserMessage?.checkpointHash);

  fs.writeFileSync(filePath, 'if __name__ == "__main__":\n  print("Hello, World!")\n', "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "fixed hello world"));

  manager.restoreSessionCode(sessionId, manualEditUserMessage.id);

  assert.equal(fs.readFileSync(filePath, "utf8"), manualEdit);
});

test("replySession inserts hidden system notice for manually changed tracked files", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-manual-change-notice-workspace-");
  const home = createTempDir(env, "deepcode-manual-change-notice-home-");
  env.setHomeDir(home);

  const firstPath = path.join(workspace, "a.txt");
  const secondPath = path.join(workspace, "b.txt");
  const manager = createSessionManager(workspace, "machine-id-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(firstPath, "one\n", "utf8");
  fs.writeFileSync(secondPath, "two\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [secondPath, firstPath], "track files"));

  fs.writeFileSync(secondPath, "two changed\n", "utf8");
  fs.writeFileSync(firstPath, "one changed\n", "utf8");
  await manager.replySession(sessionId, { text: "check manual changes" });

  const messages = manager.listSessionMessages(sessionId);
  const userIndex = messages.findIndex(
    (message) => message.role === "user" && message.content === "check manual changes"
  );
  assert.ok(userIndex > 0);
  const notice = messages[userIndex - 1];
  assert.equal(notice?.role, "system");
  assert.equal(notice?.visible, false);
  assert.equal(notice?.content, `Note that the user manually modified these files:\n${firstPath}\n${secondPath}`);
});

test("replySession does not insert manual-change notice when tracked files are unchanged", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-no-manual-change-notice-workspace-");
  const home = createTempDir(env, "deepcode-no-manual-change-notice-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "tracked.txt");
  const manager = createSessionManager(workspace, "machine-id-no-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "same\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));

  await manager.replySession(sessionId, { text: "second prompt" });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("replySession reports manual deletion of a tracked file", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-manual-delete-notice-workspace-");
  const home = createTempDir(env, "deepcode-manual-delete-notice-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "deleted.txt");
  const manager = createSessionManager(workspace, "machine-id-manual-delete-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "delete me\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));

  fs.unlinkSync(filePath);
  await manager.replySession(sessionId, { text: "check deletion" });

  const notice = manager
    .listSessionMessages(sessionId)
    .find(
      (message) =>
        message.role === "system" &&
        message.content === `Note that the user manually modified these files:\n${filePath}`
    );
  assert.ok(notice);
});

test("replySession ignores manually created untracked files", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-untracked-manual-file-workspace-");
  const home = createTempDir(env, "deepcode-untracked-manual-file-home-");
  env.setHomeDir(home);

  const trackedPath = path.join(workspace, "tracked.txt");
  const untrackedPath = path.join(workspace, "untracked.txt");
  const manager = createSessionManager(workspace, "machine-id-untracked-manual-file");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(trackedPath, "tracked\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [trackedPath], "track file"));

  fs.writeFileSync(untrackedPath, "new manual file\n", "utf8");
  await manager.replySession(sessionId, { text: "second prompt" });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("replySession does not insert manual-change notice for /continue", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-continue-no-manual-change-notice-workspace-");
  const home = createTempDir(env, "deepcode-continue-no-manual-change-notice-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "tracked.txt");
  const manager = createSessionManager(workspace, "machine-id-continue-no-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "before\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));

  fs.writeFileSync(filePath, "manual change\n", "utf8");
  await manager.replySession(sessionId, { text: "/continue" });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("replySession does not insert manual-change notice for permission-only replies", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-permission-no-manual-change-notice-workspace-");
  const home = createTempDir(env, "deepcode-permission-no-manual-change-notice-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "tracked.txt");
  const manager = createSessionManager(workspace, "machine-id-permission-no-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "before\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));
  const assistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need permission",
    [
      {
        id: "call-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: filePath }) },
      },
    ],
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, assistant);

  fs.writeFileSync(filePath, "manual change\n", "utf8");
  await manager.replySession(sessionId, { permissions: [{ toolCallId: "call-read", permission: "allow" }] });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("Write tool advances file-history while preserving the user prompt checkpoint", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-write-checkpoint-workspace-");
  const home = createTempDir(env, "deepcode-write-checkpoint-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "index.html");
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-write-index",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: filePath, content: "<h1>Hello</h1>\n" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "create an index page" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);
  assert.equal(fs.existsSync(filePath), true);

  manager.restoreSessionCode(sessionId, userMessage.id);

  assert.equal(fs.existsSync(filePath), false);
});

test("Write checkpoints restore tool-touched files outside the workspace and leave unrelated files alone", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir(env, "deepcode-write-outside-workspace-");
  const outsideDir = createTempDir(env, "deepcode-write-outside-target-");
  const home = createTempDir(env, "deepcode-write-outside-home-");
  env.setHomeDir(home);

  const outsideFilePath = path.join(outsideDir, "outside.txt");
  const unrelatedWorkspaceFilePath = path.join(workspace, "unrelated.txt");
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-write-outside",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: outsideFilePath, content: "outside\n" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "create an outside file" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);
  assert.equal(fs.readFileSync(outsideFilePath, "utf8"), "outside\n");

  fs.writeFileSync(unrelatedWorkspaceFilePath, "keep\n", "utf8");
  manager.restoreSessionCode(sessionId, userMessage.id);

  assert.equal(fs.existsSync(outsideFilePath), false);
  assert.equal(fs.readFileSync(unrelatedWorkspaceFilePath, "utf8"), "keep\n");
});

test("missing git executable does not block sessions or Write tool calls", async () => {
  const workspace = createTempDir(env, "deepcode-no-git-write-workspace-");
  const home = createTempDir(env, "deepcode-no-git-write-home-");
  env.setHomeDir(home);

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const filePath = path.join(workspace, "index.html");
    const manager = createMockedClientSessionManager(workspace, [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write-no-git",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ file_path: filePath, content: "<h1>No Git</h1>\n" }),
                  },
                },
              ],
            },
          },
        ],
      },
      createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);

    const sessionId = await manager.createSession({ text: "create an index page" });
    const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

    assert.equal(fs.readFileSync(filePath, "utf8"), "<h1>No Git</h1>\n");
    assert.equal(userMessage?.checkpointHash, undefined);
    assert.equal(manager.getSession(sessionId)?.status, "completed");
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});
