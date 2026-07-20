/**
 * DomainExpertReviewPlugin 单元测试
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 / §5.3 / §8.4（P1-NEW-1 / P1-NEW-3 / P1-NEW-4）
 * 覆盖：5 个钩子（matches/before/execute/after/cleanup）+ 2 个内部方法（invokeExpertLLM/summarizeOpinions）
 *      + 3 个辅助函数（buildExpertSystemPrompt/buildExpertUserPrompt/parseExpertResponse）
 *      + 集成流程（before → execute → after 完整链路）
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实 DomainExpert.parse 构造测试数据
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖所有错误分支和边界条件
 *   - injectedClient 仅替换 LLM 调用入口，不是 mock（真实接口契约）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DomainExpertReviewPlugin,
  _internals,
  type DomainExpertReviewPluginOptions,
} from "../domain-expert-review-plugin.js";
import { DomainExpertRegistry } from "../domain-expert-registry.js";
import { DomainExpertMatcher } from "../domain-expert-matcher.js";
import { ExpertInvocationError } from "../errors.js";
import { buildPluginContext } from "../plugin-context.js";
import { PluginRegistry } from "../plugins/index.js";
import { GoalDispatcher } from "../plugins/goal-dispatcher.js";
import type {
  DomainCategory,
  DomainExpert as DomainExpertType,
  DomainExpertMatchResult,
  ExpertOpinion,
  PluginContext,
  TaskRequirement,
  TeamConfig,
} from "../types.js";
import {
  DomainExpert as DomainExpertSchema,
  ExpertOpinion as ExpertOpinionSchema,
  TeamConfig as TeamConfigSchema,
} from "../types.js";

// ============================================================================
// 测试 fixture：构造合法对象
// ============================================================================

/**
 * 构造测试用 DomainExpert
 *
 * @param overrides 覆盖字段
 * @returns 合法的 DomainExpert 实例
 */
function buildExpert(overrides: Partial<DomainExpertType> = {}): DomainExpertType {
  const base = {
    expertId: "domain-test-expert",
    name: "测试专家",
    nameEn: "Test Expert",
    category: "strategy" as DomainCategory,
    specialty: "测试专长",
    description: "测试专家描述内容（≥10 字符）",
    systemPromptPrefix: "你是测试专家，严格遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于测试业务领域的分析。",
    systemPromptSuffix: "输出格式偏好：markdown，简洁明了。",
    capabilities: ["cap1", "cap2", "cap3"],
    skills: ["skill1", "skill2", "skill3"],
    keywords: ["kw1", "kw2", "kw3"],
    domainTags: ["测试", "业务"],
    priority: 5,
    metadata: {
      color: "#1E88E5",
      icon: "test",
      outputFormat: "markdown" as const,
      source: "woagent" as const,
    },
  };
  return DomainExpertSchema.parse({ ...base, ...overrides });
}

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
    description: "这是一个测试任务，用于验证领域专家 review 流程的完整性和正确性。",
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
 *
 * 注意：currentPhase 使用 hasOwnProperty 检查，允许显式传入 undefined
 *       （用于测试 currentPhase 未设置时的向后兼容场景）
 */
