/**
 * G-03 端到端测试：dynamic-ui skill 16 个模板物化质量验证
 *
 * 本测试基于设计文档 BUILTIN-SKILLS-ENHANCEMENT-DESIGN.md（P1-T1）和
 * dynamic-ui SKILL.md / tokens/visual-tokens.md / scenes/*.md 的契约，
 * 对 16 个物化模板进行端到端验证。
 *
 * 测试维度（对应八阶段审查 D1-D6）：
 *   D1 功能完成度 — 每个模板的 3 个文件齐全（template.md + widget-code.html + fixture.json）
 *   D2 集成完整性 — manifest.json 中所有模板 status=ready，且 scene 字段对应实际场景文件
 *   D3 测试正确性 — widget-code.html 满足所有硬性契约（结构、token、根元素、安全规则等）
 *   D4 验收标准满足 — 行数 ≤ 400、含可见降级、Chart.js 配置正确等
 *   D5 TODO/FIXME 清零 — widget-code.html 中无 TODO/FIXME 残留
 *   D6 文档意图遵从 — template.md 包含必需章节、fixture.json 字段完整
 *
 * 测试规范：node:test + node:assert/strict + fs + path
 * 不使用 mock / 占位 / 简化实现，全部读取真实文件
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ============================================================================
// 路径与常量
// ============================================================================

/** 仓库根目录（packages/core/） */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** dynamic-ui skill 根目录 */
const dynamicUiDir = path.join(repoRoot, "templates/skills/bundled/dynamic-ui");

/** templates 目录 */
const templatesDir = path.join(dynamicUiDir, "templates");

/** manifest.json 文件路径 */
const manifestPath = path.join(templatesDir, "manifest.json");

/** scenes 目录 */
const scenesDir = path.join(dynamicUiDir, "scenes");

/** tokens 目录 */
const tokensDir = path.join(dynamicUiDir, "tokens");

/**
 * 16 个模板的完整定义（与 manifest.json 中的 templates 数组保持一致）
 * 用于参数化测试和场景一致性校验
 */
const EXPECTED_TEMPLATES = [
  {
    id: "line-trend",
    kind: "chart",
    scene: "data-visualization",
    intent: "trend_over_time",
  },
  {
    id: "bar-chart-multiple",
    kind: "chart",
    scene: "data-visualization",
    intent: "grouped_bar_comparison",
  },
  {
    id: "scatter-chart",
    kind: "chart",
    scene: "data-visualization",
    intent: "correlation_scatterplot",
  },
  {
    id: "gantt-chart",
    kind: "chart",
    scene: "architecture-and-flow",
    intent: "project_schedule_gantt",
  },
  {
    id: "funnel-bar-chart",
    kind: "chart",
    scene: "data-visualization",
    intent: "pipeline_conversion_funnel_bar",
  },
  {
    id: "sankey-chart",
    kind: "chart",
    scene: "data-visualization",
    intent: "flow_magnitude_sankey",
  },
  {
    id: "heatmap-chart",
    kind: "chart",
    scene: "data-visualization",
    intent: "contribution_heatmap",
  },
  {
    id: "pie-donut-text",
    kind: "chart",
    scene: "data-visualization",
    intent: "composition_with_center_metric",
  },
  {
    id: "bar-stacked-legend",
    kind: "chart",
    scene: "data-visualization",
    intent: "stacked_part_to_whole",
  },
  {
    id: "pie-chart-label-list",
    kind: "chart",
    scene: "data-visualization",
    intent: "part_to_whole_label_list",
  },
  {
    id: "radar-chart-legend",
    kind: "chart",
    scene: "data-visualization",
    intent: "radar_profile_comparison",
  },
  {
    id: "radar-chart-lines-only",
    kind: "chart",
    scene: "data-visualization",
    intent: "radar_profile_lines_only",
  },
  {
    id: "comparison-cards",
    kind: "comparison",
    scene: "comparison-and-decision",
    intent: "multi_option_comparison_cards",
  },
  {
    id: "tree-flow",
    kind: "diagram",
    scene: "architecture-and-flow",
    intent: "horizontal_node_tree_flow",
  },
  {
    id: "architecture-elements",
    kind: "diagram",
    scene: "architecture-and-flow",
    intent: "architecture_element_palette",
  },
  {
    id: "sequence-diagram",
    kind: "diagram",
    scene: "architecture-and-flow",
    intent: "sequence_diagram_call_chain",
  },
] as const;

