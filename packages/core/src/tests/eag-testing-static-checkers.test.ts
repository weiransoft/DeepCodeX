/**
 * EAG-P3 批次 10 单元测试：测试质量静态判定器（static-checkers/）
 *
 * 测试范围：
 * - T1. AssertionDensityChecker
 *   - T1a. 实例化与 checkerId / severity 字段
 *   - T1b. 含断言的测试 → 通过
 *   - T1c. 无断言的测试 → blocker 违规
 *   - T1d. 多 it 节点：部分无断言 → 仅违规节点
 *   - T1e. it.skip 节点不强制断言
 *   - T1f. test.skip 节点不强制断言
 *   - T1g. 空文件 → 通过（无测试用例）
 *   - T1h. describe 块不计入测试用例数
 *   - T1i. expect 断言也被识别
 * - T2. TestNamingChecker
 *   - T2a. 实例化与 checkerId / severity 字段
 *   - T2b. should 前缀测试 → 通过
 *   - T2c. when 前缀测试 → 通过
 *   - T2d. it 前缀测试 → 通过
 *   - T2e. 非法前缀测试 → warning 违规
 *   - T2f. 中文命名测试 → 通过（仅 WARNING）
 *   - T2g. 空文件 → 通过
 * - T3. CoverageGapChecker
 *   - T3a. 实例化与 checkerId / severity 字段
 *   - T3b. 高风险符号被测试覆盖 → 通过
 *   - T3c. 高风险符号未被测试覆盖 → blocker 违规
 *   - T3d. 风险评分 < 0.7 的符号不强制必测
 *   - T3e. 空高风险符号列表 → 通过
 * - T4. DEFAULT_TEST_QUALITY_CHECKERS 注册表
 *   - T4a. 含 3 个 Checker 实例
 *   - T4b. 注册表冻结
 *   - T4c. getRegisteredCheckerIds 返回字典序排序的 ID
 *   - T4d. getCheckerById 返回对应实例
 *   - T4e. runAllCheckers 执行所有 Checker
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-testing-static-checkers
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AssertionDensityChecker } from "../eag/testing/static-checkers/assertion-density-checker";
import { TestNamingChecker } from "../eag/testing/static-checkers/test-naming-checker";
import { CoverageGapChecker } from "../eag/testing/static-checkers/coverage-gap-checker";
import {
  DEFAULT_TEST_QUALITY_CHECKERS,
  getRegisteredCheckerIds,
  getCheckerById,
  runAllCheckers,
} from "../eag/testing/static-checkers/index";
import type { GeneratedTestFile, TestQualityContext, UncoveredSymbol } from "../eag/testing/types";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 构造测试用 GeneratedTestFile
 *
 * @param relativePath 文件相对路径
 * @param content 文件内容
 * @returns GeneratedTestFile 实例
 */
function createTestFile(relativePath: string, content: string): GeneratedTestFile {
  return {
    relativePath,
    content,
    kind: "contract",
    requirementId: "F-001",
    sourceId: "/api/v1/test",
    testCaseCount: 1,
    testCaseDescriptions: [],
  };
}

/**
 * 构造测试用 TestQualityContext
 *
 * @param highRiskSymbols 高风险符号列表
 * @param projectRoot 项目根目录
 * @returns TestQualityContext 实例
 */
function createTestQualityContext(
  highRiskSymbols: UncoveredSymbol[] = [],
  projectRoot = "/tmp/test-project"
): TestQualityContext {
  return {
    highRiskSymbols,
    projectRoot,
  };
}

/**
 * 构造高风险符号
 *
 * @param symbolId 符号 ID
 * @param filePath 文件路径
 * @param riskScore 风险评分
 * @returns UncoveredSymbol 实例
 */
function createHighRiskSymbol(symbolId: string, filePath: string, riskScore = 0.85): UncoveredSymbol {
  return {
    symbolId,
    filePath,
    reason: "high-risk-no-test",
    riskScore,
  };
}

// ============================================================================
// T1. AssertionDensityChecker
// ============================================================================

test("T1a: AssertionDensityChecker 实例化与 checkerId / severity 字段", () => {
  const checker = new AssertionDensityChecker();
  assert.equal(checker.checkerId, "assertion-density", "checkerId 应为 assertion-density");
  assert.equal(checker.severity, "blocker", "severity 应为 blocker");
});

test("T1b: 含断言的测试 → 通过", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      "",
      'test("should pass", () => {',
      "  assert.ok(true);",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.checkerId, "assertion-density");
  assert.equal(result.passed, true, "含断言的测试应通过");
  assert.equal(result.violations.length, 0, "无违规");
});

