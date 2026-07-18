/**
 * Loop Guard —— 共享上限保护模块
 *
 * EAG 方案 §5.2.1 评审 A-3/A-4 共识：eag/loop 与 team/autonomous/loop-controller
 * 两套循环的上限保护/退避策略提取为共享模块，避免第三套循环方言。
 *
 * 功能：
 * 1. max_iterations 上限保护（防止无限循环）
 * 2. max_tokens 预算守门（防止 Token 爆炸）
 * 3. 连续失败 abort（连续 N 次 FIX 失败终止 Loop）
 * 4. 指数退避 + jitter（失败后重试的时间间隔策略）
 *
 * 设计依据：
 * - EAG 方案 §5.2.1 五步闭环上限保护
 * - EAG 方案 §5.12.3 AU-5 硬上限已配置（LLM 在循环内不可自改上限）
 * - multi-agent-team skill scripts/autonomous/loop_controller.py 退避策略
 *
 * @module common/loop-guard
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Loop Guard 配置
 *
 * 定义循环的上限保护参数。配置对象在创建后应被 Object.freeze 冻结，
 * 确保 LLM 在循环内不可自改上限（§5.12.3 AU-5 / §5.12.4 G-A6d）。
 */
export interface LoopGuardConfig {
  /** 最大迭代次数（默认 50，上限 1000） */
  maxIterations: number;
  /** 最大 Token 预算（默认 200000，约 GPT-4 上下文窗口的 50%） */
  maxTokens: number;
  /** 连续失败上限（默认 3，§5.2.3 连续 3 次同类失败 → HUMAN_CHECKPOINT） */
  maxConsecutiveFailures: number;
  /** 初始退避延迟（毫秒，默认 1000） */
  initialBackoffMs: number;
  /** 最大退避延迟（毫秒，默认 30000，即 30 秒） */
  maxBackoffMs: number;
  /** 退避乘数（每次失败延迟乘以此系数，默认 2.0 指数退避） */
  backoffMultiplier: number;
  /** Jitter 比例（0-1，默认 0.1，即 ±10% 随机抖动避免惊群） */
  jitterRatio: number;
}

/**
 * Loop Guard 运行时状态
 *
 * 跟踪循环的实时消耗，用于判定是否触达上限。
 */
export interface LoopGuardState {
  /** 已执行迭代次数 */
  iterationsCompleted: number;
  /** 已消耗 Token 数 */
  tokensConsumed: number;
  /** 当前连续失败次数 */
  consecutiveFailures: number;
  /** 总失败次数（含非连续的） */
  totalFailures: number;
  /** 上次失败时间（ISO 8601，用于退避计算） */
  lastFailureTime?: string;
  /** 当前退避级别（第 N 次失败，用于指数退避计算） */
  backoffLevel: number;
}

/**
 * Guard 检查结果
 *
 * 每次迭代前调用 check() 获取当前是否允许继续执行。
 */
export interface GuardCheckResult {
  /** 是否允许继续执行 */
  allowed: boolean;
  /** 终止原因（allowed=false 时填写） */
  stopReason?: GuardStopReason;
  /** 建议的等待时间（毫秒，用于退避，allowed=true 且有失败记录时填写） */
  suggestedWaitMs?: number;
  /** 当前状态快照 */
  state: LoopGuardState;
  /** 剩余迭代次数 */
  remainingIterations: number;
  /** 剩余 Token 预算 */
  remainingTokens: number;
}

/**
 * Guard 终止原因
 */
export type GuardStopReason =
  | "max_iterations_exceeded"
  | "max_tokens_exceeded"
  | "max_consecutive_failures"
  | "manually_aborted";

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认 Loop Guard 配置
 *
 * 数值依据：
 * - maxIterations=50：覆盖大多数企业任务的迭代需求（autonomous 上限 1000）
 * - maxTokens=200000：约 GPT-4 上下文窗口的 50%，留余量给系统 prompt
 * - maxConsecutiveFailures=3：§5.2.3 连续 3 次同类失败 → HUMAN_CHECKPOINT
 * - initialBackoffMs=1000：首次失败后等待 1 秒
 * - maxBackoffMs=30000：退避上限 30 秒，避免过长等待
 * - backoffMultiplier=2.0：标准指数退避
 * - jitterRatio=0.1：±10% 随机抖动
 */
export const DEFAULT_LOOP_GUARD_CONFIG: Readonly<LoopGuardConfig> = Object.freeze({
  maxIterations: 50,
  maxTokens: 200_000,
  maxConsecutiveFailures: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2.0,
  jitterRatio: 0.1,
});

/**
 * 初始状态
 */
export const INITIAL_LOOP_GUARD_STATE: Readonly<LoopGuardState> = Object.freeze({
  iterationsCompleted: 0,
  tokensConsumed: 0,
  consecutiveFailures: 0,
  totalFailures: 0,
  backoffLevel: 0,
});

// ============================================================================
// LoopGuard 类
// ============================================================================

