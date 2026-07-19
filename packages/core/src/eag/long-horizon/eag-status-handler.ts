/**
 * /eag-status 命令处理器（EagStatusHandler）—— EAG-P3 批次 10 §4.14
 *
 * 本模块实现 EAG 方案 §5.12.2 + 设计文档 §4.14 所述的 /eag-status 命令处理逻辑，
 * 输出长程进度报告（Markdown 格式），含完成度 / 耗时 / token 消耗 / 当前阻塞点 / milestone 列表 + 健康度。
 *
 * 核心职责（对齐设计文档 §4.14.1）：
 * 1. 若提供 run-id → 加载指定 RunState 生成单 run 详情报告
 * 2. 否则 → 调用 RunStateStore.listRuns() 显示最近 N 个 run 摘要
 * 3. 生成进度报告（Markdown 格式）：
 *    a. 头部：run-id / 状态 / 启动时间 / 当前 Loop / 当前迭代
 *    b. 完成度：已完成 Loop 数 / 总 Loop 数 + 百分比
 *    c. 耗时：总耗时 + 各 Loop 耗时分布（基于 milestone 时间戳推导）
 *    d. Token 消耗：总 token + 各 Loop token 分布（基于 milestone 推导，本批次简化为总计）
 *    e. 里程碑列表：序号 + 名称 + 完成时间 + 健康度 + tag 名
 *    f. 阻塞点：当前阻塞原因 + 阻塞时长 + 建议动作
 *    g. 人工介入历史：时间 + 原因 + 决策 + 是否已解决
 *
 * 关键技术决策（对齐 §4.14.2 + 工程实践）：
 * - 复用 RunStateStore.load() 与 RunStateStore.listRuns() 接口
 * - 报告格式严格对齐 §4.14.3 模板（Markdown + 表格 + emoji 状态图标）
 * - 不依赖 MilestoneTagger：报告字段全部从 RunState 读取（milestones / humanInterventions）
 *   MilestoneTagger 仅在 EagRunHandler 中使用，status 仅用于显示
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/long-horizon/eag-status-handler
 */

import type { LoopType } from "../loop/models";
import type { HumanInterventionRecord, LogCallback, MilestoneRecord, RunState } from "./types";
import type { RunStateStore, RunStateSummary } from "./run-state-store";
import { RunStateNotFoundError } from "./run-state-store";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 默认最近 run 列表数量
 *
 * 对应设计文档 §4.14.2 recentCount 默认值。
 */
const DEFAULT_RECENT_COUNT = 10 as const;

/**
 * 三 Loop 总数（DESIGN + CODING + TESTING）
 *
 * 用于计算完成度百分比。
 */
const TOTAL_LOOP_COUNT = 3 as const;

/**
 * Loop 类型显示顺序（用于报告中的完成度章节排序）
 */
const LOOP_DISPLAY_ORDER: ReadonlyArray<LoopType> = Object.freeze(["design", "coding", "testing"]);

/**
 * Loop 状态 emoji 图标映射
 *
 * - ✅ 已完成（completedLoops 包含）
 * - 🔄 进行中（currentLoop 匹配且 status="running"）
 * - ⏸ 等待中（pending，未开始）
 * - ⚠️ 阻塞中（status="human-checkpoint" 或 "paused"）
 */
const LOOP_STATUS_ICONS: Readonly<Record<string, string>> = Object.freeze({
  completed: "✅",
  running: "🔄",
  pending: "⏸",
  blocked: "⚠️",
});

/**
 * 默认日志空函数（避免 undefined 判空）
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 2. 自定义错误类
// ============================================================================

/**
 * /eag-status 命令处理器错误类型（字面量联合类型）
 *
 * - request-invalid：请求字段非法
 * - run-not-found：run-id 不存在
 * - status-failed：生成报告失败
 */
export type EagStatusHandlerErrorKind = "request-invalid" | "run-not-found" | "status-failed";

/**
 * /eag-status 命令处理器错误基类
 */
