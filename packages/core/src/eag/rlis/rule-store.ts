/**
 * RLIS 三层规则存储（Rule Store）—— EAG 方案 §5.5.2
 *
 * 本模块实现 EAG 方案 §5.5.2 三层规则存储的 `RuleStore` 类。
 * 负责三层规则的构造合并、查询、统计、反馈闭环。
 *
 * 三层规则存储（优先级高 → 低）：
 * 1. 项目层（.deepcode/rules/project-rules.json）—— 项目级约束（最高，覆盖同名规则）
 * 2. 全局用户层（~/.deepcodeX/rules/global-rules.json）—— 个人偏好
 * 3. 内置种子层（seed-rules.ts，CLI 打包发布）—— 系统默认（最低）
 *
 * 合并规则（§5.5.2）：
 * - 同 ID 规则按优先级覆盖：project > global > seed
 * - 不同 ID 规则全部生效
 * - 生效规则按 severity 排序（BLOCKER 优先 → MAJOR → WARNING）
 *
 * 反馈闭环（§5.5.4）：
 * - recordUsage(ruleId)：每次注入到 LLM system prompt 时 +1
 * - recordViolation(ruleId)：评估器按该规则打回时 +1
 * - suggestSeverityUpgrade(ruleId)：violationCount >= 5 时建议提升 severity
 * - suggestCleanup(ruleId)：usageCount >= 10 且 violationCount === 0 时建议清理
 *
 * 设计依据：
 * - EAG 方案 §5.5.1 规则模型（UserRule 字段定义）
 * - EAG 方案 §5.5.2 三层规则存储表
 * - EAG 方案 §5.5.4 规则学习的反馈闭环
 *
 * 不可变优先原则：
 * - 内部状态使用私有字段，对外暴露的查询结果均为副本或只读视图
 * - 统计字段更新通过 copy-on-write 模式（生成新对象替换原对象）
 * - 三层规则列表均使用 ReadonlyArray<UserRule>
 *
 * @module eag/rlis/rule-store
 */

import type { RuleCategory, RuleSeverity, UserRule, RuleStoreLayer, RuleStoreSnapshot } from "./types.js";
import { compareSeverity } from "./types.js";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 高频违规触发 severity 提升建议的阈值
 *
 * 对应 EAG 方案 §5.5.4 反馈闭环：「高频违规 → 建议提升 severity」。
 * 当 violationCount >= 5 时，suggestSeverityUpgrade 返回 true。
 *
 * 取值依据：5 次违规表示规则被频繁违反，可能是 severity 设置过低（如 WARNING 应升为 MAJOR）。
 */
const SEVERITY_UPGRADE_VIOLATION_THRESHOLD = 5;

/**
 * 长期零违规触发清理建议的注入次数阈值
 *
 * 对应 EAG 方案 §5.5.4 反馈闭环：「长期零违规且被覆盖 → 建议清理」。
 * 当 usageCount >= 10 且 violationCount === 0 时，suggestCleanup 返回 true。
 *
 * 取值依据：10 次注入零违规表示规则已被自然遵守或被高优先级规则覆盖，可建议清理。
 */
const CLEANUP_USAGE_THRESHOLD = 10;

// ============================================================================
// RuleStore 类
// ============================================================================

/**
 * 三层规则存储器
 *
 * 负责三层规则的构造合并、查询、统计、反馈闭环。
 * 构造时合并三层规则，运行时通过 recordUsage / recordViolation 更新统计字段，
 * 通过 suggestSeverityUpgrade / suggestCleanup 提供反馈建议。
 *
 * 用法：
 * ```typescript
 * const store = new RuleStore(SEED_RULES, globalRules, projectRules);
 *
 * // 获取生效规则（按 severity 排序，BLOCKER 优先）
 * const effective = store.getEffectiveRules();
 *
 * // 按分类查询
 * const codeTruthRules = store.getRulesByCategory("code-truth");
 *
 * // 添加用户显式规则
 * store.addUserRule({
 *   id: "USER-01",
 *   category: "code-truth",
 *   severity: "MAJOR",
 *   content: "禁止使用 console.log 调试语句",
 *   source: "user-explicit",
 *   confirmedBy: "auto",
 *   usageCount: 0,
 *   violationCount: 0,
 *   createdAt: new Date().toISOString(),
 * });
 *
 * // 记录违规（评估器按该规则打回时调用）
 * store.recordViolation("USER-01");
 *
 * // 高频违规建议提升 severity
 * if (store.suggestSeverityUpgrade("USER-01")) {
 *   console.log("建议将 USER-01 提升为 BLOCKER 级");
 * }
 * ```
 *
 * 线程安全：本类不做内存缓存，所有操作基于构造时传入的三层规则列表的副本，
 * 通过 copy-on-write 模式更新统计字段，避免外部突变。
 */
