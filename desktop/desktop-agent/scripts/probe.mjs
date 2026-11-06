#!/usr/bin/env node
/**
 * P0 探针：在真实 Windows 会话里采集「应用感知」可用性与耗时基线。
 *
 * 用途（方案 §7 P0）：回答「这条路线值不值得继续做」——需要真实数据，
 * 而不是靠 PPT 推断。采集三件事：
 *   1. 平台能力矩阵（桥开启时做真实 UIA 自检，哪些通道真的可用、缺什么）；
 *   2. 真实窗口枚举的分类/通道分布与耗时（桥开启走 UIA，约 0.1s）；
 *   3. 真机 GUI 只读观察（语义树 / 截图元数据 / 状态读取，不执行写动作）；
 *   4. mock 后端的 Observe-Act-Verify 单步耗时（逻辑基线，不代表真机 GUI）。
 *
 * 隐私：窗口标题**不落盘**（只记录是否存在与长度），截图只在内存里、
 * 报告只写宽高与字节数。标题常含文件名、账号、会话主题，属于 R2 敏感画面。
 *
 * 运行：node desktop/desktop-agent/scripts/probe.mjs [输出 JSON 路径]
 *   真机全能力：DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe
 * 退出码恒为 0；结论写在输出 JSON 的 decision 字段。
 */
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { DesktopAgent } from "../src/agent.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p0-probe.json");

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
      error: { code: err?.code ?? "INTERNAL", message: String(err?.message ?? err).slice(0, 200) },
    };
  }
}

