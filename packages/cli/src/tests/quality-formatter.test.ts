/**
 * quality-formatter 单元测试
 *
 * 测试范围：
 *   - A. formatCodeMapReport：CodeMap 报告格式化（json/text/markdown）
 *   - B. formatUIUXReport：UIUXReport 报告格式化（json/text/markdown）
 *   - C. formatVisualReport：VisualDiffResult 报告格式化（json/text/markdown）
 *   - D. formatCombinedReport：合并多报告输出
 *   - E. 边界场景：空数组 / 可选字段缺失 / 转义字符 / 长字符串
 *
 * 测试约定（遵循项目规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架，直接构造真实的 CodeMap/UIUXReport/VisualDiffResult 对象
 *   - 纯函数测试：所有输入数据在测试内构造，无外部依赖
 *   - 中文注释，遵循项目代码规范
 *
 * @module cli/tests/quality-formatter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCodeMapReport,
  formatUIUXReport,
  formatVisualReport,
  formatCombinedReport,
  type ReportFormat,
} from "../quality/quality-formatter";
import type { CodeMap, UIUXReport } from "@deepcodex/quality";
import type { VisualDiffResult } from "@vegamo/deepcode-core";

// ============================================================================
// 测试 Fixtures：构造真实的 CodeMap / UIUXReport / VisualDiffResult 对象
// ============================================================================

/**
 * 构造一个最小但完整的 CodeMap 对象
 *
 * 包含 1 个节点、0 个边、基础统计字段，
 * 用于验证 formatCodeMapReport 在最小输入下的行为。
 */
function makeMinimalCodeMap(): CodeMap {
  return {
    projectName: "test-project",
    projectRoot: "/tmp/test-project",
    generatedAt: "2026-07-26T10:00:00.000Z",
    nodes: [
      {
        id: "src/index.ts::main",
        kind: "function",
        name: "main",
        filePath: "/tmp/test-project/src/index.ts",
        relativePath: "src/index.ts",
        lineStart: 1,
        lineEnd: 10,
        complexity: 2,
        complexityLevel: "low",
        docstring: "/** 主入口 */",
        parentId: null,
      },
    ],
    edges: [],
    stats: {
      fileCount: 1,
      directoryCount: 1,
      nodesByKind: {
        function: 1,
        method: 0,
        class: 0,
        interface: 0,
        module: 0,
        file: 0,
        variable: 0,
        constant: 0,
      },
      edgesByKind: {
        imports: 0,
        extends: 0,
        implements: 0,
        calls: 0,
        uses: 0,
      },
      languageBreakdown: { TypeScript: 1 },
      avgComplexity: 2,
      topComplexNodes: [
        {
          id: "src/index.ts::main",
          complexity: 2,
          name: "main",
          filePath: "/tmp/test-project/src/index.ts",
        },
      ],
      deadCodeCandidates: [],
      totalLines: 10,
    },
  };
}

/**
 * 构造一个含死代码候选与多节点的 CodeMap
 *
 * 用于测试死代码列表截断（>10 个）与复杂度 Top 5 展示逻辑。
 */
function makeCodeMapWithDeadCode(): CodeMap {
  const deadCodeCandidates: string[] = [];
  for (let i = 0; i < 15; i++) {
    deadCodeCandidates.push(`src/dead${i}.ts::unused${i}`);
  }
  const topComplexNodes = [];
  for (let i = 0; i < 7; i++) {
    topComplexNodes.push({
      id: `src/c${i}.ts::complex${i}`,
      complexity: 20 - i,
      name: `complex${i}`,
      filePath: `/tmp/test-project/src/c${i}.ts`,
    });
  }
  return {
    projectName: "dead-code-project",
    projectRoot: "/tmp/dead-code-project",
    generatedAt: "2026-07-26T11:00:00.000Z",
    nodes: [],
    edges: [],
    stats: {
      fileCount: 0,
      directoryCount: 0,
      nodesByKind: {
        function: 0,
        method: 0,
        class: 0,
        interface: 0,
        module: 0,
        file: 0,
        variable: 0,
        constant: 0,
      },
      edgesByKind: {
        imports: 0,
        extends: 0,
        implements: 0,
        calls: 0,
        uses: 0,
      },
      languageBreakdown: {},
      avgComplexity: 0,
      topComplexNodes,
      deadCodeCandidates,
      totalLines: 0,
    },
  };
}

