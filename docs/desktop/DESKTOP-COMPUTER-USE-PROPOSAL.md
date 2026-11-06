# DeepCodeX Desktop「桌面应用感知与操作」能力建设方案

| 项 | 内容 |
|---|---|
| 文档性质 | 调研结论 + 架构设计 + 落地路线（不含代码实现） |
| 日期 | 2026-11-06 |
| 适用范围 | `desktop/`（Tauri v2 壳）+ `packages/core`（Node 引擎）+ `packages/web/web`（前端） |
| 基线版本 | `c3ecefd`（已推送 `origin/main`），Desktop 0.1.0 / CLI 0.4.5 |
| 关联文档 | `docs/desktop/DESKTOP-ARCH.md`、`DESKTOP-PRD.md`、`scripts/check-desktop-ipc-contract.mjs` |

---

## 0. 结论摘要

**推荐选型：以「独立 sidecar 执行进程」为主干，编排留在 Node 引擎、特权收敛在 Rust 壳、感知采用「接口优先 → 无障碍树优先 → 视觉兜底」三级降级链。** 即：不把系统级感知/输入能力塞进壳或 WebView，也不把 GUI 执行直接下放给引擎的 `bash` 工具，而是新增一个可独立发布、崩溃隔离的 `desktop-agent` 进程，由壳负责拉起、授权与生命周期，由引擎负责规划与工具调度。

五个关键判断：

1. **行业共识是「接口优先、GUI 兜底」，不是「读屏点鼠标」**。WorkBuddy、Claude Cowork、TRAE 主路径都是连接器 / 命令 / 代码 / DOM，GUI 只是无接口时的最后手段；纯视觉路线（豆包虚拟桌面、Claude Computer Use API、UI-TARS）通用但慢、贵、易错。本方案应把 GUI 定位为**降级通道**，而非默认通道。
2. **感知层采用混合架构是 2026 年的生产实践**：无障碍树（Windows UIA / macOS AX）给确定性、低成本、抗窗口移动；截图 + 视觉定位只补自绘界面、游戏、Canvas 等无语义区域；两者做坐标吸附融合。只做视觉会复现 TRAE 社区反馈的「点不准、烧积分、必须前台」。
3. **必须遵守 desktop 既有安全红线**：`WebView 零特权`、`shell/fs/process/network 一律不暴露前端`。因此不能走「给前端加 Tauri 插件」这条捷径，能力只能经 Rust 命令或受控 sidecar 提供。
4. **可复用基础比想象中多**：`engine/manager.rs` 的进程/端口/Job Object/日志脱敏/崩溃重启、`check-desktop-ipc-contract.mjs` 的四方契约校验、`engine_fingerprint` 触发重启、SQLite 密钥库 + 环境变量注入、core 的 Plan / MCP / Skills / `UnderstandImage` / `PermissionMode`。**缺的是系统级感知与动作、GUI 编排闭环、按应用授权、可观测与成本治理。**
5. **当前不具备无人值守条件**：验证码 / 扫码 / UAC / 锁屏 / 敏感应用必须人工接管；第一目标应是「有人监督的半自动」，而不是「全自动接管电脑」。

明确不做（阶段 0–3 内）：UAC 提权自动化、验证码与登录绕过、敏感应用默认放行、驱动级输入注入、锁屏接管、虚拟桌面隔离、把 shell/fs 能力开放给 WebView。

---

## 1. 调研：同类工具的设计思路与能力边界

### 1.1 技术路线分野（本质差异）

| 路线 | 代表 | 怎么「动手」 | 优势 | 代价 |
|---|---|---|---|---|
| 接口/命令优先，GUI 兜底 | WorkBuddy、Claude Cowork、TRAE 主路径 | 连接器 / Shell / 脚本 / API / DOM | 快、准、可复现、省 token | 无接口的软件只能退化为看屏点击 |
| 纯 GUI 视觉操控 | 豆包虚拟桌面、Claude Computer Use、UI-TARS | 截图 → VLM → 坐标点击 | 通用，任何能渲染的界面都能碰 | 慢、坐标漂移、token 高、依赖视觉精度 |
| 代码生成执行 | AiPy（Python-Use）、Open Interpreter | 自然语言转程序再跑 | 批量文件、开放任务强 | 碰不了纯 GUI 软件 |
| 虚拟环境隔离 | 豆包虚拟桌面、Manus、CUA | AI 在自己的虚拟桌面/云机里操作 | 不抢键鼠、可后台长跑 | 碰不到本机真实登录态与文件 |
| 传统 RPA | UiPath、Power Automate、实在 Agent | 预设流程 + 录制回放 | 可审计、稳定、企业治理成熟 | 界面一变即失效，搭建成本高 |

**结论**：分水岭不是「能不能点鼠标」，而是「遇到没有 API 的老系统时，是否愿意退化为视觉识别」，以及「退化后是否还能验证动作结果」。

### 1.2 应用感知与定位

三条感知架构，失败方式互补：

| 架构 | 机制 | 强项 | 固有缺陷 |
|---|---|---|---|
| 纯视觉 grounding | 全屏截图 → VLM → `(x,y)` | 通用；覆盖 Canvas、游戏、远程桌面、自绘 UI | DPI/多显示器坐标漂移；窗口移动即失效；每步都要视觉推理；token 成本高 |
| OS 无障碍树 | UIA / AXUIElement / AT-SPI 遍历，输出 role/name/rect/ref | 确定性；按元素身份点击；窗口移动不影响；文本 token 极省 | Electron/Chromium 树残缺（需显式开启 a11y）；自绘控件、游戏、部分 Adobe 应用返回空树；大型窗口遍历 200–500ms |
| 双流混合（推荐） | 内存持有 a11y 快照 + 截图；VLM 预测坐标后**吸附到最近的 a11y bounding box** | 兼顾通用性与点击精度；失败可逐级降级 | 需要维护快照一致性与 ref 生命周期 |

