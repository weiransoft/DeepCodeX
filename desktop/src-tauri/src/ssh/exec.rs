//! SSH 进程构造与带超时的命令执行。
//!
//! 设计取舍：**不引入 ssh2/russh 库**，统一调用系统 `ssh` 可执行文件。
//! 理由：`-L` 端口转发的行为（ProxyJump / agent / 证书 / known_hosts /
//! 系统 ssh_config 全部语义）由 OpenSSH 自身保证，壳层只需正确编排参数；
//! 而链入 libssh2/russh 会带来 C 依赖与平台编译差异，与"Windows 零依赖打包"
//! 的既有约束冲突。代价是要求目标机具备系统 OpenSSH 客户端
//! （macOS/Linux 自带，Windows 10+ 为可选功能）。

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::ShellError;
use crate::ssh::targets::SshTarget;

/// 密码以环境变量形式交给 askpass 脚本，**不写入脚本文件本身**。
const PASSWORD_ENV: &str = "DEEPCODE_SSH_PASSWORD";

/// 单次命令捕获结果。
pub struct CapturedOutput {
    /// 退出码（被信号杀死时可能为 None）
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// 是否因超时被强杀
    pub timed_out: bool,
}

impl CapturedOutput {
    /// 命令是否成功（退出码 0）
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// 失败时的可读原因（优先 stderr 末行，其次退出码/超时）
    pub fn failure_reason(&self) -> String {
        if self.timed_out {
            return "命令执行超时".to_string();
        }
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            // OpenSSH 诊断冗长，取最后一行最贴近原因
            return stderr.lines().last().unwrap_or(stderr).to_string();
        }
        match self.code {
            Some(code) => format!("命令退出码 {code}"),
            None => "命令异常终止".to_string(),
        }
    }
}

/// 构造 ssh 基础命令（共用连接参数 + 认证方式）。
///
/// `password` 非空时走密码认证：关闭 BatchMode、禁用公钥、经 askpass 传口令。
/// **Windows 不支持该路径**——OpenSSH for Windows 不实现 `SSH_ASKPASS_REQUIRE`，
/// 宁可明确报错也不让用户卡在一个必然失败的认证上。
fn base_command(
    target: &SshTarget,
    password: Option<&str>,
    extra: &[String],
) -> Result<(Command, Option<std::path::PathBuf>), ShellError> {
    let mut cmd = Command::new("ssh");

    // 首次连接自动接受主机密钥：桌面客户端无法与用户交互确认指纹。
    // 已存在且不匹配时仍会失败（不覆盖既有指纹），保留中间人防护。
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o").arg("ConnectTimeout=10");
    cmd.arg("-o").arg("ServerAliveInterval=15");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    // 不读取 stdin：避免 ssh 抢走壳进程的输入
    cmd.stdin(Stdio::null());

    let mut askpass_path = None;
    match password {
        Some(pw) if !pw.is_empty() => {
            #[cfg(windows)]
            {
                let _ = (pw, &mut askpass_path);
                return Err(ShellError::Ssh("Windows 下暂不支持密码认证：OpenSSH for Windows 不提供 \
                    SSH_ASKPASS_REQUIRE。请改用密钥或 ssh-agent（连接表单里选择「系统 ssh agent」）。"
                    .into()));
            }
            #[cfg(not(windows))]
            {
                cmd.arg("-o").arg("BatchMode=no");
                cmd.arg("-o").arg("PreferredAuthentications=password,keyboard-interactive");
                cmd.arg("-o").arg("PubkeyAuthentication=no");
                cmd.arg("-o").arg("NumberOfPasswordPrompts=1");
                let path = write_askpass_script(&target.id)?;
                cmd.env("SSH_ASKPASS", &path);
                // force：无需 DISPLAY / setsid，ssh 无条件调用 askpass（OpenSSH 8.4+）
                cmd.env("SSH_ASKPASS_REQUIRE", "force");
                cmd.env(PASSWORD_ENV, pw);
                askpass_path = Some(path);
            }
        }
        _ => {
            // 无人值守：任何需要交互的认证直接失败，附明确的 stderr 原因
            cmd.arg("-o").arg("BatchMode=yes");
        }
    }

    if let Some(key) = target.identity_file.as_deref() {
        cmd.arg("-i").arg(expand_home(key));
        // 密钥路径由用户配置，显式指定时不因权限告警中断
        cmd.arg("-o").arg("IdentitiesOnly=yes");
    }
    if let Some(jump) = target.proxy_jump.as_deref() {
        cmd.arg("-J").arg(jump);
    }
    cmd.arg("-p").arg(target.port.to_string());

    for arg in extra {
        cmd.arg(arg);
    }
    // 目标放最后（ssh 语义：host 之后的参数是远端命令）
    cmd.arg(format!("{}@{}", target.username, target.host));

    Ok((cmd, askpass_path))
}

