# desktop-agent P0 探针 + P1 主干 + 真机 GUI 打通：执行报告

- 分支：`feat/desktop-agent-p0-p1`（基于 `c3ecefd`）
- 日期：2026-11-06
- 方案：[DESKTOP-COMPUTER-USE-PROPOSAL.md](./DESKTOP-COMPUTER-USE-PROPOSAL.md)
- 实现说明：[desktop/desktop-agent/README.md](../../desktop/desktop-agent/README.md)
- 原始数据：[p0-probe.json](../../desktop/desktop-agent/reports/p0-probe.json)、
  [p1-gui-verify.json](../../desktop/desktop-agent/reports/p1-gui-verify.json)、
  [p2-coverage.json](../../desktop/desktop-agent/reports/p2-coverage.json)、
  [p2-real-app.json](../../desktop/desktop-agent/reports/p2-real-app.json)

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
- 真实应用覆盖率采样跑通：**5/5 真实窗口树可用**、均值 106 ms；并由此暴露并修掉
  「同进程多窗口按 pid 命错窗口」缺陷（新增 `hwnd` 端到端定位）；
- **真实应用写入闭环跑通**：在自建临时文件的记事本上完成「ValuePattern 写入 → Ctrl+S →
  读盘校验」，3/3 步骤通过，磁盘内容确含写入文本且基线保留；
- **通道判定改为实测驱动**：新增 `tree-quality`，观察后用真实树判定
  `good / sparse / deferred / empty`，修正「按进程名猜 Electron」的误分类
  （实测 5 个真实窗口中只有 1 个真能按名字定位）；
- **故障注入回归补齐**：窗口中途关闭、进程崩溃、桥崩溃重连、`STALE_REF`、预算熔断
  全部锁定错误码与可恢复性，共 131 个单测通过；
- **覆盖率达标（13 个真实应用）**：主动拉起 16 个目标应用、13 个采到树，其中 8 家可按
  名字操作、4 家只能视觉兜底、1 家（Edge）必须走 DOM/CDP，3 家因环境/权限未拉起且如实标注；
  同时把「完整度」判据做对（`snapshot.truncated` 恒真导致无法区分「没看全」与「树就这么小」）；
- **真实应用写入矩阵四家全绿**：记事本 / Word / Excel / 资源管理器均以**读盘或文件系统**
  为成功证据（首轮通过、无重试），浏览器外壳按策略拒绝 GUI；过程中修掉 12 条真机判据
  （含「中文按钮从未被点中」的 `\b` 正则 bug、老式对话框按钮是 `Pane`、Excel 落点选到公式栏）；
- **桥生命周期可管**：`ping` 探活 4 ms、崩溃后指数退避自愈、120 s 内崩 3 次即停止
  自动重启（`bridge-crash-loop`，零新增 spawn）、`shutdown` 208 ms 优雅退出；
- **视觉兜底的执行侧闭环**：坐标帧换算（图像像素 → 屏幕坐标）与越界拒绝在计算器上真机验证
  （点「七」→ 显示 7、点「八」→ 78）；64×64 灰度签名补上「树不变时怎么验」，任务管理器实测
  `treeChanged:false` + `pixelChanged:true`（§3.11）；
- **图能进模型了**：MCP 结果改为「text 元数据 + image 内容块」，core 侧提取后拼成 image_url
  follow-up 消息；真机帧解出 PNG 且 IHDR 宽高与工具回传一致（666×1078，53 356 B），
  `image-content-verified`（§3.12）；
- **视觉通道改成「限时 + 按应用」的授权，而不是布尔开关**：一次性令牌（5 min、用一次即废）
  → 授权（只能选已有 read 权限的应用、1 min–24 h、坐标点击单独勾选）→ 两侧读盘时按同一套
  规则重新派生（过期即自动收回，改文件放宽不了），每次授权/撤销写审计 JSONL；真机 6/6
  （`vision-gate-verified`：无授权/过期/越权应用/无坐标授权一律拒，授权后真截图 666×1078
  过大到模型，§3.13）；
- **Rust 用例运行闭环**：`cargo test --lib` 在 MSVC CI 与本机 GNU 上均
  **74 passed / 0 failed**；同时纠正了「MinGW 环境问题」的误判——真因是测试二进制缺
  Windows 应用清单、ComCtl32 停在 v5，已在 `build.rs` 修掉（§5.1）；
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
| 6 | 同进程多窗口观察/操作到错窗口 | 桥只按 `pid` 解析，而 `explorer` 的桌面窗口与文件夹窗口共用同一 PID，`Resolve-Window` 稳定返回第一个 | 工具链全面支持 `hwnd`：`_target` 先按 hwnd 匹配、桥侧 `Resolve-Window` 优先 HWND、`snapshot` 回传 hwnd；补契约与链路测试 |

第 5 条是典型的「静默降级掩盖故障」：能力自检仍然通过，枚举却全空。修复后同类问题
会留下可观测痕迹，而不是让上层超时。第 6 条由覆盖率采样暴露：修复前两个 `explorer`
窗口采到的是同一棵树（都是 46 节点），修复后分别是 46 与 3 节点。

### 3.4 真实应用覆盖率（P2 准入第 1 项）

运行：`DEEPCODE_AGENT_UIA_BRIDGE=1 npm run coverage`（只读，不执行动作、不落盘标题与截图）

| 应用 | 分类通道 | 骨架/完整节点 | 可操作 | 有名字可操作 | 实测判定 | 判定后通道 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| explorer（文件夹） | interface-or-gui | 46 / 133 | 39 | **90** | good | gui-a11y | 247.85 ms |
| gameviewer（自绘） | gui-visual | 29 / 42 | 28 | **0** | sparse | gui-visual | 74.76 ms |
| taskmgr | gui-a11y | 16 / 16 | 11 | **0** | sparse | gui-visual | 33.64 ms |
| workbuddy（Electron） | gui-a11y | 3 / 3 | 1 | **0** | sparse | gui-visual | 148.56 ms |
| explorer（桌面窗口） | interface-or-gui | 3 / 3 | 3 | **0** | sparse | gui-visual | 23.87 ms |

汇总：**5/5 快照成功且树可用**，骨架 97 节点 / 完整树 197 节点，均值 **105.74 ms**、
最大 247.85 ms，无失败。

结论：真实桌面应用的语义树可用性不是瓶颈，**瓶颈是「有名字的可操作节点」**。
5 个窗口里只有 1 个（文件夹窗口）有充足的可指认目标；`gameviewer` 28 个可操作节点
全部无名字、`workbuddy` 整棵树只有 3 个节点——这类界面无法靠「按名字找目标」完成操作，
要么走视觉兜底，要么明确拒绝。这条数据直接支撑了方案里「树优先、视觉仅兜底 + 通道矩阵」
的设计，而不是靠推断。

### 3.5 真实应用写入闭环（P2 准入第 1 项，写入侧）

运行：`DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:real-app`

受控 WPF 窗口只能证明「通道能用」，真实应用才证明「改动真能落到文件」。脚本在临时目录
创建 `dcx-e2e-*.txt`，用记事本打开，写入 → `Ctrl+S` → **读磁盘校验**，最后关闭并删目录。