可复用的工程经验：

- 稳定引用：`snapshot_id + element ref`，UI 变化时返回显式 `STALE_REF` 并触发重取，而不是按旧坐标盲点。
- token 治理：先取 `--skeleton` 骨架树，再按 root ref 下钻；只把需要的子树送进上下文。
- 局部观察：树遍历超时/深度预算耗尽时返回「已看到的部分 + 边界标记」，比硬失败更适合正在加载的实时 UI。
- 应用定位：窗口/进程枚举 + 句柄 + 前台状态。TRAE 实测的「必须保持目标页面前台、不能切 tab，否则乱切页面」说明**前台依赖是视觉路线的结构性缺陷**，而非调参问题。
- 硬边界：UAC 对话框在 Secure Desktop，普通截屏拿到的是变暗壁纸、输入注入打不进去；Windows 完整性级别（medium vs high integrity）限制跨级窗口访问；系统更新后 macOS 授权可能失效。

### 1.3 界面交互

- **两条动作通道**：无障碍 API 直接 `invoke`（不移动指针、不抢焦点，可在后台窗口操作）优于键鼠注入；键鼠注入（`SendInput` / `CGEvent`）是自绘界面的唯一手段，但会抢占用户。
- **占用策略**：TRAE Windows 用「正在操作电脑」遮罩明示占用；Claude Cowork 在 macOS 15+ 默认后台窗口、不接管指针、用户打字时等待；豆包用独立虚拟桌面彻底不抢键鼠。三者代表「明示占用 / 后台协作 / 完全隔离」三种取舍。
- **浏览器是独立通道**：DOM/CDP/扩展比像素读网页稳定得多。TRAE Browser Use 支持内置浏览器、外部 Chrome 扩展（复用登录态）、受信任域白名单、自动截图不耗 token；WorkBuddy 在读需登录网页时选择「复制一份带登录态的浏览器用户目录 + 临时调试端口」，**绕开截屏**。这是「接口优先」的典型例证。
- **权限即能力**：macOS 必须分别授予「屏幕录制」（看见）与「辅助功能」（动手），只给一项就只能做一半；Windows 无需单独授权但需遮罩提示。

### 1.4 任务编排

主流闭环是 **Observe → Act → Verify** 的单步循环，外层套 Plan / ReAct / 动态重规划：

- 分层职责（WorkBuddy 公开拆解）：交互入口 → 意图/规划/工具调度/执行监控与重规划 → 能力扩展（Skills / 专家 / MCP）→ 本地执行；数据状态层用 SQLite + jsonl 事件流 + traces/audit-log。
- **工具选择优先级**（Claude Cowork 官方口径「most precise tool first」）：连接器 → 浏览器 → 屏幕。这是成本控制的第一原则；TRAE 社区「本可看代码几步搞定却用了 Computer Use，烧掉 400+ 积分」正是违反该原则的代价。
- **流程沉淀**：WorkBuddy Skills / Playbook、豆包「演示一次录成技能」、OpenAdapt「确定性回放、健康运行不调用生成模型」、Stagehand「缓存 AI 生成的动作，页面没变就重放」。共同结论是**固定流程应退化为确定性脚本，只有变化流程才付模型推理成本**。
- **人工断点**：验证码、扫码登录、UAC、授权弹窗是共同停点。补救设计有两条：WorkBuddy 远程控制（手机实时看屏 + 点授权，单设备认证、加密通道、不存画面、不耗 token，目前仅 macOS）；豆包锁屏后继续运行。两者解决的都是「人不在电脑前」。
- **多 Agent / 长任务**：Team Mode、Agent 集群、Goal 模式（给目标与验收条件持续运行）属于编排增强，不是 GUI 能力本身。

### 1.5 权限控制

| 层次 | 行业做法 |
|---|---|
| 系统权限 | macOS 屏幕录制 + 辅助功能双授权；Windows 遮罩提示；缺一即降级 |
| 应用粒度 | 每次操作新应用弹确认，可「始终允许」形成白名单，可随时移除；TRAE `/Computer` 显式调用 |
| 动作粒度 | 有真实后果的动作（转账、提交表单、删文件、接受条款）要求人工确认 |
| 敏感面默认关闭 | Claude 对投资/交易/加密货币类应用默认禁用，支持应用黑名单；建议用户不要在敏感应用开启 |
| 环境与网络 | 官方建议专用 VM/容器最小权限、域名白名单、不向模型暴露账号登录信息 |
| 不可信输入 | 截图与 UI 文本会进入模型上下文 → 提示注入。Claude 用训练鲁棒 + 实时分类器扫描截图 + 持续红队三层防护 |
| 兜底硬拦截 | WorkBuddy 高危命令拦截 + 工作区白名单；DeepCodeX 现有 `checkDangerousBashCommand` 属同类 |

### 1.6 异常处理

- 可恢复异常：元素 ref 失效（`STALE_REF`）、窗口未就绪、树为空、点击无响应 → 重取观察 → 换通道 → 有界重试 → 升级人工。
- 不可恢复异常：验证码/登录、UAC 安全桌面、锁屏、目标应用崩溃、系统授权被撤销 → **明确认输并交还控制权**，不做无限重试。
- 验证闭环：每个动作后重新观察（树或截图）确认状态变化，避免「以为点到了其实没点到」累积成错误链。
- 成本熔断：单任务步数/截图次数/token 预算上限；TRAE 的 400 积分事件说明缺少预算可观测会直接变成用户信任事故。
- 可审计：事件流 + 回放 + 动作前后快照（注意脱敏），支持事后复盘与「为什么这么点」。

