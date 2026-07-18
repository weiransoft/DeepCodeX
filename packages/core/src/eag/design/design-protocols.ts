/**
 * DESIGN Loop 角色协议接口（EAG-P1 批次 3）
 *
 * 本模块定义 EAG 方案 §5.2.2 DESIGN Loop 涉及的三个角色协议：
 * - 产品经理（PM）：原始需求 → 结构化需求（用户故事+验收标准+领域事件候选）
 * - 架构师：结构化需求 + 范式选择 → 架构设计文档 + 领域模型文档
 * - DESIGN Loop 评估器：设计产出 → 评估判定（范式一致性+设计完整性+反模式零命中+证据强制）
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 DESIGN Loop 角色编排：PM → 架构师 → 独立评估器
 * - EAG 方案 §5.3 多角色编排层（PM / 架构师 / 独立评估器 三角色唤起知识）
 *
 * 协议设计原则（对齐批次 1 protocols.ts 风格）：
 * - 协议为 TS interface，实现方通过结构子类型匹配，无需显式 implements
 * - 协议仅描述对外契约，不约束内部实现
 * - 支持测试时注入轻量级真实对象（StaticXxx 类，遵循项目"禁止 mock"规则）
 * - 异步接口（Promise）以适配未来真实 LLM 调用场景；本批次测试用静态实现保持同步语义
 *
 * 与 EAG-P0 IndependentEvaluator 的关系：
 * - P0 `eag/evaluator/types.ts` 的 IndependentEvaluator 用于异步重型评估（含 LLM judge）
 * - 本模块的 DesignEvaluatorProtocol 为 DESIGN Loop 专属评估契约
 * - 两者职责对齐：未来可提供适配器将 P0 IndependentEvaluator 包装为本协议实现
 *
 * @module eag/design/protocols
 */

import type { ArchitectureParadigm, ParadigmLockConfig } from "../eak/types";
import type {
  ArchitectureDocument,
  DesignArtifacts,
  DesignEvaluationVerdict,
  DomainModelDocument,
  ProjectContext,
  StructuredRequirement,
} from "./design-models";

// ============================================================================
// 产品经理协议
// ============================================================================

/**
 * 产品经理协议：原始需求 → 结构化需求
 *
 * 对应 EAG 方案 §5.3 产品经理角色：
 * - 唤起知识：用户故事模板、验收标准 Gherkin 语法
 * - 产出契约：structured-requirement.json（StructuredRequirement）
 *
 * 实现方负责：
 * 1. 解析原始自然语言需求
 * 2. 抽取用户故事（角色+动作+价值三段式）
 * 3. 编写 Gherkin 验收标准（Given/When/Then）
 * 4. 提取领域事件候选名
 * 5. 构建领域词汇表 + 非功能需求清单
 *
 * 棕地场景（projectContext 提供）时，PM 应参考既有领域模型，避免术语漂移。
 */
export interface ProductManagerProtocol {
  /**
   * 将原始自然语言需求结构化为 StructuredRequirement
   *
   * @param rawRequirement 原始业务需求（自然语言）
   * @param projectContext 项目上下文（棕地场景时提供，绿地场景省略）
   * @returns PM 结构化需求产出（用户故事+领域词汇+非功能需求）
   */
  structureRequirement(rawRequirement: string, projectContext?: ProjectContext): Promise<StructuredRequirement>;
}

// ============================================================================
// 架构师协议
// ============================================================================

