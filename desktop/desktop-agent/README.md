# desktop-agent（P0 探针 + P1 主干 + 真机 GUI 打通）

独立 **Node sidecar**：把「桌面应用感知 / 界面操作 / 结果验证」以 MCP stdio 工具的形式提供给引擎编排层。
设计依据见 [`docs/desktop/DESKTOP-COMPUTER-USE-PROPOSAL.md`](../../docs/desktop/DESKTOP-COMPUTER-USE-PROPOSAL.md)，
实测结论与交付清单见 [`docs/desktop/DESKTOP-AGENT-P0-P1-REPORT.md`](../../docs/desktop/DESKTOP-AGENT-P0-P1-REPORT.md)。

## 三条原则

| 原则 | 落点 |
| --- | --- |
| 编排在引擎 | sidecar 不做任务规划，只暴露 11 个结构化工具语义；Plan / 模型决策仍在 core |
| 执行在 sidecar | 窗口枚举、a11y 树、截图、输入注入都在独立进程，WebView 零系统特权 |
| 授权在壳 | 开关与按应用授权由 Rust 壳落盘 `~/.deepcode/desktop-agent.json`，sidecar 启动时读取并二次硬化 |

降级链：**接口/连接器 → 浏览器 DOM/CDP → 桌面 GUI**。`desktop_list_apps` 直接给出建议通道，
浏览器类应用返回 `browser`、生产力类返回 `interface-or-gui`，避免把 GUI 当默认路径。
树优先、视觉仅兜底；观察结果一律标记 `untrusted`。

> 当前状态：**实验性、默认关闭**，但 Windows 真机 GUI 链路已打通（需显式开启 UIA 桥）。
> 能力矩阵 7 项中 6 项实测 `supported:true`，`verify:gui` 的 Observe→Act→Verify 闭环 4/4 verified。
> 未开启桥时自动降级为纯 Win32 窗口枚举，GUI 动作返回 `CAPABILITY_UNAVAILABLE`，不会伪造能力。

## 目录

```
desktop-agent/
├── src/index.mjs                  进程入口（策略加载 → 后端选择 → MCP stdio → 退出时关桥）
├── src/mcp-server.mjs             零依赖 JSON-RPC 2.0 server
├── src/agent.mjs                  11 个工具定义 + 分发 + 通道决策 + pid 精确定位
├── src/errors.mjs                 结构化错误码（STALE_REF / ACTION_DENIED / …）
├── src/backends/contract.mjs      后端接口契约与启动期校验
│             mock.mjs             内存后端（单测 + 逻辑基线）
│             windows.mjs          Windows 真后端（长驻桥客户端 + tasklist 回落）
│             windows-uia.ps1      UIA 长驻 stdio 桥（UTF-8 BOM，PowerShell 5.1）
├── src/modules/policy-guard.mjs   执行前硬校验（白名单 / 注入扫描 / 确认令牌）
│             policy-load.mjs      外部策略加载 + 锁定字段二次硬化
│             perception.mjs       稳定 ref / 骨架树 / 下钻 / 视觉兜底
│             verifier.mjs         Observe→Act→Verify + STALE_REF + 有界重试
│             app-registry.mjs     应用注册表 / TTL 缓存 / 通道矩阵
│             budget.mjs           步数·截图·token 原子预扣与熔断
│             telemetry.mjs        脱敏事件流
├── config/policy.default.json     默认策略（enabled=false）
├── scripts/probe.mjs              P0 探针（能力矩阵 / 枚举 / 真机只读观察）
│           verify-gui.mjs         真机 GUI 闭环验证（受控 WPF 测试窗口）
│           register-mcp.mjs       MCP 登记（dry-run / 写入 / 移除）
├── reports/p0-probe.json          P0 实测数据（窗口标题不落盘）
│           p1-gui-verify.json     真机闭环实测数据
└── tests/*.test.mjs               node:test，零依赖（54 个用例）
```

零新增 npm 依赖（Node ≥ 22，ESM）：sidecar 需要随桌面端分发，避免版本漂移与供应链面。

## 快速开始

```bash
cd desktop/desktop-agent

npm test                           # 54 个单测（协议 / 策略 / 预算 / 验证 / 桥 / 登记脚本）
npm run probe                      # P0 探针（未开桥：仅 Win32 枚举）
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe          # 真机全能力探针

# 真机 GUI 闭环：会短暂弹出 DCX-GUI-TEST-* 测试窗口，结束自动关闭
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui

# 直接以 stdio 启动（自动选择：win32 → windows，其余 → mock）
DEEPCODE_AGENT_BACKEND=mock node src/index.mjs
```

`verify:gui` 只在受控测试窗口内操作，不触碰用户窗口、不写用户文件、不保存任何 GUI 内容；
非 Windows 或未开启桥时输出 `skipped` 并以退出码 0 结束（CI 友好）。

