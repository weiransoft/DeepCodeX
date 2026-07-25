/**
 * 动态指令注入与后台子 Agent —— 共享类型定义（ADR-DI-001 Phase 1 MVP）
 *
 * 本模块定义 ADR-DI-001 §3 所述的核心数据结构的类型契约：
 * - `TaskKind`：任务类型枚举（chat / autonomous）
 * - `TaskStatus`：任务状态机枚举（§3.4 / §6）
 * - `InjectSource`：注入来源枚举（user / llm）
 * - `InjectedInstruction`：用户中途注入的指令（§3.1）
 * - `TaskStats`：任务进度统计（§3.2）
 * - `TaskSnapshot`：任务持久化快照（§3.5，仅可序列化字段）
 * - `TaskListFilter`：任务列表过滤条件（§3.3）
 * - `InterruptQueueOptions`：InterruptQueue 构造选项
 * - `QueueOverflowError` / `TaskLimitExceededError` / `InvalidStateTransitionError`：
 *   队列溢出、并发上限超限、状态机非法转换错误
 *
 * 设计依据：ADR-DI-001 §3 核心数据结构 + §6 状态机定义
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有公开字段 readonly
 * - 接口方法尽量返回 readonly 集合或不可变快照
 * - 错误类全部继承 Error，并设置 name 字段便于 instanceof 判定
 *
 * @module interrupts/types
 */

// ============================================================================
// 1. TaskKind 任务类型枚举
// ============================================================================

/**
 * 任务类型枚举
 *
 * - `chat`：普通对话任务，使用 SessionManager 主循环执行
 * - `autonomous`：4 阶段循环任务，使用 AutonomousOrchestrator 执行（Phase 3 支持）
 *
 * Phase 1 MVP 仅实现 `chat` 类型，`autonomous` 留待 Phase 3。
 */
export type TaskKind = "chat" | "autonomous";

// ============================================================================
// 2. TaskStatus 状态机（§3.4 / §6）
// ============================================================================

/**
 * 任务状态枚举
 *
 * 状态转换图见 ADR-DI-001 §6.1，转换表见 §6.2。
 *
 * 不变式（§6.3 运行时校验）：
 * - `injecting` 状态必须瞬时（drain 完成立即转回 running），不允许停留
 * - `cancelled` / `succeeded` / `failed` 是终态，不可转换
 * - `paused → running` 必须经 `resume()`，不允许直接转换
 * - `running` 状态下 `controller.signal.aborted` 必须为 `false`
 */
export type TaskStatus =
  | "queued" // 已创建未启动
  | "running" // 执行中
  | "paused" // 已暂停（可恢复）
  | "injecting" // 正在处理注入指令（瞬时状态，drain 后转回 running）
  | "succeeded" // 成功完成
  | "failed" // 失败终止
  | "cancelled"; // 用户取消

// ============================================================================
// 3. InjectSource 注入来源枚举
// ============================================================================

/**
 * 注入来源枚举
 *
 * - `user`：用户主动通过 `/inject <指令>` 注入
 * - `llm`：LLM 调用 `inject_message` 工具注入（Phase 3 支持）
 */
export type InjectSource = "user" | "llm";

// ============================================================================
// 4. InjectedInstruction 注入指令（§3.1）
// ============================================================================

/**
 * 注入指令（不可变，对应一次 `/inject <文本>` 或 LLM `inject_message` 工具调用）
 *
 * 字段说明：
 * - `id`：唯一 ID（`crypto.randomUUID()`）
 * - `text`：指令文本（用户输入的 `/inject` 后内容，或 LLM 工具的 message 参数）
 * - `enqueuedAt`：入队时间戳（ISO 8601 字符串）
 * - `source`：注入来源（`user` 来自用户 `/inject`；`llm` 来自 LLM `inject_message` 工具）
 *
 * 设计约束：
 * - 一经创建即不可变（所有字段 readonly）
 * - `text` 不允许为空字符串（InterruptQueue.enqueue 会校验）
 * - `enqueuedAt` 用于 FIFO 顺序校验与展示
 */
export interface InjectedInstruction {
  /** 唯一 ID（`crypto.randomUUID()`） */
  readonly id: string;
  /** 指令文本（用户输入的 `/inject` 后内容，或 LLM 工具的 message 参数） */
  readonly text: string;
  /** 入队时间戳（ISO 8601 字符串，毫秒精度） */
  readonly enqueuedAt: string;
  /** 注入来源（`user` 来自用户 `/inject`；`llm` 来自 LLM `inject_message` 工具） */
  readonly source: InjectSource;
}