三条硬守卫（宁可少测，不能误改用户文档）：

1. 窗口标题必须包含本次随机文件名；
2. 动作前编辑框内容必须等于基线文本，否则视为「别的文档」直接放弃；
3. 任一守卫失败即中止，不发送任何输入。

| 步骤 | 通道 | 耗时 | 结论 |
| --- | --- | --- | --- |
| ValuePattern 写入真实应用 | `value-pattern-ref` | 239 ms | `verified`（状态真变） |
| 快捷键保存 | `keyboard` | 407 ms | `verified-no-change` |
| 关闭窗口 | `keyboard` | 417 ms | `verified` |
| 磁盘校验 | — | 7 ms | `persisted:true`、基线保留、73 字节 |

判定 `real-app-write-verified`。窗口识别 113 ms、快照 44 节点（21 可操作 / 20 有名字，
`good`），说明现代记事本的 UIA 树质量足以支撑按名字定位。

这一步还暴露并修掉了验证器的假阴性：`Ctrl+S` 是幂等动作，界面本就不变，按「状态必须变化」
判定会误报 `verify-failed` 并白重试 3 次。现在区分出 `verified-no-change`——**不谎报已变化**，
成效由副作用自证；`desktop_*` 动作工具新增可选 `expectChange`（默认 true）。

### 3.6 树质量判定（新增 `src/modules/tree-quality.mjs`）

分类器只看进程名与标题，猜不出 Electron 应用（各自有独立 exe 名，进程名里没有 `electron`）。
实测 `workbuddy` 被归为 `unknown → gui-a11y`，但它的树只有 3 个节点——按名字点必然失败。
因此改为**观察后按实测树判定**：

| 判定 | 含义 | 处置 |
| --- | --- | --- |
| `good` | 有名字的可操作节点充足 | 走 a11y 树 |
| `sparse` | 树非空但指认不了目标 | 改判 `gui-visual`（视觉需策略开启），否则拒绝 |
| `empty` | 树为空 | 同上，并附 `emptyTree` |
| `deferred` | 节点预算耗尽，还没看全 | 不改判，提示先 `drillDown` |

两个关键取舍：

- 判定依据用桥回传的**完整树**（比骨架深 2 层），不是截断后的骨架。早期版本用骨架判定，
  把「控件在深处」的 `taskmgr` 误判成 `sparse`；
- `deferred` 只给「真没看全」（节点触顶 1500）的情形，否则会出现「永远下钻、永不下结论」。
  判定结果按 `appId#hwnd` 回写注册表，`desktop_list_apps` 的通道列随之为实测结论。

### 3.7 故障注入（P2 准入第 2 项）

桌面操作最怕的不是失败，而是失败以错误形态出现（窗口关了当成功、进程崩了还在重试）。
`tests/fault-injection.test.mjs` + 桥测试逐条锁死错误码与可恢复性：

| 故障 | 期望 | 结果 |
| --- | --- | --- |
| 窗口中途关闭 | `OBSERVATION_FAILED` + 可恢复 | ✅ |
| 目标进程崩溃 | `HANDOFF_REQUIRED` + 不可恢复 | ✅ |
| 观察阶段目标消失 | 结构化失败 + `hint` | ✅ |
| 界面变化后复用旧 ref | `STALE_REF` / `outcome=stale-ref` | ✅ |
| 动作无效果 | `VERIFY_FAILED` + `attempts` | ✅ |
| 预算耗尽 | `BUDGET_EXCEEDED` 熔断 | ✅ |
| 桥崩溃（请求在途） | pending 全拒 `CAPABILITY_UNAVAILABLE`，引用与探测缓存复位，下次调用自动重启 | ✅ |

### 3.8 桥生命周期（P2 准入第 3 项）

「崩了下次调用再拉一个」在真实环境里会退化成重启风暴：UIA 在锁屏 / Secure Desktop /
会话切换下会连续抛异常，没有上限的话每 200 ms 就起一个 `powershell.exe`，宿主既拿不到
可用桥也刷满日志。新增 `src/modules/bridge-lifecycle.mjs`（纯逻辑 + 可注入时钟）接管：

| 场景 | 策略 |
| --- | --- |
| 首次启动 | 放行，无退避 |
| 崩溃后重启 | 指数退避 200 → 400 → 800 ms（上限 5 s） |
| 120 s 内崩溃 ≥ 3 次 | 停止自动重启：`CAPABILITY_UNAVAILABLE` + `details.reason=bridge-crash-loop` + `handoff:true`，`desktop_capabilities` 报 `supported:false` 并给出可行动原因 |
| 连续存活 ≥ 60 s | 视为稳定，清空崩溃窗口 |
| 连续 ping 失败 ≥ 3 次 | 「进程在但管道僵死」→ 回收桥，下次调用按退避重建 |
| stdin 已关闭 | 丢弃半死桥并重建一次，不让后续请求全部永久失败 |
| `shutdown()` | 先发 `shutdown` 让 PowerShell 主循环 `break` 自然退出，超时才 `kill`；正常退出不计崩溃 |

真机实测（`DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:lifecycle`，`reports/p2-lifecycle.json`）：

| 验证项 | 实测 |
| --- | --- |
| `ping` 健康检查 | 3/3 回 pong，中位 **4 ms**（uptime / 已处理请求 / ref 数 / 工作集全部可读） |
| ping 不伤 ref | 观察后 `storedRefs=3`，ping 之后仍为 3（快照存在桥进程内，探活只读） |
| 崩溃自愈 | 外部 `taskkill` 强杀后下一次调用重建成功，**1.62 s / 1.81 s**（含 PowerShell 冷启动） |
| 崩溃循环认输 | 第 3 次崩溃后再调用 → `bridge-crash-loop`，`totalStarts` **零增长**（未再 spawn） |
| 优雅退出 | `shutdown` ack，**208 ms** 退出，`graceful:true`、进程确已消失、不计入崩溃 |

`desktop_capabilities` 的 `bridge` 段落现在带 `lifecycle`（`totalStarts` / `totalCrashes` /
`crashesInWindow` / `uptimeMs` / `lastCrash` / `lastPing` / `blocked*`），上层据此判断
「桥在抖」还是「环境真不可用」，不必靠重试次数反推。新增 9 个单测（`tests/bridge-lifecycle.test.mjs`）。

### 3.9 真实应用写入矩阵（P2 准入第 2 项）

记事本一家不能证明「判据通用」。`scripts/verify-multi-app.mjs` 把同一套
Observe→Act→Verify + 副作用校验推到五个家族，每个用例只用自建临时文件：

| 用例 | 家族 | 写入通道 | 成功证据 | 实测（`reports/p2-multi-app.json`） |
| --- | --- | --- | --- | --- |
| 记事本 / `.txt` | 经典 Win32 | `value-pattern-ref` | 读盘 | ✅ 40 字节，7 ms |
| Word / `.txt` | Office 文档模型 | `clipboard-paste` + `TextPattern` 校验 | 读盘 | ✅ 69 字节，1.7 s |
| Excel / `.csv` | Office 网格 | `clipboard-paste`（落点 `DataGrid`） | 读盘 | ✅ 42 字节，1 ms |
| 资源管理器 / 重命名 | Shell 列表 | 选中 → `F2` → 输入 → 回车 | 文件系统改名 | ✅ `renamed` + `originalGone` |
| Edge / 本地 HTML | 浏览器外壳 | —（策略拒绝 GUI） | 不适用：浏览器应走 DOM/CDP | 按设计拒绝 |

