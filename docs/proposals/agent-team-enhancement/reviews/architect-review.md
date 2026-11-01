# 架构师视角评审 — 智能体群组能力增强方案 v1

- 评审人：架构师
- 评审对象：`proposal-v1.md`
- 评审依据：`docs/team-wiring-audit-20261101.md` + 实际代码扫描

---

## 总体评分：**5.5 / 10**

## 评审结论：**不通过**（存在 3 项阻断性问题）

分层策略（L0/L1/L2）方向正确，拒绝插件树重写与全量事件溯源的判断是本方案最大的价值。但**依赖方向没说清、执行体归属没说清、目录约定与既有体系冲突**，这三条不解决就不能开工。

---

## 各维度评分

| 维度 | 分 | 说明 |
| --- | --- | --- |
| 架构可行性 | 5/10 | L0-1 存在未识别的循环依赖风险 |
| 技术选型 | 7/10 | 复用 SessionManager 而非自建工具循环，选对了 |
| 可扩展性 | 6/10 | 运行时注册表方向对，但缺少生命周期治理 |
| 安全性 | 6/10 | 未讨论 dispatch 走 SessionManager 后的沙箱/审批边界变化 |
| 可回滚性 | 4/10 | 完全没有灰度和回滚设计 |
| 代码集成路径 | 5/10 | 文件级定位清晰，但**模块依赖方向错误** |

---

## 🔴 阻断性问题

### B-01：`core/team` 不能反向依赖 `core/agents`，L0-2 的设计会引入循环依赖

方案说把 `buildRolesFromAgents(skills: SkillInfo[])` 放在 `packages/core/src/team/role-registry-runtime.ts`。

**但既有的依赖方向是 `agents → team`**，不是反过来：

- `packages/core/src/agents/preset-agents.ts:27-37` 明确 `import { ROLE_REGISTRY } from "../team/role-registry"`、`import { ALL_DOMAIN_CATEGORIES } from "../team/domain-experts/index"`。

如果 `team/role-registry-runtime.ts` 再 `import type { SkillInfo } from "../agents/..."`，就形成 `team ⇄ agents` 循环。

**修法**：`SkillInfo` 类型其实定义在 `session.ts`（方案审计已确认 `SkillInfo` 在 `session.ts` 中）。把 `buildRolesFromAgents` 放到 **`agents/` 目录**（如 `agents/role-bridge.ts`），由上层（`session.ts` / CLI）组装后**以参数注入**给 `runTeamCommand`：

```ts
export async function runTeamCommand(
  args: TeamCommandArgs,
  deps?: { candidates?: RoleDefinition[] }   // 宿主注入，team 层不认识 agents
): Promise<TeamCommandResult>
```

这样 `team` 层保持零上游依赖，符合原有分层。

### B-02：`runTeamCommand` 的落位不明，会加剧 `core/team` 膨胀

方案把 `runTeamCommand` 放在 `packages/core/src/team/team-command.ts`。但 `team/` 目录已有 23 个模块 + 8 个子目录（`autonomous`/`cybernetics`/`plugins`/`principles`/`workflows`/`domain-experts`/`tests`），再塞命令执行器会让这个本就臃肿的目录更难治理。

**修法**：放到 `packages/core/src/commands/team-command.ts`（若 `commands/` 不存在则新建），与未来的其他跨宿主命令（`rules` 等）归并。`team/` 只保留领域逻辑。

### B-03：L1-1 路径 B 会产生「幽灵会话」，方案未处理会话归属

`executeDispatch` 改为调用 `SessionManager` 的窄接口，意味着一次 dispatch 会创建一个会话。但方案通篇没说：

1. 这个会话计入用户的会话列表吗？
2. 它会不会触发 `appendAgentIndexMessage`（本次刚加的默认智能体自动激活逻辑就在这个函数末尾）？
3. dispatch 的产物（stdout）写到哪个会话？
4. 用户在 Web 会话 A 里执行 `/team dispatch`，dispatch 的内部会话与 A 是什么关系？

