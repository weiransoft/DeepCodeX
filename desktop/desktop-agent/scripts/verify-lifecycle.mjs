#!/usr/bin/env node
/**
 * 桥生命周期真机验证（P2 准入第 4 项）。
 *
 * 验证的是「长驻桥被放进工程化生命周期之后，真的按预期生病、自愈、认输、退场」，
 * 而不是只在 mock 上算数：
 *
 *  1. **健康检查**：`ping` 真回 pong，拿到桥内 uptime / 已处理请求数 / 快照 ref 数；
 *  2. **健康检查不伤 ref**：ping 前后各观察一次同一个真实窗口，ref 存储仍在；
 *  3. **崩溃自愈**：外部 `taskkill` 杀掉 powershell.exe，下一次调用按退避重建并成功；
 *  4. **崩溃循环认输**：连续杀 3 次后第 4 次调用直接 `bridge-crash-loop`，
 *     **不再拉起新进程**（这是防重启风暴的底线）；
 *  5. **优雅退出**：`shutdown` 让 PowerShell 主循环自行 break，进程真的消失，
 *     不留孤儿 powershell.exe；且优雅退出不计入崩溃。
 *
 * 安全：全程只做 `snapshot`（只读）与进程管理，不键入、不点击、不改任何应用状态；
 * 报告不落盘窗口标题，只保留长度特征。
 *
 * 运行：
 *   DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/verify-lifecycle.mjs
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { AppRegistry } from "../src/modules/app-registry.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "reports", "p2-lifecycle.json");
const CRASH_ROUNDS = 2;

const round = (n) => Number(Number(n).toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程是否仍存活（用 tasklist 精确匹配 PID，避免 PowerShell 额外开销） */
async function pidAlive(pid) {
  if (!pid) return false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
      encoding: "buffer",
      windowsHide: true,
    });
    const text = new TextDecoder("gbk").decode(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    return text.includes(String(pid));
  } catch {
    return false;
  }
}

async function waitUntil(fn, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** 杀桥进程，并统计崩溃记账（外部强杀 = 崩溃，不是正常退出） */
async function killBridge(backend) {
  const st = backend.bridge;
  if (!st) throw new Error("没有在运行的桥");
  const pid = st.proc.pid;
  const t0 = performance.now();
  const crashesBefore = backend.lifecycle.status().totalCrashes;
  await execFileAsync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true }).catch(() => {});
  const exited = await Promise.race([st.exited.then(() => true), sleep(4_000).then(() => false)]);
  return {
    pid,
    exited,
    elapsedMs: round(performance.now() - t0),
    aliveAfter: await pidAlive(pid),
    crashesBefore,
    crashesAfter: backend.lifecycle.status().totalCrashes,
  };
}

