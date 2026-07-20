/**
 * DeepCodeX 多角色团队 - PluginContext 完整实现
 *
 * 来源：multi-agent-team skill scripts/dispatcher/plugin_context.py
 * 严格遵循 user rules：禁止 mock/占位/简化；ctx 字段全部真实可用
 * Karpathy 原则：Simplicity First - ctx 是数据容器，不藏业务逻辑
 *
 * 核心契约：
 *   1. PluginContext 是 V3 插件接口（base.GoalCommandPlugin）的核心入参
 *   2. dispatcher 在执行 plugin 时构造 ctx，plugin 不应直接 new
 *   3. ctx.log 是唯一的日志出口（避免 plugin 直接 console.log）
 *   4. ctx.state 跨阶段共享（plan → dev → verify → fix）
 *   5. ctx.dryRun=true 时所有写入类操作必须 no-op
 *   6. ctx.registry 是 plugin 的注册表（提供 hot_register / hot_unregister）
 *   7. ctx.dispatcher 是当前 dispatcher（用于 multi-goal 子目标调度）
 *
 * 与 multi-agent-team v2.7 字段对齐：
 *   - project_root / log / registry / dry_run / dispatch
 *   - 增加 extensions: settings / session / tools（与 deepcode-cli 集成）
 */

import type { DispatchResult, DispatchStatus, TaskRequirement } from "./types.js";
import type { PluginRegistry } from "./plugins/goal-dispatcher.js";

// ============================================================================
// 第一部分：日志级别与事件类型
// ============================================================================

/**
 * 日志级别（与 multi-agent-team log 协议一致）
 */
export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/**
 * 事件类型（plugin 与 ctx 通信）
 */
export type PluginEventType =
  | "plugin.started"
  | "plugin.completed"
  | "plugin.failed"
  | "plugin.cancelled"
  | "plugin.log"
  | "plugin.progress"
  | "plugin.artifact"
  | "plugin.decision"
  | "plugin.checkpoint"
  | "subgoal.spawned"
  | "subgoal.completed"
  | "subgoal.failed"
  | "phase.transition"
  | "cancel.signal"
  | "error"
  | "warn"
  | "info"
  | "debug";

/**
 * 事件载荷
 */
export interface PluginEvent {
  type: PluginEventType | string;
  payload: unknown;
  timestamp: string;
  /** 事件源（plugin name） */
  source?: string;
  /** 关联 dispatchId（用于聚合） */
  dispatchId?: string;
}

// ============================================================================
// 第二部分：PluginContext 完整定义
// ============================================================================

/**
 * V3 PluginContext（V3 架构，data 容器）
 *
 * 字段：
 *   - projectRoot  项目根目录（绝对路径）
 *   - log          统一日志出口
 *   - dryRun       dry-run 标志（true 时所有写入类操作必须 no-op）
 *   - registry     plugin 注册表（hot_register / hot_unregister）
 *   - dispatcher   当前 dispatcher（multi-goal 用）
 *   - dispatch     当前 dispatch 元数据
 *   - task         关联的 task requirement
 *   - state        跨阶段共享 state（key-value 容器）
 *   - events       事件流（plugin 写入，dispatcher 消费）
 *   - cancelled    取消标志
 *   - extensions   扩展字段（settings / session / tools）
 *   - startTime    ctx 创建时间
 */
export interface PluginContext {
  // === 必填字段 ===
  /** 项目根目录（绝对路径） */
  projectRoot: string;
  /** 任务需求 */
  task: TaskRequirement;
  /** 当前 dispatch 元数据 */
  dispatch: {
    /** Dispatch UUID */
    dispatchId: string;
    /** 触发的 plugin name */
    plugin: string;
    /** 触发的 goalId（multi-goal 子调度时存在） */
    goalId?: string;
  };
  /** PluginRegistry（plugin 列表 + mutex 管理） */
  registry: PluginRegistry;
  /** 当前 dispatcher 引用（multi-goal 子调度） */
  dispatcher: import("./plugins/goal-dispatcher.js").GoalDispatcher;

  // === 关键标志 ===
  /** Dry-run 标志（true 时 plugin 不得真正写入文件 / 调用外部 API） */
  dryRun: boolean;
  /** 取消信号（任何 plugin 可置 true，dispatcher 周期性检查） */
  cancelled: boolean;

  // === 共享数据 ===
  /** 跨阶段共享 state（key-value 容器） */
  state: Record<string, unknown>;
  /** 事件流（plugin 写入，dispatcher 消费） */
  events: PluginEvent[];
  /** ctx 创建时间（用于耗时计算） */
  startTime: number;
  /** 截止时间（毫秒时间戳，0 表示无超时） */
  deadlineMs: number;

