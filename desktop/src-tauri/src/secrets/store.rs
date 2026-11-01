//! SQLite 密钥库封装（2026-10-30 起为默认实现）。
//!
//! 选型变更：原先使用 `keyring` crate（macOS Keychain / Windows Credential
//! Manager），但 macOS 上壳二进制每次重建后钥匙串 ACL 不再匹配，访问条目
//! 就会反复弹出 GUI 授权框（用户实测"频繁要输入很多次密码"），且同步调用
//! 曾阻塞引擎启动。现改为**本地 SQLite 库**：
//!
//! - 数据库文件：`~/.deepcode/desktop-secrets.db`（0600，与 desktop.json 同目录）；
//! - 表：`secrets(service, account, value)`，主键 (service, account)；
//! - 引擎侧（Node `node:sqlite`）打开同一数据库文件写入 bootstrap 口令，
//!   跨进程并发依赖 SQLite 文件锁 + busy_timeout；
//! - 任何日志不得输出 secret 明文；错误信息只携带类别，不回显值本身。
//!
//! `keyring` 依赖仅保留给 [`migrate_keychain_to_sqlite`]（一次性、限时、
//! 静默迁移旧钥匙串条目），运行时读写路径不再触碰系统钥匙串。

use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::ShellError;

/// 旧钥匙串服务名（迁移源的命名空间契约，保持稳定）。
pub const KEYCHAIN_SERVICE: &str = "com.vegamo.deepcode.desktop";

/// SQLite 密钥库文件名（位于 `~/.deepcode/` 下）。
pub const SECRETS_DB_FILE: &str = "desktop-secrets.db";

/// 钥匙串迁移完成标记的 account 名（值 = 完成时的 Unix 时间戳秒）。
pub const MIGRATION_DONE_ACCOUNT: &str = "__keychain_migration_done";

/// SQLite 密钥库句柄（按 service 隔离条目命名空间）。
/// 连接惰性创建：首次访问时建库/建表/收紧权限。
pub struct SecretStore {
    service: String,
    conn: Mutex<Option<rusqlite::Connection>>,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore {
    /// 使用默认服务名（`com.vegamo.deepcode.desktop`）。
    pub fn new() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.to_string(),
            conn: Mutex::new(None),
        }
    }

    /// 使用自定义服务名（测试隔离场景；仅测试使用）。
    #[cfg(test)]
    pub fn with_service(service: &str) -> Self {
        Self {
            service: service.to_string(),
            conn: Mutex::new(None),
        }
    }

    /// 密钥库文件路径：`~/.deepcode/desktop-secrets.db`。
    pub fn db_path() -> Result<PathBuf, ShellError> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| ShellError::Config("无法定位用户主目录".into()))?;
        Ok(home.join(crate::engine::settings::DEEPCODE_DIR).join(SECRETS_DB_FILE))
    }

    /// 打开（或创建）连接：建目录、建表、收紧文件权限、设 busy_timeout。
    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Option<rusqlite::Connection>>, ShellError> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| ShellError::SecretStore("密钥库连接锁中毒".into()))?;
        if guard.is_none() {
            let path = Self::db_path()?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| ShellError::SecretStore(format!("密钥库目录创建失败：{e}")))?;
            }
            let conn = rusqlite::Connection::open(&path)
                .map_err(|e| ShellError::SecretStore(format!("密钥库打开失败：{e}")))?;
            conn.busy_timeout(std::time::Duration::from_secs(2))
                .map_err(|e| ShellError::SecretStore(format!("密钥库 busy_timeout 设置失败：{e}")))?;
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS secrets (
                     service TEXT NOT NULL,
                     account TEXT NOT NULL,
                     value   TEXT NOT NULL,
                     PRIMARY KEY (service, account)
                 );",
            )
            .map_err(|e| ShellError::SecretStore(format!("密钥库建表失败：{e}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            *guard = Some(conn);
        }
        Ok(guard)
    }

    /// 写入（已存在则覆盖）。
    pub fn set(&self, account: &str, value: &str) -> Result<(), ShellError> {
        let guard = self.connection()?;
        let conn = guard.as_ref().expect("connection() 已保证 Some");
        conn.execute(
            "INSERT INTO secrets (service, account, value) VALUES (?1, ?2, ?3)
             ON CONFLICT (service, account) DO UPDATE SET value = excluded.value",
            rusqlite::params![self.service, account, value],
        )
        .map_err(|e| ShellError::SecretStore(format!("密钥写入失败：{e}")))?;
        Ok(())
    }

    /// 读取；不存在时返回 Err（调用方区分处置，与原钥匙串 NoEntry 语义一致）。
    pub fn get(&self, account: &str) -> Result<String, ShellError> {
        let guard = self.connection()?;
        let conn = guard.as_ref().expect("connection() 已保证 Some");
        let value: String = conn
            .query_row(
                "SELECT value FROM secrets WHERE service = ?1 AND account = ?2",
                rusqlite::params![self.service, account],
                |row| row.get(0),
            )
            .map_err(|_| ShellError::SecretStore("密钥条目不存在".into()))?;
        Ok(value)
    }

    /// 删除（幂等：条目不存在同样视为成功）。
    pub fn delete(&self, account: &str) -> Result<(), ShellError> {
        let guard = self.connection()?;
        let conn = guard.as_ref().expect("connection() 已保证 Some");
        conn.execute(
            "DELETE FROM secrets WHERE service = ?1 AND account = ?2",
            rusqlite::params![self.service, account],
        )
        .map_err(|e| ShellError::SecretStore(format!("密钥删除失败：{e}")))?;
        Ok(())
    }
}

