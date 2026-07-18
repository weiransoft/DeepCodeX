/**
 * RLIS 规则学习器（Rule Learner）—— EAG 方案 §5.5.4
 *
 * 本模块实现 EAG 方案 §5.5.4 规则学习流程的 `RuleLearner` 类。
 * 负责从用户日常纠正中检测、提取、累积、确认规则候选，最终固化为 learned 规则。
 *
 * 规则学习闭环（§5.5.4）：
 * 1. **检测**：纠正模式匹配（"不要..."/"严禁..."/"必须..."/"以后都..."/"禁止..." + 重复语义）
 * 2. **提取**：将纠正内容结构化为规则候选（category/severity 建议）
 * 3. **累积**：同类纠正 occurrenceCount+1
 * 4. **确认**：occurrenceCount >= 2 时主动推送确认请求 → 用户 confirm 或 reject
 * 5. **固化**：确认后转为 UserRule（learned 来源，confirmedBy="user"），写入全局/项目规则库
 *
 * 防误学红线（§5.5.4）：
 * - learned 来源规则未经用户确认**绝不生效**
 * - 单次纠正默认只生成候选，同类纠正出现 ≥2 次才主动推送确认请求
 * - confirmCandidate(userConfirmed=false) 时丢弃候选（不转为 UserRule）
 *
 * 分类推断规则（基于纠正内容关键词）：
 * - "mock/简化/占位/placeholder/simulated" → code-truth
 * - "注释/comment/中文注释" → comment-style
 * - "审查/review/测试先行/需求文档" → process-gate
 * - "技术栈/tech-stack/架构设计" → change-control
 * - "tests 目录/测试目录/测试脚本" → project-structure
 * - "质量/quality/评估器/打回" → quality-gate
 * - 默认（无关键词命中） → code-truth（最常用的分类）
 *
 * 级别推断规则（基于纠正语气关键词）：
 * - "严禁/禁止" → BLOCKER
 * - "必须" → MAJOR
 * - 其他 → WARNING
 *
 * 设计依据：
 * - EAG 方案 §5.5.4 规则学习流程
 * - 防误学红线（learned 来源规则未经用户确认绝不生效）
 *
 * @module eag/rlis/rule-learner
 */

import type { UserRule, RuleCandidate, RuleCategory, RuleSeverity } from "./types.js";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 纠正模式匹配规则表（表驱动设计）
 *
 * 对应 EAG 方案 §5.5.4 检测阶段的 5 种纠正模式。
 * 按数组顺序匹配，命中第一个即返回（不继续匹配后续模式）。
 *
 * 每条规则包含：
 * - pattern：正则表达式字符串
 * - label：模式的人类可读标签（如 "不要..."）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
const CORRECTION_PATTERNS: ReadonlyArray<{
  readonly pattern: string;
  readonly label: string;
}> = Object.freeze([
  // 模式 1：不要...
  { pattern: "^不要(.+)$", label: "不要..." },
  // 模式 2：严禁...
  { pattern: "^严禁(.+)$", label: "严禁..." },
  // 模式 3：必须...
  { pattern: "^必须(.+)$", label: "必须..." },
  // 模式 4：以后都...
  { pattern: "^以后都(.+)$", label: "以后都..." },
  // 模式 5：禁止...
  { pattern: "^禁止(.+)$", label: "禁止..." },
]);

/**
 * 分类推断关键词映射表（表驱动设计）
 *
 * 按数组顺序匹配，命中第一个即返回对应分类。
 * 用于 extractCandidate 阶段的 category 推断。
 *
 * 每条规则包含：
 * - keywords：关键词列表（任一命中即判定为该分类）
 * - category：规则分类
 *
 * 使用 Object.freeze 冻结。
 */
const CATEGORY_KEYWORDS: ReadonlyArray<{
  readonly keywords: ReadonlyArray<string>;
  readonly category: RuleCategory;
}> = Object.freeze([
  // 代码真实性（mock/简化/占位等）
  {
    keywords: ["mock", "模拟", "占位", "placeholder", "simulated", "简化", "逃避式删除"],
    category: "code-truth",
  },
  // 注释规范
  {
    keywords: ["注释", "comment", "中文注释", "JSDoc", "docstring"],
    category: "comment-style",
  },
  // 流程门禁
  {
    keywords: ["审查", "review", "测试先行", "需求文档", "架构师", "skill"],
    category: "process-gate",
  },
  // 变更控制
  {
    keywords: ["技术栈", "tech-stack", "架构设计", "框架", "library"],
    category: "change-control",
  },
  // 项目结构
  {
    keywords: ["tests 目录", "测试目录", "测试脚本", "目录结构", "file structure"],
    category: "project-structure",
  },
  // 质量门禁
  {
    keywords: ["质量", "quality", "评估器", "打回", "门禁", "gate"],
    category: "quality-gate",
  },
]);

