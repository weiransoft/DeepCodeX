//! EngineManager：本地 deepcode web 引擎子进程的全生命周期管理。
//!
//! 对应 PRD FR-1.1 ~ FR-1.4 与架构文档 DCA-ARCH-DESKTOP-001 §3.2：
//! - 启动：`<node> <cli.js> web --host 127.0.0.1 --port <动态>`；
//!   JWT secret 仅经环境变量 `DEEPCODE_WEB_JWT_SECRET` 注入（不落盘，评审 C-4）；
//! - 健康检查：轮询 `GET /api/health`（M1 已在引擎侧新增该端点，返回 200 `{ok:true}`；
//!   旧 dist 无该端点时回退 `/api/config` 的 401/2xx 语义探活）；
//! - 桌面登录（已核实引擎真实契约后定稿）：引擎**无**运行时用户管理 API、会话仅
//!   HttpOnly Cookie（壳不可读、WebView reload 后保留）。壳在启动前生成
//!   `desktop` 账号（sha256 hex 与引擎 matchLocalUser 完全一致）写入
//!   settings.json `web.auth.localUsers`，引擎页加载后由初始化脚本经
//!   `engine_credentials`（仅引擎 origin 放行）同源 fetch 登录换 Cookie；
//! - 崩溃自动重启 ≤3 次（监督线程同步重启）；退出优雅关闭
//!   （进程组 SIGTERM → 3s → SIGKILL；Windows 走 Job Object 终止）。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{self, EngineMode, JWT_SECRET_ENV};
use crate::engine::port;
use crate::engine::settings;
use crate::error::ShellError;

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

/// 引擎崩溃自动重启上限（ARCH §2.1 故障域表）。
const MAX_AUTO_RESTARTS: u32 = 3;
/// 健康检查默认总超时（ARCH §3.2：30s）。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// 健康检查轮询间隔。
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
/// 优雅关闭等待窗口（超时 SIGKILL）。
const GRACEFUL_KILL: Duration = Duration::from_secs(3);
/// 桌面登录账号名（写入引擎 settings 的 localUsers，与会话绑定同生命周期）。
pub const DESKTOP_USER: &str = "desktop";
/// 固定口令模式的约定口令（本地开发/演示用；settings 摘要命中才启用，
/// 默认模式下口令仍是每次启动随机生成、绝不落盘）。
const FIXED_PASSWORD: &str = "desktop";

/// 引擎对外状态快照（`engine_status` IPC 返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// stopped | starting | ready | crashed | failed
    pub state: String,
    /// 当前监听端口（未就绪时 None）
    pub port: Option<u16>,
    /// 子进程 PID
    pub pid: Option<u32>,
    /// 引擎 CLI 入口描述（诊断展示用）
    pub program: String,
    /// 日志文件路径
    pub log_path: String,
    /// 累计自动重启次数
    pub restarts: u32,
}

/// 解析引擎子进程工作目录：cli.js 所在目录（prefix_args[0]）；
/// 解析失败回落 node 可执行文件目录，再失败回落系统根目录。
#[cfg_attr(not(windows), allow(dead_code))]
fn engine_cli_dir(engine: &config::ResolvedEngine) -> std::path::PathBuf {
    engine
        .prefix_args
        .first()
        .map(std::path::PathBuf::from)
        .and_then(|p| p.parent().map(std::path::PathBuf::from))
        .filter(|d| d.is_dir())
        .or_else(|| {
            engine
                .program
                .parent()
                .map(std::path::PathBuf::from)
                .filter(|d| d.is_dir())
        })
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// Windows Job Object 句柄包装（KILL_ON_JOB_CLOSE：壳任何形式退出时/// Windows 内核保证引擎进程树一并回收；句柄存活期 == 子进程存活期）。
#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}
#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Windows Job Object 装配（对齐 macOS setsid+killpg 语义；M1 于 macOS 开发，
/// 该路径保证代码正确性，运行时验证在 Windows 机器上进行）。
#[cfg(windows)]
mod job {
    use super::JobHandle;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 创建带 KILL_ON_JOB_CLOSE 语义的 Job Object 并把子进程挂入。
    pub fn assign(child: &Child) -> std::io::Result<JobHandle> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let e = std::io::Error::last_os_error();
                windows_sys::Win32::Foundation::CloseHandle(job);
                return Err(e);
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                let e = std::io::Error::last_os_error();
                windows_sys::Win32::Foundation::CloseHandle(job);
                return Err(e);
            }
            Ok(JobHandle(job))
        }
    }
}

/// 子进程包装（std `Child`，`Send + Sync`，可安全跨线程共享）。
///
/// 句柄经 `shared` 在 owner 与 supervisor 线程间共享：
/// - 正常退出：supervisor 轮询 `try_wait` 取退出码后转崩溃处置；
/// - 主动停止：调用方 `take()` 独占句柄后置 `killed`——supervisor 见标志
///   立即让出收割权；调用方 SIGTERM → 超时 SIGKILL；
/// - 壳异常退出（abort 等 Drop-only 路径）：Drop 强杀收割，杜绝孤儿引擎。
struct ManagedChild {
    shared: Arc<Mutex<std::process::Child>>,
    /// 已走显式停止/强杀路径：supervisor 见到即让出收割权
    killed: AtomicBool,
    /// Windows Job Object 句柄（KILL_ON_JOB_CLOSE 语义，见 job::assign）
    #[cfg(windows)]
    job: Option<JobHandle>,
}

impl ManagedChild {
    fn new(child: std::process::Child) -> Self {
        Self {
            shared: Arc::new(Mutex::new(child)),
            killed: AtomicBool::new(false),
            #[cfg(windows)]
            job: None,
        }
    }

    /// 非阻塞读取 PID（状态快照用）。
    fn try_id(&self) -> Option<u32> {
        self.shared.try_lock().ok().map(|c| c.id())
    }

