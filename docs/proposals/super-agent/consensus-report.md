# 共识收敛报告 — DeepCodeX Super Agent 方案

> **日期**：2026-11-03
> **来源**：Phase 2 四角色交叉评审 + 独立代码全仓扫描
> **评审对象**：[`proposal-v1.md`](./proposal-v1.md)
> **代码基线**：`/Users/wangwei/Documents/VG/DeepCodeX-cli` @ v0.4.5

---

## 0. 评分与结论汇总

| 角色 | 评分 | 结论 |
|---|---|---|
| 架构师 | 5.5/10 | 不通过（B1–B5 须修） |
| 产品经理 | 6/10 | 有条件通过 |
| 测试专家 | 5.5/10 | 有条件通过 |
| 独立开发者 | 7/10 | 有条件通过 |
| **加权** | **6.0/10** | **有条件通过** |

**四角色一致意见**：方案的**领域建模**（Source/Trigger/Thread/Ticket/Subscription/Mandate/Attention）与**不变量提炼**（I1–I9）质量高、订阅直通与结构化 Attention 两点最有价值；调研报告诚实度高，是本次评审能快速定位边界的前提。

**但四角色一致认为**：方案最核心的「复用既有资产、不重写」承诺**在最关键的 Worker 执行链与持久层上不成立**，且**首期范围过大、用户价值交付为零**。必须按下列 18 项共识修订后重审。

---

## 1. 共识问题清单（≥2 角色提出 = 必须修改）

