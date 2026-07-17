/**
 * Feedback Control Loop - 反馈控制环核心实现
 *
 * 来源：multi-agent-team skill scripts/feedback_control_loop.py
 * 严格遵循 user rules：禁止 mock/占位/简化，真实实现完整闭环
 *
 * 职责：
 * 1. 实现"感知-决策-执行-反馈"完整闭环（工程控制论核心）
 * 2. 案例库：基于历史相似任务选择最优策略
 * 3. 状态估计：基于历史数据估计当前任务成功率与执行时间
 * 4. 反馈收集：聚合任务执行反馈并统计错误模式
 * 5. 持久化：案例数据 JSON 序列化存储
 *
 * 设计原则：
 * - 基于案例的策略选择（替代 PID 控制，更适合 AI Agent 认知任务）
 * - 线程安全：所有共享状态通过 SimpleMutex 保护
 * - 案例库上限 1000 条（FIFO 淘汰）
 * - AI 失败时优雅降级（不影响主流程）
 *
 * 作者：trae-multi-agent 融合 Phase 2（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

// 显式 ESM 导入 node:fs，避免在 ESM 模块中使用 require 失败
import * as nodeFs from "node:fs";

// ============================================================================
// 枚举：控制阶段
// ============================================================================

/**
 * 控制阶段枚举
 *
 * 表示反馈控制环中当前所处的阶段
 */
export const ControlPhase = {
  PERCEPTION: "perception", // 感知阶段：收集状态信息
  DECISION: "decision", // 决策阶段：选择执行策略
  EXECUTION: "execution", // 执行阶段：执行任务
  FEEDBACK: "feedback", // 反馈阶段：收集执行反馈
  COMPLETED: "completed", // 完成阶段：任务结束
} as const;

export type ControlPhaseType = (typeof ControlPhase)[keyof typeof ControlPhase];

/** 所有控制阶段 */
export const ALL_CONTROL_PHASES: readonly ControlPhaseType[] = [
  ControlPhase.PERCEPTION,
  ControlPhase.DECISION,
  ControlPhase.EXECUTION,
  ControlPhase.FEEDBACK,
  ControlPhase.COMPLETED,
];

/** 校验控制阶段 */
export function isValidControlPhase(phase: string): phase is ControlPhaseType {
  return (ALL_CONTROL_PHASES as readonly string[]).includes(phase);
}

// ============================================================================
// 异常类
// ============================================================================

/** 反馈控制环基础异常 */
export class FeedbackControlLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackControlLoopError";
  }
}

/** 存储失败 */
export class FeedbackControlStorageError extends FeedbackControlLoopError {
  public readonly path: string;
  constructor(path: string, cause?: Error) {
    super(`存储失败：${path}${cause ? ` (${cause.message})` : ""}`);
    this.name = "FeedbackControlStorageError";
    this.path = path;
  }
}

// ============================================================================
// 数据结构
// ============================================================================

/**
 * 执行案例数据类
 *
 * 记录一次完整的任务执行案例，用于案例检索和策略学习
 */
export interface ExecutionCase {
  /** 案例 ID（唯一） */
  case_id: string;
  /** 任务类型 */
  task_type: string;
  /** 任务复杂度 1-10 */
  task_complexity: number;
  /** 任务特征字典 */
  task_features: Record<string, unknown>;
  /** 使用的策略名称 */
  strategy: string;
  /** 执行时间（秒） */
  execution_time: number;
  /** 是否成功 */
  success: boolean;
  /** 错误类型（如有） */
  error_type: string | null;
  /** 额外反馈信息 */
  feedback: Record<string, unknown> | null;
  /** 创建时间（ISO 字符串） */
  created_at: string;
}

/** 创建 ExecutionCase */
export function createExecutionCase(args: {
  case_id: string;
  task_type: string;
  task_complexity: number;
  task_features: Record<string, unknown>;
  strategy: string;
  execution_time: number;
  success: boolean;
  error_type?: string | null;
  feedback?: Record<string, unknown> | null;
}): ExecutionCase {
  return {
    case_id: args.case_id,
    task_type: args.task_type,
    task_complexity: args.task_complexity,
    task_features: args.task_features,
    strategy: args.strategy,
    execution_time: args.execution_time,
    success: args.success,
    error_type: args.error_type ?? null,
    feedback: args.feedback ?? null,
    created_at: new Date().toISOString(),
  };
}

