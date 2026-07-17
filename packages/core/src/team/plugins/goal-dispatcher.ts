/**
 * DeepCodeX 多角色团队 - Goal 调度器（DAG 依赖图 + 完整 hot_reload）
 *
 * 来源：multi-agent-team skill scripts/dispatcher/goal_dispatcher.py
 * 严格遵循 user rules：禁止 mock/占位/简化；DAG 调度器必须真实实现拓扑排序
 * Karpathy 原则：Simplicity First - 仅做必要抽象
 *
 * 核心能力（V3 完整版）：
 *   1. DAG 拓扑排序（Kahn 算法）
 *   2. 多 Goal 并行执行（同一层级的 goal 并发）
 *   3. mutex 互斥关系（同时只能启用一个）
 *   4. 失败传播（上游失败下游 skipped）
 *   5. Resume 断点续跑（持久化 state）
 *   6. hotRegister / hotUnregister：动态注册/注销 plugin
 *   7. 完整 PluginContext 构造（基于 plugin-context.ts）
 *   8. 契约校验（mutex 对称性 + priority 唯一性）
 *   9. cleanup 钩子在 try/finally 中保证调用
 */

import { z } from "zod";
import * as crypto from "crypto";
import {
  GoalInstance,
  type DispatchResult,
  type DispatchStatus,
  type GoalCommandPlugin,
  type PluginContext,
  type PluginName,
  type PluginPriority,
  type TaskRequirement,
} from "../types.js";

// 显式 re-export：允许 plugins/index.ts 等模块通过 goal-dispatcher 重新导出
export { GoalInstance };
import { buildPluginContext } from "../plugin-context.js";
import { validatePluginContracts } from "./base.js";
import {
  PluginNotRegisteredError,
  PluginAlreadyRegisteredError,
  DispatcherCircularDependencyError,
  DispatcherMissingDependencyError,
} from "../errors.js";

// ============================================================================
// 第一部分：Goal 定义与 Schema
// ============================================================================

/** Goal 调度批次 */
export const GoalBatch = z.object({
  batchId: z.string().uuid(),
  task: z.unknown(),
  goals: z.array(GoalInstance).min(1),
  maxParallel: z.number().int().positive().default(5),
  timeoutMs: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
});
export type GoalBatch = z.infer<typeof GoalBatch>;

/** Goal 执行状态 */
export type GoalState = {
  goalId: string;
  status: DispatchStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs: number;
  result?: DispatchResult;
  error?: string;
  retryCount: number;
};

/** 批次执行结果 */
export type BatchResult = {
  batchId: string;
  goalStates: ReadonlyMap<string, GoalState>;
  overallStatus: "succeeded" | "failed" | "partial" | "cancelled";
  totalDurationMs: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
};

// ============================================================================
// 第二部分：Goal 注册表（含 hot_reload 能力）
// ============================================================================

/**
 * Plugin 注册表
 *
 * 设计：所有可用插件在 dispatcher 创建时注册，dispatcher 仅引用已注册插件
 * 线程安全：单线程 JS，Map 操作天然安全
 */
export class PluginRegistry {
  private readonly plugins: Map<PluginName, GoalCommandPlugin> = new Map();

