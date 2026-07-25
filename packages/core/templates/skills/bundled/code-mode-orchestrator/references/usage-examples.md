# Code Mode 调用示例（详细参考）

本文件收纳 `code-mode-orchestrator` Skill 的三种调用方式与 `PatternExecutorResult` 接口定义。
SKILL.md 仅保留调用入口与决策流程，详细 TS 代码示例集中在本文件，便于：

- 减少 SKILL.md 的 token 消耗
- 避免 import 路径与字段名随代码演进不同步
- 让 SKILL.md 聚焦于"何时触发 + 选哪种模式"

## 方式 1：便捷函数（推荐）

适用场景：一次性模式选择，无需画像反哺。

```typescript
import { selectPatternForTask, defaultTaskFeature } from "../team/workflows";

// 构建任务特征（16 维 TaskFeature）
const taskFeature = {
  ...defaultTaskFeature(),
  type_variants: 1,
  subtask_count: 15,           // 15 个子任务
  subtask_homogeneous: true,   // 同质
  subtask_independent: true,   // 独立
  target_is_git: true,         // Git 仓库可用 worktree 隔离
  task_description: "批量重命名 15 个文件",
  task_type: "batch-rename",
  task_complexity: 3,
};

// 选择模式（自动返回 fan-out-aggregate）
const selection = selectPatternForTask(taskFeature);
console.log(selection.pattern_id);  // "fan-out-aggregate"
console.log(selection.confidence);   // 0.7+
console.log(selection.rationale);     // 选择理由
```

## 方式 2：PatternComposer 实例（需要画像反哺时）

适用场景：需要"模式选择 → 执行 → 画像反哺"闭环，跨多次任务持续优化模式选择策略。

```typescript
import { PatternComposer } from "../team/workflows";
import { PerformanceFingerprint } from "../performance-fingerprint";

// 注入画像，实现"模式选择 → 执行 → 画像反哺"闭环
const composer = new PatternComposer({
  fingerprint: new PerformanceFingerprint(),
});

const selection = composer.select(taskFeature);

// 执行后记录结果到画像
composer.recordOutcome(taskFeature, selection, true, 12.5);
```

## 方式 3：直接调用执行器

适用场景：已知模式 ID，需自定义 dispatch 函数、并发上限、聚合策略等执行参数。

```typescript
import { FanOutAggregateExecutor, createDefaultExecutor } from "../team/workflows";

const executor = new FanOutAggregateExecutor({
  dispatch: async (task) => { /* 真实 dispatch_agent_v2 调用 */ },
  maxConcurrency: 5,        // 并发上限
  aggregationStrategy: "concat",  // concat / vote / rank / merge
});

const result = await executor.execute({
  patternId: "fan-out-aggregate",
  subtasks: [/* 子任务列表 */],
  aggregation: { strategy: "concat" },
});
```

## PatternExecutorResult 接口定义

所有 `PatternExecutor` 执行后返回 `PatternExecutorResult`：

```typescript
interface PatternExecutorResult {
  patternId: string | null;        // 使用的模式 ID；null 表示顺序执行
  status: "success" | "failure" | "partial_success" | "rejected" | "timeout" | "cancelled";
  subtaskResults: SubTaskResult[];  // 每个子任务的执行结果
  aggregatedOutput?: unknown;       // 聚合后的输出（fan-out-aggregate 模式）
  totalTokenUsed: number;           // 总 Token 消耗
  executionTimeSeconds: number;     // 总执行时间
  errors: string[];                 // 错误信息（非致命错误不中断流程）
  metadata?: Record<string, unknown>; // 扩展元数据
}
```

**状态判定**：

- `success`：所有子任务成功
- `partial_success`：部分子任务成功，部分失败
- `failure`：所有子任务失败
- `rejected`：输入校验失败或 guard 拒绝
- `timeout`：超过 Token 预算或时间上限
- `cancelled`：用户主动取消

## 相关参考

- 模式选择规则：[pattern-selection-rules.md](pattern-selection-rules.md)
- 执行器实现细节：[executor-details.md](executor-details.md)
- 配套组件能力：[supporting-components.md](supporting-components.md)
