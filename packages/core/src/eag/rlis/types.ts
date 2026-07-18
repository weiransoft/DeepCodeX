/**
 * RLIS 规则类型定义
 *
 * EAG 方案 §5.5 规则学习与注入系统的核心数据结构。
 * 定义规则的数据模型、来源、注入目标、严重级别。
 *
 * 三层规则存储（优先级高 → 低）：
 * 1. 项目规则（.deepcode/rules/project.json）—— 项目级约束
 * 2. 全局用户规则（~/.deepcode/rules/user.json）—— 个人偏好
 * 3. 内置种子规则（seed-rules.ts）—— 系统默认
 *
 * @module eag/rlis/types
 */

/**
 * 规则来源
 *
 * - seed：内置种子规则（不可移除的 BLOCKER 级）
 * - user：全局用户规则（~/.deepcode/rules/user.json）
 * - project：项目规则（.deepcode/rules/project.json）
 * - learned：从用户对话中学习并经确认的规则
 */
export type RuleSource = "seed" | "user" | "project" | "learned";

/**
 * 规则严重级别（复用评估器红线分级）
 *
 * - blocker：确定性可判定，不过即打回，不可豁免
 * - major：半确定——打回但可人工豁免
 * - warning：启发式判定，仅提示不打回
 */
export type RuleSeverity = "blocker" | "major" | "warning";

/**
 * 注入目标
 *
 * 规则可注入到两个位置：
 * - system_prompt：注入到 LLM 的 system message 中，影响生成行为
 * - evaluator：注入到评估器的判定清单中，影响验收判定
 */
export type InjectionTarget = "system_prompt" | "evaluator";

/**
 * 规则定义
 *
 * 每条规则是一个结构化的约束，包含唯一 ID、描述、级别、注入目标。
 * 规则会被注入到 LLM 调用的 system prompt 和/或评估器的判定清单中。
 */
export interface RuleDefinition {
  /** 规则唯一 ID（如 "SEED-01", "USER-01", "PROJ-01"） */
  id: string;
  /** 规则名称 */
  name: string;
  /** 规则详细描述 */
  description: string;
  /** 严重级别 */
  severity: RuleSeverity;
  /** 规则来源 */
  source: RuleSource;
  /** 注入目标列表 */
  injectionTargets: InjectionTarget[];
  /**
   * 正则模式（可选）
   *
   * 用于评估器的静态检测：如果代码内容匹配此模式，可能违反该规则。
   * null 表示该规则需要推理判定，无法用正则静态检测。
   */
  pattern: string | null;
  /** 标签（用于分类和检索） */
  tags: string[];
  /** 是否可移除（BLOCKER 级种子规则不可移除） */
  removable: boolean;
}

/**
 * 规则存储层
 *
 * 对应三层存储的每一层。
 */
export type RuleStorageLayer = "seed" | "user" | "project";

/**
 * 合并后的规则集
 *
 * 三层规则按优先级合并后的结果（项目 > 用户 > 种子）。
 * 同 ID 规则高优先级覆盖低优先级。
 */
export interface MergedRuleSet {
  /** 所有生效规则（去重后） */
  rules: RuleDefinition[];
  /** 种子规则数量 */
  seedCount: number;
  /** 用户规则数量 */
  userCount: number;
  /** 项目规则数量 */
  projectCount: number;
  /** 已移除的种子规则 ID 列表（用户通过 /rules remove 移除的可移除种子规则） */
  removedSeedIds: string[];
}
