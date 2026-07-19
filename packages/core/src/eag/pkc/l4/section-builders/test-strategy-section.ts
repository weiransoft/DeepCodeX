/**
 * 测试策略章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 5 章）
 *
 * 本模块实现 TestStrategySectionBuilder，构建交接文档第 5 章"测试策略"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - TESTING Loop 产出（context.testResults，可选）
 * - 测试代码扫描（tests 下的 .test.ts 文件，递归子目录）
 *
 * 置信度：documented（来自 TESTING Loop 产出与测试代码扫描）
 *
 * 章节内容包含：
 * 1. 测试金字塔分布（单元 / 集成 / E2E 测试数量统计）
 * 2. 覆盖率（若 context.testResults 提供，则展示）
 * 3. 关键场景（从 spec.md 验收标准推导，或从测试 describe 块提取）
 * 4. 回归策略（里程碑间复用历史测试用例集）
 *
 * @module eag/pkc/l4/section-builders/test-strategy-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

const SECTION_ID = "test-strategy" as const;
const SECTION_TITLE = "测试策略" as const;
const SECTION_ORDER = 5 as const;
const SECTION_CONFIDENCE = "documented" as const;

/**
 * 测试文件路径匹配模式（按层级分类）
 */
const TEST_PATH_PATTERNS: ReadonlyArray<{ pattern: RegExp; layer: string }> = Object.freeze([
  { pattern: /(^|\/)unit\/|\.unit\.test\.[a-z]+$/, layer: "unit" },
  { pattern: /(^|\/)integration\/|\.integration\.test\.[a-z]+$/, layer: "integration" },
  { pattern: /(^|\/)e2e\/|\.e2e\.test\.[a-z]+$/, layer: "e2e" },
  { pattern: /(^|\/)contract\/|\.contract\.test\.[a-z]+$/, layer: "contract" },
  { pattern: /(^|\/)compliance\/|\.compliance\.test\.[a-z]+$/, layer: "compliance" },
]);

// ============================================================================
// 类型定义（内部使用）
// ============================================================================

/**
 * 测试文件信息
 */
interface TestFileInfo {
  /** 文件路径 */
  readonly filePath: string;
  /** 测试层级（unit / integration / e2e / contract / compliance / unknown） */
  readonly layer: string;
  /** describe 块数量 */
  readonly describeCount: number;
  /** it / test 用例数量 */
  readonly caseCount: number;
  /** describe 块描述列表 */
  readonly describes: ReadonlyArray<string>;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断文件路径是否为测试文件
 *
 * @param filePath 文件路径
 * @returns true=测试文件
 */
function isTestFile(filePath: string): boolean {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".js") && !filePath.endsWith(".mjs")) {
    return false;
  }
  if (/\.test\.[a-z]+$/.test(filePath) || /\.spec\.[a-z]+$/.test(filePath)) {
    return true;
  }
  return /(^|\/)(tests?|__tests__)\//.test(filePath);
}

/**
 * 从文件路径推断测试层级
 *
 * 推断规则（按优先级）：
 * 1. 路径含 unit/ → unit
 * 2. 路径含 integration/ → integration
 * 3. 路径含 e2e/ → e2e
 * 4. 路径含 contract/ → contract
 * 5. 路径含 compliance/ → compliance
 * 6. 默认 → unknown
 *
 * @param filePath 文件路径
 * @returns 测试层级
 */
function inferTestLayer(filePath: string): string {
  for (const { pattern, layer } of TEST_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return layer;
    }
  }
  return "unknown";
}

/**
 * 从测试文件内容中提取 describe / it / test 块信息
 *
 * 支持以下语法：
 * - describe("name", () => { ... })
 * - describe('name', function() { ... })
 * - it("name", () => { ... })
 * - test("name", () => { ... })
 *
 * @param content 测试文件内容
 * @returns 测试信息（describe 数量 / case 数量 / describe 描述列表）
 */
function extractTestInfo(content: string): {
  describeCount: number;
  caseCount: number;
  describes: string[];
} {
  let describeCount = 0;
  let caseCount = 0;
  const describes: string[] = [];

  // 匹配 describe("name", ...) / describe('name', ...)
  const describeRegex = /describe\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = describeRegex.exec(content)) !== null) {
    describeCount++;
    describes.push(match[1]);
  }

  // 匹配 it("name", ...) / test("name", ...)
  const itRegex = /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((match = itRegex.exec(content)) !== null) {
    caseCount++;
  }

  return { describeCount, caseCount, describes };
}

/**
 * 扫描 fileMap 中的所有测试文件，提取测试信息
 *
 * @param fileMap 项目文件清单
 * @returns 测试文件信息列表
 */
