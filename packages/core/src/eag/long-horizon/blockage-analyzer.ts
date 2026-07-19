/**
 * 阻塞分析器（EAG-P3 批次 10 §4.16）
 *
 * 本模块实现 `BlockageAnalyzer` 类，对应 EAG 方案 §5.12.2 "阻塞分析报告"：
 * 累计 3 次人工介入未解决时生成阻塞分析报告，含根因假设 + 建议方案 + 所需决策清单。
 *
 * 设计依据：
 * - EAG 方案 §5.12.2 阻塞分析报告（根因假设 + 建议方案 + 所需决策）
 * - EAG-P3 批次 10 设计 §4.16 BlockageAnalyzer（双通道：规则匹配 + LLM 推断）
 *
 * 双通道根因分析（关键技术决策）：
 * - 通道 1：规则匹配（RootCauseRuleMatcher）
 *   基于 DEFAULT_ROOT_CAUSE_RULES 4 条规则，confidence 0.6~0.8
 *   规则覆盖已知失败模式（同红线 3 次失败 / 同任务卡 FIX 失败 / 覆盖率连续 BLOCKER / LLM 超时）
 * - 通道 2：LLM 推断（可选）
 *   当规则匹配不足时，调用 LLM 生成开放性根因假设，confidence ≤0.6 防幻觉
 *   LLM 通道为可选（未提供 llmClient 时仅使用规则匹配）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/long-horizon/blockage-analyzer
 */

import type { LoopType } from "../loop/models";
import type { LLMClient, LLMRequest, LLMResponse } from "../../providers/llm-provider";
import type { SessionMessage, SessionMessageRole } from "../../session";
import type { RuleStore } from "../rlis/rule-store";
import type { UserRule } from "../rlis/types";
import type {
  BlockageReport,
  HumanInterventionRecord,
  LogCallback,
  RootCauseHypothesis,
  RootCauseRule,
  RunState,
  SuggestedSolution,
  RequiredDecision,
  DecisionOption,
  SolutionCost,
} from "./types";
import {
  BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD,
  DEFAULT_ROOT_CAUSE_RULES,
  LLM_INFERRED_CONFIDENCE_CAP,
} from "./types";
import type { RunStateStore } from "./run-state-store";

// ============================================================================
// 1. 自定义错误类
// ============================================================================

/**
 * BlockageAnalyzer 错误类型字面量联合
 *
 * - invalid-request：请求参数非法
 * - run-state-not-found：RunState 未找到
 * - run-state-corrupted：RunState SHA256 校验失败
 * - llm-inference-failed：LLM 推断失败（如 LLM 调用异常 / JSON 解析失败）
 * - rule-store-error：RuleStore 查询异常
 */
export type BlockageAnalyzerErrorKind =
  | "invalid-request"
  | "run-state-not-found"
  | "run-state-corrupted"
  | "llm-inference-failed"
  | "rule-store-error";

/**
 * BlockageAnalyzer 错误
 *
 * 自定义错误类，含 kind（错误类型）+ 原始异常（cause）便于上层诊断。
 */
export class BlockageAnalyzerError extends Error {
  /** 错误类型字面量（便于程序化分支处理） */
  public readonly kind: BlockageAnalyzerErrorKind;

  /**
   * @param kind 错误类型
   * @param message 错误消息
   * @param cause 原始异常（可选）
   */
  constructor(
    kind: BlockageAnalyzerErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "BlockageAnalyzerError";
    this.kind = kind;
  }
}

// ============================================================================
// 2. 阻塞分析请求
// ============================================================================

/**
 * 阻塞分析请求
 *
 * 对应 §4.16 BlockageAnalyzeRequest：
 * 调用方提供 runId / projectRoot / blockedLoop / blockedIteration，
 * llmClient 可选（未提供时仅使用规则匹配通道，不调用 LLM 推断）。
 *
 * 字段全部 readonly。
 */
export interface BlockageAnalyzeRequest {
  /** run-id */
  readonly runId: string;
  /** 项目根目录 */
  readonly projectRoot: string;
  /** 阻塞的 Loop 类型 */
  readonly blockedLoop: LoopType;
  /** 阻塞的迭代号（currentIteration） */
  readonly blockedIteration: number;
  /** LLM 客户端（可选，未提供时不调用 LLM 推断通道） */
  readonly llmClient?: LLMClient;
}

// ============================================================================
// 3. 根因规则匹配器（独立可测）
// ============================================================================

/**
 * 根因规则匹配器
 *
 * 对应 §4.16 RootCauseRuleMatcher：
 * 基于 DEFAULT_ROOT_CAUSE_RULES 4 条规则匹配根因假设。
 *
 * 规则匹配逻辑：
 * - rc-001（same-redline-3-failures）：检测介入记录中同一红线连续 3 次失败
 *   → 根因假设"评估器规则过严或代码确实违规"
 * - rc-002（same-task-fix-exhausted）：检测同一任务卡 FIX 失败 3 次
 *   → 根因假设"任务卡声明模糊或 LLM 上下文不足"
 * - rc-003（coverage-blocker-2-consecutive）：检测覆盖率连续 2 次 BLOCKER
 *   → 根因假设"覆盖率阈值过严或代码不可测"
 * - rc-004（llm-timeout-multiple）：检测多次 LLM 调用超时
 *   → 根因假设"LLM 上下文不足或网络问题"
 *
 * 设计理由（独立可测）：
 * - 规则匹配纯函数，无副作用，便于单元测试覆盖各种介入历史组合
 * - 与 BlockageAnalyzer 解耦，未来可被其他场景复用（如 PR 描述生成时识别阻塞模式）
 */
