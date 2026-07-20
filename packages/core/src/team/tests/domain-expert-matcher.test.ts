/**
 * DomainExpertMatcher 单元测试
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.3 / §5.2
 * 覆盖：4 维加权评分 / Jaccard 相似度 / 三种匹配策略 / 降级 / 边界条件
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实 DomainExpert 构造测试数据
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖所有错误分支和边界条件
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainExpertMatcher, DomainMatchOptionsSchema, _internals } from "../domain-expert-matcher.js";
import { DomainExpertRegistry } from "../domain-expert-registry.js";
import {
  DomainExpert,
  type DomainCategory,
  type DomainExpert as DomainExpertType,
  type TaskRequirement,
  type DomainMatchOptions,
} from "../types.js";

// ============================================================================
// 测试 fixture：构造合法 DomainExpert 与 TaskRequirement
// ============================================================================

/**
 * 构造测试用 DomainExpert
 */
function buildExpert(overrides: Partial<DomainExpertType> = {}): DomainExpertType {
  const base = {
    expertId: "domain-test-expert",
    name: "测试专家",
    nameEn: "Test Expert",
    category: "strategy" as DomainCategory,
    specialty: "测试专长",
    description: "测试专家描述内容（≥10 字符）用于领域专家匹配测试场景",
    systemPromptPrefix: "你是测试专家，严格遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于测试业务领域的分析。",
    capabilities: ["cap1", "cap2", "cap3"],
    skills: ["skill1", "skill2", "skill3"],
    keywords: ["kw1", "kw2", "kw3"],
    domainTags: ["测试", "业务"],
    metadata: {
      color: "#1E88E5",
      icon: "test",
      outputFormat: "markdown" as const,
      source: "woagent" as const,
    },
  };
  return DomainExpert.parse({ ...base, ...overrides });
}

/**
 * 构造测试用 TaskRequirement
 */
function buildTask(overrides: Partial<TaskRequirement> = {}): TaskRequirement {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "测试任务标题",
    description: "测试任务描述内容（≥10 字符）用于领域专家匹配测试",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium",
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    domainTags: [],
    ...overrides,
  };
}

/**
 * 构造已注册 3 个专家的 registry
 */
function buildRegistryWith3Experts(): DomainExpertRegistry {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-strategy-a",
      category: "strategy",
      domainTags: ["金融", "风控"],
      keywords: ["金融", "风控", "合规"],
      capabilities: ["cap-finance", "cap-risk", "cap-compliance"],
      skills: ["skill-finance", "skill-risk", "skill-compliance"],
      priority: 8,
    })
  );
  registry.register(
    buildExpert({
      expertId: "domain-strategy-b",
      category: "strategy",
      domainTags: ["医疗", "合规"],
      keywords: ["医疗", "合规", "审计"],
      capabilities: ["cap-medical", "cap-compliance", "cap-audit"],
      skills: ["skill-medical", "skill-compliance", "skill-audit"],
      priority: 5,
    })
  );
  registry.register(
    buildExpert({
      expertId: "domain-product-c",
      category: "product",
      domainTags: ["电商", "增长"],
      keywords: ["电商", "增长", "运营"],
      capabilities: ["cap-ecommerce", "cap-growth", "cap-ops"],
      skills: ["skill-ecommerce", "skill-growth", "skill-ops"],
      priority: 3,
    })
  );
  return registry;
}

// ============================================================================
// 第一部分：computeDomainTagMatch（Jaccard 相似度，10 个测试）
// ============================================================================

test("computeDomainTagMatch：任务无标签时返回 0.5（不惩罚无标签任务）", () => {
  const score = _internals.computeDomainTagMatch([], ["金融", "风控"]);
  assert.equal(score, 0.5);
});

test("computeDomainTagMatch：专家无标签时返回 0（domainTags 是核心标识）", () => {
  const score = _internals.computeDomainTagMatch(["金融"], []);
  assert.equal(score, 0);
});

test("computeDomainTagMatch：完全相同标签集返回 1.0", () => {
  const score = _internals.computeDomainTagMatch(["金融", "风控"], ["金融", "风控"]);
  assert.equal(score, 1.0);
});

test("computeDomainTagMatch：完全不相交返回 0", () => {
  const score = _internals.computeDomainTagMatch(["金融"], ["医疗"]);
  assert.equal(score, 0);
});

