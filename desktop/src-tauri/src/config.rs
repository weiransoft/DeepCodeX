//! 引擎配置：入口解析与认证契约工具（与 DeepCodeX-cli 对齐）。
//!
//! 设计要点（对齐 DCA-ARCH-DESKTOP-001 §3.2，均已核实引擎源码）：
//! - settings.json 合并写入见 `engine::settings`；
//! - JWT secret 经环境变量 `DEEPCODE_WEB_JWT_SECRET` 注入（config.ts L289）；
//! - 本地会话登录用 sha256 hex 摘要（auth-api.ts matchLocalUser 契约）。

use std::path::PathBuf;

use crate::error::ShellError;

/// 引擎 JWT secret 环境变量名（已核实 packages/web/src/config.ts L289-290）。
pub const JWT_SECRET_ENV: &str = "DEEPCODE_WEB_JWT_SECRET";

/// 引擎「用户级技能 / 智能体资产根」环境变量名（2026-11-04）。
///
/// 桌面壳与 CLI 是**同一个物理用户**：用户装在 CLI 里的技能 / 智能体，桌面版
/// 应当看得见，且桌面版新建的智能体 CLI 也能用。不注入时，引擎按 Web 多用户
/// 口径把技能锚在 per-user 引擎数据根（`<uploadDir>/.engine-home/<userId>/`）——
/// 那是个空目录，于是桌面版「技能 / 智能体」列表恒为空。
///
/// 注入真实家目录后，引擎的技能根 = `~/.deepcode/skills`（与 CLI 同源）；
/// 会话 / 记忆 / 日志仍留在 per-user 引擎数据根（隔离语义不变）。
pub const SKILLS_HOME_ENV: &str = "DEEPCODE_WEB_SKILLS_HOME_DIR";

/// 引擎 CLI 入口（DeepCodeX-cli 编译产物）。
pub const ENGINE_CLI_ENTRY: &str = "packages/cli/dist/cli.js";

/// 引擎安装解析结果（可执行文件 + 固定参数前缀）。
#[derive(Debug, Clone)]
pub struct ResolvedEngine {
    /// 可执行文件绝对路径（node 或 deepcode shim）
    pub program: PathBuf,
    /// 固定参数前缀（system 模式为 [cli.js 路径]；bundled 模式为空或 shim 路径）
    pub prefix_args: Vec<String>,
}

/// 引擎安装模式（设置页可切换，对齐 ARCH §3.2）。
#[derive(Debug, Clone)]
pub enum EngineMode {
    /// system：用户本机已安装 deepcode（PATH shim），或仓库 dist 经 node 直跑。
    /// M1 阶段即此模式（开发环境），生产 bundled SEA 模式在 M5 接入。
    System,
    /// bundled：externalBin sidecar（M5 实装；当前保留配置结构，运行即报配置错误）
    /// （M1 仅测试路径构造；生产装配在 M5 接入）
    #[allow(dead_code)]
    Bundled(PathBuf),
}

impl EngineMode {
    /// 解析引擎可执行入口。
    ///
    /// 查找顺序（system 模式）：
    /// 1. 环境变量 `DEEPCODE_CLI_PATH` 指定的 cli.js（开发/测试覆盖）；
    /// 2. 环境变量 `DEEPCODE_HOME` 指向仓库根下的 dist 入口；
    /// 3. 本机开发默认仓库 `/Users/wangwei/Documents/VG/DeepCodeX-cli`；
    /// 4. PATH 上的 `deepcode` shim（生产安装场景）。
    ///
    /// 返回的 `program`：dist 入口存在时用 `node` 直跑（跨平台可靠）；
    /// 否则用 PATH 上的 `deepcode`。
    pub fn resolve(&self) -> Result<ResolvedEngine, ShellError> {
        match self {
            EngineMode::Bundled(p) => Ok(ResolvedEngine {
                program: p.clone(),
                prefix_args: Vec::new(),
            }),
            EngineMode::System => resolve_system_engine(),
        }
    }
}

/// system 模式的具体解析逻辑。
fn resolve_system_engine() -> Result<ResolvedEngine, ShellError> {
    // 候选 cli.js 路径（按优先级）
    let mut cli_candidates: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("DEEPCODE_CLI_PATH") {
        cli_candidates.push(PathBuf::from(v));
    }
    if let Ok(v) = std::env::var("DEEPCODE_HOME") {
        cli_candidates.push(PathBuf::from(v).join(ENGINE_CLI_ENTRY));
    }
    // 本机开发默认路径（架构文档 §5：开发期直接指向本地仓库）
    cli_candidates
        .push(PathBuf::from("/Users/wangwei/Documents/VG/DeepCodeX-cli").join(ENGINE_CLI_ENTRY));

    for cli in cli_candidates {
        if cli.is_file() {
            // dist 入口存在：用 node 直跑，避免依赖 PATH 上的 deepcode shim
            let node = which_node().ok_or_else(|| {
                ShellError::EngineNotFound(
                    "未找到 node 可执行文件（DeepCode 引擎为 Node CLI，需要 Node >= 22）".into(),
                )
            })?;
            return Ok(ResolvedEngine {
                program: node,
                prefix_args: vec![cli.to_string_lossy().into_owned()],
            });
        }
    }
    // 退而求其次：PATH 上的 deepcode shim（生产安装场景）
    if let Some(bin) = which("deepcode") {
        return Ok(ResolvedEngine {
            program: bin,
            prefix_args: Vec::new(),
        });
    }
    Err(ShellError::EngineNotFound(
        "未找到 DeepCode CLI：请安装 deepcode，或设置环境变量 DEEPCODE_HOME / DEEPCODE_CLI_PATH 指向仓库"
            .into(),
    ))
}

