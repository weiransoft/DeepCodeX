# 更新日志

本项目所有值得注意的变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- **DEFAULT_MAX_TOOL_ROUNDS 从 12 提升到 40**（packages/core/src/eag/p5/executors/llm-task-executor.ts）：
  部署类目标（ssh 远程+构建镜像+推送+启动容器+curl 验证）需要几十步工具调用，
  12 轮结构性不足导致连续相同失败后熔断 abort。三重安全网：拒绝风暴 6 次熔断 /
  相同调用 3 次熔断独立于轮数上限生效、自然终态任务 5-12 轮即结束、编排器 token
  预算（200K）闸门独立拦截。
- **failure() 签名扩展：失败路径同样结算累计 tokens**（packages/core/src/eag/p5/executors/llm-task-executor.ts）：
  新增 `sawUsage / realTokens / estimatedChars` 三参数，与成功路径同构走
  `resolveTokensUsed` 结算。旧实现硬编码 `tokensUsed: 0` → RunState 在
  "达到轮数上限熔断"等 failure 路径下 tokensUsed=0。
- **编排器 totalLlmCallCount 用 artifacts.llmRequests 直接累加**（packages/core/src/eag/p5/autonomous-orchestrator.ts）：
  替代旧方案 `if (result.tokensUsed > 0) { totalLlmCallCount += 1; }` 近似估算。
  旧方案两个缺陷：multi-request dev/fix 严重低估（n 轮只计 1 次）、failure()
  路径 tokensUsed=0 导致本轮 llmCallCount 被跳过。totalExecutorLlmRequests
  审计字段保留同源累加。

### Fixed
- **verify 阶段 "0 passed, 0 failed, exitCode=0" 误判 success**（packages/core/src/eag/p5/handlers/verify-stage-handler.ts）：
  旧判定 `exitCode===0 && failed===0` 未检查 passed 数量，node --test 对空目录、
  无 test 脚本的 npm test 等场景 exitCode=0 但 passed=0 被误判为"测试全部通过"。
  修复：testPassed 条件增加 `&& testStats.passed > 0`，空测试场景区间进 skip
  降级（与 exitCode≠0 的 noTestsCollected 对称）。
- **bash 后台任务 marker 残留**（packages/core/src/tools/bash-handler.ts appendOutputFile）：
  原实现在 child.on('data') 时直接 fs.appendFileSync 原始 chunk（含 `__DEEPCODE_PWD__`
  marker 行），依赖 close 事件触发时 stripMarker + writeFinalBackgroundOutput 覆写
  最终文件。风险场景：close 事件没触发（detached 进程被外部 kill）或覆写失败
  （磁盘满/权限）时 outputPath 永久残留 marker 行。修复：appendOutputFile 改为
  按行缓冲，检测到 marker 前缀的行时跳过持久化——双保险：close 正常触发时覆写
  幂等，close 不触发时文件里也没有 marker 行。
- **Web EA-03a 集成测试修复**（packages/web/tests/eag-web-sedimentation.test.ts）：
  旧测试依赖 0.4.3.11 改造前已删除的 tryDeterministicEagExecution 确定性正则通道。
  改造后触发层统一 LLM 决策（EagDynamicSuggester），确定性通道已删除：
  - 注入组 decisions 数组为空 → suggester 脚本耗尽默认返回 direct_chat →
    编排器永不启动 → run-state 文件不创建 → 20s 超时。修复：decisions 注入
    正确的 execute_command JSON（含 confidence: 0.95 过阈值校验）。
  - 基线组（eagEnabled=false）自然语言第二轮输入 → suggester=undefined →
    触发层门禁不成立 → 直入主对话流式通道消费脚本。修复：第二轮输入改显式
    `/eag-autonomous --goal "..."` 斜杠命令（eagCommandParser 在建议器之前
    拦截 → 分发到 handleEagAutonomousCommand → fail-closed 推送「未注入」文案）。

## [0.4.3.11] - 2026-10-07

补丁版（EAG 选卡劫持修复 + Web 会话注册表 sessionId 去重 + React setState 竞态修复）。

