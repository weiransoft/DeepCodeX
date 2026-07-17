/**
 * Guard Coordinator - 守护协调器
 *
 * 来源：multi-agent-team skill scripts/guard_coordinator.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 职责：
 * 1. 执行前预验证（Pre-execution Validation）：检查任务是否符合执行条件
 * 2. 实时执行监控（Real-time Monitoring）：检测异常模式
 * 3. 执行后审查（Post-execution Review）：提取经验教训，更新模式库
 * 4. AI 大模型增强的动态风险评估
 *
 * 设计原则：
 * - 预置 Karpathy 4 原则相关规则（占位代码、投机代码、空假设等）
 * - 风险等级 4 级：LOW / MEDIUM / HIGH / CRITICAL
 * - 5 个默认补偿策略 + 3 个默认异常模式
 * - AI 失败时优雅降级（不影响主流程）
 *
 * 作者：trae-multi-agent 融合 Phase 2（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

import { SimpleMutex } from "./feedback-control-loop.js";
export const RiskLevel = {
  LOW: "low", // 低风险
  MEDIUM: "medium", // 中风险
  HIGH: "high", // 高风险
  CRITICAL: "critical", // 严重风险
} as const;

export type RiskLevelType = (typeof RiskLevel)[keyof typeof RiskLevel];

/** 所有风险等级 */
export const ALL_RISK_LEVELS: readonly RiskLevelType[] = [
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
];

/** 校验风险等级 */
export function isValidRiskLevel(level: string): level is RiskLevelType {
  return (ALL_RISK_LEVELS as readonly string[]).includes(level);
}

// ============================================================================
// 严重程度
// ============================================================================

/** 严重程度 */
export const Severity = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
  CRITICAL: "critical",
} as const;

export type SeverityType = (typeof Severity)[keyof typeof Severity];

// ============================================================================
// 异常类
// ============================================================================

/** GuardCoordinator 基础异常 */
export class GuardCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardCoordinatorError";
  }
}

// ============================================================================
// 数据结构
// ============================================================================

/**
 * 验证警告数据类
 */
export interface ValidationWarning {
  warning_code: string;
  warning_type: string;
  message: string;
  severity: SeverityType;
  recommended_action: string;
}

/** 创建 ValidationWarning */
export function createValidationWarning(args: {
  warning_code: string;
  warning_type: string;
  message: string;
  severity: SeverityType;
  recommended_action: string;
}): ValidationWarning {
  return {
    warning_code: args.warning_code,
    warning_type: args.warning_type,
    message: args.message,
    severity: args.severity,
    recommended_action: args.recommended_action,
  };
}

/** ValidationWarning 转字典 */
export function validationWarningToDict(w: ValidationWarning): Record<string, unknown> {
  return {
    warning_code: w.warning_code,
    warning_type: w.warning_type,
    message: w.message,
    severity: w.severity,
    recommended_action: w.recommended_action,
  };
}

/**
 * 补偿策略数据类
 */
export interface CompensationStrategy {
  strategy_id: string;
  error_type: string;
  strategy_type: string;
  actions: string[];
  priority: number;
  confidence: number;
}

/** 创建 CompensationStrategy */
export function createCompensationStrategy(args: {
  strategy_id: string;
  error_type: string;
  strategy_type: string;
  actions: string[];
  priority: number;
  confidence: number;
}): CompensationStrategy {
  return {
    strategy_id: args.strategy_id,
    error_type: args.error_type,
    strategy_type: args.strategy_type,
    actions: args.actions,
    priority: args.priority,
    confidence: args.confidence,
  };
}

/** CompensationStrategy 转字典 */
export function compensationStrategyToDict(s: CompensationStrategy): Record<string, unknown> {
  return {
    strategy_id: s.strategy_id,
    error_type: s.error_type,
    strategy_type: s.strategy_type,
    actions: s.actions,
    priority: s.priority,
    confidence: s.confidence,
  };
}

/**
 * 验证结果数据类
 */
export interface ValidationResult {
  passed: boolean;
  risk_level: RiskLevelType;
  warnings: ValidationWarning[];
  recommended_compensations: CompensationStrategy[];
  alternative_strategies: string[];
  validation_time: number;
  validation_details: Record<string, unknown>;
  created_at: string;
}