**修法**：明确「dispatch 使用**临时会话**（`ephemeral: true`），不进入会话索引、不触发 agent 索引消息、结束后按 `dispatch/end` 事件归档」。同时在 `SessionManagerOptions` 增加 `ephemeral` 标记而不是绕过。

---

## 🟡 建议性改进

### S-01：`team-runs` 目录与既有约定冲突

方案写 `~/.deepcode/team-runs/<runId>/events.jsonl`。但既有体系是：

- CLI autonomous：`--auto-run-dir` 默认 `.gnhf/runs`（项目级）
- 会话数据：`~/.deepcode/`

两套并存会让人疑惑「我的运行记录到底在哪」。建议统一到项目级 `.deepcode/team-runs/`（与会话数据分离，且便于随仓库归档/CI 采集）。

### S-02：L1-3 的事件日志与 `RunState` 的 SHA256 校验机制可能重复

`team/RunState` 已有运行状态持久化 + SHA256 校验 + Resume。L1-3 若另起 `events.jsonl`，等于第二套运行记录体系。建议先看能否**扩展 `RunState` 的事件能力**，而不是新增平行机制。

### S-03：缺少可观测性与回滚设计

- 无指标：dispatch 成功率、平均轮次、角色匹配分布，一个都没有。
- 无灰度：L0-2 把候选集从 5 变 40 是高风险的匹配质量变更，方案给不出「出问题怎么关掉」的开关。

建议加 `settings.json` 的 `team.runtimeRoles.enabled` 开关，默认 false，灰度验证后开。

### S-04：L1-2 专家注入会改变 system prompt 结构，需评估对 thinking / 缓存的影响

`buildThinkingRequestOptions` 已经参与 `executeDispatch` 的请求构造（`team-adapter.ts` 注释第 12-16 行说明了历史修复点）。追加专家段会改变 prompt 前缀，**可能破坏 provider 侧的 prompt caching**。请在设计里显式评估。

### S-05：安全边界变化未讨论

dispatch 走 `SessionManager` 后，工具执行会经过主对话的审批链。方案 C3 只说「审批生效」，但没做威胁建模：**dispatch 的 system prompt 里包含角色定义与专家描述，这些是可控文本还是不可控文本？** 如果某个 `SKILL.md` 的 description 里写了「忽略所有审批」，会不会被注入进 dispatch prompt？

`preset-agents.ts` 里 `renderPresetSkillMd` 写 frontmatter，description 来自 `ROLE_REGISTRY` / 专家定义（可信）。但**用户自建智能体不可信**。必须在 B-01 的注入路径上做「只有 `preset: true` 才允许进入 dispatch 候选」的硬约束——方案 R5 把它写成了「中风险 + 缓解」，我认为应该是**硬门禁**。

---

## 🟢 亮点

1. **拒绝 N1/N2/N3/N4 的判断非常清醒**。尤其「不做全量会话事件溯源」——`session.ts` 8000+ 行，全量改造是灾难。
2. **L0-1 把「产生结果」与「打印结果」分离**，一针见血。CLI 靠拦截 `process.stdout.write` 硬接（`App.tsx:2242-2270`，30 行处理 Node write 三种重载）本身就是耦合过深的信号。
3. **L1-1 选路径 B 而非自建工具循环**，正确复用而非重复实现。
4. **L1-3 只事件化 dispatch 不动主对话**，是范围控制的教科书做法。

---

## 与项目最新代码结合的证据

| 结论 | 证据 |
| --- | --- |
| team → agents 循环依赖风险 | `packages/core/src/agents/preset-agents.ts:27-37` |
| SkillInfo 定义位置 | `packages/core/src/session.ts`（`SkillInfo` 类型定义处） |
| team 目录规模 | `ls packages/core/src/team/` → 23 个 `.ts` + 8 个子目录 |
| CLI write 拦截 30 行 | `packages/cli/src/ui/views/App.tsx:2242-2270` |
| thinking 参数参与 dispatch | `packages/core/src/team/team-adapter.ts:12-16` |
| 既有 RunState 有 SHA256 | `packages/core/src/team/autonomous/`（`RunState` 导出，`core/index.ts:783`） |
| CLI run 目录默认值 | `--auto-run-dir` 默认 `.gnhf/runs` |