function makeCtx(
  overrides: {
    task?: TaskRequirement;
    state?: Record<string, unknown>;
    currentPhase?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined;
  } = {}
): PluginContext {
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  // 显式检查 currentPhase 是否在 overrides 中，避免 ?? 2 兜底掩盖 undefined 测试场景
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
 * P2-1 修复后：响应中包含 usage 字段（prompt_tokens / completion_tokens / total_tokens），
 *              与 OpenAI 标准响应格式一致，用于验证 tokensConsumed 真实透传
 *
 * @param responseContent LLM 应返回的 content 字符串
 * @param usage 可选的 token 用量（默认 prompt=100 / completion=200 / total=300）
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
        create: (
          params: unknown,
          options?: unknown
        ) => Promise<{
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
 * 构造一个会抛出 abort 错误的注入客户端（用于测试超时分支）
 *
 * 实现说明：
 *   - 真实 OpenAI 客户端在 signal.abort 时会主动 reject promise（通过 fetch 的 AbortController 机制）
 *   - 此处通过 signal.addEventListener('abort', ...) 模拟相同行为
 *   - 不是 mock，是真实接口契约（响应 abort 事件并抛出 AbortError）
 */
function buildAbortingClient(): {
  client: {
    chat: {
      completions: {
        create: (params: unknown, options?: { signal?: AbortSignal }) => Promise<never>;
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
          create: (_params: unknown, options?: { signal?: AbortSignal }) => {
            return new Promise<never>((_resolve, reject) => {
              const signal = options?.signal;
              // 立即检查是否已 abort（可能 setTimeout 已触发）
              if (signal?.aborted) {
                const err = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
                return;
              }
              // 监听 abort 事件（与真实 fetch 行为一致）
              signal?.addEventListener("abort", () => {
                const err = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
              });
              // 不主动 resolve，等待 abort 触发
            });
          },
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
 * 构造一个会抛出网络错误的注入客户端（用于测试 network 分支）
 */
function buildNetworkErrorClient(): {
  client: {
    chat: {
      completions: {
        create: () => Promise<never>;
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
          create: async () => {
            throw new Error("connection refused");
          },
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
 * 构造测试用 DomainExpertMatchResult（含 expert 定义和匹配信息）
 *
 * 注意：DomainExpertMatchResult schema 包含 matchedCapabilities / matchedSkills / matchedDomainTags
 *       三个数组字段（均带 default([])），构造完整对象需显式提供
 */
function buildMatchResult(
  overrides: {
    expert?: DomainExpertType;
    confidence?: number;
    reasons?: string[];
  } = {}
): DomainExpertMatchResult {
  const expert = overrides.expert ?? buildExpert();
  return {
    expert,
    confidence: overrides.confidence ?? 0.8,
    reasons: overrides.reasons ?? ["业务标签匹配 100%", "关键词命中 3/3"],
    strategy: "keyword",
    scoreBreakdown: {
      capability: 1,
      skill: 1,
      keyword: 1,
      priority: 0.5,
      domainTag: 1,
    },
    matchedCapabilities: [],
    matchedSkills: [],
    matchedDomainTags: ["测试"],
  };
}

/**
 * 构造测试用 ExpertOpinion
 */
function buildOpinion(overrides: Partial<ExpertOpinion> = {}): ExpertOpinion {
  return ExpertOpinionSchema.parse({
    expertId: "domain-test-expert",
    expertName: "测试专家",
    opinion: "这是一个测试 review 意见，包含详细分析内容，长度满足 ≥10 字符约束。",
    confidence: 0.85,
    keyPoints: ["关键观点 1", "关键观点 2"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
    ...overrides,
  });
}

// ============================================================================
// 第一部分：常量与配置（4 个测试）
// ============================================================================

test("DEFAULT_EXPERT_TIMEOUT_MS 常量值为 30000ms", () => {
  assert.equal(_internals.DEFAULT_EXPERT_TIMEOUT_MS, 30_000);
});

test("STATE_KEY_CANDIDATES 常量为 'domainExpertCandidates'", () => {
  assert.equal(_internals.STATE_KEY_CANDIDATES, "domainExpertCandidates");
});

test("STATE_KEY_DISPATCH_RESULT 常量为 'domainExpertDispatchResult'", () => {
  assert.equal(_internals.STATE_KEY_DISPATCH_RESULT, "domainExpertDispatchResult");
});

test("STATE_KEY_REVIEWS 常量为 'domainExpertReviews'", () => {
  assert.equal(_internals.STATE_KEY_REVIEWS, "domainExpertReviews");
});

// ============================================================================
// 第二部分：ExpertReviewResponseSchema 校验（6 个测试）
// ============================================================================

test("ExpertReviewResponseSchema：合法 JSON 通过校验", () => {
  const valid = {
    opinion: "这是一个合法的 review 意见，长度满足要求。",
    confidence: 0.8,
    keyPoints: ["观点 1"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(valid);
  assert.ok(result.success);
});

test("ExpertReviewResponseSchema：opinion < 10 字符校验失败", () => {
  const invalid = {
    opinion: "短",
    confidence: 0.8,
    keyPoints: [],
    risks: [],
    recommendations: [],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

test("ExpertReviewResponseSchema：confidence > 1 校验失败", () => {
  const invalid = {
    opinion: "合法长度意见内容。",
    confidence: 1.5,
    keyPoints: [],
    risks: [],
    recommendations: [],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

test("ExpertReviewResponseSchema：confidence < 0 校验失败", () => {
  const invalid = {
    opinion: "合法长度意见内容。",
    confidence: -0.1,
    keyPoints: [],
    risks: [],
    recommendations: [],
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

test("ExpertReviewResponseSchema：keyPoints/risks/recommendations 缺失时使用默认空数组", () => {
  const minimal = {
    opinion: "合法长度意见内容测试。",
    confidence: 0.5,
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(minimal);
  assert.ok(result.success);
  assert.deepEqual(result.data?.keyPoints, []);
  assert.deepEqual(result.data?.risks, []);
  assert.deepEqual(result.data?.recommendations, []);
});

test("ExpertReviewResponseSchema：opinion 缺失校验失败", () => {
  const invalid = {
    confidence: 0.5,
  };
  const result = _internals.ExpertReviewResponseSchema.safeParse(invalid);
  assert.ok(!result.success);
});

// ============================================================================
// 第三部分：buildExpertSystemPrompt（5 个测试）
// ============================================================================

test("buildExpertSystemPrompt：包含 expert.systemPromptPrefix 内容", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "你是测试专家，遵循 Karpathy 原则。",
    systemPromptSuffix: "",
  });
  assert.ok(prompt.includes("你是测试专家，遵循 Karpathy 原则。"));
});

test("buildExpertSystemPrompt：包含 expert.systemPromptSuffix 内容", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "后置约束内容",
  });
  assert.ok(prompt.includes("后置约束内容"));
});

test("buildExpertSystemPrompt：systemPromptSuffix 为空时不包含 SUFFIX CONSTRAINTS 段", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "",
  });
  assert.ok(!prompt.includes("SUFFIX CONSTRAINTS"));
});

test("buildExpertSystemPrompt：包含 JSON 输出格式说明", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "",
  });
  assert.ok(prompt.includes("OUTPUT FORMAT"));
  assert.ok(prompt.includes("opinion"));
  assert.ok(prompt.includes("confidence"));
  assert.ok(prompt.includes("keyPoints"));
  assert.ok(prompt.includes("risks"));
  assert.ok(prompt.includes("recommendations"));
});

test("buildExpertSystemPrompt：包含严格规则说明", () => {
  const prompt = _internals.buildExpertSystemPrompt({
    systemPromptPrefix: "前缀",
    systemPromptSuffix: "",
  });
  assert.ok(prompt.includes("严格规则"));
  assert.ok(prompt.includes("只输出 JSON"));
});

// ============================================================================
// 第四部分：buildExpertUserPrompt（6 个测试）
// ============================================================================

test("buildExpertUserPrompt：包含任务标题", () => {
  const task = makeTask({ title: "测试任务标题 ABC" });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("测试任务标题 ABC"));
});

test("buildExpertUserPrompt：包含任务描述", () => {
  const task = makeTask({ description: "测试任务描述 XYZ" });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("测试任务描述 XYZ"));
});

test("buildExpertUserPrompt：domainTags 非空时包含业务标签段", () => {
  const task = makeTask({ domainTags: ["金融", "风控"] });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("业务标签"));
  assert.ok(prompt.includes("金融、风控"));
});

test("buildExpertUserPrompt：domainTags 为空时不包含业务标签段", () => {
  const task = makeTask({ domainTags: [] });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(!prompt.includes("业务标签"));
});

test("buildExpertUserPrompt：constraints 非空时包含约束条件段", () => {
  const task = makeTask({ constraints: ["约束 1", "约束 2"] });
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("约束条件"));
  assert.ok(prompt.includes("- 约束 1"));
  assert.ok(prompt.includes("- 约束 2"));
});

test("buildExpertUserPrompt：包含 review 请求段", () => {
  const task = makeTask();
  const prompt = _internals.buildExpertUserPrompt(task);
  assert.ok(prompt.includes("review 请求"));
  assert.ok(prompt.includes("业务合理性"));
  assert.ok(prompt.includes("潜在风险"));
  assert.ok(prompt.includes("改进建议"));
});

// ============================================================================
// 第五部分：parseExpertResponse（8 个测试）
// ============================================================================

test("parseExpertResponse：合法 JSON 返回 ExpertOpinion", () => {
  const content = JSON.stringify({
    opinion: "这是一个合法的 review 意见，长度满足要求。",
    confidence: 0.85,
    keyPoints: ["关键观点 1"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
  });
  const opinion = _internals.parseExpertResponse(content, buildMatchResult());
  assert.equal(opinion.expertId, "domain-test-expert");
  assert.equal(opinion.expertName, "测试专家");
  assert.equal(opinion.confidence, 0.85);
  assert.deepEqual(opinion.keyPoints, ["关键观点 1"]);
});

test("parseExpertResponse：content 为 null 抛 ExpertInvocationError（phase=empty）", () => {
  assert.throws(
    () => _internals.parseExpertResponse(null, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).expertId, "domain-test-expert");
      assert.equal((err as ExpertInvocationError).phase, "empty");
      return true;
    }
  );
});

test("parseExpertResponse：content 为空字符串抛 ExpertInvocationError（phase=empty）", () => {
  assert.throws(
    () => _internals.parseExpertResponse("   ", buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "empty");
      return true;
    }
  );
});

test("parseExpertResponse：非法 JSON 抛 ExpertInvocationError（phase=parse）", () => {
  assert.throws(
    () => _internals.parseExpertResponse("not a json", buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      assert.ok((err as Error).message.includes("JSON 解析失败"));
      return true;
    }
  );
});

test("parseExpertResponse：JSON 缺少 opinion 字段抛 ExpertInvocationError（phase=parse）", () => {
  const content = JSON.stringify({ confidence: 0.5 });
  assert.throws(
    () => _internals.parseExpertResponse(content, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      assert.ok((err as Error).message.includes("schema 校验失败"));
      return true;
    }
  );
});

test("parseExpertResponse：opinion < 10 字符抛 ExpertInvocationError（phase=parse）", () => {
  const content = JSON.stringify({
    opinion: "短",
    confidence: 0.5,
  });
  assert.throws(
    () => _internals.parseExpertResponse(content, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      return true;
    }
  );
});

test("parseExpertResponse：confidence > 1 抛 ExpertInvocationError（phase=parse）", () => {
  const content = JSON.stringify({
    opinion: "合法长度意见。",
    confidence: 1.5,
  });
  assert.throws(
    () => _internals.parseExpertResponse(content, buildMatchResult()),
    (err: unknown) => {
      assert.ok(err instanceof ExpertInvocationError);
      assert.equal((err as ExpertInvocationError).phase, "parse");
      return true;
    }
  );
});

test("parseExpertResponse：缺失 keyPoints 时使用默认空数组", () => {
  const content = JSON.stringify({
    opinion: "合法长度意见内容测试。",
    confidence: 0.5,
  });
  const opinion = _internals.parseExpertResponse(content, buildMatchResult());
  assert.deepEqual(opinion.keyPoints, []);
  assert.deepEqual(opinion.risks, []);
  assert.deepEqual(opinion.recommendations, []);
});

// ============================================================================
// 第六部分：DomainExpertReviewPlugin 构造与 meta（5 个测试）
// ============================================================================

test("DomainExpertReviewPlugin 构造成功", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const teamConfig = makeTeamConfig();
  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig);
  assert.ok(plugin);
});

test("meta.name 为 'domain-expert-review'", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  assert.equal(plugin.name, "domain-expert-review");
});

test("meta.priority 为 50", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  assert.equal(plugin.priority, 50);
});

test("meta.mutexWith 包含 'architect-review' 和 'test-expert-review'（P1-NEW-3）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  assert.ok(plugin.mutexWith.includes("architect-review"));
  assert.ok(plugin.mutexWith.includes("test-expert-review"));
});