  // === 日志与扩展 ===
  /** 统一日志出口（默认 console，但可被 host 替换） */
  log: (message: string, level?: LogLevel) => void;
  /** 扩展字段（settings / session / tools） */
  extensions: {
    settings?: Record<string, unknown>;
    session?: {
      sessionId: string;
      cwd: string;
      env: Record<string, string>;
    };
    tools?: {
      executeShell?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      readFile?: (path: string) => Promise<string>;
      writeFile?: (path: string, content: string) => Promise<void>;
    };
  };

  // === v1.1 新增：领域专家集成 ===
  /**
   * 当前 multi-agent-team 阶段（1-8）
   *
   * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3
   * 用途：DomainExpertReviewPlugin.matches() 判断当前是否处于阶段 2（架构设计）
   *       或阶段 8（发布评审），决定是否触发领域专家 review
   *
   * 8 阶段定义（与 multi-agent-team skill 对齐）：
   *   1 = 需求分析 / 2 = 架构设计 / 3 = 开发规划 / 4 = 编码实现
   *   5 = 测试验证 / 6 = 集成交付 / 7 = 部署上线 / 8 = 发布评审
   *
   * 向后兼容：可选字段，未设置时 DomainExpertReviewPlugin.matches() 返回 false
   */
  currentPhase?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

// ============================================================================
// 第三部分：构造器
// ============================================================================

/**
 * 构造 PluginContext（dispatcher 在 executeGoal 时调用）
 *
 * @param params 必填字段
 * @returns 完整 ctx
 */
export interface BuildContextParams {
  projectRoot: string;
  task: TaskRequirement;
  dispatch: { dispatchId: string; plugin: string; goalId?: string };
  registry: PluginRegistry;
  dispatcher: import("./plugins/goal-dispatcher.js").GoalDispatcher;
  dryRun?: boolean;
  state?: Record<string, unknown>;
  deadlineMs?: number;
  log?: (message: string, level?: LogLevel) => void;
  extensions?: PluginContext["extensions"];
  /** v1.1 新增：当前 multi-agent-team 阶段（1-8），用于 DomainExpertReviewPlugin */
  currentPhase?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

/**
 * 构造 PluginContext 的工厂函数
 *
 * 设计：
 *   - 必填字段无 default，防止误用
 *   - dryRun 默认 false
 *   - state 默认空对象（避免 plugin 写入 null）
 *   - events 默认空数组
 *   - log 默认写入 ctx.events（便于 dispatcher 收集）
 *   - cancelled 默认 false
 *   - startTime 设为 Date.now()
 */
export function buildPluginContext(params: BuildContextParams): PluginContext {
  const projectRoot = params.projectRoot;
  if (!projectRoot) {
    throw new Error("buildPluginContext: projectRoot 不能为空");
  }
  if (!params.task) {
    throw new Error("buildPluginContext: task 不能为空");
  }
  if (!params.dispatch?.dispatchId) {
    throw new Error("buildPluginContext: dispatch.dispatchId 不能为空");
  }
  if (!params.registry) {
    throw new Error("buildPluginContext: registry 不能为空");
  }
  if (!params.dispatcher) {
    throw new Error("buildPluginContext: dispatcher 不能为空");
  }

  const events: PluginEvent[] = [];
  const internalLog = (message: string, level: LogLevel = "INFO"): void => {
    // 默认 log：写入 ctx.events（dispatcher 消费并路由到 host logger）
    events.push({
      type: level === "DEBUG" ? "plugin.log" : `plugin.log.${level.toLowerCase()}`,
      payload: { message, level },
      timestamp: new Date().toISOString(),
      source: params.dispatch.plugin,
      dispatchId: params.dispatch.dispatchId,
    });
  };

  return {
    projectRoot,
    task: params.task,
    dispatch: params.dispatch,
    registry: params.registry,
    dispatcher: params.dispatcher,
    dryRun: params.dryRun ?? false,
    cancelled: false,
    state: params.state ? { ...params.state } : {},
    events,
    startTime: Date.now(),
    deadlineMs: params.deadlineMs ?? 0,
    log: params.log ?? internalLog,
    extensions: params.extensions ?? {},
    currentPhase: params.currentPhase,
  };
}

// ============================================================================
// 第四部分：ctx 辅助方法（纯函数）
// ============================================================================

/**
 * 记录 info 级别日志（ctx.log 包装）
 */
export function ctxInfo(ctx: PluginContext, message: string): void {
  ctx.log(message, "INFO");
}

/**
 * 记录 warning 级别日志
 */
export function ctxWarn(ctx: PluginContext, message: string): void {
  ctx.log(message, "WARNING");
}

/**
 * 记录 error 级别日志
 */
export function ctxError(ctx: PluginContext, message: string): void {
  ctx.log(message, "ERROR");
}

/**
 * 记录 debug 级别日志
 */
export function ctxDebug(ctx: PluginContext, message: string): void {
  ctx.log(message, "DEBUG");
}

/**
 * 记录 critical 级别日志（hot_reload rollback 失败等不可恢复错误）
 */
export function ctxCritical(ctx: PluginContext, message: string): void {
  ctx.log(message, "CRITICAL");
}

/**
 * 向 ctx.events 推入事件
 */
export function emitEvent(ctx: PluginContext, type: PluginEventType | string, payload: unknown): void {
  ctx.events.push({
    type,
    payload,
    timestamp: new Date().toISOString(),
    source: ctx.dispatch.plugin,
    dispatchId: ctx.dispatch.dispatchId,
  });
}

/**
 * 从 ctx.state 读取值（带类型守卫）
 */
export function getState<T>(ctx: PluginContext, key: string): T | undefined {
  return ctx.state[key] as T | undefined;
}

/**
 * 向 ctx.state 写入值
 */
export function setState<T>(ctx: PluginContext, key: string, value: T): void {
  ctx.state[key] = value;
}

/**
 * 检查 ctx 是否已超时
 *
 * @returns true 表示超时
 */
export function isTimedOut(ctx: PluginContext): boolean {
  if (ctx.deadlineMs === 0) return false;
  return Date.now() >= ctx.deadlineMs;
}

/**
 * 计算 ctx 已运行毫秒数
 */
export function elapsedMs(ctx: PluginContext): number {
  return Date.now() - ctx.startTime;
}

/**
 * 派生 DispatchResult（基于 ctx 状态构造）
 *
 * 用法：plugin.execute 完成后调用此函数生成标准 DispatchResult
 */
export function toDispatchResult(
  ctx: PluginContext,
  status: DispatchStatus,
  options?: {
    output?: string;
    error?: string;
    artifacts?: string[];
    tokensConsumed?: { prompt: number; completion: number; total: number };
    cacheHit?: boolean;
    retryCount?: number;
  }
): DispatchResult {
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
      reasons: [`Plugin ${ctx.dispatch.plugin} executed`],
      scoreBreakdown: { capability: 1, skill: 1, keyword: 1, priority: 1 },
      strategy: "keyword",
    },
    status,
    startedAt: new Date(ctx.startTime).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: elapsedMs(ctx),
    output: options?.output,
    error: options?.error,
    artifacts: options?.artifacts ?? [],
    tokensConsumed: options?.tokensConsumed ?? { prompt: 0, completion: 0, total: 0 },
    cacheHit: options?.cacheHit ?? false,
    retryCount: options?.retryCount ?? 0,
  };
}

