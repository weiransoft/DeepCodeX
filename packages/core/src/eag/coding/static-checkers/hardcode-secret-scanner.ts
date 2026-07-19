/**
 * 硬编码密钥扫描判定器（HardcodeSecretScanner）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E6：密钥与配置（硬编码密钥模式扫描）
 * - TCS-SEC-02：扫描出硬编码密钥（gitleaks 规则集移植）
 *
 * 判定算法：
 * 移植 gitleaks 规则集，使用 30+ 正则模式扫描代码中的硬编码密钥：
 * - AWS Access Key：AKIA[0-9A-Z]{16}
 * - AWS Secret Key：(?i)aws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]
 * - 私钥：-----BEGIN [A-Z ]*PRIVATE KEY-----
 * - JWT：eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*
 * - 通用密钥赋值：(?i)(api[_-]?key|password|secret|token|passwd)\s*[:=]\s*['"][^'"]{8,}['"]
 * - GitHub Token：gh[pousr]_[A-Za-z0-9]{36}
 * - Slack Token：xox[baprs]-[A-Za-z0-9-]+
 * - Stripe Key：sk_live_[A-Za-z0-9]+ / pk_live_[A-Za-z0-9]+
 * - Google API Key：AIza[0-9A-Za-z_-]{35}
 * - 等等
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E6
 * - EAG 方案 §5.8.5 漏洞扫描与修复闭环 TCS-SEC-02
 * - gitleaks 规则集：https://github.com/gitleaks/gitleaks/tree/master/config
 *
 * 误报控制：
 * - 跳过 .env.example / .env.sample 文件（占位符模板）
 * - 跳过注释行内的密钥模式
 * - 跳过占位符值（如 YOUR_API_KEY / xxx / <placeholder>）
 * - 跳过 process.env.XXX 引用（环境变量读取）
 *
 * @module eag/coding/static-checkers/hardcode-secret-scanner
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { buildViolations, extractFilePathFromComment, lineOf } from "./checker-utils";

/**
 * 密钥扫描规则
 *
 * 每条规则包含：
 * - name：规则名称（如 "AWS Access Key ID"）
 * - pattern：正则模式（全局匹配）
 * - description：违规描述模板
 *
 * 注意：JavaScript 正则不支持 (?i) 内联标志语法，大小写不敏感通过 flags 字段中的 "i" 标记实现。
 */
interface SecretRule {
  /** 规则名称 */
  readonly name: string;
  /** 正则模式（字符串形式，便于携带 flags） */
  readonly pattern: string;
  /** 正则标志（如 "g" 全局匹配 / "gi" 全局 + 大小写不敏感） */
  readonly flags: string;
  /** 违规描述模板 */
  readonly descriptionTemplate: string;
}

/**
 * gitleaks 规则集移植（30+ 模式）
 *
 * 顺序按规则集分组：AWS / 私钥 / JWT / GitHub / Slack / Stripe / Google / 通用 / 数据库 / 其他
 */
