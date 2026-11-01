# DeepCodeX 学习增强方案 v1 —— 借鉴 Better Harness 的证据驱动工作流审计体系

> 调研来源：research-better-harness.md（Better Harness @ QoderAI，2026-10 快照）
> 现状基线：baseline-deepcodex.md（DeepCodeX-cli 最新 main）
> 方法：multi-agent-team 方案撰写全流程（调研 → 撰写 → 四角色交叉评审 → 共识收敛 → 定稿）

## 1. 一句话结论

Better Harness 的核心贡献不是某段代码，而是一套**证据驱动的审计方法论**：「配置存在 ≠ 被观测使用」+ 七级证据状态 + Finding 四要素 + 确定性/LLM 双层分工。DeepCodeX 已有会话持久化、执行历史、EAG 门禁/评估器协议、经验沉淀引擎 v0 等优质底座，但**证据链断裂**——有数据无语义、有计数无闭环、有建议无验证。本方案用六个递进式改造把这条链接上。

## 2. 对照说明矩阵

| # | 能力维度 | Better Harness 做法 | DeepCodeX 现状 | 差距判定 |
|---|---|---|---|---|
| 1 | 证据观 | 「配置存在≠被观测使用」，七级证据状态（Present/Wired/Exercised/Outcome-supported/Missing/Unobserved/NA） | 规则/skill/记忆「已配置」即视为生效，无使用观测 | **关键差距** |
| 2 | 证据聚合 | `harness evidence-bundle` 单命令冻结拓扑/窗口/权限，三类证据一次采集 | 数据分散：session JSONL、execution-history.jsonl、v2 事件、规则计数，无聚合入口 | **关键差距** |
| 3 | Finding 模型 | 每条建议必须含：证据、影响、最小修复范围、验证方式；质量门拦截不合格候选 | sedimentation-engine v0 建议无结构化证据；T02 sedimentation-writer 正在做但缺四要素契约 | **部分差距**（时机正好） |
| 4 | 评估模型 | 五维度×15 检查项 Agent Work Loop + F0-F4 流畅度；分数天花板随证据等级 | EAG gate/verdict 有 pass/fail，无分级证据语义，无天花板机制 | 中等差距 |
| 5 | 重复工作发现 | loop-discovery：从会话证据发现复现性工作 → 升级为 Skill/Hook/Rule 覆盖阶梯 | execution-history.jsonl 数据在，无重复模式检测 | **关键差距**（数据已有，只差检测层） |
| 6 | 分层执行架构 | 确定性脚本层（采集/校验/渲染，零 LLM）+ 宿主 LLM 层（判断），LLM 禁止手写报告 | v2 observability 已有结构化日志；EAG 评估器协议已定义；但「渲染/校验确定性」约束未成文 | 小差距（方向一致，需显式化） |
| 7 | 并行证据代理 | 3 个只读证据代理互相隔离 + lead 单次 reconciliation | T01 custom agents 已具备子代理能力，但无「证据隔离 lane」模式 | 小差距（模式移植即可） |
| 8 | 纵向验证 | 干预台账（intervention ledger）：改进效果需后续可比 Task Episode 佐证 | 沉淀建议写入后无效果回访；规则 violationCount 无消费 | **关键差距** |
| 9 | 脱敏 | 会话证据默认语义 facet 化，禁止原始 prompt/密钥进产物 | memory redaction.ts 已有脱敏管线；execution-history 未过脱敏 | 小差距（复用现有 redaction） |
| 10 | 审计报告 | findings.json 机器校验 + 确定性渲染 HTML/MD | 无审计报告产物 | 中等差距（P6 覆盖） |

## 3. 增强学习方案（六项，按依赖排序）

### P1 资产使用证据链（打通「配置→触发→使用→结果」）

**目标**：把「配置存在」升级为可观测的「被使用」，落地七级证据状态的最小版（Present/Wired/Exercised/Outcome-supported 四级）。
**改动**：
- `packages/core/src/eag/rlis/rule-store.ts`：规则记录新增 `evidence` 字段 `{ injectedAt: string[], exercisedAt: string[], outcomeVerdicts: string[] }`——注入会话记 Wired，会话内被 violation/命中引用记 Exercised，关联 EAG verdict 记 Outcome-supported。现有 violationCount 保留并纳入 evidence。
- `packages/core/src/skills/`：skill 加载→消息注入记 Wired；宿主实际引用技能内容产出记 Exercised（复用 execution-history 的 turn 记录做归因）。
- `packages/core/src/memory/`：memory 命中统计（读取→被引用），复用 redaction.ts 保证统计不落敏感内容。
**验收**：新增单测覆盖状态迁移；`/rules` 与 Web 规则面板能看到每条规则的证据级别；无敏感内容泄漏（redaction 测试）。

### P2 统一证据包命令 `eag evidence-bundle`

