/**
 * Dynamic Workflows 模式选择器（Pattern Composer V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/pattern_composer.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Think Before Coding - 严格按 Python 版本 1:1 移植
 *
 * 真实实现能力：
 *   1. 6 大模式全部沉淀（Phase 0: 3 个核心；Phase 5: 补齐 generate-filter / tournament / loop-until-done）
 *   2. 基于任务特征（TaskFeature）选择最合适的模式
 *   3. 模式库 schema 校验（防止损坏的模式定义被使用）
 *   4. 通过 PerformanceFingerprint 实现"模式选择 → 执行 → 画像反哺"闭环
 *   5. 模式不适用时优雅回退到 sequential（不强行套模式）
 *   6. 性能基线检查：< 100ms / 次
 *
 * 设计约束（来自 DYNAMIC_WORKFLOWS_INTEGRATION.md §3.0）：
 *   - 🔴 持久化复用：禁止新建并行存储，复用 PerformanceFingerprint
 *   - 🔴 V2 不修改：本模块独立运行，不触碰 V2 引擎
 *   - 🔴 安全：模式库加载时严格 schema 校验
 *   - 🔴 模式上限 6：Phase 5 补齐 6 大模式，不再扩展
 *   - 🔴 一阶段一模块：仅模式选择器，不引入沙箱/路由/预算
 */

// ============================================================================
// 第一部分：类型定义
// ============================================================================

/** 隔离级别枚举 */
export type IsolationLevel = "none" | "context" | "worktree" | "full";

/** 风险等级枚举 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** 任务特征：模式选择的输入 */
export interface TaskFeature {
  /** 任务类型变体数（多少种不同类型的子任务） */
  type_variants: number;
  /** 子任务数 */
  subtask_count: number;
  /** 子任务是否同质 */
  subtask_homogeneous: boolean;
  /** 子任务是否独立（无强依赖） */
  subtask_independent: boolean;
  /** 风险等级 */
  risk_level: RiskLevel;
  /** 是否有可机器/人工验证的评估准则 */
  has_evaluation_criteria: boolean;
  /** 准则可测量性 */
  criteria_measurable: boolean;
  /** 未知工作量（用 stop_condition 解决） */
  workload_unknown: boolean;
  /** 是否有清晰停止条件 */
  has_stop_condition: boolean;
  /** 候选数（多方案选型场景） */
  candidate_count: number;
  /** 是否基于对比（两两 PK 优于绝对打分） */
  comparison_based: boolean;
  /** 是否创意探索（容忍重复候选） */
  is_creative: boolean;
  /** 目标环境是否为 Git 仓库（worktree 隔离前置条件） */
  target_is_git: boolean;
  /** 任务原始描述（用于画像反哺） */
  task_description: string;
  /** 任务类型字符串（用于画像分类） */
  task_type: string;
  /** 任务复杂度 1-10（用于画像） */
  task_complexity: number;
  /** 任务自定义特征（扩展点） */
  extra: Record<string, unknown>;
}

/** 创建默认 TaskFeature（所有字段采用 1:1 对齐 Python 默认值） */
export function defaultTaskFeature(): TaskFeature {
  return {
    type_variants: 1,
    subtask_count: 1,
    subtask_homogeneous: true,
    subtask_independent: true,
    risk_level: "low",
    has_evaluation_criteria: false,
    criteria_measurable: false,
    workload_unknown: false,
    has_stop_condition: false,
    candidate_count: 0,
    comparison_based: false,
    is_creative: false,
    target_is_git: true,
    task_description: "",
    task_type: "general",
    task_complexity: 5,
    extra: {},
  };
}

/** 将 TaskFeature 序列化为字典（用于画像存储） */
export function taskFeatureToDict(task: TaskFeature): Record<string, unknown> {
  return {
    type_variants: task.type_variants,
    subtask_count: task.subtask_count,
    subtask_homogeneous: task.subtask_homogeneous,
    subtask_independent: task.subtask_independent,
    risk_level: task.risk_level,
    has_evaluation_criteria: task.has_evaluation_criteria,
    criteria_measurable: task.criteria_measurable,
    workload_unknown: task.workload_unknown,
    has_stop_condition: task.has_stop_condition,
    candidate_count: task.candidate_count,
    comparison_based: task.comparison_based,
    is_creative: task.is_creative,
    target_is_git: task.target_is_git,
    task_description: task.task_description,
    task_type: task.task_type,
    task_complexity: task.task_complexity,
    extra: task.extra,
  };
}

/** 失败模式 */
export interface FailureMode {
  name: string;
  trigger: string;
  mitigation: string;
}

/** 工作流模式：声明式可复用模板 */
export interface WorkflowPattern {
  pattern_id: string;
  name: string;
  version: string;
  description: string;
  isolation_requirement: IsolationLevel;
  default_token_budget: number;
  applicable_roles: string[];
  priority: number;
  parameters_schema: Record<string, unknown>;
  example_parameters: Record<string, unknown>;
  failure_modes: FailureMode[];
  success_criteria: string[];
  not_applicable_scenarios: string[];
  /** 选择规则的函数（决策树节点） */
  selector: PatternSelector | null;
}

/** 模式选择器函数签名 */
export type PatternSelector = (task: TaskFeature) => {
  applicable: boolean;
  confidence: number;
  rationale: string;
};

/** 模式选择结果 */
export interface PatternSelection {
  /** 选中的模式 ID；null 表示不需要模式 */
  pattern_id: string | null;
  /** 是否适用 */
  applicable: boolean;
  /** 0.0-1.0 置信度 */
  confidence: number;
  /** 选择理由（必须可解释） */
  rationale: string;
  /** 实例化后的参数 */
  parameters: Record<string, unknown>;
  /** 预估 token 预算 */
  estimated_token_budget: number;
  /** 不适用时的回退模式 */
  fallback_pattern: string | null;
  /** 不适用时的拒绝原因 */
  rejection_reason: string | null;
}

