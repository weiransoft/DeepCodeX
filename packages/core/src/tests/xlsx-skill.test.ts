/**
 * P2-T6：xlsx skill 单元测试
 *
 * 验证 xlsx skill 的：
 * 1. 文件存在性（SKILL.md + scripts/recalc.py + references/）
 * 2. frontmatter 格式（name: xlsx, description 含 "Use when" + ".xlsx"）
 * 3. description 含触发词（.xlsx, Excel, spreadsheet, formula）
 * 4. 脚本文件存在且有内容（不执行 Python）
 * 5. 关键规则验证（重点）：
 *    - 公式优先规则
 *    - 颜色编码说明（蓝色/黑色/绿色/红色文本 + 黄色背景）
 *    - LibreOffice 重算说明
 * 6. references 目录引用正确（financial-modeling.md）
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
 * xlsx skill 目录绝对路径
 */
const xlsxSkillDir = path.join(repoRoot, "templates/skills/bundled/xlsx");

/**
 * 读取 xlsx skill 的 SKILL.md 内容
 * @returns SKILL.md 文件内容字符串
 */
function readXlsxSkillMd(): string {
  const skillPath = path.join(xlsxSkillDir, "SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 检查指定相对路径下的文件是否存在
 * @param relativePath 相对于 xlsx skill 目录的路径
 * @returns 是否存在
 */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(xlsxSkillDir, relativePath));
}

/**
 * 读取指定相对路径文件内容
 * @param relativePath 相对于 xlsx skill 目录的路径
 * @returns 文件内容字符串
 */
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(xlsxSkillDir, relativePath), "utf-8");
}

// ============================================================================
// 测试组 1：文件存在性
// ============================================================================

test("P2-T6: xlsx skill 目录与 SKILL.md 存在", () => {
  assert.equal(fs.existsSync(xlsxSkillDir) && fs.statSync(xlsxSkillDir).isDirectory(), true, "xlsx skill 目录应存在");
  assert.equal(fileExists("SKILL.md"), true, "xlsx/SKILL.md 应存在");
});

test("P2-T6: xlsx skill scripts/recalc.py 存在", () => {
  // recalc.py 是公式重算的核心脚本
  assert.equal(fileExists("scripts/recalc.py"), true, "xlsx/scripts/recalc.py 应存在");
});

test("P2-T6: xlsx skill references 目录与 financial-modeling.md 存在", () => {
  const refsDir = path.join(xlsxSkillDir, "references");
  assert.equal(fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory(), true, "xlsx/references 目录应存在");
  assert.equal(fileExists("references/financial-modeling.md"), true, "xlsx/references/financial-modeling.md 应存在");
});

// ============================================================================
// 测试组 2：frontmatter 格式
// ============================================================================

test("P2-T6: xlsx skill frontmatter 格式正确", () => {
  const content = readXlsxSkillMd();

  // frontmatter 起止标记
  assert.equal(content.startsWith("---"), true, "SKILL.md 应以 frontmatter 开头");

  // name 字段
  assert.equal(content.includes("name: xlsx"), true, "应包含 name: xlsx");

  // description 字段
  assert.equal(content.includes("description:"), true, "应包含 description 字段");

  // description 应包含 "Use when" 触发说明
  assert.equal(content.includes("Use when"), true, "description 应包含 'Use when' 触发说明");

  // description 应明确提及 .xlsx 扩展名
  assert.equal(content.includes(".xlsx"), true, "description 应包含 .xlsx 扩展名");
});

// ============================================================================
// 测试组 3：description 触发词
// ============================================================================

test("P2-T6: xlsx skill description 包含关键触发词", () => {
  const content = readXlsxSkillMd();

  // 触发词：.xlsx, Excel, spreadsheet, formula
  const expectedTriggers = [".xlsx", "Excel", "spreadsheet", "formula"];
  for (const trigger of expectedTriggers) {
    assert.equal(content.includes(trigger), true, `SKILL.md 应包含触发词: ${trigger}`);
  }
});

// ============================================================================
// 测试组 4：脚本文件可读且有内容
// ============================================================================

test("P2-T6: xlsx scripts/recalc.py 文件可读且有内容", () => {
  const content = readFile("scripts/recalc.py");
  assert.equal(content.length > 0, true, "scripts/recalc.py 应有内容");
  // Python 脚本应至少包含 def 或 import 关键字
  assert.equal(
    content.includes("def") || content.includes("import"),
    true,
    "scripts/recalc.py 应包含 Python def 或 import 语句"
  );
});

// ============================================================================
// 测试组 5：关键规则 - 公式优先（CRITICAL）
// ============================================================================

