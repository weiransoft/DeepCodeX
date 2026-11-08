# lead 独立复核笔记（不采信 worker 自报分级，逐条读源码确认）

## W3（coding + testing，55 文件）复核结果

### ✅ 确证，维持或提升分级

**F-01 测试执行边界失败证据整体消失 —— P0（维持）**
`eag/testing/testing-orchestrator.ts`
- `:1012` `let stderr = "";`、`:1017-1019` `child.stderr?.on("data", ...)` 收集 stderr；
- `:1039-1067` 解析只做 `JSON.parse(stdout)`，且 `const report = JSON.parse(stdout) as { tests?: Array<{ status?: string }> }` —— **只取 `status`，丢弃 `name` 与失败详情**；
- `:1069-1075` resolve 对象仅 `{ filePath, exitCode, durationMs, failedCount, passedCount }`，**无 stderr / 用例名 / AssertionError**；
- 全文 `stderr` 仅出现在 `:937`、`:977` 注释与 `:1012`、`:1018` 赋值，再无消费点。
结论：与本轮「工具输出丢尾部失败证据 / 报告无真实证据」直接同族，且发生在另一个 EAG 子系统。**确证 P0。**

**F-02 PKC 查询失败吞错 → 高风险符号覆盖率恒 100 → 门禁可误通过 —— P0（worker 报 P1，lead 提升）**
`eag/testing/coverage-gate.ts`
- `:298-304` `try { riskHotspots = await this.pkcAccessor.queryRiskHotspots(...) } catch (e) { this.log(..., "warn"); }` —— 失败后 `riskHotspots` 保持 `[]`，不降级为 unknown、不阻断；
- `:310` `calculateHighRiskSymbolsCoverage(riskHotspots, ...)`；
- `:506-512` `if (riskHotspots.length === 0) { return 100; }` —— 空数组被解释为「无必测约束，覆盖率 100%」；
- `:313` `evaluateThreshold(parsedReport, highRiskSymbolsCoverage)` 据此判定该维度达标。
结论：这是「catch 吞错后把真失败说成通过」的直接同族，且影响阻断判定，比展示层问题更严重。**提升 P0。**

**F-03 无法解析的 package.json 被当作「无漏洞」通过 —— P1（worker 报 P2，lead 提升）**
`eag/coding/static-checkers/dependency-scanner.ts`
- `:320-324` `try { pkg = JSON.parse(artifact.content); } catch { continue; }` —— 解析失败静默跳过该文件；
- `:359-362` `if (violations.length > 0) return buildViolations(...); return buildPass(redline.id);`
- 若**所有** package.json 都解析失败，`violations` 为空 → `buildPass()`，即「无法判定」被报成「通过」。
结论：同属「诚实降级」红线（无法判定应 unknown/failed，不应 passed）。**提升 P1。**

**F-04 LoopGuard token 记账恒 0 —— P1（维持）**
`eag/testing/testing-orchestrator.ts`
- `:339-340` `const totalLlmCallCount = 0; const totalTokensUsed = 0;`（const，全文不可能自增）；
- `:781` `request.loopGuard.recordIteration(totalTokensUsed, true);`
- `:1422` `request.loopGuard.recordIteration(totalTokensUsed, false);`
结论：token 预算护栏在该 Loop 永不生效，属「护栏只覆盖部分执行路径」同族。**确证 P1。**

**F-05 `pkcQueryRiskHotspotsSafe()` 恒返回空 —— P1（维持）**
- `:1377-1387` try 分支 `:1383 return []`，注释自认「此处直接返回空数组」；catch `:1385 return []`。
结论：高风险符号上下文恒空，判定器空转通过。**确证 P1。**

**F-06 STRICT 连续失败熔断不可达 —— P2（维持）**
`eag/coding/strict-evaluator.ts`
- `:81` `const DEFAULT_CONSECUTIVE_FAILURES = 0 as const;`，`:317` 恒用该值，`:333` 传给 buildReport；
- `:278-281` `evaluate()` 签名不接收该参数；`:78-79` 注释却称「FIX Loop 在重试时累加此值并传入下次评估」，文档与实现不符；
- 跨模块 `eag/evaluator/types.ts:368` `if (maxConsecutiveFailures >= failureThreshold) return "stop_failure";` 因此不可达。
结论：**确证 P2**（熔断失效，但 FixLoop 另有 `:185-206` 连续 2 轮同红线违规兜底，非完全裸奔）。

