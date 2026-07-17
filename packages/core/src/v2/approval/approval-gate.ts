/**
 * 审批门控（ApprovalGate）
 *
 * 根据审批模式（ApprovalMode）、应用模式（AppMode）、命令安全评估
 * 做出工具执行前的三态决策：auto_approve / ask_user / deny。
 *
 * 决策流程（F-07 安全修复：黑名单优先于所有审批模式判断）：
 *
 *   1. 【最高优先级】黑名单检查（仅 bash 工具）
 *      - CommandSafety.isBlacklisted(command) → deny（无论 ApprovalMode）
 *      - 风险评分 ≥ 91 → deny（无论 ApprovalMode，destructive 级别）
 *
 *   2. AppMode == "plan"（计划模式，非只读一律拒绝，即使 ApprovalMode=auto）
 *      - 只读工具 → auto_approve
 *      - 非只读工具 → deny
 *
 *   3. ApprovalMode == "never"（从不模式）
 *      - 只读工具 → auto_approve
 *      - 非只读工具 → deny
 *
 *   4. ApprovalMode == "auto"（自动模式）
 *      - → auto_approve（创建快照，snapshotRequired=true）
 *
 *   5. ApprovalMode == "suggest"（建议模式，细分决策）
 *      a. 只读工具 → auto_approve
 *      b. bash 工具 → decideBashCommand：
 *         - 白名单命令 → auto_approve
 *         - 风险 benign → auto_approve
 *         - 风险 caution → ask_user
 *         - 风险 destructive → deny（防御性，正常已被步骤 1 拦截）
 *      c. file_write / file_edit → decideFileWrite：
 *         - 敏感路径 → deny
 *         - 其他 → ask_user
 *      d. network / mcp → ask_user
 *
 *   6. 默认 → ask_user
 *
 * 关键安全保证（F-07 修复）：
 * - 黑名单检查在所有模式判断之前，确保 YOLO+Auto+黑名单命令也被拒绝
 * - Plan 模式在 Auto 模式之前判断，确保 Plan+Auto+写操作也被拒绝
 *
 * 设计依据：
 * - V2.1 技术方案 §4.2.4 决策流程
 * - V2.1 评审修复 F-07：黑名单检查必须先于 ApprovalMode 判断
 * - V2.3 修复计划 P1-03：单一事实源
 */

import { CommandSafety } from "./command-safety";
import type { ApprovalContext, ApprovalResult, AppMode, ToolCategory } from "./types";

/**
 * 敏感文件路径前缀列表：file_write/file_edit 时命中即 deny
 *
 * 包含系统配置、密钥、凭据等不可随意修改的路径，
 * 防止误操作破坏系统安全或泄露密钥。
 */
const SENSITIVE_PATH_PATTERNS: string[] = [
  "/etc/", // 系统配置目录
  "/etc/passwd", // 用户账户
  "/etc/shadow", // 密码哈希
  "/etc/sudoers", // sudo 配置
  ".ssh/", // SSH 密钥目录
  "authorized_keys", // SSH 授权密钥
  ".env", // 环境变量（可能含密钥）
  ".aws/", // AWS 凭据
  ".gnupg/", // GPG 密钥
  "/boot/", // 启动文件
  "/sys/", // 内核 sysfs
  "/proc/", // 进程信息
];

/**
 * 审批门控
 *
 * 封装完整的工具执行审批决策逻辑，是 V2 工具执行流程的"守门员"。
 * 所有工具执行前必须调用 decide() 获取决策结果，根据 decision 决定后续行为。
 *
 * 用法：
 * ```typescript
 * const gate = new ApprovalGate();
 * const result = gate.decide({
 *   toolName: "bash",
 *   toolCategory: "bash",
 *   command: "rm -rf /tmp/old",
 *   appMode: "agent",
 *   approvalMode: "suggest",
 * });
 * if (result.decision === "deny") {
 *   throw new Error(`命令被拒绝：${result.reason}`);
 * }
 * ```
 */
export class ApprovalGate {
  /** 命令安全检查器实例（黑名单/白名单/风险评分） */
  private commandSafety: CommandSafety;

  /**
   * 构造审批门控
   *
   * @param commandSafety 可选的命令安全检查器实例（用于依赖注入，便于测试）。
   *                      未提供时使用默认的 CommandSafety（内置黑名单/白名单）。
   */
  constructor(commandSafety?: CommandSafety) {
    this.commandSafety = commandSafety ?? new CommandSafety();
  }

