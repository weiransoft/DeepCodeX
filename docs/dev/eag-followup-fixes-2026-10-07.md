# EAG 后续修复设计（2026-10-07 v0.4.3.12 follow-up）

## 概述

v0.4.3.12 解决了 P0 轮数上限 / failure() tokens 结算 / verify 空测试守卫，经真实运行暴露 4 条后续修复需求。本文档覆盖 P0/P1/P2 四级修复的根因链、方案选型、风险评估。

---

## 3. P0：onIteration + 最终报告双写 appendSessionMessage + onAssistantMessage

### 根因

session.ts `handleEagAutonomousCommand` 目前：

- L6026-6036 `onIteration` 回调只调 `this.onAssistantMessage(buildAssistantMessage(...), false)`
- L6095 最终报告只调 `this.onAssistantMessage(buildAssistantMessage(...), false)`

两条路径都**不调 `appendSessionMessage(sessionId, message)`**。`onAssistantMessage` 仅推送到已连接宿主（SSE stream / WebSocket），宿主断开（无人值守 EAG 跑在后台、用户关了浏览器、CLI --detached 模式）时消息直接丢失。

对照：`addSessionSystemMessage`（L3292-L3295）、技能消息（L3170）、plan mode 状态（L8770-L8774）、所有 user message 追加（L3438 等）都走 `appendSessionMessage + onAssistantMessage` 双写模式。EAG 迭代/报告属于 assistant 侧系统消息，应走同样的模式。

### 修复方案

在 session.ts 两处各加一行 `appendSessionMessage`：

```typescript
// 位置 1：onIteration 回调内（L6026-6036）
const assistantMsg = this.buildAssistantMessage(sessionId, `[EAG Autonomous Loop] ${header}\n${stageLines}`, null);
this.appendSessionMessage(sessionId, assistantMsg);  // ← 新增
this.onAssistantMessage(assistantMsg, false);

// 位置 2：最终报告（L6095）
const reportMsg = this.buildAssistantMessage(sessionId, result.markdownReport, null);
this.appendSessionMessage(sessionId, reportMsg);       // ← 新增
this.onAssistantMessage(reportMsg, false);
```

### 风险评估

- 低风险：`appendSessionMessage` 是 void return 的纯函数（L8557），内部不抛异常
- SessionMessage 类型已对齐（`buildAssistantMessage` 返回 `SessionMessage`，签名匹配）
- 同一 message 对象传给双写（append 持久化 + onAssistantMessage 推送），无重复构造

### 改动清单

| 文件 | 行号 | 改动 |
|------|------|------|
| session.ts | ~6034 | onIteration 回调内 appendSessionMessage |
| session.ts | ~6095 | 最终报告 appendSessionMessage |

---

## 4. P1：/eag-autonomous --test-command 强制校验

### 根因

当前 `extractEagAutonomousRequestFromPrompt` 对 `--test-command` 只做可选解析，默认值 `"npm test"`（eag-autonomous-command.ts L27、L150）。异构 projectRoot（Python/Go/Rust 项目）没有 npm，`npm test` 必超时，导致 verify 阶段白等 600s 后进入连续失败熔断。

当前有两个兜底但都不够强：
1. `DEFAULT_TEST_COMMAND = "npm test"` — 硬性默认，异构项目必死
2. verify-stage-handler 的 noTestsCollected skip 降级 — exitCode≠0 场景要求 synthesizedTask=true + 默认 npm test 才降级，手写 tasks.md 的非合成任务 exitCode≠0 + 无测试计数 → failed

### 修复方案

分两步：

#### 4a. 命令解析层：/eag-autonomous 强制要求 --test-command

在 `extractEagAutonomousRequestFromPrompt` 中：
- 若命令字符串包含 `/eag-autonomous` 但不含 `--test-command` 且 projectRoot 不是 Node.js 项目（无 package.json 或 package.json 无 test 脚本），返回**解析失败**错误
- 或统一：若用户在命令字符串里显式指定了 `/eag-autonomous` 路径（非 suggester 触发），要求 --test-command 必填；suggester 触发时才允许默认值（保持向后兼容）

#### 4b. verify 阶段：项目类型自动探测默认测试命令

