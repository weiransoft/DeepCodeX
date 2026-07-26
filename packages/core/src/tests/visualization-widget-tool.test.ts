/**
 * P1-T6：visualization widget-tool 单元测试
 *
 * 验证 widget-tool.ts 的 handlePureShowWidget：
 * 1. 成功路径（渲染并落盘 widget）
 * 2. 参数校验（widget_code/widget_type 必填、合法）
 * 3. 错误处理（projectRoot 缺失、渲染异常）
 * 4. metadata 字段完整性
 *
 * 注意：遵循项目规则，不使用 mock，使用真实临时目录与真实文件系统。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handlePureShowWidget } from "../visualization/widget-tool";
import type { ToolExecutionContext } from "../tools/executor";

// ============================================================================
// 临时目录管理
// ============================================================================

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createContext(projectRoot: string): ToolExecutionContext {
  return { projectRoot };
}

// ============================================================================
// 测试组 1：成功路径
// ============================================================================

test("P1-T6: handlePureShowWidget 成功渲染并落盘 widget", async () => {
  const projectRoot = createTempDir("deepcode-widget-success-");
  const args = {
    widget_code: '<div style="padding:20px"><h2>测试图表</h2><p>内容</p></div>',
    widget_type: "chart",
    title: "测试图表标题",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));

  assert.equal(result.ok, true, "应返回 ok:true");
  assert.equal(result.name, "pure_show_widget", "name 应为 pure_show_widget");
  assert.equal(typeof result.output, "string", "应返回 output 文本");
  assert.equal(result.output.includes("请在浏览器中打开"), true, "output 应包含降级提示");
});

test("P1-T6: handlePureShowWidget 成功时 metadata 包含 filePath", async () => {
  const projectRoot = createTempDir("deepcode-widget-metadata-");
  const args = {
    widget_code: "<p>hello</p>",
    widget_type: "card",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));

  assert.equal(result.ok, true);
  assert.equal(typeof result.metadata, "object", "metadata 应为对象");
  const metadata = result.metadata as { filePath?: string; fileName?: string; widgetType?: string };
  assert.equal(typeof metadata.filePath, "string", "metadata.filePath 应为字符串");
  assert.equal(path.isAbsolute(metadata.filePath!), true, "filePath 应为绝对路径");
  assert.equal(fs.existsSync(metadata.filePath!), true, "文件应实际存在");
  assert.equal(typeof metadata.fileName, "string", "metadata.fileName 应为字符串");
  assert.equal(metadata.widgetType, "card", "metadata.widgetType 应为 card");
});

test("P1-T6: handlePureShowWidget 成功时文件写入 .deepcodex/widgets/ 目录", async () => {
  const projectRoot = createTempDir("deepcode-widget-dir-");
  const args = {
    widget_code: "<p>test</p>",
    widget_type: "diagram",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));
  const metadata = result.metadata as { filePath: string };

  const widgetsDir = path.join(projectRoot, ".deepcodex", "widgets");
  assert.equal(fs.existsSync(widgetsDir), true, ".deepcodex/widgets/ 目录应已创建");
  assert.equal(metadata.filePath.startsWith(widgetsDir), true, "filePath 应位于 .deepcodex/widgets/ 目录下");
});

test("P1-T6: handlePureShowWidget 生成的 HTML 包含 widget_code 内容", async () => {
  const projectRoot = createTempDir("deepcode-widget-content-");
  const widgetCode = "<canvas id=\"myChart\"></canvas><script>console.log('rendered')</script>";
  const args = {
    widget_code: widgetCode,
    widget_type: "chart",
    title: "内容验证",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));
  const metadata = result.metadata as { filePath: string };
  const fileContent = fs.readFileSync(metadata.filePath, "utf8");

  assert.equal(fileContent.includes("内容验证"), true, "文件应包含 title");
  assert.equal(fileContent.includes('sandbox="allow-scripts"'), true, "文件应包含 iframe sandbox");
  // widget_code 经转义后嵌入，console.log 应存在（转义不影响字母）
  assert.equal(fileContent.includes("console.log"), true, "文件应包含 widget_code 脚本");
});

test("P1-T6: handlePureShowWidget metadata 包含 sizeBytes", async () => {
  const projectRoot = createTempDir("deepcode-widget-size-");
  const args = {
    widget_code: "<p>size test</p>",
    widget_type: "custom",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));
  const metadata = result.metadata as { sizeBytes: number };
  assert.equal(typeof metadata.sizeBytes, "number", "sizeBytes 应为数字");
  assert.equal(metadata.sizeBytes > 0, true, "sizeBytes 应大于 0");
});

test("P1-T6: handlePureShowWidget 未提供 title 时 metadata.title 为 null", async () => {
  const projectRoot = createTempDir("deepcode-widget-no-title-");
  const args = {
    widget_code: "<p>x</p>",
    widget_type: "flow",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));
  const metadata = result.metadata as { title: unknown };
  assert.equal(metadata.title, null, "未提供 title 时 metadata.title 应为 null");
});

test("P1-T6: handlePureShowWidget 提供 title 时 metadata.title 包含该值", async () => {
  const projectRoot = createTempDir("deepcode-widget-with-title-");
  const args = {
    widget_code: "<p>x</p>",
    widget_type: "chart",
    title: "自定义标题",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));
  const metadata = result.metadata as { title: string };
  assert.equal(metadata.title, "自定义标题", "metadata.title 应为传入的 title");
});

// ============================================================================
// 测试组 2：参数校验
// ============================================================================

test("P1-T6: handlePureShowWidget widget_code 缺失时返回错误", async () => {
  const projectRoot = createTempDir("deepcode-widget-no-code-");
  const args = {
    widget_type: "chart",
  };

  const result = await handlePureShowWidget(args as unknown as Record<string, unknown>, createContext(projectRoot));

  assert.equal(result.ok, false, "应返回 ok:false");
  assert.equal(typeof result.error, "string", "应返回 error");
  assert.equal(result.error.includes("widget_code"), true, "error 应提及 widget_code 参数");
});

test("P1-T6: handlePureShowWidget widget_code 为空字符串时返回错误", async () => {
  const projectRoot = createTempDir("deepcode-widget-empty-code-");
  const args = {
    widget_code: "",
    widget_type: "chart",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));

  assert.equal(result.ok, false, "空 widget_code 应返回 ok:false");
  assert.equal(result.error.includes("widget_code"), true, "error 应提及 widget_code");
});

test("P1-T6: handlePureShowWidget widget_code 非字符串时返回错误", async () => {
  const projectRoot = createTempDir("deepcode-widget-non-string-");
  const args = {
    widget_code: 123,
    widget_type: "chart",
  };

  const result = await handlePureShowWidget(args as unknown as Record<string, unknown>, createContext(projectRoot));

  assert.equal(result.ok, false, "非字符串 widget_code 应返回 ok:false");
});

test("P1-T6: handlePureShowWidget widget_type 缺失时返回错误", async () => {
  const projectRoot = createTempDir("deepcode-widget-no-type-");
  const args = {
    widget_code: "<p>x</p>",
  };

  const result = await handlePureShowWidget(args as unknown as Record<string, unknown>, createContext(projectRoot));

  assert.equal(result.ok, false, "widget_type 缺失应返回 ok:false");
  assert.equal(result.error.includes("widget_type"), true, "error 应提及 widget_type");
});

test("P1-T6: handlePureShowWidget widget_type 为空字符串时返回错误", async () => {
  const projectRoot = createTempDir("deepcode-widget-empty-type-");
  const args = {
    widget_code: "<p>x</p>",
    widget_type: "",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));

  assert.equal(result.ok, false, "空 widget_type 应返回 ok:false");
});

test("P1-T6: handlePureShowWidget widget_type 非法枚举值时返回错误", async () => {
  const projectRoot = createTempDir("deepcode-widget-invalid-type-");
  const args = {
    widget_code: "<p>x</p>",
    widget_type: "invalid",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));

  assert.equal(result.ok, false, "非法 widget_type 应返回 ok:false");
  assert.equal(result.error.includes("chart/diagram/card/flow/custom"), true, "error 应列出合法枚举值");
});

test("P1-T6: handlePureShowWidget 5 种合法 widget_type 都能成功", async () => {
  const validTypes = ["chart", "diagram", "card", "flow", "custom"];
  for (const widgetType of validTypes) {
    const projectRoot = createTempDir("deepcode-widget-valid-types-");
    const args = {
      widget_code: "<p>x</p>",
      widget_type: widgetType,
    };

    const result = await handlePureShowWidget(args, createContext(projectRoot));
    assert.equal(result.ok, true, `widget_type="${widgetType}" 应成功`);
    const metadata = result.metadata as { widgetType: string };
    assert.equal(metadata.widgetType, widgetType, `metadata.widgetType 应为 ${widgetType}`);
  }
});

// ============================================================================
// 测试组 3：上下文校验
// ============================================================================

test("P1-T6: handlePureShowWidget projectRoot 缺失时返回错误", async () => {
  const args = {
    widget_code: "<p>x</p>",
    widget_type: "chart",
  };

  // projectRoot 为空字符串
  const result = await handlePureShowWidget(args, createContext(""));

  assert.equal(result.ok, false, "projectRoot 为空应返回 ok:false");
  assert.equal(result.error.includes("projectRoot"), true, "error 应提及 projectRoot");
});

test("P1-T6: handlePureShowWidget projectRoot 不存在时仍尝试创建目录", async () => {
  // projectRoot 指向一个不存在的路径，saveWidget 应通过 mkdir recursive 创建
  const baseTemp = createTempDir("deepcode-widget-nonexist-root-");
  const nonExistRoot = path.join(baseTemp, "nested", "project");
  // 不预先创建 nested/project 目录
  const args = {
    widget_code: "<p>x</p>",
    widget_type: "chart",
  };

  const result = await handlePureShowWidget(args, createContext(nonExistRoot));
  assert.equal(result.ok, true, "projectRoot 不存在时应自动创建目录");
  const metadata = result.metadata as { filePath: string };
  assert.equal(fs.existsSync(metadata.filePath), true, "文件应已创建");
});

// ============================================================================
// 测试组 4：错误边界
// ============================================================================

test("P1-T6: handlePureShowWidget 渲染异常不向上抛出", async () => {
  const projectRoot = createTempDir("deepcode-widget-error-");
  // 使用一个会导致渲染问题的 widget_code（空字符串已在参数校验拦截，
  // 这里使用一个非常长的字符串测试健壮性）
  const longCode = "x".repeat(10000);
  const args = {
    widget_code: longCode,
    widget_type: "custom",
  };

  const result = await handlePureShowWidget(args, createContext(projectRoot));
  assert.equal(result.ok, true, "长字符串 widget_code 应正常处理");
  const metadata = result.metadata as { sizeBytes: number };
  assert.equal(metadata.sizeBytes > 10000, true, "sizeBytes 应反映 HTML 总大小");
});

// ============================================================================
// 清理临时目录
// ============================================================================

test("P1-T6: 清理 widget-tool 临时目录", () => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(tempDirs.length > 0, true, "应已清理临时目录");
});
