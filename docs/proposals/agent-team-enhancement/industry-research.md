# Phase 0：DeepSeek Harness（dsh）运行机制调研

- 调研日期：2026-11-01
- 调研目的：为 DeepCodeX 智能体群组能力增强提供可信的外部参照
- 调研方法：官方站点 + 官方文档架构页 + 源码剖析文章，交叉验证
- 来源可信度：★★★（官方一手 3 条、深度源码剖析 2 条）

---

## 一、一句话定位

**Agent = Model + Harness**。DeepSeek Harness（`dsh`）是 DeepSeek 官方以 MIT 协议开源的 **agent 运行时**，2026-08-13 发布，当前为 developer preview。它的核心主张是「一切皆插件」——模型适配器、工具注册表、会话日志、甚至 **agent 主循环本身** 都是可替换插件，不存在必须改代码才能扩展的特权内核。

> 与常见 agent 框架的差别：多数框架是「一个硬编码主循环 + 一堆内建能力」，加能力要改循环、改 prompt 组装、改工具分发。dsh 把主循环做成了插件之一。

---

## 二、插件内核：Cordis

| 项 | 内容 |
| --- | --- |
| 来源 | Cordis 最初是 Koishi（2019 年起的跨平台 TS 聊天机器人框架）拆出的插件内核 |
| 协议 | MIT，作者 Shigma（Yifan Shi），对应 arXiv 论文 |
| 版本 | Koishi 用 Cordis v3；dsh 用 **v4**（重新设计） |
| 引入方式 | vendored 进 `deepseek-ai/deepseek-harness` 的 `vendor/cordis`，内部发布为 `@deepseek-ai/cordis` |
| 插件形态 | 实现 `Service` 的任意对象：普通函数 / 带 `apply(ctx)` 的对象 / `Service` 子类 |
| 组装方式 | 由 `cordis.yml` 配置驱动，**不是代码驱动** |
| 生命周期 | `Fiber` 状态机：PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED，错误走 FAILED 分支 |
| 核心概念 | **时空可组合性**：时间维——组件卸载时其副作用全部回滚；空间维——组件声明依赖，依赖出现/消失时响应式启停 |

---

## 三、三层组装：profile / bundle / patch

运行中的 dsh 是一棵**启动时按序叠加**出来的插件树：

```
profile（Harness home 里的具名组装）
  ├─ 按序应用各 bundle 的 Cordis 配置项与挂载代码
  ├─ profile 自己的 cordis.patch.yml
  ├─ home 级 cordis.patch.yml
  └─ 任意 --patch overlay
```

- `bundle` 是「Cordis 配置项 + 挂载代码」的分发格式，**它插入的内容始终可被上层 patch**。
- `dsh-base` 是所有 profile 共享的基础层：模型适配器、工具、持久化、沙箱策略、遥测。
- 自检命令：`dsh --profile web --dump-config` 打印实际启动的完整配置树，**打印出的任何条目都能被自己的 patch 替换**。

> 关键点：**扩展不需要 fork 主程序，只需要在现有插件旁边再挂一个**。

---

## 四、四种运行模式

| 模式 | 默认加载 | 用途 |
| --- | --- | --- |
| Standard | 完整工具集：文件编辑、shell、文件与 Web 搜索、skills、planning、goals、subagents、workflows | 通用编码 |
| Code（PTC） | Standard 全部能力，工具通过 Code Mode SDK 暴露 → 模型可在一段 TypeScript 程序里组合多轮工具调用 | 减少往返 |
| Minimal | 仅 `bash` + `str_replace_editor` 两个工具 | 极小环境下做模型基准 |
| Creator | Standard 全部能力 + 运行时内省 + 内存中试验 Cordis 插件 + 预设编写指引 | 创作新预设/新模式 |

> 与 DeepCodeX 的对照：dsh 的「模式」是**预设 + 插件集**的组合，切模式等于重建插件树；DeepCodeX 的模式是 `deepcode` / `code` / `minimal` 等硬编码分支。

