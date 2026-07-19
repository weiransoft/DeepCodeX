/**
 * EAG-P3 批次 11 单元测试：RiskScorer（§8.6 + B3-M9 + B3-M3 修复）
 *
 * 本测试文件校验 RiskScorer 类的 4 维度评分算法。
 *
 * 测试策略（遵循用户规则 P-5"禁止 mock"）：
 * - 直接构造真实 BlastRadiusNode 对象（含 depth / parentPaths）
 * - 真实调用 score() 方法
 * - 真实校验返回的 RiskScore 列表与 totalScore
 *
 * 测试范围：
 * - T1. 维度 1：direct（depth=0）→ score=1.0
 * - T2. 维度 1：indirect（depth>0）→ score=0.5（+ depth-decay 衰减后 totalScore=0.4）
 * - T3. 维度 2：high-risk-symbol 命中（parentPaths 含高风险符号）→ +0.3
 * - T4. 维度 2：high-risk-symbol 未命中 → 不加入 scores
 * - T5. 维度 3：domain-layer 命中（parentPaths 含 src/domain/ 文件）→ +0.2
 * - T6. 维度 3：domain-layer 未命中 → 不加入 scores
 * - T7. 维度 4：depth-decay（depth=1）→ -0.1（B3-M3 修复：允许负数衰减，totalScore=0.4）
 * - T8. 维度 4：depth-decay（depth=2）→ -0.2（B3-M3 修复：totalScore=0.3）
 * - T9. 维度 4：depth-decay（depth=5）→ -0.5（B3-M3 修复：totalScore=0.0，下限保护）
 * - T9b. 维度 4：depth-decay（depth=3）→ -0.3（B3-M3 修复新增：totalScore=0.2）
 * - T10. 维度 4：depth=0 时不触发 depth-decay
 * - T11. 总评分上限 1.0（多维度叠加时不超过 1.0）
 * - T12. 综合场景：direct + high-risk-symbol + domain-layer（depth=0）→ 1.0（上限）
 * - T13. 综合场景：indirect + high-risk-symbol + domain-layer + depth-decay（depth=2）→ 0.8
 * - T14. 返回的 scores 列表已冻结
 * - T15. 每个 RiskScore 对象本身也冻结
 * - T16. B3-M9 + B3-M3 修复验证：depth-decay 独立 dimension + 负数衰减
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 直接构造真实 BlastRadiusNode
 * - 禁止 mock
 *
 * @module core/tests/eag-incremental-risk-scorer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RiskScorer } from "../eag/testing/incremental/risk-scorer";
import type { BlastRadiusNode, RiskScore, RiskScoreDimension } from "../eag/testing/incremental/types";

// ============================================================================
// 辅助函数：构造 BlastRadiusNode
// ============================================================================

/**
 * 构造测试用 BlastRadiusNode
 *
 * @param filePath 文件路径
 * @param depth BFS 深度（0=source，>0=affected/test）
 * @param parentPaths 父节点路径列表
 * @param type 节点类型（默认 "test"）
 * @returns 完整的 BlastRadiusNode
 */
function createNode(
  filePath: string,
  depth: number,
  parentPaths: ReadonlyArray<string>,
  type: "source" | "affected" | "test" = "test"
): BlastRadiusNode {
  return {
    type,
    filePath,
    depth,
    parentPaths,
  };
}

// ============================================================================
// T1. 维度 1：direct（depth=0）→ score=1.0
// ============================================================================

test("T1. 维度 1：direct（depth=0）→ score=1.0", () => {
  const scorer = new RiskScorer();
  // depth=0 → direct，parentPaths 为空
  const node = createNode("tests/foo.test.ts", 0, [], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, []);

  // 应包含 direct 维度评分
  const directScore = scores.find((s) => s.dimension === "direct");
  assert.ok(directScore, "应包含 direct 维度评分");
  assert.equal(directScore!.score, 1.0);

  // 不应包含 indirect 维度评分（互斥）
  const indirectScore = scores.find((s) => s.dimension === "indirect");
  assert.equal(indirectScore, undefined);

  // totalScore 应为 1.0
  assert.equal(totalScore, 1.0);
});

