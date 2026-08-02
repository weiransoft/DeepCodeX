/**
 * LLM 工具（llm-tools）单元测试 —— ADR-DI-001 §9.1
 *
 * 测试范围（对齐 ADR-DI-001 §9.1 单元测试用例 + §4.6 LLM 工具）：
 * - TC-LT-001: INTERRUPT_TOOL_DEFINITIONS 4 个工具定义结构正确
 * - TC-LT-002: INTERRUPT_TOOL_METADATA 4 个工具元数据完整
 * - TC-LT-003: createBackgroundTaskHandler 成功启动后台任务
 * - TC-LT-004: createBackgroundTaskHandler 缺少 prompt 参数返回错误
 * - TC-LT-005: createBackgroundTaskHandler 空字符串 prompt 返回错误
 * - TC-LT-006: createBackgroundTaskHandler 非字符串 prompt 返回错误
 * - TC-LT-007: createBackgroundTaskHandler 无效 kind 默认为 chat
 * - TC-LT-008: createBackgroundTaskHandler 未注入 startBackgroundTask 返回 feature unavailable
 * - TC-LT-009: createBackgroundTaskHandler startBackgroundTask 抛错时 catch 返回错误
 * - TC-LT-010: createListTasksHandler 成功返回任务列表
 * - TC-LT-011: createListTasksHandler 按 status 过滤
 * - TC-LT-012: createListTasksHandler include_history=true 包含历史任务
 * - TC-LT-013: createListTasksHandler 未注入 listTasks 返回 feature unavailable
 * - TC-LT-014: createCancelTaskHandler 成功取消任务
 * - TC-LT-015: createCancelTaskHandler 携带 reason 参数
 * - TC-LT-016: createCancelTaskHandler 缺少 task_id 返回错误
 * - TC-LT-017: createCancelTaskHandler 空字符串 task_id 返回错误
 * - TC-LT-018: createCancelTaskHandler 未注入 cancelTask 返回 feature unavailable
 * - TC-LT-019: createInjectMessageHandler 成功注入消息
 * - TC-LT-020: createInjectMessageHandler 缺少 task_id 返回错误
 * - TC-LT-021: createInjectMessageHandler 缺少 message 返回错误
 * - TC-LT-022: createInjectMessageHandler 未注入 taskRegistry 返回 feature unavailable
 * - TC-LT-023: createInjectMessageHandler 任务不存在返回错误
 * - TC-LT-024: createInjectMessageHandler 注入后 task.inject 被调用
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接调用 createXxxHandler 工厂函数创建真实 handler
 * - StubSessionManager 真实实现 InterruptibleSessionManager 接口（非 mock 框架）
 * - StubTask 真实实现 BackgroundTaskLike 接口（含真实 inject 行为）
 * - 所有 fixture 使用真实数据结构
 * - 中文注释
 *
 * Stub 设计说明（非 mock）：
 * - StubSessionManager：真实实现 InterruptibleSessionManager 接口，
 *   内部维护真实的 TaskRegistry-like 数据结构（Map 存储），执行真实逻辑
 * - StubTask：真实实现 BackgroundTaskLike 接口，inject() 真实记录调用参数
 * - 这些 Stub 与 background-runner.test.ts 的 StubSessionHandle 同构：
 *   真实实现接口契约，不调用真实 LLM，但执行真实业务逻辑
 *
 * 设计依据：
 * - ADR-DI-001 §4.6 LLM 工具
 * - ADR-DI-001 §7.3 LLM 工具注册
 * - ADR-DI-001 §9.1 单元测试用例
 *
 * @module tests/llm-tools
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  INTERRUPT_TOOL_DEFINITIONS,
  INTERRUPT_TOOL_METADATA,
  createBackgroundTaskHandler,
  createCancelTaskHandler,
  createInjectMessageHandler,
  createListTasksHandler,
} from "../interrupts/llm-tools";
import type {
  BackgroundTaskLike,
  InterruptToolHandlerContext,
  InterruptibleSessionManager,
} from "../interrupts/llm-tools";
import {
  BACKGROUND_TASK_TOOL_NAME,
  CANCEL_TASK_TOOL_NAME,
  INJECT_MESSAGE_TOOL_NAME,
  LIST_TASKS_TOOL_NAME,
} from "../interrupts/types";
import type { InjectSource, TaskKind, TaskListFilter, TaskStatus } from "../interrupts/types";

// ============================================================================
// 测试辅助：StubTask（真实实现 BackgroundTaskLike 接口，非 mock）
// ============================================================================

/**
 * 真实 BackgroundTaskLike 实现（非 mock）
 *
 * 真实实现 BackgroundTaskLike 接口契约：
 * - 持有真实的状态字段（id / kind / state / progress / stats / initialPromptText / sessionId）
 * - inject() 真实记录调用参数，可用于后续断言
 *
 * 与 background-runner.test.ts 的 StubSessionHandle 同构：
 * 真实实现接口，不调用真实 LLM，但执行真实业务逻辑。
 */