    /// 标记强杀中并尝试强杀（尽力而为，不等退出；收割由调用方负责）。
    /// （Windows 未挂载 Job Object 时的退化终止路径使用；macOS 生产路径走 killpg）
    #[allow(dead_code)]
    fn start_kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        if let Ok(mut c) = self.shared.lock() {
            let _ = c.kill();
        }
    }

    /// 优雅关闭窗口内等待子进程退出并收割（同步阻塞；持锁轮询 `try_wait`，
    /// 超时返回 false 由调用方强杀）。
    fn wait_graceful_blocking(shared: &Arc<Mutex<std::process::Child>>, timeout: Duration) -> bool {
        let mut c = shared.lock().unwrap();
        let deadline = Instant::now() + timeout;
        loop {
            match c.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => {}
                Err(_) => return false,
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// 强制终止并收割（超时 SIGKILL 兜底）。
    fn force_kill(shared: &Arc<Mutex<std::process::Child>>) {
        let mut c = shared.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
    }

    /// 可中断等待（supervisor 专用）：短周期 `try_wait` 轮询检查 `killed`，
    /// 被标记后返回 None，由调用方让出收割权。锁占用窗口 ≤ 单次 try_wait。
    fn wait_interruptible(&self) -> Option<std::io::Result<std::process::ExitStatus>> {
        loop {
            if self.killed.load(Ordering::SeqCst) {
                return None;
            }
            let mut c = self.shared.lock().unwrap();
            match c.try_wait() {
                Ok(Some(status)) => return Some(Ok(status)),
                Ok(None) => {}
                Err(e) => return Some(Err(e)),
            }
            drop(c);
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        // 兜底强杀：任何未被显式收割的路径（含壳 abort 触发的 drop）都确保
        // 子进程终止；已收割进程的 kill/wait 为无害 no-op。
        if let Ok(mut c) = self.shared.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
        // Windows：JobHandle 最后 drop（CloseHandle）——KILL_ON_JOB_CLOSE 收尾
    }
}

/// 状态常量（字符串小写，与前端约定一致）。
pub mod state {
    pub const STOPPED: &str = "stopped";
    pub const STARTING: &str = "starting";
    pub const READY: &str = "ready";
    pub const CRASHED: &str = "crashed";
    pub const FAILED: &str = "failed";
}

/// 引擎运行时（随应用 state 管理；全同步实现，阻塞操作由命令层放入
/// spawn_blocking，headless 测试可直接调用）。
pub struct EngineRuntime {
    /// 引擎模式（M1=System）
    mode: EngineMode,
    /// 引擎日志目录（应用数据目录/logs）
    log_dir: PathBuf,
    /// `~/.deepcode/settings.json` 路径（注入：默认真实路径，测试注入临时文件）
    settings_path: PathBuf,
    /// 当前引擎子进程（含强杀语义）
    child: Mutex<Option<Arc<ManagedChild>>>,
    /// 状态机字符串（与 EngineStatus.state 同步）
    state: Mutex<String>,
    /// 当前端口
    port: Mutex<Option<u16>>,
    /// 累计自动重启次数
    restarts: AtomicU32,
    /// 用户主动停止标志：true 时子进程退出不再触发自动重启
    shutting_down: AtomicBool,
    /// 健康检查总超时（默认 30s；测试注入短超时）
    health_timeout: Mutex<Duration>,
    /// 会话登录口令（仅驻内存；settings 只存 sha256 摘要）
    session_password: Mutex<String>,
    /// 可选 UI 联动（状态事件广播 + 崩溃恢复导航）；headless 测试为 None
    app: Mutex<Option<AppHandle>>,
    /// 已知密钥明文清单（本轮 spawn 注入的 API Key / JWT Secret / LDAP 口令等），
    /// 供日志管道与 `engine_log_tail` 脱敏——密钥绝不落入日志文件
    log_secrets: Mutex<Arc<Vec<String>>>,
}

impl EngineRuntime {
    /// 创建引擎运行时；`log_dir` 为壳日志目录（FR-1.6），
    /// `settings_path` 为引擎用户设置文件路径（默认 `~/.deepcode/settings.json`）。
    pub fn new(mode: EngineMode, log_dir: PathBuf, settings_path: PathBuf) -> Self {
        Self {
            mode,
            log_dir,
            settings_path,
            child: Mutex::new(None),
            state: Mutex::new(state::STOPPED.to_string()),
            port: Mutex::new(None),
            restarts: AtomicU32::new(0),
            shutting_down: AtomicBool::new(false),
            health_timeout: Mutex::new(HEALTH_TIMEOUT),
            session_password: Mutex::new(String::new()),
            app: Mutex::new(None),
            log_secrets: Mutex::new(Arc::new(Vec::new())),
        }
    }

    /// 用本轮启动注入的密钥清单替换日志脱敏列表（spawn 前调用）。
    fn set_log_secrets(&self, secrets: Vec<String>) {
        *self.log_secrets.lock().unwrap() = Arc::new(secrets);
    }

    /// 将文本中出现的已知密钥明文替换为 `[REDACTED]`（日志脱敏单点实现）。
    pub fn redact_text(&self, text: &str) -> String {
        let secrets = self.log_secrets.lock().unwrap().clone();
        redact_line(text, &secrets)
    }

    /// 注入 UI 联动句柄（setup 阶段调用；headless 测试不调用）。
    pub fn attach_app(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    /// 注入健康检查超时（测试加速用；生产保持 30s 默认值）。
    #[allow(dead_code)]
    pub fn set_health_timeout(&self, timeout: Duration) {
        *self.health_timeout.lock().unwrap() = timeout;
    }

    fn set_state(&self, s: &str) {
        let old = self.state_str();
        if old != s {
            // 状态机转换可观测性：boot 页卡死类问题的关键诊断线索
            log::info!("引擎状态: {old} -> {s}");
        }
        *self.state.lock().unwrap() = s.to_string();
    }

    fn state_str(&self) -> String {
        self.state.lock().unwrap().clone()
    }

    /// 状态快照（不含口令）。
    pub fn status(&self) -> EngineStatus {
        let pid = self.child.lock().unwrap().as_ref().and_then(|c| c.try_id());
        let program = self
            .mode
            .resolve()
            .map(|r| {
                let mut s = r.program.to_string_lossy().into_owned();
                if !r.prefix_args.is_empty() {
                    s.push(' ');
                    s.push_str(&r.prefix_args.join(" "));
                }
                s
            })
            .unwrap_or_else(|e| e.to_string());
        EngineStatus {
            state: self.state_str(),
            port: *self.port.lock().unwrap(),
            pid,
            program,
            log_path: self.log_path().to_string_lossy().into_owned(),
            restarts: self.restarts.load(Ordering::SeqCst),
        }
    }

    /// 引擎日志文件路径（跨重启追加，统一文件便于排查）。
    pub fn log_path(&self) -> PathBuf {
        self.log_dir.join("engine.log")
    }

    /// 当前引擎 base URL（探活与导航共用）。
    pub fn base_url(&self) -> String {
        format!(
            "http://127.0.0.1:{}",
            self.port.lock().unwrap().unwrap_or(0)
        )
    }

    /// 桌面会话登录凭据（`engine_credentials` IPC：仅引擎 origin 页面可调用，
    /// 初始化脚本在本页内同源 fetch 登录换 HttpOnly Cookie）。
    pub fn credentials(&self) -> Result<(String, String), ShellError> {
        if self.state_str() != state::READY {
            return Err(ShellError::EngineRuntime("引擎未就绪".into()));
        }
        let password = self.session_password.lock().unwrap().clone();
        if password.is_empty() {
            return Err(ShellError::EngineRuntime("会话口令尚未生成".into()));
        }
        Ok((DESKTOP_USER.to_string(), password))
    }

    /// 启动引擎并等待就绪。幂等：已运行直接返回快照。
    /// 同步阻塞（健康检查至多 health_timeout），命令层须放入 spawn_blocking。
    pub fn start(&self) -> Result<EngineStatus, ShellError> {
        let cur = self.state_str();
        if cur == state::STARTING || cur == state::READY {
            return Ok(self.status());
        }
        self.shutting_down.store(false, Ordering::SeqCst);

        let engine = self.mode.resolve()?;
        // 密钥迁移（幂等）：settings.json 中的明文密钥（env.API_KEY / jwtSecret /
        // LDAP bindPassword）→ 系统钥匙串，随后从文件移除——配置文件不得明文存凭证。
        // 失败仅记日志不阻断（引擎仍可用 env 注入或自身缺省运行）。
        crate::config_persist::migrate_secrets_from_settings();
        // 会话口令 + 写入引擎本地用户（引擎 fail-fast 前置：web.enabled=true）。
        // settings 中 desktop 账号摘要若等于 sha256("desktop")，视为用户显式选择
        // 固定口令模式：会话口令同样用 "desktop"，重启后手动登录依然有效；
        // 否则保持默认安全模式——每次启动随机口令，仅壳内自动登录。
        let fixed = is_fixed_password_enabled(&self.settings_path);
        let password = if fixed {
            FIXED_PASSWORD.to_string()
        } else {
            settings::generate_jwt_secret()
        };
        *self.session_password.lock().unwrap() = password.clone();
        prepare_engine_settings(&self.settings_path, DESKTOP_USER, &password)?;

        let log_path = self.log_path();
        if let Some(p) = log_path.parent() {
            std::fs::create_dir_all(p)?;
        }

        self.set_state(state::STARTING);
        self.emit_status();

        // 启动 + 健康检查；失败重试一次（换端口）
        let mut last_err: Option<ShellError> = None;
        for attempt in 0..2 {
            // 记录本轮 spawn 前的日志长度：健康检查失败时只取本轮新增输出做诊断，
            // 避免把上一次成功启动的历史记录误当作本次失败原因
            let log_offset = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
            match self.try_spawn_once(&engine, &log_path) {
                Ok(()) => match wait_healthy(
                    self.base_url(),
                    *self.health_timeout.lock().unwrap(),
                    &log_path,
                    log_offset,
                ) {
                    Ok(()) => {
                        self.set_state(state::READY);
                        self.emit_status();
                        // 崩溃恢复场景：WebView 可能停在旧引擎页（端口已变），重定向进新页
                        self.redirect_to_engine();
                        return Ok(self.status());
                    }
                    Err(e) => last_err = Some(e),
                },
                Err(e) => last_err = Some(e),
            }
            log::warn!("引擎启动第 {} 次尝试失败: {:?}", attempt + 1, last_err);
            self.kill_current();
        }

        self.set_state(state::FAILED);
        self.emit_status();
        let final_err = last_err.unwrap_or_else(|| ShellError::EngineStart("未知原因".into()));
        // 失败原因同时落到 engine.log：该文件是用户经 engine_open_logs 直接打开的
        // 第一现场，只广播到 UI 会让「日志里看不出为什么没起来」再次发生。
        // 内容取自脱敏后的引擎输出，回写不会引入密钥明文。
        self.append_log(&format!("[shell] 引擎启动失败：{final_err}"));
        self.emit_error(&final_err);
        Err(final_err)
    }

    /// 单次 spawn：成功后子进程句柄挂到 self.child（未探活）。
    /// 同步函数：锁只跨 spawn 一次，无长时间持锁。
    fn try_spawn_once(
        &self,
        engine: &config::ResolvedEngine,
        log_path: &Path,
    ) -> Result<(), ShellError> {
        let port = port::pick_free_port()?;
        let jwt_secret = settings::generate_jwt_secret();

        // 密钥注入 + 日志脱敏清单（模型密钥 / 引擎级 API Key / LDAP 口令）
        let launch = crate::config_persist::resolve_engine_launch();
        self.set_log_secrets(launch.redact);

        // 日志走脱敏泵：stdout/stderr 管道化，读线程逐行替换已知密钥明文为
        // [REDACTED] 后追加写入 engine.log——引擎打印任何密钥都不会落盘明文
        // （日志文件由泵线程按 append 模式打开，见 spawn_redacting_pump）

        let mut cmd = std::process::Command::new(&engine.program);
        cmd.args(&engine.prefix_args)
            .args(["web", "--host", "127.0.0.1", "--port", &port.to_string()])
            // 显式工作目录：GUI（Finder/open/launchd）启动时壳 cwd 为 `/`，
            // Node 模块解析会沿 cwd 向上遍历找 package.json，在 `/` 附近存在
            // open() 内核态阻塞的偶发案例（2026-10-30 采样定位）；固定到
            // cli.js 所在目录消除该路径差异（所有文件访问均为绝对路径，cwd 无功能影响）
            .current_dir(engine_cli_dir(&engine))
            .env(JWT_SECRET_ENV, jwt_secret)
            // 技能 / 智能体资产根 = 真实家目录（2026-11-04）：桌面与 CLI 同一份
            // ~/.deepcode/skills。不注入时引擎按 Web 多用户口径锚在空的 per-user
            // 引擎数据根 → 桌面版「技能 / 智能体」列表恒为空。
            // 家目录取不到时跳过注入（引擎回退默认口径，不阻断启动）。
            .envs(settings::skills_home_env())
            // provider 接入：把默认模型的密钥 / 模型 / provider / baseURL 经 DEEPCODE_*
            // 环境变量注入引擎进程环境（密钥取自钥匙串，绝不回写 settings.json 明文）。
            // .envs 仅向继承环境追加，不清除 PATH 等既有变量。
            .envs(launch.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 独立进程组（Unix）：便于整组信号清理，覆盖 node 派生的孙进程
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        // Windows 独立进程组 + Job Object（KILL_ON_JOB_CLOSE：壳任何形式退出
        // 时内核保证子进程树回收；本机 macOS 仅保证编译路径，运行时验证 M5）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        let child = cmd.spawn().map_err(|e| {
            ShellError::EngineStart(format!(
                "无法启动引擎 {:?} {:?}: {e}",
                engine.program, engine.prefix_args
            ))
        })?;

        // 脱敏泵：消费 stdout/stderr 管道（不消费会反压引擎），逐行脱敏后落盘。
        // 线程随管道 EOF（引擎退出）自然结束；进程组信号清理不受影响。
        let secrets: Arc<Vec<String>> = self.log_secrets.lock().unwrap().clone();
        let mut child = child;
        if let Some(out) = child.stdout.take() {
            spawn_redacting_pump(out, log_path.to_path_buf(), Arc::clone(&secrets));
        }
        if let Some(err) = child.stderr.take() {
            spawn_redacting_pump(err, log_path.to_path_buf(), secrets);
        }

        #[allow(unused_mut)] // windows 路径需要 mut 挂 Job Object
        let mut managed = ManagedChild::new(child);
        #[cfg(windows)]
        match job::assign(&managed.shared.lock().unwrap()) {
            Ok(h) => managed.job = Some(h),
            Err(e) => log::warn!("Job Object 挂载失败（退化为直接子进程管理）: {e}"),
        }

        log::info!("引擎已启动 pid={:?} port={}", managed.try_id(), port);
        self.append_log(&format!(
            "[shell] 引擎已拉起 pid={:?} port={port}（仅绑定 127.0.0.1）",
            managed.try_id()
        ));

        *self.child.lock().unwrap() = Some(Arc::new(managed));
        *self.port.lock().unwrap() = Some(port);
        Ok(())
    }

    /// 挂载进程退出监视线程（崩溃自动重启 ≤ MAX_AUTO_RESTARTS 次，FR-1.3）。
    ///
    /// std 线程轮询子进程退出，退出后处置：主动停止/重启换实例 → 继续守下一个；
    /// 崩溃且未达上限 → crashed + 同步自动重启；超限 → failed。
    pub fn attach_exit_watch(self: &Arc<Self>) {
        let rt = Arc::clone(self);
        let _ = std::thread::Builder::new().name("engine-watch".into()).spawn(move || {
            loop {
                // 等待子进程出现（start 稍晚于本线程启动属正常竞态）
                let mc = loop {
                    if let Some(mc) = rt.child.lock().unwrap().as_ref() {
                        break Arc::clone(mc);
                    }
                    std::thread::sleep(Duration::from_millis(150));
                };
                match mc.wait_interruptible() {
                    // 主动停止/重启换实例：状态由 stop()/start() 自行维护，继续守下一个
                    None => continue,
                    Some(Ok(status)) => {
                        log::info!("引擎进程退出 code={:?}", status.code());
                        rt.append_log(&format!("[shell] 引擎进程退出 code={:?}", status.code()));
                    }
                    Some(Err(e)) => log::warn!("等待引擎进程失败: {e}"),
                }
                if rt.shutting_down.load(Ordering::SeqCst) {
                    continue;
                }
                let tries = rt.restarts.fetch_add(1, Ordering::SeqCst);
                if tries >= MAX_AUTO_RESTARTS {
                    // 清理已退出子进程句柄（exit status 已被缓存，重复守候会立即
                    // 返回同一次退出并造成忙转），随后转入 failed 终态
                    *rt.child.lock().unwrap() = None;
                    *rt.port.lock().unwrap() = None;
                    rt.set_state(state::FAILED);
                    rt.append_log(&format!(
                        "[shell] 引擎连续崩溃已达自动重启上限（{MAX_AUTO_RESTARTS} 次），转入 failed"
                    ));
                    rt.emit_status();
                    continue;
                }
                rt.set_state(state::CRASHED);
                rt.emit_status();
                log::warn!("引擎异常退出，自动重启（第 {} 次）", tries + 1);
                rt.append_log(&format!("[shell] 引擎异常退出，自动重启（第 {} 次）", tries + 1));
                // 监督线程内同步重启（阻塞直至就绪或失败）
                if let Err(e) = rt.start() {
                    log::error!("自动重启失败: {e}");
                }
            }
        });
    }

    /// 手动重启（`engine_restart` IPC）：重置重启预算 → 优雅停止 → 重新启动。
    pub fn restart(&self) -> Result<EngineStatus, ShellError> {
        self.restarts.store(0, Ordering::SeqCst);
        self.stop()?;
        self.start()
    }

    /// 用户主动停止：进程组 SIGTERM，超时 SIGKILL（FR-1.4）。
    /// 同步阻塞（至多 GRACEFUL_KILL），命令层须放入 spawn_blocking。
    pub fn stop(&self) -> Result<(), ShellError> {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.terminate_current(GRACEFUL_KILL);
        self.set_state(state::STOPPED);
        self.emit_status();
        Ok(())
    }

    /// 杀掉当前子进程并收割（不动 shutting_down 之外的语义）。
    /// 先置 killed 标志：supervisor 让出收割权，本函数独占收割。
    fn kill_current(&self) {
        self.terminate_current(GRACEFUL_KILL + Duration::from_millis(200));
    }

    /// 终止当前子进程并收割：SIGTERM（进程组）→ timeout → SIGKILL。
    /// Windows：Job Object 已挂载时 TerminateJobObject（无优雅期语义，直接终止），
    /// 否则退化为直接子进程 TerminateProcess。
    fn terminate_current(&self, timeout: Duration) {
        let mc = { self.child.lock().unwrap().take() };
        if let Some(mc) = mc {
            let pid = mc.try_id().unwrap_or(0) as i32;
            // 置 killed 标志（不 kill）：supervisor 立即让出收割权，
            // 收割权归本函数——先 SIGTERM 优雅退出，超时才 SIGKILL。
            mc.killed.store(true, Ordering::SeqCst);
            #[cfg(unix)]
            if pid > 0 {
                unsafe {
                    libc::killpg(pid, libc::SIGTERM);
                }
            }
            #[cfg(windows)]
            if pid > 0 {
                // Job Object 终止覆盖整个进程树；未挂载时退化为直接子进程终止
                match mc.job.as_ref() {
                    Some(job) => unsafe {
                        windows_sys::Win32::System::JobObjects::TerminateJobObject(job.0, 1);
                    },
                    None => mc.start_kill(),
                }
            }
            let shared = mc.shared.clone();
            let reaped = ManagedChild::wait_graceful_blocking(&shared, timeout);
            if !reaped {
                log::warn!("引擎未在 {:?} 内退出，强制 SIGKILL", timeout);
                self.append_log(&format!(
                    "[shell] 引擎未在 {timeout:?} 内响应 SIGTERM，强制 SIGKILL"
                ));
                let shared2 = mc.shared.clone();
                ManagedChild::force_kill(&shared2);
            }
            drop(mc);
        }
        *self.port.lock().unwrap() = None;
    }

    /// 崩溃恢复导航：WebView 停在旧引擎页（端口已变）时重定向进新页；
    /// 停在 boot 页（tauri 引导页）时不干预——boot 页监听状态事件自行跳转。
    fn redirect_to_engine(&self) {
        let Some(app) = self.app.lock().unwrap().clone() else {
            return;
        };
        let Some(window) = app.get_webview_window("boot") else {
            return;
        };
        let base = self.base_url();
        let Ok(cur) = window.url() else {
            return;
        };
        let cur = cur.as_str();
        let on_engine = cur.starts_with("http://127.0.0.1:");
        let on_current = cur.starts_with(&base);
        if on_engine && !on_current {
            log::info!("检测到 WebView 停在旧引擎页，重定向到 {base}");
            let _ = window.eval(&format!("window.location.replace('{base}/')"));
        }
    }

    /// 向所有窗口广播引擎状态事件（boot 页据此切换界面）。
    fn emit_status(&self) {
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit("engine-status", self.status());
        }
    }

    /// 广播启动失败事件（boot 页据此展示错误 + 日志 + 重试入口）。
    fn emit_error(&self, e: &ShellError) {
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit("engine-start-error", e.to_string());
        }
    }

    /// 追加壳侧日志到引擎日志文件（同一文件便于按时间线排查）。
    /// 防御纵深：壳侧文案同样经已知密钥脱敏（虽然正常流程不含密钥）。
    fn append_log(&self, line: &str) {
        use std::fs::OpenOptions;
        if let Some(p) = self.log_path().parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
        {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{secs} {}", self.redact_text(line));
        }
    }
}