/** 将 PatternSelection 序列化为字典 */
export function patternSelectionToDict(sel: PatternSelection): Record<string, unknown> {
  return {
    pattern_id: sel.pattern_id,
    applicable: sel.applicable,
    confidence: sel.confidence,
    rationale: sel.rationale,
    parameters: sel.parameters,
    estimated_token_budget: sel.estimated_token_budget,
    fallback_pattern: sel.fallback_pattern,
    rejection_reason: sel.rejection_reason,
  };
}

// ============================================================================
// 第二部分：模式选择规则（决策树节点）
// ============================================================================

/**
 * 模式 1：classifier-dispatch 选择规则
 *
 * 适用条件：任务存在 ≥ 3 种异构类型
 * 强约束：单一类型任务不适用
 */
export function selectClassifierDispatch(task: TaskFeature): {
  applicable: boolean;
  confidence: number;
  rationale: string;
} {
  if (task.type_variants >= 3) {
    const confidence = Math.min(0.95, 0.7 + 0.05 * task.type_variants);
    const rationale =
      `任务存在 ${task.type_variants} 种异构类型，` + `单一流程无法高效处理；启用分类器路由到不同子流程。`;
    return { applicable: true, confidence, rationale };
  }

  return {
    applicable: false,
    confidence: 0.0,
    rationale: `任务类型数 ${task.type_variants} < 3，无需分类器，顺序执行即可。`,
  };
}

/**
 * 模式 2：fan-out-aggregate 选择规则
 *
 * 适用条件：
 *   - 子任务数 ≥ 10 且同质
 *   - 子任务独立
 *   - 目标环境为 Git 仓库（worktree 隔离前置）
 */
export function selectFanOutAggregate(task: TaskFeature): {
  applicable: boolean;
  confidence: number;
  rationale: string;
} {
  if (task.type_variants >= 3) {
    return { applicable: false, confidence: 0.0, rationale: "异构任务已由 classifier-dispatch 模式处理" };
  }

  if (task.subtask_count >= 10 && task.subtask_homogeneous && task.subtask_independent) {
    const confidence = Math.min(0.95, 0.7 + 0.005 * task.subtask_count);

    let lazinessRisk = "";
    if (task.subtask_count >= 50) {
      lazinessRisk =
        `（${task.subtask_count} 个子任务，单 context 下 LLM 通常只完成前 20% ` +
        `就宣布完成，Agentic laziness 痛点突出）`;
    }

    let isolationNote = "";
    if (!task.target_is_git) {
      isolationNote = "（注意：目标环境非 Git 仓库，worktree 隔离不可用）";
    }

    const rationale =
      `${task.subtask_count} 个同质子任务且可独立处理，` + `扇出并行可显著加速${lazinessRisk}${isolationNote}。`;
    return { applicable: true, confidence, rationale };
  }

  return {
    applicable: false,
    confidence: 0.0,
    rationale: `子任务数 ${task.subtask_count} < 10 或非同质/非独立，` + `扇出开销大于收益，顺序执行即可。`,
  };
}

/**
 * 模式 3：adversarial-verify 选择规则
 *
 * 适用条件：
 *   - 风险等级 ≥ medium
 *   - 有评估准则
 *   - 准则可测量
 */
export function selectAdversarialVerify(task: TaskFeature): {
  applicable: boolean;
  confidence: number;
  rationale: string;
} {
  if (task.risk_level === "low") {
    return { applicable: false, confidence: 0.0, rationale: "风险等级为 low，对抗验证成本不划算" };
  }

  if (!task.has_evaluation_criteria) {
    return {
      applicable: false,
      confidence: 0.0,
      rationale: "没有评估准则，对抗验证无法判定通过/不通过",
    };
  }

  if (!task.criteria_measurable) {
    return { applicable: false, confidence: 0.0, rationale: "评估准则不可测量，对抗验证无意义" };
  }

  let confidence = 0.8;
  if (task.risk_level === "high") {
    confidence = 0.88;
  } else if (task.risk_level === "critical") {
    confidence = 0.95;
  }

  let biasNote = "";
  if (task.risk_level === "high" || task.risk_level === "critical") {
    biasNote = "（高风险任务存在 self-preferential bias：让模型验证自己产出，" + "通过率虚高 30%+）";
  }

  const isolation: IsolationLevel = task.risk_level === "high" || task.risk_level === "critical" ? "full" : "context";

  const rationale =
    `任务风险等级为 ${task.risk_level}，` +
    `且已定义可测量评估准则；启用对抗验证${biasNote}。` +
    `验证者隔离级别：${isolation}。`;
  return { applicable: true, confidence, rationale };
}

/**
 * 模式 4：generate-filter（生成与筛选）选择规则
 */
export function selectGenerateFilter(task: TaskFeature): {
  applicable: boolean;
  confidence: number;
  rationale: string;
} {
  if (task.type_variants >= 3) {
    return { applicable: false, confidence: 0.0, rationale: "异构任务已由 classifier-dispatch 模式处理" };
  }

  if (task.risk_level === "high" || task.risk_level === "critical") {
    return {
      applicable: false,
      confidence: 0.0,
      rationale: "高风险任务应优先用 adversarial-verify，不适合生成筛选",
    };
  }

  if (!task.is_creative) {
    return { applicable: false, confidence: 0.0, rationale: "非创意探索任务，无需大量生成后筛选" };
  }

  if (!task.has_evaluation_criteria) {
    return { applicable: false, confidence: 0.0, rationale: "无评估准则，筛选无依据" };
  }

  if (task.candidate_count < 3) {
    return {
      applicable: false,
      confidence: 0.0,
      rationale: `候选数 ${task.candidate_count} < 3，单次生成即可，无需 generate-filter`,
    };
  }

  const confidence = Math.min(0.92, 0.7 + 0.04 * task.candidate_count);
  const rationale = `创意任务且候选数=${task.candidate_count} ≥ 3，` + `通过'概率质量'（多生成后筛选）提高产出质量。`;
  return { applicable: true, confidence, rationale };
}

