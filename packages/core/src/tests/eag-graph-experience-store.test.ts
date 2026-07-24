/**
 * EAG-Graph ExperienceStore 单元测试（Phase 4）
 *
 * 测试范围：
 * - X1. computeSimilarity：完全相同的特征 → 相似度 = 1.0
 * - X2. computeSimilarity：完全不同的离散特征 → 相似度 = 0.0
 * - X3. computeSimilarity：部分匹配的离散特征 → 相似度 = 0.5
 * - X4. computeSimilarity：连续特征相同 → 相似度 = 1.0
 * - X5. computeSimilarity：连续特征不同 → 相似度 < 1.0
 * - X6. computeSimilarity：混合特征（离散+连续）→ 加权融合
 * - X7. computeSimilarity：特征权重配置生效
 * - X8. computeSimilarity：空特征 → 相似度 = 0
 * - X9. storeCase：写入案例后 size 递增
 * - X10. storeCase：自动生成 caseId 和 createdAt
 * - X11. storeCase：FIFO 淘汰（超过 maxCases 时删除最早案例）
 * - X12. recallSimilar：空案例库返回空列表
 * - X13. recallSimilar：召回相似案例（按相似度降序）
 * - X14. recallSimilar：低于阈值的案例不召回
 * - X15. recallSimilar：limit 限制返回数量
 * - X16. recallSimilar：完全匹配的特征召回成功
 * - X17. clear：清空案例库
 * - X18. getAllCases：返回所有案例
 * - X19. createExperienceStore 工厂函数
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §14.1 经验召回相似度算法
 * - LOOP-GRAPH-FUSION-DESIGN.md §12.3 Phase 4 经验自进化集成
 * - eag/graph/experience-store.ts 源文件（被测对象）
 *
 * @module core/tests/eag-graph-experience-store
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExperienceStoreImpl, createExperienceStore, computeSimilarity } from "../eag/graph/experience-store";
import type { ExperienceCase } from "../eag/graph/graph-loop-models";
import type { GraphLogger } from "../eag/graph/graph-loop-models";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 创建不输出日志的 GraphLogger（测试用，避免噪音）
 */
function makeSilentLogger(): GraphLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 构造一个经验案例
 *
 * @param overrides 字段覆盖
 */
function makeExperienceCase(overrides?: Partial<ExperienceCase>): ExperienceCase {
  return {
    caseId: overrides?.caseId ?? "case-001",
    taskType: overrides?.taskType ?? "coding",
    taskFeatures: overrides?.taskFeatures ?? { language: "typescript", complexity: "high" },
    strategy: overrides?.strategy ?? "loop-with-strict-evaluator",
    success: overrides?.success ?? true,
    executionTimeSec: overrides?.executionTimeSec ?? 100.5,
    failureReason: overrides?.failureReason,
    nodeId: overrides?.nodeId,
    graphRunId: overrides?.graphRunId,
    createdAt: overrides?.createdAt ?? "2026-07-23T00:00:00.000Z",
  };
}

// ============================================================================
// computeSimilarity 单元测试
// ============================================================================

test("X1. computeSimilarity：完全相同的特征 → 相似度 = 1.0", () => {
  const features = { language: "typescript", complexity: "high" };
  const similarity = computeSimilarity(features, features);
  assert.equal(similarity, 1.0, "完全相同的离散特征相似度应为 1.0");
});

test("X2. computeSimilarity：完全不同的离散特征 → 相似度 = 0.0", () => {
  const query = { language: "typescript" };
  const caseFeatures = { language: "python" };
  const similarity = computeSimilarity(query, caseFeatures);
  assert.equal(similarity, 0.0, "完全不同的离散特征相似度应为 0.0");
});

test("X3. computeSimilarity：部分匹配的离散特征 → 相似度 = 0.5", () => {
  const query = { language: "typescript", complexity: "high" };
  const caseFeatures = { language: "typescript", complexity: "low" };
  const similarity = computeSimilarity(query, caseFeatures);
  assert.equal(similarity, 0.5, "部分匹配的离散特征相似度应为 0.5（1/2 交集）");
});

test("X4. computeSimilarity：连续特征相同 → 相似度 = 1.0", () => {
  const query = { lines: 100 };
  const caseFeatures = { lines: 100 };
  const similarity = computeSimilarity(query, caseFeatures);
  assert.equal(similarity, 1.0, "完全相同的连续特征相似度应为 1.0（distance=0）");
});

