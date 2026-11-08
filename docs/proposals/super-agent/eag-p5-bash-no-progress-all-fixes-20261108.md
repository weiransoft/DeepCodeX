# EAG P5「bash 多轮空转」全链路修复报告

- 日期：2026-11-08
- 触发：用户提供一次 EAG 自主迭代真实日志（T-068 / `aborted，连续失败 2` / 用户回复「执行这个」后 dev 阶段连续多轮只跑 bash / 手动「停止生成」）
- 用户指令：「全部修复」
- 范围：`packages/core` 的触发层、编排层、dev/fix/verify handler、P5 子执行器、上下文压缩；不含语音链路、不含桌面 Rust 侧改动
- 红线：不把真失败说成通过；不删既有测试、不放宽阈值、不伪造通过；所有新增能力默认不改变既有判定语义，可一键回退

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 定位根因 | 7 项，分布在触发层 / 编排层 / 阶段 handler / 子执行器 / 上下文压缩五层 |
| 修复组 | 4 组并行实现，共 **15 个文件**（11 改 + 4 新增） |
| 新增单测 | **40 个**（N1–N13 / T1–T6 / N9–N13 / B1–B8） |
| 既有测试调整 | `context-budget.test.ts` 6 处精确文案断言改语义断言 + CB-03 数据量 30→40；`session-eag-goal-failure-guard.test.ts` 追加 oracle 与 5 用例 |
| 最终集成回归 | 15 套 **277 tests / 277 pass / 0 fail / 0 skipped** |
| 全仓门禁 | `npm run check` **exit 0**（5 workspace typecheck + lint 0 error + Prettier 全通过 + IPC 契约通过） |
| 生产可编译性 | `npm run bundle` **exit 0**，`packages/cli/dist/cli.js` 15,004,703 B |
| 回退开关 | `DEEPCODE_NO_PROGRESS_LIMIT`、`EAG_BASELINE_GUARD=0`，均为可选/默认不改变既有语义 |

诚实说明：lint 仍有 **144 条既有 warning（0 error）**，全部来自本轮未触碰的文件，未刷绿、未改规则；全仓 `npm test` 未整体重跑（历史上 `sharp-loader.test.ts` 存在与已装 `sharp` 版本不一致的既有红灯），本轮只跑与改动相关的 15 套测试并把结论限定在这个范围内。

---

## 1. 事故回放

用户日志关键节点：

1. 任务卡 `T-068`：修复 `/health` 谎报 `heuristic_proxy`。
2. dev/fix 报告「359 个变更文件，38 次 LLM 请求」——`changedFiles` 用的是全量 `git status --porcelain -uall`，把工作区既有脏文件算进了本次产出。
3. verify 报 `24 passed, 2 failed`，两个失败用例与 T-068 完全无关：
   - `scripts/build.js 通过 process.execPath 调用 ts-node，不依赖 shebang`
   - `提交物安全扫描：镜像清单引用的 Dockerfile 与生产 compose 禁用 root / latest / 明文密钥`
4. 这两条是 **run 起始就存在的基线红灯**，被 verify 如实报成失败，编排层却算作本任务失败；两轮失败指纹完全一致 → 确定性失败熔断 `abort`。
5. 阻塞报告只给泛化模板，用户看不到真实原因；跨 run 失败守卫拦截历史失败目标自动重放，提示「直接回复『执行这个』我将立即重新发起该任务」。
6. 用户回复「执行这个」→ 逃生门原样重放同一 `commandHint` + `goal`，**不带任何失败原因与约束** → 新一轮 dev 从零开始，连续多轮只执行 `ls` / `pwd` / `find` 类 bash，输出各不相同但不落盘。
7. 用户手动「停止生成」。

补充澄清（避免误读日志）：

- 日志里 `bash({"command":"cd /var/lib/deepcode/web-uploads/48dea4965683ce6)` 不是命令被截断执行，而是 `summarizeToolArgs()` 的 60 字符参数摘要；真实执行用的是完整 `argumentsJson`。
- `✓（流式输出中…）` 是 Web 前端 `chat-model.ts` 把未闭合 JSON 块替换成占位符，导致 UI 看起来像「纯空转」，但工具确实在跑。

