/**
 * MCP 协议 / 通道决策 / 真实 Windows 后端枚举测试。
 * 真实数据部分：Windows 后端用纯 tasklist 命令采集本机窗口（无需 .NET 编译）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createMockBackend } from "../src/backends/mock.mjs";
import { createWindowsBackend } from "../src/backends/windows.mjs";
import { DesktopAgent, TOOLS } from "../src/agent.mjs";
import { assertBackend } from "../src/backends/contract.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { ErrorCode } from "../src/errors.mjs";

function makeAgent(policy = {}) {
  return new DesktopAgent({
    backend: createMockBackend(),
    policy: { ...defaultPolicy(), enabled: true, permissionMode: "auto", ...policy },
  });
}

/** 捕获 stdout 帧，供 handle() 直接驱动 */
function capture() {
  const frames = [];
  return {
    frames,
    output: { write: (s) => frames.push(JSON.parse(s.trim())) },
    log: () => {},
  };
}

test("后端契约：mock 与 windows 都满足 BACKEND_METHODS", () => {
  assert.equal(assertBackend(createMockBackend()).name, "mock");
  assert.equal(assertBackend(createWindowsBackend()).name, "windows");
  assert.throws(() => assertBackend({}), /missing methods/);
});

test("MCP：initialize 返回 2025-03-26 与 serverInfo；通知不回帧", async () => {
  const { createMcpServer } = await import("../src/mcp-server.mjs");
  const c = capture();
  const server = createMcpServer(makeAgent(), {
    input: process.stdin,
    output: c.output,
    log: c.log,
  });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(c.frames[0].result.protocolVersion, "2025-03-26");
  assert.equal(c.frames[0].result.serverInfo.name, "deepcode-desktop-agent");
  await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(c.frames.length, 1);
  server.close();
});

test("MCP：tools/list 与 agent 注册表一致；tools/call 返回结构化 content", async () => {
  const { createMcpServer } = await import("../src/mcp-server.mjs");
  const c = capture();
  const server = createMcpServer(makeAgent(), { input: process.stdin, output: c.output, log: c.log });
  await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(c.frames[0].result.tools.length, TOOLS.length);
  assert.ok(TOOLS.every((t) => t.inputSchema?.type === "object"));
  await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "desktop_status", arguments: {} } });
  const r = c.frames[1].result;
  assert.equal(r.content[0].type, "text");
  assert.equal(JSON.parse(r.content[0].text).ok, true);
  await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool" } });
  assert.equal(c.frames[2].result.isError, true);
  await server.handle({ jsonrpc: "2.0", id: 5, method: "unknown/method" });
  assert.equal(c.frames[3].error.code, -32601);
  server.close();
});

test("三级降级链：browser 走 ② 级、敏感应用 blocked、生产力应用接口优先", async () => {
  const agent = makeAgent();
  assert.equal((await agent.decideChannel({ appId: "b", category: "browser" })).channel, "browser");
  assert.equal((await agent.decideChannel({ appId: "f", category: "finance" })).channel, "blocked");
  assert.equal((await agent.decideChannel({ appId: "n", category: "productivity" })).channel, "interface-first");
  assert.equal((await agent.decideChannel({ appId: "x", category: "unknown" })).useGui, true);
});

test("通道矩阵：5 类应用全部被分类，敏感应用列为 blocked", async () => {
  const agent = makeAgent();
  const r = await agent.callTool("desktop_list_apps");
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
  assert.equal(r.apps.find((a) => a.appId === "banking").channel, "blocked");
  assert.equal(r.apps.find((a) => a.appId === "browser").channel, "browser");
  assert.equal(r.apps.find((a) => a.appId === "canvas-app").channel, "gui-visual");
});

test("Windows 后端：UIA 桥未启用时能力矩阵如实报告不可用（不伪造）", async () => {
  const backend = createWindowsBackend({ platform: "win32", bridgeEnabled: false });
  const caps = await backend.capabilities();
  assert.equal(caps.appEnumeration.supported, true);
  assert.equal(caps.a11yTree.supported, false);
  assert.match(caps.a11yTree.reason, /未启用/);
  assert.equal(caps.uacAwareness.supported, false);
  const { AgentError } = await import("../src/errors.mjs");
  await assert.rejects(
    () => backend.snapshot({ appId: "notepad" }),
    (e) => e instanceof AgentError && e.code === ErrorCode.CAPABILITY_UNAVAILABLE
  );
});

test("Windows 后端：非 Windows 平台如实降级，不抛未捕获异常", async () => {
  const backend = createWindowsBackend({ platform: "linux", bridgeEnabled: true });
  const caps = await backend.capabilities();
  assert.equal(caps.appEnumeration.supported, false);
  assert.deepEqual(await backend.listApps(), []);
});

test("Windows 后端：真实 tasklist 枚举本机窗口（纯命令，无 .NET 依赖）", async () => {
  if (process.platform !== "win32") return; // 非 Windows 跳过真实枚举
  const backend = createWindowsBackend({ platform: "win32", bridgeEnabled: false });
  const apps = await backend.listApps();
  assert.ok(Array.isArray(apps));
  assert.ok(apps.length > 0, "交互式会话应至少有一个可见窗口");
  assert.ok(apps.every((a) => a.appId && a.processName && a.pid > 0 && a.title));
  assert.ok(apps.every((a) => typeof a.category === "string"));
  // 中文标题应被 GBK 正确解码（不应出现替换字符）
  assert.ok(apps.every((a) => !a.title.includes("\uFFFD")));
  const matrix = await new DesktopAgent({ backend, policy: defaultPolicy() }).registry.channelMatrix(apps);
  assert.equal(matrix.length, apps.length);
  assert.ok(matrix.every((a) => typeof a.channel === "string" && a.reason));
});

test("tasklist CSV 解析：带引号逗号与重复引号的字段正确切分", async () => {
  const { parseTasklistCsvForTest } = await import("../src/backends/windows.mjs");
  const line = '"my,app.exe","1234","Console","1","1,024 K","Running","user","0:00:01","标题, 带逗号"';
  const rows = parseTasklistCsvForTest(Buffer.from(line, "utf8"), "utf8");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imageName, "my,app.exe");
  assert.equal(rows[0].pid, 1234);
  assert.equal(rows[0].windowTitle, "标题, 带逗号");
  // GBK 编码输入（真实中文系统 tasklist 输出）：「标题」= b1 ea cc e2
  const iconv = Buffer.from([0xb1, 0xea, 0xcc, 0xe2]);
  assert.equal(new TextDecoder("gbk").decode(iconv), "标题");
});
