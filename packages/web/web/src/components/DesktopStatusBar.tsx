/**
 * 桌面底部状态栏（Trae 风格 Shell 重构：拖拽职责移交 TopTabBar 顶栏）。
 *
 * 仅在检测到 window.__DEEPCODE_DESKTOP__ 桥时由 App 渲染；
 * 纯浏览器访问零渲染（Web 独立可用零回归）。
 * 布局：左 = 引擎状态点 + 文案 + 端口；右 = authority 徽标 / LDAP 指示 / 设置 / 引擎面板。
 * 引擎状态面板（状态/重启/日志）改为锚定右下角弹出（原顶栏右侧）。
 */
import { useCallback, useEffect, useState } from "react";
import { getDesktopBridge, type DesktopBridge } from "../desktop-bridge";

/** 壳 IPC engine_status 返回结构（与 desktop/src-tauri engine::manager::EngineStatus 对齐，camelCase） */
interface EngineStatus {
  state: string;
  port: number | null;
  pid: number | null;
  program: string;
  logPath: string;
  restarts: number;
}

/** 引擎状态 → 用户可读文案 */
const STATE_LABEL: Record<string, string> = {
  stopped: "本地引擎 · 已停止",
  starting: "本地引擎 · 启动中",
  ready: "本地引擎 · 运行中",
  crashed: "本地引擎 · 异常（自动重启中）",
  failed: "本地引擎 · 启动失败",
};

/** 状态点样式：ok=运行中 / err=异常 / wait=过渡态 */
function dotClass(state: string | undefined): string {
  if (state === "ready") return "ok";
  if (state === "crashed" || state === "failed") return "err";
  return "wait";
}

/** 状态栏组件（App 仅在桌面桥存在时挂载；引擎面板为受控开关，活动栏引擎图标亦可切换） */
export function DesktopStatusBar({
  onOpenSettings,
  ldapEnabled,
  authority,
  panelOpen,
  onTogglePanel,
}: {
  /** 打开系统管理（模型 / MCP / LDAP 配置） */
  onOpenSettings?: () => void;
  /** LDAP 是否已启用（null = 配置未就绪，不渲染指示） */
  ldapEnabled?: boolean | null;
  /** 当前 authority（null = 本地引擎；非空 = ssh://… 远程） */
  authority?: string | null;
  /** 引擎状态面板是否展开（受控，由 App 持有；活动栏引擎图标可联动） */
  panelOpen: boolean;
  /** 切换引擎状态面板 */
  onTogglePanel: () => void;
}) {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.invoke<EngineStatus>("engine_status"));
    } catch {
      // IPC 暂不可用：保持占位，下一轮轮询重试
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const restart = useCallback(async () => {
    if (!bridge) return;
    setBusy(true);
    try {
      setStatus(await bridge.invoke<EngineStatus>("engine_restart"));
    } catch {
      // 失败保持现状，下一轮轮询以壳侧状态为准
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const openLogs = useCallback(async () => {
    if (!bridge) return;
    try {
      await bridge.invoke("engine_open_logs");
    } catch {
      // 打开失败静默（无系统文件管理器的环境）
    }
  }, [bridge]);

  if (!bridge) return null;
  return (
    <>
      <div className="desktop-statusbar">
        <span className="desktop-statusbar-left">
          <span className={`desktop-dot ${dotClass(status?.state)}`} />
          <span>{status ? (STATE_LABEL[status.state] ?? status.state) : "本地引擎"}</span>
          {status?.port != null && <span className="desktop-statusbar-port">127.0.0.1:{status.port}</span>}
        </span>
        <span className="desktop-statusbar-right">
          {authority != null && <span className="desktop-statusbar-authority">{authority}</span>}
          {ldapEnabled != null && (
            <span className={"desktop-statusbar-ldap" + (ldapEnabled ? " on" : "")}>
              LDAP{ldapEnabled ? " · 开" : " · 关"}
            </span>
          )}
          {onOpenSettings && (
            <button type="button" onClick={() => onOpenSettings()}>
              设置
            </button>
          )}
          <button type="button" onClick={onTogglePanel}>
            引擎状态
          </button>
        </span>
      </div>
      {panelOpen && (
        <div className="desktop-status-panel">
          <div className="desktop-status-row">
            <span>状态</span>
            <span>{status?.state ?? "unknown"}</span>
          </div>
          <div className="desktop-status-row">
            <span>地址</span>
            <span>{status?.port != null ? `http://127.0.0.1:${status.port}` : "—"}</span>
          </div>
          <div className="desktop-status-row">
            <span>PID</span>
            <span>{status?.pid ?? "—"}</span>
          </div>
          <div className="desktop-status-row">
            <span>自动重启</span>
            <span>{status?.restarts ?? 0} 次</span>
          </div>
          <div className="desktop-status-actions">
            <button type="button" disabled={busy} onClick={() => void restart()}>
              {busy ? "重启中…" : "重启引擎"}
            </button>
            <button type="button" onClick={() => void openLogs()}>
              打开日志
            </button>
          </div>
        </div>
      )}
    </>
  );
}
