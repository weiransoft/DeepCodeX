# EAG 全量代码审查报告：同类问题逐文件验证

- **日期**：2026-11-08
- **触发**：「review 整个 eag 代码，检查是否还有同类型的问题，逐一文件逐一验证」
- **性质**：**只读审查**。未修改任何生产代码，未执行 `git add` / `commit` / `push`，未运行会改动工作区的命令。本次仅新增本报告与逐文件索引两份文档。
- **基线**：`892938aa`（本轮「bash 多轮空转与基线红灯误判」全链路修复，已提交并推送 `origin/main`）
- **判定口径**：只报**仍存在**的同类缺口；「本轮已修复」不重复报成新问题；无法实测的一律标 `⚠️ 疑似需复核` 并写明所缺证据，不臆断为确证。

---

## 1. 审查范围与方法

### 1.1 权威清单（经三次口径校正）

| 项 | 数值 | 取法 |
|---|---|---|
| EAG 源文件 | **258** | `git ls-files packages/core/src/eag \| grep -E '\.ts$'` |
| 源文件总行数 | **135,367** | 上述清单逐文件 `wc -l` |
| 跨层边界文件 | **2** | `packages/core/src/session.ts`、`packages/core/src/context-budget.ts` |
| **审查权威清单** | **260** | 258 + 2 |
| EAG 相关测试文件 | 209 | 测试覆盖矩阵抽查（未逐一执行） |

> **口径陷阱（已修正）**：`git ls-files 'packages/core/src/eag/**/*.ts'` 只返回 **252** 个，漏掉 EAG 根级 6 个文件（`assembly.ts` / `index.ts` / `suggestion-auto.ts` / `evidence-bundle.ts` / `report-render.ts` / `intervention-ledger.ts`）。此前索引显示「权威 254 / EXTRA 6」即由此产生，现已统一改用目录清单按扩展名过滤。

### 1.2 「同类型问题」定义：本轮事故的 10 类根因族

| # | 根因模式 | 典型表现 |
|---|---|---|
| 1 | 自建执行循环无「无进展」判定 | 多轮 `ls/pwd/find`，输出变化但工作区不变，无熔断 |
| 2 | 护栏只覆盖部分执行路径 | 主 chat `TurnGuard` 管不到 p5 子执行器 / graph 自建循环 |
| 3 | 失败反馈丢失或未回灌 | 下一轮拿不到 `AssertionError` / 用例名 / 终止原因 |
| 4 | 确定性失败误判 | 把 run 起始既有红灯算作本任务失败，触发过激 abort |
| 5 | 输出 head-only 截断丢尾部证据 | `slice(0, N)` 截掉 stderr / 断言 / 结论段 |
| 6 | catch 吞错伪装成功 | 查询失败 → 空数组 → `passed:true` / `success:true` |
| 7 | 统计口径两套 | 报告里同一指标两处不一致；`changedFiles` 全量 vs 差集 |
| 8 | 报告用泛化模板不写真实证据 | 「连续失败 N 次触发 abort」，无失败用例与原因 |
| 9 | 开关默认关 / fail-open | 缺检查器、缺上下文仍 `allPassed:true` |
| 10 | resume / fix / 逃生门裸重放 | 从零重跑整卡、重放命令不带上一轮失败状态 |

### 1.3 方法

1. **统一模式扫描**：`/tmp/dcx-eag-scan.json`，12 类检查项（`C1_loop_cap` … `C12_llm_call`），覆盖 258 个文件，风险权重 HIGH 77 / MID 60 / LOW 121。扫描命中一律回读源码确认，剔除注释 / import / 常量 / fixture 字符串误报。
2. **6 组并行逐文件精读**：每组对分到的每个 `.ts` 给出独立结论行（职责 / 结论 / 行号证据 / 严重级 / 建议），禁止「其余均无问题」式合并。
3. **lead 独立复核**：不采信 worker 自报分级，逐条回读源码；交叉复核跨层契约；澄清组间冲突；记录所有分级升降。复核笔记 `/tmp/dcx-eag-lead-verification.md`。
4. **统一索引归并**：`/tmp/dcx-eag-index.md`，保留逐文件表格原文，由 lead 归并路径、补查缺口、重算计数。

### 1.4 分组

| 组 | 范围 | 文件数 |
|---|---|---|
| W1 | `p5/` 核心链路 | 26（+ lead 补查 1） |
| W2 | `loop/` `graph/` `long-horizon/` | 31 |
| W3 | `coding/` `testing/` | 55 |
| W4 | `gate/` `devops/` `deploy/` `doc-driven/` `design/` | 45 |
| W5 | `pkc/` `tcs/` `edm/` `eak/` `etsb/` `icp/` `rlis/` `dynamic/` `discovery/` + 根级 | 94 |
| W6 | 跨层边界（session / context-budget / cli / config / assembly）+ 测试覆盖矩阵 | 12 |

---

## 2. 覆盖统计（终审口径）

| 组 | 逐文件条目 | ✅ 未发现 | ⚠️ 疑似 | ❌ 确证 | ➖ 不适用 |
|---|---|---|---|---|---|
| W1 | 27 | 19 | 2 | 2 | 4 |
| W2 | 31 | 9 | 8 | 8 | 6 |
| W3 | 55 | 5 | 3 | 6 | 41 |
| W4 | 45 | 18 | 10 | 6 | 11 |
| W5 | 94 | 27 | 20 | 2 | 45 |
| W6 | 12 | 5 | 3 | 2 | 2 |
| **合计** | **264** | **83** | **46** | **26** | **109** |

