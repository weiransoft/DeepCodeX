//! 远端引擎拉起 + 本地 `-L` 隧道（ARCH §3.1 deploy.rs / tunnel.rs）。
//!
//! ## 为什么不需要"部署"远端二进制
//!
//! 产品前提是**远端已安装 DeepCodeX CLI**（`command -v deepcode` 有值）。
//! 自动下载/上传远端 server 需要目标架构匹配的制品与 scp 通道，收益远低于
//! 复杂度，且失败模式难诊断；因此本模块只做"校验 + 拉起"，缺失时如实报错
//! 并给出安装命令（见 [`crate::ssh::probe::RemoteEnv::ensure_runnable`]）。
//!
//! ## 远端引擎的配置隔离
//!
//! 不碰用户远端的 `~/.deepcode/settings.json`。做法是在远端临时目录放一份
//! **项目级** `.deepcode/settings.json`（web 配置解析里项目级覆盖用户级），
//! 在 `cwd=临时目录` 下启动 `deepcode web`：
//! - `enabled: true` —— 用户级若为 false 也会被项目级覆盖；
//! - `auth.localUsers` —— 配置了本地用户后 web 侧跳过 bootstrap 随机口令，
//!   口令由壳生成并记录，隧道建立后可自动登录（否则用户拿不到远端明文口令）；
//! - `allowRoots: [<远端 HOME>]` —— 文件 API 的访问牢笼。
//!
//! JWT secret 走环境变量注入（等价于 settings 里的 auth.jwtSecret，且不落盘）。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::error::ShellError;
use crate::ssh::{exec, targets::SshTarget};

/// 本地隧道端口就绪等待上限（远端引擎冷启动含 Node 引导与 SQLite 初始化）
pub const READY_TIMEOUT: Duration = Duration::from_secs(45);
/// 远端引擎启动脚本本身的执行超时
const START_TIMEOUT: Duration = Duration::from_secs(25);

/// 远端引擎登录用户名（固定，保证远端会话历史跨次连接可复用）
pub const REMOTE_USERNAME: &str = "desktop";

/// 远端引擎实例（拉起结果）。
#[derive(Debug, Clone)]
pub struct RemoteEngine {
    pub remote_port: u16,
    /// 远端进程 PID（断开时 kill；0 表示未取到）
    pub remote_pid: u32,
    /// 远端临时工作目录（settings.json 与日志所在）
    pub workdir: String,
    /// 本次生成的登录口令（仅驻内存，供 `engine_credentials` 自动登录）
    pub password: String,
}

