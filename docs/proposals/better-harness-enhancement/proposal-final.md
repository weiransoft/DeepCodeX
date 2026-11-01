# DeepCodeX 学习增强方案 v2（定稿）—— 借鉴 Better Harness 的证据驱动工作流审计体系

> v1 → v2 变更：按 consensus-report.md 五项共识问题（C1-C5）全面勘误——真实锚点、衔接已合并的 T02、record-only 首期、verdict 三值模型、可量化 P5 验收。

## 0. 一句话结论

Better Harness 的核心贡献是一套**证据驱动的审计方法论**：「配置存在 ≠ 被观测使用」+ 七级证据状态 + Finding 四要素 + 确定性/LLM 双层分工。DeepCodeX 已有会话持久化（`~/.deepcode/projects/**`）、执行历史（`v2/memory/execution-history-store.ts`）、EAG 评估器（`eag/evaluator/`，EvaluationVerdict 三值）、经验沉淀（`eag/dynamic/sedimentation-suggester.ts` + `agents/sedimentation-writer.ts`，T02 已合并）等底座，但**证据链断裂**。本方案用六项改造把这条链接上。

## 1. 对照说明矩阵（锚点已勘误）

| # | 能力维度 | Better Harness | DeepCodeX 现状（真实路径） | 差距 |
|---|---|---|---|---|
| 1 | 证据观 | 七级证据状态；「配置存在≠被观测使用」 | 规则触发计数（violationCount）已存在但无消费闭环；skill/memory 无使用观测 | 关键 |
| 2 | 证据聚合 | `harness evidence-bundle` 单命令冻结边界 | 数据分散于 `~/.deepcode/projects/**` 会话 JSONL、execution-history、v2 事件流，无聚合入口 | 关键 |
| 3 | Finding 模型 | 证据/影响/最小修复/验证 四要素 + 质量门 | suggester 产候选，writer（`agents/sedimentation-writer.ts`）白名单字段落盘，无四要素契约 | 部分 |
| 4 | 评估模型 | 五维度×15 检查项 + 分数天花板 | `eag/evaluator/types.ts` EvaluationVerdict：PASS/FIX/HUMAN_CHECKPOINT 三值，无分级证据语义 | 中等 |
| 5 | 重复工作发现 | loop-discovery → 资产覆盖阶梯 | execution-history 数据在，无检测层（`eag/discovery/` 空） | 关键 |
| 6 | 分层执行 | 确定性脚本层采集/校验/渲染，LLM 禁手写报告 | v2 observability 结构化日志已有；确定性校验/渲染未成文 | 小 |
| 7 | 并行证据代理 | 3 只读 lane 隔离 + lead reconciliation | T01 custom agents 子代理能力已有，无证据隔离模式 | 小 |
| 8 | 纵向验证 | 干预台账 + 后续可比 Episode 回访 | 建议落盘后无效果回访；violationCount 无消费 | 关键 |
| 9 | 脱敏 | 会话证据默认语义 facet 化 | `v2/memory/redaction.ts` 已有管线，execution-history 未过脱敏 | 小 |
| 10 | 审计报告 | findings.json 机器校验 + 确定性渲染 | 无报告产物 | 中等 |

## 2. 增强方案（v2，六项）

### P1 资产使用证据链（record-only 起步）
- **规则侧**：`eag/rlis/rule-store.ts` 规则记录扩展 `evidence: { wiredAt[], exercisedAt[], verdictRefs[] }`。注入会话记 Wired；violation 命中记 Exercised（**确定性来源已存在**：violationCount 事件）；关联 EvaluationVerdict 记 Outcome-supported。
- **技能/记忆侧**：`skill-manager.ts` 注入计数记 Wired；Exercised 归因（消息级匹配噪声大）**首期不做**，留 `evidence.exercisedAt` 扩展点。memory 命中统计同 record-only，复用 `v2/memory/redaction.ts`。
- **验收**：状态迁移单测；Web 规则面板展示证据级别；redaction 回归测试通过。

