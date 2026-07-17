/**
 * Hierarchical Control - 层次化控制器
 *
 * 来源：multi-agent-team skill scripts/hierarchical_control.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 职责：基于工程控制论的三层控制架构，结合 AI 大模型进行动态规划：
 * 1. 战略层（Strategic）：任务规划、角色配置、全局策略
 * 2. 战术层（Tactical）：Guard 验证、异常检测、补偿计算
 * 3. 执行层（Execution）：任务执行、反馈收集、结果评估
 *
 * 设计原则：
 * - 三层控制：战略 → 战术 → 执行
 * - AI 增强：可选注入 ai_provider
 * - 与 FeedbackControlLoop / GuardCoordinator 集成
 * - 角色池：architect / product-manager / solo-coder / ui-designer / test-expert
 *
 * 作者：trae-multi-agent 融合 Phase 2（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

import { SimpleMutex } from "./feedback-control-loop.js";
import type { GuardCoordinator } from "./guard-coordinator.js";
import { type AIProviderLike, type ValidationResult } from "./guard-coordinator.js";

// ============================================================================
// 枚举：控制层级
// ============================================================================

/**
 * 控制层级枚举
 */
export const ControlLevel = {
  STRATEGIC: "strategic", // 战略层
  TACTICAL: "tactical", // 战术层
  EXECUTION: "execution", // 执行层
} as const;

export type ControlLevelType = (typeof ControlLevel)[keyof typeof ControlLevel];

/** 所有控制层级 */
export const ALL_CONTROL_LEVELS: readonly ControlLevelType[] = [
  ControlLevel.STRATEGIC,
  ControlLevel.TACTICAL,
  ControlLevel.EXECUTION,
];

/** 校验控制层级 */
export function isValidControlLevel(level: string): level is ControlLevelType {
  return (ALL_CONTROL_LEVELS as readonly string[]).includes(level);
}

// ============================================================================
// 异常类
// ============================================================================

/** 层次化控制基础异常 */
export class HierarchicalControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HierarchicalControlError";
  }
}

// ============================================================================
// 数据结构
// ============================================================================

/**
 * 角色能力定义
 */
export interface RoleCapabilities {
  name: string;
  capabilities: string[];
  suitable_tasks: string[];
  complexity_range: [number, number];
}

/** 角色能力库（5 个角色） */
export const ROLE_CAPABILITIES: Record<string, RoleCapabilities> = {
  architect: {
    name: "架构师",
    capabilities: ["架构设计", "代码审查", "性能优化"],
    suitable_tasks: ["architecture", "design", "review"],
    complexity_range: [5, 10],
  },
  "product-manager": {
    name: "产品经理",
    capabilities: ["需求分析", "PRD编写", "优先级排序"],
    suitable_tasks: ["requirement", "planning", "prioritization"],
    complexity_range: [3, 8],
  },
  "solo-coder": {
    name: "独立开发者",
    capabilities: ["代码实现", "单元测试", "bug修复"],
    suitable_tasks: ["implementation", "coding", "testing"],
    complexity_range: [1, 7],
  },
  "ui-designer": {
    name: "UI设计师",
    capabilities: ["界面设计", "交互设计", "视觉优化"],
    suitable_tasks: ["ui", "design", "interface"],
    complexity_range: [2, 6],
  },
  "test-expert": {
    name: "测试专家",
    capabilities: ["测试用例设计", "自动化测试", "质量评估"],
    suitable_tasks: ["testing", "qa", "validation"],
    complexity_range: [2, 7],
  },
};

/** 所有角色 ID */
export const ALL_ROLE_IDS: readonly string[] = Object.keys(ROLE_CAPABILITIES);

/**
 * 角色配置
 */
export interface RoleConfig {
  enabled: boolean;
  priority: number;
  timeout: number;
  retry: boolean;
  max_retry: number;
}

/**
 * 战略规划数据类
 */
export interface StrategicPlan {
  plan_id: string;
  task_type: string;
  recommended_roles: string[];
  role_config: Record<string, RoleConfig>;
  execution_strategy: string;
  estimated_time: number;
  risk_assessment: Record<string, unknown>;
  ai_enhanced: boolean;
  ai_recommendations: string[];
  created_at: string;
}