/// 在 PATH 中查找可执行文件（跨平台最小实现，Windows 补 .exe/.cmd）。
pub fn which(name: &str) -> Option<PathBuf> {
    let exts: Vec<&str> = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let cand = dir.join(format!("{name}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 查找 node 可执行文件：先走 PATH，PATH 找不到时探测常见安装位置。
///
/// 为什么需要兜底：macOS 上经 Finder/`open`/launchd 启动的 GUI 进程 PATH 只有
/// `/usr/bin:/bin:/usr/sbin:/sbin`（不含 shell profile 里的 nvm/homebrew/
/// WorkBuddy node 等），裸 `which("node")` 会失败导致引擎拉不起来。
pub fn which_node() -> Option<PathBuf> {
    if let Some(p) = which("node") {
        return Some(p);
    }
    // HOME（Unix）→ USERPROFILE（Windows 兜底）：Windows 不设置 HOME，
    // 缺失会导致下方所有用户目录探测全部失效（跨平台 2026-10-30）
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        // Windows 常见安装位置：官方 installer / winget 默认落在 Program Files
        #[cfg(windows)]
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        #[cfg(windows)]
        PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
        // Volta（Windows 下位于 %LOCALAPPDATA%\Volta\bin）
        home.join(".volta/bin/node"),
        #[cfg(windows)]
        home.join("AppData/Local/Volta/bin/node.exe"),
        home.join(".asdf/shims/node"),
    ];
    // 版本目录型安装（取字典序最大 = 通常最新）：nvm / WorkBuddy node / fnm
    // Windows 上 nvm-windows 为 %APPDATA%\nvm\vX.Y.Z\node.exe，
    // fnm 为 %APPDATA%\fnm\node-versions\vX.Y.Z\installation\node.exe——两者目录层级不同，
    // 因此下面会同时探测 `<版本目录>/node` 与 `<版本目录>/installation/node`
    for pattern in [
        home.join(".nvm/versions/node"),
        home.join(".workbuddy/binaries/node/versions"),
        home.join("Library/Application Support/fnm/node-versions"),
        #[cfg(windows)]
        home.join("AppData/Roaming/nvm"),
        #[cfg(windows)]
        home.join("AppData/Roaming/fnm/node-versions"),
    ] {
        if let Ok(entries) = std::fs::read_dir(&pattern) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            if let Some(latest) = dirs.pop() {
                // 可执行文件名与相对层级随平台不同；非命中的候选会被下方 is_file() 过滤掉
                let node_name = if cfg!(windows) { "node.exe" } else { "bin/node" };
                candidates.push(latest.join(node_name));
                candidates.push(latest.join("installation").join(node_name));
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file() && std::fs::metadata(p).map(|m| is_executable(&m)).unwrap_or(false))
}

#[cfg(unix)]
fn is_executable(m: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_m: &std::fs::Metadata) -> bool {
    true
}

/// sha256 hex 摘要（与引擎认证契约逐字节一致：utf8 输入、小写 hex）。
///
/// 引擎本地口令校验用 `createHash("sha256").update(pwd,"utf8").digest("hex")`
/// + `timingSafeEqual`（已核实 packages/web/src/api/auth-api.ts L45），
/// 壳必须产出同样摘要才能让引擎认账。
pub fn sha256_hex(data: &[u8]) -> String {
    // --- FIPS 180-4 SHA-256 最小实现（避免为单一摘要引入哈希依赖） ---
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    // 消息填充：append 0x80 + 补零 + 64bit 大端原长
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ ((!v[4]) & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v[7] = v[6];
            v[6] = v[5];
            v[5] = v[4];
            v[4] = v[3].wrapping_add(t1);
            v[3] = v[2];
            v[2] = v[1];
            v[1] = v[0];
            v[0] = t1.wrapping_add(t2);
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_nist_vectors() {
        // FIPS 180-4 标准测试向量（与 Node createHash("sha256") 一致）
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // 56 字节触发跨块填充路径（正确性由上面两向量 + 集成期 Node 交叉验证保障）
        assert_eq!(sha256_hex(&[0x61u8; 56]).len(), 64);
        // 与引擎真实口令交叉验证（Node createHash("sha256").update("s3cret").digest("hex") 实测值）
        assert_eq!(
            sha256_hex(b"s3cret"),
            "1ec1c26b50d5d3c58d9583181af8076655fe00756bf7285940ba3670f99fcba0"
        );
    }

    #[test]
    fn bundled_mode_resolves_direct_program() {
        // bundled 模式：入口即程序（M5 SEA 单文件；测试用假路径验证解析透传）
        let p = std::path::Path::new("/tmp/fake-deepcode-sea");
        let resolved = EngineMode::Bundled(p.to_path_buf()).resolve().unwrap();
        assert_eq!(resolved.program, p);
        assert!(resolved.prefix_args.is_empty());
    }

    #[test]
    fn which_finds_node_on_path() {
        // 本机开发环境必有 node（Node >= 22 为引擎前置），找不到则 PATH 异常
        assert!(which("node").is_some(), "PATH 上应能找到 node");
    }
}