/** ValidationResult 转字典 */
export function validationResultToDict(v: ValidationResult): Record<string, unknown> {
  return {
    passed: v.passed,
    risk_level: v.risk_level,
    warnings: v.warnings.map(validationWarningToDict),
    recommended_compensations: v.recommended_compensations.map(compensationStrategyToDict),
    alternative_strategies: v.alternative_strategies,
    validation_time: v.validation_time,
    validation_details: v.validation_details,
    created_at: v.created_at,
  };
}

/**
 * 异常模式数据类
 */
export interface AnomalyPattern {
  pattern_id: string;
  pattern_type: string;
  trigger_conditions: Array<Record<string, unknown>>;
  anomaly_indicators: string[];
  recommended_response: string;
  severity: RiskLevelType;
}

/** 创建 AnomalyPattern */
export function createAnomalyPattern(args: {
  pattern_id: string;
  pattern_type: string;
  trigger_conditions: Array<Record<string, unknown>>;
  anomaly_indicators: string[];
  recommended_response: string;
  severity: RiskLevelType;
}): AnomalyPattern {
  return {
    pattern_id: args.pattern_id,
    pattern_type: args.pattern_type,
    trigger_conditions: args.trigger_conditions,
    anomaly_indicators: args.anomaly_indicators,
    recommended_response: args.recommended_response,
    severity: args.severity,
  };
}

/**
 * 监控结果数据类
 */
export interface MonitorResult {
  status: string; // normal / warning / anomaly / critical
  detected_patterns: string[];
  anomalies: Array<Record<string, unknown>>;
  recommended_actions: string[];
  metrics: Record<string, unknown>;
  created_at: string;
}

/** MonitorResult 转字典 */
export function monitorResultToDict(m: MonitorResult): Record<string, unknown> {
  return {
    status: m.status,
    detected_patterns: m.detected_patterns,
    anomalies: m.anomalies,
    recommended_actions: m.recommended_actions,
    metrics: m.metrics,
    created_at: m.created_at,
  };
}

/**
 * 审查结果数据类
 */
export interface ReviewResult {
  outcome: string; // SUCCESS / PARTIAL_SUCCESS / FAILURE
  patterns_learned: string[];
  fingerprint_updates: Array<Record<string, unknown>>;
  lessons_learned: string[];
  improvement_suggestions: string[];
  created_at: string;
}

/** ReviewResult 转字典 */
export function reviewResultToDict(r: ReviewResult): Record<string, unknown> {
  return {
    outcome: r.outcome,
    patterns_learned: r.patterns_learned,
    fingerprint_updates: r.fingerprint_updates,
    lessons_learned: r.lessons_learned,
    improvement_suggestions: r.improvement_suggestions,
    created_at: r.created_at,
  };
}

// ============================================================================
// 验证规则定义
// ============================================================================

/** 验证规则接口 */
export interface ValidationRule {
  rule_id: string;
  name: string;
  check: (task: Record<string, unknown>) => boolean;
  error_message: string;
  severity: SeverityType;
}

// ============================================================================
// AI Provider 接口（用于动态风险评估）
// ============================================================================

/** AI Provider 抽象接口（用于动态规划） */
export interface AIProviderLike {
  generate(prompt: string): string | Promise<string>;
}

// ============================================================================
// 默认异常模式 ID
// ============================================================================

/** 异常模式 ID 集合 */
export const ANOMALY_PATTERN_IDS = {
  TIMEOUT_REPEATED: "pattern_timeout_repeated",
  ERROR_CONCENTRATION: "pattern_error_concentration",
  MEMORY_LEAK: "pattern_memory_leak",
} as const;

export type AnomalyPatternId = (typeof ANOMALY_PATTERN_IDS)[keyof typeof ANOMALY_PATTERN_IDS];

/** 补偿策略 ID 集合 */
export const COMPENSATION_STRATEGY_IDS = {
  TIMEOUT: "strat_timeout",
  MEMORY: "strat_memory",
  SYNTAX: "strat_syntax",
  NETWORK: "strat_network",
  UNKNOWN: "strat_unknown",
} as const;

export type CompensationStrategyId = (typeof COMPENSATION_STRATEGY_IDS)[keyof typeof COMPENSATION_STRATEGY_IDS];

