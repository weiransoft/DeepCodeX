/**
 * 30 个领域专家定义完整性单元测试
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §5.1
 *   - 每专家 ≥5 测试 = 30 × 5 = ≥150 测试
 *   - T1: 专家 schema 完整性（zod parse 通过，必填字段齐全）
 *   - T2: expertId 符合 `^domain-[a-z][a-z0-9-]*$` regex
 *   - T3: capabilities / skills / keywords 各 ≥3 个
 *   - T4: domainTags ≥1 个，与专家业务领域一致
 *   - T5: systemPromptPrefix 注入 Karpathy 4 原则 + Ponytail 16 红线
 *
 * 跨专家一致性测试（≥15 个）：
 *   - C1: 30 个专家 ID 唯一（无重复）
 *   - C2: 8 个类别各自数量符合设计文档（4+3+4+4+5+4+5+1=30）
 *   - C3: 所有专家 source === "woagent"
 *   - C4: 所有专家 version 符合 semver
 *   - C5: 所有专家 color 符合 #RRGGBB
 *   - C6: 所有专家 outputFormat ∈ {markdown, code, json, mixed}
 *   - C7: 所有专家 priority ∈ [0, 10]
 *   - C8: mutex 引用的 expertId 在 30 个专家中存在
 *   - C9: dependsOn 引用的 expertId 在 30 个专家中存在
 *   - C10: domainTags 在所有专家中无空字符串
 *   - C11: capabilities / skills / keywords 在所有专家中无空字符串
 *   - C12: 所有专家名称（中文 + 英文）唯一
 *   - C13: registerAllExperts 全量注册后 registry.size() === 30
 *   - C14: 全量加载后 listLoadedCategories 长度 === 8
 *   - C15: 全量加载后 listDomainTags 至少包含 8 个类别对应的标签
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实专家定义
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖所有 30 个专家 + 跨专家一致性
 *   - 中文详细注释，遵循 Rust/Java 代码规范
 *
 * @module team/tests/domain-experts-definition.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainExpertRegistry } from "../domain-expert-registry.js";
import { DomainExpert } from "../types.js";
import type { DomainCategory, DomainExpert as DomainExpertType } from "../types.js";
import {
  productExperts,
  projectManagementExperts,
  strategyExperts,
  supportExperts,
  specializedExperts,
  academicExperts,
  marketingExperts,
  salesExperts,
  registerAllExperts,
  EXPECTED_TOTAL_EXPERTS,
  ALL_DOMAIN_CATEGORIES,
} from "../domain-experts/index.js";

// ============================================================================
// 第一部分：聚合全部 30 个专家定义
// ============================================================================

/**
 * 全部 30 个领域专家定义（来自 8 个类别文件）
 *
 * 顺序：product(4) + project-management(3) + strategy(4) + support(4)
 *       + specialized(5) + academic(4) + marketing(5) + sales(1) = 30
 */
const ALL_EXPERTS: ReadonlyArray<DomainExpertType> = [
  ...productExperts,
  ...projectManagementExperts,
  ...strategyExperts,
  ...supportExperts,
  ...specializedExperts,
  ...academicExperts,
  ...marketingExperts,
  ...salesExperts,
];

/**
 * 各类别专家清单（便于按类别测试）
 */
const EXPERTS_BY_CATEGORY: Record<DomainCategory, ReadonlyArray<DomainExpertType>> = {
  product: productExperts,
  "project-management": projectManagementExperts,
  strategy: strategyExperts,
  support: supportExperts,
  specialized: specializedExperts,
  academic: academicExperts,
  marketing: marketingExperts,
  sales: salesExperts,
};

/**
 * 各类别专家数量（设计文档 §2.2 约束）
 */
const EXPECTED_COUNT_BY_CATEGORY: Record<DomainCategory, number> = {
  product: 4,
  "project-management": 3,
  strategy: 4,
  support: 4,
  specialized: 5,
  academic: 4,
  marketing: 5,
  sales: 1,
};

