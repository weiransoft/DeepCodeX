/**
 * 后台任务抽象 —— ADR-DI-001 §3.2 实现
 *
 * 本模块实现 `BackgroundTask` 类，是动态指令注入特性的核心任务抽象。
 *
 * 核心职责（对齐 ADR-DI-001 §3.2 + §6）：
 * 1. 持有任务元数据（id / kind / prompt / sessionId / 时间戳）
 * 2. 维护状态机（queued → pending → running ⇄ pausing ⇄ paused，running ⇄ retrying / injecting → 终态）
 * 3. 提供 pause / resume / cancel / inject 等控制 API
 * 4. 通过回调与外部协作（onStart / onPause / onResume / onCancel / onComplete / onStateChange / onStatsUpdate / onInject）
 * 5. 序列化为 TaskSnapshot（持久化用，不含 controller / functions）
 * 6. 从 TaskSnapshot 重建（崩溃恢复用，不自动 start）
 *
 * 设计约束：
 * - 不可变优先：所有公开字段 readonly，状态字段通过 setState 转换
 * - 状态机不变式校验：setState 内部校验转换合法性，非法转换抛 InvalidStateTransitionError
 * - controller 由外部注入：便于 TaskRegistry / BackgroundTaskRunner 统一管理
 * - 回调全部可选：未提供回调时仅状态转换，不执行副作用
 *
 * 与 AutonomousOrchestrator 的关系（§3.2）：
 * - kind = "chat"：onStart 回调内部调用 SessionManager.handleUserPrompt()
 * - kind = "autonomous"：onStart 回调内部调用 AutonomousOrchestrator.run()
 * - Phase 1 MVP 仅实现 chat kind，autonomous kind 留待 Phase 3
 *
 * 状态机不变式（运行时校验）：
 * - `injecting` / `pausing` / `retrying` / `pending` 为中间状态，不允许长期停留
 * - `cancelled` / `succeeded` / `failed` / `timeout` 是终态，不可转换
 * - `paused → running` 必须经 `resume()`（路径：paused → pausing → running）
 * - `pause()` 路径：running → pausing → paused
 * - `running` 状态下 `controller.signal.aborted` 必须为 `false`
 *
 * @module interrupts/background-task
 */

import type { InjectedInstruction, TaskKind, TaskSnapshot, TaskStats, TaskStatus } from "./types";
import { InvalidStateTransitionError, TERMINAL_STATUSES } from "./types";

// ============================================================================
// 1. BackgroundTaskOptions 构造选项
// ============================================================================

/**
 * BackgroundTask 构造选项
 *
 * 字段说明：
 * - `id`：任务 ID（建议前缀 `t-` + UUID，由 BackgroundTaskRunner 生成）
 * - `kind`：任务类型（chat / autonomous）
 * - `prompt`：初始 prompt 文本
 * - `sessionId`：关联的 sessionId（可选，未提供时为 null；onStart 回调中可通过 setSessionId 设置）
 * - `controller`：独立的 AbortController（外部注入，便于管理）
 * - `onStart`：启动回调（在状态变为 running 之前调用，可在此创建 SessionManager 等）
 * - `onPause` / `onResume` / `onCancel`：暂停 / 恢复 / 取消回调
 * - `onComplete`：完成回调（succeeded / failed / cancelled 时调用）
 * - `onInject`：注入指令回调（InterruptQueue.enqueue 由调用方处理）
 * - `onStateChange`：状态变更回调（每次 setState 后调用）
 * - `onStatsUpdate`：统计更新回调（每次 updateStats 后调用）
 *
 * 设计约束：
 * - 所有回调可选（未提供时仅状态转换，不执行副作用）
 * - 回调可以是同步或异步（异步回调的错误被吞掉并记录到 stderr，不影响状态转换）
 * - controller 必须由外部注入（便于 TaskRegistry / BackgroundTaskRunner 统一管理）
 */