### ⚠️ 经复核需要修正（worker 定性过重）

**F-07 「首次失败恒 passed=true，PR 写 ✅ 通过」—— 降为 P1（展示层缺证据），不是 P0**
- `coverage-gate.ts:323-325` `failureOrdinal = request.consecutiveFailureCount + 1; isBlocker = failureOrdinal >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD; passed = failedDimensions.length === 0 || !isBlocker;`
- `testing/types.ts:729` `COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD = 2`；
- `testing-orchestrator.ts:640-641` 调用方**确实自增并跨轮保有** `coverageConsecutiveFailureCount`，`:648` 达阈值走 BLOCKER，`:671-672` 成功时清零。
→ 「首次失败给一次修复机会（WARNING, passed=true）」是**明文设计取舍**，且第 2 次会阻断；不是「把真失败说成通过」。
- 但 `testing-orchestrator.ts:1216-1219` PR 头部只写覆盖率数值 + `coverageReport.passed ? "✅ 通过" : "❌ 未通过"`，**未列出 `failedDimensions`** —— WARNING 阶段读者看不到哪些维度未达标。
→ 属「报告不写真实证据」同族，但仅展示层。**P1。**

**F-08 「伪造四维全失败报告掩盖真实阻塞原因」—— 降为 P2（口径污染），不是 P0**
- `testing-orchestrator.ts:1431` 失败路径 `coverageReport: partialResults?.coverageReport ?? this.buildEmptyCoverageReport()`；
- `:1482-1498` `buildEmptyCoverageReport()` 返回 `lines/branches/functions/highRiskSymbols = 0`、`failedDimensions` 四维全列、但 **`passed: false`**（诚实失败）；
- 真实阻塞原因另有独立字段 `blockedReason`（`:1433`），**没有丢失**。
→ 不是「掩盖真实原因」，而是「无覆盖率数据时塞一份假的 0% 报告」，会让读者误判为覆盖率不达标。属统计口径污染。**P2。**

### 其它
- W3 的「6 处 LLM 调用自建 messages + 无 AbortSignal」经其自述为 ⚠️ 待护栏侧确认；主 chat 是否全局拦截这些后台调用，由 W6 跨层组结论决定，不在本笔记定级。
- W3 逐文件表格 55 行，已抽查前 30 行，每行均有职责/结论/行号/建议，格式符合「逐一文件」要求。

## lead 补充线索（已发给 W2 / W6，待其结论）
1. `context-budget.ts` 第 1 级 `:338`、第 2 级 `:359`、第 3 级 `:378` 仍整条替换 tool 结果为占位；默认 `protectedRecentTools = 4`（`:65`）、`toolResultsBudgetChars = 100_000`（`:63`）。第 0 级只保「单条内部」尾部证据，未保「旧 tool 整条不丢」。→ 待 W6 判定是否同类残留。
2. EAG → team/ 耦合：`assembly.ts:55-56`、`graph/node-executor.ts:56-59`（用 `GoalDispatcher`，非 team-adapter dispatch runner）、`plan-stage-handler.ts:41-47`；`team-adapter.ts:876-891` 委托宿主执行器且注释称复用主对话护栏（含「护栏」），`maxToolRounds` 默认 8（`:191`）。→ 待 W2 核实 graph 委托路径是否有无进展判定。
3. `session.ts:4667` 注释称主循环已移除 TurnGuard 轮数上限，但 `:4691` 仍有 `toolCallCount() > options.maxToolRounds`；`:8839` 判定 / `:9309` recordTurn。→ 待 W6 核实两套上限关系与分支覆盖。

---

## W6（跨层边界 + 测试覆盖）复核结果

### ✅ 确证

