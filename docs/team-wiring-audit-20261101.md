# 智能体群组（Team）集线与接线核查报告

- 核查日期：2026-11-01
- 核查范围：`packages/core/src/team/**`、`packages/cli/src/**`、`packages/web/src/**`、`packages/web/web/src/**`、`desktop/**`
- 核查方法：全仓符号检索（精确类名 + 模块路径）、导入图遍历、调用链下钻到真实执行体
- 结论摘要：**CLI 已接满，Web（当前主用宿主）零接线，领域专家子系统整体为死代码，两套智能体体系互不连通。**

---

## 一、结论总表

| 能力 | 数据/实现 | CLI 接线 | Web 接线 | 判定 |
| --- | --- | --- | --- | --- |
| `/team list` 列角色 | ✅ `role-registry.ts`（5 角色硬编码） | ✅ | ❌ 仅描述符 | CLI 通 / Web 断 |
| `/team match` 关键词匹配 | ✅ `role-matcher.ts` | ✅ | ❌ 仅描述符 | CLI 通 / Web 断 |
| `/team dispatch` 角色分派 | ⚠️ 单次 LLM 调用，**无工具循环** | ✅ | ❌ 仅描述符 | 接线通 / 执行体弱 |
| `/team autonomous` Ralph 迭代 | ✅ `RalphLoopController` | ✅ | ❌ 仅描述符 | CLI 通 / Web 断 |
| `/team full-lifecycle` 八阶段 | ✅ `WorkflowLoopController` | ✅ | ❌ 仅描述符 | CLI 通 / Web 断 |
| 30 位领域专家匹配 | ✅ 数据 + 841 行匹配器 + 489 行注册表 | ❌ | ❌ | **死代码** |
| 领域专家评审插件 | ✅ `domain-expert-review-plugin.ts` | ❌ | ❌ | **死代码** |
| `SKILL.md` 智能体（35 个预置） | ✅ `SkillManager` 扫描链 | ✅ `agent` 工具 / `@` 提及 | ✅ `/api/capabilities` | 通（与本报告同日落地） |

**一句话结论**：群组能力在 CLI 是真实可用的，在 Web 是「有菜单、无厨房」；领域专家是「有食材、无灶台」；而用户在 Web 里看到的那 35 个智能体，和 `/team` 的 5 个角色是**两套互不相连的系统**。

---

## 二、CLI 侧：已完整接线（可判定为「完成」）

### 2.1 调用链完整贯通

```
用户输入 /team dispatch --task "..."
  → App.tsx:880  submission.command === "team"
  → App.tsx:885  handleTeamSlashCommand(submission.text)
  → App.tsx:2274 executeTeamCommand(args)              ← 真实调用，非桩
  → cli/team/team-cmd.ts:138
  → core: matchRoles / executeDispatch / RalphLoopController / WorkflowLoopController
```

关键证据：

- `packages/cli/src/ui/views/App.tsx:880-889`：`command === "team"` 分支真实调用 `handleTeamSlashCommand`，结果经 `buildSyntheticAssistantMessage` 回填到 TUI。
- `packages/cli/src/ui/views/App.tsx:2274`：`exitCode = await executeTeamCommand(args);`——真实 await，非注释、非 stub。
- `packages/cli/src/ui/views/App.tsx:2242-2270`：因为 `executeTeamCommand` 直接写 `process.stdout`，会破坏 Ink 渲染，这里做了 `process.stdout.write` 拦截重定向到内存缓冲。这种「为了接进去而打补丁」的写法，反证了它确实被接进去了。
- `packages/cli/src/team/team-cmd.ts:26-65`：从 `@vegamo/deepcode-core` 一次导入 30+ 符号，涵盖 `ROLE_REGISTRY`、`matchRoles`、`executeDispatch`、`buildTask`、`RunState`、`RalphLoopController`、`WorkflowLoopController`、`DefaultStageExecutor`、`DocCodeConsistencyChecker`。
- 5 个子命令描述符与执行体对齐：`TeamSubcommand = "list" | "match" | "dispatch" | "autonomous" | "full-lifecycle"`（`team-cmd.ts:69`）。
- 角色快捷命令 `/architect`、`/pm`、`/coder`、`/tester`、`/ui` 被统一重写为 `dispatch --role <id>`（`App.tsx:2210-2230`）。

