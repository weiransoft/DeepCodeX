//! desktop-agent 策略持久化与校验（方案 §4.4 / §5「编排在引擎、执行在 sidecar、授权在壳」）。
//!
//! 职责红线：**壳只管授权，不碰 GUI**。本模块负责把能力开关与按应用授权
//! 落到 `~/.deepcode/desktop-agent.json`（0600/unix），供独立 sidecar 启动时
//! 经 `DEEPCODE_AGENT_POLICY` 读取。窗口枚举、a11y 树、截图、输入注入一律
//! 不进 IPC 面——WebView 保持零系统特权（PRD NFR-3）。
//!
//! 三条硬约束（方案 §6 上线阻塞项 R2/R3/R8）：
//! 1. 敏感分类、截屏/坐标通道、预算上限是**不可写字段**：既不接受前端入参，
//!    也会在读取落盘文件时强制复位，防止手工篡改配置文件放宽底线；
//! 2. `permissionMode` 只允许 manual/auto，`bypass` 会被降级为 manual——
//!    避免 WebView 侧提示注入把权限模式提权；
//! 3. 所有来自前端的标识与 scope 在边界处校验，非法输入直接拒绝而非静默吞掉。
//!
//! P1 阶段策略在 sidecar 进程启动时读取一次，变更需重启引擎（连带重启 MCP
//! sidecar）；热更新通道属 P2，故状态里显式返回 `restartHint`。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::settings::{home_settings_path, write_private};
use crate::error::ShellError;

/// 策略文件名（与 settings.json / desktop.json 同目录，避免被引擎白名单重写）。
pub const POLICY_FILE: &str = "desktop-agent.json";

/// 引擎 MCP 配置中 sidecar 的约定名。
pub const SIDECAR_MCP_NAME: &str = "desktop-agent";

const MAX_ENTRIES: usize = 64;
const MAX_ID_LEN: usize = 128;

fn default_denied_categories() -> Vec<String> {
    ["finance", "crypto", "medical", "government", "finance-or-sensitive"]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// 按应用授权条目（camelCase 与 sidecar policy 完全一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppGrant {
    pub app_id: String,
    pub always: bool,
    pub scopes: Vec<String>,
}

impl Default for AppGrant {
    fn default() -> Self {
        Self { app_id: String::new(), always: false, scopes: Vec::new() }
    }
}

/// 前端**可写**的授权面（不含 enabled，开关由 toggle 单独控制）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPermissions {
    pub permission_mode: String,
    pub allowed_apps: Vec<AppGrant>,
    pub denied_apps: Vec<String>,
}

impl Default for AgentPermissions {
    fn default() -> Self {
        Self { permission_mode: "manual".into(), allowed_apps: Vec::new(), denied_apps: Vec::new() }
    }
}

/// 落盘的完整策略：字段与 `desktop-agent/config/policy.default.json` 对齐，
/// 因此 sidecar 的 `loadPolicy()` 可以直接消费，无需二次转换。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPolicy {
    pub enabled: bool,
    pub permission_mode: String,
    pub allowed_apps: Vec<AppGrant>,
    pub denied_apps: Vec<String>,
    pub denied_categories: Vec<String>,
    pub prefer_browser_channel: bool,
    pub allow_coordinate_input: bool,
    pub allow_screenshot: bool,
    pub max_steps: u32,
    pub max_screenshots: u32,
    pub max_tokens: u64,
    pub max_retries: u32,
}

impl Default for AgentPolicy {
    fn default() -> Self {
        Self {
            enabled: false, // 默认关闭：最小权限
            permission_mode: "manual".into(),
            allowed_apps: Vec::new(),
            denied_apps: Vec::new(),
            denied_categories: default_denied_categories(),
            prefer_browser_channel: true,
            allow_coordinate_input: false,
            allow_screenshot: false,
            max_steps: 25,
            max_screenshots: 3,
            max_tokens: 60_000,
            max_retries: 2,
        }
    }
}

impl AgentPolicy {
    pub fn permissions(&self) -> AgentPermissions {
        AgentPermissions {
            permission_mode: self.permission_mode.clone(),
            allowed_apps: self.allowed_apps.clone(),
            denied_apps: self.denied_apps.clone(),
        }
    }
}