/**
 * 架构师协议：结构化需求 + 范式选择 → 架构设计文档 + 领域模型文档
 *
 * 对应 EAG 方案 §5.3 架构师角色：
 * - 唤起知识：范式库 + applicabilitySignals + 反模式 + PKC 交接文档
 * - 产出契约：ARCHITECTURE.md + DOMAIN-MODEL.md（ArchitectureDocument + DomainModelDocument）
 *
 * 实现方负责：
 * 1. 根据 StructuredRequirement + 项目上下文选择范式（含 paradigm_lock 处理）
 * 2. 划分限界上下文（BoundedContext）
 * 3. 设计分层结构（LayerDefinition）+ 依赖规则（DependencyRule）
 * 4. 设计领域模型（聚合/实体/值对象/领域事件）
 * 5. 填充 signalEvidence（自主选择时强制引用需求原文）
 *
 * 范式选择逻辑：
 * - paradigmLock.locked=true → 直接采用锁定的范式（跳过信号判定）
 * - paradigmLock 未提供或 locked=false → 按 applicabilitySignals 信号匹配
 *   （由调用方通过 selectParadigm API 完成，本协议实现方负责调用）
 */
export interface ArchitectProtocol {
  /**
   * 根据结构化需求与范式选择产出架构设计文档 + 领域模型文档
   *
   * @param requirement PM 产出的结构化需求
   * @param paradigmLock 可选，paradigm_lock 配置（锁定时跳过信号判定）
   * @param projectContext 项目上下文（棕地场景时提供）
   * @returns 架构师产出：architecture（ARCHITECTURE.md 内容）+ domainModel（DOMAIN-MODEL.md 内容）
   */
  designArchitecture(
    requirement: StructuredRequirement,
    paradigmLock?: ParadigmLockConfig,
    projectContext?: ProjectContext
  ): Promise<{ architecture: ArchitectureDocument; domainModel: DomainModelDocument }>;
}

// ============================================================================
// DESIGN Loop 评估器协议
// ============================================================================

/**
 * DESIGN Loop 评估器协议：设计产出 → 评估判定
 *
 * 对应 EAG 方案 §5.2.2 评估器判定 + §5.3 独立评估器角色：
 * - 唤起知识：红线清单（E1~E8）+ 依赖规则 + 客观指标
 * - 产出契约：EvaluationVerdict（passed/reason/severity）
 *
 * 判定项（对齐 §5.2.2 评估器判定）：
 * 1. 范式一致性：架构师产出的 layering/dependencyRules 必须与所选 paradigm 的 dependencyRules 一致
 * 2. 设计完整性：每个 UserStory 必须有至少一个 Aggregate 承载
 *    （聚合名出现在 userStory 关联的 domainEventCandidates 的 publisher 中）
 * 3. 反模式零命中：架构师产出的 Aggregate/Entity 不得违反范式 antiPatterns 的静态可判规则
 * 4. signalEvidence 证据强制：自主选择范式时（非锁定）signalEvidence 必须非空且引用需求原文
 *
 * 与 Generator/Evaluator 分离原则（§5.2.1）：
 * - 架构师是 Generator 角色（产出设计文档），不得自行评估
 * - 本协议由独立评估器实现，对架构师产出做客观判定
 */
export interface DesignEvaluatorProtocol {
  /**
   * 对设计产出进行独立评估并返回判定
   *
   * @param artifacts 设计产出（PM 产出 + 架构师产出）
   * @param paradigm 选中的范式定义（评估器据此判定范式一致性）
   * @returns 评估判定结果（passed/reason/severity/findings/suggestedFix）
   */
  evaluate(artifacts: DesignArtifacts, paradigm: ArchitectureParadigm): Promise<DesignEvaluationVerdict>;
}

// ============================================================================
// 协议清单说明
// ============================================================================

/**
 * 协议清单（3 个角色协议构成 DESIGN Loop 的可注入依赖契约）
 *
 * - ProductManagerProtocol：PM 阶段（需求结构化）
 * - ArchitectProtocol：架构师阶段（范式选择 + 架构设计 + 领域模型设计）
 * - DesignEvaluatorProtocol：评估阶段（独立判定设计产出）
 *
 * 编排器（DesignLoopOrchestrator）通过组合这三个协议完成 DESIGN Loop 闭环：
 * PM.structureRequirement → Architect.designArchitecture → DesignEvaluator.evaluate
 * → 若失败重试（携带 verdict.reason）→ 若通过触发 HUMAN_CHECKPOINT
 */
