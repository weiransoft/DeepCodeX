# Super Agent「司南」架构审计与运作机制核查

> **日期**：2026-11-04
> **范围**：`packages/core/src/super-agent/**`、`packages/cli/src/super/**`、`tests/scripts/super-agent-*.ts`
> **基线**：`db841a5b`（技能中文名 + 设置页去重 + 审计报告渲染）
> **上位文档**：[`proposal-final.md`](./proposal-final.md)（架构定稿 v2）、[`proposal-p3-context-v2.md`](./proposal-p3-context-v2.md)（P3 上下文层）

---

## 0. 一句话结论

原实现是一个**扎实的事件驱动内核**（准入 → 研判 → 接管 → 派工 → 回报 → 收尾），
但它只有「一个人干一件事」的执行模型：Worker 是**一次单角色 LLM 调用**，
没有分解、没有工作流、没有团队，连一个可称呼的名字都没有。

本轮补齐三件事，并把它们做成可验证的机制而不是提示词口号：

1. **身份**：常驻主理智能体「**司南**（Sinan）」——名字、人格、署名统一到 `identity.ts` 单一真相源；
2. **动态分解 + 动态工作流**：接单时由规划器产出 `WorkPlan`（目标 / 策略 / 步骤 DAG / 团队），
   随决策**同一事务**落库，按**波次**（拓扑分层）派工；
3. **组队协同**：每一步按角色派工（架构 / 实现 / 测试 / 设计 / 产品），
   下游步骤的提示词里带上游交付摘要（显式交接），而不是让每个 Worker 冷启动。

核查中发现并修复 **4 个真实缺陷**（1 个是会造成工单提前收尾的并发判定错误），
另有 **3 项诚实边界**未掩盖，逐条列在 §5 / §7。

---

## 1. 名字：「司南」

| 项 | 值 |
| --- | --- |
| 中文名 | **司南** |
| 英文名 | Sinan |
| 架构族名 | `super-agent`（只用于文档与目录，不作为称呼） |
| 定位 | 常驻主理智能体 |
| 一句话职责 | 拆解任务 · 编排工作流 · 组建团队 · 盯到交付 |
| 署名 | `司南（Sinan）· 常驻主理智能体` |

**取名理由**：司南是先秦的指向器具（指南针祖型），名字本身就是职责——定方向、分方位。
把模糊请求拆成方位明确的步骤，再把「人（角色）」与「事（步骤）」对上，正是主理人的工作。

**为什么区分「名字」与「族名」**：`Super Agent` 在方案文档里指整个架构族（Router / Ticket / Effects 那套词表），
不适合当称呼；人机交互、提示词自称、CLI 横幅统一用「司南」，避免「系统在跟我说话吗」的模糊感。

**落点**：`packages/core/src/super-agent/identity.ts`（`SUPER_AGENT_IDENTITY` / `superAgentSignature()` /
`buildIdentityPreamble()`），CLI 帮助、状态、计划、Worker 系统提示、规划器系统提示全部引用它，改名只改一处。

---

## 2. 架构核查

### 2.1 分层与依赖方向

```
接入层   runtime.ts（组合根） / passes / effects / router / planner / cli/super
领域层   engine/{engine,intake,evals,tickets,assignments} + domain/**（零 I/O）
持久层   store/{schema,store,repositories}（唯一允许 node:sqlite）
适配层   worker/**（→ interrupts/background-runner、team/role-registry）
         router/**、planner/**（→ team/orchestrator/llm-once）
事件源   source/**（唯一允许读文件系统）
```

依赖门禁由 `eslint.config.mjs` 强制：内核层禁 `node:fs` / `node:child_process` / 网络模块 /
`node:worker_threads` / `node:sqlite`，禁反向依赖 `team/**`、`common/**`、`tools/**`、`v2/**`（类型引用除外），
且禁**动态 `import()`**（`no-restricted-syntax`）。本轮把 `planner/**` 加入**适配层**白名单，内核层门禁未放宽。

### 2.2 九条不变量逐条核对