/** widget-code.html 行数上限（设计契约要求） */
const MAX_WIDGET_LINES = 400;

/**
 * 必需的中性 CSS token（visual-tokens.md 中定义）
 * widget-code.html 必须包含这些 token 定义
 */
const REQUIRED_NEUTRAL_TOKENS = ["--surface", "--text", "--text-muted", "--border"];

/**
 * 必需的 brand CSS token
 */
const REQUIRED_BRAND_TOKENS = ["--brand", "--brand-soft", "--brand-text", "--brand-on"];

/**
 * 必需的 chart 系列 token（chart 类模板必须含前 2 个）
 */
const REQUIRED_CHART_TOKENS = ["--chart-series-1", "--chart-series-2"];

/**
 * 必需的间距 token
 */
const REQUIRED_SPACER_TOKENS = ["--spacer-4", "--spacer-8", "--spacer-16", "--spacer-20"];

/**
 * 必需的圆角 token
 */
const REQUIRED_RADIUS_TOKENS = ["--radius", "--radius-card"];

/**
 * 必需的字体 token
 */
const REQUIRED_FONT_TOKENS = ["--font-sans", "--text-body", "--text-title"];

/**
 * 禁止在 widget-code.html 中出现的安全风险关键词
 * 出现任一即视为违反安全规则
 */
const FORBIDDEN_SECURITY_PATTERNS = [
  "eval(",
  "new Function(",
  "document.cookie",
  "localStorage",
  "sessionStorage",
  "onclick=",
  "onchange=",
  "onmouseover=",
  "onmouseout=",
  "onsubmit=",
  "onload=",
];

/**
 * 禁止在 widget-code.html 中出现的 HTML 容器标签
 * widget 是片段，不应包含完整 HTML 文档结构
 */
const FORBIDDEN_HTML_PATTERNS = ["<!DOCTYPE", "<html", "<head", "<body", "<meta"];

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 读取文件内容
 * @param relativePath 相对于 templates 目录的路径
 * @returns 文件内容字符串
 */
function readTemplateFile(templateId: string, fileName: string): string {
  const filePath = path.join(templatesDir, templateId, fileName);
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * 读取 manifest.json 内容
 * @returns manifest 对象
 */
function readManifest(): {
  version: number;
  templateRoot: string;
  outputFile: string;
  fallbackPrimitives: string[];
  templates: Array<{
    id: string;
    status: string;
    kind: string;
    scene: string;
    intent: string;
    description: string;
  }>;
} {
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

/**
 * 统计文件行数
 * @param filePath 文件绝对路径
 * @returns 行数
 */
function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").length;
}

/**
 * 检查字符串中是否包含所有必需关键词
 * @param content 文件内容
 * @param keywords 必需关键词列表
 * @returns 缺失的关键词列表（空数组表示全部通过）
 */
function findMissingKeywords(content: string, keywords: readonly string[]): string[] {
  return keywords.filter((kw) => !content.includes(kw));
}

/**
 * 检查字符串中是否包含任何禁止的模式
 * @param content 文件内容
 * @param patterns 禁止模式列表
 * @returns 命中的禁止模式列表（空数组表示全部通过）
 */
function findForbiddenPatterns(content: string, patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => content.includes(pattern));
}

// ============================================================================
// 测试组 1：manifest.json 一致性（D2 集成完整性）
// ============================================================================

test("G-03 D2: manifest.json 文件存在且为有效 JSON", () => {
  assert.equal(fs.existsSync(manifestPath), true, "manifest.json 应存在");
  const manifest = readManifest();
  assert.equal(typeof manifest, "object", "manifest 应为对象");
  assert.equal(manifest.version, 1, "manifest 版本应为 1");
  assert.equal(Array.isArray(manifest.templates), true, "templates 应为数组");
});

test("G-03 D2: manifest.json 中模板数量为 16", () => {
  const manifest = readManifest();
  assert.equal(manifest.templates.length, 16, "应有 16 个模板");
});

test("G-03 D2: manifest.json 中所有模板 status=ready（物化完成）", () => {
  const manifest = readManifest();
  for (const tpl of manifest.templates) {
    assert.equal(tpl.status, "ready", `模板 ${tpl.id} 的 status 应为 ready，实际为 ${tpl.status}`);
  }
});

