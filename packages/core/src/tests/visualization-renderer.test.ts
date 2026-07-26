/**
 * P1-T6：visualization renderer 单元测试
 *
 * 验证 renderer.ts 的：
 * 1. isValidWidgetType 类型校验
 * 2. renderWidget HTML 渲染（iframe sandbox、标题、转义、文件名）
 * 3. saveWidget 文件落盘（目录创建、路径穿越防护、错误处理）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isValidWidgetType, renderWidget, saveWidget } from "../visualization/renderer";

// ============================================================================
// 测试组 1：isValidWidgetType 类型校验
// ============================================================================

test("P1-T6: isValidWidgetType 对 5 种合法类型返回 true", () => {
  const validTypes = ["chart", "diagram", "card", "flow", "custom"];
  for (const t of validTypes) {
    assert.equal(isValidWidgetType(t), true, `isValidWidgetType("${t}") 应返回 true`);
  }
});

test("P1-T6: isValidWidgetType 对非法类型返回 false", () => {
  const invalidTypes = ["", "Chart", "CHART", "table", "image", "unknown", "123", null as unknown as string];
  for (const t of invalidTypes) {
    assert.equal(isValidWidgetType(t), false, `isValidWidgetType("${t}") 应返回 false`);
  }
});

// ============================================================================
// 测试组 2：renderWidget HTML 渲染
// ============================================================================

test("P1-T6: renderWidget 返回 html 和 fileName", () => {
  const result = renderWidget("<div>hello</div>", "chart");
  assert.equal(typeof result.html, "string");
  assert.equal(result.html.length > 0, true);
  assert.equal(typeof result.fileName, "string");
  assert.equal(result.fileName.length > 0, true);
});

test("P1-T6: renderWidget 生成的 html 包含 iframe sandbox=allow-scripts", () => {
  const result = renderWidget("<p>test</p>", "diagram");
  assert.equal(
    result.html.includes('sandbox="allow-scripts"'),
    true,
    "html 应包含 iframe sandbox=allow-scripts（安全沙箱）"
  );
});

test("P1-T6: renderWidget 生成的 html 包含 widget-type meta 标签", () => {
  const result = renderWidget("<p>test</p>", "flow");
  assert.equal(result.html.includes('name="widget-type" content="flow"'), true, "html 应包含 widget-type meta 标签");
});

test("P1-T6: renderWidget 使用传入的 title 作为页面标题", () => {
  const result = renderWidget("<div>x</div>", "card", "销售数据概览");
  assert.equal(result.html.includes("<title>销售数据概览</title>"), true, "html 应使用传入的 title 作为 <title>");
  assert.equal(result.html.includes("销售数据概览"), true, "html 应在 H1 中显示 title");
});

test("P1-T6: renderWidget 未提供 title 时使用默认标题", () => {
  const result = renderWidget("<div>x</div>", "chart");
  assert.equal(
    result.html.includes("DeepCode Widget · chart"),
    true,
    "未提供 title 时应使用默认标题 'DeepCode Widget · {type}'"
  );
});

test("P1-T6: renderWidget 未提供 title 且 type 为 custom 时使用 custom 默认标题", () => {
  const result = renderWidget("<div>x</div>", "custom");
  assert.equal(
    result.html.includes("DeepCode Widget · custom"),
    true,
    "custom 类型未提供 title 时应使用 'DeepCode Widget · custom'"
  );
});

test("P1-T6: renderWidget 转义 widget_code 中的特殊字符", () => {
  // 含 & < > " 的 widget_code 应被转义后嵌入 srcdoc
  const widgetCode = '<div data-x="a&b<c>d">test</div>';
  const result = renderWidget(widgetCode, "custom");
  // 原始 <div 应被转义为 &lt;div
  assert.equal(result.html.includes("&lt;div"), true, "widget_code 中的 < 应被转义为 &lt;");
  // & 应被转义为 &amp;
  assert.equal(result.html.includes("a&amp;b"), true, "widget_code 中的 & 应被转义为 &amp;");
  // " 应被转义为 &quot;
  assert.equal(result.html.includes("&quot;a&amp;b"), true, 'widget_code 中的 " 应被转义为 &quot;');
});

test("P1-T6: renderWidget 文件名格式为 widget-{timestamp}-{random}.html", () => {
  const result = renderWidget("<p>x</p>", "chart");
  // 匹配 widget-{数字}-{8位hex}.html
  const fileNamePattern = /^widget-\d+-[0-9a-f]{8}\.html$/;
  assert.equal(
    fileNamePattern.test(result.fileName),
    true,
    `文件名格式应为 widget-{timestamp}-{8位hex}.html，实际: ${result.fileName}`
  );
});

test("P1-T6: renderWidget 无效 widgetType 降级为 custom", () => {
  // 传入非法 type，应降级为 custom 不抛错
  const result = renderWidget("<p>x</p>", "invalid-type");
  assert.equal(result.html.includes('name="widget-type" content="custom"'), true, "无效 widgetType 应降级为 custom");
  assert.equal(result.html.includes("DeepCode Widget · custom"), true, "无效 widgetType 默认标题应使用 custom");
});

test("P1-T6: renderWidget 生成的 html 是完整的 HTML 文档", () => {
  const result = renderWidget("<p>test</p>", "chart");
  assert.equal(result.html.startsWith("<!DOCTYPE html>"), true, "html 应以 <!DOCTYPE html> 开头");
  assert.equal(result.html.includes("<html"), true, "html 应包含 <html> 标签");
  assert.equal(result.html.includes("</html>"), true, "html 应以 </html> 结尾");
  assert.equal(result.html.includes("<head>"), true, "html 应包含 <head>");
  assert.equal(result.html.includes("<body>"), true, "html 应包含 <body>");
});

test("P1-T6: renderWidget 包含 generator meta 标签", () => {
  const result = renderWidget("<p>x</p>", "chart");
  assert.equal(
    result.html.includes('name="generator" content="DeepCodeX PureShowWidget"'),
    true,
    "html 应包含 generator meta 标签标识生成器"
  );
});

test("P1-T6: renderWidget 包含暗色主题支持", () => {
  const result = renderWidget("<p>x</p>", "chart");
  assert.equal(
    result.html.includes("@media (prefers-color-scheme: dark)"),
    true,
    "html 应包含 prefers-color-scheme: dark 媒体查询"
  );
});

// ============================================================================
// 测试组 3：saveWidget 文件落盘
// ============================================================================

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("P1-T6: saveWidget 创建 .deepcodex/widgets/ 目录并写入文件", () => {
  const projectRoot = createTempDir("deepcode-renderer-save-");
  const html = "<!DOCTYPE html><html><body>test</body></html>";
  const fileName = "widget-test-001.html";

  const filePath = saveWidget(html, fileName, projectRoot);

  // 验证返回的是绝对路径
  assert.equal(path.isAbsolute(filePath), true, "应返回绝对路径");

  // 验证 .deepcodex/widgets/ 目录已创建
  const widgetsDir = path.join(projectRoot, ".deepcodex", "widgets");
  assert.equal(fs.existsSync(widgetsDir), true, ".deepcodex/widgets/ 目录应已创建");

  // 验证文件已写入
  assert.equal(fs.existsSync(filePath), true, "文件应已写入");
  const content = fs.readFileSync(filePath, "utf8");
  assert.equal(content, html, "文件内容应与传入的 html 一致");
});

test("P1-T6: saveWidget 目录已存在时不报错", () => {
  const projectRoot = createTempDir("deepcode-renderer-exist-");
  const widgetsDir = path.join(projectRoot, ".deepcodex", "widgets");
  fs.mkdirSync(widgetsDir, { recursive: true });

  // 目录已存在，saveWidget 应正常工作
  const filePath = saveWidget("<p>x</p>", "widget-002.html", projectRoot);
  assert.equal(fs.existsSync(filePath), true, "目录已存在时文件应正常写入");
});

test("P1-T6: saveWidget 文件已存在时覆盖", () => {
  const projectRoot = createTempDir("deepcode-renderer-overwrite-");
  const fileName = "widget-overwrite.html";
  const html1 = "<p>old</p>";
  const html2 = "<p>new</p>";

  saveWidget(html1, fileName, projectRoot);
  const filePath = saveWidget(html2, fileName, projectRoot);

  const content = fs.readFileSync(filePath, "utf8");
  assert.equal(content, html2, "文件已存在时应被覆盖");
});

test("P1-T6: saveWidget 路径穿越防护 - fileName 含 / 时抛错", () => {
  const projectRoot = createTempDir("deepcode-renderer-traversal-");
  assert.throws(() => saveWidget("<p>x</p>", "../evil.html", projectRoot), /非法路径字符/, "fileName 含 .. 时应抛错");
  assert.throws(
    () => saveWidget("<p>x</p>", "subdir/file.html", projectRoot),
    /非法路径字符/,
    "fileName 含 / 时应抛错"
  );
  assert.throws(
    () => saveWidget("<p>x</p>", "back\\slash.html", projectRoot),
    /非法路径字符/,
    "fileName 含 \\ 时应抛错"
  );
});

test("P1-T6: saveWidget projectRoot 为空时抛错", () => {
  assert.throws(
    () => saveWidget("<p>x</p>", "widget.html", ""),
    /projectRoot 不能为空/,
    "projectRoot 为空字符串时应抛错"
  );
});

test("P1-T6: saveWidget fileName 为空时抛错", () => {
  const projectRoot = createTempDir("deepcode-renderer-empty-name-");
  assert.throws(() => saveWidget("<p>x</p>", "", projectRoot), /fileName 不能为空/, "fileName 为空字符串时应抛错");
});

// ============================================================================
// 测试组 4：集成测试 - renderWidget + saveWidget
// ============================================================================

test("P1-T6: renderWidget + saveWidget 集成 - 完整渲染落盘流程", () => {
  const projectRoot = createTempDir("deepcode-renderer-integration-");
  const widgetCode = `
<div style="padding: 20px;">
  <h2>销售概览</h2>
  <canvas id="chart"></canvas>
  <script>
    // 简单的图表渲染脚本
    console.log("chart rendered");
  </script>
</div>`;

  // 渲染
  const { html, fileName } = renderWidget(widgetCode, "chart", "Q3 销售数据");
  assert.equal(html.length > 100, true, "渲染的 HTML 应有内容");

  // 落盘
  const filePath = saveWidget(html, fileName, projectRoot);
  assert.equal(fs.existsSync(filePath), true, "文件应已写入");

  // 验证文件内容
  const content = fs.readFileSync(filePath, "utf8");
  assert.equal(content.includes("Q3 销售数据"), true, "文件应包含标题");
  assert.equal(content.includes('sandbox="allow-scripts"'), true, "文件应包含 sandbox");
  assert.equal(content.includes("console.log"), true, "文件应包含 widget_code 脚本");
});

// ============================================================================
// 清理临时目录
// ============================================================================

test("P1-T6: 清理临时目录", () => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(tempDirs.length > 0, true, "应已清理临时目录");
});