---

## 2. 根因分层

| # | 层 | 缺口 | 证据 / 位置 | 后果 |
| --- | --- | --- | --- | --- |
| R1 | 编排层 | 没有「run 起始基线红灯」采集，verify 把所有失败都算作本任务失败 | `autonomous-orchestrator.ts` 原 verify 失败直接累计 `consecutiveFailures` 与失败指纹 | 与任务无关的既有红灯触发确定性失败熔断 abort |
| R2 | 编排层 | 阻塞报告用泛化模板，不写真实失败证据 | `generateBlockageReport()` 模板 | 用户/下一轮拿不到可行动信息 |
| R3 | 触发层 | 失败目标守卫只存 `{commandHint, goal}`，逃生门裸重放 | `AutonomousGoalRunRecord`、`consumeConfirmPreviousDecision()` | 「执行这个」必然复刻上一轮失败做法 |
| R4 | 阶段 handler | `buildUserPrompt()` 只在 `stage === "fix"` 拼 feedback | `llm-task-executor.ts` | dev 阶段吞掉 `ctx.lastFailureFeedback` |
| R5 | 子执行器 | `LlmTaskExecutor` 自建 `ToolExecutor`、独立消息数组、`maxToolRounds=40`，不经过主 chat `TurnGuard`；`IDENTICAL_CALL_STORM_LIMIT=3` 只认连续逐字符相同的批量参数指纹 | `llm-task-executor.ts:597, :639` | 主 chat 的「连续空转轮」护栏完全不覆盖 dev；模型换命令探索（`ls`/`pwd`/`find`）时指纹不同，40 轮空转无熔断 |
| R6 | 上下文压缩 | 第 0 级工具输出 head-only 截断，丢掉尾部 stderr / `AssertionError` / `FAILED` 用例名 | `context-budget.ts` `compactForRequest()` | 模型看不到失败证据，只能反复试探 |
| R7 | 阶段 handler / 报告 | `changedFiles` 两套口径：dev/fix 阶段报告全量 porcelain，最终报告 run 基线差集 | `dev-stage-handler.ts` / `fix-stage-handler.ts` vs `autonomous-orchestrator.ts:930` | 「359 个变更文件」虚高，干扰判断 |
| R8 | 编排层状态机 | fix 成功后下一轮 plan 若再选同一张 pending 卡，仍从 dev 重跑整卡 | 循环状态机 | 推倒重写，放大空转 |

> 这 8 条构成「五层防线穿透」：R1/R2/R8 在编排层，R3 在触发层，R4/R5 在子执行器，R6 在上下文压缩，R7 在统计口径。此前 `docs/research/2026-10-eag-auto-loop-trigger-guard.md` 等文档已把「轮内结果指纹熔断」「历史失败基线白名单」「fix 后跳过 dev」列为范围外或另立方案，本轮「全部修复」正是补这些已知未覆盖区。

---

## 3. 修复清单

### 3.1 P0-1 子执行器无进展熔断（双轨判据）

文件：`packages/core/src/eag/p5/executors/llm-task-executor.ts`

- 新增 `noProgressLimit?: number`，默认 `DEFAULT_NO_PROGRESS_LIMIT = 4`（`:278`）；解析链 `options > env.DEEPCODE_NO_PROGRESS_LIMIT > 默认`（`:639-649`）。
- 新增 `captureWorkspaceSnapshot()`（`:1945`）、`normalizeResultContent()`（`:1978`）、`computeResultFingerprint()`（`:2002`）。
  - `normalizeResultContent()` 解析 bash-handler 的 JSON 结果，剥离 `deadlineAt / cwd / startCwd / shellPath / timeoutMs` 等每轮抖动的环境元数据，只保留 `ok / name / output / error / exitCode / signal` 真实结果字段；否则 macOS `/var`→`/private/var` 与时间戳会让指纹永不重复。
