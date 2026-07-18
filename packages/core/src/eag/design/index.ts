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
 * 模块结构：
 * - design-models.ts：DESIGN Loop 数据模型（输入/产出物/评估判定/配置）
 * - design-protocols.ts：三个角色协议（PM / Architect / DesignEvaluator）
 * - design-artifacts-schema.ts：文档章节结构 + 渲染器 + 校验器
 * - design-evaluator.ts：StaticDesignEvaluator 真实判定实现
 * - design-orchestrator.ts：DesignLoopOrchestrator 编排器
 *
 * 公开 API（barrel 导出）：
 * - 类型：DesignLoopInput / ProjectContext / UserStory / StructuredRequirement /
 *         ArchitectureDocument / DomainModelDocument / DesignArtifacts /
 *         DesignEvaluationVerdict / DesignLoopResult / DesignLoopConfig 等
 * - 常量：DEFAULT_DESIGN_LOOP_CONFIG / ARCHITECTURE_MD_SECTIONS / DOMAIN_MODEL_MD_SECTIONS
 * - 工厂函数：createDefaultDesignLoopConfig
 * - 协议接口：ProductManagerProtocol / ArchitectProtocol / DesignEvaluatorProtocol
 * - 渲染器：renderArchitectureMd / renderDomainModelMd
 * - 校验器：validateArchitectureMd / validateDomainModelMd
 * - 评估器实现：StaticDesignEvaluator
 * - 编排器：DesignLoopOrchestrator
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
// 角色协议（from design-protocols.ts）
// ============================================================================

export type { ProductManagerProtocol, ArchitectProtocol, DesignEvaluatorProtocol } from "./design-protocols";

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
// 评估器实现（from design-evaluator.ts）
// ============================================================================

export { StaticDesignEvaluator } from "./design-evaluator";

// ============================================================================
// 编排器（from design-orchestrator.ts）
// ============================================================================

export { DesignLoopOrchestrator } from "./design-orchestrator";
