# 智能体群组能力增强方案 v1

- 版本：v1（Phase 1 初版，待四角色评审）
- 日期：2026-11-01
- 依据：`docs/team-wiring-audit-20261101.md`（现状基线）+ `industry-research.md`（dsh 参照）

---

## 一、目标与非目标

### 目标

| # | 目标 | 可验证的成功标准 |
| --- | --- | --- |
| G1 | Web 端 `/team` 命令真实可执行 | 在 Web 输入框发送 `/team list`，服务端返回真实的 5+35 个角色清单，而非 LLM 自由发挥的一段文字 |
| G2 | SKILL.md 智能体成为 team 成员 | `/team match "增长方案"` 能命中 `marketing` 类别的预置专家（当前只能命中 5 个硬编码角色） |
| G3 | `/team dispatch` 能真正改代码 | 一条 dispatch 任务产生的文件改动，可在 `git diff` 中看到 |
| G4 | 30 位领域专家的匹配能力可达 | 从 CLI / Web 均可调用领域专家匹配，且至少有一条生产路径使用它 |
| G5 | dispatch 全过程可审计 | 每一次 dispatch 的输入、角色匹配结果、LLM 轮次、工具调用、产出，可从落盘文件重建 |

### 非目标（明确不做）

| # | 不做 | 理由 |
| --- | --- | --- |
| N1 | 重写为 Cordis 式插件树 | 19M 源码、成熟的 Session/Tool/Skill 三层 + Tauri 壳，全量插件化迁移风险 >> 收益 |
| N2 | 226 个 package 的拆分粒度 | 那是为「第三方替换整个运行时」设计的，DeepCodeX 无此诉求 |
| N3 | 全量会话改造为事件溯源 | 影响面过大（`session.ts` 8000+ 行）；本方案只对「dispatch 链路」做事件化，不动主对话 |
| N4 | 更换现有 session 落盘格式 | 会破坏已上线用户的会话文件兼容性 |
| N5 | 引入新的运行时依赖 | 现有依赖已足够 |

---

## 二、现状基线（摘自审计报告，此处只列关键结论）

```
CLI:  /team → handleTeamSlashCommand → executeTeamCommand → matchRoles/executeDispatch  ✅ 通
Web:  5 条描述符注入 availableCommands，无执行体                                  ❌ 断
      core session.ts:4262-4321 的 switch 只处理 EAG 系列，无 team 分支
Team 角色:  5 个硬编码 const，无 registerRole API                                  ⛔ 不可扩展
SKILL.md 智能体: 35 个（本次已补齐预置），有完整工具循环                            ✅ 通
领域专家: 数据 + 841 行匹配器 + 489 行注册表，core/index.ts 未导出 → 死代码        ❌ 不可达
dispatch 执行体: 单次 LLM 调用，ToolExecutor 只在一行注释里出现                     ⚠️ 无工具
```

---

## 三、方案总览

按投入产出比分三层，**L0 必须先做（当前是「看起来能用实则不能用」的错误状态）**。

```
┌─────────────────────────────────────────────────────────────────────┐
│ L0 打通（1 周）                                                     │
│  L0-1 Web team 执行体：抽出纯函数 + core 命令分支 + Web 路由        │
│  L0-2 角色注册表运行时扩展：buildRolesFromAgents(SKILL.md → Role)   │
├─────────────────────────────────────────────────────────────────────┤
│ L1 增强（2-3 周）                                                   │
│  L1-1 executeDispatch 补工具轮次                                    │
│  L1-2 开放领域专家 + 匹配结果注入 dispatch prompt                   │
│  L1-3 dispatch 事件日志（局部事件化，可回放）                       │
├─────────────────────────────────────────────────────────────────────┤
│ L2 观望（不做，仅记录）                                             │
│  L2-1 seam 化（能力定义/提供方/消费方三层 + conformance suite）      │
│  L2-2 全量会话事件溯源 + fork/replay                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、L0-1：Web team 执行体

### 4.1 设计原则

**单一执行体，双宿主复用。** 当前 `executeTeamCommand` 直接写 `process.stdout`（`packages/cli/src/team/team-cmd.ts`），这让它无法被 Web 调用——CLI 侧也只能靠拦截 `process.stdout.write` 硬接（`App.tsx:2242-2270`）。正确做法是**把「产生结果」与「打印结果」分离**，这与 dsh「斜杠命令不消耗模型调用、由宿主渲染」的思路一致。

### 4.2 改动清单

| # | 文件 | 动作 | 说明 |
| --- | --- | --- | --- |
| 1 | `packages/core/src/team/team-command.ts` | **新增** | 纯执行函数 `runTeamCommand(args): Promise<TeamCommandResult>`，返回 `{ exitCode, stdout, stderr, data? }`，**不写任何 process.stdout** |
| 2 | `packages/cli/src/team/team-cmd.ts` | 改造 | `executeTeamCommand` 改为薄壳：调 `runTeamCommand` 后写 stdout。删除 App.tsx 的 write 拦截 |
| 3 | `packages/core/src/session.ts` | 改造 | 在 `eagCommandParser.parse()` 分支旁（第 4262 行前）新增 `teamCommandParser.parse(userPrompt)`，命中则调 `runTeamCommand`，结果作为 assistant 消息写回会话 |
| 4 | `packages/core/src/index.ts` | 导出 | `export { runTeamCommand }`、`export type { TeamCommandResult }` |
| 5 | `packages/web/src/session-pool.ts` | 简化 | 删除自建的 5 条 team 描述符（413-446 行），改为从 core 的 `buildTeamCommandDescriptors()` 取（与 EAG 描述符同源） |

### 4.3 关键接口

```ts
// packages/core/src/team/team-command.ts
export interface TeamCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  /** 结构化产物：list → 角色数组；match → 匹配结果；dispatch → 分派结果 */
  data?: unknown
}