export interface BackgroundTaskOptions {
  /** 任务 ID（建议前缀 `t-` + UUID） */
  readonly id: string;
  /** 任务类型 */
  readonly kind: TaskKind;
  /** 初始 prompt 文本 */
  readonly prompt: string;
  /** 关联的 sessionId（可选，未提供时为 null） */
  readonly sessionId?: string | null;
  /** 独立的 AbortController（外部注入，便于管理） */
  readonly controller: AbortController;
  /** 启动回调（在状态变为 running 之前调用，可在此创建 SessionManager 等） */
  readonly onStart?: (task: BackgroundTask) => Promise<void> | void;
  /** 暂停回调 */
  readonly onPause?: (task: BackgroundTask) => Promise<void> | void;
  /** 恢复回调 */
  readonly onResume?: (task: BackgroundTask) => Promise<void> | void;
  /** 取消回调 */
  readonly onCancel?: (task: BackgroundTask, reason?: string) => Promise<void> | void;
  /** 完成回调（succeeded / failed / cancelled 时调用） */
  readonly onComplete?: (task: BackgroundTask) => Promise<void> | void;
  /** 注入指令回调（InterruptQueue.enqueue 由调用方处理） */
  readonly onInject?: (task: BackgroundTask, instruction: InjectedInstruction) => void;
  /** 状态变更回调（每次 setState 后调用） */
  readonly onStateChange?: (task: BackgroundTask) => void;
  /** 统计更新回调（每次 updateStats 后调用） */
  readonly onStatsUpdate?: (task: BackgroundTask, stats: TaskStats) => void;
}

// ============================================================================
// 2. 状态转换表（§6.2）
// ============================================================================

/**
 * 合法状态转换表（11 状态，对齐 docs/new-features.md §F.2）
 *
 * key = 起始状态，value = 允许的目标状态列表。
 * 终态（succeeded / failed / cancelled / timeout）的 value 为空数组，禁止任何转换。
 *
 * 核心路径：
 * - queued → pending → running
 * - running → pausing → paused（pause）
 * - paused → pausing → running（resume）
 * - running → retrying → running
 * - running ⇄ injecting
 * - pending / running / pausing / retrying / injecting → timeout
 */
const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  queued: Object.freeze(["pending", "running", "cancelled", "failed", "succeeded"] as readonly TaskStatus[]),
  pending: Object.freeze(["running", "cancelled", "failed", "timeout"] as readonly TaskStatus[]),
  running: Object.freeze([
    "pausing",
    "injecting",
    "retrying",
    "succeeded",
    "failed",
    "cancelled",
    "timeout",
  ] as readonly TaskStatus[]),
  pausing: Object.freeze(["paused", "running", "failed", "cancelled", "timeout"] as readonly TaskStatus[]),
  paused: Object.freeze(["pausing", "cancelled"] as readonly TaskStatus[]),
  retrying: Object.freeze(["running", "failed", "cancelled", "timeout", "succeeded"] as readonly TaskStatus[]),
  injecting: Object.freeze(["running", "succeeded", "failed", "cancelled", "timeout"] as readonly TaskStatus[]),
  timeout: Object.freeze([] as readonly TaskStatus[]),
  failed: Object.freeze([] as readonly TaskStatus[]),
  succeeded: Object.freeze([] as readonly TaskStatus[]),
  cancelled: Object.freeze([] as readonly TaskStatus[]),
});

/**
 * 校验状态转换是否合法
 *
 * @param from 起始状态
 * @param to 目标状态
 * @returns true 合法 / false 非法
 */
function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) {
    // 不允许自我转换（避免 running → running 等无意义调用）
    return false;
  }
  return VALID_TRANSITIONS[from].includes(to);
}

// ============================================================================
// 3. BackgroundTask 类实现
// ============================================================================

/**
 * 后台任务抽象（一个独立的 LLM 对话会话）
 *
 * 每个 BackgroundTask 拥有：
 * - 独立的 sessionId（与主前台 session 隔离）
 * - 独立的 AbortController（取消不影响前台）
 * - 独立的状态机（queued → pending → running ⇄ pausing ⇄ paused，running ⇄ retrying / injecting → 终态）
 * - 累计统计（iterations / durationMs / tokensUsed）
 *
 * 使用示例：
 * ```typescript
 * const task = new BackgroundTask({
 *   id: "t-abc123",
 *   kind: "chat",
 *   prompt: "调研 React 19 新特性",
 *   controller: new AbortController(),
 *   onStart: async (t) => {
 *     const session = createSessionManager(t.controller);
 *     t.setSessionId(session.id);
 *     await session.handleUserPrompt(t.prompt);
 *     t.markSucceeded("完成");
 *   },
 *   onStateChange: (t) => console.log(`task ${t.id} state: ${t.state}`),
 * });
 * await task.start();
 * ```
 */
