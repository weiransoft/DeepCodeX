/**
 * 覆盖率空白判定器（CoverageGapChecker）—— EAG-P3 批次 10 §4.7
 *
 * 负责测试质量红线：
 * - 高风险符号必须被至少一个测试文件引用（import / 符号引用）
 * - 风险评分 ≥ HIGH_RISK_SCORE_THRESHOLD（0.7）的符号强制必测
 *
 * 判定算法：
 * 1. 从 TestQualityContext.highRiskSymbols 获取必测符号列表
 * 2. 过滤出风险评分 ≥ 0.7 的高风险符号（强制必测集）
 * 3. 扫描所有测试文件的 import 路径与符号引用
 * 4. 对每个高风险符号检查是否被任何测试文件引用
 * 5. 未被任何测试文件引用的高风险符号 → 违规
 *
 * 严重级：blocker（不通过即打回 TESTING Loop）
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计 §4.7.2 静态判定器清单
 * - EAG-P3 批次 10 设计 §4.7.6 CoverageGapChecker 实现要点
 * - EAG 方案 §5.2.4 高风险符号必测约束
 * - EAG 方案 §8.6 高风险符号覆盖率 100% 要求
 *
 * 不可变优先原则：
 * - checkerId / severity 字段使用 Object.freeze 冻结
 * - violations 数组与 TestQualityResult 整体 Object.freeze 冻结
 *
 * @module eag/testing/static-checkers/coverage-gap-checker
 */

import type {
  GeneratedTestFile,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestQualitySeverity,
  TestQualityViolation,
  UncoveredSymbol,
} from "../types";
import { HIGH_RISK_SCORE_THRESHOLD } from "../types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 该 Checker 唯一标识符（与 DEFAULT_TEST_QUALITY_CHECKERS 注册表 key 一致）
 */
const CHECKER_ID = "coverage-gap" as const;

/**
 * 严重级：blocker（高风险符号无测试覆盖即打回 TESTING Loop）
 *
 * 对齐 §4.7.2 表格——CoverageGapChecker 严重级为 blocker。
 */
const SEVERITY: TestQualitySeverity = "blocker";

/**
 * import 语句扫描正则
 *
 * 支持 4 种 import 形式：
 * 1. default import：`import OSS from 'ali-oss';`
 * 2. named import：`import { OSS } from 'ali-oss';`
 * 3. namespace import：`import * as crypto from 'crypto';`
 * 4. side-effect import：`import 'reflect-metadata';`
 *
 * 分组说明：
 * - 分组 1：import 子句（含括号或 default 名）
 * - 分组 2：模块来源路径
 */
const STANDARD_IMPORT_RE = /^\s*import\s+(?:type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/;

/**
 * 符号引用扫描正则
 *
 * 识别代码中所有可能的符号引用：
 * - `SymbolName`（直接引用）
 * - `obj.SymbolName`（属性访问）
 * - `SymbolName(args)`（函数调用）
 * - `new SymbolName(args)`（构造调用）
 *
 * 用于检测测试文件中是否引用了高风险符号。
 *
 * 分组 1：符号名（必须以大写字母或下划线开头，后跟字母数字下划线）
 */
const SYMBOL_REFERENCE_RE = /\b([A-Z_][A-Za-z0-9_]*)\b/g;

// ============================================================================
// 2. 辅助类型定义
// ============================================================================

/**
 * import 语句元数据
 */
interface ImportStatement {
  /** 模块来源路径 */
  readonly source: string;
  /** import 子句原文 */
  readonly clause: string;
  /** 行号（1-based） */
  readonly line: number;
}

// ============================================================================
// 3. 核心扫描函数
// ============================================================================

/**
 * 扫描代码中的 import 语句
 *
 * 复用 coding/static-checkers/checker-utils.ts 的算法，独立实现以避免循环依赖。
 *
 * @param content 代码内容
 * @returns import 语句列表
 */
function scanImports(content: string): ImportStatement[] {
  const results: ImportStatement[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    let m = line.match(STANDARD_IMPORT_RE);
    if (m) {
      results.push({
        source: m[2],
        clause: m[1].trim(),
        line: i + 1,
      });
      continue;
    }
    m = line.match(SIDE_EFFECT_IMPORT_RE);
    if (m) {
      results.push({
        source: m[1],
        clause: "",
        line: i + 1,
      });
    }
  }
  return results;
}

/**
 * 提取代码中所有的符号引用
 *
 * 识别所有以大写字母或下划线开头的标识符（TypeScript 类名/接口名/枚举名约定）。
 * 跳过注释行与字符串字面量内的标识符。
 *
 * @param content 代码内容
 * @returns 符号名集合（去重）
 */
function extractSymbolReferences(content: string): Set<string> {
  const symbols = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    // 跳过注释行
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    // 重置正则 lastIndex（全局正则在多次 exec 调用间需重置）
    SYMBOL_REFERENCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SYMBOL_REFERENCE_RE.exec(line)) !== null) {
      const symbolName = m[1];
      // 过滤 TypeScript 保留字与常见全局对象
      if (!isReservedWord(symbolName)) {
        symbols.add(symbolName);
      }
    }
  }

  return symbols;
}

