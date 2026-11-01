//! 桌面配置持久化：模型管理 / MCP 服务 / LDAP 认证的读写（desktop.json + settings.json + 本地 SQLite 密钥库）。
//!
//! 安全模型（对齐 ARCH 与 secrets::store 注释，评审 C-4 / FR-3.2）：
//! - 桌面 UI 配置（模型元数据 / UI 形态 MCP 数组 / LDAP 认证 / 首次登录标志）写入**独立文件**
//!   `~/.deepcode/desktop.json`（0600）：引擎（@vegamo/deepcode-core）会以其已知键
//!   白名单重写 settings.json（env/model/provider/web…），写入 settings.json 的
//!   `desktop.*` / `models` 等未知键会在每次引擎启动时被抹掉——曾导致首次登录
//!   向导每次启动全屏弹出、遮住状态条（设置按钮不可见）与拖拽层（窗口无法拖动）；
//! - 仅引擎直接消费的 `mcpServers`（引擎标准 Record<name,{command,args,env}> 形态）
//!   与 `web.ldap`（非机密字段）仍合并写入 settings.json（合并写、保留全部未知字段）；
//! - API Key 等机密**只进本地 SQLite 密钥库**（`~/.deepcode/desktop-secrets.db`，0600；
//!   2026-10-30 起替代系统钥匙串——壳二进制重建后钥匙串 ACL 失配导致反复弹
//!   GUI 授权框），配置文件仅存 `apiKeyRef`（引用名 `model:<id>`），绝不明文落盘；
//! - 读取时以密钥库条目存在性决定前端是否展示"已保存密钥"占位，密钥明文不回传前端。
//!
//! 旧版兼容：desktop.json 不存在时回落读取 settings.json 的 `models` / `desktop.*`
//! 旧位置（一次性迁移语义：下次保存即落入 desktop.json）。

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::engine::settings::{
    home_settings_path, read_settings, read_settings_or_backup, write_private, DEEPCODE_DIR,
};
use crate::error::ShellError;
use crate::secrets::store::SecretStore;

/// 密钥库条目引用名前缀：`<前缀><模型 id>`（沿用旧钥匙串时代命名）。
const KEYCHAIN_PREFIX: &str = "model:";

/// 引擎级密钥的密钥库引用名（非模型类：settings.json 明文迁移目的地）。
pub const REF_ENGINE_API_KEY: &str = "engine:apiKey";
pub const REF_ENGINE_JWT_SECRET: &str = "engine:jwtSecret";
pub const REF_ENGINE_LDAP_BIND_PASSWORD: &str = "engine:ldapBindPassword";

/// 模型配置（前端 <-> 壳传输结构，camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    /// 模型唯一标识（前端生成 uuid）
    pub id: String,
    /// 展示名称
    pub name: String,
    /// 模型标识（API Model ID，如 gpt-4o / claude-3-5-sonnet；留空回落 name）
    #[serde(default)]
    pub model: String,
    /// 供应商类型（openai / anthropic / azure / ollama / gemini / custom …）
    #[serde(rename = "type")]
    pub model_type: String,
    /// API Base URL（留空走供应商默认）
    pub base_url: String,
    /// 仅保存时由前端传入明文（新增 / 修改密钥）；读取时恒为 None（密钥不回传前端）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 密钥库引用名（`model:<id>`）；读取时回填，前端据此判断密钥是否已保存
    #[serde(default)]
    pub api_key_ref: String,
    /// 是否启用（默认 true）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 是否默认模型（全局至多一个）
    #[serde(default)]
    pub is_default: bool,
    /// 创建时间（ISO 字符串）
    #[serde(default)]
    pub created_at: String,
    /// 读取时：密钥库中是否已存在该模型密钥（前端展示"已保存"占位）
    #[serde(default)]
    pub has_key: bool,
    // ---------- 高级配置（桌面高级配置 2026-10-30；全部可选，老配置零迁移成本） ----------
    /// 模型系列（default/claude/gpt/gemini/deepseek/qwen/glm…；prompt 优化预留，UI 持久化）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    /// 上下文窗口输入（Token）→ 注入 CONTEXT_WINDOW
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_input_tokens: Option<u64>,
    /// 上下文窗口输出（Token）→ 注入 ANTHROPIC_MAX_TOKENS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_output_tokens: Option<u64>,
    /// 工具调用轮数 → 注入 DEEPCODE_MAX_TOOL_ROUNDS（core 执行器 env 覆盖点）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_rounds: Option<u64>,
    /// 支持图片输入（"default"/"yes"/"no"；当前 UI 持久化，多模态裁剪预留）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_input: Option<String>,
    /// 思考模式（"default"/"on"/"off"）→ on/off 注入 THINKING_ENABLED
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<String>,
    /// 思考强度（"default"/low/medium/high/xhigh/max）→ 注入 REASONING_EFFORT
    ///
    /// 2026-11-01 新增：取值与 core `ReasoningEffort` 五档逐字一致
    /// （packages/core/src/settings.ts）。Qwen3.8 官方只有三档
    /// （low/medium/xhigh），由 core 的 `mapReasoningEffortToQwen` 做单调映射，
    /// 壳侧原样下发、不做特判。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
    /// 采样温度（0~2）→ 注入 TEMPERATURE
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Top P（0~1）→ 注入 DEEPCODE_TOP_P（预留，core 尚未消费）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// Top K（1~100）→ 注入 DEEPCODE_TOP_K（预留，core 尚未消费）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u64>,
}

/// MCP 服务配置（标准 MCP 客户端契约，camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 服务唯一标识
    pub id: String,
    /// 展示名称
    pub name: String,
    /// 启动命令（如 uvx / npx / node）
    pub command: String,
    /// 命令参数
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量（可能含 token 等敏感值，落 settings.json 但 0600）
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// 是否启用（默认 true）
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// LDAP 认证配置（前端 <-> 壳传输结构，camelCase；与 core WebLdapSettings 键对齐）。
///
/// 持久化分治（对齐本模块安全模型）：
/// - 非机密字段 → desktop.json（壳权威）+ settings.json `web.ldap`（引擎消费，合并写）；
/// - 绑定口令 → 仅本地 SQLite 密钥库（`engine:ldapBindPassword`），引擎启动时经
///   `DEEPCODE_WEB_LDAP_BIND_PASSWORD` 注入，settings.json 永不明文落盘。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LdapConfig {
    /// 是否启用 LDAP 登录（默认 false，走本地用户兜底）
    pub enabled: bool,
    /// LDAP 服务器主机名/IP（启用时必填）
    #[serde(default)]
    pub server: String,
    /// 端口（None → 引擎默认随 useSsl 切换：636 / 389）
    pub port: Option<u16>,
    /// 是否使用 ldaps://（默认 false）
    pub use_ssl: bool,
    /// 服务账号 DN（空 → 匿名 bind）
    #[serde(default)]
    pub bind_dn: String,
    /// 服务账号绑定口令：仅保存时由前端传入明文；读取恒为 None（不回传前端）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_password: Option<String>,
    /// 搜索基准 DN（启用时必填）
    #[serde(default)]
    pub base_dn: String,
    /// 用户过滤模板（空 → 引擎默认 "(uid=%s)"；支持 %s 占位）
    #[serde(default)]
    pub user_filter: String,
    /// 连接/搜索超时毫秒（None → 引擎默认 10000）
    pub timeout_ms: Option<u64>,
    /// 展示名属性映射（空 → 引擎默认 "displayName"）
    #[serde(default)]
    pub display_name_attr: String,
    /// 邮箱属性映射（空 → 引擎默认 "mail"）
    #[serde(default)]
    pub mail_attr: String,
    /// 读取时：密钥库是否已存在绑定口令（前端展示"已保存"占位，不回传明文）
    pub has_bind_password: bool,
}

