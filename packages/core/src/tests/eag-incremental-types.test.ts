/**
 * EAG-P3 批次 11 单元测试：增量测试选择器类型与常量（§8.3）
 *
 * 本测试文件校验 types.ts 中定义的全部类型与常量：
 * - T1. GitChangeType 字面量联合完整性
 *   - T1a. 4 类变更类型（added/modified/deleted/renamed）
 *   - T1b. GIT_CHANGE_TYPES 常量顺序
 *   - T1c. 常量已冻结
 * - T2. DiffStat 接口字段完整性
 * - T3. GitFileChange 接口字段完整性（含可选 oldFilePath）
 * - T4. BlastRadiusNodeType 字面量联合完整性
 *   - T4a. 3 类节点类型（source/affected/test）
 *   - T4b. BLAST_RADIUS_NODE_TYPES 常量顺序
 *   - T4c. 常量已冻结
 * - T5. BlastRadiusNode 接口字段完整性
 * - T6. RiskScoreDimension 字面量联合完整性
 *   - T6a. 5 类评分维度（direct/indirect/high-risk-symbol/domain-layer/depth-decay）
 *   - T6b. RISK_SCORE_DIMENSIONS 常量顺序
 *   - T6c. 常量已冻结
 * - T7. RiskScore 接口字段完整性
 * - T8. SelectedTest 接口字段完整性
 * - T9. IncrementalTestSelection 接口字段完整性
 * - T10. 默认配置常量
 *   - T10a. DEFAULT_MAX_BFS_DEPTH = 5
 *   - T10b. DEFAULT_TOP_N = 20
 *   - T10c. TEST_FILE_PATTERN 匹配 tests/foo.test.ts
 *   - T10d. TEST_FILE_PATTERN 不匹配 src/foo.ts
 *   - T10e. TEST_FILE_PATTERN 已冻结
 *   - T10f. DOMAIN_LAYER_PREFIX = "src/domain/"
 *   - T10g. DOMAIN_LAYER_PREFIX 已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-incremental-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIT_CHANGE_TYPES,
  BLAST_RADIUS_NODE_TYPES,
  RISK_SCORE_DIMENSIONS,
  DEFAULT_MAX_BFS_DEPTH,
  DEFAULT_TOP_N,
  TEST_FILE_PATTERN,
  DOMAIN_LAYER_PREFIX,
} from "../eag/testing/incremental/types";
import type {
  GitChangeType,
  DiffStat,
  GitFileChange,
  BlastRadiusNodeType,
  BlastRadiusNode,
  RiskScoreDimension,
  RiskScore,
  SelectedTest,
  IncrementalTestSelection,
} from "../eag/testing/incremental/types";

// ============================================================================
// T1. GitChangeType 字面量联合完整性
// ============================================================================

test("T1a. GitChangeType 包含 4 类变更类型（added/modified/deleted/renamed）", () => {
  assert.equal(GIT_CHANGE_TYPES.length, 4);
});

test("T1b. GIT_CHANGE_TYPES 常量顺序正确（added→modified→deleted→renamed）", () => {
  const expected: ReadonlyArray<GitChangeType> = ["added", "modified", "deleted", "renamed"];
  assert.deepEqual([...GIT_CHANGE_TYPES], [...expected]);
});

test("T1c. GIT_CHANGE_TYPES 常量已冻结", () => {
  assert.equal(Object.isFrozen(GIT_CHANGE_TYPES), true);
});

// ============================================================================
// T2. DiffStat 接口字段完整性
// ============================================================================

test("T2. DiffStat 接口字段完整性", () => {
  const stat: DiffStat = {
    additions: 42,
    deletions: 18,
  };
  assert.equal(stat.additions, 42);
  assert.equal(stat.deletions, 18);
});

// ============================================================================
// T3. GitFileChange 接口字段完整性
// ============================================================================

test("T3a. GitFileChange 接口字段完整性（modified 类型，无 oldFilePath）", () => {
  const change: GitFileChange = {
    type: "modified",
    filePath: "src/services/PaymentService.ts",
    diffStat: { additions: 42, deletions: 18 },
  };
  assert.equal(change.type, "modified");
  assert.equal(change.filePath, "src/services/PaymentService.ts");
  assert.equal(change.oldFilePath, undefined);
  assert.equal(change.diffStat.additions, 42);
  assert.equal(change.diffStat.deletions, 18);
});

test("T3b. GitFileChange 接口字段完整性（renamed 类型，含 oldFilePath）", () => {
  const change: GitFileChange = {
    type: "renamed",
    filePath: "src/services/PaymentServiceV2.ts",
    oldFilePath: "src/services/PaymentService.ts",
    diffStat: { additions: 5, deletions: 3 },
  };
  assert.equal(change.type, "renamed");
  assert.equal(change.filePath, "src/services/PaymentServiceV2.ts");
  assert.equal(change.oldFilePath, "src/services/PaymentService.ts");
});

// ============================================================================
// T4. BlastRadiusNodeType 字面量联合完整性
// ============================================================================

test("T4a. BlastRadiusNodeType 包含 3 类节点（source/affected/test）", () => {
  assert.equal(BLAST_RADIUS_NODE_TYPES.length, 3);
});

test("T4b. BLAST_RADIUS_NODE_TYPES 常量顺序正确（source→affected→test）", () => {
  const expected: ReadonlyArray<BlastRadiusNodeType> = ["source", "affected", "test"];
  assert.deepEqual([...BLAST_RADIUS_NODE_TYPES], [...expected]);
});

test("T4c. BLAST_RADIUS_NODE_TYPES 常量已冻结", () => {
  assert.equal(Object.isFrozen(BLAST_RADIUS_NODE_TYPES), true);
});

// ============================================================================
// T5. BlastRadiusNode 接口字段完整性
// ============================================================================

test("T5. BlastRadiusNode 接口字段完整性", () => {
  const node: BlastRadiusNode = {
    type: "test",
    filePath: "tests/contract/payment.contract.test.ts",
    depth: 2,
    parentPaths: ["src/services/PaymentService.ts", "src/controllers/PaymentController.ts"],
  };
  assert.equal(node.type, "test");
  assert.equal(node.filePath, "tests/contract/payment.contract.test.ts");
  assert.equal(node.depth, 2);
  assert.equal(node.parentPaths.length, 2);
  assert.equal(node.parentPaths[0], "src/services/PaymentService.ts");
  assert.equal(node.parentPaths[1], "src/controllers/PaymentController.ts");
});

// ============================================================================
// T6. RiskScoreDimension 字面量联合完整性
// ============================================================================

test("T6a. RiskScoreDimension 包含 5 类评分维度", () => {
  assert.equal(RISK_SCORE_DIMENSIONS.length, 5);
});

test("T6b. RISK_SCORE_DIMENSIONS 常量顺序正确", () => {
  const expected: ReadonlyArray<RiskScoreDimension> = [
    "direct",
    "indirect",
    "high-risk-symbol",
    "domain-layer",
    "depth-decay",
  ];
  assert.deepEqual([...RISK_SCORE_DIMENSIONS], [...expected]);
});

test("T6c. RISK_SCORE_DIMENSIONS 常量已冻结", () => {
  assert.equal(Object.isFrozen(RISK_SCORE_DIMENSIONS), true);
});

// ============================================================================
// T7. RiskScore 接口字段完整性
// ============================================================================

test("T7. RiskScore 接口字段完整性", () => {
  const score: RiskScore = {
    dimension: "direct",
    score: 1.0,
    reason: "测试文件直接被修改",
  };
  assert.equal(score.dimension, "direct");
  assert.equal(score.score, 1.0);
  assert.equal(score.reason, "测试文件直接被修改");
});

// ============================================================================
// T8. SelectedTest 接口字段完整性
// ============================================================================

test("T8. SelectedTest 接口字段完整性", () => {
  const selected: SelectedTest = {
    testPath: "tests/contract/payment.contract.test.ts",
    totalScore: 0.9,
    scores: [
      { dimension: "indirect", score: 0.5, reason: "受影响（距离 2 跳）" },
      { dimension: "high-risk-symbol", score: 0.3, reason: "受影响文件包含高风险符号" },
      { dimension: "depth-decay", score: -0.2, reason: "距离衰减 -0.20（depth=2）" },
    ],
    affectedFiles: ["src/services/PaymentService.ts", "src/controllers/PaymentController.ts"],
    reason: "总评分 0.90（indirect:0.50, high-risk-symbol:0.30, depth-decay:-0.20）",
  };
  assert.equal(selected.testPath, "tests/contract/payment.contract.test.ts");
  assert.equal(selected.totalScore, 0.9);
  assert.equal(selected.scores.length, 3);
  assert.equal(selected.affectedFiles.length, 2);
  assert.ok(selected.reason.includes("总评分"));
});

// ============================================================================
// T9. IncrementalTestSelection 接口字段完整性
// ============================================================================

test("T9. IncrementalTestSelection 接口字段完整性", () => {
  const selection: IncrementalTestSelection = {
    selectedTests: [],
    totalCandidates: 35,
    selectionReason: "Top-20 选择（共 35 个候选测试，选中 20 个，覆盖率估算 57.1%）",
    coverageEstimate: 0.571,
    topN: 20,
  };
  assert.equal(selection.selectedTests.length, 0);
  assert.equal(selection.totalCandidates, 35);
  assert.ok(selection.selectionReason.includes("Top-20"));
  assert.equal(selection.coverageEstimate, 0.571);
  assert.equal(selection.topN, 20);
});

// ============================================================================
// T10. 默认配置常量
// ============================================================================

test("T10a. DEFAULT_MAX_BFS_DEPTH = 5", () => {
  assert.equal(DEFAULT_MAX_BFS_DEPTH, 5);
});

test("T10b. DEFAULT_TOP_N = 20", () => {
  assert.equal(DEFAULT_TOP_N, 20);
});

test("T10c. TEST_FILE_PATTERN 匹配 tests/foo.test.ts", () => {
  assert.ok(TEST_FILE_PATTERN.test("tests/foo.test.ts"));
});

test("T10c2. TEST_FILE_PATTERN 匹配 tests/contract/payment.contract.test.ts", () => {
  assert.ok(TEST_FILE_PATTERN.test("tests/contract/payment.contract.test.ts"));
});

test("T10d. TEST_FILE_PATTERN 不匹配 src/foo.ts", () => {
  assert.equal(TEST_FILE_PATTERN.test("src/foo.ts"), false);
});

test("T10d2. TEST_FILE_PATTERN 不匹配 tests/foo.ts（缺 .test）", () => {
  assert.equal(TEST_FILE_PATTERN.test("tests/foo.ts"), false);
});

test("T10e. TEST_FILE_PATTERN 已冻结", () => {
  // RegExp 对象本身不可变（pattern/flags 只读），但仍校验 Object.isFrozen
  assert.equal(Object.isFrozen(TEST_FILE_PATTERN), true);
});

test('T10f. DOMAIN_LAYER_PREFIX = "src/domain/"', () => {
  assert.equal(DOMAIN_LAYER_PREFIX, "src/domain/");
});

test("T10g. DOMAIN_LAYER_PREFIX 已冻结", () => {
  assert.equal(Object.isFrozen(DOMAIN_LAYER_PREFIX), true);
});
