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
// 需求123/124：普通会话循环护栏配置（2026-10-17）
// ============================================================================

/**
 * 普通会话（交互式 chat）循环护栏配置
 *
 * 与 EAG 场景的 LoopGuardConfig 分离：EAG 场景触达上限直接终止；
 * 普通会话触达 maxTurns/连续失败 时暂停并咨询用户（需求124 预期：
 * "反复处理无果后（同一请求拨通3-5次），咨询用户是否继续"）。
 *
 * Token 预算护栏已移除（2026-10-19 需求变更）：
 * 上下文压力改由"自动压缩 + 新任务切新上下文"策略接管——
 * - 上下文不足（activeTokens 超阈值）→ 自动 compactSession（session.ts 主循环既有逻辑）
 * - 新任务（LLM 意图分类判定）→ 归档旧上下文直接切换（replySession 入口）
 * 因此 TurnGuard 不再设置 Token 硬终止线，tokensConsumed 仅作状态观测保留。
 *
 * 模型循环检测（2026-10-19 新增）：
 * 跟踪最近 N 次 tool 调用签名（tool name + 简化参数 hash），
 * 当连续 maxRepeatedToolCalls 次调用相同工具 + 相同参数 → 自动终止，
 * 防止模型陷入"同一命令反复重试"的死循环烧 Token。
 */
export interface TurnGuardConfig {
  /** 单 turn 最大 LLM 迭代轮数（默认 40，需求123 反馈"40 轮内未解决"即咨询） */
  maxTurns: number;
  /** 连续工具全失败轮数上限（默认 3，需求124"同一请求拨通3-5次"下限） */
  maxConsecutiveFailedTurns: number;
  /**
   * 循环检测：连续多少次调用相同工具+相同参数即判定为模型死循环（默认 3）。
   * 设为 0 禁用循环检测。
   */
  maxRepeatedToolCalls: number;
  /**
   * 循环检测：跟踪最近多少次 tool 调用的签名（默认 5）。
   * 越大检测越准但内存开销略增。
   */
  trackedToolCallHistory: number;
}

/**
 * 默认循环护栏配置（需求123/124 + 2026-10-19 模型循环检测）
 *
 * 数值依据：
 * - maxTurns=40：需求123 反馈的期望轮次——正常任务 40 轮内可完成，
 *   超出即说明执行受阻，应停下来问用户而不是继续烧 Token
 * - maxConsecutiveFailedTurns=3：需求124 下限——连续 3 轮工具调用全部失败
 *   即判定"反复处理无果"，暂停咨询
 * - maxRepeatedToolCalls=3：同一工具 + 相同参数连续调用 3 次 → 模型死循环
 * - trackedToolCallHistory=5：跟踪最近 5 次 tool 调用签名
 */
export const DEFAULT_TURN_GUARD_CONFIG: Readonly<TurnGuardConfig> = Object.freeze({
  maxTurns: 40,
  maxConsecutiveFailedTurns: 3,
  maxRepeatedToolCalls: 3,
  trackedToolCallHistory: 5,
});

/**
 * 循环护栏触发的暂停动作类型（需求123/124 + 2026-10-19 模型循环检测）
 */
export type LoopGuardAction =
  /** 连续工具全失败达上限 → 暂停咨询用户（可恢复） */
  | "consult_user_consecutive_failures"
  /** 迭代轮数达上限 → 暂停咨询用户（可恢复） */
  | "consult_user_max_turns"
  /** 模型死循环（同一工具+参数重复调用）→ 直接终止（不可恢复） */
  | "terminate_model_loop";

/**
 * 循环护栏判定结果（需求123/124）
 */
