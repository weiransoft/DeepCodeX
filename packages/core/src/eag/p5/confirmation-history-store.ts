/**
 * EAG-P5 Phase 5.3 ConfirmationHistoryStore 历史决策存储（TASK-P5-5.3-002）
 *
 * 本模块实现 `P5ConfirmationHistoryStore` 类，提供 SmartConfirmation 三态决策结果的
 * 跨会话历史记录与查询能力，是 EAG-P5 无人值守模式 SmartConfirmation 数据源迁移
 * （TASK-P5-5.3-001）的核心基础设施。
 *
 * 核心职责（对齐架构师审查 §4.5 SmartConfirmation 数据源扩展决议）：
 * 1. record(entry)：记录每次 SmartConfirmation 决策结果（含命令、决策、风险分、护栏规则）
 * 2. query(pattern)：按多维度过滤查询历史决策（runId / stage / decision / 命令子串 / 护栏规则）
 * 3. getStats(runId?)：聚合统计（按决策类型/阶段/护栏规则 ID 计数 + 自动放行率）
 * 4. clear(runId?)：清理历史记录（测试或显式重置用）
 *
 * 与 NotesMemory 的协同关系（对齐 PM 需求文档 §9.3 单一真相源）：
 * - NotesMemory：跨轮 notes.md 记忆（非结构化 markdown，含 DECISION 标签段落）
 * - ConfirmationHistoryStore：结构化决策记录（JSONL，每行一个决策对象）
 * - 两者互补：NotesMemory 提供 LLM 可读的上下文，ConfirmationHistoryStore 提供可查询的统计
 * - SmartConfirmation 扩展数据源时，优先查 ConfirmationHistoryStore（结构化数据），
 *   辅以 NotesMemory.getDecisions()（非结构化决策回溯）
 *
 * 关键技术决策（对齐架构师审查 §4.5 + §11 兼容性矩阵）：
 * - 存储格式：JSONL（每行一个 JSON 对象，便于追加与流式解析）
 * - 路径布局：<projectRoot>/.eag/p5/confirmation-history/<runId>.jsonl
 * - 原子写入：读取-修改-写入模式（.tmp → fsync → rename，避免半写）
 * - 缓存：内存缓存避免重复读盘，写入时失效
 * - 零新增依赖：仅复用 node:* 与项目既有依赖
 * - 不可变优先：所有接口字段 readonly + ReadonlyArray + Object.freeze
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/p5/confirmation-history-store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { P5ConfirmationDecision, P5RiskLevel } from "./smart-confirmation";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * P5 ConfirmationHistoryStore 默认存储目录（相对 projectRoot）
 *
 * 与 notes-memory 的 .eag/p5/notes/ 区分，避免文件冲突。
 */
const P5_DEFAULT_HISTORY_DIR = ".eag/p5/confirmation-history" as const;

/**
 * 历史记录文件扩展名（JSONL 格式）
 */
const P5_HISTORY_EXTENSION = ".jsonl" as const;

/**
 * 默认最大历史记录文件大小（KB）
 *
 * 超过此大小触发 trim，保留最近 N 条记录。
 * 取值 512KB：平衡磁盘占用与历史决策深度查询需求。
 */
const P5_DEFAULT_HISTORY_MAX_SIZE_KB = 512 as const;

/**
 * 默认 trim 时保留的最近记录条数
 *
 * 取值 200：覆盖典型 50 次迭代 × 4 阶段 = 200 条决策记录。
 */
const P5_DEFAULT_HISTORY_TRIM_KEEP_LAST_N = 200 as const;

/**
 * 决策类型枚举（与 P5ConfirmationDecision 对齐，用于统计聚合）
 *
 * 使用 Object.freeze 冻结，防止运行期篡改。
 */
export const P5_HISTORY_DECISIONS: ReadonlyArray<P5ConfirmationDecision> = Object.freeze([
  "auto-approve",
  "ask-user",
  "fail-closed",
]);

/**
 * 阶段类型枚举（与 P5StageKind 对齐，用于统计聚合）
 */
export const P5_HISTORY_STAGES: ReadonlyArray<"plan" | "dev" | "verify" | "fix"> = Object.freeze([
  "plan",
  "dev",
  "verify",
  "fix",
]);

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * 历史决策记录条目（对应 JSONL 文件的一行）
 *
 * 每条记录描述一次 SmartConfirmation 决策的完整上下文，用于：
 * - 跨会话查询历史决策模式（如"上次相同命令如何决策"）
 * - 统计自动放行率/人工确认率/拒绝率
 * - 审计护栏规则触发频率
 *
 * 字段全部 readonly——记录一经写入即不可变。
 *
 * 范例：
 *   {
 *     runId: "run-001",
 *     iterIndex: 3,
 *     stage: "dev",
 *     command: "npm test",
 *     decision: "auto-approve",
 *     riskLevel: "low",
 *     riskScore: 0,
 *     guardRuleId: "G-A2c",
 *     matchedPattern: "^npm\\s+(test|run\\s+test)$",
 *     reason: "白名单操作：^npm\\s+(test|run\\s+test)$",
 *     timestamp: "2026-07-21T10:30:00.000Z"
 *   }
 */
