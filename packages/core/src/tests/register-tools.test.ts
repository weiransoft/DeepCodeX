/**
 * 工具注册入口（register-tools）单元测试 —— ADR-DI-001 §9.1
 *
 * 测试范围（对齐 ADR-DI-001 §9.1 单元测试用例 + §7.3 LLM 工具注册）：
 * - TC-RT-001: InterruptToolRegistry 构造与 getHandlers 返回 4 个 handler
 * - TC-RT-002: InterruptToolRegistry getHandlers 懒加载（多次调用返回同一引用）
 * - TC-RT-003: InterruptToolRegistry getMetadata 返回 4 个元数据
 * - TC-RT-004: InterruptToolRegistry getHandlers 返回 ReadonlyMap（编译期不可变）
 * - TC-RT-005: registerInterruptTools 注册 4 个工具到 ToolExecutor
 * - TC-RT-006: registerInterruptTools 返回 InterruptToolRegistry 实例
 * - TC-RT-007: registerInterruptTools 注册的 handler 可被 ToolExecutor 调用
 * - TC-RT-008: createInterruptToolHandlers 返回 handlers 映射 + registry
 * - TC-RT-009: 注册的 handler 与直接创建的 handler 行为一致
 * - TC-RT-010: 多次 registerInterruptTools 不冲突（覆盖注册）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接调用 registerInterruptTools / new InterruptToolRegistry()
 * - StubToolExecutor 真实实现 ToolExecutorRegistrar 接口（非 mock 框架）
 * - StubSessionManager 真实实现 InterruptibleSessionManager 接口
 * - 中文注释
 *
 * Stub 设计说明（非 mock）：
 * - StubToolExecutor：真实实现 ToolExecutorRegistrar 接口，
 *   内部维护真实的 Map<string, ToolHandler> 存储，registerToolHandler 真实记录
 * - StubSessionManager：与 llm-tools.test.ts 同构，真实实现接口契约
 *
 * 设计依据：
 * - ADR-DI-001 §7.3 LLM 工具注册
 * - ADR-DI-001 §9.1 单元测试用例
 *
 * @module tests/register-tools
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  InterruptToolRegistry,
  createInterruptToolHandlers,
  registerInterruptTools,
} from "../interrupts/register-tools";
import type { ToolExecutorRegistrar } from "../interrupts/llm-tools";
import type {
  BackgroundTaskLike,
  InterruptibleSessionManager,
  InterruptToolHandlerContext,
} from "../interrupts/llm-tools";
import { INTERRUPT_TOOL_METADATA, createBackgroundTaskHandler } from "../interrupts/llm-tools";
import {
  BACKGROUND_TASK_TOOL_NAME,
  CANCEL_TASK_TOOL_NAME,
  INJECT_MESSAGE_TOOL_NAME,
  LIST_TASKS_TOOL_NAME,
} from "../interrupts/types";
import type { InjectSource, TaskKind, TaskListFilter, TaskStatus } from "../interrupts/types";
import type { ToolExecutionResult, ToolHandler } from "../common/tool-types";

// ============================================================================
// 测试辅助：StubToolExecutor（真实实现 ToolExecutorRegistrar 接口）
// ============================================================================

/**
 * 真实 ToolExecutorRegistrar 实现（非 mock）
 *
 * 真实实现 ToolExecutorRegistrar 接口契约：
 * - registerToolHandler：真实将 handler 存入 Map
 * - getHandler：真实按名称取出 handler（测试辅助方法）
 * - getRegisteredNames：真实返回已注册的工具名列表（测试辅助方法）
 *
 * 与 background-runner.test.ts 的 StubSessionHandle 同构：
 * 真实实现接口，不调用真实 LLM，但执行真实业务逻辑。
 */
class StubToolExecutor implements ToolExecutorRegistrar {
  /** 真实 handler 存储（Map 保持插入顺序） */
  private readonly handlers: Map<string, ToolHandler> = new Map();

  /**
   * 注册工具 handler（真实实现）
   *
   * @param name 工具名称
   * @param handler 工具 handler
   */
  readonly registerToolHandler = (name: string, handler: ToolHandler): void => {
    this.handlers.set(name, handler);
  };

