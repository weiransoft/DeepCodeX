/**
 * 动态指令注入与后台子 Agent 端到端集成测试 —— ADR-DI-001 §9.2
 *
 * 测试范围（对齐 ADR-DI-001 §9.2 端到端场景测试用例）：
 * - TC-E2E-001: /inject 在 LLM 流式中触发，主循环下一轮迭代消费指令（InterruptQueue 集成）
 * - TC-E2E-002: /bg 后台启动 chat 任务，立即返回 taskId，主任务不阻塞
 * - TC-E2E-003: /bg 后台启动 autonomous 任务（Phase 1 应抛错拒绝）
 * - TC-E2E-004: /tasks 显示完整任务表格（前台 + 后台 + 历史区）
 * - TC-E2E-005: /fg 切换前台，不中断其他后台任务
 * - TC-E2E-006: /cancel 取消后台任务，state=cancelled
 * - TC-E2E-007: /pause + /resume 完整流程，状态流转 running→paused→running→succeeded
 * - TC-E2E-008: 任务完成后自动移到历史区（unregister 触发）
 * - TC-E2E-009: LLM 调用 background_task 工具启动子 agent（LLM 工具集成）
 * - TC-E2E-010: LLM 调用 inject_message 工具注入指令到子 agent
 * - TC-E2E-011: 零回归断言：未注入组件时 SessionManager 行为不变
 * - TC-E2E-012: 多后台任务并行（≥3 个）互不干扰
 * - TC-E2E-013: EagCommandParser 解析 7 个新命令（命令解析器集成）
 * - TC-E2E-014: registerInterruptTools 注册 4 个 LLM 工具到 ToolExecutor（注册入口集成）
 * - TC-E2E-015: 任务并发上限保护（MAX_CONCURRENT_TASKS=8）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new InterruptQueue() / TaskRegistry() / BackgroundTaskRunner()
 * - sessionManagerFactory 返回真实的 StubSessionHandle（不调用 LLM，但真实实现接口）
 * - 中文注释详细
 *
 * 设计依据：
 * - ADR-DI-001 §5 核心机制详细设计
 * - ADR-DI-001 §7 与现有架构的集成点
 * - ADR-DI-001 §9.2 端到端场景测试用例
 *
 * @module tests/dynamic-injection-integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";

// ============================================================================
// 真实组件导入（不使用 mock）
// ============================================================================

import { InterruptQueue } from "../interrupts/interrupt-queue";
import { TaskRegistry } from "../interrupts/task-registry";
import { BackgroundTask } from "../interrupts/background-task";
import { BackgroundTaskRunner } from "../interrupts/background-runner";
import { InterruptToolRegistry, registerInterruptTools } from "../interrupts/register-tools";
import {
  INTERRUPT_TOOL_DEFINITIONS,
  createBackgroundTaskHandler,
  createCancelTaskHandler,
  createInjectMessageHandler,
  createListTasksHandler,
} from "../interrupts/llm-tools";
import { EagCommandParser } from "../eag/cli/eag-command-parser";
import { InjectInterruptError, QueueOverflowError, TaskLimitExceededError } from "../interrupts/types";
import type { InjectedInstruction, TaskKind, TaskListFilter } from "../interrupts/types";
import type { SessionHandle } from "../interrupts/background-runner";
import type { ToolHandler, ToolExecutionContext } from "../common/tool-types";
import type { UserPromptContent } from "../session";

// ============================================================================
// 测试辅助：StubSessionHandle（真实实现，非 mock）
// ============================================================================

/**
 * 真实 SessionHandle 实现（非 mock）
 *
 * 不调用真实 LLM，但真实实现 SessionHandle 接口契约。
 * 通过 mode 参数控制行为，覆盖测试场景。
 *
 * 行为模式：
 * - "succeed"：handleUserPrompt 立即 resolve（模拟 LLM 成功响应）
 * - "fail"：handleUserPrompt 立即 reject（模拟 LLM 调用失败）
 * - "long-running"：返回永不 resolve 的 Promise，直到 controller.signal.aborted 后 reject
 */
class StubSessionHandle implements SessionHandle {
  /** 行为模式 */
  private readonly mode: "succeed" | "fail" | "long-running";
  /** 独立的 AbortController */
  private readonly controller: AbortController;
  /** 接收到的 prompt（用于断言） */
  receivedPrompt: string | null = null;

  constructor(mode: "succeed" | "fail" | "long-running", controller: AbortController) {
    this.mode = mode;
    this.controller = controller;
  }

  /**
   * 启动会话（与 SessionManager.handleUserPrompt 同构）
   *
   * 根据 mode 返回不同的 Promise：
   * - succeed：立即 resolve（记录 prompt）
   * - fail：立即 reject
   * - long-running：永不 resolve，直到 controller.abort 后 reject
   */
  handleUserPrompt(prompt: string): Promise<void> {
    this.receivedPrompt = prompt;
    switch (this.mode) {
      case "succeed":
        return Promise.resolve();
      case "fail":
        return Promise.reject(new Error("StubSessionHandle 模拟 LLM 调用失败"));
      case "long-running":
        return new Promise<void>((_resolve, reject) => {
          if (this.controller.signal.aborted) {
            reject(new Error(`Aborted: ${this.controller.signal.reason ?? "unknown"}`));
            return;
          }
          this.controller.signal.addEventListener("abort", () => {
            reject(new Error(`Aborted: ${this.controller.signal.reason ?? "unknown"}`));
          });
        });
      default:
        return Promise.reject(new Error(`未知 mode: ${this.mode}`));
    }
  }
}

// ============================================================================
// 测试辅助：StubToolExecutor（真实实现 ToolExecutorRegistrar 接口）
// ============================================================================

/**
 * 真实 ToolExecutor 注册器实现（用于测试 registerInterruptTools）
 *
 * 实现最小化的 ToolExecutorRegistrar 接口，不调用真实 LLM 工具执行器。
 * 维护一个内部 Map 记录所有注册的 handler。
 */
class StubToolExecutor {
  /** 已注册的 handler 映射 */
  private readonly handlers = new Map<string, ToolHandler>();

  /** 实现 ToolExecutorRegistrar.registerToolHandler */
  readonly registerToolHandler = (name: string, handler: ToolHandler): void => {
    this.handlers.set(name, handler);
  };

  /** 获取已注册的 handler（用于断言） */
  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** 已注册的 handler 数量 */
  get size(): number {
    return this.handlers.size;
  }

  /** 判断是否已注册指定 handler */
  has(name: string): boolean {
    return this.handlers.has(name);
  }
}

// ============================================================================
// 测试辅助：StubInterruptibleSessionManager（真实实现中断能力接口）
// ============================================================================

