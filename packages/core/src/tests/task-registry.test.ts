/**
 * TaskRegistry 单元测试 —— ADR-DI-001 §9.1
 *
 * 测试范围（对齐 ADR-DI-001 §9.1 单元测试用例）：
 * - TC-TR-001: register + get + list 基本流程
 * - TC-TR-002: unregister 后 get 返回 null，历史区保留
 * - TC-TR-003: setForeground 切换前台，getForegroundId 正确
 * - TC-TR-004: list 按 status / kind 过滤
 * - TC-TR-005: list 限制 includeHistory=true 才返回历史区
 * - TC-TR-006: 超过 MAX_CONCURRENT_TASKS 抛 TaskLimitExceededError
 * - TC-TR-007: 事件回调（onTaskRegistered / onTaskStateChanged）触发
 * - TC-TR-008: 历史区超过 100 条自动淘汰最老的
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new TaskRegistry() + new BackgroundTask()，不通过 mock 框架
 * - 所有 fixture 使用真实 BackgroundTask 实例
 * - 中文注释
 *
 * 设计依据：
 * - ADR-DI-001 §3.3 TaskRegistry 数据结构
 * - ADR-DI-001 §9.1 单元测试用例
 *
 * @module tests/task-registry
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../interrupts/task-registry";
import { BackgroundTask } from "../interrupts/background-task";
import { TaskLimitExceededError } from "../interrupts/types";

// ============================================================================
// 测试辅助：构造真实 BackgroundTask fixture
// ============================================================================

/**
 * 构造测试用真实 BackgroundTask 实例
 *
 * 真实结构（非 mock），使用真实 AbortController 与 BackgroundTask 类。
 *
 * @param id 任务 ID
 * @param kind 任务类型（默认 chat）
 * @param prompt 任务 prompt（默认 "测试任务"）
 * @returns 真实 BackgroundTask 实例
 */
function createTask(id: string, kind: "chat" | "autonomous" = "chat", prompt: string = "测试任务"): BackgroundTask {
  return new BackgroundTask({
    id,
    kind,
    prompt,
    controller: new AbortController(),
  });
}

// ============================================================================
// TC-TR-001: register + get + list 基本流程
// ============================================================================

test("TC-TR-001: register + get + list 基本流程", () => {
  const registry = new TaskRegistry();
  const task1 = createTask("t-001");
  const task2 = createTask("t-002");
  const task3 = createTask("t-003");

  // register
  registry.register(task1);
  registry.register(task2);
  registry.register(task3);
  assert.equal(registry.size, 3, "register 后 size 应为 3");

  // get
  const got = registry.get("t-002");
  assert.equal(got, task2, "get 应返回注册的任务实例");
  assert.equal(registry.get("t-not-exist"), null, "get 不存在应返回 null");

  // list（默认不包含历史区）
  const list = registry.list();
  assert.equal(list.length, 3, "list 应返回 3 个任务");
  // 验证 list 返回值包含所有注册的任务
  const ids = list.map((t) => t.id);
  assert.ok(ids.includes("t-001"));
  assert.ok(ids.includes("t-002"));
  assert.ok(ids.includes("t-003"));
  // 验证 list 返回值不可变
  assert.ok(Object.isFrozen(list), "list 返回值应被冻结");
});

// ============================================================================
// TC-TR-002: unregister 后 get 返回 null，历史区保留
// ============================================================================

test("TC-TR-002: unregister 后 get 返回 null，历史区保留", () => {
  const registry = new TaskRegistry();
  const task1 = createTask("t-001");
  const task2 = createTask("t-002");
  registry.register(task1);
  registry.register(task2);
  assert.equal(registry.size, 2);

  // unregister task1
  registry.unregister("t-001");
  assert.equal(registry.size, 1, "unregister 后 size 应为 1");
  assert.equal(registry.get("t-001"), null, "unregister 后 get 应返回 null");

  // 默认 list 不包含历史区
  const listWithoutHistory = registry.list();
  assert.equal(listWithoutHistory.length, 1, "list 默认不包含历史区");
  assert.equal(listWithoutHistory[0].id, "t-002");

  // includeHistory=true 包含历史区
  const listWithHistory = registry.list({ includeHistory: true });
  assert.equal(listWithHistory.length, 2, "list includeHistory=true 应返回 2 个任务");
  const ids = listWithHistory.map((t) => t.id);
  assert.ok(ids.includes("t-001"), "历史区应包含已注销的 t-001");
  assert.ok(ids.includes("t-002"), "活跃区应包含 t-002");

  // 历史区计数
  assert.equal(registry.historySize, 1, "historySize 应为 1");
});