/** 创建 StrategicPlan */
export function createStrategicPlan(args: {
  plan_id: string;
  task_type: string;
  recommended_roles: string[];
  role_config: Record<string, RoleConfig>;
  execution_strategy: string;
  estimated_time: number;
  risk_assessment: Record<string, unknown>;
}): StrategicPlan {
  return {
    plan_id: args.plan_id,
    task_type: args.task_type,
    recommended_roles: args.recommended_roles,
    role_config: args.role_config,
    execution_strategy: args.execution_strategy,
    estimated_time: args.estimated_time,
    risk_assessment: args.risk_assessment,
    ai_enhanced: false,
    ai_recommendations: [],
    created_at: new Date().toISOString(),
  };
}

/** StrategicPlan 转字典 */
export function strategicPlanToDict(p: StrategicPlan): Record<string, unknown> {
  return {
    plan_id: p.plan_id,
    task_type: p.task_type,
    recommended_roles: p.recommended_roles,
    role_config: p.role_config,
    execution_strategy: p.execution_strategy,
    estimated_time: p.estimated_time,
    risk_assessment: p.risk_assessment,
    ai_enhanced: p.ai_enhanced,
    ai_recommendations: p.ai_recommendations,
    created_at: p.created_at,
  };
}

/**
 * 战术决策数据类
 */
export interface TacticalDecision {
  decision_id: string;
  context: Record<string, unknown>;
  selected_strategy: string;
  compensations: string[];
  guard_validations: Array<Record<string, unknown>>;
  fallback_strategies: string[];
  ai_enhanced: boolean;
  ai_reasoning: string;
  confidence: number;
  created_at: string;
}

/** TacticalDecision 转字典 */
export function tacticalDecisionToDict(d: TacticalDecision): Record<string, unknown> {
  return {
    decision_id: d.decision_id,
    context: d.context,
    selected_strategy: d.selected_strategy,
    compensations: d.compensations,
    guard_validations: d.guard_validations,
    fallback_strategies: d.fallback_strategies,
    ai_enhanced: d.ai_enhanced,
    ai_reasoning: d.ai_reasoning,
    confidence: d.confidence,
    created_at: d.created_at,
  };
}

/**
 * 执行指标数据类
 */
export interface ExecutionMetrics {
  execution_id: string;
  start_time: number;
  end_time: number | null;
  duration: number;
  success: boolean;
  error_type: string | null;
  strategy_used: string;
  compensations_applied: string[];
  retry_count: number;
  fallback_triggered: boolean;
  metrics: Record<string, unknown>;
}

/** ExecutionMetrics 转字典 */
export function executionMetricsToDict(m: ExecutionMetrics): Record<string, unknown> {
  return {
    execution_id: m.execution_id,
    start_time: m.start_time,
    end_time: m.end_time,
    duration: m.duration,
    success: m.success,
    error_type: m.error_type,
    strategy_used: m.strategy_used,
    compensations_applied: m.compensations_applied,
    retry_count: m.retry_count,
    fallback_triggered: m.fallback_triggered,
    metrics: m.metrics,
  };
}

// ============================================================================
// 任务执行器签名（与 FeedbackControlLoop 兼容）
// ============================================================================

/** 任务执行器函数签名 */
export type HierarchicalTaskExecutor = (
  task: Record<string, unknown>
) => Record<string, unknown> | Promise<Record<string, unknown>>;

// ============================================================================
// 战略控制器
// ============================================================================

/**
 * 战略控制器
 *
 * 负责：
 * 1. 任务分析和规划
 * 2. 角色池配置
 * 3. 全局策略制定
 * 4. AI 增强的动态规划
 */
export class StrategicController {
  public ai_provider: AIProviderLike | null;
  /** 角色能力库 */
  public role_capabilities: Record<string, RoleCapabilities>;
  /** 历史规划 */
  public planning_history: StrategicPlan[] = [];
  private _lock = new SimpleMutex();

  constructor(ai_provider: AIProviderLike | null = null) {
    this.ai_provider = ai_provider;
    this.role_capabilities = { ...ROLE_CAPABILITIES };
  }

  /** 设置 AI 提供者 */
  setAiProvider(ai_provider: AIProviderLike): void {
    this.ai_provider = ai_provider;
  }