### Fixed
- **EAG 选卡劫持：动态任务 ID 取代固定 T-001 编号**（packages/core/src/eag/p5/handlers/plan-stage-handler.ts）：
  `SYNTHESIZED_TASK_ID = "T-001"` 硬编码常量导致每次目标合成的任务卡都用同一编号，
  `tasks.md` 中多张 pending 卡共享 ID 时 `pickNextPendingTask` 退化为文件序选择 →
  最早追加的旧卡永远压在本次目标卡前面，形成"空循环"（每轮为旧目标空烧 2×12 轮工具调用后熔断 abort）。
  修复：新增 `generateSynthesizedTaskId(cards)` 扫描现有最大 `T-xxx` +1 生成唯一编号；
  `alreadySynthesized` 检测同步从 `c.id === SYNTHESIZED_TASK_ID` 改为扫描 `requirementId === "AUTO"` 且
  标题为 objective 子串的卡（语义等价，移除固定 ID 依赖）。
- **Web 会话切换串显：React setState flush 与 Promise microtask 竞态**（packages/web/web/src/App.tsx openChat）：
  `setEntries([])` 排入 React 18 更新队列（macrotask flush），但 `fetchMessages().then` 的函数式 setState
  回调在 microtask 阶段先执行 → `prev` 读到的是 flush 前旧会话 entries → 去重合并分支混入旧消息。
  修复：then 回调内直接 `setEntries(history)` 不读 prev，彻底绕过 React 批处理竞态窗口。
- **Web 注册表同 sessionId 多 chatId 脏条目**（packages/web/src/chat-registry.ts upsertUserChat）：
  `createChat` remount 每次生成新 chatId 并 upsert，但旧 chatId 同 sessionId 条目不清理 →
  `~/.deepcode/web/chats/<userId>.json` 累积 5 组以上多 chatId 共享同一底层 sessionId 的冗余记录。
  修复：upsertUserChat 内当新条目 sessionId 非空时，同表内过滤掉 sessionId 相同但 chatId 不同的旧条目
  （原子读→过滤→写在一次调用内完成，并发 remount 不丢数据）。

## [0.4.3.11] - 2026-10-06

补丁版（EAG 触发层 LLM 化——第一次/第二次指令统一经 LLM 意图识别 + 任务动态规划，不再依赖关键字/规则命中）。

### Changed
- **触发层统一 LLM 决策（`handleEagIntentResolution` 取代"确定性正则通道 + 建议器自动执行"两层结构）**：
  每次非豁免用户输入只做一次 `EagDynamicSuggester.suggest()` 决策调用，由 LLM 结合
  建议快照（指代识别依据）、运行终态历史（知情重试判定依据）、澄清答案（refine 上下文）
  直接输出七种 action：
  - `execute_command`：第一次指令——LLM 判定意图充分时输出裸 `/eag-` 命令 + 独立 goal
    字段（任务动态规划），消费侧守卫（D2）→ `buildAutoExecuteCommand` → 派发；
    派发失败降级展示并存逃生门快照
  - `confirm_previous`：第二次指令——"执行这个"类确认语义由 LLM 结合快照上下文识别
    （原 `ANAPHORA_CONFIRM_PATTERN` 短语正则删除），消费快照显式重放
  - `suggest_command` / `suggest_autonomous` / `suggest_graph`：**仅展示不再自动执行**
    （原 Plan B"suggest_* 且 /eag- 前缀 → 自动执行"取消），存快照供下一轮确认消费
  - `ask_clarification` / `direct_chat`：澄清流程与主对话语义不变
- **删除的规则匹配点**：`EAG_AUTONOMOUS_KEYWORD_PATTERN` /
  `EAG_AUTONOMOUS_INTENT_PREFIX_PATTERN` / `EAG_INTENT_NEGATION_PATTERN` /
  `ANAPHORA_CONFIRM_PATTERN` / `ANAPHORA_CONFIRM_NEGATION_PATTERN` /
  `GOAL_TERMINAL_MARKERS_PATTERN` / `GOAL_EXECUTABLE_VERBS_PATTERN` /
  `GOAL_TECH_KEYWORDS_PATTERN` / `hasExecutableIntent` / `isPureTerminalStatusLabel`
  及 `tryDeterministicEagExecution` / `matchDeterministicEagAutonomousCommand` /
  `tryAnaphoraConfirmExecution` / `tryAutoExecuteSuggestedCommand` 四个通道方法
