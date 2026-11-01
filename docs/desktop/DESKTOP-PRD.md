# DeepCode Desktop 产品需求文档（PRD）

- 文档编号：DCA-PRD-DESKTOP-001
- 版本：v1.0（2026-10-29）
- 状态：待评审
- 关联文档：`ARCHITECTURE.md`（同目录）

## 1. 背景与定位

DeepCodeX-cli（`/Users/wangwei/Documents/VG/DeepCodeX-cli`）已具备完整的 Web 形态：
`deepcode web` 单进程提供 REST + SSE + 静态前端（默认 `127.0.0.1:3210`），引擎为进程内
SessionManager，认证为 JWT + 可选 LDAP，工作区隔离为 jail/allowRoots。

本产品在其上封装一个 **跨平台桌面客户端（macOS / Windows）**，对标 Trae / Cursor 的桌面体验：

1. 双击即用的桌面应用，无需用户手动起 CLI / 浏览器；
2. 类 Trae 的 **SSH 远程开发**能力：本地 UI + 远端 DeepCode Server；
3. **DeepSeek 等模型供应商的桌面端插件式接入**（GUI 配置、Key 安全存储、快速切换）；
4. 桌面端能力（托盘、多窗口、自动更新、原生通知）不侵入 Web 引擎，CLI 仍是能力真源。

### 非目标（一期明确不做）

- 不做 VS Code 式完整 IDE（编辑器/文件系统/LSP 由 Web 前端现有能力承载，不重写）；
- 不做 JetBrains 式 thin client 远端渲染（Web 前端天然跨平台，远端渲染 UI 是倒退）；
- 一期不做远端 Windows/macOS target（仅 Linux x64/arm64，对齐 VS Code/Trae 约束）;
- 不修改 DeepCodeX-cli 引擎的业务逻辑（仅允许新增 headless/静态目录等壳所需的启动面参数）。

## 2. 用户与场景

| 角色 | 场景 |
|------|------|
| 开发者（个人） | 本机打开 DeepCode，选本地目录开始 AI 编码/评审 |
| 开发者（远程） | 连接公司 Linux 服务器，在远端仓库上做 AI 开发，体验与本地一致 |
| 团队负责人 | 配置 DeepSeek API Key 与默认模型，分发给团队共享配置 |
| 内网用户 | 远端服务器无外网，通过桌面端上传 server 二进制完成远程连接 |

## 3. 功能需求

### FR-1 桌面壳与生命周期

- FR-1.1 应用启动后自动拉起本地 `deepcode web` 引擎（sidecar 或用户已装 Node 两种模式，见架构文档），前端页面在主窗口 WebView 中加载。
- FR-1.2 引擎健康检查（HTTP `/api/health` 或等价端点轮询），启动超时 / 崩溃时给出原生错误对话框并提供"查看日志 / 重启引擎"。
- FR-1.3 引擎端口动态分配（避开占用），端口只监听 `127.0.0.1`。
- FR-1.4 应用退出时优雅关闭引擎子进程（先 SIGTERM，超时 SIGKILL），不留孤儿进程。
- FR-1.5 系统托盘：显示/隐藏主窗口、快速打开最近工作区、退出。
- FR-1.6 引擎日志落盘到应用数据目录，可从 UI 一键打开。

### FR-2 SSH 远程开发（对标 Trae Remote SSH）

- FR-2.1 连接管理界面：列表、新建、编辑、删除 SSH 目标；支持从 `~/.ssh/config` 导入 Host 条目。
- FR-2.2 认证方式：密钥（默认，走系统 ssh/agent）、密码（会话内输入，不持久化）。
- FR-2.3 连接流程（对齐 VS Code/Zed）：
  1. 探测远端（`uname -s/-m`、glibc 版本 ≥ 2.28）；
  2. 检查/安装远端 DeepCode Server（版本与客户端严格一致，缓存于远端 `~/.deepcode/server/`）；
  3. 远端无外网时支持"本地下载 + SSH 上传"模式（Zed `upload_binary_over_ssh` 同款）；
  4. 启动远端 server（仅监听远端 localhost），建立 `ssh -L` 本地随机端口转发；
  5. WebView 切换到 `http://127.0.0.1:<localPort>`，前端零改动。
