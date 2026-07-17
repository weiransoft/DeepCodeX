/**
 * /memory 命令处理器单元测试
 *
 * 测试覆盖 /memory 各子命令的行为：
 * - /memory list（空记忆、有记忆、类型过滤、无效类型）
 * - /memory delete（成功、ID 不存在、缺少参数）
 * - /memory review（空记忆、有记忆）
 * - /memory export（导出 JSON）
 * - /memory help（帮助内容）
 * - /memory 未知子命令
 * - /memory 无参数（等价于 help）
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 *
 * @module v2/tests/memory/memory-commands.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../memory/memory-store";
import { handleMemoryCommand } from "../../memory/memory-commands";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-cmd-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-cmd-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(tempProject, { recursive: true, force: true });
});

// ============================================================================
// /memory list 测试
// ============================================================================

test("/memory list 空记忆显示提示", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("list", store);
  assert.equal(result.success, true);
  assert.match(result.output, /暂无记忆|empty|no memory/i);
});

test("/memory list 显示已有记忆", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "lang",
    value: "TypeScript",
    confidence: 0.9,
    source: "user_explicit",
  });

  const result = handleMemoryCommand("list", store);
  assert.equal(result.success, true);
  assert.match(result.output, /TypeScript/, "输出应包含值");
  assert.match(result.output, /lang/, "输出应包含键");
  assert.match(result.output, /共\s*1\s*条记忆/, "输出应显示总数");
});

test("/memory list 按类型过滤", () => {
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

  // 过滤 user_global
  const result = handleMemoryCommand("list user_global", store);
  assert.equal(result.success, true);
  assert.match(result.output, /v1/);
  assert.doesNotMatch(result.output, /v2/);
});

test("/memory list 无效类型返回失败", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("list invalid_type", store);
  assert.equal(result.success, false);
  assert.match(result.output, /无效|invalid/i);
});

// ============================================================================
// /memory delete 测试
// ============================================================================

test("/memory delete <id> 删除指定记忆", () => {
  const store = new MemoryStore(tempProject);
  const entry = store.add({
    type: "user_global",
    key: "temp",
    value: "val",
    confidence: 0.5,
    source: "user_explicit",
  });

  const result = handleMemoryCommand(`delete ${entry.id}`, store);
  assert.equal(result.success, true);
  assert.match(result.output, /删除成功|deleted/i);

  // 验证已删除
  assert.equal(store.getById(entry.id), null);
});

test("/memory delete 不存在的 ID 返回失败", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("delete nonexistent-id", store);
  assert.equal(result.success, false);
  assert.match(result.output, /不存在|not found|失败/i);
});

test("/memory delete 缺少 ID 参数返回用法提示", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("delete", store);
  assert.equal(result.success, false);
  assert.match(result.output, /用法|usage/i);
});

// ============================================================================
// /memory review 测试
// ============================================================================

test("/memory review 空记忆显示提示", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("review", store);
  assert.equal(result.success, true);
  assert.match(result.output, /暂无记忆|empty/i);
});

test("/memory review 显示最近记忆", () => {
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

  const result = handleMemoryCommand("review", store);
  assert.equal(result.success, true);
  assert.match(result.output, /最近.*\d+.*条记忆/);
  assert.match(result.output, /v1/);
  assert.match(result.output, /v2/);
});

// ============================================================================
// /memory export 测试
// ============================================================================

test("/memory export 导出 JSON 字符串", () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });

  const result = handleMemoryCommand("export", store);
  assert.equal(result.success, true);
  assert.ok(result.output.length > 0);

  // 输出应为合法 JSON
  const parsed = JSON.parse(result.output);
  assert.ok(Array.isArray(parsed.entries));
  assert.equal(parsed.entries.length, 1);
});

test("/memory export 空记忆也能导出", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("export", store);
  assert.equal(result.success, true);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.entries.length, 0);
});

// ============================================================================
// /memory help 测试
// ============================================================================

test("/memory help 显示帮助信息", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("help", store);
  assert.equal(result.success, true);
  assert.match(result.output, /list/);
  assert.match(result.output, /delete/);
  assert.match(result.output, /review/);
  assert.match(result.output, /export/);
});

test("/memory 无参数等价于 help", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("", store);
  assert.equal(result.success, true);
  assert.match(result.output, /list/);
  assert.match(result.output, /delete/);
});

// ============================================================================
// 未知子命令测试
// ============================================================================

test("/memory 未知子命令返回失败", () => {
  const store = new MemoryStore(tempProject);
  const result = handleMemoryCommand("unknown", store);
  assert.equal(result.success, false);
  assert.match(result.output, /未知|unknown/i);
});

test("/memory delete 后再 list 应反映删除结果", () => {
  const store = new MemoryStore(tempProject);
  const e1 = store.add({
    type: "user_global",
    key: "keep",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });
  const e2 = store.add({
    type: "user_global",
    key: "delete_me",
    value: "v2",
    confidence: 0.5,
    source: "user_explicit",
  });

  // 删除前
  const before = handleMemoryCommand("list", store);
  assert.match(before.output, /共\s*2\s*条记忆/);

  // 删除 e2
  const del = handleMemoryCommand(`delete ${e2.id}`, store);
  assert.equal(del.success, true);

  // 删除后
  const after = handleMemoryCommand("list", store);
  assert.match(after.output, /共\s*1\s*条记忆/);
  assert.match(after.output, /keep/);
  assert.doesNotMatch(after.output, /delete_me/);

  // 验证 e1 仍存在
  assert.ok(store.getById(e1.id));
});
