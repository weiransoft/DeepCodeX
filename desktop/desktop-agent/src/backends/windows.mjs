/**
 * Windows 感知/动作后端（真实平台实现，长驻 UIA 桥）。
 *
 * 分层取舍（方案 §2.4 / R9）：
 * - **窗口枚举优先走 UIA 桥的 `listWindows`**（约 2s，含 pid/hwnd，可与 UIA 树
 *   精确对齐）；桥不可用时回落到纯 Win32 `tasklist /v /fo csv`（约 15s，
 *   不需要 .NET / 管理员 / UIA 权限）。
 * - **a11y 树 / 截图 / 输入注入** 由 `windows-uia.ps1` **长驻 stdio 子进程**承担。
 *   稳定 ref 绑定的是进程内 AutomationElement 强引用；P1 的「每次调用新起
 *   powershell.exe」会让快照跨进程丢失、invokeRef 必然 STALE_REF。长驻是
 *   真机 GUI 能打通的前提，不是性能优化。
 * - 桥由 `DEEPCODE_AGENT_UIA_BRIDGE=1` 显式开启；`bridgeStatus()` 会真的发一次
 *   `capabilities` 自检，失败时给出可行动原因，**绝不伪造 supported:true**。
 *
 * 安全：键盘/坐标动作在桥侧会校验前台窗口属于目标进程，避免误操作用户
 * 正在使用的其它窗口；截图只回传内存 base64，不落盘。
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ErrorCode, AgentError } from "../errors.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

/** 敏感应用分类关键词（方案 §4.4：金融/加密/医疗/政企默认禁用） */
const SENSITIVE_HINTS = [
  { re: /bank|银行|券商|证券|交易|支付|wallet|crypto|coin|医保|社保|gov|政务/i, category: "finance-or-sensitive" },
];
/** 浏览器类应用：应走 ② 级 DOM/CDP 通道，而非 GUI（方案 §4.2） */
const BROWSER_HINTS = /msedge|chrome|firefox|brave|opera|webkit2webprocess/i;
/** 自绘 / 已知 UIA 树残缺应用：预期需要视觉兜底 */
const CANVAS_HINTS = /unity|unreal|game|electron|photoshop|illustrator|acrobat|canvas/i;

function classify(processName, title) {
  const hay = `${processName} ${title}`;
  for (const h of SENSITIVE_HINTS) if (h.re.test(hay)) return h.category;
  if (BROWSER_HINTS.test(processName)) return "browser";
  if (CANVAS_HINTS.test(hay)) return "selfdrawn-likely";
  if (/notepad|explorer|word|excel|outlook|code/i.test(processName)) return "productivity";
  return "unknown";
}

/**
 * 解析 tasklist /fo csv /v 输出。
 * 中文系统 tasklist 走 OEM/GBK 代码页，默认按 gbk 解码；单测可传 utf8。
 */
function parseTasklistCsv(buf, encoding = "gbk") {
  const text = new TextDecoder(encoding).decode(buf);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  for (const line of lines) {
    const cols = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cols.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cols.push(cur.trim());
    if (cols.length < 9) continue;
    const [imageName, pid, sessionName, , , , , , windowTitle] = cols;
    rows.push({ imageName, pid: Number(pid) || 0, sessionName, windowTitle });
  }
  return rows;
}

/** 导出纯解析函数供单元测试（不改变运行时行为） */
export function parseTasklistCsvForTest(buf, encoding = "gbk") {
  return parseTasklistCsv(buf, encoding);
}

/** PowerShell 的 ConvertTo-Json 偶尔把单元素数组序列化成对象，这里统一形状 */
function normalizeTree(nodes) {
  const arr = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
  return arr.map((n) => ({
    ...n,
    rect: n.rect && typeof n.rect === "object" ? n.rect : { x: 0, y: 0, width: 0, height: 0 },
    children: normalizeTree(n.children),
  }));
}