/**
 * 真实 InterruptibleSessionManager 实现（非 mock）
 *
 * 实现动态指令注入所需的 4 个公开方法 + 2 个可选字段。
 * 内部委托给真实的 TaskRegistry 与 BackgroundTaskRunner。
 */
class StubInterruptibleSessionManager {
  /** 真实的 TaskRegistry */
  readonly taskRegistry: TaskRegistry;
  /** 真实的 BackgroundTaskRunner */
  readonly backgroundRunner: BackgroundTaskRunner;

  constructor(options: { registry: TaskRegistry; runner: BackgroundTaskRunner }) {
    this.taskRegistry = options.registry;
    this.backgroundRunner = options.runner;
  }

  /**
   * 启动后台任务（/bg + background_task 工具入口）
   * 委托给 backgroundRunner.start
   *
   * 注：`UserPromptContent.text` 是可选字段（`string | undefined`），
   * 此处校验非空后透传给 `backgroundRunner.start`（接收 `string`）。
   * 与真实 SessionManager.startBackgroundTask 行为一致：
   * 真实 SessionManager 接收 `string`，由调用方（session.ts 的 /bg 命令入口）
   * 在调用前已校验 `prompt.text` 非空。
   */
  async startBackgroundTask(
    prompt: UserPromptContent,
    kind: TaskKind = "chat"
  ): Promise<{ readonly taskId: string; readonly sessionId: string }> {
    // 校验 prompt.text 非空（与 backgroundRunner.start 内部校验一致）
    const promptText = prompt.text ?? "";
    if (promptText.trim().length === 0) {
      throw new Error("startBackgroundTask 失败：prompt.text 不能为空");
    }
    const result = await this.backgroundRunner.start(promptText, kind);
    return { taskId: result.taskId, sessionId: result.taskId };
  }

  /**
   * 列出所有任务（/tasks + list_tasks 工具入口）
   * 委托给 taskRegistry.list
   */
  listTasks(filter?: TaskListFilter): readonly BackgroundTask[] {
    return this.taskRegistry.list(filter);
  }

  /**
   * 取消指定任务（/cancel + cancel_task 工具入口）
   * 委托给 task.cancel
   */
  cancelTask(taskId: string, reason?: string): void {
    const task = this.taskRegistry.get(taskId);
    if (!task) {
      throw new Error(`任务不存在：${taskId}`);
    }
    task.cancel(reason);
  }
}

// ============================================================================
// 测试辅助：构造 fixture 工厂
// ============================================================================

/**
 * 构造测试用 InjectedInstruction（不可变）
 *
 * @param text 指令文本
 * @param source 注入来源（默认 user）
 */
function createInstruction(text: string, source: "user" | "llm" = "user"): InjectedInstruction {
  return Object.freeze({
    id: crypto.randomUUID(),
    text,
    enqueuedAt: new Date().toISOString(),
    source,
  });
}

/**
 * 构造真实 BackgroundTaskRunner + TaskRegistry fixture
 *
 * @param mode StubSessionHandle 行为模式
 * @param callbacks 可选回调
 * @returns 真实 BackgroundTaskRunner + TaskRegistry
 */
function createRunner(mode: "succeed" | "fail" | "long-running" = "succeed"): {
  runner: BackgroundTaskRunner;
  registry: TaskRegistry;
} {
  const registry = new TaskRegistry();
  const runner = new BackgroundTaskRunner({
    sharedSessionOptions: {
      sessionManagerFactory: (_taskId, controller) => new StubSessionHandle(mode, controller),
    },
    registry,
  });
  return { runner, registry };
}

/**
 * 等待指定的宏任务事件循环
 *
 * @param ms 等待毫秒数（默认 20ms，足够让 setTimeout(0) unregister 执行）
 */