### 1.7 共性能力边界（必须写进产品预期）

1. 自绘界面、游戏、老系统无 a11y 树，只能靠像素，误读数字/位置是固有缺陷（TRAE 实测把「12 血」看成「17 血」）。
2. 单步秒级（实测 3–8s/步），十步任务常慢于人工；适合「人不在场、时间不值钱」。
3. 验证码、扫码、二次验证一律人工；最优策略是提前登录并保持会话。
4. 视觉路线通常要求目标窗口前台，不能并行切 tab。
5. 不可逆操作（删除、发送、提交）识别错即真实执行。
6. 行业判断：现阶段 GUI 操控**尚未达到可无人值守的商用标准**；固定流程用脚本/RPA，变化流程才用 Agent。

### 1.8 同类工具差异矩阵

| 维度 | WorkBuddy | TRAE（电脑控制 / Browser Use） | 豆包虚拟桌面 | Claude Cowork + Computer Use | 传统 RPA |
|---|---|---|---|---|---|
| 主路径 | 命令/脚本/连接器，GUI 兜底且入口深 | 代码与工具链；Computer Use 为独立插件 | 纯 GUI，明确不依赖 MCP/API/插件 | 连接器 → 浏览器 → 屏幕（精度优先） | 预设流程 + 录制回放 |
| 感知 | 多模态读图 + CDP 绕路，多轮任务中不主动截屏 | 整屏截图 VLM；自绘界面无树可用 | 通用 GUI 识别 | 截图 + 坐标（官方 toolset 17 个成员工具），另有独立 browser tool | 选择器/图像匹配 |
| 交互占用 | 本机接管；手机远程看屏点授权 | 本机接管，Windows 遮罩；需保持前台 | 独立虚拟桌面，不抢键鼠 | macOS 15+ 后台窗口，不接管指针 | 通常占用前台 |
| 编排 | 四层 Agent + Skills/Playbook + 多 Agent | SOLO / Agent 模式，插件显式调用 | 演示录制成技能，锁屏续跑 | 「最精确工具优先」+ 逐应用确认 | 固定流程图 |
| 授权粒度 | 工作区白名单 + 高危拦截 + 远程单设备认证 | 按应用「始终允许」+ 受信任域 | 系统级 GUI 权限 | 按应用授权 + 敏感应用默认禁用 + 黑名单 | 企业级角色与审计 |
| 主要短板 | 指令精度要求高、积分不透明、浏览器入口深、远程仅 macOS | 点击失败率高、乱切页面、积分消耗失控、锁屏仅非 Intel Mac | 慢、免费版限制、虚拟环境无本机登录态 | 多为积木/API，无成品工作流；明确「无沙箱」 | 界面变化即失效 |

### 1.9 信息可靠性说明

- WorkBuddy 官方文档口径为：自然语言交互、自主规划与执行、多模态任务、授权后本地文件操作、多任务并行、结果交付与验收；扩展靠专家/技能/连接器/资料库。官方文档**未描述** Computer Use 架构。
- 网络上流传的「Native Bridge Runtime / WASM 技能沙箱 / 本地 Qwen-1.5B 推理 / 基于某开源框架」等架构拆解缺乏官方来源，且与「模型调用走云端、技能为 SKILL.md 文档」的口径矛盾，本方案**不予采信**。
- TRAE 电脑控制的权限、遮罩、始终允许、锁屏限制来自其官方文档；前台依赖、点击失败、积分消耗来自官方社区实测反馈。
- 竞品处于高频迭代期（2026-10 起远程控制、锁屏运行、双端融合密集上线），能力边界需按季度复核。

---

## 2. 现状：desktop 架构与集成约束

### 2.1 架构事实（代码依据）

- **薄壳 + 本地引擎**：Rust 壳是唯一特权层，唯一职责是拉起并监护 `node cli.js web --host 127.0.0.1 --port <动态端口>` 子进程；唯一 `boot` WebView 从 `boot.html` 导航到该 HTTP origin。所有 AI 与工具执行都在 Node 引擎。
- **最小权限面**：`capabilities/default.json` 仅授 `core:default` / `core:webview:default` / `window:allow-start-dragging` / `allow-app-ipc`；`permissions/app-ipc.toml` 白名单 18 条命令，注释明确「shell / 文件 / 进程 / 网络能力一律不暴露给前端」。
- **四方契约校验**：`scripts/check-desktop-ipc-contract.mjs` 校验 `ipc.rs` 定义集 = `lib.rs` `generate_handler!` 注册集 = ACL 授权集 = 前端调用集，且进 `npm run check` / CI。**新增任何命令必须同步改 4 处**。
- **零系统级依赖**：`Cargo.lock` 无任何 `tauri-plugin-*`；`windows-sys` 仅启用 Foundation / Security / JobObjects / Threading。全仓库无窗口枚举、截图、UIA/AX、输入注入、全局快捷键代码。
- **跨平台与构建**：当前用 Rust GNU + MinGW（无 MSVC、非管理员），`crate-type = ["staticlib","rlib"]`（去掉 `cdylib` 以规避 MinGW `export ordinal too large`）；`capabilities` 只授 `boot` 标签窗口，而 `window_new` 创建 `main-<ts>` 标签，多窗口能力授权需实测复核；`tauri.conf.json` 无 CSP / asset protocol / plugins 段；引擎仅绑 `127.0.0.1`，`engine_credentials` 有严格 origin 三元组校验。
- **发布**：`bundle.targets = ["app","dmg","nsis"]`；`desktop/` 不在 npm workspaces 内，`tauri.conf.json` / `Cargo.toml` / `desktop/package.json` 三处版本号手工同步。