export class BackgroundTask {
  // --- readonly 公开字段 ---

  /** 任务 ID（`t-` 前缀 + UUID） */
  public readonly id: string;
  /** 任务类型 */
  public readonly kind: TaskKind;
  /** 初始 prompt 文本 */
  public readonly prompt: string;
  /** 独立的 AbortController（外部注入） */
  public readonly controller: AbortController;

  // --- 可变状态字段（私有，通过 getter 暴露） ---

  /** 当前状态 */
  private _state: TaskStatus = "queued";
  /** 关联的 sessionId */
  private _sessionId: string | null;
  /**
   * 创建时间（ISO 8601）
   *
   * 正常生命周期内不变（构造时赋值一次）；
   * 不声明 readonly 的原因：fromSnapshot 崩溃恢复路径需要将其恢复为快照值，
   * 否则恢复后任务的 startedAt 会被错误地重置为恢复时刻（TC-BT-009 回归）。
   */
  private _startedAt: string;
  /** 最后更新时间（ISO 8601） */
  private _updatedAt: string;
  /** 完成时间（ISO 8601，未完成为 null） */
  private _completedAt: string | null = null;
  /** 任务结果（succeeded 时填充） */
  private _result: string | null = null;
  /** 失败原因（failed / cancelled 时填充） */
  private _error: string | null = null;
  /** 累计统计 */
  private _stats: TaskStats = Object.freeze({
    iterations: 0,
    durationMs: 0,
    tokensUsed: 0,
  });

  // --- 执行时长累加器（用于 stats.durationMs 计算） ---

  /** 当前执行段起点（Date.now()，暂停时累加到 accumulatedDurationMs） */
  private durationStartMs: number;
  /** 累计已执行时长（毫秒，暂停期间不累加） */
  private accumulatedDurationMs = 0;

  // --- 回调集合 ---

  /** 回调集合（构造时一次性注入，后续不变） */
  private readonly callbacks: {
    readonly onStart?: (task: BackgroundTask) => Promise<void> | void;
    readonly onPause?: (task: BackgroundTask) => Promise<void> | void;
    readonly onResume?: (task: BackgroundTask) => Promise<void> | void;
    readonly onCancel?: (task: BackgroundTask, reason?: string) => Promise<void> | void;
    readonly onComplete?: (task: BackgroundTask) => Promise<void> | void;
    readonly onInject?: (task: BackgroundTask, instruction: InjectedInstruction) => void;
    readonly onStateChange?: (task: BackgroundTask) => void;
    readonly onStatsUpdate?: (task: BackgroundTask, stats: TaskStats) => void;
  };

  /**
   * 构造 BackgroundTask
   *
   * 初始状态为 `queued`，需调用 `start()` 进入 `running`。
   *
   * @param options 构造选项
   */
  constructor(options: BackgroundTaskOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.prompt = options.prompt;
    this.controller = options.controller;
    this._sessionId = options.sessionId ?? null;
    this.callbacks = {
      onStart: options.onStart,
      onPause: options.onPause,
      onResume: options.onResume,
      onCancel: options.onCancel,
      onComplete: options.onComplete,
      onInject: options.onInject,
      onStateChange: options.onStateChange,
      onStatsUpdate: options.onStatsUpdate,
    };
    const now = new Date().toISOString();
    this._startedAt = now;
    this._updatedAt = now;
    this.durationStartMs = Date.now();
  }

  // ============================================================================
  // 3.1 只读 getter（外部读取状态）
  // ============================================================================

  /** 当前状态 */
  get state(): TaskStatus {
    return this._state;
  }

  /** 关联的 sessionId（未创建 SessionManager 时为 null） */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * 初始 prompt 文本（用于任务列表展示）
   *
   * 实现 `BackgroundTaskLike.initialPromptText` 契约：
   * - `list_tasks` LLM 工具在任务列表展示时读取此字段
   * - 真实值为构造时传入的 `prompt` 字段
   */
  get initialPromptText(): string {
    return this.prompt;
  }

