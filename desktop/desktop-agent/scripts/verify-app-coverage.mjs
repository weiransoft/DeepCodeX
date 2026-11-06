#!/usr/bin/env node
/**
 * 真实应用覆盖率矩阵（P2 准入第 1 项）。
 *
 * 与 `coverage-report.mjs` 的分工：
 *  - `coverage-report.mjs` 是**被动采样**：对当前桌面上碰巧开着的窗口逐个快照。
 *    它适合回答「现在这台机器上树好不好」，但凑不齐固定的应用集，也没法复现。
 *  - 本脚本是**主动采样**：按固定清单逐个拉起目标应用（用自建的空白/临时文件），
 *    在多个深度上采样，再逐家给出产品级判定。同一份清单、同一套判据，可重复。
 *
 * 每个应用回答三个问题：
 *  1. 它在 UIA 里暴露了什么（角色直方图 / 命名可操作节点数 / 快照耗时）；
 *  2. 深一点看能不能救回来（depth 4 → 8，区分 deferred 与 sparse）；
 *  3. 产品该拿它怎么办（语义树可操作 / 需下钻 / 视觉兜底 / 拒绝）。
 *
 * 安全边界：
 *  - **只读**：不 invoke、不 type、不 click，只 snapshot；
 *  - 只拉起清单里的应用，且每个都是空白实例或自建临时文件，不碰用户文档；
 *  - 不落盘窗口标题全文，只记长度；不截图；
 *  - 结束时只关**自己拉起的**进程（taskkill 不带 /F 先发 WM_CLOSE，2 s 后仍在才强杀）。
 *
 * 运行：
 *   DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/verify-app-coverage.mjs
 *   ... --only notepad,calc --depths 3,4,8 --keep --out reports/x.json
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { AppRegistry } from "../src/modules/app-registry.mjs";
import { assessSnapshot, channelForQuality } from "../src/modules/tree-quality.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p2-app-coverage.json");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const ONLY = (arg("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const DEPTHS = (arg("--depths", "4,8") || "4,8")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 1 && n <= 8)
  .sort((a, b) => a - b);
const OUT = arg("--out", DEFAULT_OUT);
const KEEP = flag("--keep");
const QUIET = flag("--quiet");

const sys32 = "C:\\Windows\\System32";
const notepadExe = `${sys32}\\notepad.exe`;
const paintExe = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "mspaint.exe");
const wtExe = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "wt.exe");
const OFFICE = "C:\\Program Files\\Microsoft Office\\root\\Office16";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Number(n.toFixed(2));
const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

/**
 * 目标清单。`family` 用来在窗口列表里认领「刚拉起的那个窗口」：
 * UWP 应用的 spawn pid 是启动器，真正的窗口属于另一个进程（CalculatorApp /
 * ApplicationFrameHost），所以不能只按 pid 认，必须按「新出现的窗口 + 家族名」认。
 */