// ============================================================================
// T2. 维度 1：indirect（depth>0）→ score=0.5
// ============================================================================

test("T2. 维度 1：indirect（depth=1）→ score=0.5", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 1, ["src/services/PaymentService.ts"], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, []);

  // 应包含 indirect 维度评分
  const indirectScore = scores.find((s) => s.dimension === "indirect");
  assert.ok(indirectScore, "应包含 indirect 维度评分");
  assert.equal(indirectScore!.score, 0.5);

  // 不应包含 direct 维度评分（互斥）
  const directScore = scores.find((s) => s.dimension === "direct");
  assert.equal(directScore, undefined);

  // B3-M3 修复后：totalScore = indirect(0.5) + depth-decay(-0.1) = 0.4
  // 原 B3-M3 修复前：depth-decay 受 minScore=0.1 兜底，totalScore=0.5+0.1=0.6
  // 修复后 depth-decay 真正起到衰减作用，totalScore 降低为 0.4
  assert.equal(
    totalScore,
    0.4,
    `totalScore 应为 0.4（indirect 0.5 + depth-decay -0.1，B3-M3 修复后衰减生效），实际：${totalScore}`
  );
});

// ============================================================================
// T3. 维度 2：high-risk-symbol 命中 → +0.3
// ============================================================================

test("T3. 维度 2：high-risk-symbol 命中 → +0.3", () => {
  const scorer = new RiskScorer();
  // parentPaths 含高风险符号路径（"src/services/PaymentService.ts:PaymentService.refund"）
  const node = createNode("tests/foo.test.ts", 1, ["src/services/PaymentService.ts:PaymentService.refund"], "test");

  const { scores } = scorer.score(node.filePath, node, ["PaymentService.refund"]);

  const highRiskScore = scores.find((s) => s.dimension === "high-risk-symbol");
  assert.ok(highRiskScore, "应包含 high-risk-symbol 维度评分");
  assert.equal(highRiskScore!.score, 0.3);
});

// ============================================================================
// T4. 维度 2：high-risk-symbol 未命中 → 不加入 scores
// ============================================================================

test("T4. 维度 2：high-risk-symbol 未命中 → 不加入 scores", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 1, ["src/services/PaymentService.ts"], "test");

  const { scores } = scorer.score(node.filePath, node, ["UnknownService.unknown"]);

  const highRiskScore = scores.find((s) => s.dimension === "high-risk-symbol");
  assert.equal(highRiskScore, undefined);
});

// ============================================================================
// T5. 维度 3：domain-layer 命中（parentPaths 含 src/domain/ 文件）→ +0.2
// ============================================================================

test("T5. 维度 3：domain-layer 命中 → +0.2", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 1, ["src/domain/Payment.ts"], "test");

  const { scores } = scorer.score(node.filePath, node, []);

  const domainScore = scores.find((s) => s.dimension === "domain-layer");
  assert.ok(domainScore, "应包含 domain-layer 维度评分");
  assert.equal(domainScore!.score, 0.2);
});

// ============================================================================
// T6. 维度 3：domain-layer 未命中 → 不加入 scores
// ============================================================================

test("T6. 维度 3：domain-layer 未命中 → 不加入 scores", () => {
  const scorer = new RiskScorer();
  const node = createNode(
    "tests/foo.test.ts",
    1,
    ["src/services/PaymentService.ts"], // 不以 src/domain/ 开头
    "test"
  );

  const { scores } = scorer.score(node.filePath, node, []);

  const domainScore = scores.find((s) => s.dimension === "domain-layer");
  assert.equal(domainScore, undefined);
});

// ============================================================================
// T7. 维度 4：depth-decay（depth=1）→ -0.1（B3-M3 修复：允许负数衰减）
// ============================================================================

