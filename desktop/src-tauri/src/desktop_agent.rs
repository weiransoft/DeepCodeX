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
//! 策略通道：壳写 `desktop-agent.json`，sidecar 在启动时读一次、**并在每个工具
//! 调用前重判一次**（`policy-load.mjs::PolicyReloader`）。因此授权与撤销都即时
//! 生效，不需要重启引擎；`restartHint` 现在只提示「首次登记 MCP 服务」这一种
//! 需要重启的场景。落盘文件始终按不可信输入处理，两侧各自重跑硬化规则。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::settings::{home_settings_path, write_private};
use crate::error::ShellError;

/// 策略文件名（与 settings.json / desktop.json 同目录，避免被引擎白名单重写）。
pub const POLICY_FILE: &str = "desktop-agent.json";

/// 视觉授权的审计流水（只记 appId/时长/时间，绝不记画面或文本）。
pub const AUDIT_FILE: &str = "desktop-agent-audit.jsonl";

/// 引擎 MCP 配置中 sidecar 的约定名。
pub const SIDECAR_MCP_NAME: &str = "desktop-agent";

const MAX_ENTRIES: usize = 64;
const MAX_ID_LEN: usize = 128;

// ─────────── 视觉通道的限时授权（方案 §3.12 的闸门） ───────────
//
// 为什么不是"一个布尔开关"：截图 + 坐标点击能读屏、能代用户点，风险和
// "列窗口"完全不是一个量级。所以它被设计成**一次显式、限时、按应用**的授权：
//   - 前端要先拿 challenge（一次性令牌），再带着令牌提交 grant；
//   - 令牌 5 分钟内有效、用一次即废，防止误触/重放；
//   - 授权只能覆盖已经拿到 read 权限的应用，不能顺手解锁未授权应用；
//   - 有效期上限 24 h、下限 1 min，到点自动失效（不需要用户记得来关）；
//   - 每次授权/撤销都写审计流水（JSONL，只记 appId 与时长）。
// 落盘文件仍是不可信输入：读取时按同一套规则重新裁剪（过期即失效）。

/// 视觉授权有效期上限（24 h）
pub const VISION_MAX_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// 视觉授权有效期下限（1 min）
pub const VISION_MIN_TTL_MS: u64 = 60 * 1000;
/// 一次性确认令牌有效期（5 min）
pub const VISION_CHALLENGE_TTL_MS: u64 = 5 * 60 * 1000;

/// 视觉通道授权（限时 + 按应用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VisionGrant {
    /// 允许截图/坐标点击的 appId 白名单（空 = 无效授权）
    pub apps: Vec<String>,
    /// 是否允许坐标点击（false = 只允许截图观察）
    pub allow_coordinate_input: bool,
    /// 授权时刻（Unix 毫秒）
    pub granted_at: u64,
    /// 失效时刻（Unix 毫秒）
    pub expires_at: u64,
    /// 审计 id（每次授权唯一）
    pub grant_id: String,
}