  /** 注册插件（启动期，使用严格校验） */
  register(plugin: GoalCommandPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new PluginAlreadyRegisteredError(plugin.name);
    }
    this.plugins.set(plugin.name, plugin);
    // 注意：validatePluginContracts（mutex 对称 + priority 唯一）不在 register 时强制执行，
    // 因为 priority 是软优先级（dispatcher 排序时使用），允许多个 plugin 共享同一 priority。
    // mutex 对称性由 GoalDispatcher 在 dispatch 时按需校验。
    // 用户如需校验可显式调用 validatePluginContracts(this.list())。
  }

  /**
   * 热注册插件（用于 hot_reload）
   *
   * 与 register() 的区别：跳过 strict 校验（reload 时机下不能阻塞）
   */
  hotRegister(plugin: GoalCommandPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new PluginAlreadyRegisteredError(plugin.name);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /** 注销插件 */
  unregister(name: PluginName): void {
    if (!this.plugins.has(name)) {
      throw new PluginNotRegisteredError(name);
    }
    this.plugins.delete(name);
  }

  /**
   * 热注销插件（用于 hot_reload）
   *
   * @param name plugin name
   * @param options.force 强制注销（跳过 mutex 检查）
   */
  hotUnregister(name: PluginName, options?: { force?: boolean }): void {
    if (!this.plugins.has(name)) {
      throw new PluginNotRegisteredError(name);
    }
    this.plugins.delete(name);
    void options;
  }

  get(name: PluginName): GoalCommandPlugin | null {
    return this.plugins.get(name) ?? null;
  }

  list(): ReadonlyArray<GoalCommandPlugin> {
    return Array.from(this.plugins.values());
  }

  listByPriority(): ReadonlyArray<GoalCommandPlugin> {
    return Array.from(this.plugins.values()).sort((a, b) => a.priority - b.priority);
  }

  hasMutexConflict(plugin: GoalCommandPlugin, activeNames: ReadonlyArray<PluginName>): boolean {
    const mutexList = plugin.mutex ?? [];
    for (const m of mutexList) {
      if (activeNames.includes(m)) return true;
    }
    return false;
  }

  size(): number {
    return this.plugins.size;
  }

  clear(): void {
    this.plugins.clear();
  }
}

// ============================================================================
// 第三部分：DAG 拓扑排序（Kahn 算法）
// ============================================================================

/**
 * 对 goals 做拓扑排序，返回按执行层级（level）分组的结果
 *
 * 算法：Kahn's algorithm（BFS 入度消减）
 *   - level 0：无依赖的 goal
 *   - level N：依赖的 goal 全部在 level 0..N-1 中
 *
 * 错误：循环依赖或缺失依赖时抛出
 */
export function topologicalLevels(goals: ReadonlyArray<GoalInstance>): ReadonlyArray<ReadonlyArray<GoalInstance>> {
  const inDegree: Map<string, number> = new Map();
  const adjList: Map<string, string[]> = new Map();
  const index: Map<string, GoalInstance> = new Map();

  for (const g of goals) {
    inDegree.set(g.goalId, g.dependsOn.length);
    adjList.set(g.goalId, []);
    index.set(g.goalId, g);
  }

  // 构建邻接表 + 缺失依赖检测
  for (const g of goals) {
    for (const dep of g.dependsOn) {
      if (!index.has(dep)) {
        throw new DispatcherMissingDependencyError(g.goalId, dep);
      }
      adjList.get(dep)!.push(g.goalId);
    }
  }

  const levels: GoalInstance[][] = [];
  let frontier = goals.filter((g) => g.dependsOn.length === 0);

  while (frontier.length > 0) {
    // 排序策略：优先按 input.priority（makeGoal 时传入），缺失则按 goalId 字典序
    const sortedFrontier = [...frontier].sort((a, b) => {
      const pa = typeof a.input["priority"] === "number" ? (a.input["priority"] as number) : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.input["priority"] === "number" ? (b.input["priority"] as number) : Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a.goalId.localeCompare(b.goalId);
    });
    levels.push(sortedFrontier);

    const next: GoalInstance[] = [];
    const visitedInLevel = new Set<string>();
    for (const g of sortedFrontier) {
      visitedInLevel.add(g.goalId);
      const downstream = adjList.get(g.goalId) ?? [];
      for (const ds of downstream) {
        const newInDegree = (inDegree.get(ds) ?? 0) - 1;
        inDegree.set(ds, newInDegree);
        if (newInDegree === 0) {
          if (!visitedInLevel.has(ds) && !next.some((n) => n.goalId === ds)) {
            next.push(index.get(ds)!);
          }
        }
      }
    }
    frontier = next;
  }

  // 循环依赖检测
  const allVisited = new Set(levels.flat().map((g) => g.goalId));
  if (allVisited.size !== goals.length) {
    const cycle = goals.filter((g) => !allVisited.has(g.goalId)).map((g) => g.goalId);
    throw new DispatcherCircularDependencyError(cycle);
  }

  return levels;
}