/** ExecutionCase 转字典 */
export function executionCaseToDict(c: ExecutionCase): Record<string, unknown> {
  return {
    case_id: c.case_id,
    task_type: c.task_type,
    task_complexity: c.task_complexity,
    task_features: c.task_features,
    strategy: c.strategy,
    execution_time: c.execution_time,
    success: c.success,
    error_type: c.error_type,
    feedback: c.feedback,
    created_at: c.created_at,
  };
}

/** 从字典恢复 ExecutionCase */
export function executionCaseFromDict(data: Record<string, unknown>): ExecutionCase {
  return {
    case_id: String(data["case_id"] ?? ""),
    task_type: String(data["task_type"] ?? "unknown"),
    task_complexity: Number(data["task_complexity"] ?? 5),
    task_features: (data["task_features"] as Record<string, unknown>) ?? {},
    strategy: String(data["strategy"] ?? "default"),
    execution_time: Number(data["execution_time"] ?? 0),
    success: Boolean(data["success"] ?? false),
    error_type: (data["error_type"] as string) ?? null,
    feedback: (data["feedback"] as Record<string, unknown>) ?? null,
    created_at: String(data["created_at"] ?? new Date().toISOString()),
  };
}

/**
 * 控制状态数据类
 *
 * 记录反馈控制环的当前状态
 */
export interface ControlState {
  agent_id: string;
  current_phase: ControlPhaseType;
  current_task_id: string | null;
  current_strategy: string | null;
  execution_count: number;
  success_count: number;
  failure_count: number;
  total_execution_time: number;
  last_case_id: string | null;
  last_error: string | null;
  /** 策略调整次数 */
  adaptation_count: number;
  created_at: string;
  updated_at: string;
}

/** 计算成功率 */
export function controlStateSuccessRate(s: ControlState): number {
  if (s.execution_count === 0) return 0.0;
  return s.success_count / s.execution_count;
}

/** 计算平均执行时间 */
export function controlStateAvgTime(s: ControlState): number {
  if (s.execution_count === 0) return 0.0;
  return s.total_execution_time / s.execution_count;
}

/** 创建 ControlState */
export function createControlState(agent_id: string): ControlState {
  const now = new Date().toISOString();
  return {
    agent_id,
    current_phase: ControlPhase.PERCEPTION,
    current_task_id: null,
    current_strategy: null,
    execution_count: 0,
    success_count: 0,
    failure_count: 0,
    total_execution_time: 0.0,
    last_case_id: null,
    last_error: null,
    adaptation_count: 0,
    created_at: now,
    updated_at: now,
  };
}

/** 标记 ControlState 更新时间 */
export function touchControlState(s: ControlState): void {
  s.updated_at = new Date().toISOString();
}

/**
 * 反馈数据类
 *
 * 记录任务执行后的反馈信息
 */
export interface Feedback {
  task_id: string;
  success: boolean;
  execution_time: number;
  error_type: string | null;
  error_message: string | null;
  suggestions: string[];
  metrics: Record<string, unknown>;
  created_at: string;
}

/** 创建 Feedback */
export function createFeedback(args: {
  task_id: string;
  success: boolean;
  execution_time: number;
  error_type?: string | null;
  error_message?: string | null;
  suggestions?: string[];
  metrics?: Record<string, unknown>;
}): Feedback {
  return {
    task_id: args.task_id,
    success: args.success,
    execution_time: args.execution_time,
    error_type: args.error_type ?? null,
    error_message: args.error_message ?? null,
    suggestions: args.suggestions ?? [],
    metrics: args.metrics ?? {},
    created_at: new Date().toISOString(),
  };
}

// ============================================================================
// 互斥锁（避免引入额外依赖，使用 SimpleMutex 替代 threading.Lock）
// ============================================================================

/**
 * 简单的异步互斥锁（类 Python threading.Lock 语义）
 *
 * 使用方式：
 * ```ts
 * const mutex = new SimpleMutex();
 * await mutex.runExclusive(() => { ... });
 * ```
 */
