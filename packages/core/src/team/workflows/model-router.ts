/**
 * Dynamic Workflows 模型路由器（Model Router）
 *
 * Phase 3 实现：基于 subagent 能力 / 成本的任务路由
 *
 * 核心职责：
 * 1. 定义 3 个模型层级（haiku / sonnet / opus）的画像（成本 / 质量 / 速度）
 * 2. 根据任务特征（复杂度 / 角色 / Token 预算 / 截止时间）选择最合适的模型
 * 3. 路由决策可解释（返回中文 reasoning 字段）
 * 4. 路由历史写入 PerformanceFingerprint（反哺 + 审计）
 * 5. 冷启动降级：无历史数据时使用静态决策表
 *
 * 设计约束（来自 DYNAMIC_WORKFLOWS_INTEGRATION.md §3.0）：
 * - 🔴 持久化复用：路由决策历史写入 PerformanceFingerprint.execution_record
 * - 🔴 V2 不修改：本模块独立运行，不触碰 V2 引擎
 * - 🔴 安全：任务特征 schema 校验；不允许任务描述直接决定模型
 * - 🔴 一阶段一模块：仅模型路由，不引入 Token 预算（独立模块 TokenBudgetGuard）
 *
 * 参考来源：
 * - [DYNAMIC_WORKFLOWS_INTEGRATION.md v1.1 §模块 4]
 * - [Anthropic Dynamic Workflows - 模型路由]
 * - [PHASE3_PLAN.md]
 *
 * 作者：trae-multi-agent 融合 Phase 3（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

import type { PatternTierResolver } from "./pattern-tier-resolver.js";

// ============================================================================
// 异常定义
// ============================================================================

/**
 * ModelRouter 异常基类
 */
export class ModelRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRouterError";
  }
}

/**
 * 任务特征非法（schema 校验失败）
 */
export class InvalidTaskFeatureError extends ModelRouterError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskFeatureError";
  }
}

/**
 * 模型层级未在画像中定义
 */
export class ModelTierNotFoundError extends ModelRouterError {
  constructor(message: string) {
    super(message);
    this.name = "ModelTierNotFoundError";
  }
}

// ============================================================================
// 枚举定义
// ============================================================================

/**
 * 模型层级字符串联合类型
 *
 * 对齐 Anthropic 模型家族：
 * - haiku  ：轻量级，低成本低延迟，适合简单任务
 * - sonnet ：标准级，平衡成本与质量，适合中等任务
 * - opus   ：重量级，高成本高质量，适合复杂关键任务
 */
export type ModelTier = "haiku" | "sonnet" | "opus";

/** 所有 ModelTier 列表（用于迭代） */
export const ALL_MODEL_TIERS: readonly ModelTier[] = ["haiku", "sonnet", "opus"] as const;

/** ModelTier 字符串常量的快速引用 */
export const ModelTierValues = {
  HAIKU: "haiku" as ModelTier,
  SONNET: "sonnet" as ModelTier,
  OPUS: "opus" as ModelTier,
};

/**
 * 从字符串解析 ModelTier（大小写不敏感）；找不到则抛 ModelTierNotFoundError
 */
export function modelTierFromStr(value: string): ModelTier {
  const normalized = value.toLowerCase().trim();
  for (const tier of ALL_MODEL_TIERS) {
    if (tier === normalized) {
      return tier;
    }
  }
  throw new ModelTierNotFoundError(`未知的模型层级：${value}（有效值：haiku / sonnet / opus）`);
}

// ============================================================================
// 数据类定义
// ============================================================================

/**
 * 模型画像
 *
 * 描述一个模型层级的关键属性，供路由决策使用。
 */
export interface ModelProfile {
  /** 模型层级 */
  tier: ModelTier;
  /** 每 1k token 相对成本（haiku=0.25, sonnet=1.0, opus=5.0） */
  cost_per_1k_tokens: number;
  /** 质量分 (0-1) */
  quality_score: number;
  /** 速度分 (0-1, 越大越快) */
  speed_score: number;
  /** 最大上下文 token 数 */
  max_context_tokens: number;
  /** 适用场景描述（中文） */
  description: string;
}

/**
 * 校验 ModelProfile 字段合法性（构造时立即检查）
 */
export function validateModelProfile(profile: ModelProfile): void {
  if (profile.cost_per_1k_tokens < 0) {
    throw new ModelRouterError(`cost_per_1k_tokens 不能为负：${profile.cost_per_1k_tokens}`);
  }
  if (profile.quality_score < 0.0 || profile.quality_score > 1.0) {
    throw new ModelRouterError(`quality_score 必须在 [0, 1] 范围内：${profile.quality_score}`);
  }
  if (profile.speed_score < 0.0 || profile.speed_score > 1.0) {
    throw new ModelRouterError(`speed_score 必须在 [0, 1] 范围内：${profile.speed_score}`);
  }
  if (profile.max_context_tokens <= 0) {
    throw new ModelRouterError(`max_context_tokens 必须为正整数：${profile.max_context_tokens}`);
  }
}

