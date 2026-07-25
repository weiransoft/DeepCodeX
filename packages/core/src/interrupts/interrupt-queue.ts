/**
 * 中断指令队列（FIFO）—— ADR-DI-001 §3.1 实现
 *
 * 本模块实现 `InterruptQueue` 类，是动态指令注入特性（`/inject`）的核心数据结构。
 *
 * 核心职责（对齐 ADR-DI-001 §3.1 + §5.1）：
 * 1. 接收用户 /inject <指令> 或 LLM inject_message 工具的注入指令
 * 2. 按 FIFO 顺序缓存指令
 * 3. 由 SessionManager 主循环每次 LLM 调用前调用 drain() 取出全部指令
 * 4. 容量上限保护（MAX_QUEUE_SIZE = 64，防止内存爆炸）
 *
 * 设计约束（Karpathy Simplicity First）：
 * - 仅内存对象，不持久化（崩溃恢复由 TaskRegistry 维护任务级状态，不维护指令级状态——YAGNI）
 * - FIFO 顺序保证指令按用户输入顺序被消费
 * - 不可变快照：drain() / peek() 返回不可变 readonly array，避免外部修改
 * - 容量上限：MAX_QUEUE_SIZE = 64，超限抛 QueueOverflowError
 *
 * 重入保护（防止回调中再次入队导致递归）：
 * - onEnqueue 回调中再次调用 enqueue 会抛错
 * - 防止 SessionManager 主循环检查 → enqueue → 主循环检查 → enqueue 的无限递归
 *
 * 线程模型（Node.js 单线程事件循环）：
 * - 不需要锁，但需要防止同步代码中的重入
 * - 异步代码中再次入队是允许的（事件循环已切换上下文）
 *
 * @module interrupts/interrupt-queue
 */

import type { InjectedInstruction, InterruptQueueOptions } from "./types";
import { QueueOverflowError } from "./types";

// ============================================================================
// InterruptQueue 类实现
// ============================================================================

/**
 * 中断指令队列（FIFO）
 *
 * 每个 SessionManager 实例持有一个 InterruptQueue（仅在主前台任务运行时活跃）。
 * 用户 `/inject <指令>` 将指令追加到队列尾部；主循环每次 LLM 调用前
 * 调用 `drain()` 取出全部待处理指令，合成为 system 消息追加到会话消息流，
 * 实现"任务中动态调整方向"。
 *
 * 使用示例：
 * ```typescript
 * const queue = new InterruptQueue({
 *   onEnqueue: () => sessionManager.notifyInterrupt(),
 * });
 * queue.enqueue({ id: crypto.randomUUID(), text: "加上错误处理", enqueuedAt: new Date().toISOString(), source: "user" });
 * const instructions = queue.drain();
 * console.log(instructions.length); // 1
 * console.log(queue.size);          // 0
 * ```
 */
export class InterruptQueue {
  /** 队列容量上限，防止用户狂输 /inject 导致内存爆炸 */
  static readonly MAX_QUEUE_SIZE = 64 as const;

  /** 内部存储（FIFO，从尾部入队 push，从头部出队 splice(0)） */
  private readonly queue: InjectedInstruction[] = [];

  /** 入队回调（用于触发 SessionManager 主循环检查） */
  private readonly onEnqueueCallback?: () => void;

  /** 重入保护标志（防止 onEnqueue 回调中再次入队导致递归） */
  private isMutating = false;

  /**
   * 构造 InterruptQueue
   *
   * @param options 构造选项（含 onEnqueue 回调）
   */
  constructor(options?: InterruptQueueOptions) {
    this.onEnqueueCallback = options?.onEnqueue;
  }

  /**
   * 追加一条指令到队尾。
   *
   * 校验顺序：
   * 1. 重入保护：回调中再次入队抛错
   * 2. text 非空校验：空字符串抛错
   * 3. 容量上限校验：超限抛 QueueOverflowError
   *
   * 入队成功后同步触发 onEnqueue 回调。
   * 回调抛错不影响入队结果（错误被吞掉，记录到 stderr）。
   *
   * @param instruction 注入指令（text 不能为空字符串）
   * @throws {Error} 当 text 为空字符串时
   * @throws {Error} 当回调中重入调用 enqueue 时
   * @throws {QueueOverflowError} 当队列已满（size >= MAX_QUEUE_SIZE）时
   */
  enqueue(instruction: InjectedInstruction): void {
    // 重入保护：防止 onEnqueue 回调中再次入队导致递归
    if (this.isMutating) {
      throw new Error("InterruptQueue.enqueue 重入禁止：onEnqueue 回调中不可再次调用 enqueue");
    }
    // text 非空校验
    if (!instruction.text || instruction.text.length === 0) {
      throw new Error("InterruptQueue.enqueue 失败：instruction.text 不能为空字符串");
    }
    // 容量上限校验
    if (this.queue.length >= InterruptQueue.MAX_QUEUE_SIZE) {
      throw new QueueOverflowError(
        `InterruptQueue 已满（容量上限 ${InterruptQueue.MAX_QUEUE_SIZE}），拒绝入队`,
        this.queue.length,
        InterruptQueue.MAX_QUEUE_SIZE
      );
    }
    // 入队 + 触发回调（重入保护）
    this.isMutating = true;
    try {
      this.queue.push(instruction);
      if (this.onEnqueueCallback) {
        try {
          this.onEnqueueCallback();
        } catch (err) {
          // 回调抛错不影响入队结果，仅记录到 stderr
          // 注：使用 console.error 而非 throw，避免破坏主流程
          console.error(
            "[InterruptQueue] onEnqueue 回调抛错（已忽略）：",
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    } finally {
      this.isMutating = false;
    }
  }

  /**
   * 取出并清空全部待处理指令。
   *
   * 返回不可变 readonly array，按 FIFO 入队顺序排列。
   * 调用后队列被清空，size 变为 0。
   *
   * 设计约束：
   * - 返回值不可变（Object.freeze），外部修改不影响内部状态
   * - 队列已空时返回空数组（不抛错）
   * - 不触发任何回调
   *
   * @returns 不可变数组（按 FIFO 入队顺序）
   */
  drain(): readonly InjectedInstruction[] {
    // splice(0) 取出全部并清空原数组
    const snapshot = this.queue.splice(0);
    // 冻结返回值，防止外部修改
    return Object.freeze(snapshot) as readonly InjectedInstruction[];
  }

  /**
   * 查看但不消费（用于状态展示）。
   *
   * 返回不可变 readonly array，按 FIFO 入队顺序排列。
   * 调用后队列不变，size 不变。
   *
   * 使用场景：
   * - /tasks 命令展示队列长度
   * - 调试日志输出队列内容
   *
   * @returns 不可变数组（按 FIFO 入队顺序）
   */
  peek(): readonly InjectedInstruction[] {
    // 复制一份并冻结，防止外部修改影响内部状态
    return Object.freeze([...this.queue]) as readonly InjectedInstruction[];
  }

  /**
   * 清空队列（不触发回调）。
   *
   * 使用场景：
   * - 任务取消时清理未消费的指令
   * - 测试中重置队列状态
   */
  clear(): void {
    this.queue.splice(0);
  }

  /**
   * 当前队列长度（只读 getter）。
   *
   * 用于 SessionManager 主循环快速检查是否有指令待消费：
   * ```typescript
   * if (queue.size > 0) {
   *   const instructions = queue.drain();
   *   // ... 合成 system 消息
   * }
   * ```
   */
  get size(): number {
    return this.queue.length;
  }
}