// ============================================================================
// TC-TR-003: setForeground 切换前台，getForegroundId 正确
// ============================================================================

test("TC-TR-003: setForeground 切换前台，getForegroundId 正确", () => {
  const registry = new TaskRegistry();
  const task1 = createTask("t-001");
  const task2 = createTask("t-002");
  registry.register(task1);
  registry.register(task2);

  // 初始无前台
  assert.equal(registry.getForegroundId(), null, "初始应无前台任务");

  // 设置前台为 t-001
  registry.setForeground("t-001");
  assert.equal(registry.getForegroundId(), "t-001", "前台应为 t-001");

  // 切换前台为 t-002
  registry.setForeground("t-002");
  assert.equal(registry.getForegroundId(), "t-002", "前台应切换为 t-002");

  // clearForeground 清除前台
  registry.clearForeground();
  assert.equal(registry.getForegroundId(), null, "clearForeground 后应无前台");

  // 设置不存在的任务为前台应抛错
  assert.throws(
    () => registry.setForeground("t-not-exist"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("t-not-exist"), "错误信息应包含任务 ID");
      return true;
    },
    "setForeground 不存在任务应抛错"
  );

  // unregister 前台任务后自动清除前台标记
  registry.setForeground("t-001");
  assert.equal(registry.getForegroundId(), "t-001");
  registry.unregister("t-001");
  assert.equal(registry.getForegroundId(), null, "unregister 前台任务后应自动清除前台标记");
});

// ============================================================================
// TC-TR-004: list 按 status / kind 过滤
// ============================================================================

test("TC-TR-004: list 按 status / kind 过滤", async () => {
  const registry = new TaskRegistry();
  // 构造不同状态与类型的任务
  const queued = createTask("t-queued", "chat"); // 默认 queued
  const running = createTask("t-running", "chat");
  const autonomousTask = createTask("t-autonomous", "autonomous");

  registry.register(queued);
  registry.register(running);
  registry.register(autonomousTask);

  // 将 running 转为 running 状态
  await running.start(); // start 内部 setState("running")
  assert.equal(running.state, "running");

  // 按 status 过滤
  const queuedList = registry.list({ status: "queued" });
  assert.equal(queuedList.length, 2, "queued 状态应有 2 个任务（queued + autonomous）");
  const queuedIds = queuedList.map((t) => t.id).sort();
  assert.deepEqual(queuedIds, ["t-autonomous", "t-queued"]);

  const runningList = registry.list({ status: "running" });
  assert.equal(runningList.length, 1, "running 状态应有 1 个任务");
  assert.equal(runningList[0].id, "t-running");

  // 按 kind 过滤
  const chatList = registry.list({ kind: "chat" });
  assert.equal(chatList.length, 2, "chat 类型应有 2 个任务");
  const autonomousList = registry.list({ kind: "autonomous" });
  assert.equal(autonomousList.length, 1, "autonomous 类型应有 1 个任务");
  assert.equal(autonomousList[0].id, "t-autonomous");

  // 按 status 数组过滤
  const multiStatusList = registry.list({ status: ["queued", "running"] });
  assert.equal(multiStatusList.length, 3, "queued + running 应有 3 个任务");

  // 组合过滤
  const chatRunningList = registry.list({ kind: "chat", status: "running" });
  assert.equal(chatRunningList.length, 1, "chat + running 应有 1 个任务");
  assert.equal(chatRunningList[0].id, "t-running");
});

// ============================================================================
// TC-TR-005: list 限制 includeHistory=true 才返回历史区
// ============================================================================

