# desktop-agent P0 探针 + P1 主干 + 真机 GUI 打通：执行报告

- 分支：`feat/desktop-agent-p0-p1`（基于 `c3ecefd`）
- 日期：2026-11-06
- 方案：[DESKTOP-COMPUTER-USE-PROPOSAL.md](./DESKTOP-COMPUTER-USE-PROPOSAL.md)
- 实现说明：[desktop/desktop-agent/README.md](../../desktop/desktop-agent/README.md)
- 原始数据：[p0-probe.json](../../desktop/desktop-agent/reports/p0-probe.json)、
  [p1-gui-verify.json](../../desktop/desktop-agent/reports/p1-gui-verify.json)

---

## 1. 结论

**判定：`continue`。Windows 真机 GUI 链路已打通，Observe→Act→Verify 闭环在真机 4/4 verified。**

P0 探针（桥关闭）曾判定 `continue-with-adjustment`：能枚举 34 个窗口，但 a11y 树 / 截图 /
输入注入全部不可用，P1 只能由 mock 验证。本轮把 UIA 桥真正跑通后，结论升级：

- 能力矩阵 7 项中 **6 项真机可用**（枚举 / 语义树 / 截图 / 元素 invoke / 坐标输入 / 前台控制），
  仅 `uacAwareness` 仍为 false；
- 窗口枚举从 `tasklist /v` 的 **14.8 s** 降到 UIA `listWindows` 的 **93 ms**，
  缓存命中 0.02 ms、工具调用 0.36 ms；
- `verify:gui` 在受控 WPF 窗口上跑通 **ValuePattern 输入 / InvokePattern 点击 / 坐标点击 /
  快捷键**四条通道，连续 3 次 `gui-unblocked`、4/4 verified，并有状态证据
  （`before → dcx-after`、`idle → applied:dcx-after:2`）；
- 仍保持默认关闭：未开桥或未授权时如实降级，不伪造能力、不静默执行。

关键工程结论：**稳定 ref 要求桥进程长驻**。P1 最初「每次调用新起 `powershell.exe`」的设计
让快照跨进程丢失，`invokeRef` 必然 `STALE_REF`——长驻 stdio 是闭环成立的前提，不是性能优化。

---

## 2. P0 探针实测数据

运行：`DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe`
（`generatedAt=2026-11-06T05:40:47Z`，`platform=win32`，`session=Console`）

### 2.1 平台能力矩阵

| 能力 | 可用 | 依据 |
| --- | --- | --- |
| 应用/窗口枚举 | ✅ | UIA `listWindows`（带 pid/hwnd），失败回落 `tasklist` |
| a11y 语义树 | ✅ | 长驻桥 `snapshot`，真实 `RootElement.FindAll` 自检通过 |
| 截图 | ✅ | 桥内 `CopyFromScreen`，仅内存 base64，不落盘 |
| 元素 invoke | ✅ | InvokePattern / ValuePattern / TogglePattern 依次尝试 |
| 坐标输入 | ✅ | 前台校验通过后 `SetCursorPos + mouse_event` |
| 前台控制 | ✅ | `AttachThreadInput` + `SW_RESTORE` + `BringWindowToTop` + UIA `SetFocus` |
| UAC 感知 | ❌ | Secure Desktop / 完整性级别未实现，一律 `HANDOFF_REQUIRED` |

能力矩阵探测耗时 **1,358 ms**——包含一次真实桥握手与 UIA 自检，不是查表。

### 2.2 真实枚举与耗时

| 指标 | 桥开启 | 桥关闭（基线） |
| --- | --- | --- |
| 可见窗口 | 6 | 34（`tasklist /v` 口径更宽，含无 UIA 名称窗口） |
| 冷枚举 | **92.86 ms** | 14,805.38 ms |
| 缓存命中 | 0.02 ms | 0.01 ms |
| `desktop_list_apps` | 0.36 ms | 0.4 ms |
| 分类分布 | `productivity` 3 / `unknown` 2 / `selfdrawn-likely` 1 | `unknown` 23 / `browser` 7 / `selfdrawn-likely` 3 / `productivity` 1 |
| 通道分布 | `interface-or-gui` 3 / `gui-a11y` 2 / `gui-visual` 1 | `gui-a11y` 23 / `browser` 7 / `gui-visual` 3 / `interface-or-gui` 1 |

隐私：窗口标题**不落盘**，报告只保留 `hasTitle` 与 `titleLength`；截图只写宽高与字节数。