### 2.2 可复用资产清单

| 现有资产 | 复用方式 |
|---|---|
| `engine/manager.rs`：动态端口、`wait_healthy`、状态机、崩溃自动重启（≤3 次）、Job Object / `CREATE_NEW_PROCESS_GROUP`、密钥脱敏日志泵 | 直接作为 **sidecar 进程生命周期模板** |
| `engine/port.rs` + 回环 HTTP 探针 | sidecar 健康探针与端口分配 |
| `ipc.rs` 的 `parse_origin` / `is_engine_origin` / `require_local_engine_origin` | sidecar 控制面 origin 校验，防跨 origin 调用 |
| `config_persist.rs` 的 `engine_fingerprint` + `config_save` 自动重启 + `navigate_to` | 能力开关/授权变更后的「保存即生效」 |
| `secrets/store.rs` SQLite + 环境变量注入（`DEEPCODE_API_KEY` 等）+ `redact` 清单 | sidecar 令牌、敏感配置注入与日志脱敏（需扩展脱敏字段） |
| `desktop.json` 模型/MCP/LDAP 配置 + `desktopConfig.ts` / `SetupWizard` | 新增「应用授权列表」「能力开关」设置 UI 的现成范式 |
| `packages/core` 的 `UpdatePlan` / `agent` / `AskUserQuestion` / `skill` / MCP client | 编排层与人工确认交互，无需另造 |
| `UnderstandImage` + `MULTIMODAL` + `ReadImage` | 消费视觉兜底产出的截图（现有缺口只是「没有采集环节」） |
| `PermissionMode(manual/auto/bypass)` + `checkDangerousBashCommand` 硬拦截 + `PermissionScope` | 权限骨架；需扩展「按应用/按 GUI 动作」维度 |
| `check-desktop-ipc-contract.mjs` + CI | 新命令的一致性保障 |

### 2.3 能力差距

| 能力 | 现状 | 差距性质 |
|---|---|---|
| 系统级感知（窗口枚举、a11y 树、截图、OCR） | 完全缺失 | 从零建设，含平台两套实现 |
| 系统级动作（元素 invoke、键鼠注入、焦点控制） | 完全缺失 | 从零建设 |
| GUI 编排闭环（观察→动作→验证、稳定 ref） | 完全缺失 | 新增模块 |
| 按应用 / 按动作授权、敏感应用黑名单 | 缺失（`PermissionScope` 只到文件/命令/网络粒度） | 模型扩展 |
| 动作审计、回放、成本预算与熔断 | 缺失 | 新增模块 |
| 提示注入防护（截图/UI 文本进模型上下文） | 缺失 | 新增安全层，且是上线阻塞项 |
| 人工接管点（授权框/验证码/后台监督） | 缺失 | 新增交互 |
| 浏览器独立通道（CDP / 扩展 / 受信任域） | 仅有依赖用户自配的 `browser-automation` skill | 需产品化 |
| 多窗口 capability 授权有效性 | 未验证 | 阶段 1 前置核查 |

### 2.4 硬约束（决定选型）

1. **安全模型不可动摇**：WebView 零特权；任何系统 API 必须经 Rust 命令或受控特权进程，且过 ACL + 四方契约校验。
2. **MinGW GNU / 无 MSVC / 非管理员 / 无 cdylib**：主壳不宜链接大量 Windows GUI crate（历史上已因导出符号过多失败）；新增依赖须验证 GNU 兼容。
3. **引擎只绑回环 + origin 严格校验**：sidecar 数据不能跨 origin 直连 WebView，须走引擎 HTTP 或壳命令。
4. **无 CSP / asset protocol**：截图/图标若要在前端展示，需自行设计传输通道（Rust 命令返回字节 / 引擎静态托管 / 启用 asset protocol），且要防敏感画面落盘。
5. **三处版本号手工同步 + desktop 不在 workspaces**：发布流程需补检查项。

---

## 3. 候选方案对比与推荐选型

### 3.1 三个候选

| 候选 | 做法 | 改动面 |
|---|---|---|
| **A. 引擎侧 MCP / Skill 直连** | 引入现成 desktop-automation MCP server（Windows-MCP / agent-desktop / OpenOwl 等），经现有 `McpManager` 暴露工具；感知与动作全在外部进程 | 零 Rust 改动、零 ACL 改动；仅配置与 skill |
| **B. Rust 壳内原生实现** | 在 `src-tauri` 新增 UIA/截图/输入 crate，新增一组 `tauri::command`，前端直接调用 | `ipc.rs` / `lib.rs` / ACL / 前端 4 处 + Cargo features + capabilities + 平台双实现 |
| **C. 独立 sidecar 进程（推荐）** | 新增 `deepcode-desktop-agent` 可执行进程，内部实现感知/动作/验证/策略；壳只负责拉起、监护、授权与开关；能力经 MCP（或引擎工具族）暴露给 Node 编排层 | 壳新增 3–5 条命令（生命周期/状态/授权）+ 四方契约同步；sidecar 独立编译发布 |

### 3.2 对比矩阵