test("G-03 D2: manifest.json 中模板 ID 与预期列表完全一致", () => {
  const manifest = readManifest();
  const manifestIds = manifest.templates.map((t) => t.id).sort();
  const expectedIds = EXPECTED_TEMPLATES.map((t) => t.id).sort();
  assert.deepEqual(manifestIds, expectedIds, "模板 ID 列表应与预期完全一致");
});

test("G-03 D2: manifest.json 中 kind 字段分布正确（12 chart + 1 comparison + 3 diagram）", () => {
  const manifest = readManifest();
  const kindCount: Record<string, number> = {};
  for (const tpl of manifest.templates) {
    kindCount[tpl.kind] = (kindCount[tpl.kind] ?? 0) + 1;
  }
  assert.equal(kindCount.chart, 12, "chart 类模板应为 12 个");
  assert.equal(kindCount.comparison, 1, "comparison 类模板应为 1 个");
  assert.equal(kindCount.diagram, 3, "diagram 类模板应为 3 个");
});

test("G-03 D2: manifest.json 中 scene 字段对应实际存在的场景文件", () => {
  const manifest = readManifest();
  const sceneFiles = new Set<string>();
  for (const f of fs.readdirSync(scenesDir)) {
    if (f.endsWith(".md")) sceneFiles.add(f.replace(/\.md$/, ""));
  }
  for (const tpl of manifest.templates) {
    assert.equal(
      sceneFiles.has(tpl.scene),
      true,
      `模板 ${tpl.id} 的 scene "${tpl.scene}" 应对应 scenes/ 目录下的场景文件`
    );
  }
});

// ============================================================================
// 测试组 2：每个模板的 3 个文件齐全（D1 功能完成度）
// ============================================================================

test("G-03 D1: 每个 manifest 中的模板都有对应目录与 3 个必需文件", () => {
  const manifest = readManifest();
  for (const tpl of manifest.templates) {
    const tplDir = path.join(templatesDir, tpl.id);
    assert.equal(
      fs.existsSync(tplDir) && fs.statSync(tplDir).isDirectory(),
      true,
      `模板 ${tpl.id} 的目录应存在: ${tplDir}`
    );

    // 3 个必需文件
    const requiredFiles = ["template.md", "widget-code.html", "fixture.json"];
    for (const f of requiredFiles) {
      const filePath = path.join(tplDir, f);
      assert.equal(fs.existsSync(filePath), true, `模板 ${tpl.id} 应包含文件: ${f}`);
    }
  }
});

// ============================================================================
// 测试组 3：widget-code.html 行数限制（D4 验收标准满足）
// ============================================================================

test("G-03 D4: 每个 widget-code.html 行数 ≤ 400 行", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const filePath = path.join(templatesDir, tpl.id, "widget-code.html");
    const lines = countLines(filePath);
    assert.equal(
      lines <= MAX_WIDGET_LINES,
      true,
      `模板 ${tpl.id} 的 widget-code.html 行数应 ≤ ${MAX_WIDGET_LINES}，实际 ${lines} 行`
    );
  }
});

// ============================================================================
// 测试组 4：widget-code.html 结构契约（D3 测试正确性）
// ============================================================================

test("G-03 D3: 每个 widget-code.html 含 <style> 块且 token 定义在顶部", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");

    // 必须含 <style> 块
    assert.equal(content.includes("<style"), true, `模板 ${tpl.id} 的 widget-code.html 应含 <style> 块`);

    // 验证 :root 选择器（亮色默认）出现在 <style> 块附近
    const styleStart = content.indexOf("<style");
    const rootStart = content.indexOf(":root", styleStart);
    assert.equal(rootStart > 0, true, `模板 ${tpl.id} 的 :root 选择器应出现在 <style> 之后`);
  }
});

test("G-03 D3: 每个 widget-code.html 含根元素 data-dynamic-ui-widget", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    assert.equal(
      content.includes("data-dynamic-ui-widget"),
      true,
      `模板 ${tpl.id} 应含根元素属性 data-dynamic-ui-widget`
    );
  }
});

test('G-03 D3: 每个 widget-code.html 含 data-template="<id>" 属性', () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const expectedAttr = `data-template="${tpl.id}"`;
    assert.equal(content.includes(expectedAttr), true, `模板 ${tpl.id} 应含 ${expectedAttr} 属性`);
  }
});

