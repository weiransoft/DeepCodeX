/**
 * 后台任务启动器 —— ADR-DI-001 §5.2.2 实现
 *
 * 本模块实现 `BackgroundTaskRunner` 类，是动态指令注入特性的工厂 + 调度入口。
 *
 * 核心职责（对齐 ADR-DI-001 §5.2.2）：
 * 1. 接收 prompt → 构造 BackgroundTask → 注册到 TaskRegistry → 异步启动 → 返回 taskId
 * 2. 通过 sessionManagerFactory 创建独立 SessionManager 实例（D-1 决策：与主实例隔离）
 * 3. 内部使用 crypto.randomUUID() 生成 taskId（前缀 `t-`）
 * 4. 异常处理：start 失败时 setState("failed") + 通知 onTaskStateChange
 * 5. 任务完成后自动注销（移到 TaskRegistry 历史区）
 *
 * 设计约束：
 * - Phase 1 MVP 仅支持 chat kind（autonomous kind 留待 Phase 3）
 * - 通过依赖注入接收 sessionManagerFactory（不直接依赖 SessionManager 类）
 * - 任务完成后自动注销（onStateChange 回调中检测终态触发 unregister）
 *
 * 依赖注入设计：
 * - SessionManager 是 6403 行的复杂类，依赖大量配置
 * - 通过 sessionManagerFactory 函数注入，解耦 BackgroundTaskRunner 与 SessionManager
 * - Phase 1 单元测试中使用真实的 StubSessionHandle（不调用 LLM）
 * - 主代理集成时注入真实的 SessionManager 创建逻辑
 *
 * @module interrupts/background-runner
 */

import * as crypto from "node:crypto";
import { BackgroundTask } from "./background-task";
import type { TaskRegistry } from "./task-registry";
import type { InjectedInstruction, TaskKind, TaskSnapshot } from "./types";
// 导入 UserPromptContent 类型（用于 startBackground 适配 BackgroundRunnerLike 接口）
import type { UserPromptContent } from "../session";
// D-4 修复：导入中断事件日志记录器，记录任务启动 / 终态 / 注入事件
import { logInterruptEvent } from "../common/interrupt-logger";

// ============================================================================
// 1. SessionHandle 接口（最小契约）
// ============================================================================

/**
 * SessionManager 句柄接口（最小契约）
 *
 * Phase 1 中 BackgroundTaskRunner 不直接依赖 SessionManager 类
 * （SessionManager 是 6403 行的复杂类，依赖大量配置），而是依赖此最小契约。
 *
 * 主代理在集成阶段会注入真实的 SessionManager（实现此接口）。
 * Phase 1 单元测试中使用真实的 StubSessionHandle（不调用 LLM）。
 *
 * 方法说明：
 * - `handleUserPrompt(prompt)`：启动会话（与 SessionManager.handleUserPrompt 同构）
 *   - 同步成功：返回 Promise，resolve 时任务视为成功
 *   - 同步抛错：Promise reject，任务视为失败
 *   - 异步执行：在 controller.abort() 后应抛 AbortError
 */
export interface SessionHandle {
  /** 启动会话（与 SessionManager.handleUserPrompt 同构） */
  handleUserPrompt(prompt: string): Promise<void>;
}

// ============================================================================
// 2. SessionManagerFactory 工厂函数类型
// ============================================================================

/**
 * SessionManager 工厂函数类型
 *
 * 由调用方注入，负责创建真实的 SessionManager 实例并返回最小契约句柄。
 *
 * 工厂函数职责：
 * 1. 创建独立的 SessionManager 实例（与主前台 session 隔离，D-1 决策）
 * 2. 共享只读资源（mcpManager / toolExecutor / settings 等）
 * 3. 注入独立的 AbortController（取消不影响前台）
 * 4. 返回 SessionHandle 句柄
 *
 * @param taskId 任务 ID（用于日志与 sessionId 关联）
 * @param controller 独立的 AbortController（取消信号传递）
 * @returns SessionHandle 句柄
 */
export type SessionManagerFactory = (taskId: string, controller: AbortController) => SessionHandle;

// ============================================================================
// 3. SharedSessionOptions 共享会话选项
// ============================================================================

/**
 * 共享的 SessionManager 创建选项
 *
 * 字段说明：
 * - `sessionManagerFactory`：SessionManager 工厂函数（必须）
 *
 * 设计约束：
 * - 工厂函数必须由调用方注入（不提供默认实现，避免 mock）
 * - 工厂函数应返回真实的 SessionHandle 实例（非 mock）
 */
export interface SharedSessionOptions {
  /** SessionManager 工厂函数 */
  readonly sessionManagerFactory: SessionManagerFactory;
}

