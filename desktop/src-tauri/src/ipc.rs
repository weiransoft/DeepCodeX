//! 全部 `#[tauri::command]` IPC 面（ARCH DCA-ARCH-DESKTOP-001 §3.1：
//! "ipc.rs —— 全部 #[tauri::command]，唯一前端入口"）。
//!
//! 白名单 = 本文件在 lib.rs `invoke_handler` 中注册的命令集合；
//! 前端经注入的 `window.__DEEPCODE_DESKTOP__` 桥（postMessage 代理 invoke）调用。
//! 阻塞操作（重启/停止）放入 spawn_blocking，避免卡主线程与 UI。

use std::sync::Arc;

use serde::Serialize;
use tauri::{State, WebviewWindow};

use crate::engine::manager::{EngineRuntime, EngineStatus};
use crate::error::ShellError;
use crate::ssh::manager::{ConnectRequest, ConnectResult, SessionStatus, SshManager};
use crate::ssh::targets::SshTarget;

/// 壳应用共享状态（lib.rs 定义，随 Tauri managed state 注入各命令）。
pub struct AppState {
    /// 本地引擎运行时
    pub engine: Arc<EngineRuntime>,
    /// SSH 远程连接管理器（单会话模型）
    pub ssh: Arc<SshManager>,
}

/// 引擎状态查询（boot 页与状态条共用；纯读不阻塞）。
#[tauri::command]
pub fn engine_status(state: State<AppState>) -> EngineStatus {
    state.engine.status()
}

/// boot 页诊断回传：页面 JS 把 `__TAURI__` 注入情况 / IPC 结果 / 错误堆栈
/// 发到壳日志（env_logger → 进程 stderr），用于排查"boot 页卡在启动中"类问题。
/// 仅记日志，无副作用；对页面零特权要求（invoke 白名单内）。
#[tauri::command]
pub fn boot_diag(msg: String) {
    log::info!("[boot-diag] {msg}");
}

/// 重启引擎：重置重启预算 → 优雅停止 → 重新拉起（boot 页"重试"与
/// 状态条"重启引擎"共用；阻塞操作放线程池）。
#[tauri::command]
pub async fn engine_restart(state: State<'_, AppState>) -> Result<EngineStatus, ShellError> {
    let rt = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || rt.restart())
        .await
        .map_err(|e| ShellError::EngineRuntime(format!("重启任务执行失败: {e}")))?
}

