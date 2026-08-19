/**
 * DESIGN Loop 模块入口（EAG-P1 批次 3）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.2.2 DESIGN Loop 的统一对外入口，
 * 汇总 DESIGN Loop 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 DESIGN Loop（输入/角色编排/产出物/评估器判定/人工检查点）
 * - EAG 方案 §5.3 多角色编排层（PM / 架构师 / 独立评估器 三角色唤起知识）
 *
 * 模块结构（2026-08-19 如实修正）：
 * - design-models.ts：DESIGN Loop 数据模型（输入/产出物/评估判定/配置）
 * - design-artifacts-schema.ts：文档章节结构 + 渲染器 + 校验器
 * - design-evaluator.ts：StaticDesignEvaluator 真实判定实现 + DesignEvaluatorProtocol 协议接口
 * - design-protocols.ts：PM/Architect/评估器三角色协议接口（文件实际存在，
 *   早前注释声称"已删除"与事实不符）
 * - design-orchestrator.ts：DesignLoopOrchestrator 三角色编排器（文件实际存在）
 *
 * 接线状态说明（2026-08-19 S3.2 接线完成后更新）：
 * - design-protocols.ts 与 design-orchestrator.ts 仍存在于本目录：
 *   * session.ts 以 type-only 方式导入 DesignLoopOrchestrator（装配选项注入点）
 *   * PM/Architect 协议已有 LLM 驱动生产实现（design-roles-llm.ts）：
 *     - LlmProductManager / LlmArchitect / FeedbackAwareArchitect / FeedbackCapturingEvaluator
 *   * CLI 侧经 eag-orchestrator-assembly.ts buildDesignOrchestrator() 装配注入
 * - 本 barrel 导出 DesignLoopOrchestrator / ProductManagerProtocol / ArchitectProtocol
 *   及 LLM 角色生产实现（根 barrel 经 eag/index.ts 可达，供 CLI assembly 消费）
 * - DesignEvaluatorProtocol 已迁移至 design-evaluator.ts（与唯一生产实现
 *   StaticDesignEvaluator 共置），从本 barrel 正常导出
 *
 * 公开 API（barrel 导出）：
 * - 类型：DesignLoopInput / ProjectContext / UserStory / StructuredRequirement /
 *         ArchitectureDocument / DomainModelDocument / DesignArtifacts /
 *         DesignEvaluationVerdict / DesignLoopResult / DesignLoopConfig 等
 * - 常量：DEFAULT_DESIGN_LOOP_CONFIG / ARCHITECTURE_MD_SECTIONS / DOMAIN_MODEL_MD_SECTIONS
 * - 工厂函数：createDefaultDesignLoopConfig
 * - 协议接口：DesignEvaluatorProtocol（从 design-evaluator.ts 导出）
 * - 渲染器：renderArchitectureMd / renderDomainModelMd
 * - 校验器：validateArchitectureMd / validateDomainModelMd
 * - 评估器实现：StaticDesignEvaluator
 *
 * @module eag/design
 */

// ============================================================================
// 类型与常量（from design-models.ts）
// ============================================================================

export type {
  DesignLoopInput,
  ProjectContext,
  UserStory,
  AcceptanceCriterion,
  DomainTerm,
  NonFunctionalCategory,
  NonFunctionalRequirement,
  StructuredRequirement,
  BoundedContext,
  LayerDefinition,
  ArchitectureDocument,
  AttributeDefinition,
  BehaviorDefinition,
  AggregateDefinition,
  EntityDefinition,
  ValueObjectDefinition,
  DomainEventDefinition,
  DomainModelDocument,
  DesignArtifacts,
  DesignVerdictSeverity,
  DesignEvaluationVerdict,
  DesignLoopResult,
  DesignEvaluationMode,
  DesignLoopConfig,
} from "./design-models";

export { DEFAULT_DESIGN_LOOP_CONFIG, DesignLoopConfigError, createDefaultDesignLoopConfig } from "./design-models";

// ============================================================================
// 文档 schema 与渲染器（from design-artifacts-schema.ts）
// ============================================================================

export {
  ARCHITECTURE_MD_SECTIONS,
  DOMAIN_MODEL_MD_SECTIONS,
  renderArchitectureMd,
  renderDomainModelMd,
  validateArchitectureMd,
  validateDomainModelMd,
} from "./design-artifacts-schema";

// ============================================================================
// 评估器协议接口 + 评估器实现（from design-evaluator.ts）
// ============================================================================
//
// 协议接口位置说明（2026-08-19 S3.2 接线完成后更新）：
// - DesignEvaluatorProtocol 原 from design-protocols.ts，现 from design-evaluator.ts
//   （与唯一生产实现 StaticDesignEvaluator 共置）
// - design-protocols.ts 仍定义 PM/Architect 协议（下方 S3.2 补导出段消费）

export type { DesignEvaluatorProtocol } from "./design-evaluator";

export { StaticDesignEvaluator } from "./design-evaluator";

// ============================================================================
// PM/Architect 协议接口 + 编排器 + LLM 驱动生产实现
// （S3.2 接线批次：此前 PM/Architect 协议无生产实现且编排器未导出，
//  现补全导出供 CLI 装配 eag-orchestrator-assembly.ts 消费）
// ============================================================================

export type { ProductManagerProtocol, ArchitectProtocol } from "./design-protocols";

export { DesignLoopOrchestrator } from "./design-orchestrator";

export {
  DesignRoleError,
  LlmProductManager,
  LlmArchitect,
  FeedbackAwareArchitect,
  FeedbackCapturingEvaluator,
} from "./design-roles-llm";

export type { LlmDesignRoleOptions } from "./design-roles-llm";