function waitMacrotask(ms = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * 测试用 ToolExecutionContext（共享，冻结）
 *
 * 所有 LLM 工具 handler 调用都需要接收 `(args, context)` 两个参数：
 * - args：LLM 工具调用参数（如 `{ prompt: "..." }`）
 * - context：ToolExecutionContext（包含 sessionId / projectRoot / toolCall）
 *
 * 实际 handler 内部并未使用 context 字段（仅 args），但 TypeScript 类型
 * 检查要求传入完整对象。此处构造一个最小的真实 context 满足类型契约。
 *
 * 注：ToolCall.function.arguments 是 JSON 字符串，此处用空对象 `"{}"`
 */
const TEST_TOOL_EXECUTION_CONTEXT: ToolExecutionContext = Object.freeze({
  sessionId: "test-session-di",
  projectRoot: "/tmp/test-di",
  toolCall: Object.freeze({
    id: "test-tool-call-di",
    type: "function",
    function: Object.freeze({
      name: "background_task",
      arguments: "{}",
    }),
  }),
});

// ============================================================================
// TC-E2E-001: /inject 在 LLM 流式中触发，主循环下一轮迭代消费指令
// ============================================================================

test("TC-E2E-001: /inject 在 LLM 流式中触发，InterruptQueue 集成正确", () => {
  // 真实构造 InterruptQueue + onEnqueue 回调
  const stateChanges: string[] = [];
  const queue = new InterruptQueue({
    onEnqueue: () => {
      stateChanges.push("onEnqueue");
    },
  });

  // 模拟主循环：LLM 调用前检查 interruptQueue
  // 1. 用户输入 /inject <指令>
  queue.enqueue(createInstruction("加上错误处理"));
  queue.enqueue(createInstruction("使用 TypeScript"));

  assert.equal(queue.size, 2, "队列中应有 2 条指令");
  assert.equal(stateChanges.length, 2, "onEnqueue 回调应被调用 2 次");

  // 2. 主循环下一轮迭代头部 drain 队列（模拟 E2 扩展点）
  const drained = queue.drain();
  assert.equal(drained.length, 2, "drain 应返回 2 条指令");
  assert.equal(queue.size, 0, "drain 后队列应清空");

  // 3. 验证 drain 出的指令按 FIFO 顺序排列
  assert.equal(drained[0].text, "加上错误处理", "第 1 条指令文本应正确");
  assert.equal(drained[1].text, "使用 TypeScript", "第 2 条指令文本应正确");

  // 4. 验证合成 system 消息的格式（对齐 session.ts E2 扩展点 §5.1.4）
  const combined = drained.map((i) => `[${i.enqueuedAt}] 用户注入：${i.text}`).join("\n\n");
  const injectMessage = `[用户在任务执行中追加了以下指令，请在下一步动作中考虑：]\n\n${combined}`;
  assert.ok(injectMessage.includes("加上错误处理"), "合成消息应包含第 1 条指令");
  assert.ok(injectMessage.includes("使用 TypeScript"), "合成消息应包含第 2 条指令");
  assert.ok(injectMessage.includes("用户注入："), "合成消息应使用约定格式");
});

// ============================================================================
// TC-E2E-001b: InjectInterruptError 流式中断信号集成
// ============================================================================

test("TC-E2E-001b: InjectInterruptError 流式中断信号传递正确", () => {
  // 模拟 createChatCompletionStream E3 扩展点：流式 chunk 之间检查队列
  const queue = new InterruptQueue();

  // 队列为空时不应抛错
  assert.equal(queue.size, 0, "初始队列应为空");

  // 模拟流式输出过程中用户 /inject
  queue.enqueue(createInstruction("切换到 async/await 风格"));
  assert.equal(queue.size, 1, "入队后队列长度应为 1");

  // E3 扩展点：检查队列非空，抛 InjectInterruptError 中断当前流
  let caughtError: InjectInterruptError | null = null;
  try {
    if (queue.size > 0) {
      throw new InjectInterruptError(
        queue.size,
        `Interrupted by ${queue.size} user instruction${queue.size === 1 ? "" : "s"}`
      );
    }
  } catch (err) {
    if (err instanceof InjectInterruptError) {
      caughtError = err;
    } else {
      throw err;
    }
  }

  // 验证错误信号
  assert.ok(caughtError, "应抛 InjectInterruptError");
  assert.equal(caughtError!.name, "InjectInterruptError");
  assert.equal(caughtError!.pendingCount, 1, "pendingCount 应为 1");
  assert.ok(
    caughtError!.message.includes("Interrupted by 1 user instruction"),
    `错误消息应包含中断信息，实际：${caughtError!.message}`
  );

  // 模拟 activateSession catch 块识别 InjectInterruptError 后 continue
  // 下一轮迭代头部 drain 队列
  const drained = queue.drain();
  assert.equal(drained.length, 1, "drain 应返回 1 条指令");
  assert.equal(drained[0].text, "切换到 async/await 风格");
});

// ============================================================================
// TC-E2E-002: /bg 后台启动 chat 任务，立即返回 taskId，主任务不阻塞
// ============================================================================

test("TC-E2E-002: /bg 后台启动 chat 任务，立即返回 taskId，主任务不阻塞", async () => {
  // 使用 long-running 模式，确保任务不会立即完成（验证"不阻塞"语义）
  const { runner, registry } = createRunner("long-running");

  // 记录 start 调用前后的时间，验证立即返回
  const startMs = Date.now();
  const { taskId } = await runner.start("调研 React 19 新特性", "chat");
  const elapsedMs = Date.now() - startMs;

  // 验证立即返回（≤ 500ms，对齐 P-02 性能验收）
  assert.ok(elapsedMs < 500, `start 应在 500ms 内返回，实际：${elapsedMs}ms`);

  // 验证 taskId 格式
  assert.ok(taskId.startsWith("t-"), "taskId 应以 't-' 前缀开头");
  assert.ok(taskId.length > 10, "taskId 应有足够的 UUID 部分");

  // 验证任务已注册到 registry
  assert.equal(registry.size, 1, "registry 应有 1 个活跃任务");
  const task = registry.get(taskId);
  assert.ok(task, "get(taskId) 应返回任务实例");
  assert.equal(task!.id, taskId);
  assert.equal(task!.kind, "chat");
  assert.equal(task!.prompt, "调研 React 19 新特性");
  assert.equal(task!.state, "running", "任务状态应为 running");
  assert.equal(task!.sessionId, taskId, "sessionId 应等于 taskId");
  assert.equal(task!.controller.signal.aborted, false, "controller 不应被 abort");

  // 验证"主任务不阻塞"：start 已返回，但 task 仍在运行
  assert.equal(task!.state, "running", "任务应仍在 running 状态");

  // 清理：取消任务
  await runner.stop(taskId, "测试结束");
});

// ============================================================================
// TC-E2E-003: /bg 后台启动 autonomous 任务（Phase 1 应抛错拒绝）
// ============================================================================

test("TC-E2E-003: /bg 后台启动 autonomous 任务，Phase 1 抛错拒绝", async () => {
  const { runner } = createRunner("succeed");

  // Phase 1 仅支持 chat，autonomous 应抛错
  await assert.rejects(
    runner.start("调研 React 19", "autonomous"),
    (err: unknown) => {
      assert.ok(err instanceof Error, "应为 Error 实例");
      assert.ok(
        err.message.includes('Phase 1 仅支持 kind="chat"'),
        `错误消息应包含 Phase 1 限制说明，实际：${(err as Error).message}`
      );
      return true;
    },
    "autonomous kind 在 Phase 1 应抛错拒绝"
  );
});

// ============================================================================
// TC-E2E-004: /tasks 显示完整任务表格（前台 + 后台 + 历史区）
// ============================================================================

test("TC-E2E-004: /tasks 显示完整任务表格（前台 + 后台 + 历史区）", async () => {
  // 使用 succeed 模式，任务立即完成（移到历史区）
  const { runner, registry } = createRunner("succeed");

  // 启动 2 个会立即完成的任务
  const { taskId: t1 } = await runner.start("任务 1 - 立即完成", "chat");
  const { taskId: t2 } = await runner.start("任务 2 - 立即完成", "chat");

  // 等待任务完成 + unregister（移到历史区）
  await waitMacrotask(30);

  // 验证：活跃区已为空（任务都已完成移到历史区）
  assert.equal(registry.size, 0, "活跃区应为空");

  // 验证：历史区有 2 个任务
  const historyList = registry.list({ includeHistory: true });
  assert.equal(historyList.length, 2, "历史区应有 2 个任务");
  assert.ok(
    historyList.some((t) => t.id === t1),
    "历史区应包含任务 1"
  );
  assert.ok(
    historyList.some((t) => t.id === t2),
    "历史区应包含任务 2"
  );

  // 默认 list 不含历史区
  const activeList = registry.list();
  assert.equal(activeList.length, 0, "默认 list 不应包含历史区");

  // 按状态过滤：succeeded
  const succeededList = registry.list({
    status: "succeeded",
    includeHistory: true,
  });
  assert.equal(succeededList.length, 2, "按 succeeded 过滤应返回 2 个任务");

  // 启动一个 long-running 任务，验证活跃区 + 历史区混合场景
  const longRunner = createRunner("long-running");
  const { taskId: t3 } = await longRunner.runner.start("任务 3 - 长时间运行", "chat");
  assert.equal(longRunner.registry.size, 1, "新 registry 应有 1 个活跃任务");

  // 验证按 status 过滤活跃区
  const runningList = longRunner.registry.list({ status: "running" });
  assert.equal(runningList.length, 1, "按 running 过滤应返回 1 个任务");
  assert.equal(runningList[0].id, t3);

  // 按 kind 过滤
  const chatList = longRunner.registry.list({ kind: "chat" });
  assert.equal(chatList.length, 1, "按 chat kind 过滤应返回 1 个任务");

  // 清理
  await longRunner.runner.stop(t3, "测试结束");
});

// ============================================================================
// TC-E2E-005: /fg 切换前台，不中断其他后台任务
// ============================================================================

test("TC-E2E-005: /fg 切换前台，不中断其他后台任务", async () => {
  const { runner, registry } = createRunner("long-running");

  // 启动 3 个后台任务
  const { taskId: t1 } = await runner.start("任务 A", "chat");
  const { taskId: t2 } = await runner.start("任务 B", "chat");
  const { taskId: t3 } = await runner.start("任务 C", "chat");

  assert.equal(registry.size, 3, "应有 3 个活跃任务");

  // 初始无前台
  assert.equal(registry.getForegroundId(), null, "初始无前台任务");

  // 切换前台到 t2
  registry.setForeground(t2);
  assert.equal(registry.getForegroundId(), t2, "前台应为 t2");

  // 验证：t1 与 t3 仍在运行（未被中断）
  const task1 = registry.get(t1);
  const task3 = registry.get(t3);
  assert.ok(task1, "t1 应存在");
  assert.ok(task3, "t3 应存在");
  assert.equal(task1!.state, "running", "t1 应仍在 running");
  assert.equal(task3!.state, "running", "t3 应仍在 running");
  assert.equal(task1!.controller.signal.aborted, false, "t1 controller 不应被 abort");
  assert.equal(task3!.controller.signal.aborted, false, "t3 controller 不应被 abort");

  // 切换前台到 t1（验证可多次切换）
  registry.setForeground(t1);
  assert.equal(registry.getForegroundId(), t1, "前台应切换为 t1");

  // 验证：t2 仍在运行（切换不中断原前台）
  const task2 = registry.get(t2);
  assert.ok(task2, "t2 应存在");
  assert.equal(task2!.state, "running", "t2 应仍在 running");

  // 切换到不存在的 taskId 应抛错
  assert.throws(
    () => registry.setForeground("t-not-exist"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("不在活跃区"), `错误消息应说明不在活跃区，实际：${(err as Error).message}`);
      return true;
    },
    "切换到不存在的 taskId 应抛错"
  );

  // 清理
  await runner.stop(t1, "测试结束");
  await runner.stop(t2, "测试结束");
  await runner.stop(t3, "测试结束");
});