// ============================================================================
// 4. TaskStoreLike 持久化存储接口（最小契约）
// ============================================================================

/**
 * 持久化存储最小契约
 *
 * Phase 1 中可选注入（不注入时仅内存管理，不持久化）。
 * Phase 2 中由 TaskStore 实现。
 *
 * 方法说明：
 * - `persist(task)`：持久化任务状态（原子写入，异步落盘）
 * - `loadAll()`：加载全部任务状态（启动时恢复用）
 */
export interface TaskStoreLike {
  /** 持久化任务状态（原子写入） */
  persist(task: BackgroundTask): Promise<void>;
  /** 加载全部任务状态（启动时恢复用） */
  loadAll(): Promise<readonly TaskSnapshot[]>;
}

// ============================================================================
// 5. BackgroundTaskRunnerOptions 构造选项
// ============================================================================

/**
 * BackgroundTaskRunner 构造选项
 *
 * 字段说明：
 * - `sharedSessionOptions`：共享的 SessionManager 创建选项（含工厂函数）
 * - `registry`：任务注册表
 * - `onTaskComplete`：任务完成回调（succeeded / failed / cancelled 时调用）
 * - `onTaskStateChange`：任务状态变更回调
 * - `taskStore`：持久化存储（可选，Phase 1 可不注入）
 */
export interface BackgroundTaskRunnerOptions {
  /** 共享的 SessionManager 创建选项（含工厂函数） */
  readonly sharedSessionOptions: SharedSessionOptions;
  /** 任务注册表 */
  readonly registry: TaskRegistry;
  /** 任务完成回调 */
  readonly onTaskComplete?: (task: BackgroundTask) => void;
  /** 任务状态变更回调 */
  readonly onTaskStateChange?: (task: BackgroundTask) => void;
  /** 持久化存储（可选，Phase 1 可不注入） */
  readonly taskStore?: TaskStoreLike;
}

// ============================================================================
// 6. BackgroundTaskRunner 类实现
// ============================================================================

/**
 * 后台任务启动器
 *
 * 接收 prompt → 构造 BackgroundTask → 注册到 TaskRegistry → 异步启动 → 返回 taskId
 *
 * Phase 1 仅支持 chat kind（autonomous kind 留待 Phase 3）。
 *
 * 使用示例：
 * ```typescript
 * const runner = new BackgroundTaskRunner({
 *   sharedSessionOptions: {
 *     sessionManagerFactory: (taskId, controller) => createSessionManager({ controller }),
 *   },
 *   registry,
 *   onTaskComplete: (task) => console.log(`task ${task.id} completed: ${task.state}`),
 * });
 * const { taskId } = await runner.start("调研 React 19 新特性", "chat");
 * ```
 *
 * 异常处理：
 * - start() 同步抛错：task.state 已转为 failed，onStateChange 已触发
 * - start() 异步抛错（handleUserPrompt 失败）：onStateChange 触发 failed
 * - 任务完成：onTaskComplete 触发，自动注销移到历史区
 */
export class BackgroundTaskRunner {
  /** 构造选项（构造时一次性注入，后续不变） */
  private readonly options: BackgroundTaskRunnerOptions;

  /**
   * 构造 BackgroundTaskRunner
   *
   * @param options 构造选项
   */
  constructor(options: BackgroundTaskRunnerOptions) {
    this.options = options;
  }

  /**
   * 启动后台任务（适配 `BackgroundRunnerLike` 接口）
   *
   * 实现 `BackgroundRunnerLike.startBackground` 契约：
   * - 接收 `UserPromptContent`（与 LLM 工具 / SessionManager 接口一致）
   * - 内部委托给 `start(prompt.text, kind)`
   * - 返回 `{ taskId, sessionId }`（与 `BackgroundRunnerLike` 契约一致）
   *
   * 设计说明：
   * - `start` 是底层 API（接收 `string`，返回 `{ taskId }`）
   * - `startBackground` 是适配 API（接收 `UserPromptContent`，返回 `{ taskId, sessionId }`）
   * - Phase 1 中 `sessionId === taskId`（后台任务使用独立 SessionManager，
   *   sessionId 由 BackgroundTask.sessionId 字段提供，构造时与 taskId 一致）
   *
   * @param prompt 初始 prompt（UserPromptContent 格式）
   * @param kind 任务类型（默认 `chat`）
   * @returns taskId + sessionId
   */
  async startBackground(
    prompt: UserPromptContent,
    kind?: TaskKind
  ): Promise<{ readonly taskId: string; readonly sessionId: string }> {
    // 校验 prompt.text 非空（与 start 内部校验一致，提前抛错）
    const promptText = prompt.text ?? "";
    const result = await this.start(promptText, kind);
    // Phase 1: sessionId === taskId（BackgroundTask 构造时 sessionId = taskId）
    return { taskId: result.taskId, sessionId: result.taskId };
  }