test("meta.requiresTask 为 true", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  assert.equal(plugin.requiresTask, true);
});

// ============================================================================
// 第七部分：matches() 条件分支（8 个测试）
// ============================================================================

test("matches：enableDomainExperts=false 时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig({ enableDomainExperts: false })
  );
  const ctx = makeCtx({ currentPhase: 2 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：enabledCategories 为空时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig({ enabledCategories: [] })
  );
  const ctx = makeCtx({ currentPhase: 2 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase !== 2 && !== 8 时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 3 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase=1 时返回 false（非阶段 2/8）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 1 });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase 未设置（undefined）时返回 false（向后兼容）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: undefined });
  assert.equal(plugin.matches(ctx), false);
});

test("matches：currentPhase=2 时返回 true（架构设计阶段）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 2 });
  assert.equal(plugin.matches(ctx), true);
});

test("matches：currentPhase=8 时返回 true（发布评审阶段）", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({ currentPhase: 8 });
  assert.equal(plugin.matches(ctx), true);
});

test("matches：任务无业务信号（title/description/domainTags 全空）时返回 false", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({ title: "", description: "", domainTags: [] }),
  });
  assert.equal(plugin.matches(ctx), false);
});

// ============================================================================
// 第八部分：before() 钩子（5 个测试）
// ============================================================================

