/**
 * 桌面壳桥接层（DESKTOP-ARCH-DESKTOP-001 §3.6）。
 *
 * DeepCode Desktop（Tauri v2）壳在所有页面注入 `window.__DEEPCODE_DESKTOP__`
 * （Rust 侧初始化脚本，postMessage/invoke 代理到壳 IPC 白名单命令）；
 * 若初始化脚本注入未生效（时序/异常），本模块从 Tauri 运行时注入的
 * `__TAURI_INTERNALS__` 直接构建等价桥（双通道兜底）。
 * 纯浏览器访问 `deepcode web` 时两者都不存在 → 桌面专属 UI 全部隐藏，
 * Web 独立可用零回归。
 */

/** 壳注入的桌面桥（与 desktop/src-tauri/src/lib.rs DESKTOP_BRIDGE_SCRIPT 对齐） */
export interface DesktopBridge {
  /** 桌面环境标记（恒 true，存在性即判据） */
  readonly isDesktop: boolean;
  /** 壳框架标识（"tauri-v2"） */
  readonly platform: string;
  /** 调用壳 IPC 白名单命令（engine_status / engine_restart / engine_open_logs / …） */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    /** DeepCode Desktop 壳注入的桥；纯浏览器访问时不存在 */
    __DEEPCODE_DESKTOP__?: DesktopBridge;
    /** Tauri 运行时注入的 IPC 内部通道（所有页面均有） */
    __TAURI_INTERNALS__?: {
      invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

/** 自动登录一次性标记（与壳初始化脚本 AUTO_KEY 对齐） */
const AUTO_LOGIN_KEY = "__DEEPCODE_AUTOLOGIN_DONE__";

/**
 * 桌面账号自动登录（引擎 origin 专用）：
 * 经 engine_credentials 取壳会话口令 → 同源登录换 HttpOnly Cookie。
 * 已登录 / 非引擎 origin / 纯浏览器一律静默跳过。
 */
async function ensureDesktopAutoLogin(bridge: DesktopBridge): Promise<void> {
  try {
    if (sessionStorage.getItem(AUTO_LOGIN_KEY)) return;
    sessionStorage.setItem(AUTO_LOGIN_KEY, "1");
    const creds = await bridge.invoke<{ username: string; password: string }>("engine_credentials");
    if (!creds || typeof creds.username !== "string") return;
    const me = await fetch("/api/auth/me");
    if (me.ok) return;
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    });
    if (res.ok) window.location.reload();
  } catch {
    /* 非桌面 / 凭据不可用：静默跳过，页面展示引擎自带登录页 */
  }
}

/** 读取桌面桥：壳注入对象 → __TAURI_INTERNALS__ 回退构建；纯浏览器返回 null */
export function getDesktopBridge(): DesktopBridge | null {
  const bridge = window.__DEEPCODE_DESKTOP__;
  if (bridge && bridge.isDesktop === true && typeof bridge.invoke === "function") {
    return bridge;
  }

  // 回退通道：壳初始化脚本未生效时，从 Tauri 运行时注入的内部 IPC 通道
  // 直接构建等价桥（与 DESKTOP_BRIDGE_SCRIPT 的 invoke 行为一致：
  // 同为 __TAURI_INTERNALS__.invoke，命令白名单/ACL 由 Rust 侧裁决）。
  const internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {
    const fallback: DesktopBridge = {
      isDesktop: true,
      platform: "tauri-v2",
      invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
        return internals.invoke!(cmd, args) as Promise<T>;
      },
    };
    try {
      window.__DEEPCODE_DESKTOP__ = fallback; // 缓存复用，后续调用走快路径
    } catch {
      /* 属性只读等异常场景：本次会话内仍走回退构建 */
    }
    void ensureDesktopAutoLogin(fallback);
    return fallback;
  }

  return null;
}

/** 当前是否运行在 DeepCode Desktop 壳内 */
export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}