在 verify-stage-handler 的 `DEFAULT_TEST_COMMAND` 位置增加探测：
- projectRoot 有 package.json + test script → "npm test"
- 有 pyproject.toml / requirements.txt → "python -m pytest" 或 "python3 -m pytest"
- 有 Cargo.toml → "cargo test"
- 有 go.mod → "go test ./..."
- 都没有 → skip（而非默认 npm test 超时）

### 风险评估

- 4a 低风险：仅在命令解析层加校验，不影响 suggester 触发路径
- 4b 中风险：需要确认探测逻辑不与已有 synthesizedTask 降级冲突。手写 tasks.md 的项目如果是 Python，应该自动用 pytest，而不是失败

### 改动清单

| 文件 | 行号 | 改动 |
|------|------|------|
| eag-autonomous-command.ts | extractEagAutonomousRequestFromPrompt | 非 suggester 路径 --test-command 必填校验 |
| verify-stage-handler.ts | DEFAULT_TEST_COMMAND | 项目类型探测默认值 |

---

## 5. P1：Token 预算轮内增量检查

### 根因

当前预算检查位置在 `AutonomousOrchestrator.run()` 循环结束后（autonomous-orchestrator.ts 内部检查 `totalTokensUsed > maxTokens`），执行器 `LlmTaskExecutor` 不感知预算。结果：

- 单轮 dev/fix 可以在 for 循环（默认 40 轮）里烧穿 maxTokens（200K）N 倍才返回给编排器
- 执行器只在 for 循环后调一次 resolveTokensUsed 结算，中间完全没有检查

### 修复方案

在 `LlmTaskExecutor` 的 for 循环内，每 N 轮（建议 5 轮）做一次增量预算检查：

```typescript
const ROUND_BUDGET_CHECK_INTERVAL = 5;
// 拿到的最大预算来自构造参数（autonomous-orchestrator 通过 options 传入）
const perRoundBudget = (this.maxTokens ?? 200_000) / 3; // 单轮约占总预算 1/3

for (round = 1; round <= this.maxToolRounds; round++) {
  // ... LLM 调用、工具执行 ...
  
  // 增量预算检查
  if (round % ROUND_BUDGET_CHECK_INTERVAL === 0) {
    const currentTokens = resolveTokensUsed(sawUsage, inputTokensTotal + outputTokensTotal, estimatedCharsTotal).tokens;
    if (currentTokens > perRoundBudget) {
      return this.failure(
        `Token 预算超限：单轮已用 ${currentTokens} tokens（阈值 ${perRoundBudget}）`,
        llmRequests, sawUsage, inputTokensTotal + outputTokensTotal, estimatedCharsTotal
      );
    }
  }
}
```

需要在 `LlmTaskExecutorOptions` 增加 `maxTokens?: number` 字段（编排器通过 options 传入）。

### 风险评估

- 中低风险：增量检查只在每 5 轮触发一次，不影响正常任务；超限提前 failure 比烧穿后 abort 更诚实
- 阈值选择：perRoundBudget = maxTokens/3 让每轮 dev/fix 最多用总预算的 1/3，剩余预算留给 verify + 后续迭代
- 需要同步更新 orchestrator 调 LlmTaskExecutorOptions 时传 maxTokens

### 改动清单

| 文件 | 改动 |
|------|------|
| llm-task-executor.ts | 新增 maxTokens option + 循环内 ROUND_BUDGET_CHECK_INTERVAL 增量检查 |
| autonomous-orchestrator.ts | 构造 LlmTaskExecutor 时透传 maxTokens |

---

## 6. P2：plan 阶段 goal 与选中卡 requirement 语义相关性守卫

### 根因

`pickNextPendingTask`（plan-stage-handler.ts L1142-1158）只按 `status===pending && dependencies 满足 && id 升序` 取第一张卡，**完全没有检查 goal 与 requirement 的语义相关性**。

0.4.3.8 守卫已存在但路径有漏洞：它在 plan 阶段**刚解析完 tasks.md 后**检查 goal 与新合成卡的相关性，但如果 tasks.md 已有**遗留 pending 卡**（上次运行失败留下的旧卡），旧卡在 goal 不相关的情况下仍会被 `pickNextPendingTask` 选中执行。