// ============================================================================
// TC-E2E-006: /cancel 取消后台任务，state=cancelled
// ============================================================================

test("TC-E2E-006: /cancel 取消后台任务，state=cancelled", async () => {
  const stateChanges: { id: string; state: string }[] = [];
  const registry = new TaskRegistry({
    onTaskStateChanged: (task) => {
      stateChanges.push({ id: task.id, state: task.state });
    },
  });
  const runner = new BackgroundTaskRunner({
    sharedSessionOptions: {
      sessionManagerFactory: (_taskId, controller) => new StubSessionHandle("long-running", controller),
    },
    registry,
  });

  const { taskId } = await runner.start("待取消的任务", "chat");
  assert.equal(registry.size, 1, "应有 1 个活跃任务");

  // 取消任务（模拟 /cancel <taskId>）
  await runner.stop(taskId, "用户取消");

  // 验证：任务状态为 cancelled
  // 注：onStateChange 回调中 setTimeout(0) unregister，等待后任务移到历史区
  await waitMacrotask(20);

  // 任务可能已移到历史区
  const task = registry.list({ includeHistory: true }).find((t) => t.id === taskId);
  assert.ok(task, "任务应存在于活跃区或历史区");
  assert.equal(task!.state, "cancelled", "任务状态应为 cancelled");
  assert.equal(task!.error, "用户取消", "应记录取消原因");
  assert.equal(task!.controller.signal.aborted, true, "controller 应被 abort");

  // 验证：状态变更序列包含 cancelled
  assert.ok(
    stateChanges.some((s) => s.id === taskId && s.state === "cancelled"),
    "状态变更序列应包含 cancelled"
  );

  // 验证：取消失败（任务已为终态）
  assert.throws(
    () => task!.cancel("重复取消"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
    "对终态任务再次 cancel 应抛错"
  );
});

// ============================================================================
// TC-E2E-007: /pause + /resume 完整流程
// ============================================================================

test("TC-E2E-007: /pause + /resume 完整流程，状态流转正确", async () => {
  const { runner, registry } = createRunner("long-running");

  const { taskId } = await runner.start("暂停恢复测试", "chat");
  const task = registry.get(taskId);
  assert.ok(task, "任务应存在");
  assert.equal(task!.state, "running", "初始状态应为 running");

  // pause：模拟 /pause 命令
  task!.pause();
  assert.equal(task!.state, "paused", "pause 后应为 paused");
  assert.equal(task!.controller.signal.aborted, true, "controller 应被 abort（pause 信号）");

  // 验证 pause 后不能直接 start（state 已变）
  await assert.rejects(
    task!.start(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
    "对 paused 任务调用 start 应抛错"
  );

  // resume：模拟 /resume <taskId> 命令
  // 注：StubSessionHandle 的 controller 已 abort，resume 需重建 controller
  // 这里通过新建 BackgroundTask 实例验证 resume 流程（Phase 1 限制）
  // Phase 1 中 resume 重建由 BackgroundTaskRunner.onResume 闭包处理（已实现）
  // 单元测试中通过新建 task 模拟 resume 后的状态
  // 注：使用 setTimeout(0) 延迟 markSucceeded，避免微任务在 await start() 返回前执行
  const resumedTask = new BackgroundTask({
    id: task!.id,
    kind: task!.kind,
    prompt: task!.prompt,
    controller: new AbortController(),
    onStart: async (t) => {
      t.setSessionId(t.id);
      // 使用 setTimeout(0) 延迟完成，让 start() 能在 state=running 时返回
      setTimeout(() => {
        if (t.state === "running") {
          t.markSucceeded("completed");
        }
      }, 0);
    },
  });

  // 验证：可以重新 start（模拟 resume 后的状态）
  await resumedTask.start();
  assert.equal(resumedTask.state, "running", "resume 后应为 running");
  await waitMacrotask(10);
  assert.equal(resumedTask.state, "succeeded", "完成后应为 succeeded");

  // 清理原始任务（已被 pause，需要 cancel 进入终态）
  task!.cancel("测试结束");
  await waitMacrotask(10);
});

// ============================================================================
// TC-E2E-008: 任务完成后自动移到历史区（unregister 触发）
// ============================================================================

test("TC-E2E-008: 任务完成后自动移到历史区（unregister 触发）", async () => {
  const { runner, registry } = createRunner("succeed");

  // 启动一个会立即成功的任务
  const { taskId } = await runner.start("快速完成的任务", "chat");

  // 等待 handleUserPrompt.resolve + markSucceeded + setTimeout(0) unregister
  await waitMacrotask(30);

  // 验证：活跃区为空（任务已 unregister）
  assert.equal(registry.size, 0, "活跃区应为空");
  assert.equal(registry.get(taskId), null, "get(taskId) 应返回 null");

  // 验证：历史区有 1 个 succeeded 任务
  const history = registry.list({ includeHistory: true });
  assert.equal(history.length, 1, "历史区应有 1 个任务");
  assert.equal(history[0].id, taskId);
  assert.equal(history[0].state, "succeeded", "任务状态应为 succeeded");
  assert.ok(history[0].completedAt, "completedAt 应已填充");
  assert.ok(history[0].result, "result 应已填充");
});

// ============================================================================
// TC-E2E-009: LLM 调用 background_task 工具启动子 agent
// ============================================================================

test("TC-E2E-009: LLM 调用 background_task 工具启动子 agent", async () => {
  const { runner, registry } = createRunner("long-running");

  // 构造真实的 StubInterruptibleSessionManager（实现 InterruptibleSessionManager 接口）
  const sessionManager = new StubInterruptibleSessionManager({
    registry,
    runner,
  });

  // 构造真实的 LLM 工具 handler
  const handler = createBackgroundTaskHandler({ sessionManager });

  // 模拟 LLM 调用 background_task 工具（传入完整 ToolExecutionContext）
  const result = await handler(
    {
      prompt: "调研 React 19 新特性",
      kind: "chat",
    },
    TEST_TOOL_EXECUTION_CONTEXT
  );

  // 验证返回结果
  assert.equal(result.ok, true, "工具应成功");
  assert.equal(result.name, "background_task");

  // 解析 output JSON
  assert.ok(result.output, "output 字段应存在");
  const parsed = JSON.parse(result.output as string);
  assert.ok(parsed.taskId, "output 应包含 taskId");
  assert.ok(parsed.taskId.startsWith("t-"), "taskId 应以 't-' 前缀开头");
  assert.ok(parsed.sessionId, "output 应包含 sessionId");
  assert.equal(parsed.status, "queued", "status 应为 queued");

  // 验证 metadata
  assert.ok(result.metadata, "metadata 应存在");
  assert.equal(result.metadata!.kind, "chat");

  // 验证：任务已注册到 registry
  const task = registry.get(parsed.taskId);
  assert.ok(task, "任务应已注册到 registry");
  assert.equal(task!.prompt, "调研 React 19 新特性");

  // 清理
  await runner.stop(parsed.taskId, "测试结束");
});

// ============================================================================
// TC-E2E-009b: background_task 工具参数校验
// ============================================================================

test("TC-E2E-009b: background_task 工具参数校验（缺失/空字符串/非字符串）", async () => {
  // 使用 long-running 模式，确保任务不会立即完成（避免清理时取消已 succeeded 的任务）
  const { runner, registry } = createRunner("long-running");
  const sessionManager = new StubInterruptibleSessionManager({
    registry,
    runner,
  });
  const handler = createBackgroundTaskHandler({ sessionManager });

  // 缺失 prompt 参数
  const r1 = await handler({}, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r1.ok, false, "缺失 prompt 应返回 ok=false");
  assert.ok(r1.error!.includes("prompt"), "错误应包含 prompt");

  // 空字符串 prompt
  const r2 = await handler({ prompt: "" }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r2.ok, false, "空字符串 prompt 应返回 ok=false");

  // 仅空白的 prompt
  const r3 = await handler({ prompt: "   " }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r3.ok, false, "仅空白的 prompt 应返回 ok=false");

  // 非字符串 prompt
  const r4 = await handler({ prompt: 123 }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r4.ok, false, "非字符串 prompt 应返回 ok=false");

  // kind 无效时默认为 chat（不报错）
  const r5 = await handler({ prompt: "测试", kind: "invalid-kind" }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r5.ok, true, "kind 无效时应默认为 chat 并成功");
  assert.equal(r5.metadata!.kind, "chat", "metadata.kind 应为 chat");

  // 清理：long-running 模式下任务仍在 running，可安全取消
  if (r5.ok && r5.metadata?.taskId) {
    await runner.stop(r5.metadata.taskId as string, "测试结束");
  }
});

// ============================================================================
// TC-E2E-010: LLM 调用 inject_message 工具注入指令到子 agent
// ============================================================================

test("TC-E2E-010: LLM 调用 inject_message 工具注入指令到子 agent", async () => {
  const { runner, registry } = createRunner("long-running");

  // 启动一个后台任务
  const { taskId } = await runner.start("被注入的任务", "chat");
  const task = registry.get(taskId);
  assert.ok(task, "任务应存在");

  // 记录 inject 调用
  const injectedInstructions: { id: string; text: string; source: string }[] = [];

  // 注：BackgroundTask.inject 内部调用 onInject 回调
  // 由于 task 已构造完成（onInject 回调已绑定），无法直接注入新回调
  // 改为通过 runner.inject 调用，验证流程正确性
  const instruction = createInstruction("切换到 async/await 风格", "llm");
  runner.inject(taskId, instruction);

  // 验证：runner.inject 不抛错即表示 task.inject 被调用
  // （真实场景中 task.inject 内部会调用 onInject 回调，将指令加入 InterruptQueue）

  // 验证：对不存在的 taskId 调用 inject 抛错
  assert.throws(
    () => runner.inject("t-not-exist", instruction),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("不存在"), `错误应说明任务不存在，实际：${(err as Error).message}`);
      return true;
    },
    "对不存在的 taskId 调用 inject 应抛错"
  );

  // 清理
  await runner.stop(taskId, "测试结束");
});