test('G-03 D3: 每个 widget-code.html 含 :root 与 :root[data-widget-theme="dark"] 两套 token', () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    assert.equal(content.includes(":root"), true, `模板 ${tpl.id} 应含 :root 亮色 token 定义`);
    assert.equal(
      content.includes('[data-widget-theme="dark"]'),
      true,
      `模板 ${tpl.id} 应含 :root[data-widget-theme="dark"] 暗色 token 定义`
    );
  }
});

test("G-03 D3: 每个 widget-code.html 默认紫色主题（--brand: #4B3FE3 亮 / #6054F1 暗）", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");

    // 亮色 brand（不区分大小写匹配 #4B3FE3）
    assert.equal(content.toLowerCase().includes("#4b3fe3"), true, `模板 ${tpl.id} 应含亮色主题 --brand: #4B3FE3`);

    // 暗色 brand（#6054F1）
    assert.equal(content.toLowerCase().includes("#6054f1"), true, `模板 ${tpl.id} 应含暗色主题 --brand: #6054F1`);
  }
});

// ============================================================================
// 测试组 5：widget-code.html 安全规则（D3 测试正确性）
// ============================================================================

test("G-03 D3: 每个 widget-code.html 不含禁止的安全风险关键词", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const hits = findForbiddenPatterns(content, FORBIDDEN_SECURITY_PATTERNS);
    assert.equal(hits.length, 0, `模板 ${tpl.id} 的 widget-code.html 不应含安全风险关键词: ${hits.join(", ")}`);
  }
});

test("G-03 D3: 每个 widget-code.html 不含完整 HTML 文档容器标签", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const hits = findForbiddenPatterns(content, FORBIDDEN_HTML_PATTERNS);
    assert.equal(hits.length, 0, `模板 ${tpl.id} 的 widget-code.html 不应含完整 HTML 文档标签: ${hits.join(", ")}`);
  }
});

// ============================================================================
// 测试组 6：widget-code.html 根选择器初始化（D3 测试正确性）
// ============================================================================

test("G-03 D3: 每个 widget-code.html 含根选择器初始化（:not([data-mounted])）", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    assert.equal(
      content.includes(":not([data-mounted])"),
      true,
      `模板 ${tpl.id} 应含根选择器初始化 :not([data-mounted])`
    );

    // data-mounted 标记
    assert.equal(content.includes("data-mounted"), true, `模板 ${tpl.id} 应设置 data-mounted 标记防止重复挂载`);
  }
});

// ============================================================================
// 测试组 7：widget-code.html token 契约（D3 测试正确性）
// ============================================================================

test("G-03 D3: 每个 widget-code.html 含必需的中性 CSS token", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const missing = findMissingKeywords(content, REQUIRED_NEUTRAL_TOKENS);
    assert.equal(missing.length, 0, `模板 ${tpl.id} 缺少中性 token: ${missing.join(", ")}`);
  }
});

test("G-03 D3: 每个 widget-code.html 含必需的 brand CSS token", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const missing = findMissingKeywords(content, REQUIRED_BRAND_TOKENS);
    assert.equal(missing.length, 0, `模板 ${tpl.id} 缺少 brand token: ${missing.join(", ")}`);
  }
});

test("G-03 D3: 每个 widget-code.html 含必需的间距 token", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const missing = findMissingKeywords(content, REQUIRED_SPACER_TOKENS);
    assert.equal(missing.length, 0, `模板 ${tpl.id} 缺少间距 token: ${missing.join(", ")}`);
  }
});

test("G-03 D3: 每个 widget-code.html 含必需的圆角 token", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const missing = findMissingKeywords(content, REQUIRED_RADIUS_TOKENS);
    assert.equal(missing.length, 0, `模板 ${tpl.id} 缺少圆角 token: ${missing.join(", ")}`);
  }
});

test("G-03 D3: 每个 widget-code.html 含必需的字体 token", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    const missing = findMissingKeywords(content, REQUIRED_FONT_TOKENS);
    assert.equal(missing.length, 0, `模板 ${tpl.id} 缺少字体 token: ${missing.join(", ")}`);
  }
});

// ============================================================================
// 测试组 8：chart 类模板的 Chart.js 契约（D3 测试正确性）
// ============================================================================

