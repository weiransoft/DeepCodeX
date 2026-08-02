/**
 * 动态指令注入与后台子 Agent —— 4 个 LLM 工具定义与 handler 实现
 *
 * 本模块注册 4 个任务管理 LLM 工具到 ToolExecutor：
 * 1. `background_task(prompt, kind?)` → `{ task_id }`：让 LLM 主动启动后台子 agent
 * 2. `list_tasks(status?, include_history?)` → `{ tasks, total }`：让 LLM 查询所有任务状态
 * 3. `cancel_task(task_id, reason?)` → `{ ok }`：让 LLM 取消指定任务
 * 4. `inject_message(task_id, message)` → `{ ok }`：让 LLM 向子 agent 注入消息
 *
 * 设计依据：
 * - ADR-DI-001 §4.6 LLM 工具 + §5.2 后台子 agent 机制 + §7.3 LLM 工具注册
 * - 参考模式：`packages/core/src/v2/tools/tool-executor-registry.ts`（codemap 工具注入）
 *
 * 依赖倒置原则：
 * - 本模块不依赖 BackgroundTask / TaskRegistry / BackgroundTaskRunner 的具体实现
 * - 仅依赖 `InterruptibleSessionManager` 抽象接口（含 taskRegistry / backgroundRunner）
 * - 具体实现由另一个子代理在 `background-task.ts` / `task-registry.ts` / `background-runner.ts` 提供
 *
 * 降级语义（与 codemap 工具一致）：
 * - SessionManager 未注入 taskRegistry / backgroundRunner 时，4 个工具返回 "feature unavailable" 错误
 * - handler 始终注册（与 tool definition 解耦），调用时才走降级路径
 *
 * 工具描述 token 预算（R-8 风险缓解）：
 * - 每个工具描述 < 100 token
 * - 4 个工具总 token < 500
 *
 * @module interrupts/llm-tools
 */

import type { ToolExecutionResult, ToolHandler } from "../common/tool-types";
import type { UserPromptContent } from "../session";
import type { InjectSource, TaskKind, TaskListFilter, TaskStats, TaskStatus } from "./types";
import {
  BACKGROUND_TASK_TOOL_NAME as BACKGROUND_TASK_TOOL,
  LIST_TASKS_TOOL_NAME as LIST_TASKS_TOOL,
  CANCEL_TASK_TOOL_NAME as CANCEL_TASK_TOOL,
  INJECT_MESSAGE_TOOL_NAME as INJECT_MESSAGE_TOOL,
} from "./types";

// ============================================================================
// 1. 抽象接口（依赖倒置 —— LLM 工具依赖抽象，不依赖具体类）
// ============================================================================

/**
 * BackgroundTask 抽象接口（最小化依赖）
 *
 * LLM 工具（特别是 `inject_message`）仅需访问 BackgroundTask 的以下成员：
 * - `id`：任务标识
 * - `kind` / `state` / `progress` / `stats`：状态展示
 * - `inject()`：注入指令
 *
 * 具体实现由 `background-task.ts` 的 `BackgroundTask` 类提供（另一个子代理实现）。
 * TypeScript 结构类型系统保证 BackgroundTask 类自动兼容本接口。
 */
export interface BackgroundTaskLike {
  /** 任务 ID（`t-` 前缀 + UUID） */
  readonly id: string;
  /** 任务类型 */
  readonly kind: TaskKind;
  /** 当前状态 */
  readonly state: TaskStatus;
  /** 进度（0-1） */
  readonly progress: number;
  /** 累计统计 */
  readonly stats: TaskStats;
  /** 初始 prompt 文本（用于任务列表展示） */
  readonly initialPromptText: string;
  /**
   * 关联的 sessionId（未创建 SessionManager 时为 null）
   *
   * 注：与 `BackgroundTask.sessionId` 类型对齐（getter 返回 `string | null`），
   * 因为 `BackgroundTask` 在构造时 sessionId 可能为 null（Phase 1 仅在
   * `BackgroundTaskRunner.start` 中异步注入真实 sessionId）。
   */
  readonly sessionId: string | null;

