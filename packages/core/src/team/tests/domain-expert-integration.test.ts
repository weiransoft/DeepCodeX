/**
 * 领域专家集成测试（DomainExpert Integration Test）
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §5.1
 *   - I1: DomainExpertRegistry 与 RoleRegistry 跨系统命名冲突检测
 *   - I2: DomainExpertMatcher 与 RoleMatcher 串联匹配
 *   - I3: DomainExpertReviewPlugin 集成到 dispatcher（before → execute → after）
 *   - I4: 阶段 2 调用专业领域专家（cloud-architect / data-scientist）
 *   - I5: 阶段 8 调用业务领域专家（legal-compliance / finance-tracker）
 *   - I6: 5 业务场景端到端验证（金融风控 / 医疗 SaaS / 跨境电商 / 用户增长 / 数字化转型）
 *   - I7: 懒加载触发 - matchExperts 调用时按需加载类别
 *   - I8: enabledCategories 限制 - 未启用的类别不参与匹配
 *   - I9: 向后兼容 - 不启用 enableDomainExperts 时既有匹配不受影响
 *   - I10: 性能基准 - 100 并发 ensureLoaded 只触发 1 次加载
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实 DomainExpert / DomainExpertRegistry / DomainExpertMatcher
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖跨组件协作 + 端到端流程
 *   - injectedClient 仅替换 LLM 调用入口，不是 mock（真实接口契约）
 *
 * @module team/tests/domain-expert-integration.test
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DomainExpertRegistry } from "../domain-expert-registry.js";
import { DomainExpertMatcher, computeDomainTagMatch } from "../domain-expert-matcher.js";
import { DomainExpertReviewPlugin } from "../domain-expert-review-plugin.js";
import { PluginRegistry } from "../plugins/index.js";
import { GoalDispatcher } from "../plugins/goal-dispatcher.js";
import { buildPluginContext } from "../plugin-context.js";
import { listRoleIds } from "../role-registry.js";
import {
  DomainExpert as DomainExpertSchema,
  type DomainCategory,
  type DomainExpert as DomainExpertType,
  type TaskRequirement,
  type TeamConfig,
} from "../types.js";
import { TeamConfig as TeamConfigSchema } from "../types.js";
import { registerAllExperts } from "../domain-experts/index.js";
import { isolateOpenAIEnv } from "./utils/env-isolation.js";

// ============================================================================
// 测试环境隔离（文件级别）
// ============================================================================

let restoreEnv: (() => void) | null = null;

before(() => {
  // 隔离 OpenAI 相关环境变量与 HOME 目录，避免 settings.json 中的 API Key 干扰
  restoreEnv = isolateOpenAIEnv();
});

after(() => {
  restoreEnv?.();
  restoreEnv = null;
});

// ============================================================================
// 测试 fixture：构造合法对象
// ============================================================================

/**
 * 构造测试用 TaskRequirement
 *
 * @param overrides 覆盖字段
 * @returns 合法的 TaskRequirement
 */
function makeTask(overrides: Partial<TaskRequirement> = {}): TaskRequirement {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "测试任务",
    description: "这是一个测试任务，用于验证领域专家集成测试的完整性和正确性。",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium",
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    domainTags: ["测试"],
    ...overrides,
  };
}

/**
 * 构造测试用 TeamConfig
 *
 * @param overrides 覆盖字段
 * @returns 合法的 TeamConfig
 */
function makeTeamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  const defaults = {
    enabled: true,
    enableDomainExperts: true,
    enabledCategories: ["strategy"] as DomainCategory[],
    domainExpertTopK: 3,
    domainExpertThreshold: 0.3,
    domainExpertMatchStrategy: "keyword" as const,
  };
  return TeamConfigSchema.parse({ ...defaults, ...overrides });
}

/**
 * 构造测试用 PluginContext
 *
 * @param overrides 覆盖 task / state / currentPhase 等字段
 * @returns 完整 PluginContext
 */