一次完整跑（空闲桌面，`--wait-idle 90`，3 分 14 秒）四家**首轮全绿、无重试**：

```
notepad-txt      write-verified  attempts=1  {"persisted":true,"length":40,"waitedMs":7}
word-txt         write-verified  attempts=1  {"persisted":true,"length":69,"waitedMs":1745}
excel-csv        write-verified  attempts=1  {"persisted":true,"length":42,"waitedMs":1}
explorer-rename  write-verified  attempts=1  {"renamed":true,"originalGone":true,"waitedMs":1}
edge-html        policy-blocked-browser      （策略层拒绝 GUI 驱动浏览器）
→ summary.verdict = multi-app-write-verified, writeVerified = 4/5
```

必须强调：**这些绿色全部来自读盘/文件系统**，没有一条来自「界面看起来变了」。
本轮反复出现的失败正是「每一步都返回 ok、磁盘一个字节没变」，验证器如实拒绝认账。

跑真机的过程产出了十二条可复用的判据修正（每条都落到代码里，不只是「记录一下」）：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | **窗口标题不是身份**：Word 把 `x.txt` 显示成 `x - Word(产品激活失败)`，Excel 追加 ` - Excel` | 进程名锁家族 + 含/不含扩展名双重匹配；唯一性由随机文件名保证 |
| 2 | **首启引导吃掉输入**：Word 第一次打开时标题已对，但前面叠着隐私引导页，输入全被吞、`Ctrl+S` 无反应 | 动作前 `settleDialogs()`：只点「下一步/接受/确定/是」，绝不点「否/取消/另存为/删除」 |
| 3 | **`\b` 在中文字符后面永远不成立**（本轮最贵的 bug）：`/^(是|确定|保存|…)\b/i` 对 `是(Y)`、`确定`、`下一步`、`关闭` 全返回 false，只有 `OK/Yes` 能过——兜底逻辑跑了几十轮、一个中文按钮都没点过 | 改 `(?![A-Za-z0-9])` 负向断言，CJK 与 ASCII 都对；并加了「另存为/save as」危险名排除 |
| 4 | **老式 Office 对话框按钮不是 `Button`**：三处实测 `ControlType` 都是 `Pane`（名字 `是(Y)`），子元素常带 0×0 矩形 | 接受 `Button/Pane/Custom/Text/ListItem`；对话框作用域内不强制面积；点不动退 `{ENTER}` |
| 5 | **模态可能顶替主窗口成为目标**：「Word 上次启动失败」标题就叫 `Microsoft Word`，按文件名永远匹配不到，却挡在加载前面 | 两阶段匹配：先宽松（6 s 后接受家族任意窗口，交 `settleDialogs` 答掉），再严格（标题带文件名且非 `文件转换/安全模式/受保护视图`） |
| 6 | **答模态必须排在发 `ESC` 之前**：`ESC` 语义是「取消」，对着「文件转换 - xxx.txt」发 `ESC` 等于取消打开这个文件 | 启动模态 → 严格确认窗口 → 再做前台探测，顺序固化在 `runCase` |
| 7 | **应用内模态不在顶层窗口枚举里**：Word 存 `.txt` 的保存确认框实测「本进程顶层窗口 = 1」，它是主窗口子树 depth 1 的嵌套 `Window` | 按树结构判定 + 按名回答，并接进「等磁盘」循环；只靠 `listApps` 会当成「没有对话框」 |
| 8 | **`typeText` 拿 `paste` 抄近路**：先试「焦点元素 `ValuePattern`」，而 Excel 的焦点是**公式栏**，`SetValue` 成功但什么都没变 | `paste: true` 视为显式通道选择，直接走剪贴板，不再先试 `ValuePattern`（桥侧改动） |
| 9 | **落点不能按角色名选**：Excel 同时有 `Edit 编辑栏`(1482×77) 与 `DataGrid 网格`(1327×497)，「Edit 优先」打进公式栏 | 按可写面积选，界面部件名（编辑栏/Ribbon/搜索框）直接排除；抽成 `src/modules/target-pick.mjs` + 8 条单测 |
| 10 | **窗口出现 ≠ 能输入**：冷启动期点网格不建选区、`^v` 被丢、`^s` 无效，每步却都返回 ok | 「目标角色连续两次快照都在」才算就绪（Excel 实测等 1.3 s）再动手 |
| 11 | **失败会自我强化**：保存没落盘 → 收尾强杀 → 下次弹「上次启动失败」→ 吃输入 → 又失败（「单跑能过、全量跑不过」的真因） | 答模态 + 优雅收尾；修复后同一份代码全量跑稳定四绿 |
| 12 | **前台会被占用**：操作者正在用这台机器时 Windows 拒绝后台抢焦点（这是保护用户的正确行为） | 用例前做无害前台探测，失败判 `environment-busy` 跳过；`--wait-idle <秒>` 等空闲 |

配套新增 `scripts/probe-app.mjs`（单应用结构探针）：打印 role 直方图、按面积的候选落点、
树轮廓、`readText` 通道，可选做「点落点 → 粘贴 → `^s` → 每秒观察磁盘与全部顶层窗口/嵌套模态」。
Excel 的「公式栏 vs 网格」与 Word 的「保存确认框 = depth 1 嵌套 Window、按钮是 Pane」
都是靠它定性的——给下一个应用写用例前先跑它，能省掉大部分试错。

> 真机 GUI 验证必须在**空闲桌面**上跑：`npm run verify:multi-app -- --wait-idle 240`。
> 一边用电脑一边跑，结果会是 `environment-busy`，那不是应用不可自动化。失败用例会自动重跑一次，
> 两次结论都写进报告（`attempts` / `firstAttempt`），不掩盖第一次的失败。
> 排查「界面看起来对、实际没生效」加 `--debug-shots`（三阶段截图写系统临时目录，不进仓库/报告）。

### 3.10 真实应用覆盖率矩阵（P2 准入第 1 项）

P2 第 1 项要求「覆盖率扩到 ≥10 个真实目标应用，并对 sparse/empty 明确产品化判定」。
此前的 `coverage-report.mjs` 是**被动采样**（只拍当前桌面上碰巧开着的窗口），凑不齐固定
应用集、也无法复现。新增 `scripts/verify-app-coverage.mjs` 做**主动采样**：固定清单逐个
拉起（自建空白/临时文件实例）、多深度采样、逐家给出产品判定，**全程只 snapshot**。

`--with-office` 下 16 个目标应用，一次完整跑 1 分 16 秒，`reports/p2-app-coverage.json`：

