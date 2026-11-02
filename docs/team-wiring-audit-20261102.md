# 动态组队 / 智能体群组接线复核（2026-11-02）

- 复核范围：`packages/core/src/{session.ts,commands/**,team/**,agents/role-bridge.ts}`、`packages/cli/src/team/**`、`packages/web/{src,web/src}`
- 复核方法：入口 → 分发 → 执行体 → 工具能力 → 呈现，逐跳下钻；每跳给出行号级证据
- 前序报告：`docs/team-wiring-audit-20261101.md`（当时结论：CLI 满、Web 零、专家死代码、双轨制）

## 一、结论

**动态组队（`/team` 六个子命令）已全线贯通到执行体，Web 与 CLI 共用同一套代码。**
11-01 报告里的四项硬伤（Web 无执行体、专家死代码、候选集不可扩展、dispatch 无工具）均已消除。

**但「智能体群组聊天」在当前代码里没有对应实现。** 不是接线断了，是形态不存在：
所有多角色协作都是「一次请求 → 后台批处理 → 一份报告」，用户看不到多角色对话流。

复核中发现的 5 处「接线通、能力受限」问题（D1~D5）**已全部修复**，
另有 1 处连带缺陷（D6）在同轮发现并修复，逐条见第四节。

## 二、接线总表

| 环节 | 状态 | 证据 |
| --- | --- | --- |
| `/team` 意图识别 | ✅ | `commands/team-command.ts:1480` 首 token 严格等于 `team`（`/teams` 不算） |
| Web 新会话首句拦截 | ✅ | `session.ts:3995` 在 `createSession` 之前短路，建 `commandOnly` 骨架 |
| Web 已有会话拦截 | ✅ | `session.ts:4577` 在 EAG 解析之前短路 |
| 执行体 | ✅ | `session.ts:6666` → `runTeamCommand`；`team-command.ts:125` `OutputCollector` 零终端副作用 |
| 结果回呈 | ✅ | `session.ts:6691` stdout+stderr 合成一条 system 消息 |
| 进度可见 | ✅ | `session.ts:6671` `onProgress` → 逐条 system 消息 |
| 动态候选集（5 内置 + 35 智能体） | ✅ | `session.ts:6579` → `role-bridge`；`excludeRoleIds: listRoleIds()` 防重复 |
| 运行时角色开关 | ✅ | `settings.team.runtimeRoles`，`enabled` 默认 true、`allowUserAgents` 默认 false |
| 工具轮次（Web） | ✅ | `session.ts:6670` `runner: (ctx) => this.runEphemeral(ctx)` |
| 工具轮次（CLI 独立命令） | ✅ | `cli/src/team/team-runner.ts` + `hasModelCredentials()` 无 key 不装配 |
| 领域专家注入 | ✅ | `team-adapter.ts:842` `resolveDomainExpertInjection`，命中失败静默降级 |
| dispatch 事件日志 | ✅ | `team-adapter.ts:780`、`orchestrator/index.ts:124` |
| L2 自动拆解 | ✅ | `team-command.ts:762` `orchestrate`；`execute.ts:93` 层内 `runWithConcurrency` |
| 共识评审 | ✅ | `team-command.ts:591` 5 角色 `Promise.all` 并行 + LLM 聚合 |
| Web 命令描述符 | ✅ | `capability-api.ts` `listCommandsSafe` → `/api/capabilities.commands`（D3） |
| Web 前端入口 | ✅ | `Composer` 斜杠补全 + `ChatPane` 团队卡片（D3） |
| 临时会话状态隔离 | ✅ | `activeSessionId` 不覆写（D1）、`turnGuard` 按会话（D5） |
| 临时会话审批边界 | ✅ | 后台自动拒绝 + 明确告知（D2），`bypass` 模式可放开 |

## 三、11-01 报告四项硬伤的现状

