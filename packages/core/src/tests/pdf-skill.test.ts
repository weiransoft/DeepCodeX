/**
 * P2-T6：pdf skill 单元测试
 *
 * 验证 pdf skill 的：
 * 1. 文件存在性（SKILL.md + scripts/extract_pages.py + references/）
 * 2. frontmatter 格式（name: pdf, description 含 "Use when" + ".pdf"）
 * 3. description 含触发词（.pdf, PDF, extract, merge, OCR）
 * 4. 脚本文件存在且有内容（不执行 Python）
 * 5. 推荐工具说明（pdfplumber / pypdf / reportlab / pytesseract）
 * 6. 安全规则与 CJK 字体跨平台策略
 * 7. references 目录引用正确（pdf-libraries.md）
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
 * pdf skill 目录绝对路径
 */
const pdfSkillDir = path.join(repoRoot, "templates/skills/bundled/pdf");

/**
 * 读取 pdf skill 的 SKILL.md 内容
 * @returns SKILL.md 文件内容字符串
 */
function readPdfSkillMd(): string {
  const skillPath = path.join(pdfSkillDir, "SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 检查指定相对路径下的文件是否存在
 * @param relativePath 相对于 pdf skill 目录的路径
 * @returns 是否存在
 */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(pdfSkillDir, relativePath));
}

/**
 * 读取指定相对路径文件内容
 * @param relativePath 相对于 pdf skill 目录的路径
 * @returns 文件内容字符串
 */
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(pdfSkillDir, relativePath), "utf-8");
}

// ============================================================================
// 测试组 1：文件存在性
// ============================================================================

test("P2-T6: pdf skill 目录与 SKILL.md 存在", () => {
  assert.equal(fs.existsSync(pdfSkillDir) && fs.statSync(pdfSkillDir).isDirectory(), true, "pdf skill 目录应存在");
  assert.equal(fileExists("SKILL.md"), true, "pdf/SKILL.md 应存在");
});

test("P2-T6: pdf skill scripts/extract_pages.py 存在", () => {
  // extract_pages.py 是本 skill 的核心脚本，提取指定页面文本
  assert.equal(fileExists("scripts/extract_pages.py"), true, "pdf/scripts/extract_pages.py 应存在");
});

test("P2-T6: pdf skill references 目录与 pdf-libraries.md 存在", () => {
  const refsDir = path.join(pdfSkillDir, "references");
  assert.equal(fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory(), true, "pdf/references 目录应存在");
  assert.equal(fileExists("references/pdf-libraries.md"), true, "pdf/references/pdf-libraries.md 应存在");
});

// ============================================================================
// 测试组 2：frontmatter 格式
// ============================================================================

test("P2-T6: pdf skill frontmatter 格式正确", () => {
  const content = readPdfSkillMd();

  // frontmatter 起止标记
  assert.equal(content.startsWith("---"), true, "SKILL.md 应以 frontmatter 开头");

  // name 字段
  assert.equal(content.includes("name: pdf"), true, "应包含 name: pdf");

  // description 字段
  assert.equal(content.includes("description:"), true, "应包含 description 字段");

  // description 应包含 "Use when" 触发说明
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");

  // description 应明确提及 .pdf 扩展名
  assert.equal(content.includes(".pdf"), true, "description 应包含 .pdf 扩展名");
});

// ============================================================================
// 测试组 3：description 触发词
// ============================================================================

test("P2-T6: pdf skill description 包含关键触发词", () => {
  const content = readPdfSkillMd();

  // 触发词：.pdf, PDF, extract, merge, OCR
  const expectedTriggers = [".pdf", "PDF", "extract", "merge", "OCR"];
  for (const trigger of expectedTriggers) {
    assert.equal(content.includes(trigger), true, `SKILL.md 应包含触发词: ${trigger}`);
  }
});

// ============================================================================
// 测试组 4：脚本文件可读且有内容
// ============================================================================