export interface P5ConfirmationHistoryEntry {
  /** 关联的 run-id（用于跨 run 隔离与查询） */
  readonly runId: string;
  /** 决策所属迭代号（0-based） */
  readonly iterIndex: number;
  /** 决策所属阶段（plan/dev/verify/fix） */
  readonly stage: "plan" | "dev" | "verify" | "fix";
  /** 待决策的命令字符串（可为空，表示无命令的纯护栏决策） */
  readonly command: string;
  /** SmartConfirmation 三态决策结果 */
  readonly decision: P5ConfirmationDecision;
  /** 风险等级（low/medium/high/critical） */
  readonly riskLevel: P5RiskLevel;
  /** 风险评分（0-100，黑名单命中固定 100） */
  readonly riskScore: number;
  /** 触发的护栏规则 ID（来自 GuardVerdict，未触发时为空字符串） */
  readonly guardRuleId: string;
  /** 命中的模式字符串（未命中时为空字符串） */
  readonly matchedPattern: string;
  /** 决策原因（人类可读，含命中规则与分数） */
  readonly reason: string;
  /** 决策时间戳（ISO 8601 字符串） */
  readonly timestamp: string;
}

/**
 * 历史决策查询模式（用于 query 方法的多维度过滤）
 *
 * 所有字段可选，未提供的字段不参与过滤。
 * 多个字段同时提供时，取交集（AND 语义）。
 *
 * 字段全部 readonly。
 */
export interface P5ConfirmationQueryPattern {
  /** 按 run-id 过滤（未提供时跨所有 run 查询） */
  readonly runId?: string;
  /** 按阶段过滤 */
  readonly stage?: "plan" | "dev" | "verify" | "fix";
  /** 按决策结果过滤 */
  readonly decision?: P5ConfirmationDecision;
  /** 按命令子串过滤（大小写不敏感，子串匹配） */
  readonly commandSubstring?: string;
  /** 按护栏规则 ID 过滤 */
  readonly guardRuleId?: string;
  /** 起始时间戳（ISO 8601，仅返回 timestamp >= 此值的记录） */
  readonly sinceTimestamp?: string;
  /** 截止时间戳（ISO 8601，仅返回 timestamp <= 此值的记录） */
  readonly untilTimestamp?: string;
  /** 最小风险分（仅返回 riskScore >= 此值的记录） */
  readonly minRiskScore?: number;
  /** 最大风险分（仅返回 riskScore <= 此值的记录） */
  readonly maxRiskScore?: number;
  /** 返回结果上限（默认 1000，上限 10000） */
  readonly limit?: number;
}

/**
 * 历史决策统计信息（getStats 方法返回值）
 *
 * 提供多维聚合统计，用于：
 * - 监控自动放行率（auto-approve 占比）
 * - 识别人工确认频繁的阶段（ask-user 集中分布）
 * - 审计高频触发的护栏规则（topGuardRuleIds）
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     totalEntries: 200,
 *     byDecision: { "auto-approve": 150, "ask-user": 30, "fail-closed": 20 },
 *     byStage: { "plan": 50, "dev": 80, "verify": 50, "fix": 20 },
 *     uniqueRunIds: 5,
 *     autoApproveRate: 0.75,
 *     askUserRate: 0.15,
 *     failClosedRate: 0.10,
 *     topGuardRuleIds: [{ ruleId: "G-A2c", count: 150 }, { ruleId: "G-A2a", count: 20 }]
 *   }
 */
export interface P5ConfirmationHistoryStats {
  /** 总记录条数 */
  readonly totalEntries: number;
  /** 按决策类型聚合计数 */
  readonly byDecision: Readonly<Record<P5ConfirmationDecision, number>>;
  /** 按阶段聚合计数 */
  readonly byStage: Readonly<Record<"plan" | "dev" | "verify" | "fix", number>>;
  /** 唯一 run-id 数量（跨 run 聚合时使用） */
  readonly uniqueRunIds: number;
  /** 自动放行率（auto-approve / totalEntries，0~1） */
  readonly autoApproveRate: number;
  /** 人工确认率（ask-user / totalEntries，0~1） */
  readonly askUserRate: number;
  /** 拒绝率（fail-closed / totalEntries，0~1） */
  readonly failClosedRate: number;
  /** 触发频率 Top-10 护栏规则 ID 列表（按 count 降序） */
  readonly topGuardRuleIds: ReadonlyArray<Readonly<{ ruleId: string; count: number }>>;
  /** 统计生成时间戳（ISO 8601） */
  readonly generatedAt: string;
}

/**
 * ConfirmationHistoryStore 错误类型（字面量联合类型）
 *
 * - io-failed：底层文件系统 I/O 失败
 * - invalid-request：请求字段非法
 * - not-found：指定 runId 的历史记录文件不存在
 * - corrupted：JSONL 文件损坏（某行无法解析为 JSON）
 */
export type P5HistoryStoreErrorKind = "io-failed" | "invalid-request" | "not-found" | "corrupted";