export class RootCauseRuleMatcher {
  /** 根因规则列表（默认 DEFAULT_ROOT_CAUSE_RULES） */
  private readonly rules: ReadonlyArray<RootCauseRule>;

  /**
   * @param rules 根因规则列表（默认 DEFAULT_ROOT_CAUSE_RULES）
   */
  constructor(rules: ReadonlyArray<RootCauseRule> = DEFAULT_ROOT_CAUSE_RULES) {
    this.rules = Object.freeze([...rules]);
  }

  /**
   * 基于规则匹配根因假设
   *
   * 算法：
   * 1. 遍历 4 条规则，对每条规则调用对应的匹配函数
   * 2. 命中规则 → 生成 RootCauseHypothesis（source="rule-based"）
   * 3. 收集所有命中的假设并返回
   *
   * @param interventions 人工介入记录列表
   * @param runState 当前 RunState（用于查询 currentLoop / currentIteration 等上下文）
   * @returns 规则匹配的根因假设列表（source="rule-based"）
   */
  match(
    interventions: ReadonlyArray<HumanInterventionRecord>,
    runState: Readonly<RunState>
  ): ReadonlyArray<RootCauseHypothesis> {
    const hypotheses: RootCauseHypothesis[] = [];

    // 规则 rc-001：同一红线连续 3 次失败
    const rc001Evidence = this.matchSameRedline3Failures(interventions);
    if (rc001Evidence.length > 0) {
      const rule = this.findRule("rc-001");
      if (rule) {
        hypotheses.push(
          Object.freeze({
            hypothesisId: "rc-001",
            description: rule.description,
            confidence: rule.confidence,
            evidence: Object.freeze([...rc001Evidence]),
            source: "rule-based",
          })
        );
      }
    }

    // 规则 rc-002：同一任务卡 FIX 失败 3 次
    const rc002Evidence = this.matchSameTaskFixExhausted(interventions);
    if (rc002Evidence.length > 0) {
      const rule = this.findRule("rc-002");
      if (rule) {
        hypotheses.push(
          Object.freeze({
            hypothesisId: "rc-002",
            description: rule.description,
            confidence: rule.confidence,
            evidence: Object.freeze([...rc002Evidence]),
            source: "rule-based",
          })
        );
      }
    }

    // 规则 rc-003：覆盖率连续 2 次 BLOCKER
    const rc003Evidence = this.matchCoverageBlocker2Consecutive(interventions);
    if (rc003Evidence.length > 0) {
      const rule = this.findRule("rc-003");
      if (rule) {
        hypotheses.push(
          Object.freeze({
            hypothesisId: "rc-003",
            description: rule.description,
            confidence: rule.confidence,
            evidence: Object.freeze([...rc003Evidence]),
            source: "rule-based",
          })
        );
      }
    }

    // 规则 rc-004：多次 LLM 调用超时
    const rc004Evidence = this.matchLlmTimeoutMultiple(interventions, runState);
    if (rc004Evidence.length > 0) {
      const rule = this.findRule("rc-004");
      if (rule) {
        hypotheses.push(
          Object.freeze({
            hypothesisId: "rc-004",
            description: rule.description,
            confidence: rule.confidence,
            evidence: Object.freeze([...rc004Evidence]),
            source: "rule-based",
          })
        );
      }
    }

    return Object.freeze(hypotheses);
  }

  // ============================ 私有方法 ============================

  /**
   * 按规则 ID 查找规则
   *
   * @param ruleId 规则 ID
   * @returns 规则对象；不存在时返回 undefined
   */
  private findRule(ruleId: string): RootCauseRule | undefined {
    return this.rules.find((r) => r.ruleId === ruleId);
  }

  /**
   * 规则 rc-001：同一红线连续 3 次失败
   *
   * 匹配逻辑：
   * - 扫描介入记录的 reason 字段，提取红线 ID（如 "E7"/"E3" 等）
   * - 同一红线 ID 在介入记录中出现 ≥3 次 → 命中规则
   *
   * @param interventions 介入记录列表
   * @returns 支持证据列表（命中时非空）
   */
  private matchSameRedline3Failures(interventions: ReadonlyArray<HumanInterventionRecord>): string[] {
    // 提取所有介入记录中提到的红线 ID（格式如 "E7"/"E3" 等）
    const redlineCounts = new Map<string, number>();
    const redlineEvidences = new Map<string, string[]>();

    for (const intervention of interventions) {
      // 在 reason 字段中匹配 E1~E99 格式的红线 ID
      const matches = intervention.reason.match(/\bE(\d{1,2})\b/g);
      if (matches) {
        for (const match of matches) {
          const count = (redlineCounts.get(match) ?? 0) + 1;
          redlineCounts.set(match, count);
          const evidences = redlineEvidences.get(match) ?? [];
          evidences.push(`${intervention.intervenedAt} 红线 ${match} 失败：${intervention.reason}`);
          redlineEvidences.set(match, evidences);
        }
      }
    }

    // 收集出现 ≥3 次的红线
    const evidence: string[] = [];
    for (const [redlineId, count] of redlineCounts.entries()) {
      if (count >= 3) {
        const redlineEvs = redlineEvidences.get(redlineId) ?? [];
        evidence.push(...redlineEvs);
      }
    }

    return evidence;
  }

