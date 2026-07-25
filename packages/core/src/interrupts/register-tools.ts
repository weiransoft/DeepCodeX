/**
 * 动态指令注入与后台子 Agent —— LLM 工具注册入口
 *
 * 本模块提供将 4 个中断管理工具（`background_task` / `list_tasks` /
 * `cancel_task` / `inject_message`）注册到 ToolExecutor 的统一入口函数。
 *
 * 设计依据：
 * - ADR-DI-001 §4.6 LLM 工具 + §7.3 LLM 工具注册
 * - 参考模式：`packages/core/src/v2/tools/tool-executor-registry.ts` 的 `registerCodemapTools`
 *
 * 文件职责划分：
 * - `llm-tools.ts`：工具定义（JSON Schema）+ handler 工厂函数 + 元数据 + 抽象接口
 * - `register-tools.ts`（本文件）：`InterruptToolRegistry` 类 + `registerInterruptTools` 注册函数
 *
 * 集成位置：
 * - `session.ts` 构造函数中 `registerCodemapTools` 调用之后（§7.3）
 * - 与 codemap 工具注入完全同构，向后兼容
 *
 * 降级语义：
 * - SessionManager 未注入 `taskRegistry` / `backgroundRunner` 时，handler 仍注册
 * - 调用时才走降级路径（返回 "feature unavailable" 错误，详见各 handler 实现）
 *
 * @module interrupts/register-tools
 */

import type { ToolHandler } from "../common/tool-types";
import type {
  InterruptibleSessionManager,
  InterruptToolHandlerContext,
  InterruptToolMetadata,
  ToolExecutorRegistrar,
} from "./llm-tools";
import {
  createBackgroundTaskHandler,
  createCancelTaskHandler,
  createInjectMessageHandler,
  createListTasksHandler,
  INTERRUPT_TOOL_METADATA,
} from "./llm-tools";
import {
  BACKGROUND_TASK_TOOL_NAME as BACKGROUND_TASK_TOOL,
  CANCEL_TASK_TOOL_NAME as CANCEL_TASK_TOOL,
  INJECT_MESSAGE_TOOL_NAME as INJECT_MESSAGE_TOOL,
  LIST_TASKS_TOOL_NAME as LIST_TASKS_TOOL,
} from "./types";

// ============================================================================
// 1. InterruptToolRegistry 类（持有 4 个 handler，提供注册映射）
// ============================================================================

/**
 * 中断管理工具注册中心（持有 4 个 handler，提供 ToolHandler 映射）
 *
 * 通过依赖注入 `InterruptibleSessionManager` 构造 4 个 handler，
 * 并将每个 handler 适配为 `ToolHandler` 签名。
 *
 * 与 `CodemapToolRegistry` 同构：
 * - 懒加载 handler 映射（首次调用 `getHandlers` 时构建）
 * - 冻结映射防止外部修改
 * - 提供 `getMetadata` 供 ToolExecutor 工具列表展示
 *
 * 使用示例：
 * ```typescript
 * const registry = new InterruptToolRegistry(sessionManager);
 * const handlers = registry.getHandlers();
 * for (const [name, handler] of handlers) {
 *   toolExecutor.registerToolHandler(name, handler);
 * }
 * ```
 */
export class InterruptToolRegistry {
  /** handler 共享上下文（持有 SessionManager 引用） */
  private readonly context: InterruptToolHandlerContext;

  /** ToolHandler 映射（工具名 → handler，懒加载，首次调用 getHandlers 时构建） */
  private cachedHandlers: ReadonlyMap<string, ToolHandler> | undefined;

  /**
   * 构造中断管理工具注册中心
   *
   * @param sessionManager SessionManager 引用（实现 `InterruptibleSessionManager` 接口）
   */
  constructor(sessionManager: InterruptibleSessionManager) {
    this.context = { sessionManager };
  }