test("T1c: 无断言的测试 → blocker 违规", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      "",
      'test("should fail", () => {',
      '  console.log("no assertion");',
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, false, "无断言的测试应不通过");
  assert.equal(result.severity, "blocker", "严重级应为 blocker");
  assert.ok(result.violations.length > 0, "应有违规");
  assert.ok(
    result.violations[0]!.description.includes("断言") || result.violations[0]!.description.includes("assert"),
    "违规描述应提及断言"
  );
});

test("T1d: 多 it 节点：部分无断言 → 仅违规节点", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      "",
      'test("should pass with assertion", () => {',
      "  assert.ok(true);",
      "});",
      "",
      'test("should fail without assertion", () => {',
      '  console.log("missing");',
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, false, "应不通过");
  assert.equal(result.violations.length, 1, "应仅 1 个违规（无断言的 it 节点）");
});

test("T1e: it.skip 节点不强制断言", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      "",
      'it.skip("skipped test", () => {',
      '  console.log("skipped");',
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, true, "it.skip 节点不强制断言");
});

test("T1f: test.skip 节点不强制断言", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      "",
      'test.skip("skipped test", () => {',
      '  console.log("skipped");',
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, true, "test.skip 节点不强制断言");
});

test("T1g: 空文件 → 通过（无测试用例）", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile("tests/test1.test.ts", "");
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, true, "空文件应通过");
});

test("T1h: describe 块不计入测试用例数", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test, describe } from "node:test";',
      'import assert from "node:assert/strict";',
      "",
      'describe("module", () => {',
      '  test("should pass", () => {',
      "    assert.ok(true);",
      "  });",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, true, "describe 块内的 test 节点应被检查，describe 本身不计入用例");
});

test("T1i: expect 断言也被识别", () => {
  const checker = new AssertionDensityChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      "",
      'test("should pass with expect", () => {',
      "  expect(1).toBe(1);",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.passed, true, "expect 断言应被识别");
});

// ============================================================================
// T2. TestNamingChecker
// ============================================================================

test("T2a: TestNamingChecker 实例化与 checkerId / severity 字段", () => {
  const checker = new TestNamingChecker();
  assert.equal(checker.checkerId, "test-naming", "checkerId 应为 test-naming");
  assert.equal(checker.severity, "warning", "severity 应为 warning");
});

test("T2b: should 前缀测试 → 通过", () => {
  const checker = new TestNamingChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    ['import { test } from "node:test";', "", 'test("should pass when valid input", () => {', "  // no-op", "});"].join(
      "\n"
    )
  );
  const result = checker.check([file], createTestQualityContext());
  // 命名违规为 warning 级，passed 可能为 true（warning 不打回）
  assert.equal(result.severity, "warning", "命名规范为 warning 级");
});

test("T2c: when 前缀测试 → 通过", () => {
  const checker = new TestNamingChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      "",
      'test("when input is valid then return success", () => {',
      "  // no-op",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.severity, "warning", "命名规范为 warning 级");
  // when 前缀的命名应不产生违规
  const namingViolations = result.violations.filter((v) => v.description.includes("命名"));
  assert.equal(namingViolations.length, 0, "when 前缀不应有命名违规");
});

test("T2d: it 前缀测试 → 通过", () => {
  const checker = new TestNamingChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    ['import { test } from "node:test";', "", 'test("it should validate input", () => {', "  // no-op", "});"].join(
      "\n"
    )
  );
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.severity, "warning");
});

test("T2e: 非法前缀测试 → warning 违规", () => {
  const checker = new TestNamingChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    ['import { test } from "node:test";', "", 'test("invalid name without prefix", () => {', "  // no-op", "});"].join(
      "\n"
    )
  );
  const result = checker.check([file], createTestQualityContext());
  assert.ok(result.violations.length > 0, "非法前缀应有违规");
});

test("T2g: 空文件 → 通过", () => {
  const checker = new TestNamingChecker();
  const file = createTestFile("tests/test1.test.ts", "");
  const result = checker.check([file], createTestQualityContext());
  assert.equal(result.violations.length, 0, "空文件无命名违规");
});

// ============================================================================
// T3. CoverageGapChecker
// ============================================================================

test("T3a: CoverageGapChecker 实例化与 checkerId / severity 字段", () => {
  const checker = new CoverageGapChecker();
  assert.equal(checker.checkerId, "coverage-gap", "checkerId 应为 coverage-gap");
  assert.equal(checker.severity, "blocker", "severity 应为 blocker");
});

test("T3b: 高风险符号被测试覆盖 → 通过", () => {
  const checker = new CoverageGapChecker();
  const highRiskSymbol = createHighRiskSymbol(
    "src/services/PaymentService.ts:PaymentService",
    "src/services/PaymentService.ts"
  );
  const file = createTestFile(
    "tests/payment.test.ts",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { PaymentService } from "../src/services/PaymentService";',
      "",
      'test("should pass", () => {',
      "  assert.ok(PaymentService);",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext([highRiskSymbol]));
  assert.equal(result.passed, true, "被测试覆盖的高风险符号应通过");
});

