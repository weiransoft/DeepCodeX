/**
 * 顶部标签页栏（Trae 风格 Shell 重构，DESKTOP-PRD FR-4.1 多窗口形态的 M1 落位）。
 *
 * 仅在 DeepCode Desktop WebView 内由 App 渲染（纯浏览器零渲染，Web 零回归）。
 * 结构（左 → 右）：
 * - macOS 红黄绿交通灯预留区（padding）；
 * - 透明拖拽层垫底（data-tauri-drag-region + window_drag 双通道，自 DesktopStatusBar 迁入，
 *   实现整条顶栏可拖动而按钮仍可点击）；
 * - 右侧：authority 徽标（「本地」/ ssh://user@host，M2 由 SSH 面板联动）+ 新窗口按钮。
 *
 * 注：多会话标签、左上角 Logo 与新建按钮已按产品要求移除（会话管理统一走
 * 左侧栏）。Tauri v2 的 data-tauri-drag-region 仅作用于元素本身、不向下传递，
 * 因此沿用「独立空拖拽层承载 + 内容层 pointer-events:none + 按钮 auto」方案。
 */
import { useState } from "react";
import { getDesktopBridge, type DesktopBridge } from "../desktop-bridge";
import { PlusIcon } from "./icons";

/** 运行平台是否为 macOS（顶栏左侧为交通灯预留空间） */
function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

/** TopTabBar 组件属性 */
export interface TopTabBarProps {
  /** authority（null/undefined = 本地） */
  authority?: string | null;
  /** 顶层轻提示（新窗口等失败提示） */
  onNotice?: (message: string) => void;
}

/** 顶部标签页栏组件（桌面壳专用） */
export function TopTabBar({ authority, onNotice }: TopTabBarProps) {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  if (!bridge) return null;

  const openNewWindow = (): void => {
    bridge.invoke("window_new").catch(() => onNotice?.("多窗口将在后续版本提供（M2）"));
  };

  return (
    <div className={"top-tab-bar" + (isMacOS() ? " macos" : "")}>
      {/* 透明拖拽层：垫底，点击即触发窗口拖动（双通道同旧状态条） */}
      <div
        className="top-tab-bar-drag"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          void bridge.invoke("window_drag").catch(() => {});
        }}
      />
      <div className="top-tab-bar-right">
        <span className={"authority-badge" + (authority != null ? " remote" : "")}>
          {authority != null ? authority : "本地"}
        </span>
        <button type="button" className="top-tab-win" title="新建窗口" onClick={openNewWindow}>
          <PlusIcon size={13} />
          <span>窗口</span>
        </button>
      </div>
    </div>
  );
}
