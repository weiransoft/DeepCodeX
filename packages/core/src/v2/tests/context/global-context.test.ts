/**
 * GlobalContextManager 单元测试（F-CTX-01）
 *
 * 测试覆盖：
 * - GC-01: load 文件不存在返回默认空上下文（首启友好）
 * - GC-02: load 文件存在且合法返回解析后的上下文
 * - GC-03: load 文件损坏降级返回默认空上下文并备份原文件
 * - GC-04: save 基本保存（写入文件可被再次 load）
 * - GC-05: save 原子写入（.tmp 临时文件不残留）
 * - GC-06: save version 自增 + lastUpdatedAt 更新
 * - GC-07: migrate schemaVersion 兼容（旧版本字段保留）
 * - GC-08: migrate 缺失字段补全（部分嵌套结构缺失时自动补全）
 * - GC-09: addSuccessExperience 容量上限 LRU 淘汰
 * - GC-10: addFailureExperience 容量上限 LRU 淘汰
 * - GC-11: addExperiencePattern 容量上限按 confidence 淘汰
 * - GC-12: recordExperienceAccess 自增 accessCount 并更新 lastAccessedAt
 * - GC-13: update 读-改-写原子操作
 * - GC-14: load 非对象 JSON 降级（数组/字符串/数字）
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 * 通过自定义 filePath 构造 GlobalContextManager，避免污染真实 ~/.deepcode。
 *
 * @module v2/tests/context/global-context.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  GlobalContextManager,
  createDefaultGlobalContext,
  SCHEMA_VERSION,
  MAX_SUCCESS_EXPERIENCES,
  MAX_FAILURE_EXPERIENCES,
  MAX_EXPERIENCE_PATTERNS,
} from "../../context/global-context";
import type {
  GlobalContext,
  SuccessExperience,
  FailureExperience,
  ExperiencePattern,
} from "../../context/global-context";

// ============================================================================
// 测试 fixture：每个用例独立的临时目录与文件路径
// ============================================================================

let tempDir: string;
let contextFilePath: string;

beforeEach(() => {
  // 创建临时目录（避免污染真实 ~/.deepcode）
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-global-context-"));
  contextFilePath = path.join(tempDir, "global-context.json");
});

afterEach(() => {
  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助工厂：构造测试用经验条目
// ============================================================================

/**
 * 创建测试用成功经验条目
 *
 * @param overrides 部分字段覆盖（默认值见实现）
 * @returns 完整的 SuccessExperience 对象
 */