/// 生成随机口令（base64url 风格字母数字，24 字符 ≈ 143 bit）
pub fn gen_password(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// web 侧 localUsers.passwordHash：小写十六进制 sha256。
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 取一个空闲的本地端口（bind 后立即释放；供隧道本地侧与远端侧复用）。
pub fn pick_free_port() -> Result<u16, ShellError> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// 构造远端启动脚本。
///
/// 拼接的插值全部来自本进程生成的受限字符集（端口数字、十六进制摘要、
/// 固定用户名、临时目录路径），不含用户输入，故无需额外转义。
fn start_script(remote_port: u16, jwt_secret: &str, password_hash: &str, allow_root: &str) -> String {
    let settings = format!(
        r#"{{"web":{{"enabled":true,"host":"127.0.0.1","port":{remote_port},"allowRoots":["{allow_root}"],"auth":{{"localUsers":[{{"username":"{REMOTE_USERNAME}","passwordHash":"{password_hash}"}}]}}}}}}"#
    );
    format!(
        r#"set -e
W=$(mktemp -d "${{TMPDIR:-/tmp}}/deepcode-remote.XXXXXX")
mkdir -p "$W/.deepcode"
printf '%s' '{settings}' > "$W/.deepcode/settings.json"
cd "$W"
# setsid：让引擎成为独立进程组 leader，断开时可按进程组整体回收
# （否则引擎派生的子进程会变成孤儿，实测会在目标机上残留）
if command -v setsid >/dev/null 2>&1; then
  DEEPCODE_WEB_JWT_SECRET='{jwt_secret}' nohup setsid deepcode web --host 127.0.0.1 --port {remote_port} > "$W/engine.log" 2>&1 &
else
  DEEPCODE_WEB_JWT_SECRET='{jwt_secret}' nohup deepcode web --host 127.0.0.1 --port {remote_port} > "$W/engine.log" 2>&1 &
fi
echo "WORKDIR=$W"
echo "PID=$!"
"#
    )
}

/// 解析启动脚本回显（`WORKDIR=` / `PID=`）。
pub fn parse_start_output(stdout: &str) -> (String, u32) {
    let mut workdir = String::new();
    let mut pid = 0u32;
    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("WORKDIR=") {
            workdir = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("PID=") {
            pid = v.trim().parse().unwrap_or(0);
        }
    }
    (workdir, pid)
}

/// 在远端拉起引擎；返回实例信息（尚未建隧道）。
pub fn start_remote_engine(
    target: &SshTarget,
    ssh_password: Option<&str>,
    remote_port: u16,
) -> Result<RemoteEngine, ShellError> {
    let jwt_secret = gen_password(32);
    let password = gen_password(24);
    let password_hash = sha256_hex(&password);
    // allowRoots 用远端 HOME：`~` 由远端 web 侧展开，避免本地误判
    let script = start_script(remote_port, &jwt_secret, &password_hash, "~");

    let out = exec::run_remote(target, ssh_password, &script, START_TIMEOUT)?;
    if out.timed_out {
        return Err(ShellError::Ssh(format!(
            "远端拉起 DeepCodeX 引擎超时（{}s）",
            START_TIMEOUT.as_secs()
        )));
    }
    if !out.success() {
        return Err(ShellError::Ssh(format!(
            "远端启动引擎失败：{}",
            out.failure_reason()
        )));
    }
    let (workdir, remote_pid) = parse_start_output(&out.stdout);
    if workdir.is_empty() {
        return Err(ShellError::Ssh(
            "远端启动脚本未返回工作目录（远端 shell 可能不支持 POSIX mktemp）".into(),
        ));
    }
    Ok(RemoteEngine {
        remote_port,
        remote_pid,
        workdir,
        password,
    })
}

/// 隧道 stderr 日志路径（按目标隔离；断开时清理）
pub fn tunnel_log_path(target_id: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("deepcode-ssh")
        .join(format!("tunnel-{target_id}.log"))
}

/// 建立本地隧道（`-N -L local:127.0.0.1:remote`）。
pub fn open_tunnel(
    target: &SshTarget,
    ssh_password: Option<&str>,
    local_port: u16,
    remote_port: u16,
) -> Result<(std::process::Child, Option<std::path::PathBuf>), ShellError> {
    let log = tunnel_log_path(&target.id);
    let _ = std::fs::remove_file(&log);
    exec::spawn_tunnel(target, ssh_password, local_port, remote_port, &log)
}

/// 从隧道 stderr 日志提炼可行动的诊断。
///
/// 目标机 sshd 的 `AllowTcpForwarding no` 会让转发通道被拒，而客户端
/// 侧表现为"本地端口能连上、但远端始终无响应"——若不做这一步，用户会
/// 一头扎进引擎日志，而真正要改的是目标机的 sshd 配置。
pub fn diagnose_tunnel_log(log_path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(log_path).ok()?;
    if text.contains("administratively prohibited") {
        return Some(
            "目标机 sshd 禁止端口转发：请在目标机 /etc/ssh/sshd_config 中设置 \
             `AllowTcpForwarding yes`（或 AllowTcpForwarding local）后重启 sshd"
                .into(),
        );
    }
    if text.contains("Permission denied") {
        return Some("SSH 认证被拒绝：请检查用户名、密钥或 ssh-agent 中的身份".into());
    }
    if text.contains("Address already in use") {
        return Some("本地隧道端口已被占用：请重试（壳会重新选取端口）".into());
    }
    let last = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())?;
    Some(format!("ssh 隧道输出：{last}"))
}

/// 单次就绪探测结果（三态：区分"隧道没通"与"引擎没起来"）。
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// 已收到 2xx/3xx 响应
    Ok,
    /// TCP 连得上，但没拿到有效 HTTP 响应（引擎还在起步或已崩溃）
    Connected,
    /// 连接失败（隧道未生效 / 端口未监听）
    Unreachable,
}

/// 单次探测：**一次连接**同时判断隧道与引擎。
///
/// 早期实现先 TCP 探测再 HTTP 探测，各建一次连接。对单线程 accept 的服务端
/// （或带 accept 限流的实现）两次连接会互相抢占，出现"隧道通了但 HTTP 一直
/// 拿不到响应"的假故障；合并为一次连接后语义也更准确。
pub fn probe_once(port: u16) -> Probe {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return Probe::Unreachable;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return Probe::Connected;
    }
    let mut buf = [0u8; 16];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            if head.starts_with("HTTP/1.1 2") || head.starts_with("HTTP/1.1 3") {
                Probe::Ok
            } else {
                Probe::Connected
            }
        }
        _ => Probe::Connected,
    }
}

