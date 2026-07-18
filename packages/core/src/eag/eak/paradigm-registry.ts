/**
 * 范式注册表（Paradigm Registry）+ paradigm_lock 范式锁定机制
 *
 * 本模块是 EAG 方案 §5.1.1 架构范式库的运行期访问入口：
 * - 维护 4 个范式（ddd-layered / clean-architecture / cqrs-es / microservice）的注册表
 * - 提供按 ID 查询、全量查询、信号匹配的范式选择 API
 * - 实现 paradigm_lock 范式锁定机制：组织配置后跳过信号判定直接采用锁定范式
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 架构范式库 + 范式选择防误判机制
 * - EAG 方案 §5.1.1 范式选择防误判机制三要素：
 *   1. 组织范式锁定（.deepcode/eag.yml paradigm_lock 配置，跳过信号判定）
 *   2. 命令级覆盖（/eag-design --paradigm cqrs-es 单次显式指定，优先级高于配置文件）
 *   3. 证据强制（自主选择时 signalEvidence 必须引用需求原文，证据缺失即打回）
 *
 * 信号匹配算法：
 * - 每个范式定义 applicabilitySignals 4 维度
 * - 输入 signals 与每个范式的 applicabilitySignals 逐字段比对
 * - 字段相等得 1 分，最高 4 分
 * - 最高分范式胜出；平分时按优先级 ddd-layered > clean-architecture > cqrs-es > microservice
 *   （优先级顺序由 PARADIGM_IDS 数组顺序决定，对齐 §5.1.1 防误判机制）
 *
 * 不可变保证：
 * - PARADIGM_REGISTRY 使用 ReadonlyMap + Object.freeze 冻结
 * - 注册表初始化后不可修改，对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/eak/paradigm-registry
 */

import type { ApplicabilitySignals, ArchitectureParadigm, ParadigmId, ParadigmLockConfig } from "./types";
import { PARADIGM_IDS } from "./types";
import { DDD_LAYERED_PARADIGM } from "./paradigms/ddd-layered";
import { CLEAN_ARCHITECTURE_PARADIGM } from "./paradigms/clean-architecture";
import { CQRS_ES_PARADIGM } from "./paradigms/cqrs-es";
import { MICROSERVICE_PARADIGM } from "./paradigms/microservice";

// ============================================================================
// 范式注册表
// ============================================================================

/**
 * 范式注册表：ParadigmId → ArchitectureParadigm 的不可变映射
 *
 * 4 个范式在模块加载时注册，使用 ReadonlyMap + Object.freeze 双重冻结：
 * - ReadonlyMap 保证编译期不可写
 * - Object.freeze 保证运行期不可扩展/不可改属性
 *
 * 注册顺序对应 PARADIGM_IDS 数组顺序，影响 selectParadigm 平分时的优先级判定。
 */
const PARADIGM_REGISTRY: ReadonlyMap<ParadigmId, ArchitectureParadigm> = Object.freeze(
  new Map<ParadigmId, ArchitectureParadigm>([
    [DDD_LAYERED_PARADIGM.id, DDD_LAYERED_PARADIGM],
    [CLEAN_ARCHITECTURE_PARADIGM.id, CLEAN_ARCHITECTURE_PARADIGM],
    [CQRS_ES_PARADIGM.id, CQRS_ES_PARADIGM],
    [MICROSERVICE_PARADIGM.id, MICROSERVICE_PARADIGM],
  ])
);

// ============================================================================
// 查询 API
// ============================================================================

/**
 * 按 ID 查询范式
 *
 * @param id 范式 ID（4 个之一）
 * @returns 范式定义；未找到返回 null
 */
export function getParadigmById(id: ParadigmId): ArchitectureParadigm | null {
  return PARADIGM_REGISTRY.get(id) ?? null;
}

/**
 * 获取全部范式列表
 *
 * @returns 4 个范式定义数组（按 PARADIGM_IDS 顺序，对齐优先级）
 */