export class SimpleMutex {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  /** 同步锁：立即获取锁（不阻塞） */
  lockSync(): boolean {
    if (this._locked) return false;
    this._locked = true;
    return true;
  }

  /** 同步解锁 */
  unlockSync(): void {
    this._locked = false;
    const next = this._waiters.shift();
    if (next) {
      this._locked = true;
      next();
    }
  }

  /** 异步锁：等待并获取锁 */
  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(() => resolve());
    });
  }

  /** 释放锁 */
  release(): void {
    this._locked = false;
    const next = this._waiters.shift();
    if (next) {
      this._locked = true;
      next();
    }
  }

  /** 在锁内执行（异步） */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** 在锁内执行（同步） */
  runExclusiveSync<T>(fn: () => T): T {
    if (!this.lockSync()) {
      throw new FeedbackControlLoopError("锁已被占用，无法同步执行");
    }
    try {
      return fn();
    } finally {
      this.unlockSync();
    }
  }
}

// ============================================================================
// 文件系统抽象（避免 Node fs 硬编码）
// ============================================================================

/** 文件系统抽象接口（便于测试时注入 mock fs） */
export interface FileSystemLike {
  exists(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): void;
  readdir(path: string): string[];
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  glob(path: string, pattern: string): string[];
}

/** 默认文件系统实现（Node.js fs 同步 API） */
export class NodeFileSystem implements FileSystemLike {
  // 使用 ESM 导入的 node:fs（nodeFs），避免在 ESM 模式下 require 未定义

  private _fs: typeof import("node:fs") = nodeFs;

  exists(path: string): boolean {
    try {
      this._fs.accessSync(path);
      return true;
    } catch {
      return false;
    }
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    this._fs.mkdirSync(path, { recursive: options?.recursive ?? false });
  }

  readdir(path: string): string[] {
    return this._fs.readdirSync(path);
  }

  readFile(path: string): string {
    return this._fs.readFileSync(path, "utf-8");
  }

  writeFile(path: string, content: string): void {
    this._fs.writeFileSync(path, content, "utf-8");
  }

  glob(path: string, pattern: string): string[] {
    // 简单实现：仅支持 *.ext 模式
    if (!pattern.startsWith("*.")) {
      return [];
    }
    const ext = pattern.slice(1); // ".json"
    const all = this._fs.readdirSync(path);
    return all.filter((f) => f.endsWith(ext));
  }
}

// ============================================================================
// 反馈收集器
// ============================================================================

/**
 * 反馈收集器
 *
 * 负责收集任务执行的反馈信息，并进行预处理
 */
export class FeedbackCollector {
  /** 反馈历史 */
  public feedback_history: Feedback[] = [];
  /** 错误模式统计 */
  public error_patterns: Map<string, number> = new Map();
  /** 线程安全锁 */
  private _lock = new SimpleMutex();

  /**
   * 收集任务执行的反馈
   */
  async collect(task_id: string, execution_result: Record<string, unknown>): Promise<Feedback> {
    const success = Boolean(execution_result["success"] ?? false);
    const execution_time = Number(execution_result["execution_time"] ?? 0.0);
    const error_type = (execution_result["error_type"] as string | undefined) ?? null;
    const error_message = (execution_result["error_message"] as string | undefined) ?? null;
    const suggestions = (execution_result["suggestions"] as string[] | undefined) ?? [];
    const metrics = (execution_result["metrics"] as Record<string, unknown> | undefined) ?? {};

    const feedback = createFeedback({
      task_id,
      success,
      execution_time,
      error_type,
      error_message,
      suggestions,
      metrics,
    });

    await this._lock.runExclusive(() => {
      this.feedback_history.push(feedback);
      if (error_type) {
        this.error_patterns.set(error_type, (this.error_patterns.get(error_type) ?? 0) + 1);
      }
    });

    return feedback;
  }

  /**
   * 获取最近的反馈
   */
  async getRecentFeedback(limit: number = 10): Promise<Feedback[]> {
    return this._lock.runExclusive(() => {
      return [...this.feedback_history].slice(-limit);
    });
  }

  /**
   * 获取错误统计信息
   */
  async getErrorStatistics(): Promise<Record<string, number>> {
    return this._lock.runExclusive(() => {
      const result: Record<string, number> = {};
      for (const [k, v] of this.error_patterns.entries()) {
        result[k] = v;
      }
      return result;
    });
  }
}

