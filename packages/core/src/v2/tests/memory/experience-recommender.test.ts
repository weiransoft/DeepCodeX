/**
 * ExperienceRecommender 单元测试（ER-01 ~ ER-10）
 *
 * 测试覆盖 V2-P3 F-MEM-04 经验 RAG 推荐器的核心能力：
 * - ER-01: 任务类型完全匹配召回
 * - ER-02: TF-IDF 语义相似召回（similarity > 0.3）
 * - ER-03: 标签交集召回
 * - ER-04: 三路召回去重（合并后无重复经验）
 * - ER-05: rank 计算 score = relevance*0.6 + (importance/10)*0.4
 * - ER-06: recommend 返回 Top-5（默认 limit=5）
 * - ER-07: recommend 自定义 limit
 * - ER-08: recommend 空经验库返回空数组
 * - ER-09: recordAccess 更新 accessCount（批量自增）
 * - ER-10: recommend 按 score 降序排序
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录隔离 global-context.json），
 * 禁止 mock。通过自定义 GlobalContextManager filePath 避免污染真实 ~/.deepcode。
 * TFIDFEmbedder 使用真实实现（v1-adapters re-export）。
 *
 * 设计依据：
 * - V2-P3 实施计划 §5.1.3（v1.1 修订 P1-2/P1-4/P1-5/P2-1）
 * - V2-P3 架构师审查报告 §2.2 P1-2（tags 路径）+ §2.3 P2-1（TF-IDF 范围）
 *
 * @module v2/tests/memory/experience-recommender.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { GlobalContextManager } from "../../context/global-context";
import type { SuccessExperience } from "../../context/global-context";
import { TFIDFEmbedder } from "../../integration/v1-adapters";
import { ExperienceRecommender } from "../../memory/experience-recommender";
import type { TaskContext, FocusPoint } from "../../context/types";

// ============================================================================
// 测试 fixture：每个用例独立的临时目录与文件路径
// ============================================================================

let tempDir: string;
let contextFilePath: string;

beforeEach(() => {
  // 创建临时目录（避免污染真实 ~/.deepcode/global-context.json）
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-er-"));
  contextFilePath = path.join(tempDir, "global-context.json");
});

afterEach(() => {
  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助工厂函数
// ============================================================================

/**
 * 创建测试用成功经验条目
 */
function makeSuccessExp(overrides: Partial<SuccessExperience> = {}): SuccessExperience {
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
 * 创建测试用 TaskContext
 */
function makeTaskContext(overrides: {
  taskType?: string;
  description?: string;
  focusPoints?: FocusPoint[];
}): TaskContext {
  const now = new Date().toISOString();
  return {
    taskId: "test-task-1",
    taskDefinition: {
      description: overrides.description ?? "",
      goals: [],
      constraints: [],
      taskType: overrides.taskType ?? "bugfix",
      expectedOutput: "",
    },
    taskState: {
      status: "in_progress",
      progress: 0,
      startedAt: now,
      currentStage: "测试中",
    },
    workingMemory: {
      focusPoints: overrides.focusPoints ?? [],
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
    version: 0,
  };
}

/**
 * 创建测试用 ExperienceRecommender（含 GlobalContextManager + TFIDFEmbedder）
 */
function createRecommender(): {
  manager: GlobalContextManager;
  recommender: ExperienceRecommender;
  embedder: TFIDFEmbedder;
} {
  const manager = new GlobalContextManager(contextFilePath);
  const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
  const recommender = new ExperienceRecommender(manager, embedder);
  return { manager, recommender, embedder };
}

// ============================================================================
// ER-01 ~ ER-04：三路召回（通过 recommend 公开方法间接验证）
// ============================================================================

test("ER-01: 任务类型完全匹配召回", () => {
  const { manager, recommender } = createRecommender();

  // 准备：3 条成功经验，2 条 taskType="bugfix"，1 条 taskType="feature"
  // 描述完全不相关，确保召回仅靠任务类型匹配
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "bugfix",
      description: "修复数据库连接池耗尽问题",
      tags: ["database"], // 与任务 tags 不交集
    })
  );
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "bugfix",
      description: "修复线程死锁问题",
      tags: ["threading"],
    })
  );
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "feature",
      description: "实现用户注册功能",
      tags: ["auth"],
    })
  );

  // 任务：taskType="bugfix"，描述与经验无语义重叠，tags 不交集
  const taskCtx = makeTaskContext({
    taskType: "bugfix",
    description: "修复网络超时问题", // 与 "数据库连接池" / "线程死锁" 语义不相似
    focusPoints: [],
  });

  const recs = recommender.recommend(taskCtx, 10);

  // 验证：仅召回 taskType="bugfix" 的 2 条经验
  assert.equal(recs.length, 2, "应召回 2 条 taskType=bugfix 的经验");
  const types = recs.map((r) => r.experience.taskType);
  assert.ok(
    types.every((t) => t === "bugfix"),
    "所有召回经验 taskType 应为 bugfix"
  );
});

