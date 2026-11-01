# DeepCode Desktop 架构设计文档

- 文档编号：DCA-ARCH-DESKTOP-001
- 版本：v1.0（2026-10-29）
- 状态：待评审
- 关联：`DESKTOP-PRD.md`（同目录）
- 调研依据：Trae Remote SSH、VS Code Remote-SSH / vscode-server、Zed remote-development、Cursor 进程故障域拆分、Tauri v2 官方文档（security / shell / distribute）

## 1. 选型结论

### 1.1 壳框架：Tauri v2（主方案）+ Electron（回退红线）

| 维度 | Tauri v2 | Electron |
|------|----------|----------|
| 安装包 | 1–5 MB | 100–300 MB |
| 内存 | 50–100 MB | 200–500 MB |
| 特权模型 | Rust core 全权限 / WebView 零特权 + capabilities 白名单 | nodeIntegration 历史包袱 |
| sidecar 二进制 | 官方 externalBin 机制 | 手动 child_process |
| 更新 | 官方 updater + minisign | electron-updater |

**回退红线（PRD 前置检查）**：DeepCode Web 前端含大量现代 CSS/终端渲染，第一周必须做
WKWebView（macOS）+ WebView2（Windows）双端渲染一致性 POC；不达标即切 Electron，不中途摇摆。

### 1.2 为什么不选"SwiftUI/AppKit 原生壳（build-macos-apps 插件路线）"

macOS 应用开发插件（SwiftUI + WKWebView + Process + Security）技术上完全可行，且能拿到
最地道的 macOS 体验（Liquid Glass、菜单栏、Keychain）。但它只覆盖 macOS 单端，
Windows 端必须另写一套（WinUI/WPF），双端逻辑（SSH、引擎管理、供应商配置）重复实现。
**决策**：一期用 Tauri v2 双端一套；macOS 原生质感通过 Tauri 的 macOS 窗口配置
（titleBarStyle overlay、透明标题栏）逼近系统风格。若后续对 macOS 体验有更高要求，
可二期增加 SwiftUI 原生壳复用同一套 Rust/core 协议（进程拓扑不冲突）。

### 1.3 SSH：spawn 系统 OpenSSH（不自研 SSH 栈）

Trae / VS Code / Zed 三家一致：复用用户 PATH 上的 `ssh`/`scp`，免费继承
`~/.ssh/config`、ProxyJump、ControlMaster、证书、企业 askpass。
`ssh2`(libssh2) 仅用于轻探测任务的备选，不进主链路。

### 1.4 远程模式：VS Code 式"远端 server 自动部署" + Zed 式职责切分

- 远端跑 `deepcode web`（DeepCodeX 引擎自带 headless Web 服务——这是相对其他产品的巨大红利：
  **远端 server 就是 deepcode CLI 本体，零新增服务端代码**）；
- 前端连的永远是 `http://127.0.0.1:<port>`，本地/远程仅 authority 不同，前端零改动；
- AI/LLM 调用留在哪台机器 = server 跑在哪台机器（deepcode 引擎内调 LLM）。
  与 Zed"AI 留本地"不同，这是 deepcode 单进程架构的取舍：换来的是远端零改动 + 引擎
  能力 100% 对齐。API Key 存在使用方桌面 Keychain，经启动隧道时注入远端进程环境（见 §4.4）。

## 2. 总体进程拓扑

