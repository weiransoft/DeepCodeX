//! SSH 远程连接子系统（ARCH DCA-ARCH-DESKTOP-001 §3.1/§3.3）。
//!
//! 分层：
//! - [`targets`] 目标存储与 `~/.ssh/config` 解析（纯逻辑 + 文件 IO）
//! - [`exec`]    `ssh` 进程构造、密码 askpass 通道、带超时的命令执行
//! - [`probe`]   远端环境探测（OS/架构/CLI 可用性）
//! - [`tunnel`]  远端引擎拉起 + 本地 `-L` 端口转发 + 就绪探测
//! - [`manager`] 连接生命周期状态机与四阶段编排（含失败回滚）
//!
//! 安全边界：本子系统**不引入** shell/fs 插件能力，所有远端动作都由
//! `ssh` 子进程承载；口令只驻内存并经环境变量传给 askpass，绝不落盘。

pub mod exec;
pub mod manager;
pub mod probe;
pub mod targets;
pub mod tunnel;
