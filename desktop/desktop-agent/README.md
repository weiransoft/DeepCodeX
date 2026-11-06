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
> 能力矩阵 7 项中 6 项实测 `supported:true`；`verify:gui` 受控窗口闭环 4/4 verified，
> `verify:real-app` 在**真实记事本**上完成「写入 → 保存 → 磁盘校验」闭环 3/3。
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
│             coords.mjs           坐标帧换算（图像像素 ↔ 屏幕坐标）+ 越界拒绝
│             pixel-signature.mjs  64×64 灰度签名差异（树不变时的动作验效）
│             tree-quality.mjs     实测树质量判定（good / sparse / deferred / empty）
│             bridge-lifecycle.mjs 桥生命周期（退避 / 崩溃窗口上限 / 僵死回收 / 稳定重置）
│             target-pick.mjs      写入落点选择（按可写面积，不按角色名——公式栏会骗人）
│             verifier.mjs         Observe→Act→Verify + STALE_REF + 有界重试
│             app-registry.mjs     应用注册表 / TTL 缓存 / 通道矩阵 / 质量回写
│             budget.mjs           步数·截图·token 原子预扣与熔断
│             telemetry.mjs        脱敏事件流
├── config/policy.default.json     默认策略（enabled=false）
├── scripts/probe.mjs              P0 探针（能力矩阵 / 枚举 / 真机只读观察）
│           coverage-report.mjs    真实应用 UIA 覆盖率采样（被动：当前桌面上的窗口）
│           verify-app-coverage.mjs 真实应用覆盖率矩阵（主动拉起固定清单，逐家给产品判定）
│           verify-gui.mjs         真机 GUI 闭环验证（受控 WPF 测试窗口）
│           verify-real-app.mjs    真实应用写入闭环（临时文件 + 记事本，磁盘校验）
│           verify-multi-app.mjs   真实应用写入矩阵（记事本/Word/Excel/资源管理器/Edge）
│           probe-app.mjs          单应用 UIA 结构探针（给新应用写用例前先看清它暴露了什么）
│           verify-lifecycle.mjs   桥生命周期真机验证（ping / 崩溃自愈 / 崩溃循环 / 优雅退出）
│           verify-visual-fallback.mjs 视觉兜底真机验证（坐标帧换算 / 越界拒绝 / 像素验效）
│           register-mcp.mjs       MCP 登记（dry-run / 写入 / 移除）
├── reports/p0-probe.json          P0 实测数据（窗口标题不落盘）
│           p1-gui-verify.json     真机闭环实测数据
│           p2-coverage.json       真实应用覆盖率实测数据（被动采样）
│           p2-app-coverage.json    真实应用覆盖率矩阵（16 个目标应用 / 逐家判定）
│           p2-real-app.json       真实应用写入闭环实测数据
│           p2-multi-app.json      真实应用写入矩阵实测数据
│           p2-lifecycle.json      桥生命周期真机实测数据
│           p2-visual-fallback.json 视觉兜底真机实测数据（计算器 / 字符映射表 / 任务管理器）
└── tests/*.test.mjs               node:test，零依赖（114 个用例）
```

零新增 npm 依赖（Node ≥ 22，ESM）：sidecar 需要随桌面端分发，避免版本漂移与供应链面。

## 快速开始

```bash
cd desktop/desktop-agent

npm test                           # 83 个单测（协议 / 策略 / 预算 / 验证 / 桥 / 生命周期 / 故障注入 / 树质量）
npm run probe                      # P0 探针（未开桥：仅 Win32 枚举）
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run probe          # 真机全能力探针
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run coverage       # 真实应用 UIA 覆盖率（只读，不执行动作）

# 真机 GUI 闭环：会短暂弹出 DCX-GUI-TEST-* 测试窗口，结束自动关闭
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:gui

# 真实应用写入闭环：打开自建的 dcx-e2e-*.txt，写入 → Ctrl+S → 读盘校验后删除
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:real-app

# 真实应用写入矩阵（5 家应用；需空闲桌面，--wait-idle 秒数用于等操作者离开键鼠）
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:multi-app -- --wait-idle 120

# 桥生命周期：ping 健康检查 → 强杀自愈 → 崩溃循环认输 → 优雅退出（会真的杀桥进程，仅验证用）
DEEPCODE_AGENT_UIA_BRIDGE=1 npm run verify:lifecycle

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

### 真实应用覆盖率（`npm run verify:coverage`）

覆盖率有两个脚本，回答的是不同问题，别混用：

| 脚本 | 方式 | 适合回答 |
| --- | --- | --- |
| `coverage-report.mjs`（`npm run coverage`） | **被动**：采样当前桌面上碰巧开着的窗口 | 「这台机器现在树好不好」 |
| `verify-app-coverage.mjs`（`npm run verify:coverage`） | **主动**：按固定清单逐个拉起、逐家判定 | 「我们支持哪些应用、其余怎么办」 |

主动矩阵跑 16 个目标应用（`--with-office` 含 Office），每个都用自建的空白/临时文件实例，
**只做 snapshot，不做任何写入或点击**，结束时只关自己拉起的进程。实测（空闲桌面，1 分 16 秒）：

| 应用 | 家族 | 最深质量 | 有名字可操作 | 产品判定 |
| --- | --- | --- | --- | --- |
| 记事本 | 经典 Win32 | good | 32 | 语义树 |
| 计算器 | UWP / XAML | good | 37 | 语义树 |
| 画图 | UWP 桌面桥 | good | 22 | 语义树 |
| 资源管理器 | Shell | good | 36 | 语义树 |
| Windows 终端 | 现代控制台宿主 | good | 7 | 语义树 |
| 设置 | UWP（AppFrameHost） | good | 32 | 语义树 |
| Word | Office 文档模型 | good | 6 | 语义树（正文靠 `TextPattern` 读） |
| Excel | Office 网格 | good | 223 | 语义树（`DataItem` 209 个，逐格可达） |
| Edge | 浏览器外壳 | good（仅外壳） | 8 | **DOM/CDP**，不走 GUI |
| 任务管理器 | Win32 现代 | sparse | 0 | 视觉兜底（见下节，已可真机验证） |
| 字符映射表 | Win32 对话框 | sparse | 1 | 视觉兜底（见下节） |
| 系统信息 | Win32 TreeView | sparse | 0 | 视觉兜底（同 taskmgr 形态） |
| 磁盘清理 | Win32 对话框 | sparse | 0 | 视觉兜底（同 charmap 形态） |
| 命令提示符 / PS 5 | 控制台子系统 | — | — | 环境受限，未采到（见下） |
| 性能监视器 | MMC | — | — | 需管理员会话 |

`summary.verdict = coverage-10plus`，`sampled = 13/16`：**8 家可按名字操作、4 家只能视觉兜底、
1 家必须走 DOM**、3 家未能拉起。均值 214 ms，最慢 Word 1249 ms（Office 树的采集成本是普通
应用的 4~8 倍，这是预算的真实约束）。

关键结论来自「完整度」而不只是「质量」：**13 家的最深样本全部 `complete: true`（cut = 0）**，
也就是说这些树在 depth 8 内已经看全了。所以那 4 个 `sparse` 不是「还没展开」，是
**真的没暴露可指认的目标**——视觉兜底对它们是真实需求，不是过早放弃。反过来，8 家
`good` 的应用在 depth 4 就已经 good，清单里没有出现 `deferred`，说明默认深度够用。

真机上踩到的八条（每条都改了代码，不是「记录一下」）：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | **`snapshot.truncated` 恒为 `true`**：桥无法证明自己没漏，于是永远回 true。用它判「看全没有」等于永远判 deferred | 完整度下沉到骨架节点：`Copy-Skeleton` 只给被剪掉孩子的节点打 `truncated`，再加节点预算 1500，两者都干净才算 complete（`treeCompleteness` / `assessSnapshot`） |
| 2 | **会误采别的应用**：拉起 PS 5 时桌面恰好弹出输入法安装器窗口，凭「只有一个新窗口」就把它当成目标采样，结论完全失真 | 认领窗口必须靠显式 `appIds` 白名单；匹配不上就继续等，不做「唯一新窗口」猜测 |
| 3 | **闪屏会换壳**：Office 先出现启动窗口，几秒后被主窗口替换，之后所有快照都是 `OBSERVATION_FAILED` | 认领到窗口后再 `resolveTarget` 一次（优先标题带文件名的），采样中途失败也重认领一次；实测 Word `264526 → 264962`、Excel `264970 → 330130` |
| 4 | **单实例应用根本没有新窗口**：任务管理器早就开着，再 spawn 只是聚焦旧窗口 | 回 `owned: false` 做只读采样，**收尾跳过关闭**——那不是我们拉起的窗口，不能动 |
| 5 | **UWP 的窗口不在自己的进程里**：计算器/设置的窗口属于 `ApplicationFrameHost.exe`，按 spawn pid 或应用名都认不到 | 白名单里带上宿主进程名；同时用「拉起前后 hwnd 差集」定位新窗口 |
| 6 | **控制台进程在这个执行环境里拿不到窗口**：`cmd`/`powershell` spawn 后立刻 `exitCode 0`，全程无窗口 | 记为 `launch-blocked`（附 `harnessNote`），**不是「应用不可自动化」**；控制台家族改用 Windows 终端覆盖（GUI 子系统，树正常） |
| 7 | **`EACCES` 不是「没装」**：性能监视器需要管理员权限，混记成 `app-not-installed` 会把排查方向带偏 | 单独判 `NEEDS_ELEVATION`，提示需在管理员会话运行 |
| 8 | **浏览器树 good 也只是外壳**：Edge 有 Tab/ToolBar/Button，但没有 `Document`/`Edit`，页面内容一个可操作节点都没有 | 按家族判 `dom-channel-required`：内容容器缺失即明确走 CDP，不因为「树 good」就以为能操作页面 |

> 这三个 `launch-blocked` 是环境与权限的真实边界，不是失败：报告把它们单独列在
> `launchBlocked` 里，而不是混进 `sampled` 充数。

被动采样（`npm run coverage`）仍保留，用于随手看一眼当前桌面。它此前把 4/5 判成
`sparse`（`gameviewer` 28 个可操作节点全无名字、`workbuddy` 整树 3 个节点）——这个
结论与主动矩阵一致：瓶颈不在「能不能拿到树」，而在「能不能按名字指认目标」。

### 视觉兜底：坐标帧与像素验效（`npm run verify:visual`）

上表那 4 家 `sparse` 应用以前只能拒绝（`CAPABILITY_UNAVAILABLE`）：树指认不了目标，
而「视觉兜底」缺两条腿——**点不准**、**验不了**。这一节把两条腿补上了，默认仍关闭。

**1. 坐标帧：图像像素 ≠ 屏幕坐标**

模型看的是截图，坐标是图像像素；输入 API 要的是屏幕坐标。两者差在原点（截图取的是窗口
矩形，不是整屏）和缩放（高 DPI 下同一块区域，截图 1250 px、UIA 矩形 1000 px）上。
不换算不是"点不准"，是**点到别的窗口**（R4 不可逆误动作）。所以：

- 桥侧 `screenshot` 回传 `rect`（窗口矩形，屏幕坐标）；`frame = rect + 图像尺寸` 一起进上下文；
- `desktop_click_xy` 默认 `frame: "window"`（x/y 是图像像素），内部换算成屏幕坐标；
- 换算后**越界一律拒绝**（`ACTION_DENIED`）：宁可这次不点，也不猜；
- 吸附发生在换算**之后**——树的 rect 在屏幕坐标系，先吸附会吸到错元素。

真机证据（计算器，窗口原点 (77,64)）：按树里「七」的 rect 算出图像 (98,688) → 工具换算成
屏幕 (175,752) → 显示区变成 7；再点「八」→ 78。少了原点那 77/64 px，落点会整体偏到别的键上。

**2. 像素验效：树不变时唯一还剩下的证据**

sparse 应用点击前后树一模一样，`observeState` 复观察拿到同一棵树，`expectChange` 恒 false
→ 每步都被判 `verify-failed`。现在坐标点击额外挂一条 64×64 灰度签名（4096 字节，5.5 KB
base64；一步取两次也不至于把 stdio 塞满），判据是"差异格数占比"，不是逐像素相等：

- 单格灰度差 ≤6 视为编码噪声；变化格数占比 ≤2% 视为光标闪烁/抗锯齿；
- 结构与像素**分开算再取或**，`verification.evidence` 如实标 `tree` / `tree+pixels`。

**3. 基线不稳定就不下结论**

界面还在渲染/动画时，动作前后的像素差**无法归因**——硬判就会把动画当成"生效"（假阳性）。
所以动作前连取两帧，两帧不同即标 `pixelStable=false`，`pixelChanged` 直接给 `null`、
退回结构证据（`pixelNote: "unstable-baseline"`）。

实测（`reports/p2-visual-fallback.json`，`verdict = visual-fallback-verified`）：

| 用例 | 目标 | 关键证据 | 判定 |
| --- | --- | --- | --- |
| 坐标帧 | 计算器（UWP） | 点「七」→ `显示为 7`；点「八」→ `显示为 78`；越界坐标回 `ACTION_DENIED` | `coordinate-frame-verified` |
| 稀疏像素验效 | 字符映射表（sparse，1 个命名节点） | 静止两帧 `identical`（400 ms 稳定）；点击后 `tree+pixels` 均变化 | `pixel-verify-works` |
| 稀疏像素验效 | 任务管理器（sparse，0 个命名节点） | **`treeChanged: false` + `pixelChanged: true`** | `pixel-verify-works` |

任务管理器那行是这一节的核心：树完全没变，只有像素通道能证明动作生效了。

真机上踩到的三条：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | **截图抓的是屏幕像素**：目标被别的窗口挡住，抓到的是遮挡物，before/after 量的是同一块别人的画面 | 新增 `activate`（默认 false，不抢焦点）：验效的基线帧必须先置前台；`observe` 的树为空兜底也自动开 |
| 2 | **窗口刚出现时还在渲染**：两帧静止画面差 84 格（2.05%），一开始误判「像素噪声太高」 | 不是阈值问题，是取样时机问题：先等连续两帧一致（实测 400 ms 内稳定），再取基线 |
| 3 | **像素签名不能按「截图」计费**：`maxScreenshots=3` 下，每步 2 次会让视觉兜底两步就熔断 | 签名不计截图预算（4 KB 灰度网格不是感知截图）；上界由 `maxSteps` 兜住（每步固定 2 次） |

> 这一节的执行侧已经闭环，但**模型侧**当时还断着：MCP server 只回 `{type:"text"}`，
> `packages/core` 的 `executeMcpTool` 也只保留 text，`includeImage` 回传的 base64 到不了模型。
> 下一节补的就是这一段。

### 把图喂给模型（`src/modules/mcp-content.mjs` + `packages/core/src/mcp/mcp-image-content.ts`）

坐标点击的前提是**模型真的看见了那张图**。之前协议层只承载 text，等于让模型凭树猜位置——
而"假装看过"是这类任务里最贵的一种错（它不会报错，只会点偏）。

现在的链路：

```
UIA 截图 ── base64 ──▶ splitImagePayload（拆文本/图像，base64 不进 text 块）
         ──▶ MCP 帧 content: [ {type:"text", 元数据}, {type:"image", data, mimeType} ]
         ──▶ core extractMcpImages（mime 白名单 / base64 校验 / 4 MiB / 单次 1 张）
         ──▶ follow-up user 消息（image_url data URL，visible:false）
         ──▶ messageConverter（multimodal=off 时仍会过滤掉 image_url，闸门没被绕过）
```

三条设计取舍：

| 取舍 | 原因 |
| --- | --- |
| base64 **只**出现在 image 块，text 块只留 `{mimeType, bytes, attached}` | 同一张图写两遍等于 token 花两遍；几十万字符 base64 会直接挤爆上下文 |
| 超限/坏 base64/非白名单 mime → 丢图**并显式标注** `dropped.reason` | 让模型知道"这次没给你像素"，它会重新截图或换通道；静默丢弃会让它继续瞎猜 |
| 图挂在 `role:"user"` 的 follow-up 消息上，不挂 `role:"tool"` | OpenAI 兼容接口的 tool 消息只接受文本；该通路与 ReadImage 完全一致 |

真机证据（`reports/p2-image-content.json`，`verdict = image-content-verified`）：

| 检查 | 结果 |
| --- | --- |
| 帧结构 | `content = ["text","image"]`，text 块内无 base64（`textCarriesBase64:false`） |
| 像素真实性 | image 解码出 PNG，IHDR 宽高 **666×1078** 与工具回传的 `width/height` 完全一致（53 356 字节） |
| core 消费 | 同一份帧过 `extractMcpImages` 得 1 张图；follow-up `role:user` / `visible:false` / data URL 与 base64 完全对应 |
| 遥测 | 事件流里没有 base64（图像不落事件、不落盘） |

```bash
npm run verify:image          # 需要 tsx（根 node_modules 已装）；缺 tsx 时退化为只验证协议帧
```

> 仍差最后一道闸：`allowScreenshot` / `allowCoordinateInput` 在壳侧 `harden()` 与 sidecar
> `hardenExternalPolicy()` 里都被**强制复位为 false**，所以桌面端目前没有任何路径能把视觉通道
> 打开（这是刻意的纵深防御，不是 bug）。开通它需要一个独立的高风险授权流程（IPC + 用户确认 +
> 审计），属于下一项，不在本节范围内——管线已通，闸门仍关。

### 树质量判定（`src/modules/tree-quality.mjs`）

分类器只能看进程名与窗口标题，猜不出 Electron 应用（各自有独立 exe 名，
进程名里没有 `electron`）。所以通道判定改为**观察后按实测树说话**：

| 判定 | 含义 | 处置 |
| --- | --- | --- |
| `good` | 有名字的可操作节点充足 | 走 a11y 树，按名字定位 |
| `sparse` | 树非空但指认不了目标 | 改判 `gui-visual`（视觉兜底需策略开启），否则明确拒绝 |
| `empty` | 树为空 | 同上，并自动附带 `emptyTree` 提示 |
| `deferred` | 节点预算耗尽，**还没看全** | 不改判，提示先 `drillDown` |

判定依据是桥回传的**完整树**（比骨架深 2 层），**完整度**则由 `treeCompleteness` 计算：
骨架节点上没有 `truncated` 标记、且节点数没到预算 1500，才算「看全了」。不能用
`snapshot.truncated`（桥侧恒为 true），也不能拿 `nodeCount` 猜——两者都会把
「树被深度截断」和「树本来就这么小」混为一谈，代价分别是要么永远下钻、要么把可下钻的
应用判死。判定结果会回写注册表（按 `appId#hwnd` 分别记录），`desktop_list_apps` 的通道列
即为实测结论。

> 一处自我修正：早期把 `taskmgr` 判 `sparse` 归因为「骨架截断造成的误判」。用完整度判据
> 复核后确认，它在 depth 8、树完整（cut = 0）时仍然只有 16 个 `Pane`、0 个有名字的可操作
> 节点——**它是真的不可按名字定位**，需要视觉兜底，而不是我们没看到。

### 真实应用写入闭环（`npm run verify:real-app`）

受控窗口证明「通道能用」，真实应用才证明「改动真能落到文件」。脚本在临时目录创建
`dcx-e2e-*.txt`，用记事本打开，写入 → `Ctrl+S` → **读磁盘校验**，最后关闭并删除临时目录。

三条硬守卫（宁可少测，不能误改用户文档）：

1. 窗口标题必须包含本次随机文件名；
2. 动作前编辑框内容必须等于基线文本，否则视为「别的文档」直接放弃；
3. 任一守卫失败即中止，不发送任何输入。

实测（`reports/p2-real-app.json`）：

| 步骤 | 通道 | 耗时 | 结论 |
| --- | --- | --- | --- |
| ValuePattern 写入真实应用 | `value-pattern-ref` | 239 ms | `verified`（状态真变） |
| 快捷键保存 | `keyboard` | 407 ms | `verified-no-change` |
| 关闭窗口 | `keyboard` | 417 ms | `verified` |
| 磁盘校验 | — | 7 ms | `persisted:true`、基线保留、73 字节 |

保存这一步暴露了验证器的假阴性：`Ctrl+S` 是幂等动作，界面本就不变，按「状态必须变化」
判会误报 `verify-failed` 并白重试 3 次。现在区分出 `verified-no-change`——**不谎报已变化**，
成效由副作用（文件内容）自证。

### 真实应用写入矩阵（`npm run verify:multi-app`）

记事本一家不足以说明「这套判据通用」。矩阵把同一套 Observe→Act→Verify + 副作用校验
推到不同家族的真实应用上，每个用例都只用**自建临时文件**：

| 用例 | 家族 | 写入通道 | 成功证据 | 实测 |
| --- | --- | --- | --- | --- |
| 记事本 / `.txt` | 经典 Win32 | `value-pattern-ref` | 读盘 | ✅ 40 B / 7 ms |
| Word / `.txt` | Office 文档模型 | `clipboard-paste` + TextPattern 校验 | 读盘 | ✅ 69 B / 1.7 s |
| Excel / `.csv` | Office 网格 | `clipboard-paste`（落点 = `DataGrid`） | 读盘 | ✅ 42 B / 1 ms |
| 资源管理器 / 重命名 | Shell 列表 | 选中 → `F2` → 输入 → 回车 | 文件系统改名 | ✅ `renamed` + `originalGone` |
| Edge / 本地 HTML | 浏览器外壳 | —（**策略拒绝**） | 不适用：浏览器应走 DOM/CDP | 按设计拒绝 |

一次完整跑（空闲桌面，`--wait-idle 90`）四家首轮全绿，无不稳定重试：

```
notepad-txt      write-verified  attempts=1  {"persisted":true,"length":40,"waitedMs":7}
word-txt         write-verified  attempts=1  {"persisted":true,"length":69,"waitedMs":1745}
excel-csv        write-verified  attempts=1  {"persisted":true,"length":42,"waitedMs":1}
explorer-rename  write-verified  attempts=1  {"renamed":true,"originalGone":true,"waitedMs":1}
edge-html        policy-blocked-browser      （策略层拒绝 GUI 驱动浏览器）
→ summary.verdict = multi-app-write-verified, writeVerified = 4/5
```

> 这些绿色**全部来自读盘/文件系统**，没有一条来自「界面看起来变了」。

跑出来的十二个真机坑，每个都改了代码或加进了判据：

1. **窗口标题不是身份**：Word 把 `xxx.txt` 显示成 `xxx - Word(产品激活失败)`，Excel 追加
   ` - Excel`。匹配改「进程名锁家族 + 含扩展名/去扩展名双重匹配」，随机文件名才是唯一性来源。
2. **首启引导会吃掉输入**：第一次开 Word 时标题已是文档名，但前面叠着「Microsoft 尊重你的隐私」，
   键盘输入全被它吃掉、`Ctrl+S` 什么也不发生——界面看起来对，实际没在编辑。
3. **`\b` 在中文字符后面永远不成立**（最贵的一个 bug）：判断按钮名的正则原来写成
   `/^(是|确定|保存|…)\b/i`。JS 的 `\b` 只认 `[A-Za-z0-9_]`，而「是」本身不算 word 字符，
   于是 `^是\b` 对 `是(Y)`、`确定`、`下一步`、`关闭` 全部返回 false，只有 `OK`/`Yes` 能过。
   后果是兜底逻辑跑了几十轮、一个中文按钮都没点过，而报告里只剩「`Ctrl+S` 返回 ok、磁盘没变」。
   改法：`(?![A-Za-z0-9])` 负向断言，CJK 与 ASCII 都对。
4. **老式 Office 对话框的按钮不是 `Button`**：实测「Word 上次启动失败 / 文件转换 / 是否将文档
   保存为这种格式」三处按钮的 `ControlType` 都是 **`Pane`**（名字是 `是(Y)`），子元素还常带
   0×0 的 `BoundingRectangle`。原来「只点 `role === Button`」的保守规则等于让兜底彻底失效。
   现在接受 `Button/Pane/Custom/Text/ListItem`，对话框作用域内不强制要求面积，点不动再退 `{ENTER}`。
5. **模态可能顶替主窗口成为目标**：「Word 上次启动失败」那个框标题就叫 `Microsoft Word`，
   按文件名永远匹配不到，却挡在文件加载前面。所以匹配分两阶段：先宽松（含 6 s 后接受
   应用家族任意窗口，交给 `settleDialogs` 答掉），再严格（必须是标题带文件名、且不是
   `文件转换/安全模式/受保护视图` 的壳）。
6. **答模态必须排在发 `ESC` 之前**：`ESC` 的语义是「取消」。屏幕上正挂着「文件转换 - xxx.txt」
   时先发 `ESC` 等于**取消打开这个文件**，后面所有动作都打在一个空壳上。
7. **应用内模态不在顶层窗口枚举里**：Word 存 `.txt` 会弹「是否将文档保存为这种格式?」，
   实测「本进程顶层窗口 = 1」——它是主窗口子树里 **depth 1 的嵌套 `Window`**，
   只看 `listApps` 会当成「没有对话框」。现在按树结构判定 + 把它接进「等磁盘」的循环里。
8. **`typeText` 不能拿 `paste` 抄近路**：桥里原来先试「焦点元素的 `ValuePattern`」。Excel 的
   焦点元素是**公式栏**（也是 `Edit`+`ValuePattern`），`SetValue` 返回成功、屏幕上什么都没变。
   现在 `paste: true` 是显式通道选择，直接走剪贴板，不再先试 `ValuePattern`。
9. **落点要按面积选，不能按角色名选**：Excel 树里同时有 `Edit 编辑栏`(1482×77) 与
   `DataGrid 网格`(1327×497)。「`Edit` 优先」会把内容打进公式栏。这条规则已抽成
   `src/modules/target-pick.mjs`，有 8 条单测（含这条回归）。
10. **窗口出现 ≠ 能输入**：冷启动时标题几百毫秒就出来了，但编辑面还没好——这期间点网格不
    建立选区、`^v` 被丢掉、`^s` 什么也不做，而每一步都返回 ok。现在按「目标角色连续两次
    快照都在」等就绪（Excel 实测 1.3 s），再动手。
11. **失败会自我强化**：保存没落盘 → 用例收尾强杀 → 下次启动弹「上次启动失败」→ 吃掉输入 →
    又失败。这就是同一份代码「单跑能过、全量跑不过」的来源。答模态 + 优雅收尾之后抖动消失。
12. **前台会被占用**：操作者正在用这台机器时，Windows 拒绝后台进程抢焦点
    （这是保护用户的正确行为）。用例先用一次无害按键做前台探测，拿不到就判
    `environment-busy` 跳过，而不是半途失败污染结论；`--wait-idle <秒>` 可等空闲再跑。

> 真机 GUI 验证必须在**空闲桌面**上跑：`npm run verify:multi-app -- --wait-idle 120`。
> 一边用电脑一边跑，结果会是 `environment-busy`，那不是应用不可自动化。
>
> 排查「界面看起来对、实际没生效」时加 `--debug-shots`：它会在「窗口 / 写入后 / 保存后」
> 三个阶段各留一张截图（写系统临时目录，不进仓库、不进报告）。这一轮两个最难的结论
> （Excel 打进公式栏、Word 保存确认框挂在那里）都是靠截图定性的。

### 单应用结构探针（`scripts/probe-app.mjs`）

给一个新应用写用例之前，先看清它到底暴露了什么——真机上最常见的失败不是「点不到」，
而是**以为点到了**：

```bash
DEEPCODE_AGENT_UIA_BRIDGE=1 node scripts/probe-app.mjs \
  --exe "C://Program Files//Microsoft Office//root//Office16//EXCEL.EXE" \
  --file C://tmp//x.csv --hint excel --type "hello" --save
```

它打印 role 直方图、候选落点（按面积）、树轮廓、`readText` 通道，可选地做一次
「点落点 → 粘贴 → `^s` → 每秒观察磁盘与本进程全部顶层窗口 / 嵌套模态」。
Excel 的「公式栏 vs 网格」、Word 的「保存确认框是 depth 1 嵌套 `Window`，按钮是 `Pane`」
都是靠它定性的。

### 故障注入（`tests/fault-injection.test.mjs`）

桌面操作最怕的不是失败，而是失败以错误形态出现。每条故障都锁死「错误码 / 可恢复性 / 是否交还」：

| 故障 | 期望 | 实测 |
| --- | --- | --- |
| 窗口中途关闭 | `OBSERVATION_FAILED` + `recoverable:true` | ✅ 不伪装成成功 |
| 目标进程崩溃 | `HANDOFF_REQUIRED` + `recoverable:false` | ✅ 禁止继续重试 |
| 观察阶段目标消失 | 结构化失败 + `hint` | ✅ 不抛原始堆栈 |
| 界面变化后复用旧 ref | `STALE_REF`，`outcome=stale-ref` | ✅ 不静默重取后继续点 |
| 动作无效果 | `VERIFY_FAILED` + `attempts` 可观测 | ✅ 有界重试 |
| 预算耗尽 | `BUDGET_EXCEEDED` 熔断 | ✅ 不无限重试 |
| 桥崩溃（请求在途） | pending 全部 `CAPABILITY_UNAVAILABLE`，桥引用与探测缓存复位 | ✅ 下一次调用自动重启新桥 |

### 桥的生命周期（`src/modules/bridge-lifecycle.mjs`）

「崩了下次调用再拉一个」在真机上是重启风暴的种子：UIA 在锁屏 / Secure Desktop /
会话切换下会连续抛异常，如果没上限，宿主会每 200 ms 拉起一个 `powershell.exe`，
既拿不到可用桥也刷满日志。现在生命周期由策略层接管：

| 场景 | 行为 |
| --- | --- |
| 首次启动 | 放行，无退避 |
| 崩溃后重启 | 指数退避 200 → 400 → 800 ms（上限 5 s），不会紧贴崩溃点重拉 |
| 120 s 内崩溃 ≥ 3 次 | **停止自动重启**，抛 `CAPABILITY_UNAVAILABLE` + `details.reason=bridge-crash-loop`，`desktop_capabilities` 如实报 `supported:false` + 可行动原因 |
| 连续存活 ≥ 60 s | 视为稳定，清空崩溃窗口（避免「几天里偶发崩 3 次」被误判成循环） |
| 连续 ping 失败 ≥ 3 次 | 判定「进程在但管道僵死」，回收桥，下次调用按退避重建 |
| stdin 已关闭 | 直接丢弃半死桥并重建一次，不让后续每个请求都立刻失败 |
| `close()` | 硬关闭（异常收尾）：立即放弃桥并 kill |
| `shutdown()` | 优雅关闭：先发 `shutdown` 让 PowerShell 主循环 break，超时才 kill；正常退出**不计入崩溃** |

`desktop_capabilities` 的 `bridge` 段落会带 `lifecycle`（`totalStarts` / `totalCrashes` /
`crashesInWindow` / `uptimeMs` / `lastCrash` / `lastPing` / `blocked*`），上层据此判断
「桥在抖」还是「环境真的不可用」，而不是靠重试次数猜。

真机实测（`npm run verify:lifecycle`，`reports/p2-lifecycle.json`）：ping 中位 **4 ms**、
ref 在 ping 后仍在（`storedRefs=3`）、两次强杀后均自愈（1.62 s / 1.81 s，含 PowerShell 冷启动）、
第 3 次崩溃后 `bridge-crash-loop` 且 **零新增 spawn**、优雅退出 **208 ms** 且进程确已消失。

### 同进程多窗口：必须用 hwnd

`explorer` 的桌面窗口与文件夹窗口共用同一个 PID，只按 `pid` 会稳定命错窗口：
修复前上表两个 explorer 行采到的是同一棵树（都是 46 节点），加上 `hwnd` 后分别是
46 与 3 节点。所有带 `appId` 的工具都支持 `hwnd`，桥侧按 HWND 精确解析，
`snapshot` 返回值也带 `hwnd`，调用方据此固定后续动作的目标窗口。

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
| `desktop_screenshot` | 只读 | 视觉兜底，默认关闭、不落盘；回传坐标帧 `frame`（可 `includeImage` 要像素） |
| `desktop_click_ref` | 写 | 按 ref 执行元素 invoke，走 Observe→Act→Verify |
| `desktop_click_xy` | 写 | 坐标点击兜底，默认关闭；`frame=window` 时按截图像素换算，越界拒绝，再吸附最近节点 |
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
2. **视觉兜底缺「喂图给模型」这一环**：坐标帧换算、越界拒绝、像素验效都已真机闭环
   （见「视觉兜底」一节），但 MCP 管线只承载 text content block，图片还到不了模型；
   定位模型接入前，`sparse` 应用默认仍拒绝（`allowCoordinateInput` / `allowScreenshot` 均为 false）。
3. **仅 Windows 有真实后端**：macOS AX / Linux AT-SPI 未实现，回落 mock。
4. **策略不热更新**：改开关 / 授权需重启引擎；壳侧 `platformPermissions.checkableByShell=false`，只给引导文案，不检测系统授权。
5. **未接线引擎生命周期**：桥进程自身的生命周期（退避 / 崩溃上限 / 僵死回收 / 优雅退出）已接管，
   但「随壳启停、壳侧重启上限、策略热更新」的 `AgentLifecycle` 仍属后续工作。
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
| `DEEPCODE_AGENT_BRIDGE_MAX_RESTARTS` | `3` | 120 s 窗口内允许的崩溃重启次数，超限即停止自动重启（`bridge-crash-loop`） |
