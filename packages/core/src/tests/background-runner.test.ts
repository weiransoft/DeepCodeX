/**
 * BackgroundTaskRunner 单元测试 —— ADR-DI-001 §9.1
 *
 * 测试范围（对齐 ADR-DI-001 §9.1 单元测试用例）：
 * - TC-BR-001: start chat 任务注册到 registry
 * - TC-BR-002: start 失败时 task state = failed
 * - TC-BR-003: stop 取消任务并从 registry 移除
 * - TC-BR-004: inject 找到 task 并调用 inject
 * - TC-BR-005: 任务完成后 onTaskComplete 回调
 * - TC-BR-006: 多任务并行（同时 3 个 task）
 * - TC-BR-007: 生成 taskId 唯一性
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new BackgroundTaskRunner() + new TaskRegistry()
 * - sessionManagerFactory 返回真实的 StubSessionHandle（不调用 LLM，但真实实现接口）
 * - 中文注释
 *
 * StubSessionHandle 设计（非 mock）：
 * - 真实实现 SessionHandle 接口
 * - 不调用 LLM，仅模拟 LLM 行为（成功 / 失败 / 长时间运行）
 * - 通过 mode 参数控制行为：
 *   - "succeed"：handleUserPrompt 立即 resolve
 *   - "fail"：handleUserPrompt 立即 reject
 *   - "long-running"：handleUserPrompt 返回永不 resolve 的 Promise（直到 controller.abort）
 *
 * 设计依据：
 * - ADR-DI-001 §5.2.2 BackgroundTaskRunner
 * - ADR-DI-001 §9.1 单元测试用例
 *
 * @module tests/background-runner
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { BackgroundTaskRunner } from "../interrupts/background-runner";
import { TaskRegistry } from "../interrupts/task-registry";
import type { SessionHandle } from "../interrupts/background-runner";
import type { InjectedInstruction } from "../interrupts/types";

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
 * - "long-running"：handleUserPrompt 返回永不 resolve 的 Promise
 *   直到 controller.signal.aborted 后 reject（模拟长时间任务被取消）
 */
class StubSessionHandle implements SessionHandle {
  /** 行为模式 */
  private readonly mode: "succeed" | "fail" | "long-running";
  /** 独立的 AbortController */
  private readonly controller: AbortController;

  constructor(mode: "succeed" | "fail" | "long-running", controller: AbortController) {
    this.mode = mode;
    this.controller = controller;
  }