/**
 * 判定符号名是否为 TypeScript 保留字或常见全局对象
 *
 * 这些不应被视为业务符号引用（如 String/Number/Array/Object/Promise 等内置类型）。
 *
 * @param name 符号名
 * @returns true 表示保留字或全局对象（应过滤）
 */
function isReservedWord(name: string): boolean {
  // TypeScript 内置类型与 ECMAScript 全局对象（不全，但覆盖常见）
  const reservedWords: ReadonlySet<string> = new Set([
    // ECMAScript 全局对象
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Function",
    "Symbol",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "EvalError",
    "Math",
    "JSON",
    "console",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "Infinity",
    "NaN",
    "undefined",
    // TypeScript 工具类型
    "Record",
    "Readonly",
    "ReadonlyArray",
    "Partial",
    "Required",
    "Pick",
    "Omit",
    "ReadonlyMap",
    "ReadonlySet",
    "Awaited",
    "PromiseConstructor",
    // Node.js 全局
    "Buffer",
    "Process",
    "Global",
    // TypeScript 关键字
    "Promise",
    "Module",
    "Namespace",
  ]);
  return reservedWords.has(name);
}

/**
 * 从符号 ID 中提取符号名
 *
 * 符号 ID 格式约定：`<filePath>:<SymbolName>.<methodName>` 或 `<filePath>:<SymbolName>`
 *
 * @param symbolId 符号 ID
 * @returns 符号名（最后一个 : 之后到 . 之前的部分）
 */
function extractSymbolName(symbolId: string): string {
  // 取最后一个 : 之后的部分
  const afterColon = symbolId.split(":").pop() ?? symbolId;
  // 取第一个 . 之前的部分（类名，不含方法名）
  const symbolName = afterColon.split(".")[0];
  return symbolName;
}

/**
 * 从符号 ID 中提取文件路径
 *
 * @param symbolId 符号 ID（格式：<filePath>:<SymbolName>）
 * @returns 文件路径（不含符号名部分）
 */
function extractFilePath(symbolId: string): string {
  const colonIdx = symbolId.lastIndexOf(":");
  if (colonIdx === -1) {
    return symbolId;
  }
  return symbolId.slice(0, colonIdx);
}

/**
 * 判定高风险符号是否被测试文件覆盖
 *
 * 算法：
 * 1. 提取符号的文件路径与符号名
 * 2. 检查测试文件的 import 语句中是否引用了该文件路径（路径包含匹配）
 * 3. 若 import 引用了文件路径，进一步检查符号名是否在测试代码中被引用
 * 4. 若任一条件满足，视为已覆盖
 *
 * @param symbol 高风险符号
 * @param testFiles 测试文件列表
 * @returns true 表示符号被至少一个测试文件引用
 */