/// 一次性迁移：旧系统钥匙串条目 → SQLite（静默、幂等、失败不阻断）。
///
/// 迁移对象：调用方给定的引用名清单（引擎级三密钥 + 各模型 `model:<id>`）。
/// 迁移策略：SQLite 已有值时以 SQLite 为准（跳过），避免覆盖用户新配置；
/// 成功复制后尽力删除钥匙串条目（删除可能因 ACL 失配失败——不影响正确性，
/// 残留条目运行时不再读取，仅是惰性孤儿数据）。
///
/// **只尝试一次**：完成后写入标记行（account=`__keychain_migration_done`），
/// 后续启动见到标记立即返回——保证运行时最多触碰一次系统钥匙串，
/// 迁移失败的条目绝不反复重试（反复重试 = 反复弹授权框，正是要消灭的体验）。
/// 注意：本函数可能触发一次钥匙串授权框（旧行为的最后一次），调用方须用
/// 限时护栏包裹（见 config_persist::migrate_secrets_from_settings）。
pub fn migrate_keychain_to_sqlite(accounts: &[String]) {
    use keyring::Entry;
    let store = SecretStore::new();

    // 完成标记：迁移只做一次（成功与否都不重试，防止每次启动弹框）
    if store.get(MIGRATION_DONE_ACCOUNT).is_ok() {
        return;
    }

    for account in accounts {
        if account.trim().is_empty() {
            continue;
        }
        // SQLite 已有值：跳过（幂等，不覆盖）
        if store.get(account).is_ok() {
            continue;
        }
        let entry = match Entry::new(KEYCHAIN_SERVICE, account) {
            Ok(e) => e,
            Err(_) => continue,
        };
        match entry.get_password() {
            Ok(value) => {
                if !value.trim().is_empty() && store.set(account, &value).is_ok() {
                    if let Err(_e) = entry.delete_credential() {
                        log::warn!(
                            "密钥已复制到本地 SQLite 库，但钥匙串条目删除失败（残留为惰性数据，\
                             运行时不再读取；如需清理：security delete-generic-password \
                             -s com.vegamo.deepcode.desktop -a {account}）：{account}"
                        );
                    } else {
                        log::info!("密钥已从系统钥匙串迁移至本地 SQLite 库：{account}");
                    }
                }
            }
            Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                log::warn!(
                    "钥匙串条目 {account} 读取失败（授权被拒/超时？）：本次跳过且不再重试；\
                     该条目为惰性残留，如需清理：security delete-generic-password \
                     -s com.vegamo.deepcode.desktop -a {account}"
                );
            }
        }
    }

    // 标记完成（时间戳仅作记录，无业务语义）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = store.set(MIGRATION_DONE_ACCOUNT, &now.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    /// 与 config_persist 测试共享的 HOME 注入互斥锁（并行测试下 set_var 互扰防护）
    fn home_lock() -> MutexGuard<'static, ()> {
        crate::config_persist::tests::HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn with_temp_home() -> (tempfile::TempDir, MutexGuard<'static, ()>) {
        let guard = home_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", dir.path());
        (dir, guard)
    }

    #[test]
    fn sqlite_roundtrip() {
        let (_dir, _guard) = with_temp_home();
        let store = SecretStore::with_service("selftest-service");
        let account = format!("selftest-{}", std::process::id());

        // 无条目：读取报错
        assert!(store.get(&account).is_err());

        // 写入 → 读取一致
        store.set(&account, "s3cret-value").unwrap();
        assert_eq!(store.get(&account).unwrap(), "s3cret-value");

        // 覆盖写 → 新值生效
        store.set(&account, "updated").unwrap();
        assert_eq!(store.get(&account).unwrap(), "updated");

        // service 隔离：另一命名空间读不到
        let other = SecretStore::with_service("other-service");
        assert!(other.get(&account).is_err());

        // 删除 → 读取报错；重复删除幂等
        store.delete(&account).unwrap();
        assert!(store.get(&account).is_err());
        store.delete(&account).unwrap();

        // db 文件落在 ~/.deepcode/ 下
        assert!(SecretStore::db_path().unwrap().ends_with(SECRETS_DB_FILE));
    }

    #[test]
    fn db_file_is_private() {
        let (_dir, _guard) = with_temp_home();
        let store = SecretStore::with_service("perm-selftest");
        store.set("perm-check", "v").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(SecretStore::db_path().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "密钥库文件必须为 0600");
        }
    }

    #[test]
    fn service_names_are_stable() {
        // 服务名是存储命名空间契约（迁移源 keyring 条目按此检索），必须保持稳定
        assert_eq!(KEYCHAIN_SERVICE, "com.vegamo.deepcode.desktop");
        assert_eq!(SecretStore::new().service, KEYCHAIN_SERVICE);
    }
}
