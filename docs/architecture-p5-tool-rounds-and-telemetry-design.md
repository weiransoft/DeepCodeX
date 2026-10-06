# DeepCodeX-CLI P5 架构修复方案设计

> 架构师视角 · 只写设计不写代码 · 基于真实代码路径审计
> 代码版本：`packages/core/src/eag/p5/**` 2026-10-07 HEAD

---

## 任务 1：LlmTaskExecutor 12 轮工具上限的架构级修复

### 1.1 现状审计

#### 1.1.1 常量定义位置

| 位置 | 值 | 作用域 |
|---|---|---|
| `packages/core/src/eag/p5/executors/llm-task-executor.ts` L218 | `const DEFAULT_MAX_TOOL_ROUNDS = 12` | 模块级常量（冻结语义） |
| `packages/core/src/eag/p5/executors/llm-task-executor.ts` L330 | `LlmTaskExecutorOptions.maxToolRounds?: number` | 构造选项可选字段 |
| `packages/core/src/eag/p5/executors/llm-task-executor.ts` L388 | `const rounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS` | 构造函数内解析 |

#### 1.1.2 真正的触发点（两层防线）

**触发点 A：循环硬停** — llm-task-executor.ts:506
```typescript
for (let round = 1; round <= this.maxToolRounds; round += 1) { ... }
```
到达 12 轮后循环终止，不进入任何 `break` 分支，自然落到循环后的失败路径。

**触发点 B：循环后失败收口** — llm-task-executor.ts:647-650
```typescript
const roundLimitError = `工具循环达上限（${this.maxToolRounds} 轮）仍未给出终态回复`;
emitProgress("task_end", `执行失败：${roundLimitError}`, roundLimitError);
return this.failure(roundLimitError, llmRequests);
```
注意：这里走的是 `failure()` 方法，会把 `tokensUsed` 置零（与任务 2 根因链耦合）。

#### 1.1.3 TaskCard 接口检查

guards/types.ts:116-151 的 `TaskCard` 接口**当前无** `maxToolRounds` 可声明字段。

TaskCard 是静态声明的任务单元（从 tasks.md 解析或由 plan 阶段从 objective 合成），不携带执行时约束。执行器的 `maxToolRounds` 是 SessionManager 在**构造** `LlmTaskExecutor` 时注入的单例级固定值——对所有任务卡共享。

#### 1.1.4 现有熔断机制与轮数上限的关系

执行器已有两个熔断（比单纯提升上限更重要）：
- **拒绝风暴熔断**（llm-task-executor.ts:494-496）：同一目标路径累计 6 次被拒绝 → 终止
- **相同调用空转熔断**（llm-task-executor.ts:503-504）：连续 3 轮输出完全相同的工具调用 → 终止

**这两个熔断独立于轮数上限生效**，意味着即便把上限提升到 100，空转也不会超过 3 轮。轮数上限的真正作用是防"有效但没完没了"的场景。

---

### 1.2 三个方案对比

#### 方案 A：TaskCard 新增 `maxToolRounds` 可声明字段

**改动点：**

| 文件 | 行号范围 | 改动内容 |
|---|---|---|
| `guards/types.ts` | TaskCard 接口末尾 | 新增 `readonly maxToolRounds?: number` 可选字段 |
| `handlers/task-executor-port.ts` | P5TaskExecutionInput | 新增 `maxToolRounds?: number` 可选字段（透传自 TaskCard） |
| `handlers/dev-stage-handler.ts` | executeTask 调用处（L342-352） | 从 taskCard.maxToolRounds 透传 |
| `handlers/fix-stage-handler.ts` | executeTask 调用处（L349-360） | 从 taskCard.maxToolRounds 透传 |
| `executors/llm-task-executor.ts` | runLoop 循环起点（L506） | 局部计算 `effectiveRounds = input.maxToolRounds ?? this.maxToolRounds` |

**优势：**
- 每张任务卡可按复杂度精细化配置（简单卡 12 轮，部署卡 40 轮）
- 向下兼容：不声明即使用执行器默认值
- 与 `G-A6d 上限不可自改` 护栏一致：TaskCard 声明的上限是用户/编排器显式意图，而非 LLM 可自行放宽