export interface LoopGuardTurnDecision {
  /** 是否允许本轮迭代继续执行 */
  allow: boolean;
  /** 触发动作（allow=false 时必填） */
  action?: LoopGuardAction;
  /** 人类可读的暂停/终止原因（供注入 system 消息或通知用户） */
  reason: string;
}

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
   * 用户确认后重置连续失败计数（需求123/124 修复）
   *
   * 场景：普通会话执行中连续 N 次工具失败，Guard 判定 max_consecutive_failures
   * 暂停后向用户提问"是否继续"。用户选择继续时调用本方法：
   * - 连续失败计数清零（保留 totalFailures 总量，审计可追溯）
   * - 退避级别清零（避免继续后立即再次触发退避）
   *
   * 注意：不重置 iterationsCompleted / tokensConsumed——总预算约束不因
   * 用户放行而放宽，仅解除"连续失败熔断"这一条熔断线。
   */
  acknowledgeUserContinuation(): void {
    this.state.consecutiveFailures = 0;
    this.state.backoffLevel = 0;
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

// ============================================================================
// TurnGuard：普通会话循环护栏（需求123/124，2026-10-17）
// ============================================================================

/**
 * 普通会话循环护栏
 *
 * 解决的问题（需求123/124）：
 * - 需求123：复杂任务执行陷入死循环，40 轮内无法解决时终端无输出、进程异常关闭
 * - 需求124：反复重试直到 Token 耗尽（dev 阶段 41 次 LLM 请求）会话异常退出
 *
 * 与 LoopGuard（EAG 场景）的差异：
 * - LoopGuard：触达上限直接终止（自主长程任务无人值守）
 * - TurnGuard：触达轮数/连续失败上限时**暂停咨询用户**（交互式会话有人值守），
 *   用户确认后 acknowledgeAndContinue() 清零本轮计数继续执行；
 *   Token 预算硬终止线已移除（2026-10-19）——上下文压力由
 *   "自动压缩 + 新任务切新上下文"策略接管，tokensConsumed 仅作状态观测
 *
 * 用法（session.ts activateSession 主循环）：
 * ```typescript
 * const guard = new TurnGuard();               // 每 turn 新建，跨 turn 不累计
 * for (let iteration = 0; ; iteration++) {
 *   const decision = guard.decideBeforeIteration();
 *   if (!decision.allow) { ...咨询用户/终止... }
 *   // LLM 调用 + 工具执行
 *   guard.recordTurn({ tokensUsed, allToolsFailed, hadToolCalls });
 * }
 * // 用户确认继续：
 * guard.acknowledgeAndContinue();
 * ```
 *
 * 配置冻结保证同 LoopGuard（§5.12.4 G-A6d）：LLM 在循环内不可自改上限。
 */
export class TurnGuard {
  /** 冻结的配置（运行期不可变） */
  private readonly config: Readonly<TurnGuardConfig>;
  /** 本 turn 已完成的 LLM 迭代轮数 */
  private turnsCompleted = 0;
  /** 本 turn 累计消耗 Token（所有 LLM 请求的 total_tokens 之和） */
  private tokensConsumed = 0;
  /** 连续"工具调用全部失败"的轮数（任一轮有成功工具即清零） */
  private consecutiveFailedTurns = 0;

  /**
   * 最近 N 次 tool 调用签名队列（2026-10-19 新增，模型循环检测）。
   * 每个签名是 `toolName + "|" + argsHash` 的字符串。
   * 当队列尾部连续 maxRepeatedToolCalls 条签名相同 → 判定为死循环。
   */
  private readonly toolCallSignatures: string[] = [];

  /**
   * 构造 TurnGuard
   *
   * @param config 配置（缺省字段使用 DEFAULT_TURN_GUARD_CONFIG）
   */
  constructor(config?: Partial<TurnGuardConfig>) {
    this.config = Object.freeze({
      ...DEFAULT_TURN_GUARD_CONFIG,
      ...config,
    });
  }

  /**
   * 简化参数为签名哈希（用于模型循环检测）
   *
   * 提取规则：JSON.stringify 后截取前 200 字符 + 长度后缀。
   * 目的：相同语义的参数产生相同签名，微小差异（如空格、数字精度变化）不影响检测。
   *
   * @param args 原始 tool call 参数（任意可 JSON 序列化的对象）
   * @returns 签名字符串（200 字符内 + 长度标记）
   */
  private static hashToolArgs(args: unknown): string {
    if (args === null || args === undefined) return "";
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = String(args);
    }
    // 截取前 200 字符 + 总长度后缀，平衡精度与抗噪声
    const prefix = serialized.length > 200 ? serialized.slice(0, 200) : serialized;
    return `${prefix}#${serialized.length}`;
  }

  /**
   * 记录一次 tool 调用（用于循环检测，2026-10-19 新增）
   *
   * 每轮迭代结束后调用（recordTurn 之后），把本次 LLM 响应中的所有
   * tool call 签名追加到队列头部，超出门槛时从尾部丢弃。
   *
   * @param toolCalls 本轮 LLM 响应中的 tool call 数组（每元素含 name 和 arguments）
   */
  recordToolCalls(toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments?: unknown }>): void {
    if (!toolCalls || toolCalls.length === 0) return;
    const maxHistory = this.config.trackedToolCallHistory;
    for (const tc of toolCalls) {
      const sig = `${tc.name}|${TurnGuard.hashToolArgs(tc.arguments)}`;
      this.toolCallSignatures.push(sig);
      // 超出门槛时从尾部丢弃（保持最近 N 次）
      while (this.toolCallSignatures.length > maxHistory) {
        this.toolCallSignatures.shift();
      }
    }
  }

  /**
   * 检查模型是否陷入死循环（连续相同工具+参数调用，2026-10-19 新增）
   *
   * 判定规则：
   * 1. maxRepeatedToolCalls > 0（循环检测未禁用）
   * 2. toolCallSignatures 长度 >= maxRepeatedToolCalls
   * 3. 尾部连续 maxRepeatedToolCalls 条签名完全相同
   *
   * @returns 是否检测到模型死循环
   */
  private detectModelLoop(): boolean {
    const { maxRepeatedToolCalls } = this.config;
    if (maxRepeatedToolCalls <= 0) return false;
    if (this.toolCallSignatures.length < maxRepeatedToolCalls) return false;
    const tail = this.toolCallSignatures.slice(-maxRepeatedToolCalls);
    // 所有尾部签名必须相同
    return tail.every((s) => s === tail[0]);
  }

  /**
   * 获取循环检测信息（供判定 reason 详细展示）
   *
   * @returns { toolName, repeatCount } 或 null（未检测到循环）
   */
  private getLoopInfo(): { toolName: string; repeatCount: number } | null {
    if (!this.detectModelLoop()) return null;
    const lastSig = this.toolCallSignatures[this.toolCallSignatures.length - 1];
    const toolName = lastSig.split("|")[0];
    const repeatCount = this.config.maxRepeatedToolCalls;
    return { toolName, repeatCount };
  }

  /**
   * 每轮 LLM 迭代开始前判定是否允许继续
   *
   * 判定优先级（需求123/124 + 2026-10-19 模型循环检测）：
   * 1. 模型死循环 → terminate_model_loop（硬终止，不可恢复）
   * 2. 连续工具全失败 ≥ 上限 → consult_user_consecutive_failures（暂停咨询）
   * 3. 迭代轮数 ≥ 上限 → consult_user_max_turns（暂停咨询）
   *
   * Token 预算硬终止线已移除（2026-10-19）：上下文压力由
   * "自动压缩 + 新任务切新上下文"策略接管，不再按 Token 配额终止会话。
   *
   * @returns 判定结果（allow=false 时 reason 可直接展示给用户）
   */
  decideBeforeIteration(): LoopGuardTurnDecision {
    // 1. 模型死循环检测（2026-10-19 新增：最高优先级，防止反复烧 Token）
    const loopInfo = this.getLoopInfo();
    if (loopInfo) {
      return {
        allow: false,
        action: "terminate_model_loop",
        reason:
          `检测到模型死循环：工具 "${loopInfo.toolName}" 连续 ${loopInfo.repeatCount} 次以相同参数被调用。` +
          `任务自动终止，请调整指令后重新开始。`,
      };
    }

    // 2. 连续工具全失败（需求124："同一请求拨通3-5次后咨询用户"）
    if (this.consecutiveFailedTurns >= this.config.maxConsecutiveFailedTurns) {
      return {
        allow: false,
        action: "consult_user_consecutive_failures",
        reason: `已连续 ${this.consecutiveFailedTurns} 轮工具调用全部失败，继续重试大概率无法自行解决。`,
      };
    }

    // 3. 迭代轮数上限（需求123："40 轮内未解决"）
    if (this.turnsCompleted >= this.config.maxTurns) {
      return {
        allow: false,
        action: "consult_user_max_turns",
        reason: `已执行 ${this.turnsCompleted} 轮迭代仍未得出结论，可能陷入循环或任务过于复杂。`,
      };
    }

    return { allow: true, reason: "" };
  }

  /**
   * 记录一轮迭代结果（LLM 响应 + 工具执行完成后调用）
   *
   * @param result.tokensUsed 本轮 LLM 请求消耗 Token（total_tokens）
   * @param result.hadToolCalls 本轮响应是否包含工具调用
   * @param result.allToolsFailed 本轮工具调用是否全部失败（无工具调用时忽略）
   */
  recordTurn(result: { tokensUsed: number; hadToolCalls: boolean; allToolsFailed: boolean }): void {
    this.turnsCompleted++;
    this.tokensConsumed += Math.max(0, result.tokensUsed);
    if (result.hadToolCalls) {
      if (result.allToolsFailed) {
        this.consecutiveFailedTurns++;
      } else {
        // 任一工具成功 → 清零连续失败计数（问题在推进，不算拨通无果）
        this.consecutiveFailedTurns = 0;
      }
    }
    // 无工具调用（最终回复轮）不影响连续失败计数——主循环在本轮后即 return
  }

  /**
   * 用户确认继续后清零咨询触发计数（需求124 咨询-确认闭环）
   *
   * 清零 consecutiveFailedTurns / turnsCompleted（各自给用户新的预算窗口）。
   * tokensConsumed 保留——仅作状态观测（Token 硬终止线已移除，2026-10-19）。
   */
  acknowledgeAndContinue(): void {
    this.consecutiveFailedTurns = 0;
    this.turnsCompleted = 0;
  }

  /** 当前状态快照（供审计/展示） */
  getState(): Readonly<{
    turnsCompleted: number;
    tokensConsumed: number;
    consecutiveFailedTurns: number;
  }> {
    return {
      turnsCompleted: this.turnsCompleted,
      tokensConsumed: this.tokensConsumed,
      consecutiveFailedTurns: this.consecutiveFailedTurns,
    };
  }

  /** 获取配置（只读，冻结） */
  getConfig(): Readonly<TurnGuardConfig> {
    return this.config;
  }
}