  /**
   * 任务进度（0-1 浮点数）
   *
   * 实现 `BackgroundTaskLike.progress` 契约：
   * - `list_tasks` LLM 工具在任务列表展示时读取此字段
   *
   * 11 状态粗粒度映射策略：
   * - succeeded: 1（已完成）
   * - running / injecting / retrying / pausing / paused: 0.5（处理中）
   * - pending: 0.1（已调度，未真正执行）
   * - queued / failed / cancelled / timeout: 0（未开始或已终止）
   *
   * 注：Phase 3 引入 autonomous 4 阶段循环后，可基于阶段索引细化进度
   */
  get progress(): number {
    switch (this._state) {
      case "succeeded":
        return 1;
      case "running":
      case "injecting":
      case "retrying":
      case "pausing":
      case "paused":
        return 0.5;
      case "pending":
        return 0.1;
      case "queued":
      case "failed":
      case "cancelled":
      case "timeout":
      default:
        return 0;
    }
  }

  /** 创建时间（ISO 8601） */
  get startedAt(): string {
    return this._startedAt;
  }

  /** 最后更新时间（ISO 8601） */
  get updatedAt(): string {
    return this._updatedAt;
  }

  /** 完成时间（ISO 8601，未完成为 null） */
  get completedAt(): string | null {
    return this._completedAt;
  }

  /** 任务结果（succeeded 时填充） */
  get result(): string | null {
    return this._result;
  }

  /** 失败原因（failed / cancelled 时填充） */
  get error(): string | null {
    return this._error;
  }

  /** 累计统计（不可变快照） */
  get stats(): TaskStats {
    return this._stats;
  }

  // ============================================================================
  // 3.2 控制方法（start / pause / resume / cancel / inject）
  // ============================================================================

  /**
   * 启动任务
   *
   * 流程：
   * 1. 校验状态（必须为 queued）
   * 2. setState("pending")（已提交调度）
   * 3. setState("running")（让 onStart 内部能调用 markSucceeded/markFailed/markTimeout 等）
   * 4. 调用 onStart 回调（可能抛错）
   *    - 同步抛错：catch 块 setState("failed")，重新抛出错误
   *    - 异步抛错：onStart 返回 Promise，await 时捕获，setState("failed")
   *
   * 设计决策（queued → pending → running 再调 onStart）：
   * - 符合 docs/new-features.md §F.2 的 11 状态路径
   * - onStart 内部可能立即调用 markSucceeded（如快速成功的会话）
   * - onStart 内部可能异步启动会话（void handle.handleUserPrompt().then(...)）
   *   .then 微任务可能在 await 恢复前执行，此时 state 必须已是 running
   * - 若先调用 onStart 再转 running，.then 微任务检查 state==="running" 会失败
   *
   * 注：onStart 内部可异步启动会话（不等待 handleUserPrompt 完成），
   * 这种情况下 start() 返回时状态为 running，后续会话完成时通过
   * markSucceeded / markFailed / markTimeout 转换状态。
   *
   * @throws {InvalidStateTransitionError} 当状态不为 queued  时
   * @throws {Error} 当 onStart 回调抛错时（已 setState("failed")）
   */
  async start(): Promise<void> {
    if (this._state !== "queued") {
      throw new InvalidStateTransitionError(
        this._state,
        "pending",
        `start() 仅允许从 queued 状态调用，当前状态：${this._state}`
      );
    }
    // 步骤 1：进入 pending（已提交调度，等待真正执行）
    this.setState("pending");
    // 步骤 2：进入 running，让 onStart 内部能调用 markSucceeded/markFailed/markTimeout 等
    this.setState("running");
    try {
      if (this.callbacks.onStart) {
        await this.callbacks.onStart(this);
      }
      // onStart 成功完成，状态保持 running（或已被 markSucceeded/markFailed 转换）
    } catch (err) {
      // onStart 抛错时转为 failed
      this._error = err instanceof Error ? err.message : String(err);
      // 状态可能是 running / succeeded / failed / cancelled / timeout（onStart 内部可能已转换）
      // 使用类型断言避免 TypeScript 控制流缩窄（setState 修改 _state 后 TS 不更新缩窄）
      const currentState: TaskStatus = this._state as TaskStatus;
      if (isValidTransition(currentState, "failed")) {
        this.setState("failed");
      }
      throw err;
    }
  }

