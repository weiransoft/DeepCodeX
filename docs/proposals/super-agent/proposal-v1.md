# DeepCodeX Super Agent 架构方案 v1

> **日期**：2026-11-03
> **作者**：多智能体团队（Phase 1）
> **状态**：待四角色交叉评审（Phase 2）
> **调研依据**：[`industry-research.md`](./industry-research.md)
> **代码基线**：`/Users/wangwei/Documents/VG/DeepCodeX-cli` @ v0.4.5（packages: cli / core / quality / vscode-ide-companion / web）

---

## 0. 一句话结论

DeepCodeX 已有 Super Agent 的**全部执行侧零件**（角色团队、Goal DAG、Ralph 循环、worktree 隔离、子代理沙箱、审批闸、动态上下文窗口、证据链、MCP），但**缺一副骨架**：没有常驻路由、没有事件入口、没有任务级授权、没有事务型领域状态。本方案新增一个 `super-agent` 模块层，用 **Engine 唯一写入者 + 事务/副作用分离 + 两级过滤 + 订阅直通 + 结构化注意力** 五条不变量，把既有零件组装成「**一个人只对接一个助手，助手背后多路并行推进**」的 DeepCodeX Super Agent。

---

## 1. 目标与非目标

### 1.1 目标（可验收）

| # | 目标 | 验收标准（量化） |
|---|---|---|
| G1 | **一个入口，多路并行** | 单次 `deepcode super start` 后，可同时存在 ≥3 个 Ticket 并行推进，人只与 Router 交互 |
| G2 | **主动而非被动** | 无人工下指令时，Router 能依据准入规则 + LLM 研判自主创建 Ticket（`observe` 模式只记录 `would accept`，`auto` 模式才真接单） |
| G3 | **事件驱动** | Source 推入 Trigger → 自动进入 Thread → 触发 Eval → 产出 Decision，全程无需人工 |
| G4 | **订阅直通** | Worker 接手 Thread 后，后续 Trigger **不经 Router 重决策**，直接扇出到该 Ticket |
| G5 | **人只在验收点被打扰** | 只有结构化 `Attention` 事件唤醒 Router；其余消息「只注入不唤醒」 |
| G6 | **崩溃可恢复** | 进程被杀重启后，未结束 Ticket / Assignment / Effects 队列**状态不丢、可续跑** |
| G7 | **既有资产零重写** | 本方案**不重写** `team/`、`eag/`、`v2/`、`agents/` 任何既有模块；仅新增 + 接线 |

### 1.2 非目标（明确不做）