**G-01 知情重试是第三条不带失败状态的通道 —— P1（维持，但需修正定性）**
- `session.ts:5585` `if (commandHint.startsWith("/eag-autonomous") && suggestion.acknowledgeFailedGoal !== true)` —— 为 true 时跳过 D2 守卫；
- `:5601` `this.buildAutoExecuteCommand(commandHint, goal)` **只传两参**，无 failureContext。
- 但 `eag-suggestion-prompt.ts:109` 明令「拦截后应输出 confirm_previous，禁止输出 execute_command 或 acknowledgeFailedGoal」，故**默认逃生门走已修的 confirm_previous 通道**，本路径仅在用户明确「知情重试」时触发。不是「逃生门裸重放」，是「第三条重放通道遗漏诊断」。
- 真实契约冲突：`session-eag-goal-failure-guard.test.ts:411-412` N5 断言 `runRequests[1].objective === goal`，**间接锁死**「不可把约束拼进 goal」；修复须另开独立通道，不能简单追加第三参。
- `suggestion-auto.ts:277` failureContext 为可选，无第三参时逐字零回归（N11 oracle 守护），故不传即裸重放。

**G-02 异常路径 abortReason 丢失 —— P2（维持）**
- `session.ts:7906-7914` `handler.execute()` 抛异常时 `:7910` 已取得真实 `errMsg`，但 `:7914` `recordAutonomousRunOutcome(..., {})` 传空 details；`:7919` failReason 才用到 errMsg。
- 注释 `:7912-7913` 称「绝不从异常文本猜测」——但 errMsg 是真实错误非猜测，属诚实降级过度。

**G-03 `truncateToolOutput` 极小/非法预算仍是 head-only —— P2（本轮修复自身残留，必须如实报告）**
- `context-budget.ts:128-135` `if (!Number.isFinite(maxChars) || maxChars < TRUNCATE_SAFE_MIN_CHARS)` 时 `:132` `head = content.slice(0, Math.max(0, cap - marker.length))`，无尾部保留。默认 4000 不触发，配置较小或非法时触发。
- 第 1 级 `:338`、第 2 级 `:359`、第 3 级 `:378` 仍把保护窗外旧 tool 结果**整条**替换成占位；`:300-309` 保护窗仅最近 4 条（默认 `:65`）。第 0 级只保「单条内部」尾部证据，未保「整条不丢」。→ 确认 lead 提出的线索成立。

**G-04 Web 宿主拦截提示仍是泛化模板 —— P1（维持展示层，修正 W6 的「Web 裸重放」定性）**
- `packages/web/src/session-pool.ts:1433-1450` 命中失败守卫后推 `:1440` **固定泛化文案**，无「上一轮诊断」段；桌面/WebView 用户看到的是这条。
- 「执行这个」在该文件**仅出现在 :1440 提示文案里**，全文件无 confirm 处理逻辑 → 实际走 core 已修 `consumeConfirmPreviousDecision`（`session.ts:5686` 三参）。故 Web 侧**不构成逃生门裸重放**。
- `:1420` `buildAutoExecuteCommand(...)` 两参属「守卫未命中时的自动注入」，守卫命中时 `:1450 return` 已跳过。

**G-05 `eag-graph-command.ts:600` aborted 判 success —— P2（维持，注明是设计取舍）**
- `const success = runReport.finalStatus === "completed" || runReport.finalStatus === "aborted";`，注释「用户中止也算执行完成」；与 `session.ts:5908` `finalStatus !== "completed"` 判失败口径相反。属跨模块口径不一致。

### ⚠️ W5 与 W6 的结论冲突已解决（重要）

