/**
 * P2-T6：docx skill 单元测试
 *
 * 验证 docx skill 的：
 * 1. 文件存在性（SKILL.md + scripts/pack.py + scripts/unpack.py + scripts/comment.py + references/）
 * 2. frontmatter 格式（name: docx, description 含 "Use when" + ".docx"）
 * 3. description 含触发词（.docx, Word, document）
 * 4. 脚本文件可读（验证 scripts/*.py 文件存在且有内容，不执行 Python）
 * 5. 安全规则（SKILL.md 中包含 "安全" 相关字眼及 Author 字段规则）
 * 6. 关键 OOXML 模式（tracked changes / comments 标签）
 * 7. references 目录引用正确（python-docx-guide.md）
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
 * docx skill 目录绝对路径
 */
const docxSkillDir = path.join(repoRoot, "templates/skills/bundled/docx");

/**
 * 读取 docx skill 的 SKILL.md 内容
 * @returns SKILL.md 文件内容字符串
 */
function readDocxSkillMd(): string {
  const skillPath = path.join(docxSkillDir, "SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 检查指定相对路径下的文件是否存在
 * @param relativePath 相对于 docx skill 目录的路径
 * @returns 是否存在
 */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(docxSkillDir, relativePath));
}

/**
 * 读取指定相对路径文件内容
 * @param relativePath 相对于 docx skill 目录的路径
 * @returns 文件内容字符串
 */
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(docxSkillDir, relativePath), "utf-8");
}

// ============================================================================
// 测试组 1：文件存在性
// ============================================================================

test("P2-T6: docx skill 目录与 SKILL.md 存在", () => {
  assert.equal(fs.existsSync(docxSkillDir) && fs.statSync(docxSkillDir).isDirectory(), true, "docx skill 目录应存在");
  assert.equal(fileExists("SKILL.md"), true, "docx/SKILL.md 应存在");
});

test("P2-T6: docx skill 三个 Python 脚本文件存在", () => {
  // pack.py 与 unpack.py 是 unpack/pack 工作流的核心
  assert.equal(fileExists("scripts/pack.py"), true, "docx/scripts/pack.py 应存在");
  assert.equal(fileExists("scripts/unpack.py"), true, "docx/scripts/unpack.py 应存在");
  // comment.py 用于添加 Word 评论
  assert.equal(fileExists("scripts/comment.py"), true, "docx/scripts/comment.py 应存在");
});

test("P2-T6: docx skill references 目录与引用文件存在", () => {
  const refsDir = path.join(docxSkillDir, "references");
  assert.equal(fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory(), true, "docx/references 目录应存在");
  assert.equal(fileExists("references/python-docx-guide.md"), true, "docx/references/python-docx-guide.md 应存在");
});

// ============================================================================
// 测试组 2：frontmatter 格式
// ============================================================================

test("P2-T6: docx skill frontmatter 格式正确", () => {
  const content = readDocxSkillMd();

  // frontmatter 起止标记
  assert.equal(content.startsWith("---"), true, "SKILL.md 应以 frontmatter 开头");

  // name 字段
  assert.equal(content.includes("name: docx"), true, "应包含 name: docx");

  // description 字段
  assert.equal(content.includes("description:"), true, "应包含 description 字段");

  // description 应包含 "Use when" 触发说明
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");

  // description 应明确提及 .docx 扩展名
  assert.equal(content.includes(".docx"), true, "description 应包含 .docx 扩展名");
});

// ============================================================================
// 测试组 3：description 触发词
// ============================================================================

test("P2-T6: docx skill description 包含关键触发词", () => {
  const content = readDocxSkillMd();

  // 触发词：.docx, Word, document
  const expectedTriggers = [".docx", "Word", "document"];
  for (const trigger of expectedTriggers) {
    assert.equal(content.includes(trigger), true, `SKILL.md 应包含触发词: ${trigger}`);
  }
});

// ============================================================================
// 测试组 4：脚本文件可读且有内容
// ============================================================================

test("P2-T6: docx scripts/pack.py 文件可读且有内容", () => {
  const content = readFile("scripts/pack.py");
  assert.equal(content.length > 0, true, "scripts/pack.py 应有内容");
  // Python 脚本应至少包含 def 或 import 关键字
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/pack.py 应包含 Python def 或 import 语句"
  );
});