| 应用 | 家族 | 最深质量 | 有名字可操作 | 判定 |
| --- | --- | --- | --- | --- |
| 记事本 | 经典 Win32 | good | 32 | 语义树 |
| 计算器 | UWP / XAML | good | 37 | 语义树 |
| 画图 | UWP 桌面桥 | good | 22 | 语义树 |
| 资源管理器 | Shell | good | 36 | 语义树 |
| Windows 终端 | 现代控制台宿主 | good | 7 | 语义树 |
| 设置 | UWP（AppFrameHost） | good | 32 | 语义树 |
| Word | Office 文档模型 | good | 6 | 语义树（正文 `TextPattern`） |
| Excel | Office 网格 | good | 223 | 语义树（`DataItem` 209） |
| Edge | 浏览器外壳 | good（仅外壳） | 8 | DOM/CDP |
| 任务管理器 | Win32 现代 | sparse | 0 | 视觉兜底（当前拒绝） |
| 字符映射表 | Win32 对话框 | sparse | 1 | 视觉兜底（当前拒绝） |
| 系统信息 | Win32 TreeView | sparse | 0 | 视觉兜底（当前拒绝） |
| 磁盘清理 | Win32 对话框 | sparse | 0 | 视觉兜底（当前拒绝） |
| 命令提示符 / PS 5 | 控制台子系统 | — | — | 环境受限（`launch-blocked`） |
| 性能监视器 | MMC | — | — | 需管理员会话（`NEEDS_ELEVATION`） |

`verdict = coverage-10plus`、`sampled = 13/16`、`a11yOperable = 8`、`needsVisualFallback = 4`、
`domChannelRequired = 1`、`launchBlocked = 3`；均值 214 ms、最慢 Word 1249 ms（Office 树的
采集成本是普通应用的 4~8 倍）。

**产品化判定（P2 要求的正是这一段）**：16 家里 8 家走语义树；4 家（任务管理器/字符映射表/
系统信息/磁盘清卷）树非空但不可按名字定位，产品处置是**视觉兜底**——当前实现为拒绝并回
`CAPABILITY_UNAVAILABLE`，这是已登记缺口而不是设计终局；1 家（Edge）只暴露外壳，明确走
DOM/CDP；3 家因环境或权限限制不参与统计，单独列在 `launchBlocked` 而不是混进 `sampled`。

**为什么这 4 个 sparse 可信**：13 家的最深样本全部 `complete: true`（cut = 0、预算未触顶），
即树在 depth 8 内确实看全了。这排除了「因为没展开所以看着稀疏」的误判——视觉兜底对它们
是真实需求。反过来，8 家 good 的应用在 depth 4 就已经 good，清单里没有 `deferred`。

真机踩到八条，均已落到代码：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | `snapshot.truncated` **恒为 true**（桥无法证明自己没漏），用它判完整度等于永远判 deferred | 完整度下沉到骨架逐节点 `truncated` 标记 + 节点预算 1500；新增 `treeCompleteness` / `assessSnapshot`，感知层同步改用（原来用 `nodeCount < 1400` 猜） |
| 2 | 会**误采别的应用**：拉起 PS 5 时恰好弹出输入法安装器窗口，「唯一新窗口」被当成目标，结论完全失真 | 认领窗口改为显式 `appIds` 白名单，匹配不上就继续等，不做猜测 |
| 3 | **闪屏会换壳**：Office 启动窗口几秒后被主窗口替换，之后全部 `OBSERVATION_FAILED` | 采样前再 `resolveTarget`（优先标题带文件名），采样失败也重认领；实测 Word `264526→264962`、Excel `264970→330130` |
| 4 | **单实例应用没有新窗口**：任务管理器早已开着，spawn 只是聚焦旧窗口 | `owned:false` 只读采样，收尾**跳过关闭**（不是我们拉起的窗口） |
| 5 | **UWP 窗口不在自己进程里**：计算器/设置的窗口属于 `ApplicationFrameHost.exe` | 白名单含宿主进程名 + 「拉起前后 hwnd 差集」定位 |
| 6 | **控制台进程在当前执行环境拿不到窗口**：`cmd`/`powershell` spawn 后立刻 `exitCode 0` | 记 `launch-blocked` + `harnessNote`，明确不是「应用不可自动化」；控制台家族用 Windows 终端覆盖 |
| 7 | **`EACCES` 不是「没装」**：性能监视器需要管理员权限 | 单独判 `NEEDS_ELEVATION` |
| 8 | **浏览器树 good 也只是外壳**：Edge 有 Tab/ToolBar/Button，无 `Document`/`Edit` | 按家族判 `dom-channel-required`，内容容器缺失即走 CDP |

一处自我修正：§3.4 曾把 `taskmgr` 的 `sparse` 归因为「骨架截断造成的误判」。用完整度判据
复核后确认，它在 depth 8、树完整（cut = 0）时仍是 16 个 `Pane`、0 个有名字的可操作节点——
它确实不可按名字定位，需要视觉兜底。

### 3.11 视觉兜底：坐标帧与像素验效（P2「随后」第 2 项）

§3.10 的 4 家 `sparse` 应用（任务管理器 / 字符映射表 / 系统信息 / 磁盘清理）此前只能拒绝。
拒绝是对的——但「视觉兜底」当时只剩一句口号：**点不准**（坐标来自截图，不是屏幕坐标）、
**验不了**（树前后一样，`expectChange` 恒 false）。这一轮把执行侧两条腿补上，默认仍关闭。

**① 坐标帧：图像像素 ≠ 屏幕坐标**

截图取的是**窗口矩形**，图像 (0,0) 是窗口左上角，不是屏幕 (0,0)；高 DPI 下截图像素数
还与 UIA/输入 API 的单位不等（同一块区域，截图 1250 px、矩形 1000 px）。两者叠加的后果
不是「点偏几像素」，是**整块偏移一个窗口原点**——打到别的窗口上，属 R4 不可逆误动作。

- 桥侧 `screenshot` 回传 `rect`（窗口矩形，屏幕坐标）；`coords.mjs` 统一换算：
  `screen = rect.origin + image / scale`；
- `desktop_click_xy` 默认 `frame:"window"`（x/y 是截图像素），`frame:"screen"` 时不再换算；
- 换算后**越界一律 `ACTION_DENIED`**（附窗口矩形与换算结果），宁可这一次不点；
- **吸附在换算之后**：树的 `rect` 在屏幕坐标系，先吸附会吸到错元素（顺序写反就错）。

**② 像素验效：树不变时唯一还剩下的证据**

sparse 应用点击前后树完全一样，复观察拿到的还是同一棵，每步都被判 `verify-failed`。
新增 `pixel-signature.mjs`：桥侧把窗口缩到 **64×64 灰度**（4096 字节 → 5.5 KB base64，
一步取两次也不至于把 stdio 塞满），判据是**差异格数占比**而不是逐像素相等：

| 参数 | 取值 | 挡住什么 |
| --- | --- | --- |
| `cellDelta` | 6 | 灰度编码噪声（实测静止两帧 `maxDelta ≤ 1`） |
| `changedRatio` | 2% | 光标闪烁 / 抗锯齿 / 悬停高亮（假阳性比假阴性危险） |

结构与像素**分开算再取或**，`verification.evidence` 如实标 `tree` / `tree+pixels`。
另外：动作前连取两帧做**基线稳定性**判定；两帧不同即 `pixelStable:false`，
`pixelChanged` 给 `null`、退回结构证据（`pixelNote:"unstable-baseline"`）——界面还在动画时，
前后像素差**无法归因**。

