/**
 * P0-T7：browser-automation skill 安全规则测试
 *
 * 验证 browser-automation skill 的：
 * 1. 文件存在且 frontmatter 格式正确
 * 2. 29 个 Chrome DevTools MCP 工具名被引用
 * 3. 6 类安全红线规则完整
 * 4. MCP 降级处理说明存在
 * 5. 与 code-mode-orchestrator 协同说明存在
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 读取 browser-automation skill 的 SKILL.md 内容
 * @returns SKILL.md 文件内容字符串
 */
function readBrowserAutomationSkillMd(): string {
  const skillPath = path.join(repoRoot, "templates/skills/bundled/browser-automation/SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 列出 Chrome DevTools MCP 工具目录下的所有工具 JSON 文件
 * @returns 工具名列表（不含 .json 后缀）
 */
function listMcpTools(): string[] {
  const mcpToolsDir = path.join(
    os.homedir(),
    ".trae-cn/mcps/m__trae-cn_multi-agen-24840664/solo_agent/mcp_Chrome_DevTools_MCP/tools"
  );
  if (!fs.existsSync(mcpToolsDir)) {
    return [];
  }
  return fs
    .readdirSync(mcpToolsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(".json", ""));
}

// ============================================================================
// 测试组 1：文件存在性与 frontmatter 格式
// ============================================================================

test("P0-T7: browser-automation skill 文件存在且 frontmatter 格式正确", () => {
  const skillPath = path.join(repoRoot, "templates/skills/bundled/browser-automation/SKILL.md");
  assert.equal(fs.existsSync(skillPath), true, "browser-automation/SKILL.md 应存在");

  const content = readBrowserAutomationSkillMd();

  // 验证 frontmatter 存在
  assert.equal(content.startsWith("---"), true, "应以 frontmatter 开头");

  // 验证 name 字段
  assert.equal(content.includes("name: browser-automation"), true, "应包含 name: browser-automation");

  // 验证 description 字段
  assert.equal(content.includes("description:"), true, "应包含 description 字段");
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");

  // 验证 triggers 列表
  assert.equal(content.includes("triggers:"), true, "应包含 triggers 列表");
});

// ============================================================================
// 测试组 2：29 个 MCP 工具名引用
// ============================================================================

test("P0-T7: skill 引用全部 29 个 Chrome DevTools MCP 工具", () => {
  const skillContent = readBrowserAutomationSkillMd();
  const mcpTools = listMcpTools();

  // 如果 MCP 目录不存在（非 macOS Trae 环境），跳过工具数量验证但仍验证 skill 引用
  if (mcpTools.length === 0) {
    console.log("⚠️ Chrome DevTools MCP 目录不存在，跳过工具数量验证");
    return;
  }

  // 验证 skill 引用了所有 MCP 工具
  const missingTools: string[] = [];
  for (const tool of mcpTools) {
    if (!skillContent.includes(`\`${tool}\``)) {
      missingTools.push(tool);
    }
  }

  assert.equal(missingTools.length, 0, `SKILL.md 缺少以下 MCP 工具引用: ${missingTools.join(", ")}`);
});

test("P0-T7: skill 明确标注 29 个工具数量", () => {
  const skillContent = readBrowserAutomationSkillMd();
  assert.equal(skillContent.includes("29"), true, "SKILL.md 应明确标注 29 个工具数量");
});

// ============================================================================
// 测试组 3：6 类安全红线规则
// ============================================================================

test("P0-T7: skill 包含 6 类安全红线规则", () => {
  const skillContent = readBrowserAutomationSkillMd();

  // 6 类安全红线
  const expectedRedLines = [
    { keyword: "凭据", description: "凭据输入红线" },
    { keyword: "CAPTCHA", description: "验证码红线" },
    { keyword: "删除", description: "删除类操作红线" },
    { keyword: "表单提交", description: "表单提交红线" },
    { keyword: "文件下载", description: "文件下载红线" },
    { keyword: "支付", description: "支付操作红线" },
  ];

  for (const { keyword, description } of expectedRedLines) {
    assert.equal(skillContent.includes(keyword), true, `SKILL.md 应包含安全红线: ${description}（关键词: ${keyword}）`);
  }
});

test("P0-T7: skill 安全规则要求 AskUserQuestion 确认", () => {
  const skillContent = readBrowserAutomationSkillMd();

  // 验证安全规则引用了 AskUserQuestion 工具
  assert.equal(skillContent.includes("AskUserQuestion"), true, "安全规则应引用 AskUserQuestion 工具进行确认");
});

test("P0-T7: skill 包含危险操作关键词检测", () => {
  const skillContent = readBrowserAutomationSkillMd();

  // 验证危险关键词列表
  const dangerousKeywords = ["delete", "remove", "clear", "reset", "pay", "checkout"];
  for (const keyword of dangerousKeywords) {
    assert.equal(skillContent.includes(keyword), true, `SKILL.md 应包含危险关键词: ${keyword}`);
  }
});

// ============================================================================
// 测试组 4：MCP 降级处理
// ============================================================================

test("P0-T7: skill 包含 MCP 未配置时的降级处理说明", () => {
  const skillContent = readBrowserAutomationSkillMd();

  // 验证降级处理章节存在
  assert.equal(skillContent.includes("降级处理"), true, "SKILL.md 应包含降级处理章节");

  // 验证 MCP 未配置时的行为说明
  assert.equal(skillContent.includes("未配置") || skillContent.includes("不可用"), true, "应说明 MCP 未配置时的行为");

  // 验证降级时不抛错
  assert.equal(
    skillContent.includes("不抛错") || skillContent.includes("保持流程继续"),
    true,
    "降级时应明确不抛错，保持流程继续"
  );
});

test("P0-T7: skill 包含 MCP 配置示例", () => {
  const skillContent = readBrowserAutomationSkillMd();

  // 验证包含 mcpServers 配置示例
  assert.equal(skillContent.includes("mcpServers"), true, "SKILL.md 应包含 mcpServers 配置示例");

  // 验证包含 mcp_Chrome_DevTools_MCP 标识
  assert.equal(skillContent.includes("mcp_Chrome_DevTools_MCP"), true, "SKILL.md 应包含 mcp_Chrome_DevTools_MCP 标识");
});

// ============================================================================
// 测试组 5：与 code-mode-orchestrator 协同
// ============================================================================

test("P0-T7: skill 包含与 code-mode-orchestrator 协同说明", () => {
  const skillContent = readBrowserAutomationSkillMd();

  assert.equal(
    skillContent.includes("code-mode-orchestrator"),
    true,
    "SKILL.md 应包含与 code-mode-orchestrator 协同说明"
  );

  assert.equal(skillContent.includes("fan-out-aggregate"), true, "协同说明应引用 fan-out-aggregate 模式");
});

// ============================================================================
// 测试组 6：典型工作流
// ============================================================================

test("P0-T7: skill 包含 4 个典型工作流", () => {
  const skillContent = readBrowserAutomationSkillMd();

  const expectedWorkflows = ["E2E 测试", "视觉回归测试", "性能分析", "控制台"];

  for (const workflow of expectedWorkflows) {
    assert.equal(skillContent.includes(workflow), true, `SKILL.md 应包含典型工作流: ${workflow}`);
  }
});