| # | 不变量 | 现状 | 说明 |
| --- | --- | --- | --- |
| I1 | Engine 是唯一写入者 | ✅ | 计划写入也走 `acceptTicket` → `ctx.repos`，Engine 之外无写路径 |
| I2 | 事务与副作用分离 | ✅ | 计划在**决策事务内**落库；派工/投递/回复仍是 `afterCommit` 的 Effects |
| I3 | Source 只拥有自己的数据 | ✅ | 未改动 |
| I4 | Router 是批量命令编排器 | ✅ | 计划生成在 `buildDecision`（逐候选），`decide` 仍逐项独立 |
| I5 | Worker 与 Router 仅经 Engine + Effects 通信 | ✅ | Worker 只 `report`；波次推进由 `applyReport` 写入 |
| I6 | SQLite 是事实来源 | ✅ | 新增 `ticket_plan` / `plan_step` 两表；`SCHEMA_VERSION` 1 → 2 |
| I7 | 依赖方向单向 | ✅ | 计划层类型零 I/O；LLM 只有 `planner/**` 适配层调用 |
| I8 | noWait 限制 | ⏸ | 首期无对象，仍未启用 |
| I9 | 唤醒语义分级 | ✅ | 新增消息只有「结束 / 进入下一波」，走 `reply`（不唤醒） |

DeepCodeX 专属原则：D1 审批在位（未改动 Worker 工具链路）✅；D2 诚实降级（计划失败降级单步并写明原因）✅；
D3 flag 默认 off（计划层不新增开关，`observe` 模式不规划）✅；D4 单一真相源（计划只存 SQLite）✅。

### 2.3 运作机制：一条请求的完整路径

```
① Source / CLI inject
      └─ intake：幂等键去重 → Gate（确定性，零 LLM）
            ├─ 不准入 → disposition(filtered)
            └─ 准入 → Eval 攒批（2s 一轮，串行）
② Assessment（LLM，可注入 stub）→ accept / ignore / stop / unavailable
      └─ accept 前：Planner（LLM，20s 超时）
            产出 WorkPlan：objective / strategy / steps(DAG) / team
            失败 → 单步降级计划（source=fallback，原因写进 warnings）
③ Decision（一个事务）
      Ticket + N 个首波 Assignment + 计划快照 + 全部步骤进度 + 订阅 + launch/reply 副作用
④ Effects
      launch：按**步骤角色**启动 Worker（step.role，无计划时才用 ticket.role）
      delivery：恰好一个 Worker 在跑时投递；并行波次则如实暂存
      relay：Worker 报告回灌
      reply：写侧消息
⑤ applyReport（一个事务）
      更新 Assignment → 更新工单报告 → 更新步骤状态 → 结构化 Attention
      → 最终报告：推进波次 或 收尾
⑥ 波次推进判定（本轮修复的核心）
      本步失败 → 立即收尾
      全部 ready → 收尾「已完成（N 步）」
      还有「在飞」步骤（running / 已派工未启动）→ 只记录，不派工、不收尾
      否则派工所有依赖已就绪且未派工的步骤（同波并行，一步一个 Assignment）
```

---

## 3. 本轮改动清单

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 身份 | `super-agent/identity.ts`（新） | 名字 / 署名 / 人格前导，单一真相源 |
| 计划 | `super-agent/planner/types.ts`（新） | `WorkPlan` / `PlanStep` / `TeamMember` / `PlanWave` / 状态记录 |
| 计划 | `super-agent/planner/parse.ts`（新） | JSON 提取、字段归一、角色/依赖/环校验、`MAX_PLAN_STEPS=8`、降级计划、计划渲染 |
| 计划 | `super-agent/planner/waves.ts`（新） | Kahn 分层、可派工判定、阻塞诊断、完成判定 |
| 计划 | `super-agent/planner/planner.ts`（新） | `LlmWorkflowPlanner`（真实模型）/ `StaticPlanner`（测试与显式计划）/ `NullPlanner`；`available()` 如实标记能力 |
| 持久 | `store/schema.ts` | `SCHEMA_VERSION = 2`，迁移 v2 **只新增** `ticket_plan` / `plan_step` 两表 |
| 持久 | `store/repositories.ts` | 计划与步骤进度的读写、按 Assignment 反查步骤、计划统计 |
| 引擎 | `engine/tickets.ts` | 接单按首波步骤建 Assignment，落计划与全部步骤进度 |
| 引擎 | `engine/evals.ts` | 决策携带计划进入同一事务 |
| 引擎 | `engine/assignments.ts` | 报告回灌更新步骤状态；波次推进 / 失败收尾 / 无解收尾 |
| 引擎 | `engine/engine.ts` | `DecisionInput.plan`；`TicketDetail` 增 `plan` / `planSteps` |
| 路由 | `router/router.ts` | accept 前生成计划；`observe` 推断候选**不**规划（省一次 LLM） |
| 执行 | `worker/executor.ts` | 提示词新增「任务目标 / 你的步骤 / 团队 / 上游交接」；按步骤角色注入 |
| 运行时 | `runtime.ts` | 计划器装配、状态暴露计划进度、派工按步骤角色、并行波次下的投递如实暂存 |
| CLI | `super/super-cmd.ts` | 新增 `super plan <id>`；状态增计划与能力；横幅/帮助改用司南署名 |
| CLI | `super/super-worker.ts` | Worker 系统提示改为「司南派出的执行者」并说明步骤边界 |
| CLI | `cli-args.ts` / `cli.tsx` | 注册 `plan` 子命令；关闭 yargs 内建 help 命令，修复子命令帮助重复打印 |
| 门禁 | `eslint.config.mjs` | `planner/**` 纳入适配层（仍受 I/O 与 V2 门禁约束） |
| 测试 | `src/tests/super-agent-planner.test.ts`（新，14 例） | 解析 / 校验 / 降级 / 波次 / 身份 |
| 测试 | `src/tests/super-agent-team.test.ts`（新，10 例） | 计划落库 / 波次推进 / 并行判定 / 失败收尾 / 旧语义 / 提示词 |
| 测试 | `tests/scripts/super-agent-team-e2e.ts`（新，11 项） | 真实运行时 + 真实后台 Worker + 只替换网络端点的全链路 |
| 文档 | `proposal-final.md` §15 | 本轮实施记录与诚实边界 |