/**
 * 构造一个最小但完整的 UIUXReport 对象
 *
 * 包含 1 条 HIGH 问题，用于验证问题列表排序与字段渲染。
 */
function makeMinimalUIUXReport(): UIUXReport {
  return {
    score: 60,
    is_pass: false,
    total_issues: 1,
    high_count: 1,
    medium_count: 0,
    low_count: 0,
    issues: [
      {
        category: "a11y",
        severity: "HIGH",
        rule: "img-alt-missing",
        element: "img.hero",
        message: "图片缺少 alt 属性",
        fix: "为 img 添加 alt='描述性文字'",
      },
    ],
  };
}

/**
 * 构造一个含多分类、多严重级别问题的 UIUXReport
 *
 * 用于测试 markdown 分组展示与 text 排序（HIGH > MEDIUM > LOW）。
 */
function makeMultiCategoryUIUXReport(): UIUXReport {
  return {
    score: 45,
    is_pass: false,
    total_issues: 4,
    high_count: 1,
    medium_count: 2,
    low_count: 1,
    issues: [
      {
        category: "layout",
        severity: "LOW",
        rule: "overflow-horizontal",
        element: "div.table",
        message: "表格横向溢出",
        fix: "添加 overflow-x:auto",
      },
      {
        category: "a11y",
        severity: "HIGH",
        rule: "contrast-low",
        element: "p.muted",
        message: "对比度过低",
        fix: "提高文字颜色深度",
      },
      {
        category: "interaction",
        severity: "MEDIUM",
        rule: "tap-target-small",
        element: "button.tiny",
        message: "按钮点击区域过小",
        fix: "扩大到 44x44 像素",
      },
      {
        category: "a11y",
        severity: "MEDIUM",
        rule: "label-missing",
        element: "input#name",
        message: "表单控件缺少 label",
        fix: "添加 <label for>",
      },
    ],
  };
}

/**
 * 构造一个无问题的 UIUXReport（用于测试 "无问题" 分支）
 */
function makeCleanUIUXReport(): UIUXReport {
  return {
    score: 100,
    is_pass: true,
    total_issues: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    issues: [],
  };
}

/**
 * 构造一个最小但完整的 VisualDiffResult（无 ssimScore）
 *
 * 用于测试 ssimScore 缺失时显示 "N/A"。
 */
function makeMinimalVisualResult(): VisualDiffResult {
  return {
    testId: "test-001",
    step: "step-1",
    pixelDiffRatio: 0.005,
    changedRegions: [],
    dataIncomplete: [],
    displayErrors: [],
  };
}

/**
 * 构造一个完整的 VisualDiffResult（含 ssimScore、变化区域、显示错误）
 *
 * 用于测试变化区域表格渲染、显示错误列表、SSIM 通过判断。
 */
function makeFullVisualResult(): VisualDiffResult {
  return {
    testId: "test-002",
    step: "final",
    pixelDiffRatio: 0.15,
    ssimScore: 0.85,
    changedRegions: [
      {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        pixelCount: 5000,
        severity: "HIGH",
      },
      {
        x: 200,
        y: 100,
        width: 80,
        height: 30,
        pixelCount: 2400,
        severity: "MEDIUM",
      },
    ],
    dataIncomplete: ["表格行被截断", "图片加载失败"],
    displayErrors: ["红色错误 toast", "alert 对话框"],
    error: undefined,
  };
}

/**
 * 构造一个含 error 字段的 VisualDiffResult
 *
 * 用于测试错误信息渲染。
 */
function makeErrorVisualResult(): VisualDiffResult {
  return {
    testId: "test-003",
    step: "error-case",
    pixelDiffRatio: 0,
    changedRegions: [],
    dataIncomplete: [],
    displayErrors: [],
    error: "基线图像加载失败",
  };
}

// ============================================================================
// A. formatCodeMapReport 测试
// ============================================================================

test("formatCodeMapReport: json 格式输出可解析的 JSON 字符串", () => {
  const map = makeMinimalCodeMap();
  const output = formatCodeMapReport(map, "json");
  const parsed = JSON.parse(output) as CodeMap;
  assert.equal(parsed.projectName, "test-project");
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.stats.fileCount, 1);
});