/// 等待本地端口返回 HTTP 2xx/3xx（隧道 + 远端引擎均就绪）。
///
/// `tunnel_alive` 用于在隧道进程已退出时立即失败，而不是干等到超时。
pub fn wait_ready(
    local_port: u16,
    timeout: Duration,
    mut tunnel_alive: impl FnMut() -> bool,
) -> Result<(), ShellError> {
    let deadline = Instant::now() + timeout;
    let mut ever_connected = false;
    while Instant::now() < deadline {
        if !tunnel_alive() {
            return Err(ShellError::Ssh(
                "SSH 隧道进程已退出（端口转发失败或连接被中断）".into(),
            ));
        }
        match probe_once(local_port) {
            Probe::Ok => return Ok(()),
            Probe::Connected => ever_connected = true,
            Probe::Unreachable => {}
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    if ever_connected {
        Err(ShellError::Ssh(format!(
            "隧道已建立（本地端口 {local_port}），但远端引擎在 {}s 内未响应 HTTP。\
             远端引擎可能启动失败，详见远端工作目录下的 engine.log。",
            timeout.as_secs()
        )))
    } else {
        Err(ShellError::Ssh(format!(
            "本地端口 {local_port} 在 {}s 内不可连接：SSH 端口转发未生效。\
             请检查目标机 sshd 是否允许 TcpForwarding，以及本地端口是否被占用。",
            timeout.as_secs()
        )))
    }
}

/// 读取远端引擎日志尾部（诊断用；失败时静默返回空，不掩盖原始错误）。
pub fn remote_log_tail(
    target: &SshTarget,
    ssh_password: Option<&str>,
    workdir: &str,
) -> String {
    let script = format!("tail -n 40 '{workdir}/engine.log' 2>/dev/null || true");
    match exec::run_remote(target, ssh_password, &script, Duration::from_secs(15)) {
        Ok(out) => out.stdout,
        Err(_) => String::new(),
    }
}

/// 停止远端引擎并清理临时目录（断开/失败回滚用；尽力而为，不因单步失败中断）。
///
/// 优先按**进程组**回收（启动时经 setsid 建立）：只 kill 主 PID 时，引擎
/// 派生的子进程会变成孤儿继续占用端口——实测在目标机上留下残留。
pub fn stop_remote_engine(target: &SshTarget, ssh_password: Option<&str>, engine: &RemoteEngine) {
    let kill_part = if engine.remote_pid > 0 {
        format!(
            "kill -TERM -{pid} 2>/dev/null || kill -TERM {pid} 2>/dev/null || true\n\
             sleep 1\n\
             kill -KILL -{pid} 2>/dev/null || true\n",
            pid = engine.remote_pid
        )
    } else {
        String::new()
    };
    let script = format!("{kill_part}rm -rf '{}' 2>/dev/null || true", engine.workdir);
    let _ = exec::run_remote(target, ssh_password, &script, Duration::from_secs(20));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        // 标准测试向量："abc" → ba7816bf...
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn generated_password_shape() {
        let pw = gen_password(24);
        assert_eq!(pw.chars().count(), 24);
        assert!(pw.chars().all(|c| c.is_ascii_alphanumeric()));
        // 只允许无歧义字符集
        assert!(!pw.contains('0') && !pw.contains('O') && !pw.contains('1') && !pw.contains('l'));
        assert_ne!(pw, gen_password(24));
    }

    #[test]
    fn start_script_contains_isolated_settings() {
        let script = start_script(41234, "secretjwt", "deadbeef", "~");
        assert!(script.contains("\"enabled\":true"));
        assert!(script.contains("\"port\":41234"));
        assert!(script.contains("\"passwordHash\":\"deadbeef\""));
        assert!(script.contains("DEEPCODE_WEB_JWT_SECRET='secretjwt'"));
        assert!(script.contains("mktemp -d"));
        // 不写入用户级 settings
        assert!(!script.contains("~/.deepcode/settings.json"));
        assert!(!script.contains("$HOME/.deepcode/settings.json"));
    }

    #[test]
    fn start_script_host_isolated_to_loopback() {
        // 远端引擎只监听回环，绝不暴露到网络
        let script = start_script(1, "j", "h", "~");
        assert!(script.contains("--host 127.0.0.1"));
    }

    #[test]
    fn parse_start_output_extracts_fields() {
        let (w, p) = parse_start_output("WORKDIR=/tmp/deepcode-remote.abc\nPID=9876\n");
        assert_eq!(w, "/tmp/deepcode-remote.abc");
        assert_eq!(p, 9876);
    }

    #[test]
    fn parse_start_output_tolerates_noise() {
        let (w, p) = parse_start_output("bash: welcome banner\nWORKDIR=/w\nPID=\n");
        assert_eq!(w, "/w");
        assert_eq!(p, 0);
    }

    #[test]
    fn pick_free_port_returns_usable_port() {
        let port = pick_free_port().unwrap();
        assert!(port > 1024, "应返回非特权端口");
        // 刻意**不**断言"稍后仍可绑定"：pick_free_port 的语义是"此刻空闲"，
        // 释放后到再次 bind 之间存在竞争窗口，并行用例或其他进程随时可能抢占，
        // 那样的断言必然偶发失败（曾实际发生）。端口真正被占用时由 ssh 的
        // ExitOnForwardFailure 在运行期报错，不靠测试兜底。
        let second = pick_free_port().unwrap();
        assert!(second > 1024);
    }

    #[test]
    fn wait_ready_fails_fast_when_tunnel_dies() {
        let start = Instant::now();
        let err = wait_ready(1, Duration::from_secs(5), || false).expect_err("隧道已退出必须报错");
        assert!(err.to_string().contains("隧道进程已退出"));
        // 不应等满 5 秒
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
