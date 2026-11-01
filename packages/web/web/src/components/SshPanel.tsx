/**
 * 侧边栏「远程 SSH」视图（Trae 风格 Shell 重构 + DESKTOP-PRD FR-2.1~2.7）。
 *
 * 数据面由壳侧 SSH 子系统承载（desktop/src-tauri/src/ssh/）：目标列表 / 导入 /
 * 连接分别对应 `ssh_list_targets` / `ssh_import_config` / `ssh_connect`，
 * 连接期间轮询 `ssh_status` 推进四阶段，断开走 `ssh_disconnect`。
 *
 * 闭环：连接成功后**壳把窗口导航到隧道端口**（远端引擎自带 Web UI），
 * 本组件随页面卸载；断开时壳再导航回本地引擎。因此这里不代理远端 API，
 * 只负责发起连接与展示阶段。
 *
 * 降级仍在：桥不存在（纯浏览器）→ 整个视图不挂载（App 控制）；
 * 壳未注册命令 → 列表区提示能力未就绪；ACL 未授权 → 以告警样式明示
 * 配置缺陷（见 classifySshProbeFailure）。
 * - 桥不存在（纯浏览器）→ 整个视图不挂载（App 控制）；
 * - IPC 命令未注册（M1 壳）→ 列表区展示「M2 能力未就绪」引导，表单可填写、
 *   提交时明确提示等待壳更新，绝不静默失败；
 * - M2 壳就绪后无需改 UI：invoke 即接通（事件监听见 connect() 内注释）。
 *
 * 错误分类（2026-11-01 补）：探测失败**不能一律说成「M2 未就绪」**。
 * Tauri 2 中「命令未注册」与「ACL 未授权」是两类完全不同的原因——
 * 后者是壳的权限配置缺陷（正是 `config_save not allowed by ACL` 那类事故），
 * 若被误报成「请更新客户端」，真实故障就会被掩盖。分类逻辑见
 * classifySshProbeFailure。
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

/** 桥探测失败分类 */
export type SshProbeFailureKind =
  /** 命令未注册——壳版本尚无 M2 能力，属预期内降级 */
  | "absent"
  /** 命令已注册但 ACL 未授权——壳权限配置缺陷，必须当故障暴露 */
  | "denied"
  /** 其它真实错误（桥异常、序列化失败等） */
  | "error";

/** 一次探测失败的结构化描述 */
export interface SshProbeFailure {
  kind: SshProbeFailureKind;
  /** 原始错误文本，供诊断展示 */
  detail: string;
}

/**
 * 归类桌面桥调用失败。
 *
 * 本地 origin 调用自有命令默认放行，因此这两类错误只在打包后的引擎页
 * （remote origin）出现，本地开发根本测不到——只能靠 message 判别：
 * - `Command ssh_list_targets not found`          → 壳未注册该命令（M2 未实现）
 * - `Command ssh_list_targets not allowed by ACL` → 壳已注册但 ACL 未授权（配置缺陷）
 *
 * 顺序敏感：ACL 文案不含 `not found`，但仍先判 ACL，避免大小写/文案变体漏判。
 */
export function classifySshProbeFailure(err: unknown): SshProbeFailure {
  const detail = errorText(err, "未知错误（无错误信息）");
  if (/not allowed by acl/i.test(detail)) return { kind: "denied", detail };
  if (/not found|unknown command|no command/i.test(detail)) return { kind: "absent", detail };
  return { kind: "error", detail };
}

/**
 * 提取可读错误文本。
 *
 * Tauri 命令失败时 reject 的不一定是 `Error`：`ShellError` 序列化为
 * `{ kind, message }`，ACL 拒绝/命令缺失则是裸字符串。三者都要能取到 message，
 * 否则用户只会看到兜底的"连接失败"，把真正原因（如 ssh 的认证失败）丢掉。
 */
export function errorText(err: unknown, fallback = "操作失败"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string" && msg !== "") return msg;
  }
  return fallback;
}

/** `ssh_status` 返回的会话快照（与 Rust `SessionStatus` 对齐） */
interface SshStatus {
  state: "idle" | "connecting" | "ready";
  phase?: number;
  message?: string;
  authority?: string;
  localPort?: number;
  targetId?: string;
}