- **轨道 A（结果重复型）**：结果指纹与上一轮相同 + 工作区快照不变 → `noProgressStreak++`，默认第 4 轮触发「无进展熔断」。
- **轨道 B（探索型，真实事故形态）**：结果指纹不同但工作区快照连续不变、无成功 write/edit、非全 deny、git 快照可用 → `explorationStreak++`，阈值 `noProgressLimit + 2 = 6`（`:1030, :1751-1790`）。
  - 轨道 B 仅在 git 可用时启用；非 git 仓库自动禁用并只按轨道 A 判定（阈值 +1，文案注明）。
  - 成功 write/edit 立即清零 `explorationStreak`，不误伤真实开发。
- **全 deny 轮豁免**（`:1742`）：被权限守卫拒绝属于拒绝风暴，由 `DENIAL_STORM_LIMIT = 6` 负责，不计入也不清零无进展计数，避免架空 E12 语义。
- 三处上下文折叠点（`:1289, :1382, :1535`）改为**有界衰减** `Math.min(streak, 1)` 而非清零，防止折叠把历史空转洗掉。
- 优先级保留：`DENIAL_STORM_LIMIT` > `IDENTICAL_CALL_STORM_LIMIT=3`（Z9）> 无进展双轨。

### 3.2 P0-1b 工具输出截断保留失败证据

文件：`packages/core/src/context-budget.ts`（`:291` 接入）、新增 `packages/core/src/tests/context-budget-headtail.test.ts`

- 新增导出 `truncateToolOutput(content, maxChars)`：第 0 级不再 head-only，改为**头部 + 首个失败标记窗口 + 尾部**三段保留，尾部最后约 45% 必留；总长严格 ≤ `toolOutputMaxChars`。
- 保留「已截断，原共」子串，兼容既有语义断言。
- 因压缩率提升，`context-budget.test.ts` 的 CB-03 第 2 级预算不再触发，把 `TOOL_COUNT` 30→40、保护窗 id 动态化，**保留「验证第 2 级丢弃 + 保护窗」的原意图**，未放宽 `droppedCount` 断言。
- 既有 6 处精确 head-only 文案断言改为语义断言（长度上限 + 关键证据仍在），不是删测试。

### 3.3 P0-2 dev 阶段补回失败反馈 + fix 后不再推倒重跑

文件：`llm-task-executor.ts`、`dev-stage-handler.ts`、`fix-stage-handler.ts`、`types.ts`、`autonomous-orchestrator.ts`

- `buildUserPrompt()` 的 feedback 拼装不再限 `stage === "fix"`；dev 用「本任务此前的验证失败反馈（请在既有改动上继续修，不要从零重跑整卡）」，fix 用原有文案；无 feedback 时不插入任何行。
- `skipDevAfterFix`：fix 成功在 artifacts 写 `fixApplied: true` + `fixTaskCardId`；编排层跨迭代保存 `previousFixAppliedCardId`，下一轮 plan 若再选同一张 pending 卡 → 注入 `ctx.skipDevAfterFix`，dev 零执行器调用直接 success，`reason = dev-skipped-after-fix`、`noop: false`。
- `P5StageContext` 增加 `baselineFailedTestIds? / baselineAvailable? / baselineDirtyPaths? / skipDevAfterFix?`。

### 3.4 P0-3 逃生门携带失败状态

文件：`packages/core/src/session.ts`、`packages/core/src/eag/suggestion-auto.ts`

- `AutonomousGoalRunRecord` 增加可选 `abortReason / failedTestIds / testCommand / projectRoot / runId`（`:477`），`normalizeAutonomousGoalRuns()` 反序列化逐字段类型校验后原样保留（首轮 N9/N10/N12 失败正是这里只重建 4 个旧字段导致，已修）。
- `extractAutonomousRunDetails()`（`:5856`）从 `handler.execute()` 真实结果抽取诊断；`failedTestIds` 从 `runResult` 顶层精确读取：
  ```ts
  const carried: unknown = runResult
    ? (runResult as unknown as { readonly failedTestIds?: unknown }).failedTestIds
    : undefined;
  ```
