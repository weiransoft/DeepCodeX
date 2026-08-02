/**
 * BackgroundTask 单元测试 —— ADR-DI-001 §9.1
 *
 * 测试范围（对齐 ADR-DI-001 §9.1 单元测试用例）：
 * - TC-BT-001: start chat 任务 state = running
 * - TC-BT-002: start autonomous 任务（仅校验回调被调用，不真实执行）
 * - TC-BT-003: pause + resume 完整流程 state 流转 running→paused→running
 * - TC-BT-004: cancel 创建 abort 标志 state = cancelled
 * - TC-BT-005: inject 调用 onInject 回调
 * - TC-BT-006: 完成后 setState("succeeded")
 * - TC-BT-007: 异常时 setState("failed")
 * - TC-BT-008: toSnapshot 返回可序列化对象（不含 controller / functions）
 * - TC-BT-009: fromSnapshot 重建后 state 一致
 * - TC-BT-010: 非法状态转换抛错（如 succeeded → running）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new BackgroundTask()，不通过 mock 框架
 * - 回调使用真实闭包（非 mock 框架的 mock 函数）
 * - 中文注释
 *
 * 设计依据：
 * - ADR-DI-001 §3.2 BackgroundTask 数据结构
 * - ADR-DI-001 §6 状态机定义
 * - ADR-DI-001 §9.1 单元测试用例
 *
 * @module tests/background-task
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { BackgroundTask } from "../interrupts/background-task";
import { InvalidStateTransitionError, TERMINAL_STATUSES } from "../interrupts/types";
import type { BackgroundTaskOptions } from "../interrupts/background-task";
import type { InjectedInstruction, TaskSnapshot } from "../interrupts/types";

// ============================================================================
// 测试辅助：构造真实 BackgroundTaskOptions fixture
// ============================================================================

/**
 * 构造测试用 BackgroundTaskOptions
 *
 * 真实结构（非 mock），含可选回调记录器。
 *
 * @param id 任务 ID
 * @param overrides 部分选项覆盖
 * @returns 真实 BackgroundTaskOptions
 */
function createTaskOptions(id: string, overrides: Partial<BackgroundTaskOptions> = {}): BackgroundTaskOptions {
  return {
    id,
    kind: "chat",
    prompt: "测试任务",
    controller: new AbortController(),
    ...overrides,
  };
}

