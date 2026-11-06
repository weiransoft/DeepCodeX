/**
 * 桥生命周期回归：崩溃重启上限 / 指数退避 / 稳定重置 / ping 无响应回收 / 优雅关闭。
 *
 * 这些用例锁的是**不能让桥无限重启**这条底线：真机上 UIA 在锁屏 / Secure Desktop /
 * 会话切换下会反复抛异常，如果「崩了就下次再拉一个」没有上限，宿主会陷入
 * 「每 200ms 起一个 powershell.exe」的风暴，既拿不到可用桥也刷满日志。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { BridgeLifecycle } from "../src/modules/bridge-lifecycle.mjs";
import { createWindowsBackend } from "../src/backends/windows.mjs";
import { ErrorCode } from "../src/errors.mjs";

/** 可控时钟：避免测试用真实 sleep 拖时间 */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function makeFakeBridge({ ready = { ok: true, type: "ready" }, responder } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  const writes = [];
  let killed = false;

  const reply = (req) => {
    const value = responder ? responder(req) : { ok: true, command: req.command };
    if (value === undefined) return;
    setImmediate(() => proc.stdout.write(`${JSON.stringify({ id: req.id, ...value })}\n`));
  };

  proc.stdin = {
    writable: true,
    write(chunk) {
      writes.push(chunk);
      reply(JSON.parse(Buffer.from(String(chunk).trim(), "base64").toString("utf8")));
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

const opts = (extra = {}) => ({ platform: "win32", bridgeEnabled: true, bridgeTimeoutMs: 1500, ...extra });

test("生命周期：首次启动不计入崩溃窗口、不退避", () => {
  const lc = new BridgeLifecycle();
  const first = lc.admitRestart("boot");
  assert.equal(first.allowed, true);
  assert.equal(first.firstStart, true);
  assert.equal(first.delayMs, 0);
  lc.noteStart();
  assert.equal(lc.status().totalStarts, 1);
});

test("生命周期：崩溃后重启退避按 200/400/800ms 指数递增，且有上限", () => {
  const now = fakeClock();
  const lc = new BridgeLifecycle({ now });
  const delays = [];
  for (let i = 0; i < 3; i += 1) {
    const admit = lc.admitRestart("crash");
    assert.equal(admit.allowed, true);
    delays.push(admit.delayMs);
    lc.noteStart();
    lc.noteCrash(`boom-${i}`);
    now.advance(100); // 仍在 120s 窗口内
  }
  assert.deepEqual(delays, [0, 200, 400]);
  const capped = new BridgeLifecycle({ now, backoffBaseMs: 4_000, backoffMaxMs: 5_000 });
  capped.noteStart();
  capped.noteCrash("x");
  assert.equal(capped.admitRestart().delayMs, 4_000);
});

test("生命周期：窗口内崩溃达上限即封锁，不再自动重启且给出可行动原因", () => {
  const now = fakeClock();
  const lc = new BridgeLifecycle({ now, maxRestarts: 3 });
  lc.noteStart();
  for (let i = 0; i < 3; i += 1) {
    lc.noteCrash(`boom-${i}`);
    now.advance(1_000);
  }
  const denied = lc.admitRestart("retry");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "bridge-crash-loop");
  assert.match(denied.blocked.message, /崩溃 3 次/);
  assert.match(denied.blocked.message, /停止自动重启/);
  assert.equal(lc.isBlocked(), true);

  // 再次尝试仍拒绝（不能靠反复调用把封锁刷掉）
  assert.equal(lc.admitRestart("retry-again").allowed, false);
  const st = lc.status();
  assert.equal(st.blocked, true);
  assert.equal(st.blockedReason, "bridge-crash-loop");
  assert.equal(st.crashesInWindow, 3);
  assert.equal(st.totalCrashes, 3);
});

test("生命周期：崩溃发生在窗口之外不累计；稳定运行后清空窗口并解除封锁", () => {
  const now = fakeClock();
  const lc = new BridgeLifecycle({ now, maxRestarts: 2, restartWindowMs: 60_000, stableAfterMs: 30_000 });
  lc.noteStart();
  lc.noteCrash("old");
  now.advance(120_000); // 滑出窗口
  lc.noteStart();
  const admit = lc.admitRestart();
  assert.equal(admit.crashesInWindow, 0, "过期崩溃不应继续累计");
  assert.equal(admit.delayMs, 0);

  // 稳定运行 30s 后窗口清空
  lc.noteCrash("fresh");
  assert.equal(lc.status().crashesInWindow, 1);
  lc.noteStart();
  now.advance(31_000);
  const cleared = lc.noteStable();
  assert.equal(cleared, true);
  assert.equal(lc.status().crashesInWindow, 0);
  assert.equal(lc.status().totalCrashes, 2, "累计崩溃数保留用于观测");
});

test("生命周期：连续 ping 失败达阈值判定无响应需回收，成功即清零", () => {
  const lc = new BridgeLifecycle({ maxConsecutivePingFailures: 3 });
  lc.noteStart();
  lc.notePing(false);
  lc.notePing(false);
  assert.equal(lc.shouldRecycle(), false);
  lc.notePing(true, 12); // 恢复一次
  assert.equal(lc.shouldRecycle(), false);
  assert.equal(lc.status().consecutivePingFailures, 0);
  lc.notePing(false);
  lc.notePing(false);
  lc.notePing(false);
  assert.equal(lc.shouldRecycle(), true);
  assert.equal(lc.status().lastPing.ok, false);
});

test("后端集成：崩溃超过上限后不再 spawn，抛 CAPABILITY_UNAVAILABLE 并标注 bridge-crash-loop", async () => {
  let spawned = 0;
  const fakes = [];
  const spawnFn = () => {
    spawned += 1;
    const f = makeFakeBridge({
      responder: (req) => (req.command === "capabilities" ? { ok: true, uia: true } : { ok: true }),
    });
    fakes.push(f);
    return f.spawnFn();
  };
  const b = createWindowsBackend(opts({ spawn: spawnFn }));
  const backendLifecycle = b.lifecycle; // 默认 maxRestarts=3
  backendLifecycle.noteStable = () => false; // 防止「稳定」把窗口清掉，模拟持续崩

  // 第 1 次正常连上
  assert.equal((await b.bridgeStatus()).supported, true);

  // 连续崩 3 次，每次由下一次调用惰性拉起
  for (let i = 0; i < 3; i += 1) {
    fakes.at(-1).proc.emit("exit", 1);
    b._bridgeProbe = null;
    if (i < 2) {
      const st = await b._rpc("capabilities", {});
      assert.equal(st.ok, true);
    }
  }
  assert.equal(spawned, 3, "3 次崩溃后仅重启到第 3 座桥");

  // 第 4 次：超过上限 → 拒绝启动，绝不再 spawn
  const before = spawned;
  await assert.rejects(
    () => b._rpc("capabilities", {}),
    (e) =>
      e.code === ErrorCode.CAPABILITY_UNAVAILABLE &&
      e.details?.reason === "bridge-crash-loop" &&
      e.details?.handoff === true
  );
  assert.equal(spawned, before, "封锁后不得再拉起 powershell.exe");

  // capabilities 如实报告连接失败与封锁原因，不伪造 supported:true
  const caps = await b.capabilities();
  assert.equal(caps.a11yTree.supported, false);
  assert.match(caps.a11yTree.reason, /停止自动重启/);
  assert.equal(caps.bridge.connected, false);
  assert.equal(caps.bridge.lifecycle.blocked, true);
  b.close();
});

test("后端集成：health 走真实 ping，返回 uptime/请求数；close 标记为正常退出不计崩溃", async () => {
  const fake = makeFakeBridge({
    responder: (req) => {
      if (req.command === "ping") {
        return { ok: true, pong: true, uptimeMs: 1234, requests: 7, snapshots: 1, refs: 4, workingSetMb: 88, lastHwnd: 42 };
      }
      return { ok: true, uia: true };
    },
  });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  assert.equal((await b.bridgeStatus()).supported, true); // health 只检查已存在的桥，不主动拉起
  const h = await b.health();
  assert.equal(h.ok, true);
  assert.equal(h.responsive, true);
  assert.equal(h.bridge.storedRefs, 4);
  assert.equal(h.bridge.workingSetMb, 88);
  assert.equal(h.lifecycle.totalCrashes, 0);

  b.close();
  fake.proc.emit("exit", 0);
  assert.equal(b.lifecycle.status().totalCrashes, 0, "主动关闭不是崩溃");
  assert.equal(b.lifecycle.status().totalCleanExits, 1);
});

test("后端集成：shutdown 优雅关闭（先 shutdown 再退出），僵死才 kill", async () => {
  const fake = makeFakeBridge({ responder: () => ({ ok: true, uia: true }) });
  const b = createWindowsBackend(opts({ spawn: fake.spawnFn }));
  await b.bridgeStatus();

  // 模拟桥收到 shutdown 后自行退出
  const origWrite = fake.proc.stdin.write.bind(fake.proc.stdin);
  fake.proc.stdin.write = (chunk) => {
    const ok = origWrite(chunk);
    const req = JSON.parse(Buffer.from(String(chunk).trim(), "base64").toString("utf8"));
    if (req.command === "shutdown") setImmediate(() => fake.proc.emit("exit", 0));
    return ok;
  };

  const res = await b.shutdown({ timeoutMs: 500 });
  assert.equal(res.closed, true);
  assert.equal(res.graceful, true, "桥自行退出，不应走 kill 分支");
  assert.equal(fake.killed(), false, "优雅路径不得 kill");
  assert.equal(b.bridge, null);
  assert.equal(b.lifecycle.status().totalCrashes, 0);
});

test("后端集成：stdin 已关闭（进程半死）时自动丢弃重建，而不是永久失败", async () => {
  let n = 0;
  const spawnFn = () => {
    n += 1;
    const f = makeFakeBridge({ responder: (req) => (req.command === "capabilities" ? { ok: true, uia: true } : { ok: true }) });
    if (n === 1) f.proc.stdin.writable = false; // 第一座桥管道已断
    return f.spawnFn();
  };
  const b = createWindowsBackend(opts({ spawn: spawnFn }));
  const r = await b._rpc("capabilities", {});
  assert.equal(r.ok, true);
  assert.equal(n, 2, "应重建一次并重试");
  assert.equal(b.lifecycle.status().totalCrashes, 0, "丢弃半死桥不算崩溃");
  b.close();
});