- **失败守卫升级（D2 决策：硬拦截 + LLM 知情确认）**：0.4.3.10 数据层资产全部保留
  （`autonomousGoalRuns` 落盘 / 指纹归一化 / 30 条淘汰）；运行终态历史注入决策上下文，
  LLM 判定用户明确知情重试时输出 `acknowledgeFailedGoal: true` 直接放行；无法确认知情
  且目标命中失败记录时仍硬拦截（提示 + 逃生门快照）；"执行这个"逃生门语义不变
- **降级语义（D1 决策）**：决策 LLM 不可用 / 输出非法 / 置信度不足时一律 `direct_chat`
  走主对话，不自动执行——**不保留任何正则兜底**
- Prompt 重写：`buildEagSuggestionPrompt` system 开场白改为"触发层统一决策助手
  （意图识别 + 任务动态规划）"，新增目标有效性判定（终态状态标签禁令）、指代确认判定、
  否定语义判定、知情重试判定四组 LLM 判定规则；web 侧 `classifyNonStreamingRequest`
  决策通道路由标记同步
- 结构化豁免（`/continue` / 待答 / 权限回复 / bypass）、`pendingEagClarifications`
  澄清流程、P5 重入守卫、`plan-stage-handler.ts extractRelevanceTokens`（D4）均不动

### 测试
- 新增 core `session-eag-llm-trigger.test.ts`（T1-T5/T9-T17：execute 派发与快照一次性、
  direct_chat 主对话、confirm_previous 一次性消费、澄清清快照、D1 降级、状态标签/否定
  语义、/eag-build 防御降级逃生门、非 EAG hint 降级、澄清 refine 执行、P5 重入守卫、
  派发失败降级、建议器未注入、prompt 四区块注入）全绿
- 重写 `session-eag-goal-failure-guard.test.ts` 通道级用例（execute_command 决策路径
  硬拦截 / 知情确认放行 / 逃生门三元组）全绿
- 扩充 `eag-dynamic-suggester.test.ts`（execute/confirm_previous 解析校验 7 用例：
  参数内嵌 hint 剥离、goal 空白降级、acknowledgeFailedGoal 透传、上下文注入不破坏链路）
  全绿
- 删除 `session-f9v2-deterministic-execution.test.ts`（确定性正则通道已移除，场景迁移）
- 设计文档：`docs/research/2026-10-eag-llm-intent-trigger.md`（§8 实现偏差留痕：
  suggest()/buildEagSuggestionPrompt 名称保留、T10 改防御降级、T15 改派发失败场景）
- 回归：core 4 runner（src/tests 704 例 / team / providers / v2）+ web 242 例全绿
  （`session-lifecycle-init` notify 轮询与 v2 FW-12 file-watcher 在多套件并发时存在
  与本次改动无关的时序抖动，单跑复验通过）

### Fixed
- **Web「思考过程见上方折叠区」死链**（web-thinking-display.md §5 追补）：纯 thinking
  轮次固化后 thinking 折叠块消失、提示语指向不存在的折叠区。修复：`assistant_message`
  固化时前端保留流式累积的 thinking（内存级，引擎/历史不持久化，刷新后不可回放）；
  ChatPane 固化分支在正文上方渲染默认收起的「思考过程」折叠块；空内容兜底提示按
  有无 thinking 分档（历史恢复降级为「本轮无文本回复」，不再死链）。顺带修复
  App.tsx 历史恢复路径 filter 谓词收窄导致的存量 TS2322 类型错误

## [0.4.3.10] - 2026-10-06

补丁版（EAG 触发层跨 run 失败守卫——失败目标不再被自动重放空转）。

### Fixed
- **触发层跨 run 失败守卫（2026-10-06 第二条指令空转事故复盘）**：
  `/eag-autonomous` 以 aborted/failed 终态结束后，运行结果不落盘，下一条短指令
  （"继续"）被建议器双通道把同一历史目标重新炒成 suggest_autonomous 无条件自动
  执行 → 逐字重演上一轮的空转。修复方向为**触发层识别、不进入空循环**（而非
  in-loop 熔断跳出）：
  - 写侧终态落盘：`SessionEntry.autonomousGoalRuns`（可选字段，旧会话文件零迁移）
    记录每次自主运行的目标指纹 + 终态（`recordAutonomousRunOutcome`，同指纹
    upsert、容量上限 30 淘汰最旧；handleEagAutonomousCommand 三个终态位置全覆盖）
  - 读侧三通道拦截：建议器通道（`tryAutoExecuteSuggestedCommand` 新增
    `degraded-goal-failed` 变体，goal 参数与 commandHint 内嵌 `--goal` 双源判定）、
    确定性通道（`matchDeterministicEagAutonomousCommand` 经
    `blockFailedGoalAutoExecute` 拦截）、Web 注入通道
    （`session-pool.scheduleAutoExecuteSuggestion` 跳过自动注入）；命中均推送
    可见拦截说明，绝不静默吞掉
  - 逃生门：拦截后回复"执行这个"经指代确认通道显式知情重放放行；completed
    目标不拦（合法重放）；显式手输 `/eag-autonomous` 不拦