test("ER-02: TF-IDF 语义相似召回（similarity > 0.3）", () => {
  const { manager, recommender } = createRecommender();

  // 准备：2 条成功经验，描述与任务描述相似度不同
  // 注意：TFIDFEmbedder.similarity 已 L2 归一化，similarity = cosine similarity ∈ [0, 1]
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "other", // 任务类型不匹配，确保召回仅靠语义相似
      description: "memory leak event listener", // 与任务描述相似
      tags: ["unrelated"], // 标签不交集
    })
  );
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "other",
      description: "实现 UI 界面布局", // 与任务描述完全不相似
      tags: ["ui"],
    })
  );

  const taskCtx = makeTaskContext({
    taskType: "bugfix", // 与经验 taskType="other" 不匹配
    description: "memory leak event listener fix", // 与第一条经验相似
    focusPoints: [],
  });

  const recs = recommender.recommend(taskCtx, 10);

  // 验证：应召回语义相似的经验（"memory leak event listener"）
  assert.ok(recs.length >= 1, "应至少召回 1 条语义相似的经验");
  const descriptions = recs.map((r) => r.experience.description);
  assert.ok(descriptions.includes("memory leak event listener"), "应召回描述含 'memory leak event listener' 的经验");
});

test("ER-03: 标签交集召回", () => {
  const { manager, recommender } = createRecommender();

  // 准备：2 条成功经验，taskType 不匹配，描述不相似，仅靠标签交集召回
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "other",
      description: "完全不同的描述 AAA", // 与任务描述不相似
      tags: ["memory", "performance"], // 与任务 tags 有交集 "memory"
    })
  );
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "other",
      description: "另一段无关描述 BBB",
      tags: ["ui", "ux"], // 与任务 tags 无交集
    })
  );

  // 任务的 focusPoints 中 ref="memory"（type="concept"），将作为 tag
  const taskCtx = makeTaskContext({
    taskType: "bugfix", // 与经验 taskType="other" 不匹配
    description: "网络超时问题 xyz", // 与经验描述不相似
    focusPoints: [{ type: "concept", ref: "memory", priority: 0.8, addedAt: new Date().toISOString() }],
  });

  const recs = recommender.recommend(taskCtx, 10);

  // 验证：应召回标签含 "memory" 的经验
  assert.ok(recs.length >= 1, "应至少召回 1 条标签交集的经验");
  const descriptions = recs.map((r) => r.experience.description);
  assert.ok(descriptions.includes("完全不同的描述 AAA"), "应召回标签含 'memory' 的经验");
});

