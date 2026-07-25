/**
 * 任务中央注册表 —— ADR-DI-001 §3.3 实现
 *
 * 本模块实现 `TaskRegistry` 类，是动态指令注入特性的中央任务管理器。
 *
 * 核心职责（对齐 ADR-DI-001 §3.3 + §5.3）：
 * 1. 维护全部前台 + 后台任务的内存索引（Map<taskId, BackgroundTask>）
 * 2. 维护历史区（已完成任务，最多 100 条，FIFO 淘汰）
 * 3. 提供 register / unregister / get / list API
 * 4. 提供 setForeground / getForegroundId / clearForeground 前台切换 API
 * 5. 并发上限保护（MAX_CONCURRENT_TASKS = 8，超限抛 TaskLimitExceededError）
 * 6. 事件回调（onTaskRegistered / onTaskUnregistered / onTaskStateChanged）
 *
 * 设计约束：
 * - 仅内存对象，不直接持久化（持久化由 BackgroundTaskRunner 通过 taskStore 处理）
 * - list() 返回 readonly array（不可变，防止外部修改）
 * - 历史区 FIFO 淘汰：超过 MAX_HISTORY_SIZE 时移除最老的
 *
 * 线程模型（Node.js 单线程事件循环）：
 * - 不需要锁，但状态变更必须经 BackgroundTask.setState() 路径，保证事件可观测
 * - 事件回调同步触发，异步回调需调用方自行处理
 *
 * @module interrupts/task-registry
 */

import type { BackgroundTask } from "./background-task";
import type { TaskListFilter, TaskStatus } from "./types";
import { TaskLimitExceededError } from "./types";

// ============================================================================
// 1. TaskRegistryOptions 构造选项
// ============================================================================

/**
 * TaskRegistry 构造选项
 *
 * 字段说明：
 * - `onTaskRegistered`：任务注册后回调（用于 UI 更新 / 持久化触发）
 * - `onTaskUnregistered`：任务注销后回调（用于 UI 更新 / 持久化触发）
 * - `onTaskStateChanged`：任务状态变更回调（由 notifyTaskStateChanged 触发）
 *
 * 设计约束：
 * - 所有回调可选
 * - 回调同步触发，异常被吞掉记录到 stderr（不影响注册/注销主流程）
 */
export interface TaskRegistryOptions {
  /** 任务注册后回调 */
  readonly onTaskRegistered?: (task: BackgroundTask) => void;
  /** 任务注销后回调 */
  readonly onTaskUnregistered?: (task: BackgroundTask) => void;
  /** 任务状态变更回调 */
  readonly onTaskStateChanged?: (task: BackgroundTask) => void;
}

// ============================================================================
// 2. TaskRegistry 类实现
// ============================================================================

/**
 * 任务中央注册表
 *
 * SessionManager 持有单一 TaskRegistry 实例，注册全部前台 + 后台任务。
 * 提供 /tasks /fg /cancel /pause /resume 等 API 的底层支持。
 *
 * 使用示例：
 * ```typescript
 * const registry = new TaskRegistry({
 *   onTaskStateChanged: (task) => uiRenderer.updateTask(task),
 * });
 * registry.register(task);
 * const list = registry.list({ status: "running" });
 * registry.setForeground("t-abc123");
 * ```
 */
export class TaskRegistry {
  /** 最大并行任务数（防止资源耗尽，R-5 风险缓解） */
  static readonly MAX_CONCURRENT_TASKS = 8 as const;

  /** 历史区最大保留条数（FIFO 淘汰最老的） */
  static readonly MAX_HISTORY_SIZE = 100 as const;

  /** 活跃任务映射（id → BackgroundTask） */
  private readonly tasks = new Map<string, BackgroundTask>();

  /** 历史区（已完成任务，FIFO 顺序，超出 MAX_HISTORY_SIZE 时移除最老的） */
  private readonly history: BackgroundTask[] = [];

  /** 当前前台任务 ID */
  private foregroundId: string | null = null;

  /** 事件回调集合 */
  private readonly callbacks: {
    readonly onTaskRegistered?: (task: BackgroundTask) => void;
    readonly onTaskUnregistered?: (task: BackgroundTask) => void;
    readonly onTaskStateChanged?: (task: BackgroundTask) => void;
  };

  /**
   * 构造 TaskRegistry
   *
   * @param options 构造选项（含事件回调）
   */
  constructor(options?: TaskRegistryOptions) {
    this.callbacks = {
      onTaskRegistered: options?.onTaskRegistered,
      onTaskUnregistered: options?.onTaskUnregistered,
      onTaskStateChanged: options?.onTaskStateChanged,
    };
  }

  // ============================================================================
  // 2.1 注册 / 注销 / 查询
  // ============================================================================

