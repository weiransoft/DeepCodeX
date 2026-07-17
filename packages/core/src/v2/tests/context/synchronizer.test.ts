/**
 * ContextSynchronizer 单元测试（F-CTX-03）
 *
 * 测试覆盖：
 * - CS-01: sync 成功任务 → GlobalContext.historicalExperience.successExperiences 新增 1 条
 * - CS-02: sync 失败任务 → GlobalContext.historicalExperience.failureExperiences 新增 1 条
 * - CS-03: sync 取消任务 → 不新增经验（用户主动取消，无经验价值）
 * - CS-04: sync 进行中任务 → 不新增经验（仅终态归档）
 * - CS-05: concept focusPoint → 概念库新增条目
 * - CS-06: 概念去重 → 重复概念不重复添加
 * - CS-07: updateTaskFromGlobal 桩 → 返回原 task，不修改
 * - CS-08: SyncResult 字段正确性（conflicts 空、taskUpdates 空、globalUpdates 非空、syncedAt 非空）
 * - CS-09: asArchiveCallback 注入 TaskContextManager → 归档时触发同步，经验被持久化
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 * 通过自定义 filePath 构造 GlobalContextManager，避免污染真实 ~/.deepcode。
 *
 * @module v2/tests/context/synchronizer.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { GlobalContextManager, createDefaultGlobalContext } from "../../context/global-context";
import type { GlobalContext } from "../../context/global-context";
import { ContextSynchronizer } from "../../context/synchronizer";
import type { SyncResult } from "../../context/synchronizer";
import { TaskContextManager } from "../../context/task-context-manager";
import type { TaskContext, TaskDefinition, FocusPoint } from "../../context/types";

// ============================================================================
// 测试 fixture：每个用例独立的临时目录与文件路径
// ============================================================================

let tempDir: string;
let contextFilePath: string;
let globalManager: GlobalContextManager;
let synchronizer: ContextSynchronizer;

beforeEach(() => {
  // 创建临时目录（避免污染真实 ~/.deepcode）
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-sync-"));
  contextFilePath = path.join(tempDir, "global-context.json");
  globalManager = new GlobalContextManager(contextFilePath);
  synchronizer = new ContextSynchronizer(globalManager);
});

afterEach(() => {
  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助工厂：构造测试用 TaskContext
// ============================================================================

/**
 * 创建测试用任务定义
 *
 * @param overrides 部分字段覆盖
 * @returns 完整的 TaskDefinition
 */
function createTaskDef(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    description: "测试任务",
    goals: ["验证同步器功能"],
    constraints: ["不依赖外部资源"],
    taskType: "bugfix",
    expectedOutput: "测试通过",
    ...overrides,
  };
}

/**
 * 创建测试用关注点
 *
 * @param type 关注点类型
 * @param ref 引用标识
 * @param priority 优先级
 * @returns 完整的 FocusPoint
 */
function createFocusPoint(type: FocusPoint["type"], ref: string, priority = 0.5): FocusPoint {
  return {
    type,
    ref,
    priority,
    addedAt: new Date().toISOString(),
  };
}

/**
 * 构造测试用 TaskContext（绕过 TaskContextManager 直接构造，便于控制 status）
 *
 * @param overrides 部分字段覆盖
 * @returns 完整的 TaskContext
 */
function createTaskContext(overrides: Partial<TaskContext> = {}): TaskContext {
  const now = new Date().toISOString();
  const base: TaskContext = {
    taskId: "task-test-001",
    taskDefinition: createTaskDef(),
    taskState: {
      status: "completed",
      progress: 100,
      startedAt: now,
      completedAt: now,
      currentStage: "已完成",
    },
    workingMemory: {
      focusPoints: [],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [],
      contextWindow: [],
    },
    skillContext: {
      activeSkills: [],
      loadedHistory: [],
    },
    version: 1,
  };
  return { ...base, ...overrides };
}

// ============================================================
// CS-01: sync 成功任务 → 新增 SuccessExperience
// ============================================================

