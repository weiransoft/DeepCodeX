/**
 * 棕地 Discovery 模块 —— Barrel 导出（EAG 方案 §6.2）
 *
 * 本模块聚合 Discovery 子模块的公共 API，提供统一入口。
 *
 * 子模块：
 * - types：数据模型（ChangeType / ExistingModelSnapshot / IncrementalChange 等）
 * - brownfield-discovery：棕地 Discovery 流程（BrownfieldDiscovery 类）
 * - change-classifier：变更分类器（ChangeClassifier 类）
 * - existing-contract-guard：既有契约保护判定器（ExistingContractGuard 类）
 *
 * @module eag/discovery
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  ChangeType,
  ExistingModelSnapshot,
  IncrementalChange,
  IncrementalDesignResult,
  ContractViolation,
  ContractViolationType,
  TechDebtReport,
} from "./types.js";

// ============================================================================
// 常量导出
// ============================================================================

export { CHANGE_TYPES, CONTRACT_VIOLATION_TYPES } from "./types.js";

// ============================================================================
// BrownfieldDiscovery 类导出
// ============================================================================

export { BrownfieldDiscovery, REQUIREMENT_KEYWORD_MAPPING } from "./brownfield-discovery.js";

// ============================================================================
// ChangeClassifier 类导出
// ============================================================================

export { ChangeClassifier } from "./change-classifier.js";

// ============================================================================
// ExistingContractGuard 类导出
// ============================================================================

export { ExistingContractGuard } from "./existing-contract-guard.js";
export type { ParadigmName } from "./existing-contract-guard.js";
