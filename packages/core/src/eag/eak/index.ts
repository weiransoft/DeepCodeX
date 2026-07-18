/**
 * 企业架构知识层（EAK, Enterprise Architecture Knowledge）模块入口
 *
 * 本模块是 EAG（企业应用生成）体系 §5.1 企业架构知识层的统一对外入口，
 * 汇总 EAK 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.1 企业架构知识层
 * - §5.1.1 架构范式库（Architecture Paradigm Registry）
 * - §5.1.2 模式 Skill 包（Pattern Skill Packs）
 *
 * 模块结构：
 * - types.ts：EAK 核心类型定义（ParadigmId / ApplicabilitySignals / ArchitectureParadigm / ParadigmLockConfig 等）
 * - paradigms/：4 个范式定义（ddd-layered / clean-architecture / cqrs-es / microservice）
 * - paradigm-registry.ts：范式注册表 + paradigm_lock 范式锁定机制
 * - skill-registry.ts：6 个模式 Skill 包元数据注册表
 *
 * 公开 API（barrel 导出）：
 * - 类型：ParadigmId / ApplicabilitySignals / ArchitectureParadigm / ParadigmLockConfig 等
 * - 常量：PARADIGM_IDS / SKELETON_LANGUAGES / SKILL_TRIGGER_PHASES / 4 个范式常量 / EAG_SKILLS
 * - 注册表 API：getParadigmById / getAllParadigms / selectParadigm / validateParadigmLock 等
 * - Skill API：getAllEagSkills / getEagSkillById / getEagSkillsByPhase / getEagSkillsByParadigm
 *
 * @module eag/eak
 */

// ============================================================================
// 类型定义（from types.ts）
// ============================================================================

export type {
  ParadigmId,
  ApplicabilitySignals,
  SignalEvidence,
  SkeletonLanguage,
  SkeletonTemplate,
  DependencyRule,
  NamingElement,
  NamingConvention,
  AntiPattern,
  ArchitectureParadigm,
  ParadigmLockConfig,
} from "./types";

export { PARADIGM_IDS, SKELETON_LANGUAGES } from "./types";

// ============================================================================
// 范式定义（from paradigms/）
// ============================================================================

export { DDD_LAYERED_PARADIGM } from "./paradigms/ddd-layered";
export { CLEAN_ARCHITECTURE_PARADIGM } from "./paradigms/clean-architecture";
export { CQRS_ES_PARADIGM } from "./paradigms/cqrs-es";
export { MICROSERVICE_PARADIGM } from "./paradigms/microservice";

// ============================================================================
// 范式注册表（from paradigm-registry.ts）
// ============================================================================

export {
  getParadigmById,
  getAllParadigms,
  getParadigmCount,
  selectParadigm,
  validateParadigmLock,
  rankParadigmsBySignals,
} from "./paradigm-registry";

// ============================================================================
// Skill 元数据注册表（from skill-registry.ts）
// ============================================================================

export type { SkillTriggerPhase, EagSkillMetadata } from "./skill-registry";

export {
  SKILL_TRIGGER_PHASES,
  EAG_SKILLS,
  getAllEagSkills,
  getEagSkillById,
  getEagSkillsByPhase,
  getEagSkillsByParadigm,
  getEagSkillCount,
} from "./skill-registry";