- **264 个结论行 / 260 个唯一路径 / 权威清单 260 个 → 零遗漏、1:1 对齐**。
- 3 个路径被有意交叉复核：`assembly.ts`（W5/W6）、`index.ts`（W1/W5/W6）、`suggestion-auto.ts`（W5/W6），合计多出 4 行，故「条目 264」与「唯一 260」的差值 4 有明确来源。
- **补查项**：`p5/index.ts` 未出现在 W1 逐文件表，由 lead 独立补查——495 行、48 个 `export`、其余为模块头注释与导出成员列表，唯一例外 `:359` 是重命名续行；全文无循环 / catch / 子进程 / 截断 / 结果改写，纯 barrel 重导出，判 `➖ 不适用`。**未把「未列名」记作 ✅**。
- `➖ 109` 均为纯类型 / 模板 / 静态数据 / barrel，逐行写明结构上不可能承载 10 类根因的理由，不是「未审」。

---

## 3. 结论摘要

**本轮 `892938aa` 修复的主链确为闭环**：p5 子执行器双轨无进展熔断、基线红灯诚实降级、changedFiles 差集口径、fix 后不重跑整卡、`failedTestIds` 顶层契约、逃生门 `failureContext` 三参主链，均经 W1/W6 独立复核，未发现确证的 P0 级残留（**限正常终态路径**）。

**但同类型的根因族在 EAG 其它子系统仍大面积存在**：终审确认 **8 条 P0 / 21 条 P1 / 20+ 条 P2**。最值得优先处理的三条：

1. **`long-horizon` 状态重放把失败 run 重建成 `running`**（W2 P0-1），resume 检查点分支永不触发，失败原因无法跨轮传递——与事故「逃生门裸重放」直接同源。
2. **`testing-orchestrator.ts` 把 stderr 收了却从不读**（W3 F-01），测试执行边界的 AssertionError / 失败用例名整体消失，G-7 与 PR 只拿到计数——与事故「报告不写真实证据」直接同源，且发生在另一个 EAG 子系统。
3. **部署/回滚链路多处「信息不足 → passed/success: true」**（W4 J-01/J-02/J-03）：G-8 监控与回滚预案恒真、kubectl 输出解析失败被 `0/0 → 0>=0` 判成「回滚验证成功」——发生在安全关键路径。

---

## 4. P0 确证发现（8 条，建议优先修复）

### P0-1 失败 run 重放成 `running`，resume 检查点永不触发
- **位置**：`long-horizon/run-state-store.ts:1063-1074`（`case "human-intervention"` 只 push `HumanInterventionRecord`，不改 `status`）、`:987`（`status` 初值 `"running"`）；`long-horizon/eag-run-handler.ts:813-834`（仅 `completed`/`failed` 追加终态事件）、`:720-721`；`long-horizon/eag-resume-handler.ts:393`（`status === "human-checkpoint"` 判定）；`long-horizon/types.ts:52`（合法状态含 `human-checkpoint`）。
- **成因**：完整重放状态机缺 `human-intervention → human-checkpoint` 迁移，run 结束未写 `run-paused` / `run-failed` 事件与 `blockedReason`。
- **后果**：`load()` 重建出的阻塞 run 是 `running`、`blockedReason` 丢失；resume 的 `human-intervention-resolved` 分支永不执行，介入记录永远 `resolved=false`；失败原因传不到下一轮 → 直接复刻裸重放。
- **最小修复**：`rebuildRunStateFromEvents` 的该分支设 `status="human-checkpoint"` 并写 `blockedReason=p.reason`；Step 6 为 human-checkpoint 追加 `run-paused` 事件。

### P0-2 graph fork 分支整体绕开图级护栏与调度器
- **位置**：`graph/graph-loop-orchestrator.ts:776-934`（`:868` 直接 `nodeExecutor.execute`、`:817/:848/:900` `retryCount:0`、`:912-930` 仅合并结果），对比主路径 `:347/:467/:546/:324`。
- **成因**：`executeFork` 未复用主路径的 `checkPreExecution` / `checkPostExecution` / `decideNext` / `nodeRetryCounts`。
- **后果**：fork 节点不受 token/深度/超时/输出契约/自定义规则护栏，不受连续失败抑制与总重试预算，失败不触发 retry/isolate/stop——事故模式 #2 在图内成立。
- **最小修复**：分支执行前后补 pre/post guard；分支结果纳入 `decideNext` 与 `nodeRetryCounts`。

### P0-3 resume 裸重放：不带失败状态、不复用已生成产物
- **位置**：`long-horizon/eag-resume-handler.ts:130-157`（`EagResumeRequest` 无失败字段）、`:335-340` + `:791-793`（用最小 spec 重建 plan）、`:362-366`（`run-resumed` 仅记 `previousStatus/userDecision`）、`:453-463`（context 无失败状态、`specContent: undefined`）、`:469`；`long-horizon/multi-loop-planner.ts:531`。
- **成因**：resume 不持久化、不回灌 `RunState.blockedReason`、上一轮 `failureReason/failedTestIds` 与 spec/plan/tasks。
- **后果**：必然复刻失败（模式 #10）；`completedNodeIds` 按 loopType 粗粒度推导，与原 plan 节点集合错位。
- **最小修复**：resume 请求/上下文携带失败反馈与已生成 spec/plan/tasks；持久化并复用原 `MultiLoopPlan`。

### P0-4 测试执行边界失败证据整体消失
- **位置**：`testing/testing-orchestrator.ts:1012`（`let stderr = "";`）、`:1017-1019`（`child.stderr?.on("data", …)` 累加）、`:1039-1067`（只 `JSON.parse(stdout)` 且只取 `status`，丢 `name` 与失败详情）、`:1069-1075`（`resolve({ filePath, exitCode, durationMs, failedCount, passedCount })`）。全文 `stderr` 仅在声明/累加处出现，**无消费点**。
- **后果**：AssertionError / stderr / 失败用例名在测试执行边界消失，G-7（`:742-751`）与 PR 报告只拿到计数 → 复刻「阻塞报告只给泛化模板、不写真实证据」。
- **最小修复**：`TestExecutionResult` 增 `stderr` / `failedCases` / `errorMessage` 并透传 G-7 与 `generatePrDescription`；解析失败时保留原始 stdout/stderr 片段。

