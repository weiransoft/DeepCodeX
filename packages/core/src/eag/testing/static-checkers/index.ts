/**
 * 测试质量静态判定器注册表（EAG-P3 批次 10 §4.7）
 *
 * 本模块对应 EAG-P3 批次 10 设计 §4.7.3 DEFAULT_TEST_QUALITY_CHECKERS 注册表：
 * - 统一导出 3 个 TestQualityChecker 类
 * - 维护 checkerId → TestQualityChecker 实例的注册表（DEFAULT_TEST_QUALITY_CHECKERS）
 * - TestingOrchestrator 按此注册表路由到对应 Checker 实例
 *
 * 注册表设计：
 * - 一对一映射：每个 checkerId 对应一个 Checker 实例（与 coding/static-checkers 的多对一映射不同）
 * - Object.freeze 冻结：防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）
 * - ReadonlyMap 类型：编译期保证不可变
 *
 * 设计依据：
 * - EAG 方案 §5.2.4 测试质量约束
 * - EAG-P3 批次 10 设计 §4.7.2 静态判定器清单（3 个）
 * - EAG-P3 批次 10 设计 §4.7.3 协议定义与 DEFAULT_TEST_QUALITY_CHECKERS 注册表
 *
 * 不可变优先原则：
 * - DEFAULT_TEST_QUALITY_CHECKERS 使用 Object.freeze(new Map([...])) 冻结
 * - 所有 Checker 类的 checkerId / severity 字段使用 Object.freeze 冻结
 * - 导出类型使用 ReadonlyMap / ReadonlyArray
 *
 * @module eag/testing/static-checkers
 */

// ============================================================================
// 1. 类型导入（仅 type-only）
// ============================================================================

import type {
  GeneratedTestFile,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestQualitySeverity,
  TestQualityViolation,
  UncoveredSymbol,
} from "../types";

// ============================================================================
// 2. 3 个测试质量判定器类导出
// ============================================================================

// 断言密度检查（每测试用例 ≥1 断言，blocker 级）
export { AssertionDensityChecker } from "./assertion-density-checker";

// 测试命名规范（should_* / when_* / it_* 前缀，warning 级）
export { TestNamingChecker } from "./test-naming-checker";

// 覆盖率空白检测（高风险符号无测试，blocker 级）
export { CoverageGapChecker } from "./coverage-gap-checker";

// ============================================================================
// 3. 实例化所有 Checker（按 §4.7.3 注册表顺序）
// ============================================================================

// 注：实例化放在 import 之后，避免循环依赖。
// 每个 Checker 实例为无状态单例（无字段、无副作用），可安全共享。
import { AssertionDensityChecker } from "./assertion-density-checker";
import { TestNamingChecker } from "./test-naming-checker";
import { CoverageGapChecker } from "./coverage-gap-checker";

/**
 * 默认测试质量 Checker 注册表
 *
 * 对应 EAG-P3 批次 10 设计 §4.7.3 DEFAULT_TEST_QUALITY_CHECKERS：
 * 维护 checkerId → TestQualityChecker 实例的映射。
 *
 * 注册规则（一对一映射）：
 * - assertion-density → AssertionDensityChecker（断言密度检查，blocker）
 * - test-naming → TestNamingChecker（测试命名规范，warning）
 * - coverage-gap → CoverageGapChecker（覆盖率空白检测，blocker）
 *
 * 使用 Object.freeze(new Map([...])) 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 *
 * 范例：
 *   ```typescript
 *   import { DEFAULT_TEST_QUALITY_CHECKERS } from "./static-checkers";
 *
 *   for (const [checkerId, checker] of DEFAULT_TEST_QUALITY_CHECKERS) {
 *     const result = checker.check(testFiles, context);
 *     if (!result.passed && result.severity === "blocker") {
 *       // 阻断 TESTING Loop
 *     }
 *   }
 *   ```
 */
export const DEFAULT_TEST_QUALITY_CHECKERS: ReadonlyMap<string, TestQualityChecker> = Object.freeze(
  new Map<string, TestQualityChecker>([
    ["assertion-density", new AssertionDensityChecker()],
    ["test-naming", new TestNamingChecker()],
    ["coverage-gap", new CoverageGapChecker()],
  ])
);

/**
 * 获取所有已注册的 Checker ID 列表
 *
 * 工具函数：返回 DEFAULT_TEST_QUALITY_CHECKERS 中所有 checkerId（按字典序排序）。
 * 用于测试断言与日志展示。
 *
 * @returns 已注册的 Checker ID 列表（只读，按字典序排序）
 */
export function getRegisteredCheckerIds(): ReadonlyArray<string> {
  return Object.freeze(Array.from(DEFAULT_TEST_QUALITY_CHECKERS.keys()).sort());
}

/**
 * 按 checkerId 查找 TestQualityChecker 实例
 *
 * @param checkerId Checker ID（如 "assertion-density" / "test-naming" / "coverage-gap"）
 * @returns 对应的 TestQualityChecker 实例；未注册返回 undefined
 */
export function getCheckerById(checkerId: string): TestQualityChecker | undefined {
  return DEFAULT_TEST_QUALITY_CHECKERS.get(checkerId);
}

/**
 * 运行所有 Checker 收集判定结果
 *
 * 工具函数：TestingOrchestrator 调用此函数批量执行所有 Checker。
 *
 * 算法：
 * 1. 遍历 DEFAULT_TEST_QUALITY_CHECKERS 中所有 Checker
 * 2. 对每个 Checker 调用 check(testFiles, context) 方法
 * 3. 收集所有 TestQualityResult（按字典序排序的 checkerId 顺序）
 *
 * @param testFiles 待判定的测试文件列表
 * @param context 测试质量上下文
 * @returns 所有 Checker 的判定结果列表（按字典序排序的 checkerId）
 */
export function runAllCheckers(
  testFiles: ReadonlyArray<GeneratedTestFile>,
  context: Readonly<TestQualityContext>
): ReadonlyArray<TestQualityResult> {
  const results: TestQualityResult[] = [];
  const sortedEntries = Array.from(DEFAULT_TEST_QUALITY_CHECKERS.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [, checker] of sortedEntries) {
    const result = checker.check(testFiles, context);
    results.push(result);
  }

  return Object.freeze(results);
}

// ============================================================================
// 4. 类型重导出（便于外部模块统一从 static-checkers 导入）
// ============================================================================

export type {
  GeneratedTestFile,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestQualitySeverity,
  TestQualityViolation,
  UncoveredSymbol,
} from "../types";
