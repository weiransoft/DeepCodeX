# Super Agent 上下文层增量方案（P3 · 修订版 v2）

> 状态：**已评审，据评审意见重写**。取代 `proposal-p3-context.md` v1。
> 日期：2026-11-03。
> 评审输入：架构师 6.5 / 测试专家 7.5 / PM 5.5 / 独立开发者 4.0 —— 四角色**全部有条件通过**，但 v1 有 4 处阻断性缺陷被三方独立指出。

---

## 0. 修订摘要：v1 为什么被推翻

v1 提了「新增 4 张表 + 改 9 个文件 + 6.7h」。评审后**全部推翻**，理由分两类：

### 0.1 v1 有 4 处硬缺陷（三方独立指出）

| # | 缺陷 | 证据 | v2 处置 |
|---|---|---|---|
| **D1** | **注入点 C 挂在 `engine/tickets.ts:endTicket`，但 Worker 终态路径绕过它** —— 归档 90% 落不了地 | `engine/assignments.ts:122` 直接调 `ctx.repos.endTicket(...)`；`engine/tickets.ts:endTicket` 只在 `engine/evals.ts:376`（人工喊停）被调 | **不做归档**（见 §0.2）——问题消失 |
| **D2** | **`renderPrompt` 每工单只调一次** → T13「第 2 轮 Worker 含上轮上下文」**不可达** | `worker/executor.ts:118` 是唯一调用点；第 2 轮走 `inject()` | T13 删除；改测可观测的替代面 |
| **D3** | **门禁要禁 `../../v2/*`，v1 又要复用 V2 类型** —— 自相矛盾，照做必 lint 红 | 实测 `no-restricted-imports` 的 `patterns` **不豁免 type import**，须 `allowTypeImports: true` | v2 **完全不依赖 V2**（自建 4 字段 `ContextSnippet`），矛盾消失 |
| **D4** | **中文逐字分词使 Jaccard 绝对值极小，时间维会盖过关键词维 → 排序反转** | 独立开发者实测：24h 半衰期下「无关但新」0.3557 > 「相关但旧」0.2615 | 改**两段式**：硬门槛过滤 + recency 只做 tiebreak（§4.2） |

### 0.2 v1 规模过大且与既有承诺冲突

| # | 问题 | 证据 | v2 处置 |
|---|---|---|---|
| **D5** | **`ticket_context` 表全文无写入方** → 死表 | v1 全文只有 DDL + 一个读方 + 一个测试 | **表删除**。任务层上下文改为**从既有表派生**（见 §3） |
| **D6** | **`memory_entry` 4 列是死字段**（`access_count`/`last_accessed_at`/`importance`/`scope` 无写入方；`scope` 恒 `'project'`） | 开发者逐列核对 | **表删除**。历史经验改为**从既有 `decision` 表派生** |
| **D7** | **与 R7「长程记忆首期明确不做」正面冲突且未声明** | `proposal-final.md:464` R7；`industry-research.md:281` | v2 **不建长程记忆库** → **R7 不重开**（见 §1.3） |
| **D8** | **用户可见交付物为零** | v1 文件清单里**没有一个 CLI 文件** | v2 增加 **`super memory` 只读展示** + **`super status` 补 4 个缺失计数**（§6） |
| **D9** | **评分公式 `importance` 维恒定、零区分度** | 所有条目 importance 都是 5 → 该维贡献恒 0.15 | 公式重写（§4.2） |

### 0.3 v1 漏诊的上游真实缺陷

四份评审中有两份独立发现（PM B1/S6、架构师 M1），且我已实测确认：

> **F1：`onInject` 从未接线 → 第 2 轮输入从未到达 LLM，但系统标记「已送达」。**

证据链：
1. `interrupts/background-runner.ts:272-305` 构造 `BackgroundTask` 时只传 `onStart` / `onStateChange`，**没有 `onInject`**；
2. `interrupts/background-task.ts:565` `if (this.callbacks.onInject)` → 生产环境**恒为 false** → `inject()` **静默无操作**；
3. `packages/core/src/super-agent/runtime.ts:437-443`：注入"成功"后仍执行 `markInputDelivered` → **输入被标记为已送达，实际从未到达 LLM**；
4. `packages/cli/src/super/super-worker.ts:110-117`：`onTaskComplete` 里 `launcher.forget(task.id)` → 再注入抛「找不到 assignment」。

