/**
 * 敏感信息过滤器（SensitiveInfoRedactor）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §8.6 敏感信息过滤层（US-PRIV-001）
 *
 * 职责：
 * - 在记忆数据持久化前强制脱敏（不可关闭的隐私红线关卡）
 * - 提供 11 条内置脱敏规则（6 条通用凭据 + 5 条平台专用令牌）
 * - 审计日志只记录规则名/位置/digest，绝不记录明文片段
 *
 * 调用契约（§8.6.4 集成点）：
 * - MemoryPersistence.write() 落盘前必须调用 redactMemory()
 * - UserGlobalMemoryManager.extractFromConversation() 提取 facts 后入库前必须调用 redact()
 * 两处均为同步前置关卡，不可配置关闭（隐私红线不接受开关）。
 *
 * 关键实现要点（§8.6.2 架构师审查关键发现）：
 * 1. 逐规则匹配前必须执行 pattern.lastIndex = 0（/g 正则 lastIndex 跨调用残留会导致漏检）
 * 2. 命中按 offset 降序排序，从后向前替换（避免替换改变后续命中的偏移量）
 * 3. digest = sha256(明文片段).hex.slice(0, 8)，不可逆，用于审计对账
 * 4. 已被替换为 [REDACTED] 的片段不再参与后续规则匹配
 *
 * @module v2/memory/redaction
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// 1. 接口定义（§8.6.1）
// ============================================================================

/**
 * 单条脱敏规则：命中的敏感片段统一替换为 replacement（默认 "[REDACTED]"）
 *
 * 注意：pattern 均为带全局标志 /g 的模块级共享正则实例，
 * 因此每次执行匹配前必须重置 lastIndex（见 SensitiveInfoRedactor.redact 实现注释），
 * 否则 /g 正则的 lastIndex 会跨调用残留，导致偶发漏检。
 */
export interface RedactionRule {
  /** 规则名（审计日志记录用，如 "aws-access-key"），全库唯一 */
  name: string;
  /** 带全局标志 /g 的正则实例 */
  pattern: RegExp;
  /** 替换文本（默认 "[REDACTED]"） */
  replacement: string;
  /** 严重等级（审计用，不影响替换行为） */
  severity: "low" | "medium" | "high";
}

/**
 * 一次脱敏命中记录
 *
 * 隐私红线：绝不记录明文片段，只记录规则名与位置（offset/length）。
 * 审计方只能知道"哪个规则在何处命中"，无法从日志反推原始密钥。
 */
export interface RedactionHit {
  /** 命中的规则名 */
  ruleName: string;
  /** 命中片段在原文中的起始偏移（0-based） */
  offset: number;
  /** 命中片段的字符长度 */
  length: number;
  /** 命中片段的 SHA-256 摘要前 8 位（用于审计对账，不可逆） */
  digest: string;
  /** 严重等级 */
  severity: "low" | "medium" | "high";
}

/**
 * 脱敏结果
 */
export interface RedactionResult {
  /** 脱敏后的安全文本（敏感片段已替换为 [REDACTED]） */
  sanitized: string;
  /** 命中列表（为空表示无敏感信息，此时 sanitized === 原文） */
  hits: RedactionHit[];
}

/**
 * 追加到 ~/.deepcode/memory/redaction.log 的日志行（JSON Lines，每行一条）
 *
 * 隐私红线：本结构不含、也不允许扩展任何"明文片段"字段。
 * digest 用于审计对账：取命中片段的 SHA-256 前 8 位十六进制，不可逆；
 * 同一明文产生同一 digest，可对账"两次命中是否同一把密钥"，但无法反推明文。
 */
export interface RedactionLogEntry {
  /** 日志记录时间（ISO-8601） */
  timestamp: string;
  /** 被脱敏的记忆文件名（不含目录，如 "global.json"） */
  memoryFile: string;
  /** 命中的规则名 */
  ruleName: string;
  /** 命中片段在原文中的起始偏移 */
  offset: number;
  /** 命中片段的字符长度 */
  length: number;
  /** 命中片段的 SHA-256 摘要前 8 位 */
  digest: string;
  /** 严重等级 */
  severity: "low" | "medium" | "high";
}

// ============================================================================
// 2. DEFAULT_REDACTION_RULES 内置规则集（11 条，§8.6.3）
// ============================================================================