/// 读取结果：桌面配置快照（密钥不回传）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    pub models: Vec<ModelConfig>,
    pub mcp_servers: Vec<McpServerConfig>,
    /// LDAP 认证配置（未配置过为 None）
    pub ldap: Option<LdapConfig>,
    /// 首次登录向导是否已完成
    pub first_login_done: bool,
}

/// 保存输入：前端提交的全量草稿（models / mcpServers 为完整列表，缺省即清空）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfigSave {
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    /// LDAP 配置草稿（None = 保持既有配置不变，向导/跳过路径不携带）
    #[serde(default)]
    pub ldap: Option<LdapConfig>,
    /// 是否标记首次登录向导完成
    #[serde(default)]
    pub setup_completed: bool,
}

fn default_true() -> bool {
    true
}

/// 解析模型密钥库引用名（已有则复用，否则按 id 生成）。
fn key_ref_for(model: &ModelConfig) -> String {
    if model.api_key_ref.is_empty() {
        format!("{KEYCHAIN_PREFIX}{}", model.id)
    } else {
        model.api_key_ref.clone()
    }
}

/// 读取桌面配置（desktop.json 为权威来源；缺失时回落 settings.json 旧位置，
/// 实现旧版一次性迁移；密钥明文不回传，仅 hasKey 标记）。
pub fn read_desktop_config() -> Result<DesktopConfig, ShellError> {
    let store = SecretStore::new();

    // 1) 桌面专属文件（权威来源；损坏视为空——UI 配置为壳自管数据，保存即覆盖）
    let desktop_root = read_settings(&desktop_config_path()?).unwrap_or(Value::Object(Map::new()));
    let mut cfg: DesktopConfig = match serde_json::from_value(desktop_root) {
        Ok(v) => v,
        Err(_) => DesktopConfig::default(),
    };

    // 2) 旧版回落：仅填充 desktop.json 中缺失的字段（一次性迁移语义）
    let legacy = read_settings(&home_settings_path()?)?;
    if let Some(obj) = legacy.as_object() {
        if cfg.models.is_empty() {
            if let Some(models_val) = obj.get("models").and_then(|v| v.as_array()) {
                cfg.models = models_val
                    .iter()
                    .filter_map(|m| serde_json::from_value(m.clone()).ok())
                    .collect();
            }
        }
        if let Some(d) = obj.get("desktop").and_then(|v| v.as_object()) {
            if !cfg.first_login_done {
                cfg.first_login_done = d
                    .get("firstLoginDone")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
            }
            if cfg.mcp_servers.is_empty() {
                if let Some(mcp_val) = d.get("mcpServers").and_then(|v| v.as_array()) {
                    cfg.mcp_servers = mcp_val
                        .iter()
                        .filter_map(|v| serde_json::from_value(v.clone()).ok())
                        .collect();
                }
            }
        }
    }

    // 3) 回填密钥库引用与 hasKey（不回传明文）
    for m in &mut cfg.models {
        let ref_name = key_ref_for(m);
        m.api_key_ref = ref_name.clone();
        m.has_key = store.get(&ref_name).is_ok();
        m.api_key = None;
    }

    // 4) LDAP：绑定口令不回传前端，仅回填密钥库存在性标记
    if let Some(ldap) = cfg.ldap.as_mut() {
        ldap.bind_password = None;
        ldap.has_bind_password = store.get(REF_ENGINE_LDAP_BIND_PASSWORD).is_ok();
    }

    Ok(cfg)
}

