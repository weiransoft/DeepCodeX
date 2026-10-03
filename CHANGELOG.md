# 更新日志

本项目所有值得注意的变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（本版本暂无变更。）

## [0.4.3.1] - 2026-10-03

补丁版（三段版本号 0.4.3 之上的第 1 个补丁；后续改动按 0.4.3.2、0.4.3.3 递增）。

### Fixed
- **bash 工具调用（git/pip 等）超时卡死**（`879519b0`）：
  - `buildShellEnv` 注入 `GIT_PAGER=cat` / `PAGER=cat` / `GIT_MERGE_AUTOEDIT=no` /
    `DEBIAN_FRONTEND=noninteractive` / `PIP_NO_INPUT=1`，根治 git log/diff 进
    分页器、pip/apt 弹交互确认导致的无限等待；
  - 默认超时 `DEFAULT_BASH_TIMEOUT_MS` 10min → 2min；新增
    `settings.bashTimeoutMs` 与 `env.BASH_TIMEOUT_MS`（支持 "120s"/"2m" 后缀）
    可配置覆盖，下限钳制 60s；
  - 命令运行 10s/30s/60s 卡顿阶梯提示（"运行中，可 Ctrl+C 中断" 等），
    消除"无输出 = 已死"错觉。
- **read 工具查询 /tmp、/opt 等只读路径被路径牢笼误拦**（`73d5155d`）：
  P5TaskExecutor 权限钩子新增只读放行前缀（/tmp、/var/tmp、os.tmpdir()、
  /opt、/usr、/proc、/sys）——read 正常排查日志/安装包不再被拒；
  write/edit 越界仍严格拒绝。

### Added
- **busy 等待态持续闪动的存活指示器**（`143142cc`）：思考中/Reconnecting/
  命令执行中三类状态文案统一前置 braille spinner（120ms/帧），
  点字转 = 进程活着，点字停 = 真卡死；nowTick 心跳 500ms→120ms 对齐帧间隔。

## [0.4.3] - 2026-10-03

### 新增

- **安装脚本**：setup.sh 一键安装入口（`curl -fsSL …/setup.sh | bash`）——Release tarball（npm 模式）/ 源码构建（source 模式）双路径、`--force` 覆盖重装、`--tag` 版本锁定、非 root 自动切用户级 npm prefix（4cfa251d、372ddb5b）
- **安装脚本 — 老系统支持**：GLIBC 自动检测，CentOS 7 / RHEL 7（glibc < 2.28）自动下载 glibc-2.17 专用 Node 解压即用，nvm 源码编译降为兜底；非 ASCII 终端全链路国内镜像（npmmirror / ghproxy 多源择优 + 断点续传）（ec68568e、65c6d89a、974d3f81、c0cd9a11、088fe276）

### 修复

- **模型能力 — 长路径模型名**：注册中心长路径模型名（如 `ms/kpanda-global-cluster/public/qwen38-27b-awq`）剥离路径前缀后再匹配，修复 Qwen3 系识别 MISS 导致中间 system 消息未展平、上游 vLLM 400（`System message must be at the beginning`）（66641791、5a43ce0a）
- **CLI — 对话正文纯净**：compact 观测行（`[compact] compact_skip …`）与执行历史沉淀行（`[exec-history] 二期沉淀 …`）不再打印 stdout，统一改走结构化日志（compact.log / sediment.log JSONL）（ff695c8d、2f32673b）
- **P5 — 凭据守卫模板豁免**：`.env.example` / `.env.prod.example` / `*.template` / `*.sample` 不再误拦（安装引导 `cp .env.example .env` 依赖读取）；`.env` / `.env.prod` 等真实凭据文件继续拦截（636d4505）
- **LLM — "思考中"卡死**：Anthropic 通路流总超时此前只静默 abort，抛裸 AbortError 被误判为用户中断——上游无响应（Bad Gateway / ECONNRESET）时既不重试也无错误提示，UI 永远停在"思考中..."；现归一化抛 `LlmStreamIdleTimeoutError` 进可重试判定自动重连（对齐 OpenAI 通路语义）。同批：`retry-after` 头钳制 120s 硬上限防静默长挂、setTimeout 32 位溢出防御、控制命令判定容忍斜杠/空格形态（04014814）