export async function runTeamCommand(args: TeamCommandArgs): Promise<TeamCommandResult>
```

`session.ts` 侧接入点（示意）：

```ts
const teamCommand = teamCommandParser.parse(userPrompt)
if (teamCommand !== null) {
  const result = await runTeamCommand(teamCommand)
  this.appendAssistantMessage(sessionId, result.stdout || result.stderr)
  return
}
```

### 4.4 为什么不复用 EAG 的自动注入通道

`session-pool.ts:1376-1377` 注释说明「Web 宿主无 TUI slash 执行体，不适用 `AUTO_EXECUTABLE_COMMAND_KINDS` 通道」。EAG 的通道是「LLM 建议 → 抽取命令字符串 → 再注入」，适用于**模型主动建议**的场景。team 命令是**用户主动输入**，走 `session.ts` 的命令解析更直接，也避免「字符串往返」这一层脆弱环节。

### 4.5 验收标准

| # | 验收项 | 方法 |
| --- | --- | --- |
| A1 | Web 发送 `/team list` 返回 40 个角色（5 核心 + 35 智能体，见 L0-2） | 手工 + 单测 |
| A2 | Web 发送 `/team match --keywords 测试` 返回 `test-expert` | 单测 |
| A3 | CLI 的 `/team list` 输出与改动前**逐字节一致** | 快照对比 |
| A4 | `session.ts` 的单测全部通过 | `npm test` |
| A5 | Web 端不再出现「只有描述符无执行体」的死菜单 | 代码审查 |

---

## 五、L0-2：角色注册表运行时扩展

### 5.1 问题

`packages/core/src/team/role-registry.ts` 只有 5 个 `const xxxRole: RoleDefinition = {...}`（82/163/244/325/413 行），**没有任何注册 API**。检索 `registerRole|addRole|ROLE_REGISTRY.(push|set)` 全仓 0 命中。这导致刚落盘的 35 个预置智能体对 `/team` 完全不可见。

### 5.2 设计要点

**不做**「把 SKILL.md 全部当角色」——35 个智能体里有很多是纯知识型专家（如「学术论文润色」），拿去 dispatch 反而拉低匹配质量。

**做法**：只转换**声明了 `role` 或 `group` 的**智能体，且 RoleDefinition 的必填字段从 frontmatter 兜底推导。

```ts
// packages/core/src/team/role-registry-runtime.ts（新增）
export interface RuntimeRoleRegistry {
  /** 静态 5 角色 + 运行时注册 */
  list(): RoleDefinition[]
  register(def: RoleDefinition): void
  unregister(id: string): void
  clear(): void
}

/** 从 SkillManager 扫描结果构造 RoleDefinition（跳过不具备 role/group 的 skill） */
export function buildRolesFromAgents(skills: SkillInfo[]): RoleDefinition[]
```

映射规则：

| RoleDefinition 字段 | 来源 |
| --- | --- |
| `id` | `skill.name`（已是 kebab-case，本次预置已保证唯一） |
| `name` / `description` | frontmatter 同名 |
| `capabilities` | `group` 映射到能力类别（8 类） |
| `skills` | frontmatter 未提供 → 空数组（不伪造） |
| `keywords` | 从 `description` 分词 + `group` 标签推导 |
| `priority` | `preset: true` → `"medium"`；用户自建 → `"low"`（避免挤占 5 个核心角色） |

### 5.3 变更 `matchRoles`

`role-matcher.ts` 的候选集来源从 `ROLE_REGISTRY`（常量）改为**参数注入**：

```ts
// 现状签名（示意）
matchRoles(task: TaskRequirement, options?: MatchOptions): MatchResult[]