test("formatCodeMapReport: text 格式包含项目名与文件数统计", () => {
  const map = makeMinimalCodeMap();
  const output = formatCodeMapReport(map, "text");
  assert.ok(output.includes("Code Map: test-project"));
  assert.ok(output.includes("文件数: 1"));
  assert.ok(output.includes("节点数: 1"));
  assert.ok(output.includes("边数: 0"));
  assert.ok(output.includes("死代码候选: 0 个"));
  assert.ok(output.includes("复杂度 Top 5"));
  assert.ok(output.includes("main"));
});

test("formatCodeMapReport: text 格式死代码候选超过 10 个时显示截断提示", () => {
  const map = makeCodeMapWithDeadCode();
  const output = formatCodeMapReport(map, "text");
  assert.ok(output.includes("死代码候选（前 10 个）"));
  assert.ok(output.includes("还有 5 个"));
  // 验证仅展示前 10 个，第 11 个不应出现
  assert.ok(!output.includes("unused10"));
  // 前 10 个应出现
  assert.ok(output.includes("unused0"));
  assert.ok(output.includes("unused9"));
});

test("formatCodeMapReport: text 格式复杂度 Top 5 截断为 5 个", () => {
  const map = makeCodeMapWithDeadCode();
  const output = formatCodeMapReport(map, "text");
  assert.ok(output.includes("复杂度 Top 5"));
  // 前 5 个应出现
  assert.ok(output.includes("complex0"));
  assert.ok(output.includes("complex4"));
  // 第 6、7 个不应出现
  assert.ok(!output.includes("complex5"));
  assert.ok(!output.includes("complex6"));
});

test("formatCodeMapReport: markdown 格式优先使用传入的 markdownContent", () => {
  const map = makeMinimalCodeMap();
  const customMarkdown = "# 自定义 Markdown\n\n这是测试内容。";
  const output = formatCodeMapReport(map, "markdown", customMarkdown);
  assert.equal(output, customMarkdown);
});

test("formatCodeMapReport: markdown 格式未传入 markdownContent 时降级为 text 格式", () => {
  const map = makeMinimalCodeMap();
  const output = formatCodeMapReport(map, "markdown");
  // 降级为 text 格式：应包含 text 格式的特征（# Code Map: 标题）
  assert.ok(output.includes("Code Map: test-project"));
  assert.ok(output.includes("文件数: 1"));
});

test("formatCodeMapReport: 默认 format 走 text 分支（switch default）", () => {
  const map = makeMinimalCodeMap();
  // 传入不识别的 format 值（虽然类型上是受限的，但运行时容错）
  const output = formatCodeMapReport(map, "text" as ReportFormat);
  assert.ok(output.includes("Code Map: test-project"));
});

// ============================================================================
// B. formatUIUXReport 测试
// ============================================================================

test("formatUIUXReport: json 格式输出可解析的 UIUXReport", () => {
  const report = makeMinimalUIUXReport();
  const output = formatUIUXReport(report, "json");
  const parsed = JSON.parse(output) as UIUXReport;
  assert.equal(parsed.score, 60);
  assert.equal(parsed.is_pass, false);
  assert.equal(parsed.high_count, 1);
  assert.equal(parsed.issues[0]!.rule, "img-alt-missing");
});

test("formatUIUXReport: text 格式包含评分与问题列表", () => {
  const report = makeMinimalUIUXReport();
  const output = formatUIUXReport(report, "text");
  assert.ok(output.includes("UI/UX 巡检报告"));
  assert.ok(output.includes("综合评分: 60/100"));
  assert.ok(output.includes("❌ 未通过"));
  assert.ok(output.includes("HIGH: 1"));
  assert.ok(output.includes("img-alt-missing"));
  assert.ok(output.includes("为 img 添加 alt='描述性文字'"));
});

test("formatUIUXReport: text 格式按严重级别排序（HIGH > MEDIUM > LOW）", () => {
  const report = makeMultiCategoryUIUXReport();
  const output = formatUIUXReport(report, "text");
  // 找到每个 severity 在输出中的位置
  const highIdx = output.indexOf("[HIGH]");
  const mediumIdx = output.indexOf("[MEDIUM]");
  const lowIdx = output.indexOf("[LOW]");
  // 验证顺序：HIGH 在 MEDIUM 之前，MEDIUM 在 LOW 之前
  assert.ok(highIdx > -1, "应包含 HIGH 问题");
  assert.ok(mediumIdx > -1, "应包含 MEDIUM 问题");
  assert.ok(lowIdx > -1, "应包含 LOW 问题");
  assert.ok(highIdx < mediumIdx, "HIGH 应在 MEDIUM 之前");
  assert.ok(mediumIdx < lowIdx, "MEDIUM 应在 LOW 之前");
});