  /**
   * 规则 rc-002：同一任务卡 FIX 失败 3 次
   *
   * 匹配逻辑：
   * - 扫描介入记录的 reason 字段，提取任务卡 ID（如 "T-001"/"T-002" 等）
   * - 同一任务卡 ID 在介入记录中出现 ≥3 次 → 命中规则
   *
   * @param interventions 介入记录列表
   * @returns 支持证据列表（命中时非空）
   */
  private matchSameTaskFixExhausted(interventions: ReadonlyArray<HumanInterventionRecord>): string[] {
    // 提取所有介入记录中提到的任务卡 ID（格式如 "T-001"/"T-002"）
    const taskCounts = new Map<string, number>();
    const taskEvidences = new Map<string, string[]>();

    for (const intervention of interventions) {
      // 在 reason 字段中匹配 T-NNN 格式的任务卡 ID
      const matches = intervention.reason.match(/\bT-(\d{1,4})\b/g);
      if (matches) {
        for (const match of matches) {
          const count = (taskCounts.get(match) ?? 0) + 1;
          taskCounts.set(match, count);
          const evidences = taskEvidences.get(match) ?? [];
          evidences.push(`${intervention.intervenedAt} 任务卡 ${match} FIX 失败：${intervention.reason}`);
          taskEvidences.set(match, evidences);
        }
      }
    }

    // 收集出现 ≥3 次的任务卡
    const evidence: string[] = [];
    for (const [taskId, count] of taskCounts.entries()) {
      if (count >= 3) {
        const taskEvs = taskEvidences.get(taskId) ?? [];
        evidence.push(...taskEvs);
      }
    }

    return evidence;
  }

  /**
   * 规则 rc-003：覆盖率连续 2 次 BLOCKER
   *
   * 匹配逻辑：
   * - 扫描介入记录的 reason 字段，识别"覆盖率"/"coverage"/"BLOCKER"关键词
   * - 连续 2 条介入记录都提到覆盖率 BLOCKER → 命中规则
   *
   * @param interventions 介入记录列表
   * @returns 支持证据列表（命中时非空）
   */
  private matchCoverageBlocker2Consecutive(interventions: ReadonlyArray<HumanInterventionRecord>): string[] {
    // 按时间排序介入记录
    const sorted = [...interventions].sort((a, b) => a.intervenedAt.localeCompare(b.intervenedAt));

    const coverageBlockerPattern = /覆盖率|coverage|BLOCKER/i;
    let consecutiveCount = 0;
    const evidence: string[] = [];

    for (const intervention of sorted) {
      if (coverageBlockerPattern.test(intervention.reason)) {
        consecutiveCount += 1;
        evidence.push(`${intervention.intervenedAt} 覆盖率 BLOCKER：${intervention.reason}`);
        if (consecutiveCount >= 2) {
          // 命中规则：连续 2 次覆盖率 BLOCKER
          return evidence.slice(-2);
        }
      } else {
        // 中断连续性
        consecutiveCount = 0;
        evidence.length = 0;
      }
    }

    return [];
  }

  /**
   * 规则 rc-004：多次 LLM 调用超时
   *
   * 匹配逻辑：
   * - 扫描介入记录的 reason 字段，识别"LLM"/"超时"/"timeout"关键词
   * - 累计 ≥2 次包含 LLM 超时关键词的介入记录 → 命中规则
   *
   * @param interventions 介入记录列表
   * @param runState 当前 RunState（用于查询 LLM 调用统计）
   * @returns 支持证据列表（命中时非空）
   */
  private matchLlmTimeoutMultiple(
    interventions: ReadonlyArray<HumanInterventionRecord>,
    runState: Readonly<RunState>
  ): string[] {
    const llmTimeoutPattern = /LLM|超时|timeout/i;
    const evidence: string[] = [];

    for (const intervention of interventions) {
      if (llmTimeoutPattern.test(intervention.reason)) {
        evidence.push(`${intervention.intervenedAt} LLM 超时：${intervention.reason}`);
      }
    }

    // 若有 ≥2 次 LLM 超时记录 → 命中
    if (evidence.length >= 2) {
      // 附加 RunState 中的 LLM 调用统计作为补充证据
      const llmStats = `RunState 统计：总 LLM 调用 ${runState.totalLlmCallCount} 次，总 token 消耗 ${runState.totalTokensUsed}`;
      evidence.push(llmStats);
      return evidence;
    }

    return [];
  }
}

// ============================================================================
// 4. BlockageAnalyzer 类
// ============================================================================