  /**
   * 对工具执行进行审批决策
   *
   * 严格按 F-07 决策流程执行：黑名单检查 → Plan 模式 → never 模式 →
   * auto 模式 → suggest 模式细分 → 默认 ask_user。
   *
   * @param context 审批上下文（工具信息 + 模式 + 命令/路径）
   * @returns 审批结果（决策 + 原因 + 风险评估 + 快照标志）
   */
  decide(context: ApprovalContext): ApprovalResult {
    // 步骤 1：黑名单检查（最高优先级，F-07 安全修复）
    // 仅 bash 工具有命令，其他工具跳过此步
    if (context.toolCategory === "bash" && context.command) {
      const blacklistResult = this.checkBlacklist(context.command);
      if (blacklistResult) {
        return blacklistResult;
      }
    }

    // 步骤 2：Plan 模式检查（在所有 ApprovalMode 判断之前）
    // Plan 模式下，非只读工具一律拒绝（即使 ApprovalMode=auto）
    if (context.appMode === "plan") {
      if (this.isReadonlyTool(context.toolCategory)) {
        return {
          decision: "auto_approve",
          reason: "plan 模式下只读工具自动批准",
          snapshotRequired: false,
        };
      }
      return {
        decision: "deny",
        reason: "plan 模式下非只读工具拒绝执行（即使 ApprovalMode=auto）",
        snapshotRequired: false,
      };
    }

    // 步骤 3：ApprovalMode == "never"（从不模式）
    if (context.approvalMode === "never") {
      if (this.isReadonlyTool(context.toolCategory)) {
        return {
          decision: "auto_approve",
          reason: "never 模式下只读工具自动批准",
          snapshotRequired: false,
        };
      }
      return {
        decision: "deny",
        reason: "never 模式下非只读工具拒绝执行",
        snapshotRequired: false,
      };
    }

    // 步骤 4：ApprovalMode == "auto"（自动模式）
    // 非黑名单命令自动批准，但仍创建快照以支持回滚
    if (context.approvalMode === "auto") {
      return {
        decision: "auto_approve",
        reason: "auto 模式自动批准（创建快照以支持回滚）",
        snapshotRequired: true,
      };
    }

    // 步骤 5：ApprovalMode == "suggest"（建议模式，细分决策）
    if (context.approvalMode === "suggest") {
      return this.decideSuggest(context);
    }

    // 步骤 6：默认 ask_user（未知的 ApprovalMode，保守询问）
    return {
      decision: "ask_user",
      reason: "未知的审批模式，需用户确认",
      snapshotRequired: false,
    };
  }

  /**
   * 检查命令是否命中黑名单或风险评分 >= 91
   *
   * 这是 F-07 安全修复的核心：在所有 ApprovalMode 判断之前执行，
   * 确保黑名单命令和破坏性命令在任何模式下都被拒绝。
   *
   * @param command bash 命令字符串
   * @returns 命中时返回 deny 结果，未命中返回 null
   */
  private checkBlacklist(command: string): ApprovalResult | null {
    // 黑名单检查：命中即拒绝，无论 ApprovalMode
    if (this.commandSafety.isBlacklisted(command)) {
      return {
        decision: "deny",
        reason: "命令在黑名单中，拒绝执行（黑名单优先于所有审批模式）",
        riskAssessment: this.commandSafety.assessRisk(command),
        snapshotRequired: false,
      };
    }

    // 风险评分检查：评分 >= 91（destructive 级别）即拒绝
    const assessment = this.commandSafety.assessRisk(command);
    if (assessment.score >= 91) {
      return {
        decision: "deny",
        reason: `风险评分 ${assessment.score}（destructive），拒绝执行`,
        riskAssessment: assessment,
        snapshotRequired: false,
      };
    }

    // 未命中黑名单且评分 < 91，继续后续流程
    return null;
  }

  /**
   * suggest 模式下的细分决策
   *
   * 根据工具类型分流：
   * - 只读工具 → auto_approve
   * - bash 工具 → decideBashCommand（白名单/风险分类）
   * - file_write/file_edit → decideFileWrite（敏感路径检查）
   * - network/mcp → ask_user
   *
   * @param context 审批上下文
   * @returns 审批结果
   */
  private decideSuggest(context: ApprovalContext): ApprovalResult {
    // 5a：只读工具自动批准
    if (this.isReadonlyTool(context.toolCategory)) {
      return {
        decision: "auto_approve",
        reason: "suggest 模式下只读工具自动批准",
        snapshotRequired: false,
      };
    }

    // 5b：bash 工具，根据命令风险分类决策
    if (context.toolCategory === "bash" && context.command) {
      return this.decideBashCommand(context.command, context.appMode);
    }

    // 5c：file_write / file_edit，根据文件路径敏感度决策
    if (context.toolCategory === "file_write" || context.toolCategory === "file_edit") {
      return this.decideFileWrite(context.filePath ?? "", context.appMode);
    }

    // 5d：network / mcp 工具，默认询问用户
    return {
      decision: "ask_user",
      reason: `suggest 模式下 ${context.toolCategory} 工具需用户确认`,
      snapshotRequired: false,
    };
  }

