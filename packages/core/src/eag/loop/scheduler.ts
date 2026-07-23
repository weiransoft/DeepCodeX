/**
 * Loop Engineering Scheduling 阶段（TypeScript 移植版）
 *
 * 基于当前迭代状态、验证结果、Memory 历史、Token 预算，
 * 决定 Loop 下一步动作：CONTINUE / FIX / HUMAN_CHECKPOINT / STOP_SUCCESS / STOP_FAILURE。
 *
 * 移植来源：multi-agent-team skill scripts/loop_engineering/loop_scheduler.py
 *
 * 决策逻辑（任务规格，对齐 EAG 方案 §5.2.1 五步闭环上限保护 +
 * §5.2.3 CODING Loop 失败处理"连续 3 次同类失败 → HUMAN_CHECKPOINT"）：
 *
 * 优先级（从高到低）：
 * 1. Token 预算硬上限：cumulativeTokens >= maxTokens → STOP_FAILURE
 * 2. 最大迭代次数硬上限：currentIter+1 >= maxIterations
 *    - verdict.passed=true → STOP_SUCCESS（最后一轮通过）
 *    - verdict.passed=false → STOP_FAILURE
 * 3. 验证通过（verdict.passed=true）：
 *    - 满足 stop_when 停止条件 → STOP_SUCCESS
 *    - 否则 → CONTINUE
 * 4. 验证未通过（verdict.passed=false）：
 *    - consecutiveFailures+1 >= 5 → STOP_FAILURE（连续失败超上限）
 *    - consecutiveFailures+1 >= 3 → HUMAN_CHECKPOINT（连续失败需人工介入）
 *    - 否则 → FIX
 *
 * 设计原则：
 * - 保守停止：遇到硬上限（max_iterations / max_tokens / 连续失败）必须停止
 * - 人类检查点：连续 3 次同类失败触发，避免 Cognitive Surrender
 * - 动态修复：验证未通过时优先 FIX，但超过尝试次数后升级为 HUMAN_CHECKPOINT / STOP_FAILURE
 *
 * 退避策略（computeBackoff）：
 * - 指数退避 + jitter（与 LoopGuard.calculateBackoff 算法对齐，但作为独立实现，
 *   避免对 LoopGuard 运行时状态的耦合——LoopGuard 的退避基于内部 backoffLevel，
 *   本调度器接收外部 consecutiveFailures 参数）
 *
 * @module eag/loop/scheduler
 */

import type {
  LoopEngineeringConfig,
  LoopEvent,
  LogCallback,
  LoopEvaluationVerdict,
  SchedulingAction,
  SchedulingDecision,
} from "./models";

// ============================================================================
// 常量
// ============================================================================

/**
 * 连续失败 → HUMAN_CHECKPOINT 阈值（EAG 方案 §5.2.3）
 *
 * 当连续失败次数（含当前轮）达到此值时，触发人类检查点。
 */
export const CONSECUTIVE_FAILURES_HUMAN_CHECKPOINT_THRESHOLD = 3;

/**
 * 连续失败 → STOP_FAILURE 阈值
 *
 * 当连续失败次数（含当前轮）达到此值时，终止 Loop。
 * 注意：此值必须 >= CONSECUTIVE_FAILURES_HUMAN_CHECKPOINT_THRESHOLD，
 * 否则 HUMAN_CHECKPOINT 永远不会触发。
 */
export const CONSECUTIVE_FAILURES_STOP_FAILURE_THRESHOLD = 5;

/**
 * 默认退避基础延迟（秒，对应 Python `extra.backoff_base_sec` 默认值）
 */
export const DEFAULT_BACKOFF_BASE_SEC = 1.0;

/**
 * 默认退避最大延迟（秒，对应 Python `extra.backoff_max_sec` 默认值）
 */
export const DEFAULT_BACKOFF_MAX_SEC = 60.0;

/**
 * 默认 jitter 比例（±10% 随机抖动，对齐 LoopGuard 默认值）
 */
export const DEFAULT_BACKOFF_JITTER_RATIO = 0.1;

/**
 * 默认值：stopWhen 为空字符串时是否视为"通过即停止"
 *
 * - true（默认）：对齐 eag/loop/ 母本语义，空 stopWhen 时单轮通过即 STOP_SUCCESS
 * - false：对齐 P5 语义，空 stopWhen 时不停止，依赖调用方自行判定完成条件
 *
 * 通过 config.extra.stop_when_empty_means_stop 可覆盖默认值（向后兼容）。
 */