impl Default for VisionGrant {
    fn default() -> Self {
        Self {
            apps: Vec::new(),
            allow_coordinate_input: false,
            granted_at: 0,
            expires_at: 0,
            grant_id: String::new(),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn dedup_ids(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() || out.iter().any(|s| s == &id) {
            continue;
        }
        out.push(id);
    }
    out
}

/// 规范化视觉授权：非法/过期/超长/空清单一律作废（返回 None）。
/// 纯函数，`now` 可注入——Rust 单测与 sidecar 侧口径靠它对齐。
fn normalize_vision(raw: Option<VisionGrant>, now: u64) -> Option<VisionGrant> {
    let mut v = raw?;
    v.apps.retain(|a| valid_id(a));
    v.apps = dedup_ids(std::mem::take(&mut v.apps));
    v.apps.truncate(MAX_ENTRIES);
    if v.apps.is_empty() {
        return None;
    }
    // 未标授权时刻、或授权时刻在"未来"（时钟可疑）一律不信
    if v.granted_at == 0 || v.granted_at > now.saturating_add(VISION_CHALLENGE_TTL_MS) {
        return None;
    }
    if v.expires_at <= v.granted_at {
        return None;
    }
    let cap = v.granted_at.saturating_add(VISION_MAX_TTL_MS);
    if v.expires_at > cap {
        v.expires_at = cap;
    }
    if v.expires_at <= now {
        return None;
    }
    if v.grant_id.trim().is_empty() {
        v.grant_id = "legacy".into();
    }
    Some(v)
}

fn random_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 一次性确认令牌（进程内保存，重启即失效——授权本就是要"当场确认"）
struct PendingChallenge {
    token: String,
    expires_at: u64,
}

static PENDING_VISION: Mutex<Option<PendingChallenge>> = Mutex::new(None);


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
    /// 视觉通道的限时授权；`allow_screenshot` / `allow_coordinate_input`
    /// 由它**派生**（见 harden），因此不能由前端直接写。
    pub vision: Option<VisionGrant>,
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
            vision: None,
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
    /// 视觉通道授权（None = 未开。含到期时间，UI 可显示倒计时）
    pub vision: Option<VisionStatus>,
    /// 引擎 settings.json 的 mcpServers 里是否已登记 sidecar
    pub sidecar_registered: bool,
    /// 前端无权修改的字段（用于 UI 置灰与审计说明）
    pub locked_fields: Vec<String>,
    /// 何时才需要重启引擎（策略变更已不需要，见 §3.14）
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
    // 视觉通道由限时授权**派生**，而不是可写字段：授权过期/清单为空/超长，
    // 这里就自动收回。手工改文件放宽不了（读与写都过这里）。
    p.vision = normalize_vision(p.vision.take(), now_ms());
    p.allow_screenshot = p.vision.is_some();
    p.allow_coordinate_input = p
        .vision
        .as_ref()
        .map(|v| v.allow_coordinate_input)
        .unwrap_or(false);
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

/// 视觉授权状态（供 UI 显示倒计时与"已授权的应用"，不含任何画面内容）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionStatus {
    pub apps: Vec<String>,
    pub allow_coordinate_input: bool,
    pub granted_at: u64,
    pub expires_at: u64,
    pub remaining_ms: u64,
    pub grant_id: String,
}

fn vision_status(p: &AgentPolicy, now: u64) -> Option<VisionStatus> {
    p.vision.as_ref().map(|v| VisionStatus {
        apps: v.apps.clone(),
        allow_coordinate_input: v.allow_coordinate_input,
        granted_at: v.granted_at,
        expires_at: v.expires_at,
        remaining_ms: v.expires_at.saturating_sub(now),
        grant_id: v.grant_id.clone(),
    })
}

/// 一次性确认令牌的发放结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionChallengeInfo {
    pub token: String,
    /// UI 要原样展示给用户的确认文案（人读的那一句）
    pub prompt: String,
    pub expires_in_ms: u64,
    pub max_ttl_minutes: u32,
    /// 可被授权的应用（只能是已获得 read 权限的应用）
    pub grantable_apps: Vec<String>,
}

/// 授权入参。`token` 必须来自 `vision_challenge`，且只能用一次。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VisionGrantInput {
    pub token: String,
    pub apps: Vec<String>,
    pub allow_coordinate_input: bool,
    pub ttl_minutes: u32,
}

impl Default for VisionGrantInput {
    fn default() -> Self {
        Self {
            token: String::new(),
            apps: Vec::new(),
            allow_coordinate_input: false,
            ttl_minutes: 30,
        }
    }
}

/// 已拿到 read 权限的应用（视觉授权只能在这个集合内选）。
fn read_grantable_apps(p: &AgentPolicy) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for g in &p.allowed_apps {
        if g.scopes.iter().any(|s| s == "read") && !out.iter().any(|s| s == &g.app_id) {
            out.push(g.app_id.clone());
        }
    }
    out
}

