#!/usr/bin/env node
/**
 * 真实应用 UIA 覆盖率报告（P2 准入第 1 项）。
 *
 * 目的：真机闭环此前只在受控 WPF 窗口验证，不能代表真实应用。本脚本对**当前
 * 桌面上的真实窗口**逐个做**只读**观察（snapshot / 角色统计 / 耗时），量化
 * 「语义树优先」策略在真实应用上的覆盖率，为是否投入视觉兜底提供数据。
 *
 * 安全边界（重要）：
 *  - 只调用 snapshot，不执行任何 invoke / type / key / click；
 *  - 跳过敏感分类（金融/加密/医疗/政务）与无标题窗口；
 *  - 不落盘窗口标题全文，只记录长度与「是否含中文」这类粗特征；
 *  - 不保存截图，除非显式 `--screenshot`（仍只写宽高与字节数）。
 *
 * 运行：
 *   DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/coverage-report.mjs [--limit 8] [--out 路径]
 * 退出码恒为 0；结论写在 JSON 的 summary 字段。
 */
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWindowsBackend } from "../src/backends/windows.mjs";
import { AppRegistry } from "../src/modules/app-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p2-coverage.json");

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Number(getArg("--limit", "8"));
const OUT = getArg("--out", DEFAULT_OUT);
const WITH_SCREENSHOT = argv.includes("--screenshot");

const flatten = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

/** 可操作性粗判：有名字、有面积、enabled，才算「模型能指名点击」的目标 */
function actionable(nodes) {
  return nodes.filter((n) => n.role !== "Window" && n.enabled !== false && n.rect?.width > 0 && n.rect?.height > 0).length;
}

function named(nodes) {
  return nodes.filter((n) => String(n.name ?? "").trim().length > 0).length;
}

async function one(backend, app, maxDepth) {
  const t0 = performance.now();
  try {
    const snap = await backend.snapshot({ appId: app.appId, pid: app.pid, hwnd: app.hwnd, maxDepth });
    const ms = Number((performance.now() - t0).toFixed(2));
    const nodes = flatten(snap.tree);
    const roles = {};
    for (const n of nodes) roles[n.role ?? "unknown"] = (roles[n.role ?? "unknown"] ?? 0) + 1;

    const row = {
      appId: app.appId,
      processName: app.processName,
      pid: app.pid,
      hwnd: app.hwnd ?? null,
      category: app.category,
      channel: app.channel,
      titleLength: String(app.title ?? "").length,
      nonAsciiTitle: /[^\x00-\x7f]/.test(String(app.title ?? "")),
      ok: true,
      elapsedMs: ms,
      nodeCount: snap.nodeCount,
      returnedNodes: nodes.length,
      truncated: Boolean(snap.truncated),
      actionableNodes: actionable(nodes),
      namedNodes: named(nodes),
      roles,
      topRoles: Object.entries(roles).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, c]) => `${r}:${c}`),
    };

    if (WITH_SCREENSHOT) {
      try {
        const shot = await backend.screenshot({ appId: app.appId, pid: app.pid });
        row.screenshot = { ok: shot.ok, width: shot.width, height: shot.height, bytes: shot.base64?.length ?? 0 };
      } catch (e) {
        row.screenshot = { ok: false, code: e?.code ?? "INTERNAL", message: String(e?.message ?? e).slice(0, 160) };
      }
    }
    return row;
  } catch (e) {
    return {
      appId: app.appId,
      processName: app.processName,
      pid: app.pid,
      category: app.category,
      channel: app.channel,
      ok: false,
      error: { code: e?.code ?? "INTERNAL", message: String(e?.message ?? e).slice(0, 200) },
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
    };
  }
}

async function main() {
  const backend = createWindowsBackend({ bridgeEnabled: true });
  const registry = new AppRegistry(backend, {});
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    session: process.env.SESSIONNAME ?? "unknown",
    privacy: { windowTitlesPersisted: false, note: "只记录标题长度与非 ASCII 特征，不落盘标题内容；默认不截图" },
    maxDepth: 4,
    apps: [],
  };

  try {
    const caps = await backend.capabilities();
    report.capabilities = { a11yTree: caps.a11yTree, screenshot: caps.screenshot, bridge: caps.bridge };
    if (!caps.a11yTree?.supported) {
      report.summary = { verdict: "skipped", reason: "UIA 桥不可用，无法采集真实应用覆盖率" };
      persist(report);
      console.log(JSON.stringify(report.summary, null, 2));
      return;
    }

    const t0 = performance.now();
    const apps = await registry.list({ refresh: true });
    report.enumeration = { count: apps.length, elapsedMs: Number((performance.now() - t0).toFixed(2)) };

    const matrix = await registry.channelMatrix(apps);
    const seenHwnd = new Set();
    const pickable = matrix
      .filter((a) => a.category !== "finance-or-sensitive")
      .filter((a) => String(a.title ?? "").trim().length > 0)
      // 同一进程多窗口必须按 hwnd 逐个采样：只按 pid 会把同进程的两个窗口
      // 采样成同一棵树（此前 explorer 的桌面窗口与文件夹窗口就是这样重复的）。
      .filter((a) => {
        const key = a.hwnd ? `h:${a.hwnd}` : `p:${a.pid}`;
        if (seenHwnd.has(key)) return false;
        seenHwnd.add(key);
        return true;
      })
      .slice(0, Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : 8);

    for (const app of pickable) {
      report.apps.push(await one(backend, app, 4));
    }

    const okRows = report.apps.filter((r) => r.ok);
    const totalNodes = okRows.reduce((s, r) => s + r.returnedNodes, 0);
    const totalActionable = okRows.reduce((s, r) => s + r.actionableNodes, 0);
    const withTree = okRows.filter((r) => r.returnedNodes > 1).length;

    report.summary = {
      verdict: okRows.length === 0 ? "no-data" : withTree === okRows.length ? "tree-usable" : "partial-tree",
      sampled: report.apps.length,
      snapshotOk: okRows.length,
      treeUsable: withTree,
      totalNodes,
      totalActionable,
      avgElapsedMs: okRows.length
        ? Number((okRows.reduce((s, r) => s + r.elapsedMs, 0) / okRows.length).toFixed(2))
        : null,
      maxElapsedMs: okRows.length ? Math.max(...okRows.map((r) => r.elapsedMs)) : null,
      thinTrees: okRows.filter((r) => r.returnedNodes <= 2).map((r) => `${r.appId}(pid=${r.pid})`),
      failures: report.apps.filter((r) => !r.ok).map((r) => `${r.appId}: ${r.error.code}`),
      note: "只读采样；thinTrees 表示 UIA 树几乎为空，这类应用若需操作只能走视觉兜底或直接拒绝",
    };

    persist(report);
    console.log(JSON.stringify(report.summary, null, 2));
  } finally {
    backend.close();
  }
}

function persist(report) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`覆盖率报告：${OUT}`);
}

await main();