**这比 P3 本身更紧急**：它意味着当前 Super Agent 的多轮能力**名义存在、实际不通**。v1 的「补上下文」是在给一条不通的管道接水源。

**v2 把 F1 列为 P3-0（前置修复）**——不修好它，任何上下文注入都无从验证。

---

## 1. v2 的定位与边界

### 1.1 一句话

**在零新表、零迁移的前提下，让 Super Agent 的 Router 能看到「历史上同类事件是怎么判的」，并让用户看得见。**

### 1.2 为什么不需要新表

v1 想建 `memory_entry` 存「历史经验」。但**这些数据已经在库里了**：

| v1 想存的 | 既有表已有 | 位置 |
|---|---|---|
| 历史上研判成什么 | `decision.kind` / `strength` / `reason` / `would_accept` / `at` | `store/schema.ts:123-132` |
| 当时的事件文本 | `trigger.text` / `source_id` / `actor` | `store/schema.ts:40-50` |
| 事件与 Thread 关联 | `trigger_thread` | `store/schema.ts:62-68` |
| 接单后发生了什么 | `ticket.latest_report` / `ended_reason` | `store/schema.ts:79-90` |

v1 的 `memory_entry` 本质是这四张表的**反规范化副本**。**不复制，直接查。**

### 1.3 R7 不重开

`proposal-final.md:464` R7：「长程记忆未解｜**首期明确不做**」。

v2 **不建长程记忆库、不做跨月记忆、不做向量检索**。它做的是**读取既有历史做相似召回**——读已有的 `decision` 表，与「建一个新的长期记忆存储」是两件不同的事。

**边界**：召回窗口 = 最近 N 条决策（N 默认 50），不跨项目，**不产生新的持久化状态**。这与 R7 不冲突。

---

## 2. 现有双层上下文机制（复用判定，已核实）

沿用 v1 §1 的调研结论，**结论不变**：

| V2 组件 | 判定 | 理由 |
|---|---|---|
| `v2/context/types.ts` 的 interface | ❌ **不复用** | v1 说「直接复用」被架构师 S8 推翻：语义错位（V2 是**对话任务**上下文，Super Agent 是**工单**上下文）+ 门禁矛盾。v2 **自建 4 字段 `ContextSnippet`**。 |
| `v2/integration/session-hook.ts` `ContextSnippet` | ❌ **不复用** | 同上；自建 4 字段（`type`/`content`/`source`/`relevance`），零依赖。 |
| `v2/context/relevance-scorer.ts` | 🟡 **只搬 Jaccard 段** | `:47` 值导入 `v1-adapters` barrel → 传递性拉入 `node:fs`/`node:child_process`。算法（`:319-350`）纯计算可搬。 |
| `v2/context/dual-layer-manager.ts` | 🟡 **只搬双通道结构** | `:412-418` 双通道 + `:563-582` 预算切分。 |
| `v2/context/global-context.ts` | ❌ **不复用** | `:29` `node:fs`；落 `~/.deepcode/global-context.json`。 |
| `v2/context/task-context-manager.ts` | ❌ **不复用** | `:76` 纯内存，`:413` archive 即 delete——与「跨进程存活」冲突。 |
| `v2/memory/experience-recommender.ts` | ❌ **不复用** | 同 barrel 问题；`:298` 每次全量 `fit()`。 |
| `team/workflows/semantic-embedder.ts` `tokenize` | 🟡 **内联函数体** | `:103-142` 共 36 行；函数体零依赖（`node:crypto` 是**文件级** import，服务于同文件其他 embedder）。 |

**新增搬运清单**：

| 搬运项 | 源 | 去向 | 行数 |
|---|---|---|---|
| `tokenize` | `semantic-embedder.ts:103-142` | `super-agent/domain/tokenize.ts` | 36 |
| Jaccard 匹配 | `relevance-scorer.ts:319-350` | `super-agent/domain/recall.ts` | ~30 |
| 时间衰减 | `relevance-scorer.ts:352-369` | `super-agent/domain/recall.ts` | ~15 |
| CJK 感知 token 估算 | `eag/rlis/rule-injector.ts:196-202` | `super-agent/domain/recall.ts` | 6 |
| 双通道 + 预算切分 | `dual-layer-manager.ts:412-418`、`:563-582` | `super-agent/engine/context.ts` | ~40 |

