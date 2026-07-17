/**
 * MemoryStore 单元测试（MEM-01 ~ MEM-10）
 *
 * 测试覆盖 V2 上下文记忆系统 F-MEM-01/02 的核心能力：
 * - MEM-01: 用户全局记忆持久化
 * - MEM-02: 项目记忆持久化
 * - MEM-03: 经验记忆持久化
 * - MEM-04: 跨实例读取（模拟重启）
 * - MEM-05: 删除记忆
 * - MEM-05b: 删除不存在的记忆
 * - MEM-06: task 类型记忆仅在内存
 * - MEM-07: 文件损坏降级（W-06 记忆透明化）
 * - MEM-08: list 按类型过滤
 * - MEM-09: deleteAll 清空所有记忆
 * - MEM-10: export 导出 JSON
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 * 每个用例通过设置 process.env.HOME 隔离用户全局记忆目录。
 *
 * @module v2/tests/memory/memory-store.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../memory/memory-store";
import type { MemoryStoreData } from "../../memory/types";

// ============================================================================
// 测试 fixture：每个用例独立的临时 HOME 与项目目录
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  // 创建临时 HOME 目录（避免污染真实 ~/.deepcode）
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-memory-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-memory-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  // 还原 HOME 环境变量
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  // 清理临时目录
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(tempProject, { recursive: true, force: true });
});

// ============================================================================
// MEM-01 ~ MEM-10 测试用例
// ============================================================================

test("MEM-01: 添加用户全局记忆并持久化", () => {
  const store = new MemoryStore(tempProject);
  const entry = store.add({
    type: "user_global",
    key: "preferred_language",
    value: "TypeScript",
    confidence: 0.9,
    source: "user_explicit",
  });

  // 验证返回的记忆条目结构完整
  assert.ok(entry.id, "应生成非空 ID");
  assert.equal(entry.type, "user_global");
  assert.equal(entry.key, "preferred_language");
  assert.equal(entry.value, "TypeScript");
  assert.equal(entry.confidence, 0.9);
  assert.equal(entry.source, "user_explicit");
  assert.ok(entry.createdAt, "应填充 createdAt");
  assert.ok(entry.updatedAt, "应填充 updatedAt");

  // 验证持久化到 ~/.deepcode/memory/global.json
  const storePath = path.join(tempHome, ".deepcode", "memory", "global.json");
  assert.ok(fs.existsSync(storePath), "全局记忆文件应存在");
  const data = JSON.parse(fs.readFileSync(storePath, "utf8")) as MemoryStoreData;
  assert.equal(data.entries.length, 1, "持久化文件应包含 1 条记忆");
  assert.equal(data.entries[0]!.id, entry.id);
  assert.equal(data.entries[0]!.value, "TypeScript");
});

test("MEM-02: 添加项目记忆并持久化到项目目录", () => {
  const store = new MemoryStore(tempProject);
  const entry = store.add({
    type: "project",
    key: "test_framework",
    value: "node:test",
    confidence: 0.95,
    source: "auto_extracted",
  });

  assert.ok(entry.id);

  // 验证持久化到项目目录（而非 HOME 目录）
  const projectStorePath = path.join(tempProject, ".deepcode", "memory", "project.json");
  assert.ok(fs.existsSync(projectStorePath), "项目记忆文件应存在于项目目录");

  // 验证 HOME 目录下不应有 project.json
  const homeProjectPath = path.join(tempHome, ".deepcode", "memory", "project.json");
  assert.ok(!fs.existsSync(homeProjectPath), "项目记忆不应写到 HOME 目录");

  const data = JSON.parse(fs.readFileSync(projectStorePath, "utf8")) as MemoryStoreData;
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0]!.key, "test_framework");
});

test("MEM-03: 添加经验记忆并持久化到 experience.json", () => {
  const store = new MemoryStore(tempProject);
  const entry = store.add({
    type: "experience",
    key: "bugfix_pattern",
    value: "先复现后修复，每次只改一处",
    confidence: 0.85,
    source: "auto_extracted",
  });

  assert.ok(entry.id);

  // 验证持久化到 ~/.deepcode/memory/experience.json
  const expPath = path.join(tempHome, ".deepcode", "memory", "experience.json");
  assert.ok(fs.existsSync(expPath), "经验记忆文件应存在");
  const data = JSON.parse(fs.readFileSync(expPath, "utf8")) as MemoryStoreData;
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0]!.value, "先复现后修复，每次只改一处");
});

test("MEM-04: 跨实例读取记忆（模拟重启）", () => {
  // 第一个 store 实例添加记忆
  const store1 = new MemoryStore(tempProject);
  const added = store1.add({
    type: "user_global",
    key: "editor",
    value: "vscode",
    confidence: 0.8,
    source: "user_explicit",
  });

  // 重新创建 store（模拟进程重启后加载持久化文件）
  const store2 = new MemoryStore(tempProject);
  const found = store2.getById(added.id);
  assert.ok(found, "重启后应能通过 ID 找到记忆");
  assert.equal(found?.value, "vscode");
  assert.equal(found?.key, "editor");
});

test("MEM-05: 删除记忆成功", () => {
  const store = new MemoryStore(tempProject);
  const added = store.add({
    type: "user_global",
    key: "temp_key",
    value: "temp_value",
    confidence: 0.5,
    source: "user_explicit",
  });

  const result = store.delete(added.id);
  assert.equal(result.deleted, true);
  assert.ok(result.deletedEntry, "应返回被删除的条目");
  assert.equal(result.deletedEntry?.id, added.id);

  // 验证已删除（getById 返回 null）
  assert.equal(store.getById(added.id), null);

  // 验证持久化文件中已无该条目
  const storePath = path.join(tempHome, ".deepcode", "memory", "global.json");
  const data = JSON.parse(fs.readFileSync(storePath, "utf8")) as MemoryStoreData;
  assert.equal(data.entries.length, 0, "持久化文件中应已清空");
});

test("MEM-05b: 删除不存在的记忆返回失败", () => {
  const store = new MemoryStore(tempProject);
  const result = store.delete("nonexistent-id-12345");
  assert.equal(result.deleted, false);
  assert.ok(result.reason, "应返回失败原因");
  assert.match(result.reason!, /不存在|not found/i);
});

test("MEM-06: task 类型记忆仅在内存（不持久化）", () => {
  const store = new MemoryStore(tempProject);
  const entry = store.add({
    type: "task",
    key: "current_task",
    value: "implementing memory module",
    confidence: 1.0,
    source: "system_default",
  });

  assert.ok(entry.id);

  // task 记忆在 list 中可见
  const list = store.list();
  assert.equal(list.total, 1);
  assert.equal(list.entries[0]!.type, "task");

  // 验证不会写入任何持久化文件
  const globalPath = path.join(tempHome, ".deepcode", "memory", "global.json");
  const expPath = path.join(tempHome, ".deepcode", "memory", "experience.json");
  const projPath = path.join(tempProject, ".deepcode", "memory", "project.json");
  assert.ok(!fs.existsSync(globalPath), "task 记忆不应写入 global.json");
  assert.ok(!fs.existsSync(expPath), "task 记忆不应写入 experience.json");
  assert.ok(!fs.existsSync(projPath), "task 记忆不应写入 project.json");

  // 新实例（模拟重启）不应看到 task 记忆
  const newStore = new MemoryStore(tempProject);
  assert.equal(newStore.list().total, 0, "重启后 task 记忆应消失");
});

test("MEM-07: 记忆文件损坏降级为空存储", () => {
  // 先创建损坏的全局记忆文件
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const globalPath = path.join(memoryDir, "global.json");
  fs.writeFileSync(globalPath, "{ invalid json }", "utf8");

  // 创建 store 应该不崩溃，降级为空存储
  const store = new MemoryStore(tempProject);
  const list = store.list();
  assert.equal(list.total, 0, "损坏文件应降级为空存储");

  // 损坏文件应被重命名为 .corrupted 备份
  assert.ok(fs.existsSync(globalPath + ".corrupted"), "损坏文件应被备份为 .corrupted");
  // 原文件不应再存在（已被 rename 走）
  assert.ok(!fs.existsSync(globalPath), "原损坏文件应已被重命名");

  // 验证可以继续添加新记忆（不因损坏文件而失效）
  store.add({
    type: "user_global",
    key: "after_corruption",
    value: "works",
    confidence: 0.9,
    source: "user_explicit",
  });
  const list2 = store.list();
  assert.equal(list2.total, 1, "降级后应能正常添加新记忆");
});

test("MEM-08: list 按类型过滤", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });
  store.add({
    type: "project",
    key: "k2",
    value: "v2",
    confidence: 0.8,
    source: "auto_extracted",
  });
  store.add({
    type: "user_global",
    key: "k3",
    value: "v3",
    confidence: 0.7,
    source: "user_explicit",
  });
  store.add({
    type: "experience",
    key: "k4",
    value: "v4",
    confidence: 0.6,
    source: "auto_extracted",
  });

  // 全部记忆
  const all = store.list();
  assert.equal(all.total, 4);
  assert.equal(all.byType.user_global, 2);
  assert.equal(all.byType.project, 1);
  assert.equal(all.byType.experience, 1);
  assert.equal(all.byType.task, 0);

  // 仅 user_global
  const globalOnly = store.list("user_global");
  assert.equal(globalOnly.total, 2);
  assert.ok(
    globalOnly.entries.every((e) => e.type === "user_global"),
    "过滤结果应全部为 user_global 类型"
  );

  // 仅 project
  const projectOnly = store.list("project");
  assert.equal(projectOnly.total, 1);
  assert.equal(projectOnly.entries[0]!.key, "k2");

  // 仅 experience
  const expOnly = store.list("experience");
  assert.equal(expOnly.total, 1);
  assert.equal(expOnly.entries[0]!.key, "k4");

  // 仅 task（应为空）
  const taskOnly = store.list("task");
  assert.equal(taskOnly.total, 0);
});

test("MEM-09: deleteAll 清空所有记忆", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });
  store.add({
    type: "project",
    key: "k2",
    value: "v2",
    confidence: 0.8,
    source: "auto_extracted",
  });
  store.add({
    type: "experience",
    key: "k3",
    value: "v3",
    confidence: 0.7,
    source: "auto_extracted",
  });
  store.add({
    type: "task",
    key: "k4",
    value: "v4",
    confidence: 1.0,
    source: "system_default",
  });

  const result = store.deleteAll();
  assert.equal(result.deleted, 4, "应清空 4 条记忆");

  const list = store.list();
  assert.equal(list.total, 0, "清空后应无记忆");

  // 验证持久化文件被重写为空存储（文件仍存在）
  const globalPath = path.join(tempHome, ".deepcode", "memory", "global.json");
  const data = JSON.parse(fs.readFileSync(globalPath, "utf8")) as MemoryStoreData;
  assert.equal(data.entries.length, 0, "持久化文件应被重写为空");
});

test("MEM-10: export 导出 JSON 字符串", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });

  const exported = store.export();
  assert.equal(typeof exported, "string");

  const parsed = JSON.parse(exported) as {
    entries: unknown[];
    version: string;
    lastUpdated: string;
    exportedAt: string;
  };
  assert.ok(Array.isArray(parsed.entries));
  assert.equal(parsed.entries.length, 1);
  assert.ok(typeof parsed.version === "string");
  assert.ok(typeof parsed.lastUpdated === "string");
  assert.ok(typeof parsed.exportedAt === "string");
});

// ============================================================================
// 补充测试：边界条件与错误处理
// ============================================================================

test("MEM-11: 无 projectRoot 时 project 类型记忆应抛错", () => {
  // 不传 projectRoot
  const store = new MemoryStore(null);
  assert.throws(
    () =>
      store.add({
        type: "project",
        key: "k",
        value: "v",
        confidence: 0.5,
        source: "user_explicit",
      }),
    /projectRoot|项目根目录/,
    "无 projectRoot 时添加 project 记忆应抛错"
  );
});

test("MEM-12: confidence 越界应抛错", () => {
  const store = new MemoryStore(tempProject);
  assert.throws(
    () =>
      store.add({
        type: "user_global",
        key: "k",
        value: "v",
        confidence: 1.5,
        source: "user_explicit",
      } as never),
    /confidence/,
    "confidence > 1 应抛错"
  );
  assert.throws(
    () =>
      store.add({
        type: "user_global",
        key: "k",
        value: "v",
        confidence: -0.1,
        source: "user_explicit",
      } as never),
    /confidence/,
    "confidence < 0 应抛错"
  );
});

test("MEM-13: 空字符串 ID 删除返回失败", () => {
  const store = new MemoryStore(tempProject);
  const result = store.delete("");
  assert.equal(result.deleted, false);
  assert.ok(result.reason);
});

test("MEM-14: 空字符串 ID 查找返回 null", () => {
  const store = new MemoryStore(tempProject);
  assert.equal(store.getById(""), null);
});

test("MEM-15: 原子写入保证文件完整性（无 .tmp 残留）", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });
  store.add({
    type: "user_global",
    key: "k2",
    value: "v2",
    confidence: 0.9,
    source: "user_explicit",
  });

  // 验证 .tmp 文件已被清理（rename 后会移走）
  const tmpPath = path.join(tempHome, ".deepcode", "memory", "global.json.tmp");
  assert.ok(!fs.existsSync(tmpPath), "不应残留 .tmp 文件");

  // 验证最终文件包含两条记忆
  const storePath = path.join(tempHome, ".deepcode", "memory", "global.json");
  const data = JSON.parse(fs.readFileSync(storePath, "utf8")) as MemoryStoreData;
  assert.equal(data.entries.length, 2);
});

test("MEM-16: 持久化文件包含 version 与 lastUpdated 字段", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });

  const storePath = path.join(tempHome, ".deepcode", "memory", "global.json");
  const data = JSON.parse(fs.readFileSync(storePath, "utf8")) as MemoryStoreData;
  assert.ok(typeof data.version === "string", "应有 version 字段");
  assert.ok(data.version.length > 0);
  assert.ok(typeof data.lastUpdated === "string", "应有 lastUpdated 字段");
  // lastUpdated 应为合法 ISO 8601
  assert.ok(!Number.isNaN(Date.parse(data.lastUpdated)));
});

test("MEM-17: 损坏的 .corrupted 已存在时追加时间戳后缀", () => {
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const globalPath = path.join(memoryDir, "global.json");
  const corruptedPath = globalPath + ".corrupted";

  // 先放一个旧的 .corrupted 文件
  fs.writeFileSync(corruptedPath, "old corrupted content", "utf8");
  // 再写入损坏的 global.json
  fs.writeFileSync(globalPath, "{ invalid json }", "utf8");

  const store = new MemoryStore(tempProject);
  const list = store.list();
  assert.equal(list.total, 0, "损坏文件应降级为空存储");

  // 旧的 .corrupted 仍在
  assert.ok(fs.existsSync(corruptedPath), "旧 .corrupted 应保留");
  // 原损坏文件应被重命名为带时间戳的备份
  const dirEnts = fs.readdirSync(memoryDir);
  const corruptedBackups = dirEnts.filter((n) => n.startsWith("global.json.corrupted"));
  assert.ok(corruptedBackups.length >= 2, "应有至少 2 个 corrupted 备份文件");
});