  /**
   * 注入指令到该任务的 InterruptQueue
   *
   * @param instruction 注入指令对象（text + source）
   */
  inject(instruction: { readonly text: string; readonly source: InjectSource }): void;
}

/**
 * TaskRegistry 抽象接口（最小化依赖）
 *
 * LLM 工具与 SessionManager 扩展方法仅需访问 TaskRegistry 的以下成员：
 * - `get()`：按 ID 查找任务
 * - `list()`：列出任务
 *
 * 具体实现由 `task-registry.ts` 的 `TaskRegistry` 类提供（另一个子代理实现）。
 */
export interface TaskRegistryLike {
  /** 获取单个任务 */
  get(taskId: string): BackgroundTaskLike | null;
  /** 查询全部任务（含已完成，受 filter 控制） */
  list(filter?: TaskListFilter): readonly BackgroundTaskLike[];
}

/**
 * BackgroundTaskRunner 抽象接口（最小化依赖）
 *
 * LLM 工具 `background_task` 与 SessionManager.startBackgroundTask() 调用此接口。
 *
 * 具体实现由 `background-runner.ts` 的 `BackgroundTaskRunner` 类提供（另一个子代理实现）。
 */
export interface BackgroundRunnerLike {
  /**
   * 启动后台任务（立即返回 taskId，任务在后台异步执行）
   *
   * @param prompt 初始 prompt
   * @param kind 任务类型：`chat`（普通对话）/ `autonomous`（4 阶段循环）
   * @returns task_id + sessionId
   */
  startBackground(
    prompt: UserPromptContent,
    kind?: TaskKind
  ): Promise<{ readonly taskId: string; readonly sessionId: string }>;
}

/**
 * SessionManager 中断能力扩展接口
 *
 * 定义 ADR-DI-001 §7.1 改动 5 所述的 public 方法 + 2 个可选注入字段。
 * SessionManager 通过可选注入 InterruptQueue / TaskRegistry / BackgroundTaskRunner
 * 获得这些能力（§7.1 改动 1-3）。
 *
 * 设计约束：
 * - 所有方法可选（未注入对应组件时方法不存在，向后兼容）
 * - LLM 工具 handler 调用前需检查方法是否存在，不存在时返回 "feature unavailable"
 *
 * 具体实现由 `session.ts` 的 SessionManager 类扩展（另一个子代理实现）。
 */
export interface InterruptibleSessionManager {
  /** 任务注册表（可选注入，未注入时 /tasks /fg /cancel 命令不可用） */
  readonly taskRegistry?: TaskRegistryLike;
  /** 后台任务启动器（可选注入，未注入时 /bg 命令不可用） */
  readonly backgroundRunner?: BackgroundRunnerLike;

  /**
   * 后台启动新子 agent 执行独立任务（/bg 命令 + background_task 工具入口）
   *
   * @param prompt 初始 prompt
   * @param kind 任务类型（默认 `chat`）
   * @returns taskId + sessionId
   */
  startBackgroundTask?(
    prompt: UserPromptContent,
    kind?: TaskKind
  ): Promise<{ readonly taskId: string; readonly sessionId: string }>;

  /**
   * 列出所有任务（/tasks 命令 + list_tasks 工具入口）
   *
   * @param filter 过滤条件
   * @returns 任务列表（不可变）
   */
  listTasks?(filter?: TaskListFilter): readonly BackgroundTaskLike[];

  /**
   * 取消指定任务（/cancel 命令 + cancel_task 工具入口）
   *
   * @param taskId 任务 ID
   * @param reason 取消原因（可选）
   */
  cancelTask?(taskId: string, reason?: string): void;
}

// ============================================================================
// 2. ToolExecutor 注册接口（最小化接口，避免依赖具体 ToolExecutor 类）
// ============================================================================

/**
 * ToolExecutor 注册接口（与 `tool-executor-registry.ts` 的 `ToolExecutorRegistrar` 同构）
 *
 * 仅要求实现 `registerToolHandler` 方法，便于：
 * - 现有 ToolExecutor 类实现此接口（已有 `registerToolHandler` 方法）
 * - 测试时可构造最小化 mock ToolExecutor
 * - 依赖倒置：本模块不依赖具体 ToolExecutor 类
 */
