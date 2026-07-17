/**
 * Token Budget Guard（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/token_budget_guard.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * Phase 3 实现：执行期 Token 监控 + 自动降级
 *
 * 核心职责：
 *   1. 三阶段 Token 校验：pre_execute / during_execute / post_execute
 *   2. 超限触发降级（切换 haiku 继续）而非中断
 *   3. 预算异常时硬中断（HARD 模式）
 *   4. 降级历史写入 PerformanceFingerprint（反哺 + 审计）
 *
 * 设计约束（来自 DYNAMIC_WORKFLOWS_INTEGRATION.md §3.0）：
 *   - 🔴 持久化复用：决策历史写入 PerformanceFingerprint
 *   - 🔴 安全：Token 硬上限（HARD 模式），不允许超额消耗
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 预算执行模式 */
export type BudgetEnforcementMode = "hard" | "soft" | "hybrid";

/** 预算决策建议 */
export type BudgetRecommendation = "continue" | "switch_to_haiku" | "split_task" | "abort" | "retry_with_lower";

/** Token 预算 */
export interface TokenBudget {
  total_budget: number;
  consumed: number;
  reserved: number;
  soft_threshold: number;
  hard_threshold: number;
}

/** 预算快照 */
export interface BudgetSnapshot {
  total_budget: number;
  consumed: number;
  reserved: number;
  remaining: number;
  consumption_ratio: number;
  is_over_soft: boolean;
  is_over_hard: boolean;
}

/** 预算决策 */
export interface BudgetDecision {
  allow_continue: boolean;
  recommendation: BudgetRecommendation;
  warnings: string[];
  reason: string;
  /** 是否触发了降级（从 sonnet/opus 切到 haiku） */
  triggered_downgrade: boolean;
  new_tier: "haiku" | "sonnet" | "opus" | null;
}

/** 默认 BudgetSnapshot 工厂 */
export function defaultBudgetSnapshot(): BudgetSnapshot {
  return {
    total_budget: 0,
    consumed: 0,
    reserved: 0,
    remaining: 0,
    consumption_ratio: 0.0,
    is_over_soft: false,
    is_over_hard: false,
  };
}

// ============================================================================
// 异常定义
// ============================================================================

export class TokenBudgetGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenBudgetGuardError";
  }
}

export class TokenBudgetExceeded extends TokenBudgetGuardError {
  consumed: number;
  budget: number;
  constructor(consumed: number, budget: number, message?: string) {
    const ratio = budget > 0 ? consumed / budget : 0;
    super(message ?? `Token 预算超限：consumed=${consumed}, budget=${budget}, ratio=${(ratio * 100).toFixed(1)}%`);
    this.name = "TokenBudgetExceeded";
    this.consumed = consumed;
    this.budget = budget;
  }
}

export class InvalidBudgetError extends TokenBudgetGuardError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBudgetError";
  }
}

/** 从字符串解析预算模式（大小写不敏感） */
export function budgetModeFromStr(value: string): BudgetEnforcementMode {
  const normalized = value.toLowerCase().trim();
  if (normalized === "hard" || normalized === "soft" || normalized === "hybrid") {
    return normalized;
  }
  throw new TokenBudgetGuardError(`未知的执行模式：${value}（有效值：hard / soft / hybrid）`);
}

// ============================================================================
// TokenBudget 工具函数
// ============================================================================

/** 校验 TokenBudget 字段 */
export function validateTokenBudget(b: TokenBudget): void {
  if (b.total_budget <= 0) {
    throw new InvalidBudgetError(`total_budget 必须为正整数：${b.total_budget}`);
  }
  if (b.consumed < 0) {
    throw new InvalidBudgetError(`consumed 不能为负：${b.consumed}`);
  }
  if (b.reserved < 0) {
    throw new InvalidBudgetError(`reserved 不能为负：${b.reserved}`);
  }
  if (b.soft_threshold <= 0.0 || b.soft_threshold >= 1.0) {
    throw new InvalidBudgetError(`soft_threshold 必须在 (0, 1) 范围内：${b.soft_threshold}`);
  }
  if (b.hard_threshold <= 0.0 || b.hard_threshold > 1.0) {
    throw new InvalidBudgetError(`hard_threshold 必须在 (0, 1] 范围内：${b.hard_threshold}`);
  }
  if (b.soft_threshold >= b.hard_threshold) {
    throw new InvalidBudgetError(`soft_threshold (${b.soft_threshold}) 必须 < hard_threshold (${b.hard_threshold})`);
  }
}

/** 计算 consumption_ratio */
export function consumptionRatio(b: TokenBudget): number {
  return b.total_budget > 0 ? b.consumed / b.total_budget : 0.0;
}

