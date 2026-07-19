/**
 * PKC L4 交接文档层模块入口（EAG-P3 批次 11 Part B2）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.11.3 / §5.11.4 PKC L4 交接文档层的统一对外入口，
 * 汇总 L4 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.11.3 交接文档层七章结构
 * - EAG 方案 §5.11.4 三级置信度标注（documented / inferred / verified）
 * - EAG-P3 批次 11 设计 §7.2 模块结构 / §7.3 核心类型设计 / §7.4 七章结构 / §7.5 编排器
 *
 * 模块结构：
 * - types.ts：L4 数据模型（HandoverDocument / HandoverSection / ConfidenceLevel 等）
 * - handover-doc-builder.ts：HandoverDocumentBuilder 编排器
 * - section-builders/architecture-section.ts：架构概览章节构建器（第 1 章）
 * - section-builders/module-map-section.ts：模块地图章节构建器（第 2 章）
 * - section-builders/api-contract-section.ts：API 契约章节构建器（第 3 章）
 * - section-builders/data-model-section.ts：数据模型章节构建器（第 4 章）
 * - section-builders/test-strategy-section.ts：测试策略章节构建器（第 5 章）
 * - section-builders/risk-debt-section.ts：风险与技术债章节构建器（第 6 章）
 * - section-builders/runbook-section.ts：运维手册章节构建器（第 7 章）
 *
 * 公开 API（barrel 导出）：
 * - 类型：ConfidenceLevel / HandoverSection / HandoverDocument /
 *         SectionBuilder / SectionBuildContext / SectionDefinition
 * - 常量：CONFIDENCE_LEVELS / CONFIDENCE_PRIORITY / INFERRED_SECTION_NOTICE /
 *         SECTION_DEFINITIONS / SECTION_COUNT
 * - 类：HandoverDocumentBuilder / ArchitectureSectionBuilder /
 *       ModuleMapSectionBuilder / ApiContractSectionBuilder /
 *       DataModelSectionBuilder / TestStrategySectionBuilder /
 *       RiskDebtSectionBuilder / RunbookSectionBuilder
 * - 异常：HandoverDocumentBuilderError
 * - 工具函数：isValidConfidenceLevel / compareConfidence / minConfidence / createHandoverSection
 *
 * @module eag/pkc/l4
 */

// ============================================================================
// 类型与常量（from types.ts）
// ============================================================================

export type {
  ConfidenceLevel,
  HandoverSection,
  HandoverDocument,
  SectionBuilder,
  SectionBuildContext,
  SectionDefinition,
} from "./types";

export {
  CONFIDENCE_LEVELS,
  CONFIDENCE_PRIORITY,
  INFERRED_SECTION_NOTICE,
  SECTION_DEFINITIONS,
  SECTION_COUNT,
  HandoverDocumentBuilderError,
  isValidConfidenceLevel,
  compareConfidence,
  minConfidence,
  createHandoverSection,
} from "./types";

// ============================================================================
// HandoverDocumentBuilder 编排器（from handover-doc-builder.ts）
// ============================================================================

export { HandoverDocumentBuilder } from "./handover-doc-builder";

// ============================================================================
// 7 个 SectionBuilder（from section-builders/*.ts）
// ============================================================================

export { ArchitectureSectionBuilder } from "./section-builders/architecture-section";
export { ModuleMapSectionBuilder } from "./section-builders/module-map-section";
export { ApiContractSectionBuilder } from "./section-builders/api-contract-section";
export { DataModelSectionBuilder } from "./section-builders/data-model-section";
export { TestStrategySectionBuilder } from "./section-builders/test-strategy-section";
export { RiskDebtSectionBuilder } from "./section-builders/risk-debt-section";
export { RunbookSectionBuilder } from "./section-builders/runbook-section";