### P2 统一证据包 `deepcodex eag evidence-bundle`
- 新建 `packages/core/src/eag/evidence-bundle.ts` + CLI 子命令：`--workspace --since --until --depth quick|normal --format json`。聚合：会话 JSONL（过 redaction 语义 facet 化）、execution-history、v2 事件流、资产 inventory（P1 证据级别）。冻结 workspace/时间窗/文件清单 SHA256。
- **Web 暴露（共识采纳）**：`packages/web` 新增只读 API 同源返回 bundle 摘要，供 SettingsDrawer「审计」页签（与 P6 共用）。
- **验收**：bundle JSON schema 校验；同窗口重复执行字节级一致；quick/normal 两档；Web 页签可渲染摘要。

### P3 Finding-bound 沉淀建议（衔接已合并的 T02）
- Finding 契约定义在 **suggester 输出侧**（`eag/dynamic/sedimentation-suggester.ts` 产 `{ id, evidence[], impact, minFixScope, verifyRoute, evidenceState, severity }`）；`agents/sedimentation-writer.ts` **白名单显式扩展**这些新字段（否则被静默丢弃——共识 C2）。
- evidence 引用 P2 bundle 事件序号，可回放；无证据候选 → deferred 池（保留工作理由）。
- **验收**：落盘建议过 schema 校验；evidence 可回放；writer 集成测试证明新字段完整落盘。

### P4 证据状态与天花板进 EAG 评估
- **第一步（结构先行）**：`eag/evaluator/types.ts` 的 EvaluationVerdict 增加可选 `evidenceState`（七级：Present/Wired/Exercised/Outcome-supported/Missing/Unobserved/Not-applicable）、`confidence`、`dimensionScores?`（五维度，可选字段，旧消费方兼容）。
- **第二步（语义）**：天花板常量表（Missing/Unobserved/NA ≤59、Present ≤74、Wired ≤84、Exercised ≤94、Outcome-supported 100）；**Unobserved 不得冒充 Missing**。
- **验收**：单测覆盖「Unobserved 不降级」「分数不超天花板」「旧 verdict 消费方不受影响」。

### P5 重复工作发现（eag/discovery/）
- 新建 `packages/core/src/eag/discovery/loop-discovery.ts`：对 P2 bundle 做命令/工具序列 n-gram + 任务聚类；阈值触发（如 7 天内 ≥3 次可比序列）；按覆盖阶梯只推荐最小跃迁（内建 → 已有配置资产 → 扩展 → 新建）。首期 **record-only**（只产出报告不自动写资产），二期再接 sedimentation。
- **验收（量化，共识 C5）**：用本仓库真实执行历史构造回归样本，已知重复流程检出率 100%；单次产出建议 ≤5 条；人工抽检精确率 ≥80%。

### P6 审计报告与干预台账
- 台账 `~/.deepcodeX/eag/intervention-ledger.json`（**新写统一 .deepcodeX，读取兼容 ~/.deepcode，双读单写不迁移存量**——共识采纳）：`{ findingId, appliedAt, owner, expectedEffect }`；后续可比 Episode 回访验证。
- 确定性渲染 `eag/report-render.ts`：**首期只做 schema 校验 + Markdown 渲染**（共识采纳），HTML/趋势图后置为 P6.1；LLM 只产结论文本，报告骨架由代码渲染。台账 + verdict 聚合进 P2 的 Web 审计页签。
- **验收**：报告由渲染器生成且过校验；「Outcome-supported」结论可追溯至前因 finding。

## 3. 实施顺序

```
P1 证据链 ──┐
P2 证据包 ──┼──> P3 Finding 沉淀 ──> P5 重复工作发现（record-only）
P4 评估升级 ┘              └──> P6 台账与报告（MD）──> P6.1 趋势图
```
P1/P2/P4 可并行启动；P3 依赖 P2；P5 依赖 P2；P6 依赖 P3/P5。建议排期：P2 → P1+P4 → P3 → P5 → P6。

## 4. 全局约束

- 最小改动：全部落在 `packages/core/src/eag/`、`skill-manager.ts`、`v2/memory/` 现有模块内；不改会话主循环语义；快照注入语义不变。
- 一切结论可回溯到 bundle 事件；计数只用于路由，永不直接产生 Finding。
- 每项独立可交付、可回滚；隐私红线：脱敏失败宁可 Unobserved，不可明文兜底。

## 5. 评审记录

