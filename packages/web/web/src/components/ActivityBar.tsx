/**
 * 左侧活动栏（Trae 风格 Shell 重构）。
 *
 * 44px 图标纵列，仅桌面壳渲染（纯浏览器零渲染，Web 零回归）：
 * - 会话：侧边栏切回会话视图（再次点击 = 折叠/展开侧栏）；
 * - 文件：打开/关闭右侧文件抽屉（打开中高亮）；
 * - 远程：侧边栏切到 SSH 远程视图（M2 数据面，UI 已就位）；
 * - 底部：系统管理（打开设置抽屉）、引擎（引擎状态点随 engine_status 轮询着色）。
 *
 * 与现有模块映射（设计对齐项）：会话=SessionSidebar、文件=FileDrawer、
 * 远程=SshPanel、系统管理=SettingsDrawer、引擎=engine_status/engine_restart IPC。
 */
import { useEffect, useState } from "react";
import { getDesktopBridge, type DesktopBridge } from "../desktop-bridge";
import { ChatIcon, EngineIcon, FolderIcon, GearIcon, MoonIcon, RemoteIcon, SunIcon } from "./icons";

/** 主题偏好存储键（localStorage；"light" | "dark"，缺省跟随系统） */
const THEME_STORAGE_KEY = "dcx-theme";

/** 引擎状态（壳 IPC engine_status，与 DesktopStatusBar 对齐） */
interface EngineStatus {
  state: string;
  port: number | null;
  restarts: number;
}

/** 状态点样式 */
function dotClass(state: string | undefined): string {
  if (state === "ready") return "ok";
  if (state === "crashed" || state === "failed") return "err";
  return "wait";
}

/** 活动栏视图标识（侧边栏内嵌视图） */
export type ActivityView = "chats" | "ssh";

/** ActivityBar 组件属性 */
export interface ActivityBarProps {
  /** 当前侧边栏视图 */
  view: ActivityView;
  /** 切换侧边栏视图（重复点击当前视图 = 折叠/展开） */
  onViewChange: (view: ActivityView) => void;
  /** 侧边栏是否折叠（会话视图折叠态） */
  sidebarCollapsed: boolean;
  /** 文件抽屉是否打开（文件图标高亮） */
  fileDrawerOpen: boolean;
  /** 打开/关闭文件抽屉 */
  onToggleFiles: () => void;
  /** 设置抽屉是否打开（系统管理图标高亮） */
  settingsOpen: boolean;
  /** 打开系统管理抽屉 */
  onOpenSettings: () => void;
  /** 切换引擎状态面板（底部状态栏联动） */
  onToggleEnginePanel: () => void;
}

/** 左侧活动栏组件（桌面壳专用） */
export function ActivityBar({
  view,
  onViewChange,
  sidebarCollapsed,
  fileDrawerOpen,
  onToggleFiles,
  settingsOpen,
  onOpenSettings,
  onToggleEnginePanel,
}: ActivityBarProps) {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  const [engineState, setEngineState] = useState<string | undefined>(undefined);
  // 主题偏好：初始取 localStorage，缺省跟随系统（matchMedia）
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  // 主题应用：写到 <html data-theme>，CSS 变量在该属性下强制覆盖
  // prefers-color-scheme（styles.css 尾部的 :root[data-theme=...] 两块）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = (): void => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // 引擎状态轮询（2s，与 DesktopStatusBar 同节奏；仅驱动底部引擎图标状态点）
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const poll = (): void => {
      bridge
        .invoke<EngineStatus>("engine_status")
        .then((s) => {
          if (alive) setEngineState(s?.state);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bridge]);

  if (!bridge) return null;

  return (
    <nav className="activity-bar" aria-label="活动栏">
      <button
        type="button"
        className={"activity-item" + (view === "chats" && !sidebarCollapsed ? " active" : "")}
        title="会话"
        aria-label="会话"
        onClick={() => onViewChange("chats")}
      >
        <ChatIcon size={20} />
      </button>
      <button
        type="button"
        className={"activity-item" + (fileDrawerOpen ? " active" : "")}
        title="文件"
        aria-label="文件"
        onClick={onToggleFiles}
      >
        <FolderIcon size={20} />
      </button>
      <button
        type="button"
        className={"activity-item" + (view === "ssh" ? " active" : "")}
        title="远程 SSH"
        aria-label="远程 SSH"
        onClick={() => onViewChange("ssh")}
      >
        <RemoteIcon size={20} />
      </button>
      <span className="activity-bar-spacer" />
      <button
        type="button"
        className="activity-item"
        title={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
        aria-label="主题切换"
        onClick={toggleTheme}
      >
        {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
      </button>
      <button
        type="button"
        className={"activity-item" + (settingsOpen ? " active" : "")}
        title="系统管理"
        aria-label="系统管理"
        onClick={onOpenSettings}
      >
        <GearIcon size={20} />
      </button>
      <button
        type="button"
        className="activity-item"
        title="引擎状态（状态/重启/日志面板）"
        aria-label="引擎状态"
        onClick={onToggleEnginePanel}
      >
        <span className={`activity-dot ${dotClass(engineState)}`} />
        <EngineIcon size={20} />
      </button>
    </nav>
  );
}