---

## 五、会话日志：事件溯源（最重要的一节）

### 5.1 设计选择

会话不是「一串消息的容器」，而是**一系列事件的日志**。模块头注释即划清边界：

> *Event-sourced session service: append-only session log, in-memory store, and the derived LLM message history. **Persistence is a plugin concern** (subscribe to `session/event`, drain on `session/flush`).*

由此获得四个能力，全部来自同一份事实：

| 能力 | 机制 |
| --- | --- |
| 可回放 | 任意时刻从事件序列重建完整状态 |
| 崩溃恢复 | 重新读日志 |
| 可 fork | 复制事件前缀即得分叉会话（`buildForkSeed`），`session/end-seed` 标记继承与后续生命周期的分界 |
| 可审计 | 「发生过什么」与「模型看到了什么」是两个不同问题，日志同时记录两者 |

**append-only 意味着没有 update、没有 delete**。要「修改」历史（如上下文压缩遮蔽旧消息），做法是**追加一条携带替换指令的新事件**——日志永远只增长。

### 5.2 事件信封

```ts
type SessionEvent<T> = {
  type: T
  seq: SessionSeq      // 品牌化的会话内单调序号
  time: number
  data: SessionEventMap[T]
  ignorable?: true     // 未知事件类型可被老版本读者安全跳过
} & (K extends SurfaceEventType ? SurfaceIntent : { surfaceOp?: never; sourceEventSeqs?: never })
```

三个精妙之处：

1. `seq` 是**寻址单位**——表面、fork 边界、压缩区间全部以 seq 定位。
2. 条件类型交叉让「表面意图」**只能出现在 5 种表面事件上**，非表面事件携带即编译错误——**契约活在类型里而非运行时校验**。
3. `ignorable?: true` 是兼容机制：老读者遇未知事件可安全跳过。不做「事件名注册」的理由是：注册「不能分类省略是否安全，且使读取结果依赖组合了哪些插件」。

### 5.3 事件词汇表

- **14 个核心事件**：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`system/message`、`developer/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`request/header`、`request/context`、`session/end-seed`。
- **全集 62 个**（`KNOWN_SESSION_EVENT_TYPES`，由 `scripts/gen-persistence-catalog.ts` 从源码生成、禁止手改）：`approval`、`compaction`、`todo/write`、`subagent`、`team`、`hook`、`llm/retry`、`tool/ptc-dispatch`、`session/title`、`workspace/changes` 等。
- 插件事件走独立命名空间 `plugin:${string}`，经 `PluginRecordMap` 声明合并，**不污染核心词汇**。
- `tool/call.arguments` **刻意保存模型原始 JSON 字符串、不解析**——保留原始事实。
- `assistant/attempt` 记录失败/重试/取消的**未上表面尝试**：失败也留痕。
- `turn/end.reason` 取值精确：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked`。其中 `interrupted` 是「崩溃孤儿回合的**事后**闭合标记，循环从不现场发出」。

### 5.4 表面（Surface）机制：「模型可见即已入日志」

62 种事件都落日志，但**只有一部分产生模型可见的消息**。由 `SessionSurface` 回答「哪些」：

```ts
type SessionSurface = {
  nodes: readonly SessionSeq[]   // 按序产生 LLM 消息的事件 seq 列表
  replaceGeneration: number
  contentGeneration: number      // 缓存失效键
}
```

`SurfaceManager` 只认两种操作：

- `append` —— 事件把自己的 seq 推进 `nodes`
- `replace {startSeq, endSeq}` —— 校验两端点都在 `nodes` 中、`sourceEventSeqs` 无重复且覆盖全部被遮蔽节点、`tool/result` 重写只能改内容、覆盖节点 0 的必须是 `system/message`，然后 splice 替换区间

