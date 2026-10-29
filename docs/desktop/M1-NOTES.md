# DeepCode Desktop M1 壳骨架 —— 实施记录（M1-NOTES）

- 日期：2026-10-29
- 范围：DESKTOP-ARCH-DESKTOP-001 §7 里程碑 M1（壳骨架）+ §3.6 前端薄层 + 引擎 `/api/health`
- 工程位置：壳 `CodereviewAgent/desktop/`（Tauri v2）；前端薄层 `DeepCodeX-cli/packages/web/web/src/`

## 1. 交付概览

| 模块 | 位置 | 说明 |
|------|------|------|
| EngineManager | `desktop/src-tauri/src/engine/manager.rs` | spawn / 健康检查 / 崩溃自动重启 ≤3 / 优雅关闭 / 崩溃恢复导航 |
| 动态端口 | `desktop/src-tauri/src/engine/port.rs` | 127.0.0.1 bind :0 探测 + 端口/连通性原语 |
| settings 读写 | `desktop/src-tauri/src/engine/settings.rs` | `~/.deepcode/settings.json` 幂等合并（0600），不含明文密钥 |
| 密钥库 | `desktop/src-tauri/src/secrets/store.rs` | keyring crate（macOS Keychain 实测通过；Windows 后端同源码 M5 验证） |
| IPC | `desktop/src-tauri/src/ipc.rs` | `engine_status` / `engine_restart` / `engine_open_logs` / `engine_log_tail` / `engine_credentials` |
| 托盘 | `desktop/src-tauri/src/tray.rs` | 显示/隐藏主窗口、退出=优雅关闭引擎后退出 |
| 信号看门狗 | `desktop/src-tauri/src/lib.rs` | SIGTERM/SIGINT → 优雅关闭引擎后退出（防孤儿，见 §4） |
| 引导页 | `desktop/static/boot.html` | 引擎启动进度 / 错误兜底 / 重启 / 打开日志 |
| 前端桥 | `packages/web/web/src/desktop-bridge.ts` | 检测 `window.__DEEPCODE_DESKTOP__`（壳初始化脚本注入） |
| authority 状态条 | `packages/web/web/src/components/DesktopStatusBar.tsx` | 仅桌面桥存在时渲染；纯浏览器零渲染（零回归） |
| 引擎探活端点 | `packages/web/src/server.ts` | 新增免认证 `GET /api/health → 200 {ok:true}` |

## 2. 已核实的引擎契约（以代码为准）

- 启动入口：`node <DeepCodeX-cli>/packages/cli/dist/cli.js web --host 127.0.0.1 --port <port>`（bin = `./dist/cli.js`）；
- JWT secret 环境变量名：**`DEEPCODE_WEB_JWT_SECRET`**（`packages/web/src/config.ts` L289）——与架构文档一致，无差异；
- 引擎 fail-fast：`web.enabled=false` 时 `deepcode web` 直接退出（`web-command.ts` L41-53），壳在启动前幂等注入 `web.enabled=true`（保留用户其余字段）；
- 引擎处理 SIGTERM 优雅关闭（`web-command.ts` L86-88），与壳的 SIGTERM → 3s → SIGKILL 链路衔接；
- 引擎无运行时用户管理 API、会话仅 HttpOnly Cookie：壳生成 `desktop` 账号（sha256 hex，与 `matchLocalUser` 逐字节一致）写入 `web.auth.localUsers`，引擎页加载后由初始化脚本经 `engine_credentials`（**仅引擎 origin 放行**）同源 fetch 登录。

## 3. 关键技术决策

1. **健康检查探活**：`GET /api/health`（本次新增）为主，旧 dist 无该端点时回退 `GET /api/config` 的 401/2xx 语义；原生 TCP 最小 HTTP 客户端实现，不引入 reqwest 等重依赖。
2. **密钥库选 keyring crate**（而非 security CLI）：跨平台后端由官方维护，避免 CLI 参数拼装歧义与 unsafe FFI；macOS Keychain 回环单测实测通过（`cargo test -- --ignored secrets::`）。
3. **Windows 优雅关闭**：Job Object（KILL_ON_JOB_CLOSE）代码路径已写出（`windows-sys` target 依赖，macOS 侧保证编译），SIGTERM 语义在 Windows 上以 TerminateJobObject 等价实现；运行时验证留待 Windows 机器（M5 打包阶段）。
4. **桌面登录链路**：boot 引导页就绪后 `location.replace` 进引擎 → 初始化脚本在该页调 `engine_credentials`（Rust 侧校验 window.url() 必须以引擎 base_url 开头）→ 同源 POST `/api/auth/login` 换 Cookie。弃用了早期"跨 origin fetch 借 Set-Cookie"方案（CORS 预检会拦截真实请求，不可靠）。
5. **EngineRuntime 全同步实现**：阻塞操作（启动探活/停止）由命令层 `spawn_blocking` 承载；headless 单测可直接驱动真实 node 子进程验证完整生命周期。

