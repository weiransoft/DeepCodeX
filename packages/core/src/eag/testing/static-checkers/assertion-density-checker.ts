/**
 * 断言密度判定器（AssertionDensityChecker）—— EAG-P3 批次 10 §4.7
 *
 * 负责测试质量红线：
 * - 每个测试用例节点（it/test）必须含至少 1 个断言调用（assert/assert.ok/expect 等）
 * - describe 块不计入测试用例数（仅 it/test 节点视为一个用例）
 * - 跳过 it.skip / test.skip 节点（被显式跳过的用例不强制要求断言）
 *
 * 判定算法：
 * 1. 按行分割测试文件内容
 * 2. 用正则识别 it/test 节点起始位置（含 describe 块嵌套层级跟踪）
 * 3. 对每个 it/test 节点提取其函数体范围（基于大括号配对算法）
 * 4. 在函数体内扫描 assert 与 expect 系列断言调用
 * 5. 若断言数 < MIN_ASSERTIONS_PER_TEST_CASE（默认 1）即视为违规
 *
 * 严重级：blocker（不通过即打回 TESTING Loop）
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计 §4.7.2 静态判定器清单
 * - EAG-P3 批次 10 设计 §4.7.4 AssertionDensityChecker 实现要点
 * - EAG 方案 §5.2.4 测试质量约束
 *
 * 不可变优先原则：
 * - redlineIds / severity 字段使用 Object.freeze 冻结
 * - violations 数组与 TestQualityResult 整体 Object.freeze 冻结
 *
 * @module eag/testing/static-checkers/assertion-density-checker
 */

import type {
  GeneratedTestFile,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestQualitySeverity,
  TestQualityViolation,
} from "../types";
import { MIN_ASSERTIONS_PER_TEST_CASE } from "../types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 该 Checker 唯一标识符（与 DEFAULT_TEST_QUALITY_CHECKERS 注册表 key 一致）
 */
const CHECKER_ID = "assertion-density" as const;

/**
 * 严重级：blocker（断言缺失即打回 TESTING Loop）
 *
 * 对齐 §4.7.2 表格——AssertionDensityChecker 严重级为 blocker。
 */
const SEVERITY: TestQualitySeverity = "blocker";

/**
 * 测试用例节点起始行正则（识别 it/test/test.skip/it.skip 等）
 *
 * 分组说明：
 * - 分组 1：函数名（it / test）
 * - 分组 2：跳过标记（.skip / .todo / .only，可能为空）
 *
 * 形式：`  it("描述", () => {` / `  test.skip("描述", function() {`
 *
 * 注：仅识别"行首至 it/test 关键字之间为空白"的行，避免误识别字符串字面量中的 it/test。
 */