export function getAllParadigms(): ReadonlyArray<ArchitectureParadigm> {
  // 按 PARADIGM_IDS 顺序映射，保证返回顺序与优先级一致
  return PARADIGM_IDS.map((id) => PARADIGM_REGISTRY.get(id)!).filter(
    (p): p is ArchitectureParadigm => p !== null && p !== undefined
  );
}

/**
 * 获取范式总数
 *
 * @returns 范式数量（当前为 4）
 */
export function getParadigmCount(): number {
  return PARADIGM_REGISTRY.size;
}

// ============================================================================
// 信号匹配算法（selectParadigm 内部使用）
// ============================================================================

/**
 * 计算单个范式的信号匹配得分
 *
 * 算法：逐字段比对 signals 与 paradigm.applicabilitySignals，
 * 字段相等得 1 分，最高 4 分（domainComplexity / consistencyRequirement /
 * readWritePattern / integrationComplexity 4 个维度）。
 *
 * @param paradigm 待评估的范式
 * @param signals 输入信号
 * @returns 匹配得分（0~4）
 */
function computeParadigmScore(paradigm: ArchitectureParadigm, signals: ApplicabilitySignals): number {
  const expected = paradigm.applicabilitySignals;
  let score = 0;
  // 4 个维度逐字段比对
  if (signals.domainComplexity === expected.domainComplexity) score += 1;
  if (signals.consistencyRequirement === expected.consistencyRequirement) score += 1;
  if (signals.readWritePattern === expected.readWritePattern) score += 1;
  if (signals.integrationComplexity === expected.integrationComplexity) score += 1;
  return score;
}

// ============================================================================
// paradigm_lock 范式锁定机制
// ============================================================================

/**
 * 校验 paradigm_lock 配置
 *
 * 校验规则（EAG 方案 §5.1.1 范式选择防误判机制）：
 * - locked=true 时 paradigmId 必须非空且为合法的 4 个范式 ID 之一
 * - locked=false 时 paradigmId 应为 null（非强制，但建议保持一致）
 * - reason 应非空（审计依据）
 *
 * @param lock 范式锁定配置
 * @returns 校验结果：valid=true 表示配置合法；valid=false 时 reason 说明原因
 */
export function validateParadigmLock(lock: ParadigmLockConfig): {
  valid: boolean;
  reason: string;
} {
  // 校验 locked=true 时 paradigmId 必填且合法
  if (lock.locked) {
    if (lock.paradigmId === null) {
      return {
        valid: false,
        reason: "locked=true 时 paradigmId 不得为 null，必须指定锁定的范式 ID",
      };
    }
    if (!PARADIGM_IDS.includes(lock.paradigmId)) {
      return {
        valid: false,
        reason: `paradigmId "${lock.paradigmId}" 非法，必须为 4 个范式之一：${PARADIGM_IDS.join(" / ")}`,
      };
    }
  }

  // 校验 reason 非空（审计依据，对齐 §5.12.4 配置冻结原则）
  if (!lock.reason || lock.reason.trim().length === 0) {
    return {
      valid: false,
      reason: "reason 不得为空，必须填写锁定原因（如'组织规范要求'）作为审计依据",
    };
  }

  // 校验通过
  return { valid: true, reason: "配置合法" };
}

// ============================================================================
// 范式选择 API（selectParadigm）
// ============================================================================

/**
 * 范式选择（含 paradigm_lock 判定）
 *
 * 选择逻辑（EAG 方案 §5.1.1 范式选择防误判机制）：
 * 1. 若 lock.locked=true 且 lock.paradigmId 合法：直接返回锁定的范式（跳过信号判定）
 *    ——组织有既定架构规范时防止模型"自主另选"引发事故
 * 2. 否则：按信号匹配
 *    - 计算每个范式的信号匹配得分（0~4）
 *    - 最高分范式胜出
 *    - 平分时按优先级 ddd-layered > clean-architecture > cqrs-es > microservice
 *      （优先级由 PARADIGM_IDS 数组顺序决定）
 *
 * @param signals 输入信号（4 维度：domainComplexity/consistencyRequirement/readWritePattern/integrationComplexity）
 * @param lock 可选，paradigm_lock 配置。若未提供或 locked=false，走信号匹配路径
 * @returns 选中的范式定义
 *
 * @throws 当 lock.locked=true 但 paradigmId 非法时抛出 Error
 *         （调用方应先调用 validateParadigmLock 校验配置）
 */