## [0.4.2] - 2026-09-30

### 新增

- **Web — 执行计划卡片（A2UI）**：UpdatePlan 工具的计划在对话流渲染为专用卡片——头部进度统计（完成 n/m + 进行中步骤）、进度条、变更说明与任务清单（`[x]/[>]/[ ]` 三态图标 + 嵌套层级，进行中脉冲动画）；实时（tool_progress / 工具消息帧）与历史恢复三路同源归并为单一最新态卡片，无列表行的计划整段回退 A2UI 渲染保证信息不丢（bf026d4b）
- **Web — 后台任务通知卡片**：引擎后台命令完成/失败通知（`Background command … failed with signal …` + 日志尾切片）归并为专用卡片——红/绿状态徽标、命令等宽折叠、耗时/输出路径、失败日志尾默认收起；修复此前整段文本落入助手气泡导致命令换行碎裂、日志标签直接暴露的渲染缺陷（12899793）
- **Web — 思考中占位（萤火虫闪烁）**：轮次开始（发送消息 / 引擎 processing）立即上屏「思考中…」萤火虫错相呼吸闪烁占位气泡，首个思考/正文内容到达即替换；修复工具批次结束后新请求窗口期界面无任何指示、看似卡死的问题（12899793）
- **Web — 补充指令（steering）**：任务执行中发送的消息经模型意图分类，区分「立即注入当前任务」与「排队等待」双路径，注入以「指令注入」分隔条呈现（95d2efa7）
- **Web — 思考过程展示**：thinking/reasoning 经 llm_delta 独立通道透传，流式阶段渲染为可折叠「思考过程」（0a1715f5）
- **Web — 文件文本预览**：个人/共享区文件抽屉支持文本预览，宽屏双栏布局——预览在左展开、列表保留右侧（cb6fdc0d、82423901）
- **Web — 用户专属工作目录牢笼**：personalOnly 个人区强制 + 引擎 homeDir 按用户分离；多用户隔离机制（会话归属、私有历史注册表、个人文件区）（b66c9901、f066dbef）
- **Web — 类 DeepSeek 对话界面**：进程内引擎 + LDAP 登录 + A2UI 可视化渲染（79688340）
- **安装脚本**：全自动安装脚本 install.sh（Linux 兼容 + 国内镜像源）（740972bd）

### 变更

- **Web — 工具执行条目可读化**：工具结果 JSON 块改为纯文本渲染，原始 JSON 收进次级折叠；助手正文中引擎拼接的工具结果块可读化、双写同源块去重移除，消除页面大量转义 JSON（315b77c4、05eeaa56、7f0d4f0d、efcf6423、85bd61a2）
- **Web — 首次启动体验**：默认本地用户、登录后无会话自动新建首个对话、空白名单引导与内置 favicon（68b230b3、dd1b9f9b、60212c1b）

### 修复

- **Web — 文件预览崩溃**：列表态重渲染时 previewBody 惰性构造，preview 为 null 不再无条件读取 preview.path 崩溃（8bb6a5fd）
- **Web — 「我的文件」401 与路径显示**：401 统一收敛到登录页、个人区面包屑显示详细路径（personalRoot 经 realpath 归一）（30653d76）
- **Web — 个人模式会话**：历史会话恢复与新建对话 403（真实环境复现修复）（710c6304）
- **Web — 轮次状态**：同会话串行排队时旧轮次 done 帧误复位新任务「生成中」状态（26b77490）
- **Web — 会话注册表**：并发回写 tmp 文件名冲突——追加随机后缀保证唯一（99c13e4b）
- **Web — 文件抽屉**：空 path 缺省浏览个人区根目录（消除 400）；shared scope 个人区保护线（uploadDir 旁路风险强制修复）（94e72ec0、f4f0246c）

## [0.4.0] - 2026-09-10

（本版本记录待补充：该版本发布时未维护更新日志，可通过 `git log v0.3.1..v0.4.0` 追溯。）

[Unreleased]: https://github.com/weiransoft/DeepCodeX/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/weiransoft/DeepCodeX/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/weiransoft/DeepCodeX/compare/v0.3.1...v0.4.0
