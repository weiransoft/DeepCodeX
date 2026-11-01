# 智能体群组能力增强方案 v2（定稿）

- 版本：v2 定稿（Phase 4）
- 日期：2026-11-01
- 变更依据：`consensus-report.md`（7 项共识问题 + 5 项单角色阻断 + 3 项分歧裁决）
- 前置文档：`industry-research.md`（dsh 调研）、`docs/team-wiring-audit-20261101.md`（现状审计）

---

## 〇、v1 → v2 的四处关键修正

| # | v1 的问题 | v2 的修正 |
| --- | --- | --- |
| 1 | `buildRolesFromAgents` 放 `team/` → 与 `agents/` 成环 | 移到 `agents/role-bridge.ts`，依赖方向保持单向 `agents → team` |
| 2 | 用中文分词从 description 生成 keywords | **只用 `group`（8 个固定类别）枚举映射**，零新依赖、可预测 |
| 3 | 验收项内部化、不可测 | 重写为「自动化断言 + 用户可见」双栏，A3/B1 拆分，新增 Playwright 冒烟 |
| 4 | 只做单角色派单，与「群组」诉求脱节 | 新增 **L0-3：`/team autonomous` + `/team full-lifecycle` 在 Web 打通**，作为群组的最小可见载体 |

---

## 一、目标（v2 修订）

| # | 目标 | 成功标准 |
| --- | --- | --- |
| G1 | Web `/team` 命令真实可执行 | Web 输入 `/team list`，服务端返回结构化角色清单，**不进入 LLM 对话** |
| G2 | SKILL.md 智能体成为 team 成员 | `/team match --keywords 增长` 命中 `marketing` 类预置专家 |
| G3 | `/team dispatch` 能真正改代码 | dispatch 产生的文件改动可在 `git diff` 中看到 |
| G4 | 领域专家匹配能力可达 | 从 core 公共 API 可 import 并调用；至少一条生产路径使用 |
| G5 | dispatch 全过程可审计 | 输入、匹配、LLM 轮次、工具调用、终态可从落盘文件重建 |
| **G6** | **群组能力对用户可见可感** | **Web 上能启动 `/team autonomous`，看到 plan→dev→verify→fix 阶段推进与终态** |
| **G7** | **不破坏既有任何能力** | **web 297 用例、core 全量单测、CLI team 4 套测试全绿；`cargo check` 通过** |

### 非目标（v2 修订，新增 N6/N7）

| # | 不做 | 理由 |
| --- | --- | --- |
| N1 | 重写为 Cordis 式插件树 | 19M 源码 + 成熟三层 + Tauri 壳，迁移风险 >> 收益 |
| N2 | 226 个 package 拆分粒度 | 为「第三方替换运行时」设计，无此诉求 |
| N3 | 全量会话改造为事件溯源 | `session.ts` 8000+ 行，只对 dispatch 局部事件化 |
| N4 | 更换现有会话落盘格式 | 破坏已上线用户兼容性 |
| N5 | 引入新运行时依赖 | 现有依赖足够（含"无中文分词依赖"这一约束） |
| **N6** | **本期不做「一任务自动拆解 → 多角色并行 → 结果聚合」** | 需任务 DAG 拆解 + 聚合 + 冲突消解，是独立大工程（约 +12 人日）。本期以「多阶段闭环」承载群组语义 |
| **N7** | **不改 Web 主对话的会话结构** | 与 N3 呼应；dispatch 用临时会话，不污染用户会话 |

---

## 二、架构（v2，含依赖方向）

**核心约束：依赖只能向下，`agents → team`，`commands → {team, agents}`，永不反向。**