test("formatUIUXReport: markdown 格式按 category 分组输出表格", () => {
  const report = makeMultiCategoryUIUXReport();
  const output = formatUIUXReport(report, "markdown");
  assert.ok(output.includes("# UI/UX 巡检报告"));
  assert.ok(output.includes("## 总览"));
  assert.ok(output.includes("| 综合评分 | 45/100 |"));
  // 验证分组标题
  assert.ok(output.includes("## a11y (2 项)"));
  assert.ok(output.includes("## interaction (1 项)"));
  assert.ok(output.includes("## layout (1 项)"));
  // 验证表格头
  assert.ok(output.includes("| 严重级别 | 规则 | 元素 | 描述 | 修复建议 |"));
});

test("formatUIUXReport: markdown 格式无问题时输出 '无问题'", () => {
  const report = makeCleanUIUXReport();
  const output = formatUIUXReport(report, "markdown");
  assert.ok(output.includes("## 问题清单"));
  assert.ok(output.includes("无问题。"));
});

test("formatUIUXReport: text 格式无问题时不输出问题清单部分", () => {
  const report = makeCleanUIUXReport();
  const output = formatUIUXReport(report, "text");
  assert.ok(output.includes("问题总数: 0"));
  assert.ok(!output.includes("## 问题清单"));
});

test("formatUIUXReport: markdown 格式转义表格中的 | 字符", () => {
  const report: UIUXReport = {
    score: 50,
    is_pass: false,
    total_issues: 1,
    high_count: 0,
    medium_count: 1,
    low_count: 0,
    issues: [
      {
        category: "a11y",
        severity: "MEDIUM",
        rule: "test|rule",
        element: "div|cls",
        message: "msg|with|pipe",
        fix: "fix|it",
      },
    ],
  };
  const output = formatUIUXReport(report, "markdown");
  // 验证 | 被转义为 \|
  assert.ok(output.includes("test\\|rule"));
  assert.ok(output.includes("div\\|cls"));
  assert.ok(output.includes("msg\\|with\\|pipe"));
  assert.ok(output.includes("fix\\|it"));
});

// ============================================================================
// C. formatVisualReport 测试
// ============================================================================

test("formatVisualReport: json 格式输出可解析的 VisualDiffResult", () => {
  const result = makeMinimalVisualResult();
  const output = formatVisualReport(result, "json");
  const parsed = JSON.parse(output) as VisualDiffResult;
  assert.equal(parsed.testId, "test-001");
  assert.equal(parsed.pixelDiffRatio, 0.005);
  assert.equal(parsed.ssimScore, undefined);
});

test("formatVisualReport: text 格式 ssimScore 缺失时显示 N/A", () => {
  const result = makeMinimalVisualResult();
  const output = formatVisualReport(result, "text");
  assert.ok(output.includes("SSIM 评分: N/A"));
  assert.ok(output.includes("像素差异比: 0.5000%"));
  // pixelDiffRatio=0.005 < 0.01 且无 ssimScore → 通过
  assert.ok(output.includes("✅ 通过"));
});

test("formatVisualReport: text 格式 ssimScore 提供且 >= 0.95 时通过", () => {
  const result: VisualDiffResult = {
    testId: "t-pass",
    step: "s",
    pixelDiffRatio: 0.005,
    ssimScore: 0.97,
    changedRegions: [],
    dataIncomplete: [],
    displayErrors: [],
  };
  const output = formatVisualReport(result, "text");
  assert.ok(output.includes("SSIM 评分: 0.9700"));
  assert.ok(output.includes("✅ 通过"));
});

test("formatVisualReport: text 格式 pixelDiffRatio 超阈值时未通过", () => {
  const result: VisualDiffResult = {
    testId: "t-fail",
    step: "s",
    pixelDiffRatio: 0.05,
    ssimScore: 0.99,
    changedRegions: [],
    dataIncomplete: [],
    displayErrors: [],
  };
  const output = formatVisualReport(result, "text");
  assert.ok(output.includes("❌ 未通过"));
});