/**
 * 创建 ModelProfile（带校验）
 */
export function createModelProfile(profile: ModelProfile): ModelProfile {
  validateModelProfile(profile);
  return profile;
}

/**
 * 任务特征（路由决策输入）
 *
 * 描述一次任务执行的关键特征，ModelRouter 据此选择模型。
 *
 * Phase 10 新增字段：
 * - pattern_id: 当前任务所属模式（用于 PatternTierResolver 决策）
 * - extra: 扩展字段字典（透传 subtask_count / is_final_iteration / risk_level / type_variants 等模式特定信息）
 */
export interface TaskFeature {
  /** 任务复杂度 1-10 */
  task_complexity: number;
  /** 预计 token 消耗（含 input + output） */
  estimated_tokens: number;
  /** 角色标识（架构师/产品/solo-coder/test-expert/...） */
  role?: string;
  /** 截止时间（毫秒），undefined 表示无截止 */
  deadline_ms?: number;
  /** 质量阈值（任务最低可接受质量） */
  quality_threshold: number;
  /** 预算剩余比例 (0-1)，1.0 表示充足 */
  budget_remaining: number;
  /** 是否关键任务（关键任务强制 opus） */
  is_critical: boolean;
  /** 任务类型（用于画像检索） */
  task_type: string;
  /** Phase 10 新增：当前任务所属模式（undefined 时不触发 PatternTierResolver） */
  pattern_id?: string;
  /** Phase 10 新增：模式特定扩展字段 */
  extra: Record<string, unknown>;
}

/**
 * 校验 TaskFeature 字段合法性
 */
export function validateTaskFeature(feature: TaskFeature): void {
  if (feature.task_complexity < 1 || feature.task_complexity > 10) {
    throw new InvalidTaskFeatureError(`task_complexity 必须在 [1, 10] 范围内：${feature.task_complexity}`);
  }
  if (feature.estimated_tokens <= 0) {
    throw new InvalidTaskFeatureError(`estimated_tokens 必须为正整数：${feature.estimated_tokens}`);
  }
  if (feature.quality_threshold < 0.0 || feature.quality_threshold > 1.0) {
    throw new InvalidTaskFeatureError(`quality_threshold 必须在 [0, 1] 范围内：${feature.quality_threshold}`);
  }
  if (feature.budget_remaining < 0.0 || feature.budget_remaining > 1.0) {
    throw new InvalidTaskFeatureError(`budget_remaining 必须在 [0, 1] 范围内：${feature.budget_remaining}`);
  }
  if (feature.deadline_ms !== undefined && feature.deadline_ms <= 0) {
    throw new InvalidTaskFeatureError(`deadline_ms 为正整数或 undefined：${feature.deadline_ms}`);
  }
  if (feature.pattern_id !== undefined && typeof feature.pattern_id !== "string") {
    throw new InvalidTaskFeatureError(`pattern_id 必须是 string 或 undefined：${typeof feature.pattern_id}`);
  }
  if (
    feature.extra === null ||
    feature.extra === undefined ||
    typeof feature.extra !== "object" ||
    Array.isArray(feature.extra)
  ) {
    throw new InvalidTaskFeatureError(`extra 必须是 Record<string, unknown>，实际为 ${typeof feature.extra}`);
  }
}

/**
 * 任务特征转字典（用于画像反哺）
 *
 * Phase 10 修复（架构师审查 2.10）：
 * 显式排除 `pattern_id`，保持 fingerprint schema 向后兼容。
 * `extra` 字段保留（用于模式特定特征反哺）。
 */
export function taskFeatureToDict(feature: TaskFeature): Record<string, unknown> {
  const d: Record<string, unknown> = {
    task_complexity: feature.task_complexity,
    estimated_tokens: feature.estimated_tokens,
    role: feature.role,
    deadline_ms: feature.deadline_ms,
    quality_threshold: feature.quality_threshold,
    budget_remaining: feature.budget_remaining,
    is_critical: feature.is_critical,
    task_type: feature.task_type,
    extra: { ...feature.extra },
  };
  // 显式排除 pattern_id，保持 fingerprint schema 兼容
  return d;
}

/**
 * 路由决策（带可解释性）
 *
 * 包含最终选择的模型 + 决策理由 + 备选方案 + 决策时的特征快照。
 */