```
┌─────────────────────────────────────────────────────────┐
│ 宿主层                                                   │
│  CLI (App.tsx / parse-team-args)     Web (session-pool)  │
└───────────────┬─────────────────────────┬───────────────┘
                │                         │
┌───────────────▼─────────────────────────▼───────────────┐
│ core/commands/team-command.ts  ← 新增（跨宿主命令执行体） │
│   runTeamCommand(args, deps?) → {exitCode, stdout, ...}  │
│   ↑ 不写 process.stdout；deps.candidates 由宿主注入       │
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────┐
│ core/agents/role-bridge.ts  ← 新增（agents → team 单向）  │
│   buildRolesFromAgents(skills): RoleDefinition[]         │
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────┐
│ core/team/**（保持零上游依赖）                            │
│   role-registry (5 const)  role-matcher   team-adapter    │
│   domain-expert-matcher    workflow-loop  autonomous/     │
└──────────────────────────────────────────────────────────┘
```

**为什么 `commands/` 单独一层**：`team/` 已有 23 个 `.ts` + 8 个子目录，塞命令执行器会继续膨胀；且未来 `rules` 等跨宿主命令也应归此层。参考 dsh 的做法——命令属于 human&host 关注点，不属于能力领域。

---

## 三、L0-1：Web team 执行体（1 天 + 1.5 天回归）

### 3.1 改动清单

| # | 文件 | 动作 | 关键点 |
| --- | --- | --- | --- |
| 1 | `core/commands/team-command.ts` | 新增 | `runTeamCommand(args, deps?)` 纯执行，返回结构 |
| 2 | `core/commands/types.ts` | 新增 | `TeamCommandArgs` / `TeamSubcommand` / `TeamCommandResult` 的**唯一权威定义** |
| 3 | `cli/team/team-cmd.ts` | 改造 | `TeamCommandArgs` 改为 re-export；`executeTeamCommand` 变薄壳（调 runTeamCommand + 写 stdout） |
| 4 | `cli/ui/core/parse-team-args.ts` | 微调 | import 路径改为从 core re-export 取（保持 `../../team/team-cmd` 也可，因已 re-export） |
| 5 | `core/session.ts` | 改造 | 第 4262 行前插入 team 命令分支（**只增不改**既有 EAG 分支） |
| 6 | `core/index.ts` | 导出 | `runTeamCommand` + 相关类型 |
| 7 | `web/src/session-pool.ts` | 简化 | 删除自建 5 条 team 描述符（413-446 行），改为 core 提供的 `buildTeamCommandDescriptors()` |

### 3.2 类型迁移顺序（三步，各自可编译可测）

```
Step 1  在 core/commands/types.ts 定义类型 → cli/team/team-cmd.ts 改为 re-export
        验收：tsc 通过 + CLI 的 4 套 team 测试全绿
Step 2  在 core/commands/team-command.ts 实现 runTeamCommand（逻辑从 CLI 平移）
        验收：新增 core 单测通过；CLI 输出格式断言通过
Step 3  删除 cli/team/team-cmd.ts 内的实现体，仅保留薄壳
        验收：CLI 4 套测试 + Web 297 用例全绿
```

### 3.3 write 拦截的处理（分两 commit，不合并）

```ts
// App.tsx 顶部新增
const INTERCEPT_TEAM_STDOUT = false;   // commit A：默认关闭但保留代码
```

- **commit A**：只加常量开关、改为条件拦截，手工跑 `/team list`、`/team dispatch`、`/team autonomous` 各一次，确认 Ink 渲染无破损。
- **commit B**（A 验证通过后）：删除 30 行拦截代码。

> 该段代码处理 Node `write` 的三种重载并在 `finally` 恢复（`App.tsx:2242-2270`），其存在说明团队曾因此踩坑。不在同一提交里既改执行体又删它。

### 3.4 会话归属（修正 A-01「幽灵会话」）

dispatch 产生的会话必须标记为**临时会话**：

```ts
// SessionManagerOptions 新增
ephemeral?: boolean
```

语义：

| 项 | 临时会话行为 |
| --- | --- |
| 会话索引 | 不写入 |
| `appendAgentIndexMessage` | **不调用**（避免误触发默认智能体自动激活） |
| 用户会话列表 | 不可见 |
| 归档 | 按 `dispatch/end` 事件归档到 `.deepcode/team-runs/<runId>/` |
| 可 fork / replay | 允许（用于审计） |

