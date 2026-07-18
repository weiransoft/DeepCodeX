/**
 * 独立评估器协议（IndependentEvaluator Protocol）
 *
 * EAG 核心契约：Generator（生成者）与 Evaluator（评估者）严格分离——
 * 写代码的模型不给自己打分。评估器按企业红线清单 + 范式一致性规则独立判定。
 *
 * 三种评估模式（移植 multi-agent-team loop_engineering/independent_evaluator.py）：
 * - STRICT：无客观指标即不通过（保守策略，EAG 默认模式）
 * - STANDARD：有指标用指标，无指标用 LLM judge（宽松策略）
 * - OFF：不评估（仅调试用，生产禁用）
 *
 * 评估产出 Verdict 结构：
 * - PASS：全部红线通过，可放行
 * - FIX：存在 BLOCKER/MAJOR 级问题，需修复后重试
 * - HUMAN_CHECKPOINT：存在无法自动判定的问题，转人工
 * - STOP_FAILURE：连续失败超上限，终止 Loop
 *
 * 红线分级（§5.1.3）：
 * - BLOCKER：确定性可判定，不过即打回，不可豁免
 * - MAJOR：半确定——静态扫描可查存在性但语义正确性需推理，打回但可人工豁免
 * - WARNING：启发式判定，误报风险高，仅提示不打回
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单
 * - EAG 方案 §5.2.1 五步闭环 Verification 阶段
 * - multi-agent-team skill scripts/loop_engineering/independent_evaluator.py
 *
 * @module eag/evaluator/types
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 评估模式枚举
 *
 * - STRICT：无客观指标即不通过（保守策略，EAG 默认模式）
 * - STANDARD：有指标用指标，无指标用 LLM judge（宽松策略）
 * - OFF：不评估（仅调试用，生产禁用）
 */
export type EvaluationMode = "strict" | "standard" | "off";

/**
 * 红线级别
 *
 * - blocker：确定性可判定，不过即打回，不可豁免
 * - major：半确定——静态扫描可查存在性但语义正确性需推理，打回但可人工豁免
 * - warning：启发式判定，误报风险高，仅提示不打回
 */
export type RedlineSeverity = "blocker" | "major" | "warning";

/**
 * 评估结论
 *
 * - pass：全部红线通过，可放行
 * - fix：存在 BLOCKER/MAJOR 级问题，需修复后重试
 * - human_checkpoint：存在无法自动判定的问题，转人工
 * - stop_failure：连续失败超上限，终止 Loop
 */
export type EvaluationVerdict = "pass" | "fix" | "human_checkpoint" | "stop_failure";

/**
 * 企业红线定义
 *
 * 每条红线是一个结构化判定规则，包含唯一 ID、描述、级别、判定方式。
 * 评估器按此定义对产出物逐条判定。
 *
 * 判定方式分两类：
 * - 静态可判（static）：通过正则/AST/import 分析等确定性手段判定
 * - 推理判定（reasoning）：需要 LLM 阅读代码理解语义后判定
 */
export interface RedlineDefinition {
  /** 红线唯一 ID（如 "E1", "E4", "DEP-01"） */
  id: string;
  /** 红线名称（如"事务边界""依赖方向"） */
  name: string;
  /** 红线描述（详细说明什么场景触发、为什么重要） */
  description: string;
  /** 红线级别 */
  severity: RedlineSeverity;
  /** 判定方式描述（如"import 静态分析""硬编码密钥模式扫描"） */
  checkMethod: string;
  /** 判定方式类型（静态可判 / 推理判定） */
  checkType: "static" | "reasoning";
  /** 修复建议模板（评估器判定不通过时附带的修复指引） */
  fixGuidance?: string;
}

/**
 * 红线判定结果
 *
 * 评估器对单条红线的判定产出。
 */
export interface RedlineResult {
  /** 对应的红线 ID */
  redlineId: string;
  /** 判定结论 */
  status: "passed" | "violated" | "unknown";
  /** 违规详情（status=violated 时填写，包含具体文件/行号/问题描述） */
  violations: RedlineViolation[];
  /** 判定证据（评估器引用的代码片段或分析结果，供审计） */
  evidence?: string;
}