/**
 * 内置脱敏规则集（11 条）
 *
 * 前 6 条为通用凭据规则（直接对应 PRD 验收示例 password=xxx / api_key: xxx / Bearer xxx）；
 * 后 5 条为平台专用令牌规则（v2.3 架构师建议新增），覆盖 GitHub / GitLab / Slack / Google / JWT 五类高频泄露令牌。
 *
 * 规则冲突处理：多规则命中同一片段时，按规则集声明顺序先匹配者优先替换；
 * 替换自后向前执行、命中偏移互不重叠，已被替换为 [REDACTED] 的片段不再参与后续规则匹配。
 */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  // ── 通用凭据规则（6 条）──
  {
    name: "generic-password",
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,
    replacement: "[REDACTED]",
    severity: "medium",
  },
  {
    name: "generic-api-key",
    pattern: /(?:api[_-]?key|api[_-]?secret|access[_-]?token)\s*[:=]\s*\S+/gi,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "bearer-token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "basic-auth-url",
    pattern: /https?:\/\/[^/\s:@]+:[^/\s:@]+@/g,
    replacement: "https://[REDACTED]@",
    severity: "medium",
  },
  // ── 平台专用令牌规则（5 条，v2.3 架构师建议新增）──
  {
    name: "github-pat",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "gitlab-pat",
    pattern: /glpat-[A-Za-z0-9_-]{20}/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "slack-token",
    pattern: /xox[bp]-[A-Za-z0-9-]+/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "google-api-key",
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
  {
    name: "jwt-token",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED]",
    severity: "high",
  },
];

// ============================================================================
// 3. SensitiveInfoRedactor 类（§8.6.2）
// ============================================================================

/**
 * 默认审计日志路径：~/.deepcode/memory/redaction.log
 */
const DEFAULT_LOG_PATH = path.join(os.homedir(), ".deepcode", "memory", "redaction.log");

/**
 * 敏感信息过滤器：记忆持久化前的强制关卡
 *
 * 调用契约：
 * - MemoryPersistence.write()（§8.5）落盘前必须调用 redactMemory()；
 * - UserGlobalMemoryManager.extractFromConversation()（§8.1）提取 facts 后、入库前必须调用。
 * 两处均为同步前置关卡，不可配置关闭（隐私红线不接受开关）。
 */
export class SensitiveInfoRedactor {
  /**
   * 创建敏感信息过滤器
   *
   * @param rules 规则集（默认 DEFAULT_REDACTION_RULES 11 条内置规则；自定义规则只能追加，不能移除内置规则）
   * @param logPath 审计日志路径（JSON Lines 追加写，默认 ~/.deepcode/memory/redaction.log）
   */
  constructor(
    private readonly rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
    private readonly logPath: string = DEFAULT_LOG_PATH
  ) {}

