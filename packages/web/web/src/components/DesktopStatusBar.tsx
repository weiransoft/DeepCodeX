/**
 * 桌面 authority 状态条（M1 占位，DESKTOP-ARCH-DESKTOP-001 §3.6）。
 *
 * 仅在检测到 window.__DEEPCODE_DESKTOP__ 桥时由 App 渲染；
 * 纯浏览器访问零渲染（Web 独立可用零回归）。
 * M1 仅显示本地引擎状态 + 引擎状态面板（状态/重启/日志）；
 * SSH 远程 authority 指示与连接管理在 M2 扩展。
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

/** 状态条组件（App 仅在桌面桥存在时挂载） */
export function DesktopStatusBar() {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
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
    <div className="desktop-statusbar">
      <span className="desktop-statusbar-left">
        <span className={`desktop-dot ${dotClass(status?.state)}`} />
        <span>{status ? (STATE_LABEL[status.state] ?? status.state) : "本地引擎"}</span>
        {status?.port != null && <span className="desktop-statusbar-port">127.0.0.1:{status.port}</span>}
      </span>
      <span className="desktop-statusbar-right">
        <button type="button" onClick={() => setPanelOpen((v) => !v)}>
          引擎状态
        </button>
      </span>
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
    </div>
  );
}
