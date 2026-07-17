/**
 * TaskContextManager 单元测试（F-CTX-02 TaskContext）
 *
 * 测试覆盖：
 * - TC-01: 创建任务上下文（初始化状态 + 空 WorkingMemory）
 * - TC-02: 重复创建任务 ID 抛出错误
 * - TC-03: 获取不存在的任务返回 null
 * - TC-04: 更新任务状态（pending → in_progress → completed）
 * - TC-05: 非法状态转换抛出错误（终态 → 任意）
 * - TC-06: 进度值越界抛出错误
 * - TC-07: 添加关注点（MEM-08 任务隔离基础）
 * - TC-08: 添加思考记录
 * - TC-09: 添加中间结果
 * - TC-10: 添加待办事项 + 更新待办状态
 * - TC-11: 设置临时数据
 * - TC-12: 更新上下文窗口
 * - TC-13: 激活技能（去重 + 加载历史）
 * - TC-14: 清空工作记忆
 * - TC-15: MEM-08 任务隔离（2 个并行任务互不干扰）
 * - TC-16: MEM-09 任务归档（生成摘要 + 删除上下文）
 * - TC-17: 归档非终态任务抛出错误
 * - TC-18: 归档回调被正确调用
 * - TC-19: 版本号递增（乐观并发控制）
 * - TC-20: list 列出所有任务
 * - TC-21: delete 强制删除
 *
 * 所有测试使用真实数据，无 mock。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskContextManager } from "../../context/task-context-manager";
import type { TaskDefinition, FocusPoint, PendingItem } from "../../context/types";

/**
 * 创建测试用的 TaskDefinition
 */
function createTestTaskDef(overrides?: Partial<TaskDefinition>): TaskDefinition {
  return {
    description: "测试任务",
    goals: ["验证 TaskContext 功能"],
    constraints: ["不依赖外部资源"],
    taskType: "test",
    expectedOutput: "测试通过",
    ...overrides,
  };
}

/**
 * 创建测试用的 FocusPoint
 */
function createTestFocusPoint(ref: string, priority = 0.5): FocusPoint {
  return {
    type: "file",
    ref,
    priority,
    addedAt: new Date().toISOString(),
  };
}

/**
 * 创建测试用的 PendingItem
 */