test("T7. 维度 4：depth-decay（depth=1）→ -0.1（B3-M3 修复：允许负数衰减）", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 1, [], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, []);

  const decayScore = scores.find((s) => s.dimension === "depth-decay");
  assert.ok(decayScore, "应包含 depth-decay 维度评分");
  // B3-M3 修复后：depth=1 → 1 * -0.1 = -0.1，max(-1.0, -0.1) = -0.1（允许负数衰减）
  // 原 B3-M3 修复前：max(0.1, -0.1) = 0.1（兜底失效，未起到衰减作用）
  assert.equal(
    decayScore!.score,
    -0.1,
    `depth=1 时 depth-decay score 应为 -0.1（B3-M3 修复后允许负数），实际：${decayScore!.score}`
  );

  // B3-M3 修复后：totalScore = indirect(0.5) + depth-decay(-0.1) = 0.4
  assert.equal(
    totalScore,
    0.4,
    `depth=1 时 totalScore 应为 0.4（indirect 0.5 + depth-decay -0.1），实际：${totalScore}`
  );
});

// ============================================================================
// T8. 维度 4：depth-decay（depth=2）→ -0.2（B3-M3 修复：允许负数衰减）
// ============================================================================

test("T8. 维度 4：depth-decay（depth=2）→ -0.2（B3-M3 修复：允许负数衰减）", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 2, [], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, []);

  const decayScore = scores.find((s) => s.dimension === "depth-decay");
  assert.ok(decayScore, "应包含 depth-decay 维度评分");
  // B3-M3 修复后：depth=2 → 2 * -0.1 = -0.2，max(-1.0, -0.2) = -0.2（允许负数衰减）
  assert.equal(
    decayScore!.score,
    -0.2,
    `depth=2 时 depth-decay score 应为 -0.2（B3-M3 修复后允许负数），实际：${decayScore!.score}`
  );

  // B3-M3 修复后：totalScore = indirect(0.5) + depth-decay(-0.2) = 0.3
  assert.equal(
    totalScore,
    0.3,
    `depth=2 时 totalScore 应为 0.3（indirect 0.5 + depth-decay -0.2），实际：${totalScore}`
  );
});

// ============================================================================
// T9. 维度 4：depth-decay（depth=5）→ -0.5（B3-M3 修复：允许负数衰减 + 下限保护）
// ============================================================================

test("T9. 维度 4：depth-decay（depth=5）→ -0.5（B3-M3 修复：允许负数衰减 + 下限保护）", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 5, [], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, []);

  const decayScore = scores.find((s) => s.dimension === "depth-decay");
  assert.ok(decayScore, "应包含 depth-decay 维度评分");
  // B3-M3 修复后：depth=5 → 5 * -0.1 = -0.5，max(-1.0, -0.5) = -0.5（允许负数衰减）
  // 原 B3-M3 修复前：max(0.1, -0.5) = 0.1（兜底失效，未起到衰减作用）
  assert.equal(
    decayScore!.score,
    -0.5,
    `depth=5 时 depth-decay score 应为 -0.5（B3-M3 修复后允许负数），实际：${decayScore!.score}`
  );

  // B3-M3 修复后：totalScore = indirect(0.5) + depth-decay(-0.5) = 0.0（下限保护生效）
  // 验证总评分下限为 0（depth=5 时为 0.0，不为负数）
  assert.equal(
    totalScore,
    0.0,
    `depth=5 时 totalScore 应为 0.0（indirect 0.5 + depth-decay -0.5，下限保护），实际：${totalScore}`
  );
  // 显式验证 totalScore 不为负数（B3-M3 修复增加的 Math.max(0, ...) 下限保护）
  assert.ok(totalScore >= 0, `totalScore 应 ≥ 0（B3-M3 修复增加下限保护），实际：${totalScore}`);
});

// ============================================================================
// T9b. 维度 4：depth-decay（depth=3）→ -0.3（B3-M3 修复新增：验证中等距离衰减）
// ============================================================================

