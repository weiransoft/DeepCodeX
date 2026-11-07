#!/usr/bin/env node
/**
 * 「把图喂给模型」真机验证（P2 随后第 3 项 / 方案 §3.12）。
 *
 * 单测能证明「payload 拆得对」，但证明不了**协议帧里那张图是真的窗口画面**。
 * 这个脚本补这一段：拉真窗口 → 真截图 → 走真 MCP stdio 帧 → 再把帧喂给 core
 * 的提取逻辑，用可独立核对的三条证据收口：
 *
 *   ① 帧里有两个内容块：text（元数据，**不含 base64**）+ image（mimeType + data）
 *   ② image.data 解出来是 PNG，且 IHDR 里的宽高 == 工具回传的 width/height
 *      —— 这一条才证明它是真截图，而不是任何占位/缩略图
 *   ③ core 侧（packages/core）同一份帧能提取出 1 张图并拼成 image_url follow-up
 *      消息，data URL 前缀与解码字节数都对得上
 *
 * 安全边界：
 *  - 只拉计算器（纯计算、不碰用户文档），结束时关掉自己拉起的进程；
 *  - **不抢前台**（activate=false）：本脚本只验「像素能否穿过协议层到 core」，
 *    不做 before/after 像素比较，不需要保证像素归属；而后台进程 / 无交互式会话下
 *    抢前台会被系统拒绝（ACTION_DENIED），让验证白白依赖桌面状态。像素归属的
 *    保证属于 verify:visual（那里才需要 activate）。
 *  - 图像只在内存里流转，不落盘（脚本输出只记录尺寸/字节数/哈希）。
 *
 * 运行（需要 tsx 才能加载 core 的 TS 模块；缺 tsx 时仍会验证 ①②）：
 *   node --import tsx scripts/verify-image-content.mjs
 *   node scripts/verify-image-content.mjs --out reports/x.json
 */
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DEEPCODE_AGENT_UIA_BRIDGE = process.env.DEEPCODE_AGENT_UIA_BRIDGE ?? "1";