| 评价维度 | A | B | C |
|---|---|---|---|
| 落地速度 | 最快（天级） | 最慢 | 中（周级） |
| 与「WebView 零特权」红线一致性 | 中：特权实际下放到引擎侧 MCP 进程，脱离壳的 ACL 视野 | **低**：需扩大壳的 IPC 面，触碰设计红线，须安全评审 | **高**：特权收敛在独立进程，壳只看生命周期 |
| 崩溃隔离 | 差：MCP 进程异常可能拖垮引擎会话 | 差：系统 API 在壳进程内，崩溃即整个桌面端退出 | **好**：sidecar 挂掉不影响壳与引擎 |
| 按应用授权 / 遮罩 / 焦点策略 | 弱（依赖 MCP server 自身） | 强 | **强**（策略在 sidecar，UI 在壳） |
| 跨平台维护 | 由第三方 MCP server 承担，但受其平台覆盖限制 | 最重：Win/macOS 两套代码进主壳 | **较轻**：平台实现隔离在 sidecar，可独立编译（甚至按平台预编译分发） |
| MinGW / 无 MSVC 风险 | 低（外部运行时） | **高**：大量 Windows crate 链进主壳，易复现 `export ordinal too large` | 低：主壳不新增系统依赖 |
| 可观测 / 回放 / 预算治理 | 弱 | 中 | **强**：sidecar 可做结构化事件流与回放 |
| 供应与运维 | 依赖用户自配 Python/Node 环境，版本不可控 | 自持 | 自持，随包分发 |
| 长期演进 | 上限低 | 上限高但耦合重 | **上限高且解耦** |

### 3.3 推荐：**C 为主干 + A 作为阶段 0 探针 + B 的最小必要部分**

**取舍依据**

- 排除 B 作为主干：现有架构把「Rust 壳 = 唯一特权层、WebView 零特权」写进设计红线，18 条 ACL 与 CI 契约校验都是为「小命令面」设计的。把窗口枚举、截屏、输入注入做成前端可调用的 IPC 命令，等于把高噪声、高权限、平台强相关的能力嵌进壳，既放大攻击面，又与 MinGW 链接约束正面冲突。
- A 不作最终形态：它把特权执行下放到引擎侧 MCP 进程，绕过壳的 ACL 与 origin 校验，无法承载「按应用授权、遮罩、崩溃隔离、审计回放」这些产品级要求，且依赖用户自配外部运行时。但它**零改动、能最快产出真实数据**，因此作为阶段 0 的探针（验证目标应用的 a11y 树覆盖率、视觉兜底命中率、单步耗时与 token 基线）最划算。
- 选 C：**复用 `manager.rs` 已经写好的一切**（端口、状态机、Job Object、脱敏日志、崩溃重启），壳只需新增少量生命周期/授权命令；能力以 MCP 或 core 工具族形式进入既有编排层，不改动 Plan / Skills / 权限模式；sidecar 独立编译，避开主壳的 GNU 链接风险；出问题时可单独降级或关闭，不影响桌面端主流程。

**在 C 内部再定三条设计结论**

1. **编排在引擎，执行在 sidecar，授权在壳**：模型不直接与 OS 对话；`core` 负责「选哪条通道、拆几步、何时重试」，sidecar 负责「怎么看见、怎么动手、怎么确认」，壳负责「允不允许、是否开着、崩了是否拉起」。
2. **三级降级链**：① 已有接口/连接器/CLI/文件系统（现有能力）→ ② 浏览器 DOM/CDP 通道 → ③ 桌面 GUI（a11y 树优先，视觉兜底）。每一级都要有明确的「升级条件」与「退回收敛条件」，避免 TRAE 式的「本可一步完成却启动 Computer Use」。
3. **感知双通道但默认不用视觉**：默认 `snapshot`（结构化、省 token、抗窗口移动）；仅当树为空 / 目标为自绘区域 / 需要像素级校验时才 `screenshot`；两者在 sidecar 内做坐标吸附融合。

### 3.4 明确不做（写进范围，防止范围蔓延）

不做 UAC 提权自动化、验证码与登录态绕过、敏感应用默认放行、锁屏后台接管、驱动级输入注入、虚拟桌面隔离、把 shell/fs/process 开放给 WebView、为「全自动无人值守」做承诺。

---

## 4. 整体集成设计

### 4.1 分层与数据流

| 层 | 所在进程 | 职责 |
|---|---|---|
| L1 交互层 | WebView（引擎页） | 任务发起、能力开关、按应用授权面板、进度/观察结果展示、人工接管与紧急停止 |
| L2 编排层 | Node 引擎 `packages/core` | 意图理解、Plan、工具选择（三级降级链）、步数与预算控制、重试/重规划、AskUserQuestion 人工确认；复用现有 `UpdatePlan`/`agent`/`skill`/MCP |
| L3 能力契约层 | 引擎侧 MCP client / 新增 `desktop.*` 工具族 | 统一工具语义：`list_apps`、`snapshot`、`screenshot`、`click_ref`、`click_xy`、`type`、`key`、`wait_for`、`verify`；屏蔽平台差异 |
| L4 执行层 | `deepcode-desktop-agent` sidecar | AppRegistry / Perception / Actuator / Verifier / PolicyGuard / Telemetry |
| L5 特权与治理层 | Rust 壳 `src-tauri` | sidecar 生命周期、系统权限引导、授权策略持久化、能力开关、`engine_fingerprint` 触发重载、ACL 白名单 |
| 数据/控制通道 | 回环 HTTP + 短期令牌 或 stdio MCP | 令牌与密钥一样经环境变量注入、不落盘、加入日志脱敏清单；截图/树数据默认不落盘，允许落临时目录时须自动清理与脱敏 |

**数据流（一次动作）**：用户在 L1 发起 → L2 判定走哪级通道 → L3 发出结构化工具调用 → L4 取观察（树或截图）、由 PolicyGuard 校验授权、执行动作、再观察验证 → 结构化结果 + 事件回 L2 → L1 展示。壳（L5）不参与每一步，只在授权变更、开关切换、进程异常时介入。