/// `~` 展开（IdentityFile 常见写法 `~/.ssh/id_ed25519`）
fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        // HOME 优先（unix / git-bash），回退 USERPROFILE（Windows 原生）。
        // 用 Path::join 而不是拼 `/`：Windows 家目录是 `C:\Users\x`，
        // 直接拼会得到 `C:\Users\x/.ssh/id` 这种混合分隔符。
        for var in ["HOME", "USERPROFILE"] {
            if let Ok(home) = std::env::var(var) {
                return std::path::Path::new(&home)
                    .join(rest)
                    .to_string_lossy()
                    .into_owned();
            }
        }
    }
    path.to_string()
}

/// 写 askpass 脚本（unix）：从环境变量读口令并打印。
///
/// 脚本本身**不含口令**，口令只经子进程环境传递；文件权限 0700。
#[cfg(not(windows))]
fn write_askpass_script(target_id: &str) -> Result<std::path::PathBuf, ShellError> {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join("deepcode-ssh");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("askpass-{target_id}.sh"));
    let body = format!("#!/bin/sh\nprintf '%s\\n' \"${PASSWORD_ENV}\"\n");
    std::fs::write(&path, body)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

/// 删除某个目标的 askpass 脚本（连接结束/失败时清理口令通道）。
pub fn cleanup_askpass(target_id: &str) {
    let path = std::env::temp_dir()
        .join("deepcode-ssh")
        .join(format!("askpass-{target_id}.sh"));
    let _ = std::fs::remove_file(path);
}