**目标**：对齐 Better Harness 的单命令冻结边界，为 P3-P6 提供唯一数据源。
**改动**：新建 `packages/core/src/eag/evidence-bundle.ts` + CLI 子命令：
```
deepcodex eag evidence-bundle --workspace <dir> --since <t> --until <t> --depth quick|normal --format json
```
聚合四类来源：session JSONL（脱敏语义 facet）、execution-history.jsonl、v2 事件流、资产 inventory（rules/skills/memory/tools 计数与证据级别，来自 P1）。一次性冻结：workspace、时间窗、深度、文件清单（SHA256）。
**验收**：bundle JSON 有 schema 校验（复用 P4 的校验器思路）；quick=3 事件样例 / normal=30 天全量；重复执行同窗口输出字节级一致（冻结性测试）。

### P3 Finding-bound 沉淀建议（衔接 T02 sedimentation-writer）

**目标**：沉淀引擎产出的每条建议升级为 Finding 结构：`{ id, evidence[], impact, minFixScope, verifyRoute, evidenceState, severity }`。
**改动**：`packages/core/src/eag/sedimentation-writer.ts`（T02 进行中）按此契约实现；`sedimentation-engine.ts` 的候选生成阶段增加质量门（无证据→deferred，不入正式建议）。evidence 引用 P2 bundle 的事件序号，实现可回溯。
**验收**：每条落盘建议可通过 schema 校验；evidence 字段能回放到 bundle 中的原始事件；缺证据候选进 deferred 池并有工作理由。

### P4 证据状态与分数天花板进 EAG 评估

**目标**：verdict 从二值 pass/fail 升级为证据分级结论。
**改动**：`packages/core/src/eag/verdict.ts` 增加 `evidenceState`（七级对齐 BH：Present/Wired/Exercised/Outcome-supported/Missing/Unobserved/NA）与 `confidence`；`independent-evaluator.ts` 协议扩展可选的 dimension 评分，分数天花板按证据等级封顶（≤59/≤74/≤84/≤94/100）。**Unobserved 不得冒充 Missing**（观测边界不足≠确认缺失）。
**验收**：单测覆盖「Unobserved 不降级为 Missing」「分数不超过证据天花板」；旧 verdict 消费方兼容（新增字段可选）。

### P5 重复工作发现（loop-discovery 移植）

**目标**：从 execution-history.jsonl 自动检测复现性工作流，建议升级承载机制。
**改动**：新建 `packages/core/src/eag/loop-discovery.ts`：对 P2 bundle 做序列模式挖掘（命令序列/工具序列 n-gram + 相似任务聚类），达到阈值（如 7 天内 ≥3 次可比序列）产出升级建议，按 BH 覆盖阶梯输出：`observed → 已有内建机制 → 已有配置资产 → 扩展现有资产 → 新建资产`，只推荐最小跃迁（Ponytail：能用现有 skill 覆盖就不新建）。
**验收**：用本仓库真实执行历史做回归样本，检出已知重复流程；不产生误报风暴（建议去重 + 置信度阈值）。

### P6 跨会话审计报告与干预台账

**目标**：让改进效果可纵向验证，形成审计闭环。
**改动**：
- 干预台账 `~/.deepcodeX/eag/intervention-ledger.json`：P3/P5 每条被采纳建议登记 `{ findingId, appliedAt, owner, expectedEffect }`；后续会话出现可比 Task Episode 时回访验证（Outcome-supported 或 keep-open）。
- 确定性渲染 `packages/core/src/eag/report-render.ts`：台账 + verdict 聚合渲染 Markdown 报告（LLM 只产结论文本，报告骨架由代码渲染——对齐 BH「LLM 禁止手写报告」）；Web 端 SettingsDrawer 增加审计页签展示。
**验收**：报告由渲染器生成且含 schema 校验；台账中「已验证 Outcome-supported」的建议可追溯至其前因 finding；Web 面板可查看趋势。

## 4. 实施顺序与依赖

```
P1 证据链 ──┐
P2 证据包 ──┼──> P3 Finding 沉淀 ──> P5 重复工作发现
P4 评估升级 ┘              └──> P6 台账与报告
```
- P1、P2、P4 相互独立可并行；P3 依赖 P2（证据引用）与 P1（证据状态）；P5 依赖 P2；P6 依赖 P3/P5。
- 与在途工作对齐：P3 直接衔接 T02 sedimentation-writer；P1 消费现有 violationCount；P9 脱敏复用 memory/redaction.ts。

## 5. 全局约束（Karpathy/Ponytail）

- 最小改动：P1-P6 全部落在 `packages/core/src/eag/`、`skills/`、`memory/` 现有模块内，不新建顶层子系统；不改 session-runtime 主循环语义。
- 快照注入语义不变：规则/技能对已运行会话不回填，证据记录同样只对新建观测生效。
- 一切「结论」必须可回溯到 bundle 事件；计数只用于路由，永不直接产生 Finding。
- 每项独立可交付、可回滚，验收标准见各节。

## 6. 风险与开放问题

1. **隐私**：execution-history 进 bundle 必须过 redaction 管线，脱敏失败宁可 Unobserved 不可明文兜底。
2. **性能**：P5 序列挖掘在大历史上可能昂贵——限定时间窗 + quick/normal 两档深度，与 BH 一致。
3. **误报**：重复工作检测阈值需要用真实数据调参，先只读观测（record-only）再启用建议产出。
4. **兼容**：verdict/建议结构变更需保持旧消费方（gate runner、Web 面板）向后兼容。