### 3.5 验收

| # | 自动化断言 | 用户可见 |
| --- | --- | --- |
| A1 | Web `POST` 会话消息 `/team list` → 返回体含角色数组，`role` 字段为 `assistant` 且 **不触发 LLM 调用**（断言 mock 的 chat completion 未被调用） | 在 Web 输入框敲 `/team list`，屏幕上出现角色清单表格，**不再是一段模型自由发挥的文字** |
| A2 | `/team match --keywords 测试` → top-1 `roleId === "test-expert"` | 同上，看到匹配结果卡片 |
| A3 | ① 格式断言：首行输出以角色表头开始、条目数 == 期望、退出码 == 0；② golden file diff 仅允许「预置新增行」 | CLI 输出与改动前观感一致，仅多出新角色行 |
| A4 | dispatch 使用 `ephemeral: true`：会话索引长度不变、`appendAgentIndexMessage` 调用次数为 0 | 跑完 dispatch 后在会话列表里**看不到多余会话** |
| A5 | 既有 EAG 分支行为不变：`eagCommandParser` 相关单测全绿 | — |
| A6 | `web/src` 中 team 描述符来自 core 而非自建（代码扫描断言） | — |

---

## 四、L0-2：角色候选集扩展（1.5 天）

### 4.1 落位与映射（修正 C-01）

```ts
// core/agents/role-bridge.ts（新增，依赖方向 agents → team）
export interface BuildRolesOptions {
  /** 是否允许用户自建智能体进入候选（默认 false） */
  allowUserAgents?: boolean
}
export function buildRolesFromAgents(
  skills: SkillInfo[],
  options?: BuildRolesOptions
): RoleDefinition[]
```

**只转换满足以下全部条件的智能体**：

1. `skill.type === "agent"`
2. `skill.group` 非空且 ∈ 8 个已知类别
3. `skill.preset === true` **或** `options.allowUserAgents === true`

### 4.2 keywords 生成（修正 C-02，Ponytail 决策梯第 1/2 级）

```ts
// 8 个固定类别 → 固定关键词集，纯枚举映射，零依赖
const GROUP_KEYWORDS: Record<DomainCategory, string[]> = {
  product:              ["需求", "PRD", "用户故事", "验收标准"],
  "project-management": ["流程", "排期", "里程碑", "交付"],
  strategy:             ["战略", "定位", "路线图", "竞争"],
  support:              ["支持", "工单", "服务", "培训"],
  specialized:          ["专项", "深度", "领域"],
  academic:             ["论文", "研究", "文献", "学术"],
  marketing:            ["增长", "投放", "内容", "品牌", "获客"],
  sales:                ["销售", "商机", "客户", "成单"],
}
keywords = [...GROUP_KEYWORDS[group]]
```

**不解析 `description`。** 理由：项目无中文分词依赖，伪分词质量差反而拉低匹配；且 description 是不可信文本（见 §4.3）。

### 4.3 安全硬门禁（修正 C-02/D-02）

| 规则 | 强度 |
| --- | --- |
| 只有 `preset: true` 进入默认候选 | **硬门禁**（代码级 if，非配置） |
| 自建智能体需 `team.runtimeRoles.allowUserAgents = true` | 显式开关，默认 false |
| 开启后，自建智能体的 `description` **只作为匹配元数据**，不拼入 system prompt 指令区 | 硬约束 |
| `group` 必须 ∈ 8 类别，否则不转换 | 硬门禁 |

### 4.4 灰度开关

```jsonc
// ~/.deepcode/settings.json
{
  "team": {
    "runtimeRoles": {
      "enabled": false,          // 默认关闭，验证后开
      "allowUserAgents": false   // 默认关闭
    }
  }
}
```

`enabled: false` 时 `buildRolesFromAgents` 返回 `[]`，`/team` 行为与现状完全一致——**这是一键回滚**。

