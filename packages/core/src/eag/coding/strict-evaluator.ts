/**
 * STRICT 评估器（EAG-P2 批次 9 S3 核心组件层）
 *
 * 本模块实现 `StrictEvaluator` 类，对应 EAG-P2 批次 9 设计 §4.5 STRICT 评估器：
 * 实现 `IndependentEvaluator` 协议（来自 `eag/evaluator/types.ts`），
 * 对 Phase B 产出的代码按红线清单逐条判定，输出 `EvaluationReport`。
 *
 * 核心职责（对齐 §4.5.1）：
 * 1. 收集所有产出物内容（artifactPaths 读盘 + inlineArtifacts 直取）
 * 2. 遍历 redlines 清单，对每条红线按 checkType 路由判定：
 *    a. checkType="static" → 调用对应 StaticChecker.check(artifacts, redline)
 *    b. checkType="reasoning" + 静态 Checker 存在 → 静态判定优先（unknown 时不降级 LLM，
 *       保留 unknown 状态由 buildReport 决策为 HUMAN_CHECKPOINT）
 *    c. checkType="reasoning" + 无静态 Checker → 标记为 unknown（STRICT 模式不主动调 LLM）
 * 3. 收集所有 RedlineResult
 * 4. 调用 buildReport(results, redlines, durationMs, maxConsecutiveFailures) 构建报告
 * 5. 返回 EvaluationReport
 *
 * 关键技术决策（对齐 §4.5.2）：
 * - STRICT 模式默认：无客观指标即不通过（保守策略，EAG 默认模式）
 * - 静态判定优先：13 个独立 Checker 类（单一职责 + 可独立单元测试）
 * - LLM judge 仅在 checkType="reasoning" 红线且静态判定为 unknown 时调用
 *   （本批次 strict-evaluator 实现不主动调用 LLM；LLM 调用由 FixLoop 阶段触发）
 * - 红线清单运行时注入（支持不同 Loop 阶段使用不同清单）
 * - 产出物通过 artifactPaths + inlineArtifacts 双通道（评估器不依赖文件系统状态）
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单（静态可判 redline.checkType="static"）
 * - EAG 方案 §5.2.1 五步闭环 Verification 阶段
 * - EAG-P2 批次 9 设计 §4.5.1 职责
 * - EAG-P2 批次 9 设计 §4.5.2 关键技术决策
 * - EAG-P2 批次 9 设计 §4.5.3 核心类设计
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单（13 个，由 S2 实现）
 * - EAG-P2 批次 9 设计 §4.5.5 DEFAULT_STATIC_CHECKERS 注册表（由 S2 实现）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有方法入参与返回值使用 readonly + ReadonlyArray
 * - 顶层配置使用 Object.freeze 冻结
 * - 评估产出 EvaluationReport 通过 buildReport 构建（buildReport 内部冻结）
 *
 * @module eag/coding/strict-evaluator
 */

import type {
  EvaluationContext,
  EvaluationMode,
  EvaluationReport,
  IndependentEvaluator,
  RedlineDefinition,
  RedlineResult,
} from "../evaluator/types";
import { buildReport } from "../evaluator/types";
import type { StaticChecker } from "./types";
import { DEFAULT_STATIC_CHECKERS } from "./static-checkers";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 评估器名称（用于日志和审计）
 *
 * 对齐 §4.5.3 核心类设计：`getName(): string { return "StrictEvaluator"; }`
 */
const EVALUATOR_NAME = "StrictEvaluator" as const;

/**
 * 默认评估模式
 *
 * 对齐 §4.5.2 关键技术决策："STRICT 模式默认（§5.1.3 + §8.1）"。
 * - STRICT：无客观指标即不通过（保守策略，EAG 默认模式）
 */
const DEFAULT_EVALUATION_MODE: EvaluationMode = "strict" as const;

/**
 * 默认连续失败上限（用于 STOP_FAILURE 判定）
 *
 * 对齐 §5.2.3 + §5.12.2 失败上限纪律："连续 3 次 FIX 失败 → HUMAN_CHECKPOINT"。
 * 当 maxConsecutiveFailures >= 3 时，decideVerdict 返回 stop_failure。
 */
const DEFAULT_FAILURE_THRESHOLD = 3 as const;

/**
 * 默认连续失败次数（首次评估时为 0）
 *
 * 评估器首次调用时无历史失败记录，maxConsecutiveFailures=0。
 * FIX Loop 在重试时累加此值并传入下次评估。
 */
const DEFAULT_CONSECUTIVE_FAILURES = 0 as const;

// ============================================================================
// 异常类型
// ============================================================================

