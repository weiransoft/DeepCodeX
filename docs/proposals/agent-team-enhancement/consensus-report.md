# Phase 3：四角色共识收敛报告

- 日期：2026-11-01
- 输入：`reviews/architect-review.md`、`reviews/pm-review.md`、`reviews/test-review.md`、`reviews/coder-review.md`
- 收敛规则（按 multi-agent-team v2.10）：🔴 阻断性问题 ≥2 角色提出 → 共识问题（必须修改）；🟡 建议性 ≥3 角色提出 → 建议采纳；相反意见 → 标记分歧

---

## 一、评审结果汇总

| 角色 | 评分 | 结论 | 🔴 阻断 | 🟡 建议 | 🟢 亮点 |
| --- | --- | --- | --- | --- | --- |
| 架构师 | 5.5/10 | 不通过 | 3 | 5 | 4 |
| 产品经理 | 5.0/10 | 不通过 | 2 | 5 | 4 |
| 测试专家 | 4.5/10 | 不通过 | 4 | 6 | 4 |
| 独立开发者 | 6.0/10 | 有条件通过 | 3 | 6 | 5 |
| **合计** | **5.25/10** | **3 票不通过 / 1 票有条件通过** | **12** | **22** | **17** |

**四角色一致认可的亮点**（保留不动）：

1. 拒绝插件树重写 / 全量事件溯源的判断正确（架构师 ★、PM ★、Coder ★）
2. L0-1「产生结果」与「打印结果」分离，方向一针见血（架构师 ★、Coder ★）
3. L1-1 复用 `SessionManager` 而非自建工具循环（架构师 ★、Coder ★）
4. L1-3 只事件化 dispatch、不动主对话，范围控制得当（架构师 ★、PM ★）

---

## 二、共识问题清单（≥2 角色提出，必须修改）

### C-01【架构+开发】模块落位与依赖方向错误，且有类型搬迁连锁

- 提出：架构师 B-01/B-02、独立开发者 B-01（2 票）
- 事实：`agents/preset-agents.ts:27-37` 已 `import` 自 `team/`，若 `team/` 再 import `agents/` 即成环；`TeamCommandArgs` 在 `cli/team/team-cmd.ts:72` 被 2 处依赖，搬去 core 需明确兼容层。

**裁决**：全部接受，按以下修正。

| 项 | v1 | v2 |
| --- | --- | --- |
| `buildRolesFromAgents` 落位 | `core/team/role-registry-runtime.ts` | **`core/agents/role-bridge.ts`**（依赖方向单向 `agents → team`） |
| `runTeamCommand` 落位 | `core/team/team-command.ts` | **`core/commands/team-command.ts`**（新建 commands 层，避免 team/ 继续膨胀） |
| 候选集传递 | team 层自己获取 | **宿主注入**：`runTeamCommand(args, deps?: { candidates?: RoleDefinition[] })` |
| 类型定义 | 未说明 | **core 唯一定义 + CLI 纯 re-export**，三步迁移（类型 → 实现 → 删旧） |

### C-02【架构+开发+测试+产品】角色候选集扩展的质量与安全约束不足

- 提出：架构师 R2/S-05、独立开发者 B-03、测试专家 B-04、产品经理 S-03（4 票，最高共识度）
- 三重问题：
  1. `keywords` 靠中文分词 → 项目无分词依赖，伪分词质量极差，反而拉低匹配
  2. 用户自建智能体的 `description` 是**不可信文本**，注入 dispatch system prompt 有提示注入风险
  3. 候选从 5 变 40 后匹配质量无保障、无开关、无观测

**裁决**：全部接受。

| 项 | v2 修正 |
| --- | --- |
| keywords 来源 | **只用 `group`（8 个固定类别）枚举映射**，不解析 description。零新依赖、可预测、可测试 |
| 不可信输入 | **硬门禁**：仅 `preset: true` 的智能体进入默认候选；自建智能体需 `team.runtimeRoles.allowUserAgents=true` 显式开启，且开启时其 `description` **不进入 system prompt 指令区**，只作为匹配用元数据 |
| 灰度开关 | 新增 `settings.json` → `team.runtimeRoles.enabled`，**默认 false** |
| 可观测 | `/team list` 按 8 类别分组 + 标注预置/自建；matching 分数写入 L1-3 事件日志 |

### C-03【测试+产品】验收标准不可测、缺用户可感知场景与前端覆盖