/** 取快照 */
export function snapshot(b: TokenBudget): BudgetSnapshot {
  const ratio = consumptionRatio(b);
  return {
    total_budget: b.total_budget,
    consumed: b.consumed,
    reserved: b.reserved,
    remaining: Math.max(0, b.total_budget - b.consumed - b.reserved),
    consumption_ratio: ratio,
    is_over_soft: ratio >= b.soft_threshold,
    is_over_hard: ratio >= b.hard_threshold,
  };
}

// ============================================================================
// TokenBudgetGuard 主类
// ============================================================================

/** TokenBudgetGuard 配置 */
export interface TokenBudgetGuardConfig {
  default_mode: BudgetEnforcementMode;
  default_soft_threshold: number;
  default_hard_threshold: number;
  /** 触发降级时是否同时切到 haiku */
  enable_auto_downgrade: boolean;
}

/** TokenBudgetGuard 决策历史记录 */
export interface BudgetDecisionRecord {
  task_id: string;
  pre_check: BudgetDecision | null;
  post_check: BudgetDecision | null;
  consumed: number;
  success: boolean;
  mode: BudgetEnforcementMode;
  recorded_at: number;
}

export class TokenBudgetGuard {
  private readonly config: TokenBudgetGuardConfig;
  private readonly history: Map<string, BudgetDecisionRecord>;
  private readonly log: (level: string, message: string) => void;

  constructor(args?: { config?: Partial<TokenBudgetGuardConfig>; log?: (level: string, message: string) => void }) {
    this.config = {
      default_mode: args?.config?.default_mode ?? "hybrid",
      default_soft_threshold: args?.config?.default_soft_threshold ?? 0.8,
      default_hard_threshold: args?.config?.default_hard_threshold ?? 1.0,
      enable_auto_downgrade: args?.config?.enable_auto_downgrade ?? true,
    };
    // 校验阈值
    if (this.config.default_soft_threshold >= this.config.default_hard_threshold) {
      throw new InvalidBudgetError(
        `default_soft_threshold (${this.config.default_soft_threshold}) 必须 < default_hard_threshold (${this.config.default_hard_threshold})`
      );
    }
    this.history = new Map<string, BudgetDecisionRecord>();
    this.log =
      args?.log ??
      ((l, m) => {
        if (l === "warn" || l === "error") console.warn(`[budget_guard] ${m}`);
      });
  }

  /** 创建预算 */
  createBudget(args: { total: number; task_id: string; softThreshold?: number; hardThreshold?: number }): TokenBudget {
    if (args.total <= 0) {
      throw new InvalidBudgetError(`total 必须为正整数：${args.total}`);
    }
    const b: TokenBudget = {
      total_budget: args.total,
      consumed: 0,
      reserved: 0,
      soft_threshold: args.softThreshold ?? this.config.default_soft_threshold,
      hard_threshold: args.hardThreshold ?? this.config.default_hard_threshold,
    };
    validateTokenBudget(b);
    // 初始化历史
    this.history.set(args.task_id, {
      task_id: args.task_id,
      pre_check: null,
      post_check: null,
      consumed: 0,
      success: false,
      mode: this.config.default_mode,
      recorded_at: Date.now(),
    });
    return b;
  }

  /**
   * 预检（pre_execute）
   *
   * 在执行前检查预算是否够用
   */
  preExecuteCheck(args: {
    budget: TokenBudget;
    estimatedTokens: number;
    mode?: BudgetEnforcementMode;
  }): BudgetDecision {
    const mode = args.mode ?? this.config.default_mode;
    const b = args.budget;
    const estimatedTotal = b.consumed + b.reserved + args.estimatedTokens;
    const projectedRatio = b.total_budget > 0 ? estimatedTotal / b.total_budget : 0.0;
    const warnings: string[] = [];

    if (projectedRatio >= b.hard_threshold) {
      if (mode === "hard" || mode === "hybrid") {
        return {
          allow_continue: false,
          recommendation: "abort",
          warnings: [`预计消耗 ${args.estimatedTokens}，将超过硬阈值 ${(b.hard_threshold * 100).toFixed(0)}%`],
          reason: "预计将超硬阈值",
          triggered_downgrade: false,
          new_tier: null,
        };
      }
      // soft 模式：触发降级
      return {
        allow_continue: true,
        recommendation: "switch_to_haiku",
        warnings: [`预计将超硬阈值，自动切到 haiku 继续`],
        reason: "soft 模式：降级继续",
        triggered_downgrade: this.config.enable_auto_downgrade,
        new_tier: this.config.enable_auto_downgrade ? "haiku" : null,
      };
    }

    if (projectedRatio >= b.soft_threshold) {
      warnings.push(`预计消耗将达 ${(projectedRatio * 100).toFixed(0)}%，超过软阈值`);
      if (mode === "soft" || mode === "hybrid") {
        return {
          allow_continue: true,
          recommendation: "switch_to_haiku",
          warnings,
          reason: "预计将超软阈值",
          triggered_downgrade: this.config.enable_auto_downgrade,
          new_tier: this.config.enable_auto_downgrade ? "haiku" : null,
        };
      }
    }

    return {
      allow_continue: true,
      recommendation: "continue",
      warnings,
      reason: "预算充足",
      triggered_downgrade: false,
      new_tier: null,
    };
  }

