# EAG 全量同类问题审查 — 修复实施报告（2026-11-08）

> 依据：`docs/proposals/super-agent/eag-full-review-20261108.md` §11「建议修复顺序」
> 基线：`892938aa fix(eag/p5): 全链路修复 bash 多轮空转与基线红灯误判`
> 状态：**实施与验证完成**（core 全量 8664/8646/0/18 skipped、Web 全量 689/689/0、`npm run check` exit 0、bundle exit 0）
> 红线：默认诚实降级、新行为一律带可回退开关、禁止改既有测试刷绿、以仓库实测为准

---

## 1. 实施范围与组织方式

按审查报告 §11 的 6 批建议，把 47 个生产文件按**互不重叠的文件所有权**拆成 6 个并行实现组，每组只改授权路径、只跑定向测试；全量回归、冲突检查、格式修复、跨 workspace 类型检查、bundle、报告与提交由 lead 统一处理。

| 组 | 目录 / 文件所有权 | 对应审查项 |
|---|---|---|
| G1 | `long-horizon/` `graph/` `loop/` `team/plugins/` | P0-1 / P0-2 / P0-3 + 自建循环无进展判定 |
| G2 | `testing/` `coding/static-checkers/` | P0-4 / P0-5 + 同组 P1 确证项 |
| G3 | `devops/` `deploy/` `gate/` | P0-6 / P0-7 / P0-8 + 空集合通过 / 默认 fail-open |
| G4 | `p5/` | P1-5 基线红灯拆分贯通修复指令链路 |
| G5 | `session.ts` `context-budget.ts` `eag-autonomous-command.ts` `web/session-pool.ts` | P1-1 / P1-2 / P1-2b / P1-3 / P1-4 |
| G6 | `icp/` `tcs/` `evidence-bundle` `report-render` `intervention-ledger` `dynamic/` | 证据保尾、对象存储谎报删除、合规空集合、报告降级标注 |

**改动规模**：47 个生产文件 + 5 个既有测试文件 + 7 个新建测试文件 + 3 项文档；生产 diff `+2803 / -471`；新增 84 个回归用例。

---

## 2. 8 条 P0 逐条落地

| # | 审查发现 | 落地方式 | 状态 |
|---|---|---|---|
| P0-1 | 失败 run 重放成 `running`，resume 检查点永不触发 | `run-state-store.ts` 抽出 `applyStatusEvent()` 纯函数状态机，`load()` 完整重放与 `listRuns()` 轻量重放**共用同一事件→状态映射**；补 `human-intervention → human-checkpoint` 迁移与 `blockedReason`；`eag-run-handler` 终态写 `run-paused{humanCheckpoint:true}`；`eag-resume-handler` 在追加事件前固化 `statusAtLoad` / `blockedReasonAtLoad` | ✅ |
| P0-2 | graph fork 分支绕开图级护栏与调度器 | `executeFork` 接入 `nodeRetryCounts`，补 `checkPreExecution` / `checkPostExecution`；分支结果经 `decideNext` 纳入调度决策；`retryCount` 不再硬编码 0；护栏拦截返回 `status:"failed"` 并写明真实原因 | ✅ |
| P0-3 | resume 裸重放、不复用产物 | `EagResumeRequest` 新增 `failureReason` / `failedTestIds` / `blockedReason` / `specContent` / `plan` / `tasksContent` / `completedNodeIds`；`RunStateStore` 新增 `saveResumeSnapshot()` / `loadResumeSnapshot()`（`<runId>.snapshot.json`，runId 白名单防穿越）；resume 优先复用原 plan 与已生成 spec/tasks，损坏/缺失时**诚实回退**重新生成 | ✅ |
| P0-4 | 测试执行边界失败证据整体消失 | `TestExecutionResultWithEvidence` 新增 `stderr` / `failedCases` / `errorMessage` / `stdoutSnippet`；`buildTestExecutionResult()` 导出为纯函数；失败证据透传 G-7 上下文与 `generatePrDescription()`；解析失败保留原始 stdout/stderr 片段并写明原因 | ✅ |
| P0-4 收尾 | `--test-reporter=json` 在 Node 22 不存在（**lead 独立发现**） | 见 §4.4 | ✅ |
| P0-5 | PKC 查询失败吞错 → 覆盖率恒 100 | 新增 `computeHighRiskSymbolsCoverage()` 纯函数，`pkcUnavailable` 返回 0；`check()` 标记 `pkcUnavailable` / `pkcError` 并 fail-closed，绝不把「无法判定」算成 100%；新增 `c8RawReport` 可选预采集入口供确定性单测 | ✅ |
| P0-6 | G-8 监控 + 回滚预案 `?? true` 恒真放行 | `DevOpsOrchestrator.resolveGate8Readiness()` 优先调用真实检查器并以 `ready` / `exists&&valid` 为准；未注入时默认 `false`；G-8 未通过时附带真实检查器证据；`DeployResult.errors` 在 `success=true` 分支也收集；按 `result.success` 选择 `devops-completed` / `devops-failed` | ✅ |
| P0-7 | 回滚验证 `0/0 → 0>=0` 报成功 | `rollback-manager.ts` 解析失败显式标记并判失败；`verifyRollback` 要求副本数合法且解析成功；非法 JSON / null / 非法数值均不得 `success:true` | ✅ |
| P0-8 | 监控就绪「信息不足即通过」 | 缺 `prometheusConfigPath` → `skipped:true` / `passed:false` / `ready=false`；`ready = checkedItems.every(item => item.passed && item.skipped !== true)`；failures 显式披露校验未执行 | ✅ |