/**
 * STRICT 评估器错误
 *
 * 当入参非法、StaticChecker 调用异常等场景抛出。
 */
export class StrictEvaluatorError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-context：评估上下文字段非法（artifactPaths 为空且 inlineArtifacts 为空）
   *   - redlines-empty：红线清单为空
   *   - checker-error：StaticChecker.check 抛出异常
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-context" | "redlines-empty" | "checker-error",
    public readonly detail: string
  ) {
    super(`STRICT 评估器错误 [${kind}]：${detail}`);
    this.name = "StrictEvaluatorError";
  }
}

// ============================================================================
// 辅助类型与函数
// ============================================================================

/**
 * 标准化的产出物（含路径与内容）
 *
 * 评估器内部使用的产出物表示，由 inlineArtifacts 与 artifactPaths 合并而来。
 * 对于 artifactPaths（仅含路径），评估器需读取文件内容；
 * 对于 inlineArtifacts（已含内容），直接使用。
 *
 * 注：本批次 strict-evaluator 实现中，artifactPaths 的文件读取由调用方负责
 * （在装配 EvaluationContext 时将大文件内联到 inlineArtifacts），
 * 评估器仅处理 inlineArtifacts；若 artifactPaths 中的路径未内联，则跳过该产出物
 * 并在 notes 中记录。这是为了避免评估器直接依赖文件系统（提升测试性）。
 */
interface NormalizedArtifact {
  /** 产出物路径（相对项目根） */
  readonly path: string;
  /** 产出物内容（字符串形式） */
  readonly content: string;
}

/**
 * 收集并合并产出物
 *
 * 算法：
 * 1. 以 inlineArtifacts 为基础（已含路径与内容）
 * 2. 对 artifactPaths 中未在 inlineArtifacts 出现的路径，标记为"未内联"
 * 3. 返回合并后的 NormalizedArtifact 列表 + 未内联路径列表
 *
 * @param context 评估上下文
 * @returns 合并后的产出物列表与未内联路径列表
 */
function collectArtifacts(context: Readonly<EvaluationContext>): {
  artifacts: NormalizedArtifact[];
  missingPaths: string[];
} {
  const artifacts: NormalizedArtifact[] = [];
  const inlinePaths = new Set<string>();
  const missingPaths: string[] = [];

  // 1. 收集 inlineArtifacts（已含内容）
  if (context.inlineArtifacts && context.inlineArtifacts.length > 0) {
    for (const artifact of context.inlineArtifacts) {
      artifacts.push({ path: artifact.path, content: artifact.content });
      inlinePaths.add(artifact.path);
    }
  }

  // 2. 检查 artifactPaths 中未内联的路径
  if (context.artifactPaths && context.artifactPaths.length > 0) {
    for (const path of context.artifactPaths) {
      if (!inlinePaths.has(path)) {
        missingPaths.push(path);
      }
    }
  }

  return { artifacts, missingPaths };
}

// ============================================================================
// StrictEvaluator 类
// ============================================================================

/**
 * STRICT 评估器
 *
 * 对应 EAG-P2 批次 9 设计 §4.5.3 StrictEvaluator：
 * 实现 IndependentEvaluator 协议，对产出物按红线清单逐条判定。
 *
 * 使用方式：
 * ```typescript
 * const evaluator = new StrictEvaluator();
 * const report = await evaluator.evaluate(
 *   {
 *     loopType: "coding",
 *     iteration: 1,
 *     taskId: "T-001",
 *     artifactPaths: ["src/domain/OrderAggregate.ts"],
 *     inlineArtifacts: [
 *       { path: "src/domain/OrderAggregate.ts", content: "..." }
 *     ],
 *   },
 *   [...ENTERPRISE_REDLINES, ...TCS_REDLINES]
 * );
 * if (report.verdict === "pass") { /* 通过 *\/ }
 * else if (report.verdict === "fix") { /* 进入 FIX Loop *\/ }
 * ```
 *
 * 不可变优先：
 * - 构造时注入的 staticCheckers 使用 ReadonlyMap 包裹
 * - evaluate() 返回的 EvaluationReport 通过 buildReport 构建（内部冻结）
 */
export class StrictEvaluator implements IndependentEvaluator {
  /**
   * 静态判定器映射（按红线 ID 路由）
   *
   * 默认为 DEFAULT_STATIC_CHECKERS（13 个 Checker 实例，由 S2 提供）。
   * 多对一映射：多个 redlineId 可映射到同一 Checker 实例
   * （如 E4 与 TCS-OSS-01 都映射到 ImportAnalyzer）。
   */
  private readonly staticCheckers: ReadonlyMap<string, StaticChecker>;

