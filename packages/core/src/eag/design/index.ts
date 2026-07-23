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
 * 模块结构（死代码清理后）：
 * - design-models.ts：DESIGN Loop 数据模型（输入/产出物/评估判定/配置）
 * - design-artifacts-schema.ts：文档章节结构 + 渲染器 + 校验器
 * - design-evaluator.ts：StaticDesignEvaluator 真实判定实现 + DesignEvaluatorProtocol 协议接口（迁移自 design-protocols.ts）
 *
 * 死代码清理记录：
 * - design-protocols.ts 已删除：ProductManagerProtocol / ArchitectProtocol 无生产实现（接口先行实现后置），
 *   DesignEvaluatorProtocol 已迁移至 design-evaluator.ts（其唯一实现所在文件）
 * - design-orchestrator.ts 已删除：DesignLoopOrchestrator 依赖 PM/Architect 协议，无生产实现路径
 *
 * 公开 API（barrel 导出）：
 * - 类型：DesignLoopInput / ProjectContext / UserStory / StructuredRequirement /
 *         ArchitectureDocument / DomainModelDocument / DesignArtifacts /
 *         DesignEvaluationVerdict / DesignLoopResult / DesignLoopConfig 等
 * - 常量：DEFAULT_DESIGN_LOOP_CONFIG / ARCHITECTURE_MD_SECTIONS / DOMAIN_MODEL_MD_SECTIONS
 * - 工厂函数：createDefaultDesignLoopConfig
 * - 协议接口：DesignEvaluatorProtocol（从 design-evaluator.ts 导出，原 design-protocols.ts 已删除）
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
// 死代码清理后协议接口位置变更说明：
// - DesignEvaluatorProtocol 原 from design-protocols.ts，现 from design-evaluator.ts
//   （与唯一实现 StaticDesignEvaluator 共置，避免 design-protocols.ts 中的 PM/Architect
//    无实现接口成为死代码）
// - ProductManagerProtocol / ArchitectProtocol 已删除（无生产实现）

export type { DesignEvaluatorProtocol } from "./design-evaluator";

export { StaticDesignEvaluator } from "./design-evaluator";