```
┌─ DeepCode Desktop（Tauri v2，macOS / Windows）────────────────────┐
│                                                                    │
│  Rust Core（唯一特权层）                                            │
│   ├─ EngineManager   spawn/健康检查/优雅关闭 local deepcode web     │
│   ├─ SshManager      spawn 系统 ssh：探测/部署/隧道/ControlMaster    │
│   ├─ SecretStore     Keychain(macOS) / CredentialManager(Windows)   │
│   ├─ SettingsBridge  读写 ~/.deepcode/settings.json（不含明文密钥）  │
│   ├─ Updater         tauri-plugin-updater（minisign 验签）           │
│   └─ #[tauri::command] IPC 面（capabilities 按 window label 授权）   │
│                                                                    │
│  WebView（零特权，DeepCode Web 前端原样加载）                        │
│   └─ http://127.0.0.1:<enginePort>（本地）                          │
│   └─ http://127.0.0.1:<tunnelPort>（远程，ssh -L 转发）              │
│                                                                    │
│  sidecar（externalBin，随包签名）                                    │
│   └─ deepcode（Node SEA 单文件 / 或要求用户装 Node + npx 模式）      │
└────────────────────────────────────────────────────────────────────┘

远程拓扑：
  本机 ssh -L <localPort>:127.0.0.1:<remotePort> user@host
  远端 ~/.deepcode/server/<version>/deepcode web --host 127.0.0.1 --port <remotePort>
```

### 2.1 故障域划分（借鉴 Cursor）

| 进程 | 崩溃影响 | 恢复策略 |
|------|---------|---------|
| WebView/UI | 窗口白屏 | 壳重载 URL |
| 本地引擎 | 会话中断 | EngineManager 自动重启（≤3 次）后报错 |
| ssh 隧道 | 远程操作失败 | SshManager 指数退避重连，失败降级提示 |
| 远端 server | 同上 | 隧道重连时按需拉起 |

长连接与重 IO（引擎、ssh、索引）全部在 Rust/sidecar 层，WebView 内只有 UI 与 SSE 订阅。

## 3. 模块设计

### 3.1 src-tauri（Rust）

```
desktop/src-tauri/src/
├── main.rs               # 入口：装配插件、注册命令、托盘
├── engine/
│   ├── manager.rs        # EngineManager：spawn/健康检查/重启/优雅关闭
│   ├── port.rs           # 127.0.0.1 动态端口分配（bind :0 探测）
│   └── settings.rs       # ~/.deepcode/settings.json 读写（serde_json）
├── ssh/                  # ✅ 已实现（详见 §3.3）
│   ├── mod.rs            # 模块导出
│   ├── targets.rs        # 目标存储（JSON）+ ~/.ssh/config 解析
│   ├── exec.rs           # ssh 子进程构造（隧道参数顺序 / askpass / 超时执行）
│   ├── probe.rs          # 远端探测（uname / command -v / $HOME）
│   ├── tunnel.rs         # 远端引擎拉起 + -L 转发 + 就绪探测 + 失败诊断
│   └── manager.rs        # 连接生命周期状态机与四阶段编排（含回滚）
├── secrets/
│   └── store.rs          # keychain(macOS) / windows-rs 凭据管理器
├── ipc.rs                # 全部 #[tauri::command]（唯一前端入口）
└── tray.rs / menu.rs     # 托盘与原生菜单
```

#### 关键 IPC 命令面（前端 ↔ 壳）

> **实现状态以代码为准**（2026-11-01 核对）：壳侧 `invoke_handler` 注册 10 个命令，
> 与 `permissions/app-ipc.toml` 的 `commands.allow` 严格相等；下表标 ⛔ 的行
> **尚未实现**，前端已做降级处理。三者一致性由
> `scripts/check-desktop-ipc-contract.mjs`（`npm run check:ipc`）在构建前强制校验——
> 注册命令若漏进 ACL，remote origin 调用会报 `Command xxx not allowed by ACL`。