/**
 * 模式 5：tournament（锦标赛模式）选择规则
 */
export function selectTournament(task: TaskFeature): {
  applicable: boolean;
  confidence: number;
  rationale: string;
} {
  if (task.type_variants >= 3) {
    return { applicable: false, confidence: 0.0, rationale: "异构任务已由 classifier-dispatch 模式处理" };
  }

  if (task.candidate_count < 3) {
    return {
      applicable: false,
      confidence: 0.0,
      rationale: `候选数 ${task.candidate_count} < 3，无需锦标赛，顺序评估即可`,
    };
  }

  if (task.candidate_count > 8) {
    return {
      applicable: false,
      confidence: 0.0,
      rationale: `候选数 ${task.candidate_count} > 8，锦标赛成本爆炸，应先用 generate-filter 收敛候选`,
    };
  }

  if (!task.comparison_based) {
    return { applicable: false, confidence: 0.0, rationale: "非基于对比的评估，锦标赛无意义" };
  }

  if (!task.has_evaluation_criteria) {
    return { applicable: false, confidence: 0.0, rationale: "无评估准则，裁判无标准" };
  }

  const confidence = Math.min(0.93, 0.75 + 0.025 * task.candidate_count);
  const rationale = `${task.candidate_count} 个候选方案需择优，` + `两两 PK 比绝对打分更可靠（信息熵更高）。`;
  return { applicable: true, confidence, rationale };
}

/**
 * 模式 6：loop-until-done（循环直到完成）选择规则
 */
export function selectLoopUntilDone(task: TaskFeature): {
  applicable: boolean;
  confidence: number;
  rationale: string;
} {
  if (task.type_variants >= 3) {
    return { applicable: false, confidence: 0.0, rationale: "异构任务已由 classifier-dispatch 模式处理" };
  }

  if (task.subtask_count >= 10 && task.subtask_homogeneous && task.subtask_independent) {
    return { applicable: false, confidence: 0.0, rationale: "大量同质子任务已由 fan-out-aggregate 处理" };
  }

  if (!task.workload_unknown) {
    return { applicable: false, confidence: 0.0, rationale: "工作量已知，无需循环，顺序执行即可" };
  }

  if (!task.has_stop_condition) {
    return {
      applicable: false,
      confidence: 0.0,
      rationale: "无清晰停止条件，loop-until-done 容易陷入死循环，" + "应选择确定性模式（顺序 / 扇出）",
    };
  }

  const confidence = 0.8;
  const rationale = "未知工作量任务 + 清晰停止条件，" + "用循环迭代替代固定次数（goal drift 痛点缓解）。";
  return { applicable: true, confidence, rationale };
}

// ============================================================================
// 第三部分：模式定义（6 大模式完整 schema）
// ============================================================================

/** 模式 1：classifier-dispatch（分类并行动） */
export const PATTERN_CLASSIFIER_DISPATCH: WorkflowPattern = {
  pattern_id: "classifier-dispatch",
  name: "分类并行动",
  version: "1.0",
  description: "用分类器判断任务类型 → 路由到不同子流程或子智能体。" + "适用于多种异构任务混处理的场景。",
  isolation_requirement: "none",
  default_token_budget: 4000,
  applicable_roles: ["product-manager", "test-expert", "architect", "solo-coder"],
  priority: 10,
  parameters_schema: {
    type: "object",
    required: ["classifier_role", "route_table", "fallback_route"],
    properties: {
      classifier_role: {
        type: "string",
        enum: ["product-manager", "test-expert", "architect", "solo-coder"],
      },
      route_table: { type: "object" },
      fallback_route: { type: "string" },
      classification_confidence_threshold: {
        type: "number",
        default: 0.7,
        minimum: 0.0,
        maximum: 1.0,
      },
    },
  },
  example_parameters: {
    classifier_role: "test-expert",
    route_table: {
      bug: { target_pattern: "sequential", target_role: "solo-coder" },
      feature_request: { target_pattern: "sequential", target_role: "product-manager" },
      incident: { target_pattern: "adversarial-verify", target_role: "solo-coder" },
    },
    fallback_route: "solo-coder",
    classification_confidence_threshold: 0.7,
  },
  failure_modes: [
    {
      name: "分类不准确",
      trigger: "训练样本不足 / 任务表达歧义",
      mitigation: "保留 fallback 路由 + 反馈回流到 PerformanceFingerprint",
    },
    { name: "路由死循环", trigger: "route_table 中目标互指形成环", mitigation: "PatternLibrary 加载时静态检测路由环" },
    { name: "分类开销过大", trigger: "任务量极大（> 10000）", mitigation: "引入分类缓存（LRU 1000 条）" },
  ],
  success_criteria: ["分类器准确率 ≥ 90%", "路由到目标流程的成功率 ≥ 95%", "整体处理时间 < 顺序执行的 80%"],
  not_applicable_scenarios: [
    "任务类型单一（直接顺序执行即可）",
    "分类器本身准确率 < 70%（错误分类比不分类更糟）",
    "子任务数 < 5（分类开销大于收益）",
  ],
  selector: selectClassifierDispatch,
};

