#!/usr/bin/env node
/**
 * 视觉通道「闸门」验证（P2 随后第 3 项收尾）。
 *
 * §3.12 把图喂通了，但 `allowScreenshot` 当时是硬锁。这次改成**限时 + 按应用**的
 * 授权（壳侧 `desktop_agent_vision_challenge/grant` → 落盘 `vision` → sidecar 派生）。
 * 单测分别验证了两侧逻辑，这个脚本验证**两侧真的对得上**：用壳侧写出的同一份
 * JSON 形状，喂给真的 sidecar 子进程（真 stdio、真 MCP 帧），看它认不认。
 *
 * 五个场景（前四个跑 mock 后端，不需要真窗口；第五个跑真 UIA 截图）：
 *   A 无授权            → 截图被拒（截屏通道默认关闭）
 *   B 有效授权（只读）  → 截图成功，帧里有 image 块
 *   C 有效授权（不含坐标）→ 坐标点击被拒
 *   D 授权的是别的应用  → 截图被拒（不在视觉授权清单）
 *   E 授权已过期        → 截图被拒
 *   F 真机（windows）   → 算出 PNG 宽高与回传一致（闸门放开后像素真的到得了模型）
 *
 * 运行：
 *   node scripts/verify-vision-gate.mjs
 *   node scripts/verify-vision-gate.mjs --skip-real     # 无桌面会话时跳过 F
 */
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENTRY = join(ROOT, "src", "index.mjs");
const DEFAULT_OUT = join(ROOT, "reports", "p2-vision-gate.json");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = arg("--out", DEFAULT_OUT);
const SKIP_REAL = argv.includes("--skip-real");

const NOW = Date.now();
const MINUTE = 60_000;

/** 与 desktop/src-tauri/src/desktop_agent.rs 写出的形状逐字段一致 */
function policyOf(vision) {
  return {
    enabled: true,
    permissionMode: "auto",
    allowedApps: [
      { appId: "notepad", always: true, scopes: ["read", "write"] },
      { appId: "charmap", always: true, scopes: ["read"] },
    ],
    deniedApps: [],
    deniedCategories: ["finance", "crypto", "medical", "government", "finance-or-sensitive"],
    preferBrowserChannel: true,
    allowCoordinateInput: vision?.allowCoordinateInput === true,
    allowScreenshot: Boolean(vision),
    vision,
    maxSteps: 25,
    maxScreenshots: 3,
    maxTokens: 60000,
    maxRetries: 2,
  };
}

function grant({ apps, coord = false, ttlMs = 30 * MINUTE, at = NOW }) {
  return {
    apps,
    allowCoordinateInput: coord,
    grantedAt: at,
    expiresAt: at + ttlMs,
    grantId: `verify-${at.toString(36)}`,
  };
}

/** 起一个真 sidecar 子进程，按 MCP 协议调一次工具，拿回响应帧 */
function callToolOnce({ policyPath, backend, tool, args, timeoutMs = 25_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEEPCODE_AGENT_POLICY: policyPath,
        DEEPCODE_AGENT_BACKEND: backend,
        DEEPCODE_AGENT_UIA_BRIDGE: backend === "windows" ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr = [];
    child.stderr.on("data", (b) => stderr.push(String(b)));
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`超时（${timeoutMs}ms）：${stderr.join("").slice(-400)}`)), timeoutMs);

    function finish(err, frame) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      // Windows 上 kill(SIGTERM) 不会触发 SIGTERM handler，必须整棵进程树杀掉，
      // 否则 UIA 桥（powershell.exe）会残留
      execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }, () => {});
      err ? reject(err) : resolve({ frame, stderr: stderr.join("") });
    }

    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // stdout 只应是协议帧；解析不了就跳过（stderr 里有日志）
      }
      if (msg.id === 2) finish(null, msg);
    });
    child.on("error", (e) => finish(e));

    const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  });
}

/** 从帧里取文本载荷与图像块 */
function readFrame(frame) {
  const result = frame?.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  const image = content.find((c) => c.type === "image") ?? null;
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { isError: result.isError === true, text, payload, image, types: content.map((c) => c.type) };
}

