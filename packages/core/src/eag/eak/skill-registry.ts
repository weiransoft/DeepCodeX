/**
 * EAK 模式 Skill 包元数据注册表
 *
 * 本模块定义 EAG 方案 §5.1.2 模式 Skill 包的元数据注册表。
 * 6 个 Skill 包（bundled skill）每个对应一个 SKILL.md 文件，
 * 提供按需唤起的范式知识与判定规则（Token 经济学：不全量注入）。
 *
 * 设计依据：
 * - EAG 方案 §5.1.2 模式 Skill 包（Pattern Skill Packs）
 * - EAG 方案 §5.1.2 Skill 唤起时机表
 *
 * 6 个 Skill 唤起时机与所属范式（对齐方案 §5.1.2 表格）：
 * | Skill ID                 | triggerPhase  | applicableParadigms           |
 * |--------------------------|---------------|-------------------------------|
 * | eag-domain-modeling      | design        | all                           |
 * | eag-aggregate-design     | coding        | all                           |
 * | eag-cqrs-separation      | coding        | cqrs-es                       |
 * | eag-saga-orchestration   | coding        | ddd-layered / cqrs-es / microservice |
 * | eag-acl                  | coding        | all                           |
 * | eag-verify-enterprise    | verification  | all                           |
 *
 * 元数据作用：
 * - id：Skill 唯一 ID，与目录名一致
 * - triggerPhase：唤起时机（DESIGN/CODING/TESTING/VERIFICATION）
 * - applicableParadigms：适用的范式（"all" 表示全部 4 个范式）
 * - skillMdPath：SKILL.md 相对路径（相对 bundled/ 目录）
 * - description：Skill 描述（用于按需唤起时的语义匹配）
 *
 * 不可变保证：
 * - EAG_SKILLS 使用 ReadonlyArray + Object.freeze 冻结
 * - 注册表初始化后不可修改，对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/eak/skill-registry
 */

import type { ParadigmId } from "./types";

// ============================================================================
// Skill 元数据类型定义
// ============================================================================

/**
 * Skill 唤起阶段
 *
 * 与 Loop Engineering 的 Loop 阶段对齐：
 * - design：DESIGN Loop 设计阶段（架构设计/领域建模）
 * - coding：CODING Loop 编码阶段（战术实现）
 * - testing：TESTING Loop 测试阶段（用例设计与执行）
 * - verification：各 Loop 的 Verification 阶段（评估器辅助）
 */
export type SkillTriggerPhase = "design" | "coding" | "testing" | "verification";

/**
 * SkillTriggerPhase 全部合法值（用于运行时枚举与测试断言）
 */
export const SKILL_TRIGGER_PHASES: ReadonlyArray<SkillTriggerPhase> = Object.freeze([
  "design",
  "coding",
  "testing",
  "verification",
]);

/**
 * EAK 模式 Skill 包元数据
 *
 * 每个元数据描述一个 SKILL.md 的：
 * - 唯一 ID（与目录名一致）
 * - 名称（中文，便于审计）
 * - 唤起阶段（DESIGN/CODING/TESTING/VERIFICATION）
 * - 适用范式（4 个范式之一，或全部）
 * - SKILL.md 相对路径（相对 templates/skills/bundled/ 目录）
 * - 描述（用于按需唤起时的语义匹配）
 *
 * 字段全部 readonly——元数据一旦定义即不可变。
 */
export interface EagSkillMetadata {
  /** Skill 唯一 ID（如 "eag-domain-modeling"），与目录名一致 */
  readonly id: string;
  /** Skill 名称（中文，便于审计日志） */
  readonly name: string;
  /** 唤起阶段（DESIGN/CODING/TESTING/VERIFICATION） */
  readonly triggerPhase: SkillTriggerPhase;
  /** 适用范式列表（"all" 表示全部 4 个范式） */
  readonly applicableParadigms: ReadonlyArray<ParadigmId> | "all";
  /** SKILL.md 相对路径（相对 templates/skills/bundled/ 目录，如 "eag-domain-modeling/SKILL.md"） */
  readonly skillMdPath: string;
  /** Skill 描述（用于按需唤起时的语义匹配，与需求/任务做相似度比对） */
  readonly description: string;
}

// ============================================================================
// 6 个 Skill 元数据注册表
// ============================================================================

/**
 * EAK 模式 Skill 包元数据注册表（6 个 Skill）
 *
 * 使用 Object.freeze 冻结，初始化后不可修改。
 * 顺序与方案 §5.1.2 表格一致：domain-modeling → aggregate-design → cqrs-separation
 * → saga-orchestration → acl → verify-enterprise
 */