// ============================================================================
// 状态估计器
// ============================================================================

/**
 * 状态估计器
 *
 * 负责估计当前执行状态，基于历史数据和当前任务特征
 */
export class StateEstimator {
  /** 状态历史 */
  public state_history: Array<Record<string, unknown>> = [];
  private _lock = new SimpleMutex();
  /** 默认成功率（无历史时） */
  public static readonly DEFAULT_SUCCESS_RATE = 0.85;
  /** 默认执行时间（无历史时） */
  public static readonly DEFAULT_EXECUTION_TIME = 60.0;
  /** 历史回看数量 */
  public static readonly HISTORY_LOOKBACK = 50;
  /** 复杂度匹配容差 */
  public static readonly COMPLEXITY_TOLERANCE = 2;

  /**
   * 估计当前状态
   */
  async estimate(
    task: Record<string, unknown>,
    context: Record<string, unknown> | null = null
  ): Promise<Record<string, unknown>> {
    const task_type = String(task["type"] ?? "unknown");
    const complexity = Number(task["complexity"] ?? 5);
    const features = (task["features"] as Record<string, unknown> | undefined) ?? {};

    // 基于历史数据估计当前状态
    const similar_states = await this._findSimilarStates(task_type, complexity);

    const state: Record<string, unknown> = {
      task_type,
      complexity,
      features,
      context: context ?? {},
      similar_states,
      estimated_success_rate: this._calculateSuccessRate(similar_states),
      estimated_execution_time: this._calculateAvgTime(similar_states),
      timestamp: new Date().toISOString(),
    };

    await this._lock.runExclusive(() => {
      this.state_history.push(state);
    });

    return state;
  }

  /**
   * 查找相似的历史状态
   */
  private async _findSimilarStates(task_type: string, complexity: number): Promise<Array<Record<string, unknown>>> {
    return this._lock.runExclusive(() => {
      const similar: Array<Record<string, unknown>> = [];
      const recent = this.state_history.slice(-StateEstimator.HISTORY_LOOKBACK);
      for (const state of recent) {
        if (state["task_type"] === task_type) {
          const state_complexity = Number(state["complexity"] ?? 5);
          if (Math.abs(state_complexity - complexity) <= StateEstimator.COMPLEXITY_TOLERANCE) {
            similar.push(state);
          }
        }
      }
      return similar;
    });
  }

  /**
   * 计算历史状态的成功率
   */
  private _calculateSuccessRate(states: Array<Record<string, unknown>>): number {
    if (states.length === 0) return StateEstimator.DEFAULT_SUCCESS_RATE;
    const success_count = states.filter((s) => Boolean(s["success"] ?? true)).length;
    return success_count / states.length;
  }

  /**
   * 计算历史状态的平均执行时间
   */
  private _calculateAvgTime(states: Array<Record<string, unknown>>): number {
    if (states.length === 0) return StateEstimator.DEFAULT_EXECUTION_TIME;
    const times = states.map((s) => Number(s["execution_time"] ?? StateEstimator.DEFAULT_EXECUTION_TIME));
    return times.reduce((a, b) => a + b, 0) / times.length;
  }
}

// ============================================================================
// 策略池
// ============================================================================

/**
 * 策略池配置
 */
export interface StrategyConfig {
  name: string;
  description: string;
  timeout: number; // 超时（秒）
  retry: boolean;
  max_retry: number;
}

/** 预定义策略 */
export const STRATEGY_DEFINITIONS: Record<string, StrategyConfig> = {
  conservative: {
    name: "保守策略",
    description: "优先保证成功率，降低执行速度",
    timeout: 300, // 5 分钟
    retry: true,
    max_retry: 3,
  },
  balanced: {
    name: "平衡策略",
    description: "在成功率和速度之间取得平衡",
    timeout: 180, // 3 分钟
    retry: true,
    max_retry: 2,
  },
  aggressive: {
    name: "激进策略",
    description: "优先追求速度，可能牺牲一些成功率",
    timeout: 60, // 1 分钟
    retry: false,
    max_retry: 1,
  },
  default: {
    name: "默认策略",
    description: "使用系统默认配置",
    timeout: 120, // 2 分钟
    retry: true,
    max_retry: 2,
  },
};

