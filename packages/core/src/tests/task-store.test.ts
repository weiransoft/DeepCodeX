/**
 * TaskStore 单元测试 —— 后台任务持久化存储
 *
 * 测试范围：
 * - TC-TS-001: persist 写入 .deepcodex/tasks/<taskId>.json
 * - TC-TS-002: loadAll 从磁盘加载全部任务快照
 * - TC-TS-003: remove 删除持久化文件
 * - TC-TS-004: 目录不存在时自动创建
 * - TC-TS-005: 文件不存在时 loadAll 返回空数组
 * - TC-TS-006: 文件解析失败时跳过该文件
 * - TC-TS-007: 原子写入（tmp file → rename）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实文件系统操作（使用临时目录）
 * - 中文注释
 *
 * @module tests/task-store
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskStore } from "../interrupts/task-store.ts";
import { BackgroundTask } from "../interrupts/background-task.ts";

// ============================================================================
// 测试辅助：创建临时目录
// ============================================================================

/**
 * 创建临时目录（用于测试持久化）
 *
 * @returns 临时目录路径
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-store-test-"));
}

/**
 * 清理临时目录
 *
 * @param dir 目录路径
 */
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

// ============================================================================
// TC-TS-001: persist 写入 .deepcodex/tasks/<taskId>.json
// ============================================================================

test("TC-TS-001: persist 写入 .deepcodex/tasks/<taskId>.json", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });
    const task = new BackgroundTask({
      id: "t-test-001",
      kind: "chat",
      prompt: "测试任务",
      controller: new AbortController(),
    });

    await store.persist(task);

    // 验证文件已写入
    const filePath = path.join(tempDir, ".deepcodex", "tasks", "t-test-001.json");
    assert.ok(fs.existsSync(filePath), "持久化文件应存在");

    // 验证文件内容
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(content.id, "t-test-001");
    assert.equal(content.kind, "chat");
    assert.equal(content.prompt, "测试任务");
    assert.equal(content.status, "queued");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-TS-002: loadAll 从磁盘加载全部任务快照
// ============================================================================

test("TC-TS-002: loadAll 从磁盘加载全部任务快照", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });

    // 创建 3 个任务并持久化
    const task1 = new BackgroundTask({
      id: "t-test-002-1",
      kind: "chat",
      prompt: "任务 1",
      controller: new AbortController(),
    });
    const task2 = new BackgroundTask({
      id: "t-test-002-2",
      kind: "chat",
      prompt: "任务 2",
      controller: new AbortController(),
    });
    const task3 = new BackgroundTask({
      id: "t-test-002-3",
      kind: "autonomous",
      prompt: "任务 3",
      controller: new AbortController(),
    });

    await store.persist(task1);
    await store.persist(task2);
    await store.persist(task3);

    // 加载全部快照
    const snapshots = await store.loadAll();

    assert.equal(snapshots.length, 3, "应加载 3 个快照");
    // 按 startedAt 排序（最早在前）
    assert.equal(snapshots[0].id, "t-test-002-1");
    assert.equal(snapshots[1].id, "t-test-002-2");
    assert.equal(snapshots[2].id, "t-test-002-3");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-TS-003: remove 删除持久化文件
// ============================================================================

test("TC-TS-003: remove 删除持久化文件", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });
    const task = new BackgroundTask({
      id: "t-test-003",
      kind: "chat",
      prompt: "测试任务",
      controller: new AbortController(),
    });

    await store.persist(task);
    const filePath = path.join(tempDir, ".deepcodex", "tasks", "t-test-003.json");
    assert.ok(fs.existsSync(filePath), "持久化文件应存在");

    await store.remove("t-test-003");
    assert.ok(!fs.existsSync(filePath), "持久化文件应被删除");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-TS-004: 目录不存在时自动创建
// ============================================================================

test("TC-TS-004: 目录不存在时自动创建", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });
    const tasksDir = path.join(tempDir, ".deepcodex", "tasks");

    // 目录不存在
    assert.ok(!fs.existsSync(tasksDir), "目录应不存在");

    const task = new BackgroundTask({
      id: "t-test-004",
      kind: "chat",
      prompt: "测试任务",
      controller: new AbortController(),
    });

    await store.persist(task);

    // 目录已自动创建
    assert.ok(fs.existsSync(tasksDir), "目录应被自动创建");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-TS-005: 文件不存在时 loadAll 返回空数组
// ============================================================================

test("TC-TS-005: 文件不存在时 loadAll 返回空数组", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });

    // 目录不存在
    const snapshots = await store.loadAll();
    assert.equal(snapshots.length, 0, "应返回空数组");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-TS-006: 文件解析失败时跳过该文件
// ============================================================================

test("TC-TS-006: 文件解析失败时跳过该文件", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });
    const tasksDir = path.join(tempDir, ".deepcodex", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });

    // 写入一个损坏的 JSON 文件
    const corruptedFile = path.join(tasksDir, "t-corrupted.json");
    fs.writeFileSync(corruptedFile, "invalid json content", "utf-8");

    // 写入一个正常的 JSON 文件
    const normalTask = new BackgroundTask({
      id: "t-normal",
      kind: "chat",
      prompt: "正常任务",
      controller: new AbortController(),
    });
    await store.persist(normalTask);

    // 加载全部快照（应跳过损坏文件）
    const snapshots = await store.loadAll();
    assert.equal(snapshots.length, 1, "应加载 1 个快照（跳过损坏文件）");
    assert.equal(snapshots[0].id, "t-normal");
  } finally {
    cleanupTempDir(tempDir);
  }
});

// ============================================================================
// TC-TS-007: 原子写入（tmp file → rename）
// ============================================================================

test("TC-TS-007: 原子写入（tmp file → rename）", async () => {
  const tempDir = createTempDir();
  try {
    const store = new TaskStore({ projectRoot: tempDir });
    const task = new BackgroundTask({
      id: "t-test-007",
      kind: "chat",
      prompt: "测试任务",
      controller: new AbortController(),
    });

    await store.persist(task);

    // 验证临时文件已被 rename（不存在）
    const tmpPath = path.join(tempDir, ".deepcodex", "tasks", "t-test-007.tmp.json");
    assert.ok(!fs.existsSync(tmpPath), "临时文件应被 rename（不存在）");

    // 验证最终文件存在
    const finalPath = path.join(tempDir, ".deepcodex", "tasks", "t-test-007.json");
    assert.ok(fs.existsSync(finalPath), "最终文件应存在");
  } finally {
    cleanupTempDir(tempDir);
  }
});