export interface ToolExecutorRegistrar {
  /**
   * 注册工具 handler（与现有 ToolExecutor.registerToolHandler 语义一致）
   *
   * @param name 工具名称
   * @param handler 工具 handler
   */
  readonly registerToolHandler: (name: string, handler: ToolHandler) => void;
}

// ============================================================================
// 3. 工具描述常量（每个 < 100 token，4 个总 < 500 token）
// ============================================================================

/**
 * `background_task` 工具描述
 *
 * 让 LLM 在后台启动一个独立的子 agent 执行任务，立即返回 task_id，
 * 主任务不阻塞。子 agent 在后台异步执行，可通过 `list_tasks` 查询状态。
 */
const BACKGROUND_TASK_TOOL_DESCRIPTION =
  "Start a background sub-agent for an independent task. Returns task_id immediately. The sub-agent runs in parallel without blocking the main task.";

/**
 * `list_tasks` 工具描述
 *
 * 列出所有任务状态（前台 + 后台），包含任务 ID、类型、状态、进度、时长等信息。
 * 可选按状态过滤，可选包含已完成的历史任务。
 */
const LIST_TASKS_TOOL_DESCRIPTION =
  "List all tasks (foreground + background) with their status, progress, and duration. Optionally filter by status or include completed history.";

/**
 * `cancel_task` 工具描述
 *
 * 取消指定任务（硬中断）。任务状态转为 `cancelled`，关联的进程被终止。
 * 不可取消已完成的任务（succeeded / failed / cancelled）。
 */
const CANCEL_TASK_TOOL_DESCRIPTION =
  "Cancel a running or paused task by ID. The task is hard-interrupted and transitions to cancelled state. Cannot cancel completed tasks.";

/**
 * `inject_message` 工具描述
 *
 * 向指定任务注入消息（让 LLM 也能调整子 agent 方向）。
 * 注入的消息追加到任务的 InterruptQueue，在下次 LLM 调用前被消费。
 */
const INJECT_MESSAGE_TOOL_DESCRIPTION =
  "Inject a message into a running task's interrupt queue. The message will be consumed by the sub-agent before its next LLM call, allowing mid-task direction adjustment.";

// ============================================================================
// 4. 工具元数据接口与常量
// ============================================================================

/**
 * LLM 工具元数据（工具名 + 描述，供 ToolExecutor 工具列表展示）
 */
export interface InterruptToolMetadata {
  /** 工具名称（与 LLM function calling 的 name 一致） */
  readonly name: string;
  /** 工具描述（供 LLM 选择工具时参考） */
  readonly description: string;
}

/**
 * 4 个中断管理工具元数据列表（冻结，供 ToolExecutor 工具列表展示）
 *
 * 使用 `Object.freeze` 冻结，防止运行期被篡改（不可变优先原则）。
 */
export const INTERRUPT_TOOL_METADATA: ReadonlyArray<InterruptToolMetadata> = Object.freeze([
  {
    name: BACKGROUND_TASK_TOOL,
    description: BACKGROUND_TASK_TOOL_DESCRIPTION,
  },
  {
    name: LIST_TASKS_TOOL,
    description: LIST_TASKS_TOOL_DESCRIPTION,
  },
  {
    name: CANCEL_TASK_TOOL,
    description: CANCEL_TASK_TOOL_DESCRIPTION,
  },
  {
    name: INJECT_MESSAGE_TOOL,
    description: INJECT_MESSAGE_TOOL_DESCRIPTION,
  },
]);

// ============================================================================
// 5. 工具 JSON Schema 定义（供 getTools() 返回给 LLM）
// ============================================================================

/**
 * 工具定义类型（与 `prompt.ts` 的 `ToolDefinition` 同构）
 *
 * 直接内联类型而非导入，避免与 `prompt.ts` 产生循环依赖。
 */
export interface InterruptToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Record<string, unknown>;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean;
    };
  };
}

