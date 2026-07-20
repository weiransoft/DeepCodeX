/**
 * Team 模块类型测试
 *
 * 验证 types.ts 的 zod schema 严格性，确保 P0 类型定义无简化
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RoleId,
  RoleDefinition,
  TaskRequirement,
  MatchResult,
  DispatchResult,
  TeamConfig,
  ALL_SCHEMAS,
  // v1.1 新增：领域专家 schema
  DomainCategory,
  DomainExpertId,
  DomainExpert,
  DomainExpertMatchResult,
  ExpertOpinion,
  DomainExpertDispatchResult,
} from "../types.js";

test("RoleId accepts 5 valid role ids", () => {
  const validIds = ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"];
  for (const id of validIds) {
    assert.equal(RoleId.parse(id), id);
  }
});

test("RoleId rejects unknown role id", () => {
  assert.throws(() => RoleId.parse("invalid-role"));
});

test("RoleDefinition requires min 3 capabilities and skills", () => {
  const baseDef = {
    roleId: "architect" as const,
    name: "架构师",
    nameEn: "Architect",
    description: "负责系统架构设计相关工作",
    systemPromptPrefix: "x".repeat(60),
    systemPromptSuffix: "",
    capabilities: ["ab", "bc", "cd"],
    skills: ["xx", "yy", "zz"],
    keywords: ["k1", "k2", "k3"],
    priority: 5,
    metadata: {
      color: "#0d47a1",
      icon: "🏛️",
      outputFormat: "markdown" as const,
      enabledByDefault: true,
    },
  };
  assert.deepEqual(RoleDefinition.parse(baseDef).roleId, "architect");

  // 缺少能力
  const invalid = { ...baseDef, capabilities: ["a"] };
  assert.throws(() => RoleDefinition.parse(invalid));
});

test("TaskRequirement rejects missing required fields", () => {
  assert.throws(() => TaskRequirement.parse({}));
  assert.throws(() => TaskRequirement.parse({ title: "t" }));
});

test("TaskRequirement accepts complete task", () => {
  const task = {
    taskId: "12345678-1234-4123-8123-123456789012",
    title: "Test task",
    description: "Test description longer than 10 chars",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium" as const,
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
  };
  const parsed = TaskRequirement.parse(task);
  assert.equal(parsed.priority, "medium");
});

test("MatchResult requires reasons min length 1", () => {
  const baseMatch = {
    roleId: "solo-coder" as const,
    roleName: "独立开发者",
    confidence: 0.8,
    matchedCapabilities: ["code-implementation"],
    matchedSkills: ["TypeScript"],
    missingCapabilities: [],
    reasons: ["test reason"],
    scoreBreakdown: {
      capability: 0.8,
      skill: 0.7,
      keyword: 0.6,
      priority: 0.8,
    },
    strategy: "keyword" as const,
  };
  const parsed = MatchResult.parse(baseMatch);
  assert.equal(parsed.confidence, 0.8);

  // 缺少 reasons
  const invalid = { ...baseMatch, reasons: [] };
  assert.throws(() => MatchResult.parse(invalid));
});

test("MatchResult rejects confidence > 1", () => {
  const baseMatch = {
    roleId: "solo-coder" as const,
    roleName: "独立开发者",
    confidence: 1.5, // 越界
    matchedCapabilities: [],
    matchedSkills: [],
    missingCapabilities: [],
    reasons: ["test"],
    scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
    strategy: "keyword" as const,
  };
  assert.throws(() => MatchResult.parse(baseMatch));
});

test("DispatchResult accepts all 8 status", () => {
  const statuses = ["pending", "running", "succeeded", "failed", "timeout", "cancelled", "paused", "retrying"];
  for (const status of statuses) {
    const base = {
      taskId: "12345678-1234-4123-8123-123456789012",
      dispatchId: "23456789-2345-4234-8234-234567890123",
      matchedRole: {
        roleId: "solo-coder" as const,
        roleName: "独立开发者",
        confidence: 0.8,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: ["r"],
        scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
        strategy: "keyword" as const,
      },
      status,
      startedAt: new Date().toISOString(),
      durationMs: 100,
      artifacts: [],
      tokensConsumed: { prompt: 0, completion: 0, total: 0 },
      cacheHit: false,
      retryCount: 0,
    };
    const parsed = DispatchResult.parse(base);
    assert.equal(parsed.status, status);
  }
});

test("TeamConfig applies defaults when empty", () => {
  const parsed = TeamConfig.parse({});
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.matchStrategy, "hybrid");
  assert.equal(parsed.topK, 3);
  assert.equal(parsed.defaultRole, "solo-coder");
  assert.equal(parsed.ponytailMode, "full");
  // v1.1 新增：领域专家字段默认值（设计文档 §3.1 P1-6：默认禁用 + 空启用类别）
  assert.equal(parsed.enableDomainExperts, false, "enableDomainExperts 默认应为 false");
  assert.equal(parsed.domainExpertTopK, 3, "domainExpertTopK 默认应为 3");
  assert.equal(parsed.domainExpertThreshold, 0.3, "domainExpertThreshold 默认应为 0.3");
  assert.deepEqual(parsed.enabledCategories, [], "enabledCategories 默认应为空数组");
  assert.equal(parsed.domainExpertMatchStrategy, "hybrid", "domainExpertMatchStrategy 默认应为 hybrid");
});

test("TeamConfig v1.1 领域专家字段可显式启用", () => {
  // 验证用户显式开启领域专家的配置路径
  const parsed = TeamConfig.parse({
    enableDomainExperts: true,
    enabledCategories: ["product", "strategy"],
    domainExpertTopK: 5,
    domainExpertThreshold: 0.5,
    domainExpertMatchStrategy: "keyword",
  });
  assert.equal(parsed.enableDomainExperts, true);
  assert.deepEqual(parsed.enabledCategories, ["product", "strategy"]);
  assert.equal(parsed.domainExpertTopK, 5);
  assert.equal(parsed.domainExpertThreshold, 0.5);
  assert.equal(parsed.domainExpertMatchStrategy, "keyword");
});

test("TeamConfig v1.1 enabledCategories 拒绝无效类别", () => {
  // 无效类别应被 zod enum 拒绝
  assert.throws(() =>
    TeamConfig.parse({
      enableDomainExperts: true,
      enabledCategories: ["invalid-category"],
    })
  );
});

test("TeamConfig ponytailMode only accepts literal 'full'", () => {
  const parsed = TeamConfig.parse({ ponytailMode: "full" });
  assert.equal(parsed.ponytailMode, "full");
  assert.throws(() => TeamConfig.parse({ ponytailMode: "lite" }));
});

test("ALL_SCHEMAS exports ≥25 schemas (含 v1.1 领域专家 8 个)", () => {
  const keys = Object.keys(ALL_SCHEMAS);
  // v1.0: 17 个核心 schema + v1.1: 8 个领域专家 schema = 25
  // 领域专家 schema：DomainCategory / DomainExpertId / DomainExpert / DomainExpertMatchResult /
  //                 DomainMatchOptions / DomainMatcherOptions / ExpertOpinion / DomainExpertDispatchResult
  assert.ok(keys.length >= 25, `Expected ≥25 schemas, got ${keys.length}: ${keys.join(",")}`);
  // v1.1 新增：明确验证领域专家 schema 已导出
  const requiredDomainSchemas = [
    "DomainCategory",
    "DomainExpertId",
    "DomainExpert",
    "DomainExpertMatchResult",
    "DomainMatchOptions",
    "DomainMatcherOptions",
    "ExpertOpinion",
    "DomainExpertDispatchResult",
  ];
  for (const name of requiredDomainSchemas) {
    assert.ok(keys.includes(name), `ALL_SCHEMAS 缺少 v1.1 领域专家 schema: ${name}`);
  }
});

// ============================================================================
// v1.1 新增：领域专家 schema 严格性测试（Phase 1 验证）
// ============================================================================

test("DomainCategory 接受 8 个有效类别", () => {
  const validCategories = [
    "product",
    "project-management",
    "strategy",
    "support",
    "specialized",
    "academic",
    "marketing",
    "sales",
  ];
  for (const cat of validCategories) {
    assert.equal(DomainCategory.parse(cat), cat);
  }
});

test("DomainCategory 拒绝无效类别", () => {
  assert.throws(() => DomainCategory.parse("invalid"));
  assert.throws(() => DomainCategory.parse("investment")); // 设计文档 §2.1 明确不纳入
  assert.throws(() => DomainCategory.parse("engineering")); // 与现有 5 角色重叠
});

test("DomainExpertId 强制 domain- 前缀（P1-1）", () => {
  // 合法 ID
  assert.equal(DomainExpertId.parse("domain-product-manager"), "domain-product-manager");
  assert.equal(DomainExpertId.parse("domain-cloud-architect"), "domain-cloud-architect");
  assert.equal(DomainExpertId.parse("domain-legal-compliance"), "domain-legal-compliance");
  // 非法 ID：缺少 domain- 前缀
  assert.throws(() => DomainExpertId.parse("product-manager"), /domain-/);
  assert.throws(() => DomainExpertId.parse("architect"), /domain-/);
  // 非法 ID：包含大写字母
  assert.throws(() => DomainExpertId.parse("domain-ProductManager"));
  // 非法 ID：包含下划线（kebab-case 要求连字符）
  assert.throws(() => DomainExpertId.parse("domain_product_manager"));
});

test("DomainExpert 要求完整字段（P0-2 字段对齐 RoleDefinition）", () => {
  const validExpert = {
    expertId: "domain-business-strategist",
    name: "商业策略师",
    nameEn: "Business Strategist",
    category: "strategy",
    specialty: "商业战略规划",
    description: "负责企业商业战略制定与竞争分析",
    systemPromptPrefix: "你是商业策略专家，遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于商业战略分析。",
    capabilities: ["business-strategy-design", "competitive-analysis", "market-research"],
    skills: ["SWOT", "Porter-5-Forces", "BCG-Matrix"],
    keywords: ["战略", "商业模式", "竞争"],
    domainTags: ["战略", "商业"],
    metadata: {
      color: "#1E88E5",
      icon: "strategy",
      outputFormat: "markdown",
      source: "woagent",
    },
  };
  const parsed = DomainExpert.parse(validExpert);
  assert.equal(parsed.expertId, "domain-business-strategist");
  assert.equal(parsed.priority, 5, "priority 默认应为 5");
  assert.equal(parsed.systemPromptSuffix, "", "systemPromptSuffix 默认应为空字符串");
  assert.deepEqual(parsed.mutex, [], "mutex 默认应为空数组");
  assert.deepEqual(parsed.dependsOn, [], "dependsOn 默认应为空数组");
  assert.equal(parsed.metadata.version, "1.0.0", "version 默认应为 1.0.0");
  assert.equal(parsed.metadata.enabledByDefault, true, "enabledByDefault 默认应为 true");
});

test("DomainExpert 拒绝缺少必填字段", () => {
  // 缺少 expertId
  assert.throws(() =>
    DomainExpert.parse({
      name: "测试专家",
      nameEn: "Test Expert",
      category: "strategy",
      specialty: "测试",
      description: "测试专家描述内容",
      systemPromptPrefix: "你是测试专家，遵循 Karpathy 4 原则与 Ponytail 16 红线。",
      capabilities: ["cap1", "cap2", "cap3"],
      skills: ["skill1", "skill2", "skill3"],
      keywords: ["kw1", "kw2", "kw3"],
      domainTags: ["测试"],
      metadata: { color: "#000000", icon: "test", outputFormat: "markdown", source: "woagent" },
    })
  );
  // 缺少 domainTags（≥1 个）
  assert.throws(() =>
    DomainExpert.parse({
      expertId: "domain-test",
      name: "测试专家",
      nameEn: "Test Expert",
      category: "strategy",
      specialty: "测试",
      description: "测试专家描述内容",
      systemPromptPrefix: "你是测试专家，遵循 Karpathy 4 原则与 Ponytail 16 红线。",
      capabilities: ["cap1", "cap2", "cap3"],
      skills: ["skill1", "skill2", "skill3"],
      keywords: ["kw1", "kw2", "kw3"],
      domainTags: [],
      metadata: { color: "#000000", icon: "test", outputFormat: "markdown", source: "woagent" },
    })
  );
  // capabilities 少于 3 个
  assert.throws(() =>
    DomainExpert.parse({
      expertId: "domain-test",
      name: "测试专家",
      nameEn: "Test Expert",
      category: "strategy",
      specialty: "测试",
      description: "测试专家描述内容",
      systemPromptPrefix: "你是测试专家，遵循 Karpathy 4 原则与 Ponytail 16 红线。",
      capabilities: ["cap1"],
      skills: ["skill1", "skill2", "skill3"],
      keywords: ["kw1", "kw2", "kw3"],
      domainTags: ["测试"],
      metadata: { color: "#000000", icon: "test", outputFormat: "markdown", source: "woagent" },
    })
  );
});

test("DomainExpert metadata.source 限定 woagent/custom", () => {
  assert.throws(() =>
    DomainExpert.parse({
      expertId: "domain-test",
      name: "测试专家",
      nameEn: "Test Expert",
      category: "strategy",
      specialty: "测试",
      description: "测试专家描述内容",
      systemPromptPrefix: "你是测试专家，遵循 Karpathy 4 原则与 Ponytail 16 红线。",
      capabilities: ["cap1", "cap2", "cap3"],
      skills: ["skill1", "skill2", "skill3"],
      keywords: ["kw1", "kw2", "kw3"],
      domainTags: ["测试"],
      metadata: { color: "#000000", icon: "test", outputFormat: "markdown", source: "unknown" },
    })
  );
});

test("DomainExpert metadata.version 限定 semver 格式", () => {
  // 合法 semver
  const validBase = {
    expertId: "domain-test",
    name: "测试专家",
    nameEn: "Test Expert",
    category: "strategy",
    specialty: "测试",
    description: "测试专家描述内容（≥10 字符）",
    systemPromptPrefix:
      "你是测试专家，严格遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于测试业务领域的分析与验证工作。",
    capabilities: ["cap1", "cap2", "cap3"],
    skills: ["skill1", "skill2", "skill3"],
    keywords: ["kw1", "kw2", "kw3"],
    domainTags: ["测试"],
    metadata: { color: "#000000", icon: "test", outputFormat: "markdown", source: "woagent" },
  };
  assert.equal(
    DomainExpert.parse({ ...validBase, metadata: { ...validBase.metadata, version: "2.1.0" } }).metadata.version,
    "2.1.0"
  );
  // 非法 semver
  assert.throws(() =>
    DomainExpert.parse({
      ...validBase,
      metadata: { ...validBase.metadata, version: "v1.0" },
    })
  );
  assert.throws(() =>
    DomainExpert.parse({
      ...validBase,
      metadata: { ...validBase.metadata, version: "1.0" },
    })
  );
});

test("TaskRequirement v1.1 domainTags 默认空数组", () => {
  const task = TaskRequirement.parse({
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "测试任务",
    description: "这是一个测试任务描述内容",
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(task.domainTags, [], "domainTags 默认应为空数组");
});

test("TaskRequirement v1.1 domainTags 可显式指定", () => {
  const task = TaskRequirement.parse({
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "金融风控系统",
    description: "设计金融风控系统，包含反欺诈、信用评分、AML 三个模块",
    domainTags: ["金融", "风控", "合规"],
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(task.domainTags, ["金融", "风控", "合规"]);
});

test("ScoreBreakdown v1.1 domainTag 字段可选", () => {
  // 既有 RoleMatcher 输出不带 domainTag（向后兼容）
  const roleMatcherScore: import("../types.js").ScoreBreakdown = {
    capability: 0.8,
    skill: 0.6,
    keyword: 0.4,
    priority: 0.5,
  };
  // DomainExpertMatcher 输出带 domainTag
  const domainExpertScore: import("../types.js").ScoreBreakdown = {
    capability: 0.8,
    skill: 0.6,
    keyword: 0.4,
    priority: 0.5,
    domainTag: 0.7,
  };
  assert.equal(roleMatcherScore.domainTag, undefined);
  assert.equal(domainExpertScore.domainTag, 0.7);
});

test("ExpertOpinion 要求完整字段", () => {
  const validOpinion = {
    expertId: "domain-legal-compliance",
    expertName: "合规审计工程师",
    opinion: "该方案存在合规风险：未明确数据跨境传输的法律依据",
    confidence: 0.85,
    keyPoints: ["数据跨境传输需符合 GDPR", "需进行 DPIA 评估"],
    risks: ["合规处罚风险", "用户隐私泄露风险"],
    recommendations: ["补充 DPIA 评估报告", "明确数据传输法律依据"],
  };
  const parsed = ExpertOpinion.parse(validOpinion);
  assert.equal(parsed.expertId, "domain-legal-compliance");
  assert.equal(parsed.confidence, 0.85);
  assert.deepEqual(parsed.keyPoints, validOpinion.keyPoints);
  // 缺少 opinion 字段
  assert.throws(() =>
    ExpertOpinion.parse({
      expertId: "domain-test",
      expertName: "测试",
      opinion: "",
      confidence: 0.5,
    })
  );
});

test("DomainExpertDispatchResult 支持多专家汇总（P1-NEW-4）", () => {
  const validResult = {
    taskId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "22222222-2222-4222-8222-222222222222",
    matchedExperts: [
      {
        expert: {
          expertId: "domain-business-strategist",
          name: "商业策略师",
          nameEn: "Business Strategist",
          category: "strategy",
          specialty: "商业战略",
          description: "负责企业商业战略制定",
          systemPromptPrefix: "你是商业策略专家，遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于商业战略分析。",
          capabilities: ["cap1", "cap2", "cap3"],
          skills: ["skill1", "skill2", "skill3"],
          keywords: ["战略", "商业模式", "竞争"],
          domainTags: ["战略"],
          metadata: { color: "#1E88E5", icon: "strategy", outputFormat: "markdown", source: "woagent" },
        },
        confidence: 0.85,
        scoreBreakdown: { capability: 0.8, skill: 0.7, keyword: 0.9, priority: 0.5, domainTag: 0.9 },
        strategy: "hybrid",
        reasons: ["业务标签命中战略", "关键词命中商业模式"],
      },
    ],
    status: "succeeded",
    startedAt: new Date().toISOString(),
  };
  const parsed = DomainExpertDispatchResult.parse(validResult);
  assert.equal(parsed.matchedExperts.length, 1);
  assert.equal(parsed.matchedExperts[0].expert.expertId, "domain-business-strategist");
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.durationMs, 0, "durationMs 默认应为 0");
  assert.equal(parsed.cacheHit, false, "cacheHit 默认应为 false");
});
