//! 引擎子模块：本地 deepcode web 引擎生命周期（manager）、
//! 动态端口分配（port）、用户设置读写（settings）。
//!
//! M2 的 SSH 远程引擎管理（远端 server 安装/隧道/就绪）在
//! ARCH DCA-ARCH-DESKTOP-001 §3.3 规划，届时在本模块新增 `remote.rs`，
//! 与本地 `manager.rs` 共享探活、端口、状态机等基础设施。

pub mod manager;
pub mod port;
pub mod settings;