/**
 * 级别推断关键词映射表（表驱动设计）
 *
 * 用于 extractCandidate 阶段的 severity 推断。
 * 按 BLOCKER → MAJOR 顺序匹配，未命中则默认 WARNING。
 *
 * 使用 Object.freeze 冻结。
 */
const SEVERITY_KEYWORDS: ReadonlyArray<{
  readonly keywords: ReadonlyArray<string>;
  readonly severity: RuleSeverity;
}> = Object.freeze([
  // BLOCKER：严禁/禁止语气
  {
    keywords: ["严禁", "禁止"],
    severity: "BLOCKER",
  },
  // MAJOR：必须语气
  {
    keywords: ["必须"],
    severity: "MAJOR",
  },
]);

/**
 * 默认分类（无关键词命中时）
 *
 * 取 code-truth，因「禁止 mock/简化」是最常见的纠正类型。
 */
const DEFAULT_CATEGORY: RuleCategory = "code-truth";

/**
 * 默认级别（无关键词命中时）
 *
 * 取 WARNING，因轻度纠正不强制打回。
 */
const DEFAULT_SEVERITY: RuleSeverity = "WARNING";

/**
 * 推送确认请求的累积阈值
 *
 * 对应 EAG 方案 §5.5.4 防误学红线：
 * 「单次纠正默认只生成候选，同类纠正出现 ≥2 次才主动推送确认请求」。
 */
const CONFIRMATION_PUSH_THRESHOLD = 2;

// ============================================================================
// RuleLearner 类
// ============================================================================

/**
 * 规则学习器
 *
 * 从用户日常纠正中检测、提取、累积、确认规则候选，最终固化为 learned 规则。
 *
 * 用法：
 * ```typescript
 * const learner = new RuleLearner();
 *
 * // 1. 检测纠正模式
 * const detection = learner.detectCorrection("不要使用 mock 开发");
 * if (detection) {
 *   // 2. 提取规则候选
 *   const candidate = learner.extractCandidate("不要使用 mock 开发", detection.pattern);
 *   // 3. 累积候选
 *   learner.accumulateCandidate(candidate);
 *   // 4. 判定是否推送确认请求
 *   if (learner.shouldPushConfirmation(candidate)) {
 *     // 5. 用户确认 → 转为 UserRule
 *     const rule = learner.confirmCandidate(candidate, true);
 *   }
 * }
 * ```
 *
 * 线程安全：本类的候选累积基于内部 Map 状态，不做多线程同步。
 * 实际使用场景为单会话单线程，无需同步。
 */
export class RuleLearner {
  /** 累积的规则候选（按 candidate.id 索引） */
  private readonly candidates: Map<string, RuleCandidate> = new Map();
  /** 学习规则 ID 自增计数器（用于生成 LEARN-xx ID） */
  private learnRuleCounter = 0;

  // ========================================================================
  // 公共 API：检测与提取
  // ========================================================================

  /**
   * 检测用户输入是否为纠正模式
   *
   * 匹配 5 种纠正模式（按 CORRECTION_PATTERNS 顺序匹配）：
   * - "不要..." → 命中 "不要..."
   * - "严禁..." → 命中 "严禁..."
   * - "必须..." → 命中 "必须..."
   * - "以后都..." → 命中 "以后都..."
   * - "禁止..." → 命中 "禁止..."
   *
   * @param userInput 用户输入文本
   * @returns 命中结果（包含 pattern label 与剩余内容）；未命中时返回 null
   */
  detectCorrection(userInput: string): { pattern: string; content: string } | null {
    if (!userInput || userInput.trim() === "") {
      return null;
    }
    const trimmed = userInput.trim();
    // 按 CORRECTION_PATTERNS 顺序匹配
    for (const { pattern, label } of CORRECTION_PATTERNS) {
      const regex = new RegExp(pattern);
      const match = regex.exec(trimmed);
      if (match && match[1]) {
        // match[1] 是去除模式前缀后的剩余内容
        return { pattern: label, content: match[1].trim() };
      }
    }
    return null;
  }