---

## 3. P1 / P2 主要落地项

**P1-1 知情重试第三参**（`session.ts:5580`）：`acknowledgeFailedGoal=true` 放行时取 `findFailedAutonomousRun` 真实诊断，作为 `buildAutoExecuteCommand` 第三参注入 `--goal`；无真实诊断时诚实保留 `undefined`，逐字零回归。

**P1-2 异常终态 abortReason 落盘**（`session.ts:7956`）：`handler.execute()` 抛出的真实 `errMsg` 作为 `details.abortReason` 落盘，不再传空 `{}`；只放真实错误文本，不编造归因。

**P1-2b 逃生门消费门禁**（`session.ts:5696`）：裸快照（无 `failureContext`）时实时重建上一轮诊断约束，避免展示通道绕开 `notifyFailedGoalBlocked` 形成裸重放；带真实诊断的快照直接透传。

**P1-3 context-budget 第 1/2/3 级证据保留**（`context-budget.ts`）：整条丢弃占位改为用 `truncateToolOutput` 在 20% 子预算内抽取「头部 + 失败窗口 + 尾部」真实证据；极小预算（<200 字符）退化仍保尾；开关 `DEEPCODEX_CONTEXT_DROP_EVIDENCE=0` 可逐字节回退。

**P1-4 Web 拦截提示诊断段**（`web/session-pool.ts:1431`）：core 新增 `SessionManager.getFailedAutonomousRunDiagnostics()` 作为单一事实源，Web 命中失败守卫后拼接「【上一轮诊断】」段；无记录 / 无真实诊断返回空串（诚实降级）。

**P1-5 p5 基线拆分贯通**：`P5StageContext` 新增 4 个投影字段；`buildVerifyFailureFeedback()` 仅在 `baselineAvailable && canSplit` 时消费 `newFailedTestIds`，`baselineOnly===true` 明确标注「全部失败为 run 起始既有红灯、无需改代码」；`fix-stage-handler` 新增 `resolveFixFailureIds()` 三级取值；顶层 `failedTestIds` 契约与 `EAG_BASELINE_GUARD=0` 完全未动。

**其余 P2**：凭据值扫描改「首 8192 + 尾 8192」双窗口、跨 run 记忆改头尾保留、合规证据 `slice(-1000)` 保尾、tcs `delete()` 不再谎报 `permanent:true`、合规空集合 `overallPassed=false`、证据包 `manifest.degradedSources` 降级标注、报告空态区分「无数据」与「数据源失败」、干预台账非法 verification 不再静默丢弃、沉淀取最近 30 轮保尾、报告渲染失败用例段。

---

## 4. lead 独立复核与修正（不采信 worker 自报）

### 4.1 INT-B 基线遗留红灯：`7 !== 8`

