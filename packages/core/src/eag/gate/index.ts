/**
 * 方案先行门禁模块入口（EAG-P2 批次 8 + 批次 9 S3 + EAG-P3 批次 10 + EAG-P4 批次 13）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.12.1 方案先行门禁（Spec-First Gate）的统一对外入口，
 * 汇总 gate 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 方案先行门禁
 * - §5.10.1 文档即门禁（文档状态机作为 Loop 流转条件）
 * - §5.12.4 A-3 任务范围锁（autonomous 强化 G-3）
 * - EAG-P2 批次 9 §4.8 G-4/G-5 CODING Loop 进入与退出门禁
 * - EAG-P3 批次 10 §4.8 G-6/G-7 TESTING Loop 进入与退出门禁
 * - EAG-P4 批次 13 §3.6 G-8 DEPLOY Loop 退出门禁（部署就绪校验）
 *
 * 八道门禁：
 * - G-1：无已批准 spec/plan 禁入 CODING Loop（GateG1Checker，批次 8）
 * - G-2：方案必经多角色评审 + 用户批准（GateG2Checker，批次 8）
 * - G-3：方案偏离检测（任务卡声明变更 vs 实际变更，≥3 符号级偏离触发 HUMAN_CHECKPOINT）（GateG3Checker，批次 8）
 * - G-4：CODING Loop 进入门禁（任务卡完整性 + 模板可用性 + 技术栈锁定 + 输出目录可写）（GateG4Checker，批次 9）
 * - G-5：CODING Loop 退出门禁（任务卡全 completed + STRICT 通过 + git clean + gitleaks）（GateG5Checker，批次 9）
 * - G-6：TESTING Loop 进入门禁（G-5 通过 + 单测全过 + spec.md approved + implementationRoot 非空）（GateG6Checker，批次 10）
 * - G-7：TESTING Loop 退出门禁（覆盖率达标 + 契约/E2E 测试全过 + 合规证据完整 + PR 描述就绪）（GateG7Checker，批次 10）
 * - G-8：DEPLOY Loop 退出门禁（IaC 完整 + 健康就绪 + 烟雾通过 + 监控就位 + 回滚预案存在）（GateG8CheckerImpl，批次 13）
 *
 * G-8 编排差异（重要）：
 * - G-1~G-7 由 GateOrchestrator.run() 编排（静态文档门禁）
 * - G-8 不通过 GateOrchestrator.run() 编排（运行期数据门禁）
 *   原因：G-8 需要 IaC 模板 + 部署结果 + 健康检查 + 烟雾测试等运行期数据，
 *         与 G-1~G-7 的静态文档门禁模型不同
 * - G-8 由 DevOpsOrchestrator 在部署完成后独立调用（批次 13 §3.4 + §3.6）
 *
 * 模块结构：
 * - gate-types.ts：门禁数据模型（GateContext/GateResult/GateG4Context/GateG5Context/GateG6Context/GateG7Context/TestExecutionResult 等）
 * - gate-g1-checker.ts：GateG1Checker 类（G-1 门禁，批次 8）
 * - gate-g2-checker.ts：GateG2Checker 类（G-2 门禁，批次 8）
 * - gate-g3-checker.ts：GateG3Checker 类（G-3 门禁，批次 8）
 * - gate-g4-checker.ts：GateG4Checker 类（G-4 门禁，批次 9 S3）
 * - gate-g5-checker.ts：GateG5Checker 类（G-5 门禁，批次 9 S3）
 * - gate-g6-checker.ts：GateG6Checker 类（G-6 门禁，批次 10）
 * - gate-g7-checker.ts：GateG7Checker 类（G-7 门禁，批次 10）
 * - gate-g8-checker.ts：GateG8CheckerImpl 类（G-8 门禁，批次 13，实现 devops/types.ts 的 GateG8Checker 接口）
 * - gate-orchestrator.ts：GateOrchestrator 类（按 LoopType 编排 G-1~G-7，G-8 由 DevOpsOrchestrator 独立调用）
 *
 * 公开 API（barrel 导出）：
 * - 类型：DocumentState / TaskCard / ReviewRole / ReviewVerdict / ReviewRecord /
 *         FileChangeType / FileChange / LoopType / GateId / GateSeverity /
 *         GateContext / GateResult / GateOrchestrationResult / GateChecker /
 *         GateG4Context / GateG5Context / GateG6Context / GateG7Context /
 *         TestExecutionResult / CoverageReport / GeneratedTestFile
 * - 常量：REVIEW_ROLES / LOOP_TYPES / GATE_IDS /
 *         G2_MIN_REVIEW_ROLES / G2_FULL_REVIEW_ROLES / G3_DEVIATION_THRESHOLD
 * - 类：GateG1Checker / GateG2Checker / GateG3Checker /
 *       GateG4Checker / GateG5Checker / GateG6Checker / GateG7Checker /
 *       GateG8CheckerImpl /  ← 批次 13 新增
 *       GateOrchestrator
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
  GateG4Context,
  GateG5Context,
  GateG6Context,
  GateG7Context,
  TestExecutionResult,
  // 复用 testing/types.ts 的类型，便于消费者从 gate 模块统一导入
  CoverageReport,
  GeneratedTestFile,
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
// G-4 进入门禁检查器（from gate-g4-checker.ts，批次 9 S3）
// ============================================================================

export { GateG4Checker } from "./gate-g4-checker";

// ============================================================================
// G-5 退出门禁检查器（from gate-g5-checker.ts，批次 9 S3）
// ============================================================================

export { GateG5Checker } from "./gate-g5-checker";

// ============================================================================
// G-6 TESTING Loop 进入门禁检查器（from gate-g6-checker.ts，批次 10）
// ============================================================================

export { GateG6Checker } from "./gate-g6-checker";

// ============================================================================
// G-7 TESTING Loop 退出门禁检查器（from gate-g7-checker.ts，批次 10）
// ============================================================================

export { GateG7Checker } from "./gate-g7-checker";

// ============================================================================
// G-8 DEPLOY Loop 退出门禁检查器（from gate-g8-checker.ts，批次 13）
// ============================================================================
//
// 注意：G-8 不通过 GateOrchestrator.run() 编排（运行期数据门禁），
//       由 DevOpsOrchestrator 在部署完成后独立调用。
// 接口定义在 devops/types.ts（GateG8Checker 接口），本文件仅实现类。
// 架构师审查 P2-1 修复 v1.4：实现类命名为 GateG8CheckerImpl 以避免与接口声明合并。

export { GateG8CheckerImpl } from "./gate-g8-checker";

// ============================================================================
// 门禁编排器（from gate-orchestrator.ts）
// ============================================================================

export { GateOrchestrator, GateOrchestratorError } from "./gate-orchestrator";