- `buildGoalBlockedDiagnostics()`（`:1532`）生成两段：拦截提示末尾「【上一轮诊断】」（终止原因 ≤200 字、最多展示若干失败用例）与快照 `failureContext`（紧凑「【重放约束】…」）。
- `buildAutoExecuteCommand(commandHint, goal, failureContext?)`（`suggestion-auto.ts:265`）新增可选第三参；**无第三参时输出与修复前逐字一致**（`legacyBuildAutoExecuteCommand` 作为 oracle 守护）；有约束时拼进 goal 后走同一套转义。
- 两条逃生路径（拦截提示 + `direct_chat` 确认通道）都透传 `failureContext`；无真实诊断时不编造该段。
- 旧会话记录无新字段时零迁移、不报错。

### 3.5 P1 基线红灯隔离（诚实降级）

新增 `packages/core/src/eag/p5/handlers/baseline-guard.ts`

- `collectBaselineFailures(projectRoot, testCommand, timeoutMs = 60_000)`：每个 run 起始**真实执行一次**测试命令，复用 verify 同款 `parseShellCommand`（含 `ALLOWED_TEST_PROGRAMS` 白名单与 shell 注入校验）、`spawnSync` 参数、`parseTestOutput`、`extractFailedTestIds`，保证基线探测与每轮 verify 对同一命令的解释无口径漂移。
- 只在识别到 ≥1 个明确失败用例标识时 `available = true`。以下场景一律 `available = false` + 写明 reason：开关关闭、命令无法启动、超时、`parser=unknown` / 无测试计数、起始全绿、`failed > 0` 却提取不到用例标识、命令被白名单拒、任何异常。
- **`available = false` 时不排除任何失败**，verify 结果仍如实 `failed`。
- `available = true` 的 baselineOnly 轮：verify **仍判 failed**（不把 `testPassed` 改成 true），summary 明写「基线失败 N 个、新增失败 M 个」与「基线红灯仍失败，本阶段判定 failed」；但不清除/不累计确定性失败指纹、不累加 `consecutiveFailures`、不触发 abort，并稳定化 `loopVerdict.findings`。
- verify 失败 artifacts 增加 `baselineOnly / newFailedTestIds / baselineFailedTestIds / baselineAvailable`。
- `generateBlockageReport()` 用真实基线信息替换泛化模板。

### 3.6 P1 统计口径统一与真实报告

- dev/fix 的 `changedFiles` 改用 `baselineDirtyPaths` 过滤 run 起始既有脏文件，summary 改为「本次产出 N 个文件；工作区既有 M 个未计入」，与最终报告 `:930` 的 run 基线差集一致。
- `AutonomousRunResult` 增加顶层 `readonly failedTestIds?: ReadonlyArray<string>`（`:390`）；收尾汇总本 run 全部 verify 失败阶段的 `artifacts.failedTestIds`，去重保序、上限 20、只保留非空字符串，无失败则 `undefined`（`:1724`）。`session.ts` 通过该顶层字段精确读取，不依赖嵌套 artifacts。

### 3.7 P2 编排契约

- 每组基线只采集一次并缓存，注入每轮 stage context（`:1097, :1702`）。
- fix 成功后跨迭代状态 `previousFixAppliedCardId` → `skipDevAfterFix`（`:1102`）。
- 报告撰写使用 `args.baselineFailedTestIds` / `args.baselineAvailable`（`:3637-3647`），无基线数据时不写基线段落。

---

## 4. 新增 / 调整用例清单