**劣势：**
- 改动面较广（5 个文件跨 4 层）
- tasks.md 作者需要了解这个新字段的语义；plan 阶段自动合成卡不会填这个字段
- 部署场景中"几十步"的任务卡通常是 plan 从 objective 合成而非手写 tasks.md 声明，自动合成路径依然会使用执行器默认值

#### 方案 B：断点续跑——跨迭代注入工具进度

**设计构想：** 让执行器在到达上限后，把 `messages` 历史（含 system + user + 全部 assistant/tool 消息）持久化到 JSONL；下一轮 fix 阶段先读历史，把已有进度注入消息序列后继续循环。

**复杂度评估（不推荐）：**

| 维度 | 复杂度 | 根因 |
|---|---|---|
| 跨迭代消息历史持久化 | 高 | 需定义独立的 `execution-history.jsonl` 格式，在 RunState 之外再维护一份状态 |
| `ToolExecutor` sessionId 状态延续 | 中 | 当前 `finally` 块（llm-task-executor.ts:663-666）无条件调用 `clearSessionState(toolSessionId)` 清 snippet/文件状态。续跑需要保留旧 sessionId 并跳过清理，与当前 fail-closed 设计直接冲突 |
| 上下文膨胀控制 | 高 | 每轮循环向 messages 追加 ~3-8KB（assistant 文本 + 多个 tool 结果摘要）。20 轮后 ≈ 120-160KB ≈ 30-40K tokens，超过多数模型的 128K 上下文上限的 1/3-1/2。50 轮后 ≈ 75-100K tokens 进入危险区 |
| 续跑失败的一致性 | 高 | 如果历史注入后模型再次失败，需要再续跑……会引入无限续跑的元问题，必须配套"续跑次数上限"新护栏 |
| 对现有熔断的影响 | 中 | 拒绝风暴/相同调用熔断的状态（`denialCountsByTarget` / `lastCallFingerprint`）也需要跨迭代延续，否则续跑后模型会重复已被熔断的无效动作 |
| 测试矩阵 | 高 | 需要覆盖：续跑成功、续跑失败、历史损坏、上下文溢出、abort 后续跑、不同模型上下文长度差异 |

**结论：** 复杂度爆炸。断点续跑本质是在编排器层面重构一个"长会话 LLM 代理"，而执行器的设计初衷就是"一次调用 = 一张任务卡 = 一个短循环"。这个方案违背了 `LlmTaskExecutor` 的单一职责（架构师审查 P0-6 的选型结论）。

#### 方案 C：框架级提升默认上限到 40

**改动点：**

| 文件 | 行号 | 改动内容 |
|---|---|---|
| `executors/llm-task-executor.ts` | 218 | `DEFAULT_MAX_TOOL_ROUNDS = 12` → `DEFAULT_MAX_TOOL_ROUNDS = 40` |

**Token/资源风险评估：**

| 指标 | 40 轮最坏值 | 与预算的关系 |
|---|---|---|
| 单轮输入 tokens（含历史） | 增长曲线：第 1 轮 ~5K，第 40 轮 ~100K（消息数组累积） | 40 轮后接近模型上下文上限的 1/3 |
| 单轮输出 tokens（EXECUTION_MAX_TOKENS） | 8192（固定） | 可忽略 |
| 单任务总 tokens（估算） | 40 轮 × 平均 3000 input ≈ 120K input + 40 × 2000 output ≈ 80K | ≈ 200K / 任务，在 `DEFAULT_MAX_TOKENS = 200_000` 预算边缘 |
| 编排器级最大消费 | 10 迭代 × 40 轮 = 400 次 LLM 请求 | 由 LoopScheduler 的 token 预算闸门（loop/scheduler.ts）独立生效，检查 `totalTokensUsed >= maxTokens` → `stop_failure` |

**三个缓解因子降低了真实风险：**
1. **熔断前置**：拒绝风暴 6 次、相同调用 3 次先触发，不会烧完 40 轮。真正用到 30+ 轮的是"每轮 1-2 步有效动作 + 中间穿插验证"的场景
2. **自然终态**：绝大多数编码任务在 5-12 轮内就给出终态回复。40 轮是 ceiling 而非 floor
3. **编排器级 token 预算**（`DEFAULT_MAX_TOKENS = 200_000`）在 LoopScheduler 中独立生效，即便执行器上限 40 轮也会在总 token 耗尽前被 stop_failure 拦截

**结论：风险可控。** 从 12 → 40 的线性提升不引入结构性风险。

---

