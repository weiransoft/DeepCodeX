/**
 * EAG-P5 Phase 5.2 SmartConfirmation 三态确认（P5 版）（TASK-P5-1.2-003）
 *
 * 本模块实现 `P5SmartConfirmation` 类，作为 AutonomousOrchestrator 4 阶段循环
 * 中"命令级第二道防线"，在系统级护栏（BlockerGuardChain）通过后对命令字符串
 * 进行细粒度模式匹配与风险评分，输出三态决策。
 *
 * 核心职责（对齐架构师审查 §2.3.1 层级关系 + §9.3 单一真相源决议）：
 * 1. 接收 GuardVerdict（来自 BlockerGuardChain）+ 可选 command 字符串
 * 2. 三态决策输出：auto-approve / ask-user / fail-closed
 * 3. 优先级：guard DENY → fail-closed（短路）；guard ASK → ask-user；
 *           guard PASS → 命令级评估（黑/白名单 + 风险评分）
 * 4. 黑名单命中立即 fail-closed（不走风险评分，对齐 Ponytail 红线）
 * 5. 白名单命中立即 auto-approve（LOW 风险）
 * 6. 风险评分超 denyThreshold → fail-closed；超 askThreshold → ask-user
 *
 * 与 team/autonomous/smart-confirmation.ts 的差异：
 * - team 版接口：check(command) → AUTO/ASK/DENY（仅命令级）
 * - P5 版接口：decide(verdict, command?) → auto-approve/ask-user/fail-closed
 *   （融合 GuardVerdict + 命令级评估，作为护栏守护链的下游决策器）
 * - P5 版与 BlockerGuardChain 协同：guard 先判（系统级），P5SmartConfirmation 后判（命令级）
 *
 * 关键技术决策（对齐架构师审查 §2.3.2）：
 * - 黑/白名单数据源：复用 v2/approval/command-safety.ts 的单一真相源
 *   （BUILTIN_BLACKLIST_REGEX / BUILTIN_WHITELIST_REGEX）
 * - 风险评分规则：与 team 版一致（RISK_PATTERNS 18 条规则）
 * - 预编译正则：构造时一次性编译所有正则（IGNORECASE），运行期仅 test
 * - 零新增依赖：仅复用 node:* 与项目既有依赖
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/p5/smart-confirmation
 */

import { BUILTIN_BLACKLIST_REGEX, BUILTIN_WHITELIST_REGEX } from "../../v2/approval/command-safety";
import type { GuardVerdict, TaskCard } from "./guards/types";
// 使用 type-only import 避免运行期循环依赖：
// confirmation-history-store.ts 仅 type-import 本模块的类型，
// 本模块仅 type-import 它的类型，编译期双向 type 依赖会被 TS 擦除。
import type { P5ConfirmationHistoryStore, P5ConfirmationHistoryEntry } from "./confirmation-history-store";
import type { SymbolGraphStore } from "./symbol-graph-store";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * 风险评分默认阈值：auto-approve 上限
 *
 * 风险分 <= 此值 → auto-approve
 * 取值 0：保守策略，默认无命令级自动放行（依赖白名单放行）
 */
const DEFAULT_AUTO_THRESHOLD = 0 as const;

/**
 * 风险评分默认阈值：ask-user 上限
 *
 * 风险分 <= 此值 → ask-user
 * 风险分 > 此值 → fail-closed
 * 取值 70：与 team 版一致（>=71 自动 ask-user，本版改为 >70 直接 fail-closed）
 */
const DEFAULT_ASK_THRESHOLD = 70 as const;

/**
 * 风险评分默认阈值：fail-closed 触发线
 *
 * 风险分 > 此值 → fail-closed（拒绝执行）
 * 取值 70：与 DEFAULT_ASK_THRESHOLD 一致，简化决策逻辑
 */
const DEFAULT_DENY_THRESHOLD = 70 as const;

/**
 * 风险评分规则表（18 条规则）
 *
 * 每条规则为一对 [正则字符串, 加分]，命中即累加。
 * 最终分数上限 100（Math.min(100, score)）。
 *
 * 与 team/autonomous/smart-confirmation.ts 的 RISK_PATTERNS 保持一致，
 * 确保跨模块风险评分行为一致（对齐架构师 §9.3 单一真相源决议的延伸：
 * 风险评分规则属于评分逻辑而非名单数据，留在 SmartConfirmation 侧维护）。
 */
const RISK_PATTERNS: ReadonlyArray<Readonly<[string, number]>> = Object.freeze([
  ["\\brm\\s+-rf\\b", 50],
  ["\\brm\\s+-r\\b", 30],
  ["\\brm\\s+-f\\b", 20],
  ["\\bsudo\\b", 30],
  ["\\bchmod\\s+", 15],
  ["\\bchown\\s+", 15],
  ["\\bgit\\s+push\\b", 20],
  ["\\bgit\\s+reset\\b", 20],
  ["\\bgit\\s+clean\\b", 20],
  ["\\bpip\\s+install\\b", 10],
  ["\\bnpm\\s+install\\b", 10],
  [">\\s*/", 20],
  ["\\|\\s*bash\\b", 40],
  ["\\|\\s*sh\\b", 40],
  ["\\bsystemctl\\b", 20],
  ["\\bkill\\s+-9\\b", 20],
  ["\\bkillall\\b", 20],
  ["--force\\b", 25],
  ["--hard\\b", 25],
]);

// ============================================================================
// 1.1 扩展数据源常量（Phase 5.3 TASK-P5-5.3-001 新增）
// ============================================================================

/**
 * 历史决策"曾拒绝"次数阈值：达到即升级为 ask-user
 *
 * 含义：若同一命令在历史中曾被 fail-closed 拒绝 >= 1 次，
 * 后续相同命令应升级为 ask-user（保守策略，避免重蹈覆辙）。
 *
 * 取值 1：单次拒绝即触发升级（最保守）。
 */
const HISTORY_DENY_UPGRADE_THRESHOLD = 1 as const;

/**
 * 历史决策"曾确认"次数阈值：达到即升级为 ask-user
 *
 * 含义：若同一命令在历史中曾被 ask-user 确认 >= 3 次，
 * 后续相同命令应升级为 ask-user（频繁人工确认说明命令存在争议）。
 *
 * 取值 3：3 次人工确认即触发升级。
 */
const HISTORY_ASK_UPGRADE_THRESHOLD = 3 as const;

/**
 * 历史决策"频繁自动放行"次数阈值：达到即保持原决策并降低风险等级
 *
 * 含义：若同一命令在历史中曾被 auto-approve >= 5 次，
 * 后续相同命令可保持原决策（通常为 auto-approve），信任历史模式。
 *
 * 取值 5：5 次自动放行即认为命令安全。
 */
const HISTORY_AUTO_TRUST_THRESHOLD = 5 as const;

