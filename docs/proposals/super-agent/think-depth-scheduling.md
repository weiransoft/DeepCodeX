# 按回合思考深度调度（Adaptive Thinking Depth）

> 2026-11-07 · 规则版本 `THINK_DEPTH_RULES_VERSION = 1`
> 目标：陪伴模式 / 闲聊 / 任务对话（含陪伴模式内出现的任务回合）按意图、复杂度、
> 上下文长度与响应时效动态升降思考深度；**不降回复质量、不改陪伴语气、
> 不牺牲任务准确率**的前提下减少冗余推理、缩短 TTFT 与整体延迟。

---

## 1. 变更说明

### 1.1 现状与缺口

仓库原有一套完整的 thinking 控制链路（五档 `ReasoningEffort`、
`buildThinkingRequestOptions()`、Qwen3.8 / DeepSeek V4 / Claude 差异化请求体、
thinking 流式通道），但它是**全局静态**的：`activateSession()` 在方法开头解构一次
`thinkingEnabled / reasoningEffort`，整个会话的所有迭代复用同一组值。

后果：

- 「嗯」「谢谢」「今天有点累」也要付满额推理预算，首响应时间被无意义的思考拖长；
- 陪伴模式里忽然出现的「帮我把这个报错排一下」没有任何机制把深度还回去；
- 模式（`work` / `companion`）只在建会话时注入 Soul 提示词，无法表达「同一模式内
  逐回合变化」的诉求。

### 1.2 核心设计：只下调，不超越基线

> **铁律：调度只下调，永不超过用户在 settings 里配置的 `reasoningEffort`。**

`full` 恒等于用户的静态基线。所谓「升」是从下调状态**回弹到基线**。
因此「复杂任务保证充分思考」不是承诺而是结构上不可能违反：任务回合拿到的
请求参数与调度器上线前逐字段一致。全部收益来自轻场景被省掉的冗余推理。

**陪伴语气与风格一致性同样由结构保证**：本改动没有新增、修改、删除任何一条
人格 / 语气 / 安全提示词。Soul 提示词原样注入，调度只改模型请求参数。
陪伴模式内的任务回合仍是陪伴语气（提示词没变），只是思考深度还给了任务。

### 1.3 改动清单

| # | 文件 | 变更 |
|---|---|---|
| 1 | `packages/core/src/think-depth.ts` | **新增**。纯函数调度器：四维信号、场景分类、四档档位、滞回、护栏、效率指标聚合。无 I/O、无全局时钟、无 `process.env`。 |
| 2 | `packages/core/src/common/openai-thinking.ts` | 新增 `thinkingControlForModel()`，与请求体分支同源地判定模型**实际**支持哪种控制。 |
| 3 | `packages/core/src/super-agent/soul/modes.ts` | 新增 `SOUL_COMPANION_MODE_MARKER` 与 `detectSoulModeFromPrompt()`：从本会话真正注入的提示词反查模式，而不是读磁盘最新配置。 |
| 4 | `packages/core/src/session.ts` | 新增 `resolveTurnThinkingDepth()`；主循环每轮在构造请求体前计算一次；`thinkingEnabled` / `reasoningEffort` / Claude `budget_tokens` 改用本轮值；`LlmStreamProgress` 增加 `thinkDepth` 遥测；debug 日志带场景/档位。 |
| 5 | `packages/core/src/providers/llm-provider.ts` | `LLMRequest` 增加**可选** `reasoningEffort` / `thinkingBudgetTokens`（后台调用零改动）。 |
| 6 | `packages/core/src/providers/openai-provider.ts` | 请求级 effort 优先，未传时 100% 回落 settings 快照。 |
| 7 | `packages/core/src/providers/anthropic-provider.ts` | 请求级 `budget_tokens` 优先，未传时回落构造期快照。 |
| 8 | `packages/core/src/index.ts` | 导出调度器纯函数与契约类型，供宿主/测试复用。 |
| 9 | `packages/web/src/api/chat-api.ts` | 新增 `parseThinkingDepthParams()` **严格白名单**；JSON 与 multipart 两条入口接入。 |
| 10 | `packages/web/src/session-pool.ts` | `SendMessageInput.messageParams` → `UserPromptContent.messageParams`；`llm_delta` 透传 `thinkDepth`。 |
| 11 | `packages/web/web/src/voice/voice-bus.ts` | 一次性语音来源标记（`markVoiceOrigin` / `consumeVoiceOrigin`）+ `noteVoiceThinkDepth()`。 |
| 12 | `packages/web/web/src/components/Composer.tsx` | 语音识别自动提交前打标记。 |
| 13 | `packages/web/web/src/App.tsx` | `submitToChat()` 消费标记并随请求下发 `latencySensitive`；`onLlmDelta` 透传档位快照。 |
| 14 | `packages/web/web/src/api.ts` / `sse.ts` | `SendTextPayload`、`LlmDeltaEvent` 增加可选字段；multipart 复用既有 `payload` 通道。 |
| 15 | `packages/web/web/src/voice/latency.ts` | 新增 `ThinkDepthSnapshot` 与 `summarizeDepthEfficiency()`：按档位分组的 TTFT / E2E / TTFA 分位。 |
| 16 | `packages/web/web/src/voice/useVoiceTalk.ts` | `LatencySample` 携带本轮档位；`beginTurn()` 复位快照。 |
| 17 | `packages/core/src/tests/think-depth.test.ts` | 新增 27 项纯函数单测（golden 语料 / 护栏 / 滞回 / 降级 / 指标）。 |
| 18 | `packages/web/tests/think-depth-transport.test.ts` | 新增 10 项单测（白名单 / 一次性标记 / 效率指标）。 |

