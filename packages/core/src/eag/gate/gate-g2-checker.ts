/**
 * G-2 门禁检查器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `GateG2Checker` 类，对应 EAG 方案 §5.12.1 G-2 门禁：
 * "方案必经多角色评审 + 用户批准"。
 *
 * 核心职责：
 * - 检查评审角色数 ≥ G2_MIN_REVIEW_ROLES（至少 2 角色，含 architect + test-expert）
 * - 检查评审记录中无 reject 结论（reject 视为 BLOCKER）
 * - 检查用户是否已显式批准（context.userApproved === true）
 * - 任一未满足时返回 blocker 级失败结果，并附引导消息（建议召集多角色评审会议）
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 G-2 门禁
 * - §5.12.1 多角色评审要求：架构师 + 测试专家至少 2 角色
 * - 用户批准作为最终授权（防止 LLM 自我批准）
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/gate/gate-g2-checker
 */

import {
  G2_FULL_REVIEW_ROLES,
  G2_MIN_REVIEW_ROLES,
  type GateChecker,
  type GateContext,
  type GateResult,
  type ReviewRecord,
} from "./gate-types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-2 门禁失败时的引导消息（建议召集多角色评审会议）
 *
 * 对齐 §5.12.1 G-2 门禁失败处置：方案未通过多角色评审或未经用户批准时，
 * 应召集多角色评审会议完成评审，并由用户显式批准。
 */
const G2_FAILURE_GUIDANCE: string =
  "建议召集多角色评审会议（至少含 architect 与 test-expert）完成评审，并由用户显式批准方案";

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 从评审记录列表中提取去重的角色集合
 *
 * @param records 评审记录列表
 * @returns 去重后的角色集合（Set<ReviewRole>）
 */
function collectReviewedRoles(records: ReadonlyArray<ReviewRecord>): Set<ReviewRecord["role"]> {
  const roles = new Set<ReviewRecord["role"]>();
  for (const record of records) {
    roles.add(record.role);
  }
  return roles;
}

/**
 * 从评审记录列表中筛选出 reject 结论的记录
 *
 * @param records 评审记录列表
 * @returns reject 结论的评审记录列表
 */
function collectRejectedRecords(records: ReadonlyArray<ReviewRecord>): ReviewRecord[] {
  const rejected: ReviewRecord[] = [];
  for (const record of records) {
    if (record.verdict === "reject") {
      rejected.push(record);
    }
  }
  return rejected;
}

// ============================================================================
// GateG2Checker 类
// ============================================================================

/**
 * G-2 门禁检查器
 *
 * 实现 §5.12.1 G-2 门禁：方案必经多角色评审 + 用户批准。
 *
 * 检查规则：
 * 1. 评审记录数 ≥ G2_MIN_REVIEW_ROLES（至少 2 角色）
 * 2. 评审角色必须包含 architect 与 test-expert（§5.12.1 明确要求）
 * 3. 评审记录中不得有 reject 结论（reject 视为 BLOCKER）
 * 4. 用户必须显式批准（context.userApproved === true）
 * 5. 完整性提示：评审角色数 < G2_FULL_REVIEW_ROLES（4 角色）时仅 warning，不阻断
 *
 * 使用方式：
 *   const checker = new GateG2Checker();
 *   const result = checker.check(context);
 *   if (!result.passed) {
 *     // 阻止进入 CODING Loop，召集多角色评审会议
 *   }
 */
export class GateG2Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-2"） */
  public readonly gateId = "G-2" as const;

  /**
   * 执行 G-2 门禁检查
   *
   * 检查顺序（短路求值，首个失败即返回）：
   * 1. 评审角色数 ≥ G2_MIN_REVIEW_ROLES
   * 2. 评审角色必须包含 architect
   * 3. 评审角色必须包含 test-expert
   * 4. 评审记录中不得有 reject 结论
   * 5. 用户必须显式批准
   *
   * 完整性提示（不阻断，仅 warning）：
   * - 评审角色数 < G2_FULL_REVIEW_ROLES（4 角色）时，在通过结果中提示建议补全评审
   *
   * @param context 门禁上下文（含 reviewRecords / userApproved）
   * @returns 门禁判定结果
   */
  public check(context: GateContext): GateResult {
    const records = context.reviewRecords;
    const reviewedRoles = collectReviewedRoles(records);

    // 检查 1：评审角色数 ≥ G2_MIN_REVIEW_ROLES
    if (reviewedRoles.size < G2_MIN_REVIEW_ROLES) {
      return Object.freeze({
        passed: false,
        gate: "G-2",
        reason: `评审角色数 ${reviewedRoles.size} < ${G2_MIN_REVIEW_ROLES}（至少需 ${G2_MIN_REVIEW_ROLES} 角色评审，含 architect 与 test-expert）`,
        guidance: G2_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 2：评审角色必须包含 architect（架构师）
    if (!reviewedRoles.has("architect")) {
      return Object.freeze({
        passed: false,
        gate: "G-2",
        reason: "评审角色缺少 architect（架构师必须参与方案评审，对齐 §5.12.1 G-2）",
        guidance: G2_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 3：评审角色必须包含 test-expert（测试专家）
    if (!reviewedRoles.has("test-expert")) {
      return Object.freeze({
        passed: false,
        gate: "G-2",
        reason: "评审角色缺少 test-expert（测试专家必须参与方案评审，对齐 §5.12.1 G-2）",
        guidance: G2_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 4：评审记录中不得有 reject 结论
    const rejectedRecords = collectRejectedRecords(records);
    if (rejectedRecords.length > 0) {
      const rejectedRoles = rejectedRecords.map((r) => r.role).join(", ");
      return Object.freeze({
        passed: false,
        gate: "G-2",
        reason: `评审记录中存在 ${rejectedRecords.length} 条 reject 结论（角色：${rejectedRoles}），reject 视为 BLOCKER，需修改方案后重新评审`,
        guidance: G2_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 检查 5：用户必须显式批准
    if (!context.userApproved) {
      return Object.freeze({
        passed: false,
        gate: "G-2",
        reason: "用户未显式批准方案（userApproved=false，方案必须由用户最终授权方可进入 CODING Loop）",
        guidance: G2_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 全部通过——若评审角色数 < G2_FULL_REVIEW_ROLES，附 warning 提示
    if (reviewedRoles.size < G2_FULL_REVIEW_ROLES) {
      return Object.freeze({
        passed: true,
        gate: "G-2",
        reason: `多角色评审通过（${reviewedRoles.size} 角色评审，无 reject）且用户已批准；建议补全至 ${G2_FULL_REVIEW_ROLES} 角色完整评审`,
        severity: "warning",
      }) as GateResult;
    }

    // 全部通过且角色完整
    return Object.freeze({
      passed: true,
      gate: "G-2",
      reason: `多角色评审通过（${reviewedRoles.size} 角色完整评审，无 reject）且用户已批准`,
      severity: "blocker",
    }) as GateResult;
  }
}