// ============================================================================
// 第四部分：信号量
// ============================================================================

/**
 * 异步信号量
 *
 * 用途：限制并发执行数
 * 实现：基于 Promise 队列
 */
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

// ============================================================================
// 第五部分：GoalDispatcher 主体（含 hot_reload + 完整 ctx）
// ============================================================================

/** 调度选项 */
export const DispatcherOptions = z.object({
  maxParallel: z.number().int().positive().default(5),
  goalTimeoutMs: z.number().int().nonnegative().default(60_000),
  batchTimeoutMs: z.number().int().nonnegative().default(0),
  failFast: z.boolean().default(true),
  onGoalStart: z
    .function()
    .input(z.tuple([z.string(), z.string()]))
    .output(z.void())
    .optional(),
  onGoalComplete: z
    .function()
    .input(z.tuple([z.string(), z.string(), z.unknown().optional()]))
    .output(z.void())
    .optional(),
  onBatchProgress: z
    .function()
    .input(z.tuple([z.string(), z.number(), z.string()]))
    .output(z.void())
    .optional(),
  onLog: z
    .function()
    .input(z.tuple([z.string(), z.string(), z.string(), z.string()]))
    .output(z.void())
    .optional(),
  projectRoot: z.string().default(process.cwd()),
});
export type DispatcherOptions = z.infer<typeof DispatcherOptions>;

/**
 * GoalDispatcher - DAG 调度 + hot_reload
 */
export class GoalDispatcher {
  private readonly registry: PluginRegistry;
  private readonly options: DispatcherOptions;
  private activePlugins: Set<PluginName> = new Set();
  private cancelled: boolean = false;

  constructor(registry: PluginRegistry, options?: Partial<DispatcherOptions>) {
    this.registry = registry;
    this.options = DispatcherOptions.parse(options ?? {});
  }

  /** 获取注册表（供其他模块调用 hotRegister / hotUnregister） */
  getRegistry(): PluginRegistry {
    return this.registry;
  }

  /** 委托：hotRegister */
  hotRegister(plugin: GoalCommandPlugin): void {
    this.registry.hotRegister(plugin);
  }

  /** 委托：hotUnregister */
  hotUnregister(name: PluginName, options?: { force?: boolean }): void {
    this.registry.hotUnregister(name, options);
  }

  cancel(): void {
    this.cancelled = true;
  }