test("P2-T6: xlsx skill 包含公式优先规则", () => {
  const content = readXlsxSkillMd();

  // 验证包含"公式优先"规则
  assert.equal(content.includes("公式优先"), true, "SKILL.md 应包含公式优先规则章节");

  // 验证包含 CRITICAL 标记
  assert.equal(content.includes("CRITICAL"), true, "公式优先规则应标记为 CRITICAL");

  // 验证禁止硬编码值的规则
  assert.equal(content.includes("硬编码"), true, "SKILL.md 应明确禁止硬编码值");
});

// ============================================================================
// 测试组 6：关键规则 - 颜色编码（财务模型）
// ============================================================================

test("P2-T6: xlsx skill 包含完整颜色编码说明（5 种颜色）", () => {
  const content = readXlsxSkillMd();

  // 验证包含"颜色编码"章节
  assert.equal(content.includes("颜色编码"), true, "SKILL.md 应包含颜色编码章节");

  // 5 种颜色：蓝色/黑色/绿色/红色文本 + 黄色背景
  const expectedColors = [
    { keyword: "蓝色", description: "硬编码输入值" },
    { keyword: "黑色", description: "公式与计算" },
    { keyword: "绿色", description: "同工作簿跨表引用" },
    { keyword: "红色", description: "外部文件引用" },
    { keyword: "黄色", description: "关键假设（背景色）" },
  ];
  for (const { keyword, description } of expectedColors) {
    assert.equal(content.includes(keyword), true, `SKILL.md 颜色编码应包含: ${description}（关键词: ${keyword}）`);
  }
});

test("P2-T6: xlsx skill 颜色编码区分文本色与背景色", () => {
  const content = readXlsxSkillMd();

  // 验证区分文本颜色（蓝色/黑色/绿色/红色）与背景色（黄色）
  assert.equal(content.includes("文本"), true, "颜色编码应说明文本颜色");
  assert.equal(content.includes("背景"), true, "颜色编码应说明背景颜色（黄色关键假设）");
});

// ============================================================================
// 测试组 7：关键规则 - LibreOffice 重算
// ============================================================================

test("P2-T6: xlsx skill 包含 LibreOffice 重算说明", () => {
  const content = readXlsxSkillMd();

  // 验证包含 LibreOffice 重算说明
  assert.equal(content.includes("LibreOffice"), true, "SKILL.md 应说明使用 LibreOffice 进行公式重算");

  // 验证 openpyxl 保存后公式为字符串，需重算
  assert.equal(
    content.includes("公式为字符串") || content.includes("不含计算结果"),
    true,
    "SKILL.md 应说明 openpyxl 保存后公式不含计算结果，必须重算"
  );

  // 验证 recalc.py 脚本调用示例
  assert.equal(content.includes("scripts/recalc.py"), true, "SKILL.md 应提供 scripts/recalc.py 调用示例");
});

test("P2-T6: xlsx skill recalc.py 返回 JSON 错误扫描结果", () => {
  const content = readXlsxSkillMd();

  // 验证 recalc.py 返回 JSON 格式结果
  assert.equal(
    content.includes("status") && content.includes("total_errors"),
    true,
    "SKILL.md 应说明 recalc.py 返回 JSON 结果（status + total_errors）"
  );

  // 验证扫描 Excel 错误（#REF!, #DIV/0! 等）
  assert.equal(content.includes("#REF!"), true, "SKILL.md 应说明扫描 #REF! 错误");
});

// ============================================================================
// 测试组 8：references 目录引用正确
// ============================================================================

test("P2-T6: xlsx skill SKILL.md 正确引用 references/financial-modeling.md", () => {
  const content = readXlsxSkillMd();

  // SKILL.md 应在内容中引用 references/financial-modeling.md
  assert.equal(
    content.includes("references/financial-modeling.md"),
    true,
    "SKILL.md 应引用 references/financial-modeling.md"
  );
});

// ============================================================================
// 测试组 9：安全规则与验证清单
// ============================================================================

test("P2-T6: xlsx skill 包含安全规则章节", () => {
  const content = readXlsxSkillMd();

  // 验证包含"安全规则"章节
  assert.equal(content.includes("安全规则"), true, "SKILL.md 应包含安全规则章节");

  // 验证 data_only=True 读取后禁止保存的规则
  assert.equal(content.includes("data_only"), true, "安全规则应说明 data_only=True 读取后禁止保存");
});

test("P2-T6: xlsx skill 包含验证清单与假设分离规则", () => {
  const content = readXlsxSkillMd();

  // 验证清单
  assert.equal(content.includes("验证清单"), true, "SKILL.md 应包含验证清单章节");

  // 假设分离规则
  assert.equal(content.includes("假设分离") || content.includes("假设独立"), true, "SKILL.md 应包含假设分离规则");

  // 验证清单应包含公式无错误检查项
  assert.equal(
    content.includes("无错误") || content.includes("status: success"),
    true,
    "验证清单应包含公式重算后无错误检查项"
  );
});