test("ER-04: 三路召回去重（合并后无重复经验）", () => {
  const { manager, recommender } = createRecommender();

  // 准备：1 条经验同时满足三路召回条件（taskType 匹配 + 语义相似 + 标签交集）
  manager.addSuccessExperience(
    "default",
    makeSuccessExp({
      taskType: "bugfix", // 路径 1：与任务 taskType 匹配
      description: "memory leak event listener", // 路径 2：与任务描述相似
      tags: ["memory"], // 路径 3：与任务 tags 有交集
    })
  );

  const taskCtx = makeTaskContext({
    taskType: "bugfix",
    description: "memory leak event listener fix",
    focusPoints: [{ type: "concept", ref: "memory", priority: 0.8, addedAt: new Date().toISOString() }],
  });

  const recs = recommender.recommend(taskCtx, 10);

  // 验证：经验仅出现一次（去重生效）
  assert.equal(recs.length, 1, "三路召回同时命中同一经验，去重后应仅 1 条");
  assert.equal(recs[0].experience.description, "memory leak event listener");
});

// ============================================================================
// ER-05：rank score 计算验证
// ============================================================================

test("ER-05: rank 计算 score = relevance*0.6 + (importance/10)*0.4", () => {
  const { manager, recommender, embedder } = createRecommender();

  // 准备：1 条经验，taskType 匹配 + 标签全交集 + importance=10
  // 期望 relevance = 0.3 + sim*0.5 + 1.0*0.2 = 0.5 + sim*0.5
  // 期望 score = relevance * 0.6 + (10/10) * 0.4 = relevance*0.6 + 0.4
  const exp = makeSuccessExp({
    taskType: "bugfix",
    description: "memory leak event listener",
    tags: ["memory"], // 与任务 tags 全交集
    importance: 10,
  });
  manager.addSuccessExperience("default", exp);

  const taskCtx = makeTaskContext({
    taskType: "bugfix", // 任务类型匹配
    description: "memory leak event listener",
    focusPoints: [{ type: "concept", ref: "memory", priority: 0.8, addedAt: new Date().toISOString() }],
  });

  const recs = recommender.recommend(taskCtx, 10);
  assert.equal(recs.length, 1, "应召回 1 条经验");

  // 手动计算预期 score
  // 训练 embedder（与 recommend 内部相同流程）
  embedder.fit([
    "memory leak event listener",
    "memory leak event listener", // 任务描述与经验描述相同
  ]);
  const sim = embedder.similarity("memory leak event listener", "memory leak event listener");
  // 相同文本 similarity 应为 1.0
  assert.ok(sim > 0.99, `相同文本 similarity 应 ≈ 1.0（实际: ${sim}）`);

  const expectedRelevance = Math.min(0.3 + sim * 0.5 + 1.0 * 0.2, 1.0); // = 1.0
  const expectedScore = expectedRelevance * 0.6 + (10 / 10) * 0.4; // = 1.0

  const actual = recs[0];
  assert.ok(
    Math.abs(actual.relevance - expectedRelevance) < 0.001,
    `relevance 计算错误（预期: ${expectedRelevance}, 实际: ${actual.relevance}）`
  );
  assert.ok(
    Math.abs(actual.score - expectedScore) < 0.001,
    `score 计算错误（预期: ${expectedScore}, 实际: ${actual.score}）`
  );
  assert.equal(actual.importance, 10, "importance 应为原始值 10");
});

// ============================================================================
// ER-06 ~ ER-08：recommend limit 与空经验库
// ============================================================================

test("ER-06: recommend 返回 Top-5（默认 limit=5）", () => {
  const { manager, recommender } = createRecommender();

  // 准备：8 条同 taskType 经验（全部召回）
  for (let i = 0; i < 8; i++) {
    manager.addSuccessExperience(
      "default",
      makeSuccessExp({
        description: `修复 bug #${i}`,
        importance: i + 1, // 1~8，importance 越大 score 越高
      })
    );
  }

  const taskCtx = makeTaskContext({
    taskType: "bugfix",
    description: "修复 bug",
    focusPoints: [],
  });

  // 不传 limit，使用默认值 5
  const recs = recommender.recommend(taskCtx);

  assert.equal(recs.length, 5, "默认应返回 Top-5");
});

