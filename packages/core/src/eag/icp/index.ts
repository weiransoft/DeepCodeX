/**
 * ICP（Industry Compliance Pack，行业合规包）模块 barrel 导出
 *
 * 本模块统一导出 ICP 行业合规包首版的全部类型、合规包、编排器与证据采集器，
 * 供外部模块（如 G-7 门禁、TESTING Loop）从 "eag/icp" 入口统一导入。
 *
 * 导出内容：
 * - 类型定义（types.ts）：CompliancePack / ComplianceRule / ComplianceEvidenceReport 等
 * - 工厂函数：createComplianceEvidence / createComplianceRuleResult / createComplianceEvidenceReport / createComplianceCheckContext
 * - 合规包常量：GMP_PACK / CFR_PART_11_PACK / ALCOA_PLUS_PACK
 * - 编排器：ComplianceEngine
 * - 证据采集器：EvidenceCollector
 *
 * 设计依据：
 * - EAG-P3 批次 11 设计 §6.2 模块结构
 * - EAG 方案 §5.9.2 ICP 行业合规包
 *
 * @module eag/icp
 */

// ============================================================================
// 1. 类型与常量导出
// ============================================================================

export * from "./types";

// ============================================================================
// 2. 合规包常量导出
// ============================================================================

export { GMP_PACK } from "./packs/gmp-pack";
export { CFR_PART_11_PACK } from "./packs/cfr-part11-pack";
export { ALCOA_PLUS_PACK } from "./packs/alcoa-plus-pack";

// ============================================================================
// 3. 编排器导出
// ============================================================================

export { ComplianceEngine, PACK_REGISTRY } from "./compliance-engine";

// ============================================================================
// 4. 证据采集器导出
// ============================================================================

export { EvidenceCollector } from "./evidence-collector";
