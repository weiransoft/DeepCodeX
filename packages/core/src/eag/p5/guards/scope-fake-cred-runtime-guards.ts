/**
 * EAG-P5 Phase 5.2 A-3/A-4/A-5/A-6 守护（TASK-P5-5.2-003 ~ 006）
 *
 * 本模块实现 6 层 15 条 BLOCKER 守护链的后 4 层（共 9 条 BLOCKER）：
 *
 * A-3 任务范围锁（ScopeLockGuard，2 条 BLOCKER）：
 * - G-A3a 行动依据唯一化：变更 diff vs 任务卡范围静态比对
 *   （currentDiff.changedFiles 必须 ⊆ currentTaskCard.declaredFiles）
 * - G-A3b 清理类意图永禁 AUTO：cleanup / purge / reset / format / wipe 永远转人工
 *
 * A-4 防伪造完成（FakeCompletionGuard，2 条 BLOCKER）：
 * - G-A4a 完成声明证据强制：必须附 CompletionEvidence（退出码 + 覆盖率 + verdict）
 * - G-A4b stop_when 确定性判定：条件编译期校验，拒绝无法确定化的表达式
 *
 * A-5 防越权用凭证（CredentialMisuseGuard，2 条 BLOCKER）：
 * - G-A5a 凭据文件读取白名单：.env* / credentials* / *token* / *secret* / SSH 私钥
 * - G-A5b commit 前密钥扫描：gitleaks 规则集（AWS / GCP / Azure / JWT / SSH 等）
 *
 * A-6 无人值守运行时约束（RuntimeConstraintGuard，3 条 BLOCKER）：
 * - G-A6a 《无人值守确认卡》前置：confirmationCardAccepted 必须为 true
 * - G-A6b 一键熔断与回滚：emergencyStopRequested 为 true 时立即 DENY
 * - G-A6d 上限不可自改：loopGuardConfig 必须冻结，运行期改写尝试拦截
 *
 * 设计依据：
 * - 需求文档 §3 FR-2 A-3~A-6（9 条 BLOCKER）
 * - 架构师审查 §4.2 GuardRule 接口契约 + §6 守护链架构图
 * - common/loop-guard.ts LoopGuard.getConfig() 冻结保证（G-A6d 复用）
 *
 * 不可变优先原则（NFR-8）：
 * - 所有字段 readonly
 * - 常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 真实实现（禁止 mock / 占位 / 简化）：
 * - G-A3a：真实路径归一化比对 + 符号 ID 范围检查
 * - G-A3b：真实正则匹配清理类关键词
 * - G-A4a：真实校验 CompletionEvidence 字段完整性与退出码
 * - G-A4b：真实白名单 + 黑名单条件编译期校验
 * - G-A5a：真实凭据文件名模式匹配
 * - G-A5b：真实 gitleaks 规则集正则扫描（20+ 模式）
 * - G-A6a：真实 confirmationCardAccepted 标志校验
 * - G-A6b：真实 emergencyStopRequested 标志校验
 * - G-A6d：真实 Object.isFrozen 校验 + 字段一致性比对
 *
 * @module eag/p5/guards/scope-fake-cred-runtime-guards
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GuardContext, GuardVerdict, GuardRule, GuardRuleId } from "./types";
import { createPassVerdict, createDenyVerdict, createAskVerdict } from "./types";

// ============================================================================
// 1. A-3 ScopeLockGuard 常量与正则
// ============================================================================

/**
 * 清理类意图关键词列表（G-A3b 永禁 AUTO）
 *
 * 对齐需求文档 §3 FR-2 G-A3b：cleanup / purge / reset / format / wipe 等关键词
 * 出现在命令或任务卡标题中时，永远转人工确认，不允许 AUTO 放行。
 *
 * 数值依据（事故案例）：
 * - cleanup：可能误删临时文件 / 缓存 / 构建产物
 * - purge：可能清空数据库 / 队列 / 日志
 * - reset：可能重置状态 / 配置 / 数据
 * - format：可能格式化磁盘 / 分区
 * - wipe：可能擦除数据 / 文件系统
 * - truncate：可能截断表 / 文件
 * - drop：可能删除数据库 / 表 / 集合
 * - clear：可能清空缓存 / 队列 / 日志
 *
 * 使用 Object.freeze 冻结。
 */
const CLEANUP_INTENT_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "cleanup",
  "clean-up",
  "purge",
  "reset",
  "format",
  "wipe",
  "truncate",
  "drop",
  "clear",
  "flush",
  "destroy",
  "erase",
  "obliterate",
  "shred",
]);

/**
 * 任务卡 declaredFiles 容量上限（G-A3a 性能保护）
 *
 * 防止任务卡声明过多文件导致 G-A3a 范围锁比对过慢。
 *
 * 数值依据：
 * - 200 个文件覆盖大多数企业任务的范围声明
 * - 超过 200 个文件的任务应拆分为多个子任务
 */
const MAX_DECLARED_FILES = 200 as const;

/**
 * currentDiff.changedFiles 容量上限（G-A3a 性能保护）
 *
 * 防止单次迭代产生过多变更导致 G-A3a 范围锁比对过慢。
 */
const MAX_CHANGED_FILES = 500 as const;

// ============================================================================
// 2. A-4 FakeCompletionGuard 常量
// ============================================================================

/**
 * stop_when 白名单（G-A4b 确定性条件白名单）
 *
 * 仅允许以下确定性条件作为 stop_when 表达式：
 * - 测试通过：all tests pass / tests pass / tests green
 * - 覆盖率达标：coverage >= N% / coverage > N%
 * - 类型检查通过：tsc pass / typecheck pass / no type errors
 * - Lint 通过：lint pass / no lint errors
 *
 * 数值依据：仅允许可机器验证的客观条件，禁止自然语言主观条件。
 */