- FR-2.4 连接状态指示：窗口标题/状态区显示当前 authority（`ssh://user@host:port`），一键断开回本地。
- FR-2.5 端口转发管理：GUI 管理额外的本地转发（默认绑 `127.0.0.1`），复用 SSH ControlMaster。
- FR-2.6 断线自动重连（指数退避，上限 5 次），重连失败回退本地工作区并通知。
- FR-2.7 复用用户本机 OpenSSH 客户端（PATH 上的 `ssh`/`scp`），完整继承 `~/.ssh/config`、ProxyJump、ControlMaster。

### FR-3 模型供应商插件（DeepSeek 优先）

- FR-3.1 供应商设置页：预置 DeepSeek（`https://api.deepseek.com/v1`）、自定义 OpenAI 兼容端点、Anthropic；字段：Base URL / API Key / 模型名 / thinking 开关 / 上下文窗口。
- FR-3.2 API Key 存入系统钥匙串（macOS Keychain / Windows Credential Manager），**不落盘明文、不入 git**；settings.json 中仅写 key 引用名。
- FR-3.3 保存前真实连通性测试（发一次最小 chat completion 请求），失败展示原始错误。
- FR-3.4 当前生效供应商在桌面端 UI 可见；切换后重启引擎会话即生效。
- FR-3.5 供应商配置写入/读取 `~/.deepcode/settings.json` 的 `env` 段（`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`），与 CLI 用户配置完全兼容——桌面端改过的配置 CLI 直接可用，反之亦然。

### FR-4 窗口与系统集成

- FR-4.1 多窗口：支持新开窗口打开不同工作区（本地/远程可混开）。
- FR-4.2 原生菜单（macOS 标准菜单栏）、标准编辑快捷键透传。
- FR-4.3 原生通知：评审完成 / 任务完成时弹系统通知，点击聚焦对应窗口。
- FR-4.4 最近工作区：桌面端维护最近 N 个（本地路径 + remote authority），启动页快捷打开。

### FR-5 分发与更新

- FR-5.1 macOS：DMG 分发，Developer ID 签名 + 公证（含 sidecar 二进制同签）。
- FR-5.2 Windows：NSIS/MSI 安装包，Authenticode 签名。
- FR-5.3 自动更新：桌面壳与应用内引擎版本联动检查（更新检查走 HTTPS endpoint，产物 minisign 验签）。

## 4. 非功能需求

| 编号 | 要求 |
|------|------|
| NFR-1 | 安装包 ≤ 30 MB（不含引擎）；冷启动到可交互 ≤ 3s |
| NFR-2 | 内存驻留（壳 + 引擎）≤ 400 MB |
| NFR-3 | WebView 零特权：文件/进程/网络（除 localhost 引擎）全部经 Rust 层 IPC 白名单 |
| NFR-4 | 引擎仅监听 127.0.0.1；SSH 转发默认绑 127.0.0.1 |
| NFR-5 | 密钥类配置一律系统安全存储，禁止明文配置文件与 git 提交 |
| NFR-6 | 远端 server 版本与客户端不一致时强制先更新再连接 |

## 5. 验收标准（摘要）

1. macOS 双击 DMG 内应用 → 无需终端即完成一次本地工作区 AI 对话；
2. 配置一台 Linux 服务器 → 从连接列表一键进入远程工作区，在远端仓库完成文件读写与命令执行；断网 30s 后恢复可自动重连；
3. 录入 DeepSeek Key → 连通性测试通过 → 切换模型后对话走 DeepSeek（日志可证 provider=openai/deepseek）；Key 在 Keychain 可查到条目、settings.json 无明文；
4. 退出应用后 `ps` 无 deepcode/ssh 转发残留进程；
5. 关闭应用重开，最近工作区与供应商配置完整保留。

## 6. 测试用例编号规划（供测试计划引用）

- TC-DT-01x 壳与生命周期（拉起/健康检查/退出清理/端口分配）
- TC-DT-02x SSH 远程（探测/安装/上传模式/隧道/重连/config 导入）
- TC-DT-03x 供应商插件（保存/测试/切换/Keychain/CLI 兼容）
- TC-DT-04x 窗口与集成（多窗口/托盘/通知/最近）
- TC-DT-05x 构建与签名（bundle 产物、sidecar 嵌入、验签）
