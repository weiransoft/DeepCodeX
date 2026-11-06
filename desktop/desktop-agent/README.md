# desktop-agent（P0 探针 + P1 主干切片）

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

> 当前状态：**实验性、默认关闭**。P1 只实现 Windows 的窗口枚举为真实能力，
> a11y 树 / 截图 / 输入注入由 mock 后端跑通逻辑链路，真机 UIA 桥尚未启用。

## 目录

```
desktop-agent/
├── src/index.mjs                  进程入口（策略加载 → 后端选择 → MCP stdio）
├── src/mcp-server.mjs             零依赖 JSON-RPC 2.0 server
├── src/agent.mjs                  11 个工具定义 + 分发 + 通道决策
├── src/errors.mjs                 结构化错误码（STALE_REF / ACTION_DENIED / …）
├── src/backends/contract.mjs      后端接口契约与启动期校验
│             mock.mjs             内存后端（单测 + 逻辑基线）
│             windows.mjs          Windows 真后端（tasklist /v + 可选 UIA 桥）
│             windows-uia.ps1      UIA 桥（产品代码，需交互式桌面会话，当前沙箱不可运行）
├── src/modules/policy-guard.mjs   执行前硬校验（白名单 / 注入扫描 / 确认令牌）
│             policy-load.mjs      外部策略加载 + 锁定字段二次硬化
│             perception.mjs       稳定 ref / 骨架树 / 下钻 / 视觉兜底
│             verifier.mjs         Observe→Act→Verify + STALE_REF + 重试
│             app-registry.mjs     应用注册表 / TTL 缓存 / 通道矩阵
│             budget.mjs           步数·截图·token 原子预扣与熔断
│             telemetry.mjs        脱敏事件流
├── config/policy.default.json     默认策略（enabled=false）
├── scripts/probe.mjs              P0 探针
├── scripts/register-mcp.mjs       MCP 登记（dry-run / 写入 / 移除）
├── reports/p0-probe.json          P0 实测数据（窗口标题不落盘）
└── tests/*.test.mjs               node:test，零依赖
```

零新增 npm 依赖（Node ≥ 22，ESM）：sidecar 需要随桌面端分发，避免版本漂移与供应链面。

## 快速开始

```bash
cd desktop/desktop-agent

npm test                 # 44 个单测（含 MCP 协议、策略、预算、验证、登记脚本）
npm run probe            # P0 探针，输出 reports/p0-probe.json

# 直接以 stdio 启动（默认 mock 之外的自动选择：win32 → windows，其余 → mock）
DEEPCODE_AGENT_BACKEND=mock node src/index.mjs
```

MCP 握手可用管道冒烟（stdout 只出现协议帧，日志走 stderr）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/index.mjs
```

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

错误码统一为结构化 `code`：`STALE_REF`（旧快照 ref 硬失败）、`APP_NOT_ALLOWED`、
`CONFIRMATION_REQUIRED`（一次性令牌）、`UNTRUSTED_INPUT_BLOCKED`、`BUDGET_EXCEEDED`、
`CAPABILITY_UNAVAILABLE`、`HANDOFF_REQUIRED` 等，见 `src/errors.mjs`。

## 安全基线

- 默认 `enabled=false`；未显式开启时 PolicyGuard 拒绝一切观察与动作。
- 敏感分类（金融 / 加密 / 医疗 / 政务）**先于只读分支**硬拦截，无自动放行。
- 界面文本做提示注入特征扫描，命中即拦截写动作，且不把原文回灌给模型。
- 不可逆动作（提交 / 发送 / 删除 / 支付…）强制逐次确认，令牌一次性、5 分钟过期、只在内存。
- 审计事件脱敏；探针只记录窗口标题的「是否存在 / 长度」，不落盘标题内容。
- 壳侧 4 条 IPC 只有状态、开关、授权读写，**没有任何窗口内容 / 截图 / 输入注入能力**；
  ACL 由 `permissions/app-ipc.toml` 同步，`npm run check:ipc` 做四方契约校验。

## 已知限制（P1 边界）

1. **真机 a11y / 截图 / 输入注入未通**：`windows-uia.ps1` 需要交互式桌面会话 +
   `DEEPCODE_AGENT_UIA_BRIDGE=1`；当前沙箱不满足，能力矩阵全部为 `supported:false`。
   全链路只由 mock 后端验证，P2 前不得宣称「可操作真实 GUI」。
2. `tasklist /v` 冷枚举实测约 **14.8s**；已加 TTL 缓存（命中 0.01ms），
   但 `refresh:true` 仍会触发一次全量枚举，P2 需换成增量 / UIA 事件订阅。
3. 验证码、UAC 安全桌面、锁屏一律 `HANDOFF_REQUIRED`，不做绕过。
4. 仅 Windows 有真实后端，macOS/Linux 回落 mock；`foregroundControl` 未实现。
5. 策略不热更新；壳侧 `platformPermissions.checkableByShell=false`，只给引导文案，不检测系统授权。
6. 与分发包的关系：`desktop/build/pack.ps1` 的「能力排除守卫」明确不打包本目录与
   `desktop_agent_*` IPC。**若在本功能分支上构建分发包**，需把 `-BaselineRef` 固定到
   不含本切片的提交（如 `main` / `c3ecefd`），否则默认 `HEAD` 的干净基线快照会带上
   这些 IPC 并触发源码守卫中止。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DEEPCODE_AGENT_BACKEND` | `auto` | `mock` / `windows` / `auto`（win32→windows） |
| `DEEPCODE_AGENT_POLICY` | 壳策略 → 仓库默认 | 显式指定策略 JSON |
| `DEEPCODE_AGENT_UIA_BRIDGE` | 未设置 | `1` 时启用 Windows UIA 桥 |