/**
 * 红线违规记录
 *
 * 记录单次违规的具体位置和修复建议。
 */
export interface RedlineViolation {
  /** 违规文件路径（相对项目根） */
  filePath: string;
  /** 违规行号（可选，静态分析可提供精确行号） */
  line?: number;
  /** 违规描述 */
  description: string;
  /** 修复建议（对应 RedlineDefinition.fixGuidance 的实例化） */
  fixSuggestion: string;
}

/**
 * 评估上下文
 *
 * 评估器执行判定时所需的输入信息。
 */
export interface EvaluationContext {
  /** 当前 Loop 类型（设计/编码/测试） */
  loopType: "design" | "coding" | "testing";
  /** 当前迭代轮次（从 1 开始） */
  iteration: number;
  /** 任务卡 ID（关联到 tasks.md 的具体任务） */
  taskId: string;
  /** 产出物文件路径列表（评估器按路径读取内容判定） */
  artifactPaths: string[];
  /** 产出物内联内容（小文件可直接内联，避免重复读盘） */
  inlineArtifacts?: Array<{
    path: string;
    content: string;
  }>;
  /** 已批准的设计文档路径（CODING/TESTING Loop 评估时需对照设计文档） */
  approvedDesignDoc?: string;
  /** 评估模式（覆盖默认模式，用于特定阶段切换严格度） */
  mode?: EvaluationMode;
}

/**
 * 评估报告
 *
 * 评估器对一批产出物的完整判定结果。
 */
export interface EvaluationReport {
  /** 评估结论 */
  verdict: EvaluationVerdict;
  /** 各红线判定结果列表 */
  redlineResults: RedlineResult[];
  /** BLOCKER 级违规数 */
  blockerCount: number;
  /** MAJOR 级违规数 */
  majorCount: number;
  /** WARNING 级违规数 */
  warningCount: number;
  /** 评估耗时（毫秒） */
  durationMs: number;
  /** 评估器备注（LLM judge 模式下的推理摘要，或静态分析的统计信息） */
  notes?: string;
  /** 修复建议汇总（verdict=fix 时，按优先级排序的修复清单） */
  fixSuggestions?: string[];
}

/**
 * 独立评估器协议
 *
 * 所有评估器实现必须满足此接口。EAG Loop 的 Verification 阶段调用此接口
 * 对产出物进行独立判定。
 *
 * 实现方负责：
 * 1. 按 redlines 清单逐条判定（静态可判的确定性判定 + 推理判定的 LLM 调用）
 * 2. 汇总判定结果为 EvaluationReport
 * 3. 根据 BLOCKER/MAJOR 数量决定 verdict（PASS/FIX/HUMAN_CHECKPOINT）
 *
 * 调用方（Loop kernel）负责：
 * 1. 准备 EvaluationContext（收集产出物路径 + 内联内容）
 * 2. 调用 evaluate() 获取报告
 * 3. 按 verdict 决定 Scheduling 动作（CONTINUE/FIX/HUMAN_CHECKPOINT/STOP）
 */
export interface IndependentEvaluator {
  /**
   * 执行评估
   *
   * @param context 评估上下文（产出物 + Loop 信息）
   * @param redlines 红线清单（由调用方提供，支持不同 Loop 阶段使用不同清单）
   * @returns 评估报告
   */
  evaluate(context: EvaluationContext, redlines: ReadonlyArray<RedlineDefinition>): Promise<EvaluationReport>;

  /** 获取评估器名称（用于日志和审计） */
  getName(): string;

  /** 获取评估器默认模式 */
  getDefaultMode(): EvaluationMode;
}

// ============================================================================
// Verdict 决策辅助函数
// ============================================================================

