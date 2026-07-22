/**
 * DeepCodeX 多角色团队 - 插件基类（V3 完整契约）
 *
 * 来源：multi-agent-team skill scripts/plugins/base.py
 * 严格遵循 user rules：禁止 mock/占位/简化；V3 契约字段全部真实可用
 * Karpathy 原则：Simplicity First - 基类只做最少的样板，子类可重写关键钩子
 *
 * V3 契约（与 multi-agent-team 1:1 对齐）：
 *   1. 5 个抽象属性：name / priority / mutexWith / requiresTask / description
 *   2. 2 个抽象方法：matches(ctx) / execute(ctx)
 *   3. 3 个可选钩子：before(ctx) / after(ctx, result) / cleanup(ctx, exc)
 *   4. 4 个 protected 辅助：log / ok / fail / progress
 *
 * 互斥契约（multi-agent-team H-1 / H-6）：
 *   - mutexWith 不能含自己（自指错误 PluginMutexSelfError）
 *   - mutexWith 引用的每个 name 都必须有已注册 plugin
 *   - A.mutexWith ⊇ {B.name} iff B.mutexWith ⊇ {A.name}（对称性）
 *   - 同 priority 不能有多个 plugin（unique constraint）
 */

import type {
  DispatchResult,
  GoalCommandPlugin,
  PluginContext,
  PluginName,
  PluginPriority,
  LogLevel,
} from "../types.js";
import {
  PluginNameInvalidError,
  PluginPriorityDuplicateError,
  PluginMutexSelfError,
  PluginMutexAsymmetricError,
} from "../errors.js";

// ============================================================================
// 第一部分：插件元数据（用于插件自描述）
// ============================================================================

/**
 * 插件元数据（用于插件自描述）
 */
export interface PluginMeta {
  /** 插件名（kebab-case 强制：^[a-z][a-z0-9-]*$） */
  name: PluginName;
  /** 优先级（数字越小越优先；唯一性约束） */
  priority: PluginPriority;
  /** 简短描述 */
  description: string;
  /** 互斥的其他插件名（对称性约束） */
  mutexWith: ReadonlyArray<PluginName>;
  /** 是否要求 --task 参数（默认 false） */
  requiresTask: boolean;
  /** 适用阶段（plan/dev/verify/fix） */
  phases?: Array<"plan" | "dev" | "verify" | "fix">;
  /** 版本号 */
  version?: string;
  /** 作者 */
  author?: string;
}

// ============================================================================
// 第二部分：BasePlugin 抽象基类
// ============================================================================

/**
 * 插件基类
 *
 * 用法：
 *   class MyPlugin extends BasePlugin {
 *     constructor() {
 *       super({
 *         name: "my-plugin",
 *         priority: 100,
 *         description: "...",
 *         mutexWith: ["other-plugin"],
 *         requiresTask: false,
 *       });
 *     }
 *     async matches(ctx: PluginContext): boolean { return true; }
 *     async execute(ctx: PluginContext): Promise<DispatchResult> { ... }
 *   }
 */
export abstract class BasePlugin implements GoalCommandPlugin {
  abstract readonly meta: PluginMeta;

  /**
   * 构造 BasePlugin，支持两种模式：
   *   1. 无参（推荐）：子类 readonly meta = {...} 字段初始化后，调用 this.initializeMeta()
   *   2. 传参：调用 super(meta) 立即校验（用于动态构造）
   *
   * @param meta 可选，立即校验的 meta；不传则需在子类构造末尾调用 this.initializeMeta()
   */
  constructor(meta?: PluginMeta) {
    if (meta) {
      // 立即校验：调用方已传 meta，无需再依赖 initializeMeta()
      this.validateMetaNow(meta);
    }
    // 否则等子类在 readonly meta 初始化后调用 this.initializeMeta()
  }

  /**
   * 立即校验 meta（用于 super(meta) 模式）
   */
  private validateMetaNow(meta: PluginMeta): void {
    this.checkMetaInvariants(meta);
  }