### 4.2 三级降级链的决策规则（设计结论）

| 级别 | 触发条件 | 手段 | 失败后 |
|---|---|---|---|
| ① 接口优先 | 目标有 API / 连接器 / CLI / 文件 / 已有 MCP | 现有 core 工具，零 GUI 成本 | 无对应能力 → 降 ② |
| ② 浏览器通道 | 目标在浏览器内 | CDP / 扩展 / 受信任域白名单，复用登录态 | 需登录/验证码 → 转人工；非浏览器目标 → 降 ③ |
| ③ 桌面 GUI | 无接口且为目标桌面应用 | a11y 树 snapshot + 稳定 ref；树为空/自绘 → 视觉定位并吸附到最近 a11y 节点 | 连续 N 次验证不通过 / 预算耗尽 → 停止并交还用户 |

### 4.3 进程与通信

- **拉起与监护**：完全复用 `engine/manager.rs` 的模式——动态回环端口、两轮启动重试、`wait_healthy`、状态事件、崩溃自动重启上限、Windows Job Object `KILL_ON_JOB_CLOSE` / Unix `setsid + killpg`、逐行脱敏日志泵。sidecar 与引擎是**两个独立被监护对象**，不要复用同一个状态机实例以免互相牵连。
- **鉴权**：参照 `engine_credentials` 的 origin 三元组精确校验 + 短期令牌（随进程生成、经环境变量注入、不落盘）。禁止 WebView 跨 origin 直连 sidecar。
- **能力暴露**：优先以 MCP server 形态接入（引擎已有 `McpManager`），这样 L2 不用改工具注册；若性能需要，再补一条引擎 HTTP → sidecar 的直连通道。
- **能力开关与授权**：新增到 `desktop.json`（非机密）与 `desktop-secrets.db`（令牌/敏感项）；变更经 `engine_fingerprint` 判断是否重载；沿用 `config_save` 的「保存即生效」体验。
- **新增 IPC 面（最小化）**：建议仅 4 条——`desktop_agent_status`、`desktop_agent_toggle`、`desktop_agent_permissions_get/set`、`desktop_agent_open_system_permissions`（macOS 引导）。全部同步 `ipc.rs` / `lib.rs` / `app-ipc.toml` / 前端调用，跑 `npm run check`。**不新增任何执行类命令**。

### 4.4 权限与授权链路

1. 系统权限引导：macOS「屏幕录制 + 辅助功能」分别检测与引导；Windows 用遮罩提示（复用 `window_new` / 自绘遮罩思路）。
2. 应用白名单：首次操作某应用弹确认，可「始终允许」写入 `desktop.json`，可随时移除；敏感分类（金融/加密/医疗/政企）默认禁用并支持黑名单。
3. 动作分级：只读观察（树/截图）与写入动作（点击/输入/提交）分开授权；不可逆动作（发送、删除、提交、支付）强制逐次确认，且不受「始终允许」豁免。
4. 与现有 `PermissionMode` 对齐：GUI 动作映射到 `manual / auto / bypass` 三态的语义一致；`bypass` 下**仍保留硬拦截**（对齐 `checkDangerousBashCommand` 的设计哲学）。
5. 提示注入：截图与 UI 文本标记为不可信内容；进入模型前做规则过滤/区域遮蔽，动作前校验目标是否在授权应用与允许动作集内；不可逆动作二次确认。这是**上线阻塞项**，不能靠模型自觉。

### 4.5 与现有模块的接线点

| 现有模块 | 接线方式 |
|---|---|
| `lib.rs` `DESKTOP_BRIDGE_SCRIPT` / `desktop-bridge.ts` | L1 授权面板与状态展示复用桥，新增少量只读/配置命令 |
| `ipc.rs` / `lib.rs` / `app-ipc.toml` / `check-desktop-ipc-contract.mjs` | 新增 4 条命令，四方同步 + CI |
| `config_persist.rs` `engine_fingerprint` / `config_save` | 授权与开关变更触发 sidecar 重载 |
| `secrets/store.rs` + `manager.rs` `redact` 清单 | sidecar 令牌/截图元数据脱敏 |
| `packages/core` `McpManager` / `UpdatePlan` / `UnderstandImage` | MCP 接入、编排、视觉兜底消费 |
| `docs/desktop/DESKTOP-ARCH.md` | 同步更新安全模型章节（新增特权进程说明） |

---

## 5. 关键模块职责划分

