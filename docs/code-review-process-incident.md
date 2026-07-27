# 原始 review 报告失实事件检讨

> 检讨日期：2026-07-27
> 事件：原始报告 `docs/code-review-2026-07-27.md` 与多角色团队 review 验证结果差异巨大
> 涉及组件：DeepCodeX-cli TUI 对话模式 + Qwen3.6-27B LLM

---

## 一、事件概述

### 1.1 事件经过

| 步骤 | 时间 | 操作 | 结果 |
|------|------|------|------|
| ① | 2026-07-27 早 | 用户在 DeepCodeX-cli TUI 中输入 `/review 当前工程代码` | LLM 接收为普通对话消息 |
| ② | 同上 | SessionManager 调用 Qwen3.6-27B 生成响应 | 输出原始报告（CRIT-1/2/3 + HIGH-1~6 + MED-1~6 + LOW-1~3） |
| ③ | 同上 | 用户保存为 `docs/code-review-2026-07-27.md` | 报告入库 |
| ④ | 2026-07-27 晚 | 多角色团队 fan-out-aggregate 验证 | 发现 5 项失实/误报，1 项严重低估，1 项严重夸大 |
| ⑤ | 同上 | 输出 `docs/code-review-2026-07-27-review.md` | 357 行检讨报告 |

### 1.2 差异规模

| 维度 | 原始报告 | review 验证 | 差异倍数 |
|------|---------|-----------|---------|
| CRIT-1 TypeScript 错误数 | 14 | **170** | 低估 12 倍 |
| HIGH-1 生产代码 any 数 | 44 | **2** | 夸大 22 倍 |
| HIGH-3 未格式化文件数 | 32 | **0** | 完全失实 |
| HIGH-4 ESLint warnings | 136 | 131 + **10703 errors 遗漏** | 严重不完整 |
| HIGH-6 shebang 位置 | 用户 hook | husky 内部 hook | 误判 |
| MED-4 .gitignore 注入 | 存在 | **不存在** | 误报 |
| 失实问题占比 | - | 5/12（42%） | 严重 |

---

## 二、根因分析

### 2.1 直接原因：LLM 幻觉生成

**LLM 没有系统性地调用工具进行真实验证**，而是基于训练数据"补全"了看似合理的数字和细节。

**证据**：

| 问题编号 | 失实模式 | 推断 LLM 行为 |
|---------|---------|-------------|
| CRIT-1 | 低估 12 倍 | LLM 可能运行了 `npm run typecheck` 但只读取了输出尾部（14 个错误），或基于"常见 TS 错误"猜测 |
| HIGH-1 | 夸大 22 倍 | LLM 用 grep 搜索 `any` 但**没有区分字符串模板和真实类型注解**，把 `llm-filler.ts` 内的 LLM 生成样本代码也算入 |
| HIGH-3 | 完全失实（0 vs 32） | LLM **没有运行** `prettier --check`，直接幻觉"32 个文件未格式化"（因为 quality/ 是新模块，看起来"应该"未格式化） |
| HIGH-6 | 误判 shebang 位置 | LLM **没有读取** `.husky/pre-commit`，基于 husky v8 时代记忆猜测"用户 hook 有 shebang" |
| MED-4 | 误报路径注入 | LLM **没有读取** `.gitignore`，基于"路径注入是常见风险"虚构了具体条目 |

### 2.2 根本原因：DeepCodeX-cli 系统设计缺陷

#### 缺陷 1：`/review` 不是内置命令，缺乏专门的 review 工作流

**现状**：
- `slash-commands.ts` 中只有 `/memory`、`/code-review`（指向 skill）等，**没有 `/review`**
- 用户输入 `/review 当前工程代码` 被作为**普通对话消息**处理
- LLM 基于 system prompt 自由发挥，没有结构化的 review 流程

**应有设计**：
- `/review` 应该是内置命令，触发结构化 review 工作流
- 工作流应强制执行：① 项目扫描 → ② 工具验证（typecheck/lint/format） → ③ 报告生成
- 每个数据点必须有真实的命令输出作为证据

#### 缺陷 2：System Prompt 缺乏工具调用强制约束

**现状**（`packages/core/src/prompt.ts:96-98`）：

```typescript
const SYSTEM_PROMPT_BASE = `你是名叫Deep Code的交互式CLI工具，帮助用户完成软件工程任务。
Use the instructions below and the tools available to you to assist the user.