export class EagStatusHandlerError extends Error {
  /**
   * @param kind 错误类型
   * @param detail 错误详情
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: EagStatusHandlerErrorKind,
    public readonly detail: string,
    public readonly cause?: unknown
  ) {
    super(`EagStatusHandler 错误 [${kind}]：${detail}`);
    this.name = "EagStatusHandlerError";
  }
}

// ============================================================================
// 3. EagStatusRequest / EagStatusResult 接口
// ============================================================================

/**
 * /eag-status 命令请求
 *
 * 对应设计文档 §4.14.2 EagStatusRequest。
 *
 * 字段全部 readonly——请求一经构造即不可变。
 *
 * 范例：
 *   {
 *     projectRoot: "/path/to/project",
 *     runId: "a1b2c3d4e5f6"
 *   }
 *   或
 *   {
 *     projectRoot: "/path/to/project",
 *     recentCount: 10
 *   }
 */
export interface EagStatusRequest {
  /** run-id（可选，未提供时显示最近 run 列表） */
  readonly runId?: string;
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 最近 run 列表数量（默认 10，仅 runId 未提供时生效） */
  readonly recentCount?: number;
}

/**
 * /eag-status 命令结果
 *
 * 对应设计文档 §4.14.2 EagStatusResult。
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface EagStatusResult {
  /** 报告内容（Markdown 格式） */
  readonly report: string;
  /** 单 run 详情（runId 提供时返回完整 RunState） */
  readonly runState?: Readonly<RunState>;
  /** 最近 run 列表（runId 未提供时返回摘要列表） */
  readonly recentRuns?: ReadonlyArray<RunStateSummary>;
}

// ============================================================================
// 4. EagStatusHandler 主类
// ============================================================================

/**
 * /eag-status 命令处理器
 *
 * 对应 EAG 方案 §5.12.2 + 设计文档 §4.14：
 * 输出长程进度报告（Markdown 格式），含完成度 / 耗时 / token / 里程碑 / 阻塞点。
 *
 * 使用方式：
 * ```typescript
 * const handler = new EagStatusHandler({
 *   runStateStore: new RunStateStore(),
 * });
 *
 * // 单 run 详情
 * const result1 = await handler.handle({
 *   projectRoot: "/path/to/project",
 *   runId: "a1b2c3d4e5f6",
 * });
 *
 * // 最近 run 列表
 * const result2 = await handler.handle({
 *   projectRoot: "/path/to/project",
 *   recentCount: 10,
 * });
 * ```
 */
export class EagStatusHandler {
  // ----------------------------------------------------------------------
  // 私有字段
  // ----------------------------------------------------------------------

  /** RunState 持久化存储（依赖注入） */
  private readonly runStateStore: RunStateStore;
  /** 日志回调 */
  private readonly logger: LogCallback;

  // ----------------------------------------------------------------------
  // 构造函数
  // ----------------------------------------------------------------------

  /**
   * 初始化 /eag-status 命令处理器
   *
   * @param options 注入选项
   * @param options.runStateStore RunState 持久化存储（必填）
   * @param options.logger 日志回调（可选）
   */
  constructor(options: { readonly runStateStore: RunStateStore; readonly logger?: LogCallback }) {
    if (!options || !options.runStateStore) {
      throw new EagStatusHandlerError("request-invalid", "runStateStore 必填");
    }
    this.runStateStore = options.runStateStore;
    this.logger = options.logger ?? noopLog;
  }

  // ----------------------------------------------------------------------
  // 公共 API
  // ----------------------------------------------------------------------

  /**
   * 执行 /eag-status 命令
   *
   * 完整时序（对齐设计文档 §4.14.2）：
   * 1. 校验请求字段
   * 2. 若提供 run-id → 加载指定 RunState 生成单 run 详情报告
   * 3. 否则 → 调用 RunStateStore.listRuns() 显示最近 N 个 run 摘要
   * 4. 返回报告
   *
   * @param request 状态请求
   * @returns 进度报告（Markdown 格式）
   * @throws EagStatusHandlerError 请求非法 / run-id 不存在 / 加载失败
   */
  async handle(request: Readonly<EagStatusRequest>): Promise<Readonly<EagStatusResult>> {
    // ===== Step 1: 校验请求字段 =====
    this.validateRequest(request);

    this.logger(`/eag-status 启动：projectRoot=${request.projectRoot} runId=${request.runId ?? "（未提供）"}`, "info");

    // ===== Step 2: 分支处理 =====
    if (request.runId) {
      // 单 run 详情模式
      return await this.handleSingleRunStatus(request.runId, request.projectRoot);
    } else {
      // 最近 run 列表模式
      const recentCount = request.recentCount ?? DEFAULT_RECENT_COUNT;
      return await this.handleRecentRunsStatus(request.projectRoot, recentCount);
    }
  }