/**
 * 4 个中断管理工具的 JSON Schema 定义（冻结，供 `getTools()` 追加到工具列表）
 *
 * 与 `codemap-query-tool.ts` 等工具的 Schema 定义模式一致。
 * 字段命名遵循 OpenAI Function Calling 规范（snake_case）。
 */
export const INTERRUPT_TOOL_DEFINITIONS: ReadonlyArray<InterruptToolDefinition> = Object.freeze([
  {
    type: "function",
    function: {
      name: BACKGROUND_TASK_TOOL,
      description: BACKGROUND_TASK_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task prompt for the background agent",
          },
          kind: {
            type: "string",
            enum: ["chat", "autonomous"],
            default: "chat",
            description: "Task kind: 'chat' for normal conversation, 'autonomous' for 4-phase loop",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: LIST_TASKS_TOOL,
      description: LIST_TASKS_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [
              "queued",
              "pending",
              "running",
              "pausing",
              "paused",
              "retrying",
              "injecting",
              "timeout",
              "succeeded",
              "failed",
              "cancelled",
            ],
            description: "Filter tasks by status",
          },
          include_history: {
            type: "boolean",
            default: false,
            description: "Include completed tasks in the result",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: CANCEL_TASK_TOOL,
      description: CANCEL_TASK_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The ID of the task to cancel",
          },
          reason: {
            type: "string",
            description: "Optional reason for cancellation",
          },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: INJECT_MESSAGE_TOOL,
      description: INJECT_MESSAGE_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The ID of the task to inject the message into",
          },
          message: {
            type: "string",
            description: "The message text to inject into the task's interrupt queue",
          },
        },
        required: ["task_id", "message"],
        additionalProperties: false,
      },
    },
  },
]);

// ============================================================================
// 6. 工具 handler 工厂函数
// ============================================================================

/**
 * 工具 handler 共享上下文（持有 SessionManager 引用）
 *
 * 所有 4 个 handler 共享同一上下文，避免重复创建闭包。
 * SessionManager 通过 `InterruptibleSessionManager` 接口访问，遵循依赖倒置原则。
 */
export interface InterruptToolHandlerContext {
  /** SessionManager 引用（中断能力扩展接口） */
  readonly sessionManager: InterruptibleSessionManager;
}

/**
 * 创建 `background_task` 工具的 ToolHandler
 *
 * 执行流程：
 * 1. 从 args 提取 `prompt`（必填）和 `kind`（可选，默认 `chat`）
 * 2. 类型校验：prompt 必须为非空字符串
 * 3. 调用 `sessionManager.startBackgroundTask(prompt, kind)`
 * 4. 返回 `{ taskId, sessionId, status: "queued" }`
 *
 * 错误处理：
 * - `prompt` 缺失或为空：返回 `ok=false, error=参数校验错误`
 * - `sessionManager.startBackgroundTask` 不存在：返回 `ok=false, error="feature unavailable"`
 * - 调用异常：catch 后返回 `ok=false, error=异常消息`
 *
 * @param context handler 共享上下文
 * @returns `background_task` 工具的 ToolHandler
 */
export function createBackgroundTaskHandler(context: InterruptToolHandlerContext): ToolHandler {
  return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    try {
      // ---------- 1. 参数提取与类型校验 ----------
      const rawPrompt = args.prompt;
      if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
        return {
          ok: false,
          name: BACKGROUND_TASK_TOOL,
          error: "参数校验失败：`prompt` 必须为非空字符串（Parameter 'prompt' must be a non-empty string）",
        };
      }

      // kind 可选，默认 "chat"，必须为 "chat" 或 "autonomous"
      const rawKind = args.kind;
      const kind: TaskKind =
        typeof rawKind === "string" && (rawKind === "chat" || rawKind === "autonomous")
          ? (rawKind as TaskKind)
          : "chat";

      // ---------- 2. 检查 SessionManager 是否具备中断能力 ----------
      const sessionManager = context.sessionManager;
      if (typeof sessionManager.startBackgroundTask !== "function") {
        return {
          ok: false,
          name: BACKGROUND_TASK_TOOL,
          error:
            "功能不可用：SessionManager 未注入 backgroundRunner，后台任务功能未启用" +
            "（Feature unavailable: backgroundRunner not injected）",
        };
      }

      // ---------- 3. 构造 UserPromptContent 并调用 startBackgroundTask ----------
      const prompt: UserPromptContent = {
        text: rawPrompt,
      };
      const result = await sessionManager.startBackgroundTask(prompt, kind);

      // ---------- 4. 封装返回结果 ----------
      const output = JSON.stringify({
        taskId: result.taskId,
        sessionId: result.sessionId,
        status: "queued",
      });
      return {
        ok: true,
        name: BACKGROUND_TASK_TOOL,
        output,
        metadata: {
          taskId: result.taskId,
          kind,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: BACKGROUND_TASK_TOOL,
        error: `background_task 工具执行失败：${message}`,
      };
    }
  };
}