test("P2-T6: pdf scripts/extract_pages.py 文件可读且有内容", () => {
  const content = readFile("scripts/extract_pages.py");
  assert.equal(content.length > 0, true, "scripts/extract_pages.py 应有内容");
  // Python 脚本应至少包含 def 或 import 关键字
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/extract_pages.py 应包含 Python def 或 import 语句"
  );
});

// ============================================================================
// 测试组 5：推荐工具说明
// ============================================================================

test("P2-T6: pdf skill 包含 4 大推荐 Python 库", () => {
  const content = readPdfSkillMd();

  // 四大核心库：pdfplumber / pypdf / reportlab / pytesseract
  const expectedLibraries = ["pdfplumber", "pypdf", "reportlab", "pytesseract"];
  for (const lib of expectedLibraries) {
    assert.equal(content.includes(lib), true, `SKILL.md 应推荐使用 ${lib}`);
  }
});

test("P2-T6: pdf skill 包含命令行工具说明", () => {
  const content = readPdfSkillMd();

  // 命令行工具：qpdf（合并/拆分）与 pdftotext（提取文本）
  assert.equal(content.includes("qpdf"), true, "SKILL.md 应说明 qpdf 命令行工具");
  assert.equal(content.includes("pdftotext"), true, "SKILL.md 应说明 pdftotext 命令行工具");
});

// ============================================================================
// 测试组 6：安全规则与 CJK 字体策略
// ============================================================================

test("P2-T6: pdf skill 包含安全规则章节", () => {
  const content = readPdfSkillMd();

  // 验证包含"安全规则"章节
  assert.equal(content.includes("安全规则"), true, "SKILL.md 应包含安全规则章节");

  // 不可信 PDF 来源应使用 pypdf 而非 pdfplumber
  assert.equal(
    content.includes("pypdf") && content.includes("不可信"),
    true,
    "安全规则应说明不可信 PDF 来源使用 pypdf 而非 pdfplumber"
  );
});

test("P2-T6: pdf skill 包含 CJK 字体跨平台策略", () => {
  const content = readPdfSkillMd();

  // CJK 字体跨平台策略
  assert.equal(content.includes("CJK 字体") || content.includes("CJK"), true, "SKILL.md 应包含 CJK 字体跨平台策略");

  // 三大平台字体路径
  assert.equal(content.includes("macOS"), true, "SKILL.md 应包含 macOS 字体路径");
  assert.equal(content.includes("Windows"), true, "SKILL.md 应包含 Windows 字体路径");
  assert.equal(content.includes("Linux"), true, "SKILL.md 应包含 Linux 字体路径");
});

// ============================================================================
// 测试组 7：references 目录引用正确
// ============================================================================

test("P2-T6: pdf skill SKILL.md 正确引用 references/pdf-libraries.md", () => {
  const content = readPdfSkillMd();

  // SKILL.md 应在内容中引用 references/pdf-libraries.md
  assert.equal(content.includes("references/pdf-libraries.md"), true, "SKILL.md 应引用 references/pdf-libraries.md");
});

// ============================================================================
// 测试组 8：验证清单与脚本调用
// ============================================================================

test("P2-T6: pdf skill 包含验证清单", () => {
  const content = readPdfSkillMd();

  assert.equal(content.includes("验证清单"), true, "SKILL.md 应包含验证清单章节");
  // 验证清单中应包含表格列对齐与 CJK 字符检查项
  assert.equal(content.includes("列对齐") || content.includes("无错列"), true, "验证清单应包含表格列对齐检查项");
  assert.equal(
    content.includes("CJK 字符无方框乱码") || content.includes("方框乱码"),
    true,
    "验证清单应包含 CJK 字符无方框乱码检查项"
  );
});

test("P2-T6: pdf skill SKILL.md 引用 scripts/extract_pages.py", () => {
  const content = readPdfSkillMd();

  // SKILL.md 应在内容中引用 scripts/extract_pages.py 脚本
  assert.equal(content.includes("scripts/extract_pages.py"), true, "SKILL.md 应引用 scripts/extract_pages.py");
});
