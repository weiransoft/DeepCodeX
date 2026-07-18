/**
 * 变更分类器（Change Classifier）—— EAG 方案 §6.2
 *
 * 本模块实现 EAG 方案 §6.2 增量设计阶段的「变更分类」逻辑。
 * 将新需求中提及的变更项与既有模型对比，判定为 add / modify / unchanged 三类。
 *
 * 分类规则（§6.2）：
 * - 既有且新需求中提及 → modify（修改既有项）
 * - 新需求中提及但既有中无 → add（新增项）
 * - 既有但新需求中未提及 → unchanged（不动项，保留以维护完整性）
 *
 * 设计依据：
 * - EAG 方案 §6.2 增量设计的三类变更标注
 *
 * @module eag/discovery/change-classifier
 */

import type { ChangeType, ExistingModelSnapshot } from "./types.js";

// ============================================================================
// ChangeClassifier 类
// ============================================================================

/**
 * 变更分类器
 *
 * 将新需求中提及的变更项与既有模型对比，判定为 add / modify / unchanged。
 *
 * 用法：
 * ```typescript
 * const classifier = new ChangeClassifier();
 *
 * // 单项分类：既有 "OrderAggregate" 在新需求中提及 → modify
 * const type1 = classifier.classify("OrderAggregate", ["OrderAggregate", "RefundAggregate"]);
 * // → "modify"
 *
 * // 单项分类：新需求提及 "RefundAggregate" 但既有无 → add
 * const type2 = classifier.classify("RefundAggregate", ["OrderAggregate"]);
 * // → "add"
 *
 * // 批量分类
 * const result = classifier.classifyAll(snapshot, ["OrderAggregate", "RefundAggregate"]);
 * // → [{ name: "OrderAggregate", changeType: "modify" }, { name: "RefundAggregate", changeType: "add" }]
 * ```
 */
export class ChangeClassifier {
  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 判定单个变更项的分类
   *
   * 分类规则：
   * - existingName 在 newNames 中 → modify（既有且新需求中提及）
   * - existingName 不在 newNames 中 → unchanged（既有但新需求中未提及）
   * - 当 existingName 为空但 newNames 中有项时 → 由 classifyAll 处理（add）
   *
   * 注：本方法主要用于判定「既有项」在新需求中的分类（modify/unchanged）。
   * 判定「新增项」（add）需要对比 existingNames 与 newNames，使用 classifyAll 方法。
   *
   * @param existingName 既有变更项名称
   * @param newNames 新需求中提及的全部变更项名称
   * @returns 变更类型（modify/unchanged）
   */
  classify(existingName: string, newNames: ReadonlyArray<string>): ChangeType {
    // 既有且新需求中提及 → modify
    if (newNames.includes(existingName)) {
      return "modify";
    }
    // 既有但新需求中未提及 → unchanged
    return "unchanged";
  }

  /**
   * 批量分类
   *
   * 将新需求中提及的全部变更项与既有模型对比，分类为 add/modify/unchanged。
   *
   * 分类规则：
   * - 既有且新需求中提及 → modify
   * - 新需求中提及但既有中无 → add
   * - 既有但新需求中未提及 → unchanged
   *
   * @param snapshot 既有模型快照（含全部既有项清单）
   * @param newRequirementNames 新需求中提及的全部变更项名称
   * @returns 分类结果（按 add → modify → unchanged 顺序排列）
   */
  classifyAll(
    snapshot: ExistingModelSnapshot,
    newRequirementNames: ReadonlyArray<string>
  ): ReadonlyArray<{
    readonly name: string;
    readonly changeType: ChangeType;
  }> {
    // 收集既有模型中的全部项名（聚合 + 实体 + 值对象 + 领域事件 + 限界上下文）
    const existingNames = this.collectAllExistingNames(snapshot);
    const existingSet = new Set(existingNames);
    const newSet = new Set(newRequirementNames);

    const result: Array<{ name: string; changeType: ChangeType }> = [];

    // 阶段 1：新需求中提及但既有中无 → add
    for (const newName of newRequirementNames) {
      if (!existingSet.has(newName)) {
        result.push({ name: newName, changeType: "add" });
      }
    }

    // 阶段 2：既有且新需求中提及 → modify
    for (const existingName of existingNames) {
      if (newSet.has(existingName)) {
        result.push({ name: existingName, changeType: "modify" });
      }
    }

    // 阶段 3：既有但新需求中未提及 → unchanged
    for (const existingName of existingNames) {
      if (!newSet.has(existingName)) {
        result.push({ name: existingName, changeType: "unchanged" });
      }
    }

    return Object.freeze(result);
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 收集既有模型中的全部项名
   *
   * 合并聚合、实体、值对象、领域事件、限界上下文的全部名称。
   * 用于 classifyAll 的对比基线。
   *
   * @param snapshot 既有模型快照
   * @returns 全部既有项名列表
   */
  private collectAllExistingNames(snapshot: ExistingModelSnapshot): string[] {
    return [
      ...snapshot.aggregates,
      ...snapshot.entities,
      ...snapshot.valueObjects,
      ...snapshot.domainEvents,
      ...snapshot.boundedContexts,
    ];
  }
}