test("T9b. 维度 4：depth-decay（depth=3）→ -0.3（B3-M3 修复新增：验证中等距离衰减）", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 3, [], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, []);

  const decayScore = scores.find((s) => s.dimension === "depth-decay");
  assert.ok(decayScore, "应包含 depth-decay 维度评分");
  // B3-M3 修复后：depth=3 → 3 * -0.1 = -0.3，max(-1.0, -0.3) = -0.3（允许负数衰减）
  // 注：由于 IEEE 754 浮点数精度问题，3 * -0.1 实际计算结果为 -0.30000000000000004，
  //     故采用容差比较（1e-9）替代严格相等，对齐项目内 eag-long-horizon-types.test.ts L213 既有惯例。
  assert.ok(
    Math.abs(decayScore!.score - -0.3) < 1e-9,
    `depth=3 时 depth-decay score 应为 -0.3（B3-M3 修复后允许负数），实际：${decayScore!.score}`
  );

  // B3-M3 修复后：totalScore = indirect(0.5) + depth-decay(-0.3) = 0.2
  // 注：由于 IEEE 754 浮点数累加精度问题，0.5 + (-0.30000000000000004) = 0.19999999999999998，
  //     故采用容差比较（1e-9）替代严格相等。
  assert.ok(
    Math.abs(totalScore - 0.2) < 1e-9,
    `depth=3 时 totalScore 应为 0.2（indirect 0.5 + depth-decay -0.3），实际：${totalScore}`
  );
});

// ============================================================================
// T10. 维度 4：depth=0 时不触发 depth-decay
// ============================================================================

test("T10. 维度 4：depth=0 时不触发 depth-decay", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 0, [], "test");

  const { scores } = scorer.score(node.filePath, node, []);

  const decayScore = scores.find((s) => s.dimension === "depth-decay");
  assert.equal(decayScore, undefined);
});

// ============================================================================
// T11. 总评分上限 1.0（多维度叠加时不超过 1.0）
// ============================================================================

test("T11. 总评分上限 1.0（多维度叠加时不超过 1.0）", () => {
  const scorer = new RiskScorer();
  // 构造一个会让总评分超过 1.0 的场景：direct(1.0) + high-risk-symbol(0.3) + domain-layer(0.2)
  // raw total = 1.0 + 0.3 + 0.2 = 1.5，但 totalScore 上限为 1.0
  const node = createNode("tests/foo.test.ts", 0, ["src/domain/Payment.ts:Payment.refund"], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, ["Payment.refund"]);

  // 应包含 direct + high-risk-symbol + domain-layer 三个维度
  assert.equal(scores.length, 3);
  // raw total = 1.5，但 totalScore 上限为 1.0
  assert.equal(totalScore, 1.0);
});

// ============================================================================
// T12. 综合场景：direct + high-risk-symbol + domain-layer（depth=0）→ 1.0（上限）
// ============================================================================

test("T12. 综合场景：direct + high-risk-symbol + domain-layer（depth=0）", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 0, ["src/domain/Payment.ts:Payment.refund"], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, ["Payment.refund"]);

  // 应包含 direct + high-risk-symbol + domain-layer 三个维度
  // depth=0 不触发 depth-decay
  assert.equal(scores.length, 3);
  const dimensions = scores.map((s) => s.dimension);
  assert.ok(dimensions.includes("direct"));
  assert.ok(dimensions.includes("high-risk-symbol"));
  assert.ok(dimensions.includes("domain-layer"));
  assert.ok(!dimensions.includes("depth-decay"));
  assert.ok(!dimensions.includes("indirect"));

  // totalScore = 1.0 + 0.3 + 0.2 = 1.5，上限 1.0
  assert.equal(totalScore, 1.0);
});

// ============================================================================
// T13. 综合场景：indirect + high-risk-symbol + domain-layer + depth-decay（depth=2）
// ============================================================================

