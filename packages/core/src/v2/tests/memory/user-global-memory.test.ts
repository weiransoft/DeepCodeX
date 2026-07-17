/**
 * UserGlobalMemoryManager 单元测试（UGM-01 ~ UGM-15）
 *
 * 测试覆盖 V2-P3 F-MEM-01 用户全局记忆管理器的 5 个核心方法：
 * - UGM-01: getGlobalMemory 缺失时返回空记忆
 * - UGM-02/03: updateGlobalMemory 写入 personalContext / workContext
 * - UGM-04: updateGlobalMemory 写入 facts（>100 条）淘汰 confidence 最低者
 * - UGM-05/06/07/08: updateGlobalMemory 写入 4 个尾程维度
 * - UGM-09/10/11: extractFromConversation 启发式提取（3 个维度）
 * - UGM-12/13: injectIntoSystemPrompt 限制 2000 字符 + facts 降序
 * - UGM-14/15: hygiene 清理过期/超量 facts
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录隔离 global.json），禁止 mock。
 * 通过设置 process.env.HOME 隔离用户全局记忆目录，避免污染真实 ~/.deepcode。
 *
 * 设计依据：
 * - V2-P3 实施计划 §5.1.2（v1.1 修订 P2-4 facts 序列化策略）
 * - V2-P3 架构师审查报告 §2.2 P1-3（同步 API）+ §2.3 P2-4（facts 单条 MemoryEntry）
 *
 * @module v2/tests/memory/user-global-memory.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { MemoryStore } from "../../memory/memory-store";
import { UserGlobalMemoryManager } from "../../memory/user-global-memory";
import type { Fact } from "../../memory/user-global-memory";

// ============================================================================
// 测试 fixture：每个用例独立的临时 HOME 目录
// ============================================================================

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  // 创建临时 HOME 目录（避免污染真实 ~/.deepcode/memory/global.json）
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-ugm-home-"));
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
});

// ============================================================================
// 辅助工厂函数
// ============================================================================

/**
 * 创建 UserGlobalMemoryManager 实例（仅用户全局，无项目上下文）
 */
function createManager(): UserGlobalMemoryManager {
  const store = new MemoryStore(null);
  return new UserGlobalMemoryManager(store);
}

/**
 * 生成测试用 Fact
 */
function makeFact(overrides: Partial<Fact> = {}): Fact {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    content: "测试事实",
    confidence: 0.7,
    source: "auto_extracted",
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    ...overrides,
  };
}

// ============================================================================
// UGM-01 ~ UGM-08：getGlobalMemory + updateGlobalMemory
// ============================================================================

test("UGM-01: getGlobalMemory 缺失时返回空记忆", () => {
  const manager = createManager();
  const memory = manager.getGlobalMemory("default");

  // 7 维度均为空字符串
  assert.equal(memory.workContext, "", "workContext 应为空字符串");
  assert.equal(memory.personalContext, "", "personalContext 应为空字符串");
  assert.equal(memory.topOfMind, "", "topOfMind 应为空字符串");
  assert.equal(memory.recentMonths, "", "recentMonths 应为空字符串");
  assert.equal(memory.earlierContext, "", "earlierContext 应为空字符串");
  assert.equal(memory.longTermBackground, "", "longTermBackground 应为空字符串");
  // facts 为空数组（非 undefined）
  assert.ok(Array.isArray(memory.facts), "facts 应为数组");
  assert.equal(memory.facts.length, 0, "facts 应为空数组");
});

test("UGM-02: updateGlobalMemory 写入 personalContext", () => {
  const manager = createManager();
  manager.updateGlobalMemory("default", { personalContext: "偏好中文注释" });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.personalContext, "偏好中文注释");
  // 其他维度不受影响
  assert.equal(memory.workContext, "", "workContext 应保持空字符串");
});

test("UGM-03: updateGlobalMemory 写入 workContext", () => {
  const manager = createManager();
  manager.updateGlobalMemory("default", { workContext: "DeepCodeX 项目" });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.workContext, "DeepCodeX 项目");
  // 其他维度不受影响
  assert.equal(memory.personalContext, "", "personalContext 应保持空字符串");
});

