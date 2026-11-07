#!/usr/bin/env node
/**
 * AgentLifecycle 策略热重载验证（P2「随后」第 5 项）。
 *
 * 单测锁的是逻辑，这里锁的是**接线**：起一个真的 sidecar 子进程，走真的
 * stdio JSON-RPC 帧，**保持进程不重启**，中途反复改写壳侧策略文件，看授权与
 * 撤销是不是在下一次 tools/call 前就生效。如果 index.mjs 忘了注入 reloader、
 * 或 mcp-server 绕过了 agent.callTool，单测全绿这里也会红。
 *
 * 后端用 mock：本项验证的是策略通道，不是 UIA 截图链路（那条在 §3.11–§3.13
 * 已由 verify:visual / verify:image / verify:vision 覆盖）。
 *
 * 场景：
 *   A 初始无授权            → 截图被拒（CAPABILITY_UNAVAILABLE）
 *   B 写入有效授权          → 同一进程立即出 text+image（无需重启）
 *   C 授权含坐标            → status 里 allowCoordinateInput=true（派生而非可写）
 *   D 撤销（vision:null）   → 同一进程立即拒截屏，且派生开关归零  ★核心安全用例
 *   E 策略文件被删          → fail-closed：enabled=false、通道全关
 *   F 文件恢复为无授权      → 重新解析，不沿用删除前的旧授权
 *
 * 运行：
 *   node scripts/verify-policy-lifecycle.mjs
 *   node scripts/verify-policy-lifecycle.mjs --out <path>
 */
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENTRY = join(ROOT, "src", "index.mjs");
const DEFAULT_OUT = join(ROOT, "reports", "p2-policy-lifecycle.json");

const argv = process.argv.slice(2);
const OUT = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_OUT;
})();

const MINUTE = 60_000;
const NOW = Date.now();

/** 与 desktop/src-tauri/src/desktop_agent.rs 写出的形状逐字段一致 */
function policyOf(vision) {
  return {
    enabled: true,
    permissionMode: "auto",
    allowedApps: [{ appId: "notepad", always: true, scopes: ["read", "write"] }],
    deniedApps: [],
    deniedCategories: ["finance", "crypto", "medical", "government", "finance-or-sensitive"],
    preferBrowserChannel: true,
    allowCoordinateInput: vision?.allowCoordinateInput === true,
    allowScreenshot: Boolean(vision),
    vision,
    maxSteps: 25,
    maxScreenshots: 3,
    maxTokens: 60_000,
    maxRetries: 2,
  };
}

const grant = (apps, coord = false) => ({
  apps,
  allowCoordinateInput: coord,
  grantedAt: NOW,
  expiresAt: NOW + 30 * MINUTE,
  grantId: `verify-lifecycle-${NOW.toString(36)}`,
});

/** 原子替换：避免「写一半」让脚本自己撞上 fail-closed（那条由单测覆盖） */
function writePolicy(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), "utf8");
  renameSync(tmp, path);
}