export const DEFAULT_STOP_WHEN_EMPTY_MEANS_STOP = true;

/**
 * stop_when 关键词列表（用于朴素匹配，未来可替换为 LLM 语义判断）
 *
 * 当 config.stopWhen 包含任一关键词时，若最近轮次验证通过则视为满足停止条件。
 */
const STOP_WHEN_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "完成",
  "通过",
  "成功",
  "done",
  "passed",
  "completed",
]);

// ============================================================================
// LoopScheduler 类
// ============================================================================

/**
 * Loop 调度器：决定下一循环动作
 *
 * 使用方式：
 * ```typescript
 * const scheduler = new LoopScheduler(config);
 * const decision = scheduler.decideNext(
 *   currentIter,
 *   verdict,
 *   memoryEvents,
 *   cumulativeTokens,
 *   consecutiveFailures
 * );
 * if (decision.action === "fix" || decision.action === "continue") {
 *   const backoff = scheduler.computeBackoff(consecutiveFailures);
 *   // 等待 backoff 秒后进入下一轮
 * }
 * ```
 *
 * 配置冻结保证：构造时 Object.freeze 冻结配置引用，运行期不可修改。
 */
export class LoopScheduler {
  /** 冻结的配置引用（运行期不可变） */
  private readonly config: Readonly<LoopEngineeringConfig>;
  /** 日志回调函数（null 表示不输出日志） */
  private readonly log: LogCallback;
  /**
   * 可配置：连续失败 → HUMAN_CHECKPOINT 阈值
   *
   * 从 config.extra.consecutive_failures_human_checkpoint 读取，
   * 缺省时使用 CONSECUTIVE_FAILURES_HUMAN_CHECKPOINT_THRESHOLD（向后兼容）。
   *
   * P5 集成时注入 P5 的 consecutiveFailureAbort 值，使 scheduler 阈值与 P5 一致。
   */
  private readonly humanCheckpointThreshold: number;
  /**
   * 可配置：连续失败 → STOP_FAILURE 阈值
   *
   * 从 config.extra.consecutive_failures_stop_failure 读取，
   * 缺省时使用 CONSECUTIVE_FAILURES_STOP_FAILURE_THRESHOLD（向后兼容）。
   *
   * P5 集成时注入 consecutiveFailureAbort + 1，确保 STOP_FAILURE 在 HUMAN_CHECKPOINT 之后触发。
   */
  private readonly stopFailureThreshold: number;
  /**
   * 可配置：stopWhen 为空字符串时是否视为"通过即停止"
   *
   * 从 config.extra.stop_when_empty_means_stop 读取，
   * 缺省时使用 DEFAULT_STOP_WHEN_EMPTY_MEANS_STOP=true（向后兼容）。
   *
   * P5 集成时传入 false，对齐 P5 的"空 stopWhen 不停止"语义。
   */
  private readonly stopWhenEmptyMeansStop: boolean;

  /**
   * 构造调度器
   *
   * @param config Loop Engineering 配置（应通过 createLoopEngineeringConfig 工厂函数创建并冻结）
   * @param log 日志回调函数（可选，null 表示不输出日志）
   */
  constructor(config: Readonly<LoopEngineeringConfig>, log: LogCallback = null) {
    this.config = config;
    this.log = log;
    // 从 config.extra 读取可配置阈值（向后兼容：缺省时使用硬编码默认值）
    this.humanCheckpointThreshold = this.readExtraNumber(
      "consecutive_failures_human_checkpoint",
      CONSECUTIVE_FAILURES_HUMAN_CHECKPOINT_THRESHOLD
    );
    this.stopFailureThreshold = this.readExtraNumber(
      "consecutive_failures_stop_failure",
      CONSECUTIVE_FAILURES_STOP_FAILURE_THRESHOLD
    );
    this.stopWhenEmptyMeansStop = this.readExtraBoolean(
      "stop_when_empty_means_stop",
      DEFAULT_STOP_WHEN_EMPTY_MEANS_STOP
    );
  }

  /**
   * 输出 INFO 级别日志
   *
   * @param message 日志消息
   */
  private info(message: string): void {
    if (this.log) {
      this.log(message, "INFO");
    }
  }