`892938aa` 引入 `skipDevAfterFix` 后 iter1 dev 不再调用 `taskExecutor`，但 `eag-p5-llm-execution-integration.test.ts` 仍按 8 次 LLM 请求断言，且该测试未进上一轮回归清单。lead 独立复现（2/1/1，`7 !== 8`）→ 核对 `892938aa` diff 确认只改了 5 个测试文件 → 删除桩脚本第 8 项响应、断言改为 7，并补充 **fail-loud 正向守护**：`StubLlmClient` 脚本耗尽会抛错，若跳过逻辑失效导致 iter1 dev 又发起 `createMessage`，第 8 次调用即撞上脚本耗尽使 run 失败；若少一轮则 7 不相等而失败。定向复验 **2/2/0**。

### 4.2 SD-03 失败：环境伪失败，已 A/B 证伪

第 6 组报告 `packages/web/tests/eag-web-sedimentation.test.ts` 的 `SD-03` 失败并自报「非本组引入」。lead 不采信，做严格 A/B：

| 运行方式 | 结果 |
|---|---|
| 官方 runner 环境（剥离 `NODE_OPTIONS` shim） | `# pass 1 / # fail 0` ✅ |
| 保留宿主 `--require node-brokered-fs-shim.cjs` | `# fail 1`，`experience.json 必须存在` ❌ |

根因：宿主注入的 `node-brokered-fs-shim.cjs` 在子进程里让 `appendFile` 报 `ENOENT`，`execution-history.jsonl` 未落盘 → `experience.json` 缺失。官方 `packages/web/tests/run-tests.mjs` 的注释里就写明「2026-10-30 SD-03 定位」并专门剥离该 shim。**结论：不是代码回归；Web 测试必须走官方 runner，直接 `node --import tsx --test` 会产生假红灯。**

### 4.3 7 个既有测试红灯：契约同步更新，非刷绿

独立跑 devops/deploy/gate 26 文件集复现 `679 tests / 666 pass / 7 fail / 6 skipped`。7 个红的是：

```
T7a / T7b            空 endpoints / testCases 时 passed=true（空集合视为通过）
TC-G8-004d           未提供 prometheusConfigPath 时视为通过（K-4 决策简化）
T3 / T4 / T10b / T13 默认宽松覆盖 → allPassed=true / firstFailedGate=null
```

先核实**不是过度收紧**：`GateOrchestrator` 默认 checkers 只有 G-1/2/3/6/7，而 coding loop 要求 G-1..G-5，即默认构造必然缺 G-4/G-5；报「全绿」本就是谎报。且全仓 `new GateOrchestrator` 无生产构造点（仅注释/声明出现），默认语义变更不会误伤装配链路。

处理方式：lead 亲自改这 3 个既有测试文件，**不删用例、不降断言强度**，每个改用「新默认诚实语义断言 + 同用例内 A/B 回退对照」（`EAG_LEGACY_PASS_THROUGH=1` 或 `strictGateCoverage:false`），正向证明修复与回退开关都生效。另更正 T15 标题中已过期的「不判失败」措辞。

守恒验证：`eag-deploy-smoke-test-runner` 18→18、`eag-devops-monitoring-rollback-checkers` 47→47、`eag-gate-orchestrator` 18→18，用例数完全不变。全仓 diff 无新增 `.skip` / `.todo` / `.only` / `as any` / `@ts-ignore`。

### 4.4 reporter 生产缺口：本轮闭环

第 2 组如实交出「`--test-reporter=json` 命令字符串未改」并请求裁决。lead 独立复现：`node --test --test-reporter=json <file>` 在 Node v22.22.2 下 `EXIT=7` / `ERR_MODULE_NOT_FOUND: Cannot find package 'json'`，仓库根无 `node_modules/json`；内置可用 reporter 实测 `spec/tap/dot/junit/lcov` 全 OK。这意味着**每个测试文件都拿不到 JSON 报告**，`buildTestExecutionResult` 永远走 parseError 退化路径，P0-4 修的「失败用例名进证据链」在真实运行中永远取不到用例名——是 P0-4 的实际阻断点，不修等于交付无效修复。

精确规格发回第 2 组落地：默认改 `--test-reporter=tap`，新增 `buildTestRunnerArgs()` 与 `parseTap13()`（识别 `ok N - name` / `not ok N - name`，跳过 `#` / `---` / `1..N`，YAML 块内 `error`/`stack` 文本纳入证据），保持「JSON 单对象 → NDJSON → TAP」解析优先级，回退开关 `EAG_LEGACY_JSON_REPORTER=1`。lead 独立复跑 **25/25/0**。