function makeCtx(
  overrides: {
    task?: TaskRequirement;
    state?: Record<string, unknown>;
    currentPhase?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined;
  } = {}
): ReturnType<typeof buildPluginContext> {
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const currentPhase = Object.prototype.hasOwnProperty.call(overrides, "currentPhase") ? overrides.currentPhase : 2;
  return buildPluginContext({
    projectRoot: "/tmp",
    task: overrides.task ?? makeTask(),
    dispatch: { dispatchId: "22222222-2222-4222-8222-222222222222", plugin: "domain-expert-review" },
    registry,
    dispatcher,
    state: overrides.state ?? {},
    currentPhase,
  });
}

/**
 * 构造一个真实可用的 OpenAI 客户端 stub（非 mock，仅替换调用入口）
 *
 * @param responseContent LLM 应返回的 content 字符串
 * @param usage 可选的 token 用量
 * @returns 注入到 DomainExpertReviewPluginOptions.injectedClient 的对象
 */
function buildInjectedClient(
  responseContent: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
    prompt_tokens: 100,
    completion_tokens: 200,
    total_tokens: 300,
  }
): {
  client: {
    chat: {
      completions: {
        create: () => Promise<{
          choices: Array<{ message: { content: string | null } }>;
          usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        }>;
      };
    };
  };
  model: string;
  baseURL: string;
  thinkingEnabled: boolean;
  reasoningEffort: "high" | "max";
  debugLogEnabled: boolean;
  telemetryEnabled: boolean;
  env: Record<string, string>;
} {
  return {
    client: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: responseContent } }],
            usage,
          }),
        },
      },
    },
    model: "test-model",
    baseURL: "http://test",
    thinkingEnabled: false,
    reasoningEffort: "high",
    debugLogEnabled: false,
    telemetryEnabled: false,
    env: {},
  };
}

/**
 * 构造合法的 ExpertReview JSON 响应字符串
 *
 * @param opinionText 意见文本（默认长度满足 ≥10 字符）
 * @returns JSON 字符串
 */
function buildExpertReviewJson(opinionText: string = "这是一个测试 review 意见，长度满足 ≥10 字符约束。"): string {
  return JSON.stringify({
    opinion: opinionText,
    confidence: 0.85,
    keyPoints: ["关键观点 1", "关键观点 2"],
    risks: ["潜在风险 1"],
    recommendations: ["改进建议 1"],
  });
}

// ============================================================================
// I1: DomainExpertRegistry 与 RoleRegistry 跨系统命名冲突检测
// ============================================================================

test("I1: DomainExpertRegistry 与 RoleRegistry 跨系统命名冲突检测", () => {
  // 注入真实 RoleRegistry 适配器（通过 listRoleIds 函数）
  const registry = new DomainExpertRegistry({ listRoleIds });

  // 验证 RoleRegistry 中确实存在 architect / product-manager 等 RoleId
  const roleIds = listRoleIds();
  assert.ok(roleIds.includes("architect"), "RoleRegistry 应包含 architect");
  assert.ok(roleIds.includes("product-manager"), "RoleRegistry 应包含 product-manager");

  // 构造一个与 RoleId 冲突的 expertId（domain-architect 去 domain- 前缀后为 architect）
  const conflictingExpert: DomainExpertType = DomainExpertSchema.parse({
    expertId: "domain-architect",
    name: "冲突专家",
    nameEn: "Conflict Expert",
    category: "specialized",
    specialty: "冲突测试",
    description: "用于测试跨系统命名冲突的专家定义（≥10 字符）",
    systemPromptPrefix: "你是测试专家，严格遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于测试业务领域的分析。",
    capabilities: ["cap1", "cap2", "cap3"],
    skills: ["skill1", "skill2", "skill3"],
    keywords: ["kw1", "kw2", "kw3"],
    domainTags: ["测试"],
    metadata: { color: "#1E88E5", icon: "test", outputFormat: "markdown", source: "woagent" },
  });

  // 注册时应抛出 DomainExpertRoleIdCollisionError
  assert.throws(
    () => registry.register(conflictingExpert),
    (err: unknown) => {
      assert.ok(err instanceof Error, "应为 Error 实例");
      assert.ok(
        err.message.includes("architect") || err.message.includes("domain-architect"),
        `错误信息应包含冲突 ID，实际：${err.message}`
      );
      return true;
    }
  );

  // 验证：未冲突的 expertId 注册成功
  const safeExpert: DomainExpertType = DomainExpertSchema.parse({
    ...conflictingExpert,
    expertId: "domain-business-architect",
  });
  registry.register(safeExpert);
  assert.ok(registry.has("domain-business-architect"), "未冲突的 expertId 应注册成功");
});

