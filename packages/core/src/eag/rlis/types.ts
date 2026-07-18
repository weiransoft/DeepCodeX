/**
 * RLIS 规则学习与注入系统 —— 数据模型（EAG 方案 §5.5）
 *
 * 本模块定义 EAG 方案 §5.5.1 规则模型与 §5.5.2 三层规则存储所需的全部结构化数据类型。
 * RLIS 的定位是「企业红线之外的第二层红线」，负责用户个性化开发规范的三层存储、注入、
 * 学习、评估闭环：用户习惯一次声明、永久生效，且系统能从日常纠正中自动沉淀新规则。
 *
 * 设计依据：
 * - EAG 方案 §5.5.1 规则模型（UserRule 字段定义）
 * - EAG 方案 §5.5.2 三层规则存储表（内置种子层 / 全局用户层 / 项目层）
 * - EAG 方案 §5.5.3 规则注入（按 category 分组 + severity 标注 + BLOCKER 置顶 + 预算截断）
 * - EAG 方案 §5.5.4 规则学习（检测 → 提取 → 确认 → 固化 → 反馈闭环）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * 与 EAG 红线分级对齐：
 * - BLOCKER：确定性可判定，不过即打回，不可豁免（与 E1~E8 红线同级）
 * - MAJOR：半确定——打回但可人工豁免
 * - WARNING：启发式判定，仅提示不打回
 *
 * @module eag/rlis/types
 */

// ============================================================================
// 1. 字面量联合类型：分类、级别、来源、确认来源
// ============================================================================

/**
 * 规则分类（字面量联合类型）
 *
 * 对应 EAG 方案 §5.5.1 规则模型的 category 字段。
 * 用于规则的结构化分类与按分组注入（注入时按 category 分组）。
 *
 * - code-truth：代码真实性（禁 mock/占位/简化/逃避式删除）
 * - comment-style：注释规范（中文 + 详细 + 符合代码规范）
 * - process-gate：流程门禁（审查/测试先行/需求文档先行）
 * - change-control：变更控制（技术栈锁定等）
 * - project-structure：项目结构（测试目录规范等）
 * - quality-gate：质量门禁（评估器打回条件）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type RuleCategory =
  | "code-truth"
  | "comment-style"
  | "process-gate"
  | "change-control"
  | "project-structure"
  | "quality-gate";

/**
 * 规则分类全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 * 顺序同时作为注入时分组排序的依据（按定义顺序输出）。
 */
export const RULE_CATEGORIES: ReadonlyArray<RuleCategory> = Object.freeze([
  "code-truth",
  "comment-style",
  "process-gate",
  "change-control",
  "project-structure",
  "quality-gate",
]);

/**
 * 规则严重级别（字面量联合类型，与 EAG 企业红线分级对齐）
 *
 * 对应 EAG 方案 §5.5.1 规则模型的 severity 字段。
 *
 * - BLOCKER：确定性可判定，不过即打回，不可豁免（最高优先级，注入置顶）
 * - MAJOR：半确定——打回但可人工豁免
 * - WARNING：启发式判定，仅提示不打回（注入超预算时最先裁）
 *
 * 注：采用大写形式与 EAG 企业红线分级（E1~E8）保持一致，
 * 便于跨模块对齐（如评估器 redlines 模块统一使用大写分级）。
 */
export type RuleSeverity = "BLOCKER" | "MAJOR" | "WARNING";

/**
 * 规则严重级别全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。顺序同时作为 severity 排序依据
 * （BLOCKER 优先 → MAJOR 次之 → WARNING 最后）。
 */
export const RULE_SEVERITIES: ReadonlyArray<RuleSeverity> = Object.freeze(["BLOCKER", "MAJOR", "WARNING"]);

/**
 * 规则来源（字面量联合类型）
 *
 * 对应 EAG 方案 §5.5.1 规则模型的 source 字段。
 *
 * - builtin-seed：内置种子规则（CLI 打包发布，最低优先级，可被覆盖）
 * - user-explicit：用户显式添加（通过 /rules add 命令）
 * - learned：从用户日常纠正中学习并经用户确认固化的规则
 *
 * 防误学红线：learned 来源规则未经用户确认绝不生效（§5.5.4）。
 */
export type RuleSource = "builtin-seed" | "user-explicit" | "learned";

/**
 * 规则来源全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const RULE_SOURCES: ReadonlyArray<RuleSource> = Object.freeze(["builtin-seed", "user-explicit", "learned"]);

/**
 * 规则确认来源（字面量联合类型）
 *
 * 对应 EAG 方案 §5.5.1 规则模型的 confirmedBy 字段。
 *
 * - user：用户显式确认（learned 来源规则必须经用户确认才生效）
 * - auto：系统自动确认（内置种子规则与用户显式添加的规则）
 *
 * 防误学红线：learned 来源规则 confirmedBy 必须为 "user" 才生效；
 * builtin-seed / user-explicit 来源规则 confirmedBy 固定为 "auto"。
 */