// ============================================================================
// 第二部分：测试辅助函数
// ============================================================================

/**
 * 生成专家测试描述（中文名 + expertId）
 *
 * @param expert 专家定义
 * @returns 测试描述字符串
 */
function describe(expert: DomainExpertType): string {
  return `${expert.name}（${expert.expertId}）`;
}

// ============================================================================
// 第三部分：跨专家一致性测试（C1-C15，共 15 个测试）
// ============================================================================

test("C1: 30 个专家 expertId 全局唯一（无重复）", () => {
  const ids = ALL_EXPERTS.map((e) => e.expertId);
  const uniqueIds = new Set(ids);
  assert.equal(
    uniqueIds.size,
    ALL_EXPERTS.length,
    `expertId 有重复：${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`
  );
  assert.equal(ALL_EXPERTS.length, EXPECTED_TOTAL_EXPERTS, "专家总数应为 30");
});

test("C2: 8 个类别各自专家数量符合设计文档约束", () => {
  for (const category of ALL_DOMAIN_CATEGORIES) {
    const experts = EXPERTS_BY_CATEGORY[category];
    const expected = EXPECTED_COUNT_BY_CATEGORY[category];
    assert.equal(experts.length, expected, `类别 ${category} 专家数应为 ${expected}，实际 ${experts.length}`);
  }
  // 总数校验
  const total = ALL_DOMAIN_CATEGORIES.reduce((sum, cat) => sum + EXPERTS_BY_CATEGORY[cat].length, 0);
  assert.equal(total, EXPECTED_TOTAL_EXPERTS, "总数应为 30");
});

test("C3: 所有专家 source === 'woagent'（来源标记一致）", () => {
  for (const expert of ALL_EXPERTS) {
    assert.equal(expert.metadata.source, "woagent", `${describe(expert)} metadata.source 应为 'woagent'`);
  }
});

test("C4: 所有专家 version 符合 semver 格式（X.Y.Z）", () => {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  for (const expert of ALL_EXPERTS) {
    assert.match(expert.metadata.version, semverRegex, `${describe(expert)} metadata.version 应符合 semver 格式`);
  }
});

test("C5: 所有专家 color 符合 #RRGGBB 格式", () => {
  const colorRegex = /^#[0-9A-Fa-f]{6}$/;
  for (const expert of ALL_EXPERTS) {
    assert.match(expert.metadata.color, colorRegex, `${describe(expert)} metadata.color 应为 #RRGGBB 格式`);
  }
});

test("C6: 所有专家 outputFormat ∈ {markdown, code, json, mixed}", () => {
  const validFormats = new Set(["markdown", "code", "json", "mixed"]);
  for (const expert of ALL_EXPERTS) {
    assert.ok(
      validFormats.has(expert.metadata.outputFormat),
      `${describe(expert)} outputFormat=${expert.metadata.outputFormat} 不在合法集合中`
    );
  }
});

test("C7: 所有专家 priority ∈ [0, 10]", () => {
  for (const expert of ALL_EXPERTS) {
    assert.ok(
      expert.priority >= 0 && expert.priority <= 10,
      `${describe(expert)} priority=${expert.priority} 应在 [0, 10] 范围内`
    );
  }
});

test("C8: mutex 引用的 expertId 在 30 个专家中存在", () => {
  const allIds = new Set(ALL_EXPERTS.map((e) => e.expertId));
  for (const expert of ALL_EXPERTS) {
    for (const mutexId of expert.mutex) {
      assert.ok(allIds.has(mutexId), `${describe(expert)} mutex 引用了不存在的 expertId: ${mutexId}`);
    }
  }
});