/// 保存桌面配置：
/// 1. 模型明文密钥写入本地 SQLite 密钥库（api_key 为空则保留既有密钥）；
/// 2. 回收已从列表移除的模型密钥库条目（对比 desktop.json 与 settings.json 旧 id 集合）；
/// 3. UI 全量配置（models / UI 形态 mcpServers / ldap / firstLoginDone）写入 desktop.json（0600）；
/// 4. 仅引擎消费的 mcpServers（Record 形态）与 web.ldap（非机密字段）合并写入 settings.json（保留未知字段）；
/// 5. LDAP 绑定口令仅入密钥库（engine:ldapBindPassword），经 env 注入引擎；
/// 6. 返回最新读取快照（hasKey / hasBindPassword 已刷新）。
///    payload.ldap 为 None（向导/跳过路径）时保持既有 LDAP 配置不变。
pub fn save_desktop_config(payload: DesktopConfigSave) -> Result<DesktopConfig, ShellError> {
    let store = SecretStore::new();

    // 旧模型 id 集合（desktop.json + settings.json 旧位置，供密钥库回收）
    // 同时捕获既有 desktop.json 的 LDAP 配置（payload.ldap = None 时保持不变）
    let mut prev_ids: Vec<String> = Vec::new();
    let mut existing_ldap: Option<LdapConfig> = None;
    if let Ok(v) = read_settings(&desktop_config_path()?) {
        existing_ldap = v
            .get("ldap")
            .and_then(|x| serde_json::from_value::<LdapConfig>(x.clone()).ok());
        if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
            prev_ids.extend(
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())),
            );
        }
    }
    if let Ok(v) = read_settings(&home_settings_path()?) {
        if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
            prev_ids.extend(
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())),
            );
        }
    }
    let keep_ids: HashSet<String> = payload.models.iter().map(|m| m.id.clone()).collect();
    for id in prev_ids {
        if !keep_ids.contains(&id) {
            let _ = store.delete(&format!("{KEYCHAIN_PREFIX}{id}"));
        }
    }

    // 模型：写入密钥（如有）并落元数据（不含明文）
    let mut saved_models: Vec<ModelConfig> = Vec::with_capacity(payload.models.len());
    for mut m in payload.models {
        let ref_name = key_ref_for(&m);
        if let Some(key) = m.api_key.take() {
            if !key.trim().is_empty() {
                store.set(&ref_name, &key)?; // 密钥库失败 → SecretStore 错误上浮
            }
        }
        m.api_key_ref = ref_name.clone();
        // has_key 以密钥库实际存在性为准：空密钥且此前无密钥 → false（不误报"已保存"）
        m.has_key = store.get(&ref_name).is_ok();
        m.api_key = None;
        saved_models.push(m);
    }

    // 1) UI 全量配置 → desktop.json（壳独占，引擎永不重写）
    //    LDAP：payload 未携带（None）时保持既有配置，避免向导/跳过路径误清空
    let mut saved_ldap: Option<LdapConfig> = payload.ldap.or(existing_ldap);
    if let Some(ldap) = saved_ldap.as_mut() {
        // 启用期校验（fail-fast，与 web 层 resolveWebSettings 口径一致）
        if ldap.enabled && (ldap.server.trim().is_empty() || ldap.base_dn.trim().is_empty()) {
            return Err(ShellError::Config(
                "LDAP 已启用：服务器地址（server）与搜索基准 DN（baseDn）均为必填".into(),
            ));
        }
        // 绑定口令：仅非空时更新密钥库（空 = 保持既有口令，与模型密钥语义一致）
        if let Some(pw) = ldap.bind_password.take() {
            if !pw.trim().is_empty() {
                store.set(REF_ENGINE_LDAP_BIND_PASSWORD, &pw)?;
            }
        }
        ldap.has_bind_password = store.get(REF_ENGINE_LDAP_BIND_PASSWORD).is_ok();
    }
    let desktop_doc = serde_json::json!({
        "models": saved_models,
        "mcpServers": payload.mcp_servers,
        "ldap": saved_ldap,
        "firstLoginDone": payload.setup_completed,
    });
    let desktop_path = desktop_config_path()?;
    if let Some(parent) = desktop_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_private(&desktop_path, serde_json::to_string_pretty(&desktop_doc)?.as_bytes())?;

    // 2) 引擎消费的 mcpServers（Record 形态）→ settings.json 合并写。
    //    core 的 McpServerConfig 为 Record<string,{command,args,env}>（按服务名 key），
    //    故做形态转换——否则数组会被引擎当对象、以序号为键、丢失 name 且无法禁用。
    let mut engine_mcp: Map<String, Value> = Map::new();
    for s in &payload.mcp_servers {
        if !s.enabled || s.name.trim().is_empty() || s.command.trim().is_empty() {
            continue;
        }
        let mut v = Map::new();
        v.insert("command".to_string(), Value::String(s.command.trim().to_string()));
        if !s.args.is_empty() {
            v.insert("args".to_string(), serde_json::to_value(&s.args)?);
        }
        if !s.env.is_empty() {
            v.insert("env".to_string(), serde_json::to_value(&s.env)?);
        }
        engine_mcp.insert(s.name.trim().to_string(), Value::Object(v));
    }
    let settings_path = home_settings_path()?;
    // 2026-11-01：settings.json 被手工改坏（注释/尾逗号/截断）时不再让整次保存失败——
    // 先备份为 *.corrupt-<ts>.bak 再按空对象继续合并，模型/MCP 的保存仍可完成。
    let mut root = read_settings_or_backup(&settings_path)?;
    if !root.is_object() {
        root = Value::Object(Map::new());
    }
    root.as_object_mut()
        .expect("checked")
        .insert("mcpServers".to_string(), Value::Object(engine_mcp));

    // 3) 引擎消费的 LDAP 配置 → settings.json web.ldap 合并写（仅非机密字段，
    //    绑定口令经 DEEPCODE_WEB_LDAP_BIND_PASSWORD env 注入，绝不落 settings.json）。
    //    引擎在每次启动读取该节（resolveWebSettings），与 mcpServers 同一写入口径。
    if let Some(ldap) = &saved_ldap {
        let mut engine_ldap = Map::new();
        engine_ldap.insert("enabled".to_string(), Value::Bool(ldap.enabled));
        engine_ldap.insert("server".to_string(), Value::String(ldap.server.trim().to_string()));
        if let Some(port) = ldap.port {
            engine_ldap.insert("port".to_string(), Value::Number(port.into()));
        }
        engine_ldap.insert("useSsl".to_string(), Value::Bool(ldap.use_ssl));
        if !ldap.bind_dn.trim().is_empty() {
            engine_ldap.insert("bindDn".to_string(), Value::String(ldap.bind_dn.trim().to_string()));
        }
        engine_ldap.insert("baseDn".to_string(), Value::String(ldap.base_dn.trim().to_string()));
        if !ldap.user_filter.trim().is_empty() {
            engine_ldap.insert(
                "userFilter".to_string(),
                Value::String(ldap.user_filter.trim().to_string()),
            );
        }
        if let Some(timeout) = ldap.timeout_ms {
            engine_ldap.insert("timeoutMs".to_string(), Value::Number(timeout.into()));
        }
        // 属性映射：任一非空才写 attrs（引擎缺省 displayName/mail）
        let display_attr = ldap.display_name_attr.trim();
        let mail_attr = ldap.mail_attr.trim();
        if !display_attr.is_empty() || !mail_attr.is_empty() {
            let mut attrs = Map::new();
            if !display_attr.is_empty() {
                attrs.insert("displayName".to_string(), Value::String(display_attr.to_string()));
            }
            if !mail_attr.is_empty() {
                attrs.insert("mail".to_string(), Value::String(mail_attr.to_string()));
            }
            engine_ldap.insert("attrs".to_string(), Value::Object(attrs));
        }
        // 安全兜底：清除既有文件中的明文绑定口令（旧版本残留）
        engine_ldap.remove("bindPassword");
        let root_obj = root.as_object_mut().expect("checked");
        let web_node = root_obj
            .entry("web".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !web_node.is_object() {
            *web_node = Value::Object(Map::new());
        }
        web_node
            .as_object_mut()
            .expect("checked")
            .insert("ldap".to_string(), Value::Object(engine_ldap));
    }

    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_private(&settings_path, serde_json::to_string_pretty(&root)?.as_bytes())?;

    read_desktop_config()
}

/// 桌面专属配置文件路径：`~/.deepcode/desktop.json`（壳独占，0600）。
fn desktop_config_path() -> Result<PathBuf, ShellError> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| ShellError::Config("无法定位用户主目录".into()))?;
    Ok(home.join(DEEPCODE_DIR).join("desktop.json"))
}

/// 在独立线程执行闭包并限时等待结果。
///
/// 用途：macOS 钥匙串访问可能弹出 GUI 授权框（keyring/Security.framework），
/// 同步等待会无限阻塞引擎启动流程（表现为 UI 永远停留在"正在启动本地引擎"）。
/// 限时护栏保证：即使授权框挂起，壳也按时继续启动（本次跳过对应密钥能力，
/// 用户在授权框点击允许后下次启动即恢复）。
fn run_with_timeout<T: Send + 'static>(
    secs: u64,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(secs)).ok()
}

/// 迁移 `settings.json` 中的明文密钥到本地 SQLite 密钥库（安全需求：配置文件不得明文存储凭证）。
///
/// 前置一步 [`crate::secrets::store::migrate_keychain_to_sqlite`]：把旧系统钥匙串
/// 条目一次性导入 SQLite（这是运行时唯一触碰钥匙串的地方，限时 5 秒护栏，
/// 超时/被拒仅记日志跳过，下次启动再迁移；导入成功后运行时永不再弹授权框）。
/// 明文迁移本身为纯 SQLite 本地 IO，无阻塞风险。
/// 内部实现见 [`migrate_secrets_from_settings_inner`]。
pub fn migrate_secrets_from_settings() {
    // 一次性钥匙串 → SQLite 迁移（限时：旧钥匙串可能弹最后一次授权框）
    let accounts = known_secret_accounts();
    if run_with_timeout(5, move || {
        crate::secrets::store::migrate_keychain_to_sqlite(&accounts)
    })
    .is_none()
    {
        log::warn!("钥匙串迁移超时（授权框待用户确认？）：跳过，下次启动再迁移，不阻塞启动");
    }
    migrate_secrets_from_settings_inner();
}