/// 打开引擎日志（FR-1.6：macOS 在 Finder 中定位日志文件；
/// Windows 用 explorer 定位；其余平台用 xdg-open 打开所在目录）。
#[tauri::command]
pub async fn engine_open_logs(state: State<'_, AppState>) -> Result<String, ShellError> {
    let path = state.engine.log_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| ShellError::Config(format!("打开日志失败: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| ShellError::Config(format!("打开日志失败: {e}")))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let dir = path.parent().unwrap_or(&path).to_path_buf();
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| ShellError::Config(format!("打开日志失败: {e}")))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 读取引擎日志尾部（诊断展示；最多 64 KiB，UTF-8 有损解码防截断多字节 panic）。
/// 返回前经已知密钥脱敏：历史日志中的密钥明文（若有）也不回传前端。
#[tauri::command]
pub fn engine_log_tail(state: State<AppState>) -> Result<String, ShellError> {
    const MAX_TAIL: u64 = 64 * 1024;
    let path = state.engine.log_path();
    if !path.exists() {
        return Ok(String::new());
    }
    let file = std::fs::File::open(&path)?;
    let meta = file.metadata()?;
    use std::io::{Read, Seek, SeekFrom};
    let mut file = file;
    let size = meta.len();
    if size > MAX_TAIL {
        file.seek(SeekFrom::End(-(MAX_TAIL as i64)))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(state.engine.redact_text(&String::from_utf8_lossy(&buf)))
}

/// 桌面会话登录凭据 `(baseUrl, username, password)`。
///
/// 安全边界：仅允许两类 origin 调用——
/// 1. **本地引擎 origin**（`http://127.0.0.1:<本地端口>`）；
/// 2. **活动 SSH 隧道 origin**（`http://127.0.0.1:<隧道端口>`，且必须有活动会话）。
///
/// 初始化脚本在页面内同源 fetch `/api/auth/login` 换 HttpOnly Cookie；
/// boot 引导页（tauri://localhost）与任何其他 origin 一律拒绝，
/// 口令不会跨 origin 泄露（隧道端口未建立会话时也不放行）。
#[tauri::command]
pub fn engine_credentials(
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<Credentials, ShellError> {
    let current = window
        .url()
        .map_err(|e| ShellError::Config(format!("无法读取窗口地址: {e}")))?;

    // 1) 本地引擎
    let base_url = state.engine.base_url();
    if is_engine_origin(current.as_str(), &base_url) {
        let (username, password) = state.engine.credentials()?;
        return Ok(Credentials {
            base_url,
            username,
            password,
        });
    }

    // 2) 远端引擎（SSH 隧道）：凭据仅存在于活动会话期间
    if let Some((port, username, password)) = state.ssh.tunnel_credentials() {
        let tunnel_base = format!("http://127.0.0.1:{port}");
        if is_engine_origin(current.as_str(), &tunnel_base) {
            return Ok(Credentials {
                base_url: tunnel_base,
                username,
                password,
            });
        }
    }

    Err(ShellError::Config(
        "engine_credentials 仅允许引擎/隧道 origin 页面调用".into(),
    ))
}

/// origin 三元组 `(scheme, host, port)`：host 小写归一、缺省端口按 scheme 归一
/// （http=80 / https=443），保证不同书写形态可精确比对。
type Origin = (String, String, u16);

/// 解析 URL 的 origin 三元组（最小解析，不为此引入 url crate 依赖）。
///
/// 只取 scheme://authority 段（authority 到首个 `/`、`?` 或 `#` 为止），
/// 剥离 userinfo（`user@host:port` 形态，本场景不存在，防御性处理）；
/// IPv6 字面量按 `[...]` 整体识别，端口段非纯数字时视为无端口。
fn parse_origin(url: &str) -> Option<Origin> {
    let (scheme, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    // 剥离 userinfo：取最后一个 '@' 之后的部分
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let default_port: u16 = if scheme.eq_ignore_ascii_case("https") {
        443
    } else {
        80
    };
    // 端口拆分：IPv6 字面量（带方括号）整体视作 host，仅在 ']' 之后找端口
    let (host, port) = if let Some(close) = authority.rfind(']') {
        match authority[close + 1..].strip_prefix(':') {
            Some(p) => match p.parse::<u16>() {
                Ok(p) => (&authority[..close + 1], p),
                Err(_) => (authority, default_port),
            },
            None => (authority, default_port),
        }
    } else {
        match authority.rfind(':') {
            Some(idx) => match authority[idx + 1..].parse::<u16>() {
                Ok(p) => (&authority[..idx], p),
                // 非数字段不是端口（防御：畸形 URL 一律拒绝）
                Err(_) => return None,
            },
            None => (authority, default_port),
        }
    };
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase(), port))
}

/// 引擎 origin 精确校验：scheme + host + port 三元组比对。
///
/// 不用前缀匹配：`http://127.0.0.1:1234` 前缀同样命中
/// `http://127.0.0.1:12345`（端口前缀碰撞），凭据会被发给错误的本机端口；
/// 解析后逐字段精确比对即可杜绝。
fn is_engine_origin(current: &str, base: &str) -> bool {
    match (parse_origin(current), parse_origin(base)) {
        (Some(c), Some(b)) => c == b,
        // 任何解析失败（畸形/非 http 形态）一律不放行
        _ => false,
    }
}

/// `engine_credentials` 返回结构。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    base_url: String,
    username: String,
    password: String,
}

/// 窗口拖动（桌面顶栏 mousedown 触发）。
///
/// 应用自定义命令走 `invoke_handler` 白名单，无需 capability 授权，且不依赖
/// Tauri 内置 `data-tauri-drag-region` 的注入脚本与 `core:window:allow-start-dragging`
/// ACL——在引擎 origin 远程页同样确定可用，作为顶栏拖拽的兜底通道。
#[tauri::command]
pub fn window_drag(window: WebviewWindow) -> Result<(), ShellError> {
    window
        .start_dragging()
        .map_err(|e| ShellError::Config(format!("窗口拖动失败: {e}")))
}

/// 新建窗口（PRD FR-4.1 多窗口形态的 M1 落位，顶栏「窗口」按钮入口）。
///
/// 行为：以当前引擎地址直接创建新窗口（仅引擎 ready 时允许——新窗口不经过
/// boot 引导页，引擎未就绪时应留在主窗口看引导/重试）。多窗口共享同一引擎
/// 进程；全部窗口关闭后壳退出并优雅回收引擎（lib.rs Exit 兜底不变）。
///
/// 桥初始化脚本是 Builder 级（append_invoke_initialization_script），对全部
/// 窗口生效——新窗口内桌面桥（engine_credentials 自动登录 / engine_status）同可用。
#[tauri::command]
pub fn window_new(app: tauri::AppHandle, state: State<AppState>) -> Result<String, ShellError> {
    if state.engine.status().state != "ready" {
        return Err(ShellError::Config("引擎未就绪，暂不能新建窗口".into()));
    }
    let base = state.engine.base_url();
    let url: tauri::Url = base
        .parse()
        .map_err(|e| ShellError::Config(format!("引擎地址解析失败: {e}")))?;

    // 唯一 label：毫秒时间戳（避免依赖窗口计数在关闭/重开时的竞态）
    let label = format!(
        "main-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let win = tauri::webview::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::External(url),
    )
    .title("DeepCode")
    .inner_size(1280.0, 820.0)
    .build()
    .map_err(|e| ShellError::Config(format!("创建窗口失败: {e}")))?;

    let _ = win.set_focus();
    Ok(label)
}

/// 读取桌面配置（模型 / MCP / 首次登录标志；API Key 不回传，仅 hasKey 标记）。
///
/// 与 `engine_status` 等命令一致，仅桌面 WebView（壳注入桥）可调用；
/// 不暴露任何密钥明文，故无需 `engine_credentials` 那样的 origin 校验。
#[tauri::command]
pub fn config_get() -> Result<crate::config_persist::DesktopConfig, ShellError> {
    crate::config_persist::read_desktop_config()
}

/// 保存桌面配置（模型元数据 + MCP 服务合并写入 settings.json；明文 API Key 进钥匙串）。
///
/// 入参 `payload` 为命名参数（前端经 `invoke("config_save", { payload })` 传入）；
/// 返回保存后的最新配置快照。
#[tauri::command]
pub fn config_save(
    payload: crate::config_persist::DesktopConfigSave,
) -> Result<crate::config_persist::DesktopConfig, ShellError> {
    crate::config_persist::save_desktop_config(payload)
}

// ───────────────────────────── SSH 远程连接（M2） ─────────────────────────────
//
// 闭环：目标列表/导入 → ssh_connect 四阶段 → 隧道就绪 → 主窗口导航到
// `http://127.0.0.1:<local_port>`（远端引擎）→ 注入脚本经 engine_credentials
// 自动登录 → ssh_disconnect 断开并导航回本地引擎。

/// 导入结果（前端据此提示"已导入 N 个"）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportResult {
    pub imported: usize,
    pub targets: Vec<SshTarget>,
}

/// 已保存的 SSH 目标列表。
#[tauri::command]
pub fn ssh_list_targets(state: State<AppState>) -> Result<Vec<SshTarget>, ShellError> {
    state.ssh.list_targets()
}

/// 导入 `~/.ssh/config`（按 `user@host:port` 去重合并，已存在则更新）。
#[tauri::command]
pub fn ssh_import_config(state: State<AppState>) -> Result<SshImportResult, ShellError> {
    let (targets, imported) = state.ssh.import_ssh_config()?;
    Ok(SshImportResult { imported, targets })
}

/// 删除一个目标。
#[tauri::command]
pub fn ssh_remove_target(state: State<AppState>, id: String) -> Result<Vec<SshTarget>, ShellError> {
    state.ssh.forget(&id)
}

/// 会话状态（前端在连接期间轮询以推进四阶段进度；页面刷新后也可恢复）。
#[tauri::command]
pub fn ssh_status(state: State<AppState>) -> SessionStatus {
    state.ssh.status()
}

/// 建立 SSH 远程连接（四阶段，阻塞操作放线程池）。
///
/// 成功后**导航主窗口到隧道地址**——远端引擎有自己的 Web UI，
/// 整页交由它承载比在本地面板里代理 API 更简单也更不易走样。
#[tauri::command]
pub async fn ssh_connect(
    window: WebviewWindow,
    state: State<'_, AppState>,
    req: ConnectRequest,
) -> Result<ConnectResult, ShellError> {
    let mgr = Arc::clone(&state.ssh);
    let result = tauri::async_runtime::spawn_blocking(move || {
        // 进度已写入 mgr.progress，ssh_status 轮询可见，此处回调留空
        mgr.connect(&req, |_, _| {})
    })
    .await
    .map_err(|e| ShellError::EngineRuntime(format!("SSH 连接任务执行失败: {e}")))??;

    // 导航到远端引擎：失败不回滚连接（会话仍可用，只是没能自动跳转）
    let url = format!("http://127.0.0.1:{}/", result.local_port);
    if let Err(e) = navigate_to(&window, &url) {
        log::warn!("SSH 已连接，但窗口导航失败（可手动访问 {url}）：{e}");
    }
    Ok(result)
}

/// 断开远程连接并把窗口导航回本地引擎。
#[tauri::command]
pub async fn ssh_disconnect(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), ShellError> {
    let mgr = Arc::clone(&state.ssh);
    tauri::async_runtime::spawn_blocking(move || mgr.disconnect())
        .await
        .map_err(|e| ShellError::EngineRuntime(format!("SSH 断开任务执行失败: {e}")))?;

    let base = state.engine.base_url();
    if let Err(e) = navigate_to(&window, &format!("{base}/")) {
        log::warn!("SSH 已断开，但窗口导航回本地引擎失败：{e}");
    }
    Ok(())
}

/// 让窗口导航到指定 http origin（Tauri 2 `navigate` 需要 `Url` 类型）。
fn navigate_to(window: &WebviewWindow, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("非法地址 {url}: {e}"))?;
    window.navigate(parsed).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_origin_rejects_port_prefix_collision() {
        // QA 低危加固回归用例：引擎在 :1234 时，:12345 不得放行（凭据不可发给错误端口）
        assert!(!is_engine_origin(
            "http://127.0.0.1:12345/",
            "http://127.0.0.1:1234"
        ));
        // 反向同样不放行
        assert!(!is_engine_origin(
            "http://127.0.0.1:1234/",
            "http://127.0.0.1:12345"
        ));
    }

    #[test]
    fn engine_origin_accepts_exact_origin_any_path() {
        let base = "http://127.0.0.1:63192";
        // 同 origin 任意路径/查询/锚点均放行（同源判定与路径无关）
        assert!(is_engine_origin("http://127.0.0.1:63192/", base));
        assert!(is_engine_origin("http://127.0.0.1:63192/app/main", base));
        assert!(is_engine_origin(
            "http://127.0.0.1:63192/api/auth/login?x=1#a",
            base
        ));
    }

    #[test]
    fn engine_origin_rejects_mismatched_fields() {
        let base = "http://127.0.0.1:1234";
        // scheme 不同
        assert!(!is_engine_origin("https://127.0.0.1:1234/", base));
        // host 不同（localhost ≠ 127.0.0.1，origin 判定不做同义归并）
        assert!(!is_engine_origin("http://localhost:1234/", base));
        // host 大小写归一后相同则放行（域名大小写不敏感语义）
        assert!(is_engine_origin(
            "http://LocalHost:1234/",
            "http://localhost:1234"
        ));
        // 缺省端口按 scheme 归一（http 默认 80）
        assert!(is_engine_origin("http://127.0.0.1/", "http://127.0.0.1:80"));
        // 缺省端口不等于非默认端口
        assert!(!is_engine_origin("http://127.0.0.1/", base));
        // 非法形态（无 scheme / 空串）一律拒绝
        assert!(!is_engine_origin("tauri://localhost/boot.html", base));
        assert!(!is_engine_origin("", base));
        assert!(!is_engine_origin("127.0.0.1:1234", base));
    }
}