### P0-5 PKC 查询失败吞错 → 高风险符号覆盖率恒 100 → 门禁可误通过（**lead 由 P1 提升**）
- **位置**：`testing/coverage-gate.ts:298-304`（`try { queryRiskHotspots } catch { log(warn) }`，`riskHotspots` 保持 `[]`）、`:310`、`:506-512`（`if (riskHotspots.length === 0) return 100;`）、`:313`。
- **后果**：真实 PKC 故障被算成「高风险符号覆盖率 100%」，该维度不进 `failedDimensions`，门禁可通过。属「catch 吞错 → 把真失败说成通过」，且影响阻断判定，比展示层问题更严重。
- **最小修复**：catch 时把该维度记入 `failedDimensions` / `unknown` 并在报告标注「PKC 不可用」；禁止空数组返回 100。

### P0-6 G-8 监控告警 + 回滚预案恒真放行
- **位置**：`devops/devops-orchestrator.ts:278-279`（`monitoringReady: context.monitoringReady ?? true` / `rollbackPlanExists: context.rollbackPlanExists ?? true`）；`gate/gate-g8-checker.ts:148-162`；`devops/rollback-plan-checker.ts:48-50`（注释确认 `rollbackPlanExists=true` 即跳过真实校验）。
- **后果**：批次 14 已实现的真实检查器被默认路径绕过；监控告警未就位、回滚预案不存在时 G-8 仍判通过 → `devops-completed` / `success=true` → 无监控、无回滚预案的部署被报为生产就绪。
- **最小修复**：去掉 `?? true`，未配置传 `false` 或抛错；G-8 调用真实检查器并以 `valid`/`ready` 为准。

### P0-7 回滚验证把 JSON 解析失败当成回滚成功
- **位置**：`devops/rollback-manager.ts:825-827`（`catch { return { availableReplicas: 0, expectedReplicas: 0 }; }`）、`:504`、`:508-515`（`if (availableReplicas >= expectedReplicas)` 即 `0 >= 0` → `success:true`，message 明写「回滚验证成功：0/0 副本可用」）。
- **后果**：kubectl 输出非合法 JSON 时把「状态无法确认」报成「回滚验证成功」，回滚可能实际未生效，且发生在安全关键路径。
- **最小修复**：解析失败抛错或返回带 `parseOk:false` 的结果；`verifyRollback` 要求 `expectedReplicas > 0 && parseOk` 才可能 success。

### P0-8 监控就绪门禁「信息不足即通过」
- **位置**：`devops/monitoring-readiness-checker.ts:546-553`（注释「K-4 决策简化：prometheusConfigPath 未提供时视为通过」，`passed:true`）、`:236-237`、`:243`（`ready = checkedItems.every(passed)`）。
- **后果**：未配置 Prometheus 路径（无法校验 scrape 规则）时监控就绪判 `ready:true`，与 P0-6 的 G-8-4 默认放行叠加。
- **边界**：lead 判定位于 P0/P1 边界——单独看影响面较窄，但与 P0-6 同链且属核心红线「信息不足 → passed」，故列 P0 并建议与 P0-6 一并修复。
- **最小修复**：缺失路径返回 `passed:false` 或显式 `skipped` 且不计入 `ready`。

---

## 5. P1 确证发现（21 条）

### 5.1 跨层：逃生门 / 失败反馈链（最重要的一组，4 条）

| # | 位置 | 问题 | 最小修复 |
|---|---|---|---|
| P1-1 | `session.ts:5585`、`:5601`；测试 `session-eag-goal-failure-guard.test.ts:412`(N5) | `acknowledgeFailedGoal=true` 跳过 D2 守卫，直接 `buildAutoExecuteCommand(commandHint, goal)` **只传两参**，不带 `failureContext` → 知情重试成为第三条裸重放通道。N5 的 `objective === goal` 断言间接锁死「不可把约束拼进 goal」 | 放行前 `findFailedAutonomousRun` 取诊断传第三参；**另开独立通道**，不能简单追加第三参；同步改 N5 断言 |
| P1-2 | `session.ts:7914`（`recordAutonomousRunOutcome(..., {})` 传空 details）、`:5686`、`:5515-5518`、`:5640`、`:5959-5963`、`:1553-1556`；`autonomous-orchestrator.ts:267-310`（`AutonomousRunRequest` 无 `failureContext`） | **异常终态 abortReason 丢失 → 泛化模板 → failureContext 缺失 → 逃生门裸重放**；且 `confirm_previous` 消费方零门禁，`failureContext` 覆盖按「快照写入方」而非「消费方强制」，共 4 条旁路。p5 侧无结构化字段接收，只能拼进 `--goal` 文本 | 消费方加门禁（`failureContext` 为空但存在失败 run 时实时重建诊断）；异常路径把 `errMsg` 作 `abortReason`；给 `AutonomousRunRequest` 补失败上下文字段 |
| P1-3 | `context-budget.ts:338`(第 1 级) / `:359`(第 2 级) / `:369-378`(第 3 级) / `:296-297`（占位仅字符数） / `:299-309`（保护窗只保最近 4 条） | 第 0 级 `truncateToolOutput` 只保证**单条 tool 内部**保尾；第 1/2/3 级把保护窗外旧 tool **整条**替换为占位，早期失败证据链（基线对照、前几轮 AssertionError）全丢。事故长会话（40 条 × 4000 = 160K > 100K）确实可触发第 2 级 | 整条替换前抽取失败摘要/尾部保留；极小预算退化也保尾；补「多 tool 超预算 + 窗外含 FAILED」回归测试 |
| P1-4 | `packages/web/src/session-pool.ts:1433-1450`（`:1440` 固定泛化文案） | Web 宿主失败拦截提示无「上一轮诊断」段，用户看到的是事故里的泛化模板形态。**定性修正**：该文件无 `confirm_previous` 处理逻辑，「执行这个」只出现在提示文案里，实际走 core 已修通道 → **Web 侧不构成逃生门裸重放**，问题是展示层缺诊断 | 拦截提示复用 `buildGoalBlockedDiagnostics` 等价物输出诊断段；核对 CLI/Web 宿主侧快照 |