典型场景：
1. 上次 goal="修复登录页面空指针" → 合成卡 T-001"修复登录页面空指针" → plan → dev → 熔断 abort
2. 新 goal="给订单服务加退款功能" → plan 阶段 pickNextPendingTask 看 T-001 还是 pending → 取它 → dev 阶段对着"修复登录页面空指针"执行"给订单服务加退款功能"的 goal → 语义完全错位

### 修复方案

在 `pickNextPendingTask` 或其调用点（plan-stage-handler execute 中选卡后）增加 goal 相关性检查：

```typescript
// plan-stage-handler.ts execute 中选卡后
const selectedCard = pickNextPendingTask(cards, completedIds);
if (selectedCard) {
  const relevance = calculateGoalRelevance(objective, selectedCard.requirement ?? selectedCard.title);
  if (relevance < MIN_GOAL_RELEVANCE_THRESHOLD) {
    // 拒绝取卡，强制从 goal 合成新卡
    const synthesizedId = generateSynthesizedTaskId(cards);
    const synthesizedContent = buildSynthesizedTasksContent(objective, synthesizedId);
    // 替换/追加合成卡，清空所有遗留 pending 卡的 status（改为 blocked）
    return reparseWithSynthesizedCard(cards, synthesizedContent);
  }
}
```

相关性计算用简单策略（避免引入 embedding 依赖）：
- 检查 goal 关键词是否出现在 card.requirement / card.title 中
- 或检查 card.requirement 中的实体（类名/函数名/模块名）是否也出现在 goal 中
- 阈值选 0.3（有 1-2 个关键词匹配即相关）

### 风险评估

- 中风险：相关性判断太严会拒绝合法的"旧卡复跑"场景；太松挡不住错位
- 缓解：用白名单降级——如果用户显式确认（smart confirmation 下），低相关卡仍可执行
- 改动范围可控：`pickNextPendingTask` 选卡逻辑本身不变，只是调用方加一层守卫

### 改动清单

| 文件 | 改动 |
|------|------|
| plan-stage-handler.ts | 新增 calculateGoalRelevance 函数 + pickNextPendingTask 选卡后守卫 + 合成卡兜底 |
| guards/ 或 plan-stage-handler.ts | MIN_GOAL_RELEVANCE_THRESHOLD 常量 |

---

## 实施顺序

按影响面从小到大：P2 → P1 预算 → P1 test-command → P0

P2 改动最大但最独立，先做；P0 最简洁最后做；两个 P1 中间。

## 测试策略

- 改动都在已有测试覆盖范围内（session.test.ts 覆盖 appendSessionMessage；eag-p5-llm-executor.test.ts 覆盖执行器循环；verify-stage-handler-safety.test.ts 覆盖 verify）
- 增量预算检查需要新增测试：构造 maxTokens=1000 的执行器 + 脚本 20 轮持续调用工具 → 第 5/10/15 轮触发预算超限 → tokensUsed < 1000
- goal 相关性守卫需要新增测试：残留 T-001 卡（requirement="修复登录"）+ 新 goal="订单退款" → pickNextPendingTask 应拒绝并合成新卡

---

# 附录：空循环多角色 Review 裁决与修复（2026-10-07 第二轮）

## 背景

4 条修复合入（commit 93ba88f7）后，用户反馈 /eag-autonomous "总是空循环"。多角色团队（循环机制审计员 / 规划链路审计员 / 意图入口审计员 / 执行器回路审计员）并行审计，裁决出一条四环根因链。

## 根因链

| # | 优先级 | 根因 | 位置 |
|---|--------|------|------|
| 1 | P0 | 3.5 AUTO 卡守卫走"内存态 patched"未落盘，且误将新卡 ID 加入 completedIds——下一轮重读磁盘旧卡仍 pending，守卫每轮重触发；新卡被排除出选取 → 无卡执行 → 空转 | plan-stage-handler.ts 3.5 |
| 2 | P0 | 执行器把"零工具调用纯文本回复"判 success，不检查 changedFiles——"光说不做"被记为进展 | llm-task-executor.ts 终态分支 |
| 3 | P1 | 确定性失败熔断只覆盖失败路径；全绿空转轮（无卡轮 / noop 轮）无熔断，只靠 maxIterations 兜底 | autonomous-orchestrator.ts |
| 4 | P2 | 中文滑窗膨胀使长 goal 易低于 0.3 阈值，守卫过敏放大根因 1 | computeObjectiveRelevance |