/** `ssh_connect` 返回（不含任何口令——口令只留在壳内存） */
interface SshConnectResult {
  authority: string;
  localPort: number;
  remoteOs: string;
  remoteArch: string;
  remoteUsername: string;
  targetId: string;
}

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
  /** 探测失败的结构化原因（成功时为 null） */
  const [probeFailure, setProbeFailure] = useState<SshProbeFailure | null>(null);
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
      setProbeFailure(null);
      setCapabilityReady(true);
    } catch (e: unknown) {
      const failure = classifySshProbeFailure(e);
      setProbeFailure(failure);
      setCapabilityReady(false);
      setTargets(null);
      // ACL 未授权 ≠ 版本落后：这是壳的权限配置缺陷，必须留痕，不能被降级文案掩盖
      if (failure.kind === "denied") {
        console.error(
          `[ssh] 桌面桥拒绝 ssh_list_targets：${failure.detail}。` +
            "请在 desktop/src-tauri/permissions/app-ipc.toml 的 commands.allow 中补入 " +
            "ssh_list_targets / ssh_import_config / ssh_connect / ssh_disconnect 并重建客户端。"
        );
      }
    }
  }, [bridge]);

  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);

  // 恢复会话状态：页面刷新、或从远端导航回本地后，以壳侧状态为准
  useEffect(() => {
    if (!bridge) return;
    bridge
      .invoke<SshStatus>("ssh_status")
      .then((st) => {
        if (st.state === "ready") {
          setPhase(CONNECT_PHASES.length);
          onAuthorityChange?.(st.authority ?? null);
        }
      })
      .catch(() => {
        /* 状态不可用不阻断面板：连接时会有明确报错 */
      });
  }, [bridge, onAuthorityChange]);

  /** 按探测失败原因给出准确提示（不得把配置缺陷说成"请更新客户端"） */
  const probeHint = (): string => {
    if (probeFailure?.kind === "denied") {
      return (
        `桌面桥权限配置缺失：${probeFailure.detail}。` +
        "这是壳的 ACL 白名单未包含 ssh_* 命令导致，请联系维护者补齐后重建客户端（不是升级客户端能解决的）。"
      );
    }
    if (probeFailure?.kind === "error") {
      return `SSH 能力探测失败：${probeFailure.detail}`;
    }
    return "SSH 连接能力由桌面壳 M2 提供：请更新 DeepCode Desktop 后重试。";
  };

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

  /** 连接期间轮询会话状态以推进四阶段（壳侧把进度写入 ssh_status） */
  const startProgressPolling = (): (() => void) => {
    if (!bridge) return () => {};
    const timer = window.setInterval(() => {
      bridge
        .invoke<SshStatus>("ssh_status")
        .then((st) => {
          if (st.state === "connecting" && typeof st.phase === "number") setPhase(st.phase);
        })
        .catch(() => {
          /* 轮询失败不打断连接：真正的失败由 ssh_connect 的 Promise 返回 */
        });
    }, 400);
    return () => window.clearInterval(timer);
  };

  /** 发起连接（表单与已保存目标共用同一条路径） */
  const doConnect = async (payload: Record<string, unknown>, label: string): Promise<void> => {
    if (!bridge) {
      setFormError("桌面桥不可用：请在 DeepCode Desktop 中打开本页面");
      return;
    }
    if (capabilityReady !== true) {
      setFormError(probeHint());
      return;
    }
    setFormError("");
    setPhase(0);
    const stopPolling = startProgressPolling();
    try {
      const res = await bridge.invoke<SshConnectResult>("ssh_connect", payload);
      setPhase(CONNECT_PHASES.length);
      onAuthorityChange?.(res?.authority ?? label);
      const env = [res?.remoteOs, res?.remoteArch].filter(Boolean).join(" ");
      onNotice?.(env !== "" ? `已连接远端（${env}）` : "已连接远端");
      // 壳随后把窗口导航到远端引擎，本组件即将卸载
    } catch (e: unknown) {
      setPhase(-1);
      setFormError(errorText(e, "连接失败"));
    } finally {
      stopPolling();
    }
  };

  /** 表单提交：新建连接 */
  const connect = (): void => {
    const err = validate();
    if (err !== "") {
      setFormError(err);
      return;
    }
    void doConnect(
      {
        name: form.name || `${form.username}@${form.host}`,
        host: form.host,
        port: Number(form.port),
        username: form.username,
        authMethod: form.authMethod,
        // FR-2.2：密码仅随本次调用进 Rust 层，前端不留存
        password: form.authMethod === "password" ? form.password : undefined,
        installMode: form.installMode,
      },
      `ssh://${form.username}@${form.host}`
    );
  };

  /**
   * 连接已保存目标。
   *
   * 密码认证的目标必须回到表单输入口令（口令不落盘，无法从存储取回）；
   * 其余直接以 targetId 连接，由壳侧从存储读取 IdentityFile / ProxyJump——
   * 这是导入 ~/.ssh/config 之后能"一键连接"的关键路径。
   */
  const connectSaved = (t: SshTarget): void => {
    if (t.authMethod === "password") {
      setForm({
        name: t.name,
        host: t.host,
        port: String(t.port),
        username: t.username,
        authMethod: "password",
        password: "",
        installMode: "auto",
      });
      setFormOpen(true);
      onNotice?.("该目标使用密码认证：请填写密码后连接（口令不保存）");
      return;
    }
    void doConnect({ targetId: t.id }, `ssh://${t.username}@${t.host}`);
  };

  /** 移除已保存目标（不触碰远端任何内容） */
  const removeTarget = (t: SshTarget): void => {
    if (!bridge) return;
    bridge
      .invoke<SshTarget[]>("ssh_remove_target", { id: t.id })
      .then((list) => {
        if (Array.isArray(list)) setTargets(list);
        onNotice?.(`已移除目标 ${t.name}`);
      })
      .catch((e: unknown) => onNotice?.(errorText(e, "移除失败")));
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
        onNotice?.(errorText(e, "断开失败"));
      });
  };

  const importSshConfig = (): void => {
    if (!bridge) return;
    if (capabilityReady !== true) {
      onNotice?.(probeHint());
      return;
    }
    bridge
      .invoke<{ imported: number; targets: SshTarget[] }>("ssh_import_config")
      .then((res) => {
        if (Array.isArray(res?.targets)) setTargets(res.targets);
        onNotice?.((res?.imported ?? 0) > 0 ? `已导入 ${res.imported} 个连接目标` : "没有新增目标（均已存在）");
        void refreshTargets();
      })
      .catch((e: unknown) => {
        onNotice?.(errorText(e, "导入失败"));
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
        <div className={"ssh-m2-hint" + (probeFailure && probeFailure.kind !== "absent" ? " ssh-m2-hint-danger" : "")}>
          {probeFailure?.kind === "denied" ? (
            <>
              桌面桥权限配置缺失，SSH 面板不可用。
              <br />
              原因：{probeFailure.detail}
              <br />
              这不是客户端版本问题——壳的 ACL 白名单（
              <code>permissions/app-ipc.toml</code> 的 <code>commands.allow</code>）未包含 <code>ssh_*</code>{" "}
              命令，需补齐后重建客户端。
            </>
          ) : probeFailure?.kind === "error" ? (
            <>SSH 能力探测失败：{probeFailure.detail}</>
          ) : (
            <>
              SSH 远程连接由桌面壳 M2 扩展提供（探测环境 → 部署 Server → 隧道 → 就绪）。
              当前壳版本尚未内置，可先在下方填写并保存连接参数，升级后即可一键连接。
            </>
          )}
        </div>
      )}
      {capabilityReady === true && targets !== null && targets.length === 0 && (
        <div className="ssh-empty">暂无已保存目标，点击下方「＋ 新建连接」或导入 ~/.ssh/config。</div>
      )}
      {targets !== null &&
        targets.map((t) => (
          <div
            key={t.id}
            className="ssh-target"
            role="button"
            tabIndex={0}
            title={`连接到 ${t.name}`}
            onClick={() => connectSaved(t)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                connectSaved(t);
              }
            }}
          >
            <div className="ssh-target-head">
              <span className="ssh-target-name">{t.name}</span>
              {t.authMethod === "password" ? (
                <span className="ssh-target-badge">密码</span>
              ) : t.authMethod === "keyfile" ? (
                <span className="ssh-target-badge">密钥</span>
              ) : null}
              <button
                type="button"
                className="ssh-target-del"
                title={`移除目标 ${t.name}`}
                onClick={(e) => {
                  // 阻止冒泡：否则会连带触发外层的"连接该目标"
                  e.stopPropagation();
                  removeTarget(t);
                }}
              >
                ×
              </button>
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