function countBy(items, key) {
  const out = {};
  for (const it of items) {
    const k = String(it[key] ?? "unknown");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function flattenForProbe(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flattenForProbe(n.children, out);
  }
  return out;
}

/** 脱敏后的应用条目：不含窗口标题 */
function redactApp(a) {
  return {
    appId: a.appId,
    processName: a.processName,
    pid: a.pid,
    category: a.category,
    channel: a.channel,
    hasTitle: Boolean(a.title),
    titleLength: typeof a.title === "string" ? a.title.length : 0,
  };
}

async function main() {
  const outPath = process.argv[2] ?? DEFAULT_OUT;
  const generatedAt = new Date().toISOString();

  // ── 1) 真实平台能力矩阵（桥开启时做真实 UIA 自检，而非只查文件存在） ──
  const bridgeEnabled = process.env.DEEPCODE_AGENT_UIA_BRIDGE === "1";
  const backend = createWindowsBackend({ bridgeEnabled });
  const agent = new DesktopAgent({ backend, policy: defaultPolicy() });
  const capabilities = await timed("capabilities", () => backend.capabilities());
  const caps = capabilities.value ?? {};
  const a11yOk = Boolean(caps.a11yTree?.supported);
  const visualOk = Boolean(caps.screenshot?.supported);

  // ── 2) 真实窗口枚举 + 通道决策（基于同一次快照，避免两次枚举间窗口变化） ──
  const enumeration = await timed(
    `registry.list(cold: ${bridgeEnabled ? "UIA listWindows" : "tasklist /v /fo csv /nh"})`,
    () => agent.registry.list({ refresh: true })
  );
  // 缓存治理验证：冷枚举约 15s，命中与工具调用必须接近 0ms（否则每个
  // 工具调用都会全量枚举一次，真实会话直接不可用）。
  const cacheHit = await timed("registry.list(warm: TTL 命中)", () => agent.registry.list());
  const toolList = await timed("desktop_list_apps(默认走缓存)", () =>
    agent.callTool("desktop_list_apps", {})
  );
  const apps = enumeration.ok ? enumeration.value : [];
  const matrix = await timed("channelMatrix(同一次快照)", () =>
    Promise.resolve(agent.registry.channelMatrix(apps))
  );
  const classified = matrix.ok ? matrix.value : [];

  // ── 3) 真机 GUI 只读观察（桥可用时）：语义树 / 截图元数据 / 状态读取 ──
  // 只做观察，不执行任何写动作；窗口标题与画面内容都不落盘。
  let realGui = { enabled: false, note: "UIA 桥不可用，未采集真机 GUI 观察数据" };
  if (a11yOk && apps.length > 0) {
    const target = apps.find((a) => a.category !== "finance-or-sensitive" && a.category !== "browser") ?? apps[0];
    const rs = await timed("real: snapshot (windows backend)", () =>
      backend.snapshot({ appId: target.appId, pid: target.pid, maxDepth: 3 })
    );
    const rshot = await timed("real: screenshot (metadata only)", () =>
      backend.screenshot({ appId: target.appId, pid: target.pid })
    );
    realGui = {
      enabled: true,
      appId: target?.appId ?? null,
      snapshot: rs.ok
        ? {
            ok: true,
            elapsedMs: rs.elapsedMs,
            nodeCount: rs.value.nodeCount,
            source: rs.value.source,
            truncated: rs.value.truncated,
            roles: [...new Set(flattenForProbe(rs.value.tree).map((n) => n.role))],
          }
        : rs.error,
      screenshot: rshot.ok
        ? {
            ok: true,
            elapsedMs: rshot.elapsedMs,
            width: rshot.value.width,
            height: rshot.value.height,
            base64Bytes: rshot.value.base64?.length ?? 0,
            persisted: false,
          }
        : rshot.error,
      note: "只读观察，未执行任何写动作；窗口标题与画面内容不落盘",
    };
  }

  // ── 4) mock 后端的单步闭环耗时基线（逻辑链路，不代表真机 GUI） ──
  const mockPolicy = {
    ...defaultPolicy(),
    enabled: true,
    permissionMode: "auto",
    allowedApps: [{ appId: "notepad", always: true, scopes: ["read", "write"] }],
  };
  const mockAgent = new DesktopAgent({ backend: createMockBackend(), policy: mockPolicy });
  const snapshot = await timed("mock: desktop_snapshot", () =>
    mockAgent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 2 })
  );
  const step = await timed("mock: observe-act-verify", () =>
    mockAgent.callTool("desktop_click_ref", {
      appId: "notepad",
      snapshotId: snapshot.value?.snapshotId,
      ref: "b2",
    })
  );

  const enumOk = enumeration.ok && apps.length > 0;
  const channels = countBy(classified, "channel");

  const decision = {
    verdict: a11yOk ? "continue" : enumOk ? "continue-with-adjustment" : "stop",
    reasons: [
      a11yOk
        ? "a11y 树/截图/输入注入通道已在真机打通（长驻 UIA 桥），Observe→Act→Verify 闭环已由 verify-gui 验证"
        : "a11y 树/截图/输入注入通道不可用（UIA 桥未启用或会话不具备条件），P1 全链路目前只能由 mock 后端验证",
      enumOk
        ? `真实窗口枚举可用，采到 ${apps.length} 个可见窗口（${bridgeEnabled ? "UIA listWindows" : "tasklist"}），AppRegistry 与三级降级链可产出真实数据`
        : "窗口枚举也不可用，连最低限度的应用感知都不成立",
      a11yOk
        ? "下一步：扩大目标应用集合测 UIA 覆盖率与单步耗时，补 P2 视觉兜底、生命周期接线与系统授权引导"
        : "下一步：在交互式桌面会话以 DEEPCODE_AGENT_UIA_BRIDGE=1 复跑本探针，确认 UIA 树覆盖率与单步耗时后再投入 P2 视觉兜底",
    ],
    blockedCapabilities: Object.entries(caps)
      .filter(([, v]) => v && typeof v === "object" && v.supported === false)
      .map(([k, v]) => ({ capability: k, reason: v.reason })),
  };

  const report = {
    schemaVersion: 2,
    generatedAt,
    platform: process.platform,
    session: process.env.SESSIONNAME ?? "unknown",
    bridgeEnabled,
    privacy: { windowTitlesCollected: false, note: "窗口标题不落盘，仅记录存在性与长度；截图只回传内存 base64" },
    capabilities: {
      value: caps,
      elapsedMs: capabilities.elapsedMs,
      a11yTreeSupported: a11yOk,
      screenshotSupported: visualOk,
    },
    enumeration: {
      ok: enumeration.ok,
      elapsedMs: enumeration.elapsedMs,
      count: apps.length,
      error: enumeration.error ?? null,
      categoryDistribution: countBy(apps, "category"),
    },
    cacheBehaviour: {
      coldMs: enumeration.elapsedMs,
      warmMs: cacheHit.elapsedMs,
      toolCallMs: toolList.elapsedMs,
      toolCallCount: toolList.value?.count ?? null,
      note: bridgeEnabled
        ? "冷枚举走 UIA listWindows（约 0.1s）；TTL 内命中与默认工具调用不得重复枚举"
        : "冷枚举走 tasklist /v（约 15s）；TTL 内命中与默认工具调用不得重复枚举",
    },
    channelMatrix: {
      ok: matrix.ok,
      elapsedMs: matrix.elapsedMs,
      distribution: channels,
      apps: classified.map(redactApp),
    },
    realGui,
    mockBaseline: {
      note: "逻辑链路基线，非真机 GUI 耗时；用于判断编排/验证层是否成为瓶颈",
      snapshot: { ok: snapshot.ok, elapsedMs: snapshot.elapsedMs, source: snapshot.value?.source ?? null },
      step: {
        ok: step.ok,
        elapsedMs: step.elapsedMs,
        outcome: step.value?.outcome ?? null,
        code: step.value?.code ?? null,
        attempts: step.value?.attempts ?? null,
      },
    },
    decision,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  backend.close(); // 关闭长驻 UIA 桥，避免遗留 powershell.exe

  console.log(`P0 探针报告：${outPath}`);
  console.log(`  平台能力   枚举=${enumOk ? "可用" : "不可用"}  a11y=${a11yOk ? "可用" : "不可用"}  截屏=${visualOk ? "可用" : "不可用"}（桥=${bridgeEnabled ? "开" : "关"}）`);
  console.log(`  真实窗口   ${apps.length} 个，冷枚举 ${enumeration.elapsedMs} ms / 缓存命中 ${cacheHit.elapsedMs} ms / 工具调用 ${toolList.elapsedMs} ms`);
  console.log(`  通道分布   ${JSON.stringify(channels)}`);
  console.log(`  分类分布   ${JSON.stringify(report.enumeration.categoryDistribution)}`);
  if (realGui.enabled) {
    console.log(`  真机观察   ${realGui.appId}：树 ${realGui.snapshot?.nodeCount ?? "-"} 节点 / ${realGui.snapshot?.elapsedMs ?? "-"} ms，截图 ${realGui.screenshot?.width ?? "-"}x${realGui.screenshot?.height ?? "-"} / ${realGui.screenshot?.elapsedMs ?? "-"} ms`);
  }
  console.log(`  逻辑基线   snapshot ${snapshot.elapsedMs} ms / 单步闭环 ${step.elapsedMs} ms (${step.value?.outcome ?? step.value?.code})`);
  console.log(`  结论       ${decision.verdict}`);
}

await main();
