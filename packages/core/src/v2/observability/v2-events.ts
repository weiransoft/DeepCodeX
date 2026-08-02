/**
 * V2 可观测性事件（V2LogEvent）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §12.1 日志事件体系
 *
 * 职责：
 * - 定义 4 类 V2 日志事件接口（approval/compression/retrieval/snapshot）
 * - 提供 V2EventLogger 统一日志记录器
 * - 所有事件落盘前经 SensitiveInfoRedactor 脱敏（隐私红线）
 * - JSON Lines 格式追加到 ~/.deepcodex/logs/v2-<YYYY-MM-DD>.log
 *
 * 4 类事件：
 * 1. ApprovalEvent：审批决策事件（每次 ApprovalGate.evaluate / ToolRouter.route 后写入）
 * 2. CompressionEvent：上下文压缩事件（SlidingWindowManager 压缩时写入）
 * 3. RetrievalEvent：经验检索事件（ExperienceRecommender 检索时写入）
 * 4. SnapshotEvent：side-git 快照事件（SideGitManager 创建/恢复快照时写入）
 *
 * 隐私红线：
 * - 所有事件字段在落盘前必须经 SensitiveInfoRedactor.redact() 脱敏
 * - 审计日志绝不记录明文片段，只记录规则名与位置
 * - DEEPCODEX_DEBUG=1 时同步输出 stderr（复用现有 debugLog 通道）
 *
 * @module v2/observability/v2-events
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { SensitiveInfoRedactor } from "../memory/redaction";
import { getDeepCodeXLogDir } from "../integration/v1-adapters";

// ============================================================================
// 1. 公共事件基座（§12.1）
// ============================================================================

/**
 * 公共事件基座：所有 V2 日志事件的公共字段
 */
export interface V2LogEventBase {
  /** 事件发生时间（ISO-8601，如 "2026-07-17T10:30:00.123Z"） */
  timestamp: string;
  /** 操作耗时（毫秒，性能审计与慢操作告警用） */
  durationMs: number;
}

// ============================================================================
// 2. 4 类事件接口（§12.1）
// ============================================================================

/**
 * 审批决策事件（对应 PRD §5.4「每次审批决策记录日志：模式、风险等级、决策结果」）
 *
 * 由 ApprovalGate.evaluate / ToolRouter.route 在每次审批后写入。
 */
export interface ApprovalEvent extends V2LogEventBase {
  /** 事件类型判别字段，固定 "approval" */
  type: "approval";
  /** 关联任务 ID（与 ApprovalContext.taskId 一致，缺省 "default-task"） */
  taskId: string;
  /** 被审批的工具名（如 "edit" / "bash" / "write"） */
  tool: string;
  /** 决策结果：allow（允许）/ deny（拒绝）/ suggest（建议确认） */
  decision: "allow" | "deny" | "suggest";
  /** 风险等级：benign（良性）/ caution（谨慎）/ destructive（破坏性） */
  riskLevel: "benign" | "caution" | "destructive";
  /** 命中的规则名（如 "blacklist-rm-rf-root"）；未命中规则时为 null */
  ruleName: string | null;
}

/**
 * 上下文压缩事件
 *
 * 由 SlidingWindowManager 在压缩旧对话片段时写入。
 */
export interface CompressionEvent extends V2LogEventBase {
  /** 事件类型判别字段，固定 "compression" */
  type: "compression";
  /** 关联会话 ID */
  sessionId: string;
  /** 压缩前 token 数 */
  beforeTokens: number;
  /** 压缩后 token 数 */
  afterTokens: number;
  /** 压缩策略：sliding_window（滑动窗口）/ summarization（摘要）/ truncation（截断） */
  strategy: "sliding_window" | "summarization" | "truncation";
}

/**
 * 经验检索事件
 *
 * 由 ExperienceRecommender 在检索经验库时写入。
 */
export interface RetrievalEvent extends V2LogEventBase {
  /** 事件类型判别字段，固定 "retrieval" */
  type: "retrieval";
  /** 检索查询（脱敏后记录，如 "auth token refresh"） */
  query: string;
  /** 返回结果数 */
  resultCount: number;
  /** Top-1 相似度得分（0.0 ~ 1.0） */
  topScore: number;
}

/**
 * side-git 快照事件
 *
 * 由 SideGitManager 在创建/恢复快照时写入。
 */
export interface SnapshotEvent extends V2LogEventBase {
  /** 事件类型判别字段，固定 "snapshot" */
  type: "snapshot";
  /** 关联任务 ID */
  taskId: string;
  /** 动作：create（创建快照）/ restore（恢复快照）/ prune（清理旧快照） */
  action: "create" | "restore" | "prune";
  /** 快照对应的 git commit hash（restore 时为恢复源，prune 时为 null） */
  commitHash: string | null;
  /** 快照包含的文件数（create/restore 时统计，prune 时为 0） */
  fileCount: number;
}

/**
 * V2 日志事件联合类型（4 类事件 + 判别字段 type）
 */
export type V2LogEvent = ApprovalEvent | CompressionEvent | RetrievalEvent | SnapshotEvent;

// ============================================================================
// 3. V2EventLogger 类
// ============================================================================

/**
 * 默认日志目录：~/.deepcodex/logs/
 */
const DEFAULT_LOG_DIR = getDeepCodeXLogDir();