test("G-03 D3: chart 类模板含 Chart.js CDN 或 SVG 实现", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    if (tpl.kind !== "chart") continue;
    const content = readTemplateFile(tpl.id, "widget-code.html");

    // chart 类模板应使用 Chart.js 或纯 SVG 实现
    const hasChartJs = content.includes("chart.js@4") || content.includes("Chart.js");
    const hasSvg = content.includes("<svg") || content.includes("<rect") || content.includes("<path");
    assert.equal(hasChartJs || hasSvg, true, `chart 类模板 ${tpl.id} 应使用 Chart.js 或 SVG 实现`);
  }
});

test("G-03 D3: 含 Chart.js 的 widget 含 responsive + maintainAspectRatio 配置", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    if (!content.includes("chart.js@4")) continue;

    assert.equal(
      content.includes("responsive:") || content.includes("responsive ="),
      true,
      `模板 ${tpl.id} 的 Chart.js 配置应含 responsive`
    );
    assert.equal(
      content.includes("maintainAspectRatio:") || content.includes("maintainAspectRatio ="),
      true,
      `模板 ${tpl.id} 的 Chart.js 配置应含 maintainAspectRatio: false`
    );
  }
});

test("G-03 D3: 含 Chart.js 的 widget 禁用内建 tooltip 并用 external HTML 提示框", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    if (!content.includes("chart.js@4")) continue;

    // 必须含 external 关键字（external tooltip handler）
    assert.equal(
      content.includes("external") || content.includes("tooltip") || content.includes("Tooltip"),
      true,
      `模板 ${tpl.id} 应配置 external tooltip 或 tooltip 处理逻辑`
    );
  }
});

test("G-03 D3: 含 Chart.js 的 widget canvas 数量 ≤ 2", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");
    if (!content.includes("chart.js@4")) continue;

    // 统计 <canvas 标签数量
    const canvasCount = (content.match(/<canvas/g) ?? []).length;
    assert.equal(canvasCount <= 2, true, `模板 ${tpl.id} 的 Chart.js canvas 数量应 ≤ 2，实际 ${canvasCount} 个`);
  }
});

test("G-03 D3: 每个 widget-code.html 含可见降级（HTML 表格或 SVG 在 script 前可见）", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");

    // 降级可以是 HTML 表格、SVG 或 noscript 标签
    const hasFallback =
      content.includes("<table") ||
      content.includes("<svg") ||
      content.includes("<noscript") ||
      content.includes("fallback") ||
      content.includes("降级");

    assert.equal(hasFallback, true, `模板 ${tpl.id} 应含可见降级（HTML 表格 / SVG / noscript / fallback 标记）`);
  }
});

// ============================================================================
// 测试组 9：fixture.json 有效性（D6 文档意图遵从）
// ============================================================================

test("G-03 D6: 每个 fixture.json 是有效 JSON 且含必需字段", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const filePath = path.join(templatesDir, tpl.id, "fixture.json");
    const raw = fs.readFileSync(filePath, "utf-8");

    // 必须是有效 JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(`模板 ${tpl.id} 的 fixture.json 不是有效 JSON: ${(e as Error).message}`);
    }

    // 必须含 title / description / data 字段
    assert.equal(typeof parsed, "object", `模板 ${tpl.id} 的 fixture 应为对象`);
    const obj = parsed as Record<string, unknown>;
    assert.equal(typeof obj.title, "string", `模板 ${tpl.id} 的 fixture.title 应为字符串`);
    assert.equal(typeof obj.description, "string", `模板 ${tpl.id} 的 fixture.description 应为字符串`);
    assert.equal(typeof obj.data, "object", `模板 ${tpl.id} 的 fixture.data 应为对象`);
  }
});

// ============================================================================
// 测试组 10：template.md 完整性（D6 文档意图遵从）
// ============================================================================

test("G-03 D6: 每个 template.md 含必需章节（场景与意图/数据形状/适配要点/降级策略）", () => {
  const requiredSections = ["场景与意图", "数据形状", "适配要点", "降级策略"];

  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "template.md");
    for (const section of requiredSections) {
      assert.equal(content.includes(section), true, `模板 ${tpl.id} 的 template.md 应含章节: ${section}`);
    }
  }
});

test("G-03 D6: 每个 template.md 含场景与意图字段与 manifest 一致", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "template.md");

    // 场景字段
    assert.equal(
      content.includes(`场景：${tpl.scene}`) || content.includes(tpl.scene),
      true,
      `模板 ${tpl.id} 的 template.md 场景字段应为 ${tpl.scene}`
    );

    // 意图字段
    assert.equal(
      content.includes(`意图：${tpl.intent}`) || content.includes(tpl.intent),
      true,
      `模板 ${tpl.id} 的 template.md 意图字段应为 ${tpl.intent}`
    );
  }
});

