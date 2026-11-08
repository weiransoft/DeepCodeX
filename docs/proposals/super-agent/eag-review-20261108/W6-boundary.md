# DCX EAG 跨层边界 + 测试覆盖矩阵 只读审查报告（W6）

- 审查员：`review-boundary`（只读，未修改任何仓库文件，未执行 git/构建/写工作区命令）
- 仓库根：`/Users/wangwei/Documents/VG/DeepCodeX-cli`
- 方法：`Read` 全文精读中等文件 + `Grep`/检索定位 `session.ts` EAG 段落 + `/tmp/dcx_coverage.py`、`/tmp/dcx_coverage2.py` 两份只读统计脚本（文件名匹配 + 测试 import 内容匹配双口径）
- 事故同型基线：verify 把 run 起始既有基线红灯算作任务失败 → 两轮失败指纹一致 → 确定性失败熔断 abort → 阻塞报告只给泛化模板 → 「执行这个」逃生门裸重放（不带失败原因）→ dev 连续多轮 ls/pwd/find（输出各异但工作区不变）40 轮无熔断
- 本轮已修复且**不重复报**的项（已复核确为闭环）：`AutonomousRunResult.failedTestIds` 顶层字段（`autonomous-orchestrator.ts:390` 定义 / `:1722` 写入）、`normalizeAutonomousGoalRuns()` 逐字段保留 5 个诊断字段（`session.ts:12212-12218`）、`truncateToolOutput()` 头部+失败窗口+尾部（`:119-189`）、`consumeConfirmPreviousDecision()` 快照带 `failureContext`（`:5686`）、turnGuard 三类护栏不覆盖 P5 子执行器（`session.ts:8839/9309/9329` 只在主 chat）

---

## A. 逐文件表格

> 结论四选一：`✅ 未发现同类问题` / `⚠️ 疑似需复核` / `❌ 确证问题` / `➖ 不适用`。证据均为源码行号，未标注「已修复」的均为**仍存在**的观察。

| # | 文件（相对路径） | 行数 | 职责 | 结论 | 证据（行号:代码片段） | 严重级 | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | `packages/core/src/session.ts` | 12329 | 主 chat 会话循环 / EAG 命令分发 / 跨 run 失败守卫 / 逃生门 / 终态落盘 | ❌ 确证问题 | `:5585` `if (... && suggestion.acknowledgeFailedGoal !== true)` → `:5601` `this.buildAutoExecuteCommand(commandHint, goal)`（知情重试只传两参，不带 `failureContext`）；`:7906-7914` catch 里 `errMsg` 已得但 `recordAutonomousRunOutcome(..., {})` 传空 details；`:7914` 与 `:5842-5843`「异常兜底取 errorMessage」注释矛盾 | P1 | 知情重试放行前取 `findFailedAutonomousRun` 诊断并传第三参；异常路径把 `errMsg` 作 `abortReason`（或显式文档化该降级后果）；同步改 `N5` 断言 |
| 2 | `packages/core/src/context-budget.ts` | 610 | 四级确定性上下文压缩 + 预算续跑状态机 | ❌ 确证问题 | `:285-293` 第 0 级仅保证「单条 tool 内部」head+失败窗口+tail（本轮已修复，不重复报）；**第 1/2/3 级仍整条丢证据**：`:338` 第 1 级、`:359` 第 2 级、`:369-378` 第 3 级把 tool 结果整条替换为 `droppedNote`（`:296-297` 仅字符数说明、无任何内容）；保护窗 `:299-309` 只保最近 `protectedRecentTools`（缺省 4，`:65`）条 tool，`isDroppable` `:319-321` 窗外可丢；触发线 `:345`（总量 > 100000）/`:366`（> 800000）；`:128-135` 极小预算 head-only 退化丢尾部（详见 E-1 / D-P1-3） | P1 | 第 1/2/3 级整条替换前抽取失败摘要/尾部保留；极小预算退化也保尾部；补第 2/3 级与「极小预算+尾部失败证据」测试 |
| 3 | `packages/core/src/eag/suggestion-auto.ts` | 356 | 建议白名单 / 建议命令提取 / `buildAutoExecuteCommand` 纯函数 / 工具轮碎片降级 | ⚠️ 疑似需复核 | `:265-278` 第三参 `failureContext?` 可选、省略时逐字零回归（修复正确）；但零回归设计使**所有不传第三参的宿主调用天然裸重放**：`packages/web/src/session-pool.ts:1420` `buildAutoExecuteCommand(capture.commandWithSlash, capture.goalText)` 两参；`:48` 白名单仅 `eag-autonomous`；`:12-23` 头注释所述 CLI `App.tsx` finally 兜底块经复核**确实存在**（`packages/cli/src/ui/views/App.tsx:1282-1348`，`:1315`/`:1320`/`:1329`/`:1345` 与四层描述逐条对应，头注释**未过期**——更正见 F-3）；但全 `packages/cli` 不调用本文件 `buildAutoExecuteCommand`，EAG 分支 `:1344-1345` 注入裸命令串且不构造 `failureContext`，失败拦截依赖 core 下游 `notifyFailedGoalBlocked`（F-1/F-3） | P2 | 核对全部宿主调用点是否该带失败状态；或把约束类型收紧为必传、由调用方显式传 `undefined` 表达零回归 |
| 4 | `packages/core/src/eag/cli/eag-args.ts` | 75 | `--key value` 共享参数解析（支持转义引号） | ✅ 未发现同类问题 | `:40` 正则双引号分支允许 `\"`；`:58-75` 解析失败不伪造值、返回 `true`(flag)/缺省，由 `:264-268` 等调用方校验抛错 | — | 无需改动 |
| 5 | `packages/core/src/eag/cli/eag-autonomous-command.ts` | 822 | `/eag-autonomous` 参数解析、请求装配、`orchestrator.run()` 调度、Markdown 报告 | ✅ 未发现同类问题 | `:483` `runResult = await this.orchestrator.run(runRequest)` → `:499-504` `return Object.freeze({ success: true, runResult, ... })` **原样透传、无重建丢字段**（关键契约闭环）；`:229-382` 参数非法一律 `throw new Error`（`:266/280/284/299/...`）；`:484-493` 编排抛异常时返回对象无 `runResult`（源头无结果，诚实降级，非丢字段）；次要观察：`:579-648` `formatSuccessReport` 未渲染 `runResult.failedTestIds`，markdown 报告看不到失败用例名 | — | 可在报告中追加失败用例名（非本轮事故链必需） |
| 6 | `packages/core/src/eag/cli/eag-command-parser.ts` | 1751 | EAG 命令前缀识别 / payload 提取 / discriminated union | ✅ 未发现同类问题 | `:474-476` 解析失败时仍返回 `kind:"eag-autonomous"` + `payload:null`，`:1250-1256` `catch { return null }` 是返回 null 而非默认值；`session.ts:7841-7865` 对 `payload=null` 重新解析取错误详情、置 `status:"failed"`、通知用户（未「把失败说成通过」）；`:420/428/586` 未匹配返回 `unknown` | — | 无需改动 |
| 7 | `packages/core/src/eag/cli/eag-design-command.ts` | 138 | `/eag-design` 参数解析（DesignLoopInput） | ✅ 未发现同类问题 | `:91-97` 未知参数抛错、`:99-108` 必填/范式校验抛错、`:133-137` 冻结返回；纯参数解析，不涉及 run 结果成败判定 | — | 无需改动 |
| 8 | `packages/core/src/eag/cli/eag-graph-command.ts` | 924 | `/eag-graph` 参数解析、GraphLifecycleManager 执行、报告 | ⚠️ 疑似需复核 | `:598-600` `const success = runReport.finalStatus === "completed" \|\| "aborted"`（把 `aborted` 算成功，与 `session.ts:5908` `finalStatus !== "completed"` 判失败语义相反）；`:571-575` 走 `GraphLifecycleManager` 独立体系，不经主 chat TurnGuard；`:749-751` 图文件读取失败 `throw`（✓），`:800-817` `?? DEFAULT` 是配置合并非结果判定（✓） | P2 | 统一 `aborted` 终态语义；复核 graph 执行器三类护栏覆盖（graph 目录有自建 `consecutiveFailures`，见 `node-loop-kernel.ts:211/357-359/685`，但未见 TurnGuard 三类） |
| 9 | `packages/core/src/eag/cli/index.ts` | 69 | CLI 模块 barrel | ➖ 不适用 | `:16-69` 全部 `export` / `export type`，无任何运行逻辑、无结果读取/重建 | — | 无需改动 |
| 10 | `packages/core/src/eag/config/eag-config-loader.ts` | 326 | `.deepcode/eag.yml` 配置加载/校验/与 CLI 合并 | ⚠️ 疑似需复核 | `:126-146` `load()` 失败返回 `{}`、`:244-324` 校验失败 `console.error` + 用默认值（`:22-24` 设计如此，非 run 结果判定）；**全仓 `packages/` 检索 `EagConfigLoader` 仅命中自身与 `eag-config-loader.test.ts`，无生产接线** → 配置对 `/eag-autonomous` 实际不生效；`:216-223` `Number(value)` 会把纯数字字符串配置项误转为 number | P2 | 接线到 `extractEagAutonomousRequestFromPrompt`/装配层，或标注废弃；修 `Number()` 类型推断 |
| 11 | `packages/core/src/eag/assembly.ts` | 531 | orchestrator / graph / 各组件装配工厂 | ✅ 未发现同类问题 | `:145-169` `buildAutonomousOrchestrator` 装配失败 `return undefined` + `log(..., "error")`（fail-closed）；`:157` 注入 `createDefaultBlockerGuardChain()`；全文无 `runResult` 重建、无结果成败改写（`:123` catch 仅 `formatContext` 的 JSON 序列化降级） | — | 无需改动 |
| 12 | `packages/core/src/eag/index.ts` | 571 | eag 根 barrel（显式解决 `export *` 同名冲突） | ➖ 不适用 | `:97-571` 全部 `export *` / `export type`，无运行逻辑 | — | 无需改动 |

**A 节计数**（纳入 E-1 复核后）：文件 12；`✅` 5（#4/#5/#6/#7/#11）、`⚠️` 3（#3/#8/#10）、`❌` 2（#1/#2）、`➖` 2（#9/#12）。#2 由 `⚠️` 升级为 `❌`（E-1 确证第 1/2/3 级整条丢弃失败证据，触发条件明确）。

---

## B. 跨层字段契约矩阵

> 格式：`生产写入点:行号 → 中间透传:行号 → 消费读取点:行号 → 是否一致`。行号均指源码；`session.ts` 省略前缀时均为 `packages/core/src/session.ts`。