test("TC-TR-005: list 限制 includeHistory=true 才返回历史区", () => {
  const registry = new TaskRegistry();
  const task1 = createTask("t-001");
  const task2 = createTask("t-002");
  const task3 = createTask("t-003");
  registry.register(task1);
  registry.register(task2);
  registry.register(task3);

  // 注销 task1 和 task2（移到历史区）
  registry.unregister("t-001");
  registry.unregister("t-002");

  // 默认 list 不包含历史区
  const listDefault = registry.list();
  assert.equal(listDefault.length, 1, "默认 list 应仅返回活跃区 1 个任务");
  assert.equal(listDefault[0].id, "t-003");

  // includeHistory=false 显式指定
  const listNoHistory = registry.list({ includeHistory: false });
  assert.equal(listNoHistory.length, 1, "includeHistory=false 应仅返回活跃区");

  // includeHistory=true 包含历史区
  const listWithHistory = registry.list({ includeHistory: true });
  assert.equal(listWithHistory.length, 3, "includeHistory=true 应返回活跃区 + 历史区共 3 个任务");

  // 验证历史区在 list 末尾
  const ids = listWithHistory.map((t) => t.id);
  assert.equal(ids[0], "t-003", "活跃区任务在前");
  assert.ok(ids.includes("t-001"), "历史区应包含 t-001");
  assert.ok(ids.includes("t-002"), "历史区应包含 t-002");

  // 带 filter 的 includeHistory
  const filteredWithHistory = registry.list({
    includeHistory: true,
    kind: "chat",
  });
  assert.equal(filteredWithHistory.length, 3, "filter + includeHistory 应正确过滤");
});

// ============================================================================
// TC-TR-006: 超过 MAX_CONCURRENT_TASKS 抛 TaskLimitExceededError
// ============================================================================

test("TC-TR-006: 超过 MAX_CONCURRENT_TASKS 抛 TaskLimitExceededError", () => {
  const registry = new TaskRegistry();
  // 填满活跃区
  for (let i = 0; i < TaskRegistry.MAX_CONCURRENT_TASKS; i++) {
    registry.register(createTask(`t-${i.toString().padStart(3, "0")}`));
  }
  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS, "应已达并行上限");

  // 再注册应抛 TaskLimitExceededError
  assert.throws(
    () => registry.register(createTask("t-overflow")),
    (err) => {
      assert.ok(err instanceof TaskLimitExceededError, "应抛 TaskLimitExceededError");
      assert.equal(err.name, "TaskLimitExceededError");
      assert.equal(err.currentCount, TaskRegistry.MAX_CONCURRENT_TASKS);
      assert.equal(err.maxCount, TaskRegistry.MAX_CONCURRENT_TASKS);
      return true;
    },
    "第 9 个任务注册应抛 TaskLimitExceededError"
  );

  // 活跃区数量不变
  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS);

  // unregister 后可继续注册
  registry.unregister("t-000");
  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS - 1);
  registry.register(createTask("t-new"));
  assert.equal(registry.size, TaskRegistry.MAX_CONCURRENT_TASKS);
});

// ============================================================================
// TC-TR-007: 事件回调（onTaskRegistered / onTaskStateChanged）触发
// ============================================================================

test("TC-TR-007: 事件回调（onTaskRegistered / onTaskStateChanged）触发", () => {
  const registeredTasks: string[] = [];
  const unregisteredTasks: string[] = [];
  const stateChangedTasks: string[] = [];

  const registry = new TaskRegistry({
    onTaskRegistered: (task) => {
      registeredTasks.push(task.id);
    },
    onTaskUnregistered: (task) => {
      unregisteredTasks.push(task.id);
    },
    onTaskStateChanged: (task) => {
      stateChangedTasks.push(task.id);
    },
  });

  const task1 = createTask("t-001");
  const task2 = createTask("t-002");

  // register 触发 onTaskRegistered
  registry.register(task1);
  registry.register(task2);
  assert.deepEqual(registeredTasks, ["t-001", "t-002"], "onTaskRegistered 应按注册顺序触发");

  // notifyTaskStateChanged 触发 onTaskStateChanged
  registry.notifyTaskStateChanged(task1);
  registry.notifyTaskStateChanged(task2);
  registry.notifyTaskStateChanged(task1);
  assert.deepEqual(stateChangedTasks, ["t-001", "t-002", "t-001"], "onTaskStateChanged 应按通知顺序触发");

  // unregister 触发 onTaskUnregistered
  registry.unregister("t-001");
  assert.deepEqual(unregisteredTasks, ["t-001"], "onTaskUnregistered 应触发");

  // 回调抛错不影响主流程
  const errorRegistry = new TaskRegistry({
    onTaskRegistered: () => {
      throw new Error("回调模拟抛错");
    },
  });
  // 注册应成功（回调错误被吞掉）
  errorRegistry.register(createTask("t-error"));
  assert.equal(errorRegistry.size, 1, "回调抛错不应影响 register");
});

