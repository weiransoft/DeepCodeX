# EAG 执行循环 / 终端 / 死循环检测专项审查与修复（2026-11-11）

> 基线：`1454ea34`（`feat(jev): 循环决策接入 NeoHorse-Jev-4B`），本轮改动**未提交**。
> 范围：EAG 终端处理、执行循环、死循环/无进展判定链路，以及与之共享护栏的普通会话主循环。
> 原则：最小针对性修复，不做无关重构；所有结论以仓库实测为准，未验证推断不进入结论。

---

## 1. 结论摘要

审查定位到 **4 条可复现缺陷链路**（3 条已修复并补回归，1 条为「确认无缺口、不改」的终端链路），两类用户关注的问题分别对应：

| 用户关注 | 根因链路 | 结果 |
| --- | --- | --- |
| 空循环 / 重复空转 / 状态不推进 / 始终等待 | D2 jev 主判独占去留权、旁路本地熔断并每轮清零计数；D3 普通会话同类短路 | 已修：状态感知硬下限每轮执行，jeV 只提供加速停止信号 |
| | D4 工作区快照只看 `git status` 路径/状态码 | 已修：附加变更文件内容摘要，状态推进可核验 |
| 误判死循环（只看调用重复，不看输出/状态/进展） | D1 jev 预取决策发生在工具执行前，stop 不含本轮真实输出与工作区变化 | 已修：stop 必须过「本轮进展证据门」 |
| | 沿用既有的「调用相同 + 结果也相同」判据 | 本次未回退，且新增反例测试 |
| 处理卡在终端、无法结束 | D5 前台/后台 bash 生命周期 | 复查**未发现新缺口**，保留既有 timeout / abort / IO drain 保护，未改动 |

新增统一回退开关 `DEEPCODE_JEV_EVIDENCE_GUARD=0`，可逐字回到 `1454ea34` 的「jeV 独占去留权」旧契约（默认开启修复）。

---

## 2. 逐项问题定位

### D1 — jev 预取 stop 不含本轮证据 → 误判死循环（P0）

* **位置**：`packages/core/src/eag/p5/executors/llm-task-executor.ts`
  - 预取：`decideProgress({ recentTurns: jevRoundObservations.slice(-6) })` 在 `toolExecutor.executeToolCalls()` **之前**发起；
  - 本轮观测 `jevRoundObservations.push(...)` 在工具执行**之后**；
  - join：读到 `continue_loop=stop && confidence>=0.5` 就直接 `return this.failure(...)`。
* **触发条件**：模型重复执行轮询/等待类 bash（`tail -f` 进度、重试直到服务就绪、计数器写入），输出或工作区状态逐轮推进；jeV 仅凭上一轮摘要判 stop。
* **根因**：`JevLoopDecision.buildDigestMessages()` 的 `toolCallDigests` 只有 `${name}:${ok/denied/fail}`，不含实际输出或结果签名；`buildState()` 也不含工作区变化。决策输入与本轮事实存在**一轮时滞**，而该结论却能立即终止本轮任务。
* **影响**：合法「看起来重复但有进展」的循环被判死循环并失败返回，编排器随即进入 fix/abort。

### D2 — jev 主判旁路状态感知熔断 → 真实空转漏判（P0）

* **位置**：同一文件 join 之后的分支结构 `if (jevRoundAnswers != null) { /* 只记 progress 分 */ } else { /* 全部 heuristic 熔断 */ }`；以及 join 内 `continue` 分支无条件执行：
  `identicalCallStreak = 0; lastCallFingerprint = null; noProgressStreak = 0; explorationStreak = 0;`
* **触发条件**：jeV 健康且持续判 `continue`（远程模型误判、摘要脱敏后信息不足、或健康状态机未降级），而本地连续多轮工具结果重复、工作区零变化。
* **根因**：jeV 主判成功即整轮跳过 heuristic；即使偶尔降级，每轮 `continue` 又把累计计数清零。本地「结果指纹 + 工作区快照 + 成功写入」三轨证据永远无法达到阈值，循环只能靠 `maxToolRounds=40` 兜底。
* **影响**：正是「始终等待却没有进展」——烧满 40 轮才诚实失败，期间无提前收口。

### D3 — 普通会话 jev 主判短路本地护栏（P1）

