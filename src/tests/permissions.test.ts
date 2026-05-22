import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendProjectPermissionAllows,
  computeToolCallPermissions,
  evaluatePermissionScopes,
  hasUserPermissionReplies,
  parseBashSideEffects,
} from "../common/permissions";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("parseBashSideEffects accepts valid scopes and normalizes unsafe values to unknown", () => {
  assert.deepEqual(parseBashSideEffects(["read-in-cwd", "network", "read-in-cwd"]), ["read-in-cwd", "network"]);
  assert.deepEqual(parseBashSideEffects(undefined), ["unknown"]);
  assert.deepEqual(parseBashSideEffects(["read-in-cwd", "unknown"]), ["unknown"]);
  assert.deepEqual(parseBashSideEffects(["mcp"]), ["unknown"]);
});

test("evaluatePermissionScopes applies deny, ask, allow, and default mode precedence", () => {
  const settings = {
    allow: ["read-in-cwd" as const],
    deny: ["write-out-cwd" as const],
    ask: ["network" as const],
    defaultMode: "askAll" as const,
  };

  assert.equal(evaluatePermissionScopes(["write-out-cwd"], settings), "deny");
  assert.equal(evaluatePermissionScopes(["network"], settings), "ask");
  assert.equal(evaluatePermissionScopes(["read-in-cwd"], settings), "allow");
  assert.equal(evaluatePermissionScopes(["write-in-cwd"], settings), "ask");
  assert.equal(evaluatePermissionScopes([], settings), "allow");
  assert.equal(evaluatePermissionScopes(["unknown"], settings), "ask");
});

test("computeToolCallPermissions maps tool calls to permission requests", () => {
  const projectRoot = createTempDir("deepcode-permissions-workspace-");
  const plan = computeToolCallPermissions({
    sessionId: "session-1",
    projectRoot,
    settings: {
      allow: [],
      deny: [],
      ask: ["write-out-cwd", "network"],
      defaultMode: "allowAll",
    },
    resolveSnippetPath: () => path.join(projectRoot, "src", "file.ts"),
    toolCalls: [
      {
        id: "call-write",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/out.txt", content: "x" }) },
      },
      {
        id: "call-bash",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "curl https://example.com", sideEffects: ["network"] }),
        },
      },
      {
        id: "call-edit",
        type: "function",
        function: { name: "edit", arguments: JSON.stringify({ snippet_id: "snippet_1" }) },
      },
    ],
  });

  assert.deepEqual(plan.permissions, [
    { toolCallId: "call-write", permission: "ask" },
    { toolCallId: "call-bash", permission: "ask" },
    { toolCallId: "call-edit", permission: "allow" },
  ]);
  assert.deepEqual(
    plan.askPermissions.map((item) => ({ id: item.toolCallId, scopes: item.scopes })),
    [
      { id: "call-write", scopes: ["write-out-cwd"] },
      { id: "call-bash", scopes: ["network"] },
    ]
  );
});

test("appendProjectPermissionAllows writes unique project-level allow scopes", () => {
  const projectRoot = createTempDir("deepcode-permission-settings-");
  const settingsPath = path.join(projectRoot, ".deepcode", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["read-in-cwd"] } }), "utf8");

  appendProjectPermissionAllows(projectRoot, ["read-in-cwd", "write-in-cwd"]);
  appendProjectPermissionAllows(projectRoot, ["write-in-cwd"]);

  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(settings.permissions.allow, ["read-in-cwd", "write-in-cwd"]);
});

test("hasUserPermissionReplies detects permission reply payloads", () => {
  assert.equal(hasUserPermissionReplies({}), false);
  assert.equal(hasUserPermissionReplies({ permissions: [] }), false);
  assert.equal(hasUserPermissionReplies({ permissions: [{ toolCallId: "call-1", permission: "allow" }] }), true);
  assert.equal(hasUserPermissionReplies({ alwaysAllows: ["network"] }), true);
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