test("ER-07: recommend 自定义 limit", () => {
  const { manager, recommender } = createRecommender();

  // 准备：8 条同 taskType 经验
  for (let i = 0; i < 8; i++) {
    manager.addSuccessExperience(
      "default",
      makeSuccessExp({
        description: `修复 bug #${i}`,
        importance: i + 1,
      })
    );
  }

  const taskCtx = makeTaskContext({
    taskType: "bugfix",
    description: "修复 bug",
    focusPoints: [],
  });

  const recs = recommender.recommend(taskCtx, 3);
  assert.equal(recs.length, 3, "应返回 Top-3");

  // 验证返回的是 score 最高的 3 条（importance=8,7,6）
  const importances = recs.map((r) => r.importance).sort((a, b) => b - a);
  assert.deepEqual(importances, [8, 7, 6], "应返回 importance 最高的 3 条");
});

test("ER-08: recommend 空经验库返回空数组", () => {
  const { recommender } = createRecommender();

  const taskCtx = makeTaskContext({
    taskType: "bugfix",
    description: "修复 bug",
    focusPoints: [],
  });

  const recs = recommender.recommend(taskCtx, 5);
  assert.deepEqual(recs, [], "空经验库应返回空数组");
});

// ============================================================================
// ER-09：recordAccess 批量更新 accessCount
// ============================================================================

test("ER-09: recordAccess 批量更新 accessCount", () => {
  const { manager, recommender } = createRecommender();

  // 准备：3 条经验
  const exp1 = makeSuccessExp({ description: "修复内存泄漏" });
  const exp2 = makeSuccessExp({ description: "修复线程死锁" });
  const exp3 = makeSuccessExp({ description: "修复 UI 渲染" });
  manager.addSuccessExperience("default", exp1);
  manager.addSuccessExperience("default", exp2);
  manager.addSuccessExperience("default", exp3);

  const taskCtx = makeTaskContext({
    taskType: "bugfix", // 全部 taskType 匹配
    description: "修复内存问题",
    focusPoints: [],
  });

  // 调用 recommend 触发 recordAccess
  const recs = recommender.recommend(taskCtx, 10);
  assert.ok(recs.length > 0, "应召回至少 1 条经验");

  // 验证：所有命中的经验 accessCount 应自增 1
  const ctx = manager.load("default");
  for (const rec of recs) {
    const updated = ctx.historicalExperience.successExperiences.find((e) => e.id === rec.experience.id);
    assert.ok(updated, `经验 ${rec.experience.id} 应在 GlobalContext 中找到`);
    assert.equal(
      updated.accessCount,
      1,
      `经验 "${updated.description}" 的 accessCount 应为 1（实际: ${updated.accessCount}）`
    );
  }
});

// ============================================================================
// ER-10：recommend 按 score 降序排序
// ============================================================================

test("ER-10: recommend 按 score 降序排序", () => {
  const { manager, recommender } = createRecommender();

  // 准备：5 条经验，importance 各不相同（taskType 全匹配，importance 主导 score）
  // importance 越大 → normalizedImportance 越大 → score 越大
  const importances = [3, 7, 5, 9, 1];
  for (const imp of importances) {
    manager.addSuccessExperience(
      "default",
      makeSuccessExp({
        description: `修复 bug importance=${imp}`,
        importance: imp,
      })
    );
  }

  const taskCtx = makeTaskContext({
    taskType: "bugfix",
    description: "修复 bug",
    focusPoints: [],
  });

  const recs = recommender.recommend(taskCtx, 10);
  assert.equal(recs.length, 5, "应召回全部 5 条经验");

  // 验证：score 严格降序
  for (let i = 0; i < recs.length - 1; i++) {
    assert.ok(
      recs[i].score >= recs[i + 1].score,
      `score 应降序排序（位置 ${i}: ${recs[i].score} < 位置 ${i + 1}: ${recs[i + 1].score}）`
    );
  }

  // 验证：第一个应 importance 最高（=9），最后一个 importance 最低（=1）
  assert.equal(recs[0].importance, 9, "Top-1 应为 importance=9 的经验");
  assert.equal(recs[recs.length - 1].importance, 1, "末尾应为 importance=1 的经验");
});
