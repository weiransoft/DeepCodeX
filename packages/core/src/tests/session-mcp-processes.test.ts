/**
 * SessionManager MCP 服务器与进程管理测试套件
 *
 * 覆盖方法群：
 * - MCP 生命周期：dispose disconnects、API-safe names、reports starting before init、
 *   startup stderr on failure、adds -y for npx、marks failed on single attempt、
 *   reconnect succeeds on previously failed、refreshes cached definitions after crash
 * - 进程管理：dispose kills live processes、deleteSession ignores persisted stale processes
 * - Bash timeout：adjusts active Bash timeout control and session metadata
 *
 * 共 11 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createSessionAndMessages,
  waitForMcpStatus,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("SessionManager dispose disconnects MCP servers", async () => {
  const workspace = createTempDir(env, "deepcode-mcp-dispose-workspace-");
  const serverPath = path.join(workspace, "mcp-server.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    if (request.params && request.params.cursor === "page-2") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [
        { name: "count", inputSchema: { type: "object", properties: {} } }
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
    ], nextCursor: "page-2" } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.name + ":" + (request.params.arguments.text || "") }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-dispose");
  const initPromise = manager.initMcpServers({ smoke: { command: process.execPath, args: [serverPath] } });

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "smoke",
      status: "starting",
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);

  await initPromise;

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "smoke",
      status: "ready",
      connected: true,
      toolCount: 2,
      tools: ["mcp__smoke__echo", "mcp__smoke__count"],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);
  const mcpManager = (manager as any).mcpManager;
  assert.equal(mcpManager.getMcpToolDefinitions()[0].function.name, "mcp__smoke__echo");
  assert.deepEqual(await mcpManager.executeMcpTool("mcp__smoke__echo", { text: "ok" }), {
    ok: true,
    name: "mcp__smoke__echo",
    output: "echo:ok",
  });

  manager.dispose();

  assert.deepEqual(manager.getMcpStatus(), []);
});

test("SessionManager exposes MCP tools with API-safe names and preserves original dispatch names", async () => {
  const workspace = createTempDir(env, "deepcode-mcp-safe-name-workspace-");
  const serverPath = path.join(workspace, "mcp-invalid-name-server.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "speak.text", description: "Speak text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "speak/text", description: "Speak text using a slash name", inputSchema: { type: "object", properties: {} } }
    ] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.name + ":" + (request.params.arguments.text || "") }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-safe-name");
  await manager.initMcpServers({ "voice.box": { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus()[0];
  assert.equal(status?.status, "ready");
  assert.deepEqual(status?.tools, ["mcp__voice_box__speak_text", "mcp__voice_box__speak_text_59a610ad"]);

  const mcpManager = (manager as any).mcpManager;
  const definitions = mcpManager.getMcpToolDefinitions();
  assert.equal(definitions[0].function.name, "mcp__voice_box__speak_text");
  assert.match(definitions[0].function.name, /^[a-zA-Z0-9_-]+$/);
  assert.match(definitions[0].function.description, /MCP source: voice\.box: speak\.text/);
  assert.deepEqual(await mcpManager.executeMcpTool("mcp__voice_box__speak_text", { text: "ok" }), {
    ok: true,
    name: "mcp__voice_box__speak_text",
    output: "speak.text:ok",
  });

  manager.dispose();
});

test("SessionManager dispose kills live processes without timeout controls", (t) => {
  if (process.platform === "win32") {
    t.skip("process group kill assertion is non-Windows specific");
    return;
  }

  const workspace = createTempDir(env, "deepcode-dispose-process-workspace-");
  const home = createTempDir(env, "deepcode-dispose-process-home-");
  env.setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-dispose-process");
  const sessionId = createSessionAndMessages(manager, "session-dispose-process", "Dispose process session");
  const originalKill = process.kill;
  const killed: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];

  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      killed.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    (manager as any).addSessionProcess(sessionId, 1234, "python3 -m http.server 8080");
    manager.dispose();
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(killed, [{ pid: -1234, signal: "SIGKILL" }]);
});

test("SessionManager deleteSession ignores persisted processes that are not live", (t) => {
  if (process.platform === "win32") {
    t.skip("process group kill assertion is non-Windows specific");
    return;
  }

  const workspace = createTempDir(env, "deepcode-delete-stale-process-workspace-");
  const home = createTempDir(env, "deepcode-delete-stale-process-home-");
  env.setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-delete-stale-process");
  const sessionId = createSessionAndMessages(manager, "session-delete-stale-process", "Delete stale process session");
  (manager as any).updateSessionEntry(sessionId, (entry: any) => ({
    ...entry,
    processes: new Map([["1234", { startTime: new Date().toISOString(), command: "stale process" }]]),
  }));
  const originalKill = process.kill;
  const killed: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];

  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      killed.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    assert.equal(manager.deleteSession(sessionId), true);
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(killed, []);
});

test("SessionManager refreshes cached MCP tool definitions after server crash", async () => {
  const workspace = createTempDir(env, "deepcode-mcp-crash-cache-workspace-");
  const serverPath = path.join(workspace, "mcp-server-crash.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "echo", inputSchema: { type: "object", properties: {} } }
    ] } });
    return;
  }
  if (request.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } });
    return;
  }
  if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [] } });
    setTimeout(() => process.exit(9), 10);
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-crash-cache");
  await manager.initMcpServers({ crashy: { command: process.execPath, args: [serverPath] } });

  assert.equal(manager.getMcpStatus()[0]?.status, "ready");
  assert.equal((manager as any).mcpToolDefinitions.length, 1);

  await waitForMcpStatus(manager, "failed");

  assert.equal((manager as any).mcpToolDefinitions.length, 0);

  manager.dispose();
});

test("SessionManager reports configured MCP servers as starting before initialization", () => {
  const workspace = createTempDir(env, "deepcode-mcp-configured-workspace-");
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "playwright",
      status: "starting",
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);
});

test("SessionManager reports MCP startup stderr on failure", async () => {
  const workspace = createTempDir(env, "deepcode-mcp-failure-workspace-");
  const serverPath = path.join(workspace, "mcp-server-fail.cjs");
  fs.writeFileSync(serverPath, 'process.stderr.write("mcp startup boom"); process.exit(7);', "utf8");

  const manager = createSessionManager(workspace, "machine-id-mcp-failure");
  await manager.initMcpServers({ broken: { command: process.execPath, args: [serverPath] } });

  const [status] = manager.getMcpStatus();
  assert.equal(status?.name, "broken");
  assert.equal(status?.status, "failed");
  assert.equal(status?.connected, false);
  assert.match(status?.error ?? "", /mcp startup boom/);
});

test(
  "SessionManager adds -y when launching MCP servers through npx",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir(env, "deepcode-mcp-npx-workspace-");
    const argsPath = path.join(workspace, "args.json");
    const fakeNpxPath = path.join(workspace, "npx");
    fs.writeFileSync(
      fakeNpxPath,
      `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
fs.writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
      "utf8"
    );
    fs.chmodSync(fakeNpxPath, 0o755);

    const manager = createSessionManager(workspace, "machine-id-mcp-npx");
    await manager.initMcpServers({
      npxed: { command: fakeNpxPath, args: ["@playwright/mcp@latest"], env: { ARGS_PATH: argsPath } },
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")) as string[], ["-y", "@playwright/mcp@latest"]);
    manager.dispose();
  }
);

test("SessionManager marks MCP server as failed on single failed attempt (no auto-retry)", async () => {
  const workspace = createTempDir(env, "deepcode-mcp-fail-noworkspace-");
  const serverPath = path.join(workspace, "mcp-server-fail.cjs");
  fs.writeFileSync(serverPath, "process.exit(7);", "utf8");

  const manager = createSessionManager(workspace, "machine-id-mcp-fail-no");
  await manager.initMcpServers({ broken: { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0]?.status, "failed");
  assert.match(status[0]?.error ?? "", /exited with code 7/);

  manager.dispose();
});

test("SessionManager reconnect succeeds on previously failed server", async () => {
  const workspace = createTempDir(env, "deepcode-mcp-reconn-ok-workspace-");
  const serverPath = path.join(workspace, "mcp-server-ok.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-reconn-ok");
  await manager.initMcpServers({ fixable: { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0]?.status, "ready");
  assert.equal(status[0]?.toolCount, 1);

  manager.dispose();
});

test("SessionManager adjusts the active Bash timeout control and session metadata", async () => {
  const workspace = createTempDir(env, "deepcode-bash-timeout-session-");
  const home = createTempDir(env, "deepcode-bash-timeout-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "");
  const sessionId = await manager.createSession({ text: "hello" });

  (manager as any).addSessionProcess(sessionId, 123, "sleep 10");

  let timeoutInfo = {
    timeoutMs: 10 * 60 * 1000,
    startedAtMs: 1000,
    deadlineAtMs: 1000 + 10 * 60 * 1000,
    timedOut: false,
  };
  (manager as any).setSessionProcessTimeoutControl(sessionId, 123, {
    getInfo: () => timeoutInfo,
    setTimeoutMs: (timeoutMs: number) => {
      timeoutInfo = {
        ...timeoutInfo,
        timeoutMs,
        deadlineAtMs: timeoutInfo.startedAtMs + timeoutMs,
      };
      return timeoutInfo;
    },
  });

  const adjustment = manager.adjustActiveBashTimeout(5 * 60 * 1000);
  const processInfo = manager.getSession(sessionId)?.processes?.get("123");

  assert.equal(adjustment?.processId, "123");
  assert.equal(adjustment?.timeoutMs, 15 * 60 * 1000);
  assert.equal(processInfo?.timeoutMs, 15 * 60 * 1000);
  assert.equal(processInfo?.deadlineAt, new Date(timeoutInfo.deadlineAtMs).toISOString());
});
