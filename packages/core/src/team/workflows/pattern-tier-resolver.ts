/**
 * Pattern Tier Resolver（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/pattern_tier_resolver.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * Phase 10 实现：根据 pattern_id 推导 model_tier
 *
 * 核心职责：
 *   1. 6 大模式 → ModelTier 映射表（默认策略）
 *   2. 支持升级/降级条件（基于 TaskFeature 字段）
 *   3. 显式覆盖（explicit_tier 参数，优先级最高）
 *   4. 未知 pattern_id → fallback
 *   5. 自定义策略覆盖默认（custom_policies）
 *
 * 升级/降级条件优先级（高到低）：
 *   0. explicit_tier 强制覆盖
 *   1. upgrade_condition 触发 → upgrade_to
 *   2. downgrade_condition 触发 → downgrade_to
 *   3. 否则 → default_tier
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 模型分层 */
export type ModelTier = "haiku" | "sonnet" | "opus";

/** 简化版 TaskFeature（避免循环依赖） */
export interface TierTaskFeature {
  task_complexity: number;
  estimated_tokens: number;
  is_critical: boolean;
  deadline_ms: number | null;
  extra: Record<string, unknown>;
}

/** Pattern Tier 策略 */
export interface PatternTierPolicy {
  pattern_id: string;
  default_tier: ModelTier;
  upgrade_to: ModelTier | null;
  upgrade_condition: ((f: TierTaskFeature) => boolean) | null;
  downgrade_to: ModelTier | null;
  downgrade_condition: ((f: TierTaskFeature) => boolean) | null;
  rationale: string;
}

/** 解析结果 */
export interface TierResolution {
  tier: ModelTier | null;
  source:
    | "explicit_override"
    | "pattern_policy_default"
    | "pattern_policy_upgrade"
    | "pattern_policy_downgrade"
    | "fallback";
  reasoning: string;
  confidence: number;
}

/** 默认 Tier 工厂 */
export function defaultTier(): ModelTier {
  return "sonnet";
}

/** 默认 TierResolution 工厂 */
export function defaultTierResolution(): TierResolution {
  return { tier: null, source: "fallback", reasoning: "未匹配任何策略", confidence: 0.0 };
}

// ============================================================================
// 异常定义
// ============================================================================

export class PatternTierPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternTierPolicyError";
  }
}

export class InvalidTierError extends PatternTierPolicyError {
  constructor(tier: string) {
    super(`非法 tier 值: '${tier}'`);
    this.name = "InvalidTierError";
  }
}

// ============================================================================
// 6 大模式默认策略
// ============================================================================

/** 模式 1：classifier-dispatch → sonnet（默认） */
const POLICY_CLASSIFIER_DISPATCH: PatternTierPolicy = {
  pattern_id: "classifier-dispatch",
  default_tier: "sonnet",
  upgrade_to: "opus",
  upgrade_condition: (f) => f.is_critical && f.task_complexity >= 9,
  downgrade_to: "haiku",
  downgrade_condition: (f) => !f.is_critical && f.task_complexity <= 3 && f.estimated_tokens < 2000,
  rationale: "分类器路由：普通用 sonnet，critical+complex 升级 opus",
};

/** 模式 2：fan-out-aggregate → haiku（并行量大，单条成本要低） */
const POLICY_FAN_OUT_AGGREGATE: PatternTierPolicy = {
  pattern_id: "fan-out-aggregate",
  default_tier: "haiku",
  upgrade_to: "sonnet",
  upgrade_condition: (f) => f.is_critical,
  downgrade_to: null,
  downgrade_condition: null,
  rationale: "扇出并行：单条用 haiku 控成本，critical 时升 sonnet",
};

/** 模式 3：adversarial-verify → opus（验证者必须高质量） */
const POLICY_ADVERSARIAL_VERIFY: PatternTierPolicy = {
  pattern_id: "adversarial-verify",
  default_tier: "opus",
  upgrade_to: null,
  upgrade_condition: null,
  downgrade_to: "sonnet",
  downgrade_condition: (f) => !f.is_critical && f.task_complexity <= 5,
  rationale: "对抗验证：opus 兜底，复杂低风险可降 sonnet",
};

/** 模式 4：generate-filter → sonnet（生成要质量，筛选可低成本） */
const POLICY_GENERATE_FILTER: PatternTierPolicy = {
  pattern_id: "generate-filter",
  default_tier: "sonnet",
  upgrade_to: "opus",
  upgrade_condition: (f) => f.is_critical && f.task_complexity >= 8,
  downgrade_to: "haiku",
  downgrade_condition: (f) => f.task_complexity <= 3 && f.estimated_tokens < 3000,
  rationale: "生成筛选：sonnet 平衡，critical+complex 升 opus",
};

/** 模式 5：tournament → opus（裁判要最高质量） */
const POLICY_TOURNAMENT: PatternTierPolicy = {
  pattern_id: "tournament",
  default_tier: "opus",
  upgrade_to: null,
  upgrade_condition: null,
  downgrade_to: "sonnet",
  downgrade_condition: (f) => !f.is_critical && f.task_complexity <= 4,
  rationale: "锦标赛：opus 裁判，复杂低风险可降 sonnet",
};

/** 模式 6：loop-until-done → sonnet（迭代循环，每轮成本需控制） */
const POLICY_LOOP_UNTIL_DONE: PatternTierPolicy = {
  pattern_id: "loop-until-done",
  default_tier: "sonnet",
  upgrade_to: "opus",
  upgrade_condition: (f) => f.is_critical,
  downgrade_to: "haiku",
  downgrade_condition: (f) => f.estimated_tokens < 1500,
  rationale: "循环迭代：sonnet 默认，critical 升 opus",
};

