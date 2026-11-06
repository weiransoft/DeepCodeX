/**
 * Windows 长驻 UIA 桥协议测试（纯模拟，不启动 powershell.exe）。
 *
 * 锁死真机打通依赖的三条契约：
 *  1. 桥必须真实自检（连不上不能报 supported:true）；
 *  2. snapshotId 必须用桥返回的那个（ref 才能在同一进程内解析）；
 *  3. 窗口枚举优先 UIA、失败回落 tasklist；动作自动带 appId/pid 做前台校验。
 * 另外覆盖 id 匹配、进程退出清理、close()，避免遗留子进程。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { DesktopAgent, TOOLS } from "../src/agent.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { ErrorCode } from "../src/errors.mjs";

function makeFakeBridge({ ready = { ok: true, type: "ready" }, responder } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  const writes = [];
  let killed = false;

  const reply = (req) => {
    const value = responder ? responder(req) : { ok: true, command: req.command };
    // 返回 undefined 表示「故意不回复」，用于制造在途请求（测试桥崩溃）
    if (value === undefined) return;
    setImmediate(() => proc.stdout.write(`${JSON.stringify({ id: req.id, ...value })}\n`));
  };

  proc.stdin = {
    writable: true,
    write(chunk) {
      writes.push(chunk);
      const req = JSON.parse(Buffer.from(String(chunk).trim(), "base64").toString("utf8"));
      reply(req);
      return true;
    },
    end() {
      this.writable = false;
    },
  };
  proc.kill = () => {
    killed = true;
    proc.emit("exit", 0);
  };

  const spawnFn = () => {
    setImmediate(() => proc.stdout.write(`${JSON.stringify(ready)}\n`));
    return proc;
  };
  return { proc, spawnFn, writes, killed: () => killed };
}

const capsResponder = (req) => {
  if (req.command === "capabilities") {
    return { ok: true, uia: true, session: "Console", userInteractive: true, psVersion: "5.1" };
  }
  if (req.command === "listWindows") {
    return {
      ok: true,
      windows: [{ appId: "notepad", processName: "Notepad", pid: 4321, name: "Untitled - Notepad", hwnd: 12 }],
    };
  }
  if (req.command === "snapshot") {
    return {
      ok: true,
      snapshotId: "uia-bridge-0001",
      pid: 4321,
      windowName: "Untitled - Notepad",
      nodeCount: 2,
      truncated: true,
      boundary: "depth-budget",
      tree: [{ ref: "e0", role: "Window", children: [{ ref: "e01", role: "Edit" }] }],
      fullTree: [{ ref: "e0", role: "Window", children: [{ ref: "e01", role: "Edit" }] }],
    };
  }
  return { ok: true, via: "mock-bridge" };
};

const opts = (extra = {}) => ({ platform: "win32", bridgeEnabled: true, bridgeTimeoutMs: 1500, ...extra });

test("桥自检：真实握手成功才报告 supported:true，6 项能力同步转真", async () => {
  const fake = makeFakeBridge({ responder: capsResponder });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  const caps = await b.capabilities();
  assert.equal(caps.a11yTree.supported, true);
  assert.match(caps.a11yTree.reason, /长驻桥已连接/);
  assert.equal(caps.screenshot.supported, true);
  assert.equal(caps.elementInvoke.supported, true);
  assert.equal(caps.coordinateInput.supported, true);
  assert.equal(caps.foregroundControl.supported, true);
  assert.equal(caps.bridge.connected, true);
  assert.equal(caps.uacAwareness.supported, false); // UAC 仍明确不绕过
  assert.equal(fake.writes.length >= 1, true);
  b.close();
});

test("桥自检：ready 失败时如实降级，不伪造观察能力", async () => {
  const fake = makeFakeBridge({ ready: { ok: false, type: "ready", code: "CAPABILITY_UNAVAILABLE", message: "UIA 桥初始化失败：无桌面" } });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  const caps = await b.capabilities();
  assert.equal(caps.a11yTree.supported, false);
  assert.match(caps.a11yTree.reason, /UIA 桥不可用/);
  const { AgentError } = await import("../src/errors.mjs");
  await assert.rejects(
    () => b.snapshot({ appId: "notepad" }),
    (e) => e instanceof AgentError && e.code === ErrorCode.CAPABILITY_UNAVAILABLE
  );
  b.close();
});

test("snapshot：保留桥返回的 snapshotId 并规范化树，动作才能解析 ref", async () => {
  const fake = makeFakeBridge({ responder: capsResponder });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  const s = await b.snapshot({ appId: "notepad", pid: 4321, maxDepth: 2 });
  assert.equal(s.snapshotId, "uia-bridge-0001", "不得用 Node 侧自增 id 覆盖桥 id");
  assert.equal(s.source, "a11y");
  assert.equal(s.tree[0].children[0].ref, "e01");
  assert.deepEqual(s.tree[0].children[0].rect, { x: 0, y: 0, width: 0, height: 0 }); // 缺失 rect 被补齐
  assert.deepEqual(s.fullTree[0].children[0].children, []);
  assert.equal(s.nodeCount, 2);
  assert.deepEqual(b.lastTarget, { appId: "notepad", pid: 4321, hwnd: 0 });

  const inv = await b.invokeRef({ snapshotId: s.snapshotId, ref: "e01", action: "invoke", value: "x" });
  assert.equal(inv.ok, true);
  const sent = JSON.parse(Buffer.from(fake.writes.at(-1).trim(), "base64").toString("utf8"));
  assert.equal(sent.command, "invokeRef");
  assert.equal(sent.args.appId, "notepad"); // 自动补目标，供前台校验
  assert.equal(sent.args.pid, 4321);
  b.close();
});

test("窗口枚举：优先 UIA listWindows，不再付 15s tasklist 冷枚举成本", async () => {
  const fake = makeFakeBridge({ responder: capsResponder });
  let tasklistCalled = false;
  const b = createWindowsBackend(opts({
    spawn: fake.spawnFn,
    exec: async () => {
      tasklistCalled = true;
      return { stdout: Buffer.from("") };
    },
  }));
  const apps = await b.listApps();
  assert.equal(tasklistCalled, false);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].appId, "notepad");
  assert.equal(apps[0].pid, 4321);
  assert.equal(apps[0].enumSource, "uia");
  assert.equal(apps[0].category, "productivity");
  b.close();
});

test("窗口枚举：UIA 失败时静默回落 tasklist，保留未知字段与 GBK 解码", async () => {
  const fake = makeFakeBridge({ responder: () => ({ ok: false, code: "CAPABILITY_UNAVAILABLE", message: "bridge down" }) });
  const csv = '"notepad.exe","1234","Console","1","1,024 K","Running","user","0:00:01","Untitled - Notepad"';
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn, exec: async () => ({ stdout: Buffer.from(csv, "utf8") }) }));
  const apps = await b.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].enumSource, "tasklist");
  assert.equal(apps[0].pid, 1234);
  assert.match(b.enumFallbackReason, /bridge down|listWindows/);
  b.close();
});

test("窗口枚举：桥返回 ok 但空列表时回落 tasklist，不静默当作「无窗口」", async () => {
  // 回归：Get-TopWindows 内部异常被 catch 吞掉时会返回 {ok:true, windows:[]}，
  // 旧实现直接返回空数组，导致 waitForWindow 白等 20s 却看不到任何线索。
  const fake = makeFakeBridge({
    responder: (req) => req.command === "listWindows" ? { ok: true, windows: [], count: 0 } : capsResponder(req),
  });
  const csv = '"notepad.exe","1234","Console","1","1,024 K","Running","user","0:00:01","Untitled - Notepad"';
  let tasklistCalled = false;
  const b = createWindowsBackend(opts({
    spawn: fake.spawnFn,
    exec: async () => {
      tasklistCalled = true;
      return { stdout: Buffer.from(csv, "utf8") };
    },
  }));
  const apps = await b.listApps();
  assert.equal(tasklistCalled, true);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].enumSource, "tasklist");
  assert.match(b.enumFallbackReason, /空窗口列表/);
  b.close();
});

test("长驻协议：并发请求按 id 匹配，不串包", async () => {
  const fake = makeFakeBridge({
    responder: (req) => ({ ok: true, command: req.command, echo: req.args?.n ?? null }),
  });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  const [a, c] = await Promise.all([
    b._rpc("observeState", { n: 1 }),
    b._rpc("waitFor", { n: 2 }),
  ]);
  assert.equal(a.command, "observeState");
  assert.equal(a.echo, 1);
  assert.equal(c.command, "waitFor");
  assert.equal(c.echo, 2);
  b.close();
});

test("进程退出 / close：pending 被清理，探测缓存复位，不遗留子进程", async () => {
  const fake = makeFakeBridge({ responder: capsResponder });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  assert.equal((await b.bridgeStatus()).supported, true);
  fake.proc.emit("exit", 1);
  assert.equal(b.bridge, null);
  assert.equal(b._bridgeProbe, null);
  const fake2 = makeFakeBridge({ responder: capsResponder });
  const b2 = createWindowsBackend(opts({ spawn: fake2.spawnFn }));
  await b2.capabilities();
  b2.close();
  assert.equal(fake2.killed(), true);
  assert.equal(b2.bridge, null);
});

test("桥未启用 / 非 Windows：不启动任何子进程，如实降级", async () => {
  let spawned = 0;
  const countingSpawn = () => {
    spawned += 1;
    return makeFakeBridge({ responder: capsResponder }).spawnFn();
  };
  const off = createWindowsBackend({ platform: "win32", bridgeEnabled: false, spawn: countingSpawn });
  assert.equal((await off.capabilities()).a11yTree.supported, false);
  assert.match((await off.capabilities()).a11yTree.reason, /未启用/);
  const linux = createWindowsBackend({ platform: "linux", bridgeEnabled: true, spawn: countingSpawn });
  assert.deepEqual(await linux.listApps(), []);
  assert.equal(spawned, 0);
});

test("桥崩溃：在途请求被拒为 CAPABILITY_UNAVAILABLE，下一次调用自动重启新桥", async () => {
  // 第一座桥收到 snapshot 故意不回，制造「请求在途时进程崩掉」
  const first = makeFakeBridge({
    responder: (req) => (req.command === "capabilities" ? { ok: true, uia: true } : undefined),
  });
  const second = makeFakeBridge({ responder: capsResponder });
  let spawned = 0;
  const spawnFn = () => (spawned++ === 0 ? first.spawnFn() : second.spawnFn());

  const b = createWindowsBackend(opts({ spawn: spawnFn }));
  assert.equal((await b.bridgeStatus()).supported, true);

  const inflight = b._rpc("snapshot", { appId: "notepad" });
  await new Promise((r) => setTimeout(r, 20));
  first.proc.emit("exit", 1);

  await assert.rejects(
    () => inflight,
    (e) => e.code === ErrorCode.CAPABILITY_UNAVAILABLE && /桥进程已退出/.test(e.message)
  );
  assert.equal(b.bridge, null, "崩溃后必须清空桥引用，否则后续请求会写进死管道");
  assert.equal(b._bridgeProbe, null, "能力探测缓存必须复位，否则会继续报 supported:true");

  // 下一次调用自动拉起新桥（不要求调用方重启进程）
  const r2 = await b._rpc("capabilities", {});
  assert.equal(r2.ok, true);
  assert.equal(spawned, 2);
  b.close();
});

test("工具契约：所有带 appId 的工具支持 pid/hwnd，_target 精确覆盖同进程多窗口", async () => {
  const withAppId = TOOLS.filter((t) => t.inputSchema?.properties?.appId);
  assert.ok(withAppId.length >= 6);
  assert.ok(withAppId.every((t) => t.inputSchema.properties.pid?.type === "number"));
  assert.ok(withAppId.every((t) => t.inputSchema.properties.hwnd?.type === "number"));

  const agent = new DesktopAgent({ backend: createMockBackend(), policy: defaultPolicy() });
  // 同进程两个窗口：只给 appId 会命中第一个；hwnd 才能落到第二个
  const windows = [
    { appId: "explorer", pid: 8392, hwnd: 65846, title: "Program Manager", category: "productivity" },
    { appId: "explorer", pid: 8392, hwnd: 461716, title: "Downloads", category: "productivity" },
    { appId: "notepad", pid: 111, hwnd: 197382, title: "Untitled - Notepad", category: "productivity" },
  ];
  agent.registry.list = async () => windows;

  const plain = await agent._target({ appId: "explorer" });
  assert.equal(plain.pid, 8392);
  assert.equal(plain.hwnd, 65846);

  const exact = await agent._target({ appId: "explorer", hwnd: 461716 });
  assert.equal(exact.hwnd, 461716);
  assert.equal(exact.title, "Downloads");

  const both = await agent._target({ appId: "explorer", pid: 8392, hwnd: 461716 });
  assert.equal(both.pid, 8392);
  assert.equal(both.hwnd, 461716);

  const pidOnly = await agent._target({ appId: "notepad", pid: 999 });
  assert.equal(pidOnly.pid, 999);
  await assert.rejects(() => agent._target({ appId: "missing" }), (e) => e.code === ErrorCode.INVALID_ARGUMENT);
});

test("hwnd 贯穿感知链路：snapshot/screenshot/动作都带 hwnd，桥侧才能落到具体窗口", async () => {
  const fake = makeFakeBridge({ responder: capsResponder });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  const snap = await b.snapshot({ appId: "notepad", pid: 4321, hwnd: 461716, maxDepth: 2 });
  assert.equal(snap.hwnd, 461716);
  await b.screenshot({ appId: "notepad", pid: 4321 });
  await b.invokeRef({ snapshotId: snap.snapshotId, ref: "e01", action: "click_ref" });

  const sent = fake.writes.map((w) => JSON.parse(Buffer.from(w.trim(), "base64").toString("utf8")));
  const snapReq = sent.find((r) => r.command === "snapshot");
  assert.equal(snapReq.args.hwnd, 461716);
  // 截图与动作走 _withTarget，自动继承最近一次成功观察的 hwnd
  const shotReq = sent.find((r) => r.command === "screenshot");
  assert.equal(shotReq.args.hwnd, 461716);
  const actReq = sent.find((r) => r.command === "invokeRef");
  assert.equal(actReq.args.hwnd, 461716);
  b.close();
});