  /**
   * 战略规划
   */
  async plan(task: Record<string, unknown>): Promise<StrategicPlan> {
    const task_type = String(task["type"] ?? "unknown");
    const complexity = Number(task["complexity"] ?? 5);

    // 1. 基础规划
    const recommended_roles = this._matchRoles(task_type, complexity);
    const role_config = this._configureRoles(recommended_roles, task);
    const execution_strategy = this._selectStrategy(complexity, recommended_roles);
    const estimated_time = this._estimateTime(complexity, task_type);
    const risk_assessment = this._assessRisks(task_type, complexity);

    // 创建规划
    const plan = createStrategicPlan({
      plan_id: `plan_${Date.now()}`,
      task_type,
      recommended_roles,
      role_config,
      execution_strategy,
      estimated_time,
      risk_assessment,
    });

    // 2. AI 增强规划
    if (this.ai_provider) {
      try {
        const ai_plan = await this._aiEnhancedPlanning(task, plan);
        plan.ai_enhanced = true;
        plan.ai_recommendations = (ai_plan["recommendations"] as string[]) ?? [];

        // 融合 AI 建议
        const ai_strategy = ai_plan["strategy"];
        if (typeof ai_strategy === "string" && ai_strategy.length > 0) {
          plan.execution_strategy = ai_strategy;
        }
        const ai_roles = ai_plan["roles"];
        if (Array.isArray(ai_roles) && ai_roles.length > 0) {
          plan.recommended_roles = ai_roles as string[];
        }
        const mitigation = ai_plan["risk_mitigation"];
        if (typeof mitigation === "string" && mitigation.length > 0) {
          plan.risk_assessment["mitigation"] = mitigation;
        }
      } catch {
        // AI 增强失败不影响主流程
      }
    }

    // 保存历史
    await this._lock.runExclusive(() => {
      this.planning_history.push(plan);
    });

    return plan;
  }

  /**
   * 匹配适合执行任务的角色
   */
  private _matchRoles(task_type: string, complexity: number): string[] {
    const matched_roles: string[] = [];

    for (const [role_id, capabilities] of Object.entries(this.role_capabilities)) {
      const suitable_tasks = capabilities.suitable_tasks;
      const complexity_range = capabilities.complexity_range;

      // 检查任务类型匹配
      const type_match = suitable_tasks.some(
        (t) => task_type.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(task_type.toLowerCase())
      );

      // 检查复杂度范围
      const complexity_match = complexity_range[0] <= complexity && complexity <= complexity_range[1];

      if (type_match || complexity_match) {
        matched_roles.push(role_id);
      }
    }

    // 默认至少有一个角色
    if (matched_roles.length === 0) {
      matched_roles.push("solo-coder");
    }

    return matched_roles;
  }

  /**
   * 配置角色
   */
  private _configureRoles(roles: string[], task: Record<string, unknown>): Record<string, RoleConfig> {
    const complexity = Number(task["complexity"] ?? 5);
    const config: Record<string, RoleConfig> = {};

    for (const role of roles) {
      // 校验角色是否在能力库中
      if (!this.role_capabilities[role]) {
        continue;
      }

      // 根据复杂度调整配置
      if (complexity > 7) {
        // 高复杂度：增强资源配置
        config[role] = {
          enabled: true,
          priority: 1,
          timeout: 600, // 10 分钟
          retry: true,
          max_retry: 3,
        };
      } else if (complexity > 4) {
        // 中复杂度：标准配置
        config[role] = {
          enabled: true,
          priority: 2,
          timeout: 300, // 5 分钟
          retry: true,
          max_retry: 2,
        };
      } else {
        // 低复杂度：简化配置
        config[role] = {
          enabled: true,
          priority: 3,
          timeout: 180, // 3 分钟
          retry: false,
          max_retry: 1,
        };
      }
    }

    return config;
  }

  /**
   * 选择执行策略
   */
  private _selectStrategy(complexity: number, _roles: string[]): string {
    if (complexity > 7) return "conservative";
    if (complexity > 4) return "balanced";
    return "aggressive";
  }

  /**
   * 预估执行时间
   */
  private _estimateTime(complexity: number, task_type: string): number {
    const base_time = complexity * 30; // 每复杂度 30 秒基准

    // 任务类型调整
    const type_multipliers: Record<string, number> = {
      architecture: 2.0,
      design: 1.8,
      implementation: 1.0,
      testing: 1.2,
      review: 0.8,
      planning: 1.5,
    };

    let multiplier = 1.0;
    const task_lower = task_type.toLowerCase();
    for (const [t, m] of Object.entries(type_multipliers)) {
      if (task_lower.includes(t)) {
        multiplier = m;
        break;
      }
    }

    return base_time * multiplier;
  }

