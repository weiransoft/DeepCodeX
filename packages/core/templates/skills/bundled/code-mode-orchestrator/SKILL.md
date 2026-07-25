---
name: code-mode-orchestrator
description: Code Mode 编排模式 skill——暴露 team 模块已有的 Dynamic Workflows 子系统能力，引导 LLM 根据任务特征选择合适的 WorkflowPattern。Use when 用户请求批量处理、并行执行、循环直到完成、多方案竞争、对抗验证、生成筛选等编排场景，或当单一工具调用无法满足复杂任务编排需求时。
triggers:
  - 批量处理
  - 并行执行
  - 循环直到完成
  - 多方案竞争
  - 对抗验证
  - 生成筛选
  - Code Mode
  - 编排模式
  - fan-out
  - 工作流模式
---

# Code Mode 编排模式 Skill

本 Skill 暴露 DeepCodeX-cli team 模块已有的 Dynamic Workflows 子系统能力，
让 LLM 能识别并根据任务特征选择合适的 `WorkflowPattern` 编排模式。

## 适用场景

当用户任务满足以下任一条件时，应考虑使用 Code Mode 编排：

1. **批量处理**：同一工具/逻辑需对 N 个项目并行执行（如"对 10 个文件批量重命名"）
2. **数据依赖**：步骤 A 的输出作为步骤 B 的输入（如"先扫描再修复"）
3. **条件分支**：下一步动作依赖上一步结果（如"测试通过则部署，否则回滚"）
4. **循环迭代**：处理列表项直到完成（如"逐个修复所有 lint 错误"）
5. **聚合汇总**：合并多次工具调用的结果（如"汇总 5 个模块的测试覆盖率"）
6. **质量验证**：生成产物后需校验（如"生成代码后跑静态检查"）

## 设计依据：team 模块 Dynamic Workflows 子系统

DeepCodeX-cli 的 team 模块已具备完整的 Dynamic Workflows 子系统，**无需新增任何代码**。
本 Skill 仅作为"能力暴露层"，让 LLM 知道这些编排模式的存在并主动选择使用。

### 核心组件清单

| 组件 | 位置 | 能力 |
|------|------|------|
| `WorkflowPattern` | [types.ts:268-277](../../../../../packages/core/src/team/types.ts) | 6 种编排模式枚举 |
| `PatternComposer` | [pattern-composer.ts:1036](../../../../../packages/core/src/team/workflows/pattern-composer.ts) | 模式选择器类，实例方法 `select(task)` 基于任务特征自动选择最合适模式 |
| `selectPatternForTask` | [pattern-composer.ts:1205](../../../../../packages/core/src/team/workflows/pattern-composer.ts) | 独立便捷函数，内部调用 `createDefaultComposer().select(task)` |
| `PatternExecutor` | [pattern-executor.ts](../../../../../packages/core/src/team/workflows/pattern-executor.ts) | 7 个执行器（6 个模式 + SequentialExecutor） |
| 8 个配套组件 | [workflows/index.ts](../../../../../packages/core/src/team/workflows/index.ts) | 模型路由/预算防护/沙箱/恢复等生产级能力 |

**8 个配套组件清单**（详见 [references/supporting-components.md](references/supporting-components.md)）：

`PatternTierResolver`（模型分层路由） / `ModelRouter`（模型路由） / `TokenBudgetGuard`（Token 预算防护） / `SkillInjector`（动态 skill 注入） / `InterruptionRecovery`（中断恢复） / `SemanticEmbedder`（语义嵌入） / `SubagentSandbox`（子代理沙箱） / `WorktreeManager`（Git worktree 隔离）

## 6 种编排模式映射表

| WorkflowPattern | 执行器 | 适用场景 | 选择条件（TaskFeature） |
|-----------------|--------|---------|----------------------|
| `classifier-dispatch` | `ClassifierDispatchExecutor` | 任务存在 ≥ 3 种异构类型，需分类后分发到不同子流程 | `type_variants >= 3` |
| `fan-out-aggregate` | `FanOutAggregateExecutor` | ≥ 10 个同质子任务且可独立处理，并行扇出后聚合 | `subtask_count >= 10 && subtask_homogeneous && subtask_independent` |
| `adversarial-verify` | `AdversarialVerifyExecutor` | 风险等级 ≥ medium 且有可测量评估准则，生成→审查→修复循环 | `risk_level >= "medium" && has_evaluation_criteria && criteria_measurable` |
| `generate-filter` | `GenerateFilterExecutor` | 批量生成候选后按质量过滤（如生成多个测试用例后筛选） | 任务类型为生成 + 有质量准则 |
| `tournament` | `TournamentExecutor` | 多方案两两 PK 选优（如架构选型、文案创作） | `candidate_count >= 2 && comparison_based` |
| `loop-until-done` | `LoopUntilDoneExecutor` | 成功标准可量化但当前未达成，迭代直到满足（如性能优化） | `has_stop_condition && criteria_measurable` |

**回退模式**：当所有模式均不适用时，`PatternComposer.select()` 返回 `fallback_pattern: "sequential"`，
由 `SequentialExecutor` 顺序执行。**禁止强行套用模式**——顺序推理任务应保持单角色链式执行。

## 使用方式

本 Skill 不直接执行代码，而是引导 LLM 通过以下入口调用 Dynamic Workflows 子系统：

