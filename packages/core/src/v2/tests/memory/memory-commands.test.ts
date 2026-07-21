/**
 * /memory 命令处理器单元测试
 *
 * 测试覆盖 /memory 各子命令的行为：
 * - /memory list（空记忆、有记忆、类型过滤、无效类型）
 * - /memory delete（成功、ID 不存在、缺少参数）
 * - /memory delete-all（无确认令牌、正确令牌、错误令牌、未注入 privacyManager）
 * - /memory review（空记忆、有记忆）
 * - /memory export（导出 JSON）
 * - /memory help（帮助内容含 delete-all 说明）
 * - /memory 未知子命令
 * - /memory 无参数（等价于 help）
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 *
 * v2.8 P0-2 更新（2026-07-21）：
 *   - handleMemoryCommand 签名改为 async，所有测试用 await 调用
 *   - 新增 delete-all 子命令相关测试（含 InvalidConfirmTokenError 捕获验证）
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
import { MemoryPrivacyManager } from "../../memory/privacy-manager";

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

test("/memory list 空记忆显示提示", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("list", store);
  assert.equal(result.success, true);
  assert.match(result.output, /暂无记忆|empty|no memory/i);
});

test("/memory list 显示已有记忆", async () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "lang",
    value: "TypeScript",
    confidence: 0.9,
    source: "user_explicit",
  });

  const result = await handleMemoryCommand("list", store);
  assert.equal(result.success, true);
  assert.match(result.output, /TypeScript/, "输出应包含值");
  assert.match(result.output, /lang/, "输出应包含键");
  assert.match(result.output, /共\s*1\s*条记忆/, "输出应显示总数");
});

test("/memory list 按类型过滤", async () => {
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
  const result = await handleMemoryCommand("list user_global", store);
  assert.equal(result.success, true);
  assert.match(result.output, /v1/);
  assert.doesNotMatch(result.output, /v2/);
});

test("/memory list 无效类型返回失败", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("list invalid_type", store);
  assert.equal(result.success, false);
  assert.match(result.output, /无效|invalid/i);
});

// ============================================================================
// /memory delete 测试
// ============================================================================

test("/memory delete <id> 删除指定记忆", async () => {
  const store = new MemoryStore(tempProject);
  const entry = store.add({
    type: "user_global",
    key: "temp",
    value: "val",
    confidence: 0.5,
    source: "user_explicit",
  });

  const result = await handleMemoryCommand(`delete ${entry.id}`, store);
  assert.equal(result.success, true);
  assert.match(result.output, /删除成功|deleted/i);

  // 验证已删除
  assert.equal(store.getById(entry.id), null);
});

test("/memory delete 不存在的 ID 返回失败", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("delete nonexistent-id", store);
  assert.equal(result.success, false);
  assert.match(result.output, /不存在|not found|失败/i);
});

test("/memory delete 缺少 ID 参数返回用法提示", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("delete", store);
  assert.equal(result.success, false);
  assert.match(result.output, /用法|usage/i);
});

// ============================================================================
// /memory delete-all 测试（v2.8 P0-2 新增）
// ============================================================================

test("/memory delete-all 未提供确认令牌返回提示", async () => {
  const store = new MemoryStore(tempProject);
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  const projectMemoryDir = path.join(tempProject, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const privacyManager = new MemoryPrivacyManager(memoryDir, projectMemoryDir);

  const result = await handleMemoryCommand("delete-all", store, privacyManager);
  assert.equal(result.success, false, "未提供确认令牌应返回 success=false");
  assert.match(result.output, /不可恢复|DELETE ALL/, "应提示用户使用 DELETE ALL 令牌");
});

test("/memory delete-all 正确确认令牌删除全部文件", async () => {
  const store = new MemoryStore(tempProject);
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  const projectMemoryDir = path.join(tempProject, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(projectMemoryDir, { recursive: true });

  // 准备测试文件：在 memoryDir 下放 3 个文件（含 redaction.log 和 export-*.json）
  const file1 = path.join(memoryDir, "global.json");
  const file2 = path.join(memoryDir, "redaction.log");
  const file3 = path.join(memoryDir, "export-20260721-000000-000.json");
  fs.writeFileSync(file1, '{"facts":[]}', "utf8");
  fs.writeFileSync(file2, "log entry\n", "utf8");
  fs.writeFileSync(file3, '{"schemaVersion":1}', "utf8");

  const privacyManager = new MemoryPrivacyManager(memoryDir, projectMemoryDir);

  const result = await handleMemoryCommand("delete-all DELETE ALL", store, privacyManager);
  assert.equal(result.success, true, "正确令牌应返回 success=true");
  assert.match(result.output, /已删除全部记忆文件/, "输出应包含成功提示");

  // 验证 data 字段为 DeleteReport
  const report = result.data as { deletedCount: number; deletedFiles: string[] };
  assert.equal(report.deletedCount, 3, "应删除 3 个文件");
  assert.equal(report.deletedFiles.length, 3);

  // 验证文件已被删除
  for (const f of [file1, file2, file3]) {
    assert.equal(fs.existsSync(f), false, `文件应已被删除: ${f}`);
  }
});

test("/memory delete-all 错误确认令牌不删除任何文件", async () => {
  const store = new MemoryStore(tempProject);
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  const projectMemoryDir = path.join(tempProject, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });

  // 准备测试文件
  const file1 = path.join(memoryDir, "global.json");
  fs.writeFileSync(file1, '{"facts":[]}', "utf8");

  const privacyManager = new MemoryPrivacyManager(memoryDir, projectMemoryDir);

  // 使用小写令牌（应被拒绝）
  const result = await handleMemoryCommand("delete-all delete all", store, privacyManager);
  assert.equal(result.success, false, "错误令牌应返回 success=false");
  assert.match(result.output, /确认令牌无效|InvalidConfirmTokenError/i, "应提示令牌无效");

  // 验证文件未被删除（零文件被删除，由 privacy-manager 保证）
  assert.equal(fs.existsSync(file1), true, "错误令牌不应删除任何文件");
});

test("/memory delete-all 大小写敏感（DELETE ALL 与 delete all 不同）", async () => {
  const store = new MemoryStore(tempProject);
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  const projectMemoryDir = path.join(tempProject, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });

  const file1 = path.join(memoryDir, "global.json");
  fs.writeFileSync(file1, '{"facts":[]}', "utf8");

  const privacyManager = new MemoryPrivacyManager(memoryDir, projectMemoryDir);

  // 测试多种错误形式（注意：CLI 入口已 trim 整个 args 字符串，
  // 前导/尾随空格会被去除，所以不测试 " DELETE ALL" / "DELETE ALL " 这类空格变体；
  // 仅测试大小写错误、缺少空格、子命令名作为令牌、多余参数等情况）
  const wrongTokens = [
    "delete all", // 小写
    "Delete All", // 混合大小写
    "DELETEALL", // 无空格
    "delete-all", // 子命令名作为令牌
    "DELETE ALL extra", // 多余参数
    "confirm", // 完全错误的令牌
  ];
  for (const token of wrongTokens) {
    const result = await handleMemoryCommand(`delete-all ${token}`, store, privacyManager);
    assert.equal(result.success, false, `错误令牌应失败: ${token}`);
  }

  // 验证文件未被删除
  assert.equal(fs.existsSync(file1), true, "所有错误令牌都不应删除文件");
});

test("/memory delete-all 未注入 privacyManager 返回不可用", async () => {
  const store = new MemoryStore(tempProject);

  // 不传入 privacyManager（第三参数）
  const result = await handleMemoryCommand("delete-all DELETE ALL", store);
  assert.equal(result.success, false, "未注入 privacyManager 应返回 success=false");
  assert.match(result.output, /不可用|未配置 MemoryPrivacyManager/, "应提示不可用原因");
});

test("/memory delete-all 空目录返回 deletedCount=0", async () => {
  const store = new MemoryStore(tempProject);
  const memoryDir = path.join(tempHome, ".deepcode", "memory");
  const projectMemoryDir = path.join(tempProject, ".deepcode", "memory");
  fs.mkdirSync(memoryDir, { recursive: true }); // 空目录
  const privacyManager = new MemoryPrivacyManager(memoryDir, projectMemoryDir);

  const result = await handleMemoryCommand("delete-all DELETE ALL", store, privacyManager);
  assert.equal(result.success, true, "空目录应返回 success=true（幂等）");
  const report = result.data as { deletedCount: number };
  assert.equal(report.deletedCount, 0, "空目录 deletedCount=0");
});

// ============================================================================
// /memory review 测试
// ============================================================================

test("/memory review 空记忆显示提示", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("review", store);
  assert.equal(result.success, true);
  assert.match(result.output, /暂无记忆|empty/i);
});

test("/memory review 显示最近记忆", async () => {
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

  const result = await handleMemoryCommand("review", store);
  assert.equal(result.success, true);
  assert.match(result.output, /最近.*\d+.*条记忆/);
  assert.match(result.output, /v1/);
  assert.match(result.output, /v2/);
});

// ============================================================================
// /memory export 测试
// ============================================================================

test("/memory export 导出 JSON 字符串", async () => {
  const store = new MemoryStore(tempProject);
  store.add({
    type: "user_global",
    key: "k1",
    value: "v1",
    confidence: 0.9,
    source: "user_explicit",
  });

  const result = await handleMemoryCommand("export", store);
  assert.equal(result.success, true);
  assert.ok(result.output.length > 0);

  // 输出应为合法 JSON
  const parsed = JSON.parse(result.output);
  assert.ok(Array.isArray(parsed.entries));
  assert.equal(parsed.entries.length, 1);
});

test("/memory export 空记忆也能导出", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("export", store);
  assert.equal(result.success, true);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.entries.length, 0);
});

// ============================================================================
// /memory help 测试
// ============================================================================

test("/memory help 显示帮助信息（含 delete-all）", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("help", store);
  assert.equal(result.success, true);
  assert.match(result.output, /list/);
  assert.match(result.output, /delete/);
  assert.match(result.output, /delete-all/, "帮助应包含 delete-all 子命令说明");
  assert.match(result.output, /review/);
  assert.match(result.output, /export/);
});

test("/memory 无参数等价于 help", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("", store);
  assert.equal(result.success, true);
  assert.match(result.output, /list/);
  assert.match(result.output, /delete/);
});

// ============================================================================
// 未知子命令测试
// ============================================================================

test("/memory 未知子命令返回失败", async () => {
  const store = new MemoryStore(tempProject);
  const result = await handleMemoryCommand("unknown", store);
  assert.equal(result.success, false);
  assert.match(result.output, /未知|unknown/i);
});

test("/memory delete 后再 list 应反映删除结果", async () => {
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
  const before = await handleMemoryCommand("list", store);
  assert.match(before.output, /共\s*2\s*条记忆/);

  // 删除 e2
  const del = await handleMemoryCommand(`delete ${e2.id}`, store);
  assert.equal(del.success, true);

  // 删除后
  const after = await handleMemoryCommand("list", store);
  assert.match(after.output, /共\s*1\s*条记忆/);
  assert.match(after.output, /keep/);
  assert.doesNotMatch(after.output, /delete_me/);

  // 验证 e1 仍存在
  assert.ok(store.getById(e1.id));
});
