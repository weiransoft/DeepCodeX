/**
 * ProjectMemoryManager 单元测试（F-MEM-02）
 *
 * 测试覆盖：
 * - PM-01: getProjectMemory 文件不存在返回默认空记忆（首启友好）
 * - PM-02: getProjectMemory 文件存在合法返回解析后的记忆
 * - PM-03: getProjectMemory 文件损坏降级并备份原文件
 * - PM-04: updateProjectMemory 原子写入（.tmp 不残留）
 * - PM-05: initializeFromUnderstanding 从理解结果初始化
 * - PM-06: addHistoryEntry 添加历史条目
 * - PM-07: addKnownIssue 添加已知问题
 * - PM-08: addKnownIssue fingerprint 去重（幂等）
 * - PM-09: resolveKnownIssue 标记问题为已解决
 * - PM-10: .deepcode 目录自动创建 + .gitignore 排除自身
 * - PM-11: 容量上限维护（历史条目超限淘汰）
 * - PM-12: 损坏文件降级后可正常重建
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 *
 * @module v2/tests/memory/project-memory.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  ProjectMemoryManager,
  createDefaultProjectMemory,
  generateProjectId,
  generateIssueFingerprint,
  MAX_PROJECT_HISTORY,
  MAX_KNOWN_ISSUES,
} from "../../memory/project-memory";
import type { ProjectMemory, KnownIssue, ProjectUnderstandingInput } from "../../memory/project-memory";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempProject: string;

beforeEach(() => {
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-project-memory-"));
});

afterEach(() => {
  fs.rmSync(tempProject, { recursive: true, force: true });
});

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建测试用已知问题
 *
 * @param overrides 部分字段覆盖
 * @returns 完整的 KnownIssue 对象
 */
function createKnownIssue(overrides: Partial<KnownIssue> = {}): KnownIssue {
  const filePath = overrides.filePath ?? "src/app.ts";
  const line = overrides.line ?? 42;
  const description = overrides.description ?? "类型错误";
  return {
    id: crypto.randomUUID(),
    fingerprint: generateIssueFingerprint(filePath, line, description),
    filePath,
    line,
    description,
    workaround: "添加类型注解",
    status: "open",
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * 创建测试用项目理解输入
 *
 * @returns ProjectUnderstandingInput 对象
 */
function createUnderstandingInput(): ProjectUnderstandingInput {
  return {
    projectInfo: {
      name: "test-project",
      root: tempProject,
      languages: ["TypeScript", "JavaScript"],
    },
    techStack: {
      frameworks: ["express"],
      buildTools: ["tsc"],
      packageManagers: ["npm"],
      testFrameworks: ["jest"],
      linters: ["eslint"],
    },
    architecture: "layered",
  };
}

// ============================================================================
// PM-01 ~ PM-12 测试用例
// ============================================================================

test("PM-01: getProjectMemory 文件不存在返回默认空记忆（首启友好）", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  const memory = await manager.getProjectMemory();

  // 验证返回默认空记忆
  assert.equal(memory.schemaVersion, 1);
  assert.equal(memory.projectPath, tempProject);
  assert.equal(memory.projectId, generateProjectId(tempProject));
  assert.deepEqual(memory.projectHistory, []);
  assert.deepEqual(memory.knownIssues, []);
  assert.equal(memory.config.testFramework, "");

  // 验证 .deepcode 目录已创建（即使记忆文件不存在，目录也应存在）
  assert.equal(fs.existsSync(path.join(tempProject, ".deepcode")), true);
});

test("PM-02: getProjectMemory 文件存在合法返回解析后的记忆", async () => {
  const manager = new ProjectMemoryManager(tempProject);

  // 先保存一个记忆
  const original = createDefaultProjectMemory(tempProject);
  original.config.testFramework = "jest";
  original.projectHistory.push({
    timestamp: new Date().toISOString(),
    event: "initialization",
    description: "测试初始化",
  });
  await manager.updateProjectMemory(original);

  // 重新加载并验证
  const loaded = await manager.getProjectMemory();
  assert.equal(loaded.config.testFramework, "jest");
  assert.equal(loaded.projectHistory.length, 1);
  assert.equal(loaded.projectHistory[0].event, "initialization");
});

test("PM-03: getProjectMemory 文件损坏降级并备份原文件", async () => {
  const memoryPath = path.join(tempProject, ".deepcode", "project-memory.json");
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, "{invalid json content", "utf-8");

  const manager = new ProjectMemoryManager(tempProject);
  const memory = await manager.getProjectMemory();

  // 验证降级返回默认空记忆
  assert.deepEqual(memory.projectHistory, []);

  // 验证原文件被备份为 .corrupted.<timestamp>
  const files = fs.readdirSync(path.join(tempProject, ".deepcode"));
  const corruptedBackups = files.filter((f) => f.includes(".corrupted."));
  assert.equal(corruptedBackups.length, 1, "应生成 1 个 .corrupted 备份文件");
});

test("PM-04: updateProjectMemory 原子写入（.tmp 不残留）", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  const memory = createDefaultProjectMemory(tempProject);
  await manager.updateProjectMemory(memory);

  const memoryPath = path.join(tempProject, ".deepcode", "project-memory.json");
  const tmpPath = memoryPath + ".tmp";

  // 验证 .tmp 临时文件已被清理
  assert.equal(fs.existsSync(tmpPath), false, "不应残留 .tmp 文件");
  // 验证目标文件存在且内容合法
  assert.equal(fs.existsSync(memoryPath), true);
  const content = fs.readFileSync(memoryPath, "utf-8");
  assert.doesNotThrow(() => JSON.parse(content));
});