/// 单行日志脱敏：替换所有已知密钥明文为 `[REDACTED]`。
fn redact_line(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_string();
    for s in secrets {
        if !s.is_empty() && out.contains(s.as_str()) {
            out = out.replace(s.as_str(), "[REDACTED]");
        }
    }
    out
}

/// 引擎输出脱敏泵：持续读取子进程输出流，逐行替换已知密钥明文后
/// 追加写入 engine.log。管道 EOF（引擎退出）后线程自然结束。
fn spawn_redacting_pump(
    stream: impl std::io::Read + Send + 'static,
    log_path: PathBuf,
    secrets: Arc<Vec<String>>,
) {
    let _ = std::thread::Builder::new().name("engine-log-pump".into()).spawn(move || {
        use std::io::{BufRead, BufReader};
        let mut reader = BufReader::new(stream);
        // 打开失败则丢弃输出（与原 Stdio 文件打开失败的降级语义一致）
        let mut file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(f) => f,
            Err(_) => return,
        };
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let redacted = redact_line(&line, &secrets);
                    if file.write_all(redacted.as_bytes()).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// 判断是否启用固定口令模式：settings 中 desktop 账号的 passwordHash
/// 恰好等于 sha256("desktop")（用户显式设置已知口令作为开关）。
/// 文件缺失、解析失败、账号不存在一律按未启用处理（安全默认）。
fn is_fixed_password_enabled(settings_path: &Path) -> bool {
    let wanted = config::sha256_hex(FIXED_PASSWORD.as_bytes());
    let Ok(raw) = std::fs::read_to_string(settings_path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    root["web"]["auth"]["localUsers"]
        .as_array()
        .map(|users| {
            users.iter().any(|u| {
                u.get("username").and_then(Value::as_str) == Some(DESKTOP_USER)
                    && u.get("passwordHash")
                        .and_then(Value::as_str)
                        .map(|h| h.trim().to_ascii_lowercase() == wanted)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 引擎启动前的 settings.json 准备（幂等合并，绝不清空用户其他配置）：
/// 1. `web.enabled = true`（引擎 fail-fast 前置条件，已核实 web-command.ts L41-53）；
/// 2. `web.auth.localUsers` 注入桌面账号 `{username, passwordHash: sha256(pwd)}`
///    （摘要算法与引擎 matchLocalUser 一致：utf8 → sha256 hex 小写）。
///    引擎在 localUsers 非空时跳过 bootstrap 随机口令（config.ts L400-404）。
fn prepare_engine_settings(
    settings_path: &Path,
    username: &str,
    password: &str,
) -> Result<(), ShellError> {
    settings::ensure_web_enabled(settings_path)?;
    let mut root: Value = serde_json::from_str(&std::fs::read_to_string(settings_path)?)
        .map_err(|e| ShellError::Config(format!("settings.json 解析失败：{e}")))?;
    let hash = config::sha256_hex(password.as_bytes());
    let web = root
        .as_object_mut()
        .expect("ensure_web_enabled 已保证 object")
        .entry("web")
        .or_insert_with(|| Value::Object(Default::default()));
    let auth = web
        .as_object_mut()
        .expect("ensure_web_enabled 已保证 web object")
        .entry("auth")
        .or_insert_with(|| Value::Object(Default::default()));
    let auth_obj = auth
        .as_object_mut()
        .ok_or_else(|| ShellError::Config("settings.json 的 web.auth 必须是对象".into()))?;
    let users = auth_obj
        .entry("localUsers")
        .or_insert_with(|| Value::Array(Vec::new()));
    let users_arr = users.as_array_mut().ok_or_else(|| {
        ShellError::Config("settings.json 的 web.auth.localUsers 必须是数组".into())
    })?;
    // 替换或追加桌面账号（重复启动幂等更新摘要）
    let entry = json!({ "username": username, "passwordHash": hash });
    match users_arr
        .iter_mut()
        .find(|u| u.get("username").and_then(Value::as_str) == Some(username))
    {
        Some(slot) => *slot = entry,
        None => users_arr.push(entry),
    }
    settings::write_private(
        settings_path,
        serde_json::to_string_pretty(&root)?.as_bytes(),
    )
}

/// 健康检查（/api/health 200 优先；旧 dist 无该端点时回退 /api/config 401/2xx 语义）。
///
/// 失败时附带 `log_offset` 之后的新增引擎输出：引擎「未监听」有两种截然不同的
/// 成因——已启动但端口没起来（有输出）与进程卡在极早期（零输出），只有日志能把
/// 二者分开。缺少这段上下文时，现场只能看到「已拉起」却无从判断卡在哪里。
fn wait_healthy(
    base_url: String,
    timeout: Duration,
    log_path: &Path,
    log_offset: u64,
) -> Result<(), ShellError> {
    let deadline = Instant::now() + timeout;
    loop {
        if probe_health(&base_url) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let tail = new_engine_output_lines(log_path, log_offset, 12);
            let detail = if tail.is_empty() {
                // 零输出时进程仍在，几乎只可能是卡在内核态 I/O。实测栈为
                // open() ← uv_fs_open ← ReadFileSync ← GetPackageJSON ←
                // TraverseParent：Node 模块解析沿 cwd 向上找 package.json 时挂起。
                // 开发期引擎位于 ~/Documents（macOS TCC 保护目录），GUI 启动的
                // 子进程首次读取会触发「想访问你的文稿文件夹」询问并阻塞等待，
                // 终端里手动启动因继承终端授权而不复现——故此处给出权限提示。
                format!(
                    "引擎在 {}s 内未就绪（{base_url}），且该进程在此期间没有任何输出。\
                     这通常意味着进程卡在内核态 I/O（Node 解析模块时读取 package.json）。\
                     若引擎位于 ~/Documents、~/Desktop 等受保护目录，请在系统弹出的\
                     「想访问你的文稿文件夹」询问中允许，或在「系统设置 → 隐私与安全性 →\
                     文件与文件夹 / 完全磁盘访问权限」中为 DeepCode 授权。完整日志：{}",
                    timeout.as_secs(),
                    log_path.display()
                )
            } else {
                format!(
                    "引擎在 {}s 内未就绪（{base_url}）。引擎本轮输出：\n{}\n完整日志：{}",
                    timeout.as_secs(),
                    tail.join("\n"),
                    log_path.display()
                )
            };
            return Err(ShellError::EngineHealth(detail));
        }
        std::thread::sleep(HEALTH_INTERVAL);
    }
}

/// 判断一行是否为壳的编排记录（`append_log` 写的 `[shell] ...`）。
///
/// 壳记录可能带 unix 秒时间戳前缀（`1793548106 [shell] 引擎已拉起 ...`），
/// 也可能不带，故先剥离「纯数字 + 空格」前缀再匹配；引擎自身输出里出现
/// 同样形态的概率可忽略。
fn is_shell_record(line: &str) -> bool {
    let rest = match line.split_once(' ') {
        Some((head, tail)) if !head.is_empty() && head.bytes().all(|b| b.is_ascii_digit()) => tail,
        _ => line,
    };
    rest.starts_with("[shell] ")
}

/// 读取日志中 `offset` 之后新增的**引擎自身输出**，返回末 `max_lines` 行。
///
/// 同一文件混写了两类内容：壳的编排记录（`[shell] ` 前缀，如「引擎已拉起」）
/// 与引擎 stdout/stderr。只有后者能说明引擎卡在哪，故剔除壳记录——
/// 否则「引擎已拉起」这一行会把「零输出」误判成「有输出」，掩盖真正的成因。
///
/// offset 超出当前文件长度（日志被截断/轮转）时从头读，避免漏掉有效输出。
fn new_engine_output_lines(log_path: &Path, offset: u64, max_lines: usize) -> Vec<String> {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(log_path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = if offset <= len { offset } else { 0 };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = String::new();
    if f.read_to_string(&mut buf).is_err() {
        return Vec::new();
    }
    let mut lines: Vec<String> = buf
        .lines()
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.is_empty() && !is_shell_record(l))
        .collect();
    if lines.len() > max_lines {
        lines.drain(..lines.len() - max_lines);
    }
    lines
}

/// 单轮探活：/api/health 200 即就绪；404（旧引擎）回退 /api/config 401/2xx；
/// 连接拒绝/超时/5xx 一律未就绪。
fn probe_health(base_url: &str) -> bool {
    match http_get_status(base_url, "/api/health") {
        Some(200) => return true,
        Some(404) => {}
        Some(_) => return false,
        None => return false,
    }
    matches!(
        http_get_status(base_url, "/api/config"),
        Some(code) if code == 401 || (200..300).contains(&code)
    )
}

/// 原生 TCP 最小 HTTP GET（仅本机回环探活用，不引入 HTTP 客户端依赖）。
/// 返回响应状态码；连接/读写出错返回 None。
fn http_get_status(base_url: &str, path: &str) -> Option<u16> {
    let port: u16 = base_url.rsplit(':').next()?.parse().ok()?;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(800)))
        .ok()?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf);
    head.split_whitespace().nth(1)?.parse::<u16>().ok()
}

/// `~/.deepcode/settings.json` 路径（转引 engine::settings，保持既有调用点）。
pub fn home_settings_path() -> Result<PathBuf, ShellError> {
    settings::home_settings_path()
}

/// 退出前统一清理（RunEvent::Exit / 托盘退出调用）：同步尽力停止引擎。
///
/// 该回调可能在 runtime 关停后触发，因此用带超时的同步等待而非 await；
/// SIGTERM → GRACEFUL_KILL(3s) → SIGKILL，与 stop() 同一终止路径。
pub fn cleanup_blocking(rt: &Arc<EngineRuntime>) {
    rt.shutting_down.store(true, Ordering::SeqCst);
    rt.terminate_current(GRACEFUL_KILL);
    rt.set_state(state::STOPPED);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_line_masks_known_secrets() {
        // 日志脱敏：密钥明文出现（含同一行多次 / 多密钥共存）必须被替换
        let secrets = vec!["sk-abc123secret".to_string(), "Hongene#X".to_string()];
        assert_eq!(
            redact_line("key=sk-abc123secret ok", &secrets),
            "key=[REDACTED] ok"
        );
        assert_eq!(
            redact_line("a sk-abc123secret b sk-abc123secret c", &secrets),
            "a [REDACTED] b [REDACTED] c"
        );
        assert_eq!(
            redact_line("pw Hongene#X / key sk-abc123secret", &secrets),
            "pw [REDACTED] / key [REDACTED]"
        );
        // 无密钥行原样保留；空清单不影响输出
        assert_eq!(redact_line("normal log line", &secrets), "normal log line");
        assert_eq!(redact_line("normal log line", &[]), "normal log line");
    }

    /// M1 测试用 mock 引擎：模拟 deepcode web 的 /api/health 端点与
    /// SIGTERM 优雅退出行为（端口经 --port 参数传入，与真实引擎一致）。
    const MOCK_ENGINE_SRC: &str = r#"#!/usr/bin/env node
// DeepCode Desktop M1 测试 mock 引擎（进程名含 deepcode-m1-mock 便于残留检查）
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
if (process.env.DEEPCODE_MOCK_FAIL === "1") { process.exit(1); }
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => console.log("mock ready " + port));
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});
"#;

    fn write_exec(dir: &Path, name: &str, src: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, src).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    fn test_runtime(dir: &Path, entry: PathBuf) -> Arc<EngineRuntime> {
        let rt = Arc::new(EngineRuntime::new(
            EngineMode::Bundled(entry),
            dir.join("logs"),
            dir.join("settings.json"),
        ));
        rt.set_health_timeout(Duration::from_secs(8));
        rt
    }

    /// 完整生命周期：spawn → healthy → SIGTERM 优雅关闭 → 收割，不留孤儿进程。
    #[test]
    fn engine_lifecycle_spawn_healthy_graceful_stop() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write_exec(dir.path(), "deepcode-m1-mock-engine.js", MOCK_ENGINE_SRC);
        let rt = test_runtime(dir.path(), entry);

        let st = rt.start().expect("mock 引擎应正常就绪");
        assert_eq!(st.state, state::READY);
        let port = st.port.expect("就绪状态必须携带端口");
        assert!(st.pid.is_some());
        // /api/health 返回 200（真实 HTTP 探活）
        assert_eq!(http_get_status(&rt.base_url(), "/api/health"), Some(200));
        // 引擎只绑 127.0.0.1（健康检查走的就是回环地址）
        assert!(st.program.contains("deepcode-m1-mock-engine.js"));

        // 优雅关闭：SIGTERM → mock 引擎自行退出
        rt.stop().unwrap();
        let after = rt.status();
        assert_eq!(after.state, state::STOPPED);
        assert!(after.pid.is_none(), "收割后必须清理子进程句柄");
        // 无残留：端口已无人监听（进程确已退出）
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !port::can_connect(port, Duration::from_millis(300)),
            "停止后引擎端口必须不可达（无孤儿进程）"
        );
    }

    /// 崩溃自动重启 ≤3 次：SIGKILL 后监督线程拉起新实例；超限转 failed。
    // SIGKILL 需 libc（仅 unix target 依赖）；Windows 下该用例不可编译也不适用，
    // 故做平台门控，保证 `cargo test` 在 MinGW GNU 工具链下可运行。
    #[cfg(unix)]
    #[test]
    fn engine_crash_auto_restart_capped() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write_exec(dir.path(), "deepcode-m1-mock-engine.js", MOCK_ENGINE_SRC);
        let rt = test_runtime(dir.path(), entry);
        rt.attach_exit_watch();

        let st = rt.start().expect("首次启动就绪");
        let _first_pid = st.pid.expect("必须有 PID");

        // 连续 4 次 SIGKILL（模拟崩溃）：前 3 次自动重启，第 4 次超限转 failed。
        // 注意：被杀进程退出且被收割前 state 仍为 READY，推进判据必须绑定
        // "本轮被杀 PID 已被替换"（换新 PID 且重新就绪），避免旧状态满足条件误判。
        for round in 0..4 {
            let killed_pid = rt.status().pid.expect("运行中必须有 PID");
            unsafe {
                libc::kill(killed_pid as i32, libc::SIGKILL);
            }
            // 等待监督线程完成本轮处置（重启就绪 / 转入 failed）
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let s = rt.status();
                if round < 3 {
                    if s.state == state::READY && s.pid.is_some() && s.pid != Some(killed_pid) {
                        assert_eq!(
                            s.restarts,
                            round + 1,
                            "第 {} 轮后重启计数应为 {}",
                            round,
                            round + 1
                        );
                        break;
                    }
                } else if s.state == state::FAILED {
                    assert!(s.pid.is_none(), "failed 状态不应再有活跃子进程");
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "第 {} 轮处置超时（state={}）",
                    round,
                    rt.status().state
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        // 清理（failed 状态下 stop 也必须幂等成功）
        rt.stop().unwrap();
        assert_eq!(rt.status().state, state::STOPPED);
    }

    /// 手动重启：重置重启预算并拉起新实例。
    #[test]
    fn engine_manual_restart_resets_budget() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write_exec(dir.path(), "deepcode-m1-mock-engine.js", MOCK_ENGINE_SRC);
        let rt = test_runtime(dir.path(), entry);
        rt.attach_exit_watch();

        rt.start().expect("首次启动就绪");
        let old_pid = rt.status().pid.unwrap();
        let st = rt.restart().expect("手动重启应成功");
        assert_eq!(st.state, state::READY);
        assert_eq!(st.restarts, 0, "手动重启必须重置自动重启预算");
        assert_ne!(rt.status().pid, Some(old_pid), "重启后必须换新进程");
        rt.stop().unwrap();
    }

    /// 入口即退出的坏引擎：start 必须以 EngineHealth/EngineStart 失败收场。
    #[test]
    fn engine_start_fails_on_immediately_exiting_entry() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write_exec(
            dir.path(),
            "deepcode-m1-crash-engine.js",
            "#!/usr/bin/env node\nprocess.exit(1);\n",
        );
        let rt = test_runtime(dir.path(), entry);
        rt.set_health_timeout(Duration::from_millis(1500));

        let err = rt.start().expect_err("坏引擎必须启动失败");
        assert!(
            matches!(
                err,
                ShellError::EngineHealth(_) | ShellError::EngineStart(_)
            ),
            "失败类别应为健康检查/启动失败，实际：{err:?}"
        );
        assert_eq!(rt.status().state, state::FAILED);

        // 失败原因必须落到 engine.log（用户经 engine_open_logs 打开的第一现场），
        // 否则现场只剩「引擎已拉起」一行，无从判断为何没起来
        let log = std::fs::read_to_string(dir.path().join("logs").join("engine.log"))
            .unwrap_or_default();
        assert!(
            log.contains("引擎启动失败"),
            "engine.log 应记录失败原因，实际内容：{log}"
        );
        assert!(
            log.contains("没有任何输出"),
            "立即退出的引擎应被标注为零输出，实际内容：{log}"
        );

        rt.stop().unwrap();
    }

    /// 把 &[&str] 转成 Vec<String>（便于与 new_engine_output_lines 返回值比较）。
    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// 健康检查失败必须带上本轮引擎新增输出，且不得混入历史启动记录。
    #[test]
    fn health_failure_reports_only_new_engine_output() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("engine.log");
        std::fs::write(&log, "OLD SUCCESS LINE\n").unwrap();
        // offset = 本轮 spawn 前的长度：其后的内容才是本轮产物
        let offset = std::fs::metadata(&log).unwrap().len();
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
            f.write_all(b"MODULE LOADING\nBOOM: cannot bind port\n")
                .unwrap();
        }

        // 不可达端口 + 极短超时 → 必然判定未就绪
        let err = wait_healthy(
            "http://127.0.0.1:1".to_string(),
            Duration::from_millis(120),
            &log,
            offset,
        )
        .expect_err("不可达端口必须判定未就绪");
        let msg = err.to_string();
        assert!(
            msg.contains("MODULE LOADING") && msg.contains("BOOM: cannot bind port"),
            "错误信息应包含本轮引擎输出，实际：{msg}"
        );
        assert!(
            !msg.contains("OLD SUCCESS LINE"),
            "不得把历史启动记录当作本次失败原因，实际：{msg}"
        );
    }

    /// 零输出本身是独立诊断结论（进程卡在极早期），需显式说明。
    #[test]
    fn health_failure_flags_silent_engine() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("engine.log");
        std::fs::write(&log, "OLD SUCCESS LINE\n").unwrap();
        let offset = std::fs::metadata(&log).unwrap().len();

        let err = wait_healthy(
            "http://127.0.0.1:1".to_string(),
            Duration::from_millis(120),
            &log,
            offset,
        )
        .expect_err("静默引擎必须判定未就绪");
        let msg = err.to_string();
        assert!(
            msg.contains("没有任何输出"),
            "应明确指出本轮零输出，实际：{msg}"
        );
    }

    /// new_engine_output_lines：按 offset 切片、只保留末 max_lines 行、丢弃空行，
    /// offset 越界（日志被截断/轮转）时从头读。
    #[test]
    fn new_engine_output_lines_slices_by_offset_and_keeps_tail() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("engine.log");
        std::fs::write(&log, "a\nb\n\nc\nd\n").unwrap();

        // offset 2 落在 "b" 之前（"a\n" 之后）
        assert_eq!(new_engine_output_lines(&log, 2, 10), strs(&["b", "c", "d"]));
        // 末 2 行
        assert_eq!(new_engine_output_lines(&log, 0, 2), strs(&["c", "d"]));
        // offset 越界 → 从头读，不漏内容
        assert_eq!(new_engine_output_lines(&log, 9999, 10), strs(&["a", "b", "c", "d"]));
        // 文件不存在 → 空（不 panic）
        assert!(new_engine_output_lines(&dir.path().join("missing.log"), 0, 10).is_empty());
    }

    /// 壳的编排记录（`[shell] ` 前缀）必须剔除：否则「引擎已拉起」这一行
    /// 会让引擎的「零输出」被误判成「有输出」（真实故障现场就是这个形态）。
    /// 注意壳记录实际带 unix 秒时间戳前缀，两种形态都要覆盖。
    #[test]
    fn engine_output_lines_skip_shell_bookkeeping() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("engine.log");

        // 带时间戳（真实格式）+ 裸前缀（兼容形态）都要被剔除
        std::fs::write(
            &log,
            "1793548106 [shell] 引擎已拉起 pid=Some(1) port=2（仅绑定 127.0.0.1）\n\
             [shell] 引擎进程退出 code=Some(0)\n\
             real engine line\n",
        )
        .unwrap();
        assert_eq!(
            new_engine_output_lines(&log, 0, 10),
            strs(&["real engine line"]),
            "只应保留引擎自身输出"
        );

        // 整份新增内容都是壳记录 → 等价于引擎零输出（本次故障即此形态）
        std::fs::write(
            &log,
            "1793548106 [shell] 引擎已拉起 pid=Some(1) port=2（仅绑定 127.0.0.1）\n",
        )
        .unwrap();
        assert!(
            new_engine_output_lines(&log, 0, 10).is_empty(),
            "只有壳记录时必须判为空，否则会掩盖引擎零输出"
        );
    }

    /// 探活语义：/api/health 200 即就绪；连接拒绝未就绪。
    #[test]
    fn probe_health_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write_exec(dir.path(), "deepcode-m1-mock-engine.js", MOCK_ENGINE_SRC);
        let rt = test_runtime(dir.path(), entry);
        let dead_port = port::pick_free_port().unwrap();
        // 死端口：连接失败 → 未就绪
        assert!(!probe_health(&format!("http://127.0.0.1:{dead_port}")));

        rt.start().expect("就绪");
        // mock 引擎 /api/health 返回 200 → 就绪
        assert!(probe_health(&rt.base_url()));
        // 未知路径返回 404 → 语义上不算就绪（除非走 /api/config 回退）
        assert_eq!(
            http_get_status(&rt.base_url(), "/api/nonexistent"),
            Some(404)
        );
        rt.stop().unwrap();
    }

    /// settings 准备：enabled 注入 + 桌面账号 sha256 摘要，幂等不膨胀。
    #[test]
    fn prepare_settings_injects_desktop_user() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, r#"{"web":{"port":3999},"custom":{"keep":1}}"#).unwrap();

        prepare_engine_settings(&p, DESKTOP_USER, "s3cret").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["web"]["enabled"], Value::Bool(true));
        assert_eq!(v["custom"]["keep"], 1);
        let users = v["web"]["auth"]["localUsers"].as_array().unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["username"], DESKTOP_USER);
        // sha256("s3cret") 已知值交叉验证
        assert_eq!(
            users[0]["passwordHash"].as_str().unwrap(),
            config::sha256_hex(b"s3cret")
        );

        // 幂等：重复准备只更新摘要、不膨胀数组
        prepare_engine_settings(&p, DESKTOP_USER, "n3w").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let users = v["web"]["auth"]["localUsers"].as_array().unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["passwordHash"], config::sha256_hex(b"n3w"));
    }

    /// 固定口令开关：摘要命中 sha256("desktop") 才启用；缺失/非法/其他摘要一律关闭。
    #[test]
    fn fixed_password_toggle_detection() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");

        // 文件不存在 → 未启用（安全默认）
        assert!(!is_fixed_password_enabled(&p));

        // 摘要为其他口令 → 未启用
        std::fs::write(
            &p,
            format!(
                r#"{{"web":{{"auth":{{"localUsers":[{{"username":"desktop","passwordHash":"{}"}}]}}}}}}"#,
                config::sha256_hex(b"random-pwd")
            ),
        )
        .unwrap();
        assert!(!is_fixed_password_enabled(&p));

        // 摘要恰为 sha256("desktop") → 启用
        std::fs::write(
            &p,
            format!(
                r#"{{"web":{{"auth":{{"localUsers":[{{"username":"desktop","passwordHash":"{}"}}]}}}}}}"#,
                config::sha256_hex(FIXED_PASSWORD.as_bytes())
            ),
        )
        .unwrap();
        assert!(is_fixed_password_enabled(&p));

        // 大写 hex 也视为命中（引擎 matchLocalUser 规范化小写比较，行为对齐）
        std::fs::write(
            &p,
            format!(
                r#"{{"web":{{"auth":{{"localUsers":[{{"username":"desktop","passwordHash":"{}"}}]}}}}}}"#,
                config::sha256_hex(FIXED_PASSWORD.as_bytes()).to_uppercase()
            ),
        )
        .unwrap();
        assert!(is_fixed_password_enabled(&p));

        // settings 非法 JSON → 未启用
        std::fs::write(&p, "not json").unwrap();
        assert!(!is_fixed_password_enabled(&p));
    }

    #[test]
    fn state_constants_stable() {
        // 状态字符串是与 boot 页/状态条的前端契约，必须保持稳定
        assert_eq!(state::STOPPED, "stopped");
        assert_eq!(state::STARTING, "starting");
        assert_eq!(state::READY, "ready");
        assert_eq!(state::CRASHED, "crashed");
        assert_eq!(state::FAILED, "failed");
    }
}