* **位置**：`packages/core/src/common/loop-guard.ts` `TurnGuard.decideBeforeIteration()` 在 `jevPrimary` 时直接 `return { allow: true }`；`packages/core/src/session.ts` `mapJevDecisionToGuard()` 在 `result.ok` 时只返回 `evaluateJevDecision()` 的结论。
* **触发条件**：与 D2 同，作用于普通会话主循环（jeV 决策同样在轮末预取、轮首 join）。
* **根因**：本地「工具名 + 参数 + 结果签名」三维死循环检测与连续全失败护栏在 jeV 主判期间完全不参与判定。
* **影响**：jeV 误 continue 时，真实重复调用循环可绕过本地硬护栏。
* **注意**：普通会话的 jeV stop 是 `consult_user_loop_stop`（可恢复咨询），不是 P5 那样的直接失败，故误杀风险较低；本轮只补「漏判」侧。

### D4 — 工作区快照只看路径/状态 → 状态推进被误判为空转（P0）

* **位置**：
  - `packages/core/src/eag/loop/kernel.ts` `captureWorkspaceSnapshot()`：`git status --porcelain` 原始输出；
  - `packages/core/src/eag/graph/node-loop-kernel.ts`：直接复用上述导出；
  - `packages/core/src/eag/p5/executors/llm-task-executor.ts` 私有 `captureWorkspaceSnapshot()`：同样只做状态行排序拼接。
* **触发条件**：反复写**同一个**未跟踪文件（计数器、进度日志、状态文件）。`git status` 恒为 `?? progress.log`，但文件内容每轮都在变。
* **根因**：`NoProgressDetector.observe()` 与 P5 双轨熔断都把「快照不变」当作无进展证据；反复写同一文件时该判据恒为 true，轨道 A 在 4 轮、轨道 B 在 6 轮误熔断。
* **影响**：真实推进的任务被当成空转收口；D1 的进展证据门同样需要这份证据，否则无法区分「探索型空转」与「状态推进」。

### D5 — 终端 / bash 生命周期（复查结论：无新缺口，未改动）

逐项复核 `packages/core/src/tools/bash-handler.ts`、`common/bash-timeout.ts`、`common/process-abort.ts`、`tools/executor.ts`：

| 潜在卡死点 | 既有保护 | 结论 |
| --- | --- | --- |
| 交互式命令读 stdin 挂住 | `buildShellCommand()` 统一包 `< /dev/null` | 已保护 |
| 前台命令无超时 | `DEFAULT_BASH_TIMEOUT_MS=120000`、`clampBashTimeoutMs()` 下限 60000、`triggerTimeout()` → `killProcessTree(SIGKILL)` | 已保护 |
| 子进程退出但孙进程持有管道 | `IO_DRAIN_TIMEOUT_MS=2000` + `finish()` 销毁 stdout/stderr、清 timer、注销 control | 已保护 |
| 用户停止信号 | `bindProcessAbort()`、`ToolExecutor` 每轮 `shouldStop()`、join 后立即复查 abort | 已保护 |
| jeV HTTP 等待 | `JevDecisionClient` `timeoutMs=800` + `AbortController`，3 连败降级 + single-flight 恢复探测 | 已保护 |
| 外层循环上界 | `LoopKernel` `while (... && iterIndex < maxIterations)`；`AutonomousOrchestrator` `while (iterIndex < maxIterations && status === "running")`；P5 `maxToolRounds=40` | 已保护 |

本轮**未改动任何终端代码**；既有覆盖（`tool-handlers.test.ts` / `bash-handler-safety.test.ts` / `bash-marker-strip.test.ts`）已纳入定向回归并通过。

---

