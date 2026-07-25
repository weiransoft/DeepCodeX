# Pattern Selection Rules 详细参考

本文件详细说明 6 种 `WorkflowPattern` 的选择规则、`TaskFeature` 字段含义与模式选择示例。

## TaskFeature 16 维字段说明

| 字段 | 类型 | 含义 | 默认值 |
|------|------|------|--------|
| `type_variants` | number | 任务类型变体数（多少种不同类型的子任务） | 1 |
| `subtask_count` | number | 子任务数 | 1 |
| `subtask_homogeneous` | boolean | 子任务是否同质 | true |
| `subtask_independent` | boolean | 子任务是否独立（无强依赖） | true |
| `risk_level` | "low" \| "medium" \| "high" \| "critical" | 风险等级 | "low" |
| `has_evaluation_criteria` | boolean | 是否有可验证的评估准则 | false |
| `criteria_measurable` | boolean | 准则可测量性 | false |
| `workload_unknown` | boolean | 未知工作量（用 stop_condition 解决） | false |
| `has_stop_condition` | boolean | 是否有清晰停止条件 | false |
| `candidate_count` | number | 候选数（多方案选型场景） | 0 |
| `comparison_based` | boolean | 是否基于对比（两两 PK 优于绝对打分） | false |
| `is_creative` | boolean | 是否创意探索（容忍重复候选） | false |
| `target_is_git` | boolean | 目标环境是否为 Git 仓库（worktree 隔离前置） | true |
| `task_description` | string | 任务原始描述（用于画像反哺） | "" |
| `task_type` | string | 任务类型字符串（用于画像分类） | "general" |
| `task_complexity` | number | 任务复杂度 1-10（用于画像） | 5 |
| `extra` | Record<string, unknown> | 任务自定义特征（扩展点） | {} |

## 模式选择规则详解

### 1. classifier-dispatch（分类并行）

**选择条件**：`type_variants >= 3`

**置信度**：`min(0.95, 0.7 + 0.05 * type_variants)`

**不适用场景**：任务类型数 < 3，单一类型任务无需分类器

**示例**：用户要求"处理这批文件——有些是图片需压缩，有些是文档需 OCR，有些是视频需转码"
- `type_variants = 3`（图片/文档/视频）
- 适用 classifier-dispatch，分类后分发到不同子流程

### 2. fan-out-aggregate（扇出聚合）

**选择条件**：
- `type_variants < 3`（异构任务已由 classifier-dispatch 处理）
- `subtask_count >= 10 && subtask_homogeneous && subtask_independent`

**置信度**：`min(0.95, 0.7 + 0.005 * subtask_count)`

**风险提示**：
- `subtask_count >= 50` 时存在 Agentic laziness 痛点（LLM 通常只完成前 20% 就宣布完成）
- `target_is_git = false` 时 worktree 隔离不可用

**聚合策略**：`concat`（拼接）/ `vote`（投票）/ `rank`（排名）/ `merge`（合并）

**示例**：用户要求"对 15 个 TypeScript 文件批量重命名"
- `subtask_count = 15`，`subtask_homogeneous = true`，`subtask_independent = true`
- 适用 fan-out-aggregate，并行重命名后聚合结果

### 3. adversarial-verify（对抗验证）

**选择条件**：
- `risk_level >= "medium"`
- `has_evaluation_criteria = true`
- `criteria_measurable = true`

**置信度**：`risk_level = "medium"` → 0.8；`"high"` → 0.88；`"critical"` → 0.95

**风险提示**：高风险任务存在 self-preferential bias（让模型验证自己产出，通过率虚高 30%+）

**示例**：用户要求"生成代码后做安全审计"
- `risk_level = "high"`，`has_evaluation_criteria = true`，`criteria_measurable = true`
- 适用 adversarial-verify，生成→审查→修复循环

### 4. generate-filter（生成筛选）

**选择条件**：任务类型为批量生成 + 有质量准则

**示例**：用户要求"生成 20 个测试用例，筛选出覆盖率最高的 5 个"
- 批量生成 20 个候选 → 按覆盖率过滤 → 输出 Top 5

### 5. tournament（锦标赛）

**选择条件**：`candidate_count >= 2 && comparison_based`

**示例**：用户要求"设计 3 个架构方案，选出最优的"
- `candidate_count = 3`，`comparison_based = true`
- 适用 tournament，两两 PK 选优

### 6. loop-until-done（循环直到完成）

**选择条件**：`has_stop_condition && criteria_measurable`

**安全约束**：`maxIterations` 默认 10（硬上限，防止无限循环）

**示例**：用户要求"修复所有 lint 错误直到零警告"
- `has_stop_condition = true`（lint 错误数 = 0）
- `criteria_measurable = true`（lint 输出可量化）
- 适用 loop-until-done，迭代修复直到满足停止条件

## 回退策略

当所有模式均不适用时，`PatternComposer.select()` 返回：
- `pattern_id: null`
- `fallback_pattern: "sequential"`
- `rejection_reason`: 所有模式的不适用理由拼接

此时应使用 `SequentialExecutor` 顺序执行，**禁止强行套用模式**。

## 强顺序依赖任务的特殊处理

**红线**：当任务本质是顺序推理（步骤 N 依赖步骤 N-1 的结果）时，
**禁止**为了"多角色"而强行并行，应退化为单角色链式执行。

实证显示，强顺序依赖任务多 Agent 并行反降 39-70% 性能。

典型场景：调试根因分析、数学推导、分步重构。