/**
 * 阻塞分析器
 *
 * 对应 §4.16 BlockageAnalyzer：
 * 累计 3 次人工介入未解决时生成阻塞分析报告。
 *
 * 用法：
 * ```typescript
 * const analyzer = new BlockageAnalyzer(runStateStore, ruleStore, logger);
 * const report = await analyzer.analyze({
 *   runId: "a1b2c3d4e5f6",
 *   projectRoot: "/path/to/project",
 *   blockedLoop: "coding",
 *   blockedIteration: 5,
 *   llmClient: new InMemoryLLMClient(),  // 可选
 * });
 * // report.rootCauseHypotheses.length > 0
 * // report.suggestedSolutions.length > 0
 * // report.requiredDecisions.length > 0
 * ```
 *
 * 设计约束：
 * - 规则匹配优先于 LLM 推断（先规则后 LLM，避免 LLM 重复规则匹配的根因）
 * - LLM 推断为可选通道（未提供 llmClient 时仅使用规则匹配）
 * - LLM 推断 confidence ≤0.6 防幻觉（对齐 §4.16 LLM_INFERRED_CONFIDENCE_CAP）
 */
export class BlockageAnalyzer {
  // ============================ 依赖组件 ============================

  /** RunState 持久化存储（必填） */
  private readonly runStateStore: RunStateStore;
  /** RLIS 规则库（可选，用于查找匹配的建议方案） */
  private readonly ruleStore?: RuleStore;
  /** 日志回调 */
  private readonly log: LogCallback;
  /** 根因规则匹配器（独立可测） */
  private readonly ruleMatcher: RootCauseRuleMatcher;

  /**
   * @param runStateStore RunState 持久化存储（必填）
   * @param ruleStore RLIS 规则库（可选，未提供时不查询规则库建议）
   * @param logger 日志回调（可选，默认 noop）
   * @param ruleMatcher 根因规则匹配器（可选，默认 new RootCauseRuleMatcher()）
   */
  constructor(
    runStateStore: RunStateStore,
    ruleStore?: RuleStore,
    logger: LogCallback = noopLog,
    ruleMatcher?: RootCauseRuleMatcher
  ) {
    if (!runStateStore) {
      throw new BlockageAnalyzerError("invalid-request", "runStateStore 必填");
    }
    this.runStateStore = runStateStore;
    this.ruleStore = ruleStore;
    this.log = logger;
    this.ruleMatcher = ruleMatcher ?? new RootCauseRuleMatcher();
  }

  // ============================ 公共 API ============================

  /**
   * 分析阻塞并生成报告
   *
   * 算法（对齐 §4.16.3）：
   * 1. 校验请求字段
   * 2. 加载 RunState（含 SHA256 校验）
   * 3. 收集未解决的人工介入记录
   * 4. 通道 1：规则匹配（RootCauseRuleMatcher.match）
   *    - 基于 DEFAULT_ROOT_CAUSE_RULES 4 条规则
   *    - 输出 source="rule-based" 根因假设，confidence 0.6~0.8
   * 5. 通道 2：LLM 推断（可选，llmClient 提供时）
   *    - 装配 prompt（介入历史 + 失败模式 + 当前 RunState）
   *    - 调用 LLM 生成根因假设列表
   *    - 输出 source="llm-inferred" 根因假设，confidence ≤0.6
   * 6. 生成建议方案（基于规则库 + LLM 补全）
   *    - 规则匹配：从 RuleStore 查找匹配的建议
   *    - LLM 补全：基于根因假设生成方案
   * 7. 生成决策清单：每根因假设 → 2~4 个决策选项 + 推荐选项
   * 8. 构造 BlockageReport 并返回冻结对象
   *
   * @param request 分析请求
   * @returns 阻塞分析报告
   * @throws BlockageAnalyzerError 请求非法 / RunState 加载失败 / LLM 推断失败
   */
  async analyze(request: Readonly<BlockageAnalyzeRequest>): Promise<Readonly<BlockageReport>> {
    // 1. 校验请求字段
    this.validateRequest(request);

    this.log(
      `分析阻塞：runId=${request.runId} blockedLoop=${request.blockedLoop} iteration=${request.blockedIteration}`,
      "info"
    );

    // 2. 加载 RunState
    let runState: Readonly<RunState>;
    try {
      runState = await this.runStateStore.load(request.runId, request.projectRoot);
    } catch (err) {
      // 区分 RunState 不存在与 SHA256 校验失败
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("not found") || errMsg.includes("不存在")) {
        throw new BlockageAnalyzerError(
          "run-state-not-found",
          `RunState 未找到：runId=${request.runId} projectRoot=${request.projectRoot}`,
          err
        );
      }
      throw new BlockageAnalyzerError("run-state-corrupted", `RunState 校验失败：${errMsg}`, err);
    }

    // 3. 收集未解决的人工介入记录
    const unresolvedInterventions = runState.humanInterventions.filter((i) => !i.resolved);
    this.log(`未解决的介入记录数：${unresolvedInterventions.length}`, "info");

    // 4. 通道 1：规则匹配
    const ruleBasedHypotheses = this.ruleMatcher.match(unresolvedInterventions, runState);
    this.log(`规则匹配根因假设数：${ruleBasedHypotheses.length}`, "info");