> **token 估算口径**：不用 v1 自造的 `length/2`，也不用 V2 的 `length/4`（中文被低估 4 倍）。用仓库既有的 CJK 感知口径 `ceil(cjk + nonCjk/4)`（`rule-injector.ts:196-202`，该处注释记录了「中文被低估约 4 倍」的教训）。

---

## 3. 设计

### 3.1 双层映射（修正 v1）

| V2 双层 | Super Agent v2 | 存储 | 生命周期 |
|---|---|---|---|
| **GlobalContext**（全局层） | **历史研判经验**——同类事件过去被判成什么、为什么 | **既有 `decision` ⋈ `trigger_thread` ⋈ `trigger`**（派生，不落库） | 随决策累积，永久可查 |
| **TaskContext**（任务层） | **当前工单上下文**——授权范围、待办、最近报告 | **既有 `ticket` + `ticket_input` + `attention` + `assignment`**（派生，不落库） | 随工单生命周期 |

**关键差异（v1 没说清）**：V2 的两层是**存储**（要落盘/落表）；Super Agent 的两层是**投影**（从既有事实派生的只读视图）。这正是「零新表」能成立的原因。

### 3.2 任务层上下文（Ticket Context）

**不建 `ticket_context` 表**。任务层内容全部从既有表派生：

| 上下文内容 | 来源 | 说明 |
|---|---|---|
| 授权范围 | `ticket.mandate.scope` | 必注入 |
| 未决待办 | `repos.listOpenAttention(ticketId)` | 必注入 |
| 待投递输入 | `repos.listPendingInputs(ticketId)` | 必注入 |
| 最近报告 | `ticket.latest_report` | 必注入（最新一条） |
| 历史报告 | `assignment.report`（每个 Assignment 一条） | **既有表已保留全部 Assignment 的报告**——不需要新表！ |
| 工单状态 | `ticket.state` / `ended_reason` | 必注入 |

> **v1 的 D5 是误判**：`assignment` 表本就一 Assignment 一行（`schema.ts:94-103`），每次报告覆盖的是**该 Assignment 的** `report` 字段（`repositories.ts:552-583`），而**重试会产生新的 Assignment**（`proposal-final.md` §2）。历史报告链天然存在。

### 3.3 全局层上下文（历史经验召回）

**不建 `memory_entry` 表**。召回流程：

```
Router 研判一个候选 Thread
  ↓
从既有表查该 Source 近期 N 条历史决策（decision ⋈ trigger_thread ⋈ trigger）
  ↓
用候选的 trigger 文本作 query，逐条算 Jaccard
  ↓
硬门槛过滤（Jaccard < 0.05 直接丢弃）—— 防止 D4 的排序反转
  ↓
通过门槛的按 totalScore 排序，取 Top-K
  ↓
作为「历史经验参考」注入 Assessment prompt
```

**召回 query**：候选批次的 trigger 文本拼接（`candidate.triggers.map(t => t.text).join("\n")`）。

### 3.4 注入点（修正 v1）

| 注入点 | 位置 | 内容 | 改动 |
|---|---|---|---|
| **A（保留但重定义）** | `worker/executor.ts:135-166` `renderPrompt` | 「## 工单上下文」段：授权范围 + 待办 + 最近报告 + 历史报告摘要 | 加第 6 段。**T13 改为验证「首轮 prompt 即含本工单上下文」**——不再断言「第 2 轮」（D2） |
| **B（路线改小）** | `router/assessment.ts` | 「## 历史经验参考」段 | **不改 `EvalCandidate`**。在 `LlmAssessorOptions`（`assessment.ts:62-69`，本就是为注入预留的）加 `recall?: (query: string) => readonly HistoricalDecision[]` 端口；`assess()` 内先 recall 再传给 `renderCandidate` |
| **C（删除）** | ~~`engine/tickets.ts`~~ | — | **不做归档**（D5/D6/D7）。历史经验由 `decision` 表天然承载 |

> **为什么注入点 B 不改 `EvalCandidate`**：改它要动 `domain/types.ts:236-243` + `engine/evals.ts:69-74`（唯一构造点）+ `router/router.ts:108` + `core/src/index.ts` + `super-agent/index.ts` + `cli/super/super-cmd.ts` + 2 个测试文件 = **8 个文件**，v1 一个都没列。走 `LlmAssessorOptions` 只需 **2 个文件**（`assessment.ts` + `runtime.ts:201`）。