W5 报「`eag-dynamic-suggester.ts` 的 `confirm_previous` 只含 messageToUser/reasoning、previousSuggestion 快照仅 `{commandHint,goal}`，导致逃生门裸重放」——**误判**：
- `eag-dynamic-suggester.ts:113-120` 的 `confirm_previous` 是 **LLM 决策输出的 schema**，只需表达「确认」；
- `:185` `previousSuggestion?: Readonly<{commandHint, goal}>` 是**传给触发层 LLM 的上下文**（`eag-suggestion-prompt.ts:76-78` 拼成「上一条展示过的建议快照」），用途是「指代确认识别依据」，**不是重放命令的数据来源**；
- 真正的重放数据载体是 `session.ts:1914` `lastEagDisplayedSuggestions`（类型 `:1407` 含 `failureContext`），`:5959-5963` 写入拦截快照时带 failureContext，`:5686` 三参消费。
→ 逃生门主通道**已闭环**，W5 该项应标「已澄清，非问题」。
→ 仅保留一个 P2 观察：触发层 LLM 的 `previousSuggestion` / `autonomousGoalRuns`（`:187-191` 只含 goal/finalStatus/endedAt）**看不到上一轮失败诊断**，判断「是否知情重试」时信息不足。

## W5（其余 94 文件）复核结果

**H-01 `icp/evidence-collector.ts` head-only 丢 stderr —— P1（维持，可论证 P0）**
- `:114` `mergedOutput = stdout 在前 + stderr 在后`；`:118` `lines.slice(0, 1000)`；`:123` 明写「仅显示前 1000 行」。
- stdout 超长时真实失败错误（stderr）整段被截掉，`ComplianceEvidence.content`(`:128`) 只剩 stdout 头部，G-7 合规门禁基于残缺证据判定。与 `assembly.ts:384 .slice(-2000)` 保尾做法相反。
→ **直接同族**（工具输出 head-only 丢尾部失败证据）。

**H-02 `tcs/object-storage.ts` delete 谎报成功 —— P1（维持，可论证 P0）**
- S3 `:767` `const existing = await this.get(key).catch(() => null);` 吞掉网络/认证/权限/超时任意异常；`:768-770` `if (existing === null) return { key, deletedAt, permanent: true };` 注释「文件不存在视为已永久删除」——**读失败被当成对象不存在，谎报删除成功，且删除流程根本没执行**。
- OSS `:1145-1147` 同款。
→ **直接同族**（catch 吞错把真失败说成通过）。

**H-03 其余 P2**：evidence-bundle / report-render 证据 head-only 与泛化空态模板、compliance-engine `every([])→overallPassed=true`、sedimentation 丢最近对话、pkc 系列 catch 静默跳过 + 无标注截断、intervention-ledger 白名单静默丢弃验证结论 —— 均为同族低危残留，逐条保留在报告 P2 清单。

**W5 的正面证据值得采纳**：`tcs/ldap-adapter.ts:385-391`（batchSize 夹 1）+ `:443-495`（while(true) 双退出条件：batch.length 为空 + nextOffset<=offset 游标前进）是「循环硬上限 + 无进展判定」的**已正确实现范例**；`assembly.ts:384` 保尾 stderr、`:236-245` 重试带上轮 feedback、catch fail-closed 是本组正确实现对照。

---

## W1（p5 核心 26 文件）复核结果 —— 本轮修复的真实残留

**I-01 基线红灯拆分未被 dev/fix 反馈链路消费 —— P1 确证（本轮最重要发现）**
- `verify-stage-handler.ts:472-483` 已把失败拆成 `baselineMatched` / `newFailed`，`:518-520` 写出 `newFailedTestIds` / `baselineFailedTestIds` / `baselineAvailable`，`:494-499` summary 如实写「N 个基线失败 + M 个新增失败」且明写「基线红灯仍失败，本阶段判定 failed」——**拆分本身正确**。
- 但 `autonomous-orchestrator.ts:1197-1199` `if (stage === "verify" && result.kind !== "success" && ... ) carriedFailureFeedback = this.buildVerifyFailureFeedback(result);` **无条件执行，含 `baselineOnly===true` 的轮**；`:1226-1239` 的 baselineOnly 处理只管 `loopVerdict.findings`、失败指纹、连续失败累计，**不清理 carriedFailureFeedback**。
- `buildVerifyFailureFeedback()` `:3051` 读的是 `result.artifacts["failedTestIds"]`（`:513` 原始全量清单），`:3061` 写进「失败用例：…」；`:3054` 另带 `testOutputTail`。→ 下一轮 dev 收到「请在现有改动基础上继续修」+ 含基线红灯的全量用例清单。
- `fix-stage-handler.ts:289` 更彻底：从 `outputSummary`（原始输出尾部）用 `extractFailedTestIds()` **重新提取**，天然不区分基线/新增；`:308` 写入 fixSuggestion，`:681-685` 让 fix「优先定位并复跑这些用例」。
- 结论：基线隔离只作用于「是否 abort / 是否累计连续失败」，**未作用于「喂给 dev/fix 的修复指令」**。与本次事故「基线红灯被算成本任务失败」同族，是同一根因在另一条消费链上的残留。