  /**
   * 注册任务
   *
   * 校验顺序：
   * 1. task.id 不能已存在（重复注册抛错）
   * 2. 活跃任务数不能超过 MAX_CONCURRENT_TASKS（超限抛 TaskLimitExceededError）
   *
   * 注册成功后：
   * 1. 添加到 tasks Map
   * 2. 同步触发 onTaskRegistered 回调
   *
   * @param task 待注册任务
   * @throws {Error} 当 task.id 已存在时
   * @throws {TaskLimitExceededError} 当活跃任务数已达上限时
   */
  register(task: BackgroundTask): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`TaskRegistry.register 失败：task.id=${task.id} 已存在`);
    }
    if (this.tasks.size >= TaskRegistry.MAX_CONCURRENT_TASKS) {
      throw new TaskLimitExceededError(
        `TaskRegistry 已达并行上限（${TaskRegistry.MAX_CONCURRENT_TASKS}），拒绝注册 task.id=${task.id}`,
        this.tasks.size,
        TaskRegistry.MAX_CONCURRENT_TASKS
      );
    }
    this.tasks.set(task.id, task);
    // 同步触发回调
    if (this.callbacks.onTaskRegistered) {
      try {
        this.callbacks.onTaskRegistered(task);
      } catch (err) {
        console.error(
          `[TaskRegistry] onTaskRegistered 回调抛错（已忽略）：`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /**
   * 注销任务（移到历史区）
   *
   * 流程：
   * 1. 从 tasks Map 移除（不存在则忽略，不抛错）
   * 2. 清除前台标记（如果注销的是前台任务）
   * 3. 添加到 history 数组尾部
   * 4. 历史区超限时移除最老的（FIFO 淘汰）
   * 5. 同步触发 onTaskUnregistered 回调
   *
   * @param taskId 任务 ID
   */
  unregister(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      // 不存在则忽略，不抛错
      return;
    }
    this.tasks.delete(taskId);
    // 清除前台标记
    if (this.foregroundId === taskId) {
      this.foregroundId = null;
    }
    // 加入历史区
    this.history.push(task);
    // FIFO 淘汰最老的
    while (this.history.length > TaskRegistry.MAX_HISTORY_SIZE) {
      this.history.shift();
    }
    // 同步触发回调
    if (this.callbacks.onTaskUnregistered) {
      try {
        this.callbacks.onTaskUnregistered(task);
      } catch (err) {
        console.error(
          `[TaskRegistry] onTaskUnregistered 回调抛错（已忽略）：`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /**
   * 获取单个任务（仅活跃区）
   *
   * @param taskId 任务 ID
   * @returns 任务实例或 null（不存在时）
   */
  get(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * 列出任务（含过滤）
   *
   * 返回不可变 readonly array，包含活跃区任务（+ 历史区任务，仅当 includeHistory=true）。
   * 顺序：活跃区（按注册顺序）+ 历史区（按注销顺序）。
   *
   * 过滤规则：
   * - status：单值或数组，命中任一即匹配
   * - kind：按类型过滤
   * - includeHistory：是否包含历史区任务（默认 false）
   *
   * @param filter 过滤选项（可选）
   * @returns 不可变任务数组
   */
  list(filter?: TaskListFilter): readonly BackgroundTask[] {
    const result: BackgroundTask[] = [];
    // 活跃区（按注册顺序，Map 保持插入顺序）
    for (const task of this.tasks.values()) {
      if (this.matchFilter(task, filter)) {
        result.push(task);
      }
    }
    // 历史区（仅在 includeHistory=true 时包含）
    if (filter?.includeHistory) {
      for (const task of this.history) {
        if (this.matchFilter(task, filter)) {
          result.push(task);
        }
      }
    }
    // 冻结返回值，防止外部修改
    return Object.freeze(result) as readonly BackgroundTask[];
  }

  // ============================================================================
  // 2.2 前台任务管理
  // ============================================================================

  /**
   * 设置前台任务
   *
   * 校验：
   * - taskId 必须在活跃区（不在活跃区抛错）
   *
   * 注：setForeground 仅切换 UI 关注焦点，不中断其他后台任务。
   *
   * @param taskId 任务 ID
   * @throws {Error} 当 taskId 不在活跃区时
   */
  setForeground(taskId: string): void {
    if (!this.tasks.has(taskId)) {
      throw new Error(`TaskRegistry.setForeground 失败：task.id=${taskId} 不在活跃区`);
    }
    this.foregroundId = taskId;
  }

  /**
   * 获取前台任务 ID
   *
   * @returns 前台任务 ID 或 null（未设置时）
   */
  getForegroundId(): string | null {
    return this.foregroundId;
  }

  /**
   * 清除前台标记
   *
   * 用于任务注销后自动清除前台标记（unregister 内部已自动调用），
   * 也可由外部显式调用（例如用户切换到主对话）。
   */
  clearForeground(): void {
    this.foregroundId = null;
  }

  // ============================================================================
  // 2.3 事件通知
  // ============================================================================

  /**
   * 通知状态变更
   *
   * 由 BackgroundTaskRunner 在创建 task 时将此方法绑定到 task 的 onStateChange 回调。
   * BackgroundTask.setState() 触发 onStateChange → 此方法 → registry 的 onTaskStateChanged 回调。
   *
   * @param task 状态变更的任务
   */
  notifyTaskStateChanged(task: BackgroundTask): void {
    if (this.callbacks.onTaskStateChanged) {
      try {
        this.callbacks.onTaskStateChanged(task);
      } catch (err) {
        console.error(
          `[TaskRegistry] onTaskStateChanged 回调抛错（已忽略）：`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // ============================================================================
  // 2.4 只读 getter
  // ============================================================================

  /** 当前活跃任务数 */
  get size(): number {
    return this.tasks.size;
  }

  /** 历史区任务数 */
  get historySize(): number {
    return this.history.length;
  }

  // ============================================================================
  // 2.5 内部辅助方法
  // ============================================================================

  /**
   * 匹配过滤器
   *
   * @param task 待匹配任务
   * @param filter 过滤器（可选，未提供时返回 true）
   * @returns true 匹配 / false 不匹配
   */
  private matchFilter(task: BackgroundTask, filter?: TaskListFilter): boolean {
    if (!filter) {
      return true;
    }
    // kind 过滤
    if (filter.kind && task.kind !== filter.kind) {
      return false;
    }
    // status 过滤（单值或数组，命中任一即匹配）
    if (filter.status) {
      const statuses: readonly TaskStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.includes(task.state)) {
        return false;
      }
    }
    return true;
  }
}