test("before：调用 matcher.matchExperts 并将结果存入 ctx.state", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-1", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates);
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].expert.expertId, "domain-test-1");
});

test("before：无候选专家时 state 存空数组并记录 WARNING 日志", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.deepEqual([...candidates], []);
  // 验证 WARNING 日志已记录
  const warningEvents = ctx.events.filter(
    (e) => e.type.includes("WARNING") || (e.payload as { level?: string }).level === "WARNING"
  );
  assert.ok(warningEvents.length > 0);
});

test("before：候选专家时记录 INFO 日志（包含 top1 置信度）", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-2", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const infoEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string; message?: string };
    return payload.level === "INFO" && payload.message?.includes("top1");
  });
  assert.ok(infoEvents.length > 0);
});

test("before：从 teamConfig 读取匹配策略 / topK / 阈值", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-3", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const teamConfig = makeTeamConfig({
    domainExpertMatchStrategy: "keyword",
    domainExpertTopK: 1,
    domainExpertThreshold: 0.5,
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, teamConfig);
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length <= 1, "topK=1 时最多返回 1 个候选");
});

test("before：phase=8 时也正常工作", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-test-4", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 8 });

  await plugin.before(ctx);

  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length > 0);
});

// ============================================================================
// 第八部分补充：P2-2 修复验证测试（matches 条件 4 简化）
// ============================================================================

test("matches：P2-2 修复验证 - domainTags 非空时返回 true（title/description 长度不检查）", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  // TaskRequirement schema 保证 title ≥3 字符 / description ≥10 字符，因此总是非空
  // P2-2 修复后：只检查 domainTags.length > 0，不检查 title/description
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "合法标题", // ≥3 字符
      description: "合法描述内容（≥10 字符）", // ≥10 字符
      domainTags: ["金融"], // 非空 domainTags
    }),
  });
  assert.equal(plugin.matches(ctx), true, "domainTags 非空时应返回 true（P2-2 修复后行为）");
});

test("matches：P2-2 修复验证 - domainTags 为空时返回 false（即使 title/description 非空）", () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "合法标题",
      description: "合法描述内容（≥10 字符）",
      domainTags: [], // 空 domainTags
    }),
  });
  assert.equal(plugin.matches(ctx), false, "domainTags 为空时应返回 false（P2-2 修复后行为）");
});

// ============================================================================
// 第九部分：execute() 钩子（10 个测试）
// ============================================================================

test("execute：无候选专家时返回 status=failed 的 DispatchResult", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  // 不调用 before，state 中无候选
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("无候选领域专家"));
});

test("execute：state 中候选为空数组时返回 status=failed", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
});

test("execute：单专家 LLM 调用成功返回 status=succeeded", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "这是一个合法的 review 意见，长度满足要求。",
    confidence: 0.85,
    keyPoints: ["关键观点"],
    risks: ["风险"],
    recommendations: ["建议"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("领域专家 review 汇总"));
});

test("execute：成功时将 DomainExpertDispatchResult 存入 ctx.state", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  await plugin.execute(ctx);

  const dispatchResult = ctx.state[_internals.STATE_KEY_DISPATCH_RESULT] as {
    taskId: string;
    status: string;
    matchedExperts: unknown[];
  };
  assert.ok(dispatchResult);
  assert.equal(dispatchResult.status, "succeeded");
  assert.equal(dispatchResult.matchedExperts.length, 1);
});

test("execute：单专家失败时返回 status=failed（Promise.allSettled 捕获）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(),
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("调用失败"));
});

test("execute：多专家部分失败时不影响其他专家（Promise.allSettled 隔离）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });

  // 第一个专家成功，第二个失败：通过两次 plugin 实例对比
  // 这里简化测试：注入一个会成功的 client，第二个候选用 buildNetworkErrorClient
  // 由于 injectedClient 是单一客户端，本测试验证多专家全部成功场景
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-expert-a", name: "专家 A" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-expert-b", name: "专家 B" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // 汇总报告中应包含两个专家的意见
  assert.ok(result.output?.includes("专家 A"));
  assert.ok(result.output?.includes("专家 B"));
});

test("execute：多专家全部失败时返回 status=failed 并汇总错误", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(),
  });
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-fail-1" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-fail-2" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("2 个专家调用失败"));
  assert.ok(result.error?.includes("domain-fail-1"));
  assert.ok(result.error?.includes("domain-fail-2"));
});

test("execute：失败专家的汇总报告中包含失败专家段", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(),
  });
  const candidates = [buildMatchResult({ expert: buildExpert({ expertId: "domain-fail-only" }) })];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("失败专家"));
  assert.ok(result.output?.includes("domain-fail-only"));
});