---

## 2. 场景化调度规则

### 2.1 场景 → 目标档位

| 场景 | 判据（摘要） | 目标档 | thinking | effort |
|---|---|---|---|---|
| `small_talk` | 工作模式 + 寒暄/致谢/极短应答，无任务结构信号 | `off` | 关 | low（不发送） |
| `emotional` | 工作模式 + 情感词命中 | `light` | 开 | low |
| `companion_chat` | 陪伴模式 + 闲聊/情感 | `off`（纯闲聊）/ `light`（情感） | 关 / 开 | low |
| `companion_task` | **陪伴模式内的任务回合**，复杂度 < 0.45 | `balanced` | 开 | medium |
| `task` | 任务意图命中，复杂度 < 0.42 | `full` | 基线 | **基线** |
| `complex_task` | 复杂度 ≥ 0.42 / ≥160 字 / 含代码块；含陪伴模式内的复杂任务 | `full` | 基线 | **基线** |
| `ambiguous` | 信号不足，或重上下文下的短指代句 | `balanced` | 基线 | medium |
| `crisis` | 自伤/自杀/伤害他人等危机词 | `balanced` | 开 | medium |
| `tool_continuation` | `iteration > 0` / 权限答复 / `/continue` / 编排命令 | `full` | 基线 | **基线** |

> `off` 与 `light` 的 effort 都是 `low`，区别在 `thinkingEnabled`：前者直接关闭
> 思考并跳过历史 `reasoning_content` 回放，后者保留一次短推演。
> 情感陪伴刻意**不**用 `off`——直接关思考容易退化成「加油」「抱抱」这类
> 放之四海皆准的空话，与陪伴模式提示词里「复述要具体」的要求相冲突。

### 2.2 四个输入维度

| 维度 | 具体实现 | 对档位的作用 |
|---|---|---|
| 用户意图 | `TASK_WORDS` / `SOCIAL_WORDS` / `EMOTION_WORDS` / `CRISIS_WORDS` 命中数，`analyzeTurn()` 归一化为 0~1 分数 | 决定场景；混合意图含任务结构信号时**一律按任务走**（情绪被接住的前提是事没办错） |
| 问题复杂度 | 字符数、分句数、代码块、路径、命令、多步标记、编号列表加权 | ≥0.42 标 `complex_task` 并回弹基线；陪伴模式中等复杂任务取 `balanced` |
| 上下文长度 | 会话未 compact 消息的字符数分桶（<8k / 8k–32k / >32k） | 重上下文 + 短指代句不降级；轻场景不因历史长而被误升档 |
| 响应时效 | 语音回合 `latencySensitive`、用户催促词 | 放宽短句判据（+8 字）、推动轻场景快速响应；**绝不削减任务/危机回合的思考** |

### 2.3 平滑（滞回）与升/降语义

- **升档即时**：任务、复杂任务、危机、工具续跑立即回到基线，不被上一轮轻量档位拖住。
- **明确轻场景立即降**：置信度 ≥ `CLEAR_LIGHT_CONFIDENCE` 的闲聊/陪伴闲聊不等确认
  ——这类回合对 TTFT 最敏感，等两轮等于没优化。
- **只有边界模糊回合需要确认**：`ambiguous` 或低置信轻场景需连续
  `DOWNGRADE_CONFIRM_TURNS = 2` 轮同向建议，且每轮最多下降
  `MAX_DOWNGRADE_STEPS = 1` 档（`full → balanced → light → off`）。
  成本只落在边界，避免在「闲聊 ↔ 任务」抖动时语气与详略忽长忽短。