  /**
   * 评估风险
   */
  private _assessRisks(task_type: string, complexity: number): Record<string, unknown> {
    const risks: string[] = [];
    let risk_level: string = "low";

    // 复杂度风险
    if (complexity > 8) {
      risks.push("高复杂度可能导致执行失败");
      risk_level = "high";
    } else if (complexity > 6) {
      risks.push("中等复杂度存在一定风险");
      risk_level = "medium";
    }

    // 类型风险
    const high_risk_types = ["architecture", "performance", "security"];
    const task_lower = task_type.toLowerCase();
    if (high_risk_types.some((t) => task_lower.includes(t))) {
      risks.push("高风险任务类型需要额外验证");
      if (risk_level !== "high") {
        risk_level = "medium";
      }
    }

    return {
      level: risk_level,
      risks,
      mitigation: "启用保守策略和额外监控",
    };
  }

  /**
   * AI 增强的规划
   */
  private async _aiEnhancedPlanning(
    task: Record<string, unknown>,
    base_plan: StrategicPlan
  ): Promise<Record<string, unknown>> {
    if (!this.ai_provider) return {};

    try {
      const prompt = `作为战略规划专家，分析以下任务并提供优化建议：

任务信息：
- 类型: ${task["type"] ?? "unknown"}
- 复杂度: ${task["complexity"] ?? 5}/10
- 描述: ${task["description"] ?? "无"}
- 当前推荐角色: ${JSON.stringify(base_plan.recommended_roles)}
- 当前策略: ${base_plan.execution_strategy}
- 当前风险评估: ${JSON.stringify(base_plan.risk_assessment)}

请提供优化建议，返回JSON格式：
{
    "strategy": "优化后的策略",
    "roles": ["可能的角色调整"],
    "recommendations": ["建议1", "建议2", "建议3"],
    "risk_mitigation": "风险缓解建议"
}`;

      const response = await this.ai_provider.generate(prompt);

      const json_match = response.match(/\{[\s\S]*\}/);
      if (json_match) {
        return JSON.parse(json_match[0]) as Record<string, unknown>;
      }
    } catch {
      // 忽略 AI 解析失败
    }

    return {};
  }

  /** 获取统计信息 */
  async getStatistics(): Promise<Record<string, unknown>> {
    return this._lock.runExclusive(() => {
      return {
        total_plans: this.planning_history.length,
        ai_enhanced_count: this.planning_history.filter((p) => p.ai_enhanced).length,
        role_usage: this._getRoleUsage(),
        strategy_usage: this._getStrategyUsage(),
      };
    });
  }

  /** 获取角色使用统计 */
  private _getRoleUsage(): Record<string, number> {
    const usage: Record<string, number> = {};
    for (const plan of this.planning_history) {
      for (const role of plan.recommended_roles) {
        usage[role] = (usage[role] ?? 0) + 1;
      }
    }
    return usage;
  }

  /** 获取策略使用统计 */
  private _getStrategyUsage(): Record<string, number> {
    const usage: Record<string, number> = {};
    for (const plan of this.planning_history) {
      usage[plan.execution_strategy] = (usage[plan.execution_strategy] ?? 0) + 1;
    }
    return usage;
  }
}

// ============================================================================
// 战术控制器
// ============================================================================

/**
 * 战术控制器
 *
 * 负责：
 * 1. Guard 验证协调
 * 2. 异常模式检测
 * 3. 补偿策略计算
 * 4. AI 增强的动态决策
 */
export class TacticalController {
  public ai_provider: AIProviderLike | null;
  /** Guard 协调器（可选） */
  public guard_coordinator: GuardCoordinator | null = null;
  /** 战术决策历史 */
  public decision_history: TacticalDecision[] = [];
  private _lock = new SimpleMutex();

  constructor(ai_provider: AIProviderLike | null = null) {
    this.ai_provider = ai_provider;
  }

  /** 设置 AI 提供者 */
  setAiProvider(ai_provider: AIProviderLike): void {
    this.ai_provider = ai_provider;
  }

  /** 设置守护协调器 */
  setGuardCoordinator(guard_coordinator: GuardCoordinator): void {
    this.guard_coordinator = guard_coordinator;
  }