| # | 问题 | 提出者 | 证据强度 | 判定 |
|---|---|---|---|---|
| **C1** | **`better-sqlite3` 依赖策略错误**：本机 binding 是 Linux ELF（`ELF 64-bit LSB shared object, ARM aarch64`）而宿主是 `darwin arm64`，`require` 必崩 `ERR_DLOPEN_FAILED`；且 esbuild bundle（`scripts/esbuild.config.js:31` 仅 `external: ["sharp"]`）会把原生模块打进 bundle；`packages/core/package.json` 依赖里根本没有它 | 架构师B1 / PM B2 / 测试B2 / 开发者B1 | 🔴 4/4 **实测** | **必须改** |
| **C2** | **§5.4 复用映射表多处与真实接口不符**：真正的 headless Worker 执行器 `session.runEphemeral` 被遗漏；`goal-dispatcher.ts` 是 plugin 模型且**零持久化**（文件头 `:13` 声称持久化，与实现不符）；`model-router.ts` 的 `ModelProfile` **无真实 model id**，产不出可调用句柄；`token-budget-guard.ts` 管的是**单任务内**预算，与跨 Ticket 成本控制维度错配 | 架构师B3 / PM Y2 / 开发者核验 | 🔴 3/4 **实测** | **必须改** |
| **C3** | **首期范围过大**：P0–P3 共 28 个生产文件、约 25–33 人日（单人 5–7 周）；含大量 speculative 设计 | 架构师 / PM / 测试 / 开发者 | 🔴 4/4 | **必须改** |
| **C4** | **§4 架构图与 §4.1 文件清单不一致**：图里有 `runtime.ts`/`ports/`(6 接口)/`cli/`/`web/`，清单里全无；`effects` 位置冲突；「约 25 个文件」实际 28 | 架构师B2 / 开发者B2 | 🔴 2/4 | **必须改** |
| **C5** | **CLI 接线改动面被低估**：`cli-args.ts` 实际有 **4 处**必改（`ParsedCliArgs` 接口 / `.command("super <subcommand>")` / **yargs 18 的 `helpAsSecondPositional` 五级三元链** / `superRaw` 三段式 fallback + `superOptions` 提取），非 1 处 | 架构师B2 / 测试Y8 / 开发者B4 | 🔴 3/4 | **必须改** |
| **C6** | **I7「core 不做 I/O」无强制手段** | 架构师B5 | 🟡 1/4，但 `eslint.config.mjs:44-75` 已有 v2 同构先例，成本极低 | **采纳** |
| **C7** | **覆盖率 ratchet 门禁未提及，CI 必红**：实测函数覆盖率 **45.07%**，阈值 45，**余量仅 0.07pp**；允许新增零覆盖函数上限 = `floor(8331/0.45 − 18484)` = **29 个**，而新模块必然远超 | 测试B1 | 🔴 1/4 但**实测必然发生** | **必须改** |
| **C8** | **端到端冒烟在 CI 不可执行**：`deepcode` 二进制在 CI 不存在（CI 只产出 `packages/cli/dist/cli.js`）；`&` 后台语义在 `windows-latest` 不同（`run-all-tests.mjs:5-9` 已记录该前车之鉴）；无 readiness 协议 | 测试B3 | 🔴 1/4 | **必须改** |
| **C9** | **LLM 注入/mock 策略完全缺失**：项目**禁止 mock 框架**（`context-budget.test.ts:12-15` 明写「所有桩均为函数注入式真实组件装配」），但 `resolveLlmHandle(projectRoot, injectedClient)`（`llm-once.ts:41`）**确有注入点**，方案未利用 | 测试B3 | 🔴 1/4 | **必须改** |
| **C10** | **多用户语义缺位**：单 Router + 单库无 user 维度，与 Web 已确立的 per-user 隔离（`packages/web/src/engine-home.ts:36-41`）冲突 | PM B3 | 🟡 1/4 | **必须改（首期显式声明单机）** |
| **C11** | **并行写冲突策略缺失，且 worktree 已被既有决策弃用**：`team/orchestrator/plan-graph.ts:391-396` 明确「不用 git worktree 隔离，因为 runner 的 cwd 固定是 projectRoot，worktree 会让路径全部漂移」，既有解法是 `serializeFileConflicts` 文件冲突下移串行 | PM B4 / 架构师 | 🔴 2/4 | **必须改** |
| **C12** | **首期用户价值为零**：G2（主动接单）依赖 `auto` 模式、G5（不被打扰）依赖 P5 呈现层，**而首期 P0–P3 两者都交付不了**；G1 已被 `/team auto --max-parallel` 覆盖，G6 已被 `run-state`/`task-store` 覆盖 | PM B1 | 🔴 1/4 但**直击方案根本矛盾** | **必须改** |
| **C13** | **领域词表与既有标识重复**：Super Agent `Assignment` 与既有 `TaskRequirement`（`team-adapter.ts:94`）、`Report` 六值与既有 `DispatchStatus` 八值（`team/types.ts:195-205`）需映射，否则造出第四套任务标识 | 架构师Y7/Y13 / 扫描D-2 | 🟡 2/4 | **必须改** |
| **C14** | **工作量严重低估**：「一个迭代内完成并联调」在 37–41 个新文件规模下不成立 | 开发者 | 🔴 1/4 | **必须改（诚实化）** |
| **C15** | **§7 DDL 具体缺陷**：① 声称「生成列」但 DDL 里是普通列（跨表生成列在 SQLite 不可行）② `UNIQUE(kind,key)` 与「合并」语义冲突（第二条 INSERT 必报约束失败，需显式 UPSERT）③ 无 Ticket 依赖字段 ④ `Correlation` 概念全文无落地 ⑤ `input` 表名易与 DOM 混淆 | 架构师Y2–Y6 | 🟡 1/4 但**全部实测** | **必须改** |
| **C16** | **「Worker 隔离上下文」与既有架构决策冲突**：`docs/architecture/ARCH-20261027-agent-autodiscovery.md` §1.2 D2 明确「P0 执行模型 = 会话内 prompt 注入，**不做独立子会话**」，agent 只注入角色约束 system 消息 | 扫描 | 🔴 1/4 | **必须改** |
| **C17** | **D1 的落点选错**：`v2/approval/*` 8 文件在 `session.ts` 中**生产零引用**（已实现但未接线）；生产在用的是 V1 `common/permissions.ts:172 computeToolCallPermissions()` | 扫描（+架构师隐含） | 🔴 1/4 | **必须改** |
| **C18** | **背景事实需修正**：全仓有 **5 套并行编排体系**（L2 `orchestrate` / Roundtable / Ralph / EAG-P5 / PatternExecutor）+ 3 套 4 阶段循环 + 3 套角色目录（5 硬编码 / 30 专家内存 / 35 文件），**无统一路由层**——这是 Super Agent 存在的真实理由，原方案低估了 | 扫描 | 🔴 1/4 | **写入方案背景** |

---

## 2. 分歧点清单（角色意见不一致，需在定稿中显式取舍）

