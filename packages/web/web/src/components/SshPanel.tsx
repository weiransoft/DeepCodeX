/**
 * 侧边栏「远程 SSH」视图（Trae 风格 Shell 重构 + DESKTOP-PRD FR-2.1~2.7）。
 *
 * 数据面属壳 M2 扩展（M1-NOTES §4b）：目标列表 / 导入 / 连接分别对应壳 IPC
 * `ssh_list_targets` / `ssh_import_config` / `ssh_connect` / `ssh_progress_events`，
 * 当前壳仅注册 M1 命令（engine_* / config_* / window_drag / boot_diag）。
 * 故本面板做**桥守卫优雅降级**：
 * - 桥不存在（纯浏览器）→ 整个视图不挂载（App 控制）；
 * - IPC 命令未注册（M1 壳）→ 列表区展示「M2 能力未就绪」引导，表单可填写、
 *   提交时明确提示等待壳更新，绝不静默失败；
 * - M2 壳就绪后无需改 UI：invoke 即接通（事件监听见 connect() 内注释）。
 *
 * 安全对齐（FR-2.2）：认证方式默认「系统 ssh agent 密钥」；密码仅存组件内存、
 * 仅随单次 ssh_connect 提交，绝不写配置文件/密钥库以外路径。
 */
import { useCallback, useEffect, useState } from "react";
import { getDesktopBridge, type DesktopBridge } from "../desktop-bridge";
import { RefreshIcon, RemoteIcon } from "./icons";

/** SSH 目标（与 PRD FR-2.2 对齐，camelCase；M2 壳注册后即生效） */
interface SshTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 密码认证的目标仅显示标记，口令本身永不回传前端 */
  authMethod: "agent" | "password" | "keyfile";
}

/** 连接四阶段（FR-2.3 探测 → 部署 → 隧道 → 就绪） */
const CONNECT_PHASES = ["探测远端环境", "部署远端 Server", "建立 SSH 隧道", "就绪"] as const;

/** 新建连接表单状态 */
interface ConnectForm {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: "agent" | "password";
  password: string;
  installMode: "auto" | "upload";
}

const EMPTY_FORM: ConnectForm = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  authMethod: "agent",
  password: "",
  installMode: "auto",
};

/** SshPanel 组件属性 */
export interface SshPanelProps {
  /** 当前会话工作区根（本地工作区卡片展示；空 = 无活跃会话） */
  projectRoot: string;
  /** authority 变化上报（连接成功置 ssh://…，断开置 null；M2 生效） */
  onAuthorityChange?: (authority: string | null) => void;
  /** 顶层轻提示 */
  onNotice?: (message: string) => void;
}