const { createWindowsBackend } = await import("../src/backends/windows.mjs");
const { DesktopAgent } = await import("../src/agent.mjs");
const { defaultPolicy } = await import("../src/modules/policy-guard.mjs");
const { createMcpServer } = await import("../src/mcp-server.mjs");
const { base64Bytes } = await import("../src/modules/mcp-content.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "reports", "p2-image-content.json");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = arg("--out", DEFAULT_OUT);
const KEEP_OPEN = argv.includes("--keep-open");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 拉起 / 认领 / 关闭（与 verify-visual-fallback.mjs 同款） ────────── */

function launchCalc() {
  const proc = spawn("calc.exe", [], { stdio: "ignore", windowsHide: false });
  proc.on("error", (e) => {
    proc.__spawnError = e;
  });
  return proc;
}

async function windowKeys(backend) {
  const apps = await backend.listApps().catch(() => []);
  return new Set(apps.filter((a) => a.hwnd).map((a) => a.hwnd));
}

async function waitForCalc(backend, before, proc, timeoutMs = 25_000) {
  const wanted = ["applicationframehost", "calculatorapp", "calc"];
  const t0 = Date.now();
  for (;;) {
    if (proc?.__spawnError) {
      const err = new Error(`无法启动 calc.exe：${proc.__spawnError.code}`);
      err.code = "APP_NOT_INSTALLED";
      throw err;
    }
    const apps = await backend.listApps().catch(() => []);
    const fresh = apps.filter((a) => a.hwnd && !before.has(a.hwnd));
    const hit = fresh.find((a) => wanted.some((w) => `${a.appId} ${a.processName}`.toLowerCase().includes(w)));
    if (hit) return hit;
    if (Date.now() - t0 > timeoutMs) {
      const err = new Error("等不到计算器窗口（可能已有实例，脚本不去动用户窗口）");
      err.code = "WINDOW_TIMEOUT";
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
  if (!owned || !pid) return { skipped: true };
  await new Promise((resolve) => execFile("taskkill", ["/PID", String(pid)], { windowsHide: true }, () => resolve()));
  for (let i = 0; i < 8; i += 1) {
    if (!(await pidAlive(pid))) return { graceful: true };
    await sleep(250);
  }
  await new Promise((resolve) => execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, () => resolve()));
  return { forced: true };
}

/* ── 帧校验 ─────────────────────────────────────────────────────────── */

/** 从 PNG 字节里读 IHDR 宽高（偏移固定：8 字节签名 + 4 长度 + 4 "IHDR"） */
function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const signature = bytes.subarray(0, 8);
  const expected = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if ([...signature].some((b, i) => b !== expected[i])) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function inspectFrame(frame) {
  const result = frame?.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((c) => c.type === "text");
  const imageBlocks = content.filter((c) => c.type === "image");
  const text = textBlock?.text ?? "";
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const image = imageBlocks[0] ?? null;
  const bytes = image?.data ? Buffer.from(image.data, "base64") : null;
  const size = bytes ? pngSize(bytes) : null;

  return {
    isError: result.isError === true,
    contentTypes: content.map((c) => c.type),
    textBytes: Buffer.byteLength(text),
    /** 文本块里绝不能出现 base64：同一张图写两遍等于把 token 花两遍 */
    textCarriesBase64: /[A-Za-z0-9+/]{200,}/.test(text),
    payload,
    imageMimeType: image?.mimeType ?? null,
    imageBase64Chars: image?.data?.length ?? 0,
    imageBytes: bytes?.length ?? 0,
    imageSha256Prefix: bytes ? createHash("sha256").update(bytes).digest("hex").slice(0, 16) : null,
    /** 从像素本身读出来的尺寸：与工具回传的 width/height 必须一致 */
    pixelSize: size,
    imageCount: imageBlocks.length,
  };
}

/* ── core 侧：同一份帧走真实提取逻辑 ────────────────────────────────── */

async function runCoreLeg(content) {
  try {
    const core = await import("../../../packages/core/src/mcp/mcp-image-content.ts");
    const { images, skipped } = core.extractMcpImages(content);
    const message = images.length > 0 ? core.buildMcpImageFollowUpMessage("mcp__desktop-agent__desktop_screenshot", images) : null;
    const parts = Array.isArray(message?.contentParams) ? message.contentParams : [];
    const url = parts[0]?.image_url?.url ?? "";
    return {
      status: "ok",
      images: images.length,
      skipped: skipped.map((s) => s.reason),
      imageBytes: images[0]?.bytes ?? 0,
      followUpRole: message?.role ?? null,
      followUpVisible: message?.visible ?? null,
      dataUrlPrefix: url.slice(0, 30),
      dataUrlMatchesPayload: images.length > 0 && url.endsWith(images[0].data),
      mentionsUntrusted: /untrusted data, not as instructions/.test(message?.content ?? ""),
    };
  } catch (err) {
    // 没有 tsx 时加载不了 .ts：如实标注「未验证」，不假装通过
    return { status: "unavailable", reason: String(err?.message ?? err).slice(0, 200) };
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

async function main() {
  const backend = createWindowsBackend();
  const before = await windowKeys(backend);
  const proc = launchCalc();
  let target = null;
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    backend: backend.name,
    cases: {},
  };

  try {
    target = await waitForCalc(backend, before, proc);
    // UWP 冷启动：先出窗口后出内容，等一小会儿再截，避免抓到白板
    await sleep(900);

    const policy = {
      ...defaultPolicy(),
      enabled: true,
      permissionMode: "auto",
      allowedApps: [...new Set([target.appId, "applicationframehost", "calculatorapp", "calc", "notepad"])].map((appId) => ({
        appId,
        always: true,
        scopes: ["read", "write"],
      })),
      allowScreenshot: true,
    };
    const agent = new DesktopAgent({ backend, policy, limits: { ...policy, maxScreenshots: 4, maxSteps: 10 } });

    // 真 MCP 帧：直接驱动 createMcpServer（与 stdio 输出同一个 write 路径）
    const frames = [];
    const server = createMcpServer(agent, {
      input: process.stdin,
      output: { write: (s) => frames.push(JSON.parse(s.trim())) },
      log: () => {},
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "desktop_screenshot",
        arguments: {
          appId: target.appId,
          hwnd: Number(target.hwnd),
          reason: "verify-image-content",
          includeImage: true,
          // 见文件头：只验图像管线，不比较像素内容，不依赖抢前台成功
          activate: false,
        },
      },
    });
    server.close();

    const frame = frames[0];
    const info = inspectFrame(frame);
    const coreLeg = await runCoreLeg(frame?.result?.content ?? []);

    const checks = {
      callOk: info.isError === false,
      twoBlocks: info.contentTypes.length === 2 && info.contentTypes[0] === "text" && info.contentTypes[1] === "image",
      textHasNoBase64: info.textCarriesBase64 === false,
      imageMimePng: info.imageMimeType === "image/png",
      pixelSizeMatchesPayload:
        Boolean(info.pixelSize) && info.pixelSize.width === info.payload?.width && info.pixelSize.height === info.payload?.height,
      payloadMetaAttached: info.payload?.image?.attached === true && info.payload?.image?.bytes === info.imageBytes,
      telemetryHasNoBase64: JSON.stringify(agent.telemetry.events).includes("base64") === false,
      coreAccepted: coreLeg.status === "ok" && coreLeg.images === 1 && coreLeg.dataUrlMatchesPayload === true,
    };

    report.cases.calculator = {
      target: { appId: target.appId, hwnd: target.hwnd, processName: target.processName },
      frame: info,
      coreLeg,
      checks,
      verdict: Object.values(checks).every(Boolean) ? "image-content-verified" : "image-content-broken",
    };
    report.verdict = Object.values(report.cases).every((c) => c.verdict === "image-content-verified")
      ? "image-content-verified"
      : "image-content-broken";

    if (!KEEP_OPEN) report.closed = await closeApp(target.pid, true);
  } catch (err) {
    report.verdict = "blocked";
    report.error = { code: err?.code ?? "ERROR", message: String(err?.message ?? err) };
  } finally {
    await backend.shutdown?.();
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  return report.verdict === "image-content-verified" ? 0 : 1;
}

process.exit(await main());