export type RuleConfirmedBy = "user" | "auto";

/**
 * 规则确认来源全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const RULE_CONFIRMED_BY: ReadonlyArray<RuleConfirmedBy> = Object.freeze(["user", "auto"]);

// ============================================================================
// 2. 规则定义：UserRule（用户规则）与 RuleCandidate（规则候选）
// ============================================================================

/**
 * 用户规则（UserRule）
 *
 * 对应 EAG 方案 §5.5.1 规则模型的完整定义。
 * 三层规则存储（种子 / 全局 / 项目）的每一层都使用本类型存储规则。
 *
 * 字段语义：
 * - id：规则唯一标识，前缀区分来源
 *   - SEED-xx：内置种子规则（CLI 打包发布）
 *   - USER-xx：用户显式添加规则
 *   - LEARN-xx：学习固化规则（经用户确认）
 * - category：规则分类（按字面量联合，用于分组注入）
 * - severity：严重级别（BLOCKER/MAJOR/WARNING，与 EAG 红线分级对齐）
 * - content：规则原文（中文，用户语言；与 description 不同，content 是规则正文）
 * - source：规则来源（builtin-seed/user-explicit/learned）
 * - confirmedBy：确认来源（user/auto，learned 来源必须为 user 才生效）
 * - usageCount：注入次数统计（每次注入到 LLM system prompt 时 +1）
 * - violationCount：违规次数统计（评估器按该规则打回时 +1）
 * - createdAt：创建时间（ISO 8601 字符串，种子规则使用固定时间戳保证测试可重现）
 *
 * 不可变保证：所有字段 readonly，防止运行期被 LLM 自改。
 */
export interface UserRule {
  /** 规则唯一标识（SEED-xx / USER-xx / LEARN-xx） */
  readonly id: string;
  /** 规则分类（用于分组注入） */
  readonly category: RuleCategory;
  /** 严重级别（与 EAG 企业红线分级对齐） */
  readonly severity: RuleSeverity;
  /** 规则原文（中文，用户语言） */
  readonly content: string;
  /** 规则来源（builtin-seed/user-explicit/learned） */
  readonly source: RuleSource;
  /** 确认来源（user/auto，learned 来源必须为 user 才生效） */
  readonly confirmedBy: RuleConfirmedBy;
  /** 注入次数统计（每次注入到 LLM system prompt 时 +1） */
  readonly usageCount: number;
  /** 违规次数统计（评估器按该规则打回时 +1） */
  readonly violationCount: number;
  /** 创建时间（ISO 8601 字符串） */
  readonly createdAt: string;
}

/**
 * 规则候选（RuleCandidate）
 *
 * 对应 EAG 方案 §5.5.4 规则学习流程的「提取」阶段产出。
 * 从用户日常纠正中提取的规则候选，需经用户确认后才转为 UserRule（learned 来源）。
 *
 * 防误学红线（§5.5.4）：
 * - learned 来源规则未经用户确认绝不生效
 * - 单次纠正默认只生成候选，同类纠正出现 ≥2 次才主动推送确认请求
 * - occurrenceCount 字段记录同类纠正出现次数，shouldPushConfirmation 据此判定
 *
 * 字段语义：
 * - id：临时 ID（LEARN-xx 前缀，与最终 UserRule 同 ID）
 * - category：基于纠正内容关键词推断的分类
 * - severity：基于纠正语气关键词推断的级别
 * - content：从纠正内容提取的规则正文
 * - detectedPattern：命中的纠正模式（如 "不要..." / "严禁..." / "必须..."）
 * - occurrenceCount：同类纠正出现次数（≥2 才主动推送确认请求）
 * - firstDetectedAt：首次检测到该纠正的时间（ISO 8601）
 * - lastDetectedAt：最近一次检测到该纠正的时间（ISO 8601）
 */
export interface RuleCandidate {
  /** 临时规则 ID（LEARN-xx 前缀） */
  readonly id: string;
  /** 推断的规则分类 */
  readonly category: RuleCategory;
  /** 推断的严重级别 */
  readonly severity: RuleSeverity;
  /** 提取的规则正文 */
  readonly content: string;
  /** 命中的纠正模式（如 "不要..." / "严禁..." / "必须..." / "以后都..." / "禁止..."） */
  readonly detectedPattern: string;
  /** 同类纠正出现次数（≥2 才主动推送确认请求） */
  readonly occurrenceCount: number;
  /** 首次检测到该纠正的时间（ISO 8601 字符串） */
  readonly firstDetectedAt: string;
  /** 最近一次检测到该纠正的时间（ISO 8601 字符串） */
  readonly lastDetectedAt: string;
}