export const EAG_SKILLS: ReadonlyArray<EagSkillMetadata> = Object.freeze([
  {
    id: "eag-domain-modeling",
    name: "领域建模",
    triggerPhase: "design",
    applicableParadigms: "all",
    skillMdPath: "eag-domain-modeling/SKILL.md",
    description:
      "领域建模 Skill 包：聚合边界划分五问、实体/值对象判别树、领域事件提取法。" +
      "在 DESIGN Loop 领域建模阶段唤起，辅助架构师从原始需求中识别聚合、实体、值对象、领域事件，" +
      "适用于全部 4 个范式。",
  },
  {
    id: "eag-aggregate-design",
    name: "聚合设计",
    triggerPhase: "coding",
    applicableParadigms: "all",
    skillMdPath: "eag-aggregate-design/SKILL.md",
    description:
      "聚合设计 Skill 包：聚合内一致性规则、工厂方法、仓储接口归属。" +
      "在 CODING Loop 战术实现阶段唤起，辅助独立开发者实现聚合根的内部不变式、工厂构造、" +
      "仓储接口定义，适用于全部 4 个范式。",
  },
  {
    id: "eag-cqrs-separation",
    name: "CQRS 读写分离",
    triggerPhase: "coding",
    applicableParadigms: ["cqrs-es"],
    skillMdPath: "eag-cqrs-separation/SKILL.md",
    description:
      "CQRS 读写分离 Skill 包：命令/查询模型分离、事件处理器、投影器模式。" +
      "在 cqrs-es 范式的 CODING Loop 阶段唤起，辅助独立开发者实现命令侧与查询侧的分离、" +
      "事件订阅器、投影器与读模型。仅适用于 cqrs-es 范式。",
  },
  {
    id: "eag-saga-orchestration",
    name: "Saga 编排",
    triggerPhase: "coding",
    applicableParadigms: ["ddd-layered", "cqrs-es", "microservice"],
    skillMdPath: "eag-saga-orchestration/SKILL.md",
    description:
      "Saga 编排 Skill 包：编排式 Saga、补偿动作、幂等消费。" +
      "在跨聚合/跨服务事务场景下唤起，辅助独立开发者实现编排式 Saga 模式，" +
      "包括正向步骤、补偿动作、幂等键控制。适用于 ddd-layered、cqrs-es、microservice 范式。",
  },
  {
    id: "eag-acl",
    name: "防腐层",
    triggerPhase: "coding",
    applicableParadigms: "all",
    skillMdPath: "eag-acl/SKILL.md",
    description:
      "防腐层（Anti-Corruption Layer）Skill 包：防腐层模式、外部模型翻译、隔离腐化。" +
      "在外部系统集成场景下唤起，辅助独立开发者实现 ACL 模式，隔离外部系统模型对内部领域模型的腐化，" +
      "适用于全部 4 个范式。",
  },
  {
    id: "eag-verify-enterprise",
    name: "企业红线自检",
    triggerPhase: "verification",
    applicableParadigms: "all",
    skillMdPath: "eag-verify-enterprise/SKILL.md",
    description:
      "企业红线自检 Skill 包：企业红线自检清单（评估器辅助材料）。" +
      "在各 Loop 的 Verification 阶段唤起，作为评估器的辅助材料提供红线判定指引，" +
      "适用于全部 4 个范式。",
  },
]);

// ============================================================================
// 查询 API
// ============================================================================

/**
 * 获取全部 Skill 元数据
 *
 * @returns 6 个 Skill 元数据数组（按注册顺序）
 */
export function getAllEagSkills(): ReadonlyArray<EagSkillMetadata> {
  return EAG_SKILLS;
}

/**
 * 按 ID 查询 Skill 元数据
 *
 * @param id Skill ID（如 "eag-domain-modeling"）
 * @returns Skill 元数据；未找到返回 null
 */
export function getEagSkillById(id: string): EagSkillMetadata | null {
  return EAG_SKILLS.find((s) => s.id === id) ?? null;
}

/**
 * 按阶段查询 Skill 元数据
 *
 * @param phase 阶段（design/coding/testing/verification）
 * @returns 该阶段的所有 Skill 元数据
 */
export function getEagSkillsByPhase(phase: SkillTriggerPhase): ReadonlyArray<EagSkillMetadata> {
  return EAG_SKILLS.filter((s) => s.triggerPhase === phase);
}

/**
 * 查询适用于指定范式的 Skill 元数据
 *
 * applicableParadigms === "all" 的 Skill 视为适用全部 4 个范式。
 *
 * @param paradigmId 范式 ID
 * @returns 适用于该范式的 Skill 元数据列表
 */
export function getEagSkillsByParadigm(paradigmId: ParadigmId): ReadonlyArray<EagSkillMetadata> {
  return EAG_SKILLS.filter((s) => {
    if (s.applicableParadigms === "all") return true;
    return s.applicableParadigms.includes(paradigmId);
  });
}

/**
 * 获取 Skill 总数
 *
 * @returns Skill 数量（当前为 6）
 */
export function getEagSkillCount(): number {
  return EAG_SKILLS.length;
}