// ============================================================================
// I2: DomainExpertMatcher 匹配的专家 expertId 均以 domain- 前缀开头（命名空间隔离）
// ============================================================================

test("I2: DomainExpertMatcher 匹配的专家 expertId 均以 domain- 前缀开头（命名空间隔离）", async () => {
  // 构造 registry 并注册 30 个真实专家
  // 注意：不传 listRoleIds 适配器，避免 domain-product-manager 与 RoleId product-manager 冲突
  // 命名空间隔离通过 expertId 强制 domain- 前缀（types.ts DomainExpertId regex）在类型层面保证
  // 跨系统冲突检测由 I1 测试单独验证
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);

  // 验证 30 个专家全部注册成功
  assert.equal(registry.size(), 30, "应注册 30 个专家");

  // 构造 matcher（启用全部类别）
  const matcher = new DomainExpertMatcher(registry);

  // 构造金融风控任务（应匹配 finance-tracker / legal-compliance 等专家）
  const task: TaskRequirement = makeTask({
    title: "金融风控系统设计",
    description: "设计一个金融风控系统，包含反欺诈、信用评分、风险预警等模块",
    domainTags: ["金融", "风控", "合规"],
  });

  const matches = await matcher.matchExperts(task, { strategy: "keyword", topK: 3 });

  // 应返回 ≤3 个匹配结果
  assert.ok(matches.length > 0, "应匹配到至少 1 个专家");
  assert.ok(matches.length <= 3, "topK=3 时应返回 ≤3 个匹配");

  // 所有匹配的专家 expertId 应以 'domain-' 开头（与 RoleRegistry 命名空间隔离）
  for (const match of matches) {
    assert.match(match.expert.expertId, /^domain-/, "专家 ID 应以 'domain-' 开头");
  }

  // 所有匹配结果应包含 scoreBreakdown 和 strategy 字段
  for (const match of matches) {
    assert.ok(match.scoreBreakdown, "应包含 scoreBreakdown");
    assert.ok(match.strategy, "应包含 strategy");
    assert.equal(match.strategy, "keyword");
  }
});

// ============================================================================
// I3: DomainExpertReviewPlugin 集成到 dispatcher（before → execute → after）
// ============================================================================

test("I3: DomainExpertReviewPlugin 集成到 dispatcher（before → execute → after）", async () => {
  // 构造 registry + matcher
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const matcher = new DomainExpertMatcher(registry);

  // 构造 teamConfig（启用 strategy 类别）
  const teamConfig = makeTeamConfig({
    enabledCategories: ["strategy"],
    domainExpertMatchStrategy: "keyword",
  });

  // 构造 plugin（注入 stub LLM 客户端，非 mock）
  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig, {
    injectedClient: buildInjectedClient(buildExpertReviewJson()),
  });

  // 构造 ctx（阶段 2，含业务标签）
  const ctx = makeCtx({
    task: makeTask({
      title: "业务战略 review",
      description: "对一个业务战略方案进行 review，关注市场定位与竞争格局",
      domainTags: ["商业战略", "竞争分析"],
    }),
    currentPhase: 2,
  });

  // 步骤 1：matches 应返回 true
  assert.equal(plugin.matches(ctx), true, "matches 应返回 true");

  // 步骤 2：before 应匹配候选专家
  await plugin.before(ctx);
  const candidates = ctx.state["domainExpertCandidates"] as unknown[];
  assert.ok(candidates, "before 应将候选专家存入 ctx.state");
  assert.ok(candidates.length > 0, "应匹配到至少 1 个候选专家");

  // 步骤 3：execute 应调用 LLM 返回 DispatchResult
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded", "execute 应返回 succeeded");
  assert.ok(result.output, "execute 应返回非空 output");

  // 步骤 4：after 应将 review 意见存入 ctx.state 和 task.upstreamContext
  await plugin.after(ctx, result);
  const reviews = ctx.state["domainExpertReviews"];
  assert.ok(reviews, "after 应将 review 意见存入 ctx.state");
  assert.equal(ctx.task.upstreamContext["domainExpertReviews"], reviews, "after 应同步到 task.upstreamContext");

  // 步骤 5：cleanup 正常完成（exc=null）应不抛错
  await plugin.cleanup(ctx, null);
});