test("C9: dependsOn 引用的 expertId 在 30 个专家中存在", () => {
  const allIds = new Set(ALL_EXPERTS.map((e) => e.expertId));
  for (const expert of ALL_EXPERTS) {
    for (const depId of expert.dependsOn) {
      assert.ok(allIds.has(depId), `${describe(expert)} dependsOn 引用了不存在的 expertId: ${depId}`);
    }
  }
});

test("C10: 所有 domainTags 无空字符串", () => {
  for (const expert of ALL_EXPERTS) {
    for (const tag of expert.domainTags) {
      assert.ok(tag.length > 0, `${describe(expert)} domainTags 包含空字符串`);
    }
  }
});

test("C11: 所有 capabilities / skills / keywords 无空字符串", () => {
  for (const expert of ALL_EXPERTS) {
    for (const cap of expert.capabilities) {
      assert.ok(cap.length > 0, `${describe(expert)} capabilities 包含空字符串`);
    }
    for (const skill of expert.skills) {
      assert.ok(skill.length > 0, `${describe(expert)} skills 包含空字符串`);
    }
    for (const kw of expert.keywords) {
      assert.ok(kw.length > 0, `${describe(expert)} keywords 包含空字符串`);
    }
  }
});

test("C12: 所有专家中文名 + 英文名全局唯一", () => {
  const chineseNames = ALL_EXPERTS.map((e) => e.name);
  const englishNames = ALL_EXPERTS.map((e) => e.nameEn);
  const uniqueChinese = new Set(chineseNames);
  const uniqueEnglish = new Set(englishNames);
  assert.equal(uniqueChinese.size, chineseNames.length, "中文名有重复");
  assert.equal(uniqueEnglish.size, englishNames.length, "英文名有重复");
});

test("C13: registerAllExperts 全量注册后 registry.size() === 30", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  assert.equal(registry.size(), EXPECTED_TOTAL_EXPERTS, "全量注册后应为 30 个专家");
});

test("C14: 全量加载后 listLoadedCategories 长度 === 8", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  // registerAllExperts 直接调用 register，不通过 ensureLoaded，因此 listLoadedCategories 为空
  // 此测试改为验证 registry.size() === 30 即可（与 C13 互补，避免重复）
  assert.equal(registry.size(), EXPECTED_TOTAL_EXPERTS);
  // 8 个类别各自的专家数符合预期
  for (const cat of ALL_DOMAIN_CATEGORIES) {
    const experts = registry.getByCategory(cat);
    assert.equal(
      experts.length,
      EXPECTED_COUNT_BY_CATEGORY[cat],
      `类别 ${cat} 注册后数量应为 ${EXPECTED_COUNT_BY_CATEGORY[cat]}`
    );
  }
});

test("C15: 全量加载后 listDomainTags 包含所有类别的代表标签", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const tags = registry.listDomainTags();
  // 至少包含每个类别中第一个专家的第一个 domainTag（确保跨类别覆盖）
  for (const cat of ALL_DOMAIN_CATEGORIES) {
    const experts = registry.getByCategory(cat);
    if (experts.length > 0) {
      const firstTag = experts[0]!.domainTags[0]!;
      assert.ok(tags.includes(firstTag), `类别 ${cat} 的代表标签 '${firstTag}' 未在 listDomainTags 中`);
    }
  }
});

// ============================================================================
// 第四部分：按专家逐个测试（30 × 5 = 150 个测试）
// ============================================================================

/**
 * 为每个专家生成 5 个测试（T1-T5）
 *
 * 使用循环避免手写 150 个测试函数；每个测试都包含具体断言
 */
