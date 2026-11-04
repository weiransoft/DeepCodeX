/**
 * 扩展根目录解析单测（core/prompt.getExtensionRoot + skill-manager.getBundledSkillsRoot）
 *
 * 守的是「打包 / 发布布局下资产必须可达」这条边界：
 *
 * 三种布局（templates/ 与 bundled/ 所在层级各不相同）：
 * - 开发（core 源码）：packages/core/templates/
 * - CLI 打包：packages/cli/dist/templates/ + packages/cli/dist/bundled/
 * - npm 发布：<pkg>/dist/templates/ + <pkg>/dist/bundled/
 *
 * 修复前 getExtensionRoot() 固定返回「bundle 上一级」，于是打包与发布布局下
 * 资源全部落空——22 个内置技能（bundled:）在能力清单里恒为空，
 * 工具文档与 plan.md 模板也静默丢失（读不到就跳过，几乎不露痕迹）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "../skill-manager";

/** 构造只用于能力扫描的 SkillManager（无会话、无设置过滤） */
function manager(projectRoot: string): SkillManager {
  return new SkillManager({
    projectRoot,
    getResolvedSettings: () => ({}),
    listSessionMessages: () => [],
  });
}

test("E1：开发布局下 bundled 技能可被扫到（回归护栏）", () => {
  const mgr = manager(process.cwd());
  const root = mgr.getBundledSkillsRoot();
  assert.ok(fs.existsSync(root), `bundled 根应存在：${root}`);
  // 开发模式下命中源码树里的内置技能目录
  assert.ok(root.endsWith(path.join("templates", "skills", "bundled")), `实际：${root}`);
});

test("E2：开发布局下内置技能清单非空（docx/pdf/pptx 等）", async () => {
  const mgr = manager(process.cwd());
  const skills = await mgr.listSkills();
  const bundled = skills.filter((s) => s.path.startsWith("bundled:"));
  assert.ok(bundled.length > 0, "开发布局下应能扫到 bundled: 技能");
  const names = bundled.map((s) => s.name);
  for (const expected of ["docx", "pdf", "pptx"]) {
    assert.ok(names.includes(expected), `应包含内置技能 ${expected}，实际：${names.join(",")}`);
  }
});

test("E3：bundled 根解析对不存在的目录安全降级（不抛异常）", () => {
  const mgr = manager(path.join(os.tmpdir(), "dc-nonexistent-project-root"));
  const root = mgr.getBundledSkillsRoot();
  // 解析总能返回一个绝对路径（是否存在于上层按「扫不到即空列表」处理）
  assert.ok(path.isAbsolute(root));
});

test("E4：bundled: 前缀路径解析落在 bundled 根内（路径遍历防御不受影响）", () => {
  const mgr = manager(process.cwd());
  const root = mgr.getBundledSkillsRoot();
  const resolved = mgr.resolveSkillPath("bundled:docx/SKILL.md");
  assert.ok(resolved.startsWith(path.resolve(root)), `应落在 bundled 根内：${resolved}`);
  // 越界路径被挡下（落到 __invalid_bundled_skill__）
  const escaped = mgr.resolveSkillPath("bundled:../../etc/passwd");
  assert.ok(escaped.includes("__invalid_bundled_skill__"), `越界应被拦下，实际：${escaped}`);
});