class StubTask implements BackgroundTaskLike {
  readonly id: string;
  readonly kind: TaskKind;
  state: TaskStatus;
  progress: number;
  readonly stats: { readonly iterations: number; readonly durationMs: number; readonly tokensUsed: number };
  readonly initialPromptText: string;
  readonly sessionId: string;

  /** inject 调用记录器（真实记录，非 mock 框架） */
  readonly injectedCalls: Array<{ readonly text: string; readonly source: InjectSource }> = [];

  constructor(options: {
    id: string;
    kind?: TaskKind;
    state?: TaskStatus;
    progress?: number;
    initialPromptText?: string;
    sessionId?: string;
    stats?: { readonly iterations: number; readonly durationMs: number; readonly tokensUsed: number };
  }) {
    this.id = options.id;
    this.kind = options.kind ?? "chat";
    this.state = options.state ?? "running";
    this.progress = options.progress ?? 0;
    this.stats = options.stats ?? { iterations: 0, durationMs: 0, tokensUsed: 0 };
    this.initialPromptText = options.initialPromptText ?? "测试任务";
    this.sessionId = options.sessionId ?? `s-${options.id}`;
  }

  /**
   * 真实 inject 实现（记录调用参数）
   *
   * @param instruction 注入指令对象
   */
  inject(instruction: { readonly text: string; readonly source: InjectSource }): void {
    this.injectedCalls.push({ text: instruction.text, source: instruction.source });
  }
}

// ============================================================================
// 测试辅助：StubSessionManager（真实实现 InterruptibleSessionManager 接口）
// ============================================================================

/**
 * 真实 InterruptibleSessionManager 实现（非 mock）
 *
 * 真实实现 InterruptibleSessionManager 接口契约：
 * - taskRegistry：真实 Map 存储，支持 get / list 操作
 * - startBackgroundTask：真实创建 StubTask 并注册到 taskRegistry
 * - listTasks：真实遍历 taskRegistry 返回任务列表
 * - cancelTask：真实修改任务状态为 cancelled
 *
 * 通过 enableFeatures 参数控制哪些能力可用：
 * - "all"：所有功能可用（默认）
 * - "no-background"：startBackgroundTask 不存在（测试降级路径）
 * - "no-list"：listTasks 不存在（测试降级路径）
 * - "no-cancel"：cancelTask 不存在（测试降级路径）
 * - "no-registry"：taskRegistry 为 undefined（测试降级路径）
 */
class StubSessionManager implements InterruptibleSessionManager {
  /** 真实任务存储（Map 保持插入顺序） */
  private readonly tasks: Map<string, StubTask> = new Map();
  /** 启用的功能集合 */
  private readonly enabledFeatures: ReadonlySet<string>;
  /** startBackgroundTask 调用记录器 */
  readonly startCalls: Array<{ readonly promptText: string; readonly kind: TaskKind }> = [];
  /** cancelTask 调用记录器 */
  readonly cancelCalls: Array<{ readonly taskId: string; readonly reason?: string }> = [];

  constructor(enableFeatures: readonly string[] = ["all"]) {
    this.enabledFeatures = new Set(enableFeatures);
  }