## 修复实施

1. **3.5 守卫改磁盘落盘**：旧 AUTO 卡经 `markTaskCardStatusInContent` 真实改写 blocked + 新合成卡追加，`atomicWriteTextFile` 落盘后回读重解析；删除 `patchedCompletedIds.add(newTaskId)`；判重（alreadySynthesized）改用磁盘最新内容解析（避免与 3.4 重复追加同目标卡）；3.5 不再被 3.4 的 synthesized 标志跳过（3.4 追加后旧卡仍会被 ID 升序选中——抢先路径恰在此处）。
2. **执行器 noop 标记**：零工具调用 + git 零变更 → `P5TaskExecutionResult.noop=true`（success 仍 true）；dev/fix 阶段 handler 将 noop 透传进 artifacts。
3. **连续空转熔断**：`NOOP_CIRCUIT_BREAKER_THRESHOLD=3`；编排器 5c.2 统计连续"全绿零进展"轮（无卡轮 + noop 轮），达阈值 abort；真实进展轮与失败轮清零。计数器为循环局部变量（resume 后重新计数，代价可接受，不扩展 RunState schema）。
4. **回归测试**：`eag-p5-noop-loop-fixes.test.ts` 8 用例（N1-N5 守卫落盘/判重/手写卡边界、E-N1/E-N2 noop 标记、O-N1 熔断端到端）。

## 回归结果

- core P5 系列 147/147 绿；web 248/248 绿；tsc 零错误。
- 未修复（接受现状）：根因 4 相关性算法仅调阈值会引入新误判，本次以根因 1-3 修复阻断空循环主链，根因 4 留待出现实际误判案例再治。

---

# 附录 B：任务完成"变更文件清单"设计与实现（2026-10-07 第三轮）

## 需求

/eag-autonomous 任务完成时，Web 与 CLI 都要列出本次运行修改和新增的文件清单。

## 多角色团队裁决（架构师 / 测试专家 / 宿主审计员）

1. **单一事实源**：清单只生成一份——`AutonomousRunResult.changedFiles`（结构化）+ finalReport"## 变更文件清单"段（markdown 同源渲染文本）。宿主零改动：CLI MessageView markdown 原样渲染、Web SSE assistant_message 全文透传，均自动生效。
2. **归因正确性是生命线**（测试专家 C-6 关键用例）：运行前工作区已有的脏文件（用户未提交改动）绝不能归因给本次运行。方案：run() 入口采集 git 基线快照（porcelain -uall + ls-files），结束再做终态快照差集。**不做基线差集此用例必挂**。
3. **porcelain 状态码边界**（测试专家）：新文件是 `??` 不是 `A`（LLM 执行器不会 git add）；`-uall` 展开未跟踪目录（默认折叠 `?? src/` 丢文件）；rename `R old -> new` 拆 new(M)+old(D)。
4. **诚实降级**：非 git 仓库 → changedFiles 空 + `gitAttributionAvailable=false`，报告标注"git 归因不可用"，禁止输出"无文件变更"误导结论。
5. **管线元数据排除**（实施中发现）：`.eag/`（tasks.md 状态流转、notes 记忆）每次运行必变，是编排器账本不是任务产出——快照 pathspec `:(exclude).eag/` 排除，否则只读任务也会报 tasks.md 变更淹没真实清单。

## 实现

| 文件 | 改动 |
|------|------|
| autonomous-orchestrator.ts | 新增 `RunFileChange`/`RunFileChangeKind` 类型、`GitChangeSnapshot` 内部结构；`captureGitSnapshot()`（git status -uall + ls-files，fail-open null）；`diffRunFileChanges()`（纯函数归因：?? 且基线不脏→added，M 基线跟踪→modified，D→deleted，基线脏且状态未变→排除，基线 ?? 消失→排除）；`computeRunFileChanges()`（null 降级 + added→modified→deleted 稳定排序）；run() 3b 基线快照 / 7a 终态差集；`generateFinalReport` 增清单段（三态诚实输出）；`AutonomousRunResult` 增 `changedFiles` + `gitAttributionAvailable` |
| index.ts | 导出 RunFileChange / RunFileChangeKind |
| cli / web | **零改动**（审计确认：finalReport markdown 经既有双写链路自动到达两宿主） |

