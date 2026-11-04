/**
 * Worker 指令通道 —— 让注入的指令**真正到达** Worker 的 LLM 调用
 *
 * ## 为什么需要它
 *
 * 2026-11-03 实测发现的一处真实缺陷（F1）：
 *
 * 1. `interrupts/background-runner.ts` 构造 `BackgroundTask` 时**从不传 `onInject`**；
 * 2. `interrupts/background-task.ts:565` 的 `if (this.callbacks.onInject)` **恒为 false**
 *    → `inject()` **静默无操作**；
 * 3. `super-agent/runtime.ts` 却照常 `markInputDelivered` → **输入被记为已投递，
 *    实际从未到达 LLM**。
 *
 * 修好第 1 步（接线）之后，还差一环：**Worker 会话要有地方消费这些指令**。
 * 首期 Worker 是「一次真实 LLM 调用 + 结构化报告回灌」，调用结束即完成——
 * 注入进来的指令若无人消费，仍然是死信。
 *
 * 本模块提供那个消费端：一个**按 taskId 隔离的 FIFO 缓冲 + 存活标记**。
 *
 * ## 语义
 *
 * | 方法 | 语义 |
 * |---|---|
 * | `push(instruction)` | 缓冲一条指令；返回**是否仍会被消费**（即通道是否存活） |
 * | `drain()` | 取出并清空缓冲（Worker 每轮 LLM 调用后调用） |
 * | `deactivate()` | 标记通道不再消费（Worker 收尾时调用） |
 * | `isActive(taskId)` | 通道是否仍存活 |
 *
 * ## 竞态：为什么「drain 为空 → 退出」不会漏投递
 *
 * Worker 的循环形如：
 * ```
 * result = await callLlmOnce(...)     // 异步，注入可能在此期间到达
 * outputs.set(...)
 * instrs = channel.drain()            // 同步
 * if (instrs.length === 0) {
 *   channel.deactivate()               // 同步
 *   return                            // 同步
 * }
 * ```
 *
 * `drain()` 与 `deactivate()` 之间**没有 await**，在 JS 单线程下不可被打断，
 * 因此「drain 为空」与「通道失活」之间不存在注入插入的窗口。
 * 注入若落在 `deactivate()` 之后，`push()` 会因通道已失活而返回 `false`，
 * 上层据此**不标记「已送达」**——如实降级，而不是静默丢失。
 *
 * @module super-agent/worker/channel
 */

/** 注入指令（与 `interrupts/types.ts` 的 `InjectedInstruction` 同形） */
export interface WorkerInstruction {
  /** 指令 ID */
  readonly id: string;
  /** 指令正文 */
  readonly text: string;
  /** 入队时间（ISO 8601） */
  readonly enqueuedAt: string;
  /** 来源 */
  readonly source: "user" | "llm";
}

/**
 * WorkerInstructionChannel —— 单个 Worker 的指令缓冲
 */
export class WorkerInstructionChannel {
  /** 缓冲的指令（FIFO） */
  private readonly buffer: WorkerInstruction[] = [];
  /** 通道是否仍会消费指令 */
  private active = true;

  /**
   * 缓冲一条指令
   *
   * @param instruction 指令
   * @returns 是否仍会被消费（false = 通道已失活，指令不会被 Worker 读到）
   */
  push(instruction: WorkerInstruction): boolean {
    if (!this.active) {
      return false;
    }
    this.buffer.push(instruction);
    return true;
  }

  /**
   * 取出并清空缓冲
   *
   * @returns 指令列表（按入队顺序）
   */
  drain(): readonly WorkerInstruction[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const items = this.buffer.slice();
    this.buffer.length = 0;
    return items;
  }

  /** 标记通道不再消费（Worker 收尾时调用） */
  deactivate(): void {
    this.active = false;
  }

  /** 通道是否仍存活 */
  get isActive(): boolean {
    return this.active;
  }

  /** 当前缓冲长度 */
  get size(): number {
    return this.buffer.length;
  }
}

/**
 * WorkerInstructionRegistry —— 按 taskId 隔离的通道集合
 */
export class WorkerInstructionRegistry {
  /** taskId → 通道 */
  private readonly channels = new Map<string, WorkerInstructionChannel>();

  /**
   * 取（或创建）某任务的通道
   *
   * @param taskId 任务 ID
   * @returns 通道
   */
  channelFor(taskId: string): WorkerInstructionChannel {
    let channel = this.channels.get(taskId);
    if (channel === undefined) {
      channel = new WorkerInstructionChannel();
      this.channels.set(taskId, channel);
    }
    return channel;
  }

  /**
   * 投递一条指令
   *
   * @param taskId 任务 ID
   * @param instruction 指令
   * @returns 是否仍会被消费
   */
  push(taskId: string, instruction: WorkerInstruction): boolean {
    return this.channelFor(taskId).push(instruction);
  }

  /**
   * 取出并清空某任务的缓冲
   *
   * @param taskId 任务 ID
   * @returns 指令列表
   */
  drain(taskId: string): readonly WorkerInstruction[] {
    return this.channels.get(taskId)?.drain() ?? [];
  }

  /**
   * 标记某任务的通道失活
   *
   * @param taskId 任务 ID
   */
  deactivate(taskId: string): void {
    this.channels.get(taskId)?.deactivate();
  }

  /**
   * 某任务的通道是否仍存活
   *
   * @param taskId 任务 ID
   * @returns 是否存活（无通道 = 不可投递）
   */
  isActive(taskId: string): boolean {
    return this.channels.get(taskId)?.isActive ?? false;
  }

  /**
   * 移除某任务的通道（Worker 终态时调用）
   *
   * @param taskId 任务 ID
   */
  forget(taskId: string): void {
    this.channels.delete(taskId);
  }
}