function createTestPendingItem(desc: string, priority = 0.5): PendingItem {
  return {
    id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: desc,
    priority,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

// ============================================================
// 创建任务测试
// ============================================================

test("TC-01: 创建任务上下文（初始化状态 + 空 WorkingMemory）", () => {
  const manager = new TaskContextManager();
  const ctx = manager.create("task-001", createTestTaskDef());

  // 验证任务 ID
  assert.equal(ctx.taskId, "task-001", "taskId 应为 'task-001'");

  // 验证初始状态为 pending
  assert.equal(ctx.taskState.status, "pending", "初始状态应为 pending");
  assert.equal(ctx.taskState.progress, 0, "初始进度应为 0");
  assert.ok(ctx.taskState.startedAt, "startedAt 应已设置");
  assert.equal(ctx.taskState.completedAt, undefined, "completedAt 初始应为 undefined");
  assert.equal(ctx.taskState.currentStage, "初始化", "初始阶段应为 '初始化'");

  // 验证 WorkingMemory 为空
  assert.equal(ctx.workingMemory.focusPoints.length, 0, "focusPoints 初始为空");
  assert.equal(ctx.workingMemory.pendingItems.length, 0, "pendingItems 初始为空");
  assert.equal(ctx.workingMemory.thoughtHistory.length, 0, "thoughtHistory 初始为空");
  assert.equal(ctx.workingMemory.intermediateResults.length, 0, "intermediateResults 初始为空");
  assert.equal(ctx.workingMemory.contextWindow.length, 0, "contextWindow 初始为空");
  assert.deepEqual(ctx.workingMemory.temporaryData, {}, "temporaryData 初始为空对象");

  // 验证技能上下文
  assert.equal(ctx.skillContext.activeSkills.length, 0, "activeSkills 初始为空");
  assert.equal(ctx.skillContext.loadedHistory.length, 0, "loadedHistory 初始为空");

  // 验证版本号
  assert.equal(ctx.version, 1, "初始版本号应为 1");
});

test("TC-02: 重复创建任务 ID 抛出错误", () => {
  const manager = new TaskContextManager();
  manager.create("task-dup", createTestTaskDef());

  // 重复创建相同 ID 应抛出错误
  assert.throws(() => manager.create("task-dup", createTestTaskDef()), /任务 ID 已存在/, "应抛出任务 ID 已存在错误");
});

test("TC-03: 获取不存在的任务返回 null", () => {
  const manager = new TaskContextManager();
  const ctx = manager.get("non-existent");
  assert.equal(ctx, null, "不存在的任务应返回 null");
});

// ============================================================
// 状态转换测试
// ============================================================

test("TC-04: 更新任务状态（pending → in_progress → completed）", () => {
  const manager = new TaskContextManager();
  manager.create("task-state", createTestTaskDef());

  // pending → in_progress
  manager.updateState("task-state", "in_progress", 30, "分析中");
  let ctx = manager.get("task-state")!;
  assert.equal(ctx.taskState.status, "in_progress", "状态应为 in_progress");
  assert.equal(ctx.taskState.progress, 30, "进度应为 30");
  assert.equal(ctx.taskState.currentStage, "分析中", "阶段应为 '分析中'");
  assert.equal(ctx.taskState.completedAt, undefined, "in_progress 时 completedAt 仍为 undefined");

  // in_progress → completed
  manager.updateState("task-state", "completed", 100, "完成");
  ctx = manager.get("task-state")!;
  assert.equal(ctx.taskState.status, "completed", "状态应为 completed");
  assert.equal(ctx.taskState.progress, 100, "completed 时进度应强制为 100");
  assert.ok(ctx.taskState.completedAt, "completed 时 completedAt 应已设置");
});

test("TC-05: 非法状态转换抛出错误（终态 → 任意）", () => {
  const manager = new TaskContextManager();
  manager.create("task-illegal", createTestTaskDef());
  manager.updateState("task-illegal", "in_progress");
  manager.updateState("task-illegal", "completed");

  // 终态 → in_progress 应抛出错误
  assert.throws(() => manager.updateState("task-illegal", "in_progress"), /非法状态转换/, "终态任务不应允许状态变更");

  // 终态 → failed 也应抛出错误（终态不可再转换）
  assert.throws(() => manager.updateState("task-illegal", "failed"), /非法状态转换/, "终态任务不应允许转换为其他终态");
});

test("TC-06: 进度值越界抛出错误", () => {
  const manager = new TaskContextManager();
  manager.create("task-progress", createTestTaskDef());

  // 进度 < 0 应抛出错误
  assert.throws(() => manager.updateState("task-progress", "in_progress", -1), /进度值非法/, "进度 -1 应抛出错误");

  // 进度 > 100 应抛出错误
  assert.throws(() => manager.updateState("task-progress", "in_progress", 101), /进度值非法/, "进度 101 应抛出错误");
});

test("TC-06b: 进度越界时状态不被部分更新（P1 回归测试）", () => {
  // P1 Bug 回归：progress 校验应在 status 修改之前完成，
  // 确保校验失败时 status 不会被错误地修改为终态。
  const manager = new TaskContextManager();
  manager.create("task-atomic", createTestTaskDef());

  // 先将任务转为 in_progress
  manager.updateState("task-atomic", "in_progress", 50, "执行中");
  assert.equal(manager.get("task-atomic")!.taskState.status, "in_progress", "前置：状态应为 in_progress");

  // 尝试转为 completed 但传入越界 progress，应抛出错误
  assert.throws(() => manager.updateState("task-atomic", "completed", 150), /进度值非法/, "进度 150 应抛出错误");

  // 关键断言：抛出错误后，status 不应被修改为 completed
  // （P1 Bug 修复前：status 已被修改为 completed，progress 未更新，completedAt 未设置）
  const ctx = manager.get("task-atomic")!;
  assert.equal(ctx.taskState.status, "in_progress", "进度越界时 status 不应被修改（原子性保证）");
  assert.equal(ctx.taskState.progress, 50, "进度越界时 progress 不应被修改");
  assert.equal(ctx.taskState.completedAt, undefined, "进度越界时 completedAt 不应被设置");

  // 验证版本号未被递增（因为操作失败，不应有副作用）
  // 前置 updateState(in_progress, 50) 递增了 1 次，版本应为 2
  assert.equal(ctx.version, 2, "进度越界时版本号不应递增（操作失败无副作用）");
});

// ============================================================
// WorkingMemory 操作测试
// ============================================================

test("TC-07: 添加关注点（MEM-08 任务隔离基础）", () => {
  const manager = new TaskContextManager();
  manager.create("task-focus", createTestTaskDef());

  const point = createTestFocusPoint("src/index.ts", 0.9);
  manager.addFocusPoint("task-focus", point);

  const ctx = manager.get("task-focus")!;
  assert.equal(ctx.workingMemory.focusPoints.length, 1, "应有 1 个关注点");
  assert.equal(ctx.workingMemory.focusPoints[0].ref, "src/index.ts", "关注点 ref 应匹配");
  assert.equal(ctx.workingMemory.focusPoints[0].priority, 0.9, "关注点 priority 应匹配");
});

test("TC-08: 添加思考记录", () => {
  const manager = new TaskContextManager();
  manager.create("task-thought", createTestTaskDef());

  manager.addThought("task-thought", "发现 bug 在第 42 行", "分析中");

  const ctx = manager.get("task-thought")!;
  assert.equal(ctx.workingMemory.thoughtHistory.length, 1, "应有 1 条思考记录");
  assert.equal(ctx.workingMemory.thoughtHistory[0].thought, "发现 bug 在第 42 行", "思考内容应匹配");
  assert.equal(ctx.workingMemory.thoughtHistory[0].stage, "分析中", "阶段应匹配");
  assert.ok(ctx.workingMemory.thoughtHistory[0].timestamp, "timestamp 应已设置");
});

test("TC-09: 添加中间结果", () => {
  const manager = new TaskContextManager();
  manager.create("task-result", createTestTaskDef());

  manager.addIntermediateResult("task-result", "搜索完成，找到 5 个匹配", "grep");

  const ctx = manager.get("task-result")!;
  assert.equal(ctx.workingMemory.intermediateResults.length, 1, "应有 1 条中间结果");
  assert.equal(ctx.workingMemory.intermediateResults[0].result, "搜索完成，找到 5 个匹配", "结果内容应匹配");
  assert.equal(ctx.workingMemory.intermediateResults[0].source, "grep", "来源应匹配");
});

test("TC-10: 添加待办事项 + 更新待办状态", () => {
  const manager = new TaskContextManager();
  manager.create("task-pending", createTestTaskDef());

  const item = createTestPendingItem("修复登录逻辑");
  manager.addPendingItem("task-pending", item);

  // 验证添加成功
  let ctx = manager.get("task-pending")!;
  assert.equal(ctx.workingMemory.pendingItems.length, 1, "应有 1 条待办");
  assert.equal(ctx.workingMemory.pendingItems[0].status, "pending", "初始状态应为 pending");

  // 更新待办状态为 done
  manager.updatePendingItemStatus("task-pending", item.id, "done");
  ctx = manager.get("task-pending")!;
  assert.equal(ctx.workingMemory.pendingItems[0].status, "done", "待办状态应更新为 done");

  // 更新不存在的待办应抛出错误
  assert.throws(
    () => manager.updatePendingItemStatus("task-pending", "non-existent-id", "done"),
    /待办事项不存在/,
    "更新不存在的待办应抛出错误"
  );
});

test("TC-11: 设置临时数据", () => {
  const manager = new TaskContextManager();
  manager.create("task-temp", createTestTaskDef());

  manager.setTemporaryData("task-temp", "searchQuery", "TODO");
  manager.setTemporaryData("task-temp", "matchCount", 5);

  const ctx = manager.get("task-temp")!;
  assert.equal(ctx.workingMemory.temporaryData["searchQuery"], "TODO", "searchQuery 应为 'TODO'");
  assert.equal(ctx.workingMemory.temporaryData["matchCount"], 5, "matchCount 应为 5");
});

test("TC-12: 更新上下文窗口", () => {
  const manager = new TaskContextManager();
  manager.create("task-window", createTestTaskDef());

  manager.updateContextWindow("task-window", ["src/a.ts", "src/b.ts", "src/c.ts"]);

  const ctx = manager.get("task-window")!;
  assert.equal(ctx.workingMemory.contextWindow.length, 3, "应有 3 个文件路径");
  assert.deepEqual(ctx.workingMemory.contextWindow, ["src/a.ts", "src/b.ts", "src/c.ts"], "contextWindow 内容应匹配");
});

test("TC-13: 激活技能（去重 + 加载历史）", () => {
  const manager = new TaskContextManager();
  manager.create("task-skill", createTestTaskDef());

  // 首次激活技能
  manager.activateSkill("task-skill", "ocr-skill", "1.0.0");
  let ctx = manager.get("task-skill")!;
  assert.equal(ctx.skillContext.activeSkills.length, 1, "应有 1 个激活技能");
  assert.equal(ctx.skillContext.activeSkills[0], "ocr-skill", "技能 ID 应匹配");
  assert.equal(ctx.skillContext.loadedHistory.length, 1, "应有 1 条加载记录");

  // 重复激活同一技能：activeSkills 去重，但 loadedHistory 追加
  manager.activateSkill("task-skill", "ocr-skill", "1.1.0");
  ctx = manager.get("task-skill")!;
  assert.equal(ctx.skillContext.activeSkills.length, 1, "重复激活不应增加 activeSkills");
  assert.equal(ctx.skillContext.loadedHistory.length, 2, "加载历史应追加第 2 条");
  assert.equal(ctx.skillContext.loadedHistory[1].version, "1.1.0", "第 2 条版本应为 1.1.0");

  // 激活不同技能
  manager.activateSkill("task-skill", "diff-skill", "2.0.0");
  ctx = manager.get("task-skill")!;
  assert.equal(ctx.skillContext.activeSkills.length, 2, "应有 2 个激活技能");
  assert.equal(ctx.skillContext.loadedHistory.length, 3, "应有 3 条加载记录");
});

test("TC-14: 清空工作记忆", () => {
  const manager = new TaskContextManager();
  manager.create("task-clear", createTestTaskDef());

  // 添加一些数据
  manager.addFocusPoint("task-clear", createTestFocusPoint("a.ts"));
  manager.addThought("task-clear", "思考 1", "阶段 1");
  manager.addIntermediateResult("task-clear", "结果 1", "工具 1");
  manager.addPendingItem("task-clear", createTestPendingItem("待办 1"));
  manager.setTemporaryData("task-clear", "key1", "value1");
  manager.updateContextWindow("task-clear", ["x.ts"]);

  // 清空
  manager.clear("task-clear");

  const ctx = manager.get("task-clear")!;
  assert.equal(ctx.workingMemory.focusPoints.length, 0, "清空后 focusPoints 应为空");
  assert.equal(ctx.workingMemory.thoughtHistory.length, 0, "清空后 thoughtHistory 应为空");
  assert.equal(ctx.workingMemory.intermediateResults.length, 0, "清空后 intermediateResults 应为空");
  assert.equal(ctx.workingMemory.pendingItems.length, 0, "清空后 pendingItems 应为空");
  assert.equal(ctx.workingMemory.contextWindow.length, 0, "清空后 contextWindow 应为空");
  assert.deepEqual(ctx.workingMemory.temporaryData, {}, "清空后 temporaryData 应为空对象");

  // 任务定义和状态不应被清空
  assert.ok(ctx.taskDefinition.description, "任务定义不应被清空");
  assert.ok(ctx.taskState.status, "任务状态不应被清空");
});

// ============================================================
// MEM-08 任务隔离测试
// ============================================================

test("TC-15: MEM-08 任务隔离（2 个并行任务互不干扰）", () => {
  const manager = new TaskContextManager();

  // 创建两个并行任务
  manager.create("task-A", createTestTaskDef({ description: "任务 A" }));
  manager.create("task-B", createTestTaskDef({ description: "任务 B" }));

  // 任务 A 添加关注点和思考
  manager.addFocusPoint("task-A", createTestFocusPoint("src/a.ts", 0.9));
  manager.addThought("task-A", "任务 A 的思考", "分析中");

  // 任务 B 添加不同的关注点和思考
  manager.addFocusPoint("task-B", createTestFocusPoint("src/b.ts", 0.8));
  manager.addThought("task-B", "任务 B 的思考", "编码中");

  // 验证任务 A 的工作记忆不受任务 B 影响
  const ctxA = manager.get("task-A")!;
  assert.equal(ctxA.workingMemory.focusPoints.length, 1, "任务 A 应有 1 个关注点");
  assert.equal(ctxA.workingMemory.focusPoints[0].ref, "src/a.ts", "任务 A 关注点应为 src/a.ts");
  assert.equal(ctxA.workingMemory.thoughtHistory.length, 1, "任务 A 应有 1 条思考");
  assert.equal(ctxA.workingMemory.thoughtHistory[0].thought, "任务 A 的思考", "任务 A 思考内容应匹配");
  assert.equal(ctxA.taskDefinition.description, "任务 A", "任务 A 描述应匹配");

  // 验证任务 B 的工作记忆不受任务 A 影响
  const ctxB = manager.get("task-B")!;
  assert.equal(ctxB.workingMemory.focusPoints.length, 1, "任务 B 应有 1 个关注点");
  assert.equal(ctxB.workingMemory.focusPoints[0].ref, "src/b.ts", "任务 B 关注点应为 src/b.ts");
  assert.equal(ctxB.workingMemory.thoughtHistory.length, 1, "任务 B 应有 1 条思考");
  assert.equal(ctxB.workingMemory.thoughtHistory[0].thought, "任务 B 的思考", "任务 B 思考内容应匹配");
  assert.equal(ctxB.taskDefinition.description, "任务 B", "任务 B 描述应匹配");
});

// ============================================================
// MEM-09 任务归档测试
// ============================================================

test("TC-16: MEM-09 任务归档（生成摘要 + 删除上下文）", () => {
  const manager = new TaskContextManager();
  manager.create("task-archive", createTestTaskDef({ description: "归档测试任务" }));

  // 添加工作记忆数据
  manager.addFocusPoint("task-archive", createTestFocusPoint("src/test.ts"));
  manager.addThought("task-archive", "任务完成思考", "完成阶段");
  manager.addIntermediateResult("task-archive", "测试全部通过", "pytest");

  // 转为终态
  manager.updateState("task-archive", "in_progress");
  manager.updateState("task-archive", "completed", 100, "完成");

  // 归档
  const summary = manager.archive("task-archive", true);

  // 验证归档摘要
  assert.equal(summary.taskId, "task-archive", "摘要 taskId 应匹配");
  assert.equal(summary.success, true, "摘要 success 应为 true");
  assert.equal(summary.taskDefinition.description, "归档测试任务", "摘要任务描述应匹配");
  assert.equal(summary.thoughtHistory.length, 1, "摘要应包含 1 条思考");
  assert.equal(summary.intermediateResults.length, 1, "摘要应包含 1 条中间结果");
  assert.equal(summary.focusPoints.length, 1, "摘要应包含 1 个关注点");
  assert.ok(summary.startedAt, "摘要应包含 startedAt");
  assert.ok(summary.completedAt, "摘要应包含 completedAt");
  assert.ok(summary.archivedAt, "摘要应包含 archivedAt");

  // 验证归档后上下文已删除
  assert.equal(manager.get("task-archive"), null, "归档后任务上下文应已删除");
});

test("TC-17: 归档非终态任务抛出错误", () => {
  const manager = new TaskContextManager();
  manager.create("task-not-terminal", createTestTaskDef());

  // 任务处于 pending 状态，非终态，应抛出错误
  assert.throws(() => manager.archive("task-not-terminal", true), /任务未处于终态/, "非终态任务不应允许归档");

  // 转为 in_progress 后仍非终态
  manager.updateState("task-not-terminal", "in_progress");
  assert.throws(() => manager.archive("task-not-terminal", true), /任务未处于终态/, "in_progress 状态任务不应允许归档");
});

test("TC-18: 归档回调被正确调用", () => {
  // 使用真实回调函数记录归档事件（非 mock）
  const archivedSummaries: Array<{ taskId: string; success: boolean }> = [];
  const callback = (summary: { taskId: string; success: boolean }) => {
    archivedSummaries.push({ taskId: summary.taskId, success: summary.success });
  };

  const manager = new TaskContextManager(callback);
  manager.create("task-callback", createTestTaskDef());
  manager.updateState("task-callback", "in_progress");
  manager.updateState("task-callback", "completed", 100, "完成");

  // 归档
  manager.archive("task-callback", true);

  // 验证回调被调用
  assert.equal(archivedSummaries.length, 1, "回调应被调用 1 次");
  assert.equal(archivedSummaries[0].taskId, "task-callback", "回调应收到正确的 taskId");
  assert.equal(archivedSummaries[0].success, true, "回调应收到 success=true");

  // 归档失败任务
  manager.create("task-failed", createTestTaskDef());
  manager.updateState("task-failed", "in_progress");
  manager.updateState("task-failed", "failed");

  manager.archive("task-failed", false);

  assert.equal(archivedSummaries.length, 2, "回调应被调用第 2 次");
  assert.equal(archivedSummaries[1].taskId, "task-failed", "第 2 次回调 taskId 应匹配");
  assert.equal(archivedSummaries[1].success, false, "第 2 次回调 success 应为 false");
});

// ============================================================
// 版本号测试
// ============================================================

test("TC-19: 版本号递增（乐观并发控制）", () => {
  const manager = new TaskContextManager();
  manager.create("task-version", createTestTaskDef());

  const initialVersion = manager.get("task-version")!.version;
  assert.equal(initialVersion, 1, "初始版本应为 1");

  // 每次操作都应递增版本号
  manager.addFocusPoint("task-version", createTestFocusPoint("a.ts"));
  assert.equal(manager.get("task-version")!.version, 2, "addFocusPoint 后版本应为 2");

  manager.addThought("task-version", "思考", "阶段");
  assert.equal(manager.get("task-version")!.version, 3, "addThought 后版本应为 3");

  manager.updateState("task-version", "in_progress", 50, "执行中");
  assert.equal(manager.get("task-version")!.version, 4, "updateState 后版本应为 4");

  manager.setTemporaryData("task-version", "key", "value");
  assert.equal(manager.get("task-version")!.version, 5, "setTemporaryData 后版本应为 5");

  manager.clear("task-version");
  assert.equal(manager.get("task-version")!.version, 6, "clear 后版本应为 6");
});

// ============================================================
// list / delete 测试
// ============================================================

test("TC-20: list 列出所有任务", () => {
  const manager = new TaskContextManager();
  manager.create("task-list-1", createTestTaskDef({ description: "任务 1" }));
  manager.create("task-list-2", createTestTaskDef({ description: "任务 2" }));
  manager.create("task-list-3", createTestTaskDef({ description: "任务 3" }));

  const list = manager.list();
  assert.equal(list.length, 3, "应列出 3 个任务");
  assert.equal(list[0].taskId, "task-list-1", "第 1 个任务 ID 应匹配（保持插入序）");
  assert.equal(list[1].taskId, "task-list-2", "第 2 个任务 ID 应匹配");
  assert.equal(list[2].taskId, "task-list-3", "第 3 个任务 ID 应匹配");
});

test("TC-21: delete 强制删除", () => {
  const manager = new TaskContextManager();
  manager.create("task-delete", createTestTaskDef());

  // 删除前存在
  assert.ok(manager.get("task-delete"), "删除前任务应存在");

  // 强制删除
  const deleted = manager.delete("task-delete");
  assert.equal(deleted, true, "删除成功应返回 true");
  assert.equal(manager.get("task-delete"), null, "删除后任务应为 null");

  // 删除不存在的任务返回 false
  const deletedAgain = manager.delete("task-delete");
  assert.equal(deletedAgain, false, "删除不存在的任务应返回 false");
});

// ============================================================
// 操作不存在任务测试
// ============================================================

test("TC-22: 对不存在的任务执行操作抛出错误", () => {
  const manager = new TaskContextManager();

  // 各操作对不存在的任务应抛出错误
  assert.throws(() => manager.updateState("non-existent", "in_progress"), /任务不存在/, "updateState 应抛出错误");
  assert.throws(
    () => manager.addFocusPoint("non-existent", createTestFocusPoint("x")),
    /任务不存在/,
    "addFocusPoint 应抛出错误"
  );
  assert.throws(() => manager.addThought("non-existent", "思考", "阶段"), /任务不存在/, "addThought 应抛出错误");
  assert.throws(
    () => manager.addIntermediateResult("non-existent", "结果", "来源"),
    /任务不存在/,
    "addIntermediateResult 应抛出错误"
  );
  assert.throws(
    () => manager.addPendingItem("non-existent", createTestPendingItem("待办")),
    /任务不存在/,
    "addPendingItem 应抛出错误"
  );
  assert.throws(
    () => manager.setTemporaryData("non-existent", "key", "val"),
    /任务不存在/,
    "setTemporaryData 应抛出错误"
  );
  assert.throws(
    () => manager.updateContextWindow("non-existent", ["x.ts"]),
    /任务不存在/,
    "updateContextWindow 应抛出错误"
  );
  assert.throws(() => manager.activateSkill("non-existent", "skill", "1.0"), /任务不存在/, "activateSkill 应抛出错误");
  assert.throws(() => manager.clear("non-existent"), /任务不存在/, "clear 应抛出错误");
  assert.throws(() => manager.archive("non-existent", true), /任务不存在/, "archive 应抛出错误");
});

// ============================================================
// cancelled 状态归档测试
// ============================================================

test("TC-23: cancelled 状态可归档", () => {
  const manager = new TaskContextManager();
  manager.create("task-cancelled", createTestTaskDef());
  manager.updateState("task-cancelled", "in_progress");
  manager.updateState("task-cancelled", "cancelled");

  const ctx = manager.get("task-cancelled")!;
  assert.equal(ctx.taskState.status, "cancelled", "状态应为 cancelled");
  assert.ok(ctx.taskState.completedAt, "cancelled 时应有 completedAt");

  // cancelled 是终态，可以归档
  const summary = manager.archive("task-cancelled", false);
  assert.equal(summary.success, false, "cancelled 归档 success 应为 false");
  assert.equal(manager.get("task-cancelled"), null, "归档后上下文应已删除");
});
