#!/usr/bin/env node
/**
 * 真机 GUI 闭环验证（P1+）：启动一个**受控** WinForms 测试窗口，经 DesktopAgent
 * 的 MCP 工具语义跑 Observe→Act→Verify，覆盖
 *   a11y 树 / ValuePattern 输入 / InvokePattern 点击 / 坐标点击 / 快捷键 /
 *   截图 / 状态复观察，结束后关闭窗口并清理临时文件。
 *
 * 运行：
 *   DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/verify-gui.mjs [输出 JSON 路径]
 *   npm run verify:gui                        （同样需要上面的环境变量）
 *
 * 非 Windows 或未开启桥时输出 skipped 并以退出码 0 结束（CI 友好）。
 * 桌面上会短暂出现标题为 DCX-GUI-TEST-* 的小窗口，脚本结束即关闭；
 * 不触碰用户已有窗口、不写用户文件、不保存任何 GUI 内容。
 *
 * 注意：生产默认策略关闭视觉与坐标通道；本脚本在**显式构造**的测试策略中
 * 打开它们以验证链路，不代表放宽外部策略文件（外部策略仍由 policy-load 硬化）。
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { DesktopAgent } from "../src/agent.mjs";
import { createWindowsBackend } from "../src/backends/windows.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p1-gui-verify.json");
const TITLE = `DCX-GUI-TEST-${Date.now().toString(36)}`;

/**
 * 受控测试窗体：WPF TextBox(ValuePattern) + Button(InvokePattern) + TextBlock。
 * 用 XamlReader 动态加载而非 C# 编译——WinForms 控件经 MSAA 桥会降级成 Pane，
 * 拿不到 Value/Invoke 模式；WPF 的 UIA 提供者是原生的，能覆盖完整动作通道。
 */
const TEST_WINDOW_PS1 = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="$env:DCX_TEST_TITLE" Width="460" Height="220"
        WindowStartupLocation="CenterScreen">
  <StackPanel Margin="20">
    <TextBox x:Name="InputBox" Text="before" Width="380" Height="30" />
    <Button x:Name="GoButton" Content="Apply" Width="140" Height="30" Margin="0,12,0,0" HorizontalAlignment="Left" />
    <TextBlock x:Name="StatusLabel" Text="idle" Margin="0,12,0,0" />
  </StackPanel>
</Window>
"@
$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$tb = $window.FindName('InputBox')
$btn = $window.FindName('GoButton')
$lbl = $window.FindName('StatusLabel')
$script:clicks = 0
$btn.add_Click({ $script:clicks++; $lbl.Text = 'applied:' + $tb.Text + ':' + $script:clicks })
$window.ShowDialog() | Out-Null
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { label, ok: true, elapsedMs: Number((performance.now() - t0).toFixed(2)), value };
  } catch (err) {
    return {
      label,
      ok: false,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      error: { code: err?.code ?? "INTERNAL", message: String(err?.message ?? err).slice(0, 300) },
    };
  }
}