  /**
   * 日志回调（可选，用于输出调试信息）
   */
  private readonly logger?: (message: string, level?: "info" | "warn" | "error") => void;

  /**
   * 初始化 STRICT 评估器
   *
   * @param staticCheckers 静态判定器映射（默认 DEFAULT_STATIC_CHECKERS）
   * @param logger 日志回调（可选）
   */
  constructor(
    staticCheckers: ReadonlyMap<string, StaticChecker> = DEFAULT_STATIC_CHECKERS,
    logger?: (message: string, level?: "info" | "warn" | "error") => void
  ) {
    this.staticCheckers = staticCheckers;
    this.logger = logger;
  }

  // ========================================================================
  // IndependentEvaluator 协议实现
  // ========================================================================

  /**
   * 获取评估器名称（用于日志和审计）
   *
   * @returns 评估器名称 "StrictEvaluator"
   */
  getName(): string {
    return EVALUATOR_NAME;
  }

  /**
   * 获取评估器默认模式
   *
   * @returns 评估模式 "strict"
   */
  getDefaultMode(): EvaluationMode {
    return DEFAULT_EVALUATION_MODE;
  }

  /**
   * 执行 STRICT 评估
   *
   * 算法（对齐 §4.5.3）：
   * 1. 校验入参合法性（context / redlines 非空）
   * 2. 收集所有产出物内容（inlineArtifacts + artifactPaths 中已内联部分）
   * 3. 遍历 redlines 清单，对每条红线：
   *    a. 在 staticCheckers 中查找 redline.id 对应的 Checker
   *    b. 若找到 Checker：调用 check(artifacts, redline) 得到 RedlineResult
   *    c. 若未找到 Checker：
   *       - checkType="static" → 返回 unknown（STRICT 模式下静态红线无 Checker 即无法判定）
   *       - checkType="reasoning" → 返回 unknown（STRICT 模式不主动调 LLM，
   *         由 buildReport 决策为 HUMAN_CHECKPOINT）
   * 4. 收集所有 RedlineResult 到 results 数组
   * 5. 调用 buildReport(results, redlines, durationMs, maxConsecutiveFailures) 构建报告
   * 6. 在 notes 中附加未内联路径列表（如有）
   * 7. 返回 EvaluationReport
   *
   * @param context 评估上下文（产出物 + Loop 信息）
   * @param redlines 红线清单（由调用方提供，支持不同 Loop 阶段使用不同清单）
   * @returns 评估报告
   * @throws {StrictEvaluatorError} 入参非法或 StaticChecker 调用异常
   */
  async evaluate(
    context: Readonly<EvaluationContext>,
    redlines: ReadonlyArray<RedlineDefinition>
  ): Promise<EvaluationReport> {
    this.logger?.("StrictEvaluator.evaluate 启动", "info");
    const startTime = Date.now();

    // 步骤 1：校验入参合法性
    this.validateInputs(context, redlines);

    // 步骤 2：收集产出物
    const { artifacts, missingPaths } = collectArtifacts(context);
    if (artifacts.length === 0) {
      this.logger?.("评估上下文无产出物（inlineArtifacts 与 artifactPaths 均为空）", "warn");
    }
    if (missingPaths.length > 0) {
      this.logger?.(
        `artifactPaths 中有 ${missingPaths.length} 个路径未内联到 inlineArtifacts：${missingPaths.join(", ")}`,
        "warn"
      );
    }

    // 步骤 3：遍历红线清单逐条判定
    const results: RedlineResult[] = [];
    for (const redline of redlines) {
      const result = this.evaluateRedline(redline, artifacts);
      results.push(result);

      // 日志输出判定结果（便于调试）
      this.logger?.(
        `红线 ${redline.id} [${redline.severity}] 判定结果：${result.status}${
          result.status === "violated" ? `（${result.violations.length} 个违规）` : ""
        }`,
        result.status === "violated" ? "warn" : "info"
      );
    }

    // 步骤 4：构建评估报告
    const durationMs = Date.now() - startTime;
    const maxConsecutiveFailures = DEFAULT_CONSECUTIVE_FAILURES;

    // 步骤 5：附加 notes（未内联路径 + 评估统计）
    const notesParts: string[] = [];
    if (missingPaths.length > 0) {
      notesParts.push(`未内联产出物路径：${missingPaths.join(", ")}`);
    }
    notesParts.push(
      `评估统计：红线 ${redlines.length} 条，产出物 ${artifacts.length} 个，` +
        `通过 ${results.filter((r) => r.status === "passed").length} 条，` +
        `违规 ${results.filter((r) => r.status === "violated").length} 条，` +
        `未知 ${results.filter((r) => r.status === "unknown").length} 条`
    );
    const notes = notesParts.join("\n");

    // buildReport 内部根据 redlines 中各 redline.severity 统计 blocker/major/warning 计数
    const report = buildReport(results, redlines, durationMs, maxConsecutiveFailures, notes);

    this.logger?.(
      `StrictEvaluator.evaluate 完成，verdict=${report.verdict}，` +
        `blocker=${report.blockerCount}/major=${report.majorCount}/warning=${report.warningCount}，` +
        `耗时 ${durationMs}ms`,
      report.verdict === "pass" ? "info" : "warn"
    );

    return report;
  }