export function selectParadigm(signals: ApplicabilitySignals, lock?: ParadigmLockConfig): ArchitectureParadigm {
  // 步骤 1：paradigm_lock 判定——锁定时直接返回锁定的范式
  if (lock && lock.locked) {
    // 锁定配置必须校验，paradigmId 非法时抛错（调用方应先 validateParadigmLock）
    if (lock.paradigmId === null) {
      throw new Error("paradigm_lock.locked=true 但 paradigmId 为 null，调用方应先调用 validateParadigmLock 校验");
    }
    const lockedParadigm = getParadigmById(lock.paradigmId);
    if (lockedParadigm === null) {
      throw new Error(`paradigm_lock.paradigmId "${lock.paradigmId}" 未在注册表中找到，可能是非法的范式 ID`);
    }
    // 锁定模式：跳过信号判定，直接返回锁定的范式
    return lockedParadigm;
  }

  // 步骤 2：信号匹配——遍历所有范式，按得分选出最高分范式
  let bestParadigm: ArchitectureParadigm | null = null;
  let bestScore = -1;

  // 按 PARADIGM_IDS 顺序遍历，保证平分时优先选择靠前的范式
  for (const paradigmId of PARADIGM_IDS) {
    const paradigm = PARADIGM_REGISTRY.get(paradigmId);
    if (!paradigm) continue;
    const score = computeParadigmScore(paradigm, signals);
    // 严格大于才更新，保证平分时保留先遍历到的范式（优先级更高）
    if (score > bestScore) {
      bestScore = score;
      bestParadigm = paradigm;
    }
  }

  // 步骤 3：返回最高分范式（bestParadigm 必非空——PARADIGM_IDS 非空且每个 ID 都有注册）
  if (bestParadigm === null) {
    // 理论不可达：PARADIGM_REGISTRY 初始化时已注册全部 4 个范式
    throw new Error("范式选择失败：PARADIGM_REGISTRY 为空，请检查范式注册表初始化");
  }
  return bestParadigm;
}

// ============================================================================
// 信号匹配辅助 API（供测试与架构师角色调用）
// ============================================================================

/**
 * 获取所有范式的信号匹配得分（按得分降序排列）
 *
 * 用于架构师在 DESIGN Loop 中向评估器展示打分依据，
 * 评估器据此对"信号→范式"映射做合理性抽检（EAG 方案 §5.1.1 证据强制要求）。
 *
 * @param signals 输入信号
 * @returns 范式与得分的数组，按得分降序、得分相同按优先级升序排列
 */
export function rankParadigmsBySignals(
  signals: ApplicabilitySignals
): ReadonlyArray<{ paradigm: ArchitectureParadigm; score: number }> {
  const ranked = PARADIGM_IDS.map((id) => {
    const paradigm = PARADIGM_REGISTRY.get(id)!;
    return { paradigm, score: computeParadigmScore(paradigm, signals) };
  });
  // 按 score 降序；score 相同时保留 PARADIGM_IDS 顺序（即优先级顺序）
  // 由于 Array.prototype.sort 不稳定，需用稳定排序：score 相同时按原索引（即优先级）保留
  // 这里通过先按 PARADIGM_IDS 顺序构建数组，再用稳定比较器保证平分时优先级正确
  return ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // score 相同时，按 PARADIGM_IDS 顺序保留（a 在前则返回 -1）
    const aIndex = PARADIGM_IDS.indexOf(a.paradigm.id);
    const bIndex = PARADIGM_IDS.indexOf(b.paradigm.id);
    return aIndex - bIndex;
  });
}