### 4.5 跨 workspace typecheck 断裂：声明未重建

`npm run typecheck` 报 `web/src/session-pool.ts(1438): Property 'getFailedAutonomousRunDiagnostics' does not exist on type 'SessionManager'`。根因：Web 经 `packages/core/dist/index.d.ts` 解析类型，而该声明是 11-07 构建的、不含第 5 组新增方法；`dist/` 在 `.gitignore` 中，属构建产物。运行 `npm run build --workspace @vegamo/deepcode-core` 重建后 `dist/session.d.ts:1706` 出现新方法。

期间另一次 typecheck 报 `context-budget.ts(344) Cannot find name 'DROP_EVIDENCE_ENABLED'`，复查为**并行写入中间态**（文件 16:49:08 已被改为 `this.dropEvidenceEnabled`），写入收敛后消失，非真实缺陷。最终 `npm run check` **exit 0**。

### 4.6 两项「仅实现未验证」补测

第 5 组如实标注 Web 拦截提示诊断段与 `failedTestIds` 报告渲染「仅实现未验证」。lead 核实确实零覆盖后，新建 `eag-cross-layer-diagnostics-render.test.ts`（7 用例）：D1–D3 用真实 `SessionManager` + 白盒播种验证 `getFailedAutonomousRunDiagnostics`（命中真实诊断 / 无记录 / 目标不匹配 / 旧会话无诊断均诚实降级）；R1–R4 经真实 `EagAutonomousCommandHandler.execute()` 验证 `failedTestIds` 渲染（合法数组输出「## 失败用例」、缺失/非数组/空数组/脏数据不编造）。**7/7/0**。

### 4.7 core 全量套件报红：1 个契约 + 33 个 shim 环境伪失败