export interface RoutingDecision {
  /** 选择的模型层级 */
  selected_tier: ModelTier;
  /** 决策置信度 (0-1) */
  confidence: number;
  /** 决策理由（中文，人类可读） */
  reasoning: string;
  /** 备选方案 */
  alternatives: ModelTier[];
  /** 决策时的特征快照 */
  feature_snapshot: Record<string, unknown>;
  /** 决策来源：static_rule / fingerprint_history / pattern_policy / explicit_override / fallback_on_error */
  decision_source: string;
  /** 决策耗时（毫秒） */
  decision_time_ms: number;
}

/**
 * 校验 RoutingDecision 字段合法性
 */
export function validateRoutingDecision(decision: RoutingDecision): void {
  if (decision.confidence < 0.0 || decision.confidence > 1.0) {
    throw new ModelRouterError(`confidence 必须在 [0, 1] 范围内：${decision.confidence}`);
  }
  if (!decision.reasoning) {
    throw new ModelRouterError("reasoning 不能为空");
  }
  // 软约束：alternatives 不为空时，selected_tier 应在 alternatives 中
  // （但允许 alternatives 为空以兼容极简场景）
  if (decision.alternatives.length > 0 && !decision.alternatives.includes(decision.selected_tier)) {
    // 不抛异常（软约束）
  }
}

/**
 * 创建 RoutingDecision（带校验）
 */
export function createRoutingDecision(decision: RoutingDecision): RoutingDecision {
  validateRoutingDecision(decision);
  return decision;
}

/**
 * 路由决策转字典（用于画像反哺）
 */
export function routingDecisionToDict(decision: RoutingDecision): Record<string, unknown> {
  return {
    selected_tier: decision.selected_tier,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    alternatives: [...decision.alternatives],
    feature_snapshot: { ...decision.feature_snapshot },
    decision_source: decision.decision_source,
    decision_time_ms: decision.decision_time_ms,
  };
}

// ============================================================================
// 默认模型画像（出厂设置）
// ============================================================================

/**
 * 三个模型层级的默认画像（与 Anthropic Claude 家族对齐）
 *
 * cost_per_1k_tokens: 相对值（sonnet=1.0 为基准）
 * quality_score / speed_score: 0-1 经验值
 */
export const DEFAULT_PROFILES: Map<ModelTier, ModelProfile> = new Map<ModelTier, ModelProfile>([
  [
    "haiku",
    createModelProfile({
      tier: "haiku",
      cost_per_1k_tokens: 0.25,
      quality_score: 0.7,
      speed_score: 1.0,
      max_context_tokens: 200_000,
      description: "轻量级模型，适合简单任务：分类、提取、格式化、单元测试",
    }),
  ],
  [
    "sonnet",
    createModelProfile({
      tier: "sonnet",
      cost_per_1k_tokens: 1.0,
      quality_score: 0.85,
      speed_score: 0.6,
      max_context_tokens: 200_000,
      description: "标准级模型，适合中等任务：代码实现、文档撰写、API 设计",
    }),
  ],
  [
    "opus",
    createModelProfile({
      tier: "opus",
      cost_per_1k_tokens: 5.0,
      quality_score: 0.95,
      speed_score: 0.3,
      max_context_tokens: 200_000,
      description: "重量级模型，适合复杂关键任务：架构设计、深度分析、关键审查",
    }),
  ],
]);

// ============================================================================
// 决策阈值常量
// ============================================================================

/** 关键任务复杂度阈值（>= 7 视为高复杂度） */
export const HIGH_COMPLEXITY_THRESHOLD = 7;

/** 预算耗尽阈值（< 10% 强制 haiku） */
export const BUDGET_EXHAUSTED_THRESHOLD = 0.1;

/** 截止时间紧阈值（< 5s） */
export const TIGHT_DEADLINE_MS = 5_000;

/** 画像检索最小样本数（低于此数走静态规则） */
export const MIN_FINGERPRINT_SAMPLES = 10;

/** 画像历史权重（用于加权决策） */
export const FINGERPRINT_HISTORY_WEIGHT = 0.6;

/** 静态规则权重 */
export const STATIC_RULE_WEIGHT = 0.4;

/** 路由历史最大保留条数（避免内存膨胀） */
export const MAX_DECISION_HISTORY = 500;

// ============================================================================
// PerformanceFingerprint 接口（解耦真实实现）
// ============================================================================

/**
 * Fingerprint 记录接口（解耦 deepcode-cli 与 multi-agent-team 的 PerformanceFingerprint）
 */
export interface FingerprintRecord {
  task_type: string;
  task_complexity: number;
  success: boolean;
  error_type?: string;
  execution_time: number;
  strategy: string;
  context_features: Record<string, unknown>;
}