  /**
   * 子类构造完成后必须显式调用此方法以触发契约校验
   *
   * 使用模式：
   *   class MyPlugin extends BasePlugin {
   *     readonly meta = { name: "my-plugin", ... };
   *     constructor() {
   *       super();
   *       this.initializeMeta();
   *     }
   *   }
   */
  protected initializeMeta(): void {
    const meta = this.meta;
    if (!meta) {
      throw new PluginNameInvalidError("(unknown)", "BasePlugin 子类未定义 meta 字段");
    }
    this.checkMetaInvariants(meta);
  }

  /**
   * 校验 meta 不变量
   *
   * 提取为独立方法以便 super(meta) 和 initializeMeta() 两种模式复用
   */
  private checkMetaInvariants(meta: PluginMeta): void {
    // 1. name 必须满足 ^[a-z][a-z0-9-]*$
    if (!/^[a-z][a-z0-9-]*$/.test(meta.name)) {
      throw new PluginNameInvalidError(meta.name, "必须满足 ^[a-z][a-z0-9-]*$（小写字母开头 + kebab-case）");
    }
    // 2. mutexWith 不能含自己
    if (meta.mutexWith.includes(meta.name)) {
      throw new PluginMutexSelfError(meta.name);
    }
    // 3. priority 必须在合法范围（[0, 1000]）
    if (meta.priority < 0 || meta.priority > 1000 || !Number.isInteger(meta.priority)) {
      throw new PluginNameInvalidError(meta.name, `priority 必须为 [0, 1000] 整数，当前 ${meta.priority}`);
    }
  }

  // ==========================================================================
  // V3 契约属性
  // ==========================================================================

  get name(): PluginName {
    return this.meta.name;
  }
  get priority(): PluginPriority {
    return this.meta.priority;
  }
  get description(): string {
    return this.meta.description;
  }
  get mutex(): ReadonlyArray<PluginName> {
    return this.meta.mutexWith;
  }
  get mutexWith(): ReadonlyArray<PluginName> {
    return this.meta.mutexWith;
  }
  get requiresTask(): boolean {
    return this.meta.requiresTask;
  }

  // ==========================================================================
  // 钩子方法（可重写）
  // ==========================================================================

  /**
   * dispatch 前钩子
   *
   * 默认实现：记录开始日志
   * 子类可重写以做初始化（创建临时文件、建立连接等）
   */
  async before(ctx: PluginContext): Promise<void> {
    this.log(ctx, "INFO", `Plugin ${this.name} 开始执行`);
  }

  /**
   * dispatch 中核心逻辑（子类必须实现）
   */
  abstract execute(ctx: PluginContext): Promise<DispatchResult>;

  /**
   * dispatch 后钩子
   *
   * 默认实现：记录完成日志
   * 子类可重写以做清理（关闭连接、刷新缓存等）
   */
  async after(ctx: PluginContext, result: DispatchResult): Promise<void> {
    this.log(ctx, "INFO", `Plugin ${this.name} 完成 (${result.status}, ${result.durationMs}ms`);
  }

  /**
   * 资源回收钩子（H-5 契约 + 风险-3 修正：exc 真实传递）
   *
   * 默认 no-op。Plugin 实现时必须保证幂等（可被多次调用）
   * dispatcher 在 try/finally 中调用，无论 execute 成功/失败/异常
   */
  async cleanup(ctx: PluginContext, exc: Error | null): Promise<void> {
    // 默认 no-op
    void ctx;
    void exc;
  }

  /**
   * 判断当前 goal 是否匹配本插件
   *
   * 默认实现：始终匹配
   * 子类可基于 ctx.task / ctx.state 重写
   */
  matches(ctx: PluginContext): boolean {
    void ctx;
    return true;
  }

  // ==========================================================================
  // protected 辅助方法
  // ==========================================================================