/**
 * 创建 `list_tasks` 工具的 ToolHandler
 *
 * 执行流程：
 * 1. 从 args 提取 `status`（可选）和 `include_history`（可选，默认 false）
 * 2. 构造 TaskListFilter
 * 3. 调用 `sessionManager.listTasks(filter)`
 * 4. 将任务列表序列化为 JSON，包含 id / kind / status / progress / duration / text
 *
 * @param context handler 共享上下文
 * @returns `list_tasks` 工具的 ToolHandler
 */
export function createListTasksHandler(context: InterruptToolHandlerContext): ToolHandler {
  return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    try {
      // ---------- 1. 参数提取与类型校验 ----------
      const rawStatus = args.status;
      const validStatuses: readonly TaskStatus[] = [
        "queued",
        "pending",
        "running",
        "pausing",
        "paused",
        "retrying",
        "injecting",
        "timeout",
        "succeeded",
        "failed",
        "cancelled",
      ];
      const status: TaskStatus | undefined =
        typeof rawStatus === "string" && validStatuses.includes(rawStatus as TaskStatus)
          ? (rawStatus as TaskStatus)
          : undefined;

      const includeHistory: boolean = typeof args.include_history === "boolean" ? args.include_history : false;

      // ---------- 2. 检查 SessionManager 是否具备中断能力 ----------
      const sessionManager = context.sessionManager;
      if (typeof sessionManager.listTasks !== "function") {
        return {
          ok: false,
          name: LIST_TASKS_TOOL,
          error:
            "功能不可用：SessionManager 未注入 taskRegistry，任务列表功能未启用" +
            "（Feature unavailable: taskRegistry not injected）",
        };
      }

      // ---------- 3. 构造 filter 并调用 listTasks ----------
      const filter: TaskListFilter = {
        ...(status !== undefined ? { status } : {}),
        includeHistory,
      };
      const tasks = sessionManager.listTasks(filter);

      // ---------- 4. 序列化任务列表 ----------
      const taskSummaries = tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.state,
        progress: task.progress,
        duration: task.stats.durationMs,
        text: task.initialPromptText,
      }));
      const output = JSON.stringify({
        tasks: taskSummaries,
        total: taskSummaries.length,
      });
      return {
        ok: true,
        name: LIST_TASKS_TOOL,
        output,
        metadata: {
          total: taskSummaries.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: LIST_TASKS_TOOL,
        error: `list_tasks 工具执行失败：${message}`,
      };
    }
  };
}

/**
 * 创建 `cancel_task` 工具的 ToolHandler
 *
 * 执行流程：
 * 1. 从 args 提取 `task_id`（必填）和 `reason`（可选）
 * 2. 类型校验：task_id 必须为非空字符串
 * 3. 调用 `sessionManager.cancelTask(taskId, reason)`
 * 4. 返回 `{ success: true, taskId, finalStatus: "cancelled" }`
 *
 * @param context handler 共享上下文
 * @returns `cancel_task` 工具的 ToolHandler
 */