重要：严禁编造任何非编程相关的 URL...`;
```

**问题**：
- 没有强制要求 LLM 在生成报告时使用工具验证
- 没有要求 LLM 区分"已验证"和"猜测"
- 没有要求 LLM 在数据缺乏时明确说明"未验证"

**应有约束**：
- "生成代码审查报告时，必须使用 bash 工具运行 typecheck/lint/format 命令"
- "所有数字必须有命令输出作为证据，禁止猜测"
- "无法验证的项目必须标注'未验证'，不得编造"

#### 缺陷 3：`debugLogEnabled: false` 导致无法追溯

**现状**（`~/.deepcode/settings.json`）：

```json
{
  "debugLogEnabled": false,
  "telemetryEnabled": false
}
```

**问题**：
- LLM 的所有工具调用历史**未被记录**
- 无法追溯 LLM 是否调用了 bash/read 工具
- 无法验证 LLM 的工具调用参数和返回结果
- 出现失实报告时无法定位是"幻觉"还是"工具调用错误"

**应有配置**：
- 默认启用 `debugLogEnabled: true`
- 记录所有 LLM 请求/响应到 `debug.log`
- 记录所有工具调用到 `tool-calls.log`
- 记录所有错误到 `error.log`

#### 缺陷 4：LLM 模型能力与任务复杂度不匹配

**现状**：
- 模型：Qwen3.6-27B（27B 参数）
- 任务：审查 356,303 行代码、705 个文件
- 期望：准确识别 typecheck 错误数、any 使用数、格式化状态

**问题**：
- 27B 模型在单次对话中无法系统性地扫描 705 个文件
- 模型倾向于"看起来合理"的幻觉而非"穷尽验证"的严谨
- 对于需要批量命令执行的任务，单次对话模式天然不适合

**应有方案**：
- 使用 multi-agent-team 的 fan-out-aggregate 拓扑并行验证
- 每个 subagent 负责一个维度的真实验证
- 聚合多方结果形成共识报告

#### 缺陷 5：缺乏"证据强制"机制

**现状**：
- LLM 生成的报告直接输出给用户
- 没有要求 LLM 为每个数据点附上命令输出证据
- 没有后处理验证环节

**应有机制**：
- 报告生成后，自动运行验证脚本（如 `npm run typecheck`）
- 对比报告数据与验证结果，标记差异
- 差异超过阈值时拒绝输出，要求 LLM 重新生成

---

## 三、改进方案

### 3.1 短期改进（1-2 天）

#### 改进 1：强化 System Prompt

修改 `packages/core/src/prompt.ts:96-98`，添加"工具验证优先"约束：

- 生成代码审查报告时，必须使用 bash 工具运行验证命令（npm run typecheck / npx eslint / npx prettier --check）
- 报告中每个数字必须有对应的命令输出作为证据
- 无法验证的项目必须明确标注"未验证"，不得编造
- 使用"已验证"/"未验证"/"不确定"三档标注每个结论的置信度

#### 改进 2：默认启用 debug 日志

修改 `~/.deepcode/settings.json`：`debugLogEnabled` 改为 `true`

**收益**：
- 可追溯 LLM 的所有工具调用历史
- 出现失实报告时可定位是"幻觉"还是"工具调用错误"
- 为后续优化提供数据基础

#### 改进 3：添加 `/review` 内置命令

在 `packages/cli/src/ui/core/slash-commands.ts` 中添加 `/review` 命令，触发结构化 review 工作流：

1. 强制运行验证命令（typecheck / lint / format）
2. 将真实结果作为上下文传给 LLM
3. LLM 基于真实数据生成报告

### 3.2 中期改进（1-2 周）

#### 改进 4：报告后处理验证

实现 `ReportValidator` 类，验证报告中的数据点是否与真实命令输出一致：

- 提取报告中的数字声明
- 运行对应验证命令
- 对比差异并标记严重度
- 差异超过阈值时拒绝输出

#### 改进 5：多角色团队 review 作为标准流程

将 multi-agent-team 的 fan-out-aggregate 拓扑作为代码审查的标准流程：

```
/review 当前工程代码
    ↓
触发 fan-out-aggregate 工作流
    ↓
并行派发 3 个角色 subagent：
  - 架构师（search）：架构维度验证
  - 测试专家（general_purpose_task）：质量维度验证
  - 独立开发者（general_purpose_task）：实现维度验证
    ↓
聚合三方意见形成共识报告
    ↓
后处理验证数据点
    ↓
输出报告（附验证证据）
```

