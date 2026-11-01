//! 127.0.0.1 动态端口分配（ARCH DCA-ARCH-DESKTOP-001 §3.1 engine/port.rs）。
//!
//! 引擎端口要求（PRD FR-1.3）：动态分配避开占用、只绑 127.0.0.1。
//! 实现：bind 127.0.0.1:0 让内核指派，读出端口后立即 drop 释放，把端口让给引擎。
//! 存在理论竞态（探测后端口被他进程抢占），由上层"健康检查失败换端口重试"兜底。

use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::Duration;

use crate::error::ShellError;

/// 在 127.0.0.1 上分配一个空闲端口（bind :0 内核指派后释放）。
pub fn pick_free_port() -> Result<u16, ShellError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// 探测端口当前是否空闲（仅针对 127.0.0.1；M1 供测试与诊断使用）。
#[allow(dead_code)]
pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// 探测端口能否建立 TCP 连接（引擎进程存活的粗判；M1 供测试与残留判定使用）。
#[allow(dead_code)]
pub fn can_connect(port: u16, timeout: Duration) -> bool {
    let addr = std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_port_returns_released_port() {
        let p = pick_free_port().unwrap();
        assert!(p > 0, "端口必须为合法值");
        // 探测后已释放：可以重新 bind 同一端口
        assert!(is_port_free(p), "释放后的端口应可重新绑定");
    }

    #[test]
    fn is_port_free_detects_occupied_port() {
        // 占住一个端口：is_port_free 必须返回 false；释放后恢复 true
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_port_free(port), "被占用端口不应判定为空闲");
        drop(listener);
        assert!(is_port_free(port), "释放后端口应判定为空闲");
    }

    #[test]
    fn can_connect_false_on_free_port() {
        let port = pick_free_port().unwrap();
        assert!(
            !can_connect(port, Duration::from_millis(200)),
            "空闲端口不应可建立连接"
        );
    }
}