**修复方案的关键约束（W1 建议不完整，lead 补充）**：
- 不能简单把 `:3051` 改成读 `newFailedTestIds`：`verify-stage-handler.ts:490` `canSplit = baselineAvailable && failedTests.ids.length > 0`；当基线探测降级（`baselineAvailable=false`）或本轮提取不到用例标识时，`newFailed` 为空、`:518` 写出的也是空数组。直接替换会变成「测试失败但反馈里没有任何失败用例」，比现状更糟。
- 正确条件：`baselineAvailable === true && canSplit` 时用 `newFailedTestIds`；否则**回退全量** `failedTestIds`（诚实降级：不排除任何失败）。`baselineOnly===true` 时还应跳过整条 carriedFailureFeedback 搬运，或明确标注「本轮无新增失败，无需修改代码」。
- `fix-stage-handler.ts` 需要 ctx 把 `newFailedTestIds` / `baselineAvailable` 传进来，不能只靠重新解析输出。
- **顶层 `failedTestIds` 不该改**：`:1250` 注释已明确「不区分基线/新增，透传的是『哪些用例失败了』这一客观事实，非归因结论」，供触发层逃生门展示用，设计正确。要区分的是「给 dev/fix 的修复指令」与「给用户看的客观失败清单」两种用途，不可混为一谈。

**I-02 `plan-stage-handler.ts:249` head-only —— P2 确证（低危）**
- `text.length > PREVIOUS_RUN_CONTEXT_MAX_CHARS ? text.slice(0, PREVIOUS_RUN_CONTEXT_MAX_CHARS) : text`，丢尾部；但截断对象是「上一轮 run 摘要 + 建议文本」，不是工具输出/失败证据，影响有限。

**I-03 `env-boundary-guard.ts` 凭据扫描 8192 head-only fail-open —— P2 确证（行号修正）**
- W1 报 `:208`，经 Grep 实际为 `:424` `const MAX_ENV_VALUE_SCAN_CHARS = 8192`、`:823` `varValue.length > MAX_ENV_VALUE_SCAN_CHARS ? varValue.slice(0, MAX_ENV_VALUE_SCAN_CHARS) : varValue`。超过 8192 字符的环境变量值尾部不参与凭据扫描 → 可被绕过。触发条件苛刻但属安全相关 head-only 残留。

**I-04 本轮修复的正面闭环（W1 独立复核，采纳）**
- `llm-task-executor.ts:1424-1436` 双轨清零与计数、`:1742-1751` 全 deny 豁免 + `trackBAvailable`、`:1820-1835` 亲自写验证用例的 lead 注释、`:1289/:1382/:1535` 三处折叠有界衰减、`:1978-2009` 元数据剥离 —— 确证无残留。
- `baseline-guard.ts:78-80 / 82-94 / 96-101 / 107-120 / 127-130` 六类诚实降级、`:108-110` parser/total 判据、`:115-120` 提取不到用例标识即降级 —— 确证。
- `session.ts:477-488/12212-12218/1407/1532-1576/5686/5880-5885` + `suggestion-auto.ts:265-290` 三层逃生门链路闭环 —— 与 W6 结论一致（W6 报的 `:5585/:5601` 是**第三条知情重试通道**，不否定主通道闭环）。
- 三处轻微文档/契约小瑕疵（W1 的 P2）：`baseline-guard.ts:72` 注释含 `shell:false` 导致命令行 `grep -F "shell:false"` 可匹配；`types.ts:106` `baselineDirtyPaths?` 未被读取（死字段，实际走 stage context）；`verify-stage-handler.ts:513` 「fix 阶段据此优先定位」注释未提新增拆分字段。

