/**
 * EAG-P1 批次 2 单元测试：Skill 元数据注册表
 *
 * 测试范围：
 * - S1. 6 个 Skill 元数据完整
 * - S2. id 唯一性
 * - S3. triggerPhase 合法值（design/coding/testing/verification）
 * - S4. skillMdPath 格式正确（相对路径 + SKILL.md 文件名）
 * - S5. 每个 Skill 的 SKILL.md 文件实际存在（用 fs.existsSync 验证）
 * - S6. SKILL_TRIGGER_PHASES 常量
 * - S7. EAG_SKILLS 已冻结（Object.isFrozen）
 * - S8. 查询 API（getAllEagSkills / getEagSkillById / getEagSkillsByPhase / getEagSkillsByParadigm）
 * - S9. applicableParadigms 字段格式正确（"all" 或 ParadigmId 数组）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实元数据与真实文件系统检查
 * - 通过 fs.existsSync 验证 SKILL.md 文件实际存在（文件级集成断言）
 *
 * 设计依据：
 * - EAG 方案 §5.1.2 模式 Skill 包（6 个 Skill）
 * - eag/eak/skill-registry.ts 源文件
 *
 * @module core/tests/eag-eak-skill-registry
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EAG_SKILLS,
  SKILL_TRIGGER_PHASES,
  getAllEagSkills,
  getEagSkillById,
  getEagSkillsByPhase,
  getEagSkillsByParadigm,
  getEagSkillCount,
  type SkillTriggerPhase,
  type EagSkillMetadata,
} from "../eag/eak/skill-registry";
import type { ParadigmId } from "../eag/eak/types";

// ============================================================================
// 计算 bundled skills 目录的绝对路径
// ============================================================================

// 当前测试文件路径：packages/core/src/tests/eag-eak-skill-registry.test.ts
// bundled 目录路径：packages/core/templates/skills/bundled/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = path.resolve(__dirname, "../../templates/skills/bundled");

// ============================================================================
// S1. 6 个 Skill 元数据完整
// ============================================================================

test("S1a. EAG_SKILLS 长度 = 6", () => {
  assert.equal(EAG_SKILLS.length, 6);
});

test("S1b. getEagSkillCount 返回 6", () => {
  assert.equal(getEagSkillCount(), 6);
});

test("S1c. EAG_SKILLS 包含全部 6 个 Skill ID", () => {
  const expectedIds = [
    "eag-domain-modeling",
    "eag-aggregate-design",
    "eag-cqrs-separation",
    "eag-saga-orchestration",
    "eag-acl",
    "eag-verify-enterprise",
  ];
  const actualIds = EAG_SKILLS.map((s) => s.id);
  for (const id of expectedIds) {
    assert.ok(actualIds.includes(id), `缺少 Skill：${id}`);
  }
});

test("S1d. 每个 Skill 元数据字段完整性（id/name/triggerPhase/applicableParadigms/skillMdPath/description）", () => {
  for (const skill of EAG_SKILLS) {
    // id 非空字符串
    assert.ok(typeof skill.id === "string" && skill.id.length > 0, "id 应非空");
    // id 以 eag- 前缀开头
    assert.ok(skill.id.startsWith("eag-"), `id 应以 eag- 前缀开头，实际：${skill.id}`);

    // name 非空字符串
    assert.ok(typeof skill.name === "string" && skill.name.length > 0, `${skill.id} name 应非空`);

    // triggerPhase 合法值
    const validPhases: SkillTriggerPhase[] = ["design", "coding", "testing", "verification"];
    assert.ok(validPhases.includes(skill.triggerPhase), `${skill.id} triggerPhase 非法：${skill.triggerPhase}`);

    // applicableParadigms 是 "all" 或 ParadigmId 数组
    if (skill.applicableParadigms !== "all") {
      assert.ok(
        Array.isArray(skill.applicableParadigms) && skill.applicableParadigms.length > 0,
        `${skill.id} applicableParadigms 应为非空数组或 "all"`
      );
      // 数组中的每个值应是合法的 ParadigmId
      const validParadigmIds: ParadigmId[] = ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"];
      for (const pid of skill.applicableParadigms) {
        assert.ok(validParadigmIds.includes(pid), `${skill.id} applicableParadigms 含非法值：${pid}`);
      }
    }

    // skillMdPath 非空字符串
    assert.ok(typeof skill.skillMdPath === "string" && skill.skillMdPath.length > 0);

    // description 非空且足够详细（>= 30 字符）
    assert.ok(
      typeof skill.description === "string" && skill.description.length >= 30,
      `${skill.id} description 应 >= 30 字符`
    );
  }
});

// ============================================================================
// S2. id 唯一性
// ============================================================================

test("S2. EAG_SKILLS id 唯一性——无重复", () => {
  const ids = EAG_SKILLS.map((s) => s.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, `id 存在重复：${ids.join(",")}`);
});

// ============================================================================
// S3. triggerPhase 合法值
// ============================================================================

test("S3a. SKILL_TRIGGER_PHASES 包含全部 4 个阶段", () => {
  assert.equal(SKILL_TRIGGER_PHASES.length, 4);
  const expectedPhases: SkillTriggerPhase[] = ["design", "coding", "testing", "verification"];
  assert.deepEqual([...SKILL_TRIGGER_PHASES], expectedPhases);
});

test("S3b. SKILL_TRIGGER_PHASES 已冻结", () => {
  assert.ok(Object.isFrozen(SKILL_TRIGGER_PHASES));
});

test("S3c. 6 个 Skill 的 triggerPhase 分布验证", () => {
  // 期望：
  // - design: eag-domain-modeling（1 个）
  // - coding: eag-aggregate-design, eag-cqrs-separation, eag-saga-orchestration, eag-acl（4 个）
  // - testing: 0 个
  // - verification: eag-verify-enterprise（1 个）
  const designSkills = EAG_SKILLS.filter((s) => s.triggerPhase === "design");
  const codingSkills = EAG_SKILLS.filter((s) => s.triggerPhase === "coding");
  const testingSkills = EAG_SKILLS.filter((s) => s.triggerPhase === "testing");
  const verificationSkills = EAG_SKILLS.filter((s) => s.triggerPhase === "verification");

  assert.equal(designSkills.length, 1, "design 阶段应有 1 个 Skill");
  assert.equal(codingSkills.length, 4, "coding 阶段应有 4 个 Skill");
  assert.equal(testingSkills.length, 0, "testing 阶段应有 0 个 Skill");
  assert.equal(verificationSkills.length, 1, "verification 阶段应有 1 个 Skill");
});

// ============================================================================
// S4. skillMdPath 格式正确
// ============================================================================

test("S4a. 每个 skillMdPath 格式正确（形如 'xxx/SKILL.md'）", () => {
  for (const skill of EAG_SKILLS) {
    assert.ok(
      skill.skillMdPath.endsWith("/SKILL.md"),
      `${skill.id} skillMdPath 应以 /SKILL.md 结尾，实际：${skill.skillMdPath}`
    );
    // 路径中应包含 skill.id 作为目录名
    assert.ok(
      skill.skillMdPath.startsWith(`${skill.id}/`),
      `${skill.id} skillMdPath 应以 ${skill.id}/ 开头，实际：${skill.skillMdPath}`
    );
  }
});

// ============================================================================
// S5. 每个 Skill 的 SKILL.md 文件实际存在（fs.existsSync 验证）
// ============================================================================

test("S5. 每个 Skill 的 SKILL.md 文件实际存在（fs.existsSync 验证）", () => {
  for (const skill of EAG_SKILLS) {
    const absolutePath = path.resolve(BUNDLED_SKILLS_DIR, skill.skillMdPath);
    const exists = fs.existsSync(absolutePath);
    assert.ok(exists, `SKILL.md 文件不存在：${absolutePath}（skill: ${skill.id}）`);
  }
});

test("S5b. SKILL.md 文件大小非空（避免占位实现）", () => {
  for (const skill of EAG_SKILLS) {
    const absolutePath = path.resolve(BUNDLED_SKILLS_DIR, skill.skillMdPath);
    const stats = fs.statSync(absolutePath);
    assert.ok(stats.size > 500, `${skill.id} SKILL.md 文件大小应 > 500 字节（避免占位实现），实际：${stats.size} 字节`);
  }
});

test("S5c. SKILL.md 文件含 YAML frontmatter（--- 起止标记）", () => {
  for (const skill of EAG_SKILLS) {
    const absolutePath = path.resolve(BUNDLED_SKILLS_DIR, skill.skillMdPath);
    const content = fs.readFileSync(absolutePath, "utf-8");
    assert.ok(content.startsWith("---"), `${skill.id} SKILL.md 应以 YAML frontmatter 开头（---）`);
    // 应包含第二个 --- 作为 frontmatter 结束
    const secondDashIndex = content.indexOf("---", 3);
    assert.ok(secondDashIndex > 0, `${skill.id} SKILL.md 应有 YAML frontmatter 结束标记（---）`);
  }
});

test("S5d. SKILL.md 文件含 name 字段（与 skill.id 一致）", () => {
  for (const skill of EAG_SKILLS) {
    const absolutePath = path.resolve(BUNDLED_SKILLS_DIR, skill.skillMdPath);
    const content = fs.readFileSync(absolutePath, "utf-8");
    // 简单正则匹配 name: xxx 字段
    const nameMatch = content.match(/^name:\s*(\S+)/m);
    assert.ok(nameMatch, `${skill.id} SKILL.md 应含 name 字段`);
    assert.equal(
      nameMatch![1],
      skill.id,
      `${skill.id} SKILL.md 的 name 字段应与 skill.id 一致，实际：${nameMatch![1]}`
    );
  }
});

test("S5e. SKILL.md 文件含 description 字段", () => {
  for (const skill of EAG_SKILLS) {
    const absolutePath = path.resolve(BUNDLED_SKILLS_DIR, skill.skillMdPath);
    const content = fs.readFileSync(absolutePath, "utf-8");
    assert.ok(/^description:/m.test(content), `${skill.id} SKILL.md 应含 description 字段`);
  }
});

// ============================================================================
// S6. SKILL_TRIGGER_PHASES 常量
// ============================================================================

test("S6. SKILL_TRIGGER_PHASES 已冻结", () => {
  assert.ok(Object.isFrozen(SKILL_TRIGGER_PHASES));
});

// ============================================================================
// S7. EAG_SKILLS 已冻结
// ============================================================================

test("S7. EAG_SKILLS 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(EAG_SKILLS));
});

// ============================================================================
// S8. 查询 API
// ============================================================================

test("S8a. getAllEagSkills 返回 6 个 Skill", () => {
  const all = getAllEagSkills();
  assert.equal(all.length, 6);
});

test("S8b. getAllEagSkills 与 EAG_SKILLS 引用一致", () => {
  assert.equal(getAllEagSkills(), EAG_SKILLS);
});

test("S8c. getEagSkillById 查找存在的 Skill", () => {
  const skill = getEagSkillById("eag-domain-modeling");
  assert.ok(skill !== null);
  assert.equal(skill!.id, "eag-domain-modeling");
  assert.equal(skill!.name, "领域建模");
});

test("S8d. getEagSkillById 查找不存在的 Skill 返回 null", () => {
  assert.equal(getEagSkillById("nonexistent-skill"), null);
  assert.equal(getEagSkillById(""), null);
});

test("S8e. getEagSkillById 逐条验证全部 6 个 Skill", () => {
  const expectedNames: Record<string, string> = {
    "eag-domain-modeling": "领域建模",
    "eag-aggregate-design": "聚合设计",
    "eag-cqrs-separation": "CQRS 读写分离",
    "eag-saga-orchestration": "Saga 编排",
    "eag-acl": "防腐层",
    "eag-verify-enterprise": "企业红线自检",
  };
  for (const id of Object.keys(expectedNames)) {
    const skill = getEagSkillById(id);
    assert.ok(skill !== null, `${id} 应存在`);
    assert.equal(skill!.id, id);
    assert.equal(skill!.name, expectedNames[id], `${id} name 应为 ${expectedNames[id]}`);
  }
});

test("S8f. getEagSkillsByPhase('design') 返回 1 个 Skill（eag-domain-modeling）", () => {
  const skills = getEagSkillsByPhase("design");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "eag-domain-modeling");
});

test("S8g. getEagSkillsByPhase('coding') 返回 4 个 Skill", () => {
  const skills = getEagSkillsByPhase("coding");
  assert.equal(skills.length, 4);
  const ids = skills.map((s) => s.id).sort();
  assert.deepEqual(ids, ["eag-acl", "eag-aggregate-design", "eag-cqrs-separation", "eag-saga-orchestration"]);
});

test("S8h. getEagSkillsByPhase('verification') 返回 1 个 Skill（eag-verify-enterprise）", () => {
  const skills = getEagSkillsByPhase("verification");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "eag-verify-enterprise");
});

test("S8i. getEagSkillsByPhase('testing') 返回 0 个 Skill", () => {
  const skills = getEagSkillsByPhase("testing");
  assert.equal(skills.length, 0);
});

// ============================================================================
// S9. applicableParadigms 字段格式正确
// ============================================================================

test("S9a. applicableParadigms === 'all' 的 Skill 应有 4 个（domain-modeling/aggregate-design/acl/verify-enterprise）", () => {
  // 检查方案 §5.1.2 表格：
  // - eag-domain-modeling: all
  // - eag-aggregate-design: all
  // - eag-cqrs-separation: cqrs-es（单一范式）
  // - eag-saga-orchestration: ddd/cqrs/micro（3 范式）
  // - eag-acl: all
  // - eag-verify-enterprise: all
  // all 的 Skill 数 = 4
  const allSkills = EAG_SKILLS.filter((s) => s.applicableParadigms === "all");
  assert.equal(allSkills.length, 4, `applicableParadigms='all' 应有 4 个，实际：${allSkills.length}`);
});

test("S9b. eag-cqrs-separation 仅适用于 cqrs-es 范式", () => {
  const skill = getEagSkillById("eag-cqrs-separation");
  assert.ok(skill !== null);
  assert.notEqual(skill!.applicableParadigms, "all");
  assert.deepEqual([...(skill!.applicableParadigms as Array<ParadigmId>)], ["cqrs-es"]);
});

test("S9c. eag-saga-orchestration 适用于 ddd-layered/cqrs-es/microservice 3 个范式", () => {
  const skill = getEagSkillById("eag-saga-orchestration");
  assert.ok(skill !== null);
  assert.notEqual(skill!.applicableParadigms, "all");
  const paradigms = [...(skill!.applicableParadigms as Array<ParadigmId>)];
  assert.equal(paradigms.length, 3);
  assert.ok(paradigms.includes("ddd-layered"));
  assert.ok(paradigms.includes("cqrs-es"));
  assert.ok(paradigms.includes("microservice"));
  // 不应包含 clean-architecture
  assert.ok(!paradigms.includes("clean-architecture"));
});

test("S9d. getEagSkillsByParadigm('ddd-layered') 返回适用 ddd 的全部 Skill", () => {
  const skills = getEagSkillsByParadigm("ddd-layered");
  // all 的 4 个 + saga-orchestration（含 ddd）= 5 个
  // eag-cqrs-separation 仅适用于 cqrs-es，不含 ddd
  assert.equal(skills.length, 5);
  const ids = skills.map((s) => s.id);
  assert.ok(ids.includes("eag-domain-modeling"));
  assert.ok(ids.includes("eag-aggregate-design"));
  assert.ok(ids.includes("eag-saga-orchestration"));
  assert.ok(ids.includes("eag-acl"));
  assert.ok(ids.includes("eag-verify-enterprise"));
  // 不应包含 cqrs-separation（仅 cqrs-es 范式）
  assert.ok(!ids.includes("eag-cqrs-separation"));
});

test("S9e. getEagSkillsByParadigm('cqrs-es') 返回适用 cqrs 的全部 Skill", () => {
  const skills = getEagSkillsByParadigm("cqrs-es");
  // all 的 4 个 + cqrs-separation（仅 cqrs）+ saga-orchestration（含 cqrs）= 6 个
  assert.equal(skills.length, 6);
});

test("S9f. getEagSkillsByParadigm('clean-architecture') 返回适用 clean 的全部 Skill", () => {
  const skills = getEagSkillsByParadigm("clean-architecture");
  // all 的 4 个；cqrs-separation 仅 cqrs 不含 clean；saga-orchestration 不含 clean
  assert.equal(skills.length, 4);
});

test("S9g. getEagSkillsByParadigm('microservice') 返回适用 micro 的全部 Skill", () => {
  const skills = getEagSkillsByParadigm("microservice");
  // all 的 4 个 + saga-orchestration（含 micro）= 5 个
  assert.equal(skills.length, 5);
});

// ============================================================================
// S10. EAG_SKILLS 注册顺序验证（对齐方案 §5.1.2 表格顺序）
// ============================================================================

test("S10. EAG_SKILLS 注册顺序对齐方案 §5.1.2 表格", () => {
  const expectedOrder = [
    "eag-domain-modeling",
    "eag-aggregate-design",
    "eag-cqrs-separation",
    "eag-saga-orchestration",
    "eag-acl",
    "eag-verify-enterprise",
  ];
  const actualOrder = EAG_SKILLS.map((s) => s.id);
  assert.deepEqual(actualOrder, expectedOrder);
});