async function waitForWindow(backend, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const apps = await backend.listApps();
    const hit = apps.find((a) => String(a.title ?? "").includes(TITLE));
    if (hit) return { app: hit, elapsedMs: Date.now() - start, count: apps.length };
    if (Date.now() - start > timeoutMs) throw new Error(`测试窗口 ${TITLE} 未在 ${timeoutMs}ms 内出现`);
    await sleep(400);
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
    testWindowTitle: TITLE,
    privacy: { note: "只在受控测试窗口内操作，不采集用户窗口标题，不写用户文件" },
    steps: [],
    errors: [],
  };

  if (process.platform !== "win32" || process.env.DEEPCODE_AGENT_UIA_BRIDGE !== "1") {
    report.reason = "需要 win32 + DEEPCODE_AGENT_UIA_BRIDGE=1（交互式桌面会话）";
    persist(report, outPath);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const tmpPs1 = join(tmpdir(), `dcx-gui-test-${Date.now()}.ps1`);
  // PowerShell 5.1 需要 BOM 才按 UTF-8 读取；内容全 ASCII，BOM 仍加上以绝后患
  writeFileSync(tmpPs1, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEST_WINDOW_PS1, "utf8")]));

  let testProc = null;
  let backend = null;
  let testProcLog = "";
  try {
    testProc = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", tmpPs1], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      env: { ...process.env, DCX_TEST_TITLE: TITLE },
    });
    testProc.stdout?.on("data", (c) => { testProcLog += String(c); });
    testProc.stderr?.on("data", (c) => { testProcLog += String(c); });
    testProc.on("error", (e) => { testProcLog += `spawn error: ${e.message}\n`; });

    backend = createWindowsBackend({ bridgeEnabled: true });
    const caps = await timed("capabilities", () => backend.capabilities());
    report.capabilities = caps.value ?? caps.error;
    if (!caps.ok || !caps.value?.a11yTree?.supported) {
      throw new Error(`UIA 桥自检未通过：${JSON.stringify(caps.error ?? caps.value?.a11yTree)}`);
    }

    const found = await timed("waitForWindow", () => waitForWindow(backend));
    if (!found.ok) {
      throw new Error(`${found.error.message}\n--- test window process log ---\n${testProcLog.slice(-1200) || "(empty)"}`);
    }
    const app = found.value.app;
    report.testWindow = { appId: app.appId, pid: app.pid, enumSource: app.enumSource, waitedMs: found.value.elapsedMs };
    report.enumeration = { count: found.value.count, elapsedMs: found.elapsedMs, source: app.enumSource };

    // 受控测试策略：显式开启视觉/坐标通道；生产默认仍是关闭的
    const policy = {
      ...defaultPolicy(),
      enabled: true,
      permissionMode: "auto",
      allowedApps: [{ appId: app.appId, always: true, scopes: ["read", "write"] }],
      deniedApps: [],
      allowCoordinateInput: true,
      allowScreenshot: true,
    };
    const agent = new DesktopAgent({ backend, policy, limits: policy });
    const target = { appId: app.appId, pid: app.pid };

    // 后端直连快照作为基线：确认按 pid 能定位到测试窗体（排除同 appId 多窗口歧义）
    const direct = await timed("backend.snapshot/by-pid", () => backend.snapshot({ ...target, maxDepth: 5 }));
    report.directSnapshot = direct.ok
      ? {
          windowName: direct.value.windowName,
          nodeCount: direct.value.nodeCount,
          roles: [...new Set(flatten(direct.value.tree).map((n) => n.role))],
          treeSample: JSON.stringify(direct.value.fullTree).slice(0, 2000),
        }
      : direct.error;

    const snap = await timed("desktop_snapshot", () => agent.callTool("desktop_snapshot", { ...target, maxDepth: 4 }));
    if (!snap.ok || snap.value?.ok === false) throw new Error(`snapshot 失败：${JSON.stringify(snap.error ?? snap.value)}`);
    const s = snap.value;
    const nodes = flatten(s.tree);
    const edit = nodes.find((n) => n.role === "Edit") ?? nodes.find((n) => ["before", "dcx-after"].includes(String(n.name)));
    const button = nodes.find((n) => n.role === "Button") ?? nodes.find((n) => String(n.name) === "Apply");
    report.snapshot = {
      snapshotId: s.snapshotId,
      source: s.source,
      nodeCount: s.nodeCount,
      visibleNodes: nodes.length,
      elapsedMs: snap.elapsedMs,
      roles: [...new Set(nodes.map((n) => n.role))],
      editRef: edit?.ref ?? null,
      buttonRef: button?.ref ?? null,
      buttonRect: button?.rect ?? null,
    };
    if (!edit || !button) throw new Error(`测试窗体 UIA 树缺少 Edit/Button 控件：${JSON.stringify(report.snapshot.roles)}`);

    /**
     * Verifier 每个动作成功后都会复观察并换掉当前快照（界面已变，旧 ref 不得复用），
     * 所以连续动作必须重新 Observe 并重新确认目标——这正是 STALE_REF 契约的正确用法。
     */
    const fresh = async () => {
      const r = await agent.callTool("desktop_snapshot", { ...target, maxDepth: 4 });
      if (r?.ok === false) throw new Error(`fresh snapshot 失败：${JSON.stringify(r)}`);
      return { snapshotId: r.snapshotId, nodes: flatten(r.tree) };
    };
    const pick = (nodes, kind) =>
      kind === "edit"
        ? nodes.find((n) => n.role === "Edit") ?? nodes.find((n) => ["before", "dcx-after"].includes(String(n.name)))
        : nodes.find((n) => n.role === "Button") ?? nodes.find((n) => String(n.name) === "Apply");

    // ① ValuePattern 输入（不抢焦点）→ Observe→Act→Verify
    // 每一步都是一次独立「任务」：重置预算，避免某步失败耗尽 retries 后
    // 让后续步骤被 BUDGET_EXCEEDED 连带判负，掩盖各自的真实结论。
    agent.budget.reset();
    let f = await fresh();
    const editRef = pick(f.nodes, "edit")?.ref;
    const typeStep = await timed("desktop_click_ref/value-pattern", () =>
      agent.callTool("desktop_click_ref", {
        ...target,
        snapshotId: f.snapshotId,
        ref: editRef,
        action: "invoke",
        value: "dcx-after",
      })
    );
    report.steps.push(summarize("ValuePattern 输入", typeStep));

    const afterType = await timed("observeState/after-type", () => backend.observeState());
    report.stateAfterType = afterType.ok
      ? { editValues: afterType.value.editValues, texts: afterType.value.texts?.slice(0, 8) }
      : afterType.error;

    // ② InvokePattern 点击（不抢焦点），TextBlock 文本应随点击次数变化
    agent.budget.reset();
    f = await fresh();
    const buttonRef = pick(f.nodes, "button")?.ref;
    const clickStep = await timed("desktop_click_ref/invoke-pattern", () =>
      agent.callTool("desktop_click_ref", {
        ...target,
        snapshotId: f.snapshotId,
        ref: buttonRef,
        action: "click_ref",
      })
    );
    report.steps.push(summarize("InvokePattern 点击", clickStep));

    // ③ 截图（视觉兜底通道，仅元数据，不落盘）
    const shotStep = await timed("desktop_screenshot", () =>
      agent.callTool("desktop_screenshot", { ...target, reason: "gui-verify" })
    );
    report.screenshot = shotStep.ok
      ? { ok: shotStep.value?.ok, width: shotStep.value?.width, height: shotStep.value?.height, persisted: shotStep.value?.persisted }
      : shotStep.error;

    // ④ 坐标点击兜底（吸附到按钮 rect 中心 + 前台校验）
    agent.budget.reset();
    f = await fresh();
    const freshButton = pick(f.nodes, "button");
    const cx = Math.round((freshButton?.rect?.x ?? 0) + (freshButton?.rect?.width ?? 0) / 2);
    const cy = Math.round((freshButton?.rect?.y ?? 0) + (freshButton?.rect?.height ?? 0) / 2);
    const xyStep = await timed("desktop_click_xy", () =>
      agent.callTool("desktop_click_xy", { ...target, snapshotId: f.snapshotId, x: cx, y: cy })
    );
    report.steps.push(summarize("坐标点击兜底", xyStep));

    const afterClick = await timed("observeState/after-click", () => backend.observeState());
    report.stateAfterClick = afterClick.ok
      ? { texts: afterClick.value.texts?.slice(0, 8), editValues: afterClick.value.editValues }
      : afterClick.error;

    // ⑤ 快捷键 Alt+F4：同时验证键盘通道并关闭测试窗口
    agent.budget.reset();
    f = await fresh();
    const keyStep = await timed("desktop_key/Alt-F4", () =>
      agent.callTool("desktop_key", { ...target, snapshotId: f.snapshotId, combo: "%{F4}" })
    );
    report.steps.push(summarize("快捷键/关闭窗口", keyStep));

    const verified = report.steps.filter((s2) => s2.outcome === "verified").length;
    const allOk = report.steps.every((s2) => s2.ok === true && s2.outcome === "verified");
    report.verdict = allOk ? "gui-unblocked" : "partial";
    report.verifiedSteps = verified;
    report.totalSteps = report.steps.length;
    if (!allOk) {
      report.errors.push(...report.steps.filter((s2) => s2.outcome !== "verified").map((s2) => `${s2.purpose}: ${JSON.stringify(s2.result)}`));
    }
  } catch (err) {
    report.verdict = "failed";
    report.errors.push(String(err?.stack ?? err?.message ?? err).slice(0, 800));
  } finally {
    if (backend) {
      try {
        backend.close();
      } catch (e) {
        report.errors.push(`bridge close: ${e.message}`);
      }
    }
    if (testProc && testProc.exitCode === null) {
      try {
        testProc.kill();
      } catch (e) {
        report.errors.push(`test window kill: ${e.message}`);
      }
    }
    try {
      unlinkSync(tmpPs1);
    } catch {
      /* best effort */
    }
    report.cleanup = { bridgeClosed: true, testWindowProcKilled: Boolean(testProc), tempScriptRemoved: true };
    persist(report, outPath);
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict === "failed") process.exitCode = 1;
  }
}

function summarize(purpose, step) {
  const v = step.value ?? {};
  return {
    purpose,
    ok: step.ok === true && v.ok !== false,
    outcome: v.outcome ?? (v.ok === false ? v.code : step.ok ? "ok" : "error"),
    via: v.action?.via ?? v.via ?? null,
    elapsedMs: step.elapsedMs,
    result: step.ok
      ? {
          ok: v.ok,
          code: v.code ?? null,
          outcome: v.outcome ?? null,
          attempts: v.attempts ?? null,
          message: v.message ?? null,
          action: v.action ?? null,
          verification: v.verification ?? null,
        }
      : step.error,
  };
}

function persist(report, outPath) {
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (e) {
    console.error(`[verify-gui] 报告写入失败：${e.message}`);
  }
}

await main();