  /**
   * 获取 4 个中断管理工具的 ToolHandler 映射
   *
   * 返回 `Map<工具名, ToolHandler>`，调用方可直接遍历注册到 ToolExecutor。
   *
   * 实现说明：
   * - 首次调用时构建映射并缓存（懒加载，避免构造时即构建）
   * - 4 个 handler 分别由对应的工厂函数创建，共享同一 context
   *
   * @returns 工具名 → ToolHandler 映射
   */
  readonly getHandlers = (): ReadonlyMap<string, ToolHandler> => {
    // 懒加载：首次调用时构建映射
    if (this.cachedHandlers === undefined) {
      const handlers = new Map<string, ToolHandler>();
      handlers.set(BACKGROUND_TASK_TOOL, createBackgroundTaskHandler(this.context));
      handlers.set(LIST_TASKS_TOOL, createListTasksHandler(this.context));
      handlers.set(CANCEL_TASK_TOOL, createCancelTaskHandler(this.context));
      handlers.set(INJECT_MESSAGE_TOOL, createInjectMessageHandler(this.context));
      this.cachedHandlers = handlers;
    }
    return this.cachedHandlers;
  };

  /**
   * 获取 4 个中断管理工具元数据列表
   *
   * @returns 工具元数据列表（冻结）
   */
  readonly getMetadata = (): ReadonlyArray<InterruptToolMetadata> => {
    return INTERRUPT_TOOL_METADATA;
  };
}

// ============================================================================
// 2. ToolExecutor 注册辅助函数
// ============================================================================

/**
 * 将 4 个中断管理工具注册到 ToolExecutor
 *
 * 注册流程：
 * 1. 构造 `InterruptToolRegistry`（依赖注入 `InterruptibleSessionManager`）
 * 2. 获取 handler 映射（`getHandlers`）
 * 3. 遍历映射，逐个调用 `toolExecutor.registerToolHandler(name, handler)`
 *
 * 兼容性保证（向后兼容）：
 * - 不修改现有 ToolExecutor 类的实现（仅通过 `registerToolHandler` 注入新 handler）
 * - 不影响现有工具（bash / read / write / edit / codemap_* 等）
 * - 4 个中断管理工具与现有工具并列，由 ToolExecutor 统一调度
 *
 * 降级语义：
 * - SessionManager 未注入 `taskRegistry` / `backgroundRunner` 时，handler 仍注册
 * - 调用时才走降级路径（返回 "feature unavailable" 错误）
 *
 * 使用示例：
 * ```typescript
 * const toolExecutor = new ToolExecutor(projectRoot, ...);
 * const sessionManager = new SessionManager({ ... });
 * registerInterruptTools(toolExecutor, sessionManager);
 * // 现在 toolExecutor 可调度 background_task / list_tasks / cancel_task / inject_message
 * ```
 *
 * @param toolExecutor ToolExecutor 实例（实现 `ToolExecutorRegistrar` 接口）
 * @param sessionManager SessionManager 实例（实现 `InterruptibleSessionManager` 接口）
 * @returns `InterruptToolRegistry` 实例（调用方可保留引用以获取元数据）
 */
export function registerInterruptTools(
  toolExecutor: ToolExecutorRegistrar,
  sessionManager: InterruptibleSessionManager
): InterruptToolRegistry {
  // ---------- 1. 构造 registry ----------
  const registry = new InterruptToolRegistry(sessionManager);

  // ---------- 2. 获取 handler 映射 ----------
  const handlers = registry.getHandlers();

  // ---------- 3. 遍历映射，逐个注册到 ToolExecutor ----------
  for (const [name, handler] of handlers) {
    toolExecutor.registerToolHandler(name, handler);
  }

  // ---------- 4. 返回 registry 实例（调用方可保留引用） ----------
  return registry;
}

/**
 * 创建中断管理工具的 ToolHandler 映射（不依赖 ToolExecutor 实例）
 *
 * 适用场景：
 * - 调用方仅需要 handler 映射，不需要注册到 ToolExecutor
 * - 测试场景：直接调用 handler 验证工具行为
 *
 * @param sessionManager SessionManager 实例（实现 `InterruptibleSessionManager` 接口）
 * @returns 工具名 → ToolHandler 映射 + registry 实例
 */
export function createInterruptToolHandlers(sessionManager: InterruptibleSessionManager): {
  readonly handlers: ReadonlyMap<string, ToolHandler>;
  readonly registry: InterruptToolRegistry;
} {
  const registry = new InterruptToolRegistry(sessionManager);
  return {
    handlers: registry.getHandlers(),
    registry,
  };
}