  /**
   * 获取已注册的 handler（测试辅助方法）
   *
   * @param name 工具名称
   * @returns handler 或 undefined
   */
  getHandler(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /**
   * 获取所有已注册的工具名（测试辅助方法）
   *
   * @returns 工具名数组
   */
  getRegisteredNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 获取已注册 handler 数量（测试辅助方法）
   */
  get size(): number {
    return this.handlers.size;
  }
}

// ============================================================================
// 测试辅助：StubTask（真实实现 BackgroundTaskLike 接口）
// ============================================================================

/**
 * 真实 BackgroundTaskLike 实现（非 mock，与 llm-tools.test.ts 同构）
 */
class StubTask implements BackgroundTaskLike {
  readonly id: string;
  readonly kind: TaskKind;
  state: TaskStatus;
  progress: number;
  readonly stats: { readonly iterations: number; readonly durationMs: number; readonly tokensUsed: number };
  readonly initialPromptText: string;
  readonly sessionId: string;
  readonly injectedCalls: Array<{ readonly text: string; readonly source: InjectSource }> = [];

  constructor(options: {
    id: string;
    kind?: TaskKind;
    state?: TaskStatus;
    progress?: number;
    initialPromptText?: string;
    sessionId?: string;
  }) {
    this.id = options.id;
    this.kind = options.kind ?? "chat";
    this.state = options.state ?? "running";
    this.progress = options.progress ?? 0;
    this.stats = { iterations: 0, durationMs: 0, tokensUsed: 0 };
    this.initialPromptText = options.initialPromptText ?? "测试任务";
    this.sessionId = options.sessionId ?? `s-${options.id}`;
  }

  inject(instruction: { readonly text: string; readonly source: InjectSource }): void {
    this.injectedCalls.push({ text: instruction.text, source: instruction.source });
  }
}

// ============================================================================
// 测试辅助：StubSessionManager（真实实现 InterruptibleSessionManager 接口）
// ============================================================================

/**
 * 真实 InterruptibleSessionManager 实现（非 mock，与 llm-tools.test.ts 同构）
 *
 * 提供最小化但真实的实现，支持 4 个 handler 的调用。
 */
class StubSessionManager implements InterruptibleSessionManager {
  private readonly tasks: Map<string, StubTask> = new Map();

  get taskRegistry(): {
    get(taskId: string): BackgroundTaskLike | null;
    list(filter?: TaskListFilter): readonly BackgroundTaskLike[];
  } {
    return {
      get: (taskId: string): BackgroundTaskLike | null => this.tasks.get(taskId) ?? null,
      list: (): readonly BackgroundTaskLike[] => Array.from(this.tasks.values()),
    };
  }

  get backgroundRunner(): undefined {
    return undefined;
  }