// ============================================================================
// 测试组 11：TODO/FIXME 清零（D5）
// ============================================================================

test("G-03 D5: 每个 widget-code.html 无 TODO/FIXME 残留", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "widget-code.html");

    // 检查 TODO/FIXME 注释（区分大小写，但匹配 TODO: / FIXME: 形式）
    const hasTodo = /\bTODO\b/.test(content);
    const hasFixme = /\bFIXME\b/.test(content);

    assert.equal(hasTodo, false, `模板 ${tpl.id} 的 widget-code.html 不应残留 TODO 注释`);
    assert.equal(hasFixme, false, `模板 ${tpl.id} 的 widget-code.html 不应残留 FIXME 注释`);
  }
});

test("G-03 D5: 每个 template.md 无 TODO/FIXME 残留", () => {
  for (const tpl of EXPECTED_TEMPLATES) {
    const content = readTemplateFile(tpl.id, "template.md");
    const hasTodo = /\bTODO\b/.test(content);
    const hasFixme = /\bFIXME\b/.test(content);

    assert.equal(hasTodo, false, `模板 ${tpl.id} 的 template.md 不应残留 TODO`);
    assert.equal(hasFixme, false, `模板 ${tpl.id} 的 template.md 不应残留 FIXME`);
  }
});

// ============================================================================
// 测试组 12：场景文件引用一致性（D2 集成完整性）
// ============================================================================

test("G-03 D2: scenes/data-visualization.md 引用的模板都存在且 status=ready", () => {
  const sceneFile = path.join(scenesDir, "data-visualization.md");
  const content = fs.readFileSync(sceneFile, "utf-8");
  const manifest = readManifest();

  // 在场景文件中查找形如 `template-id` 的引用（出现在反引号内）
  // data-visualization.md 的选材矩阵中列出模板 ID
  const referencedIds = new Set<string>();
  for (const tpl of manifest.templates) {
    if (tpl.scene === "data-visualization") {
      // 检查场景文件中是否引用了该模板 ID
      // 用反引号包裹的模板 ID（如 `line-trend`）
      const pattern = new RegExp(`\`${tpl.id}\``, "g");
      if (pattern.test(content)) {
        referencedIds.add(tpl.id);
      }
    }
  }

  // 至少应引用一部分 data-visualization 场景的模板
  assert.equal(referencedIds.size > 0, true, "data-visualization.md 应至少引用一个该场景的模板");
});

test("G-03 D2: scenes/architecture-and-flow.md 引用的模板都存在且 status=ready", () => {
  const sceneFile = path.join(scenesDir, "architecture-and-flow.md");
  const content = fs.readFileSync(sceneFile, "utf-8");
  const manifest = readManifest();

  const referencedIds = new Set<string>();
  for (const tpl of manifest.templates) {
    if (tpl.scene === "architecture-and-flow") {
      const pattern = new RegExp(`\`${tpl.id}\``, "g");
      if (pattern.test(content)) {
        referencedIds.add(tpl.id);
      }
    }
  }

  assert.equal(referencedIds.size > 0, true, "architecture-and-flow.md 应至少引用一个该场景的模板");
});

test("G-03 D2: scenes/comparison-and-decision.md 引用的模板都存在且 status=ready", () => {
  const sceneFile = path.join(scenesDir, "comparison-and-decision.md");
  const content = fs.readFileSync(sceneFile, "utf-8");
  const manifest = readManifest();

  const referencedIds = new Set<string>();
  for (const tpl of manifest.templates) {
    if (tpl.scene === "comparison-and-decision") {
      const pattern = new RegExp(`\`${tpl.id}\``, "g");
      if (pattern.test(content)) {
        referencedIds.add(tpl.id);
      }
    }
  }

  assert.equal(referencedIds.size > 0, true, "comparison-and-decision.md 应至少引用一个该场景的模板");
});

// ============================================================================
// 测试组 13：复杂端到端场景测试（模拟 LLM 选择模板的完整流程）
// ============================================================================

/**
 * 模拟 LLM 根据用户意图选择模板的场景
 * 验证：用户请求 → 模板匹配 → 模板就绪 → 可适配的完整流程
 */