| 模块 | 层 | 职责 | 主要依赖 | 复用的现有资产 | 新建/改造 |
|---|---|---|---|---|---|
| `AgentLifecycle` | L5 壳 | sidecar 拉起/健康/停止/重启上限/崩溃隔离/版本校验 | `engine/port.rs` | `engine/manager.rs` 全套 | 新建（照模板） |
| `CapabilityPolicy` | L5 壳 | 能力开关、应用白名单/黑名单、动作分级、系统权限引导、授权持久化 | `desktop.json` / secrets.db | `config_persist.rs`、`config_save`、`engine_fingerprint` | 新建 + 改造配置结构 |
| `DesktopIpc`（4 条命令） | L5 壳 | 状态/开关/授权读写/系统权限引导，origin 校验 | `parse_origin` | `ipc.rs` 授权范式、四方契约校验 | 新建（小） |
| `DesktopToolset` | L3 | 统一 `desktop.*` 工具语义、参数校验、平台差异屏蔽 | MCP / core tools | `McpManager`、`registerToolHandlers` | 新建 |
| `TaskOrchestrator` | L2 | 三级降级链选择、Plan、步数/预算、重试与重规划、人工确认 | `core` | `UpdatePlan`、`agent`、`AskUserQuestion`、`PermissionMode` | 改造（扩展策略） |
| `AppRegistry` | L4 | 应用/窗口/进程枚举、句柄与焦点状态、完整性级别判定 | Win32 / AX API | 无 | 新建 |
| `Perception` | L4 | a11y 树 snapshot（骨架+下钻、稳定 ref、局部观察）、screenshot、OCR、双流坐标吸附融合 | UIA / AX / 截屏 API | `UnderstandImage`（消费侧） | 新建 |
| `Actuator` | L4 | 元素 invoke 优先、坐标点击兜底、键盘/文本/快捷键、前台策略与遮罩 | 输入注入 API | 无 | 新建 |
| `Verifier` | L4 | 动作后观察比对、`STALE_REF`、超时、有界重试、收敛判定 | Perception | `wait_healthy` 思想 | 新建 |
| `PolicyGuard` | L4 | 执行前二次校验应用/动作授权、不可逆动作拦截、危险动作硬拦截 | CapabilityPolicy 同步的策略快照 | `checkDangerousBashCommand` 哲学 | 新建 |
| `Telemetry & Replay` | L4 | 结构化事件流、动作前后快照（脱敏）、回放、token/步数成本统计 | 本地临时存储 | `manager.rs` 脱敏泵、`engine.log` | 新建 |
| `Handoff` | L1+L2 | 验证码/UAC/授权框等人工接管、远程看屏（后期）、紧急停止 | 现有 Web UI | `AskUserQuestion`、`SetupWizard` | 后期新建 |

**职责红线**：L2 不碰 OS API；L4 不做任务规划；L5 不执行具体 GUI 动作；L1 不直接连 sidecar。

---

## 6. 安全与稳定性风险

| # | 风险 | 影响 | 缓解措施 | 上线阻塞 |
|---|---|---|---|---|
| R1 | 提示注入：截图/UI 文本含恶意指令，诱导点击、填表、下载 | 高危，可造成真实世界动作 | 不可信内容标记 + 规则/区域遮蔽 + 动作前策略校验 + 不可逆动作二次确认 + 事件审计；不依赖模型自觉 | **是** |
| R2 | 敏感信息泄露：截屏含密码、聊天、令牌；回放/日志落盘 | 隐私与合规 | 默认不落盘；必要时临时目录 + 自动清理；脱敏清单扩展到截图元数据；授权应用粒度的画面采集；敏感应用默认禁用 | **是** |
| R3 | 越权：新 IPC 面被跨 origin 调用 / capability 多窗口授权不确定 | 绕过 ACL | 复用 `engine_credentials` 的 origin 三元组精确校验；新命令全部只读/配置类；阶段 1 先实测 `main-<ts>` 窗口的 capability 生效情况 | **是** |
| R4 | 不可逆动作误执行（坐标漂移、DPI、多显示器、窗口切换） | 真实损失 | a11y 优先 + 坐标吸附 + 动作前预演 + 动作后验证 + 幂等设计 + 强制逐次确认 | **是** |
| R5 | UAC 安全桌面 / 完整性级别 / 锁屏 / 授权失效 | 任务静默卡死 | 明确检测并「认输交还」，不做无限重试；启动时做权限自检并给出可操作引导 | 否（需可诊断） |
| R6 | sidecar 崩溃、树遍历超时、进程僵死 | 桌面端功能不可用 | 独立进程 + Job Object/进程组 + 崩溃重启上限 + 超时预算 + 局部观察；sidecar 故障不影响壳与引擎主流程 | 否 |
| R7 | 前台占用与用户体验（抢键鼠、乱切页面） | 用户信任 | 元素 invoke 优先（不抢焦点）；明示遮罩；用户键鼠活动时暂停；可紧急停止 | 否（体验门槛） |
| R8 | 成本失控（单步秒级、截图 token、无预算重试） | 信任事故（TRAE 400 积分事件） | 三级降级链 + 骨架树下钻 + 增量截图 + 步数/截图/token 预算上限 + 熔断 + 成本可见 | **是** |
| R9 | 平台与构建：MinGW GNU 无 MSVC、无 cdylib、非管理员 | 编译失败 / 无法安装 | sidecar 独立编译，主壳不新增系统 crate；按平台预编译分发；不依赖提权；验证新增依赖的 GNU 兼容性 | 否（阶段 1 前置验证） |
| R10 | 多平台一致性：Win UIA 与 macOS AX 覆盖率差异、WebView2/WKWebView 差异 | 能力不对等 | 平台能力矩阵显式声明；降级策略按平台可配置；Windows 先行、macOS 后续 | 否 |
| R11 | 发布与契约：4 处命令同步、三处版本号、desktop 不在 workspaces | CI 失败 / 版本漂移 | `npm run check` 已在 CI；新增发布检查项核对三处版本号与 sidecar 版本 | 否 |
| R12 | 第三方平台风控（微信等自动化封号） | 账号风险 | 敏感/强风控应用默认禁用并在 UI 明示；不做绕过登录与验证码 | 否（产品策略） |

---

## 7. 落地优先级与阶段划分