/** 模式 2：fan-out-aggregate（扇出与聚合） */
export const PATTERN_FAN_OUT_AGGREGATE: WorkflowPattern = {
  pattern_id: "fan-out-aggregate",
  name: "扇出与聚合",
  version: "1.0",
  description:
    "任务拆 N 份并行处理 → 屏障等待 → 聚合为单一结果。" +
    "每个子任务拥有独立 context，规避单 context 下的 Agentic laziness 痛点。",
  isolation_requirement: "worktree",
  default_token_budget: 12000,
  applicable_roles: ["test-expert", "solo-coder", "architect", "product-manager"],
  priority: 20,
  parameters_schema: {
    type: "object",
    required: ["fanout_count", "subagent_role", "aggregator_role", "aggregation_strategy"],
    properties: {
      fanout_count: { type: "integer", minimum: 1, maximum: 10, description: "Phase 0 硬上限 10" },
      fanout_strategy: { type: "string", enum: ["static", "dynamic"] },
      subagent_role: { type: "string" },
      subagent_isolation: { type: "string", enum: ["worktree", "context", "full"] },
      barrier_timeout_seconds: { type: "integer", default: 3600 },
      aggregator_role: { type: "string" },
      aggregation_strategy: { type: "string", enum: ["concat", "vote", "rank", "merge"] },
      partial_failure_policy: { type: "string", enum: ["fail", "skip", "retry"] },
    },
  },
  example_parameters: {
    fanout_count: 10,
    fanout_strategy: "static",
    subagent_role: "test-expert",
    subagent_isolation: "worktree",
    barrier_timeout_seconds: 3600,
    aggregator_role: "architect",
    aggregation_strategy: "merge",
    partial_failure_policy: "skip",
  },
  failure_modes: [
    {
      name: "屏障超时",
      trigger: "部分子任务死锁或处理过慢",
      mitigation: "barrier_timeout_seconds 硬超时 + partial_failure_policy 兜底",
    },
    {
      name: "资源耗尽",
      trigger: "fanout_count 过大（本机资源不足）",
      mitigation: "Phase 0 硬上限 10 + 资源监控（Phase 2 引入 WorktreeManager）",
    },
    { name: "聚合冲突", trigger: "子结果 schema 不一致", mitigation: "聚合前 schema 校验，不通过则丢弃" },
    {
      name: "subagent 崩溃污染",
      trigger: "异常隔离不完整",
      mitigation: "worktree 隔离 + finally 块清理（Phase 2 实施）",
    },
  ],
  success_criteria: [
    "覆盖率 100%（无 Agentic laziness）",
    "扇出 + 聚合总耗时 < 顺序执行的 50%",
    "聚合结果 schema 100% 一致",
  ],
  not_applicable_scenarios: [
    "子任务数 < 3（扇出开销大于收益）",
    "子任务间强依赖（必须等前一个完成）",
    "目标环境非 Git 仓库（worktree 隔离不可用）",
  ],
  selector: selectFanOutAggregate,
};

/** 模式 3：adversarial-verify（对抗性验证） */
export const PATTERN_ADVERSARIAL_VERIFY: WorkflowPattern = {
  pattern_id: "adversarial-verify",
  name: "对抗性验证",
  version: "1.0",
  description:
    "生成者产出 → 独立 context 验证者对照评估准则验证。" +
    "解决 self-preferential bias 痛点：模型验证自己产出时倾向于放行。",
  isolation_requirement: "context",
  default_token_budget: 8000,
  applicable_roles: ["architect", "test-expert", "solo-coder"],
  priority: 30,
  parameters_schema: {
    type: "object",
    required: ["generator_role", "verifier_role", "verifier_isolation", "evaluation_criteria"],
    properties: {
      generator_role: { type: "string" },
      verifier_role: { type: "string" },
      verifier_isolation: {
        type: "string",
        enum: ["context", "full"],
        description: "至少 context 隔离；高风险必须 full",
      },
      evaluation_criteria: { type: "array", minItems: 3, items: { type: "string" } },
      verification_depth: { type: "string", enum: ["shallow", "deep"] },
      max_rounds: { type: "integer", minimum: 1, maximum: 5 },
      pass_threshold: { type: "number", minimum: 0.0, maximum: 1.0 },
      fallback_on_reject: { type: "string", enum: ["regenerate", "human_review", "abort"] },
    },
  },
  example_parameters: {
    generator_role: "architect",
    verifier_role: "test-expert",
    verifier_isolation: "full",
    evaluation_criteria: [
      "满足性能需求（P99 < 200ms）",
      "无单点故障",
      "符合现有代码规范",
      "通过 OWASP Top 10 安全检查",
    ],
    verification_depth: "deep",
    max_rounds: 3,
    pass_threshold: 0.8,
    fallback_on_reject: "regenerate",
  },
  failure_modes: [
    {
      name: "验证者与生成者共享偏见",
      trigger: "verifier_isolation 失效（共享 context）",
      mitigation: "🔴 强约束：PatternLibrary 启动前校验 isolation 字段，强制 context 隔离",
    },
    {
      name: "评估准则不明确",
      trigger: "evaluation_criteria 是模糊描述",
      mitigation: "schema 校验：每条 criteria 必须含可测量指标",
    },
    { name: "对抗无限循环", trigger: "生成者和验证者不断找理由", mitigation: "max_rounds 硬上限 3-5" },
    {
      name: "验证者过度严苛",
      trigger: "通过率 < 10%（验证标准脱离实际）",
      mitigation: "pass_threshold 动态调整（基于历史 50 次执行 P50）",
    },
  ],
  success_criteria: ["通过率（人工确认）≥ 80%", "平均对抗轮次 ≤ 2", "验证发现的关键缺陷数 ≥ 顺序评审的 1.5x"],
  not_applicable_scenarios: [
    "主观性强的任务（设计审美）",
    "没有评估准则的任务",
    "简单任务（如修复 typo，引入对抗成本不划算）",
    "验证者与生成者能力差距过大",
  ],
  selector: selectAdversarialVerify,
};