  /**
   * 决定下一步动作
   *
   * 决策优先级（从高到低）：
   * 1. Token 预算硬上限（max_tokens）
   * 2. 最大迭代次数硬上限（max_iterations）
   * 3. 验证结果驱动（通过 → 检查停止条件；未通过 → FIX/HUMAN_CHECKPOINT/STOP_FAILURE）
   *
   * @param currentIter 当前迭代索引（从 0 开始）
   * @param verdict 本轮独立 Evaluator 判定结果
   * @param memoryEvents 历史事件列表（供 stop_when 关键词匹配）
   * @param cumulativeTokens 累计 token 消耗估算
   * @param consecutiveFailures 当前连续失败次数（不含本轮，本轮若失败由调用方在 decideNext 后 +1）
   * @returns 调度决策
   */
  decideNext(
    currentIter: number,
    verdict: LoopEvaluationVerdict,
    memoryEvents: ReadonlyArray<LoopEvent>,
    cumulativeTokens: number,
    consecutiveFailures: number = 0
  ): SchedulingDecision {
    // 1. Token 预算硬上限（最高优先级，无视验证结果）
    if (cumulativeTokens >= this.config.maxTokens) {
      this.info(`Token 预算耗尽：${cumulativeTokens} >= ${this.config.maxTokens}`);
      return this.makeDecision("stop_failure", `Token 预算耗尽：${cumulativeTokens} >= ${this.config.maxTokens}`);
    }

    // 2. 最大迭代次数硬上限
    if (currentIter + 1 >= this.config.maxIterations) {
      if (verdict.passed) {
        this.info(`达到最大迭代次数 ${this.config.maxIterations}，最后一轮通过`);
        return this.makeDecision("stop_success", `达到最大迭代次数 ${this.config.maxIterations}，最后一轮通过`);
      }
      this.info(`达到最大迭代次数 ${this.config.maxIterations} 且验证未通过`);
      return this.makeDecision("stop_failure", `达到最大迭代次数 ${this.config.maxIterations} 且验证未通过`);
    }

    // 3. 验证结果驱动
    if (verdict.passed) {
      // 3a. 检查是否满足自然语言停止条件
      if (this.shouldStopWhen(memoryEvents)) {
        this.info("满足停止条件，正常结束 Loop");
        return this.makeDecision("stop_success", "满足停止条件");
      }
      // 3b. 否则继续下一轮
      this.info("验证通过，继续下一轮");
      return this.makeDecision("continue", "验证通过，继续下一轮");
    }

    // 4. 验证未通过 → 按连续失败次数升级处理
    // consecutiveFailures+1 表示包含本轮失败的等效失败次数
    // 阈值从 config.extra 读取（可配置），缺省时使用硬编码默认值（向后兼容）
    const effectiveFailures = consecutiveFailures + 1;
    if (effectiveFailures >= this.stopFailureThreshold) {
      this.info(`连续失败 ${effectiveFailures} 次，终止 Loop`);
      return this.makeDecision("stop_failure", `连续失败 ${effectiveFailures} 次，终止 Loop`);
    }
    if (effectiveFailures >= this.humanCheckpointThreshold) {
      this.info(`连续失败 ${effectiveFailures} 次，触发人类检查点`);
      return this.makeDecision("human_checkpoint", `连续失败 ${effectiveFailures} 次，需要人类确认`, true);
    }

    // 4b. 失败次数未达阈值 → 进入修复阶段
    this.info(`验证未通过：${verdict.reason}，进入修复阶段`);
    return this.makeDecision("fix", `验证未通过：${verdict.reason}`);
  }

  /**
   * 计算修复前的退避时间（秒）
   *
   * 指数退避 + jitter 策略（与 LoopGuard.calculateBackoff 算法对齐）：
   * - 基础延迟 = backoff_base_sec * (2 ^ consecutiveFailures)
   * - 上限截断 = min(baseDelay, backoff_max_sec)
   * - Jitter = truncatedDelay * jitterRatio * (random * 2 - 1)  // ±jitterRatio 范围
   * - 最终延迟 = max(0, truncated + jitter)
   *
   * 参数来源（按优先级从高到低）：
   * 1. config.extra.backoff_base_sec / backoff_max_sec（用户自定义）
   * 2. DEFAULT_BACKOFF_BASE_SEC / DEFAULT_BACKOFF_MAX_SEC（内置默认值）
   *
   * jitterRatio 固定为 DEFAULT_BACKOFF_JITTER_RATIO（与 LoopGuard 默认值对齐），
   * 未来如需可配置可从 config.extra 读取。
   *
   * @param consecutiveFailures 连续失败次数
   * @returns 退避秒数（>= 0）
   */
  computeBackoff(consecutiveFailures: number): number {
    // 读取可配置参数（从 config.extra 读取，缺省时使用默认值）
    const base = this.readExtraNumber("backoff_base_sec", DEFAULT_BACKOFF_BASE_SEC);
    const maxBackoff = this.readExtraNumber("backoff_max_sec", DEFAULT_BACKOFF_MAX_SEC);
    const jitterRatio = this.readExtraNumber("backoff_jitter_ratio", DEFAULT_BACKOFF_JITTER_RATIO);

    // 无失败记录：无需退避
    if (consecutiveFailures <= 0) {
      return 0.0;
    }

    // 指数退避基础延迟：base * 2^consecutiveFailures
    const baseDelay = base * Math.pow(2, consecutiveFailures);

    // 上限截断
    const truncatedDelay = Math.min(baseDelay, maxBackoff);

    // Jitter（±jitterRatio 范围的随机抖动，避免惊群）
    const jitterRange = truncatedDelay * jitterRatio;
    const jitter = jitterRange * (Math.random() * 2 - 1);

    // 最终延迟（不低于 0）
    return Math.max(0.0, truncatedDelay + jitter);
  }