**③ 真机结果**（`reports/p2-visual-fallback.json`，`verdict = visual-fallback-verified`）

| 用例 | 目标 | 关键证据 | 判定 |
| --- | --- | --- | --- |
| 坐标帧 | 计算器（UWP，窗口原点 (77,64)） | 图像 (98,688) → 屏幕 (175,752)，显示区 `显示为 7`；再点「八」→ `显示为 78`；越界回 `ACTION_DENIED` | `coordinate-frame-verified` |
| 像素验效 | 字符映射表（`sparse`，1 个命名节点） | 静止两帧 `identical`（400 ms 内稳定）；点击后 `tree+pixels` 均变化 | `pixel-verify-works` |
| 像素验效 | 任务管理器（`sparse`，0 个命名节点） | **`treeChanged:false` + `pixelChanged:true`**，1 次重试后成功 | `pixel-verify-works` |

任务管理器那行是本节的支点：树完全没变，只有像素通道能证明动作生效。

**真机上踩到的三条**

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | **截图抓的是屏幕像素**：目标被遮挡时抓到的是遮挡物，before/after 量的是同一块别人的画面（像素验效从根上失真，且方向随机） | 新增 `activate` 开关（默认 false，不抢焦点）：验效基线帧先置前台；树为空兜底时自动开 |
| 2 | **窗口刚出现还在渲染**：连续两帧差 84 格（2.05%），首轮误判「像素噪声太高」 | 不是阈值问题而是取样时机：先等连续两帧一致（实测 400 ms）再取基线；验效侧同时补基线稳定性判定 |
| 3 | **签名不能按「截图」计费**：`maxScreenshots=3` 下每步 2 次会让视觉兜底两步熔断 | 签名不计截图预算（4 KB 灰度网格不是感知截图），上界由 `maxSteps` 兜住（每步固定 2 次） |

### 3.12 把图喂给模型（P2「随后」第 3 项）

§3.11 让执行侧能产出坐标帧和像素证据，但**模型看不到那张图**：`mcp-server.mjs` 只回
`{type:"text"}`，`McpManager.executeMcpTool` 也只保留 text content。模型拿不到像素却要
给坐标，只能凭树猜——而「假装看过」不会报错，只会点偏。

**链路**（两处改动，均为纯增量）

| 层 | 文件 | 改了什么 |
| --- | --- | --- |
| 协议帧 | `desktop-agent/src/modules/mcp-content.mjs`（新增） | `splitImagePayload` 把工具返回值拆成「文本载荷 + 图像块」：base64 **只**进 image 块，text 块只留 `{mimeType, bytes, attached}` |
| core | `packages/core/src/mcp/mcp-image-content.ts`（新增） | `extractMcpImages` 白名单 + base64 校验 + 4 MiB/张 + 单次 1 张；`buildMcpImageFollowUpMessage` 拼 `role:"user"` 的 image_url 消息 |
| 接线 | `mcp-manager.ts` / `executor.ts` | `executeMcpTool` 回传 `images`（无图时不带该字段，既有 `deepEqual` 用例不受影响）；executor 转成 `followUpMessages` |

**三条取舍**

1. **base64 不进 text 块**：同一张图写两遍等于 token 花两遍，71 K 字符的 base64 足以挤爆上下文；
2. **丢图必须说明**：超限 / 坏 base64 / 非白名单 mime → 丢图并在文本里标 `dropped.reason`
   （`too-large`/`invalid-base64`/`unsupported-mime`/`too-many-images`），让模型知道"这次没给像素"；
   静默丢弃会让它继续瞎猜，比失败更贵；
3. **图挂 `role:"user"` 而不挂 `role:"tool"`**：OpenAI 兼容接口的 tool 消息只接受文本；
   该通路与 ReadImage 完全一致，`multimodal=off` 时 messageConverter 仍会过滤 `image_url`，闸门没被绕过。

**真机证据**（`reports/p2-image-content.json`，`verdict = image-content-verified`）

| 检查 | 结果 |
| --- | --- |
| 帧结构 | `content = ["text","image"]`，`textCarriesBase64:false` |
| 像素真实性 | image 解出 PNG，IHDR **666×1078** 与工具回传 `width/height` 一致，53 356 B |
| core 消费 | 同一份帧过 `extractMcpImages` 得 1 张图；follow-up `role:user`/`visible:false`，data URL 与 base64 逐字节对应 |
| 遥测 | 事件流无 base64（图像不落事件、不落盘） |

**本节末尾的状态（随后在 §3.13 已解决）**：此时 `allowScreenshot` / `allowCoordinateInput`
在 `desktop_agent.rs::harden()` 与 `policy-load.mjs::hardenExternalPolicy()` 里都被
**强制复位为 false**——管线通了、闸门焊死。这不是漏做，是刻意的纵深防御：开通它需要一次
独立的高风险授权流程（IPC + 用户逐次确认 + 审计），下一节就是这件事。

---

### 3.13 视觉通道的授权闸门（P2「随后」第 4 项）

§3.12 把图喂通了，但闸门是焊死的：两侧 `harden` 都把 `allowScreenshot` /
`allowCoordinateInput` 直接写死 `false`。所以 4 家 `sparse` 应用（字符映射表、任务管理器等）
仍然只能按「拒绝」处理。

**为什么不是"加一个开关"**：截图能读屏（可能带着聊天窗口、密码框、工资条），坐标点击能
代用户点「确认转账」。这和「列窗口」不是一个风险量级，一个布尔开关只要被写进
`desktop-agent.json` 就永久生效，用户第二天不会记得自己开过。改成**一次显式、限时、按应用**
的授权：

| 环节 | 规则 | 为什么 |
| --- | --- | --- |
| 申请令牌 | `vision_challenge`：5 min 有效、一次性、进程内保存 | 防误触与重放；重启即失效，授权必须"当场确认" |
| 提交授权 | `vision_grant`：`apps` 必须 ⊆ 已有 `read` 权限的应用；`ttl ∈ [1 min, 24 h]`；坐标点击单独勾选 | 不能借视觉授权顺手解锁没授权过的应用；只读授权（不点）也支持 |
| 派生开关 | 两侧读盘时都跑 `normalize_vision()`：过期 / 空清单 / 非法 appId / 授权时刻在未来（时钟可疑）/ 超长 → 一律作废，随后 `allowScreenshot = vision != null` | 手改文件放宽不了；到期自动收回，不依赖用户记得来关 |
| 审计 | 每次 grant / revoke 追加一行 JSONL（只记 `grantId`/`appId`/时长/时间戳） | 留不下记录的授权等于没留边界；审计写失败则**不授权** |

`normalize_vision` 是同一份契约的两个实现（Rust `desktop_agent.rs` 与 Node
`policy-load.mjs`），常量（24 h / 1 min / 5 min）两侧同名同值，单测各自覆盖全部拒绝分支。

**真机验证**（`reports/p2-vision-gate.json`，`verdict = vision-gate-verified`）
——脚本起真的 sidecar 子进程、走真的 stdio MCP 帧，喂的就是壳侧写出的那份 JSON 形状：