test("PM-05: initializeFromUnderstanding 从理解结果初始化", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  const understanding = createUnderstandingInput();

  const memory = await manager.initializeFromUnderstanding(understanding);

  // 验证从理解结果提取的配置
  assert.equal(memory.config.testFramework, "jest");
  assert.equal(memory.config.testCommand, "npm test");
  assert.equal(memory.config.linter, "eslint");
  assert.equal(memory.config.lintCommand, "npm run lint");
  assert.equal(memory.config.buildCommand, "npm run build");

  // 验证领域知识
  assert.ok(memory.domainKnowledge.concepts.includes("TypeScript"));
  assert.ok(memory.domainKnowledge.concepts.includes("JavaScript"));
  assert.ok(memory.domainKnowledge.concepts.includes("architecture:layered"));

  // 验证初始化历史条目
  assert.equal(memory.projectHistory.length, 1);
  assert.equal(memory.projectHistory[0].event, "initialization");
});

test("PM-06: addHistoryEntry 添加历史条目", async () => {
  const manager = new ProjectMemoryManager(tempProject);

  await manager.addHistoryEntry({
    timestamp: new Date().toISOString(),
    event: "config_changed",
    description: "测试框架改为 mocha",
  });

  const memory = await manager.getProjectMemory();
  assert.equal(memory.projectHistory.length, 1);
  assert.equal(memory.projectHistory[0].event, "config_changed");
  assert.equal(memory.projectHistory[0].description, "测试框架改为 mocha");
});

test("PM-07: addKnownIssue 添加已知问题", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  const issue = createKnownIssue();

  const added = await manager.addKnownIssue(issue);
  assert.equal(added, true, "首次添加应返回 true");

  const memory = await manager.getProjectMemory();
  assert.equal(memory.knownIssues.length, 1);
  assert.equal(memory.knownIssues[0].description, "类型错误");
});

test("PM-08: addKnownIssue fingerprint 去重（幂等）", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  const issue = createKnownIssue();

  // 第一次添加
  const added1 = await manager.addKnownIssue(issue);
  assert.equal(added1, true);

  // 第二次添加相同 fingerprint 的问题
  const duplicateIssue = createKnownIssue({
    id: crypto.randomUUID(), // 不同 ID 但相同 fingerprint
  });
  const added2 = await manager.addKnownIssue(duplicateIssue);
  assert.equal(added2, false, "相同 fingerprint 应不重复添加");

  // 验证只有一个问题
  const memory = await manager.getProjectMemory();
  assert.equal(memory.knownIssues.length, 1);
});

test("PM-09: resolveKnownIssue 标记问题为已解决", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  const issue = createKnownIssue();
  await manager.addKnownIssue(issue);

  // 标记为已解决
  const resolved = await manager.resolveKnownIssue(issue.id);
  assert.equal(resolved, true);

  // 验证状态已更新
  const memory = await manager.getProjectMemory();
  const resolvedIssue = memory.knownIssues.find((i) => i.id === issue.id);
  assert.ok(resolvedIssue);
  assert.equal(resolvedIssue.status, "resolved");

  // 验证添加了历史条目
  assert.ok(
    memory.projectHistory.some((h) => h.event === "issue_resolved"),
    "应添加 issue_resolved 历史条目"
  );
});

test("PM-10: .deepcode 目录自动创建 + .gitignore 排除自身", async () => {
  const manager = new ProjectMemoryManager(tempProject);
  await manager.getProjectMemory();

  // 验证 .deepcode 目录已创建
  const deepcodeDir = path.join(tempProject, ".deepcode");
  assert.equal(fs.existsSync(deepcodeDir), true);

  // 验证 .gitignore 文件已创建并排除自身
  const gitignorePath = path.join(deepcodeDir, ".gitignore");
  assert.equal(fs.existsSync(gitignorePath), true);
  const content = fs.readFileSync(gitignorePath, "utf-8");
  assert.ok(content.includes("*"), ".gitignore 应包含 * 排除所有内容");
});

test("PM-11: 容量上限维护（历史条目超限淘汰）", async () => {
  const manager = new ProjectMemoryManager(tempProject);

  // 插入 MAX_PROJECT_HISTORY + 10 条历史
  for (let i = 0; i < MAX_PROJECT_HISTORY + 10; i++) {
    await manager.addHistoryEntry({
      timestamp: new Date(2020, 0, i + 1).toISOString(), // 按日期递增，便于验证淘汰
      event: `event-${i}`,
      description: `事件 ${i}`,
    });
  }

  const memory = await manager.getProjectMemory();
  assert.equal(memory.projectHistory.length, MAX_PROJECT_HISTORY, `应保留最近 ${MAX_PROJECT_HISTORY} 条`);

  // 验证保留的是最近的事件（timestamp 较大者）
  const events = memory.projectHistory.map((h) => h.event);
  assert.ok(events.includes(`event-${MAX_PROJECT_HISTORY + 9}`), "应保留最后插入的事件");
  assert.ok(!events.includes("event-0"), "应淘汰最早的事件");
});

test("PM-12: 损坏文件降级后可正常重建", async () => {
  const memoryPath = path.join(tempProject, ".deepcode", "project-memory.json");
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, "corrupted", "utf-8");

  const manager = new ProjectMemoryManager(tempProject);

  // 第一次加载：降级返回默认空记忆
  const memory1 = await manager.getProjectMemory();
  assert.deepEqual(memory1.projectHistory, []);

  // 保存新记忆
  memory1.config.testFramework = "mocha";
  await manager.updateProjectMemory(memory1);

  // 第二次加载：应能正常读取
  const memory2 = await manager.getProjectMemory();
  assert.equal(memory2.config.testFramework, "mocha");
});