**「model-visible means logged」在代码里有四处互证**：模块头写 "the derived LLM message history"；`deriveMessages()` JSDoc 写 "The surface is the single source of derived history"；`append()` 的 `@throws` 写 "The event log is the durable source of truth"；编译期只有 5 种 `SurfaceEventType` 能携带表面意图。

**反向不成立——入日志不必模型可见。** 典型例子：`tool/ptc-dispatch` 的注释直说 *"Log-only: `deriveMessages()` ignores it, so sub-calls never re-enter model context; persistence and UIs get every call."* 程序内子调用全部留痕但不污染上下文。

> 这个**单向蕴含**是审计能力的语义基础：**可见 ⇒ 已入日志**。

### 5.5 实时控制与持久事实分离

`SessionStore` 发布四类事件，分派模式各不相同：

| 事件 | 模式 | 语义 |
| --- | --- | --- |
| `session/created` | `emit` | 同步抛出，可否决创建并回滚配对的 dispose |
| `session/disposed` | `emit` | — |
| `session/event` | `emit` | **post-commit、fire-and-forget** 的追加流 |
| `session/flush` | `parallel` | **可等待**的持久化检查点 |

`turn/end` 的 JSDoc 特意澄清：「The loop does not await a flush at turn boundaries: `dsh-session-checkpoint-policy` owns the per-request durability checkpoint」——**循环的速度与数据的耐久性解耦成两个关注点**。

热路径 `append()` 完全同步、不碰 I/O；持久化插件在异步缓冲里消费追加流。`append()` 的哲学是「坏事件当场死」：

> *The event log is the durable source of truth, so a bad event fails at the append site rather than later during a backend flush.*

---

## 六、持久化：一个严格契约的 Seam

`ctx.sessionPersistence` 的契约**非常严格**，值得逐条记住：

1. 事件序列号**必须连续**
2. 批量写入**完成持久化后**才返回追加成功
3. 若在一轮执行中崩溃，应**追加合成的结束事件（synthetic closers）** 完成修复，**而不是截断原日志**
4. 若当前版本无法正确解释某份已保存日志，**必须拒绝读取**，避免误解析

后端只需实现小巧的 `PersistenceBackend`（批量追加 / 加载 / 从指定 seq 加载 / 读 revision token / 提交修复 / 列出会话），其余交给共享的 `PersistenceCoordinator`（写入批处理、序列游标、实时会话接管、崩溃修复顺序、已准备会话缓存）。

默认两个提供方：**JSONL**（每会话一个 `.jsonl.zstd`）、**SQLite**（全库一个）。`ctx.sessionQuery` 另有一个 SQLite FTS5 提供方，可选装 `dsh-tool-session-query` 向模型开放 5 个只读工具让模型搜索自己过去的工作。

> 第三方可替换性的实证：Timeplus 用数据流实现了 `sessionPersistence` + `sessionQuery` 两个 seam，`fork` / `resume` / `replay` / 水位读取**无需任何额外修改即正常工作**——因为契约严格到「逐行对应 SQLite 实现」即可。

---

## 七、能力 Seam：约 70 项服务

一个 seam = 三种角色：**Service Definition**（声明接口）/ **Service Provider**（实现）/ **Consumer**（使用，通常是面向模型的工具）。替换一个提供方就能改变整个产品——例如文件系统与进程提供方共享同一个执行世界，把它们指向远程沙箱，**Bash、PTY、LSP 会一并搬过去**，无需提供方专用 fork。

按 harness 职责分组（文档的 capability graph 约 70 项）：

| 组 | 内容 |
| --- | --- |
| Model | LLM 适配器、system prompt 组装、上下文压缩与工具结果裁剪 |
| Agent loop | 回合驱动、**按会话配置能力集的 preset**、**subagent 委派**、Goals、Plan Mode |
| Tools & execution | 带安全管控的工具注册表；文件系统、shell、子进程、终端、LSP、Web 访问、代码运行时 |
| Security | 进程沙箱及策略、审批与权限预设、**确保凭据不写入日志**的凭据管理 |
| Human & host | **不消耗一次模型调用的斜杠命令**、向用户提问、系统设置、后台任务、Webhook、Web 客户端驱动的控制器 |
| Session & memory | 内存会话日志 + 持久化、跨会话读取与搜索、遥测镜像、标题与投影等派生视图、非会话存储 |