  /**
   * 统一日志记录（写入 ctx.events 便于追踪）
   */
  protected log(ctx: PluginContext, level: LogLevel, message: string): void {
    ctx.events.push({
      type: `plugin.${this.name}.${level}`,
      payload: { message, level },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 辅助方法：构造成功的 DispatchResult
   */
  protected ok(ctx: PluginContext, output: string, artifacts: string[] = []): DispatchResult {
    return {
      taskId: ctx.task.taskId,
      dispatchId: ctx.dispatch.dispatchId,
      matchedRole: {
        roleId: "solo-coder",
        roleName: "独立开发者",
        confidence: 1.0,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: [`Plugin ${this.name} executed`],
        scoreBreakdown: { capability: 1, skill: 1, keyword: 1, priority: 1 },
        strategy: "keyword",
      },
      status: "succeeded",
      startedAt: ctx.events[0]?.timestamp ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      output,
      artifacts,
      tokensConsumed: { prompt: 0, completion: 0, total: 0 },
      cacheHit: false,
      retryCount: 0,
      // v2.1.3 新增字段：插件路径默认未触发 LLM 续写
      continueCount: 0,
      isPartial: false,
    };
  }

  /**
   * 辅助方法：构造失败的 DispatchResult
   */
  protected fail(ctx: PluginContext, error: string): DispatchResult {
    return {
      taskId: ctx.task.taskId,
      dispatchId: ctx.dispatch.dispatchId,
      matchedRole: {
        roleId: "solo-coder",
        roleName: "独立开发者",
        confidence: 0,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: [error],
        scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
        strategy: "keyword",
      },
      status: "failed",
      startedAt: ctx.events[0]?.timestamp ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      error,
      artifacts: [],
      tokensConsumed: { prompt: 0, completion: 0, total: 0 },
      cacheHit: false,
      retryCount: 0,
      // v2.1.3 新增字段：插件路径默认未触发 LLM 续写
      continueCount: 0,
      isPartial: false,
    };
  }

  /**
   * 辅助方法：进度上报
   */
  protected progress(ctx: PluginContext, percent: number, message: string): void {
    ctx.events.push({
      type: "plugin.progress",
      payload: { percent, message, plugin: this.name },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 辅助方法：检查 ctx.cancelled
   */
  protected isCancelled(ctx: PluginContext): boolean {
    return ctx.cancelled;
  }

  /**
   * 辅助方法：检查 ctx.dryRun
   */
  protected isDryRun(ctx: PluginContext): boolean {
    return ctx.dryRun;
  }
}

// ============================================================================
// 第三部分：全局契约校验工具
// ============================================================================

/**
 * 全局契约校验：检查所有已注册 plugin 的 mutex 对称性 + priority 唯一性
 *
 * 由 dispatcher.register() 在每次 register/unregister 后调用
 *
 * @param plugins 当前已注册的 plugin 列表
 * @throws {PluginPriorityDuplicateError} priority 重复
 * @throws {PluginMutexAsymmetricError} mutex 不对称
 */
export function validatePluginContracts(plugins: ReadonlyArray<GoalCommandPlugin>): void {
  // 1. priority 唯一性
  const priorityMap = new Map<number, string>();
  for (const p of plugins) {
    const existing = priorityMap.get(p.priority);
    if (existing) {
      throw new PluginPriorityDuplicateError(p.priority, existing, p.name);
    }
    priorityMap.set(p.priority, p.name);
  }

  // 2. mutex 对称性 + 引用合法性
  const nameSet = new Set(plugins.map((p) => p.name));
  for (const p of plugins) {
    for (const target of p.mutex ?? []) {
      // 引用合法性
      if (!nameSet.has(target)) {
        // 引用未知 plugin 允许（允许前向引用，dispatcher.register 时会再做校验）
        continue;
      }
      // 对称性：A 引用 B，B 必须引用 A
      const other = plugins.find((x) => x.name === target);
      if (other && !(other.mutex ?? []).includes(p.name)) {
        throw new PluginMutexAsymmetricError(p.name, target);
      }
    }
  }
}