- 四角色评审原文见 reviews/ 目录（architect/pm/test-expert/coder）。
- 共识收敛见 consensus-report.md；v2 已逐条落实 C1-C5 与三项采纳建议。

## 6. 实施记录（2026-11-01，P2 + P1 + P4 已落地）

### 已实现

**P2 统一证据包**
- 新建 `packages/core/src/eag/evidence-bundle.ts`：`buildEvidenceBundle`（聚合执行历史/三层规则资产/技能清单，窗口过滤、脱敏瘦身、SHA256 manifest）+ `validateEvidenceBundle`（结构校验，冻结性约束 generatedAt=window.until）；`export *` 挂入 `eag/index.ts`，具名导出挂入 core index
- CLI：新建 `packages/cli/src/eag/eag-cmd.ts`（`deepcode eag evidence-bundle [--days n] [--depth quick|normal] [--format summary|json]`，human-first 摘要 + --format json 机器模式、先校验后输出）；`cli-args.ts` 新增 eag 子命令解析（对齐 team/rules 三段式 fallback 模式）、`cli.tsx` 增加路由
- 说明：技能清单 provider 接口已预留（`listSkills` 注入），CLI 默认不挂（record-only 空清单）

**P1 资产使用证据链（record-only）**
- `eag/rlis/types.ts`：新增 `RuleEvidenceState`（present/wired/exercised/outcome-supported 四级）、`RuleEvidence`（wiredAt/exercisedAt/verdictRefs 时间线，容量上限 100）、`deriveRuleEvidenceState`（统计字段兜底推导）；`UserRule` 增加可选 `evidence` 字段（向后兼容）
- `eag/rlis/rule-store.ts`：`recordUsage`/`recordViolation` 同步追加证据时间线；新增 `recordVerdictRef`（P4 集成点）
- `global-rules.ts`：新增 `markGlobalRulesInjected`（注入回写 usageCount+1 + wiredAt，全容错）；`session.ts` 全局规则注入成功后调用（Wired 闭环打通）
- 待办：skill/memory 侧注入计数（P1b）；violation 的生产调用点接线（评估器打回时调 recordViolation，属 P3/P4 集成）

**P4 证据状态与天花板**
- `eag/evaluator/types.ts`：新增 `EvidenceState`（七级）、`EVIDENCE_SCORE_CEILINGS`（59/74/84/94/100 天花板常量表）、`capDimensionScore`/`capDimensionScores`、`WorkLoopDimension` 五维度；`EvaluationReport` 增加可选 `evidenceState`/`evidenceScore`/`dimensionScores`；`buildReport` 增加可选 evidence 参数（不传时行为逐字节不变）

### 验证结果

- core tsc / cli tsc / web tsc 全部 0 错；core dist 已重建
- 新增测试 25/25 通过：eag-rlis-rule-evidence（10）、eag-evaluator-evidence（7）、eag-evidence-bundle（8，含冻结性字节级一致与脱敏红线）
- 受影响存量测试全绿：eag-rlis-rule-store-injector 48/48、eag-evaluator-types 28/28、eag-rlis-types 36/36、eag-rlis-seed-rules 35/35、eag-rlis-rule-learner 38/38
- core 全量（最终代码状态）：仅 1 失败 = session.test.ts「stream 60 秒重试」，经 git stash 对照验证为**存量失败**，与本次无关
- cli 全量：44 失败全部为 eag-rules-cmd 单文件沙箱环境问题（WorkBuddy safe-delete shim 拒绝 beforeEach 删除 `~/.deepcodeX/rules`），非代码问题；cli-args 60/60
- web 全量：293/293 通过
- CLI 冒烟：真实工作区 `deepcode eag evidence-bundle`（quick 档）摘要输出正确、exitCode=0

### 后续（P3 / P5 / P6）

- ~~P3：suggester 侧 Finding 契约 + writer 白名单扩展（evidence 引用 P2 bundle 事件）~~ → 已落地（见 §7）
- ~~P5：`eag/discovery/loop-discovery.ts` 重复工作发现（消费 P2 bundle）~~ → 已落地（见 §7）
- ~~P6：干预台账（统一 `.deepcodeX`）+ 确定性 MD 渲染 + SettingsDrawer 审计页签（P2 bundle 的 Web 同源暴露）~~ → 已落地（见 §7）