### 3.5 相关性评分（重写，修 D4/D9）

**两段式**，不是单一线性加权：

```
阶段一 · 相关性门槛（硬过滤）
  jaccard(query, decision.reason + trigger.text) < 0.05  →  丢弃

阶段二 · 排序（通过门槛的条目）
  totalScore = 0.65 * jaccard + 0.15 * recency + 0.20 * kindWeight
  recency = 0.5 ^ (elapsedMs / halfLifeMs)，halfLife = 30 天（历史经验的时效语义，不是 V2 的 30 分钟文件访问衰减）
  kindWeight: accept=1.0 / ignore=0.6 / stop=0.4 / unavailable=0.2
    （accept 的历史最值得参考——它代表「这类事件确实该接」）
```

**为什么这样能修 D4**：D4 的根因是 recency 维摆幅（0.2）远大于关键词维实际摆幅（中文逐字分词下 Jaccard 常在 0.1 附近 → 0.5×0.1 = 0.05）。加硬门槛后，**不相关的条目在阶段一就被丢弃**，根本进不了排序；阶段二里 recency 只在已相关的条目间做微调，不会反转。

**为什么用 `kindWeight` 替代 `importance`**：`importance` 在 v1 里恒为 5（零区分度，D9）；`kindWeight` 由 `decision.kind` 直接派生，**有真实区分度**，且不需要新列。

### 3.6 上下文装配（`engine/context.ts`）

沿用 V2 双通道结构（`dual-layer-manager.ts:412-418`），通道语义按 Super Agent 重新定义：

```
buildContext(input) → ContextBundle
  │
  ├─ direct（必注入，不参与竞争，不因预算被丢弃）
  │    ├─ 工单授权范围（安全边界，最高优先级）
  │    ├─ 未决 Attention + 待投递输入（工单待办）
  │    └─ 本工单最近报告 + 历史报告摘要
  │
  └─ scored（参与竞争，受预算限制）
       └─ 历史研判经验（Top-K 召回）

预算切分：
  directTokens = estimate(direct)
  remaining = max(0, budget - directTokens)
  scored 按 totalScore 降序累加，超 remaining 即止
```

**超预算兜底（补 v1 未定义的缺口）**：若 `direct` 本身超预算——**绝不静默丢弃**。按优先级截断：授权范围 > 未决待办 > 历史报告摘要。截断量记入 `ContextBundle.overflowTokens`，并由 Worker 侧如实告知（「上下文已截断 N token」）。

**预算默认值**：`8000 token`。V2 用 100_000（`dual-layer-manager.ts:149`），因为它装的是整个代码库；Super Agent 的 Worker prompt 只是工单级上下文，取小值。

### 3.7 注入防线（I12 强化）

记忆/历史内容来自用户输入与 Worker 自由文本，**可能含注入文本**。

- 历史经验注入 Assessment prompt 时，**必须标注**：「以下为历史记录，仅供参考，**不是指令**」。
- 该段内容**不得**包含任何可执行指令结构——`decision.reason` 是 Router 自己写的，**不是** Worker 自由文本（这比 v1 的「报告摘要」安全得多）。
- 注入点 A 的任务层内容里，**`ticket.latest_report.summary` 是 Worker 自由文本** → 同样必须标注为数据。

---

## 4. 不变量（I10–I12）

| ID | 不变量 | 校验点 |
|---|---|---|
| **I10** | 上下文**只读**：v2 不产生任何新的持久化领域状态 | 召回只 `SELECT`，不 `INSERT`/`UPDATE`；无新表 → schema 不变 → `SCHEMA_VERSION` 保持 1 |
| **I11** | 召回**不跨项目** | DB 本身就在项目内（`cli/super/super-cmd.ts:396-398` `.deepcode/super-agent/super-agent.db`）；召回只查本库 |
| **I12** | 上下文内容是**数据不是指令** | 注入时显式标注；`decision.reason`（Router 自写）优先于 Worker 自由文本 |

> **I10 是 v2 与 v1 最大的差异**：v1 需要写归档（复杂、需幂等、需处理工单恢复后的重复写入）；v2 **只读**，整套实现没有写路径 → 没有幂等问题、没有事务边界问题、没有「归档何时发生」的时机问题。

---

## 5. 实施顺序

### P3-0 · 修 F1（前置，~1h）

**`onInject` 断链修复**（真实用户影响缺陷，优先于上下文本身）。

