# 业界调研报告：DeepSeek Super-agent / Trae 新助手 / WorkBuddy 托管智能体

> **调研日期**：2026-11-03
> **调研人**：多智能体团队（Phase 0）
> **调研方式**：WebSearch 真实检索 + DeepSeek 原型仓库源码文档直读（github.com/deepseek-ai/dsh-superagent-prototype `docs/000~008`）
> **纪律声明**：本报告所有外部结论均附可追溯 URL；厂商自报数据（DeepSeek 实验数据、腾讯生态数据）**明确标注为厂商口径，非第三方独立评测**。

---

## 0. 一句话结论

DeepSeek 把 Agent 的瓶颈从「模型能力」重新定义为「人的注意力」，并给出了一套纯工程解法：**Router/Worker 双层解耦 + 事件驱动 + 订阅直通 + 存算分离 + 外部 Watchdog**。这套解法与 Trae（执行与上下文）、WorkBuddy（连接与业务系统）恰好互补，构成「调度 / 执行 / 连接」三层完整栈。**DeepCodeX 当前已有大量编排零件（Goal DAG、Ralph 循环、Worktree 隔离、Subagent 沙箱、审批闸、动态窗口、证据链），但缺的不是零件，而是把它们组装成「常驻路由 + 隔离执行 + 事件驱动 + 持久领域状态」的骨架。**

---

## 1. DeepSeek Super-agent（主参考）

### 1.1 发布事实