/**
 * P5 ConfirmationHistoryStore 错误基类
 *
 * 所有 P5 ConfirmationHistoryStore 相关错误均继承自此基类，
 * 调用方可以通过 instanceof P5ConfirmationHistoryStoreError 统一捕获，
 * 也可通过 err.kind 区分具体错误类型分别处理。
 */
export class P5ConfirmationHistoryStoreError extends Error {
  /**
   * @param kind 错误类型（P5HistoryStoreErrorKind 之一）
   * @param detail 错误详情（人类可读）
   * @param runId 关联的 run-id（便于日志溯源，可选）
   */
  constructor(
    public readonly kind: P5HistoryStoreErrorKind,
    public readonly detail: string,
    public readonly runId?: string
  ) {
    super(`P5 ConfirmationHistoryStore 错误 [${kind}]${runId ? ` runId=${runId}` : ""}：${detail}`);
    this.name = "P5ConfirmationHistoryStoreError";
    Object.setPrototypeOf(this, P5ConfirmationHistoryStoreError.prototype);
  }
}

/**
 * 日志回调函数类型（复用 P5LogCallback 签名）
 */
export type P5HistoryLogCallback = (message: string, level?: "info" | "warn" | "error") => void;

// ============================================================================
// 3. 默认日志空函数
// ============================================================================

/**
 * 默认日志空函数（避免 undefined 判空）
 *
 * 对齐 run-state-store / notes-memory 的 noopLog 模式。
 */
function p5HistoryNoopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 4. P5ConfirmationHistoryStore 主类
// ============================================================================

/**
 * P5ConfirmationHistoryStore —— 历史决策存储（P5 版）
 *
 * 算法概述：
 * 1. record(projectRoot, entry)：原子追加一条决策记录到 JSONL 文件
 *    - 读取现有内容（用于 trim 决策）
 *    - 序列化新条目为 JSON 行
 *    - 合并内容（现有 + 新行）
 *    - 检查是否需要 trim（超过 maxSizeBytes 时保留最近 N 条）
 *    - 原子写入（.tmp → fsync → rename）
 *    - 失效缓存
 * 2. query(projectRoot, pattern)：按多维度过滤查询
 *    - 加载完整 JSONL 内容
 *    - 逐行解析为 P5ConfirmationHistoryEntry
 *    - 按 pattern 字段过滤（AND 语义）
 *    - 按 timestamp 升序排序
 *    - 应用 limit（默认 1000，上限 10000）
 * 3. getStats(projectRoot, runId?)：聚合统计
 *    - 加载记录（可选按 runId 过滤）
 *    - 按 decision / stage / guardRuleId 聚合计数
 *    - 计算 autoApproveRate / askUserRate / failClosedRate
 *    - 取 topGuardRuleIds Top-10
 *
 * 并发安全：
 * - 单 run-id 同一时刻允许并发读写（JSONL 是追加式，写入冲突概率低）
 * - 写入采用原子 rename，避免半写
 * - 内存缓存在写入时失效，下次读取重新加载
 *
 * 使用方式：
 * ```typescript
 * const store = new P5ConfirmationHistoryStore();
 * // 记录一条决策
 * await store.record("/path/to/project", {
 *   runId: "run-001",
 *   iterIndex: 0,
 *   stage: "dev",
 *   command: "npm test",
 *   decision: "auto-approve",
 *   riskLevel: "low",
 *   riskScore: 0,
 *   guardRuleId: "G-A2c",
 *   matchedPattern: "^npm\\s+test$",
 *   reason: "白名单操作",
 *   timestamp: new Date().toISOString(),
 * });
 * // 查询历史决策
 * const entries = await store.query("/path/to/project", {
 *   runId: "run-001",
 *   decision: "auto-approve",
 *   limit: 100,
 * });
 * // 获取统计
 * const stats = await store.getStats("/path/to/project", "run-001");
 * console.log(stats.autoApproveRate);
 * ```
 */
export class P5ConfirmationHistoryStore {
  /** 最大文件大小（字节） */
  private readonly maxSizeBytes: number;
  /** trim 时保留的最近记录条数 */
  private readonly trimKeepLastN: number;
  /** 日志回调 */
  private readonly log: P5HistoryLogCallback;
  /** projectRoot::runId → 缓存内容（避免重复读盘） */
  private readonly cache: Map<string, string>;

  /**
   * @param maxSizeKb 最大历史记录文件大小（KB），超过则 trim（默认 512KB）
   * @param trimKeepLastN trim 时保留最近 N 条记录（默认 200）
   * @param logger 日志回调（可选）
   */
  constructor(
    maxSizeKb: number = P5_DEFAULT_HISTORY_MAX_SIZE_KB,
    trimKeepLastN: number = P5_DEFAULT_HISTORY_TRIM_KEEP_LAST_N,
    logger: P5HistoryLogCallback = p5HistoryNoopLog
  ) {
    this.maxSizeBytes = Math.max(1, maxSizeKb) * 1024;
    this.trimKeepLastN = Math.max(1, trimKeepLastN);
    this.log = logger;
    this.cache = new Map();
  }

  // ------------------------------------------------------------------------
  // 公共 API
  // ------------------------------------------------------------------------

