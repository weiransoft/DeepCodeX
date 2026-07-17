/**
 * DeepCodeX 多角色团队 - ReloadGuard 完整实现
 *
 * 来源：multi-agent-team skill scripts/dispatcher/reload_guard.py
 * 严格遵循 user rules：禁止 mock/占位/简化；临界区保护必须真实串行化
 * Karpathy 原则：Simplicity First - 状态机最小化（idle / busy）
 *
 * 核心契约：
 *   1. ReloadGuard 串行化所有 hot_reload 操作（避免并发导致 ghost plugin）
 *   2. 支持 tryAcquire（带超时的非阻塞获取）
 *   3. 支持 waitFor（阻塞等待直到空闲）
 *   4. 支持 forceBreak（紧急情况强制重置）
 *   5. 持有者追踪：guard 进入时记录 holder，退出时清空
 *
 * 与 multi-agent-team v2.7 字段对齐：
 *   - try_acquire / release / force_break / is_busy
 *   - 持有者追踪（用于错误信息定位）
 */

import { ReloadGuardBusyError } from "./errors.js";

// ============================================================================
// 第一部分：状态机定义
// ============================================================================

/**
 * ReloadGuard 状态
 */
export type GuardState = "idle" | "busy";

/**
 * 持有者信息
 */
export interface GuardHolder {
  /** 持有者标识（一般是 file path 或 operation id） */
  id: string;
  /** 进入时间（毫秒时间戳） */
  acquiredAt: number;
  /** 截止时间（0 表示无超时） */
  deadlineMs: number;
}

// ============================================================================
// 第二部分：ReloadGuard 类
// ============================================================================

/**
 * ReloadGuard - 串行化 hot_reload 临界区
 *
 * 使用模式：
 *   const guard = new ReloadGuard();
 *   // 方式 1：阻塞获取
 *   if (guard.tryAcquire("reload-xxx.js", 5000)) {
 *     try { ... } finally { guard.release(); }
 *   }
 *   // 方式 2：异步等待
 *   await guard.waitFor("reload-xxx.js", 5000);
 *   try { ... } finally { guard.release(); }
 */
export class ReloadGuard {
  private state: GuardState = "idle";
  private holder: GuardHolder | null = null;
  /** 等待者队列（先进先出） */
  private readonly waiters: Array<{
    id: string;
    resolve: (released: boolean) => void;
    enqueuedAt: number;
  }> = [];
  /** 默认超时（毫秒） */
  private readonly defaultTimeoutMs: number;
  /** 统计 */
  private stats = {
    totalAcquired: 0,
    totalReleased: 0,
    totalTimedOut: 0,
    totalForceBreaks: 0,
  };

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  }

  /**
   * 检查是否繁忙
   */
  isBusy(): boolean {
    return this.state === "busy";
  }

  /**
   * 获取当前持有者（用于错误诊断）
   */
  currentHolder(): GuardHolder | null {
    return this.holder;
  }

  /**
   * 队列长度（用于监控）
   */
  queueLength(): number {
    return this.waiters.length;
  }

  /**
   * 获取统计信息
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * 尝试获取 guard（非阻塞）
   *
   * @param holderId 持有者标识
   * @param timeoutMs 超时（毫秒；0 = 不等待）
   * @returns true 表示已获取
   */
  tryAcquire(holderId: string, timeoutMs: number = 0): boolean {
    if (this.state === "busy") {
      if (timeoutMs === 0) return false;
      // 同步等待：忙循环（不推荐，保留为兼容 API）
      const start = Date.now();
      while (this.state === "busy" && Date.now() - start < timeoutMs) {
        // 同步等待会阻塞事件循环，仅用于极短超时场景
      }
      if (this.state === "busy") {
        this.stats.totalTimedOut++;
        return false;
      }
    }
    this.enter(holderId, timeoutMs);
    return true;
  }

  /**
   * 异步等待获取 guard
   *
   * @param holderId 持有者标识
   * @param timeoutMs 超时（毫秒；0 = 无限等待）
   * @returns 成功获取返回 true；超时返回 false
   */
  async waitFor(holderId: string, timeoutMs: number = 0): Promise<boolean> {
    if (this.state === "idle") {
      this.enter(holderId, timeoutMs);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        id: holderId,
        resolve: (released: boolean) => resolve(released),
        enqueuedAt: Date.now(),
      };
      this.waiters.push(waiter);

      if (timeoutMs > 0) {
        setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            this.stats.totalTimedOut++;
            resolve(false);
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * 释放 guard
   *
   * @param holderId 持有者标识（仅当匹配时释放，防止误释放）
   */
  release(holderId?: string): void {
    if (this.state !== "busy") {
      return; // 空闲状态无操作
    }
    if (holderId !== undefined && this.holder && this.holder.id !== holderId) {
      throw new ReloadGuardBusyError("release", `${this.holder.id}（尝试以 ${holderId} 释放）`);
    }
    this.exit();
  }

  /**
   * 强制重置 guard（紧急情况）
   *
   * 警告：会清空所有等待者；调用方需确保不会造成 dispatcher 状态不一致
   *
   * @returns 被强制中断的等待者数量
   */
  forceBreak(): number {
    const brokenWaiters = this.waiters.length;
    for (const w of this.waiters) {
      w.resolve(false);
    }
    this.waiters.length = 0;
    this.holder = null;
    this.state = "idle";
    this.stats.totalForceBreaks++;
    return brokenWaiters;
  }

  /**
   * 进入临界区
   */
  private enter(holderId: string, timeoutMs: number): void {
    this.state = "busy";
    this.holder = {
      id: holderId,
      acquiredAt: Date.now(),
      deadlineMs: timeoutMs > 0 ? Date.now() + timeoutMs : 0,
    };
    this.stats.totalAcquired++;
  }

  /**
   * 退出临界区
   */
  private exit(): void {
    this.stats.totalReleased++;
    this.holder = null;
    this.state = "idle";

    // 唤醒下一个等待者
    if (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) {
        // 立即让下一个获取 guard
        setImmediate(() => {
          this.enter(next.id, 0);
          next.resolve(true);
        });
      }
    }
  }
}

// ============================================================================
// 第三部分：守卫执行器（便利 API）
// ============================================================================

/**
 * 在 ReloadGuard 保护下执行异步函数
 *
 * 用法：
 *   await withReloadGuard(guard, "reload-xxx.js", 5000, async () => {
 *     // critical section
 *   });
 *
 * @param guard ReloadGuard 实例
 * @param holderId 持有者标识
 * @param timeoutMs 超时（毫秒）
 * @param fn 要执行的函数
 * @returns fn 的返回值
 */
export async function withReloadGuard<T>(
  guard: ReloadGuard,
  holderId: string,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const acquired = await guard.waitFor(holderId, timeoutMs);
  if (!acquired) {
    throw new ReloadGuardBusyError(holderId, guard.currentHolder()?.id ?? "(none)");
  }
  try {
    return await fn();
  } finally {
    guard.release(holderId);
  }
}