test("UGM-04: updateGlobalMemory 写入 facts（>100 条）淘汰 confidence 最低者", () => {
  const manager = createManager();

  // 生成 110 条 facts，confidence 从 0.01 递增到 1.10（实际 0.01-1.00 共 100 条 + 10 条 0.01-0.10）
  // 排序后应保留 confidence 最高的 100 条
  const facts: Fact[] = [];
  for (let i = 0; i < 110; i++) {
    facts.push(
      makeFact({
        content: `事实 #${i}`,
        confidence: 0.01 + i * 0.009, // 0.01, 0.019, ..., 0.991
      })
    );
  }
  manager.updateGlobalMemory("default", { facts });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.facts.length, 100, "应淘汰 10 条最低 confidence 的 facts，保留 100 条");

  // 验证保留的是 confidence 最高的 100 条（按降序排序后取前 100）
  // 原始 confidence: 0.01, 0.019, ..., 0.991（共 110 条）
  // 降序排序后取前 100：0.991, 0.982, ..., 0.1（保留 i=10~109 的值，即 confidence >= 0.1）
  // 验证最低保留的 confidence 应为第 10 条（i=10，confidence=0.1）
  const sortedConfidences = memory.facts.map((f) => f.confidence).sort((a, b) => b - a);
  const minConfidence = sortedConfidences[sortedConfidences.length - 1];
  assert.ok(minConfidence >= 0.099, `保留的最低 confidence 应 ≥ 0.1（实际: ${minConfidence}）`);

  // 验证最高 confidence 为最后一条（i=109，confidence=0.991）
  const maxConfidence = sortedConfidences[0];
  assert.ok(maxConfidence > 0.98, `最高 confidence 应 ≈ 0.991（实际: ${maxConfidence}）`);
});

test("UGM-05: updateGlobalMemory 写入 topOfMind（尾程维度）", () => {
  const manager = createManager();
  manager.updateGlobalMemory("default", { topOfMind: "正在思考 V2-P3 集成方案" });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.topOfMind, "正在思考 V2-P3 集成方案");
});

test("UGM-06: updateGlobalMemory 写入 recentMonths", () => {
  const manager = createManager();
  manager.updateGlobalMemory("default", { recentMonths: "近三个月完成了 V2-P1 和 V2-P2" });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.recentMonths, "近三个月完成了 V2-P1 和 V2-P2");
});

test("UGM-07: updateGlobalMemory 写入 earlierContext", () => {
  const manager = createManager();
  manager.updateGlobalMemory("default", { earlierContext: "去年参与了 WoAgent 项目" });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.earlierContext, "去年参与了 WoAgent 项目");
});

test("UGM-08: updateGlobalMemory 写入 longTermBackground", () => {
  const manager = createManager();
  manager.updateGlobalMemory("default", { longTermBackground: "10 年后端开发经验" });

  const memory = manager.getGlobalMemory("default");
  assert.equal(memory.longTermBackground, "10 年后端开发经验");
});

// ============================================================================
// UGM-09 ~ UGM-11：extractFromConversation 启发式提取
// ============================================================================

test('UGM-09: extractFromConversation "请用中文注释" → personalContext', () => {
  const manager = createManager();
  const messages = [
    { role: "assistant", content: "好的，我会注意代码风格。" },
    { role: "user", content: "请用中文注释所有新增函数" },
  ];

  const partial = manager.extractFromConversation("default", messages);
  assert.ok(partial.personalContext, "应提取出 personalContext");
  assert.ok(
    partial.personalContext!.includes("中文注释"),
    `personalContext 应包含 "中文注释"（实际: ${partial.personalContext}）`
  );
  // 不应触发 workContext 或 facts
  assert.equal(partial.workContext, undefined, "不应提取 workContext");
  assert.equal(partial.facts, undefined, "不应提取 facts");
});

test('UGM-10: extractFromConversation "这个项目是..." → workContext', () => {
  const manager = createManager();
  const messages = [{ role: "user", content: "这个项目是 DeepCodeX 的 V2 上下文记忆系统" }];

  const partial = manager.extractFromConversation("default", messages);
  assert.ok(partial.workContext, "应提取出 workContext");
  assert.ok(
    partial.workContext!.includes("DeepCodeX"),
    `workContext 应包含 "DeepCodeX"（实际: ${partial.workContext}）`
  );
  // 不应触发 personalContext 或 facts
  assert.equal(partial.personalContext, undefined, "不应提取 personalContext");
  assert.equal(partial.facts, undefined, "不应提取 facts");
});