  /**
   * 记录一条 SmartConfirmation 决策结果
   *
   * 算法：
   * 1. 校验入参（projectRoot + entry 必填字段）
   * 2. 加载现有 JSONL 内容（用于 trim 决策）
   * 3. 序列化新条目为 JSON 行
   * 4. 合并内容（现有 + 新行）
   * 5. 检查是否需要 trim（超过 maxSizeBytes 时保留最近 N 条）
   * 6. 原子写入（.tmp → fsync → rename）
   * 7. 失效缓存
   *
   * @param projectRoot 项目根目录
   * @param entry 决策记录条目
   * @throws P5ConfirmationHistoryStoreError 请求非法 / I/O 失败
   */
  async record(projectRoot: string, entry: Readonly<P5ConfirmationHistoryEntry>): Promise<void> {
    // 1. 校验入参
    this.validateProjectRoot(projectRoot);
    this.validateEntry(entry);

    // 2. 加载现有内容
    const runId = entry.runId;
    const current = await this.safeLoad(projectRoot, runId);

    // 3. 序列化新条目为 JSON 行
    const jsonLine = this.serializeEntry(entry);

    // 4. 合并内容
    const merged = current ? current + "\n" + jsonLine : jsonLine;

    // 5. 原子写入（内部会判断是否需要 trim）
    await this.atomicWrite(projectRoot, runId, merged);

    this.log(
      `P5ConfirmationHistoryStore.record：runId=${runId} iterIndex=${entry.iterIndex} stage=${entry.stage} decision=${entry.decision}`,
      "info"
    );
  }

  /**
   * 按多维度过滤查询历史决策
   *
   * 算法：
   * 1. 校验入参
   * 2. 加载完整 JSONL 内容
   * 3. 逐行解析为 P5ConfirmationHistoryEntry（跳过损坏行并记录日志）
   * 4. 按 pattern 字段过滤（AND 语义）
   * 5. 按 timestamp 升序排序
   * 6. 应用 limit（默认 1000，上限 10000）
   *
   * @param projectRoot 项目根目录
   * @param pattern 查询模式（所有字段可选）
   * @returns 决策记录列表（按时间升序，冻结对象）
   * @throws P5ConfirmationHistoryStoreError 请求非法 / I/O 失败
   */
  async query(
    projectRoot: string,
    pattern: Readonly<P5ConfirmationQueryPattern> = {}
  ): Promise<ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>> {
    // 1. 校验入参
    this.validateProjectRoot(projectRoot);
    this.validatePattern(pattern);

    // 2. 确定查询范围：指定 runId 时查单文件，否则查全部
    const limit = Math.min(pattern.limit ?? 1000, 10000);

    if (pattern.runId) {
      // 单 run 查询
      const entries = await this.loadEntries(projectRoot, pattern.runId);
      const filtered = this.applyFilter(entries, pattern);
      const sorted = this.sortByTimestamp(filtered);
      return Object.freeze(sorted.slice(0, limit));
    }

    // 跨 run 查询：扫描目录下所有 .jsonl 文件
    const allEntries = await this.loadAllEntries(projectRoot);
    const filtered = this.applyFilter(allEntries, pattern);
    const sorted = this.sortByTimestamp(filtered);
    return Object.freeze(sorted.slice(0, limit));
  }