## 测试

`eag-p5-changed-files-inventory.test.ts` 8 用例：CF-1 纯函数三态归类+排序、CF-2 关键归因（运行前脏文件排除）、CF-3 rename 拆分、CF-4 多轮跨任务去重（端到端真实 git）、CF-5 端到端新增+报告同源、CF-6 端到端归因（预置脏文件排除）、CF-7 非 git 诚实降级、CF-8 只读任务零变更文案。

## 回归结果

- inventory 8/8 + orchestrator happy/extended/autonomous/multi-command 26/26 = 34/34 绿；tsc 零错误。

---

# 附录 C：失败目标拦截确认逃生门死循环修复（2026-10-07 第四轮）

## 事故

失败目标拦截提示明确指引"回复执行这个"，用户连续两次照做，系统每轮都只是
"检测到该任务…请确认"——死循环，正常命令也无法执行。

## 根因链（三环闭合）

1. **拦截提示阅后即焚**：`notifyFailedGoalBlocked` 只 `onAssistantMessage` 不
   `appendSessionMessage` → 不落盘 → 既不进触发层决策 LLM 的 recentMessages，
   也不进主对话 LLM 上下文；
2. **触发层决策 LLM 看不到"等待确认"状态**：recentMessages 全是历史噪音，
   "执行这个"指代无依据 → 输出 direct_chat 或 execute_command（又命中守卫
   再拦截）；prompt 规则 3 的措辞只覆盖"上一条展示过的建议"，不覆盖
   "拦截提示等待确认"；
3. **主对话 LLM 无执行能力**：direct_chat 接管后只口头"假装执行"（用户截图中
   三段措辞各异的确认话术即主对话 LLM 产物，它每轮重新生成拦截文案但无法
   真正派发命令）。

N6 单测证明逃生门代码本身无缺陷——触发层输出 confirm_previous 即放行；
缺陷在"确认意图识别"这一输入侧环节。

## 修复方案（方向 A：拦截轮升级为主对话提问 + 触发层优先级双保险）

1. **拦截提示落盘**：`notifyFailedGoalBlocked` 改 appendSessionMessage +
   onAssistantMessage 双写 → 进入两级 LLM 上下文；
2. **主对话提问文案**：明确"直接回复『执行这个』我会立即重新发起"（不再用
   "建议提供新目标"稀释确认语义）；
3. **主对话确认通道**：direct_chat 落盘用户消息后、主对话 LLM 调用前——
   存在待确认逃生门快照且用户输入以确认短语开头 →
   `consumeConfirmPreviousDecision` 消费快照派发（与触发层 confirm_previous
   同一消费语义），主对话 LLM 不再参与；
4. **触发层 prompt 优先级规则**：recentMessages 最近 assistant 消息为拦截等待
   确认提示且当前输入表达确认执行 → confirm_previous 优先于
   execute_command/acknowledgeFailedGoal（防 LLM 误判 execute 再入拦截循环）。

## 实现

| 文件 | 改动 |
|------|------|
| session.ts | `notifyFailedGoalBlocked` 双写落盘 + 提问文案；新增 `CONFIRM_EXECUTE_PREFIXES` 常量与 `startsWithConfirmExecutePhrase` 纯函数；`handleUserPrompt` direct_chat 分支（触发层未处理、主对话 LLM 前）插入确认通道；删除 `hasFailedAutonomousRun` 死代码 |
| eag-suggestion-prompt.ts | 规则 3 扩展：拦截等待确认语境下确认短语 → confirm_previous 优先级最高 |

## 测试

- N8（session-eag-goal-failure-guard.test.ts）：触发层连续误判 execute_command（复刻事故 LLM 行为），用户"执行这个"经 direct_chat 确认通道派发，零拦截循环；
- N9（session-eag-llm-trigger.test.ts）：prompt 含 confirm_previous 优先规则 + 双写后 recentMessages 含拦截提示。