/// 写一条审计流水。**只记 appId / 时长 / 时间，绝不记画面、标题或文本。**
fn append_audit(entry: serde_json::Value) -> Result<(), ShellError> {
    use std::io::Write;
    let mut path = home_settings_path()?;
    path.set_file_name(AUDIT_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = format!("{entry}\n");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(line.as_bytes())?;
    Ok(())
}

/// 申请一次性确认令牌。UI 必须把 `prompt` 展示给用户，用户确认后再提交 grant。
pub fn vision_challenge() -> Result<VisionChallengeInfo, ShellError> {
    let p = read_policy()?;
    if !p.enabled {
        return Err(ShellError::Config(
            "请先开启 desktop-agent，再申请视觉授权".into(),
        ));
    }
    let grantable = read_grantable_apps(&p);
    if grantable.is_empty() {
        return Err(ShellError::Config(
            "视觉授权只能授予已获 read 权限的应用：请先在授权列表里加入目标应用".into(),
        ));
    }
    let token = random_token();
    let expires_at = now_ms().saturating_add(VISION_CHALLENGE_TTL_MS);
    let prompt = format!(
        "接下来 5 分钟内确认的视觉授权，会让 desktop-agent 在这段时间里截取下列应用的屏幕\
         （并可能代你点击坐标）：{}。授权到期自动失效，可随时撤销。",
        grantable.join("、")
    );
    *PENDING_VISION.lock().unwrap() = Some(PendingChallenge { token: token.clone(), expires_at });
    Ok(VisionChallengeInfo {
        token,
        prompt,
        expires_in_ms: VISION_CHALLENGE_TTL_MS,
        max_ttl_minutes: (VISION_MAX_TTL_MS / 60_000) as u32,
        grantable_apps: grantable,
    })
}

/// 校验并消费一次性令牌。失败一律拒绝（不重试、不延长）。
fn consume_challenge(token: &str, now: u64) -> Result<(), ShellError> {
    let mut guard = PENDING_VISION.lock().unwrap();
    let Some(pending) = guard.as_ref() else {
        return Err(ShellError::Config(
            "没有待确认的视觉授权，请重新发起（令牌只能用一次）".into(),
        ));
    };
    let matched = !token.trim().is_empty() && pending.token == token.trim();
    let fresh = pending.expires_at > now;
    // 无论成功失败都作废：令牌是一次性的，失败也得重新领
    *guard = None;
    if !matched {
        return Err(ShellError::Config("确认令牌不匹配".into()));
    }
    if !fresh {
        return Err(ShellError::Config("确认令牌已过期，请重新发起".into()));
    }
    Ok(())
}

/// 纯校验：返回规范化后的授权（不写盘），便于单测覆盖全部拒绝分支。
fn validate_grant(
    p: &AgentPolicy,
    input: &VisionGrantInput,
    now: u64,
) -> Result<VisionGrant, ShellError> {
    if !p.enabled {
        return Err(ShellError::Config("desktop-agent 未开启，不能授予视觉通道".into()));
    }
    let apps = dedup_ids(input.apps.clone());
    if apps.is_empty() {
        return Err(ShellError::Config("至少选择一个应用".into()));
    }
    if apps.len() > MAX_ENTRIES {
        return Err(ShellError::Config(format!("授权条目数不得超过 {MAX_ENTRIES}")));
    }
    let grantable = read_grantable_apps(p);
    for app in &apps {
        if !valid_id(app) {
            return Err(ShellError::Config(format!("非法 appId：{app}")));
        }
        if !grantable.iter().any(|a| a == app) {
            return Err(ShellError::Config(format!(
                "{app} 不在已授权的应用列表里（需先授予 read 权限）"
            )));
        }
    }
    let ttl_ms = (input.ttl_minutes.max(1) as u64)
        .saturating_mul(60_000)
        .clamp(VISION_MIN_TTL_MS, VISION_MAX_TTL_MS);
    Ok(VisionGrant {
        apps,
        allow_coordinate_input: input.allow_coordinate_input,
        granted_at: now,
        expires_at: now.saturating_add(ttl_ms),
        grant_id: random_token(),
    })
}

/// 提交授权：令牌校验 → 入参校验 → 落盘 → 审计。任一步失败即不授权。
pub fn grant_vision(input: VisionGrantInput) -> Result<AgentStatus, ShellError> {
    let now = now_ms();
    consume_challenge(&input.token, now)?;
    let p = read_policy()?;
    let grant = validate_grant(&p, &input, now)?;
    let ttl_ms = grant.expires_at.saturating_sub(grant.granted_at);
    let audit = serde_json::json!({
        "ts": now,
        "event": "vision.grant",
        "grantId": grant.grant_id,
        "apps": grant.apps,
        "allowCoordinateInput": grant.allow_coordinate_input,
        "ttlMs": ttl_ms,
    });
    // 审计写不进去就不授权：留不下记录的授权等于没有留下边界
    append_audit(audit)?;
    let mut next = p;
    next.vision = Some(grant);
    write_policy(&harden(next))?;
    log::info!("[desktop-agent] 视觉通道已授权（{} 个应用，{} 分钟）", input.apps.len(), ttl_ms / 60_000);
    status()
}

/// 立即撤销（不必等到期）。
pub fn revoke_vision() -> Result<AgentStatus, ShellError> {
    let mut p = read_policy()?;
    let grant_id = p.vision.as_ref().map(|v| v.grant_id.clone());
    p.vision = None;
    write_policy(&harden(p))?;
    append_audit(serde_json::json!({
        "ts": now_ms(),
        "event": "vision.revoke",
        "grantId": grant_id,
    }))?;
    log::info!("[desktop-agent] 视觉通道已撤销");
    status()
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
        vision: vision_status(&p, now_ms()),
        sidecar_registered: sidecar_registered(),
        locked_fields: vec![
            "deniedCategories".into(),
            "preferBrowserChannel".into(),
            "maxSteps/maxTokens/maxRetries".into(),
            "allowScreenshot/allowCoordinateInput（由限时视觉授权派生，请走 visionGrant）".into(),
        ],
        restart_hint: "开关/授权/撤销由 sidecar 在每次工具调用前重读策略文件，即时生效，无需重启引擎；仅首次登记 desktop-agent MCP 服务后需重启引擎以让 McpManager 拉起 sidecar".into(),
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

    // ── 视觉通道限时授权 ──────────────────────────────────────────

    fn enabled_policy() -> AgentPolicy {
        AgentPolicy {
            enabled: true,
            allowed_apps: vec![
                AppGrant {
                    app_id: "notepad".into(),
                    always: true,
                    scopes: vec!["read".into(), "write".into()],
                },
                AppGrant {
                    app_id: "charmap".into(),
                    always: true,
                    scopes: vec!["read".into()],
                },
            ],
            ..Default::default()
        }
    }

    fn grant(apps: &[&str], coord: bool, granted_at: u64, ttl_ms: u64) -> VisionGrant {
        VisionGrant {
            apps: apps.iter().map(|s| (*s).to_string()).collect(),
            allow_coordinate_input: coord,
            granted_at,
            expires_at: granted_at + ttl_ms,
            grant_id: "g1".into(),
        }
    }

    #[test]
    fn harden_derives_vision_flags_from_grant() {
        let now = now_ms();
        // 无授权：截图与坐标都被收回
        let p = AgentPolicy { vision: None, ..enabled_policy() };
        let h = harden(p);
        assert!(!h.allow_screenshot && !h.allow_coordinate_input);

        // 只读视觉：能截图，不能坐标点击
        let p = AgentPolicy { vision: Some(grant(&["charmap"], false, now, 60_000)), ..enabled_policy() };
        let h = harden(p);
        assert!(h.allow_screenshot);
        assert!(!h.allow_coordinate_input);
        assert_eq!(h.vision.as_ref().unwrap().apps, vec!["charmap".to_string()]);

        // 带坐标点击
        let p = AgentPolicy { vision: Some(grant(&["charmap"], true, now, 60_000)), ..enabled_policy() };
        assert!(harden(p).allow_coordinate_input);
    }

    #[test]
    fn harden_revokes_expired_or_malformed_vision() {
        let now = now_ms();
        // 已过期
        let p = AgentPolicy {
            vision: Some(grant(&["charmap"], true, now - 120_000, 60_000)),
            ..enabled_policy()
        };
        let h = harden(p);
        assert!(h.vision.is_none() && !h.allow_screenshot && !h.allow_coordinate_input);

        // 空清单 = 无效授权（不能靠"授权了 0 个应用"解锁全局截图）
        let p = AgentPolicy { vision: Some(grant(&[], true, now, 60_000)), ..enabled_policy() };
        assert!(harden(p).vision.is_none());

        // 非法 appId 全被剔除后也不成立
        let p = AgentPolicy { vision: Some(grant(&["../etc", ""], true, now, 60_000)), ..enabled_policy() };
        assert!(harden(p).vision.is_none());

        // 授权时刻在未来（时钟可疑）不认
        let p = AgentPolicy {
            vision: Some(grant(&["charmap"], true, now + 3_600_000, 60_000)),
            ..enabled_policy()
        };
        assert!(harden(p).vision.is_none());
    }

    #[test]
    fn harden_clamps_vision_ttl_to_24h() {
        let now = now_ms();
        let far = now.saturating_add(VISION_MAX_TTL_MS * 3);
        let p = AgentPolicy { vision: Some(grant(&["charmap"], true, now, far - now)), ..enabled_policy() };
        let v = harden(p).vision.expect("授权应保留但被裁剪");
        assert_eq!(v.expires_at, now + VISION_MAX_TTL_MS);
    }

    #[test]
    fn validate_grant_rejects_unknown_app_and_empty_list() {
        let now = now_ms();
        let p = enabled_policy();

        let mut input = VisionGrantInput {
            apps: vec!["charmap".into()],
            ..Default::default()
        };
        let v = validate_grant(&p, &input, now).expect("已授权应用应可授权");
        assert_eq!(v.apps, vec!["charmap".to_string()]);
        assert_eq!(v.expires_at, now + 30 * 60_000);

        // 未在 allowed_apps 里的应用不能开视觉
        input.apps = vec!["calc".into()];
        assert!(validate_grant(&p, &input, now).is_err());

        // 空清单拒绝
        input.apps = vec![];
        assert!(validate_grant(&p, &input, now).is_err());

        // ttl 被 clamp 到上限 / 下限
        input.apps = vec!["charmap".into()];
        input.ttl_minutes = 99_999;
        assert_eq!(
            validate_grant(&p, &input, now).unwrap().expires_at,
            now + VISION_MAX_TTL_MS
        );
        input.ttl_minutes = 0;
        assert_eq!(
            validate_grant(&p, &input, now).unwrap().expires_at,
            now + VISION_MIN_TTL_MS
        );

        // 未开启能力时不许授权
        let off = AgentPolicy { enabled: false, ..enabled_policy() };
        input.ttl_minutes = 30;
        assert!(validate_grant(&off, &input, now).is_err());
    }

    #[test]
    fn challenge_token_is_single_use_and_expires() {
        let now = 1_000_000;
        *PENDING_VISION.lock().unwrap() = Some(PendingChallenge {
            token: "abc".into(),
            expires_at: now + 1_000,
        });
        assert!(consume_challenge("abc", now).is_ok());
        // 已消费：再提交同一令牌必须失败（防重放）
        assert!(consume_challenge("abc", now).is_err());

        *PENDING_VISION.lock().unwrap() = Some(PendingChallenge {
            token: "def".into(),
            expires_at: now + 1_000,
        });
        assert!(consume_challenge("def", now + 2_000).is_err());
        assert!(consume_challenge("def", now).is_err(), "过期令牌也已被消费");

        *PENDING_VISION.lock().unwrap() = None;
        assert!(consume_challenge("", now).is_err());
    }

    #[test]
    fn vision_flags_are_not_writable_fields() {
        // 手工把 allow_screenshot/allow_coordinate_input 写成 true，但没有授权 → 读回仍是 false
        let p = AgentPolicy {
            allow_screenshot: true,
            allow_coordinate_input: true,
            vision: None,
            ..enabled_policy()
        };
        let h = harden(p);
        assert!(!h.allow_screenshot && !h.allow_coordinate_input);
    }
}