### 1.3 推荐方案 + 实施顺序

**第一步（立即修复）：方案 C**
把 `DEFAULT_MAX_TOOL_ROUNDS` 从 12 提到 40。一行改动，零破坏性，与现有熔断 + 编排器 token 预算形成三重安全网。

**第二步（后续增强）：方案 A**
在 TaskCard 上新增 `maxToolRounds` 可选字段，让手写 tasks.md 用户可按卡配置。这个步骤**可选**——当前自动合成卡路径不填此字段，仍走 40 轮默认值，对部署场景已足够。

**明确拒绝方案 B（断点续跑）。** 复杂度/收益比严重失衡，违背执行器单一职责设计。

---

## 任务 2：run-state 遥测聚合修复

### 2.1 现状审计

#### 2.1.1 RunState 结构定义位置

| 字段 | 声明位置 |
|---|---|
| `totalLlmCallCount: number` | run-state-store.ts:191 `P5RunState` 接口 |
| `totalTokensUsed: number` | run-state-store.ts:193 `P5RunState` 接口 |
| 初始化（置零） | run-state-store.ts:578-579 `initialize()` 方法 |
| localChecksum 计算 | run-state-store.ts:854-855 `computeLocalChecksum()` 方法 |

#### 2.1.2 执行器内部 token/LLM 计数

| 变量 | 位置 | 累计方式 |
|---|---|---|
| `llmRequests` | llm-task-executor.ts:431 | 每次 `createMessage` 后 `llmRequests += 1`（L526） |
| `inputTokensTotal` / `outputTokensTotal` | llm-task-executor.ts:432-433 | 累计 `response.usage`；网关无 usage 时走字符估算 |
| `estimatedCharsTotal` | llm-task-executor.ts:434 | 无 usage 时 fallback |

成功路径结算（llm-task-executor.ts:551-558）：
```typescript
return Object.freeze({
  success: true,
  tokensUsed: tokensUsed.tokens,          // ← 正确结算
  llmRequests,                             // ← 正确传递
  ...
});
```

#### 2.1.3 聚合失败根因链（三层 Bug）

**根因 1（执行器层）：failure() 方法丢弃已累计的 tokens**

llm-task-executor.ts:1097-1107：
```typescript
private failure(error: string, llmRequests: number): Readonly<P5TaskExecutionResult> {
  return Object.freeze({
    success: false,
    tokensUsed: 0,        // ← 硬编码 0，哪怕已经跑了 12 轮真实 LLM 请求
    llmRequests,          // ← 只有 llmRequests 被保留
    ...
  });
}
```

所有走 failure() 的路径（上限熔断、拒绝风暴、相同调用熔断、abort、异常）都会丢失 token 累计。

**根因 2（编排器层）：totalLlmCallCount 基于 tokensUsed>0 做近似估算**

autonomous-orchestrator.ts:827-835：
```typescript
totalTokensUsed += result.tokensUsed;          // failure() 时加 0
if (result.tokensUsed > 0) {                   // 0 > 0 为 false
  totalLlmCallCount += 1;                      // 跳过！执行器跑了 12 轮也不计入
}
if (typeof result.artifacts["llmRequests"] === "number") {
  totalExecutorLlmRequests += result.artifacts["llmRequests"];  // 这个审计计数是正确的
}
```

注意：编排器已经维护了一个 `totalExecutorLlmRequests`（autonomous-orchestrator.ts:694），专门读取 `artifacts["llmRequests"]`。这个计数是正确的，但它**没有被**作为最终结果的 `totalLlmCallCount` 返回——后者仍走 tokensUsed 近似路径。

**根因 3（架构层）：plan/verify 阶段根本不调用 LLM**

plan-stage-handler.ts 和 verify-stage-handler.ts 全部走 `createSuccessStageResult(..., 0, ...)` 或 `createFailedStageResult(..., 0, ...)`，tokensUsed 硬编码为 0。这意味着：

- totalLlmCallCount ≈ dev 成功次数 + fix 成功次数（每个阶段 +1）
- 但一个 dev 阶段内部执行器可能已经跑了 20 次 LLM 请求

**实际观察到的"恒为 0"场景：** 部署任务大概率触发 12 轮上限熔断 → 执行器走 failure() → tokensUsed=0 → orchestrator tokens 累计 0 → llmCallCount 也不增 → RunState 写 0/0。这与用户报告完全吻合。

