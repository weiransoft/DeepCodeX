//! SSH 连接生命周期状态机（ARCH §3.3）。
//!
//! ```text
//! Idle → Probing → Starting(远端引擎) → Tunneling → Ready
//!                        ↓ 失败                       ↓ 隧道进程退出
//!                      Failed ←──── 清理（远端进程 + 临时目录 + askpass）
//! ```
//!
//! 每个阶段失败都必须**回滚已创建的资源**：远端已拉起的引擎要 kill，
//! 远端临时目录要删，askpass 脚本要删——否则会在目标机上留下一堆孤儿
//! 进程与临时文件，而用户看到的只是一次失败。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::ShellError;
use crate::ssh::exec;
use crate::ssh::probe::{self, RemoteEnv};
use crate::ssh::targets::{self, SshTarget, TargetStore};
use crate::ssh::tunnel::{self, RemoteEngine, REMOTE_USERNAME};

/// 阶段编号（与前端 `CONNECT_PHASES` 顺序一致）
pub mod phase {
    pub const PROBE: u8 = 0;
    pub const START: u8 = 1;
    pub const TUNNEL: u8 = 2;
    pub const READY: u8 = 3;
}

/// 状态常量（前端据 `state` 渲染）
pub mod state {
    pub const IDLE: &str = "idle";
    pub const CONNECTING: &str = "connecting";
    pub const READY: &str = "ready";
}

/// `ssh_connect` 入参（前端表单直传，camelCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    /// 已保存目标的 id：提供时以存储中的目标为准（保留 IdentityFile/ProxyJump），
    /// 表单其余连接字段被忽略；`password` 仍按本次传入。
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub name: String,
    /// 仅当未提供 `target_id` 时需要（提供时应忽略，故允许缺省）
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// `agent` | `password` | `keyfile`
    #[serde(default = "default_auth")]
    pub auth_method: String,
    /// SSH 认证口令（仅 password 方式；不落盘）
    #[serde(default)]
    pub password: Option<String>,
    /// `auto` | `upload`——本版本两条路径都要求远端已安装 CLI（自动部署未实现），
    /// 保留字段以兼容前端表单，并用于给出针对性提示。
    #[serde(default)]
    pub install_mode: String,
}

fn default_auth() -> String {
    "agent".into()
}

impl ConnectRequest {
    /// 转成可持久化的目标（去掉口令）
    fn to_target(&self) -> SshTarget {
        SshTarget::new(
            self.name.clone(),
            self.host.clone(),
            self.port,
            self.username.clone(),
            self.auth_method.clone(),
        )
    }
}

/// 连接成功后的对外结果（**不含任何口令**——口令只留在壳内存）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    /// 远端标识（前端状态栏展示）
    pub authority: String,
    /// 隧道本地端口（前端据此导航到远端引擎）
    pub local_port: u16,
    pub remote_os: String,
    pub remote_arch: String,
    /// 远端引擎登录用户名（壳内部自动登录用；不含口令）
    pub remote_username: String,
    pub target_id: String,
}

/// 会话状态快照（`ssh_status` 用；无活动会话且未在连接时 state=idle）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub state: String,
    /// 当前阶段（0..=3，仅 connecting 时存在）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<u8>,
    /// 阶段说明
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}

/// 活动会话（持有隧道子进程，drop/disconnect 时回收）
struct ActiveSession {
    target: SshTarget,
    local_port: u16,
    remote: RemoteEngine,
    tunnel: std::process::Child,
    askpass: Option<std::path::PathBuf>,
    authority: String,
}

impl ActiveSession {
    /// 隧道子进程是否仍存活
    fn tunnel_alive(&mut self) -> bool {
        matches!(self.tunnel.try_wait(), Ok(None))
    }
}

/// SSH 管理器（随 AppState 管理；全同步，阻塞调用由命令层放进 spawn_blocking）。
pub struct SshManager {
    store: TargetStore,
    session: Mutex<Option<ActiveSession>>,
    /// 连接进行中的阶段进度 `(phase, message)`，供 `ssh_status` 轮询。
    /// 选轮询而非 Tauri 事件：前端 Web 包不依赖 `@tauri-apps/api`，
    /// 经注入桥只能走 `invoke`；轮询同时让页面刷新后可恢复"连接中"视图。
    progress: Mutex<Option<(u8, String)>>,
}