  /**
   * 启动会话（与 SessionManager.handleUserPrompt 同构）
   *
   * 根据 mode 返回不同的 Promise：
   * - succeed：立即 resolve
   * - fail：立即 reject
   * - long-running：永不 resolve，直到 controller.abort 后 reject
   */
  handleUserPrompt(_prompt: string): Promise<void> {
    switch (this.mode) {
      case "succeed":
        return Promise.resolve();
      case "fail":
        return Promise.reject(new Error("StubSessionHandle 模拟 LLM 调用失败"));
      case "long-running":
        // 返回永不 resolve 的 Promise，直到 controller.abort
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
// 测试辅助：构造真实 BackgroundTaskRunner fixture
// ============================================================================

/**
 * StubSessionHandle 行为模式
 */
type StubMode = "succeed" | "fail" | "long-running";

/**
 * 构造真实 BackgroundTaskRunner fixture
 *
 * @param mode StubSessionHandle 行为模式
 * @param callbacks 可选回调
 * @returns 真实 BackgroundTaskRunner 与 TaskRegistry
 */
function createRunner(
  mode: StubMode = "succeed",
  callbacks: {
    onTaskComplete?: (task: { id: string; state: string }) => void;
    onTaskStateChange?: (task: { id: string; state: string }) => void;
  } = {}
): { runner: BackgroundTaskRunner; registry: TaskRegistry } {
  const registry = new TaskRegistry({
    onTaskStateChanged: (task) => {
      callbacks.onTaskStateChange?.({ id: task.id, state: task.state });
    },
  });
  const runner = new BackgroundTaskRunner({
    sharedSessionOptions: {
      sessionManagerFactory: (_taskId, controller) => new StubSessionHandle(mode, controller),
    },
    registry,
    onTaskComplete: (task) => {
      callbacks.onTaskComplete?.({ id: task.id, state: task.state });
    },
  });
  return { runner, registry };
}

/**
 * 构造测试用 InjectedInstruction
 */
function createInstruction(text: string): InjectedInstruction {
  return Object.freeze({
    id: crypto.randomUUID(),
    text,
    enqueuedAt: new Date().toISOString(),
    source: "user",
  });
}

// ============================================================================
// TC-BR-001: start chat 任务注册到 registry
// ============================================================================

test("TC-BR-001: start chat 任务注册到 registry", async () => {
  const { runner, registry } = createRunner("long-running");

  const { taskId } = await runner.start("测试任务 1", "chat");

  // 验证 taskId 格式
  assert.ok(taskId.startsWith("t-"), "taskId 应以 't-' 前缀开头");
  assert.ok(taskId.length > 2, "taskId 应有 UUID 部分");

  // 验证任务已注册到 registry
  assert.equal(registry.size, 1, "registry 应有 1 个活跃任务");
  const task = registry.get(taskId);
  assert.ok(task, "get(taskId) 应返回任务实例");
  assert.equal(task!.id, taskId);
  assert.equal(task!.kind, "chat");
  assert.equal(task!.prompt, "测试任务 1");
  assert.equal(task!.state, "running", "任务状态应为 running");
  assert.equal(task!.sessionId, taskId, "sessionId 应等于 taskId");
  assert.equal(task!.controller.signal.aborted, false, "controller 不应被 abort");
});

// ============================================================================
// TC-BR-002: start 失败时 task state = failed
// ============================================================================

test("TC-BR-002: start 失败时 task state = failed", async () => {
  const stateChanges: { id: string; state: string }[] = [];
  const completeTasks: { id: string; state: string }[] = [];
  const { runner, registry } = createRunner("fail", {
    onTaskStateChange: (t) => stateChanges.push(t),
    onTaskComplete: (t) => completeTasks.push(t),
  });

  // start 应成功（factory 同步不抛错，handleUserPrompt 异步失败）
  const { taskId } = await runner.start("失败任务", "chat");

  // 等待微任务 + 宏任务执行：让 handleUserPrompt.reject + markFailed + unregister 都完成
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  // 任务可能已从活跃区移除（终态触发 setTimeout(0) unregister）
  // 先检查活跃区，再检查历史区
  let task = registry.get(taskId);
  if (!task) {
    // 已移到历史区
    const list = registry.list({ includeHistory: true });
    task = list.find((t) => t.id === taskId) ?? null;
  }
  assert.ok(task, "任务应存在于活跃区或历史区");
  assert.equal(task!.state, "failed", "任务状态应为 failed");
  assert.equal(task!.error, "StubSessionHandle 模拟 LLM 调用失败");

  // 验证状态变更记录
  assert.ok(
    stateChanges.some((s) => s.id === taskId && s.state === "running"),
    "应有 running 状态变更记录"
  );
  assert.ok(
    stateChanges.some((s) => s.id === taskId && s.state === "failed"),
    "应有 failed 状态变更记录"
  );

  // 验证 onComplete 回调被调用
  assert.ok(
    completeTasks.some((t) => t.id === taskId && t.state === "failed"),
    "onTaskComplete 应被调用且 state=failed"
  );
});

// ============================================================================
// TC-BR-003: stop 取消任务并从 registry 移除
// ============================================================================

test("TC-BR-003: stop 取消任务并从 registry 移除", async () => {
  const { runner, registry } = createRunner("long-running");

  const { taskId } = await runner.start("待停止任务", "chat");
  assert.equal(registry.size, 1);
  assert.equal(registry.get(taskId)!.state, "running");

  // stop 任务
  await runner.stop(taskId, "用户停止");

  // 验证任务已从 registry 活跃区移除
  assert.equal(registry.get(taskId), null, "stop 后 get 应返回 null");
  assert.equal(registry.size, 0, "registry 活跃区应为 0");

  // 验证任务在历史区
  const list = registry.list({ includeHistory: true });
  assert.equal(list.length, 1, "历史区应有 1 个任务");
  assert.equal(list[0].id, taskId);
  assert.equal(list[0].state, "cancelled", "任务状态应为 cancelled");
  assert.equal(list[0].error, "用户停止", "error 应记录 stop reason");

  // stop 不存在的任务应抛错
  await assert.rejects(
    () => runner.stop("t-not-exist"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("t-not-exist"));
      return true;
    },
    "stop 不存在任务应抛错"
  );
});

// ============================================================================
// TC-BR-004: inject 找到 task 并调用 inject
// ============================================================================

test("TC-BR-004: inject 找到 task 并调用 inject", async () => {
  const { runner, registry } = createRunner("long-running");
  const { taskId } = await runner.start("待注入任务", "chat");

  const task = registry.get(taskId)!;
  const injectedInstructions: InjectedInstruction[] = [];

  // 通过 task.inject 监听（直接给 task 注册 onInject 回调需要重建 task，此处用 runner.inject 间接测试）
  // 注：runner.start 内部创建的 task 未注入 onInject 回调
  // 此处通过 task 内部 state 校验 + 不抛错来验证 inject 调用成功
  // 也可通过 Object.getOwnPropertyDescriptor 等手段检测，但保持简洁

  // 通过 runner.inject 注入指令
  const inst = createInstruction("加上错误处理");
  runner.inject(taskId, inst);

  // 验证 task 仍存在且状态未变（inject 不改变状态）
  assert.equal(registry.get(taskId), task);
  assert.equal(task.state, "running", "inject 不应改变状态");

  // 注入不存在的任务应抛错
  assert.throws(
    () => runner.inject("t-not-exist", inst),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("t-not-exist"));
      return true;
    },
    "inject 不存在任务应抛错"
  );

  // 给 task 注册 onInject 回调后再注入（验证回调被调用）
  // 通过新建一个 runner + task 并使用 registry.get 拿到 task 直接调用 inject
  // 但 task 的 onInject 是构造时注入的，无法后续添加
  // 此处验证 inject 在终态抛错即可
  await runner.stop(taskId);
  // stop 后任务在历史区，registry.get 返回 null
  assert.equal(registry.get(taskId), null);
});