/// 系统权限引导（方案 §1.5：macOS 需辅助功能+录屏，Windows 需交互式桌面会话）。
/// 壳**不检测**系统授权状态（需要 .NET/AX 特权），只返回可行动的引导文案。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformPermissionGuide {
    pub platform: String,
    pub required: Vec<String>,
    pub checkable_by_shell: bool,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub enabled: bool,
    pub permissions: AgentPermissions,
    pub denied_categories: Vec<String>,
    pub policy_path: String,
    /// 引擎 settings.json 的 mcpServers 里是否已登记 sidecar
    pub sidecar_registered: bool,
    /// 前端无权修改的字段（用于 UI 置灰与审计说明）
    pub locked_fields: Vec<String>,
    pub restart_hint: String,
    pub platform_permissions: PlatformPermissionGuide,
}

pub fn policy_path() -> Result<PathBuf, ShellError> {
    let mut path = home_settings_path()?;
    path.set_file_name(POLICY_FILE);
    Ok(path)
}

fn valid_id(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty()
        && t.chars().count() <= MAX_ID_LEN
        // 允许中文进程名，但禁止控制字符与路径分隔符（防路径穿越/注入）
        && !t.chars().any(|c| c.is_control() || c == '/' || c == '\\')
}

/**
 * 硬化：把不可写字段强制复位到安全默认。
 * 读文件与写文件都会经过这里——落盘文件被视为**不可信输入**。
 */
fn harden(mut p: AgentPolicy) -> AgentPolicy {
    p.denied_categories = default_denied_categories();
    p.allow_coordinate_input = false;
    p.allow_screenshot = false;
    p.prefer_browser_channel = true;
    if p.permission_mode != "auto" {
        p.permission_mode = "manual".into(); // bypass 一律降级
    }
    p.max_steps = p.max_steps.clamp(1, 100);
    p.max_screenshots = p.max_screenshots.clamp(0, 10);
    p.max_tokens = p.max_tokens.clamp(1_000, 200_000);
    p.max_retries = p.max_retries.clamp(0, 5);
    p.allowed_apps.retain(|g| valid_id(&g.app_id));
    p.allowed_apps.truncate(MAX_ENTRIES);
    for g in &mut p.allowed_apps {
        g.scopes.retain(|s| s == "read" || s == "write");
        g.app_id = g.app_id.trim().to_string();
    }
    p.denied_apps.retain(|s| valid_id(s));
    p.denied_apps.truncate(MAX_ENTRIES);
    p
}

pub fn read_policy() -> Result<AgentPolicy, ShellError> {
    let path = policy_path()?;
    if !path.exists() {
        return Ok(AgentPolicy::default());
    }
    let text = std::fs::read_to_string(&path)?;
    let parsed: AgentPolicy = serde_json::from_str(&text).unwrap_or_else(|e| {
        log::warn!("[desktop-agent] 策略文件解析失败，回落安全默认值：{e}");
        AgentPolicy::default()
    });
    Ok(harden(parsed))
}

fn write_policy(p: &AgentPolicy) -> Result<(), ShellError> {
    let path = policy_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(p)
        .map_err(|e| ShellError::Config(format!("desktop-agent 策略序列化失败: {e}")))?;
    write_private(path.as_path(), json.as_bytes())
}

/// 引擎 MCP 配置里是否登记了 sidecar（只读探测，不修改 settings.json）。
fn sidecar_registered() -> bool {
    let Ok(path) = home_settings_path() else { return false };
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(cfg) = serde_json::from_str::<Value>(&text) else { return false };
    cfg.get("mcpServers")
        .and_then(|m| m.get(SIDECAR_MCP_NAME))
        .is_some()
}

fn platform_guide() -> PlatformPermissionGuide {
    if cfg!(target_os = "macos") {
        PlatformPermissionGuide {
            platform: "macos".into(),
            required: vec!["辅助功能（Accessibility）".into(), "屏幕录制（Screen Recording）".into()],
            checkable_by_shell: false,
            hint: "首次启用需在系统设置 → 隐私与安全性中授权；未授权时 sidecar 应返回 CAPABILITY_UNAVAILABLE 而非伪造观察结果".into(),
        }
    } else if cfg!(target_os = "windows") {
        PlatformPermissionGuide {
            platform: "windows".into(),
            required: vec!["交互式桌面会话（非 Session 0）".into()],
            checkable_by_shell: false,
            hint: "窗口枚举用 tasklist（无需提权）；a11y 树/截图/输入注入需 UIA 桥，遇 UAC 安全桌面一律交还人工".into(),
        }
    } else {
        PlatformPermissionGuide {
            platform: "other".into(),
            required: vec!["对应平台的无障碍/截屏授权".into()],
            checkable_by_shell: false,
            hint: "P1 仅实现 Windows 主干，其余平台回落 mock 后端".into(),
        }
    }
}