| 原问题 | 现状 |
| --- | --- |
| Web 敲 `/team` 静默降级投给模型 | 已消除：core 两级拦截，两个宿主同一份执行体 |
| 专家子系统死代码 | 已消除：`index.ts` 导出 + `executeDispatch` 内注入 |
| 候选集只有 5 个硬编码角色 | 已消除：`role-bridge` 把 35 个 `type: agent` 映射为运行时角色 |
| `dispatch` 无工具循环 | 已消除（有前提，见 D2）：runner 注入后走真实工具轮次 |

## 四、本轮发现的问题与修复状态

五项均已修复，另附一项顺带发现的连带缺陷（D6）。

### D1（已修）临时会话覆写 `activeSessionId`，导致用过 `/team` 之后会话断裂

`createSession` 无条件执行 `this.activeSessionId = sessionId`（`session.ts` 原 4200 行），
临时会话也不例外；而 `runEphemeral` 的 finally 又把它从会话索引删掉，留下**指向已删除会话的悬空指针**。

链路后果：

- Web：`session-pool.ts:1259` 每轮收尾 `chat.sessionId = getActiveSessionId()` → chat 绑定到已删除会话
  → 下一轮 `getSession()` 取不到 → 新建会话，用户体感「用过 /team 之后聊天失忆」。
- CLI：`getActiveSessionId()` 同样失效，下一轮另起会话。
- L2 并行：同层子任务并发建临时会话互相覆写，最终值不可预期。

修法：`ephemeral` 时跳过赋值（`activateSession` 内部全部以参数 `sessionId` 为准，未读该字段）。
用例：`src/tests/session-ephemeral-isolation.test.ts` E1~E4，含反向验证（回退修复后 E1/E3 必失败）。
提交：`7174b419`。

### D2（已修）`runEphemeral` 遇审批即中止，「能改代码」只在只读工具范围内成立

原行为：临时会话进入 `ask_permission` 直接判定 `aborted`，文案为「该任务需要人工审批，请在主对话中重试」。

**修法取舍**：不做「审批透传到前端」。理由是临时会话跑完即删，审批卡会成为指向已删会话的幽灵卡；
L2 并行时同时弹 N 张卡也不可用。改为**自动拒绝 + 明确告知**：

- `applyEphemeralAutoDeny`（`session.ts`）把残余 `askPermissions` 就地改判 `deny`，
  并生成模型可见的拒绝理由（「后台执行无人可批准，不要重试同一调用」）；
- `runEphemeral` 结果新增 `deniedTools`，`executeDispatch` 写 `dispatch/tool-result` 事件 + 进度播报
  「自动拒绝 N 项需人工审批的工具」，最终报告列出卡点；
- 真需要 dispatch 改代码的用户把 `permissions.mode` 设为 `bypass`（该模式不产生 ask，用例 AD-I03 锁定）。

用例：`src/tests/session-ephemeral-auto-deny.test.ts` AD-I01~I04。提交：`1d7d609d`。

### D3（已修）Web 没有 `/team` 入口，输出也没有专门样式

- 引擎侧：`/team` 的 system 消息统一带 `meta.teamCommand = { subcommand, phase }`
  （`progress` / `result` / `error`）并持久化——**不能靠 `【team】` 文本前缀识别**，
  因为最终结果 `result.stdout` 恰恰不带前缀，前缀方案会漏掉最需要辨认的那条。
- 服务端：`/api/capabilities` 新增 `commands` 字段（`buildTeamCommandDescriptors` 供给）。
- 前端：`chat-model.ts` 的 `parseTeamCommandMeta` / `stripTeamPrefix` + `kind: "team"` 条目，
  实时与历史两条路径归并；`ChatPane` 渲染左侧竖线卡片，error 阶段标红。
- 输入框：`Composer` 补斜杠补全（`parseSlashContext` / `buildSlashCandidates`，纯函数可单测），
  键盘优先级 slash > mention；描述里的 Markdown 星号在候选面板内被剥掉。

用例：`web/tests/team-entry.test.tsx`（11 项）、`web/tests/capability-commands.test.ts`（3 项）、
`src/tests/session-team-command.test.ts` A7/A8。提交：`c88f53a4`。

### D4（已修）技能扫描根硬编码 `os.homedir()`，与 per-user `homeRoot` 不一致