// ============================================================================
// 默认模式：触发条件操作符
// ============================================================================

/** 比较操作符 */
export type CompareOperator = ">=" | ">" | "<=" | "<" | "==" | "!=";

/** 模式触发条件 */
export interface TriggerCondition {
  type: string;
  operator: CompareOperator;
  value: number | string | boolean;
}

// ============================================================================
// 验证工具
// ============================================================================

/**
 * 检查文本是否匹配占位符代码模式
 *
 * 对应 Karpathy 原则：Surgical Changes（精准修改）
 * 禁止使用 pass/TODO/FIXME/mock/简化/占位 等标记
 */
export function containsPlaceholderCode(task: Record<string, unknown>): boolean {
  const description = String(task["description"] ?? "");
  const code_snippet = String(task["code"] ?? "");
  const combined = `${description} ${code_snippet}`;

  const placeholder_patterns = [
    /pass\s*#\s*(占位|placeholder|TODO)/i,
    /\bmock\b/i,
    /\bstub\b/i,
    /简化实现|模拟实现|占位实现/i,
    /#.*TODO|#.*FIXME|#.*HACK|#.*XXX/i,
  ];

  for (const pattern of placeholder_patterns) {
    if (pattern.test(combined)) {
      return true;
    }
  }
  return false;
}

/**
 * 检查文本是否匹配投机性代码模式
 *
 * 对应 Karpathy 原则：Simplicity First（简单优先）
 * 禁止为未来预留代码、添加"以后可能用到"的功能
 */