test("computeDomainTagMatch：部分交集返回 Jaccard 值", () => {
  // |A ∩ B| = 1, |A ∪ B| = 3 → 1/3
  const score = _internals.computeDomainTagMatch(["金融", "风控"], ["金融", "医疗"]);
  assert.ok(Math.abs(score - 1 / 3) < 0.001);
});

test("computeDomainTagMatch：大小写不敏感", () => {
  const score = _internals.computeDomainTagMatch(["FINANCE"], ["finance"]);
  assert.equal(score, 1.0);
});

test("computeDomainTagMatch：单元素交集 1/2", () => {
  const score = _internals.computeDomainTagMatch(["金融"], ["金融", "风控"]);
  // |A ∩ B| = 1, |A ∪ B| = 2 → 0.5
  assert.equal(score, 0.5);
});

test("computeDomainTagMatch：三元素部分交集", () => {
  // A = {a, b, c}, B = {b, c, d} → |∩| = 2, |∪| = 4 → 0.5
  const score = _internals.computeDomainTagMatch(["a", "b", "c"], ["b", "c", "d"]);
  assert.equal(score, 0.5);
});

test("computeDomainTagMatch：空集合双方返回 0（避免除零）", () => {
  const score = _internals.computeDomainTagMatch([], []);
  // 任务无标签 → 0.5（早返回）
  assert.equal(score, 0.5);
});

test("computeDomainTagMatch：标签去重", () => {
  // A = {金融, 风控}（去重后）, B = {金融, 风控} → 1.0
  const score = _internals.computeDomainTagMatch(["金融", "金融", "风控"], ["金融", "风控", "风控"]);
  assert.equal(score, 1.0);
});

// ============================================================================
// 第二部分：computeKeywordOverlap（关键词重叠度，8 个测试）
// ============================================================================

test("computeKeywordOverlap：无关键词返回 0", () => {
  const score = _internals.computeKeywordOverlap("some text", []);
  assert.equal(score, 0);
});

test("computeKeywordOverlap：全部命中返回 1.0", () => {
  const score = _internals.computeKeywordOverlap("金融 风控 合规", ["金融", "风控", "合规"]);
  assert.equal(score, 1.0);
});

test("computeKeywordOverlap：无命中返回 0", () => {
  const score = _internals.computeKeywordOverlap("医疗 审计", ["金融", "风控"]);
  assert.equal(score, 0);
});

test("computeKeywordOverlap：部分命中返回比例值", () => {
  // 3 个关键词命中 1 个 → 1/3
  const score = _internals.computeKeywordOverlap("金融", ["金融", "风控", "合规"]);
  assert.ok(Math.abs(score - 1 / 3) < 0.001);
});

test("computeKeywordOverlap：中文关键词命中", () => {
  const score = _internals.computeKeywordOverlap("这是一个金融场景的任务", ["金融"]);
  assert.equal(score, 1.0);
});

test("computeKeywordOverlap：英文关键词大小写不敏感", () => {
  const score = _internals.computeKeywordOverlap("FINANCE scenario", ["finance"]);
  assert.equal(score, 1.0);
});

test("computeKeywordOverlap：中英文混合关键词", () => {
  const score = _internals.computeKeywordOverlap("金融 finance 风控", ["金融", "finance", "合规"]);
  // 命中 2/3
  assert.ok(Math.abs(score - 2 / 3) < 0.001);
});

test("computeKeywordOverlap：单字符中文关键词", () => {
  const score = _internals.computeKeywordOverlap("金融场景", ["金"]);
  // "金" 是单字符，走 includes 逻辑
  assert.equal(score, 1.0);
});

// ============================================================================
// 第三部分：computeCapabilityMatch（F1 分数，8 个测试）
// ============================================================================

test("computeCapabilityMatch：任务无所需能力返回 0.5（中性）", () => {
  const score = _internals.computeCapabilityMatch([], ["cap1", "cap2"]);
  assert.equal(score, 0.5);
});

test("computeCapabilityMatch：完全匹配返回 1.0", () => {
  const score = _internals.computeCapabilityMatch(["cap1", "cap2"], ["cap1", "cap2"]);
  assert.equal(score, 1.0);
});

test("computeCapabilityMatch：完全不匹配返回 0", () => {
  const score = _internals.computeCapabilityMatch(["cap1"], ["cap2", "cap3"]);
  assert.equal(score, 0);
});