/// 汇总已知密钥引用名（迁移对象）：引擎级三密钥 + 各模型引用（新旧两处配置来源）。
fn known_secret_accounts() -> Vec<String> {
    let mut accounts = vec![
        REF_ENGINE_API_KEY.to_string(),
        REF_ENGINE_JWT_SECRET.to_string(),
        REF_ENGINE_LDAP_BIND_PASSWORD.to_string(),
    ];
    for path in [desktop_config_path().ok(), home_settings_path().ok()]
        .into_iter()
        .flatten()
    {
        if let Ok(v) = read_settings(&path) {
            if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
                for m in arr {
                    if let Some(r) = m.get("apiKeyRef").and_then(Value::as_str) {
                        accounts.push(r.to_string());
                    } else if let Some(id) = m.get("id").and_then(Value::as_str) {
                        accounts.push(format!("{KEYCHAIN_PREFIX}{id}"));
                    }
                }
            }
        }
    }
    accounts.sort();
    accounts.dedup();
    accounts
}

/// 迁移实现：文件明文密钥 → SQLite 密钥库后从文件移除；jwtSecret 兜底生成。
/// 处理对象：`env.API_KEY` / `web.auth.jwtSecret` / `web.ldap.bindPassword`。
/// web 层与 core 均原生支持 `DEEPCODE_*` 环境变量覆盖，settings.json 无需保留明文。
fn migrate_secrets_from_settings_inner() {
    let store = SecretStore::new();
    let settings_path = match home_settings_path() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("密钥迁移跳过（无法定位 settings.json）: {e}");
            return;
        }
    };
    let mut root = match read_settings(&settings_path) {
        Ok(v) => v,
        Err(_) => return, // 文件不存在 / 非法 JSON：无迁移对象
    };
    let obj = match root.as_object_mut() {
        Some(o) => o,
        None => return,
    };

    // (路径提取闭包, 密钥库引用名) 三元组逐项迁移
    let mut changed = false;
    let mut migrated: Vec<&'static str> = Vec::new();

    // 1) env.API_KEY → engine:apiKey
    if let Some(env_obj) = obj.get_mut("env").and_then(|v| v.as_object_mut()) {
        if let Some(key) = env_obj.get("API_KEY").and_then(|v| v.as_str()) {
            if !key.trim().is_empty() && store.set(REF_ENGINE_API_KEY, key).is_ok() {
                env_obj.remove("API_KEY");
                if env_obj.is_empty() {
                    obj.remove("env");
                }
                changed = true;
                migrated.push("env.API_KEY");
            }
        }
    }

    // 2) web.auth.jwtSecret → engine:jwtSecret
    if let Some(auth_obj) = obj
        .get_mut("web")
        .and_then(|w| w.get_mut("auth"))
        .and_then(|v| v.as_object_mut())
    {
        if let Some(secret) = auth_obj.get("jwtSecret").and_then(|v| v.as_str()) {
            if !secret.trim().is_empty() && store.set(REF_ENGINE_JWT_SECRET, secret).is_ok() {
                auth_obj.remove("jwtSecret");
                changed = true;
                migrated.push("web.auth.jwtSecret");
            }
        }
    }

    // 3) web.ldap.bindPassword → engine:ldapBindPassword
    if let Some(ldap_obj) = obj
        .get_mut("web")
        .and_then(|w| w.get_mut("ldap"))
        .and_then(|v| v.as_object_mut())
    {
        if let Some(pw) = ldap_obj.get("bindPassword").and_then(|v| v.as_str()) {
            if !pw.trim().is_empty() && store.set(REF_ENGINE_LDAP_BIND_PASSWORD, pw).is_ok() {
                ldap_obj.remove("bindPassword");
                changed = true;
                migrated.push("web.ldap.bindPassword");
            }
        }
    }

    // 4) jwtSecret 兜底：文件与密钥库均无 → 生成随机密钥入密钥库
    //    （桌面壳每轮启动另注入随机 DEEPCODE_WEB_JWT_SECRET，此处保证
    //    CLI 独立启动 web 也有可用的密钥存根）
    if store.get(REF_ENGINE_JWT_SECRET).is_err() {
        let generated = crate::engine::settings::generate_jwt_secret();
        if store.set(REF_ENGINE_JWT_SECRET, &generated).is_ok() {
            log::info!("jwtSecret 未配置：已生成随机密钥并存入本地密钥库（engine:jwtSecret）");
        }
    }

    if changed {
        if let Some(parent) = settings_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match write_private(&settings_path, serde_json::to_string_pretty(&root).unwrap_or_default().as_bytes()) {
            Ok(()) => log::info!(
                "已将明文密钥迁移至本地密钥库并从 settings.json 移除：{}",
                migrated.join("、")
            ),
            Err(e) => log::warn!("settings.json 回写失败（密钥库已保存，文件明文待下次迁移）: {e}"),
        }
    }
}

/// 引擎启动注入结果：环境变量（进程注入）+ 已知密钥明文清单（日志脱敏用）。
pub struct EngineLaunch {
    /// 注入引擎进程的环境变量（DEEPCODE_* 前缀，web 层 / core 均原生消费）
    pub env: std::collections::HashMap<String, String>,
    /// 已知密钥明文（API Key / jwtSecret / LDAP 绑定口令 / 各模型密钥），
    /// 供日志管道按行替换为 `[REDACTED]`——绝不落日志文件
    pub redact: Vec<String>,
}

/// 解析引擎启动注入（provider 接入 + 密钥注入 + 日志脱敏清单）。
///
/// 环境变量消费方（均已核实）：
/// - `DEEPCODE_API_KEY` / `DEEPCODE_MODEL` / `DEEPCODE_PROVIDER` / `DEEPCODE_BASE_URL`
///   → core `collectDeepcodeEnv`（剥离前缀后映射 settings）
/// - `DEEPCODE_WEB_JWT_SECRET` / `DEEPCODE_WEB_LDAP_BIND_PASSWORD`
///   → web 层 `resolveWebSettings` 的环境变量覆盖（优先级高于 settings.json）
///
/// 密钥来源（优先级从高到低）：
/// - API Key：默认模型密钥库条目（`model:<id>`）→ 引擎级条目（`engine:apiKey`，迁移产物）
/// - JWT Secret：壳每轮生成随机密钥（`DEEPCODE_WEB_JWT_SECRET`，见 manager.rs）
/// - LDAP 绑定口令：密钥库 `engine:ldapBindPassword`（仅迁移产物存在时注入）
///
/// 任何读取失败一律降级（跳过对应注入），绝不阻断桌面启动。
/// 数据源为本地 SQLite（无 GUI 授权框、微秒级 IO），无需限时护栏。
pub fn resolve_engine_launch() -> EngineLaunch {
    resolve_engine_launch_inner()
}