| 阶段 | 目标 | 交付物 | 验收标准（可度量） | 依赖 / 退出条件 |
|---|---|---|---|---|
| **P0 探针** | 用最小代价拿到真实数据，验证「接口优先 + 树优先」是否成立 | 外部 desktop-automation MCP 接入样例（候选 A）；目标应用清单与 a11y 树覆盖率报告；单步耗时/token 基线；能力边界清单 | 选定 5–8 个目标应用，逐个记录树是否可用、需视觉兜底的比例、单步中位耗时；形成「哪些场景不该走 GUI」的负面清单 | 零 Rust 改动、不进主分支；产出「继续 / 调整 / 停止」结论 |
| **P1 主干（Windows 优先）** | 建成 sidecar 主干与最小壳侧接线 | `desktop-agent` v1（AppRegistry + a11y snapshot + 元素 invoke + Verifier + PolicyGuard 基础）；壳 4 条 IPC + 四方契约同步；应用授权 UI；`desktop.*` MCP 工具族 | 单应用内完成「打开 → 定位元素 → 动作 → 验证」闭环；按应用授权生效；sidecar 崩溃后自动拉起且壳/引擎不受影响；`npm run check` 全绿；确认 `main-<ts>` 窗口 capability 行为 | 依赖 P0 结论；MinGW/sidecar 编译验证通过；R1–R4、R8 的缓解措施随阶段落地 |
| **P2 可靠性与治理** | 把「能跑」变成「可控、可查、可停」 | 视觉兜底 + 双流坐标吸附；浏览器 CDP/受信任域通道；稳定 ref 与 `STALE_REF`；事件流/回放/成本统计；预算熔断；人工接管与紧急停止；截图脱敏与临时清理 | 连续 N 步任务的动作成功率与误操作数为可接受基线；不可逆动作 100% 触发确认；超预算自动停止；敏感信息不落盘；可回放一次完整任务 | P1 稳定运行；R1/R2/R8 完成验收 |
| **P3 跨平台与生态** | 扩平台、沉淀流程、减少重复推理 | macOS AX + 屏幕录制/辅助功能引导；Skills/Playbook 固化固定流程；后台窗口/不抢键鼠策略；可选的远程看屏监督 | macOS 与 Windows 能力矩阵对齐；固定流程重放不调用生成模型；用户可边用电脑边让 Agent 在后台窗口操作 | P2 指标达标；明确不承诺锁屏无人值守 |
| **暂缓 / 不做** | 虚拟桌面隔离、UAC 自动化、验证码绕过、锁屏接管、驱动级注入、无人值守承诺 | — | — | 成本高、风险与收益不匹配，待 P3 后单独评审 |

**优先级排序依据**：先验证「值不值得做」（P0，成本最低）→ 再建「不破坏现有安全模型的可扩展骨架」（P1，架构风险最高，必须早做）→ 再补「可靠性与治理」（P2，决定能否给用户用）→ 最后「平台与生态」（P3，边际收益递减）。把视觉兜底放在 P2 而非 P1，是因为它成本最高、失败最多，且 P1 的树优先闭环足以验证架构正确性。

---

## 8. 度量与验收基线（建议纳入 P2 看板）

- **感知**：a11y 树可用率、视觉兜底触发率、单次 snapshot 延迟与 token 数。
- **动作**：按元素 invoke 占比（越高越好）、单步成功率、`STALE_REF` 重取率、验证不通过率。
- **编排**：三级通道分布（接口/浏览器/GUI 占比）、平均步数、重规划次数、人工接管次数。
- **成本**：单任务 token / 截图次数 / 墙钟耗时，超预算熔断次数。
- **安全**：不可逆动作确认覆盖率、敏感应用拦截命中、脱敏检查通过率、提示注入演练通过率。
- **稳定性**：sidecar 崩溃与自动恢复次数、任务中断率、壳/引擎零回归。

---

## 附录 A 术语

- **CUA（Computer-Use Agent）**：通过屏幕感知与键鼠动作操作图形界面的智能体。
- **a11y 树 / UIA / AX / AT-SPI**：操作系统为屏幕阅读器维护的控件语义树，Windows 为 UI Automation、macOS 为 Accessibility(AXUIElement)、Linux 为 AT-SPI。
- **Grounding**：把「要点的东西」映射到具体坐标或元素引用的过程。
- **稳定 ref / STALE_REF**：快照内元素的确定性引用；界面变化后旧引用失效的显式错误。
- **Observe-Act-Verify**：观察 → 动作 → 复观察确认的单步闭环。
- **sidecar**：与主应用并列运行、职责单一、可独立崩溃与重启的辅助进程。

## 附录 B 主要参考来源（2026-11-06 检索）

- WorkBuddy 官方文档《WorkBuddy 简介》（核心能力、扩展方式、结果交付）。
- TRAE / TraeWork 官方文档《电脑控制(Computer Use)》《Trae Browser Use》（权限、遮罩、始终允许、锁屏限制、受信任域）。
- TRAE 官方中文社区实测帖（前台约束、点击失败、积分消耗、自绘界面用例）。
- Anthropic 官方文档《Computer use tool》《Let Claude use your computer in Cowork》《Best practices for computer and browser use》（toolset 成员工具、安全风险、提示注入分类器、工具优先级、按应用授权）。
- 第三方横评与实测：《新皮层》三产品 Computer Use 对比、远程控制与锁屏运行报道、桌面 Agent 路径分野分析。
- 技术资料：Windows-MCP / agent-desktop(UIA 树、稳定 ref、局部观察、token 治理)、2026 桌面 GUI Agent 感知架构综述（纯视觉 / a11y 树 / 双流混合）、桌面自动化 MCP 服务器对比。
- 本地依据：`docs/desktop/DESKTOP-ARCH.md`、`desktop/src-tauri/src/{lib,ipc,config,config_persist}.rs`、`engine/manager.rs`、`capabilities/default.json`、`permissions/app-ipc.toml`、`scripts/check-desktop-ipc-contract.mjs`、`packages/core/src/settings.ts`、`tools/executor.ts`。

> 注：竞品能力处于高频迭代期，第三方实测存在版本差异；本方案的**设计结论不依赖任何单一产品的实现细节**，仅依赖多条来源一致印证的能力边界。
