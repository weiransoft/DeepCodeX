/**
 * G-5 退出门禁检查器（EAG-P2 批次 9 S3 核心组件层）
 *
 * 本模块实现 `GateG5Checker` 类，对应 EAG-P2 批次 9 设计 §4.8.3 G-5 门禁：
 * "CODING Loop 退出门禁——所有任务卡 completed + STRICT 评估通过 + git 工作区干净 + gitleaks 通过"。
 *
 * 核心职责（对齐 §4.8.3）：
 * G-5 校验 CODING Loop 退出的 4 个前置条件：
 * 1. 所有任务卡 status=completed（通过 allTaskCards 列表校验）
 * 2. 最终 STRICT 评估 verdict=pass（通过 finalEvaluationReport 字段校验）
 * 3. git 工作区无未提交变更（通过 gitClean 字段校验）
 * 4. gitleaks 扫描通过（通过 gitleaksPassed 字段校验）
 *
 * 任一失败 → 返回 passed=false, severity=blocker
 *
 * 设计依据：
 * - EAG-P2 批次 9 设计 §4.8.1 设计依据
 * - EAG-P2 批次 9 设计 §4.8.3 G-5 门禁判定规则
 * - EAG-P2 批次 9 设计 §4.8.4 GateG5Context 扩展字段
 *
 * 与设计文档的实现偏差说明（真实实现需求）：
 * - 设计文档 §4.8.3 写"最终 STRICT 评估 verdict=pass（调用 evaluator.evaluate）"，
 *   但 GateG5Context 已含 finalEvaluationReport 字段（由调用方在装配上下文时
 *   调用 StrictEvaluator.evaluate 后传入）。修复方式：G-5 直接校验
 *   context.finalEvaluationReport.verdict === "pass"，避免重复评估。
 *   构造函数仍接受 evaluator 参数以对齐设计 API（保留可扩展性，
 *   如未来需要在 G-5 内重新触发评估的场景）。
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 公开方法返回冻结对象
 * - 构造时注入的 evaluator 使用 readonly 包裹
 * - check() 返回的 GateResult 通过 Object.freeze 冻结
 *
 * @module eag/gate/gate-g5-checker
 */

import type { GateChecker, GateContext, GateResult, GateG5Context } from "./gate-types";
import type { StrictEvaluator } from "../coding/strict-evaluator";
import type { TaskCardStatus } from "../doc-driven/types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-5 门禁失败时的引导消息（建议补齐未完成项后重试）
 *
 * 对齐 §4.8.3 G-5 门禁失败处置：当任一前置条件不满足时，CODING Loop 不得退出，
 * 应继续完成剩余任务卡 / 修复 STRICT 评估发现的问题 / 提交 git 变更 / 修复 gitleaks 告警。
 */
const G5_FAILURE_GUIDANCE: string =
  "建议继续完成剩余任务卡 / 修复 STRICT 评估发现的问题 / 提交 git 变更 / 修复 gitleaks 告警后重试 G-5 门禁";

/**
 * 任务卡完成状态值
 *
 * 对齐 doc-driven/types.ts 中 TaskCardStatus 字面量联合的 "completed" 值。
 * G-5 校验所有任务卡 status 全为 "completed"。
 */
const TASK_STATUS_COMPLETED: TaskCardStatus = "completed";

// ============================================================================
// GateG5Checker 类
// ============================================================================

/**
 * G-5 门禁检查器
 *
 * 实现 §4.8.3 G-5 门禁：CODING Loop 退出门禁。
 *
 * 检查规则（对齐 §4.8.3 判定规则）：
 * 1. context.allTaskCards 所有任务卡 status=completed
 * 2. context.finalEvaluationReport.verdict === "pass"
 * 3. context.gitClean === true
 * 4. context.gitleaksPassed === true
 *
 * 任一失败 → 返回 passed=false, severity=blocker
 *
 * 使用方式：
 * ```typescript
 * const evaluator = new StrictEvaluator();
 * const checker = new GateG5Checker(evaluator);
 * const result = checker.check(g5Context);
 * if (!result.passed) {
 *   // 阻止退出 CODING Loop，继续完成剩余任务或修复问题
 * }
 * ```
 *
 * 注：G-5 上下文（GateG5Context）继承自 GateContext，扩展了
 * allTaskCards / finalEvaluationReport / gitClean / gitleaksPassed 字段。
 * 调用方在装配 GateG5Context 时应确保所有字段已填充（finalEvaluationReport
 * 由调用方先调用 StrictEvaluator.evaluate 获取后传入）。
 */