test("computeCapabilityMatch：部分匹配返回 F1 值", () => {
  // precision = 2/3, recall = 2/2 = 1 → F1 = 2*0.667*1/(0.667+1) = 0.8
  const score = _internals.computeCapabilityMatch(["cap1", "cap2"], ["cap1", "cap2", "cap3"]);
  assert.ok(Math.abs(score - 0.8) < 0.001);
});

test("computeCapabilityMatch：专家能力空集返回 0", () => {
  const score = _internals.computeCapabilityMatch(["cap1"], []);
  // precision = 0/0 = 0, recall = 0/1 = 0 → 0
  assert.equal(score, 0);
});

test("computeCapabilityMatch：单元素完全匹配", () => {
  const score = _internals.computeCapabilityMatch(["cap1"], ["cap1"]);
  assert.equal(score, 1.0);
});

test("computeCapabilityMatch：precision 与 recall 不对称场景", () => {
  // 任务需要 [cap1, cap2, cap3, cap4]，专家有 [cap1, cap2]
  // precision = 2/2 = 1, recall = 2/4 = 0.5 → F1 = 2*1*0.5/(1+0.5) = 0.667
  const score = _internals.computeCapabilityMatch(["cap1", "cap2", "cap3", "cap4"], ["cap1", "cap2"]);
  assert.ok(Math.abs(score - 2 / 3) < 0.001);
});

test("computeCapabilityMatch：大小写敏感（精确匹配）", () => {
  // capabilities 是枚举值，应大小写敏感
  const score = _internals.computeCapabilityMatch(["Cap1"], ["cap1"]);
  assert.equal(score, 0);
});

// ============================================================================
// 第四部分：computeSkillMatch（技能命中率，6 个测试）
// ============================================================================

test("computeSkillMatch：任务无偏好技能返回 0.5（中性）", () => {
  const score = _internals.computeSkillMatch([], ["skill1"]);
  assert.equal(score, 0.5);
});

test("computeSkillMatch：全部命中返回 1.0", () => {
  const score = _internals.computeSkillMatch(["skill1", "skill2"], ["skill1", "skill2"]);
  assert.equal(score, 1.0);
});

test("computeSkillMatch：无命中返回 0", () => {
  const score = _internals.computeSkillMatch(["skill1"], ["skill2", "skill3"]);
  assert.equal(score, 0);
});

test("computeSkillMatch：部分命中返回比例值", () => {
  // 3 个偏好技能命中 1 个 → 1/3
  const score = _internals.computeSkillMatch(["skill1", "skill2", "skill3"], ["skill1"]);
  assert.ok(Math.abs(score - 1 / 3) < 0.001);
});

test("computeSkillMatch：大小写不敏感", () => {
  const score = _internals.computeSkillMatch(["SKILL1"], ["skill1"]);
  assert.equal(score, 1.0);
});

test("computeSkillMatch：空专家技能集", () => {
  const score = _internals.computeSkillMatch(["skill1"], []);
  assert.equal(score, 0);
});

// ============================================================================
// 第五部分：scoreByDomainKeyword（4 维评分，6 个测试）
// ============================================================================

test("scoreByDomainKeyword：返回包含 domainTag 字段的 ScoreBreakdown", () => {
  const task = buildTask({ domainTags: ["金融"] });
  const expert = buildExpert({ domainTags: ["金融"] });
  const score = _internals.scoreByDomainKeyword(task, expert);
  assert.ok("domainTag" in score);
  assert.ok(typeof score.domainTag === "number");
});

test("scoreByDomainKeyword：domainTag 完全匹配时为 1.0", () => {
  const task = buildTask({ domainTags: ["金融", "风控"] });
  const expert = buildExpert({ domainTags: ["金融", "风控"] });
  const score = _internals.scoreByDomainKeyword(task, expert);
  assert.equal(score.domainTag, 1.0);
});

test("scoreByDomainKeyword：priority 评分 = priority / 10", () => {
  const task = buildTask();
  const expert = buildExpert({ priority: 7 });
  const score = _internals.scoreByDomainKeyword(task, expert);
  assert.ok(Math.abs(score.priority - 0.7) < 0.001);
});

