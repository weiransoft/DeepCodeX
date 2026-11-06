/**
 * 真实应用写入闭环验证（P2 准入项 1）。
 *
 * 与 verify-gui 的区别：verify-gui 用受控 WPF 窗口证明「通道能用」，
 * 这里用**真实第三方应用**（记事本）证明「能把改动落到真实文件」。
 *
 * 安全约束（这是操作真实应用的脚本，全部为硬约束）：
 * 1. 只打开本脚本自己在临时目录创建的文件，不碰用户任何文档；
 * 2. 动作前双重校验：窗口标题含本次随机文件名 **且** 编辑框初始内容等于基线；
 * 3. 任一校验不通过立即放弃，绝不发送输入（宁可少测，不能误改）；
 * 4. 结束后关闭窗口并删除临时目录，磁盘上只留报告。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { DesktopAgent } from "../src/agent.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p2-real-app.json");

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BASE_NAME = `dcx-e2e-${STAMP}.txt`;
const BASELINE = `DCX-BASELINE-${STAMP}\n`;
const TYPED = `DCX-TYPED-${STAMP}\nsecond line ${STAMP}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, label, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: { code: err?.code ?? "ERROR", message: err?.message ?? String(err), ...(err?.details ?? {}) }, label, elapsedMs: Date.now() - t0 };
  }
}

function flatten(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

function summarize(purpose, step) {
  return {
    purpose,
    ok: step.ok,
    elapsedMs: step.elapsedMs,
    via: step.ok ? step.value?.action?.via ?? step.value?.via ?? null : null,
    outcome: step.ok ? step.value?.outcome ?? null : step.error?.code ?? "ERROR",
    attempts: step.ok ? step.value?.attempts ?? null : null,
    changed: step.ok ? step.value?.verification?.changed ?? null : null,
    error: step.ok ? null : step.error,
  };
}

/** 找到标题含指定文件名的窗口；找不到就等，绝不猜别的窗口 */
async function waitForWindow(backend, needle, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const apps = await backend.listApps();
    const hit = apps.find((a) => String(a.title ?? "").includes(needle));
    if (hit) return { app: hit, count: apps.length, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待窗口「${needle}」超时（${timeoutMs} ms），当前窗口数：${apps.length}`);
    }
    await sleep(300);
  }
}

function persist(report, outPath) {
  try {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    /* 报告写不进不影响结论 */
  }
}

async function main() {
  const outPath = process.argv[2] ?? DEFAULT_OUT;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    session: process.env.SESSIONNAME ?? "unknown",
    verdict: "skipped",
    target: { app: "notepad", fileName: BASE_NAME },
    privacy: { note: "只操作自建临时文件 dcx-e2e-*.txt，不读取、不修改任何用户文档" },
    guards: {},
    steps: [],
    errors: [],
  };

  if (process.platform !== "win32" || process.env.DEEPCODE_AGENT_UIA_BRIDGE !== "1") {
    report.reason = "需要 win32 + DEEPCODE_AGENT_UIA_BRIDGE=1（交互式桌面会话）";
    persist(report, outPath);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "dcx-e2e-"));
  const filePath = join(dir, BASE_NAME);
  writeFileSync(filePath, BASELINE, "utf8");

  let proc = null;
  let backend = null;
  try {
    proc = spawn("notepad.exe", [filePath], { stdio: "ignore", windowsHide: false });
    backend = createWindowsBackend({ bridgeEnabled: true });

    const caps = await timed("capabilities", () => backend.capabilities());
    report.capabilities = caps.value ?? caps.error;
    if (!caps.ok || !caps.value?.a11yTree?.supported) {
      throw new Error(`UIA 桥自检未通过：${JSON.stringify(caps.error ?? caps.value?.a11yTree)}`);
    }

    const found = await timed("waitForWindow", () => waitForWindow(backend, BASE_NAME));
    if (!found.ok) throw new Error(found.error.message);
    const app = found.value.app;
    report.window = {
      appId: app.appId,
      pid: app.pid,
      hwnd: app.hwnd,
      titleLength: String(app.title ?? "").length,
      matchedBy: "title-contains-fileName",
      enumSource: app.enumSource,
      waitedMs: found.value.elapsedMs,
      totalWindows: found.value.count,
    };

    // 受控策略：只授权本窗口读写；坐标/视觉保持默认关闭（本用例不需要）
    const policy = {
      ...defaultPolicy(),
      enabled: true,
      permissionMode: "auto",
      allowedApps: [{ appId: app.appId, always: true, scopes: ["read", "write"] }],
      deniedApps: [],
    };
    const agent = new DesktopAgent({ backend, policy, limits: policy });
    const target = { appId: app.appId, pid: app.pid, hwnd: app.hwnd };

    // ── 守卫 1：编辑框初始内容必须等于基线，证明这是「我们创建的那个文件」 ──
    const snap1 = await timed("desktop_snapshot", () => agent.callTool("desktop_snapshot", { ...target, maxDepth: 4 }));
    if (!snap1.ok || snap1.value?.ok === false) throw new Error(`首次快照失败：${JSON.stringify(snap1.error ?? snap1.value)}`);
    report.snapshot = {
      snapshotId: snap1.value.snapshotId,
      nodeCount: snap1.value.nodeCount,
      treeQuality: snap1.value.treeQuality,
      roles: [...new Set(flatten(snap1.value.tree).map((n) => n.role))].slice(0, 12),
    };

    const state0 = await timed("observeState/before", () => backend.observeState());
    const before = state0.ok ? state0.value : { editValues: [] };
    const initialText = (before.editValues ?? []).join("\n");
    report.guards.baselineMatched = initialText.trim() === BASELINE.trim();
    report.guards.baselineSeenLength = initialText.length;
    if (!report.guards.baselineMatched) {
      throw new Error(
        `守卫拦截：编辑框初始内容与基线不一致（见到 ${initialText.length} 字符），可能是别的文档，拒绝写入`
      );
    }

    const edit = flatten(snap1.value.tree).find((n) => ["Edit", "Document"].includes(n.role));
    if (!edit) throw new Error("快照中找不到 Edit/Document 节点，无法定位输入目标");
    report.targetNode = { ref: edit.ref, role: edit.role, nameLength: String(edit.name ?? "").length };

    // ── ① 写入（ValuePattern）→ Observe→Act→Verify ──
    agent.budget.reset();
    const typeStep = await timed("desktop_type", () =>
      agent.callTool("desktop_type", { ...target, snapshotId: snap1.value.snapshotId, ref: edit.ref, value: `${BASELINE}${TYPED}` })
    );
    report.steps.push(summarize("ValuePattern 写入真实应用", typeStep));

    const state1 = await timed("observeState/after-type", () => backend.observeState());
    report.stateAfterType = state1.ok
      ? { typedSeen: (state1.value.editValues ?? []).join("\n").includes(`DCX-TYPED-${STAMP}`) }
      : state1.error;

    // ── ② Ctrl+S 落盘 ──
    // 保存是幂等动作：文件已存在且未脏时界面不会变，所以 expectChange:false，
    // 成效由下面「读磁盘」这一步自证——这比看界面可靠得多。
    agent.budget.reset();
    const saveStep = await timed("desktop_key/^s", () =>
      agent.callTool("desktop_key", {
        ...target,
        snapshotId: agent.perception.currentSnapshotId(),
        combo: "^s",
        expectChange: false,
      })
    );
    report.steps.push(summarize("快捷键保存", saveStep));

    // ── ③ 磁盘校验：文件里真的出现了写入内容（唯一可信的成功证据） ──
    let onDisk = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      onDisk = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
      if (onDisk.includes(`DCX-TYPED-${STAMP}`)) break;
      await sleep(200);
    }
    report.disk = {
      persisted: onDisk.includes(`DCX-TYPED-${STAMP}`),
      baselinePreserved: onDisk.includes(`DCX-BASELINE-${STAMP}`),
      length: onDisk.length,
      waitedMs: Date.now() - t0,
    };

    // ── ④ 关闭窗口（同时验证键盘通道在真实应用上的可用性） ──
    agent.budget.reset();
    const closeStep = await timed("desktop_key/Alt-F4", () =>
      agent.callTool("desktop_key", { ...target, snapshotId: agent.perception.currentSnapshotId(), combo: "%{F4}" })
    );
    report.steps.push(summarize("关闭窗口", closeStep));

    // verified-no-change 也算通过：动作成功但界面本就不该变（保存/复制）
    const passed = report.steps.filter((s) => s.outcome === "verified" || s.outcome === "verified-no-change").length;
    report.verifiedSteps = passed;
    report.totalSteps = report.steps.length;
    report.verdict =
      report.disk.persisted && report.disk.baselinePreserved && passed === report.steps.length
        ? "real-app-write-verified"
        : report.disk.persisted
          ? "write-persisted-with-step-failures"
          : "write-not-persisted";
  } catch (err) {
    report.errors.push({ code: err?.code ?? "ERROR", message: err?.message ?? String(err) });
    report.verdict = report.verdict === "skipped" ? "blocked" : report.verdict;
  } finally {
    try {
      backend?.close();
    } catch {
      /* 桥已自行退出 */
    }
    // 关闭未自动退出的记事本：只针对本次启动的进程
    try {
      if (proc && !proc.killed) proc.kill();
    } catch {
      /* 已退出 */
    }
    await sleep(300);
    try {
      rmSync(dir, { recursive: true, force: true });
      report.cleanup = { tempDirRemoved: true, fileKept: false };
    } catch {
      report.cleanup = { tempDirRemoved: false };
    }
    persist(report, outPath);
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