  /**
   * 暂停任务
   *
   * 流程：
   * 1. 校验状态（必须为 running）
   * 2. 累加已执行时长到 accumulatedDurationMs
   * 3. controller.abort("pause")（触发 AbortController 信号）
   * 4. 调用 onPause 回调（异步回调不等待，错误吞掉记录到 stderr）
   * 5. setState("pausing") → setState("paused")
   *
   * 注：controller.abort 后 signal.aborted = true，
   * 后续 resume 时需由调用方创建新 controller（Phase 1 中由 onResume 回调处理）。
   *
   * @throws {InvalidStateTransitionError} 当状态不为 running 时
   */
  pause(): void {
    if (this._state !== "running") {
      throw new InvalidStateTransitionError(
        this._state,
        "pausing",
        `pause() 仅允许从 running 状态调用，当前状态：${this._state}`
      );
    }
    // 累加已执行时长
    this.accumulatedDurationMs += Date.now() - this.durationStartMs;
    // 触发 abort 信号（暂停信号，区别于 cancel）
    if (!this.controller.signal.aborted) {
      this.controller.abort("pause");
    }
    // 调用回调（同步调用，异步回调不等待）
    this.invokeSyncCallback("onPause", this.callbacks.onPause, this);
    // 状态流转：running → pausing → paused
    this.setState("pausing");
    this.setState("paused");
  }

  /**
   * 恢复任务
   *
   * 流程：
   * 1. 校验状态（必须为 paused）
   * 2. 重置时长起点（durationStartMs = Date.now()）
   * 3. setState("pausing")
   * 4. 调用 onResume 回调（异步等待完成）
   *    - 回调内部应重建 AbortController 并重新启动 LLM 流
   * 5. setState("running")
   *
   * 注：原 controller 已 abort，onResume 回调内部需创建新 controller。
   * 但由于 controller 是 readonly 字段，Phase 1 中由 BackgroundTaskRunner
   * 在 onResume 中替换整个 BackgroundTask 实例（或通过闭包持有外部 controller 引用）。
   *
   * @throws {InvalidStateTransitionError} 当状态不为 paused 时
   * @throws {Error} 当 onResume 回调抛错时（状态回退到 paused）
   */
  async resume(): Promise<void> {
    if (this._state !== "paused") {
      throw new InvalidStateTransitionError(
        this._state,
        "pausing",
        `resume() 仅允许从 paused 状态调用，当前状态：${this._state}`
      );
    }
    // 重置时长起点
    this.durationStartMs = Date.now();
    // 状态流转：paused → pausing
    this.setState("pausing");
    // 调用回调（异步等待）
    if (this.callbacks.onResume) {
      try {
        await this.callbacks.onResume(this);
      } catch (err) {
        // onResume 抛错时回退到 paused，允许再次 resume
        console.error(
          `[BackgroundTask ${this.id}] onResume 回调抛错（状态回退到 paused）：`,
          err instanceof Error ? err.message : String(err)
        );
        this.setState("paused");
        throw err;
      }
    }
    this.setState("running");
  }

  /**
   * 取消任务
   *
   * 流程：
   * 1. 校验状态（不能为终态）
   * 2. 累加已执行时长（如果是 running 状态）
   * 3. controller.abort("cancel")（如未已 abort）
   * 4. 调用 onCancel 回调（异步回调不等待，错误吞掉记录到 stderr）
   * 5. setState("cancelled")
   *
   * 注：cancel 与 pause 的区别：
   * - pause：从 running 转 paused（路径 running → pausing → paused），可 resume
   * - cancel：从任意非终态转 cancelled（终态），不可恢复
   *
   * @param reason 取消原因（可选，记录到 error 字段）
   * @throws {InvalidStateTransitionError} 当状态为终态时
   */
  cancel(reason?: string): void {
    // 终态禁止再次 cancel
    if (TERMINAL_STATUSES.includes(this._state)) {
      throw new InvalidStateTransitionError(
        this._state,
        "cancelled",
        `cancel() 不允许从终态调用，当前状态：${this._state}`
      );
    }
    // 累加已执行时长（仅 running 状态需要累加）
    if (this._state === "running") {
      this.accumulatedDurationMs += Date.now() - this.durationStartMs;
    }
    // 触发 abort 信号（取消信号）
    if (!this.controller.signal.aborted) {
      this.controller.abort("cancel");
    }
    // 记录取消原因
    if (reason) {
      this._error = reason;
    }
    // 调用回调（同步调用，异步回调不等待）
    this.invokeSyncCallback("onCancel", this.callbacks.onCancel, this, reason);
    this.setState("cancelled");
  }