| 命令 | 说明 | 状态 |
|------|------|------|
| `engine_status` / `engine_restart` | 引擎状态与重启 | ✅ M1 |
| `engine_open_logs` / `engine_log_tail` | 打开日志目录、读取日志尾部 | ✅ M1 |
| `engine_credentials` | 引擎 origin 自动登录凭据（Rust 侧校验来源） | ✅ M1 |
| `config_get` / `config_save` | 桌面配置读写（完整列表覆盖语义） | ✅ M1 |
| `window_drag` / `window_new` | 窗口拖动与新建 | ✅ M1 |
| `boot_diag` | 引导页错误回传壳日志 | ✅ M1 |
| `ssh_list_targets` / `ssh_import_config` / `ssh_remove_target` | 目标管理、~/.ssh/config 导入 | ✅ M2 |
| `ssh_connect` → `{authority, localPort, remoteOs, remoteArch}` | 四阶段：探测 → 拉起远端引擎 → 隧道 → 就绪 | ✅ M2 |
| `ssh_status` | 会话快照 + 连接中阶段进度（前端轮询推进进度条） | ✅ M2 |
| `ssh_disconnect` | 断开：停隧道、停远端引擎、清临时目录 | ✅ M2 |
| `provider_save/test/list/activate` | 供应商插件（Key 进 Keychain，settings 只写引用） | ⛔ 规划中，前端未接线 |
| `recent_workspaces_*` | 最近工作区持久化（壳侧 JSON） | ⛔ 规划中，前端未接线 |

**闭环**：`ssh_connect` 成功 → 壳把主窗口导航到 `http://127.0.0.1:<隧道端口>`（远端
引擎自带 Web UI）→ 注入脚本经 `engine_credentials` 拿隧道凭据自动登录 →
`ssh_disconnect` 断开并把窗口导航回本地引擎。因此前端不代理远端 API，也就不存在
"两套请求路径"的分叉。

降级与诊断仍在：桥不存在（纯浏览器）→ 面板不挂载；壳未注册命令 → 提示能力未就绪；
ACL 未授权 → 告警样式明示配置缺陷（见 `classifySshProbeFailure`）。

前端通过注入的 `window.__DEEPCODE_DESKTOP__` bridge（postMessage 代理）调用；
纯浏览器访问 `deepcode web` 时 bridge 不存在，前端自动隐藏桌面专属 UI（保持 Web 独立可用）。

### 3.2 EngineManager 细节

- 启动命令：`deepcode web --host 127.0.0.1 --port <dynamic>`；
  env 注入 `DEEPCODE_WEB_JWT_SECRET`（壳首次启动随机生成，存应用数据目录 0600 文件——引擎 fail-fast 要求该值必须存在）。
- 健康检查：轮询引擎 HTTP 根/health 直至 200（超时 30s）。
- 关闭：先对子进程组发 SIGTERM（Windows 用 Job Object 保证子进程树回收），3s 超时 SIGKILL。
- sidecar 两种运行模式（设置页可切换）：
  1. **bundled**：externalBin 打包 Node SEA（Single Executable Application）的 deepcode；
  2. **system**：调用用户 PATH 的 `node <path>/cli.js`（开发/内部署模式，规避 SEA+native 依赖打包风险，better-sqlite3/sharp 为可选依赖不构成阻塞）。

### 3.3 SshManager 状态机（实现现状）

```
Idle → Probing → Starting(远端引擎) → Tunneling → Ready
              ↓ 失败                    ↓ 隧道退出
            Failed ←── 回滚：kill 远端进程组 + 删临时目录 + 删 askpass
```

实现位于 `desktop/src-tauri/src/ssh/`：`targets.rs`（存储 + config 解析）、
`exec.rs`（`ssh` 子进程构造）、`probe.rs`（远端探测）、`tunnel.rs`（拉起 + 转发 + 就绪）、
`manager.rs`（状态机与编排）。

- **不链入 ssh2/russh**：统一调用系统 `ssh` 可执行文件。`-L` 转发、`ProxyJump`、
  ssh-agent、证书、known_hosts、系统 `ssh_config` 语义全部由 OpenSSH 自身保证；
  链库会引入 C 依赖与平台编译差异，与 Windows 零依赖打包约束冲突。
- 探测：单次往返取回 `uname -s` / `uname -m` / `command -v deepcode` / `$HOME`。
  远端非 POSIX（Windows OpenSSH 默认 cmd）直接报错，不做半吊子兼容。