const SECRET_RULES: ReadonlyArray<SecretRule> = Object.freeze([
  // AWS 系列
  {
    name: "AWS Access Key ID",
    pattern: "AKIA[0-9A-Z]{16}",
    flags: "g",
    descriptionTemplate: "硬编码 AWS Access Key ID（AKIA 前缀 + 16 位大写字母数字）",
  },
  {
    name: "AWS Secret Access Key",
    pattern: "aws_secret_access_key\\s*[:=]\\s*['\"]([A-Za-z0-9/+=]{40})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码 AWS Secret Access Key",
  },
  {
    name: "AWS Account ID",
    pattern: "aws_account_id\\s*[:=]\\s*['\"]\\d{12}['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码 AWS Account ID（12 位数字）",
  },
  // 私钥
  {
    name: "Private Key",
    pattern: "-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
    flags: "g",
    descriptionTemplate: "硬编码私钥（PEM 格式，含 BEGIN PRIVATE KEY 头）",
  },
  // JWT
  {
    name: "JWT Token",
    pattern: "eyJ[a-zA-Z0-9_-]{8,}\\.eyJ[a-zA-Z0-9_-]{8,}\\.[a-zA-Z0-9_-]{8,}",
    flags: "g",
    descriptionTemplate: "硬编码 JWT Token（三段式 header.payload.signature）",
  },
  // GitHub
  {
    name: "GitHub Personal Access Token",
    pattern: "ghp_[A-Za-z0-9]{36}",
    flags: "g",
    descriptionTemplate: "硬编码 GitHub Personal Access Token（ghp_ 前缀 + 36 位）",
  },
  {
    name: "GitHub OAuth Token",
    pattern: "gho_[A-Za-z0-9]{36}",
    flags: "g",
    descriptionTemplate: "硬编码 GitHub OAuth Token（gho_ 前缀）",
  },
  {
    name: "GitHub User Token",
    pattern: "ghu_[A-Za-z0-9]{36}",
    flags: "g",
    descriptionTemplate: "硬编码 GitHub User Token（ghu_ 前缀）",
  },
  {
    name: "GitHub Server Token",
    pattern: "ghs_[A-Za-z0-9]{36}",
    flags: "g",
    descriptionTemplate: "硬编码 GitHub Server Token（ghs_ 前缀）",
  },
  {
    name: "GitHub Refresh Token",
    pattern: "ghr_[A-Za-z0-9]{76}",
    flags: "g",
    descriptionTemplate: "硬编码 GitHub Refresh Token（ghr_ 前缀）",
  },
  // Slack
  {
    name: "Slack Bot Token",
    pattern: "xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24}",
    flags: "g",
    descriptionTemplate: "硬编码 Slack Bot Token（xoxb- 前缀）",
  },
  {
    name: "Slack User Token",
    pattern: "xox[porsa]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}",
    flags: "g",
    descriptionTemplate: "硬编码 Slack User Token（xox[porsa]- 前缀）",
  },
  {
    name: "Slack Webhook URL",
    pattern: "https://hooks\\.slack\\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+",
    flags: "g",
    descriptionTemplate: "硬编码 Slack Webhook URL",
  },
  // Stripe
  {
    name: "Stripe Live Secret Key",
    pattern: "sk_live_[A-Za-z0-9]{24,}",
    flags: "g",
    descriptionTemplate: "硬编码 Stripe Live Secret Key（sk_live_ 前缀）",
  },
  {
    name: "Stripe Live Publishable Key",
    pattern: "pk_live_[A-Za-z0-9]{24,}",
    flags: "g",
    descriptionTemplate: "硬编码 Stripe Live Publishable Key（pk_live_ 前缀）",
  },
  {
    name: "Stripe Restricted Key",
    pattern: "rk_live_[A-Za-z0-9]{24,}",
    flags: "g",
    descriptionTemplate: "硬编码 Stripe Restricted Key（rk_live_ 前缀）",
  },
  // Google
  {
    name: "Google API Key",
    pattern: "AIza[0-9A-Za-z_-]{35}",
    flags: "g",
    descriptionTemplate: "硬编码 Google API Key（AIza 前缀 + 35 位）",
  },
  {
    name: "Google OAuth Access Token",
    pattern: "ya29\\.[A-Za-z0-9_-]+",
    flags: "g",
    descriptionTemplate: "硬编码 Google OAuth Access Token（ya29. 前缀）",
  },
  {
    name: "Google OAuth Client ID",
    pattern: "\\d+-[A-Za-z0-9_]{32}\\.apps\\.googleusercontent\\.com",
    flags: "g",
    descriptionTemplate: "硬编码 Google OAuth Client ID",
  },
  // Azure
  {
    name: "Azure Storage Account Key",
    pattern: "AccountKey=[A-Za-z0-9+/=]{88}",
    flags: "g",
    descriptionTemplate: "硬编码 Azure Storage Account Key",
  },
  {
    name: "Azure Connection String",
    pattern: "DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{88}",
    flags: "g",
    descriptionTemplate: "硬编码 Azure Storage Connection String",
  },
  // 通用密钥赋值
  {
    name: "API Key Assignment",
    pattern: "\\b(api[_-]?key|apikey)\\s*[:=]\\s*['\"]([A-Za-z0-9_\\-./+]{16,})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码 API Key 赋值（变量名含 api_key/apikey）",
  },
  {
    name: "Password Assignment",
    pattern: "\\b(password|passwd|pwd)\\s*[:=]\\s*['\"]([^'\"\\s]{6,})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码密码赋值（变量名含 password/passwd/pwd）",
  },
  {
    name: "Secret Assignment",
    pattern: "\\b(secret)\\s*[:=]\\s*['\"]([A-Za-z0-9_\\-./+]{12,})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码 Secret 赋值（变量名含 secret）",
  },
  {
    name: "Token Assignment",
    pattern: "\\b(token)\\s*[:=]\\s*['\"]([A-Za-z0-9_\\-./+]{20,})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码 Token 赋值（变量名含 token）",
  },
  // 数据库连接串
  {
    name: "Database Connection String",
    pattern: "(?:postgres|postgresql|mysql|mongodb|redis)://[^:\\s]+:[^@\\s]+@[^\\s'\"]+",
    flags: "g",
    descriptionTemplate: "硬编码数据库连接串（含用户名密码）",
  },
  // 其他
  {
    name: "Generic High Entropy String",
    pattern: "\\b(private[_-]?key|client[_-]?secret)\\s*[:=]\\s*['\"]([A-Za-z0-9+/=_\\-]{32,})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码高熵密钥（private_key / client_secret）",
  },
  {
    name: "Bearer Token",
    pattern: "Bearer\\s+[A-Za-z0-9_\\-./+=]{20,}",
    flags: "g",
    descriptionTemplate: "硬编码 Bearer Token（HTTP Authorization 头）",
  },
  {
    name: "Facebook Access Token",
    pattern: "EAACEdEose0cBA[0-9A-Za-z]+",
    flags: "g",
    descriptionTemplate: "硬编码 Facebook Access Token",
  },
  {
    name: "Twitter Access Token",
    pattern: "twitter[_-]?(?:api[_-]?)?(?:access[_-]?)?token\\s*[:=]\\s*['\"]([0-9]+-[A-Za-z0-9]{40})['\"]",
    flags: "gi",
    descriptionTemplate: "硬编码 Twitter Access Token",
  },
  {
    name: "Mailgun API Key",
    pattern: "key-[0-9a-zA-Z]{32}",
    flags: "g",
    descriptionTemplate: "硬编码 Mailgun API Key",
  },
  {
    name: "Twilio API Key",
    pattern: "SK[0-9a-fA-F]{32}",
    flags: "g",
    descriptionTemplate: "硬编码 Twilio API Key",
  },
  {
    name: "PayPal Braintree Access Token",
    pattern: "access_token\\$production\\$[0-9a-z]{16}\\$[0-9a-f]{32}",
    flags: "g",
    descriptionTemplate: "硬编码 PayPal Braintree Access Token",
  },
]);