    // 5. 通道 2：LLM 推断（可选）
    let llmInferredHypotheses: ReadonlyArray<RootCauseHypothesis> = [];
    if (request.llmClient) {
      try {
        llmInferredHypotheses = await this.inferRootCausesWithLLM(
          request.llmClient,
          unresolvedInterventions,
          runState,
          ruleBasedHypotheses
        );
        this.log(`LLM 推断根因假设数：${llmInferredHypotheses.length}`, "info");
      } catch (err) {
        // LLM 推断失败不阻塞报告生成（仅记录日志，规则匹配结果仍可用）
        this.log(`LLM 推断失败（不影响规则匹配结果）：${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }

    // 6. 合并根因假设（规则匹配在前，LLM 推断在后）
    const allHypotheses: RootCauseHypothesis[] = [...ruleBasedHypotheses, ...llmInferredHypotheses];

    // 7. 生成建议方案
    const suggestedSolutions = this.generateSuggestedSolutions(allHypotheses, request.llmClient);

    // 8. 生成决策清单
    const requiredDecisions = this.generateRequiredDecisions(allHypotheses);

    // 9. 构造 BlockageReport
    const report: BlockageReport = Object.freeze({
      runId: request.runId,
      generatedAt: new Date().toISOString(),
      blockedLoop: request.blockedLoop,
      blockedIteration: request.blockedIteration,
      rootCauseHypotheses: Object.freeze([...allHypotheses]),
      suggestedSolutions: Object.freeze([...suggestedSolutions]),
      requiredDecisions: Object.freeze([...requiredDecisions]),
      relatedInterventions: Object.freeze([...unresolvedInterventions]),
    });

    return report;
  }

  // ============================ 私有方法：校验 ============================

  /**
   * 校验分析请求字段
   *
   * @param request 分析请求
   * @throws BlockageAnalyzerError 任一字段非法
   */
  private validateRequest(request: Readonly<BlockageAnalyzeRequest>): void {
    if (!request || typeof request !== "object") {
      throw new BlockageAnalyzerError("invalid-request", "request 必须为对象");
    }
    if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
      throw new BlockageAnalyzerError("invalid-request", "runId 必须为非空字符串");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new BlockageAnalyzerError("invalid-request", "projectRoot 必须为非空字符串");
    }
    // blockedLoop 校验：必须为 "design" | "coding" | "testing"
    if (request.blockedLoop !== "design" && request.blockedLoop !== "coding" && request.blockedLoop !== "testing") {
      throw new BlockageAnalyzerError(
        "invalid-request",
        `blockedLoop 非法：${request.blockedLoop}（合法值：design/coding/testing）`
      );
    }
    if (!Number.isInteger(request.blockedIteration) || request.blockedIteration < 0) {
      throw new BlockageAnalyzerError(
        "invalid-request",
        `blockedIteration 必须为非负整数，实际值：${request.blockedIteration}`
      );
    }
  }

  // ============================ 私有方法：LLM 推断 ============================

  /**
   * 使用 LLM 推断根因假设
   *
   * 算法：
   * 1. 装配 prompt（介入历史 + 失败模式 + 当前 RunState + 已有规则匹配结果）
   * 2. 调用 LLM 生成根因假设列表（JSON 格式）
   * 3. 解析 JSON 响应，提取根因假设
   * 4. 钳制 confidence ≤ LLM_INFERRED_CONFIDENCE_CAP（0.6，防幻觉）
   * 5. 标记 source="llm-inferred"
   *
   * @param llmClient LLM 客户端
   * @param interventions 未解决的介入记录
   * @param runState 当前 RunState
   * @param ruleBasedHypotheses 规则匹配的根因假设（用于让 LLM 避免重复）
   * @returns LLM 推断的根因假设列表（source="llm-inferred"）
   * @throws BlockageAnalyzerError LLM 调用失败 / JSON 解析失败
   */
  private async inferRootCausesWithLLM(
    llmClient: LLMClient,
    interventions: ReadonlyArray<HumanInterventionRecord>,
    runState: Readonly<RunState>,
    ruleBasedHypotheses: ReadonlyArray<RootCauseHypothesis>
  ): Promise<ReadonlyArray<RootCauseHypothesis>> {
    // 1. 装配 prompt
    const prompt = this.buildLlmPrompt(interventions, runState, ruleBasedHypotheses);
    // 构造 SessionMessage 数组（含全部必填字段）
    const nowIso = new Date().toISOString();
    const sessionId = `blockage-${runState.runId}`;
    const messages: SessionMessage[] = [
      {
        id: `msg-system-${nowIso}`,
        sessionId,
        role: "system" as SessionMessageRole,
        content:
          "你是一个企业应用生成系统的阻塞分析专家。基于人工介入历史与 RunState 状态，" +
          "推断阻塞的根因假设。每个根因假设需含 description 与 confidence（0~1）。\n" +
          '输出 JSON 数组格式：[{"description": "...", "confidence": 0.5}]\n' +
          "不要输出任何额外内容，仅输出 JSON 数组。",
        contentParams: null,
        messageParams: null,
        compacted: false,
        visible: false,
        createTime: nowIso,
        updateTime: nowIso,
      },
      {
        id: `msg-user-${nowIso}`,
        sessionId,
        role: "user" as SessionMessageRole,
        content: prompt,
        contentParams: null,
        messageParams: null,
        compacted: false,
        visible: false,
        createTime: nowIso,
        updateTime: nowIso,
      },
    ];

    const llmRequest: LLMRequest = {
      messages,
      thinkingEnabled: false,
      maxTokens: 2000,
    };

    // 2. 调用 LLM
    let response: LLMResponse;
    try {
      response = await llmClient.createMessage(llmRequest);
    } catch (err) {
      throw new BlockageAnalyzerError(
        "llm-inference-failed",
        `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // 3. 解析 JSON 响应
    const rawContent = response.content.trim();
    if (rawContent.length === 0) {
      this.log("LLM 响应内容为空，跳过 LLM 推断", "warn");
      return [];
    }

    let parsed: unknown;
    try {
      // 提取 JSON 数组（兼容 markdown 代码块包裹的 JSON）
      const jsonStr = this.extractJsonArray(rawContent);
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      throw new BlockageAnalyzerError(
        "llm-inference-failed",
        `LLM 响应 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // 4. 校验与转换解析结果
    if (!Array.isArray(parsed)) {
      throw new BlockageAnalyzerError("llm-inference-failed", `LLM 响应非 JSON 数组：${rawContent.substring(0, 200)}`);
    }

    const hypotheses: RootCauseHypothesis[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i] as Record<string, unknown>;
      if (!item || typeof item !== "object") continue;
      const description = typeof item.description === "string" ? item.description : "";
      const rawConfidence = typeof item.confidence === "number" ? item.confidence : 0;
      if (description.length === 0) continue;

      // 钳制 confidence ≤ LLM_INFERRED_CONFIDENCE_CAP（防幻觉）
      const confidence = Math.max(0, Math.min(LLM_INFERRED_CONFIDENCE_CAP, rawConfidence));

      hypotheses.push(
        Object.freeze({
          hypothesisId: `llm-${i + 1}`,
          description,
          confidence,
          evidence: Object.freeze([`LLM 推断（基于 ${interventions.length} 条介入记录 + RunState 状态）`]),
          source: "llm-inferred",
        })
      );
    }

    return Object.freeze(hypotheses);
  }

  /**
   * 装配 LLM prompt
   *
   * @param interventions 介入记录
   * @param runState RunState
   * @param ruleBasedHypotheses 规则匹配的根因假设
   * @returns 完整的 prompt 字符串
   */
  private buildLlmPrompt(
    interventions: ReadonlyArray<HumanInterventionRecord>,
    runState: Readonly<RunState>,
    ruleBasedHypotheses: ReadonlyArray<RootCauseHypothesis>
  ): string {
    const parts: string[] = [];
    parts.push("## 当前 RunState 状态");
    parts.push(`- runId: ${runState.runId}`);
    parts.push(`- currentLoop: ${runState.currentLoop}`);
    parts.push(`- currentIteration: ${runState.currentIteration}`);
    parts.push(`- humanInterventionCount: ${runState.humanInterventionCount}`);
    parts.push(`- completedLoops: ${runState.completedLoops.join(", ") || "（无）"}`);
    parts.push(`- totalLlmCallCount: ${runState.totalLlmCallCount}`);
    parts.push(`- totalTokensUsed: ${runState.totalTokensUsed}`);
    parts.push("");

    parts.push("## 未解决的人工介入记录");
    for (const intervention of interventions) {
      parts.push(
        `- ${intervention.intervenedAt} [${intervention.loopType}] ${intervention.reason}` +
          `（决策：${intervention.decision}）`
      );
    }
    parts.push("");

    parts.push("## 已通过规则匹配的根因假设（请勿重复）");
    if (ruleBasedHypotheses.length === 0) {
      parts.push("- （无规则匹配结果）");
    } else {
      for (const h of ruleBasedHypotheses) {
        parts.push(`- ${h.hypothesisId}: ${h.description}（confidence=${h.confidence}）`);
      }
    }
    parts.push("");

    parts.push("## 任务");
    parts.push("基于上述信息，推断额外的根因假设（规则未覆盖的开放性根因）。");
    parts.push("输出 JSON 数组，每项含 description（字符串）与 confidence（0~1 数字）。");
    parts.push("confidence 上限 0.6（防幻觉）。");
    return parts.join("\n");
  }

  /**
   * 从 LLM 响应中提取 JSON 数组字符串
   *
   * 兼容以下格式：
   * - 纯 JSON 数组（直接返回）
   * - markdown 代码块包裹的 JSON（提取 ```json ... ``` 中的内容）
   *
   * @param raw 原始响应内容
   * @returns 提取的 JSON 字符串
   */
  private extractJsonArray(raw: string): string {
    // 1. 尝试直接匹配 markdown 代码块
    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    // 2. 尝试提取第一个 [ 到最后一个 ]
    const startIdx = raw.indexOf("[");
    const endIdx = raw.lastIndexOf("]");
    if (startIdx >= 0 && endIdx > startIdx) {
      return raw.substring(startIdx, endIdx + 1);
    }
    // 3. 返回原始内容（让 JSON.parse 抛错）
    return raw;
  }

  // ============================ 私有方法：建议方案生成 ============================

  /**
   * 生成建议方案列表
   *
   * 算法：
   * 1. 遍历所有根因假设
   * 2. 对每个假设：
   *    a. 若 ruleStore 提供且能找到匹配的 RLIS 规则 → 基于 RLIS 规则生成方案
   *    b. 否则基于假设 ID 内置生成默认方案
   *
   * @param hypotheses 根因假设列表
   * @param llmClient LLM 客户端（可选，本版本未使用 LLM 补全方案）
   * @returns 建议方案列表
   */
  private generateSuggestedSolutions(
    hypotheses: ReadonlyArray<RootCauseHypothesis>,
    _llmClient?: LLMClient
  ): SuggestedSolution[] {
    const solutions: SuggestedSolution[] = [];
    let solutionIdx = 1;

    for (const hypothesis of hypotheses) {
      // 查找 RLIS 规则库中匹配的建议
      let rlisRuleId: string | undefined;
      if (this.ruleStore) {
        const matchedRule = this.findMatchingRlisRule(hypothesis);
        if (matchedRule) {
          rlisRuleId = matchedRule.id;
        }
      }

      // 基于假设 ID 生成默认方案
      const defaultSolution = this.buildDefaultSolution(hypothesis, solutionIdx, rlisRuleId);
      solutions.push(defaultSolution);
      solutionIdx += 1;
    }

    return solutions;
  }

  /**
   * 查找匹配的 RLIS 规则
   *
   * 匹配逻辑：
   * - 根因假设 hypothesisId 为 "rc-001" → 查找与"评估器规则过严"相关的 RLIS 规则
   * - 根因假设 hypothesisId 为 "rc-002" → 查找与"任务卡声明"相关的 RLIS 规则
   * - 根因假设 hypothesisId 为 "rc-003" → 查找与"覆盖率阈值"相关的 RLIS 规则
   * - 根因假设 hypothesisId 为 "rc-004" → 查找与"LLM 上下文"相关的 RLIS 规则
   *
   * @param hypothesis 根因假设
   * @returns 匹配的 RLIS 规则；未找到时返回 undefined
   */
  private findMatchingRlisRule(hypothesis: RootCauseHypothesis): UserRule | undefined {
    if (!this.ruleStore) return undefined;

    const effectiveRules = this.ruleStore.getEffectiveRules();
    // 按假设 ID 匹配关键词
    const keywordMap: Record<string, string[]> = {
      "rc-001": ["评估器", "evaluator", "红线", "redline"],
      "rc-002": ["任务卡", "task", "FIX"],
      "rc-003": ["覆盖率", "coverage"],
      "rc-004": ["LLM", "上下文", "context", "timeout"],
    };

    const keywords = keywordMap[hypothesis.hypothesisId] ?? [];
    if (keywords.length === 0) return undefined;

    // 在规则描述中查找包含关键词的规则
    for (const rule of effectiveRules) {
      const ruleText = `${rule.id} ${rule.content}`.toLowerCase();
      for (const keyword of keywords) {
        if (ruleText.includes(keyword.toLowerCase())) {
          return rule;
        }
      }
    }

    return undefined;
  }

  /**
   * 基于假设 ID 构建默认建议方案
   *
   * 算法：根据 hypothesisId 内置生成对应的建议方案描述、预期效果与成本。
   *
   * @param hypothesis 根因假设
   * @param idx 方案序号（用于生成 solutionId）
   * @param rlisRuleId 关联的 RLIS 规则 ID（可选）
   * @returns 建议方案
   */
  private buildDefaultSolution(hypothesis: RootCauseHypothesis, idx: number, rlisRuleId?: string): SuggestedSolution {
    const solutionId = `sol-${String(idx).padStart(3, "0")}`;

    // 按 hypothesisId 内置方案
    let description: string;
    let expectedEffect: string;
    let cost: SolutionCost;

    switch (hypothesis.hypothesisId) {
      case "rc-001":
        description =
          "放宽评估器规则或修复代码违规：检查红线 ID 对应的评估器规则是否过严，必要时调整 severity 或 fixGuidance；若代码确实违规则修复代码。";
        expectedEffect = "评估器规则放宽后放过合理设计；代码修复后红线不再 violated。";
        cost = "low";
        break;
      case "rc-002":
        description =
          "重写任务卡声明或扩大 LLM 上下文窗口：检查任务卡声明是否清晰可执行；增加 spec/plan/tasks 上下文注入。";
        expectedEffect = "任务卡声明清晰后 FIX 一次通过；LLM 上下文充足后生成质量提升。";
        cost = "medium";
        break;
      case "rc-003":
        description =
          "调整覆盖率阈值或重构代码使其可测：检查阈值是否过严（如 100% 高风险符号）；重构代码降低耦合度便于测试。";
        expectedEffect = "覆盖率达标或阈值合理化；代码可测性提升。";
        cost = "high";
        break;
      case "rc-004":
        description = "扩大 LLM 上下文窗口或检查网络连接：增加 PKC 知识注入；检查 LLM 服务可达性。";
        expectedEffect = "LLM 调用不再超时；上下文充足减少重试。";
        cost = "low";
        break;
      default:
        // LLM 推断的假设（hypothesisId 以 "llm-" 开头）
        description = `针对根因假设"${hypothesis.description}"制定修复方案：基于 LLM 推断的根因，结合项目实际情况调整。`;
        expectedEffect = "解决根因后阻塞解除。";
        cost = "medium";
        break;
    }

    return Object.freeze({
      solutionId,
      description,
      targetHypothesisId: hypothesis.hypothesisId,
      rlisRuleId,
      expectedEffect,
      cost,
    });
  }

  // ============================ 私有方法：决策清单生成 ============================

  /**
   * 生成决策清单
   *
   * 算法：每个根因假设生成 1 个 RequiredDecision，含 2~4 个选项 + 推荐选项。
   *
   * @param hypotheses 根因假设列表
   * @returns 决策清单
   */
  private generateRequiredDecisions(hypotheses: ReadonlyArray<RootCauseHypothesis>): RequiredDecision[] {
    const decisions: RequiredDecision[] = [];

    for (let i = 0; i < hypotheses.length; i++) {
      const hypothesis = hypotheses[i];
      const decisionId = `dec-${String(i + 1).padStart(3, "0")}`;

      // 按假设 ID 内置决策选项
      const decision = this.buildDefaultDecision(hypothesis, decisionId);
      decisions.push(decision);
    }

    return decisions;
  }

  /**
   * 基于假设 ID 构建默认决策
   *
   * @param hypothesis 根因假设
   * @param decisionId 决策 ID
   * @returns 决策对象（含选项与推荐选项）
   */
  private buildDefaultDecision(hypothesis: RootCauseHypothesis, decisionId: string): RequiredDecision {
    let description: string;
    let options: DecisionOption[];
    let recommendedOptionId: string;

    switch (hypothesis.hypothesisId) {
      case "rc-001":
        description = "如何处理评估器规则过严或代码违规？";
        options = [
          {
            optionId: "opt-1",
            description: "放宽评估器规则（降低 severity 或调整 fixGuidance）",
            impact: "可能放过部分违规设计，需人工复核",
          },
          {
            optionId: "opt-2",
            description: "修复代码违规",
            impact: "代码质量提升，但需额外开发时间",
          },
          {
            optionId: "opt-3",
            description: "维持现状并人工豁免本次违规",
            impact: "短期通过，长期技术债累积",
          },
        ];
        recommendedOptionId = "opt-2";
        break;
      case "rc-002":
        description = "如何处理任务卡声明模糊或 LLM 上下文不足？";
        options = [
          {
            optionId: "opt-1",
            description: "重写任务卡声明（明确输入/输出/验收标准）",
            impact: "任务可执行性提升，但需重新评审",
          },
          {
            optionId: "opt-2",
            description: "扩大 LLM 上下文窗口（增加 spec/plan 注入）",
            impact: "LLM 生成质量提升，token 成本增加",
          },
          {
            optionId: "opt-3",
            description: "拆分任务卡为更小粒度",
            impact: "单次 LLM 调用复杂度降低，但任务数量增加",
          },
        ];
        recommendedOptionId = "opt-1";
        break;
      case "rc-003":
        description = "如何处理覆盖率阈值过严或代码不可测？";
        options = [
          {
            optionId: "opt-1",
            description: "调整覆盖率阈值（如高风险符号从 100% 降至 90%）",
            impact: "覆盖率达标，但可能放过部分未测符号",
          },
          {
            optionId: "opt-2",
            description: "重构代码提升可测性",
            impact: "代码质量提升，但重构成本高",
          },
          {
            optionId: "opt-3",
            description: "补充测试用例覆盖未测符号",
            impact: "覆盖率提升，但需额外测试开发时间",
          },
        ];
        recommendedOptionId = "opt-3";
        break;
      case "rc-004":
        description = "如何处理 LLM 上下文不足或网络问题？";
        options = [
          {
            optionId: "opt-1",
            description: "检查 LLM 服务可达性与网络连接",
            impact: "排除网络问题，恢复 LLM 调用",
          },
          {
            optionId: "opt-2",
            description: "增加 PKC 知识注入，扩大上下文窗口",
            impact: "LLM 上下文充足，生成质量提升",
          },
          {
            optionId: "opt-3",
            description: "切换到更快的 LLM 模型（如 economy tier）",
            impact: "响应速度提升，但生成质量可能下降",
          },
        ];
        recommendedOptionId = "opt-1";
        break;
      default:
        // LLM 推断的假设
        description = `如何处理根因"${hypothesis.description}"？`;
        options = [
          {
            optionId: "opt-1",
            description: "采纳 LLM 推断并制定修复方案",
            impact: "解决根因，但需进一步分析可行性",
          },
          {
            optionId: "opt-2",
            description: "忽略 LLM 推断，继续规则匹配",
            impact: "保守策略，可能错过根因",
          },
          {
            optionId: "opt-3",
            description: "人工审阅 LLM 推断后决定",
            impact: "决策更稳健，但需人工介入",
          },
        ];
        recommendedOptionId = "opt-3";
        break;
    }

    return Object.freeze({
      decisionId,
      description,
      options: Object.freeze(options),
      recommendedOptionId,
    });
  }
}

// ============================================================================
// 5. 默认日志函数
// ============================================================================

/**
 * 空日志函数（默认值，避免每次调用都判断 null）
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认不输出日志
}

// ============================================================================
// 6. 重新导出常量（便于测试与外部使用）
// ============================================================================

/**
 * 重新导出 BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD
 *
 * 便于调用方从 blockage-analyzer 统一导入触发阈值。
 */
export { BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD };

/**
 * 重新导出 LLM_INFERRED_CONFIDENCE_CAP
 *
 * 便于测试断言 LLM 推断 confidence 上限。
 */
export { LLM_INFERRED_CONFIDENCE_CAP };

/**
 * 重新导出 DEFAULT_ROOT_CAUSE_RULES
 *
 * 便于测试断言默认规则集与 RootCauseRuleMatcher 构造默认值。
 */
export { DEFAULT_ROOT_CAUSE_RULES };