- 提出：测试专家 B-01/B-02/S-01、产品经理 B-02（2 票）
- 具体不可测项：A3「逐字节一致」（含动态内容，自相矛盾）、B1「逐字段一致」（AI 路径不确定）

**裁决**：全部接受，重写验收体系（见 `proposal-final.md` §7）。

- A3 拆为「格式断言（严格）+ 内容断言（结构化）+ golden file diff」
- B1 拆为「`matchRolesSync` 逐字段 snapshot」+「AI 路径仅结构断言 + stub 掉 LLM」
- 新增「用户可见验收」一栏，用「用户操作 → 屏幕变化」句式
- 新增 Playwright 冒烟覆盖 Web 前端

### C-04【架构+开发】事件日志与既有 `RunState` 机制重叠、目录约定冲突

- 提出：架构师 S-01/S-02、独立开发者 S-03（2 票）
- 冲突点：`team/autonomous/` 已有 `RunState` + SHA256 + resume（`core/index.ts:783` 导出）；`~/.deepcode/team-runs/` 与既有 `.gnhf/runs`（CLI `--auto-run-dir` 默认）不一致

**裁决**：接受，改为「先评估再决定」。

- 落盘位置改为**项目级 `.deepcode/team-runs/`**（便于随仓库归档与 CI 采集）
- 增加前置任务：**先读 `RunState` 实现，能扩展则扩展，不能则在方案中写明理由再新建**（列为 Task 0）

### C-05【产品+测试】引擎重启与 dispatch 的行为冲突未定义

- 提出：产品经理 S-05、测试专家 S-05（2 票）
- 事实：本次已实现「模型保存 → 指纹变化 → 自动重启引擎」（`config_persist.rs::engine_fingerprint` + `ipc.rs::ConfigSaveResult.engine_restarted`）。dispatch 运行中重启的行为完全未定义。

**裁决**：接受。

- 明确语义：dispatch 运行中引擎重启 → dispatch 终态为 `aborted`，写入 `dispatch/end { reason: "aborted", cause: "engine-restart" }`，并向用户推送可见提示（不静默消失）
- 新增验收用例覆盖

### C-06【测试+开发】缺落地顺序与工作量修正

- 提出：测试专家 S-04/S-03、独立开发者 S-04/S-05（2 票）
- 测试专家要求「先写测试再改实现」必须有流程强制；独立开发者指出 8 人日实际约 11 人日

**裁决**：接受。

- 工作量修正为 **11 人日**（+ 0.5 天桌面重打包验证 + 0.5 天 `cargo check` + 1 天评审往返 = **13 天含缓冲**）
- 给出 9 个可独立提交的 commit 序列（见 `proposal-final.md` §9）
- 定义质量门禁（见 §8）

### C-07【架构+测试】安全对抗用例缺失

- 提出：架构师 S-05、测试专家 B-04（2 票）
- 已并入 C-02 的硬门禁，另需独立对抗用例集 SEC-1~3

**裁决**：接受，作为 C-02 的验证手段单独列出。

---

## 三、单角色阻断问题（<2 票，但本人判定成立，一并采纳）

### A-01【架构师 B-03】dispatch 会产生「幽灵会话」

`executeDispatch` 改走 `SessionManager` 后：会话是否计入用户列表？是否触发 `appendAgentIndexMessage`（本次刚加的默认智能体自动激活逻辑在它末尾）？产物归属哪个会话？

**采纳**：dispatch 使用**临时会话**（`ephemeral: true`），不进会话索引、不触发 agent 索引消息、结束后归档。在 `SessionManagerOptions` 增加标记而非绕过。

### A-02【独立开发者 B-02】删除 App.tsx write 拦截风险被低估

该段代码处理 Node `write` 三种重载并在 `finally` 恢复（`App.tsx:2242-2270`），说明团队曾因此踩坑。

**采纳**：分两步——先加常量开关 `INTERCEPT_TEAM_STDOUT = false` 并做 TUI 手工验证（3 条命令各一次），确认无破损后再删。**不在同一 commit 里既改执行体又删拦截。**

### A-03【独立开发者 S-01】L1-2 阈值缺具体数值

**采纳**：初值 `team.expertInjection.minScore = 0.6`，复用已导出的 `DOMAIN_MATCH_WEIGHTS`（`team/index.ts:256-262`），一次 dispatch 最多注入 1 位专家。