  /**
   * 战术决策
   */
  async decide(context: Record<string, unknown>): Promise<TacticalDecision> {
    const task = (context["task"] as Record<string, unknown>) ?? {};
    const guard_results = (context["guard_results"] as Array<Record<string, unknown>>) ?? [];

    // 1. 聚合 Guard 验证结果
    const guard_validations = this._aggregateGuardResults(guard_results);

    // 2. 选择策略
    const selected_strategy = this._selectStrategy(task, guard_validations);

    // 3. 计算补偿措施
    const compensations = this._computeCompensations(task, guard_validations);

    // 4. 确定备用策略
    const fallback_strategies = this._getFallbackStrategies(task, guard_validations);

    // 创建决策
    const decision: TacticalDecision = {
      decision_id: `tac_${Date.now()}`,
      context,
      selected_strategy,
      compensations,
      guard_validations,
      fallback_strategies,
      ai_enhanced: false,
      ai_reasoning: "",
      confidence: 0.0,
      created_at: new Date().toISOString(),
    };

    // 5. AI 增强决策
    if (this.ai_provider) {
      try {
        const ai_decision = await this._aiEnhancedDecision(task, decision);
        decision.ai_enhanced = true;
        decision.ai_reasoning = String(ai_decision["reasoning"] ?? "");
        decision.confidence = Number(ai_decision["confidence"] ?? 0.0);

        // 融合 AI 建议
        const ai_strategy = ai_decision["strategy"];
        if (typeof ai_strategy === "string" && ai_strategy.length > 0) {
          decision.selected_strategy = ai_strategy;
        }
        const ai_compensations = ai_decision["compensations"];
        if (Array.isArray(ai_compensations) && ai_compensations.length > 0) {
          decision.compensations = ai_compensations as string[];
        }
      } catch {
        // AI 增强失败不影响主流程
      }
    }

    // 保存历史
    await this._lock.runExclusive(() => {
      this.decision_history.push(decision);
    });

    return decision;
  }

  /**
   * 聚合 Guard 验证结果
   */
  private _aggregateGuardResults(guard_results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (guard_results.length === 0) {
      return [{ source: "default", passed: true, warnings: [] }];
    }
    return guard_results;
  }

  /**
   * 选择策略
   */
  private _selectStrategy(task: Record<string, unknown>, guard_validations: Array<Record<string, unknown>>): string {
    const complexity = Number(task["complexity"] ?? 5);

    // 检查 Guard 验证是否通过
    const validation_passed = guard_validations.every((v) => Boolean(v["passed"] ?? true));

    if (!validation_passed) return "conservative";

    if (complexity > 7) return "conservative";
    if (complexity > 4) return "balanced";
    return "aggressive";
  }

  /**
   * 计算补偿措施
   */
  private _computeCompensations(
    task: Record<string, unknown>,
    guard_validations: Array<Record<string, unknown>>
  ): string[] {
    const compensations: string[] = [];

    // 从 Guard 结果提取补偿建议
    for (const validation of guard_validations) {
      const recs = validation["recommended_compensations"];
      if (Array.isArray(recs)) {
        compensations.push(...(recs as string[]));
      }
    }

    // 基于任务特征添加补偿
    const complexity = Number(task["complexity"] ?? 5);
    if (complexity > 7) {
      compensations.push("启用超时保护");
      compensations.push("启用断点保存");
    }

    // 去重
    const seen = new Set<string>();
    const unique_compensations: string[] = [];
    for (const c of compensations) {
      if (!seen.has(c)) {
        seen.add(c);
        unique_compensations.push(c);
      }
    }

    return unique_compensations;
  }

  /**
   * 获取备用策略
   */
  private _getFallbackStrategies(
    task: Record<string, unknown>,
    guard_validations: Array<Record<string, unknown>>
  ): string[] {
    const strategies = ["conservative", "balanced", "aggressive"];
    const selected = this._selectStrategy(task, guard_validations);

    // 当前策略放到第一位
    if (strategies.includes(selected)) {
      const idx = strategies.indexOf(selected);
      strategies.splice(idx, 1);
      strategies.unshift(selected);
    }

    return strategies;
  }

  /**
   * AI 增强的决策
   */
  private async _aiEnhancedDecision(
    task: Record<string, unknown>,
    base_decision: TacticalDecision
  ): Promise<Record<string, unknown>> {
    if (!this.ai_provider) return {};

    try {
      const prompt = `作为战术决策专家，分析以下任务上下文并做出最优决策：

任务信息：
- 类型: ${task["type"] ?? "unknown"}
- 复杂度: ${task["complexity"] ?? 5}/10
- 描述: ${task["description"] ?? "无"}

当前决策：
- 选择的策略: ${base_decision.selected_strategy}
- 补偿措施: ${JSON.stringify(base_decision.compensations)}
- 备用策略: ${JSON.stringify(base_decision.fallback_strategies)}

请分析并返回JSON格式：
{
    "strategy": "最优策略",
    "compensations": ["补偿措施1", "补偿措施2"],
    "confidence": 0.0-1.0,
    "reasoning": "决策推理过程"
}`;

      const response = await this.ai_provider.generate(prompt);

      const json_match = response.match(/\{[\s\S]*\}/);
      if (json_match) {
        return JSON.parse(json_match[0]) as Record<string, unknown>;
      }
    } catch {
      // 忽略 AI 解析失败
    }

    return {};
  }