export class WindowsBackend {
  constructor(options = {}) {
    this.name = "windows";
    this.exec = options.exec ?? execFileAsync;
    this.spawnFn = options.spawn ?? spawn;
    this.home = options.home ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
    this.bridgeEnabled = options.bridgeEnabled ?? process.env.DEEPCODE_AGENT_UIA_BRIDGE === "1";
    this.bridgePath = options.bridgePath ?? join(HERE, "windows-uia.ps1");
    this.platform = options.platform ?? process.platform;
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? 30_000;
    this.bridge = null;
    this._rpcSeq = 0;
    this._bridgeProbe = null;
    this.lastTarget = null; // 最近一次 snapshot 的 {appId,pid}，供动作做前台校验
    this.enumFallbackReason = null;
  }

  /** 启动（或复用）长驻桥；返回 ready 行。stdout 逐行 JSON，stderr 只做诊断 */
  async _startBridge() {
    if (this.bridge) {
      await this.bridge.ready;
      return this.bridge;
    }
    const proc = this.spawnFn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.bridgePath, "-Stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    const st = {
      proc,
      pending: new Map(),
      buffer: "",
      stderr: "",
      settled: false,
      ready: null,
      resolveReady: null,
      rejectReady: null,
    };
    st.ready = new Promise((resolve, reject) => {
      st.resolveReady = (v) => {
        if (st.settled) return;
        st.settled = true;
        resolve(v);
      };
      st.rejectReady = (e) => {
        if (st.settled) return;
        st.settled = true;
        reject(e);
      };
    });