| 字段 | 生产写入点:行号 → 中间透传:行号 → 消费读取点:行号 → 是否一致 |
|---|---|
| `failedTestIds` | `eag/p5/handlers/verify-stage-handler.ts:513` `failedTestIds: failedTests.ids`（artifacts） → `eag/p5/autonomous-orchestrator.ts:1255` `stageResult.artifacts["failedTestIds"]` 汇总 → `:1722` `failedTestIds: ... ? Object.freeze([...runFailedTestIds]) : undefined`（顶层，类型 `:390`） → `eag/cli/eag-autonomous-command.ts:501` `runResult` 原样透传 → `session.ts:5861` `result.runResult` → `:5880-5885` `(runResult as { readonly failedTestIds?: unknown }).failedTestIds` 精确读取 → `:5821` 写 record → `:12213-12214` 反序列化保留 → `:1542-1546` diagnostics。**一致 ✓**（`:484-493` 编排抛异常路径无 `runResult`，源头无值，诚实降级） |
| `abortReason` | `session.ts:5863-5867` `blockageReport.summary` / `result.errorMessage` 取值 → `:5820` `...(details?.abortReason !== undefined ? { abortReason } : {})` 写 record → `:12212` 反序列化保留 → `:1537` `record.abortReason.trim()` 读取。**一致 ✓**（例外：`:7906-7914` `handler.execute()` 自身抛异常时 `details={}`，`errMsg`(`:7910`) 未写入 → `abortReason` 丢失，属诚实降级，见 D-P2） |
| `failureContext` | `session.ts:1573-1575` `buildGoalBlockedDiagnostics` 构造 → `:5959-5963` `notifyFailedGoalBlocked` 存快照 `...(failureContext !== undefined ? { failureContext } : {})` → `:5686` `consumeConfirmPreviousDecision` 读 `stored.failureContext` → `:6021` `buildAutoExecuteCommandImpl(commandHint, goal, failureContext)` → `eag/suggestion-auto.ts:265-278` 拼进 `--goal` 统一转义。**两条确认通道（`:5504` confirm_previous / `:5155` direct_chat）一致 ✓**；**旁路见 D-P1**：`:5601` 知情重试、`packages/web/src/session-pool.ts:1420` Web 自动注入均不带第三参 |
| `fixApplied` | `eag/p5/handlers/fix-stage-handler.ts:482` `fixApplied: true`（artifacts） → （P5 内部，无跨层重建） → `eag/p5/autonomous-orchestrator.ts:1242-1243` `r.stage === "fix" && r.kind === "success" && r.artifacts["fixApplied"] === true`。**一致 ✓**（写/读都在 `artifacts` 字典，无嵌套改名） |
| `fixTaskCardId` | `eag/p5/handlers/fix-stage-handler.ts:483` `fixTaskCardId: taskCard.id` → `eag/p5/autonomous-orchestrator.ts:1245` `fixAppliedResult?.artifacts["fixTaskCardId"]` → `:1102` 参与 `skipDevAfterFix` 同卡判定。**一致 ✓** |
| `skipDevAfterFix` | `eag/p5/autonomous-orchestrator.ts:1102` 置 ctx → `:2758` `skipDevAfterFix: args.skipDevAfterFix` 透传 → `eag/p5/handlers/dev-stage-handler.ts:208` `if (ctx.skipDevAfterFix === true)`。**一致 ✓**（`=== true` 严格读取，与布尔写入一致） |
| `baselineAvailable` | `eag/p5/autonomous-orchestrator.ts:955` `baselineFailures.available` → `:1098`/`:1701`/`:2756` 注入 ctx → `eag/p5/handlers/verify-stage-handler.ts:465` `ctx.baselineAvailable === true && baselineSet !== undefined` → `:520` `baselineAvailable` 写 artifacts → `:1226-1236` orchestrator 读 `baselineOnly` 拆分。**一致 ✓** |

**B 节结论**：7 个字段**主链路全部闭环一致**，`normalizeAutonomousGoalRuns()`（首轮事故点）已逐字段保留、cli 层 `runResult` 原样透传、parser 解析失败不静默给默认值。但 **`failureContext` 存在 2 条不带失败状态的旁路**（`session.ts:5601` 知情重试、`web/session-pool.ts:1420` Web 宿主），`abortReason` 在 `session.ts:7914` 异常路径降级丢失 → 矩阵**未完全闭环**。

**B 节补充（非字段类跨层契约：上下文压缩证据保留 / 执行链护栏归属）**：本轮修复只覆盖「单条 tool 内部」写入侧（`truncateToolOutput :119-189` → 第 0 级 `:285-293`），但**压缩层 → 模型上下文**这条跨层链在第 1/2/3 级仍会把 tool 结果整条替换（`:338`/`:359`/`:378`），保护窗 `:299-309` 只保最近 4 条 → 写入侧已保留的失败证据可能在压缩中途被整条丢弃，属「写入-透传-消费」链条的同类缺口（E-1 / D-P1-3）。另：EAG→team 执行链的护栏归属（E-2）与 `runEphemeral` 轮次预算（E-3）亦属跨层契约——主委托路径 `team-adapter.ts:876-891` → `session.ts:7225` → `runEphemeral(:4673)` 继承主 chat 三类护栏，而 graph `GoalDispatcher` 子路径（`eag/assembly.ts:274` → `goal-dispatcher.ts:666`）未继承，须分路径判定。

**B 节补充 2（跨组复核并入：`failureContext` 的下游落点与双机制失效，2026-11-08，详见 F-2）**：`packages/core/src/eag/` 全目录检索 `failureContext` **仅命中 `suggestion-auto.ts:256/262/265/277`**，`p5/`/`cli/`/`dynamic/` 零命中；`AutonomousRunRequest`（`autonomous-orchestrator.ts:267-310+`）**无 `failureContext` 字段** → 本轮修复的约束只能以纯文本经 `suggestion-auto.ts:277` 拼进 `--goal` → `eag/cli/eag-autonomous-command.ts:465` `objective: request.goal` 进入新 run，**编排器无结构化字段接收**。P5 侧唯一跨 run 失败记忆是 `plan-stage-handler.ts:1036` `loadPreviousRunContext()`（定义 `:180-250`，读 `.eag/p5/run-state/*.jsonl` **末行** `abortReason`，`:249` `slice(0,1500)` head-only 截断，常量 `:163`）。因此 `session.ts:7914` 异常路径 `abortReason` 丢失时，`buildGoalBlockedDiagnostics`（`:1553-1556`）与 `loadPreviousRunContext`（`:242`）**两条记忆通道同时为空**，重放完全无失败原因——这是 B 节 `failureContext`/`abortReason` 两行「未完全闭环」在更下游的放大，放大 D-P2-3。

---

## C. 测试覆盖矩阵

### C.1 统计口径与规模
- `packages/core/src/tests/eag*.test.ts` 实测 **208** 个（任务书写 209，以实测为准）；`tests/*.test.ts` 总计 343 个；`eag/**/*.ts` 生产文件 258 个。
- 双口径：① 文件名/模块名近名匹配（`/tmp/dcx_coverage.py`）；② 测试文件 **import 内容 + 字符串提及** 匹配（`/tmp/dcx_coverage2.py`）。②用于补正经 barrel（`core/src/index.ts`、`eag/index.ts`）间接覆盖导致的①假阴性（例：`eag-assembly.test.ts` import `../index.js`，不含 `suggestion-auto` 字面量，但 EA-02 段实测覆盖该文件全部导出函数）。

### C.2 本审查范围 12 文件 → 测试文件映射（基于 import 内容）
| 生产文件 | 直接 import 的测试数 | 主要对应测试文件 | 备注 |
|---|---|---|---|
| `session.ts` | 42 | `session-eag-goal-failure-guard.test.ts`、`session-eag-llm-trigger.test.ts`、`session.test.ts` 等 | 充分 |
| `context-budget.ts` | 2 | `context-budget.test.ts`、`context-budget-headtail.test.ts` | 仅覆盖第 0 级/epoch |
| `eag/suggestion-auto.ts` | 1 | `session-eag-goal-failure-guard.test.ts:33` | 另有 `eag-assembly.test.ts` EA-02b~02h（`:181/203/216/228/258/293`）经 barrel 覆盖全部导出函数；**无同名测试文件** |
| `eag/cli/eag-args.ts` | 1 | `eag-args.test.ts` | — |
| `eag/cli/eag-autonomous-command.ts` | 9 | `eag-p5-baseline-guard.test.ts`、`eag-p5-autonomous-params-handler.test.ts` 等 | 文件名无同名但有充分间接覆盖 |
| `eag/cli/eag-command-parser.ts` | 11 | `eag-cli-parser-*.test.ts`、`eag-p5-autonomous-parser-integration.test.ts` 等 | 同上 |
| `eag/cli/eag-design-command.ts` | 1 | `eag-design-command.test.ts` | — |
| `eag/cli/eag-graph-command.ts` | 1 | `eag-graph-command.test.ts` | — |
| `eag/cli/index.ts` | 0 | — | barrel，无需专测 |
| `eag/config/eag-config-loader.ts` | 1 | `eag-config-loader.test.ts` | 仅测 loader 自身，无接线测试 |
| `eag/assembly.ts` | 0 | `eag-assembly.test.ts`（经 `../index.js` barrel 间接，提及 2） | 无直接 import |
| `eag/index.ts` | 1 | `eag-root-barrel.test.ts` | barrel |

### C.3 高风险生产文件「零测试 import 且零内容提及」清单（非模板/非 fixture/非纯类型，共 **11** 个）
```
eag/p5/guards/dangerous-command-guard.ts          （破坏性命令护栏）
eag/p5/guards/env-boundary-guard.ts               （环境边界护栏）
eag/p5/guards/scope-fake-cred-runtime-guards.ts  （范围/伪造凭据运行期护栏）
eag/p5/common/atomic-file.ts                      （原子落盘）
eag/p5/symbol-graph-store.ts
eag/p5/impact-bfs.ts
eag/graph/graph-lifecycle-models.ts
eag/doc-driven/constitution-builder.ts
eag/doc-driven/git-process-manager.ts
eag/dynamic/prompts/sedimentation-prompt.ts
eag/coding/static-checkers/checker-utils.ts
```
另：按文件名近名口径「无同名/近名测试」但经内容检索确认有覆盖的高风险文件（**不计入无测试**）：`eag/suggestion-auto.ts`、`eag/cli/eag-autonomous-command.ts`、`eag/cli/eag-command-parser.ts`、`eag/graph/graph-scheduler.ts`（`eag-loop-guard.test.ts` 等提及）、`eag/report-render.ts`（`eag-ledger-report.test.ts`）。事故链路核心文件 `autonomous-orchestrator.ts`(import 3)、`llm-task-executor.ts`(import 2)、`verify-stage-handler.ts`(import 3)、`fix-stage-handler.ts`(import 2)、`common/loop-guard.ts`(import 12) 均有测试。

### C.4 本轮新增 4 个测试文件断言质量抽查