  /**
   * 注入指令到该任务
   *
   * Phase 1 实现：仅调用 onInject 回调，由回调处理 InterruptQueue.enqueue。
   *
   * 设计约束：
   * - 仅在 running / paused / queued 状态下允许注入
   * - 终态（succeeded / failed / cancelled）下注入抛错
   * - injecting 状态下注入抛错（避免嵌套注入）
   *
   * @param instruction 注入指令
   * @throws {InvalidStateTransitionError} 当状态为终态或 injecting 时
   */
  inject(instruction: InjectedInstruction): void {
    if (this._state !== "running" && this._state !== "paused" && this._state !== "queued") {
      throw new InvalidStateTransitionError(
        this._state,
        "injecting",
        `inject() 仅允许从 running / paused / queued 状态调用，当前状态：${this._state}`
      );
    }
    if (this.callbacks.onInject) {
      this.callbacks.onInject(this, instruction);
    }
  }

  // ============================================================================
  // 3.3 完成标记方法（由 onStart 回调内部调用）
  // ============================================================================

  /**
   * 标记任务成功完成
   *
   * 由 onStart 回调内部调用，主流程结束时通知任务成功。
   *
   * 流程：
   * 1. 校验状态（必须为 queued / running / injecting，不能为终态）
   *    - queued：onStart 内部立即 markSucceeded（如快速成功的会话）
   *    - running：onStart 内部异步任务完成
   *    - injecting：注入处理过程中完成
   * 2. 累加已执行时长（仅 running 状态需要累加，queued / injecting 不累加）
   * 3. 设置 result 字段
   * 4. setState("succeeded")（触发 onStateChange + onComplete）
   *
   * @param result 任务结果（可选，例如最终回复摘要）
   * @throws {InvalidStateTransitionError} 当状态为终态时
   */
  markSucceeded(result?: string): void {
    const allowed: readonly TaskStatus[] = ["queued", "running", "injecting", "retrying"];
    if (!allowed.includes(this._state)) {
      throw new InvalidStateTransitionError(
        this._state,
        "succeeded",
        `markSucceeded() 仅允许从 ${allowed.join(" / ")} 状态调用，当前状态：${this._state}`
      );
    }
    // 累加已执行时长（仅 running 状态需要累加）
    if (this._state === "running") {
      this.accumulatedDurationMs += Date.now() - this.durationStartMs;
    }
    this._result = result ?? null;
    this.setState("succeeded");
  }

  /**
   * 标记任务失败
   *
   * 由 onStart 回调内部调用，异常时通知任务失败。
   * 也可由外部调用（例如 BackgroundTaskRunner 检测到不可恢复错误时）。
   *
   * 流程：
   * 1. 校验状态（不能为终态）
   * 2. 累加已执行时长（如果是 running 状态）
   * 3. 设置 error 字段
   * 4. setState("failed")（触发 onStateChange + onComplete）
   *
   * @param error 失败原因
   * @throws {InvalidStateTransitionError} 当状态为终态时
   */
  markFailed(error: string): void {
    // 终态不可转换
    if (TERMINAL_STATUSES.includes(this._state)) {
      throw new InvalidStateTransitionError(
        this._state,
        "failed",
        `markFailed() 不允许从终态调用，当前状态：${this._state}`
      );
    }
    // paused 状态没有到 failed 的合法转换
    if (this._state === "paused") {
      throw new InvalidStateTransitionError(
        this._state,
        "failed",
        `markFailed() 不允许从 paused 状态调用，当前状态：${this._state}`
      );
    }
    // 累加已执行时长（如果是 running 状态）
    if (this._state === "running") {
      this.accumulatedDurationMs += Date.now() - this.durationStartMs;
    }
    this._error = error;
    this.setState("failed");
  }

  /**
   * 标记任务进入重试状态
   *
   * 由 onStart 回调内部或重试策略调用，将任务从 running 转为 retrying。
   * retrying 为中间状态，完成后应转回 running 或进入终态。
   *
   * @throws {InvalidStateTransitionError} 当状态不为 running 时
   */
  markRetrying(): void {
    if (this._state !== "running") {
      throw new InvalidStateTransitionError(
        this._state,
        "retrying",
        `markRetrying() 仅允许从 running 状态调用，当前状态：${this._state}`
      );
    }
    this.setState("retrying");
  }