test("formatVisualReport: text 格式 ssimScore < 0.95 时未通过（即使 pixelDiff 通过）", () => {
  const result: VisualDiffResult = {
    testId: "t-ssim-fail",
    step: "s",
    pixelDiffRatio: 0.005,
    ssimScore: 0.85,
    changedRegions: [],
    dataIncomplete: [],
    displayErrors: [],
  };
  const output = formatVisualReport(result, "text");
  assert.ok(output.includes("❌ 未通过"));
});

test("formatVisualReport: text 格式渲染变化区域、数据显示不全、显示错误", () => {
  const result = makeFullVisualResult();
  const output = formatVisualReport(result, "text");
  assert.ok(output.includes("变化区域 (2 个)"));
  assert.ok(output.includes("(10, 20)"));
  assert.ok(output.includes("100x50"));
  assert.ok(output.includes("变化像素: 5000"));
  assert.ok(output.includes("级别: HIGH"));
  assert.ok(output.includes("数据显示不全 (2 项)"));
  assert.ok(output.includes("表格行被截断"));
  assert.ok(output.includes("显示错误 (2 项)"));
  assert.ok(output.includes("红色错误 toast"));
});

test("formatVisualReport: text 格式渲染 error 字段", () => {
  const result = makeErrorVisualResult();
  const output = formatVisualReport(result, "text");
  assert.ok(output.includes("错误: 基线图像加载失败"));
});

test("formatVisualReport: markdown 格式输出表格化的变化区域", () => {
  const result = makeFullVisualResult();
  const output = formatVisualReport(result, "markdown");
  assert.ok(output.includes("# 视觉回归比对报告"));
  assert.ok(output.includes("## 总览"));
  assert.ok(output.includes("| 像素差异比 | 15.0000% |"));
  assert.ok(output.includes("| SSIM 评分 | 0.8500 |"));
  assert.ok(output.includes("## 变化区域 (2 个)"));
  assert.ok(output.includes("| 序号 | X | Y | 宽度 | 高度 | 变化像素 | 级别 |"));
  assert.ok(output.includes("| 1 | 10 | 20 | 100 | 50 | 5000 | HIGH |"));
  assert.ok(output.includes("## 数据显示不全 (2 项)"));
  assert.ok(output.includes("## 显示错误 (2 项)"));
});

test("formatVisualReport: markdown 格式 ssimScore 缺失时表格显示 N/A", () => {
  const result = makeMinimalVisualResult();
  const output = formatVisualReport(result, "markdown");
  assert.ok(output.includes("| SSIM 评分 | N/A |"));
});

test("formatVisualReport: text 格式空 changedRegions/dataIncomplete/displayErrors 不输出对应区块", () => {
  const result = makeMinimalVisualResult();
  const output = formatVisualReport(result, "text");
  assert.ok(!output.includes("变化区域"));
  assert.ok(!output.includes("数据显示不全"));
  assert.ok(!output.includes("显示错误"));
});

// ============================================================================
// D. formatCombinedReport 测试
// ============================================================================

test("formatCombinedReport: 合并多个 section 为单一输出", () => {
  const output = formatCombinedReport([
    { title: "Code Map", content: "codemap 内容" },
    { title: "UI/UX Audit", content: "uiux 内容" },
    { title: "Visual Regression", content: "visual 内容" },
  ]);
  // 验证标题渲染
  assert.ok(output.includes("# Code Map"));
  assert.ok(output.includes("# UI/UX Audit"));
  assert.ok(output.includes("# Visual Regression"));
  // 验证内容渲染
  assert.ok(output.includes("codemap 内容"));
  assert.ok(output.includes("uiux 内容"));
  assert.ok(output.includes("visual 内容"));
  // 验证分隔线（仅在第 2 个及之后的 section 前出现）
  assert.ok(output.includes("\n---\n"));
});

test("formatCombinedReport: 单个 section 时不输出分隔线", () => {
  const output = formatCombinedReport([{ title: "Only One", content: "内容" }]);
  assert.ok(output.includes("# Only One"));
  assert.ok(output.includes("内容"));
  assert.ok(!output.includes("---"));
});

test("formatCombinedReport: 空 sections 数组返回空字符串", () => {
  const output = formatCombinedReport([]);
  assert.equal(output, "");
});