const TEST_CASE_START_RE = /^\s*\b(it|test)\b(\.(?:skip|todo|only))?\s*\(/;

/**
 * 断言调用正则（识别 assert.* / expect.* 调用）
 *
 * 形式：
 * - `assert.equal(...)` / `assert.ok(...)` / `assert.throws(...)`
 * - `expect(...).to.equal(...)` / `expect(...).toBe(...)`
 *
 * 注：仅识别"行首至 assert/expect 关键字之间允许空白或可选链式前缀（如 node:assert/strict）"。
 */
const ASSERTION_CALL_RE = /\b(?:assert|expect)\b\s*(?:\.\w+)*\s*\(/;

// ============================================================================
// 2. 辅助类型定义
// ============================================================================

/**
 * 测试用例节点元数据
 *
 * 描述一个 it/test 节点的位置与函数体范围：
 * - functionName：函数名（"it" / "test"）
 * - skipMarker：跳过标记（".skip" / ".todo" / ".only" / "" 无跳过）
 * - startLine：起始行号（1-based）
 * - endLine：结束行号（1-based，函数体闭花括号所在行）
 * - bodyContent：函数体内容（不含签名行，含中间所有行）
 */
interface TestCaseNode {
  readonly functionName: "it" | "test";
  readonly skipMarker: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly bodyContent: string;
}

// ============================================================================
// 3. 核心扫描函数
// ============================================================================

/**
 * 扫描测试文件中的所有 it/test 节点
 *
 * 算法：
 * 1. 按行分割内容
 * 2. 逐行匹配 TEST_CASE_START_RE，识别 it/test 节点起始
 * 3. 从起始行向下扫描大括号配对，提取完整函数体范围
 * 4. 跳过被 it.skip/test.skip 标记的节点（仍记录但 skipMarker 非空）
 *
 * 注意：
 * - describe 块不计入测试用例数（仅 it/test 节点）
 * - it.skip/test.skip 节点会被识别并返回，但 skipMarker 非空，判定器外层根据 skipMarker 决定是否跳过
 *
 * @param content 测试文件内容
 * @returns 测试用例节点列表（按起始行号升序）
 */
function scanTestCaseNodes(content: string): TestCaseNode[] {
  const lines = content.split(/\r?\n/);
  const nodes: TestCaseNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行（避免误识别）
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    const m = line.match(TEST_CASE_START_RE);
    if (!m) continue;

    const functionName = m[1] as "it" | "test";
    const skipMarker = m[2] ?? "";

    // 从当前行向下扫描大括号配对，提取函数体范围
    // 算法：累计 { 与 } 计数，当计数归零时表示函数体结束
    let braceDepth = 0;
    let bodyStarted = false;
    let endLine = i + 1; // 1-based
    const bodyLines: string[] = [];

    for (let j = i; j < lines.length; j++) {
      const bodyLine = lines[j];
      for (const ch of bodyLine) {
        if (ch === "{") {
          braceDepth++;
          bodyStarted = true;
        } else if (ch === "}") {
          braceDepth--;
        }
      }
      if (j > i) {
        bodyLines.push(bodyLine);
      }
      if (bodyStarted && braceDepth === 0) {
        endLine = j + 1; // 1-based
        break;
      }
    }

    // 若函数体使用箭头函数表达式且无大括号（如 `it("...", () => assert.ok(x));`），
    // bodyStarted 可能为 false——此时将整个 it 行之后到分号/行尾视为函数体
    if (!bodyStarted) {
      // 检查是否为箭头函数无大括号形式（表达式体）
      const remainingAfterArrow = line.slice(line.indexOf("=>") + 2);
      if (remainingAfterArrow.trim().length > 0) {
        bodyLines.push(remainingAfterArrow);
        endLine = i + 1;
      }
    }

    nodes.push({
      functionName,
      skipMarker,
      startLine: i + 1,
      endLine,
      bodyContent: bodyLines.join("\n"),
    });
  }

  return nodes;
}

/**
 * 统计字符串中包含的断言调用次数
 *
 * 扫描 assert 与 expect 系列调用模式，返回命中次数。
 *
 * 注意：
 * - 跳过注释行（避免误统计注释中的断言示例）
 * - 仅统计 assert/expect 后跟 . 或 ( 的形式
 *
 * @param content 函数体内容
 * @returns 断言调用次数
 */
function countAssertions(content: string): number {
  const lines = content.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    // 跳过注释行
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    // 使用正则匹配所有断言调用
    // 注意：需重置 lastIndex（全局正则在 exec/test 调用后会保留状态）
    const matches = line.match(new RegExp(ASSERTION_CALL_RE.source, "g"));
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

// ============================================================================
// 4. AssertionDensityChecker 判定器实现
// ============================================================================

/**
 * 断言密度判定器
 *
 * 实现 TestQualityChecker 协议，负责检测每个 it/test 节点的断言密度。
 *
 * 判定规则（对齐 §4.7.4）：
 * 1. 扫描测试文件中的所有 it/test 节点
 * 2. 跳过 it.skip / test.skip / it.todo / test.todo 节点（被显式跳过的用例不强制要求断言）
 * 3. 对每个未跳过的 it/test 节点统计函数体内的 assert 与 expect 系列调用次数
 * 4. 若断言数 < MIN_ASSERTIONS_PER_TEST_CASE（默认 1）→ 违规
 *
 * 严重级：blocker（不通过即打回 TESTING Loop）
 */
export class AssertionDensityChecker implements TestQualityChecker {
  /** Checker 唯一标识符 */
  readonly checkerId: string = CHECKER_ID;

  /** 严重级：blocker */
  readonly severity: TestQualitySeverity = SEVERITY;

  /**
   * 执行静态判定
   *
   * @param testFiles 待判定的测试文件列表
   * @param _context 测试质量上下文（本判定器不使用 highRiskSymbols，仅使用 testFiles）
   * @returns 判定结果（含违规项列表）
   */
  check(testFiles: ReadonlyArray<GeneratedTestFile>, _context: Readonly<TestQualityContext>): TestQualityResult {
    const violations: TestQualityViolation[] = [];

    for (const testFile of testFiles) {
      // 扫描测试文件中的所有 it/test 节点
      const nodes = scanTestCaseNodes(testFile.content);

      for (const node of nodes) {
        // 跳过被显式跳过的用例（it.skip / test.skip / it.todo / test.todo）
        if (node.skipMarker === ".skip" || node.skipMarker === ".todo") {
          continue;
        }

        // 统计函数体内的断言调用次数
        const assertionCount = countAssertions(node.bodyContent);

        // 判定：断言数 < 最小要求 → 违规
        if (assertionCount < MIN_ASSERTIONS_PER_TEST_CASE) {
          violations.push({
            filePath: testFile.relativePath,
            line: node.startLine,
            description:
              `${node.functionName}() 用例（第 ${node.startLine} 行）的断言密度为 ${assertionCount}，` +
              `低于最小要求 ${MIN_ASSERTIONS_PER_TEST_CASE}——每个测试用例必须含至少 1 个 assert/expect 调用`,
            suggestion:
              `在 ${node.functionName}() 函数体内补充 assert.ok() / assert.equal() / expect() 等断言调用，` +
              `确保测试用例对被测行为做出可验证的期望判定。` +
              `若本用例为占位用例，请使用 ${node.functionName}.skip() 显式跳过。`,
          });
        }
      }
    }

    // 构建冻结的判定结果
    return buildResult(CHECKER_ID, violations, SEVERITY);
  }
}

// ============================================================================
// 5. 判定结果构建函数
// ============================================================================

/**
 * 构建判定结果（统一冻结 violations 数组与外层 result）
 *
 * 不可变优先：返回的 TestQualityResult 与 violations 数组均通过 Object.freeze 冻结。
 *
 * @param checkerId Checker ID
 * @param violations 违规项列表
 * @param severity 严重级
 * @returns 冻结的 TestQualityResult
 */
function buildResult(
  checkerId: string,
  violations: TestQualityViolation[],
  severity: TestQualitySeverity
): TestQualityResult {
  const frozenViolations = Object.freeze(violations.map((v) => Object.freeze({ ...v })));
  const result = Object.freeze({
    checkerId,
    passed: violations.length === 0,
    violations: frozenViolations,
    severity,
  });
  // readonly 数组与 mutable TestQualityViolation[] 类型不兼容，通过 unknown 中转断言。
  return result as unknown as TestQualityResult;
}