  /**
   * 判断工具是否为只读
   *
   * 只读工具无副作用，可在 never 和 plan 模式下自动批准。
   * 当前仅 readonly 类别视为只读，bash/edit/write/network/mcp 均视为非只读。
   *
   * @param category 工具类型分类
   * @returns 是只读工具返回 true，否则 false
   */
  private isReadonlyTool(category: ToolCategory): boolean {
    return category === "readonly";
  }

  /**
   * 对 suggest 模式下的 bash 工具进行决策
   *
   * 决策逻辑：
   * 1. 白名单命令 → auto_approve（低风险，如 ls、cat、git status）
   * 2. 风险评估 benign → auto_approve（评分 0-30，如 mkdir、touch）
   * 3. 风险评估 caution → ask_user（评分 31-90，如 npm install、curl）
   * 4. 风险评估 destructive → deny（评分 91-100，防御性，正常已被步骤 1 拦截）
   *
   * @param command bash 命令字符串
   * @param appMode 应用模式（此处不为 plan，plan 已在 decide 中提前拦截）
   * @returns 审批结果
   */
  private decideBashCommand(command: string, _appMode: AppMode): ApprovalResult {
    // 白名单命令：低风险，自动批准
    if (this.commandSafety.isWhitelisted(command)) {
      return {
        decision: "auto_approve",
        reason: "白名单命令，自动批准",
        riskAssessment: this.commandSafety.assessRisk(command),
        snapshotRequired: false,
      };
    }

    // 非白名单命令：评估风险等级
    const assessment = this.commandSafety.assessRisk(command);

    // benign（0-30）：低风险，自动批准
    if (assessment.level === "benign") {
      return {
        decision: "auto_approve",
        reason: `低风险命令（评分 ${assessment.score}），自动批准`,
        riskAssessment: assessment,
        snapshotRequired: false,
      };
    }

    // caution（31-90）：中等风险，需用户确认
    if (assessment.level === "caution") {
      return {
        decision: "ask_user",
        reason: `中等风险命令（评分 ${assessment.score}），需用户确认`,
        riskAssessment: assessment,
        snapshotRequired: false,
      };
    }

    // destructive（91-100）：高风险，拒绝
    // 注：正常流程下，destructive 命令已在步骤 1 的 checkBlacklist 中被拦截，
    //     此处为防御性二次检查，确保安全无遗漏
    return {
      decision: "deny",
      reason: `高风险命令（评分 ${assessment.score}），拒绝执行`,
      riskAssessment: assessment,
      snapshotRequired: false,
    };
  }

  /**
   * 对 suggest 模式下的文件写入/编辑工具进行决策
   *
   * 决策逻辑：
   * 1. 无文件路径 → ask_user（无法评估，保守询问）
   * 2. 敏感路径 → deny（系统配置、密钥等不可修改）
   * 3. 普通路径 → ask_user（文件修改需用户确认）
   *
   * @param filePath 文件路径（可能为空字符串）
   * @param appMode 应用模式（此处不为 plan）
   * @returns 审批结果
   */
  private decideFileWrite(filePath: string, _appMode: AppMode): ApprovalResult {
    // 无文件路径：无法评估，保守询问用户
    if (!filePath || filePath.trim() === "") {
      return {
        decision: "ask_user",
        reason: "文件写入/编辑需用户确认（未提供路径）",
        snapshotRequired: false,
      };
    }

    // 敏感路径检查：命中即拒绝
    const isSensitive = SENSITIVE_PATH_PATTERNS.some((pattern) => filePath.includes(pattern));
    if (isSensitive) {
      return {
        decision: "deny",
        reason: `敏感路径 ${filePath} 拒绝写入（系统配置/密钥/凭据）`,
        snapshotRequired: false,
      };
    }

    // 普通文件路径：需用户确认（文件修改有副作用，应让用户知情）
    return {
      decision: "ask_user",
      reason: `文件写入/编辑 ${filePath} 需用户确认`,
      snapshotRequired: false,
    };
  }
}