  // ========================================================================
  // 公共 API：便捷查询
  // ========================================================================

  /**
   * 获取已注册的静态判定器数量
   *
   * @returns 静态判定器数量（默认 19 条 redlineId → 13 个 Checker 实例的多对一映射）
   */
  getStaticCheckerCount(): number {
    return this.staticCheckers.size;
  }

  /**
   * 检查指定红线 ID 是否有对应的静态判定器
   *
   * @param redlineId 红线 ID（如 "E1" / "TCS-CACHE-01"）
   * @returns true 表示有对应 Checker；false 表示无（评估时返回 unknown）
   */
  hasStaticChecker(redlineId: string): boolean {
    return this.staticCheckers.has(redlineId);
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 校验 evaluate 方法入参合法性
   *
   * 校验规则：
   * - context 必须含非空 loopType / taskId
   * - context.artifactPaths 与 context.inlineArtifacts 至少一个非空
   * - redlines 必须为非空数组
   *
   * @param context 评估上下文
   * @param redlines 红线清单
   * @throws {StrictEvaluatorError} 任一字段非法时抛出
   */
  private validateInputs(context: Readonly<EvaluationContext>, redlines: ReadonlyArray<RedlineDefinition>): void {
    if (!context || typeof context.loopType !== "string" || context.loopType.trim().length === 0) {
      throw new StrictEvaluatorError("invalid-context", "context.loopType 必须为非空字符串");
    }
    if (typeof context.taskId !== "string" || context.taskId.trim().length === 0) {
      throw new StrictEvaluatorError("invalid-context", "context.taskId 必须为非空字符串");
    }
    const hasArtifacts =
      (Array.isArray(context.artifactPaths) && context.artifactPaths.length > 0) ||
      (Array.isArray(context.inlineArtifacts) && context.inlineArtifacts.length > 0);
    if (!hasArtifacts) {
      throw new StrictEvaluatorError(
        "invalid-context",
        "context.artifactPaths 与 context.inlineArtifacts 至少一个必须非空"
      );
    }
    if (!Array.isArray(redlines) || redlines.length === 0) {
      throw new StrictEvaluatorError("redlines-empty", "redlines 必须为非空数组");
    }
  }

  /**
   * 评估单条红线
   *
   * 路由算法：
   * 1. 在 staticCheckers 中查找 redline.id 对应的 Checker
   * 2. 若找到 Checker：调用 check(artifacts, redline)
   *    - 包裹 try/catch 防止单个 Checker 异常影响整体评估
   *    - 异常时返回 unknown 状态（含 evidence 字段记录异常信息）
   * 3. 若未找到 Checker：返回 unknown 状态（STRICT 模式不主动调 LLM）
   *
   * @param redline 当前红线定义
   * @param artifacts 产出物列表
   * @returns 红线判定结果
   */
  private evaluateRedline(
    redline: Readonly<RedlineDefinition>,
    artifacts: ReadonlyArray<NormalizedArtifact>
  ): RedlineResult {
    const checker = this.staticCheckers.get(redline.id);
    if (!checker) {
      // 未找到对应 Checker：返回 unknown（STRICT 模式不主动调 LLM）
      return {
        redlineId: redline.id,
        status: "unknown",
        violations: [],
        evidence: `未注册 redline.id="${redline.id}" 对应的 StaticChecker（checkType="${redline.checkType}"）`,
      };
    }

    // 调用 Checker.check（包裹 try/catch 防止单个 Checker 异常影响整体评估）
    try {
      // 将 NormalizedArtifact[] 转为 Checker 期望的入参类型
      const checkerArtifacts = artifacts.map((a) => ({ path: a.path, content: a.content }));
      return checker.check(checkerArtifacts, redline);
    } catch (e) {
      // Checker 异常：返回 unknown 状态，evidence 记录异常信息
      const errorMsg = e instanceof Error ? e.message : String(e);
      return {
        redlineId: redline.id,
        status: "unknown",
        violations: [],
        evidence: `StaticChecker.check 抛出异常：${errorMsg}`,
      };
    }
  }
}