export class RuleStore {
  /**
   * 内置种子层规则列表（最低优先级）
   *
   * 注意：此字段不带 readonly 修饰符，因 updateRuleStats 需通过 copy-on-write 模式
   * 重新赋值（用包含更新后统计字段的新数组替换原数组）。
   * 原始 SEED_RULES 常量在构造函数中已被拷贝，本字段的重新赋值不会影响外部常量。
   */
  private seedRules: ReadonlyArray<UserRule>;
  /** 全局用户层规则列表（中优先级） */
  private globalRules: ReadonlyArray<UserRule>;
  /** 项目层规则列表（最高优先级，覆盖同名规则） */
  private projectRules: ReadonlyArray<UserRule>;
  /** 合并后生效规则列表（按 severity 排序，BLOCKER 优先） */
  private effectiveRules: ReadonlyArray<UserRule>;

  /**
   * 构造 RuleStore
   *
   * 构造时合并三层规则：
   * 1. 内置种子层（seedRules，必填，通常为 SEED_RULES 常量）
   * 2. 全局用户层（globalRules，可选，跨项目生效的个人规范）
   * 3. 项目层（projectRules，可选，最高优先级，覆盖全局同名规则）
   *
   * 合并算法：
   * - 以 ID 为键，按优先级 project > global > seed 覆盖
   * - 不同 ID 规则全部保留
   * - 合并后按 severity 排序（BLOCKER 优先 → MAJOR → WARNING）
   *
   * @param seedRules 内置种子层规则列表（必填）
   * @param globalRules 全局用户层规则列表（可选，默认空数组）
   * @param projectRules 项目层规则列表（可选，默认空数组）
   */
  constructor(
    seedRules: ReadonlyArray<UserRule>,
    globalRules?: ReadonlyArray<UserRule>,
    projectRules?: ReadonlyArray<UserRule>
  ) {
    // 拷贝输入数组，避免外部突变影响内部状态
    this.seedRules = Object.freeze([...seedRules]);
    this.globalRules = Object.freeze([...(globalRules ?? [])]);
    this.projectRules = Object.freeze([...(projectRules ?? [])]);
    // 合并三层规则并按 severity 排序
    this.effectiveRules = this.mergeRules(this.seedRules, this.globalRules, this.projectRules);
  }

  // ========================================================================
  // 公共 API：查询
  // ========================================================================

  /**
   * 获取生效规则列表
   *
   * 返回合并后的全部生效规则，按 severity 排序（BLOCKER 优先 → MAJOR → WARNING）。
   * 同 severity 内按 ID 字母序排序（保证测试可重现）。
   *
   * @returns 生效规则列表（只读视图）
   */
  getEffectiveRules(): ReadonlyArray<UserRule> {
    return this.effectiveRules;
  }

  /**
   * 按 ID 查询规则
   *
   * 从生效规则列表中按 ID 查询。同 ID 规则按优先级 project > global > seed 覆盖后，
   * 仅返回优先级最高的那条。
   *
   * @param id 规则 ID（SEED-xx / USER-xx / LEARN-xx）
   * @returns 规则对象；不存在时返回 null
   */
  getRuleById(id: string): UserRule | null {
    return this.effectiveRules.find((r) => r.id === id) ?? null;
  }

  /**
   * 按分类查询规则
   *
   * 返回指定分类的全部生效规则，按 severity 排序（BLOCKER 优先）。
   *
   * @param category 规则分类
   * @returns 符合分类的规则列表（只读视图）
   */
  getRulesByCategory(category: RuleCategory): ReadonlyArray<UserRule> {
    return this.effectiveRules.filter((r) => r.category === category);
  }