  // ----------------------------------------------------------------------
  // 私有方法
  // ----------------------------------------------------------------------

  /**
   * 校验 /eag-status 请求字段
   *
   * 校验规则：
   * - projectRoot 必填且为非空字符串
   * - runId 若提供必须为非空字符串
   * - recentCount 若提供必须为 >= 1 的整数
   *
   * @param request 请求对象
   * @throws EagStatusHandlerError 请求字段非法时抛出
   */
  private validateRequest(request: Readonly<EagStatusRequest>): void {
    if (!request || typeof request !== "object") {
      throw new EagStatusHandlerError("request-invalid", "request 必须为对象");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new EagStatusHandlerError("request-invalid", "projectRoot 必须为非空字符串");
    }
    if (request.runId !== undefined) {
      if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
        throw new EagStatusHandlerError("request-invalid", "runId 必须为非空字符串");
      }
    }
    if (request.recentCount !== undefined) {
      if (!Number.isInteger(request.recentCount) || request.recentCount < 1) {
        throw new EagStatusHandlerError("request-invalid", "recentCount 必须为整数且 >= 1");
      }
    }
  }

  /**
   * 处理单 run 详情模式
   *
   * 算法：
   * 1. 调用 RunStateStore.load() 加载 RunState
   * 2. 生成详细进度报告（含基本信息 / 完成度 / 耗时 / Token / 里程碑 / 阻塞点 / 人工介入历史）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 单 run 详情结果
   * @throws EagStatusHandlerError run-id 不存在或加载失败
   */
  private async handleSingleRunStatus(runId: string, projectRoot: string): Promise<Readonly<EagStatusResult>> {
    let runState: Readonly<RunState>;
    try {
      runState = await this.runStateStore.load(runId, projectRoot);
    } catch (err) {
      if (err instanceof RunStateNotFoundError) {
        throw new EagStatusHandlerError("run-not-found", `run-id 不存在：${runId}（projectRoot=${projectRoot}）`, err);
      }
      throw new EagStatusHandlerError(
        "status-failed",
        `加载 RunState 失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    const report = this.buildSingleRunReport(runState);
    this.logger(`/eag-status 完成：runId=${runId} status=${runState.status}`, "info");

    return Object.freeze({
      report,
      runState,
    });
  }

  /**
   * 处理最近 run 列表模式
   *
   * 算法：
   * 1. 调用 RunStateStore.listRuns() 获取最近 N 个 run 摘要
   * 2. 生成列表报告
   *
   * @param projectRoot 项目根目录
   * @param recentCount 最近 run 列表数量
   * @returns 最近 run 列表结果
   * @throws EagStatusHandlerError 加载失败
   */
  private async handleRecentRunsStatus(projectRoot: string, recentCount: number): Promise<Readonly<EagStatusResult>> {
    let summaries: ReadonlyArray<RunStateSummary>;
    try {
      summaries = await this.runStateStore.listRuns(projectRoot);
    } catch (err) {
      throw new EagStatusHandlerError(
        "status-failed",
        `加载最近 run 列表失败：${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // 截取最近 N 个（listRuns 返回全量，按 updatedAt 降序排列）
    const sortedSummaries = [...summaries].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    const recentSummaries = sortedSummaries.slice(0, recentCount);

    const report = this.buildRecentRunsReport(recentSummaries);
    this.logger(`/eag-status 完成：最近 ${recentSummaries.length} 个 run`, "info");

    return Object.freeze({
      report,
      recentRuns: Object.freeze([...recentSummaries]),
    });
  }

  /**
   * 构建单 run 详情报告（Markdown 格式，对齐设计文档 §4.14.3 模板）
   *
   * @param runState RunState 对象
   * @returns Markdown 格式报告
   */
  private buildSingleRunReport(runState: Readonly<RunState>): string {
    const parts: string[] = [];

    // ===== 章节 1：标题 + 基本信息 =====
    parts.push(`# EAG Run Status: ${runState.runId}`);
    parts.push("");
    parts.push("## 基本信息");
    parts.push("");
    parts.push(`- **状态**: ${runState.status}`);
    parts.push(`- **启动时间**: ${this.formatTimestamp(runState.startedAt)}`);
    parts.push(`- **最近更新**: ${this.formatTimestamp(runState.updatedAt)}`);
    parts.push(`- **当前 Loop**: ${this.formatLoopName(runState.currentLoop)}`);
    parts.push(`- **当前迭代**: ${runState.currentIteration}`);
    if (runState.blockedReason) {
      parts.push(`- **阻塞原因**: ${runState.blockedReason}`);
    }
    parts.push("");

    // ===== 章节 2：完成度 =====
    parts.push("## 完成度");
    parts.push("");
    const completedCount = runState.completedLoops.length;
    const completionRate = ((completedCount / TOTAL_LOOP_COUNT) * 100).toFixed(1);
    parts.push(`- **总进度**: ${completedCount} / ${TOTAL_LOOP_COUNT} Loops (${completionRate}%)`);
    for (const loopType of LOOP_DISPLAY_ORDER) {
      const icon = this.getLoopStatusIcon(loopType, runState);
      const loopName = this.formatLoopName(loopType);
      if (runState.completedLoops.includes(loopType)) {
        parts.push(`- ${icon} ${loopName}: completed`);
      } else if (loopType === runState.currentLoop) {
        const suffix =
          runState.status === "running"
            ? ` (iteration ${runState.currentIteration})`
            : runState.status === "human-checkpoint"
              ? " (等待人工决策)"
              : runState.status === "paused"
                ? " (已暂停)"
                : "";
        parts.push(`- ${icon} ${loopName}: ${runState.status}${suffix}`);
      } else {
        parts.push(`- ${icon} ${loopName}: pending`);
      }
    }
    parts.push("");

    // ===== 章节 3：耗时与 Token =====
    parts.push("## 耗时与 Token");
    parts.push("");
    const totalDurationSec = this.calculateDurationSec(runState.startedAt, runState.updatedAt);
    parts.push(`- **总耗时**: ${this.formatDuration(totalDurationSec)}`);
    parts.push(`- **总 Token**: ${runState.totalTokensUsed.toLocaleString()}`);
    parts.push(`- **总 LLM 调用**: ${runState.totalLlmCallCount.toLocaleString()}`);
    parts.push("");

    // ===== 章节 4：里程碑列表 =====
    parts.push("## 里程碑");
    parts.push("");
    if (runState.milestones.length === 0) {
      parts.push("（无里程碑）");
    } else {
      parts.push("| # | 名称 | 完成时间 | 健康度 | Tag |");
      parts.push("|---|------|---------|--------|-----|");
      for (let i = 0; i < runState.milestones.length; i++) {
        const m = runState.milestones[i];
        parts.push(
          `| ${i + 1} | ${m.name} | ${this.formatTimestamp(m.completedAt)} | ${m.healthScore.toFixed(2)} | ${m.tagName} |`
        );
      }
    }
    parts.push("");

    // ===== 章节 5：阻塞点 =====
    parts.push("## 阻塞点");
    parts.push("");
    if (runState.status === "running" || runState.status === "completed") {
      parts.push("（无）");
    } else {
      parts.push(`- **当前状态**: ${runState.status}`);
      if (runState.blockedReason) {
        parts.push(`- **阻塞原因**: ${runState.blockedReason}`);
      }
      // 推导阻塞时长（从最后一次 human-intervention 到现在）
      const lastIntervention = runState.humanInterventions[runState.humanInterventions.length - 1];
      if (lastIntervention) {
        const blockedDurationSec = this.calculateDurationSec(lastIntervention.intervenedAt, runState.updatedAt);
        parts.push(`- **阻塞时长**: ${this.formatDuration(blockedDurationSec)}`);
        parts.push(`- **建议动作**: 使用 \`/eag-resume ${runState.runId}\` 恢复执行或人工介入解决`);
      }
    }
    parts.push("");

    // ===== 章节 6：人工介入历史 =====
    parts.push("## 人工介入历史");
    parts.push("");
    if (runState.humanInterventions.length === 0) {
      parts.push("（无）");
    } else {
      parts.push("| # | 时间 | Loop | 原因 | 决策 | 已解决 |");
      parts.push("|---|------|------|------|------|--------|");
      for (let i = 0; i < runState.humanInterventions.length; i++) {
        const h = runState.humanInterventions[i];
        parts.push(
          `| ${i + 1} | ${this.formatTimestamp(h.intervenedAt)} | ${this.formatLoopName(h.loopType)} | ${h.reason} | ${h.decision} | ${h.resolved ? "✅" : "❌"} |`
        );
      }
    }

    return parts.join("\n");
  }

  /**
   * 构建最近 run 列表报告（Markdown 格式）
   *
   * @param summaries run 摘要列表
   * @returns Markdown 格式报告
   */
  private buildRecentRunsReport(summaries: ReadonlyArray<RunStateSummary>): string {
    const parts: string[] = [];

    parts.push("# EAG Recent Runs");
    parts.push("");
    parts.push(`最近 ${summaries.length} 个 EAG Run：`);
    parts.push("");

    if (summaries.length === 0) {
      parts.push("（无 Run 记录）");
    } else {
      parts.push("| # | run-id | 状态 | 当前 Loop | 完成度 | 启动时间 | 最近更新 |");
      parts.push("|---|--------|------|-----------|--------|---------|---------|");
      for (let i = 0; i < summaries.length; i++) {
        const s = summaries[i];
        const completionPercent = (s.completionRate * 100).toFixed(1);
        parts.push(
          `| ${i + 1} | ${s.runId} | ${s.status} | ${this.formatLoopName(s.currentLoop)} | ${completionPercent}% | ${this.formatTimestamp(s.startedAt)} | ${this.formatTimestamp(s.updatedAt)} |`
        );
      }
    }
    parts.push("");
    parts.push("使用 `/eag-status <run-id>` 查看单 run 详情，使用 `/eag-resume <run-id>` 恢复执行。");

    return parts.join("\n");
  }

  /**
   * 获取 Loop 状态 emoji 图标
   *
   * @param loopType Loop 类型
   * @param runState RunState 对象
   * @returns emoji 图标字符串
   */
  private getLoopStatusIcon(loopType: LoopType, runState: Readonly<RunState>): string {
    if (runState.completedLoops.includes(loopType)) {
      return LOOP_STATUS_ICONS.completed;
    }
    if (loopType === runState.currentLoop) {
      if (runState.status === "running") {
        return LOOP_STATUS_ICONS.running;
      }
      return LOOP_STATUS_ICONS.blocked;
    }
    return LOOP_STATUS_ICONS.pending;
  }

  /**
   * 格式化 Loop 类型为显示名称
   *
   * @param loopType Loop 类型
   * @returns 显示名称（如 "DESIGN Loop"）
   */
  private formatLoopName(loopType: LoopType): string {
    return `${loopType.toUpperCase()} Loop`;
  }

  /**
   * 格式化 ISO 时间戳为人类可读格式
   *
   * @param isoTimestamp ISO 8601 字符串
   * @returns 格式化后的时间字符串（如 "2026-07-19 10:00:00"）
   */
  private formatTimestamp(isoTimestamp: string): string {
    try {
      const date = new Date(isoTimestamp);
      if (Number.isNaN(date.getTime())) {
        return isoTimestamp;
      }
      // 使用 ISO 8601 紧凑格式：YYYY-MM-DD HH:mm:ss
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const seconds = String(date.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch {
      return isoTimestamp;
    }
  }

  /**
   * 计算两个 ISO 时间戳之间的时长（秒）
   *
   * @param startIso 起始时间 ISO 字符串
   * @param endIso 结束时间 ISO 字符串
   * @returns 时长（秒）
   */
  private calculateDurationSec(startIso: string, endIso: string): number {
    try {
      const start = new Date(startIso).getTime();
      const end = new Date(endIso).getTime();
      if (Number.isNaN(start) || Number.isNaN(end)) {
        return 0;
      }
      return (end - start) / 1000;
    } catch {
      return 0;
    }
  }

  /**
   * 格式化时长（秒）为人类可读格式
   *
   * @param durationSec 时长（秒）
   * @returns 格式化后的时长字符串（如 "1h 23m 45s" / "45s" / "0s"）
   */
  private formatDuration(durationSec: number): string {
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      return "0s";
    }
    const totalSec = Math.floor(durationSec);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const parts: string[] = [];
    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    if (minutes > 0 || hours > 0) {
      parts.push(`${minutes}m`);
    }
    parts.push(`${seconds}s`);
    return parts.join(" ");
  }
}

// ============================================================================
// 5. 类型导出（便于外部引用）
// ============================================================================

// 重新导出 HumanInterventionRecord 与 MilestoneRecord，便于调用方统一引用
export type { HumanInterventionRecord, MilestoneRecord };
