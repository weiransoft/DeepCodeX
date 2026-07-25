/**
 * P2-T6：pptx skill 单元测试
 *
 * 验证 pptx skill 的：
 * 1. 文件存在性（SKILL.md + scripts/add_slide.py + scripts/thumbnail.py + references/）
 * 2. frontmatter 格式（name: pptx, description 含 "Use when" + ".pptx"）
 * 3. description 含触发词（.pptx, PowerPoint, slides, presentation）
 * 4. 脚本文件存在且有内容（不执行 Python）
 * 5. 设计原则说明（SKILL.md 中包含 "设计" / "visual" 相关字眼）
 * 6. data/ 目录设计系统 CSV 数据
 * 7. references 目录引用正确（pptxgenjs-guide.md）
 *
 * 测试规范：node:test + node:assert/strict + fs + path
 * 不使用 mock / 占位 / 简化实现
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// 仓库根目录（packages/core/），与现有测试保持一致
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * pptx skill 目录绝对路径
 */
const pptxSkillDir = path.join(repoRoot, "templates/skills/bundled/pptx");

/**
 * 读取 pptx skill 的 SKILL.md 内容
 * @returns SKILL.md 文件内容字符串
 */
function readPptxSkillMd(): string {
  const skillPath = path.join(pptxSkillDir, "SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 检查指定相对路径下的文件是否存在
 * @param relativePath 相对于 pptx skill 目录的路径
 * @returns 是否存在
 */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(pptxSkillDir, relativePath));
}

/**
 * 读取指定相对路径文件内容
 * @param relativePath 相对于 pptx skill 目录的路径
 * @returns 文件内容字符串
 */
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(pptxSkillDir, relativePath), "utf-8");
}

// ============================================================================
// 测试组 1：文件存在性
// ============================================================================

test("P2-T6: pptx skill 目录与 SKILL.md 存在", () => {
  assert.equal(fs.existsSync(pptxSkillDir) && fs.statSync(pptxSkillDir).isDirectory(), true, "pptx skill 目录应存在");
  assert.equal(fileExists("SKILL.md"), true, "pptx/SKILL.md 应存在");
});

test("P2-T6: pptx skill 两个 Python 脚本文件存在", () => {
  // add_slide.py 添加新幻灯片
  assert.equal(fileExists("scripts/add_slide.py"), true, "pptx/scripts/add_slide.py 应存在");
  // thumbnail.py 生成幻灯片缩略图
  assert.equal(fileExists("scripts/thumbnail.py"), true, "pptx/scripts/thumbnail.py 应存在");
});

test("P2-T6: pptx skill references 目录与 pptxgenjs-guide.md 存在", () => {
  const refsDir = path.join(pptxSkillDir, "references");
  assert.equal(fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory(), true, "pptx/references 目录应存在");
  assert.equal(fileExists("references/pptxgenjs-guide.md"), true, "pptx/references/pptxgenjs-guide.md 应存在");
});

// ============================================================================
// 测试组 2：frontmatter 格式
// ============================================================================

test("P2-T6: pptx skill frontmatter 格式正确", () => {
  const content = readPptxSkillMd();

  // frontmatter 起止标记
  assert.equal(content.startsWith("---"), true, "SKILL.md 应以 frontmatter 开头");

  // name 字段
  assert.equal(content.includes("name: pptx"), true, "应包含 name: pptx");

  // description 字段
  assert.equal(content.includes("description:"), true, "应包含 description 字段");

  // description 应包含 "Use when" 触发说明
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");

  // description 应明确提及 .pptx 扩展名
  assert.equal(content.includes(".pptx"), true, "description 应包含 .pptx 扩展名");
});

// ============================================================================
// 测试组 3：description 触发词
// ============================================================================

test("P2-T6: pptx skill description 包含关键触发词", () => {
  const content = readPptxSkillMd();

  // 触发词：.pptx, PowerPoint, slides, presentation
  const expectedTriggers = [".pptx", "PowerPoint", "slides", "presentation"];
  for (const trigger of expectedTriggers) {
    assert.equal(content.includes(trigger), true, `SKILL.md 应包含触发词: ${trigger}`);
  }
});

// ============================================================================
// 测试组 4：脚本文件可读且有内容
// ============================================================================

test("P2-T6: pptx scripts/add_slide.py 文件可读且有内容", () => {
  const content = readFile("scripts/add_slide.py");
  assert.equal(content.length > 0, true, "scripts/add_slide.py 应有内容");
  // Python 脚本应至少包含 def 或 import 关键字
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/add_slide.py 应包含 Python def 或 import 语句"
  );
});