### 4.5 优先级约束（修正 R2 匹配质量下降）

| 角色来源 | `priority` | 匹配时的排序 |
| --- | --- | --- |
| 5 个核心角色（`ROLE_REGISTRY`） | 原值（high/medium） | 优先 |
| 预置专家（`preset: true`） | `medium` | 次之 |
| 用户自建 | `low` | 最后 |

`matchRoles(task, { candidates })`：**只改候选集来源，不改算法**（Surgical Changes）。未传 `candidates` 时行为与现状逐字段一致。

### 4.6 验收

| # | 自动化断言 | 用户可见 |
| --- | --- | --- |
| B1a | `matchRolesSync` 未传 candidates，结果 snapshot 与改动前**逐字段一致** | — |
| B1b | AI 路径（stub 掉 LLM）：返回结构合法、top-1 `roleId ∈ candidates`、`score ∈ [0,1]`，**不做值断言** | — |
| B2 | 传 35 个转换后角色，`/team match --keywords 增长` → top-1 属 `marketing` 类 | 搜「增长」能看到营销专家被选中 |
| B3 | 关键词同时命中核心角色与预置专家时，核心角色排前 | — |
| B4 | 删除某 `SKILL.md` 后重建，该角色不在结果中（无残留） | 删掉的智能体不再出现在 `/team list` |
| **B5** | `team.runtimeRoles.enabled=false` → `buildRolesFromAgents` 返回 `[]`，`/team list` 仅 5 条 | 开关关闭即回到现状 |
| **B6** | 自建智能体（`allowUserAgents=false`）不进入候选 | — |
| **B7** | 开启 `allowUserAgents` 后，自建智能体的 description **不出现在** dispatch system prompt 中（prompt 快照断言） | — |
| **B8** | `/team list` 输出按 8 类别分组，标注预置/自建 | 角色清单按业务类别分组、可辨识来源 |

---

## 五、L0-3：群组的最小可见载体（新增，2 天）

### 5.1 为什么需要

v1 被产品经理判为「把群组做成了单角色派单」。共识裁决（D-01）选择折中：**本期不做自动多角色拆解，但必须让「多阶段协同」对用户可见。**

`RalphLoopController`（plan→dev→verify→fix）与 `WorkflowLoopController`（八阶段）在 CLI 已通、Web 未接。接通过来，用户就能看到「一个任务被多个阶段、多个角色依次推进」，这是当前最经济、最稳的「群组」实现。

### 5.2 改动清单

| # | 文件 | 动作 |
| --- | --- | --- |
| 1 | `web/src/session-pool.ts` | 新增 `handleTeamAutonomousCommand` / `handleTeamFullLifecycleCommand`，仿 `handleEagAutonomousCommand` 的模式 |
| 2 | `core/commands/team-command.ts` | `runTeamCommand` 支持**进度回调** `onProgress?: (event) => void` |
| 3 | `web/src/session-pool.ts` | 进度事件经现有 `hub.publish(chatId, "assistant_message", ...)` 推给前端 |
| 4 | `web/web/src/components/`（复用现有消息渲染） | 阶段推进以系统消息卡片呈现（不新增组件，复用 `role: "system"` 渲染） |

### 5.3 验收

| # | 自动化断言 | 用户可见 |
| --- | --- | --- |
| F1 | Web 发送 `/team autonomous --goal "..."` → 收到 ≥1 条 `role: "system"` 的进度消息 | Web 上**看到** plan→dev→verify→fix 的阶段推进 |
| F2 | 终态写入 `dispatch/end`，`reason ∈ {completed, aborted, error, max-iterations}` | 跑完看到明确的成功/失败结论，不是静默结束 |
| F3 | `/team full-lifecycle` 在 Web 可启动并推进到阶段 2（限时断言，不跑完整 8 阶段） | 看到八阶段进度条 |

---

## 六、L1 阶段（2-3 周）