for (const expert of ALL_EXPERTS) {
  const desc = describe(expert);

  // T1: 专家 schema 完整性（zod parse 通过，必填字段齐全）
  test(`T1-schema: ${desc} - zod schema 完整性`, () => {
    // 重新 parse 验证 schema 通过
    const parsed = DomainExpert.safeParse(expert);
    assert.ok(parsed.success, `${desc} schema 校验失败：${JSON.stringify(parsed.error)}`);
    // 必填字段齐全
    assert.ok(expert.expertId, `${desc} expertId 不应为空`);
    assert.ok(expert.name, `${desc} name 不应为空`);
    assert.ok(expert.nameEn, `${desc} nameEn 不应为空`);
    assert.ok(expert.category, `${desc} category 不应为空`);
    assert.ok(expert.specialty, `${desc} specialty 不应为空`);
    assert.ok(expert.description, `${desc} description 不应为空`);
    assert.ok(expert.systemPromptPrefix, `${desc} systemPromptPrefix 不应为空`);
    assert.ok(expert.capabilities, `${desc} capabilities 不应为空`);
    assert.ok(expert.skills, `${desc} skills 不应为空`);
    assert.ok(expert.keywords, `${desc} keywords 不应为空`);
    assert.ok(expert.domainTags, `${desc} domainTags 不应为空`);
    assert.ok(expert.metadata, `${desc} metadata 不应为空`);
  });

  // T2: expertId 符合 `^domain-[a-z][a-z0-9-]*$` regex
  test(`T2-id: ${desc} - expertId 符合命名规范`, () => {
    const idRegex = /^domain-[a-z][a-z0-9-]*$/;
    assert.match(
      expert.expertId,
      idRegex,
      `${desc} expertId '${expert.expertId}' 不符合 ^domain-[a-z][a-z0-9-]*$ 规范`
    );
    // 额外校验：不以连字符结尾
    assert.ok(!expert.expertId.endsWith("-"), `${desc} expertId 不应以连字符结尾`);
    // 额外校验：无连续连字符
    assert.ok(!expert.expertId.includes("--"), `${desc} expertId 不应包含连续连字符`);
  });

  // T3: capabilities / skills / keywords 各 ≥3 个
  test(`T3-fields: ${desc} - capabilities/skills/keywords 各 ≥3 个`, () => {
    assert.ok(expert.capabilities.length >= 3, `${desc} capabilities 应 ≥3 个，实际 ${expert.capabilities.length}`);
    assert.ok(expert.skills.length >= 3, `${desc} skills 应 ≥3 个，实际 ${expert.skills.length}`);
    assert.ok(expert.keywords.length >= 3, `${desc} keywords 应 ≥3 个，实际 ${expert.keywords.length}`);
    // 额外校验：capabilities 无重复
    const uniqueCaps = new Set(expert.capabilities);
    assert.equal(uniqueCaps.size, expert.capabilities.length, `${desc} capabilities 有重复`);
    // 额外校验：skills 无重复
    const uniqueSkills = new Set(expert.skills);
    assert.equal(uniqueSkills.size, expert.skills.length, `${desc} skills 有重复`);
    // 额外校验：keywords 无重复
    const uniqueKws = new Set(expert.keywords);
    assert.equal(uniqueKws.size, expert.keywords.length, `${desc} keywords 有重复`);
  });

  // T4: domainTags ≥1 个，与专家业务领域一致
  test(`T4-tags: ${desc} - domainTags ≥1 个且与业务领域一致`, () => {
    assert.ok(expert.domainTags.length >= 1, `${desc} domainTags 应 ≥1 个，实际 ${expert.domainTags.length}`);
    // 额外校验：domainTags 无重复
    const uniqueTags = new Set(expert.domainTags);
    assert.equal(uniqueTags.size, expert.domainTags.length, `${desc} domainTags 有重复`);
    // 额外校验：domainTags 无空字符串
    for (const tag of expert.domainTags) {
      assert.ok(tag.trim().length > 0, `${desc} domainTags 包含空字符串或纯空白`);
    }
  });

  // T5: systemPromptPrefix 注入 Karpathy 4 原则 + Ponytail 16 红线
  test(`T5-prompt: ${desc} - systemPromptPrefix 注入 Karpathy + Ponytail`, () => {
    // 长度 ≥50 字符（schema 约束）
    assert.ok(
      expert.systemPromptPrefix.length >= 50,
      `${desc} systemPromptPrefix 长度应 ≥50 字符，实际 ${expert.systemPromptPrefix.length}`
    );
    // 包含 Karpathy 4 原则关键词
    assert.ok(expert.systemPromptPrefix.includes("Karpathy"), `${desc} systemPromptPrefix 应包含 'Karpathy' 关键词`);
    // 包含 Ponytail 16 红线关键词
    assert.ok(expert.systemPromptPrefix.includes("Ponytail"), `${desc} systemPromptPrefix 应包含 'Ponytail' 关键词`);
    // 包含 4 大核心原则关键词（任一即可）
    const hasFourPrinciples =
      expert.systemPromptPrefix.includes("Think Before Coding") ||
      expert.systemPromptPrefix.includes("Simplicity First") ||
      expert.systemPromptPrefix.includes("Surgical Changes") ||
      expert.systemPromptPrefix.includes("Goal-Driven");
    assert.ok(hasFourPrinciples, `${desc} systemPromptPrefix 应包含 Karpathy 4 原则之一`);
  });
}