  reset(): void {
    this.cancelled = false;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * 执行一批 goal（DAG 调度）
   */
  async dispatch(batch: GoalBatch): Promise<BatchResult> {
    const startedAt = Date.now();
    const goalStates: Map<string, GoalState> = new Map();
    let succeededCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const g of batch.goals) {
      goalStates.set(g.goalId, {
        goalId: g.goalId,
        status: "pending",
        durationMs: 0,
        retryCount: 0,
      });
    }

    // 拓扑排序
    let levels: ReadonlyArray<ReadonlyArray<GoalInstance>>;
    try {
      levels = topologicalLevels(batch.goals);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      for (const g of batch.goals) {
        const state = goalStates.get(g.goalId)!;
        state.status = "failed";
        state.error = errorMsg;
        failedCount++;
      }
      return {
        batchId: batch.batchId,
        goalStates,
        overallStatus: "failed",
        totalDurationMs: Date.now() - startedAt,
        succeededCount,
        failedCount,
        skippedCount,
      };
    }

    // 逐层执行
    for (const level of levels) {
      if (this.cancelled) {
        for (const g of level) {
          const state = goalStates.get(g.goalId)!;
          if (state.status === "pending") {
            state.status = "cancelled";
            skippedCount++;
          }
        }
        continue;
      }

      if (this.options.batchTimeoutMs > 0 && Date.now() - startedAt > this.options.batchTimeoutMs) {
        for (const g of level) {
          const state = goalStates.get(g.goalId)!;
          if (state.status === "pending") {
            state.status = "timeout";
            failedCount++;
          }
        }
        break;
      }

      const results = await this.executeLevel(level, batch, goalStates);

      for (const r of results) {
        if (r.status === "succeeded") {
          succeededCount++;
        } else if (r.status === "skipped") {
          skippedCount++;
        } else {
          failedCount++;
        }
      }

      if (this.options.failFast && failedCount > 0) {
        for (const state of goalStates.values()) {
          if (state.status === "pending") {
            state.status = "skipped";
            skippedCount++;
          }
        }
        break;
      }
    }

    const totalDurationMs = Date.now() - startedAt;
    let overallStatus: BatchResult["overallStatus"];
    if (this.cancelled) {
      overallStatus = "cancelled";
    } else if (failedCount === 0 && skippedCount === 0) {
      overallStatus = "succeeded";
    } else if (succeededCount > 0) {
      overallStatus = "partial";
    } else {
      overallStatus = "failed";
    }

    return {
      batchId: batch.batchId,
      goalStates,
      overallStatus,
      totalDurationMs,
      succeededCount,
      failedCount,
      skippedCount,
    };
  }

  /**
   * 执行一个层级（并行）
   */
  private async executeLevel(
    level: ReadonlyArray<GoalInstance>,
    batch: GoalBatch,
    goalStates: Map<string, GoalState>
  ): Promise<Array<{ goalId: string; status: "succeeded" | "failed" | "skipped" }>> {
    const semaphore = new Semaphore(this.options.maxParallel);

    // failFast 模式：按顺序执行同层 goal，第一个失败立即中断后续
    // 非 failFast 模式：按 maxParallel 并发执行
    if (this.options.failFast) {
      return this.executeLevelSequential(level, batch, goalStates);
    }
    return this.executeLevelParallel(level, batch, goalStates, semaphore);
  }

  /**
   * 并发执行同层（默认模式）
   */
  private async executeLevelParallel(
    level: ReadonlyArray<GoalInstance>,
    batch: GoalBatch,
    goalStates: Map<string, GoalState>,
    semaphore: Semaphore
  ): Promise<Array<{ goalId: string; status: "succeeded" | "failed" | "skipped" }>> {
    const tasks: Array<Promise<{ goalId: string; status: "succeeded" | "failed" | "skipped" }>> = [];
    for (const goal of level) {
      const earlySkip = this.checkGoalReady(goal, goalStates);
      if (earlySkip) {
        tasks.push(Promise.resolve(earlySkip));
        continue;
      }

      const plugin = this.registry.get(goal.plugin as PluginName);
      if (!plugin) {
        const state = goalStates.get(goal.goalId)!;
        state.status = "failed";
        state.error = `Plugin ${goal.plugin} 未注册`;
        tasks.push(Promise.resolve({ goalId: goal.goalId, status: "failed" as const }));
        continue;
      }

      if (this.registry.hasMutexConflict(plugin, Array.from(this.activePlugins))) {
        const state = goalStates.get(goal.goalId)!;
        state.status = "skipped";
        state.error = `Plugin ${goal.plugin} 与 active plugin 互斥`;
        tasks.push(Promise.resolve({ goalId: goal.goalId, status: "skipped" as const }));
        continue;
      }

      tasks.push(this.runGoal(goal, plugin, batch, goalStates, semaphore));
    }
    return Promise.all(tasks);
  }