### 6.1 L1-1：dispatch 补工具轮次（3.5 天）

**修正 A-02/C-06**：不走宽接口，改为窄接口 + 编译期强制审批。

```ts
// core/session.ts 新增（只增不改）
export interface EphemeralRunOptions {
  roleSystemPrompt: string
  task: string
  maxToolRounds: number
  /** 字面量 true：让「关掉审批」在编译期不可能 */
  readonly requireApproval: true
}
export interface EphemeralRunResult {
  text: string
  toolCalls: Array<{ tool: string; ok: boolean }>
  rounds: number
  endReason: "completed" | "max-rounds" | "aborted" | "error"
}
```

`executeDispatch` 改为调 `runEphemeral`，自动继承工具轮次、审批、护栏、token 预算、thinking 参数。

**同时删除 `team-adapter.ts:11` 那条与实现不符的注释**（「dispatcher 调度后调用 ToolExecutor 执行实际工具」）。

**验收**：C1 文件真实存在（E2E）；C2 token 预算/轮次与主对话一致；C3 审批生效 + SEC-1~3 对抗用例通过；C4 注释与实现一致。

### 6.2 L1-2：开放领域专家（1 天）

- `core/index.ts` re-export `DomainExpertRegistry` / `DomainExpertMatcher` / `registerAllExperts` / `ALL_DOMAIN_CATEGORIES` / `EXPECTED_TOTAL_EXPERTS`
- `executeDispatch` 中：角色匹配后做领域匹配，**score ≥ 0.6**（`team.expertInjection.minScore`，初值 0.6）且**一次最多注入 1 位**专家
- 阈值以下不注入，保持原行为

**附加评估项**（架构师 S-04）：注入专家段会改变 prompt 前缀，需评估对 provider 侧 prompt caching 的影响；若命中率低，考虑把专家段放在 prompt 末尾。

**验收**：D1 公共 API 可 import；D2 相关任务 prompt 含专家段；D3 低相关任务不含；D4 存在生产调用点。

### 6.3 L1-3：dispatch 事件日志（2.5 天）

**修正 C-04，新增 Task 0 前置**：

> **Task 0（0.5 天）**：读 `team/autonomous/` 的 `RunState` 实现（`core/index.ts:783` 导出 `RunState`/`listRuns`/`findLatestResumableRun`）。**能扩展则扩展，不能则在本文档补一节说明理由后再新建。**

若需新建：

```ts
export type DispatchEventType =
  | "dispatch/start" | "dispatch/match" | "dispatch/expert"
  | "dispatch/llm-call" | "dispatch/tool-call" | "dispatch/tool-result"
  | "dispatch/end"
```

- 落盘：**项目级 `.deepcode/team-runs/<runId>/events.jsonl`**（对齐 CLI `--auto-run-dir` 的项目级约定；会话数据仍在 `~/.deepcode/`）
- `seq` 单调递增、append-only
- 崩溃修复：**追加合成 `dispatch/end`，不截断**（对齐 dsh 的 synthetic closers）
- **并发隔离**：每次 dispatch 独立 `runId` 目录，seq 生成器不跨 run 共享

**验收**：E1 seq 连续无缺口；E2 `SIGKILL` 后重跑 → 事件数 = 崩溃前 + 1，且原事件逐条未变；E3 可独立解析重建；**E4 并发 2 个 dispatch → 各自 seq 从 1 起、无交叉无重复**；**E5 引擎重启期间 → 终态 `aborted` + `cause: "engine-restart"` + 用户收到可见提示**。

---

## 七、G ↔ 验收矩阵（修正 C-03）