- 设计文档：`docs/research/2026-10-eag-auto-loop-trigger-guard.md`（含 git 考古：
  方案B `5b0884da` 移除触发层全部准入确认是根因引入点）
- 测试：新增 core `session-eag-goal-failure-guard.test.ts` 8 用例（指纹归一化/
  写侧 upsert/三通道拦截/completed 放行/逃生门/零回归）全绿；web
  `eag-web-sedimentation.test.ts` 新增 EA-03c 跨 run 失败守卫集成用例（播种
  sessions-index → 建议回合 → 拦截帧 + 零注入 + 零执行器请求）全绿

## [0.4.3.6] - 2026-10-03

补丁版（Web 白屏防护——渲染崩溃不再整页卸载 + CLI 版本解析容错）。

- 修复：Web 前端「工具执行完成后整页瞬间全白」——新增根级 React 错误边界
  （`AppErrorBoundary`），任何组件渲染期异常不再卸载整棵组件树，
  改为显示可自解释的降级页（错误详情 + 重新加载按钮，会话历史服务端持久化不丢）
- 修复：`getPackageJson()` 对 4 段版本号（0.4.3.x）抛严格 semver 异常——
  `read-package-up@12` 内部 normalize-package-data 校验失败会炸死所有 CLI 命令
  （含 --help），现包 try/catch 回退编译期常量 `CLI_VERSION`
- 测试：新增 `tool-render-crash-regression.test.tsx` 白屏回归（真实引擎工具
  结果 JSON 块全链路 SSR 零异常、ChatPane 混合条目渲染、双写同源去重、
  humanizeEngineContent 极端输入永不抛异常）

## [0.4.3.5] - 2026-10-03

补丁版（TUI 冻死防护——SSH 卡死/终端销毁不再拖死后台任务）。

### Fixed
- **TTY 冻死防护（新增 packages/cli/src/utils/tty-guard.ts）**：
  Ink 渲染与 stdio-helpers 直接 `process.stdout.write` 在 SSH 劣化/伪终端
  销毁场景下会把事件循环拖入背压写黑洞（渲染 tick 持续入队 → LLM 网络 IO
  饿死 → 表象"TUI 冻死"），或 EPIPE/EIO 冒泡终结进程。现于进程入口安装
  stdio 守卫：通道写异常（EPIPE/EIO/EBADF）吞噬并进入静默降级，渲染路径
  只消费不再投递，后台任务（LLM 请求、工具执行）继续运行；持续背压
  （1.5s drain 超时）同样降级；每 10s 用零宽字符探测终端复活，SSH 恢复
  自动复显；流级 error 事件与 uncaughtException 兜底吸收通道错误，进程不崩。
- **循环心跳落盘（断点 resume 定位）**：core/session.ts 的 appendSessionMessage
  每向会话 jsonl 追加一条消息即以 fsync 落一行心跳到独立
  `<sessionId>.jsonl.heartbeat`（绝不混入会话文件，--resume/--fork 零污染）。
  进程被杀/OOM/断电后可精确回答"卡死发生在第几条消息之后"；
  tty-guard 提供 readHeartbeatResumeHint 解析断点（半行损坏容错）。
- 回归测试：新增 tty-guard.test.ts 8 用例（透传/EIO 静默/EPIPE 回调消化/
  非通道错误维持抛出/销毁流安全/幂等/心跳解析×2）全绿。

## [0.4.3.4] - 2026-10-03

补丁版（4 段版本号导致 CLI 启动即死——紧急修复）。