- **不自动部署远端**：要求远端已安装 DeepCodeX CLI，缺失时返回带
  `npm install -g @vegamo/deepcode-cli` 的可行动错误。自动下载/上传需要目标架构
  制品与 scp 通道，失败模式难诊断，收益低于复杂度；`install_mode` 字段保留但两条
  路径行为一致（仅记日志）。
- 远端引擎配置隔离：在远端临时目录写**项目级** `.deepcode/settings.json`
  （`enabled: true` + `auth.localUsers` + `allowRoots: ["~"]`），在 `cwd=临时目录`
  启动。配置了 `localUsers` 后 web 侧跳过 bootstrap 随机口令，口令由壳生成并仅留内存，
  因此隧道建立后可自动登录；不触碰用户远端的 `~/.deepcode/settings.json`。
  JWT secret 经 `DEEPCODE_WEB_JWT_SECRET` 注入，不落盘。
- 引擎启动：`nohup setsid deepcode web --host 127.0.0.1 --port <remotePort> > engine.log 2>&1 &`。
  `setsid` 让引擎成为进程组 leader，断开时按进程组回收——只 kill 主 PID 会留下孤儿
  子进程（实测在目标机上残留）。
- 隧道：`ssh -N -L <localPort>:127.0.0.1:<remotePort> <host>`，带
  `ExitOnForwardFailure=yes`。**`-N`/`-L` 必须在 host 之前**：host 之后的参数是远端命令，
  写错会让隧道静默失效（曾真实发生，现有回归用例 `tunnel_args_precede_host`）。
- 就绪探测：一次连接同时判断隧道与引擎（`Probe::{Ok, Connected, Unreachable}`）。
  早期先 TCP 再 HTTP 各建一次连接，会与单线程 accept 的服务端互相抢占。
- 失败诊断：隧道 stderr 落盘，识别 `administratively prohibited`
  → 明确提示目标机 `AllowTcpForwarding no`；并就绪失败时回传远端 `engine.log` 末 40 行。
- 认证：`agent`/`keyfile` 用 `BatchMode=yes`；`password` 经 `SSH_ASKPASS_REQUIRE=force`
  + 临时脚本（脚本不含口令，口令只走子进程环境变量，用完即删）。
  **Windows 不支持密码认证**（OpenSSH for Windows 无 `SSH_ASKPASS_REQUIRE`），显式报错并引导用密钥。

已实现之外的边界：不做断线自动重连、不做 `ControlMaster` 复用、不做远端版本校验与
LLM Key 注入（远端引擎使用自己的配置）。

### 3.4 sshconfig.rs

自研最小解析（约 200 行）：Host 块、HostName/User/Port/IdentityFile/ProxyJump/Include。
理由：只读导入展示 + 连接参数拼装，不需要写回；完整语义执行仍由系统 ssh 完成，
解析歧义不影响连接正确性（连接永远 `ssh <alias>` 由 ssh 自己解释 config）。

### 3.5 供应商插件（DeepSeek）

- 数据模型（壳侧 providers.json，存应用数据目录）：
  `{id, name, base_url, model, api_key_ref, thinking, context_window, active}`
- `provider_save`：Key → SecretStore（service=`com.deepcode.desktop`, account=`<id>`）；文件只写 `api_key_ref`。
- `provider_test`：Rust 侧 reqwest 向 `<base_url>/chat/completions` 发最小请求，返回真实结果。
- `provider_activate`：把激活供应商写入 `~/.deepcode/settings.json` 的 `env`
  （`LLM_BASE_URL` / `LLM_API_KEY`——此文件与 CLI 共享，写 Key 时同步写一份并提示用户该文件为明文；
  桌面"私密模式"开关：开启则 Key 仅经 env 注入子进程，settings.json 不写明文 Key）。