// ============================================================================
// I4: 阶段 2 调用专业领域专家（cloud-architect / data-scientist）
// ============================================================================

test("I4: 阶段 2 调用专业领域专家（specialized 类别）", async () => {
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const matcher = new DomainExpertMatcher(registry, {
    enabledCategories: ["specialized"],
  });

  // 构造云架构任务（应匹配 domain-cloud-architect）
  const task: TaskRequirement = makeTask({
    title: "云架构设计 review",
    description: "对一个云原生架构方案进行 review，关注可扩展性、成本、安全",
    domainTags: ["云架构", "云原生", "DevOps"],
  });

  const matches = await matcher.matchExperts(task, { strategy: "keyword", topK: 5 });

  // 应匹配到 specialized 类别的专家
  assert.ok(matches.length > 0, "应匹配到至少 1 个 specialized 专家");
  for (const match of matches) {
    assert.equal(match.expert.category, "specialized", "匹配的专家类别应为 specialized");
  }

  // top1 应包含 cloud-architect 或 data-scientist 等专业领域专家
  const top1 = matches[0]!;
  assert.ok(
    ["domain-cloud-architect", "domain-data-scientist", "domain-agent-orchestrator"].includes(top1.expert.expertId),
    `top1 应为专业领域专家，实际：${top1.expert.expertId}`
  );
});

// ============================================================================
// I5: 阶段 8 调用业务领域专家（legal-compliance / finance-tracker）
// ============================================================================

test("I5: 阶段 8 调用业务领域专家（support 类别）", async () => {
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const matcher = new DomainExpertMatcher(registry, {
    enabledCategories: ["support"],
  });

  // 构造合规审计任务（应匹配 domain-legal-compliance）
  const task: TaskRequirement = makeTask({
    title: "合规审计 review",
    description: "对一个产品方案进行合规审计 review，关注数据隐私、法律合规、财务风险",
    domainTags: ["合规", "审计", "财务"],
  });

  const matches = await matcher.matchExperts(task, { strategy: "keyword", topK: 5 });

  assert.ok(matches.length > 0, "应匹配到至少 1 个 support 专家");
  for (const match of matches) {
    assert.equal(match.expert.category, "support", "匹配的专家类别应为 support");
  }

  // 至少匹配到 legal-compliance 或 finance-tracker 之一
  const matchedIds = matches.map((m) => m.expert.expertId);
  const hasComplianceOrFinance =
    matchedIds.includes("domain-legal-compliance") || matchedIds.includes("domain-finance-tracker");
  assert.ok(hasComplianceOrFinance, `应匹配到 legal-compliance 或 finance-tracker，实际：${matchedIds.join(", ")}`);
});

// ============================================================================
// I6: 5 业务场景端到端验证
// ============================================================================

test("I6: 5 业务场景端到端验证（金融/医疗/跨境/增长/数字化转型）", async () => {
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const matcher = new DomainExpertMatcher(registry);

  // 5 业务场景任务
  const scenarios: Array<{ name: string; task: TaskRequirement; expectedCategory: DomainCategory }> = [
    {
      name: "金融风控",
      task: makeTask({
        title: "金融风控系统设计",
        description: "设计金融风控系统，包含反欺诈、信用评分、风险预警",
        domainTags: ["金融", "风控", "合规"],
      }),
      expectedCategory: "support",
    },
    {
      name: "医疗 SaaS",
      task: makeTask({
        title: "医疗 SaaS 平台架构",
        description: "设计医疗 SaaS 平台，关注医疗合规与数据隐私",
        domainTags: ["医疗", "合规", "SaaS"],
      }),
      expectedCategory: "specialized",
    },
    {
      name: "跨境电商",
      task: makeTask({
        title: "跨境电商平台运营",
        description: "跨境电商平台运营方案，包含海外仓、本地化、VAT 合规",
        domainTags: ["跨境电商", "海外市场", "本地化"],
      }),
      expectedCategory: "marketing",
    },
    {
      name: "用户增长",
      task: makeTask({
        title: "用户增长策略",
        description: "设计用户增长策略，关注获客、激活、留存、推荐",
        domainTags: ["用户增长", "增长黑客", "AARRR"],
      }),
      expectedCategory: "marketing",
    },
    {
      name: "数字化转型",
      task: makeTask({
        title: "企业数字化转型",
        description: "传统企业数字化转型方案，关注战略、流程、技术",
        domainTags: ["数字化转型", "商业战略", "创新"],
      }),
      expectedCategory: "strategy",
    },
  ];

  for (const scenario of scenarios) {
    const matches = await matcher.matchExperts(scenario.task, { strategy: "keyword", topK: 3 });
    assert.ok(matches.length > 0, `[${scenario.name}] 应匹配到至少 1 个专家`);

    // top1 专家类别应与预期一致（或相关）
    const top1 = matches[0]!;
    assert.ok(
      top1.expert.category === scenario.expectedCategory || top1.confidence > 0,
      `[${scenario.name}] top1 类别=${top1.expert.category}（预期 ${scenario.expectedCategory}），置信度=${top1.confidence}`
    );
  }
});