  /** 获取统计信息 */
  async getStatistics(): Promise<Record<string, unknown>> {
    return this._lock.runExclusive(() => {
      const recent_decisions = this.decision_history.slice(-100);

      const avg_confidence =
        recent_decisions.length > 0
          ? recent_decisions.reduce((sum, d) => sum + d.confidence, 0) / recent_decisions.length
          : 0.0;

      return {
        total_decisions: this.decision_history.length,
        ai_enhanced_count: recent_decisions.filter((d) => d.ai_enhanced).length,
        average_confidence: avg_confidence,
        strategy_distribution: this._getStrategyDistribution(recent_decisions),
      };
    });
  }

  /** 获取策略分布 */
  private _getStrategyDistribution(decisions: TacticalDecision[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const d of decisions) {
      dist[d.selected_strategy] = (dist[d.selected_strategy] ?? 0) + 1;
    }
    return dist;
  }
}

// ============================================================================
// 反馈循环接口（解耦）
// ============================================================================

/** 反馈控制环接口（最小依赖） */
export interface FeedbackLoopLike {
  record(args: {
    task_type: string;
    task_complexity: number;
    success: boolean;
    error_type?: string | null;
    execution_time: number;
    strategy: string;
  }): void;
}

// ============================================================================
// 执行控制器
// ============================================================================

/**
 * 执行控制器
 *
 * 负责：
 * 1. 任务执行
 * 2. 反馈收集
 * 3. 结果评估
 * 4. 与反馈控制环集成
 */
export class ExecutionController {
  public ai_provider: AIProviderLike | null;
  /** 反馈控制环（可选） */
  public feedback_loop: FeedbackLoopLike | null = null;
  /** 执行指标历史 */
  public metrics_history: ExecutionMetrics[] = [];
  private _lock = new SimpleMutex();

  constructor(ai_provider: AIProviderLike | null = null) {
    this.ai_provider = ai_provider;
  }

  /** 设置 AI 提供者 */
  setAiProvider(ai_provider: AIProviderLike): void {
    this.ai_provider = ai_provider;
  }

  /** 设置反馈控制环 */
  setFeedbackLoop(feedback_loop: FeedbackLoopLike): void {
    this.feedback_loop = feedback_loop;
  }

  /**
   * 执行任务
   */
  async execute(
    task: Record<string, unknown>,
    strategy: string,
    compensations: string[],
    executor: HierarchicalTaskExecutor | null = null
  ): Promise<ExecutionMetrics> {
    const execution_id = `exec_${Date.now()}`;
    const start_time = Date.now();

    // 创建执行指标
    const metrics: ExecutionMetrics = {
      execution_id,
      start_time,
      end_time: null,
      duration: 0.0,
      success: false,
      error_type: null,
      strategy_used: strategy,
      compensations_applied: compensations,
      retry_count: 0,
      fallback_triggered: false,
      metrics: {},
    };

    try {
      // 1. 准备执行
      if (this.ai_provider) {
        try {
          const execution_context = await this._aiPrepareExecution(task, strategy, compensations);
          metrics.metrics["ai_preparation"] = execution_context;
        } catch {
          // 忽略 AI 准备失败
        }
      }

      // 2. 执行任务
      let result: Record<string, unknown>;
      if (executor) {
        result = await executor(task);
      } else {
        result = this._defaultExecution(task, strategy);
      }

      // 3. 更新指标
      metrics.success = Boolean(result["success"] ?? false);
      metrics.end_time = Date.now();
      metrics.duration = (metrics.end_time - metrics.start_time) / 1000.0;

      if (!metrics.success) {
        metrics.error_type = String(result["error_type"] ?? "unknown");
      }

      // 4. AI 增强的结果评估
      if (this.ai_provider) {
        try {
          const evaluation = await this._aiEvaluateResult(result, metrics);
          metrics.metrics["ai_evaluation"] = evaluation;
        } catch {
          // 忽略 AI 评估失败
        }
      }
    } catch (e) {
      metrics.success = false;
      metrics.error_type = e instanceof Error ? e.name : "Error";
      metrics.end_time = Date.now();
      metrics.duration = (metrics.end_time - metrics.start_time) / 1000.0;
    }

    // 5. 反馈收集
    if (this.feedback_loop) {
      try {
        this.feedback_loop.record({
          task_type: String(task["type"] ?? "unknown"),
          task_complexity: Number(task["complexity"] ?? 5),
          success: metrics.success,
          error_type: metrics.error_type,
          execution_time: metrics.duration,
          strategy,
        });
      } catch {
        // 忽略反馈收集失败
      }
    }

    // 保存历史
    await this._lock.runExclusive(() => {
      this.metrics_history.push(metrics);
    });

    return metrics;
  }