| 组 | 文件 | 编号 | 数量 | 覆盖要点 |
| --- | --- | --- | --- | --- |
| 执行器 | `eag-p5-no-progress.test.ts`（新增 443 行） | N1–N13 | 13 | 结果重复熔断、不同 read 不误伤、write 不误伤、dev/fix feedback 注入、无 feedback 不插行、Z9 优先级、自定义阈值、非 git、探索型空转第 6 轮触发、write 打断清零、非 git 轨道 B 禁用 |
| 压缩 | `context-budget-headtail.test.ts`（新增 206 行） | T1–T6 | 6 | 尾部 `FAILED`/`AssertionError` 不丢、中部失败窗口、无标记退化、极小/非法预算、真实压缩端到端只读 |
| 触发层 | `session-eag-goal-failure-guard.test.ts`（追加 357 行） | N9–N13 | 5 | 写侧全字段落盘、拦截提示含诊断、命令零回归 oracle + 转义、逃生门重放带约束、direct_chat 通道、无失败真值不编造 |
| 编排层 | `eag-p5-baseline-guard.test.ts`（新增 601 行） | B1–B8 | 16 | 基线解析与超时降级、verify 拆分、baselineOnly 不 abort、开关关闭降级、changedFiles 过滤、fixApplied、skipDevAfterFix、命令层与 `run()` 顶层 `failedTestIds` 双向契约 |
| 既有调整 | `context-budget.test.ts` | — | 6 处断言 + CB-03 | 语义断言替代精确 head-only 文案；保留第 2 级预算验证意图 |

**合计新增 40 个用例。**

---

## 5. 真实验证

### 5.1 组内独立复跑（lead 抽查，不采信 worker 自报「全绿」）

| 组 | 命令范围 | 结果 |
| --- | --- | --- |
| 压缩 | `context-budget-headtail` + `context-budget` | 20 / 20 pass |
| 触发层 | 三套触发/守卫相关 | 65 / 65 pass |
| 执行器 | `eag-p5-no-progress` 13 + `eag-p5-llm-execution` 43 + `eag-p5-llm-executor` 28 | 84 / 84 pass |
| 编排层 | 五套编排/handler 相关（补 B7/B8 前） | 76 / 76 pass |
| core 类型检查 | `npx tsc -p packages/core --noEmit` | exit 0，0 error |

### 5.2 最终集成（本轮收尾，格式化与 B7/B8 落盘后重跑）

```bash
node --import tsx --test --test-concurrency=1 \
  packages/core/src/tests/context-budget-headtail.test.ts \
  packages/core/src/tests/context-budget.test.ts \
  packages/core/src/tests/eag-p5-no-progress.test.ts \
  packages/core/src/tests/eag-p5-llm-execution.test.ts \
  packages/core/src/tests/eag-p5-llm-executor.test.ts \
  packages/core/src/tests/session-eag-goal-failure-guard.test.ts \
  packages/core/src/tests/session-eag-llm-trigger.test.ts \
  packages/core/src/tests/eag-dynamic-suggester.test.ts \
  packages/core/src/tests/eag-p5-baseline-guard.test.ts \
  packages/core/src/tests/eag-p5-autonomous-orchestrator.test.ts \
  packages/core/src/tests/eag-p5-verify-fix-evidence.test.ts \
  packages/core/src/tests/eag-p5-stall-fixes.test.ts \
  packages/core/src/tests/eag-p5-noop-loop-fixes.test.ts \
  packages/core/src/tests/eag-p5-token-abort-and-rerun-recovery.test.ts \
  packages/core/src/tests/eag-assembly.test.ts
```

结果：`# tests 277 / # pass 277 / # fail 0 / # cancelled 0 / # skipped 0`。

### 5.3 全仓门禁与生产编译

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0：5 个 workspace typecheck 通过；eslint 144 warnings / **0 errors**（均为既有）；`format:check` 全通过；`check:ipc` 契约校验通过（注册集 == ACL 授权集，18 个） |
| `npm run bundle` | exit 0；`Generated version info: 0.4.5 (6dcb156f-dirty)`；`cli.js` 15,004,703 B |

### 5.4 两次非代码性失败及处置（如实记录）