> **链路级确证（W5 P1-3 由 `⚠️` 升 `❌`）**：W6 F-1 补齐了缺失环节——`consumeConfirmPreviousDecision`（`:5675-5695`）只读 `stored.failureContext`，既不从 `autonomousGoalRuns` 重建，也无「第三参必须非空」门禁；`lastEagDisplayedSuggestions.set` 三处写入方中只有 `notifyFailedGoalBlocked` 带诊断。**必须同时写明**：事故主链「D2 硬拦截 → 带真实诊断快照 → `confirm_previous` 消费」本轮修复**有效**（N6/N11/N12 覆盖），本条只报旁路、不否定主链。

### 5.2 p5：本轮修复自身的残留（1 组，2 处表现）

- **P1-5 基线红灯拆分未贯通「修复指令链路」**（lead I-01，本轮最重要发现）：
  - `autonomous-orchestrator.ts:1197-1199` 对 verify 失败轮**无条件** `carriedFailureFeedback = buildVerifyFailureFeedback(result)`，未排除 `baselineOnly===true`；`:3051` 读的是全量 `artifacts["failedTestIds"]`（`verify-stage-handler.ts:513`），`:3054` 带全量 `testOutputTail`。
  - `fix-stage-handler.ts:278-289` 从原始输出尾部重新 `extractFailedTestIds()`，全文件 Grep `newFailedTestIds|baselineFailedTestIds|baselineOnly|baselineAvailable` **零命中**；`:673-689` 让 fix「优先定位并复跑这些用例」。
  - `verify-stage-handler.ts:472-483/:518-520` **拆分本身正确**（`baselineMatched`/`newFailed`/`newFailedTestIds`/`baselineFailedTestIds`/`baselineAvailable`），summary 如实写「N 个基线失败 + M 个新增失败」并明写「基线红灯仍失败，本阶段判定 failed」。问题在**下游消费方**。
  - **后果**：基线隔离只作用于「是否 abort / 是否累计连续失败」，未作用于「喂给 dev/fix 的修复指令」，模型被要求修与任务无关的用例，持续消耗轮次、可能改不该动的基线测试。
  - **修复关键约束**：不能简单把 `:3051` 改成读 `newFailedTestIds`——`canSplit = baselineAvailable && failedTests.ids.length > 0`（`:490`），基线探测降级时 `newFailed` 为空，直接替换会变成「测试失败但反馈里没有任何失败用例」，比现状更糟。**正确条件**：`baselineAvailable === true && canSplit` 用 `newFailedTestIds`，否则**回退全量** `failedTestIds`（诚实降级）；`baselineOnly===true` 时跳过整条搬运或显式标注「本轮无新增失败，无需修改代码」。**顶层 `failedTestIds` 不该改**（`:1250` 注释已明确它透传「哪些用例失败了」这一客观事实，供逃生门展示，与归因结论解耦）。
  - 建议一并加回归：run 起始 2 个基线红灯 + 本任务无新增失败时，断言 fix feedback 与下一轮 dev feedback 中**不出现**基线用例名。

### 5.3 coding / testing（6 条）

| # | 位置 | 问题 | 最小修复 |
|---|---|---|---|
| P1-6 | `coding/static-checkers/dependency-scanner.ts:320-324`、`:359-362` | `JSON.parse` 失败 `catch { continue; }`，若所有 package.json 都解析失败 → `violations` 空 → `buildPass()`，把「无法判定」报成「通过」（**lead 由 P2 提升 P1**，诚实降级红线） | catch 返回 `status:"unknown"` + evidence（对齐 `strict-evaluator.ts:439-448`） |
| P1-7 | `testing/testing-orchestrator.ts:339-340`、`:781`、`:1422` | `const totalLlmCallCount = 0; const totalTokensUsed = 0;` 全文不自增，`recordIteration(0, …)` 使 token 预算护栏对 TESTING Loop 永不生效 | 改 `let` 并在 generator 后累加真实计数 |
| P1-8 | `testing/testing-orchestrator.ts:1377-1387` | `pkcQueryRiskHotspotsSafe()` try 与 catch 都 `return []`（`:1383` 注释自认），高风险符号上下文恒空、判定器空转通过 | 真接入 PKC 或显式标 `skipped` 让下游按 unknown 处理 |
| P1-9 | `testing/testing-orchestrator.ts:1216-1219` | PR 头部只写 `coverageReport.passed ? "✅ 通过" : "❌ 未通过"`，**未列 `failedDimensions`**；WARNING 阶段读者看不到哪些维度未达标（**lead 由 P0 降 P1**：首次失败 `passed=true` 是明文设计取舍，第 2 次会阻断，不是「把真失败说成通过」） | 改用 `failedDimensions.length===0` 判定并列出未达标维度 |
| P1-10 | `testing/testing-orchestrator.ts:907-912` | G-7 上下文 `specStatus/planStatus/userApproved/reviewRecords/actualChanges` 全为常量，这些维度永远不可能失败 | 从 request/真实 Loop 状态派生 |
| P1-11 | `llm-filler.ts:506/510/516`、`fix-loop.ts:1060/1064/1069`、`contract-test-generator.ts:708/869-874`、`e2e-test-generator.ts:300/484-489` | 6 处后台子执行器自建 `messages` 直调 `createMessage`，无 `AbortSignal`，主 chat TurnGuard 管不到（模式 #2）。**⚠️ 是否实际导致无法中断需护栏侧确认** | 调用方 AbortSignal 透传进 `LLMRequest.signal`；统一走带护栏封装 |