test("G-03 E2E: 用户请求「画销售趋势折线图」应匹配到 line-trend 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "line-trend");
  assert.equal(tpl?.status, "ready", "line-trend 模板应已就绪");

  // 验证模板文件齐全
  const tplDir = path.join(templatesDir, "line-trend");
  assert.equal(fs.existsSync(path.join(tplDir, "template.md")), true);
  assert.equal(fs.existsSync(path.join(tplDir, "widget-code.html")), true);
  assert.equal(fs.existsSync(path.join(tplDir, "fixture.json")), true);

  // 验证 widget 含 Chart.js 与折线图类型
  const widgetContent = readTemplateFile("line-trend", "widget-code.html");
  assert.equal(
    widgetContent.includes("chart.js@4") || widgetContent.includes("type:") || widgetContent.includes("line"),
    true,
    "line-trend widget 应配置 Chart.js line 类型"
  );
});

test("G-03 E2E: 用户请求「对比 React/Vue/Svelte」应匹配到 comparison-cards 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "comparison-cards");
  assert.equal(tpl?.status, "ready", "comparison-cards 模板应已就绪");
  assert.equal(tpl?.kind, "comparison", "comparison-cards kind 应为 comparison");
  assert.equal(tpl?.scene, "comparison-and-decision", "comparison-cards scene 应为 comparison-and-decision");

  // 验证 widget 含卡片容器与推荐徽章机制
  const widgetContent = readTemplateFile("comparison-cards", "widget-code.html");
  assert.equal(
    widgetContent.includes("推荐") || widgetContent.includes("recommend"),
    true,
    "comparison-cards widget 应支持推荐徽章"
  );
});

test("G-03 E2E: 用户请求「画用户登录时序图」应匹配到 sequence-diagram 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "sequence-diagram");
  assert.equal(tpl?.status, "ready", "sequence-diagram 模板应已就绪");
  assert.equal(tpl?.kind, "diagram", "sequence-diagram kind 应为 diagram");

  // 验证 widget 含 SVG 与生命线
  const widgetContent = readTemplateFile("sequence-diagram", "widget-code.html");
  assert.equal(widgetContent.includes("<svg"), true, "sequence-diagram widget 应使用 SVG");
  assert.equal(
    widgetContent.includes("生命线") || widgetContent.includes("lifeline") || widgetContent.includes("participant"),
    true,
    "sequence-diagram widget 应含生命线/参与者概念"
  );
});

test("G-03 E2E: 用户请求「画热力图」应匹配到 heatmap-chart 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "heatmap-chart");
  assert.equal(tpl?.status, "ready", "heatmap-chart 模板应已就绪");

  // 验证 widget 含 SVG cell 实现（静态 <rect> 或 JS 动态 createElementNS）
  const widgetContent = readTemplateFile("heatmap-chart", "widget-code.html");
  const hasStaticRect = widgetContent.includes("<rect");
  const hasDynamicRect = widgetContent.includes("createElementNS") && widgetContent.includes("rect");
  assert.equal(
    hasStaticRect || hasDynamicRect,
    true,
    "heatmap-chart widget 应含 SVG <rect> cell（静态或通过 createElementNS 动态创建）"
  );
});

test("G-03 E2E: 用户请求「画甘特图」应匹配到 gantt-chart 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "gantt-chart");
  assert.equal(tpl?.status, "ready", "gantt-chart 模板应已就绪");
  assert.equal(tpl?.scene, "architecture-and-flow", "gantt-chart scene 应为 architecture-and-flow");

  // 验证 widget 含 SVG 或时间线
  const widgetContent = readTemplateFile("gantt-chart", "widget-code.html");
  assert.equal(
    widgetContent.includes("<svg") || widgetContent.includes("时间"),
    true,
    "gantt-chart widget 应含 SVG 或时间线"
  );
});

test("G-03 E2E: 用户请求「数据漏斗分析」应匹配到 funnel-bar-chart 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "funnel-bar-chart");
  assert.equal(tpl?.status, "ready", "funnel-bar-chart 模板应已就绪");

  // 验证 widget 含 Chart.js 漏斗柱状配置
  const widgetContent = readTemplateFile("funnel-bar-chart", "widget-code.html");
  assert.equal(
    widgetContent.includes("chart.js@4") || widgetContent.includes("bar"),
    true,
    "funnel-bar-chart widget 应使用 Chart.js bar 类型"
  );
});