  /** taskRegistry getter（仅在启用时返回真实 registry） */
  get taskRegistry():
    | {
        get(taskId: string): BackgroundTaskLike | null;
        list(filter?: TaskListFilter): readonly BackgroundTaskLike[];
      }
    | undefined {
    // 当 enableFeatures 包含 "no-registry" 时，模拟 taskRegistry 未注入
    if (this.enabledFeatures.has("no-registry")) {
      return undefined;
    }
    // 返回真实的 taskRegistry 实现（非 mock）
    return {
      get: (taskId: string): BackgroundTaskLike | null => {
        return this.tasks.get(taskId) ?? null;
      },
      list: (filter?: TaskListFilter): readonly BackgroundTaskLike[] => {
        let result: StubTask[] = Array.from(this.tasks.values());
        // 真实实现 status 过滤
        if (filter?.status !== undefined) {
          const statuses: readonly TaskStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
          result = result.filter((t) => statuses.includes(t.state));
        }
        // 真实实现 kind 过滤
        if (filter?.kind !== undefined) {
          result = result.filter((t) => t.kind === filter.kind);
        }
        // includeHistory=false 时过滤掉已完成任务（默认行为）
        if (!filter?.includeHistory) {
          result = result.filter(
            (t) => t.state !== "succeeded" && t.state !== "failed" && t.state !== "cancelled" && t.state !== "timeout"
          );
        }
        return result;
      },
    };
  }

  /** 后台任务启动器 getter（仅在启用时返回真实 runner） */
  get backgroundRunner():
    | {
        startBackground(
          prompt: unknown,
          kind?: TaskKind
        ): Promise<{ readonly taskId: string; readonly sessionId: string }>;
      }
    | undefined {
    if (this.enabledFeatures.has("no-background")) {
      return undefined;
    }
    return undefined; // backgroundRunner 在本 Stub 中未直接使用，handler 通过 startBackgroundTask 调用
  }

