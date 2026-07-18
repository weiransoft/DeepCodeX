/**
 * RLIS 规则注入器（Rule Injector）—— EAG 方案 §5.5.3
 *
 * 本模块实现 EAG 方案 §5.5.3 规则注入的 `RuleInjector` 类。
 * 负责将规则列表格式化为可注入到 LLM system prompt 的字符串。
 *
 * 注入格式（§5.5.3）：
 * ```
 * ## 用户规则清单（生效中）
 *
 * ### [code-truth] BLOCKER 级（不可豁免）
 * - [SEED-01] 禁止使用模拟、占位、mock、简化的方式开发代码，严格真实实现所需逻辑和需求
 * - [SEED-03] 严禁未得到批准的简化实现、逃避式删除等方式解决问题，严格根据需求实现
 *
 * ### [code-truth] MAJOR 级（可人工豁免）
 * - [SEED-04] 代码中所有 TODO 注释都必须有对应实现，不能只是注释
 *
 * ### [comment-style] MAJOR 级
 * - [SEED-02] 代码函数和关键逻辑都需要注释，注释要中文、要详细...
 *
 * ### [process-gate] WARNING 级（仅提示）
 * - [USER-01] ...
 * ```
 *
 * 注入规则：
 * - 按 category 分组（code-truth / comment-style / process-gate / change-control / project-structure / quality-gate）
 * - severity 标注（BLOCKER 置顶 → MAJOR → WARNING）
 * - 超 token 预算时按 severity 截断（WARNING 最先裁，然后 MAJOR，BLOCKER 永不裁）
 *
 * 生效范围（§5.5.3）：
 * - 主循环每次 buildMessages 前自动注入
 * - EAG 三 Loop（DESIGN/CODING/TESTING）的角色 prompt 同样携带
 *
 * 设计依据：
 * - EAG 方案 §5.5.3 规则注入
 * - 项目约定：与 v2/context/dual-layer-manager.ts 的 directRetainSnippets 通道集成
 *
 * @module eag/rlis/rule-injector
 */

import type { UserRule, RuleInjectionConfig } from "./types.js";
import { RULE_CATEGORIES, SEVERITY_PRIORITY } from "./types.js";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * Token 估算系数（4 字符 ≈ 1 Token）
 *
 * 简单的 Token 估算：字符串长度 / 4。
 * 此估算不依赖 tokenizer 库，仅用于预算控制，精度足够。
 * 实际 Token 数由 LLM API 返回的 usage 字段精确统计。
 *
 * 取值依据：OpenAI tokenizer 对英文文本约 4 字符/Token，
 * 中文文本因 UTF-8 编码可能略多但粗估可接受。
 */
const TOKEN_ESTIMATE_RATIO = 4;

// ============================================================================
// RuleInjector 类
// ============================================================================

/**
 * 规则注入器
 *
 * 将规则列表格式化为可注入到 LLM system prompt 的字符串。
 * 支持：
 * - 按 category 分组（同 category 内按 severity 排序，BLOCKER 置顶）
 * - severity 标注（标题中标注级别）
 * - 超 token 预算时按 severity 截断（WARNING 最先裁，BLOCKER 永不裁）
 *
 * 用法：
 * ```typescript
 * const injector = new RuleInjector();
 * const store = new RuleStore(SEED_RULES);
 *
 * // 注入全部规则（不限制预算）
 * const text1 = injector.inject(store.getEffectiveRules(), { truncateBySeverity: false });
 *
 * // 注入并按 token 预算截断
 * const text2 = injector.inject(store.getEffectiveRules(), {
 *   maxTokenBudget: 1000,
 *   truncateBySeverity: true,
 * });
 * ```
 */