### 2.2 但执行体本身弱于宣传

`team-adapter.ts:11` 的文件头注释写着：

```
*   3. Tools：dispatcher 调度后调用 ToolExecutor 执行实际工具
```

实际核查结果：**`ToolExecutor` 这个符号在整个 `packages/core/src/team/` 目录里只出现在这一行注释中**（`grep -rn "ToolExecutor" packages/core/src/team` → 唯一命中 `team-adapter.ts:11`）。

`executeDispatch` 的真实行为是「拼角色 system prompt → 发一次 chat completion → 取文本」，没有工具循环、没有文件读写、没有命令执行。也就是说：

- `/team dispatch --task "实现登录模块"` 得到的是**一段设计建议文本**，不是真的改了代码。
- 8 阶段 `full-lifecycle` 的 `DefaultStageExecutor` 是**确定性文件检查**（`workflow-loop-controller.ts:1050-1079` 按阶段分发到 `executeDocStage` / `executeDevelopment` / `executeTestVerification` / `executeReview`），不是 LLM 驱动。

对比 `SKILL.md` 智能体走的是 `SessionManager` 主循环——有完整工具轮次、有审批、有护栏。所以**「团队角色」的能力上限显著低于「智能体」**，这是接线之外的第二层问题。

---

## 三、Web 侧：只接了「描述符」，没有「执行体」（核心缺陷）

### 3.1 描述符存在

`packages/web/src/session-pool.ts:413-446` 注册了 5 个 team 子命令描述符：

```ts
Object.freeze({ category: "team" as const, id: "team-list",   name: "/team list",   ... }),
Object.freeze({ category: "team" as const, id: "team-match",  name: "/team match",  ... }),
Object.freeze({ category: "team" as const, id: "team-dispatch", name: "/team dispatch", ... }),
Object.freeze({ category: "team" as const, id: "team-autonomous", name: "/team autonomous", ... }),
Object.freeze({ category: "team" as const, id: "team-full-lifecycle", name: "/team full-lifecycle", ... }),
```

注入点：`session-pool.ts:720` 把这些描述符塞进建议层的 `availableCommands`，用于前端命令面板展示。

### 3.2 执行体不存在（决定性证据）

`packages/web/src/session-pool.ts:1376-1377` 的注释直接承认了这一点：

```
// EAG 白名单校验（core 单一数据源；非 EAG 斜杠命令的 slash 体系校验属 CLI，
// Web 宿主无 TUI slash 执行体，不适用 AUTO_EXECUTABLE_COMMAND_KINDS 通道）
```

core 侧的斜杠命令分发器（`packages/core/src/session.ts:4262-4321`）`switch (eagCommand.kind)` 只处理 EAG 系列：

`eag-build` / `eag-design` / `eag-test` / `eag-run` / `eag-resume` / `eag-status` / `eag-deploy` / `eag-autonomous` / `eag-autonomous-status` / `eag-autonomous-stop` / `eag-graph`

**没有 `team` 分支。** 因此 Web 用户在输入框敲 `/team dispatch --task xxx` 的真实后果是：一段普通文本被原样投喂给 LLM，模型大概率会「配合演出」输出一段看起来像团队分派结果的文字，但**没有任何一行代码被真正调度**。

这是最危险的一类缺陷：不是报错，而是**静默降级 + 看起来成功**。

### 3.3 交叉验证

| 检索式 | 结果 |
| --- | --- |
| `grep -rn "TeamAdapter\|RoleMatcher\|DomainExpertMatcher\|WorkflowLoopController\|executeTeamCommand\|role-registry"` over `packages/web/src` + `packages/web/web/src` | **0 命中** |
| `grep -rli "team" packages/web/src --include=*.ts` | **仅 `session-pool.ts` 一个文件** |
| `grep -rn "slash\|Slash" packages/web/src` | 3 处，全部在说明「Web 无 slash 执行体」 |

---

## 四、领域专家（30 位 / 8 类别）：完整实现，整体死代码

