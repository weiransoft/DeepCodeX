//! 本地密钥库（ARCH DCA-ARCH-DESKTOP-001 §3.1 secrets/store.rs）。
//!
//! 2026-10-30 起默认实现为本地 SQLite（desktop-secrets.db，0600）——
//! 弃用 macOS 钥匙串（壳二进制重建后 ACL 失配导致反复弹 GUI 授权框）。
//! 供应商 API Key 的读写自 M3 供应商插件启用
//! （FR-3.2：Key 只进密钥库，settings.json 仅存引用名）。
//! `keyring` 依赖仅服务一次性迁移（钥匙串旧条目 → SQLite）。

pub mod store;