test("P2-T6: docx scripts/unpack.py 文件可读且有内容", () => {
  const content = readFile("scripts/unpack.py");
  assert.equal(content.length > 0, true, "scripts/unpack.py 应有内容");
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/unpack.py 应包含 Python def 或 import 语句"
  );
});

test("P2-T6: docx scripts/comment.py 文件可读且有内容", () => {
  const content = readFile("scripts/comment.py");
  assert.equal(content.length > 0, true, "scripts/comment.py 应有内容");
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/comment.py 应包含 Python def 或 import 语句"
  );
});

// ============================================================================
// 测试组 5：安全规则
// ============================================================================

test("P2-T6: docx skill 包含安全规则章节", () => {
  const content = readDocxSkillMd();

  // 验证包含"安全规则"章节标题
  assert.equal(content.includes("安全规则"), true, "SKILL.md 应包含安全规则章节");
});

test("P2-T6: docx skill 规定 Author 字段使用 'AI Assistant'", () => {
  const content = readDocxSkillMd();

  // 验证 tracked changes / comments 的 Author 字段规则
  assert.equal(content.includes("AI Assistant"), true, "SKILL.md 应规定 Author 字段使用 'AI Assistant'");
  assert.equal(content.includes("Author"), true, "SKILL.md 应明确提及 Author 字段");
});

// ============================================================================
// 测试组 6：关键 OOXML 模式
// ============================================================================

test("P2-T6: docx skill 包含 tracked changes 的 OOXML 标签", () => {
  const content = readDocxSkillMd();

  // 验证 tracked changes 标签 <w:ins> / <w:del>
  assert.equal(content.includes("<w:ins>"), true, "SKILL.md 应包含 <w:ins> 标签示例");
  assert.equal(content.includes("<w:del>"), true, "SKILL.md 应包含 <w:del> 标签示例");
  // 删除文本必须使用 <w:delText>
  assert.equal(content.includes("<w:delText>"), true, "SKILL.md 应说明删除文本使用 <w:delText>");
});

test("P2-T6: docx skill 包含 comments 的 OOXML 标签", () => {
  const content = readDocxSkillMd();

  // 验证 comments 标签 <w:commentRangeStart> / <w:commentRangeEnd>
  assert.equal(content.includes("<w:commentRangeStart>"), true, "SKILL.md 应包含 <w:commentRangeStart> 标签");
  assert.equal(content.includes("<w:commentRangeEnd>"), true, "SKILL.md 应包含 <w:commentRangeEnd> 标签");
});

// ============================================================================
// 测试组 7：references 目录引用正确
// ============================================================================

test("P2-T6: docx skill SKILL.md 正确引用 references/python-docx-guide.md", () => {
  const content = readDocxSkillMd();

  // SKILL.md 应在内容中引用 references/python-docx-guide.md
  assert.equal(
    content.includes("references/python-docx-guide.md"),
    true,
    "SKILL.md 应引用 references/python-docx-guide.md"
  );
});

// ============================================================================
// 测试组 8：验证清单与工作流
// ============================================================================

test("P2-T6: docx skill 包含验证清单", () => {
  const content = readDocxSkillMd();

  assert.equal(content.includes("验证清单"), true, "SKILL.md 应包含验证清单章节");
  // 验证清单中应包含 .docx 文件可正常打开的检查项
  assert.equal(
    content.includes("可在 Word") || content.includes("LibreOffice 正常打开"),
    true,
    "验证清单应包含 .docx 文件可在 Word/LibreOffice 正常打开检查项"
  );
});

test("P2-T6: docx skill 包含 unpack/pack 工作流示例", () => {
  const content = readDocxSkillMd();

  // 验证 unpack/pack 工作流命令示例
  assert.equal(content.includes("scripts/unpack.py"), true, "SKILL.md 应引用 scripts/unpack.py");
  assert.equal(content.includes("scripts/pack.py"), true, "SKILL.md 应引用 scripts/pack.py");
  assert.equal(content.includes("scripts/comment.py"), true, "SKILL.md 应引用 scripts/comment.py");
});