### A-04【产品经理 S-01/S-02】Web 输入框缺 team 入口；默认智能体与 team 未打通

**采纳**：Composer「+」菜单增「角色」页签（点击插入带占位符的完整命令模板）；`dispatch --role` 未指定时优先级为「默认智能体（若已注册为角色）> matchRoles > 报错」。

### A-05【测试专家 S-02】默认智能体指向已删除 agent 的降级未测

**采纳**：新增用例，断言「不抛错、降级为无默认、日志告警」。

---

## 四、分歧点（角色间意见相反，需裁决）

### D-01【关键】本期是否交付「多智能体协同」？

| 立场 | 角色 | 论据 |
| --- | --- | --- |
| **必须交付** | 产品经理 B-01 | 用户原话是「智能体**群组**」；v1 全部在解决「单角色派单」，群组协作缺位。core 里 `WorkflowLoopController`（八阶段）、`RalphLoopController`（自主迭代）、fan-out 拓扑都已存在但未接线 |
| **未表态/倾向先不做** | 架构师、独立开发者、测试专家 | 架构师把「复用而非新建」列为亮点但未要求扩展到多角色；独立开发者估算单是 L0+L1 已 11 人日；测试专家指出验收体系本身尚不可测 |

**裁决（折中，需用户确认）**：

本期**不做**「一次任务自动拆解并分派给多角色并行协作」的完整闭环，但**必须**：

1. 在方案中**显式写入非目标**，不让人误以为 `/team` 就是群组；
2. 把 **`/team autonomous`（Ralph 4 阶段自主迭代）与 `/team full-lifecycle`（八阶段）在 Web 打通**，作为「群组」的**最小可见载体**——用户能看到「plan→dev→verify→fix」的迭代与阶段推进，这已经是多阶段协同，而非单轮派单；
3. 下一期（L2）再评估自动多角色拆解。

**理由**：用户诉求中的「群组」在工程上最稳的最小实现是「多阶段闭环」而非「多智能体并行」。前者已有 `RalphLoopController`/`WorkflowLoopController` 现成实现且 CLI 已通，Web 接线成本低；后者需要任务 DAG 拆解 + 结果聚合 + 冲突消解，是独立的大工程。

> ⚠️ 此项需用户拍板。若用户要求本期即交付自动多角色拆解，总工作量将从 13 天升至约 25 天。

### D-02 是否允许用户自建智能体进入 dispatch 候选？

| 立场 | 角色 |
| --- | --- |
| 应允许（用户价值） | 产品经理（隐含，S-02 期望默认智能体生效） |
| 应硬禁止（安全） | 架构师 S-05、测试专家 B-04 |

**裁决**：默认禁止 + 显式开关。既满足安全（默认不可信输入不进入指令区），又保留用户价值（愿意承担风险可开）。开启后 description 仅作匹配元数据、不拼进 system prompt。

### D-03 keywords 是否解析 description？

- 独立开发者：强烈反对（无分词依赖，伪分词质量差）
- 其他：未表态

**裁决**：反对成立，只用 `group` 枚举映射。

---

## 五、v1 → v2 变更摘要

| 类别 | 变更 |
| --- | --- |
| 新增 | `.deepcode/team-runs/` 事件日志的统一评估任务（Task 0）；SEC-1~3 对抗用例；Playwright 冒烟；G↔验收矩阵；commit 序列；质量门禁 |
| 修改 | 模块落位（3 处）；候选集注入方式；keywords 生成策略；验收标准（A3/B1 拆分）；工作量 8→11 人日；事件日志目录 |
| 删除 | `team/role-registry-runtime.ts`、`team/team-command.ts` 两个落位；description 分词方案 |
| 保留 | L0/L1/L2 分层、拒绝插件树重写、L1-1 走路径 B、L1-3 局部事件化 |

---

## 六、结论

- 共识问题：**7 项**（C-01~C-07），全部接受并已在 v2 修正
- 单角色阻断：**5 项**（A-01~A-05），全部采纳
- 分歧点：**3 项**（D-01~D-03），已裁决，其中 **D-01 需用户拍板**
- 建议性问题：22 项中 15 项已并入 v2，7 项（可观测指标细化、prompt caching 影响评估、错误提示产品化、`/team list` 折叠交互等）列为 L1 阶段的后续项，不阻塞本期

**v1 已不通过，v2 见 `proposal-final.md`。**