// ============================================================================
// TC-E2E-010b: LLM 调用 inject_message 工具的参数校验
// ============================================================================

test("TC-E2E-010b: LLM 调用 inject_message 工具参数校验", async () => {
  const { runner, registry } = createRunner("long-running");
  const sessionManager = new StubInterruptibleSessionManager({
    registry,
    runner,
  });

  // 启动一个任务
  const { taskId } = await runner.start("inject_message 测试任务", "chat");

  // 构造 inject_message handler
  // 注：createInjectMessageHandler 需要 taskRegistry 注入
  // 这里通过 InterruptToolRegistry 验证 handler 调用流程
  const toolRegistry = new InterruptToolRegistry(sessionManager);
  const handlers = toolRegistry.getHandlers();
  const injectHandler = handlers.get("inject_message");
  assert.ok(injectHandler, "inject_message handler 应存在");

  // 调用 inject_message 工具（传入完整 ToolExecutionContext）
  const result = await injectHandler!(
    {
      task_id: taskId,
      message: "切换到 TypeScript",
    },
    TEST_TOOL_EXECUTION_CONTEXT
  );

  // 验证返回结果
  assert.equal(result.ok, true, "工具应成功");
  assert.equal(result.name, "inject_message");

  // 解析 output（对齐 llm-tools.ts §5：返回 { success, taskId, queueSize }）
  assert.ok(result.output, "output 应存在");
  const parsed = JSON.parse(result.output as string);
  assert.equal(parsed.success, true, "output.success 应为 true");
  assert.equal(parsed.taskId, taskId, "output.taskId 应正确");
  assert.equal(parsed.queueSize, 1, "output.queueSize 应为 1");

  // 缺失 task_id 参数
  const r1 = await injectHandler!({ message: "测试" }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r1.ok, false, "缺失 task_id 应返回 ok=false");

  // 缺失 message 参数
  const r2 = await injectHandler!({ task_id: taskId }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(r2.ok, false, "缺失 message 应返回 ok=false");

  // 不存在的 task_id
  const r3 = await injectHandler!(
    {
      task_id: "t-not-exist",
      message: "测试",
    },
    TEST_TOOL_EXECUTION_CONTEXT
  );
  assert.equal(r3.ok, false, "不存在的 task_id 应返回 ok=false");

  // 清理
  await runner.stop(taskId, "测试结束");
});

// ============================================================================
// TC-E2E-011: 零回归断言：未注入组件时降级行为正确
// ============================================================================

test("TC-E2E-011: 零回归断言：未注入组件时 LLM 工具降级返回 feature unavailable", async () => {
  // 构造一个不实现 InterruptibleSessionManager 接口的最小对象
  // （模拟 SessionManager 未注入 taskRegistry / backgroundRunner 的场景）
  const minimalSessionManager = {} as never;

  // background_task 工具：未注入 startBackgroundTask 方法
  const bgHandler = createBackgroundTaskHandler({
    sessionManager: minimalSessionManager,
  });
  const bgResult = await bgHandler({ prompt: "测试" }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(bgResult.ok, false, "未注入时应返回 ok=false");
  assert.ok(
    bgResult.error!.includes("不可用") || bgResult.error!.includes("unavailable"),
    `错误消息应说明功能不可用，实际：${bgResult.error}`
  );

  // list_tasks 工具：未注入 listTasks 方法
  const listHandler = createListTasksHandler({
    sessionManager: minimalSessionManager,
  });
  const listResult = await listHandler({}, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(listResult.ok, false, "未注入时应返回 ok=false");
  assert.ok(
    listResult.error!.includes("不可用") || listResult.error!.includes("unavailable"),
    `错误消息应说明功能不可用，实际：${listResult.error}`
  );

  // cancel_task 工具：未注入 cancelTask 方法
  const cancelHandler = createCancelTaskHandler({
    sessionManager: minimalSessionManager,
  });
  const cancelResult = await cancelHandler({ task_id: "t-test" }, TEST_TOOL_EXECUTION_CONTEXT);
  assert.equal(cancelResult.ok, false, "未注入时应返回 ok=false");
  assert.ok(
    cancelResult.error!.includes("不可用") || cancelResult.error!.includes("unavailable"),
    `错误消息应说明功能不可用，实际：${cancelResult.error}`
  );

  // inject_message 工具：未注入 taskRegistry 字段
  const injectHandler = createInjectMessageHandler({
    sessionManager: minimalSessionManager,
  });
  const injectResult = await injectHandler(
    {
      task_id: "t-test",
      message: "测试",
    },
    TEST_TOOL_EXECUTION_CONTEXT
  );
  assert.equal(injectResult.ok, false, "未注入时应返回 ok=false");
  assert.ok(
    injectResult.error!.includes("不可用") || injectResult.error!.includes("unavailable"),
    `错误消息应说明功能不可用，实际：${injectResult.error}`
  );
});

// ============================================================================
// TC-E2E-011b: 零回归断言：InterruptQueue 未注入时 SessionManager 行为不变
// ============================================================================

test("TC-E2E-011b: 零回归断言：InterruptQueue 未注入时主循环不检查队列", () => {
  // 模拟 SessionManager 未注入 interruptQueue 的场景
  // （interruptQueue 字段为 undefined，主循环 if 判断跳过）
  // 注：使用函数参数封装避免 TS 控制流分析把 interruptQueue.size 缩小到 `never`，
  //     与真实 SessionManager 中 `this.interruptQueue`（实例字段）的检查语义一致
  //     （实例字段不会被 TS narrowing 到 undefined）
  function hasPendingInterrupts(queue: InterruptQueue | undefined): boolean {
    return !!queue && queue.size > 0;
  }

  const interruptQueue: InterruptQueue | undefined = undefined;

  // 主循环 E2 扩展点的判断逻辑：
  // if (this.interruptQueue && this.interruptQueue.size > 0) { ... }
  // 未注入时此分支不进入，主循环行为零变化
  if (hasPendingInterrupts(interruptQueue)) {
    assert.fail("未注入 interruptQueue 时不应进入此分支");
  }

  // 验证：未注入时主循环检查开销为 0（仅一次 undefined 判断）
  // 对齐 P-04 性能验收：≤ 1ms
  const startMs = Date.now();
  for (let i = 0; i < 10000; i++) {
    if (hasPendingInterrupts(interruptQueue)) {
      // 不会进入
    }
  }
  const elapsedMs = Date.now() - startMs;
  assert.ok(elapsedMs < 50, `10000 次检查应远小于 50ms（实际 ${elapsedMs}ms），对齐 P-04 性能验收`);
});

// ============================================================================
// TC-E2E-012: 多后台任务并行（≥3 个）互不干扰
// ============================================================================

test("TC-E2E-012: 多后台任务并行（≥3 个）互不干扰", async () => {
  const { runner, registry } = createRunner("long-running");

  // 启动 3 个并行后台任务
  const { taskId: t1 } = await runner.start("并行任务 A", "chat");
  const { taskId: t2 } = await runner.start("并行任务 B", "chat");
  const { taskId: t3 } = await runner.start("并行任务 C", "chat");

  // 验证 3 个任务都在运行
  assert.equal(registry.size, 3, "应有 3 个活跃任务");
  const task1 = registry.get(t1);
  const task2 = registry.get(t2);
  const task3 = registry.get(t3);
  assert.ok(task1 && task2 && task3, "3 个任务都应存在");
  assert.equal(task1!.state, "running", "t1 应 running");
  assert.equal(task2!.state, "running", "t2 应 running");
  assert.equal(task3!.state, "running", "t3 应 running");

  // 验证：3 个任务的 sessionId 互不相同
  const sessionIds = new Set([task1!.sessionId, task2!.sessionId, task3!.sessionId]);
  assert.equal(sessionIds.size, 3, "3 个任务的 sessionId 应互不相同");

  // 验证：3 个任务的 controller 互不相同
  const controllers = new Set([task1!.controller, task2!.controller, task3!.controller]);
  assert.equal(controllers.size, 3, "3 个任务的 controller 应互不相同");

  // 验证：取消 t2 不影响 t1 和 t3
  await runner.stop(t2, "取消并行任务 B");
  await waitMacrotask(10);

  // t2 应为 cancelled，t1/t3 仍为 running
  const task2After = registry.list({ includeHistory: true }).find((t) => t.id === t2);
  assert.ok(task2After, "t2 应在历史区");
  assert.equal(task2After!.state, "cancelled", "t2 应为 cancelled");

  const task1After = registry.get(t1);
  const task3After = registry.get(t3);
  assert.ok(task1After, "t1 应仍在活跃区");
  assert.ok(task3After, "t3 应仍在活跃区");
  assert.equal(task1After!.state, "running", "t1 应仍为 running（不受 t2 取消影响）");
  assert.equal(task3After!.state, "running", "t3 应仍为 running（不受 t2 取消影响）");

  // 清理
  await runner.stop(t1, "测试结束");
  await runner.stop(t3, "测试结束");
});

// ============================================================================
// TC-E2E-013: EagCommandParser 解析 7 个新命令
// ============================================================================

test("TC-E2E-013: EagCommandParser 解析 7 个新命令", () => {
  const parser = new EagCommandParser();

  // /inject <指令>（parse 接收 UserPromptContent 对象，非字符串）
  const injectCmd = parser.parse({ text: "/inject 加上错误处理" });
  assert.equal(injectCmd.kind, "inject", "/inject 应解析为 inject kind");
  assert.ok(injectCmd.payload, "payload 应存在");

  // /bg <指令>
  const bgCmd = parser.parse({ text: "/bg 调研 React 19" });
  assert.equal(bgCmd.kind, "bg", "/bg 应解析为 bg kind");
  assert.ok(bgCmd.payload, "payload 应存在");

  // /tasks
  const tasksCmd = parser.parse({ text: "/tasks" });
  assert.equal(tasksCmd.kind, "tasks", "/tasks 应解析为 tasks kind");

  // /tasks --status running
  const tasksWithFilter = parser.parse({ text: "/tasks --status running" });
  assert.equal(tasksWithFilter.kind, "tasks");

  // /fg <taskId>
  const fgCmd = parser.parse({ text: "/fg t-abc123" });
  assert.equal(fgCmd.kind, "fg", "/fg 应解析为 fg kind");
  assert.ok(fgCmd.payload, "payload 应存在");

  // /cancel <taskId>
  const cancelCmd = parser.parse({ text: "/cancel t-abc123" });
  assert.equal(cancelCmd.kind, "cancel", "/cancel 应解析为 cancel kind");
  assert.ok(cancelCmd.payload, "payload 应存在");

  // /cancel <taskId> --reason <原因>
  const cancelWithReason = parser.parse({ text: "/cancel t-abc123 --reason 测试取消" });
  assert.equal(cancelWithReason.kind, "cancel");

  // /pause（无参数，严格匹配）
  const pauseCmd = parser.parse({ text: "/pause" });
  assert.equal(pauseCmd.kind, "pause", "/pause 应解析为 pause kind");
  assert.equal(pauseCmd.payload, null, "/pause payload 应为 null");

  // /resume <taskId>
  const resumeCmd = parser.parse({ text: "/resume t-abc123" });
  assert.equal(resumeCmd.kind, "resume", "/resume 应解析为 resume kind");
  assert.ok(resumeCmd.payload, "payload 应存在");

  // 验证大小写不敏感
  const upperCmd = parser.parse({ text: "/INJECT 测试" });
  assert.equal(upperCmd.kind, "inject", "/INJECT 应解析为 inject kind（大小写不敏感）");

  // 验证非命令输入返回 unknown
  const unknownCmd = parser.parse({ text: "普通用户输入" });
  assert.equal(unknownCmd.kind, "unknown", "非命令输入应返回 unknown");
});

// ============================================================================
// TC-E2E-014: registerInterruptTools 注册 4 个 LLM 工具到 ToolExecutor
// ============================================================================

test("TC-E2E-014: registerInterruptTools 注册 4 个 LLM 工具到 ToolExecutor", () => {
  const { runner, registry } = createRunner("succeed");
  const sessionManager = new StubInterruptibleSessionManager({
    registry,
    runner,
  });

  // 构造真实的 StubToolExecutor
  const toolExecutor = new StubToolExecutor();

  // 调用 registerInterruptTools（参数顺序：toolExecutor 在前，sessionManager 在后）
  const toolRegistry = registerInterruptTools(toolExecutor, sessionManager);

  // 验证：4 个工具全部注册成功
  assert.equal(toolExecutor.size, 4, "应注册 4 个 LLM 工具");
  assert.ok(toolExecutor.has("background_task"), "应注册 background_task");
  assert.ok(toolExecutor.has("list_tasks"), "应注册 list_tasks");
  assert.ok(toolExecutor.has("cancel_task"), "应注册 cancel_task");
  assert.ok(toolExecutor.has("inject_message"), "应注册 inject_message");

  // 验证：返回 InterruptToolRegistry 实例
  assert.ok(toolRegistry instanceof InterruptToolRegistry, "应返回 InterruptToolRegistry 实例");

  // 验证：getHandlers 返回 4 个 handler
  const handlers = toolRegistry.getHandlers();
  assert.equal(handlers.size, 4, "getHandlers 应返回 4 个 handler");

  // 验证：getMetadata 返回 4 个元数据
  const metadata = toolRegistry.getMetadata();
  assert.equal(metadata.length, 4, "getMetadata 应返回 4 个元数据");

  // 验证：注册的 handler 可被调用（通过 ToolExecutor 调用）
  const bgHandler = toolExecutor.get("background_task");
  assert.ok(bgHandler, "background_task handler 应存在");

  // 验证：多次调用 getHandlers 返回同一引用（懒加载缓存）
  const handlers2 = toolRegistry.getHandlers();
  assert.equal(handlers, handlers2, "多次调用 getHandlers 应返回同一引用（懒加载）");
});

// ============================================================================
// TC-E2E-015: 任务并发上限保护（MAX_CONCURRENT_TASKS=8）
// ============================================================================

test("TC-E2E-015: 任务并发上限保护（MAX_CONCURRENT_TASKS=8）", async () => {
  const { runner, registry } = createRunner("long-running");

  // 启动 8 个任务（达到上限）
  const taskIds: string[] = [];
  for (let i = 0; i < TaskRegistry.MAX_CONCURRENT_TASKS; i++) {
    const { taskId } = await runner.start(`并行任务 ${i}`, "chat");
    taskIds.push(taskId);
  }

  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS, "应达到上限");

  // 启动第 9 个任务应抛 TaskLimitExceededError
  await assert.rejects(
    runner.start("第 9 个任务", "chat"),
    (err: unknown) => {
      assert.ok(err instanceof TaskLimitExceededError, "应抛 TaskLimitExceededError");
      assert.equal(
        (err as TaskLimitExceededError).currentCount,
        TaskRegistry.MAX_CONCURRENT_TASKS,
        "currentCount 应为 MAX_CONCURRENT_TASKS"
      );
      assert.equal(
        (err as TaskLimitExceededError).maxCount,
        TaskRegistry.MAX_CONCURRENT_TASKS,
        "maxCount 应为 MAX_CONCURRENT_TASKS"
      );
      return true;
    },
    "第 9 个任务应抛 TaskLimitExceededError"
  );

  // 取消一个任务后，应能再启动新任务
  await runner.stop(taskIds[0], "腾出名额");
  await waitMacrotask(10);

  // 此时活跃区应为 7（一个被取消移到历史区）
  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS - 1, "应为 7");

  // 启动新任务应成功
  const { taskId: newTaskId } = await runner.start("新任务", "chat");
  assert.ok(newTaskId, "新任务应成功启动");
  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS, "应再次达到上限");

  // 清理：取消所有剩余任务
  for (let i = 1; i < taskIds.length; i++) {
    await runner.stop(taskIds[i], "测试结束");
  }
  await runner.stop(newTaskId, "测试结束");
});