/** 默认策略表 */
const DEFAULT_POLICIES: ReadonlyArray<PatternTierPolicy> = [
  POLICY_CLASSIFIER_DISPATCH,
  POLICY_FAN_OUT_AGGREGATE,
  POLICY_ADVERSARIAL_VERIFY,
  POLICY_GENERATE_FILTER,
  POLICY_TOURNAMENT,
  POLICY_LOOP_UNTIL_DONE,
];

/** 校验 tier 字符串 */
export function isValidTier(s: string): s is ModelTier {
  return s === "haiku" || s === "sonnet" || s === "opus";
}

// ============================================================================
// PatternTierResolver
// ============================================================================

/**
 * 模式 tier 解析器
 *
 * 线程安全：单实例无内部状态，调用方按需实例化
 */
export class PatternTierResolver {
  private readonly policies: Map<string, PatternTierPolicy>;
  private readonly log: (level: string, message: string) => void;

  constructor(args?: { customPolicies?: PatternTierPolicy[]; log?: (level: string, message: string) => void }) {
    this.policies = new Map<string, PatternTierPolicy>();
    for (const p of DEFAULT_POLICIES) {
      this.policies.set(p.pattern_id, p);
    }
    if (args?.customPolicies) {
      for (const p of args.customPolicies) {
        this.validatePolicy(p);
        this.policies.set(p.pattern_id, p);
      }
    }
    this.log =
      args?.log ??
      ((l, m) => {
        if (l === "warn" || l === "error") console.warn(`[tier_resolver] ${m}`);
      });
  }

  /** 校验 PatternTierPolicy 字段合法性 */
  private validatePolicy(p: PatternTierPolicy): void {
    const kebabRe = /^[a-z][a-z0-9-]*[a-z0-9]$/;
    if (!kebabRe.test(p.pattern_id)) {
      throw new PatternTierPolicyError(`pattern_id '${p.pattern_id}' 不符合 kebab-case 命名规范`);
    }
    if (!isValidTier(p.default_tier)) {
      throw new InvalidTierError(p.default_tier);
    }
    if (p.upgrade_to !== null && !isValidTier(p.upgrade_to)) {
      throw new InvalidTierError(p.upgrade_to);
    }
    if (p.downgrade_to !== null && !isValidTier(p.downgrade_to)) {
      throw new InvalidTierError(p.downgrade_to);
    }
    if (p.upgrade_to !== null && p.upgrade_to === p.default_tier) {
      throw new PatternTierPolicyError(`upgrade_to (${p.upgrade_to}) 不能等于 default_tier`);
    }
  }

  /**
   * 解析 tier
   *
   * 决策顺序：
   *   0. explicit_tier 非空 → 强制覆盖
   *   1. upgrade_condition 触发 → upgrade_to
   *   2. downgrade_condition 触发 → downgrade_to
   *   3. default_tier
   *   4. 未找到策略 → fallback（tier=null）
   */
  resolve(args: {
    pattern_id: string | null;
    feature: TierTaskFeature;
    explicit_tier?: string | null;
  }): TierResolution {
    // 阶段 0：显式覆盖
    if (args.explicit_tier !== undefined && args.explicit_tier !== null && args.explicit_tier !== "") {
      if (!isValidTier(args.explicit_tier)) {
        this.log("warn", `explicit_tier '${args.explicit_tier}' 非法，回退到策略决策`);
      } else {
        return {
          tier: args.explicit_tier,
          source: "explicit_override",
          reasoning: `调用方显式指定 tier=${args.explicit_tier}`,
          confidence: 1.0,
        };
      }
    }

    // 阶段 1-3：模式策略
    if (args.pattern_id === null) {
      return { tier: null, source: "fallback", reasoning: "pattern_id=null，未匹配任何策略", confidence: 0.0 };
    }
    const policy = this.policies.get(args.pattern_id);
    if (policy === undefined) {
      this.log("warn", `未知 pattern_id '${args.pattern_id}'，返回 fallback（由 ModelRouter 走通用规则）`);
      return { tier: null, source: "fallback", reasoning: `未知 pattern_id '${args.pattern_id}'`, confidence: 0.0 };
    }

    // upgrade
    if (policy.upgrade_to !== null && policy.upgrade_condition !== null) {
      if (policy.upgrade_condition(args.feature)) {
        return {
          tier: policy.upgrade_to,
          source: "pattern_policy_upgrade",
          reasoning: `模式 '${args.pattern_id}' 升级条件触发：${policy.rationale}`,
          confidence: 0.9,
        };
      }
    }

    // downgrade
    if (policy.downgrade_to !== null && policy.downgrade_condition !== null) {
      if (policy.downgrade_condition(args.feature)) {
        return {
          tier: policy.downgrade_to,
          source: "pattern_policy_downgrade",
          reasoning: `模式 '${args.pattern_id}' 降级条件触发：${policy.rationale}`,
          confidence: 0.85,
        };
      }
    }

    // default
    return {
      tier: policy.default_tier,
      source: "pattern_policy_default",
      reasoning: `模式 '${args.pattern_id}' 默认 tier=${policy.default_tier}：${policy.rationale}`,
      confidence: 0.8,
    };
  }

  /** 获取所有策略（只读） */
  listPolicies(): PatternTierPolicy[] {
    return Array.from(this.policies.values());
  }

  /** 列出所有已注册 pattern_id */
  listPatternIds(): string[] {
    return Array.from(this.policies.keys());
  }
}

/** 一键解析 */
export function resolveTier(args: {
  pattern_id: string | null;
  feature: TierTaskFeature;
  explicit_tier?: string | null;
  customPolicies?: PatternTierPolicy[];
}): TierResolution {
  const resolver = new PatternTierResolver({ customPolicies: args.customPolicies });
  return resolver.resolve(args);
}