- **可回退**：任意一轮任务回合都把状态直接拉回 `full`；`DCX_THINK_DEPTH=off`
  或单回合 `messageParams.thinkingDepth = "fixed"` 完全跳过调度。

---

## 3. 关键参数

| 参数 | 值 | 含义 |
|---|---|---|
| `SHORT_TURN_MAX_CHARS` | 24 | 短回合上限，超过不再因「短」加社交分 |
| `VOICE_SHORT_BONUS_CHARS` | 8 | 语音回合短句阈值放宽量（ASR 常带填充词） |
| `LONG_TURN_MIN_CHARS` / `COMPLEX_TURN_MIN_CHARS` | 80 / 160 | 长度复杂度起点 / 复杂文本阈值 |
| `CONTEXT_LIGHT_MAX_CHARS` / `CONTEXT_MEDIUM_MAX_CHARS` | 8,000 / 32,000 | 上下文分桶边界 |
| `TASK_INTENT_THRESHOLD` | 0.28 | 任务意图判定 |
| `LIGHT_INTENT_THRESHOLD` / `EMOTION_INTENT_THRESHOLD` | 0.30 / 0.25 | 闲聊 / 情感意图判定 |
| `COMPLEX_TASK_THRESHOLD` | 0.42 | 复杂任务标签阈值（只影响标记，两档都吃满基线） |
| `CLEAR_LIGHT_CONFIDENCE` | 0.72 | 立即降档所需置信度 |
| `DOWNGRADE_CONFIRM_TURNS` | 2 | 边界场景连续确认轮数 |
| `MAX_DOWNGRADE_STEPS` | 1 | 每轮最多下降档数 |
| `EFFORT_LADDER` | low / medium / high / xhigh / max | 五档；`off`/`light`→low，`balanced`→medium，`full`→基线 |
| `BUDGET_RATIO` | off 0 / light 0.30 / balanced 0.60 / full 1.00 | Claude `budget_tokens` 缩放 |
| `MIN_THINKING_BUDGET_TOKENS` | 1024 | Anthropic API 硬下限 |
| `DCX_THINK_DEPTH` | `off` = 禁用 | 一键回到静态基线（缺省自适应） |

---

## 4. 边界与异常处理

| 情况 | 处理 |
|---|---|
| 模型不支持 effort（`control=none`） | **诚实降级**：请求体本来就没有 thinking 字段，不假装有加速，`effective=false`。唯一真实收益是 `off` 档跳过历史 `reasoning_content` 回放、减少 prefill token。 |
| 旧 Qwen3（`control=binary`） | 只有 `enable_thinking` 开关，档位塌缩成开/关；`off` 关、`light` 开，不伪造档位。 |
| Claude（`control=budget`） | 用 `budget_tokens` 缩放；`off` 不发 thinking 块；预算不低于 1024。 |
| 用户全局关闭 thinking | 调度器**不会**把 thinking 打开；`off` 之外档位的 `thinkingEnabled` 恒等于基线 `false`。 |
| 用户配置低档 effort（`low`） | 所有档位钳在基线之下，`full` = `low`；绝不越权提升。 |
| 危机信号 | 禁用 `off` / `light`；安全规则优先，且从任意档位即时升到 `balanced`。 |
| 工具续跑 / 权限答复 / 编排命令 | 强制 `full`；防止「继续」「允许」这类短文本被误判成闲聊而截断上下文。 |
| 带附件 / 图片 | 按任务回合处理，不降级。 |
| 重上下文 + 短指代句 | 归为 `ambiguous`，保守取 `balanced`。 |
| 语音 + 复杂任务 | 时效压力**不**作用于任务回合，仍吃满基线；只放宽轻场景判据。 |
| 混合意图（情绪 + 任务） | 有任务结构信号或任务分不低于社交分 → 按任务处理；语气仍由原 Soul 提示词负责。 |
| 脏输入 / 数值 NaN / 非法 mode / 异常 | 一律 `fallback=true`，回到静态基线，且 `effective=false`；启发式绝不成为会话失败原因。 |
| 会话模式切换 | 读本会话**实际注入**的 Soul 提示词（会话建立后不改历史），不读磁盘最新值。 |
| HTTP 入口的 `messageParams` | 严格白名单：只认 `latencySensitive: true` 与 `thinkingDepth: "fixed"`，其余（含 `codingLoopRequest`）全部丢弃，避免浏览器借 CLI 编排容器越权。 |
| 旧服务端 / 旧前端 bundle | `llm_delta.thinkDepth`、`LlmDeltaEvent.thinkDepth`、`VoiceTalk.noteThinkDepth` 全部可选且可选调用；缺字段时行为与上线前一致。 |
| 调度本身 | 纯字符串启发式，**不新增任何 LLM 调用**；调度耗时相对 LLM 请求可忽略。 |

