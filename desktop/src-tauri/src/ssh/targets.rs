//! SSH 连接目标：持久化存储与 `~/.ssh/config` 解析（ARCH §3.1 sshconfig.rs）。
//!
//! 目标是"可直接用于 `ssh` 命令的连接描述"：主机、端口、用户名、认证方式，
//! 外加可选的 IdentityFile / ProxyJump 透传。**不含任何口令**——
//! 密码认证的口令只随单次 `ssh_connect` 调用进入内存，绝不落盘（FR-2.2）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::ShellError;

/// 一个 SSH 连接目标（前端 `SshTarget` 的镜像，camelCase 直出）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    /// 稳定标识（由 `username@host:port` 派生，重复导入不产生重复条目）
    pub id: String,
    /// 展示名
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 认证方式：`agent`（系统 ssh-agent / 默认密钥）| `password` | `keyfile`
    pub auth_method: String,
    /// 私钥路径（`auth_method = keyfile` 时使用；来自 ~/.ssh/config 的 IdentityFile）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// 跳板机（`-J` 直传）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_jump: Option<String>,
}

impl SshTarget {
    /// 由连接要素构造目标；`id` 按 `user@host:port` 稳定派生。
    pub fn new(
        name: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        auth_method: impl Into<String>,
    ) -> Self {
        let host = host.into();
        let username = username.into();
        let id = stable_id(&username, &host, port);
        let name = {
            let n = name.into();
            if n.is_empty() {
                format!("{username}@{host}")
            } else {
                n
            }
        };
        Self {
            id,
            name,
            host,
            port,
            username,
            auth_method: auth_method.into(),
            identity_file: None,
            proxy_jump: None,
        }
    }

    /// 人类可读地址（`ssh://user@host:port`，端口 22 省略）
    pub fn display_addr(&self) -> String {
        if self.port == 22 {
            format!("ssh://{}@{}", self.username, self.host)
        } else {
            format!("ssh://{}@{}:{}", self.username, self.host, self.port)
        }
    }
}

/// 稳定 ID：FNV-1a 64 位十六进制。
///
/// 仅用于去重/前端 key，不承担安全职责，故不引入哈希 crate。
fn stable_id(username: &str, host: &str, port: u16) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in format!("{username}@{host}:{port}").as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("ssh-{hash:016x}")
}

/// 目标存储（应用数据目录下的 JSON；纯读失败即报错，不静默清空用户数据）。
#[derive(Debug, Clone)]
pub struct TargetStore {
    path: PathBuf,
}

impl TargetStore {
    /// 指定存储文件路径（测试注入临时路径）
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// 读取全部目标；文件不存在视为空列表。
    ///
    /// 文件损坏时**报错而非覆盖**——手滑写坏 JSON 不应连累用户丢掉全部目标。
    pub fn load(&self) -> Result<Vec<SshTarget>, ShellError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let text = std::fs::read_to_string(&self.path)?;
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let targets: Vec<SshTarget> = serde_json::from_str(&text).map_err(|e| {
            ShellError::Config(format!(
                "SSH 目标文件解析失败（{}）：{e}；请修复或删除该文件后重试",
                self.path.display()
            ))
        })?;
        Ok(targets)
    }

    /// 覆盖写全部目标（先写临时文件再 rename，避免半截文件）。
    pub fn save_all(&self, targets: &[SshTarget]) -> Result<(), ShellError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(targets)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        // 目标文件可能含主机名/账号等内网信息：尽力收紧为 0600（Windows 忽略）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// 按 id 覆写或追加，返回最终列表。
    pub fn upsert(&self, target: SshTarget) -> Result<Vec<SshTarget>, ShellError> {
        let mut list = self.load()?;
        match list.iter_mut().find(|t| t.id == target.id) {
            Some(slot) => *slot = target,
            None => list.push(target),
        }
        self.save_all(&list)?;
        Ok(list)
    }

    /// 按 id 删除，返回最终列表。
    pub fn remove(&self, id: &str) -> Result<Vec<SshTarget>, ShellError> {
        let mut list = self.load()?;
        list.retain(|t| t.id != id);
        self.save_all(&list)?;
        Ok(list)
    }

    /// 批量合并（导入用）：按 id 去重，已存在则以新值覆盖，返回 `(最终列表, 新增数)`。
    pub fn merge(&self, incoming: Vec<SshTarget>) -> Result<(Vec<SshTarget>, usize), ShellError> {
        let mut list = self.load()?;
        let before = list.len();
        for target in incoming {
            match list.iter_mut().find(|t| t.id == target.id) {
                Some(slot) => *slot = target,
                None => list.push(target),
            }
        }
        let added = list.len().saturating_sub(before);
        self.save_all(&list)?;
        Ok((list, added))
    }
}

