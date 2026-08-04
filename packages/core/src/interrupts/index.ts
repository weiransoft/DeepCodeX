/**
 * 动态指令注入与后台子 Agent 模块出口
 *
 * 本模块（`packages/core/src/interrupts/`）实现 ADR-DI-001 所述的：
 * - 中断指令队列（InterruptQueue）：FIFO 指令队列，/inject 入口
 * - 后台任务抽象（BackgroundTask）：独立 LLM 对话会话
 * - 任务中央注册表（TaskRegistry）：/tasks /fg /cancel 入口
 * - 后台任务启动器（BackgroundTaskRunner）：/bg 入口 + background_task 工具
 * - 任务持久化（TaskStore）：崩溃恢复
 * - 4 个 LLM 工具：background_task / list_tasks / cancel_task / inject_message
 *
 * 公开 API 分层：
 * - 数据类型：TaskStatus / TaskKind / InjectedInstruction / TaskStats / TaskSnapshot / TaskListFilter
 * - 错误类：QueueOverflowError / TaskLimitExceededError / InvalidStateTransitionError
 * - LLM 工具：registerInterruptTools / INTERRUPT_TOOL_DEFINITIONS / InterruptToolRegistry
 * - 抽象接口：InterruptibleSessionManager / BackgroundTaskLike / TaskRegistryLike / BackgroundRunnerLike
 *
 * @module interrupts
 */

// ============================================================================
// 1. 共享类型与错误类（types.ts —— 由另一个子代理实现）
// ============================================================================

export type {
  InjectSource,
  InjectedInstruction,
  InterruptQueueOptions,
  TaskKind,
  TaskListFilter,
  TaskSnapshot,
  TaskStats,
  TaskStatus,
} from "./types";

export {
  BACKGROUND_TASK_TOOL_NAME,
  CANCEL_TASK_TOOL_NAME,
  INJECT_MESSAGE_TOOL_NAME,
  InjectInterruptError,
  InvalidStateTransitionError,
  LIST_TASKS_TOOL_NAME,
  QueueOverflowError,
  TaskLimitExceededError,
} from "./types";

// ============================================================================
// 2. LLM 工具定义与 handler（llm-tools.ts —— 由本子代理实现）
// ============================================================================

export {
  INTERRUPT_TOOL_DEFINITIONS,
  INTERRUPT_TOOL_METADATA,
  createBackgroundTaskHandler,
  createCancelTaskHandler,
  createInjectMessageHandler,
  createListTasksHandler,
} from "./llm-tools";

export type {
  BackgroundRunnerLike,
  BackgroundTaskLike,
  InterruptToolDefinition,
  InterruptToolHandlerContext,
  InterruptToolMetadata,
  InterruptibleSessionManager,
  TaskRegistryLike,
  ToolExecutorRegistrar,
} from "./llm-tools";

// ============================================================================
// 3. 工具注册入口（register-tools.ts —— 由本子代理实现）
// ============================================================================

export { InterruptToolRegistry, createInterruptToolHandlers, registerInterruptTools } from "./register-tools";

// ============================================================================
// 4. 实现类（供 SessionManager 类型导入与运行期注入，ADR-DI-001 §7.1 E1 扩展点）
// ============================================================================

// InterruptQueue 类（值导出，含运行期实现）
export { InterruptQueue } from "./interrupt-queue";

// BackgroundTask 类与其 Options 类型（值导出 + 类型导出）
export { BackgroundTask } from "./background-task";
export type { BackgroundTaskOptions } from "./background-task";

// TaskRegistry 类与其 Options 类型（值导出 + 类型导出）
export { TaskRegistry } from "./task-registry";
export type { TaskRegistryOptions } from "./task-registry";

// BackgroundTaskRunner 类与其 Options 类型（值导出 + 类型导出）
export { BackgroundTaskRunner } from "./background-runner";
export type {
  BackgroundTaskRunnerOptions,
  SessionHandle,
  SessionManagerFactory,
  SharedSessionOptions,
  TaskStoreLike,
} from "./background-runner";

// TaskStore 类与其 Options 类型（值导出 + 类型导出，ADR-DI-001 §5.5 任务持久化）
export { TaskStore } from "./task-store";
export type { TaskStoreOptions } from "./task-store";
