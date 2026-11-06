#!/usr/bin/env node
/**
 * 视觉兜底真机验证（P2 第 5 项）。
 *
 * 单元测试能证明「换算公式对」「像素判定对」，但证明不了**真机上点得中**。
 * 这个脚本补的就是这一段：拉真窗口、真截图、真点击，用可观察的二值证据收口。
 *
 * 用例 1 —— 计算器：坐标帧换算是否真的在换算
 *   按 a11y 树里「七」这个按钮的屏幕 rect，反算出它在截图里的像素坐标，
 *   走 desktop_click_xy（frame=window）点下去，再看显示区是不是变成「显示为 7」。
 *   这是二值证据：换算少了窗口原点或缩放，落点就整体偏移，按到的会是别的键
 *   （或者什么都按不到），显示区不会正好是 7。再点「八」验一次可重复性。
 *
 * 用例 2 —— 字符映射表（sparse 应用）：像素验效能不能判出「变了/没变」
 *   这类应用点击前后 a11y 树一模一样，Verifier 只能靠像素签名。脚本先取两次
 *   静止签名（必须判「没变」，否则说明噪声阈值太低），再点一下字符格看判不判得出来。
 *
 * 安全边界：
 *  - 只拉起清单里的应用，都是只读或纯计算场景，不碰用户文档；
 *  - 越界坐标必须被拒绝，且**不发生真实点击**（这是防误点别的窗口的硬边界）；
 *  - 结束时优雅关闭自己拉起的进程（先 WM_CLOSE，2 s 后仍在才强杀）。
 *
 * 运行：
 *   node scripts/verify-visual-fallback.mjs
 *   node scripts/verify-visual-fallback.mjs --only calc,taskmgr --out reports/x.json
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DEEPCODE_AGENT_UIA_BRIDGE = process.env.DEEPCODE_AGENT_UIA_BRIDGE ?? "1";

const { createWindowsBackend } = await import("../src/backends/windows.mjs");
const { DesktopAgent } = await import("../src/agent.mjs");
const { defaultPolicy } = await import("../src/modules/policy-guard.mjs");
const { diffSignatures } = await import("../src/modules/pixel-signature.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p2-visual-fallback.json");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ONLY = (arg("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("--out", DEFAULT_OUT);

const SYS32 = "C:\\Windows\\System32";
const APPS = {
  // 计算器是 UWP：窗口属于 ApplicationFrameHost，不是 calc 进程本身
  calc: { id: "calc", exe: "calc.exe", args: () => [], appIds: ["applicationframehost", "calculatorapp", "calc"] },
  charmap: { id: "charmap", exe: `${SYS32}\\charmap.exe`, args: () => [], appIds: ["charmap"] },
  taskmgr: { id: "taskmgr", exe: `${SYS32}\\Taskmgr.exe`, args: () => [], appIds: ["taskmgr"] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => (typeof n === "number" ? Number(n.toFixed(2)) : n);
const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

/* ── 拉起 / 认领 / 关闭 ─────────────────────────────────────────────── */

function launch(entry) {
  const proc = spawn(entry.exe, entry.args(), { stdio: "ignore", windowsHide: false });
  proc.on("error", (e) => {
    proc.__spawnError = e;
  });
  return proc;
}

async function windowKeys(backend) {
  const apps = await backend.listApps().catch(() => []);
  return new Set(apps.filter((a) => a.hwnd).map((a) => a.hwnd));
}

/**
 * 认领「刚拉起的那个窗口」。
 * 只认**新出现的 hwnd**：单实例应用若只是被聚焦，我们没有可安全操作的实例，
 * 宁可如实报 pre-existing 也不去动用户的窗口。
 */
async function waitForWindow(backend, before, entry, proc, timeoutMs = 25_000) {
  const wanted = entry.appIds.map((s) => s.toLowerCase());
  const t0 = Date.now();
  for (;;) {
    if (proc?.__spawnError) {
      const err = new Error(`无法启动 ${entry.exe}：${proc.__spawnError.code}`);
      err.code = proc.__spawnError.code === "EACCES" ? "NEEDS_ELEVATION" : "APP_NOT_INSTALLED";
      throw err;
    }
    const apps = await backend.listApps().catch(() => []);
    const fresh = apps.filter((a) => a.hwnd && !before.has(a.hwnd));
    const hit = fresh.find((a) => wanted.some((w) => `${a.appId} ${a.processName}`.toLowerCase().includes(w)));
    if (hit) return { target: hit, owned: true };
    if (Date.now() - t0 > timeoutMs) {
      const existing = apps.find((a) => wanted.some((w) => `${a.appId} ${a.processName}`.toLowerCase().includes(w)));
      const err = new Error(existing ? `${entry.id} 只有已存在的实例，不接管用户窗口` : `等不到 ${entry.id} 的窗口`);
      err.code = existing ? "PRE_EXISTING_INSTANCE" : "WINDOW_TIMEOUT";
      throw err;
    }
    await sleep(300);
  }
}