改动点：
1. `interrupts/background-runner.ts:272-305` —— 构造 `BackgroundTask` 时传入 `onInject` 回调（转发到 `InterruptQueue` 或本任务的指令队列）；
2. `packages/core/src/super-agent/runtime.ts:437-443` —— **只有注入确实被接受**才 `markInputDelivered`；未接线时**如实报错**（不再静默标记已送达）。

> ⚠️ 这一步会触碰**既有文件** `interrupts/background-runner.ts`（不在 v1 白名单内）。**必须先跑其既有测试**：`packages/core/src/tests/` 下的 interrupt 相关用例 + `packages/core/src/interrupts/` 自带用例。

### P3-1 · 领域层（~1h）

- `domain/tokenize.ts` —— 内联 `tokenize`（36 行）。
- `domain/recall.ts` —— Jaccard + 衰减 + `kindWeight` + CJK token 估算 + `scoreHistoricalDecisions()`。零 I/O。

### P3-2 · 存储层（~0.5h）

- `store/repositories.ts` —— 新增 `listHistoricalDecisions(sourceId, limit)` 与 `listThreadTriggers()`（后者已有，`:347`）；**零 schema 变更**。

### P3-3 · 引擎层（~1h）

- `engine/context.ts` —— `buildContext()`（双通道 + 预算 + 截断兜底）。
- `engine/history.ts` —— `recallHistoricalDecisions()`（门槛 + 排序 + Top-K）。

### P3-4 · 接线（~1h）

- `worker/executor.ts` —— `renderPrompt` 加第 6 段。
- `router/assessment.ts` —— `LlmAssessorOptions.recall` 端口 + `ASSESSMENT_SYSTEM_PROMPT` 加占位符 + `renderCandidate` 加标注。
- `runtime.ts` —— 装配 recall 实现。

### P3-5 · CLI（~1h）—— **用户可见交付物（补 D8）**

- **新增 `super memory`** —— 只读列出历史研判经验（可按 Source 过滤）。这是用户能看到「系统记住了什么」的唯一出口。
- **`super status` 补 4 个缺失计数** —— PM 审计发现 `proposal-final.md` 承诺但未兑现：
  - `routed_via_subscription`（G4，**全仓 0 命中，确实不存在**）——由 `disposition.kind === 'fanned_out'` 计数；
  - 候选数（今日新增候选）；
  - 未决 Attention 数；
  - 累计 token（Worker 侧估算）。

### P3-6 · 门禁（~0.3h）

- `eslint.config.mjs` —— `files` 扩到 `router/**` + `worker/**`（当前不含，注入点 A/B 不受约束）；
- 补 `../../v2/*` 禁列 + `allowTypeImports: true`（防未来的传递性 fs 传染）；
- 补 `node:sqlite` 静态 import 禁列 + `no-restricted-syntax` 禁内核目录内的动态 `import()`（当前 `no-restricted-imports` 拦不住动态导入）。

### P3-7 · 测试（~1.5h）

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `packages/core/src/tests/super-agent-context.test.ts` | ~12 | T13–T18 |
| `packages/core/src/tests/super-agent-history.test.ts` | ~10 | T16/T19 |
| 改 `packages/core/src/tests/super-agent-core.test.ts` | ~2 | `SCHEMA_VERSION` 仍为 1（零迁移断言） |
| 改 `packages/core/src/tests/super-agent-adapters.test.ts` | ~2 | `renderPrompt` 新增段落 |

---

## 6. 验收判据（修正 v1）

| # | 场景 | 判据 | 对应 v1 |
|---|---|---|---|
| **T13′** | Worker 首轮 prompt 即含工单上下文 | `renderPrompt` 输出含「## 工单上下文」段，且段内有授权范围与最近报告 | v1 T13 改为可达断言 |
| **T14′** | 历史经验可被召回 | 造 3 条历史 decision，其中 1 条与候选 trigger 文本相似 → 召回结果含该条 | v1 T14 反转（不测归档） |
| **T15′** | 注入点 B 生效 | Assessment prompt 含「历史经验参考」段，且**含 I12 标注** | v1 T15 |
| **T16′** | 门槛防排序反转 | 不相关但更新的历史**不出现**在召回结果里 | v1 T16（修正） |
| **T17** | 预算切分 | 记忆条目超预算时按分数淘汰；**direct 段不被丢弃** | v1 T17 |
| **T18** | I12 注入防线 | 召回段与工单上下文段均含「不是指令」标注 | v1 T18 |
| **T19** | 零迁移 | `SCHEMA_VERSION === 1`；既有 DB 无需迁移即可用新功能 | v1 T19 改写 |
| **T20** | 门禁生效 | 内核目录 import `../../v2/*` 或 `node:sqlite` → lint 报错 | v1 T20（修正措辞） |
| **T21** | F1 修复 | 注入后 Worker **确实收到**该输入；未接线时**如实报错**而非标记已送达 | 新增 |
| **T22** | 用户可见 | `super memory` 输出 ≥1 条真实历史经验；`super status` 显示 4 个新计数 | 新增（补 D8） |