  /**
   * 从纠正内容提取规则候选
   *
   * 基于 category 关键词推断分类，基于 severity 关键词推断级别。
   * 推断规则：
   * - category：按 CATEGORY_KEYWORDS 顺序匹配，命中第一个即返回；未命中默认 code-truth
   * - severity：按 SEVERITY_KEYWORDS 顺序匹配（BLOCKER → MAJOR），未命中默认 WARNING
   *
   * @param userInput 用户输入文本（用于提取 content）
   * @param detectedPattern 命中的纠正模式（如 "不要..."）
   * @returns 规则候选（含推断的 category/severity/content）
   */
  extractCandidate(userInput: string, detectedPattern: string): RuleCandidate {
    // 检测纠正模式获取剩余内容
    const detection = this.detectCorrection(userInput);
    const content = detection?.content ?? userInput.trim();
    // 推断分类
    const category = this.inferCategory(content);
    // 推断级别
    const severity = this.inferSeverity(detectedPattern, content);
    // 生成候选 ID
    const id = this.generateCandidateId();
    // 当前时间戳
    const now = new Date().toISOString();
    return Object.freeze({
      id,
      category,
      severity,
      content: userInput.trim(),
      detectedPattern,
      occurrenceCount: 1,
      firstDetectedAt: now,
      lastDetectedAt: now,
    });
  }

  // ========================================================================
  // 公共 API：累积与确认
  // ========================================================================

  /**
   * 累积候选（同类纠正 occurrenceCount+1）
   *
   * 累积规则：
   * - 若候选已存在（按 content 语义匹配），occurrenceCount+1，更新 lastDetectedAt
   * - 若候选不存在，添加新候选
   *
   * 同类判定：按 content 文本完全匹配（不区分大小写、去除首尾空格）。
   * 实际生产中可升级为语义匹配（如 TF-IDF 相似度），但本实现保持确定性。
   *
   * @param candidate 待累积的规则候选
   * @returns 累积后的规则候选（occurrenceCount 已更新）
   */
  accumulateCandidate(candidate: RuleCandidate): RuleCandidate {
    // 按内容文本查找已有候选（不区分大小写）
    const normalizedContent = candidate.content.toLowerCase().trim();
    let existing: RuleCandidate | null = null;
    let existingId: string | null = null;
    for (const [id, c] of this.candidates) {
      if (c.content.toLowerCase().trim() === normalizedContent) {
        existing = c;
        existingId = id;
        break;
      }
    }
    if (existing && existingId) {
      // 同类候选已存在：occurrenceCount+1，更新 lastDetectedAt
      const updated: RuleCandidate = Object.freeze({
        ...existing,
        occurrenceCount: existing.occurrenceCount + 1,
        lastDetectedAt: new Date().toISOString(),
      });
      this.candidates.set(existingId, updated);
      return updated;
    }
    // 新候选：直接添加
    this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  /**
   * 判定是否主动推送确认请求
   *
   * 对应 EAG 方案 §5.5.4 防误学红线：
   * 「单次纠正默认只生成候选，同类纠正出现 ≥2 次才主动推送确认请求」。
   *
   * @param candidate 规则候选
   * @returns true 表示应主动推送确认请求；false 表示未达阈值
   */
  shouldPushConfirmation(candidate: RuleCandidate): boolean {
    // 查询累积后的最新候选（可能 occurrenceCount 已更新）
    const latest = this.findCandidateByContent(candidate.content);
    const occurrenceCount = latest?.occurrenceCount ?? candidate.occurrenceCount;
    return occurrenceCount >= CONFIRMATION_PUSH_THRESHOLD;
  }

  /**
   * 确认候选
   *
   * 对应 EAG 方案 §5.5.4 确认与固化阶段：
   * - userConfirmed=true：转 UserRule（learned 来源，confirmedBy="user"），从候选列表移除
   * - userConfirmed=false：丢弃候选（不转为 UserRule），从候选列表移除
   *
   * 防误学红线：仅当 userConfirmed=true 时才转为 UserRule，且 confirmedBy 强制为 "user"。
   *
   * @param candidate 待确认的规则候选
   * @param userConfirmed 用户确认结果（true=确认，false=拒绝）
   * @returns UserRule（userConfirmed=true 时）；null（userConfirmed=false 时）
   */
  confirmCandidate(candidate: RuleCandidate, userConfirmed: boolean): UserRule | null {
    // 从候选列表移除（无论确认还是拒绝）
    this.removeCandidate(candidate);
    // 拒绝：返回 null（丢弃候选）
    if (!userConfirmed) {
      return null;
    }
    // 确认：转 UserRule（learned 来源，confirmedBy="user"）
    const now = new Date().toISOString();
    return Object.freeze({
      id: candidate.id,
      category: candidate.category,
      severity: candidate.severity,
      content: candidate.content,
      source: "learned",
      confirmedBy: "user",
      usageCount: 0,
      violationCount: 0,
      createdAt: now,
    });
  }

  // ========================================================================
  // 公共 API：查询（用于测试与调试）
  // ========================================================================

  /**
   * 获取当前累积的全部候选
   *
   * @returns 候选列表（只读视图）
   */
  getCandidates(): ReadonlyArray<RuleCandidate> {
    return Array.from(this.candidates.values());
  }

  /**
   * 按 ID 查询候选
   *
   * @param id 候选 ID
   * @returns 候选对象；不存在时返回 null
   */
  getCandidateById(id: string): RuleCandidate | null {
    return this.candidates.get(id) ?? null;
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 推断规则分类
   *
   * 按 CATEGORY_KEYWORDS 顺序匹配，命中第一个即返回对应分类。
   * 未命中任何关键词时返回 DEFAULT_CATEGORY（code-truth）。
   *
   * @param content 纠正内容
   * @returns 推断的规则分类
   */
  private inferCategory(content: string): RuleCategory {
    const lowerContent = content.toLowerCase();
    for (const { keywords, category } of CATEGORY_KEYWORDS) {
      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          return category;
        }
      }
    }
    return DEFAULT_CATEGORY;
  }