/**
 * 爆炸半径"受影响符号数"阈值：超过即升级为 ask-user
 *
 * 含义：若命令影响的符号数 > 20，说明变更波及范围广，
 * 应升级为 ask-user（防止大规模重构未经确认）。
 *
 * 取值 20：覆盖典型中型服务模块的符号数。
 */
const IMPACT_RADIUS_UPGRADE_THRESHOLD = 20 as const;

/**
 * 爆炸半径"受影响符号数"严重阈值：超过即升级为 fail-closed
 *
 * 含义：若命令影响的符号数 > 100，说明变更波及范围极广，
 * 应升级为 fail-closed（防止灾难性大范围破坏）。
 *
 * 取值 100：覆盖大型模块的符号数上限。
 */
const IMPACT_RADIUS_CRITICAL_THRESHOLD = 100 as const;

/**
 * 任务模式匹配：危险文件路径模式（命中即升级为 ask-user）
 *
 * 含义：若任务卡声明的文件路径含凭据/密钥/配置文件等敏感模式，
 * 说明变更可能涉及凭据安全，应升级为 ask-user。
 *
 * 对齐 G-A5a 凭据文件读取白名单的判定模式。
 */
const DANGEROUS_FILE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = Object.freeze([
  /\.env/i,
  /credentials/i,
  /token/i,
  /secret/i,
  /private[_-]?key/i,
  /id_rsa/i,
  /id_ed25519/i,
]);

/**
 * 任务模式匹配：清理类命令关键词（命中即升级为 ask-user）
 *
 * 对齐 G-A3b 清理类意图永禁 AUTO 的判定模式。
 */
const CLEANUP_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "cleanup",
  "purge",
  "reset",
  "删除多余",
  "整理",
  "清理",
]);

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * 风险等级（4 级）
 *
 * - low：风险分 0-30（安全）
 * - medium：风险分 31-70（需确认）
 * - high：风险分 71-99（高风险）
 * - critical：风险分 100（黑名单命中）
 */
export type P5RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * SmartConfirmation 三态决策（字面量联合类型）
 *
 * - auto-approve：自动放行（白名单命中 / 风险分低于阈值）
 * - ask-user：需用户确认（guard ASK / 中等风险分）
 * - fail-closed：拒绝执行（guard DENY / 黑名单命中 / 高风险分）
 */
export type P5ConfirmationDecision = "auto-approve" | "ask-user" | "fail-closed";

/**
 * P5_CONFIRMATION_DECISIONS 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const P5_CONFIRMATION_DECISIONS: ReadonlyArray<P5ConfirmationDecision> = Object.freeze([
  "auto-approve",
  "ask-user",
  "fail-closed",
]);

/**
 * SmartConfirmation 决策结果
 *
 * 字段全部 readonly——决策一经产出即不可变。
 *
 * 范例：
 *   {
 *     decision: "fail-closed",
 *     reason: "命令命中黑名单模式：\\brm\\s+-rf\\b（永远禁止）",
 *     riskLevel: "critical",
 *     riskScore: 100,
 *     matchedPattern: "\\brm\\s+-rf\\b",
 *     guardRuleId: "G-A2a",
 *     timestamp: "2026-07-21T10:00:00.000Z"
 *   }
 */
export interface P5ConfirmationResult {
  /** 决策（auto-approve / ask-user / fail-closed） */
  readonly decision: P5ConfirmationDecision;
  /** 决策原因（人类可读，含命中规则与分数） */
  readonly reason: string;
  /** 风险等级（low / medium / high / critical） */
  readonly riskLevel: P5RiskLevel;
  /** 风险评分（0-100，黑名单命中固定 100） */
  readonly riskScore: number;
  /** 命中的模式字符串（未命中时为空字符串） */
  readonly matchedPattern: string;
  /** 触发的护栏规则 ID（来自 GuardVerdict，未触发时为空字符串） */
  readonly guardRuleId: string;
  /** 决策时间戳（ISO 8601 字符串） */
  readonly timestamp: string;
}

/**
 * SmartConfirmation 配置选项
 *
 * 所有字段可选，未提供时使用默认值。
 */
export interface P5SmartConfirmationOptions {
  /** 自定义黑名单（覆盖默认 BUILTIN_BLACKLIST_REGEX） */
  readonly blacklist?: ReadonlyArray<string>;
  /** 自定义白名单（覆盖默认 BUILTIN_WHITELIST_REGEX） */
  readonly whitelist?: ReadonlyArray<string>;
  /** auto-approve 阈值（风险分 <= 此值 → auto-approve，默认 0） */
  readonly autoThreshold?: number;
  /** ask-user 阈值（风险分 <= 此值 → ask-user，默认 70） */
  readonly askThreshold?: number;
  /** fail-closed 阈值（风险分 > 此值 → fail-closed，默认 70） */
  readonly denyThreshold?: number;
  /** 自定义风险评分规则（覆盖默认 RISK_PATTERNS） */
  readonly riskPatterns?: ReadonlyArray<Readonly<[string, number]>>;
  /**
   * 历史决策存储实例（Phase 5.3 TASK-P5-5.3-001 新增）
   *
   * 注入后启用 recordDecision() 方法，可将决策结果持久化到 JSONL 文件。
   * 未注入时 recordDecision() 抛出 Error。
   * decideWithContext() 不依赖此字段（通过 context.historyStore 传入）。
   */
  readonly historyStore?: P5ConfirmationHistoryStore;
}

// ============================================================================
// 2.1 扩展数据源类型（Phase 5.3 TASK-P5-5.3-001 新增）
// ============================================================================

/**
 * SmartConfirmation 扩展决策上下文（TASK-P5-5.3-001）
 *
 * 在原 decide(verdict, command?) API 基础上，提供更丰富的上下文信息，
 * 使 decideWithContext() 能够综合多源数据做出更精准的三态决策。
 *
 * 数据源（对齐架构师审查 §4.5 SmartConfirmation 数据源扩展决议）：
 * 1. 命令字符串（command）：原 decide() 已支持，命令级模式匹配的基础
 * 2. 历史决策数据库（historyStore）：查询同一命令在历史中的决策模式
 * 3. 风险评分（symbolGraphStore）：通过 ImpactBFS 计算爆炸半径
 * 4. 任务模式匹配（taskCard）：通过任务卡声明的文件路径与符号判定危险等级
 *
 * 字段全部 readonly——上下文一经构造即不可变。
 *
 * 范例：
 * ```typescript
 * const context: P5SmartConfirmationContext = {
 *   command: "rm -rf node_modules",
 *   runId: "run-001",
 *   projectRoot: "/path/to/project",
 *   iterIndex: 3,
 *   stage: "dev",
 *   historyStore: createDefaultP5ConfirmationHistoryStore(),
 *   symbolGraphStore: new SymbolGraphStore(":memory:"),
 *   taskCard: currentTaskCard,
 * };
 * const result = confirmation.decideWithContext(verdict, context);
 * ```
 */