// ───────────── desktop-agent（P1）壳侧配置面 ─────────────
//
// 方案 §4.4 / §5「授权在壳」：WebView 只能读状态、改开关、改按应用授权。
// 窗口枚举 / a11y 树 / 截图 / 输入注入全部由独立 sidecar 经 MCP 承担，
// 不经这几条命令——因此桌面桥不会成为系统特权的入口。

export interface DesktopAgentAppGrant {
  appId: string;
  always: boolean;
  scopes: Array<"read" | "write">;
}

export interface DesktopAgentPermissions {
  permissionMode: "manual" | "auto";
  allowedApps: DesktopAgentAppGrant[];
  deniedApps: string[];
}

/** 视觉通道的限时授权状态（None = 未开）。 */
export interface DesktopAgentVisionStatus {
  apps: string[];
  allowCoordinateInput: boolean;
  grantedAt: number;
  expiresAt: number;
  remainingMs: number;
  grantId: string;
}

/** 一次性确认令牌（5 分钟有效、用一次即废）。 */
export interface DesktopAgentVisionChallenge {
  token: string;
  /** 必须原样展示给用户的确认文案 */
  prompt: string;
  expiresInMs: number;
  maxTtlMinutes: number;
  /** 可被授权的应用（已获 read 权限） */
  grantableApps: string[];
}

export interface DesktopAgentVisionGrantInput {
  token: string;
  apps: string[];
  allowCoordinateInput: boolean;
  ttlMinutes: number;
}

export interface DesktopAgentStatus {
  enabled: boolean;
  permissions: DesktopAgentPermissions;
  deniedCategories: string[];
  policyPath: string;
  /** 视觉通道授权（null = 未开） */
  vision: DesktopAgentVisionStatus | null;
  sidecarRegistered: boolean;
  /** 前端无权修改的字段（UI 应置灰并说明原因） */
  lockedFields: string[];
  /** 何时才需要重启引擎：开关/授权/撤销已热生效，仅首次登记 MCP 服务需要 */
  restartHint: string;
  platformPermissions: {
    platform: string;
    required: string[];
    checkableByShell: boolean;
    hint: string;
  };
}

/** 查询能力开关、授权、sidecar 登记情况与系统权限引导。只读。 */
export async function desktopAgentStatus(): Promise<DesktopAgentStatus> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentStatus>("desktop_agent_status");
}

/** 开启/关闭能力；关闭后 sidecar 会拒绝一切观察与动作。 */
export async function desktopAgentToggle(enabled: boolean): Promise<DesktopAgentStatus> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentStatus>("desktop_agent_toggle", { enabled });
}

/** 读取当前按应用授权。 */
export async function desktopAgentPermissionsGet(): Promise<DesktopAgentPermissions> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentPermissions>("desktop_agent_permissions_get");
}

/** 写入按应用授权；敏感分类与视觉/坐标通道由壳强制锁定，前端无法放宽。 */
export async function desktopAgentPermissionsSet(
  payload: DesktopAgentPermissions,
): Promise<DesktopAgentStatus> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentStatus>("desktop_agent_permissions_set", { payload });
}

/**
 * 申请视觉通道的一次性确认令牌。
 *
 * UI 必须把返回的 `prompt` 原文展示给用户并等待确认——令牌本身不构成授权，
 * 只是让"确认"这一步必须发生在当下（5 分钟内、用一次即废）。
 */
export async function desktopAgentVisionChallenge(): Promise<DesktopAgentVisionChallenge> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentVisionChallenge>("desktop_agent_vision_challenge");
}

/** 提交视觉授权（限时 + 按应用）。任一校验失败都不会落盘。 */
export async function desktopAgentVisionGrant(
  input: DesktopAgentVisionGrantInput,
): Promise<DesktopAgentStatus> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentStatus>("desktop_agent_vision_grant", { input });
}

/** 立即撤销视觉授权（不必等到期）。 */
export async function desktopAgentVisionRevoke(): Promise<DesktopAgentStatus> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("desktop-agent 配置面仅桌面端可用");
  return bridge.invoke<DesktopAgentStatus>("desktop_agent_vision_revoke");
}