| # | 场景 | 期望 | 实测 |
| --- | --- | --- | --- |
| A | 无授权 | 拒 | `CAPABILITY_UNAVAILABLE`「截屏通道默认关闭」 |
| B | 有效授权（只读） | 通过 + image 块 | `content=["text","image"]`，PNG 70 B |
| C | 有效授权但不含坐标 | 拒坐标点击 | 「坐标输入通道默认关闭」 |
| D | 授权的是别的应用 | 拒 | 「应用 notepad 不在视觉授权清单内」 |
| E | 授权已过期 | 拒 | 「截屏通道默认关闭」（过期后两侧都当没有授权） |
| F | 真机（计算器） | 像素真到得了模型 | PNG IHDR **666×1078** == 回传 `width/height`，50 852 B，text 块 399 B 且**不含 base64** |

**验证脚本自己踩的两条坑**（都是「测试在骗自己」，记下来免得复踩）

1. **闸门脚本没开桥**：`createWindowsBackend()` 默认走 `tasklist` 回落，**所有条目 `hwnd`
   都是 null**，于是「等不到新窗口」被读成"计算器起不来"；实际是枚举源不对。现在脚本显式
   `bridgeEnabled: true`，并在「全部无 hwnd」时直接报「UIA 桥未生效」。
2. **判据拿到的是原始帧，不是派生观测**：`pixelSize` / `imageBytes` 是 `describe()` 算出来的，
   `expect(info)` 里取到的是 `undefined`，于是**条件恒假、静默判失败**——真机明明全对却报
   `broken`。现在判据收到「原始帧 + 派生观测」的合并视图，且 `expect` 可以返回逐项判据
   （`checks`），失败时报告里能直接看出卡在哪一条。

**顺带确认的边界**：授权清单只覆盖 `read` 权限应用；坐标点击要在授权时单独勾；撤销是即时的
（`vision_revoke` 写盘 + 审计），下一次 sidecar 启动就看不到旧授权。

---

## 4. P1 交付清单

### 4.1 sidecar（`desktop/desktop-agent/`，零新增 npm 依赖）

| 层 | 模块 | 职责 |
| --- | --- | --- |
| L1 协议 | `mcp-server.mjs` / `mcp-content.mjs` | stdio JSON-RPC 2.0；`initialize` / `tools/list` / `tools/call` / `ping`；stdout 仅协议帧；截图结果拆成 text 元数据 + image 内容块（§3.12） |
| L2 编排 | `agent.mjs` | 11 个工具定义与分发、三级降级通道决策、`pid` 精确目标 |
| L3 护栏 | `policy-guard.mjs` / `policy-load.mjs` / `budget.mjs` / `telemetry.mjs` | 白名单 + 注入扫描 + 一次性确认令牌、外部策略硬化、预算原子预扣熔断、脱敏事件 |
| L3 感知 | `perception.mjs` / `app-registry.mjs` / `tree-quality.mjs` / `target-pick.mjs` | 稳定 ref / 骨架树 / 下钻、TTL 缓存、通道矩阵、实测树质量与**完整度**判定及回写、写入落点选择（按可写面积） |
| L3 验证 | `verifier.mjs` | Observe→Act→Verify；旧 ref 硬返回 `STALE_REF`；有界重试 |
| L3 可靠性 | `bridge-lifecycle.mjs` | 桥崩溃指数退避、窗口内重启上限、稳定重置、僵死回收、优雅退出 |
| L4 后端 | `contract.mjs` / `mock.mjs` / `windows.mjs` / `windows-uia.ps1` | 可插拔契约；mock 故障注入；Windows 长驻桥客户端 + tasklist 回落；UIA 长驻桥（599 行） |

### 4.2 壳侧接线（只加「配置面」，不加执行面）

- `desktop/src-tauri/src/desktop_agent.rs`：策略落盘 `~/.deepcode/desktop-agent.json`；
  `harden()` 复位不可写字段、拒绝 `bypass`、严格校验 appId/scope；视觉通道的限时授权
  （`vision_challenge` / `grant` / `revoke` + 审计 JSONL，§3.13）；含 9 个 Rust 单测。
- `desktop/src-tauri/src/ipc.rs` / `lib.rs`：新增 7 条命令
  `desktop_agent_status` / `desktop_agent_toggle` / `desktop_agent_permissions_get` /
  `desktop_agent_permissions_set` / `desktop_agent_vision_challenge` /
  `desktop_agent_vision_grant` / `desktop_agent_vision_revoke`。