- 预置 DeepSeek：`base_url=https://api.deepseek.com/v1`，模型 `deepseek-chat`/`deepseek-reasoner`；
  自定义 OpenAI 兼容与 Anthropic 同类。

### 3.6 前端（DeepCodeX-cli 仓库内最小改动）

`packages/web/web/src/` 新增桌面 bridge 适配层（不复制前端，直接在原前端加薄层）：
- `desktop-bridge.ts`：检测 `window.__DEEPCODE_DESKTOP__`；
- SSH 连接管理页 + 供应商设置页两个新路由（仅 bridge 存在时注册）；
- 窗口顶部 authority 状态条（本地/远程指示）。
引擎侧（packages/web/src）如需补 `/api/health` 轻量端点则加一个真实探活路由。

## 4. 安全设计

1. capabilities：主窗口只授予 `core:webview` 最小集 + `ipc` 白名单命令；shell 不暴露给前端，
   所有 ssh/spawn 在 Rust 命令内固定参数模板，杜绝命令注入（host 别名经 sshconfig 白名单校验）。
2. 引擎与隧道只绑 127.0.0.1；JWT secret 文件 0600。
3. Keychain/CredentialManager 为 Key 一级存储；任何日志、崩溃上报脱敏 `api_key`。
4. 更新产物 minisign 验签；私钥仅 CI secret。
5. sidecar 与主程序同签名（macOS 公证含 sidecar，否则 Gatekeeper 单拦）。

## 5. 工程结构（新仓库目录，落在 CodereviewAgent 工作区）

```
CodereviewAgent/desktop/            # 壳工程（独立于 backend/frontend）
├── package.json                    # tauri cli
├── src-tauri/                      # Rust 壳（§3.1）
├── src/                            # 壳内少量 UI（连接管理器引导页用 webview 内路由，此处仅静态兜底页）
├── build/                          # sidecar 拉取与打包脚本、签名脚本
└── tests/                          # Rust 单元测试 + 集成脚本（tests/scripts/）
```

前端改动在 DeepCodeX-cli 仓库 `packages/web/web/`（该仓库为自己所有，可直接修改）。

## 6. 分发与 CI 要点

- macOS：Developer ID 签名 → notarytool 公证（app + dmg + sidecar）；
- Windows：Authenticode（NSIS）；
- sidecar：Node SEA 构建产物按 target 三件套（darwin-arm64/x64、win32-x64）随 tag 发布，
  桌面构建时下载校验 sha256 后放入 externalBin；
- updater endpoint JSON + minisign 签名。

## 7. 里程碑

| 里程碑 | 内容 | 完成判据 |
|--------|------|---------|
| M1 壳骨架 | Tauri 工程 + EngineManager + 本机工作区跑通 | TC-DT-01x 通过 |
| M2 SSH 远程 | 探测/部署/隧道/重连 + 前端连接管理页 | TC-DT-02x 通过 |
| M3 供应商插件 | Keychain + DeepSeek 预设 + 连通测试 | TC-DT-03x 通过 |
| M4 系统集成 | 托盘/多窗口/最近/通知 | TC-DT-04x 通过 |
| M5 打包 | 签名/公证/更新通道 | TC-DT-05x 通过 |

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| WKWebView/WebView2 渲染差异 | M1 第一周双端 POC（红线，不过关切 Electron） |
| Node SEA 与 better-sqlite3/sharp 冲突 | 二者是可选依赖；SEA 模式禁用可选功能，保留 system 模式兜底 |
| 远端无 systemd/nohup 环境差异 | 启动用 `setsid nohup` 双保险 + 隧道健康检查兜底判定 |
| 密码认证交互 | 一期仅密钥认证（PRD FR-2.2 密码为会话内输入，若 ssh askpass 不可用则提示改用密钥） |
| settings.json 明文 Key 与"禁止 key 入 git"冲突 | 私密模式默认开：Key 只进 Keychain + 子进程 env；文档明示 |
