/**
 * DeepCodeX 多角色团队 - 领域专家匹配器（DomainExpertMatcher）
 *
 * 来源：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.3
 * 严格遵循 user rules：禁止 mock/占位/简化；三种策略全部真实实现
 * Karpathy 原则：Surgical Changes - 只新增必需函数，不修改 role-matcher.ts
 *
 * 三种匹配策略（与 role-matcher.ts 对齐）:
 *   1. keyword - 纯本地计算（4 维加权：domainTag 40% / keyword 30% / capability 20% / skill 10%）
 *   2. ai      - 调用 LLM 语义匹配（需配置 OpenAI 客户端）
 *   3. hybrid  - 默认策略：先 keyword 取 topK*2，再用 AI 重排序
 *
 * v1.1 P1-3 权重依据（4 维加权）:
 *   - domainTags 40%：业务领域标签是领域专家的核心标识，权重最高
 *   - keyword 30%：关键词命中反映任务与专家描述的字面相关性
 *   - capability 20%：能力匹配确保专家具备执行 review 的基础能力
 *   - skill 10%：技能匹配作为辅助判断，避免过度依赖工具栈
 *   设计依据：参考 role-matcher.ts MATCH_WEIGHTS（capability 0.5 / skill 0.3 / keyword 0.2）
 *   领域专家场景下 domainTags 是核心维度（RoleDefinition 无此维度），因此权重最高
 *
 * 降级策略（Ponytail 红线 R-02：必须显式错误处理）:
 *   - AI 不可用（无 API Key）→ 自动回退到 keyword
 *   - AI 调用失败（超时/网络）→ 自动回退到 keyword
 *   - AI 置信度 < aiFallbackThreshold → 回退到 keyword 重排
 */

import { z } from "zod";
import type {
  DomainCategory,
  DomainExpert,
  DomainExpertMatchResult,
  DomainMatchOptions,
  DomainMatcherOptions,
  MatchStrategy,
  ScoreBreakdown,
  TaskRequirement,
} from "./types.js";
import {
  DomainExpertMatchResult as DomainExpertMatchResultSchema,
  MatchStrategy as MatchStrategySchema,
} from "./types.js";
import { createOpenAIClient } from "../common/openai-client.js";
import type { DomainExpertRegistry } from "./domain-expert-registry.js";

/**
 * 浮点数比较精度阈值（P1-2 修复）
 *
 * 问题：原实现使用 Math.abs(scoreDiff) < 0.01 判断分数接近，
 *       当 confidence 差值恰好为 0.005 时会错误触发 priority 兜底，导致排序不稳定。
 * 修复：使用 Number.EPSILON（约 2.22e-16）作为精确比较阈值，
 *       确保只有真正相等的浮点数才触发 priority 兜底。
 */
const FLOAT_COMPARE_EPSILON = Number.EPSILON;

// ============================================================================
// 第一部分：评分权重配置（v1.1 P1-3 4 维加权）
// ============================================================================

/**
 * 领域专家匹配权重（v1.1 P1-3）
 *
 * 与 role-matcher.ts MATCH_WEIGHTS 的差异：
 *   - role-matcher: capability 0.5 / skill 0.3 / keyword 0.2（3 维）
 *   - domain-matcher: domainTag 0.4 / keyword 0.3 / capability 0.2 / skill 0.1（4 维）
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.3 P1-3
 *   - domainTags 权重最高（0.4）：领域专家的核心标识，决定专家是否"对口"
 *   - keyword 权重次高（0.3）：任务文本与专家描述的字面相关性
 *   - capability 权重中等（0.2）：确保专家具备执行 review 的基础能力
 *   - skill 权重最低（0.1）：工具栈匹配是辅助判断，避免过度依赖
 */
export const DOMAIN_MATCH_WEIGHTS = {
  domainTag: 0.4,
  keyword: 0.3,
  capability: 0.2,
  skill: 0.1,
} as const;

/**
 * AI 增强专用权重（与 role-matcher.ts AI_MATCH_WEIGHTS 对齐）
 */
export const DOMAIN_AI_MATCH_WEIGHTS = {
  domainTag: 0.4,
  context: 0.3,
  history: 0.3,
} as const;

/**
 * 匹配选项 schema（与 DomainMatchOptions 一致，用于运行时校验）
 */