  async startBackgroundTask(
    prompt: { text?: string },
    kind?: TaskKind
  ): Promise<{ readonly taskId: string; readonly sessionId: string }> {
    const taskId = `t-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    this.tasks.set(
      taskId,
      new StubTask({
        id: taskId,
        kind: kind ?? "chat",
        state: "queued",
        initialPromptText: prompt.text ?? "",
        sessionId,
      })
    );
    return { taskId, sessionId };
  }

  listTasks(): readonly BackgroundTaskLike[] {
    return Array.from(this.tasks.values());
  }

  cancelTask(taskId: string, reason?: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = "cancelled";
    }
  }

  /**
   * 手动添加任务（测试辅助方法）
   */
  addTask(task: StubTask): void {
    this.tasks.set(task.id, task);
  }
}

// ============================================================================
// 测试辅助：构造最小化 ToolExecutionContext
// ============================================================================

/**
 * 构造测试用 ToolExecutionContext（最小化字段）
 */
function createToolExecutionContext(): {
  sessionId: string;
  projectRoot: string;
  toolCall: { id: string; type: "function"; function: { name: string; arguments: string } };
} {
  return {
    sessionId: "test-session",
    projectRoot: "/tmp/test-project",
    toolCall: {
      id: "call-test",
      type: "function" as const,
      function: { name: "test-tool", arguments: "{}" },
    },
  };
}

// ============================================================================
// TC-RT-001: InterruptToolRegistry 构造与 getHandlers 返回 4 个 handler
// ============================================================================

test("TC-RT-001: InterruptToolRegistry 构造与 getHandlers 返回 4 个 handler", () => {
  const sessionManager = new StubSessionManager();
  const registry = new InterruptToolRegistry(sessionManager);

  const handlers = registry.getHandlers();

  assert.equal(handlers.size, 4, "应返回 4 个 handler");

  // 验证 4 个工具名都存在
  assert.ok(handlers.has(BACKGROUND_TASK_TOOL_NAME), "应包含 background_task");
  assert.ok(handlers.has(LIST_TASKS_TOOL_NAME), "应包含 list_tasks");
  assert.ok(handlers.has(CANCEL_TASK_TOOL_NAME), "应包含 cancel_task");
  assert.ok(handlers.has(INJECT_MESSAGE_TOOL_NAME), "应包含 inject_message");

  // 验证每个 handler 都是函数
  for (const [name, handler] of handlers) {
    assert.equal(typeof handler, "function", `handler ${name} 应为函数`);
  }
});

// ============================================================================
// TC-RT-002: InterruptToolRegistry getHandlers 懒加载（多次调用返回同一引用）
// ============================================================================

test("TC-RT-002: InterruptToolRegistry getHandlers 懒加载（多次调用返回同一引用）", () => {
  const sessionManager = new StubSessionManager();
  const registry = new InterruptToolRegistry(sessionManager);

  // 第一次调用：触发懒加载构建
  const handlers1 = registry.getHandlers();
  // 第二次调用：应返回缓存的同一引用
  const handlers2 = registry.getHandlers();

  // 验证返回同一引用（懒加载缓存）
  assert.equal(handlers1, handlers2, "多次 getHandlers 应返回同一引用（懒加载缓存）");

  // 验证 Map 内容一致
  assert.equal(handlers1.size, handlers2.size, "Map size 应一致");
  for (const [name, handler1] of handlers1) {
    const handler2 = handlers2.get(name);
    assert.equal(handler1, handler2, `handler ${name} 应为同一引用`);
  }
});

// ============================================================================
// TC-RT-003: InterruptToolRegistry getMetadata 返回 4 个元数据
// ============================================================================

test("TC-RT-003: InterruptToolRegistry getMetadata 返回 4 个元数据", () => {
  const sessionManager = new StubSessionManager();
  const registry = new InterruptToolRegistry(sessionManager);

  const metadata = registry.getMetadata();

  assert.equal(metadata.length, 4, "应返回 4 个元数据");

  // 验证元数据与 INTERRUPT_TOOL_METADATA 一致
  for (let i = 0; i < metadata.length; i++) {
    assert.equal(metadata[i]?.name, INTERRUPT_TOOL_METADATA[i]?.name, `元数据[${i}].name 应一致`);
    assert.equal(metadata[i]?.description, INTERRUPT_TOOL_METADATA[i]?.description, `元数据[${i}].description 应一致`);
  }
});

// ============================================================================
// TC-RT-004: InterruptToolRegistry getHandlers 返回 ReadonlyMap（编译期不可变）
// ============================================================================

test("TC-RT-004: InterruptToolRegistry getHandlers 返回 ReadonlyMap（编译期不可变）", () => {
  const sessionManager = new StubSessionManager();
  const registry = new InterruptToolRegistry(sessionManager);

  const handlers = registry.getHandlers();

  // 验证返回值是 Map 实例（ReadonlyMap 在运行时仍为 Map，但 TypeScript 类型系统阻止修改）
  assert.ok(handlers instanceof Map, "getHandlers 返回值应为 Map 实例");

  // 验证返回值在编译期被标记为 ReadonlyMap（运行时无法直接验证类型，
  // 但可通过 TypeScript 类型系统保证：调用方无法通过 handlers.set() 修改内容）
  // 此处验证 Map 内容的完整性（4 个 handler 且不可被外部篡改引用）
  assert.equal(handlers.size, 4, "Map 应包含 4 个 handler");
  assert.ok(handlers.has(BACKGROUND_TASK_TOOL_NAME), "应包含 background_task");
  assert.ok(handlers.has(LIST_TASKS_TOOL_NAME), "应包含 list_tasks");
  assert.ok(handlers.has(CANCEL_TASK_TOOL_NAME), "应包含 cancel_task");
  assert.ok(handlers.has(INJECT_MESSAGE_TOOL_NAME), "应包含 inject_message");

  // 验证多次调用返回同一引用（懒加载缓存，外部无法获取可变副本）
  const handlers2 = registry.getHandlers();
  assert.equal(handlers, handlers2, "多次 getHandlers 应返回同一引用（外部无法获取可变副本）");
});

// ============================================================================
// TC-RT-005: registerInterruptTools 注册 4 个工具到 ToolExecutor
// ============================================================================

test("TC-RT-005: registerInterruptTools 注册 4 个工具到 ToolExecutor", () => {
  const sessionManager = new StubSessionManager();
  const toolExecutor = new StubToolExecutor();

  registerInterruptTools(toolExecutor, sessionManager);

  // 验证 4 个工具都已注册
  assert.equal(toolExecutor.size, 4, "ToolExecutor 应有 4 个已注册 handler");
  assert.ok(toolExecutor.getHandler(BACKGROUND_TASK_TOOL_NAME), "background_task 应已注册");
  assert.ok(toolExecutor.getHandler(LIST_TASKS_TOOL_NAME), "list_tasks 应已注册");
  assert.ok(toolExecutor.getHandler(CANCEL_TASK_TOOL_NAME), "cancel_task 应已注册");
  assert.ok(toolExecutor.getHandler(INJECT_MESSAGE_TOOL_NAME), "inject_message 应已注册");

  // 验证已注册名称列表
  const names = toolExecutor.getRegisteredNames();
  assert.ok(names.includes(BACKGROUND_TASK_TOOL_NAME), "名称列表应包含 background_task");
  assert.ok(names.includes(LIST_TASKS_TOOL_NAME), "名称列表应包含 list_tasks");
  assert.ok(names.includes(CANCEL_TASK_TOOL_NAME), "名称列表应包含 cancel_task");
  assert.ok(names.includes(INJECT_MESSAGE_TOOL_NAME), "名称列表应包含 inject_message");
});

// ============================================================================
// TC-RT-006: registerInterruptTools 返回 InterruptToolRegistry 实例
// ============================================================================

test("TC-RT-006: registerInterruptTools 返回 InterruptToolRegistry 实例", () => {
  const sessionManager = new StubSessionManager();
  const toolExecutor = new StubToolExecutor();

  const registry = registerInterruptTools(toolExecutor, sessionManager);

  // 验证返回值是 InterruptToolRegistry 实例
  assert.ok(registry instanceof InterruptToolRegistry, "应返回 InterruptToolRegistry 实例");

  // 验证返回的 registry 可正常使用
  const handlers = registry.getHandlers();
  assert.equal(handlers.size, 4, "registry.getHandlers() 应返回 4 个 handler");

  const metadata = registry.getMetadata();
  assert.equal(metadata.length, 4, "registry.getMetadata() 应返回 4 个元数据");
});

// ============================================================================
// TC-RT-007: registerInterruptTools 注册的 handler 可被 ToolExecutor 调用
// ============================================================================

test("TC-RT-007: registerInterruptTools 注册的 handler 可被 ToolExecutor 调用", async () => {
  const sessionManager = new StubSessionManager();
  const toolExecutor = new StubToolExecutor();

  registerInterruptTools(toolExecutor, sessionManager);

  // 通过 ToolExecutor 取出 handler 并调用
  const handler = toolExecutor.getHandler(BACKGROUND_TASK_TOOL_NAME);
  assert.ok(handler, "background_task handler 应存在");

  const result = await handler({ prompt: "测试通过 ToolExecutor 调用", kind: "chat" }, createToolExecutionContext());

  assert.equal(result.ok, true, "handler 调用应成功");
  assert.equal(result.name, BACKGROUND_TASK_TOOL_NAME, "工具名应为 background_task");

  const output = JSON.parse(result.output as string);
  assert.ok(output.taskId.startsWith("t-"), "taskId 应以 t- 前缀开头");
  assert.equal(output.status, "queued", "status 应为 queued");
});

// ============================================================================
// TC-RT-008: createInterruptToolHandlers 返回 handlers 映射 + registry
// ============================================================================

test("TC-RT-008: createInterruptToolHandlers 返回 handlers 映射 + registry", () => {
  const sessionManager = new StubSessionManager();

  const { handlers, registry } = createInterruptToolHandlers(sessionManager);

  // 验证 handlers 映射
  assert.equal(handlers.size, 4, "handlers 应包含 4 个 handler");
  assert.ok(handlers.has(BACKGROUND_TASK_TOOL_NAME), "应包含 background_task");
  assert.ok(handlers.has(LIST_TASKS_TOOL_NAME), "应包含 list_tasks");
  assert.ok(handlers.has(CANCEL_TASK_TOOL_NAME), "应包含 cancel_task");
  assert.ok(handlers.has(INJECT_MESSAGE_TOOL_NAME), "应包含 inject_message");

  // 验证 registry 是 InterruptToolRegistry 实例
  assert.ok(registry instanceof InterruptToolRegistry, "registry 应为 InterruptToolRegistry 实例");

  // 验证 handlers 与 registry.getHandlers() 返回同一引用
  assert.equal(handlers, registry.getHandlers(), "handlers 应与 registry.getHandlers() 返回同一引用");
});

// ============================================================================
// TC-RT-009: 注册的 handler 与直接创建的 handler 行为一致
// ============================================================================

test("TC-RT-009: 注册的 handler 与直接创建的 handler 行为一致", async () => {
  const sessionManager1 = new StubSessionManager();
  const sessionManager2 = new StubSessionManager();

  // 方式 1：通过 registerInterruptTools 注册
  const toolExecutor = new StubToolExecutor();
  registerInterruptTools(toolExecutor, sessionManager1);
  const registeredHandler = toolExecutor.getHandler(BACKGROUND_TASK_TOOL_NAME);

  // 方式 2：直接通过 createBackgroundTaskHandler 创建
  const context: InterruptToolHandlerContext = { sessionManager: sessionManager2 };
  const directHandler = createBackgroundTaskHandler(context);

  assert.ok(registeredHandler, "注册的 handler 应存在");
  assert.ok(directHandler, "直接创建的 handler 应存在");

  // 两个 handler 应有相同的行为（不是同一引用，因为 context 不同）
  const result1 = await registeredHandler({ prompt: "测试 1" }, createToolExecutionContext());
  const result2 = await directHandler({ prompt: "测试 1" }, createToolExecutionContext());

  assert.equal(result1.ok, result2.ok, "两个 handler 应返回相同的 ok 状态");
  assert.equal(result1.name, result2.name, "两个 handler 应返回相同的 name");

  // 验证 output 结构一致
  const output1 = JSON.parse(result1.output as string);
  const output2 = JSON.parse(result2.output as string);
  assert.equal(output1.status, output2.status, "两个 handler 应返回相同的 status");
  assert.ok(output1.taskId.startsWith("t-"), "注册 handler 的 taskId 应以 t- 开头");
  assert.ok(output2.taskId.startsWith("t-"), "直接 handler 的 taskId 应以 t- 开头");
});

// ============================================================================
// TC-RT-010: 多次 registerInterruptTools 不冲突（覆盖注册）
// ============================================================================

test("TC-RT-010: 多次 registerInterruptTools 不冲突（覆盖注册）", () => {
  const sessionManager = new StubSessionManager();
  const toolExecutor = new StubToolExecutor();

  // 第一次注册
  registerInterruptTools(toolExecutor, sessionManager);
  assert.equal(toolExecutor.size, 4, "第一次注册后应有 4 个 handler");

  const handler1 = toolExecutor.getHandler(BACKGROUND_TASK_TOOL_NAME);

  // 第二次注册（覆盖）
  registerInterruptTools(toolExecutor, sessionManager);
  assert.equal(toolExecutor.size, 4, "第二次注册后仍应为 4 个 handler（覆盖不新增）");

  const handler2 = toolExecutor.getHandler(BACKGROUND_TASK_TOOL_NAME);

  // 两次注册的 handler 应为不同引用（因为 InterruptToolRegistry 是新实例）
  assert.notEqual(handler1, handler2, "两次注册的 handler 应为不同引用（新实例）");

  // 但都能正常工作
  assert.equal(typeof handler1, "function", "第一次注册的 handler 应为函数");
  assert.equal(typeof handler2, "function", "第二次注册的 handler 应为函数");
});

// ============================================================================
// 额外测试：registerInterruptTools 注册的 inject_message handler 可正常注入
// ============================================================================

test("额外测试：registerInterruptTools 注册的 inject_message handler 可正常注入", async () => {
  const sessionManager = new StubSessionManager();
  const task = new StubTask({ id: "t-inject-001", state: "running" });
  sessionManager.addTask(task);

  const toolExecutor = new StubToolExecutor();
  registerInterruptTools(toolExecutor, sessionManager);

  const handler = toolExecutor.getHandler(INJECT_MESSAGE_TOOL_NAME);
  assert.ok(handler, "inject_message handler 应存在");

  const result = await handler(
    { task_id: "t-inject-001", message: "通过 ToolExecutor 调用注入" },
    createToolExecutionContext()
  );

  assert.equal(result.ok, true, "注入应成功");
  assert.equal(task.injectedCalls.length, 1, "task.inject 应被调用 1 次");
  assert.equal(task.injectedCalls[0]?.text, "通过 ToolExecutor 调用注入", "注入文本应一致");
  assert.equal(task.injectedCalls[0]?.source, "llm", "注入来源应为 llm");
});

// ============================================================================
// 额外测试：registerInterruptTools 注册的 cancel_task handler 可正常取消
// ============================================================================

test("额外测试：registerInterruptTools 注册的 cancel_task handler 可正常取消", async () => {
  const sessionManager = new StubSessionManager();
  sessionManager.addTask(new StubTask({ id: "t-cancel-001", state: "running" }));

  const toolExecutor = new StubToolExecutor();
  registerInterruptTools(toolExecutor, sessionManager);

  const handler = toolExecutor.getHandler(CANCEL_TASK_TOOL_NAME);
  assert.ok(handler, "cancel_task handler 应存在");

  const result = await handler({ task_id: "t-cancel-001", reason: "测试取消" }, createToolExecutionContext());

  assert.equal(result.ok, true, "取消应成功");
  const output = JSON.parse(result.output as string);
  assert.equal(output.success, true, "output.success 应为 true");
  assert.equal(output.finalStatus, "cancelled", "output.finalStatus 应为 cancelled");
});

// ============================================================================
// 额外测试：registerInterruptTools 注册的 list_tasks handler 可正常列出
// ============================================================================

test("额外测试：registerInterruptTools 注册的 list_tasks handler 可正常列出", async () => {
  const sessionManager = new StubSessionManager();
  sessionManager.addTask(new StubTask({ id: "t-list-001", state: "running", initialPromptText: "任务 A" }));
  sessionManager.addTask(new StubTask({ id: "t-list-002", state: "running", initialPromptText: "任务 B" }));

  const toolExecutor = new StubToolExecutor();
  registerInterruptTools(toolExecutor, sessionManager);

  const handler = toolExecutor.getHandler(LIST_TASKS_TOOL_NAME);
  assert.ok(handler, "list_tasks handler 应存在");

  const result = await handler({}, createToolExecutionContext());

  assert.equal(result.ok, true, "列出应成功");
  const output = JSON.parse(result.output as string);
  assert.equal(output.total, 2, "应返回 2 个任务");
  assert.equal(output.tasks.length, 2, "tasks 数组长度应为 2");
});