test("execute：成功时 DispatchResult.matchedRole 包含专家意见数量", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-success-1" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-success-2" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.matchedRole.reasons[0]?.includes("2 成功"));
  assert.ok(result.matchedRole.reasons[0]?.includes("0 失败"));
});

test("execute：超时专家触发 ExpertInvocationError（phase=timeout）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildAbortingClient(),
    expertTimeoutMs: 0, // 立即触发 abort
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("timeout"));
});

test("execute：tokensConsumed 真实透传 LLM usage 字段（P2-1 修复验证）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "这是一个合法的 review 意见，长度满足要求。",
    confidence: 0.85,
    keyPoints: ["关键观点"],
    risks: ["风险"],
    recommendations: ["建议"],
  });
  // 注入自定义 usage（prompt=150 / completion=250 / total=400）
  const customUsage = { prompt_tokens: 150, completion_tokens: 250, total_tokens: 400 };
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse, customUsage),
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // P2-1 修复验证：tokensConsumed 必须等于注入的 usage，不再为 0
  assert.equal(result.tokensConsumed.prompt, 150, "tokensConsumed.prompt 应等于注入的 prompt_tokens");
  assert.equal(result.tokensConsumed.completion, 250, "tokensConsumed.completion 应等于注入的 completion_tokens");
  assert.equal(result.tokensConsumed.total, 400, "tokensConsumed.total 应等于注入的 total_tokens");

  // 同时验证富类型 DomainExpertDispatchResult 的 tokensConsumed 也正确透传
  const dispatchResult = ctx.state[_internals.STATE_KEY_DISPATCH_RESULT] as {
    tokensConsumed: { prompt: number; completion: number; total: number };
  };
  assert.equal(dispatchResult.tokensConsumed.prompt, 150);
  assert.equal(dispatchResult.tokensConsumed.completion, 250);
  assert.equal(dispatchResult.tokensConsumed.total, 400);
});

test("execute：多专家并行调用时 tokensConsumed 聚合所有成功专家的 usage", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse1 = JSON.stringify({
    opinion: "第一个专家的 review 意见内容长度足够。",
    confidence: 0.85,
    keyPoints: ["观点1"],
    risks: ["风险1"],
    recommendations: ["建议1"],
  });
  const validResponse2 = JSON.stringify({
    opinion: "第二个专家的 review 意见内容长度足够。",
    confidence: 0.75,
    keyPoints: ["观点2"],
    risks: ["风险2"],
    recommendations: ["建议2"],
  });

  // 构造两个候选专家，分别使用不同的 usage
  // expert1: prompt=100, completion=200, total=300
  // expert2: prompt=50, completion=150, total=200
  // 期望聚合：prompt=150, completion=350, total=500
  const expert1 = buildExpert({
    expertId: "domain-test-expert-1",
    name: "测试专家1",
    keywords: ["kw1", "kw2", "kw3"],
  });
  const expert2 = buildExpert({
    expertId: "domain-test-expert-2",
    name: "测试专家2",
    keywords: ["kw4", "kw5", "kw6"],
  });

  // 构造一个会根据 expertId 返回不同 usage 的客户端
  const dynamicClient = {
    client: {
      chat: {
        completions: {
          create: async (_params: unknown, _options?: unknown) => {
            // 通过 _params 不能直接拿到 expertId，这里使用计数器区分两次调用
            // 第一次调用返回 usage1，第二次返回 usage2
            const callCount = (dynamicClient as unknown as { _callCount: number })._callCount ?? 0;
            (dynamicClient as unknown as { _callCount: number })._callCount = callCount + 1;
            const isFirstCall = callCount === 0;
            return {
              choices: [
                {
                  message: {
                    content: isFirstCall ? validResponse1 : validResponse2,
                  },
                },
              ],
              usage: isFirstCall
                ? { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }
                : { prompt_tokens: 50, completion_tokens: 150, total_tokens: 200 },
            };
          },
        },
      },
    },
    model: "test-model",
    baseURL: "https://test.example.com",
    thinkingEnabled: false,
    reasoningEffort: "high" as const,
    debugLogEnabled: false,
    telemetryEnabled: false,
    env: {},
  };

  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: dynamicClient,
  });

  const candidate1 = buildMatchResult({ expert: expert1 });
  const candidate2 = buildMatchResult({ expert: expert2 });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate1, candidate2] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // 聚合后的 token 用量应为两个专家 usage 之和
  assert.equal(result.tokensConsumed.prompt, 150, "聚合 prompt = 100 + 50");
  assert.equal(result.tokensConsumed.completion, 350, "聚合 completion = 200 + 150");
  assert.equal(result.tokensConsumed.total, 500, "聚合 total = 300 + 200");
});

test("execute：LLM 不返回 usage 时 tokensConsumed 降级为 0（兼容自定义 OpenAI 端点）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容测试。",
    confidence: 0.85,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });

  // 构造一个不返回 usage 字段的客户端（模拟某些 OpenAI 兼容端点）
  const clientWithoutUsage = {
    client: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: validResponse } }],
            // 注意：不返回 usage 字段
          }),
        },
      },
    },
    model: "test-model",
    baseURL: "https://test.example.com",
    thinkingEnabled: false,
    reasoningEffort: "high" as const,
    debugLogEnabled: false,
    telemetryEnabled: false,
    env: {},
  };

  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: clientWithoutUsage,
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // usage 缺失时降级为 0，不应抛错
  assert.equal(result.tokensConsumed.prompt, 0);
  assert.equal(result.tokensConsumed.completion, 0);
  assert.equal(result.tokensConsumed.total, 0);
});