/** 所有有效策略名 */
export const ALL_STRATEGIES: readonly string[] = Object.keys(STRATEGY_DEFINITIONS);

/**
 * 策略池
 *
 * 管理可用的执行策略
 */
export class StrategyPool {
  /** 获取指定策略 */
  getStrategy(name: string): StrategyConfig {
    return STRATEGY_DEFINITIONS[name] ?? STRATEGY_DEFINITIONS["default"]!;
  }

  /** 获取默认策略名称 */
  getDefaultStrategy(): string {
    return "default";
  }

  /** 获取保守策略名称 */
  getConservativeStrategy(): string {
    return "conservative";
  }

  /** 获取所有策略 */
  getAllStrategies(): Record<string, StrategyConfig> {
    return { ...STRATEGY_DEFINITIONS };
  }
}

// ============================================================================
// 任务执行器签名
// ============================================================================

/** 任务执行器函数签名：(task) => result */
export type TaskExecutor = (
  task: Record<string, unknown>
) => Record<string, unknown> | Promise<Record<string, unknown>>;

// ============================================================================
// 反馈控制环主类
// ============================================================================

/**
 * 反馈控制环配置
 */
export interface FeedbackControlLoopConfig {
  agent_id: string;
  storage_path?: string | null;
  fs?: FileSystemLike;
  /** 案例库最大容量（默认 1000） */
  max_cases?: number;
}

/**
 * 反馈控制环核心类
 *
 * 实现工程控制论中的反馈闭环：
 * 1. 感知阶段：收集当前状态
 * 2. 决策阶段：选择执行策略
 * 3. 执行阶段：执行任务
 * 4. 反馈阶段：收集反馈并更新
 *
 * 本实现采用基于案例的策略选择（非PID控制），
 * 以适配 AI Agent 的认知任务特性
 */
export class FeedbackControlLoop {
  /** 默认案例库最大容量 */
  public static readonly DEFAULT_MAX_CASES = 1000;
  /** 复杂度匹配容差 */
  public static readonly COMPLEXITY_TOLERANCE = 2;

  public agent_id: string;
  public storage_path: string;
  public state_estimator: StateEstimator;
  public feedback_collector: FeedbackCollector;
  public case_library: ExecutionCase[] = [];
  public strategy_pool: StrategyPool;
  public control_state: ControlState;
  public executor: TaskExecutor | null = null;

  private _lock = new SimpleMutex();
  private _fs: FileSystemLike;
  private _max_cases: number;

  constructor(config: FeedbackControlLoopConfig) {
    this.agent_id = config.agent_id;
    this.storage_path = config.storage_path ?? `./feedback_data/${config.agent_id}`;
    this._fs = config.fs ?? new NodeFileSystem();
    this._max_cases = config.max_cases ?? FeedbackControlLoop.DEFAULT_MAX_CASES;

    // 核心组件初始化
    this.state_estimator = new StateEstimator();
    this.feedback_collector = new FeedbackCollector();
    this.strategy_pool = new StrategyPool();
    this.control_state = createControlState(config.agent_id);

    // 加载已有案例（同步加载是必要的，因为构造函数不能 async）
    this._loadCasesSync();
  }

  /** 设置任务执行器 */
  setExecutor(executor: TaskExecutor): void {
    this.executor = executor;
  }