const CATALOG = [
  {
    id: "notepad",
    label: "记事本",
    family: "win32-classic",
    exe: notepadExe,
    args: (dir) => [join(dir, "coverage.txt")],
    prepare: (dir) => writeFileSync(join(dir, "coverage.txt"), "DCX_COVERAGE_BASELINE\n", "utf8"),
    // Win11 的记事本已换成 WinUI：编辑面是 Document 而不是 Edit（实测 d4 树里 Document:1）
    readyRoles: ["Document", "Edit"],
    appIds: ["notepad"],
    titleHint: "coverage",
  },
  {
    id: "calc",
    label: "计算器",
    family: "uwp-xaml",
    exe: `${sys32}\\calc.exe`,
    args: () => [],
    // UWP：窗口可能属于 CalculatorApp，也可能挂在上一个 ApplicationFrameHost 里
    appIds: ["calculator", "applicationframehost"],
    settleMs: 1_800,
  },
  {
    id: "paint",
    label: "画图",
    family: "uwp-desktop-bridge",
    exe: paintExe,
    // WindowsApps 下的执行别名是 APPEXECLINK reparse point：Node 的 existsSync
    // 对它返回 false（PowerShell Test-Path 却是 true），所以只能靠 spawn 的 error 判定
    aliased: true,
    args: () => [],
    appIds: ["mspaint", "paint", "applicationframehost"],
    settleMs: 2_200,
  },
  {
    id: "explorer",
    label: "文件资源管理器",
    family: "shell",
    exe: "C:\\Windows\\explorer.exe",
    args: (dir) => [dir],
    appIds: ["explorer"],
    readyRoles: ["List", "ListItem"],
    settleMs: 900,
  },
  {
    id: "cmd",
    label: "命令提示符",
    family: "console",
    exe: `${sys32}\\cmd.exe`,
    args: () => ["/k", "title DCX_COVERAGE_CMD"],
    appIds: ["cmd", "conhost", "windowsterminal"],
    settleMs: 700,
  },
  {
    id: "ps5",
    label: "Windows PowerShell 5",
    family: "console",
    exe: `${sys32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: () => ["-NoLogo", "-NoProfile"],
    appIds: ["powershell", "windowsterminal"],
    settleMs: 1_200,
  },
  {
    id: "windowsterminal",
    label: "Windows 终端",
    family: "console-modern",
    exe: wtExe,
    aliased: true,
    args: () => [],
    appIds: ["windowsterminal"],
    settleMs: 2_000,
    note: "GUI 子系统的控制台宿主；cmd/powershell 这类控制台进程在当前 harness 里分配不到窗口",
  },
  {
    id: "taskmgr",
    label: "任务管理器",
    family: "win32-modern",
    exe: `${sys32}\\Taskmgr.exe`,
    args: () => [],
    appIds: ["taskmgr"],
    settleMs: 1_500,
  },
  {
    id: "charmap",
    label: "字符映射表",
    family: "win32-dialog",
    exe: `${sys32}\\charmap.exe`,
    args: () => [],
    appIds: ["charmap"],
    settleMs: 900,
  },
  {
    id: "msinfo32",
    label: "系统信息",
    family: "win32-treeview",
    exe: `${sys32}\\msinfo32.exe`,
    args: () => [],
    appIds: ["msinfo32"],
    settleMs: 3_500,
  },
  {
    id: "perfmon",
    label: "性能监视器",
    family: "mmc",
    exe: `${sys32}\\perfmon.exe`,
    args: () => [],
    appIds: ["perfmon", "mmc"],
    settleMs: 3_500,
  },
  {
    id: "cleanmgr",
    label: "磁盘清理",
    family: "win32-dialog",
    exe: `${sys32}\\cleanmgr.exe`,
    args: () => [],
    appIds: ["cleanmgr"],
    settleMs: 2_000,
  },
  {
    id: "settings",
    label: "设置",
    family: "uwp-appframe",
    exe: "C:\\Windows\\explorer.exe",
    args: () => ["ms-settings:"],
    appIds: ["applicationframehost", "systemsettings"],
    settleMs: 2_200,
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    family: "browser",
    exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    args: () => ["--new-window", "about:blank"],
    appIds: ["msedge"],
    settleMs: 2_500,
    note: "浏览器外壳：策略层本就拒绝 GUI 驱动，这里只测树是否可用",
  },
  {
    id: "word",
    label: "Word",
    family: "office-doc",
    exe: `${OFFICE}\\WINWORD.EXE`,
    args: (dir) => [join(dir, "coverage.txt")],
    prepare: (dir) => writeFileSync(join(dir, "coverage.txt"), "DCX_COVERAGE_BASELINE\n", "utf8"),
    appIds: ["winword"],
    titleHint: "coverage",
    onlyWithOffice: true,
    settleMs: 3_000,
  },
  {
    id: "excel",
    label: "Excel",
    family: "office-grid",
    exe: `${OFFICE}\\EXCEL.EXE`,
    args: (dir) => [join(dir, "coverage.csv")],
    prepare: (dir) => writeFileSync(join(dir, "coverage.csv"), "DCX_COVERAGE_BASELINE\n", "utf8"),
    appIds: ["excel"],
    titleHint: "coverage",
    onlyWithOffice: true,
    settleMs: 3_000,
  },
];

/** 拉起一个应用，返回 {proc, pid}；exe 不存在时由 spawn 的 error 事件回报（别名无法预检） */
function launch(entry, dir) {
  if (entry.prepare) entry.prepare(dir);
  const proc = spawn(entry.exe, entry.args(dir), { stdio: "ignore", windowsHide: false });
  proc.on("error", (e) => {
    proc.__spawnError = e;
  });
  return proc;
}

/** 当前所有带 hwnd 的顶层窗口快照，用于「拉起前后做差」认领新窗口 */
async function windowKeys(backend) {
  const apps = await backend.listApps().catch(() => []);
  return new Map(apps.filter((a) => a.hwnd).map((a) => [a.hwnd, a]));
}

/**
 * 等「我们刚拉起的那个窗口」出现。
 *
 * 只按 pid 认行不通：UWP 的 spawn pid 是启动器（会立刻退出），窗口属于
 * CalculatorApp / ApplicationFrameHost 等其他进程。所以先做「前后差集」，
 * 再按 appId 家族名筛，并优先选新出现的 hwnd。
 *
 * 两种「没有新窗口」的情况必须分开处理，否则会把结论搞错：
 *  1. **单实例应用**（任务管理器、设置）：spawn 只是聚焦已存在的窗口，
 *     没有新 hwnd。这类可以采样（只读），但**绝不能关闭**——那是用户的窗口。
 *     所以回 `owned:false`，收尾时跳过。
 *  2. **进程当场退出**（控制台子系统在当前执行环境拿不到控制台窗口）：
 *     这不是应用不可自动化，是 harness 限制，要记成 launch-blocked。
 */
async function waitForNewWindow(backend, before, entry, proc, timeoutMs = 25_000) {
  const t0 = Date.now();
  let last = [];
  const wanted = (entry.appIds ?? []).map((s) => String(s).toLowerCase());
  /**
   * 认领窗口必须靠显式白名单，不能靠「只有一个新窗口」猜。
   * 实测教训：拉起 ps5 时桌面上恰好弹出别的安装器窗口，凭「唯一新窗口」就把
   * 它当成了 PowerShell 采样，得到的结论（sparse）跟目标应用毫无关系。
   */
  const familyHit = (a) => {
    if (!wanted.length) return true;
    const hay = `${a.appId} ${a.processName}`.toLowerCase();
    return wanted.some((w) => hay.includes(w));
  };
  for (;;) {
    if (proc?.__spawnError) {
      const sc = proc.__spawnError.code ?? "SPAWN_ERROR";
      // EACCES 不是「没装」而是「不允许」：性能监视器这类工具需要管理员权限，
      // 混记为 app-not-installed 会让人以为应用不存在，排查方向直接跑偏。
      const err =
        sc === "EACCES"
          ? Object.assign(new Error("启动被拒绝（EACCES）：该程序需要管理员权限"), { code: "NEEDS_ELEVATION" })
          : Object.assign(new Error(`未安装或无法启动：${sc}`), { code: "APP_NOT_INSTALLED" });
      throw err;
    }
    const apps = await backend.listApps().catch(() => []);
    last = apps;
    const fresh = apps.filter((a) => a.hwnd && !before.has(a.hwnd));
    const hit = fresh.find(familyHit) ?? (wanted.length ? null : (fresh[0] ?? null));
    if (hit) {
      return { app: hit, matchedBy: "new-window", owned: true, elapsedMs: Date.now() - t0, totalWindows: apps.length };
    }
    // 进程已经退出且始终没有新窗口：可能是单实例应用（第二个实例直接退出），
    // 也可能真的起不来。先看桌面上有没有同家族的既有窗口，再决定是采样还是记失败。
    if (proc?.exitCode !== null && Date.now() - t0 > 2_500) {
      const existing = apps.filter((a) => a.hwnd && familyHit(a));
      if (existing.length) {
        return {
          app: existing[0],
          matchedBy: "pre-existing-instance",
          owned: false,
          elapsedMs: Date.now() - t0,
          totalWindows: apps.length,
          exitedEarly: proc.exitCode,
        };
      }
      const err = new Error(`进程启动后立即退出（exitCode=${proc.exitCode}），未产生窗口`);
      err.code = "PROCESS_EXITED";
      err.exitCode = proc.exitCode;
      throw err;
    }
    if (Date.now() - t0 > timeoutMs) {
      // 单实例：没有新窗口，但桌面上已有同家族窗口 → 当作「既有实例」采样
      const existing = apps.filter((a) => a.hwnd && familyHit(a));
      if (existing.length) {
        return { app: existing[0], matchedBy: "pre-existing-instance", owned: false, elapsedMs: Date.now() - t0, totalWindows: apps.length };
      }
      const err = new Error(`等待窗口超时（${timeoutMs} ms）`);
      err.code = "WINDOW_TIMEOUT";
      err.visible = last.slice(0, 12).map((a) => ({ appId: a.appId, titleLength: String(a.title ?? "").length }));
      throw err;
    }
    await sleep(300);
  }
}

/** 等「能读」而不是「窗口出现」：目标角色连续两次快照都在才算就绪 */
async function waitReady(backend, target, roles, timeoutMs = 12_000) {
  if (!roles?.length) return { ready: true, waitedMs: 0, skipped: true };
  const t0 = Date.now();
  let streak = 0;
  for (;;) {
    try {
      const snap = await backend.snapshot({ ...target, maxDepth: 4 });
      const present = flatten(snap.tree).some((n) => roles.includes(n.role));
      streak = present ? streak + 1 : 0;
      if (streak >= 2) return { ready: true, waitedMs: Date.now() - t0, role: roles.join("|") };
    } catch {
      streak = 0;
    }
    if (Date.now() - t0 > timeoutMs) return { ready: false, waitedMs: Date.now() - t0, role: roles.join("|") };
    await sleep(350);
  }
}

const CONTENT_ROLES = new Set(["Document", "Edit", "TextArea", "DataGrid", "DataItem", "ListItem", "TreeItem", "Table"]);

/**
 * 重新认领目标窗口。
 *
 * 启动闪屏会在加载完成后被真正的主窗口**替换**（Office 实测：先匹配到的 hwnd
 * 几秒后就不存在了，之后所有快照都是 OBSERVATION_FAILED）。这时不能认死
 * 第一次拿到的 hwnd，要按家族重新找：优先标题带文件名的那个（文档窗口），
 * 其次保留原 hwnd，最后退到标题最长的（通常是主窗口，弹窗标题更短）。
 */
async function resolveTarget(backend, entry, current) {
  const apps = await backend.listApps().catch(() => []);
  const wanted = (entry.appIds ?? []).map((s) => String(s).toLowerCase());
  const fam = apps.filter((a) => {
    if (!a.hwnd) return false;
    if (!wanted.length) return true;
    const hay = `${a.appId} ${a.processName}`.toLowerCase();
    return wanted.some((w) => hay.includes(w));
  });
  if (!fam.length) return null;
  if (entry.titleHint) {
    const hit = fam.find((a) => String(a.title ?? "").toLowerCase().includes(entry.titleHint));
    if (hit) return { appId: hit.appId, pid: hit.pid, hwnd: hit.hwnd, matchedBy: "title-hint" };
  }
  const same = fam.find((a) => a.hwnd === current?.hwnd);
  if (same) return { appId: same.appId, pid: same.pid, hwnd: same.hwnd, matchedBy: "same-hwnd" };
  fam.sort((a, b) => String(b.title ?? "").length - String(a.title ?? "").length);
  return { appId: fam[0].appId, pid: fam[0].pid, hwnd: fam[0].hwnd, matchedBy: "longest-title" };
}

async function sampleDepth(backend, target, depth) {
  const t0 = performance.now();
  try {
    const snap = await backend.snapshot({ ...target, maxDepth: depth });
    const ms = round(performance.now() - t0);
    const nodes = flatten(snap.tree);
    const quality = assessSnapshot(snap);
    const roles = {};
    for (const n of nodes) roles[n.role ?? "unknown"] = (roles[n.role ?? "unknown"] ?? 0) + 1;
    const contentRoles = Object.keys(roles).filter((r) => CONTENT_ROLES.has(r));
    return {
      depth,
      ok: true,
      elapsedMs: ms,
      nodeCount: snap.nodeCount,
      returnedNodes: nodes.length,
      actionableNodes: nodes.filter((n) => n.role !== "Window" && n.enabled !== false && n.rect?.width > 0).length,
      namedNodes: nodes.filter((n) => String(n.name ?? "").trim().length > 0).length,
      quality,
      channel: channelForQuality(quality),
      /** 是否存在「装了内容」的容器：浏览器只暴露外壳时，这里会空 */
      contentSurface: contentRoles,
      topRoles: Object.entries(roles)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([r, c]) => `${r}:${c}`),
      roles,
    };
  } catch (e) {
    return {
      depth,
      ok: false,
      elapsedMs: round(performance.now() - t0),
      error: { code: e?.code ?? "INTERNAL", message: String(e?.message ?? e).slice(0, 200) },
    };
  }
}

/**
 * 产品化判定：这是本脚本的**结论**，不是数据。
 *
 * 三个桶对应三种真实处置，避免「树不好」被笼统地记成「不支持」：
 *  - operate-a11y：语义树里有足够的有名字可操作节点，模型可以按名字定位；
 *  - visual-fallback：树存在但不可按名字定位（自绘/容器化），必须补视觉兜底，
 *    当前产品行为是**拒绝**——这是已知缺口，不是设计选择；
 *  - reject：树几乎为空且无法归因（游戏/加密/全自绘），明确拒绝并说明原因。
 */
function decide(row) {
  const samples = row.depths.filter((d) => d.ok);
  if (!samples.length) {
    return { decision: "reject", reason: "全部深度快照失败，无法观察", currentProduct: "拒绝（OBSERVATION_FAILED）" };
  }
  const deepest = samples[samples.length - 1];
  const good = samples.find((d) => d.quality.verdict === "good");

  // 浏览器外壳是特例：树可能判 good（标签栏/地址栏/工具栏都在），但内容区
  // 一个可操作节点都没有。这时「按名字定位」只够点浏览器自己的按钮，够不到页面。
  // 产品上必须走 DOM/CDP——这正是策略层对浏览器硬拒绝 GUI 的原因。
  if (row.family === "browser") {
    const surface = deepest.contentSurface ?? [];
    return {
      decision: "dom-channel-required",
      minDepth: null,
      reason: surface.length
        ? `外壳可定位，且出现内容容器 ${surface.join("/")}；页面仍需 CDP 才能可靠读写`
        : `树判 ${deepest.quality.verdict}，但只有外壳（${deepest.topRoles.slice(0, 4).join(" ")}），没有内容容器`,
      currentProduct: "策略拒绝 GUI，走 DOM/CDP",
    };
  }

  if (good) {
    return {
      decision: "operate-a11y",
      minDepth: good.depth,
      reason: `depth ${good.depth} 起有 ${good.quality.namedActionableCount} 个有名字的可操作节点，可按名字定位`,
      currentProduct: "走语义树（gui-a11y）",
    };
  }
  const v = deepest.quality.verdict;
  if (v === "deferred") {
    // 到了可用深度上限还是 deferred：说明不是「太小」，是「还没展开」
    return {
      decision: "depth-budget-exhausted",
      minDepth: null,
      reason: `depth ${deepest.depth} 仍未展开完（${deepest.quality.completeness.reason}），桥的深度上限是 8`,
      currentProduct: "需要提高深度预算或改成分批下钻，当前会一直判 deferred",
    };
  }
  if (v === "empty") {
    return {
      decision: "reject",
      reason: `depth ${deepest.depth} 处整棵树为空（节点 0），没有任何可定位目标`,
      currentProduct: "拒绝（CAPABILITY_UNAVAILABLE）",
    };
  }
  return {
    decision: "visual-fallback",
    reason: `最深只到 sparse：${deepest.quality.reason}（命名可操作 ${deepest.quality.namedActionableCount} 个）`,
    currentProduct: "当前拒绝；需视觉兜底才能支持",
  };
}

async function closeApp(target, proc, { owned = true } = {}) {
  const out = { graceful: false, forced: false, skipped: false };
  // 复用用户已开的窗口时不能关——那不是我们拉起的进程
  if (!owned) return { ...out, skipped: true, reason: "pre-existing-instance" };
  const pid = target?.pid ?? proc?.pid;
  if (!pid) return { ...out, skipped: true, reason: "no-pid" };
  if (!(await pidAlive(pid))) return { ...out, alreadyExited: true };
  // 不带 /F 的 taskkill 会向该进程的顶层窗口发 WM_CLOSE——不需要抢前台，
  // 也不会像强杀那样留下「上次启动失败」的会话状态（见 §3.9 第 11 条）。
  await new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid)], { windowsHide: true }, () => resolve());
  });
  for (let i = 0; i < 8; i += 1) {
    if (!(await pidAlive(pid))) return { ...out, graceful: true };
    await sleep(250);
  }
  await new Promise((resolve) => {
    execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, () => resolve());
  });
  return { ...out, forced: true };
}

async function pidAlive(pid) {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/fo", "csv", "/nh"], { windowsHide: true, encoding: "buffer" }, (err, stdout) => {
      if (err) return resolve(false);
      const text = Buffer.isBuffer(stdout) ? stdout.toString("latin1") : String(stdout ?? "");
      // CSV 第二列才是 PID；不能直接 includes(pid)，内存列里也会出现相同数字
      resolve(new RegExp(`^"[^"]+","${pid}"`, "m").test(text));
    });
  });
}

