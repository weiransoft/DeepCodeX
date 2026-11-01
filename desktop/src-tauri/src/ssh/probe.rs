//! 远端环境探测（ARCH §3.1 probe.rs）。
//!
//! 连接前先确认"能不能在这台机器上跑 DeepCodeX 引擎"，把不可行的情况
//! 挡在隧道建立之前——而不是让用户等 30 秒隧道超时再看到一句 "failed"。

use std::time::Duration;

use crate::error::ShellError;
use crate::ssh::exec;
use crate::ssh::targets::SshTarget;

/// 探测超时（含首次 SSH 握手与主机密钥确认）
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// 远端环境事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEnv {
    pub os: String,
    pub arch: String,
    /// 远端 `deepcode` 可执行文件路径（`command -v` 结果）
    pub deepcode: Option<String>,
    /// 远端 `node` 路径
    pub node: Option<String>,
    /// 远端 HOME（远端引擎的 `~/.deepcode` 落点）
    pub home: String,
}

impl RemoteEnv {
    /// 一句话摘要（进度事件里展示）
    pub fn summary(&self) -> String {
        let dc = self
            .deepcode
            .as_deref()
            .map_or("未安装", |p| p);
        format!("{} {} · deepcode={}", self.os, self.arch, dc)
    }

    /// 远端是否具备运行引擎的条件
    pub fn ensure_runnable(&self) -> Result<(), ShellError> {
        if self.deepcode.is_some() {
            return Ok(());
        }
        Err(ShellError::Ssh(format!(
            "远端未安装 DeepCodeX CLI（{} {}，HOME={}）。\n\
             请先在远端安装后重试：\n    npm install -g @vegamo/deepcode-cli\n\
             或使用仓库内构建产物：cd <repo> && npm run build && npm link\n\
             （本次连接未做任何远端变更）",
            self.os, self.arch, self.home
        )))
    }
}

/// 探测脚本：单次 SSH 往返取回全部事实。
///
/// 只用 POSIX sh 内建命令（`uname`/`command`/`printf`），不依赖 bash 扩展——
/// 远端默认 shell 可能是 dash/ash。
const PROBE_SCRIPT: &str = r#"printf 'OS=%s\n' "$(uname -s 2>/dev/null || echo unknown)"
printf 'ARCH=%s\n' "$(uname -m 2>/dev/null || echo unknown)"
printf 'DEEPCODE=%s\n' "$(command -v deepcode 2>/dev/null || :)"
printf 'NODE=%s\n' "$(command -v node 2>/dev/null || :)"
printf 'HOME=%s\n' "${HOME:-}"
"#;

/// 解析探测脚本输出（键值行，未知键忽略）。
pub fn parse_probe_output(stdout: &str) -> RemoteEnv {
    let mut os = String::new();
    let mut arch = String::new();
    let mut deepcode = None;
    let mut node = None;
    let mut home = String::new();

    for line in stdout.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "OS" => os = value.to_string(),
            "ARCH" => arch = value.to_string(),
            "DEEPCODE" => {
                if !value.is_empty() {
                    deepcode = Some(value.to_string());
                }
            }
            "NODE" => {
                if !value.is_empty() {
                    node = Some(value.to_string());
                }
            }
            "HOME" => home = value.to_string(),
            _ => {}
        }
    }
    RemoteEnv {
        os: if os.is_empty() { "unknown".into() } else { os },
        arch: if arch.is_empty() { "unknown".into() } else { arch },
        deepcode,
        node,
        home,
    }
}

/// 执行远端探测。
pub fn probe(target: &SshTarget, password: Option<&str>) -> Result<RemoteEnv, ShellError> {
    let out = exec::run_remote(target, password, PROBE_SCRIPT, PROBE_TIMEOUT)?;
    if out.timed_out {
        return Err(ShellError::Ssh(format!(
            "探测 {} 超时（{}s）：目标可能不可达或被防火墙拦截",
            target.display_addr(),
            PROBE_TIMEOUT.as_secs()
        )));
    }
    if !out.success() {
        return Err(ShellError::Ssh(format!(
            "无法连接 {}：{}",
            target.display_addr(),
            out.failure_reason()
        )));
    }
    let env = parse_probe_output(&out.stdout);
    if env.os == "unknown" {
        return Err(ShellError::Ssh(
            "远端不是 POSIX 环境（uname 不可用）。当前仅支持 macOS / Linux 远端；\
             Windows 远端（OpenSSH Server 默认 cmd shell）暂不支持。"
                .into(),
        ));
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_fields() {
        let out = "OS=Linux\nARCH=x86_64\nDEEPCODE=/usr/local/bin/deepcode\nNODE=/usr/bin/node\nHOME=/home/dev\n";
        let env = parse_probe_output(out);
        assert_eq!(env.os, "Linux");
        assert_eq!(env.arch, "x86_64");
        assert_eq!(env.deepcode.as_deref(), Some("/usr/local/bin/deepcode"));
        assert_eq!(env.node.as_deref(), Some("/usr/bin/node"));
        assert_eq!(env.home, "/home/dev");
    }

    #[test]
    fn empty_deepcode_becomes_none() {
        let out = "OS=Linux\nARCH=arm64\nDEEPCODE=\nNODE=\nHOME=/root\n";
        let env = parse_probe_output(out);
        assert!(env.deepcode.is_none());
        assert!(env.node.is_none());
    }

    #[test]
    fn tolerates_extra_noise_lines() {
        // 用户的 .bashrc 常往 stdout 打横幅
        let out = "Welcome to build server!\nOS=Linux\nARCH=aarch64\nDEEPCODE=\nNODE=/usr/bin/node\nHOME=/home/ci\n";
        let env = parse_probe_output(out);
        assert_eq!(env.os, "Linux");
        assert_eq!(env.node.as_deref(), Some("/usr/bin/node"));
    }

    #[test]
    fn missing_os_falls_back_to_unknown() {
        let env = parse_probe_output("");
        assert_eq!(env.os, "unknown");
        assert_eq!(env.arch, "unknown");
        assert_eq!(env.home, "");
    }

    #[test]
    fn ensure_runnable_rejects_missing_cli_with_actionable_hint() {
        let env = RemoteEnv {
            os: "Linux".into(),
            arch: "x86_64".into(),
            deepcode: None,
            node: Some("/usr/bin/node".into()),
            home: "/home/ci".into(),
        };
        let err = env.ensure_runnable().expect_err("未安装必须报错");
        let msg = err.to_string();
        assert!(msg.contains("npm install -g"), "必须给出可执行的安装指引：{msg}");
        assert!(msg.contains("/home/ci"));
    }

    #[test]
    fn ensure_runnable_accepts_installed_cli() {
        let env = RemoteEnv {
            os: "Darwin".into(),
            arch: "arm64".into(),
            deepcode: Some("/opt/homebrew/bin/deepcode".into()),
            node: None,
            home: "/Users/dev".into(),
        };
        assert!(env.ensure_runnable().is_ok());
        assert!(env.summary().contains("Darwin arm64"));
    }
}