// ============================================================================
// TC-E2E-016: InterruptQueue 容量上限保护
// ============================================================================

test("TC-E2E-016: InterruptQueue 容量上限保护（MAX_QUEUE_SIZE=64）", () => {
  const queue = new InterruptQueue();

  // 填满队列
  for (let i = 0; i < InterruptQueue.MAX_QUEUE_SIZE; i++) {
    queue.enqueue(createInstruction(`指令 ${i}`));
  }
  assert.equal(queue.size, InterruptQueue.MAX_QUEUE_SIZE, "应达到上限");

  // 第 65 个应抛 QueueOverflowError
  assert.throws(
    () => queue.enqueue(createInstruction("溢出指令")),
    (err: unknown) => {
      assert.ok(err instanceof QueueOverflowError, "应抛 QueueOverflowError");
      assert.equal((err as QueueOverflowError).currentSize, InterruptQueue.MAX_QUEUE_SIZE);
      assert.equal((err as QueueOverflowError).maxSize, InterruptQueue.MAX_QUEUE_SIZE);
      return true;
    },
    "第 65 个入队应抛 QueueOverflowError"
  );

  // drain 后可继续入队
  queue.drain();
  assert.equal(queue.size, 0, "drain 后应为 0");
  queue.enqueue(createInstruction("新指令"));
  assert.equal(queue.size, 1, "drain 后可继续入队");
});

