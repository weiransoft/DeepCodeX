/**
 * 方案先行门禁模块入口（EAG-P2 批次 8）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.12.1 方案先行门禁（Spec-First Gate）的统一对外入口，
 * 汇总 gate 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 方案先行门禁
 * - §5.10.1 文档即门禁（文档状态机作为 Loop 流转条件）
 * - §5.12.4 A-3 任务范围锁（autonomous 强化 G-3）
 *
 * 三道门禁：
 * - G-1：无已批准 spec/plan 禁入 CODING Loop（GateG1Checker）
 * - G-2：方案必经多角色评审 + 用户批准（GateG2Checker）
 * - G-3：方案偏离检测（任务卡声明变更 vs 实际变更，≥3 符号级偏离触发 HUMAN_CHECKPOINT）
 *
 * 模块结构：
 * - gate-types.ts：门禁数据模型（GateContext/GateResult/GateOrchestrationResult 等）
 * - gate-g1-checker.ts：GateG1Checker 类（G-1 门禁）
 * - gate-g2-checker.ts：GateG2Checker 类（G-2 门禁）
 * - gate-g3-checker.ts：GateG3Checker 类（G-3 门禁）
 * - gate-orchestrator.ts：GateOrchestrator 类（按 LoopType 编排 G-1→G-2→G-3）
 *
 * 公开 API（barrel 导出）：
 * - 类型：DocumentState / TaskCard / ReviewRole / ReviewVerdict / ReviewRecord /
 *         FileChangeType / FileChange / LoopType / GateId / GateSeverity /
 *         GateContext / GateResult / GateOrchestrationResult / GateChecker
 * - 常量：REVIEW_ROLES / LOOP_TYPES / GATE_IDS /
 *         G2_MIN_REVIEW_ROLES / G2_FULL_REVIEW_ROLES / G3_DEVIATION_THRESHOLD
 * - 类：GateG1Checker / GateG2Checker / GateG3Checker / GateOrchestrator
 * - 异常：GateOrchestratorError
 *
 * @module eag/gate
 */

// ============================================================================
// 类型与常量（from gate-types.ts）
// ============================================================================

export type {
  DocumentState,
  TaskCard,
  ReviewRole,
  ReviewVerdict,
  ReviewRecord,
  FileChangeType,
  FileChange,
  LoopType,
  GateId,
  GateSeverity,
  GateContext,
  GateResult,
  GateOrchestrationResult,
  GateChecker,
} from "./gate-types";

export {
  REVIEW_ROLES,
  LOOP_TYPES,
  GATE_IDS,
  G2_MIN_REVIEW_ROLES,
  G2_FULL_REVIEW_ROLES,
  G3_DEVIATION_THRESHOLD,
} from "./gate-types";

// ============================================================================
// G-1 门禁检查器（from gate-g1-checker.ts）
// ============================================================================

export { GateG1Checker } from "./gate-g1-checker";

// ============================================================================
// G-2 门禁检查器（from gate-g2-checker.ts）
// ============================================================================

export { GateG2Checker } from "./gate-g2-checker";

// ============================================================================
// G-3 门禁检查器（from gate-g3-checker.ts）
// ============================================================================

export { GateG3Checker } from "./gate-g3-checker";

// ============================================================================
// 门禁编排器（from gate-orchestrator.ts）
// ============================================================================

export { GateOrchestrator, GateOrchestratorError } from "./gate-orchestrator";