test("CS-01: sync 成功任务 → GlobalContext.historicalExperience.successExperiences 新增 1 条", async () => {
  // 准备：初始全局上下文（无经验）
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  // 准备：成功任务（含中间结果作为 solution 来源）
  const task = createTaskContext({
    taskId: "task-success-001",
    taskState: {
      status: "completed",
      progress: 100,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T01:00:00.000Z",
      currentStage: "已完成",
    },
    workingMemory: {
      focusPoints: [createFocusPoint("file", "src/auth.ts", 0.9)],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [{ timestamp: "2026-07-17T00:30:00.000Z", result: "修复了密码比对逻辑", source: "edit" }],
      contextWindow: [],
    },
  });

  // 执行：sync 同步
  const result = await synchronizer.sync(global, task);

  // 断言：成功经验已新增
  const updated = globalManager.load("default");
  assert.equal(updated.historicalExperience.successExperiences.length, 1, "应新增 1 条成功经验");
  const exp = updated.historicalExperience.successExperiences[0];
  assert.equal(exp.taskType, "bugfix", "taskType 应为 bugfix");
  assert.equal(exp.description, "测试任务", "description 应为任务描述");
  assert.equal(exp.solution, "修复了密码比对逻辑", "solution 应为最后一条中间结果");
  assert.equal(exp.importance, 5, "importance 默认应为 5");
  assert.equal(exp.accessCount, 0, "accessCount 初始应为 0");
  assert.ok(exp.id, "id 应已生成");
  assert.ok(exp.createdAt, "createdAt 应已设置");
  assert.equal(exp.lastAccessedAt, exp.createdAt, "lastAccessedAt 初始应等于 createdAt");

  // 断言：tags 包含文件名（去扩展名）
  assert.ok(exp.tags.includes("auth"), "tags 应包含 'auth'（src/auth.ts 的文件名去扩展名）");

  // 断言：SyncResult.globalUpdates 包含更新描述
  assert.ok(result.globalUpdates.length > 0, "globalUpdates 应非空");
  assert.ok(
    result.globalUpdates.some((u) => u.includes("成功经验")),
    "globalUpdates 应包含'成功经验'描述"
  );
});

// ============================================================
// CS-02: sync 失败任务 → 新增 FailureExperience
// ============================================================

test("CS-02: sync 失败任务 → GlobalContext.historicalExperience.failureExperiences 新增 1 条", async () => {
  // 准备：初始全局上下文
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  // 准备：失败任务（含思考历史作为 failureReason/lessonLearned 来源）
  const task = createTaskContext({
    taskId: "task-fail-001",
    taskState: {
      status: "failed",
      progress: 60,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T01:00:00.000Z",
      currentStage: "失败",
    },
    workingMemory: {
      focusPoints: [createFocusPoint("concept", "认证", 0.8)],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [
        { timestamp: "2026-07-17T00:30:00.000Z", thought: "开始分析问题", stage: "分析中" },
        { timestamp: "2026-07-17T00:45:00.000Z", thought: "发现错误：缺少空值检查", stage: "编码中" },
        { timestamp: "2026-07-17T00:55:00.000Z", thought: "尝试修复但未通过验证", stage: "测试中" },
      ],
      intermediateResults: [],
      contextWindow: [],
    },
  });

  // 执行：sync 同步
  const result = await synchronizer.sync(global, task);

  // 断言：失败经验已新增
  const updated = globalManager.load("default");
  assert.equal(updated.historicalExperience.failureExperiences.length, 1, "应新增 1 条失败经验");
  assert.equal(updated.historicalExperience.successExperiences.length, 0, "不应新增成功经验");
  const exp = updated.historicalExperience.failureExperiences[0];
  assert.equal(exp.taskType, "bugfix", "taskType 应为 bugfix");
  assert.equal(exp.description, "测试任务", "description 应为任务描述");
  assert.equal(exp.failureReason, "尝试修复但未通过验证", "failureReason 应为最后一条思考");
  // lessonLearned 应倒序命中含"错误"关键字的条目
  assert.equal(exp.lessonLearned, "发现错误：缺少空值检查", "lessonLearned 应为含'错误'关键字的条目");
  assert.ok(exp.tags.includes("认证"), "tags 应包含概念名 '认证'");

  // 断言：SyncResult.globalUpdates 包含失败经验描述
  assert.ok(
    result.globalUpdates.some((u) => u.includes("失败经验")),
    "globalUpdates 应包含'失败经验'描述"
  );
});