/**
 * PerformanceFingerprint 抽象接口
 *
 * ModelRouter 通过该接口写入 / 读取路由决策历史。
 * 真实实现由调用方注入（避免强耦合）。
 */
export interface PerformanceFingerprintLike {
  /** 总执行次数 */
  readonly total_executions: number;
  /** 全部记录（只读视图） */
  readonly records: readonly FingerprintRecord[];
  /**
   * 记录一次执行
   *
   * @param task_type 任务类型
   * @param task_complexity 任务复杂度
   * @param success 是否成功
   * @param error_type 错误类型（可选）
   * @param execution_time 执行耗时
   * @param strategy 策略描述
   * @param context_features 上下文特征
   */
  record(args: {
    task_type: string;
    task_complexity: number;
    success: boolean;
    error_type?: string;
    execution_time: number;
    strategy: string;
    context_features: Record<string, unknown>;
  }): void;
}

// ============================================================================
// 默认 TaskFeature 工厂
// ============================================================================

/**
 * 创建默认 TaskFeature（用于测试 / 简化调用）
 */
export function defaultTaskFeature(): TaskFeature {
  return {
    task_complexity: 5,
    estimated_tokens: 1000,
    quality_threshold: 0.85,
    budget_remaining: 1.0,
    is_critical: false,
    task_type: "general",
    extra: {},
  };
}

// ============================================================================
// ModelRouter 主类
// ============================================================================

/**
 * 模型路由器
 *
 * 根据任务特征选择最合适的模型层级，并提供决策可解释性 + 画像反哺。
 *
 * Phase 10 增强：
 * - 接受可选的 tier_resolver（PatternTierResolver 实例）
 * - 当 resolver 存在且 feature.pattern_id 命中策略时，优先使用 resolver 决策
 * - 决策链：explicit_tier > critical_path > pattern_policy > static_rule > history
 *
 * 使用方式：
 * ```typescript
 * const router = new ModelRouter({ fingerprint });
 * const decision = router.route({
 *   task_complexity: 8,
 *   estimated_tokens: 50000,
 *   role: "architect",
 *   budget_remaining: 0.5,
 *   quality_threshold: 0.85,
 *   is_critical: false,
 *   task_type: "general",
 *   extra: {},
 * });
 * console.log(decision.selected_tier, decision.reasoning);
 * // -> "opus" "高复杂度任务，opus 必需"
 *
 * // 执行后反哺
 * router.recordDecision(decision, { success: true, quality: 0.92 });
 * ```
 *
 * Phase 10 进阶：
 * ```typescript
 * const resolver = createDefaultResolver();
 * const router = new ModelRouter({ fingerprint, tier_resolver: resolver });
 * const decision = router.route({
 *   task_complexity: 5,
 *   estimated_tokens: 1000,
 *   pattern_id: "adversarial-verify", // 触发 pattern_policy
 *   quality_threshold: 0.85,
 *   budget_remaining: 1.0,
 *   is_critical: false,
 *   task_type: "general",
 *   extra: {},
 * });
 * // -> "opus" "模式 adversarial-verify 默认策略，使用 opus"
 *
 * // 显式覆盖
 * const decision2 = router.route(
 *   { ...feature, pattern_id: "adversarial-verify" },
 *   "haiku", // 强制 haiku
 * );
 * // -> "haiku" "显式声明 model_tier=haiku，强制覆盖"
 * ```
 */
export class ModelRouter {
  private readonly _profiles: Map<ModelTier, ModelProfile>;
  private readonly _fingerprint: PerformanceFingerprintLike | null;
  private readonly _tier_resolver: PatternTierResolver | null;
  private readonly _decision_history: Array<{
    decision: Record<string, unknown>;
    timestamp: number;
  }> = [];

  /**
   * 初始化 ModelRouter
   *
   * @param options 初始化选项
   * @param options.fingerprint 可选的 PerformanceFingerprint 实例（用于反哺）
   * @param options.custom_profiles 可选的自定义模型画像（覆盖默认值）
   * @param options.tier_resolver 可选的 PatternTierResolver 实例（Phase 10 新增；用于基于模式选择 tier）
   */
  constructor(
    options: {
      fingerprint?: PerformanceFingerprintLike;
      custom_profiles?: Map<ModelTier, ModelProfile> | Record<ModelTier, ModelProfile>;
      tier_resolver?: PatternTierResolver;
    } = {}
  ) {
    // 模型画像：合并默认 + 自定义（自定义优先）
    this._profiles = new Map<ModelTier, ModelProfile>(DEFAULT_PROFILES);
    if (options.custom_profiles) {
      for (const [tierKey, profile] of options.custom_profiles instanceof Map
        ? options.custom_profiles.entries()
        : (Object.entries(options.custom_profiles) as Array<[ModelTier, ModelProfile]>)) {
        const tier = tierKey as ModelTier;
        if (!ALL_MODEL_TIERS.includes(tier)) {
          throw new ModelRouterError(`custom_profiles 键必须是 ModelTier：${typeof tier}`);
        }
        validateModelProfile(profile);
        this._profiles.set(tier, profile);
      }
    }

    // 性能画像（可空；为空时无反哺）
    this._fingerprint = options.fingerprint ?? null;

    // Phase 10：PatternTierResolver（避免循环导入；运行时类型校验）
    this._tier_resolver = options.tier_resolver ?? null;
  }