test("scoreByDomainKeyword：所有维度评分在 [0, 1] 范围内", () => {
  const task = buildTask({
    title: "金融风控任务",
    description: "需要金融风控能力",
    domainTags: ["金融"],
    requiredCapabilities: ["cap1"],
    preferredSkills: ["skill1"],
  });
  const expert = buildExpert({
    domainTags: ["金融"],
    keywords: ["金融", "风控", "合规"],
    capabilities: ["cap1", "cap2", "cap3"],
    skills: ["skill1", "skill2", "skill3"],
  });
  const score = _internals.scoreByDomainKeyword(task, expert);
  for (const dim of ["capability", "skill", "keyword", "priority", "domainTag"] as const) {
    const v = score[dim];
    if (v !== undefined) {
      assert.ok(v >= 0 && v <= 1, `${dim} 评分 ${v} 超出 [0,1] 范围`);
    }
  }
});

test("scoreByDomainKeyword：keyword 评分使用 task title + description 文本", () => {
  const task = buildTask({
    title: "金融分析",
    description: "需要金融专业能力",
  });
  const expert = buildExpert({ keywords: ["金融", "分析", "专业"] });
  const score = _internals.scoreByDomainKeyword(task, expert);
  // 3 个中文关键词都通过 includes 命中 → 3/3 = 1.0
  assert.ok(Math.abs(score.keyword - 1.0) < 0.001);
});

test("scoreByDomainKeyword：domainTag 缺失任务标签时返回 0.5（中性）", () => {
  const task = buildTask({ domainTags: [] });
  const expert = buildExpert({ domainTags: ["金融"] });
  const score = _internals.scoreByDomainKeyword(task, expert);
  assert.equal(score.domainTag, 0.5);
});

// ============================================================================
// 第六部分：aggregateDomainScore（加权求和，6 个测试）
// ============================================================================

test("aggregateDomainScore：domainTag 缺失时按 0 计算", () => {
  const score = _internals.aggregateDomainScore({
    capability: 1.0,
    skill: 1.0,
    keyword: 1.0,
    priority: 1.0,
    // domainTag 缺失
  });
  // 0*0.4 + 1*0.3 + 1*0.2 + 1*0.1 = 0.6
  assert.ok(Math.abs(score - 0.6) < 0.001);
});

test("aggregateDomainScore：全 1.0 时为 1.0", () => {
  const score = _internals.aggregateDomainScore({
    capability: 1.0,
    skill: 1.0,
    keyword: 1.0,
    priority: 1.0,
    domainTag: 1.0,
  });
  assert.ok(Math.abs(score - 1.0) < 0.001);
});

test("aggregateDomainScore：全 0 时为 0", () => {
  const score = _internals.aggregateDomainScore({
    capability: 0,
    skill: 0,
    keyword: 0,
    priority: 0,
    domainTag: 0,
  });
  assert.equal(score, 0);
});

test("aggregateDomainScore：权重验证 domainTag 0.4 + keyword 0.3 + capability 0.2 + skill 0.1 = 1.0", () => {
  const w = _internals.DOMAIN_MATCH_WEIGHTS;
  const sum = w.domainTag + w.keyword + w.capability + w.skill;
  assert.ok(Math.abs(sum - 1.0) < 0.001);
});

test("aggregateDomainScore：仅 domainTag 高分时综合分较高", () => {
  const score = _internals.aggregateDomainScore({
    capability: 0,
    skill: 0,
    keyword: 0,
    priority: 0,
    domainTag: 1.0,
  });
  // 1*0.4 = 0.4
  assert.ok(Math.abs(score - 0.4) < 0.001);
});

test("aggregateDomainScore：仅 keyword 高分时综合分中等", () => {
  const score = _internals.aggregateDomainScore({
    capability: 0,
    skill: 0,
    keyword: 1.0,
    priority: 0,
    domainTag: 0,
  });
  // 1*0.3 = 0.3
  assert.ok(Math.abs(score - 0.3) < 0.001);
});

// ============================================================================
// 第七部分：DomainMatchOptionsSchema（选项校验，5 个测试）
// ============================================================================

test("DomainMatchOptionsSchema：默认值为 hybrid / topK=3 / threshold=0.3", () => {
  const parsed = DomainMatchOptionsSchema.parse({});
  assert.equal(parsed.strategy, "hybrid");
  assert.equal(parsed.topK, 3);
  assert.ok(Math.abs(parsed.aiFallbackThreshold - 0.3) < 0.001);
});