export class GateG5Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-5"） */
  public readonly gateId = "G-5" as const;

  /**
   * STRICT 评估器实例（用于设计 API 对齐与可扩展性）
   *
   * 设计文档 §4.8.3 显示 G-5 构造函数接受 evaluator 参数。
   * 本实现中 G-5 直接校验 context.finalEvaluationReport.verdict（由调用方
   * 在装配上下文时调用 evaluator.evaluate 后传入），不主动调用 evaluator。
   *
   * 保留此字段以对齐设计 API，并支持未来扩展场景（如 G-5 内重新触发评估）。
   */
  private readonly evaluator: StrictEvaluator;

  /**
   * 初始化 G-5 门禁检查器
   *
   * @param evaluator STRICT 评估器实例（用于设计 API 对齐与可扩展性）
   */
  constructor(evaluator: StrictEvaluator) {
    this.evaluator = evaluator;
  }

  /**
   * 执行 G-5 门禁检查
   *
   * 检查顺序（短路求值，首个失败即返回）：
   * 1. allTaskCards 所有任务卡 status=completed
   * 2. finalEvaluationReport.verdict === "pass"
   * 3. gitClean === true
   * 4. gitleaksPassed === true
   *
   * @param context 门禁上下文（GateG5Context，含 G-5 扩展字段）
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过）
   */
  public check(context: GateContext): GateResult {
    // G-5 上下文需为 GateG5Context（含扩展字段）
    // 由于 GateChecker 协议定义 check(context: GateContext)，此处需类型断言
    const g5Context = context as GateG5Context;

    // 检查 1：所有任务卡 status=completed
    const allTaskCards = g5Context.allTaskCards;
    if (!Array.isArray(allTaskCards) || allTaskCards.length === 0) {
      return Object.freeze({
        passed: false,
        gate: "G-5",
        reason: `allTaskCards 为空（CODING Loop 退出前必须含至少一张任务卡）`,
        guidance: G5_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    const incompleteTasks = allTaskCards.filter((taskCard) => taskCard.status !== TASK_STATUS_COMPLETED);
    if (incompleteTasks.length > 0) {
      const incompleteIds = incompleteTasks.map((t) => `${t.id}(${t.status})`).join(", ");
      return Object.freeze({
        passed: false,
        gate: "G-5",
        reason: `存在 ${incompleteTasks.length} 张未完成的任务卡：${incompleteIds}（G-5 要求所有任务卡 status=completed）`,
        guidance: G5_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 2：最终 STRICT 评估 verdict=pass
    const evaluationReport = g5Context.finalEvaluationReport;
    if (!evaluationReport || typeof evaluationReport.verdict !== "string") {
      return Object.freeze({
        passed: false,
        gate: "G-5",
        reason: `finalEvaluationReport 缺失或 verdict 字段非法（CODING Loop 退出前必须完成最终 STRICT 评估）`,
        guidance: G5_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }
    if (evaluationReport.verdict !== "pass") {
      const blockerCount = evaluationReport.blockerCount ?? 0;
      const majorCount = evaluationReport.majorCount ?? 0;
      const warningCount = evaluationReport.warningCount ?? 0;
      return Object.freeze({
        passed: false,
        gate: "G-5",
        reason:
          `最终 STRICT 评估 verdict="${evaluationReport.verdict}"（非 pass），` +
          `blocker=${blockerCount}/major=${majorCount}/warning=${warningCount}（G-5 要求 STRICT 评估通过方可退出 CODING Loop）`,
        guidance: G5_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 3：git 工作区无未提交变更
    if (g5Context.gitClean !== true) {
      return Object.freeze({
        passed: false,
        gate: "G-5",
        reason: `git 工作区不干净（存在未提交变更，G-5 要求退出 CODING Loop 前 git 工作区必须 clean）`,
        guidance: G5_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 4：gitleaks 扫描通过
    if (g5Context.gitleaksPassed !== true) {
      return Object.freeze({
        passed: false,
        gate: "G-5",
        reason: `gitleaks 扫描未通过（存在密钥泄露告警，G-5 要求退出 CODING Loop 前 gitleaks 必须通过）`,
        guidance: G5_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 全部通过
    return Object.freeze({
      passed: true,
      gate: "G-5",
      reason:
        `G-5 门禁通过：所有 ${allTaskCards.length} 张任务卡 status=completed，` +
        `STRICT 评估 verdict=pass，git 工作区干净，gitleaks 通过`,
      severity: "blocker",
    }) as GateResult;
  }

  // ========================================================================
  // 公共 API：便捷查询
  // ========================================================================

  /**
   * 获取构造时注入的 STRICT 评估器实例
   *
   * 用于调用方在需要时复用同一评估器实例（如 FixLoop 阶段）。
   *
   * @returns STRICT 评估器实例
   */
  getEvaluator(): StrictEvaluator {
    return this.evaluator;
  }
}