  // ========================================================================
  // 公共方法
  // ========================================================================

  /**
   * 路由决策：根据任务特征选择最合适的模型
   *
   * 决策流程（5 层优先级，Phase 10 强化）：
   * 0. 强制覆盖（explicit_tier，Phase 10 新增；来自 task._meta.model_tier）
   * 1. 关键路径检查（is_critical=True → opus / budget_remaining<0.1 → haiku / tight_deadline → sonnet）
   *    ↑ 关键路径强制高于 pattern_policy（架构师审查 2.6 安全约束）
   * 2. Pattern policy 解析（Phase 10 新增；feature.pattern_id 命中时）
   * 3. 静态规则决策（基于 task_complexity）
   * 4. 画像反哺（>= 10 samples 时加权历史决策）
   *
   * @param feature 任务特征
   * @param explicit_tier 可选的显式覆盖（Phase 10 新增；undefined 时不触发）
   * @returns RoutingDecision 路由决策（含可解释性）
   */
  route(feature: TaskFeature, explicit_tier?: ModelTier): RoutingDecision {
    const startTime = Date.now();
    const featureSnapshot = taskFeatureToDict(feature);

    let decision: RoutingDecision;
    try {
      // 0. 强制覆盖（最高优先级）
      if (explicit_tier !== undefined && explicit_tier !== null) {
        if (!ALL_MODEL_TIERS.includes(explicit_tier)) {
          throw new ModelRouterError(`explicit_tier 必须是 ModelTier，实际为 ${typeof explicit_tier}`);
        }
        decision = createRoutingDecision({
          selected_tier: explicit_tier,
          confidence: 1.0,
          reasoning: `显式声明 model_tier=${explicit_tier}，强制覆盖`,
          alternatives: [],
          feature_snapshot: featureSnapshot,
          decision_source: "explicit_override",
          decision_time_ms: 0,
        });
      } else {
        // 1. 关键路径检查（is_critical / budget / deadline）
        //    关键路径强制高于 pattern_policy，确保 critical 任务永远用 opus
        const criticalDecision = this._checkCriticalPath(feature);
        if (criticalDecision) {
          decision = criticalDecision;
        } else {
          // 2. Pattern policy 解析（Phase 10 新增）
          const patternDecision = this._decideByPatternPolicy(feature);
          if (patternDecision) {
            decision = patternDecision;
          } else {
            // 3. 静态规则决策
            const staticDecision = this._decideByStaticRule(feature);

            // 4. 画像反哺（如果可用且样本充足）
            if (this._fingerprint && this._hasEnoughSamples()) {
              const historyDecision = this._decideByHistory(feature, staticDecision);
              if (historyDecision) {
                decision = historyDecision;
              } else {
                decision = staticDecision;
              }
            } else {
              decision = staticDecision;
            }
          }
        }
      }
    } catch (e) {
      // 决策失败时降级到 sonnet（最安全的中间档）
      const errMsg = e instanceof Error ? e.message : String(e);
      decision = createRoutingDecision({
        selected_tier: "sonnet",
        confidence: 0.5,
        reasoning: `决策异常，降级到 sonnet：${errMsg}`,
        alternatives: ["haiku", "opus"],
        feature_snapshot: featureSnapshot,
        decision_source: "fallback_on_error",
        decision_time_ms: 0,
      });
    }

    // 记录决策耗时
    decision.decision_time_ms = Date.now() - startTime;
    decision.feature_snapshot = featureSnapshot;

    // 写入内存历史
    this._decision_history.push({
      decision: routingDecisionToDict(decision),
      timestamp: Date.now(),
    });
    // 限制历史大小（避免内存膨胀）
    if (this._decision_history.length > MAX_DECISION_HISTORY) {
      this._decision_history.splice(0, this._decision_history.length - MAX_DECISION_HISTORY);
    }

    return decision;
  }

