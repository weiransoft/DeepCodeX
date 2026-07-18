/**
 * RLIS 规则学习与注入系统 —— Barrel 导出（EAG 方案 §5.5）
 *
 * 本模块聚合 RLIS 子模块的公共 API，提供统一入口。
 *
 * 子模块：
 * - types：数据模型（UserRule / RuleCandidate / RuleStoreSnapshot 等）
 * - seed-rules：内置种子规则（10 条 SEED-01 ~ SEED-10）
 * - rule-store：三层规则存储（RuleStore 类）
 * - rule-injector：规则注入器（RuleInjector 类）
 * - rule-learner：规则学习器（RuleLearner 类）
 *
 * @module eag/rlis
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  RuleCategory,
  RuleSeverity,
  RuleSource,
  RuleConfirmedBy,
  UserRule,
  RuleCandidate,
  RuleStoreLayer,
  RuleStoreSnapshot,
  RuleInjectionConfig,
} from "./types.js";

// ============================================================================
// 常量导出
// ============================================================================

export {
  RULE_CATEGORIES,
  RULE_SEVERITIES,
  RULE_SOURCES,
  RULE_CONFIRMED_BY,
  RULE_STORE_LAYERS,
  SEVERITY_PRIORITY,
  compareSeverity,
} from "./types.js";

// ============================================================================
// 种子规则导出
// ============================================================================

export {
  SEED_RULES,
  getSeedRuleCount,
  getSeedRulesBySeverity,
  getSeedRulesByCategory,
  getSeedRuleById,
} from "./seed-rules.js";

// ============================================================================
// RuleStore 类导出
// ============================================================================

export { RuleStore, SEVERITY_UPGRADE_VIOLATION_THRESHOLD, CLEANUP_USAGE_THRESHOLD } from "./rule-store.js";

// ============================================================================
// RuleInjector 类导出
// ============================================================================

export { RuleInjector, TOKEN_ESTIMATE_RATIO } from "./rule-injector.js";

// ============================================================================
// RuleLearner 类导出
// ============================================================================

export {
  RuleLearner,
  CORRECTION_PATTERNS,
  CATEGORY_KEYWORDS,
  SEVERITY_KEYWORDS,
  CONFIRMATION_PUSH_THRESHOLD,
  DEFAULT_CATEGORY,
  DEFAULT_SEVERITY,
} from "./rule-learner.js";