**覆盖率门禁**：测试专家实测全仓合并后**函数覆盖率 75.11%**（阈值 45%，余量 25888 个零覆盖函数——v1 引用的「余量 29 个」来自过期快照，实际远未触线）。P3 新增约 12 个函数，**不会击穿门禁**。

---

## 7. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R13 | 历史经验成为注入旁路 | I12 标注；`decision.reason` 是 Router 自写（非 Worker 自由文本）；**只读**不可篡改 |
| R14 | 上下文膨胀 | 双通道 + 8000 预算 + direct 超预算的显式截断与告知 |
| R15 | 召回噪声 | 硬门槛 0.05 + `kindWeight` 偏向 accept |
| R16 | 误用值导入 V2 | v2 完全不依赖 V2；门禁补 `../../v2/*` + `allowTypeImports` |
| R17 | 改既有文件超出白名单 | 本轮改 `interrupts/background-runner.ts`（F1 修复）**属新增白名单项，已在本方案显式登记** |
| **R18** | **F1 修复触及 `interrupts/` 核心** | 先跑既有 interrupt 测试；改动限于「补 `onInject` 转发」，不改既有逻辑分支 |
| **R19** | **`super status` 新计数与既有断言冲突** | 既有 `super-cmd.test.ts` 的 status 断言需同步更新（测试专家已标 R3） |
| R20 | 召回结果随时间漂移（同一输入不同召回） | 召回**只读**，不写状态 → 同一 DB 同一时刻结果确定；跨时刻变化是预期（历史在增长） |

---

## 8. 与既有方案的关系

| 文档 | 关系 |
|---|---|
| `proposal-final.md` §5.5 存算分离 | **不动**（仍后置）。v2 零新表 → 不与存算分离耦合 |
| `proposal-final.md` §5.6 Watchdog | **不动** |
| `proposal-final.md` R7 长程记忆 | **不重开**（§1.3） |
| `proposal-final.md` G4 `routed_via_subscription` | **本轮补上**（P3-5）——承诺过但未实现 |
| `proposal-final.md` G2′ `matched_rules` 落库 | **本轮不补**（需 schema 变更，与「零迁移」冲突）——记为遗留 |
| `proposal-final.md` §12.5 遗留 | 完整 agentic Worker、多 Channel 写侧 —— **仍后置**；本轮先修其前置（F1） |

---

## 9. 范围对比

| 维度 | v1 | **v2** |
|---|---|---|
| 新增表 | 4 张 + schema v2 迁移 | **0 张，0 迁移** |
| 新增文件 | 7 | 4（`domain/tokenize.ts`、`domain/recall.ts`、`engine/context.ts`、`engine/history.ts`） |
| 改动既有文件 | 9 | 8（含 `interrupts/background-runner.ts`） |
| CLI 交付物 | **0** | **2**（`super memory` + `super status` 补计数） |
| 写路径 | 有（归档，需幂等 + 时机处理） | **无（全只读）** |
| 估算工作量 | 6.7h（独立开发者估 10–12h） | **~6h**（含 F1 修复与 CLI 交付） |
| 关闭的阻断项 | — | D1–D9 全部 |

---

## 10. 开放问题

- **O7**：是否需要 LLM 语义召回？**否**——沿用 V2 的判断（`relevance-scorer.ts:24-27` 注明「单文档评分时 IDF 退化为 1，无区分度」），用 Jaccard + 硬门槛。
- **O8**：跨项目经验？**否**——沿用 V2「需求121」的保守立场。
- **O9**：记忆的人工编辑入口？**本轮只做只读展示**（`super memory`），不做编辑/删除——先让用户看得见，再谈可撤销。