/**
 * Loop Guard 共享上限保护器
 *
 * 用法：
 * ```typescript
 * const guard = new LoopGuard({ maxIterations: 30, maxTokens: 100_000 });
 * while (true) {
 *   const check = guard.check();
 *   if (!check.allowed) {
 *     console.log(`Loop 终止：${check.stopReason}`);
 *     break;
 *   }
 *   if (check.suggestedWaitMs) {
 *     await sleep(check.suggestedWaitMs);
 *   }
 *   // 执行迭代...
 *   guard.recordIteration(tokensUsed, success);
 * }
 * ```
 *
 * 配置冻结保证（§5.12.4 G-A6d）：
 * - 构造函数接收配置后 Object.freeze 冻结，运行期不可修改
 * - maxIterations/maxTokens/maxConsecutiveFailures 对 LLM 只读
 * - 配置变更需退出 Loop 后重新构造 LoopGuard
 */
export class LoopGuard {
  /** 冻结的配置（运行期不可变） */
  private readonly config: Readonly<LoopGuardConfig>;
  /** 运行时状态（可变） */
  private state: LoopGuardState;
  /** 手动终止标志 */
  private manuallyAborted: boolean = false;

  /**
   * 构造 LoopGuard
   *
   * @param config 配置（缺省字段使用 DEFAULT_LOOP_GUARD_CONFIG）
   */
  constructor(config?: Partial<LoopGuardConfig>) {
    this.config = Object.freeze({
      ...DEFAULT_LOOP_GUARD_CONFIG,
      ...config,
    });
    this.state = { ...INITIAL_LOOP_GUARD_STATE };
  }

  /**
   * 检查是否允许继续执行
   *
   * 每次迭代前调用，返回当前状态和是否允许继续。
   *
   * 终止条件（按优先级）：
   * 1. 手动终止（manuallyAborted=true）
   * 2. 连续失败超上限（consecutiveFailures >= maxConsecutiveFailures）
   * 3. 迭代次数超上限（iterationsCompleted >= maxIterations）
   * 4. Token 预算耗尽（tokensConsumed >= maxTokens）
   *
   * @returns 检查结果
   */
  check(): GuardCheckResult {
    const remainingIterations = Math.max(0, this.config.maxIterations - this.state.iterationsCompleted);
    const remainingTokens = Math.max(0, this.config.maxTokens - this.state.tokensConsumed);

    // 1. 手动终止
    if (this.manuallyAborted) {
      return {
        allowed: false,
        stopReason: "manually_aborted",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 2. 连续失败超上限
    if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      return {
        allowed: false,
        stopReason: "max_consecutive_failures",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 3. 迭代次数超上限
    if (this.state.iterationsCompleted >= this.config.maxIterations) {
      return {
        allowed: false,
        stopReason: "max_iterations_exceeded",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 4. Token 预算耗尽
    if (this.state.tokensConsumed >= this.config.maxTokens) {
      return {
        allowed: false,
        stopReason: "max_tokens_exceeded",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 允许继续——计算退避建议（有失败记录时）
    const suggestedWaitMs = this.calculateBackoff();
    return {
      allowed: true,
      suggestedWaitMs: suggestedWaitMs > 0 ? suggestedWaitMs : undefined,
      state: { ...this.state },
      remainingIterations,
      remainingTokens,
    };
  }

  /**
   * 记录一次迭代完成
   *
   * 每次迭代结束后调用，更新消耗计数。
   *
   * @param tokensUsed 本次迭代消耗的 Token 数
   * @param success 本次迭代是否成功（评估器 verdict=pass）
   */
  recordIteration(tokensUsed: number, success: boolean): void {
    this.state.iterationsCompleted++;
    this.state.tokensConsumed += tokensUsed;
    if (success) {
      // 成功——重置连续失败计数
      this.state.consecutiveFailures = 0;
      this.state.backoffLevel = 0;
    } else {
      // 失败——递增失败计数
      this.state.consecutiveFailures++;
      this.state.totalFailures++;
      this.state.lastFailureTime = new Date().toISOString();
      this.state.backoffLevel++;
    }
  }

  /**
   * 手动终止
   *
   * 对外暴露的终止接口，供 /eag-autonomous --stop 调用（§5.12.4 G-A6b）。
   */
  abort(): void {
    this.manuallyAborted = true;
  }

  /**
   * 获取当前状态快照（只读）
   */
  getState(): Readonly<LoopGuardState> {
    return { ...this.state };
  }

  /**
   * 获取配置（只读，冻结）
   */
  getConfig(): Readonly<LoopGuardConfig> {
    return this.config;
  }

  /**
   * 计算退避等待时间
   *
   * 指数退避 + jitter 策略：
   * - 基础延迟 = initialBackoffMs * (backoffMultiplier ^ backoffLevel)
   * - 上限截断 = min(baseDelay, maxBackoffMs)
   * - Jitter = baseDelay * jitterRatio * (random * 2 - 1)  // ±jitterRatio 范围
   * - 最终延迟 = max(0, truncated + jitter)
   *
   * @returns 建议等待毫秒数（0 表示无需等待）
   */
  private calculateBackoff(): number {
    if (this.state.backoffLevel === 0) {
      return 0; // 无失败记录，无需等待
    }

    // 指数退避基础延迟
    const baseDelay =
      this.config.initialBackoffMs * Math.pow(this.config.backoffMultiplier, this.state.backoffLevel - 1);

    // 上限截断
    const truncatedDelay = Math.min(baseDelay, this.config.maxBackoffMs);

    // Jitter（±jitterRatio 范围的随机抖动）
    const jitterRange = truncatedDelay * this.config.jitterRatio;
    const jitter = jitterRange * (Math.random() * 2 - 1);

    return Math.max(0, Math.round(truncatedDelay + jitter));
  }
}