impl SshManager {
    pub fn new(store: TargetStore) -> Self {
        Self {
            store,
            session: Mutex::new(None),
            progress: Mutex::new(None),
        }
    }

    /// 目标列表
    pub fn list_targets(&self) -> Result<Vec<SshTarget>, ShellError> {
        self.store.load()
    }

    /// 删除目标
    pub fn forget(&self, id: &str) -> Result<Vec<SshTarget>, ShellError> {
        self.store.remove(id)
    }

    /// 导入 `~/.ssh/config`，返回 `(最终列表, 新增数)`
    pub fn import_ssh_config(&self) -> Result<(Vec<SshTarget>, usize), ShellError> {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| ShellError::Config("无法确定用户主目录（HOME/USERPROFILE 均未设置）".into()))?;
        self.import_from_path(&std::path::Path::new(&home).join(".ssh").join("config"))
    }

    /// 从指定 config 路径导入（测试注入临时文件，避免改动进程级 HOME 污染并行用例）
    pub fn import_from_path(
        &self,
        config_path: &std::path::Path,
    ) -> Result<(Vec<SshTarget>, usize), ShellError> {
        let parsed = targets::load_ssh_config(config_path)?;
        if parsed.is_empty() {
            return Err(ShellError::Config(format!(
                "{} 中没有可导入的 Host（文件{}）",
                config_path.display(),
                if config_path.exists() {
                    "存在但无有效 Host 块"
                } else {
                    "不存在"
                }
            )));
        }
        self.store.merge(parsed)
    }

    /// 当前会话快照
    pub fn status(&self) -> SessionStatus {
        let (authority, local_port, target_id) = {
            let Ok(mut guard) = self.session.lock() else {
                return SessionStatus {
                    state: state::IDLE.into(),
                    phase: None,
                    message: None,
                    authority: None,
                    local_port: None,
                    target_id: None,
                };
            };
            let snapshot = guard.as_mut().and_then(|s| {
                if s.tunnel_alive() {
                    Some((
                        Some(s.authority.clone()),
                        Some(s.local_port),
                        Some(s.target.id.clone()),
                    ))
                } else {
                    None
                }
            });
            match snapshot {
                Some(v) => v,
                None => (None, None, None),
            }
        };

        if let Some(port) = local_port {
            return SessionStatus {
                state: state::READY.into(),
                phase: Some(phase::READY),
                message: Some("已连接".into()),
                authority,
                local_port: Some(port),
                target_id,
            };
        }

        // 无活动会话：可能正在连接中，也可能是空闲
        let progress = self.progress.lock().ok().and_then(|g| g.clone());
        match progress {
            Some((p, msg)) => SessionStatus {
                state: state::CONNECTING.into(),
                phase: Some(p),
                message: Some(msg),
                authority: None,
                local_port: None,
                target_id: None,
            },
            None => SessionStatus {
                state: state::IDLE.into(),
                phase: None,
                message: None,
                authority: None,
                local_port: None,
                target_id: None,
            },
        }
    }

    /// 活动隧道的登录凭据 `(local_port, username, password)`（`engine_credentials` 用）。
    pub fn tunnel_credentials(&self) -> Option<(u16, String, String)> {
        let guard = self.session.lock().ok()?;
        let session = guard.as_ref()?;
        Some((
            session.local_port,
            REMOTE_USERNAME.to_string(),
            session.remote.password.clone(),
        ))
    }

    /// 完整连接流程；`progress(phase, message)` 在每个阶段推进时回调。
    pub fn connect<F>(
        &self,
        req: &ConnectRequest,
        progress: F,
    ) -> Result<ConnectResult, ShellError>
    where
        F: Fn(u8, &str),
    {
        // 已有会话先干净断开（单会话模型：一台远程工作区）
        self.disconnect();
        // 无论成败都清掉"连接中"进度：否则失败后 ssh_status 会永远停在 connecting
        let result = self.connect_inner(req, &progress);
        if let Ok(mut guard) = self.progress.lock() {
            *guard = None;
        }
        result
    }

    /// 连接主体：阶段进度同时写入 `self.progress`（供轮询）并转发给回调。
    fn connect_inner<F>(
        &self,
        req: &ConnectRequest,
        progress: &F,
    ) -> Result<ConnectResult, ShellError>
    where
        F: Fn(u8, &str),
    {
        let report = |phase: u8, msg: &str| {
            if let Ok(mut guard) = self.progress.lock() {
                *guard = Some((phase, msg.to_string()));
            }
            progress(phase, msg);
        };

        // 目标来源：已保存目标（保留 IdentityFile/ProxyJump）优先于表单字段
        let target = match req.target_id.as_deref() {
            Some(id) => self
                .store
                .load()?
                .into_iter()
                .find(|t| t.id == id)
                .ok_or_else(|| ShellError::Ssh(format!("已保存的 SSH 目标不存在（id={id}），请刷新列表后重试")))?,
            None => req.to_target(),
        };
        let ssh_password = req.password.as_deref().filter(|p| !p.is_empty());
        // install_mode 目前不影响流程（两条路径都要求远端已预装 CLI），
        // 但记录到日志便于排查"为什么没有自动部署"的预期落差
        if req.install_mode == "upload" {
            log::info!("SSH 连接指定 install_mode=upload：本版本不含制品上传通道，改为校验远端已有 CLI");
        }

        // ── 阶段 0：探测远端环境 ──
        report(phase::PROBE, &format!("正在探测 {}…", target.display_addr()));
        let env: RemoteEnv = probe::probe(&target, ssh_password)?;
        env.ensure_runnable()?;
        report(phase::PROBE, &env.summary());

        // ── 阶段 1：拉起远端引擎（失败即回滚）──
        report(phase::START, "正在远端拉起 DeepCodeX 引擎…");
        let remote_port = tunnel::pick_free_port()?;
        let remote = match tunnel::start_remote_engine(&target, ssh_password, remote_port) {
            Ok(r) => r,
            Err(e) => {
                exec::cleanup_askpass(&target.id);
                return Err(e);
            }
        };

        // ── 阶段 2：建立本地隧道 ──
        report(
            phase::TUNNEL,
            &format!("正在建立 SSH 隧道（远端端口 {remote_port}）…"),
        );
        let local_port = tunnel::pick_free_port()?;
        let (mut tunnel_child, askpass) =
            match tunnel::open_tunnel(&target, ssh_password, local_port, remote_port) {
                Ok(v) => v,
                Err(e) => {
                    tunnel::stop_remote_engine(&target, ssh_password, &remote);
                    exec::cleanup_askpass(&target.id);
                    return Err(e);
                }
            };

        // ── 阶段 3：等待就绪（隧道通 + 引擎应答）──
        report(phase::READY, "正在等待远端引擎就绪…");
        let ready = tunnel::wait_ready(local_port, tunnel::READY_TIMEOUT, || {
            matches!(tunnel_child.try_wait(), Ok(None))
        });
        if let Err(e) = ready {
            // 诊断增强：转发被禁等隧道层原因只出现在 ssh stderr，必须单独提炼，
            // 否则用户会拿着"引擎无响应"去查引擎日志（实测极易误判方向）
            let tunnel_hint = tunnel::diagnose_tunnel_log(&tunnel::tunnel_log_path(&target.id));
            let tail = tunnel::remote_log_tail(&target, ssh_password, &remote.workdir);
            let _ = tunnel_child.kill();
            let _ = tunnel_child.wait();
            tunnel::stop_remote_engine(&target, ssh_password, &remote);
            exec::cleanup_askpass(&target.id);
            let mut detail = format!("{e}");
            if let Some(hint) = tunnel_hint {
                detail.push_str(&format!("\n提示：{hint}"));
            }
            if !tail.trim().is_empty() {
                detail.push_str(&format!("\n远端引擎日志（末 40 行）：\n{}", tail.trim()));
            }
            return Err(ShellError::Ssh(detail));
        }

        // 记录目标（下次可直接选），失败不影响本次连接
        let remembered = self.store.upsert(target.clone()).ok();

        let authority = target.display_addr();
        report(phase::READY, "已连接");

        let session = ActiveSession {
            target: target.clone(),
            local_port,
            remote,
            tunnel: tunnel_child,
            askpass,
            authority: authority.clone(),
        };
        if let Ok(mut guard) = self.session.lock() {
            *guard = Some(session);
        }
        let _ = remembered;

        Ok(ConnectResult {
            authority,
            local_port,
            remote_os: env.os,
            remote_arch: env.arch,
            remote_username: REMOTE_USERNAME.to_string(),
            target_id: target.id,
        })
    }

    /// 断开：kill 隧道 + 停远端引擎 + 清临时文件。幂等。
    pub fn disconnect(&self) {
        let Ok(mut guard) = self.session.lock() else {
            return;
        };
        let Some(mut session) = guard.take() else {
            return;
        };
        let _ = session.tunnel.kill();
        let _ = session.tunnel.wait();
        if let Some(path) = session.askpass.as_ref() {
            let _ = std::fs::remove_file(path);
        }
        exec::cleanup_askpass(&session.target.id);
        let _ = std::fs::remove_file(tunnel::tunnel_log_path(&session.target.id));
        // 远端清理需要重新握手（此时若 SSH 密码未留存，只能尽力而为）
        tunnel::stop_remote_engine(&session.target, None, &session.remote);
        log::info!(
            "已断开 SSH 会话：{}（远端端口 {}，本地端口 {}）",
            session.authority,
            session.remote.remote_port,
            session.local_port
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> (SshManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = TargetStore::new(dir.path().join("targets.json"));
        (SshManager::new(store), dir)
    }

    #[test]
    fn idle_status_when_no_session() {
        let (m, _d) = manager();
        let st = m.status();
        assert_eq!(st.state, state::IDLE);
        assert!(st.authority.is_none());
        assert!(m.tunnel_credentials().is_none());
    }

    #[test]
    fn disconnect_is_idempotent() {
        let (m, _d) = manager();
        m.disconnect();
        m.disconnect();
        assert_eq!(m.status().state, state::IDLE);
    }

    #[test]
    fn import_reports_missing_config_actionably() {
        // 注入不存在的路径：**不改进程级 HOME**（那会污染并行用例的路径派生）
        let (m, dir) = manager();
        let missing = dir.path().join(".ssh").join("config");
        let err = m.import_from_path(&missing).expect_err("无 config 必须报错");
        let msg = err.to_string();
        assert!(msg.contains("没有可导入的 Host"), "应说明原因：{msg}");
        assert!(msg.contains("不存在"), "应指出文件不存在：{msg}");
    }

    #[test]
    fn import_from_config_file_merges_targets() {
        let (m, dir) = manager();
        let cfg = dir.path().join("config");
        std::fs::write(
            &cfg,
            "Host build\n  HostName 10.0.0.11\n  User root\n  Port 2222\n",
        )
        .unwrap();
        let (list, added) = m.import_from_path(&cfg).expect("导入应成功");
        assert_eq!(added, 1);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].host, "10.0.0.11");
        assert_eq!(list[0].port, 2222);
        assert_eq!(list[0].username, "root");
        // 二次导入不重复
        let (_, added2) = m.import_from_path(&cfg).unwrap();
        assert_eq!(added2, 0);
    }

    #[test]
    fn request_derives_target_without_password() {
        let req = ConnectRequest {
            target_id: None,
            name: "b".into(),
            host: "10.0.0.9".into(),
            port: 22,
            username: "root".into(),
            auth_method: "password".into(),
            password: Some("secret".into()),
            install_mode: "auto".into(),
        };
        let t = req.to_target();
        // SshTarget 结构里没有口令字段——编译期即保证口令不落盘
        assert_eq!(t.host, "10.0.0.9");
        assert_eq!(t.auth_method, "password");
        assert_eq!(t.name, "b");
    }

    #[test]
    fn connect_rejects_unreachable_target_fast() {        let (m, _d) = manager();
        let req = ConnectRequest {
            target_id: None,
            name: "nowhere".into(),
            host: "127.0.0.1".into(),
            // 未监听端口：立即 Connection refused，验证错误可读
            port: 1,
            username: "nobody".into(),
            auth_method: "agent".into(),
            password: None,
            install_mode: "auto".into(),
        };
        let err = m.connect(&req, |_, _| {}).expect_err("不可达目标必须失败");
        let msg = err.to_string();
        assert!(msg.contains("SSH 远程连接失败"), "{msg}");
        // 失败后不得残留会话
        assert_eq!(m.status().state, state::IDLE);
    }

    /// 真实 SSH 端到端：探测 → 拉起远端引擎 → 隧道 → 就绪 → 断开全链路。
    ///
    /// 默认 `#[ignore]`（CI 无 sshd）。本地验证方式：
    /// ```sh
    /// # 远端需具备 sshd 且 `command -v deepcode` 可用
    /// DEEPCODE_E2E_SSH_HOST=127.0.0.1 DEEPCODE_E2E_SSH_PORT=22222 \
    /// DEEPCODE_E2E_SSH_USER=tester DEEPCODE_E2E_SSH_KEY=/tmp/deepcode-e2e-key \
    ///   cargo test ssh_e2e_real_connection -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要真实 sshd 环境（见函数文档）"]
    fn ssh_e2e_real_connection() {
        let host = std::env::var("DEEPCODE_E2E_SSH_HOST").expect("需 DEEPCODE_E2E_SSH_HOST");
        let port: u16 = std::env::var("DEEPCODE_E2E_SSH_PORT")
            .expect("需 DEEPCODE_E2E_SSH_PORT")
            .parse()
            .expect("端口必须是数字");
        let user = std::env::var("DEEPCODE_E2E_SSH_USER").expect("需 DEEPCODE_E2E_SSH_USER");
        let key = std::env::var("DEEPCODE_E2E_SSH_KEY").ok();

        let dir = tempfile::tempdir().unwrap();
        let mgr = SshManager::new(TargetStore::new(dir.path().join("targets.json")));

        // 走真实使用路径：先登记目标（带密钥），再用 targetId 连接
        let mut target = SshTarget::new(
            "e2e",
            host.clone(),
            port,
            user.clone(),
            if key.is_some() { "keyfile" } else { "agent" },
        );
        target.identity_file = key;
        let saved = mgr.store.upsert(target.clone()).expect("目标应可保存");
        assert_eq!(saved.len(), 1);

        let req = ConnectRequest {
            target_id: Some(target.id.clone()),
            name: target.name.clone(),
            host,
            port,
            username: user,
            auth_method: target.auth_method.clone(),
            password: None,
            install_mode: "auto".into(),
        };

        let phases: std::sync::Arc<std::sync::Mutex<Vec<u8>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = std::sync::Arc::clone(&phases);
        let result = mgr
            .connect(&req, move |p, msg| {
                println!("  [phase {p}] {msg}");
                recorder.lock().unwrap().push(p);
            })
            .expect("真实 SSH 连接应成功");

        // 四个阶段都必须报过（0→3 单调）
        let seen = phases.lock().unwrap().clone();
        assert_eq!(seen.first().copied(), Some(phase::PROBE), "首个阶段应为探测");
        assert_eq!(seen.last().copied(), Some(phase::READY), "末个阶段应为就绪");
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "阶段必须单调不减：{seen:?}");

        // 隧道本地端口可连
        assert!(
            std::net::TcpStream::connect(("127.0.0.1", result.local_port)).is_ok(),
            "隧道端口 {} 应可连接",
            result.local_port
        );
        assert_eq!(mgr.status().state, state::READY);
        assert_eq!(mgr.status().local_port, Some(result.local_port));

        // 隧道凭据可用于自动登录
        let (cred_port, username, password) =
            mgr.tunnel_credentials().expect("活动会话应有凭据");
        assert_eq!(cred_port, result.local_port);
        assert_eq!(username, REMOTE_USERNAME);
        assert!(!password.is_empty(), "远端登录口令不应为空");

        // 断开：会话清空、端口释放
        mgr.disconnect();
        assert_eq!(mgr.status().state, state::IDLE);
        assert!(mgr.tunnel_credentials().is_none());
        assert!(
            std::net::TcpStream::connect(("127.0.0.1", result.local_port)).is_err(),
            "断开后隧道端口应不可连接"
        );
    }
}