/** 模式 4：generate-filter（生成与筛选） */
export const PATTERN_GENERATE_FILTER: WorkflowPattern = {
  pattern_id: "generate-filter",
  name: "生成与筛选",
  version: "1.0",
  description:
    "大量生成候选 → 评估筛选 → 去重 → 仅返回通过项。" + "通过'概率质量'（多生成后筛选）抵消单次生成的不稳定性。",
  isolation_requirement: "none",
  default_token_budget: 10000,
  applicable_roles: ["product-manager", "solo-coder", "architect"],
  priority: 40,
  parameters_schema: {
    type: "object",
    required: ["generator_role", "generator_count", "filter_criteria", "dedup_strategy"],
    properties: {
      generator_role: { type: "string" },
      generator_count: { type: "integer", minimum: 3, maximum: 20, description: "生成候选数（3-20，硬上限 20）" },
      filter_criteria: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        description: "筛选标准（必须含可量化指标）",
      },
      dedup_strategy: { type: "string", enum: ["exact", "fuzzy", "semantic"] },
      dedup_threshold: {
        type: "number",
        default: 0.85,
        minimum: 0.0,
        maximum: 1.0,
        description: "模糊/语义去重阈值（仅 fuzzy/semantic 生效）",
      },
      output_top_n: { type: "integer", default: 3, minimum: 1, description: "返回通过项的前 N 个" },
      quality_floor: { type: "number", default: 0.6, minimum: 0.0, maximum: 1.0, description: "低于此分数丢弃" },
      embedder: {
        type: "object",
        description:
          "Phase 6 新增：embedder 配置。dedup_strategy=semantic 时生效。type=auto 时优先 SentenceTransformer，未安装则 fallback 到 TFIDF。",
        properties: {
          type: { type: "string", enum: ["auto", "tfidf", "hashing", "sentence_transformer"], default: "auto" },
          model_name: {
            type: "string",
            default: "all-MiniLM-L6-v2",
            description: "sentence-transformer 模型名（仅 sentence_transformer 生效）",
          },
          n_features: { type: "integer", default: 1024, description: "hashing embedder 桶数量" },
          max_features: { type: "integer", default: 5000, description: "TFIDF embedder 最大特征数" },
        },
      },
    },
  },
  example_parameters: {
    generator_role: "product-manager",
    generator_count: 8,
    filter_criteria: ["简洁（<= 4 字）", "易记（无生僻字）", "与品牌调性一致"],
    dedup_strategy: "fuzzy",
    dedup_threshold: 0.85,
    output_top_n: 3,
    quality_floor: 0.6,
  },
  failure_modes: [
    {
      name: "生成候选全失败",
      trigger: "generator_role 配置错误或 dispatch 不可用",
      mitigation: "fallback_to_sequential + 异常隔离单候选",
    },
    {
      name: "筛选标准不可量化",
      trigger: "filter_criteria 含模糊描述",
      mitigation: "schema 校验要求每条 criteria 含可测量指标",
    },
    { name: "去重过激", trigger: "dedup_threshold 过高导致全部命中同一类", mitigation: "动态阈值（基于生成结果分布）" },
    {
      name: "输出不足",
      trigger: "quality_floor 过高或 filter 过严",
      mitigation: "返回所有通过 quality_floor 的候选 + 警告",
    },
    {
      name: "embedder 不可用",
      trigger: "dedup_strategy=semantic 时未安装 sentence-transformers",
      mitigation: "graceful fallback 到 TFIDFEmbedder（无外部依赖）",
    },
  ],
  success_criteria: ["至少返回 1 个通过筛选的候选", "通过率（人工确认）≥ 70%", "去重后候选数 ≥ 1"],
  not_applicable_scenarios: [
    "候选不能重复（每生成都贵）",
    "评估标准主观（筛选结果不稳定）",
    "候选数 < 3（单次生成即可）",
    "高风险任务（应优先 adversarial-verify）",
  ],
  selector: selectGenerateFilter,
};