function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if ([...bytes.subarray(0, 8)].some((b, i) => b !== sig[i])) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function scenario(dir, name, { policy, backend = "mock", tool, args, expect }) {
  const policyPath = join(dir, `${name}.json`);
  writeFileSync(policyPath, JSON.stringify(policy, null, 2), "utf8");
  try {
    const { frame, stderr } = await callToolOnce({ policyPath, backend, tool, args });
    const info = readFrame(frame);
    // expect 允许返回对象（带 ok 与逐项判据）：失败时报告里能看出卡在哪一条，
    // 只回 false 的话原因永远是「猜」
    const observed = describe(info);
    // 判据拿到的是「原始帧 + 派生观测」的合并视图：pixelSize / imageBytes 这些
    // 是 describe 算出来的，只传原始帧的话判据里永远是 undefined（会静默判失败）
    const view = { ...info, ...observed };
    const verdict = expect(view);
    const structured = verdict !== null && typeof verdict === "object";
    const row = { name, backend, tool, args, observed, pass: structured ? verdict.ok === true : verdict === true };
    if (structured) row.checks = verdict;
    // 失败时把 sidecar 的 stderr 尾部带上：windows 后端在桥错误时是静默降级
    // （_callBridge 默认不抛），只看返回帧会完全不知道桥为什么没出图
    if (!row.pass) row.stderrTail = String(stderr ?? "").slice(-1200);
    delete row.expect;
    return row;
  } catch (err) {
    return { name, backend, tool, args, expect: String(expect), error: String(err?.message ?? err), pass: false };
  }
}

function describe(info) {
  const bytes = info.image?.data ? Buffer.from(info.image.data, "base64") : null;
  return {
    isError: info.isError,
    code: info.payload?.code ?? null,
    message: info.payload?.message ?? null,
    contentTypes: info.types,
    imageMimeType: info.image?.mimeType ?? null,
    imageBytes: bytes?.length ?? 0,
    textBytes: Buffer.byteLength(info.text ?? ""),
    textHasLongBase64: /[A-Za-z0-9+/]{400,}/.test(info.text ?? ""),
    textKeys: (() => {
      try {
        return Object.keys(JSON.parse(info.text) ?? {});
      } catch {
        return null;
      }
    })(),
    pixelSize: bytes ? pngSize(bytes) : null,
    reportedSize: info.payload ? { width: info.payload.width, height: info.payload.height } : null,
  };
}

const deniedWith = (needle) => (info) =>
  info.isError === true && info.payload?.ok === false && info.payload?.code === "CAPABILITY_UNAVAILABLE" && needle.test(info.payload?.message ?? "");