// ============================================================================
// 5. TaskStats 任务进度统计（§3.2）
// ============================================================================

/**
 * 任务累计统计
 *
 * 由 BackgroundTask 内部维护，每次状态变更或周期性更新时通过 onStatsUpdate 回调传出。
 * 所有字段为只读数值，外部不可修改。
 *
 * 字段说明：
 * - `iterations`：主循环迭代次数（LLM 主循环每完成一轮 +1）
 * - `durationMs`：累计执行时长（毫秒，暂停期间不累加）
 * - `tokensUsed`：累计 token 消耗（input + output）
 */
export interface TaskStats {
  /** 迭代次数（LLM 主循环迭代计数） */
  readonly iterations: number;
  /** 累计执行时长（毫秒，暂停期间不累加） */
  readonly durationMs: number;
  /** 累计 token 消耗（input + output） */
  readonly tokensUsed: number;
}

// ============================================================================
// 6. TaskSnapshot 任务持久化快照（§3.5）
// ============================================================================

/**
 * 任务持久化快照
 *
 * 与 `.deepcodex/tasks/<taskId>.json` 文件结构一一对应（§5.5.1）。
 * 用于 TaskStore 持久化与崩溃恢复（§5.5.3）。
 *
 * 设计约束：
 * - 仅含可序列化字段，不含 `controller` / 函数 / 回调
 * - 一经创建即不可变（所有字段 readonly）
 * - 由 `BackgroundTask.toSnapshot()` 产出，`BackgroundTask.fromSnapshot()` 重建
 *
 * 字段说明：
 * - `id` / `kind` / `status` / `prompt`：任务基础信息
 * - `sessionId`：关联的 sessionId（未创建 SessionManager 时为 null）
 * - `startedAt` / `updatedAt` / `completedAt`：时间戳（ISO 8601）
 * - `result`：任务结果（succeeded 时填充，例如最终回复摘要）
 * - `error`：失败原因（failed / cancelled 时填充）
 * - `stats`：累计统计
 */
export interface TaskSnapshot {
  /** 任务 ID（`t-` 前缀 + UUID） */
  readonly id: string;
  /** 任务类型 */
  readonly kind: TaskKind;
  /** 任务状态 */
  readonly status: TaskStatus;
  /** 初始 prompt 文本（用于展示与恢复） */
  readonly prompt: string;
  /** 关联的 sessionId（未创建 SessionManager 时为 null） */
  readonly sessionId: string | null;
  /** 创建时间（ISO 8601） */
  readonly startedAt: string;
  /** 最后更新时间（ISO 8601） */
  readonly updatedAt: string;
  /** 完成时间（ISO 8601，未完成为 null） */
  readonly completedAt: string | null;
  /** 任务结果（succeeded 时填充） */
  readonly result: string | null;
  /** 失败原因（failed / cancelled 时填充） */
  readonly error: string | null;
  /** 累计统计 */
  readonly stats: TaskStats;
}

// ============================================================================
// 7. TaskListFilter 任务列表过滤条件（§3.3）
// ============================================================================

/**
 * 任务列表过滤条件
 *
 * 用于 TaskRegistry.list() 与 SessionManager.listTasks()。
 * 所有字段可选，未指定时返回全部任务。
 *
 * 字段说明：
 * - `status`：按状态过滤（单值或数组，命中任一即匹配）
 * - `kind`：按类型过滤
 * - `includeHistory`：是否包含已完成的历史任务（默认 false，仅返回活跃任务）
 */
export interface TaskListFilter {
  /** 按状态过滤（单值或数组，命中任一即匹配） */
  readonly status?: TaskStatus | readonly TaskStatus[];
  /** 按类型过滤 */
  readonly kind?: TaskKind;
  /** 是否包含已完成的历史任务（默认 false，仅返回活跃任务） */
  readonly includeHistory?: boolean;
}

// ============================================================================
// 8. InterruptQueueOptions 队列构造选项
// ============================================================================

/**
 * InterruptQueue 构造选项
 *
 * 字段说明：
 * - `onEnqueue`：入队回调，每次 `enqueue()` 成功后同步触发；
 *   用于通知 SessionManager 主循环"队列非空，需要尽快 drain"。
 *
 * 设计约束：
 * - 回调同步触发，但内部已做重入保护（回调中再次调用 enqueue 会抛错）
 * - 回调抛错不会影响 enqueue 主流程（错误被吞掉并记录到 stderr）
 */
export interface InterruptQueueOptions {
  /** 入队回调（用于触发 SessionManager 主循环检查） */
  readonly onEnqueue?: () => void;
}

// ============================================================================
// 9. 错误类定义
// ============================================================================