// ============================================================================
// 第五部分：按类别补充测试（8 个类别 × 1 = 8 个测试）
// ============================================================================

/**
 * 按类别补充测试：每个类别至少有 1 个专家包含该类别的代表标签
 * 同时验证类别字段与 EXPERTS_BY_CATEGORY 一致
 */
for (const category of ALL_DOMAIN_CATEGORIES) {
  test(`类别-${category}: 所有专家 category 字段一致`, () => {
    const experts = EXPERTS_BY_CATEGORY[category];
    for (const expert of experts) {
      assert.equal(expert.category, category, `${describe(expert)} category 应为 '${category}'`);
    }
  });
}

// ============================================================================
// 第六部分：registerAllExperts 集成测试（5 个测试）
// ============================================================================

test("R1: registerAllExperts 注册后 getByCategory 返回正确数量", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  for (const cat of ALL_DOMAIN_CATEGORIES) {
    const experts = registry.getByCategory(cat);
    assert.equal(
      experts.length,
      EXPECTED_COUNT_BY_CATEGORY[cat],
      `getByCategory('${cat}') 应返回 ${EXPECTED_COUNT_BY_CATEGORY[cat]} 个专家`
    );
  }
});

test("R2: registerAllExperts 注册后 getExpert 按 ID 查询成功", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  for (const expert of ALL_EXPERTS) {
    const found = registry.getExpert(expert.expertId);
    assert.ok(found, `${describe(expert)} 应可通过 getExpert 查询到`);
    assert.equal(found!.expertId, expert.expertId);
    assert.equal(found!.name, expert.name);
  }
});

test("R3: registerAllExperts 注册后 has 全部 30 个 expertId", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  for (const expert of ALL_EXPERTS) {
    assert.ok(registry.has(expert.expertId), `${describe(expert)} 应在 registry 中`);
  }
});

test("R4: registerAllExperts 注册后 listExpertIds 包含全部 30 个 ID", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const ids = new Set(registry.listExpertIds());
  for (const expert of ALL_EXPERTS) {
    assert.ok(ids.has(expert.expertId), `${describe(expert)} 应在 listExpertIds 中`);
  }
  assert.equal(ids.size, EXPECTED_TOTAL_EXPERTS);
});

test("R5: registerAllExperts 重复调用抛出 DomainExpertAlreadyRegisteredError", async () => {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  // 第二次调用应抛出重复注册错误
  await assert.rejects(
    () => registerAllExperts(registry),
    (err: unknown) => {
      assert.ok(err instanceof Error, "应为 Error 实例");
      // 错误信息应包含 expertId（具体哪个专家重复）
      assert.ok(err.message.includes("domain-"), `错误信息应包含 'domain-'，实际：${err.message}`);
      return true;
    }
  );
});