async function pidAlive(pid) {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/fo", "csv", "/nh"], { windowsHide: true, encoding: "buffer" }, (err, stdout) => {
      if (err) return resolve(false);
      const text = Buffer.isBuffer(stdout) ? stdout.toString("latin1") : String(stdout ?? "");
      resolve(new RegExp(`^"[^"]+","${pid}"`, "m").test(text));
    });
  });
}

async function closeApp(pid, owned) {
  if (!owned || !pid) return { skipped: true, reason: "pre-existing-or-no-pid" };
  await new Promise((resolve) => execFile("taskkill", ["/PID", String(pid)], { windowsHide: true }, () => resolve()));
  for (let i = 0; i < 8; i += 1) {
    if (!(await pidAlive(pid))) return { graceful: true };
    await sleep(250);
  }
  await new Promise((resolve) => execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, () => resolve()));
  return { forced: true };
}

/* ── agent ──────────────────────────────────────────────────────────── */

function makeAgent(backend) {
  const allowed = new Set();
  for (const id of Object.keys(APPS)) {
    allowed.add(id);
    for (const a of APPS[id].appIds) allowed.add(a);
  }
  const policy = {
    ...defaultPolicy(),
    enabled: true,
    permissionMode: "auto",
    allowedApps: [...allowed].map((appId) => ({ appId, always: true, scopes: ["read", "write"] })),
    deniedApps: [],
    allowScreenshot: true,
    allowCoordinateInput: true,
  };
  return new DesktopAgent({ backend, policy, limits: { ...policy, maxScreenshots: 8, maxSteps: 40 } });
}

/** 连续两次快照都能看到目标节点才算就绪（UWP 冷启动先出窗口、后出内容） */
async function waitForRole(agent, target, predicate, timeoutMs = 15_000) {
  const t0 = Date.now();
  let last = null;
  let hits = 0;
  while (Date.now() - t0 < timeoutMs) {
    last = await agent.callTool("desktop_snapshot", { ...target, maxDepth: 5 });
    const nodes = flatten(last.tree ?? []);
    hits = predicate(nodes) ? hits + 1 : 0;
    if (hits >= 2) return last;
    await sleep(400);
  }
  return last;
}

/**
 * 等界面稳定：连续两帧签名一致才算静止。
 * 「刚打开就测」会把渲染动画当成变化，得出「像素噪声太高」的错误结论——
 * 这不是阈值问题，是取样时机问题。
 */
async function waitSettled(backend, app, { tries = 10, delayMs = 200 } = {}) {
  let prev = null;
  let lastDiff = null;
  for (let i = 0; i < tries; i += 1) {
    const sig = await backend.pixelSignature({ ...app, activate: i === 0 }).catch((e) => ({ ok: false, message: String(e) }));
    if (!sig?.ok) return { ok: false, error: sig?.message ?? "signature failed", pairs: i };
    if (prev) {
      lastDiff = diffSignatures(prev, sig.base64);
      if (!lastDiff.changed) {
        return { ok: true, stable: true, settledAfterMs: i * delayMs, pairs: i, lastDiff };
      }
    }
    prev = sig.base64;
    await sleep(delayMs);
  }
  return { ok: true, stable: false, settledAfterMs: tries * delayMs, pairs: tries, lastDiff };
}

/** 屏幕坐标 → 截图图像像素坐标（脚本侧独立算一遍，用真实工具做交叉验证） */
function toImagePoint(frame, screenX, screenY) {
  return {
    x: Math.max(0, Math.round((screenX - frame.x) / frame.scaleX)),
    y: Math.max(0, Math.round((screenY - frame.y) / frame.scaleY)),
  };
}

/* ── 用例 1：计算器 —— 坐标帧换算 ───────────────────────────────────── */