- `desktop/src-tauri/permissions/app-ipc.toml`：ACL 同步（25=25）。
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
| Node 单测 | `cd desktop/desktop-agent && npm test` | **131/131 通过**（13 个测试文件，约 22 s） |
| 真机 GUI 闭环 | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui` | **4/4 verified**，`gui-unblocked`；连续 4 次稳定 |
| 真实应用写入 | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:real-app` | **3/3 步骤**，`real-app-write-verified`，磁盘 `persisted:true` |
| 桥生命周期 | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:lifecycle` | `lifecycle-managed`：ping 4 ms、强杀自愈 2/2、崩溃循环零新增 spawn、优雅退出 208 ms |
| 覆盖率矩阵（主动） | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:coverage -- --with-office` | `coverage-10plus`：13/16 采到树，8 家语义树 / 4 家视觉兜底 / 1 家 DOM，3 家环境受限；均值 214 ms |
| 视觉兜底（真机） | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:visual -- --only calc,charmap,taskmgr` | `visual-fallback-verified`：坐标帧 3/3（点「七」→7、点「八」→78、越界拒绝）、像素验效 2/2（taskmgr `treeChanged:false`/`pixelChanged:true`） |
| 图像进模型（真机） | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:image` | `image-content-verified`：帧含 text+image 两块；PNG IHDR 666×1078 与回传一致（53 356 B）；core 提取 1 张图并拼出 `image_url` follow-up |
| 视觉闸门（真机） | `npm run verify:vision` | `vision-gate-verified` 6/6：无授权 / 过期 / 越权应用 / 无坐标授权 4 条拒绝路径 + 只读授权出图 + 真机 PNG 666×1078 与回传一致 |
| 覆盖率采样（被动） | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run coverage` | 5/5 树可用，均值 106 ms，无失败 |
| P0 探针 | `DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe` | `continue`；6 窗口 / 93 ms，能力 6/7 可用 |
| MCP stdio 冒烟 | `printf … \| node src/index.mjs` | `initialize` 返回 `2025-03-26`；`tools/list` 11 个工具；`desktop_status` 默认 `enabled:false` |
| 外部策略硬化 | 注入含 `bypass` / `allowScreenshot:true` / `maxSteps:9999` 的策略 | 生效值 `manual` / `false` / `false` / `maxSteps=100`；`enabled` 与白名单保留 |
| 全仓类型检查 | `npm run typecheck` | 5 个 workspace 全过，exit 0 |
| IPC 四方契约 | `npm run check:ipc` | 定义 25 = 注册 25 = ACL 25；前端调用点 24（`window_new` 历史未用） |
| Rust 编译 | `cargo check` | exit 0；仅既有 `PASSWORD_ENV` dead_code 警告 |
| Rust 单测（本机 GNU） | `cd desktop/src-tauri && cargo test --lib` | **80 passed / 0 failed / 1 ignored**（2.2 s；另有 7 个用例按平台门控，见 §5.1） |
| Rust 单测（MSVC CI） | CI job `rust-msvc`（`windows-latest` + `stable-x86_64-pc-windows-msvc`） | 上一轮基线 **74 passed / 0 failed / 1 ignored**（4.93 s）；本轮新增 6 条视觉授权用例后本机 80 passed，MSVC 侧待 CI 复跑（§8 末条） |

### 5.1 Rust 用例为什么之前跑不起来（已修，§8 第 3 项）

**旧结论（错）**：`cargo test --lib` 在本机报 `STATUS_ENTRYPOINT_NOT_FOUND`，
判为「MinGW 工具链 / WebView2 DLL 环境问题」，并推断「MSVC CI 应能直接跑全量」。

**证伪**：按此推断加了 MSVC job（`windows-latest` + `stable-x86_64-pc-windows-msvc`，
干净 runner、无本地 DLL 污染），同样在**第一个用例之前**退出：
`exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND`。与工具链无关。

**真因**（tauri 生态已知问题 tauri#13419 / #14580）：`tauri` / `tray-icon`
静态引用了只存在于 **Common Controls v6** 的入口点，而 Windows 只按 **exe 自带清单**
决定把 `ComCtl32` 解析到 v5 还是 v6。`tauri_build::build()` 通过 tauri-winres 把
清单只编进 **bin**（`rustc-link-arg-bins`），测试二进制一直是「裸的」——于是加载
v5 → 导入解析失败 → 进程启动即死。`cargo test --lib --no-run` 能过，是因为那只是
编译，从不加载 exe。

**修复**（`desktop/src-tauri/build.rs` + `windows-test-manifest.xml`）：

1. tauri-build 改用 `Attributes::new().windows_attributes(WindowsAttributes::new_without_app_manifest())`，
   不再让它自己嵌清单（否则同一 exe 出现两个 `RT_MANIFEST`，链接器报 `CVT1100`）；
2. 自己生成只含 `1 24 "windows-test-manifest.xml"` 的 `.rc`，经
   `embed_resource::compile_for_everything` 用 `cargo:rustc-link-arg` 链进**所有**目标
   （bin / lib 单测 / bench / example）。清单内容与 tauri-build 自带的那份**逐字节一致**；
3. 走 `.rc` 而不是 link.exe 的 `/MANIFEST:EMBED`+`/MANIFESTINPUT`，是为了 GNU 也生效
   （GNU 走 ld，不认后者），两条工具链共用一条代码路径。

**顺带修掉两处「只在 Unix 成立」的用例**（能跑起来之后才暴露）：

| 用例 | 原写法 | 问题 | 改法 |
| --- | --- | --- | --- |
| `engine::manager` 4 个 mock 引擎用例 | 直接 spawn 带 shebang 的 `.js` | Windows `CreateProcess` 不认 shebang（os error 193），是**脚手架选型**问题不是被测逻辑 | 门控到 `#[cfg(unix)]`（与既有 SIGKILL 用例同款），Windows 侧引擎拉起由真机 `verify:*` 覆盖 |
| `ssh::exec::expands_tilde_identity` | 断言展开结果 `starts_with('/')` | Windows 家目录是 `C:\Users\x`，且 `expand_home` 直接拼 `/` 会得到混合分隔符 | `expand_home` 改 `Path::join`；断言改为「已展开 + `Path::is_absolute` + 尾部 `/.ssh/id_ed25519`」 |

**结果**：本机 GNU `74 passed / 0 failed / 1 ignored`（2.2 s）；MSVC CI 同一组用例
`74 passed / 0 failed / 1 ignored`（4.93 s，job 4 m 01 s）。**副产物**：本机不再是
「只能编译、不能运行」，Rust 用例本地可闭环，CI 用来兜 MSVC 一侧。
（§3.13 又加了 6 条视觉授权用例，本机现为 **80 passed / 1 ignored**；MSVC 侧待 CI 复跑。）

**CI 侧配套**（`.github/workflows/ci.yml` 的 `rust-msvc` job）：`windows-latest` +
`stable-x86_64-pc-windows-msvc`、`Swatinem/rust-cache`（key 带 `msvc` 前缀，避免与
GNU 产物串味）、先 `--list` 数一遍用例（<60 直接失败，防空跑）、再
`cargo test --lib --locked -- --test-threads=1`（端口 / 临时 SQLite 类用例串行求确定性）。
另有一条工程细节：本仓 Actions 的**日志下载接口要求 admin 权限**（403），失败原因
只有「Process completed with exit code 1」；因此该 job 把 cargo 输出尾部写进
`::error::` 注解、把 `test result:` 写进 `::notice::` 注解——注解匿名可读，
定位问题不必登录网页翻日志。

**已知残留（GNU only）**：链接时 ld 报
`.rsrc merge failure: multiple non-default manifests`——GNU 侧 ld 自己也会塞一份默认清单。
对照实验确认**改前 bin 就有这条告警**（与本次修改无关），且 exe 内清单生效（用例能跑、
`Microsoft.Windows.Common-Controls` 字符串在产物里）；MSVC 侧只有一份清单，无此告警。

---

## 6. 安全 / 稳定性护栏落地对照

| 方案风险 | 本切片对应实现 |
| --- | --- |
| R1 提示注入（界面文本当指令） | 观察结果标记 `untrusted`；`detectInjection` 命中即拦写动作，且不回灌原文 |
| R2 敏感应用 | 5 类敏感分类**先于只读分支**硬拦截；探针不落盘窗口标题；审计脱敏 |
| R3 越权 / 提权 | 双侧 `harden()` 锁定字段、`bypass` 降级、壳 ACL 只含 7 条配置/授权命令 |
| R3' 读屏与代点击 | 视觉通道必须经限时（≤24 h）+ 按应用授权（仅限已有 read 权限的应用）、一次性令牌、坐标点击单独勾选；开关由授权派生、两侧读盘时重判过期；grant/revoke 写审计 JSONL（§3.13） |
| R4 不可逆动作 | 一次性 5 分钟确认令牌（内存态），不受「始终允许」豁免 |
| R8 成本失控 | 步数 / 截图 / token 原子预扣 + 熔断，任务内后续动作全拒 |
| R9/R10 平台能力差异 / 陈旧 ref | 真机自检能力矩阵；长驻桥保证 ref 有效；`STALE_REF` 硬失败而非带旧坐标继续点 |
| 误操作其它窗口 | 键盘/坐标动作前置前台校验（HWND/PID 复核），置前失败即 `ACTION_DENIED` |
| UAC / 验证码 / 锁屏 | 统一 `HANDOFF_REQUIRED`，不做绕过 |

---

## 7. 未解决与边界

1. **写用例只覆盖 5 个应用**：记事本 / Word / Excel / 资源管理器 / Edge 已跑通（§3.9），
   浏览器按策略拒绝 GUI；其余应用要按 §3.10 的通道判定逐类补用例。4 家 `sparse` 应用
   现在可以走视觉通道（§3.11 执行侧 + §3.12 图像 + §3.13 授权），但**真实任务级的用例还没补**：
   目前只验到「点下去生效」，没验「按用户意图点对」。