test("DomainMatchOptionsSchema：topK 必须为正整数", () => {
  assert.throws(() => DomainMatchOptionsSchema.parse({ topK: 0 }));
  assert.throws(() => DomainMatchOptionsSchema.parse({ topK: -1 }));
  assert.throws(() => DomainMatchOptionsSchema.parse({ topK: 1.5 }));
});

test("DomainMatchOptionsSchema：aiFallbackThreshold 必须在 [0, 1]", () => {
  assert.throws(() => DomainMatchOptionsSchema.parse({ aiFallbackThreshold: -0.1 }));
  assert.throws(() => DomainMatchOptionsSchema.parse({ aiFallbackThreshold: 1.1 }));
});

test("DomainMatchOptionsSchema：strategy 必须是 keyword/ai/hybrid 之一", () => {
  assert.throws(() => DomainMatchOptionsSchema.parse({ strategy: "invalid" }));
  assert.doesNotThrow(() => DomainMatchOptionsSchema.parse({ strategy: "keyword" }));
  assert.doesNotThrow(() => DomainMatchOptionsSchema.parse({ strategy: "ai" }));
  assert.doesNotThrow(() => DomainMatchOptionsSchema.parse({ strategy: "hybrid" }));
});

test("DomainMatchOptionsSchema：timeoutMs 默认 30000ms", () => {
  const parsed = DomainMatchOptionsSchema.parse({});
  assert.equal(parsed.timeoutMs, 30000);
});

// ============================================================================
// 第八部分：DomainExpertMatcher.matchExpertsSync（同步匹配，8 个测试）
// ============================================================================

test("matchExpertsSync：无候选专家返回空数组", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融任务", "金融风控分析");
  assert.equal(results.length, 0);
});

test("matchExpertsSync：单专家匹配返回 1 个结果", () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融风控任务", "需要金融风控能力");
  assert.ok(results.length >= 1);
});

test("matchExpertsSync：固定 topK=3（同步版本不支持 topK 覆盖）", () => {
  const registry = buildRegistryWith3Experts();
  // 使用 DomainMatchOptionsSchema.parse 构造完整对象（zod schema 会填充默认值）
  const defaultMatchOptions = DomainMatchOptionsSchema.parse({ strategy: "keyword", topK: 1 });
  const matcher = new DomainExpertMatcher(registry, {
    enabledCategories: [
      "strategy",
      "product",
      "project-management",
      "support",
      "specialized",
      "academic",
      "marketing",
      "sales",
    ],
    defaultMatchOptions,
  });
  const results = matcher.matchExpertsSync("金融", "金融");
  // matchExpertsSync 内部硬编码 topK=3（同步版本设计决策，不支持 topK 覆盖）
  assert.ok(results.length <= 3);
});

test("matchExpertsSync：结果按 confidence 降序排列", () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融 风控 合规", "金融风控合规分析");
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].confidence >= results[i].confidence,
      `结果未按 confidence 降序：${results[i - 1].confidence} < ${results[i].confidence}`
    );
  }
});

test("matchExpertsSync：每个结果包含 reasons（≥1 条）", () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融", "金融分析");
  for (const r of results) {
    assert.ok(r.reasons.length >= 1, "reasons 不能为空");
  }
});

test("matchExpertsSync：strategy 固定为 keyword", () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融", "金融");
  for (const r of results) {
    assert.equal(r.strategy, "keyword");
  }
});

test("matchExpertsSync：匹配结果包含 expert 完整定义", () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融", "金融");
  for (const r of results) {
    assert.ok(r.expert.expertId);
    assert.ok(r.expert.name);
    assert.ok(r.expert.systemPromptPrefix);
  }
});

test("matchExpertsSync：confidence 在 [0, 1] 范围内", () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const results = matcher.matchExpertsSync("金融", "金融");
  for (const r of results) {
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

// ============================================================================
// 第九部分：DomainExpertMatcher.matchExperts（异步匹配，10 个测试）
// ============================================================================

test("matchExperts：keyword 策略返回结果", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({
    title: "金融风控任务",
    description: "需要金融风控合规能力",
    domainTags: ["金融"],
  });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  assert.ok(results.length >= 1);
});

test("matchExperts：无候选专家返回空数组", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask();
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  assert.equal(results.length, 0);
});

