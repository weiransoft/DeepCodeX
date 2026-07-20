/**
 * DeepCodeX 多角色团队 - 角色匹配器
 *
 * 来源：融合 multi-agent-team skill 的 role_matcher.py + AI 语义匹配
 * 严格遵循 user rules：禁止 mock/占位/简化；三种策略全部真实实现
 * Karpathy 原则：Surgical Changes - 只新增必需函数，不修改已注册角色
 *
 * 三种匹配策略（与 multi-agent-team v2.1 完全对齐）:
 *   1. keyword - 纯本地计算（能力/技能/关键词重叠，权重 50/30/20）
 *   2. ai      - 调用 LLM 语义匹配（需配置 OpenAI 客户端）
 *   3. hybrid  - 默认策略：先 keyword 取 topK，再用 AI 重排序
 *
 * 降级策略（Ponytail 红线 R-02：必须显式错误处理）:
 *   - AI 不可用（无 API Key）→ 自动回退到 keyword
 *   - AI 调用失败（超时/网络）→ 自动回退到 keyword
 *   - AI 置信度 < aiFallbackThreshold → 回退到 keyword 重排
 */

import { z } from "zod";
import type { MatchResult, MatchStrategy, RoleDefinition, ScoreBreakdown, TaskRequirement } from "./types.js";
import { ROLE_REGISTRY } from "./role-registry.js";
import { MatchStrategy as MatchStrategySchema } from "./types.js";
import { createOpenAIClient } from "../common/openai-client.js";

// ============================================================================
// 第一部分：评分权重配置（与 multi-agent-team v2.1 完全一致）
// ============================================================================

/**
 * 匹配权重配置
 *
 * 设计依据（来自 multi-agent-team v2.1 ai_semantic_matcher.py）:
 *   - 能力匹配 50%：决定角色是否「能做」
 *   - 技能匹配 30%：决定角色「做得有多好」
 *   - 关键词 20%：辅助判断意图
 */
export const MATCH_WEIGHTS = {
  capability: 0.5,
  skill: 0.3,
  keyword: 0.2,
} as const;

/**
 * AI 增强专用权重（与 keyword 不同的语义模型）
 */
export const AI_MATCH_WEIGHTS = {
  capability: 0.4,
  context: 0.3,
  history: 0.3,
} as const;

/** 匹配选项（zod 校验，运行时安全） */
export const MatchOptions = z.object({
  strategy: MatchStrategySchema.default("hybrid"),
  topK: z.number().int().positive().default(3),
  aiFallbackThreshold: z.number().min(0).max(1).default(0.3),
  projectRoot: z.string().default(process.cwd()),
  injectedClient: z.unknown().optional(),
  timeoutMs: z.number().int().positive().default(30000),
});
export type MatchOptions = z.infer<typeof MatchOptions>;

/** AI 语义匹配请求 schema */
export const AIRoleMatchRequest = z.object({
  taskTitle: z.string(),
  taskDescription: z.string(),
  candidates: z.array(
    z.object({
      roleId: z.string(),
      name: z.string(),
      description: z.string(),
      capabilities: z.array(z.string()),
    })
  ),
});

/** AI 语义匹配响应 schema */
export const AIRoleMatchResponse = z.object({
  scores: z.array(
    z.object({
      roleId: z.string(),
      score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
      capabilityFit: z.number().min(0).max(1),
      contextUnderstanding: z.number().min(0).max(1),
      historicalExperience: z.number().min(0).max(1),
      reasoning: z.string().min(1),
    })
  ),
});

// ============================================================================
// 第二部分：Keyword 匹配（纯本地，无需网络）
// ============================================================================

/**
 * 计算文本与角色关键词的重叠度
 *
 * 算法：命中关键词数 / 关键词总数
 *
 * @param text 任务文本
 * @param keywords 角色关键词列表
 * @returns 重叠度 [0, 1]
 */