### 4.1 实现是完整的

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `team/domain-experts/*.ts`（8 个文件 + index） | — | 30 位专家定义，8 类别 |
| `team/domain-expert-matcher.ts` | 841 | 关键词 + AI 双路匹配，含权重常量 |
| `team/domain-expert-registry.ts` | 489 | 注册中心 + `RoleRegistryAdapter` |
| `team/domain-expert-review-plugin.ts` | — | 专家评审插件 |

### 4.2 但生产代码零引用

```
grep -rn "DomainExpertMatcher\|DomainExpertRegistry\|registerAllExperts" \
     --include=*.ts --include=*.tsx packages/ | grep -v "/tests/" | grep -v node_modules
→ 0 命中
```

更关键的是**公共 API 根本没导出它们**：

- `packages/core/src/team/index.ts:254-264` 有导出 `DomainExpertRegistry` / `DomainExpertMatcher` / `registerAllExperts`。
- 但 `packages/core/src/index.ts`（对外唯一入口）**只选择性 re-export 了角色层**（`ROLE_REGISTRY`、`matchRoles`、`executeDispatch` 等，见 `index.ts:683-703`），**领域专家层一个都没 re-export**。
- 验证：`grep -nE "DomainExpert|registerAllExperts" packages/core/src/index.ts` → **0 命中**。

结论：**CLI 和 Web 在类型层面就无法访问领域专家子系统**。它不是「没接」，而是「连门都没开」。唯一的生产级消费方是我本次新增的 `packages/core/src/agents/preset-agents.ts`，而它只取专家数据（`academicExperts` 等数组）转成 `SKILL.md`，并未使用匹配器/注册表/评审插件。

### 4.3 后果

- 30 位专家的**匹配逻辑**（841 行）从未跑过真实流量，只在 `packages/core/src/tests/eag-p5-e2e-arch-edm-expert-icp-pkc.test.ts` 里有覆盖。这意味着它可能已经和 `RoleDefinition` 类型漂移而无人察觉。
- 专家评审插件（`DomainExpertReviewPlugin`）从未在 `/team` 或 EAG 流程中启用。
- 用户视角：**专家「存在但不工作」**。本次已通过预置种子把它们变成可 `@` 唤起的智能体文件，这是把「数据」救活了；但「匹配/评审」能力仍然是死的。

---

## 五、两套智能体体系互不连通（架构级问题）

当前存在两个平行的智能体体系：

| 维度 | 体系 A：Team 角色 | 体系 B：SKILL.md 智能体 |
| --- | --- | --- |
| 来源 | `team/role-registry.ts` **硬编码 5 个 const** | 文件系统 `SKILL.md`（`type: agent`） |
| 发现方式 | 编译期常量 | `SkillManager` 扫描 5 根目录 |
| 数量 | 5（不可扩展） | 35 预置 + 用户自建（无限） |
| 执行体 | 单次 LLM 调用，**无工具** | `SessionManager` 主循环，**有完整工具轮次** |
| 入口 | CLI `/team`、`/architect` 等 | Web/CLI 的 `@` 提及、`agent` 工具 |
| 设置页可见 | ❌ 不可见 | ✅ 可见（本次已补齐预置） |

**不连通的证据**：`role-registry.ts` 只有 5 个 `const xxxRole: RoleDefinition = {...}`（第 82 / 163 / 244 / 325 / 413 行），**没有任何 `registerRole` / `addRole` / `ROLE_REGISTRY.set(...)` 之类的注册 API**。检索确认：

```
grep -rn "registerRole|addRole|ROLE_REGISTRY\.(push|set)" packages/ → 0 命中
```

所以：

- 用户新建一个 `SKILL.md` 智能体 → **不可能**成为 `/team dispatch --role` 的候选。
- `/team match` 的关键词匹配 → 永远只看那 5 个硬编码角色，看不到 35 个预置智能体。
- 反过来，`agent` 工具也从不调用 `matchRoles`。

这是一个**双轨制**：能力更强的一轨（B）接在会话主循环上，能力更弱的一轨（A）独占 `/team` 入口。对用户表现为「我有 35 个智能体，但 `/team` 只认 5 个我不知道从哪来的角色」。

---

## 六、修复建议（按优先级）

### P0：Web 侧补 team 执行体（否则前端菜单是骗人的）

三选一，推荐第 1 种：