async function runOne(backend, entry) {
  const row = {
    id: entry.id,
    label: entry.label,
    family: entry.family,
    note: entry.note ?? null,
    installed: entry.aliased ? true : existsSync(entry.exe),
    verdict: "not-run",
    depths: [],
  };
  if (!row.installed) {
    row.verdict = "app-not-installed";
    return row;
  }
  const dir = KEEP ? mkdtempSync(join(tmpdir(), `dcx-cov-${entry.id}-`)) : mkdtempSync(join(tmpdir(), `dcx-cov-${entry.id}-`));
  row.dir = KEEP ? dir : null;

  let proc = null;
  let target = null;
  try {
    const before = await windowKeys(backend);
    proc = launch(entry, dir);
    row.spawnPid = proc.pid ?? null;

    const found = await waitForNewWindow(backend, before, entry, proc);
    row.window = {
      appId: found.app.appId,
      processName: found.app.processName,
      pid: found.app.pid,
      hwnd: found.app.hwnd,
      matchedBy: found.matchedBy,
      owned: found.owned,
      waitedMs: found.elapsedMs,
      totalWindows: found.totalWindows,
      enumSource: found.app.enumSource,
      titleLength: String(found.app.title ?? "").length,
    };
    target = { appId: found.app.appId, pid: found.app.pid, hwnd: found.app.hwnd };
    if (!found.owned) {
      // 复用用户已开的窗口：只读采样可以，收尾绝不能关（见 closeApp 的 owned 判据）
      row.note = `${row.note ? `${row.note}；` : ""}采样的是已存在的单实例窗口，未做任何关闭动作`;
    }

    if (entry.settleMs) await sleep(entry.settleMs);
    const ready = await waitReady(backend, target, entry.readyRoles);
    row.ready = ready;

    // 闪屏换壳后重新认领，避免拿着已销毁的 hwnd 一路 OBSERVATION_FAILED
    const retarget = await resolveTarget(backend, entry, target);
    if (retarget && retarget.hwnd !== target.hwnd) {
      row.window.retargeted = { from: target.hwnd, to: retarget.hwnd, by: retarget.matchedBy };
      target = { appId: retarget.appId, pid: retarget.pid, hwnd: retarget.hwnd };
    }

    for (const depth of DEPTHS) {
      let sample = await sampleDepth(backend, target, depth);
      if (!sample.ok && sample.error?.code === "OBSERVATION_FAILED") {
        // 窗口可能在采样间隙又被替换：再认领一次，仍失败才如实记录
        const again = await resolveTarget(backend, entry, target);
        if (again && again.hwnd !== target.hwnd) {
          row.window.retargeted ??= { from: target.hwnd, to: again.hwnd, by: again.matchedBy };
          target = { appId: again.appId, pid: again.pid, hwnd: again.hwnd };
          sample = await sampleDepth(backend, target, depth);
          sample.retriedAfterRetarget = true;
        }
      }
      row.depths.push(sample);
      if (!QUIET) {
        const q = sample.ok ? `${sample.quality.verdict}/${sample.quality.namedActionableCount}` : sample.error.code;
        console.error(`  ${entry.id} depth=${depth} ${q} ${sample.elapsedMs}ms`);
      }
    }

    const d = decide(row);
    row.decision = d.decision;
    row.reason = d.reason;
    row.currentProduct = d.currentProduct;
    row.minDepth = d.minDepth ?? null;
    row.verdict = row.depths.some((x) => x.ok) ? "sampled" : "observation-failed";
    return row;
  } catch (e) {
    const code = e?.code ?? "INTERNAL";
    row.verdict =
      code === "APP_NOT_INSTALLED"
        ? "app-not-installed"
        : code === "WINDOW_TIMEOUT"
          ? "window-not-found"
          : code === "PROCESS_EXITED" || code === "NEEDS_ELEVATION"
            ? "launch-blocked"
            : "error";
    row.error = { code, message: String(e?.message ?? e).slice(0, 240) };
    if (code === "PROCESS_EXITED") {
      row.error.harnessNote =
        "控制台子系统进程在当前执行环境拿不到控制台窗口（GUI 应用正常）。这是 harness 限制，不是应用不可自动化；控制台家族另用 Windows 终端（GUI 子系统）覆盖。";
    }
    if (code === "NEEDS_ELEVATION") {
      row.error.harnessNote = "需要在管理员会话中运行本脚本才能采样；非管理员时该应用对 agent 同样不可见。";
    }
    if (e?.visible) row.visibleWindows = e.visible;
    row.decision = "reject";
    row.reason = row.error.message;
    return row;
  } finally {
    row.close = await closeApp(target, proc, { owned: row.window?.owned ?? true }).catch(() => ({ graceful: false, forced: false }));
  }
}