test('UGM-11: extractFromConversation "记住..." → facts', () => {
  const manager = createManager();
  const messages = [{ role: "user", content: "记住用户使用 macOS 系统，需要 MPS 加速" }];

  const partial = manager.extractFromConversation("default", messages);
  assert.ok(partial.facts, "应提取出 facts");
  assert.ok(Array.isArray(partial.facts), "facts 应为数组");
  assert.ok(partial.facts!.length > 0, "facts 应至少包含一条");
  // 验证 fact 内容包含关键词后的内容
  const fact = partial.facts![0];
  assert.ok(
    fact.content.includes("macOS") || fact.content.includes("MPS"),
    `fact 内容应包含 "macOS" 或 "MPS"（实际: ${fact.content}）`
  );
  // 验证 Fact 结构完整
  assert.ok(fact.id, "fact 应有 id");
  assert.ok(fact.createdAt, "fact 应有 createdAt");
  assert.ok(fact.lastAccessedAt, "fact 应有 lastAccessedAt");
  assert.equal(fact.accessCount, 0, "新提取的 fact accessCount 应为 0");
  assert.equal(fact.source, "auto_extracted", "fact source 应为 auto_extracted");
  // 不应触发 personalContext 或 workContext
  assert.equal(partial.personalContext, undefined, "不应提取 personalContext");
  assert.equal(partial.workContext, undefined, "不应提取 workContext");
});

// ============================================================================
// UGM-12 ~ UGM-13：injectIntoSystemPrompt
// ============================================================================

test("UGM-12: injectIntoSystemPrompt 限制 2000 字符", () => {
  const manager = createManager();

  // 写入大量内容，使注入块超过 2000 字符
  const longPersonalContext = "A".repeat(1500);
  const longWorkContext = "B".repeat(1500);
  manager.updateGlobalMemory("default", {
    personalContext: longPersonalContext,
    workContext: longWorkContext,
  });

  // 同时写入 15 条 facts（验证 Top-10 限制）
  const facts: Fact[] = [];
  for (let i = 0; i < 15; i++) {
    facts.push(
      makeFact({
        content: `事实 #${i} ${"C".repeat(100)}`,
        confidence: 0.9 - i * 0.05, // 0.9, 0.85, ..., 0.2
      })
    );
  }
  manager.updateGlobalMemory("default", { facts });

  const originalPrompt = "You are a coding assistant.";
  const injected = manager.injectIntoSystemPrompt("default", originalPrompt);

  // 验证包含 <user_memory> 块
  assert.ok(injected.includes("<user_memory>"), "应包含 <user_memory> 开始标签");
  assert.ok(injected.includes("</user_memory>"), "应包含 </user_memory> 结束标签");

  // 提取注入块并验证总长度 ≤ 2000 字符
  const blockStart = injected.indexOf("<user_memory>");
  const blockEnd = injected.indexOf("</user_memory>") + "</user_memory>".length;
  const memoryBlock = injected.slice(blockStart, blockEnd);
  assert.ok(memoryBlock.length <= 2000, `注入块总长度应 ≤ 2000 字符（实际: ${memoryBlock.length}）`);

  // 验证原 prompt 在前
  assert.ok(injected.startsWith(originalPrompt), "原 prompt 应在前");
});

test("UGM-13: injectIntoSystemPrompt facts 按 confidence 降序", () => {
  const manager = createManager();

  // 写入 5 条 facts，confidence 顺序打乱
  const facts: Fact[] = [
    makeFact({ content: "低置信度事实", confidence: 0.3 }),
    makeFact({ content: "高置信度事实", confidence: 0.95 }),
    makeFact({ content: "中置信度事实", confidence: 0.6 }),
    makeFact({ content: "次高置信度事实", confidence: 0.85 }),
    makeFact({ content: "中低置信度事实", confidence: 0.45 }),
  ];
  manager.updateGlobalMemory("default", { facts });

  const originalPrompt = "You are a coding assistant.";
  const injected = manager.injectIntoSystemPrompt("default", originalPrompt);

  // 提取注入块
  const blockStart = injected.indexOf("<user_memory>");
  const blockEnd = injected.indexOf("</user_memory>");
  const blockContent = injected.slice(blockStart, blockEnd);

  // 验证 facts 按 confidence 降序出现
  // 预期顺序：0.95, 0.85, 0.6, 0.45, 0.3
  const expectedOrder = ["高置信度事实", "次高置信度事实", "中置信度事实", "中低置信度事实", "低置信度事实"];
  for (let i = 0; i < expectedOrder.length - 1; i++) {
    const currentIdx = blockContent.indexOf(expectedOrder[i]);
    const nextIdx = blockContent.indexOf(expectedOrder[i + 1]);
    assert.ok(currentIdx > -1 && nextIdx > -1, `应能在注入块中找到事实 #${i} 和 #${i + 1}`);
    assert.ok(
      currentIdx < nextIdx,
      `事实 "${expectedOrder[i]}"（confidence 更高）应出现在 "${expectedOrder[i + 1]}" 之前`
    );
  }
});