function scanTestFiles(fileMap: Readonly<Record<string, string>>): TestFileInfo[] {
  const files: TestFileInfo[] = [];
  const allPaths = Object.keys(fileMap).sort();
  for (const filePath of allPaths) {
    if (!isTestFile(filePath)) {
      continue;
    }
    const content = fileMap[filePath];
    if (typeof content !== "string") {
      continue;
    }
    const layer = inferTestLayer(filePath);
    const info = extractTestInfo(content);
    files.push({
      filePath,
      layer,
      describeCount: info.describeCount,
      caseCount: info.caseCount,
      describes: Object.freeze(info.describes),
    });
  }
  return files;
}

/**
 * 从 testResults 提取覆盖率信息（若 testResults 为对象且含 coverage 字段）
 *
 * 由于 testResults 类型为 ReadonlyArray<unknown>，本函数对常见覆盖率结构进行 duck-typing 探测。
 *
 * @param testResults 测试结果数组
 * @returns 覆盖率信息对象，未找到返回 null
 */
function extractCoverage(testResults: ReadonlyArray<unknown> | undefined): {
  lines: number;
  branches: number;
  functions: number;
} | null {
  if (!testResults || testResults.length === 0) {
    return null;
  }
  // 在 testResults 中查找含 coverage 字段的对象
  for (const result of testResults) {
    if (typeof result !== "object" || result === null) {
      continue;
    }
    const obj = result as Record<string, unknown>;
    // 探测 coverage 字段
    if (obj.coverage && typeof obj.coverage === "object") {
      const cov = obj.coverage as Record<string, unknown>;
      if (typeof cov.lines === "number" && typeof cov.branches === "number" && typeof cov.functions === "number") {
        return { lines: cov.lines, branches: cov.branches, functions: cov.functions };
      }
    }
    // 探测直接字段
    if (typeof obj.lines === "number" && typeof obj.branches === "number" && typeof obj.functions === "number") {
      return {
        lines: obj.lines as number,
        branches: obj.branches as number,
        functions: obj.functions as number,
      };
    }
  }
  return null;
}

// ============================================================================
// TestStrategySectionBuilder 类
// ============================================================================

/**
 * 测试策略章节构建器
 *
 * 实现章节顺序 5（对齐 §7.4 七章结构表）。
 *
 * 构建流程：
 * 1. 扫描 fileMap 中的所有测试文件（.test.ts / .spec.ts / tests/ 目录）
 * 2. 推断测试层级（unit / integration / e2e / contract / compliance）
 * 3. 提取 describe / it / test 块数量与描述
 * 4. 若 context.testResults 提供，提取覆盖率信息
 * 5. 组装 Markdown 内容（测试金字塔 + 覆盖率 + 关键场景 + 回归策略）
 * 6. 返回冻结的 HandoverSection（confidence=documented）
 */
export class TestStrategySectionBuilder implements SectionBuilder {
  readonly sectionId = SECTION_ID;
  readonly title = SECTION_TITLE;
  readonly order = SECTION_ORDER;