1. **把 team 提为 core 一级命令类别**：在 `session.ts` 的 `eagCommandParser` 旁新增 `teamCommandParser`，`switch` 增加 5 个 `team-*` 分支，直接复用 `executeTeamCommand` 的纯逻辑（需先把写 `process.stdout` 的部分改为返回 `{stdout, stderr, exitCode}`）。这样 Web / CLI 共用一套执行体，彻底消除双宿主分歧。
2. 在 Web 侧 `session-pool.ts` 新增 `handleTeamCommand`，与 `handleEagAutonomousCommand` 并列。缺点：core 里那套 `executeDispatch` 仍只能 CLI 调用，重复实现风险高。
3. 最小改动：**立刻从 `availableCommands` 里摘掉这 5 个 team 描述符**，避免用户点了没反应。这是止血，不是修复。

### P0：让 `SKILL.md` 智能体成为 team 成员

- 在 `role-registry.ts` 增加 `registerRole(def: RoleDefinition)` / `buildRolesFromAgents(skills: SkillInfo[]): RoleDefinition[]`，把 `SKILL.md` 的 `frontmatter.role/group/description` 映射为 `RoleDefinition`。
- `matchRoles` 的候选集从 `ROLE_REGISTRY` 改为 `ROLE_REGISTRY ∪ 运行时注册表`。
- 这样 `/team match "增长方案"` 才能真正匹配到 `marketing` 类别的预置专家。

### P1：开放领域专家子系统

- `packages/core/src/index.ts` re-export `DomainExpertRegistry` / `DomainExpertMatcher` / `registerAllExperts`。
- 在 `executeDispatch` 里增加「角色匹配 → 若命中领域类别则追加专家 system prompt 段」。
- 为 841 行匹配器补一条真实流量路径的单测（当前只有 e2e 那条）。

### P1：`executeDispatch` 补工具循环

- 复用 `SessionManager` 的工具执行能力，或至少暴露 `maxToolRounds` 参数。
- 同时修正 `team-adapter.ts:11` 那条**与实现不符的注释**——它现在会误导后续维护者以为工具链已经接好了。

### P2：文档纠偏

- `docs/` 下若存在把 `/team` 描述为「多角色协同、自动分派并执行」的表述，需要补充「当前为单轮 LLM 建议，不落代码」的限定。

---

## 七、本次已顺手修掉的相关问题

作为同一轮工作的一部分，以下与「智能体不可见」直接相关的问题已修复：

1. **35 个预置智能体从未落盘**（`packages/core/src/agents/preset-agents.ts` 新增）：5 角色 + 30 专家此前只存在于内存，`SkillManager` 扫不到，导致设置页「一个智能体都看不到」。现改为启动时幂等写盘（`onlyMissing`，保护用户改动）。
2. **`preset` / `group` 元数据贯通**（`skill-manager.ts` → `session.ts` → `capability-api.ts` → 前端）：设置页可按「预置 / 自建」分组，并显示 8 个业务类别。
3. **默认智能体可预置**：`settings.json` 的 `agents.default` → `resolveSettingsSources` → `appendAgentIndexMessage` 自动激活，用户可指定「每次新会话默认用哪个智能体」。

---

## 附录：核查用关键检索式与结果

| 检索式 | 结果 | 含义 |
| --- | --- | --- |
| `grep -rn "executeTeamCommand" packages/cli/src`（排除 tests） | `App.tsx:2274` 一处 | CLI 真实调用 |
| `grep -rn "TeamAdapter\|WorkflowLoopController" packages/web/src packages/web/web/src` | 0 | Web 零接线 |
| `grep -rn "DomainExpertMatcher\|DomainExpertRegistry\|registerAllExperts" packages/`（排除 tests） | 0 | 专家子系统死代码 |
| `grep -nE "DomainExpert" packages/core/src/index.ts` | 0 | 公共 API 未开放 |
| `grep -rn "ToolExecutor" packages/core/src/team` | `team-adapter.ts:11`（注释） | 工具链未接 |
| `grep -rn "registerRole\|addRole" packages/` | 0 | 角色注册表不可扩展 |
| `grep -n "eag-autonomous\|switch (eagCommand.kind)" packages/core/src/session.ts` | `4265` switch，仅 EAG | core 无 team 分支 |