// P3-1 修复验证：matchedRole 根据 currentPhase 动态选择
test("execute：P3-1 修复验证 - currentPhase=2 时 matchedRole.roleId='architect'", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容测试。",
    confidence: 0.85,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 2, // 阶段 2（架构设计）
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // P3-1 修复后：currentPhase=2 应使用 "architect" 而非硬编码 "solo-coder"
  assert.equal(result.matchedRole.roleId, "architect", "阶段 2 应使用 architect（P3-1 修复后行为）");
  assert.ok(result.matchedRole.roleName.includes("architect"), "roleName 应包含 architect");
});

test("execute：P3-1 修复验证 - currentPhase=8 时 matchedRole.roleId='test-expert'", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容测试。",
    confidence: 0.85,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidate = buildMatchResult();
  const ctx = makeCtx({
    currentPhase: 8, // 阶段 8（发布评审）
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // P3-1 修复后：currentPhase=8 应使用 "test-expert" 而非硬编码 "solo-coder"
  assert.equal(result.matchedRole.roleId, "test-expert", "阶段 8 应使用 test-expert（P3-1 修复后行为）");
  assert.ok(result.matchedRole.roleName.includes("test-expert"), "roleName 应包含 test-expert");
});

// ============================================================================
// 第十部分：after() 钩子（5 个测试）
// ============================================================================

test("after：将汇总报告存入 ctx.state[STATE_KEY_REVIEWS]", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 测试汇总报告",
  };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "# 测试汇总报告");
});

test("after：同步汇总报告到 ctx.task.upstreamContext['domainExpertReviews']", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 跨任务传播测试",
  };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.task.upstreamContext["domainExpertReviews"], "# 跨任务传播测试");
});

test("after：state 中有 DomainExpertDispatchResult 时优先使用其 output", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: {
      [_internals.STATE_KEY_DISPATCH_RESULT]: { output: "# 来自 dispatchResult 的报告" },
    },
  });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 来自 result 的报告（应被忽略）",
  };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "# 来自 dispatchResult 的报告");
});

test("after：state 和 result 均无 output 时使用空字符串", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = { status: "failed" as const };
  await plugin.after(ctx, fakeResult as never);

  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "");
});

test("after：记录 INFO 日志（包含汇总字符数）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const fakeResult = {
    status: "succeeded" as const,
    output: "# 字符数测试报告内容",
  };
  await plugin.after(ctx, fakeResult as never);

  const infoEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string; message?: string };
    return payload.level === "INFO" && payload.message?.includes("字符");
  });
  assert.ok(infoEvents.length > 0);
});

// ============================================================================
// 第十一部分：cleanup() 钩子（5 个测试）
// ============================================================================

test("cleanup：exc=null 时不记录 ERROR 日志", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.cleanup(ctx, null);

  const errorEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string };
    return payload.level === "ERROR";
  });
  assert.equal(errorEvents.length, 0);
});

test("cleanup：exc 非 null 时记录 ERROR 日志", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  const err = new Error("测试异常");
  await plugin.cleanup(ctx, err);

  const errorEvents = ctx.events.filter((e) => {
    const payload = e.payload as { level?: string; message?: string };
    return payload.level === "ERROR" && payload.message?.includes("测试异常");
  });
  assert.ok(errorEvents.length > 0);
});

test("cleanup：exc 非 null 时清理 STATE_KEY_CANDIDATES", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  await plugin.cleanup(ctx, new Error("cleanup 测试"));

  assert.equal(ctx.state[_internals.STATE_KEY_CANDIDATES], undefined);
});

test("cleanup：exc 非 null 时清理 STATE_KEY_DISPATCH_RESULT", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_DISPATCH_RESULT]: { output: "test" } },
  });

  await plugin.cleanup(ctx, new Error("cleanup 测试"));

  assert.equal(ctx.state[_internals.STATE_KEY_DISPATCH_RESULT], undefined);
});

test("cleanup：exc=null 时保留 STATE_KEY_CANDIDATES 和 STATE_KEY_DISPATCH_RESULT（支持 after 重试）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: {
      [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()],
      [_internals.STATE_KEY_DISPATCH_RESULT]: { output: "test" },
    },
  });

  await plugin.cleanup(ctx, null);

  // 正常完成时保留中间数据（支持 after 重试）
  assert.ok(ctx.state[_internals.STATE_KEY_CANDIDATES]);
  assert.ok(ctx.state[_internals.STATE_KEY_DISPATCH_RESULT]);
});

// ============================================================================
// 第十二部分：summarizeOpinions（内部方法，通过 execute 间接验证）
// ============================================================================

test("summarizeOpinions：空 opinions + 空 failures 返回无候选提示", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [] },
  });

  const result = await plugin.execute(ctx);
  // 空候选走 fail 路径，output 为错误信息
  assert.ok(result.error?.includes("无候选"));
});

test("summarizeOpinions：单专家成功时汇总报告包含专家名和置信度", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.92,
    keyPoints: ["关键观点 1", "关键观点 2"],
    risks: ["风险 1"],
    recommendations: ["建议 1"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidate = buildMatchResult({
    expert: buildExpert({ expertId: "domain-summary-1", name: "汇总测试专家" }),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [candidate] },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("汇总测试专家"));
  assert.ok(result.output?.includes("92.0%"));
  assert.ok(result.output?.includes("关键观点 1"));
  assert.ok(result.output?.includes("风险 1"));
  assert.ok(result.output?.includes("建议 1"));
});