  /**
   * 按严重级别查询规则
   *
   * 返回指定严重级别的全部生效规则，按 ID 字母序排序。
   *
   * @param severity 严重级别（BLOCKER/MAJOR/WARNING）
   * @returns 符合级别的规则列表（只读视图）
   */
  getRulesBySeverity(severity: RuleSeverity): ReadonlyArray<UserRule> {
    return this.effectiveRules.filter((r) => r.severity === severity);
  }

  /**
   * 获取三层规则存储快照
   *
   * 返回当前三层存储的完整状态，用于调试、审计与测试断言。
   *
   * @returns 规则存储快照
   */
  getSnapshot(): RuleStoreSnapshot {
    return {
      seedRules: this.seedRules,
      globalRules: this.globalRules,
      projectRules: this.projectRules,
      effectiveRules: this.effectiveRules,
    };
  }

  // ========================================================================
  // 公共 API：添加规则
  // ========================================================================

  /**
   * 添加用户显式规则
   *
   * 将一条 USER-xx 规则添加到全局用户层（globalRules）。
   * 添加后重新合并三层规则，更新 effectiveRules。
   *
   * 注意：
   * - 调用方负责生成 USER-xx 前缀的 ID 与确保唯一性
   * - source 字段会被强制覆盖为 "user-explicit"
   * - confirmedBy 字段会被强制覆盖为 "auto"（用户显式添加无需确认）
   * - 若同 ID 规则已存在，会抛错（调用方负责捕获）
   *
   * @param rule 待添加的用户规则（source/confirmedBy 字段会被强制覆盖）
   * @throws Error 当同 ID 规则已存在时抛错
   */
  addUserRule(rule: UserRule): void {
    // 强制覆盖 source 与 confirmedBy 字段
    const normalizedRule: UserRule = Object.freeze({
      ...rule,
      source: "user-explicit",
      confirmedBy: "auto",
    });
    // 检查同 ID 规则是否已存在
    if (this.findRuleByIdInAllLayers(normalizedRule.id) !== null) {
      throw new Error(`规则 ID "${normalizedRule.id}" 已存在，不能重复添加`);
    }
    // 添加到全局用户层并重新合并
    this.globalRules = Object.freeze([...this.globalRules, normalizedRule]);
    this.effectiveRules = this.mergeRules(this.seedRules, this.globalRules, this.projectRules);
  }

  /**
   * 添加学习固化规则
   *
   * 将一条 LEARN-xx 规则添加到全局用户层（globalRules）。
   * 添加后重新合并三层规则，更新 effectiveRules。
   *
   * 防误学红线（§5.5.4）：
   * - learned 来源规则必须经用户确认才生效
   * - 本方法要求传入的 rule.confirmedBy 必须为 "user"，否则抛错
   * - source 字段会被强制覆盖为 "learned"
   *
   * @param rule 待添加的学习规则（confirmedBy 必须为 "user"，source 会被强制覆盖为 "learned"）
   * @throws Error 当 confirmedBy 不为 "user" 或同 ID 规则已存在时抛错
   */
  addLearnedRule(rule: UserRule): void {
    // 防误学红线：learned 来源规则必须经用户确认
    if (rule.confirmedBy !== "user") {
      throw new Error(
        `学习规则 ${rule.id} 必须经用户确认（confirmedBy="user"）才生效，` + `当前 confirmedBy="${rule.confirmedBy}"`
      );
    }
    // 强制覆盖 source 字段
    const normalizedRule: UserRule = Object.freeze({
      ...rule,
      source: "learned",
    });
    // 检查同 ID 规则是否已存在
    if (this.findRuleByIdInAllLayers(normalizedRule.id) !== null) {
      throw new Error(`规则 ID "${normalizedRule.id}" 已存在，不能重复添加`);
    }
    // 添加到全局用户层并重新合并
    this.globalRules = Object.freeze([...this.globalRules, normalizedRule]);
    this.effectiveRules = this.mergeRules(this.seedRules, this.globalRules, this.projectRules);
  }