| # | 分歧 | 各方立场 | **定稿取舍** | 理由 |
|---|---|---|---|---|
| **D1** | **首期交付范围** | 架构师/测试/开发者：保留 P0–P3 但砍 speculative（→ 22–23 文件）<br>PM：换成 P0′ 极薄闭环（≤5 文件，不引 SQLite） | **采纳「骨架 + 可见价值」的合并方案**：保留 Super Agent 领域内核，但把**呈现层与真实事件源提前到 P0**，并把 observe 影子模式重定义为可交付用户价值 | 四方共识是「首期必须用户可见」；PM 的 P0′ 放弃了 Super Agent 架构（用户明确要求构建 super agent），架构师的砍法保留骨架。合并方案同时满足两者 |
| **D2** | **持久层选型** | 架构师/开发者：沿用 better-sqlite3 + 动态加载<br>测试/PM：换 `node:sqlite` | **换 `node:sqlite`**（Node 22.13+ 内置） | ① 本仓已有先例 `packages/web/src/server.ts:676 await import("node:sqlite")` ② 零原生依赖 → **绕开 C1 打包链路与 CI 矩阵全部风险** ③ Node ≥22 已是项目硬约束（`packages/cli/package.json:22-24`） |
| **D3** | **Worker 执行器** | 架构师：`session.runEphemeral`（但它一次性销毁、不可续跑）<br>PM：复用 `interrupts/background-runner`（已是独立 SessionManager + TaskStore 持久化） | **复用 `interrupts/background-runner`** 为 Worker 底座 | ① 它**已持久化**（`interrupts/task-store.ts` 原子写 + 启动加载），满足 G6 ② `runEphemeral` 在 `session.ts:4520-4528` 归档后即删除，**做不到续跑**（架构师 Y11 已自陈此冲突）③ 零新执行器代码 |
| **D4** | **首期呈现面** | PM：挂进 Web（复用 SseHub/SessionSidebar）成本更低<br>架构师/测试：首期只做 CLI | **首期 CLI 优先，Web 挂载列为 P2'（紧接其后）** | ① 测试专家已验证「首期不动 web」不破坏 web 42 个测试 ② PM 的 Web 方案更优但会显著扩大首期改动面（web 前端是独立 esbuild IIFE）③ 先 CLI 后 Web 可保持增量可回滚 |
| **D5** | **是否引入 Ticket 依赖 DAG** | 架构师/开发者：砍掉（goal-dispatcher 是 plugin 模型、零持久化、已有两套拓扑排序实现）<br>PM：没提 | **砍掉，首期不做** | `team/orchestrator/plan-graph.ts:324` 与 `team/plugins/goal-dispatcher.ts:183` 已有两套拓扑排序；再引入第三套是典型重复造轮子 |
| **D6** | **是否保留 SQLite 事务层** | 架构师：I2 是地基不能砍<br>PM：文件原子写够用 | **保留，但用 `node:sqlite`** | I2（事务/副作用分离）确实是 Super Agent 的核心不变量，且 `node:sqlite` 已支持 `BEGIN IMMEDIATE`/WAL，零新增风险 |
| **D7** | **Agent 角色来源** | 架构师：35 个物化角色可复用<br>PM：35 个是通用对话角色，不是 Worker 角色 | **首期用「Worker 角色 = Ticket 显式指定的 role 名」**，取自既有 `ROLE_REGISTRY` 5 核心角色 + 30 领域专家；不新造角色体系 | `agents/preset-agents.ts:186 PRESET_AGENT_COUNT` 已物化 35 个；但它们确非「Worker 角色」，首期用既有角色集 + 显式映射最省 |

---

## 3. 保留部分（明确不改）

| 保留项 | 理由 |
|---|---|
| **§3 领域模型 14 概念** | 四角色一致认可；来源有据（DSH `docs/001-domain.md` 直读） |
| **I1–I9 不变量** | 架构师评价值最高的部分；仅 I8 因首期无适用对象而后置 |
| **§5.3 订阅直通 + `routed_via_subscription` 可观测计数** | 架构师评为「全案最有价值设计」；把厂商口径数据转为可验证工程指标 |
| **§5.5 结构化 Attention（不得从自由文本推断）** | DSH 原文硬约束；且项目已有 `tools/ask-user-question-handler.ts` 结构化 questions 同构先例 |
| **D1 默认审批在位 / D2 诚实降级 / D3 flag 默认 off / D4 单一真相源** | 四角色一致认可；D1 正是对 DSH README 自陈攻击面的正确纠偏 |
| **§9 T1–T12 场景集** | 测试专家评为「质量高，直击最危险的语义边界」；仅需重新分级 |
| **§10 差异声明** | 诚实，评审认可 |