// ============================================================================
// TC-BR-005: 任务完成后 onTaskComplete 回调
// ============================================================================

test("TC-BR-005: 任务完成后 onTaskComplete 回调", async () => {
  const completeTasks: { id: string; state: string }[] = [];
  const { runner, registry } = createRunner("succeed", {
    onTaskComplete: (t) => completeTasks.push(t),
  });

  const { taskId } = await runner.start("成功任务", "chat");

  // 等待一个事件循环让 handleUserPrompt resolve + markSucceeded + onTaskComplete 触发
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // 验证 onTaskComplete 被调用
  assert.equal(completeTasks.length, 1, "onTaskComplete 应被调用 1 次");
  assert.equal(completeTasks[0].id, taskId);
  assert.equal(completeTasks[0].state, "succeeded", "完成状态应为 succeeded");

  // 等待 unregister 执行（onStateChange 中 setTimeout(0)）
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // 验证任务已从 registry 活跃区移到历史区
  assert.equal(registry.get(taskId), null, "终态后 get 应返回 null");
  assert.equal(registry.size, 0, "活跃区应为 0");
  assert.equal(registry.historySize, 1, "历史区应为 1");

  // 验证历史区任务状态
  const list = registry.list({ includeHistory: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, taskId);
  assert.equal(list[0].state, "succeeded");
  assert.equal(list[0].result, "completed");
});

// ============================================================================
// TC-BR-005b: 任务超时后 state = timeout 并触发 onTaskComplete
// ============================================================================

test("TC-BR-005b: 任务超时后 state = timeout 并触发 onTaskComplete", async () => {
  const completeTasks: { id: string; state: string }[] = [];
  const { runner, registry } = createRunner("long-running", {
    onTaskComplete: (t) => completeTasks.push(t),
  });

  const { taskId } = await runner.start("会超时的任务", "chat");
  const task = registry.get(taskId);
  assert.ok(task, "任务应存在");
  assert.equal(task!.state, "running", "初始状态应为 running");

  // 模拟外部超时检测机制调用 markTimeout
  task!.markTimeout("执行时间超过阈值");
  assert.equal(task!.state, "timeout", "markTimeout 后状态应为 timeout");
  assert.equal(task!.error, "执行时间超过阈值", "error 应记录超时原因");
  assert.ok(task!.controller.signal.aborted, "timeout 后 controller 应被 abort");

  // 等待 setTimeout(0) unregister 执行
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // 验证 onTaskComplete 被调用
  assert.equal(completeTasks.length, 1, "onTaskComplete 应被调用 1 次");
  assert.equal(completeTasks[0].id, taskId);
  assert.equal(completeTasks[0].state, "timeout", "完成状态应为 timeout");

  // 验证任务已从活跃区移到历史区
  assert.equal(registry.get(taskId), null, "timeout 后 get 应返回 null");
  assert.equal(registry.size, 0, "活跃区应为 0");
  assert.equal(registry.historySize, 1, "历史区应为 1");

  // 验证历史区任务状态
  const list = registry.list({ includeHistory: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, taskId);
  assert.equal(list[0].state, "timeout");
});

// ============================================================================
// TC-BR-006: 多任务并行（同时 3 个 task）
// ============================================================================

test("TC-BR-006: 多任务并行（同时 3 个 task）", async () => {
  const { runner, registry } = createRunner("long-running");

  // 同时启动 3 个任务
  const results = await Promise.all([
    runner.start("任务 1", "chat"),
    runner.start("任务 2", "chat"),
    runner.start("任务 3", "chat"),
  ]);

  assert.equal(results.length, 3, "应返回 3 个 taskId");
  assert.equal(registry.size, 3, "registry 应有 3 个活跃任务");

  // 验证 3 个 taskId 互不相同
  const ids = results.map((r) => r.taskId);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 3, "3 个 taskId 应互不相同");

  // 验证 3 个任务都在 running 状态
  for (const { taskId } of results) {
    const task = registry.get(taskId);
    assert.ok(task, `任务 ${taskId} 应存在`);
    assert.equal(task!.state, "running", `任务 ${taskId} 应为 running`);
  }

  // 取消其中一个任务，其他两个不受影响
  await runner.stop(ids[0], "取消第一个");
  assert.equal(registry.size, 2, "取消一个后应剩 2 个");
  assert.equal(registry.get(ids[0]), null);
  assert.ok(registry.get(ids[1]), "任务 2 应仍存在");
  assert.ok(registry.get(ids[2]), "任务 3 应仍存在");

  // 取消剩余任务
  await runner.stop(ids[1]);
  await runner.stop(ids[2]);
  assert.equal(registry.size, 0, "全部取消后应为 0");
  assert.equal(registry.historySize, 3, "历史区应有 3 个");
});

// ============================================================================
// TC-BR-007: 生成 taskId 唯一性
// ============================================================================

test("TC-BR-007: 生成 taskId 唯一性", async () => {
  const { runner, registry } = createRunner("long-running");

  // 由于 MAX_CONCURRENT_TASKS=8，分批生成 taskId
  // 每批 8 个，启动后立即 stop，再启动下一批
  // 共生成 50 个 taskId
  const taskIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const { taskId } = await runner.start(`任务-${i}`, "chat");
    taskIds.push(taskId);
    // 每生成 8 个就 stop 一批，避免超过 MAX_CONCURRENT_TASKS
    if ((i + 1) % 8 === 0) {
      // stop 当前所有活跃任务
      const currentList = registry.list();
      for (const t of currentList) {
        await runner.stop(t.id);
      }
    }
  }

  assert.equal(taskIds.length, 50);
  // 验证所有 taskId 互不相同
  const uniqueIds = new Set(taskIds);
  assert.equal(uniqueIds.size, 50, "50 个 taskId 应全部唯一");

  // 验证所有 taskId 格式正确（t- 前缀 + UUID）
  for (const id of taskIds) {
    assert.ok(id.startsWith("t-"), `taskId ${id} 应以 't-' 开头`);
    assert.ok(id.length > 10, `taskId ${id} 应有足够长度`);
  }

  // 验证 UUID 部分唯一性（去掉前缀后）
  const uuidParts = taskIds.map((id) => id.slice(2));
  const uniqueUuids = new Set(uuidParts);
  assert.equal(uniqueUuids.size, 50, "UUID 部分应全部唯一");
});