### 2.3 真机只读观察

| 项 | 实测 |
| --- | --- |
| 目标 | `workbuddy`（本机前台应用） |
| 语义树 | 3 节点 / 121.83 ms，角色 `Window` / `Pane`，`truncated:true`（深度预算） |
| 截图 | 2560×1504 / 186.2 ms / 约 810 KB base64，`persisted:false` |

Electron 类应用只暴露 `Window/Pane` 是预期行为（UIA 树残缺），这类应用在通道矩阵里
标注 `selfdrawn-likely`，需要视觉兜底而非硬啃语义树——这正是「树优先、视觉仅兜底」的边界。

---

## 3. 真机 GUI 闭环（P1+）

运行：`DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui`
（`generatedAt=2026-11-06T05:40:43Z`，`verdict=gui-unblocked`）

### 3.1 闭环结果

| 步骤 | 通道 | 耗时 | 结果 |
| --- | --- | --- | --- |
| ValuePattern 输入 | `value-pattern` | 149.83 ms | `verified`，`attempts=1` |
| InvokePattern 点击 | `a11y-invoke` | 143.00 ms | `verified`，`attempts=1` |
| 坐标点击兜底 | `coordinate-input` | 276.47 ms | `verified`，`attempts=1` |
| 快捷键 Alt+F4 | `keyboard` | 288.66 ms | `verified`，`attempts=1` |

状态证据（不是「动作返回 ok」，而是复观察到的界面变化）：

- 输入后 `editValues: ["dcx-after"]`（原 `before`）；
- 两次点击后状态文本 `idle → applied:dcx-after:2`，说明 Invoke 与坐标点击都真实生效；
- 截图 920×440 成功且 `persisted:false`；
- 清理：`bridgeClosed / testWindowProcKilled / tempScriptRemoved` 均为 true。

枚举 7 个窗口 / 108.9 ms；受控窗口语义树 7 节点 / 66.1 ms，角色
`Window / Edit / Button / Text / ScrollBar`。

### 3.2 测试窗体为什么用 WPF

第一版用 WinForms 测试窗体，UIA 树只有 `Window/Pane`：WinForms 控件经 MSAA 桥降级，
拿不到 Value/Invoke 模式。改用 `XamlReader` 动态加载 WPF 窗口后，UIA 提供者是原生的，
TextBox/Button/TextBlock 直接暴露 ValuePattern / InvokePattern，才能覆盖完整动作通道。

### 3.3 定位到的真实阻塞点（不是「沙箱限制」）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 桥脚本解析失败 | PowerShell 5.1 按 GBK 解码无 BOM 的 UTF-8 脚本，中文注释把字符串拆坏 | 脚本写入 UTF-8 BOM；编辑后校验前 3 字节 `EF BB BF` |
| 2 | `invokeRef` 必然 `STALE_REF` | 每次调用新起进程，ref 绑定的 `AutomationElement` 强引用随进程销毁 | 改为**长驻 stdio 桥**：base64 JSON 行协议、id 匹配并发、进程内 `SnapshotStore` |
| 3 | 同 `appId` 多窗口定位到错误窗体 | 只按进程名解析，宿主的控制台窗口抢了先 | 所有带 `appId` 的工具支持 `pid`，`_target` 精确覆盖 |
| 4 | 坐标点击偶发 `ACTION_DENIED` 并连锁 `BUDGET_EXCEEDED` | 后台进程 `SetForegroundWindow` 被前台锁定拒绝；重试耗尽同一任务预算 | 桥侧多重置前（`AttachThreadInput`/`SW_RESTORE`/`BringWindowToTop`/UIA `SetFocus`）+ HWND 复核；验证脚本每步重置预算 |
| 5 | `listWindows` 返回 `ok:true` 但空数组，白等 20 s 无线索 | `Get-TopWindows` 内 `NativeWindowHandle.ToInt64()` 抛异常被 `catch` 吞掉（该属性实为 `Int32`，无此方法） | 改 `[long]` 直接强转；空列表改为回落 `tasklist` 并记录 `enumFallbackReason`，补回归用例 |

第 5 条是典型的「静默降级掩盖故障」：能力自检仍然通过，枚举却全空。修复后同类问题
会留下可观测痕迹，而不是让上层超时。

---

## 4. P1 交付清单

### 4.1 sidecar（`desktop/desktop-agent/`，零新增 npm 依赖）