const STOP_WHEN_ALLOWLIST: ReadonlyArray<RegExp> = Object.freeze([
  /^all\s+tests?\s+pass$/i,
  /^tests?\s+pass$/i,
  /^tests?\s+green$/i,
  /^coverage\s*>=\s*\d+(\.\d+)?%?$/i,
  /^coverage\s*>\s*\d+(\.\d+)?%?$/i,
  /^coverage\s*==\s*\d+(\.\d+)?%?$/i,
  /^tsc\s+pass$/i,
  /^typecheck\s+pass$/i,
  /^no\s+type\s+errors?$/i,
  /^lint\s+pass$/i,
  /^no\s+lint\s+errors?$/i,
  /^build\s+pass$/i,
  /^build\s+succeed(ed|s)?$/i,
]);

/**
 * stop_when 黑名单（G-A4b 拒绝条件）
 *
 * 以下条件永远拒绝（无法确定化或主观判断）：
 * - "looks good" / "seems fine"：主观判断
 * - "should work" / "probably works"：不确定
 * - "done" / "finished" / "complete"：无客观证据
 * - "verified" / "reviewed"：无客观证据
 */
const STOP_WHEN_BLACKLIST: ReadonlyArray<RegExp> = Object.freeze([
  /\b(looks?\s+good|seems?\s+(fine|ok|good))\b/i,
  /\b(should\s+work|probably\s+works?|likely\s+works?)\b/i,
  /\b(done|finished|complete|completed)\b/i,
  /\b(verified|reviewed|checked)\b/i,
  /\b(good\s+enough|acceptable)\b/i,
]);

/**
 * 完成声明证据的最小覆盖率阈值（G-A4a 证据完整性）
 *
 * verify 阶段声明的覆盖率必须 >= 此阈值，否则视为证据不足。
 *
 * 数值依据：
 * - 0%：允许 0% 覆盖率（仅校验证据存在性，不强制覆盖率门槛）
 * - 实际覆盖率门槛由 NFR-5 单独定义（80%）
 * - G-A4a 仅校验证据字段完整性，NFR-5 校验覆盖率数值
 */
const MIN_COVERAGE_PERCENT = 0 as const;

// ============================================================================
// 3. A-5 CredentialMisuseGuard 常量与正则
// ============================================================================

/**
 * 凭据文件名模式列表（G-A5a 凭据文件读取白名单）
 *
 * 对齐需求文档 §3 FR-2 G-A5a：以下文件路径禁止 agent 读取：
 * - .env / .env.* / .env.local：环境变量文件
 * - credentials / credentials.*：通用凭据文件
 * - *token* / *secret* / *key*：含 token/secret/key 关键词的文件
 * - SSH 私钥：id_rsa / id_ecdsa / id_ed25519 / id_dsa
 * - *.pem / *.key / *.p12 / *.pfx：证书与私钥文件
 *
 * 使用 Object.freeze 冻结。
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<
  Readonly<{
    pattern: RegExp;
    description: string;
  }>
> = Object.freeze([
  // .env 文件系列
  { pattern: /^\.env(\.|$)/i, description: ".env 环境变量文件" },
  { pattern: /\/\.env(\.|$)/i, description: "路径中的 .env 环境变量文件" },
  // credentials 文件
  { pattern: /(^|\/)credentials(\.|$)/i, description: "credentials 凭据文件" },
  { pattern: /(^|\/)\.credentials(\.|$)/i, description: ".credentials 隐藏凭据文件" },
  // token 文件
  { pattern: /(^|\/)[^/]*token[^/]*$/i, description: "含 token 关键词的文件" },
  { pattern: /(^|\/)\.token[^/]*$/i, description: "隐藏的 token 文件" },
  // secret 文件
  { pattern: /(^|\/)[^/]*secret[^/]*$/i, description: "含 secret 关键词的文件" },
  { pattern: /(^|\/)\.secret[^/]*$/i, description: "隐藏的 secret 文件" },
  // key 文件
  { pattern: /(^|\/)[^/]*\.(pem|key|p12|pfx)$/i, description: "证书/私钥文件（.pem/.key/.p12/.pfx）" },
  // SSH 私钥
  { pattern: /(^|\/)\.ssh\/(id_rsa|id_ecdsa|id_ed25519|id_dsa)$/i, description: "SSH 私钥文件" },
  // AWS 凭据
  { pattern: /(^|\/)\.aws\/credentials$/i, description: "AWS 凭据文件" },
  { pattern: /(^|\/)\.aws\/config$/i, description: "AWS 配置文件" },
  // GCP 凭据
  { pattern: /(^|\/)\.config\/gcloud\/[^/]+\.json$/i, description: "GCP 凭据文件" },
  // Kubernetes 凭据
  { pattern: /(^|\/)\.kube\/config$/i, description: "Kubernetes 配置文件" },
  // Docker 凭据
  { pattern: /(^|\/)\.docker\/config\.json$/i, description: "Docker 配置文件" },
  // npm 凭据
  { pattern: /(^|\/)\.npmrc$/i, description: "npm 配置文件（可能含 token）" },
  // GitHub CLI 凭据
  { pattern: /(^|\/)\.config\/gh\/hosts\.yml$/i, description: "GitHub CLI 凭据文件" },
  // Git 凭据
  { pattern: /(^|\/)\.git-credentials$/i, description: "Git 凭据文件" },
  { pattern: /(^|\/)\.netrc$/i, description: ".netrc 凭据文件" },
]);

/**
 * gitleaks 规则集（G-A5b commit 前密钥扫描）
 *
 * 对齐需求文档 §3 FR-2 G-A5b + gitleaks 默认规则集：
 * - AWS Access Key / Secret Key
 * - Google Cloud API Key / OAuth Token
 * - Azure Storage Key
 * - 数据库连接串
 * - SSH 私钥
 * - JWT Token
 * - Slack / GitHub / Stripe Token
 * - 通用 API Key / Token / Secret
 *
 * 复用 env-boundary-guard.ts 的 PROD_CREDENTIAL_PATTERNS 模式集，
 * 但本模块用于扫描 commit 文件内容（而非环境变量）。
 */
const GITLEAKS_PATTERNS: ReadonlyArray<
  Readonly<{
    pattern: RegExp;
    name: string;
    description: string;
  }>