---

### 2.2 修复方案

#### 改动 1（执行器层，核心修复）：failure() 携带已累计的 tokens

| 文件 | 行号 | 当前 | 改为 |
|---|---|---|---|
| llm-task-executor.ts | 失败路径调用（L467/509/621/643/650/655/660） | `failure(error, llmRequests)` | `failure(error, llmRequests, sawUsage, inputTokensTotal + outputTokensTotal, estimatedCharsTotal)` |
| llm-task-executor.ts L1097 | failure 签名 | `failure(error, llmRequests)` | `failure(error, llmRequests, sawUsage, realTokens, estimatedChars)` |
| llm-task-executor.ts L1101 | failure 内 tokensUsed | 硬编码 `0` | 调用 `this.resolveTokensUsed(sawUsage, realTokens, estimatedChars).tokens`（与成功路径同构） |

循环内所有调用 failure() 的位置**全部在 `runLoop` 闭包内**，闭包已捕获 `llmRequests / inputTokensTotal / outputTokensTotal / estimatedCharsTotal / sawUsage`，参数透传无额外状态管理。

#### 改动 2（编排器层，次要修复）：用 artifacts.llmRequests 替代 tokensUsed>0 近似

| 文件 | 行号范围 | 当前 | 改为 |
|---|---|---|---|
| autonomous-orchestrator.ts L827-L835 | 5b-3 统计累加块 | `if (result.tokensUsed > 0) { totalLlmCallCount += 1; }` | 直接用 `artifacts.llmRequests` 累加：`totalLlmCallCount += (result.artifacts["llmRequests"] as number) ?? 0;` |
| autonomous-orchestrator.ts L834-L835 | totalExecutorLlmRequests | 保留（作为审计维度补充） | 可合并到 totalLlmCallCount 或保留独立字段 |

**为什么改动 2 是改动 1 的必要补充？** 即便 failure() 正确返回了 tokensUsed=6000（假设 12 轮），编排器的 `if (result.tokensUsed > 0) { totalLlmCallCount += 1; }` 也只会加 1，而非真实的 12。`artifacts["llmRequests"]` 是精确计数，dev/fix handler 无论成功失败都会透传（dev-stage-handler.ts:365, fix-stage-handler.ts:373）。

#### 改动 3（StageHandler 层，零改动）

dev-stage-handler 和 fix-stage-handler **已经**把 `execution.tokensUsed` 和 `execution.llmRequests` 写入了 P5StageResult 的对应字段和 artifacts。不需要改。

plan/verify handler 不调用 LLM，tokensUsed 保持 0 是正确语义，不需要改。

---

### 2.3 完整改动清单汇总

| 优先级 | 文件 | 改动类型 | 行数 | 内容 |
|---|---|---|---|---|
| P0 | `executors/llm-task-executor.ts` L218 | DEFAULT_MAX_TOOL_ROUNDS | 1 行 | 12 → 40（任务 1 方案 C） |
| P0 | `executors/llm-task-executor.ts` L1097 | failure() 签名扩展 | ~10 行 | 新增 sawUsage/realTokens/estimatedChars 入参，内部用 resolveTokensUsed 结算 |
| P0 | `executors/llm-task-executor.ts` L467 等 7 处 | failure() 调用点 | ~7 处 | 透传闭包内已累计的 token 变量 |
| P1 | `autonomous-orchestrator.ts` L827-L835 | 统计累加逻辑 | ~5 行 | 用 `artifacts.llmRequests` 直接累加替代 tokensUsed>0 近似 |
| P2（可选） | `guards/types.ts` | TaskCard 新增字段 | 1 行 | `maxToolRounds?: number`（任务 1 方案 A） |
| P2（可选） | `handlers/task-executor-port.ts` | 输入端口扩展 | 1 行 | `maxToolRounds?: number` |
| P2（可选） | dev-stage-handler / fix-stage-handler | 透传 | 各 1 行 | 从 taskCard 读取透传到 executeTask |
| P2（可选） | `executors/llm-task-executor.ts` L506 | 循环上限解析 | ~3 行 | 局部 effectiveRounds 计算 |

---

### 2.4 风险点