**1) `context-budget-headtail.test.ts`（204 行）— ⚠️ 只测第 0 级 happy path**
- 优点：`:19-23` import 真实 `truncateToolOutput`/provider，无 mock；`:97`/`:115`/`:133` `assert.endsWith(content.slice(-TAIL_LEN))` 尾部 1800 完整；`:166-204` T6 走真实 `compactForRequest` 端到端并断言条数/配对/输入只读。
- 缺口：全套件只构造 **单条 tool**（T6 `:172-178` 仅 1 条 tool 消息），**未触发第 2 级（`:345` 总量超 100K）/第 3 级（工具裁剪）**，因此无法暴露 `context-budget.ts:350-382` 保护窗外整条丢弃失败证据；`:142-160` T5 极小预算用 `"x".repeat(12000)`（`:143` 无失败标记），只断言 `startsWith("xxxx")`（`:149`），**不会暴露 `:128-135` head-only 退化丢尾部错误**。

**2) `eag-p5-baseline-guard.test.ts`（601 行）— ✅ 未发现断言放宽/桩太强假通过**
- `:8-13` 明确「禁止把真失败说成通过：所有断言都要求 verify 结果仍为 failed」；`:10` 真实 `spawnSync` 测试命令；`:11-12` 真实 4 handlers + guardChain/smartConfirmation，唯一替身 `createAlwaysSucceedTaskExecutor`（LLM 网络边界，声明内）。
- `:111-151` B1 覆盖 6 类诚实降级（含 `:139-141` 无用例标识绝不臆造基线）；`:171-197`/`:199-232` B2 断言 `artifacts` 三字段 + summary 反断言 `!includes("测试通过")`；`:495-519` B7a 精确复刻 `session.ts` 读取方式、断言顶层数组 + 去重保序 + 字符串过滤；`:550-575` B8a 直接属性访问非 cast。反例齐全，断言精确。

**3) `eag-p5-no-progress.test.ts`（437 行）— ✅ 未发现断言放宽/桩太强假通过**
- `:7-9` 真实 git init / 文件系统 / ToolExecutor，唯一替身 `StubLlmClient`（LLM HTTP 边界）；`:97-126` N1 精确断言 `result.llmRequests === 4` + 熔断文案；`:128-183` N2/N3 反例（不误伤）；`:245-270` N6 用 `doesNotMatch` 断言优先级；`:333-358` N10 探索型轨道 B；`:409-436` N13 非 git 禁用轨道 B 并用 `doesNotMatch` 反断言成因。正/反/配置/优先级/成因文案全覆盖。

**4) `session-eag-goal-failure-guard.test.ts` N9–N13（`:633-985`）— ⚠️ 桩太强 + 固化了缺口**
- `createDiagnosticOrchestrator`（`:670-710`）用 `as unknown as AutonomousRunResult`（`:705`）**手工在 `runResult` 顶层塞 `failedTestIds`**（`:703`），**绕过 `autonomous-orchestrator.ts:1255/1722` 的真实汇总逻辑**；桩注释（`:666-668`）称「真实生产编排器目前不透出 failedTestIds」，与当前生产代码（`:390` 类型定义 / `:1722` 写入）**矛盾/过期**，易误导维护者以为链路靠桩即可。N10/N12/N13 因此只验证 `session.ts` 读取侧，汇总侧由 `eag-p5-baseline-guard.test.ts` B7/B8 覆盖（整体不构成假通过，但桩注释需修）。
- **N5（`:381-415`）确证固化缺口**：`:412` `assert.equal(runRequests[1].objective, goal, "重放 goal 必须与失败记录目标一致")` —— 把「知情重试裸重放（不含 failureContext）」写成正向断言，与 N12（`:921` 断言重放须含「【重放约束】」）形成矛盾契约；B 节 D-P1 的第三条通道因此**无测试拦截**。
- N11（`:823-870`）零回归用独立拷贝旧实现 `legacyBuildAutoExecuteCommand`（`:643-659`）作 oracle，避免自证循环，断言质量良好；`:845-851` 覆盖第三参 `undefined/""/纯空白`。
- N9（`:712-768`）覆盖 details 全字段写入与旧会话字段缺失；N13（`:934-985`）覆盖 direct_chat 通道 + `failedTestIds=[]` 不编造该段（`:981`）。**未覆盖** `buildGoalBlockedDiagnostics` 的「`abortReason` 也为空 → 全降级」分支（`session.ts:1553-1556`）。

---

## D. Top 发现（P0 / P1 / P2）

### P0（致命、需立即修复）
**无**。本轮核心修复的主链（failedTestIds 顶层契约、normalize 保留、truncateToolOutput 保尾部、逃生门 failureContext、无进展熔断）经复核确为闭环，未发现确证的 P0 级残留。

### P1（确证，同类缺口仍存在）

**D-P1-1　知情重试（acknowledgeFailedGoal=true）是第三条绕过 failureContext 的失败目标重放通道**
- 位置：`packages/core/src/session.ts:5585`、`:5601`；测试 `packages/core/src/tests/session-eag-goal-failure-guard.test.ts:412`
- 成因：`consumeExecuteCommandDecision` 在 `suggestion.acknowledgeFailedGoal !== true`（`:5585`）时走 D2 守卫 → `notifyFailedGoalBlocked`（`:5590`，唯一写 `failureContext` 快照处，`:5959-5963`）；但 LLM 输出 `acknowledgeFailedGoal=true` 时**整个守卫与拦截被跳过**，直接 `:5601` `this.buildAutoExecuteCommand(commandHint, goal)` 只传两参，既不取 `findFailedAutonomousRun` 的诊断，也不构造 `failureContext`。
- 后果：触发层 LLM 误把「继续 / 重跑」判为知情重试时，失败目标被**裸重放**、命令 `--goal` 不含任何上一轮失败原因，逐字重演上一轮失败——与事故「下一条短指令被重炒为无条件自动执行 → 逐字重演 12 轮空转」同型；且 N5 `:412` 的 `objective === goal` 断言把该行为锁死，与 N12 `:921` 的「重放须含约束」契约冲突。
- 最小修复：放行分支先 `const failedRun = this.findFailedAutonomousRun(sessionId, goal)`，命中则取 `buildGoalBlockedDiagnostics(failedRun).failureContext` 传第三参；或显式记录 warn 日志 + 文档化「知情重试由用户承担重放风险」；同步把 N5 断言改为期望含约束。

**D-P1-2　Web 宿主自动注入 / 拦截通道未同步本轮修复（跨包）**
- 位置：`packages/web/src/session-pool.ts:1420`、`:1433`、`:1440`（全文件检索无 `failureContext` / `lastEagDisplayedSuggestions` / `notifyFailedGoalBlocked` / 「重放约束」/「诊断」等价实现）
- 成因：`:1420` `buildAutoExecuteCommand(capture.commandWithSlash, capture.goalText)` 两参组装所有自动注入命令；`:1433` `hasFailedAutonomousRun` 命中后只推送硬编码泛化文案 `:1440`「【EAG 拦截】…请回复"执行这个"或提供修改后的新目标」，**没有「上一轮诊断」段、不写带 failureContext 的快照**（对比 `session.ts:5950-5963`）。
- 后果：Web 侧失败目标拦截仍是事故里的「泛化模板」形态，自动重放路径不带失败状态；用户按提示回复「执行这个」后，Web 侧无快照依托，是否最终经 core 的 `notifyFailedGoalBlocked` 二次拦截并带上约束**需运行时复核**（⚠️ 未实测，不臆断）。
- 最小修复：Web 拦截提示复用 core 的 `buildGoalBlockedDiagnostics` 等价物输出诊断段；核对「执行这个」最终落到 core 带 `failureContext` 的快照，否则补齐宿主侧快照机制。

**D-P1-3　`context-budget.ts` 第 1/2/3 级整条丢弃失败证据：确证「同类但尚未修复」残留（E-1 复核结论）**
- 位置：`packages/core/src/context-budget.ts:285-293`（第 0 级，已修复）、`:338`（第 1 级）、`:359`（第 2 级）、`:369-378`（第 3 级）、`:296-297`（占位内容）、`:299-309`/`:319-321`（保护窗）、`:345`/`:366`（触发线）、`:335-339`（第 1 级判重）
- 成因：第 0 级 `truncateToolOutput` 只保证**单条 tool 消息内部**尾部 45% 完整；此后第 1 级（原始内容完全相同的旧 tool）、第 2 级（总量 > `toolResultsBudgetChars` 100000）、第 3 级（> `requestTotalCharsCeiling` 800000）都会把**整条** tool 内容替换为 `droppedNote`（`:296-297` 仅「共 N 字符已省略」一行，无任何 stderr/FAILED/AssertionError 内容）。保护窗 `:300-309` 只收集**最近** `protectedRecentTools`（缺省 4，`:65`）条 tool 索引，`:319-321` 对窗内 tool 返回不可丢 → **窗外更早的 tool 可整条丢弃**。
- 触发条件（精确）：① 消息数 > `minMessages`(3, `:262`)；② 第 1 级：两条 tool 原始内容逐字相同（`:330` `originalToolContentAt`、`:336` `latestToolContentIndex.has`）且 `rawContent.length > dedupeMinChars`(200, `:335`)、旧那条在保护窗外（`:337`）→ `:338` 整条替换（第 1 级保留最新那条，单独不丢证据；但若最新那条随后被第 2 级丢弃则证据全失）；③ 第 2 级：`totalChars(working) > 100000`（`:345-347`）→ `:350-363` 从最老 i 逐条 `:359` 整条替换直至达标；④ 第 3 级：`> 800000`（`:366`）→ `:369-378` 对所有可丢消息整条替换。
- 事故关联与边界（诚实）：dev 连续 40 轮 ls/pwd/find，每条输出经第 0 级截到 ≤4000（`:287-291`），40 条累计可达 160K > 100K → **事故长会话场景确实可触发第 2 级**，把最早约 15 条（含早期失败证据）整条替换为占位；但保护窗保最近 4 条 tool，**最近一次**失败原因通常仍在窗内且尾部保留，故不等同于「完全看不到任何失败原因」，丢的是**更早的历史失败证据链**（基线对照、前几轮 AssertionError）。属与事故同型（模型失去失败证据）的残留，故列 P1。
- 最小修复：第 1/2/3 级整条替换前先用 `truncateToolOutput` 或失败标记正则抽出尾部/失败窗口摘要保留在占位里；补「多 tool 累计超预算 + 保护窗外旧 tool 含 FAILED」的回归测试（现 `context-budget-headtail.test.ts` 只构造单条 tool，不触发第 2/3 级）。