---

## 4. 测试与验证

### 4.1 分层测试

| 层 | 手段 | 结果 |
| --- | --- | --- |
| 计划层单测 | `super-agent-planner.test.ts`（14 例）：解析、代码块剥离、角色回落、依赖清理、环拒绝、截断、降级、波次、可派工、身份 | ✅ 14/14 |
| 引擎/团队集成 | `super-agent-team.test.ts`（10 例）：真实 SQLite + 真实 Engine/Router，计划器函数注入 | ✅ 10/10 |
| 既有回归 | `super-agent-{core,engine,runtime,adapters,context,history}.test.ts` | ✅ 110/110 |
| 迁移 | T19 改写为「v1 库自动升级到 v2，既有决策保留，计划表可用，迁移幂等」 | ✅ |
| 端到端 | `npm run test:e2e:super:team`（11 项）：事件 → 研判 → 计划 → 三波派工 → 交接 → 收尾 | ✅ 11/11 |
| CLI 实测 | `super help` / `super status` / `super plan <id>` 在真实 SQLite 上运行 | ✅ 输出见 §4.3 |
| 质量门禁 | `npm run typecheck`（core / cli / web / vscode）、`eslint`、`prettier --check` | ✅ |

### 4.2 端到端断言（11 项）

| 断言 | 结果 |
| --- | --- |
| TEAM-1a 研判 accept → 真实建单并收尾 | ✅ |
| TEAM-1b 计划由真实计划器生成并落库（3 步 / 3 角色 / source=llm） | ✅ |
| TEAM-1c 三步骤全部 ready，Assignment 数 = 步骤数 = 3 | ✅ |
| TEAM-1d 收尾理由为「已完成（3 步）」 | ✅ |
| TEAM-2a 首个提示词含目标 / 步骤 / 团队 | ✅ |
| TEAM-2b 首波按步骤角色执行（architect） | ✅ |
| TEAM-2c 第二波两步并行且都带上游交接 | ✅ |
| TEAM-2d 第二波角色分别为 solo-coder / test-expert | ✅ |
| TEAM-3a status 暴露计划数与步骤进度 | ✅ |
| TEAM-3b 计划器能力如实标记 | ✅ |
| TEAM-3c 工单详情携带计划与团队（`super plan` 数据源） | ✅ |

### 4.3 CLI 实测（真实 SQLite）

```
$ deepcode super status --project-root /tmp/dc-demo
司南（Sinan）· 常驻主理智能体
  接单模式：auto（Policy v1）
  研判能力：不可用
  计划能力：不可用（按单步降级）
  计划：1 份（步骤 待派工 3 / 运行中 0 / 已完成 0 / 失败 0）
  ...

$ deepcode super plan <ticket-id>
目标：登录页崩溃定位、修复与回归
策略：先定位根因，再并行修复与补测试
来源：模型分解　步骤：3

步骤：
  ［pending］s1 定位崩溃点 — 角色 architect（首波）
  ［pending］s2 修复实现 — 角色 solo-coder（前置 s1）
  ［pending］s3 补回归测试 — 角色 test-expert（前置 s1）

团队：
  - 架构师（architect）：s1 — 定位崩溃点
  - 独立开发者（solo-coder）：s2 — 修复实现
  - 测试专家（test-expert）：s3 — 补回归测试
```

---

## 5. 核查中发现并修复的缺陷