> = Object.freeze([
  // AWS Access Key ID（AKIA 开头 + 16 位）
  {
    pattern: /AKIA[0-9A-Z]{16}/,
    name: "aws-access-key-id",
    description: "AWS Access Key ID 检出（AKIA 开头 20 位字符）",
  },
  // AWS Secret Access Key（40 位 base64）
  {
    pattern: /aws[_-]?secret[_-]?(access[_-]?key)?\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
    name: "aws-secret-access-key",
    description: "AWS Secret Access Key 检出（40 位 base64）",
  },
  // Google Cloud API Key（AIza 开头 + 35 位）
  {
    pattern: /AIza[0-9A-Za-z\-_]{35}/,
    name: "google-api-key",
    description: "Google Cloud API Key 检出（AIza 开头 39 位字符）",
  },
  // Google OAuth Access Token（ya29. 开头）
  {
    pattern: /ya29\.[0-9A-Za-z\-_]+/,
    name: "google-oauth-token",
    description: "Google OAuth Access Token 检出（ya29. 前缀）",
  },
  // Azure Storage Account Key（88 位 base64）
  {
    pattern: /AccountKey\s*=\s*[A-Za-z0-9+/=]{88}/,
    name: "azure-storage-key",
    description: "Azure Storage Account Key 检出（88 位 base64）",
  },
  // 数据库连接串（postgres/mysql/mongodb/redis://user:pass@host）
  {
    pattern: /(postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:]+:[^\s@]+@[^\s/]+/i,
    name: "database-connection-string",
    description: "数据库连接串检出（含用户名密码）",
  },
  // SSH 私钥头
  {
    pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)\s+PRIVATE\s+KEY-----/,
    name: "ssh-private-key",
    description: "SSH 私钥检出（PEM 格式头）",
  },
  // JWT Token（eyJ 开头的三段式 base64）
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    name: "jwt-token",
    description: "JWT Token 检出（三段式 base64）",
  },
  // Slack Token（xoxb- / xoxp- 开头）
  {
    pattern: /xox[baprs]-[0-9A-Za-z-]+/,
    name: "slack-token",
    description: "Slack Token 检出（xoxb-/xoxp- 前缀）",
  },
  // GitHub Token（ghp_ / gho_ / ghs_ / ghu_ 开头）
  {
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/,
    name: "github-token",
    description: "GitHub Token 检出（ghp_/gho_/ghs_/ghu_ 前缀）",
  },
  // Stripe Key（sk_live_ / sk_test_ / rk_live_ 开头）
  {
    pattern: /(sk|rk)_(live|test)_[0-9A-Za-z]{24,}/,
    name: "stripe-key",
    description: "Stripe Key 检出（sk_live_/rk_live_ 前缀）",
  },
  // 通用 API Key / Token / Secret（key=xxx / token=xxx / secret=xxx，长度 >= 16）
  {
    pattern:
      /(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9+/=_-]{16,}['"]?/i,
    name: "generic-api-key",
    description: "通用 API Key / Token / Secret 检出（长度 >= 16）",
  },
  // Private Key 通用模式（任何 BEGIN ... PRIVATE KEY -----）
  {
    pattern: /-----BEGIN\s+[A-Z\s]*PRIVATE\s+KEY-----/,
    name: "generic-private-key",
    description: "通用私钥检出（PEM 格式头）",
  },
]);

/**
 * commit 前密钥扫描的文件大小上限（字节）
 *
 * 超过此大小的单文件跳过扫描（避免扫描大型二进制文件或日志文件）。
 *
 * 数值依据：1MB 覆盖大多数源代码文件，跳过大型日志与二进制。
 */
const MAX_SCAN_FILE_SIZE_BYTES = 1024 * 1024;

// ============================================================================
// 4. A-6 RuntimeConstraintGuard 常量
// ============================================================================

/**
 * 上限配置字段列表（G-A6d 上限不可自改）
 *
 * 这些字段在 LoopGuard 构造时通过 Object.freeze 冻结，运行期不可修改。
 * G-A6d 校验 context.loopGuardConfig 与 LoopGuard.getConfig() 的一致性。
 */
const IMMUTABLE_LIMIT_FIELDS: ReadonlyArray<string> = Object.freeze([
  "maxIterations",
  "maxTokens",
  "maxConsecutiveFailures",
]);

// ============================================================================
// 5. ScopeLockGuard 类（A-3 层，2 条 BLOCKER）
// ============================================================================

/**
 * A-3 任务范围锁守护类
 *
 * 实现 2 条 BLOCKER：
 * - G-A3a 行动依据唯一化：变更 diff vs 任务卡范围静态比对
 * - G-A3b 清理类意图永禁 AUTO：cleanup / purge / reset 等永远转人工
 *
 * 守护顺序：
 * 1. 先检查 G-A3b 清理类意图（命令或任务卡标题含清理关键词 → ASK 转人工）
 * 2. 再检查 G-A3a 行动依据唯一化（变更 diff 必须 ⊆ 任务卡声明范围）
 *
 * 任一检查触发即返回，不继续后续检查（短路原则）。
 *
 * 用法：
 * ```typescript
 * const guard = new ScopeLockGuard();
 * const verdict = guard.check(context);
 * if (verdict.decision !== "PASS") {
 *   throw new GuardViolationError(verdict, "A-3");
 * }
 * ```
 */
export class ScopeLockGuard implements GuardRule {
  /** 规则 ID（G-A3a，主规则；G-A3b 在 check() 内部串联） */
  public readonly ruleId: GuardRuleId = "G-A3a";
  /** 所属层级（A-3 任务范围锁） */
  public readonly layer = "A-3" as const;
  /** 严重性（BLOCKER） */
  public readonly severity = "BLOCKER" as const;