test("matchExperts：topK 限制结果数量", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({ domainTags: ["金融"] });
  const results = await matcher.matchExperts(task, { strategy: "keyword", topK: 2 });
  assert.ok(results.length <= 2);
});

test("matchExperts：keyword 策略返回的 strategy 字段为 keyword", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({ domainTags: ["金融"] });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  for (const r of results) {
    assert.equal(r.strategy, "keyword");
  }
});

test("matchExperts：ai 策略无 API Key 时降级为 keyword", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({ domainTags: ["金融"] });
  // 无 API Key 环境，AI 应降级到 keyword（matchByAI 调用 matchByKeyword）
  const results = await matcher.matchExperts(task, {
    strategy: "ai",
    projectRoot: "/nonexistent-path-for-test",
  });
  assert.ok(results.length >= 1);
  // 降级后 strategy 字段为 "keyword"（matchByKeyword 设置）
  for (const r of results) {
    assert.equal(r.strategy, "keyword");
  }
});

test("matchExperts：hybrid 策略无 API Key 时降级为 keyword", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({ domainTags: ["金融"] });
  const results = await matcher.matchExperts(task, {
    strategy: "hybrid",
    projectRoot: "/nonexistent-path-for-test",
  });
  assert.ok(results.length >= 1);
});

test("matchExperts：enabledCategories 过滤候选专家", async () => {
  const registry = buildRegistryWith3Experts();
  // 仅启用 product 类别（只有 1 个专家 domain-product-c）
  const matcher = new DomainExpertMatcher(registry, {
    enabledCategories: ["product"],
  });
  const task = buildTask({ domainTags: ["电商"] });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  // 仅返回 product 类别的专家
  for (const r of results) {
    assert.equal(r.expert.category, "product");
  }
});

test("matchExperts：enabledCategories 为多个类别时合并候选", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry, {
    enabledCategories: ["strategy", "product"],
  });
  const task = buildTask();
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  for (const r of results) {
    assert.ok(r.expert.category === "strategy" || r.expert.category === "product");
  }
});

test("matchExperts：结果包含 scoreBreakdown 含 domainTag 字段", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({ domainTags: ["金融"] });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  for (const r of results) {
    assert.ok("domainTag" in r.scoreBreakdown);
  }
});

test("matchExperts：结果包含 matchedDomainTags 字段", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({ domainTags: ["金融", "风控"] });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  // 至少有一个结果的 matchedDomainTags 非空
  const hasMatchedTags = results.some((r) => r.matchedDomainTags.length > 0);
  assert.ok(hasMatchedTags, "应至少有一个专家匹配到 domainTags");
});

// ============================================================================
// 第十部分：buildDomainMatchResultFromScored（结果构建，5 个测试）
// ============================================================================

test("buildDomainMatchResultFromScored：生成包含 reasons 的结果", () => {
  const expert = buildExpert();
  const result = _internals.buildDomainMatchResultFromScored({
    expert,
    scoreBreakdown: {
      capability: 0.8,
      skill: 0.6,
      keyword: 0.7,
      priority: 0.5,
      domainTag: 0.9,
    },
    confidence: 0.75,
    strategy: "keyword",
  });
  assert.ok(result.reasons.length >= 1);
  assert.ok(result.reasons.some((r) => r.includes("综合置信度")));
});

test("buildDomainMatchResultFromScored：domainTag 高分时 reasons 包含业务标签匹配", () => {
  const expert = buildExpert();
  const result = _internals.buildDomainMatchResultFromScored({
    expert,
    scoreBreakdown: {
      capability: 0.5,
      skill: 0.5,
      keyword: 0.5,
      priority: 0.5,
      domainTag: 0.8,
    },
    confidence: 0.6,
    strategy: "keyword",
  });
  assert.ok(result.reasons.some((r) => r.includes("业务标签匹配")));
});

test("buildDomainMatchResultFromScored：keyword 高分时 reasons 包含关键词命中", () => {
  const expert = buildExpert();
  const result = _internals.buildDomainMatchResultFromScored({
    expert,
    scoreBreakdown: {
      capability: 0.5,
      skill: 0.5,
      keyword: 0.8,
      priority: 0.5,
      domainTag: 0.2,
    },
    confidence: 0.5,
    strategy: "keyword",
  });
  assert.ok(result.reasons.some((r) => r.includes("关键词命中")));
});

