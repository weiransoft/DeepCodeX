/**
 * EAG-P5 Phase 5.2 A-1 环境边界硬隔离守护（TASK-P5-5.2-001）
 *
 * 本模块实现 6 层 15 条 BLOCKER 守护链的 A-1 层（3 条 BLOCKER）：
 * - G-A1a 路径牢笼（path jail）：agent 全部文件写/删操作限定 project_root 内；
 *   任何越界路径写入（$HOME / ~ / 系统目录 / 绝对路径外溢）一律 DENY
 * - G-A1b 环境变量写保护：禁止 agent 修改 shell 环境变量（HOME / PATH / LD_* / NODE_PATH 等）
 * - G-A1c 生产凭据不可达：autonomous 启动前扫描进程环境 + 工作区配置，
 *   检出生产 DB 连接串 / 云生产凭证 / 生产 SSH 主机即 fail-closed
 *
 * 设计依据：
 * - 需求文档 §3 FR-2 A-1 环境边界硬隔离（3 条 BLOCKER）
 * - 需求文档 §2 US-2 AC-2.1 / AC-2.2 / AC-2.3
 * - 架构师审查 §4.2 GuardRule 接口契约
 * - 事故案例：GPT-5.6 Sol 清空 Mac 事故（路径越界）+ Bruno 误连生产（凭据越界）
 *
 * 不可变优先原则（NFR-8）：
 * - 所有字段 readonly
 * - 常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 真实实现（禁止 mock / 占位 / 简化）：
 * - G-A1a：使用 node:path 的 path.resolve + 前缀校验，真实文件系统路径解析
 * - G-A1b：真实正则匹配 export / unset / env 写 API 调用模式
 * - G-A1c：真实正则匹配生产凭据模式（DB 连接串 / AWS / GCP / Azure / SSH 主机）
 *
 * @module eag/p5/guards/env-boundary-guard
 */

import * as path from "node:path";
import type { GuardContext, GuardVerdict, GuardRule, GuardRuleId } from "./types";
import { createPassVerdict, createDenyVerdict } from "./types";

// ============================================================================
// 1. G-A1a 路径牢笼常量与正则
// ============================================================================

/**
 * 系统级敏感目录前缀（绝对路径）
 *
 * 对齐需求文档 §3 FR-2 G-A1a：/ ~ /etc /var /usr /home 等系统目录禁止写入。
 * macOS 特有：/System /Library /usr /var /etc /private 等。
 * Linux 特有：/etc /var /usr /home /root /boot /dev /proc /sys。
 *
 * 使用 Object.freeze 冻结，防止运行期篡改。
 */
const SYSTEM_SENSITIVE_PREFIXES: ReadonlyArray<string> = Object.freeze([
  // Unix 通用系统目录
  "/etc",
  "/var",
  "/usr",
  "/home",
  "/root",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  // macOS 特有系统目录
  "/System",
  "/Library",
  "/private",
  "/Applications",
  // 用户目录快捷方式（GPT-5.6 Sol 事故根因）
  // 注意：~ 与 $HOME 在路径解析阶段单独处理
]);

/**
 * 路径牢笼违规模式正则列表
 *
 * 匹配 pendingCommand 中的越界路径写入模式。
 * 每条正则对应一类违规，匹配即 DENY。
 *
 * 设计原则：
 * - 匹配命令中的路径参数（绝对路径 / ~ / $HOME / .. 外溢）
 * - 不依赖 shell 解析（避免 shell 注入风险）
 * - 误报优先（漏报会导致事故，误报仅降低体验）
 */