  /**
   * 判断是否满足自然语言停止条件（对应 Python _should_stop_when）
   *
   * 简化策略：
   * 1. 无显式 stop_when（空字符串）：默认 pass 即视为目标达成 → 返回 true
   *    （对齐任务规格 K1"单轮通过即停止"语义：未配置 stop_when 时单轮通过即停止）
   * 2. 有显式 stop_when 且包含完成类关键词（完成/通过/成功/done/passed/completed）：
   *    检查最近 3 个事件中是否有 verification_passed，有则返回 true
   * 3. 有显式 stop_when 但不含完成类关键词：暂不停止，继续迭代
   *    （待 LLM 语义判断落地后扩展）
   *
   * @param memoryEvents 历史事件列表
   * @returns 是否满足停止条件
   */
  private shouldStopWhen(memoryEvents: ReadonlyArray<LoopEvent>): boolean {
    // 1. 无显式 stop_when：根据 stopWhenEmptyMeansStop 配置决定行为
    // - true（默认，对齐 eag/loop/ 母本）：空 stopWhen 时单轮通过即 STOP_SUCCESS
    // - false（P5 集成用）：空 stopWhen 时不停止，依赖调用方自行判定完成条件
    if (!this.config.stopWhen) {
      return this.stopWhenEmptyMeansStop;
    }

    // 2. 基于关键词的朴素匹配（未来可替换为 LLM 语义判断）
    const stopWhenLower = this.config.stopWhen.toLowerCase();
    const hasStopKeyword = STOP_WHEN_KEYWORDS.some((kw) => stopWhenLower.includes(kw));
    if (hasStopKeyword) {
      // stop_when 包含完成类词汇，且最近一轮验证通过 → 满足停止条件
      const recentEvents = memoryEvents.slice(-3);
      return recentEvents.some((e) => e.eventType === "verification_passed");
    }

    // 3. stop_when 不包含完成类词汇：暂不停止
    return false;
  }

  /**
   * 从 config.extra 读取数值参数（带类型守卫）
   *
   * @param key extra 中的字段名
   * @param defaultValue 缺省值（当字段不存在或类型不符时使用）
   * @returns 读取到的数值
   */
  private readExtraNumber(key: string, defaultValue: number): number {
    const raw = this.config.extra[key];
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      return raw;
    }
    return defaultValue;
  }

  /**
   * 从 config.extra 读取布尔参数（带类型守卫）
   *
   * @param key extra 中的字段名
   * @param defaultValue 缺省值（当字段不存在或类型不符时使用）
   * @returns 读取到的布尔值
   */
  private readExtraBoolean(key: string, defaultValue: boolean): boolean {
    const raw = this.config.extra[key];
    if (typeof raw === "boolean") {
      return raw;
    }
    return defaultValue;
  }

  /**
   * 构造 SchedulingDecision（简化工厂方法）
   *
   * @param action 决策动作
   * @param reason 决策理由
   * @param requiresHumanInput 是否需要人类输入（默认 false）
   * @returns SchedulingDecision 实例
   */
  private makeDecision(
    action: SchedulingAction,
    reason: string,
    requiresHumanInput: boolean = false
  ): SchedulingDecision {
    return {
      action,
      reason,
      nextLoopType: null,
      nextStageOrder: null,
      backoffSeconds: 0.0,
      requiresHumanInput,
    };
  }
}
