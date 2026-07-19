/**
 * 测试命名规范判定器（TestNamingChecker）—— EAG-P3 批次 10 §4.7
 *
 * 负责测试质量红线：
 * - 测试用例名称应使用统一前缀：should / when / it（不区分大小写）
 * - 跳过非英文命名的测试（中文测试名仅 WARNING）
 *
 * 判定算法：
 * 1. 按行分割测试文件内容
 * 2. 用正则识别 it/test 节点的第一个字符串参数（描述文本）
 * 3. 检查描述文本前缀是否匹配 should/when/it（不区分大小写）
 * 4. 跳过 it.skip / test.skip 节点
 * 5. 中文测试名仅 WARNING（仍报告但不阻断）
 *
 * 严重级：warning（仅提示不打回 TESTING Loop）
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计 §4.7.2 静态判定器清单
 * - EAG-P3 批次 10 设计 §4.7.5 TestNamingChecker 实现要点
 * - EAG 方案 §5.2.4 测试质量约束
 *
 * 不可变优先原则：
 * - checkerId / severity 字段使用 Object.freeze 冻结
 * - violations 数组与 TestQualityResult 整体 Object.freeze 冻结
 *
 * @module eag/testing/static-checkers/test-naming-checker
 */

import type {
  GeneratedTestFile,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestQualitySeverity,
  TestQualityViolation,
} from "../types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 该 Checker 唯一标识符（与 DEFAULT_TEST_QUALITY_CHECKERS 注册表 key 一致）
 */
const CHECKER_ID = "test-naming" as const;

/**
 * 严重级：warning（仅提示不打回 TESTING Loop）
 *
 * 对齐 §4.7.2 表格——TestNamingChecker 严重级为 warning。
 */
const SEVERITY: TestQualitySeverity = "warning";

/**
 * 测试用例节点起始行正则（识别 it/test/test.skip/it.skip 等）
 *
 * 分组说明：
 * - 分组 1：函数名（it / test）
 * - 分组 2：跳过标记（.skip / .todo / .only，可能为空）
 *
 * 形式：`  it("描述", () => {` / `  test.skip("描述", function() {`
 */
const TEST_CASE_START_RE = /^\s*\b(it|test)\b(\.(?:skip|todo|only))?\s*\(/;

/**
 * 测试名称字符串提取正则
 *
 * 在 it/test 起始行中，提取第一个字符串字面量（描述文本）。
 *
 * 形式：
 * - `it("描述", ...)` → 描述 = "描述"
 * - `it('描述', ...)` → 描述 = "描述"
 * - `it(`描述`, ...)` → 描述 = "描述"（模板字符串）
 *
 * 分组说明：
 * - 分组 1：双引号字符串内容
 * - 分组 2：单引号字符串内容
 * - 分组 3：模板字符串内容
 */
const TEST_NAME_RE = /\b(?:it|test)\b(?:\.(?:skip|todo|only))?\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

/**
 * 合法的测试命名前缀列表（小写形式，不区分大小写匹配）
 *
 * 对齐 §4.7.5——测试命名规范 should_* / when_* / it_* 前缀。
 * 实际匹配时使用 toLowerCase() 后比较，所以此处定义为小写形式。
 */
const VALID_NAME_PREFIXES: ReadonlyArray<string> = Object.freeze(["should", "when", "it"]);

/**
 * 中文字符范围正则（用于识别中文测试名）
 *
 * 范围：\u4e00-\u9fa5（基本汉字区）+ 扩展区（可选，此处仅识别基本区即可）
 */
const CHINESE_CHAR_RE = /[\u4e00-\u9fa5]/;

// ============================================================================
// 2. 辅助类型定义
// ============================================================================

/**
 * 测试用例名称信息
 *
 * 描述一个 it/test 节点的名称与位置：
 * - functionName：函数名（"it" / "test"）
 * - skipMarker：跳过标记（".skip" / ".todo" / ".only" / "" 无跳过）
 * - name：测试名称（去除引号后的描述文本）
 * - line：起始行号（1-based）
 */
interface TestNameInfo {
  readonly functionName: "it" | "test";
  readonly skipMarker: string;
  readonly name: string;
  readonly line: number;
}

// ============================================================================
// 3. 核心扫描函数
// ============================================================================

/**
 * 扫描测试文件中的所有 it/test 节点名称
 *
 * 算法：
 * 1. 按行分割内容
 * 2. 逐行匹配 TEST_CASE_START_RE 识别 it/test 节点起始
 * 3. 在 it/test 起始行匹配 TEST_NAME_RE 提取第一个字符串字面量（描述文本）
 * 4. 跳过被 it.skip/test.skip 标记的节点（仍记录但 skipMarker 非空）
 *
 * @param content 测试文件内容
 * @returns 测试用例名称列表（按行号升序）
 */
function scanTestNames(content: string): TestNameInfo[] {
  const lines = content.split(/\r?\n/);
  const infos: TestNameInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行（避免误识别）
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;

    // 识别 it/test 起始行
    const startMatch = line.match(TEST_CASE_START_RE);
    if (!startMatch) continue;

    const functionName = startMatch[1] as "it" | "test";
    const skipMarker = startMatch[2] ?? "";

    // 提取第一个字符串字面量（描述文本）
    // 注：若 it/test 的描述跨多行（如模板字符串含换行），本简化实现仅取当前行
    // 这是因为测试命名规范判定关注的是描述的开头前缀，跨行描述的完整提取不影响前缀判定
    const nameMatch = line.match(TEST_NAME_RE);
    if (!nameMatch) {
      // it/test 起始行无字符串字面量（可能是动态拼接或换行书写），跳过判定
      continue;
    }

    // nameMatch[1] = 双引号内容，[2] = 单引号内容，[3] = 模板字符串内容
    const name = nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? "";

    infos.push({
      functionName,
      skipMarker,
      name,
      line: i + 1,
    });
  }

  return infos;
}