| 层 | 模块 | 职责 |
| --- | --- | --- |
| L1 协议 | `mcp-server.mjs` | stdio JSON-RPC 2.0；`initialize` / `tools/list` / `tools/call` / `ping`；stdout 仅协议帧 |
| L2 编排 | `agent.mjs` | 11 个工具定义与分发、三级降级通道决策、`pid` 精确目标 |
| L3 护栏 | `policy-guard.mjs` / `policy-load.mjs` / `budget.mjs` / `telemetry.mjs` | 白名单 + 注入扫描 + 一次性确认令牌、外部策略硬化、预算原子预扣熔断、脱敏事件 |
| L3 感知 | `perception.mjs` / `app-registry.mjs` | 稳定 ref / 骨架树 / 下钻、TTL 缓存、通道矩阵 |
| L3 验证 | `verifier.mjs` | Observe→Act→Verify；旧 ref 硬返回 `STALE_REF`；有界重试 |
| L4 后端 | `contract.mjs` / `mock.mjs` / `windows.mjs` / `windows-uia.ps1` | 可插拔契约；mock 故障注入；Windows 长驻桥客户端 + tasklist 回落；UIA 长驻桥（599 行） |

### 4.2 壳侧接线（只加「配置面」，不加执行面）

- `desktop/src-tauri/src/desktop_agent.rs`：策略落盘 `~/.deepcode/desktop-agent.json`；
  `harden()` 复位不可写字段、拒绝 `bypass`、严格校验 appId/scope；含 3 个 Rust 单测。
- `desktop/src-tauri/src/ipc.rs` / `lib.rs`：新增 4 条命令
  `desktop_agent_status` / `desktop_agent_toggle` / `desktop_agent_permissions_get` /
  `desktop_agent_permissions_set`。
- `desktop/src-tauri/permissions/app-ipc.toml`：ACL 同步（22=22）。
- `packages/web/web/src/desktop-bridge.ts`：TypeScript invoke 包装与类型定义。
- `desktop/src-tauri/src/engine/manager.rs`：Unix-only 崩溃重启测试加 `#[cfg(unix)]`，
  使 MinGW GNU 工具链能编译测试目标。

**壳不注册任何窗口枚举 / 截图 / 输入注入命令**，WebView 保持零系统特权；
动作权限由 sidecar 的 PolicyGuard 二次裁决（纵深防御）。

### 4.3 文档

- `DESKTOP-COMPUTER-USE-PROPOSAL.md`（方案，357 行）
- `desktop/desktop-agent/README.md`（运行、桥协议、安全约束、实测数据、限制）
- 本报告

---

## 5. 验证结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Node 单测 | `cd desktop/desktop-agent && npm test` | **54/54 通过**（6 个测试文件，约 13 s） |
| 真机 GUI 闭环 | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui` | **4/4 verified**，`gui-unblocked`；连续 3 次稳定 |
| P0 探针 | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe` | `continue`；6 窗口 / 93 ms，能力 6/7 可用 |
| MCP stdio 冒烟 | `printf … \| node src/index.mjs` | `initialize` 返回 `2025-03-26`；`tools/list` 11 个工具；`desktop_status` 默认 `enabled:false` |
| 外部策略硬化 | 注入含 `bypass` / `allowScreenshot:true` / `maxSteps:9999` 的策略 | 生效值 `manual` / `false` / `false` / `maxSteps=100`；`enabled` 与白名单保留 |
| 全仓类型检查 | `npm run typecheck` | 5 个 workspace 全过，exit 0 |
| IPC 四方契约 | `npm run check:ipc` | 定义 22 = 注册 22 = ACL 22；前端调用点 21（`window_new` 历史未用） |
| Rust 编译 | `cargo check` | exit 0；仅既有 `PASSWORD_ENV` dead_code 警告 |
| Rust 测试编译 | `cargo test --lib --no-run` | exit 0，产物 `deepcode_desktop_lib-*.exe` |

**已知环境限制**：`cargo test --lib` 的**运行**在本机报 `STATUS_ENTRYPOINT_NOT_FOUND`
（MinGW GNU 测试二进制与 WebView2 DLL 加载环境），复制 `WebView2Loader.dll` 亦无效。
这是工具链/DLL 环境问题，不是用例失败；已用 `--no-run` 证明全部 Rust 用例可编译。
CI 若用 MSVC 工具链应能直接跑全量。

