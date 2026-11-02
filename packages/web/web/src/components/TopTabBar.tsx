/**
 * 顶部标签页栏（Trae 风格 Shell 重构，DESKTOP-PRD FR-4.1 多窗口形态的 M1 落位）。
 *
 * 仅在 DeepCode Desktop WebView 内由 App 渲染（纯浏览器零渲染，Web 零回归）。
 * 结构：macOS 红黄绿交通灯预留区（padding）+ 透明拖拽层垫底
 * （data-tauri-drag-region + window_drag 双通道，自 DesktopStatusBar 迁入，
 * 实现整条顶栏可拖动）。
 *
 * 注：多会话标签、左上角 Logo、新建按钮、authority 徽标与新窗口按钮均已按
 * 产品要求移除（会话管理统一走左侧栏，引擎状态走底部状态栏）。
 */
import { useState } from "react";
import { getDesktopBridge, type DesktopBridge } from "../desktop-bridge";

/** 运行平台是否为 macOS（顶栏左侧为交通灯预留空间） */
function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

/** 顶部标签页栏组件（桌面壳专用） */
export function TopTabBar() {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  if (!bridge) return null;

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
    </div>
  );
}
