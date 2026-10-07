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