export interface P5SmartConfirmationContext {
  /** 待评估的命令字符串（可选，无命令时仅基于 verdict 决策） */
  readonly command?: string;
  /** 当前 run-id（用于历史决策查询的 runId 过滤） */
  readonly runId: string;
  /** 项目根目录（用于历史决策存储路径解析） */
  readonly projectRoot: string;
  /** 当前迭代号（0-based，用于历史决策记录） */
  readonly iterIndex: number;
  /** 当前阶段（plan/dev/verify/fix，用于历史决策记录） */
  readonly stage: "plan" | "dev" | "verify" | "fix";
  /** 历史决策存储实例（可选，未提供时跳过历史数据源） */
  readonly historyStore?: P5ConfirmationHistoryStore;
  /** 符号图谱存储实例（可选，未提供时跳过爆炸半径数据源） */
  readonly symbolGraphStore?: SymbolGraphStore;
  /** 当前任务卡（可选，用于任务模式匹配数据源） */
  readonly taskCard?: Readonly<TaskCard>;
}

/**
 * 数据源贡献记录（TASK-P5-5.3-001）
 *
 * 记录每个扩展数据源对最终决策的贡献，用于审计与可观测性。
 *
 * 字段全部 readonly——贡献记录一经产出即不可变。
 *
 * 范例：
 *   {
 *     source: "history",
 *     action: "upgrade-to-ask-user",
 *     reason: "历史中曾有 1 次 fail-closed 拒绝记录（达到阈值 1）",
 *     evidence: { denyCount: 1, askCount: 0, autoApproveCount: 0 }
 *   }
 */
export interface P5DataSourceContribution {
  /** 数据源名称（history / impact-radius / task-pattern） */
  readonly source: "history" | "impact-radius" | "task-pattern";
  /** 贡献动作（none=无影响 / upgrade-to-ask-user=升级为 ask-user / upgrade-to-fail-closed=升级为 fail-closed / keep=保持原决策） */
  readonly action: "none" | "upgrade-to-ask-user" | "upgrade-to-fail-closed" | "keep";
  /** 贡献原因（人类可读，含具体阈值与统计） */
  readonly reason: string;
  /** 证据数据（键值对，用于审计与调试） */
  readonly evidence: Readonly<Record<string, number | string | boolean>>;
}

/**
 * 扩展决策结果（TASK-P5-5.3-001）
 *
 * 在原 P5ConfirmationResult 基础上，新增数据源贡献列表，
 * 使调用方能够审计每个数据源对最终决策的影响。
 *
 * 字段全部 readonly——结果一经产出即不可变。
 *
 * 范例：
 *   {
 *     baseDecision: "auto-approve",
 *     finalDecision: "ask-user",
 *     reason: "基础决策 auto-approve 被历史数据源升级为 ask-user",
 *     riskLevel: "low",
 *     riskScore: 0,
 *     matchedPattern: "",
 *     guardRuleId: "",
 *     timestamp: "2026-07-21T10:00:00.000Z",
 *     dataSourceContributions: [
 *       { source: "history", action: "upgrade-to-ask-user", reason: "...", evidence: {...} }
 *     ]
 *   }
 */
export interface P5ExtendedConfirmationResult {
  /** 基础决策（仅基于 verdict + command 的原始决策，未考虑扩展数据源） */
  readonly baseDecision: P5ConfirmationDecision;
  /** 最终决策（综合扩展数据源后的决策，可能与 baseDecision 不同） */
  readonly finalDecision: P5ConfirmationDecision;
  /** 决策原因（人类可读，含基础决策与升级原因） */
  readonly reason: string;
  /** 风险等级（low / medium / high / critical） */
  readonly riskLevel: P5RiskLevel;
  /** 风险评分（0-100，黑名单命中固定 100） */
  readonly riskScore: number;
  /** 命中的模式字符串（未命中时为空字符串） */
  readonly matchedPattern: string;
  /** 触发的护栏规则 ID（来自 GuardVerdict，未触发时为空字符串） */
  readonly guardRuleId: string;
  /** 决策时间戳（ISO 8601 字符串） */
  readonly timestamp: string;
  /** 数据源贡献列表（按评估顺序，含每个数据源的 action 与证据） */
  readonly dataSourceContributions: ReadonlyArray<Readonly<P5DataSourceContribution>>;
}

// ============================================================================
// 3. 辅助函数
// ============================================================================

/**
 * 把风险分映射为风险等级
 *
 * 映射规则（与 team 版一致）：
 * - score <= 30 → low
 * - score <= 70 → medium
 * - score < 100 → high
 * - score === 100 → critical（黑名单命中）
 *
 * @param score 风险分（0-100）
 * @returns 风险等级
 */
export function p5ScoreToLevel(score: number): P5RiskLevel {
  if (score <= 30) return "low";
  if (score <= 70) return "medium";
  if (score < 100) return "high";
  return "critical";
}

/**
 * 生成 ISO 8601 时间戳
 *
 * @returns 当前时间的 ISO 8601 字符串（如 "2026-07-21T10:00:00.000Z"）
 */
function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================================
// 4. P5SmartConfirmation 类（核心实现）
// ============================================================================

/**
 * EAG-P5 SmartConfirmation 三态确认器
 *
 * 设计原则（对齐 Ponytail 决策梯 + Karpathy Simplicity First）：
 *   1. 黑名单优先（一旦命中 → 立即 fail-closed，不走风险评分）
 *   2. 白名单次之（命中 → auto-approve + LOW 风险）
 *   3. 风险评分兜底（基于命令特征计算 0-100 风险分）
 *   4. 保守策略：任何不确定 → ask-user
 *   5. GuardVerdict 优先级最高：DENY 短路 fail-closed，ASK 短路 ask-user
 *
 * 使用方式：
 * ```typescript
 * const confirmation = new P5SmartConfirmation();
 * const verdict: GuardVerdict = guardChain.executeSync(context).firstDenial ?? createPassVerdict("G-A2a");
 * const result = confirmation.decide(verdict, "npm test");
 * if (result.decision === "fail-closed") {
 *   throw new Error(`命令被拒绝：${result.reason}`);
 * }
 * ```
 */
export class P5SmartConfirmation {
  /** 黑名单正则字符串数组（不可变） */
  private readonly blacklist: ReadonlyArray<string>;
  /** 白名单正则字符串数组（不可变） */
  private readonly whitelist: ReadonlyArray<string>;
  /** auto-approve 阈值（风险分 <= 此值 → auto-approve） */
  private readonly autoThreshold: number;
  /** ask-user 阈值（风险分 <= 此值 → ask-user） */
  private readonly askThreshold: number;
  /** fail-closed 阈值（风险分 > 此值 → fail-closed） */
  private readonly denyThreshold: number;
  /** 预编译的黑名单正则数组（IGNORECASE） */
  private readonly blacklistRe: ReadonlyArray<RegExp>;
  /** 预编译的白名单正则数组（IGNORECASE） */
  private readonly whitelistRe: ReadonlyArray<RegExp>;
  /** 预编译的风险评分正则数组（[正则, 加分]） */
  private readonly riskRe: ReadonlyArray<Readonly<[RegExp, number]>>;
  /**
   * 历史决策存储实例（Phase 5.3 TASK-P5-5.3-001 新增）
   *
   * 由构造选项注入，用于 recordDecision() 方法持久化决策结果。
   * decideWithContext() 不使用此字段（通过 context.historyStore 传入），
   * 避免与上下文中的 historyStore 实例不一致。
   */
  private readonly historyStore: P5ConfirmationHistoryStore | undefined;