/**
 * 占位符白名单（避免误报）
 *
 * 密钥值匹配以下模式时视为占位符，不算违规：
 * - YOUR_API_KEY / YOUR_SECRET / YOUR_PASSWORD 等大写占位
 * - <placeholder> / ${ENV_VAR} / process.env.XXX 形式
 * - xxx / yyy / zzz / changeme / placeholder / example 等常见占位
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^YOUR_[A-Z_]+$/,
  /^<.+>$/,
  /^\$\{.+\}$/,
  /^process\.env\./,
  /^(x{3,}|y{3,}|z{3,})$/i,
  /^(changeme|placeholder|example|todo|fixme|none|null|undefined|empty|sample|test)$/i,
  /^[A-Z_]+_HERE$/,
]);

/**
 * 判定密钥值是否为占位符
 *
 * @param value 密钥值
 * @returns true 表示占位符（豁免）
 */
function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/**
 * 判定文件路径是否为密钥模板文件（豁免）
 *
 * .env.example / .env.sample / .env.template 等模板文件中的密钥占位符不算违规。
 *
 * @param filePath 文件路径
 * @returns true 表示模板文件（豁免）
 */
function isEnvTemplateFile(filePath: string): boolean {
  return /\.(env\.example|env\.sample|env\.template|env\.defaults)$/i.test(filePath);
}