| 项 | 事实 | 来源 |
|---|---|---|
| 文章 | 《Super-agent设计探索：迈向更自主的Agent系统》，DeepSeek Harness 团队 | [微信公众号原文](http://mp.weixin.qq.com/s?__biz=MzUyODg5Njk2MQ==&mid=2247509727&idx=1&sn=db066d5cfd575f94588e1279a7143b67) |
| 发布日 | 2026-10-31 晚 | 同上 |
| 原型仓库 | `deepseek-ai/dsh-superagent-prototype`，MIT，TypeScript，写稿时约 1,800 star | [GitHub](https://github.com/deepseek-ai/dsh-superagent-prototype) |
| 定位 | **研究原型，非官方产品、非生产就绪**（仓库 README 原文声明） | GitHub README |
| npm | `dsh-superagent-prototype` / `superagent-prototype` **均 404，未公开发布** | [第三方核查](http://mp.weixin.qq.com/s?__biz=MjM5NDgzMzQwOQ==&mid=2452085622&idx=1&sn=89e1fc406e50f361f0ecc1acb8be7206) |

### 1.2 核心命题

> 「随着模型能力持续提升，AI 完成单个任务已越来越不需要人工干预，但人类管理多任务的注意力并未同步增长——一个人通常只能同时跟进 3 至 5 个活跃会话。」

团队据此判断：**单任务上限取决于模型能力，多任务上限取决于人的注意力**。解法是把会话管理与上下文同步从人手上移到系统层面，人只负责「定目标 + 做验收」。

传统架构三处具体病灶（文章点名，非泛泛批评）：
1. **单会话串行** —— 耗时工具调用发起即阻塞，期间听不进新指令。
2. **多任务上下文混乱** —— 会话间不共享背景，同一需求换个窗口要重述。
3. **设备离线即中断** —— 执行循环跑在本机，合盖/断网/进程被杀即停摆。

### 1.3 四个特征与五个模块

**四个特征**：连续（Continuity）、高效（Efficiency）、主动（Proactivity）、持久（Persistence）。

**五个支撑模块**：

| 模块 | 关键设计 |
|---|---|
| **双层架构** | Router（常驻全局路由/协调/共享上下文，**不执行任务、可不配 Bash 工具**）＋ Worker（隔离上下文执行，可再调 Subagent）。Router 用轻量模型，Worker 用强模型 |
| **事件驱动** | Trigger 为输入单元；**两级过滤**：确定性规则 Fast Path 先筛，LLM Slow Path 再研判；**订阅直通**：Worker 接手 Thread 后直接订阅后续事件，绕开 Router 中转 |
| **异步多信道交互** | Async ReAct Loop：耗时工具改 `start()`/`stop()`，调用即返回「已启动」，结果作为新事件投递回会话；输出按信道定制（IM 硬性 ≤100 词，GitHub/邮件交付结构化完整说明） |
| **上下文管理** | Inline & Spill（高频内联、低频留窗外只留引用）+ 引用图 + **Chain of Recall**（按需逐跳召回） |
| **存算分离 + Watchdog** | Agent Loop 无状态计算上云端，会话状态入 DB，端侧只留轻量 daemon（支持 BYOM）；Watchdog 独立进程检查任务是否原地打转并尝试修复 |

### 1.4 领域模型（原型 `docs/001-domain.md` 直读，最有价值的部分）

原文用词（后续文档一律只用这些词，不另造）：

| 概念 | 含义 | 守则要点 |
|---|---|---|
| **Source** | 事件流。kind = 可复用实现，instance = 一份配置 | 持有读游标（重启不重放）；丢弃自身消息；把 Trigger 翻译为 Thread 归属与回复地址 |
| **Trigger** | 一个不可变事件 | 幂等单元：同一 Trigger 接受两次只产生一个 Ticket |
| **Thread** | 按时间排序的 Trigger 序列 | 同一时刻至多一个 Eval 运行；可持多个 Ticket；持有 Subscriptions 与 Decision 历史 |
| **Correlation** | 共 Trigger 的 Thread 之间的关系 | **只加上下文，绝不路由** |
| **Channel** | Thread 的写侧（回复地址） | 一个 Thread 可有多个 Channel |
| **Policy** | 版本化的准入/评估规则 | 版本覆盖规则 + accept 模式 + 各 Source 部分；变更**不撤销**存量 Mandate，只投递变更通知 |
| **Eval** | 对一批 Trigger 的判断，两层：**Gate（确定性准入）→ Assessment（LLM 研判）** | **无状态**；输出 Decision |
| **Mandate** | 一次 accept 授予的授权：Policy 版本 + 范围 + 强度 + 匹配规则 + 发送者身份 | **不可变**；范围变宽 = 新 Ticket；只有「人喊停」或「Policy 复验失败」能撤销 |
| **Ticket** | 一份被授权的工作单元 | **只有 Eval 能创建**；状态自定，不跟随 Executor |
| **Assignment** | Ticket ↔ 一个 Executor 实例的绑定 | 一个 Ticket 生命周期内可有多个 Assignment；只有最终报告能终结 Ticket |
| **Subscription** | Ticket ↔ Thread 多对多关系 | 匹配的 Trigger **扇出**给所有订阅中的 Ticket，**不检查发送者、不新增授权**；已结束 Ticket 保留订阅 → 人的后续消息可**无需新 Eval** 直接恢复 |

**Decision 四值**：`accept 接单 / stop 停止 / ignore 忽略 / unavailable 未完成`
**Strength 两值**：`explicit 明确 / inferred 推断`
**Assignment 三态**：`pending 待启动 / running 执行中 / ended 已结束`
**Report 六值**：`progress 进展 / waiting 等待 / ready 就绪 / blocked 受阻 / failed 失败 / dropped 无需处理`
**Attention（待人工决定）**：Ticket 上等待人回答的**结构化问题**——原文明确「不能从报告的自由文本推断」，必须结构化字段。

### 1.5 授权模型（原型 `docs/002-authorization.md` 直读）

- **两条路径**：Eval（判断是否开启新工作）vs Subscriptions（继续既有工作）。
- **准入强度**：`explicit` = 白名单内的人 @ 了机器人 / 已在有 Ticket 的 Thread 上追问 / 准入表显式单元格；`inferred` = 非白名单者的追问（除非表格设为 explicit）、准入表推断单元格、白名单 bot 的消息；`not admitted` = 其余 bot 消息、被忽略的单元格、`off` 模式下的 inferred。
- **accept 模式三档**：`off`（推断型一律不成为候选）/ `observe`（默认；研判通过只记录为「would accept」，**不接单**）/ `auto`（研判通过即接单）。
  > **「先 observe 观察一段时间，确认判定质量后再切 auto」——这是原型的推荐上线路径。**
- **复验（Revalidation before resume）**：已结束 Ticket 被人的消息恢复前，必须按当前 Policy 复验授权；复验失败 → Ticket 保持结束、其等待消息重新走 Eval。**移除白名单成员可以撤销经该成员准入的 Mandate。**
- **原型的硬安全约束**（README / 文章）：
  - Worker 会话以**运维者的系统用户身份免审批执行命令** → README 明确要求「用前先审阅和改造」。
  - 默认只允许为工单开的、**增删合计 < 200 行且已获批准**的 PR 自动合并；**且不以 Agent 自己的账号开启自动合并**。
  - Worker 没有直接向人提问/展示结果的工具；不能在 worker slots 外调度；不能编辑外部文档。

### 1.6 架构不变量（原型 `docs/007-architecture.md` 直读 —— **最高价值部分**）

> 这一节是本次调研中对 DeepCodeX 最可直接借鉴的部分。

1. **Engine 是领域状态的唯一写入者**。Triggers / Threads / Decisions / Tickets / Assignments 全部只经 Engine 写入；Engine 按角色暴露 `Pick<Engine, ...>`（`EngineForSources` / `EngineForMainSession` / `EngineForPeople` / `EngineForSettings` / `EngineForExecutor`），**调用方拿不到不该有的方法**。
2. **事务与副作用严格分离**：命令先提交事务（`Store.atomic`），再由持久化的 **Effects 队列**在提交后执行外部动作。队列项按 `kind/key` 合并去重，失败指数退避，`Later` 异常表示延期不计失败。
3. **Source 只拥有自己的数据**：Source 改变 Ticket 的唯一途径是 `SourceContext.tickets.bindThread` / `threadClosed`。
4. **Router 是批量命令编排器**：一次可处理 1–20 个 decision，**每项独立执行，单项失败不阻断后续**。
5. **Worker 与主 Session 通过 Engine + Effects 通信**，不直接互相操纵状态。
6. **Passes**（每 2 秒一轮、串行、请求合并）负责周期调度；**Effects** 负责可靠副作用；**WorkerSlots** 负责并发容量。
7. **SQLite 是系统的事实来源**，生成列（`thread.active` / `ticket.open` / `ticket.active`）+ 索引支撑活跃工作扫描。
8. **依赖规则**：`src/core` 不导入 `src/app`、不做 I/O；`src/sources` 不导入 `src/app`。
9. **noWait 限制**（工程上很实用）：主 Session 的 shell 命令**含 `sleep` 直接拒绝**、`timeoutMs > 30s` 拒绝、`job_output` 等待 > 5 秒拒绝。理由原文：「Report 和 job result 会自动到达，等待只会延迟新 candidate」。
10. **消息注入的唤醒语义分级**：会唤醒主 Session = `candidate` / `follow_up` / `worker_report` / `worker_attention`；**只注入不唤醒** = `ticket_ended` / `settings_saved` / prompt 保存通知 / Trigger requeue / dropped Subscription / context follow。

### 1.7 实验数据（**厂商口径，合成负载，非第三方评测**）

| 指标 | Super-agent | 单 Session + Subagent（中性提示） |
|---|---|---|
| 任务完成时间 P50 | **12.4 分钟** | 20.4 分钟 |
| 任务完成时间 P95 | **15.7 分钟** | **29.5 分钟** |
| 单次读缓存 token | 23.2M | 6.1M–10.8M |

> ⚠️ **口径说明**：官方自述「基于合成负载与简化环境」，只验证调度与协作能力，**未评估真实编码质量**。且「中性提示下 5 次运行模型一次都没主动调用 Subagent」——这恰恰说明**靠提示词让模型自发分工是不可靠的，分工必须在系统层固化**。

**消融实验**（关掉订阅直通）：Router 决策次数 **+约 30%**，读缓存 token 从 23.23M → 31.77M（**+37%**）。
**Router 压力测试**：Trigger 到达率 1 → 40 条/分钟时，单个决定分摊推理时间 6.4s → 1.6s（**批处理吸收拥堵**）。

### 1.8 官方承认的三个开放问题

1. **长程记忆** —— 引用图与链式召回解决的是近期检索，跨月/更长周期记忆仍是扩展性瓶颈。
2. **A2A 协作** —— 多个彼此隔离的 Super-agent 实例如何在不共享底层上下文的前提下安全通信。
3. **安全与隐私** —— 云端 Agent Loop 持续接入外部环境 + 端侧存凭据，提示词注入与服务端入侵风险被直接点明；原文甚至提出「需要让 Agent 在完全不接触凭据本身的情况下使用凭据」。
   > 结论原文：「如果没有办法很好地解决安全与隐私问题，Super-agent 只有在一个很小且可信的范围才能工作。」

---

## 2. Trae 新助手（执行与上下文层）

### 2.1 产品事实

| 能力 | 事实 | 来源 |
|---|---|---|
| **SOLO 模式** | 内置 Coding Agent，理解目标、规划任务、调度工具，独立推进各阶段开发；可自动拆分复杂任务 | [trae.cn/ide](https://www.trae.cn/ide) |
| **全新 Agent 模式** | 一个窗口统筹**多项目、多 Agent**，按任务分配 Agent 并行推进，实时查看执行进度与完成状态 | [trae.cn](https://trae.cn/) |
| **智能体合并（v3.3.93–3.3.96）** | Solo Agent 智能体与 Agent 智能体合并为 **Agent 智能体**，IDE 与 SOLO 双端可用；含原两者能力集合，支持 `/goal`、`/plan`、`/spec` 内置命令，支持按模型开启 Max 模式、Auto Mode 模型，**支持调用自定义智能体** | [TRAE 更新日志](https://docs.trae.cn/ide/changelog?_lang=zh) |
| **自定义智能体体系** | 可自由配置工具、技能、任务逻辑，构建专属智能体团队；独立创建 Agent 并分享到市场，像插件一样组合 | [trae.cn/ide](https://www.trae.cn/ide) |
| **MCP 集成** | 通过 MCP 赋予智能体外部资源调用能力 | 同上 |
| **TRAE Rules** | 可配置自己的 AI 工作规则 | 同上 |
| **移动端（TRAE SOLO）** | 语音/文本/文件下发、**跨设备任务调度（连接 Cloud 云端 + 多台 PC，远程执行与多任务并发）**、远程操控电脑、多端实时同步 | [官方公告](https://forum.trae.cn/t/topic/15182?page=2) |
| **其他** | 定时任务、飞书 CLI 接入（桌面端/网页端）、Computer Use（v3.3.88）、Browser Use（v3.3.79 Windows） | 同上 |

### 2.2 对 DeepCodeX 的启示

- Trae 的「**一个窗口统筹多项目多 Agent**」本质是 DeepSeek Super-agent 的 **Router 视图**（人只面对一个界面），但**没有**事件驱动与主动性——仍以人下指令为起点。
- Trae 的 `/goal` `/plan` `/spec` 内置命令 + **可调用自定义智能体**，正是 DeepCodeX `AgentRegistry`（SKILL.md `type: agent`，已物化 35 个角色文件）想做的「可组合智能体团队」的等价物——**DeepCodeX 在这一层已对标甚至更完整**（Trae 需装插件市场，DeepCodeX 已落文件）。
- Trae 独有、DeepSeek/DeepCodeX 都弱的是**跨设备 + 远程操控 + 语音下发**。

---

## 3. WorkBuddy 新助手（连接与业务系统层）

### 3.1 产品事实

| 能力 | 事实 | 来源 |
|---|---|---|
| **托管智能体 WMA** | 把客户端 Agent 工程能力 **1:1 搬到云端**；云端内核沿用 WorkBuddy Agent 底座与 Harness，由 **Agent 运行时 + Harness + 模型 + 企业管理平台** 四部分组成 | [腾讯云](https://cloud.tencent.com/developer/article/2774321)、[新华网](https://my-h5news.app.xinhuanet.com/h5/article.html?articleId=20261030b3f08d4e7f5944818081d584e3c95ef6) |
| **7×24 在岗** | 「让 AI 从关机就停到 7×24 在岗」；腾讯内部**每天已有百万级托管智能体任务运行** | 同上 |
| **三种调用面** | ①桌面端直接调用 ②**API / A2A 调用**（嵌入业务系统或接入 IM）③两个管理入口（WorkBuddy 管理端定义并下发到员工端侧；腾讯云控制台 API/SDK 嵌入业务系统） | 同上 |
| **三种部署形态** | SaaS 旗舰版 / **VPC 专享版**（首批通过信通院「政务领域智能体安全要求测评」，数据不留存、权限可管控、行为可审计）/ 私有化部署 | 同上 |
| **可观测中心** | 全局 / 归因 / 单步三层：Token 与费用总量、成本归属定位、执行堵点与异常；「给 Agent 装上仪表盘和行车记录仪」 | [经济参考报](http://jjckb.xinhuanet.com/20261102/702f73d52d3243dc9c8d82b8268ffd49/c.html) |
| **开放平台** | 向内融合企业微信及腾讯办公生态，向外兼容第三方 IM 与企业系统（MCP / 连接器接入 ERP、CRM），接入主流开源模型 | [腾讯云](https://cloud.tencent.com/developer/article/2774321) |
| **超级组织五阶模型** | 试用 → 推广 → 沉淀 → 连接 → 自治 | 同上 |
| **生态数据（厂商口径）** | 5 万+ 生态伙伴与开发者，20 万+ Skills，2000+ 合作伙伴；90 亿次累计任务请求；企业版覆盖半数中国企业 500 强 | [中国日报](https://ex.chinadaily.com.cn/exchange/partners/82/rss/channel/cn/columns/j3u3t6/stories/WS6ae48581e4b09a165c792b46.html) |

### 3.2 关键判断：WorkBuddy = DeepSeek Super-agent 的「存算分离」已产品化

WMA 的四段式内核（**Agent 运行时 / Harness / 模型 / 企业管理平台**）与 DeepSeek Super-agent 的「云端 Agent Loop + 端侧轻量 daemon」**是同一思路的不同深度**：WorkBuddy 已把「本地 daemon + 云端常驻」做成商用产品并跑百万级/天。

> **结论**：DeepCodeX 若要自建存算分离，投入产出比远低于「本地 daemon + 可迁移会话状态」的轻量版本；**企业级托管应留给 WorkBuddy，DeepCodeX 应专注做本地优先的 Super Agent 内核**。

### 3.3 对 DeepCodeX 的启示

- **A2A 已标准化**：WorkBuddy 用 A2A 作为跨智能体调用协议（本文档所在宿主环境即已有 A2A 代理清单，见 `wecom-message-agent-3432f035`）。DeepSeek 把 **A2A 协作**列为开放问题——**DeepCodeX 可以直接借 WorkBuddy 的 A2A 通道，而不是自己造**。
- **Skills 作为组织能力载体**（企业沉淀为 Skills → 构建专属 Agent）——与 DeepCodeX 的 `SkillManager` + `AgentRegistry`（SKILL.md 文件化）**天然同构**。
- **可观测中心的三层（全局/归因/单步）** 是 DeepCodeX `v2/observability` + `eag/evidence-bundle` 的产品化对应物，可作为交互设计参考。

---

## 4. 行业坐标（三分法）

| 玩家 | 解决什么 | 代表能力 |
|---|---|---|
| **DeepSeek Super-agent** | **怎么并行、怎么持续跑** | Router/Worker、事件驱动、订阅直通、存算分离、Watchdog |
| **Trae** | **怎么操作、怎么编码** | SOLO Coding Agent、多项目多 Agent 统一窗口、自定义智能体生态、MCP、跨设备 |
| **WorkBuddy** | **接入什么、怎么嵌入业务** | WMA 托管、开放平台、可观测中心、企业微信融合、A2A |

原文判断：「执行、连接、调度三层能力，大概率不会长期分属三家。『云端持久调度 + 本地环境执行 + 业务系统打通』的完整 Agent 栈，才是各家的终局形态。」

---

## 5. DeepCodeX 现状基线（对照 Super-agent 的九项要求）

> 扫描对象：`/Users/wangwei/Documents/VG/DeepCodeX-cli`（TS monorepo，packages: cli / core / quality / vscode-ide-companion / web）
> 规模：core ≈ 469k 行（含测试）、cli ≈ 35.5k、web ≈ 7.8k、quality ≈ 6.3k、vscode-ide-companion ≈ 2.3k

### 5.1 已有资产（真实路径）

| 资产 | 路径 | 说明 |
|---|---|---|
| **多角色团队** | `packages/core/src/team/role-registry.ts`、`team/domain-experts/*` | 5 核心角色 + 30 领域专家，**仅在内存**，已由 `agents/preset-agents.ts` 物化为文件 |
| **Agent 注册表** | `packages/core/src/agents/agent-registry.ts` | 扫描 SKILL.md `type: agent`；索引只暴露 name/role/description（**不暴露正文与绝对路径**，对齐 dsh 防线） |
| **Goal DAG 调度** | `packages/core/src/team/plugins/goal-dispatcher.ts`、`multi-goal.ts` | Kahn 拓扑排序、同层并发、mutex、失败传播、resume |
| **Ralph 自主循环** | `packages/core/src/team/autonomous/loop-controller.ts` | plan→dev→verify→fix 四阶段；success/failed/retriable/fatal 四判定；退避+连续失败 abort |
| **运行状态持久化** | `packages/core/src/team/autonomous/run-state.ts` | 原子写（tmp→rename）+ SHA256 校验 + 断点续跑；**文件级 JSON，非事务型 DB** |
| **执行环境隔离** | `packages/core/src/team/workflows/worktree-manager.ts`、`subagent-sandbox.ts` | Git worktree 隔离 + 子代理沙箱 |
| **编排模式引擎** | `packages/core/src/team/workflows/pattern-composer.ts`、`pattern-executor.ts`、`model-router.ts`、`token-budget-guard.ts`、`skill-injector.ts` | 6 类动态工作流模式；模型路由；token 预算守门 |
| **上下文管理** | `packages/core/src/context-budget.ts`、`v2/context/*` | 动态窗口管理、滑动窗口、渐进加载、相关性打分、双层管理、任务上下文管理、代码图谱片段供给 |
| **审批与安全** | `packages/core/src/v2/approval/*` | approval-gate、arity-classifier、command-safety、tool-router |
| **记忆** | `packages/core/src/v2/memory/*` | 三层记忆、execution-history store、summarizer 家族、redaction、privacy-manager |
| **异步后台任务** | `packages/core/src/interrupts/*` | background-runner / background-task / interrupt-queue / task-registry / task-store |
| **循环守卫** | `packages/core/src/common/loop-guard.ts` | max_iterations / max_tokens / 连续失败 abort / 指数退避（**EAG 与 Ralph 共用同一份，避免第三套方言**） |
| **反馈控制** | `packages/core/src/team/cybernetics/feedback-control-loop.ts`、`guard-coordinator.ts` | 感知-决策-执行-反馈闭环；执行前验证 |
| **共识机制** | `packages/core/src/team/roundtable/*` | consensus / room / protocol |
| **证据链** | `packages/core/src/eag/evidence-bundle.ts`、`eag/discovery/loop-discovery.ts`、`eag/dynamic/finding.ts` | 既有 better-harness 提案 P1–P6 已于 2026-11-01 全部落地 |
| **MCP** | `packages/core/src/mcp/mcp-client.ts`、`mcp-manager.ts` | 客户端 + 管理器 |
| **SQLite 依赖** | 根 `package.json` `optionalDependencies: better-sqlite3 ^11.0.0` | **已是可选依赖，尚未用于领域持久层** |

### 5.2 九项能力差距矩阵

| # | Super-agent 要求 | DeepCodeX 现状 | 差距 |
|---|---|---|---|
| 1 | **Router/Worker 双层解耦** | `team/` 是**进程内同步函数调用**式编排；角色 = 提示词前缀，非独立上下文实例 | 🔴 **关键** |
| 2 | **事件驱动 / Source/Trigger/Thread** | `interrupts/` 是任务级后台执行；**无事件源抽象、无 Trigger 幂等单元、无 Thread 聚合** | 🔴 **关键** |
| 3 | **Mandate 任务级授权** | `v2/approval` 是**单次调用级**审批；无「不可变授权 + 强度分级 + 复验撤销」 | 🔴 **关键** |
| 4 | **事务型领域存储 + Effects 队列** | `run-state` 是文件 JSON 原子写；无事务、无 `afterCommit`、无按 kind/key 合并的副作用队列 | 🔴 **关键** |
| 5 | **两级过滤（Gate / Assessment）** | `team/role-matcher` 是**任务级角色匹配**（TFIDF/embedder），非「事件准入 + LLM 研判」 | 🟡 中等（语义可复用，语义层要重建） |
| 6 | **订阅直通（Subscription fan-out）** | 无 | 🔴 **关键** |
| 7 | **Watchdog 外部监督** | `loop-guard` 是**内嵌上限保护**；`feedback-control-loop` 是执行内闭环；**无进程外监督者** | 🟡 中等 |
| 8 | **异步 ReAct（start/stop 工具语义）** | `interrupts/background-runner` 最接近（后台跑 + 任务注册表） | 🟢 较小（可复用） |
| 9 | **人机降噪（IM ≤100 词 + 结构化 Attention）** | 无 Attention 结构化字段；无信道化输出策略 | 🟡 中等 |

### 5.3 结论：DeepCodeX 缺的不是零件，是骨架

现有能力已覆盖 DeepSeek Super-agent 五大模块中的**执行侧全部零件**（Worker 隔离、异步、审批、上下文、模型路由、token 守门、恢复）。真正缺的是三件事：

1. **一个常驻的、持久化的领域内核**（Engine + Store + Effects），让「多任务并行」不再依赖单个进程的内存。
2. **一个事件入口**（Source/Trigger/Thread），让「主动」有触发源。
3. **一个授权与注意力模型**（Mandate + Subscription + Attention），让「人在环」从「人盯着」变成「人验收」。

---

## 6. 与既有 DeepCodeX 提案的关系（避免重复劳动）

| 既有提案 | 状态 | 与 Super-agent 的关系 |
|---|---|---|
| `docs/proposals/better-harness-enhancement/` | **P1–P6 已于 2026-11-01 全部落地** | 解决「证据驱动审计」，**不涉及调度/事件/授权**，与本方案正交 |
| `docs/proposals/agent-team-enhancement/` | 已定稿 | 团队能力增强，**本方案在其上做架构升级** |
| `docs/research/dsh-analysis-20261027.md` | 已完成 | **DSH 源码级分析**，明确 **Q6 结论：dsh 只作抽象层借鉴，禁止引入 Cordis 依赖** |
| `docs/architecture/ARCH-20261027-agent-autodiscovery.md` + `docs/prd/PRD-20261027-agent-autodiscovery.md` | 已完成并实现 | Agent 文件化 + 自动发现沉淀 |

> 🔴 **硬约束继承**：本方案**不得引入 Cordis / dsh 运行时依赖**（既有 Q6 决策）。Router/Worker 必须基于 DeepCodeX 自有的 Session / AgentRegistry / worktree 机制实现。

---

## 7. 推荐决策

**推荐**：采纳 DeepSeek Super-agent 的**架构骨架与不变量**，以 DeepCodeX 自有资产实现一个**本地优先的 Super Agent 内核**；**不自建**企业级云托管与跨设备体系。

**采纳清单（照抄其不变量）**：
1. Engine 是领域唯一写入者，按角色暴露 `Pick<>` 接口
2. 事务与副作用分离（Store.atomic + afterCommit + Effects 队列）
3. Source 只拥有自己的数据，经 SourceContext 改领域
4. Router 批量决策、逐项独立、单项失败不阻断
5. Worker 与 Router 仅经 Engine + Effects 通信
6. SQLite 为事实来源 + 生成列索引
7. `src/core` 不做 I/O、不依赖 `src/app`
8. noWait 限制（禁 sleep / 禁长阻塞等待）
9. 消息注入的唤醒语义分级（唤醒 vs 只注入）
10. Mandate 不可变 + 三种撤销路径（accept / 人停 / 复验失败）

**不采纳清单（附理由）**：
- ❌ Cordis 插件组合（过度设计，违反既有 Q6）
- ❌ 企业级云托管 / VPC / 私有化部署（WorkBuddy 已产品化，重复投入）
- ❌ 跨设备远程操控 / 语音下发（Trae 已产品化，非 DeepCodeX 核心竞争力）
- ❌ 引入飞书 / GitHub 专用 Source（首期用 MCP + 本地事件源抽象，Source 可插拔）

**避坑清单**（来自原文与本项目既有教训）：
- ⚠️ 别指望模型自发分工——实验证明中性提示下 5 次运行一次都没调 Subagent；**分工必须系统层固化**
- ⚠️ 别用文件 JSON 当领域存储——必须事务化，否则「崩溃恢复 + 幂等」不可保证
- ⚠️ 别把「配置存在」当「能力可用」——既有 better-harness 提案已踩过这个坑（证据七级）
- ⚠️ Worker 免审批执行命令是**真实攻击面**（DSH README 自己都要求先审阅改造）；DeepCodeX 必须默认**审批闸在位**
- ⚠️ 长程记忆是公认未解难题——首期**明确不做**，只做会话内引用图

---

## 8. 参考来源清单

**DeepSeek（主）**
1. 《Super-agent设计探索：迈向更自主的Agent系统》— http://mp.weixin.qq.com/s?__biz=MzUyODg5Njk2MQ==&mid=2247509727&idx=1&sn=db066d5cfd575f94588e1279a7143b67
2. 原型仓库 — https://github.com/deepseek-ai/dsh-superagent-prototype
3. 原型 `docs/001-domain.md` — https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/001-domain.md
4. 原型 `docs/002-authorization.md` — https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/002-authorization.md
5. 原型 `docs/007-architecture.md` — https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/007-architecture.md
6. 智东西报道 — https://news.qq.com/rain/a/20261101A00GAD00
7. 新浪财经报道 — https://finance.sina.cn/2026-10-31/detail-inixcwwm7186478.d.html
8. 环球时报英文版 — https://www.globaltimes.cn/page/202611/1373392.shtml
9. 第三方拆解（含 npm 404 核查）— http://mp.weixin.qq.com/s?__biz=MjM5NDgzMzQwOQ==&mid=2452085622&idx=1&sn=89e1fc406e50f361f0ecc1acb8be7206

**Trae**
10. 官网 — https://trae.cn/ 与 https://www.trae.cn/ide
11. 更新日志 — https://docs.trae.cn/ide/changelog?_lang=zh
12. SOLO 移动端公告 — https://forum.trae.cn/t/topic/15182?page=2

**WorkBuddy**
13. 腾讯云「超级组织五阶模型」— https://cloud.tencent.com/developer/article/2774321
14. 新华网「四大能力升级」— https://my-h5news.app.xinhuanet.com/h5/article.html?articleId=20261030b3f08d4e7f5944818081d584e3c95ef6
15. 经济参考报·王慧星访谈 — http://jjckb.xinhuanet.com/20261102/702f73d52d3243dc9c8d82b8268ffd49/c.html
16. 中国日报·90 亿次任务请求 — https://ex.chinadaily.com.cn/exchange/partners/82/rss/channel/cn/columns/j3u3t6/stories/WS6ae48581e4b09a165c792b46.html

**DeepCodeX 内部**
17. `docs/research/dsh-analysis-20261027.md`
18. `docs/proposals/better-harness-enhancement/proposal-final.md`
19. `docs/architecture/ARCH-20261027-agent-autodiscovery.md`