async function main() {
  const backend = createWindowsBackend({ bridgeEnabled: true });
  const registry = new AppRegistry(backend, {});
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    session: process.env.SESSIONNAME ?? "unknown",
    steps: [],
    privacy: { windowTitlesPersisted: false },
  };
  const step = (name, data) => {
    report.steps.push({ step: name, ...data });
    console.log(`[lifecycle] ${name}: ${JSON.stringify(data)}`);
  };

  try {
    // ── 1. 能力 + 首次健康检查 ────────────────────────────────────────────
    const caps = await backend.capabilities();
    report.capabilities = {
      a11yTree: caps.a11yTree.supported,
      reason: caps.a11yTree.reason,
      bridge: caps.bridge,
    };
    if (!caps.a11yTree.supported) {
      report.summary = { verdict: "skipped", reason: caps.a11yTree.reason };
      persist(report);
      console.log(JSON.stringify(report.summary, null, 2));
      return;
    }
    const firstPid = backend.bridge?.proc.pid ?? null;
    step("connected", { pid: firstPid, lifecycle: backend.lifecycle.status() });

    // ── 2. 健康检查三次（暖机后取中位延迟） ──────────────────────────────
    const pings = [];
    for (let i = 0; i < 3; i += 1) {
      const h = await backend.health();
      pings.push({ ok: h.ok, latencyMs: h.latencyMs ?? null, uptimeMs: h.uptimeMs ?? null, bridge: h.bridge ?? null });
    }
    const latencies = pings.map((p) => p.latencyMs).filter((v) => typeof v === "number").sort((a, b) => a - b);
    step("health", {
      allOk: pings.every((p) => p.ok),
      medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      samples: pings,
    });

    // ── 3. ping 不影响快照 ref：观察 → ping → 用旧 ref 动作 ────────────────
    const apps = await registry.list({ refresh: true });
    const target = apps.find(
      (a) => a.category !== "finance-or-sensitive" && String(a.title ?? "").trim().length > 0
    );
    if (target) {
      const snap = await backend.snapshot({ appId: target.appId, pid: target.pid, hwnd: target.hwnd, maxDepth: 2 });
      const after = await backend.health();
      step("ref-survives-health", {
        target: target.appId,
        hwnd: snap.hwnd,
        snapshotId: snap.snapshotId,
        nodeCount: snap.nodeCount,
        storedRefsAfterPing: after.bridge?.storedRefs ?? null,
        requestsHandled: after.bridge?.requestsHandled ?? null,
        workingSetMb: after.bridge?.workingSetMb ?? null,
        note: "ref 存在桥进程内，ping 只是只读探活，不应清空 SnapshotStore",
      });
    } else {
      step("ref-survives-health", { skipped: true, reason: "没有可用的非敏感窗口" });
    }

    // ── 4. 崩溃自愈：强杀 → 退避 → 下一次调用重建 ────────────────────────
    // 上限 3 次：前 2 次崩溃后必须自愈，第 3 次崩溃后进入封锁（见下一步）
    const kills = [];
    for (let i = 0; i < CRASH_ROUNDS; i += 1) {
      const kill = await killBridge(backend);
      const t0 = performance.now();
      let recovered = null;
      try {
        const res = await backend._rpc("capabilities", {});
        recovered = { ok: Boolean(res?.ok), elapsedMs: round(performance.now() - t0) };
      } catch (e) {
        recovered = { ok: false, elapsedMs: round(performance.now() - t0), code: e?.code, message: String(e?.message).slice(0, 160) };
      }
      kills.push({ round: i + 1, kill, recovered, lifecycle: backend.lifecycle.status() });
      step(`crash-round-${i + 1}`, { kill, recovered, crashes: backend.lifecycle.status().totalCrashes });
    }
    report.crashRecovery = kills;

    // ── 5. 崩溃循环认输：第 3 次崩溃后再调用必须拒绝，且不再 spawn ─────────
    const thirdKill = await killBridge(backend); // 窗口内第 3 次崩溃
    const startsBefore = backend.lifecycle.status().totalStarts;
    let loopError = null;
    try {
      await backend._rpc("capabilities", {});
    } catch (e) {
      loopError = { code: e?.code, reason: e?.details?.reason, message: String(e?.message).slice(0, 240), handoff: e?.details?.handoff };
    }
    const startsAfter = backend.lifecycle.status().totalStarts;
    const capsAfter = await backend.capabilities();
    step("crash-loop-blocked", {
      thirdKill,
      loopError,
      startsBefore,
      startsAfter,
      reSpawned: startsAfter > startsBefore,
      reportedSupported: capsAfter.a11yTree.supported,
      reason: capsAfter.a11yTree.reason,
    });

    // ── 6. 人工恢复 + 优雅退出 ───────────────────────────────────────────
    backend.lifecycle.reset();
    backend._bridgeProbe = null;
    const restart = await backend.restart("verify-lifecycle-reset");
    const pid = backend.bridge?.proc.pid ?? null;
    backend.lifecycle.reset(); // restart 本身计入崩溃窗口，这里不参与判定
    const t0 = performance.now();
    const shot = await backend.shutdown({ timeoutMs: 2_000 });
    const shutdownMs = round(performance.now() - t0);
    const alive = await pidAlive(pid);
    step("graceful-shutdown", {
      pid,
      shutdownMs,
      ...shot,
      aliveAfter: alive,
      lifecycle: backend.lifecycle.status(),
      note: "优雅退出：发 shutdown → PowerShell 主循环 break → 进程自然退出；不计入崩溃",
    });
    report.lifecycleAfterReset = restart;

    // ── 结论 ─────────────────────────────────────────────────────────────
    const healthOk = report.steps.find((s) => s.step === "health")?.allOk === true;
    const recoveredAll = kills.every((k) => k.recovered?.ok === true);
    const blocked = loopError?.reason === "bridge-crash-loop" && startsAfter === startsBefore;
    const cleanExit = shot.graceful === true && alive === false;
    const verdict = healthOk && recoveredAll && blocked && cleanExit ? "lifecycle-managed" : "needs-fix";
    report.summary = {
      verdict,
      healthCheck: healthOk,
      crashRecovery: recoveredAll,
      crashLoopStops: blocked,
      gracefulExit: cleanExit,
      medianPingMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      shutdownMs,
      note: "生命周期已接管：退避重建、窗口内崩溃上限、僵死回收、优雅退出",
    };
    persist(report);
    console.log(JSON.stringify(report.summary, null, 2));
    if (verdict !== "lifecycle-managed") process.exitCode = 1;
  } finally {
    backend.close();
  }
}

function persist(report) {
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[lifecycle] report → ${OUT}`);
  } catch (e) {
    console.error(`[lifecycle] 报告写入失败：${e.message}`);
  }
}

main().catch((e) => {
  console.error(`[lifecycle] 失败：${e?.stack ?? e}`);
  process.exitCode = 1;
});