/// 执行远端命令并捕获输出（`ssh <opts> <host> <command>`）。
///
/// `command` 以单个字符串传入，由远端 shell 解释——仅在拼接**常量**脚本时使用，
/// 绝不插入未经校验的用户输入。
pub fn run_remote(
    target: &SshTarget,
    password: Option<&str>,
    command: &str,
    timeout: Duration,
) -> Result<CapturedOutput, ShellError> {
    let (mut cmd, askpass) = base_command(target, password, &[])?;
    cmd.arg(command);
    let result = run_with_timeout(&mut cmd, timeout);
    if let Some(path) = askpass {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// 隧道专用参数（`-N` + `ExitOnForwardFailure` + `-L`）。
///
/// 必须经 [`base_command`] 的 `extra` 插入到 **host 之前**：ssh 的语法是
/// `ssh [选项] host [远端命令]`，host 之后的任何 `-x` 都会被当作远端命令
/// 而不是选项（曾因此把 `-N -L` 发给远端 shell，隧道静默失效）。
pub fn tunnel_extra(local_port: u16, remote_port: u16) -> Vec<String> {
    vec![
        "-N".to_string(),
        "-o".to_string(),
        // 本地端口被占用时立即失败，避免"看起来起了但实际没通"
        "ExitOnForwardFailure=yes".to_string(),
        "-L".to_string(),
        format!("{local_port}:127.0.0.1:{remote_port}"),
    ]
}

/// 启动长驻隧道：`ssh -N -L <local>:127.0.0.1:<remote> ...`
///
/// `log_path` 收集 ssh 的 stderr：转发被目标机 sshd 拒绝时，客户端只会看到
/// "连上了但没响应"，真正原因（`administratively prohibited`）只出现在这里。
/// 返回子进程与 askpass 脚本路径（由隧道结构负责回收）。
pub fn spawn_tunnel(
    target: &SshTarget,
    password: Option<&str>,
    local_port: u16,
    remote_port: u16,
    log_path: &std::path::Path,
) -> Result<(std::process::Child, Option<std::path::PathBuf>), ShellError> {
    let extra = tunnel_extra(local_port, remote_port);
    let (mut cmd, askpass) = base_command(target, password, &extra)?;
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    cmd.stdout(Stdio::null()).stderr(Stdio::from(log));
    let child = cmd.spawn().map_err(map_spawn_error)?;
    Ok((child, askpass))
}

/// `ssh` 可执行文件缺失时给出可行动的提示（而非裸 io::Error）。
fn map_spawn_error(err: std::io::Error) -> ShellError {
    if err.kind() == std::io::ErrorKind::NotFound {
        return ShellError::Ssh(
            "未找到 ssh 客户端。请安装 OpenSSH 客户端：macOS/Linux 通常自带；\
             Windows 可在「设置 → 应用 → 可选功能」中添加「OpenSSH 客户端」。"
                .into(),
        );
    }
    ShellError::Io(err)
}

/// 执行命令并收集输出，超时则强杀。
///
/// stdout/stderr 各由一个线程读干，主线程只轮询退出状态——避免管道缓冲区
/// 写满导致的互锁（ssh 的 verbose 诊断输出很容易超过管道容量）。
pub fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<CapturedOutput, ShellError> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(map_spawn_error)?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let read_all = |pipe: Option<std::process::ChildStdout>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let out_reader = read_all(stdout_pipe);

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let code = loop {
        match child.try_wait()? {
            Some(status) => break status.code(),
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(CapturedOutput {
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> SshTarget {
        SshTarget::new("t", "example.com", 2222, "root", "agent")
    }

    /// 独立目标：askpass 文件按 target_id 命名，并行用例必须用不同 id，
    /// 否则会互相删除对方刚写好的脚本（曾导致偶发失败）
    fn target_with(port: u16) -> SshTarget {
        SshTarget::new("t", "example.com", port, "root", "agent")
    }

    #[test]
    fn expands_tilde_identity() {
        let expanded = expand_home("~/.ssh/id_ed25519");
        assert!(!expanded.contains('~'), "~ 必须被展开：{expanded}");
        assert!(
            std::path::Path::new(&expanded).is_absolute(),
            "展开后必须是绝对路径：{expanded}"
        );
        assert!(
            expanded.replace('\\', "/").ends_with("/.ssh/id_ed25519"),
            "展开后必须保留相对部分：{expanded}"
        );
        assert_eq!(expand_home("/abs/key"), "/abs/key");
        assert_eq!(expand_home("rel/key"), "rel/key");
    }

    #[test]
    fn base_command_ordering_puts_host_last() {
        let t = target();
        let (cmd, _) = base_command(&t, None, &[]).unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args.last().unwrap(), "root@example.com");
        assert!(args.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"));
        // 无人值守模式必须显式关掉交互
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a.contains("accept-new")));
    }

    #[test]
    fn agent_mode_has_no_askpass() {
        let (_, askpass) = base_command(&target(), None, &[]).unwrap();
        assert!(askpass.is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn password_mode_writes_askpass_without_secret() {
        let (cmd, askpass) = base_command(&target_with(2201), Some("s3cret"), &[]).unwrap();
        let path = askpass.expect("密码认证应生成 askpass 脚本");
        let body = std::fs::read_to_string(&path).unwrap();
        // 口令绝不落进脚本文件
        assert!(!body.contains("s3cret"));
        assert!(body.contains(PASSWORD_ENV));
        let envs: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        assert!(envs.iter().any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v == "force"));
        assert!(envs.iter().any(|(k, v)| k == PASSWORD_ENV && v == "s3cret"));
        let _ = std::fs::remove_file(path);
    }

    #[cfg(not(windows))]
    #[test]
    fn password_mode_disables_pubkey() {
        let (cmd, askpass) = base_command(&target_with(2202), Some("pw"), &[]).unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        if let Some(p) = askpass {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn run_with_timeout_captures_and_kills() {
        #[cfg(unix)]
        {
            let mut ok = Command::new("sh");
            ok.arg("-c").arg("printf hello");
            let out = run_with_timeout(&mut ok, Duration::from_secs(5)).unwrap();
            assert!(out.success());
            assert_eq!(out.stdout, "hello");

            let mut slow = Command::new("sh");
            slow.arg("-c").arg("sleep 5");
            let out = run_with_timeout(&mut slow, Duration::from_millis(300)).unwrap();
            assert!(out.timed_out, "超时必须强杀并标记");
            assert!(!out.success());
        }
    }

    #[test]
    fn tunnel_args_precede_host() {
        // 回归护栏：host 之后的 -N/-L 会被 ssh 当作远端命令，隧道静默失效
        let extra = tunnel_extra(5001, 6001);
        let (cmd, _) = base_command(&target(), None, &extra).unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let host_pos = args.len() - 1;
        assert_eq!(args[host_pos], "root@example.com", "host 必须是最后一个参数");
        let l_pos = args.iter().position(|a| a == "-L").expect("应含 -L");
        assert!(l_pos < host_pos, "-L 必须在 host 之前：{args:?}");
        assert!(args.contains(&"-N".to_string()));
        assert_eq!(args[l_pos + 1], "5001:127.0.0.1:6001");
        // 转发失败必须立即退出，而不是留下"看似成功"的空隧道
        assert!(args.iter().any(|a| a == "ExitOnForwardFailure=yes"));
    }

    #[test]
    fn run_remote_puts_command_after_host() {
        // run_remote 的远端命令本就该在 host 之后（与隧道参数相反）
        let (cmd, _) = base_command(&target(), None, &[]).unwrap();
        let mut cmd = cmd;
        cmd.arg("uname -s");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[args.len() - 2], "root@example.com");
        assert_eq!(args[args.len() - 1], "uname -s");
    }

    #[test]
    fn failure_reason_prefers_last_stderr_line() {
        let out = CapturedOutput {
            code: Some(255),
            stdout: String::new(),
            stderr: "line1\nPermission denied (publickey).\n".into(),
            timed_out: false,
        };
        assert_eq!(out.failure_reason(), "Permission denied (publickey).");
    }
}