// ============================================================================
// TC-TR-008: 历史区超过 100 条自动淘汰最老的
// ============================================================================

test("TC-TR-008: 历史区超过 100 条自动淘汰最老的", () => {
  const registry = new TaskRegistry();
  // 注册并注销 110 个任务（分批，每批 ≤ MAX_CONCURRENT_TASKS=8）
  // 期望：历史区保留 100 条，淘汰最老的 10 条
  const totalTasks = 110;
  const batchSize = 8;
  let registered = 0;
  for (let batch = 0; registered < totalTasks; batch++) {
    const currentBatchSize = Math.min(batchSize, totalTasks - registered);
    // 注册本批
    for (let i = 0; i < currentBatchSize; i++) {
      const id = `t-${(registered + i).toString().padStart(4, "0")}`;
      registry.register(createTask(id));
    }
    // 注销本批全部任务（移到历史区）
    for (let i = 0; i < currentBatchSize; i++) {
      const id = `t-${(registered + i).toString().padStart(4, "0")}`;
      registry.unregister(id);
    }
    registered += currentBatchSize;
  }
  assert.equal(registered, totalTasks, `应注册 ${totalTasks} 个任务`);

  // 历史区应被淘汰到 MAX_HISTORY_SIZE
  assert.equal(
    registry.historySize,
    TaskRegistry.MAX_HISTORY_SIZE,
    `历史区应被淘汰到 ${TaskRegistry.MAX_HISTORY_SIZE} 条`
  );

  // 验证 FIFO 淘汰：注册顺序 t-0000 ~ t-0109，注销顺序相同
  // 淘汰最老的 10 条：t-0000 ~ t-0009
  // 保留最新的 100 条：t-0010 ~ t-0109
  const listWithHistory = registry.list({ includeHistory: true });
  assert.equal(listWithHistory.length, TaskRegistry.MAX_HISTORY_SIZE);

  // 历史区中应不包含 t-0000 ~ t-0009（被淘汰）
  const historyIds = listWithHistory.map((t) => t.id);
  for (let i = 0; i < 10; i++) {
    const id = `t-${i.toString().padStart(4, "0")}`;
    assert.ok(!historyIds.includes(id), `${id} 应被淘汰`);
  }
  // 历史区中应包含 t-0010（淘汰边界）与 t-0109（最后注册的）
  assert.ok(historyIds.includes("t-0010"), "t-0010 应保留（淘汰边界）");
  assert.ok(historyIds.includes("t-0109"), "t-0109 应保留（最后注册的）");
  // 历史区中应包含 t-0099（中间值）
  assert.ok(historyIds.includes("t-0099"), "t-0099 应保留");
});

// ============================================================================
// 额外测试：重复 register 同一 ID 抛错
// ============================================================================

test("额外测试：重复 register 同一 ID 抛错", () => {
  const registry = new TaskRegistry();
  registry.register(createTask("t-001"));

  assert.throws(
    () => registry.register(createTask("t-001")),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("t-001"), "错误信息应包含任务 ID");
      assert.ok(err.message.includes("已存在"), "错误信息应说明已存在");
      return true;
    },
    "重复 register 同一 ID 应抛错"
  );
});

// ============================================================================
// 额外测试：unregister 不存在的任务静默忽略
// ============================================================================

test("额外测试：unregister 不存在的任务静默忽略（不抛错）", () => {
  const registry = new TaskRegistry();
  // 不存在的任务注销应不抛错
  registry.unregister("t-not-exist");
  assert.equal(registry.size, 0, "unregister 不存在任务后 size 仍为 0");
  assert.equal(registry.historySize, 0, "历史区也应为 0");
});