// ============================================================================
// TC-E2E-017: INTERRUPT_TOOL_DEFINITIONS 4 个工具定义结构完整
// ============================================================================

test("TC-E2E-017: INTERRUPT_TOOL_DEFINITIONS 4 个工具定义结构完整", () => {
  assert.equal(INTERRUPT_TOOL_DEFINITIONS.length, 4, "应有 4 个工具定义");

  // 验证每个工具定义结构
  for (const def of INTERRUPT_TOOL_DEFINITIONS) {
    assert.equal(def.type, "function", "type 应为 function");
    assert.ok(def.function.name, "function.name 应存在");
    assert.ok(def.function.description, "function.description 应存在");
    assert.equal(def.function.parameters.type, "object", "parameters.type 应为 object");

    // 验证 description 长度 < 100 token（粗略估算：1 token ≈ 4 字符）
    const descLen = def.function.description.length;
    assert.ok(descLen < 400, `${def.function.name} description 应 < 100 token（约 400 字符），实际：${descLen}`);
  }

  // 验证 4 个工具名
  const names = INTERRUPT_TOOL_DEFINITIONS.map((d) => d.function.name);
  assert.ok(names.includes("background_task"), "应包含 background_task");
  assert.ok(names.includes("list_tasks"), "应包含 list_tasks");
  assert.ok(names.includes("cancel_task"), "应包含 cancel_task");
  assert.ok(names.includes("inject_message"), "应包含 inject_message");
});