**D-P1-4　`confirm_previous` 消费方零门禁 + 3 类快照写入方：`failureContext` 覆盖是「按写入方」而非「按消费方强制」，另添 2 条裸重放通道（F-1 复核结论，跨组确证）**
- 位置：`session.ts:5675-5695`（`consumeConfirmPreviousDecision`）、`:5504`/`:5155`（两个消费入口）、`:5515-5518`（`suggest_*` 快照）、`:5640`（降级快照）、`:5959-5963`（`notifyFailedGoalBlocked` 快照）、`:1397-1408`（快照类型）、`:1553-1556`（`buildGoalBlockedDiagnostics` 空诊断降级）、`:5585-5593`（D2 仅挂 `execute_command`）、`:5497-5499`/`:5503-5505`/`:5507-5530`；`eag/dynamic/eag-dynamic-suggester.ts:113-120`/`:185`/`:186-191`/`:404-409`；`packages/cli/src/ui/views/App.tsx:1282-1348`/`:1344-1345`；`packages/web/src/session-pool.ts:1420`/`:1433`/`:1440`
- 成因：`failureContext` 能否进入重放命令**完全取决于 `lastEagDisplayedSuggestions` 由哪个写入方填充**。消费方 `consumeConfirmPreviousDecision`（`:5686`）只读 `stored.failureContext`，既不从 `autonomousGoalRuns` 重建，也无「第三参必须非空」门禁（`:5677-5680` 仅校验快照存在，`:5667-5668` doc 明示「不做跨 run 失败守卫」；`:5686` 把可能为 `undefined` 的第三参直传 `buildAutoExecuteCommand`）。三类写入方中只有 `notifyFailedGoalBlocked`（D2 硬拦截，`:5959-5963`）带诊断，且其诊断在 `abortReason`+`failedTestIds` 同时为空时（`:1553-1556`，对应 `:7914` 异常路径）也降级为无字段。`suggest_*` 展示（`:5515-5518`）与 `degradeExecuteToSuggestion`（`:5640`）写的是裸 `{commandHint, goal}` 快照，而 D2 守卫只挂在 `execute_command` 决策（`:5497-5499`/`:5585`），这两条路径**完全不做** `findFailedAutonomousRun` 判定。
- 后果：当「上一轮建议」来自 `suggest_*` 展示 / 执行降级 / 诊断为空的拦截时，用户回复「执行这个」→ `confirm_previous`（或 `:5155` `startsWithConfirmExecutePhrase` 确定性逃生门）→ `buildAutoExecuteCommand(hint, goal, undefined)` → **逐字零回归裸重放**，新 run 拿不到任何上一轮失败原因（F-2 进一步证实 `AutonomousRunRequest` 无 `failureContext` 字段，P5 侧唯一记忆 `loadPreviousRunContext` 又依赖终态落盘且 `:249` head-only 截断）。与事故「阻塞报告泛化模板 → 逃生门裸重放 → 逐字重演」同型。触发依赖 LLM 输出 `suggest_*` 而非 `execute_command`（⚠️ 未实测，不臆断必然发生）。
- 边界（不重复报已修复项）：事故主链「D2 拦截 → `notifyFailedGoalBlocked` 带真实诊断 → `confirm_previous` 消费」经复核**确实带 `failureContext`、修复有效**（`session-eag-goal-failure-guard.test.ts` N6 `:421-463`、N11 `:823-858`、N12 `:921` 覆盖）；本条只报**仍存在**的旁路，不把主链重报为新问题。
- 最小修复：消费方加门禁——`stored.failureContext === undefined` 且 `findFailedAutonomousRun(sessionId, stored.goal)` 命中时实时 `buildGoalBlockedDiagnostics(failedRun)` 重建约束再传第三参；或 `suggest_*`/降级写快照时也补诊断；CLI/Web 宿主侧补等价快照。同步补「`suggest_*` 快照 + 存在失败 run → 重放命令须含约束」回归测试（现 N5 `:412` 反向固化裸重放，N6/N12 只测 `notifyFailedGoalBlocked` 快照）。

### P2（观察 / 需复核）

**D-P2-1　`context-budget.ts:128-135` 极小/非法预算退化仍是 head-only 丢尾部（与 D-P1-3 同源的独立分支）**
- 位置：`packages/core/src/context-budget.ts:128-135`（`maxChars < TRUNCATE_SAFE_MIN_CHARS`(200) 或 NaN/Infinity → `head = content.slice(0, cap - marker.length)` + 精简尾注，无失败窗口、无尾部）
- 后果：显式把 `toolOutputMaxChars` 配成 <200（或非法值）时，本轮修复的「尾部 45% 必留」被绕过，尾部 stderr/断言整段丢失；缺省 4000 不触发，故列 P2。`context-budget-headtail.test.ts:143` T5 用 `"x".repeat(12000)`（无失败标记）只断言 `startsWith("xxxx")`（`:149`），不暴露该分支。
- 最小修复：极小预算退化也保留尾部；补「极小预算 + 尾部含 FAILED」测试。第 1/2/3 级整条丢弃的确证结论见 **D-P1-3 / E-1**（已升级 P1）。

**D-P2-2　`EagConfigLoader` 未接线，配置静默不生效**
- 位置：`packages/core/src/eag/config/eag-config-loader.ts:126-146`（load 失败返回 `{}`）、`:244-324`（校验失败用默认值）、`:216-223`（`Number(value)` 误转纯数字字符串）；全仓 `packages/` 检索仅自身 + `eag-config-loader.test.ts` 引用
- 后果：`.deepcode/eag.yml` 的 `testCommand` / `maxIterations` / `consecutiveFailureAbort` 等对 `/eag-autonomous` 实际运行不生效，仍用 `eag-autonomous-command.ts:82-117` 硬编码默认值；用户误以为已改配置。
- 最小修复：接线到请求装配/assembly，或标注废弃并移除文档承诺。

**D-P2-3　`handler.execute()` 自身异常路径 `abortReason` 丢失（诚实降级的后果）**
- 位置：`packages/core/src/session.ts:7906-7914`（`errMsg` 在 `:7910` 已得，`:7914` `recordAutonomousRunOutcome(..., {})` 传空 details，且 `:5842-5843` 注释称异常兜底取 errorMessage 与实际不符）
- 后果：该路径落盘的失败记录无 `abortReason` → `buildGoalBlockedDiagnostics`（`:1553-1556`）返回空诊断段 + `undefined failureContext` → 逃生门回到裸重放。属 `:7911-7913` 明示的「绝不从异常文本猜测」有意降级，故列 P2。
- 最小修复：把 `errMsg` 作为 `details.abortReason` 传入（异常文本是真实错误信息，非编造），或统一注释口径并显式记录该降级后果。

**D-P2-4　护栏第三类执行路径覆盖需复核（E-2 复核结论：部分成立，主委托路径不裸奔）**
- 位置：`session.ts:8839/8851/9309/9329`（TurnGuard 全仓仅在此实例化，`common/loop-guard.ts:163` 定义 + `index.ts:396` re-export）；EAG→team 三引用点 `eag/assembly.ts:55-56`、`eag/graph/node-executor.ts:56-59`、`eag/p5/handlers/plan-stage-handler.ts:41-47`；委托链 `team/team-adapter.ts:876-891` → `session.ts:7225` `runner:(ctx)=>this.runEphemeral(ctx)` → `runEphemeral(:4673)`；`team/roundtable/room.ts:504-511`、`team/orchestrator/execute.ts:227-238`；旁路 `eag/assembly.ts:274` → `team/plugins/goal-dispatcher.ts:666`；graph 自建 `eag/graph/node-loop-kernel.ts:211/357-359/685`、team 自建 `team/autonomous/loop-controller.ts:263/346`
- 结论（分路径，纠正「所有 EAG→team 路径都绕开 TurnGuard」的假设）：① **主委托路径不绕开**——`team-adapter.ts:876` `isDispatchRunner(opts.runner)` 为真时 `opts.runner({..., maxToolRounds})`（`:883-891`），该 runner 由 `session.ts:7225`（及 `packages/cli/src/team/team-runner.ts:88`）注入为 `runEphemeral`，后者复用 `createSession + activateSession` 完整主循环（`:4655-4657`「工具执行、审批、护栏、token 预算…全部与主对话一致」「零分叉、天然继承所有护栏」）→ 继承主 chat 三类护栏，并叠加 `runEphemeral` 外层 `AbortController` 预算（`:4689-4695`）与 team 层全局预算（`execute.ts:165/193/229/242`、`room.ts:90/508`）。② **未注入 runner** 时 `team-adapter.ts:186/875` 走「单次 LLM 调用（无工具）」，无工具轮次即无空转轮概念。③ **真正的第三类路径**：`eag/assembly.ts:274` `goalDispatcher.dispatch(batch)` → `goal-dispatcher.ts:666` `plugin.execute(ctx)`（单次 goal 执行，不经 `executeDispatch`/runner/SessionManager 主循环），多轮由 graph `NodeLoopKernel` 驱动；team 目录全量检索**无** `TurnGuard`/`noProgress`/`decideBeforeIteration`/`recordTurn`/「空转」引用，仅有 `loop-controller.ts:263/346` 连续失败 abort 与 `node-loop-kernel.ts:211/357-359/685` 连续失败计数 → 该子路径**确实绕开主 chat 三类护栏、且无「工作区不变型无进展」判定**（⚠️ 具体插件 `plugin.execute` 是否内含 LLM 工具轮次循环未逐个精读，需 graph 目录负责人复核，不臆断「完全裸奔」）。
- 三类护栏分支覆盖（E-3）：`recordTurn(:9309)`/`recordToolCalls(:9329)` 仅在完整走完一轮 LLM 请求+工具执行后调用；请求前/中早退（`:8824`/`:8831`/`:8890`/`:8902`/`:8983`/`:9116` continue/`:9171`）不记，属「请求未发生/被中断」合理；`:9351`/`:9355` 在 recordTurn 之后已记 ✓；**`:9291` ask_permission 分支在 recordTurn/recordToolCalls 之前 return → 模型产出工具调用但等待审批的轮不计重复调用/连续失败**（具体盲点，⚠️）；`:8844-8849` acknowledgeAndContinue 放行重置为有意分支。
- 最小修复：补执行路径→护栏归属清单（尤其 graph GoalDispatcher 子路径与 ask_permission 挂起轮）；明确每类执行器的空转/重复/全失败收口点。**逐类收口点行号、`graph/graph-loop-orchestrator.ts:868` fork 分支 ❌ 确证残留、以及「不降 ✅ / 不升完全裸奔」的口径，已由 review-loops W2 复核并纳入 F-5**（本处结论与其一致，未据其改动四档计数）。