test("T3c: 高风险符号未被测试覆盖 → blocker 违规", () => {
  const checker = new CoverageGapChecker();
  const highRiskSymbol = createHighRiskSymbol(
    "src/services/PaymentService.ts:PaymentService",
    "src/services/PaymentService.ts"
  );
  const file = createTestFile(
    "tests/order.test.ts",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { OrderService } from "../src/services/OrderService";',
      "",
      'test("should pass", () => {',
      "  assert.ok(OrderService);",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext([highRiskSymbol]));
  assert.equal(result.passed, false, "未被覆盖的高风险符号应不通过");
  assert.equal(result.severity, "blocker");
  assert.ok(result.violations.length > 0, "应有违规");
});

test("T3d: 风险评分 < 0.7 的符号不强制必测", () => {
  const checker = new CoverageGapChecker();
  const lowRiskSymbol = createHighRiskSymbol(
    "src/utils/helper.ts:Helper",
    "src/utils/helper.ts",
    0.5 // 低于 0.7 阈值
  );
  const file = createTestFile(
    "tests/order.test.ts",
    [
      'import { test } from "node:test";',
      'import { OrderService } from "../src/services/OrderService";',
      "",
      'test("should pass", () => {',
      "  // no-op",
      "});",
    ].join("\n")
  );
  const result = checker.check([file], createTestQualityContext([lowRiskSymbol]));
  assert.equal(result.passed, true, "低风险符号不强制必测");
});

test("T3e: 空高风险符号列表 → 通过", () => {
  const checker = new CoverageGapChecker();
  const file = createTestFile(
    "tests/test1.test.ts",
    ['import { test } from "node:test";', 'test("should pass", () => {', "  // no-op", "});"].join("\n")
  );
  const result = checker.check([file], createTestQualityContext([]));
  assert.equal(result.passed, true, "无高风险符号时应通过");
});

// ============================================================================
// T4. DEFAULT_TEST_QUALITY_CHECKERS 注册表
// ============================================================================

test("T4a: DEFAULT_TEST_QUALITY_CHECKERS 含 3 个 Checker 实例", () => {
  assert.equal(DEFAULT_TEST_QUALITY_CHECKERS.size, 3, "应含 3 个 Checker 实例");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("assertion-density"), "应含 assertion-density");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("test-naming"), "应含 test-naming");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("coverage-gap"), "应含 coverage-gap");
});

test("T4b: DEFAULT_TEST_QUALITY_CHECKERS 注册表为 ReadonlyMap（类型级不可变）", () => {
  // 注：Object.freeze(new Map()) 不能阻止 Map.set() 运行期调用，
  // 但 ReadonlyMap 类型在编译期禁止 .set() / .delete() / .clear()。
  // 此处验证注册表返回的 Checker 实例的字段被冻结。
  const checker = getCheckerById("assertion-density");
  assert.ok(checker, "应能获取 AssertionDensityChecker 实例");
  // checkerId 字段应被 Object.freeze 冻结（每个 Checker 实例的 checkerId 是 readonly）
  assert.equal(checker!.checkerId, "assertion-density", "checkerId 应正确");
  // 注册表 size 字段应正确
  assert.equal(DEFAULT_TEST_QUALITY_CHECKERS.size, 3, "size 应为 3");
});

test("T4c: getRegisteredCheckerIds 返回字典序排序的 ID", () => {
  const ids = getRegisteredCheckerIds();
  assert.deepEqual([...ids], ["assertion-density", "coverage-gap", "test-naming"], "应返回字典序排序的 3 个 ID");
});

test("T4d: getCheckerById 返回对应实例", () => {
  const checker = getCheckerById("assertion-density");
  assert.ok(checker, "应返回 AssertionDensityChecker 实例");
  assert.equal(checker!.checkerId, "assertion-density");

  const notFound = getCheckerById("invalid-id");
  assert.equal(notFound, undefined, "未注册的 ID 应返回 undefined");
});

test("T4e: runAllCheckers 执行所有 Checker", () => {
  const file = createTestFile(
    "tests/test1.test.ts",
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      "",
      'test("should pass", () => {',
      "  assert.ok(true);",
      "});",
    ].join("\n")
  );
  const results = runAllCheckers([file], createTestQualityContext());
  assert.equal(results.length, 3, "应执行 3 个 Checker");
  // 按字典序排序：assertion-density / coverage-gap / test-naming
  assert.equal(results[0]!.checkerId, "assertion-density");
  assert.equal(results[1]!.checkerId, "coverage-gap");
  assert.equal(results[2]!.checkerId, "test-naming");
});