fn resolve_engine_launch_inner() -> EngineLaunch {
    let mut env = std::collections::HashMap::new();
    let mut redact: Vec<String> = Vec::new();
    let store = SecretStore::new();

    // ---------- 模型注册表：优先 desktop.json（权威），回落 settings.json 旧位置 ----------
    let models_root = match desktop_config_path().ok().and_then(|p| read_settings(&p).ok()) {
        Some(v) if v.get("models").and_then(|x| x.as_array()).is_some() => v,
        _ => match home_settings_path().ok().and_then(|p| read_settings(&p).ok()) {
            Some(v) => v,
            None => return EngineLaunch { env, redact },
        },
    };
    let models = models_root
        .get("models")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 所有模型密钥加入脱敏清单（含未选中模型：日志可能引用任一端点错误详情）
    for m in &models {
        let id = m.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let ref_name = m
            .get("apiKeyRef")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{KEYCHAIN_PREFIX}{id}"));
        if let Ok(key) = store.get(&ref_name) {
            if !key.trim().is_empty() {
                redact.push(key);
            }
        }
    }

    // 选默认模型：isDefault 优先，否则首个未禁用的模型
    let chosen = models
        .iter()
        .find(|m| m.get("isDefault").and_then(Value::as_bool) == Some(true))
        .or_else(|| {
            models
                .iter()
                .find(|m| m.get("enabled").and_then(Value::as_bool) != Some(false))
        });
    if let Some(chosen) = chosen {
        let model_id = chosen.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let model_type = chosen.get("type").and_then(Value::as_str).unwrap_or("openai");
        let model_name = chosen
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| chosen.get("name").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        let base_url = chosen
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if !model_name.is_empty() {
            // 取密钥（密钥库：model:<id>，无 apiKeyRef 时按 id 兜底）
            let ref_name = chosen
                .get("apiKeyRef")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("{KEYCHAIN_PREFIX}{model_id}"));
            match store.get(&ref_name) {
                Ok(key) if !key.trim().is_empty() => {
                    env.insert("DEEPCODE_API_KEY".to_string(), key);
                }
                _ => {
                    // 模型未配密钥：回落引擎级密钥（settings.json 明文迁移产物）
                    if let Ok(key) = store.get(REF_ENGINE_API_KEY) {
                        if !key.trim().is_empty() {
                            env.insert("DEEPCODE_API_KEY".to_string(), key);
                        }
                    }
                }
            }

            env.insert("DEEPCODE_MODEL".to_string(), model_name);
            // provider：anthropic 显式指定；其余按 OpenAI 兼容协议路由
            // （与 core 仅 openai/anthropic 两种 provider 对齐）
            let provider = if model_type == "anthropic" { "anthropic" } else { "openai" };
            env.insert("DEEPCODE_PROVIDER".to_string(), provider.to_string());
            if !base_url.is_empty() {
                env.insert("DEEPCODE_BASE_URL".to_string(), base_url.clone());
                if is_private_base_url(&base_url) {
                    env.insert("DEEPCODE_ALLOW_PRIVATE_BASE_URL".to_string(), "true".to_string());
                }
            }

            // ---------- 高级配置注入（桌面高级配置 2026-10-30） ----------
            // 仅注入引擎原生消费的变量；core 侧解析链 systemEnv 优先级最高，
            // 桌面注入即生效。字符串 → 数字全部做 range 校验，非法值静默跳过。
            if let Some(w) = chosen.get("contextInputTokens").and_then(Value::as_u64) {
                if (1..=10_000_000).contains(&w) {
                    env.insert("CONTEXT_WINDOW".to_string(), w.to_string());
                }
            }
            if let Some(t) = chosen.get("contextOutputTokens").and_then(Value::as_u64) {
                if (1..=1_000_000).contains(&t) {
                    env.insert("ANTHROPIC_MAX_TOKENS".to_string(), t.to_string());
                }
            }
            if let Some(r) = chosen.get("maxToolRounds").and_then(Value::as_u64) {
                if (1..=10_000).contains(&r) {
                    env.insert("DEEPCODE_MAX_TOOL_ROUNDS".to_string(), r.to_string());
                }
            }
            match chosen.get("thinkingMode").and_then(Value::as_str) {
                Some("on") => {
                    env.insert("THINKING_ENABLED".to_string(), "true".to_string());
                }
                Some("off") => {
                    env.insert("THINKING_ENABLED".to_string(), "false".to_string());
                }
                _ => {}
            }
            // 思考强度 → REASONING_EFFORT（2026-11-01 新增）。
            // 只接受 core 认识的五档；"default" 与非法值一律不注入，
            // 让引擎走模型/设置默认值（不写死档位，避免误钳制）。
            // 思考模式显式关闭时不注入——强度没有意义，注入反而会让
            // 请求同时带 enable_thinking=false 与 reasoning_effort，语义矛盾。
            if chosen.get("thinkingMode").and_then(Value::as_str) != Some("off") {
                if let Some(effort) = chosen.get("thinkingEffort").and_then(Value::as_str) {
                    if matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
                        env.insert("REASONING_EFFORT".to_string(), effort.to_string());
                    }
                }
            }
            if let Some(t) = chosen.get("temperature").and_then(Value::as_f64) {
                if (0.0..=2.0).contains(&t) {
                    env.insert("TEMPERATURE".to_string(), t.to_string());
                }
            }
            // 预留通道（core 尚未消费，注入无害且未来接通即生效）
            if let Some(p) = chosen.get("topP").and_then(Value::as_f64) {
                if (0.0..=1.0).contains(&p) {
                    env.insert("DEEPCODE_TOP_P".to_string(), p.to_string());
                }
            }
            if let Some(k) = chosen.get("topK").and_then(Value::as_u64) {
                if (1..=100).contains(&k) {
                    env.insert("DEEPCODE_TOP_K".to_string(), k.to_string());
                }
            }
        }
    }

    // ---------- 引擎级密钥注入（settings.json 明文迁移的运行时接续） ----------
    // API Key 兜底（模型未选中 / 未配密钥时）
    if !env.contains_key("DEEPCODE_API_KEY") {
        if let Ok(key) = store.get(REF_ENGINE_API_KEY) {
            if !key.trim().is_empty() {
                env.insert("DEEPCODE_API_KEY".to_string(), key);
            }
        }
    }
    // LDAP 绑定口令（仅启用 LDAP 且密钥库有存根时注入；web 层 env 覆盖优先于文件）
    if let Ok(pw) = store.get(REF_ENGINE_LDAP_BIND_PASSWORD) {
        if !pw.trim().is_empty() {
            env.insert("DEEPCODE_WEB_LDAP_BIND_PASSWORD".to_string(), pw);
        }
    }

    // 脱敏清单追加：引擎级 API Key / jwtSecret / LDAP 口令（去重）
    for ref_name in [REF_ENGINE_API_KEY, REF_ENGINE_JWT_SECRET, REF_ENGINE_LDAP_BIND_PASSWORD] {
        if let Ok(v) = store.get(ref_name) {
            if !v.trim().is_empty() {
                redact.push(v);
            }
        }
    }
    redact.sort();
    redact.dedup();

    EngineLaunch { env, redact }
}

/// 从 baseURL 提取 host（剥离协议 / 端口 / IPv6 方括号），失败返回 None。
fn host_of(base_url: &str) -> Option<String> {
    let raw = base_url.split("://").nth(1)?; // authority + 路径
    let authority = raw.split(['/', '?']).next().unwrap_or(raw);
    if let Some(start) = authority.find('[') {
        // IPv6 方括号形态：[addr] 或 [addr]:port
        let end = authority[start..].find(']').map(|i| start + i)?;
        return Some(authority[start + 1..end].to_lowercase());
    }
    // IPv4 / 域名：去掉端口（最后一个 ':'）
    let authority = match authority.rfind(':') {
        Some(i) => &authority[..i],
        None => authority,
    };
    Some(authority.to_lowercase())
}