| 风险 | 影响 | 缓解 |
|---|---|---|
| failure() 返回的 tokensUsed 是估算值（网关无 usage 时），但会被编排器当作真实值累加 | 低风险：执行器已有 `tokensEstimated` 标志；编排器不区分估算/真实，对统计用途够用 | 若需精确区分，可在 P5TaskExecutionResult 层面新增 `tokensEstimated` 聚合字段 |
| 编排器从 tokensUsed>0 近似改为直接累加 llmRequests 后，plan/verify 阶段（无 LLM）不再贡献 +1，totalLlmCallCount 数字会**突然下降** | 预期行为：旧值本来就是错的。正确值应该是"dev 阶段真实 LLM 请求数 + fix 阶段真实 LLM 请求数" | 验收时以"执行器 llmRequests 总和 = 编排器 totalLlmCallCount"等式成立为通过标准 |
| 默认上限提升到 40 后，某些"低效但有效"的任务（每轮一次 ls 查看、一次 edit）会自然走更长循环 | 低风险：熔断机制（拒绝风暴 6 次、相同调用 3 次）独立生效；LoopScheduler token 预算 200K 独立闸门 | 可在运行时观察"达到上限仍未收敛"的频率，若仍高发再引入方案 A 的 TaskCard 级上限 |

---

### 2.5 可验证的成功标准（binary check）

**任务 1（轮数上限）：**
1. 构造 LlmTaskExecutor 不传 maxToolRounds 时，`this.maxToolRounds === 40`
2. 传 maxToolRounds=8 时，`this.maxToolRounds === 8`（测试用例收窄）
3. 执行器运行到 13 轮后（旧 DEFAULT_MAX_TOOL_ROUNDS）不终止，继续到 40 轮才进入 roundLimitError
4. 拒绝风暴/相同调用熔断在 40 轮上限下仍然独立生效（3/6 次即终止）

**任务 2（遥测聚合）：**
1. 执行器达到轮数上限 → failure() 返回 `success=false, tokensUsed>0, llmRequests=N`
2. 编排器统计累加块：dev 成功阶段 `totalLlmCallCount += execution.llmRequests`（直接透传执行器的精确计数，而非 tokensUsed>0 近似）
3. 编排器运行一次含 dev/fix 全绿的迭代后，`RunState.totalLlmCallCount === 本轮 dev 执行器 llmRequests + 本轮 fix 执行器 llmRequests`；`RunState.totalTokensUsed === 本轮 dev tokensUsed + 本轮 fix tokensUsed`（plan/verify 贡献 0，正确）
4. `AutonomousRunResult.totalLlmCallCount === 所有迭代的 llmRequests 总和`
5. 手动 mock 一个"执行器跑了 15 轮后因上限失败"的场景：最终 RunState 的 totalLlmCallCount 应 ≥ 15（修复前恒为 0）

---

### 附录：代码路径速查

```
LlmTaskExecutor (executors/llm-task-executor.ts)
├── DEFAULT_MAX_TOOL_ROUNDS = 12  (L218)  ← 任务1改动点
├── LlmTaskExecutorOptions.maxToolRounds (L330)
├── runLoop() (L412)
│   ├── for round=1..this.maxToolRounds (L506)  ← 触发点A
│   ├── 成功路径 resolveTokensUsed (L540)
│   ├── 7 处 failure() 调用 (L467/509/621/643/650/655/660)
│   └── 循环后 roundLimitError + failure() (L647-650)  ← 触发点B + 任务2根因
└── failure(error, llmRequests) (L1097)  ← 任务2核心改动

AutonomousOrchestrator (autonomous-orchestrator.ts)
├── totalLlmCallCount / totalTokensUsed 初始化 (L687-688)
├── 5b-3 累加块 (L827-835)  ← 任务2次要改动
│   ├── totalTokensUsed += result.tokensUsed
│   ├── if (result.tokensUsed > 0) { totalLlmCallCount += 1; }  ← 近似 hack
│   └── totalExecutorLlmRequests += result.artifacts.llmRequests  ← 正确但未被消费
├── 5g 保存 RunState 快照 (L1077-1087)  ← 写入 0/0
├── 迭代用尽保存 (L1149-1159)
└── 最终结果构造 (L1199-1212)

P5RunState (run-state-store.ts)
├── 接口声明 totalLlmCallCount (L191) / totalTokensUsed (L193)
├── initialize() 置零 (L578-579)
├── computeLocalChecksum() (L854-855)  ← 校验和覆盖这两个字段
└── save() 每次快照追加 (L623-676)
```