/// `~/.ssh/config` 中一个 Host 块解析出的目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

/// 解析 `~/.ssh/config` 文本。
///
/// 支持：`Host` 多别名、`HostName`/`Hostname`、`User`、`Port`、`IdentityFile`、
/// `ProxyJump`，以及 `Key Value` / `Key=Value` 两种写法；忽略注释、
/// `Include` 与通配符别名（`*`/`?` 是匹配规则而非具体主机）。
///
/// 遵循 OpenSSH 语义：同一 Host 块内**先出现者优先**，故重复键不覆盖。
pub fn parse_ssh_config(src: &str) -> Vec<ParsedHost> {
    let mut out: Vec<ParsedHost> = Vec::new();
    let mut block: Vec<ParsedHost> = Vec::new();

    let flush = |block: &mut Vec<ParsedHost>, out: &mut Vec<ParsedHost>| {
        out.append(block);
    };

    for raw in src.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match split_directive(line) {
            Some(kv) => kv,
            None => continue,
        };
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                flush(&mut block, &mut out);
                for alias in value.split_whitespace() {
                    // 通配符/取反模式是匹配规则，不是可连接的具体主机
                    if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                        continue;
                    }
                    block.push(ParsedHost {
                        alias: alias.to_string(),
                        hostname: None,
                        user: None,
                        port: None,
                        identity_file: None,
                        proxy_jump: None,
                    });
                }
            }
            "hostname" => fill(&mut block, |h| {
                h.hostname.get_or_insert(value.clone());
            }),
            "user" => fill(&mut block, |h| {
                h.user.get_or_insert(value.clone());
            }),
            "port" => {
                if let Ok(port) = value.parse::<u16>() {
                    fill(&mut block, |h| {
                        h.port.get_or_insert(port);
                    });
                }
            }
            "identityfile" | "identityfile2" => fill(&mut block, |h| {
                h.identity_file.get_or_insert(value.clone());
            }),
            "proxyjump" => {
                if value != "none" {
                    fill(&mut block, |h| {
                        h.proxy_jump.get_or_insert(value.clone());
                    })
                }
            }
            // Include / Match / 其它指令：SSH 远程连接不依赖，忽略
            _ => {}
        }
    }
    flush(&mut block, &mut out);
    out
}

/// 对当前 Host 块内每个条目执行一次填充（`get_or_insert` 即"先出现者优先"）
fn fill(block: &mut [ParsedHost], f: impl Fn(&mut ParsedHost)) {
    for host in block.iter_mut() {
        f(host);
    }
}

/// 拆分指令行：`Key Value` 或 `Key=Value`，两段均 trim。
fn split_directive(line: &str) -> Option<(&str, String)> {
    let (key, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
        Some(idx) => (&line[..idx], &line[idx..]),
        // 只有键没有值的行：忽略
        None => return None,
    };
    let value = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key, value.to_string()))
}

/// 当前登录用户名（~/.ssh/config 未指定 User 时，OpenSSH 同样回退到它）
fn local_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_string())
}

/// 把解析结果转成可持久化的目标列表。
pub fn parsed_to_targets(parsed: Vec<ParsedHost>) -> Vec<SshTarget> {
    parsed
        .into_iter()
        .map(|h| {
            let host = h.hostname.unwrap_or_else(|| h.alias.clone());
            let username = h.user.unwrap_or_else(local_username);
            let port = h.port.unwrap_or(22);
            // IdentityFile 存在即视为密钥认证（优先于 agent：更明确、更可诊断）
            let auth_method = if h.identity_file.is_some() {
                "keyfile"
            } else {
                "agent"
            };
            let mut target = SshTarget::new(h.alias, host, port, username, auth_method);
            target.identity_file = h.identity_file;
            target.proxy_jump = h.proxy_jump;
            target
        })
        .collect()
}