**I-05 跨层因果链（W1 B-2 补充，lead 核实并升级定性）**
- `autonomous-orchestrator.ts:267` `AutonomousRunRequest` 全文 Grep `failureContext` **零命中** → 编排层无该入参，p5 侧无法从 session 的逃生门快照补回失败原因。
- `generateBlockageReport()` `:3737` `let terminationReason = args.abortReason;`，`:3741-3746` summary = abortReason 原文；为空时退化为 `连续失败 N 次触发 abort` 泛化模板。
- 真实基线证据在 `rootCauseHypotheses`（`:3651-3659`，来自 run 起始真实探测），而 `failedTestIds` 是 `:1722` 顶层独立字段（`:387-388` 已解耦）。
- 跨 run 失败记忆的**唯一**来源是 `plan-stage-handler.ts:180` `loadPreviousRunContext()` 读 `.eag/p5/run-state/*.jsonl` 末行快照的 `abortReason`（`:199-200`），且 `:249` 有 `slice(0, 1500)` head-only 截断。
- ⇒ 完整因果链：`session.ts:7914` 异常路径传 `{}` → `abortReason` 落盘为空 → `blockageReport.summary` 退化为泛化模板 → `buildGoalBlockedDiagnostics`(:1537) 拿不到 reason → `failureContext` 为 undefined → 逃生门裸重放；**且 p5 侧无入参可补回**。
- ⇒ 因此 W6 的「异常路径 abortReason 丢失」不应只算 P2 局部瑕疵，它是**异常终态下逃生门必然裸重放**的成因，应 **提升 P1** 并与 `session.ts:5585/:5601` 知情重试通道合并为「第三条/第四条重放通道缺失诊断」的一组问题。
- ⇒ W1 的「p5 无 P0」结论应限定为「**正常终态路径下**报告已用真实基线探测替换泛化模板」，不能推广到异常终态与知情重试通道。

**I-06 测试桩过期（W1 B-1 与 W6 C 节一致，lead 采纳）**
*(见下方原文，本节未改动)*

---

## W4（gate / devops / deploy / doc-driven / design，45 文件）复核结果

**J-01 `devops-orchestrator.ts:278-279` 监控/回滚预案恒真 —— P0 确证**
- `monitoringReady: context.monitoringReady ?? true` / `rollbackPlanExists: context.rollbackPlanExists ?? true`，注释自称「默认 true，批次 14 实现完整检查」，但完整检查器存在却被默认路径绕过；与 `gate-g8-checker.ts:148-162`、`rollback-plan-checker.ts:48-50` 注释互证。

**J-02 `rollback-manager.ts` JSON 解析失败 → 回滚验证成功 —— P0 确证**
- `:825-827` `catch { return { availableReplicas: 0, expectedReplicas: 0 }; }`；
- `:504` 消费该返回值 → `:508` `if (availableReplicas >= expectedReplicas)` 即 `0 >= 0` 为真 → `:510-515` `success: true`，message 明写「回滚验证成功：0/0 副本可用」。
- catch 吞错 + 空值自比较导致谎报成功，且发生在回滚验证（安全关键路径）。**确证 P0。**

**J-03 `monitoring-readiness-checker.ts:546-553` 无法判定即通过 —— P0/P1 确证**
- 注释「K-4 决策简化：prometheusConfigPath 未提供时视为通过」，`passed: true` + detail 说明跳过校验。属「信息不足 → passed」直接同族。