---

## 4. 必须砍掉的 speculative 设计（Ponytail 决策梯）

| 砍掉项 | 位置 | 理由 |
|---|---|---|
| 存算分离（轻量 daemon） | §5.6 / P6 | 方案自己写了「首期不做」；调研 §3.2 已论证 WorkBuddy 已产品化（腾讯内部百万级/天） |
| `ports/` 6 个窄接口层 | §4 图 | 首期每个接口只有 1 个实现，YAGNI 教科书案例；抽早了还要改回去 |
| Watchdog（P4）整体后置 | §5.7 / P4 | 首期只检测不自愈，对 G1–G7 零贡献；依赖 P0 稳定状态视图，写必然返工 |
| 模型分层（Router 轻量模型） | §8 R6 | `ModelProfile` 无真实 model id，产不出句柄；首期走 `resolveLlmHandle` 当前配置 |
| Ticket 依赖 DAG | §5.4 / O5 | 见 D5 |
| I8 noWait 限制 | §2 I8 | 首期无主 Session shell 工具，**无适用对象**，是死规则 |
| `Correlation` 概念 | §3.1 | 全文无落地；仅保留词表占位并显式标注「不实现」 |
| `outbox` + `input` 合并为 `ticket_message` | §7 | 首期单信道，两表语义重叠 |
| `channel` 多信道概念 | §3.1 | 首期恒为单元素 |
| Effects 的 `Later` 延期语义 | §2 I2 / §7 | 首期 5 个 effect kind 只需 `pending→running→failed` + 固定重试次数 |

**合并文件（减 5 个）**：`domain/predicates.ts`→`types.ts`；`source/registry.ts`→`kind.ts`；`engine/replies.ts`→`tickets.ts`；`store/read-queries.ts`→`repositories.ts`；`watchdog/` 删除（P4 再建）。

---

## 5. 首期范围重定义（解决 C12）

**核心洞察**：`observe` 影子模式本身就是用户价值——「今天我发现了 N 个候选，其中 M 个看起来值得做」是一个**可交付的、每天可看的**产物，且正是 DSH 原文推荐的上线路径（先 observe 观察判定质量，再切 auto）。

**因此首期用户可见清单**：

1. `deepcode super status` —— 今天发现 N 个候选 / M 个工单在跑 / 累计 token / 需要你决策 K 项
2. `deepcode super candidates` —— observe 影子模式的候选清单（含研判理由与匹配规则）→ **这就是 G2 的首期交付物**
3. `deepcode super tickets` / `ticket <id>` —— 工单详情（含 Mandate / Assignment / Report / Attention）
4. `deepcode super inject` —— 手动注入事件（真实事件源之外的补充，也是回归测试入口）
5. 真实事件源至少 1 个 —— 本地文件变更 watcher（用户自己就能造事件）

**G 重定义**：

| 原 | 新 |
|---|---|
| G2 主动接单 | **G2 主动发现并报告**（observe 影子即交付；auto 为后续开关） |
| G5 人只在验收点被打扰 | **G5 结构化 Attention + 打扰预算**（首期 CLI 呈现即可验收） |
| G6 崩溃可恢复 | 保留（由 `interrupts/task-store` 承担，非新写） |

---

## 6. 修订后文件清单（以清单为唯一事实来源，解决 C4）

**P0–P2 首期生产文件（16 个）**：

```
packages/core/src/super-agent/
├── index.ts                    公共导出（挂 @experimental）
├── runtime.ts                  组合根（组装 Engine/Store/Passes/Router/Worker）
├── domain/types.ts             领域类型 + 状态谓词（合并）
├── domain/ids.ts               确定性 id/key
├── domain/errors.ts             UserError
├── store/schema.ts             DDL + 迁移（node:sqlite，PRAGMA user_version）
├── store/store.ts              Store（唯一打开 DB）+ atomic + afterCommit（node:sqlite 动态 import）
├── store/repositories.ts       实体 CRUD + 只读查询（合并）
├── engine/engine.ts            Engine + 角色 Pick 接口
├── engine/intake.ts            Trigger 幂等 / Thread 关联 / 订阅扇出
├── engine/evals.ts             Eval 批处理 / 超时 requeue / Decision
├── engine/tickets.ts           Ticket 生命周期 + 回复（合并 replies）
├── engine/assignments.ts       Assignment + Report
├── effects/effects.ts          持久化副作用队列
├── passes/passes.ts            周期调度
└── router/{gate,assessment,router}.ts   两级过滤 + 批量决策（3 个）
```