test("P2-T6: pptx scripts/thumbnail.py 文件可读且有内容", () => {
  const content = readFile("scripts/thumbnail.py");
  assert.equal(content.length > 0, true, "scripts/thumbnail.py 应有内容");
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/thumbnail.py 应包含 Python def 或 import 语句"
  );
});

// ============================================================================
// 测试组 5：设计原则说明
// ============================================================================

test("P2-T6: pptx skill 包含设计原则章节", () => {
  const content = readPptxSkillMd();

  // 验证包含"设计原则"章节
  assert.equal(content.includes("设计原则"), true, "SKILL.md 应包含设计原则章节");

  // 设计原则中应包含 visual / 视觉 相关字眼
  assert.equal(content.includes("视觉") || content.includes("visual"), true, "设计原则应包含视觉相关说明");
});

test("P2-T6: pptx skill 包含颜色法则与布局法则", () => {
  const content = readPptxSkillMd();

  // 颜色法则：60-30-10 / 主色 60%
  assert.equal(
    content.includes("60-30-10") || content.includes("主色"),
    true,
    "SKILL.md 应包含颜色法则（60-30-10 或主色 60%）"
  );

  // 布局法则：每张幻灯片至少一个视觉元素
  assert.equal(content.includes("视觉元素"), true, "SKILL.md 应说明每张幻灯片至少一个视觉元素");
});

// ============================================================================
// 测试组 6：data/ 目录设计系统 CSV 数据
// ============================================================================

test("P2-T6: pptx skill 包含 data/ 目录及 5 个 CSV 设计数据文件", () => {
  const dataDir = path.join(pptxSkillDir, "data");
  assert.equal(fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory(), true, "pptx/data 目录应存在");

  // 5 个 CSV 设计数据文件
  const expectedCsvFiles = ["colors.csv", "typography.csv", "layouts.csv", "charts.csv", "icons.csv"];
  for (const csvFile of expectedCsvFiles) {
    assert.equal(fileExists(`data/${csvFile}`), true, `pptx/data/${csvFile} 应存在`);
  }
});

test("P2-T6: pptx skill SKILL.md 引用 data/ 目录 CSV 文件", () => {
  const content = readPptxSkillMd();

  // SKILL.md 应说明 data/ 目录及其用途
  assert.equal(content.includes("data/"), true, "SKILL.md 应引用 data/ 目录");
  // 应明确 colors.csv 配色方案库
  assert.equal(content.includes("colors.csv"), true, "SKILL.md 应引用 data/colors.csv");
});

// ============================================================================
// 测试组 7：references 目录引用正确
// ============================================================================

test("P2-T6: pptx skill SKILL.md 正确引用 references/pptxgenjs-guide.md", () => {
  const content = readPptxSkillMd();

  // SKILL.md 应在内容中引用 references/pptxgenjs-guide.md
  assert.equal(
    content.includes("references/pptxgenjs-guide.md"),
    true,
    "SKILL.md 应引用 references/pptxgenjs-guide.md"
  );
});

// ============================================================================
// 测试组 8：安全规则与验证清单
// ============================================================================

test("P2-T6: pptx skill 包含安全规则章节", () => {
  const content = readPptxSkillMd();

  // 验证包含"安全规则"章节
  assert.equal(content.includes("安全规则"), true, "SKILL.md 应包含安全规则章节");

  // 安全规则应包含绝对路径要求（避免目录遍历）
  assert.equal(content.includes("绝对路径"), true, "安全规则应要求 PptxGenJS 文件路径为绝对路径");
});

test("P2-T6: pptx skill 包含验证清单与脚本调用", () => {
  const content = readPptxSkillMd();

  // 验证清单
  assert.equal(content.includes("验证清单"), true, "SKILL.md 应包含验证清单章节");
  // 验证清单应包含 WCAG AA 对比度检查项
  assert.equal(content.includes("WCAG"), true, "验证清单应包含 WCAG AA 对比度检查项");

  // SKILL.md 应引用 scripts/add_slide.py 与 scripts/thumbnail.py
  assert.equal(content.includes("scripts/add_slide.py"), true, "SKILL.md 应引用 scripts/add_slide.py");
  assert.equal(content.includes("scripts/thumbnail.py"), true, "SKILL.md 应引用 scripts/thumbnail.py");
});