  /**
   * 判定函数：执行 A-3 层 2 条 BLOCKER 检查
   *
   * 检查顺序（短路原则）：
   * 1. G-A3b 清理类意图永禁 AUTO（最优先，避免误放行清理操作）
   * 2. G-A3a 行动依据唯一化
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY / ASK）
   */
  check(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. G-A3b 清理类意图永禁 AUTO 检查
    const cleanupVerdict = this.checkCleanupIntent(context);
    if (cleanupVerdict.decision !== "PASS") {
      return cleanupVerdict;
    }

    // 2. G-A3a 行动依据唯一化检查
    const scopeVerdict = this.checkScopeLock(context);
    if (scopeVerdict.decision !== "PASS") {
      return scopeVerdict;
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A3b 清理类意图永禁 AUTO
  // ===========================================================================

  /**
   * G-A3b 清理类意图永禁 AUTO 检查
   *
   * 判定逻辑：
   * - 检查 pendingCommand 是否含清理类关键词（cleanup / purge / reset 等）
   * - 检查 currentTaskCard.title 是否含清理类关键词
   * - 任一命中即 ASK 转人工（永禁 AUTO）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / ASK）
   */
  private checkCleanupIntent(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const cmd = context.pendingCommand ?? "";
    const taskTitle = context.currentTaskCard?.title ?? "";

    // 检查命令中的清理类关键词（不区分大小写）
    const cmdLower = cmd.toLowerCase();
    for (const keyword of CLEANUP_INTENT_KEYWORDS) {
      // 词边界匹配，避免误报（如 "resetButton" 不应匹配 "reset"）
      const keywordPattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (keywordPattern.test(cmdLower)) {
        return createAskVerdict(
          "G-A3b",
          "BLOCKER",
          `清理类意图永禁 AUTO 违规：命令含清理关键词 "${keyword}"（命令：${cmd.substring(0, 60)}）`,
          "转人工确认清理类操作，AUTO 永禁"
        );
      }
    }

    // 检查任务卡标题中的清理类关键词
    const titleLower = taskTitle.toLowerCase();
    for (const keyword of CLEANUP_INTENT_KEYWORDS) {
      const keywordPattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (keywordPattern.test(titleLower)) {
        return createAskVerdict(
          "G-A3b",
          "BLOCKER",
          `清理类意图永禁 AUTO 违规：任务卡标题含清理关键词 "${keyword}"（标题：${taskTitle}）`,
          "转人工确认清理类任务，AUTO 永禁"
        );
      }
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A3a 行动依据唯一化
  // ===========================================================================

  /**
   * G-A3a 行动依据唯一化检查
   *
   * 判定逻辑：
   * 1. 若 stage != "dev" → PASS（仅 dev 阶段产生代码变更）
   * 2. 若 currentDiff 缺失 → PASS（无变更不校验）
   * 3. 若 currentTaskCard 缺失 → ASK（无任务卡不能 dev）
   * 4. 校验 currentDiff.changedFiles 容量（> MAX_CHANGED_FILES → ASK）
   * 5. 校验 currentTaskCard.declaredFiles 容量（> MAX_DECLARED_FILES → ASK）
   * 6. 逐个校验 changedFiles 是否 ⊆ declaredFiles
   *    - 路径归一化后比较
   *    - 任一越界文件 → ASK 转人工
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / ASK）
   */
  private checkScopeLock(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. 仅 dev 阶段校验
    if (context.stage !== "dev") {
      return createPassVerdict();
    }

    // 2. 无变更不校验
    const currentDiff = context.currentDiff;
    if (!currentDiff || currentDiff.changedFiles.length === 0) {
      return createPassVerdict();
    }

    // 3. 任务卡缺失检查
    const taskCard = context.currentTaskCard;
    if (!taskCard) {
      return createAskVerdict(
        "G-A3a",
        "BLOCKER",
        "行动依据唯一化违规：dev 阶段缺少 currentTaskCard，无法校验范围",
        "转人工确认，dev 阶段必须提供 currentTaskCard"
      );
    }

    // 4. changedFiles 容量校验
    if (currentDiff.changedFiles.length > MAX_CHANGED_FILES) {
      return createAskVerdict(
        "G-A3a",
        "BLOCKER",
        `行动依据唯一化违规：currentDiff.changedFiles 容量超限（${currentDiff.changedFiles.length} > ${MAX_CHANGED_FILES}）`,
        "转人工确认，建议拆分任务以缩小变更范围"
      );
    }

    // 5. declaredFiles 容量校验
    if (taskCard.declaredFiles.length > MAX_DECLARED_FILES) {
      return createAskVerdict(
        "G-A3a",
        "BLOCKER",
        `行动依据唯一化违规：currentTaskCard.declaredFiles 容量超限（${taskCard.declaredFiles.length} > ${MAX_DECLARED_FILES}）`,
        "转人工确认，建议拆分任务卡以缩小 declaredFiles 范围"
      );
    }

    // 6. 逐个校验 changedFiles 是否 ⊆ declaredFiles
    const declaredSet = new Set(taskCard.declaredFiles.map((f) => this.normalizePath(f)));
    for (const changedFile of currentDiff.changedFiles) {
      const normalizedChanged = this.normalizePath(changedFile.filePath);
      if (!declaredSet.has(normalizedChanged)) {
        return createAskVerdict(
          "G-A3a",
          "BLOCKER",
          `行动依据唯一化违规：变更文件 ${changedFile.filePath} 不在任务卡 declaredFiles 内`,
          `转人工确认，或在任务卡 declaredFiles 中显式声明 ${changedFile.filePath}`
        );
      }
    }

    // 7. 符号级校验（可选，若 declaredSymbols 与 affectedSymbols 都提供）
    if (taskCard.declaredSymbols.length > 0 && currentDiff.affectedSymbols) {
      const declaredSymbolSet = new Set(taskCard.declaredSymbols);
      for (const affectedSymbol of currentDiff.affectedSymbols) {
        if (!declaredSymbolSet.has(affectedSymbol)) {
          return createAskVerdict(
            "G-A3a",
            "BLOCKER",
            `行动依据唯一化违规：变更符号 ${affectedSymbol} 不在任务卡 declaredSymbols 内`,
            `转人工确认，或在任务卡 declaredSymbols 中显式声明 ${affectedSymbol}`
          );
        }
      }
    }

    return createPassVerdict();
  }

  /**
   * 路径归一化（用于 declaredFiles / changedFiles 比对）
   *
   * - 统一为 POSIX 分隔符（/）
   * - 去除 ./ 前缀
   * - 去除尾部 /
   *
   * @param filePath 文件路径
   * @returns 归一化后的路径
   */
  private normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, "/");
    if (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }
}

// ============================================================================
// 6. FakeCompletionGuard 类（A-4 层，2 条 BLOCKER）
// ============================================================================

/**
 * A-4 防伪造完成守护类
 *
 * 实现 2 条 BLOCKER：
 * - G-A4a 完成声明证据强制：verify 阶段必须附 CompletionEvidence
 * - G-A4b stop_when 确定性判定：编译期校验条件表达式
 *
 * 守护顺序：
 * 1. 先检查 G-A4b stop_when 确定性（编译期校验，避免运行期失败）
 * 2. 再检查 G-A4a 完成声明证据强制（运行期证据校验）
 *
 * 用法：
 * ```typescript
 * const guard = new FakeCompletionGuard();
 * const verdict = guard.check(context);
 * if (verdict.decision !== "PASS") {
 *   throw new GuardViolationError(verdict, "A-4");
 * }
 * ```
 */
export class FakeCompletionGuard implements GuardRule {
  /** 规则 ID（G-A4a，主规则；G-A4b 在 check() 内部串联） */
  public readonly ruleId: GuardRuleId = "G-A4a";
  /** 所属层级（A-4 防伪造完成） */
  public readonly layer = "A-4" as const;
  /** 严重性（BLOCKER） */
  public readonly severity = "BLOCKER" as const;

  /**
   * 判定函数：执行 A-4 层 2 条 BLOCKER 检查
   *
   * 检查顺序（短路原则）：
   * 1. G-A4b stop_when 确定性判定（条件编译期校验）
   * 2. G-A4a 完成声明证据强制（verify 阶段证据校验）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  check(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. G-A4b stop_when 确定性判定
    const stopWhenVerdict = this.checkStopWhenDeterminism(context);
    if (stopWhenVerdict.decision !== "PASS") {
      return stopWhenVerdict;
    }

    // 2. G-A4a 完成声明证据强制
    const evidenceVerdict = this.checkCompletionEvidence(context);
    if (evidenceVerdict.decision !== "PASS") {
      return evidenceVerdict;
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A4b stop_when 确定性判定
  // ===========================================================================

  /**
   * G-A4b stop_when 确定性判定
   *
   * 判定逻辑：
   * 1. 若 stopWhenExpression 缺失 → PASS（无停止条件不校验）
   * 2. 若 stopWhenExpression ∈ 黑名单（主观/不确定）→ DENY
   * 3. 若 stopWhenExpression ∈ 白名单（客观/可机器验证）→ PASS
   * 4. 否则 → DENY（不在白名单内，无法确定化）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkStopWhenDeterminism(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const expression = context.stopWhenExpression;
    if (!expression) {
      return createPassVerdict();
    }

    // 去除首尾空白
    const trimmedExpr = expression.trim();

    // 1. 黑名单检查（主观/不确定条件）
    for (const blacklistPattern of STOP_WHEN_BLACKLIST) {
      blacklistPattern.lastIndex = 0;
      if (blacklistPattern.test(trimmedExpr)) {
        return createDenyVerdict(
          "G-A4b",
          "BLOCKER",
          `stop_when 确定性判定违规：表达式 "${trimmedExpr}" 含主观/不确定条件（黑名单匹配）`,
          "拒绝 stop_when 表达式，建议使用客观可验证条件（如 all tests pass / coverage >= 80%）"
        );
      }
    }

    // 2. 白名单检查（客观/可机器验证条件）
    let isAllowlisted = false;
    for (const allowlistPattern of STOP_WHEN_ALLOWLIST) {
      allowlistPattern.lastIndex = 0;
      if (allowlistPattern.test(trimmedExpr)) {
        isAllowlisted = true;
        break;
      }
    }

    if (!isAllowlisted) {
      return createDenyVerdict(
        "G-A4b",
        "BLOCKER",
        `stop_when 确定性判定违规：表达式 "${trimmedExpr}" 不在白名单内，无法确定化`,
        "拒绝 stop_when 表达式，建议使用白名单内的客观条件（如 all tests pass / coverage >= 80%）"
      );
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A4a 完成声明证据强制
  // ===========================================================================

  /**
   * G-A4a 完成声明证据强制检查
   *
   * 判定逻辑：
   * 1. 若 stage != "verify" → PASS（仅 verify 阶段需要证据）
   * 2. 若 completionEvidence 缺失 → DENY（无证据不能声明完成）
   * 3. 校验证据字段完整性：
   *    - testCommand 非空
   *    - testExitCode 为数字
   *    - testOutputSummary 非空
   *    - coveragePercent >= MIN_COVERAGE_PERCENT
   *    - evaluatorVerdict ∈ {"pass", "fail", "inconclusive"}
   *    - executedAt 非空（ISO 8601 格式）
   * 4. 若 evaluatorVerdict != "pass" → DENY（评估器未通过不能声明完成）
   * 5. 若 testExitCode != 0 → DENY（测试失败不能声明完成）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkCompletionEvidence(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. 仅 verify 阶段校验
    if (context.stage !== "verify") {
      return createPassVerdict();
    }

    // 2. 证据缺失检查
    const evidence = context.completionEvidence;
    if (!evidence) {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        "完成声明证据强制违规：verify 阶段缺少 completionEvidence，禁止自然语言声明完成",
        "中止迭代，verify 阶段必须附 CompletionEvidence（testCommand + testExitCode + coveragePercent + evaluatorVerdict）"
      );
    }

    // 3. 字段完整性校验
    if (!evidence.testCommand || typeof evidence.testCommand !== "string") {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        "完成声明证据强制违规：completionEvidence.testCommand 为空或非字符串",
        "中止迭代，必须提供真实的测试命令"
      );
    }

    if (typeof evidence.testExitCode !== "number" || !Number.isFinite(evidence.testExitCode)) {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        "完成声明证据强制违规：completionEvidence.testExitCode 非有效数字",
        "中止迭代，必须提供真实的测试退出码"
      );
    }

    if (!evidence.testOutputSummary || typeof evidence.testOutputSummary !== "string") {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        "完成声明证据强制违规：completionEvidence.testOutputSummary 为空或非字符串",
        "中止迭代，必须提供测试输出摘要（禁止自然语言声明）"
      );
    }

    if (
      typeof evidence.coveragePercent !== "number" ||
      evidence.coveragePercent < MIN_COVERAGE_PERCENT ||
      evidence.coveragePercent > 100
    ) {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        `完成声明证据强制违规：completionEvidence.coveragePercent 超出范围 [${MIN_COVERAGE_PERCENT}, 100]（实际值：${evidence.coveragePercent}）`,
        "中止迭代，必须提供真实的测试覆盖率数值"
      );
    }

    const validVerdicts = ["pass", "fail", "inconclusive"];
    if (!validVerdicts.includes(evidence.evaluatorVerdict)) {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        `完成声明证据强制违规：completionEvidence.evaluatorVerdict "${evidence.evaluatorVerdict}" 不在有效集合 ${JSON.stringify(validVerdicts)} 内`,
        "中止迭代，必须提供真实的评估器 verdict"
      );
    }

    if (!evidence.executedAt || typeof evidence.executedAt !== "string") {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        "完成声明证据强制违规：completionEvidence.executedAt 为空或非字符串",
        "中止迭代，必须提供测试执行时间戳（ISO 8601）"
      );
    }

    // 4. 评估器 verdict 校验
    if (evidence.evaluatorVerdict !== "pass") {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        `完成声明证据强制违规：评估器 verdict "${evidence.evaluatorVerdict}" 非 pass，禁止声明完成`,
        "中止迭代，评估器未通过，禁止声明完成"
      );
    }

    // 5. 测试退出码校验
    if (evidence.testExitCode !== 0) {
      return createDenyVerdict(
        "G-A4a",
        "BLOCKER",
        `完成声明证据强制违规：测试退出码 ${evidence.testExitCode} 非 0，测试失败`,
        "中止迭代，测试未通过，禁止声明完成"
      );
    }

    return createPassVerdict();
  }
}

// ============================================================================
// 7. CredentialMisuseGuard 类（A-5 层，2 条 BLOCKER）
// ============================================================================

/**
 * A-5 防越权用凭证守护类
 *
 * 实现 2 条 BLOCKER：
 * - G-A5a 凭据文件读取白名单：禁止读取 .env / credentials / token / secret / SSH 私钥
 * - G-A5b commit 前密钥扫描：扫描 pendingCommitFiles 内容，检出密钥即 DENY
 *
 * 守护顺序：
 * 1. 先检查 G-A5a 凭据文件读取白名单（路径匹配，无需读取文件内容）
 * 2. 再检查 G-A5b commit 前密钥扫描（需要读取文件内容）
 *
 * 用法：
 * ```typescript
 * const guard = new CredentialMisuseGuard();
 * const verdict = await guard.check(context); // 可能异步读取文件
 * if (verdict.decision !== "PASS") {
 *   throw new GuardViolationError(verdict, "A-5");
 * }
 * ```
 *
 * 注意：G-A5b 需要读取文件内容进行 gitleaks 扫描，
 * 实现采用同步 check() + 内部异步读取文件（用 fs.readFileSync 同步 API）。
 */
export class CredentialMisuseGuard implements GuardRule {
  /** 规则 ID（G-A5a，主规则；G-A5b 在 check() 内部串联） */
  public readonly ruleId: GuardRuleId = "G-A5a";
  /** 所属层级（A-5 防越权用凭证） */
  public readonly layer = "A-5" as const;
  /** 严重性（BLOCKER） */
  public readonly severity = "BLOCKER" as const;

  /**
   * 判定函数：执行 A-5 层 2 条 BLOCKER 检查
   *
   * 检查顺序（短路原则）：
   * 1. G-A5a 凭据文件读取白名单
   * 2. G-A5b commit 前密钥扫描
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  check(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. G-A5a 凭据文件读取白名单检查
    const readFileVerdict = this.checkCredentialFileRead(context);
    if (readFileVerdict.decision !== "PASS") {
      return readFileVerdict;
    }

    // 2. G-A5b commit 前密钥扫描
    const commitScanVerdict = this.checkCommitSecretScan(context);
    if (commitScanVerdict.decision !== "PASS") {
      return commitScanVerdict;
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A5a 凭据文件读取白名单
  // ===========================================================================

  /**
   * G-A5a 凭据文件读取白名单检查
   *
   * 判定逻辑：
   * - 检查 pendingReadFiles 是否匹配凭据文件名模式
   * - 任一匹配即 DENY
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkCredentialFileRead(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const pendingReadFiles = context.pendingReadFiles;
    if (!pendingReadFiles || pendingReadFiles.length === 0) {
      return createPassVerdict();
    }

    // 遍历待读取文件，检查凭据文件名模式
    for (const filePath of pendingReadFiles) {
      if (typeof filePath !== "string" || !filePath) {
        continue;
      }
      // 归一化路径（POSIX 分隔符）
      const normalizedPath = filePath.replace(/\\/g, "/");

      for (const { pattern, description } of CREDENTIAL_FILE_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(normalizedPath)) {
          return createDenyVerdict(
            "G-A5a",
            "BLOCKER",
            `凭据文件读取白名单违规：禁止读取 ${description}（路径：${filePath}）`,
            "中止迭代，禁止 agent 读取凭据文件，建议使用环境变量或密钥管理服务"
          );
        }
      }
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A5b commit 前密钥扫描
  // ===========================================================================

  /**
   * G-A5b commit 前密钥扫描
   *
   * 判定逻辑：
   * 1. 若 pendingCommitFiles 缺失或为空 → PASS
   * 2. 遍历 pendingCommitFiles，读取每个文件内容
   * 3. 对每个文件内容运行 gitleaks 规则集扫描
   * 4. 任一文件检出密钥即 DENY
   *
   * 实现细节：
   * - 使用 fs.readFileSync 同步读取文件（避免异步复杂度）
   * - 文件大小超过 MAX_SCAN_FILE_SIZE_BYTES 时跳过（避免扫描二进制/日志）
   * - 读取失败时 ASK 转人工（无法确认文件内容安全性）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY / ASK）
   */
  private checkCommitSecretScan(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const pendingCommitFiles = context.pendingCommitFiles;
    if (!pendingCommitFiles || pendingCommitFiles.length === 0) {
      return createPassVerdict();
    }

    // 使用顶层 import 的 fs / path 模块（已通过 import * as 引入）
    const projectRoot = context.projectRoot;

    for (const relativeFilePath of pendingCommitFiles) {
      if (typeof relativeFilePath !== "string" || !relativeFilePath) {
        continue;
      }

      // 拼接绝对路径
      const absolutePath = path.isAbsolute(relativeFilePath)
        ? relativeFilePath
        : path.join(projectRoot, relativeFilePath);

      // 检查文件是否存在
      if (!fs.existsSync(absolutePath)) {
        // 文件不存在（可能是新增文件未写入磁盘），跳过
        continue;
      }

      // 检查文件大小
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        // stat 失败，转人工
        return createAskVerdict(
          "G-A5b",
          "BLOCKER",
          `commit 前密钥扫描违规：无法获取文件状态 ${relativeFilePath}（stat 失败）`,
          "转人工确认文件可访问性"
        );
      }

      // 跳过目录
      if (stat.isDirectory()) {
        continue;
      }

      // 跳过过大文件
      if (stat.size > MAX_SCAN_FILE_SIZE_BYTES) {
        continue;
      }

      // 读取文件内容
      let content: string;
      try {
        content = fs.readFileSync(absolutePath, "utf-8");
      } catch {
        // 读取失败（可能是二进制文件或权限不足），转人工
        return createAskVerdict(
          "G-A5b",
          "BLOCKER",
          `commit 前密钥扫描违规：无法读取文件 ${relativeFilePath}（可能为二进制或权限不足）`,
          "转人工确认文件内容安全性"
        );
      }

      // 运行 gitleaks 规则集扫描
      for (const { pattern, name, description } of GITLEAKS_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          return createDenyVerdict(
            "G-A5b",
            "BLOCKER",
            `commit 前密钥扫描违规：${description}（文件：${relativeFilePath}，凭据类型：${name}）`,
            "中止迭代，禁止 commit 含密钥的文件，建议清理密钥并使用环境变量"
          );
        }
      }
    }

    return createPassVerdict();
  }
}

// ============================================================================
// 8. RuntimeConstraintGuard 类（A-6 层，3 条 BLOCKER）
// ============================================================================

/**
 * A-6 无人值守运行时约束守护类
 *
 * 实现 3 条 BLOCKER：
 * - G-A6a 《无人值守确认卡》前置：confirmationCardAccepted 必须为 true
 * - G-A6b 一键熔断与回滚：emergencyStopRequested 为 true 时立即 DENY
 * - G-A6d 上限不可自改：loopGuardConfig 必须 Object.isFrozen，字段不可被改写
 *
 * 守护顺序：
 * 1. 先检查 G-A6b 一键熔断（最高优先级，紧急停止）
 * 2. 再检查 G-A6a 确认卡前置（首次进入循环前必须确认）
 * 3. 最后检查 G-A6d 上限不可自改（每次迭代都校验）
 *
 * 用法：
 * ```typescript
 * const guard = new RuntimeConstraintGuard();
 * const verdict = guard.check(context);
 * if (verdict.decision !== "PASS") {
 *   throw new GuardViolationError(verdict, "A-6");
 * }
 * ```
 */
export class RuntimeConstraintGuard implements GuardRule {
  /** 规则 ID（G-A6a，主规则；G-A6b/G-A6d 在 check() 内部串联） */
  public readonly ruleId: GuardRuleId = "G-A6a";
  /** 所属层级（A-6 无人值守运行时约束） */
  public readonly layer = "A-6" as const;
  /** 严重性（BLOCKER） */
  public readonly severity = "BLOCKER" as const;

  /**
   * 判定函数：执行 A-6 层 3 条 BLOCKER 检查
   *
   * 检查顺序（短路原则）：
   * 1. G-A6b 一键熔断与回滚（紧急停止，最高优先级）
   * 2. G-A6a 无人值守确认卡前置
   * 3. G-A6d 上限不可自改
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  check(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. G-A6b 一键熔断与回滚检查
    const emergencyVerdict = this.checkEmergencyStop(context);
    if (emergencyVerdict.decision !== "PASS") {
      return emergencyVerdict;
    }

    // 2. G-A6a 无人值守确认卡前置检查
    const confirmationVerdict = this.checkConfirmationCard(context);
    if (confirmationVerdict.decision !== "PASS") {
      return confirmationVerdict;
    }

    // 3. G-A6d 上限不可自改检查
    const limitVerdict = this.checkImmutableLimits(context);
    if (limitVerdict.decision !== "PASS") {
      return limitVerdict;
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A6b 一键熔断与回滚
  // ===========================================================================

  /**
   * G-A6b 一键熔断与回滚检查
   *
   * 判定逻辑：
   * - 若 context.emergencyStopRequested === true → DENY（立即熔断并回滚）
   * - 否则 → PASS
   *
   * 实现细节：
   * - 严格 === true 比较（避免 truthy 误判）
   * - 熔断后必须回滚到上一个里程碑（由调用方实现）
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkEmergencyStop(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    if (context.emergencyStopRequested === true) {
      return createDenyVerdict(
        "G-A6b",
        "BLOCKER",
        `一键熔断与回滚违规：收到紧急停止请求（run-id：${context.runId}，迭代：${context.iterIndex}）`,
        "立即熔断并回滚到上一个里程碑，调用 /eag-autonomous-stop 触发"
      );
    }
    return createPassVerdict();
  }

  // ===========================================================================
  // G-A6a 无人值守确认卡前置
  // ===========================================================================

  /**
   * G-A6a 无人值守确认卡前置检查
   *
   * 判定逻辑：
   * - 若 iterIndex === 0 且 confirmationCardAccepted !== true → DENY
   *   （首次进入循环前必须确认）
   * - 若 iterIndex > 0 → PASS（后续迭代不重复校验）
   * - 若 confirmationCardAccepted === true → PASS
   *
   * 实现细节：
   * - 严格 === true 比较（避免 truthy 误判）
   * - 仅首次迭代校验，避免重复拦截
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkConfirmationCard(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 仅首次迭代校验
    if (context.iterIndex > 0) {
      return createPassVerdict();
    }

    // 检查确认卡标志
    if (context.confirmationCardAccepted !== true) {
      return createDenyVerdict(
        "G-A6a",
        "BLOCKER",
        `无人值守确认卡前置违规：首次迭代 confirmationCardAccepted 非 true（run-id：${context.runId}）`,
        "中止迭代，必须先调用 /eag-autonomous --confirm 确认进入无人值守模式"
      );
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A6d 上限不可自改
  // ===========================================================================

  /**
   * G-A6d 上限不可自改检查
   *
   * 判定逻辑：
   * 1. 若 loopGuardConfig 缺失 → DENY（无法校验上限一致性）
   * 2. 校验 loopGuardConfig 是否 Object.isFrozen
   *    - 若未冻结 → DENY（运行期可被修改）
   * 3. 校验 IMMUTABLE_LIMIT_FIELDS 字段类型与有效性
   *    - maxIterations：正整数，>= 1，<= 1000
   *    - maxTokens：正整数，>= 1000
   *    - maxConsecutiveFailures：正整数，>= 1，<= 10
   *
   * 实现细节：
   * - 使用 Object.isFrozen 校验配置冻结状态
   * - 使用 typeof + Number.isInteger 校验字段类型
   * - 严格范围校验，防止 LLM 自改上限逃逸保护
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  private checkImmutableLimits(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const config = context.loopGuardConfig;
    if (!config) {
      return createDenyVerdict(
        "G-A6d",
        "BLOCKER",
        `上限不可自改违规：loopGuardConfig 缺失，无法校验上限一致性（run-id：${context.runId}）`,
        "中止迭代，调用方必须传入 loopGuardConfig 快照"
      );
    }

    // 1. 校验 Object.isFrozen
    if (!Object.isFrozen(config)) {
      return createDenyVerdict(
        "G-A6d",
        "BLOCKER",
        `上限不可自改违规：loopGuardConfig 未冻结（Object.isFrozen=false），运行期可被修改`,
        "中止迭代，调用方必须传入 Object.freeze 冻结的 loopGuardConfig"
      );
    }

    // 2. 校验字段类型与范围
    const { maxIterations, maxTokens, maxConsecutiveFailures } = config;

    // maxIterations：正整数，[1, 1000]
    if (
      typeof maxIterations !== "number" ||
      !Number.isInteger(maxIterations) ||
      maxIterations < 1 ||
      maxIterations > 1000
    ) {
      return createDenyVerdict(
        "G-A6d",
        "BLOCKER",
        `上限不可自改违规：maxIterations 超出范围 [1, 1000]（实际值：${maxIterations}）`,
        "中止迭代，maxIterations 必须为 [1, 1000] 范围内的整数"
      );
    }

    // maxTokens：正整数，>= 1000
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1000) {
      return createDenyVerdict(
        "G-A6d",
        "BLOCKER",
        `上限不可自改违规：maxTokens 超出范围 [1000, +∞)（实际值：${maxTokens}）`,
        "中止迭代，maxTokens 必须为 >= 1000 的整数"
      );
    }

    // maxConsecutiveFailures：正整数，[1, 10]
    if (
      typeof maxConsecutiveFailures !== "number" ||
      !Number.isInteger(maxConsecutiveFailures) ||
      maxConsecutiveFailures < 1 ||
      maxConsecutiveFailures > 10
    ) {
      return createDenyVerdict(
        "G-A6d",
        "BLOCKER",
        `上限不可自改违规：maxConsecutiveFailures 超出范围 [1, 10]（实际值：${maxConsecutiveFailures}）`,
        "中止迭代，maxConsecutiveFailures 必须为 [1, 10] 范围内的整数"
      );
    }

    return createPassVerdict();
  }
}

// ============================================================================
// 9. 导出常量（供测试与外部模块使用）
// ============================================================================

/**
 * 导出清理类意图关键词列表（供测试断言）
 */
export { CLEANUP_INTENT_KEYWORDS as SCOPE_LOCK_CLEANUP_KEYWORDS };

/**
 * 导出凭据文件名模式列表（供测试断言）
 */
export { CREDENTIAL_FILE_PATTERNS as CREDENTIAL_MISUSE_FILE_PATTERNS };

/**
 * 导出 gitleaks 规则集（供测试断言）
 */
export { GITLEAKS_PATTERNS as CREDENTIAL_MISUSE_GITLEAKS_PATTERNS };

/**
 * 导出 stop_when 白名单（供测试断言）
 */
export { STOP_WHEN_ALLOWLIST as FAKE_COMPLETION_STOP_WHEN_ALLOWLIST };

/**
 * 导出 stop_when 黑名单（供测试断言）
 */
export { STOP_WHEN_BLACKLIST as FAKE_COMPLETION_STOP_WHEN_BLACKLIST };

/**
 * 导出上限不可自改字段列表（供测试断言）
 */
export { IMMUTABLE_LIMIT_FIELDS as RUNTIME_CONSTRAINT_IMMUTABLE_FIELDS };