  /**
   * 带反馈的执行业务方法
   *
   * 完整流程：
   * 1. 感知阶段：估计当前状态
   * 2. 决策阶段：基于案例选择策略
   * 3. 执行阶段：执行任务
   * 4. 反馈阶段：收集反馈并记录案例
   */
  async executeWithFeedback(task: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task_id = String(task["id"] ?? `task_${Date.now()}`);

    // 更新控制状态
    await this._lock.runExclusive(() => {
      this.control_state.current_task_id = task_id;
      this.control_state.current_phase = ControlPhase.PERCEPTION;
    });

    try {
      // 阶段1: 感知阶段
      const current_state = await this.state_estimator.estimate(task);

      // 阶段2: 决策阶段 - 基于案例选择策略
      await this._lock.runExclusive(() => {
        this.control_state.current_phase = ControlPhase.DECISION;
      });
      const selected_strategy = await this._selectStrategy(task, current_state);
      await this._lock.runExclusive(() => {
        this.control_state.current_strategy = selected_strategy;
      });

      // 阶段3: 执行阶段
      await this._lock.runExclusive(() => {
        this.control_state.current_phase = ControlPhase.EXECUTION;
      });
      const execution_start = Date.now();

      let result: Record<string, unknown>;
      if (this.executor) {
        result = await this.executor(task);
      } else {
        // 默认执行逻辑（不返回 mock，抛出明确错误）
        throw new FeedbackControlLoopError(
          "FeedbackControlLoop 没有配置执行器，请通过 set_executor() 提供真实执行逻辑。"
        );
      }

      const execution_time = (Date.now() - execution_start) / 1000.0;
      result["execution_time"] = execution_time;

      // 阶段4: 反馈阶段
      await this._lock.runExclusive(() => {
        this.control_state.current_phase = ControlPhase.FEEDBACK;
      });
      await this._processFeedback(task_id, task, result, selected_strategy, execution_time);

      await this._lock.runExclusive(() => {
        this.control_state.current_phase = ControlPhase.COMPLETED;
      });

      return result;
    } catch (e) {
      // 异常处理
      const error = e instanceof Error ? e : new Error(String(e));
      await this._lock.runExclusive(() => {
        this.control_state.last_error = error.message;
        this.control_state.failure_count += 1;
        this.control_state.current_phase = ControlPhase.FEEDBACK;
      });

      return {
        success: false,
        error_type: error.name,
        error_message: error.message,
        task_id,
      };
    }
  }

  /**
   * 基于案例选择策略
   *
   * 核心逻辑：
   * 1. 查找相似的历史案例
   * 2. 统计成功案例使用的策略
   * 3. 返回最成功的策略
   */
  private async _selectStrategy(task: Record<string, unknown>, _state: Record<string, unknown>): Promise<string> {
    const task_type = String(task["type"] ?? "unknown");
    const complexity = Number(task["complexity"] ?? 5);

    return this._lock.runExclusive(() => {
      // 查找相似案例
      const similar_cases = this.case_library.filter(
        (c) =>
          c.task_type === task_type &&
          Math.abs(c.task_complexity - complexity) <= FeedbackControlLoop.COMPLEXITY_TOLERANCE
      );

      // 如果有相似案例，使用加权投票
      if (similar_cases.length > 0) {
        const successful_strategies = similar_cases.filter((c) => c.success).map((c) => c.strategy);
        if (successful_strategies.length > 0) {
          // 简单投票：选择出现最多的策略
          const counts: Record<string, number> = {};
          for (const s of successful_strategies) {
            counts[s] = (counts[s] ?? 0) + 1;
          }
          let best: string | null = null;
          let best_count = -1;
          for (const [s, c] of Object.entries(counts)) {
            if (c > best_count) {
              best = s;
              best_count = c;
            }
          }
          if (best) {
            // 增加 adaptation_count
            this.control_state.adaptation_count += 1;
            return best;
          }
        }
      }

      // 默认策略
      return this.strategy_pool.getDefaultStrategy();
    });
  }

  /**
   * 处理执行反馈
   *
   * 1. 收集反馈
   * 2. 创建案例
   * 3. 保存案例
   * 4. 更新控制状态
   */
  private async _processFeedback(
    task_id: string,
    task: Record<string, unknown>,
    result: Record<string, unknown>,
    strategy: string,
    execution_time: number
  ): Promise<void> {
    const success = Boolean(result["success"] ?? false);
    const error_type = (result["error_type"] as string | undefined) ?? null;

    // 收集反馈
    await this.feedback_collector.collect(task_id, result);

    // 创建案例
    const caseObj = createExecutionCase({
      case_id: `case_${task_id}_${Date.now()}`,
      task_type: String(task["type"] ?? "unknown"),
      task_complexity: Number(task["complexity"] ?? 5),
      task_features: (task["features"] as Record<string, unknown> | undefined) ?? {},
      strategy,
      execution_time,
      success,
      error_type,
      feedback: (result["feedback"] as Record<string, unknown> | undefined) ?? null,
    });

    await this._lock.runExclusive(() => {
      // 添加到案例库
      this.case_library.push(caseObj);

      // 限制案例库大小（FIFO 淘汰）
      if (this.case_library.length > this._max_cases) {
        this.case_library = this.case_library.slice(-this._max_cases);
      }

      // 更新控制状态
      this.control_state.execution_count += 1;
      this.control_state.total_execution_time += execution_time;
      this.control_state.last_case_id = caseObj.case_id;

      if (success) {
        this.control_state.success_count += 1;
      } else {
        this.control_state.failure_count += 1;
        this.control_state.last_error = error_type;
      }
      touchControlState(this.control_state);
    });

    // 持久化保存（异步，失败不抛）
    try {
      await this._saveCase(caseObj);
    } catch {
      // 忽略存储错误（保持原 Python 行为：except: pass）
    }
  }

