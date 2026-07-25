# Supporting Components 配套组件能力

本文件详细说明 Dynamic Workflows 子系统的 8 个配套组件。

## 组件清单

定义于 [workflows/index.ts](../../../../../packages/core/src/team/workflows/index.ts)：

### 1. PatternTierResolver（模型分层路由器）

**位置**：[pattern-tier-resolver.ts](../../../../../packages/core/src/team/workflows/pattern-tier-resolver.ts)

**能力**：按任务复杂度将任务路由到不同模型层级（high/medium/low）

**核心导出**：
- `PatternTierResolver` 类
- `resolveTier(taskFeature)` 便捷函数
- `defaultTier` 默认层级

### 2. ModelRouter（模型路由器）

**位置**：[model-router.ts](../../../../../packages/core/src/team/workflows/model-router.ts)

**能力**：基于任务特征 + 画像反哺选择最合适的模型

**核心导出**：
- `ModelRouter` 类
- `createModelProfile()` 创建模型配置
- `validateTaskFeature()` 任务特征校验
- `DEFAULT_PROFILES` 默认模型配置

### 3. TokenBudgetGuard（Token 预算防护）

**位置**：[token-budget-guard.ts](../../../../../packages/core/src/team/workflows/token-budget-guard.ts)

**能力**：硬上限 + 消耗监控，超预算自动终止

**核心导出**：
- `TokenBudgetGuard` 类
- `createDefaultBudgetGuard()` 创建默认防护
- `validateTokenBudget()` 预算校验
- `consumptionRatio()` 消耗比率

### 4. SkillInjector（动态 skill 注入）

**位置**：[skill-injector.ts](../../../../../packages/core/src/team/workflows/skill-injector.ts)

**能力**：运行时按需加载 skill

**核心导出**：
- `SkillInjector` 类
- `createDefaultInjector()` 创建默认注入器
- `defaultInjectResult` 默认注入结果

### 5. InterruptionRecovery（中断恢复）

**位置**：[interruption-recovery.ts](../../../../../packages/core/src/team/workflows/interruption-recovery.ts)

**能力**：检查点 + 断点续跑

**核心导出**：
- `InterruptionRecovery` 类
- `createDefaultRecovery()` 创建默认恢复器
- `defaultRecoveryState` 默认恢复状态

### 6. SemanticEmbedder（语义嵌入）

**位置**：[semantic-embedder.ts](../../../../../packages/core/src/team/workflows/semantic-embedder.ts)

**能力**：TFIDF/Hashing/SentenceTransformer 三级降级

**核心导出**：
- `TFIDFEmbedder` / `HashingEmbedder` / `SentenceTransformerEmbedder` 三个实现
- `getDefaultEmbedder()` 获取默认 embedder
- `cosineSimilarity()` 余弦相似度计算
- `EmbeddingCache` 嵌入缓存

**降级链**：SentenceTransformer → TFIDF → Hashing（无网络/无模型时自动降级）

### 7. SubagentSandbox（子代理沙箱）

**位置**：[subagent-sandbox.ts](../../../../../packages/core/src/team/workflows/subagent-sandbox.ts)

**能力**：隔离级别 none/context/worktree/full

**核心导出**：
- `SubagentSandbox` 类
- `createSandboxContext()` 创建沙箱上下文
- `recordToken()` 记录 Token 消耗
- `ALL_SANDBOX_STATUSES` 所有状态枚举

**隔离级别**：
- `none`：无隔离（默认）
- `context`：上下文隔离
- `worktree`：Git worktree 隔离（要求 `target_is_git = true`）
- `full`：完全隔离（worktree + 独立进程）

### 8. WorktreeManager（Git worktree 隔离管理）

**位置**：[worktree-manager.ts](../../../../../packages/core/src/team/workflows/worktree-manager.ts)

**能力**：Git worktree 创建/删除/管理

**核心导出**：
- `WorktreeManager` 类
- `createDefaultWorktreeManager()` 创建默认管理器
- `defaultWorktree` 默认 worktree 配置

**前置条件**：目标环境必须为 Git 仓库（`target_is_git = true`）

## 组件协同关系

```
任务输入
   │
   ├─> PatternComposer.select() ──> PatternSelection
   │     │
   │     └─> PatternTierResolver.resolveTier() ──> 模型层级
   │           │
   │           └─> ModelRouter.route() ──> 具体模型
   │
   ├─> PatternExecutor.execute()
   │     │
   │     ├─> TokenBudgetGuard.check() ──> 预算检查
   │     │
   │     ├─> SkillInjector.inject() ──> 动态 skill 加载
   │     │
   │     ├─> SubagentSandbox.create() ──> 隔离环境
   │     │     │
   │     │     └─> WorktreeManager.create() ──> Git worktree（如需）
   │     │
   │     └─> InterruptionRecovery.checkpoint() ──> 检查点
   │
   └─> PatternComposer.recordOutcome() ──> 画像反哺
         │
         └─> SemanticEmbedder.embed() ──> 语义嵌入（用于相似案例检索）
```