  /**
   * 启动后台任务（真实实现）
   *
   * @param prompt 初始 prompt
   * @param kind 任务类型
   */
  async startBackgroundTask(
    prompt: { text?: string },
    kind?: TaskKind
  ): Promise<{ readonly taskId: string; readonly sessionId: string }> {
    const taskId = `t-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = `s-${crypto.randomUUID().slice(0, 8)}`;
    const task = new StubTask({
      id: taskId,
      kind: kind ?? "chat",
      state: "queued",
      initialPromptText: prompt.text ?? "",
      sessionId,
    });
    this.tasks.set(taskId, task);
    this.startCalls.push({ promptText: prompt.text ?? "", kind: kind ?? "chat" });
    return { taskId, sessionId };
  }

  /**
   * 列出所有任务（真实实现）
   *
   * @param filter 过滤条件
   */
  listTasks(filter?: TaskListFilter): readonly BackgroundTaskLike[] {
    let result: StubTask[] = Array.from(this.tasks.values());
    if (filter?.status !== undefined) {
      const statuses: readonly TaskStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
      result = result.filter((t) => statuses.includes(t.state));
    }
    if (filter?.kind !== undefined) {
      result = result.filter((t) => t.kind === filter.kind);
    }
    if (!filter?.includeHistory) {
      result = result.filter((t) => t.state !== "succeeded" && t.state !== "failed" && t.state !== "cancelled");
    }
    return result;
  }

  /**
   * 取消指定任务（真实实现）
   *
   * @param taskId 任务 ID
   * @param reason 取消原因
   */
  cancelTask(taskId: string, reason?: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = "cancelled";
    }
    this.cancelCalls.push({ taskId, reason });
  }

  /**
   * 手动添加任务到 registry（测试辅助方法，非接口方法）
   *
   * @param task 要添加的任务
   */
  addTask(task: StubTask): void {
    this.tasks.set(task.id, task);
  }
}

// ============================================================================
// 测试辅助：构造真实 ToolHandler 执行上下文（ToolExecutionContext）
// ============================================================================

/**
 * 构造测试用 ToolExecutionContext
 *
 * ToolHandler 签名为 (args, context) => Promise<ToolExecutionResult>，
 * 但 llm-tools 的 handler 内部不使用 context 参数（仅用 args），
 * 因此传入最小化真实 context 即可。
 *
 * @returns 真实 ToolExecutionContext（最小化字段）
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
// TC-LT-001: INTERRUPT_TOOL_DEFINITIONS 4 个工具定义结构正确
// ============================================================================

test("TC-LT-001: INTERRUPT_TOOL_DEFINITIONS 4 个工具定义结构正确", () => {
  assert.equal(INTERRUPT_TOOL_DEFINITIONS.length, 4, "应有 4 个工具定义");

  // 验证工具名
  const toolNames = INTERRUPT_TOOL_DEFINITIONS.map((d) => d.function.name);
  assert.ok(toolNames.includes(BACKGROUND_TASK_TOOL_NAME), "应包含 background_task");
  assert.ok(toolNames.includes(LIST_TASKS_TOOL_NAME), "应包含 list_tasks");
  assert.ok(toolNames.includes(CANCEL_TASK_TOOL_NAME), "应包含 cancel_task");
  assert.ok(toolNames.includes(INJECT_MESSAGE_TOOL_NAME), "应包含 inject_message");

  // 验证每个工具定义结构
  for (const def of INTERRUPT_TOOL_DEFINITIONS) {
    assert.equal(def.type, "function", "type 应为 function");
    assert.ok(def.function.name.length > 0, "function.name 应非空");
    assert.ok(def.function.description.length > 0, "function.description 应非空");
    assert.equal(def.function.parameters.type, "object", "parameters.type 应为 object");
    assert.ok(def.function.parameters.properties, "parameters.properties 应存在");
  }

  // 验证 background_task 的必填字段
  const bgDef = INTERRUPT_TOOL_DEFINITIONS.find((d) => d.function.name === BACKGROUND_TASK_TOOL_NAME);
  assert.ok(bgDef, "background_task 定义应存在");
  assert.deepEqual(bgDef?.function.parameters.required, ["prompt"], "background_task 必填字段应为 [prompt]");
  assert.equal(bgDef?.function.parameters.additionalProperties, false, "additionalProperties 应为 false");

  // 验证 cancel_task 的必填字段
  const cancelDef = INTERRUPT_TOOL_DEFINITIONS.find((d) => d.function.name === CANCEL_TASK_TOOL_NAME);
  assert.ok(cancelDef, "cancel_task 定义应存在");
  assert.deepEqual(cancelDef?.function.parameters.required, ["task_id"], "cancel_task 必填字段应为 [task_id]");

  // 验证 inject_message 的必填字段
  const injectDef = INTERRUPT_TOOL_DEFINITIONS.find((d) => d.function.name === INJECT_MESSAGE_TOOL_NAME);
  assert.ok(injectDef, "inject_message 定义应存在");
  assert.deepEqual(
    injectDef?.function.parameters.required,
    ["task_id", "message"],
    "inject_message 必填字段应为 [task_id, message]"
  );

  // 验证 list_tasks 无必填字段
  const listDef = INTERRUPT_TOOL_DEFINITIONS.find((d) => d.function.name === LIST_TASKS_TOOL_NAME);
  assert.ok(listDef, "list_tasks 定义应存在");
  assert.equal(listDef?.function.parameters.required, undefined, "list_tasks 应无必填字段");
});

// ============================================================================
// TC-LT-002: INTERRUPT_TOOL_METADATA 4 个工具元数据完整
// ============================================================================

test("TC-LT-002: INTERRUPT_TOOL_METADATA 4 个工具元数据完整", () => {
  assert.equal(INTERRUPT_TOOL_METADATA.length, 4, "应有 4 个工具元数据");

  // 验证每个元数据结构
  for (const meta of INTERRUPT_TOOL_METADATA) {
    assert.ok(meta.name.length > 0, "name 应非空");
    assert.ok(meta.description.length > 0, "description 应非空");
    assert.ok(meta.description.length < 200, `description 应简洁（<200 字符），实际：${meta.description.length}`);
  }

  // 验证元数据与定义一致
  for (const meta of INTERRUPT_TOOL_METADATA) {
    const def = INTERRUPT_TOOL_DEFINITIONS.find((d) => d.function.name === meta.name);
    assert.ok(def, `元数据 ${meta.name} 应有对应的工具定义`);
    assert.equal(meta.description, def?.function.description, "元数据 description 应与定义一致");
  }

  // 验证冻结
  assert.ok(Object.isFrozen(INTERRUPT_TOOL_METADATA), "INTERRUPT_TOOL_METADATA 应被冻结");
});

// ============================================================================
// TC-LT-003: createBackgroundTaskHandler 成功启动后台任务
// ============================================================================

test("TC-LT-003: createBackgroundTaskHandler 成功启动后台任务", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  const result = await handler({ prompt: "调研 React 19 新特性", kind: "chat" }, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功");
  assert.equal(result.name, BACKGROUND_TASK_TOOL_NAME, "工具名应为 background_task");
  assert.ok(result.output, "output 应非空");

  // 解析 output JSON 验证结构
  const output = JSON.parse(result.output as string);
  assert.ok(output.taskId.startsWith("t-"), "taskId 应以 t- 前缀开头");
  assert.ok(output.sessionId.startsWith("s-"), "sessionId 应以 s- 前缀开头");
  assert.equal(output.status, "queued", "status 应为 queued");

  // 验证 metadata
  assert.equal(result.metadata?.taskId, output.taskId, "metadata.taskId 应与 output 一致");
  assert.equal(result.metadata?.kind, "chat", "metadata.kind 应为 chat");

  // 验证 SessionManager 被调用
  assert.equal(sessionManager.startCalls.length, 1, "startBackgroundTask 应被调用 1 次");
  assert.equal(sessionManager.startCalls[0]?.promptText, "调研 React 19 新特性", "prompt 文本应一致");
  assert.equal(sessionManager.startCalls[0]?.kind, "chat", "kind 应为 chat");
});

// ============================================================================
// TC-LT-004: createBackgroundTaskHandler 缺少 prompt 参数返回错误
// ============================================================================

test("TC-LT-004: createBackgroundTaskHandler 缺少 prompt 参数返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  // 不传 prompt 参数
  const result = await handler({}, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.equal(result.name, BACKGROUND_TASK_TOOL_NAME, "工具名应为 background_task");
  assert.ok(result.error?.includes("prompt"), "错误信息应包含 prompt");
  assert.ok(result.error?.includes("非空字符串"), "错误信息应说明需非空字符串");

  // 验证 SessionManager 未被调用
  assert.equal(sessionManager.startCalls.length, 0, "startBackgroundTask 不应被调用");
});

// ============================================================================
// TC-LT-005: createBackgroundTaskHandler 空字符串 prompt 返回错误
// ============================================================================

test("TC-LT-005: createBackgroundTaskHandler 空字符串 prompt 返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  // 空字符串 prompt
  const result = await handler({ prompt: "   " }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("prompt"), "错误信息应包含 prompt");
  assert.equal(sessionManager.startCalls.length, 0, "startBackgroundTask 不应被调用");
});

// ============================================================================
// TC-LT-006: createBackgroundTaskHandler 非字符串 prompt 返回错误
// ============================================================================

test("TC-LT-006: createBackgroundTaskHandler 非字符串 prompt 返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  // 非字符串 prompt（数字）
  const result = await handler({ prompt: 12345 }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("prompt"), "错误信息应包含 prompt");
  assert.equal(sessionManager.startCalls.length, 0, "startBackgroundTask 不应被调用");
});

// ============================================================================
// TC-LT-007: createBackgroundTaskHandler 无效 kind 默认为 chat
// ============================================================================

test("TC-LT-007: createBackgroundTaskHandler 无效 kind 默认为 chat", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  // 无效 kind 值
  const result = await handler({ prompt: "测试任务", kind: "invalid-kind" }, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功（kind 降级为 chat）");
  assert.equal(result.metadata?.kind, "chat", "metadata.kind 应为 chat（降级）");
  assert.equal(sessionManager.startCalls[0]?.kind, "chat", "SessionManager 收到的 kind 应为 chat");
});

// ============================================================================
// TC-LT-008: createBackgroundTaskHandler 未注入 startBackgroundTask 返回 feature unavailable
// ============================================================================

test("TC-LT-008: createBackgroundTaskHandler 未注入 startBackgroundTask 返回 feature unavailable", async () => {
  // 构造未启用 background 功能的 StubSessionManager
  // 通过覆盖 startBackgroundTask 为 undefined 模拟未注入
  const sessionManager = new StubSessionManager();
  // 删除 startBackgroundTask 方法模拟未注入
  (sessionManager as unknown as { startBackgroundTask: undefined }).startBackgroundTask = undefined;

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  const result = await handler({ prompt: "测试任务" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("功能不可用"), "错误信息应包含 功能不可用");
  assert.ok(result.error?.includes("backgroundRunner"), "错误信息应包含 backgroundRunner");
});

// ============================================================================
// TC-LT-009: createBackgroundTaskHandler startBackgroundTask 抛错时 catch 返回错误
// ============================================================================

test("TC-LT-009: createBackgroundTaskHandler startBackgroundTask 抛错时 catch 返回错误", async () => {
  // 构造 startBackgroundTask 抛错的 StubSessionManager
  const sessionManager = new StubSessionManager();
  (
    sessionManager as unknown as {
      startBackgroundTask: () => Promise<{ readonly taskId: string; readonly sessionId: string }>;
    }
  ).startBackgroundTask = async () => {
    throw new Error("模拟启动失败：并发上限超限");
  };

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createBackgroundTaskHandler(context);

  const result = await handler({ prompt: "测试任务" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("background_task 工具执行失败"), "错误信息应包含 工具执行失败");
  assert.ok(result.error?.includes("模拟启动失败"), "错误信息应包含原始异常消息");
});

// ============================================================================
// TC-LT-010: createListTasksHandler 成功返回任务列表
// ============================================================================

test("TC-LT-010: createListTasksHandler 成功返回任务列表", async () => {
  const sessionManager = new StubSessionManager();
  // 添加 3 个真实任务
  sessionManager.addTask(new StubTask({ id: "t-001", kind: "chat", state: "running", initialPromptText: "任务 1" }));
  sessionManager.addTask(
    new StubTask({ id: "t-002", kind: "autonomous", state: "running", initialPromptText: "任务 2" })
  );
  sessionManager.addTask(new StubTask({ id: "t-003", kind: "chat", state: "queued", initialPromptText: "任务 3" }));

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createListTasksHandler(context);

  const result = await handler({}, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功");
  assert.equal(result.name, LIST_TASKS_TOOL_NAME, "工具名应为 list_tasks");

  const output = JSON.parse(result.output as string);
  assert.equal(output.total, 3, "应返回 3 个任务");
  assert.equal(output.tasks.length, 3, "tasks 数组长度应为 3");

  // 验证任务摘要结构
  const task0 = output.tasks[0];
  assert.ok(task0.id, "task.id 应存在");
  assert.ok(task0.kind, "task.kind 应存在");
  assert.ok(task0.status, "task.status 应存在");
  assert.equal(typeof task0.progress, "number", "task.progress 应为数值");
  assert.equal(typeof task0.duration, "number", "task.duration 应为数值");
  assert.equal(typeof task0.text, "string", "task.text 应为字符串");

  // 验证 metadata
  assert.equal(result.metadata?.total, 3, "metadata.total 应为 3");
});

// ============================================================================
// TC-LT-011: createListTasksHandler 按 status 过滤
// ============================================================================

test("TC-LT-011: createListTasksHandler 按 status 过滤", async () => {
  const sessionManager = new StubSessionManager();
  sessionManager.addTask(new StubTask({ id: "t-001", state: "running" }));
  sessionManager.addTask(new StubTask({ id: "t-002", state: "queued" }));
  sessionManager.addTask(new StubTask({ id: "t-003", state: "running" }));

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createListTasksHandler(context);

  // 过滤 running 状态
  const result = await handler({ status: "running" }, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功");
  const output = JSON.parse(result.output as string);
  assert.equal(output.total, 2, "应返回 2 个 running 任务");
  for (const task of output.tasks) {
    assert.equal(task.status, "running", "所有任务状态应为 running");
  }
});

// ============================================================================
// TC-LT-012: createListTasksHandler include_history=true 包含历史任务
// ============================================================================

test("TC-LT-012: createListTasksHandler include_history=true 包含历史任务", async () => {
  const sessionManager = new StubSessionManager();
  sessionManager.addTask(new StubTask({ id: "t-001", state: "running" }));
  sessionManager.addTask(new StubTask({ id: "t-002", state: "succeeded" }));
  sessionManager.addTask(new StubTask({ id: "t-003", state: "cancelled" }));

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createListTasksHandler(context);

  // 不包含历史（默认）：只返回 running
  const resultActive = await handler({}, createToolExecutionContext());
  const outputActive = JSON.parse(resultActive.output ?? "{}");
  assert.equal(outputActive.total, 1, "默认应只返回 1 个活跃任务");

  // 包含历史：返回全部 3 个
  const resultAll = await handler({ include_history: true }, createToolExecutionContext());
  const outputAll = JSON.parse(resultAll.output as string);
  assert.equal(outputAll.total, 3, "include_history=true 应返回 3 个任务");
});

// ============================================================================
// TC-LT-013: createListTasksHandler 未注入 listTasks 返回 feature unavailable
// ============================================================================

test("TC-LT-013: createListTasksHandler 未注入 listTasks 返回 feature unavailable", async () => {
  const sessionManager = new StubSessionManager();
  // 删除 listTasks 方法模拟未注入
  (sessionManager as unknown as { listTasks: undefined }).listTasks = undefined;

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createListTasksHandler(context);

  const result = await handler({}, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("功能不可用"), "错误信息应包含 功能不可用");
  assert.ok(result.error?.includes("taskRegistry"), "错误信息应包含 taskRegistry");
});

// ============================================================================
// TC-LT-014: createCancelTaskHandler 成功取消任务
// ============================================================================

test("TC-LT-014: createCancelTaskHandler 成功取消任务", async () => {
  const sessionManager = new StubSessionManager();
  sessionManager.addTask(new StubTask({ id: "t-001", state: "running" }));

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createCancelTaskHandler(context);

  const result = await handler({ task_id: "t-001" }, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功");
  assert.equal(result.name, CANCEL_TASK_TOOL_NAME, "工具名应为 cancel_task");

  const output = JSON.parse(result.output as string);
  assert.equal(output.success, true, "output.success 应为 true");
  assert.equal(output.taskId, "t-001", "output.taskId 应一致");
  assert.equal(output.finalStatus, "cancelled", "output.finalStatus 应为 cancelled");

  // 验证 metadata
  assert.equal(result.metadata?.taskId, "t-001", "metadata.taskId 应一致");
  assert.equal(result.metadata?.finalStatus, "cancelled", "metadata.finalStatus 应为 cancelled");

  // 验证 SessionManager.cancelTask 被调用
  assert.equal(sessionManager.cancelCalls.length, 1, "cancelTask 应被调用 1 次");
  assert.equal(sessionManager.cancelCalls[0]?.taskId, "t-001", "taskId 应一致");
});

// ============================================================================
// TC-LT-015: createCancelTaskHandler 携带 reason 参数
// ============================================================================

test("TC-LT-015: createCancelTaskHandler 携带 reason 参数", async () => {
  const sessionManager = new StubSessionManager();
  sessionManager.addTask(new StubTask({ id: "t-002", state: "running" }));

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createCancelTaskHandler(context);

  const result = await handler({ task_id: "t-002", reason: "用户主动取消" }, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功");
  assert.equal(sessionManager.cancelCalls[0]?.reason, "用户主动取消", "reason 应被传递");
});

// ============================================================================
// TC-LT-016: createCancelTaskHandler 缺少 task_id 返回错误
// ============================================================================

test("TC-LT-016: createCancelTaskHandler 缺少 task_id 返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createCancelTaskHandler(context);

  const result = await handler({}, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("task_id"), "错误信息应包含 task_id");
  assert.ok(result.error?.includes("非空字符串"), "错误信息应说明需非空字符串");
  assert.equal(sessionManager.cancelCalls.length, 0, "cancelTask 不应被调用");
});

// ============================================================================
// TC-LT-017: createCancelTaskHandler 空字符串 task_id 返回错误
// ============================================================================

test("TC-LT-017: createCancelTaskHandler 空字符串 task_id 返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createCancelTaskHandler(context);

  const result = await handler({ task_id: "  " }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("task_id"), "错误信息应包含 task_id");
  assert.equal(sessionManager.cancelCalls.length, 0, "cancelTask 不应被调用");
});

// ============================================================================
// TC-LT-018: createCancelTaskHandler 未注入 cancelTask 返回 feature unavailable
// ============================================================================

test("TC-LT-018: createCancelTaskHandler 未注入 cancelTask 返回 feature unavailable", async () => {
  const sessionManager = new StubSessionManager();
  (sessionManager as unknown as { cancelTask: undefined }).cancelTask = undefined;

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createCancelTaskHandler(context);

  const result = await handler({ task_id: "t-001" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("功能不可用"), "错误信息应包含 功能不可用");
  assert.ok(result.error?.includes("taskRegistry"), "错误信息应包含 taskRegistry");
});

// ============================================================================
// TC-LT-019: createInjectMessageHandler 成功注入消息
// ============================================================================

test("TC-LT-019: createInjectMessageHandler 成功注入消息", async () => {
  const sessionManager = new StubSessionManager();
  const task = new StubTask({ id: "t-001", state: "running" });
  sessionManager.addTask(task);

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createInjectMessageHandler(context);

  const result = await handler({ task_id: "t-001", message: "请改用 TypeScript 实现" }, createToolExecutionContext());

  assert.equal(result.ok, true, "应返回成功");
  assert.equal(result.name, INJECT_MESSAGE_TOOL_NAME, "工具名应为 inject_message");

  const output = JSON.parse(result.output as string);
  assert.equal(output.success, true, "output.success 应为 true");
  assert.equal(output.taskId, "t-001", "output.taskId 应一致");
  assert.equal(output.queueSize, 1, "output.queueSize 应为 1");

  // 验证 metadata
  assert.equal(result.metadata?.taskId, "t-001", "metadata.taskId 应一致");
  assert.equal(result.metadata?.queueSize, 1, "metadata.queueSize 应为 1");
});

// ============================================================================
// TC-LT-020: createInjectMessageHandler 缺少 task_id 返回错误
// ============================================================================

test("TC-LT-020: createInjectMessageHandler 缺少 task_id 返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createInjectMessageHandler(context);

  const result = await handler({ message: "测试消息" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("task_id"), "错误信息应包含 task_id");
  assert.ok(result.error?.includes("非空字符串"), "错误信息应说明需非空字符串");
});

// ============================================================================
// TC-LT-021: createInjectMessageHandler 缺少 message 返回错误
// ============================================================================

test("TC-LT-021: createInjectMessageHandler 缺少 message 返回错误", async () => {
  const sessionManager = new StubSessionManager();
  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createInjectMessageHandler(context);

  const result = await handler({ task_id: "t-001" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("message"), "错误信息应包含 message");
  assert.ok(result.error?.includes("非空字符串"), "错误信息应说明需非空字符串");
});

// ============================================================================
// TC-LT-022: createInjectMessageHandler 未注入 taskRegistry 返回 feature unavailable
// ============================================================================

test("TC-LT-022: createInjectMessageHandler 未注入 taskRegistry 返回 feature unavailable", async () => {
  // 构造 taskRegistry 为 undefined 的 StubSessionManager
  const sessionManager = new StubSessionManager(["no-registry"]);

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createInjectMessageHandler(context);

  const result = await handler({ task_id: "t-001", message: "测试消息" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("功能不可用"), "错误信息应包含 功能不可用");
  assert.ok(result.error?.includes("taskRegistry"), "错误信息应包含 taskRegistry");
});

// ============================================================================
// TC-LT-023: createInjectMessageHandler 任务不存在返回错误
// ============================================================================

test("TC-LT-023: createInjectMessageHandler 任务不存在返回错误", async () => {
  const sessionManager = new StubSessionManager();
  // 不添加任何任务

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createInjectMessageHandler(context);

  const result = await handler({ task_id: "t-not-exist", message: "测试消息" }, createToolExecutionContext());

  assert.equal(result.ok, false, "应返回失败");
  assert.ok(result.error?.includes("任务不存在"), "错误信息应包含 任务不存在");
  assert.ok(result.error?.includes("t-not-exist"), "错误信息应包含任务 ID");
});

// ============================================================================
// TC-LT-024: createInjectMessageHandler 注入后 task.inject 被调用
// ============================================================================

test("TC-LT-024: createInjectMessageHandler 注入后 task.inject 被调用", async () => {
  const sessionManager = new StubSessionManager();
  const task = new StubTask({ id: "t-001", state: "running" });
  sessionManager.addTask(task);

  const context: InterruptToolHandlerContext = { sessionManager };
  const handler = createInjectMessageHandler(context);

  await handler({ task_id: "t-001", message: "请添加错误处理" }, createToolExecutionContext());

  // 验证 task.inject 被调用
  assert.equal(task.injectedCalls.length, 1, "task.inject 应被调用 1 次");
  assert.equal(task.injectedCalls[0]?.text, "请添加错误处理", "注入文本应一致");
  assert.equal(task.injectedCalls[0]?.source, "llm", "注入来源应为 llm");
});