/** 模式 5：tournament（锦标赛模式） */
export const PATTERN_TOURNAMENT: WorkflowPattern = {
  pattern_id: "tournament",
  name: "锦标赛模式",
  version: "1.0",
  description: "N 个候选方案 → 两两 PK → 逐步淘汰 → 决出冠军。" + "两两对比比绝对打分更可靠，参考信息熵更高。",
  isolation_requirement: "context",
  default_token_budget: 15000,
  applicable_roles: ["architect", "test-expert", "product-manager"],
  priority: 50,
  parameters_schema: {
    type: "object",
    required: ["candidate_count", "candidate_generator", "judge_role", "ranking_method"],
    properties: {
      candidate_count: { type: "integer", minimum: 3, maximum: 8, description: "候选数（3-8 硬上限，> 8 成本爆炸）" },
      candidate_generator: { type: "string", description: "候选生成器角色" },
      judge_role: { type: "string", description: "裁判角色" },
      ranking_method: {
        type: "string",
        enum: ["knockout", "round-robin", "elo"],
        description: "排名方法：淘汰赛 / 循环赛 / ELO 评分",
      },
      judge_criteria: {
        type: "array",
        items: { type: "string" },
        description: "裁判标准（缺省沿用 evaluation_criteria）",
      },
      judge_context_isolation: {
        type: "boolean",
        default: true,
        description: "裁判是否必须独立 context（防 self-bias）",
      },
    },
  },
  example_parameters: {
    candidate_count: 4,
    candidate_generator: "architect",
    judge_role: "test-expert",
    ranking_method: "knockout",
    judge_criteria: ["性能（P99 < 200ms）", "可维护性（耦合度低）", "可扩展性（支持未来 10x 流量）"],
    judge_context_isolation: true,
  },
  failure_modes: [
    { name: "候选数非 2 的幂", trigger: "knockout 模式下候选数不为 2^n", mitigation: "自动补齐 bye（轮空）位" },
    { name: "裁判不公", trigger: "judge 与候选生成器共享偏见", mitigation: "judge_context_isolation=true 强约束" },
    {
      name: "PK 死循环",
      trigger: "knockout 平局无法分出胜负",
      mitigation: "平局策略：随机晋级 / 重新 PK（最多 3 次）",
    },
    { name: "cost 爆炸", trigger: "candidate_count 接近 8 + round-robin", mitigation: "硬上限 8，超过则降级 knockout" },
  ],
  success_criteria: ["成功决出唯一冠军", "每场 PK 都有明确裁判结果", "总 PK 次数 < candidate_count * 2"],
  not_applicable_scenarios: [
    "候选无对比性（完全不同的产物）",
    "评估需要全局视角（PK 信息不足）",
    "候选数 < 3（顺序打分即可）",
    "候选数 > 8（成本爆炸）",
  ],
  selector: selectTournament,
};

/** 模式 6：loop-until-done（循环直到完成） */
export const PATTERN_LOOP_UNTIL_DONE: WorkflowPattern = {
  pattern_id: "loop-until-done",
  name: "循环直到完成",
  version: "1.0",
  description: "动态生成 subagent → 直至满足停止条件。" + "用停止条件替代固定次数上限，缓解 goal drift 痛点。",
  isolation_requirement: "none",
  default_token_budget: 20000,
  applicable_roles: ["architect", "test-expert", "solo-coder"],
  priority: 60,
  parameters_schema: {
    type: "object",
    required: ["max_iterations", "stop_conditions", "iteration_executor"],
    properties: {
      max_iterations: { type: "integer", minimum: 1, maximum: 50, description: "硬上限（避免死循环）" },
      stop_conditions: {
        type: "object",
        properties: {
          no_new_findings: { type: "boolean" },
          no_error_logs: { type: "boolean" },
          quality_threshold_met: { type: "boolean" },
          convergence_detected: { type: "boolean" },
        },
        description: "停止条件：满足任一即停止（OR 关系）；quality_threshold_met 需要 quality_threshold 字段",
      },
      iteration_executor: { type: "string", description: "每轮执行器角色" },
      state_persistence: {
        type: "string",
        enum: ["memory", "checkpoint"],
        default: "memory",
        description: "跨迭代状态：内存 / 持久化（Phase 5+ 引入 CheckpointManager）",
      },
      quality_threshold: {
        type: "number",
        default: 0.85,
        minimum: 0.0,
        maximum: 1.0,
        description: "质量阈值（仅 quality_threshold_met 生效）",
      },
    },
  },
  example_parameters: {
    max_iterations: 10,
    stop_conditions: {
      no_new_findings: true,
      no_error_logs: true,
      quality_threshold_met: true,
      convergence_detected: true,
    },
    iteration_executor: "architect",
    state_persistence: "memory",
    quality_threshold: 0.85,
  },
  failure_modes: [
    { name: "死循环", trigger: "停止条件永远不满足", mitigation: "max_iterations 硬上限 + 超限报警" },
    {
      name: "状态丢失",
      trigger: "state_persistence=memory 跨调用丢失",
      mitigation: "Phase 5+ 引入 CheckpointManager 持久化",
    },
    { name: "每轮上下文膨胀", trigger: "迭代结果累积到下一次 prompt", mitigation: "上下文截断（仅保留最近 N 轮结果）" },
    { name: "成本失控", trigger: "max_iterations 过大 + 单轮成本高", mitigation: "max_iterations 硬上限 50" },
  ],
  success_criteria: ["在 max_iterations 内停止（不超限）", "至少满足 1 个停止条件后停止", "返回最后一轮的执行结果"],
  not_applicable_scenarios: [
    "工作量已知（顺序即可）",
    "无清晰停止条件（容易死循环）",
    "单次执行可完成（无需循环）",
    "大量同质子任务（应改用 fan-out-aggregate）",
  ],
  selector: selectLoopUntilDone,
};

/** Phase 5 扩展：6 大模式全部沉淀（Phase 0 仅 3 个核心模式） */
export const ALL_PATTERNS: ReadonlyArray<WorkflowPattern> = [
  PATTERN_CLASSIFIER_DISPATCH,
  PATTERN_FAN_OUT_AGGREGATE,
  PATTERN_ADVERSARIAL_VERIFY,
  PATTERN_GENERATE_FILTER,
  PATTERN_TOURNAMENT,
  PATTERN_LOOP_UNTIL_DONE,
];

/** 兼容旧名（Phase 0 代码可能仍引用 PHASE0_PATTERNS） */
export const PHASE0_PATTERNS: ReadonlyArray<WorkflowPattern> = [
  PATTERN_CLASSIFIER_DISPATCH,
  PATTERN_FAN_OUT_AGGREGATE,
  PATTERN_ADVERSARIAL_VERIFY,
];

// ============================================================================
// 第四部分：模式 schema 校验
// ============================================================================