/// 判断 baseURL 是否指向本地 / 私网地址（Ollama / vLLM 等场景需放开 SSRF 校验）。
fn is_private_base_url(base_url: &str) -> bool {
    let host = match host_of(base_url) {
        Some(h) => h,
        None => return false,
    };
    host == "localhost"
        || host == "ip6-localhost"
        || host == "ip6-loopback"
        || host == "::1"
        || host == "0.0.0.0"
        || host.ends_with(".local")
        || host.ends_with(".localhost")
        || {
            // IPv4 私网 / 回环段
            let parts: Vec<&str> = host.split('.').collect();
            if parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok()) {
                let a: u8 = parts[0].parse().unwrap();
                let b: u8 = parts[1].parse().unwrap();
                a == 127
                    || a == 10
                    || (a == 172 && b >= 16 && b <= 31)
                    || (a == 192 && b == 168)
                    || (a == 169 && b == 254)
                    || (a == 100 && b >= 64 && b <= 127)
            } else {
                false
            }
        }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};
    use tempfile::tempdir;

    /// HOME 注入互斥锁：并行测试下 set_var("HOME") 会互相干扰
    /// （secrets::store 测试同持此锁——SQLite 密钥库路径同样依赖 HOME）
    pub(crate) static HOME_LOCK: Mutex<()> = Mutex::new(());

    /// 建临时 HOME 并注入环境（持锁保证与其它 HOME 依赖测试互斥）
    fn with_temp_home() -> (tempfile::TempDir, MutexGuard<'static, ()>) {
        let guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempdir().unwrap();
        std::env::set_var("HOME", dir.path());
        (dir, guard)
    }

    fn home_deepcode() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
            .join(".deepcode")
    }

    #[test]
    fn save_writes_desktop_json_and_merges_engine_mcp() {
        let (_dir, _guard) = with_temp_home();
        // 预置含未知字段的 settings.json（模拟用户既有配置）
        let settings = home_deepcode().join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, r#"{"web":{"enabled":true},"custom":{"keep":1}}"#).unwrap();

        let saved = save_desktop_config(DesktopConfigSave {
            models: vec![ModelConfig {
                id: "m1".into(),
                name: "GPT".into(),
                model: "gpt-4o".into(),
                model_type: "openai".into(),
                base_url: "https://api.openai.com/v1".into(),
                api_key: None,
                api_key_ref: String::new(),
                enabled: true,
                is_default: true,
                created_at: "2026-10-29T00:00:00Z".into(),
                has_key: false,
                series: None,
                context_input_tokens: None,
                context_output_tokens: None,
                max_tool_rounds: None,
                image_input: None,
                thinking_mode: None,
                thinking_effort: None,
                temperature: None,
                top_p: None,
                top_k: None,
            }],
            mcp_servers: vec![McpServerConfig {
                id: "s1".into(),
                name: "sql".into(),
                command: "uvx".into(),
                args: vec!["x".into()],
                env: Default::default(),
                enabled: true,
            }],
            ldap: None,
            setup_completed: true,
        })
        .expect("保存桌面配置");

        // 返回快照：标志置位、模型回填引用、明文不回传
        assert!(saved.first_login_done);
        assert_eq!(saved.models[0].api_key_ref, "model:m1");
        assert!(saved.models[0].api_key.is_none(), "明文密钥不得回传");
        assert_eq!(saved.mcp_servers[0].name, "sql");

        // desktop.json：UI 全量配置（壳独占文件）
        let djson = home_deepcode().join("desktop.json");
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&djson).unwrap()).unwrap();
        assert_eq!(d["models"][0]["name"], "GPT");
        assert_eq!(d["models"][0]["apiKeyRef"], "model:m1");
        assert!(d["models"][0].get("apiKey").is_none(), "明文密钥不得落盘");
        assert_eq!(d["firstLoginDone"], Value::Bool(true));
        assert_eq!(d["mcpServers"][0]["command"], "uvx");

        // settings.json：仅引擎 mcpServers（Record 形态）合并写入，未知字段保留；
        // models / desktop 命名空间不再写 settings.json（会被引擎白名单重写抹掉）
        let s: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(s["web"]["enabled"], Value::Bool(true));
        assert_eq!(s["custom"]["keep"], 1);
        assert_eq!(s["mcpServers"]["sql"]["command"], "uvx");
        assert!(s.get("models").is_none());
        assert!(s.get("desktop").is_none());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in [&djson, settings.as_path()] {
                let mode = std::fs::metadata(f).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "{f:?} 必须为 0600");
            }
        }
    }

    #[test]
    fn engine_whitelist_rewrite_does_not_lose_desktop_config() {
        // 本 bug 回归用例：引擎以白名单重写 settings.json（desktop/models 键消失）后，
        // 桌面配置（firstLoginDone）必须依然可读 —— 否则首次登录向导每次启动全屏弹出，
        // 遮住状态条（设置按钮不可见）与拖拽层（窗口无法拖动）。
        let (_dir, _guard) = with_temp_home();
        save_desktop_config(DesktopConfigSave {
            models: vec![],
            mcp_servers: vec![],
            ldap: None,
            setup_completed: true,
        })
        .expect("保存桌面配置");

        // 模拟引擎白名单重写：settings.json 仅剩引擎已知键
        let settings = home_deepcode().join("settings.json");
        let rewritten = serde_json::json!({
            "env": {}, "model": "x", "provider": "openai",
            "reasoningEffort": "medium", "thinkingEnabled": false,
            "web": {"enabled": true}
        });
        std::fs::write(&settings, serde_json::to_string_pretty(&rewritten).unwrap()).unwrap();

        let cfg = read_desktop_config().expect("引擎重写后仍可读取桌面配置");
        assert!(cfg.first_login_done, "firstLoginDone 不得因引擎重写丢失");
    }

    #[test]
    fn save_persists_ldap_config_secret_and_merge() {
        // LDAP 配置端到端：desktop.json 权威 + settings.json web.ldap 合并（无明文口令）
        // + 绑定口令仅入密钥库 + 读取回填 hasBindPassword。
        let (_dir, _guard) = with_temp_home();
        // 预置 settings.json：web 节已有其它子字段 + 旧版残留明文 bindPassword
        let settings = home_deepcode().join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            r#"{"web":{"enabled":true,"ldap":{"enabled":false,"bindPassword":"legacy-plain"}},"custom":{"keep":1}}"#,
        )
        .unwrap();

        let saved = save_desktop_config(DesktopConfigSave {
            models: vec![],
            mcp_servers: vec![],
            ldap: Some(LdapConfig {
                enabled: true,
                server: "ldap.corp.example.com".into(),
                port: Some(636),
                use_ssl: true,
                bind_dn: "cn=svc,dc=corp".into(),
                bind_password: Some("bind-secret".into()),
                base_dn: "dc=corp,dc=example,dc=com".into(),
                user_filter: "(sAMAccountName=%s)".into(),
                timeout_ms: Some(5000),
                display_name_attr: "cn".into(),
                mail_attr: String::new(),
                has_bind_password: false,
            }),
            setup_completed: true,
        })
        .expect("保存含 LDAP 的桌面配置");

        // 返回快照：口令不回传、hasBindPassword 已回填
        let ldap = saved.ldap.as_ref().expect("ldap 应在快照中");
        assert!(ldap.enabled);
        assert!(ldap.bind_password.is_none(), "绑定口令不得回传");
        assert!(ldap.has_bind_password, "密钥库已保存口令，应回填 true");

        // desktop.json：LDAP 全量非机密配置（壳独占）
        let d: Value =
            serde_json::from_str(&std::fs::read_to_string(home_deepcode().join("desktop.json")).unwrap()).unwrap();
        assert_eq!(d["ldap"]["enabled"], Value::Bool(true));
        assert_eq!(d["ldap"]["server"], "ldap.corp.example.com");
        assert_eq!(d["ldap"]["port"], 636);
        assert_eq!(d["ldap"]["userFilter"], "(sAMAccountName=%s)");
        assert!(d["ldap"].get("bindPassword").is_none(), "口令不得落 desktop.json");

        // settings.json：web.ldap 合并写（保留 web.enabled / custom 未知字段；
        // 移除旧版残留 bindPassword；attrs 按非空字段生成）
        let s: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(s["web"]["enabled"], Value::Bool(true));
        assert_eq!(s["custom"]["keep"], 1);
        assert_eq!(s["web"]["ldap"]["enabled"], Value::Bool(true));
        assert_eq!(s["web"]["ldap"]["baseDn"], "dc=corp,dc=example,dc=com");
        assert_eq!(s["web"]["ldap"]["bindDn"], "cn=svc,dc=corp");
        assert_eq!(s["web"]["ldap"]["timeoutMs"], 5000);
        assert_eq!(s["web"]["ldap"]["attrs"]["displayName"], "cn");
        assert!(s["web"]["ldap"].get("attrs").unwrap().get("mail").is_none(), "空映射不写 attrs");
        assert!(
            s["web"]["ldap"].get("bindPassword").is_none(),
            "settings.json 不得残留明文绑定口令"
        );

        // 密钥库：绑定口令已保存
        let store = SecretStore::new();
        assert_eq!(store.get(REF_ENGINE_LDAP_BIND_PASSWORD).unwrap(), "bind-secret");

        // 再次保存（ldap: None，向导/跳过路径）：既有 LDAP 配置与 web.ldap 均保持
        save_desktop_config(DesktopConfigSave {
            models: vec![],
            mcp_servers: vec![],
            ldap: None,
            setup_completed: true,
        })
        .expect("ldap None 保存");
        let d2: Value =
            serde_json::from_str(&std::fs::read_to_string(home_deepcode().join("desktop.json")).unwrap()).unwrap();
        assert_eq!(d2["ldap"]["server"], "ldap.corp.example.com", "None 不得清空既有 LDAP 配置");
        let s2: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(s2["web"]["ldap"]["server"], "ldap.corp.example.com");

        // 空口令 = 保持既有：不报错且密钥库内容不变
        let kept = save_desktop_config(DesktopConfigSave {
            models: vec![],
            mcp_servers: vec![],
            ldap: Some(LdapConfig {
                enabled: true,
                bind_password: None,
                server: "ldap.corp.example.com".into(),
                base_dn: "dc=corp,dc=example,dc=com".into(),
                ..LdapConfig::default()
            }),
            setup_completed: true,
        })
        .expect("空口令保存");
        assert_eq!(
            store.get(REF_ENGINE_LDAP_BIND_PASSWORD).unwrap(),
            "bind-secret",
            "空口令不得清除既有口令"
        );
        assert!(kept.ldap.as_ref().unwrap().has_bind_password);

        // 启用期校验：缺 server / baseDn 必须报错
        let err = save_desktop_config(DesktopConfigSave {
            models: vec![],
            mcp_servers: vec![],
            ldap: Some(LdapConfig {
                enabled: true,
                server: String::new(),
                base_dn: String::new(),
                ..LdapConfig::default()
            }),
            setup_completed: true,
        });
        assert!(err.is_err(), "启用但缺 server/baseDn 应 fail-fast");
    }

    #[test]
    fn read_falls_back_to_legacy_settings_json() {
        // 旧版迁移：desktop.json 不存在时回落 settings.json 的 models / desktop.*
        let (_dir, _guard) = with_temp_home();
        let p = home_deepcode().join("settings.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            r#"{
              "models": [{"id":"a","name":"GPT","model":"gpt-4o","type":"openai","baseUrl":"https://x","apiKeyRef":"model:a","enabled":true,"isDefault":true}],
              "desktop": {"mcpServers": [{"id":"m","name":"sql","command":"uvx","args":["x"],"enabled":false}], "firstLoginDone": true},
              "custom": {"keep": 1}
            }"#,
        )
        .unwrap();

        let cfg = read_desktop_config().expect("读取桌面配置");
        assert_eq!(cfg.models.len(), 1);
        assert_eq!(cfg.models[0].name, "GPT");
        assert_eq!(cfg.models[0].model, "gpt-4o");
        assert_eq!(cfg.models[0].model_type, "openai");
        assert_eq!(cfg.models[0].api_key_ref, "model:a");
        assert_eq!(cfg.models[0].is_default, true);
        assert!(cfg.models[0].api_key.is_none(), "读取不回传明文密钥");
        // 测试环境无密钥库条目 → has_key 应为 false
        assert!(!cfg.models[0].has_key);
        assert_eq!(cfg.mcp_servers.len(), 1);
        assert_eq!(cfg.mcp_servers[0].command, "uvx");
        assert_eq!(cfg.mcp_servers[0].args, vec!["x".to_string()]);
        assert_eq!(cfg.mcp_servers[0].enabled, false);
        assert!(cfg.first_login_done);
    }

    #[test]
    fn key_ref_falls_back_to_id() {
        let m = ModelConfig {
            id: "abc".into(),
            name: "x".into(),
            model: String::new(),
            model_type: "custom".into(),
            base_url: "".into(),
            api_key: Some("sk".into()),
            api_key_ref: "".into(),
            enabled: true,
            is_default: false,
            created_at: "".into(),
            has_key: false,
            series: None,
            context_input_tokens: None,
            context_output_tokens: None,
            max_tool_rounds: None,
            image_input: None,
            thinking_mode: None,
            thinking_effort: None,
            temperature: None,
            top_p: None,
            top_k: None,
        };
        assert_eq!(key_ref_for(&m), "model:abc");
        let m2 = ModelConfig {
            api_key_ref: "model:existing".into(),
            ..m
        };
        assert_eq!(key_ref_for(&m2), "model:existing");
    }

    #[test]
    fn private_base_url_detection() {
        // 本地 / 私网地址需放开 SSRF 校验（Ollama / vLLM 等场景）
        assert!(is_private_base_url("http://localhost:11434/v1"));
        assert!(is_private_base_url("http://127.0.0.1:8080"));
        assert!(is_private_base_url("http://192.168.1.10"));
        assert!(is_private_base_url("http://[::1]:1234"));
        assert!(is_private_base_url("http://0.0.0.0"));
        // 公网官方端点不应被放行（保持 SSRF 防御纵深）
        assert!(!is_private_base_url("https://api.openai.com/v1"));
        assert!(!is_private_base_url("https://api.anthropic.com"));
    }

    // ========================================================================
    // 端到端（E2E）用例 —— 2026-11-01「保存系统管理失败」「思考强度」两项修复
    //
    // 与上面的单测不同，这里刻意不做任何 mock/stub：
    //   - 真实临时 HOME（with_temp_home）
    //   - 真实磁盘文件（settings.json / desktop.json / *.corrupt-*.bak）
    //   - 真实 SQLite 密钥库（SecretStore）
    //   - 真实 serde 序列化 → 落盘 → 反序列化回读
    // ========================================================================

    /// E2E 辅助：构造一份最小可用模型配置
    fn sample_model(effort: Option<&str>, thinking: Option<&str>) -> ModelConfig {
        ModelConfig {
            id: "e2e-m1".into(),
            name: "Qwen".into(),
            model: "qwen3.8-max".into(),
            model_type: "openai".into(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            api_key: Some("sk-e2e".into()),
            api_key_ref: String::new(),
            enabled: true,
            is_default: true,
            created_at: "2026-11-01T00:00:00Z".into(),
            has_key: false,
            series: Some("qwen".into()),
            context_input_tokens: None,
            context_output_tokens: None,
            max_tool_rounds: None,
            image_input: Some("yes".into()),
            thinking_mode: thinking.map(|s| s.to_string()),
            thinking_effort: effort.map(|s| s.to_string()),
            temperature: None,
            top_p: None,
            top_k: None,
        }
    }

    /// 列出 `~/.deepcode` 下的坏文件备份（settings.json.corrupt-*.bak）
    fn corrupt_backups() -> Vec<PathBuf> {
        std::fs::read_dir(home_deepcode())
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .map(|n| n.to_string_lossy().starts_with("settings.json.corrupt-"))
                            .unwrap_or(false)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// E2E-1a：`settings.json` 被手工改坏后，点「保存」仍必须成功。
    ///
    /// 用户报障原话：「点击保存 系统管理 失败」。真实成因是保存流程要把
    /// mcpServers 合并写回 settings.json，而用户手改过的文件带注释/尾逗号，
    /// JSON 解析必然失败 → 整次保存上抛 → 模型一条都没存上。
    ///
    /// 断言四件事：模型真落盘、原文件逐字备份、settings.json 重建为合法 JSON、
    /// 返回快照密钥标记正确（UI 据此显示「已保存」）。
    #[test]
    fn e2e_save_succeeds_when_settings_json_corrupt() {
        let (_dir, _guard) = with_temp_home();
        let settings = home_deepcode().join("settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        // 典型"手改坏"形态：JSON 不支持注释 + 尾逗号
        let broken = "{\n  // 我手动加的注释\n  \"web\": { \"enabled\": true },\n}\n";
        std::fs::write(&settings, broken).unwrap();

        let saved = save_desktop_config(DesktopConfigSave {
            models: vec![sample_model(Some("high"), Some("on"))],
            mcp_servers: Vec::new(),
            ldap: None,
            setup_completed: true,
        })
        .expect("settings.json 损坏时保存仍须成功（否则 UI 只会报「保存失败」）");

        // 1) 模型真的落到 desktop.json（壳权威来源），且思考强度一并持久化
        assert_eq!(saved.models.len(), 1, "模型必须保存成功");
        assert_eq!(saved.models[0].id, "e2e-m1");
        assert!(saved.models[0].has_key, "密钥应已写入 SQLite 密钥库");
        let desktop_raw = std::fs::read_to_string(home_deepcode().join("desktop.json")).unwrap();
        let desktop: Value = serde_json::from_str(&desktop_raw).unwrap();
        assert_eq!(desktop["models"].as_array().unwrap().len(), 1);
        assert_eq!(desktop["models"][0]["thinkingEffort"], "high");
        assert_eq!(desktop["models"][0]["imageInput"], "yes");

        // 2) 原文件内容必须逐字备份（绝不静默丢用户手写内容）
        let backups = corrupt_backups();
        assert_eq!(backups.len(), 1, "坏文件必须被备份，实际：{backups:?}");
        assert_eq!(
            std::fs::read_to_string(&backups[0]).unwrap(),
            broken,
            "备份内容必须与原文件逐字一致"
        );

        // 3) settings.json 被重建为合法 JSON，且 mcpServers 节写成功
        let rebuilt_raw = std::fs::read_to_string(&settings).unwrap();
        let rebuilt: Value =
            serde_json::from_str(&rebuilt_raw).expect("重建后的 settings.json 必须是合法 JSON");
        assert!(
            rebuilt.get("mcpServers").is_some(),
            "mcpServers 节应被写入，实际：{rebuilt_raw}"
        );
    }

    /// E2E-1b：思考强度必须真实注入引擎进程环境（桌面壳 → 引擎的环境变量契约）。
    ///
    /// 链路：UI 选择「思考强度=xhigh」→ desktop.json 持久化 → 壳启动引擎时
    /// resolve_engine_launch() 注入 REASONING_EFFORT=xhigh → core settings.ts 读取。
    #[test]
    fn e2e_thinking_effort_reaches_engine_env() {
        let (_dir, _guard) = with_temp_home();
        save_desktop_config(DesktopConfigSave {
            models: vec![sample_model(Some("xhigh"), Some("on"))],
            mcp_servers: Vec::new(),
            ldap: None,
            setup_completed: true,
        })
        .expect("保存桌面配置");

        let launch = resolve_engine_launch();
        assert_eq!(
            launch.env.get("REASONING_EFFORT").map(String::as_str),
            Some("xhigh"),
            "思考强度必须注入引擎环境"
        );
        assert_eq!(
            launch.env.get("THINKING_ENABLED").map(String::as_str),
            Some("true")
        );
        // 选中的确实是这份配置（模型 / provider / 端点均到位）
        assert_eq!(
            launch.env.get("DEEPCODE_MODEL").map(String::as_str),
            Some("qwen3.8-max")
        );
        assert_eq!(
            launch.env.get("DEEPCODE_PROVIDER").map(String::as_str),
            Some("openai")
        );
    }

    /// E2E-1c：思考关闭 / 非法档位时**不得**注入 REASONING_EFFORT。
    ///
    /// 关闭思考还发 reasoning_effort 会让请求同时带 enable_thinking=false
    /// 与 reasoning_effort，语义矛盾；非法值则会被引擎当作默认档处理，
    /// 静默改变用户预期。
    #[test]
    fn e2e_thinking_effort_not_injected_when_off_or_invalid() {
        let (_dir, _guard) = with_temp_home();

        // A) 思考模式显式关闭
        save_desktop_config(DesktopConfigSave {
            models: vec![sample_model(Some("high"), Some("off"))],
            mcp_servers: Vec::new(),
            ldap: None,
            setup_completed: true,
        })
        .expect("保存（thinking=off）");
        let launch = resolve_engine_launch();
        assert_eq!(
            launch.env.get("THINKING_ENABLED").map(String::as_str),
            Some("false")
        );
        assert!(
            !launch.env.contains_key("REASONING_EFFORT"),
            "思考关闭时不得注入强度，实际：{:?}",
            launch.env.get("REASONING_EFFORT")
        );

        // B) 非法档位（不在 core 五档内）
        save_desktop_config(DesktopConfigSave {
            models: vec![sample_model(Some("ultra"), Some("on"))],
            mcp_servers: Vec::new(),
            ldap: None,
            setup_completed: true,
        })
        .expect("保存（effort=ultra）");
        let launch = resolve_engine_launch();
        assert!(
            !launch.env.contains_key("REASONING_EFFORT"),
            "非法档位不得注入（应回落引擎默认），实际：{:?}",
            launch.env.get("REASONING_EFFORT")
        );
    }
}