**P3–P4 追加**：`worker/{executor,report}.ts`（复用 background-runner）、`source/{kind,local-watcher}.ts`、`policy/policy.ts`

**CLI**：`packages/cli/src/super/super-cmd.ts`（新）
**改动既有文件（白名单，逐条）**：
- `packages/core/src/index.ts`（+3 行挂载）
- `packages/cli/src/cli-args.ts`（**4 处**）
- `packages/cli/src/cli.tsx`（1 处路由）
- `eslint.config.mjs`（+1 段 no-restricted-imports 门禁）

**测试**：`packages/core/src/tests/super-agent-*.test.ts`（**必须放 `src/tests/` 顶层**，非递归 glob 只扫顶层）6–10 个 + `packages/cli/src/tests/super-cmd.test.ts`

**合计**：约 26–30 个新文件（含测试），较 v1 的 37–41 个减少约 25%。

---

## 7. 工作量诚实化（解决 C14）

| 阶段 | 文件 | 人日 |
|---|---|---|
| P0 领域内核（domain/store/engine/effects/passes） | 12 | 6–8 |
| P1 路由（policy/router） | 4 | 2–3 |
| P2 Worker + Source | 5 | 2–3 |
| 接线（core index / cli-args×4 / cli.tsx / super-cmd） | 6 | 2–2.5 |
| 测试 | 7–11 | 3–4 |
| **首期合计** | **约 26–30** | **约 15–20 人日（单人 3–4 周）** |

**修正声明**：v1 方案 §11「P0–P3 一个迭代内完成并联调」在 37–41 文件规模下不成立。修正为：**首期 = P0–P2（不含 P3 真实事件源）+ P3 最小 Source**，约 15–20 人日；「一个迭代」按团队并行节奏可压到 1.5–2 周。

---

## 8. 修订后必测场景（分级，解决 C8/C9）

| 层 | 场景 | 手段 |
|---|---|---|
| **单测（确定性）** | T1 幂等 / T4 Gate 白名单 / T5 直通不产生 Decision / T6 批量单项失败不阻断 / T7 复验失败保持结束 / T8 Policy 变更不撤销 Mandate / T2a observe 只记 would_accept | 端口全部**函数注入式** stub（禁 mock 框架，照抄 `context-budget.test.ts:12-15` + `fixtures/stub-llm-client.ts`） |
| **集成** | Store 事务/迁移/回滚 / Effects 合并与退避 / T10 审批拦截 / T9 崩溃恢复 | 真 `node:sqlite` 文件库；审批用**真实** `common/permissions.ts`；崩溃用 `spawn` + `SIGKILL`（模板 `eag-e2e-full-pipeline.test.ts:907-975`） |
| **CLI e2e** | `super` 子命令退出码与 stdout/stderr 分离 | `spawnSync("node",["--import","tsx","src/cli.tsx","super",...])`（模板 `quality-cli-e2e.test.ts:82-98`） |
| **CI 冒烟** | 单轮闭环 | **Node 脚本** `tests/scripts/ci-super-agent-smoke.mjs`（非 POSIX `&`），`super start --once` 单轮模式 + 就绪契约；**不使用 `deepcode` 二进制** |
| **人工/nightly** | T2b 真实 LLM 研判质量 | 真实 API key，CI 跳过 |
| **门禁** | 覆盖率 | 新模块**函数覆盖率 ≥ 75%**；全仓阈值不降（`--lines 71 --branches 80 --functions 45`，当前函数余量仅 0.07pp） |

---

## 9. 结论

**方案有条件通过。** 按本报告的 18 项共识问题 + 7 项分歧取舍修订后形成 `proposal-final.md`，随后进入实施。

**修订后仍需用户拍板的唯一产品级问题**：首期范围是「完整 Super Agent 骨架（15–20 人日）」还是「极薄 P0′（约 5 人日，不引 SQLite）」。已在定稿前向用户确认。