  /**
   * 构造 P5SmartConfirmation
   *
   * @param options 配置选项（所有字段可选）
   */
  constructor(options?: Readonly<P5SmartConfirmationOptions>) {
    // 优先级：自定义 > 默认（默认名单来自 command-safety.ts 单一真相源）
    this.blacklist = options?.blacklist ?? BUILTIN_BLACKLIST_REGEX;
    this.whitelist = options?.whitelist ?? BUILTIN_WHITELIST_REGEX;
    this.autoThreshold = clamp(options?.autoThreshold, 0, 100, DEFAULT_AUTO_THRESHOLD);
    this.askThreshold = clamp(options?.askThreshold, 0, 100, DEFAULT_ASK_THRESHOLD);
    this.denyThreshold = clamp(options?.denyThreshold, 0, 100, DEFAULT_DENY_THRESHOLD);

    // 风险评分规则（自定义 > 默认）
    const riskPatterns = options?.riskPatterns ?? RISK_PATTERNS;

    // 预编译正则（IGNORECASE，与 team 版一致）
    // 注意：RegExp 数组本身不可变（ReadonlyArray），但 RegExp 实例有内部状态（lastIndex）
    // 本场景下仅使用 test()（不使用 exec + g 标志），无 lastIndex 副作用
    this.blacklistRe = Object.freeze([...this.blacklist].map((p) => new RegExp(p, "i")));
    this.whitelistRe = Object.freeze([...this.whitelist].map((p) => new RegExp(p, "i")));
    this.riskRe = Object.freeze(
      [...riskPatterns].map(([p, score]) => Object.freeze([new RegExp(p, "i"), score] as const))
    );

    // Phase 5.3 TASK-P5-5.3-001：注入 historyStore（用于 recordDecision）
    this.historyStore = options?.historyStore;
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 决策入口：根据 GuardVerdict + 可选命令字符串输出三态决策
   *
   * 决策优先级（短路求值）：
   *   1. GuardVerdict.decision === "DENY" → fail-closed（系统级护栏已拒绝）
   *   2. GuardVerdict.decision === "ASK" → ask-user（系统级护栏要求确认）
   *   3. GuardVerdict.decision === "PASS":
   *      a. command 为空 → auto-approve（无命令需评估）
   *      b. 黑名单命中 → fail-closed（critical 风险）
   *      c. 白名单命中 → auto-approve（low 风险）
   *      d. 风险分 > denyThreshold → fail-closed（high 风险）
   *      e. 风险分 > askThreshold → ask-user（medium 风险）
   *      f. 风险分 <= autoThreshold → auto-approve（low 风险）
   *      g. 兜底 → ask-user（保守策略）
   *
   * @param verdict GuardVerdict（来自 BlockerGuardChain）
   * @param command 待评估的命令字符串（可选，无命令时仅基于 verdict 决策）
   * @returns 决策结果（不可变，Object.freeze 冻结）
   */
  decide(verdict: Readonly<GuardVerdict>, command?: string): Readonly<P5ConfirmationResult> {
    const timestamp = nowIso();

    // 1. GuardVerdict.decision === "DENY" → fail-closed（短路）
    if (verdict.decision === "DENY") {
      return Object.freeze({
        decision: "fail-closed",
        reason: `系统级护栏拒绝（规则 ${verdict.ruleId}）：${verdict.reason}`,
        riskLevel: "critical",
        riskScore: 100,
        matchedPattern: "",
        guardRuleId: verdict.ruleId,
        timestamp,
      });
    }

    // 2. GuardVerdict.decision === "ASK" → ask-user（短路）
    if (verdict.decision === "ASK") {
      return Object.freeze({
        decision: "ask-user",
        reason: `系统级护栏要求确认（规则 ${verdict.ruleId}）：${verdict.reason}`,
        riskLevel: "medium",
        riskScore: 50,
        matchedPattern: "",
        guardRuleId: verdict.ruleId,
        timestamp,
      });
    }

    // 3. GuardVerdict.decision === "PASS" → 命令级评估
    // 3.a command 为空 → auto-approve（无命令需评估）
    if (!command || !command.trim()) {
      return Object.freeze({
        decision: "auto-approve",
        reason: "无命令需评估（verdict=PASS & command 为空）",
        riskLevel: "low",
        riskScore: 0,
        matchedPattern: "",
        guardRuleId: verdict.ruleId,
        timestamp,
      });
    }

    const cmdStripped = command.trim();

    // 3.b 黑名单优先（一旦命中 → 立即 fail-closed）
    for (let i = 0; i < this.blacklistRe.length; i++) {
      const pattern = this.blacklistRe[i]!;
      if (pattern.test(cmdStripped)) {
        return Object.freeze({
          decision: "fail-closed",
          reason: `命令命中黑名单模式：${this.blacklist[i]}（永远禁止）`,
          riskLevel: "critical",
          riskScore: 100,
          matchedPattern: this.blacklist[i]!,
          guardRuleId: verdict.ruleId,
          timestamp,
        });
      }
    }

    // 3.c 白名单次之（命中 → auto-approve + LOW 风险）
    for (let i = 0; i < this.whitelistRe.length; i++) {
      const pattern = this.whitelistRe[i]!;
      if (pattern.test(cmdStripped)) {
        return Object.freeze({
          decision: "auto-approve",
          reason: `白名单操作：${this.whitelist[i]}`,
          riskLevel: "low",
          riskScore: 0,
          matchedPattern: this.whitelist[i]!,
          guardRuleId: verdict.ruleId,
          timestamp,
        });
      }
    }

    // 3.d-f 风险评分兜底
    const riskScore = this.calculateRisk(cmdStripped);
    const riskLevel = p5ScoreToLevel(riskScore);

    // 3.d 风险分 > denyThreshold → fail-closed（high 风险）
    if (riskScore > this.denyThreshold) {
      return Object.freeze({
        decision: "fail-closed",
        reason: `风险分 ${riskScore} 超过 deny 阈值 ${this.denyThreshold}，拒绝执行`,
        riskLevel,
        riskScore,
        matchedPattern: "",
        guardRuleId: verdict.ruleId,
        timestamp,
      });
    }

    // 3.e 风险分 > askThreshold → ask-user（medium 风险）
    if (riskScore > this.askThreshold) {
      return Object.freeze({
        decision: "ask-user",
        reason: `风险分 ${riskScore} 超过 ask 阈值 ${this.askThreshold}，需要用户确认`,
        riskLevel,
        riskScore,
        matchedPattern: "",
        guardRuleId: verdict.ruleId,
        timestamp,
      });
    }

    // 3.f 风险分 <= autoThreshold → auto-approve（low 风险）
    if (riskScore <= this.autoThreshold) {
      return Object.freeze({
        decision: "auto-approve",
        reason: `风险分 ${riskScore} 低于 auto 阈值 ${this.autoThreshold}，自动放行`,
        riskLevel,
        riskScore,
        matchedPattern: "",
        guardRuleId: verdict.ruleId,
        timestamp,
      });
    }

    // 3.g 兜底 → ask-user（保守策略：autoThreshold < score <= askThreshold）
    return Object.freeze({
      decision: "ask-user",
      reason: `风险分 ${riskScore} 介于 ${this.autoThreshold} 与 ${this.askThreshold} 之间，需要用户确认`,
      riskLevel,
      riskScore,
      matchedPattern: "",
      guardRuleId: verdict.ruleId,
      timestamp,
    });
  }

  /**
   * 批量决策：对多个 GuardVerdict + 命令对输出决策列表
   *
   * 单条失败不影响其他条目评估（每条独立决策）。
   * 任一 fail-closed → 调用方应整体拒绝执行。
   *
   * @param verdicts GuardVerdict 数组
   * @param commands 命令字符串数组（可选，长度应与 verdicts 一致）
   * @returns 决策结果数组（不可变）
   */
  decideBatch(
    verdicts: ReadonlyArray<Readonly<GuardVerdict>>,
    commands?: ReadonlyArray<string>
  ): ReadonlyArray<Readonly<P5ConfirmationResult>> {
    if (commands && commands.length !== verdicts.length) {
      throw new Error(`verdicts 与 commands 长度不匹配：verdicts=${verdicts.length} commands=${commands.length}`);
    }

    const results: P5ConfirmationResult[] = [];
    for (let i = 0; i < verdicts.length; i++) {
      const verdict = verdicts[i]!;
      const command = commands ? commands[i] : undefined;
      results.push(this.decide(verdict, command));
    }
    return Object.freeze(results);
  }

  /**
   * 快速判断命令是否破坏性（不返回完整结果）
   *
   * 等价于 decide(passVerdict, command).decision === "fail-closed"。
   * 用于 StageHandler 在执行命令前做轻量级预检。
   *
   * @param command 待评估的命令字符串
   * @returns true=破坏性（应拒绝）；false=非破坏性（可执行或需确认）
   */
  isDestructive(command: string): boolean {
    if (!command || !command.trim()) {
      return false;
    }
    const cmdStripped = command.trim();
    // 仅检查黑名单（不走风险评分，提高性能）
    for (let i = 0; i < this.blacklistRe.length; i++) {
      if (this.blacklistRe[i]!.test(cmdStripped)) {
        return true;
      }
    }
    // 检查高风险评分
    const riskScore = this.calculateRisk(cmdStripped);
    return riskScore > this.denyThreshold;
  }

  /**
   * 获取黑名单模式数量（用于测试断言与可观测性）
   *
   * @returns 黑名单正则数量
   */
  getBlacklistSize(): number {
    return this.blacklist.length;
  }

  /**
   * 获取白名单模式数量（用于测试断言与可观测性）
   *
   * @returns 白名单正则数量
   */
  getWhitelistSize(): number {
    return this.whitelist.length;
  }

  // ========================================================================
  // 扩展数据源 API（Phase 5.3 TASK-P5-5.3-001 新增）
  // ========================================================================

  /**
   * 扩展决策入口：综合多源数据输出三态决策（TASK-P5-5.3-001）
   *
   * 算法（对齐架构师审查 §4.5 SmartConfirmation 数据源扩展决议）：
   * 1. 调用原 decide(verdict, command) 获取基础决策（baseDecision）
   * 2. fail-closed 短路：基础决策已为 fail-closed → 直接返回（无需查询扩展数据源）
   * 3. 历史决策数据源（historyStore）：
   *    - 查询同一命令在历史中的决策模式（按 commandSubstring 过滤）
   *    - 曾被 fail-closed 拒绝 >= HISTORY_DENY_UPGRADE_THRESHOLD（1 次）→ 升级为 ask-user
   *    - 曾被 ask-user 确认 >= HISTORY_ASK_UPGRADE_THRESHOLD（3 次）→ 升级为 ask-user
   *    - 曾被 auto-approve 放行 >= HISTORY_AUTO_TRUST_THRESHOLD（5 次）→ 保持原决策（信任）
   * 4. 爆炸半径数据源（symbolGraphStore）：
   *    - 通过任务卡声明的符号查询 ImpactBFS.getExplosionRadius
   *    - 受影响符号数 > IMPACT_RADIUS_CRITICAL_THRESHOLD（100）→ 升级为 fail-closed
   *    - 受影响符号数 > IMPACT_RADIUS_UPGRADE_THRESHOLD（20）→ 升级为 ask-user
   * 5. 任务模式匹配数据源（taskCard）：
   *    - 任务卡声明的文件路径匹配 DANGEROUS_FILE_PATTERNS（.env/credentials 等）→ 升级为 ask-user
   *    - 命令字符串匹配 CLEANUP_KEYWORDS（cleanup/purge/reset 等）→ 升级为 ask-user
   * 6. 综合所有数据源贡献，输出最终决策（finalDecision）
   *
   * 决策升级规则（严格单调）：
   * - 任一数据源升级为 fail-closed → finalDecision = fail-closed（最高优先级）
   * - 任一数据源升级为 ask-user → finalDecision = ask-user（次高优先级）
   * - 全部数据源无升级或 keep → finalDecision = baseDecision（保持原决策）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - 返回的 P5ExtendedConfirmationResult 通过 Object.freeze 冻结
   * - dataSourceContributions 数组与每个 contribution 对象均冻结
   *
   * @param verdict GuardVerdict（来自 BlockerGuardChain）
   * @param context 扩展决策上下文（含历史存储/符号图谱/任务卡等数据源）
   * @returns 扩展决策结果（不可变，Object.freeze 冻结）
   */
  async decideWithContext(
    verdict: Readonly<GuardVerdict>,
    context: Readonly<P5SmartConfirmationContext>
  ): Promise<Readonly<P5ExtendedConfirmationResult>> {
    // 1. 校验上下文入参
    this.validateContext(context);

    const timestamp = nowIso();
    const command = context.command;

    // 2. 调用原 decide() 获取基础决策
    const baseResult = this.decide(verdict, command);
    const baseDecision = baseResult.decision;

    // 3. fail-closed 短路：基础决策已为 fail-closed → 直接返回
    //    无需查询扩展数据源（避免不必要的 I/O 开销）
    if (baseDecision === "fail-closed") {
      return Object.freeze({
        baseDecision,
        finalDecision: baseDecision,
        reason: baseResult.reason,
        riskLevel: baseResult.riskLevel,
        riskScore: baseResult.riskScore,
        matchedPattern: baseResult.matchedPattern,
        guardRuleId: baseResult.guardRuleId,
        timestamp,
        dataSourceContributions: Object.freeze([
          Object.freeze({
            source: "history" as const,
            action: "none" as const,
            reason: "基础决策已为 fail-closed，跳过扩展数据源评估",
            evidence: Object.freeze({}) as Readonly<Record<string, number | string | boolean>>,
          }),
        ]),
      });
    }

    // 4. 评估各数据源贡献
    const contributions: P5DataSourceContribution[] = [];
    // 显式声明为 P5ConfirmationDecision（三态联合类型），
    // 避免 TypeScript 基于初始赋值将 finalDecision 类型收窄为 "auto-approve" | "ask-user"，
    // 导致后续赋值 "fail-closed" 时报 TS2322 / 比较 "fail-closed" 时报 TS2367。
    let finalDecision: P5ConfirmationDecision = baseDecision;
    let upgradeReason = "";

    // 4a. 历史决策数据源
    const historyContribution = await this.evaluateHistorySource(context, command);
    contributions.push(historyContribution);
    // 注：finalDecision 显式断言为 P5ConfirmationDecision 以绕过 TS 的 CFA 类型收窄，
    // 此处的 !== "fail-closed" 检查为防御性编程（保留升级单调性校验），
    // 避免 TS 基于初始赋值将 finalDecision 收窄为 "auto-approve" | "ask-user" 后报 TS2367。
    if (
      historyContribution.action === "upgrade-to-fail-closed" &&
      (finalDecision as P5ConfirmationDecision) !== "fail-closed"
    ) {
      finalDecision = "fail-closed";
      upgradeReason = historyContribution.reason;
    } else if (historyContribution.action === "upgrade-to-ask-user" && finalDecision === "auto-approve") {
      finalDecision = "ask-user";
      upgradeReason = historyContribution.reason;
    }

    // 4b. 爆炸半径数据源（仅当 finalDecision 未被升级为 fail-closed 时评估）
    if ((finalDecision as P5ConfirmationDecision) !== "fail-closed") {
      const impactContribution = this.evaluateImpactRadiusSource(context);
      contributions.push(impactContribution);
      if (
        impactContribution.action === "upgrade-to-fail-closed" &&
        (finalDecision as P5ConfirmationDecision) !== "fail-closed"
      ) {
        finalDecision = "fail-closed";
        upgradeReason = impactContribution.reason;
      } else if (impactContribution.action === "upgrade-to-ask-user" && finalDecision === "auto-approve") {
        finalDecision = "ask-user";
        upgradeReason = impactContribution.reason;
      }
    }

    // 4c. 任务模式匹配数据源（仅当 finalDecision 未被升级为 fail-closed 时评估）
    if ((finalDecision as P5ConfirmationDecision) !== "fail-closed") {
      const taskPatternContribution = this.evaluateTaskPatternSource(context, command);
      contributions.push(taskPatternContribution);
      if (
        taskPatternContribution.action === "upgrade-to-fail-closed" &&
        (finalDecision as P5ConfirmationDecision) !== "fail-closed"
      ) {
        finalDecision = "fail-closed";
        upgradeReason = taskPatternContribution.reason;
      } else if (taskPatternContribution.action === "upgrade-to-ask-user" && finalDecision === "auto-approve") {
        finalDecision = "ask-user";
        upgradeReason = taskPatternContribution.reason;
      }
    }

    // 5. 构造最终原因文本
    const finalReason =
      finalDecision === baseDecision
        ? baseResult.reason
        : `基础决策 ${baseDecision} 被扩展数据源升级为 ${finalDecision}：${upgradeReason}`;

    // 6. 返回冻结的扩展决策结果
    return Object.freeze({
      baseDecision,
      finalDecision,
      reason: finalReason,
      riskLevel: baseResult.riskLevel,
      riskScore: baseResult.riskScore,
      matchedPattern: baseResult.matchedPattern,
      guardRuleId: baseResult.guardRuleId,
      timestamp,
      dataSourceContributions: Object.freeze(contributions.map((c) => Object.freeze(c))),
    });
  }

  /**
   * 记录决策到历史存储（TASK-P5-5.3-001）
   *
   * 委托给 context.historyStore.record()，将 SmartConfirmation 决策结果
   * 持久化到 JSONL 文件，供未来 decideWithContext() 查询。
   *
   * 算法：
   * 1. 校验入参（projectRoot + entry 必填字段）
   * 2. 委托 historyStore.record(projectRoot, entry)
   * 3. historyStore 内部完成原子写入 + 缓存失效
   *
   * @param projectRoot 项目根目录
   * @param entry 决策记录条目
   * @throws Error historyStore 未注入时抛出
   * @throws P5ConfirmationHistoryStoreError I/O 失败 / 入参非法
   */
  async recordDecision(projectRoot: string, entry: Readonly<P5ConfirmationHistoryEntry>): Promise<void> {
    // 此处复用入参 context 中的 historyStore；
    // 由于 recordDecision 通常在 decideWithContext 之后调用，
    // 调用方需保证传入的 historyStore 与 decideWithContext 一致。
    // 为简化 API，recordDecision 不依赖 context，直接委托给传入的 historyStore。
    // 调用方需在调用 recordDecision 前自行构造 P5ConfirmationHistoryEntry。
    if (!this.historyStore) {
      throw new Error(
        "P5SmartConfirmation.recordDecision 失败：historyStore 未注入（请在构造时通过 options.historyStore 提供）"
      );
    }
    await this.historyStore.record(projectRoot, entry);
  }

  // ========================================================================
  // 扩展数据源评估私有方法（TASK-P5-5.3-001 新增）
  // ========================================================================

  /**
   * 评估历史决策数据源
   *
   * 算法：
   * 1. historyStore 未注入 → 返回 none 贡献
   * 2. 查询历史中同一命令的决策记录（commandSubstring 过滤）
   * 3. 统计各决策类型的次数：
   *    - denyCount：fail-closed 次数
   *    - askCount：ask-user 次数
   *    - autoApproveCount：auto-approve 次数
   * 4. 升级判定（保守策略，任一命中即升级）：
   *    - denyCount >= HISTORY_DENY_UPGRADE_THRESHOLD（1）→ upgrade-to-ask-user
   *    - askCount >= HISTORY_ASK_UPGRADE_THRESHOLD（3）→ upgrade-to-ask-user
   *    - autoApproveCount >= HISTORY_AUTO_TRUST_THRESHOLD（5）→ keep（信任历史模式）
   *
   * @param context 决策上下文
   * @param command 待评估的命令字符串
   * @returns 历史数据源贡献记录
   */
  private async evaluateHistorySource(
    context: Readonly<P5SmartConfirmationContext>,
    command: string | undefined
  ): Promise<P5DataSourceContribution> {
    // historyStore 未注入 → 返回 none 贡献
    if (!context.historyStore) {
      return Object.freeze({
        source: "history" as const,
        action: "none" as const,
        reason: "historyStore 未注入，跳过历史数据源评估",
        evidence: Object.freeze({}) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 无命令字符串 → 无法按 commandSubstring 查询，返回 none 贡献
    if (!command || !command.trim()) {
      return Object.freeze({
        source: "history" as const,
        action: "none" as const,
        reason: "command 为空，跳过历史数据源评估",
        evidence: Object.freeze({}) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 查询历史中同一命令的决策记录
    let entries: ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>;
    try {
      entries = await context.historyStore.query(context.projectRoot, {
        commandSubstring: command,
        limit: 1000,
      });
    } catch (err) {
      // 查询失败 → 返回 none 贡献（不阻断决策流程）
      return Object.freeze({
        source: "history" as const,
        action: "none" as const,
        reason: `历史数据源查询失败：${(err as Error).message}（保守跳过）`,
        evidence: Object.freeze({
          error: (err as Error).message,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 统计各决策类型的次数
    let denyCount = 0;
    let askCount = 0;
    let autoApproveCount = 0;
    for (const entry of entries) {
      if (entry.decision === "fail-closed") {
        denyCount += 1;
      } else if (entry.decision === "ask-user") {
        askCount += 1;
      } else if (entry.decision === "auto-approve") {
        autoApproveCount += 1;
      }
    }

    // 升级判定（保守策略）
    // 优先级：deny 升级 > ask 升级 > auto 信任
    if (denyCount >= HISTORY_DENY_UPGRADE_THRESHOLD) {
      return Object.freeze({
        source: "history" as const,
        action: "upgrade-to-ask-user" as const,
        reason: `历史中曾有 ${denyCount} 次 fail-closed 拒绝记录（达到阈值 ${HISTORY_DENY_UPGRADE_THRESHOLD}），升级为 ask-user`,
        evidence: Object.freeze({
          denyCount,
          askCount,
          autoApproveCount,
          totalEntries: entries.length,
          denyThreshold: HISTORY_DENY_UPGRADE_THRESHOLD,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    if (askCount >= HISTORY_ASK_UPGRADE_THRESHOLD) {
      return Object.freeze({
        source: "history" as const,
        action: "upgrade-to-ask-user" as const,
        reason: `历史中曾有 ${askCount} 次 ask-user 确认记录（达到阈值 ${HISTORY_ASK_UPGRADE_THRESHOLD}），升级为 ask-user`,
        evidence: Object.freeze({
          denyCount,
          askCount,
          autoApproveCount,
          totalEntries: entries.length,
          askThreshold: HISTORY_ASK_UPGRADE_THRESHOLD,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    if (autoApproveCount >= HISTORY_AUTO_TRUST_THRESHOLD) {
      return Object.freeze({
        source: "history" as const,
        action: "keep" as const,
        reason: `历史中曾有 ${autoApproveCount} 次 auto-approve 放行记录（达到阈值 ${HISTORY_AUTO_TRUST_THRESHOLD}），信任历史模式保持原决策`,
        evidence: Object.freeze({
          denyCount,
          askCount,
          autoApproveCount,
          totalEntries: entries.length,
          autoTrustThreshold: HISTORY_AUTO_TRUST_THRESHOLD,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 无升级触发
    return Object.freeze({
      source: "history" as const,
      action: "none" as const,
      reason: `历史记录不足（deny=${denyCount} ask=${askCount} auto=${autoApproveCount}），无升级触发`,
      evidence: Object.freeze({
        denyCount,
        askCount,
        autoApproveCount,
        totalEntries: entries.length,
      }) as Readonly<Record<string, number | string | boolean>>,
    });
  }

  /**
   * 评估爆炸半径数据源
   *
   * 算法：
   * 1. symbolGraphStore 未注入 → 返回 none 贡献
   * 2. 任务卡未提供或 declaredSymbols 为空 → 返回 none 贡献
   * 3. 调用 symbolGraphStore.getExplosionRadius(declaredSymbols)
   * 4. 升级判定：
   *    - 受影响符号数 > IMPACT_RADIUS_CRITICAL_THRESHOLD（100）→ upgrade-to-fail-closed
   *    - 受影响符号数 > IMPACT_RADIUS_UPGRADE_THRESHOLD（20）→ upgrade-to-ask-user
   *
   * @param context 决策上下文
   * @returns 爆炸半径数据源贡献记录
   */
  private evaluateImpactRadiusSource(context: Readonly<P5SmartConfirmationContext>): P5DataSourceContribution {
    // symbolGraphStore 未注入 → 返回 none 贡献
    if (!context.symbolGraphStore) {
      return Object.freeze({
        source: "impact-radius" as const,
        action: "none" as const,
        reason: "symbolGraphStore 未注入，跳过爆炸半径数据源评估",
        evidence: Object.freeze({}) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 任务卡未提供或 declaredSymbols 为空 → 返回 none 贡献
    if (!context.taskCard || context.taskCard.declaredSymbols.length === 0) {
      return Object.freeze({
        source: "impact-radius" as const,
        action: "none" as const,
        reason: "taskCard 未提供或 declaredSymbols 为空，跳过爆炸半径数据源评估",
        evidence: Object.freeze({
          declaredSymbolsCount: context.taskCard?.declaredSymbols.length ?? 0,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 调用 symbolGraphStore.getExplosionRadius 计算爆炸半径
    let impactedCount = 0;
    let queryError: string | null = null;
    try {
      const impact = context.symbolGraphStore.getExplosionRadius(context.taskCard.declaredSymbols);
      impactedCount = impact.impactedSymbolIds.length;
    } catch (err) {
      // 查询失败 → 返回 none 贡献（不阻断决策流程）
      queryError = (err as Error).message;
      return Object.freeze({
        source: "impact-radius" as const,
        action: "none" as const,
        reason: `爆炸半径查询失败：${queryError}（保守跳过）`,
        evidence: Object.freeze({
          error: queryError,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 升级判定（严格优先级：critical > upgrade）
    if (impactedCount > IMPACT_RADIUS_CRITICAL_THRESHOLD) {
      return Object.freeze({
        source: "impact-radius" as const,
        action: "upgrade-to-fail-closed" as const,
        reason: `爆炸半径受影响符号数 ${impactedCount} 超过严重阈值 ${IMPACT_RADIUS_CRITICAL_THRESHOLD}，升级为 fail-closed`,
        evidence: Object.freeze({
          impactedCount,
          criticalThreshold: IMPACT_RADIUS_CRITICAL_THRESHOLD,
          upgradeThreshold: IMPACT_RADIUS_UPGRADE_THRESHOLD,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    if (impactedCount > IMPACT_RADIUS_UPGRADE_THRESHOLD) {
      return Object.freeze({
        source: "impact-radius" as const,
        action: "upgrade-to-ask-user" as const,
        reason: `爆炸半径受影响符号数 ${impactedCount} 超过升级阈值 ${IMPACT_RADIUS_UPGRADE_THRESHOLD}，升级为 ask-user`,
        evidence: Object.freeze({
          impactedCount,
          criticalThreshold: IMPACT_RADIUS_CRITICAL_THRESHOLD,
          upgradeThreshold: IMPACT_RADIUS_UPGRADE_THRESHOLD,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 无升级触发
    return Object.freeze({
      source: "impact-radius" as const,
      action: "none" as const,
      reason: `爆炸半径受影响符号数 ${impactedCount} 未超过阈值 ${IMPACT_RADIUS_UPGRADE_THRESHOLD}，无升级触发`,
      evidence: Object.freeze({
        impactedCount,
        upgradeThreshold: IMPACT_RADIUS_UPGRADE_THRESHOLD,
        criticalThreshold: IMPACT_RADIUS_CRITICAL_THRESHOLD,
      }) as Readonly<Record<string, number | string | boolean>>,
    });
  }

  /**
   * 评估任务模式匹配数据源
   *
   * 算法：
   * 1. 任务卡未提供或 declaredFiles 为空 + 命令为空 → 返回 none 贡献
   * 2. 危险文件路径匹配：
   *    - 遍历 taskCard.declaredFiles，匹配 DANGEROUS_FILE_PATTERNS
   *    - 任一命中 → upgrade-to-ask-user
   * 3. 清理类命令关键词匹配：
   *    - 遍历 CLEANUP_KEYWORDS，检查 command 是否包含关键词
   *    - 任一命中 → upgrade-to-ask-user
   *
   * @param context 决策上下文
   * @param command 待评估的命令字符串
   * @returns 任务模式匹配数据源贡献记录
   */
  private evaluateTaskPatternSource(
    context: Readonly<P5SmartConfirmationContext>,
    command: string | undefined
  ): P5DataSourceContribution {
    // 任务卡未提供 → 返回 none 贡献
    if (!context.taskCard) {
      return Object.freeze({
        source: "task-pattern" as const,
        action: "none" as const,
        reason: "taskCard 未提供，跳过任务模式匹配数据源评估",
        evidence: Object.freeze({}) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 危险文件路径匹配
    const declaredFiles = context.taskCard.declaredFiles;
    const matchedDangerousFiles: string[] = [];
    for (const file of declaredFiles) {
      for (const pattern of DANGEROUS_FILE_PATTERNS) {
        if (pattern.test(file)) {
          matchedDangerousFiles.push(file);
          break; // 单个文件只记录一次命中
        }
      }
    }

    if (matchedDangerousFiles.length > 0) {
      return Object.freeze({
        source: "task-pattern" as const,
        action: "upgrade-to-ask-user" as const,
        reason: `任务卡声明的文件路径命中危险模式（${matchedDangerousFiles.length} 个文件）：${matchedDangerousFiles.slice(0, 3).join(", ")}${matchedDangerousFiles.length > 3 ? "..." : ""}`,
        evidence: Object.freeze({
          matchedCount: matchedDangerousFiles.length,
          matchedFiles: matchedDangerousFiles.slice(0, 5).join(";"),
          declaredFilesCount: declaredFiles.length,
        }) as Readonly<Record<string, number | string | boolean>>,
      });
    }

    // 清理类命令关键词匹配
    if (command && command.trim()) {
      const cmdLower = command.toLowerCase();
      const matchedKeywords: string[] = [];
      for (const keyword of CLEANUP_KEYWORDS) {
        if (cmdLower.includes(keyword.toLowerCase())) {
          matchedKeywords.push(keyword);
        }
      }

      if (matchedKeywords.length > 0) {
        return Object.freeze({
          source: "task-pattern" as const,
          action: "upgrade-to-ask-user" as const,
          reason: `命令字符串命中清理类关键词（${matchedKeywords.length} 个）：${matchedKeywords.join(", ")}`,
          evidence: Object.freeze({
            matchedCount: matchedKeywords.length,
            matchedKeywords: matchedKeywords.join(";"),
          }) as Readonly<Record<string, number | string | boolean>>,
        });
      }
    }

    // 无升级触发
    return Object.freeze({
      source: "task-pattern" as const,
      action: "none" as const,
      reason: `任务模式匹配无命中（declaredFiles=${declaredFiles.length} command=${command ? "非空" : "空"}）`,
      evidence: Object.freeze({
        declaredFilesCount: declaredFiles.length,
        hasCommand: !!command,
      }) as Readonly<Record<string, number | string | boolean>>,
    });
  }

  /**
   * 校验扩展决策上下文入参
   *
   * @param context 决策上下文
   * @throws Error runId / projectRoot 缺失时抛出
   */
  private validateContext(context: Readonly<P5SmartConfirmationContext>): void {
    if (!context || typeof context !== "object") {
      throw new Error("P5SmartConfirmationContext 必须为对象");
    }
    if (typeof context.runId !== "string" || context.runId.trim().length === 0) {
      throw new Error("P5SmartConfirmationContext.runId 必须为非空字符串");
    }
    if (typeof context.projectRoot !== "string" || context.projectRoot.trim().length === 0) {
      throw new Error("P5SmartConfirmationContext.projectRoot 必须为非空字符串");
    }
    if (typeof context.iterIndex !== "number" || context.iterIndex < 0) {
      throw new Error("P5SmartConfirmationContext.iterIndex 必须为非负整数");
    }
    if (context.stage !== "plan" && context.stage !== "dev" && context.stage !== "verify" && context.stage !== "fix") {
      throw new Error(`P5SmartConfirmationContext.stage 非法：${context.stage}（合法值：plan/dev/verify/fix）`);
    }
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 计算命令的风险分（0-100）
   *
   * 算法：遍历 RISK_PATTERNS，命中即累加，最终 Math.min(100, score)。
   *
   * @param command 待评估的命令字符串
   * @returns 风险分（0-100）
   */
  private calculateRisk(command: string): number {
    let score = 0;
    for (let i = 0; i < this.riskRe.length; i++) {
      const [pattern, weight] = this.riskRe[i]!;
      if (pattern.test(command)) {
        score += weight;
      }
    }
    return Math.min(100, score);
  }
}

// ============================================================================
// 5. 工具函数
// ============================================================================

/**
 * 数值钳制（限制在 [min, max] 区间内）
 *
 * @param value 待钳制的值
 * @param min 最小值
 * @param max 最大值
 * @param defaultValue 值为 undefined 时的默认值
 * @returns 钳制后的值
 */
function clamp(value: number | undefined, min: number, max: number, defaultValue: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, value));
}

/**
 * 工厂函数：创建默认 P5SmartConfirmation 实例
 *
 * 使用默认黑/白名单（来自 command-safety.ts 单一真相源）与默认阈值。
 *
 * @param options 配置选项（可选，覆盖默认值）
 * @returns P5SmartConfirmation 实例
 */
export function createDefaultP5SmartConfirmation(options?: Readonly<P5SmartConfirmationOptions>): P5SmartConfirmation {
  return new P5SmartConfirmation(options);
}