**J-04 `smoke-test-runner.ts` 空集合 passed=true —— 确证，但定性修正为「明文设计 + 上游降级叠加」**
- `:113-114` 注释明写「endpoints/testCases 为空 → totalTests=0 → passed=true」，`:171-173` `const passed = failedTests === 0;` 并注释「空集合视为通过」——**是有意设计，不是隐蔽 bug**。
- 但 `deploy-stage.ts:386` `healthyEndpoints = healthEndpoints.filter(e => e.healthy).map(...)`；健康检查无可用端点时得到空数组 → `:389` `run([], testCases)` → `passed=true` → `:390` 不触发回滚 → 部署判成功。
- ⇒ 真实缺口是「**烟雾测试一条都没跑**」与「**跑完零失败**」共用同一个 `passed=true`，上游无法区分。建议 `totalTests===0` 时返回 `passed=false, reason="no-test-executed"` 或独立状态。判 **P1**（不采纳 W4 的 P0，但注明部署链路后果重）。

**J-05 `gate-orchestrator.ts` —— 定性修正：不是「静默少跑门禁报全绿」，是「默认 fail-open 但有披露」**
- W4 引 `:270-281`：`if (!LOOP_GATE_STRATEGY[loopType])` 返回 `results:[] / allPassed:true / skippedGates:[]`。该分支语义是「此 loopType 不启用任何门禁」，返回 allPassed:true **合理**，不算缺陷。
- `:286-295` 2026-11-01 已修：no-checker 记入 `skippedGates` **披露**（注释明写此前 `continue` 静默跳过、allPassed 仍 true 是缺陷）；`:330-334` `coverageGap = this.strictGateCoverage && missingCheckerGates.length > 0; allPassed = firstFailedGate === null && !coverageGap;`
- `:221` `this.strictGateCoverage = options?.strictGateCoverage === true;` → **默认 false**，即缺检查器时默认只披露、不阻断；显式开启才 fail-closed。
- `:311-318` missing-context（G-6/G-7 普通 GateContext）也只披露、不计入未通过（`:331` 注释称「既定向后兼容语义」）。
- ⇒ 准确定性：**默认 `strictGateCoverage=false` 时，门禁覆盖缺口不阻断**，与本轮「开关默认关、诚实降级」模式一致，但此处的「降级」是少跑门禁仍可 allPassed。判 **P1**，并注明「有 skippedGates 披露，非完全静默」。W4 的 P0 定性过重。

**J-06 其它（W4 P1/P2，lead 采纳但需注明设计取舍）**
- `devops-orchestrator.ts:306-311` G-8 失败仍发 `devops-completed` 事件，`:283-285` 只 push errors、`success` 字段反映失败 → 事件名误导，P1。
- `design-orchestrator.ts:137-174` `while(true)` 每轮相同 3 参重调、注释自认 `verdict.reason` 未传；修复在集成层 `design-roles-llm.ts:780-867` FeedbackAwareArchitect（需经 `eag-orchestrator-assembly.ts` 装配），编排器自身不强制 → W4 标 ⚠️ 合理，**待 W2 确认装配覆盖**。
- `gate-g3-checker.ts:135-141` `actualChanges.length===0` 直接 passed:true，「采集失败致空」与「确认零变更」不分 → P1。
- `blue-green-strategy.ts:384` / `canary-strategy.ts:489` 硬编码 `success=true`、`rolling-strategy.ts:290` `errors.length===0||resources.length>0` 忽略累积 errors，且 `devops-orchestrator.ts:206/208` 仅 `!success` 才消费 errors → 错误被吞，P2。
- W4 的正面参照应写入报告：G-1/G-2/G-4/G-5/G-6/G-7 六个静态门禁在信息不足时**一律 failed**，是本仓最诚实的对照；问题集中在部署/监控/回滚链路与编排层默认放行。

---

**I-06 原文**
- `session-eag-goal-failure-guard.test.ts:666-668` 桩注释称「真实生产编排器目前不透出 failedTestIds」，与 `autonomous-orchestrator.ts:390/:1722` 已透出矛盾；`:703-705` 用 `as unknown as` 手工在 runResult 顶层塞字段，绕过真实汇总。
- 该组测试验证的是 session 消费侧，生产透传由 `eag-p5-baseline-guard.test.ts` B7a/B8a 用真实 handler+真实 orchestrator.run() 覆盖，故**不算假通过**，但注释与桩需修正；且缺少「session 写侧 → orchestrator 真实汇总」的端到端单测（W6 亦指出 B7a 未走到 handleUserPrompt）。