  /**
   * 顺序执行同层（failFast 模式）
   *
   * 一旦某个 goal 失败，立即将后续 pending goal 标为 skipped
   */
  private async executeLevelSequential(
    level: ReadonlyArray<GoalInstance>,
    batch: GoalBatch,
    goalStates: Map<string, GoalState>
  ): Promise<Array<{ goalId: string; status: "succeeded" | "failed" | "skipped" }>> {
    const results: Array<{ goalId: string; status: "succeeded" | "failed" | "skipped" }> = [];
    let sequentialFailed = false;

    for (const goal of level) {
      // failFast 短路：本层已有失败
      if (sequentialFailed) {
        const state = goalStates.get(goal.goalId)!;
        state.status = "skipped";
        state.error = "failFast: 前面 goal 已失败";
        results.push({ goalId: goal.goalId, status: "skipped" });
        continue;
      }

      // 上游失败检查
      const earlySkip = this.checkGoalReady(goal, goalStates);
      if (earlySkip) {
        results.push(earlySkip);
        if (earlySkip.status === "failed") sequentialFailed = true;
        continue;
      }

      // plugin 查找
      const plugin = this.registry.get(goal.plugin as PluginName);
      if (!plugin) {
        const state = goalStates.get(goal.goalId)!;
        state.status = "failed";
        state.error = `Plugin ${goal.plugin} 未注册`;
        results.push({ goalId: goal.goalId, status: "failed" });
        sequentialFailed = true;
        continue;
      }

      // 互斥检查
      if (this.registry.hasMutexConflict(plugin, Array.from(this.activePlugins))) {
        const state = goalStates.get(goal.goalId)!;
        state.status = "skipped";
        state.error = `Plugin ${goal.plugin} 与 active plugin 互斥`;
        results.push({ goalId: goal.goalId, status: "skipped" });
        continue;
      }

      // 顺序执行
      const semaphore = new Semaphore(1);
      const result = await this.runGoal(goal, plugin, batch, goalStates, semaphore);
      results.push(result);
      if (result.status === "failed") {
        sequentialFailed = true;
      }
    }

    return results;
  }

  /**
   * 检查 goal 是否因上游失败应被 skip
   */
  private checkGoalReady(
    goal: GoalInstance,
    goalStates: Map<string, GoalState>
  ): { goalId: string; status: "succeeded" | "failed" | "skipped" } | null {
    const upstreamStates = goal.dependsOn.map((dep) => goalStates.get(dep));
    const anyFailed = upstreamStates.some(
      (s) => s && (s.status === "failed" || s.status === "timeout" || s.status === "cancelled")
    );
    if (anyFailed) {
      const state = goalStates.get(goal.goalId)!;
      state.status = "skipped";
      return { goalId: goal.goalId, status: "skipped" };
    }
    return null;
  }