---

## 6. 安全 / 稳定性护栏落地对照

| 方案风险 | 本切片对应实现 |
| --- | --- |
| R1 提示注入（界面文本当指令） | 观察结果标记 `untrusted`；`detectInjection` 命中即拦写动作，且不回灌原文 |
| R2 敏感应用 | 5 类敏感分类**先于只读分支**硬拦截；探针不落盘窗口标题；审计脱敏 |
| R3 越权 / 提权 | 双侧 `harden()` 锁定字段、`bypass` 降级、壳 ACL 只含 4 条配置命令 |
| R4 不可逆动作 | 一次性 5 分钟确认令牌（内存态），不受「始终允许」豁免 |
| R8 成本失控 | 步数 / 截图 / token 原子预扣 + 熔断，任务内后续动作全拒 |
| R9/R10 平台能力差异 / 陈旧 ref | 真机自检能力矩阵；长驻桥保证 ref 有效；`STALE_REF` 硬失败而非带旧坐标继续点 |
| 误操作其它窗口 | 键盘/坐标动作前置前台校验（HWND/PID 复核），置前失败即 `ACTION_DENIED` |
| UAC / 验证码 / 锁屏 | 统一 `HANDOFF_REQUIRED`，不做绕过 |

---

## 7. 未解决与边界

1. **目标应用覆盖率不足**：真机闭环在受控 WPF 窗口验证；本机实际应用只做了只读观察。
   Electron / 自绘 / 游戏类 UIA 树残缺（`workbuddy` 仅 3 节点），需逐个实测后才能纳入白名单。
2. **UAC 未感知**：Secure Desktop 与完整性级别检测未实现，遇 UAC 一律交还人工。
3. **分类仍偏粗**：靠进程名/标题启发式，`unknown` 占 2/6；误分会把目标送进错误通道。
4. **策略不热更新**：改开关/授权需重启引擎，UI 已有 `restartHint` 文案。
5. **仅 Windows 真后端**：macOS AX / Linux AT-SPI 未实现，回落 mock。
6. **未接线引擎生命周期**：P1 是「配置即生效」的最小接线；`AgentLifecycle`
   （随壳启停、崩溃重启上限、健康检查）属 P2。
7. **桥对脚本编码敏感**：`windows-uia.ps1` 必须保持 UTF-8 BOM，否则 PowerShell 5.1
   按 GBK 解码会解析失败；已写入 README 与回归用例的约束说明。
8. **交叉工作区提示**：同一工作区里 `desktop/build/*` 的 Windows 分发打包脚本是另一条
   工作流，其「能力排除守卫」明确不打包本切片。若在该分支上打分发包，需用
   `-BaselineRef` 固定到不含本切片的提交，否则默认 `HEAD` 快照会带上 IPC 并触发守卫中止。

---

## 8. P2 准入条件与下一步

**准入（真机闭环已达成，以下为放量前置）：**

1. 扩到 ≥ 10 个真实目标应用（含 Electron、Office、浏览器外壳）测 UIA 覆盖率与单步耗时，
   对树残缺应用明确「视觉兜底 / 拒绝」的判定规则；
2. 补齐故障注入回归：权限拒绝、窗口中途关闭、目标进程退出、`STALE_REF`、桥崩溃重启；
3. 在 MSVC CI 上跑通 `cargo test --lib`，闭环 Rust 用例运行验证；
4. 桥进程纳入生命周期管理：健康检查、崩溃重启上限、退出清理（现为 sidecar 退出时关闭）。

**随后：**

- 接 `AgentLifecycle`（壳管 sidecar 启停 / 崩溃上限 / 策略热更新）；
- 视觉兜底与坐标吸附（P2），默认仍关闭；
- 配置页 UI 落地 4 条 IPC（当前只有 TS 包装，无界面）；
- 按方案 §8 补端到端度量：任务成功率、单步耗时、人工接管率、token/步数成本。

---

## 9. 复现命令

```bash
# 以下命令均以仓库根目录为起点（每行独立执行）
(cd desktop/desktop-agent && npm test)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui)
npm run typecheck && npm run check:ipc

# Rust（需用户级 Rust GNU + MinGW 在 PATH）
(cd desktop/src-tauri && cargo check && cargo test --lib --no-run)

# 登记 sidecar（默认 dry-run，不改文件）
(cd desktop/desktop-agent && npm run register:mcp)
```