// 目标：options 增加 candidates?: RoleDefinition[]
// 未传时行为与现在完全一致（向后兼容）
```

这是 **Surgical Changes**：不改匹配算法，只改候选集来源。

### 5.4 验收标准

| # | 验收项 | 方法 |
| --- | --- | --- |
| B1 | 未传 `candidates` 时，`matchRoles` 结果与改动前逐字段一致 | 现有单测全绿 + 快照 |
| B2 | 传 35 个 agent 转换后，`/team match --keywords 增长` 命中 `marketing` 类专家 | 新增单测 |
| B3 | 5 个核心角色的匹配优先级仍高于预置专家 | 新增单测 |
| B4 | 用户删除某个 SKILL.md 后，该角色自动消失（无残留） | 新增单测 |

---

## 六、L1-1：executeDispatch 补工具轮次

### 6.1 问题定性

`packages/core/src/team/team-adapter.ts:11` 注释声称「dispatcher 调度后调用 ToolExecutor 执行实际工具」，但 `ToolExecutor` 在整个 `packages/core/src/team/` 只出现在这一行注释里。`executeDispatch` 的真实行为是「拼 system prompt → 一次 chat completion → 取文本」。

**这是注释与实现不符**，属于必须修的问题：它会让后续维护者误判能力边界。

### 6.2 两条路径，推荐路径 B

| 路径 | 做法 | 代价 | 风险 |
| --- | --- | --- | --- |
| A | 在 `team-adapter.ts` 内自建工具循环 | 需重复实现工具注册、审批、护栏、轮次上限 | 高（与 `SessionManager` 语义漂移） |
| **B（推荐）** | `executeDispatch` 改为「构造 role system prompt → 调 `SessionManager` 的现有会话执行入口」 | 需给 `SessionManager` 暴露一个 `runWithSystemPromptOverride(prompt, task)` 的窄接口 | 中（触碰 `session.ts`，但只增不改） |

路径 B 的收益：dispatch 自动继承**已有的**工具轮次、审批、护栏、token 预算、thinking 参数——这正是 dsh「seam 复用」的等价效果，而不需要引入插件体系。

### 6.3 验收标准

| # | 验收项 | 方法 |
| --- | --- | --- |
| C1 | `/team dispatch --task "在本仓库新建 docs/demo.md 写入 hello"` 后文件真实存在 | E2E |
| C2 | dispatch 的 token 预算、轮次上限与主对话一致 | 单测 |
| C3 | 工具审批在 dispatch 路径同样生效（不可绕过） | 单测 |
| C4 | `team-adapter.ts` 头部注释与实际实现一致（或直接删除误导性注释） | 代码审查 |

---

## 七、L1-2：开放领域专家

### 7.1 三处改动

| # | 文件 | 动作 |
| --- | --- | --- |
| 1 | `packages/core/src/index.ts` | re-export `DomainExpertRegistry`、`DomainExpertMatcher`、`registerAllExperts`、`ALL_DOMAIN_CATEGORIES`、`EXPECTED_TOTAL_EXPERTS` |
| 2 | `team-adapter.ts` | `executeDispatch` 内：角色匹配后，用 `DomainExpertMatcher` 对 task 做一次领域匹配；命中（score ≥ 阈值）则把专家描述追加到 system prompt 的「领域知识」段 |
| 3 | `packages/core/src/tests/` | 为匹配器补一条**生产路径**单测（当前只有 e2e 覆盖） |

### 7.2 阈值与退让

- 领域匹配分数低于阈值 → **不注入**，保持原 dispatch 行为（避免噪音专家污染 prompt）。
- 一次 dispatch 最多注入 **1 位**专家（dsh 的 lesson：上下文是稀缺资源，不是越多越好）。

### 7.3 验收标准

| # | 验收项 | 方法 |
| --- | --- | --- |
| D1 | `import { DomainExpertMatcher } from "@vegamo/deepcode-core"` 编译通过 | tsc |
| D2 | 一条「写增长方案」的 dispatch，system prompt 中含 marketing 专家段 | 单测断言 prompt |
| D3 | 低相关任务的 system prompt **不含**专家段 | 单测 |
| D4 | 专家匹配器有生产调用点（非仅测试） | 代码扫描 |

---

## 八、L1-3：dispatch 事件日志（局部事件化）

### 8.1 只做 dispatch，不做全量会话

借鉴 dsh 的 `SessionEvent` 信封（`{type, seq, time, data, ignorable?}`）与「model-visible means logged」不变量，但**只作用于 team dispatch 链路**，不动主对话：

```ts
// packages/core/src/team/dispatch-log.ts（新增）
export type DispatchEventType =
  | "dispatch/start"      // { task, roleCandidates }
  | "dispatch/match"      // { matchedRole, score, reasons }
  | "dispatch/expert"     // { expertId, score }  ← 命中领域专家时
  | "dispatch/llm-call"   // { round, requestTokens }
  | "dispatch/tool-call"  // { tool, args }
  | "dispatch/tool-result"// { tool, ok }
  | "dispatch/end"        // { reason: "completed" | "aborted" | "error" | "max-rounds" }
