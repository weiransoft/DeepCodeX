//! `~/.deepcode/settings.json` 读写（ARCH DCA-ARCH-DESKTOP-001 §3.1 engine/settings.rs）。
//!
//! 设计要点（对齐 DeepCodeX-cli 引擎真实契约，均已核实源码）：
//! - `web.enabled` 必须为 true，否则 `deepcode web` fail-fast 退出
//!   （packages/cli/src/web-command.ts L41-53）；
//! - JWT secret 优先走环境变量 `DEEPCODE_WEB_JWT_SECRET` 注入
//!   （packages/web/src/config.ts L289-290），**绝不写入 settings.json 任何位置**
//!   （settings.json 与 CLI 共享且可能被同步，明文 secret 属泄露面）；
//! - 写入采用"保留未知字段的 JSON 合并"，绝不清空用户的其他配置；
//!   解析失败直接报错而非覆盖（保护用户数据）。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::ShellError;

/// DeepCode 用户配置目录名（与 CLI 共享：`~/.deepcode`）。
pub const DEEPCODE_DIR: &str = ".deepcode";

/// `~/.deepcode/settings.json` 路径（生产装配用；测试注入临时路径）。
pub fn home_settings_path() -> Result<PathBuf, ShellError> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| ShellError::Config("无法定位用户主目录".into()))?;
    Ok(home.join(DEEPCODE_DIR).join("settings.json"))
}

/// 写入权限为 0600 的文件（unix）；Windows 走默认 DACL（属主可写已足够）。
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ShellError> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// 生成 JWT secret（32 字节随机 → base64url，43 字符，满足引擎非空要求）。
///
/// 注意：该值**只**通过子进程环境变量注入（`DEEPCODE_WEB_JWT_SECRET`），
/// 绝不落盘 settings.json，也绝不打日志（NFR-5）。
pub fn generate_jwt_secret() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    // 最小 base64url 编码（无依赖；'+/' 替换为 '-_'、去 padding）
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(43);
    for chunk in buf.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        }
    }
    out
}

/// 读取 settings.json（不存在返回空对象；JSON 非法报错且绝不覆盖）。
pub fn read_settings(path: &Path) -> Result<Value, ShellError> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let raw = std::fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(|e| {
        ShellError::Config(format!(
            "settings.json 解析失败（为避免覆盖你的配置已中止）：{e}"
        ))
    })
}

/// 读取 settings.json 的"可继续"版本：JSON 非法时先备份再返回空对象。
///
/// 用途（2026-11-01 修复"保存系统管理失败"）：
/// `save_desktop_config` 需要把 mcpServers / web.ldap 合并写回 settings.json。
/// 用户在 CLI 里手工编辑过该文件（注释、尾逗号、被截断）时解析必然失败，
/// 旧实现直接 `?` 上抛——结果是"模型一条都没保存，界面报保存失败"，
/// 而真正的故障点与模型配置毫无关系，用户完全无从判断。
///
/// 语义取舍：
/// - 绝不静默丢数据 —— 非法文件先复制到 `settings.json.corrupt-<ts>.bak`；
/// - 返回空对象让上层继续写，保证"保存"这个动作对用户是可完成的；
/// - 备份路径写进日志，用户/支持人员可据此恢复手工内容。
pub fn read_settings_or_backup(path: &Path) -> Result<Value, ShellError> {
    match read_settings(path) {
        Ok(v) => Ok(v),
        Err(_) => {
            let raw = match std::fs::read_to_string(path) {
                Ok(raw) => raw,
                // 文件不可读（权限等）：不是"内容非法"，照旧上抛，别假装成功
                Err(e) => {
                    return Err(ShellError::Config(format!(
                        "settings.json 读取失败：{e}"
                    )))
                }
            };
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.corrupt-{ts}.bak"));
            std::fs::write(&backup, raw.as_bytes())?;
            log::warn!(
                "settings.json 内容非法，已备份到 {} 并按空配置继续合并写入",
                backup.display()
            );
            Ok(Value::Object(Map::new()))
        }
    }
}

/// 确保 `~/.deepcode/settings.json` 中 `web.enabled = true`（幂等）。
///
/// 合并语义：读旧 JSON → 仅改 `web.enabled` → 写回（保留全部未知字段）。
/// 文件不存在则创建最小骨架；0600 收紧权限（文件可能含 LDAP 等敏感配置）。
/// 返回设置文件的规范路径（供日志与前端展示）。
pub fn ensure_web_enabled(settings_path: &Path) -> Result<PathBuf, ShellError> {
    let mut root = read_settings(settings_path)?;
    if !root.is_object() {
        return Err(ShellError::Config(
            "settings.json 顶层必须是 JSON 对象，请先修正".into(),
        ));
    }
    let obj = root.as_object_mut().expect("checked");
    let web = obj
        .entry("web")
        .or_insert_with(|| Value::Object(Map::new()));
    if !web.is_object() {
        return Err(ShellError::Config(
            "settings.json 的 web 字段必须是对象，请先修正".into(),
        ));
    }
    web.as_object_mut()
        .expect("checked")
        .insert("enabled".into(), Value::Bool(true));

    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_private(
        settings_path,
        serde_json::to_string_pretty(&root)?.as_bytes(),
    )?;
    Ok(settings_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_web_enabled_creates_and_merges() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");

        // 文件不存在 → 创建骨架且 enabled=true
        ensure_web_enabled(&p).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["web"]["enabled"], Value::Bool(true));

        // 已有其他字段 → 合并保留、幂等
        std::fs::write(&p, r#"{"web":{"port":3999},"custom":{"keep":1}}"#).unwrap();
        ensure_web_enabled(&p).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["web"]["enabled"], Value::Bool(true));
        assert_eq!(v["web"]["port"], 3999);
        assert_eq!(v["custom"]["keep"], 1);

        // 0600 权限收紧（unix）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "settings.json 必须为 0600");
        }
    }

    #[test]
    fn ensure_web_enabled_rejects_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, b"{ not json").unwrap();
        let err = ensure_web_enabled(&p).unwrap_err();
        assert!(matches!(err, ShellError::Config(_)));
        // 必须保持原文件不被覆盖
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ not json");
    }

    #[test]
    fn read_settings_missing_returns_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let v = read_settings(&dir.path().join("absent.json")).unwrap();
        assert!(v.as_object().unwrap().is_empty());
    }

    #[test]
    fn jwt_secret_shape() {
        let s = generate_jwt_secret();
        assert!(s.len() >= 40, "secret 长度应足够随机：{}", s.len());
        assert!(
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "base64url 字符集校验"
        );
        assert!(!s.contains('='), "base64url 不应带 padding");
        // 两次生成不重复（随机性粗判）
        assert_ne!(s, generate_jwt_secret());
    }
}
