# Pattern Executor 实现细节

本文件详细说明 7 个 `PatternExecutor` 的实现细节、输入输出与安全约束。

## 执行器清单

定义于 [pattern-executor.ts](../../../../../packages/core/src/team/workflows/pattern-executor.ts)：

| 执行器 | 类定义行号 | 对应 WorkflowPattern | 核心能力 |
|--------|-----------|---------------------|---------|
| `ClassifierDispatchExecutor` | 第 510 行 | `classifier-dispatch` | 分类后分发到不同角色 |
| `FanOutAggregateExecutor` | 第 673 行 | `fan-out-aggregate` | 并行扇出 + 聚合（concat/vote/rank/merge 4 种策略） |
| `AdversarialVerifyExecutor` | 第 934 行 | `adversarial-verify` | 生成→审查→修复循环（多轮验证） |
| `GenerateFilterExecutor` | 第 1153 行 | `generate-filter` | 批量生成 + 质量过滤 |
| `TournamentExecutor` | 第 1387 行 | `tournament` | 多方案两两 PK 选优 |
| `LoopUntilDoneExecutor` | 第 1661 行 | `loop-until-done` | 迭代直到退出条件满足（maxIterations 上限） |
| `SequentialExecutor` | 第 1878 行 | null（回退模式） | 顺序执行多步骤（pipeline = 有序步骤） |

## 统一接口

所有执行器实现 `PatternExecutorLike` 接口（[pattern-executor.ts:190](../../../../../packages/core/src/team/workflows/pattern-executor.ts)）：

```typescript
interface PatternExecutorLike {
  execute(context: ExecutionContext): Promise<PatternExecutorResult>;
}
```

## 安全约束（所有执行器共享）

| 约束 | 实现 | 说明 |
|------|------|------|
| 输入校验 | `execute()` 前置 schema 校验 | 拒绝不合规输入 |
| 提示词注入防护 | `detectPromptInjection()` | 检测并拒绝注入攻击 |
| Token 预算硬上限 | `token-budget-guard` | 超预算自动终止 |
| 异常隔离 | 每个子任务独立 try/catch | 单点失败不影响整体 |
| 并发控制 | `subagent-sandbox` | 隔离级别 none/context/worktree/full |
| 中断恢复 | `interruption-recovery` | 检查点 + 断点续跑 |

## PatternExecutorResult 状态机

```
pending → running → success（所有子任务成功）
                  → partial_success（部分成功）
                  → failure（全部失败）
                  → rejected（输入校验失败）
                  → timeout（超预算）
                  → cancelled（用户取消）
```

## 便捷工厂函数

```typescript
// 创建默认执行器（自动根据 patternId 选择对应执行器）
import { createDefaultExecutor } from "../team/workflows";
const executor = createDefaultExecutor({
  dispatch: async (task) => { /* 真实 dispatch 调用 */ },
  log: (level, msg) => console.log(`[${level}] ${msg}`),
});
```

## 与 PerformanceFingerprint 的闭环

所有执行器执行后可通过 `PatternComposer.recordOutcome()` 记录结果到画像：

```typescript
composer.recordOutcome(taskFeature, selection, success, executionTime, errorType);
```

画像数据将用于后续相似任务的模式选择优化（"模式选择 → 执行 → 画像反哺"闭环）。