/**
 * 判定测试名称是否符合命名规范
 *
 * 规则：
 * - 名称非空
 * - 名称开头单词（以空格/下划线/连字符分隔）的小写形式应匹配 should/when/it
 *
 * 算法：
 * 1. 取名称第一个单词（split by 空格/_/-）
 * 2. 转小写后与 VALID_NAME_PREFIXES 比较
 *
 * @param name 测试名称
 * @returns true 表示符合命名规范
 */
function isValidNaming(name: string): boolean {
  if (name.trim().length === 0) {
    return false;
  }

  // 提取第一个单词（按空格/下划线/连字符/中文标点分隔）
  // 注意：中文字符本身不会被视为分隔符，需额外处理
  // 算法：取名称开头连续的 ASCII 字母
  const firstWordMatch = name.match(/^([A-Za-z]+)/);
  if (!firstWordMatch) {
    // 名称不以 ASCII 字母开头（如中文开头）→ 不符合命名规范
    return false;
  }

  const firstWord = firstWordMatch[1].toLowerCase();
  return VALID_NAME_PREFIXES.includes(firstWord);
}

/**
 * 判定测试名称是否为中文命名
 *
 * 启发式规则：名称中包含中文字符即视为中文命名。
 *
 * @param name 测试名称
 * @returns true 表示中文命名
 */
function isChineseName(name: string): boolean {
  return CHINESE_CHAR_RE.test(name);
}

// ============================================================================
// 4. TestNamingChecker 判定器实现
// ============================================================================

/**
 * 测试命名规范判定器
 *
 * 实现 TestQualityChecker 协议，负责检测每个 it/test 节点的命名规范。
 *
 * 判定规则（对齐 §4.7.5）：
 * 1. 扫描测试文件中的所有 it/test 节点
 * 2. 提取每个节点的第一个字符串参数（描述文本）
 * 3. 跳过 it.skip / test.skip / it.todo / test.todo 节点
 * 4. 检查描述前缀是否匹配 should/when/it（不区分大小写）
 * 5. 中文测试名仅 WARNING（仍报告但不阻断）
 *
 * 严重级：warning（仅提示不打回 TESTING Loop）
 */
export class TestNamingChecker implements TestQualityChecker {
  /** Checker 唯一标识符 */
  readonly checkerId: string = CHECKER_ID;

  /** 严重级：warning */
  readonly severity: TestQualitySeverity = SEVERITY;

  /**
   * 执行静态判定
   *
   * @param testFiles 待判定的测试文件列表
   * @param _context 测试质量上下文（本判定器不使用 highRiskSymbols）
   * @returns 判定结果（含违规项列表）
   */
  check(testFiles: ReadonlyArray<GeneratedTestFile>, _context: Readonly<TestQualityContext>): TestQualityResult {
    const violations: TestQualityViolation[] = [];

    for (const testFile of testFiles) {
      // 扫描测试文件中的所有 it/test 节点名称
      const infos = scanTestNames(testFile.content);

      for (const info of infos) {
        // 跳过被显式跳过的用例
        if (info.skipMarker === ".skip" || info.skipMarker === ".todo") {
          continue;
        }

        // 跳过空名称（可能是动态拼接，无法判定）
        if (info.name.trim().length === 0) {
          continue;
        }

        // 判定命名规范
        if (isValidNaming(info.name)) {
          continue; // 符合命名规范，无违规
        }

        // 中文测试名：仍报告但不阻断（warning 级本就不阻断）
        const isChinese = isChineseName(info.name);
        const description = isChinese
          ? `${info.functionName}() 用例（第 ${info.line} 行）名称 "${info.name}" 为中文命名——` +
            `建议改用英文前缀（should/when/it）以便于跨团队协作与工具链识别`
          : `${info.functionName}() 用例（第 ${info.line} 行）名称 "${info.name}" 不符合命名规范——` +
            `应以 should/when/it 开头（不区分大小写），如 "should return 200 when valid input"`;

        violations.push({
          filePath: testFile.relativePath,
          line: info.line,
          description,
          suggestion:
            `将测试名称改为英文前缀形式：\n` +
            `  - should <期望结果> when <条件>：描述期望行为\n` +
            `  - when <条件> then <结果>：描述条件分支\n` +
            `  - it <行为描述>：描述功能点\n` +
            `示例：${info.functionName}("should return 200 when input is valid", () => { ... })`,
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