### 5.4 gate / devops / deploy（5 条）

| # | 位置 | 问题 | 最小修复 |
|---|---|---|---|
| P1-12 | `deploy/smoke-test-runner.ts:113-114`、`:173`；`deploy/deploy-stage.ts:386/:389-390` | `passed = failedTests === 0`，endpoints/testCases 为空 → `totalTests=0` → `passed:true`。**lead 由 P0 降 P1**：`:113-114` 明注释「空集合视为通过」，是**明文设计非隐蔽 bug**；真实缺口是「一条都没跑」与「跑完零失败」共用同一语义，且上游健康检查无可用端点会得到空数组 → 不触发回滚 → 部署判成功 | `totalTests===0` 返回 `passed=false, reason="no-test-executed"` 或独立状态；`healthyEndpoints` 为空直接失败/回滚 |
| P1-13 | `gate/gate-orchestrator.ts:221`、`:286-295`、`:330-334`、`:311-318` | `strictGateCoverage` 默认 false，缺检查器 / 缺上下文只披露不阻断，少跑门禁仍可 `allPassed:true`。**lead 由 P0 降 P1 并改定性**：`:270-281` 的「此 loopType 不启用门禁 → allPassed:true」合理、不算缺陷；`:286-295` 已有 `skippedGates` 披露、**非完全静默** | 默认 `strictGateCoverage=true` 或默认注册全部门禁；`skippedGates` 非空时 `allPassed=false` |
| P1-14 | `devops/devops-orchestrator.ts:282-285`、`:306-311`、`:344-350` | G-8 未通过仍发 `type:"devops-completed"`（订阅方会把失败 run 当完成）；catch 的默认 `guidance` 是泛化模板 | 按 `success` 选事件类型；guidance 带 `gateResult.reason` 真实证据 |
| P1-15 | `gate/gate-g3-checker.ts:135-141` | `actualChanges.length===0` 直接 `passed:true`，「采集失败致空」与「确认零变更」不分 | 区分两种空集语义 |
| P1-16 | `design/design-orchestrator.ts:137-174`；`assembly.ts:503-531`；`design-roles-llm.ts:780-867` | `while(true)` 每轮相同 3 参重调、`verdict.reason` 未传给架构师（`:141-142` 注释自认），唯一上限 `maxIterations=3`、无确定性失败提前熔断；修复仅在集成层 `FeedbackAwareArchitect`，经装配生效，`session.ts:966` 注入点类型开放不校验闭环，**缺调用方全覆盖证据**（W2 Q4 亦标 ⚠️） | 接口增 `previousVerdict` 参数、加重复 verdict 指纹熔断；闭环下沉到编排器或注入点运行期校验 |

> **部署链路 P2 补充**：`blue-green-strategy.ts:384` / `canary-strategy.ts:489` 硬编码 `success=true`、`rolling-strategy.ts:290` `errors.length===0\|\|resources.length>0` 忽略累积 errors，且 `devops-orchestrator.ts:206/208` 仅 `!success` 才消费 errors → 错误被吞。

### 5.5 misc / loops（5 条，末行合并了 3 条同类项）

| # | 位置 | 问题 | 最小修复 |
|---|---|---|---|
| P1-17 | `icp/evidence-collector.ts:114`、`:118`、`:123`、`:128` | `mergedOutput` 把 stdout 放前、stderr 放后，再 `lines.slice(0, 1000)` **取前 1000 行**并明写「仅显示前 1000 行」→ stdout 超长时真实错误（stderr）整段丢失，`ComplianceEvidence.content` 只剩 stdout 头部，G-7 基于残缺证据判定。与 `assembly.ts:384 .slice(-2000)` 保尾做法相反 | 改 `slice(-1000)` 或 stdout/stderr 分别保尾后合并；至少保证 stderr 完整 |
| P1-18 | `tcs/object-storage.ts:767-770`(S3)、`:1145-1147`(OSS) | `get(key).catch(() => null)` 吞掉网络/认证/权限/超时任意异常，`if (existing === null) return { permanent: true }` 把读失败当成「对象不存在，已永久删除」，**删除流程根本没执行却报成功** | 区分 404 与其它异常；仅 404 走 `permanent:true`，其它上抛或返回 `{ permanent:false, error }` |
| P1-19~21 | `graph/node-loop-kernel.ts:304`、`loop/kernel.ts:158`、`:307-373`；`team/plugins/autonomous.ts:361-367`（`failed` 默认 0 → `success = failed === 0` 恒成功）；`team/plugins/loop.ts:108-116`（达 `max-iterations` 仍 `return this.ok(...)` 报 succeeded）；`graph/graph-context-helpers.ts:331-358`、`:164-190`；`graph/node-executor.ts:266/:279/:318` | 自建 while 循环无「结果指纹 + 工作区快照」双轨无进展判定，绕开主 chat TurnGuard 与 p5 双轨；报告/经验层 head-only 截断 + payload 字段不对齐退化为泛化 `verify-rejected`；节点统计 `humanCheckpoints:[]` / `llmCallCount:0` 失真 | 接入双轨计数并达阈值时诚实判失败；头尾保留截断、payload 对齐；resume 注入上一轮失败反馈 |

---

## 6. P2 观察 / 待复核（汇总，逐条行号见附录索引）