1. 首次跨组全量回归 `FULL_EXIT=1`，`/tmp/dcx-eag-full.log` 只有一行 `Could not find '...'`：命令写成 `F="a.test.ts b.test.ts ..."; node --test $F`，**zsh 不做默认词分割**，整个字符串被当成一个文件路径，测试根本没跑。改为显式多文件路径后 275/275、补 B8 后 277/277。与语音 P1 阶段 `$flags` 被当成一个参数同源。
2. 首次 `npm run check` exit 1：9 个改动文件 Prettier 格式不合规导致 `format:check` 中断，`check:ipc` 未执行。对这 9 个文件单独 `npx prettier --write` 后重跑，全链路 exit 0。
3. 一次 BSD grep 假阴性：用 `grep -n 'a\|b\|c'` 查 `autonomous-orchestrator.ts` 契约字段返回空，误以为 `failedTestIds` 未落盘；macOS grep 不支持 `\|` 分支语法。改用专用检索确认 `:390 / :1724 / :1097 / :1702 / :3646` 全部存在。**这是本项目第二次踩同一坑**，后续核查一律使用 `grep -E` 或专用检索工具。

---

## 6. 开关与回退契约

| 开关 | 默认 | 作用 | 回退 |
| --- | --- | --- | --- |
| `DEEPCODE_NO_PROGRESS_LIMIT` | 未设 → 4 | 轨道 A 阈值；轨道 B = 该值 + 2 | 设为较大正整数可放宽；`options.noProgressLimit` 优先 |
| `EAG_BASELINE_GUARD` | 未设 → 开启 | run 起始基线红灯采集与隔离 | `EAG_BASELINE_GUARD=0` → `available=false`，**不排除任何失败**，verify 仍如实 failed |
| `buildAutoExecuteCommand` 第三参 | 省略 | 逃生门追加「【重放约束】」 | 省略第三参时输出与修复前逐字一致（oracle 守护） |
| 基线探测超时 | 60,000 ms | 与任务卡默认一致 | 超时即降级，不阻塞主流程 |

设计原则：所有新增字段均为**可选**；旧会话记录、非 git 仓库、命令被白名单拒、git 不可用等场景都走「不启用增强」路径，不抛异常、不改既有判定结果。

---

## 7. 诚实降级与红线

- 基线守卫 `available=false` 时**不排除任何失败**；`failed > 0` 却提取不到用例标识时同样降级，绝不臆造「这些都是基线红灯」借以逃过熔断。
- baselineOnly 轮 verify **仍判 failed**，summary 明写「基线红灯仍失败，本阶段判定 failed」，只调整是否累计连续失败/触发 abort，不改 `testPassed`。
- 无失败用例时 `failedTestIds` 为 `undefined`，不编造用例名。
- 无真实诊断时逃生门不写「重放约束」，不伪造 abortReason。
- 全 deny 轮由拒绝风暴熔断负责，不被无进展熔断抢先，保持 E12 语义。
- 轨道 B 在 git 不可用 / 已有成功 write/edit 时禁用或清零，不误伤真实开发。
- 未删任何既有测试、未放宽任何阈值断言、未把 lint warning 刷成 0。

---

## 8. 未覆盖边界 / 已知限制