**D-P2-5　同一 `aborted` 终态在两处语义口径不一致（次要；措辞依 review-loops W2 复核收窄，见 F-5e）**
- 位置：`eag/cli/eag-graph-command.ts:598-600` `const success = runReport.finalStatus === "completed" || ... === "aborted"`（`:598` 注释「用户中止也算执行完成」）；`session.ts:5908` `history.find(... && r.finalStatus !== "completed")`，`:5914-5916` 注释明确「非 completed 终态（failed/aborted/fatal）→ true，宿主应跳过自动注入，防失败目标被逐字重演」。
- 结论（review-loops 逐字复核）：两者语义相反但**作用域不同**——前者是「命令返回给用户的 success」，后者是「跨 run 失败守卫的历史指纹，用于跳过自动注入」。故**不定性为「把失败说成通过」**，保持 P2 观察，措辞由原「两套命令体系对同一终态字串语义相反」收窄为「同一 aborted 终态在两处语义口径不一致」。真正贴切「把失败说成通过」的对象是 `team/plugins/loop.ts:116`（实测 `exitReason="max-iterations"` 收口后仍 `return this.ok(ctx, summary, ...)` succeeded），该文件属 review-loops 范围、其 W2 已按 ❌ 处理，本处仅转述引用、不重复计数。
- 最小修复：统一终态枚举口径或加转换层；`team/plugins/loop.ts:116` 由 review-loops 收口。

**D-P2-6　两套轮次上限不矛盾，但 `runEphemeral` 预算存在轮次口径错配（E-3 复核结论）**
- 位置：`session.ts:4667`（注释「主循环 TurnGuard 已移除轮数上限」）、`session.ts:4691`（`if (toolCallCount() > options.maxToolRounds)`）、`:4683-4687`（`toolCallCount()`）、`:4689-4695`（200ms 轮询 + `controller.abort()`）、`:9341`（每轮覆盖 `toolCalls`）、`team/team-adapter.ts:191`（`maxToolRounds` 默认 8、`max(50)`）、`session.ts:7225`（runner 注入）
- 两套上限关系（结论：**不矛盾、不同层、叠加生效**）：`:4667` 指的是 `common/loop-guard.ts:112` 的 `TurnGuard` 不再有 Token/轮数硬终止线（改为重复调用/连续全失败/连续空转三类护栏）；`:4691` 是 **`runEphemeral(:4673)` 方法外层**用 `setInterval(..., 200)` 轮询 + `AbortController.abort()` 实现的**独立任务级预算**，只作用于 dispatch/临时会话，不作用于普通主 chat，`:4665-4670` 注释已明确解释「选轮询而非改主循环」的取舍。链路：`team-adapter.ts:191`（默认 8）→ `session.ts:7225` 注入 runner → `runEphemeral` 外层 abort 预算 + 内层完整主循环三类护栏（`session.ts:8839/9309/9329`）。
- 新发现口径错配（⚠️）：`toolCallCount()`（`:4683-4687`）读 `entry.toolCalls.length`，但 `entry.toolCalls` 在 `:9341`（及 `:9277-9289` ask_permission 分支）**每轮被覆盖为本轮工具调用数组**，并非累计轮数 → `:4691` 实际比较的是「当前轮工具调用数 > maxToolRounds」，与「轮次上限」语义错配；且 200ms 轮询（`:4695`）可能漏过快速连续轮。后果：单轮多工具调用可能误触发 abort，多轮各 1 个工具则预算永不触发（后者与事故「40 轮无熔断」同型，尽管 `runEphemeral` 内层仍继承 TurnGuard 三类护栏兜底）。
- 最小修复：改用累计轮数计数器（与 `:9309` `recordTurn` 的轮次语义对齐），或明确把 `maxToolRounds` 文档化为「单轮工具调用上限」并改名；补多轮各 1 工具的预算触发测试。

---

## E. lead 补充线索复核（2026-11-08 追加，只读）

> 本节对 lead 独立复核提出的三条线索逐条给出行号结论。口径同前：不把「本轮已修复」重复报成新问题，只判定**仍存在**的同类缺口；无法实测的标 ⚠️ 并说明缺什么。

### E-1　`context-budget.ts` 第 1/2/3 级整条丢证据 — **❌ 确证，属「同类但尚未修复」残留**

**结论**：是。第 0 级 `:285-293` 的 head+失败窗口+tail 只保证**单条 tool 消息内部**尾部证据不丢；一旦进入第 1/2/3 级，tool 结果被**整条**替换成占位，保护窗之外的旧 tool 中的 stderr / FAILED / AssertionError / 用例名会被**整条丢弃**。这属于本轮修复（第 0 级）**未覆盖**的同型残留，已据此把 A 节 #2 由 `⚠️` 升级为 `❌`、D 节新增 **D-P1-3**。

**行号证据（逐级）**
| 级别 | 写入/替换点 | 占位内容 | 触发条件 | 是否保留失败证据 |
|---|---|---|---|---|
| 第 0 级（已修复） | `:285-293` `truncateToolOutput(content, toolOutputMaxChars)` | 头 35% + 首个失败窗口 + 尾 45% + 省略标记 | 无条件（`:285`），单条 `> toolOutputMaxChars`(4000, `:287`) | ✓ 单条内部尾部必留（`:137-179`） |
| 第 1 级 | `:338` `working[i] = { ...message, content: droppedNote(...) + "（与较近一次相同结果重复）" }` | `:296-297` 仅「共 N 字符已省略」 | 两条 tool **原始内容逐字相同**（`:330` `originalToolContentAt`、`:336` `latestToolContentIndex.has`）、`rawContent.length > dedupeMinChars`(200, `:335`)、旧那条 `isDroppable(i,"tool")` 为真（`:337`） | ✗ 旧那条整条丢失（但最新那条仍在，单独看不算全丢；若最新那条随后被第 2 级丢则证据全失） |
| 第 2 级 | `:359` `working[i] = { ...message, content: droppedNote(originalChars) }` | 同上，无任何内容 | `totalChars(working) > toolResultsBudgetChars`(100000, `:345-347`)；`:350-363` 从最老 i 起，对 `isDroppable` 为真（窗外）的 tool 逐条替换，达标即停 | ✗ **窗外旧 tool 整条丢失** |
| 第 3 级 | `:378` `working[i] = { ...message, content: "（上下文压缩：该 role 消息共 N 字符已省略）" }` | 同上 | `totalChars(working) > requestTotalCharsCeiling`(800000, `:366`)；`:369-382` 对所有可丢消息（不限 role）逐条替换 | ✗ 整条丢失 |

**保护窗精确语义**：`:300-308` 从 `messages` 末尾倒序收集**最近** `protectedRecentTools`（缺省 4，`:65`）条 tool 的索引 → `:309` Set → `:319-321` `isDroppable` 对窗内 tool 返回 `false`（永不整条丢）；`:313-315` 首条非 system（任务卡）与末条消息、`:316-318` system 也不可丢。**其余更早的 tool（第 5 条及以前）在预算超限时可被整条丢弃。**

**事故场景触发演算**：dev 连续 40 轮 `ls`/`pwd`/`find`，每条输出经第 0 级截到 ≤4000（`:287-291`），40 条累计上限约 160000 > 100000 → 满足 `:345` 触发线，`:350-363` 从最老开始整条替换，最早约 15 条（含早期失败证据）被换成 `:296-297` 的纯字符数占位。**事故长会话确实可触发第 2 级。**

**边界（不夸大）**：保护窗保最近 4 条 tool，**最近一次**失败原因通常在窗内且经第 0 级尾部保留，故不等同于「模型完全看不到任何失败原因」；丢的是**更早的历史失败证据链**（基线对照、前几轮 AssertionError）。与事故同型之处是「模型失去失败证据 → 盲试换命令」，故列 **P1**（D-P1-3），并同步把 A 节 #2 结论升级为 `❌`。测试缺口见 C.4-1（`context-budget-headtail.test.ts` 只构造单条 tool，不触发第 2/3 级）。

### E-2　EAG → `team/` 第三类执行路径 — **⚠️ 部分成立；「绕开 TurnGuard」对主委托路径不成立，须分路径判定**

**结论**：lead 给出的三个 EAG→team 引用点性质需先澄清：**它们本身是类型/组件依赖，不是执行器委托**。经全链核实，`team-adapter.ts` → `executeDispatch` → runner 的**主委托路径并不绕开主 chat TurnGuard**（与假设相反，需纠正）；真正构成「护栏只覆盖部分执行路径」的第三类，是 `eag/assembly.ts:274` 的 `GoalDispatcher → plugin.execute` graph loop 子路径与 `team/autonomous` 自建循环。已纳入 D-P2-4。

**三引用点性质（行号）**
- `eag/assembly.ts:55-56`：`:45-55` 从 `../team/plugins/index.js` import `GoalDispatcher`/`makeGoal`/6 个插件，`:56` `TaskRequirement` from `../team/types.js`。用于 `ProductionLoopHandoffAdapter`（`:191`，构造 `:196` 注入 `goalDispatcher`），是**图 loop 节点派发组件**，不是 team-adapter 的 `executeDispatch`。
- `eag/graph/node-executor.ts:56-59`：import `GoalDispatcher`/`BatchResult`/`GoalState`（`:56`）与 `makeGoal`/`makeBatch`（`:58`）、`TaskRequirement`（`:59`），供 `NodeExecutorImpl` 构造 goal 批次。
- `eag/p5/handlers/plan-stage-handler.ts:41-47`：import `DomainExpertMatchResult`（`:41`）、`DomainExpertMatcher`/`DomainExpertRegistry`/`registerAllExperts`（`:42-44`）、`GuardCoordinator`（`:46`）、`ValidationResult`（`:47`）——plan 阶段**可选增强**（领域专家匹配、守护协调器），不是执行器委托。

**调用链（行号，分三条）**
1. **主委托链（不绕开护栏）**：`session.ts:7221-7225` `runTeamCommand(args, { runner: (ctx) => this.runEphemeral(ctx), ... })`（另 `packages/cli/src/team/team-runner.ts:88` 同） → `team/team-adapter.ts:876` `if (isDispatchRunner(opts.runner))` → `:883-891` `await opts.runner({ ..., maxToolRounds: opts.maxToolRounds, requireApproval: true })` → `session.ts:4673` `runEphemeral` → `:4699-4705` `createSession` + `activateSession` **完整主循环**（`:4655-4657` 注释：「工具执行、审批、护栏、token 预算、thinking 参数全部与主对话一致」「零分叉、天然继承所有护栏」）→ `session.ts:8839/:8851/:9309/:9329` **TurnGuard 三类护栏生效**。`team/roundtable/room.ts:504-511`（`:508 maxToolRounds`、`:509 ...(options.runner ? { runner } : {})`）与 `team/orchestrator/execute.ts:227-238`（`:229 maxToolRounds: reservation`、`:231 wrappedRunner`、`:238 executeDispatch`）最终都汇入 `executeDispatch` → 同一 runner 链。
2. **runner 未注入**：`team-adapter.ts:186`「未传 → 沿用单次 LLM 调用（无工具）」/`:875`「未注入时保持单次 LLM 调用」→ 根本没有工具轮次，不存在「空转轮」概念，不构成裸奔循环。
3. **真正的第三类路径**：`eag/assembly.ts:274` `const batchResult = await this.goalDispatcher.dispatch(batch)`（`:262-271` 构造 goal/batch，`:220` `iteration` 回调由 graph 节点循环驱动） → `team/plugins/goal-dispatcher.ts:361` `dispatch` → `:424` `executeLevel` → `:666` `const result = await plugin.execute(ctx)`（**单次 goal 执行，不经 `executeDispatch`/runner/SessionManager 主循环**）。多轮迭代由 `eag/graph/node-loop-kernel.ts`（`:211` `consecutiveFailures`、`:357-359` 计数、`:685` 读取）驱动。