| 组 | 主要条目 |
|---|---|
| W1 | `plan-stage-handler.ts:243-249` 跨 run 记忆 `slice(0, 1500)` head-only；`env-boundary-guard.ts:424/:823` 凭据值 8192 字符 head-only fail-open；`types.ts:106` `baselineDirtyPaths?` 死字段；`session-eag-goal-failure-guard.test.ts:666-668` 桩注释与生产 `:390/:1722` 矛盾（**不算假通过**，生产透传由 B7a/B8a 真实链路覆盖） |
| W2 | 默认护栏开关 `maxTokens:0`/`timeoutSec:0` + `tokenBudgetHardStop:false`；`graph-lifecycle-manager.ts:161` 新建 orchestrator 不调 `scheduler.reset()` 致计数跨 run 污染；`graph-loop-orchestrator.ts:635-648` 未知 run 报成完成；模型层缺 `failureFeedback/failedTestIds` 字段；`loop/kernel.ts:307-373` 不跳过已完成节点 |
| W3 | `coding-orchestrator.ts:681-687` finalFillResult 重建丢字段 + token 两套口径；`contract-test-generator.ts:928-929` / `e2e-test-generator.ts:538-539` 无条件取 `files[0].content`（对照 `llm-filler.ts:555-592` 已修，属同族未修残留）；`strict-evaluator.ts:81/317/333` 连续失败恒 0 致 STOP_FAILURE 不可达；`fix-loop.ts:790-796/1029/1116` patch 失败原因未回灌 + head-only；`llm-filler.ts:182-185` 失败原因截 200 字符；`testing-orchestrator.ts:1246` 验收标准截 60 字符；`buildFailureResult` 塞 `buildEmptyCoverageReport()` 假 0% 报告（**lead 由 P0 降 P2**：`passed:false` 诚实、真实原因另有 `blockedReason` 独立字段，属统计口径污染而非掩盖） |
| W4 | `design-roles-llm.ts:165/:183`、`gate-g7-checker.ts:350` 失败原因 head-only；部署策略 success 忽略累积 errors；`document-state-machine.ts:56-61` approved 终态不可回退 + 重建丢 version/审批历史；`rollback-manager.ts:659-661` 等降级值是否被上层当成功缺证据（⚠️） |
| W5 | `evidence-bundle.ts:252/255-268/306-308` 丢尾部最新记录 + 失败原因文本不进 bundle；`report-render.ts:70/85/101/138-140` 空态泛化模板 + 校验只查 4 个标题；`icp/compliance-engine.ts:275-283` `every([])→overallPassed=true`；`sedimentation-suggester.ts:241-243` 取前 30 轮而非最近轮次；pkc 系列 L1/L3/L4 分析器 `catch { continue/return null }` 静默跳过 + 无标注截断；`intervention-ledger.ts:79-90` verification 白名单静默丢弃；`dynamic/finding.ts:111/164` 字段口径不一致 |
| W6 | `context-budget.ts:128-135` 极小/非法预算退化仍 head-only；`config/eag-config-loader.ts:126-146` 全仓 `packages/` 仅自身 + 测试引用，**配置对 `/eag-autonomous` 实际不生效**；`eag/cli/eag-graph-command.ts:600` 把 `aborted` 判 `success=true`（与 `session.ts:5908` 相反）；护栏第三类执行路径（GoalDispatcher → `plugin.execute`）与 `ask_permission` 挂起轮不记三类护栏；`suggestion-auto.ts` 头注释所述 `App.tsx` finally 块经复核**确实存在、未过期**（W6 F-3 自检更正） |

---

## 7. 正面证据：本轮修复闭环 + 仓内诚实实现参照

### 7.1 `892938aa` 修复主链（W1/W6 独立复核，确证无残留）

| 修复项 | 证据 |
|---|---|
| 子执行器双轨无进展熔断 | `llm-task-executor.ts:1424-1436`（计数/清零）、`:1742-1751`（全 deny 豁免 + `trackBAvailable`）、`:1289/:1382/:1535`（三处折叠有界衰减）、`:1978-2009`（元数据剥离） |
| 基线红灯诚实降级 | `baseline-guard.ts:78-80/82-94/96-101/107-120/127-130` 六类降级；`:108-110` parser/total 判据；`:115-120` 提取不到用例标识即降级 |
| 基线轮稳定化 | `autonomous-orchestrator.ts:1301-1308` 清确定性失败指纹累计；`:2982-2984` findings 稳定化 |
| 报告用真实证据 | `autonomous-orchestrator.ts:3651-3659` 真实 `testCommand`/`projectRoot`/失败清单；`:1722` 顶层 `failedTestIds` |
| changedFiles 差集口径 | `dev-stage-handler.ts:422-431`、`fix-stage-handler.ts:461-497`、`autonomous-orchestrator.ts:3424-3487` |
| fix 后不重跑整卡 | `dev-stage-handler.ts:208-224`（`skipDevAfterFix`）、`fix-stage-handler.ts:461-497`（`fixApplied`）、`run-state-store.ts:803-836` |
| 输出非 head-only | `test-output-analysis.ts:322-371`、`context-budget.ts:119-140`（head + 失败窗口 + tail） |
| 逃生门主链 | `session.ts:477-488/12212-12218/1407/1532-1576/5686/5880-5885` + `suggestion-auto.ts:265-290` 三层闭环；N6/N11/N12 覆盖 |

> **边界限定**：W1「p5 无 P0」结论仅适用于**正常终态路径**。异常终态（`:7914` 空 details）与知情重试（`:5585/:5601`）两条通道缺失诊断，已列为 P1-1/P1-2。

### 7.2 仓内「正确实现」参照（可作为修复模板）