  /**
   * 记录路由决策 + 实际结果到性能画像
   *
   * 用于反哺：未来同类任务可参考历史成功决策。
   *
   * @param decision 路由决策
   * @param actual_outcome 实际执行结果
   * @param actual_outcome.success 是否成功
   * @param actual_outcome.quality 实际产出质量 (0-1)
   * @param actual_outcome.error_type 错误类型
   * @param actual_outcome.execution_time 执行耗时
   */
  recordDecision(
    decision: RoutingDecision,
    actual_outcome: {
      success?: boolean;
      quality?: number;
      error_type?: string;
      execution_time?: number;
    } = {}
  ): void {
    if (this._fingerprint === null) {
      // PerformanceFingerprint 未启用，跳过决策反哺
      return;
    }

    const success = actual_outcome.success ?? true;
    const quality = actual_outcome.quality ?? 0.0;
    const errorType = actual_outcome.error_type;

    // 估算复杂度（用于画像反哺，1-10 区间）
    const taskComplexity = (decision.feature_snapshot["task_complexity"] as number) ?? 5;

    try {
      this._fingerprint.record({
        task_type: `model_routing:${decision.selected_tier}`,
        task_complexity: taskComplexity,
        success,
        error_type: errorType,
        execution_time: actual_outcome.execution_time ?? 0.0,
        strategy: `model_tier=${decision.selected_tier};source=${decision.decision_source}`,
        context_features: {
          model_tier: decision.selected_tier,
          decision_confidence: decision.confidence,
          decision_source: decision.decision_source,
          actual_quality: quality,
          feature_snapshot: decision.feature_snapshot,
        },
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // 写入画像失败不应中断主流程

      console.error(`[model-router] 写入路由决策到画像失败: ${errMsg}`);
    }
  }

  /**
   * 获取所有模型画像（只读副本）
   *
   * @returns 模型画像字典
   */
  getProfiles(): Map<ModelTier, ModelProfile> {
    return new Map(this._profiles);
  }

  /**
   * 获取指定层级的模型画像
   *
   * @param tier 模型层级
   * @returns 模型画像
   * @throws ModelTierNotFoundError tier 未在画像中
   */
  getProfile(tier: ModelTier): ModelProfile {
    const profile = this._profiles.get(tier);
    if (!profile) {
      throw new ModelTierNotFoundError(`模型层级 ${tier} 未在画像中`);
    }
    return profile;
  }

  /**
   * 获取内存中的路由决策历史（最多 MAX_DECISION_HISTORY 条）
   *
   * @returns 决策历史列表
   */
  getDecisionHistory(): Array<Record<string, unknown>> {
    return this._decision_history.map((entry) => ({
      ...entry.decision,
      timestamp: entry.timestamp,
    }));
  }

  // ========================================================================
  // 内部方法 - 决策逻辑
  // ========================================================================

  /**
   * Phase 10 新增：基于 PatternTierResolver 的策略决策
   *
   * 触发条件：
   * 1. self._tier_resolver 存在
   * 2. feature.pattern_id 存在且非空
   *
   * 决策流程：
   * - 委托给 tier_resolver.resolve() 解析 tier
   * - 如果解析结果 tier 为 null → 返回 null（fallback 到通用规则）
   * - 否则构建 RoutingDecision 返回
   *
   * @returns RoutingDecision 如果 resolver 返回有效 tier；否则 null
   */
  private _decideByPatternPolicy(feature: TaskFeature): RoutingDecision | null {
    if (this._tier_resolver === null) {
      return null;
    }
    if (!feature.pattern_id) {
      return null;
    }

    // 委托给 resolver（TaskFeature -> TierTaskFeature 适配）
    const resolution = this._tier_resolver.resolve({
      pattern_id: feature.pattern_id,
      feature: {
        task_complexity: feature.task_complexity,
        estimated_tokens: feature.estimated_tokens,
        is_critical: feature.is_critical,
        deadline_ms: feature.deadline_ms ?? null,
        extra: feature.extra,
      },
    });

    // fallback（resolver 返回 tier=null）→ 走通用规则
    if (resolution.tier === null) {
      return null;
    }

    // 构建备选 tier 列表（除 selected_tier 外的所有 tier）
    const alternatives: ModelTier[] = ALL_MODEL_TIERS.filter((t) => t !== resolution.tier);

    return createRoutingDecision({
      selected_tier: resolution.tier,
      confidence: resolution.confidence,
      reasoning: resolution.reasoning,
      alternatives,
      feature_snapshot: {},
      decision_source: `pattern_policy:${feature.pattern_id}`,
      decision_time_ms: 0,
    });
  }

  /**
   * 关键路径检查：is_critical / 预算耗尽 / 截止时间紧
   *
   * @returns RoutingDecision 如果命中关键路径；否则 null（继续走静态规则）
   */
  private _checkCriticalPath(feature: TaskFeature): RoutingDecision | null {
    // 1. 关键任务 → 强制 opus
    if (feature.is_critical) {
      return createRoutingDecision({
        selected_tier: "opus",
        confidence: 0.95,
        reasoning: "关键任务（is_critical=True），强制使用 opus 确保质量",
        alternatives: ["sonnet"],
        feature_snapshot: {},
        decision_source: "static_rule:critical_task",
        decision_time_ms: 0,
      });
    }

    // 2. 预算耗尽（< 10%）→ 强制 haiku
    if (feature.budget_remaining < BUDGET_EXHAUSTED_THRESHOLD) {
      return createRoutingDecision({
        selected_tier: "haiku",
        confidence: 0.9,
        reasoning: `预算即将耗尽（剩余 ${(feature.budget_remaining * 100).toFixed(1)}% < ${(BUDGET_EXHAUSTED_THRESHOLD * 100).toFixed(0)}%），强制使用 haiku 节省成本`,
        alternatives: ["sonnet"],
        feature_snapshot: {},
        decision_source: "static_rule:budget_exhausted",
        decision_time_ms: 0,
      });
    }

    // 3. 截止时间紧（< 5s）+ 质量阈值宽松（< 0.8）→ sonnet
    if (
      feature.deadline_ms !== undefined &&
      feature.deadline_ms < TIGHT_DEADLINE_MS &&
      feature.quality_threshold < 0.8
    ) {
      return createRoutingDecision({
        selected_tier: "sonnet",
        confidence: 0.85,
        reasoning: `截止时间紧（${feature.deadline_ms}ms < ${TIGHT_DEADLINE_MS}ms）且质量阈值宽松（${feature.quality_threshold.toFixed(2)}），使用 sonnet 平衡速度与质量`,
        alternatives: ["haiku", "opus"],
        feature_snapshot: {},
        decision_source: "static_rule:tight_deadline",
        decision_time_ms: 0,
      });
    }

    // 未命中关键路径
    return null;
  }

  /**
   * 静态规则决策：基于任务复杂度分级
   *
   * 规则：
   * - 1-3  → haiku（低复杂度）
   * - 4-6  → sonnet（中等复杂度）
   * - 7-10 → opus（高复杂度）
   */
  private _decideByStaticRule(feature: TaskFeature): RoutingDecision {
    const complexity = feature.task_complexity;

    if (complexity <= 3) {
      return createRoutingDecision({
        selected_tier: "haiku",
        confidence: 0.8,
        reasoning: `低复杂度任务（complexity=${complexity} <= 3），haiku 即可满足`,
        alternatives: ["sonnet", "opus"],
        feature_snapshot: {},
        decision_source: "static_rule:low_complexity",
        decision_time_ms: 0,
      });
    } else if (complexity <= 6) {
      return createRoutingDecision({
        selected_tier: "sonnet",
        confidence: 0.8,
        reasoning: `中等复杂度任务（complexity=${complexity} in [4,6]），sonnet 平衡成本与质量`,
        alternatives: ["haiku", "opus"],
        feature_snapshot: {},
        decision_source: "static_rule:medium_complexity",
        decision_time_ms: 0,
      });
    } else {
      return createRoutingDecision({
        selected_tier: "opus",
        confidence: 0.8,
        reasoning: `高复杂度任务（complexity=${complexity} >= 7），opus 必需`,
        alternatives: ["sonnet"],
        feature_snapshot: {},
        decision_source: "static_rule:high_complexity",
        decision_time_ms: 0,
      });
    }
  }

  /**
   * 画像反哺决策：检索历史相似任务的成功决策，加权到静态规则
   *
   * 策略：
   * - 检索同 task_type + 相近 task_complexity 的历史记录
   * - 取最近 N 次成功记录中 model_tier 的众数
   * - 加权：历史权重 0.6 + 静态规则权重 0.4
   * - 如果历史决策与静态决策一致 → 提高置信度
   * - 如果历史决策与静态决策不一致 → 选择历史决策（基于真实数据）
   *
   * @param feature 任务特征
   * @param static_decision 静态规则决策
   * @returns RoutingDecision 如果有可用历史；否则 null
   */
  private _decideByHistory(feature: TaskFeature, static_decision: RoutingDecision): RoutingDecision | null {
    if (this._fingerprint === null) {
      return null;
    }

    try {
      // 检索相似历史（同 task_type + complexity ±2）
      const targetComplexity = feature.task_complexity;

      const similarRecords: FingerprintRecord[] = [];
      for (const record of this._fingerprint.records) {
        if (!record.strategy.startsWith("model_tier=")) {
          continue;
        }
        if (Math.abs(record.task_complexity - targetComplexity) > 2) {
          continue;
        }
        if (!record.success) {
          continue;
        }
        similarRecords.push(record);
      }

      if (similarRecords.length === 0) {
        return null;
      }

      // 取最近 20 条
      const recentRecords = similarRecords.slice(-20);

      // 统计 model_tier 众数
      const tierCounts = new Map<ModelTier, number>();
      for (const record of recentRecords) {
        // strategy 格式: "model_tier=xxx;source=yyy"
        for (const part of record.strategy.split(";")) {
          if (part.startsWith("model_tier=")) {
            const tierValue = part.split("=", 2)[1];
            if (tierValue === undefined) {
              continue;
            }
            try {
              const tier = modelTierFromStr(tierValue);
              tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
            } catch {
              // 未知 tier 跳过
              continue;
            }
            break;
          }
        }
      }

      if (tierCounts.size === 0) {
        return null;
      }

      // 众数
      let historyTier: ModelTier = "sonnet";
      let historyCount = 0;
      let maxCount = 0;
      for (const [tier, count] of tierCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          historyTier = tier;
          historyCount = count;
        }
      }
      const totalCount = Array.from(tierCounts.values()).reduce((a, b) => a + b, 0);
      const historyRatio = totalCount > 0 ? historyCount / totalCount : 0;

      // 加权决策
      if (historyTier === static_decision.selected_tier) {
        // 一致 → 提高置信度
        const newConfidence = Math.min(
          1.0,
          static_decision.confidence * STATIC_RULE_WEIGHT + historyRatio * FINGERPRINT_HISTORY_WEIGHT + 0.1 // 一致性奖励
        );
        return createRoutingDecision({
          selected_tier: historyTier,
          confidence: newConfidence,
          reasoning: `画像反哺：历史 ${historyCount}/${totalCount} 次同类任务均使用 ${historyTier}，与静态规则一致，提高置信度`,
          alternatives: static_decision.alternatives,
          feature_snapshot: {},
          decision_source: "fingerprint_history:consistent",
          decision_time_ms: 0,
        });
      } else {
        // 不一致 → 采用历史决策（基于真实数据优先）
        const newConfidence = Math.min(
          1.0,
          static_decision.confidence * STATIC_RULE_WEIGHT + historyRatio * FINGERPRINT_HISTORY_WEIGHT
        );
        return createRoutingDecision({
          selected_tier: historyTier,
          confidence: newConfidence,
          reasoning: `画像反哺：历史 ${historyCount}/${totalCount} 次同类任务使用 ${historyTier}（与静态规则的 ${static_decision.selected_tier} 不一致），基于真实数据采用 ${historyTier}`,
          alternatives: [static_decision.selected_tier, ...static_decision.alternatives],
          feature_snapshot: {},
          decision_source: "fingerprint_history:override",
          decision_time_ms: 0,
        });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // 画像反哺决策失败，降级到静态规则

      console.error(`[model-router] 画像反哺决策失败，降级到静态规则: ${errMsg}`);
      return null;
    }
  }

  /**
   * 检查画像样本数是否足够（>= MIN_FINGERPRINT_SAMPLES）
   *
   * @returns true 表示样本充足，可启用反哺；false 表示冷启动
   */
  private _hasEnoughSamples(): boolean {
    if (this._fingerprint === null) {
      return false;
    }
    return this._fingerprint.total_executions >= MIN_FINGERPRINT_SAMPLES;
  }
}

// ============================================================================
// 模块导出
// ============================================================================

// 注意：仅导出值（接口仅作为类型，不出现在 default 导出中）
export default {
  // 异常
  ModelRouterError,
  InvalidTaskFeatureError,
  ModelTierNotFoundError,
  // 字符串常量
  ALL_MODEL_TIERS,
  ModelTierValues,
  modelTierFromStr,
  // 工厂函数
  validateModelProfile,
  createModelProfile,
  validateTaskFeature,
  taskFeatureToDict,
  validateRoutingDecision,
  createRoutingDecision,
  routingDecisionToDict,
  defaultTaskFeature,
  // 常量
  DEFAULT_PROFILES,
  HIGH_COMPLEXITY_THRESHOLD,
  BUDGET_EXHAUSTED_THRESHOLD,
  TIGHT_DEADLINE_MS,
  MIN_FINGERPRINT_SAMPLES,
  FINGERPRINT_HISTORY_WEIGHT,
  STATIC_RULE_WEIGHT,
  MAX_DECISION_HISTORY,
  // 主类
  ModelRouter,
};