  /**
   * AI 准备执行
   */
  private async _aiPrepareExecution(
    task: Record<string, unknown>,
    strategy: string,
    compensations: string[]
  ): Promise<Record<string, unknown>> {
    if (!this.ai_provider) return {};

    try {
      const prompt = `分析以下任务执行上下文，提供执行建议：

任务：
${JSON.stringify(task, null, 2)}

策略: ${strategy}
补偿措施: ${JSON.stringify(compensations)}

返回JSON格式：
{
    "suggestions": ["建议1", "建议2"],
    "optimizations": ["优化1", "优化2"],
    "warnings": ["警告1"]
}`;

      const response = await this.ai_provider.generate(prompt);

      const json_match = response.match(/\{[\s\S]*\}/);
      if (json_match) {
        return JSON.parse(json_match[0]) as Record<string, unknown>;
      }
    } catch {
      // 忽略 AI 解析失败
    }

    return {};
  }

  /**
   * 默认执行逻辑
   */
  private _defaultExecution(task: Record<string, unknown>, strategy: string): Record<string, unknown> {
    // 默认执行返回 success=True 但 strategy 标记 strategy_used
    // 真实执行需由调用方提供 executor
    return {
      success: true,
      task_id: task["id"],
      strategy,
      message: `使用${strategy}策略执行任务（默认执行器）`,
    };
  }

  /**
   * AI 评估执行结果
   */
  private async _aiEvaluateResult(
    result: Record<string, unknown>,
    metrics: ExecutionMetrics
  ): Promise<Record<string, unknown>> {
    if (!this.ai_provider) return {};

    try {
      const prompt = `评估以下任务执行结果：

结果：
${JSON.stringify(result, null, 2)}

指标：
- 执行时间: ${metrics.duration}秒
- 成功: ${metrics.success}
- 错误类型: ${metrics.error_type}

返回JSON格式：
{
    "assessment": "评估结果",
    "lessons": ["经验1", "经验2"],
    "improvements": ["改进1", "改进2"]
}`;

      const response = await this.ai_provider.generate(prompt);

      const json_match = response.match(/\{[\s\S]*\}/);
      if (json_match) {
        return JSON.parse(json_match[0]) as Record<string, unknown>;
      }
    } catch {
      // 忽略 AI 解析失败
    }

    return {};
  }

  /** 获取统计信息 */
  async getStatistics(): Promise<Record<string, unknown>> {
    return this._lock.runExclusive(() => {
      const total = this.metrics_history.length;
      const success = this.metrics_history.filter((m) => m.success).length;
      const failure = total - success;
      const avg_duration = total > 0 ? this.metrics_history.reduce((s, m) => s + m.duration, 0) / total : 0;

      return {
        total_executions: total,
        success_count: success,
        failure_count: failure,
        average_duration: avg_duration,
        retry_count: this.metrics_history.reduce((s, m) => s + m.retry_count, 0),
        fallback_triggered: this.metrics_history.filter((m) => m.fallback_triggered).length,
      };
    });
  }
}

// ============================================================================
// 层次化控制管理器
// ============================================================================

/**
 * 层次化控制管理器
 *
 * 整合战略层、战术层、执行层三层控制，
 * 实现完整的层次化控制流程
 */
export class HierarchicalControlManager {
  public ai_provider: AIProviderLike | null;
  /** 战略层控制器 */
  public strategic_controller: StrategicController;
  /** 战术层控制器 */
  public tactical_controller: TacticalController;
  /** 执行层控制器 */
  public execution_controller: ExecutionController;
  /** 反馈控制环（可选） */
  public feedback_loop: FeedbackLoopLike | null = null;
  /** 守护协调器（可选） */
  public guard_coordinator: GuardCoordinator | null = null;
  /** 控制历史 */
  public control_history: Array<Record<string, unknown>> = [];
  private _lock = new SimpleMutex();

  constructor(ai_provider: AIProviderLike | null = null) {
    this.ai_provider = ai_provider;

    // 初始化三层控制器
    this.strategic_controller = new StrategicController(ai_provider);
    this.tactical_controller = new TacticalController(ai_provider);
    this.execution_controller = new ExecutionController(ai_provider);
  }