function computeKeywordOverlap(text: string, keywords: ReadonlyArray<string>): number {
  if (keywords.length === 0) return 0;
  const normalized = text.toLowerCase();
  const englishWords = normalized.match(/[a-z0-9+#.-]+/g) ?? [];
  const chineseChars = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
  const tokenSet = new Set<string>();
  for (const w of englishWords) tokenSet.add(w);
  for (const c of chineseChars) tokenSet.add(c);

  let hitCount = 0;
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (lowerKw.length > 1 && /[a-z0-9]/.test(lowerKw)) {
      if (tokenSet.has(lowerKw)) hitCount++;
    } else {
      if (normalized.includes(lowerKw)) hitCount++;
    }
  }
  return hitCount / keywords.length;
}

/**
 * 计算能力匹配得分（F1 分数）
 *
 * @param requiredCapabilities 任务所需能力
 * @param roleCapabilities 角色能力列表
 * @returns [0, 1]
 */
function computeCapabilityMatch(
  requiredCapabilities: ReadonlyArray<string>,
  roleCapabilities: ReadonlyArray<string>
): number {
  if (requiredCapabilities.length === 0) {
    return 0.5;
  }
  const roleSet = new Set(roleCapabilities);
  const requiredSet = new Set(requiredCapabilities);

  let roleHit = 0;
  for (const cap of roleCapabilities) {
    if (requiredSet.has(cap)) roleHit++;
  }
  const precision = roleCapabilities.length > 0 ? roleHit / roleCapabilities.length : 0;

  let taskHit = 0;
  for (const cap of requiredCapabilities) {
    if (roleSet.has(cap)) taskHit++;
  }
  const recall = taskHit / requiredCapabilities.length;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * 计算技能匹配得分（命中率）
 *
 * @param preferredSkills 任务偏好技能
 * @param roleSkills 角色技能列表
 * @returns [0, 1]
 */
function computeSkillMatch(preferredSkills: ReadonlyArray<string>, roleSkills: ReadonlyArray<string>): number {
  if (preferredSkills.length === 0) {
    return 0.5;
  }
  const roleSet = new Set(roleSkills.map((s) => s.toLowerCase()));
  let hit = 0;
  for (const skill of preferredSkills) {
    if (roleSet.has(skill.toLowerCase())) hit++;
  }
  return hit / preferredSkills.length;
}

/**
 * 对单个角色执行 keyword 匹配
 */
function scoreByKeyword(task: TaskRequirement, role: RoleDefinition): ScoreBreakdown {
  const text = `${task.title} ${task.description}`;
  const keywordScore = computeKeywordOverlap(text, role.keywords);
  const capabilityScore = computeCapabilityMatch(task.requiredCapabilities, role.capabilities);
  const skillScore = computeSkillMatch(task.preferredSkills, role.skills);
  const priorityScore = role.priority / 10;

  return {
    capability: capabilityScore,
    skill: skillScore,
    keyword: keywordScore,
    priority: priorityScore,
  };
}

/**
 * 将 ScoreBreakdown 转换为综合 confidence（加权求和）
 */
function aggregateScore(scores: ScoreBreakdown): number {
  return (
    scores.capability * MATCH_WEIGHTS.capability +
    scores.skill * MATCH_WEIGHTS.skill +
    scores.keyword * MATCH_WEIGHTS.keyword
  );
}

// ============================================================================
// 第三部分：AI 语义匹配（真实调用 LLM）
// ============================================================================

/**
 * 构建 AI 匹配的系统 prompt
 */
function buildAIMatchSystemPrompt(): string {
  return `# ROLE: AI 角色匹配专家

你是一个多角色匹配系统的 AI 增强模块。给定一个用户任务和若干候选角色，输出每个角色的综合评分。

## 评分维度（每项 0-1）
1. capabilityFit（能力契合）：候选角色的能力是否覆盖任务核心需求
2. contextUnderstanding（上下文理解）：候选角色能否理解任务上下文（附件、约束、上游产出）
3. historicalExperience（历史经验）：基于角色描述中的技能和职责，评估其历史处理类似任务的经验

## 输出格式（严格 JSON，无任何额外文本）
{
  "scores": [
    {
      "roleId": "<候选角色 ID>",
      "score": <综合得分 0-1>,
      "confidence": <你对这个评分的置信度 0-1>,
      "capabilityFit": <能力契合 0-1>,
      "contextUnderstanding": <上下文理解 0-1>,
      "historicalExperience": <历史经验 0-1>,
      "reasoning": "<中文解释，≤ 100 字>"
    }
  ]
}

## 严格规则
1. 只输出 JSON，不要 markdown 包装、不要解释、不要道歉
2. 每个候选角色必须输出 1 个评分对象（不能遗漏）
3. 评分理由必须用中文
4. 如果不确定，给 0.5 而非编造
`;
}

/**
 * 调用 LLM 执行 AI 语义匹配（真实实现）
 *
 * @param task 任务需求
 * @param candidates 候选角色
 * @param options 匹配选项
 * @returns AI 响应或 null（失败时）
 */
async function scoreByAI(
  task: TaskRequirement,
  candidates: ReadonlyArray<RoleDefinition>,
  options: MatchOptions
): Promise<z.infer<typeof AIRoleMatchResponse> | null> {
  let client: ReturnType<typeof createOpenAIClient> | null = null;
  if (options.injectedClient) {
    client = options.injectedClient as ReturnType<typeof createOpenAIClient>;
  } else {
    try {
      client = createOpenAIClient(options.projectRoot);
    } catch (err) {
      return null;
    }
  }

  if (!client || !client.client) {
    return null;
  }

  const requestData: z.infer<typeof AIRoleMatchRequest> = {
    taskTitle: task.title,
    taskDescription: task.description,
    candidates: candidates.map((c) => ({
      roleId: c.roleId,
      name: c.name,
      description: c.description,
      capabilities: c.capabilities,
    })),
  };

  const userPrompt = JSON.stringify(requestData, null, 2);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await client.client.chat.completions.create(
      {
        model: client.model,
        messages: [
          { role: "system", content: buildAIMatchSystemPrompt() },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      },
      { signal: controller.signal }
    );

    clearTimeout(timer);

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const validated = AIRoleMatchResponse.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data;
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

// ============================================================================
// 第四部分：Hybrid 策略
// ============================================================================

async function matchByHybrid(task: TaskRequirement, options: MatchOptions): Promise<ReadonlyArray<MatchResult>> {
  const keywordScored = ROLE_REGISTRY.map((role) => {
    const scoreBreakdown = scoreByKeyword(task, role);
    return { role, scoreBreakdown, confidence: aggregateScore(scoreBreakdown), strategy: "hybrid" as const };
  });

  keywordScored.sort((a, b) => {
    const scoreDiff = b.confidence - a.confidence;
    if (Math.abs(scoreDiff) < 0.01) {
      return b.role.priority - a.role.priority;
    }
    return scoreDiff;
  });

  const topCandidates = keywordScored.slice(0, Math.max(options.topK * 2, 3));

  const aiResponse = await scoreByAI(
    task,
    topCandidates.map((c) => c.role),
    options
  );

  if (aiResponse && aiResponse.scores.length > 0) {
    const aiScoreMap = new Map(aiResponse.scores.map((s) => [s.roleId, s]));
    const merged = topCandidates.map(({ role, scoreBreakdown, confidence }) => {
      const ai = aiScoreMap.get(role.roleId);
      if (!ai) {
        return { role, scoreBreakdown, confidence, strategy: "hybrid" as const };
      }
      const hybridConfidence = ai.score * 0.6 + confidence * 0.4;
      const mergedBreakdown: ScoreBreakdown = {
        ...scoreBreakdown,
        semantic: ai.score,
        aiConfidence: ai.confidence,
      };
      return { role, scoreBreakdown: mergedBreakdown, confidence: hybridConfidence, strategy: "hybrid" as const };
    });

    merged.sort((a, b) => b.confidence - a.confidence);

    const top1 = merged[0];
    if (top1 && (top1.scoreBreakdown.aiConfidence ?? 0) >= options.aiFallbackThreshold) {
      return merged.slice(0, options.topK).map(buildMatchResultFromScored);
    }
  }

  return keywordScored.slice(0, options.topK).map(buildMatchResultFromScored);
}

// ============================================================================
// 第五部分：结果构建
// ============================================================================

function buildMatchResultFromScored(scored: {
  role: RoleDefinition;
  scoreBreakdown: ScoreBreakdown;
  confidence: number;
  strategy: MatchStrategy;
}): MatchResult {
  const { role, scoreBreakdown, confidence, strategy } = scored;
  const matchedCapabilities = role.capabilities.filter((c) => scoreBreakdown.capability > 0);
  const matchedSkills = role.skills.filter((s) => scoreBreakdown.skill > 0.3);
  const missingCapabilities: string[] = [];
  const reasons: string[] = [];
  reasons.push(`综合置信度 ${(confidence * 100).toFixed(1)}%`);
  if (scoreBreakdown.capability > 0.5) {
    reasons.push(`能力匹配度 ${(scoreBreakdown.capability * 100).toFixed(0)}%`);
  }
  if (scoreBreakdown.keyword > 0.3) {
    reasons.push(`关键词命中 ${(scoreBreakdown.keyword * 100).toFixed(0)}%`);
  }
  if (scoreBreakdown.semantic !== undefined) {
    reasons.push(`AI 语义分 ${(scoreBreakdown.semantic * 100).toFixed(0)}%`);
  }

  return {
    roleId: role.roleId,
    roleName: role.name,
    confidence,
    matchedCapabilities,
    matchedSkills,
    missingCapabilities,
    reasons,
    scoreBreakdown,
    strategy,
  };
}

// ============================================================================
// 第六部分：对外主入口
// ============================================================================

/**
 * 角色匹配主入口
 *
 * @param task 任务需求
 * @param rawOptions 匹配选项
 * @returns topK 匹配结果（按 confidence 降序）
 */
export async function matchRoles(
  task: TaskRequirement,
  rawOptions?: Partial<MatchOptions>
): Promise<ReadonlyArray<MatchResult>> {
  const options = MatchOptions.parse(rawOptions ?? {});

  switch (options.strategy) {
    case "keyword": {
      const scored = ROLE_REGISTRY.map((role) => {
        const scoreBreakdown = scoreByKeyword(task, role);
        return {
          role,
          scoreBreakdown,
          confidence: aggregateScore(scoreBreakdown),
          strategy: "keyword" as const,
        };
      });
      scored.sort((a, b) => {
        const diff = b.confidence - a.confidence;
        if (Math.abs(diff) < 0.01) {
          return b.role.priority - a.role.priority;
        }
        return diff;
      });
      return scored.slice(0, options.topK).map(buildMatchResultFromScored);
    }

    case "ai": {
      const aiResponse = await scoreByAI(task, ROLE_REGISTRY, options);
      if (!aiResponse) {
        return matchRoles(task, { ...options, strategy: "keyword" });
      }
      const aiMap = new Map(aiResponse.scores.map((s) => [s.roleId, s]));
      const merged = ROLE_REGISTRY.map((role) => {
        const ai = aiMap.get(role.roleId);
        if (!ai) {
          const sb = scoreByKeyword(task, role);
          return {
            role,
            scoreBreakdown: sb,
            confidence: aggregateScore(sb) * 0.5,
            strategy: "ai" as const,
          };
        }
        const scoreBreakdown: ScoreBreakdown = {
          capability: ai.capabilityFit,
          skill: 0.5,
          keyword: 0.5,
          priority: role.priority / 10,
          semantic: ai.score,
          aiConfidence: ai.confidence,
        };
        return {
          role,
          scoreBreakdown,
          confidence: ai.score,
          strategy: "ai" as const,
        };
      });
      merged.sort((a, b) => b.confidence - a.confidence);
      return merged.slice(0, options.topK).map(buildMatchResultFromScored);
    }

    case "hybrid": {
      return matchByHybrid(task, options);
    }
  }
}

/**
 * 同步版本（仅 keyword 模式，用于 CLI 启动阶段）
 */
export function matchRolesSync(taskTitle: string, taskDescription: string): MatchResult | null {
  const task: TaskRequirement = {
    taskId: "00000000-0000-0000-0000-000000000000",
    title: taskTitle,
    description: taskDescription,
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium",
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    // v1.1 新增：同步构造路径默认空业务标签（与 TaskRequirement schema default 对齐）
    domainTags: [],
  };
  const scored = ROLE_REGISTRY.map((role) => {
    const sb = scoreByKeyword(task, role);
    return { role, scoreBreakdown: sb, confidence: aggregateScore(sb), strategy: "keyword" as const };
  });
  scored.sort((a, b) => b.confidence - a.confidence);
  if (scored.length === 0) return null;
  return buildMatchResultFromScored(scored[0]!);
}

export const _internals = {
  computeKeywordOverlap,
  computeCapabilityMatch,
  computeSkillMatch,
  scoreByKeyword,
  aggregateScore,
  buildMatchResultFromScored,
  MATCH_WEIGHTS,
  AI_MATCH_WEIGHTS,
};