  // ========================================================================
  // 公共 API：统计与反馈
  // ========================================================================

  /**
   * 记录规则注入（usageCount +1）
   *
   * 对应 EAG 方案 §5.5.4 反馈闭环：每次注入到 LLM system prompt 时调用。
   * 通过 copy-on-write 模式更新规则对象，避免突变原对象。
   *
   * @param ruleId 规则 ID
   * @throws Error 当规则 ID 不存在时抛错
   */
  recordUsage(ruleId: string): void {
    this.updateRuleStats(ruleId, (rule) => ({
      ...rule,
      usageCount: rule.usageCount + 1,
    }));
  }

  /**
   * 记录规则违规（violationCount +1）
   *
   * 对应 EAG 方案 §5.5.4 反馈闭环：评估器按该规则打回时调用。
   * 通过 copy-on-write 模式更新规则对象，避免突变原对象。
   *
   * @param ruleId 规则 ID
   * @throws Error 当规则 ID 不存在时抛错
   */
  recordViolation(ruleId: string): void {
    this.updateRuleStats(ruleId, (rule) => ({
      ...rule,
      violationCount: rule.violationCount + 1,
    }));
  }

  /**
   * 建议提升 severity（高频违规触发）
   *
   * 对应 EAG 方案 §5.5.4 反馈闭环：「高频违规 → 建议提升 severity」。
   * 当 violationCount >= 5 时返回 true，建议将该规则提升 severity
   * （WARNING → MAJOR → BLOCKER）。
   *
   * 注意：本方法仅返回建议，不自动提升 severity。调用方应根据建议
   * 通过 HUMAN_CHECKPOINT 让用户决定是否提升。
   *
   * @param ruleId 规则 ID
   * @returns true 表示建议提升 severity；false 表示未达阈值
   * @throws Error 当规则 ID 不存在时抛错
   */
  suggestSeverityUpgrade(ruleId: string): boolean {
    const rule = this.getRuleById(ruleId);
    if (rule === null) {
      throw new Error(`规则 ID "${ruleId}" 不存在`);
    }
    return rule.violationCount >= SEVERITY_UPGRADE_VIOLATION_THRESHOLD;
  }