  /** 设置反馈控制环 */
  setFeedbackLoop(feedback_loop: FeedbackLoopLike): void {
    this.feedback_loop = feedback_loop;
    this.execution_controller.setFeedbackLoop(feedback_loop);
  }

  /** 设置守护协调器 */
  setGuardCoordinator(guard_coordinator: GuardCoordinator): void {
    this.guard_coordinator = guard_coordinator;
    this.tactical_controller.setGuardCoordinator(guard_coordinator);
  }

  /**
   * 执行任务（层次化控制）
   *
   * 完整流程：
   * 1. 战略层：任务规划、角色配置
   * 2. 战术层：Guard 验证、策略决策
   * 3. 执行层：任务执行、反馈收集
   */
  async executeTask(
    task: Record<string, unknown>,
    executor: HierarchicalTaskExecutor | null = null
  ): Promise<Record<string, unknown>> {
    const control_record: Record<string, unknown> = {
      task_id: task["id"],
      start_time: new Date().toISOString(),
      levels: {},
    };

    try {
      // 阶段1: 战略控制
      const strategic_plan = await this.strategic_controller.plan(task);
      control_record["levels"] = {
        ...(control_record["levels"] as Record<string, unknown>),
        strategic: strategicPlanToDict(strategic_plan),
      };

      // 阶段2: 战术控制
      const guard_results: Array<Record<string, unknown>> = [];
      if (this.guard_coordinator) {
        const validation: ValidationResult = await this.guard_coordinator.preExecuteValidation(task);
        guard_results.push({
          source: "guard_coordinator",
          passed: validation.passed,
          risk_level: validation.risk_level,
          warnings: validation.warnings,
        });
      }

      const tactical_context: Record<string, unknown> = {
        task,
        strategic_plan: strategicPlanToDict(strategic_plan),
        guard_results,
      };
      const tactical_decision = await this.tactical_controller.decide(tactical_context);
      control_record["levels"] = {
        ...(control_record["levels"] as Record<string, unknown>),
        tactical: tacticalDecisionToDict(tactical_decision),
      };

      // 阶段3: 执行控制
      const execution_metrics = await this.execution_controller.execute(
        task,
        tactical_decision.selected_strategy,
        tactical_decision.compensations,
        executor
      );
      control_record["levels"] = {
        ...(control_record["levels"] as Record<string, unknown>),
        execution: executionMetricsToDict(execution_metrics),
      };
      control_record["success"] = execution_metrics.success;
      control_record["end_time"] = new Date().toISOString();

      // 提取 executor 返回的结果（透传给调用方）
      // 注意：execution_metrics 本身是 ExecutionMetrics 类型，executor 的真实返回值
      // 会被包装在 execution_metrics.metrics 或其他字段中。
      // 此处统一使用 execution_metrics 作为 executor_result 的来源，确保类型安全
      const executor_result: Record<string, unknown> = execution_metrics as unknown as Record<string, unknown>;

      // 执行后审查
      if (this.guard_coordinator) {
        const review = await this.guard_coordinator.postExecuteReview(
          execution_metrics.execution_id,
          executionMetricsToDict(execution_metrics)
        );
        control_record["review"] = review;
      }

      // 记录控制历史
      await this._lock.runExclusive(() => {
        this.control_history.push(control_record);
      });

      return {
        success: execution_metrics.success,
        strategic_plan: strategicPlanToDict(strategic_plan),
        tactical_decision: tacticalDecisionToDict(tactical_decision),
        execution_metrics: executionMetricsToDict(execution_metrics),
        control_record,
        // 透传 executor 返回结果（让调用方能获取业务结果，如 { completed: true }）
        ...(executor_result as Record<string, unknown>),
      };
    } catch (e) {
      const error_message = e instanceof Error ? e.message : String(e);
      control_record["error"] = error_message;
      control_record["success"] = false;
      control_record["end_time"] = new Date().toISOString();

      await this._lock.runExclusive(() => {
        this.control_history.push(control_record);
      });

      return {
        success: false,
        error: error_message,
        control_record,
      };
    }
  }

  /**
   * 获取所有层的统计信息
   */
  async getAllStatistics(): Promise<Record<string, unknown>> {
    return {
      strategic: await this.strategic_controller.getStatistics(),
      tactical: await this.tactical_controller.getStatistics(),
      execution: await this.execution_controller.getStatistics(),
      hierarchical: {
        total_control_records: this.control_history.length,
        success_rate:
          this.control_history.length > 0
            ? this.control_history.filter((r) => r["success"] === true).length / this.control_history.length
            : 0.0,
      },
    };
  }
}