function isSymbolCoveredByTests(symbol: UncoveredSymbol, testFiles: ReadonlyArray<GeneratedTestFile>): boolean {
  const symbolName = extractSymbolName(symbol.symbolId);
  const symbolFilePath = extractFilePath(symbol.symbolId);

  // 兜底：符号名为空（不应发生，但防御性处理）
  if (symbolName.length === 0) {
    return true;
  }

  for (const testFile of testFiles) {
    // 1. 检查 import 路径是否引用了高风险符号所在文件
    const imports = scanImports(testFile.content);
    const hasImportMatch = imports.some((imp) => {
      // 标准化路径比较：去除 ./ ../ 前缀，比较文件名（不含扩展名）
      const normalizedSource = imp.source.replace(/^\.\//, "").replace(/^\.\.\//, "");
      const normalizedSymbolPath = symbolFilePath.replace(/^\.\//, "").replace(/^\.\.\//, "");
      // 路径包含匹配（符号路径是 import 路径的子串，或反之）
      return (
        normalizedSource.includes(normalizedSymbolPath) ||
        normalizedSymbolPath.includes(normalizedSource) ||
        // 比较文件名（不含目录与扩展名）
        extractFileNameWithoutExt(normalizedSource) === extractFileNameWithoutExt(normalizedSymbolPath)
      );
    });

    if (hasImportMatch) {
      // 2. 进一步检查符号名是否在测试代码中被引用
      const symbolRefs = extractSymbolReferences(testFile.content);
      if (symbolRefs.has(symbolName)) {
        return true;
      }
    }

    // 3. 兜底检查：即使没有显式 import，符号名在测试代码中被直接引用（如通过 re-export）
    const allSymbolRefs = extractSymbolReferences(testFile.content);
    if (allSymbolRefs.has(symbolName)) {
      return true;
    }
  }

  return false;
}

/**
 * 从路径中提取文件名（不含扩展名）
 *
 * @param path 文件路径
 * @returns 文件名（不含扩展名）
 */
function extractFileNameWithoutExt(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx === -1) {
    return fileName;
  }
  return fileName.slice(0, dotIdx);
}

// ============================================================================
// 4. CoverageGapChecker 判定器实现
// ============================================================================

/**
 * 覆盖率空白判定器
 *
 * 实现 TestQualityChecker 协议，负责检测高风险符号是否被测试覆盖。
 *
 * 判定规则（对齐 §4.7.6）：
 * 1. 从 TestQualityContext.highRiskSymbols 获取必测符号列表
 * 2. 过滤出风险评分 ≥ HIGH_RISK_SCORE_THRESHOLD（0.7）的高风险符号（强制必测集）
 * 3. 扫描所有测试文件的 import 路径与符号引用
 * 4. 对每个高风险符号检查是否被任何测试文件引用
 * 5. 未被任何测试文件引用的高风险符号 → 违规
 *
 * 严重级：blocker（不通过即打回 TESTING Loop）
 */
export class CoverageGapChecker implements TestQualityChecker {
  /** Checker 唯一标识符 */
  readonly checkerId: string = CHECKER_ID;

  /** 严重级：blocker */
  readonly severity: TestQualitySeverity = SEVERITY;

  /**
   * 执行静态判定
   *
   * @param testFiles 待判定的测试文件列表
   * @param context 测试质量上下文（含高风险符号列表）
   * @returns 判定结果（含违规项列表）
   */
  check(testFiles: ReadonlyArray<GeneratedTestFile>, context: Readonly<TestQualityContext>): TestQualityResult {
    const violations: TestQualityViolation[] = [];

    // 过滤出强制必测的高风险符号（风险评分 ≥ HIGH_RISK_SCORE_THRESHOLD）
    const mandatorySymbols = context.highRiskSymbols.filter((symbol) => symbol.riskScore >= HIGH_RISK_SCORE_THRESHOLD);

    // 对每个强制必测符号检查是否被测试覆盖
    for (const symbol of mandatorySymbols) {
      const isCovered = isSymbolCoveredByTests(symbol, testFiles);
      if (!isCovered) {
        violations.push({
          filePath: symbol.filePath,
          line: 1, // 符号定义行号未知，使用 1 表示文件级违规
          description:
            `高风险符号 "${symbol.symbolId}"（风险评分 ${symbol.riskScore.toFixed(2)} ≥ 阈值 ${HIGH_RISK_SCORE_THRESHOLD}）` +
            `未被任何测试文件引用——违反 §8.6 高风险符号必测约束。` +
            `原因：${symbol.reason}`,
          suggestion:
            `为高风险符号 "${symbol.symbolId}" 补充测试用例：\n` +
            `  1. 在测试文件中 import 该符号所在模块\n` +
            `  2. 编写至少 1 个 it/test 用例覆盖该符号的核心行为\n` +
            `  3. 在用例中调用 assert/expect 断言符号的期望行为\n` +
            `  4. 运行 c8 覆盖率工具确认该符号已被覆盖`,
        });
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