/**
 * V2 事件日志记录器
 *
 * 统一记录 4 类 V2 日志事件，落盘前经 SensitiveInfoRedactor 脱敏。
 *
 * 用法：
 * ```typescript
 * const logger = new V2EventLogger();
 * await logger.logApproval({
 *   timestamp: new Date().toISOString(),
 *   durationMs: 3,
 *   taskId: "task-42",
 *   tool: "bash",
 *   decision: "deny",
 *   riskLevel: "destructive",
 *   ruleName: "blacklist-rm-rf-root",
 * });
 * ```
 */
export class V2EventLogger {
  /** 日志目录路径 */
  private readonly logDir: string;
  /** 敏感信息过滤器实例 */
  private readonly redactor: SensitiveInfoRedactor;
  /** 是否启用 stderr 同步输出（DEEPCODEX_DEBUG=1 时启用） */
  private readonly debugMode: boolean;

  /**
   * 创建 V2 事件日志记录器
   *
   * @param logDir 日志目录（默认 ~/.deepcodex/logs/，测试注入临时目录）
   * @param redactor 敏感信息过滤器（默认使用内置 11 条规则）
   */
  constructor(logDir: string = DEFAULT_LOG_DIR, redactor: SensitiveInfoRedactor = new SensitiveInfoRedactor()) {
    this.logDir = logDir;
    this.redactor = redactor;
    // DEEPCODEX_DEBUG=1 时同步输出 stderr
    this.debugMode = process.env.DEEPCODEX_DEBUG === "1";
  }

  /**
   * 记录审批决策事件
   *
   * @param event 审批事件（不含 type 字段，由本方法补充）
   */
  async logApproval(event: Omit<ApprovalEvent, "type">): Promise<void> {
    const fullEvent: ApprovalEvent = { ...event, type: "approval" };
    await this.writeEvent(fullEvent);
  }

  /**
   * 记录上下文压缩事件
   *
   * @param event 压缩事件（不含 type 字段）
   */
  async logCompression(event: Omit<CompressionEvent, "type">): Promise<void> {
    const fullEvent: CompressionEvent = { ...event, type: "compression" };
    await this.writeEvent(fullEvent);
  }

  /**
   * 记录经验检索事件
   *
   * @param event 检索事件（不含 type 字段）
   */
  async logRetrieval(event: Omit<RetrievalEvent, "type">): Promise<void> {
    const fullEvent: RetrievalEvent = { ...event, type: "retrieval" };
    await this.writeEvent(fullEvent);
  }

  /**
   * 记录 side-git 快照事件
   *
   * @param event 快照事件（不含 type 字段）
   */
  async logSnapshot(event: Omit<SnapshotEvent, "type">): Promise<void> {
    const fullEvent: SnapshotEvent = { ...event, type: "snapshot" };
    await this.writeEvent(fullEvent);
  }

  /**
   * 获取今日日志文件路径
   *
   * 文件名格式：v2-<YYYY-MM-DD>.log
   *
   * @returns 日志文件绝对路径
   */
  getTodayLogPath(): string {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return path.join(this.logDir, `v2-${dateStr}.log`);
  }

  // ========================================================================
  // 内部方法
  // ========================================================================

  /**
   * 将事件写入日志文件（JSON Lines 格式）
   *
   * 实现步骤：
   * 1. 先对事件对象递归脱敏（redactMemory）——保护字符串 value，不破坏 JSON 结构；
   * 2. 将脱敏后的事件对象序列化为 JSON 字符串；
   * 3. 追加到 ~/.deepcodex/logs/v2-<YYYY-MM-DD>.log（JSON Lines，每行一条）；
   * 4. DEEPCODEX_DEBUG=1 时同步输出 stderr。
   *
   * 关键设计（脱敏顺序）：
   * 必须先对对象脱敏、再 JSON.stringify。若反过来先 stringify 再对整个 JSON 字符串脱敏，
   * 则脱敏规则中的贪婪量词（如 \S+）会跨越 JSON 字段边界匹配，把后续字段一并替换，
   * 导致 JSON 结构破坏（如 `"query":"api_key=xxx","count":1` 被整段替换为 `[REDACTED]`，
   * 后续 `","count":1}` 全部丢失）。redactMemory 仅作用于字符串叶子节点，数字/布尔/null
   * 不受影响，保证 JSON 结构完整性。
   *
   * @param event 完整的 V2 日志事件
   */
  private async writeEvent(event: V2LogEvent): Promise<void> {
    // 步骤 1：对事件对象递归脱敏（隐私红线：所有字符串字段在落盘前必须脱敏）
    // redactMemory 仅替换字符串 value 中的敏感片段，不破坏对象结构与数值类型
    const redactedEvent = this.redactor.redactMemory(event, `v2-${this.getDateStr()}.log`);

    // 步骤 2：序列化为 JSON（脱敏后的对象，结构完整可解析）
    const jsonStr = JSON.stringify(redactedEvent);

    // 步骤 3：追加到日志文件（JSON Lines）
    const logPath = this.getTodayLogPath();
    try {
      // 确保日志目录存在
      await fs.mkdir(this.logDir, { recursive: true });
      // 追加写（每行一条 JSON）
      await fs.appendFile(logPath, jsonStr + "\n", "utf8");
    } catch (err) {
      // 日志写入失败不阻塞主流程，仅告警
      console.warn(`[V2EventLogger] 日志写入失败（不阻塞主流程）: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 步骤 4：DEEPCODEX_DEBUG=1 时同步输出 stderr
    if (this.debugMode) {
      process.stderr.write(jsonStr + "\n");
    }
  }

  /**
   * 获取今日日期字符串
   *
   * @returns 日期字符串（如 "2026-07-20"）
   */
  private getDateStr(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
}