export const DomainMatchOptionsSchema = z.object({
  strategy: MatchStrategySchema.default("hybrid"),
  topK: z.number().int().positive().default(3),
  aiFallbackThreshold: z.number().min(0).max(1).default(0.3),
  projectRoot: z.string().default(process.cwd()),
  injectedClient: z.unknown().optional(),
  timeoutMs: z.number().int().positive().default(30000),
});

/**
 * AI 领域专家匹配请求 schema
 */
export const AIDomainExpertMatchRequest = z.object({
  taskTitle: z.string(),
  taskDescription: z.string(),
  taskDomainTags: z.array(z.string()),
  candidates: z.array(
    z.object({
      expertId: z.string(),
      name: z.string(),
      specialty: z.string(),
      description: z.string(),
      domainTags: z.array(z.string()),
      capabilities: z.array(z.string()),
    })
  ),
});

/**
 * AI 领域专家匹配响应 schema
 */
export const AIDomainExpertMatchResponse = z.object({
  scores: z.array(
    z.object({
      expertId: z.string(),
      score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
      domainTagFit: z.number().min(0).max(1),
      contextUnderstanding: z.number().min(0).max(1),
      historicalExperience: z.number().min(0).max(1),
      reasoning: z.string().min(1),
    })
  ),
});

// ============================================================================
// 第二部分：Keyword 匹配（4 维加权，纯本地）
// ============================================================================

/**
 * 计算文本与专家关键词的重叠度
 *
 * 算法：命中关键词数 / 关键词总数
 *
 * P2-1 修复：中英文混合关键词（如"金融 finance"）拆分为中文和英文部分分别匹配
 *            原实现将混合词视为英文关键词走 tokenSet.has(lowerKw) 路径，
 *            但 tokenSet 只包含英文单词和单字中文字符，导致混合词无法命中。
 *            修复后：混合词拆分为中文部分和英文部分，任一命中即算命中。
 *
 * @param text 任务文本
 * @param keywords 专家关键词列表
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
    // 检测是否为纯英文关键词（长度 >1 且包含字母/数字）
    const isPureEnglish = lowerKw.length > 1 && /^[a-z0-9+#.-]+$/.test(lowerKw);
    if (isPureEnglish) {
      // 纯英文：走 tokenSet 精确匹配
      if (tokenSet.has(lowerKw)) hitCount++;
    } else {
      // 中文或中英文混合：拆分为中文部分和英文部分分别匹配
      const chinesePart = lowerKw.match(/[\u4e00-\u9fff]+/g)?.join("") ?? "";
      const englishPart = lowerKw.match(/[a-z0-9+#.-]+/g)?.join("") ?? "";

      let matched = false;
      // 中文部分：检查是否在文本中出现（includes 匹配）
      if (chinesePart.length > 0 && normalized.includes(chinesePart)) {
        matched = true;
      }
      // 英文部分：检查是否在 tokenSet 中（精确匹配）
      if (!matched && englishPart.length > 0 && tokenSet.has(englishPart)) {
        matched = true;
      }
      // 单字符中文关键词：走 includes 逻辑（兼容原实现）
      if (!matched && lowerKw.length === 1 && /[\u4e00-\u9fff]/.test(lowerKw)) {
        if (normalized.includes(lowerKw)) matched = true;
      }
      if (matched) hitCount++;
    }
  }
  return hitCount / keywords.length;
}

/**
 * 计算能力匹配得分（F1 分数）
 *
 * @param requiredCapabilities 任务所需能力
 * @param expertCapabilities 专家能力列表
 * @returns [0, 1]
 */