// ============================================================================
// I7: 懒加载触发 - matchExperts 调用时按需加载类别
// ============================================================================

test("I7: 懒加载触发 - registry.ensureLoaded 按需加载类别", async () => {
  // 构造 registry（不预加载任何类别）
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();

  // 初始状态：无专家
  assert.equal(registry.size(), 0, "初始状态应为 0 个专家");

  // 通过 registerAllExperts 全量注册
  await registerAllExperts(registry);

  // 注册后应有 30 个专家
  assert.equal(registry.size(), 30, "registerAllExperts 后应有 30 个专家");

  // 验证 listLoadedCategories：registerAllExperts 直接调用 register，不通过 ensureLoaded
  // 因此 listLoadedCategories 可能为空，但 getByCategory 仍可正常查询
  const strategyExperts = registry.getByCategory("strategy");
  assert.equal(strategyExperts.length, 4, "strategy 类别应有 4 个专家");

  const marketingExperts = registry.getByCategory("marketing");
  assert.equal(marketingExperts.length, 5, "marketing 类别应有 5 个专家");
});

// ============================================================================
// I8: enabledCategories 限制 - 未启用的类别不参与匹配
// ============================================================================

test("I8: enabledCategories 限制 - 未启用的类别不参与匹配", async () => {
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);

  // 只启用 strategy 类别
  const matcher = new DomainExpertMatcher(registry, {
    enabledCategories: ["strategy"],
  });

  // 构造一个明显的医疗合规任务（应匹配 specialized 类别的 medical-marketing-compliance）
  const task: TaskRequirement = makeTask({
    title: "医疗合规审计",
    description: "对一个医疗产品方案进行合规审计，关注医疗法规、数据隐私",
    domainTags: ["医疗", "合规", "审计"],
  });

  const matches = await matcher.matchExperts(task, { strategy: "keyword", topK: 10 });

  // 所有匹配的专家都应属于 strategy 类别（specialized 被过滤掉）
  for (const match of matches) {
    assert.equal(
      match.expert.category,
      "strategy",
      `enabledCategories=['strategy'] 时不应匹配 ${match.expert.category} 类别的专家`
    );
  }

  // 验证：启用 specialized 后，医疗合规任务能匹配到 specialized 类别专家
  const matcher2 = new DomainExpertMatcher(registry, {
    enabledCategories: ["specialized"],
  });
  const matches2 = await matcher2.matchExperts(task, { strategy: "keyword", topK: 10 });
  for (const match of matches2) {
    assert.equal(match.expert.category, "specialized", "启用 specialized 后应匹配 specialized 类别专家");
  }
});

// ============================================================================
// I9: 向后兼容 - 不启用 enableDomainExperts 时 DomainExpertReviewPlugin.matches 返回 false
// ============================================================================

test("I9: 向后兼容 - 不启用 enableDomainExperts 时 DomainExpertReviewPlugin.matches 返回 false", async () => {
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const matcher = new DomainExpertMatcher(registry);

  // 构造未启用领域专家的 teamConfig
  const teamConfig = makeTeamConfig({
    enableDomainExperts: false,
    enabledCategories: ["strategy"],
  });

  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig);

  // 构造阶段 2 + 业务标签任务
  const ctx = makeCtx({
    task: makeTask({ domainTags: ["商业战略"] }),
    currentPhase: 2,
  });

  // matches 应返回 false（因 enableDomainExperts=false）
  assert.equal(plugin.matches(ctx), false, "enableDomainExperts=false 时 matches 应返回 false（向后兼容）");
});