| 入口 | 适用场景 | 调用方式 |
|------|---------|---------|
| `selectPatternForTask(taskFeature)` | 一次性模式选择（推荐） | 便捷函数，自动返回 `PatternSelection` |
| `new PatternComposer({ fingerprint })` | 需要画像反哺的闭环场景 | 实例方法 `select()` + `recordOutcome()` |
| `new XxxExecutor({ dispatch, ... })` | 已知模式 ID，需自定义执行参数 | 直接调用 `execute(executionContext)` |

**调用流程**：构建 16 维 `TaskFeature` → 选择入口 → 获得 `PatternSelection` → 委托对应 `PatternExecutor` 执行 → 返回 `PatternExecutorResult`。

完整的 TS 代码示例（3 种调用方式 + `PatternExecutorResult` 接口定义）见 [references/usage-examples.md](references/usage-examples.md)。

## 安全规则（复用现有实现）

| 规则 | 实现 | 默认值 |
|------|------|--------|
| fan-out 并发上限 | `token-budget-guard` + `subagent-sandbox` | 5（按模型限流动态调整） |
| loop 迭代上限 | `LoopUntilDoneExecutor.maxIterations` | 10（硬上限，防止无限循环） |
| Token 预算硬上限 | `token-budget-guard` | 按模式 `default_token_budget` 配置 |
| 输入校验 | `PatternExecutor` 基类 `execute()` 前置校验 | schema 校验 + 提示词注入防护 |
| 异常隔离 | 每个子任务异常独立捕获 | 不影响其他子任务 |
| 中断恢复 | `interruption-recovery` | 检查点 + 断点续跑 |

## 输出契约

所有 `PatternExecutor` 执行后返回 `PatternExecutorResult`，包含 `patternId` / `status` / `subtaskResults` / `aggregatedOutput` / `totalTokenUsed` / `executionTimeSeconds` / `errors` / `metadata` 字段。

**状态判定**：
- `success`：所有子任务成功
- `partial_success`：部分子任务成功，部分失败
- `failure`：所有子任务失败
- `rejected`：输入校验失败或 guard 拒绝
- `timeout`：超过 Token 预算或时间上限
- `cancelled`：用户主动取消

完整接口定义见 [references/usage-examples.md](references/usage-examples.md#patternexecutorresult-接口定义)。

## 决策流程图

```
用户任务
   │
   ├─1─> 评估 TaskFeature（16 维任务特征）
   │     - type_variants / subtask_count / subtask_homogeneous
   │     - subtask_independent / risk_level / has_evaluation_criteria
   │     - criteria_measurable / workload_unknown / has_stop_condition
   │     - candidate_count / comparison_based / is_creative / target_is_git
   │
   ├─2─> 调用 selectPatternForTask(taskFeature) 或 composer.select(taskFeature)
   │     返回 PatternSelection { pattern_id, confidence, rationale }
   │
   ├─3─> 判断 selection.pattern_id
   │     ├─ null → 顺序执行（SequentialExecutor）
   │     ├─ "classifier-dispatch" → ClassifierDispatchExecutor
   │     ├─ "fan-out-aggregate" → FanOutAggregateExecutor
   │     ├─ "adversarial-verify" → AdversarialVerifyExecutor
   │     ├─ "generate-filter" → GenerateFilterExecutor
   │     ├─ "tournament" → TournamentExecutor
   │     └─ "loop-until-done" → LoopUntilDoneExecutor
   │
   ├─4─> 执行 executor.execute(executionContext)
   │     - 真实调用 dispatch_agent_v2
   │     - 输入校验 + 提示词注入防护
   │     - Token 预算硬上限 + 异常隔离
   │
   └─5─> 返回 PatternExecutorResult
         - status / subtaskResults / aggregatedOutput / totalTokenUsed
```

## 与 team/plugins 的协同

| 插件 | 协同方式 |
|------|---------|
| `multi-goal`（多目标 DAG） | 底层调用 `PatternExecutor` 实现复杂编排 |
| `loop`（循环编排） | 可嵌套 `LoopUntilDoneExecutor` 实现双层循环 |
| `graph`（图编排） | 节点执行可委托给对应 `PatternExecutor` |
| `autonomous`（自主编排） | Ralph 循环中可调用 `selectPatternForTask` 选择模式 |

## 详细参考

- 调用示例与接口定义：[references/usage-examples.md](references/usage-examples.md)
- 模式选择规则详解：[references/pattern-selection-rules.md](references/pattern-selection-rules.md)
- 执行器实现细节：[references/executor-details.md](references/executor-details.md)
- 配套组件能力：[references/supporting-components.md](references/supporting-components.md)

## 验证清单

- [ ] Skill 通过 `session.listSkills()` 可被扫描注册
- [ ] 用户输入"批量处理"/"并行执行"时自动匹配本 Skill
- [ ] Skill 内容引用的 `WorkflowPattern` 枚举值与 [types.ts:268-277](../../../../../packages/core/src/team/types.ts) 一致
- [ ] Skill 内容引用的 `PatternExecutor` 类名与 [pattern-executor.ts](../../../../../packages/core/src/team/workflows/pattern-executor.ts) 一致
- [ ] Skill 内容引用的 `selectPatternForTask` 函数签名与 [pattern-composer.ts:1205](../../../../../packages/core/src/team/workflows/pattern-composer.ts) 一致
- [ ] `enabledSkills: {"code-mode-orchestrator": false}` 可禁用本 Skill