// ============================================================================
// UGM-14 ~ UGM-15：hygiene 清理
// ============================================================================

test("UGM-14: hygiene 清理 confidence < 0.3 且 accessCount=0", () => {
  const manager = createManager();

  // 写入混合 facts：
  // - 低置信度且未访问（应清理）
  // - 低置信度但已访问（保留）
  // - 高置信度未访问（保留）
  // - 高置信度已访问（保留）
  const facts: Fact[] = [
    makeFact({ content: "低置信度未访问-1", confidence: 0.2, accessCount: 0 }),
    makeFact({ content: "低置信度未访问-2", confidence: 0.1, accessCount: 0 }),
    makeFact({ content: "低置信度已访问", confidence: 0.2, accessCount: 5 }),
    makeFact({ content: "高置信度未访问", confidence: 0.8, accessCount: 0 }),
    makeFact({ content: "高置信度已访问", confidence: 0.9, accessCount: 3 }),
  ];
  manager.updateGlobalMemory("default", { facts });

  // 执行 hygiene
  manager.hygiene("default");

  const memory = manager.getGlobalMemory("default");
  // 应清理 2 条（低置信度未访问），保留 3 条
  assert.equal(memory.facts.length, 3, "应清理 2 条低置信度未访问的 facts");

  // 验证保留的 facts 不含低置信度未访问项
  const contents = memory.facts.map((f) => f.content);
  assert.ok(!contents.includes("低置信度未访问-1"), "不应包含 低置信度未访问-1");
  assert.ok(!contents.includes("低置信度未访问-2"), "不应包含 低置信度未访问-2");
  assert.ok(contents.includes("低置信度已访问"), "应保留 低置信度已访问");
  assert.ok(contents.includes("高置信度未访问"), "应保留 高置信度未访问");
  assert.ok(contents.includes("高置信度已访问"), "应保留 高置信度已访问");
});

test("UGM-15: hygiene 淘汰超过 100 条的 facts", () => {
  // 通过 MemoryStore 直接写入 110 条 facts，绕过 updateGlobalMemory 的 100 条裁剪
  // 以便真正测试 hygiene 规则 2 的 >100 淘汰逻辑
  const store = new MemoryStore(null);
  const manager = new UserGlobalMemoryManager(store);

  // 构造 110 条 facts，全部满足规则 1（confidence >= 0.3 或 accessCount > 0），
  // 迫使规则 2 介入：按 (confidence desc, accessCount desc) 淘汰 10 条最低优先级者
  const facts: Fact[] = [];
  for (let i = 0; i < 110; i++) {
    facts.push(
      makeFact({
        content: `事实 #${i}`,
        // confidence 在 0.4~0.9 之间循环（全部 >= 0.3，规则 1 不删除）
        confidence: 0.4 + (i % 6) * 0.1, // 0.4, 0.5, 0.6, 0.7, 0.8, 0.9 循环
        accessCount: i % 3, // 0, 1, 2 循环
      })
    );
  }

  // 直接通过 store.add 写入 facts（绕过 manager.updateGlobalMemory 的裁剪）
  // 模拟历史遗留数据超过 100 条的场景
  store.add({
    type: "user_global",
    key: "facts",
    value: JSON.stringify(facts),
    confidence: 1.0,
    source: "user_explicit",
  });

  // 验证初始状态确有 110 条
  const beforeHygiene = manager.getGlobalMemory("default");
  assert.equal(beforeHygiene.facts.length, 110, "初始应有 110 条 facts");

  // 执行 hygiene（规则 1 不删除任何条目，规则 2 应淘汰 10 条）
  manager.hygiene("default");

  const afterHygiene = manager.getGlobalMemory("default");
  assert.equal(afterHygiene.facts.length, 100, "hygiene 规则 2 应淘汰 10 条，保留 100 条");

  // 验证保留的是 (confidence desc, accessCount desc) 综合排序的 Top-100
  // 排序后应优先保留 confidence 高且 accessCount 高的条目
  // 验证最高优先级的条目（confidence=0.9, accessCount=2）被保留
  const hasHighestPriority = afterHygiene.facts.some((f) => f.confidence === 0.9 && f.accessCount === 2);
  assert.ok(hasHighestPriority, "应保留最高优先级的 facts（confidence=0.9, accessCount=2）");

  // 验证所有保留的 facts 满足规则 1（不被规则 1 删除）
  const allValid = afterHygiene.facts.every((f) => f.confidence >= 0.3 || f.accessCount > 0);
  assert.ok(allValid, "所有保留的 facts 应满足规则 1（confidence >= 0.3 或 accessCount > 0）");
});