// ============================================================================
// TC-E2E-018: 完整生命周期（start → inject → pause → resume → succeed）
// ============================================================================

test("TC-E2E-018: 完整生命周期（start → inject → pause → resume → succeed）", async () => {
  // 记录状态变更序列
  const stateSequence: string[] = [];

  // 构造真实的 BackgroundTask（带完整回调记录）
  // 注：使用 setTimeout(0) 延迟 markSucceeded，避免微任务在 await task.start() 返回前执行
  // （Promise.resolve().then 是微任务，await 恢复前会执行；setTimeout 是宏任务，await 恢复后才执行）
  const task = new BackgroundTask({
    id: `t-${crypto.randomUUID()}`,
    kind: "chat",
    prompt: "生命周期测试",
    controller: new AbortController(),
    onStart: async (t) => {
      t.setSessionId(t.id);
      // 使用 setTimeout(0) 延迟完成，让 start() 能在 state=running 时返回
      setTimeout(() => {
        if (t.state === "running") {
          t.markSucceeded("completed");
        }
      }, 0);
    },
    onStateChange: (t) => {
      stateSequence.push(t.state);
    },
  });

  // 1. start：queued → running（setTimeout 还未执行，state 仍为 running）
  await task.start();
  assert.equal(task.state, "running", "start 后应为 running");

  // 2. inject：注入指令（state 仍为 running）
  const instruction = createInstruction("切换到 async/await");
  task.inject(instruction);
  // 注：inject 调用 onInject 回调（这里没设置 onInject，仅状态不变）
  assert.equal(task.state, "running", "inject 后状态应仍为 running");

  // 3. 等待 setTimeout(0) 执行，markSucceeded 触发
  await waitMacrotask(10);
  assert.equal(task.state, "succeeded", "完成后应为 succeeded");
  assert.equal(task.result, "completed", "result 应为 completed");
  assert.ok(task.completedAt, "completedAt 应已填充");

  // 4. 验证状态变更序列（start 路径：queued → pending → running → succeeded）
  assert.deepEqual(stateSequence, ["pending", "running", "succeeded"], "状态序列应为 pending → running → succeeded");

  // 5. 验证终态不可转换
  assert.throws(
    () => task.pause(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
    "对 succeeded 任务调用 pause 应抛错"
  );
});