async function caseCalc(backend) {
  const entry = APPS.calc;
  const before = await windowKeys(backend);
  const proc = launch(entry);
  const { target, owned } = await waitForWindow(backend, before, entry, proc);
  const app = { appId: target.appId, pid: target.pid, hwnd: target.hwnd };
  const agent = makeAgent(backend);
  const out = { id: "calc", app, owned, steps: [], verdict: "unknown" };

  try {
    const snap = await waitForRole(
      agent,
      app,
      (nodes) => nodes.some((n) => n.name === "七" && /button/i.test(String(n.role)))
    );
    const nodes = flatten(snap.tree ?? []);
    out.tree = { nodes: nodes.length, verdict: snap.treeQuality?.verdict ?? null };

    const btn7 = nodes.find((n) => n.name === "七" && /button/i.test(String(n.role)) && n.rect?.width > 0);
    const btn8 = nodes.find((n) => n.name === "八" && /button/i.test(String(n.role)) && n.rect?.width > 0);
    if (!btn7 || !btn8) {
      out.verdict = "no-keypad-buttons";
      return out;
    }

    const shot = await agent.callTool("desktop_screenshot", { ...app, reason: "visual-fallback-verify", activate: true });
    if (!shot.ok || !shot.frame) {
      out.verdict = "screenshot-unavailable";
      out.error = shot.message ?? shot.code;
      return out;
    }
    out.frame = {
      origin: { x: shot.frame.x, y: shot.frame.y },
      size: { width: shot.frame.width, height: shot.frame.height },
      image: { width: shot.width, height: shot.height },
      scale: round(shot.frame.scaleX),
    };

    // 1) 越界硬边界：必须拒绝，且不能真的点下去
    const oob = await agent.callTool("desktop_click_xy", {
      ...app,
      x: shot.width + 500,
      y: Math.round(shot.height / 2),
    });
    out.steps.push({
      step: "out-of-bounds-rejected",
      pass: oob.ok === false && oob.code === "ACTION_DENIED",
      code: oob.code,
    });

    // 2) 点「七」→ 显示区必须变成 7
    const p7 = toImagePoint(shot.frame, btn7.rect.x + btn7.rect.width / 2, btn7.rect.y + btn7.rect.height / 2);
    const click7 = await agent.callTool("desktop_click_xy", { ...app, x: p7.x, y: p7.y });
    await sleep(300);
    let after = await agent.callTool("desktop_snapshot", { ...app, maxDepth: 5 });
    const shows7 = flatten(after.tree ?? []).some((n) => /显示为\s*7\b/.test(String(n.name ?? "")));
    out.steps.push({
      step: "click-7",
      pass: click7.ok === true && shows7,
      imagePoint: p7,
      screenRect: btn7.rect,
      clickOk: click7.ok === true,
      converted: click7.action?.converted,
      resolved: click7.action?.resolved,
      snapped: click7.action?.snapped ?? null,
      pixelChanged: click7.verification?.pixelChanged ?? null,
      displayShows7: shows7,
    });

    // 3) 再点「八」→ 显示区必须是 78（第一下是 7，第二下接在后面：证明连按两次落点都对）
    const shot2 = await agent.callTool("desktop_screenshot", { ...app, reason: "verify-2", activate: true });
    const p8 = toImagePoint(shot2.frame, btn8.rect.x + btn8.rect.width / 2, btn8.rect.y + btn8.rect.height / 2);
    const click8 = await agent.callTool("desktop_click_xy", { ...app, x: p8.x, y: p8.y });
    await sleep(300);
    after = await agent.callTool("desktop_snapshot", { ...app, maxDepth: 5 });
    const shows8 = flatten(after.tree ?? []).some((n) => /显示为\s*78\b/.test(String(n.name ?? "")));
    out.steps.push({
      step: "click-8",
      pass: click8.ok === true && shows8,
      imagePoint: p8,
      clickOk: click8.ok === true,
      displayShows78: shows8,
    });

    out.verdict = out.steps.every((s) => s.pass) ? "coordinate-frame-verified" : "partial";
    return out;
  } finally {
    out.closed = await closeApp(target.pid, owned);
  }
}

/* ── 用例 2：sparse 应用 —— 像素验效 ────────────────────────────────── */