function summarize(report) {
  const rows = report.apps;
  const sampled = rows.filter((r) => r.verdict === "sampled");
  const byDecision = {};
  const byFamily = {};
  const byQuality = {};
  for (const r of rows) {
    byDecision[r.decision ?? r.verdict] = (byDecision[r.decision ?? r.verdict] ?? 0) + 1;
    if (r.verdict === "sampled") {
      const deepest = r.depths.filter((d) => d.ok).at(-1);
      byQuality[deepest?.quality.verdict ?? "unknown"] = (byQuality[deepest?.quality.verdict ?? "unknown"] ?? 0) + 1;
      byFamily[r.family] = (byFamily[r.family] ?? 0) + 1;
    }
  }
  const usable = sampled.filter((r) => r.decision === "operate-a11y");
  const latencies = sampled.flatMap((r) => r.depths.filter((d) => d.ok).map((d) => d.elapsedMs));
  return {
    // 门槛就是 P2 要求：≥10 个真实应用真正采到树。未安装/超时的不算，但也不掩盖
    verdict: sampled.length >= 10 ? "coverage-10plus" : sampled.length > 0 ? "coverage-partial" : "no-data",
    requested: rows.length,
    sampled: sampled.length,
    a11yOperable: usable.length,
    needsVisualFallback: sampled.filter((r) => r.decision === "visual-fallback").length,
    domChannelRequired: sampled.filter((r) => r.decision === "dom-channel-required").length,
    depthBudgetExhausted: sampled.filter((r) => r.decision === "depth-budget-exhausted").length,
    rejected: sampled.filter((r) => r.decision === "reject").length,
    notInstalled: rows.filter((r) => r.verdict === "app-not-installed").map((r) => r.id),
    windowNotFound: rows.filter((r) => r.verdict === "window-not-found").map((r) => r.id),
    launchBlocked: rows.filter((r) => r.verdict === "launch-blocked").map((r) => r.id),
    errors: rows.filter((r) => r.verdict === "error").map((r) => `${r.id}:${r.error?.code}`),
    byDecision,
    byDeepestQuality: byQuality,
    byFamily,
    avgSnapshotMs: latencies.length ? round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    maxSnapshotMs: latencies.length ? Math.max(...latencies) : null,
    minDepthHistogram: usable.reduce((acc, r) => {
      const k = `d${r.minDepth}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    note: "只读采样，不做任何写入/点击；decision 是产品判定，不是原始数据",
  };
}

async function main() {
  const backend = createWindowsBackend({ bridgeEnabled: true });
  const registry = new AppRegistry(backend, {});
  const wantOffice = flag("--with-office");
  const catalog = CATALOG.filter((e) => (ONLY.length ? ONLY.includes(e.id) : true)).filter(
    (e) => (e.onlyWithOffice ? wantOffice : true)
  );

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    session: process.env.SESSIONNAME ?? "unknown",
    privacy: { windowTitlesPersisted: false, note: "只记标题长度；不截图；只拉起自建空白/临时文件实例" },
    depths: DEPTHS,
    mode: "active-launch",
    apps: [],
  };

  try {
    const caps = await backend.capabilities();
    report.capabilities = { a11yTree: caps.a11yTree, bridge: caps.bridge };
    if (!caps.a11yTree?.supported) {
      report.summary = { verdict: "skipped", reason: "UIA 桥不可用，无法采集覆盖率" };
      persist(report);
      console.log(JSON.stringify(report.summary, null, 2));
      return;
    }

    for (const entry of catalog) {
      if (!QUIET) console.error(`[cov] ${entry.id} (${entry.label}) ...`);
      const row = await runOne(backend, entry);
      report.apps.push(row);
      if (!QUIET) console.error(`[cov] ${entry.id} → ${row.decision ?? row.verdict}${row.reason ? ` · ${row.reason}` : ""}`);
      // 采样即测量：把质量回写注册表，让后续 channelMatrix 以实测为准
      if (row.verdict === "sampled" && row.window) {
        const deepest = row.depths.filter((d) => d.ok).at(-1);
        if (deepest) registry.noteTreeQuality(row.window, deepest.quality);
      }
    }

    report.summary = summarize(report);
    persist(report);
    console.log(JSON.stringify(report.summary, null, 2));
  } finally {
    await backend.shutdown?.().catch(() => backend.close());
  }
}

function persist(report) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`覆盖率矩阵：${OUT}`);
}

await main();
