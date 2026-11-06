/**
 * Windows 感知/动作后端（真实平台实现）。
 *
 * 分层取舍（方案 §2.4 / R9）：
 * - **窗口/进程枚举用纯 Win32 命令 `tasklist /v /fo csv`**：不需要 .NET 编译、
 *   不需要管理员、不需要 UIA 权限，在受限会话里也能拿到真实数据。
 * - **a11y 树 / 截图 / 输入注入** 委托给独立 PowerShell 桥 `windows-uia.ps1`，
 *   由环境变量 `DEEPCODE_AGENT_UIA_BRIDGE=1` 显式开启。桥不可用（缺少
 *   UIAutomationClient 程序集、会话 0、无桌面、沙箱禁止运行时编译）时，
 *   明确返回 CAPABILITY_UNAVAILABLE + 可行动原因，**绝不伪造观察结果**。
 *
 * 这样即便在受限环境下，AppRegistry 与能力矩阵仍可产出真实探针数据，
 * 而全链路逻辑测试由 mock 后端承担。
 */

import { execFile } from "node:child_process";
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
    // CSV：双引号包裹，字段内逗号在引号内；用简单状态机而非 split(',')
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
    // 列序：映像名称, PID, 会话名, 会话#, 内存使用, 状态, 用户名, CPU 时间, 窗口标题
    const [imageName, pid, sessionName, , , , , , windowTitle] = cols;
    rows.push({ imageName, pid: Number(pid) || 0, sessionName, windowTitle });
  }
  return rows;
}

/** 导出纯解析函数供单元测试（不改变运行时行为） */
export function parseTasklistCsvForTest(buf, encoding = "gbk") {
  return parseTasklistCsv(buf, encoding);
}

export class WindowsBackend {
  constructor(options = {}) {
    this.name = "windows";
    this.exec = options.exec ?? execFileAsync;
    this.home = options.home ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
    this.bridgeEnabled = options.bridgeEnabled ?? process.env.DEEPCODE_AGENT_UIA_BRIDGE === "1";
    this.bridgePath = options.bridgePath ?? join(HERE, "windows-uia.ps1");
    this.platform = options.platform ?? process.platform;
    this.snapshotSeq = 0;
    this.snapshots = new Map();
    this._bridgeProbe = null;
  }

  /** 桥可用性探测只做一次；不做任何 .NET 编译 */
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
      this._bridgeProbe = { supported: true, reason: "windows-uia.ps1 已就绪（需交互式桌面会话）" };
    }
    return this._bridgeProbe;
  }

  async capabilities() {
    const bridge = await this.bridgeStatus();
    const enumOk = this.platform === "win32";
    return {
      platform: "windows",
      session: process.env.SESSIONNAME ?? "unknown",
      appEnumeration: {
        supported: enumOk,
        reason: enumOk ? "tasklist /v /fo csv（纯 Win32 命令，无需提权）" : "非 Windows 平台",
      },
      a11yTree: bridge,
      screenshot: bridge,
      elementInvoke: bridge,
      coordinateInput: bridge,
      foregroundControl: bridge,
      uacAwareness: {
        supported: false,
        reason: "Secure Desktop / 完整性级别检测超出 P1 范围，遇 UAC 一律 HANDOFF_REQUIRED",
      },
    };
  }

  /** 真实窗口枚举：只保留有可见窗口标题的进程（AppRegistry 的最小可用集） */
  async listApps() {
    if (this.platform !== "win32") return [];
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
          hwnd: null, // 需 UIA 桥补充（P2）
          foreground: null,
        };
      });
  }

  _requireBridge(op) {
    return this.bridgeStatus().then((s) => {
      if (!s.supported) {
        throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, `${op} 不可用：${s.reason}`, {
          operation: op,
          fallback: "使用 mock 后端运行逻辑测试；或在交互式桌面会话启用 UIA 桥",
        });
      }
    });
  }

  /** 调用 PowerShell 桥；stdout 期望单行 JSON */
  async _callBridge(command, args = {}) {
    await this._requireBridge(command);
    const payload = Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
    const { stdout } = await this.exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.bridgePath, "-PayloadBase64", payload],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30_000 }
    );
    const text = new TextDecoder("utf8").decode(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)).trim();
    const lastLine = text.split(/\r?\n/).filter(Boolean).pop() ?? "";
    try {
      return JSON.parse(lastLine);
    } catch {
      throw new AgentError(ErrorCode.OBSERVATION_FAILED, "UIA 桥返回非 JSON 输出", {
        output: lastLine.slice(0, 200),
      });
    }
  }

  async snapshot({ appId, maxDepth = 3, skeleton = true } = {}) {
    const res = await this._callBridge("snapshot", { appId, maxDepth, skeleton });
    const snapshotId = `win-snap-${++this.snapshotSeq}`;
    this.snapshots.set(snapshotId, { appId, createdAt: Date.now(), data: res });
    return { ...res, snapshotId, source: (res.tree ?? []).length === 0 ? "empty" : "a11y", untrusted: true };
  }

  async screenshot(args = {}) {
    const res = await this._callBridge("screenshot", args);
    return { ...res, persisted: false, untrusted: true }; // 默认不落盘（R2）
  }

  async invokeRef(args) {
    return this._callBridge("invokeRef", args);
  }
  async clickXY(args) {
    return this._callBridge("clickXY", args);
  }
  async typeText(args) {
    return this._callBridge("typeText", args);
  }
  async sendKey(args) {
    return this._callBridge("sendKey", args);
  }
  async waitFor(args) {
    return this._callBridge("waitFor", args);
  }
  async observeState() {
    return this._callBridge("observeState", {});
  }
}

export function createWindowsBackend(options) {
  return new WindowsBackend(options);
}