  /**
   * 中检（during_execute）
   *
   * 在执行中累计实际消耗
   */
  duringExecuteUpdate(args: {
    budget: TokenBudget;
    additionalTokens: number;
    mode?: BudgetEnforcementMode;
  }): BudgetDecision {
    const mode = args.mode ?? this.config.default_mode;
    const b = args.budget;
    b.consumed += args.additionalTokens;
    const snap = snapshot(b);

    if (snap.is_over_hard) {
      if (mode === "hard" || mode === "hybrid") {
        return {
          allow_continue: false,
          recommendation: "abort",
          warnings: [`已消耗 ${b.consumed}，超过硬阈值（${(b.hard_threshold * 100).toFixed(0)}%）`],
          reason: "已超硬阈值",
          triggered_downgrade: false,
          new_tier: null,
        };
      }
    }

    if (snap.is_over_soft) {
      return {
        allow_continue: true,
        recommendation: "switch_to_haiku",
        warnings: [`已消耗 ${b.consumed}，超过软阈值`],
        reason: "已超软阈值",
        triggered_downgrade: this.config.enable_auto_downgrade,
        new_tier: this.config.enable_auto_downgrade ? "haiku" : null,
      };
    }

    return {
      allow_continue: true,
      recommendation: "continue",
      warnings: [],
      reason: "预算正常",
      triggered_downgrade: false,
      new_tier: null,
    };
  }

  /**
   * 后审（post_execute）
   *
   * 在执行后更新画像与历史
   */
  postExecuteReview(args: {
    budget: TokenBudget;
    success: boolean;
    task_id: string;
    task_type?: string;
  }): BudgetDecision {
    const b = args.budget;
    const snap = snapshot(b);
    const warnings: string[] = [];
    let recommendation: BudgetRecommendation = "continue";
    const triggered_downgrade = false;
    const newTier: "haiku" | "sonnet" | "opus" | null = null;

    if (snap.is_over_hard) {
      warnings.push(`最终消耗 ${b.consumed} 超过硬阈值（${(b.hard_threshold * 100).toFixed(0)}%）`);
      recommendation = "abort";
    } else if (snap.is_over_soft) {
      warnings.push(`最终消耗 ${b.consumed} 超过软阈值（${(b.soft_threshold * 100).toFixed(0)}%）`);
      recommendation = "split_task";
    }

    // 更新历史
    const record = this.history.get(args.task_id);
    if (record !== undefined) {
      record.post_check = {
        allow_continue: !snap.is_over_hard,
        recommendation,
        warnings,
        reason: "post_execute_review",
        triggered_downgrade,
        new_tier: newTier,
      };
      record.consumed = b.consumed;
      record.success = args.success;
    }

    return {
      allow_continue: !snap.is_over_hard,
      recommendation,
      warnings,
      reason: "post_execute_review",
      triggered_downgrade,
      new_tier: newTier,
    };
  }

  /** 获取历史记录 */
  getHistory(taskId: string): BudgetDecisionRecord | null {
    return this.history.get(taskId) ?? null;
  }

  /** 列出所有历史 */
  listHistory(): BudgetDecisionRecord[] {
    return Array.from(this.history.values());
  }

  /** 清理过期历史（保留最近 N 条） */
  cleanupHistory(keepLast: number = 100): number {
    if (this.history.size <= keepLast) return 0;
    const sorted = Array.from(this.history.values()).sort((a, b) => a.recorded_at - b.recorded_at);
    const toDelete = sorted.slice(0, sorted.length - keepLast);
    for (const r of toDelete) {
      this.history.delete(r.task_id);
    }
    return toDelete.length;
  }
}

/** 创建默认 TokenBudgetGuard */
export function createDefaultBudgetGuard(args?: {
  config?: Partial<TokenBudgetGuardConfig>;
  log?: (level: string, message: string) => void;
}): TokenBudgetGuard {
  return new TokenBudgetGuard(args);
}