- `assembly.ts:384` `.slice(-2000)` 保**尾部** stderr；`:236-245` 重试把上轮 `feedback.reason/findings/suggestedFix` 拼进 `nodeTask`；`:145-169` 装配失败 `return undefined`（fail-closed）。
- `tcs/ldap-adapter.ts:385-391`（batchSize 夹 1）+ `:443-495`（`while(true)` 双退出：`batch.length` 为空 + `nextOffset<=offset` 游标前进）——**「循环硬上限 + 无进展判定」的已正确实现范例**，正对应事故「dev 空转 40 轮无熔断」。
- `pkc/l4/handover-doc-builder.ts:130-165` 单章节失败降级章节带 `confidence="inferred"` + 错误提示 + `sources=[]`（降级必标注）。
- `icp/compliance-engine.ts:137/150/169` catch → `handleRuleError` 返回 `passed:false`，**未**静默通过；`tcs/vulnerability-scanner.ts:509-513` 扫描失败写 `notes="扫描失败：<原因>"`。
- **门禁诚实性矩阵**：G-1/G-2/G-4/G-5/G-6/G-7 及 `pre/post-deploy-checker` 在信息不足时**一律 `passed:false`**，是本仓最诚实的对照；问题集中在部署/监控/回滚链路与编排层默认放行。
- `eag/cli/eag-autonomous-command.ts:483-504` 原样透传 `runResult`、无重建丢字段；`eag-command-parser.ts:474-476` 解析失败返回 `payload:null` 而非伪造默认值。

---

## 8. lead 复核修正记录（不采信 worker 自报分级）

| 来源 | worker 自报 | lead 终审 | 理由 |
|---|---|---|---|
| W3 F-02 `coverage-gate.ts` | P1 | **P0 ↑** | 影响阻断判定，比展示层严重 |
| W3 F-03 `dependency-scanner.ts` | P2 | **P1 ↑** | 「无法判定 → passed」违反诚实降级红线 |
| W3 F-07 首次失败 PR 写 ✅ | P0 | **P1 ↓** | `COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD=2`，首次给修复机会是明文设计，第 2 次阻断；仅展示层缺证据 |
| W3 F-08 伪造四维全失败报告 | P0 | **P2 ↓** | `buildEmptyCoverageReport()` 是 `passed:false` 诚实失败，真实 `blockedReason` 独立字段未丢，属口径污染非掩盖 |
| W4 J-04 `smoke-test-runner.ts` | P0 | **P1 ↓** | 空集合通过是明文设计取舍；真实缺口是语义共用 |
| W4 J-05 `gate-orchestrator.ts` | P0 | **P1 ↓ + 改定性** | 默认 fail-open 但有 `skippedGates` 披露，非「静默少跑门禁报全绿」 |
| W5 P1-3 `confirm_previous` | ⚠️ 疑似 | **❌ 链路级确证（逐文件档位不变）** | W6 F-1 补齐消费方零门禁（`session.ts:5686`）+ 3 类快照写入方证据，W5 据此确证 4 条旁路；**保留「主链 `execute_command` → `notifyFailedGoalBlocked` 带真实诊断 → 修复有效」限定**。W5 另更正宿主定位：CLI `App.tsx:1344-1345` 是**自动注入构造点**、不是 `confirm_previous` 消费方；Web `session-pool.ts:1440` 无「执行这个」确认处理逻辑，实际走 core 已修通道。该缺口是跨文件契约缺口，故不折算进任一单文件档位 |
| W5 vs W6 冲突 | W5 称「逃生门裸重放」 | **已澄清，非问题** | `confirm_previous`(`:113-120`) 是 LLM 决策 schema、`previousSuggestion`(`:185`) 是指代确认上下文，**不是重放数据来源**；真正载体是 `session.ts:1914` `lastEagDisplayedSuggestions` |
| W6 D-P1-2 Web 侧 | 「Web 裸重放」 | **改定性为「拦截提示泛化模板」** | `session-pool.ts` 全文件无 confirm 处理逻辑，「执行这个」只在提示文案里，实际走 core 已修 `confirm_previous`；主逃生门已闭环 |
| W6 G-02 异常路径 abortReason | P2 | **P1 ↑（并入 P1-2）** | 经 W1 I-05 跨层因果链确认，它是异常终态下逃生门必然裸重放的成因，非局部瑕疵 |
| W1「p5 无 P0」 | 无限定 | **限定为「正常终态路径下」** | 异常终态、知情重试两条通道仍缺诊断 |
| **lead 自身假设** | 「graph → team-adapter 委托路径绕开护栏」 | **证伪** | `node-executor.ts` 引入的是 `team/plugins/goal-dispatcher.js`，`assembly.ts:427-434` 装配 6 个插件未注入 runner，`goal-dispatcher.ts:666` 终点是 `plugin.execute(ctx)`，无 `executeDispatch/runner/maxToolRounds` 调用。真正残留在 graph/plugin 自建循环与 fork 分支 |
| W6 F-3 自检 | 「`App.tsx` 注释过期」 | **更正** | `App.tsx:1282-1348` finally 兜底块确实存在，`:1315/:1320/:1329/:1345` 与四层描述逐条对应，头注释未过期；准确事实是 `packages/cli` 全目录不调用 `buildAutoExecuteCommand` |
| W6 E-3 行号 | `decideBeforeIteration :8839` | **更正 :8851** | 实测 `:8839` 是 `getOrCreateTurnGuard`，`:8851` 才是 `decideBeforeIteration` |

---

## 9. 跨层因果链（最值得优先理解的一条）

