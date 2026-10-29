/**
 * 桌面壳桥接层（DESKTOP-ARCH-DESKTOP-001 §3.6）。
 *
 * DeepCode Desktop（Tauri v2）壳在所有页面注入 `window.__DEEPCODE_DESKTOP__`
 * （Rust 侧初始化脚本，postMessage/invoke 代理到壳 IPC 白名单命令）；
 * 纯浏览器访问 `deepcode web` 时该对象不存在 → 桌面专属 UI 全部隐藏，
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
  }
}

/** 读取桌面桥；不存在或形态非法（非桌面注入）时返回 null */
export function getDesktopBridge(): DesktopBridge | null {
  const bridge = window.__DEEPCODE_DESKTOP__;
  if (bridge && bridge.isDesktop === true && typeof bridge.invoke === "function") {
    return bridge;
  }
  return null;
}

/** 当前是否运行在 DeepCode Desktop 壳内 */
export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}