## 4. POC 发现并修复的问题

- **SIGTERM 孤儿引擎**：Tauri 默认不安装 SIGTERM 处理器，`kill -TERM` 走默认处置直接终止进程，`RunEvent::Exit` 不会触发，引擎成为孤儿（首轮 POC 实测复现）。
  **修复**：主线程在任何线程创建前 `pthread_sigmask` 屏蔽 SIGTERM/SIGINT，专用线程 `sigwait` 收取后执行 `cleanup_blocking`（SIGTERM → 3s → SIGKILL）再退出。修复后 POC 实测：壳收到信号 15 → 引擎端口关闭 → 无残留。

## 5. WKWebView 渲染 POC 结论（红线项）

- `cargo build`（debug）产物 `target/debug/deepcode-desktop` 三轮实测（见 §6）：
  窗口正常创建，WKWebView 渲染本地引导页（boot.html，含暗色模式与动画）；
  引擎就绪后跳转 `http://127.0.0.1:<port>` 加载 Web 前端。
- **观察**：本机 WKWebView 加载 web 前端正常——引擎返回的静态页（bundle.js/bundle.css）渲染无异常，`GET /` 与 `/api/health` 均 200。深色模式（prefers-color-scheme）在 boot 页已验证；web 前端完整交互（对话/文件抽屉/终端渲染）的长时间人工验证建议在真机 GUI 会话中进行，本环境仅能做无头级验证。
- **红线结论**：现有证据支持继续 Tauri v2 路线，无需触发切换 Electron。遗留验证点见 §7。

## 6. 验证结果汇总

| 验证项 | 命令 | 结果 |
|--------|------|------|
| Rust 编译 | `cargo check --lib --bins` | ✅ 0 error 0 warning |
| Rust 格式 | `cargo fmt --check` | ✅ |
| Rust 单测 | `cargo test --lib` | ✅ 18 passed / 0 failed（1 ignored=真实钥匙串用例） |
| 钥匙串实测 | `cargo test --lib -- --ignored secrets::` | ✅ Keychain 写/读/覆盖/删除回环 |
| 冒烟脚本 | `bash tests/scripts/smoke-engine.sh` | ✅ 生命周期 + 端口/settings/配置单测全绿；ps 残留检查在本沙箱环境被 OS 拒绝（见 §7），进程清理由单测断言（停止后端口不可达）+ POC 端口探测兜底验证 |
| POC | debug 二进制三轮实跑 | ✅ 引擎拉起 → `/api/health` 200 `{ok:true}` → SIGTERM 优雅清理无孤儿 |
| TS typecheck | `npm run typecheck`（全 workspace） | ✅ |
| 前端构建 | `node packages/web/web/build.mjs` | ✅ bundle.js/bundle.css/index.html 产出 |
| web 既有测试 | `npm test`（packages/web，270 例） | 269 pass / 1 fail——`SD-03`（EAG 沉淀落盘）为**既有偶发失败**：stash 本改动后全量跑同样失败，单文件隔离运行则稳定通过（含本改动），与 M1 改动无关（并行全量下的 SIGTERM 落盘时序 flake） |

## 7. 遗留问题与 M2 建议

1. **ps 残留检查**：当前执行环境沙箱禁止进程枚举（`/bin/ps` Operation not permitted）。smoke-engine.sh 的检查在普通终端可用；建议 CI（普通 runner）补跑一次完整冒烟。
2. **引擎 origin 的 IPC ACL 实测**：capabilities 已对 `http://127.0.0.1:*` 开放 remote 授权（`core:default` + `core:webview:default`）；应用自定义命令（engine_status 等）的跨 origin 可达性需在真机 GUI 会话确认（无头环境无法点击验证）。若不通，回退方案：状态条数据改经 `engine-status` 事件（Rust 推送）或 boot 引导页中转。
3. **GUI 人工验收**：托盘菜单、titleBarStyle Overlay 视觉、登录自动跳转、`cargo tauri build` 产出 .app（bundle 配置已就绪、icons 已生成）需真人双击验证——建议纳入 TC-DT-04x。
4. **M2 建议**：a) SshManager 落位 `engine/remote.rs`（复用 port/settings 基础设施）；b) 状态条扩展 SSH authority 显示与连接管理页路由；c) 引擎页断线（引擎崩溃时 WebView 停在失效页）的自动重载 UX；d) 登出后再登录的口令获取 UX（当前桌面账号口令仅壳持有）。
5. **版本**：DeepCodeX-cli 各 package.json version 保持 0.4.5 未动；desktop 工程独立版本 0.1.0。