/**
 * 队列容量超限错误
 *
 * 当 `InterruptQueue.enqueue()` 时队列长度已达 `MAX_QUEUE_SIZE` 抛出。
 * 防止用户狂输 `/inject` 导致内存爆炸（R-5 风险缓解）。
 */
export class QueueOverflowError extends Error {
  /** 当前队列长度 */
  readonly currentSize: number;
  /** 队列容量上限 */
  readonly maxSize: number;

  constructor(message: string, currentSize: number, maxSize: number) {
    super(message);
    this.name = "QueueOverflowError";
    this.currentSize = currentSize;
    this.maxSize = maxSize;
  }
}

/**
 * 任务并发上限超限错误
 *
 * 当 `TaskRegistry.register()` 时活跃任务数已达 `MAX_CONCURRENT_TASKS` 抛出。
 * 防止后台任务过多导致内存爆炸（R-5 风险缓解）。
 */
export class TaskLimitExceededError extends Error {
  /** 当前活跃任务数 */
  readonly currentCount: number;
  /** 并发上限 */
  readonly maxCount: number;

  constructor(message: string, currentCount: number, maxCount: number) {
    super(message);
    this.name = "TaskLimitExceededError";
    this.currentCount = currentCount;
    this.maxCount = maxCount;
  }
}

/**
 * 状态机非法转换错误
 *
 * 当 `BackgroundTask.setState()` 校验状态转换不合法时抛出。
 * 携带 `from` / `to` 字段便于调试。
 */
export class InvalidStateTransitionError extends Error {
  /** 起始状态 */
  readonly from: TaskStatus;
  /** 目标状态 */
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus, message?: string) {
    super(message ?? `非法状态转换：${from} → ${to}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ============================================================================
// 10. 工具名常量（供 LLM 工具定义与 handler 共享，Phase 3 使用）
// ============================================================================

/** `background_task` 工具名 —— 启动后台子 agent */
export const BACKGROUND_TASK_TOOL_NAME = "background_task" as const;

/** `list_tasks` 工具名 —— 列出所有任务状态 */
export const LIST_TASKS_TOOL_NAME = "list_tasks" as const;

/** `cancel_task` 工具名 —— 取消指定任务 */
export const CANCEL_TASK_TOOL_NAME = "cancel_task" as const;

/** `inject_message` 工具名 —— 向指定任务注入消息 */
export const INJECT_MESSAGE_TOOL_NAME = "inject_message" as const;

// ============================================================================
// 11. InjectInterruptError 流式中断错误（ADR-DI-001 §5.1.3 E3 扩展点）
// ============================================================================

/**
 * 流式中断错误（由 createChatCompletionStream 在流式 chunk 之间检查到
 * InterruptQueue 非空时抛出，activateSession catch 块识别此错误并 continue
 * 进入下一轮迭代，从而让主循环在 LLM 调用前 drain 队列中的指令）
 *
 * 设计约束（对齐 ADR-DI-001 §5.1.3）：
 * - 继承 Error，name 字段固定为 "InjectInterruptError"，便于 instanceof 判定
 * - 携带 pendingCount 字段（被消费前的队列长度，便于日志与展示）
 * - 不被视为 AbortError（不触发 session.status="interrupted"）
 * - 不被视为常规错误（不触发 session.status="failed"）
 *
 * 使用示例：
 * ```typescript
 * // E3 扩展点：流式 chunk 之间检查中断队列
 * if (this.interruptQueue && this.interruptQueue.size > 0) {
 *   throw new InjectInterruptError(
 *     this.interruptQueue.size,
 *     `Interrupted by ${this.interruptQueue.size} user instructions`
 *   );
 * }
 *
 * // activateSession catch 块识别
 * try {
 *   // ... createChatCompletionStream ...
 * } catch (error) {
 *   if (error instanceof InjectInterruptError) {
 *     // 不设置 failed，continue 进入下一轮迭代
 *     continue;
 *   }
 *   throw error;
 * }
 * ```
 */
export class InjectInterruptError extends Error {
  /** 抛错时队列中待处理的指令数量（用于日志与展示） */
  readonly pendingCount: number;

  /**
   * 构造 InjectInterruptError
   *
   * @param pendingCount 抛错时队列中待处理的指令数量
   * @param message 错误消息（可选，默认含 pendingCount 信息）
   */
  constructor(pendingCount: number, message?: string) {
    super(message ?? `Interrupted by ${pendingCount} user instruction${pendingCount === 1 ? "" : "s"}`);
    this.name = "InjectInterruptError";
    this.pendingCount = pendingCount;
  }
}
