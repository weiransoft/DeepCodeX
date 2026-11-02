# 动态组队 / 智能体群组接线复核（2026-11-02）

- 复核范围：`packages/core/src/{session.ts,commands/**,team/**,agents/role-bridge.ts}`、`packages/cli/src/team/**`、`packages/web/{src,web/src}`
- 复核方法：入口 → 分发 → 执行体 → 工具能力 → 呈现，逐跳下钻；每跳给出行号级证据
- 前序报告：`docs/team-wiring-audit-20261101.md`（当时结论：CLI 满、Web 零、专家死代码、双轨制）

## 一、结论

**动态组队（`/team` 六个子命令）已全线贯通到执行体，Web 与 CLI 共用同一套代码。**
11-01 报告里的四项硬伤（Web 无执行体、专家死代码、候选集不可扩展、dispatch 无工具）均已消除。

**但「智能体群组聊天」在当前代码里没有对应实现。** 不是接线断了，是形态不存在：
所有多角色协作都是「一次请求 → 后台批处理 → 一份报告」，用户看不到多角色对话流。

仍有 4 处「接线通、能力受限」，其中 1 处会话串线已修，另 3 处见第四节。

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
| Web 命令描述符 | ⚠️ | `session-pool.ts:694` 注入，但**只进建议层 prompt**（`session.ts:5682`），不是 UI 面板 |
| Web 前端入口 | ❌ | 前端 `web/web/src` 对 `team` **零引用**，无按钮/无补全，只能手敲 |

## 三、11-01 报告四项硬伤的现状

| 原问题 | 现状 |
| --- | --- |
| Web 敲 `/team` 静默降级投给模型 | 已消除：core 两级拦截，两个宿主同一份执行体 |
| 专家子系统死代码 | 已消除：`index.ts` 导出 + `executeDispatch` 内注入 |
| 候选集只有 5 个硬编码角色 | 已消除：`role-bridge` 把 35 个 `type: agent` 映射为运行时角色 |
| `dispatch` 无工具循环 | 已消除（有前提，见 D2）：runner 注入后走真实工具轮次 |

## 四、仍然存在的 4 个问题

### D1（已修）临时会话覆写 `activeSessionId`，导致用过 `/team` 之后会话断裂

`createSession` 无条件执行 `this.activeSessionId = sessionId`（`session.ts` 原 4200 行），
临时会话也不例外；而 `runEphemeral` 的 finally 又把它从会话索引删掉，留下**指向已删除会话的悬空指针**。

链路后果：

- Web：`session-pool.ts:1259` 每轮收尾 `chat.sessionId = getActiveSessionId()` → chat 绑定到已删除会话
  → 下一轮 `getSession()` 取不到 → 新建会话，用户体感「用过 /team 之后聊天失忆」。
- CLI：`getActiveSessionId()` 同样失效，下一轮另起会话。
- L2 并行：同层子任务并发建临时会话互相覆写，最终值不可预期。

修法：`ephemeral` 时跳过赋值（`activateSession` 内部全部以参数 `sessionId` 为准，未读该字段）。
用例：`src/tests/session-ephemeral-isolation.test.ts` 4 项，含反向验证（回退修复后 E1/E3 必失败）。

### D2（未修）`runEphemeral` 遇审批即中止，「能改代码」只在只读工具范围内成立

`session.ts:4318-4320`：临时会话进入 `ask_permission` 直接判定 `aborted`，说明文案为
「该任务需要人工审批，请在主对话中重试（临时运行无法接收审批交互）」。

这意味着 `dispatch` / `auto` / `consensus` 的角色一旦要写文件或执行需审批命令，任务即中断。
`toolCapable` 标记存在（`team-command.ts:702`），但能力边界被审批卡死。

连带 UI 风险：`session-pool.ts:765` 的 `onSessionEntryUpdated` 会把临时会话的 `askPermissions`
推成 status 帧 → 前端弹出审批卡；而临时会话随即被清理，**用户点卡片时已无会话可 resolve（幽灵卡片）**。

### D3（未修）Web 没有 `/team` 入口，输出也没有专门样式

- 描述符只喂给 LLM 建议层（`session.ts:5682` `listAvailableCommands`），前端不消费；
  `Composer` 无斜杠补全，用户必须事先知道语法。
- `/team` 输出走 `buildSystemMessage(..., meta=null)`，前端 system 分支不认它，
  落到兜底助手气泡——团队报告看起来像「模型自己说的」，与 `contextLoad` 的处理不一致。

### D4（未修）技能扫描根硬编码 `os.homedir()`，与 per-user `homeRoot` 不一致

`skill-manager.ts:103` 用 `os.homedir()`，而 `session.ts:1697` 的 `homeRoot = options.homeDir ?? os.homedir()`。

Web `personalOnly` 模式下 settings 走 per-user engine-home，skills 却扫真实主目录：
单机桌面端无害（预置确实在主目录），**多用户部署时用户 A 的自建智能体会进入用户 B 的 `/team` 候选集**。
`/api/capabilities` 走同一扫描链，属既有的隔离不一致，非本轮引入。

### D5（观察，未修）临时会话重置主会话的 `turnGuard`

`session.ts:4034` 在 `createSession` 开头无条件 `this.turnGuard = new TurnGuard(...)`。
临时会话会清空主会话的连续失败/重复调用/空转计数，护栏被临时放宽。
改法需要「每会话一个 guard」的设计，不适合顺手改，先记录。

## 五、关于「群组聊天」

代码中不存在「多个智能体在同一会话里轮流发言」的机制。最接近的三种形态都是批处理：

| 形态 | 行为 | 用户可见性 |
| --- | --- | --- |
| `dispatch --consensus` | 5 角色并行各自评审 → LLM 聚合成一份共识报告 | 只有最终报告 + 进度行 |
| `auto`（L2） | 拆解 DAG → 分层并行 → 聚合成报告 | 进度行 `[i/n]`，无角色对话 |
| `autonomous` | 单角色 Ralph 迭代，直至收敛 | 迭代摘要 |

要做成「群聊」需要新增：多角色消息流（谁在说、说给谁）、发言调度、共享上下文窗口、
前端按角色分栏渲染。这是新功能，不是补接线。

## 六、建议顺序

1. **D2**：让 `runEphemeral` 支持审批透传（前端卡片 → `resolvePermission` → 继续），
   或在 dispatch 前把 `permissions.mode` 降为只读并明确告知用户能力边界。二者都别留「幽灵卡片」。
2. **D3**：`/team` 输出的 system 消息补 `meta.teamCommand` 标记，前端渲染成专用卡片
   （可复用 `contextLoad` 的折叠模式）；`Composer` 补 `/team` 前缀补全。
3. **D4**：`SkillManager` 接受注入的 `homeDir`，与 `SessionManager.homeRoot` 同源。
4. **D5**：`turnGuard` 按 sessionId 隔离。
5. 若要「群聊」，单独立项（见第五节）。
