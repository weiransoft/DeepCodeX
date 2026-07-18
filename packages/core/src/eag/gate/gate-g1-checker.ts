/**
 * G-1 门禁检查器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `GateG1Checker` 类，对应 EAG 方案 §5.12.1 G-1 门禁：
 * "无已批准 spec/plan 禁入 CODING Loop"。
 *
 * 核心职责：
 * - 检查 spec.md 状态机为 approved
 * - 检查 plan.md 状态机为 approved
 * - 任一未批准时返回 blocker 级失败结果，并附引导消息（建议进入 DESIGN Loop）
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 G-1 门禁
 * - §5.10.1 文档即门禁（文档状态机作为 Loop 流转条件）
 * - SEED-10 规则（需求文档先行——spec.md 未批准不得进入 CODING Loop）
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/gate/gate-g1-checker
 */

import type { GateChecker, GateContext, GateResult } from "./gate-types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-1 门禁失败时的引导消息（建议进入 DESIGN Loop）
 *
 * 对齐 §5.12.1 G-1 门禁失败处置：当 spec.md 或 plan.md 未批准时，
 * CODING Loop 不得启动，应回退到 DESIGN Loop 完成方案评审与批准。
 */
const G1_FAILURE_GUIDANCE: string = "建议进入 DESIGN Loop 完成 spec.md 与 plan.md 的评审与批准（SEED-10 需求文档先行）";

// ============================================================================
// GateG1Checker 类
// ============================================================================

/**
 * G-1 门禁检查器
 *
 * 实现 §5.12.1 G-1 门禁：无已批准 spec/plan 禁入 CODING Loop。
 *
 * 检查规则：
 * 1. context.specStatus 必须为 "approved"
 * 2. context.planStatus 必须为 "approved"
 * 3. 任一未批准时返回 blocker 级失败结果
 * 4. 全部通过时返回 passed=true
 *
 * 使用方式：
 *   const checker = new GateG1Checker();
 *   const result = checker.check(context);
 *   if (!result.passed) {
 *     // 阻止进入 CODING Loop，回退到 DESIGN Loop
 *   }
 */
export class GateG1Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-1"） */
  public readonly gateId = "G-1" as const;

  /**
   * 执行 G-1 门禁检查
   *
   * 检查顺序（短路求值，首个失败即返回）：
   * 1. spec.md 状态必须为 "approved"
   * 2. plan.md 状态必须为 "approved"
   *
   * @param context 门禁上下文（含 specStatus / planStatus）
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过）
   */
  public check(context: GateContext): GateResult {
    // 检查 1：spec.md 状态必须为 approved
    if (context.specStatus !== "approved") {
      return Object.freeze({
        passed: false,
        gate: "G-1",
        reason: `spec.md 状态为 "${context.specStatus}"，未批准（SEED-10 需求文档先行）`,
        guidance: G1_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 2：plan.md 状态必须为 approved
    if (context.planStatus !== "approved") {
      return Object.freeze({
        passed: false,
        gate: "G-1",
        reason: `plan.md 状态为 "${context.planStatus}"，未批准（plan.md 必须经评审与批准方可进入 CODING Loop）`,
        guidance: G1_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 全部通过
    return Object.freeze({
      passed: true,
      gate: "G-1",
      reason: "spec.md 与 plan.md 均已批准，可进入 CODING Loop",
      severity: "blocker",
    }) as GateResult;
  }
}