MCP 握手可用管道冒烟（stdout 只出现协议帧，日志走 stderr）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/index.mjs
```

## Windows 真机 GUI 通道

### 为什么必须是「长驻桥」

`snapshot` 返回的稳定 ref 绑定的是 UIA `AutomationElement` **强引用**，保存在桥进程内的
`SnapshotStore`。若每次调用都新起 `powershell.exe`，`invokeRef` 必然找不到 ref（表现为
`STALE_REF`）——长驻是闭环成立的前提，不是性能优化。

协议：Node 侧 `spawn` 一个 `powershell.exe -STA` 长驻进程，双方以 **base64 编码的 JSON 行**
在 stdio 上通信，请求带自增 `id`、响应按 `id` 匹配，支持并发不串包；握手 `ready` 后
`capabilities` 会真的调用 `AutomationElement.RootElement.FindAll` 自检，失败即如实降级。
进程退出 / `backend.close()` 会清理 pending 并结束子进程，不遗留 `powershell.exe`。

> `windows-uia.ps1` **必须带 UTF-8 BOM**：Windows PowerShell 5.1 按 GBK 解码无 BOM 的 UTF-8
> 脚本，中文注释会把字符串拆坏导致解析失败。编辑该文件后请确认前 3 字节为 `EF BB BF`。

### 安全约束

- 键盘 / 坐标动作在桥侧校验**前台窗口属于目标进程**（`AttachThreadInput` + `SW_RESTORE` +
  `BringWindowToTop` + UIA `SetFocus` 多重置前，按 HWND/PID 复核），避免把输入打到用户
  正在使用的其它窗口；无法置前即返回 `ACTION_DENIED`。
- 元素 `invoke` / `ValuePattern` 优先，不抢焦点；坐标点击仅作兜底且默认关闭。
- 所有带 `appId` 的工具都支持 `pid`，用于同进程多窗口时精确定位目标窗体。
- 截图只回传内存 base64，不落盘；探针只记录宽高与字节数，不采集窗口标题与画面内容。
- `listWindows` 返回「ok 但空数组」不视为「桌面无窗口」，而是回落 `tasklist` 并记录原因。

### 实测数据（`reports/*.json`）

| 项 | 实测 |
| --- | --- |
| 能力矩阵 | 6/7 `supported:true`；`uacAwareness` 仍为 false（遇 UAC 一律 `HANDOFF_REQUIRED`） |
| 窗口枚举 | UIA `listWindows` 冷枚举约 **93 ms**（原 `tasklist /v` 约 14.8 s），缓存命中 0.02 ms，工具调用 0.36 ms |
| 语义树 | 受控 WPF 窗口 7 节点 / 78 ms，角色 Window / Edit / Button / Text / ScrollBar |
| 闭环 | ValuePattern 输入 176 ms、InvokePattern 点击 203 ms、坐标点击 331 ms、Alt+F4 325 ms，均 `verified`、`attempts=1` |
| 状态证据 | 输入框 `before → dcx-after`；状态文本 `idle → applied:dcx-after:2`（两次真实点击生效） |
| 截图 | 920×440 窗口截图成功，仅内存，`persisted:false` |
| 稳定性 | `verify:gui` 连续 3 次 `gui-unblocked`、4/4 verified |

闭环脚本用 WPF（`XamlReader` 动态加载）而非 WinForms 测试窗体：WinForms 控件经 MSAA 桥
会降级为 Pane，拿不到 Value/Invoke 模式；WPF 的 UIA 提供者是原生的。

### 登记到桌面端（开发联调）

引擎与配置页对 `mcpServers` 的形态不同，脚本同时维护两份并保持幂等：

| 文件 | 形态 | 消费方 |
| --- | --- | --- |
| `~/.deepcode/settings.json` | `Record<name, {command,args,env}>` | McpManager，引擎启动时读取 |
| `~/.deepcode/desktop.json` | `[{id,name,command,args,env,enabled}]` | 配置页，保存时全量回写 |

```bash
npm run register:mcp                      # 默认 dry-run，只预览
npm run register:mcp -- --write           # 写入（原文件备份为 *.bak）
npm run register:mcp -- --remove --write  # 撤销
npm run register:mcp -- --home <dir>      # 隔离家目录，供测试
```

只写 `settings.json` 会在用户下次从配置页保存时被 UI 全量覆盖而丢失；
只写 `desktop.json` 则要等下次保存才生效，所以两侧同写。
登记后 **需重启引擎**，`desktop_agent_status` 的 `sidecarRegistered` 才会变为 true。

### 策略契约（壳 ↔ sidecar）

```
WebView ── desktop_agent_toggle / permissions_set ──> Rust 壳
                                                      │ harden()（不可写字段复位）
                                                      ▼
                                    ~/.deepcode/desktop-agent.json
                                                      │ 启动时读取
                                                      ▼
                       sidecar loadPolicy() ── 二次硬化 ──> PolicyGuard
```

- 优先级：`DEEPCODE_AGENT_POLICY`（显式指定） > 壳落盘策略 > 仓库内 `config/policy.default.json`。
- 策略文件解析失败 → **回落到「默认关闭」**，不抛错、不带病启动。
- 两侧共同锁定的字段：`deniedCategories`、`allowScreenshot`、`allowCoordinateInput`、
  `preferBrowserChannel`、预算上限；`bypass` 一律降级为 `manual`。
- 策略在进程启动时读取一次，修改后返回 `restartHint`；热更新属 P2。
- 诊断动作（`status` / `list_apps` / `events`）在关闭状态下也可查，否则用户无法诊断「为什么不能用」。

## 工具清单

| 工具 | 类别 | 说明 |
| --- | --- | --- |
| `desktop_status` | 诊断 | 版本、后端、策略、预算、能力矩阵 |
| `desktop_list_apps` | 只读 | 可见窗口枚举 + 分类 + 建议通道（默认 TTL 缓存） |
| `desktop_snapshot` | 只读 | a11y 语义骨架树 + 稳定 ref |
| `desktop_drill_down` | 只读 | 按 `rootRef` 下钻子树，省 token |
| `desktop_screenshot` | 只读 | 视觉兜底，默认关闭、不落盘 |
| `desktop_click_ref` | 写 | 按 ref 执行元素 invoke，走 Observe→Act→Verify |
| `desktop_click_xy` | 写 | 坐标点击兜底，默认关闭，先吸附最近 a11y 节点 |
| `desktop_type` | 写 | 输入文本（优先 ValuePattern） |
| `desktop_key` | 写 | 快捷键 |
| `desktop_wait_for` | 只读 | 有界等待（最长 10s） |
| `desktop_events` | 诊断 | 脱敏结构化事件流 |

所有带 `appId` 的工具都可额外传 `pid` 精确定位窗口。错误码统一为结构化 `code`：
`STALE_REF`（旧快照 ref 硬失败）、`APP_NOT_ALLOWED`、`CONFIRMATION_REQUIRED`（一次性令牌）、
`UNTRUSTED_INPUT_BLOCKED`、`BUDGET_EXCEEDED`、`CAPABILITY_UNAVAILABLE`、`HANDOFF_REQUIRED`
等，见 `src/errors.mjs`。

> 连续动作必须每步重新 `desktop_snapshot`：Verifier 成功后会复观察并换掉当前快照，
> 复用旧 `snapshotId` / ref 会得到 `STALE_REF`。这是刻意的安全契约，不是缺陷。

## 安全基线

- 默认 `enabled=false`；未显式开启时 PolicyGuard 拒绝一切观察与动作。
- 敏感分类（金融 / 加密 / 医疗 / 政务）**先于只读分支**硬拦截，无自动放行。
- 界面文本做提示注入特征扫描，命中即拦截写动作，且不把原文回灌给模型。
- 不可逆动作（提交 / 发送 / 删除 / 支付…）强制逐次确认，令牌一次性、5 分钟过期、只在内存。
- 审计事件脱敏；探针只记录窗口标题的「是否存在 / 长度」，不落盘标题内容。
- 壳侧 4 条 IPC 只有状态、开关、授权读写，**没有任何窗口内容 / 截图 / 输入注入能力**；
  ACL 由 `permissions/app-ipc.toml` 同步，`npm run check:ipc` 做四方契约校验。

## 已知限制

1. **UAC / 验证码 / 锁屏**：`uacAwareness=false`，Secure Desktop 与完整性级别未检测，一律 `HANDOFF_REQUIRED`，不做绕过。
2. **覆盖率待扩大**：真机闭环在受控 WPF 测试窗口与本机 6–8 个窗口上验证；Electron / 自绘 / 游戏类应用的 UIA 树可能残缺，需逐个实测后才可纳入白名单。
3. **仅 Windows 有真实后端**：macOS AX / Linux AT-SPI 未实现，回落 mock。
4. **策略不热更新**：改开关 / 授权需重启引擎；壳侧 `platformPermissions.checkableByShell=false`，只给引导文案，不检测系统授权。
5. **未接线引擎生命周期**：P1 是「配置即生效」的最小接线；`AgentLifecycle`（随壳启停、崩溃重启上限、健康检查）属 P2。
6. **真机动作依赖交互式桌面会话**：服务 / 无桌面会话下 UIA 自检会失败并如实降级；`DEEPCODE_AGENT_UIA_BRIDGE=1` 必须显式开启。
7. 与分发包的关系：`desktop/build/pack.ps1` 的「能力排除守卫」明确不打包本目录与
   `desktop_agent_*` IPC。**若在本功能分支上构建分发包**，需把 `-BaselineRef` 固定到
   不含本切片的提交（如 `main` / `c3ecefd`），否则默认 `HEAD` 的干净基线快照会带上
   这些 IPC 并触发源码守卫中止。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DEEPCODE_AGENT_BACKEND` | `auto` | `mock` / `windows` / `auto`（win32→windows） |
| `DEEPCODE_AGENT_POLICY` | 壳策略 → 仓库默认 | 显式指定策略 JSON |
| `DEEPCODE_AGENT_UIA_BRIDGE` | 未设置 | `1` 时启用 Windows UIA 长驻桥（真机 GUI 全能力） |