// ============================================================
// CS-03: sync 取消任务 → 不新增经验
// ============================================================

test("CS-03: sync 取消任务 → 不新增经验（用户主动取消，无经验价值）", async () => {
  // 准备：初始全局上下文
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  // 准备：取消的任务
  const task = createTaskContext({
    taskId: "task-cancel-001",
    taskState: {
      status: "cancelled",
      progress: 30,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:30:00.000Z",
      currentStage: "已取消",
    },
    workingMemory: {
      focusPoints: [],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [{ timestamp: "2026-07-17T00:15:00.000Z", thought: "用户取消", stage: "分析中" }],
      intermediateResults: [],
      contextWindow: [],
    },
  });

  // 执行：sync 同步
  const result = await synchronizer.sync(global, task);

  // 断言：未新增任何经验
  const updated = globalManager.load("default");
  assert.equal(updated.historicalExperience.successExperiences.length, 0, "不应新增成功经验");
  assert.equal(updated.historicalExperience.failureExperiences.length, 0, "不应新增失败经验");

  // 断言：globalUpdates 为空
  assert.equal(result.globalUpdates.length, 0, "cancelled 任务 globalUpdates 应为空");
});

// ============================================================
// CS-04: sync 进行中任务 → 不新增经验（仅终态归档）
// ============================================================

test("CS-04: sync 进行中任务 → 不新增经验（仅终态归档）", async () => {
  // 准备：初始全局上下文
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  // 准备：进行中的任务
  const task = createTaskContext({
    taskId: "task-running-001",
    taskState: {
      status: "in_progress",
      progress: 50,
      startedAt: "2026-07-17T00:00:00.000Z",
      currentStage: "编码中",
    },
    workingMemory: {
      focusPoints: [createFocusPoint("file", "src/foo.ts")],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [{ timestamp: "2026-07-17T00:30:00.000Z", result: "部分实现", source: "edit" }],
      contextWindow: [],
    },
  });

  // 执行：sync 同步
  const result = await synchronizer.sync(global, task);

  // 断言：未新增任何经验
  const updated = globalManager.load("default");
  assert.equal(updated.historicalExperience.successExperiences.length, 0, "进行中任务不应新增成功经验");
  assert.equal(updated.historicalExperience.failureExperiences.length, 0, "进行中任务不应新增失败经验");
  assert.equal(result.globalUpdates.length, 0, "进行中任务 globalUpdates 应为空");
});

// ============================================================
// CS-05: concept focusPoint → 概念库新增条目
// ============================================================

test("CS-05: concept focusPoint → 概念库新增条目", async () => {
  // 准备：初始全局上下文（conceptLibrary 为空）
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  // 准备：成功任务，含 2 个 concept 关注点
  const task = createTaskContext({
    taskId: "task-concept-001",
    taskState: {
      status: "completed",
      progress: 100,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T01:00:00.000Z",
      currentStage: "已完成",
    },
    workingMemory: {
      focusPoints: [
        createFocusPoint("concept", "JWT 认证", 0.9),
        createFocusPoint("concept", "OAuth 2.0", 0.8),
        createFocusPoint("file", "src/auth.ts", 0.5), // 非 concept，不进 conceptLibrary
      ],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [],
      contextWindow: [],
    },
  });

  // 执行：sync 同步
  await synchronizer.sync(global, task);

  // 断言：conceptLibrary 新增 2 条
  const updated = globalManager.load("default");
  assert.equal(updated.domainKnowledge.conceptLibrary.length, 2, "应新增 2 个概念");
  const names = updated.domainKnowledge.conceptLibrary.map((c) => c.name);
  assert.ok(names.includes("JWT 认证"), "conceptLibrary 应包含 'JWT 认证'");
  assert.ok(names.includes("OAuth 2.0"), "conceptLibrary 应包含 'OAuth 2.0'");
  // 验证概念结构完整性
  const concept = updated.domainKnowledge.conceptLibrary[0];
  assert.ok(concept.id, "概念 id 应已生成");
  assert.equal(concept.description, "", "概念 description 默认为空串");
  assert.deepEqual(concept.relatedConcepts, [], "概念 relatedConcepts 默认为空数组");
});