---

## 5. 可验证的效率与质量指标

### 5.1 效率指标（代码已提供聚合函数）

- 后端：`summarizeThinkingDepthEfficiency()`（`packages/core/src/think-depth.ts`）
- 前端：`summarizeDepthEfficiency()`（`packages/web/web/src/voice/latency.ts`）

| 指标 | 定义 | 数据来源 |
|---|---|---|
| `ttftP50Ms` / `ttftP95Ms` | 按档位分组的 LLM 首正文 token 延迟分位 | `LlmStreamProgress.timing.firstContentMs` → SSE `llm_delta.timing` → `VoiceTurnLatency.llmTtftMs` |
| `e2eP50Ms` | 用户说完 → 首音出声（端到端） | 五时间戳 `speechEndAtMs` / `firstAudioAtMs` |
| `ttfaP50Ms` | 单调时钟 TTFA | `LatencySample.ttfaMs` |
| `downgradedRatio` | 非 `full` 档样本占比 | `llm_delta.thinkDepth.level` |
| `fallbackRatio` / `fallbackCount` | 兜底样本占比/计数 | `thinkDepth.fallback` |
| `ttftSavingP50Ms` | `full.ttftP50 − off(or light).ttftP50` | 聚合计算；**任一侧缺实测值则 `undefined`，绝不填 0** |

**A/B 验收协议（同一台机器、同一 golden 语料、同一模型与负载）**：

1. `DCX_THINK_DEPTH=off` 跑一批 → 全部样本 `level=full`，得到静态基线 TTFT / E2E 分位。
2. 默认自适应跑同一批 → 轻场景落到 `off` / `light`，任务场景仍为 `full`。
3. 对比 `ttftSavingP50Ms`、`byLevel.full.ttftP50Ms` 是否**不劣于**基线，
   以及 `byLevel.full.e2eP50Ms` 是否不变。
4. 任何一侧缺实测时间戳，报告留 `undefined`，不得报「已优化」。

> 本报告**不填任何未经真机测量的数字**。调度器与聚合函数已就绪，
> 真实收益需在上述 A/B 中采集；这与仓库「禁止伪造通过」的红线一致。

### 5.2 质量指标（护栏，全部为可执行断言）

| 指标 | 验收方式 | 状态 |
|---|---|---|
| 任务准确率 | 任务/复杂任务/工具续跑回合的请求参数与静态基线逐字段一致（T5、T7、T12 单测）；现有 `npm test` 全量回归 | 结构上保证 |
| effort 不越基线 | 五档基线 × 五种文本的穷举断言（T4） | 单测覆盖 |
| 陪伴语气与风格一致性 | **零提示词改动**（1.2）；`renderModeSection()` 输出 unchanged；`super-agent-soul-mode.test.ts` 既有 M1–M9 全量回归 | 单测覆盖 |
| 情感回应自然度 | 情感场景不降到 `off`（T1、T8）；危机禁用快速档与思考关闭 | 单测覆盖 |
| 场景识别准确率 | 10 条 golden 语料逐条断言场景 + 档位（T1），含 2 条「陪伴模式内任务回合」 | 单测覆盖 |
| 场景切换平滑 | 滞回确认 / 每轮最多一档 / 升档即时（T11–T13） | 单测覆盖 |
| 可回退 | `enabled=false` 完全等价于静态基线（T14）；脏输入仍返回基线（T15、T16） | 单测覆盖 |
| 入口安全 | HTTP `messageParams` 白名单丢弃编排参数（W1–W4） | 单测覆盖 |
| 语音标记不串扰 | 一次性消费、键盘输入不继承（W5、W6） | 单测覆盖 |
| 指标不伪造 | 缺实测值留 `undefined`（T25、W9） | 单测覆盖 |

### 5.3 运行命令

```bash
# 新增专项单测
node --import tsx --test --test-concurrency=1 packages/core/src/tests/think-depth.test.ts
TSX_TSCONFIG_PATH=packages/web/tests/tsconfig.json \
  node --import tsx --test --test-concurrency=1 packages/web/tests/think-depth-transport.test.ts

# 全量门禁
npm run build -w @vegamo/deepcode-core   # 刷新 .d.ts，web typecheck 依赖
npm run check                           # typecheck + lint + prettier + ipc contract
npx tsc -p packages/web/web/tsconfig.json --noEmit
npm test
npm run build
```