/// 读取并解析指定路径的 ssh config（不存在则返回空，不视为错误）。
pub fn load_ssh_config(path: &Path) -> Result<Vec<SshTarget>, ShellError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)?;
    Ok(parsed_to_targets(parse_ssh_config(&text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# 全局默认（不在 Host 块内，按 OpenSSH 语义不归属任何主机）
ServerAliveInterval 30

Host build
    HostName 10.0.0.11
    User root
    Port 2222
    IdentityFile ~/.ssh/id_build

Host db1 db2
    HostName 10.0.0.12
    User dba

Host *
    User wildcard-user

Host jump
    hostname=bastion.example.com
    user=ops
    proxyjump=bastion.example.com
"#;

    #[test]
    fn parses_single_host_block() {
        let hosts = parse_ssh_config(SAMPLE);
        let build = hosts.iter().find(|h| h.alias == "build").expect("build 块");
        assert_eq!(build.hostname.as_deref(), Some("10.0.0.11"));
        assert_eq!(build.user.as_deref(), Some("root"));
        assert_eq!(build.port, Some(2222));
        assert_eq!(build.identity_file.as_deref(), Some("~/.ssh/id_build"));
    }

    #[test]
    fn expands_multiple_aliases() {
        let hosts = parse_ssh_config(SAMPLE);
        assert!(hosts.iter().any(|h| h.alias == "db1"));
        assert!(hosts.iter().any(|h| h.alias == "db2"));
        assert_eq!(hosts.iter().filter(|h| h.hostname.as_deref() == Some("10.0.0.12")).count(), 2);
    }

    #[test]
    fn skips_wildcard_aliases() {
        let hosts = parse_ssh_config(SAMPLE);
        assert!(!hosts.iter().any(|h| h.alias == "*"), "通配符不是可连接主机");
    }

    #[test]
    fn supports_equals_syntax() {
        let hosts = parse_ssh_config(SAMPLE);
        let jump = hosts.iter().find(|h| h.alias == "jump").expect("jump 块");
        assert_eq!(jump.hostname.as_deref(), Some("bastion.example.com"));
        assert_eq!(jump.user.as_deref(), Some("ops"));
        assert_eq!(jump.proxy_jump.as_deref(), Some("bastion.example.com"));
    }

    #[test]
    fn first_value_wins_within_block() {
        let src = "Host a\n User first\n User second\n";
        let hosts = parse_ssh_config(src);
        assert_eq!(hosts[0].user.as_deref(), Some("first"));
    }

    #[test]
    fn ignores_comments_and_include() {
        let src = "# Host ghost\nInclude config.d/*\nHost real\n  HostName 1.2.3.4\n";
        let hosts = parse_ssh_config(src);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
    }

    #[test]
    fn converts_to_targets_with_fallbacks() {
        let src = "Host plain\n  HostName 5.6.7.8\n";
        let targets = parsed_to_targets(parse_ssh_config(src));
        assert_eq!(targets.len(), 1);
        let t = &targets[0];
        assert_eq!(t.host, "5.6.7.8");
        assert_eq!(t.port, 22);
        assert_eq!(t.auth_method, "agent");
        // 未指定 User 时回退到本机用户名，与 OpenSSH 行为一致
        assert!(!t.username.is_empty());
    }

    #[test]
    fn keyfile_auth_detected() {
        let targets = parsed_to_targets(parse_ssh_config(SAMPLE));
        let build = targets.iter().find(|t| t.name == "build").expect("build");
        assert_eq!(build.auth_method, "keyfile");
        assert_eq!(build.identity_file.as_deref(), Some("~/.ssh/id_build"));
    }

    #[test]
    fn stable_id_is_deterministic_and_sensitive() {
        assert_eq!(stable_id("u", "h", 22), stable_id("u", "h", 22));
        assert_ne!(stable_id("u", "h", 22), stable_id("u", "h", 23));
        assert_ne!(stable_id("u", "h", 22), stable_id("v", "h", 22));
    }

    #[test]
    fn store_roundtrip_and_merge() {
        let dir = tempfile::tempdir().unwrap();
        let store = TargetStore::new(dir.path().join("targets.json"));
        assert!(store.load().unwrap().is_empty());

        let a = SshTarget::new("A", "10.0.0.1", 22, "root", "agent");
        let b = SshTarget::new("B", "10.0.0.2", 2222, "ops", "password");
        let (list, added) = store.merge(vec![a.clone(), b.clone()]).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(added, 2);

        // 重复导入不新增
        let (list, added) = store.merge(vec![a.clone()]).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(added, 0);

        // 重新读盘内容一致
        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.iter().find(|t| t.id == b.id).unwrap().port, 2222);

        // 删除
        let left = store.remove(&a.id).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.id);
    }

    #[test]
    fn corrupt_store_reports_instead_of_wiping() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("targets.json");
        std::fs::write(&path, "{ not an array").unwrap();
        let store = TargetStore::new(path.clone());
        let err = store.load().expect_err("损坏文件必须报错");
        assert!(matches!(err, ShellError::Config(_)));
        // 报错不等于销毁：原文件仍在
        assert!(path.exists());
    }
}