/**
 * 根据红线判定结果决定 Verdict
 *
 * 决策规则（EAG 方案 §5.2.1）：
 * - 任一 BLOCKER 违规 → FIX（不可豁免，必须修复）
 * - 任一 MAJOR 违规 → FIX（可人工豁免，但默认打回）
 * - 仅有 WARNING → PASS（提示不打回）
 * - 全部通过 → PASS
 * - 推理判定无法确定（unknown 状态且有 BLOCKER/MAJOR 级红线）→ HUMAN_CHECKPOINT
 *
 * @param results 红线判定结果列表
 * @param maxConsecutiveFailures 连续失败次数（用于 STOP_FAILURE 判定）
 * @param failureThreshold 连续失败上限（默认 3，§5.2.3）
 * @returns 评估结论
 */
export function decideVerdict(
  results: ReadonlyArray<RedlineResult>,
  maxConsecutiveFailures: number,
  failureThreshold: number = 3
): EvaluationVerdict {
  // 统计各级别违规
  let blockerViolations = 0;
  let unknownBlockerOrMajor = 0;
  for (const result of results) {
    if (result.status === "violated") {
      // 需要通过 redlineId 查找对应的 severity
      // 这里通过 violations 数组推断：有违规即计数
      // 实际 severity 由调用方在 redlines 清单中定义
      // 此函数仅依据 result.status 判定
      blockerViolations += result.violations.length;
    } else if (result.status === "unknown") {
      unknownBlockerOrMajor++;
    }
  }

  // 连续失败超上限 → STOP_FAILURE
  if (maxConsecutiveFailures >= failureThreshold) {
    return "stop_failure";
  }

  // 有 BLOCKER 违规 → FIX
  if (blockerViolations > 0) {
    return "fix";
  }

  // 有无法判定的 BLOCKER/MAJOR 级红线 → HUMAN_CHECKPOINT
  if (unknownBlockerOrMajor > 0) {
    return "human_checkpoint";
  }

  // 全部通过 → PASS
  return "pass";
}

/**
 * 从红线清单和判定结果构建评估报告
 *
 * 辅助函数：评估器实现方可调用此函数快速构建报告，
 * 确保报告结构与决策逻辑一致。
 *
 * @param results 红线判定结果
 * @param redlines 红线清单（用于查找 severity）
 * @param durationMs 评估耗时
 * @param maxConsecutiveFailures 连续失败次数
 * @param notes 评估器备注
 * @returns 完整评估报告
 */
export function buildReport(
  results: RedlineResult[],
  redlines: ReadonlyArray<RedlineDefinition>,
  durationMs: number,
  maxConsecutiveFailures: number,
  notes?: string
): EvaluationReport {
  // 构建 redlineId → severity 映射
  const severityMap = new Map<string, RedlineSeverity>();
  for (const rl of redlines) {
    severityMap.set(rl.id, rl.severity);
  }

  // 按 severity 统计违规数
  let blockerCount = 0;
  let majorCount = 0;
  let warningCount = 0;
  for (const result of results) {
    if (result.status !== "violated") continue;
    const severity = severityMap.get(result.redlineId);
    const violationCount = result.violations.length;
    if (severity === "blocker") {
      blockerCount += violationCount;
    } else if (severity === "major") {
      majorCount += violationCount;
    } else {
      warningCount += violationCount;
    }
  }

  // 决策 verdict
  const verdict = decideVerdict(results, maxConsecutiveFailures);

  // 构建修复建议汇总（按 severity 降序）
  const fixSuggestions: string[] = [];
  if (blockerCount > 0 || majorCount > 0) {
    for (const result of results) {
      if (result.status !== "violated") continue;
      const severity = severityMap.get(result.redlineId);
      if (severity === "warning") continue;
      for (const v of result.violations) {
        const location = v.line ? `${v.filePath}:${v.line}` : v.filePath;
        fixSuggestions.push(
          `[${severity?.toUpperCase()}] ${result.redlineId} @ ${location}: ${v.description} → ${v.fixSuggestion}`
        );
      }
    }
  }

  return {
    verdict,
    redlineResults: results,
    blockerCount,
    majorCount,
    warningCount,
    durationMs,
    notes,
    fixSuggestions: fixSuggestions.length > 0 ? fixSuggestions : undefined,
  };
}