// ============================================================
// CS-06: 概念去重 → 重复概念不重复添加
// ============================================================

test("CS-06: 概念去重 → 重复概念不重复添加", async () => {
  // 准备：全局上下文已有概念 "JWT 认证"
  const global = createDefaultGlobalContext("default");
  global.domainKnowledge.conceptLibrary.push({
    id: crypto.randomUUID(),
    name: "JWT 认证",
    description: "已有概念",
    relatedConcepts: [],
  });
  globalManager.save(global);

  // 准备：成功任务，含相同 concept "JWT 认证" + 新 concept "RBAC"
  const task = createTaskContext({
    taskId: "task-dedup-001",
    taskState: {
      status: "completed",
      progress: 100,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T01:00:00.000Z",
      currentStage: "已完成",
    },
    workingMemory: {
      focusPoints: [
        createFocusPoint("concept", "JWT 认证", 0.9), // 重复
        createFocusPoint("concept", "RBAC", 0.7), // 新增
      ],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [],
      contextWindow: [],
    },
  });

  // 执行：sync 同步
  await synchronizer.sync(global, task);

  // 断言：conceptLibrary 仅新增 1 条（RBAC），JWT 认证保持原样
  const updated = globalManager.load("default");
  assert.equal(updated.domainKnowledge.conceptLibrary.length, 2, "conceptLibrary 应为 2 条");
  const jwtConcept = updated.domainKnowledge.conceptLibrary.find((c) => c.name === "JWT 认证");
  assert.ok(jwtConcept, "JWT 认证 概念应存在");
  assert.equal(jwtConcept!.description, "已有概念", "JWT 认证 描述应保持原样（未被覆盖）");
  const rbacConcept = updated.domainKnowledge.conceptLibrary.find((c) => c.name === "RBAC");
  assert.ok(rbacConcept, "RBAC 概念应存在");
});

// ============================================================
// CS-07: updateTaskFromGlobal 桩 → 返回原 task，不修改
// ============================================================

test("CS-07: updateTaskFromGlobal 桩 → 返回原 task，不修改", async () => {
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  const task = createTaskContext({
    taskId: "task-stub-001",
    workingMemory: {
      focusPoints: [createFocusPoint("file", "src/bar.ts")],
      temporaryData: { key: "value" },
      pendingItems: [],
      thoughtHistory: [{ timestamp: "2026-07-17T00:00:00.000Z", thought: "原始思考", stage: "分析中" }],
      intermediateResults: [],
      contextWindow: ["src/bar.ts"],
    },
  });

  // 执行：updateTaskFromGlobal（桩）
  const result = await synchronizer.updateTaskFromGlobal(global, task);

  // 断言：返回的对象与原对象引用相同（桩实现直接 return task）
  assert.equal(result, task, "桩实现应返回原 task 引用（未修改）");
  // 断言：内容完全一致
  assert.equal(result.taskId, task.taskId, "taskId 应一致");
  assert.equal(result.workingMemory.focusPoints.length, 1, "focusPoints 应未被修改");
  assert.equal(result.workingMemory.thoughtHistory[0].thought, "原始思考", "thoughtHistory 应未被修改");
  assert.deepEqual(result.workingMemory.temporaryData, { key: "value" }, "temporaryData 应未被修改");
});

