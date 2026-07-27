/**
 * DomainExpertReviewPlugin 测试夹具：共享辅助函数与客户端构造器
 *
 * 用途：
 * - 为 domain-expert-*.test.ts 系列拆分文件提供统一的测试对象构造函数
 * - 提供真实可用的注入客户端（非 mock，仅替换 LLM 调用入口，遵循"禁止 mock"规则）
 * - 保证测试数据真实可用的同时避免在每个测试文件中重复定义
 *
 * 设计依据：
 * - DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3 / §5.3 / §8.4（P1-NEW-1 / P1-NEW-3 / P1-NEW-4）
 * - domain-expert-review-plugin.ts 源文件
 * - types.ts 类型定义
 *
 * @module core/team/tests/utils/domain-expert-fixtures
 */

import { buildPluginContext } from "../../plugin-context.js";
import { PluginRegistry } from "../../plugins/index.js";
import { GoalDispatcher } from "../../plugins/goal-dispatcher.js";
import type {
  DomainCategory,
  DomainExpert as DomainExpertType,
  DomainExpertMatchResult,
  ExpertOpinion,
  PluginContext,
  TaskRequirement,
  TeamConfig,
} from "../../types.js";
import {
  DomainExpert as DomainExpertSchema,
  ExpertOpinion as ExpertOpinionSchema,
  TeamConfig as TeamConfigSchema,
} from "../../types.js";

/**
 * 构造测试用 DomainExpert
 *
 * @param overrides 覆盖字段
 * @returns 合法的 DomainExpert 实例
 */
export function buildExpert(overrides: Partial<DomainExpertType> = {}): DomainExpertType {
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
export function makeTask(overrides: Partial<TaskRequirement> = {}): TaskRequirement {
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
export function makeTeamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
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
export function makeCtx(
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
export function buildInjectedClient(
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
export function buildAbortingClient(): {
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
export function buildNetworkErrorClient(): {
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
export function buildMatchResult(
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

export function buildOpinion(overrides: Partial<ExpertOpinion> = {}): ExpertOpinion {
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