/**
 * 构造测试用 InjectedInstruction
 *
 * @param text 指令文本
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
// TC-BT-001: start chat 任务 state = running
// ============================================================================

test("TC-BT-001: start chat 任务 state = running", async () => {
  let onStartCalled = false;
  const task = new BackgroundTask({
    id: "t-001",
    kind: "chat",
    prompt: "调研 React 19",
    controller: new AbortController(),
    onStart: async (_t) => {
      onStartCalled = true;
    },
  });

  assert.equal(task.state, "queued", "初始状态应为 queued");
  assert.equal(task.kind, "chat");
  assert.equal(task.prompt, "调研 React 19");

  await task.start();

  assert.equal(onStartCalled, true, "onStart 回调应被调用");
  assert.equal(task.state, "running", "start 后状态应为 running");
  assert.equal(task.controller.signal.aborted, false, "controller 不应被 abort");
});

// ============================================================================
// TC-BT-002: start autonomous 任务（仅校验回调被调用，不真实执行）
// ============================================================================

test("TC-BT-002: start autonomous 任务（仅校验回调被调用，不真实执行）", async () => {
  let onStartCalled = false;
  const task = new BackgroundTask({
    id: "t-auto-001",
    kind: "autonomous",
    prompt: "重构订单服务",
    controller: new AbortController(),
    onStart: async (_t) => {
      onStartCalled = true;
      // 模拟 AutonomousOrchestrator.run 的最小行为（不真实执行 LLM）
      // 仅校验 onStart 被调用即可
    },
  });

  assert.equal(task.kind, "autonomous");

  await task.start();

  assert.equal(onStartCalled, true, "onStart 回调应被调用");
  assert.equal(task.state, "running", "autonomous 任务 start 后状态应为 running");
});

// ============================================================================
// TC-BT-003: pause + resume 完整流程 state 流转 running→paused→running
// ============================================================================

test("TC-BT-003: pause + resume 完整流程 state 流转 running→paused→running", async () => {
  const stateChanges: string[] = [];
  let onPauseCalled = false;
  let onResumeCalled = false;

  const task = new BackgroundTask({
    id: "t-pause-001",
    kind: "chat",
    prompt: "测试暂停",
    controller: new AbortController(),
    onStart: async () => {
      // 模拟启动（不真实调用 LLM）
    },
    onPause: () => {
      onPauseCalled = true;
    },
    onResume: async () => {
      onResumeCalled = true;
    },
    onStateChange: (t) => {
      stateChanges.push(t.state);
    },
  });

  await task.start();
  assert.equal(task.state, "running");

  // pause
  task.pause();
  assert.equal(task.state, "paused", "pause 后状态应为 paused");
  assert.equal(onPauseCalled, true, "onPause 回调应被调用");
  assert.equal(task.controller.signal.aborted, true, "controller 应被 abort");

  // resume
  await task.resume();
  assert.equal(task.state, "running", "resume 后状态应为 running");
  assert.equal(onResumeCalled, true, "onResume 回调应被调用");

  // 验证状态变更顺序：queued → pending → running → pausing → paused → pausing → running
  assert.deepEqual(
    stateChanges,
    ["pending", "running", "pausing", "paused", "pausing", "running"],
    "状态变更顺序应为 queued → pending → running → pausing → paused → pausing → running"
  );
});

// ============================================================================
// TC-BT-004: cancel 创建 abort 标志 state = cancelled
// ============================================================================

test("TC-BT-004: cancel 创建 abort 标志 state = cancelled", async () => {
  let onCancelCalled = false;
  const task = new BackgroundTask({
    id: "t-cancel-001",
    kind: "chat",
    prompt: "测试取消",
    controller: new AbortController(),
    onStart: async () => {},
    onCancel: (_t, reason) => {
      onCancelCalled = true;
      assert.equal(reason, "用户主动取消", "cancel reason 应传递给回调");
    },
  });

  await task.start();
  assert.equal(task.state, "running");

  // cancel
  task.cancel("用户主动取消");
  assert.equal(task.state, "cancelled", "cancel 后状态应为 cancelled");
  assert.equal(onCancelCalled, true, "onCancel 回调应被调用");
  assert.equal(task.controller.signal.aborted, true, "controller 应被 abort");
  assert.equal(task.error, "用户主动取消", "error 字段应记录 cancel reason");
  assert.equal(task.completedAt, task.updatedAt, "completedAt 应被设置");

  // cancelled 是终态，不可再操作
  assert.throws(() => task.pause(), InvalidStateTransitionError, "cancelled 后 pause 应抛错");
  assert.throws(() => task.cancel(), InvalidStateTransitionError, "cancelled 后 cancel 应抛错");
});

// ============================================================================
// TC-BT-005: inject 调用 onInject 回调
// ============================================================================

test("TC-BT-005: inject 调用 onInject 回调", async () => {
  const injectedInstructions: InjectedInstruction[] = [];
  const task = new BackgroundTask({
    id: "t-inject-001",
    kind: "chat",
    prompt: "测试注入",
    controller: new AbortController(),
    onStart: async () => {},
    onInject: (_t, instruction) => {
      injectedInstructions.push(instruction);
    },
  });

  await task.start();
  assert.equal(task.state, "running");

  const inst1 = createInstruction("加上错误处理");
  const inst2 = createInstruction("使用 TypeScript");

  task.inject(inst1);
  task.inject(inst2);

  assert.equal(injectedInstructions.length, 2, "onInject 应被调用 2 次");
  assert.equal(injectedInstructions[0].id, inst1.id, "第 1 次注入应保持顺序");
  assert.equal(injectedInstructions[1].id, inst2.id, "第 2 次注入应保持顺序");
});

// ============================================================================
// TC-BT-006: 完成后 setState("succeeded")
// ============================================================================

test('TC-BT-006: 完成后 setState("succeeded")', async () => {
  const stateChanges: string[] = [];
  let onCompleteCalled = false;

  const task = new BackgroundTask({
    id: "t-succeed-001",
    kind: "chat",
    prompt: "测试成功完成",
    controller: new AbortController(),
    onStart: async (t) => {
      // 模拟会话成功完成
      t.markSucceeded("任务完成摘要");
    },
    onComplete: (t) => {
      onCompleteCalled = true;
      assert.equal(t.state, "succeeded", "onComplete 时状态应为 succeeded");
    },
    onStateChange: (t) => {
      stateChanges.push(t.state);
    },
  });

  await task.start();
  // onStart 内部已 markSucceeded，所以 state 应为 succeeded
  assert.equal(task.state, "succeeded", "markSucceeded 后状态应为 succeeded");
  assert.equal(onCompleteCalled, true, "onComplete 回调应被调用");
  assert.equal(task.result, "任务完成摘要", "result 字段应记录任务结果");
  assert.equal(task.completedAt, task.updatedAt, "completedAt 应被设置");

  // succeeded 是终态，不可再操作
  assert.throws(() => task.pause(), InvalidStateTransitionError, "succeeded 后 pause 应抛错");
});

// ============================================================================
// TC-BT-007: 异常时 setState("failed")
// ============================================================================

test('TC-BT-007: 异常时 setState("failed")', async () => {
  let onCompleteCalled = false;
  const task = new BackgroundTask({
    id: "t-fail-001",
    kind: "chat",
    prompt: "测试失败",
    controller: new AbortController(),
    onStart: async () => {
      throw new Error("模拟 LLM 调用失败");
    },
    onComplete: (t) => {
      onCompleteCalled = true;
      assert.equal(t.state, "failed", "onComplete 时状态应为 failed");
    },
  });

  // start 应抛错（onStart 抛错传播）
  await assert.rejects(
    () => task.start(),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "模拟 LLM 调用失败");
      return true;
    },
    "start 应抛出 onStart 的错误"
  );

  assert.equal(task.state, "failed", "异常后状态应为 failed");
  assert.equal(task.error, "模拟 LLM 调用失败", "error 字段应记录失败原因");
  assert.equal(onCompleteCalled, true, "onComplete 回调应被调用");
  assert.equal(task.completedAt, task.updatedAt, "completedAt 应被设置");

  // failed 是终态
  assert.throws(() => task.pause(), InvalidStateTransitionError, "failed 后 pause 应抛错");
});

// ============================================================================
// TC-BT-008: toSnapshot 返回可序列化对象（不含 controller / functions）
// ============================================================================

test("TC-BT-008: toSnapshot 返回可序列化对象（不含 controller / functions）", async () => {
  const task = new BackgroundTask({
    id: "t-snapshot-001",
    kind: "chat",
    prompt: "测试快照",
    sessionId: "session-001",
    controller: new AbortController(),
    onStart: async () => {},
    onPause: () => {},
    onCancel: () => {},
    onComplete: () => {},
    onInject: () => {},
    onStateChange: () => {},
    onStatsUpdate: () => {},
  });

  await task.start();
  task.updateStats({ iterations: 5, tokensUsed: 1000 });

  const snapshot = task.toSnapshot();

  // 验证所有字段存在且类型正确
  assert.equal(snapshot.id, "t-snapshot-001");
  assert.equal(snapshot.kind, "chat");
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.prompt, "测试快照");
  assert.equal(snapshot.sessionId, "session-001");
  assert.equal(typeof snapshot.startedAt, "string");
  assert.equal(typeof snapshot.updatedAt, "string");
  assert.equal(snapshot.completedAt, null, "未完成时 completedAt 应为 null");
  assert.equal(snapshot.result, null, "未完成时 result 应为 null");
  assert.equal(snapshot.error, null, "未失败时 error 应为 null");
  assert.equal(snapshot.stats.iterations, 5);
  assert.equal(snapshot.stats.tokensUsed, 1000);
  assert.ok(snapshot.stats.durationMs >= 0);

  // 验证不含 controller / functions
  const snapshotKeys = Object.keys(snapshot);
  assert.ok(!snapshotKeys.includes("controller"), "snapshot 不应包含 controller");
  assert.ok(!snapshotKeys.includes("onStart"), "snapshot 不应包含 onStart");
  assert.ok(!snapshotKeys.includes("onPause"), "snapshot 不应包含 onPause");
  assert.ok(!snapshotKeys.includes("onCancel"), "snapshot 不应包含 onCancel");
  assert.ok(!snapshotKeys.includes("callbacks"), "snapshot 不应包含 callbacks");

  // 验证可序列化（JSON.stringify 不抛错）
  const json = JSON.stringify(snapshot);
  assert.ok(json.length > 0, "snapshot 应可 JSON 序列化");
  const parsed = JSON.parse(json) as TaskSnapshot;
  assert.equal(parsed.id, snapshot.id);
  assert.equal(parsed.status, snapshot.status);

  // 验证 snapshot 被冻结
  assert.ok(Object.isFrozen(snapshot), "snapshot 应被冻结");
});

// ============================================================================
// TC-BT-009: fromSnapshot 重建后 state 一致
// ============================================================================

test("TC-BT-009: fromSnapshot 重建后 state 一致", async () => {
  // 构造原任务并完成
  const originalTask = new BackgroundTask({
    id: "t-restore-001",
    kind: "chat",
    prompt: "测试重建",
    controller: new AbortController(),
    onStart: async (t) => {
      t.markSucceeded("完成");
    },
  });
  await originalTask.start();
  assert.equal(originalTask.state, "succeeded");

  // 生成快照
  const snapshot = originalTask.toSnapshot();

  // 从快照重建
  let onStateChangeCalled = false;
  const restoredTask = BackgroundTask.fromSnapshot(snapshot, {
    onStateChange: () => {
      onStateChangeCalled = true;
    },
  });

  // 验证状态一致
  assert.equal(restoredTask.id, originalTask.id);
  assert.equal(restoredTask.kind, originalTask.kind);
  assert.equal(restoredTask.prompt, originalTask.prompt);
  assert.equal(restoredTask.state, originalTask.state, "重建后状态应一致");
  assert.equal(restoredTask.sessionId, originalTask.sessionId);
  assert.equal(restoredTask.startedAt, originalTask.startedAt);
  assert.equal(restoredTask.updatedAt, originalTask.updatedAt);
  assert.equal(restoredTask.completedAt, originalTask.completedAt);
  assert.equal(restoredTask.result, originalTask.result);
  assert.equal(restoredTask.error, originalTask.error);
  assert.equal(restoredTask.stats.iterations, originalTask.stats.iterations);
  assert.equal(restoredTask.stats.tokensUsed, originalTask.stats.tokensUsed);

  // 重建后不应自动调用 onStateChange（未发生状态转换）
  assert.equal(onStateChangeCalled, false, "fromSnapshot 不应触发 onStateChange");

  // 重建后 controller 是新的（不与原 task 共享）
  assert.notEqual(restoredTask.controller, originalTask.controller);

  // 从 cancelled 快照重建时 controller 应已 abort
  const cancelledSnapshot: TaskSnapshot = Object.freeze({
    id: "t-cancelled-restore",
    kind: "chat",
    status: "cancelled",
    prompt: "已取消的任务",
    sessionId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: null,
    error: "用户取消",
    stats: Object.freeze({ iterations: 0, durationMs: 0, tokensUsed: 0 }),
  });
  const restoredCancelled = BackgroundTask.fromSnapshot(cancelledSnapshot, {});
  assert.equal(restoredCancelled.controller.signal.aborted, true, "cancelled 快照重建后 controller 应已 abort");
  assert.equal(restoredCancelled.state, "cancelled");
});

// ============================================================================
// TC-BT-010: 非法状态转换抛错（如 succeeded → running）
// ============================================================================

test("TC-BT-010: 非法状态转换抛错（如 succeeded → running）", async () => {
  const task = new BackgroundTask({
    id: "t-invalid-001",
    kind: "chat",
    prompt: "测试非法转换",
    controller: new AbortController(),
    onStart: async () => {},
  });

  await task.start();
  assert.equal(task.state, "running");

  // succeeded → running 非法
  task.markSucceeded("完成");
  assert.equal(task.state, "succeeded");
  assert.throws(
    () => task.setState("running"),
    (err) => {
      assert.ok(err instanceof InvalidStateTransitionError);
      assert.equal(err.name, "InvalidStateTransitionError");
      assert.equal(err.from, "succeeded");
      assert.equal(err.to, "running");
      return true;
    },
    "succeeded → running 应抛 InvalidStateTransitionError"
  );

  // failed → running 非法
  const task2 = new BackgroundTask({
    id: "t-invalid-002",
    kind: "chat",
    prompt: "测试 failed 转换",
    controller: new AbortController(),
    onStart: async (t) => {
      t.markFailed("模拟失败");
    },
  });
  await task2.start();
  assert.equal(task2.state, "failed");
  assert.throws(() => task2.setState("running"), InvalidStateTransitionError, "failed → running 应抛错");

  // queued 直接 pause 非法（必须先 start 转 running）
  const task3 = new BackgroundTask({
    id: "t-invalid-003",
    kind: "chat",
    prompt: "测试 queued 转换",
    controller: new AbortController(),
  });
  assert.equal(task3.state, "queued");
  assert.throws(() => task3.pause(), InvalidStateTransitionError, "queued → paused 应抛错（必须先 start）");

  // 自我转换非法（running → running）
  const task4 = new BackgroundTask({
    id: "t-invalid-004",
    kind: "chat",
    prompt: "测试自我转换",
    controller: new AbortController(),
    onStart: async () => {},
  });
  await task4.start();
  assert.equal(task4.state, "running");
  assert.throws(() => task4.setState("running"), InvalidStateTransitionError, "running → running 自我转换应抛错");

  // paused → succeeded 非法（必须先 resume 转 running）
  const task5 = new BackgroundTask({
    id: "t-invalid-005",
    kind: "chat",
    prompt: "测试 paused 转换",
    controller: new AbortController(),
    onStart: async () => {},
  });
  await task5.start();
  task5.pause();
  assert.equal(task5.state, "paused");
  assert.throws(
    () => task5.setState("succeeded"),
    InvalidStateTransitionError,
    "paused → succeeded 应抛错（必须先 resume）"
  );
});

// ============================================================================
// 额外测试：markFailed 从 running 状态
// ============================================================================

test("额外测试：markFailed 从 running 状态", async () => {
  let onCompleteCalled = false;
  const task = new BackgroundTask({
    id: "t-mark-failed-001",
    kind: "chat",
    prompt: "测试 markFailed",
    controller: new AbortController(),
    onStart: async () => {
      // 启动后稍后由外部 markFailed
    },
    onComplete: (t) => {
      onCompleteCalled = true;
      assert.equal(t.state, "failed");
    },
  });

  await task.start();
  assert.equal(task.state, "running");

  // 模拟外部检测到错误，调用 markFailed
  task.markFailed("运行时错误");

  assert.equal(task.state, "failed");
  assert.equal(task.error, "运行时错误");
  assert.equal(onCompleteCalled, true);
});

// ============================================================================
// 额外测试：updateStats 触发 onStatsUpdate 回调
// ============================================================================

test("额外测试：updateStats 触发 onStatsUpdate 回调", async () => {
  const statsUpdates: { iterations: number; tokensUsed: number }[] = [];
  const task = new BackgroundTask({
    id: "t-stats-001",
    kind: "chat",
    prompt: "测试 stats 更新",
    controller: new AbortController(),
    onStart: async () => {},
    onStatsUpdate: (_t, stats) => {
      statsUpdates.push({ iterations: stats.iterations, tokensUsed: stats.tokensUsed });
    },
  });

  await task.start();
  task.updateStats({ iterations: 1, tokensUsed: 100 });
  task.updateStats({ iterations: 2, tokensUsed: 200 });
  task.updateStats({ iterations: 3, tokensUsed: 300 });

  assert.equal(statsUpdates.length, 3, "onStatsUpdate 应被调用 3 次");
  assert.equal(statsUpdates[0].iterations, 1);
  assert.equal(statsUpdates[1].iterations, 2);
  assert.equal(statsUpdates[2].iterations, 3);
  assert.equal(statsUpdates[2].tokensUsed, 300);

  // 未提供的字段保留原值
  task.updateStats({ iterations: 4 });
  assert.equal(task.stats.iterations, 4);
  assert.equal(task.stats.tokensUsed, 300, "未提供的 tokensUsed 应保留原值 300");
});

// ============================================================================
// 额外测试：setSessionId 由 onStart 回调内部调用
// ============================================================================

test("额外测试：setSessionId 由 onStart 回调内部调用", async () => {
  const task = new BackgroundTask({
    id: "t-session-001",
    kind: "chat",
    prompt: "测试 setSessionId",
    controller: new AbortController(),
    onStart: async (t) => {
      t.setSessionId("session-from-onstart");
    },
  });

  assert.equal(task.sessionId, null, "初始 sessionId 应为 null");

  await task.start();

  assert.equal(task.sessionId, "session-from-onstart", "onStart 中 setSessionId 应生效");
});

// ============================================================================
// 额外测试：inject 在终态抛错
// ============================================================================

test("额外测试：inject 在终态抛错", async () => {
  const task = new BackgroundTask({
    id: "t-inject-terminal-001",
    kind: "chat",
    prompt: "测试终态 inject",
    controller: new AbortController(),
    onStart: async (t) => {
      t.markSucceeded("完成");
    },
  });

  await task.start();
  assert.equal(task.state, "succeeded");

  assert.throws(() => task.inject(createInstruction("终态注入")), InvalidStateTransitionError, "终态 inject 应抛错");
});

// ============================================================================
// TC-BT-011: start 状态流转 queued → pending → running
// ============================================================================

test("TC-BT-011: start 状态流转 queued → pending → running", async () => {
  const stateChanges: string[] = [];
  const task = new BackgroundTask({
    id: "t-pending-001",
    kind: "chat",
    prompt: "测试 pending 状态",
    controller: new AbortController(),
    onStart: async () => {
      // 模拟启动
    },
    onStateChange: (t) => {
      stateChanges.push(t.state);
    },
  });

  assert.equal(task.state, "queued");
  await task.start();
  assert.equal(task.state, "running");

  // start 过程中应依次经过 pending、running
  assert.deepEqual(stateChanges, ["pending", "running"], "start 应先转 pending 再转 running");
});

// ============================================================================
// TC-BT-012: pause 状态流转 running → pausing → paused
// ============================================================================

test("TC-BT-012: pause 状态流转 running → pausing → paused", async () => {
  const stateChanges: string[] = [];
  const task = new BackgroundTask({
    id: "t-pausing-001",
    kind: "chat",
    prompt: "测试 pausing 状态",
    controller: new AbortController(),
    onStart: async () => {},
    onStateChange: (t) => {
      stateChanges.push(t.state);
    },
  });

  await task.start();
  stateChanges.length = 0; // 清空 start 产生的 pending / running

  task.pause();
  assert.equal(task.state, "paused");
  assert.deepEqual(stateChanges, ["pausing", "paused"], "pause 应先转 pausing 再转 paused");
});

// ============================================================================
// TC-BT-013: resume 状态流转 paused → pausing → running，失败回退 paused
// ============================================================================

test("TC-BT-013: resume 状态流转 paused → pausing → running，失败回退 paused", async () => {
  const stateChanges: string[] = [];
  const task = new BackgroundTask({
    id: "t-resume-pausing-001",
    kind: "chat",
    prompt: "测试 resume 路径",
    controller: new AbortController(),
    onStart: async () => {},
    onResume: async () => {
      // 正常恢复
    },
    onStateChange: (t) => {
      stateChanges.push(t.state);
    },
  });

  await task.start();
  task.pause();
  stateChanges.length = 0; // 清空前面状态

  await task.resume();
  assert.equal(task.state, "running");
  assert.deepEqual(stateChanges, ["pausing", "running"], "resume 应先转 pausing 再转 running");

  // resume 失败时回退到 paused
  const failingTask = new BackgroundTask({
    id: "t-resume-fail-001",
    kind: "chat",
    prompt: "测试 resume 失败回退",
    controller: new AbortController(),
    onStart: async () => {},
    onResume: async () => {
      throw new Error("恢复失败");
    },
  });
  await failingTask.start();
  failingTask.pause();
  await assert.rejects(
    () => failingTask.resume(),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "恢复失败");
      return true;
    },
    "onResume 抛错应传播"
  );
  assert.equal(failingTask.state, "paused", "resume 失败后状态应回退到 paused");
});

// ============================================================================
// TC-BT-014: markRetrying running → retrying
// ============================================================================

test("TC-BT-014: markRetrying running → retrying", async () => {
  const task = new BackgroundTask({
    id: "t-retrying-001",
    kind: "chat",
    prompt: "测试重试状态",
    controller: new AbortController(),
    onStart: async () => {},
  });

  await task.start();
  assert.equal(task.state, "running");

  task.markRetrying();
  assert.equal(task.state, "retrying", "markRetrying 后状态应为 retrying");

  // retrying 可回到 running
  task.setState("running");
  assert.equal(task.state, "running");

  // 非 running 状态调用 markRetrying 应抛错
  task.pause();
  assert.throws(() => task.markRetrying(), InvalidStateTransitionError, "paused 状态 markRetrying 应抛错");
});

// ============================================================================
// TC-BT-015: markTimeout 转入 timeout 终态
// ============================================================================

test("TC-BT-015: markTimeout 转入 timeout 终态", async () => {
  const task = new BackgroundTask({
    id: "t-timeout-001",
    kind: "chat",
    prompt: "测试超时状态",
    controller: new AbortController(),
    onStart: async () => {},
    onComplete: (t) => {
      assert.equal(t.state, "timeout");
    },
  });

  await task.start();
  assert.equal(task.state, "running");

  task.markTimeout("执行时间超过阈值");
  assert.equal(task.state, "timeout", "markTimeout 后状态应为 timeout");
  assert.equal(task.error, "执行时间超过阈值", "error 应记录超时原因");
  assert.ok(task.completedAt, "completedAt 应被设置");
  assert.ok(task.controller.signal.aborted, "timeout 后 controller 应被 abort");

  // timeout 是终态，不可再转换
  assert.throws(() => task.pause(), InvalidStateTransitionError, "timeout 后 pause 应抛错");
  assert.throws(() => task.cancel(), InvalidStateTransitionError, "timeout 后 cancel 应抛错");
});

// ============================================================================
// TC-BT-016: timeout 属于终态集合
// ============================================================================

test("TC-BT-016: timeout 属于终态集合", () => {
  assert.ok(TERMINAL_STATUSES.includes("timeout"), "timeout 应为终态");
  assert.ok(TERMINAL_STATUSES.includes("succeeded"));
  assert.ok(TERMINAL_STATUSES.includes("failed"));
  assert.ok(TERMINAL_STATUSES.includes("cancelled"));
  assert.equal(TERMINAL_STATUSES.length, 4, "终态应有 4 个");
});

// ============================================================================
// TC-BT-018: injecting 状态转换 running → injecting → running
// ============================================================================

test("TC-BT-018: injecting 状态转换 running → injecting → running", async () => {
  const stateChanges: string[] = [];
  const task = new BackgroundTask({
    id: "t-injecting-001",
    kind: "chat",
    prompt: "测试 injecting 状态",
    controller: new AbortController(),
    onStart: async () => {},
    onStateChange: (t) => {
      stateChanges.push(t.state);
    },
  });

  await task.start();
  stateChanges.length = 0; // 清空 start 产生的 pending / running

  // running → injecting（模拟动态注入处理）
  task.setState("injecting");
  assert.equal(task.state, "injecting", "setState 后状态应为 injecting");

  // injecting 可回到 running
  task.setState("running");
  assert.equal(task.state, "running", "注入处理完成后应回到 running");

  // injecting 也可直接进入 succeeded / failed / cancelled / timeout
  const task2 = new BackgroundTask({
    id: "t-injecting-002",
    kind: "chat",
    prompt: "测试 injecting 直接到终态",
    controller: new AbortController(),
    onStart: async () => {},
  });
  await task2.start();
  task2.setState("injecting");
  task2.setState("succeeded");
  assert.equal(task2.state, "succeeded", "injecting 可直接转 succeeded");

  assert.deepEqual(stateChanges, ["injecting", "running"], "状态变更序列应为 injecting → running");
});

// ============================================================================
// TC-BT-019: progress 映射覆盖 11 状态
// ============================================================================

test("TC-BT-019: progress 映射覆盖 11 状态", async () => {
  // running / injecting / retrying / pausing
  const progressHalfDirectStates: TaskStatus[] = ["running", "injecting", "retrying", "pausing"];
  for (const state of progressHalfDirectStates) {
    const t = new BackgroundTask({
      id: `t-progress-${state}`,
      kind: "chat",
      prompt: `测试 ${state} progress`,
      controller: new AbortController(),
      onStart: async () => {},
    });
    await t.start();
    if (state !== "running") {
      t.setState(state);
    }
    assert.equal(t.progress, 0.5, `${state} progress 应为 0.5`);
  }

  // paused 需通过 pause() 进入（running → pausing → paused）
  const pausedTask = new BackgroundTask({
    id: "t-progress-paused",
    kind: "chat",
    prompt: "测试 paused progress",
    controller: new AbortController(),
    onStart: async () => {},
  });
  await pausedTask.start();
  pausedTask.pause();
  assert.equal(pausedTask.progress, 0.5, "paused progress 应为 0.5");

  // pending
  const pendingTask = new BackgroundTask({
    id: "t-progress-pending",
    kind: "chat",
    prompt: "测试 pending progress",
    controller: new AbortController(),
  });
  pendingTask.setState("pending");
  assert.equal(pendingTask.progress, 0.1, "pending progress 应为 0.1");

  // queued / failed / cancelled / timeout / succeeded
  const progressZeroStates: TaskStatus[] = ["queued", "failed", "cancelled", "timeout"];
  for (const state of progressZeroStates) {
    const t = new BackgroundTask({
      id: `t-progress-${state}`,
      kind: "chat",
      prompt: `测试 ${state} progress`,
      controller: new AbortController(),
      onStart: async () => {},
    });
    if (state !== "queued") {
      await t.start();
      if (state === "failed") {
        t.markFailed("模拟失败");
      } else if (state === "cancelled") {
        t.cancel("模拟取消");
      } else if (state === "timeout") {
        t.markTimeout("模拟超时");
      }
    }
    assert.equal(t.progress, 0, `${state} progress 应为 0`);
  }

  // succeeded
  const succeededTask = new BackgroundTask({
    id: "t-progress-succeeded",
    kind: "chat",
    prompt: "测试 succeeded progress",
    controller: new AbortController(),
    onStart: async () => {},
  });
  await succeededTask.start();
  succeededTask.markSucceeded();
  assert.equal(succeededTask.progress, 1, "succeeded progress 应为 1");
});

// ============================================================================
// TC-BT-017: fromSnapshot 恢复 timeout / failed 后 controller 已 abort
// ============================================================================

test("TC-BT-017: fromSnapshot 恢复 timeout / failed 后 controller 已 abort", () => {
  const now = new Date().toISOString();
  const timeoutSnapshot: TaskSnapshot = Object.freeze({
    id: "t-timeout-restore",
    kind: "chat",
    status: "timeout",
    prompt: "超时任务",
    sessionId: null,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    result: null,
    error: "执行超时",
    stats: Object.freeze({ iterations: 0, durationMs: 0, tokensUsed: 0 }),
  });
  const restoredTimeout = BackgroundTask.fromSnapshot(timeoutSnapshot, {});
  assert.equal(restoredTimeout.state, "timeout");
  assert.equal(restoredTimeout.controller.signal.aborted, true, "timeout 快照重建后 controller 应已 abort");

  const failedSnapshot: TaskSnapshot = Object.freeze({
    id: "t-failed-restore",
    kind: "chat",
    status: "failed",
    prompt: "失败任务",
    sessionId: null,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    result: null,
    error: "模拟失败",
    stats: Object.freeze({ iterations: 0, durationMs: 0, tokensUsed: 0 }),
  });
  const restoredFailed = BackgroundTask.fromSnapshot(failedSnapshot, {});
  assert.equal(restoredFailed.state, "failed");
  assert.equal(restoredFailed.controller.signal.aborted, true, "failed 快照重建后 controller 应已 abort");
});