function createSuccessExp(overrides: Partial<SuccessExperience> = {}): SuccessExperience {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    taskType: "bugfix",
    description: "修复内存泄漏",
    solution: "释放事件监听器",
    tags: ["memory"],
    importance: 5,
    createdAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

/**
 * 创建测试用失败经验条目
 *
 * @param overrides 部分字段覆盖
 * @returns 完整的 FailureExperience 对象
 */
function createFailureExp(overrides: Partial<FailureExperience> = {}): FailureExperience {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    taskType: "feature",
    description: "实现登录功能失败",
    failureReason: "未处理 token 过期",
    lessonLearned: "需要处理 token 刷新",
    tags: ["auth"],
    importance: 5,
    createdAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

/**
 * 创建测试用经验模式条目
 *
 * @param overrides 部分字段覆盖
 * @returns 完整的 ExperiencePattern 对象
 */
function createPattern(overrides: Partial<ExperiencePattern> = {}): ExperiencePattern {
  return {
    id: crypto.randomUUID(),
    pattern: "错误处理模式",
    applicableScenarios: ["网络请求"],
    counterExamples: ["本地计算"],
    confidence: 0.5,
    ...overrides,
  };
}

// ============================================================================
// GC-01 ~ GC-14 测试用例
// ============================================================================

test("GC-01: load 文件不存在返回默认空上下文（首启友好）", () => {
  const manager = new GlobalContextManager(contextFilePath);
  const ctx = manager.load("default");

  // 验证返回默认空上下文
  assert.equal(ctx.schemaVersion, SCHEMA_VERSION);
  assert.equal(ctx.userId, "default");
  assert.equal(ctx.version, 0);
  assert.deepEqual(ctx.historicalExperience.successExperiences, []);
  assert.deepEqual(ctx.historicalExperience.failureExperiences, []);
  assert.deepEqual(ctx.historicalExperience.experiencePatterns, []);
  assert.deepEqual(ctx.userProfile.frameworkPreferences, []);

  // 验证未创建文件（首启友好，不主动创建文件）
  assert.equal(fs.existsSync(contextFilePath), false);
});

test("GC-02: load 文件存在且合法返回解析后的上下文", () => {
  // 先写入一个合法的上下文文件
  const manager = new GlobalContextManager(contextFilePath);
  const originalCtx = createDefaultGlobalContext("test-user");
  originalCtx.historicalExperience.successExperiences.push(createSuccessExp({ description: "测试经验" }));
  manager.save(originalCtx);

  // 重新加载并验证
  const loaded = manager.load("test-user");
  assert.equal(loaded.userId, "test-user");
  assert.equal(loaded.historicalExperience.successExperiences.length, 1);
  assert.equal(loaded.historicalExperience.successExperiences[0].description, "测试经验");
  // save 自增 version，load 不自增
  assert.equal(loaded.version, 1);
});

test("GC-03: load 文件损坏降级返回默认空上下文并备份原文件", () => {
  // 写入损坏的 JSON
  fs.mkdirSync(path.dirname(contextFilePath), { recursive: true });
  fs.writeFileSync(contextFilePath, "{invalid json content", "utf-8");

  const manager = new GlobalContextManager(contextFilePath);
  const ctx = manager.load("default");

  // 验证降级返回默认空上下文
  assert.equal(ctx.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(ctx.historicalExperience.successExperiences, []);

  // 验证原文件被备份为 .corrupted.<timestamp>
  const files = fs.readdirSync(tempDir);
  const corruptedBackups = files.filter((f) => f.includes(".corrupted."));
  assert.equal(corruptedBackups.length, 1, "应生成 1 个 .corrupted 备份文件");
});

test("GC-04: save 基本保存（写入文件可被再次 load）", () => {
  const manager = new GlobalContextManager(contextFilePath);
  const ctx = createDefaultGlobalContext("default");
  ctx.userProfile.frameworkPreferences = ["react", "express"];
  manager.save(ctx);

  // 验证文件已创建
  assert.equal(fs.existsSync(contextFilePath), true);

  // 验证内容可被再次 load
  const loaded = manager.load("default");
  assert.deepEqual(loaded.userProfile.frameworkPreferences, ["react", "express"]);
});

test("GC-05: save 原子写入（.tmp 临时文件不残留）", () => {
  const manager = new GlobalContextManager(contextFilePath);
  const ctx = createDefaultGlobalContext("default");
  manager.save(ctx);

  // 验证 .tmp 临时文件已被 rename 清理
  const tmpPath = contextFilePath + ".tmp";
  assert.equal(fs.existsSync(tmpPath), false, "不应残留 .tmp 文件");

  // 验证目标文件存在且内容合法
  assert.equal(fs.existsSync(contextFilePath), true);
  const content = fs.readFileSync(contextFilePath, "utf-8");
  assert.doesNotThrow(() => JSON.parse(content));
});

test("GC-06: save version 自增 + lastUpdatedAt 更新", () => {
  const manager = new GlobalContextManager(contextFilePath);
  const ctx = createDefaultGlobalContext("default");
  const originalVersion = ctx.version;
  const originalTimestamp = ctx.lastUpdatedAt;

  // 等待 10ms 确保时间戳不同
  const beforeSave = Date.now();
  manager.save(ctx);
  const afterSave = Date.now();

  // 重新 load 验证
  const loaded = manager.load("default");
  assert.equal(loaded.version, originalVersion + 1, "version 应自增 1");

  // 验证 lastUpdatedAt 已更新（ISO 字符串解析为时间戳比较）
  const loadedTime = new Date(loaded.lastUpdatedAt).getTime();
  const originalTime = new Date(originalTimestamp).getTime();
  assert.ok(loadedTime >= originalTime, "lastUpdatedAt 应更新");
  assert.ok(loadedTime >= beforeSave && loadedTime <= afterSave, "lastUpdatedAt 应为 save 时刻");
});

test("GC-07: migrate schemaVersion 兼容（旧版本字段保留）", () => {
  // 模拟旧版本文件（schemaVersion=0，但其他字段完整）
  const oldData: GlobalContext = {
    ...createDefaultGlobalContext("default"),
    schemaVersion: 0,
  };
  fs.mkdirSync(path.dirname(contextFilePath), { recursive: true });
  fs.writeFileSync(contextFilePath, JSON.stringify(oldData, null, 2), "utf-8");

  const manager = new GlobalContextManager(contextFilePath);
  const loaded = manager.load("default");

  // 验证 schemaVersion 被升级为最新
  assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
  // 验证其他字段保留
  assert.equal(loaded.userId, "default");
});

test("GC-08: migrate 缺失字段补全（部分嵌套结构缺失时自动补全）", () => {
  // 模拟字段缺失的文件（只有顶层 schemaVersion 和 userId）
  const partialData = {
    schemaVersion: 1,
    userId: "partial-user",
  };
  fs.mkdirSync(path.dirname(contextFilePath), { recursive: true });
  fs.writeFileSync(contextFilePath, JSON.stringify(partialData, null, 2), "utf-8");

  const manager = new GlobalContextManager(contextFilePath);
  const loaded = manager.load("partial-user");

  // 验证缺失字段被补全为默认值
  assert.equal(loaded.userId, "partial-user");
  assert.ok(loaded.historicalExperience, "historicalExperience 应被补全");
  assert.deepEqual(loaded.historicalExperience.successExperiences, []);
  assert.ok(loaded.userProfile, "userProfile 应被补全");
  assert.ok(loaded.domainKnowledge, "domainKnowledge 应被补全");
  assert.ok(loaded.collaborationNetwork, "collaborationNetwork 应被补全");
  assert.ok(loaded.capabilityModel, "capabilityModel 应被补全");
});

test("GC-09: addSuccessExperience 容量上限 LRU 淘汰", () => {
  const manager = new GlobalContextManager(contextFilePath);

  // 插入 MAX_SUCCESS_EXPERIENCES + 5 条经验
  // 前 5 条 accessCount 设为 0（应被淘汰），后 100 条 accessCount 设为 10（应保留）
  for (let i = 0; i < 5; i++) {
    manager.addSuccessExperience(
      "default",
      createSuccessExp({
        id: `to-evict-${i}`,
        description: `应被淘汰 ${i}`,
        accessCount: 0,
        lastAccessedAt: "2020-01-01T00:00:00.000Z",
      })
    );
  }
  for (let i = 0; i < MAX_SUCCESS_EXPERIENCES; i++) {
    manager.addSuccessExperience(
      "default",
      createSuccessExp({
        id: `to-keep-${i}`,
        description: `应保留 ${i}`,
        accessCount: 10,
        lastAccessedAt: "2025-07-17T00:00:00.000Z",
      })
    );
  }

  // 重新 load 验证
  const loaded = manager.load("default");
  assert.equal(
    loaded.historicalExperience.successExperiences.length,
    MAX_SUCCESS_EXPERIENCES,
    `应保留 ${MAX_SUCCESS_EXPERIENCES} 条`
  );

  // 验证 accessCount 低的被淘汰
  const evictedIds = loaded.historicalExperience.successExperiences.map((e) => e.id);
  for (let i = 0; i < 5; i++) {
    assert.equal(evictedIds.includes(`to-evict-${i}`), false, `to-evict-${i} 应被淘汰`);
  }
  // 验证 accessCount 高的保留
  assert.equal(evictedIds.includes("to-keep-0"), true, "to-keep-0 应保留");
});

test("GC-10: addFailureExperience 容量上限 LRU 淘汰", () => {
  const manager = new GlobalContextManager(contextFilePath);

  // 插入 MAX_FAILURE_EXPERIENCES + 3 条失败经验
  // 前 3 条 accessCount=0 + 老时间（应淘汰），后 100 条 accessCount=5 + 新时间（应保留）
  for (let i = 0; i < 3; i++) {
    manager.addFailureExperience(
      "default",
      createFailureExp({
        id: `fail-evict-${i}`,
        accessCount: 0,
        lastAccessedAt: "2019-01-01T00:00:00.000Z",
      })
    );
  }
  for (let i = 0; i < MAX_FAILURE_EXPERIENCES; i++) {
    manager.addFailureExperience(
      "default",
      createFailureExp({
        id: `fail-keep-${i}`,
        accessCount: 5,
        lastAccessedAt: "2025-07-17T00:00:00.000Z",
      })
    );
  }

  const loaded = manager.load("default");
  assert.equal(
    loaded.historicalExperience.failureExperiences.length,
    MAX_FAILURE_EXPERIENCES,
    `应保留 ${MAX_FAILURE_EXPERIENCES} 条`
  );

  // 验证低 accessCount 的被淘汰
  const ids = loaded.historicalExperience.failureExperiences.map((e) => e.id);
  for (let i = 0; i < 3; i++) {
    assert.equal(ids.includes(`fail-evict-${i}`), false, `fail-evict-${i} 应被淘汰`);
  }
});

test("GC-11: addExperiencePattern 容量上限按 confidence 淘汰", () => {
  const manager = new GlobalContextManager(contextFilePath);

  // 插入 MAX_EXPERIENCE_PATTERNS + 3 条模式
  // 前 3 条 confidence=0.1（应淘汰），后 50 条 confidence=0.8（应保留）
  for (let i = 0; i < 3; i++) {
    manager.addExperiencePattern(
      "default",
      createPattern({
        id: `pat-low-${i}`,
        confidence: 0.1,
      })
    );
  }
  for (let i = 0; i < MAX_EXPERIENCE_PATTERNS; i++) {
    manager.addExperiencePattern(
      "default",
      createPattern({
        id: `pat-high-${i}`,
        confidence: 0.8,
      })
    );
  }

  const loaded = manager.load("default");
  assert.equal(
    loaded.historicalExperience.experiencePatterns.length,
    MAX_EXPERIENCE_PATTERNS,
    `应保留 ${MAX_EXPERIENCE_PATTERNS} 条`
  );

  // 验证低 confidence 的被淘汰
  const ids = loaded.historicalExperience.experiencePatterns.map((p) => p.id);
  for (let i = 0; i < 3; i++) {
    assert.equal(ids.includes(`pat-low-${i}`), false, `pat-low-${i} 应被淘汰（confidence 低）`);
  }
});

test("GC-12: recordExperienceAccess 自增 accessCount 并更新 lastAccessedAt", () => {
  const manager = new GlobalContextManager(contextFilePath);
  const expId = "exp-access-test";
  const originalTime = "2020-01-01T00:00:00.000Z";

  // 插入一条经验，accessCount=0
  manager.addSuccessExperience(
    "default",
    createSuccessExp({
      id: expId,
      accessCount: 0,
      lastAccessedAt: originalTime,
    })
  );

  // 记录访问
  const beforeRecord = Date.now();
  manager.recordExperienceAccess("default", expId);
  const afterRecord = Date.now();

  // 验证 accessCount 自增 + lastAccessedAt 更新
  const loaded = manager.load("default");
  const exp = loaded.historicalExperience.successExperiences.find((e) => e.id === expId);
  assert.ok(exp, "经验应存在");
  assert.equal(exp.accessCount, 1, "accessCount 应自增为 1");

  const accessedTime = new Date(exp.lastAccessedAt).getTime();
  assert.ok(accessedTime >= beforeRecord && accessedTime <= afterRecord, "lastAccessedAt 应为当前时间");
  assert.ok(new Date(exp.lastAccessedAt).getTime() > new Date(originalTime).getTime(), "lastAccessedAt 应更新");
});

test("GC-13: update 读-改-写原子操作", () => {
  const manager = new GlobalContextManager(contextFilePath);

  // 通过 update 修改 userProfile
  const updated = manager.update("default", (ctx) => {
    ctx.userProfile.frameworkPreferences = ["vue", "nuxt"];
    ctx.userProfile.codeStyle.indent = "4space";
    return ctx;
  });

  // 验证返回值反映修改
  assert.deepEqual(updated.userProfile.frameworkPreferences, ["vue", "nuxt"]);
  assert.equal(updated.userProfile.codeStyle.indent, "4space");

  // 验证修改已持久化
  const loaded = manager.load("default");
  assert.deepEqual(loaded.userProfile.frameworkPreferences, ["vue", "nuxt"]);
  assert.equal(loaded.userProfile.codeStyle.indent, "4space");
});

test("GC-14: load 非对象 JSON 降级（数组/字符串/数字）", () => {
  const manager = new GlobalContextManager(contextFilePath);

  // 测试数组
  fs.mkdirSync(path.dirname(contextFilePath), { recursive: true });
  fs.writeFileSync(contextFilePath, "[1, 2, 3]", "utf-8");
  let ctx = manager.load("default");
  assert.equal(ctx.schemaVersion, SCHEMA_VERSION, "数组 JSON 应降级为默认空上下文");
  assert.deepEqual(ctx.historicalExperience.successExperiences, []);

  // 测试字符串
  fs.writeFileSync(contextFilePath, '"hello"', "utf-8");
  ctx = manager.load("default");
  assert.equal(ctx.schemaVersion, SCHEMA_VERSION, "字符串 JSON 应降级为默认空上下文");

  // 测试数字
  fs.writeFileSync(contextFilePath, "42", "utf-8");
  ctx = manager.load("default");
  assert.equal(ctx.schemaVersion, SCHEMA_VERSION, "数字 JSON 应降级为默认空上下文");
});