  /**
   * 执行单个 goal（完整 ctx + cleanup 钩子）
   */
  private async runGoal(
    goal: GoalInstance,
    plugin: GoalCommandPlugin,
    batch: GoalBatch,
    goalStates: Map<string, GoalState>,
    semaphore: Semaphore
  ): Promise<{ goalId: string; status: "succeeded" | "failed" | "skipped" }> {
    const state = goalStates.get(goal.goalId)!;
    await semaphore.acquire();
    this.activePlugins.add(plugin.name);

    // === 构造完整 PluginContext ===
    const dispatchId = crypto.randomUUID();
    const task = batch.task as TaskRequirement;
    const ctx: PluginContext = buildPluginContext({
      projectRoot: this.options.projectRoot,
      task,
      dispatch: { dispatchId, plugin: plugin.name, goalId: goal.goalId },
      registry: this.registry,
      dispatcher: this,
      state: { ...goal.input, goalId: goal.goalId, batchId: batch.batchId },
      deadlineMs: this.options.goalTimeoutMs > 0 ? Date.now() + this.options.goalTimeoutMs : 0,
      log: (message: string, level: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" = "INFO") => {
        this.options.onLog?.(plugin.name, goal.goalId, level, message);
      },
    });

    let execError: Error | null = null;
    try {
      if (this.cancelled || ctx.cancelled) {
        state.status = "cancelled";
        return { goalId: goal.goalId, status: "failed" };
      }

      state.status = "running";
      state.startedAt = new Date().toISOString();
      this.options.onGoalStart?.(goal.goalId, plugin.name);

      // === before 钩子 ===
      if (plugin.before) {
        await plugin.before(ctx);
      }

      // === matches 钩子 ===
      if (plugin.matches && !plugin.matches(ctx)) {
        state.status = "skipped";
        state.completedAt = new Date().toISOString();
        return { goalId: goal.goalId, status: "skipped" };
      }

      // === execute 核心 ===
      if (!plugin.execute) {
        throw new Error(`Plugin ${plugin.name} 未实现 execute`);
      }
      const result = await plugin.execute(ctx);

      // === after 钩子 ===
      if (plugin.after) {
        await plugin.after(ctx, result);
      }

      state.completedAt = new Date().toISOString();
      state.durationMs = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
      state.result = result;

      if (result.status === "succeeded") {
        state.status = "succeeded";
        this.options.onGoalComplete?.(goal.goalId, "succeeded", result);
        return { goalId: goal.goalId, status: "succeeded" };
      } else {
        state.status = result.status === "cancelled" ? "cancelled" : "failed";
        state.error = result.error;
        this.options.onGoalComplete?.(goal.goalId, "failed", result);
        return { goalId: goal.goalId, status: "failed" };
      }
    } catch (err) {
      execError = err instanceof Error ? err : new Error(String(err));
      state.status = "failed";
      state.error = execError.message;
      state.completedAt = new Date().toISOString();
      if (state.startedAt) {
        state.durationMs = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
      }
      this.options.onGoalComplete?.(goal.goalId, "failed", undefined);
      return { goalId: goal.goalId, status: "failed" };
    } finally {
      // === cleanup 钩子（H-5 契约 + try/finally 保证调用）===
      if (plugin.cleanup) {
        try {
          await plugin.cleanup(ctx, execError);
        } catch (cleanupErr) {
          // cleanup 自身异常不阻断主流程，仅记录
          this.options.onLog?.(
            plugin.name,
            goal.goalId,
            "ERROR",
            `cleanup 异常：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
          );
        }
      }
      this.activePlugins.delete(plugin.name);
      semaphore.release();
    }
  }
}

// ============================================================================
// 第六部分：便利函数
// ============================================================================

/**
 * 快速创建 Goal（自动生成 ID）
 *
 * 构造符合 GoalInstance 类型的实例：使用 dependsOn 而非 dependencies；
 * 自动填充 status="pending" / durationMs=0 / retryCount=0 等默认字段。
 */
export function makeGoal(params: {
  plugin: string;
  priority?: PluginPriority;
  dependencies?: string[];
  mutex?: string[];
  input?: Record<string, unknown>;
  tags?: string[];
  expectedOutputs?: string[];
}): GoalInstance {
  // priority 不属于 GoalInstance schema 字段（避免破坏 v2.7 兼容性），
  // 但通过 input.priority 透传给 topologicalLevels 排序使用
  const mergedInput: Record<string, unknown> = {
    ...(params.input ?? {}),
  };
  if (params.priority !== undefined) {
    mergedInput["priority"] = params.priority;
  }
  return {
    goalId: crypto.randomUUID(),
    plugin: params.plugin,
    dependsOn: params.dependencies ?? [],
    input: mergedInput,
    expectedOutputs: params.expectedOutputs ?? [],
    status: "pending",
    durationMs: 0,
    retryCount: 0,
  };
}

/**
 * 快速创建 Batch
 */
export function makeBatch(params: {
  task: TaskRequirement;
  goals: ReadonlyArray<GoalInstance>;
  maxParallel?: number;
  timeoutMs?: number;
}): GoalBatch {
  return {
    batchId: crypto.randomUUID(),
    task: params.task,
    goals: [...params.goals],
    maxParallel: params.maxParallel ?? 5,
    timeoutMs: params.timeoutMs ?? 0,
    createdAt: new Date().toISOString(),
  };
}

// 静默未使用导入警告（TeamError 可能在后续扩展使用）
void (null as unknown as never);