test("X5. computeSimilarity：连续特征不同 → 相似度 < 1.0", () => {
  const query = { lines: 100 };
  const caseFeatures = { lines: 200 };
  const similarity = computeSimilarity(query, caseFeatures);
  assert.ok(similarity < 1.0, "不同的连续特征相似度应 < 1.0");
  assert.ok(similarity > 0, "不同的连续特征相似度应 > 0");
  // distance = sqrt((100-200)²) = 100, similarity = 1/(1+100) ≈ 0.0099
  assert.ok(Math.abs(similarity - 1 / 101) < 0.001, `相似度应约为 1/101 = ${1 / 101}，实际为 ${similarity}`);
});

test("X6. computeSimilarity：混合特征（离散+连续）→ 加权融合", () => {
  const query = { language: "typescript", complexity: "high", lines: 100 };
  const caseFeatures = { language: "typescript", complexity: "high", lines: 200 };
  const similarity = computeSimilarity(query, caseFeatures);
  // 离散特征 2 个，连续特征 1 个
  // 离散相似度 = 1.0（全部匹配）
  // 连续相似度 = 1/(1+100) ≈ 0.0099
  // 混合权重 = 0.6 × 1.0 + 0.4 × 0.0099 ≈ 0.604
  assert.ok(similarity > 0.5, "混合特征相似度应 > 0.5（离散部分完全匹配）");
  assert.ok(similarity < 1.0, "混合特征相似度应 < 1.0（连续部分不完全匹配）");
  const expected = 0.6 * 1.0 + 0.4 * (1 / 101);
  assert.ok(Math.abs(similarity - expected) < 0.001, `混合相似度应约为 ${expected}，实际为 ${similarity}`);
});

test("X7. computeSimilarity：特征权重配置生效", () => {
  const query = { language: "typescript", complexity: "high" };
  const caseFeatures = { language: "typescript", complexity: "low" };
  // 不带权重：相似度 = 0.5（1/2 交集）
  const similarityNoWeight = computeSimilarity(query, caseFeatures);
  assert.equal(similarityNoWeight, 0.5, "等权相似度应为 0.5");

  // 带权重：language 权重 3，complexity 权重 1
  // 交集权重 = 3（language 匹配），并集权重 = 3 + 1 = 4
  // 相似度 = 3/4 = 0.75
  const similarityWeighted = computeSimilarity(query, caseFeatures, {
    language: 3,
    complexity: 1,
  });
  assert.equal(similarityWeighted, 0.75, "加权相似度应为 0.75（3/4）");
});

test("X8. computeSimilarity：空特征 → 相似度 = 0", () => {
  const similarity = computeSimilarity({}, {});
  assert.equal(similarity, 0, "空特征相似度应为 0");
});

// ============================================================================
// ExperienceStoreImpl 单元测试
// ============================================================================

test("X9. storeCase：写入案例后 size 递增", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  assert.equal(store.size(), 0, "初始案例库大小应为 0");

  await store.storeCase(makeExperienceCase({ caseId: "case-001" }));
  assert.equal(store.size(), 1, "写入 1 个案例后大小应为 1");

  await store.storeCase(makeExperienceCase({ caseId: "case-002" }));
  assert.equal(store.size(), 2, "写入 2 个案例后大小应为 2");
});

test("X10. storeCase：自动生成 caseId 和 createdAt", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  // 传入空 caseId 和 createdAt
  const caseData = makeExperienceCase({ caseId: "", createdAt: "" });
  await store.storeCase(caseData);

  const allCases = store.getAllCases();
  assert.equal(allCases.length, 1, "应有 1 个案例");
  assert.ok(allCases[0].caseId.length > 0, "caseId 应被自动生成");
  assert.ok(allCases[0].createdAt.length > 0, "createdAt 应被自动生成");
});

test("X11. storeCase：FIFO 淘汰（超过 maxCases 时删除最早案例）", async () => {
  // 设置 maxCases=3
  const store = new ExperienceStoreImpl({ maxCases: 3 }, makeSilentLogger());

  // 写入 3 个案例
  await store.storeCase(makeExperienceCase({ caseId: "case-1" }));
  await store.storeCase(makeExperienceCase({ caseId: "case-2" }));
  await store.storeCase(makeExperienceCase({ caseId: "case-3" }));
  assert.equal(store.size(), 3, "写入 3 个案例后大小应为 3");

  // 写入第 4 个案例，应淘汰 case-1
  await store.storeCase(makeExperienceCase({ caseId: "case-4" }));
  assert.equal(store.size(), 3, "FIFO 淘汰后大小应仍为 3");

  const allCases = store.getAllCases();
  const caseIds = allCases.map((c) => c.caseId);
  assert.ok(!caseIds.includes("case-1"), "case-1 应被 FIFO 淘汰");
  assert.ok(caseIds.includes("case-2"), "case-2 应保留");
  assert.ok(caseIds.includes("case-3"), "case-3 应保留");
  assert.ok(caseIds.includes("case-4"), "case-4 应保留");
});