async function caseSparse(backend, id) {
  const entry = APPS[id];
  const before = await windowKeys(backend);
  const proc = launch(entry);
  const { target, owned } = await waitForWindow(backend, before, entry, proc);
  const app = { appId: target.appId, pid: target.pid, hwnd: target.hwnd };
  const agent = makeAgent(backend);
  const out = { id, app, owned, steps: [], verdict: "unknown" };

  try {
    const snap = await agent.callTool("desktop_snapshot", { ...app, maxDepth: 4 });
    const nodes = flatten(snap.tree ?? []);
    out.tree = {
      nodes: nodes.length,
      verdict: snap.treeQuality?.verdict ?? null,
      reason: snap.treeQuality?.reason ?? null,
    };

    const shot = await agent.callTool("desktop_screenshot", { ...app, reason: "sparse-visual-fallback", activate: true });
    if (!shot.ok || !shot.frame) {
      out.verdict = "screenshot-unavailable";
      out.error = shot.message ?? shot.code;
      return out;
    }
    out.frame = {
      origin: { x: shot.frame.x, y: shot.frame.y },
      size: { width: shot.frame.width, height: shot.frame.height },
      scale: round(shot.frame.scaleX),
    };

    // 先证明「静止画面不会被判成变化」——噪声阈值太低的话，验效等于永远通过。
    // 窗口刚出现时还在渲染/动画，此时两帧本来就不同，所以要等它稳定下来再测；
    // 顺便把「多久稳定」记下来，这是真实使用里 before 帧能不能信的前提。
    const settle = await waitSettled(backend, app, { tries: 10, delayMs: 200 });
    if (!settle.ok) {
      out.verdict = "pixel-signature-unavailable";
      out.error = settle.error ?? "no signature";
      return out;
    }
    out.steps.push({
      step: "static-diff",
      pass: settle.stable,
      settledAfterMs: settle.settledAfterMs,
      pairs: settle.pairs,
      lastDiff: settle.lastDiff,
      verdict: settle.stable ? "settled-identical" : "never-settled",
    });

    // 点字符网格里的一个格子：选中态会让像素明显变化（也是非破坏性操作）
    const imgX = Math.round(shot.width * 0.45);
    const imgY = Math.round(shot.height * 0.45);
    const click = await agent.callTool("desktop_click_xy", { ...app, x: imgX, y: imgY });
    out.steps.push({
      step: "click-and-verify",
      pass: click.ok === true,
      imagePoint: { x: imgX, y: imgY },
      clickOk: click.ok === true,
      code: click.code ?? null,
      blind: click.action?.blind ?? null,
      snapped: click.action?.snapped ?? null,
      evidence: click.verification?.evidence ?? null,
      treeChanged: click.verification?.treeChanged ?? null,
      pixelChanged: click.verification?.pixelChanged ?? null,
      attempts: click.attempts ?? null,
    });

    const staticOk = out.steps[0].pass;
    const clickStep = out.steps[1];
    const detected = clickStep.pixelChanged === true || clickStep.treeChanged === true;
    out.verdict = !staticOk
      ? "ui-never-settled"
      : detected
        ? "pixel-verify-works"
        : "pixel-static-ok-click-undetected";
    return out;
  } finally {
    out.closed = await closeApp(target.pid, owned);
  }
}

/* ── main ───────────────────────────────────────────────────────────── */

const PASS_VERDICTS = new Set(["coordinate-frame-verified", "pixel-verify-works"]);

async function main() {
  const backend = createWindowsBackend();
  const status = await backend.bridgeStatus();
  if (!status.supported) {
    console.error(`UIA 桥不可用：${status.reason}`);
    process.exit(2);
  }
  const report = {
    startedAt: new Date().toISOString(),
    bridge: { session: status.details?.session, psVersion: status.details?.psVersion },
    cases: [],
    verdict: "unknown",
  };
  const wanted = ONLY.length ? ONLY : ["calc", "charmap"];
  for (const id of wanted) {
    if (!APPS[id]) {
      report.cases.push({ id, verdict: "unknown-target" });
      continue;
    }
    process.stderr.write(`\n=== ${id} ===\n`);
    try {
      const row = id === "calc" ? await caseCalc(backend) : await caseSparse(backend, id);
      process.stderr.write(`${id}: ${row.verdict}\n`);
      for (const s of row.steps ?? []) process.stderr.write(`  - ${JSON.stringify(s)}\n`);
      report.cases.push(row);
    } catch (err) {
      process.stderr.write(`${id}: error ${err?.message}\n`);
      report.cases.push({ id, verdict: "error", error: String(err?.message ?? err), code: err?.code ?? null });
    }
  }
  const ok = report.cases.length > 0 && report.cases.every((c) => PASS_VERDICTS.has(c.verdict));
  report.verdict = ok ? "visual-fallback-verified" : "partial";
  report.finishedAt = new Date().toISOString();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await backend.shutdown?.().catch(() => {});
  process.stdout.write(
    `${JSON.stringify({ verdict: report.verdict, cases: report.cases.map((c) => [c.id, c.verdict]), out: OUT }, null, 2)}\n`
  );
  process.exit(ok ? 0 : 1);
}

await main();