// ============================================================================
// 3. 三层规则存储：RuleStoreLayer 与 RuleStoreSnapshot
// ============================================================================

/**
 * 规则存储层（字面量联合类型）
 *
 * 对应 EAG 方案 §5.5.2 三层规则存储表的「层」概念。
 *
 * - seed：内置种子层（CLI 打包，最低优先级，可被覆盖）
 * - global：全局用户层（~/.deepcodeX/rules/global-rules.json，跨项目生效）
 * - project：项目层（.deepcode/rules/project-rules.json，最高优先级，覆盖全局同名规则）
 *
 * 合并优先级：project > global > seed（同 ID 规则高优先级覆盖低优先级）。
 */
export type RuleStoreLayer = "seed" | "global" | "project";

/**
 * 规则存储层全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。顺序同时作为合并优先级（project > global > seed）。
 */
export const RULE_STORE_LAYERS: ReadonlyArray<RuleStoreLayer> = Object.freeze(["seed", "global", "project"]);

/**
 * 规则存储快照（RuleStoreSnapshot）
 *
 * 三层规则存储在某时刻的完整快照，用于：
 * - RuleStore.getSnapshot() 返回当前三层存储的完整状态
 * - 测试断言三层合并结果
 * - 调试与审计（记录某次注入前的规则状态）
 *
 * 字段语义：
 * - seedRules：内置种子层规则列表（来自 SEED_RULES 常量）
 * - globalRules：全局用户层规则列表（来自 ~/.deepcodeX/rules/global-rules.json）
 * - projectRules：项目层规则列表（来自 .deepcode/rules/project-rules.json）
 * - effectiveRules：合并后生效规则列表（项目层覆盖全局同名规则，按 severity 排序 BLOCKER 优先）
 */
export interface RuleStoreSnapshot {
  /** 内置种子层规则列表 */
  readonly seedRules: ReadonlyArray<UserRule>;
  /** 全局用户层规则列表 */
  readonly globalRules: ReadonlyArray<UserRule>;
  /** 项目层规则列表 */
  readonly projectRules: ReadonlyArray<UserRule>;
  /** 合并后生效规则列表（项目层覆盖全局同名规则，按 severity 排序 BLOCKER 优先） */
  readonly effectiveRules: ReadonlyArray<UserRule>;
}

// ============================================================================
// 4. 规则注入配置：RuleInjectionConfig
// ============================================================================

/**
 * 规则注入配置（RuleInjectionConfig）
 *
 * 对应 EAG 方案 §5.5.3 规则注入的配置选项。
 * 由 RuleInjector.inject(rules, config?) 方法使用。
 *
 * 字段语义：
 * - maxTokenBudget：Token 预算上限（超预算时按 severity 截断）
 *   - 不传时不做预算控制（注入全部规则）
 *   - 传入时按 4 字符/token 粗估进行截断
 * - truncateBySeverity：超预算时是否按 severity 截断
 *   - true：WARNING 最先裁，然后 MAJOR，BLOCKER 永不裁
 *   - false：超预算时不截断（仍注入全部规则，可能导致超预算）
 *
 * 默认行为（不传 config 时）：不限制预算，注入全部规则。
 */
export interface RuleInjectionConfig {
  /** Token 预算上限（超预算时按 severity 截断） */
  readonly maxTokenBudget?: number;
  /** 超预算时是否按 severity 截断（WARNING 最先裁） */
  readonly truncateBySeverity: boolean;
}

// ============================================================================
// 5. 严重级别优先级辅助常量
// ============================================================================

/**
 * 严重级别优先级映射（数值越大优先级越高）
 *
 * 用于：
 * - getEffectiveRules() 按 severity 排序（BLOCKER 优先）
 * - RuleInjector.inject() 按 severity 截断（WARNING 最先裁）
 * - suggestSeverityUpgrade() 触发条件判定
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const SEVERITY_PRIORITY: Readonly<Record<RuleSeverity, number>> = Object.freeze({
  BLOCKER: 3,
  MAJOR: 2,
  WARNING: 1,
});

/**
 * 严重级别排序比较函数
 *
 * 用于 Array.sort() 按 severity 降序排序（BLOCKER 优先 → MAJOR → WARNING）。
 *
 * @param a 严重级别 A
 * @param b 严重级别 B
 * @returns 负数表示 A 优先于 B，正数表示 B 优先于 A，0 表示同级
 */
export function compareSeverity(a: RuleSeverity, b: RuleSeverity): number {
  return SEVERITY_PRIORITY[b] - SEVERITY_PRIORITY[a];
}