**护栏检索证据**：`packages/core/src/team/` 全目录检索 `TurnGuard|noProgress|consecutiveFail|空转|熔断|recordTurn|decideBeforeIteration` —— **无** `TurnGuard`/`noProgress`/`decideBeforeIteration`/`recordTurn`/「空转」引用；仅有 `team/autonomous/loop-controller.ts:263/296-347`（`consecutiveFailureAbort: 3` 于 `:76`）、`config-loader.ts:83`、`run-state.ts:208/224` 的**连续失败 abort**，以及 `team/orchestrator/execute.ts:165/193/229/242`、`room.ts:87-90/508`、`team-adapter.ts:191` 的**任务级工具轮次预算**。`eag/graph/node-loop-kernel.ts:211/357-359/685` 有 graph 自建连续失败计数。→ 第 3 类路径**确实绕开主 chat 三类护栏（重复 tool call / 连续工具全失败 / 连续空转轮）、且无「工作区不变型无进展」判定**（后者是 P5 `llm-task-executor.ts` 内部自建，不在 team/graph 链上）。

**⚠️ 无法判定项（已诚实标注）**：`goal-dispatcher.ts:666` 的 `plugin.execute(ctx)` 是否内含「LLM ↔ 工具」多轮循环，取决于 `team/plugins/index.js` 注册的 6 个具体插件（AutonomousPlugin/MultiGoalPlugin/GraphPlugin/LoopPlugin/ResumePlugin/CancelPlugin）实现，本次未逐个精读；因此不臆断该子路径「完全裸奔」，标 ⚠️ 需 graph/team 目录负责人（review-loops 任务 #7 同范围）复核。主委托路径继承护栏这一结论有 `session.ts:4655-4657/7225` 明确代码支撑，非推测。

**E-2 补充（review-loops W2 护栏收口点复核并入，2026-11-08，详见 F-5）**：上述「需 graph/team 负责人复核」已由 review-loops 逐文件完成，结论为本节 ⚠️ 判定成立——每类自建循环靠「轮数 / 连续失败计数」收口，**没有重复 tool call / 连续工具全失败 / 连续空转轮 / 工作区快照 / 结果指纹**的等价物，故「换命令探索即空转」风险确实存在；但因有 `maxIterations` / `MAX_TRAVERSAL_STEPS` / `consecutiveFailures`，**不降 ✅、也不升级为「无上限裸奔」**。其中 `graph/graph-loop-orchestrator.ts:868` fork 分支直接 `nodeExecutor.execute` 绕开主路径护栏属 **❌ 确证残留**（引用行号已逐条实测）。逐类收口点、作用域澄清与 long-horizon P0 归类见 F-5；本处不新增独立 D 条目、不改动四档计数，避免与 W2 双计。

### E-3　主循环护栏口径 — **两套上限不矛盾（不同层、叠加）；三类护栏覆盖「完整轮」但有 2 类分支不记；发现 1 处轮次口径错配**

**(a) `:4667` 注释 vs `:4691` 上限的关系（结论：不矛盾）**
- `:4667`「主循环 TurnGuard 已移除轮数上限（改为连续失败/重复调用/空转三类护栏）」指 `common/loop-guard.ts:112`（「TurnGuard 不再设置 Token 硬终止线，tokensConsumed 仅作状态观测保留」）与 `DEFAULT_TURN_GUARD_CONFIG`（`:163`）。
- `:4691` `if (toolCallCount() > options.maxToolRounds)` 位于 **`runEphemeral` 方法（`:4673`）外层**：`:4689-4695` `setInterval(..., 200)` 轮询 → `abortedByBudget = true; controller.abort()`；`:4665-4670` 注释明确「主循环是最高回归风险区，选轮询而非改主循环」「预算真实生效（abort 会中断流式请求）」。它只作用于 dispatch/临时会话（`team-adapter.ts:191` 默认 8、`max(50)`），**不作用于普通主 chat**，也不是 TurnGuard 的上限。
- 二者**叠加**：主 chat 普通会话靠三类护栏收口（无硬轮数上限）；team dispatch 临时会话在主循环三类护栏之外再叠一层 `runEphemeral` 外层 abort 预算 + team 层全局预算（`orchestrator/execute.ts:165/193/229/242`）。

**(b) 三类护栏是否覆盖所有主 chat 执行分支（结论：覆盖「完整走完一轮」的分支，2 类早退不记）**
- 判定点 `decideBeforeIteration()`（`:8851`）在每轮 LLM 请求前；记录点 `recordTurn`（`:9309`，含 `allToolsFailed :9312` / `hadVisibleText :9315`）与 `recordToolCalls`（`:9329`）在「LLM 响应 + 工具执行」之后。
- **请求前/请求中早退（不记护栏，属「请求未发生/被中断」，合理）**：`:8824`/`:8831`（会话 null/interrupted/failed）、`:8890`/`:8902`（工具挂起/等待用户）、`:8983`（构造请求后中断检查）、`:9116`（`InjectInterruptError` continue 进入下一轮）、`:9171`（响应后中断检查）、`:9291`（`ask_permission` 分支 return）。
- **请求后早退（在 `:9309` 之后，护栏已记 ✓）**：`:9333`（isInterrupted）、`:9351`（refusal）、`:9355`（waitingForUser）。
- **`decideBeforeIteration` 不通过**（`:8873` return）是护栏自身生效出口 ✓；`:8844-8849` `acknowledgeAndContinue()` 用户放行清零为有意分支。
- **具体盲点（⚠️）**：`:9291` `ask_permission` 分支在 `recordTurn`/`recordToolCalls` **之前** return → 模型已产出工具调用但等待审批的轮**不计入重复调用/连续失败/空转计数**；若模型连续多轮输出相同工具调用且每轮触发审批挂起，重复调用护栏不会累计。
- 另：`runEphemeral` 临时会话复用主循环但 TurnGuard 按 sessionId 独立实例（定义 `:4332`；主循环入口 `:8725` `this.getOrCreateTurnGuard(sessionId)`，`:8723-8724` 注释「主会话与并行临时会话各持有独立实例」；新建会话 `:4404` `resetTurnGuard(sessionId)`），会话结束 `dropTurnGuard`（定义 `:4384`、调用 `:11016`）删除 → 跨临时会话计数不持久（设计如此，非缺口）。**行号自检更正（见 F-5f）**：`decideBeforeIteration()` 调用点是 `:8851`，`:8839` 是同轮稍早的 `getOrCreateTurnGuard` 取值（跨组消息曾把 `:8834/:8839` 并列写作 `decideBeforeIteration`，以实测 `:8851` 为准）；原写 `:4402-4404` 含注释行，精确到调用行 `:4404`。

**(c) 新发现：`:4691` 轮次口径错配（P2，见 D-P2-6）**
- `toolCallCount()`（`:4683-4687`）读 `entry.toolCalls.length`；而 `entry.toolCalls` 在 `:9336-9349` 的 `updateSessionEntry` 中**每轮被覆盖为本轮工具调用数组**（`:9341`），`:9277-9290` ask_permission 分支同样覆盖 → 该值是**单轮工具调用数**，不是累计轮数。`:4691` 拿它与语义为「轮数上限」的 `options.maxToolRounds`（`team-adapter.ts:191` 默认 8）比较，口径错配；200ms 轮询（`:4695`）还可能漏过快速连续轮。后果：单轮多工具可能误触发 abort，多轮各 1 工具则预算永不触发（与事故「40 轮无熔断」同型，幸有内层 TurnGuard 三类护栏兜底）。已列入 D-P2-6。

---

## F. 跨组线索复核（review-misc / review-p5，2026-11-08 追加，只读）

> 本节复核两条由同组审查员同步、与「跨层边界」重合的线索。口径同前：只判定**仍存在**的同类缺口，不把「本轮已修复」重复报成新问题；无法实测的标 ⚠️ 并说明缺什么。证据行号均为本轮重新只读核实所得。

### F-1　review-misc P1-3「`confirm_previous` 重放跨组调用链」——缺失环节已补齐，**结构性确证 ❌，但修复主链有效**

**直接答复 review-misc 标 ⚠️ 缺的那一环**：`session.ts` 的 `confirm_previous` 消费方**既不从上次 run 状态构造 `failureContext`，也不存在「拒绝裸重放」门禁**。

| 核对项 | 结论 | 行号证据 |
|---|---|---|
| 消费方是否读 run 状态重建失败上下文 | ✗ 否 | `consumeConfirmPreviousDecision`（`:5675-5695`）`:5686` 只读 `stored.failureContext`；不读 `autonomousGoalRuns`、不调 `findFailedAutonomousRun`（`:5922`） |
| 消费方是否有「裸重放」门禁 | ✗ 否 | `:5677-5680` 唯一门禁是「快照存在」，无「第三参必须非空」断言；`:5667-5668` doc 明示「不做跨 run 失败守卫」；`:5686` 把可能为 `undefined` 的第三参直传 `buildAutoExecuteCommand` |
| `autonomousGoalRuns` 是否流向消费方 | ✗ 否，只流向 LLM | `:5431` 注入 suggester；类型 `eag/dynamic/eag-dynamic-suggester.ts:186-191` 仅 `{goal, finalStatus, endedAt}`，**不含 `abortReason`/`failedTestIds`**，仅作 LLM 决策提示 |
| `confirm_previous` 决策对象本身 | 不带失败状态（但非缺陷） | `eag-dynamic-suggester.ts:113-120` 仅 `messageToUser`/`reasoning`、`:404-409` 同；`previousSuggestion`（`:185`）仅 `{commandHint, goal}`，经 `eag/dynamic/prompts/eag-suggestion-prompt.ts:76-78` 渲染为 LLM「指代确认识别依据」。二者是**指针/提示**，不是失败状态载体 |
| 消费方调用点数 | 2 | `:5504`（suggester `confirm_previous` 分支）、`:5155`（`direct_chat` 降级后的确定性逃生门，`startsWithConfirmExecutePhrase` 定义 `:1464`）；共用同一方法，行为一致 |

**`failureContext` 由哪个写入方决定（这才是根因）**：快照类型 `EagDisplayedSuggestion`（`:1397-1408`）注释明确「仅 `notifyFailedGoalBlocked` 拦截时写入；普通 `suggest_*` 展示快照无此字段」。全仓 `lastEagDisplayedSuggestions.set` 共 3 处：