export class RuleInjector {
  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 将规则列表格式化为注入字符串
   *
   * 格式化流程：
   * 1. 按 category 分组（按 RULE_CATEGORIES 定义顺序）
   * 2. 每个 category 内按 severity 排序（BLOCKER → MAJOR → WARNING）
   * 3. 输出分组标题 + 规则列表
   * 4. 若配置了 maxTokenBudget 且 truncateBySeverity=true：
   *    - 超 budget 时按 severity 截断（WARNING 最先裁，然后 MAJOR，BLOCKER 永不裁）
   *    - 截断时在末尾追加"（已截断 N 条 WARNING 级规则）"提示
   *
   * @param rules 规则列表
   * @param config 注入配置（不传时默认 truncateBySeverity=false，注入全部规则）
   * @returns 格式化的注入字符串（空规则列表返回空字符串）
   */
  inject(rules: ReadonlyArray<UserRule>, config?: RuleInjectionConfig): string {
    // 空规则列表返回空字符串
    if (rules.length === 0) {
      return "";
    }

    // 默认配置：不截断
    const truncateBySeverity = config?.truncateBySeverity ?? false;
    const maxTokenBudget = config?.maxTokenBudget;

    // 若启用截断且有预算上限，先按 severity 截断规则列表
    let effectiveRules = rules;
    let truncatedCount = 0;
    if (truncateBySeverity && maxTokenBudget !== undefined) {
      const truncationResult = this.truncateByTokenBudget(rules, maxTokenBudget);
      effectiveRules = truncationResult.rules;
      truncatedCount = truncationResult.truncatedCount;
    }

    // 按 category 分组（按 RULE_CATEGORIES 定义顺序）
    const lines: string[] = ["## 用户规则清单（生效中）", ""];

    for (const category of RULE_CATEGORIES) {
      const categoryRules = effectiveRules.filter((r) => r.category === category);
      if (categoryRules.length === 0) continue;
      // category 内按 severity 排序（BLOCKER 优先）
      const sortedRules = this.sortBySeverity(categoryRules);
      // 输出 category 分组标题
      lines.push(`### [${category}]`);
      // 输出每条规则
      for (const rule of sortedRules) {
        lines.push(this.formatRule(rule));
      }
      lines.push("");
    }

    // 若发生截断，追加截断提示
    if (truncatedCount > 0) {
      lines.push(`（已截断 ${truncatedCount} 条 WARNING/MAJOR 级规则以控制 token 预算）`);
    }

    return lines.join("\n").trim();
  }

  /**
   * 格式化单条规则为字符串
   *
   * 格式：`- [ID] [SEVERITY] content`
   *
   * 示例：`- [SEED-01] [BLOCKER] 禁止使用模拟、占位、mock、简化的方式开发代码...`
   *
   * @param rule 规则对象
   * @returns 格式化的规则字符串
   */
  formatRule(rule: UserRule): string {
    return `- [${rule.id}] [${rule.severity}] ${rule.content}`;
  }