test("T13. 综合场景：indirect + high-risk-symbol + domain-layer + depth-decay（depth=2）", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 2, ["src/domain/Payment.ts:Payment.refund"], "test");

  const { scores, totalScore } = scorer.score(node.filePath, node, ["Payment.refund"]);

  // 应包含 4 个维度：indirect + high-risk-symbol + domain-layer + depth-decay
  assert.equal(scores.length, 4);
  const dimensions = scores.map((s) => s.dimension);
  assert.ok(dimensions.includes("indirect"));
  assert.ok(dimensions.includes("high-risk-symbol"));
  assert.ok(dimensions.includes("domain-layer"));
  assert.ok(dimensions.includes("depth-decay"));

  // B3-M3 修复后：raw total = 0.5 + 0.3 + 0.2 + (-0.2) = 0.8
  // 原 B3-M3 修复前：raw total = 0.5 + 0.3 + 0.2 + 0.1 = 1.1，受 maxTotalScore=1.0 上限限制为 1.0
  // 修复后 depth-decay 真正起到衰减作用，totalScore 降低为 0.8（不再触发上限）
  assert.equal(
    totalScore,
    0.8,
    `depth=2 综合场景 totalScore 应为 0.8（indirect 0.5 + high-risk-symbol 0.3 + domain-layer 0.2 + depth-decay -0.2），实际：${totalScore}`
  );
});

// ============================================================================
// T14. 返回的 scores 列表已冻结
// ============================================================================

test("T14. 返回的 scores 列表已冻结", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 1, [], "test");

  const { scores } = scorer.score(node.filePath, node, []);

  assert.equal(Object.isFrozen(scores), true);
});

// ============================================================================
// T15. 每个 RiskScore 对象本身也冻结
// ============================================================================

test("T15. 每个 RiskScore 对象本身也冻结", () => {
  const scorer = new RiskScorer();
  const node = createNode("tests/foo.test.ts", 2, ["src/domain/Payment.ts:Payment.refund"], "test");

  const { scores } = scorer.score(node.filePath, node, ["Payment.refund"]);

  for (const s of scores) {
    assert.equal(Object.isFrozen(s), true, `RiskScore 应冻结：${s.dimension}`);
  }
});

// ============================================================================
// T16. B3-M9 修复验证：depth-decay 使用独立 dimension，不与 indirect 冲突
// ============================================================================

test("T16. B3-M9 + B3-M3 修复验证：depth-decay 独立 dimension + 负数衰减", () => {
  const scorer = new RiskScorer();
  // depth=2 → indirect + depth-decay
  const node = createNode("tests/foo.test.ts", 2, [], "test");

  const { scores } = scorer.score(node.filePath, node, []);

  // 收集 indirect 维度的评分项
  const indirectScores: ReadonlyArray<RiskScore> = scores.filter((s: RiskScore) => s.dimension === "indirect");
  // 收集 depth-decay 维度的评分项
  const decayScores: ReadonlyArray<RiskScore> = scores.filter((s: RiskScore) => s.dimension === "depth-decay");

  // B3-M9 修复：indirect 维度应只有 1 项（基础分 0.5），不应有两个 dimension="indirect" 项
  assert.equal(indirectScores.length, 1, `indirect 维度应只有 1 项，实际：${indirectScores.length}`);
  assert.equal(indirectScores[0].score, 0.5);

  // B3-M9 修复：depth-decay 维度应只有 1 项（独立维度，不与 indirect 冲突）
  assert.equal(decayScores.length, 1, `depth-decay 维度应只有 1 项，实际：${decayScores.length}`);

  // B3-M3 修复：depth-decay 维度 score 应为 -0.2（depth=2 时 -0.1*2，允许负数衰减）
  // 原 B3-M3 修复前：score=0.1（受 minScore=0.1 兜底，未起到衰减作用）
  assert.equal(
    decayScores[0].score,
    -0.2,
    `depth=2 时 depth-decay score 应为 -0.2（B3-M3 修复后允许负数衰减），实际：${decayScores[0].score}`
  );
  // 显式验证 score 为负数（B3-M3 修复核心目标：depth-decay 必须产生负数衰减）
  assert.ok(
    decayScores[0].score < 0,
    `depth-decay score 应为负数（B3-M3 修复核心目标），实际：${decayScores[0].score}`
  );
});