| 写入方 | 行号 | 是否带 `failureContext` |
|---|---|---|
| `notifyFailedGoalBlocked`（D2 硬拦截） | `:5959-5963` | ✓ 仅 `failureContext !== undefined` 时（真实诊断存在） |
| `suggest_*` 展示路径 | `:5515-5518` | ✗ `{commandHint, goal}` |
| `degradeExecuteToSuggestion` | `:5640` | ✗ `{commandHint, goal}` |

而 D2 守卫 `findFailedAutonomousRun`（`:5585-5593`）**只挂在 `execute_command` 决策**（`:5497-5499`）；`suggest_*` 路径 `:5507-5530` 与 `confirm_previous` 路径 `:5503-5505` 均**不做**跨 run 失败判定。

**由此「用户执行这个 → 裸重放不带失败原因」在结构上可重现（4 条通道）**：
1. `suggest_*`/降级展示快照（`:5515-5518`/`:5640`）被 `confirm_previous` 消费 → `:5686` 第三参 `undefined` → `buildAutoExecuteCommand` 逐字零回归裸重放（触发依赖 LLM 输出 `suggest_*` 而非 `execute_command`，⚠️ 未实测）；
2. 即便走 `notifyFailedGoalBlocked`，`buildGoalBlockedDiagnostics`（`:1553-1556`）在 `abortReason` 与 `failedTestIds` **同时为空**时返回 `{diagnosticBlock:""}`、无 `failureContext` → `:5962` 不写字段 → 裸重放；`:5936-5937` doc 自认「无真实诊断（旧记录 / 取不到终止原因）时…重放命令与修复前逐字一致」。与 D-P2-3（`:7914` 异常路径 `abortReason` 丢失）叠加；
3. D-P1-1 知情重试 `:5601` 两参裸重放；
4. D-P1-2 Web 拦截路径（见下）。

**边界（不夸大，必须同时写明）**：事故主链「D2 硬拦截 → `notifyFailedGoalBlocked` 带真实诊断 → 用户回复『执行这个』→ `confirm_previous` 消费」**确实带 `failureContext`，本轮修复有效**（`session-eag-goal-failure-guard.test.ts` N6 `:421-463`、N11 `:823-858` 零回归 oracle、N12 `:921` 断言重放须含「【重放约束】」均覆盖）。故结论**不是「修复无效」**，而是：`failureContext` 的覆盖是**按快照写入方**而非**按消费方强制**——消费方零门禁，只要快照来自其它写入方或诊断为空即退回裸重放。建议 review-misc 把 P1-3 由 ⚠️ 升级为 ❌（结构事实已补齐），措辞保留「修复主链有效、残留为旁路」限定。

**CLI / Web 两个跨包消费方结论**：
- CLI `packages/cli/src/ui/views/App.tsx:1282-1348`：finally 兜底块**存在**，但**不**消费 `confirm_previous`、**不**调 `buildAutoExecuteCommand`、**不**构造 `failureContext`；EAG 分支 `:1344-1345` 以 `extractSuggestedCommandText` 抽出的裸命令串纯文本注入标准 prompt 路径 → `handleEagIntentResolution`（`:5105-5106`，豁免门 `:5091-5097`）→ suggester → D2 守卫 → core 的 `notifyFailedGoalBlocked` 在下游生效。CLI 本身不是裸重放构造点。
- Web `packages/web/src/session-pool.ts`：`:1420` `buildAutoExecuteCommand` 两参；`:1433` `hasFailedAutonomousRun` 命中后 `:1440` 只推硬编码泛化文案。**全 `packages/web` 检索 `failureContext|lastEagDisplayedSuggestions|notifyFailedGoalBlocked|confirm_previous|重放约束|上一轮诊断|buildGoalBlockedDiagnostics` 零命中**（本轮实测）→ Web 拦截路径**不写任何 core 快照**，用户按 `:1440` 提示回复「执行这个」时 `lastEagDisplayedSuggestions` 无本次拦截的带诊断快照；`:1476-1477` 注入命令文本走 `runTurn` 与用户消息同路径，仍回 core，但拦截这一轮未留快照。⚠️ 最终落到 core 后由 LLM 重新决策（可能二次拦截 / 交回主对话）需运行时复核，不臆断。

**对 review-misc 诊断措辞的一处精确化（非否定）**：`confirm_previous` 类型（`:113-120`）与 `previousSuggestion`（`:185`）不带失败状态**本身不是缺陷**——前者是对快照的指针，后者只是 LLM 的指代识别提示。真正决定因素是 core 的 `lastEagDisplayedSuggestions` 由哪个写入方填充；这样定位可避免把修复点错放在 suggester 类型上。

### F-2　review-p5 B-1/B-2 并入跨层条目（不单列 p5 文件问题）

- **闭环互相印证**：`autonomous-orchestrator.ts:390`（类型）→ `:1255`（读 `artifacts.failedTestIds`）→ `:1722`（挂顶层）字段名/嵌套一致；`:1248-1272` 去重保序上限 20；`:387-388` 注释 `failedTestIds` 与 `blockageReport.summary` 解耦。与本报告 B 节 `failedTestIds` 行一致。
- **新增跨层事实（`failureContext` 的下游落点）**：`packages/core/src/eag/` 全目录检索 `failureContext` **仅命中 `suggestion-auto.ts:256/262/265/277`**，`p5/`/`cli/`/`dynamic/` 零命中；`AutonomousRunRequest`（`autonomous-orchestrator.ts:267-310+`）**无 `failureContext` / 任何上一轮失败上下文字段**。因此本轮修复的 `failureContext` **只能以「追加进 `--goal` 的纯文本」进入新 run**：`suggestion-auto.ts:277` 拼进 `--goal` → `eag/cli/eag-autonomous-command.ts:465` `objective: request.goal` → `AutonomousRunRequest.objective`。**新 run 没有结构化字段接收它**，编排器无法把它当可判定状态。
- **跨 run 失败记忆的第二（也是 P5 侧唯一）来源**：`plan-stage-handler.ts:1036` `loadPreviousRunContext(ctx.projectRoot, ctx.runId)`（定义 `:180-250`，全仓唯一调用点）读 `.eag/p5/run-state/*.jsonl` **末行** `abortReason`（`:214`/`:228`）拼文本（`:242-248`），`:249` `text.slice(0, 1500)` **head-only 截断**（常量 `:163` `PREVIOUS_RUN_CONTEXT_MAX_CHARS = 1500`）。该被截断文本经 `:1392-1393` `previousRunContext` / `lastFailureFeedback: previousRunContext` 透出（`:1391` 注释「审计 + F-C dev 阶段失败反馈注入的数据源」）→ **dev 阶段能拿到的全部跨 run 失败反馈就是这段 ≤1500 的 head-only 文本**；异常路径 `abortReason` 为空时连这段也只剩泛化模板（行号经复核，来源 review-p5 W1「B-2 补充」，属其范围、按转述引用）。
- **双机制同时失效（并入 B 节 `failureContext`/`abortReason` 行，放大 D-P2-3）**：若上一轮终态未落盘（`session.ts:7914` 异常路径 `recordAutonomousRunOutcome(..., {})` → `abortReason` 丢失），则 ① `buildGoalBlockedDiagnostics`（`:1553-1556`）无真实成因 → 无 `failureContext`（F-1 通道 2）；② `loadPreviousRunContext` 的 `abortReasonPart` 因 `prev.abortReason.length > 0`（`:242`）不成立而为空 → 新 run 从 P5 侧也拿不到失败原因。**两条记忆通道同源、同时为空**，裸重放完全无失败原因。这从 p5 侧支持 D-P1/D-P2-3 判断。
- **review-p5 的 p5 侧补充证据**（并入，不单列）：`:3737`/`:3741-3746` `summary` 即 `abortReason` 原文、为空时退化泛化模板；`:1688-1689` 仅 `aborted`/`failed` 生成 `blockageReport`，若 `orchestrator.run()` 自身抛异常未返回 result 则连 `blockageReport` 都没有；真实基线证据在 `rootCauseHypotheses`（`:3651-3659`）而非 `summary`。与 `:7914` 异常路径叠加印证 D-P2-3。
- **桩注释过期**：`session-eag-goal-failure-guard.test.ts:666-668`（「真实生产编排器目前不透出 failedTestIds…诚实降级为 undefined」）与生产 `:390`/`:1722` 矛盾；`:703`/`:705` `as unknown as AutonomousRunResult` 手工塞字段绕过 `:1248-1272`/`:1255` 真实汇总。双方结论一致，已在本报告 C.4-4 记录；review-p5 已作为「范围外记录」写入 W1 B-1，未改动其 26 文件结论与计数，尊重其边界。
- review-p5 主发现（`orchestrator.ts:1197-1199`/`:3050-3068` + `fix-stage-handler.ts:278-289`/`:673-689` 基线拆分未贯通修复指令链路）与本跨层发现不重叠、并列。

### F-3　报告自检更正（A 节 #3 一处措辞）

- 原 A 节 #3 证据列写「`:16-23` 头注释仍称 CLI `App.tsx` finally 兜底，全仓 `packages/cli` 已无该调用（**注释过期**）」。**复核后判定有误，予以更正**：`App.tsx:1282-1348` 的 finally 兜底块**确实存在**，且 `:1315` `parseSlashCommandKind`、`:1320` `AUTO_EXECUTABLE_COMMAND_KINDS.has`、`:1329`/`:1345` 自动注入与 `suggestion-auto.ts:12-23` 头注释描述的 2/3/4 层逐条对应，头注释**未过期**。
- 准确事实：`packages/cli` 全目录**不调用 `buildAutoExecuteCommand`**（该函数仅 `core/src/index.ts:1350` 导出、`web/session-pool.ts:1420`、`session.ts:6021` 委托、及测试使用）；CLI 的 EAG 分支 `:1344-1345` 注入 `extractSuggestedCommandText` 抽出的裸命令串（可能含 `--goal` 参数），不构造 goal 散文、不构造 `failureContext`，失败拦截依赖 core 下游 `notifyFailedGoalBlocked`。
- A 节 #3 结论档位**不变**（仍 `⚠️ 疑似需复核`），四档计数不变；仅更正证据措辞。已同步改 A 节表格该单元格。

### F-4　护栏/重试「携带上轮状态」正向对照（review-misc 提供，可引用）

- `eag/assembly.ts:233-245`（loop executor 重试把上轮 `feedback.reason`/`findings`/`suggestedFix` 拼进 `nodeTask`，「带着反馈重试」）—— 属「重试携带上轮状态」的正确实现对照，与 A 节 #11 `✅` 一致，且在本审查范围内，已复核。
- `tcs/ldap-adapter.ts:385-391/443-495`（游标前进双保险）、`handover-doc-builder.ts:130-165`（降级章节带 `inferred` 标注）—— 不在本审查范围，按 review-misc 结论作为对照引用，未逐个精读，标 ⚠️ 不自证。