const imageOk = (info) =>
  info.isError === false &&
  info.types.join(",") === "text,image" &&
  info.image?.mimeType === "image/png" &&
  !/[A-Za-z0-9+/]{400,}/.test(info.text);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "dcx-vision-gate-"));
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, cases: [] };
  try {
    report.cases.push(
      await scenario(dir, "a-no-grant", {
        policy: policyOf(null),
        tool: "desktop_screenshot",
        args: { appId: "notepad", reason: "gate-a" },
        expect: deniedWith(/截屏通道默认关闭/),
      })
    );

    report.cases.push(
      await scenario(dir, "b-granted-readonly", {
        policy: policyOf(grant({ apps: ["notepad"] })),
        tool: "desktop_screenshot",
        args: { appId: "notepad", reason: "gate-b", includeImage: true },
        expect: imageOk,
      })
    );

    report.cases.push(
      await scenario(dir, "c-no-coordinate", {
        policy: policyOf(grant({ apps: ["notepad"], coord: false })),
        tool: "desktop_click_xy",
        args: { appId: "notepad", x: 10, y: 10 },
        expect: deniedWith(/坐标输入通道默认关闭/),
      })
    );

    report.cases.push(
      await scenario(dir, "d-other-app", {
        policy: policyOf(grant({ apps: ["charmap"], coord: true })),
        tool: "desktop_screenshot",
        args: { appId: "notepad", reason: "gate-d" },
        expect: deniedWith(/不在视觉授权清单/),
      })
    );

    report.cases.push(
      await scenario(dir, "e-expired", {
        policy: policyOf(grant({ apps: ["notepad"], at: NOW - 2 * 60 * MINUTE, ttlMs: MINUTE })),
        tool: "desktop_screenshot",
        args: { appId: "notepad", reason: "gate-e" },
        expect: deniedWith(/截屏通道默认关闭/),
      })
    );

    if (!SKIP_REAL) {
      // 真机：授权放开后，真截图能不能穿过整条链路（含 PNG 尺寸自证）
      let ctx = null;
      try {
        ctx = await launchCalc();
        const { target } = ctx;
        report.cases.push(
          await scenario(dir, "f-real-windows", {
            policy: {
              ...policyOf(grant({ apps: [target.appId.toLowerCase(), "calc", "calculatorapp", "applicationframehost"], coord: false })),
              allowedApps: [
                { appId: target.appId, always: true, scopes: ["read", "write"] },
                { appId: "applicationframehost", always: true, scopes: ["read", "write"] },
              ],
            },
            backend: "windows",
            tool: "desktop_screenshot",
            // F 只验「闸门放开后像素能不能穿过协议层」，不比较像素内容归属；
            // 抢前台属于 verify:visual 的 before/after 验效，且后台进程可能被系统拒绝
            args: { appId: target.appId, hwnd: Number(target.hwnd), reason: "gate-f", includeImage: true, activate: false },
            expect: (info) => {
              const checks = {
                imageBlock: imageOk(info),
                decoded: Boolean(info.pixelSize),
                // 必须先 decoded：两边都 undefined 时 `===` 会假阳性判成「尺寸一致」
                widthMatches: Boolean(info.pixelSize) && info.pixelSize?.width === info.reportedSize?.width,
                heightMatches: Boolean(info.pixelSize) && info.pixelSize?.height === info.reportedSize?.height,
                bytesPositive: info.imageBytes > 0,
              };
              return { ok: Object.values(checks).every(Boolean), ...checks };
            },
          })
        );
      } catch (err) {
        // 已有实例/无桌面会话：如实标注跳过，不假装通过
        report.cases.push({
          name: "f-real-windows",
          backend: "windows",
          skipped: true,
          reason: String(err?.message ?? err).slice(0, 300),
        });
      } finally {
        if (ctx) await closeCalc(ctx);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 跳过（无桌面会话）不算失败，但也绝不能算通过——verdict 里单列出来
  const failed = report.cases.filter((c) => c.pass === false);
  const skipped = report.cases.filter((c) => c.skipped === true);
  report.summary = {
    total: report.cases.length,
    passed: report.cases.filter((c) => c.pass === true).length,
    failed: failed.length,
    skipped: skipped.length,
  };
  report.verdict =
    failed.length > 0 ? "vision-gate-broken" : skipped.length > 0 ? "vision-gate-partial" : "vision-gate-verified";
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  return report.verdict === "vision-gate-verified" ? 0 : 1;
}

/* ── 真机：拉起/认领/关闭计算器 ─────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function windowKeys() {
  const { createWindowsBackend } = await import("../src/backends/windows.mjs");
  // 必须显式开桥：默认走 tasklist 回落，**所有条目的 hwnd 都是 null**，
  // 表现为「算不出新窗口」，很容易被误读成计算器没起来
  const backend = createWindowsBackend({ bridgeEnabled: true });
  const apps = await backend.listApps().catch(() => []);
  if (apps.length > 0 && apps.every((a) => !a.hwnd)) {
    throw new Error("UIA 桥未生效（窗口枚举全部无 hwnd，已回落 tasklist）——检查 DEEPCODE_AGENT_UIA_BRIDGE 与 PowerShell 可用性");
  }
  return { before: new Set(apps.filter((a) => a.hwnd).map((a) => a.hwnd)), backend };
}

async function launchCalc(timeoutMs = 25_000) {
  const { before, backend } = await windowKeys();
  const proc = spawn("calc.exe", [], { stdio: "ignore", windowsHide: false });
  const wanted = ["applicationframehost", "calculatorapp", "calc"];
  const t0 = Date.now();
  try {
    for (;;) {
      const apps = await backend.listApps().catch(() => []);
      const hit = apps.find(
        (a) => a.hwnd && !before.has(a.hwnd) && wanted.some((w) => `${a.appId} ${a.processName}`.toLowerCase().includes(w))
      );
      if (hit) {
        await sleep(900); // UWP 冷启动：先出窗口后出内容
        return { target: hit, proc, backend };
      }
      if (Date.now() - t0 > timeoutMs) {
        // 计算器是单实例：残留的旧窗口被「拉起」只会聚焦、不会产生新 hwnd，
        // 报「等不到」会让人误以为是环境坏，实际是上一轮没关干净
        const existing = apps.find((a) => wanted.some((w) => `${a.appId} ${a.processName}`.toLowerCase().includes(w)));
        throw new Error(
          existing ? `已有计算器实例（hwnd ${existing.hwnd}），单实例不会新开窗口——先关掉它` : "等不到计算器窗口"
        );
      }
      await sleep(300);
    }
  } catch (err) {
    proc.kill();
    await backend.shutdown?.();
    throw err;
  }
}

async function closeCalc(ctx) {
  if (!ctx?.target) return;
  await new Promise((resolve) => execFile("taskkill", ["/PID", String(ctx.target.pid)], { windowsHide: true }, () => resolve()));
  await sleep(600);
  await new Promise((resolve) => execFile("taskkill", ["/F", "/T", "/PID", String(ctx.target.pid)], { windowsHide: true }, () => resolve()));
  await ctx.backend.shutdown?.();
}

process.exit(await main());