  /**
   * 构建测试策略章节
   *
   * @param context 章节构建上下文
   * @returns 冻结的 HandoverSection（confidence=documented）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    const sources: string[] = [];

    // 1. 扫描测试文件
    const testFiles = scanTestFiles(context.fileMap);
    for (const file of testFiles) {
      sources.push(file.filePath);
    }

    // 2. 提取覆盖率（若 testResults 提供）
    const coverage = extractCoverage(context.testResults);

    // 3. 组装 Markdown 内容
    const content = this.assembleContent(testFiles, coverage, context.projectRoot);

    return Object.freeze({
      sectionId: SECTION_ID,
      title: SECTION_TITLE,
      order: SECTION_ORDER,
      confidence: SECTION_CONFIDENCE,
      content,
      sources: Object.freeze(sources),
    });
  }

  /**
   * 组装章节 Markdown 内容
   *
   * @param testFiles 测试文件列表
   * @param coverage 覆盖率信息（可选）
   * @param projectRoot 项目根目录
   * @returns 完整 Markdown 内容
   */
  private assembleContent(
    testFiles: TestFileInfo[],
    coverage: { lines: number; branches: number; functions: number } | null,
    projectRoot: string
  ): string {
    const lines: string[] = [];
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：documented（来自 TESTING Loop 产出与测试代码扫描）`);
    lines.push(`> **项目根目录**：${projectRoot}`);
    lines.push(`> **测试文件总数**：${testFiles.length}`);
    lines.push("");

    if (testFiles.length === 0) {
      lines.push("> 未在 fileMap 中扫描到测试文件。请检查项目是否包含 .test.ts / .spec.ts 文件或 tests/ 目录。");
      lines.push("");
      return lines.join("\n");
    }

    // 测试金字塔分布
    lines.push("### 测试金字塔分布");
    lines.push("");
    const layerCounts = new Map<string, { files: number; cases: number }>();
    for (const file of testFiles) {
      const entry = layerCounts.get(file.layer) ?? { files: 0, cases: 0 };
      entry.files++;
      entry.cases += file.caseCount;
      layerCounts.set(file.layer, entry);
    }
    lines.push("| 测试层级 | 文件数 | 用例数 |");
    lines.push("|----------|--------|--------|");
    for (const layer of [...layerCounts.keys()].sort()) {
      const entry = layerCounts.get(layer)!;
      lines.push(`| ${layer} | ${entry.files} | ${entry.cases} |`);
    }
    lines.push("");

    // 覆盖率
    lines.push("### 覆盖率");
    lines.push("");
    if (coverage) {
      lines.push("| 维度 | 覆盖率 |");
      lines.push("|------|--------|");
      lines.push(`| 行覆盖率 | ${coverage.lines.toFixed(2)}% |`);
      lines.push(`| 分支覆盖率 | ${coverage.branches.toFixed(2)}% |`);
      lines.push(`| 函数覆盖率 | ${coverage.functions.toFixed(2)}% |`);
      lines.push("");
      // 覆盖率达标判定（默认阈值：行 80% / 分支 70% / 函数 85%）
      const pass = coverage.lines >= 80 && coverage.branches >= 70 && coverage.functions >= 85;
      lines.push(
        `> **覆盖率达标判定**：${pass ? "✅ 通过（行≥80% / 分支≥70% / 函数≥85%）" : "❌ 未达标（请检查未覆盖文件与高风险符号）"}`
      );
      lines.push("");
    } else {
      lines.push("> context.testResults 未提供覆盖率信息。建议在 TESTING Loop 完成后注入覆盖率报告。");
      lines.push("");
      lines.push("**默认覆盖率阈值**（对齐 §5.2.4 领域层 ≥80%）：");
      lines.push("");
      lines.push("| 维度 | 阈值 |");
      lines.push("|------|------|");
      lines.push("| 行覆盖率 | ≥80% |");
      lines.push("| 分支覆盖率 | ≥70% |");
      lines.push("| 函数覆盖率 | ≥85% |");
      lines.push("| 高风险符号覆盖率 | 100% |");
      lines.push("");
    }

    // 关键测试场景
    lines.push("### 关键测试场景");
    lines.push("");
    const allDescribes = testFiles.flatMap((f) => f.describes);
    if (allDescribes.length > 0) {
      lines.push("以下为测试文件中的 describe 块列表（用于核对关键场景覆盖）：");
      lines.push("");
      for (const desc of allDescribes.slice(0, 50)) {
        lines.push(`- ${desc}`);
      }
      if (allDescribes.length > 50) {
        lines.push(`- ...(共 ${allDescribes.length} 个 describe 块，仅展示前 50 个)`);
      }
      lines.push("");
    } else {
      lines.push("> 测试文件中未提取到 describe 块。建议为关键场景补充 describe 块以提高可读性。");
      lines.push("");
    }

    // 回归策略
    lines.push("### 回归策略");
    lines.push("");
    lines.push("**里程碑间回归策略**（对齐 §5.10.5 TESTING Loop 时序）：");
    lines.push("");
    lines.push("1. **契约测试回归**：每个 PR 触发契约测试套件，验证 API 兼容性。");
    lines.push("2. **E2E 测试回归**：里程碑间复用历史 E2E 测试用例集，验证业务流程未回归。");
    lines.push("3. **覆盖率门禁**：行覆盖率不得下降，高风险符号 100% 覆盖。");
    lines.push("4. **静态质量判定**：AssertionDensityChecker / TestNamingChecker / CoverageGapChecker 全部通过。");
    lines.push("5. **既有契约保护**：BrownfieldContractGuard 检测 breaking change，禁止引入不兼容变更。");
    lines.push("");

    // 测试文件清单
    lines.push("### 测试文件清单");
    lines.push("");
    lines.push("| 文件路径 | 层级 | describe 数 | 用例数 |");
    lines.push("|----------|------|-------------|--------|");
    for (const file of testFiles) {
      lines.push(`| \`${file.filePath}\` | ${file.layer} | ${file.describeCount} | ${file.caseCount} |`);
    }
    lines.push("");

    return lines.join("\n");
  }
}