2. **UAC 未感知**：Secure Desktop 与完整性级别检测未实现，遇 UAC 一律交还人工。
3. **分类启发式仍保留**：进程名/标题分类仍用于初始通道建议（`unknown` 占比高），
   但已不再是最终结论——观察后由 `tree-quality` 实测覆盖；未观察过的应用仍可能是错的。
4. **视觉通道可放量但默认关闭**：闸门已从「硬锁」改成**限时 + 按应用**的授权（§3.13），
   两侧 `harden` 从授权派生开关、过期即收回，真机 `vision-gate-verified` 6/6。剩下的是
   **默认值与使用体验**：默认 `vision: null`（不授权 = 不能截图），且授权仍需重启引擎才生效
   （策略不热更新，见条目 5）。所以 4 家 `sparse` 应用现在是「授权后可用」，不再只能拒绝。
5. **策略不热更新**：改开关/授权需重启引擎，UI 已有 `restartHint` 文案。
6. **仅 Windows 真后端**：macOS AX / Linux AT-SPI 未实现，回落 mock。
7. **未接线引擎生命周期**：桥进程自身的生命周期（退避 / 崩溃上限 / 僵死回收 / 优雅退出）
   已接管（§3.8）；但「随壳启停、壳侧重启上限、策略热更新」的 `AgentLifecycle` 仍未接线。
8. **桥对脚本编码敏感**：`windows-uia.ps1` 必须保持 UTF-8 BOM，否则 PowerShell 5.1
   按 GBK 解码会解析失败；已写入 README 与回归用例的约束说明。
9. **交叉工作区提示**：同一工作区里 `desktop/build/*` 的 Windows 分发打包脚本是另一条
   工作流，其「能力排除守卫」明确不打包本切片。若在该分支上打分发包，需用
   `-BaselineRef` 固定到不含本切片的提交，否则默认 `HEAD` 快照会带上 IPC 并触发守卫中止。
10. **引擎启动用例在 Windows 上未覆盖**：mock 引擎是带 shebang 的 `.js`，Windows
    `CreateProcess` 不认 shebang，故 `engine::manager` 的 4 个启动/重启/探活用例门控在
    `#[cfg(unix)]`（§5.1）。补法是把 sidecar 改成「node + 脚本参数」形态，再给这组用例加
    Windows 变体；当前 Windows 侧的引擎拉起由真机 `verify:*` 覆盖。

---

## 8. P2 准入条件与下一步

**准入（真机闭环 / 覆盖率 / 写入闭环 / 故障注入均已达成，以下为放量前置）：**

1. ~~覆盖率扩到 ≥ 10 个真实目标应用~~ ✅ 已完成（§3.10）：主动拉起 16 个目标、13 个采到树
   （8 家语义树可操作 / 4 家视觉兜底 / 1 家 DOM），`sparse` 判定已由完整度判据复核为真；
   视觉兜底通道本身仍未实现，这 4 家当前按「拒绝」处理并如实报 `CAPABILITY_UNAVAILABLE`；
2. ~~真实应用写用例从 1 个扩到 ≥ 5 个~~ ✅ 已完成（§3.9）：5 个用例覆盖经典 Win32 /
   Office 文档模型 / Office 网格 / Shell / 浏览器外壳，其中 4 家以读盘或文件系统为证据
   首轮全绿，浏览器按策略拒绝 GUI；`expectChange` 与副作用校验的通用性由矩阵本身证明；
3. ~~在 MSVC CI 上跑通 `cargo test --lib`，闭环 Rust 用例运行验证~~ ✅ 已完成（§5.1）：
   新增 `rust-msvc` job（`windows-latest` + MSVC，`--locked` + 用例数守卫 + 自诊断注解），
   **74 passed / 0 failed / 1 ignored**（4.93 s）。过程中纠正了原「MinGW 环境问题」的误判——
   真因是测试 exe 没有 Windows 应用清单（ComCtl32 v6 未激活），已在 `build.rs` 修掉，
   本机 GNU 也一并受益；
4. ~~桥进程纳入生命周期管理~~ ✅ 已完成（§3.8）：`ping` 健康检查、指数退避、
   120 s 内崩溃 3 次的自动重启上限（`bridge-crash-loop`）、僵死回收、`shutdown` 优雅退出。

**随后：**

- ~~视觉兜底与坐标吸附（P2）~~ ✅ 执行侧（§3.11）与**模型侧**（§3.12）均已闭环：
  坐标帧换算 + 越界拒绝 + 64×64 像素验效，真机 `visual-fallback-verified`；
  MCP 图像内容块透传到 core 的 `image_url` follow-up，真机 `image-content-verified`；
- ~~视觉通道的高风险授权流程~~ ✅ 已完成（§3.13）：`vision_challenge`（一次性令牌 5 min）→
  `vision_grant`（只能选已有 read 权限的应用、1 min–24 h、坐标点击单独勾选）→
  `vision_revoke`；两侧 harden 改为**从授权派生**开关，`locked_fields` 口径同步改；
  审计 JSONL 只记 `grantId`/`appId`/时长；真机 `vision-gate-verified` 6/6。
  **剩下的**：配置页 UI 还没有这三条 IPC 的界面（现在只能从设置面调），以及授权后
  sidecar 需要重启才生效（策略热更新属 `AgentLifecycle`）；
- **`sparse` 应用的任务级用例**：视觉通道通了，但 4 家应用只验到「点下去界面确实变了」，
  没验「按意图点对」（例如任务管理器的结束任务流程）。补法是给 `verify:vision` 之外
  再加一组按应用的任务脚本；
- **MSVC CI 复跑**：本轮新增 6 条视觉授权用例（本机 80 passed），CI 侧需确认
  `rust-msvc` job 仍绿、用例数守卫（<60 失败）未被绕过；
- 接 `AgentLifecycle`（壳管 sidecar 启停 / 崩溃上限 / 策略热更新）；
- 配置页 UI 落地 7 条 IPC（status / toggle / permissions_get / permissions_set /
  vision_challenge / vision_grant / vision_revoke；当前只有 TS 包装，无界面）；
- 按方案 §8 补端到端度量：任务成功率、单步耗时、人工接管率、token/步数成本。

---

## 9. 复现命令

```bash
# 以下命令均以仓库根目录为起点（每行独立执行）
(cd desktop/desktop-agent && npm test)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run coverage)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:coverage -- --with-office)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:multi-app -- --wait-idle 90)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:real-app)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:lifecycle)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:visual -- --only calc,charmap,taskmgr)
(cd desktop/desktop-agent && DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:image)
(cd desktop/desktop-agent && npm run verify:vision)
npm run typecheck && npm run check:ipc

# Rust（本机 GNU：PATH 里要有 MinGW 的 windres / rc.exe；用例已可本地运行，见 §5.1）
(cd desktop/src-tauri && cargo check && cargo test --lib)

# Rust（MSVC）：CI job `rust-msvc` 自动跑，等价命令
(cd desktop/src-tauri && cargo test --lib --locked -- --test-threads=1)

# 登记 sidecar（默认 dry-run，不改文件）
(cd desktop/desktop-agent && npm run register:mcp)
```