export function containsSpeculativeCode(task: Record<string, unknown>): boolean {
  const description = String(task["description"] ?? "");
  const code_snippet = String(task["code"] ?? "");
  const combined = `${description} ${code_snippet}`;

  const speculative_patterns = [
    /#.*以后|#.*future|#.*预留|#.*reserve/i,
    /为未来|以后可能|暂时不用|先留着/i,
    /class\s+\w*(Factory|Builder)\b(?!\s*\()/,
  ];

  for (const pattern of speculative_patterns) {
    if (pattern.test(combined)) {
      return true;
    }
  }
  return false;
}

/**
 * 检查任务是否有明确的目标定义
 *
 * 对应 Karpathy 原则：Goal-Driven Execution（目标驱动执行）
 * 任务必须有 goals 或 description 字段
 */
export function hasClearGoals(task: Record<string, unknown>): boolean {
  const goals = task["goals"];
  const description = task["description"];
  const has_goals = Array.isArray(goals) && goals.length > 0;
  const has_description = typeof description === "string" && description.length > 5;
  return has_goals || has_description;
}

/**
 * 检查任务描述是否包含未验证的假设
 *
 * 对应 Karpathy 原则：Think Before Coding（三思而后行）
 * 检测"假设"、"assume"等关键词
 */
export function containsUnverifiedAssumptions(task: Record<string, unknown>): boolean {
  const description = String(task["description"] ?? "");
  const code_snippet = String(task["code"] ?? "");
  const combined = `${description} ${code_snippet}`;

  const assumption_patterns = [/#.*假设|#.*assume|#.*可能|#.*maybe/i, /假设.*是|assume.*is/i, /假设/];

  for (const pattern of assumption_patterns) {
    if (pattern.test(combined)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// GuardCoordinator 主类
// ============================================================================

/**
 * GuardCoordinator 配置
 */
export interface GuardCoordinatorConfig {
  agent_id: string;
  ai_provider?: AIProviderLike | null;
}

/**
 * 守护协调器类
 *
 * 核心功能：
 * 1. 执行前预验证（Pre-execution Validation）
 * 2. 实时执行监控（Real-time Monitoring）
 * 3. 执行后审查（Post-execution Review）
 * 4. AI 大模型增强的动态风险评估
 *
 * 参考 Profile-Aware Maneuvering 架构
 */
export class GuardCoordinator {
  public agent_id: string;
  public ai_provider: AIProviderLike | null;

  /** 补偿策略库 */
  public compensation_strategies: Map<string, CompensationStrategy> = new Map();
  /** 异常模式库 */
  public anomaly_patterns: Map<string, AnomalyPattern> = new Map();
  /** 验证规则库 */
  public validation_rules: ValidationRule[] = [];
  /** 验证历史 */
  public validation_history: ValidationResult[] = [];

  private _lock = new SimpleMutex();

  constructor(config: GuardCoordinatorConfig) {
    this.agent_id = config.agent_id;
    this.ai_provider = config.ai_provider ?? null;

    this._initDefaultStrategies();
    this._initDefaultPatterns();
    this._initDefaultRules();
  }

  /**
   * 初始化默认补偿策略
   */
  private _initDefaultStrategies(): void {
    const default_strategies: CompensationStrategy[] = [
      createCompensationStrategy({
        strategy_id: COMPENSATION_STRATEGY_IDS.TIMEOUT,
        error_type: "timeout",
        strategy_type: "feedforward",
        actions: ["增加超时时间", "简化任务", "启用缓存"],
        priority: 3,
        confidence: 0.8,
      }),
      createCompensationStrategy({
        strategy_id: COMPENSATION_STRATEGY_IDS.MEMORY,
        error_type: "memory_error",
        strategy_type: "feedback",
        actions: ["减少并发", "清理内存", "优化数据结构"],
        priority: 4,
        confidence: 0.75,
      }),
      createCompensationStrategy({
        strategy_id: COMPENSATION_STRATEGY_IDS.SYNTAX,
        error_type: "syntax_error",
        strategy_type: "feedforward",
        actions: ["语法检查", "格式化代码", "使用lint工具"],
        priority: 2,
        confidence: 0.9,
      }),
      createCompensationStrategy({
        strategy_id: COMPENSATION_STRATEGY_IDS.NETWORK,
        error_type: "network_error",
        strategy_type: "hybrid",
        actions: ["重试连接", "使用备用节点", "降级服务"],
        priority: 4,
        confidence: 0.7,
      }),
      createCompensationStrategy({
        strategy_id: COMPENSATION_STRATEGY_IDS.UNKNOWN,
        error_type: "unknown",
        strategy_type: "feedback",
        actions: ["记录详细日志", "切换保守策略", "通知监控系统"],
        priority: 5,
        confidence: 0.5,
      }),
    ];

    for (const strategy of default_strategies) {
      this.compensation_strategies.set(strategy.error_type, strategy);
    }
  }

  /**
   * 初始化默认异常模式
   */
  private _initDefaultPatterns(): void {
    const default_patterns: AnomalyPattern[] = [
      createAnomalyPattern({
        pattern_id: ANOMALY_PATTERN_IDS.TIMEOUT_REPEATED,
        pattern_type: "repeated_timeout",
        trigger_conditions: [{ type: "timeout_count", operator: ">=", value: 3 }],
        anomaly_indicators: ["执行时间持续增长", "超时频率增加"],
        recommended_response: "降低任务复杂度或启用快速失败模式",
        severity: RiskLevel.HIGH,
      }),
      createAnomalyPattern({
        pattern_id: ANOMALY_PATTERN_IDS.ERROR_CONCENTRATION,
        pattern_type: "error_concentration",
        trigger_conditions: [{ type: "error_rate", operator: ">", value: 0.3 }],
        anomaly_indicators: ["错误率超过30%", "特定类型错误集中"],
        recommended_response: "暂停任务并分析根因",
        severity: RiskLevel.CRITICAL,
      }),
      createAnomalyPattern({
        pattern_id: ANOMALY_PATTERN_IDS.MEMORY_LEAK,
        pattern_type: "memory_leak",
        trigger_conditions: [{ type: "memory_trend", operator: ">", value: 0.1 }],
        anomaly_indicators: ["内存使用持续增长", "GC频率增加"],
        recommended_response: "触发内存清理或重启执行环境",
        severity: RiskLevel.HIGH,
      }),
    ];

    for (const pattern of default_patterns) {
      this.anomaly_patterns.set(pattern.pattern_id, pattern);
    }
  }

  /**
   * 初始化默认验证规则（含 Karpathy 四大核心原则规则）
   */
  private _initDefaultRules(): void {
    this.validation_rules = [
      {
        rule_id: "rule_complexity",
        name: "复杂度验证",
        check: (task: Record<string, unknown>) => Number(task["complexity"] ?? 5) <= 10,
        error_message: "任务复杂度超出范围 (1-10)",
        severity: Severity.ERROR,
      },
      {
        rule_id: "rule_timeout",
        name: "超时时间验证",
        check: (task: Record<string, unknown>) => {
          const t = Number(task["timeout"] ?? 300);
          return t > 0 && t <= 3600;
        },
        error_message: "超时时间超出范围 (1-3600秒)",
        severity: Severity.WARNING,
      },
      {
        rule_id: "rule_required_fields",
        name: "必填字段验证",
        check: (task: Record<string, unknown>) => "type" in task && "id" in task,
        error_message: "缺少必填字段 (type, id)",
        severity: Severity.ERROR,
      },
      {
        rule_id: "rule_karpathy_no_placeholder",
        name: "Karpathy原则-禁止占位符代码",
        check: (task: Record<string, unknown>) => !containsPlaceholderCode(task),
        error_message: "任务包含占位符代码（pass/TODO/mock/简化实现），违反 Surgical Changes 原则",
        severity: Severity.CRITICAL,
      },
      {
        rule_id: "rule_karpathy_no_speculative",
        name: "Karpathy原则-禁止投机性代码",
        check: (task: Record<string, unknown>) => !containsSpeculativeCode(task),
        error_message: "任务包含投机性代码（为未来预留/以后可能用到），违反 Simplicity First 原则",
        severity: Severity.ERROR,
      },
      {
        rule_id: "rule_karpathy_goal_defined",
        name: "Karpathy原则-目标必须明确",
        check: (task: Record<string, unknown>) => hasClearGoals(task),
        error_message: "任务缺少明确目标定义（goals或description），违反 Goal-Driven 原则",
        severity: Severity.WARNING,
      },
      {
        rule_id: "rule_karpathy_no_assumption",
        name: "Karpathy原则-禁止未验证假设",
        check: (task: Record<string, unknown>) => !containsUnverifiedAssumptions(task),
        error_message: "任务描述包含未验证的假设，违反 Think Before Coding 原则",
        severity: Severity.WARNING,
      },
    ];
  }

  /** 设置 AI 提供者 */
  setAiProvider(ai_provider: AIProviderLike): void {
    this.ai_provider = ai_provider;
  }

  /**
   * 执行前验证
   *
   * 验证任务是否符合执行条件，识别潜在风险并提供补偿策略
   */
  async preExecuteValidation(task: Record<string, unknown>): Promise<ValidationResult> {
    const start_time = Date.now();

    const warnings: ValidationWarning[] = [];
    const recommendations: CompensationStrategy[] = [];
    const details: Record<string, unknown> = { rule_checks: [] as Array<Record<string, unknown>> };
    let passed = true;

    // 1. 规则检查
    for (const rule of this.validation_rules) {
      try {
        const check_result = rule.check(task);
        (details["rule_checks"] as Array<Record<string, unknown>>).push({
          rule_id: rule.rule_id,
          passed: check_result,
          message: check_result ? null : rule.error_message,
        });

        if (!check_result) {
          passed = false;
          warnings.push(
            createValidationWarning({
              warning_code: rule.rule_id,
              warning_type: "validation_rule",
              message: rule.error_message,
              severity: rule.severity,
              recommended_action: "修正任务参数",
            })
          );
        }
      } catch (e) {
        warnings.push(
          createValidationWarning({
            warning_code: rule.rule_id,
            warning_type: "validation_error",
            message: `规则检查异常: ${e instanceof Error ? e.message : String(e)}`,
            severity: Severity.WARNING,
            recommended_action: "跳过该规则检查",
          })
        );
      }
    }

    // 2. AI 增强的风险评估
    if (this.ai_provider) {
      try {
        const ai_assessment = await this._aiEnhancedRiskAssessment(task);
        details["ai_assessment"] = ai_assessment;

        const risk_detected = Boolean(ai_assessment["risk_detected"] ?? false);
        if (risk_detected) {
          passed = false;
          const risks = (ai_assessment["risks"] as Array<Record<string, unknown>>) ?? [];
          for (const risk of risks) {
            warnings.push(
              createValidationWarning({
                warning_code: `ai_risk_${String(risk["type"] ?? "unknown")}`,
                warning_type: "ai_enhanced",
                message: String(risk["message"] ?? ""),
                severity: (risk["severity"] as SeverityType) ?? Severity.WARNING,
                recommended_action: String(risk["recommendation"] ?? "人工审核"),
              })
            );
          }
        }

        // AI 推荐的补偿策略
        const ai_strategies = (ai_assessment["recommended_strategies"] as Array<Record<string, unknown>>) ?? [];
        for (const strat of ai_strategies) {
          recommendations.push(
            createCompensationStrategy({
              strategy_id: `ai_strat_${String(strat["type"] ?? "unknown")}`,
              error_type: String(strat["type"] ?? "unknown"),
              strategy_type: "ai_recommended",
              actions: (strat["actions"] as string[]) ?? [],
              priority: Number(strat["priority"] ?? 3),
              confidence: Number(strat["confidence"] ?? 0.7),
            })
          );
        }
      } catch {
        // AI 评估失败不影响主流程
      }
    }

    // 3. 基于历史风险的补偿策略推荐
    const complexity = Number(task["complexity"] ?? 5);
    if (complexity > 7) {
      const timeout_strat =
        this.compensation_strategies.get("timeout") ??
        createCompensationStrategy({
          strategy_id: "default",
          error_type: "timeout",
          strategy_type: "feedforward",
          actions: ["启用保守策略"],
          priority: 3,
          confidence: 0.8,
        });
      recommendations.push(timeout_strat);
    }

    // 4. 确定风险等级
    let risk_level: RiskLevelType = RiskLevel.LOW;
    if (warnings.some((w) => w.severity === Severity.ERROR)) {
      risk_level = RiskLevel.MEDIUM;
    }
    if (warnings.some((w) => w.severity === Severity.CRITICAL)) {
      risk_level = RiskLevel.CRITICAL;
    }
    if (passed && warnings.length === 0) {
      risk_level = RiskLevel.LOW;
    }

    const validation_time = (Date.now() - start_time) / 1000.0;

    const result: ValidationResult = {
      passed,
      risk_level,
      warnings,
      recommended_compensations: recommendations.slice(0, 5), // 最多 5 个策略
      alternative_strategies: this._getAlternativeStrategies(task, risk_level),
      validation_time,
      validation_details: details,
      created_at: new Date().toISOString(),
    };

    // 保存验证历史
    await this._lock.runExclusive(() => {
      this.validation_history.push(result);
    });

    return result;
  }

  /**
   * AI 增强的风险评估
   */
  private async _aiEnhancedRiskAssessment(task: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ai_provider) {
      return { risk_detected: false, risks: [], recommended_strategies: [] };
    }

    try {
      // 构建提示
      const prompt = this._buildRiskAssessmentPrompt(task);

      // 调用 AI
      const response = await this.ai_provider.generate(prompt);

      // 解析响应
      return this._parseAiResponse(response);
    } catch {
      return { risk_detected: false, risks: [], recommended_strategies: [] };
    }
  }

  /**
   * 构建风险评估提示
   */
  private _buildRiskAssessmentPrompt(task: Record<string, unknown>): string {
    return `分析以下任务的潜在风险：

任务信息：
- 类型: ${task["type"] ?? "unknown"}
- 复杂度: ${task["complexity"] ?? 5}/10
- 描述: ${task["description"] ?? "无"}
- 特征: ${JSON.stringify(task["features"] ?? {}, null, 2)}

请分析并返回JSON格式：
{
    "risk_detected": true/false,
    "risks": [
        {
            "type": "风险类型",
            "message": "风险描述",
            "severity": "warning/error/critical",
            "recommendation": "建议措施"
        }
    ],
    "recommended_strategies": [
        {
            "type": "策略类型",
            "actions": ["具体行动1", "具体行动2"],
            "priority": 1-5,
            "confidence": 0.0-1.0
        }
    ]
}`;
  }

  /**
   * 解析 AI 响应
   */
  private _parseAiResponse(response: string): Record<string, unknown> {
    try {
      // 尝试提取 JSON
      const json_match = response.match(/\{[\s\S]*\}/);
      if (json_match) {
        return JSON.parse(json_match[0]) as Record<string, unknown>;
      }
    } catch {
      // 忽略解析错误
    }
    return { risk_detected: false, risks: [], recommended_strategies: [] };
  }

  /**
   * 获取备选策略
   */
  private _getAlternativeStrategies(_task: Record<string, unknown>, risk_level: RiskLevelType): string[] {
    const alternatives: string[] = [];

    if (risk_level === RiskLevel.HIGH || risk_level === RiskLevel.CRITICAL) {
      alternatives.push("保守策略");
      alternatives.push("分步执行");
      alternatives.push("人工审核");
    } else if (risk_level === RiskLevel.MEDIUM) {
      alternatives.push("平衡策略");
      alternatives.push("增加监控");
    }

    alternatives.push("默认策略");

    return alternatives;
  }

  /**
   * 执行监控
   *
   * 实时监控执行状态，检测异常模式
   */
  async monitorExecution(_execution_id: string, result: Record<string, unknown>): Promise<MonitorResult> {
    let status = "normal";
    const detected_patterns: string[] = [];
    const anomalies: Array<Record<string, unknown>> = [];
    const recommended_actions: string[] = [];
    const metrics: Record<string, unknown> = {};

    // 1. 基础指标计算
    if (result["execution_time"] !== undefined) {
      metrics["execution_time"] = result["execution_time"];
      metrics["timeout"] = Number(result["execution_time"] ?? 0) > Number(result["timeout"] ?? 300);
    }

    metrics["success"] = Boolean(result["success"] ?? false);

    // 2. 异常模式检测
    for (const [pattern_id, pattern] of this.anomaly_patterns.entries()) {
      if (this._matchPattern(result, pattern)) {
        status = "anomaly";
        detected_patterns.push(pattern_id);
        anomalies.push({
          pattern_id,
          type: pattern.pattern_type,
          indicators: pattern.anomaly_indicators,
          response: pattern.recommended_response,
        });
        recommended_actions.push(pattern.recommended_response);
      }
    }

    // 3. AI 增强的异常检测
    if (this.ai_provider && status === "anomaly") {
      try {
        const ai_recommendations = await this._aiEnhancedAnomalyDetection(result, anomalies);
        recommended_actions.push(...ai_recommendations);
      } catch {
        // 忽略 AI 异常检测失败
      }
    }

    // 4. 确定最终状态
    if (anomalies.some((a) => a["type"] === "error_concentration")) {
      status = "critical";
    }

    return {
      status,
      detected_patterns,
      anomalies,
      recommended_actions: recommended_actions.slice(0, 5),
      metrics,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * 匹配异常模式
   */
  private _matchPattern(result: Record<string, unknown>, pattern: AnomalyPattern): boolean {
    for (const condition of pattern.trigger_conditions) {
      const cond_type = String(condition["type"] ?? "");
      const operator = (condition["operator"] as CompareOperator) ?? "==";
      const value = condition["value"];

      // 获取实际值
      const actual_value = result[cond_type] ?? 0;

      // 比较
      let condition_met = false;
      if (operator === ">=") {
        condition_met = Number(actual_value) >= Number(value);
      } else if (operator === ">") {
        condition_met = Number(actual_value) > Number(value);
      } else if (operator === "<=") {
        condition_met = Number(actual_value) <= Number(value);
      } else if (operator === "<") {
        condition_met = Number(actual_value) < Number(value);
      } else if (operator === "==") {
        condition_met = actual_value === value;
      } else if (operator === "!=") {
        condition_met = actual_value !== value;
      } else {
        condition_met = false;
      }

      if (!condition_met) {
        return false;
      }
    }

    return true;
  }

  /**
   * AI 增强的异常检测
   */
  private async _aiEnhancedAnomalyDetection(
    result: Record<string, unknown>,
    anomalies: Array<Record<string, unknown>>
  ): Promise<string[]> {
    if (!this.ai_provider) return [];

    try {
      const prompt = `分析以下执行异常并推荐额外处理措施：

执行结果：
${JSON.stringify(result, null, 2)}

已检测异常：
${JSON.stringify(anomalies, null, 2)}

请推荐3-5个额外的处理措施，以JSON数组格式返回：
["措施1", "措施2", "措施3"]`;

      const response = await this.ai_provider.generate(prompt);

      const list_match = response.match(/\[[\s\S]*\]/);
      if (list_match) {
        return JSON.parse(list_match[0]) as string[];
      }
    } catch {
      // 忽略解析错误
    }

    return [];
  }

  /**
   * 执行后审查
   *
   * 分析执行结果，提取经验教训，更新模式库
   */
  async postExecuteReview(_execution_id: string, result: Record<string, unknown>): Promise<ReviewResult> {
    const patterns_learned: string[] = [];
    const lessons_learned: string[] = [];
    const improvement_suggestions: string[] = [];

    const success = Boolean(result["success"] ?? false);
    const error_type = (result["error_type"] as string | undefined) ?? null;

    // 1. 结果分析
    if (success) {
      patterns_learned.push("任务成功完成");
      lessons_learned.push("当前策略适用于此类任务");
    } else {
      patterns_learned.push(`任务失败: ${error_type ?? "unknown"}`);
      lessons_learned.push(`错误类型: ${error_type ?? "unknown"}`);

      if (error_type) {
        const strategy = this.compensation_strategies.get(error_type);
        if (strategy) {
          improvement_suggestions.push(`下次遇到${error_type}时使用策略: ${strategy.strategy_id}`);
        } else {
          improvement_suggestions.push(`建议为${error_type}添加补偿策略`);
        }
      }
    }

    // 2. AI 增强的经验提取
    if (this.ai_provider) {
      try {
        const ai_insights = await this._aiExtractLessons(result);
        const lessons = (ai_insights["lessons"] as string[]) ?? [];
        const suggestions = (ai_insights["suggestions"] as string[]) ?? [];
        lessons_learned.push(...lessons);
        improvement_suggestions.push(...suggestions);
      } catch {
        // 忽略 AI 提取失败
      }
    }

    return {
      outcome: success ? "SUCCESS" : "FAILURE",
      patterns_learned,
      fingerprint_updates: [], // 传递给性能画像模块
      lessons_learned,
      improvement_suggestions,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * AI 提取经验教训
   */
  private async _aiExtractLessons(result: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ai_provider) return { lessons: [], suggestions: [] };

    try {
      const prompt = `从以下执行结果中提取经验教训和改进建议：

${JSON.stringify(result, null, 2)}

请返回JSON格式：
{
    "lessons": ["经验1", "经验2"],
    "suggestions": ["建议1", "建议2"]
}`;

      const response = await this.ai_provider.generate(prompt);

      const json_match = response.match(/\{[\s\S]*\}/);
      if (json_match) {
        return JSON.parse(json_match[0]) as Record<string, unknown>;
      }
    } catch {
      // 忽略解析错误
    }

    return { lessons: [], suggestions: [] };
  }

  /** 添加补偿策略 */
  addCompensationStrategy(strategy: CompensationStrategy): void {
    this._lock.runExclusiveSync(() => {
      this.compensation_strategies.set(strategy.error_type, strategy);
    });
  }

  /** 添加异常模式 */
  addAnomalyPattern(pattern: AnomalyPattern): void {
    this._lock.runExclusiveSync(() => {
      this.anomaly_patterns.set(pattern.pattern_id, pattern);
    });
  }

  /**
   * 获取统计信息
   */
  async getStatistics(): Promise<Record<string, unknown>> {
    return this._lock.runExclusive(() => {
      const recent_validations = this.validation_history.slice(-100);

      return {
        agent_id: this.agent_id,
        total_validations: this.validation_history.length,
        recent_validations: recent_validations.length,
        pass_rate:
          recent_validations.length > 0
            ? recent_validations.filter((v) => v.passed).length / recent_validations.length
            : 1.0,
        risk_distribution: this._getRiskDistribution(recent_validations),
        strategy_count: this.compensation_strategies.size,
        pattern_count: this.anomaly_patterns.size,
      };
    });
  }

  /** 获取风险分布 */
  private _getRiskDistribution(validations: ValidationResult[]): Record<string, number> {
    const distribution: Record<string, number> = {
      [RiskLevel.LOW]: 0,
      [RiskLevel.MEDIUM]: 0,
      [RiskLevel.HIGH]: 0,
      [RiskLevel.CRITICAL]: 0,
    };
    for (const v of validations) {
      distribution[v.risk_level] = (distribution[v.risk_level] ?? 0) + 1;
    }
    return distribution;
  }
}