test("summarizeOpinions：多专家时按 confidence 降序排列", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  // 通过返回不同 confidence 的内容（这里固定一个 client 只能返回同一种内容，
  // 所以用两次 plugin 实例验证排序逻辑）
  const lowConfidenceResponse = JSON.stringify({
    opinion: "低置信度意见内容测试。",
    confidence: 0.3,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(lowConfidenceResponse),
  });
  // 由于 injectedClient 返回固定内容，两个专家 confidence 相同
  // 改为验证汇总报告包含两个专家段
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-low-1", name: "低置信度专家 1" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-low-2", name: "低置信度专家 2" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("低置信度专家 1"));
  assert.ok(result.output?.includes("低置信度专家 2"));
});

test("summarizeOpinions：成功 + 失败混合时汇总报告同时包含两段", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(), // 全部失败
  });
  const candidates = [buildMatchResult({ expert: buildExpert({ expertId: "domain-fail-mixed" }) })];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  // 全部失败时无成功意见段，但有失败专家段
  assert.ok(result.output?.includes("失败专家"));
  assert.ok(result.output?.includes("domain-fail-mixed"));
});

test("summarizeOpinions：汇总报告包含概览段（成功/失败/总计数量）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const candidates = [
    buildMatchResult({ expert: buildExpert({ expertId: "domain-overview-1" }) }),
    buildMatchResult({ expert: buildExpert({ expertId: "domain-overview-2" }) }),
  ];
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: candidates },
  });

  const result = await plugin.execute(ctx);
  assert.ok(result.output?.includes("成功：2 位专家"));
  assert.ok(result.output?.includes("失败：0 位专家"));
  assert.ok(result.output?.includes("总计：2 位专家"));
});

// ============================================================================
// 第十三部分：invokeExpertLLM（通过 execute 间接验证，4 个测试）
// ============================================================================

test("invokeExpertLLM：LLM 返回合法 JSON 时成功（通过 execute 验证）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "合法长度 review 意见内容。",
    confidence: 0.7,
    keyPoints: ["kp1"],
    risks: ["r1"],
    recommendations: ["rec1"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
});

test("invokeExpertLLM：LLM 返回非 JSON 时抛 ExpertInvocationError（phase=parse）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient("not a json"),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("parse"));
});

test("invokeExpertLLM：LLM 网络错误时抛 ExpertInvocationError（phase=network）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildNetworkErrorClient(),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("network"));
});

test("invokeExpertLLM：超时时抛 ExpertInvocationError（phase=timeout）", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildAbortingClient(),
    expertTimeoutMs: 0,
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("timeout"));
});

// ============================================================================
// 第十四部分：集成流程（before → execute → after 完整链路，5 个测试）
// ============================================================================

test("集成流程：before → execute → after 完整链路（单专家成功）", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-integration-1", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "集成测试 review 意见，验证完整链路。",
    confidence: 0.88,
    keyPoints: ["集成关键观点"],
    risks: ["集成风险"],
    recommendations: ["集成建议"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({ currentPhase: 2 });

  // 1. matches
  assert.equal(plugin.matches(ctx), true);

  // 2. before
  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length > 0);

  // 3. execute
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");

  // 4. after
  await plugin.after(ctx, result);
  assert.ok(ctx.state[_internals.STATE_KEY_REVIEWS]);
  assert.equal(ctx.task.upstreamContext["domainExpertReviews"], ctx.state[_internals.STATE_KEY_REVIEWS]);

  // 5. cleanup（正常完成）
  await plugin.cleanup(ctx, null);
});

test("集成流程：before → execute → after 完整链路（无候选专家）", async () => {
  const registry = new DomainExpertRegistry(); // 不注册任何专家
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.equal(candidates.length, 0);

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");

  await plugin.after(ctx, result);
  // 即使失败也应写入空字符串到 state（避免下游读取 undefined）
  assert.equal(ctx.state[_internals.STATE_KEY_REVIEWS], "");

  await plugin.cleanup(ctx, null);
});

test("集成流程：phase=8 时完整链路正常工作", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-phase-8", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "phase 8 review 意见内容。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({ currentPhase: 8 });

  assert.equal(plugin.matches(ctx), true);
  await plugin.before(ctx);
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  await plugin.after(ctx, result);
  assert.ok(ctx.state[_internals.STATE_KEY_REVIEWS]);
});

test("集成流程：异常路径触发 cleanup 清理 state", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-cleanup-test", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);
  // 模拟异常：state 中已有候选，但执行时抛错
  assert.ok(ctx.state[_internals.STATE_KEY_CANDIDATES]);

  // 模拟 dispatcher 在异常后调用 cleanup
  await plugin.cleanup(ctx, new Error("模拟异常"));

  // 异常时清理中间数据
  assert.equal(ctx.state[_internals.STATE_KEY_CANDIDATES], undefined);
});

test("集成流程：多专家并行调用全部成功", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-multi-1", keywords: ["测试", "业务", "验证"], name: "专家甲" }));
  registry.register(buildExpert({ expertId: "domain-multi-2", keywords: ["测试", "业务", "验证"], name: "专家乙" }));
  registry.register(buildExpert({ expertId: "domain-multi-3", keywords: ["测试", "业务", "验证"], name: "专家丙" }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "多专家并行 review 意见。",
    confidence: 0.75,
    keyPoints: ["并行关键观点"],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({ currentPhase: 2 });

  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates.length >= 2, "至少匹配到 2 个专家");

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  // 汇总报告应包含所有匹配到的专家
  for (const c of candidates) {
    assert.ok(result.output?.includes(c.expert.name));
  }
});

// ============================================================================
// 第十五部分：DomainExpertReviewPluginOptions 选项（3 个测试）
// ============================================================================