| 目标 | 对应验收项 | 用户可见验收 |
| --- | --- | --- |
| G1 | A1, A2, A3, A6 | ✅ 输入 `/team list` 看到角色清单，不再是模型自由发挥 |
| G2 | B2, B3, B4, B5, B6, B8 | ✅ 搜「增长」能选中营销专家 |
| G3 | C1, C2, C3, C4 | ✅ dispatch 后能看到文件被改 |
| G4 | D1, D2, D3, D4 | ⚪ 间接（prompt 层面，用户无直接感知） |
| G5 | E1, E2, E3, E4, E5 | ✅ 能查「上次为什么选这个角色」 |
| G6 | F1, F2, F3 | ✅ 看到 plan→dev→verify→fix 阶段推进 |
| G7 | 质量门禁（§8 全部） | — |

**新增自动化用例清单**：A4/A5/A6、B1a/B1b/B5/B6/B7/B8、SEC-1~3、E4/E5、F1/F2/F3、默认 agent 指向已删除项（A-05）。共 **18 条新增断言**。

---

## 八、质量门禁（修正 C-06）

合入前必须全部满足，任一不满足即阻止合并：

| # | 门禁 | 命令 |
| --- | --- | --- |
| 1 | core `tsc` 通过 | `cd packages/core && npx tsc --noEmit` |
| 2 | web 服务端 `tsc` 通过 | `cd packages/web && npx tsc --noEmit` |
| 3 | web 前端 `tsc` 通过 | `cd packages/web/web && npx tsc --noEmit` |
| 4 | web 测试 ≥297 且 0 fail | `cd packages/web && npm test` |
| 5 | core 全量单测通过 | `cd packages/core && npm test` |
| 6 | CLI team 4 套测试通过 | `team-cmd-*.test.ts` |
| 7 | Rust 编译通过 | `cd desktop/src-tauri && cargo check` |
| 8 | IPC 契约未破坏 | `node scripts/check-desktop-ipc-contract.mjs` |
| 9 | 无新增运行时依赖 | `git diff package.json` 检查 dependencies |

---

## 九、Commit 序列（修正 C-06，9 个可独立回滚的提交）

| # | 内容 | 门禁 |
| --- | --- | --- |
| 0 | Task 0：`RunState` 可用性评估（只读调研，可能无代码） | — |
| 1 | 类型迁移 Step 1：core 定义类型 + CLI re-export | 门禁 1/6 |
| 2 | 类型迁移 Step 2：`runTeamCommand` 实现 + core 单测 | 门禁 1/5 |
| 3 | 类型迁移 Step 3：CLI 薄壳化 + golden file 断言 | 门禁 1/6 |
| 4 | `session.ts` 新增 team 命令分支（+ 临时会话 ephemeral） | 门禁 1/5 |
| 5 | Web 侧删除自建描述符、改由 core 提供 | 门禁 2/3/4 |
| 6 | `INTERCEPT_TEAM_STDOUT = false` + TUI 手工验证记录 | 手工 |
| 7 | 删除 App.tsx write 拦截（依赖 #6 验证通过） | 门禁 6 |
| 8 | `agents/role-bridge.ts` + 灰度开关 + 优先级 + B1~B8 | 门禁 1/5 |
| — | （L0-3 / L1-1 / L1-2 / L1-3 各自 1-2 个提交） | 全部 9 项 |

---

## 十、工作量（v2 修正）

| 阶段 | v1 估算 | v2 估算 | 差异原因 |
| --- | --- | --- | --- |
| L0-1 | 1.5 天 | **2.5 天** | 类型三步迁移 + 3 处调用点 + Ink 渲染回归 |
| L0-2 | 1.5 天 | **1.5 天** | 一致（keywords 简化反而省时） |
| **L0-3** | — | **2 天** | 新增：autonomous/full-lifecycle Web 打通 |
| L1-1 | 2 天 | **3.5 天** | 触碰 `session.ts` + 临时会话 + 审批强制 + 回归面 |
| L1-2 | 1 天 | **1 天** | 一致 |
| L1-3 | 2 天 | **2.5 天**（+0.5 Task 0） | 崩溃修复 + 并发隔离 |
| **小计** | 8 天 | **13 天** | |
| 桌面重打包验证 | 未计 | +0.5 天 | Tauri |
| 四平台 `cargo check` | 未计 | +0.5 天 | 交叉编译 |
| 评审往返 | 未计 | +1 天 | |
| **合计** | **8 天** | **15 天（含缓冲）** | |