首次全量（保留宿主 `NODE_OPTIONS`）4 个 runner 结果：`src/tests` 6975/6957/0/18 skipped ✅、`team` 959/958/**1** ❌、`providers` 13/13/0 ✅、`v2` 568/535/**33** ❌。逐条归因，不合并处理：

**`team:650 LoopPlugin exits at max iterations`（真实契约变更）**：期望 `status="succeeded"`、实得 `"failed"`。核查 `team/plugins/loop.ts` diff 确认是审查要求的诚实修复——跑满 `maxIterations` 仍未命中退出条件不再报成功，并提供 `DEEPCODE_LOOP_REPORT_MAX_ITER_AS_SUCCESS=1` 回退。按 §4.3 同一方式更新契约为「新默认 `failed` + A/B 回退对照（`=1` 时恢复 `succeeded`）」，同时保留 `loopHistory.length===3` 与 `loopExitReason==="max-iterations"` 断言。复跑 team 全套 **959/959/0**。

**v2 的 33 个（环境伪失败，已 A/B 证伪）**：错误信息均为 `Broker request outcome unknown: Broker request timed out` / `CODEBUDDY_BROKER_OUTCOME_UNKNOWN`，栈顶指向 `node-brokered-fs-shim.cjs` 的 `wrappedPromisesMkdir`，单个用例耗时 20 秒（超时）；`sliding-window.test.ts` 等为文件级级联失败（耗时 275 秒），导致用例根本没跑全。剥离 shim 后单跑 v2 runner：**710/710/0 ✅**（10 秒完成，对比带 shim 的 568/535/33）。与 §4.2 的 SD-03 完全同源：`packages/core/src/tests/run-tests.mjs` 未剥离 `NODE_OPTIONS`，而 Web 的 runner 已处理。

> **结论**：core 全量测试必须在剥离宿主 shim 的环境运行，否则 v2 会稳定产生 33 个假红灯。这不是本轮代码引入的回归，也不改测试掩盖。


---

## 5. 可回退开关（默认一律诚实）

| 开关 | 默认 | 回退到 |
|---|---|---|
| `EAG_LEGACY_PASS_THROUGH=1` | fail-closed / 空集合判失败 / 信息不足不就绪 | 旧「默认放行 / 信息不足即通过」 |
| `EAG_COVERAGE_PKC_LENIENT=1` | PKC 不可用 → 覆盖率 0、门禁不通过 | 忽略 PKC 错误、空数组仍 100% |
| `EAG_DEPENDENCY_SCANNER_LENIENT=1` | 解析全失败不返回 passed | 旧宽松语义 |
| `DEEPCODEX_CONTEXT_DROP_EVIDENCE=0` | 丢弃占位保留真实证据摘要 | 修复前「仅字符数」占位 |
| `EAG_LEGACY_HEAD_ONLY_EVIDENCE=1` | 合规证据保尾 | 旧 head-only |
| `EAG_TCS_DELETE_RETURN_ERROR=1` | 删除异常抛错 | 返回 `permanent:false + error` |
| `EAG_LEGACY_JSON_REPORTER=1` | `--test-reporter=tap` | 旧 `--test-reporter=json` |
| `EAG_PR_DISPLAY_LEGACY=1` | PR 描述含真实失败证据 | 旧纯计数描述 |
| `DEEPCODE_NO_PROGRESS_GUARD=0` | 自建循环双轨无进展熔断开启 | 关闭熔断 |
| `DEEPCODE_NO_PROGRESS_LIMIT=N` | 无进展轮数阈值（默认 4） | 自定义阈值 |
| `DEEPCODE_LOOP_REPORT_MAX_ITER_AS_SUCCESS=1` | 达 max-iterations 判 `failed` | 旧 `succeeded` |
| `DEEPCODE_VERIFY_ALLOW_UNKNOWN_SUCCESS=1` | 无真实测试结果判失败 | 旧「failed=0 即成功」 |

> 共 12 个开关，全部**默认诚实、可一键回退**；扫描同时覆盖 `process.env.XXX` 与 `process.env["XXX"]` 两种写法。

---

## 6. 验证数字（全部为仓库实测）

| 项目 | 命令 / 范围 | 结果 |
|---|---|---|
| 本轮定向全集 | 14 文件（7 新测试 + 5 修改测试 + 2 context-budget） | **205 / 205 / 0** ✅ |
| devops/deploy/gate 全量 | 27 文件（含 3 个契约更新文件 + 第 3 组新测试） | **693 / 687 / 0 / 6 skipped** ✅ |
| 契约更新 3 文件 | smoke / monitoring / gate-orchestrator | **83 / 83 / 0** ✅ |
| 第 2 组 reporter 收尾 | `eag-testing-review-fixes.test.ts` | **25 / 25 / 0** ✅ |
| 两项补测 | `eag-cross-layer-diagnostics-render.test.ts` | **7 / 7 / 0** ✅ |
| 修复前 7 红灯复现 | 26 文件 | 679 / 666 / **7 fail** / 6 skipped |
| SD-03 A/B | 官方环境 vs 保留 shim | 1/1/0 vs 1 fail（环境伪失败） |
| 全仓门禁 | `npm run check`（typecheck + lint + format:check + IPC 契约） | **exit 0** ✅ |
| Web 全量套件 | `npm run test --workspace @vegamo/deepcode-web`（官方 runner，剥离 shim） | **689 / 689 / 0** ✅ |
| CLI 打包 | `npm run bundle`（先备份 `bundled` 规避 safe-delete shim） | **exit 0** ✅ |
| core 全量套件（**最终**） | 剥离宿主 `NODE_OPTIONS` 后跑 4 个 runner（见下方） | **exit 0，4/4 runner ✅** |

**core 全量最终明细**（`NODE_OPTIONS` 剥离 shim）：

| runner | tests | pass | fail | skipped |
|---|---|---|---|---|
| `src/tests/run-tests.mjs` | 6982 | 6964 | 0 | 18 |
| `src/team/tests/run-tests.mjs` | 959 | 959 | 0 | 0 |
| `src/providers/tests/run-tests.mjs` | 13 | 13 | 0 | 0 |
| `src/v2/tests/run-v2-tests.mjs` | 710 | 710 | 0 | 0 |
| **合计** | **8664** | **8646** | **0** | **18** |

> 首次全量测试在第 3951 个用例被 10 分钟工具超时 SIGTERM 中断（日志 0 个 `not ok`），改后台任务重跑；保留宿主 shim 的版本在 team/v2 报 1+33 个红，逐条归因见 §4.7（1 个契约已同步更新、33 个已 A/B 证伪为 shim 假红灯）。**两次全量都没有任何由本轮生产代码引起的失败。**

---

## 7. 诚实声明与未覆盖边界

1. **P1 其余与 P2 未全量覆盖**：本轮按 §11 完成前 5 批（8 条 P0 + 跨层 P1 + P1-5）与第 6 批的部分 P2；审查报告列出的 21 条 P1 / 20+ 条 P2 **未逐条全部实施**，逐文件结论仍以 `eag-full-review-file-index-20261108.md` 为准。
2. **Web 端到端未做**：`getFailedAutonomousRunDiagnostics` 已验证 core 单一事实源与报告渲染真实入口，`web/session-pool.ts` 的 SSE 拼接未在真实 HTTP/SSE 集成用例中断言。
3. **reporter 收尾边界**（第 2 组如实声明，lead 接受）：新增 25 个用例均为**纯函数**（喂入真实 TAP 输出）与 `buildTestRunnerArgs` 契约；没有「单条 1 pass + 1 fail 的生产 `TestingOrchestrator.run()` 端到端」用例。
4. **自建循环无进展判定**：`loop/kernel.ts` 双轨判据在 git 不可用时禁用轨道 B（避免误判），属设计取舍而非遗漏。
5. **7 个契约更新是行为变更的必然结果**：修复把「默认放行」改为「默认 fail-closed」，旧断言不可能继续成立；采用 A/B 双向夹紧而非改数字刷绿，用例数守恒。
6. **dist 声明是构建产物**：`packages/core/dist/` 不入 Git；Web typecheck 依赖该声明，干净检出后需先构建 core。

---

## 8. 交付清单

| 文件 | 说明 |
|---|---|
| `docs/proposals/super-agent/eag-full-review-20261108.md` | 全量审查主报告（只读阶段交付） |
| `docs/proposals/super-agent/eag-full-review-file-index-20261108.md` | 264 行逐文件结论索引 |
| `docs/proposals/super-agent/eag-review-20261108/` | 6 组原始报告 + lead 复核笔记 + 扫描脚本/结果 |
| `docs/proposals/super-agent/eag-review-fixes-20261108.md` | 本报告 |
| `packages/core/src/tests/eag-*-review-fixes.test.ts` 等 7 个新文件 | 84 个新增回归用例 |

---

## 9. 提交与提交态复验

**提交**：`b70092c8 fix(eag): 按全量审查结论落地 8 条 P0 与跨层 P1 修复，默认诚实可回退`，72 文件 / `+11080 / -484`，已推送 `origin/main`（该提交落地时 `HEAD == origin/main == b70092c86ba6845c1a9b5ba872f47cb1b92ed760`），工作区干净。只读审查阶段的 3 份报告与 6 组原始材料一并归档入库。随后 `c3c37eca docs(eag): 补记修复提交 b70092c8 的提交态全量复验结果` 追加本节。**当前提交态以 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main` 为准**；本节不再固化 HEAD 值，因为任何写死 hash 的「当前 HEAD」在下次提交后必然过期。

**pre-commit hook 影响**：lint-staged 对 60 个 TS/JS 与 1 个 JSON 跑 `eslint --fix` + `prettier --write`，暂存态 `+13884` 变为提交态 `+11080`。差异主要来自 `eag-review-20261108/pattern-scan.json`（2435 行）被 prettier 重排。已核实提交态 `pattern-scan.json` 仍为合法 JSON（258 个键）、报告 8 个章节与 300 行索引完整、关键修复符号（`applyStatusEvent` / `parseTap13` / `parseOk` / `pkcUnavailable` / `getFailedAutonomousRunDiagnostics` / `strictGateCoverage`）全部在提交态源码中、7 个新测试用例数不变。

**提交态全量复验**（不直接沿用提交前数字）：

| 项目 | 结果 |
|---|---|
| `npm run check` | **exit 0** ✅ |
| 提交态定向全集（15 文件，含 team 契约） | **231 / 231 / 0** ✅ |
| core 全量 4 runner（剥离 shim） | **8664 / 8646 / 0 / 18 skipped，exit 0，4/4 runner ✅** |
| Web 全量 | **689 / 689 / 0** ✅ |

> 项目约定：pre-commit lint-staged 会改暂存文件，因此提交后重跑相关测试与 `npm run check` 才宣布完成。本轮已执行，结果与提交前一致，**hook 未改变任何行为**。