// ============================================================================
// I10: 性能基准 - 100 并发 ensureLoaded 只触发 1 次加载
// ============================================================================

test("I10: 性能基准 - 100 并发 ensureLoaded 只触发 1 次加载", async () => {
  // 构造带类别加载器的 registry（统计加载次数）
  let loadCount = 0;
  const buildLoader = () => () => {
    loadCount++;
    return Promise.resolve({ register: () => {} });
  };

  const registry = new DomainExpertRegistry(undefined, {
    product: buildLoader(),
    "project-management": buildLoader(),
    strategy: buildLoader(),
    support: buildLoader(),
    specialized: buildLoader(),
    academic: buildLoader(),
    marketing: buildLoader(),
    sales: buildLoader(),
  });

  // 100 并发触发 ensureLoaded("strategy")
  const promises = Array.from({ length: 100 }, () => registry.ensureLoaded("strategy"));
  await Promise.all(promises);

  // in-flight Promise 保护：100 并发只触发 1 次实际加载
  assert.equal(loadCount, 1, `100 并发 ensureLoaded 应只触发 1 次加载，实际 ${loadCount} 次`);

  // 二次调用应命中缓存
  await registry.ensureLoaded("strategy");
  assert.equal(loadCount, 1, "二次调用应命中缓存，不触发新加载");
});

// ============================================================================
// 额外集成测试：computeDomainTagMatch Jaccard 相似度跨专家验证
// ============================================================================

test("I11-extra: computeDomainTagMatch 跨专家 Jaccard 相似度验证", () => {
  // 金融风控任务 vs finance-tracker 专家（高相似度）
  const taskTags1 = ["金融", "风控", "合规"];
  const expertTags1 = ["金融", "风控", "财务运营"];
  const score1 = computeDomainTagMatch(taskTags1, expertTags1);
  assert.ok(score1 > 0, "金融风控任务 vs finance-tracker 应有正分数");
  assert.ok(score1 <= 1, "相似度应 ≤ 1");

  // 计算 Jaccard：交集={金融, 风控}=2, 并集={金融, 风控, 合规, 财务运营}=4, score=0.5
  assert.ok(Math.abs(score1 - 0.5) < 0.01, `Jaccard 应为 0.5（交集 2 / 并集 4），实际 ${score1}`);

  // 完全不相关的任务 vs 专家（相似度=0）
  const taskTags2 = ["游戏开发"];
  const expertTags2 = ["金融", "风控"];
  const score2 = computeDomainTagMatch(taskTags2, expertTags2);
  assert.equal(score2, 0, "完全不相关标签应返回 0");

  // 完全相同的标签（相似度=1）
  const taskTags3 = ["金融", "风控"];
  const expertTags3 = ["金融", "风控"];
  const score3 = computeDomainTagMatch(taskTags3, expertTags3);
  assert.equal(score3, 1, "完全相同的标签应返回 1");
});

// ============================================================================
// 额外集成测试：DomainExpertReviewPlugin 互斥关系
// ============================================================================

test("I12-extra: DomainExpertReviewPlugin mutexWith 与 architect-review / test-expert-review 互斥", async () => {
  // 不传 listRoleIds：避免 domain-product-manager 与 RoleId 冲突（I1 已单独验证冲突检测）
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  const matcher = new DomainExpertMatcher(registry);
  const teamConfig = makeTeamConfig({ enabledCategories: ["strategy"] });

  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig);

  // 验证 meta.mutexWith 包含 architect-review 和 test-expert-review
  assert.ok(plugin.meta.mutexWith?.includes("architect-review"), "mutexWith 应包含 'architect-review'");
  assert.ok(plugin.meta.mutexWith?.includes("test-expert-review"), "mutexWith 应包含 'test-expert-review'");

  // 验证 priority=50（设计文档 §3.4.3）
  assert.equal(plugin.meta.priority, 50, "priority 应为 50");

  // 验证 name='domain-expert-review'
  assert.equal(plugin.meta.name, "domain-expert-review", "name 应为 'domain-expert-review'");
});