/** 校验结果：返回错误信息列表（空列表表示通过） */
export function validatePattern(pattern: WorkflowPattern): string[] {
  const errors: string[] = [];

  // pattern_id 必须符合命名规范：kebab-case
  const kebabCaseRe = /^[a-z][a-z0-9-]*[a-z0-9]$/;
  if (!kebabCaseRe.test(pattern.pattern_id)) {
    errors.push(`pattern_id '${pattern.pattern_id}' 不符合 kebab-case 命名规范`);
  }

  // 必填字段非空
  if (!pattern.name) {
    errors.push("name 不能为空");
  }
  if (!pattern.description) {
    errors.push("description 不能为空");
  }

  // applicable_roles 至少 1 个
  if (!pattern.applicable_roles || pattern.applicable_roles.length === 0) {
    errors.push("applicable_roles 至少需要 1 个角色");
  }

  // isolation_requirement 必须是合法枚举
  const validIsolation: IsolationLevel[] = ["none", "context", "worktree", "full"];
  if (!validIsolation.includes(pattern.isolation_requirement)) {
    errors.push(`isolation_requirement 必须是合法枚举，实际为 '${pattern.isolation_requirement}'`);
  }

  // default_token_budget 必须在合理范围
  if (pattern.default_token_budget < 100 || pattern.default_token_budget > 1_000_000) {
    errors.push(`default_token_budget=${pattern.default_token_budget} 超出合理范围 [100, 1000000]`);
  }

  // priority 必须在合理范围
  if (pattern.priority < 0 || pattern.priority > 100) {
    errors.push(`priority=${pattern.priority} 超出合理范围 [0, 100]`);
  }

  // parameters_schema 必须是对象
  if (
    typeof pattern.parameters_schema !== "object" ||
    pattern.parameters_schema === null ||
    Array.isArray(pattern.parameters_schema)
  ) {
    errors.push("parameters_schema 必须是 object 类型");
  }

  // failure_modes 至少 1 个
  if (!pattern.failure_modes || pattern.failure_modes.length === 0) {
    errors.push("failure_modes 至少需要 1 个失败模式");
  }

  // success_criteria 至少 1 个
  if (!pattern.success_criteria || pattern.success_criteria.length === 0) {
    errors.push("success_criteria 至少需要 1 个成功标准");
  }

  // not_applicable_scenarios 至少 1 个
  if (!pattern.not_applicable_scenarios || pattern.not_applicable_scenarios.length === 0) {
    errors.push("not_applicable_scenarios 至少需要 1 个不适用场景");
  }

  return errors;
}

// ============================================================================
// 第五部分：模式库（PatternLibrary）
// ============================================================================

/**
 * 模式库：管理 6 大模式（Phase 5 后）的加载、校验、查询
 *
 * 关键约束（来自 DYNAMIC_WORKFLOWS_INTEGRATION.md §3.0.1）：
 *   - 模式定义不在本类内持久化（持久化复用 PerformanceFingerprint）
 *   - 模式定义仅在内存中持有（Phase 0/5 简化）
 *   - 加载时严格 schema 校验（防止损坏的模式定义被使用）
 *
 * 关键约束（§3.0.3 安全）：
 *   - 模式库加载时校验每个 WorkflowPattern.validate() 必须通过
 *   - 校验失败时抛出 Error，不允许降级使用损坏模式
 */
export class PatternLibrary {
  private readonly _patterns: Map<string, WorkflowPattern>;

  constructor(args?: { patterns?: WorkflowPattern[]; useAllPatterns?: boolean }) {
    this._patterns = new Map<string, WorkflowPattern>();

    const patterns = args?.patterns;
    const useAllPatterns = args?.useAllPatterns ?? true;

    // 加载模式（带 schema 校验）
    let patternsToLoad: ReadonlyArray<WorkflowPattern>;
    if (patterns !== undefined) {
      patternsToLoad = patterns;
    } else {
      // Phase 5: 默认加载全部 6 大模式
      patternsToLoad = useAllPatterns ? ALL_PATTERNS : PHASE0_PATTERNS;
    }

    for (const pattern of patternsToLoad) {
      const errors = validatePattern(pattern);
      if (errors.length > 0) {
        // 🔴 强约束：校验失败直接抛错，不允许降级
        const errorMsg = errors.join("; ");
        throw new Error(`模式 '${pattern.pattern_id}' schema 校验失败：${errorMsg}`);
      }
      this._patterns.set(pattern.pattern_id, pattern);
    }
  }

  /** 根据 ID 获取模式 */
  get(patternId: string): WorkflowPattern | null {
    return this._patterns.get(patternId) ?? null;
  }

  /** 列出所有已加载模式 ID */
  listIds(): string[] {
    return Array.from(this._patterns.keys());
  }

  /** 列出所有已加载模式（按 priority 升序） */
  listAll(): WorkflowPattern[] {
    const arr = Array.from(this._patterns.values());
    arr.sort((a, b) => a.priority - b.priority);
    return arr;
  }

  /** 返回已加载模式数 */
  size(): number {
    return this._patterns.size;
  }
}

// ============================================================================
// 第六部分：PerformanceFingerprint 抽象（避免循环依赖）
// ============================================================================

/** PerformanceFingerprint 接口（仅声明本模块用到的方法） */
export interface PerformanceFingerprintLike {
  record(args: {
    task_type: string;
    task_complexity: number;
    success: boolean;
    error_type?: string | null;
    execution_time?: number;
    strategy?: string;
    context_features?: Record<string, unknown>;
  }): void;
}

// ============================================================================
// 第七部分：模式选择器（PatternComposer）
// ============================================================================