  /**
   * 建议清理规则（长期零违规触发）
   *
   * 对应 EAG 方案 §5.5.4 反馈闭环：「长期零违规且被覆盖 → 建议清理」。
   * 当 usageCount >= 10 且 violationCount === 0 时返回 true，
   * 建议清理该规则（可能已被高优先级规则覆盖或自然遵守）。
   *
   * 注意：本方法仅返回建议，不自动清理规则。调用方应根据建议
   * 通过 HUMAN_CHECKPOINT 让用户决定是否清理。
   *
   * @param ruleId 规则 ID
   * @returns true 表示建议清理；false 表示未达阈值
   * @throws Error 当规则 ID 不存在时抛错
   */
  suggestCleanup(ruleId: string): boolean {
    const rule = this.getRuleById(ruleId);
    if (rule === null) {
      throw new Error(`规则 ID "${ruleId}" 不存在`);
    }
    return rule.usageCount >= CLEANUP_USAGE_THRESHOLD && rule.violationCount === 0;
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 合并三层规则
   *
   * 合并算法：
   * 1. 以 ID 为键，按优先级 project > global > seed 覆盖
   * 2. 不同 ID 规则全部保留
   * 3. 合并后按 severity 排序（BLOCKER 优先 → MAJOR → WARNING）
   * 4. 同 severity 内按 ID 字母序排序（保证测试可重现）
   *
   * @param seedRules 内置种子层规则
   * @param globalRules 全局用户层规则
   * @param projectRules 项目层规则
   * @returns 合并后排序的生效规则列表
   */
  private mergeRules(
    seedRules: ReadonlyArray<UserRule>,
    globalRules: ReadonlyArray<UserRule>,
    projectRules: ReadonlyArray<UserRule>
  ): ReadonlyArray<UserRule> {
    // 以 ID 为键，按优先级 project > global > seed 覆盖
    const mergedById = new Map<string, UserRule>();
    // 先放种子层（最低优先级）
    for (const rule of seedRules) {
      mergedById.set(rule.id, rule);
    }
    // 再放全局用户层（覆盖同 ID 的种子规则）
    for (const rule of globalRules) {
      mergedById.set(rule.id, rule);
    }
    // 最后放项目层（最高优先级，覆盖同 ID 的全局/种子规则）
    for (const rule of projectRules) {
      mergedById.set(rule.id, rule);
    }
    // 转换为数组并按 severity 排序，同 severity 内按 ID 字母序
    const merged = Array.from(mergedById.values());
    merged.sort((a, b) => {
      const severityCmp = compareSeverity(a.severity, b.severity);
      if (severityCmp !== 0) return severityCmp;
      return a.id.localeCompare(b.id);
    });
    return Object.freeze(merged);
  }

  /**
   * 在三层规则中按 ID 查找规则
   *
   * 不应用覆盖优先级，返回首次找到的规则（按 project → global → seed 顺序）。
   * 用于添加规则前检查 ID 唯一性。
   *
   * @param id 规则 ID
   * @returns 规则对象；不存在时返回 null
   */
  private findRuleByIdInAllLayers(id: string): UserRule | null {
    // 按 project → global → seed 顺序查找
    for (const rule of this.projectRules) {
      if (rule.id === id) return rule;
    }
    for (const rule of this.globalRules) {
      if (rule.id === id) return rule;
    }
    for (const rule of this.seedRules) {
      if (rule.id === id) return rule;
    }
    return null;
  }

  /**
   * 更新规则统计字段（copy-on-write）
   *
   * 通过 copy-on-write 模式更新规则的统计字段（usageCount / violationCount），
   * 避免突变原对象。更新后重新合并三层规则。
   *
   * @param ruleId 规则 ID
   * @param updater 更新函数，接收原规则返回新规则
   * @throws Error 当规则 ID 不存在时抛错
   */
  private updateRuleStats(ruleId: string, updater: (rule: UserRule) => UserRule): void {
    // 查找规则所在的层
    let foundLayer: RuleStoreLayer | null = null;
    let foundIndex = -1;
    // 按 project → global → seed 顺序查找
    for (let i = 0; i < this.projectRules.length; i++) {
      if (this.projectRules[i].id === ruleId) {
        foundLayer = "project";
        foundIndex = i;
        break;
      }
    }
    if (foundLayer === null) {
      for (let i = 0; i < this.globalRules.length; i++) {
        if (this.globalRules[i].id === ruleId) {
          foundLayer = "global";
          foundIndex = i;
          break;
        }
      }
    }
    if (foundLayer === null) {
      for (let i = 0; i < this.seedRules.length; i++) {
        if (this.seedRules[i].id === ruleId) {
          foundLayer = "seed";
          foundIndex = i;
          break;
        }
      }
    }
    if (foundLayer === null || foundIndex < 0) {
      throw new Error(`规则 ID "${ruleId}" 不存在`);
    }
    // copy-on-write 更新规则对象
    const updateLayer = (layer: ReadonlyArray<UserRule>): ReadonlyArray<UserRule> => {
      const newLayer = [...layer];
      newLayer[foundIndex] = Object.freeze(updater(newLayer[foundIndex]));
      return Object.freeze(newLayer);
    };
    if (foundLayer === "project") {
      this.projectRules = updateLayer(this.projectRules);
    } else if (foundLayer === "global") {
      this.globalRules = updateLayer(this.globalRules);
    } else {
      // 种子层规则通常是冻结的常量，但统计字段更新需要可变。
      // 解决方案：构造新的种子层数组（包含更新后的规则），保留其他种子规则不变。
      // 注：这不会修改 SEED_RULES 常量本身（因我们拷贝了数组），仅更新 store 内部的 seedRules 视图。
      this.seedRules = updateLayer(this.seedRules);
    }
    // 重新合并三层规则
    this.effectiveRules = this.mergeRules(this.seedRules, this.globalRules, this.projectRules);
  }
}

// ============================================================================
// 模块导出
// ============================================================================

export { SEVERITY_UPGRADE_VIOLATION_THRESHOLD, CLEANUP_USAGE_THRESHOLD };