| # | 缺陷 | 影响 | 处置 |
| --- | --- | --- | --- |
| 1 | **并行波次提前收尾**：同波某步先完成时，仍在运行/已派工未启动的步骤被当作「无步骤可派」，工单被以「依赖无法满足」结束 | 多角色并行的工作流必然踩中；表现为「明明还在跑，单却关了」 | `advancePlan` 增加「在飞」判定（running 或 pending+已派工），有在飞就只记录不推进；派工前过滤已派工步骤，避免重复派工。回归测试 T2b + E2E TEAM-1d |
| 2 | **`super help` 打印两遍**：yargs 内建 help 命令先把英文 Options 打一遍，再执行子命令中文帮助；`rules help` / `eag help` 同样 | 用户第一眼看到的是过时英文帮助，新增 `plan` 子命令被淹没 | `.help(false)` 关闭内建 help 命令；`rules` / `eag` 的 `choices` 显式加入 `"help"`；`--help` / `-h` 行为不变 |
| 3 | **`observe` 模式白跑规划**：推断候选研判通过只记影子，却仍消耗一次规划 LLM 调用 | 观察期成本翻倍，且产生无人使用的计划 | Router 判定 `willAccept`（explicit 或 auto）后才规划；T8 守护 |
| 4 | **执行器对仓储形状过强假设**：`renderPrompt` 直接调用 `findPlan`，旧的测试替身立刻崩 | 测试替身暴露的问题同样是接口契约风险（读取失败应降级而非中断派工） | 依赖注入的替身补齐计划读取方法；工厂实现保持只读、缺计划即回旧语义 |

> 缺陷 1 是**并发判定错误**，不是文案问题：它会让「组队协同」在第一个并行波次就失败。

---

## 6. 计划校验规则（模型输出是不可信输入）

| 规则 | 违反时 |
| --- | --- |
| 1 ≤ 步骤数 ≤ 8 | 超出截断并告警；0 步直接判为不合法 |
| 角色必须来自注册表（5 个内置角色） | 回落 `solo-coder` 并告警 |
| `dependsOn` 必须引用本计划内已存在的步骤 | 移除该依赖并告警 |
| 禁止自依赖 | 移除并告警 |
| 必须无环（Kahn 检测） | 整份计划拒绝 → 降级单步 |
| 字段长度上限（目标 400 / 策略 600 / 标题 120 / 交付 200） | 截断并告警 |
| 版本必须为 1 | 拒绝 → 降级单步 |

**任何修正都写入 `plan.warnings`**，`super plan` 原样展示——不静默吞掉模型的不合规输出。

---

## 7. 诚实边界（未做就是未做）

1. **Worker 仍是「一次 LLM 调用 + 结构化报告」**，不是完整 agentic 会话（无工具调用、无多轮循环）。
   本轮补的是「编排」深度（分解 / 分工 / 交接 / 波次），不是「执行器」深度。
2. **并行波次下的追加输入会暂存**：多条 Worker 并行时，一条输入无法无歧义地投给多个会话，
   此时输入保持待投递并写一条内部说明（`state=dropped`，不入发送队列），待波次收敛后重投。
   这是**如实降级**，不是投递成功。
3. **真实模型下的计划质量未验证**：本机无有效模型凭据，E2E 只替换网络端点、验证内核时序与落库；
   「模型能否稳定产出合规 DAG」需要在有凭据时复测（属于 nightly / 人工项）。
4. **计划不可变更**：工单执行中不重新规划；需求变了就是新工单（与 Mandate 不可变同构）。
5. **无并发上限**：同波步骤数即并发 Worker 数（上限由计划 ≤8 步间接约束），未做 WorkerSlots 容量控制。
6. **`plan_step.summary` 只存摘要**：完整报告仍在 `assignment.report`，步骤表不复制全文，避免双写。

---

## 8. 后续建议（按价值排序）

1. **真实模型质量复测**：用真实 endpoint 跑 20 条各类型请求，统计「计划合规率 / 步骤数分布 / 角色分布 / 降级率」。
2. **Worker 深度**：接工具调用与多轮循环（`WorkerExecutor` / `WorkerInjector` 端口已就位，引擎层零改动）。
3. **并发容量控制**：给 Effects 的 `launch` 增加 WorkerSlots 预留，超限的步骤保持 pending。
4. **计划变更**：为「人追加要求」提供 re-plan（新 Mandate + 新工单，保留旧计划作为历史）。
5. **Web 面板**：`super plan` 的数据结构已可直接映射为计划视图（步骤 DAG + 状态色）。