1. **写入 `.gitignore` 路径**：`captureWorkspaceSnapshot()` 基于 git 快照，被忽略的写入不会改变快照，可能被轨道 B 判为「无进展」。真实开发中若合法产出只在忽略目录，需靠成功 write/edit 清零保护；该清零已实现，但若模型只写忽略路径且工具回报失败，仍可能触发。
2. **折叠 + 空转复合**：三处折叠改为有界衰减（`min(streak,1)`），但长 run 中多次折叠叠加的极端组合未做端到端真机复现。
3. **部分 deny 混合轮**：全 deny 豁免已实现；一轮内「部分成功 + 部分拒绝」且工作区不变的场景，未单独建模。
4. **基线探测开销**：每个 run 额外真实跑一次完整测试命令（默认 60 s 超时上限）。慢测试套件会增加 run 启动延迟；超时即降级，但已消耗的时间不会退回。
5. **基线只在 run 起始采集一次**：run 期间外部新引入的红灯仍会被算作新增失败——这是保守选择（宁可多报，不可漏报）。
6. **env 配置通道**：`DEEPCODE_NO_PROGRESS_LIMIT`、`EAG_BASELINE_GUARD` 目前仅环境变量/代码 options，未接入设置面板或任务卡字段。
7. **UI 占位符**：`chat-model.ts` 的「✓（流式输出中…）」会让工具过程在界面上看起来像空转，本轮未改前端；日志可读性仍是独立议题。
8. **全仓 `npm test` 未整体重跑**：存在与本轮无关的既有红灯（`sharp-loader.test.ts` 硬编码 `0.35.4` vs 已装 `0.35.5`），未改测试刷绿，结论限定在本轮 15 套相关测试。

---

## 9. 回归命令（复现本报告结论）

```bash
# 1) 相关单测（15 套，277 用例）
node --import tsx --test --test-concurrency=1 \
  packages/core/src/tests/context-budget-headtail.test.ts \
  packages/core/src/tests/context-budget.test.ts \
  packages/core/src/tests/eag-p5-no-progress.test.ts \
  packages/core/src/tests/eag-p5-llm-execution.test.ts \
  packages/core/src/tests/eag-p5-llm-executor.test.ts \
  packages/core/src/tests/session-eag-goal-failure-guard.test.ts \
  packages/core/src/tests/session-eag-llm-trigger.test.ts \
  packages/core/src/tests/eag-dynamic-suggester.test.ts \
  packages/core/src/tests/eag-p5-baseline-guard.test.ts \
  packages/core/src/tests/eag-p5-autonomous-orchestrator.test.ts \
  packages/core/src/tests/eag-p5-verify-fix-evidence.test.ts \
  packages/core/src/tests/eag-p5-stall-fixes.test.ts \
  packages/core/src/tests/eag-p5-noop-loop-fixes.test.ts \
  packages/core/src/tests/eag-p5-token-abort-and-rerun-recovery.test.ts \
  packages/core/src/tests/eag-assembly.test.ts

# 2) 全仓门禁
npm run check

# 3) 生产 bundle（若 safe-delete shim 拦截，先 mv packages/cli/dist/bundled 到 /tmp 备份）
npm run bundle
```

---

## 10. 变更文件清单

**修改（11）**

```
packages/core/src/context-budget.ts
packages/core/src/eag/p5/autonomous-orchestrator.ts
packages/core/src/eag/p5/executors/llm-task-executor.ts
packages/core/src/eag/p5/handlers/dev-stage-handler.ts
packages/core/src/eag/p5/handlers/fix-stage-handler.ts
packages/core/src/eag/p5/handlers/types.ts
packages/core/src/eag/p5/handlers/verify-stage-handler.ts
packages/core/src/eag/suggestion-auto.ts
packages/core/src/session.ts
packages/core/src/tests/context-budget.test.ts
packages/core/src/tests/session-eag-goal-failure-guard.test.ts
```

**新增（4）**

```
packages/core/src/eag/p5/handlers/baseline-guard.ts
packages/core/src/tests/context-budget-headtail.test.ts
packages/core/src/tests/eag-p5-baseline-guard.test.ts
packages/core/src/tests/eag-p5-no-progress.test.ts
```

**本报告（1）**：`docs/proposals/super-agent/eag-p5-bash-no-progress-all-fixes-20261108.md`

> 存放位置说明：仓库 `.gitignore` 第 5 行明确将 `docs/dev/` 标记为「已从 Git 历史移除的文档子目录，防止误重新提交」，因此本报告落在正常跟踪的 `docs/proposals/super-agent/` 下，未使用 `git add -f` 破坏忽略约定。

> `packages/cli/dist/*` 为未跟踪构建产物，`npm run bundle` 重建后不进入提交。
