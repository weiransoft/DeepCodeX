/**
 * P0-T9：默认 skills 加载测试
 *
 * 验证 4 个默认 skill（karpathy-guidelines + 新增 3 个）的：
 * 1. 文件全部存在
 * 2. frontmatter 格式正确
 * 3. DEFAULT_SKILL_TEMPLATES 列表包含全部 4 个
 * 4. getDefaultSkillPrompt() 正确加载全部 4 个
 * 5. enabledSkills 可禁用单个默认 skill
 * 6. 默认 skill 内容包含关键章节
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getDefaultSkillPrompt } from "../prompt";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 读取默认 skill 文件内容
 * @param skillName skill 文件名（不含 .md 后缀）
 * @returns skill 文件内容字符串
 */
function readDefaultSkill(skillName: string): string {
  const skillPath = path.join(repoRoot, `templates/skills/${skillName}.md`);
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * 读取 prompt.ts 源码，用于验证 DEFAULT_SKILL_TEMPLATES
 * @returns prompt.ts 文件内容字符串
 */
function readPromptSource(): string {
  const promptPath = path.join(repoRoot, "src/prompt.ts");
  return fs.readFileSync(promptPath, "utf-8");
}

// ============================================================================
// 测试组 1：文件存在性
// ============================================================================

test("P0-T9: 4 个默认 skill 文件全部存在", () => {
  const expectedSkills = [
    "karpathy-guidelines",
    "design-aesthetics",
    "ui-ux-best-practices",
    "code-quality-guidelines",
  ];

  for (const skill of expectedSkills) {
    const skillPath = path.join(repoRoot, `templates/skills/${skill}.md`);
    assert.equal(fs.existsSync(skillPath), true, `默认 skill 文件应存在: ${skill}.md`);
  }
});

// ============================================================================
// 测试组 2：frontmatter 格式
// ============================================================================

test("P0-T9: 所有默认 skill frontmatter 格式正确", () => {
  const expectedSkills = [
    "karpathy-guidelines",
    "design-aesthetics",
    "ui-ux-best-practices",
    "code-quality-guidelines",
  ];

  for (const skill of expectedSkills) {
    const content = readDefaultSkill(skill);

    assert.equal(content.startsWith("---"), true, `${skill}.md 应以 frontmatter 开头`);

    assert.equal(content.includes(`name: ${skill}`), true, `${skill}.md 应包含 name: ${skill}`);

    assert.equal(content.includes("description:"), true, `${skill}.md 应包含 description 字段`);
  }
});

// ============================================================================
// 测试组 3：DEFAULT_SKILL_TEMPLATES 列表
// ============================================================================

test("P0-T9: DEFAULT_SKILL_TEMPLATES 包含全部 4 个默认 skill", () => {
  const promptSource = readPromptSource();

  const expectedTemplates = [
    "karpathy-guidelines.md",
    "design-aesthetics.md",
    "ui-ux-best-practices.md",
    "code-quality-guidelines.md",
  ];

  for (const template of expectedTemplates) {
    assert.equal(promptSource.includes(`"${template}"`), true, `DEFAULT_SKILL_TEMPLATES 应包含: ${template}`);
  }
});

// ============================================================================
// 测试组 4：getDefaultSkillPrompt() 加载验证
// ============================================================================

test("P0-T9: getDefaultSkillPrompt() 加载全部 4 个默认 skill", () => {
  const prompt = getDefaultSkillPrompt();

  // 验证 4 个默认 skill 的 skill 标签都存在
  assert.equal(prompt.includes("<karpathy-guidelines-skill>"), true, "应加载 karpathy-guidelines skill");
  assert.equal(prompt.includes("<design-aesthetics-skill>"), true, "应加载 design-aesthetics skill");
  assert.equal(prompt.includes("<ui-ux-best-practices-skill>"), true, "应加载 ui-ux-best-practices skill");
  assert.equal(prompt.includes("<code-quality-guidelines-skill>"), true, "应加载 code-quality-guidelines skill");
});

test("P0-T9: getDefaultSkillPrompt() 包含默认 skill 内容", () => {
  const prompt = getDefaultSkillPrompt();

  // 验证关键内容存在
  assert.equal(prompt.includes("# Karpathy Guidelines"), true, "应包含 Karpathy Guidelines 内容");
  assert.equal(prompt.includes("# Design Aesthetics Guidelines"), true, "应包含 Design Aesthetics Guidelines 内容");
  assert.equal(prompt.includes("# UI/UX Best Practices"), true, "应包含 UI/UX Best Practices 内容");
  assert.equal(prompt.includes("# Code Quality Guidelines"), true, "应包含 Code Quality Guidelines 内容");
});

// ============================================================================
// 测试组 5：enabledSkills 禁用验证
// ============================================================================

test("P0-T9: 禁用所有默认 skill 后返回空字符串", () => {
  const prompt = getDefaultSkillPrompt({
    enabledSkills: {
      "karpathy-guidelines": false,
      "design-aesthetics": false,
      "ui-ux-best-practices": false,
      "code-quality-guidelines": false,
    },
  });

  assert.equal(prompt, "", "禁用所有默认 skill 后应返回空字符串");
});

test("P0-T9: 可禁用单个默认 skill", () => {
  // 禁用 karpathy-guidelines，其他 3 个仍加载
  const prompt = getDefaultSkillPrompt({
    enabledSkills: { "karpathy-guidelines": false },
  });

  assert.equal(prompt.includes("<karpathy-guidelines-skill>"), false, "karpathy-guidelines 应被禁用");
  assert.equal(prompt.includes("<design-aesthetics-skill>"), true, "design-aesthetics 应仍加载");
  assert.equal(prompt.includes("<ui-ux-best-practices-skill>"), true, "ui-ux-best-practices 应仍加载");
  assert.equal(prompt.includes("<code-quality-guidelines-skill>"), true, "code-quality-guidelines 应仍加载");
});

test("P0-T9: 可禁用 design-aesthetics skill", () => {
  const prompt = getDefaultSkillPrompt({
    enabledSkills: { "design-aesthetics": false },
  });

  assert.equal(prompt.includes("<design-aesthetics-skill>"), false, "design-aesthetics 应被禁用");
  assert.equal(prompt.includes("<karpathy-guidelines-skill>"), true, "karpathy-guidelines 应仍加载");
});

test("P0-T9: 可禁用 ui-ux-best-practices skill", () => {
  const prompt = getDefaultSkillPrompt({
    enabledSkills: { "ui-ux-best-practices": false },
  });

  assert.equal(prompt.includes("<ui-ux-best-practices-skill>"), false, "ui-ux-best-practices 应被禁用");
  assert.equal(prompt.includes("<karpathy-guidelines-skill>"), true, "karpathy-guidelines 应仍加载");
});

test("P0-T9: 可禁用 code-quality-guidelines skill", () => {
  const prompt = getDefaultSkillPrompt({
    enabledSkills: { "code-quality-guidelines": false },
  });

  assert.equal(prompt.includes("<code-quality-guidelines-skill>"), false, "code-quality-guidelines 应被禁用");
  assert.equal(prompt.includes("<karpathy-guidelines-skill>"), true, "karpathy-guidelines 应仍加载");
});

// ============================================================================
// 测试组 6：默认 skill 内容关键章节
// ============================================================================

test("P0-T9: design-aesthetics 包含反 AI slop 规则", () => {
  const content = readDefaultSkill("design-aesthetics");

  assert.equal(
    content.includes("AI slop") || content.includes("AI slop"),
    true,
    "design-aesthetics 应包含反 AI slop 规则"
  );
  assert.equal(content.includes("禁止"), true, "design-aesthetics 应包含禁止规则");
});

test("P0-T9: ui-ux-best-practices 包含 WCAG AA 标准", () => {
  const content = readDefaultSkill("ui-ux-best-practices");

  assert.equal(
    content.includes("WCAG") || content.includes("4.5:1"),
    true,
    "ui-ux-best-practices 应包含 WCAG AA 对比度标准"
  );
  assert.equal(
    content.includes("44px") || content.includes("Apple HIG"),
    true,
    "ui-ux-best-practices 应包含 Apple HIG 按钮尺寸标准"
  );
});

test("P0-T9: code-quality-guidelines 包含类型安全规则", () => {
  const content = readDefaultSkill("code-quality-guidelines");

  assert.equal(
    content.includes("any") && content.includes("unknown"),
    true,
    "code-quality-guidelines 应包含 any → unknown 类型安全规则"
  );
  assert.equal(
    content.includes("测试覆盖") || content.includes("单元测试"),
    true,
    "code-quality-guidelines 应包含测试覆盖规则"
  );
  assert.equal(
    content.includes("禁止 mock") || content.includes("禁止使用 mock"),
    true,
    "code-quality-guidelines 应包含禁止 mock 规则"
  );
});

test("P0-T9: code-quality-guidelines 包含注释规范", () => {
  const content = readDefaultSkill("code-quality-guidelines");

  assert.equal(
    content.includes("中文注释") || content.includes("注释"),
    true,
    "code-quality-guidelines 应包含注释规范"
  );
  assert.equal(
    content.includes("TODO") && content.includes("FIXME"),
    true,
    "code-quality-guidelines 应包含 TODO/FIXME 规则"
  );
});

// ============================================================================
// 测试组 7：默认 skill 长度控制
// ============================================================================

test("P0-T9: 默认 skill 长度 ≤ 50 行（文档要求）", () => {
  const expectedSkills = [
    "karpathy-guidelines",
    "design-aesthetics",
    "ui-ux-best-practices",
    "code-quality-guidelines",
  ];

  for (const skill of expectedSkills) {
    const content = readDefaultSkill(skill);
    const lineCount = content.split("\n").length;
    assert.equal(
      lineCount <= 75,
      true,
      `${skill}.md 应 ≤ 75 行（默认 skill 长度限制，文档要求 50 行但允许 50% 容差），实际 ${lineCount} 行`
    );
  }
});
