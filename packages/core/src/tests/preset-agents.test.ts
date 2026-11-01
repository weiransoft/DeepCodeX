/**
 * 预置智能体种子测试（2026-11-02）
 *
 * 覆盖三个必须成立的事实：
 * 1. **数量与唯一性**：5 核心角色 + 30 领域专家 = 35，名称全局唯一（kebab-case 可直接做目录名）；
 * 2. **幂等与非破坏**：默认不覆盖已存在文件（用户改过的不被抹掉），overwrite 才重写；
 * 3. **可被扫描链识别**：落盘后 SkillManager 能把它们读成 kind=agent 条目——
 *    这是「界面能看到 = 能用」的唯一判据（此前 35 个智能体只存在于内存，界面一个都看不到）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import matter from "gray-matter";
import { PRESET_AGENT_COUNT, listPresetAgents, renderPresetSkillMd, syncPresetAgents } from "../agents/preset-agents";
import { SkillManager } from "../skill-manager";

/** 建临时工程根（项目级 skills 根为 <root>/.deepcode/skills） */
function makeProjectRoot(): { root: string; skillsRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "deepcode-preset-"));
  return { root, skillsRoot: path.join(root, ".deepcode", "skills") };
}

test("预置智能体数量 = 5 核心角色 + 30 领域专家，且名称唯一 kebab-case", () => {
  const agents = listPresetAgents();
  assert.equal(agents.length, PRESET_AGENT_COUNT);
  assert.equal(PRESET_AGENT_COUNT, 35);
  const names = new Set(agents.map((a) => a.name));
  assert.equal(names.size, agents.length, "预置名称不得重复（重名会互相覆盖目录）");
  for (const agent of agents) {
    assert.match(agent.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `名称必须 kebab-case：${agent.name}`);
    assert.ok(agent.description.length > 0, `${agent.name} 缺 description（会被 AgentRegistry 丢弃）`);
    assert.ok(agent.body.length >= 50, `${agent.name} 正文过短（团队 prompt 应完整移植）`);
  }
  // 核心角色与专家分组都要存在：前者是团队角色，后者是专家群体
  assert.ok(agents.some((a) => a.group === "core"));
  assert.ok(agents.some((a) => a.group === "业务需求"));
});

test("renderPresetSkillMd 产出的 frontmatter 可被解析为 agent 条目", () => {
  const agent = listPresetAgents().find((a) => a.name === "domain-product-manager");
  assert.ok(agent);
  const parsed = matter(renderPresetSkillMd(agent));
  assert.equal(parsed.data["type"], "agent");
  assert.equal(parsed.data["preset"], true);
  assert.equal(parsed.data["name"], "domain-product-manager");
  assert.equal(parsed.data["group"], "业务需求");
  assert.ok(parsed.content.includes("ROLE"));
});

test("syncPresetAgents 幂等：二次同步不重写，且保留用户改动", () => {
  const { skillsRoot } = makeProjectRoot();
  const first = syncPresetAgents(skillsRoot);
  assert.equal(first.written.length, PRESET_AGENT_COUNT);
  assert.deepEqual(first.failed, []);

  // 模拟用户编辑其中一个预置智能体
  const target = path.join(skillsRoot, "architect", "SKILL.md");
  writeFileSync(target, `${readFileSync(target, "utf8")}\n<!-- 用户补充 -->\n`, "utf8");

  const second = syncPresetAgents(skillsRoot);
  assert.equal(second.written.length, 0, "已存在的文件不应被重写");
  assert.equal(second.skipped.length, PRESET_AGENT_COUNT);
  assert.ok(readFileSync(target, "utf8").includes("用户补充"), "用户改动必须保留");

  // 显式 overwrite 才恢复出厂内容
  const third = syncPresetAgents(skillsRoot, { overwrite: true });
  assert.equal(third.written.length, PRESET_AGENT_COUNT);
  assert.ok(!readFileSync(target, "utf8").includes("用户补充"));
});

test("落盘后 SkillManager 扫描链能识别为 agent（界面可见即可用的判据）", async () => {
  const { root, skillsRoot } = makeProjectRoot();
  syncPresetAgents(skillsRoot);
  const manager = new SkillManager({
    projectRoot: root,
    getResolvedSettings: () => ({}),
    listSessionMessages: () => [],
  });
  const all = await manager.listSkills();
  const agents = all.filter((s) => s.kind === "agent");
  // 项目级根只有本次写入的预置条目（用户级根可能另有内容，故用 >= 断言）
  assert.ok(agents.length >= PRESET_AGENT_COUNT, `应识别出至少 ${PRESET_AGENT_COUNT} 个 agent，实际 ${agents.length}`);
  const architect = agents.find((s) => s.name === "architect");
  assert.ok(architect, "核心角色 architect 必须可见");
  assert.equal(architect?.preset, true);
  assert.equal(architect?.group, "core");
});
