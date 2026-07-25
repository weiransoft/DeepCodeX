/**
 * P0-T8：前端开发 skill 加载测试
 *
 * 验证 web-dev 和 web-artisan skill 的：
 * 1. 文件存在且 frontmatter 格式正确
 * 2. 触发词正确定义
 * 3. 文档工作流引用 .deepcodex/docs/ 路径
 * 4. references 目录存在
 * 5. 不引用 .trae/documents（旧路径）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 读取指定 skill 的 SKILL.md 内容
 * @param skillName skill 名称（如 web-dev、web-artisan）
 * @returns SKILL.md 文件内容字符串
 */
function readSkillMd(skillName: string): string {
  const skillPath = path.join(repoRoot, `templates/skills/bundled/${skillName}/SKILL.md`);
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 检查 skill 目录是否存在
 * @param skillName skill 名称
 * @returns 是否存在
 */
function skillDirExists(skillName: string): boolean {
  const skillDir = path.join(repoRoot, `templates/skills/bundled/${skillName}`);
  return fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory();
}

/**
 * 检查 references 目录是否存在
 * @param skillName skill 名称
 * @returns 是否存在
 */
function referencesDirExists(skillName: string): boolean {
  const refsDir = path.join(repoRoot, `templates/skills/bundled/${skillName}/references`);
  return fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory();
}

// ============================================================================
// 测试组 1：web-dev skill 验证
// ============================================================================

test("P0-T8: web-dev skill 目录与文件存在", () => {
  assert.equal(skillDirExists("web-dev"), true, "web-dev skill 目录应存在");

  const skillPath = path.join(repoRoot, "templates/skills/bundled/web-dev/SKILL.md");
  assert.equal(fs.existsSync(skillPath), true, "web-dev/SKILL.md 应存在");
});

test("P0-T8: web-dev skill frontmatter 格式正确", () => {
  const content = readSkillMd("web-dev");

  assert.equal(content.startsWith("---"), true, "应以 frontmatter 开头");
  assert.equal(content.includes("name: web-dev"), true, "应包含 name: web-dev");
  assert.equal(content.includes("description:"), true, "应包含 description 字段");
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");
  assert.equal(content.includes("triggers:"), true, "应包含 triggers 列表");
});

test("P0-T8: web-dev skill 包含正确触发词", () => {
  const content = readSkillMd("web-dev");

  const expectedTriggers = ["创建网站", "开发前端", "构建 web 应用", "设计页面"];
  for (const trigger of expectedTriggers) {
    assert.equal(content.includes(trigger), true, `web-dev skill 应包含触发词: ${trigger}`);
  }
});

test("P0-T8: web-dev skill 引用 .deepcodex/docs/ 路径", () => {
  const content = readSkillMd("web-dev");

  assert.equal(content.includes(".deepcodex/docs/"), true, "web-dev skill 应引用 .deepcodex/docs/ 路径");

  // 验证不引用旧路径 .trae/documents
  assert.equal(content.includes(".trae/documents"), false, "web-dev skill 不应引用旧路径 .trae/documents");
});

test("P0-T8: web-dev skill 包含 references 目录", () => {
  assert.equal(referencesDirExists("web-dev"), true, "web-dev skill 应包含 references 目录");

  const guidelinePath = path.join(repoRoot, "templates/skills/bundled/web-dev/references/web-dev-guideline.md");
  assert.equal(fs.existsSync(guidelinePath), true, "web-dev/references/web-dev-guideline.md 应存在");
});

test("P0-T8: web-dev skill 包含反 AI slop 规则", () => {
  const content = readSkillMd("web-dev");

  assert.equal(content.includes("AI slop") || content.includes("AI slop"), true, "web-dev skill 应包含反 AI slop 规则");
});

// ============================================================================
// 测试组 2：web-artisan skill 验证
// ============================================================================

test("P0-T8: web-artisan skill 目录与文件存在", () => {
  assert.equal(skillDirExists("web-artisan"), true, "web-artisan skill 目录应存在");

  const skillPath = path.join(repoRoot, "templates/skills/bundled/web-artisan/SKILL.md");
  assert.equal(fs.existsSync(skillPath), true, "web-artisan/SKILL.md 应存在");
});

test("P0-T8: web-artisan skill frontmatter 格式正确", () => {
  const content = readSkillMd("web-artisan");

  assert.equal(content.startsWith("---"), true, "应以 frontmatter 开头");
  assert.equal(content.includes("name: web-artisan"), true, "应包含 name: web-artisan");
  assert.equal(content.includes("description:"), true, "应包含 description 字段");
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");
  assert.equal(content.includes("triggers:"), true, "应包含 triggers 列表");
});

test("P0-T8: web-artisan skill 包含正确触发词", () => {
  const content = readSkillMd("web-artisan");

  const expectedTriggers = ["全栈开发", "React 开发", "Vue 开发", "Supabase 集成"];
  for (const trigger of expectedTriggers) {
    assert.equal(content.includes(trigger), true, `web-artisan skill 应包含触发词: ${trigger}`);
  }
});

test("P0-T8: web-artisan skill 引用 .deepcodex/docs/ 路径", () => {
  const content = readSkillMd("web-artisan");

  assert.equal(content.includes(".deepcodex/docs/"), true, "web-artisan skill 应引用 .deepcodex/docs/ 路径");

  // 验证不引用旧路径 .trae/documents
  assert.equal(content.includes(".trae/documents"), false, "web-artisan skill 不应引用旧路径 .trae/documents");
});

test("P0-T8: web-artisan skill 包含 references 目录", () => {
  assert.equal(referencesDirExists("web-artisan"), true, "web-artisan skill 应包含 references 目录");

  const handbooksPath = path.join(repoRoot, "templates/skills/bundled/web-artisan/references/handbooks.md");
  assert.equal(fs.existsSync(handbooksPath), true, "web-artisan/references/handbooks.md 应存在");
});

test("P0-T8: web-artisan skill 包含 guiding_principles", () => {
  const content = readSkillMd("web-artisan");

  assert.equal(
    content.includes("guiding_principles") || content.includes("指导原则"),
    true,
    "web-artisan skill 应包含 guiding_principles（指导原则）"
  );
});

test("P0-T8: web-artisan skill 包含 COMPLIANCE CHECKLIST", () => {
  const content = readSkillMd("web-artisan");

  assert.equal(
    content.includes("COMPLIANCE CHECKLIST") || content.includes("合规检查清单"),
    true,
    "web-artisan skill 应包含 COMPLIANCE CHECKLIST（合规检查清单）"
  );
});

// ============================================================================
// 测试组 3：SKILL.md 长度控制
// ============================================================================

test("P0-T8: web-dev SKILL.md 长度 ≤ 150 行", () => {
  const content = readSkillMd("web-dev");
  const lineCount = content.split("\n").length;
  assert.equal(lineCount <= 150, true, `web-dev/SKILL.md 应 ≤ 150 行，实际 ${lineCount} 行`);
});

test("P0-T8: web-artisan SKILL.md 长度 ≤ 150 行", () => {
  const content = readSkillMd("web-artisan");
  const lineCount = content.split("\n").length;
  assert.equal(lineCount <= 150, true, `web-artisan/SKILL.md 应 ≤ 150 行，实际 ${lineCount} 行`);
});

// ============================================================================
// 测试组 4：与 web-dev 的区别说明
// ============================================================================

test("P0-T8: web-artisan skill 说明与 web-dev 的区别", () => {
  const content = readSkillMd("web-artisan");

  assert.equal(content.includes("web-dev"), true, "web-artisan skill 应说明与 web-dev 的区别");
});