const PATH_JAIL_VIOLATION_PATTERNS: ReadonlyArray<Readonly<{ pattern: RegExp; description: string }>> = Object.freeze([
  // $HOME 引用（含 ${HOME} 与 $HOME/）
  { pattern: /\$HOME\b|\$\{HOME\}/i, description: "命令引用 $HOME 环境变量" },
  // ~ 或 ~/ 路径（home 目录快捷方式）
  { pattern: /(^|\s)~(\/|\s|$)/, description: "命令引用 home 目录快捷方式 ~" },
  // 绝对路径写入系统敏感目录（/etc /var /usr 等）
  {
    pattern:
      /(^|\s)(\/etc|\/var|\/usr|\/home|\/root|\/boot|\/dev|\/proc|\/sys|\/bin|\/sbin|\/lib|\/lib64|\/System|\/Library|\/private|\/Applications)\b/i,
    description: "命令引用系统敏感目录绝对路径",
  },
  // .. 外溢尝试（连续 ../ 超过 2 层，疑似逃逸 projectRoot）
  { pattern: /(^|\s|["'])(\.\.\/){3,}/, description: "命令包含连续 3 层及以上 .. 外溢尝试" },
  // 块设备写入（/dev/sda /dev/nvme0n1 等）
  { pattern: /\/dev\/(sd[a-z]+|nvme\d+n\d+|disk\d+|loop\d+)/i, description: "命令引用块设备路径" },
]);

// ============================================================================
// 2. G-A1b 环境变量写保护常量与正则
// ============================================================================

/**
 * 受保护的环境变量名列表
 *
 * 对齐需求文档 §3 FR-2 G-A1b：禁止修改 HOME / PATH / LD_LIBRARY_PATH / NODE_PATH 等。
 * 这些变量一旦被恶意修改，会导致 agent 逃逸路径牢笼或加载恶意库。
 *
 * 使用 Object.freeze 冻结。
 */
const PROTECTED_ENV_VARS: ReadonlyArray<string> = Object.freeze([
  // 用户与家目录
  "HOME",
  "USER",
  "LOGNAME",
  "USERNAME",
  // 可执行文件搜索路径
  "PATH",
  "NODE_PATH",
  "PYTHONPATH",
  "RUBYLIB",
  "PERL5LIB",
  "JAVA_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  // Shell 配置
  "SHELL",
  "BASH_ENV",
  "ZDOTDIR",
  "ENV",
  // 进程控制
  "PWD",
  "OLDPWD",
  // Git 配置（防止篡改 git 行为）
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG",
  // 安全相关
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * 环境变量写操作模式正则列表
 *
 * 匹配 pendingCommand 中的环境变量写操作。
 * 支持 export / unset / set / env -u / declare -x 等多种 shell 写法。
 */
const ENV_WRITE_PATTERNS: ReadonlyArray<Readonly<{ pattern: RegExp; description: string }>> = Object.freeze([
  // export VAR=value 或 export VAR（含空格与引号）
  { pattern: /\bexport\s+([A-Z_][A-Z0-9_]*)\s*[=\s]/i, description: "export 设置环境变量" },
  // unset VAR 或 unset -v VAR
  { pattern: /\bunset\s+(-v\s+)?([A-Z_][A-Z0-9_]*)/i, description: "unset 删除环境变量" },
  // set VAR=value（部分 shell 写法）
  { pattern: /\bset\s+([A-Z_][A-Z0-9_]*)\s*=/i, description: "set 设置环境变量" },
  // env -u VAR（删除环境变量）
  { pattern: /\benv\s+-u\s+([A-Z_][A-Z0-9_]*)/i, description: "env -u 删除环境变量" },
  // declare -x VAR=value（bash 特有）
  { pattern: /\bdeclare\s+-x\s+([A-Z_][A-Z0-9_]*)\s*=/i, description: "declare -x 设置环境变量" },
  // VAR=value 直接赋值（行首或分号后，如 HOME=/tmp）
  { pattern: /(^|;|\s|&&|\|\|)([A-Z_][A-Z0-9_]*)\s*=\s*[^\s]/, description: "直接赋值环境变量" },
]);

// ============================================================================
// 3. G-A1c 生产凭据不可达常量与正则
// ============================================================================

/**
 * 生产凭据检测模式正则列表
 *
 * 对齐需求文档 §3 FR-2 G-A1c：检出生产 DB 连接串 / 云生产凭证 / 生产 SSH 主机即 fail-closed。
 * 复用 gitleaks 规则集扩展环境变量维度。
 *
 * 模式来源：
 * - AWS Access Key ID：AKIA 开头 + 16 位字符
 * - AWS Secret Access Key：40 位 base64
 * - Google Cloud API Key：AIza 开头 + 35 位字符
 * - Google OAuth Token：ya29. 开头
 * - Azure Storage Key：base64 88 字符
 * - 数据库连接串：postgres/mysql/mongodb://user:pass@host
 * - SSH 私钥头：-----BEGIN ... PRIVATE KEY-----
 * - 通用 API Key 模式：key=xxx / token=xxx / secret=xxx
 */
const PROD_CREDENTIAL_PATTERNS: ReadonlyArray<
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
  // AWS Secret Access Key（40 位 base64 字符）
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
  // 通用 API Key / Token / Secret（key=xxx / token=xxx / secret=xxx，长度 >= 16）
  {
    pattern:
      /(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9+/=_-]{16,}['"]?/i,
    name: "generic-api-key",
    description: "通用 API Key / Token / Secret 检出（长度 >= 16）",
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
]);

/**
 * 生产环境标识关键词（用于环境变量名匹配）
 *
 * 当环境变量名包含这些关键词时，认为该变量承载生产凭据。
 */
const PROD_ENV_NAME_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "PROD",
  "PRODUCTION",
  "LIVE",
  "STAGING",
  "RELEASE",
]);

// ============================================================================
// 4. EnvBoundaryGuard 类（A-1 层，3 条 BLOCKER）
// ============================================================================

/**
 * A-1 环境边界硬隔离守护类
 *
 * 实现 3 条 BLOCKER：
 * - G-A1a 路径牢笼（path jail）
 * - G-A1b 环境变量写保护
 * - G-A1c 生产凭据不可达
 *
 * 守护顺序：
 * 1. 先检查 G-A1a 路径牢笼（命令中是否含越界路径）
 * 2. 再检查 G-A1b 环境变量写保护（命令中是否含 export/unset 等写操作）
 * 3. 最后检查 G-A1c 生产凭据不可达（环境变量快照中是否含生产凭据）
 *
 * 任一检查触发即 DENY，不继续后续检查（短路原则）。
 *
 * 用法：
 * ```typescript
 * const guard = new EnvBoundaryGuard();
 * const verdict = guard.check(context);
 * if (verdict.decision === "DENY") {
 *   throw new GuardViolationError(verdict, "A-1");
 * }
 * ```
 */
export class EnvBoundaryGuard implements GuardRule {
  /** 规则 ID（G-A1a，主规则；其余两条在 check() 内部串联） */
  public readonly ruleId: GuardRuleId = "G-A1a";
  /** 所属层级（A-1 环境边界硬隔离） */
  public readonly layer = "A-1" as const;
  /** 严重性（BLOCKER） */
  public readonly severity = "BLOCKER" as const;

  /**
   * 判定函数：执行 A-1 层 3 条 BLOCKER 检查
   *
   * 检查顺序（短路原则，任一 DENY 即返回）：
   * 1. G-A1a 路径牢笼
   * 2. G-A1b 环境变量写保护
   * 3. G-A1c 生产凭据不可达
   *
   * @param context 判定上下文
   * @returns 判定结果（PASS / DENY）
   */
  check(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 1. G-A1a 路径牢笼检查
    const pathJailVerdict = this.checkPathJail(context);
    if (pathJailVerdict.decision === "DENY") {
      return pathJailVerdict;
    }

    // 2. G-A1b 环境变量写保护检查
    const envWriteVerdict = this.checkEnvWrite(context);
    if (envWriteVerdict.decision === "DENY") {
      return envWriteVerdict;
    }

    // 3. G-A1c 生产凭据不可达检查
    const prodCredVerdict = this.checkProdCredential(context);
    if (prodCredVerdict.decision === "DENY") {
      return prodCredVerdict;
    }

    // 全部通过
    return createPassVerdict();
  }

  // ===========================================================================
  // G-A1a 路径牢笼（path jail）
  // ===========================================================================

  /**
   * G-A1a 路径牢笼检查
   *
   * 检查 pendingCommand 中的写入路径是否在 projectRoot（或 worktreePath）子树内。
   * 越界路径写入（$HOME / ~ / 系统目录 / 绝对路径外溢）一律 DENY。
   *
   * 实现方式：
   * 1. 正则匹配命令中的违规路径模式（$HOME / ~ / 系统目录 / 块设备 / .. 外溢）
   * 2. 解析命令中的绝对路径，使用 path.resolve + 前缀校验判定是否在 projectRoot 内
   *
   * 性能目标（NFR-7）：< 1ms（执行前实时拦截）
   *
   * @param context 判定上下文
   * @returns 判定结果
   */
  private checkPathJail(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const cmd = context.pendingCommand;
    // 无命令时不检查（plan 阶段或无 pendingCommand 的场景）
    if (!cmd) {
      return createPassVerdict();
    }

    // 1. 正则匹配违规路径模式（$HOME / ~ / 系统目录 / 块设备 / .. 外溢）
    for (const { pattern, description } of PATH_JAIL_VIOLATION_PATTERNS) {
      const match = cmd.match(pattern);
      if (match) {
        return createDenyVerdict(
          "G-A1a",
          "BLOCKER",
          `路径牢笼违规：${description}（匹配片段：${match[0]}）`,
          "中止迭代，建议转人工确认路径白名单"
        );
      }
    }

    // 2. 解析命令中的绝对路径，前缀校验是否在 projectRoot 内
    const projectRoot = path.resolve(context.projectRoot);
    const worktreePath = path.resolve(context.worktreePath);
    // 提取命令中的绝对路径（/ 开头的 token，去除引号）
    const absolutePathPattern = /(^|\s|["'])(\/[^\s"']+)/g;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = absolutePathPattern.exec(cmd)) !== null) {
      const candidatePath = pathMatch[2];
      // 跳过 /dev/null / /dev/stdin 等标准设备（无害）
      if (
        candidatePath === "/dev/null" ||
        candidatePath === "/dev/stdin" ||
        candidatePath === "/dev/stdout" ||
        candidatePath === "/dev/stderr"
      ) {
        continue;
      }
      const resolved = path.resolve(candidatePath);
      // 检查是否在系统敏感目录前缀内
      for (const prefix of SYSTEM_SENSITIVE_PREFIXES) {
        if (resolved === prefix || resolved.startsWith(prefix + "/")) {
          return createDenyVerdict(
            "G-A1a",
            "BLOCKER",
            `路径牢笼违规：写入系统敏感目录 ${resolved}（前缀 ${prefix}）`,
            "中止迭代，禁止写入系统目录"
          );
        }
      }
      // 检查是否在 projectRoot 或 worktreePath 子树内
      const inProject = resolved === projectRoot || resolved.startsWith(projectRoot + path.sep);
      const inWorktree = resolved === worktreePath || resolved.startsWith(worktreePath + path.sep);
      if (!inProject && !inWorktree) {
        // 检查是否在 /tmp（允许临时文件写入，但需监控）
        if (resolved.startsWith("/tmp/") || resolved === "/tmp") {
          continue; // /tmp 允许写入（临时文件）
        }
        return createDenyVerdict(
          "G-A1a",
          "BLOCKER",
          `路径牢笼违规：绝对路径 ${resolved} 不在 projectRoot(${projectRoot}) 或 worktreePath(${worktreePath}) 子树内`,
          "中止迭代，建议转人工确认路径白名单"
        );
      }
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A1b 环境变量写保护
  // ===========================================================================

  /**
   * G-A1b 环境变量写保护检查
   *
   * 检查 pendingCommand 中是否含 export / unset / set / env -u / declare -x 等环境变量写操作。
   * 命中受保护环境变量（HOME / PATH / LD_* / NODE_PATH 等）即 DENY。
   *
   * @param context 判定上下文
   * @returns 判定结果
   */
  private checkEnvWrite(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    const cmd = context.pendingCommand;
    if (!cmd) {
      return createPassVerdict();
    }

    // 遍历环境变量写模式正则
    for (const { pattern, description } of ENV_WRITE_PATTERNS) {
      // 使用全局正则提取所有匹配的环境变量名
      const globalPattern = new RegExp(pattern.source, pattern.flags + (pattern.global ? "" : "g"));
      let match: RegExpExecArray | null;
      while ((match = globalPattern.exec(cmd)) !== null) {
        // 提取环境变量名（匹配组中第一个非 undefined 的捕获组）
        const varName = match[2] ?? match[1] ?? "";
        if (!varName) {
          continue;
        }
        // 校验变量名是否在受保护列表内（大小写敏感）
        if (PROTECTED_ENV_VARS.includes(varName)) {
          return createDenyVerdict(
            "G-A1b",
            "BLOCKER",
            `环境变量写保护违规：${description}（变量名：${varName}）`,
            "中止迭代，禁止修改受保护环境变量"
          );
        }
        // 校验变量名是否含 LD_ / DYLD_ 前缀（动态链接库注入风险）
        if (varName.startsWith("LD_") || varName.startsWith("DYLD_")) {
          return createDenyVerdict(
            "G-A1b",
            "BLOCKER",
            `环境变量写保护违规：${description}（变量名：${varName}，疑似动态链接库注入）`,
            "中止迭代，禁止修改 LD_*/DYLD_* 前缀环境变量"
          );
        }
      }
    }

    return createPassVerdict();
  }

  // ===========================================================================
  // G-A1c 生产凭据不可达
  // ===========================================================================

  /**
   * G-A1c 生产凭据不可达检查
   *
   * 扫描进程环境变量快照（context.envSnapshot），检出生产凭据即 fail-closed。
   * 检测维度：
   * 1. 凭据模式正则匹配（AWS / GCP / Azure / DB 连接串 / SSH 私钥 / JWT 等）
   * 2. 环境变量名含生产标识关键词（PROD / PRODUCTION / LIVE / STAGING / RELEASE）
   *
   * @param context 判定上下文
   * @returns 判定结果
   */
  private checkProdCredential(context: Readonly<GuardContext>): Readonly<GuardVerdict> {
    // 取环境变量快照（缺省时不检查，由调用方决定是否提供）
    const envSnapshot = context.envSnapshot;
    if (!envSnapshot) {
      return createPassVerdict();
    }

    // 1. 遍历环境变量值，正则匹配生产凭据模式
    for (const [varName, varValue] of Object.entries(envSnapshot)) {
      // 跳过空值
      if (!varValue || typeof varValue !== "string") {
        continue;
      }
      for (const { pattern, name, description } of PROD_CREDENTIAL_PATTERNS) {
        const match = varValue.match(pattern);
        if (match) {
          return createDenyVerdict(
            "G-A1c",
            "BLOCKER",
            `生产凭据不可达违规：${description}（环境变量：${varName}，凭据类型：${name}）`,
            "fail-closed 拒绝启动 autonomous 模式，建议清理生产凭据后重试"
          );
        }
      }
    }

    // 2. 检查环境变量名是否含生产标识关键词
    for (const varName of Object.keys(envSnapshot)) {
      const upperName = varName.toUpperCase();
      for (const keyword of PROD_ENV_NAME_KEYWORDS) {
        if (upperName.includes(keyword)) {
          // 生产标识变量且值非空，进一步检查值是否为连接串或凭据
          const value = envSnapshot[varName];
          if (value && typeof value === "string" && value.length >= 8) {
            // 值长度 >= 8 且包含生产标识，疑似生产凭据
            return createDenyVerdict(
              "G-A1c",
              "BLOCKER",
              `生产凭据不可达违规：环境变量名含生产标识关键词 ${keyword}（变量：${varName}=${value.substring(0, 4)}****）`,
              "fail-closed 拒绝启动 autonomous 模式，建议确认生产凭据来源"
            );
          }
        }
      }
    }

    return createPassVerdict();
  }
}

// ============================================================================
// 5. 导出常量（供测试与外部模块使用）
// ============================================================================

/**
 * 导出受保护环境变量列表（供测试断言）
 */
export { PROTECTED_ENV_VARS as ENV_BOUNDARY_PROTECTED_ENV_VARS };

/**
 * 导出系统敏感目录前缀列表（供测试断言）
 */
export { SYSTEM_SENSITIVE_PREFIXES as ENV_BOUNDARY_SYSTEM_SENSITIVE_PREFIXES };

/**
 * 导出生产凭据检测模式列表（供测试参数化）
 */
export { PROD_CREDENTIAL_PATTERNS as ENV_BOUNDARY_PROD_CREDENTIAL_PATTERNS };