dsh 还为第三方提供方准备了**一致性测试套件（conformance suites）**——第三方实现必须跑与官方第一方相同的测试。

---

## 八、对 DeepCodeX 最有借鉴价值的五点

按「与当前痛点的匹配度」排序：

| # | dsh 机制 | 对应 DeepCodeX 痛点 | 借鉴价值 |
| --- | --- | --- | --- |
| 1 | **斜杠命令不消耗模型调用**（Human & host 组） | Web 侧 `/team` 只有描述符、无执行体；用户敲了命令被当普通文本投给 LLM，静默降级 | ★★★★★ 直接对症 |
| 2 | **subagent 委派 + preset 按会话配置能力集** | Team 角色（5 硬编码、无工具）与 SKILL.md 智能体（35 个、有完整工具循环）是两套互不相连的体系 | ★★★★★ 直接对症 |
| 3 | **单一事件日志派生历史**（model-visible means logged） | 会话是可变 messages 数组；无 fork / replay；`team dispatch` 的一次性调用不留痕 | ★★★★☆ 结构性强，但迁移成本高 |
| 4 | **seam 三层 + conformance suite** | 加能力要改 core；领域专家匹配器等 1300 行代码因未导出而成为死代码 | ★★★☆☆ 长期方向 |
| 5 | **持久化契约严格化**（seq 连续、批量原子、合成结束事件而非截断） | 会话落盘为 JSON，崩溃语义未定义 | ★★★☆☆ 局部可借用 |

**明确不建议照搬的两点**：

- **不要重写为 Cordis 插件树。** DeepCodeX 已有 19M 源码、成熟的 `SessionManager`/`ToolExecutor`/`SkillManager` 与 Tauri 壳，全量插件化的迁移风险远大于收益。
- **不要引入 226 个 package 的拆分粒度。** 那是为「第三方可替换整个运行时」设计的，DeepCodeX 当前没有这个诉求。

---

## 九、来源清单

| # | 标题 | URL | 用途 |
| --- | --- | --- | --- |
| 1 | 架构与设计 - 一切皆插件的 DeepSeek Harness（官方文档） | https://deepseekharness.online/guide/architecture/ | profile/bundle/patch、四种模式、seam、会话日志 |
| 2 | Everything is a plugin（DeepSeek 官方站） | https://deepseek.com/harness/en | 官方定位、四模式定义、design approach |
| 3 | The Cordis Framework: The Plugin Kernel Inside DeepSeek Harness | https://deepseekai.works/cordis | Cordis 来源、版本谱系、Fiber 状态机、时空可组合性 |
| 4 | DeepSeek Harness 源码剖析-05 会话日志系统 | 微信公众号（源码级剖析） | SessionEvent 信封、14/62 事件、Surface 机制、append 语义 |
| 5 | 在 Timeplus 上运行 DeepSeek Agent Harness | 微信公众号（Timeplus 官方） | persistence seam 严格契约、约 70 项服务分组、斜杠命令不耗模型调用 |
| 6 | DeepSeek Harness 开源了：先看懂它的插件树和会话日志 | https://www.jxxy.net/ai/articles/echo-vic-deepseek-harness-plugin-tree-session-log/ | 226 个 package、waterfall 拦截链、交叉验证 |
| 7 | DeepSeek Harness: Everything-Is-a-Plugin Agent Runtime | https://crazycoderslab.com/deepseek-harness-dsh-plugin-agent-runtime-github-2026 | 版本/星标/桌面端、release notes 细节 |