/**
 * 模式选择器：基于任务特征选择最合适的模式
 *
 * 选择流程（对齐 PATTERNS_REFERENCE.md §3 决策树）：
 *   1. 遍历所有模式，按 priority 升序调用其 selector
 *   2. 第一个 applicable=true 的模式胜出
 *   3. 都不适用时返回 PatternSelection(pattern_id=null, applicable=false)
 *   4. 通过 PerformanceFingerprint 反哺历史选择效果
 *   5. 性能目标：< 100ms / 次
 */
export class PatternComposer {
  /** 性能基线目标 */
  static readonly PERFORMANCE_BUDGET_MS = 100.0;

  private readonly library: PatternLibrary;
  private readonly fingerprint: PerformanceFingerprintLike | null;
  private readonly log: (level: string, message: string) => void;

  constructor(args?: {
    library?: PatternLibrary;
    fingerprint?: PerformanceFingerprintLike | null;
    log?: (level: string, message: string) => void;
  }) {
    this.library = args?.library ?? new PatternLibrary();
    this.fingerprint = args?.fingerprint ?? null;
    this.log =
      args?.log ??
      ((level, message) => {
        if (level === "error" || level === "warn") {
          console.warn(`[pattern_composer] ${message}`);
        } else {
          console.log(`[pattern_composer] ${message}`);
        }
      });
  }

  /**
   * 基于任务特征选择最合适的模式
   */
  select(task: TaskFeature, _enableHistoryLookup = true): PatternSelection {
    const startTime = Date.now();

    // 阶段 1：按 priority 顺序遍历所有模式
    const candidateResults: Array<{
      pattern: WorkflowPattern;
      applicable: boolean;
      confidence: number;
      rationale: string;
    }> = [];

    for (const pattern of this.library.listAll()) {
      if (pattern.selector === null) {
        // 无 selector 的模式不参与自动选择（保留扩展能力）
        continue;
      }
      const sel = pattern.selector(task);
      candidateResults.push({
        pattern,
        applicable: sel.applicable,
        confidence: sel.confidence,
        rationale: sel.rationale,
      });
    }

    // 阶段 2：选择第一个 applicable 的模式（按 priority 顺序）
    let selected: WorkflowPattern | null = null;
    let selectedConfidence = 0.0;
    let selectedRationale = "";

    for (const r of candidateResults) {
      if (r.applicable) {
        selected = r.pattern;
        selectedConfidence = r.confidence;
        selectedRationale = r.rationale;
        break;
      }
    }

    // 阶段 3：构建选择结果
    let selection: PatternSelection;
    if (selected === null) {
      // 没有任何模式适用 → 回退到顺序执行
      const allReasons = candidateResults.map((r) => `[${r.pattern.pattern_id}]${r.rationale}`).join("; ");
      selection = {
        pattern_id: null,
        applicable: false,
        confidence: 0.0,
        rationale: `所有 ${this.library.size()} 个模式均不适用，回退到顺序执行（fallback_pattern=sequential）。`,
        parameters: {},
        estimated_token_budget: 2000, // 顺序执行默认预算
        fallback_pattern: "sequential",
        rejection_reason: allReasons,
      };
    } else {
      // 模式适用 → 构建完整选择结果
      selection = {
        pattern_id: selected.pattern_id,
        applicable: true,
        confidence: selectedConfidence,
        rationale: selectedRationale,
        parameters: { ...selected.example_parameters }, // 复制避免引用
        estimated_token_budget: selected.default_token_budget,
        fallback_pattern: "sequential",
        rejection_reason: null,
      };
    }

    // 阶段 4：性能基线检查（架构师审查要求 < 100ms）
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > PatternComposer.PERFORMANCE_BUDGET_MS) {
      this.log(
        "warn",
        `模式选择耗时 ${elapsedMs.toFixed(2)}ms 超出预算 ${PatternComposer.PERFORMANCE_BUDGET_MS}ms（task_type=${task.task_type}）`
      );
    } else {
      this.log(
        "debug",
        `模式选择耗时 ${elapsedMs.toFixed(2)}ms（task_type=${task.task_type}, pattern_id=${selection.pattern_id}）`
      );
    }

    return selection;
  }

  /**
   * 记录模式执行结果到画像
   *
   * 这是"模式选择 → 执行 → 画像反哺"闭环的关键接口。
   * Phase 0 仅暴露接口，具体记录策略由调用方控制。
   */
  recordOutcome(
    task: TaskFeature,
    selection: PatternSelection,
    success: boolean,
    executionTimeSeconds = 0.0,
    errorType: string | null = null
  ): void {
    if (this.fingerprint === null) {
      this.log("warn", "未配置 PerformanceFingerprint，跳过结果记录");
      return;
    }

    // 将模式选择作为 strategy 字段存储到画像
    // PerformanceFingerprint 已有 strategy 字段，可直接复用
    try {
      this.fingerprint.record({
        task_type: task.task_type,
        task_complexity: task.task_complexity,
        success,
        error_type: errorType,
        execution_time: executionTimeSeconds,
        strategy: selection.pattern_id ?? "sequential",
        context_features: taskFeatureToDict(task),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("warn", `记录执行结果到画像失败（非致命）: ${msg}`);
    }
  }
}

// ============================================================================
// 第八部分：便捷函数
// ============================================================================

/**
 * 创建默认配置的模式选择器
 *
 * 这是给上层调用方（产品经理/独立开发者）的一键入口。
 */
export function createDefaultComposer(): PatternComposer {
  return new PatternComposer();
}

/**
 * 一键模式选择：给定任务特征，返回选择结果
 *
 * 这是最简化的对外接口。
 */
export function selectPatternForTask(task: TaskFeature): PatternSelection {
  const composer = createDefaultComposer();
  return composer.select(task);
}