  /**
   * 对纯文本脱敏；命中时异步追加审计日志（不阻塞返回值，日志写入失败仅告警不抛出）
   *
   * 关键实现（架构师审查关键发现 —— lastIndex reset）：
   * 逐规则匹配前必须执行 `pattern.lastIndex = 0`。
   * 原因：内置规则均为带 /g 标志的共享正则实例，JS 的 /g 正则在 exec/test 后
   * 会更新 lastIndex；若不重置，下一次调用将从上一次命中位置之后开始匹配，
   * 造成跨调用残留状态与偶发漏检（同一文本两次调用结果不一致）。
   *
   * 实现步骤：
   * 1. 遍历规则集：先 pattern.lastIndex = 0，再循环 exec 收集全部命中（规则名/offset/length）；
   * 2. 命中按 offset 降序排序，从后向前替换（避免替换改变后续命中的偏移量）；
   * 3. 对每条命中计算 digest = sha256(明文片段).hex.slice(0, 8)，组装 RedactionLogEntry；
   * 4. 调用 appendLog 追加审计日志（仅规则名/位置/digest，严禁写入明文片段）；
   * 5. 返回 { sanitized, hits }。
   *
   * @param text 待脱敏的纯文本
   * @param memoryFile 被脱敏的记忆文件名（审计日志归属用，如 "global.json"）
   * @returns 脱敏结果（sanitized + hits）
   */
  redact(text: string, memoryFile: string): RedactionResult {
    // 无文本直接返回空结果
    if (!text || text.length === 0) {
      return { sanitized: text, hits: [] };
    }

    // 收集所有命中（跨规则）
    const allHits: Array<{ rule: RedactionRule; offset: number; length: number; matchedText: string }> = [];

    for (const rule of this.rules) {
      // 关键：/g 正则 lastIndex 重置，避免跨调用残留
      rule.pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      // 使用 exec 循环收集全部命中（避免 String.matchAll 在某些边界的行为差异）
      while ((match = rule.pattern.exec(text)) !== null) {
        const matchedText = match[0];
        const offset = match.index;
        const length = matchedText.length;

        // 检查是否与已收集的命中重叠（已被替换的片段不再参与后续规则匹配）
        const overlaps = allHits.some(
          (existing) => offset < existing.offset + existing.length && offset + length > existing.offset
        );
        if (!overlaps) {
          allHits.push({ rule, offset, length, matchedText });
        }

        // 防止零宽匹配导致死循环
        if (match.index === rule.pattern.lastIndex) {
          rule.pattern.lastIndex++;
        }
      }
      // 再次重置，确保下次调用干净状态
      rule.pattern.lastIndex = 0;
    }

    // 无命中直接返回原文
    if (allHits.length === 0) {
      return { sanitized: text, hits: [] };
    }

    // 按 offset 降序排序（从后向前替换，避免偏移量变化）
    allHits.sort((a, b) => b.offset - a.offset);

    // 从后向前替换，同时构建 hits 列表（按原文 offset 升序）
    let sanitized = text;
    const hits: RedactionHit[] = [];
    const logEntries: RedactionLogEntry[] = [];
    const timestamp = new Date().toISOString();

    for (const hit of allHits) {
      // 截取命中片段的明文（用于 digest 计算，绝不写入日志）
      const plainText = hit.matchedText;
      // digest = sha256(明文).hex.slice(0, 8)
      const digest = createHash("sha256").update(plainText, "utf8").digest("hex").slice(0, 8);

      // 替换为 replacement
      sanitized = sanitized.slice(0, hit.offset) + hit.rule.replacement + sanitized.slice(hit.offset + hit.length);

      // 构建 RedactionHit（不包含明文）
      hits.push({
        ruleName: hit.rule.name,
        offset: hit.offset,
        length: hit.length,
        digest,
        severity: hit.rule.severity,
      });

      // 构建 RedactionLogEntry（不包含明文）
      logEntries.push({
        timestamp,
        memoryFile,
        ruleName: hit.rule.name,
        offset: hit.offset,
        length: hit.length,
        digest,
        severity: hit.rule.severity,
      });
    }

    // 反转 hits 列表为 offset 升序（便于调用方按原文顺序查阅）
    hits.reverse();

    // 异步追加审计日志（不阻塞返回值，日志写入失败仅告警不抛出）
    this.appendLogs(logEntries).catch((err) => {
      // 隐私红线：日志写入失败不能影响主流程，但需告警
      // 使用 console.warn 而非 throw，避免阻塞主流程
      console.warn(
        `[SensitiveInfoRedactor] 审计日志写入失败（不阻塞主流程）: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    return { sanitized, hits };
  }

  /**
   * 深度遍历记忆对象的所有字符串字段并逐字段脱敏
   *
   * 实现步骤：
   * 1. 递归遍历对象/数组，收集所有 string 类型叶子字段；
   * 2. 对每个字符串字段调用 redact()，memoryFile 参数透传用于日志归属；
   * 3. 返回脱敏后的新对象（纯函数语义，不修改入参，防止调用方持有未脱敏引用继续操作）；
   * 4. 非字符串叶子（number/boolean/null/undefined）原样保留。
   *
   * @param data 待脱敏的记忆对象
   * @param memoryFile 被脱敏的记忆文件名
   * @returns 脱敏后的新对象（深拷贝 + 脱敏）
   */
  redactMemory<T>(data: T, memoryFile: string): T {
    if (data === null || data === undefined) {
      return data;
    }
    if (typeof data === "string") {
      return this.redact(data, memoryFile).sanitized as unknown as T;
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.redactMemory(item, memoryFile)) as unknown as T;
    }
    if (typeof data === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(data as Record<string, unknown>)) {
        result[key] = this.redactMemory((data as Record<string, unknown>)[key], memoryFile);
      }
      return result as unknown as T;
    }
    // number / boolean / 其他原样返回
    return data;
  }

  /**
   * 追加审计日志到 JSON Lines 文件
   *
   * 实现细节：
   * - 确保日志目录存在（递归创建）
   * - 每条日志序列化为一行 JSON，以 \n 结尾
   * - 使用 appendFile 追加写（不覆盖已有日志）
   *
   * @param entries 日志条目数组
   */
  private async appendLogs(entries: RedactionLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    // 确保日志目录存在
    const logDir = path.dirname(this.logPath);
    await fs.mkdir(logDir, { recursive: true });
    // 序列化为 JSON Lines
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.appendFile(this.logPath, lines, "utf8");
  }
}