export function createCancelTaskHandler(context: InterruptToolHandlerContext): ToolHandler {
  return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    try {
      // ---------- 1. 参数提取与类型校验 ----------
      const rawTaskId = args.task_id;
      if (typeof rawTaskId !== "string" || rawTaskId.trim().length === 0) {
        return {
          ok: false,
          name: CANCEL_TASK_TOOL,
          error: "参数校验失败：`task_id` 必须为非空字符串（Parameter 'task_id' must be a non-empty string）",
        };
      }
      const taskId = rawTaskId;
      const reason: string | undefined =
        typeof args.reason === "string" && args.reason.trim().length > 0 ? args.reason : undefined;

      // ---------- 2. 检查 SessionManager 是否具备中断能力 ----------
      const sessionManager = context.sessionManager;
      if (typeof sessionManager.cancelTask !== "function") {
        return {
          ok: false,
          name: CANCEL_TASK_TOOL,
          error:
            "功能不可用：SessionManager 未注入 taskRegistry，任务取消功能未启用" +
            "（Feature unavailable: taskRegistry not injected）",
        };
      }

      // ---------- 3. 调用 cancelTask ----------
      sessionManager.cancelTask(taskId, reason);

      // ---------- 4. 封装返回结果 ----------
      const output = JSON.stringify({
        success: true,
        taskId,
        finalStatus: "cancelled",
      });
      return {
        ok: true,
        name: CANCEL_TASK_TOOL,
        output,
        metadata: {
          taskId,
          finalStatus: "cancelled",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: CANCEL_TASK_TOOL,
        error: `cancel_task 工具执行失败：${message}`,
      };
    }
  };
}

/**
 * 创建 `inject_message` 工具的 ToolHandler
 *
 * 执行流程：
 * 1. 从 args 提取 `task_id`（必填）和 `message`（必填）
 * 2. 类型校验：两个参数都必须为非空字符串
 * 3. 通过 `sessionManager.taskRegistry.get(taskId)` 查找任务
 * 4. 任务不存在时返回 `ok=false, error="Task not found"`
 * 5. 调用 `task.inject({ text: message, source: "llm" })`
 * 6. 返回 `{ success: true, taskId, queueSize: 1 }`
 *
 * @param context handler 共享上下文
 * @returns `inject_message` 工具的 ToolHandler
 */
export function createInjectMessageHandler(context: InterruptToolHandlerContext): ToolHandler {
  return async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    try {
      // ---------- 1. 参数提取与类型校验 ----------
      const rawTaskId = args.task_id;
      if (typeof rawTaskId !== "string" || rawTaskId.trim().length === 0) {
        return {
          ok: false,
          name: INJECT_MESSAGE_TOOL,
          error: "参数校验失败：`task_id` 必须为非空字符串（Parameter 'task_id' must be a non-empty string）",
        };
      }
      const rawMessage = args.message;
      if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
        return {
          ok: false,
          name: INJECT_MESSAGE_TOOL,
          error: "参数校验失败：`message` 必须为非空字符串（Parameter 'message' must be a non-empty string）",
        };
      }
      const taskId = rawTaskId;
      const message = rawMessage;

      // ---------- 2. 检查 taskRegistry 是否注入 ----------
      const sessionManager = context.sessionManager;
      const taskRegistry = sessionManager.taskRegistry;
      if (!taskRegistry) {
        return {
          ok: false,
          name: INJECT_MESSAGE_TOOL,
          error:
            "功能不可用：SessionManager 未注入 taskRegistry，消息注入功能未启用" +
            "（Feature unavailable: taskRegistry not injected）",
        };
      }

      // ---------- 3. 查找任务 ----------
      const task = taskRegistry.get(taskId);
      if (!task) {
        return {
          ok: false,
          name: INJECT_MESSAGE_TOOL,
          error: `任务不存在：${taskId}（Task not found: ${taskId}）`,
        };
      }

      // ---------- 4. 调用 task.inject 注入消息 ----------
      task.inject({ text: message, source: "llm" as InjectSource });

      // ---------- 5. 封装返回结果 ----------
      const output = JSON.stringify({
        success: true,
        taskId,
        queueSize: 1,
      });
      return {
        ok: true,
        name: INJECT_MESSAGE_TOOL,
        output,
        metadata: {
          taskId,
          queueSize: 1,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: INJECT_MESSAGE_TOOL,
        error: `inject_message 工具执行失败：${message}`,
      };
    }
  };
}
