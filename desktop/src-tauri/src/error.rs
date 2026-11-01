//! 壳层统一错误类型。
//!
//! 所有 `#[tauri::command]` 返回 `Result<T, ShellError>`，Tauri 会序列化为
//! `{ kind, message }` 结构供前端展示；`message` 面向用户，必须可读、可行动。

use serde::Serialize;

/// 壳层错误：按来源分类，便于前端区分处置方式（重试/检查配置/查看日志）。
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    /// 引擎可执行文件未找到/不可执行（配置错误，需用户修改设置）
    #[error("DeepCode 引擎不可用：{0}")]
    EngineNotFound(String),
    /// 引擎启动失败（进程退出/超时，附日志路径）
    #[error("引擎启动失败：{0}")]
    EngineStart(String),
    /// 健康检查未通过
    #[error("引擎健康检查失败：{0}")]
    EngineHealth(String),
    /// 密钥存储不可用（Keychain / Credential Manager 异常或被拒绝）
    #[error("系统密钥库操作失败：{0}")]
    #[allow(dead_code)] // M3 供应商插件启用
    SecretStore(String),
    /// 配置读写失败
    #[error("配置读写失败：{0}")]
    Config(String),
    /// 供应商连通性测试失败（透传上游原始错误，帮助用户自查）
    #[error("连通性测试失败：{0}")]
    #[allow(dead_code)] // M3 供应商插件启用
    ProviderTest(String),
    /// 引擎运行异常（重启次数超限等）
    #[error("引擎运行异常：{0}")]
    EngineRuntime(String),
    /// IO 错误（日志、settings.json、端口探测等）
    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),
    /// JSON 序列化/解析错误（settings.json 读写等）
    #[error("JSON 处理失败：{0}")]
    Json(#[from] serde_json::Error),
    /// SSH 远程连接失败：目标不可达、认证失败、远端缺少运行时、
    /// 隧道建立失败等。`message` 面向用户，必须可行动。
    #[error("SSH 远程连接失败：{0}")]
    Ssh(String),
}

/// 序列化为前端可读结构：`{ "kind": "EngineStart", "message": "..." }`。
impl Serialize for ShellError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            ShellError::EngineNotFound(_) => "EngineNotFound",
            ShellError::EngineStart(_) => "EngineStart",
            ShellError::EngineHealth(_) => "EngineHealth",
            ShellError::SecretStore(_) => "SecretStore",
            ShellError::Config(_) => "Config",
            ShellError::ProviderTest(_) => "ProviderTest",
            ShellError::EngineRuntime(_) => "EngineRuntime",
            ShellError::Io(_) => "Io",
            ShellError::Json(_) => "Json",
            ShellError::Ssh(_) => "Ssh",
        };
        let mut s = serializer.serialize_struct("ShellError", 2)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

/// 便于 `?` 传播：字符串错误统一映射到配置类。
impl From<String> for ShellError {
    fn from(v: String) -> Self {
        ShellError::Config(v)
    }
}
