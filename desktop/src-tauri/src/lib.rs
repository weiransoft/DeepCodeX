//! DeepCode Desktop 壳层库入口。
//!
//! 架构（DCA-ARCH-DESKTOP-001 §2/§3.1）：
//! - Rust Core 是唯一特权层；WebView 零特权，仅能调用 `ipc.rs` 中
//!   `invoke_handler` 白名单内的命令；
//! - 启动流程：boot 引导页（静态兜底，引擎启动进度/错误兜底 UI）→
//!   EngineManager 拉起引擎 → 就绪后引导页跳转 `http://127.0.0.1:<port>` →
//!   初始化脚本注入的桌面桥在本页经 `engine_credentials`（仅引擎 origin 放行）
//!   同源登录 → 进入工作区；
//! - 纯浏览器访问引擎时 `window.__DEEPCODE_DESKTOP__` 不存在，
//!   Web 前端桌面专属 UI 全部隐藏（Web 独立可用零回归）。

mod config;
mod config_persist;
mod engine;
mod error;
mod ipc;
mod secrets;
mod tray;

use std::sync::Arc;

use engine::manager::EngineRuntime;
use tauri::Manager;

/// 桌面桥初始化脚本：注入到所有页面（boot 引导页 + 引擎 origin 页）。
///
/// - boot 页用它调用 `engine_status` / `engine_restart` 等命令；
/// - 引擎页用它供 Web 前端薄层（desktop-bridge.ts）检测桌面环境并调用
///   状态/重启/日志命令；`__TAURI_INTERNALS__` 采用惰性求值规避注入时序。
pub const DESKTOP_BRIDGE_SCRIPT: &str = r#"(function () {
  if (window.__DEEPCODE_DESKTOP__) { return; }
  function invoke(cmd, args) {
    var it = window.__TAURI_INTERNALS__;
    if (!it || typeof it.invoke !== "function") {
      return Promise.reject(new Error("Tauri IPC 不可用"));
    }
    return it.invoke(cmd, args || {});
  }
  window.__DEEPCODE_DESKTOP__ = Object.freeze({
    isDesktop: true,
    platform: "tauri-v2",
    invoke: invoke
  });
  // 引擎页自动登录：仅在引擎 origin 上 engine_credentials 才会放行（Rust 侧校验）。
  // 就绪后同源 fetch 登录换 HttpOnly Cookie；失败静默——引导页展示引擎自带登录页。
  var AUTO_KEY = "__DEEPCODE_AUTOLOGIN_DONE__";
  function tryAutoLogin() {
    if (window[AUTO_KEY]) { return; }
    var bridge = window.__DEEPCODE_DESKTOP__;
    if (!bridge || !bridge.invoke) { return; }
    bridge.invoke("engine_credentials").then(function (creds) {
      window[AUTO_KEY] = true;
      return fetch("/api/auth/me").then(function (r) {
        if (r.ok) { return null; }
        return fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: creds.username, password: creds.password })
        }).then(function (r2) {
          if (r2.ok) { window.location.reload(); }
        });
      });
    }).catch(function () { /* 非引擎 origin / 未就绪：静默跳过 */ });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryAutoLogin);
  } else {
    tryAutoLogin();
  }
})();
"#;

/// 阻塞终止信号（SIGTERM/SIGINT）：必须在任何线程创建前于主线程调用，
/// 之后创建的所有线程（tauri runtime、监督线程等）均继承屏蔽字——
/// 信号只能由 signal-watchdog 线程经 sigwait 同步收取，杜绝默认处置
/// 直接杀死进程导致引擎孤儿（PRD FR-1.4）。
#[cfg(unix)]
fn block_termination_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    }
}

/// 信号看门狗：sigwait 收到 SIGTERM/SIGINT → 优雅关闭引擎（SIGTERM → 3s →
/// SIGKILL）→ 退出。前提：信号已在主线程于一切线程创建前被屏蔽
/// （block_termination_signals），因此信号只会送达本线程。
/// Windows 无 POSIX 信号语义：进程树回收由 Job Object（KILL_ON_JOB_CLOSE）
/// 兜底，控制台关闭场景 M5 打包后统一验证。
#[cfg(unix)]
fn spawn_signal_watchdog(rt: Arc<EngineRuntime>, set: libc::sigset_t) {
    let _ = std::thread::Builder::new()
        .name("signal-watchdog".into())
        .spawn(move || {
            let mut sig: libc::c_int = 0;
            let rc = unsafe { libc::sigwait(&set, &mut sig) };
            if rc == 0 {
                log::info!("收到信号 {sig}，优雅关闭引擎后退出");
                engine::manager::cleanup_blocking(&rt);
                std::process::exit(0);
            }
        });
}

/// 应用入口（由 main.rs 调用；逻辑放 lib 以便测试复用）。
pub fn run() {
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .init();

    // 信号屏蔽必须先于 tauri runtime 的线程创建（见 block_termination_signals）
    #[cfg(unix)]
    let signal_set = block_termination_signals();
    #[cfg(not(unix))]
    let _ = ();

    tauri::Builder::default()
        .append_invoke_initialization_script(DESKTOP_BRIDGE_SCRIPT)
        .setup(move |app| {
            // 日志目录：应用数据目录下 logs/（FR-1.6，路径进 EngineStatus 供诊断展示）
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法解析应用数据目录: {e}"))?;
            let log_dir = data_dir.join("logs");
            std::fs::create_dir_all(&log_dir)?;

            let rt = Arc::new(EngineRuntime::new(
                config::EngineMode::System,
                log_dir,
                engine::manager::home_settings_path()?,
            ));
            // UI 联动（状态事件广播 + 崩溃恢复导航）
            rt.attach_app(app.handle().clone());
            app.manage(ipc::AppState {
                engine: Arc::clone(&rt),
            });

            // 先挂崩溃监督，再启动引擎（崩溃自动重启 ≤3 次，FR-1.3）
            rt.attach_exit_watch();
            // 信号看门狗：SIGTERM/SIGINT → 优雅关闭引擎后退出（FR-1.4）
            #[cfg(unix)]
            spawn_signal_watchdog(Arc::clone(&rt), signal_set);
            let rt2 = Arc::clone(&rt);
            std::thread::spawn(move || {
                if let Err(e) = rt2.start() {
                    log::error!("引擎首次启动失败: {e}");
                    // 状态已广播为 failed，boot 页据此展示重试入口与日志
                }
            });

            // 系统托盘（FR-1.5：显示/隐藏主窗口、退出=优雅关闭引擎后退出）
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::engine_status,
            ipc::engine_restart,
            ipc::engine_open_logs,
            ipc::engine_log_tail,
            ipc::engine_credentials,
            ipc::config_get,
            ipc::config_save,
            ipc::window_drag,
            ipc::window_new,
            ipc::boot_diag
        ])
        .build(tauri::generate_context!())
        .expect("构建 DeepCode Desktop 失败")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => {}
                // 全部退出路径兜底：优雅关闭引擎，不留孤儿进程（FR-1.4）
                tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<ipc::AppState>() {
                        engine::manager::cleanup_blocking(&state.engine);
                    }
                }
                _ => {}
            }
        });
}