  /**
   * 估算字符串 token 数
   *
   * 按 4 字符/token 粗估（与 TOKEN_ESTIMATE_RATIO 一致）。
   * 用于预算控制与截断判定。
   *
   * @param text 字符串
   * @returns 估算的 token 数（向上取整）
   */
  estimateTokenCount(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / TOKEN_ESTIMATE_RATIO);
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 按严重级别排序规则（BLOCKER 优先 → MAJOR → WARNING）
   *
   * 同 severity 内按 ID 字母序排序（保证测试可重现）。
   *
   * @param rules 规则列表
   * @returns 排序后的规则列表（新数组，不修改原数组）
   */
  private sortBySeverity(rules: ReadonlyArray<UserRule>): UserRule[] {
    return [...rules].sort((a, b) => {
      const severityCmp = SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity];
      if (severityCmp !== 0) return severityCmp;
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * 按 token 预算截断规则列表
   *
   * 截断策略（§5.5.3）：
   * 1. 估算完整注入文本的 token 数
   * 2. 若未超预算，返回完整规则列表
   * 3. 若超预算，按 severity 截断：
   *    - 优先保留 BLOCKER（永不裁）
   *    - 其次保留 MAJOR
   *    - 最先裁 WARNING
   * 4. 逐步裁剪 WARNING → MAJOR，直到 token 数在预算内或仅剩 BLOCKER
   *
   * @param rules 完整规则列表
   * @param maxTokenBudget token 预算上限
   * @returns 截断结果（保留的规则列表 + 被裁剪的数量）
   */
  private truncateByTokenBudget(
    rules: ReadonlyArray<UserRule>,
    maxTokenBudget: number
  ): { rules: ReadonlyArray<UserRule>; truncatedCount: number } {
    // 估算完整注入文本的 token 数
    const fullText = this.buildInjectionText(rules);
    const fullTokens = this.estimateTokenCount(fullText);

    // 未超预算，直接返回
    if (fullTokens <= maxTokenBudget) {
      return { rules, truncatedCount: 0 };
    }

    // 超预算：按 severity 分组
    const blockerRules = rules.filter((r) => r.severity === "BLOCKER");
    const majorRules = rules.filter((r) => r.severity === "MAJOR");
    const warningRules = rules.filter((r) => r.severity === "WARNING");

    // 逐步裁剪：先尝试 BLOCKER + MAJOR + 部分 WARNING
    // 然后尝试 BLOCKER + 部分 MAJOR
    // 最后仅保留 BLOCKER

    // 阶段 1：保留 BLOCKER + MAJOR，裁掉全部 WARNING
    const stage1Rules = [...blockerRules, ...majorRules];
    const stage1Text = this.buildInjectionText(stage1Rules);
    const stage1Tokens = this.estimateTokenCount(stage1Text);
    if (stage1Tokens <= maxTokenBudget) {
      // 预算允许部分 WARNING，逐步添加 WARNING 直到超预算
      const remainingWarning: UserRule[] = [];
      let currentRules = [...stage1Rules];
      for (const rule of warningRules) {
        const candidateRules = [...currentRules, rule];
        const candidateText = this.buildInjectionText(candidateRules);
        const candidateTokens = this.estimateTokenCount(candidateText);
        if (candidateTokens > maxTokenBudget) break;
        currentRules = candidateRules;
        remainingWarning.push(rule);
      }
      const truncatedWarningCount = warningRules.length - remainingWarning.length;
      return { rules: currentRules, truncatedCount: truncatedWarningCount };
    }

    // 阶段 2：保留 BLOCKER + 部分 MAJOR，裁掉全部 WARNING + 部分 MAJOR
    const stage2BaseRules = [...blockerRules];
    const remainingMajor: UserRule[] = [];
    let currentRules = [...stage2BaseRules];
    for (const rule of majorRules) {
      const candidateRules = [...currentRules, rule];
      const candidateText = this.buildInjectionText(candidateRules);
      const candidateTokens = this.estimateTokenCount(candidateText);
      if (candidateTokens > maxTokenBudget) break;
      currentRules = candidateRules;
      remainingMajor.push(rule);
    }
    const truncatedMajorCount = majorRules.length - remainingMajor.length;
    return {
      rules: currentRules,
      truncatedCount: warningRules.length + truncatedMajorCount,
    };
  }

  /**
   * 构建注入文本（不包含截断提示）
   *
   * 用于 token 估算。与 inject() 方法的格式化逻辑保持一致。
   *
   * @param rules 规则列表
   * @returns 注入文本
   */
  private buildInjectionText(rules: ReadonlyArray<UserRule>): string {
    if (rules.length === 0) return "";
    const lines: string[] = ["## 用户规则清单（生效中）", ""];
    for (const category of RULE_CATEGORIES) {
      const categoryRules = rules.filter((r) => r.category === category);
      if (categoryRules.length === 0) continue;
      const sortedRules = this.sortBySeverity(categoryRules);
      lines.push(`### [${category}]`);
      for (const rule of sortedRules) {
        lines.push(this.formatRule(rule));
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }
}

// ============================================================================
// 模块导出
// ============================================================================

export { TOKEN_ESTIMATE_RATIO };