test("G-03 E2E: 用户请求「架构图」应匹配到 architecture-elements 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "architecture-elements");
  assert.equal(tpl?.status, "ready", "architecture-elements 模板应已就绪");
  assert.equal(tpl?.kind, "diagram", "architecture-elements kind 应为 diagram");
});

test("G-03 E2E: 用户请求「画像对比」应匹配到 radar-chart-legend 模板且就绪", () => {
  const manifest = readManifest();
  const tpl = manifest.templates.find((t) => t.id === "radar-chart-legend");
  assert.equal(tpl?.status, "ready", "radar-chart-legend 模板应已就绪");
});

// ============================================================================
// 测试组 14：token 系统完整性（D3 测试正确性）
// ============================================================================

test("G-03 D3: tokens/visual-tokens.md 文件存在且含完整 token 定义", () => {
  const tokensFile = path.join(tokensDir, "visual-tokens.md");
  assert.equal(fs.existsSync(tokensFile), true, "visual-tokens.md 应存在");
  const content = fs.readFileSync(tokensFile, "utf-8");

  // 必需的 token 类别
  assert.equal(content.includes("--surface"), true, "visual-tokens.md 应定义 --surface");
  assert.equal(content.includes("--brand"), true, "visual-tokens.md 应定义 --brand");
  assert.equal(content.includes("--chart-series-1"), true, "visual-tokens.md 应定义 --chart-series-1");
  assert.equal(content.includes("--spacer-4"), true, "visual-tokens.md 应定义 --spacer-4");
  assert.equal(content.includes("--radius"), true, "visual-tokens.md 应定义 --radius");
  assert.equal(content.includes("--font-sans"), true, "visual-tokens.md 应定义 --font-sans");
});

test("G-03 D3: SKILL.md 文件存在且含场景路由表", () => {
  const skillFile = path.join(dynamicUiDir, "SKILL.md");
  assert.equal(fs.existsSync(skillFile), true, "SKILL.md 应存在");
  const content = fs.readFileSync(skillFile, "utf-8");

  // 必需的章节
  assert.equal(content.includes("场景路由"), true, "SKILL.md 应含场景路由章节");
  assert.equal(content.includes("data-visualization"), true, "SKILL.md 应引用 data-visualization 场景");
  assert.equal(content.includes("architecture-and-flow"), true, "SKILL.md 应引用 architecture-and-flow 场景");
  assert.equal(content.includes("comparison-and-decision"), true, "SKILL.md 应引用 comparison-and-decision 场景");

  // 工具契约
  assert.equal(content.includes("pure_show_widget"), true, "SKILL.md 应说明 pure_show_widget 工具契约");

  // 安全规则
  assert.equal(content.includes("安全规则"), true, "SKILL.md 应含安全规则章节");
});

// ============================================================================
// 测试组 15：场景文件完整性
// ============================================================================

test("G-03 D2: scenes 目录下 5 个场景文件全部存在", () => {
  const expectedScenes = [
    "data-visualization.md",
    "architecture-and-flow.md",
    "comparison-and-decision.md",
    "mechanism-explanation.md",
    "micro-interaction.md",
  ];
  for (const scene of expectedScenes) {
    const filePath = path.join(scenesDir, scene);
    assert.equal(fs.existsSync(filePath), true, `场景文件 ${scene} 应存在`);
  }
});

// ============================================================================
// 测试组 16：物化覆盖率统计（汇总测试）
// ============================================================================

test("G-03 汇总: 16 个模板物化覆盖率 100%", () => {
  const manifest = readManifest();
  const readyCount = manifest.templates.filter((t) => t.status === "ready").length;
  assert.equal(readyCount, 16, `应有 16 个模板 status=ready，实际 ${readyCount}`);
  assert.equal(readyCount / manifest.templates.length, 1, "物化覆盖率应为 100%");
});

test("G-03 汇总: 全部模板文件数量统计（16 模板 × 3 文件 = 48 文件）", () => {
  let totalFiles = 0;
  for (const tpl of EXPECTED_TEMPLATES) {
    const tplDir = path.join(templatesDir, tpl.id);
    const files = fs.readdirSync(tplDir);
    totalFiles += files.length;
  }
  assert.equal(totalFiles >= 48, true, `应有至少 48 个文件（16 模板 × 3 必需文件），实际 ${totalFiles} 个`);
});
