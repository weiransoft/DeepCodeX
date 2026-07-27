/**
 * SkillManager 单元测试
 *
 * 验证 A3.1 改进（2026-07-27）：扩展 getSkillScanRoots 扫描 ~/.trae-cn/builtin_skills
 * 关联事件：docs/code-review-process-incident.md
 *
 * 测试覆盖：
 *   - getSkillScanRoots 返回 6 个根（之前 5 个）
 *   - 第 5 个根为 ~/.trae-cn/builtin_skills
 *   - 优先级正确：项目级 ./deepcode/skills 覆盖 ~/.trae-cn/builtin_skills
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillManager } from "../skill-manager";

// ============================================================================
// 测试 fixture
// ============================================================================

/**
 * 创建测试用 SkillManager 实例
 *
 * @param projectRoot 项目根目录
 */
function createTestSkillManager(projectRoot: string): SkillManager {
  return new SkillManager({
    projectRoot,
    getResolvedSettings: () => ({}),
    listSessionMessages: () => [],
  });
}

// ============================================================================
// getSkillScanRoots 测试
// ============================================================================

test("getSkillScanRoots 返回 6 个根（A3.1 改进：新增 ~/.trae-cn/builtin_skills）", () => {
  const manager = createTestSkillManager("/tmp/test-project");
  const roots = manager.getSkillScanRoots();

  // 之前 5 个根，A3.1 新增 1 个根，共 6 个
  assert.equal(roots.length, 6);
});

test("getSkillScanRoots 第 5 个根为 ~/.trae-cn/builtin_skills（A3.1）", () => {
  const manager = createTestSkillManager("/tmp/test-project");
  const roots = manager.getSkillScanRoots();
  const homeDir = os.homedir();

  // 索引 4（第 5 个）应该是 ~/.trae-cn/builtin_skills
  const traeRoot = roots[4];
  assert.ok(traeRoot);
  assert.equal(traeRoot.root, path.join(homeDir, ".trae-cn", "builtin_skills"));
  assert.equal(traeRoot.displayRoot, "~/.trae-cn/builtin_skills");
});

test("getSkillScanRoots 优先级：项目级 ./.deepcode/skills 排在 ~/.trae-cn/builtin_skills 之前", () => {
  const manager = createTestSkillManager("/tmp/test-project");
  const roots = manager.getSkillScanRoots();

  // 找到项目级 ./.deepcode/skills 和 ~/.trae-cn/builtin_skills 的索引
  const projectDeepcodeIdx = roots.findIndex((r) => r.displayRoot === "./.deepcode/skills");
  const traeIdx = roots.findIndex((r) => r.displayRoot === "~/.trae-cn/builtin_skills");

  assert.notEqual(projectDeepcodeIdx, -1);
  assert.notEqual(traeIdx, -1);
  assert.equal(projectDeepcodeIdx < traeIdx, true);
});

test("getSkillScanRoots 优先级：~/.trae-cn/builtin_skills 排在 bundled: 之前", () => {
  const manager = createTestSkillManager("/tmp/test-project");
  const roots = manager.getSkillScanRoots();

  // 找到 ~/.trae-cn/builtin_skills 和 bundled: 的索引
  const traeIdx = roots.findIndex((r) => r.displayRoot === "~/.trae-cn/builtin_skills");
  const bundledIdx = roots.findIndex((r) => r.displayRoot === "bundled:");

  assert.notEqual(traeIdx, -1);
  assert.notEqual(bundledIdx, -1);
  assert.equal(traeIdx < bundledIdx, true);
});

test("getSkillScanRoots 包含完整的 6 个 displayRoot 标识", () => {
  const manager = createTestSkillManager("/tmp/test-project");
  const roots = manager.getSkillScanRoots();
  const displayRoots = roots.map((r) => r.displayRoot);

  // 验证 6 个根的 displayRoot 完整性
  assert.deepEqual(displayRoots, [
    "./.deepcode/skills",
    "./.agents/skills",
    "~/.deepcode/skills",
    "~/.agents/skills",
    "~/.trae-cn/builtin_skills",
    "bundled:",
  ]);
});

// ============================================================================
// listSkills 集成测试（在临时目录中真实创建 skill）
// ============================================================================

test("listSkills 能扫描到 ~/.trae-cn/builtin_skills 下的 skill（A3.1）", async () => {
  // 创建临时目录模拟 home 与项目根
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-skill-test-home-"));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-skill-test-project-"));

  // 在临时 home 下创建 .trae-cn/builtin_skills/TRAE-code-review/SKILL.md
  const traeSkillDir = path.join(tmpHome, ".trae-cn", "builtin_skills", "TRAE-code-review");
  fs.mkdirSync(traeSkillDir, { recursive: true });
  const traeSkillContent = `---
name: TRAE-code-review
description: Test code review skill
---
# TRAE Code Review Skill
Test content
`;
  fs.writeFileSync(path.join(traeSkillDir, "SKILL.md"), traeSkillContent, "utf8");

  // ESM 模块绑定只读，无法直接覆盖 os.homedir；
  // 改用 process.env.HOME 控制 os.homedir() 返回值（macOS/Linux POSIX 行为）
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const manager = createTestSkillManager(tmpProject);
    const skills = await manager.listSkills();

    // 验证扫描到了 TRAE-code-review skill
    const traeSkill = skills.find((s) => s.name === "TRAE-code-review");
    assert.ok(traeSkill, "未扫描到 ~/.trae-cn/builtin_skills/TRAE-code-review skill");
    assert.equal(traeSkill?.description, "Test code review skill");
  } finally {
    // 恢复 process.env.HOME
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    // 清理临时目录
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test("listSkills 优先级：项目级 ./.deepcode/skills 覆盖 ~/.trae-cn/builtin_skills（A3.1）", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-skill-prio-home-"));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-skill-prio-project-"));

  // 在 ~/.trae-cn/builtin_skills/ 下创建同名 skill
  const traeSkillDir = path.join(tmpHome, ".trae-cn", "builtin_skills", "shared-skill");
  fs.mkdirSync(traeSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(traeSkillDir, "SKILL.md"),
    `---
name: shared-skill
description: Trae version
---
# Trae Version
`,
    "utf8"
  );

  // 在项目级 ./.deepcode/skills/ 下创建同名 skill（应优先）
  const projectSkillDir = path.join(tmpProject, ".deepcode", "skills", "shared-skill");
  fs.mkdirSync(projectSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSkillDir, "SKILL.md"),
    `---
name: shared-skill
description: Project version (higher priority)
---
# Project Version
`,
    "utf8"
  );

  // ESM 模块绑定只读，改用 process.env.HOME 控制 os.homedir() 返回值
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const manager = createTestSkillManager(tmpProject);
    const skills = await manager.listSkills();

    const shared = skills.find((s) => s.name === "shared-skill");
    assert.ok(shared);
    // 项目级应覆盖 ~/.trae-cn/builtin_skills
    assert.equal(shared?.description, "Project version (higher priority)");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});