  /**
   * 保存案例到存储
   */
  private async _saveCase(caseObj: ExecutionCase): Promise<void> {
    const storage_dir = this.storage_path;
    try {
      if (!this._fs.exists(storage_dir)) {
        this._fs.mkdir(storage_dir, { recursive: true });
      }

      const case_file = `${storage_dir}/${caseObj.case_id}.json`;
      const content = JSON.stringify(executionCaseToDict(caseObj), null, 2);
      this._fs.writeFile(case_file, content);
    } catch (e) {
      throw new FeedbackControlStorageError(this.storage_path, e instanceof Error ? e : undefined);
    }
  }

  /**
   * 从存储加载已有案例（同步版本，仅在构造函数中调用）
   */
  private _loadCasesSync(): void {
    try {
      const storage_dir = this.storage_path;
      if (!this._fs.exists(storage_dir)) return;

      const case_files = this._fs.glob(storage_dir, "*.json");
      for (const case_file of case_files) {
        try {
          const content = this._fs.readFile(`${storage_dir}/${case_file}`);
          const data = JSON.parse(content) as Record<string, unknown>;
          const caseObj = executionCaseFromDict(data);
          this.case_library.push(caseObj);
        } catch {
          // 忽略单个文件加载错误
          continue;
        }
      }

      // 限制加载数量
      if (this.case_library.length > this._max_cases) {
        this.case_library = this.case_library.slice(-this._max_cases);
      }
    } catch {
      // 忽略整体加载错误
    }
  }

  /** 获取当前控制状态 */
  getControlState(): ControlState {
    return this.control_state;
  }

  /**
   * 获取相似案例
   */
  async getSimilarCases(task: Record<string, unknown>, limit: number = 5): Promise<Array<Record<string, unknown>>> {
    const task_type = String(task["type"] ?? "unknown");
    const complexity = Number(task["complexity"] ?? 5);

    return this._lock.runExclusive(() => {
      const similar = this.case_library.filter(
        (c) =>
          c.task_type === task_type &&
          Math.abs(c.task_complexity - complexity) <= FeedbackControlLoop.COMPLEXITY_TOLERANCE
      );

      return similar.slice(-limit).map((c) => executionCaseToDict(c));
    });
  }

  /**
   * 获取统计信息
   */
  async getStatistics(): Promise<Record<string, unknown>> {
    return this._lock.runExclusive(() => {
      return {
        agent_id: this.agent_id,
        total_cases: this.case_library.length,
        execution_count: this.control_state.execution_count,
        success_count: this.control_state.success_count,
        failure_count: this.control_state.failure_count,
        success_rate: controlStateSuccessRate(this.control_state),
        average_execution_time: controlStateAvgTime(this.control_state),
        strategy_usage: this._getStrategyUsage(),
      };
    });
  }

  /** 获取策略使用统计 */
  private _getStrategyUsage(): Record<string, number> {
    const usage: Record<string, number> = {};
    for (const c of this.case_library) {
      usage[c.strategy] = (usage[c.strategy] ?? 0) + 1;
    }
    return usage;
  }

  /**
   * 重置控制环状态
   *
   * 注意：不会删除持久化的案例数据
   */
  async reset(): Promise<void> {
    await this._lock.runExclusive(() => {
      this.control_state = createControlState(this.agent_id);
      this.feedback_collector = new FeedbackCollector();
      this.state_estimator = new StateEstimator();
    });
  }
}