/** 长驻 sidecar：一次 initialize，之后按 id 复用同一条 stdin/stdout */
class McpChild {
  constructor(policyPath) {
    this.child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEEPCODE_AGENT_POLICY: policyPath,
        DEEPCODE_AGENT_BACKEND: "mock",
        DEEPCODE_AGENT_UIA_BRIDGE: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = [];
    this.child.stderr.on("data", (b) => this.stderr.push(String(b)));
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // stdout 只允许协议帧，非 JSON 直接忽略并留证
      }
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      slot.resolve(msg);
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`超时：${method}（stderr 尾部：${this.stderr.join("").slice(-300)}）`));
        },
        20_000
      );
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async tool(name, args = {}) {
    const frame = await this.request("tools/call", { name, arguments: args });
    const result = frame.result ?? frame.error;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.find((c) => c.type === "text")?.text ?? "";
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* 非 JSON 文本按原样留在 observed 里 */
    }
    return {
      payload,
      text,
      types: content.map((c) => c.type),
      isError: result?.isError === true,
      imageBytes: content.find((c) => c.type === "image")?.data?.length ?? 0,
    };
  }

  async ready() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "verify-policy-lifecycle", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  reloadLog() {
    const text = this.stderr.join("");
    return [...text.matchAll(/\[agent\] policy rev=(\d+) (\S+)/g)].map((m) => ({
      revision: Number(m[1]),
      reason: m[2],
    }));
  }

  async close() {
    this.rl.close();
    try {
      this.child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    // Windows 上 SIGTERM 不触发 handler，必须整棵进程树杀（避免遗留 powershell.exe）
    if (process.platform === "win32") {
      await new Promise((r) =>
        execFile("taskkill", ["/F", "/T", "/PID", String(this.child.pid)], { windowsHide: true }, () => r())
      );
    } else {
      this.child.kill("SIGTERM");
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const policyPath = join(dir, "desktop-agent.json");
  const report = {
    verdict: "pending",
    generatedAt: new Date().toISOString(),
    note: "真实 sidecar 子进程 + 真 stdio MCP 帧，全程不重启进程；mock 后端（策略通道验证）",
    cases: [],
    reloadLog: [],
    summary: null,
  };
  let child;

  try {
    writePolicy(policyPath, policyOf(null));
    child = new McpChild(policyPath);
    await child.ready();

    const shot = () =>
      child.tool("desktop_screenshot", {
        appId: "notepad",
        reason: "policy-lifecycle-verify",
        includeImage: true,
      });
    const status = () => child.tool("desktop_status", {});

    /** 每个场景自带逐项判据：失败时报告直接指到哪一条 */
    async function record(name, run, expect) {
      const observed = await run();
      const checks = expect(observed);
      const pass = Object.values(checks).every(Boolean);
      report.cases.push({ name, pass, checks, observed });
      return pass;
    }

    const denied = (o) => ({
      rejected: o.payload?.ok === false && o.payload?.code === "CAPABILITY_UNAVAILABLE",
      noImage: !o.types.includes("image"),
    });
    const allowed = (o) => ({
      ok: o.payload?.ok === true,
      hasImage: o.types.includes("image"),
      imageNonEmpty: o.imageBytes > 0,
      textHasNoBase64: !/[A-Za-z0-9+/]{400,}/.test(o.text),
    });

    // A：初始无授权
    await record("a-no-grant", shot, denied);

    // B：写有效授权，同一进程立即放行
    await record(
      "b-grant-live",
      async () => {
        writePolicy(policyPath, policyOf(grant(["notepad"])));
        await sleep(50); // 让文件替换落地（不重启子进程）
        return shot();
      },
      allowed
    );

    // C：授权带坐标 → 派生开关跟着变（不是可写字段）
    await record(
      "c-grant-with-coordinate",
      async () => {
        writePolicy(policyPath, policyOf(grant(["notepad"], true)));
        await sleep(50);
        const s = await status();
        return {
          payload: s.payload,
          types: s.types,
          text: s.text,
          imageBytes: 0,
          allowScreenshot: s.payload?.policy?.allowScreenshot,
          allowCoordinateInput: s.payload?.policy?.allowCoordinateInput,
          visionApps: s.payload?.policy?.visionApps,
        };
      },
      (o) => ({
        screenshotDerived: o.allowScreenshot === true,
        coordinateDerived: o.allowCoordinateInput === true,
        scopedToOneApp: Array.isArray(o.visionApps) && o.visionApps.length === 1 && o.visionApps[0] === "notepad",
      })
    );

    // D：撤销 —— 本项的核心安全用例，重启前必须已经收紧
    await record(
      "d-revoke-live",
      async () => {
        writePolicy(policyPath, policyOf(null));
        await sleep(50);
        const [s, st] = [await shot(), await status()];
        return {
          payload: s.payload,
          types: s.types,
          text: s.text,
          imageBytes: s.imageBytes,
          allowScreenshot: st.payload?.policy?.allowScreenshot,
          allowCoordinateInput: st.payload?.policy?.allowCoordinateInput,
        };
      },
      (o) => ({
        ...denied(o),
        screenshotReclaimed: o.allowScreenshot === false,
        coordinateReclaimed: o.allowCoordinateInput === false,
      })
    );

    // E：策略文件被删 → fail-closed 到默认全关
    await record(
      "e-file-removed-fail-closed",
      async () => {
        rmSync(policyPath);
        await sleep(50);
        const [s, st] = [await shot(), await status()];
        return {
          payload: s.payload,
          types: s.types,
          text: s.text,
          imageBytes: s.imageBytes,
          enabled: st.payload?.enabled,
          allowScreenshot: st.payload?.policy?.allowScreenshot,
        };
      },
      (o) => ({
        rejected: o.payload?.ok === false,
        noImage: !o.types.includes("image"),
        enabledReclaimed: o.enabled === false,
        screenshotReclaimed: o.allowScreenshot === false,
      })
    );

    // F：文件恢复为「无授权」→ 重新解析，不能沿用删除前的旧授权
    await record(
      "f-file-restored",
      async () => {
        writePolicy(policyPath, policyOf(null));
        await sleep(50);
        const [s, st] = [await shot(), await status()];
        return {
          payload: s.payload,
          types: s.types,
          text: s.text,
          imageBytes: s.imageBytes,
          enabled: st.payload?.enabled,
          allowScreenshot: st.payload?.policy?.allowScreenshot,
        };
      },
      (o) => ({
        ...denied(o),
        enabledBack: o.enabled === true,
        stillClosed: o.allowScreenshot === false,
      })
    );

    report.reloadLog = child.reloadLog();
    const reasons = report.reloadLog.map((e) => e.reason);
    const passed = report.cases.filter((c) => c.pass).length;
    report.summary = {
      total: report.cases.length,
      passed,
      reloads: report.reloadLog.length,
      contentChangedReloads: reasons.filter((r) => r === "content-changed").length,
      failClosedLogged: child.stderr.join("").includes("fail-closed"),
      processRestarts: 0,
    };
    // 至少要有多次 content-changed：否则说明「生效」靠的不是重载
    const wiringOk = report.summary.contentChangedReloads >= 4;
    report.verdict =
      passed === report.cases.length && wiringOk
        ? "policy-lifecycle-verified"
        : "policy-lifecycle-broken";
    report.summary.wiringOk = wiringOk;
  } finally {
    if (child) await child.close();
    rmSync(dir, { recursive: true, force: true });
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: report.verdict, summary: report.summary }, null, 2));
  for (const c of report.cases) {
    console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name} ${JSON.stringify(c.checks)}`);
  }
  if (report.verdict !== "policy-lifecycle-verified") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