    const onLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        st.stderr += `[non-json] ${line.slice(0, 200)}\n`;
        return;
      }
      if (obj.type === "ready") {
        if (obj.ok === false) {
          st.rejectReady(new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, obj.message ?? "UIA 桥初始化失败"));
        } else st.resolveReady(obj);
        return;
      }
      const p = st.pending.get(obj.id);
      if (!p) return;
      clearTimeout(p.timer);
      st.pending.delete(obj.id);
      const { id, ...rest } = obj;
      p.resolve(rest);
    };

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      st.buffer += chunk;
      let idx;
      while ((idx = st.buffer.indexOf("\n")) >= 0) {
        onLine(st.buffer.slice(0, idx));
        st.buffer = st.buffer.slice(idx + 1);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => {
      st.stderr = (st.stderr + c).slice(-4000);
    });
    const onExit = (code) => {
      const reason = `UIA 桥进程已退出（code=${code}）${st.stderr ? `：${st.stderr.slice(-300)}` : ""}`;
      st.rejectReady(new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, reason));
      for (const p of st.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, reason));
      }
      st.pending.clear();
      if (this.bridge === st) {
        this.bridge = null;
        this._bridgeProbe = null; // 允许下次自检重新拉起
      }
    };
    proc.on("exit", onExit);
    proc.on("error", (err) => onExit(err?.message ?? "spawn-error"));

    this.bridge = st;
    await st.ready;
    return st;
  }

  /** 裸 RPC（不做能力前置校验，供自检与枚举降级使用） */
  async _rpc(command, args = {}) {
    const st = await this._startBridge();
    if (!st.proc.stdin.writable) {
      throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, "UIA 桥 stdin 已关闭");
    }
    const id = ++this._rpcSeq;
    const payload = Buffer.from(JSON.stringify({ id, command, args }), "utf8").toString("base64");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        st.pending.delete(id);
        reject(
          new AgentError(ErrorCode.OBSERVATION_FAILED, `UIA 桥请求超时：${command}`, {
            command,
            timeoutMs: this.bridgeTimeoutMs,
          })
        );
      }, this.bridgeTimeoutMs);
      st.pending.set(id, { resolve, reject, timer });
      st.proc.stdin.write(`${payload}\n`);
    });
  }

  /** 真实自检：连得上、UIA 枚举得到窗口，才报告 supported:true */
  async bridgeStatus() {
    if (this._bridgeProbe) return this._bridgeProbe;
    const unavailable = (reason) => ({ supported: false, reason });
    if (this.platform !== "win32") {
      this._bridgeProbe = unavailable(`非 Windows 平台（${this.platform}）`);
    } else if (!this.bridgeEnabled) {
      this._bridgeProbe = unavailable("UIA 桥未启用：设置 DEEPCODE_AGENT_UIA_BRIDGE=1 且在交互式桌面会话中运行");
    } else if (!existsSync(this.bridgePath)) {
      this._bridgeProbe = unavailable(`桥脚本不存在：${this.bridgePath}`);
    } else {
      try {
        const r = await this._rpc("capabilities", {});
        if (r?.ok && r.uia) {
          this._bridgeProbe = {
            supported: true,
            reason: `windows-uia.ps1 长驻桥已连接（session=${r.session ?? "unknown"}, userInteractive=${r.userInteractive}）`,
            details: r,
          };
        } else {
          this._bridgeProbe = unavailable(`UIA 桥自检失败：${r?.message ?? "未知原因"}`);
        }
      } catch (e) {
        this._bridgeProbe = unavailable(`UIA 桥不可用：${e?.message ?? String(e)}`);
      }
    }
    return this._bridgeProbe;
  }

  async capabilities() {
    const bridge = await this.bridgeStatus();
    const enumOk = this.platform === "win32";
    const one = (extra = "") => ({
      supported: bridge.supported,
      reason: bridge.supported ? `${bridge.reason}${extra}` : bridge.reason,
    });
    return {
      platform: "windows",
      session: process.env.SESSIONNAME ?? "unknown",
      appEnumeration: {
        supported: enumOk,
        reason: enumOk
          ? this.bridgeEnabled
            ? "UIA listWindows（优先）+ tasklist /v 回落"
            : "tasklist /v /fo csv（纯 Win32 命令，无需提权）"
          : "非 Windows 平台",
      },
      a11yTree: one(),
      screenshot: one(),
      elementInvoke: one(),
      coordinateInput: one(),
      foregroundControl: one(),
      uacAwareness: {
        supported: false,
        reason: "Secure Desktop / 完整性级别检测超出 P1 范围，遇 UAC 一律 HANDOFF_REQUIRED",
      },
      bridge: bridge.supported
        ? { connected: true, session: bridge.details?.session, userInteractive: bridge.details?.userInteractive, psVersion: bridge.details?.psVersion }
        : { connected: false, reason: bridge.reason },
    };
  }

  /** 窗口枚举：优先 UIA（快、带 pid/hwnd），失败静默回落 tasklist */
  async listApps() {
    if (this.platform !== "win32") return [];
    if (this.bridgeEnabled) {
      try {
        const res = await this._rpc("listWindows", {});
        // 「ok:true 但窗口为空」通常是桥侧枚举被异常吞掉（例如 UIA 属性读取报错），
        // 不能静默当成「桌面上没有窗口」——回落 tasklist 并记录原因，便于定位。
        if (res?.ok && Array.isArray(res.windows) && res.windows.length > 0) {
          this.enumFallbackReason = null;
          return res.windows
            .filter((w) => w.name && w.pid > 0)
            .map((w) => {
              const processName = /\.exe$/i.test(w.processName) ? w.processName : `${w.processName}.exe`;
              return {
                appId: String(w.appId || w.processName.replace(/\.exe$/i, "").toLowerCase()),
                processName,
                pid: w.pid,
                title: String(w.name),
                sessionName: process.env.SESSIONNAME ?? "Console",
                category: classify(processName, String(w.name)),
                hwnd: w.hwnd ?? null,
                foreground: null,
                enumSource: "uia",
              };
            });
        }
        this.enumFallbackReason =
          res?.ok && Array.isArray(res.windows) && res.windows.length === 0
            ? "listWindows 返回空窗口列表（UIA 枚举可能被异常吞掉），已回落 tasklist"
            : (res?.message ?? "listWindows 返回非预期结果");
      } catch (e) {
        this.enumFallbackReason = e?.message ?? String(e);
      }
    }
    return this._listAppsTasklist();
  }

  /** 纯 Win32 回落路径：不需要 .NET，也不需要交互式桌面 */
  async _listAppsTasklist() {
    const { stdout } = await this.exec("tasklist", ["/v", "/fo", "csv", "/nh"], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const rows = parseTasklistCsv(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    return rows
      .filter((r) => r.windowTitle && !/^(N\/A|不适用|暂缺|Unknown)$/i.test(r.windowTitle))
      .map((r) => {
        const appId = r.imageName.replace(/\.exe$/i, "").toLowerCase();
        return {
          appId,
          processName: r.imageName,
          pid: r.pid,
          title: r.windowTitle,
          sessionName: r.sessionName,
          category: classify(r.imageName, r.windowTitle),
          hwnd: null,
          foreground: null,
          enumSource: "tasklist",
        };
      });
  }

  _requireBridge(op) {
    return this.bridgeStatus().then((s) => {
      if (!s.supported) {
        throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, `${op} 不可用：${s.reason}`, {
          operation: op,
          fallback: "使用 mock 后端运行逻辑测试；或在交互式桌面会话设置 DEEPCODE_AGENT_UIA_BRIDGE=1",
        });
      }
    });
  }

  async _callBridge(command, args = {}, { throwOnError = false } = {}) {
    await this._requireBridge(command);
    const res = await this._rpc(command, args);
    if (res?.ok === false && throwOnError) {
      const known = Object.values(ErrorCode).includes(res.code);
      const code = known ? res.code : ErrorCode.OBSERVATION_FAILED;
      throw new AgentError(code, res.message ?? `${command} 失败`, { ...res, operation: command });
    }
    return res;
  }

  /** 自动补目标 appId/pid/hwnd，供桥侧做「前台窗口必须属于目标进程」校验 */
  _withTarget(args = {}) {
    return {
      appId: this.lastTarget?.appId ?? "",
      pid: this.lastTarget?.pid ?? 0,
      hwnd: this.lastTarget?.hwnd ?? 0,
      ...args,
    };
  }

  async snapshot({ appId, pid, hwnd, maxDepth = 3, skeleton = true } = {}) {
    const res = await this._callBridge(
      "snapshot",
      {
        appId,
        pid: pid ?? this.lastTarget?.pid ?? 0,
        hwnd: hwnd ?? this.lastTarget?.hwnd ?? 0,
        maxDepth,
        skeleton,
      },
      { throwOnError: true }
    );
    this.lastTarget = {
      appId,
      pid: res.pid ?? pid ?? 0,
      hwnd: res.hwnd ?? hwnd ?? 0,
    };
    return {
      ok: true,
      /** 关键：保留桥返回的 snapshotId，ref 与桥内 SnapshotStore 才能对上 */
      snapshotId: res.snapshotId,
      appId,
      hwnd: res.hwnd ?? hwnd ?? null,
      source: (res.tree ?? []).length === 0 ? "empty" : "a11y",
      tree: normalizeTree(res.tree),
      fullTree: normalizeTree(res.fullTree ?? res.tree),
      nodeCount: res.nodeCount ?? 0,
      truncated: Boolean(res.truncated),
      boundary: res.boundary,
      elapsedMs: res.elapsedMs,
      windowName: res.windowName,
      untrusted: true,
    };
  }

  async screenshot(args = {}) {
    const res = await this._callBridge("screenshot", this._withTarget(args));
    return { ...res, persisted: false, untrusted: true };
  }

  async invokeRef(args) {
    return this._callBridge("invokeRef", this._withTarget(args));
  }
  async clickXY(args) {
    return this._callBridge("clickXY", this._withTarget(args));
  }
  async typeText(args) {
    return this._callBridge("typeText", this._withTarget(args));
  }
  async sendKey(args) {
    return this._callBridge("sendKey", this._withTarget(args));
  }
  async waitFor(args) {
    return this._callBridge("waitFor", args);
  }
  async observeState() {
    return this._callBridge("observeState", {});
  }

  async invalidateSnapshots() {
    if (!this.bridge) return { ok: true, cleared: false };
    try {
      return await this._rpc("invalidateSnapshots", {});
    } catch {
      return { ok: false };
    }
  }

  /** sidecar 退出时关闭长驻桥，避免遗留 powershell.exe */
  close() {
    if (!this.bridge) return;
    const st = this.bridge;
    this.bridge = null;
    this._bridgeProbe = null;
    for (const p of st.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, "UIA 桥已关闭"));
    }
    st.pending.clear();
    try {
      st.proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      st.proc.kill();
    } catch {
      /* already exited */
    }
  }
}

export function createWindowsBackend(options) {
  return new WindowsBackend(options);
}