  // ============================================================================
  // 6.1 start 启动后台任务
  // ============================================================================

  /**
   * 启动后台任务（立即返回 taskId，任务在后台异步执行）
   *
   * 流程：
   * 1. 校验 kind（Phase 1 仅支持 chat）
   * 2. 校验 prompt 非空
   * 3. 生成 taskId（`t-` + UUID）
   * 4. 创建独立 AbortController
   * 5. 构造 BackgroundTask（注入 onStart / onStateChange 回调）
   * 6. 注册到 TaskRegistry
   * 7. 调用 task.start()（异步，await 但内部 onStart 也是异步）
   * 8. 返回 { taskId }
   *
   * onStart 回调内部：
   * 1. 调用 sessionManagerFactory 创建 SessionHandle
   * 2. setSessionId(taskId)（与 taskId 相同，便于关联）
   * 3. 异步调用 handle.handleUserPrompt(prompt)
   *    - 成功：markSucceeded("completed")
   *    - 失败：markFailed(err.message)
   *
   * onStateChange 回调内部：
   * 1. 触发 onTaskStateChange 外部回调
   * 2. 通知 registry.notifyTaskStateChanged
   * 3. 持久化（如注入了 taskStore）
   * 4. 终态时：触发 onTaskComplete + 异步 unregister
   *
   * @param prompt 初始 prompt
   * @param kind 任务类型（默认 chat）
   * @returns task_id（前缀 `t-` + UUID）
   * @throws {Error} 当 kind 不为 chat 时（Phase 1 限制）
   * @throws {Error} 当 prompt 为空字符串时
   * @throws {Error} 当 sessionManagerFactory 同步抛错时（task.state 已 failed）
   */
  async start(prompt: string, kind: TaskKind = "chat"): Promise<{ taskId: string }> {
    // Phase 1 仅支持 chat kind
    if (kind !== "chat") {
      throw new Error(`BackgroundTaskRunner.start 失败：Phase 1 仅支持 kind="chat"，传入 kind="${kind}"`);
    }
    // prompt 非空校验
    if (!prompt || prompt.length === 0) {
      throw new Error("BackgroundTaskRunner.start 失败：prompt 不能为空字符串");
    }
    // 生成 taskId 与 controller
    const taskId = `t-${crypto.randomUUID()}`;
    const controller = new AbortController();
    // 提取 options 引用（避免在回调中使用 this 别名，符合 ESLint no-this-alias 规则）
    const { sharedSessionOptions, registry, onTaskComplete, onTaskStateChange, taskStore } = this.options;
    // 构造 BackgroundTask
    const task = new BackgroundTask({
      id: taskId,
      kind,
      prompt,
      controller,
      onStart: async (t) => {
        // 1. 创建 SessionHandle
        const handle = sharedSessionOptions.sessionManagerFactory(t.id, t.controller);
        // 2. 设置 sessionId（与 taskId 相同，便于关联）
        t.setSessionId(t.id);
        // 3. 异步启动会话（不 await，让 onStart 立即返回，状态转为 running）
        //    注：handleUserPrompt 完成后任务视为成功，失败则视为失败
        //    使用 void + .then/.catch 处理异步结果
        void handle
          .handleUserPrompt(t.prompt)
          .then(() => {
            // 会话成功完成（仅在 running 状态下转为 succeeded）
            if (t.state === "running") {
              t.markSucceeded("completed");
            }
          })
          .catch((err) => {
            // 会话失败（仅在 running / injecting 状态下转为 failed）
            if (t.state === "running" || t.state === "injecting") {
              t.markFailed(err instanceof Error ? err.message : String(err));
            }
          });
        // 注：onStart 不等待 handleUserPrompt 完成，立即返回让状态转为 running
      },
      onStateChange: (t) => {
        // 1. 触发外部 onTaskStateChange 回调
        if (onTaskStateChange) {
          try {
            onTaskStateChange(t);
          } catch (err) {
            console.error(
              `[BackgroundTaskRunner] onTaskStateChange 回调抛错（已忽略）：`,
              err instanceof Error ? err.message : String(err)
            );
          }
        }
        // 2. 通知 registry
        registry.notifyTaskStateChanged(t);
        // 3. 持久化（如注入了 taskStore）
        if (taskStore) {
          void taskStore.persist(t).catch((err) => {
            console.error(
              `[BackgroundTaskRunner] taskStore.persist 抛错（已忽略）：`,
              err instanceof Error ? err.message : String(err)
            );
          });
        }
        // 4. 终态触发 onTaskComplete + 异步 unregister
        if (t.state === "succeeded" || t.state === "failed" || t.state === "cancelled") {
          // D-4：记录任务终态事件（失败不影响主流程）
          // 注：BackgroundTask 没有 cancelReason / failureReason 字段，统一通过 error getter 暴露
          //     startedAt 为 ISO 8601 字符串，需 new Date() 转换后计算 durationMs
          try {
            const eventType =
              t.state === "succeeded" ? "task.succeeded" : t.state === "failed" ? "task.failed" : "task.cancelled";
            logInterruptEvent({
              timestamp: new Date().toISOString(),
              eventType,
              taskId: t.id,
              taskKind: t.kind,
              taskStatus: t.state,
              sessionId: t.sessionId ?? undefined,
              durationMs: Date.now() - new Date(t.startedAt).getTime(),
              reason: t.error ?? undefined,
            });
          } catch (err) {
            console.error(
              `[BackgroundTaskRunner] logInterruptEvent 抛错（已忽略）：`,
              err instanceof Error ? err.message : String(err)
            );
          }
          // 触发外部 onTaskComplete 回调
          if (onTaskComplete) {
            try {
              onTaskComplete(t);
            } catch (err) {
              console.error(
                `[BackgroundTaskRunner] onTaskComplete 回调抛错（已忽略）：`,
                err instanceof Error ? err.message : String(err)
              );
            }
          }
          // 异步 unregister（移到历史区）
          // 注：使用 setTimeout(0) 避免在状态变更回调中同步修改 registry
          setTimeout(() => {
            registry.unregister(t.id);
          }, 0);
        }
      },
    });
    // 注册到 registry
    registry.register(task);
    // 调用 task.start()（内部会调用 onStart 回调）
    // 注：start() 抛错时 task.state 已在 start 内部转为 failed，错误直接传播
    await task.start();
    // D-4：记录后台任务启动事件（M3 修订：必须在 await task.start() 成功返回后记录）
    // - 此时 task.state 已为 running（或已被 markSucceeded/markFailed 转换为终态）
    // - start() 抛错时不会执行到此日志，符合"task.started"语义
    // - taskStatus 字段使用 t.state 反映任务实际状态（而非硬编码 "running"）
    try {
      logInterruptEvent({
        timestamp: new Date().toISOString(),
        eventType: "task.started",
        taskId,
        taskKind: kind,
        taskStatus: task.state,
      });
    } catch (err) {
      console.error(
        `[BackgroundTaskRunner] logInterruptEvent 抛错（已忽略）：`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return { taskId };
  }

  // ============================================================================
  // 6.2 stop 停止任务
  // ============================================================================

  /**
   * 停止任务（cancel + unregister）
   *
   * 流程：
   * 1. 校验 taskId 存在
   * 2. 调用 task.cancel(reason)
   *    - cancel 内部 setState("cancelled")，触发 onStateChange
   *    - onStateChange 检测终态，setTimeout(0) 异步 unregister
   * 3. 等待一个事件循环（让 setTimeout(0) 执行）
   *
   * @param taskId 任务 ID
   * @param reason 取消原因（可选）
   * @throws {Error} 当 taskId 不存在时
   */
  async stop(taskId: string, reason?: string): Promise<void> {
    const task = this.options.registry.get(taskId);
    if (!task) {
      throw new Error(`BackgroundTaskRunner.stop 失败：task.id=${taskId} 不存在`);
    }
    task.cancel(reason);
    // 等待一个事件循环，让 onStateChange 中的 setTimeout(0) unregister 执行
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  // ============================================================================
  // 6.3 inject 注入指令
  // ============================================================================

  /**
   * 注入指令到指定任务
   *
   * 找到 task 后调用 task.inject(instruction)。
   * task.inject 内部调用 onInject 回调（InterruptQueue.enqueue 由调用方处理）。
   *
   * @param taskId 任务 ID
   * @param instruction 注入指令
   * @throws {Error} 当 taskId 不存在时
   */
  inject(taskId: string, instruction: InjectedInstruction): void {
    const task = this.options.registry.get(taskId);
    if (!task) {
      throw new Error(`BackgroundTaskRunner.inject 失败：task.id=${taskId} 不存在`);
    }
    task.inject(instruction);
    // D-4：记录指令注入到任务事件（失败不影响主流程）
    try {
      logInterruptEvent({
        timestamp: new Date().toISOString(),
        eventType: "task.injected",
        taskId,
        taskKind: task.kind,
        taskStatus: task.state,
        instructionText: instruction.text,
        instructionSource: instruction.source,
      });
    } catch (err) {
      console.error(
        `[BackgroundTaskRunner] logInterruptEvent 抛错（已忽略）：`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