- ❌ 企业级云托管 / VPC / 私有化部署 → WorkBuddy WMA 已产品化（[调研 §3](./industry-research.md#3-workbuddy-新助手连接与业务系统层)）
- ❌ 跨设备远程操控 / 语音下发 → Trae 已产品化
- ❌ 引入 Cordis / dsh 运行时依赖 → **继承既有 Q6 硬决策**（`docs/research/dsh-analysis-20261027.md`）
- ❌ 完整 MCP Server 实现 → 首期只做 MCP **客户端**事件源接入
- ❌ 长程记忆（跨月）→ DeepSeek 官方承认未解，本方案首期只做**会话内引用图**
- ❌ 改写 `team/` 既有编排 → 复用，不动

---

## 2. 设计原则（继承自 DeepSeek Super-agent 的可复用不变量）

> 这一节是本方案的**核心资产**。九条不变量全部有 DeepCodeX 的落地位置。

| # | 不变量 | DeepCodeX 落地方式 |
|---|---|---|
| **I1** | **Engine 是领域状态的唯一写入者** | `super-agent/engine/engine.ts` 独占 Triggers/Threads/Decisions/Tickets/Assignments 的写权；对外只暴露角色受限的 `Pick<Engine, ...>`（`EngineForSources` / `EngineForRouter` / `EngineForWorker` / `EngineForPeople` / `EngineForSettings`） |
| **I2** | **事务与副作用严格分离** | `Store.atomic()` 内只改状态；外部动作经 `afterCommit` + 持久化 **Effects 队列**执行（按 `kind/key` 合并、指数退避、`Later` 延期语义） |
| **I3** | **Source 只拥有自己的数据** | Source 改领域的唯一途径是 `SourceContext.tickets.bindThread` / `threadClosed`；不得直接写 Ticket 字段 |
| **I4** | **Router 是批量命令编排器** | 一次可提交 1–20 个 Decision，**逐项独立执行，单项失败不阻断后续** |
| **I5** | **Worker 与 Router 仅经 Engine + Effects 通信** | Worker 不能直接调 Router 的 session；只能 `orchestrator_report` 回报 |
| **I6** | **SQLite 是事实来源** | 复用根 `package.json` 已有 `optionalDependencies.better-sqlite3`；生成列（`thread.active` / `ticket.open` / `ticket.active`）+ 索引支撑活跃扫描 |
| **I7** | **依赖方向单向** | `super-agent/core/**` 不做 I/O、不依赖 `super-agent/app/**`；`super-agent/source/**` 不依赖 `super-agent/app/**` |
| **I8** | **noWait 限制** | Router 的 shell 命令含 `sleep` 拒绝、`timeoutMs > 30s` 拒绝、`job_output` 等待 > 5s 拒绝（结果会自动投递） |
| **I9** | **消息注入的唤醒语义分级** | 唤醒 = `candidate` / `follow_up` / `worker_report` / `worker_attention`；只注入 = `ticket_ended` / `settings_saved` / `policy_changed` / `trigger_requeued` / `subscription_dropped` |

### 2.1 本方案新增的 DeepCodeX 专属原则

| # | 原则 | 说明 |
|---|---|---|
| **D1** | **默认审批在位** | DeepSeek 原型的 Worker **以运维者系统用户身份免审批执行命令**（其 README 自陈风险）。DeepCodeX **必须默认走 `v2/approval` 审批闸**，除非显式 `--trust-worker` 开启且记录到台账 |
| **D2** | **诚实降级** | `better-sqlite3` 缺失 → 明确报错并给出安装命令，**绝不用内存假 Store 冒充持久化** |
| **D3** | **flag 默认 off** | 所有新能力（主动接单、auto 模式、Watchdog 自愈）默认关闭，需显式开启 |
| **D4** | **单一真相源** | Super Agent 领域状态**只存 SQLite**，不与 `team/` 的 `run-state.json` 双写 |

---

## 3. 领域模型

### 3.1 概念表

| 概念 | 定义 | 守则 |
|---|---|---|
| **Source** | 事件流。kind = 可复用实现；instance = 一份配置 | 持读游标（重启不重放）；丢弃自身消息；把 Trigger 翻译为 Thread 归属与回复地址 |
| **Trigger** | 一个不可变事件 | 幂等：同一 Trigger 接受两次**只产生一个 Ticket**；归属一个或多个 Thread |
| **Thread** | 按时间排序的 Trigger 序列 | 同一时刻至多一个 Eval 运行；可持多个 Ticket；持 Subscriptions 与 Decision 历史 |
| **Correlation** | 共 Trigger 的 Thread 关系 | **只加上下文，绝不路由** |
| **Channel** | Thread 的写侧（回复地址） | 一个 Thread 可多个 Channel；Ticket 持一组 |
| **Policy** | 版本化的准入与评估规则 | 版本覆盖规则 + accept 模式 + 各 Source 部分；变更**不撤销**存量 Mandate，只投递通知 |
| **Eval** | 对一批 Trigger 的判断，两层：**Gate（确定性准入）→ Assessment（LLM 研判）** | **无状态**；输出 Decision |
| **Mandate** | 一次 accept 授予的授权：Policy 版本 + 范围 + 强度 + 匹配规则 + 请求者身份 | **不可变**；范围变宽 = 新 Ticket；**只有三种撤销路径**：① accept 创建 ② 人喊停 ③ Policy 复验失败 |
| **Ticket** | 一份被授权的工作单元 | **只有 Eval 能创建**；状态自定（不跟随 Worker）；`open → ended`，人消息可恢复 |
| **Assignment** | Ticket ↔ 一个 Worker 实例的绑定 | 一个 Ticket 生命周期内可有多个；`pending → running → ended`；只有最终报告能终结 Ticket |
| **Subscription** | Ticket ↔ Thread 多对多 | 匹配 Trigger **扇出**给订阅中的 Ticket，**不检查发送者、不新增授权**；已结束 Ticket 保留订阅 → 人的消息**无需新 Eval** 直接恢复 |
| **Attention** | Ticket 上等待人回答的**结构化问题** | 🔴 **不得从报告自由文本推断**（DSH 明确拒绝该做法）；必须有结构化字段 |
| **Report** | Assignment 向 Ticket 汇报的状态 | 六值：`progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` |

### 3.2 Decision / Strength / 状态机

```
Decision:  accept 接单 | stop 停止 | ignore 忽略 | unavailable 未完成
Strength:  explicit 明确 | inferred 推断
Assignment: pending 待启动 → running 执行中 → ended 已结束
Ticket:    open → ended（人消息可恢复，除非被人 stop）
Eval 超时: 第 1 次过期 → requeue；第 2 次 → requeue；第 3 次 → Decision=unavailable
```

### 3.3 accept 模式三档（**默认 observe**）

| 模式 | 行为 |
|---|---|
| `off` | 推断型一律不成为候选 |
| `observe`（**默认**） | 推断型候选会被研判；研判通过**只记录为 `would accept`**，不接单 |
| `auto` | 研判通过即接单 |

> 显式请求（白名单内的人 @ 了机器人 / 已在有 Ticket 的 Thread 上追问）在**任何模式**下都有效。

---

## 4. 架构分层

```
┌──────────────────────────────────────────────────────────────────────┐
│  接入层 (app)                                                        │
│  runtime.ts(组合根) │ passes.ts(周期调度) │ effects.ts(副作用队列)   │
│  watchdog.ts(外部监督) │ router/ (LLM研判+路由决策)                  │
│  cli/ (面板与命令)  │ web/ (只读面板 API)                            │
├──────────────────────────────────────────────────────────────────────┤
│  领域层 (core) —— 零 I/O                                             │
│  engine.ts(唯一写入者) │ intake │ evals │ tickets │ assignments      │
│  domain/types │ domain/predicates │ domain/ids │ domain/errors      │
├──────────────────────────────────────────────────────────────────────┤
│  持久层 (store)                                                      │
│  store.ts(SQLite唯一持有者) │ schema.ts │ repositories │ read-queries│
├──────────────────────────────────────────────────────────────────────┤
│  端口 (ports) —— 窄接口                                             │
│  repositories │ policy │ sourceScope │ assessor │ executor │ outbox  │
├──────────────────────────────────────────────────────────────────────┤
│  适配层 (adapter) —— 复用既有资产                                   │
│  executor/ → team/workflows/worktree-manager + team-adapter          │
│               + agents/agent-registry + v2/approval                  │
│  assessor/ → team/orchestrator/llm-once + providers/                │
│  source/   → mcp/mcp-client + 新 SourceKind 协议                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 目录清单（新增文件）

```
packages/core/src/super-agent/
├── index.ts                      公共导出
├── domain/
│   ├── types.ts                  领域类型（Source/Trigger/Thread/…/Attention/Report）
│   ├── predicates.ts             状态谓词
│   ├── ids.ts                    确定性 id / key 生成
│   └── errors.ts                 UserError / USER_ERRORS
├── store/
│   ├── schema.ts                 DDL + 迁移（schemaVersion 只增）
│   ├── store.ts                  Store（唯一打开 SQLite）+ atomic + afterCommit
│   ├── repositories.ts           triggers/threads/tickets/decisions/effects/outbox
│   └── read-queries.ts           只读查询（永不写状态）
├── engine/
│   ├── engine.ts                 Engine + 5 个角色 Pick 接口
│   ├── intake.ts                 Trigger 接收/幂等/Thread 关联/扇出
│   ├── evals.ts                  Eval 批处理/超时/requeue/Decision
│   ├── tickets.ts                Ticket 生命周期（accept/resume/stop/end/retry）
│   ├── assignments.ts            Assignment + Report 事实
│   └── replies.ts                Channel 回复规则
├── effects/effects.ts            持久化副作用队列
├── passes/passes.ts              周期调度（每 2s，串行，合并请求）
├── policy/policy.ts              Policy / accept mode / 准入表 / 复验
├── router/
│   ├── gate.ts                   Gate：确定性准入（白名单/来源/强度）
│   ├── assessment.ts             Assessment：LLM 研判（复用 llm-once）
│   └── router.ts                 批量路由决策（I4）
├── worker/
│   ├── executor.ts               Worker 执行器（隔离 worktree + 角色 Agent）
│   ├── slots.ts                  并发容量（WorkerSlots）
│   └── report.ts                 结构化 Report + Attention 提取
├── source/
│   ├── kind.ts                   SourceKind 协议
│   ├── registry.ts               SourceRegistry
│   └── local-mcp.ts              首个 Source：MCP 客户端事件源
└── watchdog/watchdog.ts          外部监督与自愈
```

### 4.2 CLI

```
packages/cli/src/super/super-cmd.ts
```

| 子命令 | 作用 |
|---|---|
| `deepcode super start` | 启动 Super Agent runtime（Router 常驻 + Passes + Effects） |
| `deepcode super status` | 状态总览（活跃 Ticket / Worker 负载 / Effects 积压 / 健康） |
| `deepcode super tickets [--state open\|ended]` | 工单列表 |
| `deepcode super ticket <id>` | 单工单详情（含 Mandate / Assignments / Report / Attention） |
| `deepcode super inject --text "..."` | 手动注入 Trigger（演示 / 回归测试用） |
| `deepcode super watchdog` | 手动巡检一次（列出生效中的异常） |
| `deepcode super policy show\|set` | 策略查看 / 修改（accept mode 等） |

### 4.3 Web 只读面板（后置，首期只做 CLI）

首期**不做 Web**（`packages/web` 改动面大、收益后置）。P5 再做只读 API + 页面。

---

## 5. 关键机制设计

### 5.1 两级过滤（Fast Path / Slow Path）

```
Trigger ──> Gate（确定性，零 LLM）──> 不准入 → 记 disposition(filtered)，结束
                │ 准入
                ▼
           批量攒批（batching）──> Assessment（LLM 研判）──> Decision
```

**Gate（零 LLM，毫秒级）**：
- 发送者是否在 Source 的允许名单？
- 是否 @ 了机器人 / 直接消息？
- 是否落在准入表的接收范围？
- 机器人身份是否在 Source 的 bot 名单？
- **已订阅 Thread 上的后续消息直接跳过 Gate**（订阅直通，见 5.3）

**Assessment（LLM）**：
- 输入：Trigger 批次（有界窗口）+ Thread 快照 + 该 Thread 上全部 Ticket（含已结束）+ 当前 Policy
- 输出：Decision + 理由 + 匹配的规则名
- **约束**：`observe` 模式下，即使研判为 accept 也只记 `would accept`

### 5.2 批处理（吸收突发）

- Passes 每 2 秒跑一轮，**每次只跑一个 pass**（串行），运行中到达的请求**合并到下一轮**。
- 同一 Thread 的 Trigger 在一轮内合并为一个批次交给 Assessment。
- **效果对齐 DeepSeek 实测**：Trigger 到达率 1 → 40 条/分钟时，单决定分摊推理时间 6.4s → 1.6s。

### 5.3 订阅直通（Subscription fan-out）

```
Thread 收到 Trigger
   ├─> 命中订阅的 Ticket ──> 直接扇出为 Input（不经 Router 决策、不做 Gate）
   │      └─> Assignment 仍在运行 → 投递到 Worker
   │      └─> Ticket 已结束且消息来自人 → 按原 Mandate 恢复（需 Policy 复验通过）
   └─> 未命中任何 Ticket 且非订阅消息 ──> 进入 Eval
```

**收益对齐**：DSH 消融实测——关掉直通，Router 决策数 +30%，读缓存 token +37%。**本方案必须实现直通，且在 status 里暴露 `routed_via_subscription` 计数以便实测。**

### 5.4 Worker 执行与隔离

```
Ticket 接受
   → 创建 Assignment(pending)
   → Effects:launch
   → WorkerSlots 预留容量
   → 准备隔离工作目录（复用 team/workflows/worktree-manager）
   → 加载角色 Agent（复用 agents/agent-registry，从 SKILL.md 物化的 35 个角色）
   → 执行（工具经 v2/approval 审批闸，见 D1）
   → Report(六值) ──> Effects:relay ──> Router 收到 worker_report / worker_attention
```

**复用映射（关键：不重写既有资产）**：

| Super Agent 概念 | 复用的 DeepCodeX 资产 |
|---|---|
| Worker 隔离工作目录 | `team/workflows/worktree-manager.ts` |
| Worker 子代理沙箱 | `team/workflows/subagent-sandbox.ts` |
| 角色 Agent 装载 | `agents/agent-registry.ts` + `tools/agent-handler.ts` 的 `onLoadAgent` |
| 工具审批 | `v2/approval/approval-gate.ts` + `command-safety.ts` |
| 角色任务派发 | `team/team-adapter.ts` 的 `buildTask` / `executeDispatch` |
| 多工单依赖编排 | `team/plugins/goal-dispatcher.ts`（DAG 拓扑排序 + 同层并发） |
| 单工单内循环 | `team/autonomous/loop-controller.ts`（plan→dev→verify→fix） |
| 循环上限与退避 | `common/loop-guard.ts`（**与 EAG 共用同一份，不造第三套方言**） |
| 模型选择 | `team/workflows/model-router.ts` |
| Token 守门 | `team/workflows/token-budget-guard.ts` |
| LLM 单次调用 | `team/orchestrator/llm-once.ts` |
| 持久化与恢复 | `team/autonomous/run-state.ts` 的原子写 + SHA256 思路（本次升级为事务型） |

### 5.5 结构化 Attention（人只在验收点被打扰）

🔴 **硬约束**：Attention **不得从 Report 的自由文本推断**（DSH 原文明确拒绝）。

```ts
interface Attention {
  ticketId: string;
  question: string;          // 明确的问题
  options?: string[];        // 可选项（若有）
  blocking: boolean;         // 是否阻塞 Worker
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}
```

**唤醒语义（I9）**：
- `worker_attention`（blocking=true）→ **唤醒 Router** → 打扰人
- `worker_report`（progress/ready）→ **唤醒 Router**（人要看结果）
- `ticket_ended` / `policy_changed` / `settings_saved` → **只注入，不唤醒**

### 5.6 存算分离（后置，P6）

首期**不做**。但**领域状态全部在 SQLite**，天然可迁移——这为后续「本地 daemon + 云端 Agent Loop」留了路。
**首期必须做的**：Session 状态存 DB 而非内存、Worker 可在进程重启后被 `runtime` 恢复。

### 5.7 Watchdog（P4，首期只做检测，不做自愈）

首期：定期巡检并**如实报告**下列异常，**不做自动修复**（自动修复属高危，须显式开启）：
- Ticket 停滞（running 但超过 N 分钟无 Report）
- Assignment 处于 running 但对应 Worker 进程已不存在
- Effects 队列积压超阈值 / 某 kind 连续失败 ≥3 次
- Ticket 的 Mandate 已因 Policy 变更失效但仍在运行

---

## 6. 实施阶段

| 阶段 | 内容 | 依赖 | 交付判据 |
|---|---|---|---|
| **P0** | 领域类型 + SQLite Store（schema + 迁移 + repositories + 只读查询）+ Engine 骨架 + Effects 队列 + Passes | — | Store 单测通过；原子写 + afterCommit 单测通过；SQLite 缺失时诚实报错 |
| **P1** | Policy（accept mode / 准入表 / 复验）+ Gate + Assessment + 批量路由决策 | P0 | 两级过滤单测；批量决策「单项失败不阻断」单测；`observe` 模式**绝不**真接单 |
| **P2** | Worker 执行器（worktree 隔离 + 角色 Agent + 审批闸）+ WorkerSlots + 结构化 Report/Attention + Relay | P1 | 端到端：Trigger → Decision(accept) → Ticket → Worker 执行 → Report → Router 收到 |
| **P3** | Source 协议 + Registry + 首个 Source（MCP / 手动注入）+ Trigger 幂等 + Thread 聚合 + **订阅直通** | P2 | 幂等单测（同一 Trigger 两次 → 一个 Ticket）；**直通路径实测：不经过 Router 决策** |
| **P4** | Watchdog 巡检 + 恢复 `Assignment`（进程重启后）+ 可观测计数 | P3 | 重启后未结束 Ticket 可续跑；停滞/积压能被检出 |
| **P5** | 多信道输出（CLI 面板 + IM 简版 ≤100 词）+ 只读 Web API/页面 | P4 | 信道化输出契约测试 |
| **P6** | 存算分离（轻量 daemon 协议 + 会话状态迁移） | P5 | 可选 |

**首期交付范围 = P0 + P1 + P2 + P3**（端到端最小闭环）。P4–P6 排后续。

### 6.1 P0–P3 的文件级改动清单

| 类型 | 文件 | 动作 |
|---|---|---|
| 新增 | `packages/core/src/super-agent/**`（约 25 个文件） | 新建 |
| 新增 | `packages/cli/src/super/super-cmd.ts` | 新建 |
| 修改 | `packages/core/src/super-agent/index.ts` → `packages/core/src/index.ts` | 挂载具名导出 |
| 修改 | `packages/cli/src/cli-args.ts` | 新增 `super` 子命令解析 |
| 修改 | `packages/cli/src/cli.tsx` | 新增路由 |
| 修改 | `packages/core/package.json` | `better-sqlite3` 由根 optionalDependencies 提升为 core 的**可选** dependency（保持 optional，缺失时诚实降级） |
| 测试 | `packages/core/src/tests/super-agent-*.test.ts`（预计 8–12 个） | 新建 |

**不动**：`team/**`、`eag/**`、`v2/**`、`agents/**`、`mcp/**`、`providers/**` 的任何既有文件（除 `index.ts` 挂载）。

---

## 7. 数据模型（SQLite）

```sql
-- schemaVersion = 1（只增）
CREATE TABLE trigger (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX trigger_idem ON trigger(source_id, idempotency_key);

CREATE TABLE thread (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1      -- 生成列：是否有 open Ticket / 排队 Eval
);

CREATE TABLE trigger_thread (
  trigger_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, thread_id)
);

CREATE TABLE disposition (            -- 每个 Trigger 的处置轨迹（审计）
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- filtered | evaluated | fanned_out | acked | answered | requeued | handback
  at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE ticket (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,                -- open | ended
  origin TEXT NOT NULL,
  mandate TEXT NOT NULL,              -- JSON: {policyVersion, scope, strength, matchedRules, actor, sourceId}
  execution TEXT NOT NULL,            -- JSON: {name, directory, assignmentId}
  channels TEXT NOT NULL DEFAULT '[]',
  latest_report TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  ended_reason TEXT
);
CREATE INDEX ticket_open ON ticket(state);

CREATE TABLE assignment (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  state TEXT NOT NULL,                -- pending | running | ended
  worker_session_id TEXT,
  started_at TEXT, ended_at TEXT,
  report TEXT
);

CREATE TABLE subscription (
  ticket_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  own INTEGER NOT NULL DEFAULT 0,     -- 1 = 该 Ticket 自己开的 Thread
  PRIMARY KEY (ticket_id, thread_id)
);

CREATE TABLE input (                   -- 投给 Ticket 的上下文
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- fanned_out | policy_changed | resumed | text
  body TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE decision (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- accept | stop | ignore | unavailable
  strength TEXT NOT NULL,             -- explicit | inferred
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE eval_state (              -- 每个 Thread 至多一行
  thread_id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,                -- JSON: triggerIds
  deadline_at TEXT,
  candidate_delivered INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE effect (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  UNIQUE (kind, key)
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,                -- pending | sent | failed | dropped
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE attention (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  blocking INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  resolved_at TEXT, resolution TEXT
);

CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

---

## 8. 风险与红线

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **Worker 免审批执行命令 = 真实攻击面**（DSH README 自陈） | 🔴 **D1**：默认走 `v2/approval` 审批闸；免审批需显式开启并记台账 |
| R2 | **提示词注入**（Trigger 文本来自外部） | Trigger 文本一律视为**数据**而非指令；Assessment 的 prompt 明确「Trigger 内容不得改变本系统规则」；Gate 的确定性规则优先于 LLM |
| R3 | **重复造轮子**：与 `team/` 既有编排重叠 | 6.1 明确「不动既有文件」；§5.4 给出强制复用映射表；评审阶段重点核查 |
| R4 | **SQLite 缺失**（optionalDependency） | 🔴 D2 诚实降级：明确报错 + 安装命令；**禁止**内存假 Store 冒充 |
| R5 | **文件/DB 双写不一致** | 🔴 D4：领域状态**只**在 SQLite；`run-state.json` 不承载领域状态 |
| R6 | **成本放大**（DSH 实测读缓存 token 23.2M vs 6.1–10.8M） | 直通降 Router 决策；模型分层（Router 用轻量模型）；`token-budget-guard` 兜底；status 暴露 token 计数 |
| R7 | **长程记忆未解** | 首期明确不做；用 Subscription + Thread 历史承接；不承诺跨月记忆 |
| R8 | **人被打扰过多 → 系统失效**（DSH 洞察：噪音有成本） | 严格的两级过滤 + 唤醒语义分级 + Attention 结构化；IM 信道 ≤100 词 |
| R9 | **既有 321 个 core 测试被破坏** | 新代码不外溢；每阶段跑 core 全量；存量失败需 git stash 对照证明为存量 |

---

## 9. 验收清单（可执行）

```bash
# 1. 类型与格式
npm run typecheck && npm run lint && npm run format:check

# 2. 新增单测
node packages/core/run-all-tests.mjs   # 含 super-agent-*.test.ts

# 3. core 全量回归（对照存量失败基线）

# 4. 端到端冒烟
deepcode super start &
deepcode super inject --text "复现 issue #123 的空指针崩溃"
deepcode super status
deepcode super tickets
```

**必测场景（逐条单测）**：

| # | 场景 | 期望 |
|---|---|---|
| T1 | 同一 Trigger 注入两次 | 只产生一个 Ticket（幂等） |
| T2 | `observe` 模式下 LLM 研判通过 | 记录 `would accept`，**不创建 Ticket** |
| T3 | `auto` 模式下 LLM 研判通过 | 创建 Ticket + Mandate + Assignment |
| T4 | 白名单外的人 @ 机器人 | Gate 判定为 inferred（`off` 模式下不接单） |
| T5 | 已订阅 Thread 的后续 Trigger | **不产生新的 Decision**，直接扇出为 Input |
| T6 | 批量路由决策含一条非法项 | 合法项**照常执行**，非法项单独返回 refused |
| T7 | 已结束 Ticket 收到人的消息 | 按原 Mandate 恢复；Policy 复验失败则**保持结束** |
| T8 | Policy 变更影响活跃 Ticket | 投递 `policy_changed` Input，**不撤销** Mandate |
| T9 | 进程重启 | 未结束 Ticket / Assignment / Effects 队列状态不丢、可续跑 |
| T10 | Worker 试图执行高危命令 | 走审批闸被拦（**不得免审批**） |
| T11 | `better-sqlite3` 缺失 | 启动**明确报错**并给安装命令，**不静默降级为内存 Store** |
| T12 | Effects 某 kind 连续失败 3 次 | 健康面板报错；队列不丢数据 |

---

## 10. 与 DeepSeek Super-agent 的差异声明（诚实说明）

| 维度 | DeepSeek 原型 | 本方案 | 理由 |
|---|---|---|---|
| 部署 | 云端 Agent Loop + 端侧 daemon | **本地优先**，单进程 | 企业托管由 WorkBuddy 负责（避免重复投入） |
| Source | GitHub + 飞书（专用实现） | **SourceKind 协议 + 首个 MCP/手动 Source** | 避免为特定平台写死；后续可插拔 |
| 事件类型 | 群聊 / PR / CI / 邮件 | Trigger 抽象 + Source 翻译 | 同上 |
| 持久化 | SQLite + 完整 migration | SQLite + 迁移（首期 schemaVersion=1） | 一致 |
| Effects | 6 个 kind，完整退避 | 首批：`assessment` / `launch` / `delivery` / `relay` / `reply` | 首期够用，可增量加 |
| Panel | React Web 面板 | 首期 CLI；P5 再做 Web | 减少首期改动面 |
| Watchdog | 独立监督 + 自愈 | P4 只检测不自愈 | 自愈属高危，须显式开启（D3） |
| 人机交互 | IM ≤100 词 + 结构化 Attention | 同（P5 实现 IM 信道） | 一致 |
| 领域词表 | Source/Trigger/Thread/… | **沿用同一套词表** | 避免再造名词，降低学习成本 |

---

## 11. 实施顺序与排期建议

```
P0 领域内核（Store + Engine + Effects + Passes）
   └── P1 两级过滤与路由（Policy + Gate + Assessment）
          └── P2 Worker 执行与回报（隔离 + 审批 + Report/Attention）
                 └── P3 事件源与订阅直通（Source + Trigger + Thread + Subscription）
                        └── P4 Watchdog 与恢复
                               └── P5 多信道与 Web 面板
                                      └── P6 存算分离
```

**建议**：P0–P3 一个迭代内完成并联调（端到端闭环优先），P4 单独迭代，**P5/P6 视需要再排**（YAGNI）。

---

## 12. 待评审确认的开放问题

| # | 问题 | 建议默认 | 需要谁拍板 |
|---|---|---|---|
| O1 | 首期是否必须包含 Web 面板？ | 否（只做 CLI） | 产品经理 |
| O2 | `auto` 模式是否首期就允许开启？ | 否（默认 `observe`，需显式开） | 架构师 / 产品经理 |
| O3 | 首个 Source 用 MCP 客户端事件源，还是先做「手动注入 + 本地文件监听」？ | 手动注入 + 文件监听（更易测），MCP 次之 | 架构师 |
| O4 | Worker 的工作目录是否强制走 git worktree（隔离强但要求 git 仓库）？ | 非 git 仓库降级为独立临时目录 | 独立开发者 |
| O5 | 是否复用 `team/plugins/goal-dispatcher` 的 Goal DAG 作为「多 Ticket 依赖编排」？ | 是（复用） | 架构师 |
| O6 | `super-agent` 模块放 `packages/core/src/` 还是独立 package？ | 放 core 内（首期），后续规模上来再拆 | 架构师 |

---

## 13. 参考

- 调研报告：[`industry-research.md`](./industry-research.md)
- DeepSeek 原型领域模型：`docs/001-domain.md`（https://github.com/deepseek-ai/dsh-superagent-prototype）
- DeepSeek 原型授权模型：`docs/002-authorization.md`
- DeepSeek 原型架构不变量：`docs/007-architecture.md`
- DeepCodeX 既有 DSH 源码分析：`docs/research/dsh-analysis-20261027.md`（**Q6：禁止引入 Cordis 依赖**）
- DeepCodeX 既有证据链方案（已落地）：`docs/proposals/better-harness-enhancement/proposal-final.md`
