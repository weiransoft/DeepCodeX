# Qwen3.8 系列适配设计文档

> 状态：评审通过（架构师 + 测试专家有条件通过，v2 已落实全部修订）
> 版本：v2（2026-09-03，评审修订版）
> 关联模型卡：[Qwen/Qwen3.8-27B-FP8](https://modelscope.cn/models/Qwen/Qwen3.8-27B-FP8)

## 0. v2 评审修订记录

| 修订 | 来源 | 内容 |
|---|---|---|
| R1 | 架构师 B-1 | §4 变更清单补入 `packages/core/src/tests/settings-and-notify.test.ts`：既有 L651-664 用例以 `"medium" as never` 为非法样本，D1 落地后必挂，须将样本改为真非法值 `"ultra"` 并同步用例名 |
| R2 | 架构师 B-2 / 测试专家修正3 | §4 变更清单补入 `packages/cli/src/tests/models-dropdown.test.ts`：既有 L9-15 断言四档顺序与索引，D7 重排后必挂，须更新为六档新断言 |
| R3 | 架构师 S-1 | D2 正则锚定为 `^(?:qwen/)?qwen3\.(\d+)`，与 `isQwen3Model` 命名空间口径对齐（3.8+ 识别集 ⊆ Qwen3 识别集，消除 "unsloth/Qwen3.8" 类名称的分歧） |
| R4 | 架构师 S-2 | D3 映射 `high→medium` 补充决策理由：保守控制 token 开销取次低档；xhigh 本就是 Qwen3.8 服务端默认档，映射后无档位漂移 |
| R5 | 架构师 S-3 | D4 措辞修正：`openai-message-converter.ts` 对历史 `reasoning_content` 的回放是无条件的（不依赖 thinkingEnabled）；thinking-off 时不下发 preserve_thinking 的理由改为「不新增字段、沿用服务端默认」 |
| R6 | 架构师 S-4 | D6 补充 `??` 语义说明：空字符串不回退与 session.ts L1460 主路径语义一致，两处保持相同实现 |
| R7 | 架构师 S-5 | D8 文档同步范围扩展：补 `docs/quickstart.md` / `quickstart_en.md`（L52 三档表述）、`packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` / `configuration_en.md`（L34、L83-91）；注明 `docs/INSTALL.md:83` 示例值 `"medium"` 在 D1 落地后由静默无效变为合法（顺带修复既有文档-行为不一致） |
| R8 | 架构师 S-6 / 测试专家修正2 | §5.3 测试落点修正：reasoningEffort 既有解析用例在 `settings-and-notify.test.ts` 而非 `qwen3-settings.test.ts`（后者仅覆盖 LLM_ 环境变量别名与 thinking 默认值）；非法值断言改为黑盒断言 resolved 结果回落 `"max"`（`resolveReasoningEffort` 未导出，不新增导出） |
| R9 | 测试专家修正1 | §5.4 handle 守卫用例改为完整 handle 对象（`isOpenAIClientHandle` 校验 client/model/baseURL/thinkingEnabled 四必填字段，仅传 reasoningEffort 测不到放宽逻辑）；补旧三档正向回归与大小写敏感负向用例 |
| R10 | 测试专家 §二.1 | §5.1 补 T7-T12 边界：两位数 minor（qwen3.10）、patch 后缀（qwen3.7.9 / qwen3.8.1）、双函数分叉边界（qwen30-8b）、首尾空格、纯前缀名（qwen3.8） |
| R11 | 测试专家 §二.3 | §5.2 映射矩阵补全（T9-T12），thinking=false 路径补负向断言（请求体不含 reasoning_effort / preserve_thinking 字段） |
| R12 | 测试专家 §二.5 | 新增 S5：team-adapter 路径 Qwen3.8 端到端集成用例（复用 `packages/core/src/team/tests/team-adapter-llm.test.ts` 既有 stub 设施；该路径现仅覆盖 DeepSeek） |
| R13 | 测试专家 §二.6 | 新增文档一致性用例 `qwen38-docs-consistency.test.ts`，支撑验收标准第 8 条的自动化验证 |
| R14 | 测试专家修正4 | §5.6 集成用例 S1-S4 明确为 provider 级「真实接口契约固定响应桩」（复用 `openai-stream.test.ts` 的 `TestableOpenAILLMClient` 模式：子类化 OpenAILLMClient 覆写 `getUnderlyingOpenAI()` 返回固定响应，非 mock）；S4 采用 provider 级 `buildMessages` 观测（回放逻辑在 converter，观察链短、证明力等价） |
| R15 | 测试专家 §五.6 | 新增实施顺序约束：先更新 R1/R2 两个既有测试文件的断言，再做 D1-D8 功能改动，最后全量回归，防止中途红灯被误判为功能回归 |
| R16 | 架构师风险3 | `ThinkingRequestOptions.reasoning_effort` 类型注释显式标注「仅 Qwen3.8+ 分支产出，禁止挪到公共路径」（SDK 官方类型只认 low/medium/high，xhigh 发到 OpenAI 官方端点会 400） |

## 1. 背景与需求

### 1.1 模型卡关键信息（Qwen3.8-27B-FP8）

| 维度 | 说明 |
|---|---|
| 量化 | 细粒度 FP8 量化（块大小 128），兼容 vLLM / SGLang / Transformers |
| 架构 | 原生视觉-语言模型（图像 + 视频），27B 稠密，混合注意力（门控 DeltaNet 线性注意力 + 门控注意力）+ MTP 多 Token 预测 |
| 上下文 | 原生 262,144，可扩展至 1,000,000 |
| 思考模式 | **默认启用**，通过 `chat_template_kwargs.enable_thinking` 控制 |
| 思考保留 | **`preserve_thinking` 默认启用**（保留所有历史消息的思考块），通过 `chat_template_kwargs.preserve_thinking` 控制 |
| 推理强度 | **官方支持 `reasoning_effort` 顶层参数**：`xhigh`（默认）/ `medium` / `low` |
| 推荐采样 | 思考模式：temp=1.0 / top_p=0.95 / top_k=20；非思考模式：temp=0.7 / top_p=0.8 / top_k=20 / presence_penalty=1.5 |
| 流式输出 | `delta.reasoning_content` 或 `delta.reasoning` 字段（不同部署实现字段名不同） |

### 1.2 用户需求

结合 DeepCodeX-cli 当前（v1.1 fork）对 Qwen3 系列的支持，更新适配机制，使 CLI 完整、正确地驱动 Qwen3.8 系列模型（含 Qwen3.8-27B-FP8 本地/托管部署）：

- 正确识别 Qwen3.8 及后续 3.x（≥3.8）子版本；
- 在 thinking 模式默认启用的前提下，正确下发 `enable_thinking` / `preserve_thinking`；
- 支持官方 `reasoning_effort` 档位（xhigh / medium / low）并暴露到设置与 UI；
- 流式路径正确解析 `reasoning_content` / `reasoning` 两种字段；
- 不回归现有 Qwen3（<3.8）与 DeepSeek V4 的请求形态。

## 2. 现状与 Gap 分析

当前 Qwen3 支持（v1.1）已具备：

- `isQwen3Model`（`packages/core/src/common/model-capabilities.ts`）：`lower.startsWith("qwen3") || lower.startsWith("qwen/qwen3")`，**"Qwen/Qwen3.8-27B-FP8" 已可匹配**；
- `defaultsToThinkingMode`：Qwen3 系列默认启用 thinking，与 3.8 模型卡一致 ✓；
- `buildThinkingRequestOptions`（`packages/core/src/common/openai-thinking.ts`）：Qwen3 分支下发顶层 `chat_template_kwargs: { enable_thinking }` ✓；
- `openai-message-converter.ts`：历史 assistant 消息的 `reasoning_content` 回放（L258-264，无条件回放，与 thinkingEnabled 无关），Qwen3 system 消息扁平化（L99-104）；
- `session.ts` 主流式路径：`delta.reasoning_content ?? delta.reasoning` 双字段解析（L1460）✓。

Gap 清单：

| # | 特性 | 现状 | Gap |
|---|---|---|---|
| G1 | Qwen3.8 子版本识别 | 仅 `isQwen3Model` 粗粒度匹配 | 无 3.8+ 子版本判别，无法差异化下发新参数 |
| G2 | `reasoning_effort` | 仅 DeepSeek 分支发送（low/high/max，extra_body 内） | Qwen3.8 需顶层 `reasoning_effort`（xhigh/medium/low） |
| G3 | `preserve_thinking` | 未支持 | Qwen3.8+ thinking 模式需显式下发 `preserve_thinking: true` |
| G4 | `ReasoningEffort` 类型 | `"low" \| "high" \| "max"` | 需扩展 `medium` / `xhigh`（settings.ts L33、resolveReasoningEffort L259、openai-client.ts 类型守卫 L257、ModelsDropdown 选项） |
| G5 | openai-provider.ts 流式 | L179 仅读 `delta["reasoning_content"]` | 缺 `?? delta["reasoning"]` fallback（session.ts 主路径已有） |
| G6 | UI 档位 | max / high / low / No thinking | 缺 xhigh / medium 选项 |

已满足、无需改动：

- 上下文窗口：`getDefaultContextWindow` 非 DeepSeek-V4 默认 256K = 262,144，与 3.8 原生窗口一致 ✓；
- 多模态：`NON_MULTIMODAL_MODELS` 仅含 DeepSeek，Qwen 默认视为多模态 ✓（视频输入超出 CLI 文本输入范围，见 §7 Out of Scope）。

## 3. 设计方案

### D1：`ReasoningEffort` 类型扩展

`packages/core/src/settings.ts`：

```ts
// v1.2 变更：扩展 "medium" / "xhigh" 档位（Qwen3.8 官方档位为 low/medium/xhigh）
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
```

同步点（经全仓 grep 核实，字面量校验仅此 2 处，其余 170 处命中均为类型引用/展示/透传，自动继承无需改动）：

- `resolveReasoningEffort`（settings.ts L259-261）：接受 `low/medium/high/xhigh/max` 五个字面量；
- `openai-client.ts` `isOpenAIClientHandle`（L257-264）：类型守卫同步放宽至五档。

**兼容性**：旧值 low/high/max 全部保留，现有配置零迁移。注意 `resolveReasoningEffort` 为严格字面量相等、大小写敏感，非法值（含 `"XHIGH"`、`" high"`）回落默认 `"max"`（settings.ts L697-703 兜底）。

### D2：`isQwen38Model` 子版本判别

`packages/core/src/common/model-capabilities.ts` 新增：

```ts
/**
 * 判断是否为 Qwen3.8+ 系列模型（3.8 / 3.9 / 4.x 等后续子版本）
 *
 * 识别规则：model 转小写、去首尾空白后，匹配锚定正则 /^(?:qwen/)?qwen3\.(\d+)/，
 * 且捕获的 minor 版本号 >= 8
 * 覆盖模型：Qwen/Qwen3.8-27B-FP8 / qwen3.8-27b / qwen3.8-plus /
 * qwen3.8-max-preview / qwen3.9-70b 等
 *
 * 设计说明：
 * - 正则锚定 ^ 并仅允许 qwen/ 前缀，与 isQwen3Model 的命名空间口径
 *   （"qwen3" / "qwen/qwen3" 开头）对齐，保证 isQwen38Model 识别集 ⊆ isQwen3Model 识别集
 * - 必须带小数点（qwen3.8-…），"qwen38" / "qwen30-8b" 等非版本串不匹配
 * - 以 3.8 为能力基线：3.8 引入 reasoning_effort / preserve_thinking，
 *   后续子版本视为向后兼容同一能力集
 * - \d+ 捕获完整数字，两位数 minor（如 qwen3.10）判定为 10 >= 8
 *
 * @param model 模型名称
 * @returns 是否为 Qwen3.8+ 系列模型
 */
export function isQwen38Model(model: string): boolean {
  const lower = model.trim().toLowerCase();
  const match = /^(?:qwen\/)?qwen3\.(\d+)/.exec(lower);
  if (!match) return false;
  return Number(match[1]) >= 8;
}
```

### D3：`buildThinkingRequestOptions` Qwen3 分支改造

`packages/core/src/common/openai-thinking.ts`：

```ts
type ThinkingRequestOptions = {
  thinking?: ThinkingConfig;
  extra_body?: {
    reasoning_effort?: ReasoningEffort;
  };
  chat_template_kwargs?: {
    enable_thinking: boolean;
    /** Qwen3.8+：保留历史消息思考块（与 CLI 无条件回放 reasoning_content 的语义一致） */
    preserve_thinking?: boolean;
  };
  /**
   * Qwen3.8+：官方顶层 reasoning_effort（xhigh / medium / low）
   *
   * 注意：仅 Qwen3.8+ 分支产出，禁止挪到公共路径——
   * OpenAI SDK 官方类型只认 low/medium/high，xhigh 发到 OpenAI 官方端点会 400
   */
  reasoning_effort?: "xhigh" | "medium" | "low";
};
```

Qwen3 分支逻辑：

| 条件 | 请求体 |
|---|---|
| Qwen3.8+ 且 thinkingEnabled=true | `{ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }, reasoning_effort: map(reasoningEffort) }` |
| Qwen3.8+ 且 thinkingEnabled=false | `{ chat_template_kwargs: { enable_thinking: false } }` |
| Qwen3（<3.8） | `{ chat_template_kwargs: { enable_thinking: thinkingEnabled } }`（**零回归**） |

档位映射 `mapReasoningEffortToQwen`：

| CLI 档位 | Qwen3.8 顶层值 | 说明 |
|---|---|---|
| `low` | `low` | 直传 |
| `medium` | `medium` | 直传 |
| `high` | `medium` | Qwen3.8 无 high 档。决策：保守控制 token 开销，向下钳到次低档（而非上探 xhigh），避免高吞吐场景成本失控 |
| `xhigh` | `xhigh` | 直传（Qwen3.8 服务端默认档） |
| `max` | `xhigh` | max 高于官方最高档，钳制到 xhigh |

映射单调不降；settings 默认档 `"max"`（L697-703 兜底）映射为 xhigh，与模型服务端默认一致，无档位漂移。

**`preserve_thinking` 显式下发 `true` 的理由（D4）**：
CLI 的 `openai-message-converter.ts`（L258-264）对历史 assistant 消息的 `reasoning_content` 回放是**无条件的**（不依赖 thinkingEnabled）。thinking 模式下这与 `preserve_thinking: true` 语义完全吻合；模型卡虽标注默认启用，但显式下发可免疫服务端默认值变更，且与 CLI 回放行为保持强一致。thinking 关闭时不新增该字段、沿用服务端默认，避免下发无效参数。

**旧模型回归保护**：`isQwen38Model` 为 false 的 Qwen3（如 qwen3-8b、Qwen3-32B、qwen3.5-xxx、qwen30-8b）走原分支，请求形态与 v1.1 逐字节一致；DeepSeek 分支不动；非 Qwen/非 DeepSeek 模型仍返回 `{}`（OpenAI 官方 o-series 等不受影响）。

### D5：推荐采样参数 —— 不实现（YAGNI，已提交架构师评审并认可）

模型卡推荐的 temp/top_p/top_k/presence_penalty 组合**暂不自动注入**，理由：

1. CLI 现有语义：temperature 未显式配置时不发送，由服务端用模型默认值采样；Qwen3.8 在 vLLM 上的服务端默认值即模型卡推荐值；
2. 自动覆盖用户已配置的 temperature/top_p 会破坏用户控制权；
3. 若后续验证存在部署差异，可在 settings 增加 `samplingProfile` 配置项（本期不做）。

结论：仅在本文档记录推荐值，代码不实现。

### D6：openai-provider.ts 流式 reasoning 双字段解析

`packages/core/src/providers/openai-provider.ts` L179（流式）：

```ts
// 与 session.ts L1460 主路径对齐：兼容 reasoning_content（vLLM）与 reasoning（部分部署）两种字段。
// 说明：?? 仅在 null/undefined 时回退，reasoning_content 为空字符串时不回退——
// 空字符串后续 length > 0 判定不产生事件，与主路径语义保持一致（两处实现相同）
const reasoningRaw =
  (delta as unknown as Record<string, unknown>)["reasoning_content"] ??
  (delta as unknown as Record<string, unknown>)["reasoning"];
if (typeof reasoningRaw === "string" && reasoningRaw.length > 0) {
  yield { type: "thinking_delta", thinking: reasoningRaw };
}
```

非流式 `createMessage`（L110）同步加 `?? msg["reasoning"]` fallback（同一 `??` 语义）。

### D7：ModelsDropdown 新增档位选项

`packages/cli/src/ui/components/ModelsDropdown/index.tsx`：

```ts
export const MODEL_COMMAND_THINKING_OPTIONS: ThinkingModeOption[] = [
  { label: "Thinking mode [xhigh]", thinkingEnabled: true, reasoningEffort: "xhigh" },
  { label: "Thinking mode [max]", thinkingEnabled: true, reasoningEffort: "max" },
  { label: "Thinking mode [high]", thinkingEnabled: true, reasoningEffort: "high" },
  { label: "Thinking mode [medium]", thinkingEnabled: true, reasoningEffort: "medium" },
  { label: "Thinking mode [low]", thinkingEnabled: true, reasoningEffort: "low" },
  { label: "No thinking", thinkingEnabled: false },
];
```

- `getThinkingOptionIndex`（L25-33，已导出，L167 + ui barrel）按 `reasoningEffort` 精确匹配、未命中回 0，五档均可命中，**函数本身无需改动**；
- 组件 `maxVisible={6}` 恰好容纳六项，无需调整。

### D8：文档同步（范围经评审扩展）

| 文档 | 变更 |
|---|---|
| `docs/configuration.md` / `configuration_en.md` | L35 取值更新为五档；L178 章节补充五档说明表；L141-176 Qwen3 章节补充 3.8+ 参数表格（enable_thinking / preserve_thinking / 顶层 reasoning_effort 映射） |
| `docs/quickstart.md` / `quickstart_en.md` | L52 `reasoningEffort` 取值更新为五档 |
| `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` / `configuration_en.md` | L34 取值表、L83-91 五档说明表同步（内置 skill 参考文档，随包分发，须与 docs 一致） |
| `docs/INSTALL.md` | L83 示例值 `"reasoningEffort": "medium"` 无需改动——**顺带修复**：当前代码下该示例静默无效（解析回落 max），D1 落地后恰好变合法，消除既有文档-行为不一致 |
| `docs/qwen38-adaptation.md` / `_en.md` | 本文档（设计依据留档） |

D8 另需写明一对偶关系：CLI 侧无条件回放 `reasoning_content` 与服务端 `preserve_thinking` 默认值共同决定历史思考块是否进入 prompt——排查「模型忘记上文思考」类问题时需同时看两侧。

## 4. 变更文件清单（经评审补全）

| 文件 | 变更 |
|---|---|
| `packages/core/src/settings.ts` | `ReasoningEffort` 扩展五档；`resolveReasoningEffort` 同步（D1） |
| `packages/core/src/common/model-capabilities.ts` | 新增 `isQwen38Model`（D2） |
| `packages/core/src/common/openai-thinking.ts` | Qwen3 分支改造（D3）；`ThinkingRequestOptions` 类型扩展（含 R16 注释） |
| `packages/core/src/common/openai-client.ts` | `isOpenAIClientHandle` 守卫放宽至五档（D1） |
| `packages/core/src/providers/openai-provider.ts` | 流式/非流式 reasoning 双字段 fallback（D6） |
| `packages/cli/src/ui/components/ModelsDropdown/index.tsx` | 新增 xhigh / medium 选项、六档顺序（D7） |
| `packages/core/src/tests/settings-and-notify.test.ts` | **既有断言更新**（R1）：L651-664 非法样本 `"medium" as never` → `"ultra"`，用例名同步；新增五档解析用例（§5.3） |
| `packages/cli/src/tests/models-dropdown.test.ts` | **既有断言更新**（R2）：L9-15 四档顺序/索引断言 → 六档新断言（§5.5）；新增 xhigh/medium 用例 |
| `docs/configuration.md` / `configuration_en.md` | 五档文档 + Qwen3.8 参数说明（D8） |
| `docs/quickstart.md` / `quickstart_en.md` | 五档取值同步（D8） |
| `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` / `configuration_en.md` | 五档文档同步（D8） |
| 新增测试（§5 列明） | — |

**不改动**：`session.ts`（主路径 L1460 已兼容）、`openai-message-converter.ts`、`team-adapter.ts`（L681 经 `buildThinkingRequestOptions` 自动继承新行为）、`docs/INSTALL.md`（R7 顺带修复，无需编辑）。

## 5. 测试设计

约定：node:test + `node:assert/strict`，中文注释，请求体断言一律 `assert.deepStrictEqual`（宽松 `deepEqual` 不用于请求体）。新测试文件放 `packages/core/src/tests/`（顶层 glob）、`packages/core/src/providers/tests/`（递归 glob）或 `packages/cli/src/tests/`，均自动发现，**无需修改任何 package.json**。

### 5.1 `qwen38-model-capabilities.test.ts`（core，新增，unit）

`isQwen38Model` 判定（对应 §6 第 1 条）：

- T1 `"Qwen/Qwen3.8-27B-FP8"` → true
- T2 `"qwen3.8-27b"` / `"qwen3.8-plus"` / `"qwen3.8-max-preview"` / `"qwen3.9-70b"` / `"QWEN/QWEN3.8-27B"` → true（大小写 / 前缀 / 后续版本）
- T3 `"qwen3-8b"` / `"Qwen3-32B"` / `"qwen3.5-72b"` / `"qwen3.7-max"` → false（无小数点不误伤、3.5/3.7 不算 3.8+）
- T4 `"qwen38-10b"` → false（无小数点不匹配）
- T5 `""` / `"  "` → false；`"qwen2.5-72b"` → false（非 Qwen3 系列）
- T6 子集性质：所有 T1/T2 样例同时满足 `isQwen3Model(...) === true`（锚定正则下该性质由构造保证）
- T7 `"qwen3.10-plus"` → true（两位数 minor=10，验证 `\d+` 捕获完整数字）
- T8 `"qwen3.7.9-xxx"` → false（patch 后缀，捕获首段 7 < 8）
- T9 `"qwen3.8.1-xxx"` → true（多位小数取首段 8）
- T10 `"qwen30-8b"` → `isQwen38Model === false` 且 `isQwen3Model === true`（双函数分叉边界：必须落入旧 Qwen3 分支）
- T11 `"  qwen3.8-plus  "`（首尾空格）→ true（trim 行为固化）
- T12 `"qwen3.8"`（无 `-` 后缀）→ true（纯前缀名命中）

### 5.2 `qwen38-thinking.test.ts`（core，新增，unit）

`buildThinkingRequestOptions` 映射矩阵（对应 §6 第 2、4 条），全部 `deepStrictEqual`：

- T1 Qwen3.8 thinking=true effort=max → `{ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }, reasoning_effort: "xhigh" }`（max 钳制 xhigh）
- T2 effort=high → `reasoning_effort: "medium"`（降档映射）
- T3 effort=xhigh → `"xhigh"`；effort=medium → `"medium"`；effort=low → `"low"`（直传三档）
- T4 Qwen3.8 thinking=false（effort=xhigh）→ 恰好 `{ chat_template_kwargs: { enable_thinking: false } }`，且负向断言 `!("reasoning_effort" in result)`、`!("preserve_thinking" in result.chat_template_kwargs)`
- T5 旧 Qwen3（"qwen3-8b"）thinking=true → 恰好 `{ chat_template_kwargs: { enable_thinking: true } }`（零回归）
- T6 旧 Qwen3（"Qwen3-30B-A3B"）thinking=false → 恰好 `{ chat_template_kwargs: { enable_thinking: false } }`
- T7 分叉边界（"qwen30-8b"）thinking=true → 走旧分支（与 T5 同形态）
- T8 非 thinking 模型（"gpt-4o"）thinking=true → `{}`
- T9 DeepSeek 回归（"deepseek-v4-pro"）thinking=true → `thinking: { type: "enabled" }` + `extra_body.reasoning_effort`，且无 `chat_template_kwargs` / 顶层 `reasoning_effort`
- T10 DeepSeek 回归 thinking=false → `thinking: { type: "disabled" }`，无 extra_body

### 5.3 `settings-and-notify.test.ts` 扩展（core，既有文件，unit）

reasoningEffort 解析（对应 §6 第 2 条），黑盒断言 `resolveSettings(...)` 结果：

- T1 userSettings `reasoningEffort: "xhigh"` → resolved `"xhigh"`
- T2 userSettings `reasoningEffort: "medium"` → resolved `"medium"`
- T3 非法值 `"ultra"` / `"XHIGH"`（大写）/ `" high"`（带空格）→ resolved 回落 `"max"`（严格字面量、大小写敏感）
- T4 systemEnv `REASONING_EFFORT: "xhigh"` 穿透 → resolved `"xhigh"`
- T5 优先级回归：systemEnv `"low"` 覆盖 userSettings `"high"` → resolved `"low"`
- T6 **既有断言更新**：L651-664 用例非法样本 `"medium" as never` → `"ultra"`，断言维持 `"max"`，用例名改为 `defaults invalid reasoning effort (ultra) to max`

### 5.4 `qwen38-handle-guard.test.ts`（core，新增，unit）

`isOpenAIClientHandle` 五档守卫（对应 §6 第 6 条）。**必须传完整 handle**（client/model/baseURL/thinkingEnabled 四必填字段）：

- T1 正向：完整 handle + `reasoningEffort: "xhigh"` → true；`"medium"` → true
- T2 正向回归：`"low"` / `"high"` / `"max"` → true（放宽后旧值不可误拒）
- T3 负向：`reasoningEffort: "ultra"` → false；`"xHIGH"`（大小写敏感）→ false
- T4 缺 `client` 键 → false（守卫基础行为回归）

### 5.5 `models-dropdown.test.ts` 扩展（cli，既有文件，unit）

（对应 §6 第 6 条）`getThinkingOptionIndex` 经 `../ui` barrel 导出，纯函数直接调用：

- T1 **既有断言更新**：`MODEL_COMMAND_THINKING_OPTIONS.map(option => option.reasoningEffort)` deepEqual `["xhigh", "max", "high", "medium", "low", undefined]`
- T2 `getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "xhigh" })` → 0；`"medium"` → 3
- T3 `getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "unknown" })` → 0（未命中回 0 行为回归）
- T4 `{ thinkingEnabled: false }` → 5（No thinking 项回归）

### 5.6 `qwen38-integration.test.ts`（core，新增，provider 级场景集成）

Stub 规范（禁止 mock/简化）：复用 `packages/core/src/providers/tests/openai-stream.test.ts` 的 `TestableOpenAILLMClient` 模式——子类化 `OpenAILLMClient` 覆写 `getUnderlyingOpenAI()` 返回**真实接口契约的固定响应桩**（`chat.completions.create` 记录 params 并 yield 真实形状的 chunk），非 mock、不绕过构造器。

- S1 Qwen3.8 thinking=true 请求体（对应 §6 第 2 条）：settings `model: "qwen3.8-plus"`、`thinkingEnabled: true`、`reasoningEffort: "xhigh"`，调 `createMessageStream` → 捕获的 `params` 含顶层 `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }` 与 `reasoning_effort: "xhigh"`（deepStrictEqual）
- S2 thinking=false 负向（对应 §6 第 3 条）：`thinkingEnabled: false` → `params` 恰好含 `{ chat_template_kwargs: { enable_thinking: false } }`，且 `!("reasoning_effort" in params)`
- S3 双字段 fallback（对应 §6 第 5 条）：桩分别 yield `{ delta: { reasoning_content: "A" } }` 与 `{ delta: { reasoning: "B" } }` 两组流 → provider 均产出非空 `thinking_delta` 事件
- S4 多轮回放 + preserve_thinking 同现（对应 §6 第 2 条语义一致性）：历史 assistant 消息 `messageParams: { reasoning_content: "上一轮思考" }`，经 provider `buildMessages` → 请求 `params.messages` 中该消息保留 `reasoning_content`，且同一请求体含 `preserve_thinking: true`

### 5.7 `team-adapter-llm.test.ts` 扩展（core，既有文件，S5 场景集成）

对应 §6 第 2 条 team 调用路径（buildThinkingRequestOptions 三个调用点中，现仅 DeepSeek 有覆盖）：

- S5 复用该文件既有 `buildStubClient()`，构造 handle `{ model: "qwen3.8-plus", thinkingEnabled: true, reasoningEffort: "xhigh", client: 桩 }` 走 executeDispatch → 捕获请求体含 `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }` 与 `reasoning_effort: "xhigh"`（deepStrictEqual 逐字段）

### 5.8 `qwen38-docs-consistency.test.ts`（core，新增，文档一致性）

对应 §6 第 8 条的自动化支撑：

- T1 `fs.readFileSync` 读取 `docs/configuration.md` 与 `docs/configuration_en.md`，断言文本包含 `"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"` 五档字面量及 `preserve_thinking`
- T2 同法校验 `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md`（内置 skill 文档随包分发，防「代码改了文档没改」）

### 5.9 全量回归（零回归红线）

- `cd packages/core && npm test` 与 `cd packages/cli && npm test` 全部通过；
- **以下文件 D3 后不得有任何改动**（改动即回归）：`qwen3-thinking.test.ts`（全部模型名走 <3.8 旧分支）、`qwen3-model-capabilities.test.ts`（既有 3.6/3.7 用例断言不变，仅新增 isQwen38Model 组）、`openai-thinking.test.ts`（DeepSeek）、`session-skill-matching-safety.test.ts`（L248 Qwen3.6 `{enable_thinking:false}`）。

### 5.10 实施顺序（防误判红灯）

1. 先更新 R1（settings-and-notify.test.ts 既有断言）与 R2（models-dropdown.test.ts 既有断言）两个既有测试文件；
2. 再做 D1-D8 功能改动 + 新增测试；
3. 最后 core + cli 全量回归。

## 6. 验收标准

| # | 标准 | 测试支撑 |
|---|---|---|
| 1 | `isQwen38Model` 对 §5.1 T1-T12 全部样例给出正确结果（含两位数 minor、patch 后缀、分叉边界、trim） | §5.1 |
| 2 | Qwen3.8 thinking 模式请求体含 `enable_thinking: true` + `preserve_thinking: true` + 顶层 `reasoning_effort`，五档映射表（D3）全覆盖，session 级与 team 级调用点均生效 | §5.2 T1-T4 + §5.6 S1 + §5.7 S5 |
| 3 | Qwen3.8 非 thinking 模式请求体仅含 `enable_thinking: false`，**不含** reasoning_effort / preserve_thinking 残留字段 | §5.2 T4 + §5.6 S2 |
| 4 | 旧 Qwen3（<3.8，含 qwen30-8b 分叉边界）请求体与 v1.1 逐字节一致 | §5.2 T5-T7 + §5.9 红线文件零改动 |
| 5 | DeepSeek V4 请求形态零变化 | §5.2 T9-T10 + openai-thinking.test.ts 零改动 |
| 6 | 五档可经 settings 解析（含非法值回落 max）、经 handle 守卫（旧三档正向 + 新两档 + 非法负向）、在 UI 六项可选 | §5.3 + §5.4 + §5.5 |
| 7 | openai-provider 流式对 `reasoning` / `reasoning_content` 两字段均产出 `thinking_delta` | §5.6 S3 |
| 8 | core + cli 全量测试通过；`docs/configuration*.md` 与内置 skill 参考文档与实现一致 | §5.9 + §5.8 |

## 7. Out of Scope（记录但不实现）

- **视频输入**：模型支持视频理解，但 CLI 输入通道为文本/图片，视频输入不在本期范围；
- **推荐采样参数自动注入**（D5）：见 §3-D5 决策（架构师已认可 YAGNI 拒绝）；
- **1M 上下文扩展**：需服务端 RoPE 扩展配置，CLI 无法控制，保持 256K 默认；
- **MTP（多 Token 预测）**：服务端推理优化，与请求协议无关。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 部分 vLLM 旧版本不识别 `preserve_thinking` | 参数经 `chat_template_kwargs` 透传给 jinja 模板，模板未声明时静默忽略，无 400 风险（与 enable_thinking 同通道） |
| 部分部署不识别顶层 `reasoning_effort` | OpenAI SDK 透传未知字段，vLLM 对未声明参数忽略；且仅在 thinking=true 时下发 |
| 顶层 `reasoning_effort: "xhigh"` 误发 OpenAI 官方端点会 400 | R16：类型注释显式标注「仅 Qwen3.8+ 分支产出，禁止公共化」；§5.2 T8 固化非 Qwen 模型零字段行为 |
| 五档与 DeepSeek extra_body 档位交互 | DeepSeek 分支维持原样（L64-70 不动），xhigh/max 在 DeepSeek 路径原样透传 extra_body，服务端行为由部署方定义，不新增钳制 |
| 历史思考块是否进 prompt 依赖双侧行为 | D8 文档写明 CLI 无条件回放与 `preserve_thinking` 服务端默认的对偶关系（R5）；§5.6 S4 固化同现断言 |
| 多轮 thinking 开→关→再开 | `chat_template_kwargs` 逐请求无状态，无服务端残留；再开时 reasoning_effort 按当前 settings 重新映射（预期行为） |
| UI 选项过多 | 六项按强度降序，xhigh 置顶（Qwen3.8 默认档），No thinking 殿后；maxVisible=6 恰好容纳 |
| 变更可回滚性（Karpathy 四原则） | 无新抽象层、无新依赖；`isQwen38Model` 对所有既有模型名恒 false，未出现 3.8+ 模型名时全链路与 v1.1 逐字节一致，逐文件可独立回滚 |