```
session.ts:7914  handler.execute() 抛异常 → recordAutonomousRunOutcome(..., {}) 传空 details
   ↓ abortReason 落盘为空
autonomous-orchestrator.ts:3737/:3741-3746  blockageReport.summary 退化为「连续失败 N 次触发 abort」泛化模板
   ↓ （AutonomousRunRequest:267 无 failureContext 入参，p5 侧无法补回）
session.ts:1553-1556  buildGoalBlockedDiagnostics 返回空诊断段 → failureContext = undefined
   ↓ 两条记忆通道同时为空：
     ① failureContext 不追加进 --goal
     ② plan-stage-handler.ts:180-249 loadPreviousRunContext 读不到 abortReason（且 :249 slice(0,1500) head-only）
   ↓
逃生门「执行这个」→ buildAutoExecuteCommand(hint, goal, undefined) → 逐字零回归裸重放
   ↓
新一轮 run 逐字重演同一失败（事故 T-068 链路复现）
```

`confirm_previous` 消费方（`:5686`）零门禁 + 3 类快照写入方（`:5515-5518` / `:5640` 裸快照、`:5959-5963` 带诊断快照）+ 知情重试（`:5601`）+ Web 拦截提示，共同构成 **4 条旁路**。**主链 D2 硬拦截 → 带真实诊断快照 → `confirm_previous` 消费已闭环**，本报告的结论是「旁路仍需收口」，不是「修复无效」。

---

## 10. 未覆盖边界与诚实声明

- **全过程只读**：未修改仓库内任何生产代码，未执行 git 写操作；本次仅新增 2 份文档（本报告 + 逐文件索引）。
- **未做真机复现**：未运行 EAG 自主循环复现上述 P0/P1 的运行时后果；结论基于源码精读与既有测试覆盖矩阵。
- **大文件覆盖方式**：全文件模式扫描 + 关键区段逐段 Read；未逐行读完的部分**不作为 ✅ 的依据**，✅ 证据列均为实际读到的行号。
- **仍缺运行时/装配证据的 ⚠️ 项**：Web「执行这个」最终落点是否二次拦截；graph `GoalDispatcher` 插件 `plugin.execute` 内部是否含 LLM 工具轮次循环；design 反馈闭环调用方全覆盖；`sedimentation` transcript 传入顺序；icp pack 规则 filter 后是否恒非空；rollback 降级值是否被上层当成功；6 处后台 LLM 无 AbortSignal 是否实际导致无法中断。
- **测试覆盖矩阵**：209 个相关测试文件仅做 import/内容映射抽查，未逐一执行；W6 C.3 列出 11 个高风险生产文件「零测试 import 且零内容提及」。
- **扫描误报**：`/tmp/dcx-eag-scan.json` 的 C1~C12 命中经回读确认有大量注释/import/常量/fixture 字符串误报，已在对应行注明并剔除。
- **未实施任何修复**：本报告只给分级清单与最小修复建议，等待用户明确授权后再另开实现任务。

---

## 11. 建议修复顺序（本次未实施）

1. **P0-1/2/3**（long-horizon 状态重放 + graph fork + resume）：三者同属「执行状态与失败反馈跨轮丢失」，建议一并改并补一次真实 resume 事件序列回归。
2. **P0-4/5**（testing 证据链 + 覆盖率门禁）：把 stderr/用例名/AssertionError 透传到 G-7 与 PR，同时禁止 PKC 失败 → 100%。
3. **P0-6/7/8**（部署/回滚/监控诚实性）：去掉 `?? true`、修 `0/0` 判据、缺失配置返回 failed；对齐 G-1~G-7 已有的诚实语义。
4. **P1-1/2/3/4**（跨层逃生门与 context-budget）：消费方门禁 + 异常终态 `abortReason` + 第 1/2/3 级保尾摘要，补「suggest_* 快照 + 存在失败 run → 重放须含约束」回归。
5. **P1-5**（p5 基线拆分贯通）：按 §5.2 的「可拆分才用新增清单、否则回退全量」条件实现，避免退化为「无失败用例的反馈」。
6. P1 其余与 P2 按模块分批，优先复用 §7.2 的仓内正确实现模板。

---

## 附录

| 文件 | 说明 |
|---|---|
| `eag-full-review-file-index-20261108.md` | **264 个逐文件结论索引**（按路径排序，含行号证据、严重级、建议）——「逐一文件逐一验证」的主证据 |
| `eag-review-20261108/W1-p5.md` | W1：p5 核心链路 26 文件逐文件表 + Top 发现 + 跨层边界补充 |
| `eag-review-20261108/W2-loops.md` | W2：loop/graph/long-horizon 31 文件 + 循环护栏覆盖矩阵 + Q1~Q4 路径核实 |
| `eag-review-20261108/W3-coding-testing.md` | W3：coding/testing 55 文件 + 独立 LLM/工具循环清单 |
| `eag-review-20261108/W4-gates-deploy.md` | W4：45 文件 + **门禁诚实性矩阵**（信息不足时返回什么） |
| `eag-review-20261108/W5-misc.md` | W5：其余 94 文件 + 已修复/正确实现对照 + 审查限制声明 |
| `eag-review-20261108/W6-boundary.md` | W6：12 文件 + 跨层字段契约矩阵 + 测试覆盖矩阵 + E/F 节补充复核 |
| `eag-review-20261108/LEAD-verification.md` | lead 独立复核笔记（F-01~F-08 / G-01~G-05 / H-01~H-03 / I-01~I-06 / J-01~J-06） |
| `eag-review-20261108/pattern-scan.json` / `pattern-scan.py` | 12 类模式扫描全量结果与可复跑脚本 |
| `eag-p5-bash-no-progress-all-fixes-20261108.md` | 本轮事故修复报告（`892938aa`） |

> 归档说明：6 组报告与复核笔记最初生成于 `/tmp`，为避免会话结束被清理，已按最终版复制进仓库本目录。归档后 lead 按**结论列**精确复核四档计数：6 组原始表格合计 `✅83 / ⚠️46 / ❌26 / ➖108 = 263`，加 lead 补查的 `p5/index.ts`（`➖`）即索引的 `83/46/26/109 = 264`，完全一致。