pub fn status() -> Result<AgentStatus, ShellError> {
    let p = read_policy()?;
    let path = policy_path()?;
    Ok(AgentStatus {
        enabled: p.enabled,
        permissions: p.permissions(),
        denied_categories: p.denied_categories.clone(),
        policy_path: path.to_string_lossy().into_owned(),
        sidecar_registered: sidecar_registered(),
        locked_fields: vec![
            "deniedCategories".into(),
            "allowScreenshot".into(),
            "allowCoordinateInput".into(),
            "preferBrowserChannel".into(),
            "maxSteps/maxTokens/maxRetries".into(),
        ],
        restart_hint: "策略由 sidecar 启动时读取一次；修改开关或授权后需重启引擎才会生效（P2 再做热更新）".into(),
        platform_permissions: platform_guide(),
    })
}

/// 能力开关。关闭时也要落盘（sidecar 读到 enabled=false 才会拒绝动作）。
pub fn set_enabled(enabled: bool) -> Result<AgentStatus, ShellError> {
    let mut p = read_policy()?;
    p.enabled = enabled;
    write_policy(&harden(p))?;
    log::info!("[desktop-agent] enabled={enabled}");
    status()
}

/// 按应用授权：**严格校验**前端入参，非法值直接拒绝（不静默丢弃）。
pub fn set_permissions(input: AgentPermissions) -> Result<AgentStatus, ShellError> {
    if input.permission_mode == "bypass" {
        return Err(ShellError::Config(
            "不允许通过桌面 IPC 启用 bypass 权限模式".into(),
        ));
    }
    if input.permission_mode != "manual" && input.permission_mode != "auto" {
        return Err(ShellError::Config(
            "permissionMode 只能是 manual 或 auto".into(),
        ));
    }
    if input.allowed_apps.len() > MAX_ENTRIES || input.denied_apps.len() > MAX_ENTRIES {
        return Err(ShellError::Config(format!("授权条目数不得超过 {MAX_ENTRIES}")));
    }
    for g in &input.allowed_apps {
        if !valid_id(&g.app_id) {
            return Err(ShellError::Config(format!("非法 appId：{}", g.app_id)));
        }
        for s in &g.scopes {
            if s != "read" && s != "write" {
                return Err(ShellError::Config(format!("非法 scope：{s}（只允许 read/write）")));
            }
        }
    }
    for id in &input.denied_apps {
        if !valid_id(id) {
            return Err(ShellError::Config(format!("非法 deniedApps 项：{id}")));
        }
    }

    let mut p = read_policy()?;
    p.permission_mode = input.permission_mode;
    p.allowed_apps = input.allowed_apps;
    p.denied_apps = input.denied_apps;
    let count = p.allowed_apps.len();
    write_policy(&harden(p))?;
    log::info!("[desktop-agent] 授权已更新（{count} 个应用）");
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harden_restores_locked_fields() {
        let p = AgentPolicy {
            enabled: true,
            permission_mode: "bypass".into(),
            allow_screenshot: true,
            allow_coordinate_input: true,
            denied_categories: vec![],
            max_steps: 9999,
            ..Default::default()
        };
        let h = harden(p);
        assert_eq!(h.permission_mode, "manual");
        assert!(!h.allow_screenshot);
        assert!(!h.allow_coordinate_input);
        assert_eq!(h.denied_categories.len(), 5);
        assert_eq!(h.max_steps, 100);
    }

    #[test]
    fn harden_drops_invalid_ids_and_scopes() {
        let p = AgentPolicy {
            allowed_apps: vec![AppGrant {
                app_id: "../evil".into(),
                always: true,
                scopes: vec!["write".into(), "admin".into()],
            }],
            ..Default::default()
        };
        let h = harden(p);
        assert!(h.allowed_apps.is_empty());
    }

    #[test]
    fn set_permissions_rejects_bypass_and_bad_scope() {
        // 纯校验路径：不落盘（会在构造输入后于校验阶段返回 Err）
        let mut input = AgentPermissions::default();
        input.permission_mode = "bypass".into();
        assert!(set_permissions(input).is_err());
        let mut input2 = AgentPermissions::default();
        input2.allowed_apps.push(AppGrant {
            app_id: "notepad".into(),
            always: true,
            scopes: vec!["admin".into()],
        });
        assert!(set_permissions(input2).is_err());
    }
}