### F-5　review-loops W2「每类执行器空转收口点」并入 E-2 / D-P2-4 / D-P2-5 / E-3（2026-11-08，只读）

> 来源：review-loops 对 loop/graph/long-horizon 三目录逐文件复核，完整报告 `/tmp/dcx-eag-review-W2.md`。**这些文件不在本审查范围**；我只核实了将要引用的关键行号（`session.ts :8851/:8725/:4332/:4384/:4404/:11016/:5908/:5914-5916`、`graph-loop-orchestrator.ts :324/:347/:467/:546/:817/:848/:868/:900`、`team/plugins/loop.ts :116`、`eag-graph-command.ts :598-600` 均已实测），结论按转述引用、标注来源，不冒充本组精读，不改变四档计数。

**(a) 主 chat / P5 / team CLI 委托链护栏归属（与 E-2、E-3 一致，补充行号）**
- 主 chat 三类护栏实例化/调用只在 `session.ts`：`:8725` 每轮 `getOrCreateTurnGuard(sessionId)`（定义 `:4332`）、`:8851` `decideBeforeIteration()`、`:9309` `recordTurn`（`:9312 allToolsFailed` / `:9315 hadVisibleText`）、`:9329` `recordToolCalls`；定义 `common/loop-guard.ts:163`，`index.ts:396` re-export。注：跨组消息把 `:8839` 并列写作 `decideBeforeIteration`，实测 `:8839` 是同轮 `getOrCreateTurnGuard` 取值、`:8851` 才是判定调用，以 `:8851` 为准（已同步 E-3）。
- P5 双轨：`eag/p5/executors/llm-task-executor.ts:1020-1029`（轨道 A 结果指纹 `noProgressStreak` + 轨道 B git 工作区快照）、`:1780-1800`（`effectiveNoProgressLimit` / `explorationLimit` 收口）。
- **team CLI 委托链不绕开护栏**（与 E-2 主委托链结论一致）：`team-adapter.ts:876-891` → `packages/cli/src/team/team-runner.ts:88` `runEphemeral` → `session.ts` 完整主循环，带 `:4689-4695` `maxToolRounds` 轮次预算 + `:8725` TurnGuard。不要把它当成第三条裸路径。

**(b) 每类执行器空转收口点（逐条行号，来源 W2）**
| 执行器 | 主循环 | 收口机制 | 含「工作区/结果指纹」无进展判定 |
|---|---|---|---|
| `loop/kernel.ts:158` `while(!stop && iterIndex < maxIterations)` | :158 | `maxIterations` 默认 50（`loop/models.ts:250`）+ `loop/scheduler.ts:61/70` 连续失败阈值 3(human_checkpoint)/5(stop_failure)、`:230` 轮数上限、`:255-267 decideNext`；`:341-342 shouldStopWhen` 用 `slice(-3)` 关键词匹配 | ✗ 无 |
| `graph/node-loop-kernel.ts:304` `while(iteration < loopConfig.maxIterations)` | :304 | `maxIterations`（`:707-725` 由 `NodeLoopConfig` 注入）+ `:356-360 consecutiveFailures`；`:349-352` 图场景 human_checkpoint 自动批准继续；`:443/587-593` feedback 只传上一轮 `lastVerdict`、无 resume 入口 | ✗ 无 |
| `graph/graph-loop-orchestrator.ts:326` 主遍历 | :326 | `MAX_TRAVERSAL_STEPS=10000`（`:76`）+ `:560-566` 撞顶置 `traversalStepLimitReached` + `:1093-1145 determineFinalStatus`（对上限 / prematureStop / isolated 均诚实判 failed，**属已修复点，不重复报**） | ✗ 无 |
| `graph/graph-scheduler.ts:167-229` | — | 超时 `:169`、token `:186-193`（`tokenBudgetHardStop=false` 仅告警、诚实降级）、深度 `:203`、连续节点失败 `:219`、总重试 `:229`；`:289-293 reset()` 存在但 `setGraph()` 不调用（跨 run 计数污染，W2 标 ⚠️） | ✗ 无 |
| `graph/graph-guard.ts:274-324` pre / `:375-399` post / `:478` BFS、`:530` DFS | — | `visited` / `inStack` 防环；`:76-83` 默认 `tokenBudgetHardStop:false`；`:705-717` 自定义规则 catch 返回 `pass:false`（诚实） | ✗ 无 |
| long-horizon `eag-run-handler.ts:566` 节点遍历 | :566 | 依赖满足检查 `:568`、`humanInterventionCount>=3` `:641`；`eag-resume-handler.ts:412` 续跑遍历唯一上限 `maxIterations=30`（`types.ts:867`） | ✗ 无 |
| `design-orchestrator.ts:137-174` `while(true)` | :137-174 | 收口仅 `:167` `maxIterations=3`（`design-models.ts:515`）、无无进展判定；反馈闭环只在集成层 `design-roles-llm.ts:780-867`，经 `assembly.ts:503-531` 装配（已知 2 个生产宿主 `App.tsx:365`、`session-pool.ts:397` 均经装配，但 `session.ts:966` 注入类型开放、编译期不强制 → W2 标 ⚠️「缺调用方全覆盖证据」） | ✗ 无 |

**结论口径（review-loops 明确建议，与 E-2 的 ⚠️ 判定一致）**：这些自建循环收口靠的是「轮数 / 连续失败计数」，**没有重复 tool call、连续工具全失败、连续空转轮、工作区快照 / 结果指纹**的等价物 → 「换命令探索即空转」风险确实存在；但因有 `maxIterations` / `MAX_TRAVERSAL_STEPS` / `consecutiveFailures`，**不降为 ✅、也不写「无上限裸奔」**。E-2 的 ⚠️ 保持。

**(c) 可升级为 ❌ 的确证残留：`graph/graph-loop-orchestrator.ts:776-934` fork 分支**
- 已核实：主遍历护栏点 `checkPreExecution :347`、`checkPostExecution :467`、`decideNext :546` 均在 `:324-:549` 主路径（`nodeRetryCounts` Map 定义 `:324`）；fork 分支 `:868` `const result = await this.nodeExecutor.execute(targetNode, branchInput, branchContext)` **直接调用节点执行器**，不经上述三处，且 `:817` / `:848` / `:900` 三处 `retryCount: 0` 固定、不入 `:324 nodeRetryCounts` → 该分支确证绕开护栏。行号已逐条实测，结论转述自 review-loops W2（其已按 ❌ 处理）。因该文件不在本审查范围，我仅在 E-2 补充引用，**不新增独立 D 条目、不改动四档计数**，避免与 W2 双计。

**(d) long-horizon 的 P0 属「失败反馈 / 状态丢失」，不是护栏覆盖，E 节分开写**
- 来源 W2（本组未精读、按转述引用）：`run-state-store.ts:1063-1074` 完整重放 human-intervention 不改 status、`:987` status 初值 `running` → `eag-resume-handler.ts:393` `status==="human-checkpoint"` 永不触发（配合 `eag-run-handler.ts:813-834` human-checkpoint 无终态事件）；`:1194-1196` 轻量重放反而置 human-checkpoint，两套口径冲突。属确证 P0，但性质是状态 / 失败反馈丢失，与 E-2 护栏覆盖分开归类，**不计入本报告 P0**（本报告 P0「无」仅指本审查范围 12 文件的正常终态路径）。

**(e) D-P2-5 措辞收窄（已同步改 D 节）**
- `eag-graph-command.ts:598-600` 把 `aborted` 判 `success=true` 与 `session.ts:5908` `finalStatus !== "completed"` 把 `aborted` 判失败目标，语义相反但**作用域不同**（前者「命令返回给用户的 success」，后者「跨 run 失败守卫的历史指纹，用于跳过自动注入」）→ 不定性为「把失败说成通过」，保持 P2，措辞收窄为「同一 aborted 终态在两处语义口径不一致」。真正贴切「把失败说成通过」的对象是 `team/plugins/loop.ts:116`（实测 `exitReason="max-iterations"` 收口后仍 `return this.ok(...)` succeeded），属 review-loops 范围、W2 已按 ❌ 处理，本处仅转述引用、不重复计数。

**(f) 行号自检更正（已同步改 E-3）**：每会话实例化 `:8725`（非 `:8719-8725` 全段）、`resetTurnGuard :4404`（原写 `:4402-4404` 含注释行，精确到调用行）、`dropTurnGuard` 定义 `:4384` / 调用 `:11016`；`decideBeforeIteration` 是 `:8851`（`:8839` 为 `getOrCreateTurnGuard`）。这些是精确化，不涉及结论档位变化。

---

## 附：给 team-lead 的最终汇总口径
- 文件总数 **12**（A 节逐行覆盖，无省略）
- 四档结论计数：**✅ 5 / ⚠️ 3 / ❌ 2 / ➖ 2**（E-1 把 `context-budget.ts` 由 ⚠️ 升 ❌；F-3 更正 A#3 措辞但档位/计数不变）
- 契约矩阵：**7 字段主链路闭环一致**（review-p5 二次印证），但 `failureContext` 存在 **4 条不带失败状态的旁路**（`:5601` 知情重试、`web/session-pool.ts:1420` Web、`suggest_*`/降级快照 `:5515-5518`/`:5640`、`buildGoalBlockedDiagnostics` 空诊断 `:1553-1556`），且新 run 无结构化字段接收（F-2）；`abortReason` 异常路径 `:7914` 降级丢失 → **未完全闭环**
- 无测试的高风险生产文件数：**11**（零测试 import 且零内容提及，已排除模板/fixture/纯类型）
- Top 发现：**P0 0 / P1 4 / P2 6**；核心行号 `session.ts:5585/5601/5686/5515-5518/5640/5959-5963/1553-1556/7914/4691/9291/8851/8725`、`web/session-pool.ts:1420/1440`、`context-budget.ts:128-135/338/359/378/350-382`、`eag-config-loader.ts:126-146`、`autonomous-orchestrator.ts:267-310`/`:390`/`:1722`、`plan-stage-handler.ts:163/180-250/1036`、`graph/graph-loop-orchestrator.ts:868`（fork 分支，转述 W2）、`team/plugins/loop.ts:116`（转述 W2）、`session-eag-goal-failure-guard.test.ts:412/666-668/703`
- 跨组复核已含三方：review-misc W5（confirm_previous 消费链，F-1）/ review-p5 W1（p5 侧 B-1/B-2，F-2）/ review-loops W2（每类执行器空转收口点，F-5）；均标注来源、只核实引用行号、未改四档计数、未把跨组已修复项重复报成新问题
- 报告结构：A / B / C / D / E（lead 三条线索）/ F（跨组复核 F-1~F-5，含 F-3 自检更正）/ 附
- 输出文件：`/tmp/dcx-eag-review-W6.md`