```

落盘：`~/.deepcode/team-runs/<runId>/events.jsonl`（沿用现有 `Runs` 目录约定，不新增目录语义）。`seq` 单调递增、append-only、崩溃后追加合成 `dispatch/end`（对齐 dsh 的 synthetic closers 而非截断）。

### 8.2 为什么值得做

| 收益 | 说明 |
| --- | --- |
| 可回放 | 用户问「上次那个 dispatch 为什么选错角色」，能给出确切依据 |
| 可评估 | 角色匹配质量第一次可度量（匹配分 vs 人工判断），为后续调权重提供数据 |
| 不侵入 | 独立文件，不改 `session.ts` 的会话结构，N3/N4 非目标得以保持 |

### 8.3 验收标准

| # | 验收项 | 方法 |
| --- | --- | --- |
| E1 | 一次 dispatch 产生 events.jsonl，`seq` 从 1 连续无缺口 | 单测 |
| E2 | 进程被 kill 后重跑，日志追加合成 `dispatch/end`，**不截断** | 故障注入 |
| E3 | 事件文件可独立解析重建完整 dispatch 过程 | 单测 |

---

## 九、风险与缓解

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | L0-1 抽取纯函数时改变 CLI 输出格式，破坏既有快照测试 | 中 | A3 设「逐字节一致」验收；先写快照测试再改 |
| R2 | L0-2 让 `/team match` 候选从 5 变 40，匹配质量下降 | **高** | B3 优先级约束 + 只在声明 `role`/`group` 时转换；上线后看 L1-3 日志的匹配分布 |
| R3 | L1-1 路径 B 触碰 `session.ts`（8000+ 行），引入回归 | **高** | 只增窄接口不改既有分支；全量 `npm test` 门禁 |
| R4 | L1-2 注入专家 prompt 导致 token 膨胀 | 中 | 单次最多 1 位专家 + 阈值退让 |
| R5 | 用户已自定义的 SKILL.md 被当作角色后行为不可预期 | 中 | 仅 `preset: true` 或显式声明 `role` 的才转换 |
| R6 | 各阶段并行开发导致改动冲突 | 低 | L0 必须先合入再开 L1 |

---

## 十、工作量估算

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| L0-1 | Web team 执行体 | 1.5 天 |
| L0-2 | 角色注册表扩展 | 1.5 天 |
| L1-1 | dispatch 工具轮次 | 2 天 |
| L1-2 | 领域专家开放 | 1 天 |
| L1-3 | dispatch 事件日志 | 2 天 |
| 合计 | | **8 人日**（不含评审往返） |

---

## 十一、Karpathy / Ponytail 自检

| 原则 | 本方案的落实 |
| --- | --- |
| 🧠 Think Before Coding | 先在审计报告中把「已接/未接」逐条落到文件行号，再设计；未凭印象假设 |
| 🎯 Simplicity First | 拒绝插件树重写（N1/N2）、拒绝全量事件溯源（N3/N4）；L1-3 只做 dispatch 局部事件化 |
| 🔬 Surgical Changes | `matchRoles` 只改候选集来源不改算法；`session.ts` 只增窄接口；Web 侧删除自建描述符改为复用 core |
| ✅ Goal-Driven | 5 条目标各配可验证验收标准，共 21 条验收项 |
| 🪜 Ponytail 决策梯 | L0-1 先问「能否复用现有 executeTeamCommand」→ 能，故抽取而非重写；L1-1 先问「能否复用 SessionManager」→ 能，故走路径 B 而非自建工具循环 |