### 3.3 长期改进（1-2 月）

#### 改进 6：LLM 模型升级评估

**问题**：Qwen3.6-27B 在单次对话中无法系统性扫描 705 个文件

**方案**：
- 升级到更大参数的模型（如 Qwen3.6-72B / Claude 3.7 Sonnet）
- 或使用专用代码审查模型（如 CodeLlama-70B）
- 配合 multi-agent-team 并行验证

#### 改进 7：工具调用强制门禁

在 SessionManager 中添加"工具调用强制门禁"：

- 检测 LLM 响应是否为报告类内容（含"审查/分析/评估/review/audit"）
- 检测是否含具体数字 + 表格
- 检测是否未检测到工具调用
- 触发后拦截输出，提示 LLM 补充工具调用

---

## 四、经验教训

### 4.1 LLM 生成报告类内容的可信度

**教训**：LLM 生成的报告类内容**默认不可信**，必须经过工具验证。

**原因**：
- LLM 倾向于生成"看起来合理"的内容而非"穷尽验证"的内容
- 27B 参数模型无法在单次对话中系统性扫描 705 个文件
- 缺乏工具调用约束时，LLM 会基于训练数据"补全"细节

**应对**：
- 报告类任务必须强制工具验证
- 多角色团队并行验证比单次 LLM 对话更可靠
- 每个数据点必须有命令输出作为证据

### 4.2 日志可观测性的重要性

**教训**：`debugLogEnabled: false` 导致无法追溯 LLM 行为，加剧了问题定位难度。

**应对**：
- 默认启用 debug 日志
- 关键场景（如报告生成）必须记录工具调用历史
- 日志是诊断 LLM 幻觉问题的唯一可靠依据

### 4.3 System Prompt 设计的关键作用

**教训**：简短的 system prompt 不足以约束 LLM 行为，需要明确的"工具验证优先"约束。

**应对**：
- System prompt 应明确要求"报告类任务必须工具验证"
- 要求 LLM 区分"已验证"和"未验证"
- 禁止 LLM 编造无法验证的具体数字

### 4.4 多角色团队 review 的价值

**教训**：本次 review 报告通过 fan-out-aggregate 拓扑发现了 5 项失实/误报，证明了多角色验证的价值。

**应对**：
- 代码审查任务默认采用多角色团队 review
- 每个角色 subagent 必须真实执行命令验证
- 聚合三方意见形成共识报告

---

## 五、行动项跟踪

| 编号 | 改进项 | 优先级 | 截止日期 | 状态 |
|------|-------|-------|---------|------|
| A1 | 强化 System Prompt（工具验证优先约束） | P0 | 2026-07-28 | 待开始 |
| A2 | 默认启用 debugLogEnabled | P0 | 2026-07-28 | 待开始 |
| A3 | 添加 `/review` 内置命令（结构化工作流） | P1 | 2026-08-01 | 待开始 |
| A4 | 实现 ReportValidator 后处理验证 | P1 | 2026-08-05 | 待开始 |
| A5 | 多角色团队 review 作为标准流程 | P2 | 2026-08-10 | 待开始 |
| A6 | LLM 模型升级评估 | P3 | 2026-08-30 | 待开始 |
| A7 | 工具调用强制门禁 | P3 | 2026-08-30 | 待开始 |

---

## 六、总结

原始 review 报告失实的根本原因是 **DeepCodeX-cli 系统设计缺陷**叠加**LLM 幻觉**：

1. `/review` 不是内置命令，缺乏结构化 review 工作流
2. System Prompt 缺乏"工具验证优先"约束
3. `debugLogEnabled: false` 导致无法追溯 LLM 行为
4. 27B 模型在单次对话中无法系统性扫描 705 个文件
5. 缺乏报告后处理验证机制

**核心改进方向**：
- **短期**：强化 system prompt + 启用 debug 日志 + 添加 `/review` 内置命令
- **中期**：实现 ReportValidator + 多角色团队 review 标准化
- **长期**：LLM 模型升级 + 工具调用强制门禁

**关键原则**：LLM 生成的报告类内容**默认不可信**，必须经过工具验证。多角色团队 fan-out-aggregate 拓扑是验证 LLM 报告的有效手段。