  /**
   * 获取历史决策统计信息
   *
   * 算法：
   * 1. 加载记录（可选按 runId 过滤）
   * 2. 按 decision / stage / guardRuleId 聚合计数
   * 3. 计算 autoApproveRate / askUserRate / failClosedRate
   * 4. 取 topGuardRuleIds Top-10
   *
   * @param projectRoot 项目根目录
   * @param runId 可选 run-id（提供时仅统计该 run，否则跨所有 run）
   * @returns 统计信息（冻结对象）
   * @throws P5ConfirmationHistoryStoreError 请求非法 / I/O 失败
   */
  async getStats(projectRoot: string, runId?: string): Promise<Readonly<P5ConfirmationHistoryStats>> {
    // 1. 校验入参
    this.validateProjectRoot(projectRoot);
    if (runId !== undefined) {
      this.validateRunId(runId);
    }

    // 2. 加载记录
    let entries: ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>;
    if (runId) {
      entries = await this.loadEntries(projectRoot, runId);
    } else {
      entries = await this.loadAllEntries(projectRoot);
    }

    // 3. 聚合统计
    const totalEntries = entries.length;
    const byDecision: Record<P5ConfirmationDecision, number> = {
      "auto-approve": 0,
      "ask-user": 0,
      "fail-closed": 0,
    };
    const byStage: Record<"plan" | "dev" | "verify" | "fix", number> = {
      plan: 0,
      dev: 0,
      verify: 0,
      fix: 0,
    };
    const guardRuleCounts = new Map<string, number>();
    const runIdSet = new Set<string>();

    for (const entry of entries) {
      byDecision[entry.decision] = (byDecision[entry.decision] ?? 0) + 1;
      byStage[entry.stage] = (byStage[entry.stage] ?? 0) + 1;
      runIdSet.add(entry.runId);
      if (entry.guardRuleId) {
        guardRuleCounts.set(entry.guardRuleId, (guardRuleCounts.get(entry.guardRuleId) ?? 0) + 1);
      }
    }

    // 4. 计算比率（避免除零）
    const safeTotal = Math.max(1, totalEntries);
    const autoApproveRate = byDecision["auto-approve"] / safeTotal;
    const askUserRate = byDecision["ask-user"] / safeTotal;
    const failClosedRate = byDecision["fail-closed"] / safeTotal;

    // 5. 取 topGuardRuleIds Top-10（按 count 降序）
    const topGuardRuleIds = [...guardRuleCounts.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return Object.freeze({
      totalEntries,
      byDecision: Object.freeze({ ...byDecision }),
      byStage: Object.freeze({ ...byStage }),
      uniqueRunIds: runIdSet.size,
      autoApproveRate,
      askUserRate,
      failClosedRate,
      topGuardRuleIds: Object.freeze(topGuardRuleIds.map((item) => Object.freeze(item))),
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * 清理历史记录
   *
   * @param projectRoot 项目根目录
   * @param runId 可选 run-id（提供时仅清理该 run 的记录，否则清理全部）
   * @throws P5ConfirmationHistoryStoreError I/O 失败
   */
  async clear(projectRoot: string, runId?: string): Promise<void> {
    this.validateProjectRoot(projectRoot);
    if (runId !== undefined) {
      this.validateRunId(runId);
    }

    const historyDir = this.resolveHistoryDir(projectRoot);

    if (runId) {
      // 清理指定 run 的文件
      const filePath = this.resolveHistoryPath(projectRoot, runId);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          throw new P5ConfirmationHistoryStoreError(
            "io-failed",
            `删除历史记录文件失败：${filePath} 错误：${(err as Error).message}`,
            runId
          );
        }
      }
      // 失效缓存
      this.cache.delete(this.cacheKey(projectRoot, runId));
    } else {
      // 清理目录下全部 .jsonl 文件
      if (fs.existsSync(historyDir)) {
        let files: string[];
        try {
          files = fs.readdirSync(historyDir);
        } catch (err) {
          throw new P5ConfirmationHistoryStoreError(
            "io-failed",
            `读取历史记录目录失败：${historyDir} 错误：${(err as Error).message}`
          );
        }
        for (const file of files) {
          if (file.endsWith(P5_HISTORY_EXTENSION)) {
            const filePath = path.join(historyDir, file);
            try {
              fs.unlinkSync(filePath);
            } catch (err) {
              throw new P5ConfirmationHistoryStoreError(
                "io-failed",
                `删除历史记录文件失败：${filePath} 错误：${(err as Error).message}`
              );
            }
          }
        }
      }
      // 失效全部缓存
      this.cache.clear();
    }

    this.log(
      `P5ConfirmationHistoryStore.clear：projectRoot=${projectRoot}${runId ? ` runId=${runId}` : "（全部）"}`,
      "info"
    );
  }

  /**
   * 强制失效缓存（外部修改文件后调用）
   *
   * @param projectRoot 项目根目录
   * @param runId 可选 run-id（未提供时失效全部缓存）
   */
  invalidateCache(projectRoot: string, runId?: string): void {
    if (runId) {
      this.cache.delete(this.cacheKey(projectRoot, runId));
    } else {
      this.cache.clear();
    }
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 校验 projectRoot 入参
   */
  private validateProjectRoot(projectRoot: string): void {
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "projectRoot 必须为非空字符串");
    }
  }

  /**
   * 校验 runId 入参
   *
   * runId 仅允许字母/数字/连字符，避免路径遍历攻击（如 ../）。
   */
  private validateRunId(runId: string): void {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "runId 必须为非空字符串");
    }
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", `runId 仅允许字母/数字/连字符，实际值：${runId}`);
    }
  }

  /**
   * 校验决策记录条目入参
   */
  private validateEntry(entry: Readonly<P5ConfirmationHistoryEntry>): void {
    if (!entry || typeof entry !== "object") {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "entry 必须为对象");
    }
    this.validateRunId(entry.runId);
    if (typeof entry.iterIndex !== "number" || entry.iterIndex < 0) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "entry.iterIndex 必须为非负整数");
    }
    if (!P5_HISTORY_STAGES.includes(entry.stage)) {
      throw new P5ConfirmationHistoryStoreError(
        "invalid-request",
        `entry.stage 非法：${entry.stage}（合法值：plan/dev/verify/fix）`
      );
    }
    if (typeof entry.command !== "string") {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "entry.command 必须为字符串");
    }
    if (!P5_HISTORY_DECISIONS.includes(entry.decision)) {
      throw new P5ConfirmationHistoryStoreError(
        "invalid-request",
        `entry.decision 非法：${entry.decision}（合法值：auto-approve/ask-user/fail-closed）`
      );
    }
    if (typeof entry.riskScore !== "number" || entry.riskScore < 0 || entry.riskScore > 100) {
      throw new P5ConfirmationHistoryStoreError(
        "invalid-request",
        `entry.riskScore 必须在 0~100 之间，实际值：${entry.riskScore}`
      );
    }
    if (typeof entry.timestamp !== "string" || entry.timestamp.trim().length === 0) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "entry.timestamp 必须为非空字符串");
    }
  }

  /**
   * 校验查询模式入参
   */
  private validatePattern(pattern: Readonly<P5ConfirmationQueryPattern>): void {
    if (!pattern || typeof pattern !== "object") {
      throw new P5ConfirmationHistoryStoreError("invalid-request", "pattern 必须为对象");
    }
    if (pattern.runId !== undefined) {
      this.validateRunId(pattern.runId);
    }
    if (pattern.stage !== undefined && !P5_HISTORY_STAGES.includes(pattern.stage)) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", `pattern.stage 非法：${pattern.stage}`);
    }
    if (pattern.decision !== undefined && !P5_HISTORY_DECISIONS.includes(pattern.decision)) {
      throw new P5ConfirmationHistoryStoreError("invalid-request", `pattern.decision 非法：${pattern.decision}`);
    }
    if (pattern.limit !== undefined) {
      if (typeof pattern.limit !== "number" || pattern.limit < 1) {
        throw new P5ConfirmationHistoryStoreError(
          "invalid-request",
          `pattern.limit 必须为正整数，实际值：${pattern.limit}`
        );
      }
    }
  }

  /**
   * 解析历史记录目录绝对路径
   */
  private resolveHistoryDir(projectRoot: string): string {
    const projectRootAbs = path.resolve(projectRoot);
    return path.join(projectRootAbs, P5_DEFAULT_HISTORY_DIR);
  }

  /**
   * 解析历史记录文件绝对路径
   *
   * @param projectRoot 项目根目录
   * @param runId run-id
   * @returns JSONL 文件绝对路径
   */
  private resolveHistoryPath(projectRoot: string, runId: string): string {
    const historyDir = this.resolveHistoryDir(projectRoot);
    return path.join(historyDir, runId + P5_HISTORY_EXTENSION);
  }

  /**
   * 构造缓存键
   */
  private cacheKey(projectRoot: string, runId: string): string {
    return `${projectRoot}::${runId}`;
  }

  /**
   * 安全加载文件内容（文件不存在返回空字符串）
   *
   * @param projectRoot 项目根目录
   * @param runId run-id
   * @returns JSONL 文件完整内容（文件不存在返回空字符串）
   */
  private async safeLoad(projectRoot: string, runId: string): Promise<string> {
    const cacheKey = this.cacheKey(projectRoot, runId);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const filePath = this.resolveHistoryPath(projectRoot, runId);
    if (!fs.existsSync(filePath)) {
      return "";
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      throw new P5ConfirmationHistoryStoreError(
        "io-failed",
        `读取历史记录文件失败：${filePath} 错误：${(err as Error).message}`,
        runId
      );
    }

    this.cache.set(cacheKey, content);
    return content;
  }

  /**
   * 加载指定 runId 的全部决策记录（逐行解析 JSONL）
   *
   * 算法：
   * 1. 加载 JSONL 文件内容
   * 2. 按行切分（跳过空行）
   * 3. 逐行 JSON.parse（跳过损坏行并记录日志）
   * 4. 返回记录列表
   *
   * @param projectRoot 项目根目录
   * @param runId run-id
   * @returns 决策记录列表（冻结对象）
   */
  private async loadEntries(
    projectRoot: string,
    runId: string
  ): Promise<ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>> {
    const content = await this.safeLoad(projectRoot, runId);
    if (!content.trim()) {
      return Object.freeze([]);
    }
    return this.parseJsonl(content, runId);
  }

  /**
   * 加载项目下全部 run 的决策记录（扫描目录下所有 .jsonl 文件）
   *
   * @param projectRoot 项目根目录
   * @returns 决策记录列表（冻结对象）
   */
  private async loadAllEntries(projectRoot: string): Promise<ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>> {
    const historyDir = this.resolveHistoryDir(projectRoot);
    if (!fs.existsSync(historyDir)) {
      return Object.freeze([]);
    }

    let files: string[];
    try {
      files = fs.readdirSync(historyDir);
    } catch (err) {
      throw new P5ConfirmationHistoryStoreError(
        "io-failed",
        `读取历史记录目录失败：${historyDir} 错误：${(err as Error).message}`
      );
    }

    const allEntries: P5ConfirmationHistoryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(P5_HISTORY_EXTENSION)) {
        continue;
      }
      // 从文件名提取 runId（去掉 .jsonl 后缀）
      const fileRunId = file.slice(0, -P5_HISTORY_EXTENSION.length);
      if (!/^[a-zA-Z0-9-]+$/.test(fileRunId)) {
        // 跳过不符合 runId 命名规则的文件
        this.log(`P5ConfirmationHistoryStore.loadAllEntries：跳过非法命名的文件：${file}`, "warn");
        continue;
      }
      const entries = await this.loadEntries(projectRoot, fileRunId);
      for (const entry of entries) {
        allEntries.push(entry as P5ConfirmationHistoryEntry);
      }
    }

    return Object.freeze(allEntries);
  }

  /**
   * 解析 JSONL 字符串为决策记录列表
   *
   * 算法：
   * 1. 按行切分（跳过空行）
   * 2. 逐行 JSON.parse
   * 3. 损坏行跳过并记录 warn 日志（不抛错，容错优先）
   * 4. 字段缺失时跳过该行
   *
   * @param content JSONL 字符串
   * @param runId 关联的 run-id（用于错误日志）
   * @returns 决策记录列表（冻结对象）
   */
  private parseJsonl(content: string, runId: string): ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>> {
    const lines = content.split("\n");
    const entries: P5ConfirmationHistoryEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        // 损坏行：跳过并记录日志（不抛错，容错优先）
        this.log(
          `P5ConfirmationHistoryStore.parseJsonl：跳过损坏行 runId=${runId} line=${i + 1} 错误：${(err as Error).message}`,
          "warn"
        );
        continue;
      }

      // 校验解析结果为合法的 P5ConfirmationHistoryEntry
      const candidate = obj as Partial<P5ConfirmationHistoryEntry>;
      if (
        typeof candidate.runId === "string" &&
        typeof candidate.iterIndex === "number" &&
        typeof candidate.stage === "string" &&
        typeof candidate.command === "string" &&
        typeof candidate.decision === "string" &&
        typeof candidate.riskLevel === "string" &&
        typeof candidate.riskScore === "number" &&
        typeof candidate.guardRuleId === "string" &&
        typeof candidate.matchedPattern === "string" &&
        typeof candidate.reason === "string" &&
        typeof candidate.timestamp === "string"
      ) {
        entries.push(
          Object.freeze({
            runId: candidate.runId,
            iterIndex: candidate.iterIndex,
            stage: candidate.stage as "plan" | "dev" | "verify" | "fix",
            command: candidate.command,
            decision: candidate.decision as P5ConfirmationDecision,
            riskLevel: candidate.riskLevel as P5RiskLevel,
            riskScore: candidate.riskScore,
            guardRuleId: candidate.guardRuleId,
            matchedPattern: candidate.matchedPattern,
            reason: candidate.reason,
            timestamp: candidate.timestamp,
          })
        );
      } else {
        this.log(`P5ConfirmationHistoryStore.parseJsonl：跳过字段缺失的行 runId=${runId} line=${i + 1}`, "warn");
      }
    }

    return Object.freeze(entries);
  }

  /**
   * 序列化决策记录为 JSON 行
   *
   * 注意：JSON.stringify 不会包含换行符，可安全作为 JSONL 的一行。
   *
   * @param entry 决策记录
   * @returns JSON 字符串（单行）
   */
  private serializeEntry(entry: Readonly<P5ConfirmationHistoryEntry>): string {
    return JSON.stringify({
      runId: entry.runId,
      iterIndex: entry.iterIndex,
      stage: entry.stage,
      command: entry.command,
      decision: entry.decision,
      riskLevel: entry.riskLevel,
      riskScore: entry.riskScore,
      guardRuleId: entry.guardRuleId,
      matchedPattern: entry.matchedPattern,
      reason: entry.reason,
      timestamp: entry.timestamp,
    });
  }

  /**
   * 按查询模式过滤决策记录
   *
   * 多字段同时提供时取交集（AND 语义）。
   *
   * @param entries 待过滤的记录列表
   * @param pattern 查询模式
   * @returns 过滤后的记录列表
   */
  private applyFilter(
    entries: ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>,
    pattern: Readonly<P5ConfirmationQueryPattern>
  ): ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>> {
    const result: P5ConfirmationHistoryEntry[] = [];

    for (const entry of entries) {
      // runId 过滤
      if (pattern.runId !== undefined && entry.runId !== pattern.runId) {
        continue;
      }
      // stage 过滤
      if (pattern.stage !== undefined && entry.stage !== pattern.stage) {
        continue;
      }
      // decision 过滤
      if (pattern.decision !== undefined && entry.decision !== pattern.decision) {
        continue;
      }
      // commandSubstring 过滤（大小写不敏感，子串匹配）
      if (pattern.commandSubstring !== undefined && pattern.commandSubstring.length > 0) {
        const cmdLower = entry.command.toLowerCase();
        const subLower = pattern.commandSubstring.toLowerCase();
        if (!cmdLower.includes(subLower)) {
          continue;
        }
      }
      // guardRuleId 过滤
      if (pattern.guardRuleId !== undefined && entry.guardRuleId !== pattern.guardRuleId) {
        continue;
      }
      // sinceTimestamp 过滤（ISO 8601 字符串可直接字典序比较）
      if (pattern.sinceTimestamp !== undefined && entry.timestamp < pattern.sinceTimestamp) {
        continue;
      }
      // untilTimestamp 过滤
      if (pattern.untilTimestamp !== undefined && entry.timestamp > pattern.untilTimestamp) {
        continue;
      }
      // minRiskScore 过滤
      if (pattern.minRiskScore !== undefined && entry.riskScore < pattern.minRiskScore) {
        continue;
      }
      // maxRiskScore 过滤
      if (pattern.maxRiskScore !== undefined && entry.riskScore > pattern.maxRiskScore) {
        continue;
      }

      result.push(entry as P5ConfirmationHistoryEntry);
    }

    return Object.freeze(result);
  }

  /**
   * 按 timestamp 升序排序
   *
   * ISO 8601 字符串可直接字典序比较（年份在前，月份居中，日在后）。
   *
   * @param entries 待排序的记录列表
   * @returns 排序后的记录列表（新数组，不修改原数组）
   */
  private sortByTimestamp(
    entries: ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>>
  ): ReadonlyArray<Readonly<P5ConfirmationHistoryEntry>> {
    return Object.freeze(
      [...entries].sort((a, b) => {
        if (a.timestamp < b.timestamp) return -1;
        if (a.timestamp > b.timestamp) return 1;
        return 0;
      })
    );
  }

  /**
   * 原子写入（先 .tmp，fsync，rename）
   *
   * 算法：
   * 1. 确保父目录存在（mkdir -p）
   * 2. 检查是否需要 trim（超过 maxSizeBytes 时保留最近 N 条）
   * 3. 写 .tmp 文件
   * 4. fsync 确保数据落盘
   * 5. 原子 rename 覆盖原文件
   * 6. 更新缓存
   *
   * @param projectRoot 项目根目录
   * @param runId run-id
   * @param content 完整 JSONL 内容
   */
  private async atomicWrite(projectRoot: string, runId: string, content: string): Promise<void> {
    const filePath = this.resolveHistoryPath(projectRoot, runId);

    // 1. 确保父目录存在
    const parentDir = path.dirname(filePath);
    fs.mkdirSync(parentDir, { recursive: true });

    // 2. 检查是否需要 trim
    const trimmed = this.trimContent(content);

    // 3. 写 .tmp 文件
    const tmpPath = `${filePath}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(tmpPath, "w");
    } catch (err) {
      throw new P5ConfirmationHistoryStoreError(
        "io-failed",
        `打开 .tmp 文件失败：${tmpPath} 错误：${(err as Error).message}`,
        runId
      );
    }

    try {
      try {
        fs.writeSync(fd, trimmed, 0, "utf8");
        // 强制 fsync（确保数据落盘后再 rename）
        fs.fsyncSync(fd);
      } catch (err) {
        throw new P5ConfirmationHistoryStoreError(
          "io-failed",
          `写入 .tmp 文件失败：${tmpPath} 错误：${(err as Error).message}`,
          runId
        );
      }
    } finally {
      fs.closeSync(fd);
    }

    // 4. 原子 rename（跨平台）
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      throw new P5ConfirmationHistoryStoreError(
        "io-failed",
        `rename .tmp 到历史记录文件失败：${tmpPath} → ${filePath} 错误：${(err as Error).message}`,
        runId
      );
    }

    // 5. 更新缓存
    const cacheKey = this.cacheKey(projectRoot, runId);
    this.cache.set(cacheKey, trimmed);
  }

  /**
   * 检查并 trim（超过 maxSizeBytes 时保留最近 N 条记录）
   *
   * 算法：
   * 1. 计算当前内容字节大小
   * 2. 若未超限，原样返回
   * 3. 按行切分（保留最后一行如果以换行结尾则忽略空行）
   * 4. 保留最后 N 行
   * 5. 在头部插入 trim 提示行
   *
   * @param content 完整 JSONL 内容
   * @returns trim 后的内容（若未超限则原样返回）
   */
  private trimContent(content: string): string {
    const encodedSize = Buffer.byteLength(content, "utf8");
    if (encodedSize <= this.maxSizeBytes) {
      return content;
    }

    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length <= this.trimKeepLastN) {
      return content; // 行数太少，无法 trim
    }

    const keep = lines.slice(-this.trimKeepLastN);
    // 在头部插入 trim 提示行（注释行，JSONL 解析时跳过损坏行）
    const trimMarker = JSON.stringify({
      _trimMarker: true,
      _trimmedAt: new Date().toISOString(),
      _trimmedCount: lines.length - this.trimKeepLastN,
      _message: `Earlier ${lines.length - this.trimKeepLastN} entries were trimmed to stay under max_size_kb=${Math.floor(this.maxSizeBytes / 1024)}.`,
    });
    return trimMarker + "\n" + keep.join("\n");
  }
}

// ============================================================================
// 5. 工厂函数
// ============================================================================

/**
 * 工厂函数：创建默认 P5ConfirmationHistoryStore 实例
 *
 * 使用默认配置（512KB 最大文件 / 200 条保留）。
 *
 * @param options 配置选项（可选）
 * @returns P5ConfirmationHistoryStore 实例
 */
export function createDefaultP5ConfirmationHistoryStore(
  options?: Readonly<{
    maxSizeKb?: number;
    trimKeepLastN?: number;
    logger?: P5HistoryLogCallback;
  }>
): P5ConfirmationHistoryStore {
  return new P5ConfirmationHistoryStore(options?.maxSizeKb, options?.trimKeepLastN, options?.logger);
}

// ============================================================================
// 6. 常量导出（供测试断言与外部消费者引用）
// ============================================================================

export {
  P5_DEFAULT_HISTORY_DIR,
  P5_HISTORY_EXTENSION,
  P5_DEFAULT_HISTORY_MAX_SIZE_KB,
  P5_DEFAULT_HISTORY_TRIM_KEEP_LAST_N,
};