### Fixed
- **getPackageJson 解析异常不再炸穿启动路径**：read-package-up@12 内部
  normalize-package-data 对 4 段补丁版本号（0.4.3.2 起）抛严格 semver 校验异常，
  旧实现只处理"未找到 package.json"分支，导致 --help 在内的所有 CLI 命令启动即崩。
  现将 readPackageUp 整体纳入 try/catch，异常与未命中统一回退编译期常量
  CLI_VERSION（经 semver 形状过滤），CLI 任何命令均可正常启动。
- **build 链刷新编译期版本常量**：packages/cli build 前执行
  scripts/generate-git-commit-info.js，修复 CLI_VERSION 长期停留旧值 0.4.3、
  --version 显示与实际发布版本不一致的问题。
- 回归测试：新增 package-version-fallback.test.ts（正常路径/异常兜底/
  缓存路径/常量形状 3 用例全绿）；`deepcode --version` 实测输出 0.4.3.x。

## [0.4.3.3] - 2026-10-03

补丁版（thinking 长思考期状态行零进展——"卡死"观感修复）。

### Added
- **CLI 状态行渲染思考尾行**：reasoning 模型前 100-250s 只推 `reasoning_content`、
  正文 preview 恒空时，状态行追加 `· 思考 <尾行>`（换行折叠单空格、保留最新片段、
  按终端宽度图簇裁剪严格单行）——长思考期肉眼可见推进，不再只靠 token 计数
  判断存活。渲染规则：正文 preview 满足原门槛（>1500 token 且 ≥80 列）时
  preview 优先（零回归）；终端 <50 列或宽度未知时不渲染尾行；纯空白/超短
  thinking 回落原状态行。
- 回归测试：loading-text.test.ts 新增 5 用例（尾行渲染/门槛与窄终端回落/
  preview 优先/1MB 级推理折叠单行/空白回落），21/21 全绿。

## [0.4.3.2] - 2026-10-03

补丁版（eag 自主循环"假死"事故复盘四项修复；事故链：不可完成目标 × 只读执行器
→ 12 轮空转 ×3 熔断 abort → 全程主会话零输出 + 终态不回写 = 用户端"永久卡死"表象）。

### Fixed
- **计划阶段能力预检（修复#3）**：`detectShellCapabilityGap` 对 objective 合成
  任务卡路径检测远程执行/软件安装/容器编排/系统服务/数据库变更五类 shell 语义，
  命中即 plan 阶段 fatal 拒绝并给出"退出自主循环改主会话执行 / 改写为纯代码产出"
  建议——不再烧 3 轮 × 12 次 LLM 调用才熔断（远程装 K3s/部署 MySQL 类目标
  第一秒即被诚实拒绝，tasks.md 不落盘）。
- **eag 进度回写主会话（修复#4）**：`AutonomousRunRequest.onIteration` 回调 +
  session.ts 装配——每轮迭代 4 阶段摘要（✓/✗ + 截断文本 + 连续失败计数）实时以
  assistant 消息 append 主会话；回调异常被吞并记 warn，绝不反噬主循环。
  abort/completed 终态回写链路（updateSessionEntry + onAssistantMessage）经核验保持完整。
- **verify 空测试误判 failed（修复#5）**：合成任务 + 默认 npm test 且输出
  0 passed/0 failed/0 skipped 时诚实降级 `unverified/skipped`（bio-vlab 类
  无测试脚本项目不再累加 consecutiveFailures）；手写任务卡与自定义测试命令
  仍如实 failed（V4 契约不放宽）。
- **拒绝风暴 fail-fast（修复#6）**：P5TaskExecutor 连续 6 次工具调用被权限守卫
  拒绝即终止并报醒目根因（"拒绝风暴：……超出 P5 执行器能力"），不再静默烧满
  12 轮报"工具循环达上限"；任何一次成功调用即清零计数。
- **凭据守卫被只读放行通道架空（E9 调试中新发现，真实 deny 静默失效）**：
  项目根位于临时目录（沙箱/单测布局）时，牢笼内 `.env*` 路径同样命中
  os.tmpdir 只读放行前缀 → 凭据 deny 全程未触发。现只读放行仅限牢笼外路径，
  且凭据 basename 判定前置于路径牢笼，两种路径形态拦截行为一致。

### Added
- 回归测试：`eag-p5-stall-fixes.test.ts`（G1-G6 能力预检 / V1-V3 空测试降级 /
  O1-O2 进度回写回调）+ `eag-p5-llm-executor.test.ts` E9/E10（拒绝风暴
  fail-fast / 计数清零不误伤）。

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