// ============================================================
// CS-08: SyncResult 字段正确性
// ============================================================

test("CS-08: SyncResult 字段正确性（conflicts 空、taskUpdates 空、globalUpdates 非空、syncedAt 非空）", async () => {
  const global = createDefaultGlobalContext("default");
  globalManager.save(global);

  const task = createTaskContext({
    taskId: "task-fields-001",
    taskState: {
      status: "completed",
      progress: 100,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T01:00:00.000Z",
      currentStage: "已完成",
    },
    workingMemory: {
      focusPoints: [createFocusPoint("concept", "测试概念")],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [{ timestamp: "2026-07-17T00:30:00.000Z", result: "测试结果", source: "test" }],
      contextWindow: [],
    },
  });

  const beforeTime = new Date().toISOString();
  const result: SyncResult = await synchronizer.sync(global, task);
  const afterTime = new Date().toISOString();

  // 断言：conflicts 为空数组（V2-P1 无冲突检测）
  assert.deepEqual(result.conflicts, [], "conflicts 应为空数组");
  // 断言：taskUpdates 为空数组（V2-P1 updateTaskFromGlobal 桩）
  assert.deepEqual(result.taskUpdates, [], "taskUpdates 应为空数组");
  // 断言：globalUpdates 非空（含成功经验 + 概念 2 条描述）
  assert.ok(result.globalUpdates.length >= 1, "globalUpdates 应非空");
  // 断言：syncedAt 为有效 ISO 时间戳，介于 before 和 after 之间
  assert.ok(result.syncedAt, "syncedAt 应非空");
  const syncedTime = new Date(result.syncedAt).getTime();
  assert.ok(
    syncedTime >= new Date(beforeTime).getTime() - 1000 && syncedTime <= new Date(afterTime).getTime() + 1000,
    "syncedAt 应为当前时间附近（允许 1 秒误差）"
  );
});

// ============================================================
// CS-09: asArchiveCallback 注入 TaskContextManager → 归档时触发同步
// ============================================================

test("CS-09: asArchiveCallback 注入 TaskContextManager → 归档时触发同步，经验被持久化", async () => {
  // 准备：使用真实 TaskContextManager + ContextSynchronizer.asArchiveCallback
  const taskManager = new TaskContextManager(synchronizer.asArchiveCallback("default"));

  // 准备：创建并完成任务
  const taskDef = createTaskDef({
    description: "归档测试任务",
    taskType: "feature",
  });
  const ctx = taskManager.create("task-archive-001", taskDef);
  taskManager.updateState("task-archive-001", "in_progress", 30, "编码中");
  taskManager.addFocusPoint("task-archive-001", createFocusPoint("file", "src/feature.ts", 0.9));
  taskManager.addThought("task-archive-001", "实现核心逻辑", "编码中");
  taskManager.addIntermediateResult("task-archive-001", "功能实现完成", "edit");
  taskManager.updateState("task-archive-001", "completed", 100, "完成");

  // 执行：归档（应触发 asArchiveCallback → 同步到 GlobalContext）
  taskManager.archive("task-archive-001", true);

  // 断言：成功经验已持久化到 GlobalContext
  const global = globalManager.load("default");
  assert.equal(global.historicalExperience.successExperiences.length, 1, "归档应新增 1 条成功经验");
  const exp = global.historicalExperience.successExperiences[0];
  assert.equal(exp.taskType, "feature", "taskType 应为 feature");
  assert.equal(exp.description, "归档测试任务", "description 应为任务描述");
  assert.equal(exp.solution, "功能实现完成", "solution 应为最后一条中间结果");
  assert.ok(exp.tags.includes("feature"), "tags 应包含 'feature'（文件名去扩展名）");

  // 断言：任务上下文已从 TaskContextManager 删除（归档后清理）
  const archivedCtx = taskManager.get("task-archive-001");
  assert.equal(archivedCtx, null, "归档后任务上下文应已删除");
});