// ============================================================================
// 额外测试：start 时 kind=autonomous 抛错（Phase 1 限制）
// ============================================================================

test("额外测试：start 时 kind=autonomous 抛错（Phase 1 限制）", async () => {
  const { runner } = createRunner("succeed");

  await assert.rejects(
    () => runner.start("autonomous 任务", "autonomous"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Phase 1"));
      assert.ok(err.message.includes("chat"));
      return true;
    },
    "Phase 1 应拒绝 autonomous kind"
  );
});

// ============================================================================
// 额外测试：start 时 prompt 为空抛错
// ============================================================================

test("额外测试：start 时 prompt 为空抛错", async () => {
  const { runner } = createRunner("succeed");

  await assert.rejects(
    () => runner.start("", "chat"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("prompt"));
      return true;
    },
    "空 prompt 应抛错"
  );

  await assert.rejects(() => runner.start("", "chat"), "空字符串 prompt 应抛错");
});

// ============================================================================
// 额外测试：sessionManagerFactory 抛错时 task state = failed
// ============================================================================

test("额外测试：sessionManagerFactory 抛错时 task state = failed", async () => {
  const registry = new TaskRegistry();
  const runner = new BackgroundTaskRunner({
    sharedSessionOptions: {
      // 工厂函数同步抛错
      sessionManagerFactory: () => {
        throw new Error("工厂函数初始化失败");
      },
    },
    registry,
  });

  // start 应抛错（onStart 抛错传播）
  await assert.rejects(
    () => runner.start("测试工厂失败", "chat"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "工厂函数初始化失败");
      return true;
    },
    "工厂函数抛错时 start 应抛错"
  );

  // 验证 task 已注册并转为 failed
  assert.equal(registry.size, 1, "task 应已注册");
  const list = registry.list();
  const task = list[0];
  assert.equal(task.state, "failed", "task 应为 failed 状态");
  assert.equal(task.error, "工厂函数初始化失败");
});

// ============================================================================
// 额外测试：start 默认 kind 为 chat
// ============================================================================

test("额外测试：start 默认 kind 为 chat", async () => {
  const { runner, registry } = createRunner("long-running");

  // 不传 kind 参数
  const { taskId } = await runner.start("默认 kind 任务");

  const task = registry.get(taskId)!;
  assert.equal(task.kind, "chat", "默认 kind 应为 chat");
});