## 7. 实施记录（2026-11-01，P3 + P5 + P6 已落地）

**P3 Finding-bound 沉淀契约**

- 新建 `eag/dynamic/finding.ts`：`AgentFinding` 四要素契约（`evidence[]` 可回放引用 / `impact` / `minFixScope` / `verifyRoute`，复用 P4 七级 `EvidenceState`）；`validateFinding` 唯一 schema 关卡（非法丢弃不截断）；`partitionByEvidence` bound/deferred 划分（**deferred ≠ rejected**，无证据候选保留 rationale 待补证据升级）
- `agents/sedimentation-writer.ts`：`SedimentationDraft` 增可选 `finding`；白名单显式扩展（validateFinding 校验通过才保留）；落盘时 finding 写入同目录 `finding.json`（SKILL.md 本体契约不变，向后兼容），`WriteResult` 增 `findingPath`
- `eag/dynamic/sedimentation-suggester.ts`：LLM 抽取链路透传 finding（非法降级 deferred + 结构化日志 `sediment-finding-invalid`）；prompt 契约扩展 finding 四要素说明（「无法给出真实证据时宁可不写 finding，不得编造」）

**P5 重复工作流发现（record-only）**

- 新建 `eag/discovery/loop-discovery.ts`：`discoverRepeatedFlows`（纯函数）对执行历史做归一化 n-gram（n=3..5）序列挖掘——bash 按 argsSnippet 首词归一（`bash:build`），跨会话阈值（默认 7 天 ≥3 次 ≥2 会话），平凡序列过滤（distinct <2 不算工作流，同会话内重复归 TurnGuard 不越界）；覆盖阶梯最小跃迁（已知资产 token 重叠 → extend，否则 create）；`discoverFromStore` 便捷入口衔接 `ExecutionHistoryStore.query({lastDays})`；单次建议 ≤5 条（共识 C5）；指纹 sha256 支撑跨窗口去重

**P6 干预台账 + 确定性渲染 + Web 审计页签**

- 新建 `eag/intervention-ledger.ts`：台账 `<homeRoot>/.deepcodeX/eag/intervention-ledger.json`（新写统一 .deepcodeX），**双读单写**——读取新根缺失回退 `.deepcode` 旧根，追加时旧根存量随首次写入合并进新根（单写路径零丢失，旧根文件不删除）；tmp+rename 原子写；容错读（损坏/坏条目逐条跳过）；`recordVerification` 回填回访结果（outcome-supported/partial/blocked）；容量上限 500（超限优先丢最旧无验证条目）
- 新建 `eag/report-render.ts`：`renderAuditReport` 确定性 Markdown 渲染（同输入字节级一致，时间显式传入；排序稳定；LLM 只产结论文本，骨架代码渲染）；`validateAuditReport` 必备章节自检；Outcome-supported 条目渲染「追溯」行（引用 findingId + appliedAt，验收达成）
- Web：新建 `api/audit-api.ts`（GET `/api/eag/audit`，只读聚合：规则证据 P1 + 台账 P6 + 确定性报告；engineHomeFor 与 rules-api/session-pool 逐字一致）；前端新建 `AuditPane.tsx`（规则证据表 + 干预台账 + 报告原文），SettingsDrawer 增「审计」页签；顺手修复 FileDrawer.tsx 上一轮遗留的 `DrawerScope`→`FileScope` 类型错误（`load("", next)` → `load("", toApiScope(next))`，运行时行为不变）

### 验证结果（第二批）

- core / web 服务端 / web 前端 tsc 全部 0 错；eslint 0 error（1 warning 为存量）；core dist 重建、web 前端 bundle 构建通过
- 新增测试 24/24 通过：eag-finding-contract（10）、eag-loop-discovery（10，含已知重复流程检出率 100% 与 ≤5 条上限）、eag-ledger-report（10）、audit-api（4）
- 受影响存量全绿：sedimentation-writer + sedimentation-suggester 18/18、rule-store-injector 48/48
- core 新增+受影响合集 104/104；web 全量 **297/297**（293 存量 + 4 新增）
- P5/P6 的 Web/CLI 出口：审计页签已上线；CLI `deepcode eag` 后续可加 `loop-discover`/`report` 子命令（core API 已就绪，未接线——留待按需）