`SkillManager` 新增 `homeRoot` 注入，`AgentRegistryDeps` 与 `SessionManager` 装配处透传；
Web 侧新增 `src/engine-home.ts`，`capability-api` / `chat-api` / `rules-api` 三处统一走
`engineHomeForUser(settings, userId)`（`personalOnly` → `<engineHomeRoot>/<userId>`，否则进程家目录）。
CLI 不注入 → 回退 `os.homedir()`，行为零变化。

用例：`src/tests/skill-manager.test.ts` +2、`web/tests/engine-home.test.ts`（3 项）。
提交：`e07965e8`。

### D5（已修）临时会话重置主会话的 `turnGuard`

原实现是 `SessionManager` 上的**单实例字段**，`createSession` 开头无条件 `new TurnGuard(...)`。
临时会话也走 `createSession`，于是：

1. 派一次 dispatch 就把主会话累积的连续失败 / 循环检测签名清零（护栏静默失效一次）；
2. L2 并行 dispatch（`execute.ts:356`、`pattern-executor.ts:799` 都是 `Promise.all`）的多个临时会话
   **共享同一实例**，A 角色的连续失败会累到 B 角色头上，可能把 B 误判成「连续失败 / 空转」提前打断。

修法：改为 `Map<sessionId, TurnGuard>`，归属关系由单点方法 `turnGuardKey()` 定义
（`getOrCreateTurnGuard` / `resetTurnGuard` / `dropTurnGuard` / `getTurnGuardState` 全部走它）；
`cleanupSessionResources` 与 `runEphemeral` 的 finally 同步丢弃实例，避免 Map 常驻。
新增只读探针 `getTurnGuardState(sessionId)` 供诊断与测试断言。

用例：`src/tests/session-ephemeral-isolation.test.ts` E6/E7，含反向验证
（把 `turnGuardKey` 改回固定 key 模拟旧单实例语义，E6/E7 必失败、E1~E5 不受影响）。

### D6（已修，D2 的连带发现）`normalizeSessionEntry` 丢弃 `ephemeral` 标记

`ephemeral` 只在写侧落盘，读侧白名单重建时未保留 → `getSession()` 拿不到该标记，导致：
`listSessions()` 的临时会话过滤从上线起就失效（临时会话会出现在用户会话列表里），
D2 的自动拒绝分流同样判断不出来。已在 `normalizeSessionEntry` 末尾保留该字段，
用例 `session-ephemeral-isolation.test.ts` E5 锁定。

## 五、关于「群组聊天」

代码中不存在「多个智能体在同一会话里轮流发言」的机制。最接近的三种形态都是批处理：

| 形态 | 行为 | 用户可见性 |
| --- | --- | --- |
| `dispatch --consensus` | 5 角色并行各自评审 → LLM 聚合成一份共识报告 | 只有最终报告 + 进度行 |
| `auto`（L2） | 拆解 DAG → 分层并行 → 聚合成报告 | 进度行 `[i/n]`，无角色对话 |
| `autonomous` | 单角色 Ralph 迭代，直至收敛 | 迭代摘要 |

要做成「群聊」需要新增：多角色消息流（谁在说、说给谁）、发言调度、共享上下文窗口、
前端按角色分栏渲染。这是新功能，不是补接线。

## 六、后续

D1~D6 已按「先止血、再补面、后收口」的顺序修复完毕：

| 顺序 | 项 | 提交 |
| --- | --- | --- |
| 1 | D1 会话串线 | `7174b419` |
| 2 | 复核报告 | `a64d6393` |
| 3 | D2 审批边界 + D6 `ephemeral` 反序列化 | `1d7d609d` |
| 4 | D3 Web 入口与团队卡片 | `c88f53a4` |
| 5 | D4 per-user 扫描根 | `e07965e8` |
| 6 | D5 护栏按会话隔离 | 见本文件所在提交 |

仍然没有的：**群组聊天形态**（第五节）。它需要多角色消息流、发言调度、共享上下文窗口、
前端按角色分栏渲染，属新功能，不是补接线，应单独立项。