test("X12. recallSimilar：空案例库返回空列表", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  const results = await store.recallSimilar({ language: "typescript" }, 5);
  assert.equal(results.length, 0, "空案例库应返回空列表");
});

test("X13. recallSimilar：召回相似案例（按相似度降序）", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());

  // 写入 3 个案例，相似度不同
  await store.storeCase(
    makeExperienceCase({
      caseId: "case-exact",
      taskFeatures: { language: "typescript", complexity: "high" },
    })
  );
  await store.storeCase(
    makeExperienceCase({
      caseId: "case-partial",
      taskFeatures: { language: "typescript", complexity: "low" },
    })
  );
  await store.storeCase(
    makeExperienceCase({
      caseId: "case-nomatch",
      taskFeatures: { language: "python", complexity: "low" },
    })
  );

  // 查询：language=typescript, complexity=high
  const results = await store.recallSimilar({ language: "typescript", complexity: "high" }, 5);

  // case-exact 相似度=1.0，case-partial 相似度=0.5，case-nomatch 相似度=0.0（低于阈值 0.5）
  assert.ok(results.length >= 1, "至少应召回 1 个案例");
  assert.equal(results[0].caseId, "case-exact", "第一个应为完全匹配的案例");
});

test("X14. recallSimilar：低于阈值的案例不召回", async () => {
  // 设置相似度阈值 = 0.6
  const store = new ExperienceStoreImpl({ similarityThreshold: 0.6 }, makeSilentLogger());

  await store.storeCase(
    makeExperienceCase({
      caseId: "case-50percent",
      taskFeatures: { language: "typescript", complexity: "low" },
    })
  );

  // 查询：language=typescript, complexity=high
  // case-50percent 相似度 = 0.5（1/2 交集），低于阈值 0.6
  const results = await store.recallSimilar({ language: "typescript", complexity: "high" }, 5);

  assert.equal(results.length, 0, "相似度 0.5 低于阈值 0.6，不应召回");
});

test("X15. recallSimilar：limit 限制返回数量", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());

  // 写入 5 个完全匹配的案例
  for (let i = 0; i < 5; i++) {
    await store.storeCase(
      makeExperienceCase({
        caseId: `case-${i}`,
        taskFeatures: { language: "typescript", complexity: "high" },
      })
    );
  }

  // 查询，limit=2
  const results = await store.recallSimilar({ language: "typescript", complexity: "high" }, 2);

  assert.equal(results.length, 2, "应限制返回 2 个案例");
});

test("X16. recallSimilar：完全匹配的特征召回成功", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  const features = { language: "typescript", complexity: "high", framework: "react" };

  await store.storeCase(
    makeExperienceCase({
      caseId: "case-perfect",
      taskFeatures: features,
    })
  );

  const results = await store.recallSimilar(features, 5);
  assert.equal(results.length, 1, "完全匹配应召回 1 个案例");
  assert.equal(results[0].caseId, "case-perfect", "应召回完全匹配的案例");
});

test("X17. clear：清空案例库", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  await store.storeCase(makeExperienceCase({ caseId: "case-1" }));
  await store.storeCase(makeExperienceCase({ caseId: "case-2" }));
  assert.equal(store.size(), 2, "写入 2 个案例后大小应为 2");

  store.clear();
  assert.equal(store.size(), 0, "清空后大小应为 0");
});

test("X18. getAllCases：返回所有案例", async () => {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  await store.storeCase(makeExperienceCase({ caseId: "case-1" }));
  await store.storeCase(makeExperienceCase({ caseId: "case-2" }));
  await store.storeCase(makeExperienceCase({ caseId: "case-3" }));

  const allCases = store.getAllCases();
  assert.equal(allCases.length, 3, "应返回 3 个案例");
  const caseIds = allCases.map((c) => c.caseId);
  assert.ok(caseIds.includes("case-1"), "应包含 case-1");
  assert.ok(caseIds.includes("case-2"), "应包含 case-2");
  assert.ok(caseIds.includes("case-3"), "应包含 case-3");
});

test("X19. createExperienceStore 工厂函数", () => {
  const store = createExperienceStore({}, makeSilentLogger());
  assert.ok(store instanceof ExperienceStoreImpl, "工厂函数应返回 ExperienceStoreImpl 实例");
  assert.equal(store.size(), 0, "新创建的存储应为空");

  const storeWithConfig = createExperienceStore({ maxCases: 100, similarityThreshold: 0.7 }, makeSilentLogger());
  assert.ok(storeWithConfig instanceof ExperienceStoreImpl, "带配置的工厂函数应返回实例");
});