/**
 * 硬编码密钥扫描判定器
 *
 * 实现 StaticChecker 协议，负责 E6 与 TCS-SEC-02 两条红线的静态判定。
 * E6 与 TCS-SEC-02 在判定逻辑上一致（均为硬编码密钥扫描），仅 redlineId 不同。
 */
export class HardcodeSecretScanner implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E6", "TCS-SEC-02"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 遍历所有 artifacts
   * 2. 跳过 .env.example 等模板文件
   * 3. 对每个文件内容，应用 30+ gitleaks 规则模式
   * 4. 跳过注释行内的匹配（避免误报）
   * 5. 跳过占位符值
   * 6. 收集违规点，构建 RedlineResult
   *
   * @param artifacts 产出物列表（路径 + 内容）
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      // 模板文件豁免
      if (isEnvTemplateFile(filePath)) {
        continue;
      }

      const content = artifact.content;
      const lines = content.split(/\r?\n/);

      // 对每条规则应用正则匹配
      for (const rule of SECRET_RULES) {
        // 构造正则实例（避免全局 lastIndex 在多次调用间残留）
        const regex = new RegExp(rule.pattern, rule.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          const matchText = match[0];
          const matchStart = match.index;

          // 提取密钥值（取最后一个捕获组，或整个匹配）
          const groups = match.slice(1);
          const secretValue = groups.length > 0 ? groups[groups.length - 1] : matchText;

          // 跳过占位符
          if (isPlaceholderValue(secretValue)) {
            continue;
          }

          const lineNum = lineOf(content, matchStart);

          // 跳过注释行内的匹配
          const matchedLine = lines[lineNum - 1] ?? "";
          if (/^\s*\/\//.test(matchedLine) || /^\s*\*/.test(matchedLine)) {
            continue;
          }
          // 跳过 process.env.XXX 形式（环境变量读取，非硬编码）
          if (/process\.env\./.test(matchedLine) && !/['"]process\.env\./.test(matchedLine)) {
            // 但若匹配项本身是字面量字符串（非 process.env 引用），仍判违规
            // 通过检查 matchedLine 中匹配位置附近是否为 process.env 引用
            const matchEnd = matchStart + matchText.length;
            const lineStart = content.lastIndexOf("\n", matchStart) + 1;
            const lineEnd = content.indexOf("\n", matchEnd);
            const fullLine = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
            // 若匹配文本来自 process.env.XXX 引用（变量名而非字面量），跳过
            if (
              fullLine.includes("process.env.") &&
              !fullLine.includes(`'${matchText}'`) &&
              !fullLine.includes(`"${matchText}"`)
            ) {
              continue;
            }
          }

          violations.push({
            filePath,
            line: lineNum,
            description:
              `检测到硬编码密钥（${rule.name}）：${rule.descriptionTemplate}。` +
              `匹配片段：${matchText.length > 60 ? matchText.slice(0, 60) + "..." : matchText}`,
            fixSuggestion:
              `1. 立即撤销泄漏的密钥（在密钥管理系统/云控制台）\n` +
              `2. 替换为环境变量读取：const apiKey = process.env.API_KEY!;\n` +
              `3. 密钥存储在 .env 文件（加入 .gitignore）或 Secret Manager\n` +
              `4. 检查 git 历史，使用 BFG Repo-Cleaner 清理泄漏记录`,
          });
        }
      }
    }

    return buildViolations(redline.id, violations);
  }
}
