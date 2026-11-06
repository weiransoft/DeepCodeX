#!/usr/bin/env node
/**
 * probe-app.mjs —— 单应用 UIA 结构探针（开发期工具，不进产品路径）
 *
 * 为什么需要它：给一个新应用写自动化用例前，必须先看清**它到底暴露了什么**。
 * 真机上最常见的失败不是「点不到」，而是「以为点到了」：
 *   · 记事本的正文是 Edit + ValuePattern（可直接 SetValue）
 *   · Word 的正文是 Document + TextPattern（没有 ValuePattern，只能键盘/剪贴板）
 *   · Excel 的网格既不是 Edit 也不是 Document —— 盲猜落点会把内容打进 Ribbon
 *
 * 用法：
 *   DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/probe-app.mjs \
 *     --exe "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE" \
 *     --file C:\tmp\x.csv --hint excel [--depth 8] [--shot] [--keep] [--wait 45]
 *
 * 输出：role 直方图 → 关键容器候选 → 树轮廓 → 可写性探测（哪类节点能读正文/能接收输入）
 * 隐私：只打印名字的**前 40 字符**；截图写到系统临时目录（不落项目、不落用户目录）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWindowsBackend } from "../src/backends/windows.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const EXE = arg("exe");
const FILE = arg("file");
const HINT = arg("hint", "");
const DEPTH = Number(arg("depth", "8"));
const WAIT_MS = Number(arg("wait", "30")) * 1000;
const SHOT = flag("shot");
const KEEP = flag("keep");
const TYPE = arg("type", null);
const SAVE = flag("save");
const SAVE_WATCH_MS = Number(arg("save-watch", "8")) * 1000;

if (!EXE) {
  console.error("必须给 --exe <可执行文件路径>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};
const cut = (s, n = 40) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…(${t.length})` : t;
};

async function main() {
  const work = mkdtempSync(join(tmpdir(), "dcx-probe-"));
  const backend = createWindowsBackend({});
  const cap = await backend.capabilities();
  console.log(`# capabilities  a11yTree=${cap.a11yTree?.supported}  bridge=${cap.bridge?.connected}  ${cap.bridge?.reason ?? ""}`);
  if (!cap.a11yTree?.supported) {
    console.error(`UIA 不可用，无法探测：${cap.a11yTree?.reason ?? "unknown"}`);
    process.exit(3);
  }

  const args = [];
  if (FILE) args.push(FILE);
  console.log(`# launch  ${EXE} ${args.join(" ")}`);
  const child = spawn(EXE, args, { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;

  // 等窗口：先用进程名锁家族，再等 UIA 枚举出**能真的快照到**的窗口。
  // 真机坑：Office 先起一个「正在打开 - Excel」闪屏，它的 hwnd 会在几百毫秒后失效，
  // 拿着它去 snapshot 只会拿到 OBSERVATION_FAILED。所以判定标准是「snapshot 成功」，
  // 不是「窗口存在」。
  const SPLASH = /正在打开|正在加载|启动中|Opening|Loading|Starting/i;
  const t0 = Date.now();
  let win = null;
  let snap = null;
  let lastErr = null;
  while (Date.now() - t0 < WAIT_MS) {
    const apps = await backend.listApps().catch(() => []);
    const fam = (HINT ? apps.filter((a) => a.appId === HINT) : apps.filter((a) => a.pid === pid)).filter((a) => a.hwnd);
    // 闪屏排在后面：优先快照「看起来是正式窗口」的那个
    fam.sort((a, b) => Number(SPLASH.test(a.title ?? "")) - Number(SPLASH.test(b.title ?? "")));
    for (const cand of fam) {
      // 闪屏本身也能快照（1 个 Window 节点），所以「能快照」还不够，标题和节点数都要看
      if (SPLASH.test(cand.title ?? "")) continue;
      const s = await backend
        .snapshot({ appId: cand.appId, pid: cand.pid, hwnd: cand.hwnd, maxDepth: DEPTH })
        .catch((e) => {
          lastErr = e;
          return null;
        });
      if (s && flatten(s.tree).length >= 3) {
        win = cand;
        snap = s;
        break;
      }
    }
    if (snap) break;
    await sleep(500);
  }
  if (!win || !snap) {
    console.error(`# 超时：${WAIT_MS} ms 内没等到可快照的窗口（最后错误：${lastErr?.code ?? "-"}）`);
    await backend.shutdown?.().catch(() => {});
    process.exit(4);
  }
  console.log(`# window  appId=${win.appId} pid=${win.pid} hwnd=${win.hwnd} title=${cut(win.title)}  (+${Date.now() - t0} ms)`);

  // 同 pid 的其它顶层窗口 = 模态/引导/受保护视图，这些会吃掉输入
  const all = await backend.listApps().catch(() => []);
  const extras = all.filter((a) => a.pid === win.pid && a.hwnd !== win.hwnd);
  console.log(`# 同进程其它顶层窗口 ${extras.length} 个`);
  for (const e of extras) console.log(`    · hwnd=${e.hwnd} ${cut(e.title, 60)}`);

  const target = { appId: win.appId, pid: win.pid, hwnd: win.hwnd };
  const nodes = flatten(snap.tree);
  console.log(`# 树  nodes=${nodes.length}  snapshotId=${snap.snapshotId}  truncated=${Boolean(snap.truncated)}`);

  const hist = new Map();
  for (const n of nodes) hist.set(n.role, (hist.get(n.role) ?? 0) + 1);
  console.log("# role 直方图（按数量）");
  for (const [role, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${role}`);
  }

  // 可写性候选：有面积 + 是容器/编辑类角色
  const CAND = ["Edit", "Document", "TextArea", "DataGrid", "Table", "Grid", "Pane", "ListItem", "Custom"];
  console.log("# 候选落点（有面积，按优先级）");
  const candidates = nodes
    .filter((n) => (n.rect?.width ?? 0) > 4 && (n.rect?.height ?? 0) > 4 && CAND.includes(n.role))
    .sort((a, b) => CAND.indexOf(a.role) - CAND.indexOf(b.role) || (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))
    .slice(0, 12);
  for (const n of candidates) {
    console.log(
      `    ${n.role.padEnd(10)} depth=${String(n.depth).padStart(2)} ${String(n.rect.width).padStart(4)}x${String(n.rect.height).padEnd(4)} ` +
        `value=${n.value === undefined ? "-" : "yes"} name=${cut(n.name, 28)}`,
    );
  }

  // 树轮廓：只打容器层，控件层按 role 折叠
  console.log("# 树轮廓（前 5 层，控件层折叠）");
  const outline = (list, depth) => {
    for (const n of list ?? []) {
      if ((n.depth ?? depth) > 5) continue;
      const kids = n.children?.length ?? 0;
      const collapsed = kids > 3 && (n.depth ?? depth) >= 3;
      console.log(
        `${"  ".repeat(depth)}- ${n.role}${kids ? `[${kids}]` : ""} ${cut(n.name, 30)}` +
          `${collapsed ? "  …" : ""}`,
      );
      if (!collapsed) outline(n.children, depth + 1);
    }
  };
  outline(snap.tree, 0);

  // 读正文探测：哪条通道真的能读到内容
  const rt = await backend.readText({ ...target, maxLength: 4000 }).catch((e) => ({ ok: false, code: e?.code, message: e?.message }));
  console.log(`# readText  ok=${rt?.ok} via=${rt?.via ?? "-"} length=${String(rt?.text ?? "").length}`);
  if (rt?.ok && rt.text) console.log(`    前 80 字符：${JSON.stringify(String(rt.text).slice(0, 80))}`);

  // 状态探测：Edit/ValuePattern 命中情况
  const st = await backend.observeState().catch(() => null);
  console.log(`# observeState  editValues=${st?.editValues?.length ?? 0} texts=${st?.texts?.length ?? 0} focused=${st?.focused ? cut(st.focused, 40) : "-"}`);

  if (SHOT) {
    const shot = await backend.screenshot({ ...target, reason: "probe" }).catch(() => null);
    if (shot?.base64) {
      const p = join(work, `${HINT || "app"}-probe.png`);
      writeFileSync(p, Buffer.from(shot.base64, "base64"));
      console.log(`# 截图  ${p}  (${shot.width}x${shot.height}, ${Math.round(shot.bytes / 1024)} KB)`);
    }
  }

  // ── 写入探测：点击最大可编辑面 → 粘贴 → 可选保存 ──
  if (TYPE) {
    const AREA = (n) => (n.rect?.width ?? 0) * (n.rect?.height ?? 0);
    const EDITABLE = new Set(["Edit", "Document", "TextArea", "DataGrid", "Table", "Grid", "List"]);
    const CHROME = /编辑栏|公式栏|地址栏|搜索框|功能区|Ribbon|Formula|Search/i;
    const spot =
      nodes
        .filter((n) => EDITABLE.has(n.role) && !CHROME.test(String(n.name ?? "")) && AREA(n) > 16)
        .sort((a, b) => AREA(b) - AREA(a))[0] ?? null;
    if (!spot) {
      console.log("# 写入探测：没有可编辑落点，跳过");
    } else {
      console.log(`# 写入落点 ${spot.role} ${spot.rect.width}x${spot.rect.height} name=${cut(spot.name, 20)}`);
      await backend.invokeRef({ snapshotId: snap.snapshotId, ref: spot.ref, action: "click" }).catch(() => null);
      await sleep(300);
      const t = await backend.typeText({ ...target, text: TYPE, paste: true }).catch((e) => ({ ok: false, message: String(e) }));
      console.log(`# 粘贴  ok=${t?.ok} via=${t?.via ?? "-"} ${t?.message ?? ""}`);
      await sleep(500);
      if (SHOT) {
        const s2 = await backend.screenshot({ ...target, reason: "after-type" }).catch(() => null);
        if (s2?.base64) {
          const p = join(work, `${HINT || "app"}-after-type.png`);
          writeFileSync(p, Buffer.from(s2.base64, "base64"));
          console.log(`# 截图  ${p}（写入后）`);
        }
      }
      if (SAVE) {
        console.log(`# 保存探测：^s 后观察 ${SAVE_WATCH_MS} ms`);
        const k = await backend.sendKey({ ...target, combo: "^s" }).catch((e) => ({ ok: false, message: String(e) }));
        console.log(`# ^s  ok=${k?.ok} ${k?.message ?? ""}`);
        const t0s = Date.now();
        let round = 0;
        while (Date.now() - t0s < SAVE_WATCH_MS) {
          round += 1;
          const onDisk = FILE && existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
          const apps = await backend.listApps().catch(() => []);
          const same = apps.filter((a) => a.pid === win.pid);
          console.log(
            `  [t+${Date.now() - t0s}ms] disk=${onDisk.length}B marker=${onDisk.includes(TYPE) ? "YES" : "no"} ` +
              `本进程顶层窗口=${same.length}`,
          );
          for (const w of same) {
            if (w.hwnd === win.hwnd) continue;
            const s = await backend.snapshot({ appId: w.appId, pid: w.pid, hwnd: w.hwnd, maxDepth: 3 }).catch(() => null);
            const names = s
              ? flatten(s.tree)
                  .filter((n) => String(n.name ?? "").trim())
                  .slice(0, 8)
                  .map((n) => `${n.role}:${String(n.name).slice(0, 10)}`)
                  .join(" | ")
              : "snapshot FAILED";
            console.log(`      · hwnd=${w.hwnd} title=${cut(w.title, 24)}  ${names}`);
          }
          // 关键：Word/Excel 的保存确认框常常是**主窗口子树里的嵌套 Window**，
          // 不在顶层窗口列表里。把它连同后代的名字一起打出来，才能判断按钮是否可达。
          const deep = await backend.snapshot({ ...target, maxDepth: 8 }).catch(() => null);
          if (deep) {
            const nested = flatten(deep.tree).filter((n) => n.role === "Window" && (n.depth ?? 0) > 0);
            for (const nw of nested) {
              const sub = flatten(nw.children ?? []).filter((n) => String(n.name ?? "").trim());
              console.log(
                `      ~ 嵌套模态 depth=${nw.depth} ${cut(nw.name, 26)} 子孙命名节点=${sub.length}` +
                  (sub.length ? `  ${sub.slice(0, 8).map((n) => `${n.role}:${String(n.name).slice(0, 10)}`).join(" | ")}` : ""),
              );
            }
            if (!nested.length) console.log("      ~ 主窗口子树里没有嵌套模态");
          }
          if (onDisk.includes(TYPE)) {
            console.log("# 落盘成功");
            break;
          }
          await sleep(1000);
        }
      }
    }
  }

  if (!KEEP) {
    // 收尾：先温和关窗，残留再按 pid 兜底
    await backend.sendKey({ ...target, combo: "%{F4}" }).catch(() => {});
    await sleep(800);
    await backend.sendKey({ ...target, combo: "n" }).catch(() => {});
    await sleep(500);
  }
  await backend.shutdown?.().catch(() => {});
  console.log(`# 工作目录 ${work}`);
}

main().catch(async (e) => {
  console.error(`探针失败：${e?.stack ?? e}`);
  process.exit(1);
});