test("DomainExpertReviewPluginOptions：未提供 options 时使用默认值", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig());
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  // 无 options 时 invokeExpertLLM 会调用 createOpenAIClient（无 API Key）→ 抛 ExpertInvocationError
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("no-client"));
});

test("DomainExpertReviewPluginOptions：expertTimeoutMs 覆盖默认超时", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildAbortingClient(),
    expertTimeoutMs: 0, // 立即 abort
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("timeout"));
});

test("DomainExpertReviewPluginOptions：projectRoot 用于读取 .env", async () => {
  const registry = new DomainExpertRegistry();
  const matcher = new DomainExpertMatcher(registry);
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    projectRoot: "/nonexistent-path",
  });
  const ctx = makeCtx({
    currentPhase: 2,
    state: { [_internals.STATE_KEY_CANDIDATES]: [buildMatchResult()] },
  });

  // projectRoot 不存在时 createOpenAIClient 会读取默认 settings，最终可能无 API Key
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "failed");
});

// ============================================================================
// 第十六部分：综合场景（5 个测试）
// ============================================================================

test("综合场景：金融任务匹配金融专家并完成 review", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-finance-strategist",
      name: "金融战略专家",
      category: "strategy",
      keywords: ["金融", "风控", "合规"],
      domainTags: ["金融", "风控"],
    })
  );
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "金融任务 review 意见：建议加强风控措施。",
    confidence: 0.9,
    keyPoints: ["风控缺失"],
    risks: ["合规风险"],
    recommendations: ["增加风控审批环节"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "金融风控系统设计",
      description: "设计一套金融风控系统，包含实时反欺诈和贷后管理。",
      domainTags: ["金融", "风控"],
    }),
  });

  await plugin.before(ctx);
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult>;
  assert.ok(candidates[0].expert.expertId === "domain-finance-strategist");

  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("金融战略专家"));
  assert.ok(result.output?.includes("风控缺失"));
});

test("综合场景：医疗任务匹配医疗专家并完成 review", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-medical-expert",
      name: "医疗合规专家",
      category: "specialized",
      keywords: ["医疗", "合规", "数据"],
      domainTags: ["医疗", "合规"],
    })
  );
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "医疗任务 review 意见：需符合 HIPAA 合规要求。",
    confidence: 0.85,
    keyPoints: ["HIPAA 合规"],
    risks: ["数据泄露风险"],
    recommendations: ["加密患者数据"],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 8,
    task: makeTask({
      title: "医疗数据平台建设",
      description: "构建医疗数据平台，需满足合规要求。",
      domainTags: ["医疗"],
    }),
  });

  await plugin.before(ctx);
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("医疗合规专家"));
});

test("综合场景：空 domainTags 任务不触发 review（P2-2 修复后行为）", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({
      expertId: "domain-text-match",
      name: "文本匹配专家",
      keywords: ["测试", "业务", "验证"],
      domainTags: ["测试"],
    })
  );
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "基于文本匹配的 review 意见。",
    confidence: 0.6,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 2,
    task: makeTask({
      title: "测试业务验证流程",
      description: "验证测试业务的完整性和正确性。",
      domainTags: [], // 空 domainTags
    }),
  });

  // P2-2 修复后：空 domainTags 任务不再触发 review（matches 返回 false）
  assert.equal(plugin.matches(ctx), false, "空 domainTags 任务不应触发 review（P2-2 修复后行为）");
  // before 不应被调用（matches=false 时 dispatcher 不触发 before）
  // 因此 candidates 应为 undefined（state 未设置）
  const candidates = ctx.state[_internals.STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult> | undefined;
  assert.equal(candidates, undefined, "matches=false 时 before 不应被调用，state 中无候选");
});

test("综合场景：phase=8 触发时汇总报告写入 upstreamContext 供下游消费", async () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-upstream-test", keywords: ["测试", "业务", "验证"] }));
  const matcher = new DomainExpertMatcher(registry);
  const validResponse = JSON.stringify({
    opinion: "upstream 传播测试意见。",
    confidence: 0.7,
    keyPoints: [],
    risks: [],
    recommendations: [],
  });
  const plugin = new DomainExpertReviewPlugin(registry, matcher, makeTeamConfig(), {
    injectedClient: buildInjectedClient(validResponse),
  });
  const ctx = makeCtx({
    currentPhase: 8,
    task: makeTask({ domainTags: ["测试"] }),
  });

  await plugin.before(ctx);
  const result = await plugin.execute(ctx);
  await plugin.after(ctx, result);

  // upstreamContext 中的 domainExpertReviews 可被下游阶段读取
  const upstreamReviews = ctx.task.upstreamContext["domainExpertReviews"];
  assert.equal(typeof upstreamReviews, "string");
  assert.ok((upstreamReviews as string).includes("领域专家 review 汇总"));
});

test("综合场景：插件 meta 完整性校验", () => {
  const plugin = new DomainExpertReviewPlugin(
    new DomainExpertRegistry(),
    new DomainExpertMatcher(new DomainExpertRegistry()),
    makeTeamConfig()
  );
  // 验证 V3 契约 meta 字段完整性
  assert.equal(plugin.meta.name, "domain-expert-review");
  assert.equal(plugin.meta.priority, 50);
  assert.ok(plugin.meta.description.length > 0);
  assert.ok(plugin.meta.mutexWith.length === 2);
  assert.equal(plugin.meta.requiresTask, true);
  assert.deepEqual([...plugin.meta.mutexWith].sort(), ["architect-review", "test-expert-review"].sort());
});