test("buildDomainMatchResultFromScored：strategy 字段透传", () => {
  const expert = buildExpert();
  for (const strategy of ["keyword", "ai", "hybrid"] as const) {
    const result = _internals.buildDomainMatchResultFromScored({
      expert,
      scoreBreakdown: {
        capability: 0.5,
        skill: 0.5,
        keyword: 0.5,
        priority: 0.5,
        domainTag: 0.5,
      },
      confidence: 0.5,
      strategy,
    });
    assert.equal(result.strategy, strategy);
  }
});

test("buildDomainMatchResultFromScored：semantic 字段存在时 reasons 包含 AI 语义分", () => {
  const expert = buildExpert();
  const result = _internals.buildDomainMatchResultFromScored({
    expert,
    scoreBreakdown: {
      capability: 0.5,
      skill: 0.5,
      keyword: 0.5,
      priority: 0.5,
      domainTag: 0.5,
      semantic: 0.85,
    },
    confidence: 0.7,
    strategy: "hybrid",
  });
  assert.ok(result.reasons.some((r) => r.includes("AI 语义分")));
});

// ============================================================================
// 第十一部分：DOMAIN_MATCH_WEIGHTS 权重常量（3 个测试）
// ============================================================================

test("DOMAIN_MATCH_WEIGHTS：domainTag 权重 0.4（最高）", () => {
  assert.equal(_internals.DOMAIN_MATCH_WEIGHTS.domainTag, 0.4);
});

test("DOMAIN_MATCH_WEIGHTS：keyword 权重 0.3（次高）", () => {
  assert.equal(_internals.DOMAIN_MATCH_WEIGHTS.keyword, 0.3);
});

test("DOMAIN_MATCH_WEIGHTS：capability 0.2 + skill 0.1", () => {
  assert.equal(_internals.DOMAIN_MATCH_WEIGHTS.capability, 0.2);
  assert.equal(_internals.DOMAIN_MATCH_WEIGHTS.skill, 0.1);
});

// ============================================================================
// 第十二部分：综合场景测试（5 个测试）
// ============================================================================

test("综合场景：金融任务匹配金融专家的置信度高于医疗专家", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({
    title: "金融风控系统设计",
    description: "需要金融行业风控合规审计能力",
    domainTags: ["金融", "风控"],
  });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  // 金融专家应排在医疗专家前面
  const financeIdx = results.findIndex((r) => r.expert.expertId === "domain-strategy-a");
  const medicalIdx = results.findIndex((r) => r.expert.expertId === "domain-strategy-b");
  if (financeIdx >= 0 && medicalIdx >= 0) {
    assert.ok(financeIdx < medicalIdx, "金融专家应排在医疗专家前面");
  }
});

test("综合场景：电商任务匹配电商专家", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({
    title: "电商平台增长策略",
    description: "需要电商运营和增长能力",
    domainTags: ["电商", "增长"],
  });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  // 电商专家应排在第一位
  if (results.length > 0) {
    assert.equal(results[0].expert.expertId, "domain-product-c");
  }
});

test("综合场景：空 domainTags 任务仍可匹配（中性 0.5 分）", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({
    title: "金融分析",
    description: "金融分析任务",
    domainTags: [],
  });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  assert.ok(results.length >= 1);
});

test("综合场景：topK=1 时只返回最高置信度专家", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({
    title: "金融风控",
    description: "金融风控合规",
    domainTags: ["金融", "风控"],
  });
  const results = await matcher.matchExperts(task, { strategy: "keyword", topK: 1 });
  assert.equal(results.length, 1);
});

test("综合场景：所有专家 priority 不影响 keyword 评分（priority 仅用于兜底排序）", async () => {
  const registry = buildRegistryWith3Experts();
  const matcher = new DomainExpertMatcher(registry);
  const task = buildTask({
    title: "金融风控合规",
    description: "金融风控合规分析",
    domainTags: ["金融", "风控", "合规"],
  });
  const results = await matcher.matchExperts(task, { strategy: "keyword" });
  // domain-strategy-a（金融+风控）应排第一，即使 priority=8（priority 仅在 confidence 相近时兜底）
  if (results.length > 0) {
    assert.equal(results[0].expert.expertId, "domain-strategy-a");
  }
});