> 若用户选择 D-01 的「本期交付自动多角色拆解」，另加约 **12 天**，总计约 27 天。

---

## 十一、风险（v2 更新）

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | 改 CLI 输出格式破坏既有快照 | 中 | golden file + 格式/内容两级断言 |
| R2 | 候选 5→40 匹配质量下降 | **高** | 优先级约束 + 灰度开关（默认关）+ L1-3 日志度量匹配分布 |
| R3 | 触碰 `session.ts` 引入回归 | **高** | 只增窄接口 + `EphemeralRunOptions` 字面量类型 + 全量测试门禁 |
| R4 | 专家 prompt 膨胀 / 破坏 prompt caching | 中 | 单次最多 1 位 + 阈值 0.6 + 评估放 prompt 末尾 |
| R5 | 自建智能体不可信文本注入 | **高** | 硬门禁（仅 preset）+ 显式开关 + description 不进指令区 + SEC-1~3 |
| R6 | 删除 write 拦截破坏 Ink 渲染 | 中 | 两步提交 + 手工验证 3 条命令 |
| R7 | 并行开发冲突 | 低 | 按 commit 序列串行合入 |
| R8 | dispatch 途中引擎重启 | 中 | 明确定义 `aborted` 终态 + 可见提示（E5） |
| R9 | 事件日志与 `RunState` 重复造轮子 | 中 | Task 0 先行评估，能复用则复用 |

---

## 十二、待用户决策

| # | 决策点 | 选项 | 影响 |
| --- | --- | --- | --- |
| **P1** | 「群组」本期范围 | A) 多阶段闭环（L0-3）作最小载体，15 天（**推荐**）<br>B) 本期即交付自动多角色拆解，27 天 | 工作量翻倍 vs 诉求完整度 |
| **P2** | 是否允许用户自建智能体进 dispatch | A) 默认禁 + 显式开关（**推荐**）<br>B) 直接放开 | 安全 vs 灵活性 |
| **P3** | 灰度开关默认值 | A) `runtimeRoles.enabled=false`（**推荐**，先关后开）<br>B) 直接 `true` | 上线即可见 vs 稳 |
| **P4** | L0-3 是否前置 | A) 与 L0-1/L0-2 同批（**推荐**，否则「群组」仍不可见）<br>B) 移到 L1 | 交付节奏 |

---

## 附录：本方案引用的代码事实

| 结论 | 证据位置 |
| --- | --- |
| 依赖方向 `agents → team` | `core/src/agents/preset-agents.ts:27-37` |
| `TeamCommandArgs` 定义与两处依赖 | `cli/src/team/team-cmd.ts:72`、`ui/core/parse-team-args.ts:19`、`ui/views/App.tsx:126` |
| write 拦截三种重载 | `cli/src/ui/views/App.tsx:2242-2270` |
| core 命令分发仅 EAG | `core/src/session.ts:4262-4321` |
| Web 无 slash 执行体 | `web/src/session-pool.ts:1376-1377` |
| Web team 仅有描述符 | `web/src/session-pool.ts:413-446` |
| 5 角色硬编码、无注册 API | `core/src/team/role-registry.ts:82/163/244/325/413` |
| ToolExecutor 仅存于注释 | `core/src/team/team-adapter.ts:11` |
| 两条匹配路径 + AI 路径 | `core/src/index.ts:689-696` |
| 领域匹配权重常量已导出 | `core/src/team/index.ts:256-262` |
| RunState 已导出 | `core/src/index.ts:783` |
| 默认智能体链路 | `core/src/settings.ts`（`defaultAgent`）+ `session.ts`（`appendAgentIndexMessage`） |
| 引擎重启由指纹驱动 | `desktop/src-tauri/src/config_persist.rs::engine_fingerprint`、`ipc.rs::ConfigSaveResult` |