  /**
   * 推断规则级别
   *
   * 按 SEVERITY_KEYWORDS 顺序匹配（BLOCKER → MAJOR）。
   * - "严禁/禁止" → BLOCKER
   * - "必须" → MAJOR
   * - 其他 → WARNING
   *
   * 注：detectedPattern 也参与判定（如 "严禁..." 模式直接判定为 BLOCKER）。
   *
   * @param detectedPattern 命中的纠正模式
   * @param content 纠正内容
   * @returns 推断的规则级别
   */
  private inferSeverity(detectedPattern: string, content: string): RuleSeverity {
    // 先按 detectedPattern 判定
    // "严禁..." 和 "禁止..." 模式 → BLOCKER
    if (detectedPattern.includes("严禁") || detectedPattern.includes("禁止")) {
      return "BLOCKER";
    }
    // "必须..." 模式 → MAJOR
    if (detectedPattern.includes("必须")) {
      return "MAJOR";
    }
    // 再按 content 关键词判定
    for (const { keywords, severity } of SEVERITY_KEYWORDS) {
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          return severity;
        }
      }
    }
    // 默认 WARNING
    return DEFAULT_SEVERITY;
  }

  /**
   * 生成候选 ID（LEARN-xx 前缀）
   *
   * @returns 候选 ID（如 "LEARN-01"）
   */
  private generateCandidateId(): string {
    this.learnRuleCounter += 1;
    return `LEARN-${String(this.learnRuleCounter).padStart(2, "0")}`;
  }

  /**
   * 按 content 文本查找候选
   *
   * @param content 候选内容
   * @returns 候选对象；不存在时返回 null
   */
  private findCandidateByContent(content: string): RuleCandidate | null {
    const normalized = content.toLowerCase().trim();
    for (const c of this.candidates.values()) {
      if (c.content.toLowerCase().trim() === normalized) {
        return c;
      }
    }
    return null;
  }

  /**
   * 从候选列表移除指定候选
   *
   * @param candidate 待移除的候选
   */
  private removeCandidate(candidate: RuleCandidate): void {
    // 按 ID 移除（若 ID 匹配）
    if (this.candidates.has(candidate.id)) {
      this.candidates.delete(candidate.id);
      return;
    }
    // 按 content 移除（兜底，防止 ID 不匹配但内容相同）
    const normalized = candidate.content.toLowerCase().trim();
    for (const [id, c] of this.candidates) {
      if (c.content.toLowerCase().trim() === normalized) {
        this.candidates.delete(id);
        return;
      }
    }
  }
}

// ============================================================================
// 模块导出
// ============================================================================

export {
  CORRECTION_PATTERNS,
  CATEGORY_KEYWORDS,
  SEVERITY_KEYWORDS,
  CONFIRMATION_PUSH_THRESHOLD,
  DEFAULT_CATEGORY,
  DEFAULT_SEVERITY,
};