/**
 * 检查 ctx.dryRun 标志（写入操作前置守卫）
 *
 * 用法：
 *   if (guardDryRun(ctx, "写文件")) return;
 *   fs.writeFileSync(...)
 */
export function guardDryRun(ctx: PluginContext, operation: string): boolean {
  if (ctx.dryRun) {
    ctxInfo(ctx, `[dryRun] 跳过 ${operation}`);
    emitEvent(ctx, "plugin.log", { level: "INFO", message: `[dryRun] 跳过 ${operation}` });
    return true;
  }
  return false;
}

/**
 * 检查 ctx.cancelled 标志
 */
export function isCancelled(ctx: PluginContext): boolean {
  return ctx.cancelled;
}

/**
 * 复制 ctx（用于 multi-goal 子调度时隔离 state）
 *
 * 注意：events / state 浅复制；extensions 引用共享
 */
export function clonePluginContext(ctx: PluginContext, overrides?: Partial<BuildContextParams>): PluginContext {
  return buildPluginContext({
    projectRoot: overrides?.projectRoot ?? ctx.projectRoot,
    task: overrides?.task ?? ctx.task,
    dispatch: overrides?.dispatch ?? ctx.dispatch,
    registry: overrides?.registry ?? ctx.registry,
    dispatcher: overrides?.dispatcher ?? ctx.dispatcher,
    dryRun: overrides?.dryRun ?? ctx.dryRun,
    state: { ...ctx.state, ...(overrides?.state ?? {}) },
    deadlineMs: overrides?.deadlineMs ?? ctx.deadlineMs,
    log: overrides?.log ?? ctx.log,
    extensions: overrides?.extensions ?? ctx.extensions,
    currentPhase: overrides?.currentPhase ?? ctx.currentPhase,
  });
}