  /**
   * 标记任务超时
   *
   * 由外部超时检测机制调用，将任务从 pending / running / pausing / retrying / injecting
   * 转为 timeout 终态。
   *
   * @param error 超时原因（可选，默认 "任务执行超时"）
   * @throws {InvalidStateTransitionError} 当当前状态不允许转 timeout 时
   */
  markTimeout(error?: string): void {
    const allowed: readonly TaskStatus[] = ["pending", "running", "pausing", "retrying", "injecting"];
    if (!allowed.includes(this._state)) {
      throw new InvalidStateTransitionError(
        this._state,
        "timeout",
        `markTimeout() 仅允许从 ${allowed.join(" / ")} 状态调用，当前状态：${this._state}`
      );
    }
    // 累加已执行时长（仅 running 状态需要累加）
    if (this._state === "running") {
      this.accumulatedDurationMs += Date.now() - this.durationStartMs;
    }
    // 触发 abort 信号（超时信号）
    if (!this.controller.signal.aborted) {
      this.controller.abort("timeout");
    }
    this._error = error ?? "任务执行超时";
    this.setState("timeout");
  }

  // ============================================================================
  // 3.4 内部状态管理（setState / updateStats / setSessionId）
  // ============================================================================

  /**
   * 状态转换（public，但建议仅在回调内部使用）
   *
   * 校验状态机不变式（docs/new-features.md §F.2）：
   * - queued → pending / running / cancelled / failed / succeeded ✓
   * - pending → running / cancelled / failed / timeout ✓
   * - running → pausing / injecting / retrying / succeeded / failed / cancelled / timeout ✓
   * - pausing → paused / running / failed / cancelled / timeout ✓
   * - paused → pausing / cancelled ✓
   * - retrying → running / failed / cancelled / timeout / succeeded ✓
   * - injecting → running / succeeded / failed / cancelled / timeout ✓
   * - succeeded / failed / cancelled / timeout：终态，禁止任何转换
   *
   * 转换成功后：
   * 1. 更新 _state / _updatedAt
   * 2. 终态时设置 _completedAt
   * 3. 调用 onStateChange 回调
   * 4. 终态时调用 onComplete 回调（异步回调不等待）
   *
   * @param next 目标状态
   * @throws {InvalidStateTransitionError} 非法转换
   */
  setState(next: TaskStatus): void {
    if (!isValidTransition(this._state, next)) {
      throw new InvalidStateTransitionError(this._state, next);
    }
    this._state = next;
    this._updatedAt = new Date().toISOString();
    // 终态设置完成时间
    if (TERMINAL_STATUSES.includes(next)) {
      this._completedAt = this._updatedAt;
    }
    // 触发 onStateChange 回调
    if (this.callbacks.onStateChange) {
      try {
        this.callbacks.onStateChange(this);
      } catch (err) {
        // 回调抛错不影响状态转换，记录到 stderr
        console.error(
          `[BackgroundTask ${this.id}] onStateChange 回调抛错（已忽略）：`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    // 终态触发 onComplete 回调（异步回调不等待）
    if (TERMINAL_STATUSES.includes(next)) {
      if (this.callbacks.onComplete) {
        const result = this.callbacks.onComplete(this);
        if (result instanceof Promise) {
          // 异步回调不等待，错误吞掉记录到 stderr
          result.catch((err) => {
            console.error(
              `[BackgroundTask ${this.id}] onComplete 回调抛错（已忽略）：`,
              err instanceof Error ? err.message : String(err)
            );
          });
        }
      }
    }
  }

  /**
   * 更新统计信息
   *
   * 与现有 stats 合并（patch 字段覆盖，未提供字段保留原值）。
   * durationMs 未提供时自动计算（accumulatedDurationMs + 当前执行段）。
   *
   * @param patch 部分统计字段
   */
  updateStats(patch: Partial<TaskStats>): void {
    const currentDurationMs =
      patch.durationMs ??
      this.accumulatedDurationMs + (this._state === "running" ? Date.now() - this.durationStartMs : 0);
    this._stats = Object.freeze({
      iterations: patch.iterations ?? this._stats.iterations,
      durationMs: currentDurationMs,
      tokensUsed: patch.tokensUsed ?? this._stats.tokensUsed,
    });
    if (this.callbacks.onStatsUpdate) {
      try {
        this.callbacks.onStatsUpdate(this, this._stats);
      } catch (err) {
        console.error(
          `[BackgroundTask ${this.id}] onStatsUpdate 回调抛错（已忽略）：`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /**
   * 设置 sessionId
   *
   * 由 onStart 回调内部调用，SessionManager 创建后回填 sessionId。
   *
   * @param sessionId 会话 ID
   */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
  }

  // ============================================================================
  // 3.5 序列化与重建（toSnapshot / fromSnapshot）
  // ============================================================================

  /**
   * 序列化为可持久化的 TaskSnapshot
   *
   * 不含 controller / functions / 回调，仅含可序列化字段。
   * 返回值 Object.freeze 冻结，防止外部修改。
   *
   * @returns 任务快照
   */
  toSnapshot(): TaskSnapshot {
    return Object.freeze({
      id: this.id,
      kind: this.kind,
      status: this._state,
      prompt: this.prompt,
      sessionId: this._sessionId,
      startedAt: this._startedAt,
      updatedAt: this._updatedAt,
      completedAt: this._completedAt,
      result: this._result,
      error: this._error,
      stats: this._stats,
    });
  }

  /**
   * 从快照重建 BackgroundTask（不自动 start）
   *
   * 用于崩溃恢复：进程启动时加载 .deepcodex/tasks/*.json，
   * 重建 BackgroundTask 实例，状态保持快照中的状态（不转为 running）。
   *
   * 重建后的实例：
   * - 创建新的 AbortController（如快照状态为 cancelled / timeout / failed，立即 abort）
   * - 注入新的回调集合
   * - 内部状态直接设置（绕过状态机校验，因为是从持久化恢复）
   * - 不调用 start()（用户需显式调用 resume() 或 start()）
   *
   * @param snapshot 持久化快照
   * @param callbacks 回调集合（重建后需重新注入回调）
   * @returns 重建后的 BackgroundTask 实例
   */
  static fromSnapshot(
    snapshot: TaskSnapshot,
    callbacks: Omit<BackgroundTaskOptions, "id" | "kind" | "prompt" | "sessionId" | "controller">
  ): BackgroundTask {
    const controller = new AbortController();
    // 如果快照状态是 cancelled / timeout / failed，恢复时立即 abort
    if (snapshot.status === "cancelled" || snapshot.status === "timeout" || snapshot.status === "failed") {
      controller.abort(snapshot.status);
    }
    const task = new BackgroundTask({
      id: snapshot.id,
      kind: snapshot.kind,
      prompt: snapshot.prompt,
      sessionId: snapshot.sessionId,
      controller,
      onStart: callbacks.onStart,
      onPause: callbacks.onPause,
      onResume: callbacks.onResume,
      onCancel: callbacks.onCancel,
      onComplete: callbacks.onComplete,
      onInject: callbacks.onInject,
      onStateChange: callbacks.onStateChange,
      onStatsUpdate: callbacks.onStatsUpdate,
    });
    // 直接设置内部状态（绕过状态机校验，因为是从持久化恢复）
    task._state = snapshot.status;
    // 恢复创建时间：缺省时回退为 updatedAt，保证不为构造函数写入的恢复时刻
    task._startedAt = snapshot.startedAt ?? snapshot.updatedAt;
    task._updatedAt = snapshot.updatedAt;
    task._completedAt = snapshot.completedAt;
    task._result = snapshot.result;
    task._error = snapshot.error;
    task._stats = snapshot.stats;
    // 已完成的任务累计时长设为快照中的 durationMs
    task.accumulatedDurationMs = snapshot.stats.durationMs;
    return task;
  }

  // ============================================================================
  // 3.6 内部辅助方法
  // ============================================================================

  /**
   * 同步调用回调（异步回调不等待，错误吞掉记录到 stderr）
   *
   * @param name 回调名（用于日志）
   * @param callback 回调函数（可选）
   * @param args 回调参数
   */
  private invokeSyncCallback<A extends unknown[]>(
    name: string,
    callback: ((...args: A) => Promise<void> | void) | undefined,
    ...args: A
  ): void {
    if (!callback) {
      return;
    }
    try {
      const result = callback(...args);
      if (result instanceof Promise) {
        // 异步回调不等待，错误吞掉记录到 stderr
        result.catch((err) => {
          console.error(
            `[BackgroundTask ${this.id}] ${name} 回调抛错（已忽略）：`,
            err instanceof Error ? err.message : String(err)
          );
        });
      }
    } catch (err) {
      // 同步回调抛错不影响状态转换，记录到 stderr
      console.error(
        `[BackgroundTask ${this.id}] ${name} 回调抛错（已忽略）：`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