/** SSH 远程侧边栏视图（桌面壳专用；纯浏览器由 App 不挂载） */
export function SshPanel({ projectRoot, onAuthorityChange, onNotice }: SshPanelProps) {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  /** 目标列表；null = 尚未探测（M1 壳命令未注册时保持 null） */
  const [targets, setTargets] = useState<SshTarget[] | null>(null);
  /** M2 能力是否可用（ssh_list_targets 探测结果） */
  const [capabilityReady, setCapabilityReady] = useState<boolean | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ConnectForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  /** 连接中阶段索引（-1 = 未连接；M2 生效） */
  const [phase, setPhase] = useState(-1);

  // 目标列表探测：命令未注册（M1 壳）时 invoke 会被 Tauri 拒绝 → capabilityReady=false
  const refreshTargets = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    try {
      const list = await bridge.invoke<SshTarget[]>("ssh_list_targets");
      setTargets(Array.isArray(list) ? list : []);
      setCapabilityReady(true);
    } catch {
      setCapabilityReady(false);
      setTargets(null);
    }
  }, [bridge]);

  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);

  const setField = <K extends keyof ConnectForm>(key: K, value: ConnectForm[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormError("");
  };

  /** 表单校验（FR-2.2 最小必填：host/username；端口 1-65535） */
  const validate = (): string => {
    if (form.host.trim() === "") return "请填写主机地址";
    if (form.username.trim() === "") return "请填写用户名";
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口需为 1-65535";
    if (form.authMethod === "password" && form.password === "") return "密码认证需填写密码（仅本次会话使用，不落盘）";
    return "";
  };

  /** 测试并连接：M2 壳就绪后经 ssh_connect + ssh_progress_events 推进四阶段 */
  const connect = (): void => {
    const err = validate();
    if (err !== "") {
      setFormError(err);
      return;
    }
    if (!bridge || capabilityReady !== true) {
      setFormError("SSH 连接能力由桌面壳 M2 提供：请更新 DeepCode Desktop 后重试。");
      return;
    }
    // M2 事件通道：ssh_progress_events 推送 { phase: 0..3, message }，成功即上报 authority
    setPhase(0);
    bridge
      .invoke<{ authority: string }>("ssh_connect", {
        name: form.name || `${form.username}@${form.host}`,
        host: form.host,
        port: Number(form.port),
        username: form.username,
        authMethod: form.authMethod,
        // FR-2.2：密码仅随本次调用进 Rust 层，前端不留存
        password: form.authMethod === "password" ? form.password : undefined,
        installMode: form.installMode,
      })
      .then((res) => {
        setPhase(CONNECT_PHASES.length);
        onAuthorityChange?.(res?.authority ?? `ssh://${form.username}@${form.host}`);
        onNotice?.("已连接远程引擎");
      })
      .catch((e: unknown) => {
        setPhase(-1);
        setFormError(e instanceof Error ? e.message : "连接失败");
      });
  };

  const disconnect = (): void => {
    if (!bridge) return;
    bridge
      .invoke("ssh_disconnect")
      .then(() => {
        setPhase(-1);
        onAuthorityChange?.(null);
        onNotice?.("已断开远程，回到本地工作区");
      })
      .catch((e: unknown) => {
        onNotice?.(e instanceof Error ? e.message : "断开失败");
      });
  };

  const importSshConfig = (): void => {
    if (!bridge) return;
    if (capabilityReady !== true) {
      onNotice?.("导入 ~/.ssh/config 由桌面壳 M2 提供");
      return;
    }
    bridge
      .invoke<{ imported: number }>("ssh_import_config")
      .then((res) => {
        onNotice?.(`已导入 ${res?.imported ?? 0} 个连接目标`);
        void refreshTargets();
      })
      .catch((e: unknown) => {
        onNotice?.(e instanceof Error ? e.message : "导入失败");
      });
  };

  return (
    <aside className="sidebar ssh-panel">
      <div className="ssh-head">
        <RemoteIcon size={15} />
        <span>远程</span>
        <span className="ssh-head-spacer" />
        <button type="button" className="icon-btn" title="刷新目标列表" onClick={() => void refreshTargets()}>
          <RefreshIcon size={14} />
        </button>
      </div>

      {/* 本地工作区（当前） */}
      <div className="ssh-local">
        <div className="ssh-section-title">本地工作区（当前）</div>
        <div className="ssh-local-path" title={projectRoot || "无活跃会话工作区"}>
          {projectRoot !== "" ? projectRoot : "（无活跃会话工作区）"}
        </div>
      </div>

      {/* 已保存目标 */}
      <div className="ssh-section-title">
        已保存目标
        <span className="ssh-section-spacer" />
        <button type="button" className="ssh-link-btn" onClick={importSshConfig}>
          导入 ~/.ssh/config
        </button>
      </div>
      {capabilityReady === false && (
        <div className="ssh-m2-hint">
          SSH 远程连接由桌面壳 M2 扩展提供（探测环境 → 部署 Server → 隧道 → 就绪）。
          当前壳版本尚未内置，可先在下方填写并保存连接参数，升级后即可一键连接。
        </div>
      )}
      {capabilityReady === true && targets !== null && targets.length === 0 && (
        <div className="ssh-empty">暂无已保存目标，点击下方「＋ 新建连接」或导入 ~/.ssh/config。</div>
      )}
      {targets !== null &&
        targets.map((t) => (
          <div key={t.id} className="ssh-target">
            <div className="ssh-target-head">
              <span className="ssh-target-name">{t.name}</span>
              {t.authMethod === "password" && <span className="ssh-target-badge">密码</span>}
            </div>
            <div className="ssh-target-addr">
              ssh://{t.username}@{t.host}
              {t.port !== 22 ? `:${t.port}` : ""}
            </div>
          </div>
        ))}

      {/* 新建连接表单 */}
      {!formOpen ? (
        <button type="button" className="ssh-new-btn" onClick={() => setFormOpen(true)}>
          ＋ 新建连接
        </button>
      ) : (
        <div className="ssh-form">
          <div className="ssh-form-title">新建连接</div>
          <label className="ssh-field">
            <span>名称（可选）</span>
            <input value={form.name} placeholder="如：内网构建机" onChange={(e) => setField("name", e.target.value)} />
          </label>
          <label className="ssh-field">
            <span>主机 *</span>
            <input
              value={form.host}
              placeholder="host.example.com 或 IP"
              onChange={(e) => setField("host", e.target.value)}
            />
          </label>
          <div className="ssh-field-row">
            <label className="ssh-field">
              <span>端口</span>
              <input value={form.port} inputMode="numeric" onChange={(e) => setField("port", e.target.value)} />
            </label>
            <label className="ssh-field">
              <span>用户名 *</span>
              <input value={form.username} onChange={(e) => setField("username", e.target.value)} />
            </label>
          </div>
          <label className="ssh-field">
            <span>认证方式</span>
            <select
              value={form.authMethod}
              onChange={(e) => setField("authMethod", e.target.value as ConnectForm["authMethod"])}
            >
              <option value="agent">系统 ssh agent（密钥，推荐）</option>
              <option value="password">密码（仅本次会话，不持久化）</option>
            </select>
          </label>
          {form.authMethod === "password" && (
            <label className="ssh-field">
              <span>密码</span>
              <input
                type="password"
                value={form.password}
                autoComplete="off"
                onChange={(e) => setField("password", e.target.value)}
              />
            </label>
          )}
          <label className="ssh-field">
            <span>远端 Server 安装</span>
            <select
              value={form.installMode}
              onChange={(e) => setField("installMode", e.target.value as ConnectForm["installMode"])}
            >
              <option value="auto">自动下载（需外网）</option>
              <option value="upload">本地上传（内网环境）</option>
            </select>
          </label>
          {formError !== "" && <div className="ssh-form-error">{formError}</div>}
          {/* 连接四阶段进度（M2 生效；phase -1 隐藏，0..2 进行中，3+ 完成） */}
          {phase >= 0 && (
            <div className="ssh-phases">
              {CONNECT_PHASES.map((label, i) => (
                <div key={label} className={"ssh-phase" + (phase > i ? " done" : phase === i ? " active" : "")}>
                  <span className="ssh-phase-dot" />
                  {label}
                </div>
              ))}
            </div>
          )}
          <div className="ssh-form-actions">
            <button type="button" className="ssh-btn-ghost" onClick={() => setFormOpen(false)}>
              取消
            </button>
            {phase >= 0 && phase < CONNECT_PHASES.length ? (
              <button type="button" className="ssh-btn-ghost" onClick={disconnect}>
                断开
              </button>
            ) : (
              <button type="button" className="ssh-btn-primary" onClick={connect}>
                测试并连接
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
