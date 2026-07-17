/**
 * Ralph 风格智能确认跳过（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/smart_confirmation.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Goal-Driven Execution - 三态决策 AUTO/ASK/DENY
 * Ponytail 红线：黑名单命中立即 DENY，不走风险评分
 *
 * 真实实现能力：
 *   1. 黑名单：明确禁止（rm -rf /、git push --force、drop database 等）
 *   2. 白名单：明确允许（测试、lint、状态检查等）
 *   3. 风险评分：基于命令特征计算 0-100 风险分
 *   4. 三态决策：AUTO / ASK / DENY
 *   5. 大小写不敏感（IGNORECASE 预编译）
 *   6. 自定义黑白名单可覆盖默认
 */

// V2.3 P1-03 修复：黑名单/白名单数据单一事实源。
// 名单数据集中维护于 v2/approval/command-safety.ts（全库唯一存放位置），
// 本文件不再自行定义 DEFAULT_BLACKLIST / DEFAULT_WHITELIST，改为 import 引用。
// 说明：V1 使用 IGNORECASE 正则匹配引擎（覆盖面更大，含数据库/系统命令），
// V2 CommandSafety 使用词边界精确匹配引擎（避免 maintenance 被 main 误伤），
// 两者匹配语义不同，故数据源同处、格式各表（regex vs plain），
// 职责分工详见技术方案 §9.3 职责分工矩阵。
import { BUILTIN_BLACKLIST_REGEX, BUILTIN_WHITELIST_REGEX } from "../../v2/approval/command-safety";

// ============================================================================
// 第一部分：类型定义
// ============================================================================

/** 风险等级 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** 确认决策三态 */
export type ConfirmationDecision = "auto" | "ask" | "deny";

/** 确认决策结果 */
export interface ConfirmationResult {
  decision: ConfirmationDecision;
  reason: string;
  riskLevel: RiskLevel;
  riskScore: number;
  matchedPattern: string;
}

/**
 * 把风险分映射为风险等级
 *
 * 0-30 → LOW，31-70 → MEDIUM，>=71 → HIGH
 */
export function scoreToLevel(score: number): RiskLevel {
  if (score <= 30) return "low";
  if (score <= 70) return "medium";
  return "high";
}

// ============================================================================
// 第二部分：默认黑/白名单 + 风险评分规则
// ============================================================================
//
// V2.3 P1-03：默认黑/白名单已迁移至 v2/approval/command-safety.ts
// （BUILTIN_BLACKLIST_REGEX / BUILTIN_WHITELIST_REGEX，见文件头 import），
// 本文件仅保留 V1 特有的风险评分规则（RISK_PATTERNS 属于评分逻辑而非名单数据，
// 按技术方案 §9.3 职责分工矩阵留在 V1 侧维护）。
// ============================================================================

/** 风险加分项（每个匹配 +N 分） */
const RISK_PATTERNS: ReadonlyArray<[string, number]> = [
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
];

// ============================================================================
// 第三部分：SmartConfirmation 类
// ============================================================================

/**
 * Ralph 风格智能确认
 *
 * 设计原则：
 *   1. 黑名单优先（一旦命中 → 立即 DENY）
 *   2. 白名单次之（命中 → AUTO + LOW 风险）
 *   3. 风险评分兜底（基于命令特征）
 *   4. 保守策略：任何不确定 → ASK
 */
export class SmartConfirmation {
  private readonly blacklist: ReadonlyArray<string>;
  private readonly whitelist: ReadonlyArray<string>;
  private readonly autoThreshold: number;
  /** 预编译的黑名单正则（IGNORECASE） */
  private readonly blacklistRe: RegExp[];
  /** 预编译的白名单正则（IGNORECASE） */
  private readonly whitelistRe: RegExp[];
  /** 预编译的风险评分正则 */
  private readonly riskRe: Array<[RegExp, number]>;

  constructor(args?: { blacklist?: ReadonlyArray<string>; whitelist?: ReadonlyArray<string>; autoThreshold?: number }) {
    // 优先级：自定义 > 默认（默认名单来自 command-safety.ts 单一事实源）
    this.blacklist = args?.blacklist ?? BUILTIN_BLACKLIST_REGEX;
    this.whitelist = args?.whitelist ?? BUILTIN_WHITELIST_REGEX;
    this.autoThreshold = Math.max(0, Math.min(100, args?.autoThreshold ?? 0));
    // 预编译正则（IGNORECASE）
    this.blacklistRe = this.blacklist.map((p) => new RegExp(p, "i"));
    this.whitelistRe = this.whitelist.map((p) => new RegExp(p, "i"));
    this.riskRe = RISK_PATTERNS.map(([p, score]) => [new RegExp(p, "i"), score] as [RegExp, number]);
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 检查命令，决定是否自动确认
   *
   * @param command 完整命令字符串
   */
  check(command: string): ConfirmationResult {
    if (!command || !command.trim()) {
      return {
        decision: "deny",
        reason: "空命令",
        riskLevel: "low",
        riskScore: 0,
        matchedPattern: "",
      };
    }
    const cmdStripped = command.trim();
    // 1. 黑名单优先
    for (let i = 0; i < this.blacklistRe.length; i++) {
      const pattern = this.blacklistRe[i]!;
      if (pattern.test(cmdStripped)) {
        return {
          decision: "deny",
          reason: `命令命中黑名单模式：${this.blacklist[i]}（永远禁止）`,
          riskLevel: "critical",
          riskScore: 100,
          matchedPattern: this.blacklist[i]!,
        };
      }
    }
    // 2. 白名单 → AUTO
    for (let i = 0; i < this.whitelistRe.length; i++) {
      const pattern = this.whitelistRe[i]!;
      if (pattern.test(cmdStripped)) {
        return {
          decision: "auto",
          reason: `白名单操作：${this.whitelist[i]}`,
          riskLevel: "low",
          riskScore: 0,
          matchedPattern: this.whitelist[i]!,
        };
      }
    }
    // 3. 风险评分
    const riskScore = this.calculateRisk(cmdStripped);
    if (riskScore <= this.autoThreshold) {
      return {
        decision: "auto",
        reason: `风险分 ${riskScore} 低于阈值 ${this.autoThreshold}`,
        riskLevel: scoreToLevel(riskScore),
        riskScore,
        matchedPattern: "",
      };
    }
    if (riskScore >= 71) {
      return {
        decision: "ask",
        reason: `风险分 ${riskScore} >= 71，需要用户确认`,
        riskLevel: "high",
        riskScore,
        matchedPattern: "",
      };
    }
    // 中等风险：默认 ASK（保守）
    return {
      decision: "ask",
      reason: `风险分 ${riskScore} 中等，需要用户确认`,
      riskLevel: "medium",
      riskScore,
      matchedPattern: "",
    };
  }

  /**
   * 批量检查多个命令
   */
  checkBatch(commands: string[]): ConfirmationResult[] {
    return commands.map((cmd) => this.check(cmd));
  }

  /**
   * 快速判断命令是否破坏性（不返回完整结果）
   */
  isDestructive(command: string): boolean {
    const result = this.check(command);
    return result.decision === "deny";
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 计算风险分（0-100）
   */
  private calculateRisk(command: string): number {
    let score = 0;
    for (const [pattern, weight] of this.riskRe) {
      if (pattern.test(command)) {
        score += weight;
      }
    }
    return Math.min(100, score);
  }
}