function computeCapabilityMatch(
  requiredCapabilities: ReadonlyArray<string>,
  expertCapabilities: ReadonlyArray<string>
): number {
  if (requiredCapabilities.length === 0) {
    return 0.5;
  }
  const expertSet = new Set(expertCapabilities);
  const requiredSet = new Set(requiredCapabilities);

  let expertHit = 0;
  for (const cap of expertCapabilities) {
    if (requiredSet.has(cap)) expertHit++;
  }
  const precision = expertCapabilities.length > 0 ? expertHit / expertCapabilities.length : 0;

  let taskHit = 0;
  for (const cap of requiredCapabilities) {
    if (expertSet.has(cap)) taskHit++;
  }
  const recall = taskHit / requiredCapabilities.length;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * 计算技能匹配得分（命中率）
 *
 * @param preferredSkills 任务偏好技能
 * @param expertSkills 专家技能列表
 * @returns [0, 1]
 */
function computeSkillMatch(preferredSkills: ReadonlyArray<string>, expertSkills: ReadonlyArray<string>): number {
  if (preferredSkills.length === 0) {
    return 0.5;
  }
  const expertSet = new Set(expertSkills.map((s) => s.toLowerCase()));
  let hit = 0;
  for (const skill of preferredSkills) {
    if (expertSet.has(skill.toLowerCase())) hit++;
  }
  return hit / preferredSkills.length;
}

/**
 * 计算业务领域标签匹配得分（Jaccard 相似度，v1.1 P1-4）
 *
 * 算法：|A ∩ B| / |A ∪ B|
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.3 P1-4
 *   - domainTags 是 DomainExpertMatcher 专有逻辑，不复用 role-matcher.ts
 *   - 使用 Jaccard 相似度衡量集合重叠度
 *   - 大小写不敏感，避免"金融"vs"金融业"等大小写差异导致漏匹配
 *
 * @param taskDomainTags 任务业务标签
 * @param expertDomainTags 专家业务标签
 * @returns [0, 1]
 */
export function computeDomainTagMatch(
  taskDomainTags: ReadonlyArray<string>,
  expertDomainTags: ReadonlyArray<string>
): number {
  // 任务无业务标签时，给中等分数（0.5），不惩罚无标签任务
  if (taskDomainTags.length === 0) {
    return 0.5;
  }
  // 专家无业务标签时，给 0 分（domainTags 是专家核心标识，缺失即不匹配）
  if (expertDomainTags.length === 0) {
    return 0;
  }

  // 大小写不敏感的集合构造
  const taskSet = new Set(taskDomainTags.map((t) => t.toLowerCase()));
  const expertSet = new Set(expertDomainTags.map((t) => t.toLowerCase()));

  // 计算交集
  let intersection = 0;
  for (const tag of taskSet) {
    if (expertSet.has(tag)) {
      intersection++;
    }
  }

  // 计算并集（|A ∪ B| = |A| + |B| - |A ∩ B|）
  const union = taskSet.size + expertSet.size - intersection;

  // 避免除零（intersection=0 时返回 0）
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * 对单个专家执行 keyword 匹配（4 维评分）
 *
 * @param task 任务需求
 * @param expert 专家定义
 * @returns ScoreBreakdown（含 domainTag 字段）
 */
function scoreByDomainKeyword(task: TaskRequirement, expert: DomainExpert): ScoreBreakdown {
  const text = `${task.title} ${task.description}`;
  const keywordScore = computeKeywordOverlap(text, expert.keywords);
  const capabilityScore = computeCapabilityMatch(task.requiredCapabilities, expert.capabilities);
  const skillScore = computeSkillMatch(task.preferredSkills, expert.skills);
  const priorityScore = expert.priority / 10;
  const domainTagScore = computeDomainTagMatch(task.domainTags, expert.domainTags);

  return {
    capability: capabilityScore,
    skill: skillScore,
    keyword: keywordScore,
    priority: priorityScore,
    domainTag: domainTagScore,
  };
}

/**
 * 将 ScoreBreakdown 转换为综合 confidence（4 维加权求和）
 *
 * 权重：domainTag 0.4 / keyword 0.3 / capability 0.2 / skill 0.1
 *
 * @param scores 评分明细
 * @returns 综合置信度 [0, 1]
 */
function aggregateDomainScore(scores: ScoreBreakdown): number {
  // domainTag 缺失时回退到 0（防御性：scoreByDomainKeyword 已保证填充）
  const domainTagScore = scores.domainTag ?? 0;
  return (
    domainTagScore * DOMAIN_MATCH_WEIGHTS.domainTag +
    scores.keyword * DOMAIN_MATCH_WEIGHTS.keyword +
    scores.capability * DOMAIN_MATCH_WEIGHTS.capability +
    scores.skill * DOMAIN_MATCH_WEIGHTS.skill
  );
}

// ============================================================================
// 第三部分：AI 语义匹配（真实调用 LLM）
// ============================================================================

/**
 * 构建 AI 匹配的系统 prompt
 */
function buildAIDomainMatchSystemPrompt(): string {
  return `# ROLE: AI 领域专家匹配专家

你是一个领域专家匹配系统的 AI 增强模块。给定一个用户任务和若干候选领域专家，输出每个专家的综合评分。

## 评分维度（每项 0-1）
1. domainTagFit（业务标签契合）：候选专家的业务标签是否覆盖任务业务领域
2. contextUnderstanding（上下文理解）：候选专家能否理解任务上下文（业务场景、约束、上游产出）
3. historicalExperience（历史经验）：基于专家描述中的技能和职责，评估其历史处理类似业务的经验

## 输出格式（严格 JSON，无任何额外文本）
{
  "scores": [
    {
      "expertId": "<候选专家 ID>",
      "score": <综合得分 0-1>,
      "confidence": <你对这个评分的置信度 0-1>,
      "domainTagFit": <业务标签契合 0-1>,
      "contextUnderstanding": <上下文理解 0-1>,
      "historicalExperience": <历史经验 0-1>,
      "reasoning": "<中文解释，≤ 100 字>"
    }
  ]
}

## 严格规则
1. 只输出 JSON，不要 markdown 包装、不要解释、不要道歉
2. 每个候选专家必须输出 1 个评分对象（不能遗漏）
3. 评分理由必须用中文
4. 如果不确定，给 0.5 而非编造
`;
}

/**
 * 调用 LLM 执行 AI 语义匹配（真实实现）
 *
 * 降级策略：
 *   - 无 API Key → 返回 null，调用方回退到 keyword
 *   - 超时 / 网络错误 → 返回 null
 *   - 响应解析失败 → 返回 null
 *
 * @param task 任务需求
 * @param candidates 候选专家
 * @param options 匹配选项
 * @returns AI 响应或 null（失败时）
 */
async function scoreByDomainAI(
  task: TaskRequirement,
  candidates: ReadonlyArray<DomainExpert>,
  options: DomainMatchOptions
): Promise<z.infer<typeof AIDomainExpertMatchResponse> | null> {
  let client: ReturnType<typeof createOpenAIClient> | null = null;
  if (options.injectedClient) {
    client = options.injectedClient as ReturnType<typeof createOpenAIClient>;
  } else {
    try {
      client = createOpenAIClient(options.projectRoot);
    } catch {
      // Ponytail R-02：捕获但不吞没，返回 null 让调用方降级
      return null;
    }
  }

  if (!client || !client.client) {
    return null;
  }

  const requestData: z.infer<typeof AIDomainExpertMatchRequest> = {
    taskTitle: task.title,
    taskDescription: task.description,
    taskDomainTags: task.domainTags,
    candidates: candidates.map((c) => ({
      expertId: c.expertId,
      name: c.name,
      specialty: c.specialty,
      description: c.description,
      domainTags: c.domainTags,
      capabilities: c.capabilities,
    })),
  };

  const userPrompt = JSON.stringify(requestData, null, 2);

  // Ponytail R-10：超时控制，避免无限等待
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await client.client.chat.completions.create(
      {
        model: client.model,
        messages: [
          { role: "system", content: buildAIDomainMatchSystemPrompt() },
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
    const validated = AIDomainExpertMatchResponse.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data;
  } catch {
    // Ponytail R-02：捕获所有异常，清理 timer 并降级
    clearTimeout(timer);
    return null;
  }
}

// ============================================================================
// 第四部分：Hybrid 策略
// ============================================================================

/**
 * Hybrid 匹配策略（keyword + AI 重排序）
 *
 * 流程：
 *   1. keyword 策略评分所有候选专家
 *   2. 取 topK*2 候选（至少 3 个）送入 AI 重排序
 *   3. AI 成功且 top1 置信度 ≥ aiFallbackThreshold → 返回 AI 重排序结果
 *   4. AI 失败或置信度过低 → 回退到 keyword 结果
 *
 * @param task 任务需求
 * @param candidates 候选专家列表（已应用 enabledCategories 过滤）
 * @param options 匹配选项
 * @returns topK 匹配结果
 */
async function matchByDomainHybrid(
  task: TaskRequirement,
  candidates: ReadonlyArray<DomainExpert>,
  options: DomainMatchOptions
): Promise<ReadonlyArray<DomainExpertMatchResult>> {
  // 步骤 1：keyword 评分所有候选
  const keywordScored = candidates.map((expert) => {
    const scoreBreakdown = scoreByDomainKeyword(task, expert);
    return {
      expert,
      scoreBreakdown,
      confidence: aggregateDomainScore(scoreBreakdown),
      strategy: "hybrid" as const,
    };
  });

  // 步骤 2：keyword 排序（confidence 降序，priority 兜底）
  // P1-2 修复：使用 FLOAT_COMPARE_EPSILON 替代 0.01，避免浮点数精度问题导致排序不稳定
  keywordScored.sort((a, b) => {
    const scoreDiff = b.confidence - a.confidence;
    if (Math.abs(scoreDiff) < FLOAT_COMPARE_EPSILON) {
      return b.expert.priority - a.expert.priority;
    }
    return scoreDiff;
  });

  // 步骤 3：取 topK*2（至少 3 个）送入 AI
  const topCandidates = keywordScored.slice(0, Math.max(options.topK * 2, 3));

  const aiResponse = await scoreByDomainAI(
    task,
    topCandidates.map((c) => c.expert),
    options
  );

  // 步骤 4：AI 成功且置信度足够 → 合并 AI 分数
  if (aiResponse && aiResponse.scores.length > 0) {
    const aiScoreMap = new Map(aiResponse.scores.map((s) => [s.expertId, s]));
    const merged = topCandidates.map(({ expert, scoreBreakdown, confidence }) => {
      const ai = aiScoreMap.get(expert.expertId);
      if (!ai) {
        return { expert, scoreBreakdown, confidence, strategy: "hybrid" as const };
      }
      // AI 与 keyword 加权融合：AI 60% + keyword 40%
      const hybridConfidence = ai.score * 0.6 + confidence * 0.4;
      const mergedBreakdown: ScoreBreakdown = {
        ...scoreBreakdown,
        semantic: ai.score,
        aiConfidence: ai.confidence,
      };
      return { expert, scoreBreakdown: mergedBreakdown, confidence: hybridConfidence, strategy: "hybrid" as const };
    });

    merged.sort((a, b) => b.confidence - a.confidence);

    // 步骤 5：检查 top1 的 AI 置信度是否达标
    const top1 = merged[0];
    if (top1 && (top1.scoreBreakdown.aiConfidence ?? 0) >= options.aiFallbackThreshold) {
      return merged.slice(0, options.topK).map(buildDomainMatchResultFromScored);
    }
  }

  // 步骤 6：AI 失败或置信度过低 → 回退到 keyword
  return keywordScored.slice(0, options.topK).map(buildDomainMatchResultFromScored);
}

// ============================================================================
// 第五部分：结果构建
// ============================================================================

/**
 * 从评分对象构建 DomainExpertMatchResult
 *
 * @param scored 评分对象
 * @returns DomainExpertMatchResult
 */
function buildDomainMatchResultFromScored(scored: {
  expert: DomainExpert;
  scoreBreakdown: ScoreBreakdown;
  confidence: number;
  strategy: MatchStrategy;
}): DomainExpertMatchResult {
  const { expert, scoreBreakdown, confidence, strategy } = scored;

  // 命中的能力列表（capability 评分 > 0 表示有命中）
  const matchedCapabilities = expert.capabilities.filter((c) => scoreBreakdown.capability > 0);
  // 命中的技能列表（skill 评分 > 0.3 表示有命中，与 role-matcher 阈值对齐）
  const matchedSkills = expert.skills.filter((s) => scoreBreakdown.skill > 0.3);
  // 命中的业务标签列表（domainTag 评分 > 0 表示有交集）
  const matchedDomainTags = expert.domainTags.filter(() => (scoreBreakdown.domainTag ?? 0) > 0);

  // 构造可解释的匹配原因（Ponytail R-12：审计日志）
  // 提取 domainTag 分数到局部变量，避免多次访问 optional 字段导致 TypeScript 窄化丢失
  const domainTagScore = scoreBreakdown.domainTag ?? 0;
  const reasons: string[] = [];
  reasons.push(`综合置信度 ${(confidence * 100).toFixed(1)}%`);
  if (domainTagScore > 0.3) {
    reasons.push(`业务标签匹配 ${(domainTagScore * 100).toFixed(0)}%`);
  }
  if (scoreBreakdown.keyword > 0.3) {
    reasons.push(`关键词命中 ${(scoreBreakdown.keyword * 100).toFixed(0)}%`);
  }
  if (scoreBreakdown.capability > 0.5) {
    reasons.push(`能力匹配度 ${(scoreBreakdown.capability * 100).toFixed(0)}%`);
  }
  if (scoreBreakdown.semantic !== undefined) {
    reasons.push(`AI 语义分 ${(scoreBreakdown.semantic * 100).toFixed(0)}%`);
  }

  // 通过 schema 校验后返回（防御性编程，确保返回值符合契约）
  const result: DomainExpertMatchResult = {
    expert,
    confidence,
    scoreBreakdown,
    strategy,
    reasons,
    matchedCapabilities,
    matchedSkills,
    matchedDomainTags,
  };
  return DomainExpertMatchResultSchema.parse(result);
}

// ============================================================================
// 第六部分：DomainExpertMatcher 主类
// ============================================================================

/**
 * 领域专家匹配器
 *
 * v1.1 P1-3 权重依据：4 维加权评分（domainTags 40% / keyword 30% / capability 20% / skill 10%）
 * v1.1 P1-4 computeDomainTagMatch：Jaccard 相似度，专有逻辑不复用 role-matcher
 * v1.1 P1-5 三种匹配策略：keyword / ai / hybrid（与 role-matcher 对齐）
 */
export class DomainExpertMatcher {
  /**
   * 构造函数
   *
   * @param registry 领域专家注册中心（动态，已加载的专家参与匹配）
   * @param options 匹配器选项（enabledCategories 过滤等）
   */
  constructor(
    private readonly registry: DomainExpertRegistry,
    private readonly options?: DomainMatcherOptions
  ) {}

  /**
   * 根据任务文本动态匹配领域专家（支持 keyword/ai/hybrid 三策略）
   *
   * @param task 任务需求
   * @param rawOptions 匹配选项（覆盖构造时的默认值）
   * @returns topK 匹配结果（按 confidence 降序）
   */
  async matchExperts(
    task: TaskRequirement,
    rawOptions?: Partial<DomainMatchOptions>
  ): Promise<ReadonlyArray<DomainExpertMatchResult>> {
    // 合并默认选项与运行时选项
    const defaultOptions = this.options?.defaultMatchOptions ?? {};
    const options = DomainMatchOptionsSchema.parse({ ...defaultOptions, ...rawOptions });

    // 获取候选专家（应用 enabledCategories 过滤）
    const candidates = this.getCandidates();

    // 无候选专家时返回空数组（避免空数组传入 AI 导致异常）
    if (candidates.length === 0) {
      return [];
    }

    switch (options.strategy) {
      case "keyword": {
        return this.matchByKeyword(task, candidates, options);
      }
      case "ai": {
        return this.matchByAI(task, candidates, options);
      }
      case "hybrid": {
        return matchByDomainHybrid(task, candidates, options);
      }
    }
  }

  /**
   * 同步版本（仅 keyword 策略，不触发懒加载）
   *
   * 用途：CLI 启动阶段 / 测试场景快速匹配
   *
   * @param taskTitle 任务标题
   * @param taskDescription 任务描述
   * @returns topK 匹配结果（按 confidence 降序），无候选时返回空数组
   */
  matchExpertsSync(taskTitle: string, taskDescription: string): ReadonlyArray<DomainExpertMatchResult> {
    // 构造最小 TaskRequirement（domainTags 默认空）
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
      domainTags: [],
    };

    const candidates = this.getCandidates();
    if (candidates.length === 0) {
      return [];
    }

    // 同步路径仅支持 keyword 策略
    const options = DomainMatchOptionsSchema.parse({ strategy: "keyword", topK: 3 });
    return this.matchByKeyword(task, candidates, options);
  }

  /**
   * 获取候选专家列表（应用 enabledCategories 过滤）
   *
   * @returns 候选专家数组
   */
  private getCandidates(): ReadonlyArray<DomainExpert> {
    const enabledCategories = this.options?.enabledCategories ?? [];

    // 未配置 enabledCategories 时，使用全部已注册专家
    if (enabledCategories.length === 0) {
      const expertIds = this.registry.listExpertIds();
      const experts: DomainExpert[] = [];
      for (const id of expertIds) {
        const expert = this.registry.getExpert(id);
        if (expert) {
          experts.push(expert);
        }
      }
      return experts;
    }

    // 配置了 enabledCategories 时，按类别聚合
    const experts: DomainExpert[] = [];
    for (const category of enabledCategories as ReadonlyArray<DomainCategory>) {
      const categoryExperts = this.registry.getByCategory(category);
      experts.push(...categoryExperts);
    }
    return experts;
  }

  /**
   * Keyword 策略匹配
   *
   * @param task 任务需求
   * @param candidates 候选专家
   * @param options 匹配选项
   * @returns topK 匹配结果
   */
  private matchByKeyword(
    task: TaskRequirement,
    candidates: ReadonlyArray<DomainExpert>,
    options: DomainMatchOptions
  ): ReadonlyArray<DomainExpertMatchResult> {
    const scored = candidates.map((expert) => {
      const scoreBreakdown = scoreByDomainKeyword(task, expert);
      return {
        expert,
        scoreBreakdown,
        confidence: aggregateDomainScore(scoreBreakdown),
        strategy: "keyword" as const,
      };
    });

    // 排序：confidence 降序，priority 兜底
    // P1-2 修复：使用 FLOAT_COMPARE_EPSILON 替代 0.01，避免浮点数精度问题
    scored.sort((a, b) => {
      const diff = b.confidence - a.confidence;
      if (Math.abs(diff) < FLOAT_COMPARE_EPSILON) {
        return b.expert.priority - a.expert.priority;
      }
      return diff;
    });

    return scored.slice(0, options.topK).map(buildDomainMatchResultFromScored);
  }

  /**
   * AI 策略匹配（带降级）
   *
   * @param task 任务需求
   * @param candidates 候选专家
   * @param options 匹配选项
   * @returns topK 匹配结果（AI 失败时降级为 keyword）
   */
  private async matchByAI(
    task: TaskRequirement,
    candidates: ReadonlyArray<DomainExpert>,
    options: DomainMatchOptions
  ): Promise<ReadonlyArray<DomainExpertMatchResult>> {
    const aiResponse = await scoreByDomainAI(task, candidates, options);
    if (!aiResponse) {
      // Ponytail R-02：AI 失败时显式降级到 keyword
      return this.matchByKeyword(task, candidates, options);
    }

    const aiMap = new Map(aiResponse.scores.map((s) => [s.expertId, s]));
    const merged = candidates.map((expert) => {
      const ai = aiMap.get(expert.expertId);
      if (!ai) {
        // AI 漏评的专家：用 keyword 评分 × 0.5 作为置信度（惩罚）
        const sb = scoreByDomainKeyword(task, expert);
        return {
          expert,
          scoreBreakdown: sb,
          confidence: aggregateDomainScore(sb) * 0.5,
          strategy: "ai" as const,
        };
      }
      // AI 评分的专家：用 AI 分数作为 confidence
      const scoreBreakdown: ScoreBreakdown = {
        capability: ai.domainTagFit, // 复用 domainTagFit 作为 capability 维度
        skill: 0.5,
        keyword: 0.5,
        priority: expert.priority / 10,
        domainTag: ai.domainTagFit,
        semantic: ai.score,
        aiConfidence: ai.confidence,
      };
      return {
        expert,
        scoreBreakdown,
        confidence: ai.score,
        strategy: "ai" as const,
      };
    });

    merged.sort((a, b) => b.confidence - a.confidence);
    return merged.slice(0, options.topK).map(buildDomainMatchResultFromScored);
  }
}

// ============================================================================
// 第七部分：_internals 导出（供单元测试访问内部函数）
// ============================================================================

/**
 * 内部函数导出（与 role-matcher.ts _internals 模式对齐）
 *
 * 用途：单元测试直接调用内部函数验证算法正确性
 * 注意：仅供测试使用，生产代码不应依赖 _internals
 */
export const _internals = {
  computeKeywordOverlap,
  computeCapabilityMatch,
  computeSkillMatch,
  computeDomainTagMatch,
  scoreByDomainKeyword,
  aggregateDomainScore,
  buildDomainMatchResultFromScored,
  matchByDomainHybrid,
  DOMAIN_MATCH_WEIGHTS,
  DOMAIN_AI_MATCH_WEIGHTS,
};