## 3. 修复清单（7 个文件）

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/common/workspace-progress.ts` | **新增**共享快照工具：`git status --porcelain -uall` + 变更文件首尾内容摘要（各 ≤32KB、最多 64 文件）；`realpath` 越界检查，符号链接指向仓库外只读标记 `out-of-root`；非 git / 超时 / 无 root → `null` 诚实降级 |
| `packages/core/src/eag/loop/kernel.ts` | `captureWorkspaceSnapshot()` 委托共享工具（D4 一处修复同时覆盖 `NodeLoopKernel`） |
| `packages/core/src/eag/p5/executors/llm-task-executor.ts` | ① 私有快照委托共享工具；② 新增「本轮进展证据」统一采集块（结果指纹 / 调用指纹 / 工作区快照 / 成功写入，每轮只采一次）；③ jeV stop 加证据门；④ continue 不再清零本地计数；⑤ 状态感知硬下限改为 `if (jevRoundAnswers == null \|\| jevEvidenceGuardEnabled)` **始终执行**；⑥ 新增回退开关 |
| `packages/core/src/common/loop-guard.ts` | 新增 `TurnGuard.decideJevHardFloor()`：只读可观测证据（含结果维度的签名队列 + 连续失败计数），输出一律为可恢复 `consult_*`，不产生不可恢复 `terminate_model_loop`；**不改** `decideBeforeIteration()` / `setJevPrimary()` 既有语义（T5/T6/P0-1 零回归） |
| `packages/core/src/session.ts` | `mapJevDecisionToGuard()` 在 jeV 放行分支叠加硬下限复核 |
| `packages/core/src/tests/workspace-progress.test.ts` | **新增** W1-W5：同一文件反复写、大文件尾部追加、干净/非 git 降级、LoopKernel 接线、越界符号链接 |
| `packages/core/src/tests/jev-loop-decision.test.ts` | 测试网关支持常驻响应；P2 改为**默认新契约 + `=0` 旧契约 A/B 同用例对照**（用例数守恒）；新增 P4-P7、T7-T12 |

**回退方式**：`DEEPCODE_JEV_EVIDENCE_GUARD=0` 同时关闭 P5 证据门 / P5 硬下限 / 普通会话硬下限，逐字恢复 `1454ea34` 行为。默认不设置即开启修复。

**设计取舍**：没有改动 jeV 预取协议（把本轮输出塞进预取需要把决策挪到工具执行后，会失去并发收益、改动面过大），而是在 join 时用本轮可观测证据做二次确认；这样预取的低延迟与判定的事实完整性同时保留。

---

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 新增/改造定向测试 | **42 / 42 通过**（jev 37 + workspace-progress 5），0 失败 |
| EAG / 终端 / 护栏 / session 定向回归（22 套） | **686 tests / 685 pass / 0 fail / 1 skipped**，exit 0 |
| core 全量 4 runner | **8750 tests / 8732 pass / 0 fail / 18 skipped**，4/4 runner 通过，exit 0（`7068+959+13+710`） |
| Web 全量 | **706 / 706 / 0**，exit 0 |
| `npm run check` | **exit 0**（全 workspace typecheck + eslint 0 error / 138 条既有 warning + format:check + IPC 契约） |
| `npm run bundle` | **exit 0**（`cli.js` 构建成功，assets 复制完成） |

关键场景覆盖（均为真实 `git init` 临时仓库 + 真实 `ToolExecutor` + 本地真实 HTTP jev 网关，唯一替换点为脚本化 LLM 桩）：

* **空转不推进**：P2-A（jeV 持续 continue，本地第 4 轮收口）、P5（jeV 每轮 stop 且零进展，第 1 轮即终止）、P3（jeV 不可达回落 heuristic）。
* **正常重复但仍有进展**：P4（jeV 每轮误判 stop，3 轮反复写同一文件 + bash 输出推进 → 不误杀、正常终态成功）、T8 / T12（结果签名逐轮变化的轮询 → 放行）、W1 / W2（状态推进可比较）。
* **真实死循环**：P6（jeV 主判持续 continue + 逐字符相同调用/结果 → 相同调用空转熔断收口）、T7 / T11（本地硬下限 / session 主链路可恢复咨询）。
* **契约回退**：P2-B、P7、T9（`=0` 逐字回退旧行为）。
* **终端边界**：既有 timeout / 延长 deadline / held pipe / 延迟输出 / 退出码 / 取消用例全部通过。

> 环境口径：core 全量按仓库已知坑剥离宿主 `NODE_OPTIONS` 的 fs/language shim 后运行；Web runner 已内置剥离。未用任何方式刷绿契约变更——P2 采用「新默认断言 + 同用例 A/B 回退对照」，用例数守恒。

---

## 5. 已知边界与残留风险（如实披露）

1. **jeV stop 咨询路径仍是远程主观判定**：普通会话的 `consult_user_loop_stop` 为可恢复咨询，用户可放行；本轮未对其加本地证据门（改动面控制）。P5 的 stop 是硬失败，已加门。
2. **`setJevPrimary(true)` 内含签名队列清空（P0-1 语义）**：首次启用 / 降级恢复时会清空一次本地证据，硬下限相应延后约 1 轮；若 jeV 网络频繁抖动反复切换，证据会被反复重置。本轮未改该语义（会破坏 T6 与 P0-1 防 stale 误终止），T11 已按真实时序显式模拟首次切换后验证。
3. **`resultChanged` 是弱进展证据**：仅输出变化但工作区零变化的探索型空转，会逐轮否决 jeV stop，最终仍由 P5 轨道 B（默认 6 轮）收口，不会无限循环。
4. **快照工具开销**：每轮一次 `git status -uall` + 最多 64 个变更文件首尾各 32KB 摘要；有 3s timeout 与条目上限，超时诚实降级 `null`（单轨判定），不会把不可用伪装成「无变化」。
5. **未提交**：本轮 7 个文件均为工作区改动；工作区另有其他会话的 `scripts/voice/*`、`package.json` 改动，本轮**未触碰、未暂存、未提交**。
6. `npm run bundle` 生成的 `packages/cli/dist/*` 为未跟踪产物，不入库。
